# 双会话响应模式 - 架构设计文档

## 文档说明

**版本**: 2.0  
**创建时间**: 2026-06-28  
**最后更新**: 2026-06-28  
**状态**: 核心框架完成

---

## 一、概述

### 1.1 什么是双会话响应模式？

双会话响应模式（Dual-Session Mode）是 EvolClaw 的核心响应模式，**适用于单聊和群聊场景**，通过**辅助会话**（便宜模型）和**主会话**（主力模型）的配合，实现智能、高效、低成本的消息响应。

```
核心思想：
  辅助会话理解和预判 → 主会话精准响应
  
应用场景：
  ✅ 群聊：过滤无关消息、判断参与时机、理解复杂上下文
  ✅ 单聊：预处理消息、路由简单/复杂问题、成本优化
  
优势：
  ✅ 成本优化：辅助会话过滤 70%+ 无效消息
  ✅ 上下文理解：基于交互本体论深度理解
  ✅ 灵活响应：提示词驱动，非固定规则
  ✅ 自我进化：系统可以自我优化形态和策略
  ✅ 知识沉淀：交互存储，可检索可引用
```

### 1.2 设计理念

```
重点不是"设计完备的形态/策略"
重点是"建立可以自我进化的体系"

初始状态：
  - 提供初始种子（7 种核心形态 + 8 种核心策略）
  - 定义清晰的维度和属性框架
  - 建立映射关系

自我进化：
  - 每日评估和总结
  - 发现新场景，新增形态/策略
  - 优化映射关系
  - 支持关系级定制
```

---

## 二、系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    AUN 消息到达                              │
└────────────────────────┬────────────────────────────────────┘
                         ↓
        ┌────────────────────────────────┐
        │   辅助会话消息队列              │
        │   Auxiliary Message Queue      │
        │                                │
        │   触发条件:                    │
        │   - 延迟 3 秒                  │
        │   - 最长等待 15 秒             │
        │   - 紧急关键词立即触发          │
        │   - 队列满（50 条）            │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   辅助会话 (Auxiliary Session) │
        │   便宜模型 (DeepSeek/Haiku)    │
        │                                │
        │   职责:                        │
        │   1. 交互形态判断（客观）      │
        │   2. 主会话模型选择 ⭐         │
        │   3. 消息预处理                │
        └────────────┬───────────────────┘
                     ↓
            输出结构化 JSON
                     ↓ 代码层面解析并操作
        ┌────────────────────────────────┐
        │   主会话消息队列                │
        │   Main Message Queue           │
        │                                │
        │   特性:                        │
        │   - 优先级队列                 │
        │   - 支持打断                   │
        │   - 可被辅助会话操作            │
        └────────────┬───────────────────┘
                     ↓
        ┌────────────────────────────────┐
        │   主会话 (Main Session)        │
        │   主力模型 (Claude Opus/GPT-4) │
        │                                │
        │   职责:                        │
        │   1. 读取交互类型              │
        │   2. 查询策略映射表            │
        │   3. 决策最终策略              │
        │   4. 按需加载策略文件          │
        │   5. 执行策略并回复            │
        │   6. 记录效果（自我进化）      │
        └────────────┬───────────────────┘
                     ↓
              反馈给辅助会话
                     ↓
                渠道发送消息
```

---

## 三、核心机制

### 3.1 ECK Vars 参数体系

#### 会话级参数（固定）

```yaml
# 响应模式标识
responseMode: 'dual-session'

# 会话类型
sessionType: 'auxiliary' | 'main'

# 目录路径
responseModeDir: '$KITS/docs/response-system/双会话响应模式'
promptsDir: '$responseModeDir/prompts'
```

#### 消息级参数（动态，辅助→主）

```typescript
interface MessageLevelECKVars {
  // 交互信息
  interactionId: string;           // 交互 ID
  interactionType: string;         // 交互类型（如 A1, B1）
  
  // 维度和属性
  dimensions: {...};
  attributes: {...};
  
  // 参与判断
  participationIntent: string;     // 参与意愿
  importance: number;              // 重要性 0-10
  
  // 模型选择
  targetModel: string;             // 主会话模型（如 claude-opus）
  
