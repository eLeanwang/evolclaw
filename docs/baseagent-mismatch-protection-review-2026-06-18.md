# Baseagent 错配保护与默认切换策略审查

日期：2026-06-18

## 背景

本次问题源于 session 元数据中的 `agentId` 与实际 runner 不一致：

- 会话记录显示 `agentId: codex`。
- 该 agent 下实际没有可用的 `owner::codex` runner。
- 旧逻辑在找不到指定 runner 时会静默 fallback 到 primary runner，导致 codex 会话实际被 Claude 执行。
- 后续状态、`/status`、底层会话 UUID 等信息因此出现错配。

核心风险不是某一个旧 session 异常，而是系统允许“会话声明的 baseagent”和“实际执行 runner”分叉。

## 改进目标

1. 已知 channel owner 时，禁止 runner 静默跨 baseagent fallback。
2. `/baseagent <name>` 改成设置 agent 的新会话默认 baseagent，不切换当前历史会话。
3. 非 owner 不能修改 baseagent 默认值。
4. 当前历史会话继续使用原 baseagent。
5. 新会话、新话题会话使用当前 agent 默认 baseagent。
6. 如果新 session 继承到的 baseagent 在当前 agent 下不可用，自动对齐到可用后端并清理不兼容的 `agentSessionId`。

## 非目标

- 不迁移旧会话。
- 不批量重写历史 session 的 `agentId`。
- 不允许关系级自定义 baseagent 类型。
- 不把 `/baseagent` 做成“当前会话切换”命令。

## 行为变更

### `/baseagent` 查询

无参数时仍可查询：

- owner 可看到可用 baseagent 列表和用法。
- 列表中选中的是“新会话默认 baseagent”，不是当前历史会话的 `agentId`。
- 文本降级输出同时展示：
  - 当前会话 baseagent。
  - 新会话默认 baseagent。

### `/baseagent <name>` 切换

带参数时：

- 只有 owner 可执行。
- 写入 agent 层级 `active_baseagent`。
- 不调用 `SessionManager.switchAgent()`。
- 不修改当前 active session 的 `agentId`。
- 成功提示明确说明：
  - 当前会话仍使用原 baseagent。
  - 新会话/新话题会话才使用新的默认 baseagent。

示例响应：

```text
✓ 已设置新会话默认 baseagent: codex
  Agent: review
  项目: /path/to/project
  当前会话仍使用: claude
  新会话/新话题会话将使用新的默认 baseagent
```

### 菜单协议

`menu.update /baseagent` 与 slash 命令保持一致：

- owner-only。
- 只写 agent 默认 baseagent。
- 返回 `scope: "default"`。
- 不再支持旧的 `session` / `both` 语义。

### 新会话

`/new` 创建新主会话时，优先使用 channel 所属 agent 的 `baseagent`：

1. `agentRegistry.resolveByChannel(channel)?.baseagent`
2. 当前 session 的 `agentId`
3. primary runner 的 baseagent

如果旧 session 的 runner 已不可用，`/new` 不会因为清理旧 runner 状态失败而中断。

### 新入站 session / 新话题 session

MessageBridge 创建/读取 session 时会传入 owning agent 的默认 baseagent。

创建后还会校验当前 session 的 `agentId` 是否在该 owner 的可用 runner 集合中：

- 可用：保持原值。
- 不可用：对齐到 agent 当前默认 baseagent；如果默认也不可用，则用第一个可用 baseagent。
- 对齐时清理 `agentSessionId`，避免把旧后端会话 UUID 继续挂到新后端。
- 对齐只更新当前 session，不创建或切换主会话。

## 实现概要

### Runner 错配错误类型

文件：`src/agents/runner-types.ts`

新增：

- `BASEAGENT_RUNNER_UNAVAILABLE`
- `BaseagentRunnerUnavailableError`

该错误携带：

- `evolagentName`
- `baseagent`
- `availableBaseagents`

### Runner 选择收紧

文件：

- `src/core/message/message-processor.ts`
- `src/core/command/command-handler.ts`

规则：

- 如果 channel 没有明确 owner，保留旧 fallback 行为，兼容测试和默认单 runner 场景。
- 如果 channel 有明确 owner，则必须命中 `${owner.name}::${session.agentId}`。
- 找不到时抛出 `BaseagentRunnerUnavailableError`，不再 fallback 到 primary runner。

