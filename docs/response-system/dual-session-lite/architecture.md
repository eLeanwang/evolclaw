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
    maxSize: 50,                // 队列最大容量（群聊）/ 15（单聊）
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
  HOLD = 'hold',        // 已处理，暂时挂起（队列满时投递）
  DELAY = 'delay',      // 已处理，延迟投递
}
```

**说明**：
- **HOLD 不是"永久不投递"，而是"暂时挂起"**
- **辅助队列消息的唯一出口**：转移到主队列
- **transfer 后立即从辅助队列删除**（无需 TRANSFERRED 状态）
- **processedByAuxiliary 标记**：已处理的消息不会重复输入给辅助会话

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
    
    // 检查队列是否满（消息数或字节数）
    const totalSize = this.messages.size;
    const totalBytes = this.getTotalBytes();
    
    if (totalSize >= this.config.maxSize ||  // 群聊 50，单聊 15
        totalBytes >= this.config.maxBatchBytes) {  // 10k 字节
      
      // 队列满：强制投递所有消息到主队列
      const allMessages = Array.from(this.messages.values())
        .sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime())
        .map(qm => qm.message);
      
      mainQueue.append(allMessages);  // 排队投递，不打断
      
      // 清空辅助队列
      this.messages.clear();
    }
  }
  
  // 获取未处理的消息（喂给辅助会话）
  getUnprocessedMessages(): Message[] {
    return Array.from(this.messages.values())
      .filter(qm => !qm.processedByAuxiliary)
      .map(qm => qm.message);
  }
  
  // 计算队列总字节数
  private getTotalBytes(): number {
    return Array.from(this.messages.values())
      .reduce((sum, qm) => sum + JSON.stringify(qm.message).length, 0);
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
    let batchRole: string | undefined;  // 批次内统一的角色
    
    for (const [id, qm] of this.messages) {
      if (qm.state === MessageState.PENDING || 
          (qm.state === MessageState.DELAY && qm.transferAt && qm.transferAt <= new Date())) {
        
        // 【角色权限一致性】群聊中检查发送者角色是否一致
        if (this.chatType === 'group') {
          const messageRole = qm.message.role;  // owner | admin | guest | anonymous
          
          if (batch.length === 0) {
            // 第一条消息，记录角色
            batchRole = messageRole;
          } else if (batchRole !== messageRole) {
            // 角色不一致，停止提取当前批次
            // 当前消息留在队列中，等待下一轮提取
            break;
          }
        }
        
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
        
        // 群聊加随机数（避免多 agent 竞争），单聊不加
        const randomDelay = this.chatType === 'group' ? Math.random() * 60000 : 0;
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
    // 【角色权限一致性】群聊中检查发送者角色是否一致
    if (this.chatType === 'group') {
      const batch: Message[] = [];
      let batchRole: string | undefined;
      
      for (let i = 0; i < Math.min(this.queue.length, this.config.maxBatchSize); i++) {
        const message = this.queue[i];
        const messageRole = message.role;
        
        if (i === 0) {
          batchRole = messageRole;
          batch.push(message);
        } else if (batchRole === messageRole) {
          batch.push(message);
        } else {
          // 角色不一致，停止提取
          break;
        }
      }
      
      // 从队列中移除已提取的消息
      this.queue.splice(0, batch.length);
      this.processing = batch;
      return batch;
    }
    
    // 私聊：直接提取
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
    
    // 调用主会话模型（主会话在 turn 内自己通过 CLI 发送回复）
    const response = await this.callModel(batch);
    
    // 从主会话输出中提取自然语言总结
    const summary = this.extractSummary(response.content);
    
    // 从工具调用历史中提取回复内容
    const replies = this.extractRepliesFromToolCalls();
    
    // 组装反馈
    const feedback: MainFeedback = {
      summary,
      replies,
    };
    
    // 直接通知辅助会话（不写文件）
    await auxiliarySession.processFeedback(feedback);
    
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
  
  // 从主会话输出中提取自然语言总结
  private extractSummary(content: string): string {
    // 简单实现：取最后一段非空文本（<200字）
    const lines = content.trim().split('\n').filter(l => l.trim());
    return lines[lines.length - 1].substring(0, 200);
  }
  
  // 从工具调用历史中提取回复内容
  private extractRepliesFromToolCalls(): string[] {
    const replies: string[] = [];
    
    // 遍历当前 turn 的工具调用历史
    for (const toolCall of this.currentTurnToolCalls) {
      if (toolCall.name === 'ec' && 
          (toolCall.args.includes('msg send') || toolCall.args.includes('group send'))) {
        // 提取消息正文（简化实现，实际需要解析命令参数）
        const messageContent = this.extractMessageFromCommand(toolCall.args);
        if (messageContent) {
          replies.push(messageContent);
        }
      }
    }
    
    return replies;
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
  
  // 状态变化时触发（单聊场景）
  private onStatusChange(oldStatus: SessionStatus, newStatus: SessionStatus): void {
    // 单聊场景下，主会话变为空闲时触发辅助队列检查
    if (this.chatType === 'private' && 
        oldStatus === 'processing' && 
        newStatus === 'idle') {
      const undelivered = auxiliaryQueue.getAllUndelivered();
      if (undelivered.length > 0) {
        auxiliarySession.process(undelivered, 'main-idle');
      }
    }
  }
}
```

