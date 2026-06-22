# Bug: AUNClient(aid) 内部 keystore 不继承 encryptionSeed

**SDK 版本**: @agentunion/fastaun 0.4.3（首次发现） / 0.4.4（复测仍未修复，且引入新问题）
**发现日期**: 2026-05-31
**严重程度**: Critical — 所有使用非空 encryptionSeed 的旧身份均无法连接；0.4.4 起私钥明文落盘

> **状态更新（0.4.4 复测）**：见文末「0.4.4 复测结论」。简言之：原 bug **未修复**（旧身份仍 `missing keypair`），且 0.4.4 注册流程把私钥**明文写入磁盘**，掩盖了原 bug 并引入安全倒退。

## 现象

```
StateError: local identity for aid <aid> is incomplete (missing keypair);
call auth.registerAid() first
```

`AIDStore.load(aid)` 返回 `_privateKeyValid: true`，但随后 `new AUNClient(aid).authenticate()` 抛出上述错误。

## 根因

`AID` 值对象（`aid.js`）不携带 `encryptionSeed`/`seedPassword` 字段：

```js
// aid-store.js — AIDStore.load() 调用 AID._create()，未传 encryptionSeed
return resultOk({
  aid: AID._create({ aid, aunPath, certPem, privateKeyPem, ..., /* 无 encryptionSeed */ }),
});
```

`AUNClient` 构造时从 `inputAid.seedPassword` 读取 seed：

```js
// client.js:569
const keystore = new FileKeyStore(this._configModel.aunPath, {
  encryptionSeed: this._configModel.seedPassword ?? undefined,  // → undefined
});
```

`seedPassword` 为 `undefined`，keystore 用空 seed 派生 master key，无法解密用 `encryptionSeed` 加密的私钥。

## 复现步骤

```js
const store = new AIDStore({ aunPath, slotId: 'test', encryptionSeed: 'my-seed' });
await store.register('test.agentid.pub');
const r = store.load('test.agentid.pub');
console.log(r.data.aid._privateKeyValid);  // true ✓

const client = new AUNClient(r.data.aid);
await client.authenticate();  // ❌ StateError: missing keypair
```

## 期望行为

`AIDStore.load()` 应将 `encryptionSeed` 传入 `AID._create()`，`AUNClient` 构造时从 `AID` 读取并传给内部 keystore。

或者 `AUNClient` 提供接受 `AIDStore` 的构造重载：`new AUNClient(store, aid)`。

## 影响范围

所有使用非空 `encryptionSeed` 的场景（evolclaw 使用 `encryptionSeed: 'evolclaw2'`）：
- daemon 长连接无法建立
- CLI 短连接无法建立
- `aid new` 注册后无法 authenticate
- 所有 `loadClient(store, aid)` 调用均失败

## 临时 Workaround

无法在 evolclaw 侧绕过（`AUNClient` 构造函数只接受 `AID`，无法注入 seed）。

需要 SDK 修复后才能进行阶段二联调。

---

## 0.4.4 复测结论

**复测日期**: 2026-05-31（升级 0.4.3 → 0.4.4 后）
**结论**: 原 bug **未修复**，并新增「私钥明文落盘」问题。

### 复测现象

| 场景 | 结果 |
|------|------|
| 0.4.4 新注册的 AID | ✅ authenticate 成功 |
| 旧 AID（0.3.x 用真实 seed 加密的，如 dddd） | ❌ 仍 `missing keypair` |

新 AID「成功」是假象（见下），不代表修复。

### 根因一：encryptionSeed 传递链仍断（未修复）

`AUNClient` 构造时**仍不把 seed 传给内部 keystore**：

```js
// client.js:591-594（0.4.4）—— 不传 encryptionSeed
const keystore = new FileKeyStore(this._configModel.aunPath, {
  logger: ...,
  secretStoreLogger: ...,
});  // → _secretStore 用空 seed
```

`authenticate()` 仍走 keystore 从磁盘**重新解密**，无视内存中已有的明文私钥：

```js
// auth.js:1976（0.4.4）
_loadIdentityOrRaise(aid) {
  const existing = this._keystore.loadIdentity(requestedAid);  // 空 seed 解密
  if (!existing.private_key_pem || !existing.public_key_der_b64) {
    throw new StateError(`local identity ... incomplete (missing keypair)`);
  }
  ...
}
```

实测：旧 AID 加载后 `client._identity.private_key_pem` 长度 241（**内存已有明文**），
`client._state = 'standby'`，但 `authenticate()` 仍抛 `missing keypair`
——证明它无视内存明文，重新走空 seed keystore，解不开 evolclaw2 加密的旧私钥。

### 根因二：私钥明文落盘（0.4.4 新增的安全倒退）

0.4.4 注册流程把私钥**明文写入磁盘**，绕过 secretStore 加密：

```js
// auth.js:533-542（0.4.4）_writePendingKeypair
_writePendingKeypair(pendingDir, identity) {
  const priv = String(identity.private_key_pem ?? '');
  ...
  // 直接明文写入，未经 _secretStore.protect()
  fs.writeFileSync(path.join(dir, 'key.json'),
    JSON.stringify({ private_key_pem: priv, public_key_der_b64: pub, curve }, null, 2),
    { encoding: 'utf-8', mode: 0o600 });
}
```

`promotePendingIdentity()`（keystore/file.js:652）只做 `fsRenameSync`，不加密：

```js
promotePendingIdentity(pendingDir, aid) {
  ...
  fsRenameSync(pendingDir, target);  // 明文目录直接 rename 成正式目录
}
```

实测：`getAidStore` 明确配置 `encryptionSeed: "evolclaw2"`，但 0.4.4 新注册的
`AIDs/<aid>/private/key.json` 中 `private_key_pem` 是**明文**，无 `private_key_protection` 字段。

对比旧 AID（0.3.x 注册）的 `key.json`：有 `private_key_protection`（scheme=`file_aes`），是加密的。

### 为什么新 AID「看起来成功」

私钥明文落盘 + AUNClient keystore 用空 seed —— 两端都不需要真正解密，
所以 authenticate 通过。这**掩盖了根因一**，并非修复。

一旦私钥被正确加密（如对旧 AID，或将来修好加密落盘后），空 seed keystore 立刻解不开，
`missing keypair` 重现。

### 验证补充

把 0.4.4 明文 AID 用 `changeSeed('', 'evolclaw2')` 加密后再测，
`authenticate()` 报错从 `missing keypair` 变为 `no trusted roots available`
（CA 链问题，与本 bug 无关）——说明只要私钥变成加密态，解密链就再次暴露。

### 期望修复（重申，与架构方案一致）

见 `fastaun_SDK_架构调整方案_AID中心化.md`。核心两点：

1. **修复加密落盘**：`_writePendingKeypair` / promote 流程必须经 secretStore 加密，
   私钥绝不可明文落盘。
2. **修复解密链**：`authenticate()` 应使用 AID 携带的密钥（内存明文 `_identity`），
   或让 keystore 通过 AID 完成解密；keystore 不应用空 seed 重新解密。

两者必须一起修：只修 1（加密落盘）会让所有新 AID 重现 `missing keypair`；
只修 2（解密链）旧 AID 能连但新私钥仍明文落盘。

### 影响

- 阶段二联调仍被阻塞（旧 AID 全部 `missing keypair`，daemon 无法上线）
- 安全倒退：0.4.4 起所有新注册身份私钥明文落盘
