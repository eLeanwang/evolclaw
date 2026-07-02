# EvolClaw 配置项全量参考手册

> 生成时间：2026-06-23
> 数据来源：4 份 H 链 schema + 1 份 behavior(HA) schema + `src/` 代码实际使用点
> 适用版本：config 体系 v3（H 链三级）+ behavior HA 链（仍在运行，见下方「重要澄清」）

本手册逐项列出**所有配置参数**：它的用途、当前从哪个文件读取、代码里的兜底默认值（写死在哪）、应该配在哪一层、合并语义。

相关文档：
- [01-overview.md](./01-overview.md) — 体系总览
- [02-merge-rules.md](./02-merge-rules.md) — 合并规则
- [PARAMS-GAPS-AND-FIXES.md](./PARAMS-GAPS-AND-FIXES.md) — 硬编码/不一致/缺口清单与修复建议

---

## 重要澄清：实际有 5 个配置文件，不是 4 个

当前 `01-overview.md` 已修正为 H 配置链 + HA 行为链。运行时真实的配置文件有 5 类：

| # | 逻辑名 | 文件 | 权限 | 是否进覆盖链 | Schema |
|---|--------|------|------|------------|--------|
| ① | `evolclaw` | `evolclaw.json` | H | 否（独立进程级） | `evolclaw.schema.1.json` |
| ② | `defaults` | `agents/defaults.json` | H | 是（最低） | `defaults.schema.1.json` |
| ③ | `agent-config` | `agents/{aid}/config.json` | H | 是（中） | `agent-config.schema.1.json` |
| ④ | `relation-config` | `agents/{aid}/relations/{peerKey}/config.json` | H | 是（最高） | `relation-config.schema.1.json` |
| ⑤ | `behavior` | `agents/{aid}/behavior.json` 及 `relations/{peerKey}/behavior.json` | **HA** | 叠加在 H 链结果之上 | `behavior.schema.1.json` |

**H 链（人类专属）**：`defaults → agent/config → relation/config`，由 `resolveAgentConfig()` 合并。
**HA 链（Agent 可写）**：`agent/behavior → roles.<role> → relation/behavior`，由 `resolveBehavior()` 合并。

运行时 `resolveEffective()`（`config-manager.ts:259`）= 先算 H 链，再调用 `mergeBehaviorIntoEffective()` 把 HA 链叠上去。
关键代码：`config-manager.ts:289` → `behavior.ts:68`。

**为什么重要**：`model`、`effort`、`chatmode`、`permissionMode` 等行为参数，CLI（`ec model` / `ec perm`）实际写入的是 **behavior.json**，不是 config.json。在 config.json 里配同名字段会被 behavior.json 覆盖。这是当前最容易踩的坑。

---

## 图例

- **读取点**：代码中实际消费该参数的位置
- **兜底值**：配置全缺时代码里写死的默认（= 真实的「系统默认行为」）
- **合并**：`scalar`(覆盖) / `list`(并集去重) / `dict`(第一层键并集，不递归)
- **关系级**：是否支持针对单个对端个性化（★ = 支持）

---

## ① 进程级 evolclaw.json（不进覆盖链）

daemon 自身运行配置，与具体 agent 行为无关。

| 参数 | 类型 | 用途 | 合并 | 当前值 |
|------|------|------|------|--------|
| `aid` | string | daemon 默认身份 AID | scalar | `ec59627.agentid.pub` |
| `owners[]` | string[] | 进程控制面鉴权名单（谁能远程管 daemon） | list | `["lwjccccc.aid.pub"]` |
| `aun.encryptionSeed` | string\|null | keystore 加密种子（应用 `${VAR}` 引用） | dict | `null` |
| `tunnel.targets[]` | object[] | 内网穿透目标配置 | dict | 未配 |
| `serviceProxy.enabled` | boolean | 把本地服务暴露到 AUN 网络（总开关） | dict | 未配 |
| `serviceProxy.services[]` | object[] | Service Proxy 服务列表 | dict | 未配 |
| `ecweb.enabled` | boolean | web 控制台自启开关 | dict | `true` |
| `ecweb.port` | number | web 控制台监听端口 | dict | `42705` |
| `watch.logTypes[]` | string[] | 前端默认勾选的日志类型 | dict | 未配 |
| `debug` | object | daemon 级日志开关 | dict | 未配 |

