# 双会话响应模式 - 架构设计

**版本**: 2.0  
**创建时间**: 2026-07-08  
**状态**: 设计定稿

**相关文档**：
- [数据结构定义](./data-structures.md) - 完整的 TypeScript 接口定义
- [配置参数](./config/common-params.md) - 通用参数说明
- [ECK 集成](./eck-integration.md) - 上下文组装机制
- [主会话打断机制](./interrupt-mechanism.md) - 打断的唯一事实源（本文档 §3.3 及 `interrupt()` 伪代码以其为准）

---

## 一、整体架构

### 1.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    AUN 消息到达                              │
└────────────────────────┬────────────────────────────────────┘
                         ↓
        ┌────────────────────────────────┐
        │   辅助队列 (AuxiliaryQueue)    │
        │   - 防抖3秒                     │
        │   - 最早消息15秒强制触发        │
        │   - 队列满强制触发              │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   辅助会话 (AuxiliarySession)  │
        │   便宜模型 (DeepSeek/Haiku)    │
        │                                │
        │   职责:                        │
        │   1. 判断何时投递               │
        │   2. 判断是否打断               │
        │   3. 接收主会话反馈             │
        └────────────┬───────────────────┘
                     ↓
        输出决策：hold / delay / transfer
                     ↓
        ┌────────────────────────────────┐
        │   主队列 (MainQueue)            │
        │   - 追加 or 打断重新提取批次    │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   主会话 (MainSession)         │
        │   主力模型 (Claude Opus)       │
        │                                │
        │   职责:                        │
        │   1. 批量处理消息               │
        │   2. 生成回复                   │
        │   3. 判断消息是否过期           │
        │   4. 输出处理总结               │
        └────────────┬───────────────────┘
                     ↓
        生成回复 + 处理总结
                     ↓
        反馈给辅助会话
```

---

## 二、系统组件

### 2.1 AuxiliaryQueue（辅助队列）

#### 职责

- 接收从 Channel 适配器来的 AUN 消息
- 维护消息状态（PENDING / HOLD / DELAY）
- 管理触发条件（防抖、超时、强制触发）
- 提供消息查询和状态更新接口

#### 数据结构

```typescript
class AuxiliaryQueue {
  private messages: Map<string, QueuedMessage>;
  private debounceTimer: NodeJS.Timeout | null;
  private delayTimers: Map<string, NodeJS.Timeout>;
  
  // 配置
  private readonly config = {
    debounceMs: 3000,           // 防抖时间
    maxWaitMs: 15000,           // 最早消息最长等待
    maxSize: 50,                // 队列最大容量（群聊 50，单聊 15）
    maxBatchSize: 50,           // 每批最多处理消息数
    maxBatchBytes: 10240,       // 每批最多字节数
  };
  
  constructor(private chatType: 'private' | 'group') {
    // 单聊场景下队列容量限制为 15 条
    if (chatType === 'private') {
      this.config.maxSize = 15;
    }
  }
}

interface QueuedMessage {
  message: Message;
  state: MessageState;
  enqueuedAt: Date;
  processedByAuxiliary: boolean;  // 是否已被辅助会话处理
  transferAt?: Date;              // 延迟投递时间
}

enum MessageState {
  PENDING = 'pending',  // 未被辅助会话处理
  HOLD = 'hold',        // 已处理，暂时挂起
  DELAY = 'delay',      // 已处理，延迟投递
}
```

#### 触发机制

**触发条件**（满足任一）：

1. **防抖3秒**：有新消息重置
2. **最早消息超过15秒**：强制触发
3. **队列满**：群聊50条/单聊15条，强制投递到主队列（不打断）
4. **延迟投递超时**：该投递了
5. **主会话反馈到达**：需要更新上下文

#### 核心方法

```typescript
class AuxiliaryQueue {
  // 消息入队
  enqueue(message: Message): void {
    this.messages.set(message.id, {
      message,
      state: MessageState.PENDING,
      enqueuedAt: new Date(),
      processedByAuxiliary: false,
    });
    
    // 重置防抖定时器
    this.resetDebounceTimer();
    
    // 检查队列是否满
    if (this.shouldForceTransfer()) {
      this.forceTransferAll();
    }
  }
  
