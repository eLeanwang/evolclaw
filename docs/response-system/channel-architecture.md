# 响应层与渠道层的架构关系

本文档回答两个关键问题：
1. 不同的渠道，出站消息怎么处理？
2. 响应层和渠道之间是怎么个架构关系？

---

## 一、当前架构：响应层与渠道层的关系

### 1.1 层级关系

```
┌─────────────────────────────────────────────────────┐
│                  Message Processor                  │  ← 响应层（当前）
│  - 决定何时处理消息（chatmode: interactive/proactive）│
│  - 创建 IMRenderer                                  │
│  - 调用 agent.runQuery()                            │
└────────────────┬────────────────────────────────────┘
                 │ IMRenderer.send(payload)
                 ↓
┌─────────────────────────────────────────────────────┐
│                   IMRenderer                        │  ← 输出缓冲层
│  - 收集 agent 输出                                  │
│  - 格式化为 OutboundPayload                         │
│  - 调用 adapter.send(envelope, payload)             │
└────────────────┬────────────────────────────────────┘
                 │ adapter.send(envelope, payload)
                 ↓
┌─────────────────────────────────────────────────────┐
│                 Channel Adapter                     │  ← 渠道适配层
│  - AUN Adapter / Feishu Adapter / WeChat Adapter   │
│  - 按 payload.kind 分发到具体发送方法               │
│  - 调用底层 SDK（AUNClient/飞书SDK/微信SDK）         │
└─────────────────────────────────────────────────────┘
```

### 1.2 关键接口

**ChannelAdapter 接口**（src/types.ts:440）：

```typescript
export interface ChannelAdapter {
  readonly channelName: string;
  readonly channelKey: string;
  readonly capabilities: ChannelCapabilities;  // 渠道能力声明
  
  // 统一出站入口，按 OutboundPayload.kind 分发
  send(envelope: OutboundEnvelope, payload: OutboundPayload): Promise<void>;
  
  // 其他方法...
}
```

**OutboundPayload**（src/types.ts:997）：

```typescript
export type OutboundPayload =
  | { kind: 'result.text'; text: string; isFinal: boolean }
  | { kind: 'result.file'; filePath: string; fileName?: string }
  | { kind: 'result.image'; data: Buffer; mimeType?: string }
  | { kind: 'activity.batch'; items: ThoughtItem[] }  // thought 协议
  | { kind: 'status.started'; ... }
  | { kind: 'status.completed'; ... }
  | { kind: 'interaction'; interaction: InteractionRequest; ... }
  | { kind: 'system.notice'; text: string; subtype: string }
  | { kind: 'custom'; channelType: string; payload: unknown };
```

**OutboundEnvelope**（src/types.ts:1017）：

```typescript
export interface OutboundEnvelope {
  taskId: string;
  sessionId?: string;
  channel: string;
  channelId: string;
  agentName: string;
  chatmode: 'interactive' | 'proactive';
  replyContext?: ReplyContext;  // 回复上下文（如 replyToMessageId）
  timestamp: number;
}
```

---

## 二、不同渠道的出站消息处理机制

### 2.1 统一入口：adapter.send()

**所有渠道的出站消息都经过同一个入口**：`adapter.send(envelope, payload)`

**调用位置**：`message-processor.ts:931`

```typescript
await adapter.send(enrichedEnvelope, payload);
```

### 2.2 渠道内部分发机制

**以 AUN Adapter 为例**（src/channels/aun.ts 末尾，plugin 返回的 adapter 对象）：

```typescript
const adapter = {
  send: async (envelope: OutboundEnvelope, payload: OutboundPayload) => {
    const channelId = envelope.channelId;
    const replyCtx = envelope.replyContext;

    // 按 payload.kind 分发到不同处理方法
    switch (payload.kind) {
      case 'result.text':
        await channel.sendMessage(channelId, payload.text, replyCtx);
        break;
        
      case 'result.file':
        await channel.sendFile(channelId, payload.filePath, replyCtx);
        break;
        
      case 'activity.batch':  // thought 协议
        const taskId = envelope.metadata?.taskId || envelope.taskId;
        await channel.sendThought(channelId, taskId, { items: payload.items }, replyCtx);
        break;
        
      case 'status.started':
      case 'status.completed':
        // AUN 不发送 status（或发到特定频道）
        break;
        
      case 'interaction':
        // 发送交互式卡片
        await channel.sendContentPayload(channelId, /* card payload */, { ... });
        break;
        
      case 'custom':
        await channel.sendCustomPayload(channelId, payload.payload);
        break;
        
      default:
        logger.warn(`[AUN] Unhandled payload kind: ${payload.kind}`);
    }
  }
};
```