**说明**：
- 单聊场景下，主会话从 `processing` 变为 `idle` 时，立即触发辅助队列检查
- 效果：延迟投递（delay）在主会话空闲后立即重新判断，通常会变为 transfer
- 群聊场景下不需要此机制

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
   - 队列满（群聊 50 条 / 单聊 15 条）？
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
4. 解析输出（群聊: hold / delay / transfer；单聊: delay / transfer）
   ↓
5. 执行决策：
   - hold: 更新状态为 HOLD（仅群聊）
   - delay: 更新状态为 DELAY，设置延迟定时器（群聊加随机数，单聊不加）
   - transfer: 投递到主队列（append / interrupt）
```

### 3.3 主会话处理流程
```
1. MainQueue 触发 MainSession.process(batch)
   ↓
2. 构建输入（批次消息 + 已在上下文的消息）
   ↓
3. 调用主会话模型（主会话在 turn 内自己通过 CLI 发送回复）
   ↓
4. 主会话输出自然语言总结（<200字）
   ↓
5. 代码层组装 MainFeedback：
   - 从主会话输出中提取 summary
   - 从工具调用历史中提取 replies
   ↓
6. 直接调用 AuxiliarySession.processFeedback(feedback)
   ↓
7. 标记批次完成，继续处理队列
```

### 3.4 打断流程
```
1. AuxiliarySession 判断需要打断
   ↓
   输出包含：
   - interrupt: true
   - interruptReason: "紧急问题需要立即处理"
   - previousMessageStrategy: "defer"
   ↓
2. 调用 MainQueue.interrupt(messages, interruptInfo)
   ↓
3. MainQueue 检查是否应该打断：
   - 主会话正在处理？
   - 当前批次 < 50 条？
   ↓
4. 如果是，调用 MainSession.interrupt(interruptInfo)
   ↓
5. MainSession.interrupt() 调用 agent.interrupt(sessionId)
   ↓
6. agent.interrupt() 调用 SDK 的 sdkStream.interrupt()
   ↓
7. **硬打断**：中止当前 API 请求（abort）
   ↓
8. 记录 interruptInfo（打断原因和处理策略）
   ↓
9. MainQueue 追加新消息到队列末尾
   ↓
10. MainQueue 重新提取批次（含新消息）
   ↓
