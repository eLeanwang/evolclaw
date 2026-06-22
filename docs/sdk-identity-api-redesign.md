# AUN SDK 身份接口重设计提案

## 问题背景

### 现象

本地 `AIDs/` 目录下出现了不属于本机的 AID 的私钥文件（`private/key.json`），这些私钥无法用于签名或认证（因为服务端注册的是对端自己的公钥），属于垃圾数据。

### 根因

SDK 的 `auth.createAid()` 内部调用 `_ensureLocalIdentity(aid)`，该方法的逻辑是：

```
_ensureLocalIdentity(aid):
  existing = keystore.loadIdentity(aid)
  if existing 有 private_key_pem + public_key_der_b64:
    return existing          // ← load 语义
  else:
    identity = generateIdentity()  // 生成 ECDSA 密钥对
    _persistIdentity(identity)     // 立即写入磁盘
    return identity                // ← create 语义
```

**密钥在网络请求之前就已落盘**。后续即使服务端返回 "already exists" 错误，密钥也不会被回滚。

### 问题链条

```
evolclaw 调用 getAunClient(aid)
  → createAunClient()
  → client.auth.createAid({ aid })        // evolclaw 的意图是 "load"
    → SDK AuthNamespace.createAid()
      → AuthFlow.createAid(gatewayUrl, aid)
        → _ensureLocalIdentity(aid)        // 本地无密钥 → 生成 + 落盘
        → _createAid(gatewayUrl, identity) // 向服务端注册
          → 失败: "AID already exists"     // 对端已注册
        → _recoverCertViaDownload()        // 尝试下载证书
          → 下载到对端的证书（公钥 ≠ 本地刚生成的私钥）
        → 抛异常或存了不匹配的 cert
  → 私钥已留在磁盘，无法使用
```

### evolclaw 为什么要调 createAid

因为 SDK **没有提供单独的 "加载已有身份" 公开 API**。`createAid` 是 SDK 规定的"让 client 准备好以某个 AID 身份操作"的唯一入口。对于已创建过的自己的 AID，这个调用是幂等的（`_ensureLocalIdentity` 发现已有密钥对，直接返回）。

evolclaw 调 `createAid` 的意图是 **load**，不是 create。

---

## 当前 SDK 接口分析

### 公开 API（AuthNamespace）

| 方法 | 语义 | 是否生成密钥 |
|------|------|-------------|
| `auth.createAid({ aid })` | 确保本地有身份 + 向服务端注册 | **是**（无密钥时） |
| `auth.authenticate({ aid })` | 认证登录（需已有身份） | 否 |
| `auth.signAgentMd(content, { aid })` | 用本地私钥签名 | 否 |
| `auth.verifyAgentMd(content, { aid })` | 验证签名（自动获取对端证书） | 否 |
| `auth.uploadAgentMd(content)` | 上传 agent.md | 否 |
| `auth.headAgentMd(aid)` | HEAD 检查远程 agent.md | 否 |
| `auth.downloadAgentMd(aid)` | 下载对端 agent.md | 否 |
| `auth.checkAid({ aid })` | 检查本地+远程状态 | 否 |
| `auth.renewCert()` | 续期证书 | 否 |
| `auth.rekey()` | 密钥轮换 | 否 |

### 公开 API（AUNClient）

| 方法 | 语义 | 是否生成密钥 |
|------|------|-------------|
| `client.listIdentities()` | 列出有私钥的 AID | 否 |
| `client.fetchAgentMd(aid)` | 下载+验签+保存 agent.md | 否 |
| `client.publishAgentMd()` | 读本地→签名→上传 | 否 |
| `client.checkAgentMd(aid)` | 检查 agent.md 同步状态 | 否 |
| `client.connect(auth, options)` | 连接网关 | 否（但 connectSession 内部可能触发） |

### 内部方法（AuthFlow，未公开）

| 方法 | 语义 | 是否生成密钥 |
|------|------|-------------|
| `loadIdentity(aid)` | 加载身份，不存在抛错 | 否 |
| `loadIdentityOrNone(aid)` | 加载身份，不存在返回 null | 否 |
| `_ensureLocalIdentity(aid)` | 确保有身份（不存在则生成） | **是** |
| `_ensureIdentity()` | 确保有身份（不存在则生成） | **是** |
| `ensureAuthenticated(gatewayUrl)` | 确保已认证（可能生成密钥） | **是** |
| `_fetchPeerCert(aid)` | 获取对端证书 | 否 |
| `verifyPeerCertificate(gw, cert, aid)` | 验证对端证书链 | 否 |

