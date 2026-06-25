# Proactive-to-Interactive 模式切换提示功能实现文档

## 1. 文档信息

| 项目 | 内容 |
|------|------|
| 功能名称 | Proactive-to-Interactive 模式切换提示 |
| 设计文档 | `docs/proactive-to-interactive-hint-design.md` |
| 开发者 | Claude (via writing-plans skill) |
| 创建日期 | 2026-05-24 |
| 版本 | 1.0 |

---

## 2. 功能概述

### 2.1 问题

当会话从 proactive 模式切换到 interactive 模式时，agent 可能继续使用 proactive 通信模式（调用 `evolclaw ctl send`）而不是直接输出文本，导致消息发送失败。

### 2.2 解决方案

在 interactive 模式下，如果检测到上一轮 proactive 会话中使用了标志位（`[PROACTIVE:REPLY_CONFIRMED_SENT]` 或 `[PROACTIVE:REPLY_CONFIRMED_NONE]`），自动在用户消息前注入提示："本轮会话已切换为 interactive 模式，无需调用工具发送消息。"

### 2.3 核心机制

使用 `session.metadata.lastProactiveFlag` 标记跟踪标志位使用情况：
- **Proactive 模式**：`complete` 事件检测到标志位 → 设置标记
- **Interactive 模式**：新消息到达 → 检测标记 → 注入提示 → 清除标记

---

## 3. 实现任务清单

### 3.1 代码修改

#### 任务 1：标记设置逻辑（Proactive 模式）

**文件**：`src/core/message/message-processor.ts`

**位置**：`processEventStream()` 方法，`complete` 事件处理器内部（约 1341-1374 行）

**修改内容**：

```typescript
if (event.type === 'complete') {
  logger.info(`[MessageProcessor] complete event: isError=${event.isError} terminalReason=${event.terminalReason ?? 'none'} subtype=${event.subtype ?? 'none'} hasReceivedText=${hasReceivedText}`);

  // 自动回填会话名称
  if (event.sessionTitle && session.name === '默认会话') {
    await this.sessionManager.renameSession(session.id, event.sessionTitle);
    logger.info(`[MessageProcessor] Auto-filled session name: ${event.sessionTitle}`);
  }

  // 记录完成状态 + 最后一轮回复文本（后续 complete 覆盖前序）
  completeResult = { isError: !!event.isError, subtype: event.subtype, errors: event.errors, terminalReason: event.terminalReason, lastReplyText, fullText: event.result || '', hasReceivedText, numTurns: event.numTurns, usage: event.usage };

  // 【新增】检测到 proactive 标志位时设置标记
  if (session.sessionMode === 'proactive' && lastReplyText) {
    const hasProactiveMarker = /\[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)\]/.test(lastReplyText);
    if (hasProactiveMarker) {
      session.metadata = session.metadata || {};
      session.metadata.lastProactiveFlag = true;
      await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
      logger.debug(`[MessageProcessor] Set lastProactiveFlag for session ${session.id}`);
    }
  }

  // proactive 模式：每轮 LLM 调用完成后写一条 thought 到 messages.jsonl
  // ... 现有逻辑 ...
}
```

**关键点**：
- 仅在 `session.sessionMode === 'proactive'` 时检测
- 使用正则表达式 `/\[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)\]/` 检测标志位
- 设置 `session.metadata.lastProactiveFlag = true`
- 调用 `updateSession()` 持久化

**预计工作量**：30 分钟

---

#### 任务 2：提示注入逻辑（Interactive 模式）

**文件**：`src/core/message/message-processor.ts`

**位置**：`_processMessageInternal()` 方法，兜底纠正逻辑之后（约 1142 行）

**修改内容**：

```typescript
private async _processMessageInternal(
  message: Message,
  channelKey: string,
  projectPath?: string
): Promise<void> {
  // ... 现有会话解析逻辑 ...
  const { session, absoluteProjectPath } = await this.resolveSessionAndProject(message, channelKey, projectPath);

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

**关键点**：
- **必须在兜底纠正之后**执行，确保 `sessionMode` 已稳定
- 检查 `session.sessionMode === 'interactive'` 且 `session.metadata?.lastProactiveFlag === true`
- 在 `message.content` 前插入提示
- 立即删除标记并调用 `updateSession()` 持久化
- 记录 INFO 级别日志

**预计工作量**：30 分钟

---

#### 任务 3：类型定义更新（可选）

**文件**：`src/types.ts`

**位置**：`Session` 接口的 `metadata` 字段注释

**修改内容**：

```typescript
export interface Session {
  // ... 现有字段 ...
  
