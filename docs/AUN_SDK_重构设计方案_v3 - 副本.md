# AUN SDK 重构设计方案 v3（最终版）

## 一、设计原则

### 1.1 两主体架构

| 主体 | 职责 | 状态 |
|------|------|------|
| **AID** | AID 本身（密码学材料 + 证书） | 无状态值对象 |
| **AUNClient** | AID 状态（连接 + 会话生命周期） | 有状态机 |

### 1.2 核心改进点

1. **加密种子外部管理**：AID 构造时强制传入 `encryptionSeed`（可为空字符串），由应用层统一管理
2. **AUNClient 身份可重载**：构造时可选传入 AID，也可通过 `loadIdentity()` 加载/重载身份（仅 NoIdentity 或 Closed 状态可调）
3. **判断方法精简**：只保留 2 个核心判断（`isCertValid()` 公钥有效性、`isPrivateKeyValid()` 私钥有效性）
4. **exists 语义明确**：HEAD PKI 证书端点判断 AID 是否注册；`headAgentMd()` 判断名片是否发布
5. **状态机闭环**：AUNClient 状态机支持 close 后重载身份重新使用，连接断开后自动退避重连
6. **实例级 protected_headers**：AUNClient 构造时可设置默认 `protected_headers`，自动附加到所有消息发送和 RPC 调用，无需每次传入
7. **多设备/多实例支持**：AUNClient 构造时传入 `deviceId`/`slotId` 构成消费通道，同一 AID 最多 10 设备 × 10 slot 在线

---

## 二、AID 类（AID 本身）

### 2.1 构造方法

```typescript
class AID {
  constructor(opts: {
    aunPath: string;           // 必传：keystore 根目录
    encryptionSeed: string;    // 必传：加密种子（可为空字符串 ''）
  });
}
```

**说明**：
- `aunPath` 和 `encryptionSeed` 都是必传参数
- `encryptionSeed` 可以是空字符串 `''`，表示不加密
- 应用层统一管理加密种子，SDK 不持久化

**示例**：
```typescript
// 有加密
const aid = new AID({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: 'my-secret-seed-from-env'
});

// 无加密
const aid = new AID({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: ''
});
```

---

### 2.2 只读属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `aid` | string | AID 标识符（如 `'alice.aid.pub'`） |
| `aunPath` | string | keystore 根目录 |
| `certPem` | string | PEM 格式证书 |
| `publicKey` | string | DER base64 公钥 |
| `certSubject` | string | 证书 subject |
| `certNotBefore` | Date | 证书生效时间 |
| `certNotAfter` | Date | 证书过期时间 |
| `certIssuer` | string | 证书颁发者 |
| `certFingerprint` | string | sha256 指纹 |

---

### 2.3 状态判断（2 个核心方法）

| 方法 | 返回 | 说明 |
|------|:----:|------|
| `isCertValid()` | boolean | 公钥有效性：链验证通过 + 在有效期内 |
| `isPrivateKeyValid()` | boolean | 私钥有效性：有私钥 + 与公钥配对（蕴含公钥有效） |

**派生语义**（直接读这两个判断即可）：

| 派生判断 | 等价表达式 | 说明 |
|---------|-----------|------|
| 能否验签 | `isCertValid()` | 公钥有效即可验签 |
| 能否签名 | `isPrivateKeyValid()` | 私钥有效即可签名 |
| 是否本地身份 | `isPrivateKeyValid()` | 私钥有效一定意味着公私钥都有效 |
| 是否对端身份 | `isCertValid() && !isPrivateKeyValid()` | 仅有公钥 |

**示例**：
```typescript
const me = await aid.load('alice.aid.pub');

if (me.isPrivateKeyValid()) {
  // 本地身份，可签名
  const signed = me.signAgentMd(content);
} else if (me.isCertValid()) {
  // 对端身份，仅可验签
  const result = me.verifyAgentMd(content);
}
```

---

### 2.4 加载与查询方法

#### `load(aid: string): Promise<AID>`

从本地加载 AID（证书 + 私钥）。

**流程**：
1. 从 `{aunPath}/AIDs/{aid}/public/certs/` 读证书
2. 链验证 + 有效期检查
3. 尝试从 `{aunPath}/AIDs/{aid}/private/key.pem` 读私钥
4. 若有私钥，签名自检（签 → 验）

**返回**：
- 有私钥且配对 → Local AID（`isPrivateKeyValid() === true`）
- 仅有证书 → PeerOnly AID（`isCertValid() === true`，`isPrivateKeyValid() === false`）

**失败抛错**：
- `CertNotFoundError`：证书不存在
- `CertExpiredError`：证书过期
- `CertChainBrokenError`：证书链验证失败
- `KeyPairMismatchError`：私钥与公钥不配对

**示例**：
```typescript
const aid = new AID({ aunPath: '...', encryptionSeed: '...' });
const me = await aid.load('alice.aid.pub');

if (me.isPrivateKeyValid()) {
  console.log('本地身份，可签名');
} else if (me.isCertValid()) {
  console.log('对端身份，仅可验签');
}
```

---

#### `register(aid: string): Promise<AID>`

注册新 AID。

**流程**：
1. 生成 keypair
2. 向服务端注册（POST `/auth/register`）
3. 拿到证书
4. 原子落盘（cert + 私钥）

**返回**：Local AID（`isPrivateKeyValid() === true`）

**失败抛错**：
- `IdentityConflictError`：AID 已被占用
- `NetworkError`：网络故障

**示例**：
```typescript
const aid = new AID({ aunPath: '...', encryptionSeed: '...' });
const me = await aid.register('alice.aid.pub');
console.log('注册成功:', me.aid);
```

---

#### `list(): Promise<AID[]>`

列出本地所有有私钥的 AID。

**流程**：
1. 扫描 `{aunPath}/AIDs/` 目录
2. 对每个 AID 调用 `load`
3. 过滤出 `isPrivateKeyValid() === true` 的

**返回**：Local AID 数组

**示例**：
```typescript
const aid = new AID({ aunPath: '...', encryptionSeed: '...' });
const myAids = await aid.list();
console.log('本地身份:', myAids.map(a => a.aid));
```

---

#### `exists(aid: string): Promise<ExistsResult>`

检查 AID 是否已在网络上注册（PKI 是否签发过证书）。

**流程**：
1. HEAD PKI 证书端点（如 `https://pki.{issuer}/certs/{aid}`）
2. 根据状态码判断

**返回**：
```typescript
type ExistsResult = 
  | { exists: true }                                          // 200 OK
  | { exists: false; reason: 'not-found' }                    // 404
  | { exists: 'unknown'; reason: 'network-error'; error: Error };  // 其他
```

**特点**：
- 零 body 传输，最快
- 明确区分"不存在"和"网络故障"

**示例**：
```typescript
const aid = new AID({ aunPath: '...', encryptionSeed: '...' });
const result = await aid.exists('alice.aid.pub');

if (result.exists === false) {
  await aid.register('alice.aid.pub');
} else if (result.exists === true) {
  console.log('名字已被占用');
} else {
  console.log('网络故障，无法确定');
}
```

---

### 2.5 密码学操作（同步方法）

| 方法 | 前置条件 | 说明 |
|------|---------|------|
| `verify(payload, signature)` | `isCertValid()` | 验签任意 payload |
| `verifyAgentMd(content)` | `isCertValid()` | 验签 agent.md，返回 `VerifyResult` |
| `sign(payload)` | `isPrivateKeyValid()` | 签名任意 payload |
| `signAgentMd(content)` | `isPrivateKeyValid()` | 签名 agent.md，返回带签名块的完整 content |

**类型定义**：
```typescript
type VerifyResult = {
  status: 'verified' | 'invalid' | 'unsigned';
  payload?: string;  // 去除签名块后的原始内容
  reason?: string;
};
```

**示例**：
```typescript
// 签名
const me = await aid.load('alice.aid.pub');
const signed = me.signAgentMd(content);

// 验签
const peer = await aid.load('bob.aid.pub');
const result = peer.verifyAgentMd(signed);
if (result.status === 'verified') {
  console.log('验签通过:', result.payload);
}
```

---

### 2.6 agent.md 下载（HTTP，无需身份）

#### `fetchAgentMd(): Promise<AgentMdFetchResult>`