> 已补齐：`idleMonitor.{enabled,timeout}` 已归属 `evolclaw.json` schema，兜底仍为 `enabled=true / timeout=120s`。

---

## ②③④ H 链参数（defaults / agent / relation）

下表「层级」列标注该参数在 H 链各 schema 中是否定义：D=defaults / A=agent-config / R=relation-config。

### 身份与生命周期（仅 agent 级）

| 参数 | 类型 | 用途 | 合并 | 层级 | 读取点 |
|------|------|------|------|------|--------|
| `aid` | string | Agent 标识（必填） | scalar | A | 全局 |
| `enabled` | boolean | Agent 启用状态；`false`→不加载 | scalar | A | `evolagent.ts:58` |
| `initialized` | boolean | AUN 首次初始化标记 | scalar | A | 启动流程 |
| `observable` | boolean | 观察者模式：入站/出站各转一份给 owners | scalar | A | channel 加载 |

### 权限角色

| 参数 | 类型 | 用途 | 合并 | 层级 | 兜底 |
|------|------|------|------|------|------|
| `owners[]` | string[] | owner 名单（AID），沿链**并集**，只增不减 | list | D/A/R | `[]` |
| `admins[]` | string[] | admin 名单（AID），沿链并集 | list | D/A/R | `[]`（全空，代码支持未用） |

### 渠道（仅 agent 级）

| 参数 | 类型 | 用途 | 合并 | 层级 |
|------|------|------|------|------|
| `channels[]` | object[] | 渠道实例列表（含凭证 `${VAR}` 引用） | list | A |
| `channels[].type` | string | `aun`/`feishu`/`wechat`/`wecom`/`qqbot`/`dingtalk` | — | A |
| `channels[].name` | string | 实例名（agent 内唯一） | — | A |
| `channels[].enabled` | boolean | 渠道启用状态 | — | A |
| `channels[].appId/appSecret/token/...` | string | 各渠道凭证（应为 `${VAR}`） | — | A |
| `channels[].flushDelay` | number | 渠道级 flush 间隔（覆盖 agent 级 flush_delay） | — | A |
| `channels[].debounce` | number | 渠道级去抖间隔 | — | A |
| `channels[].showActivities` | string | 渠道级活动可见性 | — | A |
| `channels[].requireMention` | boolean | 钉钉：群聊需 @mention | — | A |
| `channels[].freeResponseChats[]` | string[] | 钉钉：免 @mention 白名单 | — | A |

> AUN channel 是隐式的（从 `aid` 派生），不在 `channels[]` 里声明；其 owner/admin 走顶层 `owners`/`admins`。

### AUN 运行时

| 参数 | 类型 | 用途 | 合并 | 层级 |
|------|------|------|------|------|
| `aun.keystorePath` | string | AUN keystore 路径 | dict | D/A |
| `aun.encryptionSeed` | string | AUN 加密种子 | dict | D/A |
| `aun.gatewayUrl` | string | AUN Gateway URL | dict | D/A |

### 模型与 baseagents（H 链中存「凭证」，行为参数实际走 behavior）