### 2.3 不同渠道的差异处理

#### 能力声明（ChannelCapabilities）

```typescript
export interface ChannelCapabilities {
  file: boolean;       // 是否支持文件
  image: boolean;      // 是否支持图片
  interaction: boolean; // 是否支持交互式组件（按钮/菜单）
  markdown: boolean;   // 是否支持 Markdown
  thought: boolean;    // 是否支持 thought 协议（proactive 模式关键）
  status: boolean;     // 是否支持状态消息
  thread: boolean;     // 是否支持消息线索（回复）
}
```

**不同渠道的能力差异**：

| 渠道 | thought | interaction | markdown | file | image |
|------|---------|-------------|----------|------|-------|
| AUN | ✅ | ✅ | ✅ | ✅ | ✅ |
| 飞书 | ❌ | ✅ | ✅ | ✅ | ✅ |
| 微信 | ❌ | ❌ | ❌ | ✅ | ✅ |

#### 消息过滤机制（message-processor.ts:908-910）

```typescript
// proactive 模式：activity.batch 是 thought 协议内容，
// 只发给支持 thought 的 channel（不支持的静默丢弃）
if (isProactive && payload.kind === 'activity.batch' && !adapter.capabilities?.thought) {
  return;  // ← 不发送
}
```

**逻辑**：
- 如果渠道不支持 thought 协议（如飞书、微信），proactive 模式的 thought 消息会被**静默丢弃**
- 只有工具调用的结果会发送（因为 `result.text` 不受此限制）

---

## 三、插件化后的架构变化

### 3.1 新架构

```
┌─────────────────────────────────────────────────────┐
│               Response Mode Coordinator             │  ← 响应层（插件化后）
│  - 解析当前响应模式（interactive/proactive/...）    │
│  - 调用 mode.handleInbound() 决定是否处理           │
│  - 调用 mode.handleOutbound() 决定如何发送          │
└────────────────┬────────────────────────────────────┘
                 │ mode.handleOutbound(payload)
                 │ ↓ 返回 OutboundDecision
                 │
                 ↓
┌─────────────────────────────────────────────────────┐
│               Decision Executor                     │  ← 决策执行层（新增）
│  - 执行 OutboundDecision                            │
│  - 根据 decision.method 调用不同逻辑：              │
│    • direct → channel.send()                        │
│    • suppress → 不发送                              │
│    • customSender → 调用自定义发送器                │
└────────────────┬────────────────────────────────────┘
                 │ channel.send(content, type)
                 ↓
┌─────────────────────────────────────────────────────┐
│                 Channel Adapter                     │  ← 渠道适配层（不变）
│  - 按 payload.kind 分发                             │
│  - 调用底层 SDK                                     │
└─────────────────────────────────────────────────────┘
```

### 3.2 关键变化

#### 变化 1：IMRenderer 退化

**现状**：IMRenderer 有 chatMode 感知，判断是否发送 thought  
**插件化后**：IMRenderer 只负责"收集输出、缓冲"，不判断是否发送

**理由**：chatMode 逻辑应该由响应模式接管，而不是 IMRenderer

#### 变化 2：响应模式决定出站策略

**现状**：MessageProcessor 判断 `isProactive`，IMRenderer 判断 `adapter.capabilities.thought`  
**插件化后**：响应模式的 `handleOutbound()` 完全接管

**示例**（proactive 模式）：

```typescript
class ProactiveMode implements ResponseMode {
  async handleOutbound(payload: OutboundPayload, context: ResponseModeContext): Promise<OutboundDecision> {
    // 判断渠道能力
    if (!context.channel.capabilities.supportsThought) {
      // 不支持 thought 的渠道
      if (payload.isToolCall) {
        return { method: 'direct' };  // 工具调用正常发送
      } else {
        return { method: 'suppress' };  // 普通文本不发送
      }
    }
    
    // 支持 thought 的渠道
    if (payload.kind === 'text') {
      return { method: 'direct', type: 'thought' };  // 作为 thought 发送
    } else {
      return { method: 'direct' };  // 其他正常发送
    }
  }
}
```

#### 变化 3：ResponseModeContext 提供渠道能力查询

**接口设计**（已在 architecture.md 中定义）：

