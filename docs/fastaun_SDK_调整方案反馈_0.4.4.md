# fastaun SDK 调整方案反馈（致 SDK 开发方）

**反馈方**: evolclaw
**复测版本**: @agentunion/fastaun 0.4.4
**日期**: 2026-05-31
**一句话**: 0.4.4 已朝「AID 携带明文私钥」方向改，但未收尾，导致旧身份无法认证；
同时希望借此从架构上彻底解耦 AIDStore 与 AUNClient。

---

## 〇、背景与核心诉求

evolclaw 的使用模式：`AIDStore`（注册/加载身份）→ 产出 `AID` → `AUNClient`（连接/通信）。
`AIDStore` 配置了 `encryptionSeed`（如 `'evolclaw2'`）。

两条核心原则（请据此评估所有改动）：

1. **单一事实来源**：每类数据只有一个权威存储位置，其他组件通过引用读取，不做冗余副本。
   - 身份私钥/证书 → **文件系统**（`private/key.json`、`public/cert.pem`）唯一事实来源
   - 连接运行时状态 → **aun.db**（SQLite）
   - 对端 agent.md 缓存 → 文件系统
2. **AIDStore 与 AUNClient 尽量解耦**：两者共同依赖的底层对象应按职责拆开，
   各自只持有自己需要的部分，降低耦合。

> ## ⛔ 不可妥协的硬约束：任何敏感密钥材料都不允许明文落盘
>
> 这是**安全红线，优先级高于以上所有原则和任何便利性考量**。
> 私钥、群组密钥、会话密钥等一切敏感密钥材料，**无论存文件还是存 db，落盘前必须加密**。
> 0.4.4 当前存在系统性的明文落盘（见第二节，多处带 `_enc` 后缀的字段实际写明文），
> 必须全部修正。任何"先明文、后续再加密"的临时方案都不接受。

---

## 一、问题 1（Critical）：authenticate() 不消费 AID 的明文私钥，旧身份无法认证

### 现象

| 场景 | 结果 |
|------|------|
| 0.4.4 新注册的 AID | ✅ authenticate 成功 |
| 旧 AID（0.3.x 用真实 seed 加密的私钥） | ❌ `StateError: local identity ... incomplete (missing keypair)` |

新 AID「成功」是假象（见问题 2），不代表已修复。

### 根因（代码定位）

0.4.4 已经让 `AID` 公开携带明文私钥，方向正确：

```js
// aid.js:18-19,33
/** AIDStore 加载时注入的明文私钥 PEM，供 AUNClient 直接使用（无需 seed）。*/
privateKeyPem;
this.privateKeyPem = params.privateKeyPem ?? '';
```

`AUNClient` 构造时也把它存入了 `_identity`：

```js
// client.js:636-643
this._currentAid = inputAid;
this._identity = {
  aid: inputAid.aid,
  private_key_pem: inputAid.privateKeyPem,  // 内存中已有明文私钥
  ...
};
this._state = 'standby';
```

**但 `authenticate()` 没有用它**，而是重新走 keystore 从磁盘解密：

```js
// auth.js:553-555
async authenticate(gatewayUrl, opts) {
  let identity = this._loadIdentityOrRaise(opts?.aid);   // ← 重新走 keystore
  ...
}
// auth.js:1976-1986
_loadIdentityOrRaise(aid) {
  const existing = this._keystore.loadIdentity(requestedAid);  // 空 seed 解密
  if (!existing.private_key_pem || !existing.public_key_der_b64) {
    throw new StateError(`local identity ... incomplete (missing keypair)`);
  }
}
```

而 AUNClient 的 keystore **构造时不传 seed**：

```js
// client.js:591-594（authenticate 路径）/ 761-764（重连路径）
const keystore = new FileKeyStore(this._configModel.aunPath, {
  logger: ...,
  secretStoreLogger: ...,
});   // → _secretStore 用空 seed
```

于是：旧 AID 私钥用真实 seed 加密 → 空 seed keystore 解不开 → `missing keypair`。

**佐证**：实测旧 AID 加载后 `client._identity.private_key_pem` 长度 241（内存确有明文），
`client._state='standby'`，但 authenticate 仍抛 `missing keypair`——证明它无视内存私钥。

对比：`_ensureAgentMdUploadToken`（client.js:878-879）已有 `this._identity` 兜底，
说明「用内存私钥」的模式 SDK 已具备，只是 `authenticate()` 主路径没接上。

### 期望

