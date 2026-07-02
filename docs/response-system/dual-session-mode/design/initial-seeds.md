# 初始种子：核心交互形态和行动策略

**版本**: 1.0  
**创建时间**: 2026-06-28  
**说明**: 系统启动时的初始形态和策略集合，后续通过自我进化机制扩展

---

## 设计理念

```
重点不是"完备"，而是"够用 + 可进化"

初始种子：
  - 覆盖最常见的 80% 场景
  - 提供清晰的扩展模板
  - 建立进化的起点

后续进化：
  - 系统自动发现新场景
  - 每日评估和优化
  - 关系级定制
```

---

## 一、核心交互形态（初始 7 种）

### A 类：单人求助（3 种）

#### A1: 直接求助

```yaml
code: A1
name: 直接求助
description: 用户明确求助，问题清晰完整

dimensions:
  participantStructure: 单人→群
  intent: 信息获取
  timePattern: 实时同步
  structureLevel: 自由对话
  contextDependency: 独立

attributes:
  urgency: 正常
  emotionalTone: [中性]
  informationCompleteness: 完整
  aiRelevance: 必须 AI
  topicProfessionalism: 技术

primaryStrategy: S2

triggers:
  - "@AI"
  - 明确的问题
  - 完整的描述

examples:
  - "@AI Python 如何读取 CSV 文件？"
  - "@AI 这个报错怎么解决？[报错信息]"
```

#### A3: 附件说明型求助

```yaml
code: A3
name: 附件说明型求助
description: 用户发送图片/文件 + 说明

dimensions:
  participantStructure: 单人→群
  intent: 信息获取
  timePattern: 实时同步
  structureLevel: 半结构化
  contextDependency: 独立

attributes:
  urgency: 正常
  emotionalTone: [中性]
  informationCompleteness: 不完整-多模态
  aiRelevance: 必须 AI
  topicProfessionalism: 技术

primaryStrategy: S6

preprocessing:
  - OCR 提取图片文字
  - 文件内容摘要
  - 信息拼接

examples:
  - "[图片: 代码截图] 这个报错怎么解决？"
  - "[文件: log.txt] 能帮我看看哪里有问题吗？"
```

#### A5: 紧急求助

```yaml
code: A5
name: 紧急求助
description: 紧急故障、生产问题

dimensions:
  participantStructure: 单人→群
  intent: 信息获取
  timePattern: 实时同步
  structureLevel: 自由对话
  contextDependency: 独立

attributes:
  urgency: 紧急
  emotionalTone: [紧张, 焦虑]
  informationCompleteness: 完整 或 不完整
  aiRelevance: 必须 AI
  topicProfessionalism: 技术

primaryStrategy: S1

triggers:
  - "紧急"、"urgent"
  - "崩了"、"挂了"
  - "生产环境"

examples:
  - "紧急！生产环境崩了！"
  - "数据库连不上了，急！"
```

---

### B 类：多人讨论（2 种）

#### B1: 技术讨论

```yaml
code: B1
name: 技术讨论
description: 多人讨论技术问题或方案

dimensions:
  participantStructure: 多人讨论
  intent: 讨论决策
  timePattern: 实时同步
  structureLevel: 自由对话
  contextDependency: 弱依赖

attributes:
  urgency: 正常
  emotionalTone: [中性]
  informationCompleteness: 完整
  participationActivity: 正常活跃
  aiRelevance: 弱相关
  topicProfessionalism: 技术

primaryStrategy: S7-observe
conditionalStrategies:
  - condition: "participationActivity = 低活跃 && aiRelevance = 强相关"
    strategy: S8-timely-intervention
  - condition: "emotionalTone contains 冲突"
    strategy: S8-timely-intervention

examples:
  - "React 和 Vue 哪个好？"
  - "我们应该用微服务还是单体架构？"
```

#### B2: 技术争论

```yaml
code: B2
name: 技术争论
description: 多人讨论演变为争论

dimensions:
  participantStructure: 多人讨论
  intent: 讨论决策
  timePattern: 实时同步
  structureLevel: 自由对话
  contextDependency: 强依赖

attributes:
  urgency: 正常
  emotionalTone: [冲突, 紧张]
  informationCompleteness: 完整
  participationActivity: 高活跃
  consensusLevel: 分歧大
  aiRelevance: 弱相关
  topicProfessionalism: 技术

primaryStrategy: S7-observe
conditionalStrategies:
  - condition: "有人 @AI 或求助"
    strategy: S8-timely-intervention

note: "从 B1 演进而来，情绪基调变化"

examples:
  - "你不懂" "你才不懂" [循环争论]
  - "@AI 你来评评理"
```

---

### E 类：社交互动（1 种）

#### E1: 日常闲聊

