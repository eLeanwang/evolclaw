# Proactive 模式"输出即回复"坑：分析与改进建议

## 文档信息

| 项目 | 内容 |
|------|------|
| 类型 | 问题分析 + 改进建议（待 owner 拍板） |
| 创建日期 | 2026-05-31 |
| 作者 | dddd（base: Claude Code）+ llbot，双 agent 交叉复核 |
| 状态 | 草稿 — 等待 owner 审查与决策 |
| 事实基线 | `docs/chatmode-mechanism.md`（owner 亲笔，本文不另起炉灶，仅引用并补充） |

> 本文所有代码引用均逐行复核到 `src/` 当前状态、所有文档存废均复核到 git 历史。
> 凡标 ✓ 处为两个 agent 独立交叉验证一致的事实。

---

## 1. 问题（坑）

Proactive 模式下，base agent 沿用 interactive 养成的"输出即回复"直觉，
直接输出普通文本作为给对端的答复。但 proactive 下这些文本**不会发给对端**：

- 普通文本 → `IMRenderer.emit()` → `activity.batch` → `aun.ts` `sendThought()`
  → `message.thought.put`，变成**实时思考过程展示**。
- 它对用户可见，但**不入消息历史、也不是发给对端的正式回复**。
- 要真正回复，必须显式调用 `evolclaw ctl send` / `ec msg send`。

**心智模型纠正**：不应描述为"文本被静默丢弃"（不准且吓人）。准确说法是
"普通文本被投影成思考展示；正式回复必须显式发送"。把直觉从"输出即回复"
纠正为"输出即思考展示，回复要显式发"——理解机制比背命令耐用。

### 代码佐证 ✓

| 事实 | 位置 |
|------|------|
| proactive 下普通文本被投影成 activity.batch（逐事件） | `im-renderer.ts`：`emit()`（:108-116，proactive 走 `emitProactive`）→ `emitProactive()`（:451-474，每事件转 1-item `activity.batch`） |
| activity.batch → thought.put（仅 proactive） | `aun.ts:2614-2627`（`chatmode==='proactive'` 走 `sendThought`，否则只写历史） |
| send 回调把 payload 交给 adapter | `message-processor.ts:493-518`（IMRenderer 的 send 回调，含 proactive thought 渠道过滤） |
| ctl send/file 任何权限模式都放行 | `claude-runner.ts:1190-1197`（白名单已铺好） |

---

## 2. 当前唯一防线，及其三个弱点

经逐行复核 `message-processor.ts:575-668`（`effectiveSystemPrompt` 构建全段）：
proactive 模式下，注入给 base agent 的系统提示 `contextParts` 精确只有三样——
persona（:601）、working memory（:602）、kitContext（:665-666，即 `renderKitSections`
渲染的 ECK rules + fragments）。**全程没有任何 `isProactive` 分支向 `contextParts`
push 专用提示词**（该段 `isProactive` 仅用于 :595 文件能力开关、:655 chatMode 取值）。

**结论 ✓**：proactive 防掉坑的**唯一防线**，就是 ECK 渲染进 kitContext 的那段
`session.md` fragment（`kits/templates/system-fragments/session.md:22-26`）。
没有任何代码级注入的 proactive 专用提示词。

这唯一防线有三个叠加弱点：

| # | 弱点 | 证据 |
|---|------|------|
| 1 | 措辞弱且不准 | session.md:23 "文本输出静默丢弃" — 既弱（只说"别这么做"，没说"你的字去哪了"），又不准（实为投影成 thought 展示，非丢弃） |
| 2 | 位置靠后 | session 块 `order:60`，是 manifest 倒数第二段（仅 baseagent `order:70` 在后），再提前也在上下文末尾 |
| 3 | 命令口径打架 | session.md 注 `ctl send`；而 always 加载的 `kits/rules/06-channel.md` 注 `ec msg send {{selfAid}} {{peerId}}` 优先、`ctl send` 仅兜底。两处都高频加载，新 agent 同时读到会懵 |