  // 获取未处理的消息（喂给辅助会话）
  getUnprocessedMessages(): Message[] {
    return Array.from(this.messages.values())
      .filter(qm => !qm.processedByAuxiliary)
      .map(qm => qm.message);
  }
  
  // 获取已经进入辅助会话上下文、可由本次 transfer 决策投递的消息
  getProcessedByAuxiliary(): Message[] {
    return Array.from(this.messages.values())
      .filter(qm => qm.processedByAuxiliary)
      .map(qm => qm.message);
  }
  
  // 更新消息状态
  updateState(messageId: string, state: MessageState, transferAt?: Date): void {
    const qm = this.messages.get(messageId);
    if (qm) {
      qm.state = state;
      qm.processedByAuxiliary = true;
      qm.transferAt = transferAt;
      
      // 如果是延迟投递，设置定时器
      if (state === MessageState.DELAY && transferAt) {
        this.scheduleDelayedTransfer(messageId, transferAt);
      }
    }
  }
  
  // 移除已投递的消息
  remove(messageIds: string[]): void {
    for (const id of messageIds) {
      this.messages.delete(id);
      this.clearDelayTimer(id);
    }
  }
}
```

---

### 2.2 AuxiliarySession（辅助会话）

#### 职责

- 管理辅助会话的生命周期
- 调用辅助会话模型进行判断
- 解析辅助会话输出并执行相应操作
- 处理主会话反馈
- 管理会话上下文和压缩

#### 数据结构

```typescript
class AuxiliarySession {
  private conversationId: string;
  private context: ConversationContext;
  private model: string = 'deepseek-v4-flash';  // 或 claude-haiku
  
  private readonly config = {
    maxTokens: 40000,           // 触发压缩的阈值
    maxMessages: 100,
    compressionTarget: 2000,    // 压缩摘要字数
    recentMessagesCount: 10,    // 压缩后载入的最近消息数
  };
}
```

#### 输入输出

**输入**：

```typescript
interface AuxiliaryInput {
  // 输入类型
  type: 'aun-messages' | 'main-feedback';
  
  // 如果 type = 'aun-messages'
  aunMessages?: {
    newMessages: Message[];        // 本次新增的消息（只给这批；之前 hold/delay 的已在上下文）
    remainingInQueue: number;      // 【信号A】去掉本批次后，辅助队列剩余待判断数（催快）
  };
  
  // 如果 type = 'main-feedback'
  mainFeedback?: {
    processedMessageIds: string[];
    summary: string;
    replies: string[];
  };
  
  // 主会话当前状态
  mainSession: {
    status: 'idle' | 'processing';
    pendingCount: number;          // 【信号B】主队列待处理数（=queueSize，不含正在处理批次）（压慢）
  };
}
```

**输出**：

```typescript
interface AuxiliaryOutput {
  // 输入类型对应的输出
  type: 'aun-decision' | 'feedback-ack';
  
  // 如果 type = 'aun-decision'
  decision?: {
    action: 'hold' | 'delay' | 'transfer';  // 单聊无 hold
    
    // 如果 action = 'delay'
    delayLevel?: 'short' | 'medium' | 'long';  // 延迟等级（默认 medium）
    
    // 如果 action = 'transfer'
    interrupt?: boolean;           // 是否打断（默认false）
    
    // 简短说明（<50字）
    reason: string;
  };
  
  // 如果 type = 'feedback-ack'
  ack?: {
    reason: '已知悉' | '已更新上下文';
  };
}
```

#### 核心方法

```typescript
class AuxiliarySession {
  // 处理消息批次
  async process(batch: Message[], reason: TriggerReason): Promise<void> {
    const input = this.buildInput(batch, reason);
    const output = await this.callModel(input);
    await this.executeDecision(output);
    
    if (this.shouldCompress()) {
      await this.compressAndNew();
    }
  }
  
  // 处理主会话反馈
  async processFeedback(feedback: MainFeedback): Promise<void> {
    const input = this.buildFeedbackInput(feedback);
    const output = await this.callModel(input);
    
    // 更新上下文
    this.context.append(`[主会话反馈] ${feedback.summary}`);
    
    // 从辅助队列移除已处理消息
    auxiliaryQueue.remove(feedback.processedMessageIds);
  }
  
