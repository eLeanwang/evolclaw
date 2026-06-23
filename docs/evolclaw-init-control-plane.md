# EvolClaw 云部署 Control Plane 初始化方案

## 1. 背景与目标

目标是在云部署链路中支持用户从 Evol App 一键开通 EvolClaw：

```
evol-app
  -> evol-backend
  -> deploy-backend
  -> deploy-server
  -> evolclaw container
```

当前“开通权限 / 创建容器”已经打通，卡点在容器内初始化 EvolClaw、绑定 owner，并让用户随后可以从 App 通过控制 AID 发送 `menu.*` 指令管理 EvolClaw。

本方案采用“后端可信 owner 直写”的方式：

- `evol-backend` 已认证用户身份，知道用户的 `ownerAid`。
- `deploy-backend/deploy-server` 通过可信内部链路把唯一 `ownerAid` 注入容器。
- 容器内 `evolclaw init --non-interactive --owner <aid>` 直接写入 `evolclaw.json.owners = [ownerAid]`。
- `evolclaw start` 启动 Control Plane。Control Plane 永远可启动，不依赖 self-agent。
- 用户随后可以通过 App 的远程 `menu.*` 指令创建/配置 self-agent；Agent Runtime 只在存在 runnable self-agent 时启动。
- `deploy-server` 通过 IPC `status` 轮询 Control Plane readiness，不解析 CLI 人类输出。

不再把 QR 绑定作为云部署主路径。QR 绑定仅作为可选兜底，用于后端无法可信取得 owner AID 的场景。

预期效果：

1. 没有任何 self-agent 时，`evolclaw start` 仍能启动 Control Plane。
2. Control Plane ready 后，IPC、control AID、owner 鉴权、进程级 `menu.*` 可用。
3. owner 绑定或 owner 直写只完成“谁能控制此 EvolClaw 实例”的授权，不自动启动 Agent Runtime。
4. App 通过 `controlAid` 发送 `menu.agent.create` 后，Control Plane 创建 self-agent 配置/AID。
5. 新 self-agent 创建完成后，Agent Runtime hot-load 该 agent，并从 `empty` 进入 `running`。

---

## 2. 角色边界

| 角色 | 职责 |
|------|------|
| `evol-app` | 用户入口。发起一键开通，开通完成后通过控制 AID 发送 `menu.*`。 |
| `evol-backend` | 认证用户，确认用户 `ownerAid`，发起开通请求。 |
| `deploy-backend` | 对外服务编排层。校验授权，向 deploy-server 下发部署任务。 |
| `deploy-server` | 管理 EvolClaw 运行容器，执行容器内初始化命令，轮询 IPC ready。 |
| `evolclaw` | 容器内运行时。生成/持有控制 AID、写配置、启动 daemon、提供 IPC 和远程 menu 控制面。 |

命名约定：

- `controlAid` 与旧文档里的 `daemonAid` 是同一个东西，后续统一使用 `controlAid`。
- `ownerAid` 只支持唯一 owner。配置文件中仍写为数组 `owners: [ownerAid]`，用于兼容现有结构。
- `agentAid` 是 Agent Runtime 管理的 self-agent AID，可在部署阶段预创建，也可在 Control Plane ready 后由 App 通过 menu 远程创建。

---

## 3. Daemon 分层目标

EvolClaw daemon 拆为两个逻辑层：

### 3.1 Control Plane

Control Plane 永远可启动，不依赖 self-agent。它负责：

- control AID 连接。
- `evolclaw.json.owners` 鉴权。
- IPC。
- `menu.*` 协议的进程级能力。首阶段至少支持 agent create/list/show/progress、gateway/defaults/project 查询与修改。
- agent create/list/show/delete/progress。
- gateway / defaults / project 配置。
- runtime start/stop/restart 管理。

云部署的一键开通只要求 Control Plane ready。达到这个状态后，App 就可以通过 `controlAid` 发送远程 menu 指令继续配置 EvolClaw。

Control Plane 不应依赖以下对象已经存在：

- primary self-agent。
- baseagent runner。
- agent channel adapter。
- active session。
- message queue 中的可执行任务。

因此，控制面入口不能直接复用只适用于 Agent Runtime 的 `CommandHandler` 全量实例，除非该实例能在空 agent 状态下安全构造。更稳妥的实现是抽出轻量的 process-level menu executor，先覆盖云部署所需的进程级能力，再逐步接回现有 menu 能力。

