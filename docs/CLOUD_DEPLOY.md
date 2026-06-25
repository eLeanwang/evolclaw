# EvolClaw 云端一键部署 & APP 集成指南

> 适用版本：evolclaw ≥ **3.5.2**（npm: `evolclaw`）
> 目标受众：
> - **云供应商** —— 在云主机/容器中一键拉起 EvolClaw daemon，自动绑定 owner
> - **APP 开发** —— 用户在 Evol App 内点击 "开通云端 Agent"，由 App 调云供应商接口完成开通后接管 daemon

本文档覆盖 `evolclaw init --non-interactive`、Control Plane ready 轮询、远程创建 Agent 的完整契约：CLI 参数、JSON 输出、IPC 状态、错误码、典型部署脚本、APP 端接管协议。

当前云部署主路径是：

```text
可信 ownerAid 直写 -> 启动 Control Plane -> IPC ready -> App 通过 controlAid 创建 Agent
```

Control Plane 可以在没有 self-agent 的情况下启动。此时 `agentRuntime.state = "empty"` 是正常成功状态，用户稍后通过 App 创建第一个 Agent 后，Runtime 会热启动并进入 `running`。

---

## 1. 总览：开通流程

```
┌──────────┐          ┌────────────┐          ┌────────────────┐          ┌─────────────┐
│  Evol    │          │  云供应商  │          │  云主机 (VM)   │          │  AUN 网关   │
│  APP     │          │  开通 API  │          │  EvolClaw      │          │  agentid.pub│
└────┬─────┘          └─────┬──────┘          └────────┬───────┘          └──────┬──────┘
     │  1. 用户在 App 内点  │                          │                         │
     │     "云端 Agent 开通"│                          │                         │
     │   + 提供 owner AID   │                          │                         │
     │─────────────────────▶│                          │                         │
     │                      │  2. 创建 VM / 容器       │                         │
     │                      │     注入 owner AID       │                         │
     │                      │─────────────────────────▶│                         │
     │                      │                          │  3. 启动脚本运行         │
     │                      │                          │  evolclaw init           │
     │                      │                          │  --non-interactive       │
     │                      │                          │  --owner <aid>           │
     │                      │                          │  --format json           │
     │                      │                          │                         │
     │                      │                          │  4. 生成 control AID    │
     │                      │                          │─────────────────────────▶│
     │                      │                          │     注册控制平面身份    │
     │                      │                          │◀─────────────────────────│
     │                      │                          │                         │
     │                      │                          │  5. 写 evolclaw.json    │
     │                      │                          │     (controlAid + owner)│
     │                      │                          │                         │
     │                      │                          │  6. evolclaw start       │
     │                      │                          │     Control Plane ready  │
     │                      │   7. 返回 controlAid +   │                         │
     │                      │      controlReady/runtime│                         │
     │                      │◀─────────────────────────│                         │
     │  8. App 收到         │                          │                         │
     │     controlAid       │                          │                         │
     │     → 通过 AUN 连接  │                          │                         │
     │     daemon，创建Agent│                          │                         │
     │◀─────────────────────│                          │                         │
```

**关键点**：
- 整条链路**不需要人工二维码扫码** —— owner AID 由 App 端从用户 Evol 账户取出，通过 cloud API 透传到 VM
- `--format json` 让 init 输出**机器可解析**的结果，云端脚本可直接消费 `controlAid` / `ownerAid` 字段
- deploy-server 必须通过 IPC `status` 判定 ready，不解析 `evolclaw status` 的人类输出
- 没有 self-agent 时部署也可以成功：`controlPlane.ready=true` 且 `agentRuntime.state=empty`
- daemon 启动后即**只接受 `owner` 名单中的 AID** 调用 `system`、`agent` 等进程级 menu

---

## 2. 云供应商接入

### 2.1 环境准备（VM/容器基础镜像）

基础镜像至少包含：

| 组件 | 版本 | 安装方式 |
|---|---|---|
| Node.js | ≥ 22 LTS | `nvm install --lts` 或 apt/yum 包 |
| Baseagent CLI | 至少 1 个 | `claude` / `codex` / `gemini` 任选 |
| `evolclaw` | ≥ 3.5.2 | `npm i -g evolclaw` |

