# AUN SDK 重构设计方案 v4.0

## 一、设计原则

### 1.1 三主体架构

| 主体 | 职责 | 状态 |
|------|------|------|
| **AIDStore** | keystore 管理器（配置 + 工厂 + 联网管理） | 持有 `aunPath`、`encryptionSeed` |
| **AID** | 单个身份的值对象（证书 + 可选私钥 + 密码学操作） | 不可变 |
| **AUNClient** | 连接 + 会话生命周期 | 有状态机 |

**职责边界**：
- `AIDStore` 创建/加载/注册/解析 AID，**不持有正在使用的身份**——它是工厂，不是会话
- `AID` 加载完成后即不可变；续签/换钥通过 `AIDStore` 完成，调用方重新 `load()` 取新实例
- `AUNClient` 接收已加载的 `AID`（`isPrivateKeyValid() === true`），管理连接状态

### 1.2 核心改进点

1. **AIDStore / AID 拆分**：管理器与值对象分离，`new AIDStore(...)` 持有配置，`AIDStore.load(aid)` 等返回 AID 值对象
2. **结果字典统一**：所有可能失败的方法返回 `{ ok, data?, error? }`，不抛异常（密码学同步操作除外，见 2.7）
3. **AID 不可变**：构造后所有字段只读；renewCert/rekey 在 store 上完成，调用方重新 `load()` 取新实例
4. **AUNClient 身份可重载**：构造时可选传入 AID，也可通过 `loadIdentity()` 加载/重载身份（仅 NoIdentity 或 Closed 状态可调）
5. **判断方法精简**：只保留 2 个核心判断（`isCertValid()` 公钥有效性、`isPrivateKeyValid()` 私钥有效性）
6. **exists 语义明确**：HEAD PKI 证书端点判断 AID 是否注册；`headAgentMd()` 判断名片是否发布
7. **状态机闭环**：AUNClient 状态机支持 close 后重载身份重新使用，连接断开后自动退避重连
8. **实例级 protected_headers**：AUNClient 构造时可设置默认 `protected_headers`，自动附加到所有消息发送和 RPC 调用
9. **多设备/多实例支持**：AIDStore 构造时传入 `deviceId`/`slotId` 构成消费通道，同一 AID 最多 10 设备 × 10 slot 在线

---

## 二、AIDStore 与 AID

### 2.1 AIDStore 构造

```typescript
class AIDStore {
  constructor(opts: {
    aunPath: string;           // 必传：keystore 根目录
    encryptionSeed: string;    // 必传：加密种子（可为空字符串 ''）
    deviceId?: string;         // 默认 getDeviceId()，同一 AID 最多 10 个设备在线
    slotId?: string;           // 默认 'default'，同设备最多 10 个 slot 在线
  });
}
```

**说明**：
- `aunPath` 和 `encryptionSeed` 都是必传参数
- `encryptionSeed` 可以是空字符串 `''`，表示不加密
- 应用层统一管理加密种子，SDK 不持久化
- `deviceId` + `slotId` 构成消费通道，影响 V2 session 密钥存储和消息序号命名空间
- 同一进程内可创建多个 AIDStore 实例（指向不同 keystore 或不同 slot）

**示例**：
```typescript
// 有加密
const store = new AIDStore({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: 'my-secret-seed-from-env',
  deviceId: 'desktop-01',
  slotId: 'default'
});

// 无加密，默认 deviceId/slotId
const store = new AIDStore({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: ''
});
```

---

### 2.2 AIDStore 加载与注册

#### `load(aid: string): Promise<Result<{ aid: AID }>>`

从本地 keystore 加载 AID（证书 + 私钥若有）。

**流程**：
1. 从 `{aunPath}/AIDs/{aid}/public/certs/` 读证书
2. 链验证 + 有效期检查
3. 尝试从 `{aunPath}/AIDs/{aid}/private/key.pem` 读私钥
4. 若有私钥，签名自检（签 → 验）

**返回**：
- 成功（有私钥）→ `{ ok: true, data: { aid: AID } }`（`aid.isPrivateKeyValid() === true`）
- 成功（仅证书）→ `{ ok: true, data: { aid: AID } }`（`aid.isCertValid() === true`，`aid.isPrivateKeyValid() === false`）
- 失败 → `{ ok: false, error: { code, message } }`

**错误码**：`CERT_NOT_FOUND` | `CERT_EXPIRED` | `CERT_CHAIN_BROKEN` | `KEYPAIR_MISMATCH` | `PRIVATE_KEY_PARSE_ERROR`

**示例**：
```typescript
const store = new AIDStore({ aunPath: '...', encryptionSeed: '...' });
const result = await store.load('alice.aid.pub');

if (result.ok) {
  const me = result.data.aid;
  if (me.isPrivateKeyValid()) {
    console.log('本地身份，可签名');
  } else {
    console.log('对端身份，仅可验签');
  }
} else {
  console.log('加载失败:', result.error.code, result.error.message);
}
```

