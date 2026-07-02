# 双会话响应模式 - 架构设计

## 文档说明

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**关联**: [README.md](./README.md)

---

## 一、系统组件

### 1.1 组件清单

```
┌─────────────────────────────────────────────────────────────┐
│                      Channel 适配器                          │
│              (AUN/飞书/微信/钉钉等)                          │
└────────────────────────┬────────────────────────────────────┘
                         ↓
        ┌────────────────────────────────┐
        │   AuxiliaryQueue                │  ← 新增组件
        │   辅助会话消息队列              │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   AuxiliarySession              │  ← 新增组件
        │   辅助会话管理器                │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   MainQueue                     │  ← 新增组件
        │   主会话消息队列                │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   MainSession                   │  ← 扩展现有
        │   主会话管理器                  │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   FeedbackStore                 │  ← 新增组件
        │   反馈存储 (jsonl)              │
        └────────────────────────────────┘
```

---

## 二、组件详细设计

### 2.1 AuxiliaryQueue（辅助会话消息队列）

#### 职责
- 接收从 Channel 适配器来的 AUN 消息
- 维护消息状态（PENDING / HOLD / DELAY / TRANSFERRED）
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
    maxSize: 50,                // 队列最大容量
    maxBatchSize: 50,           // 每批最多处理消息数
    maxBatchBytes: 10240,       // 每批最多字节数
  };
}

interface QueuedMessage {
  message: Message;
  state: MessageState;
  enqueuedAt: Date;
  transferAt?: Date;            // 延迟投递时间
}

enum MessageState {
  PENDING = 'pending',
  HOLD = 'hold',
  DELAY = 'delay',
  TRANSFERRED = 'transferred',
}
```

#### 核心方法
```typescript
class AuxiliaryQueue {
  // 消息入队
  enqueue(message: Message): void {
    this.messages.set(message.id, {
      message,
      state: MessageState.PENDING,
      enqueuedAt: new Date(),
    });
    
    // 重置防抖定时器
    this.resetDebounceTimer();
    
    // 检查是否需要强制触发
    if (this.messages.size >= this.config.maxSize) {
      this.triggerAuxiliary('queue-full');
    }
  }
  
  // 重置防抖定时器
  private resetDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    this.debounceTimer = setTimeout(() => {
      this.triggerAuxiliary('debounce');
    }, this.config.debounceMs);
  }
  
  // 检查最早消息超时
  private checkOldestMessage(): void {
    const oldest = this.getOldestPendingMessage();
    if (oldest) {
      const waitTime = Date.now() - oldest.enqueuedAt.getTime();
      if (waitTime >= this.config.maxWaitMs) {
        this.triggerAuxiliary('max-wait');
      }
    }
  }
  
  // 触发辅助会话处理
  private triggerAuxiliary(reason: TriggerReason): void {
    // 提取批次（最多50条或10k字节）
    const batch = this.extractBatch();
    
    // 调用辅助会话处理
    auxiliarySession.process(batch, reason);
  }
  
  // 提取批次
  private extractBatch(): Message[] {
    const batch: Message[] = [];
    let totalBytes = 0;
    
    for (const [id, qm] of this.messages) {
      if (qm.state === MessageState.PENDING || 
          (qm.state === MessageState.DELAY && qm.transferAt && qm.transferAt <= new Date())) {
        batch.push(qm.message);
        totalBytes += JSON.stringify(qm.message).length;
        
        if (batch.length >= this.config.maxBatchSize || totalBytes >= this.config.maxBatchBytes) {
          break;
        }
      }
    }
    
    return batch;
  }
  
  // 更新消息状态
  updateState(messageId: string, state: MessageState, transferAt?: Date): void {
    const qm = this.messages.get(messageId);
    if (qm) {
      qm.state = state;
      qm.transferAt = transferAt;
      
      // 如果是延迟投递，设置定时器
      if (state === MessageState.DELAY && transferAt) {
        const baseDelay = transferAt.getTime() - Date.now();
        const randomDelay = Math.random() * 60000;  // 0-60秒随机
        const actualDelay = baseDelay + randomDelay;
        
        const timer = setTimeout(() => {
          this.triggerAuxiliary('delay-timeout');
        }, actualDelay);
        
        this.delayTimers.set(messageId, timer);
      }
    }
  }
  
  // 移除已投递的消息
  remove(messageIds: string[]): void {
    for (const id of messageIds) {
      this.messages.delete(id);
      
      // 清除延迟定时器
      const timer = this.delayTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.delayTimers.delete(id);
      }
    }
  }
}
```

---

### 2.2 AuxiliarySession（辅助会话管理器）

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
    maxTokens: 40000,           // 触发 new 的阈值
    maxMessages: 100,
    compressionTarget: 2000,    // 压缩摘要字数
    recentMessagesCount: 10,    // new 后载入的最近消息数
  };
}
```

