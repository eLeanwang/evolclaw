# 双会话响应模式 - 消息处理流程

## 文档说明

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**关联**: [README.md](./README.md) | [架构设计](./architecture.md)

---

## 一、完整流程图

```
┌─────────────────────────────────────────────────────────────┐
│                    AUN 消息到达                              │
└────────────────────────┬────────────────────────────────────┘
                         ↓
        [阶段 1] 消息入队
        ┌────────────────────────────────┐
        │   AuxiliaryQueue.enqueue()     │
        │   - 标记 PENDING               │
        │   - 重置防抖定时器（3秒）       │
        │   - 检查强制触发条件            │
        └────────────┬───────────────────┘
                     ↓
        触发条件（满足任一）：
          ✓ 防抖 3 秒
          ✓ 最早消息 15 秒
          ✓ 队列满 50 条
          ✓ 延迟投递超时
          ✓ 主会话反馈到达
                     ↓
        [阶段 2] 辅助会话判断
        ┌────────────────────────────────┐
        │   AuxiliarySession.process()   │
        │   - 提取批次（≤50条 or 10k）   │
        │   - 构建输入                    │
        │   - 调用辅助会话模型            │
        │   - 解析输出                    │
        └────────────┬───────────────────┘
                     ↓
        输出决策（3种）
                     ↓
        ┌────────────┴────────────┬─────────────┐
        ↓                         ↓             ↓
    ┌────────┐              ┌─────────┐    ┌──────────┐
    │  hold  │              │  delay  │    │ transfer │
    └───┬────┘              └────┬────┘    └────┬─────┘
        ↓                        ↓              ↓
    更新状态: HOLD          更新状态: DELAY   interrupt?
    继续等待              设置延迟定时器        ↓
                        (3s + 0-60s随机)   yes / no
                                              ↓
        [阶段 3] 投递到主队列
        ┌────────────────────────────────┐
        │   MainQueue.append()           │  ← no
        │   或                            │
        │   MainQueue.interrupt()        │  ← yes
        └────────────┬───────────────────┘
                     ↓
        打断检查（如果 interrupt=yes）：
          - 主会话正在处理？
          - 当前批次 < 50 条？
                     ↓
                  打断成功
                     ↓
        ┌────────────────────────────────┐
        │   MainSession.interrupt()      │
        │   - 停止当前处理                │
        │   - 标记 idle                   │
        └────────────┬───────────────────┘
                     ↓
        新消息追加到主队列末尾
                     ↓
        重新提取批次（≤50条）
                     ↓
        [阶段 4] 主会话处理
        ┌────────────────────────────────┐
        │   MainSession.process(batch)   │
        │   - 构建输入                    │
        │   - 调用主会话模型              │
        │   - 生成回复                    │
        └────────────┬───────────────────┘
                     ↓
        [阶段 5] 发送回复
        ┌────────────────────────────────┐
        │   ec msg send ...              │
        │   (通过 CLI 发送)               │
        └────────────┬───────────────────┘
                     ↓
        [阶段 6] 生成总结
        ┌────────────────────────────────┐
        │   MainSession.generateSummary()│
        │   - 处理了哪些消息              │
        │   - 回复了什么                  │
        │   - 哪些消息已过期              │
        └────────────┬───────────────────┘
                     ↓
        [阶段 7] 追加反馈
        ┌────────────────────────────────┐
        │   FeedbackStore.append()       │
        │   - 写入 main-feedback.jsonl   │
        └────────────┬───────────────────┘
                     ↓
        [阶段 8] 通知辅助会话
        ┌────────────────────────────────┐
        │   AuxiliarySession             │
        │     .processFeedback()         │
        │   - 更新上下文                  │
        │   - 移除已处理消息              │
        │   - 输出 ack                    │
        └────────────┬───────────────────┘
                     ↓
        [阶段 9] 继续或空闲
        ┌────────────────────────────────┐
        │   MainQueue.completeBatch()    │
        │   - 检查队列是否还有消息        │
        │   - 有 → 继续处理               │
        │   - 无 → 标记空闲               │
        └────────────────────────────────┘
```

---

## 二、关键流程详解

### 2.1 消息入队与触发

