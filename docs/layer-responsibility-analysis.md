# 三层架构职责边界分析

## 问题背景

在三层架构（Channel → Gateway → Agent Runner）重构中，需要明确以下组件的归属：
1. StreamFlusher（消息批量发送）
2. StreamIdleMonitor（空闲检测）
3. Safe Mode（错误累积与安全模式）
4. Message Events（消息事件处理）

## 设计原则

### 层级职责定义
- **Channel 层**：平台 I/O，协议适配，无业务逻辑
- **Gateway 层**：会话管理、队列调度、命令路由、事件编排
- **Agent Runner 层**：AI 后端调用，工具权限控制，会话生命周期

### 判断标准
1. **数据流向**：组件处理的数据来自哪一层？
2. **依赖关系**：组件依赖哪一层的能力？
3. **复用性**：组件是否需要跨 Agent 后端复用？
4. **耦合度**：组件与哪一层的耦合最紧密？

## 组件归属分析

### 1. StreamFlusher（消息批量发送）

**当前实现**：
- 位置：`message-processor.ts` 内部创建
- 功能：3秒窗口批量发送工具活动，减少消息碎片
- 依赖：`ChannelAdapter.sendText()`

**归属判断**：
```
数据流向：Agent 事件流 → Flusher → Channel
依赖关系：依赖 Channel 发送能力
复用性：所有 Agent 后端都需要
耦合度：与 Gateway 事件处理紧密耦合
```

**结论**：**Gateway 层**
- 理由：Flusher 是事件流处理的一部分，负责将 Agent 输出优化后路由到 Channel
- 位置：保持在 `message-processor.ts`，但抽象为独立模块 `core/stream-flusher.ts`（已存在）
- 接口：通过 `ReplyContext` 获取 Channel 发送能力

### 2. StreamIdleMonitor（空闲检测）

**当前实现**：
- 位置：`message-processor.ts` 内部创建
- 功能：检测 Agent 输出流 30 秒无活动，发送"思考中"提示
- 依赖：`ChannelAdapter.sendText()`

**归属判断**：
```
数据流向：监听 Agent 事件流静默 → 发送到 Channel
依赖关系：依赖 Channel 发送能力
复用性：所有 Agent 后端都需要
耦合度：与 Gateway 事件处理紧密耦合
```

**结论**：**Gateway 层**
- 理由：与 Flusher 同理，是事件流处理的辅助机制
- 位置：保持在 `message-processor.ts`，已有独立模块 `core/stream-idle-monitor.ts`
- 接口：通过 `ReplyContext` 获取 Channel 发送能力

### 3. Safe Mode（错误累积与安全模式）

**当前实现**：
- 位置：`message-processor.ts` 的 `checkSafeMode()` 方法
- 功能：累积错误次数，达到阈值后进入安全模式（禁用工具调用）
- 依赖：`Session.errorCount`，`AgentRunner.runQuery()` 的 `disableTools` 参数

**归属判断**：
```
数据流向：Agent 错误 → Session 状态更新 → Agent 调用参数
依赖关系：依赖 Session 状态管理 + Agent 调用能力
复用性：所有 Agent 后端都需要
耦合度：横跨 Gateway（会话状态）和 Agent Runner（调用参数）
```

**结论**：**Gateway 层**
- 理由：Safe Mode 是会话级别的状态管理，属于 Gateway 的会话编排职责
- 位置：保持在 `message-processor.ts`，或抽取到 `session-manager.ts`
- 接口：通过 `SessionManager` 管理 `errorCount`，通过 `AgentRunner` 接口传递 `disableTools`

### 4. Message Events（消息事件处理）

**当前实现**：
- 位置：`message-processor.ts` 的 `processEventStream()` 方法
- 功能：消费 Agent 事件流（`text_delta`, `assistant`, `tool_result`, `result`, `system`）
- 依赖：Claude SDK 事件类型，StreamFlusher，StreamIdleMonitor

