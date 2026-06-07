# ec stats — Token 用量与费用统计

查看 token 用量、费用消耗、预算状态、上下文细目。触发词：用量/费用/统计/预算/token/cost/花了多少。

## 查看今日概览

```bash
ec stats
ec stats --today
```

## 按时间段查看

```bash
ec stats --hour              # 最近 24h，按小时分组
ec stats --week              # 本周
ec stats --month             # 本月
ec stats --range 2026-05-01 2026-06-01   # 任意区间
```

## 按维度过滤（可组合）

```bash
ec stats --agent <aid>       # 指定 agent
ec stats --peer <X>          # 指定对端（裸 AID 自动前缀 aun#）
ec stats --model <model-id>  # 指定模型
ec stats --session <id>      # 指定会话
```

> `--peer` 简写：`alice.aid.pub` 等价于 `aun#alice.aid.pub`；其他渠道需显式写 `feishu#ou_xxx`。

## 聚合粒度

```bash
ec stats --by hour|day|week|month      # 时间维度
ec stats --by model                    # 按模型分组
ec stats --by peer                     # 按对端分组
ec stats --by agent                    # 按 agent 分组
```

## 快捷视图

```bash
ec stats --session <id>              # 会话明细（每轮 token/cost/ctx%）
ec stats --context <session-id>      # 上下文 breakdown 细目
ec stats --budget                    # 预算状态（daily + monthly）
ec stats --top-peers [--limit 10]    # 对端排行
ec stats --top-models [--limit 10]   # 模型用量排行
ec stats --traffic                   # 网络流量概览（收发条数/字节数）
ec stats --traffic --by peer         # 按对端分组流量
ec stats --traffic --week            # 本周流量
```

## 直接 SQL 查询

```bash
ec stats --sql "SELECT model, COUNT(*) AS cnt FROM usage_events GROUP BY model"
```

仅允许 SELECT 查询（只读安全）。

## 输出格式

- `--format json`：JSON 输出
- 默认：彩色终端表格

## 通用选项

- `--help`, `-h`：显示帮助
- `--format json`：JSON 输出（所有命令集通用约定）
