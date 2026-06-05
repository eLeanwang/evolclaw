# EvolClaw 目录结构重构：后续待办

> 截止 2026-05-18，核心架构 + 运行时已落地。以下是剩余工作。

## 优先级 A：功能缺失

### 1. 身份层运行时（identities/）

让 agent 认识人。

- 入站消息时 resolve speaker → 查 `_index/` → 加载 profile.md
- 首次交互自动在 `_observed/` 建极简档案
- LLM 调工具 `identity.identify()` 时 promote 到 `contacts/`
- interaction 事件追加到 `history.jsonl`

**需要决策**：resolve 触发点（每条消息 vs 首次）、工具接口形式（ctl 命令 vs tool_use）

### 2. 环境层运行时（venues/）

让 agent 理解环境。

- 按 venue_id 查 `_index/` → 加载 venue profile.md 的 policy
- policy 字段（require_mention / batch_window_seconds）影响消息处理行为
- 首次进群自动建 venue 档案

### 3. self-summary 机制

agent 自省——会话结束时回顾交互，提炼记忆。

- 触发时机：session end / idle N 分钟 / 每日定时
- 目标层：episodic.jsonl / semantic.md / working.md / journal.jsonl
- 预算控制：max_tokens_per_day
- 配置在 `personal/self_summary.json`

## 优先级 B：适配 & 清理

### 4. init-channel.ts 适配新格式

`evolclaw init feishu` / `init aun` 等子命令收集完凭证后写入旧 dict 形态。改成写到对应 agent 的 `config.json.channels[]`。

### 5. Channel plugin 重写

6 个 channel plugin 的 `isEnabled(config)` / `createChannels(config)` 还在按旧 dict 读 `config.channels.<type>`。改成直接接受 `ChannelInstance[]`，然后：
- 删 `ChannelLoader.createForAgent` 里的 dict 翻译
- 删 `src/utils/channel-helpers.ts`
- 删 `Config` 类型

### 6. autoMigrateIfNeeded 移除

临时迁移代码，过 2-3 个版本后删除。

### 7. 旧 EvolAgentConfig 类型删除

`types.ts` 里的 `EvolAgentConfig`（旧格式）已无人使用，可删。

## 优先级 C：体验优化

### 8. agent list 表格对齐

当前 `evolclaw agent list` 的列宽没对齐（AID 太长截断）。

### 9. evolclaw status 显示 persona 摘要

status 输出里加一行显示 agent 的 persona.md 首行（名称/角色）。

### 10. kits/ 内容补充

- `kits/channels/feishu.md` / `wechat.md` / `dingtalk.md`（各渠道约定）
- `kits/templates/broadcast.md`（广播场景模板）
- `kits/templates/self-summary.md`（自我总结任务模板）
