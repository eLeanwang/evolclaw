# `ec msg history` 会话过滤设计

> 日期：2026-07-13  
> 状态：已实现

## 1. 目标

为 `ec msg` 增加本地消息历史查询能力。查询始终限定在一对 AUN 私聊身份：

```text
<self-aid> ↔ <target-aid>
```

同时支持按 EvolClaw 逻辑会话过滤，使同一对端经过 `/new` 创建多个会话后，可以只读取某一个会话关联的消息。

本功能读取本地 `messages.jsonl`，不调用 AUN `message.pull`，因此不会读取或推进网络收件箱游标。

## 2. 命令接口

```bash
ec msg history <self-aid> <target-aid>
  [--session <latest|all|session-id>]
  [--limit <N>]
  [--before <time>]
  [--after <time>]
  [--direction <in|out|all>]
  [--format <text|json>]
```

示例：

```bash
# 查询最新激活会话最近 50 条消息
ec msg history alice.agentid.pub bob.agentid.pub

# 只查询当前激活会话
ec msg history alice.agentid.pub bob.agentid.pub --session latest

# 查询指定归档会话
ec msg history alice.agentid.pub bob.agentid.pub --session meta_20260713_1783920000000

# 查询该 AID 对全部历史（包括没有 sessionId 的旧记录）
ec msg history alice.agentid.pub bob.agentid.pub --session all

# 查询时间范围内的入站消息
ec msg history alice.agentid.pub bob.agentid.pub \
  --after 2026-07-13T00:00:00+08:00 --direction in --limit 100
```

### 2.1 参数语义

- 不传 `--session`：等价于 `--session latest`。
- `--session latest`：读取该 AID 对目录下的 `active.json`，使用其中的 `id` 精确过滤。它表示最新激活会话，不读取任务运行时环境，也不解析 `EVOLCLAW_SESSION_ID`。
- `--session all`：查询该 AID 对的全部本地消息历史，包括没有 `sessionId` 的旧记录。
- `--session <session-id>`：使用给定的 EvolClaw 逻辑会话 ID 精确过滤。
- `--limit`：默认 `50`，最大 `500`；取过滤结果中时间最新的 N 条，最终按时间正序输出。
- `--before` / `--after`：支持 epoch 毫秒或可由 `Date.parse()` 解析的时间；边界为开区间。
- `--direction`：默认 `all`。
- `--format text`：默认的人类可读输出。
- `--format json`：输出稳定的 JSON 对象，包含查询元数据与消息数组。

`latest` 找不到有效 `active.json` 时返回明确错误，不得降级为全量查询。

## 3. 数据范围

查询只读取：

```text
$EVOLCLAW_HOME/data/sessions/aun/<encoded-self-aid>/<encoded-target-aid>/messages.jsonl
```

路径必须由现有 `chatDirPath()` 构造，命令不接受任意文件路径。查询不会扫描其他 self AID、其他 peer 或其他 channel。

以下记录不返回：

- `msgType === "handoff_state"` 的内部状态事件；
- 不满足 session、方向或时间过滤条件的记录。

文件或消息记录不存在时返回空结果，不创建会话目录或日志文件。

## 4. 会话标识

`MessageLogEntry` 增加可选字段：

```ts
sessionId?: string;
```

该字段唯一表示 EvolClaw 的本地逻辑会话 `Session.id`：

- 不使用 Claude/Codex/Gemini 的 `agentSessionId`；模型上下文可能因清理或恢复而变化。
- 不信任或复用对端 payload 自报的 `session_id`。
- `/new` 创建新 `Session.id`，因此新旧上下文自然隔离。
- 切换回归档会话时继续使用原 `Session.id`。

日志格式保持 append-only，无需迁移或重写旧数据。

### 4.1 写入规则

只有能够从本地可信链路确定会话时才写 `sessionId`：

1. 普通入站消息：MessageBridge 解析或创建 session 后，使用 `session.id`。
2. 正常 Agent 出站消息、文件和结构化消息：由已解析 session 的响应/命令链路显式写入 `ReplyContext.sessionId`，发送渠道据此落盘。通用 `OutboundEnvelope.sessionId` 可能表示审批或任务关联，不直接作为目标聊天的消息归属。
3. 会话内执行的 `ec msg send`：从可信 `TaskRuntimeContext.sessionId` 写入。
4. 非 AUN 渠道现有消息日志也可随已解析的本地 session 写入相同字段，保持 schema 一致。

无法绑定本地会话的记录不写该字段，例如：

- 人工终端直接执行 `ec msg send`；
- 在 session 解析前走命令快速路径的 slash/menu 消息；
- 在 session 解析前被渠道层消费或丢弃的协议/信号消息；
- 历史版本已经存在的记录。

### 4.2 兼容规则

- 使用 `--session all` 时，旧记录照常可见。
- 使用 `latest` 或指定 session ID 过滤时，只返回 `entry.sessionId` 精确相等的记录。
- 不根据时间、thread、active.json 或消息内容猜测旧记录所属 session。

## 5. 授权边界

`history` 的查询实现不解析 role，也不判断 relation 权限，与现有 `msg pull/ack/recall/online` 的命令层职责保持一致。

命令层只负责：

- AID、session、时间、方向和数量参数校验；
- 固定目录构造与安全读取；
- 返回数量上限。

是否允许 Agent 工具执行该 Bash 命令，由现有 Hook/权限系统负责。本期不新增 `ec.msg.history` operation，也不修改 `send/file` 专用 EC 鉴权解析器。

`sessionId` 仅是查询过滤字段，不是授权凭证。

## 6. 返回结构

JSON 格式：

```json
{
  "ok": true,
  "self_aid": "alice.agentid.pub",
  "target_aid": "bob.agentid.pub",
  "session_id": "meta_20260713_1783920000000",
  "count": 2,
  "messages": [
    {
      "ts": 1783920000000,
      "time": "2026-07-13 10:40:00.000",
      "dir": "in",
      "from": "bob.agentid.pub",
      "to": "alice.agentid.pub",
      "sessionId": "meta_20260713_1783920000000",
      "msgId": "message-id",
      "msgType": "text",
      "content": "hello"
    }
  ]
}
```

文本格式每条至少展示时间、方向、对端、消息类型与正文；没有结果时输出“暂无消息历史”。

## 7. 实现位置

- `src/core/message/message-log.ts`：扩展 schema 和 builder 参数。
- `src/core/message/message-bridge.ts`：普通入站写入 `session.id`。
- `src/core/message/response-engine.ts`、channel 出站链路：透传本地 session ID。
- `src/aun/msg/history.ts`：本地历史查询与过滤。
- `src/aun/msg/index.ts`：导出查询接口。
- `src/cli/aun-commands.ts`：增加 `history` 子命令与输出。
- `kits/docs/evolclaw/msg.md`：用户文档。

## 8. 测试范围

- message log builder 正确保留 `sessionId`。
- 不带 session 过滤时兼容旧记录。
- `latest` 从 `active.json` 解析会话。
- 指定 session ID 精确过滤，并排除旧记录。
- direction、before、after、limit 组合过滤。
- `handoff_state` 排除。
- 空文件、缺失文件、损坏 JSONL 行容错。
- 无效 AID、session、时间、direction、limit 返回参数错误。
