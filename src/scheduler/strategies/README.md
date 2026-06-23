# 调度策略（strategies/）

`SchedulingStrategy` 接口的三种实现，计算会话优先级。

| 文件 | 策略 | 特点 | 适用 |
|------|------|------|------|
| rule-based.ts | 规则驱动 | 快、可预测、零成本 | 默认，80% 场景 |
| ai-based.ts | AI 驱动 | 智能、慢、耗 token | 复杂场景，显式开启 |
| hybrid.ts | 混合 | 平时规则、关键时 AI | 推荐平衡方案 |

详见 `docs/response-system/architecture.md` §4.3。当前为占位目录，待 Phase 7 填充。
