# 双会话响应模式 - 特有参数

**版本**: 2.0  
**创建时间**: 2026-07-08  
**状态**: 设计定稿

---

## 一、概述

特有参数是**双会话响应模式独有的配置参数**，用于控制辅助队列、辅助会话、主队列、主会话的具体行为。

---

## 二、特有参数清单

> **参数唯一事实源见 [config-reference.md](../../config-reference.md)**。本文档保留各参数的
> 详细说明与调优建议，参数集合/默认值以 config-reference.md 为准。

```typescript
interface DualSessionConfig extends CommonResponseModeConfig {
  // === 辅助队列触发配置 ===
  debounceMs?: number;          // 防抖时间（默认 3000ms，范围 0-6000）
  maxWaitMs?: number;           // 最早消息最长等待（默认 15000ms，范围 5000-30000）
  maxQueueSize?: number;        // 队列满强制转投阈值（群聊 50，单聊 15）
  maxBatchSize?: number;        // 每批最多消息数（默认 50）【高级】
  maxBatchBytes?: number;       // 每批最多字节数（默认 10240）【高级】
  
  // === 延迟投递配置（单聊与群聊公式相同）===
  // 实际延迟 = baseDelayMs + random(0, effectiveLevelMs)
  // effectiveLevelMs = baseLevelMs(delayLevel) × 对端系数（agent×1.0 / 人×0.5）
  // delayLevel 由辅助会话输出；对端系数由代码按发送者类型自动判定
  baseDelayMs?: number;         // 延迟基础偏移（默认 0）【高级】
  
  // === HOLD 超时兜底（仅群聊；DELAY/HOLD 到期共用同一套扫描/定时器）===
  holdTimeoutMs?: number;       // HOLD 挂起多久后兜底转投主队列（默认 3600000ms=1小时）【高级】
                                // 由独立到期定时器驱动，不依赖新消息；防止 HOLD 消息饿死
  
  // === 辅助会话配置 ===
  auxiliaryModel?: string;      // 辅助会话模型（默认 'deepseek-v4-flash'）
  auxiliaryMaxTokens?: number;  // 辅助会话压缩阈值（默认 40000）【高级】
  auxiliaryMaxMessages?: number; // 辅助会话消息数压缩阈值（默认 100）【高级】
  
  // === 主会话配置 ===
  // 主会话模型用通用参数 model（不是 mainModel）
  mainMaxTokens?: number;       // 主会话压缩阈值（默认 160000）【高级】
  mainMaxMessages?: number;     // 主会话消息数压缩阈值（默认 200）【高级】
  compressionTarget?: number;   // 压缩摘要目标字数（默认 2000）【高级】
  
  // === 打断与调试 ===
  interruptEnabled?: boolean;   // 是否启用打断（默认 true）
  enableDebug?: boolean;        // 是否启用调试输出（默认 false）【高级】
}
```

---

## 三、辅助队列触发配置

### 3.1 debounceMs（防抖时间）

**说明**：新消息到达后，等待多久触发辅助会话判断（如果期间有新消息则重置）

**默认值**：`3000`（3秒）

**取值范围**：`0-6000`（0-6秒）

**作用**：
- ✅ 等待用户分段输入完成（如：文本 + 截图 + 问题）
- ✅ 批量处理，提高效率

**场景示例**：

```
T0: Owner: "这个报错"
T2: Owner: [截图]
T5: Owner: "怎么解决？"

防抖3秒：
  T0 → 重置定时器
  T2 → 重置定时器
  T5 → 重置定时器
  T8 → 触发辅助会话（一次性处理全部3条消息）
```

**配置示例**：

```json
// 快速响应（减少防抖）
{
  "config": {
    "debounceMs": 1000  // 1秒
  }
}

// 更长的等待（适合消息频繁的群聊）
{
  "config": {
    "debounceMs": 5000  // 5秒
  }
}
```

---

### 3.2 maxWaitMs（最早消息最长等待）

**说明**：即使有新消息不断到达（防抖一直重置），最早的消息等待超过此时间也会强制触发

**默认值**：`15000`（15秒）

**取值范围**：`5000-30000`（5-30秒）

**作用**：
- ✅ 防止防抖无限重置，消息永远得不到处理
- ✅ 保证响应延迟的上限

**场景示例**：

```
T0: Owner: "问题1"
T2: Owner: "问题2"
T5: Owner: "问题3"
T8: Owner: "问题4"
T11: Owner: "问题5"  ← 防抖不断重置

T15: 强制触发（最早消息已等待15秒）
```

**配置示例**：

```json
// 更快的强制触发
{
  "config": {
    "maxWaitMs": 10000  // 10秒
  }
}

// 更长的容忍时间
{
  "config": {
    "maxWaitMs": 30000  // 30秒
  }
}
```

---

### 3.3 maxQueueSize（队列最大容量）

**说明**：辅助队列累积消息数达到此值时，强制投递所有消息到主队列（不打断）

**默认值**：
- 群聊：`50`
- 单聊：`15`

**取值范围**：`10-100`

**作用**：
- ✅ 防止队列无限增长
- ✅ 消息爆发时快速降级（跳过辅助会话判断）

