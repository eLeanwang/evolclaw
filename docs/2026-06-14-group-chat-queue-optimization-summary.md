# 群聊队列优化总结报告

**日期**：2026-06-14  
**状态**：已完成，已通过单测与构建验证

## 一、背景

群聊场景下，多个 agent 会持续并发发言。旧方案如果按 `role` 分批，容易把群聊时间线切断，导致模型在积压恢复后看不到“别的 agent 已经接手”的上下文，从而重复执行。

同时，队列在入队阶段做过度合并，会让队列数量不准确，影响状态展示、调试和恢复判断。

## 二、目标

1. 保证群聊积压按完整时间线合并，而不是按发送者或 `role` 拆分。
2. 保证队列长度真实可见，便于监控和排障。
3. 保证重启恢复时不重复注入 active 原文。
4. 保证同人连发打断只作用于单发送者批次，不打断多发送者聚合批次。

## 三、核心决策

### 1. 群聊队列改为“入队原子，出队合并”

- 入队阶段不合并消息，pending 保持原子粒度。
- 出队阶段再按时间线贪心合并。
- 队列显示数量直接反映真实 pending 数量。

### 2. 群聊 `peerKey` 固定为群级标识

- 群聊关系层统一使用 `groupId/channelId`。
- 私聊继续使用发送者 `peerId`。
- 这样单条消息和合并批次不会因为是否积压而切换关系上下文。

### 3. `role` 只做逐条元数据，不做批次策略提升

- 入队时捕获 `session.identity.role`。
- 合并后每条消息保留自己的 `peerRole`。
- `batchRole` 只有批内 role 完全一致时才设置。
- 系统策略仍按 session identity 计算，不因混合批次误升权。

### 4. `currentPeerId` 只用于单发送者批次

- 单发送者批次允许同人连发打断。
- 多发送者群聊批次 `currentPeerId = undefined`。
- 这样不会让聚合批次被某个成员的新消息不断打断。

### 5. 重启恢复要持久化 `queues` + `active`

- `queues` 保存未处理 pending。
- `active` 保存已出队、handler 尚未结束的 batch。
- 恢复时：
  - `queued` 原样恢复；
  - `submitted` 只恢复成“服务已重启，请继续之前未完成的任务。”；
  - `completed` 不恢复。
- 若 `submitted` 后还有 pending，则组装成：
  - 重启提示
  - `【新消息插入】...【请根据前后消息酌情处理】`

## 四、实现落点

### `src/core/message/message-bridge.ts`

- 群聊入队时传入 `role: session.identity?.role ?? 'anonymous'`。
- 群聊不再走入队合并，交给队列出队时统一聚合。

### `src/core/message/message-queue.ts`

- pending 保持原子消息。
- `dequeueGreedy()` 在出队时合并群聊时间线。
- `mergeItems()` 生成 `message.items`，逐条保留 `peerRole`。
- `batchRole` 只在批内一致时设置。
- `currentPeerId` 对多发送者批次置空。
- `queues` 与 `active` 一并持久化到 `data/message-queue.json`。
- 重启恢复时，`active` 不重放原文，只生成 resume 提示。

### `src/core/message/message-processor.ts`

- 群聊 `peerKey` 固定使用 `groupId/channelId`。
- 渲染层按 `message.items` 逐条渲染。
- 单条消息 fallback 使用 `message.batchRole || session.identity.role`。
- 批量消息以 `items[].peerRole` 为准。

### `src/eck/message-renderer.ts` 与 `kits/templates/message-fragments/item.md`

- 每条 item 都注入 `peerRole`。
- 群聊正文可以直接看到每条消息的真实发送者和 role。

### `src/index.ts`

- 启动时先恢复持久化队列。
- 若已有 persisted queue，则跳过泛化的兜底 resume，避免重复注入。

## 五、验证结果

已完成的验证：

- `npx vitest run tests/unit/message-queue.test.ts tests/unit/message-queue-persistence.test.ts tests/unit/message-queue-agent.test.ts tests/unit/message-queue-project.test.ts tests/unit/processor-group-peerkey.test.ts`
- `npx tsc --noEmit`
- `npm run build`

结果：

- 55 个相关测试全部通过。
- 构建通过。
- 关键场景已覆盖：
  - 群聊时间线合并
  - mixed role 批次
  - 重启恢复
  - active 不重复注入
  - 同人连发打断守卫
  - 队列长度统计准确

## 六、结论

这次优化的核心结果是：

1. 群聊不再按 `role` 截断时间线。
2. 队列数量与真实 pending 对齐。
3. 重启恢复不会重复注入 active 原文。
4. 多发送者群聊批次不会被单个成员反复打断。

当前实现与设计预期一致，未见重大隐患。

## 七、后续边界

- 群聊关系层固定为 group 关系，成员个人 relation 不自动生效。
- 如果未来要给群聊里的单个成员注入个人资料，应走 `SubMessage` 级注入，而不是把顶层 `peerKey` 改回按人切换。
