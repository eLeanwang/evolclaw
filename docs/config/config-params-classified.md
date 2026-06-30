# 配置参数完整清单（按功能分类）

> 生成时间：2026-06-18
> 数据来源：
> - 实际配置文件：~/.evolclaw/evolclaw.json, agents/defaults.json, agents/*/config.json, relations/*/preferences.json
> - 代码类型定义：src/types.ts
> - 代码实际使用：搜索 src/ 目录

---

## 图例说明

**当前实际位置列**：
- ✅ = 该参数存在于该层级的配置文件中
- ❌ = 不存在
- 📝 = 存在于 preferences.json（需迁移到 config.json）
- (空) = 存在但值为空对象/空数组

**建议存放层级**：用 `/` 分隔表示可在多个层级存在，形成覆盖链

**支持关系级**：是否应该支持针对不同用户的个性化配置

---

## 一、身份与安全（7个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 1.1 | `$schema_version` | ✅ | ✅ | ✅ | ❌ | process / defaults / agent / relation | H | ✅ | Schema 版本号 |
| 1.2 | `aid` | ✅ | ❌ | ✅ | ❌ | process / agent | H | ❌ | Agent/进程 AID |
| 1.3 | `owners[]` | ✅ | ❌ | ✅ | ❌ | process / defaults / agent | H | ❌ | 控制面鉴权名单（list 合并） |
| 1.4 | `admins[]` | ❌ | ❌ | ❌ | ❌ | defaults / agent | H | ❌ | 管理员名单（代码支持但未配置） |
| 1.5 | `enabled` | ❌ | ❌ | ✅ | ❌ | agent | H | ❌ | Agent 启用状态 |
| 1.6 | `initialized` | ❌ | ❌ | ✅ | ❌ | agent | H | ❌ | AUN 首次初始化标记 |
| 1.7 | `observable` | ❌ | ❌ | ✅ | ❌ | agent | H | ❌ | 观察者模式：入站/出站转发给 owners |

---

## 二、基础设施与端点（6个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 2.1 | `aun.encryptionSeed` | ✅ | ❌ | ❌ | ❌ | process | H | ❌ | AUN 加密种子（仅进程级） |
| 2.2 | `aun.keystorePath` | ❌ | ❌ | ❌ | ❌ | process | H | ❌ | AUN keystore 路径（代码支持但未配置） |
| 2.3 | `aun.gatewayUrl` | ❌ | ❌ | ❌ | ❌ | defaults / agent | H | ❌ | AUN Gateway URL（代码支持但未配置） |
| 2.4 | `baseagents.claude.baseUrl` | ❌ | ✅ | ❌ | ❌ | defaults / agent | H | ❌ | Claude API 端点 |
| 2.5 | `baseagents.codex.baseUrl` | ❌ | ❌ | ❌ | ❌ | defaults / agent | H | ❌ | Codex API 端点（代码支持但未配置） |
| 2.6 | `baseagents.gemini.baseUrl` | ❌ | ❌ | ❌ | ❌ | defaults / agent | H | ❌ | Gemini API 端点（代码支持但未配置） |

---

## 三、API 凭证（6个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 3.1 | `baseagents.claude.apiKey` | ❌ | ✅ ($ENV) | ❌ | ❌ | defaults / agent | H | ❌ | Claude API Key（引用 .env） |
| 3.2 | `baseagents.codex.apiKey` | ❌ | ❌ | ❌ | ❌ | defaults / agent | H | ❌ | Codex API Key（代码支持但未配置） |
| 3.3 | `baseagents.gemini.apiKey` | ❌ | ❌ | ❌ | ❌ | defaults / agent | H | ❌ | Gemini API Key（代码支持但未配置） |
| 3.4 | `channels[].appId` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 飞书 appId（引用 .env） |
| 3.5 | `channels[].appSecret` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 飞书 appSecret（引用 .env） |
| 3.6 | `channels[].token` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 微信 token（引用 .env） |

**说明**：还有更多渠道凭证字段（clientId, clientSecret, botId, secret, accessToken 等），为简洁省略

---

## 四、渠道配置（14个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 4.1 | `channels[]` | ❌ | ❌ | ✅ (空) | ❌ | agent | H | ❌ | 渠道实例列表 |
| 4.2 | `channels[].type` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 渠道类型（aun/feishu/wechat/...） |
| 4.3 | `channels[].name` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 实例名（agent 内唯一标识） |
| 4.4 | `channels[].enabled` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 渠道启用状态 |
| 4.5 | `channels[].baseUrl` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 微信 baseUrl |
| 4.6 | `channels[].gatewayUrl` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | AUN Gateway URL（渠道级） |
| 4.7 | `channels[].owners[]` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 渠道级 owner |
| 4.8 | `channels[].admins[]` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 渠道级 admin |
| 4.9 | `channels[].flushDelay` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 渠道级 flush 间隔 |
| 4.10 | `channels[].debounce` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 渠道级去抖间隔 |
| 4.11 | `channels[].showActivities` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 渠道级活动可见性 |
| 4.12 | `channels[].pythonBin` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | Python 可执行路径（AUN TUI） |
| 4.13 | `channels[].requireMention` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 钉钉：群聊需要 @mention |
| 4.14 | `channels[].freeResponseChats[]` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 钉钉：跳过 @mention 白名单 |