**场景示例**：

```
群聊消息爆发：
  50条消息在5秒内到达
  ↓
  队列满（50条）
  ↓
  强制投递所有消息到主队列
  ↓
  清空辅助队列
```

**配置示例**：

```json
// 群聊：更大的容量
{
  "config": {
    "maxQueueSize": 100
  }
}

// 单聊：更小的容量（更快触发）
{
  "config": {
    "maxQueueSize": 10
  }
}
```

---

## 四、辅助会话配置

### 4.1 auxiliaryModel（辅助会话模型）

**说明**：辅助会话使用的模型

**默认值**：`deepseek-v4-flash`

**推荐值**：
- `deepseek-v4-flash`（快速、便宜）
- `claude-haiku`（质量更高，稍贵）

**作用**：
- 辅助会话负责快速判断消息相关性（hold / delay / transfer）
- 使用便宜模型可以大幅降低成本

**成本对比**：

| 模型 | 输入价格 | 输出价格 | 响应速度 |
|------|---------|---------|---------|
| deepseek-v4-flash | $0.1/M tokens | $0.4/M tokens | ~500ms |
| claude-haiku | $0.8/M tokens | $4.0/M tokens | ~800ms |
| claude-opus | $15/M tokens | $75/M tokens | ~2000ms |

**配置示例**：

```json
// 使用 DeepSeek（默认）
{
  "config": {
    "auxiliaryModel": "deepseek-v4-flash"
  }
}

// 使用 Haiku（质量优先）
{
  "config": {
    "auxiliaryModel": "claude-haiku"
  }
}
```

---

### 4.2 auxiliaryMaxTokens（辅助会话压缩阈值）

**说明**：辅助会话上下文 token 数超过此值时，触发压缩（生成摘要，创建新会话）

**默认值**：`40000`

**取值范围**：`20000-80000`

**作用**：
- ✅ 控制辅助会话的上下文长度
- ✅ 定期清理，保持效率

**压缩机制**：

```
辅助会话 token 超过 40k
  ↓
在当前会话中生成压缩摘要（<2000字）
  ↓
创建新会话
  ↓
载入：压缩摘要 + 最近10条原始消息
```

**配置示例**：

```json
// 更频繁的压缩
{
  "config": {
    "auxiliaryMaxTokens": 20000
  }
}

// 更长的上下文
{
  "config": {
    "auxiliaryMaxTokens": 80000
  }
}
```

---

## 五、主会话配置

### 5.1 mainMaxTokens（主会话压缩阈值）

**说明**：主会话上下文 token 数超过此值时，触发压缩

**默认值**：`160000`

**取值范围**：`80000-500000`

**作用**：
- ✅ 控制主会话的上下文长度
- ✅ 适应不同模型的上下文窗口

**压缩机制**：

```
主会话 token 超过 160k
  ↓
在当前会话中生成压缩摘要
  ↓
创建新会话
  ↓
载入：压缩摘要 + 最近20条原始消息
```

**配置示例**：

```json
// 更频繁的压缩
{
  "config": {
    "mainMaxTokens": 80000
  }
}

// 超长上下文（Claude Opus 支持 200k）
{
  "config": {
    "mainMaxTokens": 180000
  }
}
```

---

## 六、打断策略

### 6.1 interruptEnabled（是否启用打断）

**说明**：是否允许辅助会话打断正在处理的主会话

**默认值**：`true`

**作用**：
- ✅ 紧急消息可以打断慢速处理
- ✅ 避免处理过期消息

**打断条件**：

1. `interruptEnabled === true`
2. 辅助会话判断需要打断（`interrupt: true`）
3. 主会话正在处理（`status === 'processing'`）
4. 当前批次未满（`currentBatchSize < 50`）

**打断行为**：

```
主会话正在处理消息 A（已处理2分钟）
主队列：[B, C]

突然：Owner: "紧急！生产环境崩了！"
  ↓
辅助会话判断：interrupt: true
  ↓
打断主会话（硬打断，调用 SDK abort）
  ↓
紧急批次（携带指令）入主队列：[G, O-紧急]
  ↓
批次调度：取最后一个 interrupt 批次 O 优先处理
（被跳过的 G 作 reference 注入、本体留队列；ignore 指令则移除更早批次）
  ↓
主会话处理 O（消息A仍在上下文，不回灌队列）
```

**副作用**（固有特性，非缺陷；靠辅助会话谨慎决策规避）：
- ❌ 已发送的回复无法撤回
- ❌ 已执行的工具调用无法撤回

> 打断机制完整论述（硬 abort 语义、被打断批次去向、三策略、并发时序）见
> [interrupt-mechanism.md](../interrupt-mechanism.md)，为唯一事实源。

**配置示例**：

```json
// 禁用打断（始终排队）
{
  "config": {
    "interruptEnabled": false
  }
}

// 启用打断（默认）
{
  "config": {
    "interruptEnabled": true
  }
}
```

---

## 七、完整配置示例

### 7.1 标准群聊配置

