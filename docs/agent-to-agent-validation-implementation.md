# Agent-to-Agent 回复校验机制功能实现文档

## 1. 文档信息

| 项目 | 内容 |
|------|------|
| 功能名称 | Agent-to-Agent 回复校验机制（纠错重试） |
| 设计文档 | `proactive-mode-design.md` 第 11 节 |
| 创建日期 | 2026-05-24 |
| 版本 | 1.0 |

---

## 2. 功能概述

### 2.1 问题

Proactive 模式下 Agent 与 Agent 对话时，LLM 容易用普通文本输出而非调用 `evolclaw ctl send`，导致消息实际未发出，对端收不到任何回复。

### 2.2 解决方案

通过系统提示词要求 Agent 在回复中包含标志位，`complete` 事件后执行后置校验：
- 有标志位 `REPLY_CONFIRMED_SENT` 但无成功 `ctl send` → 触发纠错重试
- 有标志位 `REPLY_CONFIRMED_NONE` → 正常结束
- 无标志位但有成功 `ctl send` → 视为正常
- 无标志位且无 `ctl send` → 记录警告，不重试

### 2.3 适用范围

仅在以下条件**同时满足**时激活：
- `session.sessionMode === 'proactive'`
- `message.peerType === 'ai' | 'assistant'`

---

## 3. 实现任务清单

### 3.1 代码修改

#### 任务 1：系统提示词注入标志位要求

**文件**：`src/core/message/message-processor.ts`

**位置**：`_processMessageInternal()` 中 `contextParts` 构建阶段（约 600-635 行）

**修改内容**：

```typescript
// 现有：proactive 模式提示词
if (session.sessionMode === 'proactive') {
  contextParts.push(PROACTIVE_MODE_PROMPT);
}

// 【新增】Agent-to-Agent 校验标志位要求
const isAgentPeer = message.peerType === 'ai' || message.peerType === 'assistant';
if (session.sessionMode === 'proactive' && isAgentPeer) {
  contextParts.push(PROACTIVE_AGENT_VALIDATION_PROMPT);
}
```

**新增常量**（在文件顶部或常量区）：

```typescript
const PROACTIVE_AGENT_VALIDATION_PROMPT = `[Agent 回复校验] 每轮回复结束时，必须在输出中包含以下标志位之一（位置不限）：
- 已调用工具发送消息：[PROACTIVE:REPLY_CONFIRMED_SENT]
- 确认本轮无需回复：[PROACTIVE:REPLY_CONFIRMED_NONE]
不包含标志位将触发系统纠错重试。`;
```

**预计工作量**：20 分钟

---

#### 任务 2：`processEventStream` 中追踪 ctl send 成功状态

**文件**：`src/core/message/message-processor.ts`

**位置**：`processEventStream()` 方法内部，`tool_result` 事件处理处（约 1298 行）

**修改内容**：

```typescript
// 在 processEventStream 顶部新增追踪变量
let hasSuccessfulCtlSend = false;  // 本轮是否有成功的 ctl send

// 在 tool_result 事件处理中追踪
if (event.type === 'tool_result') {
  eventDetail = ` tool=${event.name} ok=${!event.isError}`;
  
  // 【新增】追踪 ctl send 成功状态
  if (!event.isError && event.name === 'Bash') {
    // ctl send 通过 Bash 工具执行，检查 tool_use 的 command 是否包含 ctl send
    const callDesc = toolDescByCallId.get(event.callId ?? '');
    if (callDesc && /evolclaw ctl send/.test(callDesc)) {
      hasSuccessfulCtlSend = true;
    }
  }
  
  // ... 现有逻辑 ...
}
```

**同时修改 `processEventStream` 返回值**，增加 `hasSuccessfulCtlSend` 字段：

```typescript
// 返回值类型新增字段
return {
  isError: completeResult.isError,
  // ... 现有字段 ...
  hasSuccessfulCtlSend,  // 【新增】
};
```

**预计工作量**：45 分钟

---

#### 任务 3：`complete` 事件后置校验与纠错重试

**文件**：`src/core/message/message-processor.ts`

**位置**：`_processMessageInternal()` 中，`processEventStream` 调用之后（约 660 行）

