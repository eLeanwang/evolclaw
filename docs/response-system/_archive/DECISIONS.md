# 响应系统插件化：决策总览

本文档记录响应系统插件化过程中的所有关键决策及其拍板结果。

---

## 决策汇总

| 决策 | 问题 | 结果 | 影响的 Phase |
|------|------|------|--------------|
| **D1** | 队列机制与 agent 隔离 | ✅ 修复 agent 隔离 + 入队/出队策略分离 | Phase 2 |
| **D2** | 调度层兼容性预留 | ✅ 预留 yieldHint，Phase 7 暂不实施 | 无（Phase 7 暂不） |
| **D3** | 辅助会话接口能力 | ✅ 扩展接口（加 send()），支持配置 | Phase 6 |
| **D4** | 旧配置参数迁移 | ✅ 直接删除 chatmode/dispatch | Phase 4 |
| **D5** | 作用域读写机制 | ✅ 泛化 config-scope 为 field-scope | Phase 5 |
| **D6** | 响应模式异常处理 | ✅ 不降级，增强错误提示 | Phase 3 |
| **D7** | 现有机制迁移评估 | ✅ 4 项接口调整（详见下文） | Phase 1/2/3/6 |

---

## D1：队列机制与 agent 隔离

### 问题

- 现有队列按 `sessionKey::projectPath` 分队列，多 agent 共享同一对端时队列冲突
- 响应模式需要自己的队列，但不能让每个模式独立持久化

### 决策 ✅

**D1.1 修复 agent 隔离**：
- `queueKey = selfAID::sessionKey::projectPath`（加 selfAID 前缀）
- 不同 agent 与同一对端的队列独立

**D1.2 入队/出队策略分离**：
- 物理队列（全局单例）：负责持久化、去重、中断
- 逻辑队列（per-mode）：负责出队顺序
- 切换模式时：已入队消息不动，出队时按新模式重排

### 理由

- 修复 agent 隔离是必须的（否则多 agent 场景冲突）
- 分层架构平衡了灵活性（模式自定义队列）和简单性（持久化仍集中）

---

## D2：调度层兼容性预留

### 问题

响应层之上是否需要调度层（SlotManager）？如何预留扩展点？

### 决策 ✅

**D2.1 预留 yieldHint**：
- `OutboundDecision` 加可选字段 `yieldHint?: 'continue' | 'pause' | 'yield'`
- 当前阶段忽略，未来调度层可读取

**D2.2 Phase 7 暂不实施**：
- 接口已预留，流程图已标注插入点
- 未来实施时可无缝对接，不需要改响应层

### 理由

- 当前需求不涉及并发限制和预算分配
- 预留接口成本低，避免未来大改

---

## D3：辅助会话接口能力

### 问题

辅助会话（dual-session 等模式使用）需要哪些能力？

### 决策 ✅

**扩展接口（选 B）**：
```typescript
interface AuxiliarySession {
  judge(prompt: string): Promise<string>;
  send(content: string, type: 'thought' | 'message'): Promise<void>;  // ← 新增
  close(): Promise<void>;
}
```

**配置选项**：
- `purpose`：用途标识（用于成本统计）
- `contextMode`：'minimal'（默认）/ 'full'
- 工具权限：当前默认无，预留扩展

### 理由

- 辅助会话不只是"判断"，还需要发送状态和通知
- 但不给完整权限（不是"轻量主会话"），保持复杂度可控

---

## D4：旧配置参数迁移

### 问题

现有 `chatmode`/`dispatch` 参数如何处理？

### 决策 ✅

**直接删除，无需兼容**：
- 项目未对外发布，直接用新结构
- `chatmode` → `response_modes.default_private/default_group`
- `dispatch: 'mention'` → `default_group: 'selective-response'`
- `dispatch: 'broadcast'` → `default_group: 'proactive'`

### 理由

- 开发阶段，避免维护兼容层的复杂度

---

## D5：作用域读写机制

### 问题

`ec response` 命令需要作用域读写（--self/--peer），是否复用 `ec model` 的 config-scope？

### 决策 ✅

**泛化为 field-scope**：
- 提取 config-scope 的通用框架（determineScope/peer 规范化）
- model 和 response 各自提供字段路径适配器
- 未来其他命令（ec skill）可复用

### 理由

- 作用域逻辑是通用的，不应重复
- 重构成本小，收益明显

---

## D6：响应模式异常处理

### 问题

响应模式的 `handleInbound/handleOutbound` 抛异常时如何处理？

### 决策 ✅

**不降级，增强提示**：
1. 记录日志（包含堆栈）
2. reject Promise（通知调用方失败）
3. **新增**：发送用户友好的错误提示（"响应模式处理异常：[异常信息]，已跳过本条消息"）

