# 附录 I：跨域消息路由实现指南（非规范性）

> **本文档为非规范性内容**：提供跨域消息路由的架构设计、实现建议、性能优化和部署指南，不是协议强制要求。

## I.1 架构概述

AUN 是一个**开放网络**，不同 Issuer 运营的 Gateway 之间可以互相通信，实现跨 Issuer 的消息传递。

**核心特性**：
- **去中心化**：没有中央服务器，每个 Issuer 独立运营
- **互联互通**：不同 Issuer 的用户可以互相通信
- **端到端加密**：消息在客户端加密，Gateway 无法解密
- **证书验证**：通过 X.509 证书链验证对方身份

**类比**：
- 类似电子邮件（alice@gmail.com 可以发送给 bob@outlook.com）
- 类似 XMPP/Jabber（去中心化即时通讯协议）
- 类似 Matrix（去中心化通信协议）

### I.1.1 架构设计

AUN 的跨域路由采用 **Message 服务直连对端 Gateway** 的架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                         Issuer A (aid.pub)                      │
│                                                                 │
│  Alice ──→ Gateway A ──→ Message Service A                     │
│                              │                                  │
│                              │ 1. 发现 gateway.example.com     │
│                              │    via well-known               │
│                              │                                  │
│                              │ 2. 建立 WebSocket 连接          │
└──────────────────────────────┼─────────────────────────────────┘
                               │
                               │ WebSocket + JSON-RPC 2.0
                               │ (message.send)
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Issuer B (example.com)                     │
│                                                                 │
│                          Gateway B ──→ Message Service B ──→ Bob│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**职责分工**：

| 组件 | 职责 |
|------|------|
| **Message Service** | 路由决策：判断目标 AID 是本域还是跨域<br>网关发现：通过 well-known 查询对端 Gateway 地址<br>连接管理：建立、维护、复用到对端 Gateway 的连接<br>消息转发：将消息发送到对端 Gateway |
| **Gateway** | 本地连接管理：维护客户端 WebSocket 连接<br>消息接收：接收来自其他 Issuer 的 Message Service 的连接<br>本地路由：将跨域消息路由到本地客户端 |

**关键设计决策**：

1. **Message 服务直连 Gateway**（而非 Gateway 间互连）
   - Message 服务负责路由逻辑，Gateway 专注连接管理
   - Message 服务可以灵活控制跨域策略（重试、超时、限流）

2. **使用 WebSocket + JSON-RPC 2.0**（而非 HTTP POST）
   - 与客户端协议一致，简化实现
   - 支持双向通信（未来可扩展）

3. **按需连接**（而非全连接）
   - Message 服务不预先建立所有跨域连接
   - 首次跨域消息时建立连接，后续复用
   - 空闲超时后关闭连接

## I.2 路由场景

### I.2.1 场景 1：本域路由

发送者和接收者属于同一 Issuer，Message 服务直接在本地路由。

```
Alice (alice.aid.pub)
  │
  │ 1. message.send(to: "bob.aid.pub")
  ↓
Gateway A
  │
  │ 2. 转发到 Message Service A
  ↓
Message Service A
  │
  │ 3. 判断：bob.aid.pub 是本域
  │ 4. 查询 Bob 的连接（可能在本 Gateway 或其他 Gateway）
  │ 5. 路由到 Bob 的 Gateway
  ↓
Bob (bob.aid.pub)
  │
  │ 6. event/message.received
```

**特点**：
- 最快，无需跨域查询
- Message 服务内部路由
- 延迟最低（< 50ms）

### I.2.2 场景 2：跨域路由

发送者和接收者属于不同 Issuer，Message 服务需要连接对端 Gateway。

```
Alice (alice.aid.pub)
  │
  │ 1. message.send(to: "bob.example.com")
  ↓
Gateway A (aid.pub)
  │
  │ 2. 转发到 Message Service A
  ↓
Message Service A
  │
  │ 3. 判断：bob.example.com 是跨域
  │ 4. 查询 well-known: https://bob.example.com/.well-known/aun-gateway
  │    → 返回 wss://gateway.example.com/aun
  │
  │ 5. 建立到 gateway.example.com 的 WebSocket 连接（或复用已有连接）
  │ 6. 发送 message.send(to: "bob.example.com", ...)
  │
  ├──────────────────────────────────────────────────────────────┐
  │                    WebSocket + JSON-RPC 2.0                  │
  └──────────────────────────────────────────────────────────────┘
                               ↓
                          Gateway B (example.com)
                               │
                               │ 7. 转发到 Message Service B
                               ↓
                          Message Service B
                               │
                               │ 8. 本地路由到 Bob
                               ↓
                          Bob (bob.example.com)
                               │
                               │ 9. event/message.received
```

**特点**：
- 需要网关发现（well-known 查询）
- 需要建立跨域连接
- 延迟较高（100-500ms，取决于网络）

## I.3 网关发现机制

Message 服务通过 **well-known** 机制发现目标 AID 的 Gateway 地址。

### I.3.1 发现流程

