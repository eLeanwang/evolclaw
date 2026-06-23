# Agent Ctl：Agent 自主管理指令

> 当前口径更新（2026-06-11）：本文是早期 ctl 设计，权限细节以后续 slash/menu 对齐为准。`/perm <mode>` 已调整为 owner/admin 均可切换所有模式；`/file <path>` 项目内同渠道发送为 owner/admin，跨渠道发送仍仅 owner；`/restart` 是 daemon owner 进程级操作，不按当前会话 owner/admin 放行。当前实现路径也已从单文件 `src/core/command-handler.ts` 拆分为 `src/core/command/command-handler.ts` 门面、`slash-handler.ts` 与 `menu-handler.ts`。

## 概述

让 evolclaw 托管的 Agent（Claude / Codex / Gemini）能通过 `evolclaw ctl <cmd>` 自主管理运行时配置——切换模型、调整 effort、压缩上下文等。Agent 通过 Bash 工具调用 CLI，CLI 通过 IPC 与运行中服务通信，服务端复用 CommandHandler 执行指令并返回结果。

## 触发场景

- **Agent 自主判断**：运行中根据情况主动调用（如觉得模型不合适、想查看状态）
- **用户自然语言**：用户说"切到 opus"、"压缩一下上下文"，Agent 理解后调用对应指令

## 架构

```
Agent (任意后端, Bash 工具)
  │  evolclaw ctl model sonnet
  ▼
CLI (src/cli.ts → cmdCtl)
  │  读取 EVOLCLAW_SESSION_ID 环境变量
  │  ipcQuery({ type:'ctl', cmd:'/model sonnet', sessionId })
  ▼
IpcServer (src/ipc.ts)
  │  handleCommand({ type:'ctl' }) → 调用注入的 commandExecutor
  ▼
CommandHandler.handleCtl(cmd, sessionId)
  │  复用现有 slash cmd 逻辑 + 权限检查
  │  不调用 adapter.sendText，直接返回结果
  ▼
JSON → IPC 响应 → CLI stdout → Agent 读取
```

## 可用指令

Agent ctl 暴露的指令（排除 `/agent`、`/stop`、`/rewind`、`/new`、`/s`、`/p`、`/bind`、`/name`、`/del`、`/fork` 等会话/项目管理类）：

| 指令 | 参数 | 说明 | 所需角色 |
|------|------|------|---------|
| `help` | - | 帮助信息 | guest |
| `status` | - | 会话状态 | guest |
| `check` | - | 渠道健康（纯只读） | guest |
| `model` | `[model-id]` | 查看/切换模型 | 查看: admin, 切换: admin |
| `effort` | `[level]` | 查看/切换推理强度 | 查看: admin, 切换: admin |
| `perm` | `[mode]` | 查看/切换权限模式 | 查看: admin, 切换: admin |
| `compact` | - | 压缩会话上下文 | admin |
| `activity` | `[all\|dm\|owner\|none]` | 查看/控制输出显示模式 | 查看: admin, 切换: owner |
| `send` | `[channel] <path>` | 发送文件 | 同渠道项目内 admin；跨渠道 owner |
| `restart` | - | 重启服务 | daemon owner |

权限判断：IPC 请求携带 `sessionId` → 服务端查 session → 查用户角色（owner/admin/guest）→ 复用现有 CommandHandler 权限逻辑。

## 权限附带调整

本次同时调整两个现有指令的权限：

1. **`/check` 下放 guest**：所有用户可用，但非 admin 用户隐藏渠道连接详情（仅返回"健康/异常"摘要）
2. **`/check rty`（重连写操作）**：移至 `/restart` 下处理，`/check` 变为纯只读
3. **`/perm` 模式切换**：当前口径为 owner/admin 均可切换所有模式（早期“owner only”收紧方案已废弃）

## 实现计划

### 1. CLI 入口：`evolclaw ctl`（src/cli.ts）

新增 `cmdCtl(args: string[])` 函数：

