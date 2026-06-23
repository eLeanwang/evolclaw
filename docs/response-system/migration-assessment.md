# 现有响应机制迁移评估

## 一、现有响应机制梳理

### 1.1 入站流程

**Channel Adapter（以 aun.ts 为例）**：

```
群聊消息到达
  ↓
判断 dispatch mode（mention/broadcast）
  ├─ mention：必须 @ 自己或 @all
  └─ broadcast：不判断，全部接收
  ↓
剥离 @ 标记
  ├─ 命令消息：剥离所有 @
  └─ 普通消息：仅唯一 @ 是自己时剥离
  ↓
构造 Message 对象
  - mentionAids: string[]（被 @ 的 AID 列表）
  - dispatchMode: 'mention' | 'broadcast'
  ↓
调用 MessageBridge.onMessage()
  ↓
入队到 MessageQueue
```

**私聊**：
- 无 dispatch 判断，直接入队

### 1.2 处理流程

**MessageProcessor.processMessage()**：

```
从队列取出消息
  ↓
解析 chatMode（从 session.chatMode 或 agent.config.chatmode）
  ├─ interactive：直接输出即回复
  └─ proactive：需调用工具才发送，普通文本作为 thought
  ↓
构造 ProactiveRuntimeState（如果 proactive）
  - suspendUntilCall: boolean（首条消息是否挂起到工具调用）
  - preTool1stMsgChk: boolean（首条工具前检查）
  - toolUseReminder: boolean（工具使用提醒）
  - suppressOutput: boolean（抑制输出）
  ↓
创建 IMRenderer
  - 模式感知：interactive 直接输出，proactive 判断是否 thought
  ↓
调用 agent.runQuery()
  ↓
流式输出处理
  ↓
后处理（文件标记、用量统计等）
```

### 1.3 出站流程

**IMRenderer**：

```
agent 产生输出（文本/工具调用）
  ↓
判断 chatMode
  ├─ interactive：
  │   └─ 直接通过 channel.send() 发送
  │
  └─ proactive：
      ├─ 工具调用：发送
      ├─ 普通文本 + thought 协议支持：作为 thought 发送
      └─ 普通文本 + 无 thought 协议：投影为空（不发送）
```

---

## 二、迁移到插件化的映射

### 2.1 Interactive 模式迁移

**现有机制**：
- 入站：所有消息入队
- 处理：立即处理
- 出站：直接发送

**插件化后**：
```typescript
class InteractiveMode implements ResponseMode {
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 所有消息都处理
    return {
      action: 'process',
      queueBehavior: 'enqueue'
    };
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    // 直接发送
    return {
      method: 'direct'
    };
  }
}
```

**映射检查**：✅ 完全对齐

---

### 2.2 Proactive 模式迁移

**现有机制**：
- 入站：所有消息入队
- 处理：立即处理，但构造 ProactiveRuntimeState
- 出站：
  - 工具调用 → 发送
  - 普通文本 + thought 协议 → 作为 thought 发送
  - 普通文本 + 无 thought 协议 → 不发送

**插件化后**：
```typescript
class ProactiveMode implements ResponseMode {
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 所有消息都处理
    return {
      action: 'process',
      queueBehavior: 'enqueue',
      // ⚠️ 问题：如何传递 ProactiveRuntimeState？
    };
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    // ⚠️ 问题：如何判断是否工具调用？payload 结构是什么？
    return {
      method: 'tool-required'  // 只有工具调用才发送
    };
  }
}
```

**映射检查**：⚠️ **发现问题**

---

### 2.3 Selective-Response 模式迁移（mention）

**现有机制**：
- 入站：Channel Adapter 判断 mentionAids，未 @ 自己则 **在 Channel 层过滤，不入队**
- 处理：（已过滤，不执行）
- 出站：N/A

**插件化后**：
```typescript
class SelectiveResponseMode implements ResponseMode {
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // ⚠️ 问题：message.mentionAids 已经是过滤后的，怎么判断？
    const mentioned = message.mentionAids?.includes(context.session.selfAID);
    if (!mentioned) {
      return { action: 'drop', reason: 'not-mentioned' };
    }
    return { action: 'process', queueBehavior: 'enqueue' };
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    return { method: 'direct' };
  }
}
```

**映射检查**：⚠️ **发现问题**

---

