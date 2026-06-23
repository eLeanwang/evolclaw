# ControlTunnel 设计方案

**日期**：2026-06-03  
**状态**：部分实现（见下方更新）  
**背景**：给 evolclaw daemon 增加进程身份（AID），通过 AUN 网络将本机 HTTP 服务（ecweb 等）暴露给远程访问。

---

## ⚠️ 状态更新（2026-06-04）

本设计拆分为两部分实现，且转发机制归属已变更：

- **Part 1（本次实现）= daemon AID 身份**：配置层（`evolclaw.json`）、init 生成 `ec+5位` AID、daemon 启动连接该 AID、status 展示。实现计划见 `docs/superpowers/plans/2026-06-04-part1-daemon-aid-plan.md`。
- **HTTP↔AUN 转发与服务注册 = 归 fastaun SDK**：下文第五节的 `TunnelTransport` / `AunTunnelTransport` / `forwarder`（路由/SSRF/转发）**不再由 daemon 自行实现**，将集成进 fastaun SDK。下文相关章节保留为背景/接口参考，不作为 Part 1 实现依据。
- daemon AID 身份是上述转发能力的前置：SDK 拿到 daemon 的 AID 后才能注册 tunnel endpoint。

进程级 menu 控制面（通过该 AID 管理 agent/trigger）见 `2026-06-04-aun-agent-control-design.md` + `2026-06-04-part2-menu-agent-trigger-plan.md`。

---

## 一、问题与目标

ecweb 等本机 HTTP 服务当前只能通过 `127.0.0.1:<port>` 本机访问。目标是让这些服务能经由 AUN 网络被远程访问，同时：

- daemon 不新增外部暴露端口
- ecweb 无需感知 AUN，保持纯 HTTP 服务
- 身份验证在 AUN 层完成，本机信任已通过隧道的流量
- 本机直连路径不变

---

## 二、全局架构

### 数据流

```
远程访问：
互联网 HTTP → http://ec12345.gateway.example.com/dashboard
  ↓ AUN Gateway（泛域名解析 + tunnel 协议转换，协议待定）
  ↓ AUN tunnel 协议帧
daemon ControlTunnel（持 ec12345.agentid.pub）
  ↓ HTTP → 127.0.0.1:<target.port>
ecweb（纯 HTTP 服务，无感知）

本机直连（不变）：
curl http://127.0.0.1:18080 → ecweb（直连）
```

### daemon 进程内结构

```
evolclaw daemon（单进程）
├── AUNChannel ×N        ← 业务会话 AID（evolagent，聊天，已有）
├── IpcServer            ← Unix socket（evolclaw ctl，已有）
├── ControlTunnel ★新增  ← 控制 AID（ec*，HTTP tunnel）
├── MessageProcessor     ← 消息处理引擎（已有）
└── SessionManager       ← 会话管理（已有）
```

**ControlTunnel 与 AUNChannel 的区别**：

| | AUNChannel | ControlTunnel |
|---|---|---|
| 处理内容 | 聊天消息 | HTTP 转发帧 |
| 转发目标 | Agent 后端（Claude/Codex） | 本机 HTTP 端口 |
| AID 用途 | 业务会话身份 | daemon 进程身份 |

---

## 三、配置体系

### 文件分层

| 文件 | 作用域 | 内容 | 读取者 |
|---|---|---|---|
| `~/.evolclaw/evolclaw.json` ★新增 | 进程级 | `aid`、`debug`、`tunnel`、`aun.encryptionSeed` | daemon 主进程 / `src/aun/aid/store.ts` |
| ~~`~/.evolclaw/config.json`~~ | ~~AUN 模块~~ | **已吞并进 `evolclaw.json` 并废弃**（见下「config.json 迁移」） | — |
| `~/.evolclaw/agents/defaults.json` | agent 默认值 | `baseagents`、`models` 等（去掉 `debug`） | agent 配置合并链 |

> **状态更新（2026-06-04）**：原方案保留独立 `config.json`（`ProcessConfig`）。现已决定**将其吞并进 `evolclaw.json`**——唯一有效字段 `aun.encryptionSeed` 迁入 `evolclaw.json` 顶层 `aun` 块，`log` / `aun.gateway` / `aun.keystorePath` 均为死字段（无消费者）直接丢弃。`ProcessConfig` 类型废弃。迁移见 Part 1 计划 Task 1.5。

### `evolclaw.json` 结构

