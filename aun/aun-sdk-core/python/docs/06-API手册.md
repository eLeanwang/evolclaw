# AUN SDK Python - API 手册

---

## 目录

### [AUNClient](#aunclient)
- [构造函数](#构造函数)
- [属性](#属性)
- [connect()](#await-connectauth-dict-options-dict--none---none) - 建立连接
- [call()](#await-callmethod-str-params-dict--none---any) - 调用 RPC 方法
- [on()](#onevent-str-handler-callable---subscription) - 订阅事件
- [close()](#await-close---none) - 关闭连接

### [AUNClient.Auth](#authnamespace-clientauth)
- [create_aid()](#await-create_aidparams-dict---dict) - 注册新 AID
- [authenticate()](#await-authenticateparams-dict--none---dict) - 认证获取令牌
- [renew_cert()](#await-renew_certparams-dict--none---dict) - 续期证书
- [rekey()](#await-rekeyparams-dict--none---dict) - 密钥轮换
- [request_cert()](#await-request_certparams-dict---dict) - 通用证书请求
- [download_cert()](#await-download_certparams-dict--none---any) - 下载证书
- [trust_roots()](#await-trust_rootsparams-dict--none---any) - 查询信任根

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

---

## AUNClient

主客户端类，所有操作的入口。

### 构造函数

**`AUNClient(config: dict | None)`**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `aun_path` | `str` | 否 | `~/.aun/{cwd}` | 应用级数据目录（AID 数据在 `{aun_path}/AIDs/{aid}/` 下） |
| `root_ca_path` | `str` | 否 | `None` | 额外 Root CA 路径 |
| `encryption_seed` | `str` | 否 | `None` | 本地加密种子 |
| `discovery_port` | `int` | 否 | `None` | 自定义 Gateway 发现端口 |
| `group_e2ee` | `bool` | 否 | `true` | 群组 E2EE 为必选能力；当前 Python SDK 固定启用，用户传入值被忽略 |
| `rotate_on_join` | `bool` | 否 | `false` | 新成员加入时是否轮换 epoch |
| `epoch_auto_rotate_interval` | `int` | 否 | `0` | 定时 epoch 轮换间隔（秒），0=禁用 |
| `old_epoch_retention_seconds` | `int` | 否 | `604800` | 旧 epoch 密钥保留时间（默认 7 天） |
| `keystore` | `KeyStore` | 否 | `FileKeyStore` | 自定义密钥存储实现 |
| `secret_store` | `SecretStore` | 否 | 平台默认 | 自定义敏感数据存储（DPAPI/Keychain/libsecret） |
| `connection_factory` | `callable` | 否 | 内置 WSS | 自定义 WebSocket 连接工厂 |
| `crypto` | `CryptoProvider` | 否 | 内置 | 自定义密码学实现 |
| `server_replay_guard` | `bool` | 否 | `false` | 启用服务端防重放（跨进程持久化） |
| `prekey_refresh_interval` | `float` | 否 | `3600` | Prekey 自动轮换间隔（秒） |

```python
client = AUNClient({
    "aun_path": "~/.aun/myapp",
    "rotate_on_join": False,
})
```

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `aid` | `str \| None` | 当前连接的 AID |
| `state` | `str` | 连接状态 (`idle` / `connecting` / `connected` / `disconnected` / `closed`) |
| `auth` | `AuthNamespace` | 认证命名空间 |
| `e2ee` | `E2EEManager` | P2P E2EE 工具类 |
| `group_e2ee` | `GroupE2EEManager` | 群组 E2EE 工具类（当前 Python SDK 固定可用） |

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
| `auto_reconnect` | `bool` | `False` | 断线自动重连 |
| `heartbeat_interval` | `float` | `30.0` | 心跳间隔（秒） |
| `token_refresh_before` | `float` | `60.0` | 令牌过期前多久刷新（秒） |
| `retry.max_attempts` | `int` | `3` | 重连最大次数 |
| `retry.initial_delay` | `float` | `0.5` | 首次重连延迟（秒） |
| `retry.max_delay` | `float` | `5.0` | 最大重连延迟（秒） |
| `timeouts.connect` | `float` | `5.0` | 连接超时（秒） |
| `timeouts.call` | `float` | `10.0` | RPC 调用超时（秒） |
| `timeouts.http` | `float` | `30.0` | HTTP 请求超时（秒） |

```python
auth = await client.auth.authenticate({"aid": MY_AID})
await client.connect(auth, {
    "auto_reconnect": False,
    "heartbeat_interval": 30.0,
})
```

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
- 发送明文消息需显式传 `encrypt=False`
- `message.pull` / `group.pull` 返回的消息已自动解密，加密消息带有 `encrypted=True` 标记

```python
# 发送加密消息（默认行为，无需传 encrypt）
await client.call("message.send", {
    "to": "bob.agentid.pub",
    "payload": {"text": "秘密消息"},
    "persist": True,
})

# 接收并自动解密
result = await client.call("message.pull", {"after_seq": 0, "limit": 50})
for msg in result["messages"]:
    print(msg["payload"])   # 加密消息已自动解密

# 发送明文消息（需显式关闭加密）
await client.call("message.send", {
    "to": "bob.agentid.pub",
    "payload": {"text": "Hello"},
    "encrypt": False,
})
```

**`message.send` 额外参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `encrypt` | `bool` | 否 | 是否加密消息（默认 `true`） |
| `message_id` | `str` | 否 | 消息 ID（不传则自动生成） |
| `timestamp` | `int` | 否 | 时间戳毫秒（不传则自动生成） |
| `persist` | `bool` | 否 | 是否持久化（默认 `true`） |

---

### `on(event: str, handler: Callable) -> Subscription`

订阅事件，支持同步和异步 handler。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | `str` | 是 | 事件名 |
| `handler` | `Callable` | 是 | 事件处理函数 |

**返回值**: `Subscription` 对象（可调用 `.unsubscribe()` 取消订阅）

```python
sub = client.on("message.received", lambda e: print(e))
sub.unsubscribe()
```

---

### `await close() -> None`

关闭连接，停止心跳、令牌刷新、重连等所有后台任务。

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

### `await renew_cert(params: dict | None) -> dict`

续期当前 AID 的证书（保持相同密钥，只延长有效期）。

**使用场景**: 证书即将过期时的日常续期操作

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `aid` | `str` | 是 | AID |
| `public_key` | `str` | 是 | 公钥（Base64 编码的 SPKI 格式） |
| `curve` | `str` | 否 | 曲线类型，默认 `P-256`（可选 `P-384` / `Ed25519`） |

**返回值**

| 字段 | 类型 | 说明 |
|------|------|------|
| `cert` | `str` | 新证书（PEM 格式） |
| `serial_number` | `str` | 证书序列号（十六进制） |
| `valid_notbefore` | `int` | 生效时间戳（秒） |
| `valid_notafter` | `int` | 过期时间戳（秒） |

**注意**: 旧证书会被降级为 `verify_only` 状态，不再用于签名但仍可验证历史签名

---

### `await rekey(params: dict | None) -> dict`

重新生成密钥对并签发新证书（用于密钥泄露后的安全恢复）。

**使用场景**: 密钥泄露、安全事件响应、主动密钥轮换

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `aid` | `str` | 是 | AID |
| `new_public_key` | `str` | 是 | 新公钥（Base64 编码的 SPKI 格式） |
| `curve` | `str` | 否 | 曲线类型，默认 `P-256` |
| `old_serial` | `str` | 否 | 旧证书序列号（可选） |

**返回值**

| 字段 | 类型 | 说明 |
|------|------|------|
| `cert` | `str` | 新证书（PEM 格式） |
| `serial_number` | `str` | 证书序列号（十六进制） |
| `valid_notbefore` | `int` | 生效时间戳（秒） |
| `valid_notafter` | `int` | 过期时间戳（秒） |

**注意**: 旧证书会被降级为 `verify_only` 后立即吊销，不再可用

---

### `await request_cert(params: dict) -> dict`

通用的证书请求接口（支持自定义参数）。

**使用场景**: 高级场景，需要指定特殊参数（如不同用途、自定义扩展等）

**参数**: 根据具体需求传递，详见后端 RPC 手册

**返回值**: 签发的证书信息

---

### `await trust_roots(params: dict | None) -> Any`

查询网关信任的 Root CA 列表（需已连接）。

**参数**: 无

**返回值**: Root CA 证书列表

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
| `message.ack` | 消息已读确认 | `{"ack_seq": N}` |
| `group.changed` | 群组状态变更 | 变更详情 |
| `connection.state` | 连接状态变化 | `{"state": "..."}` |
| `connection.challenge` | 收到认证挑战 | 挑战参数 |
| `connection.error` | 连接发生错误 | 异常信息 |
| `token.refreshed` | 访问令牌已刷新 | `{"aid": "..."}` |
| `notification` | 未分类推送通知 | 原始消息体 |

---

## RPC 方法参考

所有业务操作通过 `client.call(method, params)` 调用，参数和返回值详见 RPC 手册：

| 领域 | 手册 | 涵盖方法 |
|------|------|----------|
| 消息 | [message/04-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/message/04-RPC-Manual.md) | message.send / pull / ack / recall |
| 群组 | [group/04-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/group/04-RPC-Manual.md) | 群组生命周期、成员管理、群消息 |
| 存储 | [storage/04-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/storage/04-RPC-Manual.md) | 文件上传下载、对象存储 |
| 元信息 | [meta/01-RPC-Manual.md](../src/aun_core/docs/skill/rpc-manual/meta/01-RPC-Manual.md) | meta.ping / status / trust_roots |

可运行示例见 [examples/](../src/aun_core/docs/skill/examples/)。