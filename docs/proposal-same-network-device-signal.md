# 提案：消息携带「同网络 / 同设备」标记，贯通 SDK → 应用上下文

> 面向：AUN 网关、fastaun SDK 开发方
> 提出方：EvolClaw
> 状态：需求 + 设计草案，待网关/SDK 方评审
> 关联代码引用均为 fastaun（`@agentunion/fastaun`）dist 与 EvolClaw 现网代码，行号供核对。

## 1. 需求

让通信双方的 agent 能感知对端与自己是否处于：

- **同一网络**（same network）
- **同一设备**（same device）

最终目的：应用层（EvolClaw 的 ECK 上下文）据此向 agent 注入提示，
例如「对端与你在同一台机器上，可直接走本地文件/IPC，无需走网络传输」。

核心诉求是**信号要能从底层一路透到应用层**，不在中途被吃掉。

## 2. 当前链路现状（已核实）

一条入站消息从网关到应用的实际流转：

```
网关 push
  → SDK 解密/组装 message 事件
  → SDK emit 'message.received'（client.js）
  → 应用 client.on('message.received')
  → 应用榨取 payload 文本 + 元数据
  → 注入应用上下文（提示词）
```

SDK 成功解密后给应用的事件对象（`client.js:4722-4740`）大致为：

```js
{
  from, to, seq, message_id, t_server,
  payload,            // 应用内容
  encrypted, e2ee,    // 加密状态
  device_id, slot_id, // 见下方说明
  direction,
}
```

## 3. 现状的两个关键事实（已核实）

### 3.1 `device_id` 是接收方自己的，不是发送方的

成功解密路径里 `result.device_id = msg.device_id`（`client.js:4734`）——这是**目标设备**
（本端多实例路由用），不是发送方设备。应用拿它无法判断对端在哪。

### 3.2 发送方 device_id 存在于 AAD，但成功路径不透出

E2EE 信封的 AAD 里带有 `from_device`（= 发送方 device_id，密码学防篡改）：
- 发送侧写入：`v2/e2ee/encrypt-p2p.js:65`、`encrypt-group.js:47` → `from_device: sender.deviceId`
- 接收侧读取：`client.js:4643` → `const senderDeviceId = String(aad.from_device ?? '')`

但 `senderDeviceId` **只在解密失败分支**被放进事件（`client.js:4663/4688` 的 `_sender_device_id`）。
**成功解密路径**（`client.js:4722-4740`）构造的 result **不包含** `from_device`。

结论：**今天一条正常收到的消息，应用拿不到发送方 device_id，更没有任何「同网络」信号。**

## 4. 需要新增的两个信号

| 字段 | 含义 | 谁能算出 | 信任模型 |
|------|------|----------|----------|
| `same_network` | 收发双方处于同一网络 | **仅网关**（同时看到两条连接的来源地址） | 网关断言 |
| `same_device` | 收发双方处于同一设备 | 网关，或由 `aad.from_device` 比对 | 见下 |

### 4.1 为什么「同网络」必须由网关给

收发双方各自只知道自己的地址，唯有网关同时持有两条连接的来源信息。
agent 自身无法推断，因此该信号**只能在网关计算并下发**。

> ⚠️ 语义需先对齐：「同网络」指同公网出口 IP？同 NAT 内网？同局域网段？
> 同公网 IP ≠ 同内网（同运营商出口可能让无关用户共享 IP）。该定义直接决定网关判定逻辑。

### 4.2 「同设备」的两条可选实现

- **路径 A（网关下发）**：网关比对两端设备标识，盖 `same_device` 标记。简单，但属网关断言。
- **路径 B（SDK 透出 `from_device`）**：发送方 device_id 已在 AAD 中、且签名防篡改；
  让 SDK 在**成功解密路径**也带上 `from_device`，应用比对双方 device_id 即可。
  更可信（发送方无法伪造），不依赖网关。
  - 前提：双方共享同一 `device_id` 来源文件。EvolClaw 的 device_id 取自
    `$EVOLCLAW_HOME/.device_id`（同机同数据目录共享），锚定的是「数据目录」非「物理机」。

## 5. 建议的字段接口

### 5.1 网关 → SDK（信封新增字段）

建议网关在下发的消息信封中新增两个布尔标记（命名可商议）：

```jsonc
{
  // ...现有字段...
  "same_network": true,   // 网关判定：收发双方同一网络
  "same_device":  false   // 网关判定：收发双方同一设备（路径 A）
}
```