```typescript
async function cmdCtl(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('用法: evolclaw ctl <command> [args...]');
    console.error('示例: evolclaw ctl model sonnet');
    process.exit(1);
  }

  const sessionId = process.env.EVOLCLAW_SESSION_ID;
  if (!sessionId) {
    console.error('错误: EVOLCLAW_SESSION_ID 未设置（仅在 evolclaw 托管环境中可用）');
    process.exit(1);
  }

  const cmd = '/' + args.join(' ');  // 拼接为 slash cmd 格式
  const socketPath = resolvePaths().socket;

  // compact/restart 等长时操作需要更长超时
  const longRunning = ['/compact', '/restart'];
  const timeout = longRunning.some(c => cmd.startsWith(c)) ? 60_000 : 10_000;

  const result = await ipcQuery(socketPath, {
    type: 'ctl',
    cmd,
    sessionId,
  }, timeout);

  if (!result) {
    console.error('错误: 无法连接 evolclaw 服务');
    process.exit(1);
  }

  const ctlResult = result as any;
  if (ctlResult.ok) {
    console.log(ctlResult.result);
  } else {
    console.error(ctlResult.error || '执行失败');
    process.exit(1);
  }
}
```

在 `main()` 的 subcommand 分发中新增 `case 'ctl'`。

### 2. IPC 扩展（src/ipc.ts）

**类型定义**：
```typescript
export interface IpcCtlRequest {
  type: 'ctl';
  cmd: string;       // 完整 slash cmd，如 "/model sonnet"
  sessionId: string;  // EVOLCLAW_SESSION_ID
}

export interface IpcCtlResponse {
  ok: boolean;
  result?: string;   // 命令输出
  error?: string;    // 错误信息
}

type CommandExecutor = (cmd: string, sessionId: string) => Promise<IpcCtlResponse>;
```

**IpcServer 改动**：
- 构造函数新增可选 `commandExecutor?: CommandExecutor` 参数
- `handleCommand` 改为 `async`，调用点改为 `await`：
  ```typescript
  // conn.on('data') 回调改为 async
  conn.on('data', async (data) => {
    // ... 解析 line ...
    const response = await this.handleCommand(cmd);
    conn.end(JSON.stringify(response) + '\n');
  });

  // handleCommand 新增 ctl case
  private async handleCommand(cmd: { type: string }): Promise<unknown> {
    switch (cmd.type) {
      case 'status':
        return this.getStatus();
      case 'ping':
        return { pong: true, pid: process.pid };
      case 'ctl': {
        if (!this.commandExecutor) return { ok: false, error: 'ctl not configured' };
        const { cmd: slashCmd, sessionId } = cmd as unknown as IpcCtlRequest;
        return await this.commandExecutor(slashCmd, sessionId);
      }
      default:
        return { error: `unknown command: ${cmd.type}` };
    }
  }
  ```

### 3. CommandHandler 适配（当前拆分为 `src/core/command/command-handler.ts` / `slash-handler.ts`）

新增 `handleCtl()` 方法：

```typescript
// Agent ctl 允许的指令白名单
private static readonly CTL_COMMANDS = [
  '/help', '/status', '/check',
  '/model', '/effort', '/perm',
  '/compact', '/activity', '/file', '/restart',
];

async handleCtl(cmd: string, sessionId: string): Promise<{ ok: boolean; result?: string; error?: string }> {
  // 1. 白名单检查
  const inputCmd = cmd.split(' ')[0];
  if (!CommandHandler.CTL_COMMANDS.includes(inputCmd)) {
    return { ok: false, error: `不允许的指令: ${inputCmd}` };
  }

  // 2. 通过 sessionId 查 session
  const session = await this.sessionManager.getSessionById(sessionId);
  if (!session) {
    return { ok: false, error: '无效的 session' };
  }

  // 3. 从 session.metadata.peerId 获取 userId（用于权限判断）
  //    peerId 在 getOrCreateSession 时写入 metadata（私聊 = userId，群聊也可能有）
  const userId = session.metadata?.peerId;

  // 4. compact 防护：不能在活跃流期间执行
  if (cmd === '/compact') {
    const agent = this.getAgent(session.agentId);
    if (agent.hasActiveStream(session.id)) {
      return { ok: false, error: '当前会话正在处理中，无法压缩上下文' };
    }
  }

  // 5. file 路径限制：只允许 projectPath 下的文件
  if (cmd.startsWith('/file')) {
    const sendArgs = cmd.slice(5).trim();
    // 提取最后一个参数作为路径（/file [channel] <path>）
    const parts = sendArgs.split(/\s+/);
    const filePath = parts[parts.length - 1];
    if (filePath) {
      const resolved = path.resolve(session.projectPath, filePath);
      if (!resolved.startsWith(session.projectPath)) {
        return { ok: false, error: '路径越界：只能发送项目目录下的文件' };
      }
    }
  }

  // 6. 调用现有 handle()，不传 sendMessage 回调（结果直接返回）
  try {
    const result = await this.handle(
      cmd,
      session.channel,
      session.channelId,
      undefined,  // 不发送消息
      userId,
    );
    return { ok: true, result: result ?? '(无输出)' };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
```

