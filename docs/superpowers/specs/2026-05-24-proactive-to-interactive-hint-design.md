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

**位置**：在 `_processMessageInternal()` 开始处，会话解析之后（约 1150 行）

**逻辑**：
```typescript
private async _processMessageInternal(
  message: Message,
  channelKey: string,
  projectPath?: string
): Promise<void> {
  // ... 现有会话解析逻辑 ...
  
  // 从 proactive 切换到 interactive 时注入提示
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

### 3.3 Metadata 持久化

`session.metadata` 对象已通过以下机制持久化：
- `SessionManager.updateSession()` → `writeSessionIfChanged()` → `appendMeta()` + `writeActive()`
- 存储位置：`{sessionsDir}/{channelType}/{channelId}/active.json` 和 `{sessionId}.jsonl`

无需额外的持久化逻辑。

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
1. **Proactive → Interactive 切换**：
   - 在 proactive 模式下发送带 `[PROACTIVE:REPLY_CONFIRMED_SENT]` 的消息
   - 切换到 interactive 模式
   - 发送新消息
   - 验证提示出现在 agent 输入中

2. **Proactive 中无标志位**：
   - 在 proactive 模式下发送不带标志位的消息
   - 切换到 interactive 模式
   - 发送新消息
   - 验证无提示出现

3. **多条 proactive 消息**：
   - 在 proactive 模式下发送 3 条带标志位的消息
   - 切换到 interactive 模式
   - 发送消息 → 验证提示出现
   - 再发送一条消息 → 验证提示不出现（标记已清除）

4. **重启持久化**：
   - 在 proactive 模式下设置标记
   - 重启 EvolClaw
   - 在 interactive 模式下发送消息
   - 验证提示出现

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

## 14. 附录

### 14.1 相关文档

- `proactive-mode-design.md` - 原始 proactive 模式设计（第 11 节：Agent 到 Agent 回复验证）
- `docs/multi-session-design.md` - 会话管理架构
- `docs/architecture.md` - 整体系统架构

### 14.2 术语表

- **Proactive 模式**：Agent 必须显式调用 `evolclaw ctl send` 发送消息
- **Interactive 模式**：Agent 的文本输出自动发送给用户
- **标志位**：特殊字符串（`[PROACTIVE:REPLY_CONFIRMED_*]`）指示 agent 的发送意图
- **标记**：布尔 metadata 字段，跟踪上一次会话中是否使用了标志位
- **提示**：注入的消息，通知 agent 模式切换

---

**文档版本**：1.0  
**最后更新**：2026-05-24  
**作者**：Claude（通过 brainstorming skill）  
**状态**：草稿 - 等待审查
