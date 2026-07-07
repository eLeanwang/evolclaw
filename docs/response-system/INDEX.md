# 响应系统文档索引

**状态**: 当前响应系统设计的唯一事实来源索引  
**最后更新**: 2026-07-06  
**架构决策**: 后续设计和实现统一采用 `src/response-system/engines + modes` 方案。

---

## 1. 架构决策

当前响应系统采用三层结构：

```text
用户配置层
  -> 用户只选择 response_mode
响应模式层
  -> modes/interactive
  -> modes/proactive
  -> modes/dual-session-lite
响应引擎层
  -> engines/v1
  -> engines/v2
```

目标代码结构：

```text
src/response-system/
├── engines/
│   ├── v1/
│   └── v2/
├── modes/
│   ├── interactive/
│   ├── proactive/
│   └── dual-session-lite/
├── registry.ts
├── selector.ts
├── types.ts
└── index.ts
```

明确不再采用以下方案作为新设计目标：

```text
src/response-modes/dual-session/
```

现有 `src/response-modes/` 只作为 V1 行为迁移来源或兼容层，不作为 dual-session-lite 的实现落点。

---

## 2. 唯一事实来源文档

后续响应系统设计、任务拆分和实现，以本节文档为准。若其它文档与本节冲突，以本节排序靠前的文档为准。

| 顺序 | 文档 | 作用 | 使用场景 |
|---:|---|---|---|
| 1 | `docs/response-system/RESPONSE-MODE-ARCHITECTURE-V2.md` | 响应模式 V2 总体架构 | 判断 mode/engine 分层、用户配置语义、目录结构 |
| 2 | `docs/response-system/dual-session-lite/ARCHITECTURE-FINAL.md` | dual-session-lite 最终架构 | 判断 V2Engine、DualSessionLiteMode、registry/selector 关系 |
| 3 | `docs/response-system/dual-session-lite/IMPLEMENTATION-PLAN.md` | 方案 1 实施计划 | 拆任务、安排阶段、确认新增/修改文件 |
| 4 | `docs/response-system/dual-session-lite/ISSUES-SUMMARY.md` | P0/P1/P2 问题收敛结果 | 判断设计是否覆盖阻塞问题和强建议问题 |
| 5 | `docs/response-system/dual-session-lite/README.md` | dual-session-lite 行为入口 | 理解问题背景、核心机制、单聊/群聊差异 |
| 6 | `docs/response-system/dual-session-lite/data-structures.md` | 数据结构定义 | 写 V2 类型、队列状态、决策、反馈、持久化结构 |
| 7 | `docs/response-system/dual-session-lite/message-flow.md` | 消息流转细节 | 写 V2 集成流程、测试消息路径 |
| 8 | `docs/response-system/dual-session-lite/eck-integration.md` | ECK 集成设计 | 改 ECK vars、manifest、辅助/主会话 prompt 注入 |
| 9 | `docs/response-system/dual-session-lite/prompts/auxiliary-base.md` | 辅助会话提示词 | 实现 AuxiliarySession 调用和输出解析 |
| 10 | `docs/response-system/dual-session-lite/prompts/main-base.md` | 主会话提示词 | 实现 MainSession 批处理、回复和反馈总结 |

---

## 3. 实施任务分组

### 3.1 框架与 V1 迁移

| 文档 | 作用 |
|---|---|
| `RESPONSE-MODE-ARCHITECTURE-V2.md` | 定义 `src/response-system/` 总体结构 |
| `dual-session-lite/ARCHITECTURE-FINAL.md` | 定义 registry、selector、V1/V2 mode 集成方式 |
| `dual-session-lite/IMPLEMENTATION-PLAN.md` | Phase 1/2 任务和验收标准 |

### 3.2 V2 双会话引擎

| 文档 | 作用 |
|---|---|
| `dual-session-lite/README.md` | 说明双会话要解决的消息爆炸、快慢模型不对齐、多 agent 竞争问题 |
| `dual-session-lite/data-structures.md` | 定义 QueuedMessage、AuxiliaryDecision、MainFeedback、DualSessionConfig |
| `dual-session-lite/message-flow.md` | 定义辅助队列、辅助会话、主队列、主会话之间的流转 |
| `dual-session-lite/ISSUES-SUMMARY.md` | 定义错误处理、HOLD 超时、降级、持久化等关键设计结论 |