  // 执行决策
  private async executeDecision(output: AuxiliaryOutput): Promise<void> {
    if (output.type === 'aun-decision') {
      const { action, delayLevel, interrupt, reason } = output.decision;
      
      if (action === 'hold') {
        // 更新状态为 HOLD（仅群聊）
        // ...
      } else if (action === 'delay') {
        // 更新状态为 DELAY，按 delayLevel + 对端系数计算延迟（见 §3.2）
        // ...
      } else if (action === 'transfer') {
        // 只投递辅助会话已经见过的消息。
        // 判断期间新入队、尚未喂给辅助会话的 PENDING 消息留到下一轮。
        const messages = auxiliaryQueue.getProcessedByAuxiliary();
        
        if (interrupt) {
          await mainQueue.interrupt(messages);
        } else {
          await mainQueue.append(messages);
        }
        
        // 从辅助队列移除
        auxiliaryQueue.remove(messages.map(m => m.id));
      }
    }
  }
}
```

---

### 2.3 MainQueue（主队列）

#### 职责

- 接收从辅助会话投递的消息
- 维护消息优先级
- 支持打断和重新提取批次
- 提供批次提取接口

#### 数据结构

```typescript
class MainQueue {
  private queue: Message[] = [];
  private processing: Message[] = [];  // 当前正在处理的批次
  
  private readonly config = {
    maxBatchSize: 50,
  };
}
```

#### 核心方法

```typescript
class MainQueue {
  // 追加消息
  append(messages: Message[]): void {
    this.queue.push(...messages);
    
    // 如果主会话空闲，触发处理
    if (mainSession.isIdle()) {
      this.triggerMainSession();
    }
  }
  
  // 打断并插入消息
  async interrupt(messages: Message[]): Promise<void> {
    // 检查是否应该打断
    if (!mainSession.isProcessing() || 
        this.processing.length >= this.config.maxBatchSize) {
      // 主会话空闲，或当前批次已满，不打断
      this.append(messages);
      return;
    }
    
    // 打断主会话
    await mainSession.interrupt();
    
    // 新消息追加到队列末尾
    this.queue.push(...messages);
    
    // 注意：this.processing（当前批次）不会重新入队
    // 因为这些消息已经在主会话上下文中了（见 interrupt-mechanism.md §4）
    
    // 从主队列提取新批次（打断场景特殊提取：≤100 条 / 20k，见 §5）
    this.triggerMainSession({ interrupt: true });
  }
  
  // 提取批次
  extractBatch(): Message[] {
    // 群聊：检查角色一致性
    if (this.chatType === 'group') {
      return this.extractBatchWithRoleConsistency();
    }
    
    // 单聊：直接提取
    const batch = this.queue.splice(0, this.config.maxBatchSize);
    this.processing = batch;
    return batch;
  }
  
  // 提取批次（群聊，角色一致性）
  private extractBatchWithRoleConsistency(): Message[] {
    const batch: Message[] = [];
    let batchRole: string | undefined;
    
    for (let i = 0; i < Math.min(this.queue.length, this.config.maxBatchSize); i++) {
      const message = this.queue[i];
      const messageRole = message.peerRole;
      
      if (i === 0) {
        batchRole = messageRole;
        batch.push(message);
      } else if (batchRole === messageRole) {
        batch.push(message);
      } else {
        break;  // 角色不一致，停止提取
      }
    }
    
    this.queue.splice(0, batch.length);
    this.processing = batch;
    return batch;
  }
  
  // 标记批次处理完成
  completeBatch(): void {
    this.processing = [];
    
    // 如果队列还有消息，继续处理
    if (this.queue.length > 0) {
      this.triggerMainSession();
    }
  }
}
```

---

### 2.4 MainSession（主会话）

#### 职责

- 管理主会话的生命周期
- 批量处理消息
- 生成回复（根据 chatMode 决定方式）
- 输出处理总结并反馈给辅助会话
- 管理会话上下文和压缩

#### 数据结构

```typescript
class MainSession {
  private conversationId: string;
  private context: ConversationContext;
  private model: string = 'claude-opus';
  private chatMode: 'interactive' | 'proactive';  // 交互方式
  private status: 'idle' | 'processing' = 'idle';
  private currentBatch: Message[] = [];
  
  private readonly config = {
    maxTokens: 160000,
    maxMessages: 200,
    recentMessagesCount: 20,
  };
  