**修改内容**：

```typescript
streamResult = await this.processEventStream(
  stream, session, renderer, resetTimer, shouldSuppress
);

// 【新增】Agent-to-Agent 后置校验（仅 proactive + AI 对端）
const isAgentPeer = message.peerType === 'ai' || message.peerType === 'assistant';
if (session.sessionMode === 'proactive' && isAgentPeer && !streamResult.isError) {
  const retryCount = (session.metadata?.proactiveRetryCount ?? 0) as number;
  const MAX_RETRIES = 2;
  
  const validationResult = this.validateProactiveReply(
    streamResult.lastReplyText,
    streamResult.hasSuccessfulCtlSend
  );
  
  if (validationResult === 'retry' && retryCount < MAX_RETRIES) {
    logger.warn(`[MessageProcessor] Proactive reply validation failed, retry ${retryCount + 1}/${MAX_RETRIES} session=${session.id}`);
    
    // 更新重试计数
    session.metadata = session.metadata || {};
    session.metadata.proactiveRetryCount = retryCount + 1;
    await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
    
    // 注入纠错 prompt，重新运行（输出不转发给对端）
    const retryStream = await agent.runQuery(
      session.id,
      '上一轮消息未实际发出，请重新调用工具发送',
      absoluteProjectPath,
      session.agentSessionId,
      undefined,
      effectiveSystemPrompt,
      this.sessionManager
    );
    agent.registerStream(streamKey, retryStream);
    
    // silent renderer：重试输出不转发给对端
    const silentRenderer = renderer.asSilent();
    streamResult = await this.processEventStream(
      retryStream, session, silentRenderer, resetTimer, shouldSuppress
    );
  } else if (validationResult === 'retry' && retryCount >= MAX_RETRIES) {
    logger.error(`[MessageProcessor] Proactive reply validation failed after ${MAX_RETRIES} retries, giving up session=${session.id}`);
  }
  
  // 重置重试计数（本轮处理完成）
  if (retryCount > 0) {
    session.metadata!.proactiveRetryCount = 0;
    await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
  }
}
```

**预计工作量**：1.5 小时

---

#### 任务 4：新增 `validateProactiveReply` 方法

**文件**：`src/core/message/message-processor.ts`

**位置**：`MessageProcessor` 类内部，私有方法区

**修改内容**：

```typescript
/**
 * 校验 proactive 模式下 Agent 的回复是否实际发出消息。
 * 
 * 返回值：
 * - 'ok'：正常结束
 * - 'retry'：需要纠错重试
 */
private validateProactiveReply(lastReplyText: string, hasSuccessfulCtlSend: boolean): 'ok' | 'retry' {
  const hasConfirmedSent = /\[PROACTIVE:REPLY_CONFIRMED_SENT\]/.test(lastReplyText);
  const hasConfirmedNone = /\[PROACTIVE:REPLY_CONFIRMED_NONE\]/.test(lastReplyText);
  
  if (hasConfirmedNone) {
    // Agent 确认无需回复，正常结束
    return 'ok';
  }
  
  if (hasConfirmedSent) {
    // Agent 声称已发送，验证是否有成功的 ctl send
    if (hasSuccessfulCtlSend) {
      return 'ok';
    }
    // 声称发送但无成功 tool_result → 触发重试
    logger.warn('[MessageProcessor] REPLY_CONFIRMED_SENT but no successful ctl send found');
    return 'retry';
  }
  
  // 无标志位
  if (hasSuccessfulCtlSend) {
    // Agent 发了但忘写标志位，视为正常
    logger.debug('[MessageProcessor] No proactive marker but ctl send succeeded, treating as ok');
    return 'ok';
  }
  
  // 无标志位且无 ctl send → 保守处理，记录警告不重试
  logger.warn('[MessageProcessor] No proactive marker and no ctl send, skipping retry (conservative)');
  return 'ok';
}
```

**预计工作量**：30 分钟

---

#### 任务 5：IMRenderer 增加 `asSilent()` 方法

**文件**：`src/core/message/im-renderer.ts`

**位置**：`IMRenderer` 类内部

**修改内容**：

