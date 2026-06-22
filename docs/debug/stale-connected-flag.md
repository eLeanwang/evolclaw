# EvolClaw "假发成功" Bug 调查记录

> **症状**：长时间运行后，APP 发消息到 EvolClaw，网关把消息送到了 evolclaw，evolclaw 也走了回复流程并打日志说"发成功"，但网关侧从未收到回包。重启 evolclaw 后恢复正常。
>
> **状态**：假设已提出，正在通过日志取证。修复尚未实施。
>
> **日期**：2026-05-14

## 1. 假设

问题在 **evolclaw 自身**，不在 SDK（`@agentunion/fastaun`）。

具体：`AUNChannel.handleConnectionState`（`src/channels/aun.ts`）在收到 SDK 的 `connection.state` 事件时，对四种 state 的处理不对称：

| SDK state          | `this.connected` 怎么处理      |
| ------------------ | ------------------------------ |
| `connected`        | 设为 `true` ✅                  |
| `disconnected`     | 设为 `false` ✅                 |
| `reconnecting`     | **未修改**（保持原值）❌         |
| `terminal_failed`  | 设为 `false` ✅                 |

当 SDK 因网络抖动进入内部重连循环时：

1. SDK 发出 `connection.state: reconnecting` 事件，内部 `_state` 已切到 `'reconnecting'`
2. evolclaw 的 `this.connected` 仍然是 `true`（因为 `reconnecting` 分支没改它）
3. 此时上层调 `sendMessage`，守卫 `if (!this.connected || !this.client)` 通过
4. 进入 `callAndTrace` → `this.client.call('message.send', ...)`
5. SDK 在 `client.js:549` 的 `call()` 守卫 `if (this._state !== 'connected') throw new ConnectionError(...)` 抛异常
6. `callAndTrace` 的 catch 捕获，打 `[AUN] rpc message.send failed`，**re-throw**
7. `sendMessage` 的 catch 再捕获，打 `[AUN] Send failed to ...`，**吞掉**

→ 用户视角：消息**没发出去**，但因为错误被吞，上层任务流程认为已完成。

**重启能修复**是因为 `this.connected` 重新从 `false` 起步，只有 SDK 真正 `connected` 才会变 `true`。

## 2. 关键代码位置

- `src/channels/aun.ts:886` — `handleConnectionState`，bug 来源
- `src/channels/aun.ts:958` — `sendMessage`，受害者（守卫被 stale `connected` 骗过）
- `src/channels/aun.ts:81` — `callAndTrace`，所有 RPC 出口
- `node_modules/@agentunion/fastaun/dist/client.js:549` — SDK 的 `call()` 状态守卫，证明 SDK 不会"假报成功"

## 3. 已加的取证日志

所有埋点统一用 `[AUN][DIAG-STALE]` 前缀，便于过滤：

```bash
grep DIAG-STALE ~/.aun/logs/evolclaw.log
```

### 3.1 `handleConnectionState` 入口（`src/channels/aun.ts:890-894`）

每次 SDK 发出状态事件时，记录切换瞬间的 `connected` 标志和 SDK 内部 `_state`：

```ts
const sdkState = (this.client as any)?._state ?? 'no-client';
const connectedBefore = this.connected;
logger.info(`[AUN][DIAG-STALE] connection.state event: state=${state} attempt=${(data as any).attempt ?? '-'} | connected_before=${connectedBefore} sdk_state=${sdkState}`);
```

**预期证据**：
- 看到 `state=reconnecting connected_before=true sdk_state=reconnecting` → 即坐实 stale
- `reconnecting` 分支后续不会再修改 `this.connected`，下一条 `connection.state` 事件来时 `connected_before` 仍为 `true`

注意：`reconnecting` 分支同时加了一条注释 `// [DIAG-STALE] 故意不修改 this.connected — 这里就是要观察这个 bug`，避免后人误改。

### 3.2 `sendMessage` 入口（`src/channels/aun.ts:959-966`）