### 3.2 Agent Runtime

Agent Runtime 仅在存在 runnable self-agent 时启动。它负责：

- 加载 `EvolAgentRegistry`。
- 创建 agent AUN/channel。
- session / message queue。
- baseagent runner。
- trigger。
- agent 自管理菜单。

没有 runnable self-agent 时，Agent Runtime 状态为 `stopped` / `empty`，但 Control Plane 仍保持可用。

推荐状态定义：

| 状态 | 含义 |
|------|------|
| `empty` | 磁盘上没有 runnable self-agent；Control Plane 正常运行。 |
| `starting` | 已发现 runnable self-agent，正在创建 runner/channel/queue。 |
| `running` | 至少一个 self-agent 已完成 Runtime 启动。 |
| `stopped` | Runtime 被显式停止，但 Control Plane 仍运行。 |
| `error` | Runtime 启动失败；Control Plane 仍运行并可用于修复配置。 |

`empty` 和 `error` 都不应导致 daemon 退出。只有 Control Plane 自身无法启动时，daemon 才应启动失败。

---

## 4. 推荐部署流程

### 4.1 总体流程

```
用户在 evol-app 点击一键开通
  ↓
evol-backend 校验登录态，确定 ownerAid
  ↓
deploy-backend 创建部署任务
  ↓
deploy-server 创建/启动容器
  ↓
容器内执行 evolclaw init --non-interactive --owner <ownerAid>
  ↓
容器内执行 evolclaw start
  ↓
deploy-server 轮询 IPC status，等待 Control Plane ready
  ↓
返回 controlAid、controlReady 状态
  ↓
evol-app 使用 controlAid 发送 menu.* 远程配置 EvolClaw
  ↓
用户通过 App 创建/配置 agent
  ↓
Control Plane hot-load 新 agent，触发 Agent Runtime 启动
```

### 4.2 容器内命令顺序

```bash
evolclaw init --non-interactive \
  --owner "$OWNER_AID" \
  --baseagent "$BASEAGENT" \
  --projectpath /workspace \
  --ecweb \
  --force \
  --format json

evolclaw start
```

说明：

- `init` 负责进程级配置：`defaults.json`、`evolclaw.json.aid`、唯一 `ownerAid`、ECWeb 开关。
- `start` 启动 Control Plane。无 self-agent 时也必须启动成功。
- Agent Runtime 在用户后续通过 App 创建 self-agent 后启动；owner 绑定/直写本身不启动 Runtime。
- 部署方案不依赖 bootstrap daemon，也不做 bootstrap 到正式 daemon 的自切换。

### 4.3 可选：部署阶段预创建 agent

如果产品希望实例 ready 后立即有默认 agent，也可以由 deploy-server 预创建：

```bash
evolclaw agent new "$AGENT_AID" \
  --non-interactive \
  --project /workspace \
  --baseagent "$BASEAGENT" \
  --owner "$OWNER_AID" \
  --name "$AGENT_NAME" \
  --format json
```

这只是产品策略，不再是 daemon 启动的必要条件。

---

## 5. `evolclaw init --non-interactive` 命令设计

### 5.1 参数

```bash
evolclaw init --non-interactive [选项]
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--non-interactive` | flag | 是 | - | 启用机器友好初始化。 |
| `--owner <aid>` | string | 云部署必填 | 无 | 唯一 daemon owner AID，写入 `owners: [aid]`。 |
| `--baseagent <name>` | string | 否 | 自动选择 | `claude` / `codex` / `gemini`。 |
| `--projectpath <path>` | string | 否 | 无 | 默认项目目录，必须为绝对路径，自动创建。 |
| `--ecweb` | flag | 否 | false | 写入 `ecweb.enabled = true`。 |
| `--force` | flag | 否 | false | 允许覆盖已有 `defaults.json` / owner 配置。 |
| `--format json` | string | 建议 | human | stdout 输出 JSON。云部署必须使用。 |

### 5.2 行为要求

非交互模式必须满足：

- 不调用 readline。
- 不依赖 TTY。
- 不打印 ASCII QR。
- 不进入 raw keyboard 模式。
- `stdout` 只输出机器可解析 JSON。
- 人类提示、诊断、进度输出到 `stderr`。
- 所有错误使用稳定 `code`，并用非 0 退出码结束。