  // 消息处理
  messageProcessing?: {...};       // 预处理结果（可选）
}
```

**重要**：
- ❌ 没有 `actionStrategy` 字段
- ✅ 只有 `interactionType`（辅助会话的客观判断）
- ✅ 策略决策由主会话完成

---

### 3.2 系统提示词渲染层

#### 渲染规则（Context Assembly）

```yaml
# 辅助会话提示词加载
- id: auxiliary-base
  when: "responseMode === 'dual-session' && sessionType === 'auxiliary'"
  source:
    type: file
    path: "{{promptsDir}}/auxiliary/base.md"
  priority: 100

- id: auxiliary-interaction-understanding
  when: "responseMode === 'dual-session' && sessionType === 'auxiliary'"
  source:
    type: file
    path: "{{promptsDir}}/auxiliary/interaction-understanding.md"
  priority: 101

# 主会话提示词加载
- id: main-base
  when: "responseMode === 'dual-session' && sessionType === 'main'"
  source:
    type: file
    path: "{{promptsDir}}/main/base.md"
  priority: 100

# 策略提示词按需加载机制（关键！）
# 
# 系统提示词中包含策略文件路径映射，指导主会话在需要时 Read 策略文件
- id: main-strategy-index
  when: "responseMode === 'dual-session' && sessionType === 'main'"
  source:
    type: inline
    content: |
      ## 行动策略按需加载
      
      当你看到消息标注中的策略 ID（如 S2、S7 等），如果你不确定该策略的具体内容，
      请 Read 对应的策略文件。
      
      策略文件路径映射：
      - S1 → $KITS_DOCS/strategies/S1-emergency-response.md
      - S2 → $KITS_DOCS/strategies/S2-direct-answer.md
      - S3 → $KITS_DOCS/strategies/S3-guided-clarification.md
      - S6 → $KITS_DOCS/strategies/S6-wait-for-more.md
      - S7 → $KITS_DOCS/strategies/S7-observe.md
      - S8 → $KITS_DOCS/strategies/S8-timely-intervention.md
      - S11 → $KITS_DOCS/strategies/S11-smart-ignore.md
      - S12 → $KITS_DOCS/strategies/S12-selective-participation.md
      - S14 → $KITS_DOCS/strategies/S14-phased-response.md
      - fallback → $KITS_DOCS/strategies/fallback.md
      
      **加载策略**：
      - 在处理批次消息时，先识别本批次用到的策略 ID
      - Read 你不确定的策略文件（会话内记住已读的策略，不重复读取）
      - 根据策略指导执行，不要僵化套用
      
      **重要**：
      - 策略是行为模式指导，不是回复模板
      - 可以根据实际情况灵活调整
      - 可以覆盖辅助会话的建议
  priority: 200
```

**关键设计**：
- ✅ 系统提示词固定（仅策略索引和路径映射） → Cache 稳定
- ✅ 策略提示词按需加载（模型自己 Read） → Token 优化
- ✅ 会话内记忆（首次读取后记住） → 避免重复加载
- ✅ 利用模型能力判断是否需要加载 → 灵活、容错

---

### 3.3 辅助会话消息队列

#### 队列特性

```typescript
interface AuxiliaryQueue {
  messages: Message[];              // 消息列表
  maxSize: 50;                      // 最大容量
  
  // 批次触发条件
  triggers: {
    delay: 3000;                    // 延迟触发（ms）
    maxWait: 15000;                 // 最长等待（ms）
    emergencyKeywords: string[];    // 紧急关键词
  };
}
```

#### 批次处理规则

```
触发条件（满足任一即触发）:

1. 延迟触发
   - 新消息到达后延迟 3 秒
   - 如果 3 秒内又有新消息，重置延迟
   - 目的：等待连续消息（如分段输入）

2. 最长等待
   - 队列中最早的消息已等待 15 秒
   - 无论如何都触发
   - 目的：避免消息积压过久

3. 紧急触发
   - 检测到紧急关键词（"紧急"、"urgent"、"崩了"）
   - 立即触发（不等待）
   - 目的：快速响应紧急情况

4. 队列满
   - 队列消息数达到 50 条
   - 立即触发
   - 目的：防止队列溢出

批次大小:
  - 处理队列中所有消息（不限制）
  - 渲染给模型时有 token 限制（避免超长）
