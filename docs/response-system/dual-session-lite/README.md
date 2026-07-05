# 双会话响应模式 - 简化版

## 文档说明

**版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**状态**: 设计定稿

---

## 一、概述

### 1.1 什么是双会话响应模式（简化版）

双会话响应模式简化版是 EvolClaw 针对**群聊和单聊场景**设计的智能响应架构。通过**辅助会话**和**主会话**的配合，解决多 agent 场景（群聊）和快慢模型不对齐（单聊/群聊）的核心痛点。

### 1.2 核心问题

#### 问题 1：消息爆炸
```
场景：
  Owner: "这个 API 怎么设计？"
  Agent1: "我觉得用 REST"
  Agent2: "GraphQL 更好"
  Agent3: "@Agent1 REST 有什么优势？"
  ...（爆炸）
```

#### 问题 2：快慢模型不对齐（核心痛点）
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

#### 问题 3：多 agent 竞争回复
```
场景：
  Owner: "这个问题怎么解决？"（未@具体agent）
  
问题：
  - 所有 agent 都立即处理并回复
  - 导致重复回复
  - 实际上只需要一个回复
```

### 1.3 解决方案

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

### 1.4 核心特性

✅ **职责清晰**：辅助会话只管"何时投递"，不管"回复什么"  
✅ **打断机制**：避免慢 agent 处理过期消息  
✅ **延迟投递**：避免多 agent 竞争回复（含随机延迟）  
✅ **批量处理**：提高效率，优化 token  
✅ **反馈机制**：主会话处理结果同步给辅助会话  

---

## 二、整体架构

### 2.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    AUN 消息到达                              │
└────────────────────────┬────────────────────────────────────┘
                         ↓
        ┌────────────────────────────────┐
        │   辅助队列                      │
        │   - 防抖3秒                     │
        │   - 最早消息15秒强制触发        │
        │   - 队列满50条强制触发          │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   辅助会话 (Auxiliary Session) │
        │   便宜模型 (DeepSeek/Haiku)    │
        │                                │
        │   职责:                        │
        │   1. 判断何时投递               │
        │   2. 判断是否打断               │
        │   3. 接收主会话反馈             │
        └────────────┬───────────────────┘
                     ↓
        输出决策：hold / delay / transfer
                     ↓
        ┌────────────────────────────────┐
        │   主队列                        │
        │   - 追加 or 打断重新提取批次    │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   主会话 (Main Session)        │
        │   主力模型 (Claude Opus)       │
        │                                │
        │   职责:                        │
        │   1. 批量处理消息               │
        │   2. 生成回复                   │
        │   3. 判断消息是否过期           │
        │   4. 输出处理总结               │
        └────────────┬───────────────────┘
                     ↓
        生成回复 + 处理总结
                     ↓
        追加到 main-feedback.jsonl
                     ↓
        反馈给辅助会话
```

### 2.2 数据流

```
[阶段 1] 消息到达辅助队列
  - 标记为 PENDING
  - 启动防抖定时器（3秒）

[阶段 2] 辅助会话批次处理
  触发条件：
    - 防抖3秒
    - 最早消息15秒
    - 队列满50条
    - 延迟投递超时
    - 主会话反馈到达
  ↓
  调用辅助会话模型
  ↓
  输出决策：
    - hold: 继续挂起
    - delay: 延迟投递（3秒基础 + 0-60秒随机）
    - transfer: 立即投递（可选打断）

[阶段 3] 投递到主队列
  if transfer:
    - 从辅助队列移除消息（标记为 TRANSFERRED）
    if interrupt:
      - 打断主会话（如果正在处理 && 批次<50条）
      - 新消息追加到主队列末尾
      - 重新提取批次（最多50条）
    else:
      - 追加到主队列末尾

[阶段 4] 主会话批次处理
  - 从主队列提取最多50条消息
  - 批量处理
  - 生成回复

[阶段 5] 主会话反馈
  - 生成处理总结（<200字）
  - 追加到 main-feedback.jsonl
  - 通知辅助会话

[阶段 6] 辅助会话同步
  - 将反馈内容追加到辅助会话上下文
```

---

## 三、核心机制

### 3.1 辅助队列触发机制

```typescript
触发条件（满足任一）：
  1. 防抖3秒（有新消息重置）
  2. 最早消息等待超过15秒（强制触发）
  3. 队列累计超过50条（强制投递到主队列，不打断）
  4. 延迟投递超时（该投递了）
  5. 主会话反馈到达（需要更新上下文）

批次处理限制：
  - 每批最多50条消息
  - 或最多10k字节
