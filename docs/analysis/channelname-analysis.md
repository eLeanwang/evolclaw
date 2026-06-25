# channelName 完整分析

## 概念定义

`channelName` 是 EvolClaw 中用于标识一个 **channel 实例** 的唯一名称。它是 `ChannelAdapter` 接口的必需字段。

## 与 channelType 的区别

| 概念 | 含义 | 示例 | 用途 |
|------|------|------|------|
| `channelType` | 渠道类型（第一级分类） | `aun`, `feishu`, `wechat` | 决定使用哪个 Channel Plugin |
| `channelName` | 渠道实例名称（第二级标识） | `aun`, `aun-alice`, `feishu-bot1` | 唯一标识一个 channel 实例 |

**关系**：
- 单实例配置：`channelName === channelType`（如 `aun`）
- 多实例配置：`channelName` 是自定义名称（如 `aun-alice`, `aun-bob`），`channelType` 仍是 `aun`

## 定义位置

### 1. ChannelAdapter 接口

**位置**：`types.ts:348-367`

```typescript
export interface ChannelAdapter {
  readonly channelName: string;  // ← 必需字段
  readonly capabilities: ChannelCapabilities;
  send(envelope: OutboundEnvelope, payload: OutboundPayload): Promise<void>;
  // ...
}
```

### 2. 实例化时赋值

**位置**：`aun.ts:2557-2558`

```typescript
const adapter = {
  channelName: inst.name,  // ← 从配置的 name 字段读取
  capabilities: { ... },
  send: async (envelope, payload) => { ... }
};
```

**配置来源**：
```json
{
  "channels": {
    "aun": {
      "name": "aun-alice",  // ← channelName 的来源
      "aid": "alice.aid.pub",
      "enabled": true
    }
  }
}
```

或者单实例配置（自动生成 name）：
```json
{
  "channels": {
    "aun": {
      "aid": "alice.aid.pub",
      "enabled": true
      // name 缺省时，normalizeChannelInstances 会设为 "aun"
    }
  }
}
```

## 使用场景

### 1. Agent Registry 关联

**用途**：将 channel 实例绑定到 agent

**代码位置**：`index.ts:668-670`

```typescript
const agent = agentRegistry.resolveByChannel(inst.adapter.channelName);
if (!agent || agent.status === 'error') continue;
agent.channels.set(inst.adapter.channelName, inst.adapter);
```

**查询**：
```typescript
agentRegistry.resolveByChannel(channelName) // 返回拥有该 channel 的 agent
```

### 2. Session 管理

**重要**：Session 目录结构使用的是 **channelType** 而不是 channelName！

**实际目录结构**：
```
~/.evolclaw/data/sessions/
├── aun/                           ← channelType（不是 channelName！）
│   ├── alice.aid.pub/             ← channelId
│   │   └── active.json
│   └── bob.aid.pub/
├── feishu/                        ← channelType
│   └── ou_xxx/
└── toleiliang5.agentid.pub#aun#main/  ← 特殊格式（旧版兼容？）
```

**代码位置**：`session-fs-store.ts:59-65`

```typescript
export function chatDirPath(sessionsDir: string, channelType: string, channelId: string, selfId?: string | null): string {
  if (channelType === 'aun') {
    const self = selfId || '_unknown';
    return path.join(sessionsDir, 'aun', encodeSegment(self), encodeSegment(channelId));
  }
  return path.join(sessionsDir, channelType, encodeSegment(channelId));
}
```

**注意**：
- `getOrCreateSession` 的第一个参数是 `channel`（实际是 channelName）
- 但内部通过 `channelType` 参数或 fallback 到 `channel` 来确定目录路径
- 多实例配置时，不同 channelName 可能共享同一个 channelType 目录

### 3. MessageProcessor 注册

**用途**：注册 channel 到消息处理器

**代码位置**：`index.ts:630`

```typescript
processor.registerChannel(inst.adapter, inst.policy || defaultPolicy, opts);
```

**内部存储**：
```typescript
// MessageProcessor 内部
private channels = new Map<string, ChannelInfo>();

registerChannel(adapter: ChannelAdapter, ...) {
  this.channels.set(adapter.channelName, { adapter, ... });
}
```

### 4. CommandHandler 注册

**用途**：注册 channel 到命令处理器

**代码位置**：`index.ts:632-634`

```typescript
cmdHandler.registerAdapter(inst.adapter);
cmdHandler.registerChannel(inst.adapter.channelName, inst.channel, inst.channelType);
if (inst.policy) {
  cmdHandler.registerPolicy(inst.adapter.channelName, inst.policy);
}
```

### 5. MessageBridge 注册

**用途**：注册 channel 到消息桥接器

**代码位置**：`index.ts:645-648`

```typescript
const channelType = inst.channelType || inst.adapter.channelName;
if (inst.registerBridge) {
  inst.registerBridge(msgBridge, channelType);
}
```

### 6. 日志记录

**用途**：标识消息来源的 channel

**代码位置**：`index.ts:604`