MessageProcessor 捕获该错误后发送可恢复系统错误，避免错误 runner 执行任务。

### `/baseagent` 语义调整

文件：

- `src/core/command/slash-handler.ts`
- `src/core/command/menu-handler.ts`

核心变化：

- `/baseagent <name>` 只调用 `owningAgent.setActiveBaseagent(name)`。
- 不再调用 `sessionManager.switchAgent()`。
- card 和文本路径都以“新会话默认 baseagent”为选中态。
- 权限从 admin/group owner 混合策略收紧为 owner-only。

### Session 对齐

文件：

- `src/core/message/message-bridge.ts`
- `src/core/session/session-manager.ts`

`MessageBridge.alignSessionBaseagent()` 负责对齐不可用 session baseagent。

`SessionManager.updateSession()` 增加 `agentId` 更新能力，用于安全更新当前 session，而不是通过 `switchAgent()` 创建或切换主会话。

### Recovery 命令不被错配卡死

文件：

- `src/core/command/slash-handler.ts`
- `src/core/command/slash-gate.ts`

runner 改为懒加载：

- 需要 runner 时才查。
- 查不到 runner 时，不阻塞 `/baseagent`、`/new` 等恢复路径。
- idle guard 对 runner 缺失做容错，但仍保留 messageQueue processing 检查。

## 审查重点

建议重点看以下问题：

1. 是否所有已知 owner channel 都已禁止跨 baseagent fallback。
2. `/baseagent <name>` 是否完全停止修改当前 session。
3. card/menu 和 slash 命令语义是否一致。
4. 新主会话、新话题会话是否都能拿到 agent 默认 baseagent。
5. 对齐不可用 baseagent 时是否只更新当前 session，未调用 `switchAgent()`。
6. `agentSessionId` 是否在 baseagent 对齐时被清空。
7. guest/admin 是否无法通过 menu 或 slash 修改默认 baseagent。
8. runner 缺失时，恢复命令是否仍可执行。

## 测试覆盖

已执行：

```bash
npx tsc --noEmit
npx vitest run
```

结果：

- 150 个测试文件通过。
- 1741 passed。
- 25 skipped。

新增或调整的覆盖点包括：

- owned channel 请求缺失 baseagent runner 时抛出 `BaseagentRunnerUnavailableError`。
- MessageBridge 对齐不可用 baseagent 时只更新当前 session，不调用 `switchAgent()`。
- 新入站 session 创建时传入 owning agent 默认 baseagent。
- `/new` 使用 owning agent 默认 baseagent，而不是当前历史会话 baseagent。
- `/baseagent` slash 成功提示包含“当前会话仍使用 xxx，新会话/新话题生效”。
- menu `/baseagent` owner-only，并只写默认 baseagent。

## 风险与兼容性

### 行为兼容性

旧行为中 `/baseagent <name>` 会切当前会话；现在改为只影响新会话。

这是有意的 breaking behavior，目的是避免当前历史会话和底层后端状态被隐式重挂。

### 历史会话

历史会话继续使用原 `agentId`。

如果原 baseagent runner 不再可用：

- 普通处理路径会阻断，发送可恢复错误。
- 新会话路径会使用当前默认 baseagent。
- 新入站 session / 新话题 session 会对齐到可用 baseagent。

### 可用 baseagent 列表

当前可切换列表以实际 runner map 为准，即 `${owner}::*`。

这保证了列表中不会出现配置存在但 runner 创建失败的后端。配置层 default + agent 合并后的结果应在 runner 创建阶段体现；审查时需要确认 loader 对合并配置和 runner map 的生成符合预期。

### 用户提示

`/baseagent <name>` 已增加明确提示。

MessageBridge 自动对齐新 session baseagent 当前主要记录 warn 日志，并在后续消息中体现新的 `agentId`。如果希望用户也收到一条可见系统通知，可作为后续增强项单独实现。

## 建议后续

1. 增加 daemon/status 视图，区分“当前会话 baseagent”和“agent 新会话默认 baseagent”。
2. 在自动对齐新 session baseagent 时，增加一条可见的 system notice。
3. 给 baseagent 可用列表增加显式来源说明：defaults、agent config、runtime runner。
4. 清理旧 menu `scope` 概念的前端文案，避免客户端继续展示 session/both 选项。
