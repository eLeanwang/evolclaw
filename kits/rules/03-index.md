# 索引机制

## 两层索引

| 层 | 位置 | 维护者 |
|----|------|--------|
| evolclaw 级 | `$KITS_DOCS/INDEX.md` | 开发时维护，运行时只读 |
| agent 级 | `$AGENT_INDEX/INDEX.md` | agent 会话维护 |

## agent 级索引范围

- `$CURRENT_PROJECT`（当前工作目录）
- `$AGENT_DIR`（自己的 agent 数据目录）

## 触发时机

上述范围内有文档新增或较大幅度修改时，agent 主动重建索引。
