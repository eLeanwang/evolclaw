# AUN message.send 1062 错误分析报告

> 时间：2026-05-14
> 受影响：evolclaw（H:\project\evolclaw） + AUN TS SDK（H:\project\kite\aun-sdk-core\ts）
> 现象：对端 `evolapp.agentid.pub` 发送 `/status`、`/p` 后未收到任何回复

---

## 1. TL;DR

- **现象**：evolclaw 服务在 AUN 链路 79 秒短暂断连后重连成功，随即对两条入站命令的回复消息全部被网关 RPC 拒绝，错误码 `AUNError(-32603)`，错误内容是 MySQL `1062 Duplicate entry ... for key 'message_device_delivery.uk_owner_device_message'`。
- **根因定位**：错误来自 **AUN Gateway 服务端**，在 `(owner_aid, device_id, message_id)` 三元唯一索引上写 `message_device_delivery` 行时发生主键冲突。该冲突由 server 在断连期间残留的 delivery 行与重连后新分配的 message_id 撞键造成，**不是 evolclaw / SDK 客户端的问题**。
- **加重因素**：evolclaw `aun.ts` 的 `sendMessage` 错误分支在收到此类网关 RPC 错误时没有任何重试、降级或上抛，只打了一行 `logger.error` 就返回成功语义，导致上层 `MessageProcessor` 认为消息已发，对端"自然"收不到。

---

## 2. 关键时间线（2026-05-14 本地时间）

| 时间 | 事件 |
|---|---|
| `00:33:44` | 服务启动；AUN 通道初始化、网关发现、认证、连接成功（`aun-20260514-00.log`） |
| `00:35:32 ~ 00:36:01` | evolapp 发起 `/help`、`/p`、`/evolhelp`，evolclaw 全部正常回复，`message.send.ok` 一气呵成 |
| `00:36:27.875` | **链路断开**：`connection.state state=disconnected error=null`；SDK 立即进入 reconnect attempt 1 |
| `00:36:27 ~ 00:37:45` | reconnect 重试中（约 78 秒） |
| `00:37:45.475` | **重连成功**：`connection.state state=connected gateway=wss://gateway.agentid.pub:20001/aun` |
| `00:38:15.215` | 收到 evolapp 入站消息 seq=105 `/status`，**带 `persist:true`**（持久化兜底通道下发） |
| `00:38:15.216` | 收到 evolapp 入站消息 seq=106 `/p` |
| `00:38:15.244` | evolclaw 调 `message.send` 回发 `/status` 响应（`encrypt:false`） |
| `00:38:15.255` | evolclaw 调 `message.send` 回发 `/p` 响应（`encrypt:false`） |
| `00:38:15.325` | 网关返回 `AUNError(-32603)`：`(1062, "Duplicate entry 'evolapp.agentid.pub-727ab033-73fc-4bcb-98ca-1bba3245232e-40af2a8' for key 'message_device_delivery.uk_owner_device_message'")` |
| `00:38:15.328` | 网关再次返回 `AUNError(-32603)`：`(1062, "Duplicate entry 'evolapp.agentid.pub-727ab033-73fc-4bcb-98ca-1bba3245232e-3461ec9' ...")` |
| `00:38:15` 之后 | 主日志再无任何写入，进程是否仍存活待确认（`evolclaw.pid=820`，`tasklist` 中已不存在该 PID 的 node 进程） |

---

## 3. 错误现场

### 3.1 网关返回的两次错误

```
(1062, "Duplicate entry 'evolapp.agentid.pub-727ab033-73fc-4bcb-98ca-1bba3245232e-40af2a8'
        for key 'message_device_delivery.uk_owner_device_message'")
(1062, "Duplicate entry 'evolapp.agentid.pub-727ab033-73fc-4bcb-98ca-1bba3245232e-3461ec9'
        for key 'message_device_delivery.uk_owner_device_message'")
```