```python
async def discover_gateway(aid: str) -> str:
    """发现 AID 的 Gateway 地址"""
    # 1. 检查缓存
    cached = await cache.get(f"gateway:{aid}")
    if cached:
        return cached
    
    # 2. 查询 well-known
    url = f"https://{aid}/.well-known/aun-gateway"
    response = await http_client.get(url, timeout=5.0)
    gateway_info = response.json()
    
    # 3. 提取 WebSocket 地址
    gateway_url = gateway_info["gateway"]  # e.g., "wss://gateway.example.com/aun"
    
    # 4. 缓存结果（TTL: 1小时）
    await cache.set(f"gateway:{aid}", gateway_url, ttl=3600)
    
    return gateway_url
```

### I.3.2 Well-Known 响应格式

```json
{
  "gateway": "wss://gateway.example.com/aun",
  "issuer": "example.com",
  "version": "1.0"
}
```

### I.3.3 缓存策略

**本地缓存（单实例）**：
```python
# 使用 TTL 缓存
cache = TTLCache(maxsize=10000, ttl=3600)  # 1小时过期
```

**分布式缓存（多实例）**：
```python
# 使用 Redis
await redis.setex(f"gateway:{aid}", 3600, gateway_url)
```

**缓存更新**：
- 订阅 `client.online` 事件：客户端上线时更新缓存
- 订阅 `client.offline` 事件：客户端离线时可选择保留缓存（下次上线可能还在同一 Gateway）
- 连接失败时：清除缓存，强制重新发现

### I.3.4 错误处理

| 错误 | 处理策略 |
|------|---------|
| well-known 查询超时 | 重试 3 次，间隔 1s/2s/5s |
| well-known 返回 404 | 该 Issuer 不支持 AUN 协议，返回错误 |
| Gateway 地址无效 | 记录日志，返回错误 |
| 缓存失效 | 重新查询 well-known |

## I.4 连接管理

Message 服务需要管理到多个对端 Gateway 的 WebSocket 连接。

### I.4.1 连接池设计

**按需建立连接**：
```python
class CrossDomainConnectionPool:
    def __init__(self):
        self.connections = {}  # {gateway_url: WebSocketConnection}
        self.locks = {}        # {gateway_url: asyncio.Lock}
    
    async def get_connection(self, gateway_url: str) -> WebSocketConnection:
        """获取到指定 Gateway 的连接（复用或新建）"""
        # 1. 检查是否已有连接
        if gateway_url in self.connections:
            conn = self.connections[gateway_url]
            if conn.is_alive():
                return conn
            else:
                # 连接已断开，清理
                del self.connections[gateway_url]
        
        # 2. 获取锁，避免并发建立多个连接
        if gateway_url not in self.locks:
            self.locks[gateway_url] = asyncio.Lock()
        
        async with self.locks[gateway_url]:
            # 再次检查（可能其他协程已建立）
            if gateway_url in self.connections:
                return self.connections[gateway_url]
            
            # 3. 建立新连接
            conn = await self._create_connection(gateway_url)
            self.connections[gateway_url] = conn
            return conn
    
    async def _create_connection(self, gateway_url: str) -> WebSocketConnection:
        """建立到 Gateway 的 WebSocket 连接"""
        ws = await websockets.connect(
            gateway_url,
            ssl=ssl_context,  # TLS 证书验证
            ping_interval=30,
            ping_timeout=10,
            close_timeout=5,
        )
        return WebSocketConnection(ws, gateway_url)
```

### I.4.2 连接生命周期

**连接状态**：
- `CONNECTING`：正在建立连接
- `CONNECTED`：连接已建立，可以发送消息
- `IDLE`：连接空闲（无消息发送）
- `CLOSED`：连接已关闭

**空闲超时**：
```python
# 连接空闲 5 分钟后自动关闭
IDLE_TIMEOUT = 300  # 秒

async def monitor_idle_connections():
    while True:
        await asyncio.sleep(60)  # 每分钟检查一次
        now = time.time()
        for gateway_url, conn in list(pool.connections.items()):
            if now - conn.last_activity > IDLE_TIMEOUT:
                await conn.close()
                del pool.connections[gateway_url]
```

### I.4.3 重连策略

**连接断开时**：
- 不立即重连（按需重连）
- 下次发送消息时自动重新建立连接
- 记录断开原因和时间，用于监控

**连接失败时**：
- 重试 3 次，间隔 1s/2s/5s
- 3 次失败后放弃，返回错误
- 清除该 Gateway 的缓存，下次重新发现

## I.5 消息路由实现

### I.5.1 路由决策

```python
async def route_message(from_aid: str, to_aid: str, payload: dict) -> dict:
    """路由消息到目标 AID"""
    # 1. 提取目标 Issuer
    target_issuer = extract_issuer(to_aid)  # e.g., "example.com"
    local_issuer = extract_issuer(from_aid)  # e.g., "aid.pub"
    
    # 2. 判断是否跨域
    if target_issuer == local_issuer:
        # 本域路由
        return await route_local(to_aid, payload)
    else:
        # 跨域路由
        return await route_cross_domain(to_aid, payload)

async def route_cross_domain(to_aid: str, payload: dict) -> dict:
    """跨域路由"""
    # 1. 发现目标 Gateway
    gateway_url = await discover_gateway(to_aid)
    
    # 2. 获取连接
    conn = await connection_pool.get_connection(gateway_url)
    
    # 3. 发送消息
    result = await conn.call("message.send", {
        "to": to_aid,
        "type": payload["type"],
        "payload": payload["payload"],
    })
    
    return result
```