### 3.3 ECK 和 Prompt

| 文档 | 作用 |
|---|---|
| `dual-session-lite/eck-integration.md` | 定义 `responseMode`、`sessionType` 等 ECK vars |
| `dual-session-lite/prompts/auxiliary-base.md` | 辅助会话判断提示词 |
| `dual-session-lite/prompts/main-base.md` | 主会话处理提示词 |

### 3.4 后续增强

| 文档 | 作用 | 阶段 |
|---|---|---|
| `memory-compression-design.md` | 设计会话总结、关键事实提取、记忆搜索 | Phase 2，不阻塞 dual-session-lite MVP |

---

## 4. 背景分析文档

这些文档用于理解历史讨论和设计取舍，不作为当前实现的直接事实来源。

| 文档 | 定位 |
|---|---|
| `dual-session-lite/REVIEW-SUPPLEMENT.md` | 详细评审材料；若与 `ISSUES-SUMMARY.md` 冲突，以 `ISSUES-SUMMARY.md` 为准 |
| `dual-session-lite/REVISION-SUMMARY.md` | 修订摘要；用于快速了解最近改动 |
| `dual-session-lite/PLUGIN-SYSTEM-ANALYSIS.md` | 旧 `src/response-modes/` 插件系统分析；用于理解为什么要切到方案 1 |
| `dual-session-lite/plugin-analysis.md` | 早期插件分析；只作背景 |
| `dual-session-lite/REVIEW.md` | 早期 review；只作背景 |
| `dual-session-lite/IMPL-PLAN-V2-SUMMARY.md` | V2 实施摘要；以 `IMPLEMENTATION-PLAN.md` 为完整版本 |

---

## 5. 历史文档

这些文档反映旧版方案或早期迁移过程，不再驱动新实现。

| 文档/目录 | 处理方式 |
|---|---|
| `docs/response-system/dual-session-mode/` | 旧完整双会话方案，已被 `dual-session-lite/` 取代 |
| `docs/response-system/context-mode/` | 旧 context-mode 探索，保留为历史参考 |
| `docs/response-system/response-mode-architecture.md` | 旧响应模式架构，已被 `RESPONSE-MODE-ARCHITECTURE-V2.md` 取代 |
| `docs/response-system/architecture.md` | 旧插件化系统大文档，保留为历史背景 |
| `docs/response-system/implementation-plan.md` | 旧实施计划，不作为当前任务依据 |
| `docs/response-system/phase*.md` | 旧迁移阶段记录，不作为当前任务依据 |
| `docs/response-system/migration-*.md` | 旧迁移评估/完成记录，不作为当前任务依据 |

---

## 6. 冲突处理规则

1. 如果文档要求在 `src/response-modes/dual-session*` 下实现 dual-session-lite，该要求作废。
2. 如果文档把 dual-session-lite 描述为旧 `ResponseMode` 接口的直接实现，该要求作废。
3. 如果文档要求用户选择 engine，该要求作废；用户只选择 response mode。
4. 如果文档在 V2 内部抽象公共接口，该要求暂缓；V2 第一版完整实现，不提前提取可复用接口。
5. 如果文档与 `IMPLEMENTATION-PLAN.md` 的交付文件清单冲突，以 `IMPLEMENTATION-PLAN.md` 为准。

---

## 7. 建议执行顺序

1. 先读本索引。
2. 读 `RESPONSE-MODE-ARCHITECTURE-V2.md`。
3. 读 `dual-session-lite/ARCHITECTURE-FINAL.md`。
4. 读 `dual-session-lite/IMPLEMENTATION-PLAN.md`。
5. 按当前任务读取对应的细分文档：数据结构、消息流、ECK、prompt、问题总结。

不要从旧 `dual-session-mode/` 或旧 `implementation-plan.md` 反推当前实现。

---

## 0. Runtime Mode Priority

Response mode runtime resolution must use this priority:

1. Relation override: `response_modes.overrides[peerKey].mode`
2. Current session mode: `session.chatMode` set by UI/menu/slash command
3. Agent defaults: `response_modes.default_private` / `response_modes.default_group`
4. System fallback: private -> `interactive`, group -> `proactive`

Rationale: `response_modes.default_*` is an agent default, not a lock. If the user changes the current conversation to Proactive, the current session must execute as Proactive unless a relation override explicitly forces another mode.

## 1.