  constructor(config: MainSessionConfig) {
    this.chatMode = config.chatMode;
    this.model = config.model || 'claude-opus';
  }
}
```

#### 核心方法

```typescript
class MainSession {
  // 处理批次
  async process(batch: Message[]): Promise<void> {
    this.status = 'processing';
    this.currentBatch = batch;
    
    // 调用主会话模型
    const response = await this.callModel(batch);
    
    // 根据 chatMode 处理回复
    if (this.chatMode === 'interactive') {
      // 输出已经是回复，无需额外处理
    } else if (this.chatMode === 'proactive') {
      // 主会话在 turn 内通过 CLI 发送回复
    }
    
    // 提取处理总结
    const summary = this.extractSummary(response.content);
    const replies = this.extractRepliesFromToolCalls();
    
    // 组装反馈
    const feedback: MainFeedback = {
      processedMessageIds: batch.map(m => m.id),
      summary,
      replies,
    };
    
    // 通知辅助会话
    await auxiliarySession.processFeedback(feedback);
    
    // 标记完成
    mainQueue.completeBatch();
    this.status = 'idle';
    this.currentBatch = [];
    
    // 检查是否需要压缩
    if (this.shouldCompress()) {
      await this.compressAndNew();
    }
  }
  
  // 打断（硬打断，详见 interrupt-mechanism.md §3）
  async interrupt(): Promise<void> {
    // 硬 abort：中止正在进行的 callModel 请求
    // 单设 status='idle' 不足以中断 await callModel，必须真正 abort
    await this.abortController?.abort();  // → SDK sdkStream.interrupt()
    this.status = 'idle';
    // 被 abort 的 process() 续体会抛错中止，不会执行到 completeBatch/feedback
    // 当前批次中的消息已在上下文，保留（不回灌队列，见 interrupt-mechanism.md §4）
  }
  
  // 状态查询
  isIdle(): boolean {
    return this.status === 'idle';
  }
  
  isProcessing(): boolean {
    return this.status === 'processing';
  }
  
  getCurrentBatchSize(): number {
    return this.currentBatch.length;
  }
}
```

---

## 三、核心机制

### 3.1 消息状态管理

```typescript
enum MessageState {
  PENDING = 'pending',   // 刚到达，未处理
  HOLD = 'hold',         // 挂起（群聊特有，单聊无此状态）
  DELAY = 'delay',       // 延迟投递
}
```

**状态流转**：

```
PENDING → (辅助会话判断) → HOLD / DELAY / TRANSFER
   ↑                           ↓          ↓
   └──────(重新判断)───────────┘          └→ 投递到主队列
```

### 3.2 延迟投递机制（单聊与群聊公式相同）

```typescript
// 辅助会话决策（只需给出 delayLevel）
{
  action: 'delay',
  delayLevel: 'medium',  // short/medium/long
  reason: '等待完整意图 / 等其他 agent 回复'
}

// 代码层处理
// 实际延迟 = baseDelayMs + random(0, effectiveLevelMs)
// effectiveLevelMs = baseLevelMs(delayLevel) × 对端系数
const levelMs = baseLevelMs(delayLevel);        // short=60k / medium=120k / long=180k
const peerFactor = isAgentPeer(batch) ? 1.0 : 0.5;  // 含 agent→1.0，全是人→0.5
const actualDelay = config.baseDelayMs + Math.random() * (levelMs * peerFactor);