  /**
   * Session metadata (flexible key-value store)
   * 
   * Known fields:
   * - lastProactiveFlag?: boolean - Set when agent uses proactive markers, cleared after hint injection
   * - peerId?: string - Peer identifier
   * - peerName?: string - Peer display name
   * - ... other fields ...
   */
  metadata?: Record<string, any>;
  
  // ... 其他字段 ...
}
```

**关键点**：
- 仅添加注释，不修改类型定义
- 记录 `lastProactiveFlag` 字段的用途和生命周期

**预计工作量**：10 分钟

---

### 3.2 测试

#### 任务 4：单元测试

**文件**：`tests/unit/message-processor.test.ts`（新建或扩展现有文件）

**测试用例**：

```typescript
describe('Proactive-to-Interactive hint injection', () => {
  describe('Flag setting (proactive mode)', () => {
    it('should set lastProactiveFlag when REPLY_CONFIRMED_SENT detected', async () => {
      // Mock session in proactive mode
      // Mock complete event with lastReplyText containing [PROACTIVE:REPLY_CONFIRMED_SENT]
      // Verify session.metadata.lastProactiveFlag === true
      // Verify updateSession called
    });

    it('should set lastProactiveFlag when REPLY_CONFIRMED_NONE detected', async () => {
      // Similar to above, but with [PROACTIVE:REPLY_CONFIRMED_NONE]
    });

    it('should NOT set flag when no markers present', async () => {
      // Mock complete event with lastReplyText without markers
      // Verify session.metadata.lastProactiveFlag is undefined
      // Verify updateSession NOT called
    });

    it('should NOT set flag in interactive mode', async () => {
      // Mock session in interactive mode
      // Mock complete event with markers
      // Verify flag NOT set (only works in proactive mode)
    });
  });

  describe('Hint injection (interactive mode)', () => {
    it('should inject hint when flag is set and mode is interactive', async () => {
      // Mock session in interactive mode with lastProactiveFlag = true
      // Mock incoming message
      // Verify message.content starts with hint
      // Verify flag is cleared
      // Verify updateSession called
    });

    it('should NOT inject hint when flag is absent', async () => {
      // Mock session in interactive mode without flag
      // Mock incoming message
      // Verify message.content unchanged
    });

    it('should NOT inject hint in proactive mode', async () => {
      // Mock session in proactive mode with flag
      // Mock incoming message
      // Verify message.content unchanged (hint only in interactive)
    });

    it('should NOT inject hint in autonomous mode', async () => {
      // Mock session in autonomous mode with flag
      // Mock incoming message
      // Verify message.content unchanged
    });

    it('should inject hint only once (flag cleared after injection)', async () => {
      // Mock session with flag
      // Process first message → verify hint injected, flag cleared
      // Process second message → verify no hint (flag already cleared)
    });
  });

  describe('Integration with fallback corrections', () => {
    it('should NOT inject hint when fallback upgrades to proactive', async () => {
      // Mock session in interactive mode with flag (group chat)
      // Mock incoming message (chatType = 'group')
      // Verify fallback upgrades to proactive
      // Verify hint NOT injected (final mode is proactive)
    });
  });
});
```

**预计工作量**：2-3 小时

---

#### 任务 5：集成测试

**测试环境**：需要 AUN 通道连接

**场景 1：Proactive → Interactive 切换（带标志位）**

```bash
# 前置条件：Session 初始为 proactive 模式

# 步骤 1：发送消息（proactive 模式）
# 用户输入："你好"
# Agent 回复包含：[PROACTIVE:REPLY_CONFIRMED_SENT]

# 步骤 2：切换模式
/chatmode interactive

# 步骤 3：发送新消息
# 用户输入："继续"

# 验证：
# - Agent 收到的输入为："本轮会话已切换为 interactive 模式，无需调用工具发送消息。\n\n继续"
# - 日志包含：[MessageProcessor] Injected interactive mode hint for session ...
```

**场景 2：Proactive 中无标志位**

```bash
# 前置条件：Session 初始为 proactive 模式

# 步骤 1：发送消息（proactive 模式）
# 用户输入："你好"
# Agent 回复不包含标志位

# 步骤 2：切换模式
/chatmode interactive

# 步骤 3：发送新消息
# 用户输入："继续"

