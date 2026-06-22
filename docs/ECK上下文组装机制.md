# ECK 上下文组装机制

本文档定义 EvolClaw Context Kit (ECK) 的上下文组装机制——从 manifest 配置到最终注入 base agent 的完整流程。

## 核心思想

ECK 的分层（身份层、关系层、环境层、渠道层）本质上是**参数驱动的上下文加载机制**。每条消息到达时，evolclaw 根据当前参数集合，通过 manifest 配置定位到具体的上下文文档，组装后注入 base agent 的 system prompt。

```
参数集合（selfAID / peerKey / chatType / channel / ...）
    +
manifest.json（加载规则）
    ↓
定位到具体的上下文文档
    ↓
渲染模板变量
    ↓
拼装注入 base agent system prompt
```

## Manifest 文件

### 位置与优先级

| 路径 | 性质 | 说明 |
|------|------|------|
| `$KITS/eck_manifest.json` | 基础 manifest | 随包发布，定义默认加载规则 |
| `$ECK/eck_manifest.json` | 覆盖 manifest | 用户自定义，可选 |

### 合并策略

| 模式 | 行为 |
|------|------|
| 无覆盖文件 | 只用基础 manifest |
| 默认（无 `mode` 字段） | 按 `section.id` 浅合并——同 id 字段级覆盖，新 id 追加 |
| `mode: 'replace'` | 完全忽略基础 manifest，只用覆盖文件 |

### Section 结构

```jsonc
{
  "id": "section-id",           // 唯一标识（合并时按此匹配）
  "type": "file" | "directory", // 加载单文件还是整个目录
  "file": "路径（type=file 时）",
  "path": "路径（type=directory 时）",
  "pattern": "*.md",            // directory 时的文件匹配模式
  "order": 40,                  // 渲染顺序（升序）
  "needsInjection": true,       // 是否渲染模板变量
  "enabled": true,              // false 时跳过
  "when": "always" | {...},     // 加载条件
  "description": "说明"
}
```

### When 条件语法

```jsonc
// 始终加载
"when": "always"

// 单变量条件
"when": { "var": "chatType", "eq": "group" }      // 等于
"when": { "var": "chatType", "neq": null }         // 不等于（非空即加载）
"when": { "var": "chatType", "in": ["private", "group"] }  // 在列表中
"when": { "var": "chatType", "nin": ["broadcast"] }        // 不在列表中

// 多变量条件
"when": { "any": ["peerKey", "groupId"] }          // 任一非空
"when": { "all": ["channel", "chatType"] }         // 全部非空
```

### 路径变量替换

路径中支持两种变量语法：

| 语法 | 含义 | 示例 |
|------|------|------|
| `$PATH_VAR` | 路径级变量（大写） | `$KITS_FRAGMENTS`、`$RELATIONS_DIR` |
| `{{contextVar}}` | 上下文变量（camelCase） | `{{selfAid}}`、`{{peerKey}}`、`{{channel}}` |

manifest 中可用的路径变量：

| 变量 | 展开为 | 含义 |
|------|--------|------|
| `$PACKAGE_ROOT` | evolclaw 包根 | 基础路径 |
| `$EVOLCLAW_HOME` | 用户数据根 | 基础路径 |
| `$KITS` | `$PACKAGE_ROOT/kits` | ECK 知识包根 |
| `$KITS_RULES` | `$KITS/rules` | 自动加载规则 |
| `$KITS_DOCS` | `$KITS/docs` | 按需加载文档 |
| `$KITS_TEMPLATES` | `$KITS/templates` | prompt 模板 |
| `$KITS_FRAGMENTS` | `$KITS_TEMPLATES/system-fragments` | 动态注入 fragment |
| `$ECK` | `$EVOLCLAW_HOME/eck` | ECK 运行时配置 |
| `$AGENT_DIR` | `$EVOLCLAW_HOME/agents/<selfAid>` | 当前 agent 根 |
| `$PERSONAL_DIR` | `$AGENT_DIR/personal` | 个人数据层 |
| `$RELATIONS_DIR` | `$AGENT_DIR/relations` | 关系层根 |
| `$VENUES_DIR` | `$AGENT_DIR/venues` | 环境层根 |

**关键特性**：变量为空或解析后路径不存在时，整个 section 静默跳过（不报错）。这实现了"存在则加载"的语义。

### 模板渲染语法

`needsInjection: true` 的文件支持模板语法：

```
{{variableName}}                    变量替换（为空时输出空字符串）

{{?varName}}                        条件块：varName 非空时渲染
  内容...
{{/}}

{{?channel=aun}}                    条件块：channel 等于 aun 时渲染
  内容...
{{/}}

{{?channel!=aun}}                   条件块：channel 不等于 aun 时渲染
  内容...
{{/}}
```

条件块支持嵌套，解析时从最内层向外逐层展开。

## 加载流程

### 每条消息的处理