```json
{
  "responseMode": "dual-session",
  "config": {
    // 通用参数
    "chatMode": "proactive",
    "mentionMode": "disabled",
    "model": "claude-opus",
    
    // 特有参数
    "debounceMs": 3000,
    "maxWaitMs": 15000,
    "maxQueueSize": 50,
    "auxiliaryModel": "deepseek-v4-flash",
    "auxiliaryMaxTokens": 40000,
    "mainMaxTokens": 160000,
    "interruptEnabled": true
  }
}
```

### 7.2 提及模式配置（owner 主导的群聊）

```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "mention-only",  // 只处理 @ 消息
    "debounceMs": 1000,             // 减少防抖
    "maxWaitMs": 10000,             // 更快强制触发
    "auxiliaryModel": "claude-haiku"  // 质量优先
  }
}
```

### 7.3 低成本配置

```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "model": "claude-sonnet",           // 主会话使用 Sonnet
    "auxiliaryModel": "deepseek-v4-flash",  // 辅助会话使用 DeepSeek
    "debounceMs": 5000,                 // 更长防抖，批量处理
    "auxiliaryMaxTokens": 20000,        // 更频繁压缩
    "mainMaxTokens": 80000
  }
}
```

### 7.4 单聊配置

```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "disabled",  // 单聊无需 mention
    "maxQueueSize": 15,         // 单聊专用队列大小
    "debounceMs": 2000,         // 更快响应
    "interruptEnabled": true    // 允许打断
  }
}
```

---

## 八、参数调优指南

### 8.1 消息频率

| 消息频率 | 推荐配置 |
|---------|---------|
| 稀疏（几分钟一条） | `debounceMs: 1000`, `maxWaitMs: 10000` |
| 正常（每分钟几条） | `debounceMs: 3000`, `maxWaitMs: 15000` |
| 频繁（每分钟十几条） | `debounceMs: 5000`, `maxWaitMs: 20000` |

### 8.2 响应延迟要求

| 延迟要求 | 推荐配置 |
|---------|---------|
| 极速（< 5秒） | `debounceMs: 1000`, `maxWaitMs: 5000` |
| 快速（5-10秒） | `debounceMs: 2000`, `maxWaitMs: 10000` |
| 正常（10-20秒） | `debounceMs: 3000`, `maxWaitMs: 15000` |

### 8.3 成本控制

| 成本要求 | 推荐配置 |
|---------|---------|
| 极低成本 | `auxiliaryModel: 'deepseek-v4-flash'`, `model: 'claude-sonnet'` |
| 平衡 | `auxiliaryModel: 'deepseek-v4-flash'`, `model: 'claude-opus'` |
| 质量优先 | `auxiliaryModel: 'claude-haiku'`, `model: 'claude-opus'` |

---

## 九、监控指标

建议监控以下指标以调优参数：

| 指标 | 说明 | 理想值 |
|------|------|--------|
| **辅助会话过滤率** | hold / (hold + transfer) | 30-50% |
| **平均响应延迟** | 消息到达 → 回复发出 | < 15秒 |
| **打断率** | 打断次数 / 总处理批次 | < 5% |
| **队列满触发率** | 队列满触发 / 总触发 | < 10% |
| **辅助会话成本占比** | 辅助会话成本 / 总成本 | < 20% |

---

## 十、配置层级

特有参数也支持多层级配置和覆盖：

1. **关系级配置**（`$RELATIONS_DIR/<peerKey>/config.json`）
2. **环境级配置**（`$VENUES_DIR/<venueKey>/config.json`）
3. **Agent 级配置**（`$AGENT_DIR/config.json`）
4. **出厂默认值**

**示例**：

```json
// Agent 级配置（$AGENT_DIR/config.json）
{
  "responseMode": "dual-session",
  "config": {
    "debounceMs": 3000,
    "auxiliaryModel": "deepseek-v4-flash"
  }
}

// 环境级覆盖（$VENUES_DIR/aun#vip-group/config.json）
{
  "config": {
    "debounceMs": 1000,              // 覆盖：VIP 群快速响应
    "mentionMode": "mention-only"    // 新增：启用提及模式
  }
}

// 最终生效配置
{
  "responseMode": "dual-session",
  "config": {
    "debounceMs": 1000,                     // 环境级覆盖
    "mentionMode": "mention-only",          // 环境级新增
    "auxiliaryModel": "deepseek-v4-flash"   // Agent 级继承
  }
}
```

---

## 十一、总结

### 参数分类

| 类别 | 参数 | 作用 |
|------|------|------|
| **触发控制** | debounceMs, maxWaitMs, maxQueueSize | 何时触发辅助会话 |
| **模型选择** | auxiliaryModel | 辅助会话用什么模型 |
| **上下文管理** | auxiliaryMaxTokens, mainMaxTokens | 何时压缩 |
| **打断策略** | interruptEnabled | 是否允许打断 |

### 调优原则

✅ **先用默认值**：默认配置适用于大多数场景  
✅ **按场景调整**：根据消息频率、延迟要求、成本控制调整  
✅ **持续监控**：通过监控指标评估配置效果  
✅ **分层配置**：不同群聊可以有不同配置  

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-08  
**状态**: ✅ 设计定稿