# 验证：
# - Agent 收到的输入为："继续"（无提示）
# - 日志不包含：Injected interactive mode hint
```

**场景 3：多条 proactive 消息**

```bash
# 步骤 1-3：发送 3 条消息（proactive 模式，都带标志位）
# 步骤 4：切换到 interactive 模式
# 步骤 5：发送消息 → 验证提示出现
# 步骤 6：再发送一条消息 → 验证提示不出现（标记已清除）
```

**场景 4：重启持久化**

```bash
# 步骤 1：proactive 模式发送消息（带标志位）
# 步骤 2：验证 active.json 中 metadata.lastProactiveFlag === true
# 步骤 3：evolclaw restart
# 步骤 4：切换到 interactive 模式
# 步骤 5：发送消息 → 验证提示出现
```

**场景 5：兜底纠正优先级**

```bash
# 步骤 1：proactive 模式发送消息（群聊，带标志位）
# 步骤 2：手动修改 session 为 interactive（模拟配置错误）
# 步骤 3：发送新消息（群聊）
# 验证：
# - 兜底纠正将 sessionMode 改回 proactive
# - 不注入提示（因为最终 sessionMode 是 proactive）
# - 日志包含：group proactive upgrade
```

**预计工作量**：2-3 小时

---

### 3.3 文档更新

#### 任务 6：用户文档

**文件**：`docs/multi-session-design.md` 或 `README.md`

**新增内容**：

```markdown
### 模式切换提示

当会话从 proactive 模式切换到 interactive 模式时，系统会自动检测并注入提示消息，帮助 agent 适应新模式。

**触发条件**：
- 上一轮 proactive 会话中使用了标志位（`[PROACTIVE:REPLY_CONFIRMED_SENT]` 或 `[PROACTIVE:REPLY_CONFIRMED_NONE]`）
- 当前会话切换到 interactive 模式

**提示内容**：
```
本轮会话已切换为 interactive 模式，无需调用工具发送消息。
```

**注意事项**：
- 提示仅出现一次（首次切换到 interactive 时）
- 群聊会话会被兜底纠正强制为 proactive 模式，不会触发提示
- AI 对端会话同样会被强制为 proactive 模式
```

**预计工作量**：30 分钟

---

#### 任务 7：开发者文档

**文件**：`docs/architecture.md`

**新增内容**：

```markdown
### Proactive-to-Interactive 模式切换提示

**实现位置**：`src/core/message/message-processor.ts`

**核心机制**：

1. **标记设置**（Proactive 模式）：
   - 位置：`processEventStream()` → `complete` 事件处理器
   - 条件：`session.sessionMode === 'proactive'` 且检测到标志位
   - 操作：设置 `session.metadata.lastProactiveFlag = true`

2. **提示注入**（Interactive 模式）：
   - 位置：`_processMessageInternal()` → 兜底纠正之后
   - 条件：`session.sessionMode === 'interactive'` 且 `metadata.lastProactiveFlag === true`
   - 操作：在 `message.content` 前插入提示，清除标记

**数据流**：
```
Proactive 会话
  → Agent 输出（带标志位）
  → complete 事件
  → 检测标志位
  → 设置 metadata.lastProactiveFlag
  → 持久化到 active.json

切换到 Interactive
  → 新消息到达
  → _processMessageInternal
  → 兜底纠正（确保 sessionMode 稳定）
  → 检测 lastProactiveFlag
  → 注入提示
  → 清除标记
  → 持久化
```

