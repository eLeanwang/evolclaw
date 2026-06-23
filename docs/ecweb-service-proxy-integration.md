# ECWeb 经 AUN Service Proxy 反向代理实现

> 把本地 ECWeb 监控面板通过控制 AID 暴露到 AUN 网络，访问入口
> `https://proxy.{issuer}/{user_name}/{svc_name}/`，零网络配置（无需公网 IP、端口映射或域名）。
>
> 实现于 2026-06-13。落地文件见末尾「落地清单」。

## 1. 目标与背景

ECWeb（`evolclaw-web`）是 EvolClaw 的本地监控面板，默认监听 `127.0.0.1:42705`，
只在主机本地可访问。需求是：让 owner 在任意网络环境下，无需 VPN / 内网穿透 / 公网部署，
就能打开这个面板。

AUN Service Proxy 正好提供了这种能力：把一个本地 HTTP/WS 服务挂到一个 AUN AID 上，
由 AUN 的 proxy-server 充当公网入口，请求经隧道回灌到本地。整条链路复用 AUN 已有的
身份（AID）、证书信任链和加密通道，不引入任何新的网络暴露面。

## 2. 整体架构

```
浏览器                    proxy-server (公网)              本机 daemon                 ECWeb
  │                       proxy.agentid.pub:19890           (evolclaw)              127.0.0.1:42705
  │                              │                              │                        │
  │  GET /ec70338/ecweb/         │                              │                        │
  ├─────────────────────────────►                              │                        │
  │                              │  剥掉 /ec70338/ecweb 前缀     │                        │
  │                              │  经隧道下发 service_proxy_request                      │
  │                              ├──────────────────────────────►                        │
  │                              │      (WSS 长隧道 /ws/client)  │  ServiceProxyClient    │
  │                              │                              │  真实 HTTP 回连本地     │
  │                              │                              ├────────────────────────►
  │                              │                              │   GET /  (剩余 path)   │
  │                              │                              ◄────────────────────────┤
  │                              ◄──────────────────────────────┤  200 + HTML/CSS/JS     │
  ◄─────────────────────────────┤  隧道回传响应                 │                        │
```

关键点：

- **入口是 proxy-server，不是 AID 自身的 :443**。`{aid}:443` 是 Gateway 的身份 HTTP 服务
  （只服务 `/.well-known`、`/agent.md`），不路由进隧道。访问入口必须用
  `https://proxy.{issuer}/{user_name}/{svc_name}/`。
- **ServiceProxyClient 是真正的反向代理客户端**：`endpoint` 是真实本地地址，不是路由标记。
  收到隧道请求后用 `requestBackend(targetUrl)` 真实 HTTP 回连、`new WebSocket(targetUrl)`
  真实 WS 回连本地，因此 ECWeb 的 HTTP server 路由零改动。
- **控制面 + 数据面双注册**：缺一不可（见 §4）。

## 3. 控制 AID（providerAid）

Service Proxy 挂在 daemon 的**控制 AID** 上（`evolclaw.json` 的 `aid` 字段）。这个 AID 是
`pureIdentity` 的常驻身份 channel（同时也处理 `/pair` 等控制指令），在 `src/index.ts` 中
连接成功后才启动 Service Proxy：

```ts
if (evolclawCfg.serviceProxy?.enabled) {
  const proxyHandle = startServiceProxy(controlChannel, evolclawCfg.aid, evolclawCfg.serviceProxy);
  if (proxyHandle) onShutdown(() => proxyHandle.stop());
}
```

`providerAid = evolclawCfg.aid`。访问 URL 里的 `{user_name}` 是该 AID 的用户名段
（如 `ec70338.agentid.pub` → `ec70338`），`{svc_name}` 是服务配置里的 `name`。

## 4. 控制面与数据面双注册（必须都成功）

AUN Service Proxy 有两层注册，**二者都必须存在**，否则请求不会被转发：

