# ec stats — Token 用量与费用统计命令参考

> 命令入口：`src/cli/stats.ts` | 数据查询：`src/core/stats/query.ts` | 计费：`src/core/stats/billing.ts`

---

## 基础语法

```
ec stats [时间范围] [维度过滤] [聚合粒度] [快捷视图] [输出格式]
```

---

## 时间范围

| 参数 | 含义 | 默认粒度 |
|------|------|---------|
| *(无参数)* | 今日概览 | hour |
| `--today` | 今日概览 | hour |
| `--hour` | 最近 24 小时 | hour |
| `--week` | 本周（从周日起） | day |
| `--month` | 本月 | day |
| `--from <YYYY-MM-DD> --to <YYYY-MM-DD>` | 任意区间 | day |

---

## 维度过滤（可与时间范围自由组合）

| 参数 | 含义 | 示例 |
|------|------|------|
| `--agent <aid>` | 指定 agent | `--agent bot.agentid.pub` |
| `--peer <X>` | 对端（裸 AID 自动补 `aun#` 前缀，或直接传 `channel#id`） | `--peer alice.aid.pub` |
| `--model <model-id>` | 指定模型 | `--model claude-opus-4-8` |
| `--session <id>` | 指定会话 | `--session abc123` |

---

## 聚合粒度 `--by`

覆盖默认粒度，可选值：`hour` `day` `week` `month` `model` `peer` `agent`

```bash
ec stats --month --by model    # 本月按模型分组
ec stats --week  --by peer     # 本周按对端分组
ec stats --month --by agent    # 本月按 agent 分组
```

---

## 默认聚合视图（不带快捷视图参数时）

```bash
ec stats              # 今日（按小时）
ec stats --week       # 本周（按天）
ec stats --month      # 本月（按天）
```

**输出列：**

| 列 | 说明 |
|-----|------|
| Period | 时间段 |
| Input | 输入 token |
| Output | 输出 token |
| Cache↑ | 缓存写入 token（cache_creation） |
| CacheHit | 缓存命中 token（cache_read） |
| Calls | 调用次数 |
| HitRate | 缓存命中率 |

**注：** 默认聚合视图不含费用列（USD/CNY），需费用信息请用 `--session` 或 `--by model` + `--format json`。

---
## 快捷视图

### 单个会话明细

```bash
ec stats --session <id>
```

**输出列：** Time · Model · Input · Output · Cache · Ctx% · USD · CNY
**汇总行：** input / output token 合计、USD / CNY 总费用、轮次数

---

### 会话最后一轮 + 累计统计

```bash
ec stats --session <id> --last
```

**等价于 `status.completed` 事件中的 metadata。输出字段：**

```
turn.model                  模型 ID
turn.input_tokens           本轮输入 token
turn.output_tokens          本轮输出 token
turn.cache_read_tokens      本轮缓存命中 token
turn.cache_creation_tokens  本轮缓存写入 token
turn.cache_hit_rate         本轮缓存命中率
turn.context_window_pct     上下文窗口占用百分比
turn.cost_usd               本轮 USD 费用
turn.cost_cny               本轮 CNY 费用
turn.duration_ms            本轮耗时（毫秒）

session_total.input_tokens
session_total.output_tokens
session_total.cache_read_tokens
session_total.cache_creation_tokens
session_total.cost_usd      会话累计 USD 费用
session_total.cost_cny      会话累计 CNY 费用
session_total.call_count    会话总调用次数
session_total.cache_hit_rate

model_spec.context_window   模型上下文窗口上限
model_spec.max_input_tokens
model_spec.max_output_tokens
```

---

### 会话 Context 细分

```bash
ec stats --context <session-id>
```

**输出列：** Turn · System（系统提示词）· Tools · MCP · Agents · Memory · Skills · Messages · Free · Total · Max

> 每轮显示各部分占用 token 数，Total 为预估上下文总长度。

---

### 预算状态

```bash
ec stats --budget                        # 全局预算
ec stats --budget --agent <aid>          # 指定 agent 预算
ec stats --budget --peer <key>           # 指定对端预算
```

**输出字段：**

```
daily_limit_usd       日限额（-1 = 无限制）
daily_used_usd        今日已用
daily_remaining_usd   今日剩余
monthly_limit_usd     月限额
monthly_used_usd      本月已用
monthly_remaining_usd 本月剩余
pct_used              使用百分比
hard_blocked          是否已硬限流（>= 100%，红色警示）
soft_warn             软警告（>= 80%）
auto_warn             自主警告（>= 60%）
```

**预算配置文件：** `$EVOLCLAW_HOME/data/stats/budgets.json`

```json
{
  "global": { "daily_usd": 10, "monthly_usd": 300 },
  "agents": { "<aid>": { "daily_usd": 5 } },
  "peers":  { "<peer_key>": { "daily_usd": 2 } }
}
```

---

### 对端 Token 排行

```bash
ec stats --top-peers               # 默认 Top 10
ec stats --top-peers --limit 20    # 自定义条数
```

**输出：** 排名 · Peer · Tokens · Calls

---

### 模型 Token 排行

```bash
ec stats --top-models
ec stats --top-models --limit 5
```

**输出：** 排名 · Model · Tokens · Calls

---

### 网络流量统计

```bash
ec stats --traffic
ec stats --week --traffic
ec stats --traffic --by hour
```

**输出列：** Period · Msg In · Msg Out · Bytes In · Bytes Out

---

### 直接执行 SQL（只读）

```bash
ec stats --sql "SELECT model, COUNT(*) as calls, SUM(input_tokens) as tokens FROM usage_events GROUP BY model ORDER BY tokens DESC"
```

> 仅允许 `SELECT` 语句。可查询 `usage_events`、`context_breakdown`、`message_events` 表。

---

## 输出格式

| 参数 | 说明 |
|------|------|
| *(默认)* | 带颜色的表格输出 |
| `--format json` | JSON 格式，适合脚本处理 |

所有命令均支持 `--format json`。

---

## 模型价格信息

```bash
ec model info <model-id>
```

```
模型: claude-opus-4-8
  厂商:       anthropic
  上下文窗口: 1000000 tokens
  最大输出:   8192 tokens
  输入价格:   $15.00 / 1M tokens
  输出价格:   $75.00 / 1M tokens
```

---

## 常用示例

```bash
# 今日消耗概览
ec stats

# 本月按模型分组（含费用）— JSON
ec stats --month --by model --format json

# 本周某个 agent 的费用
ec stats --week --agent bot.agentid.pub

# 查看预算还剩多少
ec stats --budget

# 查看某次会话每轮消耗明细
ec stats --session abc123

# 查看某次会话累计费用（与 status.completed 数据一致）
ec stats --session abc123 --last

# 查看上下文各部分占了多少 token
ec stats --context abc123

# Top 20 对端
ec stats --top-peers --limit 20

# 自定义时间范围
ec stats --from 2026-06-01 --to 2026-06-07 --by model

# 原始 SQL 查询
ec stats --sql "SELECT model, SUM(input_tokens+output_tokens) total FROM usage_events GROUP BY model ORDER BY total DESC LIMIT 10"
```

---

## 数据存储位置

```
$EVOLCLAW_HOME/data/stats/
├── usage.db               # 主统计数据库（SQLite）
├── budgets.json           # 预算配置
├── model-prices.jsonl     # 价格表（可覆盖）
├── model-specs.jsonl      # 模型规格（context_window 等）
├── model-aliases.jsonl    # 模型别名映射
└── archive/               # 跨年归档数据库（查询时自动合并）
```