### 5.3 `--owner` 行为

带 `--owner` 时：

- 校验 `ownerAid` 合法。
- 确保控制 AID 存在；如果不存在则调用 Gateway 生成并写入 `evolclaw.json.aid`。
- 写入 `evolclaw.json.owners = [ownerAid]`。
- 不启动 bootstrap daemon。
- 不创建 bind task。
- 不输出 QR JSON。
- 不启动 Control Plane；启动由后续 `evolclaw start` 负责。

成功输出：

```json
{
  "type": "init.result",
  "success": true,
  "controlAid": "ec42857.agentid.pub",
  "ownerAid": "alice.agentid.pub",
  "owners": ["alice.agentid.pub"],
  "defaultsPath": "/home/evol/.evolclaw/agents/defaults.json",
  "evolclawPath": "/home/evol/.evolclaw/evolclaw.json"
}
```

失败输出：

```json
{
  "type": "init.result",
  "success": false,
  "error": {
    "code": "INVALID_OWNER",
    "message": "invalid owner AID"
  }
}
```

退出码：

- `0`：初始化成功。
- `1`：参数或环境错误。
- `2`：未预期运行时错误。

---

## 6. 配置写入

### 6.1 `defaults.json`

路径：

```text
~/.evolclaw/agents/defaults.json
```

写入示例：

```json
{
  "$schema_version": 1,
  "active_baseagent": "claude",
  "baseagents": {
    "claude": {},
    "codex": {},
    "gemini": {}
  },
  "projects": {
    "defaultPath": "/workspace"
  }
}
```

覆盖规则：

- 文件不存在：创建。
- 文件存在且无 `--force`：保留已有字段，只做幂等补全；如果请求会改变关键字段，应返回错误或明确 skipped。
- 文件存在且有 `--force`：允许覆盖本次初始化负责的字段。

### 6.2 `evolclaw.json`

路径：

```text
~/.evolclaw/evolclaw.json
```

写入示例：

```json
{
  "$schema_version": 1,
  "aid": "ec42857.agentid.pub",
  "owners": ["alice.agentid.pub"],
  "ecweb": { "enabled": true }
}
```

规则：

- `aid` 已存在时复用。
- `aid` 不存在时生成控制 AID。
- `owners` 云部署只支持唯一 owner，始终写为单元素数组。
- 已有 owner 且与传入 owner 不一致时，无 `--force` 应失败，防止误接管。
- `--ecweb` 写入 `ecweb.enabled = true`；未传时不强制覆盖已有 ECWeb 配置。

---

## 7. Agent 创建

Control Plane ready 后，agent 可以通过两种方式创建：

- deploy-server 在容器内调用 CLI 预创建。
- App 通过 `controlAid` 发送 `menu.*` 远程创建。

CLI 预创建命令：

```bash
evolclaw agent new "$AGENT_AID" \
  --non-interactive \
  --project /workspace \
  --baseagent "$BASEAGENT" \
  --owner "$OWNER_AID" \
  --name "$AGENT_NAME" \
  --format json
```

成功输出沿用现有 `agent new --format json` 结构。若部署阶段预创建 agent，部署侧至少需要记录：

- `agentAid`
- `configPath`
- `ownerAid`
- `hotLoaded` / `hotLoadError`

注意：

- `agentAid` 可由 deploy-backend 分配，也可由 EvolClaw 侧生成；必须保证后续 App 能知道这个默认 agent。
- `ownerAid` 同时写入 agent 级 `owners`，方便后续 agent 自管理。
- `project` 必须是绝对路径；不存在时自动创建。

### 7.1 远程创建后的 Runtime 启动

App 侧远程创建推荐使用结构化 menu：

```json
{
  "type": "menu.action",
  "id": "req-1",
  "name": "agent",
  "action": "create",
  "args": {
    "aid": "mybot.agentid.pub",
    "name": "mybot",
    "baseagent": "claude",
    "project": "/workspace/mybot"
  }
}
```

处理语义：

1. Control Plane 校验发送方 `peerId` 是否在 `evolclaw.json.owners`。
2. 校验参数，创建 agent AID、`agents/<agentAid>/config.json`、初始 personal 文件、agent.md。
3. 写入 agent 级 `owners: [peerId]`。
4. 如果 daemon 正在运行，调用 Runtime hot-load 入口加载该 agent。
5. hot-load 成功后，`status.agentRuntime.state` 从 `empty` 或 `starting` 变为 `running`。