---

#### `register(aid: string): Promise<Result<{ registered: true }>>`

注册新 AID。注册成功后密钥材料落盘，但**不返回 AID 实例**——需后续 `load()` 加载。

**流程**：
1. 生成 keypair
2. 向服务端注册（POST `/auth/register`）
3. 拿到证书
4. 原子落盘（cert + 私钥）

**返回**：
- 成功 → `{ ok: true, data: { registered: true } }`
- 失败 → `{ ok: false, error: { code, message } }`

**错误码**：`IDENTITY_CONFLICT` | `INVALID_AID_FORMAT` | `NETWORK_ERROR` | `SERVER_ERROR`

**示例**：
```typescript
const store = new AIDStore({ aunPath: '...', encryptionSeed: '...' });
const result = await store.register('alice.aid.pub');

if (result.ok) {
  // 注册成功，加载身份
  const loadResult = await store.load('alice.aid.pub');
  const me = loadResult.data!.aid;
} else {
  console.log('注册失败:', result.error.code);
}
```

---

#### `list(): Promise<Result<{ identities: AIDInfo[] }>>`

列出本地所有有私钥的 AID 元信息。

**流程**：
1. 扫描 `{aunPath}/AIDs/` 目录
2. 对每个 AID 读取证书元数据
3. 过滤出有私钥的

**返回**：
```typescript
type AIDInfo = {
  aid: string;
  certNotAfter: Date;
  certIssuer: string;
};

// 成功
{ ok: true, data: { identities: AIDInfo[] } }
```

**示例**：
```typescript
const store = new AIDStore({ aunPath: '...', encryptionSeed: '...' });
const result = await store.list();

if (result.ok) {
  console.log('本地身份:', result.data.identities.map(i => i.aid));
}
```

---

#### `exists(aid: string): Promise<Result<{ exists: boolean }>>`

检查 AID 是否已在网络上注册（PKI 是否签发过证书）。

**流程**：
1. HEAD PKI 证书端点（如 `https://pki.{issuer}/certs/{aid}`）
2. 根据状态码判断

**返回**：
```typescript
// AID 已注册
{ ok: true, data: { exists: true } }
// AID 未注册
{ ok: true, data: { exists: false } }
// 无法判断
{ ok: false, error: { code: 'NETWORK_ERROR', message: '...' } }
```

**特点**：零 body 传输，最快；明确区分"不存在"和"网络故障"

**示例**：
```typescript
const store = new AIDStore({ aunPath: '...', encryptionSeed: '...' });
const result = await store.exists('alice.aid.pub');

if (result.ok) {
  if (result.data.exists) {
    console.log('名字已被占用');
  } else {
    // 可以注册
    await store.register('alice.aid.pub');
  }
} else {
  console.log('网络故障，无法确定');
}
```

---

### 2.3 AIDStore 解析对端

#### `resolve(aid: string, opts?: ResolveOpts): Promise<Result<ResolveData>>`

**一站式解析对端 AID**：下载证书 → 验签证书 → 缓存到本地 → 下载 agent.md → 验签 agent.md。

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
3. **验证证书 + 落盘缓存** — 链验证 + 有效期检查 + 写入 `{aunPath}/AIDs/{aid}/public/certs/`
4. **下载 agent.md** — GET `https://{aid}/agent.md`
5. **验证 agent.md 签名** — 从签名块提取 fingerprint，比对证书 fingerprint，验签

**返回**：
```typescript
type ResolveData = {
  aid: AID;                          // PeerOnly AID 对象
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

// 成功
{ ok: true, data: ResolveData }
// 失败
{ ok: false, error: { code, message } }
```

**错误码**：

| 阶段 | 错误码 | 说明 |
|------|--------|------|
| 证书下载失败（网络） | `NETWORK_ERROR` | 应用层重试 |
| 证书不存在（404） | `CERT_NOT_FOUND` | AID 未注册 |
| 证书链验证失败 | `CERT_CHAIN_BROKEN` | 证书不可信 |
| 证书过期 | `CERT_EXPIRED` | 证书已失效 |
| agent.md 不存在（404） | `AGENTMD_NOT_FOUND` | 对端未发布名片 |

**关键设计原则**：
- 网络/资源不存在 → 返回 `error`（应用层无法继续）
- 内容验证失败（签名 invalid / unsigned）→ 仍 `ok: true`，通过 `data.agentMd.verification.status` 标记，让应用层决定

