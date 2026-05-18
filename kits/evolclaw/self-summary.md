# 自我总结流程指南

自我总结是 agent 的自省行为——在会话结束或空闲时，回顾本次交互，提炼值得记住的信息。

## 触发时机

- 会话结束时（`on_session_end: true`）
- 空闲超过 N 分钟（`on_idle_minutes: 30`）
- 每日定时（`daily_at: "03:00"`）
- 每周定时（`weekly_on: "Sunday"`）

## 总结目标

| 目标层 | 写入位置 | 内容 |
|---|---|---|
| 事件性记忆 | `personal/memory/episodic.jsonl` | "我经历了什么"——关键事件、决策、结果 |
| 语义性记忆 | `personal/memory/semantic.md` | 习得的事实、规律、结论 |
| 当前关注 | `personal/memory/working.md` | 短期关注点（下次会话开始时加载） |
| 反思日志 | `personal/journal.jsonl` | 关键决策的复盘、自我修订 |

## 预算控制

- `max_tokens_per_day: 50000`——每日总结消耗的 token 上限
- 超出预算时跳过本次总结，记录到 `self_summary_failures.jsonl`

## 去重

- episodic.jsonl 按时间窗口去重（同一小时内的重复事件合并）
- semantic.md 由 LLM 判断是否已有等价结论
