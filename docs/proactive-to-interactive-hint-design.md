# Proactive 到 Interactive 模式切换提示设计

## 1. 概述

### 1.1 问题

当会话从 proactive 模式切换到 interactive 模式时，agent 可能继续使用 proactive 通信模式（调用 `evolclaw ctl send`）而不是直接输出文本。这会导致混淆和消息发送失败。

### 1.2 解决方案

当 agent 进入 interactive 模式且之前使用过 proactive 模式标志位时，自动注入提示消息："本轮会话已切换为 interactive 模式，无需调用工具发送消息"。

### 1.3 适用范围

- **适用于**：所有支持 proactive 和 interactive 模式的通道（主要是 AUN）
- **不适用于**：从未使用过 proactive 模式的会话
- **触发条件**：Agent 在上一次 proactive 会话中使用了标志位（`[PROACTIVE:REPLY_CONFIRMED_SENT]` 或 `[PROACTIVE:REPLY_CONFIRMED_NONE]`）

---

## 2. 设计

### 2.1 核心机制

设计使用 metadata 标记来跟踪 agent 是否在上一次会话中使用了 proactive 标志位：

```
Proactive 模式（complete 事件）
  → 检测 lastReplyText 中的标志位
  → 设置 session.metadata.lastProactiveFlag = true
  → 持久化到文件系统

Interactive 模式（新消息到达）
  → 检查 session.metadata.lastProactiveFlag
  → 如果为 true：在 message.content 前插入提示
  → 立即清除标记
  → 持久化更新后的 metadata
```

### 2.2 标志位检测

系统检测 proactive 模式设计中定义的两个标志位：

| 标志位 | 含义 |
|--------|------|
| `[PROACTIVE:REPLY_CONFIRMED_SENT]` | Agent 调用工具发送了消息 |
| `[PROACTIVE:REPLY_CONFIRMED_NONE]` | Agent 确认无需回复 |

检测逻辑：
```typescript
const hasProactiveMarker = /\[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)\]/.test(lastReplyText);
```

### 2.3 标记生命周期

**设置标记**（proactive 模式）：
- 位置：`message-processor.ts`，`complete` 事件处理器
- 条件：`session.sessionMode === 'proactive'` 且在 `lastReplyText` 中检测到标志位
- 操作：`session.metadata.lastProactiveFlag = true` + `updateSession()`

**检查并清除标记**（interactive 模式）：
- 位置：`message-processor.ts`，`_processMessageInternal` 方法开始处
- 条件：`session.sessionMode === 'interactive'` 且 `session.metadata?.lastProactiveFlag === true`
- 操作：在 `message.content` 前插入提示，删除标记，`updateSession()`

### 2.4 提示消息

**中文**（默认）：
```
本轮会话已切换为 interactive 模式，无需调用工具发送消息。

[原始消息内容]
```

**设计理由**：
- 清晰直接的指令
- 位于用户消息之前，确保 agent 首先读到
- 单行空行分隔，提高可读性

---

## 3. 实现细节

### 3.1 标记设置（Proactive 模式）

**文件**：`src/core/message/message-processor.ts`

**位置**：在 `processEventStream()` 内部，`complete` 事件处理器中（约 1341-1374 行）

**逻辑**：
```typescript
if (event.type === 'complete') {
  // ... 现有逻辑 ...
  
  // 检测到 proactive 标志位时设置标记
  if (session.sessionMode === 'proactive' && lastReplyText) {
    const hasProactiveMarker = /\[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)\]/.test(lastReplyText);
    if (hasProactiveMarker) {
      session.metadata = session.metadata || {};
      session.metadata.lastProactiveFlag = true;
      await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
      logger.debug(`[MessageProcessor] Set lastProactiveFlag for session ${session.id}`);
    }
  }
  
  // ... 现有逻辑 ...
}
```

### 3.2 标记检查与提示注入（Interactive 模式）

**文件**：`src/core/message/message-processor.ts`

**位置**：在 `_processMessageInternal()` 中，**兜底纠正逻辑之后**（约 1142 行）

**关键要求**：必须在兜底纠正逻辑之后执行，确保 `sessionMode` 已经稳定。

