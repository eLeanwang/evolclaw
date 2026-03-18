# SDK 升级方案 (0.1.77 → 0.2.77)

**状态**：✅ 已完成实施（2026-03-18）

## 概述

将 Claude Agent SDK 从 0.1.77 升级到 0.2.77，适配新功能，简化配置加载逻辑。

---

## 功能 1：使用 settingSources 简化配置加载

**状态**：✅ 方案已确认

### 当前实现

`agent-runner.ts` 中 ~40 行代码手动加载：
- `~/.claude/CLAUDE.md`（全局）
- `CLAUDE.md` / `.claude/CLAUDE.md`（项目级）
- `~/.claude/mcp.json`（MCP 配置）
- 通过 `systemPrompt.append` 拼接注入

### 新方案

使用 SDK 原生 `settingSources: ['project', 'user']`，SDK 自动加载以上所有配置。

### 设计细节

1. **配置开关**：`data/config.json` 中添加 `sdk.useSettingSources`（默认 `true`）
2. **旧代码保留**：通过开关控制，`false` 时走旧逻辑，方便回滚
3. **加载顺序**：使用 SDK 默认顺序
4. **MCP 配置**：也由 SDK 自动加载，开关同时控制 MCP 手动加载逻辑
5. **channel 级别追加**：`systemPromptAppend`（如飞书的 SEND_FILE 指令）保留，通过 `systemPrompt.append` 传入

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/types.ts` | Config 类型添加 `sdk?: { useSettingSources?: boolean }` |
| `src/core/agent-runner.ts` | 添加条件判断，新旧模式切换 |
| `package.json` | SDK 版本升级到 `^0.2.77` |

### 代码示意

```typescript
// agent-runner.ts
const useSettingSources = config?.sdk?.useSettingSources !== false; // 默认 true

if (useSettingSources) {
  // 新方式
  return query({
    prompt: promptInput,
    options: {
      cwd: projectPath,
      model: this.model,
      settingSources: ['project', 'user'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(systemPromptAppend ? { append: systemPromptAppend } : {})
      },
      // 不传 mcpServers，由 SDK 自动加载
    }
  });
} else {
  // 旧方式（保留原有手动加载逻辑）
}
```

### 集成测试

- [ ] 新方式能正确加载项目级 CLAUDE.md
- [ ] 新方式能正确加载全局 CLAUDE.md
- [ ] 新方式能正确加载 MCP 配置
- [ ] channel 级别的 systemPromptAppend 仍然生效
- [ ] 开关设为 false 时旧方式正常工作
- [ ] 旧方式确认无问题后可删除

---

## 功能 2：task_progress 事件处理

**状态**：✅ 方案已确认

### 说明

SDK 0.2.51 新增 `task_progress` 事件，当 subagent 运行时周期性发出进度信息。

### 设计细节

1. **处理位置**：`message-processor.ts` 中处理 `task_progress` 事件
2. **展示方式**：合并到 `StreamFlusher`，和工具活动一起批量发送
3. **展示格式**：`⏳ 子任务进行中: 8次工具调用, 25s`

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/core/message-processor.ts` | 添加 `task_progress` 事件处理 |

---

## 功能 3：agentProgressSummaries

**状态**：✅ 方案已确认

### 说明

SDK 0.2.72 新增 `agentProgressSummaries` 选项，启用后为 subagent 自动生成 AI 进度摘要。

### 设计细节

1. **默认开启**：`config.sdk.agentProgressSummaries: true`（可配置）
2. **展示逻辑**：
   - 有 `summary` 时：`⏳ 子任务: 正在分析auth.ts的认证逻辑 (8次工具调用, 25s)`
   - 无 `summary` 时：`⏳ 子任务进行中: 8次工具调用, 25s`

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/types.ts` | Config 添加 `sdk.agentProgressSummaries` |
| `src/core/agent-runner.ts` | 传入 `agentProgressSummaries` 选项 |
| `src/core/message-processor.ts` | 处理 `summary` 字段 |

---

## 功能 4：会话管理 API 增强

**状态**：✅ 方案已确认

### 说明

SDK 0.2.x 新增会话管理方法，增强 EvolClaw 的会话操作能力。

### 设计细节

1. **`renameSession()`**：
   - 使用 SDK 方法替换当前数据库实现
   - **双写策略**：调用 SDK `renameSession()` + 更新数据库 `name` 字段
   - 保留数据库字段用于快速查询

2. **Name 同步策略**（解决 CLI 改名后数据库不一致问题）：
   - **`/name` 命令**：双写（SDK + 数据库），立即一致
   - **`/status` 命令**：已在读 `.jsonl` 文件（countSessionTurns），顺便提取 name 并同步到数据库
   - **`/slist` 命令**：调用 SDK `listSessions()` 获取会话列表，对比并同步 name 到数据库
   - 覆盖面：用户无论执行哪个命令，都能发现并同步外部 CLI 的改名

3. **`forkSession()`**：
   - 新增 `/fork [名称]` 命令
   - 支持 fork 时指定新会话名称
   - 创建分支会话，从当前点探索不同方向

4. **不使用**：`getSessionMessages()`, `tagSession()`
5. **使用**：`listSessions()`（用于 `/slist` 同步 name）

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/core/command-handler.ts` | `/name` 双写，`/status` 同步 name，`/slist` 同步 name，新增 `/fork` |
| `src/core/session-manager.ts` | 添加 name 同步方法，添加 fork 会话支持 |

---

## 升级步骤

### Phase 1: 升级 SDK 版本
1. ✅ 升级 package.json 到 `^0.2.77`
2. 运行 `npm install`
3. 验证安装成功

### Phase 2: 功能 1 - settingSources
1. 修改 `src/types.ts` 添加配置类型
2. 修改 `src/core/agent-runner.ts` 实现新旧模式切换
3. 测试验证

### Phase 3: 功能 2+3 - task_progress
1. 修改 `src/types.ts` 添加配置类型
2. 修改 `src/core/agent-runner.ts` 传入 `agentProgressSummaries`
3. 修改 `src/core/message-processor.ts` 处理事件
4. 测试验证

### Phase 4: 功能 4 - 会话管理
1. 修改 `src/core/command-handler.ts` 改造 `/name` 和新增 `/fork`
2. 修改 `src/core/session-manager.ts` 添加 fork 支持
3. 测试验证

### Phase 5: 清理
1. 确认旧代码可删除
2. 删除手动加载逻辑
3. 更新文档