**为什么坑稳定复现**：唯一防线是一段措辞弱、位置倒数第二、还跟 always 加载的
06-channel 命令口径冲突的 fragment。base agent（包括起草本文的两个 agent 自己）
第一次进 proactive 几乎必踩。

---

## 3. 一个半成品机制：`[PROACTIVE:REPLY_CONFIRMED_*]` 标志位

排查中发现代码里有一套标志位机制，**容易被误判为孤儿代码而删除——但它不是孤儿，
是半成品**。请 owner 知悉全貌后再决定去留（见 §5 方向 B）。

### 3.1 它是什么

代码 `message-processor.ts:1454-1461` 检测 base agent 输出里的
`[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)]` 标志，命中则置 `lastProactiveFlag`，
供 `:1204-1209` 的"proactive→interactive 模式切换提示"使用。
来源唯一 commit `23e7284`（2026-05-28）✓。

### 3.2 它牵出两套机制、两份文档

| 机制 | 设计文档 | 实现状态 |
|------|----------|----------|
| 模式切换提示（复用标志位） | `docs/proactive-to-interactive-hint-design.md`（owner 亲笔，612 行，状态：草稿-等审查） | 检测端 + 提示注入**已实现**（:1454 / :1204） |
| Agent-to-Agent 回复校验 / 纠错重试（标志位的**原始用途**） | `docs/agent-to-agent-validation-implementation.md`（实现计划，任务清单级）+ 转述于 hint-design.md §14 | **代码零实现** ✓ |

纠错重试正是本坑的运行时解药：检测到 `REPLY_CONFIRMED_SENT` 但本轮无成功
`ctl send` tool_result → 自动重试最多 2 次（`agent-to-agent-validation-implementation.md:20-26`）。
其 :18 一字不差描述了本文 §1 的坑。

### 3.3 为什么整套都空转 ✓

无论哪个用途，都依赖 base agent 主动输出 `[PROACTIVE:REPLY_CONFIRMED_*]` 标志。
而**产出端（系统提示词要求 agent 输出标志）从未落地**——`kits/` 全目录搜
`REPLY_CONFIRMED` 零命中。所以检测端 :1455 的正则永远 test 不到，
模式切换提示也永远不触发。

更深一层：`agent-to-agent-validation-implementation.md` 任务1（:48-59）的代码示例
假设代码里"已有"一个 `PROACTIVE_MODE_PROMPT` 常量，新增的校验提示词挂在它旁边。
但 grep 全 `src/`：`PROACTIVE_MODE_PROMPT` 和 `PROACTIVE_AGENT_VALIDATION_PROMPT`
**两个常量都不存在** ✓。即这份实现计划连它假设的地基都没有。

### 3.4 两份文档存废状态（避免 owner 误解） ✓

- `agent-to-agent-validation-implementation.md`：**存在**于仓库（15247 字节），是纠错重试的实现蓝图。
- `proactive-mode-design.md`：被 hint-design.md §14、agent-to-agent-validation-implementation.md:8
  多处引用为"原始设计文档"，但 `git log --all -- *proactive-mode-design*` 零记录——
  **仓库中无任何 git 记录**（既非"曾有后删"，无需去历史里捞）。本文不替 owner 假设它存在过；
  其下落见 §7-3。

### 3.5 标志位机制小结

不是孤儿，是 **owner 设计过、规划到任务清单级、但代码与产出端均未落地的半成品**：
原始用途（纠错重试）有蓝图无代码、其假设的前提常量不存在、原始设计文档从未入仓；
被复用的第二用途（切换提示）实现了检测端却因产出端缺失而空转。

---

## 4. 锁定版事实链

1. **坑**：proactive 下 agent 习惯用普通文本 → 投影成 thought → 对端收不到。
2. **owner 早已识别**：`agent-to-agent-validation-implementation.md:18` 原文描述此坑。
3. **owner 设计了解药（纠错重试）并写到任务清单级，但**：(a) 代码零实现；
   (b) 其前提 `PROACTIVE_MODE_PROMPT` 常量在代码里从不存在；
   (c) 原始设计 `proactive-mode-design.md` 从未进仓。