| 参数 | 类型 | 用途 | 合并 | 层级 | 关系级 |
|------|------|------|------|------|--------|
| `models.default` | string | 默认模型 | dict | D/A/R | ★ |
| `models.allowed[]` | string[] | 模型白名单（安全边界） | dict | D/A | |
| `active_baseagent` | string | 当前活跃 baseagent（`claude`/`codex`/`gemini`） | scalar | D/A | |
| `baseagents.<ba>.apiKey` | string | 该 baseagent API Key（应为 `${VAR}`） | dict | D/A | |
| `baseagents.<ba>.baseUrl` | string | 该 baseagent API 端点 | dict | D/A | |
| `baseagents.<ba>.model` | string | 模型（**注意：实际由 behavior 覆盖**） | dict | D/A | |
| `baseagents.<ba>.effort` | string | 推理强度（同上） | dict | D/A | |
| `baseagents.claude.useSettingSources` | boolean | 加载 settings.json | dict | A | |
| `baseagents.claude.agentProgressSummaries` | boolean | Agent 进度摘要 | dict | A | |

> ⚠️ `baseagents` 是 `dict` 合并、**第一层键不递归**：高优先级写 `baseagents.claude` 会**整块替换**，未重写的 `effort`/`apiKey` 会丢失。详见 [02-merge-rules.md](./02-merge-rules.md) 第四节。

### 项目路径

| 参数 | 类型 | 用途 | 合并 | 层级 | 读取点 |
|------|------|------|------|------|--------|
| `projects.rootPath` | string | 项目根路径 | dict | D/A | |
| `projects.defaultPath` | string | 默认工作目录 | dict | D/A | `evolagent.ts:104` → 兜底 `process.cwd()` |
| `projects.autoCreate` | boolean | 自动创建项目目录 | dict | A | |
| `projects.list` | object | 项目名→路径映射 | dict | A | |

### 调试日志

| 参数 | 类型 | 用途 | 合并 | 层级 |
|------|------|------|------|------|
| `debug.logLevel` | enum | `DEBUG`/`INFO`/`WARN`/`ERROR` | dict | D/A |
| `debug.flusherDiag` | boolean | Flusher 诊断 | dict | D/A |
| `debug.aunTrace` | boolean | AUN trace | dict | D/A |
| `debug.aunSdkLog` | boolean | AUN SDK 日志 | dict | D/A |
| `debug.upmsg` | boolean | 上行消息调试 | dict | D/A |

### 备份

| 参数 | 类型 | 用途 | 合并 | 层级 |
|------|------|------|------|------|
| `extra_backup[]` | object[] | 快照额外备份声明（不得指向 `.env`） | list | A/R |

### chatmode / dispatch（H 链 agent schema 也定义了，但实际走 behavior）

| 参数 | 类型 | 用途 | 合并 | 层级 |
|------|------|------|------|------|
| `chatmode.{private,group,nothuman}` | enum | 对话模式（见 ⑤ behavior 详解） | dict | A（+behavior） |
| `dispatch` | enum | 群聊响应策略（见 ⑤） | scalar | A（+behavior） |

---

## ⑤ behavior.json — HA 链（Agent 可写的行为参数）

链：`agent/behavior.json → behavior.roles.<role> → relation/behavior.json`，叠加在 H 链结果之上。
CLI `ec model` / `ec perm` 等写入此处。**所有这些参数都支持关系级个性化（★）**。