创建接口可以“受理即返回”，但必须提供进度查询：

```json
{
  "type": "menu.query",
  "id": "req-2",
  "name": "agent",
  "args": { "aid": "mybot.agentid.pub" }
}
```

返回中应包含 create progress，便于 App 展示 validating / creating_aid / writing_config / publishing_agentmd / hot_loading / ready / failed。

### 7.2 owner 绑定与 Runtime 的关系

owner 绑定或 owner 直写只改变 Control Plane 的授权状态：

```text
unowned/control-only -> owned/control-ready
```

它不创建 self-agent，也不启动 Agent Runtime。Runtime 启动条件必须是“存在 runnable self-agent”，即：

```text
owned/control-ready + menu.agent.create success -> runtime starting -> runtime running
```

这样可以避免把“实例控制权绑定”和“默认 agent 产品策略”耦合在一起。

---

## 8. 启动与 IPC Ready 轮询

### 8.1 启动

```bash
evolclaw start
```

`start` 会后台启动 daemon。daemon 内部先启动 Control Plane；若存在 runnable self-agent，再启动 Agent Runtime。

deploy-server 不应把 `evolclaw status` 的人类输出作为状态来源，而应直接访问 IPC socket。

Unix socket 路径：

```text
$EVOLCLAW_HOME/data/instance/evolclaw.sock
```

Windows named pipe：

```text
\\.\pipe\evolclaw-<hash>
```

云容器优先按 Linux/Unix socket 实现。

### 8.2 IPC 协议

IPC 是换行分隔 JSON：

请求：

```json
{"type":"status"}
```

响应示例：

```json
{
  "pid": 12345,
  "uptime": 1200,
  "controlPlane": {
    "ready": true,
    "owned": true
  },
  "agentRuntime": {
    "state": "empty",
    "runnableAgents": 0,
    "runningAgents": 0
  },
  "channels": {},
  "channelsByType": {},
  "queue": { "pending": 0, "processing": 0 },
  "controlAid": {
    "aid": "ec42857.agentid.pub",
    "connected": true
  }
}
```

兼容说明：

- 当前实现已包含 `pid`、`queue`、`controlAid`、`controlPlane` 与 `agentRuntime` 字段。
- `ready.signal` 在 IPC server 已完成监听、menu/reload/hot-load/provider 已注册后写入；deploy-server 看到 ready signal 后仍应以 IPC `status` 作为最终状态来源。
- 旧版本兼容：如果部署环境仍运行未包含 `controlPlane` / `agentRuntime` 的旧版本，可临时用 `pid + controlAid` 判定 Control Plane ready；新云部署镜像不应依赖这个兜底。

查询 agent：

```json
{"type":"evolagent.list"}
```

响应示例：

```json
{
  "ok": true,
  "agents": [
    {
      "aid": "mybot.agentid.pub",
      "name": "mybot",
      "status": "running"
    }
  ]
}
```

### 8.3 Ready 条件

deploy-server 应区分两个 ready 层级。

Control Plane ready 的最低条件：

- IPC `status` 有响应。
- `status.pid` 是数字。
- `status.controlAid.aid === expectedControlAid`。
- `status.controlAid.connected === true`。
- `status.controlPlane.ready === true`。
- 如果需要确认 owner 已生效，则 `status.controlPlane.owned === true`，或通过 `evolclaw.json.owners` / 控制面 owner 校验确认。

`controlAid.connected === true` 很关键，因为 App 后续通过 AUN 向控制 AID 发送 `menu.*`，控制 AID 未连接时远程控制不可用。

Agent Runtime ready 是可选条件，仅当部署阶段预创建 agent 或用户已经创建 agent 后才检查：

- `status.agentRuntime.state === "running"`，或兼容性地通过 `evolagent.list` 查询。
- `evolagent.list` 中存在 `expectedAgentAid`。
- 该 agent 状态不是 `error` / `disabled`。

没有 agent 时，`agentRuntime.state === "empty"` 应是正常状态，不应影响一键开通成功。

Runtime failed 也不应影响 Control Plane ready。此时 deploy-server 可以把实例标记为 `controlReady=true, runtimeState=error`，App 仍可通过 Control Plane 修复配置或重新创建 agent。

### 8.4 Node.js 轮询示例

