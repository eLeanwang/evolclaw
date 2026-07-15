# 双会话响应模式（Dual-Session Response Mode）

**版本**: 2.0  
**创建时间**: 2026-07-08  
**状态**: 设计定稿

---

## 一、概述

双会话响应模式是 EvolClaw 针对**群聊和单聊场景**设计的智能响应架构。通过**辅助会话**和**主会话**的配合，解决多 agent 场景（群聊）和快慢模型不对齐（单聊/群聊）的核心痛点。

### 核心特性

✅ **职责清晰**：辅助会话判断"何时投递"，主会话负责"回复什么"  
✅ **打断机制**：避免慢 agent 处理过期消息  
✅ **延迟投递**：避免多 agent 竞争回复（含随机延迟）  
✅ **批量处理**：提高效率，优化 token  
✅ **反馈机制**：主会话处理结果同步给辅助会话  

---

## 二、核心问题

### 问题 1：消息爆炸

```
场景：
  Owner: "这个 API 怎么设计？"
  Agent1: "我觉得用 REST"
  Agent2: "GraphQL 更好"
  Agent3: "@Agent1 REST 有什么优势？"
  ...（爆炸）
```

### 问题 2：快慢模型不对齐

```
时间线：
  T0: Owner 问问题 Q1
  T1: Agent1-4 快速回复（5秒内完成）
  T1: Agent5 开始处理（需要大量工具调用）
  
  T+5分钟: Agent5 还在处理 Q1
           期间 Owner 又问了 Q2, Q3, Q4
           Agent1-4 都回复了
           → Agent5 的队列中新增了 15-20 条消息
  
  T+5分钟: Agent5 处理完 Q1，准备回复
           问题：
             1. 回复 Q1 时大家已经在讨论 Q2/Q3 了
             2. Agent5 队列中有 15-20 条新消息
             3. 不处理无法判断哪些重要/过期
             4. 处理又慢，继续拉慢节奏
```

### 问题 3：多 agent 竞争回复

```
场景：
  Owner: "这个问题怎么解决？"（未@具体agent）
  
问题：
  - 所有 agent 都立即处理并回复
  - 导致重复回复
  - 实际上只需要一个回复
```

---

## 三、解决方案

```
核心思想：
  辅助会话判断"何时投递" → 主会话精准处理
  
架构：
  AUN 消息 → 辅助队列 → 辅助会话（判断投递时机）
           ↓
  主队列 → 主会话（批量处理）→ 回复
           ↓
  反馈 → 辅助会话（更新上下文）
```

---

## 四、配置示例

> 通用参数（chatmode / mentionMode / model）在**顶层**；模式特有参数放
> `responseModeParams["dual-session"]` 桶。详见 [config-reference.md](../config-reference.md)。

### 4.1 标准配置（群聊）

```json
{
  "responseMode": "dual-session",
  "chatmode": { "group": "proactive" },
  "mentionMode": "disabled",
  "responseModeParams": {
    "dual-session": {
      "debounceMs": 3000,
      "maxWaitMs": 15000,
      "auxiliaryModel": "deepseek-v4-flash"
    }
  }
}
```

### 4.2 提及模式配置（只处理 @ 消息）

```json
{
  "responseMode": "dual-session",
  "mentionMode": "mention-only"
}
```

### 4.3 单聊配置

```json
{
  "responseMode": "dual-session",
  "mentionMode": "disabled",
  "responseModeParams": {
    "dual-session": { "maxQueueSize": 15 }
  }
}
```

---

## 五、文档导航

### 核心架构

- **[架构设计](./architecture.md)** - 完整的系统架构和组件设计
- **[数据结构](./data-structures.md)** - 完整的 TypeScript 接口定义

### 参数配置

- **[配置参考总表](../config-reference.md)** ⭐ - 所有参数的唯一事实源（含存放级别/可选值/默认值）
- **[通用参数](./config/common-params.md)** - chatMode / mentionMode / model（详细说明）
- **[特有参数](./config/specific-params.md)** - dual-session 特有配置（详细说明+调优）

### ECK 集成

- **[ECK 集成](./eck-integration.md)** - 与 ECK 的集成方式
- **[系统提示词](./prompts/)** - 辅助会话和主会话的提示词模板

### 实施指南

- **[实施计划](./implementation-plan.md)** - 分阶段实施计划
- **[迁移指南](./migration-guide.md)** - 从旧版本迁移

### 设计决策

- **[设计决策记录](./decisions/)** - 关键设计决策的记录（可选，未创建）

---

## 六、快速开始

### 1. 启用双会话模式

在 agent 配置中设置（chatmode 按对端类型自动解析，通常无需显式配）：

```json
{
  "responseMode": "dual-session"
}
```

### 2. 理解核心流程

1. **消息到达** → 进入辅助队列
2. **防抖触发** → 辅助会话判断（hold / delay / transfer）
3. **投递主队列** → 主会话批量处理
4. **生成回复** → 反馈给辅助会话

### 3. 调整参数

根据场景调整参数：
- 群聊多 agent：启用 `mentionMode: 'mention-only'`
- 消息频繁：减小 `debounceMs`
- 消息稀疏：增大 `maxWaitMs`

---

## 七、与单会话模式的对比

| 维度 | 单会话模式 | 双会话模式 |
|------|-----------|-----------|
| **成本** | 所有消息进主会话 | 辅助会话预过滤 |
| **延迟** | 5-10秒 | 首条：8-13秒，后续：正常 |
| **多agent竞争** | 重复回复 | 延迟投递 + 随机数 |
| **快慢模型不对齐** | 处理过期消息 | 打断机制 |
| **架构复杂度** | 简单 | 中等 |
| **适用场景** | 简单直接响应 | 群聊、复杂场景 |

---

## 八、常见问题

### Q: 为什么需要辅助会话？

A: 辅助会话使用便宜模型（DeepSeek/Haiku）快速判断消息相关性，避免所有消息都进入主会话（Opus），大幅降低成本。

### Q: 延迟投递的时长怎么算？

A: 单聊、群聊公式相同：`baseDelayMs + random(0, 等级时长 × 对端系数)`。等级(short/medium/long
=1/2/3分钟)由辅助会话输出；对端系数由代码判定（对端是人 ×0.5、agent ×1.0）。

### Q: 什么时候会打断主会话？

A: 辅助会话判断需要打断（批次携带 `interrupt: true`）、主会话正在处理且在飞批次 < 50 条时，会硬打断（调用 SDK abort）。主队列以**同角色批次**为调度单位：interrupt 批次被优先处理，被跳过的更早批次作为只读 reference 注入（本体留队列排队）。被打断批次的旧消息不回灌队列，仅保留在主会话上下文。完整机制见 [interrupt-mechanism.md](./interrupt-mechanism.md)。

### Q: 单聊和群聊有什么区别？

A: 延迟机制两者相同（都带随机、公式一致），区别仅：
- 群聊：`hold / delay / transfer` 三种决策
- 单聊：`delay / transfer` 两种决策（无 hold，一对一都相关）

---

## 九、相关资源

- **[响应模式体系架构](../ARCHITECTURE.md)** - 整体响应模式设计（入口文档）
- **[旧版文档](../dual-session-lite/)** - dual-session-lite 历史文档（参考）

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-08  
**状态**: ✅ 设计定稿