**示例**：
```typescript
const store = new AIDStore({ aunPath: '...', encryptionSeed: '' });
const result = await store.resolve('bob.aid.pub');

if (result.ok) {
  const { aid: peer, agentMd, source } = result.data;
  console.log('证书来自:', source.certFromCache ? '本地缓存' : '网络下载');

  if (agentMd?.verification.status === 'verified') {
    console.log('名片有效:', agentMd.content);
  } else if (agentMd?.verification.status === 'invalid') {
    console.log('警告：名片签名无效，原因:', agentMd.verification.reason);
  } else {
    console.log('名片未签名');
  }
} else {
  switch (result.error.code) {
    case 'CERT_NOT_FOUND': console.log('AID 未在 PKI 注册'); break;
    case 'AGENTMD_NOT_FOUND': console.log('AID 未发布 agent.md'); break;
    case 'NETWORK_ERROR': console.log('网络故障'); break;
  }
}
```

**网络开销优化**：
- 本地证书缓存命中：1 次 GET agent.md
- 本地无缓存：1 次 GET 证书 + 1 次 GET agent.md（可并行）
- `skipAgentMd: true`：只解析证书，0~1 次网络请求

---

#### `fetchAgentMd(aid: string): Promise<Result<AgentMdFetchData>>`

下载 agent.md + 自动拉证书 + 验签。比 `resolve` 更轻量，适用于"只想拿名片"的场景。

**流程**：
1. GET `https://{aid}/agent.md`
2. 从签名块提取 fingerprint
3. 查证书（本地缓存优先，无则从 PKI 拉）
4. 验签

**返回**：
```typescript
type AgentMdFetchData = {
  content: string;
  verification: {
    status: 'verified' | 'invalid' | 'unsigned';
    reason?: string;
  };
  certPem: string;
};
```

**错误码**：`AGENTMD_NOT_FOUND` | `NETWORK_ERROR`

---

#### `checkAgentMd(aid: string, ttlDays?: number): Promise<Result<AgentMdCheckData>>`

比对本地缓存与远端 etag，决定是否需要重新拉取。

**返回**：
```typescript
type AgentMdCheckData = {
  needsUpdate: boolean;
  localEtag?: string;
  remoteEtag?: string;
  lastModified?: string;
};
```

---

#### `headAgentMd(aid: string): Promise<Result<AgentMdHeadData>>`

HEAD 请求拿 agent.md 元数据，**判断对端是否发布了名片**。

**返回**：
```typescript
type AgentMdHeadData = {
  etag: string;
  lastModified: string;
  contentLength: number;
};
```

**错误码**：`AGENTMD_NOT_FOUND`（对端未发布名片）| `NETWORK_ERROR`

---

### 2.4 AIDStore 证书运维

| 方法 | 联网 | 说明 |
|------|:----:|------|
| `renewCert(aid)` | 是 | 续签证书并落盘，调用方需重新 `load()` 取新实例 |
| `rekey(aid)` | 是 | 密钥轮换：生成新 keypair → 服务端换证书 → 落盘，调用方需重新 `load()` |
| `changeSeed(oldSeed, newSeed)` | 否 | 更换加密种子：用旧种子解密所有私钥 → 用新种子重新加密 → 落盘 |
| `diagnose(aid)` | 是 | 本地状态 + 远端注册状态对比 |

所有方法返回 `Promise<Result<T>>`：

```typescript
// renewCert 成功
{ ok: true, data: { renewed: true, newCertNotAfter: Date } }

// rekey 成功
{ ok: true, data: { rekeyed: true, newFingerprint: string } }

// changeSeed 成功
{ ok: true, data: { changed: true, count: number } }  // 重新加密的私钥数量

// diagnose 成功
{
  ok: true,
  data: {
    localValid: boolean;
    remoteRegistered: boolean;
    certMatch: boolean;
    suggestions: string[];
  }
}
```

**错误码**：
- `renewCert`: `CERT_RENEWAL_FAILED` | `PRIVATE_KEY_REQUIRED` | `NETWORK_ERROR`
- `rekey`: `REKEY_FAILED` | `PRIVATE_KEY_REQUIRED` | `NETWORK_ERROR`
- `changeSeed`: `PRIVATE_KEY_PARSE_ERROR`（旧种子错误）

**示例**：
```typescript
const store = new AIDStore({ aunPath, encryptionSeed: 'old-seed' });

// 续签
const renewResult = await store.renewCert('alice.aid.pub');
if (renewResult.ok) {
  // 重新加载拿新证书
  const me = (await store.load('alice.aid.pub')).data!.aid;
  console.log('新证书有效期至:', me.certNotAfter);
}

// 换加密种子
const seedResult = await store.changeSeed('old-seed', 'new-seed');
if (seedResult.ok) {
  console.log(`已重新加密 ${seedResult.data.count} 个私钥`);
}
```

---

### 2.5 AID 类（值对象）

AID 是不可变的身份值对象，由 AIDStore 创建，外部不直接 `new AID()`。

#### 只读属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `aid` | string | AID 标识符（如 `'alice.aid.pub'`） |
| `aunPath` | string | keystore 根目录（来自创建它的 store） |
| `certPem` | string | PEM 格式证书 |
| `publicKey` | string | DER base64 公钥 |
| `certSubject` | string | 证书 subject |
| `certNotBefore` | Date | 证书生效时间 |
| `certNotAfter` | Date | 证书过期时间 |
| `certIssuer` | string | 证书颁发者 |
| `certFingerprint` | string | sha256 指纹 |

