# EvolClaw 云部署非交互式初始化方案

> 历史方案：本文描述的是旧的“可信 owner 直写 + 预创建默认 self-agent”路径。
> 当前云部署主路径已切换为 Control Plane 分层启动：无 self-agent 也可启动，部署成功条件是
> `controlPlane.ready=true` 且 `controlAid.connected=true`，没有 agent 时 `agentRuntime.state=empty`
> 是正常状态。对外集成请以 `docs/CLOUD_DEPLOY.md` 为准；设计细节见
> `docs/evolclaw-init-control-plane.md`。

## 1. 背景与目标

目标是在云部署链路中支持用户从 Evol App 一键开通 EvolClaw：

```
evol-app
  -> evol-backend
  -> deploy-backend
  -> deploy-server
  -> evolclaw container
```

当前"开通权限 / 创建容器"已经打通，卡点在容器内初始化 EvolClaw、绑定 owner，并让用户随后可以从 App 通过控制 AID 发送 `menu.*` 指令管理 EvolClaw。

本方案面向当前 daemon 架构，采用"后端可信 owner 直写 + 预创建默认 self-agent"的方式：

- `evol-backend` 已认证用户身份，知道用户的 `ownerAid`。
- `deploy-backend/deploy-server` 通过可信内部链路把唯一 `ownerAid` 注入容器。
- 容器内 `evolclaw init --non-interactive --owner <aid>` 直接写入 `evolclaw.json.owners = [ownerAid]`。
- 部署阶段预创建一个默认 self-agent，确保当前正式 daemon 可以启动。
- `deploy-server` 通过 IPC `status` / `evolagent.list` 轮询 readiness，不解析 CLI 人类输出。

不再把 QR 绑定作为云部署主路径。QR 绑定仅作为可选兜底，用于后端无法可信取得 owner AID 的场景。

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
- `agentAid` 是部署阶段预创建的默认 self-agent AID。
- 文中所有路径以 `$EVOLCLAW_HOME` 为根（默认 `~/.evolclaw`，由 `EVOLCLAW_HOME` 环境变量覆盖；解析逻辑见 `src/paths.ts:9`）。

---

## 3. 推荐部署流程

### 3.1 总体流程

```
用户在 evol-app 点击一键开通
  ↓
evol-backend 校验登录态，确定 ownerAid
  ↓
deploy-backend 创建部署任务
  ↓
deploy-server 创建/启动容器（注入 EVOLCLAW_HOME 环境变量）
  ↓
容器内执行 evolclaw init --non-interactive --owner <ownerAid>
  ↓
容器内执行 evolclaw agent new <agentAid> --non-interactive --owner <ownerAid>
  ↓
容器内执行 evolclaw start
  ↓
deploy-server 轮询 IPC status / evolagent.list
  ↓
返回 controlAid、agentAid、ready 状态
  ↓
evol-app 使用 controlAid 发送 menu.* 远程配置 EvolClaw
```

### 3.2 容器内命令顺序

```bash
evolclaw init --non-interactive \
  --owner "$OWNER_AID" \
  --baseagent "$BASEAGENT" \
  --projectpath /workspace \
  --ecweb \
  --force \
  --format json

evolclaw agent new "$AGENT_AID" \
  --non-interactive \
  --project /workspace \
  --baseagent "$BASEAGENT" \
  --owner "$OWNER_AID" \
  --name "$AGENT_NAME" \
  --force \
  --format json

evolclaw start
```

说明：

- `init` 负责进程级配置：`defaults.json`、`evolclaw.json.aid`、唯一 `ownerAid`、ECWeb 开关。
- `agent new` 负责创建默认 self-agent。当前正式 daemon 没有 self-agent 会启动失败，因此部署阶段必须预创建一个 agent（启动失败提示见 `src/index.ts:213`）。
- `start` 启动正式 daemon。部署方案不依赖 bootstrap daemon，也不做 bootstrap 到正式 daemon 的自切换。

---

## 4. `evolclaw init --non-interactive` 命令设计

### 4.1 参数

