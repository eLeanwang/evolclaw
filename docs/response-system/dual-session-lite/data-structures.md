# 双会话响应模式 - 数据结构定义

## 文档说明

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**关联**: [README.md](./README.md) | [架构设计](./architecture.md)

---

## 一、核心数据结构

### 1.1 Message（消息）

```typescript
interface Message {
  id: string;                      // 消息唯一 ID
  channel: string;                 // 渠道（aun/feishu/wechat等）
  peerId: string;                  // 发送者 ID
  peerName: string;                // 发送者名称
  content: string;                 // 消息内容
  timestamp: number;               // 时间戳（毫秒）
  
  // 可选字段
  isMentioned?: boolean;           // 是否 @本agent
  attachments?: Attachment[];      // 附件
  referencedMessages?: string[];   // 引用的消息 ID
  metadata?: Record<string, any>;  // 元数据
}

interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
  size?: number;
  mimeType?: string;
}
```

---

### 1.2 QueuedMessage（队列中的消息）

```typescript
interface QueuedMessage {
  message: Message;                // 原始消息
  state: MessageState;             // 消息状态
  enqueuedAt: Date;                // 入队时间
  processedByAuxiliary: boolean;   // 是否已被辅助会话处理
  
  // 如果 state = DELAY
  transferAt?: Date;               // 计划投递时间
  
  // 如果 state = HOLD
  holdSince?: number;              // 首次 HOLD 的时间（毫秒时间戳）
  
  // 错误处理
  hasError?: boolean;              // 是否处理失败
  lastErrorTime?: number;          // 上次失败时间（毫秒时间戳）
  errorCount?: number;             // 失败次数
  
  // 元数据
  processedCount?: number;         // 被辅助会话处理的次数
  lastProcessedAt?: Date;          // 最后一次处理时间
}

enum MessageState {
  PENDING = 'pending',             // 刚到达，未处理
  HOLD = 'hold',                   // 挂起（与agent无关）
  DELAY = 'delay',                 // 延迟投递
  TRANSFERRED = 'transferred',     // 已投递到主队列
}
```

**HOLD 超时机制**：
- HOLD 状态的消息，如果 `holdSince` 超过 1 小时 → 自动投递到主队列
- 检查时机：每次辅助会话处理时检查

---

### 1.3 AuxiliaryInput（辅助会话输入）

```typescript
interface AuxiliaryInput {
  // 输入类型
  type: 'aun-messages' | 'main-feedback';
  
  // 如果 type = 'aun-messages'
  aunMessages?: {
    queue: Message[];              // 辅助队列中所有未投递的消息
    newMessages: Message[];        // 本次新增的消息（触发本次判断）
  };
  
  // 如果 type = 'main-feedback'
  mainFeedback?: MainFeedback;
  
  // 主会话当前状态
  mainSession: MainSessionStatus;
}

interface MainSessionStatus {
  status: 'idle' | 'processing';
  currentBatchSize?: number;       // 当前批次大小（如果正在处理）
  queueSize: number;               // 主队列剩余消息数
}
```

---

### 1.4 AuxiliaryOutput（辅助会话输出）

