# fastaun 0.4.5 阻断性 Bug：message.pull/ack 的 slot_id 校验与 connect/隔离键自相矛盾

**反馈方**: evolclaw
**版本**: @agentunion/fastaun 0.4.5
**日期**: 2026-05-31
**严重度**: 🔴 阻断（Blocker）—— 直接卡死 evolclaw 的多 slot 共享消费通道方案，阶段二联调无法进行

---

## 一句话

同一个 `slot_id` 在 `connect()` 能通过校验（`normalizeSlotId` 允许空格/`/`/`:`），
但一调用 `message.pull` / `message.ack` 就抛 `ValidationError: slot_id contains unsupported characters`
（`_injectMessageCursorContext` 改用 `normalizeInstanceId`，禁止空格/`/`/`:`）。
而这些被禁的字符，恰恰是 `slotIsolationKey` 用来切分「共享隔离键」的分隔符——
导致**「slot 共享隔离键」与「能调 message.pull/ack」在 0.4.5 上不可兼得**。

---

## 复现

```js
const store = await getAidStore({ slotId: 'evolclaw cli' });   // 带空格
const c = await loadClient(store, 'llbot.agentid.pub');
await c.authenticate();                                          // ✓ 成功
await c.connect({ connection_kind:'short', short_ttl_ms:30000, auto_reconnect:false }); // ✓ 成功
await c.call('message.pull', { limit: 1 });                     // ✗ 抛 ValidationError: slot_id contains unsupported characters
```

报错栈：
```
ValidationError: slot_id contains unsupported characters
    at normalizeInstanceId (config.js:24)
    at AUNClient._injectMessageCursorContext (client.js:6953)
    at AUNClient.call (client.js:1864)
```

---

## 根因：两个校验函数对 slot_id 的规则相反

`config.js` 里两套正则：
```js
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;                 // 不含空格 / : /
const SLOT_ID_PATTERN     = /^[A-Za-z0-9._-][A-Za-z0-9._/ :-]{0,127}$/; // 含空格 / : /
```

- `connect()` → `normalizeSlotId`（用 `SLOT_ID_PATTERN`，**允许** 空格/`/`/`:`）→ 通过
- `message.pull`/`message.ack` → `_injectMessageCursorContext`（client.js:6946-6958）
  → `normalizeInstanceId(params.slot_id ?? this._slotId, 'slot_id', ...)`（用 `INSTANCE_ID_PATTERN`，**禁止** 空格/`/`/`:`）→ 崩

```js
// client.js:6946-6958
_injectMessageCursorContext(method, params) {
    if (method !== 'message.pull' && method !== 'message.ack') return;
    ...
    const slotId = normalizeInstanceId(params.slot_id ?? this._slotId, 'slot_id', { allowEmpty: true });
    //             ^^^^^^^^^^^^^^^^^^ 用了 instance_id 的严格正则，与 connect 用的 normalizeSlotId 不一致
    ...
}
```

同一个 `this._slotId`，connect 阶段合法、message 阶段非法——**自相矛盾**。

---

## 与 slotIsolationKey 的冲突（为什么这是死结）

`slotIsolationKey`（config.js:37）用空格/`/`/`:` 作分隔符，取首段做「隔离键」（共享消费通道的依据）：
```js
slotIsolationKey(slotId){ const m = slotId.match(/^[^/ :]+/); return m ? m[0] : slotId; }
```

evolclaw 的设计依赖此语义：`evolclaw daemon` / `evolclaw cli` / `evolclaw netcheck`
→ 隔离键都是 `evolclaw` → 共享同一消费通道（1 长连 + N 短连共存，短连不踢长连）。

**实测矩阵**（短连接后调 message.pull，目标 llbot）：

| slot_id | message.pull | slotIsolationKey | 能否共享 |
|---------|:---:|---|:---:|
| `evolclaw daemon`（空格） | ✗ 崩 | `evolclaw` | 想共享但崩 |
| `evolclaw cli`（空格） | ✗ 崩 | `evolclaw` | 想共享但崩 |
| `evolclaw:daemon` | ✗ 崩 | `evolclaw` | 想共享但崩 |
| `evolclaw/daemon` | ✗ 崩 | `evolclaw` | 想共享但崩 |
| `evolclaw.daemon` | ✓ OK | `evolclaw.daemon`（整串） | 不共享 |
| `evolclaw-cli` | ✓ OK | `evolclaw-cli`（整串） | 不共享 |

**结论**：三个隔离键分隔符（空格 / `:` / `/`）全部触发 message.pull 崩溃；
而能通过 message.pull 的字符（`.` / `-`）都不是分隔符，只能产生「整串=独立隔离键」，无法共享。
→ 在 0.4.5 上，**「多 slot 共享隔离键」与「能调 message.pull/ack」二者不可兼得**。

---

## 影响

- evolclaw 现行方案（daemon=`evolclaw daemon` 长连、cli=`evolclaw cli` 短连，二者共享 `evolclaw` 隔离键并都收发消息）被**完全卡死**：CLI/net-check 一 pull 就崩。
- 补充观察：daemon 长连接（同样带空格 slot）日志里 **0 条**该报错——推测 daemon 长连接收消息走 push 不主动 pull，故未触发；但 CLI 短连接必须 pull。**待 SDK 确认 daemon 的 message.ack 路径是否也会触发**（若会，daemon 也有隐患）。

---

## 期望修复

`message.pull` / `message.ack` 的 slot_id 校验应与 `connect()` 一致，统一用 `normalizeSlotId`
（`SLOT_ID_PATTERN`，允许分隔符），而不是退回 `normalizeInstanceId`（`INSTANCE_ID_PATTERN`）。

即把 client.js:6953 的：
```js
const slotId = normalizeInstanceId(params.slot_id ?? this._slotId, 'slot_id', { allowEmpty: true });
```
改为用 `normalizeSlotId`（与 connect/AIDStore 构造一致的校验）。

修复后「共享隔离键 + 收发消息」即可两全，evolclaw slot 方案与阶段二联调可继续。

---

## 对 evolclaw 的临时选择（待 SDK 修复前）

二选一，均有代价：
- **保共享、停联调**：维持带空格 slot（隔离键共享语义正确），等 SDK 修 message.pull 校验后再联调。
- **保联调、弃共享**：临时改用无分隔符 slot（如 `evolclaw-daemon`/`evolclaw-cli`），能 pull，但 daemon/cli 变成独立隔离键、各自独立消费通道、CLI 短连接会另占槽位——偏离原设计。

倾向前者（等修复），因为后者破坏了 daemon/cli 共享消费通道这一核心设计，且 SDK 修复只是一行校验函数替换。