---

### 2.6 AID 状态判断

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

---

### 2.7 AID 密码学操作

所有方法**同步**返回结果字典：

| 方法 | 前置条件 | 返回 |
|------|---------|------|
| `verify(payload, signature)` | `isCertValid()` | `Result<{ valid: boolean }>` |
| `verifyAgentMd(content)` | `isCertValid()` | `Result<VerifyResult>` |
| `sign(payload)` | `isPrivateKeyValid()` | `Result<{ signature: string }>` |
| `signAgentMd(content)` | `isPrivateKeyValid()` | `Result<{ signed: string }>` |

**类型定义**：
```typescript
type VerifyResult = {
  status: 'verified' | 'invalid' | 'unsigned';
  payload?: string;  // 去除签名块后的原始内容
  reason?: string;
};
```

**错误码**：
- `verify` / `verifyAgentMd`：`CERT_NOT_VALID`（前置条件不满足）| `VERIFICATION_OPERATION_ERROR`
- `sign` / `signAgentMd`：`PRIVATE_KEY_NOT_VALID`（前置条件不满足）| `SIGNATURE_OPERATION_ERROR`

**示例**：
```typescript
// 签名
const me = (await store.load('alice.aid.pub')).data!.aid;
const signResult = me.signAgentMd(content);
if (signResult.ok) {
  const signed = signResult.data.signed;
}

// 验签
const peer = (await store.resolve('bob.aid.pub')).data!.aid;
const verifyResult = peer.verifyAgentMd(signed);
if (verifyResult.ok && verifyResult.data.status === 'verified') {
  console.log('验签通过:', verifyResult.data.payload);
}
```

---

### 2.8 结果字典统一格式

所有可能失败的方法（包括 AIDStore 联网方法和 AID 同步密码学方法）返回统一格式：

```typescript
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; cause?: unknown } };
```

**约定**：
- 永远返回 Result，不抛异常（除非是真正的程序错误，如类型不匹配）
- `error.code` 是字符串错误码（见 2.10 错误码汇总）
- `error.message` 是人类可读消息
- `error.cause` 可选，包装底层异常

**TypeScript 使用模式**：
```typescript
const result = await store.load('alice.aid.pub');
if (!result.ok) {
  // 处理错误
  console.log(result.error.code, result.error.message);
  return;
}
// 之后 result.data 类型已收窄为 { aid: AID }
const me = result.data.aid;
```

---

### 2.9 使用场景对照表

| 场景 | 推荐方法 | 一行代码示例 |
|------|---------|--------------|
| 检查 AID 名字是否可注册 | `store.exists(aid)` | `(await store.exists('alice.aid.pub')).data?.exists === false` |
| 注册新身份 | `store.register` + `store.load` | `await store.register('alice.aid.pub'); await store.load('alice.aid.pub')` |
| 加载本地身份 | `store.load(aid)` | `(await store.load('alice.aid.pub')).data!.aid` |
| 列出本地所有身份 | `store.list()` | `(await store.list()).data!.identities` |
| **一站式解析对端**（推荐）| `store.resolve(aid)` | `const { aid: peer, agentMd } = (await store.resolve('bob')).data!` |
| 只想拿对端 agent.md | `store.fetchAgentMd(aid)` | `(await store.fetchAgentMd('bob.aid.pub')).data?.content` |
| 离线签名 agent.md | `load` → `signAgentMd` | `me.signAgentMd(content).data?.signed` |
| 离线验签 agent.md | `load`/`resolve` → `verifyAgentMd` | `peer.verifyAgentMd(signed).data?.status` |
| 检查证书是否即将过期 | `load` + `certNotAfter` | `me.certNotAfter` |
| 证书即将过期，续签 | `store.renewCert(aid)` | `await store.renewCert('alice.aid.pub')` |
| 密钥泄漏，换密钥 | `store.rekey(aid)` | `await store.rekey('alice.aid.pub')` |
| 检查本地+远端一致性 | `store.diagnose(aid)` | `(await store.diagnose('alice.aid.pub')).data` |
| 验证某段 payload 的签名 | `peer.verify(payload, sig)` | `peer.verify(payload, signature).data?.valid` |
| 用本地私钥签 payload | `me.sign(payload)` | `me.sign(payload).data?.signature` |

#### 关键场景详解

**场景 A：未知对端，建立信任**

```typescript
const store = new AIDStore({ aunPath, encryptionSeed: '' });
const result = await store.resolve('bob.aid.pub');

if (result.ok && result.data.agentMd?.verification.status === 'verified') {
  console.log('对端可信:', result.data.agentMd.content);
}
```

**场景 B：已知对端（证书已缓存），快速验签**

