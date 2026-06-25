# EvolClaw Control Plane / Agent Runtime 分拆方案

日期：2026-06-18

## 1. 背景

当前 EvolClaw 已有两个身份概念：

- daemon/control 身份：`evolclaw.json.aid`，用于控制 AID、进程级 owner 鉴权、远程管理入口。
- self-agent 身份：`agents/<aid>/config.json`，用于真正接入渠道、处理消息、运行 baseagent。

但当前运行时生命周期仍然强耦合：正式 daemon 启动要求至少加载一个 self-agent。无 self-agent 时，普通 `evolclaw start` 在 CLI 层退出；即使绕过 CLI，`src/index.ts` 中正式 daemon 也会在 `agentInfos.length === 0` 时退出。

现有 `EVOLCLAW_BIND_BOOTSTRAP=1` 已经提供了一个 bootstrap daemon 雏形：启动 control AID、IPC、`BindService`，不加载 Agent Runtime。但它目前只支持绑定流程，不支持远程创建首个 agent，也不是一个完整 control plane。

## 2. 问题

当前耦合导致三类问题：

1. 新装主机无法先启动可远程管理的 daemon，再通过 Evol App/menu 协议创建首个 agent。
2. 删除最后一个 agent 后，当前进程可能还能短暂存在，但下一次正式 daemon 启动会失败。
3. control 能力和 agent runtime 非此即彼：没有 self-agent 时 control 也无法作为稳定管理面存在。

核心目标是切断这条依赖：

```text
当前：daemon 可用 => 必须至少一个 runnable self-agent
目标：control 可用 => 不依赖 self-agent
      runtime 可用 => 依赖至少一个 runnable self-agent
```

## 3. 目标

- Control Plane 永远可启动，只依赖 `evolclaw.json.aid` 和本地配置。
- Agent Runtime 仅在存在 runnable self-agent 时启动。
- 新装主机可完成：初始化 control AID -> 绑定 owner -> bootstrap/control-only 在线 -> 远程创建首个 agent -> 切换 full runtime。
- 删除最后一个 agent 后不进入不可恢复状态，而是降级到 control-only，允许远程恢复。
- 保持正式 Agent Runtime 的启动硬约束，避免把大量 runtime 代码改成 nullable 半初始化状态。

## 4. 非目标

- 第一阶段不做多进程物理拆分。
- 第一阶段不开放完整 `/system`、`/gateway`、runtime 级菜单到 bootstrap。
- 不让普通 agent channel 获得进程级控制权限。
- 不改变 self-agent 的执行模型：agent 仍由 daemon/runtime 托管，不变成独立进程。

## 5. 目标架构

### 5.1 Control Plane

Control Plane 负责不依赖 self-agent 的能力：

- control AID AUN 连接，`pureIdentity: true`
- `evolclaw.json.owners` 鉴权
- IPC server
- bind service
- bootstrap/control menu 协议
- agent 配置生命周期：create/list/show/delete/progress
- process status：`mode`、control AID 状态、runtime 状态
- runtime lifecycle：start/stop/restart/resync

### 5.2 Agent Runtime

Agent Runtime 负责依赖 self-agent 的能力：

- `EvolAgentRegistry`
- channel loader 和 agent AUN/channel 连接
- message bridge / queue / session manager
- baseagent runner
- trigger scheduler
- agent 自管理菜单
- runtime reload/hot-load/resync

### 5.3 运行模式

| 模式 | 条件 | 能力 |
| --- | --- | --- |
| `control-only` | 无 runnable self-agent，或 runtime 未启动 | control AID、IPC、bind、受限 agent menu |
| `full` | 至少一个 runnable self-agent 且 runtime 启动成功 | control plane + agent runtime 全量能力 |
| `runtime-error` | 存在 agent 但 runtime 初始化失败 | control 可用，runtime 错误可查询，可远程修复配置 |
| `shutting-down` | stop/restart 中 | 停止接收新 runtime 任务，control 做收尾 |

## 6. 分阶段落地

### 阶 1：增强 bootstrap control

目标：用最小改动解决首装远程创建和最后 agent 删除后的恢复闭环。

改动范围：

1. bootstrap daemon 增加 `menu.*` 处理。
   - 当前 `runBindBootstrapDaemon()` 只处理 `bind.request`。
   - 新增 `handleBootstrapMenu(payload, peerId)`。
   - 所有响应使用 `controlChannel.sendStructured()`，不要用 `sendMessage(JSON.stringify(...))` 包文本。