```
1. evolclaw 收到入站消息
2. 完成 agent 路由和 session 路由
3. 构建 KitRenderContext（收集所有参数）
4. 调用 renderKitSections(ctx)
5. 对 manifest 中每个 section（按 order 升序）：
   a. enabled === false → 跳过
   b. evaluateWhen(when, vars) === false → 跳过
   c. resolvePath(file/path, vars) → 变量替换 + 存在性检查
      - 变量为空 → return null → 跳过
      - 路径不存在 → return null → 跳过
   d. 读取文件内容（有 session 级缓存）
   e. needsInjection=true → renderTemplate(content, vars)
   f. 拼入输出
6. 所有 section 拼装为完整上下文字符串
7. 注入 base agent 的 system prompt
```

### 缓存机制

- manifest 本身在进程启动时加载一次，缓存在内存
- 每个 session 有独立的文件内容缓存（同一 session 内同一文件不重复读取）
- agent 热重载时调用 `invalidateKitCache()` 清除 manifest 缓存
- session 结束时调用 `invalidateSessionCache(sessionId)` 清除文件缓存

## 输出结构

所有命中 section 的文件内容按 order 拼成一个块，包进 `<system-reminder>` 注入 system prompt：

```
<system-reminder>
EvolClaw Context Kit documents are shown below.

Contenu de <展示路径> (<id — description>):

<文件内容>

...（每个文件一段，按 order）

IMPORTANT: Use this context when it affects the current interaction.
</system-reminder>
```

展示路径会把绝对路径回缩成 `$KITS_RULES` / `$AGENT_DIR` 等别名。

## 调试机制（看实际渲染结果）

每次渲染都把结果落盘到 **`$EVOLCLAW_HOME/data/eck-debug/`**，文件名带时间戳（`<字段>-YYYY-MM-DD-HH-MM-SS`）：

| 文件 | 内容 |
|------|------|
| `vars-<ts>.json` | 本次注入的全部 vars 真值 + 每个变量的中文说明 |
| `context-<ts>.md` | 最终注入 base agent 的完整 `<system-reminder>` 块（即上面"输出结构"的实际产物） |
| `fragments-<ts>.md` | 仅经过模板渲染（needsInjection）的段，单独汇总，便于核对 `{{}}` 替换是否正确 |
| `manifest-<ts>.md` | **诊断报告**：每个 section 的 when 是否通过、路径解析状态（ok/unresolved-vars/not-exist/skipped）、是否被用上、是否注入；含未解析占位符清单 |

排查"某段为什么没出现"：看 `manifest-<ts>.md` 里该 section 的 `status` 和未解析占位符。看"实际给 agent 的全文"：读 `context-<ts>.md`。

调试文件保留 24 小时，`cleanEckDebug` 在进程启动时自动清理过期的。

## 三种加载方式

| 加载方式 | 决策者 | 驱动方式 | 例子 |
|---------|-------|---------|------|
| **全量加载** | manifest | `when: "always"` | rules/ 核心规则、session 参数 |
| **按条件自动加载** | manifest | `when: { var, eq/neq/in }` + 路径存在性 | 身份层（chatType 非空时）、对端档案（peerKey 非空时） |
| **按需加载** | agent 自主 | agent 在对话中主动 Read 文件 | 查阅 kits/docs/ 下的详细参考文档 |

前两种由 manifest 控制，第三种由 agent 根据各层文档中的"按需加载指引"自主决定。

## 参数集合

每次上下文组装时可用的完整参数：

### 路径参数

| 参数 | 含义 |
|------|------|
| `EVOLCLAW_HOME` | 用户数据根 |
| `PACKAGE_ROOT` | evolclaw 包根 |
| `CURRENT_PROJECT` | 当前项目路径 |

### 身份参数

| 参数 | 含义 |
|------|------|
| `selfAid` | 本端 agent 的 AID |
| `selfName` | 本端显示名 |
| `hasPersona` | 是否有 persona 文件 |
| `hasWorkingMemory` | 是否有 working memory |

### 关系参数

| 参数 | 含义 |
|------|------|
| `peerId` | 对端在当前渠道的原生 ID |
| `peerKey` | 对端跨渠道标识（`<channel>#<urlEncode(peerId)>`） |
| `peerName` | 对端显示名 |
| `peerRole` | 对端角色（owner/admin/guest/anonymous） |
| `peerType` | 对端类型（human/agent） |

### 环境参数

| 参数 | 含义 |
|------|------|
| `chatType` | 聊天类型（private/group） |
| `channel` | 渠道类型（aun/feishu/wechat/...） |
| `groupId` | 群 ID（仅群聊时有值） |
| `dispatch` | 群聊分发模式：`mention`（被 @ 才响应）/ `broadcast`（所有消息都响应）。仅群聊有效 |
| `clientType` | 客户端类型（desktop/mobile/web，如可获取） |

### 会话参数

