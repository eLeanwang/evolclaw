# EvolClaw 双日志系统

EvolClaw 使用两套互补的日志系统：**evolclaw.log**（运行叙事）和 **aun-trace**（协议流水）。两者定位不同、格式不同、受众不同。

## 概览

| 维度 | evolclaw.log | aun-trace |
|------|-------------|-----------|
| 定位 | 给人看的"运行叙事" | 给机器解析的"协议审计" |
| 格式 | 纯文本（`[时间] [级别] 消息`） | NDJSON（每行独立 JSON） |
| 内容 | 决策节点 + 结果（why/what） | 所有 AUN 消息收发（how/raw） |
| 级别控制 | `debug.logLevel` 或 `LOG_LEVEL` 环境变量 | 无级别，开关式（`debug.aunTrace`） |
| 轮转 | 单文件追加 | 按日轮转 `aun-YYYYMMDD.log` |
| 默认状态 | 始终开启 | 默认关闭 |
| 覆盖范围 | 全系统（所有通道、所有组件） | 仅 AUN 通道 |

## 一、evolclaw.log

### 配置

```json
// evolclaw.json
{
  "debug": {
    "logLevel": "INFO"   // 可选: DEBUG / INFO / WARN / ERROR
  }
}
```

优先级：`config.debug.logLevel` → 环境变量 `LOG_LEVEL` → 默认 `INFO`

### 级别策略

#### INFO（默认可见）— 关键叙事节点

**入站消息处理**：
```
[AUN] P2P dispatched: from=alice(Alice) mid=mp-xxx text=你好...
[AUN] Group dispatched: group=g-dev sender=bob(Bob) mode=broadcast mid=gm-xxx text=...
```

**任务生命周期**：
```
[MessageProcessor] session=sess-1 task=task-abc123 chatType=private sessionMode=proactive agentId=claude
[MessageProcessor] session sess-1 marked as processing task=task-abc123
[MessageProcessor] proactive mode: flusher silent, outputs via thought.put task=task-abc123
[ThoughtEmitter] created channel=alice.agentid.pub task=task-abc123 chatmode=proactive
[MessageProcessor] agent.runQuery start: agent=claude session=sess-1 task=task-abc123 attempt=1/3
```

**事件流（高价值）**：
```
[MessageProcessor] Event: type=tool_use tool=Read desc="src/index.ts"
[MessageProcessor] Event: type=tool_result tool=Read ok=true
[MessageProcessor] Event: type=text text="好的，我来帮你查看代码..."
[MessageProcessor] Event: type=complete
```

**AUN 通道操作**：
```
[AUN] message.send ok: to=alice.agentid.pub mid=mp-xxx text=好的...
[AUN] group.send ok: group=g-dev mid=gm-xxx text=...
[AUN] thought.put ok p2p=alice.agentid.pub task=task-abc123 stage=tool
[AUN] task.start task=task-abc123 session=sess-1 target=alice.agentid.pub
[AUN] task.done task=task-abc123 session=sess-1 target=alice.agentid.pub
[AUN] File sent: report.md (2.3 KB) → alice.agentid.pub
```

**连接生命周期**：
```
[AUN] Authenticating as evolai.agentid.pub...
[AUN] Authenticated as evolai.agentid.pub, gateway=wss://gw.agentid.pub
[AUN] Connected
[AUN] Disconnected: connection reset
[AUN] Scheduling reconnect #1/5 in 5s
[AUN] Reconnect #1 starting...
[AUN] Reconnect #1 succeeded
```

**命令处理**：
```
[CommandHandler] handle: channel=aun-01 channelId=alice.agentid.pub cmd="/status" user=alice.agentid.pub role=owner
```

**会话管理**：
```
[SessionManager] switchProject: channel=aun-01 channelId=alice.agentid.pub newPath=/home/user/project agent=claude
```

**任务结束**：
```
[MessageProcessor] agent.cleanupStream ok: session=sess-1 task=task-abc123
[MessageProcessor] session sess-1 processing cleared task=task-abc123
```

#### DEBUG（需 `logLevel: "DEBUG"` 才可见）— 诊断/框架

```
[AUN][DIAG] message.received: kind= keys=message_id,seq,from,to,...
[AUN][DIAG] group.message_created: group_id=g-dev sender=bob.agentid.pub
[AUN][DIAG-GRP] full_msg={"module_id":"group",...前500字符...}
[AUN] Group missed: unmentioned in mention-mode (group=g-dev sender=bob mid=gm-xxx)
[AUN] P2P dropped: echo from self (from=evolai.agentid.pub mid=mp-xxx)
[AUN] Group dropped: own message (group=g-dev mid=gm-xxx)
[MessageProcessor] Event: type=session_id
[MessageProcessor] Event: type=state_changed
[MessageProcessor] Event: type=status
[MessageProcessor] Session ID updated: d3b23bb2-... for session: sess-1
[MessageProcessor] Session state: running for session: sess-1
```

