# EvolClaw 提示词装载全景（Prompt Loading Architecture）

> 文档范围：消息从渠道到 base agent 的完整提示词装载流程，涵盖系统提示词渲染层与消息渲染层两套机制。
> 最后更新：2026-06-04

---

## 总体数据流

```
收到一条消息
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│  MessageBridge                                           │
│  • 消息预处理（去重/拦截/chatType 填充）                   │
│  • messagePrefix 硬编码已移除（归消息渲染层）              │
│  • 构造 Message（含 items=undefined 此时）                │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│  MessageQueue                                            │
│  • 去重 / 单聊 interrupt / 群聊 FIFO                     │
│  • dequeueGreedy：弹出连续同 peerId 消息                  │
│  • mergeItems（多条时）：                                 │
│    - content = join('\n')（兜底）                        │
│    - items[] = 每条 SubMessage{peer,time,images,...}     │
│    - images/mentions 扁平合并（给 runQuery 的总量）       │
└──────────────────────┬───────────────────────────────────┘
                       │ Message（可能带 items[]）
                       ▼
┌──────────────────────────────────────────────────────────┐
│  MessageProcessor.processMessage()                       │
│                                                          │
│  ① wrapPrompt 准备（中断包装函数）                        │
│     effectivePrompt = wrapPrompt(message.content) ← 兜底 │
│                                                          │
│  ② 构造 kitCtx.vars（~47 个变量，见下节）                 │
│                                                          │
│  ③ 系统提示词渲染层                                       │
│     renderKitSections(kitCtx)                            │
│     effectiveSystemPrompt = persona + kitContext         │
│                                                          │
│  ④ 消息渲染层                                             │
│     renderMessageBody(items, kitCtx.vars, sessionId)     │
│     effectivePrompt = wrapPrompt(body)  ← 覆盖兜底       │
│     renderImages = result.images                         │
│                                                          │
│  ⑤ agent.runQuery(                                       │
│       effectivePrompt,                                   │
│       renderImages ?? message.images,                    │
│       effectiveSystemPrompt,                             │
│       modelOverride                                      │
│     )                                                    │
└──────────────────────────────────────────────────────────┘
```

---

## 两个渲染层对比

|  | 系统提示词渲染层 | 消息渲染层 |
|--|--|--|
| **驱动文件** | `kits/eck_manifest.json`（默认；按 `session.sessionType` 经 config.sessionManifests 可切到 `eck_manifest.<type>.json`，如 auxiliary） | `kits/eck_message_manifest.json` |
| **覆盖文件** | `$EVOLCLAW_HOME/eck/<驱动文件名>` | `$EVOLCLAW_HOME/eck/eck_message_manifest.json` |
| **模板目录** | `kits/templates/system-fragments/` | `kits/templates/message-fragments/` |
| **输出去向** | `systemPrompt.append`（每轮覆盖，不进 transcript） | `effectivePrompt`（进 transcript，成永久历史） |
| **vars 粒度** | 会话级（一次构造，整批复用） | item 级（每条叠加 peerName/now/images） |
| **模板空行** | 删除（stripBlankLines=true，紧凑） | 保留（stripBlankLines=false，消息多段） |
| **content 注入** | N/A | 哨兵末步字面量注入（防二次解析） |
| **缓存** | per-sessionId（跨消息复用文件内容） | per-renderMessageBody 调用（局部） |
| **debug 输出** | `eck-debug/context-*.md` `fragments-*.md` `manifest-*.md` `vars-*.json` | `eck-debug/msg-render-*.md` |

---

## manifest 共享引擎（manifest-engine.ts）

两个渲染层共用同一套原语，由 `src/agents/manifest-engine.ts` 提供：

| 函数 | 作用 |
|------|------|
| `loadManifest(filename)` | 加载并合并 manifest，按文件名缓存 |
| `evaluateWhen(when, vars)` | 求值 section 加载条件 |
| `renderTemplate(tpl, vars, stripBlankLines)` | 条件块 + 变量替换，可选删空行 |
| `resolvePathWithDiag(rawPath, vars)` | `$VAR` / `{{key}}` 路径展开 + 诊断 |
| `loadSectionFiles(section, vars, cache)` | 按 section 类型加载文件内容 |
| `buildPathMappings(vars)` / `shortenPath` | debug 输出路径别名化 |
| `invalidateManifestCache()` | 清全部 manifest 缓存 |

---

## 系统提示词渲染层详解

### 执行位置

`src/core/message/message-processor.ts` → `renderKitSections(kitCtx)` → `src/agents/kit-renderer.ts`

