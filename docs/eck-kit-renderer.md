# ECK/Kits 模板注入机制

evolclaw 的 system prompt 注入体系由三层加载机制构成，通过 `eck_manifest.json` 声明式驱动。

## 三层加载机制

| 层级 | 位置 | 加载方式 | 说明 |
|------|------|----------|------|
| **自动载入** | `kits/rules/` | 无条件加载 | ECK 核心规则，每个会话都加载 |
| **按需载入** | `kits/docs/` | agent 自行判断 | 通过已载入文档中的提示词，agent 决定是否读取 |
| **条件自动载入** | `kits/templates/system-fragments/` | manifest 控制 | 根据参数条件（身份层/关系层/环境层/渠道层）自动加载 |

## 两层目录

| 层 | 路径 | 可写 | 升级影响 |
|---|---|---|---|
| **kits**（只读源） | `<package>/kits/` | 否 | 整体覆盖 |
| **eck**（用户运行时） | `EVOLCLAW_HOME/eck/` | 是 | 不受影响 |

两层目录结构完全镜像。加载任意文件时，先查 `eck/`，不存在则 fallback 到 `kits/`。

```
resolveFile(relativePath):
  eck/<relativePath> 存在 → 用 eck/
  否则               → 用 kits/
```

用户/agent 想定制某个片段时，从 `kits/` 复制对应文件到 `eck/` 同路径再修改。包升级不会覆盖 `eck/`。

## 目录结构

```
kits/
├── eck_manifest.json              ← 加载清单（根目录）
├── rules/                         ← 自动载入（目录加载）
│   ├── 01-overview.md
│   ├── 02-navigation.md
│   ├── 03-identity.md
│   ├── 04-relation.md
│   ├── 05-venue.md
│   └── 06-channel.md
├── docs/                          ← 按需载入
│   ├── INDEX.md
│   ├── path-registry.md
│   ├── aun/
│   ├── evolclaw/
│   ├── identity/
│   ├── relations/
│   ├── venues/
│   └── channels/
└── templates/
    └── system-fragments/          ← 条件自动载入（6 个文件）
        ├── identity.md              身份层
        ├── relation.md              关系层
        ├── venue.md                 环境层
        ├── channel.md               渠道层
        ├── runtime.md               运行时（evolclaw）
        └── baseagent.md             Base Agent 特定
```

## eck_manifest.json 格式

`eck_manifest.json` 位于 `kits/` 根目录，定义所有需要条件加载的内容。

```json
{
  "$schema_version": 1,
  "templatesDir": "templates/system-fragments",
  "sections": [
    {
      "id": "rules",
      "type": "directory",
      "path": "rules",
      "order": 10,
      "needsInjection": false,
      "when": "always",
      "description": "ECK 核心规则（自动载入）"
    },
    {
      "id": "identity-layer",
      "type": "file",
      "file": "templates/system-fragments/identity.md",
      "order": 20,
      "needsInjection": true,
      "when": {
        "var": "scene",
        "neq": "coding"
      },
      "description": "身份层：我是谁"
    },
    {
      "id": "relation-layer",
      "type": "file",
      "file": "templates/system-fragments/relation.md",
      "order": 30,
      "needsInjection": true,
      "when": {
        "var": "scene",
        "in": ["private", "group"]
      },
      "description": "关系层：跟我聊天的是谁"
    },
    {
      "id": "venue-layer",
      "type": "file",
      "file": "templates/system-fragments/venue.md",
      "order": 40,
      "needsInjection": true,
      "when": {
        "var": "chatType",
        "neq": null
      },
      "description": "环境层：我在什么场景下"
    },
    {
      "id": "channel-layer",
      "type": "file",
      "file": "templates/system-fragments/channel.md",
      "order": 50,
      "needsInjection": true,
      "when": {
        "var": "channel",
        "neq": null
      },
      "description": "渠道层：我通过什么通信"
    },
    {
      "id": "runtime",
      "type": "file",
      "file": "templates/system-fragments/runtime.md",
      "order": 60,
      "needsInjection": true,
      "when": "always",
      "description": "运行时参数"
    },
    {
      "id": "baseagent",
      "type": "file",
      "file": "templates/system-fragments/baseagent.md",
      "order": 70,
      "needsInjection": true,
      "when": {
        "var": "baseAgent",
        "neq": null
      },
      "description": "Base Agent 特定配置"
    }
  ]
}
```

