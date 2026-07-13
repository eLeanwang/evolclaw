# Restart Monitor 通知改造：区分发起人回执与 daemon 运维告警

## 背景

`/restart` 会把触发会话写入 `data/restart-pending.json`，新主进程启动成功后可以通过对应 ChannelAdapter 发送“重启成功”通知。

但 `restart-monitor` 是主进程退出后的独立子进程，不持有 ChannelAdapter。当前实现为了在启动失败、自动修复、升级失败等阶段还能通知用户，在子进程内直接实现了部分渠道发送逻辑：Feishu 走 Lark SDK，WeChat 走 HTTP API。

历史语义上，`restart-pending.json` 的目的不是 daemon owner 告警，而是记录“谁从哪个渠道/会话发起了重启”，让重启完成后能回到发起人的发起渠道通知结果。话题场景中还会保存 `rootId`，用于重启后回复到原话题。

因此，通知不能简单改成“只发 daemon owners”。更准确的改造方向是区分两类通知：

1. 发起人回执：面向触发 `/restart` 或 `/system restart` 的人，说明重启已受理或新主进程已启动成功。
2. daemon 运维告警：面向 daemon owners，说明 daemon 级维护事件、自动修复过程和需要人工介入的问题。

## 当前问题

- `restart-monitor` 的通知分支绑定外部 IM 渠道，当前只覆盖 Feishu/WeChat。
- `restart-monitor` 把启动失败、自动修复、升级结果、最终失败等不同语义的通知全部发给 `restart-pending.json` 中记录的发起会话。
- 如果继续给每个渠道补直发实现，会让子进程重复维护各渠道协议细节。
- 发起人回执和 daemon 运维告警没有被建模为两个不同目标，导致后续讨论容易把“谁发起通知谁”和“daemon owner 运维告警”混为一谈。
- 该问题与“Feishu 消息经 AUN 代理转发”无关，不应混入 AUN 代理设计。

## 目标行为

- 发起人仍应在发起渠道收到重启结果：
  - 新主进程启动成功后，由主进程 adapter 路径发送“重启成功”。
  - 如果新主进程没有启动成功，就不再强行通过外部 IM 直发回到原渠道；失败和自愈过程改走 daemon 运维告警。
- daemon 运维告警通过 AUN 发送给 daemon 配置中的 owners，而不是触发 `/restart` 的 agent owners。
- 因为 `/restart` 本身只允许 daemon owner 触发，发起人通常也会在 owners 中；失败时他会收到 daemon AID 发来的 AUN 运维告警，但不保证回到原外部 IM 会话。
- daemon 运维告警覆盖：
  - 依赖升级成功/失败；
  - 服务启动失败；
  - 自动修复开始、进行中、成功、失败；
  - 需要人工介入的最终失败。
- `restart-monitor` 不再为每个外部 IM 渠道扩展完整直发逻辑。

## 建议方案

### 1. 明确通知分类

定义两个通知目标：

- `requester`: 来自 `restart-pending.json`，表示本次重启的发起渠道和会话。
- `daemonOwners`: 来自 daemon 级配置 `evolclaw.json.owners`，表示 daemon 运维负责人。

`restart-pending.json` 继续保留 `channel`、`channelId`、`timestamp`、`rootId` 等字段，只表达发起人回执上下文，不承担 daemon owner 定位职责。

### 2. 发起人回执路径

- 成功回执继续由新主进程处理，因为新主进程已经持有 ChannelAdapter，可以使用统一出站路径发送到 `pending.channelId`。
- `restart-monitor` 不再负责“回到发起人的外部 IM 渠道”发送失败回执。原因是主进程未恢复时没有 ChannelAdapter，继续在子进程里补 Feishu/WeChat/其它渠道直发会让 monitor 变成第二套渠道实现。
- 当新主进程没有启动成功时，失败信息进入 daemon owner 告警路径。

### 3. daemon owner 告警路径

- 在 `restart-monitor` 中读取 daemon 级 owners。
- 读取 `evolclaw.json.aid` 作为 daemon AID。
- 通过 daemon AID 调用 `ec msg send`，向每个 owner AID 发送运维告警：

  ```bash
  ec msg send <daemon-aid> <owner-aid> --text-from-file <notice-file> --app restart-monitor --format json
  ```

  实现上可以直接调用 `ec msg send` 背后的 `msgSend` API，避免在 `restart-monitor` 中再 fork 一个 CLI 子进程。

- 告警内容包括升级结果、启动失败、自愈开始、自愈进度、自愈成功、自愈失败和最终人工介入。
- 如果 daemon 未配置 `aid` 或 owners，monitor 只写日志，不 fallback 到发起人的 agent 渠道。

### 4. `restart-monitor` 内部调整

- 移除当前 `notifyChannel(p, pendingInfo, message, log)` 的发起渠道直发语义，改为：
  - 成功回执：不在 `restart-monitor` 中实现，继续由新主进程发送。
  - `notifyDaemonOwners(p, message, log)`：通过 daemon AID 执行 `ec msg send` 同路径发送，只用于 daemon 运维告警。
- 启动成功路径不在 `restart-monitor` 发送发起人成功回执，继续交给新主进程。
- 启动失败、自愈过程和自愈最终失败全部只发 daemon owners。
- 自愈最终失败的 daemon owner 告警包含完整修复记录路径和人工介入提示。

### 5. 兼容策略

- 第一阶段新增 `ec msg send` daemon owner 告警，并把启动失败、自愈过程、最终失败迁到该路径。
- 迁移完成后删除 `restart-monitor` 中现有 Feishu/WeChat 子进程直发分支。
- `restart-pending.json` 继续只供新主进程发送“重启成功”回执使用。

## 非目标

- 不在本方案中解决 Feishu 经 AUN 代理后的 origin/session 映射。
- 不把 agent owners 当作 daemon 运维通知收件人。
- 不在 `restart-monitor` 中重新创建完整 ChannelAdapter。
- 不保证主进程无法启动时仍回到发起人的外部 IM 渠道发送失败消息；该场景改由 daemon AID 通知 daemon owners。