```ts
import net from 'node:net';

function ipcQuery(socketPath: string, cmd: any, timeoutMs = 1000): Promise<any | null> {
  return new Promise((resolve) => {
    const conn = net.connect(socketPath);
    let buf = '';

    const timer = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, timeoutMs);

    conn.on('connect', () => {
      conn.write(JSON.stringify(cmd) + '\n');
    });

    conn.on('data', (data) => {
      buf += data.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;

      clearTimeout(timer);
      conn.destroy();

      try {
        resolve(JSON.parse(buf.slice(0, idx)));
      } catch {
        resolve(null);
      }
    });

    conn.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function waitEvolclawReady(opts: {
  evolclawHome: string;
  expectedControlAid: string;
  expectedAgentAid?: string;
  timeoutMs?: number;
}) {
  const socket = `${opts.evolclawHome}/data/instance/evolclaw.sock`;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);

  while (Date.now() < deadline) {
    const status = await ipcQuery(socket, { type: 'status' }, 1000);
    const daemonReady =
      typeof status?.pid === 'number' &&
      status.controlAid?.aid === opts.expectedControlAid &&
      status.controlAid?.connected === true &&
      status.controlPlane?.ready === true;

    if (daemonReady) {
      if (!opts.expectedAgentAid) return { status };

      const agents = await ipcQuery(socket, { type: 'evolagent.list' }, 1000);
      const agentReady = agents?.ok === true &&
        agents.agents?.some((a: any) =>
          a.aid === opts.expectedAgentAid &&
          a.status !== 'error' &&
          a.status !== 'disabled'
        );

      if (agentReady) return { status, agents };
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error('EvolClaw ready timeout');
}
```

---

## 9. 远程 menu 可用性

初始化成功并且 Control Plane ready 后，App 可以向 `controlAid` 发送结构化 `menu.*` 消息。控制 AID 消息处理会校验发送方是否在 `evolclaw.json.owners` 中。

因此部署链路必须保证：

- `ownerAid` 是用户 App 当前登录 AID。
- `evolclaw.json.owners = [ownerAid]`。
- `controlAid` 已连接 AUN。
- App 使用同一个 `ownerAid` 身份向 `controlAid` 发消息。
- Control Plane 已加载进程级 menu 能力。

如果 owner 不匹配，控制 AID 会静默忽略或返回权限错误，远程 menu 不可用。

---

## 10. 安全与幂等

### 10.1 owner 来源

deploy-server 不应信任 App 直接传入的 ownerAid。ownerAid 必须来自 `evol-backend` 的认证上下文，或者来自 `deploy-backend` 签发的短期 provisioning ticket。

建议 ticket 至少包含：

```json
{
  "ownerAid": "alice.agentid.pub",
  "tenantId": "tenant-1",
  "instanceId": "inst-1",
  "expiresAt": 1781720000000,
  "nonce": "..."
}
```

说明：

- `instanceId` 是部署系统内部资源标识，不进入 EvolClaw 协议。
- EvolClaw 不需要知道 containerId。
- ticket 必须短期有效、一次性使用，并由 deploy-backend 校验签名。

### 10.2 唯一 owner

云部署只支持唯一 owner：

- 新实例：写入 `[ownerAid]`。
- 重试同一 owner：幂等成功。
- 已有不同 owner：无 `--force` 失败。
- 有 `--force`：允许重置 owner，但必须只由 deploy-backend 的实例重置流程触发。

### 10.3 重试

deploy-server 可以安全重试：

1. `init --non-interactive --owner <same ownerAid> --force`
2. `evolclaw start`
3. IPC Control Plane ready 轮询

如果部署策略要求预创建默认 agent，则额外重试：

1. `agent new <same agentAid> --non-interactive --force`
2. IPC Agent Runtime ready 轮询

如果 `start` 返回“already running”，deploy-server 应继续走 IPC ready 轮询，而不是直接判失败。

---

## 11. 可选兜底：App bind.request 流程

仅当后端无法可信取得 ownerAid 时，才使用绑定协议兜底。

该流程不要求展示二维码，可由 deploy-server 把 bind JSON 传给 App，App 直接发送 `bind.request`：

```
deploy-server
  -> evolclaw init --non-interactive --wait-bind --format json
  -> stdout 输出 evolclaw.bind JSON
  -> deploy-backend/evol-backend 转发给 evol-app
  -> evol-app 向 controlAid 发送 bind.request
  -> init 进程等待 bind.status
  -> 成功后 stdout 输出 init.result，退出
```