#### 流程
```typescript
// 1. 消息到达
const message = await channel.receive();

// 2. 入队
auxiliaryQueue.enqueue(message);

// 3. 重置防抖定时器
if (debounceTimer) {
  clearTimeout(debounceTimer);
}
debounceTimer = setTimeout(() => {
  triggerAuxiliary('debounce');
}, 3000);

// 4. 检查强制触发
if (auxiliaryQueue.size() >= 50) {
  clearTimeout(debounceTimer);
  triggerAuxiliary('queue-full');
}

// 5. 定期检查最早消息超时
setInterval(() => {
  const oldest = auxiliaryQueue.getOldestPending();
  if (oldest && Date.now() - oldest.enqueuedAt > 15000) {
    clearTimeout(debounceTimer);
    triggerAuxiliary('max-wait');
  }
}, 1000);
```

#### 触发条件优先级
```
1. 队列满（50条）→ 立即触发（最高优先级）
2. 最早消息超时（15秒）→ 立即触发
3. 防抖超时（3秒）→ 正常触发
4. 延迟投递超时 → 按延迟时间触发
5. 主会话反馈到达 → 立即触发
```

---

### 2.2 辅助会话判断流程

#### 流程
```typescript
async function processAuxiliaryBatch(trigger: TriggerReason) {
  // 1. 提取批次
  const batch = auxiliaryQueue.extractBatch(50, 10240);
  
  // 2. 获取所有未投递消息
  const allUndelivered = auxiliaryQueue.getAllUndelivered();
  
  // 3. 构建输入
  const input: AuxiliaryInput = {
    type: 'aun-messages',
    aunMessages: {
      queue: allUndelivered,
      newMessages: batch,
    },
    mainSession: {
      status: mainSession.getStatus(),
      currentBatchSize: mainSession.getCurrentBatchSize(),
      queueSize: mainQueue.size(),
    },
  };
  
  // 4. 调用辅助会话模型
  const output = await auxiliarySession.callModel(input);
  
  // 5. 执行决策
  await executeDecision(output);
}
```

#### 决策执行
```typescript
async function executeDecision(output: AuxiliaryOutput) {
  const { action, delayMs, interrupt, reason } = output.decision;
  
  if (action === 'hold') {
    // 更新所有未投递消息为 HOLD
    for (const msg of allUndelivered) {
      auxiliaryQueue.updateState(msg.id, MessageState.HOLD);
    }
    
    logger.info('[Auxiliary] Hold', { reason });
  }
  
  else if (action === 'delay') {
    // 计算延迟时间（基础 + 随机）
    const baseDelay = delayMs || 3000;
    const randomDelay = Math.random() * 60000;
    const totalDelay = baseDelay + randomDelay;
    const transferAt = new Date(Date.now() + totalDelay);
    
    // 更新状态
    for (const msg of allUndelivered) {
      auxiliaryQueue.updateState(msg.id, MessageState.DELAY, transferAt);
    }
    
    // 设置延迟定时器
    setTimeout(() => {
      triggerAuxiliary('delay-timeout');
    }, totalDelay);
    
    logger.info('[Auxiliary] Delay', { 
      baseDelay, 
      randomDelay, 
      totalDelay, 
      reason 
    });
  }
  
  else if (action === 'transfer') {
    // 投递到主队列
    const messages = allUndelivered.map(qm => qm.message);
    
    if (interrupt) {
      await mainQueue.interrupt(messages);
      logger.info('[Auxiliary] Transfer with interrupt', { 
        count: messages.length, 
        reason 
      });
    } else {
      await mainQueue.append(messages);
      logger.info('[Auxiliary] Transfer', { 
        count: messages.length, 
        reason 
      });
    }
    
    // 更新状态
    for (const msg of messages) {
      auxiliaryQueue.updateState(msg.id, MessageState.TRANSFERRED);
    }
  }
}
```

---

### 2.3 主队列投递流程

#### append（追加）
```typescript
async function append(messages: Message[]) {
  mainQueue.push(...messages);
  
  logger.info('[MainQueue] Append', { 
    count: messages.length,
    queueSize: mainQueue.length 
  });
  
  // 如果主会话空闲，立即处理
  if (mainSession.isIdle()) {
    await triggerMainSession();
  }
}
```

#### interrupt（打断）
```typescript
async function interrupt(messages: Message[]) {
  // 检查是否应该打断
  if (!mainSession.isProcessing()) {
    logger.info('[MainQueue] Skip interrupt (main idle), append instead');
    return await append(messages);
  }
  
  if (mainSession.getCurrentBatchSize() >= 50) {
    logger.info('[MainQueue] Skip interrupt (batch full), append instead');
    return await append(messages);
  }
  
  // 打断主会话
  logger.info('[MainQueue] Interrupt', { 
    currentBatch: mainSession.getCurrentBatchSize(),
    newMessages: messages.length 
  });
  
  await mainSession.interrupt();
  
  // 新消息追加到队列末尾
  mainQueue.push(...messages);
  
  // 重新触发处理
  await triggerMainSession();
}
```

