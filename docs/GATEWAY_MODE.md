# Gateway 模式说明

## 状态

**实验性功能，未在生产环境使用。保留作为未来需求的参考实现。**

## 概述

Gateway 模式是 EvolClaw 的备选入口点，提供了实例池管理和完整的 Hook 监控机制。

## 核心价值

### 1. 实例池管理 (`src/gateway/instance-manager.ts`)

**功能**：
- 管理最多 20 个并发 Claude Agent SDK 实例
- 自动清理空闲 30 分钟的实例
- 实例状态跟踪：IDLE → BUSY → IDLE

**适用场景**：
- 多用户高并发访问
- 需要严格控制资源使用
- 需要实例复用以提高性能

**代码示例**：
```typescript
const instanceManager = new InstanceManager({
  maxInstances: 20,
  idleTimeout: 30 * 60 * 1000,
  apiKey: config.anthropic.apiKey
});

const instance = await instanceManager.getOrCreateInstance(
  sessionId,
  projectPath
);
```

### 2. 完整 Hook 监控 (`src/gateway/claude-instance.ts`)

**支持的 Hooks**：
- **Stop Hook**: 对话结束同步点（100% 可靠）
- **PostToolUse Hook**: 工具调用后触发
- **SubagentStart Hook**: 子 Agent 启动时触发
- **SubagentStop Hook**: 子 Agent 停止时触发
- **Notification Hook**: 系统通知处理

**价值**：
- 完整的事件追踪和监控
- 可用于性能分析、调试、审计
- 事件通过 EventEmitter 发送到监控层

**代码示例**：
```typescript
const instance = new ClaudeInstance(sessionId, projectPath, apiKey);

instance.on('hook', (event) => {
  if (event.type === 'stop') {
    console.log('Dialogue completed');
  }
  if (event.type === 'postToolUse') {
    console.log('Tool used:', event.data);
  }
});
```

### 3. 故障恢复机制 (`src/gateway/failure-handler.ts`)

**功能**：
- **重试机制**: 最多 3 次，指数退避（1s, 2s, 4s）
- **实例重启**: 最多 5 次重启，60 秒冷却时间
- **熔断保护**: 连续失败达到阈值时触发熔断

**价值**：
- 提高系统稳定性
- 自动从临时故障中恢复
- 避免级联故障

## 为什么未在生产使用？

主入口 (`src/index.ts`) 提供了更适合当前场景的功能：

| 特性 | Gateway 模式 | 主入口 (index.ts) |
|------|-------------|-------------------|
| 实例管理 | ✅ 实例池（20个） | ⚠️ 简单 Map |
| Hook 监控 | ✅ 5个 Hooks | ⚠️ 1个 Hook (PreCompact) |
| 故障恢复 | ✅ 重试+重启+熔断 | ⚠️ 简单重试 |
| 中断机制 | ❌ 无 | ✅ 有 |
| 批量发送 | ❌ 无 | ✅ 3秒窗口 |
| 项目切换 | ❌ 无 | ✅ /switch, /bind |
| 会话持久化 | ❌ 无 | ✅ SQLite + JSONL |
| 消息处理 | ❌ 简单 | ✅ MessageProcessor |

**结论**：主入口的功能更完善，更适合单用户场景。

## 何时考虑使用 Gateway 模式？

### 场景 1：高并发多用户

**需求**：
- 100+ 并发用户
- 需要实例复用以降低成本
- 需要严格的资源限制

**方案**：
- 使用 InstanceManager 管理实例池
- 配置合适的 maxInstances 和 idleTimeout
- 结合负载均衡器分发请求

### 场景 2：完整监控和审计

**需求**：
- 需要追踪所有 Hook 事件
- 需要性能分析和调试
- 需要审计日志

**方案**：
- 使用 ClaudeInstance 的完整 Hook 配置
- 将 Hook 事件发送到监控系统
- 结合 HookCollector 存储事件

### 场景 3：高可用性要求

**需求**：
- 需要自动故障恢复
- 需要熔断保护
- 需要实例自动重启

**方案**：
- 使用 FailureHandler 处理故障
- 配置重试策略和熔断阈值
- 监控重启次数和失败率

## 如何启用 Gateway 模式？

### 方法 1：修改 package.json

```json
{
  "main": "dist/index-gateway.js"
}
```

然后：
```bash
npm run build
npm start
```

### 方法 2：直接运行

```bash
npm run build
node dist/index-gateway.js
```

### 方法 3：创建独立启动脚本

```bash
#!/bin/bash
# gateway-start.sh
node dist/index-gateway.js
```

## 迁移到主入口

如果需要将 Gateway 模式的功能迁移到主入口：

### 1. 迁移 Hook 监控

从 `src/gateway/claude-instance.ts` 复制 Hook 配置到 `src/agent-runner.ts`：

```typescript
// 在 AgentRunner.runQuery() 中添加
hooks: {
  Stop: [{ matcher: '.*', hooks: [stopHook] }],
  PostToolUse: [{ matcher: '.*', hooks: [postToolUseHook] }],
  SubagentStart: [{ matcher: '.*', hooks: [subagentStartHook] }],
  SubagentStop: [{ matcher: '.*', hooks: [subagentStopHook] }],
  Notification: [{ matcher: '.*', hooks: [notificationHook] }],
  PreCompact: [{ matcher: '.*', hooks: [preCompactHook] }]
}
```

### 2. 迁移实例池管理

在 `src/index.ts` 中集成 InstanceManager：

```typescript
import { InstanceManager } from './gateway/instance-manager.js';

const instanceManager = new InstanceManager({
  maxInstances: 20,
  idleTimeout: 30 * 60 * 1000,
  apiKey: config.anthropic.apiKey
});

// 替换 AgentRunner 使用 InstanceManager
```

### 3. 迁移故障恢复

在 `src/index.ts` 中集成 FailureHandler：

```typescript
import { FailureHandler } from './gateway/failure-handler.js';

const failureHandler = new FailureHandler(instanceManager, {
  retry: { maxAttempts: 3, backoff: 'exponential', initialDelay: 1000 },
  restart: { enabled: true, maxRestarts: 5, cooldown: 60000 }
});
```

## 测试

Gateway 模式有完整的单元测试：

```bash
# 测试实例管理器
npm test tests/unit/instance-manager.test.ts

# 测试 Claude 实例
npm test tests/unit/claude-instance.test.ts
```

## 文档

- 架构设计：`docs/architecture.md`
- 开发指南：`CLAUDE.md` - "Gateway Mode (Experimental)" 章节
- 项目概览：`README.md` - "系统架构" 章节

## 维护状态

- ✅ 代码完整，可运行
- ✅ 测试覆盖完整
- ✅ 文档齐全
- ⚠️ 未在生产使用
- ⚠️ 缺少主入口的新功能（中断、批量发送、项目切换等）

## 总结

Gateway 模式是一个有价值的参考实现，保留的主要原因：

1. **实例池管理**：未来高并发场景的成熟方案
2. **完整 Hook 监控**：全面的事件追踪机制
3. **故障恢复**：生产级的重试和熔断机制
4. **代码质量高**：测试覆盖完整，可直接使用

当前不使用的原因：主入口功能更完善，更适合单用户场景。

未来如需要实例池管理或完整监控，可直接参考或迁移 Gateway 模式的代码。