```typescript
const store = new AIDStore({ aunPath, encryptionSeed: '' });
const peer = (await store.load('bob.aid.pub')).data?.aid;

if (peer?.isCertValid()) {
  const r = peer.verifyAgentMd(content);
  if (r.ok) console.log(r.data.status);
}
```

**场景 C：注册新身份流程（健壮）**

```typescript
const store = new AIDStore({ aunPath, encryptionSeed: process.env.SEED || '' });

// Step 1: 检查名字是否可用
const check = await store.exists('alice.aid.pub');
if (!check.ok) {
  throw new Error('网络故障，无法确定');
}
if (check.data.exists) {
  throw new Error('名字已被占用');
}

// Step 2: 注册（仅落盘，不加载）
const reg = await store.register('alice.aid.pub');
if (!reg.ok) {
  throw new Error(`注册失败: ${reg.error.code}`);
}

// Step 3: 加载身份用于后续操作
const load = await store.load('alice.aid.pub');
const me = load.data!.aid;
```

**场景 D：批量加载本地身份（并发安全）**

```typescript
const store = new AIDStore({ aunPath, encryptionSeed: '' });
const list = await store.list();
if (!list.ok) return;

// 并发加载多个 AID 实例
const aids = await Promise.all(
  list.data.identities.map(i => store.load(i.aid).then(r => r.data!.aid))
);

// 并发签名
const signatures = aids.map(me => me.signAgentMd(content));
```

---

### 2.10 错误码汇总

所有错误以 `error.code` 形式返回，不再以 Error 类抛出。

#### 2.10.1 加载阶段（store.load）

| 错误码 | 触发条件 | 恢复建议 |
|--------|---------|---------|
| `CERT_NOT_FOUND` | 证书文件不存在 | 1. 检查 aid 拼写<br>2. `store.register()` 注册<br>3. `store.resolve()` 拉对端证书 |
| `CERT_PARSE_ERROR` | 证书 PEM 格式损坏 | 删除损坏文件，重新拉取 |
| `CERT_EXPIRED` | 证书已过期 | `store.renewCert(aid)` |
| `CERT_NOT_YET_VALID` | 证书未生效 | 检查系统时间 |
| `CERT_CHAIN_BROKEN` | 证书链验证失败 | 1. 更新根证书缓存<br>2. 检查 PKI 配置 |
| `KEYPAIR_MISMATCH` | 私钥与公钥不配对（自检失败） | 1. 私钥损坏，删除重新生成<br>2. 重新拉取证书 |
| `PRIVATE_KEY_PARSE_ERROR` | 私钥 PEM 格式损坏或解密失败 | 1. 检查 `encryptionSeed` 是否正确<br>2. 删除重新生成 |

#### 2.10.2 注册阶段（store.register）

| 错误码 | 触发条件 | 恢复建议 |
|--------|---------|---------|
| `IDENTITY_CONFLICT` | AID 已被占用（409） | 换名字 |
| `INVALID_AID_FORMAT` | 不符合 `{name}.{issuer}` 格式 | 检查 AID 格式 |
| `NETWORK_ERROR` | 无法连接服务端 | 检查网络 |
| `SERVER_ERROR` | 服务端 5xx | 稍后重试 |

#### 2.10.3 agent.md / 证书下载阶段（store.fetchAgentMd / resolve / headAgentMd）

| 错误码 | 触发条件 | 恢复建议 |
|--------|---------|---------|
| `AGENTMD_NOT_FOUND` | agent.md 不存在（404） | 该 AID 未发布名片 |
| `AGENTMD_PARSE_ERROR` | YAML frontmatter 解析失败 | 联系 AID 所有者修复 |
| `SIGNATURE_NOT_FOUND` | agent.md 未签名 | 该名片不可信（也可能 `verification.status='unsigned'` 形式返回） |
| `SIGNATURE_INVALID` | 签名验证失败 | 该名片已被篡改（也可能 `verification.status='invalid'` 形式返回） |
| `CERT_FINGERPRINT_MISMATCH` | 签名块中 fingerprint 与证书不符 | 证书与签名不对应 |
| `NETWORK_ERROR` | 无法连接 | 检查网络 |

#### 2.10.4 证书运维阶段（store.renewCert / rekey）

| 错误码 | 触发条件 | 恢复建议 |
|--------|---------|---------|
| `CERT_RENEWAL_FAILED` | 服务端拒绝续签 | 检查 AID 状态，可能需要 rekey |
| `REKEY_FAILED` | 服务端拒绝换证书 | 联系服务端管理员 |
| `PRIVATE_KEY_REQUIRED` | 没有本地私钥，无法执行 | 该操作需要本地身份 |

#### 2.10.5 密码学操作（aid.sign / verify / signAgentMd / verifyAgentMd）