### 关键发现

1. `loadIdentity` / `loadIdentityOrNone` 已存在于 `AuthFlow` 上，语义正确（只读），但**未暴露到 `AuthNamespace` 公开 API**
2. `_fetchPeerCert` 功能完整（获取+缓存+PKI验证），但是 **private 方法**
3. `createAid` 是唯一的"准备身份"公开入口，混合了 load 和 create 两个语义

---

## 应用场景梳理

从应用层看，对 AID 的操作分为三类主体：

### A. 以自己身份操作（需要私钥）

| 场景 | 前置条件 | 操作 |
|------|----------|------|
| 发消息 | 已有身份 | loadIdentity → authenticate → connect → call |
| 签名 agent.md | 已有身份 | loadIdentity → signAgentMd |
| 发布 agent.md | 已有身份 | loadIdentity → publishAgentMd |
| 连接网关 | 已有身份 | loadIdentity → authenticate → connect |

### B. 创建新身份（首次注册）

| 场景 | 前置条件 | 操作 |
|------|----------|------|
| 注册新 AID | 无本地数据 | 生成密钥 → 向服务端注册 → 拿证书 → 落盘 |

### C. 与对端交互（只需对端公钥/证书）

| 场景 | 前置条件 | 操作 |
|------|----------|------|
| 验证对端 agent.md 签名 | 无（自动获取证书） | fetchPeerCert → verify |
| 加密发送给对端 | 已连接 | fetchPeerCert → encrypt |
| 下载对端 agent.md | 无 | fetchAgentMd（纯 HTTP） |
| 查看对端信息 | 无 | checkAid / headAgentMd |

---

## 建议的接口调整

### 原则

1. **读写分离**：加载已有身份（只读）和创建新身份（写入）必须是不同的入口
2. **原子写入**：创建新身份必须是原子操作——服务端确认后才落盘，失败不留痕迹
3. **路径隔离**：自己的操作碰 `private/`，对端的操作只碰 `public/certs/`
4. **最小暴露**：将应用层需要的内部方法提升为公开 API

### 具体调整

#### 1. AuthNamespace 新增 `loadIdentity`

```typescript
/**
 * 加载已有本地身份。本地无私钥 → 抛 StateError。
 * 语义：我知道这是我的 AID，加载它以便后续操作。
 * 
 * 内部实现：调用 AuthFlow.loadIdentity(aid)（已有，只需暴露）
 */
auth.loadIdentity(params: { aid: string }): IdentityRecord
```

#### 2. `createAid` 改为原子语义（或新增 `registerAid`）

**方案 A：修改 createAid 行为**

```typescript
/**
 * 创建新 AID 并注册到服务端。
 * 
 * 变更：密钥生成后保留在内存，注册成功后才落盘。
 * 失败（网络错误、AID 已存在等）→ 不写磁盘，不留痕迹。
 * 
 * 如果本地已有该 AID 的完整身份（私钥+证书），直接返回（幂等）。
 */
auth.createAid(params: { aid: string }): Promise<AuthNamespaceResult>
```

**方案 B：新增 registerAid，createAid 标记 deprecated**

```typescript
/**
 * 注册新 AID：生成密钥 → 服务端注册 → 拿证书 → 原子落盘。
 * 全部成功才写磁盘，任一步失败 → 内存丢弃，磁盘无变化。
 */
auth.registerAid(params: { aid: string }): Promise<AuthNamespaceResult>
```

#### 3. 公开 `fetchPeerCert`

```typescript
/**
 * 获取对端证书（本地缓存 → 网络获取 → PKI 验证）。
 * 只写 public/certs/，绝不碰 private/。
 * 
 * 内部实现：调用 AUNClient._fetchPeerCert（已有，只需公开）
 */
auth.fetchPeerCert(aid: string, opts?: { certFingerprint?: string }): Promise<string>
```

---

## 当前 SDK vs 建议设计 对比

