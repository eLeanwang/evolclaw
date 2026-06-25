# fastaun SDK 解耦核查反馈（0.4.5 复核更正版）

**反馈方**: evolclaw
**核查版本**: @agentunion/fastaun 0.4.5
**日期**: 2026-05-31
**结论**: 0.4.5 解耦做得比初判要好——**接口层面已用 `TokenStore` / `KeyStore` 两个接口做了职责隔离**
（AuthFlow / AUNClient 仅持 `TokenStore`，编译期就拿不到私钥方法），注册流程也拆出了独立 `RegisterFlow`。
但仍有 **3 个真实问题**未解决：① AIDStore 跨界调用 AuthFlow 的 `protected _shortRpc`；
② 敏感密钥材料（prekey/group/e2ee）明文落盘；③ `AID.privateKeyPem` 明文私钥为 public 可读。
此外有 2 项「可选优化」（物理类未拆，但不影响正确性）。

> **更正声明**：本文档此前版本曾判定「FileKeyStore 类被共享导致 AUNClient 可误调私钥方法」「职责混合可被误用」。
> 经复核 `.d.ts` 类型声明，该判定**不准确**：SDK 已通过接口隔离（`TokenStore` / `KeyStore`）在类型层面禁止了误用。
> 下文已更正。

---

## 〇、目标（重申）

`AIDStore`（身份：注册/加载/续期/证书）与 `AUNClient`（连接：认证/通信/状态）应**底层解耦**：
- 共享的底层能力按职责隔离，各持其需
- 唯一连接点是 `AID` 值对象（AIDStore 生产、AUNClient 消费）
- seed / 私钥加解密只存在于身份侧，连接侧零接触

---

## 一、已经做到的（确认 ✅）

| 项 | 证据 |
|----|------|
| **接口职责隔离** | `keystore/index.d.ts`：定义 `TokenStore`（无私钥操作）+ `KeyStore`（私钥/身份操作）两个接口，`FullKeyStore = TokenStore & KeyStore` |
| **AUNClient/AuthFlow 只持 TokenStore** | `auth.d.ts:43` 构造参数 `tokenStore: TokenStore`——**类型上无 `loadKeyPair/saveKeyPair/loadIdentity`，编译期无法误调私钥** |
| **AuthFlow 不再解密私钥** | `auth.d.ts:57` 注释 + `_loadIdentityOrRaise`（auth.js:1748）优先用注入的 `_memIdentity` 明文，不走 store 解密 |
| **注册流程独立** | 拆出 `RegisterFlow`（register-flow.js），AIDStore 用它做 `registerAid` |
| **身份私钥加密落盘** | 实测新 AID `private/key.json` 为加密（scheme=`file_aes`）；`_persistIdentity` 显式 delete 私钥字段不回写 db |
| **seed 隔离** | AUNClient 侧 `new FileKeyStore` 不传 seed（client.js:591）；seed 仅在 AIDStore 侧 |
| **单向依赖** | AUNClient 不 import AIDStore |

→ **「seed 误用导致旧身份无法认证」的功能性 bug 已消除**。新旧 AID 均能 authenticate，evolclaw 246 单测通过。

---

## 二、仍存在的真实问题

| # | 问题 | 严重度 | 证据 | 期望 |
|---|------|--------|------|------|
| 1 | AIDStore 跨界调用 AuthFlow 的 `protected _shortRpc` | 🔴 高 | aid-store.js:484/491/520/528（renewCert/rekey）；`_shortRpc` 在 auth.d.ts:127 是 `protected` | 身份侧续期/轮换的短连接 RPC 应归身份侧自有方法，不依赖连接侧 AuthFlow 内部 |
| 2 | 敏感密钥材料明文落盘（prekey/group/e2ee） | 🔴 高(安全) | file.js:427/531/538 三处「阶段6：明文写入」 | 全部加密落盘，加解密走 AID |
| 3 | `AID.privateKeyPem` 明文私钥为 public 可读 | 🟡 中 | aid.d.ts:24 `readonly privateKeyPem: string`（public，无 `private` 修饰） | 收敛为私有 + 受控签名接口（AID 已有 `sign()`/`signAgentMd()`） |

---

## 三、可选优化（不影响正确性，非缺陷）

| # | 项 | 说明 |
|---|----|----|
| A | `FileKeyStore` 物理类未拆 | 运行时两边仍 `new` 同一个 `FileKeyStore`（它实现 `FullKeyStore`）。**但已通过接口窄化隔离**，AUNClient 持 `TokenStore` 视图。是否进一步拆成 `IdentityStore`+`StateStore` 两个物理类，属代码整洁度优化，非正确性问题 |
| B | `AuthFlow` 连接侧未拆出 `SessionAuthFlow` | AuthFlow 仍是一个类，被 AIDStore（仅 `fetchPeerCert` + 问题①的 `_shortRpc`）和 AUNClient（全套认证）共用。若解决问题①后 AIDStore 不再碰 AuthFlow 私有成员，则共享 `fetchPeerCert` 一个公开方法的耦合可接受 |

---

## 四、逐项证据（仅问题项）

### 问题 1：AIDStore 跨界调用 AuthFlow 的 protected _shortRpc