进入发消息时检测 evolclaw 标志和 SDK `_state` 是否一致：

```ts
const sdkStateOnEntry = (this.client as any)?._state ?? 'no-client';
if (this.connected !== (sdkStateOnEntry === 'connected')) {
  logger.warn(`[AUN][DIAG-STALE] sendMessage entry MISMATCH: connected=${this.connected} sdk_state=${sdkStateOnEntry} channel=${channelId} text=${text.slice(0, 40)}`);
} else {
  logger.debug(`[AUN][DIAG-STALE] sendMessage entry: connected=${this.connected} sdk_state=${sdkStateOnEntry} channel=${channelId}`);
}
```

**预期证据**：核心证据。一旦看到
```
[AUN][DIAG-STALE] sendMessage entry MISMATCH: connected=true sdk_state=reconnecting
```
说明 evolclaw 在 SDK 重连期间还在尝试发消息——假设直接坐实。

### 3.3 `callAndTrace` 调用前后（`src/channels/aun.ts:81-110`）

每次 RPC 出口检测 SDK `_state`，失败时记录错误类型：

调用前（`_state !== 'connected'` 时打 WARN）：
```ts
const sdkStateBefore = (this.client as any)?._state ?? 'no-client';
if (sdkStateBefore !== 'connected') {
  logger.warn(`[AUN][DIAG-STALE] callAndTrace ${method} on non-connected SDK: sdk_state=${sdkStateBefore} evolclaw_connected=${this.connected}`);
}
```

失败时：
```ts
const sdkStateAfter = (this.client as any)?._state ?? 'no-client';
logger.warn(`[AUN][DIAG-STALE] callAndTrace ${method} FAILED: err_name=${e?.name ?? '?'} err_code=${e?.code ?? '?'} sdk_state_before=${sdkStateBefore} sdk_state_after=${sdkStateAfter} evolclaw_connected=${this.connected}`);
```

**预期证据**：
- `err_name=ConnectionError` + `sdk_state_before=reconnecting` → 闭环：SDK 在重连，evolclaw 还在调用，被 SDK 守卫拦截
- 如果反而看到 RPC 成功但用户说没收到 → 假设需要修正，问题不在这里，可能在 E2EE 或网关 session

## 4. 复现取证流程

1. 重启 evolclaw，让它跑一段时间
2. 复现"APP 发消息但收不到回复"
3. 抓日志：
   ```bash
   grep DIAG-STALE ~/.aun/logs/evolclaw.log
   # 或在 Windows 下：
   findstr DIAG-STALE %USERPROFILE%\.aun\logs\evolclaw.log
   ```
4. 关键看三件事：
   - 复现时段内有没有 `state=reconnecting`
   - 复现时段内有没有 `sendMessage entry MISMATCH`
   - `callAndTrace ... FAILED: err_name=ConnectionError` 是不是和复现时段对应

如果三个证据都对得上 → 假设成立，按"修复方案"处理。

## 5. 修复方案（待实施）

最小改动：在 `handleConnectionState` 的 `reconnecting` 分支加 `this.connected = false`：

```ts
} else if (state === 'reconnecting') {
  this.connected = false;   // ← 修复
  // ...
}
```

修复后行为：
- SDK 重连期间 `this.connected = false`
- `sendMessage` 走 `[AUN] Cannot send: not connected` 分支，**直接拒绝**
- 等 SDK 真正重连成功（`connected` 事件），`this.connected` 才回 `true`，恢复发送

副作用：上层任务在 SDK 重连期间会收到"未发送"的反馈，需要确认上层（`message-bridge` / `interaction-router`）能否优雅处理"channel 暂时不可发"。

## 6. 相关文件

- `src/channels/aun.ts` — 全部改动
- `node_modules/@agentunion/fastaun/dist/client.js:549` — SDK call() 状态守卫
- `node_modules/@agentunion/fastaun/dist/client.js:4308` — SDK 设 `_state = 'reconnecting'` 并发布事件