| 参数 | 含义 |
|------|------|
| `sessionId` | evolclaw 会话 ID |
| `sessionName` | 会话名称 |
| `sessionCreatedAt` | 会话创建时间 |
| `threadId` | 话题 ID |
| `chatMode` | 会话模式（interactive/proactive） |
| `permissionMode` | baseagent 会话权限模式（auto/bypass/request/edit/plan/noask/readonly） |

### Base Agent 参数

| 参数 | 含义 |
|------|------|
| `baseAgent` | base agent 类型标识 |
| `baseAgentName` | base agent 显示名 |
| `baseAgentModel` | 当前模型 |
| `agentSessionId` | base agent 的 session ID |

### 渠道能力参数

| 参数 | 含义 |
|------|------|
| `capabilities` | 渠道能力声明（file/image/interaction/markdown/thought/status） |

## 各层的参数→路径映射

### 身份层

| section | 条件 | 路径 | 说明 |
|---------|------|------|------|
| identity-layer | chatType != null | `$KITS_FRAGMENTS/identity.md` | 身份参数注入（模板） |
| persona | chatType != null + 文件存在 | `$PERSONAL_DIR/persona.md` | 人格文件（存在则加载） |
| working-memory | chatType != null + 文件存在 | `$PERSONAL_DIR/memory/working.md` | 当前关注（存在则加载） |

### 关系层

| section | 条件 | 路径 | 说明 |
|---------|------|------|------|
| relation-layer | chatType in [private, group] | `$KITS_FRAGMENTS/relation.md` | 关系参数注入（模板） |
| peer-profile | peerKey != null | `$RELATIONS_DIR/{{peerKey}}/profile.md` | 对端关系档案（存在则加载） |

### 环境层

| section | 条件 | 路径 | 说明 |
|---------|------|------|------|
| venue-fragment | chatType != null | `$KITS_FRAGMENTS/venue.md` | 环境基础参数注入（模板） |
| venue-chattype | chatType != null | `$KITS_DOCS/venues/{{chatType}}.md` | 场景通用文档（private.md / group.md） |
| venue-channel-chattype | chatType != null | `$KITS_DOCS/venues/{{channel}}-{{chatType}}.md` | 渠道+场景文档（feishu-group.md 等） |
| venue-group-profile | groupId != null | `$VENUES_DIR/{{channel}}#{{groupId}}/profile.md` | 具体群环境文档（存在则加载） |
| venue-client | clientType != null | `$KITS_DOCS/venues/client-{{clientType}}.md` | 设备环境文档（存在则加载） |

### 渠道层

| section | 条件 | 路径 | 说明 |
|---------|------|------|------|
| channel-layer | channel != null | `$KITS_FRAGMENTS/channel.md` | 渠道能力+发消息命令（模板） |
| commands | channel != null | `$KITS_FRAGMENTS/commands.md` | 命令集能力卡：按场景列出可用命令集及文档路径（模板） |

### 会话层 & Base Agent

| section | 条件 | 路径 | 说明 |
|---------|------|------|------|
| session | always | `$KITS_FRAGMENTS/session.md` | 会话状态参数（模板） |
| baseagent | baseAgent != null | `$KITS_FRAGMENTS/baseagent.md` | base agent 配置（模板） |

## 环境层文档目录结构

```
$KITS_DOCS/venues/                          通用环境文档（随包发布，只读）
├── private.md                              单聊场景通用指引
├── group.md                                群聊场景通用指引
├── aun-private.md                          AUN 单聊特有
├── aun-group.md                            AUN 群聊特有
├── feishu-private.md                       飞书单聊特有
├── feishu-group.md                         飞书群聊特有（怎么取群信息/公告/成员/管理员）
├── client-desktop.md                       桌面端环境
├── client-mobile.md                        移动端环境
└── ...

$AGENT_DIR/venues/                          agent 私有环境文档（按需创建）
└── <channel>#<urlEncode(groupId)>/
    └── profile.md                          具体群的特别内容
```

## 加载顺序（order）

```
10  rules/                    ECK 核心规则（全量加载）
20  identity-layer            身份层模板
21  persona                   人格文件
22  working-memory            当前关注
30  relation-layer            关系层模板
35  peer-profile              对端关系档案
40  venue-fragment            环境层模板
41  venue-chattype            场景通用文档
42  venue-channel-chattype    渠道+场景文档
43  venue-group-profile       具体群环境文档
44  venue-client              设备环境文档
50  channel-layer             渠道层模板
55  commands                  命令集能力卡
60  session                   会话层
70  baseagent                 Base Agent 配置
```

## 用户自定义覆盖

用户可以在 `$ECK/eck_manifest.json` 中：

### 禁用某个 section

```json
{
  "sections": [
    { "id": "venue-client", "enabled": false }
  ]
}
```

### 修改加载条件

```json
{
  "sections": [
    { "id": "peer-profile", "when": { "var": "peerRole", "in": ["owner", "admin"] } }
  ]
}
```

### 新增自定义 section

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

### 完全替换

```json
{
  "$schema_version": 1,
  "mode": "replace",
  "sections": [ ... ]
}
```

