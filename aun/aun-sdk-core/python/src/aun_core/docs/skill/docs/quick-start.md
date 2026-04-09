# 快速开始

## 安装

SDK Core 尚未发布到 PyPI，当前使用本地开发安装：

```bash
pip install aun-core
```

依赖项：

- `websockets >= 15.0`
- `cryptography >= 43.0`
- `aiohttp >= 3.10`

## 最小示例

```python
import asyncio, random
from aun_core import AUNClient

async def main():
    # 创建客户端
    client = AUNClient({
        "aun_path": "./aun_data",  # AUN 工作目录
    })

    # 创建 AID（首次使用时）
    MY_AID = f"my-agent-{random.randint(1000,9999)}.agentid.pub"
    await client.auth.create_aid({"aid": MY_AID})

    # 认证
    auth = await client.auth.authenticate({"aid": MY_AID})

    # 连接到网关
    await client.connect({
        "access_token": auth["access_token"],
        "gateway": auth["gateway"],
        "auto_reconnect": True,
    })

    # 调用 RPC 方法
    result = await client.call("meta.ping", {})
    print(result)  # {"pong": true}

    # 关闭连接
    await client.close()

asyncio.run(main())
```

## 构造参数

`AUNClient(config)` 接受以下可选配置：

| 参数 | 类型 | 说明 |
|------|------|------|
| `aun_path` | `str` | AUN 工作目录，用于存储密钥、证书等本地数据 |
| `root_ca_path` | `str` | 可选的额外 Root CA 证书 bundle 路径。SDK 默认内置根证书，并在 `auth.aid_login1` 时用本地信任根校验服务端 `auth_cert` 链；缺失的中间 CA 证书会通过 Gateway `/pki/chain` 下载补全，并通过签名 CRL/OCSP 检查服务端证书状态 |
| `encryption_seed` | `str` | 本地存储加密种子，保护密钥文件的对称加密密钥派生源 |

## 核心 API

| API | 说明 |
|-----|------|
| `client.call(method, params)` | 调用任意 RPC 方法，返回结果或抛出异常。`message.send` / `group.send` 默认加密发送，`message.pull` / `group.pull` 自动解密 |
| `client.on(event, handler)` | 订阅事件，`handler` 为异步回调函数 |
| `client.auth` | 认证命名空间，提供 `create_aid()`、`authenticate()` 等方法 |
| `client.e2ee` | E2EE 管理器（高级 API，裸 WebSocket 开发者使用）。`E2EEManager` 可独立于 `AUNClient` 实例化。普通开发者无需额外操作，SDK 默认加密 |
| `client.state` | 当前连接状态（`idle`、`connected`、`disconnected` 等） |
| `client.aid` | 当前已认证的 AID 标识 |
| `client.close()` | 关闭连接并释放资源 |

## 实例属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `client.config` | `dict` | 构造时传入的原始配置字典（如 `client.config["aun_path"]`） |
| `client.auth` | `AuthNamespace` | 认证命名空间（`create_aid`、`authenticate`、`renew_cert`、`rekey`） |
| `client.e2ee` | `E2EEManager` | 端到端加密管理器（高级 API，可独立于 AUNClient 实例化）。普通开发者无需额外操作，SDK 默认加密发送 |
| `client.state` | `str` | 连接状态：`"idle"` / `"connected"` / `"disconnected"` |
| `client.aid` | `str \| None` | 当前已认证的 AID 标识 |

> **注意**：访问配置使用 `client.config`（公开属性），而非 `client._config`（不存在）或 `client._config_model`（内部实现）。
