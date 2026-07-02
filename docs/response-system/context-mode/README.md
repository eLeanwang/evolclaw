# Context-Mode：上下文响应模式

## 概述

**Context-Mode**（上下文响应模式）是 EvolClaw 群聊响应系统的一种响应模式，核心特点是基于对交互上下文的深度理解来做出灵活的响应决策，而非依赖固定的规则匹配。

## 核心理念

```
方法论驱动 > 规则枚举
理解上下文 > 模式匹配
灵活推导 > 固定查表
开放扩展 > 封闭分类
```

## 设计原则

1. **上下文理解优先** - AI 首先理解"正在发生什么"
2. **提示词驱动** - 通过提示词引导判断，而非硬编码规则
3. **保留灵活性** - 即使相同情况也可以有不同策略
4. **开放性设计** - 支持未知情况和动态扩展
5. **交互为中心** - 以交互为基本单元组织和理解对话

## 核心组件

### 1. 交互本体论

定义交互的本质特征：
- **5 个核心维度**：参与者结构、交互意图、时间模式、结构化程度、上下文依赖性
- **10 个状态属性**：紧急程度、情绪基调、信息完整性等

### 2. 双会话机制

- **辅助会话**（便宜模型）：理解交互、预判参与、评估重要性、决定折叠
- **主会话**（主力模型）：执行策略、实际响应、深度处理

### 3. 参与决策框架

基于交互特征推导参与意愿：
- 与我无关，静默
- 不想参与，静默
- 有兴趣的
- 工作流中必须处理
- 我的职责

### 4. 策略推导

基于交互特征和状态动态推导策略，而非查表。

### 5. 交互存储

交互作为一等公民，持久化到关系级目录，支持检索和引用。

## 目录结构

```
context-mode/
├── design/          设计文档
├── prompts/         提示词模板（核心）
├── reference/       参考资料（维度/属性/模式定义）
└── examples/        示例案例
```

## 与其他模式的区别

| 特性 | Context-Mode | Rule-Based-Mode | Simple-Mode |
|------|-------------|-----------------|-------------|
| 决策方式 | 理解+推导 | 规则匹配 | 简单判断 |
| 灵活性 | 高 | 低 | 中 |
| 适用场景 | 复杂群聊 | 确定性场景 | 简单对话 |
| 模型要求 | 较高 | 低 | 低 |
| 开放性 | 强 | 弱 | 中 |

## 快速开始

### 启用 Context-Mode

在 ECK 变量中设置：

```yaml
responseMode: 'context-mode'
sessionType: 'auxiliary'  # 或 'main'
```

### 查看设计文档

从 `design/01-overview.md` 开始阅读。

### 修改提示词

编辑 `prompts/auxiliary/` 或 `prompts/main/` 中的模板。

### 添加新模式

在 `reference/pattern-library.yaml` 中添加新的常见模式。

## 文档索引

### 设计文档
- [01-overview.md](design/01-overview.md) - 系统概述
- [02-interaction-ontology.md](design/02-interaction-ontology.md) - 交互本体论
- [03-participation-framework.md](design/03-participation-framework.md) - 参与决策框架
- [04-strategy-derivation.md](design/04-strategy-derivation.md) - 策略推导原则
- [05-common-patterns.md](design/05-common-patterns.md) - 常见模式参考库
- [06-message-folding.md](design/06-message-folding.md) - 消息折叠机制
- [07-interaction-storage.md](design/07-interaction-storage.md) - 交互存储设计
- [08-history-command.md](design/08-history-command.md) - History 命令集

### 提示词模板
- [auxiliary/base.md](prompts/auxiliary/base.md) - 辅助会话基础提示词
- [main/base.md](prompts/main/base.md) - 主会话基础提示词

### 参考资料
- [dimension-definitions.yaml](reference/dimension-definitions.yaml) - 维度定义
- [attribute-definitions.yaml](reference/attribute-definitions.yaml) - 属性定义
- [pattern-library.yaml](reference/pattern-library.yaml) - 模式库

## 版本历史

- **v1.0** (2026-06-26) - 初始设计

## 维护者

EvolClaw 团队

---

**注意**: Context-Mode 仍在设计和迭代中，欢迎反馈和建议。