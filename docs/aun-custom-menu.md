# AUN 自定义菜单功能方案

> ⚠️ **已废弃 (2026-05-26)**：本文档是 menu protocol 的最初设计稿，不含 `id` / `name` 字段，与当前实现不一致。
> 当前规范见 [`aun-menu-protocol-dev-guide-v2.2.md`](./aun-menu-protocol-dev-guide-v2.2.md)。
> 本文保留为历史变更参考。

## 概述

AUN CLI 通过 `///` 触发查询远端 EvolClaw 暴露的命令菜单，根据用户身份（admin/guest）返回不同的可用命令列表，以交互式菜单形式展示，选中后发送对应的斜杠指令。

## 协议

基于 AUN `message.send`（`persist: false`）的自定义消息，复用现有消息通道，无需新增 RPC 方法。

### 请求

```json
{"type": "menu.query"}
```

### 响应

```json
{
  "type": "menu.response",
  "items": [
    {
      "group": "项目管理",
      "commands": [
        {"cmd": "/pwd", "label": "显示当前项目路径"},
        {"cmd": "/plist", "label": "列出所有配置的项目"},
        {"cmd": "/p", "args": "<name|path>", "label": "切换项目"}
      ]
    },
    {
      "group": "会话管理",
      "commands": [
        {"cmd": "/new", "args": "[名称]", "label": "创建新会话"},
        {"cmd": "/slist", "label": "列出当前项目的所有会话"},
        {"cmd": "/s", "args": "<名称>", "label": "切换到指定会话"},
        {"cmd": "/name", "args": "<新名称>", "label": "重命名当前会话"},
        {"cmd": "/del", "args": "<名称>", "label": "删除指定会话"}
      ]
    },
    {
      "group": "Agent 与模型",
      "commands": [
        {"cmd": "/agent", "args": "[name]", "label": "查看或切换 Agent 后端"},
        {"cmd": "/model", "args": "[model] [effort]", "label": "查看或切换模型"}
      ]
    },
    {
      "group": "权限管理",
      "commands": [
        {"cmd": "/perm", "args": "[模式|allow|deny]", "label": "权限模式管理"}
      ]
    },
    {
      "group": "运维",
      "commands": [
        {"cmd": "/status", "label": "显示会话状态"},
        {"cmd": "/stop", "label": "中断当前任务"},
        {"cmd": "/restart", "label": "重启服务"},
        {"cmd": "/file", "args": "<路径>", "label": "发送项目内文件"}
      ]
    },
    {
      "group": "帮助",
      "commands": [
        {"cmd": "/help", "label": "显示帮助信息"}
      ]
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `group` | 一级菜单标题（分组名） |
| `cmd` | 斜杠命令（不含参数部分） |
| `args` | 可选，命令参数占位符。有此字段表示需要用户补充参数 |
| `label` | 命令描述 |

## 服务端改动

### 1. `src/core/command-handler.ts` — 新增 `getMenuItems(isAdmin)` 方法（~40行）

根据身份返回结构化的命令分组列表，数据来源与 `/help` 命令一致：

- **admin**：返回全部命令分组（项目管理、会话管理、Agent 与模型、权限管理、运维、帮助）
- **guest**：仅返回用户级命令（会话管理、帮助）

```typescript
getMenuItems(isAdmin: boolean): { group: string; commands: { cmd: string; args?: string; label: string }[] }[] {
  const items = [];
  // 会话管理（所有用户可见）
  items.push({
    group: '会话管理',
    commands: [
      { cmd: '/new', args: '[名称]', label: '创建新会话' },
      { cmd: '/slist', label: '列出当前项目的所有会话' },
      { cmd: '/s', args: '<名称>', label: '切换到指定会话' },
      // ...
    ]
  });
  if (isAdmin) {
    // 项目管理、运维等
  }
  items.push({ group: '帮助', commands: [{ cmd: '/help', label: '显示帮助信息' }] });
  return items;
}
```

### 2. `src/core/message-bridge.ts` — 拦截 `menu.query`（~15行）

在 `register()` 回调中，**命令检查之前**拦截自定义消息 payload：

```typescript
// 0. 自定义消息快速路径（menu.query 等）
const customResult = await this.handleCustomPayload(content, channelName, msg, sendReply);
if (customResult) return;

// 1. owner 绑定 ...（现有逻辑）
```

新增 `handleCustomPayload` 方法：
- 尝试 JSON 解析消息内容
- 匹配 `type === 'menu.query'`
- 通过 `msg.peerId` 与 `config.channels.aun.owner` 比较判断身份
- 调用 `cmdHandler.getMenuItems(isAdmin)` 获取菜单数据
- 构造 `menu.response` payload，通过 `sendReply` 发送（`persist: false`）

### 3. `aun_bridge.py` — 无需改动

`menu.query` 作为普通文本消息到达服务端，`menu.response` 作为普通消息返回客户端。透传即可。

### 4. `src/channels/aun.ts` — 无需改动

消息收发走已有通道。

## CLI 改动

### `aun_cli.py`（~40行）

#### 触发

`///` 输入触发查询（现有 `//` 行为保持不变，转发远端 `/` 指令）：

```python
if line.startswith("///"):
    await c.query_menu()
    continue

if line.startswith("//"):
    await c.send(line[1:])
    continue
```

#### 发送查询

```python
async def query_menu(self):
    info("查询菜单…")
    self._pending_menu = None
    await self.client.call("message.send", {
        "to": self.target_aid,
        "payload": json.dumps({"type": "menu.query"}),
        "encrypt": True, "persist": False,
    })
    # 等待 menu.response（超时 5s）
    for _ in range(50):
        if self._pending_menu is not None:
            break
        await asyncio.sleep(0.1)
    if self._pending_menu is None:
        error("菜单查询超时")
        return
    await self.render_menu(self._pending_menu)
```

#### 接收响应

`_on_message` 中识别 `menu.response`：

```python
if proc_payload.get("type") == "menu.response":
    self._pending_menu = proc_payload.get("items", [])
    return
```

#### 渲染与交互

交互式菜单渲染（待另一线程完成后对接）：

- 一级菜单：分组标题
- 二级菜单：编号 + 命令 + 描述
- 选中后：无 `args` 的命令直接发送；有 `args` 的填入输入栏等待用户补全

## 涉及文件

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `src/core/command-handler.ts` | ~40行 | 新增 `getMenuItems(isAdmin)` |
| `src/core/message-bridge.ts` | ~15行 | 拦截 `menu.query`，回复 `menu.response` |
| `aun_cli.py` | ~40行 | `///` 触发、接收、渲染 |
| `aun_bridge.py` | 0 | 透传 |
| `src/channels/aun.ts` | 0 | 不变 |

## 验证

1. 构建：`cd /home/evolclaw && npm run build`
2. 启动服务端
3. AUN CLI：`.venv/bin/python3 aun_cli.py -t evolclaw-ai.agentid.pub`
4. 输入 `///` → 应显示交互式菜单
5. 以 guest 身份连接 → 菜单应仅显示用户级命令
6. 选中无参数命令 → 直接发送
7. 选中带参数命令 → 填入输入栏等待补全
