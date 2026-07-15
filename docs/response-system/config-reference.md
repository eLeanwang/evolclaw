# 响应模式配置参考（Config Reference）

**版本**: 1.0  
**创建时间**: 2026-07-08  
**状态**: 参数唯一事实源（SSOT）

> 本文档是**响应模式所有配置参数的唯一事实源**。其他文档（common-params.md /
> specific-params.md / data-structures.md）保留各自的细节说明，但参数集合、默认值、
> 可选值以本文档为准。发现不一致时，以本文档为准并回改其他文档。

---

## 一、配置结构总览

响应模式相关配置**全部在顶层**（无独立的 `config` 子块）：

```json
{
  "responseMode": "dual-session",      // 顶层·标量：选择响应模式
  "chatmode": {                        // 顶层·字典：chatMode 场景表（按对端类型取值）
    "private": "interactive",          //   私聊 + 对端是人
    "nothuman": "proactive",           //   私聊 + 对端是 agent
    "group": "proactive"               //   群聊
  },
  "mentionMode": "disabled",           // 顶层·标量：@ 处理策略（通用参数）
  "model": "claude-opus",              // 顶层·标量：主会话模型（通用参数）
  "responseModeParams": {              // 顶层·字典：模式特有参数，按模式 id 分桶
    "dual-session": {                  //   仅当 responseMode=dual-session 时读此桶
      "debounceMs": 3000,
      "auxiliaryModel": "deepseek-v4-flash"
    }
  }
}
```

**参数分类**：

| 类 | 参数 | 形态 | 说明 |
|----|------|------|------|
| **选模式** | `responseMode` | 顶层标量 | 选哪个模式；候选/默认来自注册表（§二） |
| **通用参数** | `chatmode` / `mentionMode` / `model` | 顶层（chatmode 字典，其余标量） | 所有模式共用，与选模式正交（§三） |
| **模式特有参数** | `responseModeParams[modeId]` | 顶层字典，按模式分桶 | 仅特定模式支持（如 dual-session 队列参数，§四/§五） |

> **为何全部顶层、且模式特有参数按模式 id 分桶**：通用参数与「选哪个模式」正交，放顶层
> 独立管理；模式特有参数用 `responseModeParams[modeId]` 分桶，切模式时各模式参数互不混淆。
> 旧的 `config` 块、`response_modes` 块均已废除（见 §二废弃说明）。

---

## 二、顶层参数：responseMode（标量，选哪个模式）

**存放级别**：顶层（与 `responseModeParams` 平级）· **形态**：标量字符串

决定使用哪个响应模式（进而决定底层引擎）。这是**唯一走特殊路线的参数**：
候选清单和默认值来自**响应模式注册表**，不来自 schema。

| 值 | 引擎 | 说明 | 状态 |
|----|------|------|------|
| `single-session` | V1 | 单会话直接响应（合并了旧的 interactive / proactive）；**注册表首选** | ✅ 可用 |
| `dual-session` | V2 | 双会话（辅助会话判断投递时机 + 主会话处理） | ✅ 可用 |
| `workflow` | V3 | 工作流模式 | ⚠️ 未来，未实现 |

**解析优先级**（高→低，标量覆盖，不分场景）：

```
1. 关系级 responseMode（$RELATIONS_DIR/<peerKey>/config.json）
2. agent 级 responseMode（$AGENT_DIR/config.json）
3. 注册表首选（registry.getPreferred()，当前为 single-session）
```

- **不区分场景**：整个会话链路一个标量。要「某个群用 dual-session」通过关系级 responseMode 覆盖表达；
- 关系级 > agent 级由 ConfigManager 按 `x-merge: scalar` 合并；缺省兜底注册表首选；
- 配了不存在的模式 id 时不报错，回落注册表首选（避免单个坏配置卡死会话）。

> **废弃结构（已删除，见 migration-guide.md）**：
> - 旧的 `response_modes` 块（`default_private` / `default_group` / `configs` / `overrides`）已废除；
> - 选模式改用标量 `responseMode`，模式特有参数改用 `responseModeParams` 字典（见 §四）；
> - 旧模式 id `interactive` / `proactive` → `single-session` + 顶层 `chatmode`；`dual-session-lite` → `dual-session`。