**归属判断**：
```
数据流向：Agent 事件流 → 解析 → Flusher/Monitor → Channel
依赖关系：依赖 Agent Runner 输出 + Gateway 辅助组件
复用性：不同 Agent 后端事件格式不同
耦合度：与 Gateway 事件编排紧密耦合
```

**结论**：**Gateway 层**
- 理由：事件流消费是 Gateway 的核心职责，负责将 Agent 输出转换为用户可见的消息
- 位置：保持在 `message-processor.ts`
- 接口：Agent Runner 返回标准化的事件流接口（需要抽象层）

**关键问题**：当前 `processEventStream()` 硬编码了 Claude SDK 事件类型，需要抽象：
```typescript
// 当前（耦合 Claude SDK）
if (event.type === 'text_delta') { ... }
else if (event.type === 'assistant') { ... }

// 重构后（标准化事件接口）
interface AgentEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'complete' | 'system';
  data: unknown;
}
```

## 架构决策总结

### Gateway 层职责（message-processor.ts）
1. **StreamFlusher**：批量发送优化
2. **StreamIdleMonitor**：空闲检测提示
3. **Safe Mode**：错误累积与会话状态管理
4. **Event Processing**：消费标准化事件流，编排输出

### Agent Runner 层职责（agent-runner.ts）
1. **事件流标准化**：将 Claude SDK 原始事件转换为标准 `AgentEvent`
2. **工具权限控制**：PreToolUse hook 调用 `canUseTool()`
3. **会话生命周期**：resume/compact/clear

### Channel 层职责（channels/*.ts）
1. **平台 I/O**：sendText/sendFile/isGroupChat
2. **协议适配**：WebSocket/HTTP long-poll
3. **无业务逻辑**：不处理 Safe Mode、Flusher、权限

## 关键设计问题解答

### Q1: ReplyContext 如何解决跨层通信？

**问题**：Gateway 需要调用 Channel 发送消息，但不应直接依赖具体 Channel 实现

**方案**：
```typescript
// types.ts
export interface ReplyContext {
  channelId: string;
  adapter: ChannelAdapter;
  options?: {
    replyToMessageId?: string;
    mentionUserIds?: string[];
    replyInThread?: boolean;
  };
}

// message-processor.ts
async processMessage(msg: Message, session: Session, replyCtx: ReplyContext) {
  const flusher = new StreamFlusher(
    (text) => replyCtx.adapter.sendText(replyCtx.channelId, text, replyCtx.options)
  );
  // ...
}
```

**优势**：
- Gateway 只依赖 `ChannelAdapter` 接口，不依赖具体实现
- `ReplyContext` 封装了回复所需的所有上下文
- 消除了 `session.metadata.feishu.rootId` 这类跨层泄漏

### Q2: Agent 事件流如何标准化？

**问题**：`processEventStream()` 硬编码 Claude SDK 事件类型，无法支持其他 Agent 后端

**方案**：在 Agent Runner 层做适配转换
```typescript
// types.ts
export interface AgentEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'complete' | 'system';
  text?: string;
  toolUse?: { name: string; input: Record<string, unknown> };
  toolResult?: { output: string; isError: boolean };
  systemMessage?: string;
}

// agent-runner.ts
async *runQuery(params): AsyncIterable<AgentEvent> {
  const stream = await query({ ...params });
  for await (const event of stream) {
    // 转换 Claude SDK 事件为标准格式
    if (event.type === 'text_delta') {
      yield { type: 'text', text: event.text };
    } else if (event.type === 'assistant') {
      // 解析 assistant 消息
    }
    // ...
  }
}
```

**优势**：
- Gateway 层不感知具体 Agent 后端
- 新增 Agent 后端只需实现事件转换逻辑
- 保持 Gateway 层代码稳定

### Q3: Safe Mode 状态如何管理？

**问题**：Safe Mode 需要跨消息累积错误，涉及会话状态持久化

