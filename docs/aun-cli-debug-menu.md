# AUN CLI Debug 菜单方案

## 背景

AUN CLI 需要调试能力，方便排查消息收发、处理状态、加密等问题。通过二级补全菜单提供调试命令，不污染常规命令列表。

## 菜单结构

```
  /target <aid>
  /ping
  /status
  /plain <text>
  more ▸              ← 不可回车，光标悬停展开二级
    /debug            ← toggle 开关：状态通知 + 全局耗时
    /processing       ← 一次性打印：当前 processing 状态
    /rawdata          ← 一次性打印：最后一条消息原始内容
    /e2ee             ← 一次性打印：当前 E2EE 状态
  /help
  /quit
```

## 命令详细设计

### `/debug` — toggle 开关

控制以下内容在会话流中的显示：

| 场景 | 关闭时 | 开启时输出 |
|------|--------|-----------|
| 发送成功 | 静默 | `▶ evolclaw-ai  已发送 (123ms)` |
| 开始处理 | `▶ evolclaw-ai  开始处理` | `▶ evolclaw-ai  开始处理 (从发送起 350ms)` |
| 中断 | 静默 | `! evolclaw-ai  已中断` |
| message.ack | 未订阅 | `· evolclaw-ai  ACK seq=142` |
| 处理完成 | `* evolclaw-ai  处理完成，耗时9秒` | 不变 |

开关反馈（info 样式）：
```
20:12:14 · debug 模式已开启
20:12:14 · debug 模式已关闭
```

状态栏标记（开启时追加）：
```
🟢 已连接  我: tester  →  目标: evolclaw-ai  消息: 3  [DEBUG]
```

实现要点：
- AUNCli 增加 `debug_mode: bool = False`
- 发送成功：`send()` 中 `await client.call()` 返回后记录耗时，`debug_mode` 时输出
- 中断通知：`_on_message` 中 `status == "interrupted"` 时 `debug_mode` 才输出
- message.ack：`client.on("message.ack", ...)` 订阅，`debug_mode` 时输出
- 开始处理耗时：`_proc_start` 记录时间，与 `_last_sent` 差值

### `/processing` — 打印当前 processing 状态

输出格式（info 样式逐行）：
```
20:12:14 · ── Processing ──
20:12:14 · #1  aun-evolclaw-...616
20:12:14 ·     状态: 处理中，已耗时12秒
```

无活跃处理时：
```
20:12:14 · ── Processing ──
20:12:14 · 无活跃处理
```

实现要点：
- 遍历 `self._processing` 和 `self._proc_start`
- 实时计算已耗时（`asyncio.get_event_loop().time() - start_t`）

### `/rawdata` — 打印最后一条消息原始内容

输出格式（info 样式逐行）：
```
20:12:14 · ── Last Message ──
20:12:14 · from:    evolclaw-ai.agentid.pub
20:12:14 · payload: 今天是星期六。
20:12:14 · task_id: (空)
20:12:14 · e2ee:    {"mode":"x25519","key_id":"..."}
20:12:14 · seq:     142
```

无消息时：
```
20:12:14 · ── Last Message ──
20:12:14 · 尚未收到消息
```

实现要点：
- AUNCli 增加 `_last_raw_message: dict | None = None`
- `_on_message` 中保存完整 `data` 到 `_last_raw_message`（processing 消息也保存）

### `/e2ee` — 打印当前 E2EE 状态

输出格式（info 样式逐行）：
```
20:12:14 · ── E2EE ──
20:12:14 · 状态:    🔒 正常
20:12:14 · 最近事件: e2ee.degraded
20:12:14 ·   peer:   evolclaw-ai
20:12:14 ·   reason: missing prekey
20:12:14 ·   时间:   20:12:03
```

无 E2EE 事件时：
```
20:12:14 · ── E2EE ──
20:12:14 · 状态:    🔒 正常
20:12:14 · 最近事件: 无
```

实现要点：
- AUNCli 增加 `_last_e2ee_event: dict | None = None`（含 type/data/time）
- 订阅 `e2ee.degraded`、`e2ee.orchestration_error`、`token.refreshed` 三个事件

## 状态栏 E2EE 信息流转

SDK 事件直接更新状态栏的 E2EE 位置，互斥显示：

| 事件 | 状态栏显示 | 持续 |
|------|----------|------|
| 收到 E2EE 消息（正常） | `🔒 E2EE` | 持续 |
| `token.refreshed` | `🔑 Token已刷新` | 3秒后恢复 `🔒 E2EE` |
| `e2ee.degraded` | `⚠️ E2EE降级` | 直到下次正常 E2EE 消息 |
| `e2ee.orchestration_error` | `❌ E2EE错误` | 直到下次正常 E2EE 消息 |
| 收到非 E2EE 消息 | `🔓 明文` | 持续 |

流转示意：
```
初始: (空)
  → 收到 E2EE 消息 → 🔒 E2EE
  → e2ee.degraded → ⚠️ E2EE降级
  → 收到正常 E2EE 消息 → 🔒 E2EE
  → token.refreshed → 🔑 Token已刷新 → (3秒) → 🔒 E2EE
  → orchestration_error → ❌ E2EE错误
  → 收到正常 E2EE 消息 → 🔒 E2EE
```

实现要点：
- `_on_message` 中根据 `e2ee` 字段更新 `self.last_e2ee`
- SDK 事件回调中更新 `self.last_e2ee`
- `token.refreshed` 使用 `call_later(3, ...)` 恢复

## 补全器实现

用自定义 `Completer` 替换 `WordCompleter`：

```python
class AUNCompleter(Completer):
    def __init__(self, cli):
        self.cli = cli

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor.lstrip()
        
        # 一级菜单
        if not text or text == '/':
            yield from 一级菜单项
            yield Completion('more', display='more ▸', display_meta='调试工具')
        
        # 输入 "more " 或 "/more " 后展开二级
        elif text in ('more ', '/more '):
            yield Completion('/debug', ...)
            yield Completion('/processing', ...)
            yield Completion('/rawdata', ...)
            yield Completion('/e2ee', ...)
```

`more ▸` 项不对应实际命令，仅作为展开触发。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `aun_cli.py` | AUNCli 增加状态字段、SDK 事件订阅、自定义 Completer、REPL 命令处理、状态栏更新 |

## 新增字段汇总

```python
# AUNCli.__init__
self.debug_mode = False          # /debug toggle
self._last_raw_message = None    # /rawdata 用
self._last_e2ee_event = None     # /e2ee 用
self._e2ee_restore_timer = None  # token.refreshed 3秒恢复定时器
```