```typescript
interface AuxiliaryOutput {
  // 输出类型
  type: 'aun-decision' | 'feedback-ack';
  
  // 如果 type = 'aun-decision'
  decision?: AuxiliaryDecision;
  
  // 如果 type = 'feedback-ack'
  ack?: FeedbackAck;
}

interface AuxiliaryDecision {
  // 决策类型（三选一）
  action: 'hold' | 'delay' | 'transfer';
  
  // 如果 action = 'delay'
  delayMs?: number;                // 基础延迟时间（已废弃，使用 delayLevel 代替）
  delayLevel?: 'short' | 'medium' | 'long';  // 延迟等级：short=1分钟, medium=2分钟(默认), long=3分钟，群聊会加随机数，单聊不加
  
  // 如果 action = 'transfer'
  interrupt?: boolean;             // 是否打断主会话（默认false）
  interruptReason?: string;        // 打断原因（interrupt=true 时必填）
  previousMessageStrategy?: 'ignore' | 'defer' | 'continue';  // 被打断消息处理策略（interrupt=true 时必填）
  
  // 简短说明（<50字）
  reason: string;
}

/**
 * delayLevel 延迟等级说明：
 * - short (1分钟)：高相关性、紧急问题
 * - medium (2分钟，默认)：中等相关性
 * - long (3分钟)：低相关性、不紧急
 * 
 * 群聊会在基础时间上加随机数（减少多 agent 碰撞），单聊不加随机数
 */

/**
 * previousMessageStrategy 三种策略：
 * - ignore：忽略被打断的消息，只处理新消息
 * - defer：先处理新消息，完成后再处理被打断的消息
 * - continue：继续处理被打断的消息，但考虑新消息的内容
 */

interface FeedbackAck {
  reason: '已知悉' | '已更新上下文';
}
```

**辅助会话输出格式**：

辅助会话的输出包含两部分（以自然语言形式）：

1. **思考过程**（<200字）
2. **JSON 判断结果**

**示例**：
```
【思考过程】
Owner 提了一个关于报错的紧急问题，主会话正忙着处理闲聊消息，需要打断。新问题优先，但闲聊消息不重要可以忽略。

【判断结果】
{
  "action": "transfer",
  "interrupt": true,
  "interruptReason": "Owner 提出紧急问题",
  "previousMessageStrategy": "ignore",
  "reason": "紧急问题优先处理，闲聊可忽略"
}
```

**Schema 插入方式**：
- Schema 作为辅助会话系统提示词的一部分（`.md` 文件）
- 通过 ECK 的模板渲染机制注入
- 兼容所有 base agent（Claude Code、Codex、Gemini CLI 等）

**输出验证**：
- 代码层提取 JSON 部分
- 验证 schema 是否符合 `AuxiliaryDecision`
- 验证失败时，提示辅助会话重新输出

---

### 1.5 MainFeedback（主会话反馈）

```typescript
interface MainFeedback {
  summary: string;                 // 主会话输出的自然语言总结（<200字）
  replies: string[];               // 从工具调用历史提取的回复内容
}
```

**说明**：
- `summary`: 主会话在 turn 结束时输出的自然语言总结，代码层从输出中提取
- `replies`: 代码层从主会话的工具调用历史中提取所有 `ec group send` / `ec msg send` 的消息正文
- MainFeedback 由代码层组装后直接传递给辅助会话（不写文件）

---

## 二、配置数据结构

### 2.1 DualSessionConfig（双会话配置）

```typescript
interface DualSessionConfig {
  // 模型配置
  auxiliaryModel: string;          // 辅助会话模型（默认：deepseek-v4-flash）
  mainModel: string;               // 主会话模型（默认：claude-opus）
  
  // mention 机制配置
  mentionMode: 'disabled' | 'fast-track';  // 默认：disabled
  // - disabled: 所有消息进入辅助队列，由辅助会话判断
  // - fast-track: 被 @ 的消息直接投递到主队列并打断
  
  // 队列配置
  debounceMs: number;              // 防抖时间（默认：3000，可配置 0-6000）
  maxWaitMs: number;               // 最早消息最长等待（默认：15000）
  maxQueueSize: number;            // 队列最大容量（群聊：50，单聊：15）
  maxBatchSize: number;            // 每批最多消息数（默认：50）
  maxBatchBytes: number;           // 每批最多字节数（默认：10240）
  
  // 延迟配置
  baseDelayMs: number;             // 基础延迟时间（默认：3000）
  randomDelayMaxMs: number;        // 随机延迟最大值（群聊：60000，单聊：0）
  
  // 压缩配置
  auxiliaryMaxTokens: number;      // 辅助会话触发压缩阈值（默认：40000）
  auxiliaryMaxMessages: number;    // 辅助会话触发压缩阈值（默认：100）
  mainMaxTokens: number;           // 主会话触发压缩阈值（默认：160000）
  mainMaxMessages: number;         // 主会话触发压缩阈值（默认：200）
  compressionTarget: number;       // 压缩摘要目标字数（默认：2000）
  
  // 调试配置
  enableDebug: boolean;            // 是否启用调试输出（默认：false）
}
```