可选：

| 组件 | 用途 |
|---|---|
| `evolclaw-web` ≥ 1.2.2 | Web 监控面板（`--ecweb` 启用自启动） |

> ⚠️ 当前 `init --non-interactive` 仍会探测 PATH 中的 `claude` / `codex` / `gemini`，全部缺失则失败；`--baseagent` 不指定时默认按优先级选第一个可用项（claude > codex > gemini）。Control Plane ready 不会立即启动 Agent Runtime，但后续创建 Agent 时目标 baseagent CLI 必须可用。

### 2.2 一键开通脚本（最小可用版）

```bash
#!/usr/bin/env bash
# cloud-onboard.sh —— 由云供应商 API 在 VM 上执行
# 入参（环境变量）：
#   OWNER_AID         —— App 端传入的 owner AID（必填，例：alice.agentid.pub）
#   PROJECT_PATH      —— 默认项目目录（可选，默认 /opt/evolclaw/project）
#   ENABLE_ECWEB      —— 是否启用 web 面板（可选，默认 false）
#   EVOLCLAW_HOME     —— 数据目录（可选，默认 /root/.evolclaw）

set -euo pipefail

: "${OWNER_AID:?OWNER_AID is required}"
PROJECT_PATH="${PROJECT_PATH:-/opt/evolclaw/project}"
ENABLE_ECWEB="${ENABLE_ECWEB:-false}"
export EVOLCLAW_HOME="${EVOLCLAW_HOME:-/root/.evolclaw}"

mkdir -p "$PROJECT_PATH"

# 1. 非交互式初始化（结构化输出）
ECWEB_FLAG=""
[ "$ENABLE_ECWEB" = "true" ] && ECWEB_FLAG="--ecweb"

INIT_RESULT="$(evolclaw init --non-interactive \
  --owner "$OWNER_AID" \
  --projectpath "$PROJECT_PATH" \
  --format json \
  $ECWEB_FLAG)"

# 2. 解析关键字段
SUCCESS=$(echo "$INIT_RESULT" | jq -r '.success')
if [ "$SUCCESS" != "true" ]; then
  CODE=$(echo "$INIT_RESULT" | jq -r '.error.code')
  MSG=$(echo "$INIT_RESULT" | jq -r '.error.message')
  echo "init failed: $CODE - $MSG" >&2
  exit 1
fi

CONTROL_AID=$(echo "$INIT_RESULT" | jq -r '.controlAid')
OWNER_AID_OUT=$(echo "$INIT_RESULT" | jq -r '.ownerAid')
BASEAGENT=$(echo "$INIT_RESULT" | jq -r '.baseagent')

# 3. 启动 daemon。无 self-agent 时也会启动 Control Plane。
evolclaw start

# 4. 轮询 IPC status，等待 Control Plane ready。
READY_STATUS="$(node - "$EVOLCLAW_HOME" "$CONTROL_AID" <<'NODE'
const net = require('node:net');
const path = require('node:path');

const home = process.argv[2];
const expectedControlAid = process.argv[3];
const socket = path.join(home, 'data', 'instance', 'evolclaw.sock');
const deadline = Date.now() + 60_000;

function query(payload, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const conn = net.connect(socket);
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      resolve(null);
    }, timeoutMs);
    conn.on('connect', () => conn.write(JSON.stringify(payload) + '\n'));
    conn.on('data', (data) => {
      buf += data.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      clearTimeout(timer);
      conn.destroy();
      try { resolve(JSON.parse(buf.slice(0, idx))); }
      catch { resolve(null); }
    });
    conn.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

(async () => {
  while (Date.now() < deadline) {
    const status = await query({ type: 'status' });
    const ready =
      typeof status?.pid === 'number' &&
      status.controlAid?.aid === expectedControlAid &&
      status.controlAid?.connected === true &&
      status.controlPlane?.ready === true;
    if (ready) {
      console.log(JSON.stringify(status));
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error('Control Plane ready timeout');
  process.exit(2);
})();
NODE
)"

CONTROL_READY=$(echo "$READY_STATUS" | jq -r '.controlPlane.ready == true')
RUNTIME_STATE=$(echo "$READY_STATUS" | jq -r '.agentRuntime.state // "unknown"')

# 5. 输出回云控制平面（也可写文件供后续 API 读取）
cat <<EOF
{
  "status": "ready",
  "controlAid": "$CONTROL_AID",
  "ownerAid": "$OWNER_AID_OUT",
  "controlReady": $CONTROL_READY,
  "runtimeState": "$RUNTIME_STATE",
  "baseagent": "$BASEAGENT",
  "projectPath": "$PROJECT_PATH",
  "ecwebEnabled": $ENABLE_ECWEB
}
EOF
```