字段拆解：
- `owner_aid` = `evolapp.agentid.pub`（投递归属方，对端 AID）
- `device_id` = `727ab033-73fc-4bcb-98ca-1bba3245232e`（**两次相同** — 是 evolapp 名下的某台投递设备）
- `message_id` 后缀 = `40af2a8` / `3461ec9`（**两次不同**）
- 唯一索引 `uk_owner_device_message` 由 `(owner_aid, device_id, message_id)` 组成

### 3.2 evolclaw 入站消息上的 `device_id`

入站日志中只出现 evolapp 端的 `device_id=2c292ff4-749c-4f3d-93d2-755628137ab4`，并不是 1062 错误中的 `727ab033-...`。这说明：
- `727ab033-...` 是 server 端 `message_device_delivery` 投递视图里另一条 evolapp 设备记录，是网关侧维护的"目标设备"集合的一员。
- 两次错误命中**同一台目标设备**、不同 message_id —— 不是同一条消息的幂等重发。

### 3.3 本地 device_id

```
~/.aun/.device_id  →  2c292ff4-749c-4f3d-93d2-755628137ab4
```

evolclaw 自身的 device_id 与 evolapp 入站消息上的 device_id 一致（同机），与错误中的 `727ab033-...` 不同。所以**冲突主体是网关的 evolapp 投递行**，evolclaw 这边没有控制权。

---

## 4. 排除项：客户端没有制造重复 message_id

### 4.1 SDK 明文路径不会注入 `message_id`

`H:\project\kite\aun-sdk-core\ts\src\client.ts` 中 `message.send` 入口：

```ts
// client.ts:804-812
if (method === 'message.send') {
  const encrypt = p.encrypt ?? true;
  delete p.encrypt;
  if (encrypt) {
    return await this._sendEncrypted(p);
  }
  delete p.protected_headers;
  delete p.headers;
}
```

明文分支落到 `this._transport.call(method, p, callTimeout)`（`client.ts:847-850`），不会主动塞 `message_id`。`message_id` 由 **网关 server 端** 分配并写入 `message_device_delivery`。

只有以下三个路径会主动生成 `message_id`：
- `_sendEncrypted`（加密 P2P）：`client.ts:1038`、`1103`、`1154`
- `_putGroupThoughtEncrypted`、`_putMessageThoughtEncrypted`（thought）

evolclaw `/status`、`/p` 这两次回复 `encrypt:false`（aun trace 里清晰可见），所以没有客户端 message_id。

### 4.2 SDK 重连不会重放任何旧 RPC

`H:\project\kite\aun-sdk-core\ts\src\transport.ts:175-214` 的 `RPCTransport.close()`：

```ts
async close(): Promise<void> {
  this._closed = true;
  for (const [id, pending] of this._pending) {
    clearTimeout(pending.timer);
    pending.reject(new ConnectionError('transport closed'));
  }
  this._pending.clear();
  ...
}
```

断连时所有 pending RPC 直接 reject。重连循环 `_reconnectLoop`（`client.ts:5362-5437`）只重建 WebSocket、重新认证，**不缓存、不重放**任何用户层 RPC 调用。

### 4.3 SDK 明文 `message.send` 没有任何客户端重试

- `transport.call` 超时/错误直接 reject（`transport.ts:234`、`241`）。
- `client.call` 里**只有加密 P2P** 有一次 retryable peer-material 重试（`client.ts:1113-1119`）。明文 `message.send` 走完 `_transport.call` 后立刻冒泡。

### 4.4 JSON-RPC id 也每次新生

```ts
// transport.ts:228
const rpcId = `rpc-${crypto.randomBytes(8).toString('hex')}`;
```

每次调用全新 16 hex bytes，永远不会撞。

### 4.5 evolclaw 业务层只调用一次

`H:\project\evolclaw\src\channels\aun.ts:1037` `sendMessage` 内：

```ts
const result = await this.callAndTrace<any>('message.send', params);
```

每条业务回复在主流程里只 await 一次，无循环、无 retry。两次 `/status` 与 `/p` 是两条独立调用、产生两次独立 RPC，分别返回了不同 message_id 的 1062 —— 进一步证明客户端不存在 message_id 复用。