下载 agent.md + 自动拉证书 + 验签。

**流程**：
1. GET `https://{this.aid}/agent.md`
2. 从签名块提取 fingerprint
3. 查证书（本地缓存优先，无则从 PKI 拉）
4. 验签

**返回**：
```typescript
type AgentMdFetchResult = {
  content: string;
  verification: {
    status: 'verified' | 'invalid' | 'unsigned';
    reason?: string;
  };
  certPem: string;
};
```

**失败抛错**：
- `AgentMdNotFoundError`：agent.md 不存在（404）
- `NetworkError`：网络故障

**示例**：
```typescript
const aid = new AID({ aunPath: '...', encryptionSeed: '...' });
const result = await aid.fetchAgentMd();
if (result.verification.status === 'verified') {
  console.log('名片有效:', result.content);
}
```

---

#### `checkAgentMd(ttlDays?: number): Promise<AgentMdCheckResult>`

比对本地缓存与远端 etag，决定是否需要重新拉取。

**返回**：
```typescript
type AgentMdCheckResult = {
  needsUpdate: boolean;
  localEtag?: string;
  remoteEtag?: string;
  lastModified?: string;
};
```

**示例**：
```typescript
const aid = new AID({ aunPath: '...', encryptionSeed: '...' });
const check = await aid.checkAgentMd(7);  // 7 天 TTL
if (check.needsUpdate) {
  const fresh = await aid.fetchAgentMd();
}
```

---

#### `headAgentMd(): Promise<AgentMdHeadResult>`

HEAD 请求拿 agent.md 元数据。

**返回**：
```typescript
type AgentMdHeadResult = {
  etag: string;
  lastModified: string;
  contentLength: number;
};
```

---

#### `resolve(aid: string, opts?: ResolveOpts): Promise<ResolveResult>`

**一站式解析对端 AID**：下载证书 → 验签证书 → 下载 agent.md → 验签 agent.md，健壮处理整个链路上的各种问题。

**参数**：
```typescript
type ResolveOpts = {
  forceRefresh?: boolean;     // 强制忽略本地缓存
  timeout?: number;            // 整体超时（ms），默认 10000
  skipAgentMd?: boolean;       // 只解析证书，不下载 agent.md
};
```

**流程**：
1. **检查本地证书缓存** — 缓存存在且未过期 → 跳到 step 4
2. **下载证书** — GET PKI 证书端点
3. **验证证书** — 链验证 + 有效期检查
4. **下载 agent.md** — GET `https://{aid}/agent.md`
5. **验证 agent.md 签名** — 从签名块提取 fingerprint，比对证书 fingerprint，验签
6. **返回完整结果** — 包含 AID 对象、证书、agent.md 内容、所有验证状态

**返回**：
```typescript
type ResolveResult = {
  aid: AID;                          // 解析得到的 PeerOnly AID 对象
  agentMd?: {
    content: string;
    verification: {
      status: 'verified' | 'invalid' | 'unsigned';
      reason?: string;
    };
  };
  source: {
    certFromCache: boolean;          // 证书来自本地缓存
    agentMdFetched: boolean;         // agent.md 已下载
  };
};
```

**错误处理（健壮性）**：

| 阶段 | 错误 | 处理策略 |
|------|------|---------|
| 证书下载失败（网络） | `NetworkError` | 抛错，应用层重试 |
| 证书不存在（404） | `CertNotFoundError` | 抛错，明确"AID 未注册" |
| 证书链验证失败 | `CertChainBrokenError` | 抛错，证书不可信 |
| 证书过期 | `CertExpiredError` | 抛错，证书已失效 |
| agent.md 不存在（404） | `AgentMdNotFoundError` | 抛错，明确"对端未发布名片" |
| agent.md 下载失败（网络） | `NetworkError` | 抛错，应用层重试 |
| agent.md 签名验证失败 | 返回 `verification.status = 'invalid'` | **不抛错**，让应用层决定 |
| agent.md 未签名 | 返回 `verification.status = 'unsigned'` | **不抛错**，让应用层决定 |
| 证书指纹不匹配 | 返回 `verification.status = 'invalid'` | **不抛错**，让应用层决定 |

**关键设计原则**：
- 网络/资源不存在 → 抛错（应用层无法继续）
- 内容验证失败 → 返回结果但标记 invalid（应用层可能仍想看内容）

**示例**：
```typescript
const aid = new AID({ aunPath: '...', encryptionSeed: '' });

try {
  const result = await aid.resolve('bob.aid.pub');
  
  console.log('AID 解析成功:', result.aid.aid);
  console.log('证书来自:', result.source.certFromCache ? '本地缓存' : '网络下载');
  
  if (result.agentMd?.verification.status === 'verified') {
    console.log('名片有效:', result.agentMd.content);
  } else if (result.agentMd?.verification.status === 'invalid') {
    console.log('警告：名片签名无效，原因:', result.agentMd.verification.reason);
  } else {
    console.log('名片未签名');
  }
} catch (e) {
  if (e instanceof CertNotFoundError) {
    console.log('AID 未在 PKI 注册');
  } else if (e instanceof AgentMdNotFoundError) {
    console.log('AID 未发布 agent.md');
  } else if (e instanceof NetworkError) {
    console.log('网络故障:', e.message);
  }
}
```

**网络开销优化**：
- 本地证书缓存命中：1 次 GET agent.md
- 本地无缓存：1 次 GET 证书 + 1 次 GET agent.md（可并行）
- `skipAgentMd: true`：只解析证书，0~1 次网络请求

---

### 2.7 证书管理（联网）

| 方法 | 前置条件 | 说明 |
|------|---------|------|
| `renewCert()` | `isPrivateKeyValid()` | 续签证书（cert 即将过期时调用），返回新 AID（cert 更新，私钥不变） |
| `rekey()` | `isPrivateKeyValid()` | 密钥轮换：生成新 keypair → 服务端换证书 → 落盘，返回新 AID（cert + 私钥都更新） |
| `changeSeed(oldSeed, newSeed)` | — | 更换加密种子：用旧种子解密所有私钥 → 用新种子重新加密 → 落盘 |
| `diagnose()` | — | 本地状态 + 远端注册状态对比，返回诊断报告 |

---

### 2.8 AID 使用场景对照表（场景速查）

下表列出常见使用场景，以及新设计下应该用哪个方法。每个场景都应能优雅完成，无需多余动作。

| 场景 | 推荐方法 | 一行代码示例 |
|------|---------|--------------|
| 检查 AID 名字是否可注册 | `exists(aid)` | `(await aid.exists('alice.aid.pub')).exists === false` |
| 注册新身份 | `register(aid)` | `const me = await aid.register('alice.aid.pub')` |
| 加载本地身份用于签名 | `load(aid)` | `const me = await aid.load('alice.aid.pub')` |
| 列出本地所有身份 | `list()` | `const all = await aid.list()` |
| **一站式解析对端**（推荐）| `resolve(aid)` | `const { aid: peer, agentMd } = await aid.resolve('bob.aid.pub')` |
| 只想拿对端 agent.md（已有证书） | `load(aid)` + `fetchAgentMd()` | `(await aid.load('bob.aid.pub')).fetchAgentMd()` |
| 只想拿对端 agent.md（没证书） | `resolve(aid)` | `aid.resolve('bob.aid.pub')` |
| 离线签名 agent.md | `load` + `signAgentMd` | `(await aid.load('alice.aid.pub')).signAgentMd(content)` |
| 离线验签 agent.md | `load` + `verifyAgentMd` | `(await aid.load('bob.aid.pub')).verifyAgentMd(signed)` |
| 检查证书是否即将过期 | `load` + `certNotAfter` | `(await aid.load('alice.aid.pub')).certNotAfter` |
| 证书即将过期，续签 | `renewCert()` | `const newAid = await me.renewCert()` |
| 密钥泄漏，换密钥 | `rekey()` | `const newAid = await me.rekey()` |
| 检查本地+远端一致性 | `diagnose()` | `const report = await me.diagnose()` |
| 验证某段 payload 的签名 | `verify(payload, sig)` | `peer.verify(payload, signature)` |
| 用本地私钥签 payload | `sign(payload)` | `me.sign(payload)` |

#### 关键场景详解