11. MainSession 处理新批次，系统提示词中注入打断信息
```

**打断机制说明**：
- **硬打断**：调用 SDK 的 `interrupt()` 方法，中止当前 API 请求
- **副作用无法撤回**：
  - 已发送的回复（通过 `ec group send` / `ec msg send`）无法撤回
  - 已执行的工具调用（修改文件、执行命令等）无法撤回
- **上下文保留**：打断前的消息和部分响应已在主会话上下文中
- **单聊和群聊的打断操作相同**：都是调用 `agent.interrupt(sessionId)`

**打断信息注入到主会话系统提示词**：

根据 `previousMessageStrategy` 的值，注入对应的文字描述：

**ignore 策略**：
```
【打断通知】
原因：紧急问题需要立即处理。
处理建议：忽略之前的消息，只处理新消息。
```

**defer 策略**：
```
【打断通知】
原因：紧急问题需要立即处理。
处理建议：先处理新消息，完成后再处理之前的消息。
```

**continue 策略**：
```
【打断通知】
原因：用户补充了重要信息。
处理建议：继续处理之前的消息，但考虑新消息的内容。
```

**要点**：
- 只插入打断原因和处理建议的文字描述
- 不枚举被打断的具体消息
- 被打断的消息仍在主会话上下文中，可以继续参考

### 3.5 主会话空闲触发流程（单聊特有）
```
1. MainSession 处理完批次，状态从 processing → idle
   ↓
2. 触发 onStatusChange 回调
   ↓
3. 检查 chatType === 'private'？
   ↓
4. 如果是，获取辅助队列中所有未投递消息（PENDING + DELAY）
   ↓
5. 如果有未投递消息，立即触发 AuxiliarySession.process(messages, 'main-idle')
   ↓
6. 辅助会话重新判断：
   - DELAY 状态的消息：通常会变为 TRANSFER（不再需要延迟）
   - PENDING 状态的消息：立即判断
   ↓
7. 投递到主队列，主会话继续处理
```

**效果**：
- 降低单聊场景下的响应延迟
- 延迟投递在主会话空闲后立即重新判断

### 3.6 错误处理流程

```
1. 主会话或辅助会话调用 base agent 失败
   ↓
2. 重试 3 次（退避时间：5秒、10秒、30秒）
   - 每次重试前通知用户："API 不可用，X秒后重试 Y/3"
   - 重试期间检查中断（新消息可打断重试）
   ↓
3. 重试失败后：
   - 记录健康状态（recordError）
   - 消息回退到来源队列：
     * 辅助会话失败 → 回退到辅助队列
     * 主会话失败 → 回退到主队列
   - 标记消息：hasError: true, lastErrorTime, errorCount++
   - 向对端发送通知："抱歉，我遇到了技术问题，会在问题解决后继续处理"
   ↓
4. 重新提取批次：
   - 上次处理成功 → 可以提取带 hasError 的消息（重试）
   - 上次处理失败 → 跳过带 hasError 的消息，只提取正常消息
   ↓
5. 提取到错误消息时：
   - 在提示词中标注："⚠️ 处理失败（上次尝试：X，失败 Y 次）"
   - 提醒 base agent 这是需要重新处理的消息
   ↓
6. 处理结果：
   - 成功 → 消息从队列移除，清除 hasError 标记
   - 失败 → 重复步骤 2-5
```

**批次边界规则**：
- 遇到第一个带 `hasError` 标记的消息时截止（除非它是批次第一条）
- 错误消息不与正常消息混在同一批次
- **【群聊权限控制】群聊中，批次内所有消息的发送者角色（role）必须一致**
  - 角色包括：owner / admin / member / guest / anonymous
  - 遇到第一条角色不一致的消息时停止提取（该消息留在队列）
  - **原因**：Agent 处理批次时可能调用需要权限判断的命令（如 `ec config`），使用批次的统一角色（batchRole）进行权限判断
  - **安全性**：防止低权限用户的消息与高权限用户的消息合并处理，避免权限提升

**错误消息提取规则**：
```
场景 A：上次成功，可以重试错误消息
队列：[A(error), B(error)]
提取：[A(error), B(error)]

场景 B：上次失败，跳过错误消息
队列：[A(error), B(error), C, D]
提取：[C, D]

