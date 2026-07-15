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

模型分支不读取响应模式的 `config.auxiliaryModel`，也不跟随候选旧 Session 的 `baseagent` 或普通 Agent 会话模型。它固定使用当前 EvolAgent 的 Claude 普通模型 API，并从 Models API 返回列表中自动选择版本最高、同版本日期最新的 Haiku 精确模型 ID。

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

规则无法决定时，固定使用当前 EvolAgent 的 Claude API 配置：

1. 调用 `GET /v1/models`，处理 `has_more` / `last_id` 分页；
2. 对模型列表按网关和凭证缓存 5 分钟；
3. 从返回列表中选择版本最高、同版本日期最新的 Haiku；
4. 通过 `POST /v1/messages` 调用选中的精确模型 ID。

判定不进入 `AgentRunner`，不创建或恢复 Claude/Codex Agent 会话，也没有 project path、工具、MCP、hook、权限模式或会话持久化参数。Claude provider/Models API 不可用、列表中没有 Haiku、Messages API 失败或响应非法时，均执行 `fallback_action`。严格显式信号、明确回复和 `missing_history` 不受影响。

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

输出不合法、调用失败或“模型列表校验 + Messages 请求”整体超过 10 秒时按 `fallback_action` 降级，默认继续旧会话。

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
baseagent=claude|none
model=<selected haiku model>|none
```

不把模型思考过程写入消息日志，不向用户发送“正在判断会话”提示。

## 9. 测试范围

- 三层配置合并和默认关闭；
- 句首短语 + 标点严格匹配；
- 中间关键词、空格分隔不匹配；
- `sessionId` 历史过滤；
- 未过期、processing、thread、无历史时跳过；
- 明确回复直接继续；
- Claude Models API 分页、缓存和精确模型名称校验；
- 候选 Session 为 Claude/Codex/Gemini 时均使用 Claude judge provider；
- 模型未配置、provider 不可用或指定模型不在列表时执行 fallback；
- 模型 `continue` / `new` / 非法输出 / 异常降级；
- 并发消息只创建一个新 Session；
- renew 后入站消息写入最终 Session。
