# `evolclaw watch session` — 跨 selfAid/peerAid 浏览 cc 会话

## Context

evolclaw 现有 `watch msg` 命令展示**单条消息粒度**的统计与日志（messages.jsonl），但当 base agent（Claude Code）在自主/被动模式下处理一条远端消息时，cc 内部还会产生多轮思考、工具调用、再回复——这些发生在 cc 的 `~/.claude/projects/<encodedPath>/<sessionId>.jsonl` 里，外部看不到。

新增 `watch session` 命令的目标：以**会话粒度**穿透到 cc jsonl，把"远端 → 本地大模型 → 远端"完整对话流可视化，并区分三种内容来源。

附带一个设计修订：远端消息注入 cc 的 user prompt 当前是**裸文本**（`message.content` 直传），watch 侧没有结构化锚点定位"是谁、什么时候、加密与否、模式"。本计划同步在 `message-processor.ts` 里加一个轻量 Markdown 前缀行作为元数据壳，watch 侧据此还原元信息。

## Scope（要做的事）

1. **新建 `src/cli/watch-session.ts`** — 一个新 TUI，模式与 `src/cli/watch-msg.ts:1-636` 完全一致：raw stdin + ANSI + 状态对象 + `renderFrame()`。
2. **在 `src/cli/index.ts:4341` 的 `watch` 路由里增加 `session` 子命令分支**，并把 `--help` 加上。
3. **`src/cli/index.ts:1441`（watch 菜单选择器）增加 `session` 选项**。
4. **修改 `src/core/message/message-processor.ts:549` 的 `effectivePrompt` 构造**，给远端消息加 Markdown 前缀行包壳。

## 数据模型

### 三个层级的导航

| 层级 | 来源 | 说明 |
|------|------|------|
| selfAid | 扫 `$AGENTS_DIR/<aid>/config.json`（不管 enabled） | 用 `decodeDirSegment` 解码目录名 |
| peerAid | 扫 `$SESSIONS_DIR/aun/<encodeSegment(selfAid)>/` 下的子目录（排除 `_*`） | 复用 `watch-msg.ts:178 listPeers` 模式 |
| cc 会话 | 该 (selfAid, peerAid) 目录下的所有 `meta_*.jsonl`，每条最后一行是 `SessionFile` | 复用 `session-fs-store.ts:scanMetaFiles` + `readLastJsonlLine` |

### 会话列表展示字段（每行）

字段全部从两个数据源拼出来：

| 字段 | 来源 |
|------|------|
| 最后时间 | `SessionFile.updatedAtStr` 或 cc jsonl 文件 mtime（取大者） |
| 最后一句话 | cc jsonl 最后一条 `type:"user"` 的 message text（复用 `claude-session-file-adapter.ts:83 readLastUserMessage`） |
| AI 标题 | cc jsonl 里 `type:"ai-title"` 的 `aiTitle` 字段（取最后一条） |
| recap | cc jsonl 里 `type:"last-prompt"` 的 `lastPrompt` 字段（取最后一条） |
| cc sessionId | `SessionFile.agentSessionId` |

这些通过新建的 `src/cli/cc-session-reader.ts` 集中提供（不要把读 cc jsonl 的逻辑塞进 watch-session.ts，方便后续别处复用）。

### cc 会话详情视图——三种内容的识别规则

逐行解析 cc jsonl，按 `type` 分流：

| 渲染类别 | 识别规则 | 颜色 |
|---------|---------|------|
| **远端发来的消息**（紫） | `type:"user"` 且 `message.content` 是字符串（或 text 数组）且**不是** tool_result。命中正则 `^\[from:.+ time:.+ encrypted:.+ mode:.+\]$`（首行）则解析元数据，剥壳后展示原文 | `MAGENTA = \x1b[35m` |
| **本地大模型输出**（默认色） | `type:"assistant"` 的 `message.content` 中 `type:"text"` 的 text 块 | 默认 |
| **本地回复给远端**（橙） | `type:"assistant"` 的 `tool_use` 块，`name === "Bash"` 且 `input.command` 命中正则 `/^\s*evolclaw\s+ctl\s+(send|file)\b/`。从命令里 shell-parse 出消息文本，target AID 显示为当前会话的 peerAid | `ORANGE = \x1b[38;5;208m` |
| 其他 tool_use / tool_result / thinking | 折叠为单行 `▸ Bash: <command 摘要>` 或 `▸ Read: <file>`，可按 `t` 切换详细/折叠 | DIM |