要求：

- stdout 使用 NDJSON，一行一个 JSON。
- 第一行输出 `evolclaw.bind`。
- 绑定成功输出 `init.result`。
- 超时输出 `init.result success=false code=BIND_TIMEOUT`。
- 不启动 Control Plane；启动仍由后续 `evolclaw start` 负责。
- 不做 bootstrap 自启动正式 daemon。

示例：

```json
{"type":"evolclaw.bind","version":"3.4.0","bindType":"daemon","controlAid":"ec42857.agentid.pub","daemonAid":"ec42857.agentid.pub","token":"Lx7q8LR3mV3DRXoR","expiresAt":1781720000000}
{"type":"init.result","success":true,"controlAid":"ec42857.agentid.pub","ownerAid":"alice.agentid.pub","owners":["alice.agentid.pub"]}
```

兼容字段：

- 对外新字段建议使用 `controlAid`。
- 为兼容现有 QR 协议，可同时输出 `daemonAid`，值与 `controlAid` 相同。

---

## 12. 实施要点

### 12.1 必须改动

- `src/cli/index.ts`
  - 解析 `--owner`、`--projectpath`、`--ecweb`、`--format json`。

- `src/cli/init.ts`
  - 将 `cmdInit()` 的非交互分支与 `initTail()` 的交互流程拆开。
  - 非交互模式不进入 readline/QR/manual owner/ECWeb prompt。
  - 实现 owner 直写和 JSON-only 输出。
  - 已有不同 owner 且无 `--force` 时失败。

- `src/config-store.ts`
  - 如需更严格，可增加唯一 owner 写入 helper，避免多处手写数组覆盖。

- daemon 分层
  - `evolclaw start` CLI 不再因 `loadAllAgents().agents.length === 0` 拒绝启动。
  - daemon main 不再因 `agentRegistry.list().length === 0` 或无 primary agent 退出。
  - 将启动流程拆为 Control Plane 与 Agent Runtime。
  - Control Plane 先启动 IPC、control AID、owner 鉴权、process-level menu executor。
  - Agent Runtime 在无 runnable self-agent 时跳过，并向 IPC 暴露 `empty` 状态。
  - Runtime 初始化失败时不杀死 daemon；错误写入 `agentRuntime.error`，Control Plane 继续运行。
  - 进程级 menu 能力必须挂在 Control Plane 上，而不是依赖 Agent Runtime 初始化完成。
  - hot-load handler 必须在 `empty` 状态下也可用，使 `menu.agent.create` 可以触发 Runtime 启动。

### 12.2 已落地实施阶段

#### Phase 1：空 agent 启动 Control Plane

目标：`init --owner -> start -> IPC status` 在没有 self-agent 时成功。

已落地改动：

- 放开 CLI `start` 的无 agent 门禁。
- daemon main 先构造 Control Plane：IPC、control AID、BindService、owner 校验。
- IPC `status` 增加：
  - `controlPlane.ready`
  - `controlPlane.owned`
  - `agentRuntime.state`
  - `agentRuntime.runnableAgents`
  - `agentRuntime.runningAgents`
- 无 runnable self-agent 时写 ready signal，并返回 `agentRuntime.state = "empty"`。

验收：

```text
evolclaw init --non-interactive --owner <ownerAid> --projectpath /workspace --format json
evolclaw start
IPC status: controlPlane.ready=true, controlAid.connected=true, agentRuntime.state=empty
```

#### Phase 2：Control Plane 进程级 menu executor

目标：Control Plane ready 后，App 可以通过 `controlAid` 管理进程级资源。

已落地改动：

- 抽出轻量 process-level menu executor，避免依赖 primary agent、active session、runner。
- 首批支持：
  - `menu.list`
  - `menu.action name=agent action=create/delete/enable/disable`
  - `menu.query name=agent`
  - `menu.options name=agent`
  - gateway/defaults/project 的必要 query/update
- 保持 owner 鉴权：非 `evolclaw.json.owners` 发送者拒绝或静默。

验收：

```text
Control Plane empty 状态下：
menu.options name=agent -> ok, agents=[]
menu.action name=agent action=create -> accepted=true
menu.query name=agent args.aid=<agentAid> -> 可看到 create progress
```