`authenticate()` / `_loadIdentityOrRaise()` 应优先使用 AUNClient 已持有的明文私钥
（`this._identity` / `this._currentAid.privateKeyPem`），而非走 keystore 空 seed 重新解密。
keystore 不应承担私钥解密职责（见问题 3）。

---

## 二、问题 2（Critical / 安全红线）：敏感密钥材料系统性明文落盘

> 对应〇节的硬约束。这是**必须修复、不接受任何临时妥协**的安全问题。

### 现象

`AIDStore` 配置了 `encryptionSeed: 'evolclaw2'`，但 0.4.4 多类敏感密钥材料实际**明文写盘**。
多个字段名带 `_enc` 后缀（本意是加密），实际却是明文——属于系统性的"阶段6 明文化"。

### 全部明文落盘点（代码定位）

| 敏感材料 | 存储位置 | 代码位置 | 现状 |
|---------|---------|---------|------|
| 身份私钥 | `private/key.json` | auth.js:542 `_writePendingKeypair` | 明文 `fs.writeFileSync`，未 protect |
| E2EE prekey 私钥 | `aun.db` `prekeys.private_key_enc` | file.js:379-385 | 明文（注释「阶段6：明文写入，IK 私钥除外」） |
| 群组密钥 | `aun.db` `group_*.secret_enc` | file.js:489 | 明文（注释「阶段6：明文写入」） |
| E2EE 会话状态 | `aun.db` `e2ee_sessions.data_enc` | file.js:496 | 明文（注释「阶段6：明文写入」） |

身份私钥示例：
```js
// auth.js:542  _writePendingKeypair —— 明文，未经 secretStore.protect()
fs.writeFileSync(path.join(dir, 'key.json'),
  JSON.stringify({ private_key_pem: priv, public_key_der_b64: pub, curve }),
  { mode: 0o600 });
```
`promotePendingIdentity`（file.js:652）随后只 `fsRenameSync`，全程不加密。

对比旧 AID（0.3.x 注册）：`key.json` 含 `private_key_protection`（scheme=`file_aes`），是加密的。
说明 0.4.x 是从「加密」回退到了「明文」，属安全倒退。

### 与问题 1 的叠加效应

身份私钥明文落盘 + AUNClient keystore 空 seed → 两端都不需真正解密 → 新 AID authenticate「通过」。
**这掩盖了问题 1，并非修复**。一旦私钥被正确加密（如旧 AID），`missing keypair` 立刻重现。

### 期望（硬性）

上述 4 类材料**全部**必须加密后落盘，文件与 db 一视同仁。
加解密统一由 AID 完成（见问题 3），seed 只在 AID 内部。
不接受 `mode:0o600` 文件权限替代加密——权限不是加密。

---

## 三、问题 3（架构）：AIDStore 与 AUNClient 的底层对象需按职责拆开

### 现状：两个共享类把两类职责揉在一起

`AIDStore` 与 `AUNClient` 各自 `new` 了独立实例，但用的是同一批"大杂烩"类：

| 共享类 | AIDStore 用它做什么 | AUNClient 用它做什么 | 冲突 |
|--------|---------------------|---------------------|------|
| `FileKeyStore` | 私钥加解密(seed)、证书读写、changeSeed | 连接状态(token/seq/group/metadata)、loadIdentity | 🔴 seed 依赖 vs 无 seed |
| `AuthFlow` | 仅 `registerAid` / `fetchPeerCert` | `authenticate` / `connectSession` / token 刷新 | 🟡 方法集几乎不重叠 |
| `AIDDatabase` | 不直接用 | aun.db 全部状态表 | 🟢 仅 AUNClient 用 |
| `CryptoProvider` / `GatewayDiscovery` / `DnsResilientNet` / `AUNLogger` | 各自 new | 各自 new | 🟢 无状态，无需共享 |

AUNClient 调 keystore 的方法（`loadInstanceState`/`saveSeq`/`loadGroupState`/`saveMetadata`...）
**全部不需要 seed**；唯一碰私钥的是 `loadIdentity`——而那正是问题 1 中它不该做的。

### 存储层边界（磁盘上职责本已清晰）

| 磁盘对象 | 内容 | 应归属 | 需 seed |
|---------|------|--------|---------|
| `private/key.json` | 身份私钥 | 身份层（AIDStore/AID） | ✅ 唯一需要 seed 处 |
| `public/cert.pem` | 身份证书 | **文件系统唯一事实来源**；连接层只读 | ❌ |
| `aun.db` 全部表 | token/instance_state/seq/group/prekey/e2ee/agent_md_cache | 连接层（AUNClient） | ❌ 全明文 |