2. bootstrap menu 只开放窄口能力。
   - `menu.list`：返回最小控制菜单。
   - `menu.options name=agent`：返回已有 agent 列表，首装为空。
   - `menu.query name=agent`：查询 agent 详情或创建进度。
   - `menu.action name=agent action=create`：创建 agent。
   - 其他 name/action 一律返回 `NOT_SUPPORTED`。

3. 鉴权规则。
   - `bind.request` 保持现有 token 绑定逻辑。
   - `menu.*` 必须要求 `peerId` 属于 `evolclaw.json.owners`。
   - owners 为空时仅允许 local IPC 创建 bind task，不允许远程 menu。

4. 创建 agent。
   - 复用 `agentCreateNonInteractive()`。
   - 可复用或抽出 `runCreateInBackground()` 的创建进度写入逻辑。
   - `peerId` 自动作为新 agent owner。
   - `project` 兜底规则复用 `resolveProjectPath()`：显式值 > `defaults.projects.rootPath/<aid-prefix>` > `defaults.projects.defaultPath`。

5. 创建进度。
   - 读取 `agents/<aid>/create-status.json`。
   - 即使 `config.json` 尚未写完，也应能返回 `createProgress`，避免创建初期误报 `NOT_FOUND`。

6. 创建完成后的切换策略。
   - MVP 采用保守策略：返回 `requiresRestart: true`，提示 App 或用户执行 restart。
   - 不在阶段 1 自动把 bootstrap 原地升级 full daemon。

7. CLI 入口。
   - 新增显式入口：`evolclaw start --bootstrap` 或 `evolclaw daemon bootstrap`。
   - `evolclaw init` 在无 agent 时提示：
     - 本地创建：`evolclaw agent new <aid>.agentid.pub`
     - 远程创建：`evolclaw start --bootstrap`

验收标准：

- 无 self-agent 的新主机可以启动 bootstrap daemon。
- owner 可通过 control AID 发送 `menu.action agent:create` 创建首个 agent。
- 非 owner 发送 menu 被拒绝或静默忽略。
- 创建中可查询进度。
- 创建完成后普通 `evolclaw restart` 可进入 full daemon。
- 删除最后一个 agent 后可进入/保持 bootstrap control 并远程重建。

预计成本：1-3 天。

### 阶段 2：同进程 Control Plane / Agent Runtime 分层

目标：在一个 Node 进程内拆清生命周期，正式启动不再因为无 self-agent 退出，而是进入 control-only。

建议结构：

```text
src/index.ts
  createControlPlane()
  startControlPlane()
  maybeStartAgentRuntime()

ControlPlane
  controlChannel
  ipcServer
  bindService
  process-level menu
  runtime lifecycle adapter

AgentRuntime
  agentRegistry
  channelLoader
  messageBridge
  messageQueue
  sessionManager
  runners
  triggers
```

主要改动：

1. 抽出 Control Plane 初始化。
   - control AID 启动在 Agent Runtime 之前完成。
   - IPC `status` 增加 `mode`、`runtime` 字段。
   - control menu 在 full/control-only 下使用同一鉴权口径。

2. 抽出 Agent Runtime 初始化。
   - `loadAllAgents().agents.length === 0` 不再 `process.exit(1)`。
   - 无 agent 时返回 `runtime.status = "not_configured"`。
   - 有 agent 但 runner/channel 初始化失败时返回 `runtime.status = "error"`，control plane 继续在线。

3. Command/menu 降级。
   - process-level agent create/list/show/delete 不依赖 runtime。
   - runtime-only 命令在 `control-only` 下返回 `RUNTIME_UNAVAILABLE`。
   - `/agent create` 成功后可调用 `startRuntime()` 或返回 `requiresRuntimeStart`。

4. 最后 agent 删除。
   - 允许删除。
   - runtime resync 下线最后 agent 后，runtime 状态变为 `not_configured`。
   - control plane 继续在线。

5. 热启动 runtime。
   - 首个 agent 创建完成后优先尝试 `startRuntime()`。
   - 如果热启动失败，保留 control plane 并返回错误，允许远程修复/重试。

验收标准：

- 普通 `evolclaw start` 在无 agent 时仍成功，但状态为 `control-only`。
- 有 agent 时自动进入 `full`。
- runtime 初始化失败不杀 control。
- 删除最后 agent 后 status 变为 `control-only/not_configured`。
- 创建首个 agent 后无需手动重启即可进入 full，或明确返回热启动失败原因。

预计成本：5-10 个工作日。

### 阶段 3：多进程物理分拆（可选）

目标：control 进程常驻，runtime 作为子进程或独立进程被 control 管理。

进程形态：

```text
evolclaw-control
  - control AID
  - IPC public endpoint
  - owner/menu/process control
  - runtime supervisor

evolclaw-runtime
  - agent registry
  - channels
  - queues/sessions/runners/triggers
```