**逻辑**：
```typescript
private async _processMessageInternal(
  message: Message,
  channelKey: string,
  projectPath?: string
): Promise<void> {
  // ... 现有会话解析逻辑 ...
  
  // 兜底纠正1：群聊强制 proactive
  if (message.chatType === 'group' && session.sessionMode !== 'proactive') {
    logger.info(`[MessageProcessor] group proactive upgrade: sessionId=${session.id} ${session.sessionMode} -> proactive`);
    session.sessionMode = 'proactive';
    await this.sessionManager.updateSession(session.id, { sessionMode: 'proactive' });
  }
  
  // 兜底纠正2：非 human peerType 升级为 proactive
  if (message.peerType && message.peerType !== 'human' && message.peerType !== 'unknown' && session.sessionMode !== 'proactive') {
    logger.info(`[MessageProcessor] proactive upgrade: sessionId=${session.id} ${session.sessionMode} -> proactive (peerType=${message.peerType})`);
    session.sessionMode = 'proactive';
    await this.sessionManager.updateSession(session.id, { sessionMode: 'proactive' });
  }
  
  // 【新增】从 proactive 切换到 interactive 时注入提示
  // 注意：必须在兜底纠正之后，确保 sessionMode 已稳定
  if (session.sessionMode === 'interactive' && session.metadata?.lastProactiveFlag) {
    const hint = '本轮会话已切换为 interactive 模式，无需调用工具发送消息。\n\n';
    message.content = hint + message.content;
    
    // 清除标记以避免重复提示
    delete session.metadata.lastProactiveFlag;
    await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
    logger.info(`[MessageProcessor] Injected interactive mode hint for session ${session.id}`);
  }
  
  // ... 方法其余部分 ...
}
```

**为什么在兜底纠正之后**：
1. 兜底纠正是强制性的（群聊必须 proactive，AI 对端必须 proactive）
2. 如果兜底纠正把模式改回 proactive，说明这个会话本来就不应该是 interactive
3. 提示注入应该基于最终确定的 sessionMode，避免无效注入

### 3.3 Metadata 持久化

`session.metadata` 对象已通过以下机制持久化：
- `SessionManager.updateSession()` → `writeSessionIfChanged()` → `appendMeta()` + `writeActive()`
- 存储位置：`{sessionsDir}/{channelType}/{channelId}/active.json` 和 `{sessionId}.jsonl`

无需额外的持久化逻辑。

### 3.4 消息内容修改的影响范围

提示注入通过直接修改 `message.content` 实现，影响范围分析：

| 影响点 | 是否受影响 | 说明 |
|--------|-----------|------|
| 消息日志（messages.jsonl） | ✅ 是 | 记录修改后的内容（包含提示），这是期望行为 |
| 命令检测 | ❌ 否 | 命令在 MessageBridge 中已拦截，不会到达此处 |
| Agent 输入 | ✅ 是 | Agent 看到的是修改后的内容（包含提示），这是核心功能 |
| 后续消息处理 | ❌ 否 | 提示注入在消息处理早期，不影响后续逻辑 |

**关键保证**：
- 提示注入在兜底纠正之后、Agent 调用之前
- 修改仅影响当前消息，不影响 session 状态（除了清除标记）
- 提示只出现一次（标记清除后不再注入）

---

## 4. 边界情况

### 4.1 Proactive 模式下的多条消息

**场景**：Agent 在切换到 interactive 之前在 proactive 模式下发送多条消息。

**行为**：标记在第一个带标志位的 `complete` 事件时设置。后续 `complete` 事件可能覆盖标记（幂等）。提示仅在切换到 interactive 时出现一次。

**结论**：可接受。提示在正确的时机出现（第一条 interactive 消息）。

### 4.2 无消息的手动模式切换

**场景**：用户在 proactive 模式下运行 `/chatmode interactive`，但在 proactive 模式下没有发送消息（无标志位）。

**行为**：未设置标记，不注入提示。

**结论**：可接受。如果 agent 从未使用过 proactive 标志位，则不需要提示。

### 4.3 会话重启

**场景**：EvolClaw 在 `lastProactiveFlag` 设置时重启。

**行为**：标记在 `active.json` 和 `.jsonl` 中持久化。重启后下一条 interactive 消息时会出现提示。

**结论**：正确行为。标记应该在重启后保留。

### 4.4 Autonomous 模式

**场景**：会话处于 autonomous 模式（触发任务）。

**行为**：Autonomous 会话不接收用户消息，因此永远不会到达提示注入代码路径。

**结论**：无影响。Autonomous 模式不受影响。

### 4.5 与 Agent-to-Agent 纠错重试的交互

**背景**：Agent-to-Agent 纠错重试机制（见第 14 节）也检测相同的标志位。

**交互分析**：

