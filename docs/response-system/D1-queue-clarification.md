# D1 决策：队列机制的澄清与修正

## 现状澄清（基于代码审查）

### 当前实现的真实情况

**队列粒度**：
- `queueKey = sessionKey::projectPath`
- `sessionKey = channelType#channelId#threadId`
- 队列是 **per-session**（准确说是 per-(channelType, channelId, threadId, projectPath)）

**关键发现**：
1. ✅ **同一 agent 的不同会话共享队列**：多个 Session（不同 session.id）如果 channelId/threadId 相同，共享同一队列
2. ❌ **缺少 agent 隔离**：sessionKey 不含 selfAID，导致不同 agent 与同一对端的队列会冲突
   - `alice.aid → bob.aid` 的 queueKey = `aun#bob.aid#main::projectPath`
   - `carol.aid → bob.aid` 的 queueKey = `aun#bob.aid#main::projectPath`（相同！）

### 这是 bug 还是设计？

**判断**：这是一个**潜在 bug**，但在当前使用场景下可能没有暴露：

- 如果每个 evolclaw 实例只服务一个 agent（单 AID 部署），不会冲突
- 如果支持多 agent，但不同 agent 不会同时与同一对端通信，也不会暴露
- 但理论上，多 agent 实例应该支持 agent 隔离

---

## D1 决策需要回答的问题

### 问题 1：是否修复 agent 隔离问题？

**选项 A**：修复 sessionKey，加入 selfAID
- `sessionKey = channelType#selfAID#channelId#threadId`（或 `selfAID#channelType#channelId#threadId`）
- queueKey 自动包含 agent 隔离
- **影响**：破坏性变更，持久化队列格式变化，需要迁移逻辑

**选项 B**：queueKey 显式包含 selfAID，sessionKey 不变
- `queueKey = selfAID::sessionKey::projectPath`
- sessionKey 保持现状（不破坏其他依赖它的地方）
- **影响**：最小，只改 MessageQueue 内部

**选项 C**：不修复，声明单 agent 约束
- 文档声明：一个 evolclaw 实例只服务一个 agent
- 多 agent 场景启动多个独立进程
- **影响**：架构约束，但符合当前使用模式

**owner 决策**：选哪个？推荐 **B**（queueKey 加 selfAID，最小影响）。

---

### 问题 2：响应模式的逻辑队列绑定到什么？

现在明确了物理队列是 per-(agent, 对端, 话题)，那么响应模式的逻辑队列应该绑定到什么？

**答案**：**与物理队列同粒度** —— per-(agent, 对端, 话题)。

理由：
- 多个会话（不同 session.id）共享同一物理队列，也应该共享同一逻辑队列
- 响应模式是 per-session 配置的（不同会话可以用不同模式），但队列是共享的
- 这意味着：**当同一对端的会话切换响应模式时，需要切换逻辑队列（或者重建排序）**

**衍生问题**：
- 会话 A（interactive 模式，FIFO 队列）处理到一半
- 用户切换到会话 B（同一对端，dual-session 模式，Priority 队列）
- 队列里的消息顺序是否重排？

**推荐方案**：
- 逻辑队列与 **当前活跃会话的响应模式** 绑定
- 切换会话时，队列排序策略跟随切换（可能重排）
- 或者：一旦队列非空，禁止切换响应模式（提示用户"队列有待处理消息，请清空后再切换"）

**owner 决策**：允许动态切换并重排？还是队列非空时锁定模式？

---

### 问题 3：分层队列的具体形态

基于上述澄清，分层方案需要调整：

**物理队列**（现有 MessageQueue 单例）：
- 键：`queueKey = selfAID::sessionKey::projectPath`（如果修复 agent 隔离）
- 职责：去重（`recentMessageIds`，全局 60s 窗口）、持久化、中断、批量合并
- 粒度：per-(agent, 对端, 话题, 项目)

**逻辑队列**（响应模式持有）：
- 键：与物理队列同 queueKey（一一对应）
- 职责：**仅决定出队顺序**，持有待处理 messageId 的排序视图
- 生命周期：跟随响应模式实例；切换模式时可能重建

**取消息流程**：
1. Runner 问响应模式："下一个处理哪个？"
2. 响应模式的逻辑队列返回 messageId
3. Runner 从物理队列取该 messageId 的 Message 本体
4. 物理队列标记该消息为 processing

**关键调整**：
- 逻辑队列不是"per-session"而是"per-queueKey"（与物理队列同粒度）
- 响应模式实例可以是 per-session，但它持有的逻辑队列是共享的（通过 queueKey 索引）

**owner 决策**：接受这个调整后的分层方案？

---

## 总结：D1 需要的三个拍板

| # | 问题 | 推荐 | 阻塞 Phase |
|---|------|------|-----------|
| D1.1 | agent 隔离修复方案 | 选项 B（queueKey 加 selfAID） | Phase 2 |
| D1.2 | 响应模式切换时队列重排 | 队列非空时锁定模式 | Phase 3 |
| D1.3 | 分层队列形态（调整后） | 逻辑队列 per-queueKey，非 per-session | Phase 2 |

**下一步**：owner 逐个拍板 D1.1 / D1.2 / D1.3，我记录到 implementation-plan.md。
