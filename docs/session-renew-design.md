# Session Renew 设计

> 日期：2026-07-13  
> 状态：已实现

## 1. 目标

当一个已结束的 EvolClaw 主会话超过配置时长后再次收到普通消息，先判断新消息是否延续当前会话，再决定：

- `continue`：复用当前 `Session.id` 和底层 `agentSessionId`；
- `new`：创建新的 EvolClaw `Session`，不复用旧 `agentSessionId`。

时间只负责触发判断，语义连续性决定最终结果。功能默认关闭。

## 2. 配置

配置名为 `session_renew`，支持现有三层覆盖链：

```text
agents/defaults.json
  -> agents/{aid}/config.json
  -> agents/{aid}/relations/{peerKey}/config.json
```

```jsonc
{
  "session_renew": {
    "enabled": false,
    "after_hours": 24,
    "effort": "low",
    "fallback_action": "continue"
  }
}
```

字段说明：

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `false` | 只有最终有效配置严格等于 `true` 时启用 |
| `after_hours` | `24` | 当前会话最后一条有效对话消息距今超过该时长才触发 |
| `effort` | `low` | 判定调用的推理强度 |
| `fallback_action` | `continue` | 模型失败、超时或输出非法时的降级动作 |

模型分支不读取响应模式的 `config.auxiliaryModel`。判定 runner 和轻量模型由候选旧 Session 的 `baseagent` 确定，避免辅助配置与实际 runner 不匹配。

`session_renew` 保持扁平子字段，适配配置系统的字典第一层覆盖规则。

本期不增加 `evolclaw.json` 进程级硬开关。`agents/defaults.json` 是该行为的全局默认层。

## 3. 触发条件

同时满足以下条件才进入 renew 判断：

1. `session_renew.enabled === true`；
2. 当前是非 thread 的主会话；
3. 当前会话没有 `processingState`；
4. 当前 Session 有带 `sessionId` 的有效历史时，最后一条有效对话距今超过 `after_hours`。

24 小时阈值只适用于已有明确消息边界的 Session。

当前 `sessionId` 历史为空时：

- 若该 Session 是本次入站刚创建的首个主 Session，继续并写入第一条消息；
- 否则视为无法继续的存量 Session，直接创建新 Session，来源记为 `missing_history`。

存量无历史分支不检查 `after_hours`，不匹配显式信号，也不调用模型。

首期 thread 会话始终继续。thread 本身就是明确的话题边界，且当前 thread index 不支持在同一 thread 下同时维护多代 Session。

## 4. 严格显式信号

显式文本信号只识别句首固定短语，并要求短语后立即出现分隔标点：

```text
<固定短语><标点><正文>
```

允许标点：

```text
： : ， , ； ; 。 ！ ! 换行
```

明确新建短语：

```text
新话题
换个话题
重新开始
新开会话
新会话
```

明确继续短语：

```text
继续上次
延续上次
继续
接着
```

示例：

```text
新话题：讨论部署方案       -> new
继续，上次的测试还没跑完   -> continue
继续从 GitHub 下载          -> 不命中，交给模型
我想换个话题                -> 不命中，交给模型
```

中间包含关键词、只有空格分隔、没有标点均不得直接决定。

此外，如果新消息明确回复 `messages.jsonl` 中当前 Session 的既有消息，则直接 `continue`。

## 5. 模型判定

规则无法决定时，根据候选旧 Session 的 `session.baseagent` 选择判定 runner 和固定轻量模型：

| Session baseagent | 判定 runner | 判定模型 |
|---|---|---|
| `claude` | Claude | `haiku`（由 Claude runner 解析实际模型 ID） |
| `codex` | Codex | `gpt-5.6-luna` |

其他 baseagent 或对应 runner 不可用时，只跳过模型判断并继续当前 Session，不跨 runner 兜底，也不执行 `fallback_action`。严格显式信号、明确回复和 `missing_history` 不受影响。

判定使用一次性内部辅助会话：

- 不恢复旧主会话；
- 不预创建新主会话；
- 不向渠道发送输出；
- 以单次调用参数禁用工具；即使 backend 仍上报 `tool_use`，也立即中断并按失败降级；
- backend 支持时不持久化内部会话；
- 使用最小 system prompt；
- 完成一次判断后立即关闭。

工具隔离按 backend 能力实现：Claude 调用移除内置工具、MCP、skill 和项目/用户 setting source；Codex 使用 ephemeral thread，并清空动态工具、capability root 和 environment。任何 backend 一旦仍上报 `tool_use`，该次判定立即中断，结果无效并走降级动作。

模型输入由以下部分组成：

1. 当前 `Session.id` 在 `messages.jsonl` 中的原始有效对话；
2. 当前尚未写入日志的新消息；
3. `replyTo`、chat type、空闲时长等结构化信号。

不维护旧会话摘要。短会话输入全部原文；超过预算时保留会话首条有效消息和最近消息，做确定性截取，不生成二次摘要。

不含 `sessionId` 的存量日志不参与语义判断。只要当前 Session 不是本次入站刚创建且没有带 `sessionId` 的历史，就直接新建。

有效对话默认排除：

- `command`；
- `thought`、`status`、`event`；
- `tool_call`、`tool_result`；
- `handoff_state`；
- 空内容。

模型只返回结构化结果：

```json
{
  "decision": "continue",
  "confidence": 0.91,
  "reason_code": "same_task"
}
```

输出不合法、调用失败或超过 10 秒时按 `fallback_action` 降级，默认继续旧会话。这里的“调用失败”指已经取得对应 runner 并实际发起判定后的失败；runner 不支持或不可用仍按前述规则直接跳过。

模型输出 `new` 时还要求 `confidence >= 0.85`；低于该阈值按 `continue` 处理。严格句首新建信号不受该阈值影响。

## 6. 入站顺序与并发

普通消息处理顺序调整为：

```text
解析候选 Session
  -> 解析有效 session_renew 配置
  -> 严格信号/模型判定
  -> 确定最终 Session
  -> 使用最终 sessionId 写 messages.jsonl
  -> ACK / debounce / enqueue
```

同一聊天使用串行 renew 锁。第一条消息完成判断后，短窗口内到达的并发消息复用同一结果，避免重复创建新会话或重复调用模型。

## 7. 新会话创建

自动创建的新 Session 继承旧 Session 的路由上下文：

- `channel` / `channelType` / `channelId` / `selfAID`；
- `projectPath` / `baseagent` / `chatType` / `chatMode`；
- 对端、群、channel key 等 metadata。

不继承：

- `agentSessionId`；
- `processingState`；
- 临时任务状态。

触发 renew 的首条普通消息只写入最终选中的新 Session。

## 8. 可观测性

每次实际触发判断记录结构化日志：

```text
session=<old id>
decision=continue|new
source=explicit|reply|model|fallback|missing_history
idleHours=<number>
baseagent=claude|codex|none
model=haiku|gpt-5.6-luna|none
```

不把模型思考过程写入消息日志，不向用户发送“正在判断会话”提示。

## 9. 测试范围

- 三层配置合并和默认关闭；
- 句首短语 + 标点严格匹配；
- 中间关键词、空格分隔不匹配；
- `sessionId` 历史过滤；
- 未过期、processing、thread、无历史时跳过；
- 明确回复直接继续；
- Claude/Haiku 与 Codex/Luna 路由；
- 不支持或不可用 runner 时跳过模型分支；
- 模型 `continue` / `new` / 非法输出 / 异常降级；
- 并发消息只创建一个新 Session；
- renew 后入站消息写入最终 Session。
