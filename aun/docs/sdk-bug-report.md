# AUN SDK Bug Report: E2EE 接收端解密失败

> 提交时间: 2026-04-04
> SDK 版本: aun-core 0.1.5 (PyPI)
> 严重程度: **High** — E2EE 消息接收端无法解密，仅影响首次通信

---

## 问题描述

当客户端 A 向客户端 B 发送 E2EE 加密消息后，B 的回复经 E2EE 加密返回给 A 时，A 无法解密该回复。错误信息为：

```
发送方签名验证失败: sender cert not found for <sender_aid>
```

## 根因分析

`_fetch_peer_cert` 和 `_ensure_sender_cert_cached` 之间存在缓存层级不一致：

### 发送路径（正常）

```
client.call("message.send", encrypt=True)
  → _send_encrypted()
    → _fetch_peer_cert(peer_aid)          # 下载证书
      → 写入 self._cert_cache（内存）      ✅
      → 未写入 keystore（磁盘）           ❌  ← 问题根源
    → _e2ee.encrypt_outbound()            # 加密成功
```

### 接收路径（失败）

```
_process_and_publish_message()
  → _decrypt_single_message()
    → _ensure_sender_cert_cached(sender_aid)
      → self._cert_cache.get(aid)          # 命中内存缓存！
      → if cached and not expired:
          return True                      # 直接返回，跳过 save_cert
                                           ❌ ← keystore 始终为空
    → _e2ee.decrypt_message()
      → _verify_sender_signature()
        → _get_sender_cert(aid)
          → keystore.load_cert(aid)        # 从 keystore 读 → 空！
          → return None                    ❌
        → raise "sender cert not found"    💥
```

### 关键代码位置

**`client.py` 第 643-673 行** — `_fetch_peer_cert`：
```python
async def _fetch_peer_cert(self, aid: str) -> bytes:
    # ...下载证书...
    self._cert_cache[aid] = _CachedPeerCert(...)  # 只写内存缓存
    return cert_bytes
    # ❌ 没有调用 self._keystore.save_cert()
```

**`client.py` 第 788-810 行** — `_ensure_sender_cert_cached`：
```python
async def _ensure_sender_cert_cached(self, aid: str) -> bool:
    cached = self._cert_cache.get(aid)
    if cached and time.time() < cached.refresh_after:
        return True  # ❌ 命中内存缓存，跳过 save_cert，keystore 为空
    try:
        cert_bytes = await self._fetch_peer_cert(aid)
        self._keystore.save_cert(aid, cert_pem)  # ← 这行永远执行不到
        return True
```

**`e2ee.py` 第 485-493 行** — `_get_sender_cert`：
```python
def _get_sender_cert(self, aid: str) -> bytes | None:
    keystore = self._keystore()
    cert_pem = keystore.load_cert(aid)  # 只从 keystore 读，不查内存缓存
    return cert_pem  # → None
```

### 问题本质

两层缓存（内存 `_cert_cache` vs 磁盘 `keystore`）不同步：

| 操作 | 内存 `_cert_cache` | 磁盘 `keystore` |
|------|:---:|:---:|
| `_fetch_peer_cert`（发送时） | ✅ 写入 | ❌ 未写入 |
| `_ensure_sender_cert_cached`（接收时） | 命中 → 跳过 | 仍为空 |
| `_get_sender_cert`（解密时） | 不查 | ❌ 读不到 → 失败 |

## 复现步骤

```python
import asyncio
from aun_core import AUNClient

async def main():
    # 创建两个全新客户端（无任何缓存）
    alice = AUNClient({"aun_path": "./data/alice", ...})
    bob = AUNClient({"aun_path": "./data/bob", ...})

    # 分别创建 AID、认证、连接
    # ...

    # Alice → Bob: E2EE 加密发送
    await alice.call("message.send", {
        "to": bob_aid, "payload": "hello", "encrypt": True
    })
    # 此时 alice._cert_cache 有 bob 的证书，但 keystore 没有

    # Bob 收到并处理后回复 → Alice
    # Alice 收到 Bob 的 E2EE 回复
    # _ensure_sender_cert_cached(bob_aid) 命中内存缓存返回 True
    # _get_sender_cert(bob_aid) 从 keystore 读 → None
    # 💥 "sender cert not found for bob_aid"
```

## 实际诊断日志

```
[TRACE] _fetch_peer_cert(evolclaw-ai.agentid.pub) called        ← 发送时下载成功
[TRACE] _fetch_peer_cert OK: 1058 bytes
--- sent: delivered ---
[TRACE] _ensure_sender_cert_cached(evolclaw-ai.agentid.pub) called  ← 接收回复时
[TRACE] _ensure result=True, keystore=EMPTY                     ← 返回True但keystore空！
发送方签名验证失败: sender cert not found for evolclaw-ai.agentid.pub  ← 解密失败
```

## 建议修复方案

### 方案 A：`_fetch_peer_cert` 同时写入 keystore（推荐）

```python
async def _fetch_peer_cert(self, aid: str) -> bytes:
    # ...下载证书...
    self._cert_cache[aid] = _CachedPeerCert(...)
    # 同步写入 keystore
    cert_pem = cert_bytes.decode("utf-8")
    self._keystore.save_cert(aid, cert_pem)
    return cert_bytes
```

### 方案 B：`_ensure_sender_cert_cached` 命中内存缓存时补写 keystore

```python
async def _ensure_sender_cert_cached(self, aid: str) -> bool:
    cached = self._cert_cache.get(aid)
    if cached and time.time() < cached.refresh_after:
        # 补写 keystore（幂等）
        if not self._keystore.load_cert(aid):
            cert_pem = cached.cert_bytes.decode("utf-8")
            self._keystore.save_cert(aid, cert_pem)
        return True
```

### 方案 C：`_get_sender_cert` 增加内存缓存查询

```python
def _get_sender_cert(self, aid: str) -> bytes | None:
    keystore = self._keystore()
    cert_pem = keystore.load_cert(aid) if keystore else None
    if cert_pem:
        return cert_pem.encode("utf-8") if isinstance(cert_pem, str) else cert_pem
    # Fallback: 查 client 层的内存缓存
    # （需要 E2EEManager 持有 client 引用或注入回调）
    return None
```

方案 A 最简洁，改动最小，且保证 keystore 始终与内存缓存同步。

## 影响范围

- **首次 E2EE 通信**必现：A 发送加密消息给 B，B 的加密回复 A 无法解密
- 进程重启后也受影响（内存缓存丢失，keystore 从未写入）
- 明文消息不受影响
- 手动调用 `_ensure_sender_cert_cached`（未命中内存缓存时）可正常工作

## 当前 Workaround

在发送 E2EE 消息前，手动获取对方证书并写入 keystore：

```python
cert_bytes = await client._fetch_peer_cert(target_aid)
client._keystore.save_cert(target_aid, cert_bytes.decode("utf-8"))
```

一次写入后永久生效（证书文件持久化到磁盘）。

---

## 环境信息

- aun-core: 0.1.5 (PyPI)
- Python: 3.11
- OS: Linux (Debian)
- 网关: gateway.agentid.pub:20001
