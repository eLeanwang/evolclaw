# fastaun SDK 架构调整方案：以 AID 为中心

**版本**: 草案 v1.0  
**日期**: 2026-05-31  
**背景**: fastaun 0.4.3 中发现 encryptionSeed 传递链断裂（AIDStore→AID→AUNClient），
导致 AUNClient 内部 keystore 用空 seed 无法解密私钥。
本方案借此机会系统性修正架构，而不是打补丁。

---

## 一、当前架构的问题

### 1.1 数据多份拷贝，事实来源不唯一

```
AIDStore._encryptionSeed   (1份)
  ↓ 漏传
AID (无此字段)
  ↓
AUNClient._configModel.seedPassword = null  (空)
AUNClient._keystore (用空 seed 初始化)      (错误的1份)
```

同样的问题存在于其他配置参数（aunPath、deviceId、slotId、verifySsl、rootCaPath、debug），
它们在 AIDStore、AID、AUNClient._configModel 三处各存一份，靠手动同步，容易漂移。

### 1.2 密码学操作分散，没有统一入口

当前密码学/证书持久化操作实际分散在三处，**AID 不是中间通道，也不引用 AIDStore**：

| 操作 | 实际执行者 |
|------|-----------|
| 私钥加密写磁盘 | `FileKeyStore.saveKeyPair()` → `_secretStore.protect()` |
| 私钥解密读磁盘 | `FileKeyStore._restoreKeyPair()` → `_secretStore.reveal()` |
| 登录签名 | `AuthFlow` 直接取 `identity.private_key_pem` 传给 `_crypto.signLoginNonce()` |
| keypair 自检签名 | `AIDStore.load()` 直接调 `signBytes(privPem, probe)` |
| cert 持久化 | `AIDStore._keystore.saveCert()` / `FileKeyStore.saveCert()` |
| agent.md 签名/验签 | **AID 实例**（已正确实现） |

agent.md 签名/验签已经走 AID，其余操作绕过了 AID 直接操作私钥，职责不清。

### 1.3 AID 不应引用 AIDStore

一个可能的误解：让 AID 通过引用 AIDStore 来完成密码学操作。

**这是错误的**，原因：
- AIDStore 有状态（持有 keystore、网络连接、缓存），AID 引用它就变成有状态对象
- AIDStore 生命周期比 AID 短（用完即 close），AID 持有其引用会造成悬空引用
- 循环依赖：AIDStore 构造 AID，AID 又引用 AIDStore

**正确做法**：AID 内部持有 `FileSecretStore`（无状态，纯加解密），独立完成所有密码学操作，不依赖任何外部对象。这与 agent.md 签名/验签的现有实现一致（AID 持有私钥 PEM，直接签名，不回调 AIDStore）。

### 1.3 AUNClient 重复解密私钥

`AUNClient` 构造时已从 `inputAid._privateKeyPem` 拿到明文私钥（存入 `this._identity`），
但 `authenticate()` 调 `_loadIdentityOrRaise()` 时重新走 keystore 从磁盘解密，
完全无视内存中已有的明文，导致空 seed 解密失败。

---

## 二、目标架构

```
AIDStore（配置入口）
  │  构造时注入所有参数
  ▼
AID（唯一事实来源）
  │  持有：aunPath / deviceId / slotId / verifySsl / rootCaPath / debug / encryptionSeed
  │  提供：所有密码学操作（sign / verify / encryptField / decryptField）
  │  性质：无状态值对象（encryptionSeed → masterKey 是确定性派生，不需持久化）
  │
  ├─ 通过引用传给 AUNClient
  │
  ▼
AUNClient（连接状态机）
  │  持有 AID 引用，配置参数从 AID 读，不做副本
  │  职责：维护连接状态（connecting/ready/closed/...）
  │
  ▼
FileKeyStore（状态持久化）
  │  持有 AID 引用
  │  职责：token / instance_state / group_state / cert 的存取
  │  密码学操作：委托给 AID 实例
  │  不持有 encryptionSeed，不持有 _secretStore
  ▼
AIDDatabase（SQLite，per-AID）
  │  持有 AID 引用
  │  group 私钥加解密委托给 AID
```

**核心原则**：
- AID 是唯一事实来源，所有组件通过引用读取，不做副本
- 密码学操作（私钥加解密、签名、验签）只在 AID 内部发生
- keystore 只管"存什么"，不管"怎么加密"

---

## 三、各组件改动清单

### 3.1 AID（aid.js）— 新增密码学方法

**新增字段**：
```
encryptionSeed: string   // 从 AIDStore 传入，内部派生 masterKey
```

**新增方法**（替代 FileSecretStore 的 protect/reveal）：
```
encryptField(scope: string, name: string, plaintext: Buffer): EncryptedRecord
decryptField(scope: string, name: string, rec: EncryptedRecord): Buffer | null
```

- `encryptField` / `decryptField` 内部用 encryptionSeed 派生 masterKey，逻辑与现有 FileSecretStore 完全一致
- AID 不暴露 encryptionSeed 本身，只暴露加解密方法
- masterKey 在构造时一次性派生，之后只读，保持无状态

**已有方法保持不变**：`sign()` / `verify()` / `signAgentMd()` / `verifyAgentMd()`

---

### 3.2 AIDStore（aid-store.js）— 传 encryptionSeed 给 AID