```

#### 消息渲染

```typescript
// 将队列中的所有消息渲染成一条 mega 提示词
function renderAuxiliaryBatch(messages: Message[]): string {
  return `
你需要处理以下 ${messages.length} 条新消息：

${messages.map((msg, idx) => `
━━━━━━━━━━━━━━━━━━━━━━
[消息 ${idx + 1}/${messages.length}]
ID: ${msg.messageId}
发送者: ${msg.peerName}
时间: ${formatTime(msg.timestamp)}
内容: ${msg.content}
${msg.attachments ? '附件: ' + msg.attachments.join(', ') : ''}
`).join('\n')}

━━━━━━━━━━━━━━━━━━━━━━

请逐条分析并决策。
`;
}
```

---

### 3.4 主会话消息队列

#### 队列特性

```typescript
interface MainQueue {
  pending: Message[];               // 待处理消息
  processing: Message | null;       // 正在处理的消息
  completed: Message[];             // 已完成消息（保留最近 20 条）
  
  // 优先级
  priority: {
    interrupt: Message[];           // 打断级（最高）
    high: Message[];               // 高优先级
    normal: Message[];             // 正常优先级
  };
  
  // 状态
  paused: boolean;                 // 是否暂停
}
```

#### 批次处理规则

```
触发条件:
  - 队列非空 && 主会话空闲 && 未暂停
  - 立即开始处理

批次模式:
  1. 取出队列中所有待处理消息（按优先级）
  2. 渲染成一条 mega 提示词
  3. 调用主会话模型
  4. 处理完成后，标记消息为已完成
  5. 检查队列，如果有新消息，重复

打断机制:
  - 辅助会话可以调用工具打断
  - 当前正在处理的消息被标记为"已中断"
  - 可选择保留到队列（稍后重试）或丢弃
```

#### 消息渲染（关键！）

```typescript
// 将队列中的所有消息渲染成一条 mega 提示词
function renderMainBatch(messages: AnnotatedMessage[]): string {
  return messages.map((msg, idx) => `
━━━━━━━━━━━━━━━━━━━━━━
[消息 ${idx + 1}/${messages.length}]

[交互标注]
交互 ID: ${msg.annotation.interactionId}
交互类型: ${msg.annotation.interactionType}
参与意愿: ${msg.annotation.participationIntent}
重要性: ${msg.annotation.importance}/10

维度:
  - 参与者结构: ${msg.annotation.dimensions.participantStructure}
  - 交互意图: ${msg.annotation.dimensions.intent}
  - 时间模式: ${msg.annotation.dimensions.timePattern}
  - 结构化程度: ${msg.annotation.dimensions.structureLevel}
  - 上下文依赖性: ${msg.annotation.dimensions.contextDependency}

属性:
  - 紧急程度: ${msg.annotation.attributes.urgency}
  - 情绪基调: ${msg.annotation.attributes.emotionalTone.join(', ')}
  - 信息完整性: ${msg.annotation.attributes.informationCompleteness}
  - AI 相关性: ${msg.annotation.attributes.aiRelevance}

判断理由:
  ${msg.annotation.reason}

[消息内容]
${msg.content}

${msg.referencedMessages ? '[引用消息: ' + msg.referencedMessages.join(', ') + ']' : ''}

`).join('\n\n');
}

// 注意：
// - 策略提示词由主会话模型自己按需 Read（系统提示词中已有路径映射）
// - 不在这里硬编码加载，减少代码复杂度，提高容错率
// - 模型会话内会记住已读策略，不会重复加载
```

---

### 3.5 消息队列操作工具集

#### 辅助会话可用工具

```bash
# ========================================
# 查看主会话状态
# ========================================
ec queue-main status
# 输出：
#   状态: running / paused
#   当前处理: msg-123 (进行中)
#   待处理: 3 条
#   已完成: 15 条

# ========================================
# 查看消息队列
# ========================================

# 查看待处理消息
ec queue-main list --type pending --limit 10

# 查看正在处理的消息
ec queue-main list --type processing

# 查看已完成消息
ec queue-main list --type completed --limit 5

# ========================================
# 插入消息到主会话队列
# ========================================

# 正常插入
ec queue-main insert <message-json> --priority normal

# 高优先级插入
ec queue-main insert <message-json> --priority high