### 2.3 `evolclaw init --non-interactive` 完整参数

```
evolclaw init --non-interactive --owner <aid> [选项]

必填:
  --owner <aid>              唯一 daemon owner AID（单值，禁止逗号/空格列表）

可选:
  --baseagent <name>         claude | codex | gemini；默认按 PATH 探测
  --projectpath <abs-path>   默认项目目录（必须绝对路径，不存在则自动创建）
  --ecweb                    启用 web 面板自启动（写 ecweb.enabled=true）
  --format json              **强烈推荐**：stdout 输出 init.result JSON
  --force                    已配置 owner 时覆盖（迁移/换主场景）
```

### 2.4 `init.result` JSON 契约

#### 成功

```json
{
  "type": "init.result",
  "success": true,
  "controlAid": "ec12345.agentid.pub",
  "ownerAid": "alice.agentid.pub",
  "owners": ["alice.agentid.pub"],
  "ecwebEnabled": true,
  "baseagent": "claude",
  "projectsDefaultPath": "/opt/evolclaw/project",
  "defaultsPath": "/root/.evolclaw/agents/defaults.json",
  "evolclawPath": "/root/.evolclaw/data/evolclaw.json",
  "forced": false,
  "previousOwners": null
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `controlAid` | string | 进程级身份。daemon 在 AUN 网络以此身份接入，App 端通过它连接 daemon |
| `ownerAid` | string | 与 `--owner` 入参一致；App 用此身份调用 daemon 的 `/system` `/agent` |
| `owners` | string[] | 实际写入 `evolclaw.json.owners` 的列表（当前固定 1 项） |
| `ecwebEnabled` | boolean | 是否启用 web 面板自启动 |
| `baseagent` | string | 实际选中的 baseagent（claude/codex/gemini） |
| `projectsDefaultPath` | string \| null | 默认项目目录绝对路径；未指定则 null |
| `defaultsPath` | string | defaults.json 绝对路径（含 baseagent 默认值） |
| `evolclawPath` | string | evolclaw.json 绝对路径（含 controlAid、owners、ecweb 配置） |
| `forced` | boolean | true 表示触发了 `--force` 覆盖已有 owner |
| `previousOwners` | string[] \| null | force 覆盖前的旧 owner 列表（审计用） |

#### 失败

```json
{
  "type": "init.result",
  "success": false,
  "error": {
    "code": "MISSING_OWNER",
    "message": "--owner is required in non-interactive mode"
  }
}
```

### 2.5 错误码

| code | exit code | 原因 | 处置建议 |
|---|---|---|---|
| `MISSING_OWNER` | 1 | 未传 `--owner` | App 端补传 owner AID 后重试 |
| `INVALID_OWNER` | 1 | owner AID 格式非法 / 含逗号/空格 / 未通过 `isValidAid` | 校验 App 端 AID 输入；逗号空格分隔的旧格式不再接受 |
| `DAEMON_RUNNING` | 1 | 当前 EVOLCLAW_HOME 已有 daemon 在跑 | 重试前先 `evolclaw stop`；若属于多 owner 共用同机部署，建议给每个 owner 独立 `EVOLCLAW_HOME` |
| `BASEAGENT_UNAVAILABLE` | 1 | PATH 中无任何可用 baseagent CLI；或 `--baseagent` 指定的 CLI 不可用 | 检查 VM 镜像是否安装 claude/codex/gemini |
| `INVALID_BASEAGENT` | 1 | `--baseagent` 值不在 claude/codex/gemini 之内 | 修正入参 |
| `INVALID_PROJECT_PATH` | 1 | `--projectpath` 非绝对路径 | 改用 `/...` 开头的绝对路径 |
| `PROJECT_PATH_CREATE_FAILED` | 2 | 无法 mkdir 项目目录 | 排查文件系统权限 / 磁盘空间 |
| `OWNER_EXISTS` | 1 | 已配置不同 owner 且未传 `--force` | 明确"换主"语义后追加 `--force` |
| `IO_ERROR` | 2 | 写 defaults.json / evolclaw.json 失败 | 排查磁盘 / 权限 |
| `CONTROL_AID_CREATE_FAILED` | 2 | 注册控制 AID 时 AUN 网关不可达 | 检查 VM 出网到 `*.agentid.pub`；网络恢复后重跑 init（含已写文件的幂等性，详见 §2.6） |

**约定**：exit code 1 = 入参/契约问题（不重试），exit code 2 = 运行时/外部依赖问题（可重试）。

### 2.6 幂等性 & 重试

`evolclaw init --non-interactive` **设计为可重入**：
- 已写 `evolclaw.json.aid`（control AID）的情况下，重跑 init **不会重新注册**，直接复用现有 control AID
- 同 owner 重跑 init **被视为幂等成功**，返回原 controlAid
- 不同 owner 必须显式 `--force`

云端脚本失败重试策略：

| 失败类型 | 重试 | 间隔 |
|---|---|---|
| `CONTROL_AID_CREATE_FAILED` | ✅ 是 | 指数退避，最多 5 次 |
| `IO_ERROR` / `PROJECT_PATH_CREATE_FAILED` | ⚠️ 视情况 | 排查后再人工重试 |
| `MISSING_OWNER` / `INVALID_*` | ❌ 否 | 修复入参 |
| `DAEMON_RUNNING` | ❌ 否 | 先 stop |

### 2.7 启动后健康检查

```bash
# CLI 可用于人工观察；部署程序应直接查 IPC socket。
evolclaw status
```

IPC `{"type":"status"}` 输出（节选）：

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
    "aid": "ec12345.agentid.pub",
    "connected": true
  }
}
```