setTimeout(() => {
  triggerDelayExpired();  // 到期扫描转投；期间来新消息则重判
}, actualDelay);
```

**延迟的双重目的**：①群聊多 agent 时错开、避免竞态回复；②等待用户完整意图输入。
所以单聊也有 delay、也带随机；意图已完整则辅助会话直接 transfer，不 delay。

**对端系数**：对端是人 ×0.5、agent ×1.0（人打字慢但不竞态，等待可更短）。
群聊按"消息集合含 agent 就算 agent"判定，单聊看对端本身。

### 3.3 打断机制

> **唯一事实源**：打断机制的完整论述见 [interrupt-mechanism.md](./interrupt-mechanism.md)。本节为摘要，冲突时以专题文档为准。

#### 打断条件

1. 辅助会话判断需要打断（`interrupt: true`）
2. 主会话正在处理（`status === 'processing'`）
3. 当前批次未满（`currentBatchSize < 50`）

#### 打断行为

```typescript
if (shouldInterrupt) {
  // 1. 停止主会话（硬打断，调用 SDK 的 abort()）
  //    abort 使旧 process() 续体抛错中止，不会 completeBatch/feedback
  await mainSession.interrupt();
  
  // 2. 当前批次中的消息A已在主会话上下文（保留，不回灌队列）
  
  // 3. 新投递的消息追加到主队列末尾
  mainQueue.append(newMessages);
  
  // 4. 打断场景特殊提取：一次性提取主队列全部消息
  //    上限放宽为 100 条 / 20k 字节（区别于普通批次的 ≤50 条）
  //    确保紧急消息一定在新批次中，详见 interrupt-mechanism.md §5
  const newBatch = mainQueue.extractBatchForInterrupt();  // ≤100 条 / 20k
  
  // 5. 主会话处理新批次（消息A仍在上下文）
  mainSession.process(newBatch);
}
```

**副作用无法撤回**：
- 已发送的回复无法撤回
- 已执行的工具调用无法撤回

### 3.4 反馈机制

```
主会话处理完批次
  ↓
生成自然语言总结（<200字）
  ↓
代码层组装 MainFeedback：
  - summary: 从主会话输出提取
  - replies: 从工具调用历史提取
  ↓
直接调用 auxiliarySession.processFeedback()
  ↓
辅助会话更新上下文
  ↓
从辅助队列移除已处理消息
```

### 3.5 会话压缩机制

**辅助会话**：
- 触发条件：token > 40k 或消息 > 100 条
- 压缩方式：在当前会话中生成摘要，创建新会话，载入摘要 + 最近10条消息

**主会话**：
- 触发条件：token > 160k 或消息 > 200 条
- 压缩方式：同上，载入摘要 + 最近20条消息

---

## 四、单聊与群聊的差异

延迟机制（公式、随机、到期/新消息重判）**单聊与群聊完全相同**，仅以下不同。

### 4.1 辅助会话输出类型

| 场景 | 输出类型 | 说明 |
|------|---------|------|
| **群聊** | `hold / delay / transfer` | hold: 与本 agent 无关的闲聊 |
| **单聊** | `delay / transfer` | 一对一都相关，无 hold |

### 4.2 延迟投递（相同公式）

单聊与群聊延迟公式一致：`实际延迟 = baseDelayMs + random(0, baseLevelMs(delayLevel) × 对端系数)`。

| 场景 | 对端系数判定 |
|------|-------------|
| **群聊** | 消息集合含 agent → ×1.0；全是人 → ×0.5 |
| **单聊** | 对端是 agent → ×1.0；对端是人 → ×0.5 |

延迟目的：①群聊避免多 agent 竞态；②等待用户完整意图。两场景都带随机。

### 4.3 触发条件

| 触发条件 | 群聊 | 单聊 |
|---------|------|------|
| 防抖时间 | 3秒 | 3秒 |
| 最早消息强制触发 | 15秒 | 15秒 |
| **队列满强制触发** | **50条** | **15条** |
| 延迟到期 / 期间新消息重判 | 有 | 有（同群聊） |

> **已移除"主会话空闲触发"机制**：既然是延迟投递，就老实等到超时（`triggerDelayExpired`
> 扫描转投）或等延迟期间来新消息再判断——与群聊完全一致，不再因主会话空闲而抢跑。

---

## 五、批次角色一致性（群聊）

### 问题背景

群聊中，Agent 处理消息批次时可能调用需要权限判断的命令（如 `ec config`）。这些命令通过 PreToolUse Hook 获取当前会话的 `batchRole` 进行权限判断。

如果一个批次包含不同角色的发送者（如 owner 和 guest），会导致权限判断不明确。

### 解决方案

**批次提取时检查角色一致性**：

```typescript
// 群聊模式
if (chatType === 'group') {
  let batchRole: string | undefined;
  
  for (const message of queue) {
    if (batch.length === 0) {
      batchRole = message.peerRole;
      batch.push(message);
    } else if (message.peerRole === batchRole) {
      batch.push(message);  // 角色相同
    } else {
      break;  // 角色不同，停止提取
    }
  }
}
```

**权限判断**：

```typescript
const role = batchRole || message.peerRole || 'anonymous';