```typescript
logger.channelOut({ 
  channel: inst.adapter.channelName,  // ← 日志中的 channel 字段
  channelId: envelope.channelId, 
  taskId: envelope.taskId, 
  payload 
});
```

**日志格式**：
```json
{
  "channel": "aun-alice",
  "channelId": "bob.aid.pub",
  "taskId": "task-a1b2c3d4e5",
  "payload": { ... }
}
```

### 7. 事件总线

**用途**：发布 channel 连接事件

**代码位置**：`index.ts:696-701`

```typescript
eventBus.publish({
  type: 'channel:connected',
  channel: type.toLowerCase(),      // channelType
  channelName: name,                // channelName
  timestamp: Date.now()
});
```

### 8. 重复检测

**用途**：检测多个 agent 使用相同的 channel 凭证

**代码位置**：`index.ts:276`

```typescript
const owners = d.agents.map(o => `${o.aid}(${o.channelName})`).join(', ');
logger.warn(`⚠ Duplicate channel credential: ${d.fingerprint} claimed by ${owners}.`);
```

### 9. Thread 预加载（Feishu）

**用途**：重启后恢复已知的 thread_id

**代码位置**：`index.ts:686-690`

```typescript
const channelType = inst.channelType || inst.adapter.channelName;
if (channelType === 'feishu' && 'preloadThreads' in inst.channel) {
  const threadIds = sessionManager.getKnownThreadIds(inst.adapter.channelName);
  (inst.channel as any).preloadThreads(threadIds);
}
```

### 10. 系统通知

**用途**：向 channel 发送系统通知

**代码位置**：`index.ts:728`

```typescript
const envelope = buildEnvelope({
  taskId: `system-online-${crypto.randomBytes(5).toString('hex')}`,
  channel: adapter.channelName,  // ← 指定目标 channel
  channelId: ownerAid,
  agentName,
});
```

## 命名规范

### 单实例配置

```json
{
  "channels": {
    "aun": {
      "aid": "alice.aid.pub"
    }
  }
}
```

**结果**：`channelName = "aun"`

### 多实例配置

```json
{
  "channels": {
    "aun": [
      {
        "name": "aun-alice",
        "aid": "alice.aid.pub"
      },
      {
        "name": "aun-bob",
        "aid": "bob.aid.pub"
      }
    ]
  }
}
```

**结果**：
- 实例 1：`channelName = "aun-alice"`
- 实例 2：`channelName = "aun-bob"`

### 命名建议

- **单实例**：使用 channelType 作为 name（如 `aun`, `feishu`）
- **多实例**：使用 `{channelType}-{标识符}` 格式（如 `aun-alice`, `feishu-bot1`）
- **避免**：特殊字符、空格、中文（可能影响文件系统路径）

## 数据流

### 配置 → 实例化

```
config.json
  channels.aun.name = "aun-alice"
    ↓
normalizeChannelInstances()
  inst.name = "aun-alice"
    ↓
AUNChannelPlugin.createChannels()
  adapter.channelName = inst.name
    ↓
ChannelAdapter { channelName: "aun-alice" }
```

### 消息处理

```
收到消息
  ↓
MessageBridge.handleMessage(channelName, ...)
  ↓
MessageProcessor.channels.get(channelName)  ← 使用 channelName 查找 adapter
  ↓
SessionManager.getOrCreateSession(
  channel: channelName,     ← 传入 channelName
  channelId,
  ...,
  channelType               ← 传入 channelType（可选）
)
  ↓
内部使用 channelType 确定目录路径
  ↓
Session 存储在 ~/.evolclaw/data/sessions/{channelType}/{channelId}/
```

**关键点**：
- MessageProcessor 使用 **channelName** 作为 adapter 的索引
- SessionManager 使用 **channelType** 作为文件系统路径
- 多实例配置时，不同 channelName 的 session 可能存储在同一个 channelType 目录下

### 日志记录

```
adapter.send(envelope, payload)
  ↓
logger.channelOut({ channel: adapter.channelName, ... })
  ↓
~/.evolclaw/logs/channel-out.log
  { "channel": "aun-alice", ... }
```

## 与其他标识符的关系

| 标识符 | 层级 | 示例 | 用途 |
|--------|------|------|------|
| `channelType` | 渠道类型 | `aun`, `feishu` | Plugin 选择、文件系统路径 |
| `channelName` | 实例名称 | `aun-alice`, `feishu-bot1` | Adapter 标识、Agent 关联 |
| `channelId` | 会话标识 | `alice.aid.pub`, `ou_xxx` | 对端标识 |
| `sessionId` | 会话 ID | `meta_20260524_1716800000000` | Session 唯一 ID |
| `taskId` | 任务 ID | `task-a1b2c3d4e5` | 任务标识 |
| `threadId` | 线程 ID | `topic-123` | 线程标识 |

