# 错误码参考

## JSON-RPC 2.0 标准错误码

| 错误码 | 名称 | 说明 |
|--------|------|------|
| `-32700` | Parse Error | 解析错误，服务端收到无效 JSON |
| `-32600` | Invalid Request | 无效请求，JSON 不符合 JSON-RPC 2.0 规范 |
| `-32601` | Method Not Found | 方法不存在，请求的 RPC 方法未注册 |
| `-32602` | Invalid Params | 无效参数，方法参数类型或结构不符合要求 |
| `-32603` | Internal Error | 内部错误，服务端处理过程中发生未预期异常 |

## SDK 异常映射

`aun-sdk-core` 不会只抛一个统一的 `AUNError`。它会按错误码将远端错误映射为更具体的异常类型：

| 错误码范围 / 值 | SDK 异常类型 |
|----------------|-------------|
| `4001`, `4010` | `AuthError` |
| `4030`, `403`, `-32003` | `PermissionError` |
| `4040`, `404`, `-32004` | `NotFoundError` |
| `4290`, `429`, `-32029` | `RateLimitError` |
| `-32600`, `-32601`, `-32602`, `4000` | `ValidationError` |
| 其他错误码 | `AUNError` |

此外，SDK 还定义了以下本地异常类型（不由远端错误码映射，而是 SDK 内部逻辑触发）：

| 异常类型 | 触发场景 |
|---------|---------|
| `ConnectionError` | WebSocket 连接失败、传输层断开 |
| `TimeoutError` | RPC 调用超时（`retryable=True`） |
| `StateError` | 状态不正确，如未连接时调用 `call()`、缺少本地身份等 |
| `SerializationError` | 收到无效 JSON 或不可解析的 WebSocket 消息 |

`RateLimitError` 和 `5xxx` 错误会带 `retryable=True`。

## 错误处理

SDK 的所有 RPC 异常都继承自 `AUNError`，可统一捕获，也可按具体类型分类处理：

```python
from aun_core import (
    AUNClient,
    AUNError,
    AuthError,
    ConnectionError,
    NotFoundError,
    PermissionError,
    RateLimitError,
    StateError,
    TimeoutError,
    ValidationError,
)

client = AUNClient({"aun_path": "./aun_data"})

try:
    result = await client.call("message.send", {
        "to": "peer-agent.agentid.pub",
        "payload": {"text": "你好"},
    })
except AuthError:
    print("认证失败，请重新登录")
except PermissionError:
    print("权限被拒绝，无法执行此操作")
except NotFoundError:
    print("目标不存在")
except RateLimitError as e:
    print(f"限流: retryable={e.retryable}")
except ValidationError as e:
    print(f"参数错误: {e}")
except AUNError as e:
    print(f"错误码: {e.code}")       # 如 -32004
    print(f"错误信息: {e}")          # AUNError 没有 e.message 属性，直接 str(e)
    print(f"错误数据: {e.data}")      # 附加信息（可选）
    print(f"可重试: {e.retryable}")
    print(f"追踪 ID: {e.trace_id}")
```

## AUNError 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `code` | `int` | 错误码，对应上述表格中的数值 |
| `data` | `dict \| None` | 附加错误数据，部分错误会携带额外上下文 |
| `retryable` | `bool` | 是否建议调用方稍后重试 |
| `trace_id` | `str \| None` | 服务端返回的追踪 ID（若存在） |

错误文本本身通过 `str(e)` 获取，而不是 `e.message`。