```typescript
interface ResponseModeContext {
  channel: {
    type: string;
    capabilities: {
      supportsThought: boolean;
      supportsInteraction: boolean;
      supportsRichText: boolean;
    };
    send(content: string, type?: 'message' | 'thought'): Promise<void>;
  };
  // ...其他字段
}
```

**用途**：
- 响应模式通过 `context.channel.capabilities` 查询渠道能力
- 根据能力做出不同的出站决策

---

## 四、关键问题解答

### Q1：不同的渠道，出站消息怎么处理？

**答**：

1. **统一入口**：所有渠道都通过 `adapter.send(envelope, payload)` 处理出站消息
2. **渠道内分发**：Adapter 根据 `payload.kind` 分发到不同的具体方法（sendMessage/sendFile/sendThought）
3. **能力差异**：通过 `adapter.capabilities` 声明，调用方（IMRenderer 或响应模式）根据能力决定是否发送
4. **插件化后**：响应模式通过 `context.channel.capabilities` 查询能力，在 `handleOutbound()` 中决定出站策略

### Q2：响应层和渠道之间是怎么个架构关系？

**答**：

**当前架构**：
```
MessageProcessor（响应层）
  → IMRenderer（输出缓冲层，有 chatMode 感知）
    → ChannelAdapter（渠道适配层）
      → 底层 SDK
```

**插件化后架构**：
```
ResponseModeCoordinator（响应层）
  → ResponseMode.handleOutbound()（响应模式决策）
    → DecisionExecutor（决策执行层）
      → IMRenderer（纯缓冲器，无 chatMode 判断）
        → ChannelAdapter（渠道适配层，不变）
          → 底层 SDK
```

**职责分离**：
- **响应层**：决定"是否处理消息、如何响应、何时发送"
- **渠道层**：负责"底层协议适配、具体发送实现"
- **中间层**（IMRenderer/DecisionExecutor）：解耦响应层和渠道层，响应层不直接调用渠道

**接口隔离**：
- 响应层只依赖 `ResponseModeContext.channel`（抽象接口）
- 不直接依赖具体的 AUNAdapter/FeishuAdapter
- 新增渠道时，只需实现 ChannelAdapter 接口，响应层无需改动

---

## 五、插件化对渠道层的影响

### 5.1 渠道层需要改动的地方

#### 改动 1：Mention 过滤下移（D7.3）

**现状**：Channel Adapter 在入队前过滤未 @ 的消息  
**改动**：不过滤，只标记 `message.isMentioned = true/false`，全部入队

**影响**：`src/channels/aun.ts:1456` 行的过滤逻辑移除

```typescript
// 现状（会过滤）
if (enforceMention && !mentionedSelf && !mentionedAll) {
  this.acknowledgeImmediately(messageId, seq);
  logger.info(`Group dropped: unmentioned`);
  return;  // ← 不入队
}

// 插件化后（不过滤）
message.isMentioned = mentionedSelf || mentionedAll;  // ← 只标记
// 继续入队，由响应模式的 handleInbound() 决定是否 drop
```

### 5.2 渠道层不变的地方

**ChannelAdapter 接口不变**：
- `send(envelope, payload)` 方法签名不变
- `capabilities` 字段不变
- 底层 SDK 调用逻辑不变

**新增渠道时**：
- 实现 ChannelAdapter 接口
- 声明 capabilities
- 实现 send() 方法的 kind 分发逻辑
- **不需要关心响应模式的逻辑**

---

## 六、总结

### 6.1 当前架构的核心特点

1. **统一出站接口**：所有渠道通过 `adapter.send(envelope, payload)` 处理
2. **能力声明**：通过 `capabilities` 字段让调用方感知渠道能力
3. **IMRenderer 承担部分响应逻辑**：判断 chatMode、判断是否发送 thought

### 6.2 插件化后的改进

1. **职责更清晰**：响应逻辑完全由响应模式接管，IMRenderer 退化为纯缓冲器
2. **接口更明确**：ResponseModeContext 提供 `channel.capabilities` 查询接口
3. **扩展性更强**：新增响应模式时，通过 `context.channel` 查询能力即可，无需修改渠道层

### 6.3 对渠道开发者的影响

**插件化前**：
- 实现 ChannelAdapter 接口
- 需要理解 chatMode 的含义（因为 envelope 携带）

**插件化后**：
- 实现 ChannelAdapter 接口（不变）
- **不需要理解响应模式**，只需正确声明 capabilities
- 响应模式会根据 capabilities 做决策，渠道层只负责执行

---

最后更新：2026-06-23