部署成功条件：

| 场景 | 成功条件 |
|---|---|
| 只开通 Control Plane | `controlPlane.ready=true`、`controlAid.connected=true`、`agentRuntime.state=empty` |
| 预创建或已创建 Agent | 上述条件 + `agentRuntime.state=running` + `evolagent.list` 中目标 Agent 不是 `error/disabled` |
| Runtime 失败但 Control Plane 可用 | `controlPlane.ready=true`、`agentRuntime.state=error`；实例可标为 control-ready，并让 App 通过 Control Plane 修复或重建 Agent |

### 2.8 与 systemd 集成

```ini
# /etc/systemd/system/evolclaw.service
[Unit]
Description=EvolClaw Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=evolclaw
Environment=EVOLCLAW_HOME=/var/lib/evolclaw
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/evolclaw start --foreground
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

> 注：`evolclaw start --foreground` 让 systemd 直接管理进程；不带 `--foreground` 时 evolclaw 自己 fork daemon，需配套 `Type=forking` + `PIDFile`。

---

## 3. APP 端集成

### 3.1 角色边界

| 角色 | 职责 |
|---|---|
| **Evol App** | 用户身份、AID 持有、UI 引导、调用云供应商开通 API、接管 daemon |
| **云供应商 API** | VM/容器生命周期、跑 `cloud-onboard.sh`、把 `controlAid` 返还给 App |
| **EvolClaw daemon** | 在 VM 上以 control AID 上 AUN，接受 owner AID 的 `/system` `/agent` 调用 |

### 3.2 App → 云供应商 API（参考契约）

> 此为 EvolClaw 推荐的云供应商 API 契约，供 App 与云供应商共同实现。

#### POST `/v1/instances` — 开通实例

请求：
```json
{
  "ownerAid": "alice.agentid.pub",
  "region": "cn-shanghai",
  "plan": "standard",
  "projectPath": "/opt/evolclaw/project",
  "enableWeb": true
}
```

成功响应（202 Accepted）：
```json
{
  "instanceId": "i-abc123",
  "status": "provisioning"
}
```

#### GET `/v1/instances/{id}` — 查询实例

成功（ready）：
```json
{
  "instanceId": "i-abc123",
  "status": "ready",
  "controlAid": "ec12345.agentid.pub",
  "ownerAid": "alice.agentid.pub",
  "controlReady": true,
  "runtimeState": "empty",
  "createdAt": "2026-06-19T01:23:45Z"
}
```

状态机：`provisioning` → `installing` → `initializing` → `starting` → `ready` / `failed`

失败：
```json
{
  "instanceId": "i-abc123",
  "status": "failed",
  "error": {
    "code": "BASEAGENT_UNAVAILABLE",
    "message": "no baseagent CLI detected in image"
  }
}
```

> 错误码与 §2.5 一一对应。

### 3.3 App 接管 daemon

拿到 `controlAid` 后，App 端通过 AUN 协议直连 daemon：

```typescript
// App 端伪代码（基于 @agentunion/fastaun ≥ 0.5.0）。
// sendMenuPayload 表示向 controlAid 发送结构化 menu.* payload，并等待 menu.response。
import { AUNClient, AIDStore } from '@agentunion/fastaun';