### 理由

- 现有机制已是"失败跳过、继续下一条"
- 降级逻辑复杂（需判断模式类型、区分场景），维护成本高
- 响应模式异常通常是开发者问题，应修复模式而非静默降级

---

## D7：现有机制迁移评估

### 问题

现有的 interactive/proactive/mention 机制能否顺利迁移到插件化接口？

### 迁移评估结果 ⚠️

**不能直接迁移，需要调整接口**

通过代码审查发现 4 个关键问题，全部已通过决策解决：

---

### D7.1：ProactiveRuntimeState 传递

**问题**：proactive 模式需要传递细粒度控制状态（suspendUntilCall、preTool1stMsgChk），但 `InboundDecision` 没有地方携带。

**决策 ✅**：`InboundDecision.runtimeState?: Record<string, any>`

```typescript
interface InboundDecision {
  action: 'process' | 'drop' | 'defer';
  queueBehavior?: 'enqueue' | 'priority' | 'clear-and-enqueue' | 'interrupt';
  reason?: string;
  runtimeState?: Record<string, any>;  // ← 新增
}
```

**用法**：
- proactive 模式的 `handleInbound` 返回 `{ action: 'process', runtimeState: { suspendUntilCall: true } }`
- MessageProcessor 将 `runtimeState` 存入 `context.sessionState`
- IMRenderer 或响应模式从中读取，实现细粒度控制

---

### D7.2：OutboundPayload 结构明确化

**问题**：无法判断是否工具调用，proactive 模式核心逻辑（"只有工具调用才发送"）无法实现。

**决策 ✅**：扩展 `kind` 枚举 + 加 `isToolCall` 便捷字段

```typescript
interface OutboundPayload {
  kind: 'text' | 'tool-call' | 'tool-result' | 'thought' | 'image' | 'file';  // ← 扩展
  content: string | Buffer;
  isToolCall?: boolean;  // ← 便捷判断
  metadata?: Record<string, any>;
}
```

**用法**：
- proactive 模式的 `handleOutbound` 判断 `payload.isToolCall` 或 `payload.kind === 'tool-call'`
- 只有工具调用时返回 `{ method: 'direct' }`，普通文本返回 `{ method: 'suppress' }`

---

### D7.3：Mention 过滤时机

**问题**：Channel Adapter 在入队前过滤未 @ 的消息，响应模式的 `handleInbound` 拿不到这些消息，无法做判断。

**决策 ✅**：Channel 标记不过滤，响应模式决定 drop

**改动**：
- Channel Adapter（aun.ts/feishu.ts）不再过滤，全部入队
- Message 携带 `isMentioned: boolean`（由 Channel 标记）
- selective-response 模式的 `handleInbound` 判断 `message.isMentioned`，未 @ 则 `{ action: 'drop' }`

---

### D7.4：IMRenderer 职责重叠

**问题**：IMRenderer 已有 chatMode 感知（proactive 判断是否 thought），与响应模式的 `handleOutbound` 职责重叠。

**决策 ✅**：IMRenderer 退化为纯"输出缓冲器"

**改动**：
- 移除 IMRenderer 的 chatMode 判断逻辑
- 只保留"收集输出、格式化、缓冲"功能
- chatMode 逻辑（什么时候发、发什么类型）全部由响应模式的 `handleOutbound` 接管

---

## D7 影响的接口调整总结

| 接口 | 新增/修改 | 用途 |
|------|-----------|------|
| `InboundDecision` | 新增 `runtimeState` 字段 | 传递 proactive 细粒度控制状态 |
| `OutboundPayload` | 扩展 `kind` 枚举，加 `isToolCall` | 判断工具调用，proactive 模式决策 |
| `InboundMessage` | 新增 `isMentioned` 字段 | Channel 标记，响应模式判断是否响应 |
| `ResponseModeContext` | 扩展 `channel.capabilities`，新增 `sessionState` | 查询渠道能力，存储会话状态 |

---

## 实施影响

### Phase 1（接口骨架）

- T1.1：接口定义包含 D7 所有调整

### Phase 2（队列分层）

- T2.3：Channel Adapter 改为"标记不过滤"（D7.3）

### Phase 3（核心运行时）

- T3.5：IMRenderer 退化重构（D7.4）

### Phase 6（内置模式）

- T6.1/T6.2：验证 interactive/proactive 完整迁移（含 runtimeState 传递）

---

## 文档位置

- **架构设计**：`architecture.md`
- **实施计划**：`implementation-plan.md`
- **迁移评估**：`migration-assessment.md`（详细代码审查）
- **决策总览**：本文档

---

最后更新：2026-06-23
