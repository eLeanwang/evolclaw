# ECWeb 控制台重构设计

日期：2026-06-09
范围：`ecweb/` 前端 + `src/core/command/command-handler.ts` 门面 / `src/core/command/menu-handler.ts` 执行层等后端 menu 层

## 背景与根因

EvolClaw Watch（ECWeb）现有 5 个标签：`AID · Messages · Sessions · Cache · Control`。
其中 **Control 页大面积为空**。根因不在样式，而在信息架构：

`ecweb/src/sources/control.ts` 通过 IPC `menu.exec` 拉取 `menu.*` 状态；
后端 `execMenuForEcweb()`（门面在 `src/core/command/command-handler.ts`，执行在 `src/core/command/menu-handler.ts`）用一个**虚构渠道 `__ecweb__`** 跑所有查询：

```js
const ECWEB_CHANNEL = '__ecweb__';
```

`__ecweb__` 不绑定任何真实 EvolAgent、也没有活跃会话。于是：

- **能出数**（进程级，不依赖会话）：`system`、`chatmode`（回落默认）、`activity`（回落 all）、`EvolAgent` 列表、`触发器` 列表。
- **必然空**（依赖活跃会话）：`工作目录`、`Agent 后端`、`模型`、`推理强度`、`权限模式`、`群分发`、`会话` 动作。

daemon 底下同时跑多个 EvolAgent（如 eleanbot / evolagent / evolai / multica + DefaultAgent），各有 AID、渠道、会话。
脱离"具体哪个 agent"，模型/后端/权限无从谈起。因此重构核心是**先定每个页面的定位，再谈布局**。

## 目标

1. 取消 `Control` 这一含混的页面，按"控制对象"拆分到合适的页面。
2. per-agent 配置项联动后端，按选中的 agent 解析，不再依赖假渠道 `__ecweb__`。
3. 进程级看板（System）与实体级配置（Agents）、调度（Triggers）各归其位。

## 非目标

- 不改 Messages / Sessions / Cache 三页的现有逻辑。
- 不引入新的前端框架（保持原生 JS + WS + 卡片/表格 DOM 渲染）。
- 不做会话级动作（stop/new/fork/compact）的控制入口——它们属于会话上下文，不属于控制层。

## 标签栏重构

| 旧 | 新 | 变化 |
|---|---|---|
| AID | **Agents** | 保留现有 AID 表，最右新增"操作"列；表头加"+ 新建 Agent" |
| Control | （拆解删除） | per-agent 配置 → Agents 编辑弹窗；触发器 → Triggers；EvolAgent 列表 → Agents；纯进程级 → System |
| — | **Triggers** | 新独立 tab，按 agent 钻取触发器 |
| — | **System** | 纯进程级看板：版本/uptime/pid/channels + 重启/升级/健康检查 |
| Messages | Messages | 不变 |
| Sessions | Sessions | 不变 |
| Cache | Cache | 不变 |

新标签顺序：`Agents · Messages · Sessions · Triggers · Cache · System`

`Control` 名字整体消失，职责由 `Agents`（实体配置）与 `System`（进程）接管。

---

## 一、Agents 页（由旧 AID 页升级）

### 布局

保留现有 `renderAid()` 的整张表（列：状态/AID/收/发/系统/入字节/出字节/peers/重连/最后活动/最近消息），
**最右新增一列「操作」**，每行渲染按钮组。表头右上角加「+ 新建 Agent」入口。

```
│ … 最后活动 │ 最近消息      │ 操作                                       │
│ … 2m      │ ↓ alice: hi  │ [编辑] [重载] [禁用] [删除] [Agent.md↗]    │
```

### AID 行 ↔ Agent 归属

一行是一个 AID；操作针对其所属 EvolAgent。映射方式：
用 `agentList()` + 各 agent 的 `channelInstanceNames()` 解析 AID → agent 名/aid。
DefaultAgent 的 AID 同样可解析。无法归属到任何 agent 的 AID 行，操作列置灰。

### 操作列按钮

| 按钮 | 后端入口 | 行为 |
|---|---|---|
| **编辑** | 新增 menu 写入口（见后端改动） | 弹结构化表单窗，见下。**保存只落盘，不自动重载**——需用户回表手动点「重载」生效 |
| **重载** | `agentReload(aid)` / `evolagent.reload` IPC | **执行前检查该 agent 是否有任务在跑**，有则提示确认/阻止；需后端补 `menu.action name=agent action=reload` |
| **禁用 / 启用** | `agentDisable(aid)` / `agentEnable(aid)` | 按当前 status 二选一显示；**禁用前检查是否有任务在跑**，有则提示 |
| **删除** | `agentDelete(aid, purge)` | 危险确认弹窗，可勾选"同时清除数据"(purge)；**删除前检查是否有任务在跑**，有则提示 |
| **Agent.md↗** | — | 新窗口打开 `https://{aid}/agent.md` |