---

## 三、通用参数（所有响应模式）

### 3.1 chatmode（顶层字典）

**存放级别**：顶层（与 `config` 平级）· **适用**：所有模式 · **形态**：三键字典

```json
"chatmode": {
  "private": "interactive",   // 私聊 + 对端是人（human）
  "nothuman": "proactive",    // 私聊 + 对端是 agent
  "group": "proactive"        // 群聊（人/agent 都算）
}
```

**取哪个键由对端类型决定**（读取时机械判定，非配置）：

| 场景 | 取用的键 | 出厂默认值 |
|------|---------|-----------|
| 私聊 + 对端是人（human） | `private` | `interactive` |
| 私聊 + 对端是 agent | `nothuman` | `proactive` |
| 群聊（人/agent 都算） | `group` | `proactive` |
| system/service 对端 | —（不读字典） | 硬约束 `interactive` |

**解析优先级**（高→低）：

```
1. 运行时硬约束：system/service 对端 → 恒 interactive（不可配置）
2. trigger 元数据 chatModeOverride（临时覆盖）
3. 合并后的 chatmode 字典[对端类型判定的键]
4. schema 出厂默认表（agent-config.schema 的 chatmode.default）
```

- 出厂默认表是**配置数据**（`agent-config.schema` 的 `chatmode.default` 字段），非代码硬编码；
- 前端设置传入的是**标量**（interactive/proactive），代码按当前对端类型写到对应键
  （群聊→`group`，私聊人→`private`，私聊 agent→`nothuman`）；
- 逐键合并、层级覆盖见 §七。

> chatmode 是**顶层参数**（不在 config 内）——因为它按对端类型取值、与响应模式正交。
> 详见 §一说明。

### 3.2 其余通用参数（顶层标量）

**存放级别**：顶层（与 `config` 平级）· **适用**：single-session / dual-session / workflow

| 参数 | 存放级别 | 必选 | 可选值 | 默认值 | schema | 用途 |
|------|---------|------|--------|--------|--------|------|
| `mentionMode` | 顶层 | 可选 | `disabled` \| `mention-only` | `disabled` | ✅ enum + default | @ 处理策略：disabled=处理所有消息；mention-only=只处理被 @ 的消息，未 @ 作引用上下文 |
| `model` | 顶层 | 可选 | 模型 ID 字符串 | 无（由响应模式/全局默认决定） | ❌ 黑箱放行（无 enum/default） | 主会话使用的模型（辅助会话另有 `auxiliaryModel`） |

**说明**：
- 三个通用参数（`chatmode` / `mentionMode` / `model`）均在顶层，与 `config` 内的模式特有参数分离；
- `mentionMode` 在 schema 显式声明（有候选清单和默认值，可被校验）；`model` 顶层黑箱放行（schema 不约束候选值/默认值）；
- `chatMode` 详见 [config/common-params.md §三](./dual-session/config/common-params.md)
- `mentionMode` 详细机制见 [MENTION-MODE-MECHANISM.md](./dual-session/MENTION-MODE-MECHANISM.md)

---

## 四、single-session 特有参数

single-session 主要依赖通用参数（顶层 chatmode / mentionMode / model）。此外有两个
**proactive 投递专用**的微调开关，存 `responseModeParams["single-session"]`，仅在
本会话 chatMode 解析为 `proactive` 时生效（interactive 投递忽略）：

| 参数 | 类型 | 候选 | 默认 | 说明 |
|------|------|------|------|------|
| `pre_tool_1stmsgchk` | boolean | `true`/`false` | `true` | proactive 下首个工具调用前必须先用 send/file 向对端表态，否则拦截 |
| `tool_use_reminder` | boolean | `true`/`false` | `true` | proactive 下启用队列未读提醒 + 每 10 次工具调用的汇报提醒 |

**事实源 = 模式 schema 文件**：这两个参数的候选值（`enum`）与默认值（`default`）唯一声明在
`kits/schemas/single-session.schema.1.json`（随包分发，已登记 `_meta.json`）。三处消费同一份：