场景 C：所有消息都标记错误，且上次失败
队列：[A(error), B(error), C(error)]
提取：无法提取（等待新消息）
```

---

### 3.7 辅助会话失败降级流程

**兜底机制**：保证消息可达性，即使辅助会话不可用。

#### (1) HOLD 超时投递

```
HOLD 状态的消息
↓
检查 holdSince 字段
↓
超过 1 小时？
├─ 是 → 自动投递到主队列（不打断）
└─ 否 → 保持 HOLD 状态
```

**检查时机**：每次辅助会话处理时检查 HOLD 超时

#### (2) 辅助会话失败降级

```
辅助会话调用失败
↓
检查错误状态（errorState.isInError）
├─ 否（第一次失败）
│   ↓
│   退避重试 3 次（5秒、10秒、30秒）
│   ↓
│   重试成功？
│   ├─ 是 → 返回决策，清除错误状态
│   └─ 否 → 标记错误状态（isInError = true）
│           返回降级决策（delay 2分钟）
└─ 是（已处于错误状态）
    ↓
    直接返回降级决策（delay 2分钟，不重试）
    ↓
    尝试调用辅助会话
    ↓
    成功？
    ├─ 是 → 清除错误状态（isInError = false）
    └─ 否 → 保持错误状态
```

**降级决策**：
```typescript
{
  action: 'delay',
  delayLevel: 'medium',  // 2 分钟
  reason: '降级：辅助会话不可用，延迟 2 分钟后批量投递',
  fallbackMode: true,    // 标记为降级模式
}
```

**降级投递说明**：
```markdown
【批次投递说明】
投递原因：辅助会话模型调用失败，延迟 2 分钟后批量投递（5 条消息）

注意：由于辅助会话暂时不可用，这些消息没有经过相关性判断，可能包含与你无关的消息。请自行判断是否需要响应。
```

**优势**：
- ✅ 消息可达性保证（不会因辅助会话失败而丢失）
- ✅ 批量处理降低 token 消耗（2 分钟内消息累积）
- ✅ 系统鲁棒性（辅助会话挂了主会话仍能工作）
- ✅ 自动恢复（辅助会话恢复后清除错误状态）

---

### 3.8 群聊批次角色权限一致性

**问题背景**：

在群聊场景中，Agent 处理消息批次时可能会调用需要权限判断的命令（如 `ec config set`）。这些命令通过 PreToolUse Hook 获取当前会话的 `batchRole` 进行权限判断。

如果一个批次包含不同角色的发送者（如 owner 和 guest），会导致权限判断不明确：
- 使用 owner 的权限？→ 会让 guest 的消息"借用"owner 权限（权限提升）
- 使用 guest 的权限？→ 会导致 owner 的合法操作被拒绝
- 使用最高权限？→ 同样存在权限提升风险

**解决方案：批次角色一致性约束**

#### 实现机制

**1. 角色层级**
```typescript
const roleRank = {
  anonymous: 0,
  guest: 1,
  member: 2,
  admin: 3,
  owner: 4,
};
```

**2. 批次提取时检查**

辅助队列（AuxiliaryQueue）和主队列（MainQueue）在提取批次时：

```typescript
// 群聊模式
if (chatType === 'group') {
  let batchRole: string | undefined;
  
  for (const message of queue) {
    if (batch.length === 0) {
      batchRole = message.role;  // 第一条消息的角色
      batch.push(message);
    } else if (message.role === batchRole) {
      batch.push(message);  // 角色相同，继续
    } else {
      break;  // 角色不同，停止提取
    }
  }
}
```

**3. batchRole 计算**

消息队列在合并批次时计算 `batchRole`：

```typescript
function commonRole(messages: Message[]): string | undefined {
  let role: string | undefined;
  for (const msg of messages) {
    if (!msg.role) return undefined;  // 有未知角色
    if (!role) {
      role = msg.role;
    } else if (role !== msg.role) {
      return undefined;  // 角色不一致
    }
  }
  return role;  // 所有消息角色一致
}
```

**4. 权限判断使用 batchRole**

PreToolUse Hook 中：
```typescript
const session = sessionManager.getActiveSession(sessionId);
const role = message.batchRole || session.identity?.role || 'anonymous';