| 功能 | 激活条件 | 执行时机 | 操作 |
|------|---------|---------|------|
| 纠错重试 | proactive + AI 对端 | complete 事件后 | 检测标志位 → 验证发送 → 可能重试 |
| 模式切换提示 | interactive 模式 | 新消息到达时 | 检测标记 → 注入提示 → 清除标记 |

**互不干扰的保证**：
1. **模式互斥**：纠错重试在 proactive 模式，提示注入在 interactive 模式
2. **时机不同**：纠错重试在 complete 事件，提示注入在新消息到达
3. **标记独立**：纠错重试检测 `lastReplyText`，提示注入检测 `metadata.lastProactiveFlag`

**执行顺序**（Proactive → Interactive 切换）：
```
Proactive 会话：
  1. Agent 输出（带标志位）
  2. complete 事件 → 纠错重试检测（如果是 AI 对端）
  3. complete 事件 → 设置 lastProactiveFlag

切换到 Interactive：
  4. 用户切换模式（/chatmode interactive）
  5. 新消息到达 → 检测 lastProactiveFlag → 注入提示 → 清除标记
```

**结论**：两个功能可以安全共存，标志位检测逻辑可以共享。

---

## 5. 测试策略

### 5.1 单元测试

**测试用例**：
1. 在 `complete` 事件中检测到 proactive 标志位时设置标记
2. 无标志位时不设置标记
3. 标记设置且模式为 interactive 时注入提示
4. 提示注入后清除标记
5. 标记不存在时不注入提示
6. proactive 或 autonomous 模式下不注入提示

**Mock 依赖**：
- `SessionManager.updateSession()`
- `session.metadata` 对象

### 5.2 集成测试

**测试场景**：

#### 场景 1：Proactive → Interactive 切换（带标志位）

**前置条件**：
- AUN 通道已连接
- Session 初始为 proactive 模式

**步骤**：
1. 在 proactive 模式下发送消息："你好"
2. Agent 回复包含 `[PROACTIVE:REPLY_CONFIRMED_SENT]`
3. 执行命令：`/chatmode interactive`
4. 发送新消息："继续"
5. 检查 agent 收到的输入

**预期结果**：
- Agent 收到的输入为："本轮会话已切换为 interactive 模式，无需调用工具发送消息。\n\n继续"
- 日志包含：`Injected interactive mode hint for session ...`

#### 场景 2：Proactive 中无标志位

**前置条件**：
- AUN 通道已连接
- Session 初始为 proactive 模式

**步骤**：
1. 在 proactive 模式下发送消息："你好"
2. Agent 回复**不包含**标志位（或包含 `[PROACTIVE:REPLY_CONFIRMED_NONE]`）
3. 执行命令：`/chatmode interactive`
4. 发送新消息："继续"
5. 检查 agent 收到的输入

**预期结果**：
- Agent 收到的输入为："继续"（无提示）
- 日志**不包含**：`Injected interactive mode hint`

#### 场景 3：多条 proactive 消息

**前置条件**：
- AUN 通道已连接
- Session 初始为 proactive 模式

**步骤**：
1. 发送消息 1："第一条" → Agent 回复（带标志位）
2. 发送消息 2："第二条" → Agent 回复（带标志位）
3. 发送消息 3："第三条" → Agent 回复（带标志位）
4. 执行命令：`/chatmode interactive`
5. 发送消息 4："第四条" → 检查输入（应有提示）
6. 发送消息 5："第五条" → 检查输入（应无提示）

**预期结果**：
- 消息 4：包含提示
- 消息 5：不包含提示（标记已清除）

#### 场景 4：重启持久化

**前置条件**：
- AUN 通道已连接
- Session 初始为 proactive 模式

**步骤**：
1. 在 proactive 模式下发送消息："你好" → Agent 回复（带标志位）
2. 验证 `active.json` 中 `metadata.lastProactiveFlag === true`
3. 执行：`evolclaw restart`
4. 等待重启完成
5. 执行命令：`/chatmode interactive`
6. 发送新消息："继续"
7. 检查 agent 收到的输入

**预期结果**：
- 重启后标记仍然存在
- Agent 收到的输入包含提示
- 日志包含：`Injected interactive mode hint`

#### 场景 5：兜底纠正优先级

**前置条件**：
- AUN 通道已连接
- Session 初始为 proactive 模式（群聊）

**步骤**：
1. 在 proactive 模式下发送消息（群聊）→ Agent 回复（带标志位）
2. 手动修改 session 为 interactive（模拟配置错误）
3. 发送新消息（群聊）
4. 检查 sessionMode 和是否注入提示