1. **候选/默认展示**：`ec config schema single-session` 可读出（与 agent-config 等核心 schema 同一套子命令）；
2. **运行时默认**：`default` 即出厂默认，由宿主组装 modeConfig 时提取注入（`coordinator.schemaDefaults`），
   flow **不再硬编码** `?? true`；
3. **写入校验**：写 config 时对 `responseModeParams` 做**桶专项校验**——桶键须是已注册模式
   （否则报错并点名，提示 `ec response list`），桶内容用该模式 schema 校验（`enum` / 未知键拦截）。

> **新增一个响应模式时，schema 侧要做哪些**：建
> `kits/schemas/<name>.schema.<v>.json` → 登记 `_meta.json` → `LogicalSchemaName` union 加 `<name>`
> → descriptor `configSchema = loadSchema('<name>').raw`。完成这几步后，桶写校验、候选/默认展示、
> 运行时默认注入三条链路**零额外代码自动生效**。完整 8 步清单见
> [mode-contract.md](./mode-contract.md) §4.1.1「新增一个响应模式：schema 侧清单」；
> 模式桶 schema 作为「无 config target 的一等 schema」的定位见 [config/03-schema.md](../config/03-schema.md)。

**每会话生效值的优先级**（高→低）：

| 层 | 来源 |
|----|------|
| 1. 关系级 | `$RELATIONS_DIR/<peerKey>/config.json` 的 `responseModeParams["single-session"]` 桶 |
| 2. agent 级 | `$AGENT_DIR/config.json` 的 `responseModeParams["single-session"]` 桶 |
| 3. schema 默认 | `single-session.schema` 的 `default`（出厂默认，无人配时兜底） |

> 桶按模式 id 整桶 dict 合并——关系级写了 `single-session` 桶即整桶覆盖 agent 级同名桶（不递归到键）。
>
> **迁移（旧顶层 `proactive` 块已废弃）**：这两个键历史上落在顶层 `proactive` 块。single-session
> 合并后运行时只从桶读取，顶层 `proactive` 块已从 schema 移除。存量配置**读时自动折叠**进模式桶
> （桶内已显式设置的同名键优先，旧块随后续写入从磁盘消失），用户无需手工迁移。新配置直接写桶：
> `ec response config set pre_tool_1stmsgchk false --mode single-session`。

配置示例（chatmode / mentionMode 均在顶层）：

```json
// coding 模式（无渠道，对端视为 system → 硬约束 interactive，通常无需配 chatmode）
{ "responseMode": "single-session" }

// 单聊/群聊（如需关闭 proactive 首工具表态）
{
  "responseMode": "single-session",
  "chatmode": { "private": "interactive", "group": "proactive" },
  "mentionMode": "disabled",
  "responseModeParams": { "single-session": { "pre_tool_1stmsgchk": false } }
}
```

---

## 五、dual-session 特有参数

**存放级别**：`responseModeParams["dual-session"]` · **适用**：仅 `dual-session`

参数按用途分组。「等级」列区分**核心参数**（常用）与**高级参数**（一般用默认值，需要时才调）。

### 5.1 队列触发参数

| 参数 | 等级 | 可选值/范围 | 默认值 | 用途 |
|------|------|-----------|--------|------|
| `debounceMs` | 核心 | 0-6000 | 3000 | 防抖时间：新消息到达后等待多久触发辅助会话（期间有新消息则重置） |
| `maxWaitMs` | 核心 | 5000-30000 | 15000 | 最早消息最长等待：防抖被反复重置时的强制触发上限 |
| `maxQueueSize` | 核心 | 10-100 | 群聊 50 / 单聊 15 | 队列满强制转投阈值：累积到此值直接投主队列，不经辅助会话 |
| `maxBatchSize` | 高级 | 正整数 | 50 | 单批最多消息数（extractBatch / extractForceTransferBatch 上限） |
| `maxBatchBytes` | 高级 | 正整数 | 10240 | 单批最多字节数 |

### 5.2 延迟投递参数