**结论：客户端（应用层 + SDK）所有可能制造 `(owner, device, message_id)` 重复的路径都被排除。**

---

## 5. 根因分析

### 5.1 错误来源

`message_device_delivery` 是网关侧表，用于把一条逻辑消息展开成"每个目标设备一条投递行"。其唯一索引 `uk_owner_device_message = (owner_aid, device_id, message_id)` 防止同一目标设备上同一条消息被重复入库。

写这张表是网关的责任。客户端从未发送 `message_id`，所以**`message_id` 由网关生成 → 写表 → 撞索引 → 返回 1062**。这是一个 server-side 错误。

### 5.2 触发场景：断连期间遗留 delivery 行 vs 重连后新分配 message_id

最可能的链路（基于现有日志的推断）：

1. `00:36:27` 链路异常断开，原因 `null`（既非 server kick，也非业务 close code）。属于网络抖动 / 网关临时不可用。
2. 断开瞬间网关侧可能有正在写入的 delivery 行处于半完成态；evolapp 名下设备 `727ab033-...` 这一行的 `message_id` 已分配并落入数据库（或落入网关恢复队列），但客户端从未收到对应的 `message.send.ok`。
3. `00:37:45` SDK 重连成功；网关恢复 evolapp 这条会话的投递视图。**网关的 message_id 分配游标 / ID 池可能未正确推进，或残留行未清理**。
4. `00:38:15` evolclaw 发新回复，网关再为新 delivery 分配 message_id。新值与第 2 步残留行的 `(owner, device, message_id)` 撞键 → 1062。
5. `/status` 撞了一次，紧接着 `/p` 撞第二次（不同 message_id 但**同一对 (owner, device)**）。这强烈提示该设备的 ID 池或残留队列出了问题，而不是单条消息的偶发碰撞。

### 5.3 为什么 evolclaw 这边业务上"对方收不到"

错误处理路径过窄。`H:\project\evolclaw\src\channels\aun.ts:1044-1073`：

```ts
} catch (e) {
  if (encrypt && e instanceof E2EEError) {
    // 仅 E2EE 加密失败时降级明文重试
    ...
  } else {
    this.trace('OUT', 'send.error', { channelId, error: String(e) });
    logger.error(`[AUN] Send failed to ${channelId}: ${e}`);
  }
}
```

- 只对 `E2EEError` 做降级；
- 对网关 `AUNError(-32603)` 之类的暂态错误 **没有重试、没有上抛、没有标记会话异常**；
- `sendMessage` 函数 `Promise<void>` 正常 resolve；
- 上层 `MessageProcessor` 看到 `await sendMessage(...)` 不抛错，认为发送成功，继续推进任务、清理状态、调度后续。

最终结果：网关已拒绝消息，但 evolclaw 在业务语义上把这条响应"当作发送成功"处理 → 对端 evolapp 实际未收到。

### 5.4 进程层面的旁证

- `~/.evolclaw/logs/evolclaw.pid = 820`，但当前 `tasklist` 中已无该 PID 的 node 进程。
- 主日志在 `00:38:15.328` 之后**没有新内容**直到本次排查。
- 这两条 1062 在 channel 层未上抛、未崩溃，但其后是否被某个 unhandled rejection / 别的代码路径打死，从日志无法直接推断。需要在再次复现时核对 stdout/stderr。

---

## 6. 证据链汇总

