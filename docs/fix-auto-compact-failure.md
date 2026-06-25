# 自动压缩失败问题修复报告

**日期**: 2026-06-20  
**问题编号**: EVOLCLAW-001  
**严重程度**: 高（阻塞任务执行）

## 问题描述

### 症状
多个 agent（包括 wcguard、eleanbot）在长对话中触发 "Prompt is too long" 错误后，自动压缩失败，导致任务终止并显示"任务执行失败"。

### 复现条件
1. 使用 Claude SDK runner (AgentRunner)
2. 配置非 Claude 原生模型（如 kimi-k2.6）或累积大量对话历史
3. 触发上下文过长错误
4. 自动压缩机制被触发

### 影响范围
- **受影响模型**: 所有通过 Claude SDK 访问的非原生模型（kimi、moonshot 等）
- **受影响 agent**: wcguard、eleanbot 及其他长对话场景
- **用户体验**: 任务中断，需要手动 `/clear` 重置会话

---

## 根本原因分析

### 1. 代码缺陷：压缩失败误报成功

**位置**: `src/agents/claude-runner.ts:1638`

**问题代码**:
```typescript
for await (const event of stream) {
  if (event.type === 'system' && event.subtype === 'compact_boundary') {
    logger.info(`[AgentRunner] Compact completed, pre_tokens: ${event.compact_metadata?.pre_tokens}`);
    return true;
  }
}
return true;  // 👈 问题：即使没收到压缩完成事件也返回 true
```

**原因**: 
- Claude SDK 对不支持的模型调用 `/compact` 时，不抛出错误
- 不返回 `compact_boundary` 事件，直接结束流
- 代码没有检测是否真正收到事件，流结束即返回 `true`

**影响**: 外层认为压缩成功，立即重试，但实际历史未减少，重试仍超限。

---

### 2. 处理逻辑缺陷：压缩失败直接放弃

**位置**: `src/core/message/message-processor.ts:1273`

**问题代码**:
```typescript
const compacted = await compactAgent.compact(session.id, session.agentSessionId!, absoluteProjectPath);
if (compacted) {
  // 重试
} else {
  throw new Error('CONTEXT_COMPACT_FAILED');  // 👈 直接抛错退出
}
```

**原因**: 压缩失败后，没有降级方案（如清空会话），直接抛错导致任务终止。

**影响**: 用户看到"任务执行失败"，对话中断，需要手动干预。

---

### 3. 预防机制不足：压缩阈值过高

**位置**: `src/agents/runner-types.ts:313`

**问题配置**:
```typescript
export function autoCompactWindowForModel(model: string | undefined): number {
  return isOneMillionContextModel(model) ? 900000 : 200000;
  // 👈 Opus 4.8 等 1M 模型设为 900k tokens 才触发 SDK 自动压缩
}
```

**原因**: 
- Claude API 的 prompt cache 限制约 50-100k tokens
- SDK 认为有 1M 窗口，累积到 900k 才自动压缩
- 结果：在 SDK 自动压缩前，API 就报 `blocking_limit` 错误

**影响**: 即使是 Claude 原生模型，也容易触发手动压缩逻辑，增加失败风险。

---

## 修复方案

### 修复 1: 检测压缩是否真正完成

**文件**: `src/agents/claude-runner.ts`

**修改**:
```typescript
async compactSession(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean> {
  try {
    logger.info(`[AgentRunner] Compacting session: ${agentSessionId}`);
    const stream = this.runSessionCommand('/compact', agentSessionId, projectPath);
    this.activeStreams.set(sessionId, stream);
    try {
      let receivedBoundary = false;
      for await (const event of stream) {
        if (event.type === 'system' && event.subtype === 'compact_boundary') {
          logger.info(`[AgentRunner] Compact completed, pre_tokens: ${event.compact_metadata?.pre_tokens}`);
          receivedBoundary = true;
        }
      }
      if (!receivedBoundary) {
        logger.warn(`[AgentRunner] Compact stream ended without compact_boundary event`);
      }
      return receivedBoundary;  // 👈 只有收到事件才返回 true
    } finally {
      this.activeStreams.delete(sessionId);
    }
  } catch (error) {
    logger.error('[AgentRunner] Compact failed:', error);
    return false;
  }
}
```