**说明**：还有 clientId, clientSecret, botId, secret, accessToken 等凭证字段（已列在"三、API 凭证"中）

---

## 五、模型与 Base Agent 配置（16个参数，★支持关系级）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 5.1 | `models.default` | ❌ | ❌ | ❌ | ❌ | defaults / agent / relation | H | ✅ ★ | 默认模型（对不同用户可不同） |
| 5.2 | `models.allowed[]` | ❌ | ❌ | ❌ | ❌ | defaults / agent | H | ❌ | 模型白名单（安全边界） |
| 5.3 | `active_baseagent` | ❌ | ✅ | ✅ | ❌ | defaults / agent | H | ❌ | 当前活跃的 base agent |
| 5.4 | `baseagents.claude.model` | ❌ | ✅ | ❌ | 📝 (model) | defaults / agent / relation | H | ✅ ★ | Claude 模型 |
| 5.5 | `baseagents.claude.effort` | ❌ | ✅ | ❌ | ❌ | defaults / agent / relation | H | ✅ ★ | Claude 推理强度 |
| 5.6 | `baseagents.claude.pathToClaudeCodeExecutable` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | Claude Code 可执行路径 |
| 5.7 | `baseagents.claude.useSettingSources` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 使用 settings.json |
| 5.8 | `baseagents.claude.agentProgressSummaries` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | Agent 进度摘要 |
| 5.9 | `baseagents.claude.excludeDynamicSections` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 排除动态章节 |
| 5.10 | `baseagents.codex.model` | ❌ | ❌ | ❌ | ❌ | defaults / agent / relation | H | ✅ ★ | Codex 模型 |
| 5.11 | `baseagents.codex.effort` | ❌ | ❌ | ❌ | ❌ | defaults / agent / relation | H | ✅ ★ | Codex 推理强度 |
| 5.12 | `baseagents.codex.enableRequestUserInput` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 启用用户输入请求 |
| 5.13 | `baseagents.codex.approvalsReviewer` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 审批审查者 |

`baseagents.codex.reasoning` 已并入 `baseagents.codex.effort`；旧配置仍兼容读取，但新写入不再生成 `reasoning`。
| 5.15 | `baseagents.gemini.model` | ❌ | ❌ | ❌ | ❌ | defaults / agent / relation | H | ✅ ★ | Gemini 模型 |
| 5.16 | `baseagents.gemini.mode` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | Gemini 模式（cli/sdk） |

**说明**：还有 gemini 的其他配置字段（cliPath, useVertex, project, location 等），为简洁省略部分

---

## 六、对话模式与交互（8个参数，★全部支持关系级）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 6.1 | `chatmode.private` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 私聊对话模式（interactive/proactive） |
| 6.2 | `chatmode.group` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 群聊对话模式（对不同群可不同） |
| 6.3 | `chatmode.nothuman` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 非人类对话模式 |
| 6.4 | `flush_delay` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 消息 flush 间隔（对不同用户可调整） |
| 6.5 | `debounce` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 入站消息去抖间隔 |
| 6.6 | `dispatch` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 群聊分发策略（mention/broadcast） |
| 6.7 | `show_activities` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 中间活动可见性（技术用户显示，普通用户隐藏） |
| 6.8 | `enable_rich_content` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 启用富内容渲染 |

---

## 七、Proactive 模式策略（2个参数，★全部支持关系级）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 7.1 | `proactive.pre_tool_1stmsgchk` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | Proactive 下首次工具调用前必须先 send/file 表态 |
| 7.2 | `proactive.tool_use_reminder` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | Proactive 下启用队列未读提醒和工具汇报提醒 |

---

## 八、渲染与显示（3个参数，★全部支持关系级）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 8.1 | `render.private` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 私聊渲染模式名称（对不同用户可用不同渲染） |
| 8.2 | `render.group` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 群聊渲染模式名称（对不同群可不同） |
| 8.3 | `render.inject` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 注入渲染模式名称 |

---

## 九、权限控制（3个参数，★全部支持关系级）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 9.1 | `permissionMode` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 执行权限模式（对信任用户 bypass，对陌生用户 readonly） |
| 9.2 | `roles.<role>.baseagents` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 角色级 baseagents 覆盖 |
| 9.3 | `roles.<role>.permissionMode` | ❌ | ❌ | ❌ | ❌ | agent / relation | H | ✅ ★ | 角色级 permissionMode 覆盖 |

---

## 十、项目与工作目录（2个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 10.1 | `projects.rootPath` | ❌ | ✅ | ❌ | ❌ | defaults | H | ❌ | 创建 agent 时派生默认项目路径 |
| 10.2 | `projects.defaultPath` | ❌ | ✅ | ✅ | ❌ | defaults / agent | H | ❌ | Agent 项目路径 |

`projects.rootPath` 仅用于 defaults 作用域的创建兜底；单个 agent 为单项目模型，ECWeb / menu update 只允许写 `projects.defaultPath`。`projects.autoCreate` 与 `projects.list` 已不再是公开配置契约。

