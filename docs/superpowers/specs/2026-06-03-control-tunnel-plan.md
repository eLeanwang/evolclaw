# ControlTunnel 实现计划

**设计文档**：`2026-06-03-control-tunnel-design.md`  
**日期**：2026-06-03

---

## 任务列表

### T1 — 新增 `evolclaw.json` 配置层

**文件**：
- `src/paths.ts` — 新增 `evolclawJson` 路径（`path.join(root, 'evolclaw.json')`）
- `src/evolclaw-config.ts`（新） — `EvolclawConfig` / `TunnelConfig` / `TunnelTarget` 类型 + `loadEvolclawConfig()` / `saveEvolclawConfig()`

**要点**：
- `loadEvolclawConfig()`：文件不存在返回 `{}`，不报错
- 复用已有 `atomicReadJson` / `atomicWriteJson`
- 不做任何 debug 迁移兼容

---

### T2 — debug 读取切换到 `evolclaw.json`

**文件**：`src/index.ts`

**改动**：
```typescript
// 原来：从 defaults.debug 读（(defaults as any).debug）
// 改为：从 evolclaw.json 读
const evolclawCfg = loadEvolclawConfig();
const globalSettings: GlobalSettings = {
  idleMonitor: (defaults as any).idleMonitor,
  debug: evolclawCfg.debug,
};
```

`DefaultsConfig`（`src/types.ts`）删除 `debug?: DebugBlock` 字段。

**注意**：`(defaults as any).debug` 当前是 hack 写法（注释里有 TODO），此次顺手清理。

---

### T3 — AID 生成（evolclaw init）

**文件**：`src/cli/init.ts`

**逻辑**（在 init 流程末尾追加）：
```
loadEvolclawConfig()
├─ aid 已存在 → 跳过
└─ 无 →
    loop（最多 5 次）:
      candidate = "ec" + randomInt(10000, 99999) + ".agentid.pub"
      aidLookup(candidate).exists → 重新随机
    aidCreate(candidate)   // 不传 agent.md 相关选项
    saveEvolclawConfig({ ...existing, aid: candidate })
    console.log(`✓ 已生成控制 AID: ${candidate}`)
```

复用：`aidCreate` / `aidLookup`（`src/aun/aid/identity.ts`）

---

### T4 — ControlTunnel 组件

**新增文件**：

**`src/core/control-tunnel/transport.ts`**
```typescript
export interface TunnelRequest  { method: string; path: string; headers: Record<string,string>; body?: Buffer }
export interface TunnelResponse { status: number; headers: Record<string,string>; body?: Buffer }
export interface TunnelTransport {
  connect(aid: string): Promise<void>;
  disconnect(): Promise<void>;
  onRequest(handler: (req: TunnelRequest) => Promise<TunnelResponse>): void;
}
```

**`src/core/control-tunnel/aun-transport.ts`**（stub）
```typescript
// TODO: Gateway tunnel 协议待定
export class AunTunnelTransport implements TunnelTransport {
  async connect(_aid: string) {}
  async disconnect() {}
  onRequest(_h: any) {}
}
```

**`src/core/control-tunnel/forwarder.ts`**
- `matchTarget(path, targets)` — 最长 pathPrefix 匹配
- `forward(req, target)` — SSRF 校验（强制 `127.0.0.1`，端口 1024–65535）+ `http.request` 转发，超时/失败返回 502
- 单元测试：`tests/unit/control-tunnel/forwarder.test.ts`

**`src/core/control-tunnel/index.ts`**
```typescript
export class ControlTunnel {
  constructor(private cfg: EvolclawConfig) {}
  async start(): Promise<void>   // transport.connect(cfg.aid) + forwarder 就位
  async stop(): Promise<void>    // transport.disconnect()
  getStatus(): { aid: string; connected: boolean; targets: TunnelTarget[] }
}
```

---

### T5 — daemon 装配（src/index.ts）

在 channel 注册完成后、IpcServer 启动前：

```typescript
let controlTunnel: ControlTunnel | undefined;
if (evolclawCfg.aid && evolclawCfg.tunnel) {
  controlTunnel = new ControlTunnel(evolclawCfg);
  await controlTunnel.start();
}
```

shutdown 钩子追加：
```typescript
await controlTunnel?.stop();
```

---

### T6 — status 集成

**文件**：`src/ipc.ts` + `src/cli/index.ts`（`cmdStatus`）

IPC 响应新增 `controlTunnel?: { aid: string; connected: boolean; targets: ... }` 字段。

`evolclaw status` 输出新增一行：
```
control: ec73841.agentid.pub  [connected | disconnected | not configured]
  targets: ecweb(:18080)  metrics(:9090)
```

---

## 实现顺序

```
T1（配置层）→ T2（debug 切换）→ T3（AID 生成）→ T4（组件）→ T5（装配）→ T6（status）
```

T1–T3 可先独立交付验证，T4–T6 依赖 T1。

---

## 不在本次范围

- `AunTunnelTransport` 实现（依赖 Gateway 协议，留 stub）
- `tunnel.targets` 为空时的 AUN 纯身份连接（stub 阶段 `connect` 为 no-op，等协议定后自然覆盖）