| 错误码 | 触发条件 | 恢复建议 |
|--------|---------|---------|
| `SIGNATURE_OPERATION_ERROR` | 签名操作失败 | 检查私钥完整性 |
| `VERIFICATION_OPERATION_ERROR` | 验签操作失败 | 检查证书完整性 |
| `CERT_NOT_VALID` | `verify()` 但 `isCertValid() === false` | 先检查 `isCertValid()` |
| `PRIVATE_KEY_NOT_VALID` | `sign()` 但 `isPrivateKeyValid() === false` | 先检查 `isPrivateKeyValid()` |

---

### 2.11 加载诊断流程

```
store.load(aid)
  │
  ├─ 证书存在？
  │  ├─ 否 → { ok: false, error: { code: 'CERT_NOT_FOUND' } }
  │  └─ 是 ↓
  │
  ├─ 证书可解析？
  │  ├─ 否 → { ok: false, error: { code: 'CERT_PARSE_ERROR' } }
  │  └─ 是 ↓
  │
  ├─ 证书在有效期内？
  │  ├─ 否 → { ok: false, error: { code: 'CERT_EXPIRED' / 'CERT_NOT_YET_VALID' } }
  │  └─ 是 ↓
  │
  ├─ 证书链验证通过？
  │  ├─ 否 → { ok: false, error: { code: 'CERT_CHAIN_BROKEN' } }
  │  └─ 是 ↓
  │
  ├─ → AID 实例 isCertValid() = true
  │
  ├─ 私钥存在？
  │  ├─ 否 → { ok: true, data: { aid } }（PeerOnly，仅能验签）
  │  └─ 是 ↓
  │
  ├─ 私钥可解析？
  │  ├─ 否 → { ok: false, error: { code: 'PRIVATE_KEY_PARSE_ERROR' } }
  │  └─ 是 ↓
  │
  ├─ 私钥与公钥配对？（签名自检）
  │  ├─ 否 → { ok: false, error: { code: 'KEYPAIR_MISMATCH' } }
  │  └─ 是 ↓
  │
  └─ → AID 实例 isPrivateKeyValid() = true
     { ok: true, data: { aid } }（Local，能签能验）
```

---

## 三、AUNClient 类（AID 状态）

### 3.1 构造方法与身份加载

```typescript
class AUNClient {
  constructor(aid?: AID);
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
- `deviceId` + `slotId` 由 AIDStore 管理，AUNClient 通过 AID 实例间接获取
- `setProtectedHeaders(headers)` 随时可调，传 `null` 清除；设置后自动附加到所有 `call()`、`sendV2()`、`sendGroupV2()` 调用，无需在每次调用时传入

**示例**：
```typescript
const store = new AIDStore({ aunPath: '...', encryptionSeed: '...' });
const me = (await store.load('alice.aid.pub')).data!.aid;
const client = new AUNClient(me);

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
const store = new AIDStore({ aunPath: '...', encryptionSeed: '...' });
const me = (await store.load('alice.aid.pub')).data!.aid;
const client = new AUNClient(me);   // → Standby
await client.connect();             // Standby → Authenticated → Connecting → Ready
// connect() 内部自动完成 authenticate（如果还没有 token）
```

**场景 2：只想上传 agent.md，不需要长连接**

```typescript
const store = new AIDStore({ aunPath: '...', encryptionSeed: '...' });
const me = (await store.load('alice.aid.pub')).data!.aid;
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
const signed = client.currentAid!.signAgentMd(content).data!.signed;
// 想再次上线
await client.connect();     // Standby → Authenticated → Connecting → Ready
```

**场景 7：换个身份继续用**

```typescript
await client.close();                    // → Closed（身份清除）
const newMe = (await store.load('bob.aid.pub')).data!.aid;
client.loadIdentity(newMe);              // Closed → Standby（新身份）
await client.connect();                  // → Authenticated → Connecting → Ready
```

**场景 8：预热 token**

```typescript
// 应用启动时，预先认证以减少后续连接延迟
const store = new AIDStore({ aunPath: '...', encryptionSeed: '...' });
const me = (await store.load('alice.aid.pub')).data!.aid;
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
  client.loadIdentity((await store.load('alice.aid.pub')).data!.aid);
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

### 4.1 AIDStore 操作表

| 分类 | 方法 | 联网? | 说明 |
|------|------|:----:|------|
| **构造** | `new AIDStore({ aunPath, encryptionSeed })` | 否 | 创建 keystore 管理器 |
| **加载与注册** | `load(aid)` | 否 | 从 keystore 加载 AID 实例 |
| | `register(aid)` | 是 | 注册新身份并落盘（不返回 AID 实例） |
| | `list()` | 否 | 列出本地所有有私钥的 AID 元信息 |
| | `exists(aid)` | 是 | HEAD PKI 证书端点，判断 AID 是否已注册 |
| **解析对端** | `resolve(aid, opts?)` | 是 | 一站式解析对端：拉证书 + 缓存 + 拉 agent.md + 验签 |
| | `fetchAgentMd(aid)` | 是 | 下载 agent.md + 自动拉证书 + 验签 |
| | `checkAgentMd(aid, ttl?)` | 是 | HEAD 比对 etag |
| | `headAgentMd(aid)` | 是 | HEAD 拿 agent.md 元数据 |
| **证书运维** | `renewCert(aid)` | 是 | 续签证书并落盘 |
| | `rekey(aid)` | 是 | 密钥轮换并落盘 |
| | `changeSeed(oldSeed, newSeed)` | 否 | 更换加密种子 |
| | `diagnose(aid)` | 是 | 本地 + 远端状态对比 |