**单聊与群聊配置差异**：
- `maxQueueSize`: 群聊 50 条，单聊 15 条
- `randomDelayMaxMs`: 群聊 60000（60秒），单聊 0（不加随机数）
- 单聊场景下会启用主会话空闲监听机制

---

### 2.2 AgentConfig（Agent 配置）

```typescript
interface AgentConfig {
  // 响应模式
  responseMode: 'dual-session-lite' | null;
  
  // 双会话配置
  dualSessionConfig?: DualSessionConfig;
  
  // 其他现有配置
  aid: string;
  name: string;
  model: string;
  // ...
}
```

---

## 三、存储数据结构

### 3.1 QueueState（队列状态持久化）

持久化队列状态（支持重启后恢复）：

```typescript
interface QueueState {
  auxiliaryQueue: {
    messages: QueuedMessage[];
    debounceTimer?: {
      startAt: string;             // ISO 8601
      durationMs: number;
    };
    delayTimers: {
      messageId: string;
      transferAt: string;          // ISO 8601
    }[];
  };
  
  mainQueue: {
    messages: Message[];
    processing: Message[];
  };
  
  lastUpdateAt: string;            // ISO 8601
}
```

**存储位置**：
```
$AGENT_DIR/relations/<channel>#<urlEncode(peerId)>/queue-state.json
```

---

## 四、内部数据结构

### 4.1 TriggerReason（触发原因）

```typescript
type TriggerReason = 
  | 'debounce'           // 防抖超时
  | 'max-wait'           // 最早消息超时
  | 'queue-full'         // 队列满
  | 'delay-timeout'      // 延迟投递超时
  | 'main-feedback'      // 主会话反馈到达
  | 'retry';             // 重试（失败后）
```

---

### 4.2 SessionStatus（会话状态）

```typescript
interface SessionStatus {
  conversationId: string;          // 当前会话 ID
  status: 'idle' | 'processing';
  
  // 统计信息
  stats: {
    totalMessages: number;         // 总消息数
    totalTokens: number;           // 总 token 数
    totalCalls: number;            // 总调用次数
    lastCallAt?: Date;             // 最后一次调用时间
  };
  
  // 压缩信息
  compression: {
    lastCompressedAt?: Date;       // 最后一次压缩时间
    compressionCount: number;      // 压缩次数
  };
}
```

---

### 4.3 BatchInfo（批次信息）

```typescript
interface BatchInfo {
  batchId: string;
  messages: Message[];
  extractedAt: Date;
  
  // 辅助会话批次
  triggerReason?: TriggerReason;
  
  // 主会话批次
  isInterrupted?: boolean;         // 是否是打断后的批次
  previousMessage?: Message;       // 被打断的消息（已在上下文）
}
```

---

## 五、API 数据结构

### 5.1 AuxiliaryQueue API

```typescript
interface AuxiliaryQueueAPI {
  // 入队
  enqueue(message: Message): void;
  
  // 查询
  getAllUndelivered(): QueuedMessage[];
  getByState(state: MessageState): QueuedMessage[];
  getOldestPending(): QueuedMessage | null;
  size(): number;
  
  // 更新
  updateState(messageId: string, state: MessageState, transferAt?: Date): void;
  
  // 移除
  remove(messageIds: string[]): void;
  
  // 批次提取
  extractBatch(maxSize: number, maxBytes: number): Message[];
}
```

---

### 5.2 MainQueue API