#### WARN — 异常但可恢复

```
[AUN] E2EE send failed to alice.agentid.pub, retrying plaintext: ...
[AUN] group.send returned no message_id: ...
[AUN] rpc storage.put_object failed: NetworkError(TIMEOUT) ...
[MessageBridge] Unknown command intercepted: "/xyz"
```

#### ERROR — 需要关注

```
[AUN] Terminal failure: gateway_closed (session expired)
[AUN] sendFile failed for alice.agentid.pub: ENOENT
[AUN] Plaintext fallback also failed to alice.agentid.pub: ...
[MessageProcessor] Error: context_too_long
```

### 排查用法

```bash
# 跟踪实时日志
tail -f logs/evolclaw.log

# 按 task_id 追踪完整任务链路
grep "task-abc123" logs/evolclaw.log

# 看所有错误
grep "\[ERROR\]\|\[WARN\]" logs/evolclaw.log

# 看某个用户的所有交互
grep "alice.agentid.pub" logs/evolclaw.log

# 看 proactive 模式行为
grep "proactive\|thought.put" logs/evolclaw.log
```

---

## 二、aun-trace

### 配置

```json
// evolclaw.json
{
  "debug": {
    "aunTrace": true
  }
}
```

开启后写入 `{EVOLCLAW_HOME}/logs/aun-YYYYMMDD.log`，按日自动轮转。

### 格式

每行一个 JSON 对象（NDJSON / JSON Lines）：

```json
{"ts":"2026-05-12T17:24:06.201","dir":"IN","event":"message.received","data":{完整消息对象}}
{"ts":"2026-05-12T17:24:06.450","dir":"OUT","event":"message.send","data":{完整 params}}
{"ts":"2026-05-12T17:24:06.520","dir":"OUT","event":"message.send.ok","data":{"message_id":"mp-xxx"}}
```

字段说明：
- `ts`: 本地时间戳（毫秒精度）
- `dir`: `IN`（入站事件）/ `OUT`（出站调用）
- `event`: 事件名（RPC 方法名 + `.ok` / `.error` 后缀）
- `data`: 完整请求参数或响应数据

### 覆盖范围

#### 入站事件（IN）

| 事件 | 说明 | 覆盖 |
|------|------|------|
| `message.received` | P2P 消息到达 | 全量 |
| `group.message_created` | 群消息到达（含 miss） | 全量 |
| `message.recalled` | 消息撤回 | 全量 |
| `message.undecryptable` | P2P 解密失败 | 全量 |
| `group.message_undecryptable` | 群消息解密失败 | 全量 |
| `auth.result` | 认证结果 | 全量 |
| `connection.state` | 连接状态变更（connected/disconnected/reconnecting/terminal_failed） | 全量 |

#### 出站调用（OUT）— 每个调用都有"发+收"成对记录

| 调用 | trace 事件 | 说明 |
|------|-----------|------|
| 普通消息 | `message.send` / `group.send` + `.ok` | 正文发送 |
| 文件消息 | `message.send.file` / `group.send.file` + `.ok` / `.error` | 附件发送 |
| Thought | `message.thought.put` / `group.thought.put` + `.ok` / `.error` | Proactive 可观测 |
| 自定义 payload | `message.send.custom` + `.ok` / `.error` | ctl send |
| E2EE 回退 | `*.fallback` + `.fallback.ok` | 加密失败后明文重试 |
| 文件上传（小） | `storage.put_object` + `.ok` / `.error` | ≤64KB 内联 |
| 文件上传（大） | `storage.create_upload_session` + `.ok` / `.error` | 票据创建 |
| HTTP PUT | `http.put.upload_url` + `.ok` / `.error` | 实际上传 |
| 上传完成 | `storage.complete_upload` + `.ok` / `.error` | 确认 |
| 附件下载票据 | `storage.create_download_ticket` + `.ok` / `.error` | 下载前 |
| 认证 | `auth.authenticate` + `.ok` / `.error` | 启动时 |
| 连接 | `client.connect` + `.ok` / `.error` | 启动时 |
| 断开 | `client.close` + `.ok` / `.error`（含 reason） | 多处 |
| 重连 | `reconnect.start` + `.ok` / `.error` | 断线恢复 |

#### 不记录的调用

| 调用 | 原因 |
|------|------|
| `message.ack` | 每条入站都调，量大且无排查价值 |
| `sendProcessingStatus` | 已有 evolclaw.log 的 `task.xxx` INFO 日志覆盖 |

