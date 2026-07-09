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

## 多 manifest：按会话原型（sessionType）选清单

不同**会话原型**加载不同的 manifest 文件，各自走同一引擎、同一两级覆盖机制：

| 会话原型（`session.sessionType`） | manifest 文件 | 用途 |
|------|------|------|
| `main`（默认） | `eck_manifest.json` | 主会话，完整上下文 |
| `auxiliary` | `eck_manifest.auxiliary.json` | 辅助会话（双会话模式），精简上下文 |
| 未来：`approval` / `goal` / ... | `eck_manifest.<type>.json` | 权限审批 / 目标管理等专用会话 |

**映射由 agent config 的 `sessionManifests` 字段定义**（走 config 分级覆盖：关系/环境/agent 级）：

```jsonc
// $AGENT_DIR/config.json
{
  "sessionManifests": {
    "main": "eck_manifest.json",              // 缺省可省略，兜底就是它
    "auxiliary": "eck_manifest.auxiliary.json"
  }
}
```

渲染时按 `session.sessionType`（缺省 `'main'`）查 `sessionManifests`，取不到则回退 `eck_manifest.json`。
**每个 manifest 文件各自两级合并**（`$KITS/<file>` + `$ECK/<file>`），互不干扰。

## section 字段

manifest 是 `{ "$schema_version": 1, "sections": [...] }`。每个 section：

| 字段 | 必填 | 含义 |
|------|------|------|
| `id` | ✓ | 唯一标识，覆盖合并的键 |
| `type` | ✓ | `file`（单文件）或 `directory`（整目录） |
| `file` | type=file | 文件路径，可含 `$NAME` / `{{key}}` |
| `path` | type=directory | 目录路径 |
| `pattern` | | 目录匹配 glob，默认 `*.md`（支持 `*` 和 `{a,b}`） |
| `maxFiles` | | type=directory：最多加载文件数，默认 20。超出停止加载并注入截断说明 |
| `maxBytes` | | type=directory：最多加载总字节，默认 40960（40KB）。超出停止加载并注入截断说明（至少保留 1 个文件） |
| `order` | ✓ | 排序，**升序**决定上下文中出现的先后 |
| `needsInjection` | ✓ | `true`=按模板渲染（解析 `{{}}` 条件与变量）；`false`=原样读入 |
| `when` | ✓ | 加载条件，`"always"` 或条件对象（见下） |
| `enabled` | | `false` 时整段跳过 |
| `loop` | | 三段式循环：`{ forEach, childFile, separator? }`。有 loop 时 file 作 wrapper，见"三段式循环" |
| `description` | | 调试输出里的人类可读标签 |

### 三段式循环（wrapper + forEach + child）

批量数据（如一批消息）用 `loop` 字段做"包裹层 + 循环体"渲染，避免手写重复模板：

```jsonc
{
  "id": "batch-messages",
  "type": "file",
  "file": "$KITS_.../batch-wrapper.md",   // ① wrapper：包裹模板，含 {{@loop}} 占位
  "loop": {
    "forEach": "items",                    // ② 循环 vars 里的数组变量
    "childFile": "$KITS_.../batch-item.md", // ③ 每元素渲染的子模板
    "separator": "\n"                      // 元素间分隔符，默认 "\n"
  },
  "needsInjection": true,
  "order": 5,
  "when": "always"
}
```

**wrapper 模板**（`{{@loop}}` 处填入循环结果）：
```
【批次 剩余{{remainingInQueue}}条 | 主队列{{pendingCount}}】
{{@loop}}
【批次结束】
```

**childFile 模板**（每个元素，可访问元素字段 + 外层 vars + `{{@index}}`）：
```
[{{@index}}] {{peerName}}: {{content}}
```

**渲染规则**：
- 对 `vars[forEach]` 数组每个元素渲染 childFile（对象元素 → 字段可用 `{{field}}`；标量 → `{{.}}`），以 `separator` 连接
- wrapper 单独渲染（其变量如 `remainingInQueue` 来自 vars），`{{@loop}}` 位置**字面量填入**循环结果 → 循环结果不被二次解析
- childFile 内可再嵌套 `{{#each}}` 或另一个占位，支持多层
- 空数组 / 非数组 → 循环结果为空串
- wrapper 不含 `{{@loop}}` → 循环结果追加到 wrapper 末尾（容错）

> **消息渲染层的 loop**：`eck_message_manifest.json` 里的 loop 段是**批次包裹层**——
> child 由 message-renderer 的逐条渲染（`renderOneItem`，自带 content 哨兵）产出，
> 用户消息文本里的 `{{}}` 不会被二次解析。批次 vars（remainingInQueue 等）从 sessionVars 透传。
> 详见 `prompt-loading-architecture.md`。

### 清单顶层字段

除 `sections` 外，manifest 顶层还支持全局限额（总闸，跨所有段累计）：

| 字段 | 默认 | 含义 |
|------|------|------|
| `$schema_version` | — | 版本号 |
| `mode` | patch | `patch`（合并）/ `replace`（完全替换），见"合并与覆盖" |
| `totalMaxFiles` | 50 | 整个清单渲染最多文件数。达到后停止加载后续所有段 |
| `totalMaxBytes` | 102400（100KB） | 整个清单渲染最多总字节。达到后停止加载后续所有段 |

## 目录加载限额（安全保护）

`type: directory` 段加载整个目录，若目录内容失控会撑爆提示词。两层限额保护：