### 任务执行检查（重载 / 禁用 / 删除前置）

重载、禁用、删除会中断 agent 正在处理的任务，故执行前需检查该 agent 是否繁忙：
- 检查依据：`messageQueue.getProcessingCountByAgent(agentName)` > 0（处理中）或 `getQueueLengthByAgent` > 0（待处理）。
- 繁忙时：弹窗提示"该 Agent 有 N 个任务执行中，确认仍要 {重载/禁用/删除}？"，用户确认后才执行。
- 后端在对应 menu.action 内做二次校验（前端可绕过），繁忙时返回 `BUSY` 错误码，前端据此提示；
  用户坚持时可带 `force: true` 参数再次提交。

### 编辑弹窗（含项目 / owners / 渠道）

分区块表单：

1. **运行参数**：后端(baseagent) / 模型 / 推理强度 / 会话模式 —— 下拉，选项来自对应 `menu.options`（按该 agent 解析）。
2. **项目**：项目路径（文本）。
3. **owners**：owner AID 列表（增删行）。
4. **渠道**：飞书 / 微信等渠道配置。AUN 渠道由 `agent.aid` 隐式管理，不可在此编辑（与 `agentChannelUpsert` 约束一致）。渠道凭证为敏感字段，单独区块并标注。

保存流程：前端提交 config patch → 后端校验 → `saveAgent()` 落盘。**不触发 `evolagent.reload`**——
保存后提示"配置已保存，点「重载」生效"，由用户回表手动点重载（重载会做任务执行检查）。失败回显错误，不静默。

### 新建弹窗

字段：aid / name / baseagent / project（project 可后端兜底）。提交走 `execAgentAction('create')`（受理即返回，后台构建）。
构建进度可经 `agentShow` 的 `createProgress` 字段轮询展示（可选，二期）。

---

## 二、Triggers 页（独立 tab）

### 布局

主从双栏，复用 Agents/Messages 的双栏骨架：