// 基础设施字段：只有 owner 能改
if (isInfrastructureField(field) && role !== 'owner') {
  return { decision: 'block', reason: '仅 owner 可修改基础设施配置' };
}

// 运行时配置字段：owner 和 admin 能改
if (isRuntimeConfigField(field) && role !== 'owner' && role !== 'admin') {
  return { decision: 'block', reason: '需要 admin 以上权限' };
}
```

#### 权限矩阵

| 批次场景 | batchRole | 基础设施字段 | 运行时配置字段 |
|---------|-----------|-------------|---------------|
| 全部 owner | owner | ✅ 允许 | ✅ 允许 |
| 全部 admin | admin | ❌ 拒绝 | ✅ 允许 |
| 全部 guest | guest | ❌ 拒绝 | ❌ 拒绝 |
| **混合角色** | undefined | ❌ 拒绝 | ❌ 拒绝 |

**关键**：混合角色批次的 `batchRole` 为 `undefined`，所有需要权限的操作都被拒绝。

#### 场景示例

**场景 A：角色一致（正常）**
```
队列：
  - 消息 A（Alice, owner）："帮我统计数据"
  - 消息 B（Alice, owner）："顺便改个配置"
  - 消息 C（Alice, owner）："谢谢"

提取批次：[A, B, C]
batchRole: owner
权限判断：✅ owner 可以修改配置
```

**场景 B：角色混合（安全拒绝）**
```
队列：
  - 消息 A（Alice, owner）："帮我统计数据"
  - 消息 B（Bob, guest）："顺便改个配置"
  - 消息 C（Charlie, admin）："检查状态"

提取批次 1：[A]（只提取 Alice）
batchRole: owner
权限判断：✅ owner 可以修改配置

提取批次 2：[B]（只提取 Bob）
batchRole: guest
权限判断：❌ guest 不能修改配置
```

**场景 C：角色交替**
```
队列：
  - 消息 1（owner）
  - 消息 2（guest）
  - 消息 3（owner）
  - 消息 4（owner）

提取批次 1：[消息 1]
提取批次 2：[消息 2]
提取批次 3：[消息 3, 消息 4]
```

#### 优势

- ✅ **防止权限提升**：低权限用户无法"搭便车"借用高权限
- ✅ **保守安全**：混合角色批次拒绝敏感操作
- ✅ **批次完整性**：相同角色的消息合并处理，符合语义
- ✅ **审计清晰**：每个批次有明确的权限上下文

#### 实现位置

- **文档**：`docs/response-system/dual-session-lite/architecture.md`（本文档）
- **代码**：
  - `src/core/message/message-queue.ts` - `commonRole()` 计算
  - `src/agents/claude-runner.ts` - PreToolUse Hook 权限判断
  - `src/core/command/ec-command-permission.ts` - ec 命令权限控制

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
        │   - 主会话在 turn 内通过 CLI 发送回复 │
        │   - 输出自然语言总结            │
        └────────────┬───────────────────┘
                     ↓
        代码层组装 MainFeedback (summary + replies)
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

MainQueue
  ↓ 依赖
  MainSession

MainSession
  ↓ 依赖
  - AuxiliarySession（通知反馈）
```

---

## 六、与现有机制的集成

### 6.1 与 mention 机制的集成

**核心原则**：mention 模式作为配置参数，决定是否启用 mention 快速通道。

#### 配置方式

```typescript
interface DualSessionConfig {
  // ... 其他配置
  mentionMode: 'disabled' | 'fast-track';  // 默认 'disabled'
}
```

#### 两种模式

**disabled（默认）**：
- 所有群消息进入辅助队列
- 由辅助会话判断相关性（hold / delay / transfer）
- 保留 `isMentioned` 标记，在提示词中提示相关性

**fast-track（提及模式）**：
- 被 @ 的消息**直接投递到主队列并打断**
- 跳过辅助会话判断
- 未被 @ 的消息进入辅助队列，由辅助会话判断

#### 实施细节