## 三、发现的问题

### 问题 1：ProactiveRuntimeState 如何传递？ ⚠️

**现状**：
```typescript
const proactive: ProactiveRuntimeState | null = isProactive ? {
  suspendUntilCall: proactiveBehavior.suspend_until_call,
  preTool1stMsgChk: proactiveBehavior.pre_tool_1stmsgchk,
  toolUseReminder: proactiveBehavior.tool_use_reminder,
  suppressOutput: false,
} : null;
```

这个状态在 `processMessage()` 中创建，贯穿整个处理流程，传递给 IMRenderer。

**插件化问题**：
- `handleInbound` 无法返回"运行时状态"
- `InboundDecision` 没有地方携带 ProactiveRuntimeState

**影响**：
- proactive 模式的细粒度控制（suspend_until_call、pre_tool_1stmsgchk 等）无法实现

**可能方案**：
- **方案 A**：`InboundDecision` 加 `runtimeState?: any`（通用扩展字段）
- **方案 B**：响应模式通过 Context 存储状态（per-session state）
- **方案 C**：IMRenderer 创建时由响应模式提供配置

---

### 问题 2：OutboundPayload 结构不明确 ⚠️

**现状**：`handleOutbound` 的参数是 `OutboundPayload`，但文档没定义其结构。

**需要判断的内容**（proactive 模式）：
- 是否是工具调用？
- 是否是普通文本？
- Channel 是否支持 thought 协议？

**architecture.md 中的定义**：
```typescript
interface OutboundPayload {
  kind: 'text' | 'tool' | 'image' | 'file';
  content: string | Buffer;
  metadata?: Record<string, any>;
}
```

**问题**：
- 如何区分"工具调用"和"普通文本"？
- Channel 能力（是否支持 thought）如何获取？

**可能方案**：
- **方案 A**：`OutboundPayload` 加 `isToolCall: boolean`
- **方案 B**：`kind` 扩展为 `'text' | 'tool-call' | 'tool-result' | 'thought'`
- **方案 C**：`ResponseModeContext` 提供 `channel.capabilities.supportsThought`

---

### 问题 3：Mention 过滤时机错误 ⚠️

**现状**：Channel Adapter（aun.ts 1456 行）在入队前过滤：
```typescript
if (enforceMention && !mentionedSelf && !mentionedAll) {
  this.acknowledgeImmediately(messageId, seq);
  logger.info(`Group dropped: unmentioned`);
  return;  // ← 不调用 onMessage，不入队
}
```

**插件化问题**：
- 响应模式的 `handleInbound` 在入队后调用
- 但 mention 过滤在入队前就做了，响应模式拿不到未 @ 的消息

**影响**：
- selective-response 模式的 `handleInbound` **永远拿不到未 @ 的消息**
- 无法做"判断是否 @"的逻辑（因为已经被 Channel 过滤了）

**可能方案**：
- **方案 A**：取消 Channel 层的 mention 过滤，全部入队，交给响应模式判断
- **方案 B**：保持 Channel 层过滤，响应模式只处理已过滤的消息（selective-response 退化为配置标记）
- **方案 C**：Channel 层只做"标记"（`message.isMentioned = true/false`），不过滤，响应模式决定 drop

---

### 问题 4：IMRenderer 与响应模式的职责重叠 ⚠️

**现状**：IMRenderer 已经有 chatMode 感知：
```typescript
// message-processor.ts 908 行
// proactive 模式：activity.batch 是 thought 协议内容，只发给支持 thought 的 channel
```

**插件化问题**：
- IMRenderer 负责"输出投影"（thought vs 实际消息）
- 响应模式的 `handleOutbound` 也负责"发送决策"（direct vs tool-required）
- 两者职责重叠

**可能方案**：
- **方案 A**：IMRenderer 退化为纯"输出缓冲器"，不做 chatMode 判断，由响应模式的 `handleOutbound` 完全接管
- **方案 B**：保持 IMRenderer 的 chatMode 感知，`handleOutbound` 只决策"要不要发"，不管"怎么发"
- **方案 C**：IMRenderer 由响应模式创建（`mode.createRenderer()`），不同模式提供不同的 Renderer 实现

---

## 四、迁移风险评估