### manifest 默认段（按 order）

| order | id | 加载条件 | needsInjection | 内容 |
|-------|----|----|--------|------|
| 10 | rules | always | ✗ | `$KITS_RULES/` 目录（ECK 核心规则） |
| 20 | identity-layer | chatType≠null | ✓ | 身份层 fragment |
| 21 | persona | chatType≠null | ✗ | `$PERSONAL_DIR/persona.md` |
| 22 | working-memory | chatType≠null | ✗ | `$PERSONAL_DIR/memory/working.md` |
| 30 | relation-layer | chatType∈{private,group} | ✓ | 关系层 fragment |
| 35 | peer-profile | peerKey≠null | ✗ | 对端 profile.md |
| 40 | venue-fragment | chatType≠null | ✓ | 环境层 fragment |
| 41 | venue-chattype | chatType≠null | ✗ | `venues/{{chatType}}.md` |
| 42 | venue-channel-chattype | chatType≠null | ✗ | `venues/{{channel}}-{{chatType}}.md` |
| 43 | venue-group-profile | groupId≠null | ✗ | 群 venue profile.md |
| 44 | venue-client | clientType≠null | ✗ | `venues/client-{{clientType}}.md` |
| 50 | channel-layer | channel≠null | ✓ | 渠道层 fragment |
| 55 | commands | channel≠null | ✓ | 命令集能力卡 |
| 60 | session | always | ✓ | 会话层 fragment（含 localDate/weekday） |
| 70 | baseagent | baseAgent≠null | ✓ | base agent 配置 fragment |

### 输出结构

```
<system-reminder>
EvolClaw Context Kit documents are shown below.

Contenu de $KITS_RULES/01-overview.md (rules — ECK 核心规则):
...（各 section 内容，按 order）

IMPORTANT: Use this context when it affects the current interaction.
</system-reminder>
```

### 加载限额（防撑爆保护）

目录段与整个清单都有加载上限，超出即截断并注入说明（详见 `context-assembly.md`「目录加载限额」）：

| 层级 | 维度 | 默认 | 覆盖字段 |
|------|------|------|---------|
| 单目录段 | 文件数 / 字节 | 20 / 40KB | section `maxFiles` / `maxBytes` |
| 整个清单 | 文件数 / 字节 | 50 / 100KB | 清单顶层 `totalMaxFiles` / `totalMaxBytes` |

超限时：单目录段末尾注入 `[注意] 目录 X 未完整加载…`；总闸超限则停止加载后续段，末尾注入 `[注意] …以下 section 未加载：<id 集合>`。截断信息同步进 `manifest-*.md` 调试输出。

---

## 消息渲染层详解

### 执行位置

`src/core/message/message-processor.ts` → `renderMessageBody(items, vars, sessionId)` → `src/agents/message-renderer.ts`

### 渲染流程

```
for each SubMessage in items:
  sentinel = '\x00ECMSG-<UUID>\x00'   ← 每次调用独立，null 字节在渠道消息中不可能出现
  itemVars = {
    ...sessionVars,
    peerId / peerName / peerType,      ← 本条消息自己的发送者
    now = formatLocalTime(timestamp),  ← 本条消息自己的时刻
    content = sentinel,                ← 占位，末步换回
  }
  loadManifest(eck_message_manifest) → 选段 → renderTemplate(stripBlankLines=false)
  rendered.split(sentinel).join(item.content)  ← 字面量注入，不二次解析
  收集 item.images

join('\n\n') → { body: string, images: ImageData[] }
```

### 批次包裹层（loop 段）

消息 manifest 里若有 `loop` 段（见 `context-assembly.md`「三段式循环」），逐条渲染结果会被**包裹**：

```
逐条渲染（每条走 renderOneItem，自带 content 哨兵）→ renderedParts[]
  ↓
wrapBatch：loop 段的 file 作 wrapper，渲染批次 vars（remainingInQueue/pendingCount 等，从 sessionVars 透传）
  ↓
wrapper 的 {{@loop}} 处字面量填入 renderedParts.join(separator)
```

- **child = renderOneItem 逐条结果**（不用 loop.childFile）——复用消息渲染的完整逻辑（哨兵/renderMode/图片/handoff）
- **哨兵天然生效**：每条 content 在 renderOneItem 内已哨兵化，wrapBatch 只做字面量拼接，用户消息里的 `{{}}` 不被解析
- loop 段的 `separator` 默认 `\n`（消息层若不设则逐条间用 `\n\n`；wrapper 内 loop 段可自定）
- **无 loop 段** → 回退现有 `join('\n\n')`，行为不变（向后兼容）
- loop 段只做批次包裹，不参与逐条 renderOneItem（renderOneItem 跳过 `section.loop`）