**代码位置**：`src/adapters/aun.ts` 的群消息处理逻辑

**当前实现**（行号 1606-1616）：
```typescript
const enforceMention = dispatchMode === 'mention' || isCommandMsg;
const isMentioned = mentionedSelf || mentionedAll;

if (enforceMention && !isMentioned) {
  this.acknowledgeImmediately(messageId, seq);
  logger.info(`Group dropped: unmentioned`);
  return;  // 消息不进入系统
}
```

**修改方案**：

**步骤 1：删除旧逻辑**
- 删除 `aun.ts:1606-1616` 的 mention 过滤逻辑
- 删除 `dispatchMode` 参数（已废弃）

**步骤 2：增加 mention 快速通道**
```typescript
// 在消息入队前检查 mention 快速通道
const config = this.dualSessionConfig;
const isMentioned = mentionedSelf || mentionedAll;

if (config.mentionMode === 'fast-track' && isMentioned) {
  // 快速通道：直接投递到主队列并打断
  logger.info(`Group message fast-track (mentioned)`, { messageId });
  
  // 跳过辅助队列，直接投递
  await mainQueue.interrupt([message], {
    reason: '被 @ 提及，快速通道',
    source: 'mention-fast-track'
  });
  
  return;
}

// 其他消息进入辅助队列
await auxiliaryQueue.enqueue(message);
```

**步骤 3：保留 isMentioned 标记**
```typescript
interface Message {
  // ... 其他字段
  isMentioned?: boolean;  // 是否 @ 本 agent
}

// 在构造 Message 时设置
const message: Message = {
  // ...
  isMentioned: mentionedSelf || mentionedAll,
};
```

**步骤 4：提示词中使用 isMentioned**

辅助会话提示词中增加：
```markdown
**消息相关性提示**：
- 如果消息被标记为 `isMentioned: true`，说明 Owner 或其他人 @ 了本 agent
- 被 @ 的消息通常相关性较高，应优先考虑 transfer
```

主会话提示词中增加：
```markdown
**优先级提示**：
- 批次中被 @ 的消息（`isMentioned: true`）通常需要优先回复
```

#### 配置示例

**全局配置**（`$AGENT_DIR/config.json`）：
```json
{
  "responseMode": "dual-session-lite",
  "dualSessionConfig": {
    "mentionMode": "disabled"  // 默认关闭快速通道
  }
}
```

**关系级配置**（`$RELATIONS_DIR/<peerKey>/config.json`）：
```json
{
  "dualSessionConfig": {
    "mentionMode": "fast-track"  // 该群启用快速通道
  }
}
```

#### 行为对比

| 场景 | disabled 模式 | fast-track 模式 |
|------|--------------|----------------|
| @ 本 agent 的消息 | 进入辅助队列 → 辅助会话判断 | **直接投递主队列 + 打断** |
| 未 @ 的消息 | 进入辅助队列 → 辅助会话判断 | 进入辅助队列 → 辅助会话判断 |
| 响应延迟 | 3-63 秒（防抖 + 随机） | **< 1 秒**（跳过辅助队列） |
| 适用场景 | 多 agent 群聊，需要智能判断 | Owner 主导的群聊，@ 即响应 |

#### 兼容性说明

- **向后兼容**：默认 `mentionMode: disabled`，行为与设计文档一致
- **灵活切换**：可按关系/环境级配置，支持不同群聊使用不同策略

---

## 七、扩展点

### 7.1 自定义触发条件
`AuxiliaryQueue` 的触发条件可配置化：
```typescript
interface TriggerConfig {
  debounceMs: number;
  maxWaitMs: number;
  maxSize: number;
  customRules?: ((queue: AuxiliaryQueue) => boolean)[];
}
```

### 7.2 自定义模型
辅助/主会话的模型可配置：
```typescript
interface SessionConfig {
  auxiliaryModel: string;  // deepseek-v4-flash / claude-haiku
  mainModel: string;       // claude-opus / claude-sonnet
}
```

---

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**维护者**: EvolClaw 团队