```typescript
/**
 * 返回一个静默版本的 renderer，所有输出被丢弃（用于纠错重试轮次）。
 */
asSilent(): IMRenderer {
  return new IMRenderer({
    ...this.options,
    send: async () => {},  // 静默：丢弃所有输出
  });
}
```

**预计工作量**：20 分钟

---

#### 任务 6：`tool_use` 事件中记录 command 到 `toolDescByCallId`

**文件**：`src/core/message/message-processor.ts`

**位置**：`processEventStream()` 中 `tool_use` 事件处理处（约 1280-1295 行）

**修改内容**：

```typescript
if (event.type === 'tool_use') {
  const input = (event as any).input || {};
  const desc = summarizeToolInput(event.name, input);
  
  // 【新增】记录完整 command 到 callId 映射（用于 tool_result 中追踪 ctl send）
  if (event.callId && typeof input.command === 'string') {
    toolDescByCallId.set(event.callId, input.command);
  } else if (event.callId && desc) {
    toolDescByCallId.set(event.callId, desc);
  }
  
  // ... 现有逻辑 ...
}
```

**预计工作量**：20 分钟

---

### 3.2 测试

#### 任务 7：单元测试

**文件**：`tests/unit/message-processor-proactive-validation.test.ts`（新建）

**测试用例**：

```typescript
describe('validateProactiveReply', () => {
  it('REPLY_CONFIRMED_NONE → ok', () => {
    expect(validate('[PROACTIVE:REPLY_CONFIRMED_NONE]', false)).toBe('ok');
  });

  it('REPLY_CONFIRMED_SENT + 有成功 ctl send → ok', () => {
    expect(validate('[PROACTIVE:REPLY_CONFIRMED_SENT]', true)).toBe('ok');
  });

  it('REPLY_CONFIRMED_SENT + 无成功 ctl send → retry', () => {
    expect(validate('[PROACTIVE:REPLY_CONFIRMED_SENT]', false)).toBe('retry');
  });

  it('无标志位 + 有成功 ctl send → ok（保守）', () => {
    expect(validate('普通文本', true)).toBe('ok');
  });

  it('无标志位 + 无 ctl send → ok（保守，不重试）', () => {
    expect(validate('普通文本', false)).toBe('ok');
  });
});

describe('Retry count limit', () => {
  it('should retry at most 2 times', async () => {
    // Mock session with proactiveRetryCount = 2
    // Verify no more retries triggered
  });

  it('should reset retry count after successful completion', async () => {
    // Mock session with proactiveRetryCount = 1
    // Verify count reset to 0 after processing
  });
});
```

**预计工作量**：1.5 小时

---

#### 任务 8：集成测试

**场景 1：Agent 声称发送但未调用工具**

```bash
# 前置条件：proactive 模式，AI 对端

# Agent 回复包含 [PROACTIVE:REPLY_CONFIRMED_SENT] 但未调用 ctl send
# 验证：
# - 触发纠错重试（日志：Proactive reply validation failed, retry 1/2）
# - 重试输出不转发给对端
# - 重试后 Agent 正确调用 ctl send
```

**场景 2：Agent 正确调用工具**

```bash
# Agent 回复包含 [PROACTIVE:REPLY_CONFIRMED_SENT] 且成功调用 ctl send
# 验证：
# - 不触发重试
# - 消息正常发送给对端
```

**场景 3：Agent 确认无需回复**

```bash
# Agent 回复包含 [PROACTIVE:REPLY_CONFIRMED_NONE]
# 验证：
# - 不触发重试
# - 对端收不到消息（正常）
```

**场景 4：超过最大重试次数**

```bash
# Agent 连续 3 次声称发送但未调用工具
# 验证：
# - 重试 2 次后放弃
# - 日志：Proactive reply validation failed after 2 retries, giving up
# - 对端收不到消息（已尽力）
```

**场景 5：Interactive 模式不触发**

```bash
# interactive 模式，AI 对端
# Agent 回复不包含标志位
# 验证：
# - 不触发校验逻辑
# - 消息正常发送给对端
```

**预计工作量**：2 小时

---

## 4. 实施计划

