# 上下文组装机制（manifest）

ECK 把"每条消息该给 base agent 看哪些上下文"这件事，交给一份 **manifest** 声明式描述，由 `renderKitSections`（`src/agents/kit-renderer.ts`）在每次处理消息时执行。本文是这套机制的完整参考。

> 本文是按需载入文档。日常对话不需要读它——只有在排查"为什么某段上下文没出现/出现了"、要改 manifest、或要看实际渲染结果时才 Read。

## 三个阶段

evolclaw 收到消息 → 构造一份 **vars**（运行时变量，见下）→ `renderKitSections`：

1. **选段**：按 manifest 顺序遍历每个 section，用它的 `when` 条件 + 当前 vars 判断是否加载。
2. **渲染**：解析 section 路径里的 `$NAME` / `{{key}}` 占位符定位文件；`needsInjection:true` 的文件再跑一遍模板渲染（条件块 + 变量替换）。
3. **拼装**：所有命中的文件内容包进一个 `<system-reminder>` 块，作为 system prompt 的一部分注入。

整个过程对每次消息执行一次，结果同时落盘到调试目录（见"调试机制"）。

## manifest 文件位置

| 文件 | 角色 | 性质 |
|------|------|------|
| `$KITS/eck_manifest.json` | 基础 manifest（开发时维护） | 只读 |
| `$ECK/eck_manifest.json` | 用户覆盖（可选，默认不存在） | 可写 |

加载时合并两者（见"合并与覆盖"）。manifest 只加载一次并缓存。

## section 字段

manifest 是 `{ "$schema_version": 1, "sections": [...] }`。每个 section：

| 字段 | 必填 | 含义 |
|------|------|------|
| `id` | ✓ | 唯一标识，覆盖合并的键 |
| `type` | ✓ | `file`（单文件）或 `directory`（整目录） |
| `file` | type=file | 文件路径，可含 `$NAME` / `{{key}}` |
| `path` | type=directory | 目录路径 |
| `pattern` | | 目录匹配 glob，默认 `*.md`（支持 `*` 和 `{a,b}`） |
| `order` | ✓ | 排序，**升序**决定上下文中出现的先后 |
| `needsInjection` | ✓ | `true`=按模板渲染（解析 `{{}}` 条件与变量）；`false`=原样读入 |
| `when` | ✓ | 加载条件，`"always"` 或条件对象（见下） |
| `enabled` | | `false` 时整段跳过 |
| `description` | | 调试输出里的人类可读标签 |

## when 条件求值

`when` 是 `"always"` 或一个对象。求值规则（`evaluateWhen`）：

| 写法 | 含义 |
|------|------|
| `"always"` | 恒为真 |
| `{ "var": "X", "eq": V }` | `vars.X === V`；`eq:null` 匹配"未注入"（null/undefined） |
| `{ "var": "X", "neq": V }` | `vars.X !== V`；`neq:null` 匹配"已注入" |
| `{ "var": "X", "in": [...] }` | `vars.X` 在数组内 |
| `{ "var": "X", "nin": [...] }` | `vars.X` 不在数组内 |
| `{ "any": ["A","B"] }` | A、B 任一为真值 |
| `{ "all": ["A","B"] }` | A、B 全为真值 |

"真值"判定：非 `undefined`/`null`/`false`/`""`/`0`。

典型用法：`{ "var": "chatType", "neq": null }` = "非 coding 场景才加载"；`{ "var": "groupId", "neq": null }` = "群聊才加载"。

## 合并与覆盖

无 `$ECK/eck_manifest.json` 时，直接用基础 manifest。存在时：

- 覆盖文件含 `"mode": "replace"` → **完全替换**，只用覆盖文件的 sections。
- 否则 **patch 合并**：以 `id` 为键，覆盖文件里同 id 的字段浅合并进基础 section（`{...base, ...override}`），新 id 追加。

合并后统一按 `order` 升序排序。改某段行为（如关掉某层、调顺序、换条件）优先用覆盖文件，不动基础 manifest。

## 路径与模板渲染

### 路径占位符（所有 section 的 file/path）

- `$NAME`（大写）→ 从 vars 取真值，如 `$KITS_DOCS` → 包内文档目录。
- `{{key}}` → 从 vars 取真值，如 `{{chatType}}` → `private`，`{{peerKey}}` → `aun#alice.aid.pub`。

任一占位符解析为空 → 该 section 视为"未解析"，跳过（调试输出标 `unresolved-vars`）。文件不存在 → 标 `not-exist`，也跳过。这是**正常机制**：很多 section 靠"路径解析不出来"自然落选（如 coding 场景没有 `$PERSONAL_DIR`）。

### 模板渲染（仅 needsInjection:true 的文件）

读入跑三遍：

1. **条件块**（内层优先，可嵌套）：
   - `{{?key}}...{{/}}` — key 为真值才保留
   - `{{?key=value}}...{{/}}` — `String(vars.key)===value` 才保留
   - `{{?key!=value}}...{{/}}` — 不等才保留
2. **变量替换**：`{{key}}` 替换为值，非真值替换为空串。
3. **清理**：删掉空行。

`needsInjection:false` 的文件原样读入，不做任何替换（如 rules 目录、persona.md、各 venue 文档）。

## 运行时变量（vars）目录

vars 由 evolclaw 在 `message-processor.ts` 按当前会话构造。分两类：

**路径类**（供占位符展开成真实路径）：
`EVOLCLAW_HOME`、`PACKAGE_ROOT`、`CURRENT_PROJECT`、`KITS`、`KITS_RULES`、`KITS_DOCS`、`KITS_TEMPLATES`、`KITS_FRAGMENTS`、`PERSONAL_DIR`、`RELATIONS_DIR`、`VENUES_DIR`。