```

### 3.2 消息状态管理

```typescript
enum MessageState {
  PENDING = 'pending',           // 刚到达，未处理
  HOLD = 'hold',                 // 挂起（无关）
  DELAY = 'delay',               // 延迟投递（有关但不急）
  TRANSFERRED = 'transferred',   // 已投递
}

interface QueuedMessage {
  message: Message;
  state: MessageState;
  
  // 如果 state = DELAY
  transferAt?: Date;             // 何时投递
}
```

**重新判断规则**：
- 延迟期间收到新消息 → 触发辅助会话
- 辅助会话重新判断所有未投递消息（PENDING + DELAY）
- 可能改变之前的决策（DELAY → HOLD / TRANSFER）

### 3.3 延迟投递机制（含随机数）

```typescript
// 辅助会话决策
{
  action: 'delay',
  delayMs: 3000,  // 基础延迟3秒
  reason: '等待其他agent回复'
}

// 代码层处理
const randomDelay = Math.random() * 60000;  // 0-60秒随机
const actualDelay = 3000 + randomDelay;     // 实际延迟：3-63秒

// 设置定时器
setTimeout(() => {
  triggerAuxiliary('timeout');
}, actualDelay);
```

**场景示例**：
```
Owner: "这个问题怎么解决？"（未@具体agent）

Agent1 辅助会话判断：delay 3s + 随机12s = 15s
Agent2 辅助会话判断：delay 3s + 随机5s = 8s   ← 先触发
Agent3 辅助会话判断：delay 3s + 随机28s = 31s

时间线：
  T0: 消息到达
  T+8s: Agent2 先触发，判断后 transfer，回复
  T+15s: Agent1 触发，看到 Agent2 已回复 → hold（挂起）
  T+31s: Agent3 触发，看到 Agent2 已回复 → hold（挂起）
```

### 3.4 打断机制

#### 打断条件
辅助会话判断需要打断（interrupt: true）

#### 打断行为
```typescript
if (interrupt && mainSession.status === 'processing' && currentBatchSize < 50) {
  // 1. 停止主会话
  mainSession.stop();
  
  // 2. 当前批次中的消息A已在主会话上下文（保留）
  
  // 3. 新投递的消息追加到主队列末尾
  mainQueue.append(newMessages);
  
  // 4. 重新提取批次（最多50条）
  const newBatch = mainQueue.extractBatch(50);
  
  // 5. 主会话处理新批次（消息A已在上下文）
  mainSession.process(newBatch);
}
```

#### 不打断场景
- 主会话空闲（无需打断）
- 当前批次已满（≥50条）→ 打断无意义，重新提取还是这些消息

#### 打断效果
```
打断前：
  主会话处理中：A（已在上下文）
  主队列：[B, C]

新消息 D 到达，辅助会话判断 interrupt: true
  ↓
打断后：
  主会话重新处理：[B, C, D]
  （消息A仍在上下文，可以继续参考）
```

### 3.5 反馈机制

#### 主会话生成总结
主会话在 turn 内自己通过 CLI 发送回复，turn 结束时输出自然语言总结（<200字）。

代码层组装反馈：
```typescript
// 从主会话输出中提取自然语言总结
const summary = extractSummary(mainSessionOutput); // "处理了 Owner 关于报错的求助，已回复解决方案"

// 从工具调用历史中提取回复内容
const replies = extractRepliesFromToolCalls(); // ["这个报错是因为..."]

// 组装 MainFeedback
const feedback: MainFeedback = {
  summary,
  replies,
};

// 直接通知辅助会话（不写文件）
auxiliarySession.processFeedback(feedback);
```

#### 辅助会话处理反馈
```typescript
// 输入
{
  type: 'main-feedback',
  mainFeedback: {
    summary: '处理了 Owner 关于报错的求助，已回复解决方案',
    replies: ['这个报错是因为...'],
  }
}

// 输出（简单确认）
{
  type: 'feedback-ack',
  ack: {
    reason: '已更新上下文'
  }
}

// 代码层处理
// 将反馈内容追加到辅助会话上下文
```

### 3.6 辅助会话 new 机制（带压缩）

```
触发条件：
  - 上下文 token 数超过 40k
  - 或消息数超过 100 条

压缩方式：
  1. 在辅助会话中直接给压缩提示词
     "请将当前对话压缩成摘要（<2000字）：
      - 讨论话题：
      - 参与者：
      - 重要事件：
      - 当前状态："
  
  2. 获取压缩摘要
  
  3. 创建新会话，载入：
     - 压缩摘要（作为历史上下文）
     - 最近10条原始消息
  
  4. 辅助队列中未投递的消息保留，继续处理
```

### 3.7 主会话 new 机制

```
触发条件：
  - 上下文 token 数超过 160k
  - 或消息数超过 200 条