### 排查用法

```bash
# 看所有发送失败
jq 'select(.event | endswith(".error"))' logs/aun-20260512.log

# 看某条消息的完整收发
jq 'select(.data.message_id == "mp-xxx" or .data.message_id == "mp-xxx")' logs/aun-20260512.log

# 看某个 task 的所有 thought
jq 'select(.event | contains("thought")) | select(.data.context.id == "task-abc123")' logs/aun-20260512.log

# 看连接生命周期
jq 'select(.event | startswith("auth.") or startswith("client.") or startswith("reconnect.") or contains("connection.state"))' logs/aun-20260512.log

# 看所有群消息（含 miss）
jq 'select(.event == "group.message_created")' logs/aun-20260512.log

# 统计各事件类型数量
jq -r '.event' logs/aun-20260512.log | sort | uniq -c | sort -rn

# 看 E2EE 回退情况
jq 'select(.event | contains("fallback"))' logs/aun-20260512.log
```

---

## 三、互补关系

| 排查场景 | 用哪个 | 为什么 |
|---------|--------|--------|
| "服务现在在做什么" | evolclaw.log `tail -f` | 人类可读，实时叙事 |
| "为什么这条消息没回复" | evolclaw.log `grep task-xxx` | 看决策链路 |
| "Gateway 返回了什么" | aun-trace `jq .event == "*.error"` | 完整 req/resp |
| "消息是否送达" | aun-trace `jq .data.message_id` | 看 `.ok` 里的 message_id |
| "E2EE 是否正常" | aun-trace `jq "fallback\|undecryptable"` | 看回退和解密失败 |
| "连接为什么断了" | 两个都看 | evolclaw.log 看决策，trace 看时序 |
| "proactive 任务的 thought 发了吗" | evolclaw.log `grep thought.put` | INFO 级别直接可见 |
| "thought 的完整 payload 是什么" | aun-trace `jq .event == "*.thought.put"` | 含完整加密前 payload |
| "文件上传失败在哪一步" | aun-trace `jq "storage\|http.put"` | 三步流程逐步可见 |

### 设计原则

- **evolclaw.log 精简高效**：只记"发生了什么决策"，不记完整数据。一次 proactive 任务约 10-20 行 INFO。
- **aun-trace 完整全面**：记录所有 AUN 协议交互的完整 req/resp，一次任务可能 50-100 行 JSON。
- **不重复**：evolclaw.log 不记 payload 细节（trace 有）；trace 不记决策逻辑（evolclaw.log 有）。
- **级别分离**：evolclaw.log 的 DEBUG 级别用于"诊断细节"（如 DIAG、框架事件），默认不可见；trace 无级别概念，开了就全记。

---

## 四、`callAndTrace` 统一机制

AUN 通道所有 RPC 调用通过 `callAndTrace` wrapper 统一处理：

```typescript
private async callAndTrace<T>(method: string, params: Record<string, any>): Promise<T> {
  this.trace('OUT', method, params);           // 记录发送
  try {
    const result = await this.client!.call(method, params);
    this.trace('OUT', `${method}.ok`, snap);   // 记录成功
    return result;
  } catch (e) {
    this.trace('OUT', `${method}.error`, err); // 记录失败
    logger.warn(`[AUN] rpc ${method} failed`); // evolclaw.log 也记
    throw e;
  }
}
```

保证：
- 每个 OUT 调用在 trace 里都有"发+收"成对记录
- 失败同时写入 evolclaw.log（WARN 级别）
- 不需要每个调用点手动维护 trace 逻辑

**例外**（不走 wrapper 但有手动 trace）：
- `sendFile` 内部的文件发送 — 需要 `group.send.file` 等语义化事件名
- `sendCustomPayload` — fire-and-forget 模式，用 `.then/.catch`
- `message.ack` — 忽略，不记录
- `sendProcessingStatus` — 忽略，evolclaw.log 已覆盖

---

## 五、task_id 贯穿

每次任务处理生成唯一 `task_id`（格式 `task-{10hex}`），贯穿所有日志：

```
evolclaw.log:  [MessageProcessor] session=... task=task-abc123 ...
evolclaw.log:  [AUN] task.start task=task-abc123 ...
evolclaw.log:  [AUN] thought.put ok ... task=task-abc123 stage=tool
aun-trace:     {"event":"message.thought.put","data":{"context":{"type":"task","id":"task-abc123"},...}}
aun-trace:     {"event":"message.send","data":{"payload":{"task_id":"task-abc123","chatmode":"interactive",...}}}
```

用 `grep task-abc123` 可以在两套日志中同时定位同一次任务的所有相关记录。
