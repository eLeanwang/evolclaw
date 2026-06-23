# 群聊积压按时间线合并消息 - 设计文档

- **日期**：2026-06-13
- **状态**：已调整，待验证
- **背景关联**：[[已落地] 群聊同人连发打断](../../../src/core/message/message-queue.ts)

## 1. 问题

群里一条消息进来，多个 agent 各自回复；这些回复又作为新入站消息投递给其他 agent。LLM 推理速度远慢于群聊消息产生速度时，`MessageQueue` 会快速堆积。

之前考虑“按 role 合并”，但这个方案有重大隐患：它会切断群聊时间线。

典型场景：

```text
owner: 有个问题 A
evolagent: 我去处理
```

如果 evolai 正在执行，积压消息按 role 分批，那么 evolai 执行完后可能只看到 owner 的问题 A，看不到 evolagent 已经接手，于是重复处理。

## 2. 目标

当一个 agent 在群聊里产生积压时，将待处理消息按**完整时间线**合并成一次推理，而不是按发送者或 role 拆成多次推理。

目标是减少推理轮数，同时保证模型看到群里已经发生过的上下文，尤其是其他 agent 的接手、回复和补充。

非目标：限制 agent 最终回复几条。一次推理后，proactive agent 自行决定是否回复、回谁、发几条。

## 3. 核心决策

### 3.1 群聊合并不按 role 分批

群聊入队时仍捕获 `session.identity.role`，但 role 只作为每条消息的元数据，不再作为队列切分边界。

- 群聊 pending 一律合并为一个时间线批次。
- 批次内每条消息保留自己的 `peerId/peerName/peerType/peerRole/timestamp/images/mentionAids`。
- 渲染层逐条渲染 `SubMessage`，模型能看到每条是谁说的、什么 role。
- `Message.batchRole` 只有当批内 role 完全一致时才设置；混合 role 批次不设置，避免把整个批次误当 owner/admin。

### 3.2 role 只做逐条上下文，不做策略提升

批次中混入 owner 发言时，不应让整个批次获得 owner 策略。

- 通道策略、permission mode、是否显示中间输出仍基于当前 session 的身份/配置。
- 消息正文中通过 `SubMessage.peerRole` 告诉模型每条消息的真实 role。
- 命令仍走 MessageBridge 快速路径，不进入队列合并。

### 3.3 群聊 peerKey 固定为 groupId/channelId

群聊关系层 peerKey 统一使用群级标识：

```text
formatPeerKey(channelType, session.metadata.groupId || message.channelId)
```

私聊仍使用发送者 `peerId`。

这样单条群聊消息和合并批次不会因为“是否积压”而切换关系级模型/资料。代价是群聊里不会自动使用某个成员的个人 relation；如果未来需要，应做 SubMessage 级成员资料注入，而不是让顶层 peerKey 在群和人之间摇摆。

### 3.4 same-peer 打断只允许单发送者批次

`currentPeerId` 表示当前在途任务的唯一真实发送者：

```ts
const peers = new Set(items.map(item => item.message.peerId).filter(Boolean));
currentPeerId = peers.size === 1 ? [...peers][0] : undefined;
```

- 单发送者批次：同一人继续发、且队列里没有其他人消息时，可以打断。
- 多发送者群聊批次：`currentPeerId = undefined`，后续消息排队，避免聚合推理被其中某个成员不断打断。

## 4. 持久化

队列 pending 和正在执行中的 active batch 都必须持久化，避免进程重启后积压消息或 in-flight 消息静默丢失。

- 持久化文件：`data/message-queue.json`。
- 保存 `queues`（pending）和 `active`（已出队、handler 尚未结束）。
- 恢复语义按三态处理：
  - `queued`：来自 `queues`，原样恢复并重新投递。
  - `submitted`：来自 `active`，说明重启前已交给 runner，恢复时不重放原始消息，只生成 `evolclaw 服务已重启，请继续之前未完成的任务。`。
  - `completed`：handler 已返回并删除 active，不恢复。
- 如果 `submitted` 后面还有 pending，最终 prompt 形态是“重启继续提示 + `【新消息插入】pending 时间线【请根据前后消息酌情处理】`”，避免 active 原文在 runner 上下文里出现两次。
- 恢复后重新组装 pending 队列，并把 messageId 加回短期去重窗口，防止同一条消息重复入队；active 原始 messageId 也加入去重窗口，但不进入 prompt。
- handler 成功或失败返回后删除对应 active batch；只有进程死在 handler 中途时才会在下次启动重试。
- 启动时先恢复持久化队列；如果某个 processing session 已有持久化任务，则跳过旧的“服务已重启，请继续之前未完成的任务。”兜底恢复，避免重复任务。

## 5. 改动清单

1. `message-bridge.ts`
   - 群聊入队时传入 `role: session.identity?.role ?? 'anonymous'`。

2. `message-queue.ts`
   - pending 保持原子消息，不在入队时合并。
   - `dequeueGreedy` 对群聊取出当前所有 pending 群聊项，按 timestamp 排序后合并。
   - `mergeItems` 生成 `message.items`，逐条保留 `peerRole`。
   - `batchRole` 仅在批内 role 完全一致时设置。
   - `currentPeerId` 对多发送者批次置空。
   - pending 和 active batch 持久化到 `data/message-queue.json`；active 恢复为 submitted resume，不重放原始 active 内容。

3. `message-processor.ts`
   - 群聊 `peerKey` 固定使用 `groupId/channelId`。
   - 系统策略使用 session identity，不使用混合批次 role。
   - 单条消息 fallback item 使用 `message.batchRole || session.identity.role`；批量消息以 `items[].peerRole` 为准。

4. `message-renderer.ts` / `kits/templates/message-fragments/item.md`
   - 每条 item 渲染时注入 `peerRole`。
   - 群聊批次正文能显示每条发言者及其 role。

## 6. 行为示例

群聊中 evolai 正在执行，期间积压：

```text
owner: 问题 A
evolagent: 我去处理
owner: 好
```

改后 evolai 下一轮看到一个批次：

```text
owner(role:owner): 问题 A
evolagent(role:guest): 我去处理
owner(role:owner): 好
```

模型可以判断问题 A 已经有人接手，不应重复执行。

## 7. 风险与边界

- 混合 role 批次不提升系统策略，owner 在正文中的要求只作为对话上下文，不自动改变 permission mode。
- 群聊关系层固定为 group relation，成员个人 relation 不自动生效。
- 重启会恢复 pending；active 只作为 submitted resume 提示，不重放原始 active 内容。这避免 runner 上下文重复注入同一条用户消息，但仍要求模型/runner 根据历史继续未完成工作。
- timestamp 相同的消息依赖入队顺序保持稳定；当前 JS sort 是稳定排序，满足同毫秒入队场景。