#### 核心方法
```typescript
class AuxiliarySession {
  // 处理消息批次
  async process(batch: Message[], reason: TriggerReason): Promise<void> {
    // 构建输入
    const input: AuxiliaryInput = {
      type: 'aun-messages',
      aunMessages: {
        queue: auxiliaryQueue.getAllUndelivered(),
        newMessages: batch,
      },
      mainSession: {
        status: mainSession.getStatus(),
        currentBatchSize: mainSession.getCurrentBatchSize(),
        queueSize: mainQueue.size(),
      },
    };
    
    // 调用辅助会话模型
    const output = await this.callModel(input);
    
    // 解析输出并执行
    await this.executeDecision(output);
    
    // 检查是否需要 new
    if (this.shouldCompress()) {
      await this.compressAndNew();
    }
  }
  
  // 处理主会话反馈
  async processFeedback(feedback: MainFeedback): Promise<void> {
    const input: AuxiliaryInput = {
      type: 'main-feedback',
      mainFeedback: feedback,
      mainSession: {
        status: mainSession.getStatus(),
        queueSize: mainQueue.size(),
      },
    };
    
    const output = await this.callModel(input);
    
    // 更新上下文
    this.context.append(`[主会话反馈] ${feedback.summary}`);
    
    // 从辅助队列移除已处理消息
    auxiliaryQueue.remove(feedback.processedMessageIds);
  }
  
  // 调用模型
  private async callModel(input: AuxiliaryInput): Promise<AuxiliaryOutput> {
    const prompt = this.buildPrompt(input);
    
    const response = await claudeAPI.call({
      model: this.model,
      messages: [
        { role: 'user', content: prompt }
      ],
      system: await this.loadSystemPrompt(),
    });
    
    return JSON.parse(response.content);
  }
  
  // 执行决策
  private async executeDecision(output: AuxiliaryOutput): Promise<void> {
    if (output.type === 'aun-decision') {
      const { action, delayMs, interrupt, reason } = output.decision;
      
      if (action === 'hold') {
        // 更新状态为 HOLD
        for (const msg of auxiliaryQueue.getAllUndelivered()) {
          auxiliaryQueue.updateState(msg.id, MessageState.HOLD);
        }
      } else if (action === 'delay') {
        // 更新状态为 DELAY，设置延迟时间
        const transferAt = new Date(Date.now() + (delayMs || 3000));
        for (const msg of auxiliaryQueue.getAllUndelivered()) {
          auxiliaryQueue.updateState(msg.id, MessageState.DELAY, transferAt);
        }
      } else if (action === 'transfer') {
        // 投递到主队列
        const messages = auxiliaryQueue.getAllUndelivered();
        
        if (interrupt) {
          await mainQueue.interrupt(messages);
        } else {
          await mainQueue.append(messages);
        }
        
        // 更新状态为 TRANSFERRED
        for (const msg of messages) {
          auxiliaryQueue.updateState(msg.id, MessageState.TRANSFERRED);
        }
      }
    } else if (output.type === 'feedback-ack') {
      // 确认反馈，无需额外操作
    }
  }
  
  // 检查是否需要压缩
  private shouldCompress(): boolean {
    return this.context.tokenCount >= this.config.maxTokens ||
           this.context.messageCount >= this.config.maxMessages;
  }
  
  // 压缩并创建新会话
  private async compressAndNew(): Promise<void> {
    // 在当前会话中生成压缩摘要
    const compressionPrompt = `
请将当前对话压缩成摘要（<${this.config.compressionTarget}字）：

格式：
- 讨论话题：
- 参与者：
- 重要事件：
- 当前状态：
`;
    
    const summary = await this.callModel({
      type: 'compression',
      prompt: compressionPrompt,
    });
    
    // 创建新会话
    const newConversationId = generateId();
    
    // 载入压缩摘要 + 最近消息
    const recentMessages = this.context.getRecentMessages(this.config.recentMessagesCount);
    
    this.conversationId = newConversationId;
    this.context = new ConversationContext({
      summary,
      recentMessages,
    });
  }
}
```