### 4.2 AID 操作表

| 分类 | 方法/属性 | 说明 |
|------|----------|------|
| **只读属性** | `aid` `certPem` `publicKey` `certSubject` `certNotBefore` `certNotAfter` `certIssuer` `certFingerprint` `aunPath` | 身份元数据 |
| **状态判断** | `isCertValid()` | 公钥有效性（链验证 + 有效期） |
| | `isPrivateKeyValid()` | 私钥有效性（有私钥 + 与公钥配对） |
| **密码学** | `verify(payload, sig)` | 验签任意 payload |
| | `verifyAgentMd(content)` | 验签 agent.md |
| | `sign(payload)` | 签名任意 payload |
| | `signAgentMd(content)` | 签名 agent.md |

### 4.3 AUNClient 操作表

| 分类 | 方法 | 联网? | 前置状态 | 状态变迁 | 说明 |
|------|------|:----:|---------|----------|------|
| **构造** | `new AUNClient()` | 否 | — | → NoIdentity | 不传身份 |
| | `new AUNClient(aid)` | 否 | — | → Standby | aid 必须 `isPrivateKeyValid()` |
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
const store = new AIDStore({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: process.env.ENCRYPTION_SEED || ''
});

const result = await store.exists('alice.aid.pub');

if (result.ok) {
  if (!result.data.exists) {
    // 可以注册
    const reg = await store.register('alice.aid.pub');
    if (reg.ok) console.log('注册成功');
  } else {
    console.log('名字已被占用');
  }
} else {
  console.log('网络故障，无法确定');
}
```

**网络开销**：1 次 HEAD（~100ms，零 body）

---

### 5.2 下载对端 agent.md 并验签

```typescript
const store = new AIDStore({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: ''
});

const result = await store.fetchAgentMd('bob.aid.pub');

if (result.ok) {
  if (result.data.verification.status === 'verified') {
    console.log('名片有效:', result.data.content);
  } else {
    console.log('验签失败:', result.data.verification.reason);
  }
} else {
  console.log('下载失败:', result.error.code);
}
```

**网络开销**：
- 本地有证书缓存：1 次 GET agent.md
- 本地无证书缓存：1 次 GET agent.md + 1 次 GET cert（可并行）

---

### 5.3 离线签 agent.md

```typescript
const store = new AIDStore({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: process.env.ENCRYPTION_SEED || ''
});

const loadResult = await store.load('alice.aid.pub');
if (!loadResult.ok) {
  console.log('加载失败:', loadResult.error.code);
  return;
}

const me = loadResult.data.aid;
if (me.isPrivateKeyValid()) {
  const content = '---\naid: "alice.aid.pub"\nname: "Alice"\n---';
  const signResult = me.signAgentMd(content);
  if (signResult.ok) {
    console.log('签名完成:', signResult.data.signed);
  }
} else {
  console.log('私钥无效，无法签名');
}
```

---

### 5.4 上线发消息

```typescript
const store = new AIDStore({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: process.env.ENCRYPTION_SEED || ''
});

const me = (await store.load('alice.aid.pub')).data!.aid;
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

---

### 5.5 验对端签名（自动拉证书）

```typescript
const store = new AIDStore({
  aunPath: '/home/user/.evolclaw/aun',
  encryptionSeed: ''
});

// 无本地缓存：resolve 自动拉证书 + 缓存
const resolveResult = await store.resolve('bob.aid.pub');
if (!resolveResult.ok) {
  console.log('解析失败:', resolveResult.error.code);
  return;
}

const peer = resolveResult.data.aid;
const verifyResult = peer.verifyAgentMd(signedContent);
if (verifyResult.ok && verifyResult.data.status === 'verified') {
  console.log('验签通过:', verifyResult.data.payload);
}
```

---

## 六、设计优势总结

| 维度 | 优势 |
|------|------|
| **职责清晰** | AIDStore（管理器）/ AID（值对象）/ AUNClient（连接）三者正交 |
| **错误处理** | 统一 Result 字典，不抛异常，TypeScript 类型收窄友好 |
| **性能** | exists 用 HEAD（零 body），resolve 自动缓存证书 |
| **简洁** | 判断方法精简到 2 个，公开 API 最小化 |
| **不可变** | AID 加载后不可变，可安全并发使用 |
| **类型安全** | capability getter 替代字符串比较，编译期检查 |
| **可测试** | AID 是值对象（无副作用），AUNClient 可注入 AID（易 mock） |
| **状态清晰** | 状态机图 + 转换表 + 可用性矩阵，一目了然 |

