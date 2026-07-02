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
  
  // 如果 state = DELAY
  transferAt?: Date;               // 计划投递时间
  
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
  delayMs?: number;                // 基础延迟时间（默认3000，代码层会加0-60秒随机）
  
  // 如果 action = 'transfer'
  interrupt?: boolean;             // 是否打断主会话（默认false）
  
  // 简短说明（<50字）
  reason: string;
}

interface FeedbackAck {
  reason: '已知悉' | '已更新上下文';
}
```

---

### 1.5 MainFeedback（主会话反馈）

```typescript
interface MainFeedback {
  batchId: string;                 // 批次唯一 ID
  processedAt: string;             // 处理时间（ISO 8601）
  processedMessageIds: string[];   // 处理了哪些消息
  summary: string;                 // 处理总结（<200字）
  replies: string[];               // 回复内容列表
  
  // 可选字段
  failedReplies?: {                // 发送失败的回复
    reply: string;
    error: string;
  }[];
}
```

---

## 二、配置数据结构

### 2.1 DualSessionConfig（双会话配置）

```typescript
interface DualSessionConfig {
  // 模型配置
  auxiliaryModel: string;          // 辅助会话模型（默认：deepseek-v4-flash）
  mainModel: string;               // 主会话模型（默认：claude-opus）
  
  // 队列配置
  debounceMs: number;              // 防抖时间（默认：3000）
  maxWaitMs: number;               // 最早消息最长等待（默认：15000）
  maxQueueSize: number;            // 队列最大容量（默认：50）
  maxBatchSize: number;            // 每批最多消息数（默认：50）
  maxBatchBytes: number;           // 每批最多字节数（默认：10240）
  
  // 延迟配置
  baseDelayMs: number;             // 基础延迟时间（默认：3000）
  randomDelayMaxMs: number;        // 随机延迟最大值（默认：60000）
  
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

### 3.1 FeedbackStore（jsonl 文件）

每行一个 JSON 对象（`MainFeedback`）：

```jsonl
{"batchId":"batch-001","processedAt":"2026-07-01T10:30:00Z","processedMessageIds":["msg-001","msg-002"],"summary":"处理了Owner关于报错的问题","replies":["这个报错是因为..."]}
{"batchId":"batch-002","processedAt":"2026-07-01T10:35:00Z","processedMessageIds":["msg-003"],"summary":"回复了技术讨论","replies":["关于这个技术选型..."]}
```

**存储位置**：
```
$AGENT_DIR/relations/<channel>#<urlEncode(peerId)>/main-feedback.jsonl
```

---

### 3.2 QueueState（队列状态，可选持久化）

如果需要持久化队列状态（重启后恢复）：

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
}

interface MainSessionAPI extends SessionAPI {
  process(batch: Message[]): Promise<void>;
  interrupt(): Promise<void>;
  getCurrentBatchSize(): number;
}
```

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
