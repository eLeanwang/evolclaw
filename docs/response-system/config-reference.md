# 响应模式配置参考（Config Reference）

**版本**: 1.0  
**创建时间**: 2026-07-08  
**状态**: 参数唯一事实源（SSOT）

> 本文档是**响应模式所有配置参数的唯一事实源**。其他文档（common-params.md /
> specific-params.md / data-structures.md）保留各自的细节说明，但参数集合、默认值、
> 可选值以本文档为准。发现不一致时，以本文档为准并回改其他文档。

---

## 一、配置结构总览

配置分为**顶层**和 **config 内**两部分：

```json
{
  "responseMode": "dual-session",      // 顶层：选择响应模式
  "config": {                          // config 内：该模式的参数
    "chatMode": "proactive",           //   通用参数（所有模式支持）
    "mentionMode": "disabled",
    "model": "claude-opus",
    "debounceMs": 3000,                //   特有参数（仅 dual-session）
    "auxiliaryModel": "deepseek-v4-flash"
  }
}
```

**参数分三级**：

| 级别 | 位置 | 说明 |
|------|------|------|
| **顶层** | 与 `config` 平级 | `responseMode`：选哪个模式 |
| **通用** | `config` 内 | 所有响应模式都支持 |
| **特有** | `config` 内 | 仅特定模式支持（如 dual-session 的队列参数） |

---

## 二、顶层参数：responseMode

**唯一的顶层参数**，决定使用哪个响应模式（进而决定底层引擎）。

| 值 | 引擎 | 说明 | 状态 |
|----|------|------|------|
| `single-session` | V1 | 单会话直接响应（合并了旧的 interactive / proactive） | ✅ 可用 |
| `dual-session` | V2 | 双会话（辅助会话判断投递时机 + 主会话处理） | ✅ 可用 |
| `workflow` | V3 | 工作流模式 | ⚠️ 未来，未实现 |

> **废弃值（自动迁移，见 migration-guide.md）**：
> - `interactive` → `single-session` + `chatMode: 'interactive'`
> - `proactive` → `single-session` + `chatMode: 'proactive'`
> - `dual-session-lite` → `dual-session`

---

## 三、通用参数（所有响应模式）

**存放级别**：`config` 内 · **适用**：single-session / dual-session / workflow

| 参数 | 存放级别 | 必选 | 可选值 | 默认值 | 用途 |
|------|---------|------|--------|--------|------|
| `chatMode` | config（通用） | ✅ 必选 | `interactive` \| `proactive` | — | 回复投递方式：interactive=输出即回复（coding 无渠道）；proactive=CLI 发送（单聊/群聊） |
| `mentionMode` | config（通用） | 可选 | `disabled` \| `mention-only` | `disabled` | @ 处理策略：disabled=处理所有消息；mention-only=只处理被 @ 的消息，未 @ 作引用上下文 |
| `model` | config（通用） | 可选 | 模型 ID 字符串 | `claude-opus` | 主会话使用的模型（辅助会话另有 `auxiliaryModel`） |

**说明**：
- `chatMode` 详见 [config/common-params.md §三](./dual-session/config/common-params.md)
- `mentionMode` 详细机制见 [MENTION-MODE-MECHANISM.md](./dual-session/MENTION-MODE-MECHANISM.md)

---

## 四、single-session 特有参数

**无特有参数**。single-session 只使用通用参数。

| responseMode | 特有参数 |
|--------------|---------|
| `single-session` | 无 |

配置示例：

```json
// coding 模式（无渠道）
{ "responseMode": "single-session", "config": { "chatMode": "interactive" } }

// 单聊/群聊
{ "responseMode": "single-session", "config": { "chatMode": "proactive", "mentionMode": "disabled" } }
```

---

## 五、dual-session 特有参数

**存放级别**：`config` 内 · **适用**：仅 `dual-session`

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

> `delayLevel`（short/medium/long）**不是配置参数**，而是辅助会话每次决策的输出字段
> （见 [data-structures.md AuxiliaryDecision](./dual-session/data-structures.md)）。
> 对端系数由代码按发送者类型自动判定，无需配置参数控制。

### 5.3 模型参数

| 参数 | 等级 | 可选值 | 默认值 | 用途 |
|------|------|--------|--------|------|
| `model` | 核心（通用） | 模型 ID | `claude-opus` | 主会话模型（通用参数，见 §三；此处列出以便对照） |
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
| 2 | 环境级（预留） | 环境层尚未定型，config 路径待定 |
| 3 | Agent 级 | `$AGENT_DIR/config.json` |
| 4（最低） | 出厂默认值 | 代码内置 |