---

### 2.4 主会话处理流程

#### 批次处理
```typescript
async function processMainBatch(batch: Message[]) {
  mainSession.status = 'processing';
  mainSession.currentBatch = batch;
  
  logger.info('[MainSession] Processing batch', { 
    count: batch.length 
  });
  
  // 1. 构建输入
  const prompt = buildMainPrompt(batch);
  
  // 2. 调用主会话模型
  const response = await callMainModel(prompt);
  
  // 3. 解析响应
  const parsed = parseMainResponse(response);
  
  // 4. 发送回复（通过 CLI）
  for (const reply of parsed.replies) {
    await bash(`ec msg send ${selfAid} ${peerId} "${reply}"`);
  }
  
  logger.info('[MainSession] Sent replies', { 
    count: parsed.replies.length 
  });
  
  // 5. 生成总结
  const summary: MainFeedback = {
    batchId: generateId(),
    processedAt: new Date().toISOString(),
    processedMessageIds: batch.map(m => m.id),
    summary: parsed.summary,
    replies: parsed.replies,
  };
  
  // 6. 追加反馈
  await feedbackStore.append(summary);
  
  // 7. 通知辅助会话
  await auxiliarySession.processFeedback(summary);
  
  // 8. 标记完成
  mainQueue.completeBatch();
  mainSession.status = 'idle';
  mainSession.currentBatch = [];
  
  logger.info('[MainSession] Batch complete');
}
```

---

### 2.5 反馈处理流程

#### 主会话反馈
```typescript
async function processFeedback(feedback: MainFeedback) {
  logger.info('[Auxiliary] Received feedback', { 
    batchId: feedback.batchId,
    processedCount: feedback.processedMessageIds.length 
  });
  
  // 1. 构建输入
  const input: AuxiliaryInput = {
    type: 'main-feedback',
    mainFeedback: feedback,
    mainSession: {
      status: mainSession.getStatus(),
      queueSize: mainQueue.size(),
    },
  };
  
  // 2. 调用辅助会话模型
  const output = await auxiliarySession.callModel(input);
  
  // 3. 更新上下文
  auxiliarySession.context.append(`
[主会话反馈 ${feedback.batchId}]
已处理消息：${feedback.processedMessageIds.join(', ')}
总结：${feedback.summary}
回复：${feedback.replies.join(' / ')}
`);
  
  // 4. 从辅助队列移除已处理消息
  auxiliaryQueue.remove(feedback.processedMessageIds);
  
  logger.info('[Auxiliary] Feedback processed', { 
    ackReason: output.ack.reason 
  });
}
```

---

## 三、典型场景流程

### 3.1 场景：分段输入

```
时间轴：
  T0: 消息 "这个报错" 到达
      → 入队（PENDING）
      → 启动防抖 3 秒
  
  T2: 消息 [截图] 到达
      → 入队（PENDING）
      → 重置防抖 3 秒
  
  T5: 消息 "怎么解决？" 到达
      → 入队（PENDING）
      → 重置防抖 3 秒
  
  T8: 防抖超时，触发辅助会话
      → 提取 3 条消息
      → 判断：transfer（分段输入已完整）
      → 投递到主队列
  
  T8.5: 主会话处理
      → 批次：3 条消息
      → 生成回复："这个报错是因为..."
      → 发送回复
      → 生成总结
      → 反馈辅助会话
  
  T9: 辅助会话收到反馈
      → 更新上下文
      → 移除已处理消息
```

---

### 3.2 场景：多 agent 竞争回复

