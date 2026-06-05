# /btw 命令研究（2026-03-25）

## 状态：方案已验证，暂不实现

## Claude Code /btw 功能
- 旁白问答：看到完整对话上下文，只读（无工具），不写入会话历史
- CLI 内部实现：进程内直接调 Anthropic API，`canUseTool: deny`，`skipCacheWrite: true`，`forkLabel: "side_question"`（内存级 fork）
- SDK 未暴露此 API（`side_question` 是 CLI print mode 内部的 control request）

## 推荐方案：C（已验证可行）

`query()` + `resume` + `persistSession: false` + `allowedTools: []` + `maxTurns: 1`

### 验证结果（scripts/test-btw.ts）
- ✓ `persistSession: false` + `resume` 不写入原 JSONL（0 字节变化）
- ✓ `allowedTools: []` 完全禁用工具
- ✓ 能看到对话上下文并正常回答
- ✓ 不创建孤儿文件

### 实现要点
- `AgentRunner` 新增 `runBtwQuery(claudeSessionId, prompt, projectPath)` 方法
- 复用 `runSessionCommand` 模式，改三个参数
- `CommandHandler` 注册 `/btw` 为用户级命令
- 零新依赖，~15 行代码

### 与 CLI 实现的差异
- CLI：进程内 API 调用，~1-3s
- 方案 C：子进程（SDK query spawn cli.js），~3-6s
- 消息通道场景下 2-3s 额外延迟可接受