| 层 | 谁注册 | 作用 |
|---|---|---|
| **Gateway 控制面** | provider 的 AUN 长连接调用 `proxy.register_services` | Gateway 记录该 provider 在线、声明了哪些服务，用于 wakeup 判定 |
| **proxy-server 数据面** | proxy-client 连上 proxy-server `/ws/client` 认证后发 `register_services` 隧道消息 | proxy-server 只向已注册目标服务的数据面连接转发请求 |

`ServiceProxyClient.serveForever({connectionMode:'persistent'})` 已封装整套流程：

1. `_autoRegisterServicesWithGateway()` — 存在 `aunClient.call()` 时自动 `proxy.register_services`
2. `discoverProxyWsUrl()` — 通过 `/.well-known/aun-proxy` 发现 proxy-server WS 地址
   （先读 provider AID metadata 的 1h TTL 缓存，缺失再查 well-known，应用不得硬拼 URL）
3. `_ensureAccessToken()` — 复用 cached access token；缺失/过期才 `authenticate()` 刷新
4. 隧道认证成功后自动发 `register_services` 数据面注册
5. persistent 模式内置指数退避重连（上限 60s，成功后重置）

## 5. 关键陷阱与解法

### 5.1 aunClient 生命周期：AUNChannel 重连会销毁重建 client

`AUNChannel.connect()` 每次都 `this.client = null` 再 `new`。而 `ServiceProxyClient`
构造时固定持有 `this._aunClient` 引用。**不能把 client 引用直接交给 ServiceProxyClient**，
否则一旦 AUN 重连，proxy 持有的就是已销毁的死引用。

**解法**：传一个**动态解引用 facade**，每次访问都读 channel 当前 client：

```ts
const aunFacade = {
  call: (method, params) => {
    const client = controlChannel.getClient() as any;
    if (!client) return Promise.reject(new Error('AUN control client not connected'));
    return client.call(method, params ?? {});
  },
  authenticate: () => { /* 同样动态读 client */ },
  on: (event, handler) => controlChannel.getClient()?.on?.(event, handler),
  get _tokenStore() { return controlChannel.getClient()?._tokenStore; },
  // ↓ 见 5.2
  get _identity()  { return controlChannel.getClient()?._identity; },
  get _auth()      { return controlChannel.getClient()?._auth; },
  get _deviceId()  { return controlChannel.getClient()?._deviceId; },
};
```

`serveForever(persistent)` 在 client 暂时缺失（重连窗口）时会自然走退避等待，自动恢复。

为支持这个 facade，`AUNChannel` 暴露了 `getClient(): AUNClient | null` getter——调用方
**不可缓存**返回值，每次动态读取。

### 5.2 token 复用：facade 必须透出 _identity / _auth / _deviceId

`_ensureAccessToken()` 先调 `_resolveCachedAccessToken()` 找已签发的 AUN token，它依次读：

1. `client.access_token / token / kite_token`（直接字段）
2. `client._identity`
3. `client._auth.loadIdentityOrNone(aid)`
4. `client._tokenStore.loadInstanceState(aid, deviceId, slotId)`

控制 AID 在 `connect()` 时已经 `authenticate()` 过，token 存在 `client._identity.access_token`。
**若 facade 不透出 `_identity` / `_auth` / `_deviceId`，这四路查找全部 miss**，
就会回退到 `authenticate()`——而此时 client 处于 `ready` 态，重复认证直接抛
`authenticate not allowed in state ready`，导致**隧道永远连不上 proxy-server**。

所以 facade 除了行为方法，还必须把这几个内部字段以动态 getter 形式透出（见 5.1 代码）。

### 5.3 内部失败必须接 logger，否则全静默

`ServiceProxyClient` 构造时若不传 `logger`，`serveForever()` 内部所有
`_logWarn / _logError`（隧道连接失败、认证失败、注册失败等）都会被**静默吞掉**，
任何日志里都看不到，排障时完全摸黑。务必把 evolclaw 的 `logger` 接进去
（evolclaw `logger` 的 `error/warn/info/debug` 签名与 SDK `ModuleLogger` 一致）：