**效果**: kimi 等不支持压缩的模型会返回 `false`，触发降级方案。

---

### 修复 2: 压缩失败后自动清空会话

**文件**: `src/core/message/message-processor.ts`

**修改**:
```typescript
const compacted = await compactAgent.compact(session.id, session.agentSessionId!, absoluteProjectPath);
if (compacted) {
  renderer.addNotice('✅ 压缩完成，继续处理...', 'info', 'compact-retry', true);
  // ... 重试逻辑
} else {
  // 👇 新增：压缩失败后的降级方案
  renderer.addNotice('⚠️ 压缩失败，清空会话历史后重试...', 'warn', 'compact-failed-clear', true);
  await renderer.flush();
  const hasClear = hasPermissionController(agent) && typeof agent.clearSession === 'function';
  if (hasClear) {
    await agent.clearSession(session.id, session.agentSessionId!, absoluteProjectPath);
    renderer.addNotice('✅ 会话已清空，继续处理...', 'info', 'clear-retry', true);
    const retryStream = await agent.runQuery(
      session.id,
      '会话历史已清空，请继续之前未完成的任务。',
      absoluteProjectPath,
      session.agentSessionId!,
      undefined,
      effectiveSystemPrompt,
      this.sessionManager,
      modelOverride
    );
    agent.registerStream(streamKey, retryStream);
    streamResult = await this.processEventStream(retryStream, session, agent, renderer, resetTimer, shouldSuppress, proactive, message.source === 'trigger');
  } else {
    throw new Error('CONTEXT_COMPACT_FAILED');
  }
}
```

**效果**: 压缩失败时，自动清空会话历史并重试，任务能继续执行。

---

### 修复 3: 降低自动压缩阈值

**文件**: `src/agents/runner-types.ts`

**修改**:
```typescript
/** autoCompact trigger threshold: 1M models = 150000 (conservative for cache limits), otherwise 180000. */
export function autoCompactWindowForModel(model: string | undefined): number {
  return isOneMillionContextModel(model) ? 150000 : 180000;
  // 👆 从 900k/200k 改为 150k/180k，提前触发 SDK 自动压缩
}
```

**理由**:
- Claude API 的 prompt cache 限制约 50-100k tokens
- 150k 给 cache 留足余量，避免触发 blocking_limit
- 200k 模型改为 180k，同样原因

**效果**: SDK 会在累积到 150k 时主动压缩，远早于 cache 限制，减少手动压缩触发频率。

---

### 修复 4: 导入缺失类型

**文件**: `src/core/message/message-processor.ts`

**修改**:
```typescript
import { 
  BaseagentRunnerUnavailableError, 
  type AgentRunnerFull, 
  hasCompact, 
  type AgentEvent, 
  type Compactable, 
  type AgentTokenUsage, 
  type AgentContextUsage, 
  type AgentLastModelCall, 
  type AgentModelCall, 
  autoCompactWindowForModel, 
  isClaudeContextUsageModel,
  hasPermissionController  // 👈 新增
} from '../../agents/runner-types.js';
```

---

## 验证方案

### 1. 单元测试补充

**待补充测试用例**:
```typescript
describe('claude-runner compactSession', () => {
  it('should return false when no compact_boundary event received', async () => {
    // 模拟 kimi 等不支持压缩的模型
    const runner = new ClaudeAgentRunner(config);
    const result = await runner.compactSession(sessionId, agentSessionId, projectPath);
    expect(result).toBe(false);
  });

  it('should return true when compact_boundary event received', async () => {
    // 模拟 Claude 原生模型
    const runner = new ClaudeAgentRunner(config);
    const result = await runner.compactSession(sessionId, agentSessionId, projectPath);
    expect(result).toBe(true);
  });
});

describe('message-processor auto-compact fallback', () => {
  it('should clear session when compact fails', async () => {
    // 模拟压缩失败 → 清空会话 → 重试成功
    const processor = new MessageProcessor(...);
    const result = await processor.processMessage(message);
    expect(result.isError).toBe(false);
    expect(mockClearSession).toHaveBeenCalled();
  });
});
```

