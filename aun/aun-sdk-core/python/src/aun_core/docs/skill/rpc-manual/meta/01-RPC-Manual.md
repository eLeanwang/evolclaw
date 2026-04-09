# 元信息 — RPC Manual

## 方法索引

| 方法 | 说明 |
|------|------|
| [meta.ping](#metaping) | 心跳检测 |
| [meta.status](#metastatus) | 查询连接状态 |
| [meta.trust_roots](#metatrust_roots) | 获取信任根证书 |

---

## meta.ping

心跳检测。SDK Core 自动调用以保持连接活性，也可手动调用验证连接是否正常。

### 参数

无。

> **注意**：`timestamp` 参数**不会被回显**，服务端始终返回自身当前时间戳。

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `pong` | boolean | 固定为 `true` |
| `timestamp` | integer | 服务端当前 Unix 时间戳（秒） |

### 示例

```python
result = await client.call("meta.ping", {})
print(result)  # {"pong": true, "timestamp": ...}
```

---

## meta.status

查询当前连接的状态信息。返回结构与连接模式相关。

### 参数

无。

### 响应

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | string | 当前连接模式：`"gateway"` / `"peer"` / `"relay"` |
| `identity` | object | 本端身份信息 |
| `identity.aid` | string | 当前连接的 AID |
| `identity.status` | string | 身份状态：`"online"` / `"authenticated"` / `"connecting"` |
| `transport` | object | 底层传输信息 |
| `transport.state` | string | 连接状态：`"connected"` / `"degraded"` / `"reconnecting"` |
| `transport.remote` | string | 当前连接的远端端点 |
| `authenticated` | boolean | 当前连接是否已完成认证 |
| `connections` | object | 模式相关连接详情 |
| `uptime` | integer | 当前连接持续时间（秒） |

> **当前实现**：Gateway 返回简化子集 `{ mode, aid, role, connected_at, protocol_version }`。协议完整结构将在后续版本实现。客户端应容忍未知字段和缺失字段。

### 示例

```python
status = await client.call("meta.status", {})
print(f"模式: {status['mode']}")
```

---

## meta.trust_roots

获取当前服务端信任的根证书列表。Gateway 内部转发给 `ca.get_trust_roots`。

### 参数

无参数。

### 响应

```json
{
    "roots": [
        {
            "cert_pem": "-----BEGIN CERTIFICATE-----\n...",
            "agentid": "root.agentid.pub",
            "cert_sn": "1234567890"
        }
    ],
    "count": 1
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `roots` | array | 根证书列表 |
| `roots[].cert_pem` | string | PEM 格式证书 |
| `roots[].agentid` | string | 根 CA 的 AID |
| `roots[].cert_sn` | string | 证书序列号 |
| `count` | integer | 根证书数量 |

### 示例

```python
result = await client.call("meta.trust_roots", {})
for root in result["roots"]:
    print(f"根证书: {root['agentid']} sn={root['cert_sn']}")
```
