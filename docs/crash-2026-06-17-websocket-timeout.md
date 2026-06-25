# EvolClaw 崩溃分析：WebSocket 连接超时未捕获错误

**日期**：2026-06-17  
**崩溃时间**：13:08:40  
**严重程度**：高（导致进程完全崩溃）

## 崩溃现象

EvolClaw 进程突然终止，没有优雅关闭。

## 根本原因

**未捕获的 WebSocket 'error' 事件导致 Node.js 进程崩溃。**

### 错误链路

1. **13:05-13:06**：AUN gateway (`gateway.agentid.pub:20001`) 网络不可达
2. **13:06-13:08**：所有 AUN 客户端 WebSocket 连接断开（closeCode=1006），健康检查持续失败
3. **13:08:40**：`evolagent.agentid.pub` 连接超时
4. **fastaun SDK 行为**：
   ```javascript
   // transport.js:446 - 连接超时触发
   connectTimeout = setTimeout(() => {
     cleanupHandshakeListeners();
     rollback();  // ← 调用 ws.close()
     reject(new ConnectionError('websocket connect timeout'));
   }, this._timeout);
   
   // transport.js:365 - rollback 函数
   const rollback = () => {
     this._ws = null;
     this._closed = true;
     try {
       ws.close();  // ← WebSocket 还在 CONNECTING 状态
     }
     catch { /* noop */ }
   };
   ```

5. **ws 库行为**：
   ```javascript
   // ws/lib/websocket.js:306
   close(code, data) {
     if (this.readyState === WebSocket.CONNECTING) {
       const msg = 'WebSocket was closed before the connection was established';
       abortHandshake(this, this._req, msg);  // ← 发出 'error' 事件
       return;
     }
   }
   
   // ws/lib/websocket.js - abortHandshake
   function abortHandshake(websocket, stream, message) {
     const err = new Error(message);
     process.nextTick(emitErrorAndClose, websocket, err);  // ← 异步发射错误
   }
   
   // ws/lib/websocket.js:1060
   function emitErrorAndClose(websocket, err) {
     websocket.emit('error', err);  // ← 没有监听器 → uncaughtException
   }
   ```

6. **Node.js 默认行为**：未监听的 'error' 事件 → `throw er; // Unhandled 'error' event` → 进程终止

### 错误日志

```
[2026-06-17 13:08:40.924][ERROR][aun_core.transport] [evolagent.agentid.pub] connect timeout
node:events:496
      throw er; // Unhandled 'error' event
      ^

Error: WebSocket was closed before the connection was established
    at WebSocket.close (/home/evolclaw/node_modules/ws/lib/websocket.js:306:7)
    at rollback (file:///home/evolclaw/node_modules/@agentunion/fastaun/dist/transport.js:365:24)
    at Timeout._onTimeout (file:///home/evolclaw/node_modules/@agentunion/fastaun/dist/transport.js:446:21)
    at listOnTimeout (node:internal/timers:588:17)
    at process.processTimers (node:internal/timers:523:7)
Emitted 'error' event on WebSocket instance at:
    at emitErrorAndClose (/home/evolclaw/node_modules/ws/lib/websocket.js:1060:13)
    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)
```

## 为什么之前没出现？

- **AUN 重连机制**通常能在连接超时前完成重连
- **Gateway 稳定时**很少触发连接超时
- **本次触发条件**：Gateway 长时间完全不可达（2-3 分钟），导致多个 AID 同时超时

## 修复方案

### 短期修复（已实施）

在 `src/index.ts` 添加全局错误处理：

```typescript
process.on('uncaughtException', (error: Error) => {
  // 检查是否是 WebSocket 连接超时相关错误
  const isWsError = error.message?.includes('WebSocket was closed before the connection was established');
  const isFastaunError = error.stack?.includes('@agentunion/fastaun');

  if (isWsError || isFastaunError) {
    logger.warn(`Caught WebSocket connection error (non-fatal): ${error.message}`);
    logger.debug(`WebSocket error stack: ${error.stack}`);
    // 不退出进程，让 AUN 重连机制处理
    return;
  }

  // 其他未捕获错误仍然是致命的
  logger.error('Uncaught exception:', error);
  console.error('Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled promise rejection:', reason);
  console.error('Unhandled promise rejection:', reason);
  // Promise rejection 不立即退出，记录后继续运行
});
```

**优点**：
- 立即生效，防止类似崩溃
- 不影响 AUN 重连机制
- 保留其他致命错误的终止行为

**缺点**：
- 治标不治本，理想情况下 SDK 应该处理这个问题

### 中期修复（TODO）

向 `@agentunion/fastaun` 提交 PR：

```typescript
// transport.ts - 创建 WebSocket 时添加错误监听器
const ws = new WebSocket(url);

// 添加空的 error 监听器，防止未捕获错误崩溃进程
ws.on('error', (err) => {
  this._logger.warn(`WebSocket error: ${err.message}`);
  // 连接失败会通过其他路径（timeout/close）处理
});
```

### 长期修复（TODO）

改进 AUN 重连策略：
- 减少连接超时时间（当前可能过长）
- 在 Gateway 不可达时更快降级到离线模式
- 添加 circuit breaker 模式，避免多个 AID 同时尝试连接

## 次要问题

日志中还发现 ServiceProxy 错误（13:01:19）：

```
[ERROR] [ServiceProxy] websocket backend task failed: 
TypeError: First argument must be a valid error code number
    at Sender.close (/home/evolclaw/node_modules/ws/lib/sender.js:190:13)
    at WebSocket.close (/home/evolclaw/node_modules/ws/lib/websocket.js:322:18)
    at file:///home/evolclaw/node_modules/@agentunion/fastaun/dist/service-proxy.js:837:29
```

**问题**：`ws.close()` 被调用时传入了无效的错误码。

**影响**：ServiceProxy WebSocket 隧道清理失败，但不会导致进程崩溃。

**TODO**：检查 `service-proxy.js:837` 调用 `ws.close()` 的代码，确保传入有效的错误码（1000-4999）。

## 验证步骤

1. **构建**：`npm run build`
2. **重启服务**：`evolclaw restart`
3. **模拟 Gateway 不可达**：
   - 修改 `/etc/hosts` 阻止 `gateway.agentid.pub` 解析
   - 观察日志，确认连接超时不再导致崩溃
4. **恢复连接**：移除 hosts 修改，确认 AUN 能自动重连

## 参考

- Node.js EventEmitter 'error' 事件：https://nodejs.org/api/events.html#error-events
- ws 库源码：`/home/evolclaw/node_modules/ws/lib/websocket.js`
- fastaun SDK 源码：`/home/evolclaw/node_modules/@agentunion/fastaun/dist/transport.js`