压缩方式：
  1. 在主会话中生成压缩摘要
  2. 创建新会话
  3. 载入：压缩摘要 + 最近20条消息
  4. 主队列未处理的消息保留，继续处理
```

---

## 四、ECK 集成

### 4.1 ECK Vars 参数体系

```typescript
// 会话级参数
interface ECKVars {
  // 响应模式
  responseMode: 'dual-session-lite';
  
  // 会话类型（关键！）
  sessionType: 'auxiliary' | 'main';
  
  // 其他现有参数
  chatMode: 'proactive';
  channel: string;
  selfAid: string;
  peerId: string;
  // ...
}
```

### 4.2 系统提示词渲染层

```yaml
# Context Assembly Manifest

sections:
  # 辅助会话系统提示词
  - id: auxiliary-session-prompt
    when: "responseMode === 'dual-session-lite' && sessionType === 'auxiliary'"
    source:
      type: file
      path: "$KITS/docs/response-system/dual-session-lite/prompts/auxiliary-base.md"
    priority: 100
  
  # 主会话系统提示词
  - id: main-session-prompt
    when: "responseMode === 'dual-session-lite' && sessionType === 'main'"
    source:
      type: file
      path: "$KITS/docs/response-system/dual-session-lite/prompts/main-base.md"
    priority: 100
```

---

## 五、数据接口

### 5.1 辅助会话输入

```typescript
interface AuxiliaryInput {
  // 输入类型
  type: 'aun-messages' | 'main-feedback';
  
  // 如果 type = 'aun-messages'
  aunMessages?: {
    queue: Message[];              // 辅助队列中所有未投递的消息
    newMessages: Message[];        // 本次新增的消息
  };
  
  // 如果 type = 'main-feedback'
  mainFeedback?: {
    processedMessageIds: string[];  // 主会话处理了哪些消息
    summary: string;                // 主会话的处理总结
    replies: string[];              // 主会话的回复内容
  };
  
  // 主会话当前状态
  mainSession: {
    status: 'idle' | 'processing';
    currentBatchSize?: number;      // 当前批次大小（如果正在处理）
    queueSize: number;              // 主队列剩余消息数
  };
}
```

### 5.2 辅助会话输出（简化版）

```typescript
interface AuxiliaryOutput {
  // 输入类型对应的输出
  type: 'aun-decision' | 'feedback-ack';
  
  // 如果 type = 'aun-decision'
  decision?: {
    action: 'hold' | 'delay' | 'transfer';
    
    // 如果 action = 'delay'
    delayMs?: number;              // 延迟时间（默认3000，代码层会加随机0-60000）
    
    // 如果 action = 'transfer'
    interrupt?: boolean;           // 是否打断（默认false）
    
    // 简短说明（<50字）
    reason: string;
  };
  
  // 如果 type = 'feedback-ack'
  ack?: {
    reason: '已知悉' | '已更新上下文';
  };
}
```

**设计要点**：
- ✅ 极简输出（3个action + 1个数字 + 1个布尔 + 1个短reason）
- ✅ 节省 token
- ✅ 不容易出错

---

## 六、关键流程

### 6.1 防抖等待（分段输入）

```
场景：
  T0: Owner: "这个报错"
  T2: Owner: [截图]
  T5: Owner: "怎么解决？"

辅助会话判断：
  T0: 消息到达 → 防抖3秒
  T2: 新消息到达 → 重置防抖3秒
  T5: 新消息到达 → 重置防抖3秒
  T8: 触发辅助会话 → transfer（一次性投递全部3条消息）

输出：
  {
    type: 'aun-decision',
    decision: {
      action: 'transfer',
      interrupt: false,
      reason: '用户分段输入已完成'
    }
  }
```

### 6.2 延迟投递（多 agent 竞争）

```
场景：
  Owner: "这个问题怎么解决？"（未@具体agent）

各 agent 辅助会话判断：
  Agent1: delay 3s + 随机12s = 15s
  Agent2: delay 3s + 随机5s = 8s   ← 先触发
  Agent3: delay 3s + 随机28s = 31s

时间线：
  T0: 消息到达
  
  T+8s: Agent2 触发
        判断：transfer
        回复："这个问题可以这样解决..."
  
  T+15s: Agent1 触发
         看到 Agent2 已回复
         判断：hold（无需重复回复）
  
  T+31s: Agent3 触发
         看到 Agent2 已回复
         判断：hold（无需重复回复）
```

### 6.3 紧急打断

```
场景：
  主会话正在处理消息 A（已处理2分钟）
  主队列：[B, C]
  
  突然：Owner: "紧急！生产环境崩了！"