# 打断当前任务
ec queue-main insert <message-json> --interrupt

# 打断并清空待处理队列
ec queue-main insert <message-json> --interrupt --clear-pending

# ========================================
# 删除消息
# ========================================

# 删除指定消息
ec queue-main delete <message-id>

# 清空待处理队列
ec queue-main clear --type pending

# ========================================
# 控制主会话
# ========================================

# 暂停主会话
ec queue-main pause

# 恢复主会话
ec queue-main resume

# 跳过当前消息
ec queue-main skip
```

#### 主会话可用工具

```bash
# ========================================
# 查看原始消息
# ========================================

# 获取单条消息
ec history get <message-id>

# 获取多条消息
ec history get --ids <id1,id2,id3>

# 列出消息
ec history list --from "1h ago" --limit 50

# ========================================
# 查看交互
# ========================================

# 获取交互详情
ec interaction get <interaction-id>

# 列出交互
ec interaction list --active
ec interaction list --status completed --limit 10

# 获取交互的消息
ec interaction messages <interaction-id> --limit 10

# ========================================
# 引用消息
# ========================================

# 生成消息引用（用于回复时引用）
ec message-ref <message-id>
# 输出: [引用 msg-123: "原消息内容..."]
```

---

## 四、完整工作流程

### 4.1 消息处理流程

```
[步骤 1] AUN 消息到达
  ↓
  消息进入辅助会话消息队列
  ↓
  触发条件检查
    - 延迟 3 秒？
    - 最长等待 15 秒？
    - 紧急关键词？
    - 队列满？
  ↓
[步骤 2] 辅助会话批次处理
  ↓
  加载系统提示词:
    - auxiliary/base.md
    - auxiliary/interaction-understanding.md
    - auxiliary/participation-decision.md
  ↓
  渲染用户消息:
    - 队列中所有消息（循环渲染）
  ↓
  调用辅助会话模型
  ↓
  输出决策:
    - 每条消息的标注（维度、属性、策略等）
    - 重写后的消息（可选）
    - 操作指令（插入/删除/控制主队列）
  ↓
[步骤 3] 调用工具操作主队列
  ↓
  if 需要主会话处理:
    调用 ec queue-main insert
  else:
    记录为已忽略/已折叠
  ↓
[步骤 4] 主会话批次处理
  ↓
  检查队列:
    - 队列非空？
    - 主会话空闲？
    - 未暂停？
  ↓
  加载系统提示词（固定）:
    - main/base.md (仅索引，Cache 稳定)
  ↓
  渲染用户消息（动态）:
    - 每条消息的标注
    - 按需加载的策略指南 ← 关键！
    - 消息内容
  ↓
  调用主会话模型
  ↓
  生成回复
  ↓
[步骤 5] 反馈给辅助会话
  ↓
  通知辅助会话:
    - 处理了哪些消息
    - 回复内容
    - 处理结果（成功/失败）
  ↓
  辅助会话更新:
    - 交互状态
    - 上下文记录
  ↓
[步骤 6] 渠道发送
  ↓
  发送回复消息
```

---

### 4.2 示例场景

#### 场景 1: 用户求助

```
[T1] AUN 消息到达
  内容: "@AI 这个报错怎么解决？"
  ↓
[T2] 进入辅助队列，等待 3 秒
  ↓
[T3] 触发辅助会话处理
  ↓
  辅助会话判断:
    interactionType: "A1"
    actionStrategy: "S2"
    participationIntent: "我的职责"
    importance: 8
    folded: false
  ↓
  调用工具:
    ec queue-main insert {
      originalMessageId: "msg-123",
      annotation: {...},
      content: "@AI 这个报错怎么解决？",
      priority: "normal"
    }
  ↓
[T4] 主队列收到消息，触发主会话
  ↓
  加载系统提示词（固定，Cache 命中）
  ↓
  渲染用户消息（动态）:
    - 标注（A1, S2, ...）
    - 策略指南（按需加载 S2-direct-answer.md）
    - 消息内容
  ↓
  主会话执行:
    "标注建议用 S2 直接回答，问题清晰，我直接回答"
  ↓
  生成回复:
    "这个报错是因为..."
  ↓
[T5] 反馈给辅助会话
  更新交互状态: completed
  ↓