---

### 2.3 MainQueue（主会话消息队列）

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
    if (!mainSession.isProcessing() || this.processing.length >= this.config.maxBatchSize) {
      // 主会话空闲，或当前批次已满，不打断，直接追加
      this.append(messages);
      return;
    }
    
    // 打断主会话
    await mainSession.interrupt();
    
    // 新消息追加到队列末尾
    this.queue.push(...messages);
    
    // 重新触发处理
    this.triggerMainSession();
  }
  
  // 提取批次
  extractBatch(): Message[] {
    const batch = this.queue.splice(0, this.config.maxBatchSize);
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
  
  // 触发主会话处理
  private triggerMainSession(): void {
    const batch = this.extractBatch();
    mainSession.process(batch);
  }
  
  // 获取队列大小
  size(): number {
    return this.queue.length;
  }
}
```

---

### 2.4 MainSession（主会话管理器）

#### 职责
- 管理主会话的生命周期
- 批量处理消息
- 生成回复
- 输出处理总结并反馈给辅助会话
- 管理会话上下文和压缩

#### 数据结构
```typescript
class MainSession {
  private conversationId: string;
  private context: ConversationContext;
  private model: string = 'claude-opus';
  private status: 'idle' | 'processing' = 'idle';
  private currentBatch: Message[] = [];
  
  private readonly config = {
    maxTokens: 160000,
    maxMessages: 200,
    recentMessagesCount: 20,
  };
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
    
    // 生成回复（通过 CLI）
    await this.sendReplies(response.replies);
    
    // 生成处理总结
    const summary = this.generateSummary(batch, response);
    
    // 追加到 feedback 文件
    await feedbackStore.append(summary);
    
    // 通知辅助会话
    await auxiliarySession.processFeedback(summary);
    
    // 标记完成
    mainQueue.completeBatch();
    this.status = 'idle';
    this.currentBatch = [];
    