**预期结果**：
- 兜底纠正将 sessionMode 改回 proactive
- **不注入提示**（因为最终 sessionMode 是 proactive）
- 日志包含：`group proactive upgrade`

---

## 6. 性能影响

### 6.1 Proactive 模式

**每个 `complete` 事件新增操作**：
- 对 `lastReplyText` 进行正则测试（O(n)，n = 文本长度）
- 条件性 metadata 更新（仅在存在标志位时）

**影响**：可忽略。正则表达式很快，metadata 更新已是会话生命周期的一部分。

### 6.2 Interactive 模式

**每条消息新增操作**：
- 检查 `session.metadata?.lastProactiveFlag`（O(1)）
- 条件性字符串前置 + metadata 更新（仅在标记设置时）

**影响**：可忽略。标记检查是常数时间，提示注入每次模式切换最多发生一次。

---

## 7. 考虑的替代方案

### 7.1 每次检查 messages.jsonl

**方法**：每条 interactive 消息时，从 `messages.jsonl` 读取最后一条出站消息并检查标志位。

**优点**：无 metadata 依赖，始终检测标志位。

**缺点**：
- 每条消息都有文件 I/O（性能损失）
- 需要额外逻辑防止重复提示
- 实现更复杂

**结论**：拒绝。Metadata 标记方法更简单更快。

### 7.2 混合方案

**方法**：在 `complete` 事件中设置标记，并在使用 `/chatmode` 命令时检查 `messages.jsonl`。

**优点**：覆盖自动和手动模式切换。

**缺点**：
- 更复杂（两条代码路径）
- `/chatmode` 命令需要文件 I/O
- 边际收益（无先前消息的手动切换很少见）

**结论**：拒绝。增加的复杂性不能证明边界情况覆盖的合理性。

---

## 8. 未来增强

### 8.1 本地化

当前提示硬编码为中文。未来工作可以：
- 从会话 metadata 检测用户语言
- 提供英文/中文变体
- 使用 i18n 框架（如果可用）

### 8.2 可配置提示

允许用户通过 `evolclaw.json` 自定义提示消息：
```json
{
  "hints": {
    "proactiveToInteractive": "自定义提示消息"
  }
}
```

### 8.3 提示抑制

为高级用户添加会话级标志以禁用提示：
```typescript
session.metadata.suppressModeHints = true;
```

---

## 9. 修改的文件

| 文件 | 变更 |
|------|------|
| `src/core/message/message-processor.ts` | 在 `complete` 处理器中添加标记设置，在 `_processMessageInternal` 中添加提示注入 |
| `src/types.ts` | 记录 `Session.metadata.lastProactiveFlag` 字段（可选，为了清晰） |

---

## 10. 发布计划

### 10.1 开发

1. 在 `complete` 处理器中实现标记设置逻辑
2. 在 `_processMessageInternal` 中实现提示注入逻辑
3. 为两条代码路径添加单元测试
4. 使用 AUN 通道进行手动测试

### 10.2 测试

1. 运行单元测试：`npm test`
2. 集成测试：proactive → interactive 切换（带标志位）
3. 集成测试：proactive → interactive 切换（无标志位）
4. 集成测试：重启持久化
5. 回归测试：确保现有 proactive/interactive 行为不变

### 10.3 部署

1. 合并到 main 分支
2. 构建：`npm run build`
3. 部署到生产环境
4. 监控日志中的 `Injected interactive mode hint` 消息
5. 收集用户反馈

---

## 11. 成功指标

### 11.1 功能指标

- 检测到标志位时正确设置标记（日志分析）
- 提示在每次模式切换时恰好出现一次（日志分析）
- 无重复提示（日志分析）
- 无性能下降（响应时间监控）

### 11.2 用户体验指标

- 减少模式切换时的 agent 混淆（定性反馈）
- 减少 interactive 模式下失败的 `ctl send` 尝试（错误日志分析）

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Metadata 未正确持久化 | 重启后提示不出现 | 彻底测试重启持久化 |
| 正则表达式误报 | 不需要时出现提示 | 使用带 `PROACTIVE:` 前缀的特定标志位格式 |
| 提示污染对话 | 用户看到技术消息 | 保持提示简洁清晰；未来考虑抑制标志 |
| 性能影响 | 消息处理变慢 | 分析正则和 metadata 操作；如需要则优化 |

---