**关键字段**：
- `Session.metadata.lastProactiveFlag: boolean` - 标记上一轮 proactive 会话是否使用了标志位
```

**预计工作量**：30 分钟

---

## 4. 实施计划

### 4.1 开发阶段

| 阶段 | 任务 | 预计时间 | 依赖 |
|------|------|---------|------|
| 1 | 任务 1：标记设置逻辑 | 30 分钟 | 无 |
| 2 | 任务 2：提示注入逻辑 | 30 分钟 | 任务 1 |
| 3 | 任务 3：类型定义更新 | 10 分钟 | 任务 1, 2 |
| 4 | 任务 4：单元测试 | 2-3 小时 | 任务 1, 2 |
| 5 | 任务 5：集成测试 | 2-3 小时 | 任务 1, 2, 4 |
| 6 | 任务 6：用户文档 | 30 分钟 | 任务 1, 2 |
| 7 | 任务 7：开发者文档 | 30 分钟 | 任务 1, 2 |

**总预计时间**：6-8 小时

### 4.2 开发顺序

1. **第一步**：实现核心逻辑（任务 1, 2, 3）
   - 先实现标记设置
   - 再实现提示注入
   - 更新类型注释
   - 本地手动测试验证基本功能

2. **第二步**：编写测试（任务 4, 5）
   - 先写单元测试，确保逻辑正确
   - 再进行集成测试，验证端到端流程

3. **第三步**：更新文档（任务 6, 7）
   - 用户文档说明功能用途
   - 开发者文档说明实现细节

### 4.3 验收标准

- [ ] 所有单元测试通过（`npm test`）
- [ ] 所有集成测试场景验证通过
- [ ] 代码审查通过（无明显问题）
- [ ] 文档更新完成
- [ ] 回归测试通过（现有 proactive/interactive 行为不变）

---

## 5. 风险与注意事项

### 5.1 实现风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 兜底纠正顺序错误 | 提示注入后被覆盖 | 确保提示注入在兜底纠正之后 |
| 标记未持久化 | 重启后提示不出现 | 测试重启持久化场景 |
| 正则表达式误报 | 不需要时出现提示 | 使用严格的标志位格式 |
| message.content 修改副作用 | 影响其他逻辑 | 仔细分析影响范围，确保安全 |

### 5.2 开发注意事项

1. **代码位置精确性**：
   - 标记设置必须在 `complete` 事件处理器内部
   - 提示注入必须在兜底纠正之后

2. **条件判断严格性**：
   - 标记设置：仅 proactive 模式
   - 提示注入：仅 interactive 模式
   - 两者互斥，不会同时触发

3. **标记生命周期**：
   - 设置：检测到标志位时
   - 清除：注入提示后立即清除
   - 持久化：每次修改后调用 `updateSession()`

4. **日志级别**：
   - 标记设置：DEBUG 级别（频繁操作）
   - 提示注入：INFO 级别（重要事件）

5. **测试覆盖**：
   - 单元测试覆盖所有分支
   - 集成测试覆盖所有场景
   - 回归测试确保不影响现有功能

---

## 6. 部署与监控

### 6.1 部署步骤

1. **代码合并**：
   ```bash
   git checkout -b feature/proactive-to-interactive-hint
   # 实现所有任务
   git add .
   git commit -m "feat: add proactive-to-interactive mode switch hint"
   git push origin feature/proactive-to-interactive-hint
   # 创建 PR，等待审查
   ```

2. **构建**：
   ```bash
   npm run build
   ```

3. **测试**：
   ```bash
   npm test
   # 手动集成测试
   ```

4. **部署**：
   ```bash
   # 合并到 main
   git checkout main
   git merge feature/proactive-to-interactive-hint
   git push
   
   # 重启服务
   evolclaw restart
   ```

### 6.2 监控指标

**日志监控**：
```bash
# 监控标记设置
grep "Set lastProactiveFlag" logs/evolclaw.log

# 监控提示注入
grep "Injected interactive mode hint" logs/evolclaw.log

# 监控错误
grep "ERROR" logs/evolclaw.log | grep -i "proactive\|interactive\|hint"
```

**功能指标**：
- 标记设置次数（每天）
- 提示注入次数（每天）
- 提示注入后的 agent 行为（是否仍然调用 `ctl send`）

**性能指标**：
- 消息处理延迟（应无明显增加）
- metadata 更新频率

---

## 7. 回滚计划

如果部署后发现严重问题，按以下步骤回滚：

1. **立即回滚代码**：
   ```bash
   git revert <commit-hash>
   git push
   evolclaw restart
   ```

2. **清理残留数据**（如果需要）：
   ```bash
   # 清除所有 session 的 lastProactiveFlag
   # 脚本位置：scripts/cleanup-proactive-flags.js
   node scripts/cleanup-proactive-flags.js
   ```

3. **通知用户**：
   - 说明回滚原因
   - 预计修复时间

4. **问题分析**：
   - 收集日志
   - 分析根本原因
   - 修复后重新部署

---

## 8. 附录

### 8.1 相关文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/core/message/message-processor.ts` | 源码 | 核心实现 |
| `src/types.ts` | 源码 | 类型定义 |
| `tests/unit/message-processor.test.ts` | 测试 | 单元测试 |
| `docs/proactive-to-interactive-hint-design.md` | 文档 | 设计文档 |
| `docs/proactive-to-interactive-hint-implementation.md` | 文档 | 本实现文档 |
| `docs/multi-session-design.md` | 文档 | 用户文档 |
| `docs/architecture.md` | 文档 | 开发者文档 |

### 8.2 参考资料

- [Proactive Mode 设计方案](../proactive-mode-design.md)
- [Session Management 架构](./multi-session-design.md)
- [Message Processor 架构](./architecture.md)

---

**文档版本**：1.0  
**最后更新**：2026-05-24  
**作者**：Claude (via implementation planning)  
**状态**：待审查