### I.5.2 消息格式

跨域消息使用标准的 `message.send` 方法，格式与本域消息一致：

```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "message.send",
  "params": {
    "to": "bob.example.com",
    "type": "text",
    "payload": {
      "text": "Hello from alice.aid.pub"
    }
  }
}
```

### I.5.3 错误处理

| 错误场景 | 错误码 | 处理策略 |
|---------|--------|---------|
| 目标 AID 不存在 | `USER_NOT_FOUND` | 返回错误给发送者 |
| 目标 Gateway 不可达 | `GATEWAY_UNREACHABLE` | 重试 3 次，失败后返回错误 |
| 连接超时 | `TIMEOUT` | 重试，清除缓存 |
| 目标用户离线 | `USER_OFFLINE` | 根据策略：存储离线消息或返回错误 |

## I.6 安全考虑

### I.6.1 TLS 证书验证

Message 服务连接对端 Gateway 时必须验证 TLS 证书：

```python
import ssl

ssl_context = ssl.create_default_context()
ssl_context.check_hostname = True
ssl_context.verify_mode = ssl.CERT_REQUIRED

# 连接时使用
ws = await websockets.connect(gateway_url, ssl=ssl_context)
```

### I.6.2 防止滥用

**限流策略**：
- 每个 Issuer 的跨域消息限流（例如：1000 msg/s）
- 单个 AID 的跨域消息限流（例如：10 msg/s）
- 使用令牌桶或漏桶算法

**黑名单机制**：
```python
# 恶意 Issuer 黑名单
BLACKLIST = {"spam.example.com", "malicious.net"}

async def route_cross_domain(to_aid: str, payload: dict):
    target_issuer = extract_issuer(to_aid)
    if target_issuer in BLACKLIST:
        raise PermissionError(f"Issuer {target_issuer} is blacklisted")
    # ...
```

### I.6.3 消息验证

虽然 Message 服务不解密消息内容（E2EE），但应验证消息格式：
- 检查必填字段（to、type、payload）
- 验证 AID 格式
- 限制消息大小（例如：1MB）

## I.7 性能优化

### I.7.1 连接复用

- 同一 Gateway 的多条消息复用同一 WebSocket 连接
- 避免频繁建立/关闭连接的开销
- 使用连接池管理

### I.7.2 并发控制

```python
# 限制并发连接数
MAX_CONCURRENT_CONNECTIONS = 100
semaphore = asyncio.Semaphore(MAX_CONCURRENT_CONNECTIONS)

async def send_cross_domain_message(to_aid, payload):
    async with semaphore:
        return await route_cross_domain(to_aid, payload)
```

### I.7.3 批量发送

对于同一目标 Gateway 的多条消息，可以批量发送：

```python
async def send_batch(gateway_url: str, messages: list):
    conn = await connection_pool.get_connection(gateway_url)
    # 使用 JSON-RPC 批量请求
    batch_request = [
        {"jsonrpc": "2.0", "id": i, "method": "message.send", "params": msg}
        for i, msg in enumerate(messages)
    ]
    return await conn.send_batch(batch_request)
```

## I.8 监控与运维

### I.8.1 关键指标

| 指标 | 说明 | 告警阈值 |
|------|------|---------|
| `cross_domain_message_total` | 跨域消息总数 | - |
| `cross_domain_message_success_rate` | 成功率 | < 95% |
| `cross_domain_message_latency_p99` | P99 延迟 | > 1000ms |
| `gateway_connection_count` | 活跃连接数 | > 500 |
| `gateway_discovery_failures` | 发现失败次数 | > 10/min |
| `connection_failures` | 连接失败次数 | > 5/min |

### I.8.2 日志记录

```python
logger.info("cross_domain_route", extra={
    "from": from_aid,
    "to": to_aid,
    "target_gateway": gateway_url,
    "latency_ms": latency,
    "success": True,
})
```

### I.8.3 故障排查

**常见问题**：

1. **well-known 查询失败**
   - 检查目标域名 DNS 解析
   - 检查 HTTPS 证书
   - 检查防火墙规则

2. **连接超时**
   - 检查网络连通性
   - 检查目标 Gateway 是否在线
   - 检查 TLS 握手

3. **消息发送失败**
   - 检查目标 AID 是否存在
   - 检查目标用户是否在线
   - 检查消息格式

---

**总结**：

本实现指南描述了基于 Message 服务直连对端 Gateway 的跨域路由架构。核心要点：

1. Message 服务通过 well-known 发现对端 Gateway
2. 按需建立 WebSocket 连接，复用连接池
3. 使用标准 message.send 方法，格式与本域一致
4. 注意 TLS 验证、限流、监控