**权限调整**：
- `/check`：将 `guestGroupCommands` 扩展为 `['/status', '/help', '/check']`；`/check` 处理逻辑中对非 admin 用户隐藏渠道详情
- `/check rty`（重连写操作）：移至 `/restart` 下，`/check` 变为纯只读
- `/perm` 模式切换：owner/admin 均可切换所有模式（查看保持 admin+）

### 4. IPC Executor 注入（src/index.ts）

初始化 IpcServer 时注入 commandExecutor：

```typescript
const ipcServer = new IpcServer(
  resolvePaths().socket,
  statusProvider,
  // Agent ctl executor
  async (cmd, sessionId) => cmdHandler.handleCtl(cmd, sessionId),
);
```

### 5. 环境变量注入

**关键点**：`EVOLCLAW_SESSION_ID` 是 evolclaw 内部 session ID（非 Agent SDK session ID），从 `runQuery` 参数中获取。

**`src/agents/claude-runner.ts`** — `getAgentEnv()` 中注入：
```typescript
private getAgentEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: this.apiKey,
    PATH: process.env.PATH,
    DISABLE_AUTOUPDATER: '1',
    ...(this.baseUrl ? { ANTHROPIC_BASE_URL: this.baseUrl } : {}),
    ...(this.currentSessionId ? { EVOLCLAW_SESSION_ID: this.currentSessionId } : {}),
  };
}
```

`currentSessionId`（evolclaw session ID）在 `runQuery` 时从参数设置到实例字段。

**需要注入的地方**：
- `src/agents/claude-runner.ts` — `getAgentEnv()`
- `src/agents/codex-runner.ts` — 子进程 env
- `src/agents/gemini-runner.ts` — `spawn` 的 env

### 6. System Prompt 注入（src/core/message/message-processor.ts）

在 `buildContextParts()` 的 contextParts 中追加：

```typescript
// Agent ctl 指令提示
contextParts.push(
  `[EvolClaw 自管理] 可通过 Bash 执行 \`evolclaw ctl <cmd>\` 管理运行时，详见 ${absoluteProjectPath}/.evolclaw/SKILLS.md`
);
```

### 7. SKILLS.md 生成

**位置**：`{projectPath}/.evolclaw/SKILLS.md`

**生成时机**：`MessageProcessor.processMessage()` 中，在构建 system prompt 前，检查 SKILLS.md 是否存在/版本过期，从内置模板写入或更新。

**内置模板**放在 `src/templates/skills.md`，构建时随代码发布。模板头部包含版本号，用于判断是否需要更新。

**SKILLS.md 内容**：

```yaml
---
name: evolclaw-ctl
version: 1
description: EvolClaw 运行时自管理指令，仅在 evolclaw 托管环境中可用
trigger: Agent 自主判断需要时（切换模型、调整配置、查看状态等）
---
```

```markdown
# EvolClaw Ctl

通过 `evolclaw ctl <command> [args]` 管理运行时配置。仅在 evolclaw 托管环境中可用（`EVOLCLAW_SESSION_ID` 已设置）。

## 可用指令

### 查询类（所有用户）
- `evolclaw ctl help` — 显示帮助
- `evolclaw ctl status` — 显示会话状态
- `evolclaw ctl check` — 检查渠道健康状态