| 论断 | 证据位置 |
|---|---|
| 错误来自服务端 MySQL 唯一键冲突 | `aun trace` 中两条 `message.send.error`，错误文本含 `for key 'message_device_delivery.uk_owner_device_message'` |
| 客户端明文 `message.send` 不会塞 message_id | `H:\project\kite\aun-sdk-core\ts\src\client.ts:804-812` |
| SDK 加密路径才生成 message_id | `client.ts:1038`、`1103`、`1154` |
| 重连不重放 pending RPC | `transport.ts:175-214`、`client.ts:5362-5437` |
| 明文 `message.send` 客户端无重试 | `client.ts:847-850`（直接 await transport），仅加密路径有 `client.ts:1113-1119` 的 peer-material 重试 |
| JSON-RPC id 每次随机 16 字节 | `transport.ts:228` |
| evolclaw 业务层只调用一次 send | `aun.ts:1037` |
| 两次错误是不同 message_id | aun trace 文件最后两条 `message.send.error` 的 `message_id` 后缀不同 |
| 两次错误打在同一台对端设备 | 错误文本中 `727ab033-...` 完全相同 |
| 本机 device_id 与错误里不同 | `~/.aun/.device_id = 2c292ff4-...` vs 错误里 `727ab033-...` |
| 错误处理只覆盖 E2EE 降级 | `aun.ts:1044-1073` |

---

## 7. 建议修复

修服务端的 1062 是网关团队的事。客户端这边能（也应该）做的是把这类暂态错误识别出来并恢复。

### 7.1 P0：识别 1062 暂态错误并退避重试

在 `H:\project\evolclaw\src\channels\aun.ts:1037` 周围加一层重试：

- 错误判定：`AUNError` + 错误文本匹配 `Duplicate entry` 或 `message_device_delivery` 或包含 `1062`。
- 退避策略：首次失败 200~500 ms 后重试一次；仍失败再延迟 1~2 s 重试一次；最多 2~3 次。
- 重试期间不要复用任何客户端构造参数（本来就没有 message_id，不必担心客户端侧重发产生的重复）。
- 全部失败后：上抛 / 触发 `send.error` 事件，**不**让 `sendMessage` 静默 resolve。

### 7.2 P1：把网关错误暴露给业务层

`sendMessage` 当前签名是 `Promise<void>`。建议任一：
- 改为返回 `{ ok: boolean; messageId?: string; error?: Error }`，或
- 失败时 `throw`，上层 `MessageProcessor` 显式捕获并能选择是否对用户回退提示（如发送失败提示，或 SDK/消息缓存重排）。

### 7.3 P2：进程存活与自愈

- 写入 `stdout.log`、`stderr` 的 unhandled rejection / uncaughtException 记录，确认 1062 之后服务是否真的死亡。
- 如果服务在 1062 后被某条悬挂 promise 打死，需补 `process.on('unhandledRejection', ...)` 防御。
- 若 `evolclaw.pid` 与 `tasklist` 不一致已是常态，可在启动时校验并清理过期 pid。

### 7.4 P3：上报到网关团队的最小复现信息

- 错误文本：`(1062, "Duplicate entry 'evolapp.agentid.pub-727ab033-73fc-4bcb-98ca-1bba3245232e-<MID>' for key 'message_device_delivery.uk_owner_device_message'")`
- 触发时刻：链路断连约 78s 后重连成功，紧接着的首批明文 `message.send`。
- 怀疑点：网关在断连恢复期间对 `(owner_aid=evolapp, device_id=727ab033-...)` 这一组合的 `message_device_delivery` 行存在残留 / message_id 分配游标未推进。
- 期望：服务端在重连后清理悬挂 delivery 行，或在唯一键冲突时自旋分配新的 `message_id`、对客户端透明。

---

## 8. 结论

| 项 | 结论 |
|---|---|
| 是否 evolclaw 业务代码 bug | 否 |
| 是否 AUN TS SDK bug | 否（明显意义上） |
| 是否 AUN Gateway 服务端 bug | **是**（`message_device_delivery.uk_owner_device_message` 在断连恢复后被旧 delivery 行占坑） |
| evolclaw 是否需要改动 | **需要** —— 在错误处理上为暂态网关错误增加退避重试 + 失败上抛，以避免业务层把网关拒绝当作发送成功 |
| 影响范围 | 链路抖动后第一批未加密 `message.send` 易撞；加密路径未观察到，但同源问题理论上同样可发生 |
