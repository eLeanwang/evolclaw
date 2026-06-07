# SDK Bug: verifyAgentMd `this` 绑定丢失

## 问题描述

`@agentunion/fastaun` SDK 的 `verifyAgentMd` 方法在需要远程获取对端证书时会报错：

```
TypeError: Cannot read properties of undefined (reading '_clientLog')
```

验签返回 `status: "invalid"`，`reason` 为上述 TypeError。

## 影响范围

- **受影响**：`client.auth.verifyAgentMd(content, { aid })` — 当不传 `certPem` 且本地无对端证书缓存时
- **不受影响**：`client.auth.signAgentMd(content)` — 签名正常
- **不受影响**：`client.auth.verifyAgentMd(content, { aid, certPem })` — 手动传入证书时正常

## 根因分析

位置：`node_modules/@agentunion/fastaun/dist/namespaces/auth.js` 第 382 行

```javascript
// AuthNamespace.verifyAgentMd 内部
const fetchPeerCert = this._internal._fetchPeerCert;
if (typeof fetchPeerCert !== 'function') { ... }
certPem = String(await fetchPeerCert(expectedAid, fields.cert_fingerprint)).trim();
```

`this._internal` 是 `AUNClient` 实例本身。问题在于 `_fetchPeerCert` 被**解构赋值**给局部变量后，调用时丢失了 `this` 绑定。

`_fetchPeerCert` 内部第一行就是 `this._clientLog.debug(...)`，由于 `this` 变成了 `undefined`（严格模式）或 `global`，导致 `_clientLog` 不存在。

### 验证

```javascript
// 裸调用 — 报错
const fetchPeerCert = client._fetchPeerCert;
await fetchPeerCert('some.agentid.pub'); // TypeError: Cannot read properties of undefined (reading '_clientLog')

// 绑定调用 — 正常
await client._fetchPeerCert.call(client, 'some.agentid.pub'); // OK
```

## 正确修复（SDK 侧）

SDK 应该用 `.call(this._internal, ...)` 或 `.bind(this._internal)` 调用：

```javascript
// 修复方案 A：bind
const fetchPeerCert = this._internal._fetchPeerCert.bind(this._internal);

// 修复方案 B：直接调用
certPem = String(await this._internal._fetchPeerCert(expectedAid, fields.cert_fingerprint)).trim();
```

## evolclaw 侧 Workaround

在 `src/aid/agentmd.ts` 中，我们绕过了这个 bug：

1. **本地 AID**：直接读 `~/.aun/AIDs/<aid>/public/cert.pem`，传入 `{ aid, certPem }` 调用 `verifyAgentMd`
2. **远程 AID**：手动调用 `client._fetchPeerCert.call(client, aid)` 获取证书，再传入 `{ aid, certPem }`

这样完全跳过了 SDK 内部有 bug 的 `_fetchPeerCert` 解构路径。

## SDK 版本

- 包名：`@agentunion/fastaun`
- 当前版本：`^0.2.19`
- Bug 位置：`dist/namespaces/auth.js:382`

## 状态

- evolclaw 已有 workaround，签名验签功能完整可用
- 待 SDK 修复后可移除 workaround（删除手动 certPem 获取逻辑，直接传 `{ aid }` 即可）