### 配置类（管理员）
- `evolclaw ctl model` — 查看当前模型和可选列表
- `evolclaw ctl model <model-id>` — 切换模型（如 `opus`, `sonnet`, `haiku`）
- `evolclaw ctl effort` — 查看当前推理强度
- `evolclaw ctl effort <low|medium|high|max>` — 切换推理强度
- `evolclaw ctl compact` — 压缩当前会话上下文

### 权限类
- `evolclaw ctl perm` — 查看当前权限模式（管理员）
- `evolclaw ctl perm <mode>` — 切换权限模式（管理员）

### 运维类（仅 owner）
- `evolclaw ctl activity <all|dm|owner|none>` — 控制中间输出显示模式
- `evolclaw ctl send [channel] <path>` — 发送项目内文件（仅限项目目录内）
- `evolclaw ctl restart` — 重启服务（慎用：中断所有会话）

## 使用示例

```bash
# 查看当前模型
evolclaw ctl model

# 切换到 opus
evolclaw ctl model opus

# 降低推理强度以加快响应
evolclaw ctl effort low

# 压缩上下文
evolclaw ctl compact

# 查看服务状态
evolclaw ctl status
```

## 注意事项

- 仅在 evolclaw 托管环境中可用（EVOLCLAW_SESSION_ID 环境变量已设置时）
- 权限继承当前会话用户的角色（owner / admin / guest）
- `compact` 不能在当前会话处理消息期间执行（会自动拒绝）
- `send` 只能发送项目目录下的文件（路径越界会被拒绝）
- `restart` 会中断当前所有会话，谨慎使用
```

## 边界情况与防护

| 场景 | 处理方式 |
|------|---------|
| session 表无 userId 列 | 使用 `session.metadata.peerId` 作为 userId 传入 `resolveIdentity()` |
| Agent 在活跃流期间调 compact | `handleCtl` 检查 `hasActiveStream()`，拒绝并返回错误 |
| IPC 超时（compact/restart 耗时长） | CLI 对长时操作使用 60s 超时（默认 10s） |
| Agent 通过 send 发送项目外文件 | `handleCtl` 校验 `path.resolve()` 必须在 `session.projectPath` 下 |
| self-heal 子进程无 EVOLCLAW_SESSION_ID | CLI 进程不经过 Agent runner，天然隔离，无需额外处理 |
| restart 导致 IPC 连接断开 | CLI 已有 "无法连接" 错误处理，Agent 可理解并重试 |
| peerId 为空（群聊匿名用户） | `resolveIdentity` 返回 `anonymous`，仅可用 guest 级指令 |

## 需要新增/修改的文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/cli.ts` | 修改 | 新增 `ctl` 子命令 |
| `src/ipc.ts` | 修改 | 新增 `ctl` 命令类型，`handleCommand` 改 async，调用点 await |
| `src/core/command/command-handler.ts` / `slash-handler.ts` | 修改 | 新增 `handleCtl()`；`/check` 下放 guest；`/perm` 切换按当前 admin+ 口径 |
| `src/index.ts` | 修改 | IpcServer 构造时注入 commandExecutor |
| `src/agents/claude-runner.ts` | 修改 | `getAgentEnv()` 注入 `EVOLCLAW_SESSION_ID` |
| `src/agents/codex-runner.ts` | 修改 | 子进程 env 注入 `EVOLCLAW_SESSION_ID` |
| `src/agents/gemini-runner.ts` | 修改 | spawn env 注入 `EVOLCLAW_SESSION_ID` |
| `src/core/message/message-processor.ts` | 修改 | buildContextParts 注入 SKILLS.md 路径提示 + 生成 SKILLS.md |
| `src/templates/skills.md` | 新增 | SKILLS.md 内置模板（含版本号） |

## 不做的事

- 不新增 MCP tool 或 SDK custom tool
- 不修改 AgentRunner 接口签名（仅内部注入 env）
- Agent 不能调用会话/项目管理类指令（`/s`、`/p`、`/new`、`/agent`、`/stop`、`/rewind` 等）
- 不新增配置项
