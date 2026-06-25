# AUN SDK Python - API 手册

---

## 目录

### [AUNClient](#aunclient)
- [构造函数](#构造函数)
- [属性](#属性)
- [connect()](#await-connectauth-dict-options-dict--none---none) - 建立连接
- [call()](#await-callmethod-str-params-dict--none---any) - 调用 RPC 方法
- [on()](#onevent-str-handler-callable---subscription) - 订阅事件
- [off()](#offevent-str-handler-callable---none) - 注销事件处理器
- [close()](#await-close---none) - 关闭连接
- [disconnect()](#await-disconnect---none) - 断开连接（可重连）
- [list_identities()](#list_identities---listdict) - 列出本地身份
- [ping()](#await-pingparams-dict--none---any) - 连通性探测
- [set_agent_md_path()](#set_agent_md_pathpath-str--none---str--agentmd-存储目录设置) - 设置 agent.md 本地存储根目录
- [publish_agent_md()](#await-publish_agent_md---dict--agentmd-发布主-api) - 读取本地 agent.md → 签名 → 上传，并刷新内部 etag
- [fetch_agent_md()](#await-fetch_agent_mdaid-str--none---dict--agentmd-下载主-api) - 下载 agent.md → 自动验签 → 持久化到 SDK 管理的目录
- [check_agent_md()](#await-check_agent_mdaid-str--none-max_unsynced_days-float--0---dict--agentmd-本地云端一致性检查) - 检查本地 agent.md 是否与云端一致（带缓存窗口）
- [status()](#await-statusparams-dict--none---any) - 网关状态查询
- [check_gateway_health()](#await-check_gateway_healthgateway_url-str-timeout-float--50---bool) - 检查网关可用性

### [AUNClient.Auth](#authnamespace-clientauth)
- [create_aid()](#await-create_aidparams-dict---dict) - 注册新 AID
- [check_aid()](#await-check_aidparams-dict---dict) - 检查 AID 状态（本地完整性 + 远程注册）
- [authenticate()](#await-authenticateparams-dict--none---dict) - 认证获取令牌
- [sign_agent_md()](#await-sign_agent_mdcontent-str-aid-str--none---str) - 为 agent.md 生成尾部签名 **（已 deprecated，建议改用 `client.publish_agent_md`）**
- [verify_agent_md()](#await-verify_agent_mdcontent-str-aid-str--none-cert_pem-str--none---dict) - 验证 agent.md 尾部签名 **（已 deprecated，建议改用 `client.fetch_agent_md`）**
- [upload_agent_md()](#await-upload_agent_mdcontent-str---dict) - 上传自己的 agent.md **（已 deprecated，建议改用 `client.publish_agent_md`）**
- [download_agent_md()](#await-download_agent_mdaid-str---str) - 下载指定 AID 的 agent.md **（已 deprecated，建议改用 `client.fetch_agent_md`）**
- [renew_cert()](#await-renew_certparams-dict--none---dict) - 续期证书
- [rekey()](#await-rekeyparams-dict--none---dict) - 密钥轮换
- [request_cert()](#await-request_certparams-dict---dict) - 通用证书请求
- [download_cert()](#await-download_certparams-dict--none---any) - 下载证书

### [AUNClient.Meta](#metanamespace-clientmeta)
- [ping()](#await-clientmetapingparams-dict--none--none---any) - 连通性探测
- [status()](#await-clientmetastatusparams-dict--none--none---any) - 网关状态查询
- [trust_roots()](#await-clientmetatrust_rootsparams-dict--none--none---any) - 查询信任根
- [download_trust_roots()](#await-clientmetadownload_trust_rootsurl-str--none--none--gateway_url-str--none--none-timeout-float--100---dict) - 下载信任根列表
- [download_issuer_root_cert()](#await-clientmetadownload_issuer_root_certissuer-str-url-str--none--none-timeout-float--100---str) - 下载 issuer Root CA 证书
- [verify_trust_roots()](#clientmetaverify_trust_rootstrust_list-dict--authority_cert_pem-str--none--none-authority_public_key_pem-str--none--none-allow_unsigned-bool--false---dict) - 验证信任根列表
- [import_trust_roots()](#clientmetaimport_trust_rootstrust_list-dict--authority_cert_pem-str--none--none-authority_public_key_pem-str--none--none-allow_unsigned-bool--false---dict) - 验签并导入信任根
- [refresh_trust_roots()](#await-clientmetarefresh_trust_roots---dict) - 下载、验签并导入
- [update_issuer_root_cert()](#await-clientmetaupdate_issuer_root_certissuer-str---dict) - 更新指定 issuer Root CA 证书

### [E2EEManager](#e2eemanager-cliente2ee)（高级 API，裸 WebSocket 开发者使用）
- [构造函数](#构造函数裸-websocket-开发者使用) - 独立实例化
- [encrypt_message()](#encrypt_messageto_aid-payload--peer_cert_pem-prekeynone---tupleany-bool) - 加密消息
- [decrypt_message()](#decrypt_messagemessage-dict---dict--none) - 解密单条消息（含本地防重放）
- [encrypt_outbound()](#encrypt_outboundpeer_aid-payload--peer_cert_pem-prekeynone-message_id-timestamp---tupleany-bool) - 加密出站消息（底层）
- [generate_prekey()](#generate_prekey---dict) - 生成 prekey 材料
- [cache_prekey()](#cache_prekeypeer_aid-prekey---none) - 缓存对方 prekey
- [get_cached_prekey()](#get_cached_prekeypeer_aid---dict--none) - 获取缓存的 prekey
- [invalidate_prekey_cache()](#invalidate_prekey_cachepeer_aid---none) - 使 prekey 缓存失效

### [GroupE2EEManager](#groupe2eemanager-clientgroup_e2ee)（高级 API，裸 WebSocket 开发者使用）
- [构造函数](#构造函数群组-e2ee) - 独立实例化
- [create_epoch()](#create_epochgroup_id-member_aids---dict) - 创建首个 epoch
- [rotate_epoch()](#rotate_epochgroup_id-member_aids---dict) - 轮换 epoch
- [rotate_epoch_to()](#rotate_epoch_togroup_id-target_epoch-member_aids---dict) - 指定目标 epoch 轮换（配合 CAS）
- [encrypt()](#encryptgroup_id-payload--message_idnone-timestampnone---dict) - 加密群消息
- [decrypt()](#decryptmessage-dict---dict--none) - 解密单条群消息
- [decrypt_batch()](#decrypt_batchmessages---list) - 批量解密
- [handle_incoming()](#handle_incomingpayload-dict---str--none) - 处理 P2P 密钥消息
- [build_recovery_request()](#build_recovery_requestgroup_id-epoch--sender_aidnone---dict--none) - 构建密钥恢复请求
- [handle_key_request_msg()](#handle_key_request_msgrequest_payload-current_members---dict--none) - 处理密钥请求
- [has_secret()](#has_secretgroup_id---bool) / [current_epoch()](#current_epochgroup_id---int--none) / [get_member_aids()](#get_member_aidsgroup_id---list) - 状态查询

### [其他](#其他)
- [Subscription](#subscription) - 事件订阅对象
- [内置事件](#内置事件) - 事件列表
- [RPC 方法参考](#rpc-方法参考) - 业务 RPC 手册链接

### [Stream 使用指南](#stream-使用指南)
- [创建流](#创建流) - stream.create
- [推流](#推流websocket) - WebSocket 推送数据帧
- [拉流](#拉流http-sse) - HTTP SSE 接收数据
- [关闭流](#关闭流) - stream.close
- [查询流状态](#查询流状态) - stream.get_info / stream.list_active

---

## AUNClient

主客户端类，所有操作的入口。

### 构造函数

**`AUNClient(config: dict | None)`**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `aun_path` | `str` | 否 | `~/.aun` | 应用级数据目录（AID 数据在 `{aun_path}/AIDs/{aid}/` 下） |
| `root_ca_path` | `str` | 否 | `None` | 额外 Root CA 路径 |
| `seed_password` | `str` | 否 | `None` | 本地存储保护口令 |

```python
client = AUNClient({
    "aun_path": "~/.aun/myapp",
    "seed_password": "seed",
})
```

`verify_ssl` 不在构造阶段传入。Python / TS / Go SDK 根据 `AUN_ENV` 或 `KITE_ENV` 自动决定是否校验证书；Browser SDK 恒为 `true`。

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `aid` | `str \| None` | 当前连接的 AID |
| `state` | `str` | 连接状态 (`idle` / `connecting` / `authenticating` / `connected` / `disconnected` / `reconnecting` / `terminal_failed` / `closed`) |
| `auth` | `AuthNamespace` | 认证命名空间 |
| `meta` | `MetaNamespace` | 元信息与信任根管理命名空间 |
| `e2ee` | `E2EEManager` | P2P E2EE 工具类 |
| `group_e2ee` | `GroupE2EEManager` | 群组 E2EE 工具类（当前 Python SDK 固定可用） |
| `gateway_health` | `bool \| None` | 最近一次 health check 结果，`None` 表示尚未检查 |

---

### `await connect(auth: dict, options: dict | None) -> None`

建立 WebSocket 连接。必须先调用 `client.auth.authenticate()` 获取 `auth` 参数。

**参数 `auth`**（来自 `authenticate()` 返回值）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `aid` | `str` | 是 | AID |
| `access_token` | `str` | 是 | 访问令牌 |
| `refresh_token` | `str` | 是 | 刷新令牌 |
| `expires_at` | `int` | 是 | 令牌过期时间戳（秒） |
| `gateway` | `str` | 是 | 网关 WebSocket URL |

**参数 `options`**

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `slot_id` | `str` | `""` | 同一设备上的实例槽位；空字符串表示该设备单实例模式 |
| `delivery_mode.mode` | `str` | `"fanout"` | 连接级投递语义；同一 AID 的所有在线实例必须保持一致 |
| `delivery_mode.routing` | `str` | `"round_robin"` | 仅 `queue` 模式有效 |
| `delivery_mode.affinity_ttl_ms` | `int` | `300000` | 仅 `queue + sender_affinity` 有效 |
| `auto_reconnect` | `bool` | `True` | 断线自动重连 |
| `heartbeat_interval` | `float` | `30.0` | 心跳间隔（秒） |
| `token_refresh_before` | `float` | `60.0` | 令牌过期前多久刷新（秒） |
| `connection_kind` | `str` | `"long"` | 连接类型：`"long"` = 长连接（收推送）；`"short"` = 短连接（发 RPC 后断开） |
| `short_ttl_ms` | `int` | `0` | 仅 `kind="short"` 时有效，服务端兜底关闭超时（毫秒）；0 = 不限时 |
| `retry.initial_delay` | `float` | `1.0` | 首次重连延迟（秒） |
| `retry.max_delay` | `float` | `64.0` | 最大重连延迟（秒） |
| `timeouts.connect` | `float` | `5.0` | 连接超时（秒） |
| `timeouts.call` | `float` | `10.0` | RPC 调用超时（秒） |
| `timeouts.http` | `float` | `30.0` | HTTP 请求超时（秒） |

> 当前实现只读取 `retry.initial_delay` / `retry.max_delay`；未提供 `retry.max_attempts` 选项。

```python
auth = await client.auth.authenticate({"aid": MY_AID})
await client.connect(auth, {
    "slot_id": "slot-a",
    "delivery_mode": {"mode": "fanout"},
    "auto_reconnect": True,
    "heartbeat_interval": 30.0,
})
```

**典型使用模式**

长连接守护进程（常驻收件箱）：

```python
client = AUNClient({"aun_path": "/home/alice/.aun/alice"})
auth = await client.auth.authenticate({"aid": "alice.example.com"})
await client.connect(auth, {"connection_kind": "long", "slot_id": "main"})
client.on("message.received", handle)
await asyncio.Event().wait()  # 常驻
```

CLI 短连接（与长连接共享 keystore，自动复用 token）：

```python
client = AUNClient({"aun_path": "/home/alice/.aun/alice"})  # 同 path
auth = await client.auth.authenticate({"aid": "alice.example.com"})  # 命中 cached token
await client.connect(auth, {
    "connection_kind": "short",
    "slot_id": "main",        # 与长连接同槽位共存
    "short_ttl_ms": 30000,
})
await client.call("message.send", {...})
await client.close()
```

完整说明（token 复用机制、三种典型场景对比）见 [04-连接与认证.md](04-连接与认证.md#长连接--短连接代码示例)。

---

### `await call(method: str, params: dict | None) -> Any`

调用 RPC 方法。内部保留方法（`auth.*`、`initialize` 等）不可通过此接口调用。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `method` | `str` | 是 | RPC 方法名 |
| `params` | `dict` | 否 | 方法参数 |

**返回值**: 方法返回的结果（类型取决于具体方法）

**E2EE 自动加密/解密**：

- `message.send` 和 `group.send` **默认加密发送**（`encrypt` 默认 `True`），无需显式传参
- `message.thought.put` **强制 P2P E2EE 加密**，`encrypt=False` 会被拒绝
- `group.thought.put` **强制群组 E2EE 加密**，`encrypt=False` 会被拒绝
- 发送明文消息需显式传 `encrypt=False`
- `message.pull` / `group.pull` 返回的消息已自动解密，加密消息带有 `encrypted=True` 标记
- `message.thought.get` 返回前自动解密服务端密文 `items`，应用层读取 `thoughts[]`
- `group.thought.get` 返回前自动解密服务端密文 `items`，应用层读取 `thoughts[]`
- P2P 消息的投递语义由连接阶段声明的 `delivery_mode` 决定
- `group.send` 固定为 `fanout`，不支持 `queue`
- 群消息的 `dispatch_mode` 来自群设置，SDK 会在解密后保留顶层 `dispatch_mode` 并注入 `payload.dispatch_mode`
- `message.send` / `message.thought.put` / `group.send` / `group.thought.put` 可传 `protected_headers`，SDK 会为它和 thought `context` 生成独立 `_auth`，接收端验通过后在 `message.e2ee.protected_headers` / `message.e2ee.context` 暴露给应用层
- Python SDK 会为 `message.pull` / `message.ack` 自动附带当前实例的 `device_id` / `slot_id`，应用层不应手工覆盖

```python
# 发送加密消息（默认行为，无需传 encrypt）
await client.call("message.send", {
    "to": "bob.agentid.pub",
    "payload": {"type": "text", "text": "秘密消息"},
})

# 接收并自动解密（SDK 会自动带当前实例的 device_id / slot_id）
result = await client.call("message.pull", {"after_seq": 0, "limit": 50})
for msg in result["messages"]:
    print(msg["payload"])   # 加密消息已自动解密

# 发送明文消息（需显式关闭加密）
await client.call("message.send", {
    "to": "bob.agentid.pub",
    "payload": {"type": "text", "text": "Hello"},
    "encrypt": False,
})
```

**`message.send` 额外参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `encrypt` | `bool` | 否 | 是否加密消息（默认 `true`） |
| `message_id` | `str` | 否 | 消息 ID（不传则自动生成） |
| `timestamp` | `int` | 否 | 时间戳毫秒（不传则自动生成） |
| `protected_headers` / `headers` | `dict` / `ProtectedHeaders` | 否 | E2EE 信封元数据，类似 HTTP headers；SDK 自动补 `payload_type` 并做 `_auth` 防篡改 |

P2P 消息的 `delivery_mode` 由当前连接实例携带；应用层通过 `connect` 配置即可。

**`message.thought.put/get` 额外参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `to` | `str` | put 必填 | P2P 会话另一方 AID |
| `context.type` | `str` | 是 | 思考上下文类型，推荐 `run` |
| `context.id` | `str` | 是 | 思考上下文 ID，如 `run_id` |
| `payload` | `dict` | put 必填 | 思考内容，推荐 `{"type": "thought", "text": "..."}` |
| `sender_aid` | `str` | get 必填 | thought 作者 AID |
| `peer_aid` / `to` | `str` | 条件必填 | 读取自己写的 thought 时指定会话另一方 |
| `protected_headers` / `headers` | `dict` / `ProtectedHeaders` | put 可选 | E2EE 信封元数据；`context` 会另行绑定到信封内并验 `_auth` |

`message.thought.put/get` 只使用 `context.type + context.id` 定位 thought head。

```python
await client.call("message.thought.put", {
    "to": "bob.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
    "payload": {"type": "thought", "text": "先核对约束"},
})

result = await client.call("message.thought.get", {
    "sender_aid": "bob.agentid.pub",
    "context": {"type": "run", "id": "run-xxx"},
})
```

**ProtectedHeaders 读取位置**：

```python
from aun_core import ProtectedHeaders

headers = ProtectedHeaders({"device_id": "dev-123"}).set("slot_id", "desktop")
await client.call("group.send", {
    "group_id": "10001.example.com",
    "payload": {"type": "text", "text": "群组消息"},
    "protected_headers": headers,
})

pulled = await client.call("group.pull", {"group_id": "10001.example.com"})
received_headers = pulled["messages"][0].get("e2ee", {}).get("protected_headers", {})
```

`payload_type` 由 SDK 根据加密前 `payload.type` 自动设置，应用层不需要传。完整安全语义见 [05-E2EE加密通信](05-E2EE加密通信.md#protectedheaders-与可验证上下文)。

**群消息 `dispatch_mode` 设置**：

```python
await client.call("group.set_settings", {
    "group_id": "g-abc123.agentid.pub",
    "settings": {"dispatch_mode": "mention"},
})
```

后续 `group.send` / `group.pull` / `group.message_created` 中的群消息会携带 `dispatch_mode`，取值为 `"broadcast"` 或 `"mention"`。

---

### `on(event: str, handler: Callable) -> Subscription`

订阅事件，支持同步和异步 handler。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `str` | 是 | 事件名 |
| `handler` | `Callable` | 是 | 事件处理函数 |

**返回值**: `Subscription` 对象（可调用 `.unsubscribe()` 取消订阅）

> 事件处理器内部抛出的异常会被 SDK 记录并吞掉，不会中断其他处理器，也不会自动重新抛回到调用方。

```python
sub = client.on("message.received", lambda e: print(e))
sub.unsubscribe()
```

---

### `off(event: str, handler: Callable) -> None`

注销指定的事件处理器。等价于通过 `Subscription.unsubscribe()` 取消订阅，但无需保留订阅句柄。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `str` | 是 | 事件名 |
| `handler` | `Callable` | 是 | 之前传给 `on()` 的同一处理函数引用 |

> 若传入的 handler 未注册，调用无副作用（幂等）。

```python
def handle_msg(e):
    print(e)

client.on("message.received", handle_msg)
# ... 之后取消订阅
client.off("message.received", handle_msg)
```

---

### `await close() -> None`

关闭连接，停止心跳、令牌刷新、重连等所有后台任务。调用后客户端进入 `closed` 状态，不可再次 `connect()`。

---

### `await disconnect() -> None`

断开 WebSocket 连接，但不销毁客户端。与 `close()` 的区别：`disconnect()` 后可再次调用 `connect()` 重新建立连接；`close()` 则彻底终止客户端生命周期。

断开后状态变为 `disconnected`，并发布 `connection.state` 事件。若客户端已在 `closing` 流程中，调用无副作用。

```python
await client.disconnect()
# 之后可重新连接
auth = await client.auth.authenticate({"aid": MY_AID})
await client.connect(auth)
```

---

### `list_identities() -> list[dict]`

返回本地 keystore 中所有已存储且拥有有效私钥的身份摘要列表（同步方法，无需 `await`）。

**返回值**: 每个元素结构为：

| 字段 | 类型 | 说明 |
|------|------|------|
| `aid` | `str` | AID |
| `metadata` | `dict` | 该 AID 的本地元数据（若存在） |

```python
identities = client.list_identities()
for item in identities:
    print(item["aid"])
```

---

### `await ping(params: dict | None) -> Any`

调用 `meta.ping` RPC，等价于 `await client.meta.ping(params)`。用于连通性探测或心跳检测。

---

### `set_agent_md_path(path: str | None = None) -> str` — agent.md 存储目录设置

设置 agent.md 本地存储根目录。SDK 的 `publish_agent_md` / `fetch_agent_md` / `check_agent_md` 都基于此目录读写文件和元数据。

- 传入非空路径：切换到指定目录
- 传入空字符串或 `None`：恢复默认目录 `{aun_path}/AgentMDs`
- 目录不存在时自动创建
- 切换后清空内存中的 agent.md 缓存（下次操作会重新从磁盘/list.json 加载）

**API 跨语言对齐：**

| SDK | 签名 |
|------|------|
| Python | `client.set_agent_md_path(path=None) -> str` |
| TypeScript（Node） | `client.setAgentMdPath(root?)` |
| Go | `client.SetAgentMDPath(root string) string` |
| C++ | `client.SetAgentMDPath(root) -> std::string` |
| JavaScript（浏览器） | `client.setAgentMdPath(root?)` |

**返回值：** 实际生效的根目录绝对路径。

**目录结构：**

```
{agent_md_path}/
├── list.json                    # 所有 AID 的元数据索引
├── {aid_1}/
│   └── agent.md                 # aid_1 的 agent.md 正文
├── {aid_2}/
│   └── agent.md
└── ...
```

**示例：**

```python
# 切换到自定义目录
actual = client.set_agent_md_path("/data/my-agents")
print(actual)  # "/data/my-agents"

# 恢复默认
client.set_agent_md_path()  # 回到 {aun_path}/AgentMDs
```

> **注意：** 此方法应在 `connect()` 之前或 `publish_agent_md()` / `fetch_agent_md()` 之前调用。连接后切换目录不会触发重新下载，但后续的 publish/fetch/check 会使用新目录。

---

### `await publish_agent_md() -> dict` — agent.md 发布主 API

读取 SDK 管理的本地 `agent.md`（路径：`{aun_path}/AgentMDs/{self_aid}/agent.md`）→ 调用 `auth.sign_agent_md` 在尾部追加 `<!-- AUN-SIGNATURE -->` 块 → 调用 `auth.upload_agent_md` 上传到服务端 → 以**上传字节的 sha256**计算 quoted etag 写入内部 `_local_agent_md_etag` 与持久化缓存（`agent_md_cache` 表 / `list.json`），使后续应用事件 payload 中的 `_agent_md.local_etag` 字段反映服务端实际生效的版本。

**API 跨语言对齐：**

| SDK | 签名 |
|------|------|
| Python | `await client.publish_agent_md() -> dict` |
| TypeScript（Node） | `await client.publishAgentMd()` |
| Go | `client.PublishAgentMD(ctx) (map[string]any, error)` |
| C++ | `client.PublishAgentMd(out_result)` |
| JavaScript（浏览器） | `await client.publishAgentMd(content?: string)` |

**返回值：** 透传 `auth.upload_agent_md` 的返回，含 `aid` / `etag` / `last_modified` / `agent_md_url` / `bytes`。

**副作用：**
- 更新内存中的 `_local_agent_md_etag`，等于上传字节的 quoted sha256
- 若服务端返回 `etag` 字段，同步更新内存中的 `_remote_agent_md_etag`
- 把 `content` / `local_etag` / `remote_etag` / `last_modified` / `fetched_at` / `remote_status="found"` 写入 `agent_md_cache` 持久化记录
- 把签名后的内容原子写回本地文件（含 `<!-- AUN-SIGNATURE -->` 块）

**异常：**
- `ValidationError`：未持有本地身份 / 本地 agent.md 文件不存在或为空
- `StateError`：SDK 未连接
- `AUNError`：上传失败

**示例：**

```python
result = await client.publish_agent_md()
print(result["agent_md_url"], result["etag"])
```

---

### `await fetch_agent_md(aid: str | None = None) -> dict` — agent.md 下载主 API

下载指定 AID 的 `agent.md`，自动调用 `auth.verify_agent_md` 验签；`aid` 缺省取本地身份；下载结果**固定保存**到 `{aun_path}/AgentMDs/{aid}/agent.md`，并同步更新持久化缓存（`agent_md_cache` 表 / `list.json`）。若目标 aid 是自己则刷新内部 `_local_agent_md_etag` 并计算 `in_sync`。

**API 跨语言对齐：**

| SDK | 签名 |
|------|------|
| Python | `await client.fetch_agent_md(aid=None) -> dict` |
| TypeScript（Node） | `await client.fetchAgentMd(aid?)` |
| Go | `client.FetchAgentMD(ctx, aid string) (*AgentMDInfo, error)` |
| C++ | `client.FetchAgentMd(aid, out_info)` |
| JavaScript（浏览器） | `await client.fetchAgentMd(aid?)` |

**返回字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `aid` | `str` | 实际下载的 AID（缺省时为自身 AID） |
| `content` | `str` | agent.md 完整文本 |
| `signature` | `dict` | `auth.verify_agent_md` 的返回（status / verified / reason / cert_fingerprint / timestamp） |
| `in_sync` | `bool \| None` | 仅当 aid 是自己时给出：本地 etag == 服务端 etag；否则为 `null` |
| `saved_to` | `str \| None` | 实际写入路径（`{aun_path}/AgentMDs/{aid}/agent.md`）；浏览器 SDK 无此字段 |
| `save_error` | `str \| None` | 写盘失败原因；不影响下载成功；浏览器 SDK 无此字段 |

**副作用：**
- 把 `content` / `local_etag = sha256(content)` / `remote_etag` / `last_modified` / `fetched_at` / `remote_status="found"` / `verify_status` / `verify_error` 写入 `agent_md_cache` 持久化记录
- 若 `aid == self_aid`：刷新 `_local_agent_md_etag` 并比对 `_remote_agent_md_etag` 计算 `in_sync`

**异常：**
- `ValidationError`：未传 aid 且本地无身份
- `NotFoundError`：服务端 404
- `AUNError`：其他 HTTP 错误

**调用建议：** 通常先调 `check_agent_md` 检查状态，仅当 `local_found=False` 且 `remote_found=True` 或用户明确要更新本地版本时才调 `fetch_agent_md`。SDK 不会因为 `_observe_rpc_meta` 收到新 etag 而主动下载（除非本地从未保存过该 aid 的内容）。

**示例：**

```python
# 拉自己的 agent.md，并判断是否与服务端同步
info = await client.fetch_agent_md()
print(info["signature"]["status"], info["in_sync"], info["saved_to"])

# 拉别人的 agent.md（自动写到 {aun_path}/AgentMDs/bob.agentid.pub/agent.md）
info = await client.fetch_agent_md("bob.agentid.pub")
```

---

### `await check_agent_md(aid: str | None = None, max_unsynced_days: float = 0) -> dict` — agent.md 本地/云端一致性检查

检查指定 AID 的 agent.md 在本地和服务端的状态，**不主动下载**（除非远程存在而本地从未保存过——由 `_observe_rpc_meta` 异步触发的延迟下载除外）。返回值包含本地是否存在、是否与云端一致、验签状态、是否走了 HEAD 等信息，由应用层根据返回值决定是否调 `fetch_agent_md`。

**API 跨语言对齐：**

| SDK | 签名 |
|------|------|
| Python | `await client.check_agent_md(aid=None, max_unsynced_days: float = 0) -> dict` |
| TypeScript（Node） | `await client.checkAgentMd(aid?, maxUnsyncedDays = 0)` |
| Go | `client.CheckAgentMD(ctx, aid string, maxUnsyncedDays ...float64) (*AgentMDCheckResult, error)` |
| C++ | `client.CheckAgentMd(aid, out_result)` 或 `client.CheckAgentMd(aid, max_unsynced_days, out_result)` |
| JavaScript（浏览器） | `await client.checkAgentMd(aid?, maxUnsyncedDays = 0)` |

**`max_unsynced_days` 语义：**

- `= 0`（默认）：每次都强制 HEAD 服务端确认 etag/last_modified
- `> 0`：若距上次 HEAD（`checked_at` 字段）在 N 天内，且本地缓存的 `local_etag == remote_etag`，则直接返回缓存（`cached=true`），跳过 HEAD；否则仍走 HEAD

> **重要：** N 天的窗口基于 SDK 上次 HEAD 的时间（`checked_at`），不是基于服务端 `Last-Modified`。这样即使 agent.md 长期不变，也会在 N 天后强制重新确认。

**返回字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `aid` | `str` | 检查的 AID |
| `local_found` | `bool` | 本地 `agent_md_cache` 是否有 content 或 local_etag |
| `remote_found` | `bool` | 服务端是否存在该 AID 的 agent.md |
| `local_etag` | `str` | 本地缓存的 quoted sha256 etag |
| `remote_etag` | `str` | 服务端 HEAD 返回的 etag（命中缓存时用缓存值） |
| `in_sync` | `bool` | `local_etag == remote_etag` 且两者都非空 |
| `last_modified` | `str` | 服务端 HTTP 日期格式的 Last-Modified |
| `status` | `int` | HEAD 响应状态码（缓存命中时为 200） |
| `cached` | `bool` | 是否命中本地窗口缓存（true 时未走 HEAD） |
| `verify_status` | `str` | 上次 fetch 的验签状态（cached 时复用） |
| `verify_error` | `str` | 上次 fetch 的验签错误（cached 时复用） |

**副作用：**
- 走 HEAD 路径时：更新 `agent_md_cache` 的 `remote_etag` / `last_modified` / `checked_at` / `remote_status` 字段
- 若 aid 是自身且 HEAD 拿到 remote_etag：同步更新内存中的 `_remote_agent_md_etag`
- 若远程存在但本地从未保存过 → 通过 `_observe_agent_md_meta` 异步调度后台 fetch（不阻塞返回）

**异常：**
- `ValidationError`：未传 aid 且本地无身份
- HEAD 网络错误：抛出原始异常（同时把 `last_error` 写入缓存记录）

**典型用法：**

```python
# 严格模式：每次都确认服务端
state = await client.check_agent_md("bob.agentid.pub")
if state["remote_found"] and not state["in_sync"]:
    # 服务端有更新版本
    info = await client.fetch_agent_md("bob.agentid.pub")

# 宽松模式：3 天内不重复 HEAD
state = await client.check_agent_md("bob.agentid.pub", max_unsynced_days=3)
if state["local_found"] and state["in_sync"]:
    print("本地版本是最新的")
```

---

### `_agent_md` 事件 payload 字段（保留）

SDK 在 publish `message.received` / `group.message_created` 等应用事件时仍会自动注入：

```python
{
  "_agent_md": {
    "local_etag": "\"abc...\"",   # publish_agent_md / fetch_agent_md（自身）后内部计算
    "remote_etag": "\"def...\"",  # gateway 在每次 RPC envelope._meta.agent_md_etag 注入
  },
  # ... 原有业务字段
}
```

应用层比对二者是否一致即可知本地是否需要重新 publish。

**Gateway 多 AID etag 注入（v0.x+）：** Gateway 现在在 RPC response 和事件通知的 `_meta` 中**最多同时注入两个 AID** 的 agent.md 元数据：

- **requester**：调用者 / 事件订阅方（自身）
- **peer**：RPC 对端 / 事件源（仅当 `peer_aid != requester_aid` 时注入）

每个条目都带 `aid` 字段。`receiver` / `to` / `target` / `sender` / `from` 等是为了兼容旧 SDK 而保留的**别名**，它们指向与 `requester` 或 `peer` 完全相同的对象（不是独立 AID），新 SDK 只需读 `requester` 和 `peer` 即可：

```json
{
  "_meta": {
    "agent_md_etag": "\"requester-etag\"",
    "agent_md_etags": {
      "requester": {"aid": "alice.agentid.pub", "etag": "\"...\"", "last_modified": "..."},
      "peer":      {"aid": "bob.agentid.pub",   "etag": "\"...\"", "last_modified": "..."},

      "receiver":  { /* 与 requester 同一对象（事件场景）或与 peer 同一对象（RPC 场景） */ },
      "to":        { /* alias of peer（RPC 场景） */ },
      "target":    { /* alias of peer / requester */ },
      "sender":    { /* alias of peer（事件场景） */ },
      "from":      { /* alias of peer（事件场景） */ }
    }
  }
}
```

| 场景 | requester | peer | 别名分布 |
|------|-----------|------|---------|
| RPC response | 调用者 | 对端（如果 RPC 涉及 to_aid 且不等于调用者） | `receiver/to/target` → peer |
| 事件通知 | 订阅方 | 事件源（如果存在且不等于订阅方） | `receiver/target` → requester；`sender/from` → peer |

- 各 SDK 收到后通过 `_observe_rpc_meta` → `_observe_agent_md_meta(aid, etag, last_modified)` 写入 `agent_md_cache` 持久化记录（`setdefault` 自动按 AID 去重，别名不会重复处理）
- 若发现"远程有 etag 但本地从未保存该 aid"，SDK 会异步触发后台 `fetch_agent_md` 拉取一次（不阻塞 RPC 返回）；其他场景**不会**主动下载

> **注意：** v0.x 起删除了 `set_local_agent_md_path()` / `get_local_agent_md_etag()` / `get_remote_agent_md_etag()` 三个旧 API。`_local_etag` 现在由 `publish_agent_md` / `fetch_agent_md(自身 aid)` 自动计算并缓存；不再支持外部直接设置或读取。

---

### `await status(params: dict | None) -> Any`

调用 `meta.status` RPC，等价于 `await client.meta.status(params)`。返回网关服务状态信息。

---

### `await check_gateway_health(gateway_url: str, timeout: float = 5.0) -> bool`

基于传入的 Gateway WebSocket URL 动态构造健康检查地址：将末尾路径替换为 `/health`，并将 `wss://` / `ws://` 分别转换为 `https://` / `http://`。随后向该地址发送 `GET /health` 请求，检查网关可用性。结果同步更新 `gateway_health` 属性。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `gateway_url` | `str` | — | 服务器发现返回的网关 WebSocket URL（`wss://.../aun` 或 `ws://.../aun`） |
| `timeout` | `float` | `5.0` | 超时秒数 |

返回 `True` 表示网关可用（HTTP 200），`False` 表示不可用或超时。

> **说明**：`discover()` 成功后会自动异步触发一次 health check，无需手动调用。

**各语言对应 API**

| 语言 | 属性 | 方法 |
|------|------|------|
| Python | `client.gateway_health` | `await client.check_gateway_health(url)` |
| TypeScript | `client.gatewayHealth` | `await client.checkGatewayHealth(url)` |
| Go | `client.GatewayHealth()` | `client.CheckGatewayHealth(ctx, url, timeout)` |
| JS (browser) | `client.gatewayHealth` | `await client.checkGatewayHealth(url)` |

---

## AUNClient.Auth (`client.auth`)

---

### `await create_aid(params: dict) -> dict`

注册新 AID，本地生成 ECDSA 密钥对并向 Gateway 申请 X.509 证书。

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `aid` | `str` | 是 | 要注册的 AID |

**返回值**

| 字段 | 类型 | 说明 |
|------|------|------|
| `aid` | `str` | 已注册的 AID |
| `cert_pem` | `str` | X.509 证书（PEM 格式） |
| `gateway` | `str` | 网关 URL |

```python
MY_AID = f"alice-{random.randint(1000,9999)}.agentid.pub"
result = await client.auth.create_aid({"aid": MY_AID})
# {"aid": "alice-XXXX.agentid.pub", "cert_pem": "-----BEGIN...", "gateway": "ws://..."}
```

---

### `await check_aid(params: dict) -> dict`

检查 AID 的本地密钥/证书完整性和远程注册状态。用于首次启动时判断是创建还是恢复，或连接前确认本地状态。

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `aid` | `str` | 是 | 要检查的 AID |

**返回值**

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `str` | `local_ready` / `local_incomplete` / `available` / `registered_remote` / `unknown` |
| `can_register` | `bool\|null` | 是否可注册（`local_ready` 时为 `false`） |
| `local` | `dict` | 本地状态详情（`exists` / `complete` / `private_key` / `public_key` / `certificate` / `issues`） |
| `remote` | `dict` | 远程状态（`status`: `not_checked` / `registered` / `available` / `error`） |

```python
result = await client.auth.check_aid({"aid": "alice.agentid.pub"})
if result["status"] == "local_ready":
    # 可以直接连接
    pass
elif result["can_register"]:
    # AID 可用，创建新身份
    await client.auth.create_aid({"aid": "alice.agentid.pub"})
```

**跨语言**

| 语言 | 调用方式 |
|------|----------|
| Python | `await client.auth.check_aid({"aid": "..."})` |
| TypeScript | `await client.auth.checkAid({ aid: '...' })` |
| Go | `client.Auth.CheckAID(ctx, map[string]any{"aid": "..."})` |
| C++ | `client->Auth()->CheckAID("...", callback)` |

---

### `await authenticate(params: dict | None) -> dict`

执行双向 ECDSA 挑战-响应认证，获取访问令牌。

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `aid` | `str` | 否 | AID（可选，默认使用已加载的身份） |

**返回值**

| 字段 | 类型 | 说明 |
|------|------|------|
| `aid` | `str` | 认证的 AID |
| `access_token` | `str` | 访问令牌 |
| `refresh_token` | `str` | 刷新令牌 |
| `expires_at` | `int` | 令牌过期时间戳（秒） |
| `gateway` | `str` | 网关 WebSocket URL |

```python
auth = await client.auth.authenticate({"aid": MY_AID})
```

---

### `await sign_agent_md(content: str, aid: str | None = None) -> str`

> **⚠️ Deprecated。** 主要场景请改用 `client.publish_agent_md(path)`，它内部已包含读文件 + 签名 + 上传一整套流程。`sign_agent_md` 仅作为离线签名（先签名后异步发布、给非 SDK 渠道发送等）的底层工具继续保留，未来版本将移除。

为 `agent.md` 生成尾部签名块。

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | `str` | 是 | 完整的 `agent.md` 文本（YAML frontmatter + Markdown 正文 + 可选尾部签名块） |
| `aid` | `str` | 否 | 指定要使用的本地身份 AID；不传则使用当前 AID |

**返回值**

签名后的完整 `agent.md` 文本。

**说明**

- 若输入内容已经带有尾部签名块，会先剥离旧签名再重新签名
- 签名块位于文件尾部，签名内容只覆盖签名块之前的全部字节
- 签名块本身不参与验证时的 payload 计算

---

### `await verify_agent_md(content: str, aid: str | None = None, cert_pem: str | None = None) -> dict`

> **⚠️ Deprecated。** 主要场景请改用 `client.fetch_agent_md(aid)`，它内部已包含下载 + 自动验签 + etag 缓存。`verify_agent_md` 仅作为对纯文本 agent.md（来自非 SDK 渠道）的验签底层工具继续保留，未来版本将移除。

验证 `agent.md` 尾部签名。

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | `str` | 是 | 完整的 `agent.md` 文本 |
| `aid` | `str` | 否 | 预期 AID；用于校验 payload 中的 `aid` 与证书归属 |
| `cert_pem` | `str` | 否 | 直接提供对端证书 PEM；不传时 SDK 会按 `aid + cert_fingerprint` 拉取 |

**返回值**

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `str` | `verified` / `invalid` / `unsigned` |
| `verified` | `bool` | 是否验签成功 |
| `payload` | `str` | 去掉尾部签名块后的原始内容 |
| `reason` | `str` | 失败原因（仅 `invalid` 时可能存在） |
| `aid` | `str` | 关联 AID |
| `cert_fingerprint` | `str` | 使用的证书指纹 |
| `timestamp` | `int` | 签名时间戳 |

**说明**

- `unsigned` 表示文件未带签名块，不视为错误
- 若 `cert_pem` 未提供，SDK 会根据 `aid` 和签名块里的 `cert_fingerprint` 拉取对端证书再验签
- 验签失败不会抛异常，而是通过 `status=invalid` 返回原因

---

### `await upload_agent_md(content: str) -> dict`

> **⚠️ Deprecated。** 请改用 `client.publish_agent_md(path)`，它会自动读文件、签名、上传并刷新内部 etag。`upload_agent_md` 仅作底层 API 继续保留以兼容旧代码，未来版本将移除。

上传当前 AID 的公开 `agent.md` 文档。

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | `str` | 是 | 完整的 `agent.md` 文本（YAML frontmatter + Markdown 正文 + 可选尾部签名块） |

**返回值**

| 字段 | 类型 | 说明 |
|------|------|------|
| `aid` | `str` | 当前上传目标 AID |
| `bytes` | `int` | 文档字节数 |
| `etag` | `str` | 服务端返回的 ETag |
| `last_modified` | `str` | HTTP 日期格式的最后修改时间 |
| `agent_md_url` | `str` | 文档访问 URL |

**说明**

- 该方法会自动复用本地缓存的 access token；若 token 缺失或过期，会自动重新认证后再上传
- 对应 HTTP 端点：`PUT https://{aid}/agent.md`
- 上传需要 `Authorization: Bearer <access_token>`
- 常见错误：
  `401` 表示缺失或无效 token
  `403` 表示 token 的 `aid` 与目标 Host 不一致
  `400` 表示 `agent.md` frontmatter 非法，或其中的 `aid` 与目标 Host 不一致
  `413` 表示文档大小超过服务端限制
  SDK 在这些场景下抛出 `AUNError`

```python
result = await client.auth.upload_agent_md("""---
aid: alice.agentid.pub
name: Alice
---

# Alice
""")
```

---

### `await download_agent_md(aid: str) -> str`

> **⚠️ Deprecated。** 请改用 `client.fetch_agent_md(aid)`，它会自动下载、验签、刷新内部 etag，并支持可选写盘。`download_agent_md` 仅作底层 API 继续保留以兼容旧代码，未来版本将移除。

匿名下载指定 AID 的公开 `agent.md` 文档。

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `aid` | `str` | 是 | 目标 AID |

**返回值**

完整的 `agent.md` 文本。

**说明**

- 对应 HTTP 端点：`GET https://{aid}/agent.md`
- 若只需查询是否存在及缓存元数据，可直接使用 `HEAD https://{aid}/agent.md`
- 下载不需要认证
- `404` 表示目标 AID 尚未发布 `agent.md`
- SDK 在 `404` 时抛出 `NotFoundError`，其他非 2xx 状态抛出 `AUNError`

```python
agent_md = await client.auth.download_agent_md("bob.agentid.pub")
```

---

### `await renew_cert(params: dict | None) -> dict`

续期当前 AID 的证书（保持相同密钥，只延长有效期）。透传到 `auth.renew_cert` RPC。

**使用场景**: 证书即将过期时的日常续期操作

**参数 / 返回值**: 详见协议文档 [01-身份与凭证协议-auth §1.6 auth.renew_cert](../../docs/protocol/01-身份与凭证协议-auth.md)

**注意**: 仅 Python SDK 提供此便捷方法；其他语言通过 `client.call("auth.renew_cert", params)` 调用

---

### `await rekey(params: dict | None) -> dict`

重新生成密钥对并签发新证书（用于密钥泄露后的安全恢复）。透传到 `auth.rekey` RPC。

**使用场景**: 密钥泄露、安全事件响应、主动密钥轮换

**参数 / 返回值**: 详见协议文档 [01-身份与凭证协议-auth §1.6 auth.rekey](../../docs/protocol/01-身份与凭证协议-auth.md)

**注意**: 仅 Python SDK 提供此便捷方法；其他语言通过 `client.call("auth.rekey", params)` 调用

---

### `await request_cert(params: dict) -> dict`

通用的证书请求接口。透传到 `auth.request_cert` RPC。

**使用场景**: 为已有 AID 申请不同曲线的额外证书

**参数 / 返回值**: 详见协议文档 [01-身份与凭证协议-auth §1.6 auth.request_cert](../../docs/protocol/01-身份与凭证协议-auth.md)

**注意**: 仅 Python SDK 提供此便捷方法；其他语言通过 `client.call("auth.request_cert", params)` 调用

---

## MetaNamespace (`client.meta`)

### `await client.meta.ping(params: dict | None = None) -> Any`

调用 `meta.ping` RPC，检测与网关的连通性。需已连接。

### `await client.meta.status(params: dict | None = None) -> Any`

调用 `meta.status` RPC，获取网关服务状态信息。需已连接。

### `await client.meta.trust_roots(params: dict | None = None) -> Any`

查询网关信任的 Root CA 列表（需已连接）。

**参数**: 无

**返回值**: 管理局签名的受信根证书列表。早期服务可能返回 `roots/count` 兼容结构。

### `await client.meta.download_trust_roots(url: str | None = None, *, issuer: str | None = None, gateway_url: str | None = None, timeout: float = 10.0) -> dict`

从管理局权威端点、`pki.{issuer}` 泛域名端点或 Gateway 镜像端点下载受信根列表。优先级为显式 `url`、`https://pki.{issuer}/trust-root.json`、已连接 Gateway 的 `https://gateway.{issuer}/pki/trust-roots.json`、管理局权威端点。

### `await client.meta.download_issuer_root_cert(issuer: str, url: str | None = None, *, timeout: float = 10.0) -> str`

从 `https://pki.{issuer}/root.crt` 下载该 issuer 证书链锚定的 Root CA PEM。该方法只下载和解析证书，不会导入本地信任根。

### `client.meta.verify_trust_roots(trust_list: dict, *, authority_cert_pem: str | None = None, authority_public_key_pem: str | None = None, allow_unsigned: bool = False) -> dict`

验证 `authority_signature`、`version`、`issued_at`、`next_update`、Root CA 证书有效期、CA 约束和 `fingerprint_sha256`，只返回可导入摘要，不写入本地信任根。默认拒绝未签名列表；`allow_unsigned=True` 仅用于私有测试环境。

### `client.meta.import_trust_roots(trust_list: dict, *, authority_cert_pem: str | None = None, authority_public_key_pem: str | None = None, allow_unsigned: bool = False) -> dict`

在 `verify_trust_roots()` 通过后，进一步检查 `version` 不低于本地已导入版本，再写入 `{aun_path}/CA/root/trust-roots.json` 和 `{aun_path}/CA/root/trust-roots.pem`，并刷新当前客户端的信任根缓存。

### `await client.meta.refresh_trust_roots(...) -> dict`

组合执行下载、验签、导入和刷新。应用层通常优先使用该方法。

### `await client.meta.update_issuer_root_cert(issuer: str, *, cert_pem: str | None = None, url: str | None = None, trust_list: dict | None = None, authority_cert_pem: str | None = None, authority_public_key_pem: str | None = None, allow_unsigned: bool = False, timeout: float = 10.0) -> dict`

下载或接收 `issuer` 的 `root.crt`，校验证书为自签 Root CA，并确认其 SHA-256 指纹存在于已验签的受信根列表中，通过后写入 `{aun_path}/CA/root/issuers/{issuer}.root.crt`，合并进 `{aun_path}/CA/root/trust-roots.pem`，并刷新当前客户端信任根缓存。

顶层兼容方法 `await client.trust_roots()` 仍保留，等价于 `await client.meta.trust_roots()`。

---

## E2EEManager (`client.e2ee`)

> **高级 API**：主要供裸 WebSocket 开发者使用。普通 SDK 开发者无需额外操作——`call("message.send", ...)` 默认加密发送，SDK 会自动处理加密/解密，无需直接使用本节 API。
>
> `E2EEManager` 是纯密码学工具类，无 I/O 依赖，可独立于 `AUNClient` 实例化。
>
> 更详细的用法可参考 SDK 内部实现：`src/aun_core/client.py` 中 `_send_encrypted` / `_decrypt_message` 等方法。

### 构造函数（裸 WebSocket 开发者使用）

```python
E2EEManager(
    *,
    identity_fn,      # () -> {aid, private_key_pem, public_key_der_b64}
    keystore,         # KeyStore protocol 实现
    prekey_cache_ttl=3600.0,  # prekey 缓存 TTL（秒）
)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `identity_fn` | `() -> dict` | 返回当前身份信息 |
| `keystore` | `KeyStore` | 密钥存储实现 |
| `prekey_cache_ttl` | `float` | prekey 缓存过期时间，默认 3600 秒 |

---

### `encrypt_message(to_aid, payload, *, peer_cert_pem, prekey=None, message_id=None, timestamp=None) -> tuple[Any, bool]`

加密消息（便利方法，自动生成 message_id / timestamp）。有 prekey → prekey_ecdh_v2，无 prekey → long_term_key。传入的 prekey 自动缓存。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `to_aid` | `str` | 是 | 对端 AID |
| `payload` | `dict` | 是 | 原始消息载荷 |
| `peer_cert_pem` | `bytes` | 是 | 对端证书（PEM） |
| `prekey` | `dict \| None` | 否 | 对端 prekey（None 时查缓存或降级） |
| `message_id` | `str` | 否 | 消息 ID（不传则自动生成） |
| `timestamp` | `int` | 否 | 时间戳毫秒（不传则自动生成） |

**返回值**: `(envelope, encrypted)` — 加密信封和是否成功标志

---

### `decrypt_message(message: dict) -> dict | None`

解密单条消息，内置本地防重放（seen set）。重复消息返回 `None`。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | `dict` | 是 | 原始消息 |

**返回值**: 解密后的消息，解密失败或重放返回 `None`

---

### `encrypt_outbound(peer_aid, payload, *, peer_cert_pem, prekey=None, message_id, timestamp) -> tuple[Any, bool]`

加密出站消息（底层方法）。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `peer_aid` | `str` | 是 | 对端 AID |
| `payload` | `dict` | 是 | 原始消息载荷 |
| `peer_cert_pem` | `bytes` | 是 | 对端证书（PEM） |
| `prekey` | `dict \| None` | 否 | 对端 prekey |
| `message_id` | `str` | 是 | 消息 ID |
| `timestamp` | `int` | 是 | 时间戳（毫秒） |

**返回值**: `(envelope, encrypted)`

---

### `generate_prekey() -> dict`

生成 prekey 材料（密钥对 + 签名），私钥保存在本地 keystore。返回上传材料，调用方自行上传到服务端。

**返回值**: `{"prekey_id": "uuid", "public_key": "base64", "signature": "base64"}`

---

### `cache_prekey(peer_aid, prekey) -> None`

缓存对方的 prekey，后续 encrypt 自动复用。

---

### `get_cached_prekey(peer_aid) -> dict | None`

获取缓存的 prekey，过期返回 `None`。

---

### `invalidate_prekey_cache(peer_aid) -> None`

使指定 peer 的 prekey 缓存失效。

---

## GroupE2EEManager (`client.group_e2ee`)

> **高级 API**：主要供裸 WebSocket 开发者使用。普通 SDK 开发者无需额外操作——`call("group.send", ...)` 默认加密发送，SDK 自动处理群组加密/解密和密钥管理。
>
> `GroupE2EEManager` 是纯密码学 + 本地状态工具类，零 I/O 依赖，可独立于 `AUNClient` 实例化。
> 内置防重放、epoch 降级防护、密钥请求/响应频率限制。
>
> 更详细的用法可参考 SDK 内部实现：`src/aun_core/client.py` 中群组 E2EE 自动编排（`_rotate_group_epoch` / `_distribute_key_to_new_member` / `_try_handle_group_key_message` 等方法）。

### 构造函数（群组 E2EE）

```python
GroupE2EEManager(
    *,
    identity_fn,            # () -> {aid, private_key_pem, ...}
    keystore,               # KeyStore protocol 实现
    request_cooldown=30.0,  # 密钥请求冷却时间（秒）
    response_cooldown=30.0, # 密钥响应冷却时间（秒）
)
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `identity_fn` | `() -> dict` | 返回当前身份信息 |
| `keystore` | `KeyStore` | 密钥存储实现 |
| `request_cooldown` | `float` | 同一 group+epoch 密钥请求最小间隔，默认 30 秒 |
| `response_cooldown` | `float` | 同一 group+requester 密钥响应最小间隔，默认 30 秒 |

---

### `create_epoch(group_id, member_aids) -> dict`

创建首个 epoch（建群时调用）。生成群密钥，本地存储，返回分发信息。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `group_id` | `str` | 是 | 群组 ID |
| `member_aids` | `list[str]` | 是 | 初始成员 AID 列表 |

**返回值**: `{epoch: 1, commitment: str, distributions: [{to: str, payload: dict}]}`

调用方需将 `distributions` 中的每个 payload 通过 P2P E2EE 发送给对应成员。

---

### `rotate_epoch(group_id, member_aids) -> dict`

轮换 epoch（踢人/定时轮换时调用）。自动递增 epoch 号，返回格式与 `create_epoch` 相同。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `group_id` | `str` | 是 | 群组 ID |
| `member_aids` | `list[str]` | 是 | 轮换后的成员列表（不含被踢成员） |

**返回值**: `{epoch, commitment, distributions}`

---

### `rotate_epoch_to(group_id, target_epoch, member_aids) -> dict`

指定目标 epoch 号轮换（配合服务端 CAS 使用）。当服务端通过 CAS 分配了 epoch 号后，用此方法生成对应密钥。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `group_id` | `str` | 是 | 群组 ID |
| `target_epoch` | `int` | 是 | 服务端 CAS 分配的 epoch 号 |
| `member_aids` | `list[str]` | 是 | 成员列表 |

**返回值**: `{epoch, commitment, distributions}`

---

### `encrypt(group_id, payload, *, message_id=None, timestamp=None) -> dict`

加密群消息。使用当前 epoch 的群密钥加密。无密钥时抛 `E2EEGroupSecretMissingError`。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `group_id` | `str` | 是 | 群组 ID |
| `payload` | `dict` | 是 | 原始消息载荷 |
| `message_id` | `str` | 否 | 消息 ID（不传则自动生成） |
| `timestamp` | `int` | 否 | 时间戳毫秒（不传则自动生成） |

**返回值**: 加密信封 `dict`（`type: "e2ee.group_encrypted"`）

---

### `decrypt(message: dict) -> dict | None`

解密单条群消息。内置防重放 + 外层 `group_id` / `from` / `sender_aid` 校验。非加密消息原样返回，解密失败返回 `None`。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | `dict` | 是 | 原始群消息（含 payload、group_id、from 等字段） |

**返回值**: 解密后的消息，解密失败返回 `None`，非加密消息原样返回

---

### `decrypt_batch(messages) -> list`

批量解密群消息（用于 `group.pull` 返回的消息列表）。解密失败的消息保留原始内容。

---

### `handle_incoming(payload: dict) -> str | None`

处理已解密的 P2P 密钥消息（分发/请求/响应）。收到 P2P 消息后先解密，再将内层 payload 传入此方法。

**返回值**:

| 返回值 | 含义 |
|--------|------|
| `"distribution"` | 密钥分发已存储 |
| `"distribution_rejected"` | epoch 降级被拒 |
| `"request"` | 收到密钥请求，需调用 `handle_key_request_msg` 构建响应 |
| `"response"` | 密钥恢复响应已存储 |
| `"response_rejected"` | 响应被拒（epoch 降级） |
| `None` | 不是密钥消息 |

---

### `build_recovery_request(group_id, epoch, *, sender_aid=None) -> dict | None`

构建密钥恢复请求（缺密钥时调用）。受频率限制，冷却期内返回 `None`。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `group_id` | `str` | 是 | 群组 ID |
| `epoch` | `int` | 是 | 需要恢复的 epoch |
| `sender_aid` | `str` | 否 | 消息发送者 AID（备选恢复目标） |

**返回值**: `{to: str, payload: dict}` 或 `None`（限流/无目标时）

调用方需将 `payload` 通过 P2P E2EE 发送给 `to`。

---

### `handle_key_request_msg(request_payload, current_members) -> dict | None`

处理密钥请求并构建响应（受频率限制）。校验请求者是否在 `current_members` 中。

**参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `request_payload` | `dict` | 是 | 密钥请求消息（含 requester_aid、group_id、epoch） |
| `current_members` | `list[str]` | 是 | 当前群成员列表（用于校验请求者身份） |

**返回值**: 响应 payload `dict`，或 `None`（非成员/限流/无密钥时）

> **注意**：SDK 自动编排中，如果请求者不在本地 `member_aids` 中，会先回源查询 `group.get_members` 获取服务端最新成员列表后再调用此方法。裸 WebSocket 开发者也应实现类似逻辑。

---

### `has_secret(group_id) -> bool`

查询指定群组是否有本地密钥。

---

### `current_epoch(group_id) -> int | None`

获取指定群组的当前 epoch 号，无密钥时返回 `None`。

---

### `get_member_aids(group_id) -> list`

获取指定群组当前 epoch 的本地成员列表，无密钥时返回空列表。

> **注意**：返回的是本地保存的成员视图，不一定与服务端最新一致。需要最新列表时应查询 `group.get_members`。

---

## Subscription

`client.on()` 的返回值。

### `unsubscribe() -> None`

取消事件订阅，幂等（多次调用无副作用）。

---

## 内置事件

| 事件名 | 触发时机 | payload 结构 |
|--------|----------|--------------|
| `message.received` | 收到新消息推送 | `Message` 对象 |
| `message.recalled` | 消息被撤回 | 撤回信息 |
| `message.ack` | 消息已读确认 | `{"ack_seq": N, "device_id": "...", "slot_id": "..."}` |
| `message.undecryptable` | P2P 消息解密失败 | 原始加密消息 |
| `group.changed` | 群组状态变更 | 变更详情 |
| `group.message_created` | 收到群消息推送 | 群消息对象 |
| `group.message_undecryptable` | 群消息解密失败 | 原始加密群消息 |
| `storage.object_changed` | 存储对象变更（put/delete） | `{"action": "put"/"delete", "owner_aid": "...", "object_key": "..."}` |
| `e2ee.degraded` | E2EE 降级为 long_term_key | `{"peer_aid": "...", "reason": "..."}` |
| `e2ee.orchestration_error` | 群 E2EE 编排失败 | 错误详情 |
| `connection.state` | 连接状态变化 | `{"state": "..."}` |
| `connection.challenge` | 收到认证挑战 | 挑战参数 |
| `connection.error` | 连接发生错误 | 异常信息 |
| `token.refreshed` | 访问令牌已刷新 | `{"aid": "..."}` |
| `token.refresh_exhausted` | Token 刷新重试耗尽 | `{"aid": "...", "consecutive_failures": N}` |
| `notification` | 未分类推送通知 | 原始消息体 |

---

## RPC 方法参考

所有业务操作通过 `client.call(method, params)` 调用，参数和返回值详见 RPC 手册：

| 领域 | 手册 | 涵盖方法 |
|------|------|----------|
| 消息 | [message/04-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/message/04-RPC-Manual.md) | message.send / pull / ack / recall |
| 群组 | [group/04-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/group/04-RPC-Manual.md) | 群组生命周期、成员管理、群消息 |
| 存储 | [storage/04-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/storage/04-RPC-Manual.md) | 文件上传下载、对象存储 |
| 流 | [stream/04-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/stream/04-RPC-Manual.md) | stream.create / close / get_info / list_active |
| 元信息 | [meta/01-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/meta/01-RPC-Manual.md) | meta.ping / status / trust_roots |

可运行示例见 [examples/](../src/aun_core/docs/skill/examples/)。

---

## Stream 使用指南

Stream 服务用于实时流式数据传输（LLM 输出、数据推送等）。控制面通过 `client.call()` 管理，数据面通过原生 WebSocket / HTTP SSE 传输。

> 详细协议规范见 [12-Stream-子协议](../src/aun_core/docs/protocol/12-Stream-子协议.md)

### 创建流

```python
result = await client.call("stream.create", {
    "content_type": "text/plain",   # 可选，默认 text/plain
    "metadata": {"model": "gpt-4"}, # 可选，自定义元数据
    "target_aid": "bob.aid.net",    # 可选，仅在拉流方显式提供 aid 时做匹配校验
})
stream_id = result["stream_id"]
push_url  = result["push_url"]   # WebSocket 推流地址
pull_url  = result["pull_url"]   # HTTP SSE 拉流地址
push_token = result["push_token"]   # 推流凭证
pull_token = result["pull_token"]   # 拉流凭证
push_headers = result["push_headers"] # 推荐使用 Authorization header
pull_headers = result["pull_headers"] # 推荐使用 Authorization header
```

> 当前实现仍保留 URL query token 以兼容旧客户端；新客户端优先使用 `push_headers` / `pull_headers`。

### 推流（WebSocket）

```python
import websockets, json

async with websockets.connect(
    push_url,
    ssl=ssl_ctx,
    additional_headers=push_headers,
) as ws:
    await ws.send(json.dumps({"cmd": "data", "data": "Hello ", "seq": 1}))
    await ws.send(json.dumps({"cmd": "data", "data": "World", "seq": 2}))
    await ws.send(json.dumps({"cmd": "close"}))
```

### 拉流（HTTP SSE）

```python
import aiohttp

async with aiohttp.ClientSession() as session:
    async with session.get(pull_url, headers=pull_headers) as resp:
        async for line in resp.content:
            # SSE 格式：id: {seq}\ndata: {内容}\n\n
            pass

> 推流连接若失败，当前实现常见返回为 HTTP `403` / `404` / `410`，应优先检查升级前的 HTTP 状态码。
```

### 关闭流

```python
await client.call("stream.close", {"stream_id": stream_id})
```

### 查询流状态

```python
info = await client.call("stream.get_info", {"stream_id": stream_id})
streams = await client.call("stream.list_active", {})