**改动**：两处 `AID._create()` 调用补传 `encryptionSeed`

```js
// 改前（aid-store.js:163 和 :194）
AID._create({ aid, aunPath, certPem, ..., debug })

// 改后
AID._create({ aid, aunPath, certPem, ..., debug, encryptionSeed: this._encryptionSeed })
```

AIDStore 自身的 `_keystore`（FileKeyStore）也改为传入 AID 实例（见 3.4）。

---

### 3.3 AUNClient（client.js）— 以 AID 引用为配置来源

**改动 1**：构造时不再从 inputAid 手动复制字段到 rawConfig，直接持有 AID 引用

```js
// 改前：手动复制 4 个字段
rawConfig.aun_path = inputAid.aunPath;
rawConfig.verify_ssl = inputAid.verifySsl;
rawConfig.root_ca_path = inputAid.rootCaPath;
rawConfig.debug = inputAid.debug;

// 改后：AID 就是配置来源，rawConfig 从 AID 读
// configModel 可以保留作为内部缓存，但以 AID 为准
```

**改动 2**：keystore 构造时传入 AID 实例

```js
// 改前
const keystore = new FileKeyStore(aunPath, { encryptionSeed: seedPassword });

// 改后
const keystore = new FileKeyStore(aunPath, { aid: inputAid });
```

**改动 3**：`authenticate()` 优先用 `this._identity`（构造时已从 AID 拿到明文私钥）

```js
// _loadIdentityOrRaise() 里，如果 this._identity 已有完整 private_key_pem，直接返回
// 不走 keystore.loadIdentity() 重新解密
```

**移除**：`rawConfig.seed_password` / `configModel.seedPassword` 不再需要

---

### 3.4 FileKeyStore（keystore/file.js）— 委托密码学给 AID

**改动 1**：构造函数接受 `aid` 实例替代 `encryptionSeed`

```js
// 改前
constructor(root, opts) {
  this._secretStore = createDefaultSecretStore(root, opts.encryptionSeed, ...);
}

// 改后
constructor(root, opts) {
  this._aid = opts.aid;  // 持有引用，不做副本
  // 不再创建 _secretStore
}
```

**改动 2**：`saveKeyPair()` 委托给 AID

```js
// 改前
const rec = this._secretStore.protect(safeAid(aid), 'identity/private_key', Buffer.from(pem));

// 改后
const rec = this._aid.encryptField(safeAid(aid), 'identity/private_key', Buffer.from(pem));
```

**改动 3**：`_restoreKeyPair()` 委托给 AID

```js
// 改前
const plain = this._secretStore.reveal(safeAid(aid), 'identity/private_key', rec);

// 改后
const plain = this._aid.decryptField(safeAid(aid), 'identity/private_key', rec);
```

**改动 4**：`_protectText()` / `_revealText()`（prekey 私钥）同样委托给 AID

**改动 5**：`AIDDatabase` 构造时传入 AID 实例替代 secretStore

```js
// 改前
new AIDDatabase(dbPath, this._secretStore, ...)

// 改后
new AIDDatabase(dbPath, this._aid, ...)
```

---

### 3.5 AIDDatabase（keystore/aid-db.js）— 委托密码学给 AID

group 私钥加解密（E2EE 相关）改为通过 AID 实例完成，不再持有 secretStore。

---

### 3.6 FileSecretStore（secret-store/file-store.js）— 职责收窄

`FileSecretStore` 仍然存在，但**只被 AID 内部使用**，不再被 keystore 直接持有。

AID 内部：
```js
constructor(params) {
  ...
  this._secretStore = new FileSecretStore(params.aunPath, params.encryptionSeed);
}
```

这样 encryptionSeed 的生命周期完全封装在 AID 内部。

---

## 四、改动影响范围汇总

| 文件 | 改动类型 | 风险 |
|------|---------|------|
| `aid.js` | 新增字段 + 4 个方法 | 低（纯新增） |
| `aid-store.js` | 2 处 `_create()` 补字段 | 极低 |
| `client.js` | 移除 seedPassword，传 aid 给 keystore，优化 _loadIdentityOrRaise | 中 |
| `keystore/file.js` | 替换 _secretStore 为 _aid，4 处委托调用 | 中 |
| `keystore/aid-db.js` | 替换 secretStore 参数为 aid | 中 |
| `secret-store/file-store.js` | 不变（仍被 AID 内部使用） | 无 |
| `auth.js` | `_loadIdentityOrRaise` 优先用内存 identity | 低（逻辑简化） |

**evolclaw 侧**：无需改动（`loadClient(store, aid)` 接口不变）

---

## 五、关键约束

1. **AID 实例生命周期**：AUNClient 和 FileKeyStore 持有 AID 引用，调用方必须保证 AID 在 client.close() 之前不被 GC。evolclaw 侧 `this._currentAid = inputAid` 已满足此约束。

2. **多 AUNClient 共享 AID**：允许，因为 AID 无状态，`encryptField/decryptField` 是纯函数（相同输入相同输出），无并发问题。

3. **seed 迁移**：`FileSecretStore._autoMigrateFromSeedFile()` 逻辑保留在 AID 内部，对外透明。

4. **向后兼容**：`AUNClient(aid)` 构造签名不变，`AIDStore` 接口不变，evolclaw 侧无感知。
