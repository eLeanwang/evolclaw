# EvolClaw 实例生命周期管理设计

## 概述

本文档定义 EvolClaw 进程实例和 AID 连接的生命周期管理方案。核心思路：每个 EVOLCLAW_HOME 通过 `{HOME}/data/instance/` 目录自管自己的进程，不再依赖跨进程读取环境变量或全局锁文件。

## 设计原则

1. **EVOLCLAW_HOME 是隔离单位** — 每个实例的数据、进程记录、AID 状态完全独立
2. **进程自己读自己的 HOME** — `process.env.EVOLCLAW_HOME` 三大平台都能可靠读到，不再跨进程读 env
3. **PID + 启动时间双校验** — 防止 PID 复用误杀，不依赖命令行匹配
4. **文件位置即归属** — 文件在哪个 HOME 下就属于哪个实例，无需额外标识
5. **保守原则** — 拿不到启动时间时跳过不杀，宁留孤儿不误杀

## 目录结构

```
{EVOLCLAW_HOME}/data/instance/
├── main-<pid>.json              主服务进程
├── restart-monitor-<pid>.json   restart-monitor 进程（仅重启期间存在）
└── aid-<pid>.jsonl              所有 AID 事件流（追加写）
```

文件生命周期 = 进程生命周期。进程正常退出时删除自己的文件，异常退出时由下次启动清理。

## 文件格式

### main-\<pid\>.json

```json
{
  "pid": 12345,
  "startedAt": 1716000000,
  "startedAtIso": "2026-05-16T08:00:00Z",
  "launchedBy": "start"
}
```

`launchedBy` 取值：
- `start` — CLI 直接 `evolclaw start`
- `restart-cli` — CLI `evolclaw restart`
- `restart-network` — 来自渠道的 `/restart` 命令
- `self-heal` — restart-monitor 自愈修复后启动

### restart-monitor-\<pid\>.json

```json
{
  "pid": 12346,
  "startedAt": 1716000000,
  "startedAtIso": "2026-05-16T08:00:00Z",
  "launchedBy": "restart-monitor"
}
```

### aid-\<pid\>.jsonl

所有 AID 共用一个文件，每行一个 JSON 事件，追加写入：

```jsonl
{"ts":1716000010,"iso":"2026-05-16T08:00:10Z","event":"connected","aid":"alice.agentid.pub","gateway":"wss://..."}
{"ts":1716000050,"iso":"2026-05-16T08:00:50Z","event":"message_in","aid":"alice.agentid.pub","from":"bob.agentid.pub","msgId":"m1","kind":"text","len":234}
{"ts":1716000060,"iso":"2026-05-16T08:01:00Z","event":"message_out","aid":"alice.agentid.pub","to":"bob.agentid.pub","msgId":"m2","kind":"text","len":512}
{"ts":1716000080,"iso":"2026-05-16T08:01:20Z","event":"message_in","aid":"bob.agentid.pub","from":"carol.agentid.pub","msgId":"m3","kind":"file","len":102400}
{"ts":1716000120,"iso":"2026-05-16T08:02:00Z","event":"disconnected","aid":"alice.agentid.pub","reason":"flap","lifetimeMs":110000}
```

事件类型：
- `connected` — AID 连线成功
- `disconnected` — AID 断线（含 reason、lifetimeMs）
- `message_in` — 收到消息（含 from、msgId、kind、len、groupId）
- `message_out` — 发出消息（含 to、msgId、kind、len、groupId）

不轮转。进程退出时删除文件。

## 流程定义

### start 流程

```
1. 确保 {HOME}/data/instance/ 目录存在
2. 扫描目录下所有文件
3. 处理 main-<pid>.json：
   a. 解析 pid + startedAt
   b. 检查 pid 是否存活 + getProcessStartTime(pid) 与 startedAt 容差 2s
   c. 匹配（进程有效）：
      → 报告 "已在运行 (PID: xxx, 启动于 xxx)"
      → 解析 aid-<pid>.jsonl 尾部，报告各 AID 状态：
          "✓ alice.agentid.pub — 在线，最后活动 2分钟前"
          "✗ bob.agentid.pub — 最后活动 3小时前（可能已断线）"
      → 提示 "如需强制重启，使用 evolclaw restart"
      → 退出
   d. 不匹配（pid 死了或被复用）：
      → 如果 pid 还活着但时间不匹配：跳过不杀（PID 已被其他程序复用）
      → 删除 main-<pid>.json
4. 处理 restart-monitor-<pid>.json：同样 pid + 时间检查
   → 有效：杀掉（它不该在 start 时还活着）
   → 无效：删文件
5. 处理 aid-<pid>.jsonl：直接删除（属于旧实例的残留）
6. 启动新主进程
7. 写 main-<newpid>.json
```

### restart 流程（统一走 restart-monitor 模式）

CLI `evolclaw restart` 和群聊 `/restart` 统一走同一条路径：

```
CLI 端：
1. 检查 main-<pid>.json 是否存在且有效
   → 不存在 / 无效 → 直接走 start 流程
2. spawn restart-monitor (detached)
3. 轮询 ready.signal（30s 超时）
4. 成功 → 打印 "✓ Restarted (PID: xxx)" 退出
5. 超时 → 打印 "✗ Restart failed, check logs" 退出

restart-monitor 内部：
1. 写 restart-monitor-<pid>.json
2. 向旧主进程发 SIGTERM
3. 等旧 pid 退出（30s 超时 → SIGKILL）
   旧进程退出时自己清理 main-*.json + aid-*.jsonl
4. 等 3s（端口/文件锁释放）
5. 检查升级（tryUpgrade）
6. 启动新主进程
   新进程写 main-<newpid>.json，开始写 aid-<newpid>.jsonl
7. 等 ready.signal（15s 超时）
8. 成功 → 删 restart-monitor-<pid>.json，退出
9. 失败 → self-heal 重试（最多 3 次）
10. 全部失败 → 通知渠道，删 restart-monitor-<pid>.json，退出
```