## 13. 文档更新

### 13.1 用户文档

更新 `docs/multi-session-design.md` 或等效文档以记录：
- 从 proactive 切换到 interactive 时的自动提示注入
- 提示消息内容和目的
- 如何解释提示（用于调试 agent 行为的用户）

### 13.2 开发者文档

更新 `docs/architecture.md` 或等效文档以记录：
- `session.metadata.lastProactiveFlag` 字段
- 标记生命周期（设置/检查/清除）
- `message-processor.ts` 中的集成点

---

## 14. 背景：Agent-to-Agent 回复校验机制

本节内容来自 `proactive-mode-design.md` 第 11 节，说明标志位的原始设计背景和用途。

### 14.1 背景

Proactive 模式下 Agent 与 Agent 对话时，LLM 容易用普通文本输出而非调用 `evolclaw ctl send`，导致消息实际未发出。

### 14.2 适用范围

仅在以下条件**同时满足**时激活，其他场景零侵入：
- `chatmode === 'proactive'`
- `peerType === 'ai' | 'assistant'`

Interactive 模式不适用（Agent 输出直接呈现给用户，注入标志位会污染对话内容）。

### 14.3 标志位定义

通过系统提示词要求 Agent 在回复中包含以下两个标志位之一（无位置限制）：

| 标志位 | 含义 |
|--------|------|
| `[PROACTIVE:REPLY_CONFIRMED_SENT]` | 本轮已调用工具发送消息 |
| `[PROACTIVE:REPLY_CONFIRMED_NONE]` | 本轮确认无需回复 |

`PROACTIVE:` 前缀为项目专属，极低误命中概率。

### 14.4 Channel 后置校验逻辑

`complete` 事件触发后执行：

```
有 [PROACTIVE:REPLY_CONFIRMED_NONE] → 正常结束
有 [PROACTIVE:REPLY_CONFIRMED_SENT] → 验证本轮是否有成功的 ctl send tool_result
    ├─ 有 → 正常结束
    └─ 无 → 触发纠错重试（最多 2 次）
无标志位
    ├─ 本轮有成功 ctl send tool_result → 视为正常（Agent 发了但忘写标志位）
    └─ 本轮无 ctl send → 记录警告日志，不重试（保守处理，避免误触发）
```

### 14.5 纠错重试

- 最大重试次数：**2 次**，超出后记录日志放弃
- 重试注入 prompt：`"上一轮消息未实际发出，请重新调用工具发送"`（注入为新的 user message）
- 重试轮次的输出**不转发给对端**，仅用于 Channel 内部纠错

### 14.6 风险控制

| 风险 | 控制措施 |
|------|----------|
| 重复发送 | 只有"有 `REPLY_CONFIRMED_SENT` 但无成功 tool_result"才重试，条件严格 |
| 无限循环 | 最大 2 次硬限制 |
| 上下文污染 | 仅 Proactive + AI 对端时激活；Interactive 模式完全不触发 |
| 误命中标志位 | `PROACTIVE:` 专属前缀双重保护 |

### 14.7 与本设计的关系

本设计（Proactive-to-Interactive 模式切换提示）复用了相同的标志位机制：
- **标志位检测**：在 `complete` 事件中检测 `[PROACTIVE:REPLY_CONFIRMED_*]`
- **用途不同**：原设计用于纠错重试，本设计用于模式切换提示
- **互不干扰**：两个功能可以共存，标志位检测逻辑可以共享

---

## 15. 附录

### 15.1 相关文档

- `proactive-mode-design.md` - 原始 proactive 模式设计（第 11 节：Agent 到 Agent 回复验证）
- `docs/multi-session-design.md` - 会话管理架构
- `docs/architecture.md` - 整体系统架构

### 15.2 术语表

- **Proactive 模式**：Agent 必须显式调用 `evolclaw ctl send` 发送消息
- **Interactive 模式**：Agent 的文本输出自动发送给用户
- **标志位**：特殊字符串（`[PROACTIVE:REPLY_CONFIRMED_*]`）指示 agent 的发送意图
- **标记**：布尔 metadata 字段，跟踪上一次会话中是否使用了标志位
- **提示**：注入的消息，通知 agent 模式切换
- **纠错重试**：Agent-to-Agent 对话中，检测到标志位但未实际发送时的自动重试机制

---

**文档版本**：1.1  
**最后更新**：2026-05-24  
**作者**：Claude（通过 brainstorming skill）  
**状态**：草稿 - 等待审查