**场景 A：未知对端，需要建立信任**

```typescript
// 一步到位，自动处理证书 + agent.md
const aid = new AID({ aunPath, encryptionSeed: '' });
const result = await aid.resolve('bob.aid.pub');

if (result.agentMd?.verification.status === 'verified') {
  // 信任建立，可以保存 peer 用于后续操作
  console.log('对端可信:', result.agentMd.content);
}
```

**场景 B：已知对端（证书已缓存），快速验签**

```typescript
// 直接 load，本地操作，零网络
const aid = new AID({ aunPath, encryptionSeed: '' });
const peer = await aid.load('bob.aid.pub');

if (peer.isCertValid()) {
  const result = peer.verifyAgentMd(content);
}
```

**场景 C：注册新身份流程（健壮）**

```typescript
const aid = new AID({ aunPath, encryptionSeed: process.env.SEED || '' });

// Step 1: 快速检查名字是否可用
const check = await aid.exists('alice.aid.pub');
if (check.exists === true) {
  throw new Error('名字已被占用');
}
if (check.exists === 'unknown') {
  throw new Error('网络故障，无法确定');
}

// Step 2: 注册（原子操作，失败不留垃圾）
const me = await aid.register('alice.aid.pub');
console.log('注册成功:', me.aid);
```

**场景 D：批量加载本地身份（并发安全）**

```typescript
const aid = new AID({ aunPath, encryptionSeed: '' });
const all = await aid.list();

// AID 是值对象，可并发
const signatures = await Promise.all(
  all.map(me => Promise.resolve(me.signAgentMd(content)))
);
```

**类型定义**：
```typescript
type DiagnoseResult = {
  localValid: boolean;
  remoteRegistered: boolean;
  certMatch: boolean;
  suggestions: string[];
};
```

---

### 2.9 AID 错误状态汇总

#### 2.9.1 加载阶段错误

| 错误类型 | 触发条件 | 错误码 | 说明 | 恢复建议 |
|---------|---------|--------|------|---------|
| `CertNotFoundError` | 证书文件不存在 | `CERT_NOT_FOUND` | `{aunPath}/AIDs/{aid}/cert.pem` 不存在 | 1. 检查 aid 拼写<br>2. 调用 `register()` 注册<br>3. 调用 `fetchAgentMd()` 拉取对端证书 |
| `CertParseError` | 证书格式错误 | `CERT_PARSE_ERROR` | PEM 格式损坏或无法解析 | 删除损坏文件，重新拉取 |
| `CertExpiredError` | 证书已过期 | `CERT_EXPIRED` | `certNotAfter < now` | 调用 `renewCert()` 续签 |
| `CertNotYetValidError` | 证书未生效 | `CERT_NOT_YET_VALID` | `certNotBefore > now` | 检查系统时间 |
| `CertChainBrokenError` | 证书链验证失败 | `CERT_CHAIN_BROKEN` | 无法验证到根证书 | 1. 更新根证书缓存<br>2. 检查 PKI 配置 |
| `KeyPairMismatchError` | 私钥与公钥不配对 | `KEYPAIR_MISMATCH` | 签名自检失败（签 → 验不通过） | 1. 私钥损坏，删除重新生成<br>2. 证书与私钥不匹配，重新拉取证书 |
| `PrivateKeyParseError` | 私钥格式错误 | `PRIVATE_KEY_PARSE_ERROR` | PEM 格式损坏或解密失败 | 1. 检查 `encryptionSeed` 是否正确<br>2. 删除损坏文件，重新生成 |

#### 2.9.2 注册阶段错误

| 错误类型 | 触发条件 | 错误码 | 说明 | 恢复建议 |
|---------|---------|--------|------|---------|
| `IdentityConflictError` | AID 已被占用 | `IDENTITY_CONFLICT` | 服务端返回 409 Conflict | 换一个 AID 名字 |
| `InvalidAidFormatError` | AID 格式不合法 | `INVALID_AID_FORMAT` | 不符合 `{name}.{issuer}` 格式 | 检查 AID 格式 |
| `NetworkError` | 网络故障 | `NETWORK_ERROR` | 无法连接服务端 | 检查网络连接 |
| `ServerError` | 服务端错误 | `SERVER_ERROR` | 服务端返回 5xx | 稍后重试 |

#### 2.9.3 agent.md 下载阶段错误

| 错误类型 | 触发条件 | 错误码 | 说明 | 恢复建议 |
|---------|---------|--------|------|---------|
| `AgentMdNotFoundError` | agent.md 不存在 | `AGENTMD_NOT_FOUND` | 服务端返回 404 | 该 AID 未发布名片 |
| `AgentMdParseError` | agent.md 格式错误 | `AGENTMD_PARSE_ERROR` | YAML frontmatter 解析失败 | 联系 AID 所有者修复 |
| `SignatureNotFoundError` | 签名块缺失 | `SIGNATURE_NOT_FOUND` | agent.md 未签名 | 该名片不可信 |
| `SignatureInvalidError` | 签名验证失败 | `SIGNATURE_INVALID` | 签名与内容不匹配 | 该名片已被篡改 |
| `CertFingerprintMismatchError` | 证书指纹不匹配 | `CERT_FINGERPRINT_MISMATCH` | 签名块中的 fingerprint 与证书不符 | 证书与签名不对应 |
| `NetworkError` | 网络故障 | `NETWORK_ERROR` | 无法连接 `https://{aid}/agent.md` | 检查网络连接 |

#### 2.9.4 证书管理阶段错误

| 错误类型 | 触发条件 | 错误码 | 说明 | 恢复建议 |
|---------|---------|--------|------|---------|
| `CertRenewalFailedError` | 续签失败 | `CERT_RENEWAL_FAILED` | 服务端拒绝续签 | 检查 AID 状态，可能需要 rekey |
| `RekeyFailedError` | 密钥轮换失败 | `REKEY_FAILED` | 服务端拒绝换证书 | 联系服务端管理员 |
| `PrivateKeyRequiredError` | 缺少私钥 | `PRIVATE_KEY_REQUIRED` | 对端身份无法执行需要私钥的操作 | 该操作需要本地身份 |

#### 2.9.5 密码学操作错误

| 错误类型 | 触发条件 | 错误码 | 说明 | 恢复建议 |
|---------|---------|--------|------|---------|
| `SignatureOperationError` | 签名操作失败 | `SIGNATURE_OPERATION_ERROR` | 私钥损坏或算法不支持 | 检查私钥完整性 |
| `VerificationOperationError` | 验签操作失败 | `VERIFICATION_OPERATION_ERROR` | 公钥损坏或算法不支持 | 检查证书完整性 |
| `CertNotValidError` | 证书无效 | `CERT_NOT_VALID` | 调用 `verify()` 但 `isCertValid() === false` | 先检查 `isCertValid()` |
| `PrivateKeyNotValidError` | 私钥无效 | `PRIVATE_KEY_NOT_VALID` | 调用 `sign()` 但 `isPrivateKeyValid() === false` | 先检查 `isPrivateKeyValid()` |

---

### 2.10 AID 状态诊断流程

```
加载 AID
  │
  ├─ 证书存在？
  │  ├─ 否 → CertNotFoundError
  │  └─ 是 ↓
  │
  ├─ 证书可解析？
  │  ├─ 否 → CertParseError
  │  └─ 是 ↓
  │
  ├─ 证书在有效期内？
  │  ├─ 否 → CertExpiredError / CertNotYetValidError
  │  └─ 是 ↓
  │
  ├─ 证书链验证通过？
  │  ├─ 否 → CertChainBrokenError
  │  └─ 是 ↓
  │
  ├─ isCertValid() = true
  │
  ├─ 私钥存在？
  │  ├─ 否 → 返回 PeerOnly AID（仅能验签）
  │  └─ 是 ↓
  │
  ├─ 私钥可解析？
  │  ├─ 否 → PrivateKeyParseError
  │  └─ 是 ↓
  │
  ├─ 私钥与公钥配对？（签名自检）
  │  ├─ 否 → KeyPairMismatchError
  │  └─ 是 ↓
  │
  └─ isPrivateKeyValid() = true
     返回 Local AID（能签能验）
```

---

## 三、AUNClient 类（AID 状态）