**方案**：在 SessionManager 中管理
```typescript
// session-manager.ts
async incrementErrorCount(sessionId: string): Promise<number> {
  const session = await this.getSession(sessionId);
  const newCount = (session.errorCount || 0) + 1;
  await this.db.run(
    'UPDATE sessions SET error_count = ?, updated_at = ? WHERE id = ?',
    [newCount, Date.now(), sessionId]
  );
  return newCount;
}

async resetErrorCount(sessionId: string): Promise<void> {
  await this.db.run(
    'UPDATE sessions SET error_count = 0, updated_at = ? WHERE id = ?',
    [Date.now(), sessionId]
  );
}

// message-processor.ts
private async checkSafeMode(session: Session): Promise<boolean> {
  if (session.errorCount >= 3) {
    await this.replyCtx.adapter.sendText(
      this.replyCtx.channelId,
      '⚠️ 进入安全模式（禁用工具调用）'
    );
    return true;
  }
  return false;
}
```

**优势**：
- 会话状态集中管理
- 持久化到数据库，重启后保留
- Gateway 层只负责判断逻辑

### Q4: 工具权限控制在哪一层？

**问题**：当前 `agent-runner.ts` 的 PreToolUse hook 调用 `canUseTool()`，但权限审批需要用户交互

**方案**：分层处理
```typescript
// Agent Runner 层：黑名单检查（同步）
async preToolUse(toolUse) {
  if (!canUseTool(toolUse.name)) {
    return { allow: false, reason: '工具已被禁用' };
  }
  // 触发 Gateway 层权限审批事件
  const approved = await this.permissionController?.requestApproval(toolUse);
  return { allow: approved ?? true };
}

// Gateway 层：权限审批（异步，5分钟超时）
class PermissionGateway implements PermissionController {
  async requestApproval(toolUse): Promise<boolean> {
    // 发送审批请求到 Channel
    await this.replyCtx.adapter.sendText(
      this.replyCtx.channelId,
      `🔐 工具调用审批：${toolUse.name}\n回复 y/n`
    );
    // 等待用户响应（5分钟超时）
    return await this.waitForUserResponse(300000);
  }
}
```

**优势**：
- Agent Runner 层处理快速黑名单检查
- Gateway 层处理需要用户交互的审批流程
- 通过 `PermissionController` 接口解耦

## 重构实施路径

### 阶段 1：类型定义（types.ts）
- 新增 `ReplyContext` 接口
- 新增 `AgentEvent` 标准事件接口
- 新增 `PermissionController` 能力接口
- 扩展 `ChannelAdapter.sendText()` 支持 options 参数

### 阶段 2：Agent Runner 标准化（agent-runner.ts）
- `runQuery()` 返回 `AsyncIterable<AgentEvent>` 而非原始 SDK 事件
- 实现 Claude SDK 事件到标准事件的转换逻辑
- 实现 `PermissionController` 接口（可选注入）
- 添加 `ModelSwitcher` 能力接口（已有 setModel/getModel）

### 阶段 3：Gateway 层解耦（message-processor.ts）
- 构造函数接收 `ReplyContext` 而非 `ChannelAdapter`
- `processEventStream()` 处理标准 `AgentEvent` 而非 Claude SDK 事件
- 移除 `session.metadata.feishu.rootId` 依赖，改用 `replyCtx.options`
- Safe Mode 逻辑调用 `SessionManager` 方法

### 阶段 4：Session 状态管理（session-manager.ts）
- 添加 `incrementErrorCount()` / `resetErrorCount()` 方法
- 数据库 schema 已有 `error_count` 字段，无需迁移

### 阶段 5：入口层适配（index.ts）
- 构造 `ReplyContext` 对象传递给 `MessageProcessor`
- Feishu 线程回复：从 Channel 层获取 `rootId`，放入 `replyCtx.options`
- 移除 Channel 特定逻辑分支

## 风险评估

### 低风险
- **ReplyContext 引入**：纯新增接口，不影响现有代码
- **Safe Mode 迁移**：逻辑不变，只是位置调整
- **类型定义扩展**：向后兼容