[T6] 渠道发送
```

#### 场景 2: 技术讨论（观察）

```
[T1] 多条消息陆续到达
  A: "React 和 Vue 哪个好？"
  B: "我觉得 React"
  C: "Vue 更简单"
  ↓
[T2] 进入辅助队列，等待
  ↓
[T3] 触发辅助会话处理（3 条消息批次）
  ↓
  辅助会话判断:
    interactionType: "B1"
    actionStrategy: "S7"  (观察讨论)
    participationIntent: "有兴趣的"
    importance: 4
    folded: false
  ↓
  决策: 暂不插入主队列，观察
  ↓
  不调用 ec queue-main insert
  ↓
[结束] 主会话未被触发，AI 保持静默
```

#### 场景 3: 紧急插入

```
[T1] 正常讨论中
  主会话正在处理某个问题
  ↓
[T2] 紧急消息到达
  内容: "紧急！生产环境崩了！"
  ↓
[T3] 立即触发辅助会话（紧急关键词）
  ↓
  辅助会话判断:
    interactionType: "A5"
    actionStrategy: "S1"  (紧急响应)
    urgency: "紧急"
  ↓
  调用工具:
    ec queue-main insert <message> --interrupt
  ↓
[T4] 主会话被打断
  当前任务标记为"已中断"
  立即处理紧急消息
  ↓
  加载策略指南: S1-emergency-response.md
  ↓
  快速响应
```

---

## 五、交互与消息管理

### 5.1 交互状态管理

#### 交互的生命周期

```
辅助会话职责:
  1. 创建交互
     - 识别新交互的开始
     - 分配 interactionId
     - 记录起点消息
  
  2. 维护交互
     - 关联新消息到交互
     - 更新交互属性（动态）
     - 追踪交互演进
  
  3. 关闭交互
     - 判断交互终止
     - 标记状态（completed/abandoned）
     - 记录终点消息

主会话职责:
  - 查询交互信息（只读）
  - 引用交互中的消息
  - 不修改交互状态
```

#### 交互存储

```
位置: $AGENT_DIR/relations/<channel>#<peerId>/interactions/

结构:
  ├── messages.db           # SQLite 数据库
  │   ├── messages 表       # 所有消息
  │   └── interactions 表   # 所有交互
  ├── index.json            # 交互索引
  └── archives/             # 归档的交互
      ├── int-001-技术讨论.md
      └── int-002-紧急求助.md
```

---

### 5.2 消息引用机制

#### 引用格式

```
主会话回复时引用:
  [引用 msg-123: "这个报错怎么解决？"]
  
  针对这个问题，解决方案是...

辅助会话插入消息时引用:
  {
    originalMessageId: "msg-456",
    referencedMessageIds: ["msg-123", "msg-124"],
    content: "..."
  }
```

#### 引用查询

```bash
# 主会话使用工具查询被引用的消息
ec history get msg-123

# 获取交互中的所有消息
ec interaction messages int-001
```

---

## 六、性能优化

### 6.1 Cache 优化（核心）

```
系统提示词:
  - 固定内容（仅策略索引）
  - Cache 完全稳定 ✅
  - 每次 API 调用都命中 Cache

策略提示词:
  - 按需加载
  - 作为用户消息注入
  - 不影响系统提示词的 Cache

结果:
  - Cache 命中率 100%
  - Token 成本大幅降低
```

### 6.2 策略文件缓存

```typescript
// 策略文件 LRU 缓存
const strategyCache = new LRUCache<string, string>({
  max: 50,              // 缓存 50 个策略文件
  ttl: 3600 * 1000,     // 1 小时过期
});

// 预加载热门策略
const HOT_STRATEGIES = ['S1', 'S2', 'S7', 'S11'];
await Promise.all(
  HOT_STRATEGIES.map(id => loadStrategy(id))
);
```

### 6.3 批次处理优化

```
辅助会话:
  - 批次处理减少 API 调用次数
  - 延迟等待减少碎片化

主会话:
  - 批次处理提高吞吐量
  - 一次性处理多条消息
```

---

## 七、监控与调试

### 7.1 日志系统

```typescript
// 关键节点日志
logger.info('[Auxiliary] Batch triggered', {
  trigger: 'delay' | 'maxWait' | 'emergency' | 'full',
  messageCount: 5,
  queueSize: 5,
});