```ts
new ServiceProxyClient({
  providerAid,
  aunClient: aunFacade as any,
  endpointPolicy: new EndpointPolicy(),
  logger: {
    error: (msg, err?) => logger.error(`${LOG} ${msg}${err ? ` ${err.stack || err.message}` : ''}`),
    warn:  (msg) => logger.warn(`${LOG} ${msg}`),
    info:  (msg) => logger.info(`${LOG} ${msg}`),
    debug: (msg) => logger.debug(`${LOG} ${msg}`),
  },
});
```

### 5.4 隧道回连伪装成本地直连（安全）

走 proxy 隧道时，ServiceProxyClient 回连 `127.0.0.1`，因此 ECWeb backend 看到的
`remoteAddress` 恒为回环。若 ECWeb 用「127.0.0.1 免鉴权」策略，会把**所有远程访客**放行。

**解法**：proxy-server 为每个转发请求注入可信 header（访客无法伪造，proxy-server 会剥离
伪造的 `x-aun-*`）：

- `x-aun-provider-aid` = 被访问的 provider AID
- `x-aun-service-name` = 服务名
- `x-forwarded-prefix` = `/{user_name}/{svc_name}`（外部前缀，如 `/ec70338/ecweb`）

ECWeb 的 `isLocalDirect()` = `remoteAddress 是回环` **AND** `无 x-aun-provider-aid 头`。
只有真本地直连两条件同时满足，才免配对自动发 token；隧道来源需走配对码流程。
`/api/pair-code` 对隧道来源直接拒绝（防止远程访客拿到配对码）。

> **AUN 层不传递访客身份**：proxy-server 不注入 visitor-aid。`visibility=public` 即对匿名公开。
> 若某服务需要限 owner 访问，鉴权必须由应用层（ECWeb）自己实现。

### 5.5 base href 前缀注入（前端资源相对路径）

请求经隧道转发时带 `x-forwarded-prefix`（如 `/ec70338/ecweb`）。ECWeb `serveStatic`
对 `index.html` 注入 `<base href="/ec70338/ecweb/">`，使相对路径资源（`style.css` /
`app.js` / `/api` / WS）在带不带尾斜杠时都正确解析。本地直连无此头，`<base>` 注入为 `/`，
行为不变。

前端配合：`app.js` 用 `BASE = location.pathname.replace(/[^/]*$/,'')` 计算前缀，
所有绝对路径 fetch/WS 改相对；`index.html` 把 `/style.css`→`style.css`、`/app.js`→`app.js`
（受 `<base>` 管辖）。

## 6. endpoint 发现

`resolveEndpoint(svc)` 把服务配置解析为本地回连地址：

- `source: 'ecweb'`：读 `data/instance/ecweb-*.json`（或旧名 `watch-web-*.json`），
  过滤存活进程（`process.kill(pid, 0)`），取 `startedAt` 最新一条的 `port`，
  返回 `http://127.0.0.1:{port}`。发现不到则 warn 跳过。
- `source: 'static'`（默认）：用显式配置的 `endpoint`。

**单 endpoint 同时承载 HTTP + WS**：`new WebSocket('http://127.0.0.1:port/ws')` 被
ws 库接受，无需为 WS 单独注册服务，注册一个 `http://127.0.0.1:port` 即可。

## 7. 失败降级

`startServiceProxy()` 全程 try/catch，任何异常只 `logger.warn`，返回 `null`，
**绝不阻塞 daemon 主流程**。控制 AID 首连失败也不影响——AUNChannel 内部无限重连，
`serveForever(persistent)` 会在 client 恢复后自动接上。

## 8. 配置示例（evolclaw.json）

```json
{
  "aid": "ec70338.agentid.pub",
  "ecweb": { "enabled": true, "port": 42705 },
  "serviceProxy": {
    "enabled": true,
    "services": [
      {
        "name": "ecweb",
        "source": "ecweb",
        "visibility": "public",
        "metadata": { "label": "EvolClaw Dashboard" }
      }
    ]
  }
}
```