### Section 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | section 唯一标识 |
| `type` | enum | ✅ | `file` 或 `directory` |
| `file` | string | 条件 | type=file 时必需，文件路径。支持变量替换 |
| `path` | string | 条件 | type=directory 时必需，目录路径。支持变量替换 |
| `pattern` | string | 否 | type=directory 时有效，文件名匹配的 glob 模式，默认 `*.md` |
| `order` | number | ✅ | 加载顺序（数字越小越先加载） |
| `needsInjection` | boolean | ✅ | 是否需要动态注入参数 |
| `when` | object/string | ✅ | 加载条件（见下方语法） |
| `description` | string | 否 | 说明文字 |

### 路径变量替换

`file` 和 `path` 字段支持注入参数中的变量替换：

| 语法 | 含义 | 示例 |
|------|------|------|
| `$VAR_NAME` | 注入参数（大写+下划线命名） | `$SELF_DIR/persona.md` |
| `{{varName}}` | 注入参数（camelCase 命名） | `$RELATIONS_DIR/contacts/{{peerName}}/` |

两种语法从同一个 vars 字典取值，`$VAR_NAME` 匹配 `vars[VAR_NAME]`，`{{varName}}` 匹配 `vars[varName]`。

路径替换后如果目标不存在，该 section 静默跳过（不报错）。

**示例**：

```json
{
  "id": "peer-profile",
  "type": "file",
  "file": "$PEER_DIR/profile.md",
  "order": 35,
  "needsInjection": false,
  "when": { "var": "peerAid", "neq": null },
  "description": "当前对端的关系档案"
}
```

```json
{
  "id": "venue-docs",
  "type": "directory",
  "path": "$VENUES_DIR/{{venueName}}/",
  "pattern": "*.md",
  "order": 45,
  "needsInjection": false,
  "when": { "var": "venueUid", "neq": null },
  "description": "当前 venue 的文档"
}
```

### Directory 类型加载规则

当 `type: "directory"` 时：

1. 解析路径参数（`$PATH_VAR` 和 `{{var}}`）
2. 如果目录不存在，静默跳过
3. 按 `pattern`（默认 `*.md`）过滤目录下的文件
4. 按文件名**字符串排序**（字典序）
5. 依次加载并拼接内容
6. 如果 `needsInjection: true`，对每个文件内容进行参数注入

`pattern` 使用 glob 语法：
- `*.md` — 匹配所有 .md 文件（默认）
- `*.{md,txt}` — 匹配 .md 和 .txt 文件
- `profile*` — 匹配以 profile 开头的文件

## when 条件语法

| 语法 | 含义 | 示例 |
|---|---|---|
| `"always"` | 无条件加载 | `"when": "always"` |
| `{ "var": "x", "eq": value }` | 等于某值 | `{ "var": "scene", "eq": "private" }` |
| `{ "var": "x", "neq": value }` | 不等于某值 | `{ "var": "scene", "neq": "coding" }` |
| `{ "var": "x", "in": [...] }` | 在值列表中 | `{ "var": "scene", "in": ["private", "group"] }` |
| `{ "var": "x", "nin": [...] }` | 不在值列表中 | `{ "var": "scene", "nin": ["coding"] }` |
| `{ "any": ["a", "b"] }` | 任一变量为真值 | `{ "any": ["peerAid", "groupId"] }` |
| `{ "all": ["a", "b"] }` | 全部变量为真值 | `{ "all": ["selfAid", "channel"] }` |

## 注入参数清单

manifest 中 `needsInjection: true` 的 section 会使用以下参数进行模板渲染。`file`/`path` 字段中的 `$VAR` 和 `{{var}}` 也从同一参数字典取值。

### 基础路径

| 参数名 | 描述 | 来源 |
|--------|------|------|
| `$EVOLCLAW_HOME` | 用户数据根目录 | `resolveRoot()` |
| `$PACKAGE_ROOT` | evolclaw 包根目录 | `getPackageRoot()` |
| `$CURRENT_PROJECT` | 当前项目完整路径 | session 的 projectPath |

### 身份参数（Identity）

| 参数名 | 描述 | 来源 |
|--------|------|------|
| `selfAid` | 当前 agent 的 AID | channel adapter `_selfAid()` |
| `selfName` | 当前 agent 的显示名 | channel adapter `_selfName()` |
| `hasPersona` | 是否有 persona 内容 | persona.md 是否存在且非空 |
| `hasWorkingMemory` | 是否有 working memory | working.md 是否存在且非空 |

### 关系参数（Relation）

| 参数名 | 描述 | 来源 |
|--------|------|------|
| `peerId` | 对端在该渠道的原生 ID（不 encode） | `message.peerId`（AUN 是 AID，飞书是 user_id…） |
| `peerKey` | 对端跨渠道唯一标识 | `${channel}#${encodeURIComponent(peerId)}` |
| `peerName` | 对端显示名 | `message.peerName` / `session.metadata.peerName` |
| `peerRole` | 对端角色 | `session.identity.role`（owner/admin/guest/anonymous） |
| `groupId` | 群组 ID（群聊时） | `session.metadata.groupId` |