// 基础设施字段：只有 owner 能改
if (isInfrastructureField(field) && role !== 'owner') {
  return { decision: 'block', reason: '仅 owner 可修改' };
}
```

---

## 六、错误处理

### 6.1 主会话失败

```
主会话调用失败
  ↓
重试3次（退避：5秒、10秒、30秒）
  ↓
重试成功？
  ├─ 是 → 继续处理
  └─ 否 → 消息回退到主队列
         标记 hasError: true
         向对端发送通知
```

### 6.2 辅助会话失败降级

```
辅助会话调用失败
  ↓
重试3次
  ↓
重试成功？
  ├─ 是 → 返回决策
  └─ 否 → 返回降级决策（delay 2分钟）
         标记 fallbackMode: true
```

**降级决策**：

```typescript
{
  action: 'delay',
  delayLevel: 'long',  // 最长等级（辅助会话不可用，延后批量投递）
  reason: '降级：辅助会话不可用，延迟后批量投递',
  fallbackMode: true,
}
```

**降级投递说明**：

```markdown
【批次投递说明】
投递原因：辅助会话模型调用失败，延迟 2 分钟后批量投递（5 条消息）

注意：由于辅助会话暂时不可用，这些消息没有经过相关性判断，可能包含与你无关的消息。请自行判断是否需要响应。
```

---

## 七、mentionMode 集成

### 配置方式

```typescript
interface DualSessionConfig {
  mentionMode?: 'disabled' | 'mention-only';
}
```

### 行为

**详细机制见 [MENTION-MODE-MECHANISM.md](./MENTION-MODE-MECHANISM.md)**

| mentionMode | 被 @ 的消息 | 未被 @ 的消息 |
|-------------|-----------|-------------|
| `disabled` | 进入辅助队列 | 进入辅助队列 |
| `mention-only` | 进入辅助队列（作为主消息） | **过滤**（未 @ 消息作为引用上下文） |

**mention-only 特殊机制**：
- 被 @ 的消息：立即触发辅助会话处理，提取该消息 + 之前的引用消息（最多20条/24小时内）
- 未被 @ 的消息：作为引用上下文，不触发处理
- 活跃发言人：被 @ 的发言人在接下来5分钟内的消息视为主消息（无需再 @）

### 实现

```typescript
// 消息入队前检查
const isMentioned = mentionedSelf || mentionedAll;

if (config.mentionMode === 'mention-only') {
  // 提及模式：详细实现见 MENTION-MODE-MECHANISM.md
  await auxiliaryQueue.enqueue(message);
  
  if (isMentioned) {
    // 被 @ 消息：立即触发处理
    await handleMentionTrigger(message);
  } else if (isActiveSpeaker(message.peerId)) {
    // 活跃发言人的后续消息：走正常流程
    // 由防抖触发
  } else {
    // 未 @ 且非活跃发言人：不触发处理，作为引用上下文
  }
  return;
}

// disabled 模式：所有消息进入辅助队列
await auxiliaryQueue.enqueue(message);
```

---

## 八、chatMode 集成

### 配置方式

```typescript
interface DualSessionConfig {
  chatMode: 'interactive' | 'proactive';
}
```

### 行为

| chatMode | 主会话回复方式 |
|----------|--------------|
| `interactive` | 直接输出即回复 |
| `proactive` | 通过 CLI 发送回复 |

### 实现

```typescript
class MainSession {
  constructor(config: MainSessionConfig) {
    this.chatMode = config.chatMode;
  }
  
  async process(batch: Message[]): Promise<void> {
    // 调用模型
    const response = await this.callModel(batch);
    
    // 根据 chatMode 处理回复
    if (this.chatMode === 'interactive') {
      // 输出已经是回复，无需额外处理
    } else if (this.chatMode === 'proactive') {
      // 主会话在 turn 内通过 CLI 发送回复
      // 系统提示词中会告知使用 CLI
    }
  }
}
```

---

## 九、模块依赖

```
AuxiliaryQueue
  ↓ 依赖
  AuxiliarySession

AuxiliarySession
  ↓ 依赖
  - MainQueue（投递）
  - MainSession（查询状态）

MainQueue
  ↓ 依赖
  MainSession

MainSession
  ↓ 依赖
  - AuxiliarySession（通知反馈）
```

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-08  
**状态**: ✅ 设计定稿