```yaml
code: E1
name: 日常闲聊
description: 非工作相关的闲聊

dimensions:
  participantStructure: 多人讨论 或 双人对话
  intent: 社交互动
  timePattern: 实时同步
  structureLevel: 自由对话
  contextDependency: 弱依赖

attributes:
  urgency: 低
  emotionalTone: [中性, 积极]
  informationCompleteness: 完整
  participationActivity: 正常活跃
  aiRelevance: 与 AI 无关
  topicProfessionalism: 通用

primaryStrategy: S11-smart-ignore
conditionalStrategies:
  - condition: "明确 @AI"
    strategy: S2-direct-answer

examples:
  - "周末干什么了？"
  - "今天天气真好"
  - "晚上吃什么？"
```

---

### Unknown: 未知形态

```yaml
code: unknown
name: 未知形态
description: 无法匹配任何已知形态

primaryStrategy: fallback

note: "触发自我进化机制，分析是否需要新增形态"
```

---

## 二、核心行动策略（初始 8 种）

### 立即响应类（3 种）

#### S1: 紧急响应

```yaml
code: S1
name: 紧急响应
description: 处理紧急故障和生产问题

characteristics:
  speed: 极快（30秒内）
  quality: 临时方案优先
  followup: 需要后续优化

principles:
  - 速度 > 完美
  - 止血 > 根治
  - 临时方案 > 长期方案

steps:
  1. 快速理解（10秒）
  2. 给出临时方案（30秒）
  3. 跟踪结果

file: prompts/main/strategies/S1-emergency-response.md
```

#### S2: 直接回答

```yaml
code: S2
name: 直接回答
description: 问题清晰时直接给出答案

characteristics:
  speed: 快
  quality: 高（准确、完整）
  style: 简洁、直接

principles:
  - 第一句话就是答案
  - 包含可运行的示例
  - 一次性解决问题
  - 避免过度解释

file: prompts/main/strategies/S2-direct-answer.md
```

#### S3: 引导澄清

```yaml
code: S3
name: 引导澄清
description: 需求模糊时引导用户澄清

characteristics:
  speed: 快
  quality: 引导性
  style: 友好追问

principles:
  - 给出可能的理解
  - 具体的追问
  - 提供选项

steps:
  1. 给出初步理解
  2. 友好追问关键信息
  3. 提供可能的方向

note: "与 fallback 类似，但更主动引导"
```

---

### 延迟响应类（3 种）

#### S6: 等待补充

```yaml
code: S6
name: 等待补充
description: 信息不完整时等待或预处理

characteristics:
  speed: 延迟（3-15秒）
  quality: 预处理后高质量
  preprocessing: 多模态、信息拼接

use_cases:
  - 分段消息（等待拼接）
  - 多模态消息（OCR、文件提取）
  - 信息不完整（等待补充）

preprocessing_steps:
  - 图片 → OCR / 视觉理解
  - 文件 → 提取摘要
  - 视频 → 关键帧 / 转文字
```

#### S7: 观察讨论

```yaml
code: S7
name: 观察讨论
description: 多人讨论时观察，不打断

characteristics:
  speed: 不响应
  quality: 跟踪记录
  followup: 等待介入时机

principles:
  - 尊重讨论节奏
  - 不抢话、不打断
  - 识别介入时机

intervention_signals:
  - 讨论陷入僵局
  - 出现明显错误
  - 有人明确求助
  - 需要总结

file: prompts/main/strategies/S7-observe.md
```

#### S8: 适时介入

```yaml
code: S8
name: 适时介入
description: 观察后找时机介入

characteristics:
  speed: 延迟（等待时机）
  quality: 高（提供增量价值）
  timing: 关键

intervention_scenarios:
  - 讨论陷入僵局 → 给出客观分析
  - 出现明显错误 → 温和纠正
  - 需要总结 → 提炼要点
  - 明确求助 → 直接回答

note: "从 S7 演进而来"
```

---

### 智能调节类（1 种）

#### S11: 智能忽略

```yaml
code: S11
name: 智能忽略
description: 与 AI 无关的消息，不参与

characteristics:
  speed: 不响应
  storage: 折叠存储
  quality: 生成摘要

principles:
  - 不参与无关对话
  - 但记录摘要（主会话可查）
  - 节省资源

fold_format:
  summary: "5 条消息，闲聊周末计划"
  importance: 1
  observing: false

examples:
  - 日常闲聊
  - 订餐讨论
  - 个人话题
```

---

### 兜底（1 种）

#### fallback: 兜底策略

```yaml
code: fallback
name: 兜底策略
description: 无法匹配任何策略时使用

characteristics:
  speed: 快
  quality: 保守
  style: 友好追问

principles:
  - 承认不确定
  - 请求澄清
  - 提供可能方向

file: prompts/main/strategies/fallback.md

trigger_for_evolution: true
note: "使用 fallback 说明可能需要新增形态/策略"
```

---

## 三、默认策略映射表