```typescript
interface MainQueueAPI {
  // 入队
  append(messages: Message[]): Promise<void>;
  interrupt(messages: Message[]): Promise<void>;
  
  // 查询
  size(): number;
  isEmpty(): boolean;
  peek(): Message[];
  
  // 批次操作
  extractBatch(maxSize: number): Message[];
  completeBatch(): void;
  
  // 状态
  isProcessing(): boolean;
  getCurrentBatch(): Message[];
}
```

---

### 5.3 Session API

```typescript
interface SessionAPI {
  // 处理
  process(input: any): Promise<any>;
  
  // 状态
  getStatus(): SessionStatus;
  isIdle(): boolean;
  isProcessing(): boolean;
  
  // 打断（仅主会话）
  interrupt?(): Promise<void>;
  
  // 压缩
  shouldCompress(): boolean;
  compressAndNew(): Promise<void>;
  
  // 系统提示词
  loadSystemPrompt(): Promise<string>;
}

interface AuxiliarySessionAPI extends SessionAPI {
  process(batch: Message[], reason: TriggerReason): Promise<void>;
  processFeedback(feedback: MainFeedback): Promise<void>;
  
  // 错误状态
  errorState: AuxiliaryErrorState;
}

interface AuxiliaryErrorState {
  isInError: boolean;           // 是否处于错误状态
  consecutiveFailures: number;  // 连续失败次数
  lastSuccessTime?: number;     // 上次成功时间（毫秒时间戳）
}

interface MainSessionAPI extends SessionAPI {
  process(batch: Message[]): Promise<void>;
  interrupt(): Promise<void>;
  getCurrentBatchSize(): number;
}
```

**辅助会话错误状态说明**：
- `isInError = true`：辅助会话处于错误状态，后续调用失败时不重试，直接降级
- `consecutiveFailures`：记录连续失败次数
- `lastSuccessTime`：记录上次成功时间，用于判断是否恢复

**降级策略**：
- 第一次失败：重试 3 次（5秒、10秒、30秒退避）
- 重试失败：延迟 2 分钟投递，标记 `isInError = true`
- 后续失败：延迟 2 分钟投递（不重试）
- 调用成功：清除错误状态

---

## 六、事件数据结构

### 6.1 事件类型

```typescript
type DualSessionEvent = 
  | MessageEnqueuedEvent
  | AuxiliaryTriggeredEvent
  | AuxiliaryDecisionEvent
  | MainQueueAppendEvent
  | MainQueueInterruptEvent
  | MainSessionProcessingEvent
  | MainSessionCompletedEvent
  | FeedbackGeneratedEvent
  | FeedbackAckedEvent;

interface BaseEvent {
  type: string;
  timestamp: Date;
  agentAid: string;
  peerKey: string;
}

interface MessageEnqueuedEvent extends BaseEvent {
  type: 'message-enqueued';
  messageId: string;
}

interface AuxiliaryTriggeredEvent extends BaseEvent {
  type: 'auxiliary-triggered';
  reason: TriggerReason;
  batchSize: number;
}

interface AuxiliaryDecisionEvent extends BaseEvent {
  type: 'auxiliary-decision';
  decision: AuxiliaryDecision;
  processedMessageIds: string[];
}

interface MainQueueAppendEvent extends BaseEvent {
  type: 'main-queue-append';
  messageIds: string[];
}

interface MainQueueInterruptEvent extends BaseEvent {
  type: 'main-queue-interrupt';
  messageIds: string[];
  currentBatchSize: number;
}

interface MainSessionProcessingEvent extends BaseEvent {
  type: 'main-session-processing';
  batchId: string;
  batchSize: number;
}

interface MainSessionCompletedEvent extends BaseEvent {
  type: 'main-session-completed';
  batchId: string;
  repliesCount: number;
}

interface FeedbackGeneratedEvent extends BaseEvent {
  type: 'feedback-generated';
  feedback: MainFeedback;
}

interface FeedbackAckedEvent extends BaseEvent {
  type: 'feedback-acked';
  batchId: string;
}
```

---

## 七、日志数据结构