---

## 十一、调试与日志（5个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 11.1 | `debug.logLevel` | ❌ | ❌ | ❌ | ❌ | process / defaults / agent | H | ❌ | 日志级别（DEBUG/INFO/WARN/ERROR） |
| 11.2 | `debug.flusherDiag` | ❌ | ❌ | ❌ | ❌ | process / defaults / agent | H | ❌ | Flusher 诊断开关 |
| 11.3 | `debug.aunTrace` | ❌ | ❌ | ❌ | ❌ | process / defaults / agent | H | ❌ | AUN trace 开关 |
| 11.4 | `debug.aunSdkLog` | ❌ | ❌ | ❌ | ❌ | process / defaults / agent | H | ❌ | AUN SDK log 开关 |
| 11.5 | `debug.upmsg` | ❌ | ❌ | ❌ | ❌ | defaults / agent | H | ❌ | 上行消息调试开关 |

---

## 十二、备份与快照（1个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 12.1 | `extra_backup[]` | ❌ | ❌ | ❌ | ❌ | agent | H | ❌ | 快照额外备份文件声明（不得指向 .env） |

---

## 十三、网络与服务（5个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议权限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 13.1 | `tunnel.targets[]` | ❌ | ❌ | ❌ | ❌ | process | H | ❌ | Tunnel 目标配置 |
| 13.2 | `serviceProxy.enabled` | ❌ | ❌ | ❌ | ❌ | process | H | ❌ | Service Proxy 总开关 |
| 13.3 | `serviceProxy.services[]` | ❌ | ❌ | ❌ | ❌ | process | H | ❌ | Service Proxy 服务列表 |
| 13.4 | `ecweb.enabled` | ✅ | ❌ | ❌ | ❌ | process | H | ❌ | ECWeb 自动启动开关 |
| 13.5 | `ecweb.port` | ✅ | ❌ | ❌ | ❌ | process | H | ❌ | ECWeb 监听端口 |

---

## 十四、UI 与前端（1个参数）

| # | 参数名 | process | defaults | agent | relation | 建议存放层级 | 建议限 | 支持关系级 | 说明 |
|---|--------|---------|----------|-------|----------|-------------|---------|-----------|------|
| 14.1 | `watch.logTypes[]` | ❌ | ❌ | ❌ | ❌ | process | H | ❌ | 前端勾选的日志类型 |

---

## 汇总统计

### 按分类统计

| 分类 | 参数数量 | 实际已配置 | 代码支持未配置 | 支持关系级 |
|------|---------|-----------|--------------|-----------|
| 一、身份与安全 | 7 | 5 | 2 | 1 ($schema_version) |
| 二、基础设施与端点 | 6 | 2 | 4 | 0 |
| 三、API 凭证 | 6+ | 1 | 5+ | 0 |
| 四、渠道配置 | 14+ | 1 (空) | 13+ | 0 |
| 五、模型与 Base Agent | 16+ | 5 | 11+ | 13 ★ |
| 六、对话模式与交互 | 8 | 0 | 8 | 8 ★ |
| 七、Proactive 策略 | 2 | 0 | 2 | 2 ★ |
| 八、渲染与显示 | 3 | 0 | 3 | 3 ★ |
| 九、权限控制 | 3 | 0 | 3 | 3 ★ |
| 十、项目与工作目录 | 4 | 3 | 1 | 0 |
| 十一、调试与日志 | 5 | 0 | 5 | 0 |
| 十二、备份与快照 | 1 | 0 | 1 | 0 |
| 十三、网络与服务 | 5 | 2 | 3 | 0 |
| 十四、UI 与前端 | 1 | 0 | 1 | 0 |
| **总计** | **81+** | **20** | **61+** | **30** ★ |

**说明**：`+` 表示还有未完全列举的子参数（如各渠道的凭证字段）

### 关键发现

1. **实际配置的参数很少**：81 个参数中只有 20 个实际在配置文件中
2. **支持关系级的参数有 30 个**：主要集中在模型配置、对话模式、权限控制等
3. **关系级目前只有 1 个参数**：preferences.json 中只有 `model` 字段
4. **需要扩展关系级配置**：应该支持 30 个关系级参数，但目前只有 1 个

---

## 需要处理的问题

### 问题 1：关系级配置扩展
**当前**：`relations/*/preferences.json` 只有 `model` 字段  
**建议**：创建 `relations/*/config.json`，支持 30 个关系级参数（标记为 ★ 的参数）

### 问题 2：大量参数未配置
61+ 个参数代码支持但未配置，是否需要：
- 补充默认值到 schema
- 在文档中说明这些参数的用途

### 问题 3：H/HA 物理分离
**当前**：defaults.json 和 agent/config.json 混有应该属于 HA 的字段（active_baseagent, baseagents）  
**决定**：按你之前的决定，暂时保持现状，等权限体系实现后再迁移

---

## 下一步

请逐个分类审查，确认：
1. 参数分类是否合理？
2. 编号是否清晰？
3. "建议存放层级"和"支持关系级"是否准确？

确认后，我会生成正确的 schema 文件。