**关键复用**：
- 识别正则：`/^\s*evolclaw\s+ctl\s+(send|file)\b/` —— 与 `src/agents/claude-runner.ts:1007` 的白名单完全一致
- shell-parse 命令参数：`evolclaw ctl send "<text>"` 用现成的简单解析（取第一对配对引号内容；fallback 取整条命令第三段后的内容）

## 元数据包壳（message-processor.ts 改动）

修改 `src/core/message/message-processor.ts:549`：

```ts
// 改前
const effectivePrompt = prevInterruptReason === 'new_message' && session.agentSessionId
  ? `【新消息插入】\n\n${message.content}\n\n【请无视之前中断继续处理】`
  : message.content;

// 改后
const encrypted = !!message.replyContext?.metadata?.encrypted;
const mode = isProactive ? 'proactive' : 'interactive';
const ts = new Date(message.timestamp || Date.now()).toISOString();
const wrappedContent = `[from:${message.peerId} time:${ts} encrypted:${encrypted} mode:${mode}]\n\n${message.content}`;
const effectivePrompt = prevInterruptReason === 'new_message' && session.agentSessionId
  ? `【新消息插入】\n\n${wrappedContent}\n\n【请无视之前中断继续处理】`
  : wrappedContent;
```

注意：
- 元数据壳放在`【新消息插入】`包装的**内层**（这样中断包装语义不被打断）。
- 群聊场景下 `messagePrefix` 已在 `message.content` 里加了 `[SenderName] `，仍保留——元数据壳的 `from:` 是 AID 维度的真值，群聊里发言人名字仍在正文。
- base agent 看到这个前缀是合理的——它能从中读取"谁在什么时候发的"，与系统层 `relation.md` 注入的对端信息互补。如果发现 base agent 把它当指令执行，再考虑改成 XML tag。

## TUI 布局

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Self: alice.aid.pub        Peer: bob.aid.pub        Session: fdd64c08… │ ← 顶部菜单栏（持久）
│ [Tab 切焦点  Enter 选择  q 退出]                                         │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  10:23  紫 [bob → alice] 你帮我看一下这个 bug                            │
│  10:23  默认 我来读一下文件…                                              │
│  10:23  ▸ Read: src/foo.ts                                              │
│  10:24  默认 看到了问题，原因是 X，修复方案是 Y                           │
│  10:24  橙 → bob: 已经修好了，你看下                                     │
│                                                                          │
│  [PgUp/PgDn 翻页  ↑↓ 滚动  t 折叠/展开工具调用  Esc 返回会话列表]        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 三种交互状态

| State | 显示 | 焦点 |
|-------|------|------|
| `picking-self` | 顶部菜单栏 + 下方 self 列表 | self 槽 |
| `picking-peer` | 顶部菜单栏（self 已定）+ 下方 peer 列表 | peer 槽 |
| `picking-session` | 顶部菜单栏（self/peer 已定）+ 下方会话列表（每条 4 行：时间/标题/最后一句/recap） | session 槽 |
| `viewing` | 顶部菜单栏 + 下方时间线 | session 槽（默认）；Tab 可回退到 self/peer 槽切换上下文 |

### 键位