配置字段（`ServiceProxyService`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` | 必填 | 服务名（URL 段），仅 `[a-z0-9_-]+`，不得用 `api`/`health`/`proxy`/`ws` 等保留名 |
| `enabled` | `true` | 单服务开关 |
| `source` | `static` | `ecweb`=读 instance 文件发现端口（忽略 endpoint）；`static`=用显式 endpoint |
| `endpoint` | — | 本地回连地址（`source=static` 时必填） |
| `serviceType` | `http` | `http` / `websocket` / `sse` / `mcp` |
| `visibility` | `private` | `public`=匿名可访问；`private` |
| `metadata` | — | 非敏感描述（label 等），proxy-server 会清洗 token/secret/endpoint 等字段 |

## 9. 访问

```
https://proxy.{issuer}/{user_name}/{svc_name}/
```

对本例：

```
https://proxy.agentid.pub/ec70338/ecweb/
```

> ⚠️ 不要用 `https://{aid}/{svc_name}/`（如 `https://ec70338.agentid.pub/ecweb/`）。
> 那是 Gateway 身份服务的地址，返回 `{"detail":"Not Found"}`，不走代理隧道。

## 10. 排障

| 现象 | 检查 |
|---|---|
| 访问 404 `{"detail":"Not Found"}` | URL 用错——应走 `proxy.{issuer}/{user}/{svc}/`，不是 `{aid}/{svc}/` |
| 访问 `not_service_proxy_route` | proxy-server 收到了请求但路由不匹配，确认 URL 段格式 |
| 访问 `service_not_registered` | 数据面未注册——隧道没连上或注册失败，查 daemon 日志 `[ServiceProxy]` |
| 访问 `provider_offline` | 控制面未注册——控制 AID 没在线，查 `[AUN ...] Connected` |
| daemon 日志无任何 `[ServiceProxy]` warn 但隧道不通 | logger 没接（见 5.3）；或 token 复用失败抛 `authenticate not allowed in state ready`（见 5.2） |
| 隧道是否建立 | `ss -tnp | grep :19890` 应有到 proxy-server 的 ESTABLISHED 连接 |
| 前端资源 404 / 样式错乱 | `<base href>` 前缀注入未生效（见 5.5），确认 `x-forwarded-prefix` 透传 |

## 落地清单

- `src/config-store.ts` — `ServiceProxyConfig` / `ServiceProxyService` 类型（通用，不绑 ecweb）；
  `EvolclawConfig.serviceProxy`
- `src/channels/aun.ts` — `getClient(): AUNClient | null` getter，暴露当前底层 client
- `src/aun/service-proxy.ts` — `startServiceProxy(controlChannel, providerAid, config)`：
  动态解引用 facade（含 `_identity`/`_auth`/`_deviceId` token 复用字段）、logger 接入、
  endpoint 发现、`serveForever(persistent)` 常驻隧道
- `src/index.ts` — 控制 AID 连接后按 `serviceProxy.enabled` 启动，`onShutdown` 关停
- ecweb `src/server.ts` — `isLocalDirect()` 鉴权判定、`issueLocalDirectToken()` 本地免配对、
  `/api/pair-code` 隧道来源拒绝、`serveStatic` 注入 `<base href>`（injection-safe 正则）
- ecweb `src/static/app.js` — `BASE` 前缀计算 + `apiUrl()`，绝对路径 fetch/WS 改相对，
  `tryLocalAutoPair()` 本地启动免配对
- ecweb `src/static/index.html` — 资源路径改相对（受 `<base>` 管辖）

## 参考

- AUN Service Proxy RPC 手册：`@agentunion/fastaun/_packed_docs/sdk/09-proxy-rpc-manual.md`
- 路由与 wakeup 语义、错误码：同上文档「路由与 wakeup 语义」节