可选：附带判定依据，便于应用侧调试与分级提示：

```jsonc
{
  "proximity": {
    "same_network": true,
    "same_device": false,
    "basis": "egress_ip",        // egress_ip | nat | lan_subnet | device_id ...
    "asserted_by": "gateway"     // 标明这是网关断言
  }
}
```

### 5.2 SDK → 应用（message 事件透出）

SDK 在**成功解密路径**（`client.js:4722-4740`）构造的 result 中，把上述信封字段透出：

```js
const result = {
  // ...现有字段...
  same_network: msg.same_network,        // 来自网关信封
  same_device:  msg.same_device,         // 来自网关信封（路径 A）
  sender_device_id: aad.from_device,     // 路径 B：把 AAD 里的发送方设备 ID 也透出
};
```

> 路径 B 仅需 SDK 在成功路径补一行 `from_device` 透出，应用即可自行比对 device_id，
> 无需网关参与，且因 `from_device` 已签入 AAD 而具备防伪造性。两条路径可并存。

## 6. 应用侧（EvolClaw）落地路径

信号到达 `message.received` 事件后，EvolClaw 内部已有成熟的「字段 → 上下文变量 → 提示词」通路，
参照现有 `encrypted` / `peerRole` 的流法即可，改动集中且小：

1. **AUN channel**（`src/channels/aun.ts` `handleIncomingPrivateMessage`）
   从事件读 `same_network` / `same_device`（或比对 `sender_device_id`），写入 `replyContext.metadata`。
2. **InboundMessage / ReplyContext**（`src/types.ts`）新增对应字段。
3. **MessageProcessor**（`src/core/message/message-processor.ts`）把字段写进 `KitRenderContext.vars`，
   如 `sameNetwork` / `sameDevice`。
4. **ECK fragment**（`kits/templates/system-fragments/`）加条件块，按标记注入提示，例如：
   > 对端与你在同一设备上，可考虑本地文件 / IPC 直连，无需经网络传输大文件。

## 7. 对各方的改动清单

| 方 | 改动 | 说明 |
|----|------|------|
| **网关** | 计算 `same_network` / `same_device`，写入下发信封 | 唯一能算「同网络」的一方；需先定义「同网络」语义 |
| **SDK** | 成功解密路径透出 `same_network` / `same_device`；并透出 `sender_device_id`(=`aad.from_device`) | 当前成功路径吃掉了这些字段（见 §3.2） |
| **EvolClaw** | 读字段 → ctx var → ECK fragment 提示词 | 本仓可独立完成，等上游字段到位即可接通 |

## 8. 待确认问题（给网关 / SDK 方）

1. **「同网络」的判定口径**：同公网出口 IP / 同 NAT / 同局域网段？（§4.1）
2. **字段命名与结构**：扁平 `same_network`/`same_device`，还是 §5.1 的 `proximity` 对象？
3. **信任模型**：是否需要可验证的「同设备」证明（路径 B），还是网关断言（路径 A）即可满足？
4. **群消息**：是否也需要逐发送者的 proximity 标记？（群场景一条消息对应一个发送者，机制同 P2P）
5. **隐私**：proximity 标记是否对所有对端无条件下发，还是需要可见性策略（如仅同 issuer）？

## 9. 附：关键代码引用

| 位置 | 内容 |
|------|------|
| `client.js:4722-4740` | 成功解密 P2P 路径构造 result（当前不含发送方设备/proximity） |
| `client.js:4643` | 接收侧读取 `aad.from_device`（仅失败分支透出为 `_sender_device_id`） |
| `client.js:4663` / `4688` | `_sender_device_id` 仅出现在解密失败事件 |
| `v2/e2ee/encrypt-p2p.js:65` | 发送侧写入 `from_device: sender.deviceId` |
| `v2/e2ee/encrypt-group.js:47` | 群消息发送侧写入 `from_device` |
| `config.js:48` | `getDeviceId(aunRoot)`：读/生成 `{root}/.device_id`，同机同目录共享 |
| `aid-store.js:88` | 未传 deviceId 时回落 `getDeviceId(this.aunPath)` |
| `src/channels/aun.ts:972` | EvolClaw 入站私聊处理入口 |
| `src/channels/aun.ts:1063` | 现有 `replyContext.metadata = { encrypted, chatmode }`（新字段挂载点） |
| `src/core/message/message-processor.ts` | 组装 `KitRenderContext.vars`（注入 ECK 上下文） |