延迟投递总时长公式（**单聊与群聊相同**）：

```
实际延迟 = baseDelayMs + random(0, effectiveLevelMs)

effectiveLevelMs = baseLevelMs(delayLevel) × 对端系数

baseLevelMs: short=60000, medium=120000, long=180000（辅助会话决策输出的等级）
对端系数:    agent ×1.0 / 人 ×0.5（代码按发送者类型自动判定）
```

**延迟投递有双重目的**：①群聊多 agent 时错开、避免竞态回复；②等待用户完整意图输入。
因此单聊也有 delay（等意图）、也带随机；若意图已完整则辅助会话直接 transfer，不 delay。

- 随机上限 = `effectiveLevelMs`，即等级时长乘对端系数
- 对端是人时上限减半（人打字比 agent 慢但不会竞态，等待可更短）
- 对端判定：群聊消息集合**含 agent 就算 agent**，全是人才算人；单聊看对端本身

| 参数 | 等级 | 可选值/范围 | 默认值 | 用途 |
|------|------|-----------|--------|------|
| `baseDelayMs` | 高级 | ≥0 | 0 | 延迟基础偏移，打底叠加在随机延迟之上 |
| `holdTimeoutMs` | 高级 | ≥0 | 3600000（1小时） | HOLD 挂起兜底超时（仅群聊）：挂起超过此时长由独立到期定时器转投主队列，防饿死。与 DELAY 到期共用同一套扫描 |

> `delayLevel`（short/medium/long）**不是配置参数**，而是辅助会话每次决策的输出字段
> （见 [data-structures.md AuxiliaryDecision](./dual-session/data-structures.md)）。
> 对端系数由代码按发送者类型自动判定，无需配置参数控制。

### 5.3 模型参数

| 参数 | 等级 | 可选值 | 默认值 | 用途 |
|------|------|--------|--------|------|
| `model` | 核心（通用） | 模型 ID | 无（由响应模式/全局默认决定） | 主会话模型（**顶层**通用参数，见 §3.2；此处列出以便对照） |
| `auxiliaryModel` | 核心 | 模型 ID | `deepseek-v4-flash` | 辅助会话模型（判断投递时机，用便宜快速模型降本） |

> 已统一：主会话模型一律用通用参数 **`model`**；不再使用 `mainModel`。

### 5.4 会话压缩参数

| 参数 | 等级 | 可选值/范围 | 默认值 | 用途 |
|------|------|-----------|--------|------|
| `auxiliaryMaxTokens` | 高级 | 20000-80000 | 40000 | 辅助会话上下文超过此 token 数触发压缩 |
| `auxiliaryMaxMessages` | 高级 | 正整数 | 100 | 辅助会话消息数超过此值触发压缩 |
| `mainMaxTokens` | 高级 | 80000-500000 | 160000 | 主会话上下文超过此 token 数触发压缩 |
| `mainMaxMessages` | 高级 | 正整数 | 200 | 主会话消息数超过此值触发压缩 |
| `compressionTarget` | 高级 | 正整数 | 2000 | 压缩摘要目标字数 |

### 5.5 打断与调试参数

| 参数 | 等级 | 可选值 | 默认值 | 用途 |
|------|------|--------|--------|------|
| `interruptEnabled` | 核心 | boolean | true | 是否允许辅助会话打断正在处理的主会话（紧急消息） |
| `enableDebug` | 高级 | boolean | false | 是否输出调试日志 |

---

## 六、单聊 vs 群聊的差异

延迟机制（公式、随机、到期/新消息重判）**单聊与群聊完全相同**，仅以下不同：

| 项 | 群聊 | 单聊 | 原因 |
|------|---------|---------|------|
| `maxQueueSize` 默认 | 50 | 15 | 单聊消息量小，更快触发 |
| 决策类型 | hold / delay / transfer | delay / transfer（无 hold） | 单聊一对一都相关，无需 hold |
| 对端系数判定 | 消息集合含 agent 就算 agent | 看对端本身是人/agent | 见 §5.2 延迟公式 |

---

## 七、配置层级与覆盖优先级