```
时间轴：
  T0: Owner 消息 "这个问题怎么解决？" 到达
      
      Agent1:
        → 入队（PENDING）
        → 启动防抖 3 秒
      
      Agent2:
        → 入队（PENDING）
        → 启动防抖 3 秒
      
      Agent3:
        → 入队（PENDING）
        → 启动防抖 3 秒
  
  T3: Agent1/2/3 防抖超时，触发辅助会话
      
      Agent1:
        → 判断：delay 3000 + 随机 12000 = 15000ms
      
      Agent2:
        → 判断：delay 3000 + 随机 5000 = 8000ms   ← 最短
      
      Agent3:
        → 判断：delay 3000 + 随机 28000 = 31000ms
  
  T11 (T3+8s): Agent2 延迟超时，触发辅助会话
      → 判断：transfer（仍无其他回复）
      → 投递到主队列
      → 主会话处理并回复
  
  T12: Agent2 回复消息到达
      
      Agent1 辅助队列：
        → 收到新消息（Agent2 的回复）
        → 触发辅助会话（新消息到达）
        → 重新判断所有未投递消息
        → 判断：hold（Agent2 已回复，无需重复）
      
      Agent3 辅助队列：
        → 同 Agent1
```

---

### 3.3 场景：紧急打断

```
时间轴：
  T0: 正常消息 A 到达
      → 投递到主队列
      → 主会话开始处理 A（预计需要 5 分钟）
  
  T2: 紧急消息 "生产环境崩了！" 到达
      → 入队（PENDING）
      → 检测到紧急关键词，立即触发辅助会话
  
  T2.5: 辅助会话判断
      → 判断：transfer + interrupt（紧急消息）
      → 调用 mainQueue.interrupt()
  
  T2.6: 主队列打断
      → 检查：主会话正在处理？是（A）
      → 检查：当前批次 < 50？是（1 条）
      → 执行打断：mainSession.interrupt()
  
  T2.7: 主会话被打断
      → 停止处理 A（A 已在上下文）
      → 标记 idle
  
  T2.8: 主队列重新提取批次
      → 提取：主队列中的消息 B, C + 新投递的紧急消息
      → 批次：[B, C, 紧急消息]
  
  T2.9: 主会话处理新批次
      → 上下文中有 A
      → 新批次：[B, C, 紧急消息]
      → 判断：紧急消息优先，A/B/C 可稍后
      → 回复紧急消息
      → 生成总结
      → 反馈辅助会话
```

---

### 3.4 场景：延迟期间重新判断

```
时间轴：
  T0: 消息 "这个问题怎么解决？" 到达（未@agent）
      → 判断：delay 3000 + 随机 10000 = 13000ms
  
  T5: 另一个 agent 回复了该问题
      → 新消息到达
      → 触发辅助会话（新消息到达）
      → 重新判断所有未投递消息
      → 看到已有 agent 回复
      → 判断：hold（无需重复回复）
      → 取消延迟定时器
```

---

## 四、异常流程处理

### 4.1 辅助会话调用失败

```typescript
try {
  const output = await auxiliarySession.callModel(input);
  await executeDecision(output);
} catch (error) {
  logger.error('[Auxiliary] Call failed', { error });
  
  // 兜底策略：延迟 10 秒后重试
  setTimeout(() => {
    triggerAuxiliary('retry');
  }, 10000);
}
```

### 4.2 主会话调用失败

```typescript
try {
  const response = await mainSession.callModel(batch);
  await sendReplies(response.replies);
} catch (error) {
  logger.error('[MainSession] Call failed', { error });
  
  // 兜底策略：标记批次失败，继续处理队列
  mainQueue.completeBatch();
  mainSession.status = 'idle';
  
  // 记录失败反馈
  await feedbackStore.append({
    batchId: generateId(),
    processedAt: new Date().toISOString(),
    processedMessageIds: batch.map(m => m.id),
    summary: `处理失败：${error.message}`,
    replies: [],
  });
}
```

### 4.3 发送回复失败

```typescript
for (const reply of replies) {
  try {
    await bash(`ec msg send ${selfAid} ${peerId} "${reply}"`);
  } catch (error) {
    logger.error('[MainSession] Send failed', { reply, error });
    
    // 记录失败，但继续发送其他回复
    failedReplies.push({ reply, error: error.message });
  }
}

// 在总结中记录失败的回复
summary.failedReplies = failedReplies;
```

---

## 五、性能优化

### 5.1 批量处理
- 辅助会话：每批最多 50 条或 10k 字节
- 主会话：每批最多 50 条

### 5.2 并行处理
- 辅助队列和主队列独立运行
- 辅助会话空闲时可立即处理新消息
- 主会话处理时不阻塞辅助会话

### 5.3 延迟随机化
- 避免多 agent 同时触发
- 基础延迟 + 0-60 秒随机

### 5.4 打断条件优化
- 满批次不打断（避免无效打断）
- 主会话空闲时不打断（直接追加）

---

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**维护者**: EvolClaw 团队