**内容/场景类**（供 when 判断与模板替换）：

| 变量 | 含义 |
|------|------|
| `selfAid` / `selfName` | 当前 agent 身份 |
| `hasPersona` / `hasWorkingMemory` | 是否有人格 / 当前关注 |
| `peerId` / `peerKey` / `peerName` | 对端原生 ID / 跨渠道键 / 显示名 |
| `peerRole` / `peerType` | 对端角色（owner/admin/guest/...）/ 类型（human/agent） |
| `groupId` | 群 ID（群聊时） |
| `chatType` | `private` / `group` / `null`(coding) |
| `channel` | 渠道类型（aun/feishu/...）|
| `dispatch` | 群分发模式（mention/broadcast） |
| `clientType` | 客户端类型（desktop/web/mobile） |
| `permissionMode` / `readonly` | 权限模式 / 是否只读 |
| `capabilities` | 当前渠道能力（图片输入/输出、文件发送） |
| `project` / `CURRENT_PROJECT` | 项目目录名 / 完整路径 |
| `sessionId` / `sessionName` / `sessionKey` / `sessionCreatedAt` / `threadId` | 会话标识与元信息 |
| `chatMode` | `interactive` / `proactive` |
| `baseAgent` / `baseAgentName` / `baseAgentModel` / `agentSessionId` | base agent 信息 |

coding 场景（无 channel/无身份）下，`chatType`、`channel`、`selfAid`、`peer*` 等均为空——这正是身份/关系/环境/渠道层落选的原因。

## 默认 manifest 的段（按 order）

| order | id | 类型 | 加载条件（when） | inject |
|-------|----|----|------------------|--------|
| 10 | rules | 目录 `$KITS_RULES` | always | ✗ |
| 20 | identity-layer | fragment | chatType≠null | ✓ |
| 21 | persona | `$PERSONAL_DIR/persona.md` | chatType≠null | ✗ |
| 22 | working-memory | `$PERSONAL_DIR/memory/working.md` | chatType≠null | ✗ |
| 30 | relation-layer | fragment | chatType∈{private,group} | ✓ |
| 35 | peer-profile | `$RELATIONS_DIR/{{peerKey}}/profile.md` | peerKey≠null | ✗ |
| 40 | venue-fragment | fragment | chatType≠null | ✓ |
| 41 | venue-chattype | `$KITS_DOCS/venues/{{chatType}}.md` | chatType≠null | ✗ |
| 42 | venue-channel-chattype | `$KITS_DOCS/venues/{{channel}}-{{chatType}}.md` | chatType≠null | ✗ |
| 43 | venue-group-profile | `$VENUES_DIR/{{channel}}#{{groupId}}/profile.md` | groupId≠null | ✗ |
| 44 | venue-client | `$KITS_DOCS/venues/client-{{clientType}}.md` | clientType≠null | ✗ |
| 50 | channel-layer | fragment | channel≠null | ✓ |
| 60 | session | fragment | always | ✓ |
| 70 | baseagent | fragment | baseAgent≠null | ✓ |

> 注意：`session`(60) 是 `always`，`baseagent`(70) 只看 `baseAgent` 是否注入——这两段**与 chatType 无关**，coding 场景也会加载。所谓"coding 仅 rules"是近似说法：精确地说 coding 场景命中的是 rules + session + baseagent（其余因 chatType/channel 为空而落选）。

## 输出结构

所有命中 section 的文件内容拼成一个块，注入 system prompt：

```
<system-reminder>
EvolClaw Context Kit documents are shown below.

Contenu de <展示路径> (<id — description>):

<文件内容>

...（每个文件一段，按 order）

IMPORTANT: Use this context when it affects the current interaction.
</system-reminder>
```

展示路径会把绝对路径回缩成 `$KITS_RULES`/`$AGENT_DIR` 等别名。`needsInjection:true` 的段额外单独汇总到 `fragments-*.md` 调试文件（见下）。

## 调试机制（看实际渲染结果）

每次渲染都把结果落盘到 **`$EVOLCLAW_HOME/data/eck-debug/`**，文件名带时间戳（`<字段>-YYYY-MM-DD-HH-MM-SS`）：

| 文件 | 内容 |
|------|------|
| `vars-<ts>.json` | 本次注入的全部 vars 真值 + 每个变量的中文说明 |
| `context-<ts>.md` | 最终注入 base agent 的完整 `<system-reminder>` 块（即上面"输出结构"的实际产物） |
| `fragments-<ts>.md` | 仅经过模板渲染（needsInjection）的段，单独汇总，便于核对 `{{}}` 替换是否正确 |
| `manifest-<ts>.md` | **诊断报告**：每个 section 的 when 是否通过、路径解析状态（ok/unresolved-vars/not-exist/skipped）、是否被用上、是否注入；含未解析占位符清单 |

排查"某段为什么没出现"：看 `manifest-<ts>.md` 里该 section 的 `status` 和 `unresolved tokens`。看"实际给 agent 的全文"：读 `context-<ts>.md`。

调试文件保留 24 小时，`cleanEckDebug` 自动清理过期的。

## 缓存与热加载

- **manifest 缓存**：`_manifestCache`，进程内只加载一次。改了 manifest 需触发 `invalidateKitCache()`（或重启）才生效。
- **文件内容缓存**：`_sessionPathCache` 按 `sessionId` 缓存已读文件内容；`invalidateSessionCache(sessionId)` 清单个会话。
- rules / fragments / docs 这些 `kits/` 下的文件，改完一般随会话重建生效（缓存按会话隔离）；manifest 本身的结构改动需要 invalidate。