> **环境级 config 待定**：环境层承载更高抽象（组织、类型级共性），不为具体群/私聊实例建目录。
> 环境级 config 的存储路径、键的设计留待环境层正向规划时确定。本次仅消除旧的 `venueKey` 命名。

**覆盖示例**：

```json
// Agent 级（$AGENT_DIR/config.json）
{
  "responseMode": "dual-session",
  "config": { "chatMode": "proactive", "mentionMode": "disabled" }
}

// 关系级覆盖（$RELATIONS_DIR/aun#alice.aid.pub/config.json）
{
  "config": { "mentionMode": "mention-only" }   // 只覆盖这一项
}

// 最终生效
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",        // 继承 Agent 级
    "mentionMode": "mention-only"   // 关系级覆盖
  }
}
```

---

## 八、完整配置示例

### 8.1 single-session（coding 模式）

```json
{
  "responseMode": "single-session",
  "config": { "chatMode": "interactive" }
}
```

### 8.2 dual-session 标准群聊

```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "disabled",
    "model": "claude-opus",
    "auxiliaryModel": "deepseek-v4-flash",
    "debounceMs": 3000,
    "maxWaitMs": 15000,
    "maxQueueSize": 50,
    "interruptEnabled": true
  }
}
```

### 8.3 dual-session 单聊（低延迟）

```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "disabled",
    "maxQueueSize": 15,
    "debounceMs": 2000
  }
}
```

### 8.4 dual-session 低成本

```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "model": "claude-sonnet",
    "auxiliaryModel": "deepseek-v4-flash",
    "debounceMs": 5000,
    "auxiliaryMaxTokens": 20000,
    "mainMaxTokens": 80000
  }
}
```

---

## 九、参数速查总表

一站式速查（★=核心，☆=高级）：

| 参数（英文名） | 中文名 | 级别 | 模式 | 可选值 | 默认 | ★/☆ |
|------|------|------|------|--------|------|------|
| `responseMode` | 响应模式 | 顶层 | — | single-session / dual-session / workflow | — | ★ |
| `chatMode` | 交互方式 | config·通用 | 全部 | interactive / proactive | — | ★ |
| `mentionMode` | 提及处理策略 | config·通用 | 全部 | disabled / mention-only | disabled | ★ |
| `model` | 主会话模型 | config·通用 | 全部 | 模型 ID | claude-opus | ★ |
| `auxiliaryModel` | 辅助会话模型 | config·特有 | dual-session | 模型 ID | deepseek-v4-flash | ★ |
| `debounceMs` | 防抖时间 | config·特有 | dual-session | 0-6000 | 3000 | ★ |
| `maxWaitMs` | 最长等待时间 | config·特有 | dual-session | 5000-30000 | 15000 | ★ |
| `maxQueueSize` | 队列最大容量 | config·特有 | dual-session | 10-100 | 群50/单15 | ★ |
| `interruptEnabled` | 是否启用打断 | config·特有 | dual-session | boolean | true | ★ |
| `maxBatchSize` | 单批最多消息数 | config·特有 | dual-session | 正整数 | 50 | ☆ |
| `maxBatchBytes` | 单批最多字节数 | config·特有 | dual-session | 正整数 | 10240 | ☆ |
| `baseDelayMs` | 延迟基础偏移 | config·特有 | dual-session | ≥0 | 0 | ☆ |
| `auxiliaryMaxTokens` | 辅助会话压缩 token 阈值 | config·特有 | dual-session | 20000-80000 | 40000 | ☆ |
| `auxiliaryMaxMessages` | 辅助会话压缩消息数阈值 | config·特有 | dual-session | 正整数 | 100 | ☆ |
| `mainMaxTokens` | 主会话压缩 token 阈值 | config·特有 | dual-session | 80000-500000 | 160000 | ☆ |
| `mainMaxMessages` | 主会话压缩消息数阈值 | config·特有 | dual-session | 正整数 | 200 | ☆ |
| `compressionTarget` | 压缩摘要目标字数 | config·特有 | dual-session | 正整数 | 2000 | ☆ |
| `enableDebug` | 是否启用调试输出 | config·特有 | dual-session | boolean | false | ☆ |

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-08  
**状态**: ✅ 参数唯一事实源