**已确认的两点**（与 evolclaw 原则一致，无需 SDK 改）：
- 身份证书：`loadCert/saveCert` 走文件 `cert.pem`，文件系统是唯一事实来源 ✓
- 对端 agent.md：缓存在文件系统，非 db ✓

> 备注：当前 db 的 `metadata_kv` 里残留了一份与 `cert.pem` 同 serial 的身份证书副本
> （`_pending_active_cert`，登录响应里服务端返回的续期证书被 `saveIdentity` 当普通字段落库）。
> 这是个**临时字段**（auth.js:1889 用完即 `delete`），不应持久化。
> 建议在 `saveIdentity` 的 skip 集合里排除 `_pending_*`，确保身份证书唯一来源是 `cert.pem`。

### 目标：以 AID 为枢纽彻底解耦

```
文件系统（身份，唯一事实来源）        aun.db（连接状态，全明文）
  ├ private/key.json (加密)            ├ tokens / instance_state / seq
  └ public/cert.pem  (明文,只读共享)   ├ prekeys / e2ee / group_*
         │                            └ agent_md_cache
         ▼
   AIDStore ──→ IdentityStore(seed) ──→ AID(明文私钥 + 加解密能力)
      │                                      │
      └─ RegistrationFlow                    │ 仅靠引用传递
                                             ▼
   AUNClient ─→ StateStore(无 seed, aun.db) ─┘
      │      └─→ AID(引用, 取明文私钥签名 / 委托加解密)
      └─ SessionAuthFlow
```

### 拆分动作

1. **拆 `FileKeyStore`** → 两个类：
   - `IdentityStore`（私钥+证书，带 seed，AIDStore 用）
   - `StateStore`（aun.db 状态 + 只读 cert.pem，无 seed，AUNClient 用）
2. **拆 `AuthFlow`** → 两个类：
   - `RegistrationFlow`（registerAid/fetchPeerCert，AIDStore 用）
   - `SessionAuthFlow`（authenticate/connectSession/token 刷新，AUNClient 用）
3. **密码学集中到 AID**：私钥加解密（`encryptField`/`decryptField`）、签名验签全部在 AID 内部完成；
   AID 内部持有 seed 派生的 masterKey。seed 只存在于 AIDStore→AID 链，AUNClient 零 seed 依赖。

拆分后 AIDStore 与 AUNClient 的唯一连接点是 **AID 引用**：AIDStore 生产 AID，AUNClient 消费 AID。

---

## 四、三个问题的关系与修复顺序

```
问题3（解耦：密码学集中到 AID，keystore 拆分）
   ├── 修复后自然解决问题1：authenticate 用 AID 私钥，不再走空 seed keystore
   └── 修复后自然解决问题2：私钥加解密统一走 AID，注册落盘必经加密
```

- **问题 1、2 是表象，问题 3 是根**。若按问题 3 重构，1、2 一并消除。
- 若暂时只能打补丁（不做大重构），最小修复为：
  - 问题 1：`authenticate` 优先用 `this._identity` 的明文私钥
  - 问题 2：**全部 4 类敏感材料**（身份私钥 / prekey / 群组密钥 / e2ee 会话）改为经加密落盘
  - 两者必须**一起改**：只改 2 会让所有新 AID 重现 `missing keypair`；只改 1 旧 AID 能连但密钥仍明文落盘。
- ⛔ 无论走重构还是补丁，「敏感材料明文落盘」是必须清零的红线，不接受遗留任何一处。

---

## 五、对 evolclaw 的影响

- `loadClient(store, aid)` / `AIDStore` / `AUNClient(aid)` 公开接口若保持不变，**evolclaw 侧无需改动**。
- 阶段二联调（daemon 长连接、CLI 短连接、踢人测试）依赖问题 1 修复后才能进行。
- 旧身份（已用真实 seed 加密的 AID）必须能在修复后正常 authenticate，否则需提供迁移路径。

---

## 附：复现命令（0.4.4）

```js
// 旧 AID（加密私钥）→ 失败
const store = new AIDStore({ aunPath, slotId:'x', encryptionSeed:'evolclaw2' });
const r = store.load('dddd.agentid.pub');
console.log(r.data.aid.isPrivateKeyValid());  // true
const c = new AUNClient(r.data.aid);
await c.authenticate();  // ❌ StateError: missing keypair

// 新 AID（明文私钥）→ 假性成功
await store.register('new.agentid.pub');      // key.json 明文落盘
// authenticate 通过，仅因明文 + 空 seed 都不需解密
```