额外成本：

- control/runtime IPC 协议和版本兼容。
- runtime 崩溃恢复和 backoff。
- 双进程日志、ready signal、instance registry。
- stop/restart/upgrade 语义重做。
- Windows/macOS/Linux 后台进程差异。
- 配置写入并发锁。
- ECWeb/CLI/status 适配双进程状态。

预计成本：2-4 周。

建议：只有在阶段 2 稳定后再评估，不作为首轮目标。

## 7. 协议设计

### 7.1 bootstrap agent create

请求：

```json
{
  "type": "menu.action",
  "id": "req-001",
  "name": "agent",
  "action": "create",
  "args": {
    "aid": "mybot.agentid.pub",
    "name": "mybot",
    "baseagent": "codex",
    "project": "/home/evolclaw/projects/mybot"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "req-001",
  "name": "agent",
  "data": {
    "accepted": true,
    "aid": "mybot.agentid.pub",
    "mode": "bootstrap",
    "requiresRestart": true
  }
}
```

### 7.2 bootstrap create progress

请求：

```json
{
  "type": "menu.query",
  "id": "req-002",
  "name": "agent",
  "args": {
    "aid": "mybot.agentid.pub"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "req-002",
  "name": "agent",
  "data": {
    "aid": "mybot.agentid.pub",
    "exists": true,
    "createProgress": {
      "status": "ready",
      "currentPhase": null
    }
  }
}
```

## 8. 安全边界

- bootstrap 远程入口只接受 control AID 私聊/合法 AUN envelope。
- 远程 `menu.*` 必须校验 `peerId in evolclaw.json.owners`。
- owners 为空时不可远程创建 agent；必须先通过本地 IPC + QR bind 或手动配置 owner。
- bootstrap 不开放 shell/CLI passthrough。
- bootstrap 不开放 gateway 凭证写入。
- bootstrap 不开放 delete/enable/disable/reload 等破坏性动作，除非后续单独设计。
- agent create 的 `project` 必须是绝对路径；若使用默认路径，由 daemon 生成。

## 9. 主要风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| bootstrap 权限面扩大 | 远程越权 | 窄口 allowlist，只放行 agent create/query/list |
| 创建首个 agent 后热启动复杂 | 状态不一致 | 阶段 1 只要求 restart，阶段 2 再做热启动 |
| `sendMessage(JSON.stringify())` 导致 App 收不到 typed payload | 协议不可用 | bootstrap 统一使用 `sendStructured()` |
| 创建早期 query 查不到 config | UI 误报失败 | query 先读 `create-status.json`，再读 config |
| 删除最后 agent 后 runtime 空状态未处理 | 队列/channel 残留 | resync 下线 runtime，status 显示 `control-only` |
| 同进程阶段仍有隐式全局变量 | 生命周期混乱 | 收敛 `globalThis.__evolclaw_*` 到 runtime lifecycle adapter |

## 10. 测试计划

### 单元测试

- bootstrap menu owner 鉴权。
- 非 owner menu 拒绝。
- `agent:create` 参数校验。
- create progress 在无 config 时可返回。
- owners 为空时 menu 拒绝。

### 集成测试

- 空 `agents/` 启动 bootstrap。
- 通过 AUN/control message 创建首个 agent。
- 创建完成后 restart 进入 full daemon。
- 删除最后一个 agent 后 resync 下线 runtime。
- 删除最后一个 agent 后重新创建并恢复 full。

### 回归测试

- 现有 `evolclaw init` QR bind。
- 普通 `evolclaw start` 有 agent 时行为不变。
- `/agent create/delete/list/show` 在 full daemon 下行为不变。
- control AID owner 鉴权不回退。

## 11. 推荐实施顺序

1. 修正 bootstrap `bind.response`/后续 `menu.response` 为 `sendStructured()`。
2. 增加 bootstrap menu allowlist executor。
3. 增加 `evolclaw start --bootstrap` 显式入口。
4. 支持 bootstrap `/agent create` 和进度查询。
5. 调整删除最后 agent 的提示和文档口径。
6. 增加 status `mode` 字段。
7. 开始阶段 2 同进程生命周期重构。

## 12. 结论

最合理的路线不是马上做多进程拆分，而是先把 control plane 从 self-agent 依赖中解耦。

短期通过增强 bootstrap control 解决闭环问题；中期在同进程内拆出 Control Plane 和 Agent Runtime；长期再评估是否需要物理多进程。这样改动可控，每个阶段都有独立收益，也能避免把正式 daemon 改成大量 nullable 半初始化状态。