logger.info('[Auxiliary] Decision made', {
  messageId: 'msg-123',
  interactionType: 'A1',
  actionStrategy: 'S2',
  participationIntent: '我的职责',
  needsMain: true,
});

logger.info('[Main] Processing batch', {
  messageCount: 3,
  strategies: ['S2', 'S7', 'S2'],
});

logger.info('[Main] Completed', {
  messageId: 'msg-123',
  success: true,
  duration: 2.5,
});
```

### 7.2 监控指标

```
辅助会话:
  - 批次触发频率
  - 平均批次大小
  - 判断耗时
  - 插入主队列比例

主会话:
  - 队列长度
  - 处理延迟
  - Cache 命中率
  - 策略分布

整体:
  - 消息吞吐量
  - 端到端延迟
  - 成本统计
```

---

## 八、辅助会话功能边界

### 8.1 严格限制

#### 输入边界

```
✅ 允许的输入:
  - 来自 AUN 的原始消息
  - 历史交互信息（只读）
  - 历史消息（只读）

❌ 禁止的输入:
  - 敏感配置文件
  - 其他关系的数据
  - 系统级配置
```

#### 输出边界（关键）

```
✅ 唯一的输出:
  结构化决策 JSON（由代码层面处理）

❌ 绝对禁止:
  - 直接回复对端
  - 发送消息到渠道
  - 调用对外 API
  - 写入任何文件
```

**核心原则**: 辅助会话**永远不直接与对端交互**！

---

### 8.2 工具和权限

#### 只读工具（白名单）

```bash
✅ 允许的工具:
  - ec history get <message-id>          # 读取历史消息
  - ec interaction get <interaction-id>  # 读取交互信息
  - ec history list --limit 10           # 查询消息列表

❌ 禁止的工具:
  - 任何写操作（ec history create/update/delete）
  - 任何文件操作（read/write/edit）
  - 任何外部 API 调用
  - 任何消息发送操作
```

#### 特殊权限：多模态模型调用

```
✅ 允许调用（仅限预处理）:
  - OCR 模型（提取图片文字）
  - 视觉理解模型（理解图片内容）
  - 语音转文字模型

目的: 预处理多模态消息，提取信息
限制: 不能用于生成对端回复
```

---

### 8.3 核心职责（明确）

辅助会话有且仅有**四大职责**：

#### 1. 交互形态判断

```
任务:
  - 基于维度和属性识别交互形态
  - 创建/更新交互记录
  - 关联消息到交互

输出:
  {
    "interactionId": "int-456",
    "interactionType": "A1-直接求助",
    "dimensions": {...},
    "attributes": {...}
  }
```

#### 2. 行动策略选择

```
任务:
  - 基于形态和属性推导策略
  - 评估重要性
  - 判断参与意愿

输出:
  {
    "actionStrategy": "S2-direct-answer",
    "participationIntent": "我的职责",
    "importance": 8
  }
```

#### 3. 主会话模型选择 ⭐

```
任务:
  - 根据任务类型选择主会话使用的模型

输出:
  {
    "targetModel": "claude-opus" | "gpt-4-vision" | "whisper" | "claude-sonnet",
    "reason": "需要处理图片，选择视觉模型"
  }

场景:
  - 纯文本任务 → claude-opus（默认）
  - 需要视觉理解 → gpt-4-vision
  - 需要语音处理 → whisper
  - 简单任务 → claude-sonnet（便宜）
```

#### 4. 消息预处理（可选）

```
任务:
  - 多模态内容提取（图片、文件、视频）
  - 信息补全和拼接（分段消息）
  - 消息重写和结构化

输出:
  {
    "messageProcessing": {
      "type": "multimodal",
      "multimodalResults": [{
        "type": "image",
        "extracted": "[OCR提取的文字]"
      }]
    },
    "rewrittenContent": "[重写后的消息]"
  }
```

---

### 8.4 辅助会话输出格式（完整）

```typescript
interface AuxiliaryOutput {
  // 批次处理结果
  decisions: AuxiliaryDecision[];
}

interface AuxiliaryDecision {
  // 原始消息
  originalMessageId: string;
  
  // 交互识别
  interactionId: string;
  interactionType: string;        // "A1", "B1", etc.
  