| 风险 | 严重性 | 影响 | 推荐方案 |
|------|--------|------|----------|
| ProactiveRuntimeState 传递缺失 | 🔴 高 | proactive 模式细粒度控制失效 | 方案 B（Context 存储状态） |
| OutboundPayload 结构不明确 | 🔴 高 | 无法判断工具调用，proactive 模式实现受阻 | 方案 B（扩展 kind） |
| Mention 过滤时机错误 | 🟡 中 | selective-response 模式实现受限 | 方案 C（Channel 标记不过滤） |
| IMRenderer 职责重叠 | 🟡 中 | 架构不清晰，维护成本高 | 方案 A（IMRenderer 退化） |

---

## 五、推荐方案总结

### 5.1 接口调整

**InboundDecision 增强**：
```typescript
interface InboundDecision {
  action: 'process' | 'drop' | 'defer';
  queueBehavior?: 'enqueue' | 'priority' | 'clear-and-enqueue' | 'interrupt';
  reason?: string;
  // ✅ 新增：运行时状态（传递给处理流程）
  runtimeState?: Record<string, any>;
}
```

**OutboundPayload 明确化**：
```typescript
interface OutboundPayload {
  kind: 'text' | 'tool-call' | 'tool-result' | 'thought' | 'image' | 'file';  // ✅ 扩展
  content: string | Buffer;
  metadata?: Record<string, any>;
  // ✅ 新增：是否是工具调用（便捷判断）
  isToolCall?: boolean;
}
```

**ResponseModeContext 增强**：
```typescript
interface ResponseModeContext {
  // ...现有字段
  
  // ✅ 新增：Channel 能力查询
  channel: {
    type: string;
    capabilities: {
      supportsThought: boolean;
      supportsInteraction: boolean;
      // ...
    };
    send: (content: string, type?: 'message' | 'thought') => Promise<void>;
  };
  
  // ✅ 新增：会话级状态存储（响应模式可存储 per-session 状态）
  sessionState: Map<string, any>;
}
```

### 5.2 架构调整

**1. Mention 过滤下移到响应层**：
- Channel Adapter 不再过滤，全部入队
- Message 携带 `mentionAids: string[]` 和 `isMentioned: boolean`
- 响应模式的 `handleInbound` 决定是否 drop

**2. IMRenderer 退化为纯缓冲器**：
- 移除 chatMode 感知逻辑
- 只负责"收集输出格式化、缓冲"
- 由响应模式的 `handleOutbound` 决定"发什么、怎么发"

**3. ProactiveRuntimeState 通过 Context 传递**：
- `handleInbound` 返回 `runtimeState`
- MessageProcessor 将其存入 `context.sessionState`
- IMRenderer 从 `context.sessionState` 读取（或由响应模式提供 Renderer 配置）

---

## 六、结论

### 能否顺利迁移？

⚠️ **不能直接迁移，需要调整接口和架构**

### 必须调整的内容

| 项 | 优先级 | 工作量 |
|----|--------|--------|
| OutboundPayload 结构明确化 | 🔴 P0 | 小（接口定义） |
| InboundDecision 增加 runtimeState | 🔴 P0 | 小（接口定义） |
| ResponseModeContext 增强 | 🔴 P0 | 中（实现 sessionState 和 channel.capabilities） |
| Mention 过滤下移 | 🟡 P1 | 中（改 Channel Adapter） |
| IMRenderer 退化 | 🟡 P1 | 大（重构 IMRenderer） |

### 建议

1. **Phase 1 先更新接口定义**（包含上述调整）
2. **Phase 2 验证 interactive/proactive 能否完整迁移**（proof of concept）
3. **Phase 3 再推进完整实现**

---

## 附录：需要 Owner 确认的设计选择

| 选择 | 方案 A | 方案 B | 方案 C | 推荐 |
|------|--------|--------|--------|------|
| ProactiveRuntimeState 传递 | InboundDecision.runtimeState | Context.sessionState | 响应模式提供 Renderer 配置 | B |
| OutboundPayload 工具判断 | 加 isToolCall 字段 | 扩展 kind 枚举 | Context 提供判断方法 | B |
| Mention 过滤时机 | 取消 Channel 过滤 | 保持 Channel 过滤 | Channel 标记不过滤 | C |
| IMRenderer 职责 | 退化为纯缓冲器 | 保持 chatMode 感知 | 响应模式创建 Renderer | A |