// 1. 加载用户本地 owner 身份
const store = new AIDStore({
  encryptionSeed: userKeySeed,
  aunPath: userAunPath,
  slotId: 'evol-app',
});
const aid = store.load(ownerAid).data.aid;
const client = new AUNClient(aid);
await client.connect();

async function sendMenuPayload(payload: Record<string, unknown>) {
  // 具体发送 API 以 App 当前 AUN SDK 封装为准；payload 必须原样作为结构化消息发送给 controlAid。
  return await client.message.sendStructured({ to: controlAid, payload });
}

// 2. 查询云端 daemon 的健康状态
const result = await sendMenuPayload({
  type: 'menu.action',
  id: crypto.randomUUID(),
  name: 'system',
  action: 'check'
});
// → { uptime: 123, pid: 12345, owners: ['alice.agentid.pub'], ... }

// 3. 创建 agent（非交互，异步）
const created = await sendMenuPayload({
  type: 'menu.action',
  id: crypto.randomUUID(),
  name: 'agent',
  action: 'create',
  args: {
    aid: 'mybot.agentid.pub',
    name: 'mybot',
    baseagent: 'claude',
    project: '/opt/evolclaw/project'
  }
});
// 立即返回 { accepted: true, aid: 'mybot.agentid.pub' }

// 4. 轮询 agent 创建进度
const progress = await sendMenuPayload({
  type: 'menu.query',
  id: crypto.randomUUID(),
  name: 'agent',
  args: { aid: 'mybot.agentid.pub' }
});
// → { createProgress: { status: 'registering_aid', ... } }
// 状态： validating → registering_aid → config_saved → uploading_agentmd → hot_loading → ready
```

### 3.4 进程级 menu 鉴权

App 端调用 `/system` / `/agent` 时必须用 `owners` 名单中的 AID 签名，否则 daemon 返回：

```json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "..." } }
```

**注意**：daemon 的 `evolclaw.json.owners`（进程级管理者）与 evolagent 的 channel role（`owner`/`admin`/`guest`/`anonymous`）是**两套独立鉴权**：
- `evolclaw.json.owners` —— 进程级，控制 `/system` `/agent` 这类管理操作
- evolagent 内的 channel role —— 关系级，控制对该 evolagent 的对话/触发器/baseagent 切换等

### 3.5 `menu.action name=agent action=create` 异步创建协议

结构化 `menu.action` 走"受理即返回"：

```
App                  daemon
 │  menu.action create  │
 │ ─────────────────────▶│
 │                       │  写 create-status.json:
 │                       │   { status: 'validating' }
 │  { accepted, aid }    │
 │ ◀─────────────────────│
 │                       │  后台执行：
 │                       │    validating → registering_aid →
 │                       │    config_saved → uploading_agentmd →
 │                       │    hot_loading → ready
 │  menu.query agent     │  (App 轮询，间隔 1-2s 推荐)
 │ ─────────────────────▶│
 │  { createProgress:    │
 │    { status: 'hot_loading' }} │
 │ ◀─────────────────────│
 │   ... 直到 ready / failed   │