### 正常关闭流程

```
SIGINT / SIGTERM → shutdown handler:
1. 断开所有渠道
   → 每个 AID 断线事件追加到 aid-<pid>.jsonl
2. 关闭 SQLite
3. 删除 main-<pid>.json
4. 删除 aid-<pid>.jsonl
5. process.exit(0)

process.on('exit') 兜底（同步）：
  删除 main-<pid>.json（如果还在）
  删除 aid-<pid>.jsonl（如果还在）
```

### 异常崩溃恢复

| 场景 | 恢复方式 |
|------|---------|
| 主进程被 kill -9 / OOM | instance/ 文件残留，下次 start 时 Phase 3-5 清理 |
| restart-monitor 崩溃 | restart-monitor-<pid>.json 残留，下次 start 时清理 |
| 文件写入中途崩溃 | JSON 解析失败 → 当作无效文件删除 |
| 主进程崩溃但 Gemini 子进程还在 | Gemini 子进程无父进程后自然退出（stdio pipe 断裂） |

## 跨平台进程启动时间获取

统一到秒级精度，容差 2 秒。

### Linux

```typescript
// /proc/<pid>/stat 第 22 字段 (starttime, jiffies since boot)
// + /proc/uptime 计算绝对时间
const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
const starttimeJiffies = parseInt(fields[19], 10);
const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);
const bootTimeMs = Date.now() - uptime * 1000;
const startedAtMs = bootTimeMs + (starttimeJiffies / 100) * 1000;
```

### macOS

```typescript
// ps -p <pid> -o lstart=
// 输出格式："Fri May 16 08:00:00 2026"
const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='],
  { encoding: 'utf-8', timeout: 5000 }).trim();
const startedAtMs = Date.parse(out);
```

### Windows

```typescript
// PowerShell Get-CimInstance Win32_Process
// 输出格式："20260516080000.000000+480"
const out = execFileSync('powershell', ['-NoProfile', '-Command',
  `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate`
], { encoding: 'utf-8', timeout: 8000 }).trim();
// 解析 yyyyMMddHHmmss.ffffff±TZZ 格式
```

### 容错

拿不到启动时间时（PowerShell 被禁用、/proc 未挂载等极端情况）→ 返回 null → 保守不杀该 PID。

### 比对函数

```typescript
function startTimeMatches(recorded: number, actual: number | null): boolean {
  if (actual === null) return false;
  return Math.abs(recorded - actual) < 2000;  // 2 秒容差
}
```

## 废弃的旧机制

以下机制在本方案实施后全部删除：

| 旧机制 | 文件位置 | 替代 |
|--------|---------|------|
| `evolclaw.pid` | `{HOME}/logs/evolclaw.pid` | `instance/main-<pid>.json` |
| AID 单例锁 | `~/.aun/AIDs/<aid>/.evolclaw.lock` | `instance/aid-<pid>.jsonl` |
| `singleton-lock.ts` | `src/utils/singleton-lock.ts` | 删除整个文件 |
| `getProcessEnv` | `src/utils/cross-platform.ts` | 删除该函数 |
| 孤儿扫描 | `src/cli.ts:223-235` | 删除（instance/ 目录自管） |
| `isRunning(pidFile)` | `src/cli.ts` | 替换为读 instance/ 文件 |
| `releaseAllLocks` 调用 | `src/index.ts` | 删除 |
| `tryAcquireLock/probeLock/releaseLock` 调用 | `src/channels/aun.ts` | 删除 |

## 新增文件

| 文件 | 职责 |
|------|------|
| `src/utils/process-introspect.ts` | 跨平台 `getProcessStartTime(pid)` + `startTimeMatches()` |
| `src/utils/instance-registry.ts` | instance/ 目录读写：`writeMain()`, `writeRestartMonitor()`, `appendAidEvent()`, `readAll()`, `cleanup()`, `removeAll()` |

## 受影响的现有文件

| 文件 | 改动 |
|------|------|
| `src/cli.ts` | cmdStart 重写启动检查；cmdRestart 改走 monitor；删除 isRunning/stopAndWait 中的 PID 文件逻辑 |
| `src/index.ts` | 启动时写 main-<pid>.json；shutdown 时删文件；删除 releaseAllLocks |
| `src/channels/aun.ts` | 删除 singleton-lock 相关调用；连线/断线/收发消息时调 appendAidEvent |
| `src/utils/cross-platform.ts` | 删除 getProcessEnv 函数 |
| `src/utils/singleton-lock.ts` | 删除整个文件 |
| `src/paths.ts` | resolvePaths() 增加 instanceDir 路径 |
| `src/core/command-handler.ts` | /restart 命令改走统一 monitor 模式 |
| `src/agents/gemini-runner.ts` | 暂不追踪（Gemini 子进程随 stdio pipe 断裂自然退出） |

## 实施顺序（建议）

1. 新增 `process-introspect.ts`（跨平台启动时间获取）
2. 新增 `instance-registry.ts`（instance/ 目录操作）
3. `paths.ts` 增加 instanceDir
4. `index.ts` 改造：启动写 main、shutdown 删文件、AID 事件追加
5. `aun.ts` 改造：删除 singleton-lock 调用，接入 appendAidEvent
6. `cli.ts` 改造：start 检查改读 instance/、restart 统一走 monitor
7. 删除旧文件和旧逻辑
8. 测试验证

每一步可独立提交，逐步替换。