### 3.1 构造方法与身份加载

```typescript
class AUNClient {
  constructor(aid?: AID, opts?: {
    deviceId?: string;  // 默认 getDeviceId()，同一 AID 最多 10 个设备在线
    slotId?: string;    // 默认 'default'，同设备最多 10 个 slot 在线
  });
  loadIdentity(aid: AID): void;  // 加载/重载身份，aid 必须 isPrivateKeyValid()，只在 NoIdentity 或 Closed 状态可调用
  setProtectedHeaders(headers: Record<string, string> | null): void;  // 设置/清除实例级 protected_headers，随时可调
}
```

**说明**：
- 构造时可选传入 AID 对象
- 传入有效本地 AID（`isPrivateKeyValid() === true`）→ 直接进入 Standby 状态
- 传入无效 AID 或不传 → 进入 NoIdentity 状态
- `loadIdentity(aid)` 只在 NoIdentity 或 Closed 状态可调用
- `loadIdentity` 传入的 AID 必须 `isPrivateKeyValid() === true`，否则抛 `InvalidIdentityError`
- `deviceId` + `slotId` 构成消费通道，构造后不可变更，影响 V2 session 密钥存储和消息序号命名空间
- `setProtectedHeaders(headers)` 随时可调，传 `null` 清除；设置后自动附加到所有 `call()`、`sendV2()`、`sendGroupV2()` 调用，无需在每次调用时传入

**示例**：
```typescript
const aid = new AID({ aunPath: '...', encryptionSeed: '...' });
const me = await aid.load('alice.aid.pub');
const client = new AUNClient(me, { deviceId: 'desktop-01', slotId: 'default' });

// 设置实例级 protected_headers
client.setProtectedHeaders({ 'x-app': 'evolclaw', 'x-version': '3.0' });

// 之后所有 call/sendV2/sendGroupV2 自动附带
await client.connect();

// 运行时更新
client.setProtectedHeaders({ 'x-app': 'evolclaw', 'x-version': '3.1' });

// 清除
client.setProtectedHeaders(null);
```

---

### 3.2 状态机

#### 3.2.1 状态转换图

```
new AUNClient()          new AUNClient(validAid)
      │                         │
      ▼                         ▼
┌──────────────┐         ┌──────────────┐
│  NoIdentity  │         │   Standby    │
│  （无身份）   │         │  （待命中）   │
└──────┬───────┘         └──────┬───────┘
       │                        │
       │ loadIdentity(aid)      │ authenticate()
       │                        │
       ▼                        ▼
┌──────────────┐         ┌──────────────┐
│   Standby    │         │Authenticated │  有 token，可上传 agent.md
│  （待命中）   │         │  （已认证）   │
└──────┬───────┘         └──────┬───────┘
       │                        │
       │ authenticate()         │ connect()
       │                        │
       ▼                        │
┌──────────────┐                │
│Authenticated │                │
│  （已认证）   │────────────────┘
└──────┬───────┘
       │
       │ connect()
       ▼
┌──────────────┐
│  Connecting  │
│  （连接中）   │
└──────┬───────┘
       │ 成功
       ▼
┌──────────────┐
│    Ready     │←──────────────────────────┐
│  （就绪）     │                           │
└──────┬───────┘                           │
       │ 网络断开                           │
       ▼                                   │
┌──────────────┐                           │
│ RetryBackoff │                           │
│（重连等待中） │                           │
│ nextRetryAt  │                           │
└──────┬───────┘                           │
       │ 退避到期 / connect()               │
       ▼                                   │
┌──────────────┐                           │
│ Reconnecting │──────── 成功 ─────────────┘
│  （重连中）   │
└──────┬───────┘
       │ 失败（还有次数）→ RetryBackoff
       │ 失败（重连耗尽）
       ▼
┌───────────────────┐
│  ConnectionFailed │
│  （连接失败）      │
│  lastError/Code   │
└──────┬────────────┘
       │ connect() → Connecting

任意状态 ─── close() ──→ Closed ─── loadIdentity() ──→ Standby

任意连接状态（Connecting/Ready/RetryBackoff/Reconnecting/ConnectionFailed）
  ─── disconnect() ──→ Standby
```

**状态闭环说明**：
- 正常流程：Standby → Authenticated → Connecting → Ready → RetryBackoff → Reconnecting → Ready（循环）
- `connect()` 在 Standby 状态时自动先 authenticate（内部完成），在 Authenticated 状态时直接连接
- 主动断开：任意连接状态 → `disconnect()` → Standby
- 重连耗尽：Reconnecting → ConnectionFailed → `connect()` → Connecting
- 关闭重生：任意状态 → `close()` → Closed → `loadIdentity()` → Standby

---

#### 3.2.2 状态详细说明表

| 状态 | 含义 | 持有身份 | hasIdentity | canSign | canConnect | canSend | isOnline |
|------|------|:-------:|:-----------:|:-------:|:----------:|:-------:|:--------:|
| **NoIdentity** | 无身份，需先 `loadIdentity()` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Standby** | 待命中，身份已加载，无 token | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Authenticated** | 已认证，有 token，未连接 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Connecting** | 正在建立连接 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Ready** | 就绪，全功能可用 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **RetryBackoff** | 重连等待中（退避计时） | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Reconnecting** | 重连中 | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **ConnectionFailed** | 连接失败（重连耗尽） | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Closed** | 已关闭，身份已清除 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**关键说明**：

- **Authenticated**：有 token，可调 `publishAgentMd()` / `uploadAgentMd()`，不需要长连接
- **Connecting**：`connect()` 在 Standby 时自动先 authenticate（内部完成），在 Authenticated 时直接建连接
- **RetryBackoff**：`isOnline === true`，SDK 仍认为自己应该在线，只是暂时等待。可读 `nextRetryAt`
- **ConnectionFailed**：保留身份，可调 `connect()` 重新尝试
- **Closed** vs **ConnectionFailed**：前者清除身份（`hasIdentity = false`），后者保留身份

---

#### 3.2.3 状态转换表

| 当前状态 | 推进方法 / 触发 | 目标状态 | 说明 |
|---------|---------------|---------|------|
| **NoIdentity** | `loadIdentity(aid)` | Standby | aid 必须 `isPrivateKeyValid()` |
| | `close()` | Closed | 幂等 |
| **Standby** | `authenticate()` | Authenticated | 拿 token，不建长连接 |
| | `connect({ gateway? })` | Connecting | 自动先 authenticate 再建连接 |
| | `loadIdentity(aid)` | ❌ 抛 StateError | 仅 NoIdentity / Closed 可重载 |
| | `close()` | Closed | 清除身份 |
| **Authenticated** | `connect({ gateway? })` | Connecting | 直接建连接（已有 token） |
| | `disconnect()` | Standby | 丢弃 token |
| | `close()` | Closed | 清除身份 |
| **Connecting** | 成功 | Ready | 自动推进 |
| | 失败 | ConnectionFailed | 自动推进，记录 lastError |
| | `disconnect()` | Standby | 取消连接 |
| | `close()` | Closed | 清除身份 |
| **Ready** | `disconnect()` | Standby | 主动断开 |
| | 网络断开 | RetryBackoff | 自动推进，启动退避 |
| | `close()` | Closed | 清除身份 |
| **RetryBackoff** | 退避到期 | Reconnecting | 自动推进 |
| | `connect()` | Reconnecting | 跳过退避，立即重连 |
| | `disconnect()` | Standby | 取消重连 |
| | `close()` | Closed | 清除身份 |
| **Reconnecting** | 成功 | Ready | 自动推进 |
| | 失败（还有次数） | RetryBackoff | 自动推进，递增退避 |
| | 失败（重连耗尽） | ConnectionFailed | 自动推进，记录 lastError |
| | `disconnect()` | Standby | 取消重连 |
| | `close()` | Closed | 清除身份 |
| **ConnectionFailed** | `connect()` | Connecting | 重新尝试 |
| | `disconnect()` | Standby | 放弃重试 |
| | `close()` | Closed | 清除身份 |
| **Closed** | `loadIdentity(aid)` | Standby | 重新激活 |

---

#### 3.2.4 方法可用性矩阵