### 中风险
- **Agent 事件流标准化**：需要完整测试所有事件类型（text_delta, assistant, tool_result, result, system）
- **PermissionController 注入**：需要确保可选注入不影响现有流程

### 高风险
- **processEventStream 重构**：核心消息处理逻辑，需要充分测试
- **session.metadata 清理**：需要确保所有 Feishu 特定逻辑都迁移到 ReplyContext

## 测试策略

### 单元测试
- `agent-runner.ts`：事件转换逻辑（Claude SDK → AgentEvent）
- `session-manager.ts`：errorCount 增减逻辑
- `stream-flusher.ts`：批量发送逻辑（已有测试）

### 集成测试
- Feishu 线程回复：验证 `replyCtx.options.replyInThread` 生效
- WeChat 普通回复：验证 `replyCtx` 不影响现有流程
- Safe Mode：验证错误累积 → 禁用工具 → 重置流程
- 权限审批：验证 5 分钟超时机制

### 回归测试
- 所有现有测试用例必须通过
- 手动测试 Feishu/WeChat 双通道

## 结论

### 核心设计决策

1. **StreamFlusher/StreamIdleMonitor → Gateway 层**
   - 属于事件流处理的辅助机制
   - 通过 `ReplyContext` 获取 Channel 能力

2. **Safe Mode → Gateway 层**
   - 会话级别状态管理
   - 持久化由 `SessionManager` 负责

3. **Message Events → Gateway 层**
   - 消费标准化的 `AgentEvent`
   - Agent Runner 负责事件转换

4. **权限控制 → 分层处理**
   - Agent Runner：黑名单检查（同步）
   - Gateway：审批流程（异步）

### 关键接口

```typescript
// 跨层通信
interface ReplyContext {
  channelId: string;
  adapter: ChannelAdapter;
  options?: { replyToMessageId?: string; mentionUserIds?: string[]; replyInThread?: boolean };
}

// 标准化事件
interface AgentEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'complete' | 'system';
  text?: string;
  toolUse?: { name: string; input: Record<string, unknown> };
  toolResult?: { output: string; isError: boolean };
  systemMessage?: string;
}

// 能力接口
interface PermissionController {
  requestApproval(toolUse: ToolUse): Promise<boolean>;
}
```

### 下一步

参考本文档完成三层架构重构的详细实施计划。

---

## 补充问题解答

### Q5: summarizeToolInput 为何放在 utils/permission.ts 而不是 message-*.ts？

**当前状态**：
- `utils/permission.ts` 只包含 `canUseTool()` 函数（黑名单检查）
- `message-processor.ts` 的 `formatToolDescription()` 方法（664-679行）实际承担了工具输入摘要功能

**问题分析**：
- 你提到的 `summarizeToolInput` 可能是计划中的函数名，但当前代码中实际是 `formatToolDescription()`
- 该函数位置正确：在 Gateway 层的 `message-processor.ts` 中
- 与权限控制无关，不应放在 `permission.ts`

**结论**：
- ✅ **当前实现正确**：`formatToolDescription()` 已在 Gateway 层
- ❌ **不应放在 permission.ts**：权限模块只负责黑名单检查，不负责工具描述格式化
- 💡 **可选优化**：如果未来工具描述逻辑复杂化，可抽取到 `core/tool-formatter.ts`

---

### Q6: flusher、后台执行、空闲监听处理放在哪层？

**已明确归属 Gateway 层**，具体位置：

#### StreamFlusher（批量发送）
- **层级**：Gateway 层
- **当前位置**：`utils/stream-flusher.ts`（独立模块）+ `message-processor.ts` 内部创建（284-307行）
- **职责**：3秒窗口批量发送，减少消息碎片
- **依赖**：通过闭包调用 `adapter.sendText()`