#### Phase 3：agent 创建后启动 Runtime

目标：远程创建 agent 后，无需重启 daemon，Runtime 自动启动。

已落地改动：

- 在 Control Plane 阶段注册 hot-load/resync 入口。
- `agentCreateNonInteractive` 成功写盘后调用 hot-load。
- hot-load 首个 runnable agent 时初始化 Runtime 公共对象：AgentLoader、SessionManager、MessageQueue、ChannelLoader、Trigger scheduler。
- Runtime 已运行时，hot-load 走现有新增 agent 流程。
- Runtime 从 `empty -> starting -> running`，失败则 `error`，Control Plane 不退出。

验收：

```text
menu.agent.create accepted
progress -> ready
IPC status: agentRuntime.state=running, runningAgents>=1
evolagent.list 包含新 agent，status != error/disabled
```

#### Phase 4：部署集成与兼容兜底

目标：deploy-server 只依赖 IPC ready，不解析人类输出。

已落地改动：

- deploy-server 记录 `controlAid`、`ownerAid`、`controlReady`、`runtimeState`。
- 如选择预创建默认 agent，额外等待 Agent Runtime ready。
- `start` 返回 already running 时继续 IPC 轮询。
- 保留 bind.request / QR 作为无法可信取得 ownerAid 的兜底，不进入云部署主路径。

验收：

```text
无默认 agent：部署成功条件是 controlReady=true, runtimeState=empty
有默认 agent：部署成功条件是 controlReady=true, runtimeState=running, expectedAgentAid 存在
```

### 12.3 不作为本阶段目标

- 不实现 bootstrap daemon 绑定成功后自动启动正式 daemon。
- 不要求 `evolclaw init --non-interactive` 在无 owner 时默认输出 QR 并退出。
- 不要求 owner 绑定成功后自动创建默认 agent；是否创建默认 agent 是产品策略。
- 不要求第一阶段迁移所有 agent 自管理菜单到 Control Plane；只迁移进程级能力。

这些能力可以后续单独设计，但不阻塞当前云部署链路。

### 12.4 回归测试

| 场景 | 验证点 |
|------|--------|
| `--owner` 成功 | 输出 `init.result success=true`，写入唯一 owner。 |
| owner 非法 | JSON 错误 `INVALID_OWNER`，退出码 1。 |
| 已有相同 owner | 幂等成功。 |
| 已有不同 owner 无 `--force` | JSON 错误 `OWNER_EXISTS`，退出码 1。 |
| 已有不同 owner 有 `--force` | 覆盖为新 owner。 |
| `--projectpath` 相对路径 | JSON 错误 `INVALID_PROJECT_PATH`。 |
| `--ecweb` | 写入 `ecweb.enabled=true`。 |
| stdout 清洁 | `--format json` 下 stdout 只包含 JSON。 |
| 无 agent 启动 | init -> start -> IPC Control Plane ready，Agent Runtime 为 empty。 |
| 无 agent 远程 agent list | Control Plane empty 状态下 `menu.options name=agent` 返回空列表。 |
| 远程创建 agent | Control Plane ready 后通过 menu 创建 agent，Agent Runtime 变为 running。 |
| Runtime 启动失败 | Control Plane 保持 ready，IPC 暴露 `agentRuntime.state=error`。 |
| 可选预创建 agent | init -> agent new -> start -> IPC Agent Runtime ready。 |

当前已验证的关键路径：

- 空 `EVOLCLAW_HOME` 启动后 IPC `status.controlPlane.ready=true`、`status.agentRuntime.state=empty`。
- IPC `menu.exec` 执行 `menu.action name=agent action=create` 返回 `accepted=true`。
- 创建进度进入 `ready`，`hot_loading` 为 `done`。
- 再次查询 IPC `status.agentRuntime.state=running`、`runningAgents=1`，`evolagent.list` 中新 agent 为 `running` 且包含 owner。

---

## 13. 结论

云部署主路径应使用：

```text
可信 ownerAid 直写 + Control Plane 永远可启动 + IPC Control Plane ready 轮询
```

这条路径避免 bootstrap 生命周期、自启动接管、QR 输出解析和“必须预创建默认 agent”带来的部署耦合。App 侧开通体验仍然是一键完成；Control Plane ready 后即可远程创建/配置 agent；QR/bind.request 只保留为无法可信传递 ownerAid 时的兜底机制。