```bash
evolclaw init --non-interactive [选项]
```

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--non-interactive` | flag | 是 | - | 启用机器友好初始化。 |
| `--owner <aid>` | string | 云部署必填 | 无 | 唯一 daemon owner AID，写入 `owners: [aid]`。**仅接受单个 AID，不接受逗号/空格分隔列表**。 |
| `--baseagent <name>` | string | 否 | 自动选择 | `claude` / `codex` / `gemini`。 |
| `--projectpath <path>` | string | 否 | 无 | 默认项目目录，必须为绝对路径，自动创建。 |
| `--ecweb` | flag | 否 | false | 写入 `ecweb.enabled = true`。 |
| `--force` | flag | 否 | false | 允许覆盖已有 `defaults.json` / owner 配置。 |
| `--format json` | string | 建议 | human | stdout 输出 JSON。云部署必须使用。 |

### 4.2 行为要求

非交互模式（`--non-interactive` + `--format json`）必须满足：

- 不调用 readline。
- 不依赖 TTY（不通过 `process.stdin.isTTY` 走分支）。
- 不打印 ASCII QR。
- 不进入 raw keyboard 模式。
- `stdout` 只输出机器可解析 JSON（成功一行 `init.result`，失败一行 `init.result success=false`）。
- 人类提示、诊断、进度输出到 `stderr`。
- 所有错误使用稳定 `code`，并用非 0 退出码结束。
- 任何子调用（控制 AID 生成、defaults 写入、SDK 日志）的 stdout 输出必须被重定向到 stderr 或抑制。

### 4.3 `--owner` 行为

带 `--owner` 时：

- 校验 `ownerAid` 合法（`isValidAid`：多级 agentid 域名）。
- 确保控制 AID 存在；如果不存在则调用 Gateway 生成并写入 `evolclaw.json.aid`。
- 写入 `evolclaw.json.owners = [ownerAid]`。
- 不启动 bootstrap daemon。
- 不创建 bind task。
- 不输出 QR JSON。
- 不启动正式 daemon。

不带 `--owner` 时（云部署不应进入此分支）：

- 直接失败，返回 `MISSING_OWNER`。
- 想要无 owner 启动 + 二维码兜底的，参见 §10：那是一条独立的 bind 兜底路径，不和"主非交互路径"混用。

成功输出：

```json
{
  "type": "init.result",
  "success": true,
  "controlAid": "ec42857.agentid.pub",
  "ownerAid": "alice.agentid.pub",
  "owners": ["alice.agentid.pub"],
  "ecwebEnabled": true,
  "baseagent": "claude",
  "projectsDefaultPath": "/workspace",
  "defaultsPath": "$EVOLCLAW_HOME/agents/defaults.json",
  "evolclawPath": "$EVOLCLAW_HOME/evolclaw.json"
}
```

`--force` 覆盖已有不同 owner 时，追加：

```json
{
  "forced": true,
  "previousOwners": ["bob.agentid.pub"]
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
- `1`：参数或环境错误（owner 非法、baseagent 不可用、project 非绝对路径、owner 冲突等）。
- `2`：未预期运行时错误（Gateway 不可达、磁盘写失败等）。

### 4.4 稳定错误码

| code | 退出码 | 触发场景 |
|------|--------|---------|
| `MISSING_OWNER` | 1 | `--non-interactive` 但未传 `--owner`。 |
| `INVALID_OWNER` | 1 | `--owner` 不是合法多级 AID 域名，或包含多个值。 |
| `INVALID_BASEAGENT` | 1 | `--baseagent` 不在 `claude/codex/gemini` 集合。 |
| `BASEAGENT_UNAVAILABLE` | 1 | 指定 baseagent 在当前环境不可用（CLI 缺失等）。 |
| `INVALID_PROJECT_PATH` | 1 | `--projectpath` 不是绝对路径。 |
| `PROJECT_PATH_CREATE_FAILED` | 2 | 创建项目目录失败（权限、磁盘等）。 |
| `OWNER_EXISTS` | 1 | `evolclaw.json.owners` 已存在且与传入不一致，未传 `--force`。 |
| `CONTROL_AID_CREATE_FAILED` | 2 | 调用 Gateway 生成控制 AID 失败。 |
| `DAEMON_RUNNING` | 1 | 检测到主进程在跑（`scanInstances` 命中），需先 `evolclaw stop`。 |
| `IO_ERROR` | 2 | 写 `defaults.json` / `evolclaw.json` 失败。 |
| `INTERNAL_ERROR` | 2 | 未分类异常。 |

---

## 5. 配置写入

### 5.1 `defaults.json`

路径：

```text
$EVOLCLAW_HOME/agents/defaults.json
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
- 文件存在且无 `--force`：保留已有字段，只做幂等补全（深合并）；如果请求会改变关键字段（`active_baseagent` 不同），返回 `OWNER_EXISTS`/相应 code 或在 result 中明确 `skipped: true`。
- 文件存在且有 `--force`：允许覆盖本次初始化负责的字段（不动 chatmode 等无关字段，使用现有 `saveDefaultsSafe` 深合并语义，见 `src/config-store.ts:172`）。

### 5.2 `evolclaw.json`

路径：

```text
$EVOLCLAW_HOME/evolclaw.json
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

- `aid` 已存在时复用，不重新生成。
- `aid` 不存在时调 `generateControlAid()` 生成并写入（见 `src/cli/init.ts:236`）。
- `owners` 云部署只支持唯一 owner，始终写为单元素数组。
- 已有 owner 且与传入 owner 不一致时，无 `--force` 返回 `OWNER_EXISTS`，防止误接管。
- `--ecweb` 写入 `ecweb.enabled = true`；未传时不强制覆盖已有 ECWeb 配置。

---

## 6. 默认 self-agent 创建

当前正式 daemon 启动要求至少有一个 self-agent（无 self-agent 时 `printConfigFailure` 直接退出，见 `src/index.ts:213`）。云部署初始化完成后，deploy-server 必须创建默认 agent：

```bash
evolclaw agent new "$AGENT_AID" \
  --non-interactive \
  --project /workspace \
  --baseagent "$BASEAGENT" \
  --owner "$OWNER_AID" \
  --name "$AGENT_NAME" \
  --force \
  --format json
```

`agent new --non-interactive` 已经实现（`src/cli/agent-command.ts:140`、`src/cli/agent.ts:674`）。

当前 JSON 实际返回的字段：

```json
{
  "ok": true,
  "aid": "mybot.agentid.pub",
  "configPath": "$EVOLCLAW_HOME/agents/mybot.agentid.pub/config.json",
  "aidCreated": true,
  "agentmdUploaded": true,
  "hotLoaded": false,
  "hotLoadError": null
}
```

部署侧需要的字段（建议本阶段补齐）：

| 字段 | 现状 | 备注 |
|------|------|------|
| `aid` / `agentAid` | ✅ 现有字段名 `aid` | deploy-server 直接使用 `aid`。 |
| `configPath` | ✅ | |
| `ownerAid` | ❌ 缺失，需补 | 取 `opts.owner`，便于审计；可读 `config.owners[0]` 兜底。 |
| `hotLoaded` / `hotLoadError` | ✅ | |
| `agentmdUploaded` | ✅ | |

注意：

- `agentAid` 可由 deploy-backend 分配，也可由 EvolClaw 侧生成；必须保证后续 App 能知道这个默认 agent。
- `ownerAid` 同时写入 agent 级 `owners`，方便后续 agent 自管理。
- `project` 必须是绝对路径；不存在时自动创建（已实现，见 `src/cli/agent.ts:719`）。
- `agent new` 的 `console.warn`（agent.md 上传失败）走 stderr，不污染 stdout JSON（见 `src/cli/agent.ts:800`）。

---

## 7. 启动与 IPC Ready 轮询

### 7.1 启动

```bash
evolclaw start
```

`start` 会后台启动正式 daemon。deploy-server 不应把 `evolclaw status` 的人类输出作为状态来源，而应直接访问 IPC socket。

Unix socket 路径（解析逻辑见 `src/paths.ts:130`）：

```text
$EVOLCLAW_HOME/data/instance/evolclaw.sock
```

Windows named pipe：

```text
\\.\pipe\evolclaw-<sha1(EVOLCLAW_HOME)前12字符>
```

云容器优先按 Linux/Unix socket 实现。

### 7.2 IPC 协议

IPC 是换行分隔 JSON：

请求：

```json
{"type":"status"}
```

响应示例（实际结构见 `src/ipc.ts:19`、`src/index.ts:1291`）：

```json
{
  "pid": 12345,
  "uptime": 1200,
  "channels": {},
  "channelsByType": {},
  "queue": { "pending": 0, "processing": 0 },
  "controlAid": {
    "aid": "ec42857.agentid.pub",
    "connected": true
  }
}
```

查询 agent：

```json
{"type":"evolagent.list"}
```

响应示例（实际 handler 见 `src/ipc.ts:330`）：

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

### 7.3 Ready 条件

deploy-server 判定 ready 的最低条件：

- IPC `status` 有响应。
- `status.pid` 是数字。
- `status.controlAid.aid === expectedControlAid`。
- `status.controlAid.connected === true`。
- `evolagent.list.agents` 中存在 `expectedAgentAid`。
- 该 agent 状态不是 `error` / `disabled`。

`controlAid.connected === true` 很关键，因为 App 后续通过 AUN 向控制 AID 发送 `menu.*`，控制 AID 未连接时远程控制不可用。

控制 AID 首连有可能失败但后台自动重连（见 `src/index.ts:144`），所以轮询窗口至少应给 60s。

### 7.4 Node.js 轮询示例

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
  expectedAgentAid: string;
  timeoutMs?: number;
}) {
  const socket = `${opts.evolclawHome}/data/instance/evolclaw.sock`;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);

  while (Date.now() < deadline) {
    const status = await ipcQuery(socket, { type: 'status' }, 1000);
    const daemonReady =
      typeof status?.pid === 'number' &&
      status.controlAid?.aid === opts.expectedControlAid &&
      status.controlAid?.connected === true;

    if (daemonReady) {
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

## 8. 远程 menu 可用性

初始化成功并 ready 后，App 可以向 `controlAid` 发送结构化 `menu.*` 消息。控制 AID 消息处理会校验发送方是否在 `evolclaw.json.owners` 中。

因此部署链路必须保证：

- `ownerAid` 是用户 App 当前登录 AID。
- `evolclaw.json.owners = [ownerAid]`。
- `controlAid` 已连接 AUN（`status.controlAid.connected === true`）。
- App 使用同一个 `ownerAid` 身份向 `controlAid` 发消息。

如果 owner 不匹配，控制 AID 会静默忽略或返回权限错误，远程 menu 不可用。

---

## 9. 安全与幂等

### 9.1 owner 来源

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

### 9.2 唯一 owner

云部署只支持唯一 owner：

- 新实例：写入 `[ownerAid]`。
- 重试同一 owner：幂等成功。
- 已有不同 owner：无 `--force` 失败（`OWNER_EXISTS`）。
- 有 `--force`：允许重置 owner，但必须只由 deploy-backend 的实例重置流程触发；result 中输出 `forced: true` + `previousOwners` 供审计。

CLI 实现上 `--owner` **只接受单个 AID**。当前交互式 `parseOwnerAids()` 支持多个 owner（`src/cli/init.ts:55`），但非交互路径不复用它。

### 9.3 重试

deploy-server 可以安全重试：

1. `init --non-interactive --owner <same ownerAid> --force`
2. `agent new <same agentAid> --non-interactive --force`
3. `evolclaw start`
4. IPC ready 轮询

如果 `start` 返回"already running"，deploy-server 应继续走 IPC ready 轮询，而不是直接判失败。

---

## 10. 可选兜底：App bind.request 流程

仅当后端无法可信取得 ownerAid 时，才使用绑定协议兜底。本节不属于当前阶段实施目标（见 §11.2），保留作为设计预留。

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
- 不启动正式 daemon。
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

## 11. 实施要点

### 11.0 当前实现现状（gap 分析）

| 能力 | 现状 | 文件位置 |
|------|------|---------|
| `init` 命令入口 | ✅ | `src/cli/index.ts:29` |
| `--non-interactive` 解析 | ✅ | `src/cli/index.ts:76` |
| `--baseagent` / `--force` 解析 | ✅ | `src/cli/index.ts:79–81` |
| `--owner` / `--projectpath` / `--ecweb` / `--format` 解析 | ❌ 未接入 | 需补 |
| 非交互分支不进 readline | ✅ | `src/cli/init.ts:111` |
| 非交互分支 stdout JSON-only | ❌ 仍打印人类文本 | `src/cli/init.ts:101, 136` |
| `initTail()` 不区分交互/非交互 | ❌ 共用 tail | `src/cli/init.ts:222` |
| 控制 AID 自动生成 | ✅ `generateControlAid` | `src/cli/init.ts:236` |
| owner 写入 `evolclaw.json` | ⚠️ 仅交互式 QR / 手输 | `src/cli/init.ts:247` |
| owner 冲突 / `--force` 语义 | ❌ 未实现 | 需补 |
| ECWeb 非交互写入 | ❌ 仅交互询问 | `src/cli/init.ts:287` |
| 错误结构化（code）输出 | ❌ 仅打印中文 | 需补 |
| `agent new --non-interactive` | ✅ | `src/cli/agent.ts:674` |
| `agent new` result 含 `ownerAid` | ❌ 缺字段 | `src/cli/agent.ts:830` 需补 |
| IPC `status.controlAid.{aid,connected}` | ✅ | `src/index.ts:1318` |
| IPC `evolagent.list` | ✅ | `src/ipc.ts:330` |
| daemon 无 self-agent 启动失败 | ✅ 行为已存在 | `src/index.ts:213` |

### 11.1 必须改动

- `src/cli/index.ts`
  - 在 `cmd === 'init'` 且无渠道子命令分支：解析 `--owner`、`--projectpath`、`--ecweb`、`--format`，传入 `cmdInit()`。
  - 透传 `--format` 给下游用于切换 stdout 模式。

- `src/cli/init.ts`
  - 把 `cmdInit()` 的非交互分支拆出独立函数 `cmdInitNonInteractive(opts)`，不再调用 `initTail()`。
  - 该函数职责（顺序）：
    1. 参数 + 环境校验（`isValidAid` / 路径 / baseagent 可用性 / 单进程互斥）。
    2. 读 `evolclaw.json`，处理 owner 冲突 / `--force`。
    3. `saveDefaultsSafe()` 写 baseagent + projectsDefaultPath。
    4. 必要时 `generateControlAid()` 写 `aid`。
    5. 写 `owners: [ownerAid]`、`ecweb`。
    6. 组装 `init.result` JSON → 单行 stdout。
  - 任何错误统一走 `emitError(code, message, exitCode)`，stderr 提示 + stdout 单行 JSON + 退出码。
  - 非交互分支保证：不依赖 `process.stdin.isTTY`，不调用任何 readline，不打印进度到 stdout。
  - 把现有打印（`console.log`）改为 stderr 或在 `--format json` 下静默。

- `src/cli/agent.ts`
  - `agentCreateNonInteractive()` 的返回结果补 `ownerAid` 字段（取 `opts.owner ?? null`）。
  - `console.warn` 已经走 stderr，无需调整；如未来要严格机器输出，可在 result 中嵌入 `warnings: string[]`。

- `src/config-store.ts`
  - 可选：增加 `setUniqueOwner(aid, { force }): { changed, previousOwners }` helper，集中"唯一 owner 写入 + 冲突检测"语义。

- 日志噪声
  - `--format json` 模式下需要把 SDK 噪声（AUN / Feishu / Logger info）压到 stderr。`suppressSdkLogs()` 已在 init 路径调用（`src/cli/index.ts:75`），需要确认它对所有相关 logger 生效。

### 11.2 不作为本阶段目标

- 不实现 bootstrap daemon 绑定成功后自动启动正式 daemon。
- 不实现 §10 的 `--wait-bind` NDJSON 兜底流程。
- 不要求正式 daemon 支持无 self-agent 的 control-only 模式。
- 不修改交互式 init 流程的行为（保持 `initTail()` 现有 UX）。

### 11.3 建议新增测试

| 场景 | 验证点 |
|------|--------|
| `--owner` 成功 | 输出 `init.result success=true`，写入唯一 owner，退出码 0。 |
| 未传 `--owner` | JSON 错误 `MISSING_OWNER`，退出码 1。 |
| owner 非法 | JSON 错误 `INVALID_OWNER`，退出码 1。 |
| `--owner` 含逗号/空格分隔多个值 | JSON 错误 `INVALID_OWNER`。 |
| 已有相同 owner | 幂等成功，无 `forced` 字段。 |
| 已有不同 owner 无 `--force` | JSON 错误 `OWNER_EXISTS`，退出码 1。 |
| 已有不同 owner 有 `--force` | 覆盖为新 owner，result 含 `forced: true` + `previousOwners`。 |
| `--projectpath` 相对路径 | JSON 错误 `INVALID_PROJECT_PATH`。 |
| `--projectpath` 不存在 | 自动创建，result 含 `projectsDefaultPath`。 |
| `--baseagent` 未安装 | JSON 错误 `BASEAGENT_UNAVAILABLE`。 |
| `--ecweb` | 写入 `ecweb.enabled=true`，result 含 `ecwebEnabled: true`。 |
| 主进程已运行 | JSON 错误 `DAEMON_RUNNING`。 |
| stdin 非 TTY（管道） | 不触发 readline / QR / 任何交互。 |
| stdout 清洁 | `--format json` 下 stdout 仅一行 JSON；SDK / logger 全走 stderr。 |
| `agent new --non-interactive --format json` | result 含 `aid`、`configPath`、`ownerAid`、`hotLoaded`。 |
| 部署 happy path | init → agent new → start → IPC status ready + evolagent.list 含 expectedAgentAid。 |
| 部署重试 happy path | 相同参数二次执行：init 幂等、agent new 幂等（`--force`）、start 输出"already running" 但 ready 轮询仍成功。 |

---

## 12. 结论

当前架构下，云部署主路径应使用：

```text
可信 ownerAid 直写 + 默认 self-agent 预创建 + 正式 daemon 启动 + IPC ready 轮询
```

这条路径与当前 EvolClaw 架构最贴近，避免 bootstrap 生命周期、自启动接管、QR 输出解析等复杂问题。App 侧开通体验仍然是一键完成；QR/bind.request 只保留为无法可信传递 ownerAid 时的兜底机制，且不属于本阶段实施目标。

主要工作量集中在 `src/cli/init.ts` 拆出独立非交互函数 + 统一结构化 JSON 输出，估计 0.5–2 天可落地（含测试）。
