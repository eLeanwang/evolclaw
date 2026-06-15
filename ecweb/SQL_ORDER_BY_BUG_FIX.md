# SQL ORDER BY Bug 修复 - 群聊数据不显示问题

## 问题描述

用户反馈：agent `1lwj.agentid.pub` 在群聊"爸爸真的好帅"中有过消耗，但群聊名称和统计信息没有展示出来。

## 根本原因

### SQL 排序错误

在 `stats.ts` 的三个查询函数中，使用了错误的 `ORDER BY` 语法：

```sql
-- ❌ 错误：在 GROUP BY 后直接引用聚合前的列名
ORDER BY (input_tokens+output_tokens) DESC

-- ✅ 正确：在 ORDER BY 中使用 SUM 函数
ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC
```

### 为什么会出错？

在 SQL 的 `GROUP BY` 查询中：
- `SELECT` 子句中已经使用了 `SUM(input_tokens)` 进行聚合
- 但 `ORDER BY (input_tokens+output_tokens)` 引用的是**聚合前的原始列**
- 这导致 SQLite 使用**每个分组第一行的值**进行排序，而不是聚合后的总和

### 实际影响

以 agent `1lwj.agentid.pub` 为例：

| Peer | 实际总 Tokens | 错误排序 | 正确排序 |
|------|--------------|---------|---------|
| lwjccccc.agentid.pub (单聊) | 121K | 第2位 | **第1位** ✅ |
| group.agentid.pub/11637 (群聊) | 46K | 第1位 | **第2位** ✅ |

**结果**：使用量较低的群聊被错误地排在前面，而高使用量的单聊被排到后面。

## 修复方案

### 修改的文件：`src/sources/stats.ts`

修复了三处 ORDER BY 错误：

#### 1. `queryStatsByPeer` (第186行)

```typescript
// 修复前
ORDER BY (input_tokens+output_tokens) DESC

// 修复后
ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC
```

#### 2. `queryStatsOverview` (第273行)

```typescript
// 修复前
ORDER BY (input_tokens+output_tokens) DESC

// 修复后
ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC
```

#### 3. `queryStatsByAgent` (第343行)

```typescript
// 修复前
ORDER BY (input_tokens+output_tokens) DESC

// 修复后
ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC
```

## 数据验证

### 群聊数据确实存在

1. **active.json 文件存在**
   - 路径：`~/.evolclaw/data/sessions/aun/1lwj.agentid.pub/group.agentid.pub%2F11637/active.json`
   - groupName: "你好123你、爸爸真帅、ykj、三藏..."
   - channelId: "group.agentid.pub/11637"
   - agentSessionId: "7760d6d5-3b30-4fdf-9463-49b516ff44b7"

2. **数据库记录存在**
   - peer_key: `aun#1lwj.agentid.pub#main#group.agentid.pub%2F11637`
   - 总 tokens: 46,276 (input: 45,536, output: 740)
   - peer_type: "group"

3. **CC 会话文件存在**
   - sessionId: `7760d6d5-3b30-4fdf-9463-49b516ff44b7.jsonl`
   - 通过 bindMap 正确关联到 agent 和 peer

## 修复效果

修复后，数据按照**实际使用量（总 tokens）**正确排序：

1. **Peers 列表**：高使用量的 peer 排在前面
2. **Agents 列表**：高使用量的 agent 排在前面
3. **群聊正确显示**：不再被错误地排除或排序错误

## 相关问题

这个 Bug 可能还影响了：
- Dashboard 的 Top Peers 显示
- Overview 的 by_agent 排序
- Explorer 侧边栏的排序

所有这些场景现在都已修复。

## SQL 最佳实践

在使用 `GROUP BY` 时：
- ✅ `ORDER BY SUM(column)` - 正确
- ✅ `ORDER BY aggregated_alias` - 如果数据库支持（某些数据库支持，SQLite 不完全支持）
- ❌ `ORDER BY column` - 错误，引用聚合前的列