**层级关系**：
```
channelType (aun)                          ← 文件系统路径
  └── channelName (aun-alice)              ← Adapter 标识
      └── channelId (alice.aid.pub)        ← 对端标识
          ├── sessionId (meta_20260524_...) ← Session 实例
          │   └── taskId (task-a1b2c3d4e5)  ← 任务实例
          └── threadId (topic-123)          ← 线程标识
              └── thread sessionId (...)    ← Thread Session 实例
```

**重要区别**：
- **channelType** 用于文件系统路径：`~/.evolclaw/data/sessions/{channelType}/`
- **channelName** 用于内存索引：`MessageProcessor.channels.get(channelName)`

## 典型场景

### 场景 1：单个 agent，单个 AUN channel

```json
{
  "agents": [
    {
      "aid": "alice.aid.pub",
      "channels": ["aun"]
    }
  ],
  "channels": {
    "aun": {
      "aid": "alice.aid.pub"
    }
  }
}
```

**结果**：
- `channelName = "aun"`
- `agentRegistry.resolveByChannel("aun")` → alice agent

### 场景 2：单个 agent，多个 AUN channel

```json
{
  "agents": [
    {
      "aid": "alice.aid.pub",
      "channels": ["aun-alice", "aun-work"]
    }
  ],
  "channels": {
    "aun": [
      {
        "name": "aun-alice",
        "aid": "alice.aid.pub"
      },
      {
        "name": "aun-work",
        "aid": "alice-work.aid.pub"
      }
    ]
  }
}
```

**结果**：
- `channelName = "aun-alice"` 和 `"aun-work"`
- 两个 channel 都属于 alice agent
- **Session 存储在同一个 channelType 目录**：`~/.evolclaw/data/sessions/aun/`
- 通过不同的 selfId 区分：
  - `aun/alice.aid.pub/` （aun-alice 的 session）
  - `aun/alice-work.aid.pub/` （aun-work 的 session）

### 场景 3：多个 agent，各自的 channel

```json
{
  "agents": [
    {
      "aid": "alice.aid.pub",
      "channels": ["aun-alice"]
    },
    {
      "aid": "bob.aid.pub",
      "channels": ["aun-bob"]
    }
  ],
  "channels": {
    "aun": [
      {
        "name": "aun-alice",
        "aid": "alice.aid.pub"
      },
      {
        "name": "aun-bob",
        "aid": "bob.aid.pub"
      }
    ]
  }
}
```

**结果**：
- `agentRegistry.resolveByChannel("aun-alice")` → alice agent
- `agentRegistry.resolveByChannel("aun-bob")` → bob agent

## 调试技巧

### 1. 查看所有 channel 类型

```bash
# 查看 session 目录（按 channelType 分组）
ls ~/.evolclaw/data/sessions/
# 输出：aun  feishu  wechat
```

### 2. 查看特定 channelType 的所有 session

```bash
# 查看 aun 类型的所有 session（包含所有 aun-* channelName 的 session）
ls ~/.evolclaw/data/sessions/aun/
# 输出：alice.aid.pub  bob.aid.pub  charlie.aid.pub
```

### 3. 查看 channel 的日志

```bash
# 过滤特定 channelName 的出站消息
jq 'select(.channel == "aun-alice")' ~/.evolclaw/logs/channel-out.log
```

### 4. 区分 channelType 和 channelName

```bash
# channelType 用于文件系统
ls ~/.evolclaw/data/sessions/  # 看到的是 channelType

# channelName 用于日志
jq '.channel' ~/.evolclaw/logs/channel-out.log | sort -u  # 看到的是 channelName
```

## 设计原则

1. **唯一性**：每个 channel 实例必须有唯一的 channelName
2. **可读性**：使用有意义的名称（如 `aun-alice` 而不是 `ch1`）
3. **一致性**：单实例用 channelType，多实例用 `{type}-{id}` 格式
4. **持久性**：channelName 用于内存索引，channelType 用于文件系统路径
5. **隔离性**：不同 channelName 在内存中完全隔离，但可能共享 channelType 目录

## 关键发现

### channelName vs channelType 的使用场景

| 场景 | 使用 | 说明 |
|------|------|------|
| ChannelAdapter 标识 | channelName | `adapter.channelName` |
| MessageProcessor 索引 | channelName | `channels.get(channelName)` |
| Agent Registry 关联 | channelName | `resolveByChannel(channelName)` |
| 日志记录 | channelName | `logger.channelOut({ channel: channelName })` |
| 文件系统路径 | channelType | `~/.evolclaw/data/sessions/{channelType}/` |
| Session 目录 | channelType | `chatDirPath(sessionsDir, channelType, ...)` |

### 多实例配置的影响

**配置**：
```json
{
  "channels": {
    "aun": [
      { "name": "aun-alice", "aid": "alice.aid.pub" },
      { "name": "aun-bob", "aid": "bob.aid.pub" }
    ]
  }
}
```

**结果**：
- **内存层面**：两个独立的 adapter（`aun-alice` 和 `aun-bob`）
- **文件系统层面**：共享同一个目录（`~/.evolclaw/data/sessions/aun/`）
- **区分方式**：通过 selfId（alice.aid.pub vs bob.aid.pub）

## 日期

2026-05-24