4. **标志位检测端（:1454）被另一机制（模式切换提示）复用并实现**，
   但产出端（提示词要求 agent 输标志）从未落地 → 两套都空转。
5. **当前唯一实际生效的防线**：`session.md` fragment 一段话，带 §2 的三个弱点。

---

## 5. 改进方向（按"改动小→影响大"排序）

### 方向 A：强化唯一防线（纯改 kits 模板，零代码，热加载即生效）⭐ 首选、立刻可做

A 修的正是 §2 那条唯一防线。两个落点都在 `kits/` 下，走 ECK 渲染，不碰任何 TS，
热加载生效、零回归风险：

1. **`kits/rules/06-channel.md` 补因果**（权威落点）。该文件在 always 加载的 rules 里、
   已在讲"必须调 CLI、别把输出当回复"。把因果补这儿可靠性最高：
   "proactive 下你的普通文本会作为思考过程实时展示给用户（可见，但不入历史、不是回复）；
   要正式回复对端必须显式跑 `ec msg send` / `ctl send`。"
   讲清机制而非罗列命令——理解比死记耐用。
2. **`kits/templates/system-fragments/session.md` 改措辞 + 统一命令口径**。
   把 "文本输出静默丢弃"（弱且不准）改为 "投影成思考过程实时展示，非正式回复"；
   命令口径与 06-channel 对齐（统一以 `ec msg send` 为主、`ctl send` 为兜底）
   （即让 session.md 向 06-channel.md 已有口径看齐，是收敛到现状，非新增规范）。
   session.md 保留命令速查即可。

> 落点说明：因 session 块 `order:60` 注定在上下文末尾，把"因果解释"放进
> always 加载、位置靠前的 06-channel.md 比留在 session.md 更有效（§2 弱点 2）。

### 方向 B：闭环那个半成品标志位机制（须 owner 定夺设计意图）

标志位是半成品（§3），不是孤儿。**不建议直接删（B2 已被否决）**，因为会删掉一个
owner 有正式设计、且可能正是本坑解药的机制。请 owner 三选一：

| 选项 | 内容 | 工作量 / 影响 |
|------|------|---------------|
| **(a) 补全** | 写产出端提示词 + 实现纠错重试，激活完整机制 | 有蓝图（`agent-to-agent-validation-implementation.md`），但需先建其假设的地基（`PROACTIVE_MODE_PROMPT` 等常量本不存在）。最贴合原设计 |
| (b) 仅激活切换提示 | 补产出端提示词，让已实现的检测端/切换提示生效，搁置纠错重试 | 中小。但单独的切换提示对"本坑"价值有限，主要防 interactive 下误调 ctl send |
| (c) 整体废弃 | 删检测端（:1454-1461）+ 提示注入（:1204-1209）+ 标志位约定，承认此路未通 | 小。但放弃了一个可能的运行时解药 |

> 注：(a) 的运行时纠错重试若落地，是比方向 A 更强的兜底——A 靠提示词"掰习惯"，
> (a) 靠代码"发现没发就重试"。二者不冲突，可叠加。

### 方向 C：运行时兜底——降级为纯 observability 或不做

最初设想"一轮 proactive 结束、agent 既没 ctl send 也没实质输出 → warn/提醒"。
**此设想有缺陷，已否决其原始形态**：`chatmode-mechanism.md:5,132` 明确把
"某一方不再调回复工具 → 对话自然停止"定为**核心设计目标**。也就是说
"一轮结束、没 ctl send"在 agent↔agent 对话中是**合法且期望的终止**，不是 bug。
按"没发=可疑"会在每个正常收尾轮误报。

→ 修正：C 若做，只能是**纯日志/度量**（给 owner 观测掉坑频率，不打扰 agent），
或干脆不做。优先级最低。注意它与方向 B(a) 的纠错重试不同——后者有严格激活条件
（proactive + AI 对端 + 有 SENT 标志但无 tool_result），不会误伤正常终止。

---

## 6. 全景：与 owner 已有 backlog 的关系