### 7.1 日志格式

```typescript
interface LogEntry {
  timestamp: string;               // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;               // AuxiliaryQueue / AuxiliarySession / MainQueue / MainSession
  action: string;                  // enqueue / trigger / decision / append / interrupt / processing / completed
  
  // 上下文
  agentAid?: string;
  peerKey?: string;
  
  // 详细信息
  details: Record<string, any>;
  
  // 错误信息（如果 level = error）
  error?: {
    message: string;
    stack?: string;
  };
}
```

**示例**：
```json
{
  "timestamp": "2026-07-01T10:30:00.123Z",
  "level": "info",
  "component": "AuxiliaryQueue",
  "action": "enqueue",
  "agentAid": "agent.aid.pub",
  "peerKey": "aun#owner.aid.pub",
  "details": {
    "messageId": "msg-001",
    "queueSize": 3
  }
}
```

---

## 八、监控指标数据结构

### 8.1 指标定义

```typescript
interface DualSessionMetrics {
  // 辅助队列指标
  auxiliaryQueue: {
    currentSize: number;
    totalEnqueued: number;
    totalProcessed: number;
    avgWaitTimeMs: number;
    maxWaitTimeMs: number;
  };
  
  // 辅助会话指标
  auxiliarySession: {
    totalCalls: number;
    avgLatencyMs: number;
    maxLatencyMs: number;
    decisions: {
      hold: number;
      delay: number;
      transfer: number;
    };
  };
  
  // 主队列指标
  mainQueue: {
    currentSize: number;
    totalAppended: number;
    totalInterrupts: number;
    interruptSuccessRate: number;  // 成功打断的比例
  };
  
  // 主会话指标
  mainSession: {
    totalBatches: number;
    avgBatchSize: number;
    avgProcessingTimeMs: number;
    totalReplies: number;
  };
  
  // 反馈指标
  feedback: {
    totalGenerated: number;
    totalAcked: number;
    avgAckLatencyMs: number;
  };
  
  // 时间窗口
  timeWindow: {
    startAt: string;               // ISO 8601
    endAt: string;                 // ISO 8601
  };
}
```

---

## 九、错误数据结构

### 9.1 错误类型

```typescript
class DualSessionError extends Error {
  code: string;
  component: string;
  details?: Record<string, any>;
}

// 具体错误类型
class AuxiliaryQueueFullError extends DualSessionError {
  code = 'AUXILIARY_QUEUE_FULL';
  component = 'AuxiliaryQueue';
}

class AuxiliaryCallError extends DualSessionError {
  code = 'AUXILIARY_CALL_FAILED';
  component = 'AuxiliarySession';
}

class MainQueueError extends DualSessionError {
  code = 'MAIN_QUEUE_ERROR';
  component = 'MainQueue';
}

class MainSessionCallError extends DualSessionError {
  code = 'MAIN_SESSION_CALL_FAILED';
  component = 'MainSession';
}

class SendReplyError extends DualSessionError {
  code = 'SEND_REPLY_FAILED';
  component = 'MainSession';
}

class FeedbackStoreError extends DualSessionError {
  code = 'FEEDBACK_STORE_ERROR';
  component = 'FeedbackStore';
}
```

---

## 十、版本兼容性

### 10.1 数据结构版本

```typescript
interface DataStructureVersion {
  version: string;                 // 语义化版本（如 "1.0.0"）
  schemaUrl?: string;              // JSON Schema URL（可选）
}

// 在序列化数据中包含版本信息
interface VersionedData<T> {
  _version: DataStructureVersion;
  data: T;
}
```

**示例**：
```json
{
  "_version": {
    "version": "1.0.0"
  },
  "data": {
    "batchId": "batch-001",
    "processedAt": "2026-07-01T10:30:00Z",
    "processedMessageIds": ["msg-001"],
    "summary": "...",
    "replies": ["..."]
  }
}
```

---

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**维护者**: EvolClaw 团队
