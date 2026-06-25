# SDK 上下文加载机制研究报告

> 日期：2026-03-17
> 目的：搞清 Claude Agent SDK `query()` 与 Claude Code CLI 在配置/上下文发现上的差异，明确 EvolClaw 需要手动补齐哪些加载逻辑。

## 核心结论

**SDK `query()` 是一个纯净的 API 调用，不会自动读取任何本地配置文件。** 所有 CLI 自动发现的配置（CLAUDE.md、settings.json、mcp.json、plugins）在 SDK 模式下都需要调用方手动加载并通过参数传入。

## 验证方法

在全局 `~/.claude/CLAUDE.md` 和项目级 `{cwd}/CLAUDE.md` 中分别注入唯一标记字符串，然后通过 SDK `query()` 让模型判断是否能在 system instructions 中看到该标记。

测试覆盖以下组合：

| 场景 | 全局标记 | 项目标记 | git 仓库 | systemPrompt 参数 | 结果 |
|------|:-:|:-:|:-:|:-:|:-:|
| 非 git 目录，无 systemPrompt | 有 | — | 无 | 无 | NOT_FOUND |
| 非 git 目录，preset | 有 | — | 无 | preset | NOT_FOUND |
| 非 git 目录，项目级 | — | 有 | 无 | 无 | NOT_FOUND |
| git 仓库，无 systemPrompt | — | 有 | 有 | 无 | NOT_FOUND |
| git 仓库，preset | — | 有 | 有 | preset | NOT_FOUND |
| git 仓库，preset+append | — | 有 | 有 | preset+append | NOT_FOUND |

**结论：所有场景下 SDK 均不自动加载 CLAUDE.md。**

对 settings.json 的验证（plugins、env）同样确认 SDK 不读取：
- plugins 提供的 MCP 工具在 SDK 模式下不可用
- settings.json 中定义的 env 变量不会被 SDK 注入

## CLI vs SDK 完整对比

| 配置文件 | CLI 自动加载 | SDK 自动加载 | SDK 注入方式 | EvolClaw 当前状态 |
|----------|:-:|:-:|---|---|
| `~/.claude/CLAUDE.md` | ✅ | ❌ | `systemPrompt.append` | ✅ 已处理 |
| `{cwd}/CLAUDE.md` | ✅ | ❌ | `systemPrompt.append` | ❌ **遗漏** |
| `{cwd}/.claude/CLAUDE.md` | ✅ | ❌ | `systemPrompt.append` | ❌ **遗漏** |
| `~/.claude/mcp.json` | ✅ | ❌ | `mcpServers` 参数 | ✅ 已处理 |
| `~/.claude/settings.json` (plugins) | ✅ | ❌ | 无对应参数 | ❌ 不可用 |
| `~/.claude/settings.json` (env) | ✅ | ❌ | `env` 参数 | ⚠️ 仅部分 (`ANTHROPIC_BASE_URL`) |
| `~/.claude/settings.json` (model) | ✅ | ❌ | `model` 参数 | ✅ 已处理 |
| `~/.claude/settings.json` (permissions) | ✅ | ❌ | `permissionMode` + `canUseTool` | ⚠️ 用 hook 替代 |
| `{cwd}/.claude/settings.local.json` | ✅ | ❌ | 无对应参数 | ❌ 不生效 |

## 三层目录结构

```
~/.claude/                          ← 全局级
├── CLAUDE.md                       ← 全局指令（所有项目生效）
├── settings.json                   ← 全局设置（plugins、model、env、permissions）
├── settings.local.json             ← 本机全局设置（不提交 git）
├── mcp.json                        ← 全局 MCP 服务器配置
├── skills/                         ← 全局 skills
└── projects/{encoded-path}/        ← SDK 会话存储（JSONL 文件）

{projectPath}/                      ← 项目级
├── CLAUDE.md                       ← 项目共享指令（提交到 git，团队共享）
└── .claude/
    ├── CLAUDE.md                   ← 项目私有指令（不提交 git，个人偏好）
    ├── settings.json               ← 项目共享设置
    ├── settings.local.json         ← 项目本机设置（权限白名单等）
    ├── skills/                     ← 项目级 skills
    └── mcp.json                    ← 项目级 MCP 配置
```

## CLAUDE.md 两个位置的区别

| 文件 | Git 可见性 | 用途 |
|------|-----------|------|
| `{project}/CLAUDE.md` | ✅ 提交到 git | 项目架构、开发规范、命令说明——团队共享 |
| `{project}/.claude/CLAUDE.md` | ❌ 在 .gitignore 中 | 个人偏好、本地路径、私有配置——个人私有 |

CLI 加载时两个都读，合并到上下文中。

## mcp.json vs CLAUDE.md 加载方式差异

两者在 EvolClaw 中的加载方式不同，原因是 SDK API 的约束：

- **`mcpServers` 参数** — SDK 提供了显式参数接收 MCP server 配置，需要启动子进程/管理连接生命周期
- **`systemPrompt.append`** — CLAUDE.md 只是文本指令，SDK 没有专门参数，只能通过 system prompt 拼接注入

不是设计选择，是 API 形状决定的。

## SDK 与 CLI 的关系

类比：SDK `query()` 之于 Claude Code CLI，类似 Docker Engine API 之于 `docker` CLI。

- CLI 做了大量配置发现和环境准备（CLAUDE.md 扫描、settings 加载、plugin 初始化、MCP 启动）
- SDK 只是底层执行引擎，接收显式参数，不做隐式发现
- EvolClaw 作为网关，需要自己复刻 CLI 的配置加载逻辑

## EvolClaw 当前加载逻辑（agent-runner.ts）

```typescript
// 1. 全局 CLAUDE.md → systemPrompt.append（行 119-127）
const globalClaudeMd = fs.readFileSync('~/.claude/CLAUDE.md', 'utf-8');

// 2. 全局 MCP → mcpServers 参数（行 130-139）
const globalMcpServers = JSON.parse(fs.readFileSync('~/.claude/mcp.json'));

// 3. 拼接 system prompt（行 142）
const fullAppend = [globalClaudeMd, systemPromptAppend].filter(Boolean).join('\n\n');

// 4. 传入 SDK（行 144-183）
query({
  prompt,
  options: {
    cwd: projectPath,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: fullAppend },
    mcpServers: globalMcpServers,
    model, permissionMode, env, hooks, ...
  }
});
```

## 待修复项

### P0：项目级 CLAUDE.md 未加载
当用户切换项目时，目标项目的 CLAUDE.md 不会被加载到 Agent 上下文。需要在 `agent-runner.ts` 中增加：
- 读取 `{projectPath}/CLAUDE.md`
- 读取 `{projectPath}/.claude/CLAUDE.md`
- 按正确顺序拼接到 `systemPrompt.append`

建议拼接顺序：项目 CLAUDE.md → 项目 .claude/CLAUDE.md → 全局 CLAUDE.md → 频道专属提示

### P1：settings.json 中的 env 未完整传递
`~/.claude/settings.json` 的 `env` 字段包含 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 等变量，当前仅部分手动传递。应读取 settings.json 并合并到 `env` 参数。

### P2：项目级 MCP 配置未加载
如果项目有自己的 `.claude/mcp.json`，当前不会被加载。可考虑合并到 `mcpServers` 参数。

### P3：Plugins 不可用
SDK 不支持 plugins 概念。这是 SDK 层面的限制，暂时无法解决。部分 plugin 功能（如 context7 MCP）可以通过 mcp.json 替代。