### 场景参数（Scene & Venue）

| 参数名 | 描述 | 来源 |
|--------|------|------|
| `scene` | 场景类型 | 从 chatType 推导：coding/private/group |
| `chatType` | 聊天类型 | `session.chatType`（private/group/null） |
| `channel` | 当前渠道 | `options.channelType` / `message.channel` |
| `venueUid` | venue 唯一标识 | 暂未实现 |

### 项目与会话参数

| 参数名 | 描述 | 来源 |
|--------|------|------|
| `project` | 当前项目目录名 | `path.basename(CURRENT_PROJECT)` |
| `sessionName` | 会话名称 | `session.name` |

### 模式参数

| 参数名 | 描述 | 来源 |
|--------|------|------|
| `sessionMode` | 会话模式 | interactive/proactive |
| `readonly` | 是否只读模式 | `session.metadata.permissionMode === 'readonly'` |

### 能力参数

| 参数名 | 描述 | 来源 |
|--------|------|------|
| `canSendFile` | 当前渠道是否支持发文件 | `channelInfo.adapter.capabilities.file` |
| `capabilities` | 渠道能力列表 | 拼接字符串如"图片输入、图片输出、文件发送" |

### Base Agent 参数

| 参数名 | 描述 | 来源 |
|--------|------|------|
| `baseAgent` | 当前 base agent 规范值 | `normalizeBaseagent(agent.name).canonical`（claude/codex/gemini/hermes/unknown） |
| `baseAgentName` | 当前 base agent 显示名 | `normalizeBaseagent(agent.name).displayName`（Claude Code/Codex/Gemini CLI/Hermes） |

**参数总计**：24 个（3 个基础路径 + 21 个业务参数）

## manifest 合并策略（eck 覆盖 kits）

`eck/eck_manifest.json` 支持两种形态：

**patch 模式**（默认，`"mode": "patch"`）：按 `id` 匹配，用户侧条目与包内同 id 条目 shallow merge，新 id 追加，未提及的 id 保持包内默认。

```json
{
  "$schema_version": 1,
  "mode": "patch",
  "sections": [
    { "id": "baseagent", "enabled": false },
    { "id": "runtime", "order": 90 },
    {
      "id": "my-custom-rules",
      "type": "file",
      "file": "templates/my-custom-rules.md",
      "needsInjection": false,
      "when": "always",
      "order": 80
    }
  ]
}
```

**replace 模式**（`"mode": "replace"`）：完整替代包内清单，用户自行维护全部 sections。

## 模板变量语法

`needsInjection: true` 的片段文件使用以下变量语法：

| 语法 | 作用 | 示例 |
|---|---|---|
| `{{var}}` | 变量替换，值为空/false/null 时输出空 | `{{selfName}}` → `Alice` |
| `{{?var}}...{{/}}` | 条件段，var 为真值时保留整段 | `{{?peerAid}}...{{/}}` |
| `{{?var=value}}...{{/}}` | 条件段，var 等于指定值时保留 | `{{?sessionMode=proactive}}...{{/}}` |

渲染后空行自动删除。

## 渲染引擎入口

```typescript
// src/agents/kit-renderer.ts
renderKitSections(vars: Record<string, VarValue>): string
```

替代原 `templates.ts` 的 `renderPromptSection`。`message-processor.ts` 从多次分散调用变为一次 `renderKitSections`，引擎内部按 manifest 顺序评估条件、读文件、渲染变量、拼接输出。

### 缓存策略

上下文组装在每条消息处理时执行，但实际开销极小（相比 LLM 调用的秒级延迟）。为避免不必要的磁盘 IO，采用会话级缓存策略：

**缓存粒度：per-session**。不同会话有独立的缓存实例，因为同一 agent 可能同时处理多个会话（不同对端、不同渠道），注入参数和路径参数文件各不相同。

| 缓存对象 | 缓存时机 | 失效时机 |
|----------|----------|----------|
| `eck_manifest.json`（合并后） | 会话首次组装时 | agent reload / 会话结束 |
| 模板文件内容（`templatesDir` 下所有文件） | 会话首次组装时 | agent reload / 会话结束 |
| `$PEER_DIR/profile.md` 等路径参数文件 | 首次访问时 | agent reload / 会话结束 |
| when 条件编译结果 | manifest 加载时 | agent reload / 会话结束 |