  // 维度和属性
  dimensions: {...};
  attributes: {...};
  
  // 行动策略
  actionStrategy: string;         // "S2", "S7", etc.
  participationIntent: string;    // "我的职责", "与我无关", etc.
  importance: number;             // 0-10
  
  // 主会话模型选择
  targetModel?: string;           // "claude-opus", "gpt-4-vision", etc.
  
  // 行动决策（三选一）
  action: 'insert' | 'fold' | 'ignore';
  
  // 如果 action = 'insert'（插入主队列）
  queueOptions?: {
    priority: 'normal' | 'high' | 'interrupt';
    interrupt: boolean;           // 是否打断当前任务
    clearPending: boolean;        // 是否清空待处理队列
  };
  
  // 如果 action = 'fold'（折叠）
  foldOptions?: {
    summary: string;              // 折叠摘要
    observing: boolean;           // 是否观察中（可能后续参与）
  };
  
  // 消息预处理（可选）
  messageProcessing?: {
    type: 'rewrite' | 'multimodal' | 'merge';
    rewrittenContent?: string;
    multimodalResults?: {
      type: 'image' | 'file' | 'video';
      extracted: string;
    }[];
    mergedMessages?: string[];    // 合并的消息 ID
  };
  
  // 推理说明
  reason: string;
}
```

**关键**: 这是结构化 JSON，不是工具调用！代码层面直接解析和执行。

---

### 8.5 主会话对比（清晰边界）

| 维度 | 辅助会话 | 主会话 |
|------|---------|--------|
| **输入** | AUN 消息 | 主队列消息 + 标注 |
| **输出** | 结构化 JSON | 对端回复消息 |
| **工具权限** | 只读历史 | 完整工具集 |
| **模型** | 便宜模型 | 主力/多模态模型 |
| **职责** | 判断+选择+预处理 | 执行+回复+交互 |
| **对端交互** | ❌ 绝不 | ✅ 是的 |

---

## 九、自我进化机制

### 9.1 设计理念

```
核心思想:
  不追求初始完备，而是建立可以自我优化的体系

重点:
  ✅ 提供合理的初始种子（10-15 种核心形态和策略）
  ✅ 建立进化框架和机制
  ✅ 让系统在实践中发现和完善
  ✅ 支持关系级定制（每个群/人可以有自己的优化）
```

---

### 9.2 每日优化流程

```
┌─────────────────────────────────────────────────────────────┐
│                    每日优化循环                              │
└─────────────────────────────────────────────────────────────┘

[步骤 1] 数据收集
  - 今天处理了多少消息？
  - 哪些交互形态出现频率最高？
  - 哪些策略被使用？
  - 哪些决策被主会话覆盖？（说明辅助会话判断不准）
  - 是否有无法分类的交互？
  ↓
[步骤 2] 问题识别
  - 无法分类的交互 → 需要新增形态
  - 策略效果不好 → 需要调整策略
  - 频繁被覆盖 → 映射关系需要优化
  - 某些形态从未出现 → 可能定义过细
  ↓
[步骤 3] 方案生成
  - 提出调整建议（修改提示词）
  - 提出新增形态/策略
  - 提出映射关系优化
  - 生成具体的 diff
  ↓
[步骤 4] 实施更新
  - 更新提示词文件
  - 更新映射表
  - 记录变更历史
  - A/B 测试（可选）
  ↓
[步骤 5] 效果评估
  - 观察第二天的数据
  - 判断优化是否有效
  - 决定保留或回滚
```

---

### 9.3 存储结构

```
$AGENT_DIR/relations/<channel>#<peerId>/response-optimization/
├── daily-summary/                    # 每日总结
│   ├── 2026-06-28.md
│   ├── 2026-06-29.md
│   └── ...
├── pattern-evolution.jsonl           # 形态演进记录
├── strategy-evolution.jsonl          # 策略演进记录
├── mapping-evolution.jsonl           # 映射关系演进记录
└── custom-prompts/                   # 关系级定制提示词
    ├── patterns/
    │   ├── P1-custom-pattern.md      # 新增的形态定义
    │   └── A1-override.md            # 覆盖默认的 A1 定义
    └── strategies/
        ├── S100-custom-strategy.md   # 新增的策略
        └── S2-override.md            # 覆盖默认的 S2 策略