#### StreamIdleMonitor（空闲检测）
- **层级**：Gateway 层
- **当前位置**：`utils/stream-idle-monitor.ts`（独立模块）+ `message-processor.ts` 内部创建（94行）
- **职责**：检测 Agent 事件流 30 秒无活动，发送"思考中"提示
- **依赖**：通过 `channelInfo.adapter.sendText()` 发送提示（107、124行）

#### 后台执行（Background Session）
- **层级**：Gateway 层
- **当前位置**：`message-processor.ts` 的 `isBackgroundSession()` 方法（24-30行）
- **职责**：判断会话是否为后台任务，后台任务静默执行不发送输出
- **逻辑**：
  - 话题会话独立运行，不是后台任务
  - 主会话：与当前活跃会话比对，非活跃会话 = 后台任务
  - 后台任务只缓存 result 事件（627-650行），不发送中间输出

**总结**：三者都在 Gateway 层，通过 `message-processor.ts` 协调，依赖 `ChannelAdapter` 接口发送消息。

---

### Q7: 安全模式与修复在哪层实现？

#### Safe Mode（安全模式）
**层级**：Gateway 层

**状态管理**（session-manager.ts）：
- `recordError()`：记录错误，累积计数
- `recordSuccess()`：重置错误计数
- `setSafeMode()`：设置安全模式标志
- `getHealthStatus()`：获取健康状态

**判断逻辑**（message-processor.ts）：
- `checkSafeMode()` 方法（187-226行）：
  - 检查连续错误次数是否达到阈值（默认3次）
  - 达到阈值：设置安全模式，发送提示消息
  - 阈值-1次：发送预警消息

**触发时机**（message-processor.ts）：
- 捕获错误后调用 `sessionManager.recordError()`（163行）
- 仅单聊主人的错误累计触发安全模式（群聊和非主人跳过，159-162行）
- 上下文过长错误不累计（157-158行）

#### Self-Heal（自愈修复）
**层级**：系统层（不在三层架构内）

**位置**：`src/cli.ts` 的 `restart-monitor` 子命令

**流程**：
1. 检测启动失败（无 ready.signal）
2. 调用 `claude -p` CLI 诊断
3. Claude 读取日志、分析、修复代码、构建
4. 记录到 `logs/self-heal.md`
5. 重试启动（最多3次）
6. 成功后归档 `self-heal-{timestamp}.md`

**通知**：通过 `notifyChannel()` 路由到 Feishu/WeChat

**总结**：Safe Mode 在 Gateway 层，Self-Heal 在系统层（进程级故障恢复）。

---

### Q8: 执行中消息和最终消息以及权限确认为何不在消息接收事件中？

**当前实现**：这些消息在 `message-processor.ts` 的 `processMessage()` 和 `processEventStream()` 中直接发送

#### 执行中消息（Processing Messages）
- **位置**：`message-processor.ts` 通过 StreamFlusher 批量发送
- **类型**：
  - 工具活动：`🔧 ToolName: description`（591-593行）
  - 子任务进度：`⏳ 子任务: summary`（579行）
  - 系统通知：`💡 会话压缩完成...`（568行）
- **发送方式**：`flusher.addActivity()` → 3秒窗口批量发送

#### 最终消息（Final Messages）
- **位置**：`message-processor.ts` 通过 StreamFlusher 的 `flush(true)` 发送（415行）
- **特点**：带 `title: '最终回复:'` 标记（290行）
- **发送方式**：`flusher.flush(true)` 立即发送

#### 权限确认（Permission Approval）
- **当前状态**：仅黑名单检查（`utils/permission.ts` 的 `canUseTool()`）
- **未来设计**：需要用户交互的审批流程（见 Q4）

**为什么不事件化**：
1. **执行中消息**：已通过 StreamFlusher 优化，无需额外事件总线
2. **最终消息**：是 Gateway 内部的输出编排，直接调用更简单
3. **权限确认**：需要阻塞等待用户响应，不适合异步事件模式