`_shortRpc` 在类型声明中是 `protected`：
```ts
// auth.d.ts:127
protected _shortRpc(gatewayUrl: string, method: string, params: RpcParams): Promise<JsonObject>;
```

但 AIDStore 从外部实例直接调用它（绕过访问控制）：
```js
// aid-store.js
313:  const certPem  = await this._auth.fetchPeerCert(gatewayUrl, target);          // 公开方法，OK
484:  const phase1   = await this._auth._shortRpc(gatewayUrl, 'auth.aid_login1', {...});  // renewCert() —— 调 protected
491:  const response = await this._auth._shortRpc(gatewayUrl, 'auth.renew_cert', {...});  // renewCert()
520:  const phase1   = await this._auth._shortRpc(gatewayUrl, 'auth.aid_login1', {...});  // rekey()
528:  const response = await this._auth._shortRpc(gatewayUrl, 'auth.rekey', {...});       // rekey()
```

`renewCert` / `rekey`（证书续期/密钥轮换）是**身份侧职责**，却复用了连接侧 AuthFlow 的 protected 短连接 RPC。
AuthFlow 内部签名一变，AIDStore 即坏。

**可拆性分析（供参考）**：`_shortRpc` 实现（auth.js:691）只依赖 `_connectionFactory` + `_wsRecv` + `mapRemoteError`，
**完全无状态**（不读 `_memIdentity`/token/keystore）。建议下沉为独立的无状态 `shortRpc(gatewayUrl, method, params)` 工具
（函数或小类），身份侧与连接侧各自引用，AIDStore 不再触碰 AuthFlow 内部。

### 问题 2：敏感密钥材料明文落盘（安全红线）

身份私钥已加密（0.4.5 修复）。但以下三类仍明文写盘，字段名带 `_enc` 后缀却存明文：
```js
// keystore/file.js
427:  ...run(prekeyId, deviceId, privateKey, ...)        // prekeys.private_key_enc —— E2EE prekey 私钥，明文
531:  ...run(groupId, epoch, String(opts.secret ?? ''), ...)  // group_current.secret_enc —— 群组密钥，明文
538:  ...run(sessionId, dataJson, ...)                   // e2ee_sessions.data_enc —— E2EE 会话，明文
```
三处源码注释均自承「阶段6：明文写入」。违反「任何敏感密钥材料不允许明文落盘」硬约束。
基础认证不受影响，但**启用 E2EE / 群组前必须修复**。

### 问题 3：AID.privateKeyPem 明文私钥 public 可读

```ts
// aid.d.ts
24:  readonly privateKeyPem: string;     // public（无 private 修饰）
25:  private readonly _certValid;        // 对比：真正的私有字段长这样
```
明文私钥作为 public readonly 字段暴露，任何持 AID 引用者可 `aid.privateKeyPem` 直接读明文。
这是「私钥解密上移到 AID」方案的副作用（AUNClient 取它构造 `_memIdentity`）。
建议收敛为私有字段，对外只暴露 `sign()`/`signAgentMd()` 受控签名接口（AID 已具备）。

---

## 五、解耦完成度（更正后）

| 维度 | 状态 |
|------|------|
| AUNClient → AIDStore 反向依赖 | ✅ 无 |
| 接口职责隔离（TokenStore/KeyStore） | ✅ 已做 |
| AUNClient 编译期无法误调私钥方法 | ✅ 接口窄化保证 |
| 注册流程独立（RegisterFlow） | ✅ 已拆 |
| 私钥解密上移到 AID + seed 隔离 | ✅ 已做 |
| 身份私钥加密落盘 | ✅ 已做 |
| AIDStore 不碰 AuthFlow 私有成员（问题1） | ❌ 仍调 protected `_shortRpc` |
| 敏感材料全加密落盘（问题2） | ❌ prekey/group/e2ee 明文 |
| AID 明文私钥不裸露（问题3） | ❌ public 可读 |
| FileKeyStore 物理拆分（可选A） | ⚪ 未拆，但接口已隔离，非必须 |
| AuthFlow 连接侧拆分（可选B） | ⚪ 未拆，解决问题1后可接受 |

**功能性解耦已达成（核心 bug 消除）；剩 3 个真实问题（1 个结构耦合 + 1 个安全 + 1 个暴露面）+ 2 项可选优化。**

---

## 六、建议优先级

1. **问题 2（安全，最高）**：prekey/group/e2ee 三处明文落盘必须加密——启用 E2EE 前的硬门槛。
2. **问题 1（结构）**：`_shortRpc` 下沉为无状态工具，斩断 AIDStore 对 AuthFlow 私有成员的依赖。
3. **问题 3（暴露面）**：`AID.privateKeyPem` 收敛为私有 + 签名接口。
4. 可选 A/B：视代码整洁度需要决定，不阻塞功能。

---

## 七、对 evolclaw 的影响

- 上述均为 SDK 内部调整。`AIDStore` / `AUNClient(aid)` / `loadClient(store, aid)` 公开接口不变则 **evolclaw 侧无需改动**。
- 0.4.5 已可支撑基础认证联调（新旧 AID 均能 authenticate，身份私钥加密落盘，evolclaw 246 单测通过）。
- 问题 2 属安全项，需在启用 E2EE / 群组功能前由 SDK 修复。