---

## 附录：完整 API 迁移对照表

### A.1 AuthNamespace 方法迁移

| 当前方法 | 新归宿 | 迁移状态 |
|---------|--------|:--------:|
| `auth.registerAid({ aid })` | `AIDStore.register(aid)` | ✅ |
| `auth.loadIdentity({ aid })` | `AIDStore.load(aid)` | ✅ |
| `auth.authenticate({ aid })` | `AUNClient.connect()` 内部自动完成 | ✅ |
| `auth.fetchPeerCert({ aid })` | `AIDStore.resolve()` 内部自动完成 | ✅ |
| `auth.signAgentMd(content, { aid })` | `aid.signAgentMd(content)` | ✅ |
| `auth.verifyAgentMd(content, { aid, certPem })` | `aid.verifyAgentMd(content)` | ✅ |
| `auth.uploadAgentMd(content)` | `AUNClient.uploadAgentMd(content)` | ✅ |
| `auth.downloadAgentMd(aid)` | `AIDStore.fetchAgentMd(aid)` | ✅ |
| `auth.headAgentMd(aid)` | `AIDStore.headAgentMd(aid)` | ✅ |
| `auth.checkAid({ aid })` | `AIDStore.diagnose(aid)` | ✅ |
| `auth.renewCert()` | `AIDStore.renewCert(aid)` | ✅ |
| `auth.rekey()` | `AIDStore.rekey(aid)` | ✅ |
| `auth.downloadCert(params)` | `AIDStore.resolve()` 内部自动完成 | ✅ |
| `auth.requestCert(params)` | `AIDStore.register()` 内部自动完成 | ✅ |
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
| `client.fetchAgentMd(aid)` | `AIDStore.fetchAgentMd(aid)` / `AIDStore.resolve(aid)` | ✅ |
| `client.checkAgentMd(aid, ttl)` | `AIDStore.checkAgentMd(aid, ttl)` | ✅ |
| `client.checkGatewayHealth(url, timeout)` | `AUNClient.gatewayHealth` getter + 内部自动检查 | ✅ |
| `client.listIdentities()` | `AIDStore.list()` | ✅ |
| `client.setAgentMdPath(path)` | 移除（构造参数） | ✅ 移除 |
| `FileKeyStore.ChangeSeed(root, old, new)` | `AIDStore.changeSeed(oldSeed, newSeed)` | ✅ |
| `FileKeyStore.changeSeed(old, new)` | `AIDStore.changeSeed(oldSeed, newSeed)` | ✅ |
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
| `meta.downloadTrustRoots(opts)` | `AIDStore` 构造时自动下载 / `AUNClient.connect()` 内部处理 | ✅ |
| `meta.verifyTrustRoots(trustList, opts)` | `AIDStore.load()` 内部链验证使用 | ✅ |
| `meta.importTrustRoots(trustList, opts)` | `AIDStore` 构造时自动导入 | ✅ |
| `meta.refreshTrustRoots(opts)` | `AIDStore` 内部按需刷新 | ✅ |
| `meta.downloadIssuerRootCert(issuer, opts)` | `AIDStore.load()` 内部链验证使用 | ✅ |
| `meta.updateIssuerRootCert(issuer, opts)` | `AIDStore` 内部按需更新 | ✅ |

### A.7 新增方法（当前 SDK 无对应）

| 新方法 | 归属 | 说明 |
|--------|------|------|
| `new AIDStore({ aunPath, encryptionSeed })` | AIDStore | keystore 管理器 |
| `AIDStore.exists(aid)` | AIDStore | HEAD 检查 AID 是否存在 |
| `AIDStore.resolve(aid, opts?)` | AIDStore | 一站式解析对端（证书 + agent.md + 验签） |
| `AIDStore.list()` | AIDStore | 列出本地身份元信息 |
| `AIDStore.diagnose(aid)` | AIDStore | 本地+远端一致性诊断 |
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
| 迁移到 AIDStore | 12 | 实例方法 |
| 迁移到 AID（值对象） | 4 | 密码学操作 |
| 迁移到 AUNClient | 8 | 实例方法 |
| 通过 `call()` RPC 透传 | 20 | 不需要专门封装 |
| 内部自动完成 | 12 | connect/load 内部处理 |
| 移除 | 1 | `setAgentMdPath` |
| 新增 | 22 | 新设计独有（含 AIDStore 本身） |

**结论**：当前 SDK 的所有公开功能在新设计中都有对应的实现路径。大量 RPC 方法（V2 E2EE、Group、Custody、Meta）通过 `client.call()` 透传，不需要单独封装——这些是协议层方法，SDK 只需提供通道。

---

**文档版本**：v4.0  
**最后更新**：2026-05-28