```
┌─ Triggers ─────────────────────────────────────────────┐
│ ┌─ Agent 列表 ─┐ ┌─ evolai 的触发器 ──────────────────┐ │
│ │ ● eleanbot   │ │ [全部/启用] 切换                    │ │
│ │ ● evolai  ◄  │ │ ● 每日简报  cron 0 9 * * *  下次 09:00 [取消]│
│ │ ● multica    │ │ ○ 提醒xxx   once  已过期            [取消]│
│ └──────────────┘ └────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- **左列**：agent 列表（同 Agents 页数据源）。
- **右侧**：选中 agent 的触发器列表，来自 `menu.options name=trigger`（带 enabled/all 切换）。
  每条显示 name / scheduleType / 下次触发时间，操作：set（编辑调度参数）/ cancel。
- 触发器为关系级数据，后端已有 `TriggerManager`；按 agent 的 owning channel 解析其 triggerManager。

---

## 三、System 页（纯进程级看板）

定位：脱离任何 agent / 会话，只看 daemon 本身。卡片栅格复用 Cache 页的 `cache-cards`/`cache-card` 语言。竖向三段。

### ① 进程概况（只读卡）

数据来自 `menu.query name=system`（owner-gated）。卡片：

| 卡 | 字段 | 来源 |
|---|---|---|
| 状态 | ● 运行中 | daemonRunning（圆点复用 `.dot.on/.off`） |
| evolclaw 版本 | `version`，命中新版叠加 `⬆` 角标 | package.json + upgrade 结果 |
| fastaun 版本 | `fastaunVersion`，命中新版叠加 `⬆` 角标 | `@agentunion/fastaun` package.json + registry 比对 |
| ECWeb 版本 | `ecwebVersion`，命中新版叠加 `⬆` 角标 | ECWeb 自身 package.json + registry 比对 |
| 运行时间 | `uptime` | process.uptime() |
| PID | `pid` | process.pid |
| Node | `node` | process.version |

附：`agent`（owning agent 名）/ `channel` / `channels[]` 可作为副信息行展示。

### 三个独立包的版本检查

evolclaw 生态有三个各自独立发布、各自版本的 npm 包，System 页并列展示三张版本卡：

| 包 | 包名 | 当前版本 | 安装方式 | 本地版本来源 |
|---|---|---|---|---|
| 主网关 | `evolclaw` | 见 package.json | `npm i -g evolclaw` | daemon 读自身 package.json |
| AUN SDK | `@agentunion/fastaun` | 0.4.12 | 主包依赖 | daemon 读 `node_modules/@agentunion/fastaun/package.json` |
| 监控台 | `evolclaw-web` | 1.0.1 | `npm i -g evolclaw-web`（独立全局装，daemon spawn 成独立进程） | **ECWeb 自身进程读自己的 package.json** |

- **evolclaw / fastaun 的当前版本**：经 daemon `menu.query name=system` 返回（`version` / `fastaunVersion`）。
- **ECWeb 的当前版本**：ECWeb 就是渲染 System 页的那个进程，直接读自身 package.json，
  经 WS snapshot 带给前端（`ecwebVersion`），不必经 daemon IPC。
- **三者的"最新版"**：`action=upgrade` 并行 `checkLatestVersion('evolclaw' / '@agentunion/fastaun' / 'evolclaw-web')`，
  各自 `compareVersions` 比对；有新版时对应版本卡显示 `⬆ 当前 → 最新`。
  注意 ECWeb 升级需在主机执行 `npm i -g evolclaw-web@latest` 后重启 ECWeb 进程，System 页仅提示、不代执行。

### ② 操作区（按钮，全部 owner-gated）

```
[ 🔍 健康检查 ]   [ ⬆ 检查更新 ]   [ ⟳ 重启服务(危险) ]
```

- **健康检查** → `menu.action name=system action=check`，结果填入 ③。
- **检查更新** → `action=upgrade`，结果回写版本卡（最新/有新版/开发模式跳过）。
- **重启服务** → `action=restart`，`danger` 红边 + `confirm()` 二次确认。

### ③ 健康快照（按钮触发，默认空）

点「健康检查」后填充。后端 `check` 返回**结构化 JSON**（见后端改动），前端渲染为：

```
┌─ 渠道健康 ──────────┐  ┌─ 队列 ──────┐
│ aun    ● 已连接 ×3  │  │ 待处理  0   │
│ feishu ● 已连接     │  │ 处理中  1   │
│ wechat ⏳ 重连中    │  └─────────────┘
└─────────────────────┘
┌─ 近 1 小时 ─────────────────────────────────────┐
│ 收到 42 · 完成 40 · 出错 2 (timeout:1, api:1)    │
│ 工具失败 1 (Bash:1) · 中断 3 · 平均响应 8.4s     │
└──────────────────────────────────────────────────┘
┌─ EvolAgent 健康 ──────────────────────────────────┐
│ ● eleanbot   running  claude · 0 任务             │
│ ● evolai     running  claude · 1 任务处理中        │
│ ⊘ review     disabled —                           │
│ ✗ broken     error    上次错误: API timeout        │
└──────────────────────────────────────────────────┘
┌─ BaseAgent 健康 ──────────────────────────────────┐
│ claude   ● 有活跃流 (2)   Runner 正常             │
│ codex    ○ 空闲            Runner 正常             │
└──────────────────────────────────────────────────┘
```

结构化 JSON 扩展字段（`/check` 返回）：

```ts
evolagents: Array<{
  name: string;
  aid: string;
  status: 'running' | 'stopped' | 'disabled' | 'error';
  baseagent: string | null;
  activeTasks: number;      // getProcessingCountByAgent + getQueueLengthByAgent
  error?: string;           // AgentInfo.error，有则标红
}>;
baseagents: Array<{
  name: string;             // 'claude' | 'codex' | 'gemini' | ...
  activeStreams: number;    // hasActiveStream 计数 / runners 遍历
  healthy: boolean;
}>;
```

数据来源：`agentRegistry.list()` 给 EvolAgent 列表；runner map 遍历给 BaseAgent 列表。

---

## 后端改动

### 1. `/check` 返回结构化数据

现状：`/check`（`command-handler.ts:2864`）把渠道健康/队列/近 1h 统计拼成一坨文本。
改动：让 `menu.action name=system action=check` 返回结构化对象（保留文本路径供 IM 渠道用）：

```ts
{
  channels: [{ type: 'aun', instances: [{ name, connected }] }, ...],
  queue: { pending: number, processing: number },
  uptimeMs: number,
  lastHour: { received, completed, errors, errorsByType, toolErrors, toolErrorsByName, interrupts, avgResponseMs },
  evolagents: [{ name, aid, status, baseagent, activeTasks, error? }, ...],
  baseagents: [{ name, activeStreams, healthy }, ...],
}
```

数据已存在于 `statsCollector.getSnapshot()`、渠道对象、`agentRegistry.list()` 与 runner map，只是当前部分被格式化成文本。抽出结构化构造函数，文本渲染基于它。

### 1b. `menu.query name=system` 增加 fastaun 版本

`/system` query（`command-handler.ts:959`）返回体增 `fastaunVersion`（读 `@agentunion/fastaun` 的 package.json）。
ECWeb 自身版本（`ecwebVersion`）由 ECWeb 进程读自己的 package.json，经 WS snapshot 带给前端，不走此 query。
三个包的新版比对走 `action=upgrade` 路径（见下）。

### 1c. `action=upgrade` 同时检查 fastaun 与 evolclaw-web

`/upgrade`（`command-handler.ts:3059`）现仅查 evolclaw。扩展为并行查三个独立包：
`checkLatestVersion('evolclaw')` / `checkLatestVersion('@agentunion/fastaun')` / `checkLatestVersion('evolclaw-web')`，
结构化返回三者的 `{ local, remote, hasUpdate }`，前端分别回写三张版本卡。
evolclaw-web 的 local 版本由 ECWeb 进程提供（前端已持有），daemon 侧只需提供 remote。
注意：evolclaw-web 是独立全局安装的进程，升级需主机执行 `npm i -g evolclaw-web@latest` 并重启 ECWeb，System 页仅提示不代执行。

### 2. `menu.action name=agent` 增加 `reload`（带任务检查）

`execAgentAction`（`src/core/message/command-handler-agent-control.ts`）增 `reload` case，调用 `agentReload(aid)`（`src/cli/agent.ts`，走 `evolagent.reload` IPC）。
**reload / disable / delete 三个 action 执行前检查目标 agent 是否繁忙**：
`getProcessingCountByAgent(agentName) + getQueueLengthByAgent(agentName) > 0` 即繁忙，
返回 `{ error: '该 Agent 有 N 个任务执行中', code: 'BUSY' }`；调用方传 `force: true` 时跳过检查强制执行。

### 3. menu 层增加 agent config patch 写入口

新增一个 menu action（如 `name=agent action=update`），接受 config patch（运行参数 / project / owners / channels），
**仅 `saveAgent()` 落盘，不触发 `evolagent.reload`**——重载由用户在操作列手动触发（带任务检查）。
校验沿用 `validateAgentConfig` 与 `agentChannelUpsert` 的约束（AUN 渠道不可编辑等）。

### 4. per-agent 配置解析不再用 `__ecweb__`

`execMenuForEcweb` 接受 `agent`（aid 或 name）参数；对依赖会话的查询（baseagent/model/effort/chatmode/perm/dispatch），
按该 agent 的 channelKey（`channelInstanceNames()[0]` 或显式）解析，而非假渠道。
Agents 编辑弹窗的下拉选项与当前值由此而来。

---

## 数据流

```
浏览器 tab 切换
  → WS subscribe(view)
  → ecweb/src/sources/<view>.ts.snapshot()/subscribe()
  → IPC menu.exec / aun-aids / aun-aid-stats
  → daemon command-handler execMenuForEcweb(payload)
  → 结构化响应回传 → 前端渲染

