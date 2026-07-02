# 群聊智能响应模式 (Dual-Session Response Mode)

## 文档说明

**模式名称**: Dual-Session Response Mode (双会话响应模式)  
**别名**: DSRM / Auxiliary-Main Pattern  
**版本**: 1.0  
**创建时间**: 2026-06-26  
**状态**: 设计定稿

---

## 目录

1. [概述](#一概述)
2. [核心问题](#二核心问题)
3. [设计目标](#三设计目标)
4. [整体架构](#四整体架构)
5. [核心机制](#五核心机制)
6. [详细流程](#六详细流程)
7. [关键设计细节](#七关键设计细节)
8. [与现有系统的集成](#八与现有系统的集成)
9. [性能与成本分析](#九性能与成本分析)
10. [总结](#十总结)

---

## 一、概述

### 1.1 什么是双会话响应模式

双会话响应模式（Dual-Session Response Mode）是一种针对群聊场景设计的智能响应架构。该模式通过**辅助会话**和**主会话**的协同工作，实现：

- **智能过滤** - 用便宜的模型过滤无关消息
- **成本优化** - 降低 70%+ 的 API 调用成本
- **精准响应** - 根据交互形态选择最佳策略
- **上下文优化** - 折叠无关消息，保持主会话上下文清晰

### 1.2 核心思想

```
传统模式:
  消息到达 → 直接进入主会话 → 判断是否响应 → 处理/忽略
  问题: 每条消息都消耗主力模型的 token

双会话模式:
  消息到达 → 辅助会话预判断 → 筛选 → 主会话精准处理
  优势: 大部分消息被便宜模型过滤，主力模型专注核心任务
```

### 1.3 适用场景

✅ **适用**:
- 高频群聊（每天 100+ 条消息）
- 多人讨论（5+ 人）
- 混合内容（技术讨论 + 闲聊）
- 需要成本控制

❌ **不适用**:
- 私聊（消息少，双会话开销不值得）
- Coding 模式（无渠道）
- 实时响应要求极高的场景

---

## 二、核心问题

### 2.1 群聊场景的挑战

#### 挑战 1: 消息量大，成本高

```
典型群聊场景:
  - 每天 200 条消息
  - 其中只有 20 条需要 AI 处理（10%）
  - 但传统模式下，所有 200 条都进入主会话上下文
  
成本计算:
  - 主力模型 (Opus): ¥0.15/1k tokens
  - 平均每条消息 + 上下文: 50k tokens
  - 每天成本: 200 × 50 × 0.15 = ¥1,500
  
问题: 90% 的成本花在无关消息上
```

#### 挑战 2: 上下文稀释

```
主会话看到的消息流:
  [闲聊] "今天天气真好"
  [闲聊] "是啊"
  [技术] "@AI 这个 bug 怎么解决？"  ← 重要
  [闲聊] "中午吃什么？"
  [闲聊] "去食堂"
  [技术] "@AI 还有个问题..."       ← 重要
  
问题: 重要信息被大量无关消息稀释
```

#### 挑战 3: 响应不智能

```
问题场景:
  - 用户分段输入，AI 过早响应
  - 多人讨论，AI 不知何时介入
  - 闲聊时 AI 乱插话
  - 紧急情况响应不够快
  
问题: 缺少智能的参与决策
```

#### 挑战 4: 批次合并困难

```
用户行为:
  Msg1: "我有个问题"
  Msg2: [发送截图]
  Msg3: "这个报错是什么意思？"
  
期望: 合并成一个批次处理
实际: 可能被分散处理，浪费 token
```

---

## 三、设计目标

### 3.1 功能目标

1. **智能过滤** - 自动识别需要处理的消息（准确率 > 95%）
2. **成本优化** - 降低 70%+ 的 API 成本
3. **精准响应** - 根据交互形态选择最佳策略
4. **上下文优化** - 主会话上下文保持清晰高效

### 3.2 性能目标

1. **辅助会话判断延迟** < 500ms
2. **主会话响应延迟** < 5s（正常消息）/ < 1s（紧急消息）
3. **准确率** > 95%（不误判需要处理的消息）
4. **召回率** > 98%（不漏掉需要处理的消息）

### 3.3 成本目标

```
基准（传统模式）:
  - 每月成本: ¥45,000（100 条/天 × 30 天）
  
目标（双会话模式）:
  - 辅助会话成本: ¥100/月（便宜模型）
  - 主会话成本: ¥12,000/月（只处理 30% 的消息）
  - 总成本: ¥12,100/月
  
节省: ¥32,900/月（73%）
```

---

## 四、整体架构

### 4.1 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      群聊消息流                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
            ┌───────────────────────────────┐
            │       Channel 适配器           │
            │   (AUN/飞书/微信/钉钉等)       │
            └───────────────────────────────┘
                            ↓
            ┌───────────────────────────────┐
            │      辅助队列                  │
            │  (Auxiliary Queue)            │
            │  未判断消息暂存                │
            └───────────────────────────────┘
                            ↓
    ┌────────────────────────────────────────────────┐
    │           辅助会话 (Auxiliary Session)         │
    ├────────────────────────────────────────────────┤
    │  模型: deepseek-v4-flash / haiku               │
    │  成本: ¥0.001/1k tokens                        │
    │                                                │
    │  职责:                                         │
    │  1. 交互识别 - 判断属于哪个交互                 │
    │  2. 形态识别 - 35 种交互形态                   │
    │  3. 参与意愿评估 - 5 种意愿分类                │
    │  4. 重要性评分 - 0-10 分                       │
    │  5. 策略建议 - 21 种行动策略                   │
    │  6. 折叠决策 - 是否折叠                        │
    └────────────────────────────────────────────────┘
                            ↓
                    消息标注 + 分流
                            ↓
            ┌───────────┴───────────┐
            ↓                       ↓
    ┌───────────────┐       ┌──────────────┐
    │  折叠 (L4)     │       │  主队列       │
    │  记录日志      │       │ (Main Queue)  │
    └───────────────┘       └──────────────┘
                                    ↓
                        优先级分层 (L0-L3)
                                    ↓
            ┌───────────────────────────────────┐
            │        调度层 (Scheduler)          │
            │  - 预算控制                        │
            │  - 负载均衡                        │
            │  - 规则匹配                        │
            └───────────────────────────────────┘
                                    ↓
    ┌────────────────────────────────────────────────┐
    │            主会话 (Main Session)               │
    ├────────────────────────────────────────────────┤
    │  模型: Claude Opus / Sonnet                    │
    │  成本: ¥0.15/1k tokens                         │
    │                                                │
    │  能力:                                         │
    │  1. 读取标注 - 获取辅助会话的判断              │
    │  2. 检查折叠 - 过滤不需要处理的消息            │
    │  3. 展开消息 - 按需查看折叠消息的完整内容      │
    │  4. 执行策略 - 21 种行动策略                  │
    │  5. 生成回复 - 实际响应用户                   │
    └────────────────────────────────────────────────┘
                            ↓
                        发送回复
                            ↓
            ┌───────────────────────────────┐
            │       反馈给辅助会话           │
            │  - 处理结果                   │
            │  - AI 的回复内容              │
            │  - 更新上下文                 │
            └───────────────────────────────┘
```

### 4.2 双队列架构

```
┌─────────────────────────────────────────────────────────────┐
│                        辅助队列                              │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  未判断区:                                                    │
│    [Msg1] [Msg2] [Msg3]                                      │
│                                                               │
│  判断中:                                                      │
│    [Msg4: 等待更多信息, waitUntil=10:05:30]                   │
│                                                               │
│  已判断:                                                      │
│    [Msg5: L1, 需要处理]                                      │
│    [Msg6: L4, 忽略]                                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                            ↓ 分流
            ┌───────────────┴───────────────┐
            ↓                               ↓
    ┌───────────────┐             ┌─────────────────┐
    │  忽略/记录     │             │    主队列        │
    └───────────────┘             └─────────────────┘
                                            ↓
                            ┌───────────────────────────┐
                            │   L0 (紧急)               │
                            ├───────────────────────────┤
                            │   L1 (高优先级)            │
                            ├───────────────────────────┤
                            │   L2 (正常)               │
                            ├───────────────────────────┤
                            │   L3 (低优先级/调度决定)   │
                            └───────────────────────────┘
```

### 4.3 数据流

```
[阶段 1] 消息到达
  Channel 适配器接收消息
  ↓
  生成消息 ID
  ↓
  写入 SQLite (messages 表)

[阶段 2] 辅助会话判断
  从辅助队列取消息
  ↓
  加载轻量上下文
  ↓
  调用便宜模型 (deepseek v4 flash)
  ↓
  生成判断结果
  ↓
  写入标注 (MessageAnnotationStore)

[阶段 3] 分流
  if needsMain = false:
    → 标记为 L4
    → 折叠 (如果重要性低)
    → 结束
  else:
    → 进入主队列
    → 按优先级排队

[阶段 4] 调度
  调度层评估 L3 级别消息
  ↓
  考虑预算、负载、规则
  ↓
  决定：处理 / 延迟 / 丢弃

[阶段 5] 主会话处理
  从主队列出队
  ↓
  读取标注
  ↓
  过滤不需要处理的消息
  ↓
  贪心合并批次
  ↓
  按需展开折叠的消息
  ↓
  加载完整上下文
  ↓
  调用主力模型
  ↓
  执行行动策略
  ↓
  生成并发送回复

[阶段 6] 反馈
  主会话处理结果
  ↓
  通知辅助会话
  ↓
  辅助会话更新上下文（增量）
```

---

## 五、核心机制

### 5.1 交互识别机制

**定义**: 交互是群聊中具有目标和上下文的对话流

**职责**: 辅助会话识别新交互的开始，判断消息属于哪个交互

**识别规则**:

```typescript
// 伪代码
function identifyInteraction(message: Message): string[] {
  const interactionIds: string[] = [];
  
  // 规则 1: 检查是否是现有交互的延续
  for (const int of activeInteractions) {
    if (isPartOf(message, int)) {
      interactionIds.push(int.id);
    }
  }
  
  // 规则 2: 检查是否开启新交互
  if (isNewInteractionStart(message)) {
    const newInt = createInteraction(message);
    interactionIds.push(newInt.id);
  }
  
  return interactionIds;
}

// 判断是否属于现有交互
function isPartOf(message: Message, interaction: Interaction): boolean {
  // 1. 时间窗口内
  if (message.timestamp - interaction.updatedAt > 5 * 60 * 1000) {
    return false; // 超过 5 分钟
  }
  
  // 2. 相同参与者
  if (interaction.participants.includes(message.peerId)) {
    return true;
  }
  
  // 3. 话题相关
  if (isTopicRelated(message.content, interaction.topic)) {
    return true;
  }
  
  // 4. 引用了交互中的消息
  if (message.referencedMessages.some(id => 
    interaction.messages.includes(id))) {
    return true;
  }
  
  return false;
}
```

**交互状态管理**:

```typescript
interface InteractionState {
  active: Interaction[];      // 活跃交互（< 5 分钟无新消息）
  completed: Interaction[];   // 已完成（超过 5 分钟）
  abandoned: Interaction[];   // 已放弃（无人参与）
}

// 自动清理机制
setInterval(() => {
  for (const int of activeInteractions) {
    const idle = Date.now() - int.updatedAt;
    
    if (idle > 5 * 60 * 1000) {
      // 超过 5 分钟无新消息
      if (int.messages.length === 1 && !int.aiParticipated) {
        int.status = 'abandoned'; // 无人参与
      } else {
        int.status = 'completed'; // 自然结束
      }
      
      // 折叠该交互的所有消息
      foldInteractionMessages(int.id);
    }
  }
}, 60 * 1000); // 每分钟检查一次
```

---

### 5.2 形态识别机制

**输入**: 消息 + 交互上下文  
**输出**: 交互形态标签（35 种）

**识别流程**:

```typescript
async function identifyPattern(
  message: Message,
  interaction: Interaction
): Promise<string[]> {
  const patterns: string[] = [];
  
  // 1. 快速规则匹配
  const quickMatch = quickRuleMatch(message);
  if (quickMatch) {
    patterns.push(quickMatch);
    return patterns; // 快速路径
  }
  
  // 2. 辅助会话模型判断
  const prompt = buildPatternPrompt(message, interaction);
  const result = await auxiliaryModel.call(prompt);
  const identified = parsePatternResult(result);
  
  patterns.push(...identified);
  
  return patterns;
}

// 快速规则（无需调模型）
function quickRuleMatch(message: Message): string | null {
  // 规则 1: 紧急关键词
  if (/紧急|急|崩了|挂了|救命|urgent|emergency/i.test(message.content)) {
    return 'A5'; // 紧急求助
  }
  
  // 规则 2: 明确 @AI
  if (message.isMentioned && /^@AI\s+/.test(message.content)) {
    return 'A1'; // 直接求助
  }
  
  // 规则 3: 纯表情
  if (/^[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}]+$/u.test(message.content)) {
    return 'E2'; // 情感表达
  }
  
  // 规则 4: 问候
  if (/^(大家好|早上好|你好|在吗？?)$/i.test(message.content)) {
    return 'E3'; // 打招呼
  }
  
  return null; // 需要模型判断
}
```

**提示词模板**:

```
你是群聊消息分析助手，负责识别消息的交互形态。

## 当前消息
发送者: {peerName}
内容: {content}
是否 @AI: {isMentioned}

## 交互上下文
交互 ID: {interactionId}
形态: {currentPattern}
参与者: {participants}
最近 3 条消息:
{recentMessages}

## 任务
从以下 35 种形态中识别当前消息属于哪种（可能多个）:

A 类（单人求助型）:
  A1 - 直接求助
  A2 - 分段求助
  ...

返回格式:
{
  "patterns": ["A1", "F1"],
  "confidence": 0.95,
  "reason": "用户明确 @AI 求助，且是多轮对话"
}
```

---

### 5.3 参与意愿评估机制

**5 种参与意愿**:

```typescript
enum ParticipationIntent {
  IRRELEVANT = '与我无关',      // → 静默
  UNWILLING = '不想参与',        // → 静默/观察
  INTERESTED = '有兴趣的',       // → 选择性参与
  WORKFLOW = '工作流必须处理',   // → 必须处理
  DUTY = '我的职责',            // → 必须处理
}
```

**评估规则**:

```typescript
function assessIntent(
  pattern: string,
  message: Message,
  config: AgentConfig
): ParticipationIntent {
  // 规则 1: 明确 @AI → 职责
  if (message.isMentioned) {
    return ParticipationIntent.DUTY;
  }
  
  // 规则 2: 工作流节点 → 工作流必须
  if (config.workflows.some(wf => wf.shouldHandle(message))) {
    return ParticipationIntent.WORKFLOW;
  }
  
  // 规则 3: 根据形态判断
  const formIntent = patternToIntent[pattern];
  
  // 规则 4: 考虑配置
  if (config.ignorePatterns?.includes(pattern)) {
    return ParticipationIntent.IRRELEVANT;
  }
  
  return formIntent;
}

// 形态到意愿的默认映射
const patternToIntent: Record<string, ParticipationIntent> = {
  // A 类 → 职责
  'A1': ParticipationIntent.DUTY,
  'A2': ParticipationIntent.DUTY,
  'A3': ParticipationIntent.DUTY,
  'A4': ParticipationIntent.DUTY,
  'A5': ParticipationIntent.DUTY,
  
  // B 类 → 有兴趣/不想参与
  'B1': ParticipationIntent.INTERESTED,
  'B2': ParticipationIntent.UNWILLING,
  'B3': ParticipationIntent.INTERESTED,
  'B4': ParticipationIntent.DUTY,
  'B5': ParticipationIntent.UNWILLING,
  'B6': ParticipationIntent.UNWILLING,
  'B7': ParticipationIntent.DUTY,
  
  // C 类 → 无关/有兴趣
  'C1': ParticipationIntent.IRRELEVANT,
  'C2': ParticipationIntent.INTERESTED,
  'C3': ParticipationIntent.INTERESTED,
  // ... 其他
  
  // E 类 → 无关
  'E1': ParticipationIntent.IRRELEVANT,
  'E2': ParticipationIntent.IRRELEVANT,
  'E3': ParticipationIntent.IRRELEVANT,
  'E4': ParticipationIntent.IRRELEVANT,
  'E5': ParticipationIntent.IRRELEVANT,
};
```

---

### 5.4 重要性评分机制

**评分范围**: 0-10

**评分规则**:

```typescript
function scoreImportance(
  message: Message,
  pattern: string,
  intent: ParticipationIntent
): number {
  let score = 5; // 基准分
  
  // 因素 1: 参与意愿
  if (intent === ParticipationIntent.DUTY) score += 3;
  else if (intent === ParticipationIntent.WORKFLOW) score += 3;
  else if (intent === ParticipationIntent.INTERESTED) score += 1;
  else if (intent === ParticipationIntent.UNWILLING) score -= 1;
  else if (intent === ParticipationIntent.IRRELEVANT) score -= 3;
  
  // 因素 2: 是否 @AI
  if (message.isMentioned) score += 2;
  
  // 因素 3: 形态
  if (pattern === 'A5') score = 10; // 紧急求助，最高分
  if (pattern.startsWith('A')) score += 1; // 求助类
  if (pattern.startsWith('E')) score -= 2; // 社交类
  
  // 因素 4: 发送者
  if (message.peerId === config.ownerId) score += 2; // Owner 的消息
  
  // 因素 5: 内容长度
  if (message.content.length > 500) score += 1; // 长文本
  if (message.content.length < 10) score -= 1; // 短文本
  
  // 因素 6: 附件
  if (message.attachments.length > 0) score += 1;
  
  // 限制在 0-10 范围内
  return Math.max(0, Math.min(10, score));
}
```

---

### 5.5 折叠决策机制

**折叠条件**:

```typescript
function shouldFold(
  message: Message,
  importance: number,
  intent: ParticipationIntent
): boolean {
  // 条件 1: 重要性过低
  if (importance <= 2) return true;
  
  // 条件 2: 与 AI 无关
  if (intent === ParticipationIntent.IRRELEVANT) return true;
  
  // 条件 3: 不想参与且重要性一般
  if (intent === ParticipationIntent.UNWILLING && importance <= 4) {
    return true;
  }
  
  // 条件 4: 纯社交互动
  if (message.patternTags.every(p => p.startsWith('E'))) {
    return true;
  }
  
  // 条件 5: 历史消息（交互已完成）
  if (message.interactionIds.every(id => 
    getInteraction(id).status === 'completed')) {
    return true;
  }
  
  return false;
}
```

**折叠粒度**:

```typescript
// 级别 1: 单条折叠
if (message.content.length > 5000) {
  fold(message.id, { 
    summary: message.content.slice(0, 200) + '...' 
  });
}

// 级别 2: 批量折叠（同一交互）
if (interaction.status === 'completed' && 
    interaction.messages.every(m => m.importance <= 3)) {
  foldInteraction(interaction.id, {
    summary: generateInteractionSummary(interaction)
  });
}

// 级别 3: 时间段折叠
const lowImportanceMessages = getMessagesInTimeRange(
  '10:00', '10:30'
).filter(m => m.importance <= 2);

if (lowImportanceMessages.length >= 10) {
  foldTimeRange('10:00', '10:30', {
    summary: `${lowImportanceMessages.length} 条闲聊消息`
  });
}
```

---


## 八、与现有系统的集成

### 8.1 与响应模式系统集成

```typescript
// 新增响应模式：DualSessionMode
class DualSessionMode implements ResponseMode {
  id = 'dual-session';
  name = 'Dual Session (群聊双会话)';
  
  private auxiliaryLayer: AuxiliaryLayer;
  
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 1. 辅助会话判断
    const decision = await this.auxiliaryLayer.judge(message);
    
    // 2. 返回决策
    return {
      shouldProcess: decision.needsMain,
      priority: decision.priority,
      batchWith: decision.batchWith,
      runtimeState: {
        auxiliaryDecision: decision,
        importance: decision.importance,
        folded: decision.folded,
      },
    };
  }
  
  // 配置自定义队列策略
  configureQueue(): QueueStrategy {
    return new DualSessionQueueStrategy();
  }
}

// 注册到响应模式 Registry
registry.register(new DualSessionMode());
```

### 8.2 与消息队列集成

```typescript
// 扩展 MessageQueue 支持双队列
class MessageQueue {
  // 辅助队列
  private auxiliaryQueue: Map<string, AuxiliaryQueueItem[]>;
  
  // 主队列（现有）
  private mainQueue: Map<string, QueueItem[]>;
  
  async enqueue(message: Message, mode: ResponseMode): Promise<void> {
    // 1. 先进入辅助队列
    if (mode instanceof DualSessionMode) {
      await this.enqueueAuxiliary(message);
      return;
    }
    
    // 2. 其他模式直接进主队列
    await this.enqueueMain(message);
  }
  
  private async enqueueAuxiliary(message: Message): Promise<void> {
    const sessionKey = this.getSessionKey(message);
    const queue = this.auxiliaryQueue.get(sessionKey) || [];
    
    queue.push({
      message,
      status: 'pending',
      enqueueAt: Date.now(),
    });
    
    this.auxiliaryQueue.set(sessionKey, queue);
    
    // 触发辅助会话处理
    await this.processAuxiliary(sessionKey);
  }
}
```

### 8.3 与 ECK 集成

```typescript
// 扩展 ECK vars，标识会话类型
interface ECKVars {
  // ... 现有字段
  
  // 新增字段
  sessionType: 'main' | 'auxiliary';
  isAuxiliarySession: boolean;
  
  // 辅助会话特定
  auxiliaryModel?: string;
  auxiliaryMode?: boolean;
}

// 辅助会话加载精简的 ECK
function buildAuxiliaryContext(vars: ECKVars): string {
  return `
你是群聊消息分析助手（辅助会话）。

职责：
1. 判断消息属于哪个交互
2. 识别交互形态（35 种）
3. 评估 AI 的参与意愿
4. 评分消息重要性
5. 建议行动策略

不需要：
- 实际回复用户
- 执行工具
- 生成长文本

当前配置：
  模型: ${vars.auxiliaryModel}
  AID: ${vars.selfAid}
  群组: ${vars.venueId}
`;
}
```

### 8.4 数据流集成

```
[现有系统]                    [新增组件]

Channel 适配器
    ↓
Response Engine  ──────→  Auxiliary Layer
    ↓                         ↓
MessageQueue    ←─────────  判断结果
    ↓                         ↓
(处理流程)                Message Annotation Store
    ↓                         ↓
Session Manager            SQLite (messages 表)
    ↓
Base Agent
```

---

## 九、性能与成本分析

### 9.1 性能指标

#### 延迟分析

```
传统模式:
  消息到达 → 进入主会话 → 处理 → 回复
  平均延迟: 5-10s

双会话模式:
  消息到达 → 辅助会话判断(0.5s) → 分流
    ├─ 不需要处理: 0.5s（结束）
    └─ 需要处理: 0.5s + 5-10s = 5.5-10.5s

结论: 
  - 需要处理的消息略微增加 0.5s（可接受）
  - 不需要处理的消息节省 9.5s（大幅优化）
```

#### 吞吐量分析

```
假设场景: 群聊每分钟 10 条消息

传统模式:
  10 条/分钟 × 10s/条 = 100s
  吞吐量: 6 条/分钟（串行处理）

双会话模式:
  辅助会话: 10 条/分钟 × 0.5s/条 = 5s（并行）
  主会话: 3 条/分钟（30% 需要处理）× 10s/条 = 30s
  
  总时间: max(5s, 30s) = 30s（并行）
  吞吐量: 10 条/分钟（提升 67%）
```

### 9.2 成本分析

#### 详细成本计算

```
场景: 100 人群聊，每天 200 条消息，30 天

[传统模式]
  主力模型: Claude Opus
  价格: ¥0.15/1k tokens
  
  每条消息成本:
    - 消息内容: 500 tokens
    - 上下文: 50k tokens
    - 总计: 50.5k tokens
    - 成本: 50.5 × 0.15 = ¥7.58
  
  每天成本: 200 × 7.58 = ¥1,516
  每月成本: 1,516 × 30 = ¥45,480

[双会话模式]
  辅助会话:
    模型: deepseek-v4-flash
    价格: ¥0.001/1k tokens
    
    每条消息成本:
      - 消息内容: 500 tokens
      - 轻量上下文: 5k tokens
      - 判断输出: 200 tokens
      - 总计: 5.7k tokens
      - 成本: 5.7 × 0.001 = ¥0.0057
    
    每天成本: 200 × 0.0057 = ¥1.14
    每月成本: 1.14 × 30 = ¥34.2
  
  主会话:
    需要处理: 200 × 30% = 60 条/天
    
    每条消息成本: ¥7.58（同传统模式）
    
    每天成本: 60 × 7.58 = ¥454.8
    每月成本: 454.8 × 30 = ¥13,644
  
  总成本: ¥34.2 + ¥13,644 = ¥13,678.2

节省: ¥45,480 - ¥13,678.2 = ¥31,801.8 (70%)
```

#### 不同过滤率的成本对比

```
过滤率 | 主会话处理 | 月成本(¥) | 节省率
─────────────────────────────────────
  0%   |   200条   |  45,480   |   0%
 20%   |   160条   |  37,028   |  19%
 40%   |   120条   |  28,576   |  37%
 60%   |    80条   |  20,124   |  56%
 70%   |    60条   |  13,678   |  70%  ← 目标
 80%   |    40条   |  11,226   |  75%
 90%   |    20条   |   8,774   |  81%
```

### 9.3 资源消耗

#### 内存消耗

```
[辅助会话]
  上下文: 5k tokens ≈ 20 KB
  活跃交互: 10 × 1 KB = 10 KB
  总计: 约 30 KB/会话

[主会话]
  上下文: 50k tokens ≈ 200 KB
  折叠消息索引: 50 KB
  总计: 约 250 KB/会话

结论: 双会话模式增加 10% 内存消耗（可接受）
```

#### 数据库存储

```
[新增表]
  messages: 
    - 每条消息: 约 2 KB
    - 200 条/天 × 30 天 = 6000 条
    - 存储: 6000 × 2 KB = 12 MB/月
  
  interactions:
    - 每个交互: 约 1 KB
    - 50 个/天 × 30 天 = 1500 个
    - 存储: 1500 × 1 KB = 1.5 MB/月
  
  总计: 约 13.5 MB/月（可忽略）
```

---

## 十、总结

### 10.1 核心优势

1. **成本优化** ✅
   - 节省 70% 的 API 成本
   - 用便宜模型过滤 70% 的无关消息

2. **智能响应** ✅
   - 35 种交互形态精准识别
   - 21 种行动策略精准执行
   - 5 种参与意愿智能评估

3. **上下文优化** ✅
   - 折叠无关消息
   - 主会话上下文清晰高效
   - 按需展开查看完整内容

4. **性能提升** ✅
   - 辅助会话判断 < 500ms
   - 并行处理提升吞吐量 67%
   - 不影响需要处理的消息延迟

### 10.2 关键创新

1. **四层模型** - 消息 → 交互 → 形态 → 策略
2. **双队列架构** - 辅助队列 + 主队列
3. **双会话协同** - 辅助会话判断 + 主会话执行
4. **消息折叠** - 优化 token，保持上下文清晰
5. **参与意愿** - 5 种分类，智能决策

### 10.3 适用性评估

#### ✅ 强烈推荐

- 高频群聊（100+ 条/天）
- 多人群组（5+ 人）
- 混合内容（技术 + 社交）
- 成本敏感场景

#### ⚠️ 谨慎使用

- 中频群聊（20-100 条/天）
- 需要评估 ROI

#### ❌ 不推荐

- 低频群聊（< 20 条/天）
- 私聊（消息少）
- 实时性要求极高的场景

### 10.4 未来优化方向

1. **辅助会话模型优化**
   - 微调专用模型
   - 提高判断准确率到 98%+

2. **自适应过滤阈值**
   - 根据历史数据动态调整
   - 学习用户偏好

3. **多模态支持**
   - 图片、语音消息的智能判断
   - OCR + 语音识别 + 内容分析

4. **预测性调度**
   - 预测消息可能的后续
   - 提前准备上下文

5. **分布式部署**
   - 辅助会话分布式处理
   - 提升并发能力

### 10.5 实施建议

#### 阶段 1: 最小可行产品（MVP）

- 实现辅助会话基础判断
- 实现双队列架构
- 支持 5 种核心交互形态（A1, A5, B1, E1, E2）
- 支持基础折叠

#### 阶段 2: 功能完善

- 支持全部 35 种交互形态
- 实现全部 21 种行动策略
- 完整的消息折叠机制
- history 命令集

#### 阶段 3: 优化迭代

- 性能优化
- 准确率提升
- 成本进一步优化
- 用户体验优化

---

## 附录

### A. 术语表

| 术语 | 英文 | 定义 |
|------|------|------|
| 双会话响应模式 | Dual-Session Response Mode | 本文档设计的核心模式 |
| 辅助会话 | Auxiliary Session | 用便宜模型预判断的会话 |
| 主会话 | Main Session | 用主力模型实际处理的会话 |
| 交互 | Interaction | 具有目标和上下文的对话流 |
| 交互形态 | Interaction Pattern | 交互的类型（35 种） |
| 行动策略 | Action Strategy | AI 的响应方式（21 种） |
| 参与意愿 | Participation Intent | 是否应该响应（5 种） |
| 消息折叠 | Message Folding | 隐藏无关消息的机制 |

### B. 配置示例

```yaml
# 双会话响应模式配置
dual_session:
  enabled: true
  
  # 辅助会话配置
  auxiliary:
    model: deepseek-v4-flash  # 或 claude-haiku-4
    max_context_messages: 50
    judgment_timeout_ms: 500
    
  # 过滤配置
  filtering:
    importance_threshold: 3  # 低于此分数的消息折叠
    auto_fold_social: true   # 自动折叠社交消息
    
  # 预算控制
  budget:
    daily_usd: 50
    monthly_usd: 1000
    alert_threshold: 0.8  # 80% 时告警
    
  # 队列配置
  queue:
    auxiliary_queue_size: 100
    main_queue_size: 50
    wait_timeout_ms: 60000  # LW 级别等待超时
```

### C. 相关文档

- [交互形态与行动策略完整分类](./interaction-patterns-and-action-strategies.md)
- [History 命令集设计](./history-command-design.md)
- [响应模式系统架构](./response-system-architecture.md)

---

**文档版本**: 1.0  
**创建时间**: 2026-06-26  
**维护者**: EvolClaw 团队  
**状态**: 设计定稿，待实施