### 4.1 开发阶段

| 阶段 | 任务 | 预计时间 | 依赖 |
|------|------|---------|------|
| 1 | 任务 4：`validateProactiveReply` 方法 | 30 分钟 | 无 |
| 2 | 任务 6：`tool_use` 记录 command | 20 分钟 | 无 |
| 3 | 任务 2：追踪 ctl send 成功状态 | 45 分钟 | 任务 6 |
| 4 | 任务 5：`IMRenderer.asSilent()` | 20 分钟 | 无 |
| 5 | 任务 1：系统提示词注入 | 20 分钟 | 无 |
| 6 | 任务 3：后置校验与纠错重试 | 1.5 小时 | 任务 2, 4, 5 |
| 7 | 任务 7：单元测试 | 1.5 小时 | 任务 4 |
| 8 | 任务 8：集成测试 | 2 小时 | 全部 |

**总预计时间**：7-8 小时

### 4.2 开发顺序

1. **第一步**：实现 `validateProactiveReply`（纯函数，最易测试）
2. **第二步**：实现 `tool_use` command 记录 + `tool_result` 追踪
3. **第三步**：实现 `IMRenderer.asSilent()`
4. **第四步**：实现系统提示词注入
5. **第五步**：实现后置校验与纠错重试（整合前四步）
6. **第六步**：编写测试

### 4.3 验收标准

- [ ] `validateProactiveReply` 单元测试全部通过
- [ ] 重试次数上限（2次）正确执行
- [ ] 重试输出不转发给对端
- [ ] Interactive 模式完全不触发
- [ ] 回归测试：现有 proactive/interactive 行为不变

---

## 5. 关键设计决策

### 5.1 ctl send 检测方式

**问题**：如何判断 `tool_result` 对应的是 `ctl send` 调用？

**方案**：在 `tool_use` 事件时，将 `callId → command` 存入 `toolDescByCallId`。`tool_result` 时通过 `callId` 查找对应 command，检查是否包含 `evolclaw ctl send`。

**理由**：
- `tool_use` 和 `tool_result` 通过 `callId` 关联
- `toolDescByCallId` 已存在，只需扩展存储内容

### 5.2 重试输出静默

**问题**：重试轮次的输出不能转发给对端。

**方案**：`IMRenderer.asSilent()` 返回一个 `send` 为空操作的 renderer，传入 `processEventStream`。

**理由**：
- 最小改动：只需修改 renderer 的 `send` 函数
- 不影响 `processEventStream` 的其他逻辑（session_id 提取、error 处理等）

### 5.3 重试计数持久化

**问题**：重试计数需要在 `processEventStream` 调用之间保持。

**方案**：存入 `session.metadata.proactiveRetryCount`，每次重试后更新，处理完成后重置为 0。

**理由**：
- 利用现有 metadata 持久化机制
- 重置为 0 确保下一轮消息不受影响

### 5.4 保守处理（无标志位 + 无 ctl send）

**问题**：Agent 既没有标志位也没有调用 ctl send，是否重试？

**方案**：不重试，只记录警告日志。

**理由**：
- 避免误触发（Agent 可能在处理中间状态）
- 设计文档明确要求"保守处理，避免误触发"

---

## 6. 风险与注意事项

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `callId` 为空 | 无法追踪 ctl send | 防御性检查，`callId` 为空时跳过追踪 |
| `asSilent()` 实现不完整 | 重试输出泄漏给对端 | 确保 `send` 函数完全静默 |
| 重试计数未重置 | 下一轮消息无法重试 | 处理完成后强制重置为 0 |
| 系统提示词过长 | 影响 token 消耗 | 提示词保持简洁（3行以内） |

---

## 7. 修改的文件

| 文件 | 变更 |
|------|------|
| `src/core/message/message-processor.ts` | 新增常量、追踪变量、后置校验逻辑、`validateProactiveReply` 方法 |
| `src/core/message/im-renderer.ts` | 新增 `asSilent()` 方法 |
| `tests/unit/message-processor-proactive-validation.test.ts` | 新建单元测试文件 |

---

**文档版本**：1.0  
**最后更新**：2026-05-24  
**状态**：待审查