```json
{
  "$schema_version": 1,
  "aid": "ec73841.agentid.pub",
  "debug": {
    "logLevel": "INFO",
    "aunTrace": false
  },
  "aun": {
    "encryptionSeed": null
  },
  "tunnel": {
    "targets": [
      { "name": "ecweb",   "port": 18080, "pathPrefix": "/" },
      { "name": "metrics", "port": 9090,  "pathPrefix": "/metrics" }
    ]
  }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `aid` | string | daemon 控制 AID，缺失则 ControlTunnel 不启动 |
| `debug` | object | 进程级调试配置，缺失时用代码默认值（logLevel: INFO） |
| `aun` | object | AUN 模块配置（从旧 `config.json` 迁入）。`aun.encryptionSeed`（string\|null）派生 AID 私钥种子，`store.ts` 读；缺失/null 时回退 `env.AUN_ENCRYPTION_SEED ?? 'evol'` |
| `tunnel` | object | 可选，缺失时 ControlTunnel 不启动 |
| `tunnel.targets` | array | 转发路由表，按 `pathPrefix` 最长匹配。允许为空数组 `[]` |
| `targets[].name` | string | 标识名（日志/status 用） |
| `targets[].port` | number | 本机 HTTP 目标端口（1024–65535） |
| `targets[].pathPrefix` | string | 路径前缀，默认 `"/"`，最长优先匹配 |

**启动逻辑**：

```
loadEvolclawConfig()
  ├─ evolclaw.json 存在 → 读取
  └─ 不存在 → EvolclawConfig 为空，用代码默认值

config.aid 存在 && config.tunnel 存在
  ├─ 是 → 启动 ControlTunnel
  └─ 否 → 跳过，daemon 正常工作
```

**关于 debug 迁移**：`defaults.json` 中的 `debug` 字段直接删除，不做兼容迁移。`evolclaw.json` 缺失 debug 时用代码默认值。

**关于 config.json 迁移**：启动时 `migrateProcessConfigIfNeeded()` 把旧 `{root}/config.json` 的 `aun.encryptionSeed` **逐字节原样**搬进 `evolclaw.json` 顶层 `aun` 块（含 `null`），其余字段丢弃，旧文件归档为 `config.json.migrated`。`getAidStore` 读取源从 `loadProcessConfig` 切到 `loadEvolclawConfig`，`?? env ?? 'evol'` 回退链不变（保证 seed 行为零变化）。迁移须在任何 `getAidStore` 之前执行。详见 Part 1 计划 Task 1.5。

### TypeScript 类型

```typescript
// src/evolclaw-config.ts（新文件）
export interface EvolclawConfig {
  $schema_version?: number;
  aid?: string;
  debug?: DebugBlock;           // 复用已有 DebugBlock 类型
  aun?: EvolclawAunConfig;      // 从旧 config.json 迁入
  tunnel?: TunnelConfig;
}

export interface EvolclawAunConfig {
  encryptionSeed?: string | null;  // null 原样保留（迁移自旧 config.json）
}

export interface TunnelConfig {
  targets: TunnelTarget[];
}

export interface TunnelTarget {
  name: string;
  port: number;
  pathPrefix?: string;          // 默认 "/"
}
```

---

## 四、AID 生成机制

### 触发时机

`evolclaw init` 流程中自动生成，用户无需额外命令。

### 命名规则

`ec` + 5位随机数字，如 `ec73841.agentid.pub`。

### 生成流程

```
evolclaw init
  ↓ 检测 evolclaw.json 是否已有 aid
  ├─ 已有 → 跳过（复用现有身份）
  └─ 无 ↓
      loop:
        1. 生成候选 = "ec" + randomInt(10000, 99999) + ".agentid.pub"
        2. aidLookup(候选) → 已存在则重新随机
        3. 不存在 → 采用
      ↓ aidCreate(候选)
        - 注册到 Gateway，私钥写入本机 keystore
        - agent.md 不上传
      ↓ 写回 evolclaw.json["aid"]
      ↓ 打印一行让用户看到：✓ 已生成控制 AID: ec73841.agentid.pub
```

**可见性**：生成成功后向用户打印 AID（不静默），失败则打印错误并提示可重试。

### 行为约束

| 约束 | 内容 |
|---|---|
| agent.md | 不上传（不暴露身份信息） |
| 入群 | 拒绝 |
| 主动发消息 | 不主动发 |
| 消息响应 | 不预设限制（留给未来扩展） |
| 生命周期 | daemon 停止时断开；重启复用同一 AID |
| keystore | 复用现有 `getAidStore` / SLOT 机制 |

### 与 `evolclaw agent new` 的区别

| | `evolclaw agent new <aid>` | 控制 AID |
|---|---|---|
| AID 名称 | 用户指定 | `ec`+5位随机数字 |
| agent.md | 上传 | 不上传 |
| 用途 | 业务会话 agent | daemon 进程身份 |
| 配置落点 | `agents/<aid>/config.json` | `evolclaw.json` 顶层 `aid` |

---

## 五、ControlTunnel 内部结构

### 文件布局

```
src/core/control-tunnel/
├── index.ts          ← ControlTunnel 类（生命周期 + 装配）
├── transport.ts      ← TunnelTransport 接口 + 中性请求/响应模型
├── aun-transport.ts  ← AUN 协议实现（本次留 stub，Gateway 协议定后填）
└── forwarder.ts      ← 路由匹配 + SSRF 校验 + HTTP 转发
```

### 三层职责

```
┌─────────────────────────────────────────┐
│  ControlTunnel (index.ts)               │
│  start() / stop() / getStatus()         │
│  装配 transport + forwarder              │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴──────────┐
       ↓                  ↓