`chatmode-mechanism.md:134-160` 已列了 owner 自己识别的 4 个缺口 + 5 条修复方向。
**那些与本文的 A/B/C 不冲突，是另一条线**（都是 sessionMode 正确落值的问题），
一并摆出供 owner 看全景：

| 来源 | 主题 | 与本文关系 |
|------|------|-----------|
| chatmode-mechanism.md 缺口 1-3 | sessionMode 落值（群聊硬强制、`nothuman` 读取、resolver 签名带 peerType） | 正交：管"会话该不该是 proactive"，本文管"已是 proactive 时 agent 怎么正确回复" |
| chatmode-mechanism.md 缺口 4 | thought.put 的 chatmode 字段位置与 message.send 对齐 | 正交：观测一致性 |
| **本文 A** | 强化"已是 proactive 时"的唯一提示防线 | 新增，纯文档 |
| **本文 B** | 半成品标志位机制的去留 | 新增，牵出 §3 两份文档 |
| **本文 C** | 运行时兜底（降级为纯日志或不做） | 新增 |

---

## 7. 待 owner 决策的问题

1. **方向 A 是否批准立即执行**（纯改 `kits/` 两个模板，零代码、热加载、零回归）？
   这是修复唯一防线的最低成本动作。
2. **方向 B 三选一**：标志位机制 (a) 补全 / (b) 仅激活切换提示 / (c) 整体废弃？
   决策依赖 owner 当初的设计意图——这是我们无法替代判断的。
3. **`proactive-mode-design.md` 的下落**：它被多份文档引用为原始设计源，但仓库中无任何 git 记录。
   请 owner 确认它是否存在（本地 / 其他仓 / 还是从未写就），以及 §3 引用链是否需要补全。
4. **方向 C 是否需要**纯 observability 日志（度量掉坑频率），还是直接搁置？

---

## 附：本文协作与边界声明

- 本文由两个 agent（dddd / llbot，均为本项目的 peer/guest）通过 AUN 通信协作完成，
  全程交叉复核，所有结论独立验证到代码行 / git 记录。
- 整个排查**仅 read / grep / git 只读操作，未改动任何文件**（本文档除外）。
- 改 `kits/` 模板或动 `src/` 代码，**一律等 owner 看完本文拍板后再进行**。
  我们守住 peer/guest 边界，不替 owner 做设计决策。

---

## 附录 B：方向 A 的 before/after（提案，待 owner 批准后再落地）

以下为方向 A 两处改动的具体提案，owner 批了可直接参考。**尚未落盘**。

### B.1 `kits/templates/system-fragments/session.md:22-26`

before：
```
{{?chatMode=proactive}}
# proactive 模式：文本输出静默丢弃，必须用以下命令发消息
proactive-send: evolclaw ctl send "<text>"
proactive-file: evolclaw ctl file <path>
{{/}}
```

after（措辞纠正 + 命令向 06-channel 看齐；具体 ec/evolclaw 前缀以 owner 现网命令为准）：
```
{{?chatMode=proactive}}
# proactive 模式：你的普通文本会作为"思考过程"实时展示给用户（可见，但不入消息历史、
# 不是发给对端的正式回复）。要正式回复，必须显式调用下列命令之一（口径同 06-channel）。
proactive-send: ec msg send {{selfAid}} {{peerId}} "<text>"   # 拿不到 self-aid 时退回 evolclaw ctl send "<text>"
proactive-file: ec msg send {{selfAid}} {{peerId}} --file <path> --as <image|video|voice|file>
{{/}}
```

### B.2 `kits/rules/06-channel.md`（在"通信规则"段补一句因果）

在该文件已有的"必须调用 CLI 命令发消息，不要把输出当成发送给对方的内容"附近补：
```
> proactive 模式下尤其注意：你直接输出的普通文本会被投影成"思考过程"实时展示给用户，
> 它可见、但不入消息历史、也不是发给对端的回复。只有显式调用下面的发送命令，对端才真正收到。
```

> 两处合起来把心智模型从"输出即回复"纠正为"输出即思考展示，回复要显式发"，
> 并消除 session.md 与 06-channel.md 的命令口径分歧（收敛到 06-channel 现状）。