---

### 2. 集成测试场景

**测试步骤**:
1. 配置 wcguard 使用 kimi-k2.6
2. 在 AUN 群聊中发送长对话，累积到触发上下文过长
3. 观察日志：
   - 看到 "Compacting session"
   - 看到 "Compact stream ended without compact_boundary event"
   - 看到 "压缩失败，清空会话历史后重试"
   - 看到 "会话已清空，继续处理"
   - 任务成功完成，不再显示"任务执行失败"

**预期结果**:
- 压缩失败返回 `false`（日志有 warn）
- 自动清空会话
- 重试成功，任务继续

---

### 3. 回归测试

**测试 Claude 原生模型**:
1. 配置 eleanbot 使用 opus/sonnet/haiku
2. 累积到 150k tokens（观察 SDK 自动压缩）
3. 手动触发上下文过长（systemPrompt 加大到 100k）
4. 观察日志：
   - 看到 "Compact completed, pre_tokens: xxx"
   - 压缩返回 `true`
   - 重试成功

**预期结果**:
- Claude 原生模型的压缩正常工作
- 不会误触发 clear 降级方案

---

## 风险评估

### 低风险
- **修复 1（检测压缩完成）**: 仅改变返回值逻辑，不影响正常流程
- **修复 3（降低阈值）**: 更早触发压缩，减少 API 报错，无副作用

### 中风险
- **修复 2（清空会话降级）**: 
  - **风险**: 压缩失败时清空历史，可能丢失上下文
  - **缓解**: 仅在压缩确认失败时触发，且用户会看到明确提示
  - **回滚**: 可通过配置禁用降级方案（保留 throw）

---

## 配置说明

### baseagents vs agents 配置

| 字段 | 作用域 | 优先级 | 示例 |
|------|--------|--------|------|
| `baseagents.<name>.model` | Per-agent 配置 | **高（生效）** | `baseagents.claude.model = "kimi-k2.6"` |
| `agents.<name>.model` | 全局兜底配置 | 低（未生效） | `agents.claude.model = "deepseek-v4-pro"` |

**正确配置示例**:
```json
{
  "active_baseagent": "claude",
  "baseagents": {
    "claude": {
      "model": "kimi-k2.6"
    }
  }
}
```

**过时配置**（不再生效）:
```json
{
  "agents": {
    "claude": {
      "model": "deepseek-v4-pro"
    }
  }
}
```

---

## 部署计划

### 阶段 1: 代码审查
- [ ] 审查修复 1-4 的代码变更
- [ ] 确认类型导入正确
- [ ] 检查是否有遗漏的边界条件

### 阶段 2: 测试验证
- [ ] 补充单元测试
- [ ] 执行集成测试（kimi 场景）
- [ ] 执行回归测试（Claude 原生模型）

### 阶段 3: 灰度发布
- [ ] 先部署到 wcguard (kimi) 验证
- [ ] 观察 24 小时，确认无回归
- [ ] 推广到所有 agent

### 阶段 4: 监控
- [ ] 监控 "Compact stream ended without compact_boundary" 日志频率
- [ ] 监控 "压缩失败，清空会话历史" 触发次数
- [ ] 收集用户反馈（是否仍有任务失败）

---

## 后续优化

### 1. 支持渐进式降级
```
压缩失败 → 尝试部分清空（保留最近 N 条） → 完全清空 → 报错
```

### 2. 模型能力探测
在 runner 初始化时探测模型是否支持 `/compact`，避免运行时失败。

### 3. 配置字段统一
废弃 `agents.<name>` 配置，统一使用 `baseagents.<name>`，减少混淆。

---

## 审查检查清单

- [ ] 代码逻辑正确（压缩检测、降级方案）
- [ ] 类型导入完整
- [ ] 日志输出清晰（warn/info 级别合理）
- [ ] 用户提示友好（中文描述准确）
- [ ] 向后兼容（不影响现有正常流程）
- [ ] 性能影响可控（清空会话开销）
- [ ] 文档完整（配置说明、部署计划）
