## ec stats 命令设计

> 状态：已实现

### 时间范围
```
ec stats                              # 今日全局概览（默认）
ec stats --today                      # 同上
ec stats --hour                       # 最近 24 小时，按小时分组
ec stats --week                       # 本周
ec stats --month                      # 本月
ec stats --from 2026-05-01 --to 2026-06-01  # 任意区间
```

### 维度过滤（可组合）
```
ec stats --agent <aid>                # 指定 agent
ec stats --peer <peerId>             # 指定对端（AUN 简写：不含 # 时自动前缀 aun#）
ec stats --peer feishu#ou_xxx         # 非 AUN 渠道需带 channel# 前缀
ec stats --model <model-id>           # 指定模型
ec stats --session <session-id>       # 指定会话（evolclaw session id）
```

### 聚合粒度
```
ec stats --by hour                    # 按小时聚合
ec stats --by day                     # 按天聚合（默认）
ec stats --by week
ec stats --by month
ec stats --by model                   # 按模型分组
ec stats --by peer                    # 按对端分组
ec stats --by agent                   # 按 agent 分组
```

### 快捷视图
```
ec stats --session <id>               # 单个会话全貌：每轮 turn 的 input/output/cost/ctx_pct
ec stats --session <id> --last        # 最后一轮用量 + 会话累计 + model_spec（等价 status.completed fallback）
ec stats --context <session-id>       # 会话的 context breakdown 细目（各段 token 占比变化）
ec stats --budget                     # 当前预算状态（各维度已用/剩余/百分比）
ec stats --top-peers [--limit 10]     # 用量最多的对端排行
ec stats --top-models                 # 各模型用量占比
ec stats --traffic                    # 网络流量概览（收发条数/字节数）
ec stats --traffic --by peer          # 按对端分组流量
ec stats --traffic --week             # 本周流量
```

### 直接 SQL 查询
```
ec stats --sql "SELECT model, COUNT(*) AS cnt FROM usage_events GROUP BY model"
ec stats --sql "SELECT * FROM usage_events ORDER BY ts DESC LIMIT 5" --json
```

安全措施：只读连接 + 仅允许 SELECT 语句。

### 输出格式
```
ec stats --format json                # JSON 输出
```

### Menu Protocol exec 快捷命令（Evol 前端调用）
```json
[
  { "label": "今日用量",     "command": "ec stats --today --format json" },
  { "label": "本月用量",     "command": "ec stats --month --format json" },
  { "label": "当前 agent",   "command": "ec stats --today --agent $SELF_AID --format json" },
  { "label": "当前对端",     "command": "ec stats --today --peer $PEER_KEY --format json" },
  { "label": "当前会话",     "command": "ec stats --session $SESSION_ID --format json" },
  { "label": "最后一轮",     "command": "ec stats --session $SESSION_ID --last --format json" },
  { "label": "预算状态",     "command": "ec stats --budget --format json" },
  { "label": "上下文细目",   "command": "ec stats --context $SESSION_ID --format json" },
  { "label": "自定义查询",   "command": "ec stats --sql \"SELECT ...\" --format json" }
]
```

> **前端 fallback**：若未收到 `status.completed` 事件（超时/离线），执行 `ec stats --session $SESSION_ID --last --format json` 可获取等效数据。