```

`createProgress.status` 可能值：

| status | 含义 |
|---|---|
| `validating` | 校验 AID 格式、baseagent 可用性、project 路径 |
| `registering_aid` | 在 AUN 网关注册 agent AID（可能耗时 2-5s） |
| `config_saved` | 写入 `agents/<aid>/config.json` |
| `uploading_agentmd` | 上传 agent.md（最多重试 3 次，失败转 warn） |
| `hot_loading` | 通过 IPC 通知 daemon 热载入（连接 AUN，最长 30s） |
| `ready` | 完成 |
| `failed` | 硬失败，详情见 `createProgress.detail` |

### 3.6 用户体验建议

App 端开通流程的推荐 UI 节奏：

```
[点击 "开通云端 Agent"]
       ↓
[输入/确认 owner AID]                    ← 复用 App 已登录身份
       ↓
[选择 region / plan]
       ↓
[POST /v1/instances] —— 立即返回 instanceId
       ↓
[进度条 1：分配实例]      ← provisioning
[进度条 2：安装环境]      ← installing
[进度条 3：初始化身份]     ← initializing
[进度条 4：启动 daemon]   ← starting
       ↓
[ready] —— 显示 controlAid + 引导用户「立即创建第一个 Agent」
       ↓
[App 内点击 "新建 Agent"]
       ↓
[选择 AID 后缀 / baseagent / project]
       ↓
[menu.action agent/create]  ← 异步
       ↓
[进度条：注册 → 上传 agent.md → 上线]
       ↓
[完成] —— 引导用户「绑定渠道」「设置 owner 行为档案」等
```

---

## 4. 故障排查速查

| 现象 | 排查 |
|---|---|
| `init` 报 `CONTROL_AID_CREATE_FAILED` | 检查 VM 出网到 AUN 网关（默认 `*.agentid.pub`）；DNS / 防火墙；指数退避后重试 |
| `init` 成功但 `evolclaw start` 卡住 | 看 `${EVOLCLAW_HOME}/logs/evolclaw.log`；Control Plane 启动不依赖 self-agent，常见原因是控制 AID 首连、IPC/socket 权限、端口或进程残留 |
| App 调 `/system status` 返回 `FORBIDDEN` | `evolclaw.json.owners` 是否包含 App 当前 AID；可通过 `evolclaw init --non-interactive --owner <new> --force` 切换 |
| `agent/create` 一直在 `registering_aid` | AUN 网关侧 AID 创建慢；30s 超时后转 failed，看 `createProgress.detail` |
| `agentRuntime.state=empty` | 正常状态，表示尚未创建 self-agent；App 可继续调用 `menu.action agent/create` |
| `agentRuntime.state=error` | Runtime 启动失败但 Control Plane 仍可用；查 IPC `agentRuntime.error` 和日志后重新创建/修复 Agent |
| `ecwebEnabled=true` 但访问不到面板 | 检查 `evolclaw-web` 是否已 npm 全局安装、端口 42705 是否开放 |
| daemon 重启后 owner 丢失 | `evolclaw.json` 持久化，检查文件是否被覆写 / EVOLCLAW_HOME 是否切换 |

---

## 5. 版本兼容矩阵

| evolclaw | evolclaw-web | @agentunion/fastaun | Node.js | 说明 |
|---|---|---|---|---|
| 3.5.2 | 1.2.2 | 0.5.0 | ≥ 22 | 当前推荐 |
| 3.5.1 | 1.2.0 | 0.4.x | ≥ 22 | 旧版本（不支持 `--non-interactive --owner`） |

> 云端镜像建议固定到 `evolclaw@3.5.2` + `evolclaw-web@1.2.2`，并在 App 侧维护"最低版本"检查（通过 `/system version` menu 查询）。

---

## 6. 参考

- 主仓 README：`README.md`（项目总览）
- 内部架构：`docs/architecture.md`
- AUN 协议：`https://docs.agentid.pub`
- fastaun 0.5.0 变更：`node_modules/@agentunion/fastaun/CHANGELOG.md`