参数可在多个层级配置，优先级从高到低：

| 优先级 | 层级 | 路径 |
|--------|------|------|
| 1（最高） | 关系级 | `$RELATIONS_DIR/<peerKey>/config.json` |
| 2 | 环境级（预留） | 环境层尚未定型，存储路径待定 |
| 3 | Agent 级 | `$AGENT_DIR/config.json` |
| 4（最低） | 出厂默认值 | schema 的 `default` 字段（如 chatmode 见 `agent-config.schema`；**不进 defaults.json**） |

> **环境级 config 待定**：环境层承载更高抽象（组织、类型级共性），不为具体群/私聊实例建目录。
> 环境级 config 的存储路径、键的设计留待环境层正向规划时确定。本次仅消除旧的 `venueKey` 命名。

**覆盖示例（顶层标量参数，整体覆盖）**：

```json
// Agent 级（$AGENT_DIR/config.json）
{
  "responseMode": "dual-session",
  "mentionMode": "disabled"
}

// 关系级覆盖（$RELATIONS_DIR/aun#alice.aid.pub/config.json）
{
  "mentionMode": "mention-only"   // 只覆盖这一项
}

// 最终生效
{
  "responseMode": "dual-session",
  "mentionMode": "mention-only"   // 关系级覆盖
}
```

**chatmode 字典的逐键合并**（顶层，`x-merge: dict`——按键覆盖，非整体替换）：

```json
// Agent 级（$AGENT_DIR/config.json）—— 未写则用 schema 出厂默认表
{
  "chatmode": { "private": "interactive", "nothuman": "proactive", "group": "proactive" }
}

// 关系级覆盖（$RELATIONS_DIR/aun#alice.aid.pub/config.json）
{
  "chatmode": { "private": "proactive" }   // 只写这一个键
}

// 最终生效（关系级的 private 覆盖，其余键继承 agent 级）
{
  "chatmode": { "private": "proactive", "nothuman": "proactive", "group": "proactive" }
}
```

- agent 级和关系级的 `chatmode` **形态相同**（都是三键字典），按键逐个覆盖；
- 某一层只写了部分键，其余键继承下层；全部未写则由 schema 出厂默认表兜底；
- chatmode **不进 defaults.json**——全局兜底直接来自 schema 的 `default` 字段。

**responseModeParams 字典的逐键合并**（顶层，`x-merge: dict`——按模式 id 分桶，桶整体覆盖）：

```json
// Agent 级
{
  "responseModeParams": {
    "dual-session": { "debounceMs": 3000, "auxiliaryModel": "deepseek-v4-flash" }
  }
}

// 关系级覆盖（只改 dual-session 桶）
{
  "responseModeParams": { "dual-session": { "debounceMs": 1000 } }
}

// 最终生效：dual-session 桶被关系级**整桶覆盖**（dict 不递归，auxiliaryModel 不保留）
{
  "responseModeParams": { "dual-session": { "debounceMs": 1000 } }
}
```

- 第一层键是**模式 id**；同一模式桶按 dict 规则**整体覆盖**（不递归进桶内字段）；
- 不同模式的桶互不影响（关系级新增 workflow 桶不动 agent 的 dual-session 桶）；
- 读取时取 `responseModeParams[当前responseMode]` 注入该模式的 modeConfig；
- responseMode / responseModeParams **从 agent 级起**（不进 defaults.json）。

---

## 八、完整配置示例

> 说明：`chatmode` / `mentionMode` / `model` 是**顶层**通用参数；模式特有参数放
> `responseModeParams[modeId]` 桶。coding 模式（无渠道，对端视为 system）由运行时硬约束走
> interactive，通常无需显式配 chatmode。

### 8.1 single-session（coding 模式）

```json
{
  "responseMode": "single-session"
}
```

### 8.2 dual-session 标准群聊

```json
{
  "responseMode": "dual-session",
  "chatmode": { "group": "proactive" },
  "mentionMode": "disabled",
  "model": "claude-opus",
  "responseModeParams": {
    "dual-session": {
      "auxiliaryModel": "deepseek-v4-flash",
      "debounceMs": 3000,
      "maxWaitMs": 15000,
      "maxQueueSize": 50,
      "interruptEnabled": true
    }
  }
}
```