| 参数 | 类型 | 用途 | 兜底值 | 兜底位置 |
|------|------|------|--------|---------|
| `active_baseagent` | string | 新会话使用的 baseagent | `'claude'` | `config-scope.ts:108` |
| `baseagents.<ba>.model` | string | 该 baseagent 模型 | 由 schema/无 | `evolagent.ts:74` |
| `baseagents.<ba>.effort` | enum | 推理强度 `low/medium/high/xhigh/max` | 无 | `evolagent.ts:87` |
| `baseagents.codex.reasoning` | string | Codex 专用：推理模式（effort 字段名） | 无 | `config-scope.ts:113` |
| `baseagents.codex.approvalsReviewer` | enum | `user`/`auto_review`/`guardian_subagent` | 无 | codex-runner |
| `baseagents.claude.agentProgressSummaries` | boolean | Agent 进度摘要 | 无 | claude-runner |
| `baseagents.claude.excludeDynamicSections` | boolean | 排除动态章节 | 无 | claude-runner |
| `baseagents.gemini.mode` | enum | `cli`/`sdk` | 无 | gemini-runner |
| `chatmode.private` | enum | 私聊：`interactive`(直接回) / `proactive`(须显式 send) | `'interactive'` | `evolagent.ts` resolveChatMode |
| `chatmode.group` | enum | 群聊对话模式 | `'proactive'` | 同上 |
| `chatmode.nothuman` | enum | 非人类（agent-to-agent）对话模式 | `'proactive'` | 同上 |
| `flush_delay` | number | 出站消息批次推送延迟（秒） | `3`（统一常量） | `core/defaults.ts` |
| `debounce` | number | 入站消息去抖间隔（秒） | `0` | `message-bridge.ts` |
| `dispatch` | enum | 群聊响应：`mention`(仅@) / `broadcast`(广播也响应) | `'mention'` | `aun.ts:1407` |
| `show_activities` | enum | 中间活动可见性 `all`/`none`（`all` 实际仅私聊显示） | `'all'` | `evolagent.ts:203` |
| `enable_rich_content` | boolean | 富内容渲染（当前仅飞书实现） | `false` | `feishu.ts:64` |
| `proactive.pre_tool_1stmsgchk` | boolean | proactive 下首个工具调用前须先 send/file 表态 | `true` | `message-processor.ts:102` |
| `proactive.tool_use_reminder` | boolean | proactive 下启用队列未读提醒/工具汇报提醒 | `true` | `message-processor.ts:103` |
| `render.{private,group,inject}` | string | 各渲染类型激活的 ECK modeName | 由 ECK manifest 兜底 | `message-processor.ts:1169` |
| `permissionMode` | string | 执行权限模式（见下方枚举） | `'auto'` | `config-scope.ts:221` / `types.ts` |
| `roles.<role>.baseagents` | object | 角色级 model/effort 覆盖 | — | `config-scope.ts:132` |
| `roles.<role>.permissionMode` | string | 角色级 permissionMode 覆盖 | — | `config-scope.ts:135` |

### permissionMode 取值与解析链

可选值：`auto` / `bypass` / `readonly` / `request` / `edit` / `plan` / `noask`

解析优先级（`resolvePermissionMode`，`config-scope.ts:227`）：
```
关系级 behavior.permissionMode
  → 角色级 roles.<role>.permissionMode
  → 内置角色默认（owner/admin→bypass, guest/anonymous→readonly）
  → 'auto'（兜底）
```

### chatmode 语义

- `interactive`：模型输出文本即视为回复，直接投递给对端。
- `proactive`：模型须显式调用 send/file 工具才发送，否则仅内部思考。
- 默认：私聊 `interactive`，群聊/非人类 `proactive`。

---

## 当前实际配置状态速查

| 层级 | 文件 | 状态 |
|------|------|------|
| ① 进程级 | `evolclaw.json` | ✅ 已配 aid/owners/ecweb |
| ② 全局级 | `agents/defaults.json` | ✅ 已配 baseagents/projects/show_activities/flush_delay/debounce |
| ③ Agent 级 | `agents/{1..5}lwj.agentid.pub/config.json` | ✅ 5 个 agent |
| ④ 关系级(H) | `relations/{peer}/config.json` | ❌ **零配置**（16 个关系目录无一 config.json） |
| ⑤ behavior(HA) | `agents/{aid}/behavior.json` | ⚠️ 按需生成（CLI 改 model/perm 时） |

---

详见配套文档：
- [PARAMS-GAPS-AND-FIXES.md](./PARAMS-GAPS-AND-FIXES.md) — 硬编码默认值清单、配置不一致、缺口与修复优先级
- [config-params-classified.md](./config-params-classified.md) — 按功能分类的旧版清单
