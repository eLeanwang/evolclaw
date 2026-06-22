# Source 标记实现报告

## 问题描述

用户希望通过消息日志清楚地区分消息的发送来源和发送方式：

### 发送来源（3种）

| 来源 | 说明 | 标记 |
|------|------|------|
| 用户手动 CLI | 用户在终端执行 `ec msg send` | `cli` |
| Agent 调用 CLI | Agent 在会话中执行 `ec msg send` | `msg` |
| Agent 调用 IPC | Agent 在会话中执行 `ec ctl send` | `ctl` |
| EvolClaw 代码 | daemon 内部调用 `adapter.send()` | `daemon` |

### 发送方式（2种）

| 方式 | 标记 | 对端能否收到 |
|------|------|--------------|
| `message.send` | `msgType: "text"` | 是 |
| `thought.put` | `msgType: "thought"` | 否 |

## 实现方案

### 1. 扩展 source 类型

**文件**：`src/core/message/message-log.ts`

```typescript
// 修改前
source?: 'daemon' | 'cli';

// 修改后
source?: 'daemon' | 'cli' | 'msg' | 'ctl';
```

### 2. CLI 发送（ec msg send）

**文件**：`src/aun/msg/p2p.ts`

通过 `CLAUDE_SESSION_ID` 环境变量区分：

```typescript
// 判断是 agent 调用还是用户手动调用
const isInSession = !!process.env.CLAUDE_SESSION_ID;
const source = isInSession ? 'msg' : 'cli';
```

**逻辑**：
- Agent 在会话中执行命令 → 有 `CLAUDE_SESSION_ID` → `source = 'msg'`
- 用户手动执行命令 → 无 `CLAUDE_SESSION_ID` → `source = 'cli'`

### 3. IPC 发送（ec ctl send）

**文件**：`src/core/command-handler.ts`

在 `replyContext.metadata` 中添加 `source: 'ctl'`：

```typescript
const enrichedReplyContext = forceEncrypt
  ? { ...(replyContext ?? {}), metadata: { ...(replyContext?.metadata ?? {}), encrypted: true, source: 'ctl' } }
  : { ...(replyContext ?? {}), metadata: { ...(replyContext?.metadata ?? {}), source: 'ctl' } };
```

### 4. Daemon 发送

**文件**：`src/channels/aun.ts`

从 `context.metadata.source` 读取，默认为 `'daemon'`：

```typescript
const source = (context?.metadata?.source as 'daemon' | 'cli' | 'msg' | 'ctl' | undefined) ?? 'daemon';
```

### 5. 传递 source 到日志

**文件**：`src/channels/aun.ts`

修改 `appendOutboundJsonl()` 接受 `source` 参数，并传递给 `buildOutboundEntry()`：

```typescript
private appendOutboundJsonl(..., source: 'daemon' | 'cli' | 'msg' | 'ctl' = 'daemon'): void {
  appendMessageLog(chatDir, buildOutboundEntry({
    // ...
    source,
  }));
}
```

## 实现清单

| # | 文件 | 修改内容 |
|---|------|----------|
| 1 | `src/core/message/message-log.ts` | 扩展 source 类型 |
| 2 | `src/aun/msg/p2p.ts` | 通过 CLAUDE_SESSION_ID 区分 cli/msg |
| 3 | `src/core/command-handler.ts` | 在 replyContext 中添加 source: 'ctl' |
| 4 | `src/channels/aun.ts` | deliverTextEntry 从 context 读取 source |
| 5 | `src/channels/aun.ts` | appendOutboundJsonl 接受 source 参数 |
| 6 | `src/channels/aun.ts` | 调用 appendOutboundJsonl 时传递 source |

## 验证场景

### 场景1：用户手动 CLI

```bash
# 用户在终端执行
ec msg send llbot.aid.pub dddd.aid.pub "test"
```

**预期日志**：
```json
{
  "dir": "out",
  "msgType": "text",
  "source": "cli",
  "chatmode": "proactive"
}
```

### 场景2：Agent 调用 ec msg send

```bash
# Agent 在会话中执行
ec msg send dddd.aid.pub llbot.aid.pub "reply"
```

**预期日志**：
```json
{
  "dir": "out",
  "msgType": "text",
  "source": "msg",
  "chatmode": "proactive"
}
```

### 场景3：Agent 调用 ec ctl send

```bash
# Agent 在会话中执行
ec ctl send "reply"
```

**预期日志**：
```json
{
  "dir": "out",
  "msgType": "text",
  "source": "ctl",
  "chatmode": "interactive"
}
```

### 场景4：Daemon 内部调用

```typescript
// EvolClaw 代码内部
await adapter.send(...);
```

**预期日志**：
```json
{
  "dir": "out",
  "msgType": "text",
  "source": "daemon",
  "chatmode": "interactive"
}
```

### 场景5：thought.put

```typescript
// Agent 输出 thought
await adapter.sendThought(...);
```

**预期日志**：
```json
{
  "dir": "out",
  "msgType": "thought",
  "source": "daemon",
  "chatmode": "proactive"
}
```

## 标记含义总结

### source 字段

| 值 | 含义 | 判断依据 |
|---|------|----------|
| `cli` | 用户手动 CLI | 无 CLAUDE_SESSION_ID |
| `msg` | Agent 调用 ec msg send | 有 CLAUDE_SESSION_ID |
| `ctl` | Agent 调用 ec ctl send | replyContext.metadata.source = 'ctl' |
| `daemon` | EvolClaw 代码调用 | 默认值 |

### msgType 字段

| 值 | 含义 | 对端能否收到 |
|---|------|--------------|
| `text` | message.send | 是 |
| `thought` | thought.put | 否 |

## 使用示例

### watch msg 显示

```
llbot → dddd: [明文|自主][msg] "test message"
         ↑      ↑     ↑
      chatmode  |   source
              encrypt
```

### 日志分析

```bash
# 查看所有 agent 调用 ec msg send 的消息
jq 'select(.source == "msg")' messages.jsonl

# 查看所有 thought 消息
jq 'select(.msgType == "thought")' messages.jsonl

# 查看所有用户手动发送的消息
jq 'select(.source == "cli")' messages.jsonl
```

## 注意事项

1. **CLAUDE_SESSION_ID 依赖**：依赖 Claude Code 设置的环境变量，如果其他 base agent 没有这个变量，会被误判为 `cli`

2. **向后兼容**：旧的消息日志没有 `source` 字段，读取时需要处理 `undefined`

3. **source 优先级**：
   - `replyContext.metadata.source` 存在 → 使用它
   - 不存在 → 默认 `'daemon'`

4. **msgType 与 source 独立**：
   - `msgType` 表示发送方式（message.send / thought.put）
   - `source` 表示发送来源（daemon / cli / msg / ctl）
   - 两者可以任意组合

## 下一步

1. 测试所有场景，验证 source 标记是否正确
2. 更新 `ec watch msg` 显示逻辑，展示 source 信息
3. 更新文档，说明 source 字段的含义