**reload 触发时机**（清除所有会话的缓存）：
- `evolclaw agent reload <aid>` — CLI 手动触发
- `evolclaw agent reload`（无参数）— 全量 resync
- `evolclaw agent enable/disable/set` — 配置变更后自动热重载
- IPC `evolagent.reload` — 外部进程触发

**实现方式**：缓存挂在 session 对象上，agent reload 时遍历所有活跃 session 清除缓存。

```typescript
// Session 上的缓存
interface SessionKitCache {
  manifest: ResolvedManifest | null;
  templates: Map<string, string> | null;
  pathFiles: Map<string, string> | null;
}

// agent reload 时
for (const session of agent.activeSessions) {
  session.kitCache = { manifest: null, templates: null, pathFiles: null };
}
```

### 调试输出

为便于观察上下文组装结果，每次组装完成后输出两个调试文件到 `$EVOLCLAW_HOME/data/eck-debug/`：

| 文件 | 内容 | 命名格式 |
|------|------|----------|
| `vars-{timestamp}.json` | 本次注入的动态参数列表（名、值、描述） | `vars-20260522-143025.json` |
| `context-{timestamp}.md` | 最终组装出来的完整上下文 | `context-20260522-143025.md` |

**文件格式**：

`vars-{timestamp}.json`：
```json
{
  "timestamp": "2026-05-22T14:30:25.123Z",
  "sessionKey": "alice.aid.pub:venue:v_abc123:/project",
  "params": [
    { "name": "selfAid", "value": "alice.aid.pub", "description": "当前 agent 的 AID" },
    { "name": "selfName", "value": "Alice", "description": "当前 agent 的显示名" },
    { "name": "scene", "value": "private", "description": "场景类型" },
    { "name": "peerAid", "value": "bob.aid.pub", "description": "对端 AID（单聊时）" }
  ]
}
```

`context-{timestamp}.md`：组装后的完整 system prompt 片段原文。

**清理策略**：evolclaw 启动时扫描 `$EVOLCLAW_HOME/data/eck-debug/`，删除时间戳超过 1 天的文件。

### 加载流程

```
1. 读取 eck_manifest.json（先查 eck/，fallback 到 kits/）
2. 如果 eck/ 有 eck_manifest.json，按 mode 合并
3. 按 order 排序 sections
4. 对每个 section：
   a. 评估 when 条件
   b. 条件不满足 → 跳过
   c. 条件满足 → 读取文件/目录内容（优先从缓存）
   d. 如果 needsInjection: true → 用参数渲染模板
   e. 拼接到输出
5. 返回完整的 system prompt 片段
```

## 场景加载示例

### coding 模式

```
scene = "coding", channel = null, chatType = null

✅ rules/           (always, order: 10)
❌ identity-layer   (scene neq "coding" → 不满足)
❌ relation-layer   (scene in ["private","group"] → 不满足)
❌ venue-layer      (chatType neq null → 不满足)
❌ channel-layer    (channel neq null → 不满足)
✅ runtime          (always, order: 60)
✅ baseagent        (baseAgent neq null → 满足, order: 70)
```

### private 模式（AUN 单聊）

```
scene = "private", channel = "aun", chatType = "private"

✅ rules/           (always, order: 10)
✅ identity-layer   (scene neq "coding" → 满足, order: 20)
✅ relation-layer   (scene in ["private","group"] → 满足, order: 30)
✅ venue-layer      (chatType neq null → 满足, order: 40)
✅ channel-layer    (channel neq null → 满足, order: 50)
✅ runtime          (always, order: 60)
✅ baseagent        (baseAgent neq null → 满足, order: 70)
```

### group 模式（飞书群聊）

```
scene = "group", channel = "feishu", chatType = "group"

✅ rules/           (always, order: 10)
✅ identity-layer   (scene neq "coding" → 满足, order: 20)
✅ relation-layer   (scene in ["private","group"] → 满足, order: 30)
✅ venue-layer      (chatType neq null → 满足, order: 40)
✅ channel-layer    (channel neq null → 满足, order: 50)
✅ runtime          (always, order: 60)
✅ baseagent        (baseAgent neq null → 满足, order: 70)
```

## 版本兼容

manifest `$schema_version` 升级时，若 `eck/` 中存在旧版定制文件，启动时 log warning 提示用户检查。不自动覆盖 `eck/`，由用户/agent 主动更新。

## 迁移路径（从 prompts.md）

1. 实现 `kit-renderer.ts`，与旧 `templates.ts` 并存
2. `message-processor.ts` 加 feature flag `useKitRenderer`（默认 false）
3. 验证输出一致后切换默认值为 true
4. 下个大版本删除 `templates.ts` 和 `src/data/prompts.md`
