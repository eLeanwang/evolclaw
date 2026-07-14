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
  private expiryTimer: NodeJS.Timeout | null;  // 全队列单个到期定时器（DELAY/HOLD 共用，见 §6.2）
  
  // 配置
  private readonly config = {
    debounceMs: 3000,           // 防抖时间
    maxWaitMs: 15000,           // 最早消息最长等待
    maxSize: 50,                // 队列最大容量（群聊 50，单聊 15）
    maxBatchSize: 50,           // 每批最多处理消息数
    maxBatchBytes: 10240,       // 每批最多字节数
  };
  
  constructor(
    private chatType: 'private' | 'group',
    private mentionMode: 'disabled' | 'mention-only' = 'disabled',
  ) {
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
  expireAt?: Date;                // DELAY/HOLD 的到期时刻（批内统一；到期扫描转投）
  expireReason?: 'delay' | 'hold-timeout';
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

> 主会话反馈**不是触发源**：反馈只包成 FeedbackItem 入队暂存，被动等待上述任一真实触发时
> 随本批带出（见 §3.4）。这样不额外唤醒辅助会话、不额外调模型、不绕过队列。

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
    
    // 队列容量控制：按 mentionMode 分流（唯一入口，模式无关地兜底）
    if (this.mentionMode === 'mention-only') {
      // mention-only：未 @ 消息不参与强制转投（只作引用上下文），
      // 仅在堆到 2×maxSize 时滚动淘汰最老的一半（见 MENTION-MODE-MECHANISM.md §5.5）
      this.rollingEvict();
    } else {
      // disabled：到 maxSize 强制转投主队列（不打断）
      if (this.shouldForceTransfer()) {
        this.forceTransferAll();
      }
    }
  }
  
  // 滚动淘汰（mention-only 兜底）：达到 2×maxSize 时砍掉最老的一半，保留 maxSize 条
  private rollingEvict(): void {
    const L = this.config.maxSize;   // 群 50 / 单 15
    if (this.messages.size >= 2 * L) {
      // Map 按插入序迭代，取最老的 (size - L) 条移除
      const overflow = this.messages.size - L;
      const oldest = Array.from(this.messages.keys()).slice(0, overflow);
      this.remove(oldest);
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
  
  // 更新消息状态（DELAY/HOLD 时写入该批次统一算好的 expireAt 与 expireReason）
  // 注意：这里只写字段，不在此挂定时器。到期定时器是全队列单个、由 armExpiryTimer()
  //       从各消息的 expireAt 派生维护（见 auxiliary-queue-processing.md §6.2）。
  updateState(
    messageId: string,
    state: MessageState,
    expire?: { expireAt: Date; expireReason: 'delay' | 'hold-timeout' }
  ): void {
    const qm = this.messages.get(messageId);
    if (qm) {
      qm.state = state;
      qm.processedByAuxiliary = true;
      qm.expireAt = expire?.expireAt;
      qm.expireReason = expire?.expireReason;
    }
  }
  
  // 移除已投递的消息（不按消息清定时器；单个到期定时器由调用方随后 armExpiryTimer() 重算）
  remove(messageIds: string[]): void {
    for (const id of messageIds) {
      this.messages.delete(id);
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
  // 一次触发的批次 = 带标记的项列表；每项 kind 区分，遍历时分别对待。
  // 反馈保持独立类型、与新消息同批带入，但反馈不是触发源（详见 data-structures.md §1.3）。
  items: Array<
    | { kind: 'message';  message: Message }         // 待判断的新消息
    | { kind: 'feedback'; feedback: MainFeedback }   // 主会话反馈，只读上下文，不单独产出决策
  >;
  remainingInQueue: number;        // 【信号A】去掉本批次后，辅助队列剩余待判断数（催快）

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
  // 输出只有决策一种（反馈是只读上下文，不再需要 feedback-ack 应答）
  type: 'aun-decision';

  decision: {
    action: 'hold' | 'delay' | 'transfer';  // 单聊无 hold

    // 如果 action = 'delay'
    delayLevel?: 'short' | 'medium' | 'long';  // 延迟等级（默认 medium）

    // 如果 action = 'transfer'
    interrupt?: boolean;           // 是否打断（默认false）

    // 简短说明（<50字）
    reason: string;
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
  
  // 接收主会话反馈：只入队暂存，不调模型、不触发处理
  enqueueFeedback(feedback: MainFeedback): void {
    // 包成 FeedbackItem 插入辅助队列，等待下次真实触发时随批带出。
    // 反馈是纯上下文信息，无需立刻消费 —— 零额外 LLM 调用，也不绕过队列。
    auxiliaryQueue.enqueueFeedback(feedback);
    // 注意：这里不调用 callModel，也不主动触发辅助会话。
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
        // 只投递辅助会话已经见过的消息（判断期间新入队的 PENDING 留到一轮）。
        // 批次在提取时已同角色成形；之前 hold/delay 的批次按序先投（不带 interrupt），
        // 触发本次 transfer 的批次携带本次指令。详见 auxiliary-queue-processing.md §5.2
        await transferToMain(output.decision, currentBatch);
      }
    }
  }
}
```

---

### 2.3 MainQueue（主队列）

#### 职责

- 接收辅助会话转投的**同角色批次**（`TransferBatch`，携带判断指令），作为调度单位维护
- 执行批次调度：interrupt 批次优先（跳过的批次作 reference、本体留队列），否则 FIFO
- 执行 ignore 指令的队列侧动作（移除未处理批次）
- 打断守卫：判断是否硬 abort 在飞批次

> 调度规则与打断语义的 SSOT 是 [interrupt-mechanism.md](./interrupt-mechanism.md)，本节为实现视图。

#### 数据结构

```typescript
class MainQueue {
  private batches: TransferBatch[] = [];        // 等待中的批次（到达顺序）
  private processing: TransferBatch | null = null;  // 在飞批次
}
```

#### 核心方法

```typescript
class MainQueue {
  // 批次入队（transfer 边界已同角色、已带指令）
  async enqueueBatch(batch: TransferBatch): Promise<void> {
    this.batches.push(batch);
    
    // 主会话空闲 → 立即调度
    if (mainSession.isIdle()) {
      this.triggerMainSession();
    }
  }
  
  // 打断守卫（enqueueBatch 后由 transferToMain 在 interrupt=true 时调用）
  async maybeInterruptInFlight(): Promise<void> {
    // 四条件见 interrupt-mechanism.md §5：开关、interrupt 批存在、processing、在飞批未满
    if (!mainSession.isProcessing() ||
        (this.processing?.messages.length ?? 0) >= this.config.maxBatchSize) {
      return;  // 不中止在飞批；interrupt 批仍在队列，下个调度点被优先选取
    }
    
    // 硬 abort 在飞批次（其消息已在上下文，不回灌；处置由 previousMessageStrategy 决定）
    await mainSession.interrupt();
    this.processing = null;
    
    this.triggerMainSession();  // 立即进入下一轮调度
  }
  
  // 调度提取：主会话每处理完一个批次调用（规则 SSOT：interrupt-mechanism.md §3）
  nextBatch(): { primary: TransferBatch; references: TransferBatch[] } | null {
    if (this.batches.length === 0) return null;
    
    // 1. 找「最后一个」interrupt=true 的批次（最新的紧急判断）
    let idx = -1;
    for (let i = this.batches.length - 1; i >= 0; i--) {
      if (this.batches[i].interrupt) { idx = i; break; }
    }
    
    if (idx === -1) {
      // 2. 无 interrupt 批次 → FIFO
      const primary = this.batches.shift()!;
      this.processing = primary;
      return { primary, references: [] };
    }
    
    // 3. interrupt 批次优先；被跳过的更早批次作 reference（只读注入），本体留队列排队
    const primary = this.batches.splice(idx, 1)[0];
    const references = this.batches.slice(0, idx);  // 不移除——仍在队列
    
    // 4. 执行 primary 的 previousMessageStrategy 对队列的动作（interrupt-mechanism.md §4）
    if (primary.previousMessageStrategy === 'ignore') {
      // ignore：之前未处理的已转投批次从队列真实移除（对在飞批则靠提示词，见 §3.3）
      this.batches = this.batches.slice(idx);  // 移除 primary 之前的所有批次
      references.length = 0;                   // 被移除的不再作为 reference
    }
    
    this.processing = primary;
    return { primary, references };
  }
  
  // ignore 指令：移除指定的未处理批次
  removeBatches(batchIds: string[]): void {
    this.batches = this.batches.filter(b => !batchIds.includes(b.batchId));
  }
  
  // 标记批次处理完成
  completeBatch(batchId: string): void {
    this.processing = null;
    
    // 队列还有批次 → 继续调度
    if (this.batches.length > 0) {
      this.triggerMainSession();
    }
  }
}
```

> **角色一致性不在这里检查**——批次在 transfer 边界已同角色成形（见 §5、
> auxiliary-queue-processing.md §1.2），主队列不拆散重切，`batchRole` 天然唯一。

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
  private generation = 0;  // 处理代号：开始新批次/打断时 +1；过期续体静默退出（interrupt-mechanism.md §8.2）
  
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
    
    // 通知辅助会话：仅入队暂存反馈，不调模型、不触发（被动带入）
    auxiliarySession.enqueueFeedback(feedback);
    
    // 标记完成
    mainQueue.completeBatch();
    this.status = 'idle';
    this.currentBatch = [];
    
    // 检查是否需要压缩
    if (this.shouldCompress()) {
      await this.compressAndNew();
    }
  }
  
  // 打断：硬打断，中止正在进行的模型调用
  // 契约（详见 interrupt-mechanism.md §6、§8.2）：
  //   - 必须真正中止进行中的模型调用，不能只把 status 置为 idle
  //   - 必须 generation++，使所有在飞续体过期（旧 catch/finally 醒来后静默退出）
  //   - 当前批次的处理随之停止：不产出回复、不生成反馈、不标记批次完成
  //   - 被打断批次的消息已在上下文中，保留；不回灌队列
  async interrupt(): Promise<void>;
  
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

// 批内统一写 expireAt（无 skew），再维护全队列单个到期定时器
const expireAt = new Date(Date.now() + actualDelay);
for (const msg of batch) {
  auxiliaryQueue.updateState(msg.id, MessageState.DELAY, { expireAt, expireReason: 'delay' });
}
armExpiryTimer();  // DELAY 与 HOLD 共用；到期扫描转投，期间来新消息则重判
```

**延迟的双重目的**：①群聊多 agent 时错开、避免竞态回复；②等待用户完整意图输入。
所以单聊也有 delay、也带随机；意图已完整则辅助会话直接 transfer，不 delay。

**对端系数**：对端是人 ×0.5、agent ×1.0（人打字慢但不竞态，等待可更短）。
群聊按"消息集合含 agent 就算 agent"判定，单聊看对端本身。

### 3.3 打断与批次调度

> **唯一事实源**：完整论述见 [interrupt-mechanism.md](./interrupt-mechanism.md)。本节为摘要，冲突时以专题文档为准。

#### 打断条件（中止在飞批次）

1. `interruptEnabled === true`
2. 批次携带 `interrupt: true`（辅助会话判断）
3. 主会话正在处理（`status === 'processing'`）
4. 在飞批次未满（`< 50`）

任一不满足 → 不中止在飞批次，但 interrupt 批次仍入队，下个调度点被优先选取。

#### 打断行为

打断成立后依次发生：

1. **硬打断主会话**：中止正在进行的模型调用，在飞批次的处理立即停止，
   不再产出回复、不生成反馈、不标记批次完成。
2. **被打断批次保留在上下文**：这些消息已在主会话上下文中，不回灌队列；
   如何对待由 `previousMessageStrategy` 决定（ignore 对在飞批 = 提示词提示忽略）。
3. **进入调度**：遍历主队列取最后一个 interrupt 批次优先处理；
   被跳过的更早批次作为 reference（只读引用）注入，本体留队列排队；
   若指令为 ignore，primary 之前的未处理批次**从队列真实移除**。
4. **主会话处理 primary 批次**：同角色、带打断通知与 references。

> 主队列以批次为单位调度，紧急批次天然完整入队、整批优先处理。见 interrupt-mechanism.md §2。

**副作用无法撤回**：
- 已发送的回复无法撤回
- 已执行的工具调用无法撤回

### 3.4 反馈机制（被动带入，不额外调模型）

反馈是纯上下文信息：让辅助会话知道主会话消费了哪些消息、回了什么，供它下次重判 hold/delay 时参考。
因此**不需要立刻处理**——包成 FeedbackItem 入队暂存，等下次辅助会话被真实触发时随批带出即可。

```
主会话处理完批次
  ↓
生成自然语言总结（<200字）
  ↓
代码层组装 MainFeedback：
  - summary: 从主会话输出提取
  - replies: 从工具调用历史提取
  ↓
auxiliarySession.enqueueFeedback()
  → 包成 FeedbackItem 插入辅助队列（不调模型、不触发处理）
  ↓
……（被动等待）……
  ↓
下次辅助会话被真实触发（防抖/超时/队列满/延迟到期）
  ↓
extractBatch() 把队列中的 FeedbackItem 随本批新消息一起带出
  ↓
辅助会话遍历批次：kind='feedback' 的项作为只读上下文吸收
（不为反馈单独产出决策、不产出 ack）
```

**三条不变量**（对齐 lite P1-4 / P1-6）：
- **零额外 LLM 调用**：反馈搭下一次决策的便车，不单独唤起模型
- **零额外延迟**：不主动触发，也就不打乱既有节奏
- **不绕过队列**：反馈经辅助队列流转，串行化不变量保持

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
| HOLD 超时兜底投递 | 1 小时（独立定时器驱动） | —（单聊无 HOLD） |

> **已移除"主会话空闲触发"机制**：既然是延迟投递，就老实等到超时（`triggerExpiredScan`
> 扫描转投）或等延迟期间来新消息再判断——与群聊完全一致，不再因主会话空闲而抢跑。

> **HOLD/DELAY 到期统一由独立定时器驱动**：不依赖新消息到来，队列安静也能按时兜底投递；
> 全队列单个定时器，重启后按 `expireAt` 重建。详见 auxiliary-queue-processing.md §6.2。

---

## 五、批次角色一致性（群聊）

### 问题背景

群聊中，Agent 处理消息批次时可能调用需要权限判断的命令（如 `ec config`）。这些命令通过 PreToolUse Hook 获取当前会话的 `batchRole` 进行权限判断。

如果一个批次包含不同角色的发送者（如 owner 和 guest），会导致权限判断不明确。

### 解决方案：批次在 transfer 边界成形（同角色）

角色同质在**辅助队列提取时**就完成：`extractBatch()` 遇到不同 `peerRole` 即截批
（机械字段分组，非权限判断，见 auxiliary-queue-processing.md §1.2/§7.3）。
transfer 投出的每个 `TransferBatch` 天然同角色、携带 `batchRole` 字段。

**主队列以批次为调度单位，不拆散重切**——这同时保证了：
1. **权限清晰**：`batchRole` 唯一，PreToolUse Hook 判断不含糊；
2. **判断有效**：辅助会话的指令（打断/忽略/优先）精确作用于它判断的那批消息；
3. **打断不破窗**：打断/优先调度均以同角色批次为单位，不存在跨角色混批
   （打断/优先均以批次为调度单位，见 interrupt-mechanism.md §2/§3）。

**权限判断**（主会话侧，PreToolUse Hook）：

```typescript
const role = batch.batchRole || 'anonymous';

// 基础设施字段：只有 owner 能改
if (isInfrastructureField(field) && role !== 'owner') {
  return { decision: 'block', reason: '仅 owner 可修改' };
}
```

> 被跳过批次以 reference（只读引用）注入当前批次时，**不影响 `batchRole`**——
> reference 不作为响应对象、不触发带权限操作（见 interrupt-mechanism.md §3）。

---

## 六、错误处理

### 6.1 主会话失败

```
主会话调用失败（callModel 抛错）
  ↓
generation 守卫检查：myGen === mainSession.generation ？
  ├─ 否 → 静默退出（这是被打断的旧续体，不重试、不回灌、不碰状态）
  │       （打断会使 generation +1，见 interrupt-mechanism.md §8.2——实现必做）
  └─ 是 → 当前批次的真实失败，继续 ↓
重试3次（退避：5秒、10秒、30秒；每次重试前同样过 generation 守卫）
  ↓
重试成功？
  ├─ 是 → 继续处理
  └─ 否 → 批次回退到主队列
         标记 hasError: true
         向对端发送通知
```

> **失败重试与打断的边界**：只有"当前代"的失败才进入重试/回退流程。被 abort 的旧续体
> 从 catch/finally 醒来时已过代，一律静默退出——否则会出现旧批次复活重试、被打断批次
> 回灌队列、旧 finally 踩掉新批次状态等竞态（详见 interrupt-mechanism.md §8.2）。

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
| `mention-only` | 进入辅助队列（作为主消息 primary） | 进入辅助队列（作为引用上下文，**不触发处理**） |

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