### 8.3 dual-session 单聊（低延迟）

```json
{
  "responseMode": "dual-session",
  "mentionMode": "disabled",
  "responseModeParams": {
    "dual-session": { "maxQueueSize": 15, "debounceMs": 2000 }
  }
}
```

### 8.4 dual-session 低成本

```json
{
  "responseMode": "dual-session",
  "model": "claude-sonnet",
  "responseModeParams": {
    "dual-session": {
      "auxiliaryModel": "deepseek-v4-flash",
      "debounceMs": 5000,
      "auxiliaryMaxTokens": 20000,
      "mainMaxTokens": 80000
    }
  }
}
```

---

## 九、参数速查总表

一站式速查（★=核心，☆=高级）：

| 参数（英文名） | 中文名 | 级别 | 模式 | 可选值 | 默认 | ★/☆ |
|------|------|------|------|--------|------|------|
| `responseMode` | 响应模式 | **顶层**·标量 | — | single-session / dual-session / workflow | 注册表首选(single-session) | ★ |
| `responseModeParams` | 模式特有参数字典 | **顶层**·字典 | — | `{ [modeId]: {...} }` 按模式分桶 | — | ★ |
| `chatmode` | 交互方式场景表 | **顶层字典** | 全部 | 三键 `{private, nothuman, group}`，每键 interactive / proactive | schema 出厂表 | ★ |
| `mentionMode` | 提及处理策略 | **顶层**·通用 | 全部 | disabled / mention-only | disabled | ★ |
| `model` | 主会话模型 | **顶层**·通用 | 全部 | 模型 ID | 无（模式/全局定） | ★ |
| `auxiliaryModel` | 辅助会话模型 | responseModeParams·特有 | dual-session | 模型 ID | deepseek-v4-flash | ★ |
| `debounceMs` | 防抖时间 | responseModeParams·特有 | dual-session | 0-6000 | 3000 | ★ |
| `maxWaitMs` | 最长等待时间 | responseModeParams·特有 | dual-session | 5000-30000 | 15000 | ★ |
| `maxQueueSize` | 队列最大容量 | responseModeParams·特有 | dual-session | 10-100 | 群50/单15 | ★ |
| `interruptEnabled` | 是否启用打断 | responseModeParams·特有 | dual-session | boolean | true | ★ |
| `maxBatchSize` | 单批最多消息数 | responseModeParams·特有 | dual-session | 正整数 | 50 | ☆ |
| `maxBatchBytes` | 单批最多字节数 | responseModeParams·特有 | dual-session | 正整数 | 10240 | ☆ |
| `baseDelayMs` | 延迟基础偏移 | responseModeParams·特有 | dual-session | ≥0 | 0 | ☆ |
| `holdTimeoutMs` | HOLD 兜底超时（仅群聊） | responseModeParams·特有 | dual-session | ≥0 | 3600000 | ☆ |
| `auxiliaryMaxTokens` | 辅助会话压缩 token 阈值 | responseModeParams·特有 | dual-session | 20000-80000 | 40000 | ☆ |
| `auxiliaryMaxMessages` | 辅助会话压缩消息数阈值 | responseModeParams·特有 | dual-session | 正整数 | 100 | ☆ |
| `mainMaxTokens` | 主会话压缩 token 阈值 | responseModeParams·特有 | dual-session | 80000-500000 | 160000 | ☆ |
| `mainMaxMessages` | 主会话压缩消息数阈值 | responseModeParams·特有 | dual-session | 正整数 | 200 | ☆ |
| `compressionTarget` | 压缩摘要目标字数 | responseModeParams·特有 | dual-session | 正整数 | 2000 | ☆ |
| `enableDebug` | 是否启用调试输出 | responseModeParams·特有 | dual-session | boolean | false | ☆ |

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-14（single-session 合并：responseMode 标量 + responseModeParams 字典，废除 response_modes / config 块）  
**状态**: ✅ 参数唯一事实源