| 方法 | NoIdentity | Standby | Authenticated | Connecting | Ready | RetryBackoff | Reconnecting | ConnectionFailed | Closed |
|------|:----------:|:-------:|:-------------:|:----------:|:-----:|:------------:|:------------:|:----------------:|:------:|
| **状态推进** |
| `loadIdentity(aid)` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `authenticate()` | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `connect({ gateway? })` | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |
| `disconnect()` | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `close()` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **状态查询** |
| `state` (getter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `currentAid` (getter) | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `aunPath` (getter) | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `nextRetryAt` (getter) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `nextRetryInSeconds` (getter) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `lastError` (getter) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| `lastErrorCode` (getter) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| `gatewayHealth` (getter) | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `hasIdentity` (getter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `canSign` (getter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `canConnect` (getter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `canSend` (getter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `isReady` (getter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `isOnline` (getter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `isClosed` (getter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **对端管理** |
| `lookupPeer(aid)` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `getPeer(aid)` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `cachePeer(aid)` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `peers()` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **业务操作** |
| `call()` | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `on()` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `off()` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **agent.md 上传**（需 token） |
| `publishAgentMd()` | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `uploadAgentMd()` | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

**图例**：
- ✅ 可调用
- ❌ 不可调用（抛 StateError）

**说明**：
- `publishAgentMd` / `uploadAgentMd` 要求至少 Authenticated（有 token）。Standby 状态下先调 `authenticate()`
- `disconnect()` 在 ConnectionFailed 状态也可调，从"放弃重试"语义回到 Standby
- 签名/验签操作直接用 `AID` 实例（`me.signAgentMd()`、`peer.verifyAgentMd()`），不在 AUNClient 上

---

#### 3.2.5 状态查询属性

```typescript
class AUNClient {
  // ─── 基础状态 ─────────────────────────
  get state(): ConnectionState;
  // 'no-identity' | 'standby' | 'authenticated' | 'connecting' | 'ready'
  // | 'retry-backoff' | 'reconnecting' | 'connection-failed' | 'closed'
  
  get currentAid(): AID | null;
  get aunPath(): string | null;
  
  // ─── 重连相关（仅 RetryBackoff 状态有意义） ──
  get nextRetryAt(): Date | null;            // 下次重连的绝对时间
  get nextRetryInSeconds(): number | null;   // 距下次重连的秒数
  get retryAttempt(): number;                // 当前重连次数（从 1 开始）
  get retryMaxAttempts(): number;            // 最大重连次数
  
  // ─── 错误信息（RetryBackoff / Reconnecting / ConnectionFailed 时有意义） ──
  get lastError(): Error | null;
  get lastErrorCode(): string | null;
  
  // ─── 网关健康 ─────────────────────────
  get gatewayHealth(): boolean | null;
  
  // ─── Capability Getters ─────────────────
  get hasIdentity(): boolean;        // state !== 'no-identity' && state !== 'closed'
  get canSign(): boolean;            // hasIdentity && currentAid.isPrivateKeyValid()
  get canConnect(): boolean;         // hasIdentity && state !== 'closed'
  get canSend(): boolean;            // state === 'ready'
  get isReady(): boolean;            // 同 canSend
  get isOnline(): boolean;           // ready | retry-backoff | reconnecting
  get isClosed(): boolean;           // state === 'closed'
}
```

---

#### 3.2.6 状态推进决策树

```
我想做什么？
│
├─ 加载身份 → loadIdentity()（仅 NoIdentity/Closed 可调）
│
├─ 签名/验签 → 任意有身份的状态都可以
│
├─ 拿 token（不建长连接）
│  └─ state === 'standby' → authenticate()
│
├─ 上传 agent.md（需 token，不需要长连接）
│  ├─ state === 'standby' → authenticate() 先
│  └─ state >= 'authenticated' → publishAgentMd()
│
├─ 发送消息（RPC，需长连接）
│  └─ canSend?
│     ├─ 是 → call()
│     └─ 否 → 看当前状态
│        ├─ 'standby' / 'authenticated' → connect()
│        ├─ 'retry-backoff' → connect()（跳过退避立即重连）
│        ├─ 'connection-failed' → connect()（重新尝试）
│        └─ 'no-identity' / 'closed' → loadIdentity() 先
│
├─ 主动断开 → disconnect()（任意连接相关状态都行）
│
└─ 关闭客户端 → close()（任意状态都可以）
```

---

#### 3.2.7 常见状态转换场景

**场景 1：首次上线**

```typescript
const me = await aid.load('alice.aid.pub');
const client = new AUNClient(me);   // → Standby
await client.connect();             // Standby → Authenticated → Connecting → Ready
// connect() 内部自动完成 authenticate（如果还没有 token）
```

**场景 2：只想上传 agent.md，不需要长连接**

```typescript
const me = await aid.load('alice.aid.pub');
const client = new AUNClient(me);   // → Standby

await client.authenticate();        // Standby → Authenticated
await client.publishAgentMd();      // 用 token 上传，不建立长连接
// 此时 state 仍是 Authenticated
```

**场景 3：网络断开后自动重连**

```typescript
// 网络断开（自动）
// Ready → RetryBackoff（退避计时启动）
console.log('下次重连:', client.nextRetryInSeconds, '秒后');

// 退避到期（自动）
// RetryBackoff → Reconnecting

// 重连成功（自动）
// Reconnecting → Ready
```

**场景 4：重连等待中应用想立即发消息**

```typescript
// 当前 state === 'retry-backoff'
// 应用想立即发消息，不想等退避

if (!client.canSend) {
  await client.connect();  // 跳过退避，立即进入 Reconnecting
}

// 等待 Reconnecting → Ready，或监听 'state-change' 事件
client.on('state-change', ({ to }) => {
  if (to === 'ready') {
    client.call('message.send', {...});
  }
});
```

**场景 5：重连耗尽后手动重试**

```typescript
// state === 'connection-failed'
console.log('重连失败:', client.lastError, client.lastErrorCode);

// 应用决定再试一次（身份还在）
await client.connect();  // ConnectionFailed → Connecting
```

**场景 6：主动断开后回到待命**

```typescript
await client.disconnect();  // Ready → Standby
// ... 做其他事情，比如离线签名
const signed = client.currentAid!.signAgentMd(content);
// 想再次上线
await client.connect();     // Standby → Authenticated → Connecting → Ready
```

**场景 7：换个身份继续用**

```typescript
await client.close();                    // → Closed（身份清除）
const newMe = await aid.load('bob.aid.pub');
client.loadIdentity(newMe);              // Closed → Standby（新身份）
await client.connect();                  // → Authenticated → Connecting → Ready
```

**场景 8：预热 token**

```typescript
// 应用启动时，预先认证以减少后续连接延迟
const me = await aid.load('alice.aid.pub');
const client = new AUNClient(me);
await client.authenticate();   // → Authenticated（提前拿好 token）

// ... 之后某个时刻需要发消息
await client.connect();        // 直接从 Authenticated 建连接，不用再认证
await client.call('message.send', {...});
```

---

#### 3.2.8 状态检查最佳实践

**推荐：用 capability getter**

```typescript
// ✅ 推荐
if (client.canSend) {
  await client.call('message.send', {...});
} else if (client.canConnect) {
  await client.connect();
}

if (client.isOnline) {
  console.log('连接活跃中（Ready / RetryBackoff / Reconnecting）');
}

if (!client.hasIdentity) {
  client.loadIdentity(await aid.load('alice.aid.pub'));
}
```

**RetryBackoff 状态下的常见模式**：

```typescript
if (client.state === 'retry-backoff') {
  console.log(`将在 ${client.nextRetryInSeconds} 秒后自动重连`);
  console.log(`已尝试 ${client.retryAttempt}/${client.retryMaxAttempts} 次`);
  
  // 用户点了"立即重连"按钮
  if (userClickedRetryNow) {
    await client.connect();  // 跳过退避
  }
}
```

---

### 3.3 AUNClient 错误状态汇总

#### 3.3.1 身份加载错误

| 错误类型 | 触发条件 | 错误码 | 说明 | 恢复建议 |
|---------|---------|--------|------|---------|
| `InvalidIdentityError` | `loadIdentity` 传入的 AID 不是有效本地身份 | `INVALID_IDENTITY` | `aid.isPrivateKeyValid() === false` | 传入有效的本地 AID |
| `StateError` | 在不允许的状态调 `loadIdentity` | `STATE_ERROR` | 仅 NoIdentity / Closed 可调 | 先 `close()` 再 `loadIdentity()` |

#### 3.3.2 连接阶段错误

| 错误类型 | 触发条件 | 错误码 | 说明 | 恢复建议 |
|---------|---------|--------|------|---------|
| `AuthError` | 认证失败 | `AUTH_ERROR` | 两阶段登录失败 | 检查 `currentAid.isPrivateKeyValid()` |
| `TokenExpiredError` | Token 过期 | `TOKEN_EXPIRED` | 访问令牌已过期 | SDK 自动续期，否则重连 |
| `ConnectionError` | 连接失败 | `CONNECTION_ERROR` | 无法建立 WebSocket 连接 | 检查 gateway 地址和网络 |
| `GatewayUnreachableError` | 网关不可达 | `GATEWAY_UNREACHABLE` | 网关服务不可用 | 稍后重试或更换 gateway |
| `NetworkError` | 网络故障 | `NETWORK_ERROR` | 无法连接服务器 | 检查网络连接 |
| `StateError` | 状态错误 | `STATE_ERROR` | 在不允许的状态调用方法 | 检查 capability getter |

#### 3.3.3 ConnectionFailed 状态的 lastErrorCode

进入 `ConnectionFailed` 状态时，`lastErrorCode` 会指明具体原因：

| `lastErrorCode` | 含义 | 应对 |
|----------------|------|------|
| `RECONNECT_EXHAUSTED` | 重连次数耗尽 | 检查网络后 `connect()` 重试 |
| `AUTH_REJECTED` | 服务端拒绝认证（身份失效） | 检查 AID 状态，可能需要 rekey |
| `GATEWAY_UNREACHABLE` | 所有网关都不可达 | 检查 gateway 配置 |
| `TOKEN_INVALID` | Token 被服务端废弃 | 重新走 connect 流程 |

#### 3.3.4 业务操作错误

| 错误类型 | 触发条件 | 错误码 | 说明 | 恢复建议 |
|---------|---------|--------|------|---------|
| `RpcError` | RPC 调用失败 | `RPC_ERROR` | 服务端返回错误 | 检查参数和权限 |
| `TimeoutError` | 超时 | `TIMEOUT_ERROR` | 请求超时 | 检查网络或增加超时时间 |
| `NotReadyError` | 未就绪 | `NOT_READY` | 调用 `call()` 但 `canSend === false` | 检查 `state`，必要时 `connect()` |

---

## 三附、protected_headers 机制

### 概述

`protected_headers` 是消息信封的元数据层，随消息明文传输，**网关和接收方都可见**。它独立于消息 payload，用于路由、过滤、审计等场景。对于 V2 加密消息，SDK 会用消息 master_key 对其 HMAC 签名（`_auth` 字段），接收方可验证未被篡改，但网关仍能读取内容。

### 传输范围

| 场景 | 是否携带 | 网关可见 |
|------|:-------:|:-------:|
| `message.send`（加密，默认） | 是 | 是（envelope 外层） |
| `message.send`（明文） | 是 | 是 |
| `group.send`（加密，默认） | 是 | 是（envelope 外层） |
| `group.send`（明文） | 是 | 是 |
| `message.thought.put` | 是 | 是 |
| `group.thought.put` | 是 | 是 |
| `connect()` / `call()` 普通 RPC | 是（实例默认值） | 是 |

### 字段规范

- 键：只能小写字母、数字、下划线、连字符 `[a-z0-9_-]`
- 值：自动 toString()
- 保留键：`_auth`（SDK 内部 HMAC 签名，不可设置）
- SDK 自动注入：`payload_type`、`sdk_lang`、`sdk_version`

统一使用 `protected_headers`（snake_case），不再支持 `protectedHeaders` / `headers` 别名。

### 设置与读取

```typescript
client.setProtectedHeaders({ 'x-app': 'evolclaw', 'x-channel': 'aun' });  // 设置
client.setProtectedHeaders(null);                                           // 清除
const headers = client.getProtectedHeaders();                               // 读取当前值
```

设置后自动附加到所有 `call()`、`sendV2()`、`sendGroupV2()` 调用，无需在每次调用时传入。

### 接收消息时读取

收到消息后，`protected_headers` 直接挂在消息对象顶层：

```typescript
client.on('message.received', (msg) => {
  // msg.protected_headers — 发送方设置的字段（_auth 已去除）
  const appName = msg.protected_headers?.['x-app'];
  const priority = msg.protected_headers?.['x-priority'];
  
  // msg.payload — 消息内容
  // msg.from    — 发送方 AID
});

client.on('group.message_created', (msg) => {
  const appName = msg.protected_headers?.['x-app'];
  // msg.group_id — 群组 ID
});
```

解密失败时（`message.undecryptable` / `group.message_undecryptable`），`protected_headers` 同样可读（来自 envelope 外层，无需解密）。

---

## 四、完整操作表

### 4.1 AID 操作表

| 分类 | 方法 | 联网? | 前置条件 | 说明 |
|------|------|:----:|---------|------|
| **构造** | `new AID({ aunPath, encryptionSeed })` | 否 | — | 创建 AID 管理器实例 |
| **加载与查询** | `load(aid)` | 视情况 | — | 加载证书 + 私钥（若有） |
| | `register(aid)` | 是 | — | 注册新身份 |
| | `list()` | 否 | — | 列出本地所有有私钥的 AID |
| | `exists(aid)` | 是 | — | HEAD PKI 证书端点，判断 AID 是否已注册 |
| | `resolve(aid)` | 是 | — | 一站式解析对端：下载证书 + 验签 + 下载 agent.md + 验签 |
| **状态判断** | `isCertValid()` | 否 | — | 公钥有效性（链验证 + 有效期） |
| | `isPrivateKeyValid()` | 否 | — | 私钥有效性（有私钥 + 与公钥配对） |
| **密码学** | `verify(payload, sig)` | 否 | `isCertValid()` | 验签任意 payload |
| | `verifyAgentMd(content)` | 否 | `isCertValid()` | 验签 agent.md |
| | `sign(payload)` | 否 | `isPrivateKeyValid()` | 签名任意 payload |
| | `signAgentMd(content)` | 否 | `isPrivateKeyValid()` | 签名 agent.md |
| **agent.md 下载** | `fetchAgentMd()` | 是 | — | 下载 + 自动拉证书 + 验签 |
| | `checkAgentMd(ttl?)` | 是 | — | HEAD 比对 etag |
| | `headAgentMd()` | 是 | — | HEAD 拿元数据 |
| **证书管理** | `renewCert()` | 是 | `isPrivateKeyValid()` | 续签证书 |
| | `rekey()` | 是 | `isPrivateKeyValid()` | 密钥轮换 |
| | `changeSeed(oldSeed, newSeed)` | 否 | — | 更换加密种子 |
| | `diagnose()` | 是 | — | 本地 + 远端状态对比 |

### 4.2 AUNClient 操作表

| 分类 | 方法 | 联网? | 前置状态 | 状态变迁 | 说明 |
|------|------|:----:|---------|----------|------|
| **构造** | `new AUNClient()` | 否 | — | → NoIdentity | 不传身份 |
| | `new AUNClient(aid, opts?)` | 否 | — | → Standby | aid 必须 `isPrivateKeyValid()`；opts: `{deviceId?, slotId?}` |
| **状态推进** | `loadIdentity(aid)` | 否 | NoIdentity \| Closed | → Standby | 加载/重载身份 |
| | `connect({ gateway? })` | 是 | Standby \| Authenticated \| RetryBackoff \| ConnectionFailed | → Connecting / Reconnecting | Standby 时自动先 authenticate |
| | `authenticate()` | 是 | Standby | → Authenticated | 拿 token，不建长连接 |
| | `disconnect()` | 是 | Authenticated \| Connecting \| Ready \| RetryBackoff \| Reconnecting \| ConnectionFailed | → Standby | 主动断开 |
| | `close()` | 否 | * | → Closed | 清除身份 + 资源 |
| **状态查询** | `state` (getter) | 否 | — | — | 当前状态字符串 |
| | `currentAid` (getter) | 否 | hasIdentity | — | 当前本端 AID |
| | `aunPath` (getter) | 否 | hasIdentity | — | 从 currentAid 取 |
| | `nextRetryAt` (getter) | 否 | RetryBackoff | — | 下次重连时间 |
| | `nextRetryInSeconds` (getter) | 否 | RetryBackoff | — | 距下次重连秒数 |
| | `retryAttempt` (getter) | 否 | — | — | 当前重连次数 |
| | `lastError` (getter) | 否 | — | — | 最后一次错误对象 |
| | `lastErrorCode` (getter) | 否 | — | — | 最后一次错误码 |
| | `gatewayHealth` (getter) | 否 | hasIdentity | — | 最近健康检查 |
| | `hasIdentity` (getter) | 否 | — | — | 是否已加载身份 |
| | `canSign` (getter) | 否 | — | — | hasIdentity && 私钥有效 |
| | `canConnect` (getter) | 否 | — | — | hasIdentity 且非 Closed |
| | `canSend` (getter) | 否 | — | — | state === 'ready' |
| | `isReady` (getter) | 否 | — | — | 同 canSend |
| | `isOnline` (getter) | 否 | — | — | ready \| retry-backoff \| reconnecting |
| | `isClosed` (getter) | 否 | — | — | state === 'closed' |
| **对端管理** | `lookupPeer(aid)` | 视缓存 | hasIdentity | — | 查缓存 → 无则解析 |
| | `getPeer(aid)` | 否 | hasIdentity | — | 仅查缓存 |
| | `cachePeer(aid)` | 否 | hasIdentity | — | 加入缓存 |
| | `peers()` | 否 | hasIdentity | — | 列出所有缓存对端 |
| **业务操作** | `call(method, params)` | 是 | Ready | — | 通用 RPC |
| | `on(event, handler)` | 否 | hasIdentity | — | 事件订阅 |
| | `off(event, handler)` | 否 | hasIdentity | — | 取消订阅 |
| **agent.md 上传** | `publishAgentMd(content?)` | 是 | Authenticated \| Connecting \| Ready | — | 签名 + 上传 |
| | `uploadAgentMd(content)` | 是 | Authenticated \| Connecting \| Ready | — | 直接上传已签名内容 |
| **配置** | `setProtectedHeaders(headers)` | 否 | * | — | 设置实例级 protected_headers，传 null 清除，随时可调 |
| | `getProtectedHeaders()` | 否 | * | — | 读取当前实例级 protected_headers |

**事件**：

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| `state-change` | 状态变化 | `{ from, to }` |
| `message.received` | 收到 P2P 消息 | `{ from, payload, protected_headers?, context?, ... }` |
| `group.message_created` | 收到群消息 | `{ from, group_id, payload, protected_headers?, context?, ... }` |
| `message.recalled` | 消息被撤回 | `{ message_id, from, ... }` |
| `message.undecryptable` | P2P 消息解密失败 | `{ from, seq, _decrypt_error, protected_headers?, ... }` |
| `group.message_undecryptable` | 群消息解密失败 | `{ from, group_id, seq, _decrypt_error, protected_headers?, ... }` |
| `token.refreshed` | token 自动续期 | `{ expiresAt }` |
| `gateway.disconnect` | 网关主动断开 | `{ reason, code }` |
| `connection.error` | 连接异常 | `{ error, code }` |

---

## 五、典型场景示例

### 5.1 注册前检查名字是否可用

```typescript
const aid = new AID({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: process.env.ENCRYPTION_SEED || ''
});

const result = await aid.exists('alice.aid.pub');

if (result.exists === false) {
  // 可以注册
  const me = await aid.register('alice.aid.pub');
  console.log('注册成功:', me.aid);
} else if (result.exists === true) {
  console.log('名字已被占用');
} else {
  console.log('网络故障，无法确定');
}
```

**网络开销**：1 次 HEAD（~100ms，零 body）

---

### 5.2 下载对端 agent.md 并验签

```typescript
const aid = new AID({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: ''
});

const result = await aid.fetchAgentMd();

if (result.verification.status === 'verified') {
  console.log('名片有效:', result.content);
  console.log('证书:', result.certPem);
} else {
  console.log('验签失败:', result.verification.reason);
}
```

**网络开销**：
- 本地有证书缓存：1 次 GET agent.md
- 本地无证书缓存：1 次 GET agent.md + 1 次 GET cert（可并行）

---

### 5.3 离线签 agent.md

```typescript
const aid = new AID({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: process.env.ENCRYPTION_SEED || ''
});

const me = await aid.load('alice.aid.pub');

if (me.isPrivateKeyValid()) {
  const content = '---\naid: "alice.aid.pub"\nname: "Alice"\n---';
  const signed = me.signAgentMd(content);
  console.log('签名完成:', signed);
} else {
  console.log('私钥无效，无法签名');
}
```

**改进**：无需构造 client，无需 close，可并发

---

### 5.4 上线发消息

```typescript
const aid = new AID({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: process.env.ENCRYPTION_SEED || ''
});

const me = await aid.load('alice.aid.pub');
const client = new AUNClient(me);

await client.connect();  // 自动完成认证 + 建立连接

if (client.canSend) {
  await client.call('message.send', {
    to: 'bob.aid.pub',
    payload: { text: 'Hello' }
  });
}

await client.close();
```

**改进**：
- `connect()` 自动完成认证（不再需要单独 `authenticate`）
- 不需要手工传 access_token 和 gateway
- 可用 capability getter 检查状态

---

### 5.5 验对端签名（自动拉证书）

```typescript
const aid = new AID({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: ''
});

// 无本地缓存：resolve 自动拉证书 + 验签 agent.md
const { aid: peer } = await aid.resolve('bob.aid.pub');
const result = peer.verifyAgentMd(signedContent);

if (result.status === 'verified') {
  console.log('验签通过:', result.payload);
}
```

---

## 六、设计优势总结

| 维度 | 优势 |
|------|------|
| **性能** | exists 用 HEAD（零 body），fetchAgentMd 自动拉证书（减少往返） |
| **简洁** | 判断方法精简到 2 个，公开 API 最小化 |
| **灵活** | AID 和 AUNClient 正交，按需选择层级 |
| **类型安全** | capability getter 替代字符串比较，编译期检查 |
| **可测试** | AID 是值对象（无副作用），AUNClient 可注入 AID（易 mock） |
| **错误诊断** | 完整的错误状态汇总，明确恢复建议 |
| **状态清晰** | 状态机图 + 转换表 + 可用性矩阵，一目了然 |

---

## 附录：完整 API 迁移对照表

### A.1 AuthNamespace 方法迁移

| 当前方法 | 新归宿 | 迁移状态 |
|---------|--------|:--------:|
| `auth.registerAid({ aid })` | `AID.register(aid)` | ✅ |
| `auth.loadIdentity({ aid })` | `AID.load(aid)` | ✅ |
| `auth.authenticate({ aid })` | `AUNClient.connect()` 内部自动完成 | ✅ |
| `auth.fetchPeerCert({ aid })` | `AID.resolve()` 内部自动完成 | ✅ |
| `auth.signAgentMd(content, { aid })` | `aid.signAgentMd(content)` | ✅ |
| `auth.verifyAgentMd(content, { aid, certPem })` | `aid.verifyAgentMd(content)` | ✅ |
| `auth.uploadAgentMd(content)` | `AUNClient.uploadAgentMd(content)` | ✅ |
| `auth.downloadAgentMd(aid)` | `aid.fetchAgentMd()` | ✅ |
| `auth.headAgentMd(aid)` | `aid.headAgentMd()` | ✅ |
| `auth.checkAid({ aid })` | `aid.diagnose()` | ✅ |
| `auth.renewCert()` | `aid.renewCert()` | ✅ |
| `auth.rekey()` | `aid.rekey()` | ✅ |
| `auth.downloadCert(params)` | `AID.resolve()` 内部自动完成 | ✅ |
| `auth.requestCert(params)` | `AID.register()` 内部自动完成 | ✅ |
| `auth.trustRoots(params)` | `AUNClient.call('meta.trust_roots', params)` | ✅ RPC 透传 |

### A.2 AUNClient 方法迁移

| 当前方法 | 新归宿 | 迁移状态 |
|---------|--------|:--------:|
| `client.connect(auth, opts)` | `AUNClient.connect({ gateway? })` | ✅ |
| `client.disconnect()` | `AUNClient.disconnect()` | ✅ |
| `client.close()` | `AUNClient.close()` | ✅ |
| `client.call(method, params)` | `AUNClient.call(method, params)` | ✅ |
| `client.on(event, handler)` | `AUNClient.on(event, handler)` | ✅ |
| `client.off(event, handler)` | `AUNClient.off(event, handler)` | ✅ |
| `client.ping(params)` | `AUNClient.call('meta.ping', params)` | ✅ RPC 透传 |
| `client.status(params)` | `AUNClient.call('meta.status', params)` | ✅ RPC 透传 |
| `client.trustRoots(params)` | `AUNClient.call('meta.trust_roots', params)` | ✅ RPC 透传 |
| `client.publishAgentMd()` | `AUNClient.publishAgentMd(content?)` | ✅ |
| `client.fetchAgentMd(aid)` | `aid.fetchAgentMd()` / `aid.resolve(aid)` | ✅ |
| `client.checkAgentMd(aid, ttl)` | `aid.checkAgentMd(ttl)` | ✅ |
| `client.checkGatewayHealth(url, timeout)` | `AUNClient.gatewayHealth` getter + 内部自动检查 | ✅ |
| `client.listIdentities()` | `AID.list()` | ✅ |
| `client.setAgentMdPath(path)` | 移除（构造参数） | ✅ 移除 |
| `FileKeyStore.ChangeSeed(root, old, new)` | `AID.changeSeed(oldSeed, newSeed)` | ✅ |
| `FileKeyStore.changeSeed(old, new)` | `AID.changeSeed(oldSeed, newSeed)` | ✅ |
| `client.state` (getter) | `AUNClient.state` (getter) | ✅ |
| `client.aid` (getter) | `AUNClient.currentAid` (getter) | ✅ |
| `client.gatewayHealth` (getter) | `AUNClient.gatewayHealth` (getter) | ✅ |

### A.3 V2 E2EE 方法迁移

| 当前方法 | 新归宿 | 迁移状态 |
|---------|--------|:--------:|
| `client.initV2Session()` | `AUNClient.connect()` 内部自动初始化 | ✅ |
| `client.sendV2(to, payload, opts)` | `AUNClient.call('message.v2.send', {...})` | ✅ RPC 透传 |
| `client.pullV2()` | `AUNClient.call('message.v2.pull', {...})` | ✅ RPC 透传 |
| `client.ackV2(seq)` | `AUNClient.call('message.v2.ack', {...})` | ✅ RPC 透传 |
| `client.sendGroupV2(groupId, payload, opts)` | `AUNClient.call('group.v2.send', {...})` | ✅ RPC 透传 |
| `client.pullGroupV2(groupId)` | `AUNClient.call('group.v2.pull', {...})` | ✅ RPC 透传 |
| `client.ackGroupV2(groupId, seq)` | `AUNClient.call('group.v2.ack', {...})` | ✅ RPC 透传 |

### A.4 Group 方法迁移

| 当前方法 | 新归宿 | 迁移状态 |
|---------|--------|:--------:|
| `client.createNamedGroup(name, opts)` | `AUNClient.call('group.create', {...})` | ✅ RPC 透传 |
| `client.bindGroupAid(groupId, name)` | `AUNClient.call('group.bind_aid', {...})` | ✅ RPC 透传 |

### A.5 CustodyNamespace 方法迁移

| 当前方法 | 新归宿 | 迁移状态 |
|---------|--------|:--------:|
| `custody.setUrl(url)` | 构造参数或配置 | ✅ |
| `custody.configureUrl(url)` | 构造参数或配置 | ✅ |
| `custody.discoverUrl(params)` | 内部自动发现 | ✅ |
| `custody.sendCode(params)` | `AUNClient.call('custody.send_code', {...})` | ✅ RPC 透传 |
| `custody.bindPhone(params)` | `AUNClient.call('custody.bind_phone', {...})` | ✅ RPC 透传 |
| `custody.restorePhone(params)` | `AUNClient.call('custody.restore_phone', {...})` | ✅ RPC 透传 |
| `custody.createDeviceCopy(params)` | `AUNClient.call('custody.create_device_copy', {...})` | ✅ RPC 透传 |
| `custody.uploadDeviceCopyMaterials(params)` | `AUNClient.call('custody.upload_device_copy_materials', {...})` | ✅ RPC 透传 |
| `custody.claimDeviceCopy(params)` | `AUNClient.call('custody.claim_device_copy', {...})` | ✅ RPC 透传 |

### A.6 MetaNamespace 方法迁移

| 当前方法 | 新归宿 | 迁移状态 |
|---------|--------|:--------:|
| `meta.ping(params)` | `AUNClient.call('meta.ping', params)` | ✅ RPC 透传 |
| `meta.status(params)` | `AUNClient.call('meta.status', params)` | ✅ RPC 透传 |
| `meta.trustRoots(params)` | `AUNClient.call('meta.trust_roots', params)` | ✅ RPC 透传 |
| `meta.downloadTrustRoots(opts)` | `AID` 构造时自动下载 / `AUNClient.connect()` 内部处理 | ✅ |
| `meta.verifyTrustRoots(trustList, opts)` | `AID.load()` 内部链验证使用 | ✅ |
| `meta.importTrustRoots(trustList, opts)` | `AID` 构造时自动导入 | ✅ |
| `meta.refreshTrustRoots(opts)` | `AID` 内部按需刷新 | ✅ |
| `meta.downloadIssuerRootCert(issuer, opts)` | `AID.load()` 内部链验证使用 | ✅ |
| `meta.updateIssuerRootCert(issuer, opts)` | `AID` 内部按需更新 | ✅ |

### A.7 新增方法（当前 SDK 无对应）

| 新方法 | 归属 | 说明 |
|--------|------|------|
| `AID.exists(aid)` | AID | HEAD 检查 AID 是否存在 |
| `AID.resolve(aid, opts?)` | AID | 一站式解析对端（证书 + agent.md + 验签） |
| `AUNClient.loadIdentity(aid)` | AUNClient | 加载/重载身份 |
| `AUNClient.lookupPeer(aid)` | AUNClient | 对端管理 |
| `AUNClient.getPeer(aid)` | AUNClient | 查缓存 |
| `AUNClient.cachePeer(aid)` | AUNClient | 加入缓存 |
| `AUNClient.peers()` | AUNClient | 列出缓存对端 |
| `AUNClient.hasIdentity` | AUNClient | 是否已加载身份 |
| `AUNClient.canSign` | AUNClient | 能否签名 |
| `AUNClient.canConnect` | AUNClient | 能否连接 |
| `AUNClient.canSend` | AUNClient | 能否发送 |
| `AUNClient.isReady` | AUNClient | 是否就绪 |
| `AUNClient.isOnline` | AUNClient | 是否在线 |
| `AUNClient.isClosed` | AUNClient | 是否已关闭 |
| `AUNClient.nextRetryAt` | AUNClient | 下次重连时间 |
| `AUNClient.nextRetryInSeconds` | AUNClient | 距下次重连秒数 |
| `AUNClient.retryAttempt` | AUNClient | 当前重连次数 |
| `AUNClient.lastError` | AUNClient | 最后错误对象 |
| `AUNClient.lastErrorCode` | AUNClient | 最后错误码 |

### A.8 迁移统计

| 分类 | 数量 | 迁移方式 |
|------|:----:|---------|
| 迁移到 AID | 12 | 静态/实例方法 |
| 迁移到 AUNClient | 8 | 实例方法 |
| 通过 `call()` RPC 透传 | 20 | 不需要专门封装 |
| 内部自动完成 | 12 | connect/load 内部处理 |
| 移除 | 1 | `setAgentMdPath` |
| 新增 | 18 | 新设计独有 |

**结论**：当前 SDK 的所有公开功能在新设计中都有对应的实现路径。大量 RPC 方法（V2 E2EE、Group、Custody、Meta）通过 `client.call()` 透传，不需要单独封装——这些是协议层方法，SDK 只需提供通道。

---

**文档版本**：v3.2  
**最后更新**：2026-05-28

