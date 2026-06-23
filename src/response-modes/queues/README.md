# 队列实现（queues/）

响应模式的**逻辑队列**实现，只决定出队顺序，不持有消息本体。

> ⚠️ 见 architecture.md 第十章「难点 1」与 implementation-plan.md D1：
> 逻辑队列（排序）与现有进程级单例 MessageQueue（物理队列：去重/持久化/中断）分层。
> 落地形态取决于 D1 决策。

| 文件 | 队列 | 出队顺序 |
|------|------|----------|
| fifo-queue.ts | FIFO | 先进先出（默认）|
| lifo-queue.ts | LIFO | 后进先出 |
| priority-queue.ts | Priority | 按 priorityFn 排序 |
| custom-queue.ts | Custom | 按 compareFn 排序 |

接口：`MessageQueueInterface`（types.ts）。当前为占位目录，待 Phase 2 填充。