### 策略映射表格式

映射表位置：`$AGENT_DIR/strategy-mapping.json`

```json
{
  "global": {
    "A1": "S2",
    "A3": "S6",
    "A5": "S1",
    "B1": "S7",
    "B2": "S8",
    "E1": "S11",
    "unknown": "fallback"
  },
  "relations": {
    "feishu#chat_123": {
      "A1": "S14"
    }
  }
}
```

### 说明

**全局规则（global）**：
- 所有群/人默认使用的映射
- 基于初始种子定义
- 可以被关系级配置覆盖

**关系级定制（relations）**：
- 特定群/人的定制映射
- 格式：`<channel>#<peerId>`
- 覆盖全局规则

**查询顺序**：
1. 先查 `relations[当前群/人][交互类型]`
2. 如果没有，查 `global[交互类型]`
3. 如果没有，使用 `fallback`

**进化方式**：
- 主会话记录策略效果
- 每日评估调整映射表
- 支持自动和手动调整

---

## 四、形态到策略的映射（已合并到上方）

**注意**：形态到策略的映射现在统一在策略映射表中维护，不再分散定义。

初始映射：

```yaml
A1 → S2   # 直接求助 → 直接回答
A3 → S6   # 附件求助 → 等待补充（预处理）
A5 → S1   # 紧急求助 → 紧急响应
B1 → S7   # 技术讨论 → 观察
B2 → S8   # 技术争论 → 适时介入
E1 → S11  # 日常闲聊 → 智能忽略
unknown → fallback  # 未知 → 兜底
```

**条件分支**（待实现）：
```yaml
B1:
  默认: S7
  条件:
    - if: "participationActivity = 低活跃 && aiRelevance = 强相关"
      then: S8
    - if: "emotionalTone contains 冲突"
      then: S8

E1:
  默认: S11
  条件:
    - if: "明确 @AI"
      then: S2
```

**注意**：条件分支逻辑由主会话实现，映射表只存储简单映射。

---

## 五、未包含但计划扩展的形态/策略

### 待观察的形态

```yaml
potential_patterns:
  A2: 分段求助
  A4: 模糊求助
  B3: 头脑风暴
  B4: 问题排查
  C1: 任务分配
  D1: 群公告
  F1: 多轮对话
```

### 待补充的策略

```yaml
potential_strategies:
  S4: 快速确认
  S9: 延迟总结
  S12: 选择性参与
  S14: 分阶段响应
  S16: 主动总结
```

**原则**: 不预先创建，等实际需要时通过自我进化添加

---

## 六、自我进化触发条件

### 需要新增形态的信号

```
1. fallback 使用频率高（> 10%）
2. 相似场景反复出现但无法分类
3. 辅助会话判断置信度持续低
4. 主会话频繁覆盖决策（特定类型）
```

### 需要新增策略的信号

```
1. 现有策略效果不好（用户追问多）
2. 特定形态的处理方式重复调整
3. 主会话频繁偏离策略指南
```

### 需要优化映射的信号

```
1. 特定形态的策略效果不好（用户追问多）
2. 主会话频繁调整策略（特定形态）
3. 某些策略从未被使用
4. 某些策略被过度使用
```

**注意**：映射优化由主会话记录数据，每日评估调整。

---

## 七、关系级定制示例

```yaml
# 全局默认使用初始种子
global_seeds: 7_patterns_8_strategies

# 某个技术群的定制
relation_custom:
  channel: "feishu"
  peerId: "chat_123"
  venueKey: "feishu#chat_123"
  
  # 覆盖策略映射
  strategy_mapping:
    "A1": "S14"  # 这个群对直接求助偏好分阶段响应
    "B1": "S8"   # 这个群更倾向主动介入讨论
  
  # 可选：新增形态（如果全局没有）
  custom_patterns:
    "C1":
      name: "任务分配"
      description: "Owner 分配任务"
      primary_strategy: "S2"
  
  # 可选：新增策略（如果全局没有）
  custom_strategies:
    "S100":
      name: "技术深度讨论"
      description: "针对这个群的技术深度"
      file: "$AGENT_DIR/venues/feishu#chat_123/strategies/S100.md"
```

**说明**：
- 关系级定制存储在 `$AGENT_DIR/venues/<venueKey>/config.json` 中
- 主会话查询映射时先查关系级，再查全局
- 关系级定制由自我进化机制自动调整

---

## 八、版本演进记录

```yaml
v1.0 (2026-06-28):
  patterns: 7
  strategies: 8
  coverage: "预估 80% 常见场景"
  
future:
  v1.1: "预计 1 周后，根据实际使用添加 2-3 个形态"
  v1.2: "预计 2 周后，优化映射关系"
  v2.0: "预计 1 个月后，形态稳定在 12-15 个"
```

---

**记住**: 初始种子不追求完备，重点是建立可进化的基础。