辅助会话判断：
  检测到紧急关键词
  ↓
  输出：
  {
    type: 'aun-decision',
    decision: {
      action: 'transfer',
      interrupt: true,
      reason: '紧急消息，立即处理'
    }
  }
  ↓
  打断主会话
  ↓
  主队列：[B, C, D-紧急]
  ↓
  主会话重新处理批次 [B, C, D]
  （消息A仍在上下文，可以参考）
```

### 6.4 主会话反馈

```
主会话处理完批次后：
  1. 生成总结
     {
       processedMessageIds: ['msg-001', 'msg-002'],
       summary: '处理了Owner关于报错的问题',
       replies: ['这个报错是因为...']
     }
  
  2. 追加到 main-feedback.jsonl
  
  3. 通知辅助会话
  
辅助会话收到反馈：
  1. 输出 ack
     {
       type: 'feedback-ack',
       ack: { reason: '已更新上下文' }
     }
  
  2. 更新上下文（将反馈内容追加）
  
  3. 从辅助队列移除已处理消息
```

---

## 七、单聊与群聊的差异

双会话响应模式同时支持单聊和群聊场景，两者使用相同的核心机制，但有以下差异：

### 7.1 辅助会话输出类型

| 场景 | 输出类型 | 说明 |
|------|---------|------|
| **群聊** | `hold / delay / transfer` | hold: 与本 agent 无关的闲聊 |
| **单聊** | `delay / transfer` | 一对一都相关，无 hold |

### 7.2 延迟投递随机数

| 场景 | 延迟计算 | 原因 |
|------|---------|------|
| **群聊** | `delayMs + 0-60秒随机` | 避免多 agent 竞争回复 |
| **单聊** | `delayMs`（无随机数） | 无多 agent 竞争 |

### 7.3 触发条件

| 触发条件 | 群聊 | 单聊 |
|---------|------|------|
| 防抖时间 | 3 秒（可配置） | 3 秒（可配置 0-6 秒） |
| 最早消息强制触发 | 15 秒 | 15 秒 |
| **队列满强制触发** | **50 条** | **15 条** |
| 延迟投递超时 | 有 | 有 |
| **主会话空闲触发** | 无 | **有**（单聊特有） |

### 7.4 主会话空闲触发（单聊特有）

单聊场景下，当主会话从 `processing` 变为 `idle` 时，立即触发辅助队列检查并投递：

```typescript
mainSession.on('statusChange', (oldStatus, newStatus) => {
  if (oldStatus === 'processing' && newStatus === 'idle') {
    const undelivered = auxiliaryQueue.getAllUndelivered();
    if (undelivered.length > 0) {
      // 立即触发辅助会话判断
      auxiliarySession.process(undelivered, 'main-idle');
    }
  }
});
```

**效果**：
- 延迟投递（delay）在主会话空闲后立即重新判断，通常会变为 transfer
- 降低单聊场景下的响应延迟

### 7.5 辅助会话提示词

单聊和群聊使用不同的提示词 fragment（通过 ECK 的 `when` 条件加载）：
- **群聊版**：`auxiliary-base-group.md`（包含 hold / delay / transfer）
- **单聊版**：`auxiliary-base-private.md`（只有 delay / transfer）

---

## 八、与现有系统的对比

| 维度 | 传统单会话 | 双会话简化版 |
|------|-----------|-------------|
| **成本** | 所有消息进主会话 | 辅助会话预过滤 |
| **延迟** | 5-10秒 | 首条：8-13秒，后续：正常 |
| **多agent竞争** | 重复回复 | 延迟投递 + 随机数 |
| **快慢模型不对齐** | 处理过期消息 | 打断机制 |
| **架构复杂度** | 简单 | 中等 |

---

## 八、实施建议

### Phase 1：核心功能（MVP）
- ✅ 辅助队列 + 防抖触发
- ✅ 辅助会话判断（hold / delay / transfer）
- ✅ 主队列 + 批量处理
- ✅ 打断机制

### Phase 2：优化
- ✅ 延迟投递随机数
- ✅ 反馈机制
- ✅ 辅助/主会话 new 机制（带压缩）

### Phase 3：监控与调优
- 监控指标（过滤率、误判率、延迟）
- 调优提示词
- 性能优化

---

## 九、相关文档

- [架构设计](./architecture.md) - 详细的架构设计
- [消息流程](./message-flow.md) - 完整的消息处理流程
- [数据结构](./data-structures.md) - 数据结构设计
- [ECK 集成](./eck-integration.md) - 与 ECK 的集成方式
- [提示词模板](./prompts/) - 系统提示词模板
  - [辅助会话提示词](./prompts/auxiliary-base.md)
  - [主会话提示词](./prompts/main-base.md)

---

**文档版本**: 1.0 (Lite)  
**创建时间**: 2026-07-01  
**维护者**: EvolClaw 团队  
**状态**: 设计定稿，待实施