写操作（编辑/重载/启禁/删除/触发器 set·cancel/系统动作）
  → WS menu 消息（requestId 配对）
  → execMenuForEcweb(menu.update / menu.action)
  → saveAgent + evolagent.reload / agentReload / agentDelete / ...
  → 响应回传 → toast + 刷新快照
```

## 错误处理

- 所有写操作经 `mResp()` 解析 data/error，错误以 toast 红色提示，不静默吞。
- 危险操作（重启、删除、禁用）`confirm()` 二次确认，沿用现有 `ctrl-btn.danger`。
- daemon 未运行时各页显示 banner（沿用 `.banner` 既有样式）。
- 进程级操作 owner-gated；`owners` 未配置时返回 FORBIDDEN，前端置灰并提示。

## 测试策略

- 后端：`/check` 结构化输出单测（mock statsCollector + 渠道对象）；`agent reload`/`agent update` menu action 单测（mock registry）。
- 前端：手动验证三页渲染与写操作回环（开发模式 daemon + 配对码登录）。
- 回归：Messages/Sessions/Cache 三页不受影响。

## 实施顺序（建议）

1. 后端 `/check` 结构化 + `menu.action name=agent action=reload` + agent config patch 写入口 + `execMenuForEcweb` 接受 agent 参数。
2. 前端标签栏重构（删 Control，加 Triggers/System，AID→Agents）。
3. System 页三段。
4. Agents 页操作列 + 编辑/新建弹窗。
5. Triggers 页主从。
6. 联调与回归。