> 批次包裹层是响应模式（单会话/双会话）批量处理消息的基础设施：把背压信号、批次头尾
> 渲染在逐条消息外层，供辅助会话/主会话感知队列状态。

### 初始 manifest（一个段）

```json
{
  "id": "msg-item",
  "file": "$KITS_MESSAGE_FRAGMENTS/item.md",
  "when": "always",
  "needsInjection": true
}
```

### 紧凑模板（item.md）

```
‹{{now}}{{?chatType=group}} · {{peerName}}{{/}}›
{{content}}
```

- 私聊：`{{?chatType=group}}` 块收敛，只剩时间
- 群聊：时间 + 发送者名
- 改格式只动这一个文件，不动代码

---

## vars 时变性归属

### 进系统提示词（每轮覆盖，缓存友好）

| 类别 | 变量 |
|------|------|
| 静态（进程级） | `PACKAGE_ROOT` `KITS*` `evolclawMode` `osInfo` `baseAgent` |
| 会话稳定 | `selfAid` `sessionId` `sessionKey` `chatType` `channel` `timezone` `tzOffset` `capabilities` `CURRENT_PROJECT` |
| 慢变（配置驱动） | `effectiveModel` `permissionMode` `peerRole` `readonly` `chatMode` `modelFallback*` |
| 新增（日期级） | `localDate`（YYYY-MM-DD）`weekday`（星期四），一天才变一次，缓存暖 ~24h |

### 进消息渲染层（每条独立，进 transcript 永久保真）

| 变量 | 说明 |
|------|------|
| `now` | 精确到秒的本地时间（含时区偏移），每条自己的发生时刻 |
| `peerName` / `peerId` / `peerType` | 群聊每条消息的发送者，单聊复用会话值 |
| `content` | 原始消息文本（字面量注入，不参与模板解析） |
| `images` | 按条归属的图片（SubMessage.images） |

---

## 关键保证

| 保证 | 实现方式 |
|------|---------|
| **模板注入防护** | 哨兵 `\x00ECMSG-<UUID>\x00`，per-call 独立，null 字节在任何渠道消息中不可能出现 |
| **消息不丢失** | manifest 无产出或渲染抛异常均显式 fallback 到 `wrapPrompt(message.content)` |
| **系统提示词不累积** | `systemPrompt.append` 是 SDK 每次 `query()` 的独立参数，随调用重传覆盖，不进 transcript |
| **图片归属** | `SubMessage.images` 按条保留，`renderMessageBody` 返回按顺序收集的 images；`runQuery` 用此数组而非 flat-merge 的 `message.images` |
| **群聊发送者保真** | 每条 SubMessage 携带自己的 peerName/peerId，进 transcript 成永久历史，模型可推理"谁说的、隔了多久" |
| **空消息安全** | `hasContent` guard，空消息不进渲染层，不传 `runQuery` |

---

## 文件索引

| 文件 | 角色 |
|------|------|
| `src/agents/manifest-engine.ts` | 共享渲染引擎原语 |
| `src/agents/kit-renderer.ts` | 系统提示词渲染，输出 `<system-reminder>` |
| `src/agents/message-renderer.ts` | 消息渲染层，输出 `{ body, images }` |
| `src/core/message/message-processor.ts` | 装配点：构造 vars，调两层渲染，调 runQuery |
| `src/core/message/message-queue.ts` | 队列合并：mergeItems 保留 items[] 和 per-item images |
| `src/core/message/message-bridge.ts` | 消息入口：已移除 messagePrefix 硬编码 |
| `src/types.ts` | SubMessage / Message.items 类型定义 |
| `kits/eck_manifest.json` | 系统提示词 manifest |
| `kits/eck_message_manifest.json` | 消息渲染 manifest |
| `kits/templates/system-fragments/session.md` | 含 localDate/weekday |
| `kits/templates/message-fragments/item.md` | 消息渲染紧凑模板 |
| `$EVOLCLAW_HOME/eck/eck_manifest.json` | 系统提示词 manifest 用户覆盖（可选） |
| `$EVOLCLAW_HOME/eck/eck_message_manifest.json` | 消息渲染 manifest 用户覆盖（可选） |
| `$EVOLCLAW_HOME/data/eck-debug/` | 调试输出目录（保留 24h） |