┌──────────────┐   ┌──────────────────┐
│TunnelTransport│   │   Forwarder      │
│ 协议适配层    │   │   转发逻辑        │
│ connect(aid)  │   │ 路由匹配          │
│ onRequest()   │   │ SSRF 校验         │
│ ← stub        │   │ http.request      │
└──────────────┘   └──────────────────┘
```

### TunnelTransport 接口（协议无关边界）

```typescript
// src/core/control-tunnel/transport.ts

export interface TunnelRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
}

export interface TunnelTransport {
  connect(aid: string): Promise<void>;
  disconnect(): Promise<void>;
  onRequest(handler: (req: TunnelRequest) => Promise<TunnelResponse>): void;
}
```

### Forwarder 转发逻辑

```
收到 TunnelRequest
  ↓ pathPrefix 最长匹配选 target
  │   无匹配 → 404
  ↓ SSRF 校验
  │   目标强制为 127.0.0.1（拒绝任何非本机地址）
  │   端口范围校验：1024–65535
  ↓ http.request → 127.0.0.1:<target.port><path>
  │   连接失败/超时 → 502
  ↓ 收集响应 → TunnelResponse 原样返回
```

### AunTunnelTransport（stub，待 Gateway 协议定后填）

```typescript
// src/core/control-tunnel/aun-transport.ts
// TODO: Gateway tunnel 协议待定，本次为 stub 实现

export class AunTunnelTransport implements TunnelTransport {
  async connect(_aid: string): Promise<void> {
    // TODO: loadAid + 连接 AUN Gateway，注册 tunnel endpoint
  }
  async disconnect(): Promise<void> {
    // TODO: 断开 AUN 连接
  }
  onRequest(_handler: (req: TunnelRequest) => Promise<TunnelResponse>): void {
    // TODO: 监听 Gateway 转来的 tunnel 帧，解析为 TunnelRequest，调 handler，把 TunnelResponse 打回
  }
}
```

---

## 六、生命周期装配

### daemon 启动（src/index.ts）

```
1. loadEvolclawConfig()
2. channel 注册完成后
3. if (config.aid && config.tunnel):
     controlTunnel = new ControlTunnel(config)
     await controlTunnel.start()
       ├─ transport.connect(config.aid)  // stub 阶段 no-op
       └─ forwarder 就位（targets 路由表加载）
4. IpcServer 启动（getStatus 可查 tunnel 状态）
```

### daemon 停止

```
shutdown 钩子
  ↓ await controlTunnel?.stop()
      └─ transport.disconnect()
```

### status 集成

`evolclaw status` 新增一行：

```
control: ec73841.agentid.pub  [connected | disconnected | not configured]
  targets: ecweb(:18080) metrics(:9090)
```

---

## 七、本次交付边界

| 模块 | 本次实现 | 依赖 Gateway 协议 |
|---|---|---|
| `evolclaw.json` 配置加载（EvolclawConfig） | ✅ 完整 | 否 |
| `DefaultsConfig` 删除 `debug` 字段 | ✅ | 否 |
| AID 生成（init，ec+5位数字） | ✅ 完整 | 否 |
| Forwarder（路由+SSRF+转发+单测） | ✅ 完整 | 否 |
| TunnelTransport 接口定义 | ✅ | 否 |
| ControlTunnel 生命周期（start/stop/getStatus） | ✅ 完整 | 否 |
| AunTunnelTransport | ⬜ stub + TODO | **是，留空** |
| status 集成 | ✅ 完整 | 否 |

协议敲定后，只需补全 `aun-transport.ts` 一个文件即可端到端跑通。

---

## 八、未决事项

- [ ] Gateway tunnel/stream 协议格式（`AunTunnelTransport` 实现依赖此）
- [ ] ecweb 端口默认值确认（当前文档示例用 18080，ecweb 未安装暂未确定）

### 已决事项

- ✅ `evolclaw init` 生成 AID 时向用户打印 AID（不静默）
- ✅ `tunnel.targets` 允许为空数组：AID 连接 AUN 纯身份在线，不转发流量