    // 检查是否需要 new
    if (this.shouldCompress()) {
      await this.compressAndNew();
    }
  }
  
  // 打断
  async interrupt(): Promise<void> {
    this.status = 'idle';
    // 当前批次中的消息已在上下文，保留
    // 不需要清理 this.currentBatch，因为会重新提取
  }
  
  // 调用模型
  private async callModel(batch: Message[]): Promise<MainResponse> {
    const prompt = this.buildPrompt(batch);
    
    const response = await claudeAPI.call({
      model: this.model,
      messages: [
        { role: 'user', content: prompt }
      ],
      system: await this.loadSystemPrompt(),
    });
    
    return this.parseResponse(response.content);
  }
  
  // 发送回复（通过 CLI）
  private async sendReplies(replies: string[]): Promise<void> {
    for (const reply of replies) {
      await bash(`ec msg send ${this.selfAid} ${this.peerId} "${reply}"`);
    }
  }
  
  // 生成处理总结
  private generateSummary(batch: Message[], response: MainResponse): MainFeedback {
    return {
      batchId: generateId(),
      processedAt: new Date().toISOString(),
      processedMessageIds: batch.map(m => m.id),
      summary: response.summary,
      replies: response.replies,
    };
  }
  
  // 压缩并创建新会话（同 AuxiliarySession）
  private async compressAndNew(): Promise<void> {
    // 实现同辅助会话
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

### 2.5 FeedbackStore（反馈存储）

#### 职责
- 追加主会话的处理总结到 jsonl 文件
- 提供查询接口

#### 数据结构
```typescript
class FeedbackStore {
  private filePath: string;  // ${AGENT_DIR}/relations/${peerKey}/main-feedback.jsonl
}
```

#### 核心方法
```typescript
class FeedbackStore {
  // 追加反馈
  async append(feedback: MainFeedback): Promise<void> {
    const line = JSON.stringify(feedback) + '\n';
    await fs.promises.appendFile(this.filePath, line, 'utf-8');
  }
  
  // 查询最近的反馈
  async getRecent(limit: number = 10): Promise<MainFeedback[]> {
    const content = await fs.promises.readFile(this.filePath, 'utf-8');
    const lines = content.trim().split('\n');
    return lines.slice(-limit).map(line => JSON.parse(line));
  }
}
```

---

## 三、组件交互流程

### 3.1 消息到达流程
```
1. Channel 适配器收到 AUN 消息
   ↓
2. 调用 AuxiliaryQueue.enqueue(message)
   ↓
3. AuxiliaryQueue 重置防抖定时器
   ↓
4. 检查触发条件：
   - 防抖 3 秒？
   - 最早消息 15 秒？
   - 队列满 50 条？
   ↓
5. 触发 AuxiliarySession.process(batch)
```

### 3.2 辅助会话处理流程
```
1. AuxiliarySession.process(batch)
   ↓
2. 构建输入（aunMessages + mainSession 状态）
   ↓
3. 调用辅助会话模型
   ↓
4. 解析输出（hold / delay / transfer）
   ↓
5. 执行决策：
   - hold: 更新状态为 HOLD
   - delay: 更新状态为 DELAY，设置延迟定时器
   - transfer: 投递到主队列（append / interrupt）
```

### 3.3 主会话处理流程
```
1. MainQueue 触发 MainSession.process(batch)
   ↓
2. 构建输入（批次消息 + 已在上下文的消息）
   ↓
3. 调用主会话模型
   ↓
4. 生成回复（通过 CLI 发送）
   ↓
5. 生成处理总结
   ↓
6. 追加到 main-feedback.jsonl
   ↓
7. 通知 AuxiliarySession.processFeedback()
   ↓
8. 标记批次完成，继续处理队列
```

### 3.4 打断流程
```
1. AuxiliarySession 判断需要打断（interrupt: true）
   ↓
2. 调用 MainQueue.interrupt(messages)
   ↓
3. MainQueue 检查是否应该打断：
   - 主会话正在处理？
   - 当前批次 < 50 条？
   ↓
4. 如果是，调用 MainSession.interrupt()
   ↓
5. MainSession 停止当前处理（标记 idle）
   ↓
6. MainQueue 追加新消息到队列末尾
   ↓
7. MainQueue 重新提取批次（含新消息）
   ↓
8. MainSession 处理新批次（之前的消息已在上下文）
```

---

## 四、数据流图

```
┌─────────────────────────────────────────────────────────────┐
│                    AUN 消息到达                              │
└────────────────────────┬────────────────────────────────────┘
                         ↓
        ┌────────────────────────────────┐
        │   AuxiliaryQueue                │
        │   - enqueue(message)           │
        │   - 重置防抖                    │
        │   - 检查触发条件                │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   AuxiliarySession              │
        │   - process(batch)             │
        │   - 调用模型                    │
        │   - 解析输出                    │
        │   - 执行决策                    │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   MainQueue                     │
        │   - append / interrupt         │
        │   - extractBatch               │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   MainSession                   │
        │   - process(batch)             │
        │   - 调用模型                    │
        │   - 发送回复（CLI）             │
        │   - 生成总结                    │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   FeedbackStore                 │
        │   - append(feedback)           │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   AuxiliarySession              │
        │   - processFeedback()          │
        │   - 更新上下文                  │
        │   - 移除已处理消息              │
        └────────────────────────────────┘
```

---

## 五、模块依赖

```
AuxiliaryQueue
  ↓ 依赖
  AuxiliarySession

AuxiliarySession
  ↓ 依赖
  - MainQueue（投递）
  - MainSession（查询状态）
  - FeedbackStore（不直接依赖，通过事件通知）

MainQueue
  ↓ 依赖
  MainSession

MainSession
  ↓ 依赖
  - FeedbackStore（追加反馈）
  - AuxiliarySession（通知反馈）
```

---

## 六、扩展点

### 6.1 自定义触发条件
`AuxiliaryQueue` 的触发条件可配置化：
```typescript
interface TriggerConfig {
  debounceMs: number;
  maxWaitMs: number;
  maxSize: number;
  customRules?: ((queue: AuxiliaryQueue) => boolean)[];
}
```

### 6.2 自定义模型
辅助/主会话的模型可配置：
```typescript
interface SessionConfig {
  auxiliaryModel: string;  // deepseek-v4-flash / claude-haiku
  mainModel: string;       // claude-opus / claude-sonnet
}
```

### 6.3 自定义反馈格式
`FeedbackStore` 支持自定义序列化格式（jsonl / json / 数据库）。

---

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**维护者**: EvolClaw 团队