- **单目录限额**（`maxFiles` 20 / `maxBytes` 40KB）：单个目录段最多加载多少。超出时停止加载该目录后续文件，并在该段末尾注入一行截断说明：
  `[注意] 目录 $KITS_RULES 未完整加载：N 个文件未加载（达文件数上限 20 个）。`
- **总闸限额**（`totalMaxFiles` 50 / `totalMaxBytes` 100KB）：整个清单所有段加起来的上限。达到后停止加载后续所有命中段，末尾注入总截断说明，**带上未加载的 section id 集合**：
  `[注意] 上下文清单总量超限（>50 文件 / >100KB），以下 section 未加载：goal-fragment, extra-docs。`

> **注**：字节按文件原始内容（`rawContent`）计，不含渲染后变化，也不含截断说明行本身。
> 单目录"至少保留 1 个文件"——避免单个超大文件导致整段为空。
> 截断信息同时写入调试输出（`manifest-*.md`），便于排查。

> **现状**：当前唯一目录段 `$KITS_RULES` = 6 文件 / ~18KB，远低于默认限额，不受影响。
> 新增规则文档时注意别让该目录逼近 40KB。

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

### 覆盖示例

禁用某段：

```json
{ "sections": [ { "id": "venue-client", "enabled": false } ] }
```

改加载条件（仅 owner/admin 才载入对端档案）：

```json
{ "sections": [ { "id": "peer-profile", "when": { "var": "peerRole", "in": ["owner", "admin"] } } ] }
```

新增自定义段：

```json
{
  "sections": [
    {
      "id": "my-custom-context",
      "type": "file",
      "file": "$AGENT_DIR/custom/my-rules.md",
      "order": 25,
      "needsInjection": false,
      "when": "always",
      "description": "我的自定义规则"
    }
  ]
}
```

完全替换（忽略基础 manifest）：

```json
{ "$schema_version": 1, "mode": "replace", "sections": [ ... ] }
```

## 路径与模板渲染

### 路径占位符（所有 section 的 file/path）

- `$NAME`（大写）→ 从 vars 取真值，如 `$KITS_DOCS` → 包内文档目录。
- `{{key}}` → 从 vars 取真值，如 `{{chatType}}` → `private`，`{{peerKey}}` → `aun#alice.aid.pub`。

manifest 中常用路径变量的展开值：

| 变量 | 展开为 |
|------|--------|
| `$PACKAGE_ROOT` | evolclaw 包根 |
| `$EVOLCLAW_HOME` | 用户数据根（默认 `~/.evolclaw`） |
| `$KITS` | `$PACKAGE_ROOT/kits` |
| `$KITS_RULES` | `$KITS/rules` |
| `$KITS_DOCS` | `$KITS/docs` |
| `$KITS_TEMPLATES` | `$KITS/templates` |
| `$KITS_FRAGMENTS` | `$KITS_TEMPLATES/system-fragments` |
| `$ECK` | `$EVOLCLAW_HOME/eck` |
| `$AGENT_DIR` | `$EVOLCLAW_HOME/agents/<selfAid>` |
| `$PERSONAL_DIR` | `$AGENT_DIR/personal` |
| `$RELATIONS_DIR` | `$AGENT_DIR/relations` |
| `$VENUES_DIR` | `$AGENT_DIR/venues` |

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

## 三种加载方式

| 加载方式 | 决策者 | 驱动方式 | 例子 |
|---------|-------|---------|------|
| **全量加载** | manifest | `when: "always"` | rules/ 核心规则、session 参数 |
| **按条件自动加载** | manifest | `when` 条件 + 路径存在性 | 身份层（chatType 非空时）、对端档案（peerKey 非空时） |
| **按需加载** | agent 自主 | agent 在对话中主动 Read 文件 | 查阅 `$KITS_DOCS/` 下的详细参考文档 |

前两种由 manifest 控制，第三种由 agent 根据各层文档中的"按需加载指引"自主决定。

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
| 43 | relation-group-profile | `$RELATIONS_DIR/{{peerKey}}/profile.md` | groupId≠null | ✗ |
| 44 | venue-client | `$KITS_DOCS/venues/client-{{clientType}}.md` | clientType≠null | ✗ |
| 50 | channel-layer | fragment | channel≠null | ✓ |
| 55 | commands | fragment | channel≠null | ✓ |
| 60 | session | fragment | always | ✓ |
| 70 | baseagent | fragment | baseAgent≠null | ✓ |

> 注意：`session`(60) 是 `always`，`baseagent`(70) 只看 `baseAgent` 是否注入——这两段**与 chatType 无关**，coding 场景也会加载。所谓"coding 仅 rules"是近似说法：精确地说 coding 场景命中的是 rules + session + baseagent（其余因 chatType/channel 为空而落选）。

## 环境层文档目录结构

venue-* 段从随包发布的通用文档（只读）取文件：

```
$KITS_DOCS/venues/                  通用环境文档（随包发布，只读）
├── private.md                      单聊场景通用指引
├── group.md                        群聊场景通用指引
├── aun-private.md                  AUN 单聊特有
├── aun-group.md                    AUN 群聊特有
├── feishu-private.md               飞书单聊特有
├── feishu-group.md                 飞书群聊特有
├── client-desktop.md               桌面端环境
├── client-mobile.md                移动端环境
└── ...
```

> **注意**：具体群/私聊实例的 profile 数据落**关系层** `$RELATIONS_DIR/<peerKey>/profile.md`，
> 由 `relation-group-profile` 段注入，不在 venues 目录。

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