```

---

### 9.4 进化示例

#### 示例 1: 发现新形态

```
[观察]
连续 3 天出现类似场景:
  - 用户发送一个链接
  - 无其他说明
  - 期待 AI 阅读并总结

当前分类:
  - 被误判为 D5 (资源分享)
  - 实际上是 A1 (求助) 的变体
  - 策略选择不当（S11 忽略 vs 应该 S2 回答）

[方案]
新增形态: A6 (链接求助)
  维度:
    - 参与者结构: 单人→群
    - 交互意图: 信息获取
    - 信息完整性: 不完整-需要抓取
  
  策略: S2-direct-answer（带链接抓取预处理）

[实施]
创建文件:
  custom-prompts/patterns/A6-link-help.md
  custom-prompts/strategies/S2-with-fetch.md

[效果]
第二天正确识别 5 次，效果良好，保留
```

#### 示例 2: 优化映射关系

```
[观察]
B1 (技术讨论) 的处理效果不好:
  - 80% 的情况选择 S7 (观察)
  - 但实际上有 50% 应该 S8 (介入)
  - 主会话频繁覆盖决策

[分析]
当前映射:
  B1 → S7 (主策略)

问题:
  缺少条件判断

[方案]
优化映射:
  B1 → 
    if participationActivity = "低活跃" && aiRelevance = "强相关":
      S8 (介入)
    else:
      S7 (观察)

[实施]
更新 mapping-evolution.jsonl

[效果]
第二天覆盖率从 50% 降到 20%，效果改善
```

---

### 9.5 关系级定制

```
全局默认:
  $KITS/docs/response-system/dual-session-mode/prompts/

关系级覆盖:
  $AGENT_DIR/relations/<channel>#<peerId>/response-optimization/custom-prompts/

加载顺序:
  1. 先加载全局默认
  2. 如果存在关系级定制，覆盖
  3. 关系级可以新增形态/策略，也可以覆盖默认

优势:
  - 每个群/人可以有自己的特化
  - 不影响其他关系
  - 可以回退到全局默认
```

---

## 十、后续文档

### 设计文档
- [design/01-interaction-ontology.md](design/01-interaction-ontology.md) - 交互本体论（5维度+10属性）
- [design/02-self-evolution-mechanism.md](design/02-self-evolution-mechanism.md) - 自我进化机制详解 ⭐
- [design/03-auxiliary-session-boundary.md](design/03-auxiliary-session-boundary.md) - 辅助会话边界详解 ⭐
- [design/04-initial-seeds.md](design/04-initial-seeds.md) - 初始种子（10-15 种核心形态和策略）

### 提示词模板
- [prompts/auxiliary/base.md](prompts/auxiliary/base.md) - 辅助会话系统提示词
- [prompts/main/base.md](prompts/main/base.md) - 主会话系统提示词（固定索引）
- [prompts/main/strategies/](prompts/main/strategies/) - 策略提示词目录
  - S1-emergency-response.md - 紧急响应
  - S2-direct-answer.md - 直接回答
  - S6-wait-for-more.md - 等待补充（含多模态预处理）
  - S7-observe.md - 观察讨论
  - S11-smart-ignore.md - 智能忽略
  - fallback.md - 兜底策略

### 参考资料
- [reference/dimension-definitions.yaml](reference/dimension-definitions.yaml) - 维度定义
- [reference/attribute-definitions.yaml](reference/attribute-definitions.yaml) - 属性定义
- [reference/interaction-strategy-map.yaml](reference/interaction-strategy-map.yaml) - 形态→策略映射表

### 工具文档
- [tools/queue-operations.md](tools/queue-operations.md) - 队列操作详解
- [tools/history-commands.md](tools/history-commands.md) - 历史消息查询命令

---

**版本**: 2.0  
**创建时间**: 2026-06-28  
**最后更新**: 2026-06-28  
**维护者**: EvolClaw 团队  
**状态**: 架构设计完成，待实施

**核心变更**:
- ✅ 强调单聊和群聊通用
- ✅ 增加自我进化机制
- ✅ 明确辅助会话功能边界
- ✅ 增加主会话模型选择
- ✅ 结构化输出（非工具调用）
- ✅ 从"完备枚举"转向"进化框架"