**是否需要改为事件**：
- ❌ **不建议**：当前设计已足够清晰，事件化会增加复杂度
- ✅ **当前设计合理**：Gateway 层直接调用 `adapter.sendText()` 符合职责边界

---

### Q9: 输入后的开始执行消息是不是也应该加入到事件？

**当前实现**：无明确的"开始执行"消息，用户发送消息后直接进入处理流程

**分析**：

#### 方案 A：保持当前设计（推荐）
```typescript
// message-processor.ts
async processMessage(msg, session, replyCtx) {
  // 直接开始处理，无"开始执行"消息
  const stream = await this.agentRunner.runQuery(...);
  await this.processEventStream(...);
}
```

**优势**：
- 简洁直接，减少消息噪音
- 用户体验更流畅（无多余确认消息）
- 首个工具活动或文本输出即表示已开始执行

#### 方案 B：添加开始消息（可选）
```typescript
// message-processor.ts
async processMessage(msg, session, replyCtx) {
  // 发送开始消息
  await replyCtx.adapter.sendText(replyCtx.channelId, '✓ 收到消息，正在处理...');

  const stream = await this.agentRunner.runQuery(...);
  await this.processEventStream(...);
}
```

**优势**：
- 用户立即获得反馈（消息已收到）
- 适合长时间无输出的场景

#### 方案 C：事件化（不推荐）
```typescript
// 定义事件
eventBus.emit('message:processing:start', { sessionId, message });

// 监听器
eventBus.on('message:processing:start', async (data) => {
  await adapter.sendText(data.channelId, '✓ 开始处理...');
});
```

**劣势**：
- 过度设计，增加复杂度
- 单一职责的消息发送不需要事件总线

**建议**：
- ✅ **方案 A（当前）**：适合快速响应场景（<2秒出首个输出）
- ⚠️ **方案 B（可选）**：如果 Agent 初始化耗时较长（>3秒），可添加开始消息
- ❌ **方案 C（不推荐）**：无需事件化，直接调用即可

**实施建议**：
- 保持当前设计，无需修改
- 如果未来需要"开始执行"消息，在 `processMessage()` 开头添加一行 `sendText()` 调用即可
- 不需要引入事件总线

---

## 总结表格

| 问题 | 归属层级 | 当前位置 | 是否需要调整 | 备注 |
|------|---------|---------|-------------|------|
| summarizeToolInput | Gateway | `message-processor.ts` 的 `formatToolDescription()` | ✅ 已正确 | 不应放在 permission.ts |
| StreamFlusher | Gateway | `utils/stream-flusher.ts` + `message-processor.ts` | ✅ 已正确 | 批量发送优化 |
| StreamIdleMonitor | Gateway | `utils/stream-idle-monitor.ts` + `message-processor.ts` | ✅ 已正确 | 空闲检测提示 |
| 后台执行 | Gateway | `message-processor.ts` 的 `isBackgroundSession()` | ✅ 已正确 | 会话级别判断 |
| Safe Mode | Gateway | `session-manager.ts` + `message-processor.ts` | ✅ 已正确 | 状态管理 + 判断逻辑 |
| Self-Heal | 系统层 | `cli.ts` 的 `restart-monitor` | ✅ 已正确 | 进程级故障恢复 |
| 执行中消息 | Gateway | `message-processor.ts` 通过 StreamFlusher | ✅ 已正确 | 无需事件化 |
| 最终消息 | Gateway | `message-processor.ts` 的 `flush(true)` | ✅ 已正确 | 无需事件化 |
| 权限确认 | Agent Runner + Gateway | `permission.ts` + 未来的 PermissionGateway | ⚠️ 待实现 | 分层处理 |
| 开始执行消息 | Gateway | 当前无 | ⚠️ 可选添加 | 保持当前设计即可 |

**核心结论**：
1. 所有组件归属清晰，无需大规模调整
2. 唯一需要实现的是权限审批机制（PermissionGateway）
3. 开始执行消息可选，当前设计已足够

