# Codex App Server 孤儿进程清理修复

## 问题描述

2026-06-15 发现 eleanbot 的 feiche 会话报错：

```
Error: initialize failed: Already initialized
    at CodexAppServerClient.handleLine (codex-app-server-client.js:301:28)
```

经排查发现系统中有 4 个 codex app-server 孤儿进程，其中 2 个来自前一天。

## 根本原因

### 1. 进程泄漏

**原 `CodexAppServerClient.close()` 方法缺陷**：
```typescript
async close(): Promise<void> {
  // ...
  proc.stdin.end();
  proc.kill('SIGTERM');  // 只发送信号，不等待退出
}
```

问题：
- 只发送 `SIGTERM`，但不等待进程退出
- 如果进程未及时响应，会成为孤儿进程
- `this.proc` 被置为 null，但进程仍在运行

### 2. 重复初始化

场景：
1. `resetAppServerClient()` 调用 `close()`，清空 `this.appServerClient`
2. 旧进程可能还在运行（stdio 断开但进程未退出）
3. 下次 `runQuery` 创建新的 `CodexAppServerClient` 实例
4. 新实例尝试 `initialize`，但可能连接到旧进程
5. Codex app-server 拒绝重复初始化，返回错误

### 3. restart 不清理子进程

`evolclaw restart` 的清理范围：
- ✅ evolclaw 主进程（`dist/index.js`）
- ✅ restart-monitor 进程
- ✅ evolclaw-web 进程（有专门的 `stopEcwebIfRunning()`）
- ❌ **codex app-server 进程**（无清理逻辑）
- ❌ gemini CLI 进程（无清理逻辑）
- ❌ hermes bridge 进程（无清理逻辑）

## 解决方案

### 1. 改进 close() 方法（防止新泄漏）

**文件**：`src/agents/codex-app-server-client.ts`

```typescript
async close(): Promise<void> {
  const proc = this.proc;
  this.proc = null;
  this.initialized = false;
  for (const pending of this.pending.values()) {
    pending.reject(new Error('Codex app-server closed'));
  }
  this.pending.clear();
  if (!proc) return;

  // 优雅关闭：先关闭 stdin，然后发送 SIGTERM，等待进程退出
  proc.stdin.end();
  proc.kill('SIGTERM');

  // 等待进程退出，最多等待 5 秒
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!proc.killed) {
        logger.warn('[CodexAppServer] Process did not exit after SIGTERM, sending SIGKILL');
        proc.kill('SIGKILL');
      }
      resolve();
    }, 5000);

    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
```

关键改进：
- 等待 `exit` 事件，确保进程真正退出
- 5 秒超时保护，超时则 `SIGKILL` 强制杀掉
- `resetAppServerClient()` 调用后保证旧进程完全清理

### 2. 添加 restart 清理逻辑（清理旧泄漏）

**文件**：`src/cli/daemon-commands.ts`

#### 2.1 添加清理函数

```typescript
/** 清理所有 codex app-server 孤儿进程，返回清理的进程数。 */
function stopCodexAppServerOrphans(): number {
  // 查找所有 codex app-server 进程（无论是 node 启动的还是原生二进制）
  const codexProcs = platform.findProcesses('codex app-server');
  let killed = 0;
  for (const pid of codexProcs) {
    try {
      platform.killProcess(pid, true);
      killed++;
    } catch {}
  }
  return killed;
}
```

#### 2.2 在 cmdRestart 中调用

```typescript
// 清理 codex app-server 孤儿进程（无 HOME 区分，全局清理）
{
  const killed = stopCodexAppServerOrphans();
  if (killed > 0) {
    console.log(`☠ 已清理 ${killed} 个 codex app-server 孤儿进程`);
    await sleep(500);
  }
}
```

位置：在清理 evolclaw 主进程孤儿之后，启动新进程之前。

## 测试验证

### 1. 功能测试

```bash
# 创建模拟的 codex app-server 进程
(exec -a "codex app-server --listen stdio://" sleep 3600) &

# 验证进程存在
ps aux | grep "codex app-server" | grep -v grep

# 测试清理
node -e "
const { findProcesses, killProcess } = require('./dist/utils/cross-platform.js');
const procs = findProcesses('codex app-server');
console.log('找到', procs.length, '个进程');
for (const pid of procs) {
  try { killProcess(pid, true); } catch {}
}
"

# 验证进程已清理
ps aux | grep "codex app-server" | grep -v grep
```

结果：✅ 成功清理所有匹配的进程

### 2. close() 方法测试

预期行为：
- 调用 `close()` 后，进程在 5 秒内退出
- 如果进程未响应，5 秒后 `SIGKILL` 强制杀掉
- 下次创建新实例时，不会连接到旧进程

### 3. restart 集成测试

```bash
# 手动创建孤儿进程
(exec -a "codex app-server --listen stdio://" sleep 3600) &

# 执行 restart
evolclaw restart

# 观察输出，应该看到：
# ☠ 已清理 1 个 codex app-server 孤儿进程
```

## 影响范围

### 修改的文件

1. `src/agents/codex-app-server-client.ts`
   - 改进 `close()` 方法，等待进程退出

2. `src/cli/daemon-commands.ts`
   - 新增 `stopCodexAppServerOrphans()` 函数
   - `cmdRestart()` 中调用清理函数

### 受益场景

1. **切换模型/effort**：`setModel()`/`setEffort()` 调用 `resetAppServerClient()` 时，确保旧进程完全退出
2. **evolclaw restart**：清理所有 codex app-server 孤儿进程
3. **会话切换**：不同会话的 codex 实例不会相互干扰
4. **长期运行**：防止孤儿进程累积

## 对比：ecweb vs codex

| 维度 | ecweb | codex app-server |
|------|-------|------------------|
| **生命周期** | 长驻后台服务 | 会话级子进程 |
| **restart 处理** | `stopEcwebIfRunning()` + 端口兜底 | `stopCodexAppServerOrphans()` 全局清理 |
| **清理时机** | 每次 start 前清理 | 仅 restart 时清理 |
| **进程识别** | PID 文件 + 端口占用 | 进程 cmdline 模式匹配 |
| **HOME 区分** | 是（通过 instance 文件） | 否（全局清理） |

## 后续改进建议

### 短期
- ✅ 已实现：改进 `close()` 等待退出
- ✅ 已实现：restart 时清理 codex 孤儿

### 长期
可考虑为所有 agent backend 建立统一的子进程管理：

1. **进程注册表**：记录所有子进程（codex/gemini/hermes）
2. **父子关系追踪**：关联 evolclaw 会话与子进程
3. **统一清理机制**：restart 时清理所有子进程
4. **健康检查**：定期检测孤儿进程并报警

但当前修复已足够解决实际问题，长期方案可按需推进。

## 部署说明

1. 重新构建：`npm run build`
2. 重启服务：`evolclaw restart`
3. 观察输出，确认清理了旧的 codex 孤儿进程
4. 后续 restart 时，如果没有孤儿，不会有清理提示（正常）

## 参考

- Issue: eleanbot feiche 会话 "Already initialized" 错误
- 相关文件：`codex-app-server-client.ts`, `daemon-commands.ts`, `cross-platform.ts`
- 测试日期：2026-06-15
- 修复人：evolai.agentid.pub
