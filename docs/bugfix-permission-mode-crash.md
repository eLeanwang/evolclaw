# Bug 修复报告：SDK permissionMode 导致进程崩溃

## 问题描述

**日期**: 2026-03-12
**严重程度**: 高（导致服务完全不可用）

EvolClaw 服务在处理用户消息时，Claude Agent SDK 子进程持续崩溃，错误信息：
```
Error: Claude Code process exited with code 1
```

## 症状

- 服务启动正常，Feishu 和 AUN 通道连接成功
- 每次用户发送消息时，SDK 子进程立即崩溃
- 错误发生在 `ProcessTransport.getProcessExitError`
- 无详细错误堆栈，仅显示退出码 1

## 根本原因

发现两个问题导致 SDK 子进程崩溃：

### 1. 错误的 permissionMode 配置

`src/agent-runner.ts` 中使用了 `permissionMode: 'bypassPermissions'`，该模式在 Claude Agent SDK v0.1.77 中会导致子进程崩溃。

**问题代码**：
```typescript
permissionMode: 'bypassPermissions',  // ❌ 导致崩溃
```

### 2. 继承 Claude Code 环境变量

EvolClaw 服务继承了父进程（Claude Code）的环境变量，导致 SDK 认为是嵌套会话：
- `CLAUDECODE=1`
- `CLAUDE_CODE_ENTRYPOINT=cli`
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- `CLAUDE_CONFIG_DIR`

## 解决方案

### 修复 1：更改 permissionMode

将 `permissionMode` 从 `'bypassPermissions'` 改为 `'dontAsk'`。

**修复代码**：
```typescript
permissionMode: 'dontAsk',  // ✅ 正常工作
```

### 修复 2：清理环境变量

在 `evolclaw.sh` 启动脚本中添加环境变量清理：

```bash
# 清理 Claude Code 环境变量，防止 SDK 认为是嵌套会话
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT
unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
unset CLAUDE_CONFIG_DIR
```

## 修改文件

### 1. src/agent-runner.ts (2 处修改)
- 第 95 行：图片消息处理分支
- 第 127 行：文本消息处理分支

### 2. evolclaw.sh (1 处修改)
- 第 19-29 行：添加环境变量清理逻辑

## 验证测试

**测试命令**：
```bash
node -e "
import('@anthropic-ai/claude-agent-sdk').then(async ({ query }) => {
  const stream = query({
    prompt: 'say hi',
    options: {
      cwd: '/home/evolclaw/projects/default',
      model: 'claude-sonnet-4-6',
      permissionMode: 'dontAsk',
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        PATH: process.env.PATH
      }
    }
  });
  for await (const event of stream) {
    if (event.type === 'result') {
      console.log('Success!');
      break;
    }
  }
});
"
```

**结果**: ✅ 成功

## 部署步骤

```bash
# 1. 修改代码（已完成）
# - src/agent-runner.ts: permissionMode 改为 'dontAsk'
# - evolclaw.sh: 添加环境变量清理

# 2. 重新构建
npm run build

# 3. 重启服务
./evolclaw.sh restart

# 4. 验证环境变量已清理
cat /proc/$(cat data/evolclaw.pid)/environ | tr '\0' '\n' | grep CLAUDE
# 应该只显示 ANTHROPIC_* 变量，不应有 CLAUDECODE 等变量
```

## 相关信息

- **SDK 版本**: @anthropic-ai/claude-agent-sdk@0.1.77
- **环境**: Node.js, Linux
- **代理服务**: https://mg.aid.pub/claude-proxy

## 权限模式对比

| 模式 | 行为 | 结果 |
|------|------|------|
| `bypassPermissions` | 绕过权限检查 | ❌ 崩溃 (exit code 1) |
| `auto` | 自动决策 | ❌ 崩溃 (exit code 1) |
| `dontAsk` | 自动批准 | ✅ 正常工作 |
| 无 (default) | 等待用户确认 | ⚠️ 挂起（不适合自动化） |

## 注意事项

- `canUseTool` 安全检查函数仍然生效，危险命令会被拦截
- 修改后的 `dontAsk` 模式会自动批准所有工具调用（通过 `canUseTool` 检查的）
- 建议定期检查 SDK 更新，`bypassPermissions` 可能在未来版本修复

## 后续建议

1. 监控 SDK 版本更新和 changelog
2. 考虑添加 SDK 调用的单元测试
3. 在测试环境验证新版本 SDK 的兼容性
4. 定期检查进程环境变量，确保没有意外继承的变量
5. 考虑在代码中显式清理环境变量，而不仅依赖启动脚本

## 验证清单

- [x] permissionMode 已改为 'dontAsk'
- [x] 启动脚本清理 Claude Code 环境变量
- [x] 服务重启后环境变量验证通过
- [x] 用户消息处理不再崩溃
- [x] canUseTool 安全检查仍然生效