| 应用场景 | 当前 SDK | 问题 | 建议设计 |
|----------|----------|------|----------|
| 加载已有身份 | `auth.createAid({ aid })` | 无密钥时会生成+落盘 | `auth.loadIdentity({ aid })` — 只读，不存在就抛 |
| 创建新身份 | `auth.createAid({ aid })` | 先落盘再联网，失败不回滚 | `auth.registerAid({ aid })` — 原子，失败无痕 |
| 认证登录 | `auth.authenticate({ aid })` | ✓ 语义正确 | 不变 |
| 获取对端证书 | `_fetchPeerCert(aid)` (private) | 应用层无法直接调用 | `auth.fetchPeerCert(aid)` — 公开 |
| 验证对端签名 | `auth.verifyAgentMd(content, { aid })` | ✓ 语义正确 | 不变 |
| 下载对端 agent.md | `client.fetchAgentMd(aid)` | ✓ 语义正确 | 不变 |
| 签名 agent.md | `auth.signAgentMd(content, { aid })` | ✓ 语义正确 | 不变 |
| 列出本地身份 | `client.listIdentities()` | ✓ 语义正确 | 不变 |

---

## evolclaw 侧对应调整

SDK 接口调整后，evolclaw 的调用方式变为：

```typescript
// 加载已有身份（当前的 getAunClient）
async function getAunClient(aid: string, opts?: { aunPath?: string }): Promise<any> {
  const client = await createAunClient({ aunPath: opts?.aunPath });
  client.auth.loadIdentity({ aid });  // 不存在就抛，不会生成密钥
  return client;
}

// 创建新 AID（当前的 aidCreate）
async function aidCreate(aid: string, opts?: { aunPath?: string }): Promise<AidCreateResult> {
  const client = await createAunClient({ aunPath: opts?.aunPath });
  const result = await client.auth.registerAid({ aid });  // 原子，失败无痕
  return { aid, alreadyExisted: false, gateway: result.gateway, client };
}

// 对端操作（验签/获取证书）
async function verifyPeerAgentMd(peerAid: string, content: string): Promise<VerifyResult> {
  const client = await createBareClient();  // 不需要自己的身份
  return await client.auth.verifyAgentMd(content, { aid: peerAid });
  // 内部自动调 fetchPeerCert，只碰 public/certs/
}
```

---

## aid list 命令的问题

### 当前实现

evolclaw 的 `aid list` 使用自己实现的 `aidList()` 函数，通过扫描 `{aunPath}/AIDs/` 目录下所有子目录来列出 AID。它会列出：

- 有私钥的自己的 AID（`hasPrivateKey: true`）
- 只有 agent.md 的对端 AID（`hasPrivateKey: false`）— SDK 自动下载 agent.md 时创建的目录
- 有私钥但不可用的 AID（`hasPrivateKey: true, canSign: true` 但实际无法在服务端认证）

### SDK 的 listIdentities

SDK 的 `client.listIdentities()` 只返回有有效私钥的 AID（12 个），不包含只有 agent.md 的对端目录（5 个）。

### 对比

| | evolclaw `aidList()` | SDK `listIdentities()` |
|---|---|---|
| 数据源 | 扫描 `AIDs/` 目录 | keystore 内部查询 |
| 包含对端 AID | 是（标记 `hasPrivateKey: false`） | 否 |
| 包含孤儿密钥 | 是（标记 `canSign: true` 但实际不可用） | 是 |
| 区分"可用"vs"不可用" | 通过 `signVerified` 实测 | 不区分 |

### 建议

`aid list` 应该区分两种列表：

1. **我的身份**（`aid list --mine`）：只列出有私钥且 signVerified=true 的 AID
2. **本地已知 AID**（`aid list --all`）：列出所有本地有数据的 AID（含对端缓存）

默认行为应该是 `--mine`，避免用户误以为对端 AID 也是自己的。

---

## 总结

| 层 | 当前问题 | 修复方案 |
|---|---|---|
| **SDK** | `createAid` 混合 load/create 语义；create 先落盘再联网 | 拆分为 `loadIdentity`（只读）+ `registerAid`（原子写入）；公开 `fetchPeerCert` |
| **evolclaw** | 用 `createAid` 做 load，对端 AID 误触发密钥生成 | SDK 修复后改用 `loadIdentity`；`aid list` 默认只显示可用身份 |

SDK 的修改量很小（暴露已有内部方法 + 调整 `createAid` 的落盘时机），但能从根本上消除"非本机 AID 产生无用私钥"的问题。