| 键 | 行为 |
|----|------|
| `Tab` | 顶部菜单栏焦点循环：self → peer → session → self |
| `Enter` | 当前焦点对应的列表展开为下方面板；选中后回到 viewing |
| `↑↓` | 滚动当前列表/时间线（行级） |
| `PgUp/PgDn` | 时间线翻页 |
| `Home/End` | 跳到时间线顶/底 |
| `t` | viewing 状态下，折叠/展开非"send/file"工具调用 |
| `r` | 刷新当前数据（重新读 cc jsonl） |
| `Esc` | viewing → picking-session → picking-peer → picking-self → 退出 |
| `q` / `Ctrl+C` | 直接退出 |

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/cli/watch-session.ts` | **新建**，约 700 行（参照 watch-msg.ts 结构） |
| `src/cli/cc-session-reader.ts` | **新建**，约 200 行。提供 `readSessionTimeline(jsonlPath): TimelineEvent[]` / `readSessionMeta(jsonlPath): { aiTitle, lastPrompt, lastUserMessage, mtime }` |
| `src/cli/index.ts` | 在 watch 路由（行 4341 附近）增加 `session` 子命令；在 watch 菜单（行 1441 附近）增加 `session` 选项；help 文本同步 |
| `src/core/message/message-processor.ts` | 修改行 549 附近的 `effectivePrompt`，加元数据壳 |

## 复用的现成函数（不要重写）

| 函数 | 路径 |
|------|------|
| `resolvePaths()` | `src/paths.ts` |
| `decodeDirSegment` / `encodeSegment` | `src/core/session/session-fs-store.ts` |
| `readAllJsonlLines<T>` / `readLastJsonlLine<T>` / `scanMetaFiles` / `chatDirPath` | `src/core/session/session-fs-store.ts` |
| `encodePath` | `src/utils/cross-platform.ts` |
| `SessionFile` 类型 | `src/core/session/session-fs-store.ts` |
| ANSI 工具函数：`visualWidth`/`padRight`/`truncate`/`wrapText`/`formatDateTime`/`shortAid` | 当前都在 `src/cli/watch-msg.ts:74-161`，**抽到 `src/cli/tui-utils.ts`** 让 watch-msg 和 watch-session 共享 |
| `renderScrollbar` | `src/cli/watch-msg.ts:248`，一并抽到 `tui-utils.ts` |

> 抽 tui-utils.ts 是顺手做的减熵——让 watch-msg.ts 也用新文件的 import，不会增加它的总行数。

## 边界情况

- cc jsonl 文件很大（>10MB）：流式读取，不要一次性 readFileSync。先按行读到 100 条 user/assistant 事件就停止预览，详情视图按需懒加载。
- `agentSessionId` 是 null（会话从未跑过 cc）：在会话列表里标 `[未启动]`，Enter 进入显示空时间线 + 提示。
- cc jsonl 不存在但 `agentSessionId` 非 null（cc 文件被删）：标 `[文件丢失]`。
- selfAid 没有任何 peer：picking-peer 状态显示 `<no peers yet>`。
- 元数据壳的向后兼容：watch 渲染时如果首行不匹配正则，就把整条 user message 当作"远端原文"渲染（兼容历史会话）。

## Verification

1. **typecheck**：`npx tsc --noEmit` 通过（项目已配置）。
2. **运行**：`npm run build && node dist/cli/index.js watch session`，验证三级选择能进会话详情。
3. **真实场景**：随便挑一个有 `agentSessionId` 的活跃会话（比如 `data/sessions/aun/toleiliang5.agentid.pub/toleiliang.agentid.pub/active.json`），看时间线里能否分别看到紫/默认/橙三种内容。
4. **元数据壳验证**：发一条新消息触发处理，再用 `watch session` 打开该会话，确认远端消息行显示了 `[from:... time:... encrypted:... mode:...]` 解析出的元数据，且 base agent 的回复看起来正常（没有把元数据当指令执行）。
5. **边界**：手动改一个 active.json 让 `agentSessionId` 指向不存在的 UUID，验证 `[文件丢失]` 标记。

## 不在本计划范围（如需后续再做）

- 把会话从 watch 直接 resume 进 cc（需要起 cc 子进程）
- 跨 self/peer 的全局搜索
- 时间线导出（md/html）
- 群聊场景的多人渲染（当前先按"我 vs 群"两端处理，群成员名字从 `[Name]` 前缀显出）
