# Token 用量统计系统设计规格

> 状态：**已实现**  
> 关联文档：`token-stats-cli.md`

---

## 1. 概述

为 EvolClaw 新增 token 用量与费用统计能力，覆盖：数据采集 → 持久化 → CLI 查询 → ECK 变量注入 → Evol 前端通知 → ecweb 看板。

---

## 2. 存储位置与文件结构

```
$EVOLCLAW_HOME/data/stats/
├── usage.db               ← SQLite 主库（WAL 模式，保留最近约一年数据）
├── usage-2024.db          ← 归档库示例（只读，按年生成）
└── budgets.json           ← 预算配置

$PACKAGE_ROOT/data/stats/
├── model-prices.jsonl     ← 模型价格表（append-only，随包发布）
├── model-specs.jsonl      ← 模型能力参数（context_window / max_input / max_output 等）
└── model-aliases.jsonl    ← 模型 ID 映射（带版本号 → 定价表规范 ID）
```

> 三个 JSONL 表随包发布（`$PACKAGE_ROOT/data/stats/`），billing.ts 读取时先包路径再用户路径合并——用户可在 `$EVOLCLAW_HOME/data/stats/` 下放同名文件追加/覆盖。

### 归档策略

- **触发时机**：daemon 启动时检查一次；每天凌晨定时检查一次
- **归档条件**：`ts < 当前年份第一天 00:00:00`（即超过一整个自然年的数据）
- **流程**：
  1. 确定归档目标年份（如当前 2026 年 5 月 → 归档 2024 年及更早）
  2. 对每个待归档年份：`ATTACH 'usage-{year}.db' AS arch` → `INSERT INTO arch.usage_events SELECT * FROM main.usage_events WHERE ts < {year_end_ts}` → `DETACH` → `DELETE FROM usage_events WHERE ts < {year_end_ts}`
  3. `VACUUM` 主库回收空间
- **归档库只读**：归档完成后不再写入；CLI 和 ecweb 查询跨年数据时自动发现并附加对应归档库
- **context_breakdown 同步归档**：与 usage_events 同批次，按相同 ts 条件归档
> 无汇率表。USD 和 CNY 各自独立计算（跟随价格表中模型的 currency 字段），前端/ecweb 切换展示，不做换算。

### 2.1 SQLite 并发安全

- **WAL 模式**：`PRAGMA journal_mode=WAL`，一个写者（daemon）+ 多个读者（ecweb、CLI）并发安全
- **只读连接**：ecweb 和 CLI 以 `readOnly: true` 打开，不申请写锁
- **技术选型**：`node:sqlite`（Node 22.5+ 内置 `DatabaseSync`），与主包保持一致；低版本 Node 懒加载失败时降级提示，不崩溃

### 2.2 usage_events 表

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                    INTEGER NOT NULL,
  agent_aid             TEXT    NOT NULL,
  peer_key              TEXT    NOT NULL,       -- channel#peerId
  peer_type             TEXT,                   -- private | group
  session_id            TEXT,                   -- evolclaw session id
  model                 TEXT    NOT NULL,
  billing_fn            TEXT    NOT NULL,       -- 写入时推断，历史永久绑定

  -- 通用字段（Claude / OpenAI 兼容）
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,

  -- DeepSeek 口径
  cache_hit_tokens      INTEGER,
  cache_miss_tokens     INTEGER,

  -- 图片 token（Qwen-VL 等）
  image_tokens          INTEGER,

  -- 上下文总长（供分档计费，如 Gemini）
  total_context_tokens  INTEGER,

  -- 元数据
  turns                 INTEGER NOT NULL DEFAULT 1,
  duration_ms           INTEGER,
  context_window_pct    REAL
);

CREATE INDEX IF NOT EXISTS idx_ts         ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_agent_ts   ON usage_events(agent_aid, ts);
CREATE INDEX IF NOT EXISTS idx_peer_ts    ON usage_events(agent_aid, peer_key, ts);
CREATE INDEX IF NOT EXISTS idx_model_ts   ON usage_events(model, ts);
CREATE INDEX IF NOT EXISTS idx_session_ts ON usage_events(session_id, ts);
```

### 2.3 context_breakdown 表

每轮 human turn 构造时，把各段的本地估算 token 数写入此表（对应 `/context` 细目）。

```sql
CREATE TABLE IF NOT EXISTS context_breakdown (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  agent_aid       TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  turn            INTEGER NOT NULL,
  model           TEXT    NOT NULL,
  max_tokens      INTEGER NOT NULL,
  system_prompt   INTEGER,
  system_tools    INTEGER,
  mcp_tools       INTEGER,
  custom_agents   INTEGER,
  memory_files    INTEGER,
  skills          INTEGER,
  messages        INTEGER,
  free_space      INTEGER,
  total_estimated INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cb_session ON context_breakdown(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_cb_agent   ON context_breakdown(agent_aid, ts);
```

### 2.3.1 message_events 表

每条 AUN 网络消息（收/发，含系统消息）记录一行，用于网络流量统计。

```sql
CREATE TABLE IF NOT EXISTS message_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,         -- 时间戳 (ms)
  agent_aid   TEXT    NOT NULL,         -- 本端 AID
  peer_key    TEXT    NOT NULL,         -- channel#peerId（对端）
  direction   TEXT    NOT NULL,         -- 'in' | 'out'
  msg_type    TEXT,                     -- 'private' | 'group' | 'system'
  bytes       INTEGER NOT NULL DEFAULT 0,
  encrypted   INTEGER DEFAULT 0,       -- 0/1
  chatmode    TEXT                      -- 模式标记（如有）
);

CREATE INDEX IF NOT EXISTS idx_me_ts       ON message_events(ts);
CREATE INDEX IF NOT EXISTS idx_me_agent_ts ON message_events(agent_aid, ts);
CREATE INDEX IF NOT EXISTS idx_me_peer_ts  ON message_events(agent_aid, peer_key, ts);
```

**写入时机**：`AidStatsCollector.recordInbound()` 和 `recordOutbound()` 每次调用时通过回调写入。
不存消息内容（隐私），只记方向/字节数/类型/加密标记。

### 2.4 model-prices.jsonl

每行一条价格记录，字段因模型/计费模式不同而不同。  
**查价逻辑**：取 `model` 匹配且 `effective_from <= event.ts` 中 `effective_from` 最大的一条。

```jsonl
{"model":"claude-opus-4-8","effective_from":1700000000000,"billing_fn":"per_token_v1","currency":"USD","price_input":15,"price_output":75,"price_cache_creation":18.75,"price_cache_read":1.5}
{"model":"deepseek-v3","effective_from":1700000000000,"billing_fn":"per_token_deepseek_v1","currency":"CNY","price_output":2.0,"price_cache_hit":0.1,"price_cache_miss":1.0}
{"model":"deepseek-v3","effective_from":1720000000000,"billing_fn":"per_token_deepseek_v1","currency":"CNY","price_output":1.0,"price_cache_hit":0.05,"price_cache_miss":0.5}
{"model":"gemini-2.5-pro","effective_from":1700000000000,"billing_fn":"per_token_tiered_v1","currency":"USD","tiers":[{"up_to_tokens":128000,"price_input":1.25,"price_output":10.0,"price_cache_read":0.31},{"up_to_tokens":null,"price_input":2.50,"price_output":20.0,"price_cache_read":0.62}]}
{"model":"qwen-vl-max","effective_from":1700000000000,"billing_fn":"per_token_image_v1","currency":"CNY","price_input":3.0,"price_output":9.0,"price_image":3.0}
{"model":"moonshot-v1-8k","effective_from":1700000000000,"billing_fn":"per_token_v1","currency":"CNY","price_input":12.0,"price_output":12.0}
```

**新增计费模式**：在 `billing.ts` 注册新函数 ID，价格表追加带新 `billing_fn` 的记录；旧事件历史费用不受影响。

### 2.5 model-aliases.jsonl

模型 ID 映射表——LLM 接口返回的 model ID 常带日期/版本号，而定价表中使用简化规范 ID。  
查价时先精确匹配，找不到则通过此表映射到规范 ID 再查。

```jsonl
{"alias":"claude-opus-4-8-20250514","canonical":"claude-opus-4-8"}
{"alias":"claude-opus-4-8-20250601","canonical":"claude-opus-4-8"}
{"alias":"deepseek-chat","canonical":"deepseek-v3"}
{"alias":"deepseek-chat-v3-0527","canonical":"deepseek-v3"}
{"alias":"gemini-2.5-pro-preview-0506","canonical":"gemini-2.5-pro"}
```

手动维护，append-only。无对应 alias 时以原始 model ID 精确匹配价格表。

### 2.6 budgets.json

```json
{
  "global": {
    "daily_usd": 10.0,
    "monthly_usd": 100.0,
    "hard_limit_pct": 100,
    "soft_limit_pct": 80,
    "auto_limit_pct": 60,
    "on_hard_limit": "block",
    "downgrade_model": "claude-haiku-4-5-20251001"
  },
  "agents": {
    "alice.agentid.pub": { "daily_usd": 3.0 }
  },
  "peers": {
    "feishu#ou_xxx": { "daily_usd": 1.0 }
  }
}
```

---

## 3. 模块划分

```
src/core/stats/
├── db.ts           ← SQLite 初始化（建表、WAL、索引）；lazy 单例
├── writer.ts       ← insertUsageEvent() + insertContextBreakdown()
├── normalizer.ts   ← 各模型 raw usage → 归一化字段 + 推断 billing_fn
├── billing.ts      ← 读 model-prices.jsonl，按 billing_fn 调算法函数
├── query.ts        ← 聚合查询（CLI + ecweb 共用，只读）
├── budget.ts       ← 预算检查（三档）；读 budgets.json + query.ts
└── eck-vars.ts     ← 组装 $STATS_* 注入变量（分层，保护 cache）

src/cli/stats.ts            ← ec stats 命令（见 token-stats-cli.md）
ecweb/src/sources/stats.ts  ← ecweb 数据源，node:sqlite 只读连接
ecweb/src/static/           ← Dashboard + Explorer tab（ECharts CDN）
```

### 3.1 数据流

```
claude-runner complete 事件
  └→ normalizer.ts（raw usage + 推断 billing_fn）
      └→ writer.ts（INSERT usage_events）
          └→ budget.ts（检查是否超限，决定下轮行为）
              └→ AUN notify → Evol 前端（本轮用量摘要）
              └→ IPC → ecweb WebSocket（Dashboard 实时刷新）

human turn 构造时
  └→ writer.ts（INSERT context_breakdown，各段估算 token 数）

message-processor 入口
  └→ budget.ts（硬上限检查，超限直接返回，不调模型）

渲染层（manifest when 条件）
  └→ budget.ts（读软上限/自主上限状态）
      └→ 激活节流 fragment / 注入预算 ECK vars
```

---

## 4. 各模型归一化策略（normalizer.ts）

按实际有什么字段智能推断，不假设字段存在。

**两层分离**：
- **归一化层**（normalizer）：关心 API 响应风格（有哪些字段），统一读进 DB 的标准列，同时推断 `billing_fn`
- **计费层**（billing）：关心模型，按 model ID 查 `model-prices.jsonl`（配合 `model-aliases.jsonl` 映射）取价格行

两者正交——同一模型经不同网关可能推断到不同 `billing_fn`（DeepSeek 直连 vs OpenAI 兼容截断网关），费用计算结果不同，反映真实账单。

探测顺序（按字段唯一性从高到低）：

| 探测条件 | 推断 billing_fn | 填充字段 |
|---|---|---|
| 有 `cache_hit_tokens` 或 `cache_miss_tokens` | `per_token_deepseek_v1`（DeepSeek） | cache_hit / cache_miss / output |
| 有 `promptTokenCount`（Gemini 原生） | `per_token_tiered_v1` | input / output / cache_read；填 total_context_tokens |
| 有 `image_tokens` | `per_token_image_v1`（Qwen-VL 等） | input / output / image |
| 有 `cache_creation_input_tokens` 或 `cache_read_input_tokens` | `per_token_v1`（Anthropic/Claude） | input / output / cache_creation / cache_read |
| 仅有 `prompt_tokens` / `completion_tokens`（OpenAI 兼容降级） | `per_token_v1`（通用） | input / output，cache 补 0 |

---

## 5. 计费引擎（billing.ts）

| 函数 ID | 适用场景 |
|---|---|
| `per_token_v1` | Claude / OpenAI 兼容 / Kimi / MiniMax |
| `per_token_tiered_v1` | Gemini（按上下文长度分档） |
| `per_token_deepseek_v1` | DeepSeek（cache_hit / cache_miss 口径） |
| `per_token_image_v1` | Qwen-VL / GPT-4o 视觉模型 |

签名：`(event: UsageEvent, priceRow: PriceRecord) => { usd?: number; cny?: number }`

费用**查询时实时计算**，不存入 DB（价格可能变动，存进去会产生历史错误）。

---

## 6. 预算三档控制

```
消耗比例:  0% ──── auto_limit_pct ──── soft_limit_pct ──── hard_limit_pct(100%)
                        ↓                      ↓                    ↓
                   自主上限               软上限               硬上限
               ECK vars 注入           渲染层节流          消息入口拦截
               agent 自主决策         切模型/缩上下文      直接返回提示
```

### 硬上限（Hard Limit）
- **位置**：`message-processor.ts` 消息入口，调模型之前
- **行为**：不调模型，直接向对端返回系统提示（"已达用量上限"），零 token 消耗
- **维度**：global / per-agent / per-peer，daily / monthly

### 软上限（Soft Limit）
- **位置**：渲染层（manifest when 条件），system prompt 组装时
- **行为**：激活节流 fragment（切换低价模型 / 缩减上下文段 / 缩短输出指令）
- **特点**：agent 正常响应，行为受渲染层约束，用户无感

### 自主上限（Autonomous Limit）
- **位置**：消息提示词（human turn 前插入，**不注入 system prompt**，保护 cache）
- **行为**：注入预算 ECK vars，agent persona 规则决定响应（切模型 / 告知用户 / 拒复杂任务）
- **特点**：agent 自主感知，行为由 persona 定义

---

## 7. ECK 变量注入分层

**原则：保护 prompt cache——变化频繁的变量不注入 system prompt。**

| 变量 | 注入位置 | 变化频率 | 说明 |
|---|---|---|---|
| `$STATS_TODAY_INPUT_TOKENS` | system prompt | 慢（分钟级） | 日内基本稳定 |
| `$STATS_TODAY_OUTPUT_TOKENS` | system prompt | 慢 | 同上 |
| `$STATS_TODAY_CACHE_HIT_RATE` | system prompt | 慢 | cache_read / (input+cache_read) |
| `$STATS_TODAY_COST_USD` | system prompt | 慢 | |
| `$STATS_TODAY_COST_CNY` | system prompt | 慢 | |
| `$STATS_TODAY_CALL_COUNT` | system prompt | 慢 | |
| `$STATS_BUDGET_DAILY_LIMIT_USD` | system prompt | 极慢（配置变才变） | |
| `$STATS_BUDGET_DAILY_USED_USD` | system prompt | 慢 | |
| `$STATS_BUDGET_DAILY_REMAINING_USD` | system prompt | 慢 | |
| `$STATS_BUDGET_PCT_USED` | system prompt | 慢 | |
| `$STATS_BUDGET_WARN` | system prompt | 触发时变 | 超软上限才插入节流 fragment |
| `$STATS_BUDGET_AUTO_WARN` | **消息提示词** | 触发时变 | 超自主上限插入 human turn |
| `$SESSION_TURN_COUNT` | **消息提示词** | 每轮变 | 不污染 system cache |
| `$SESSION_LLM_CALL_COUNT` | **消息提示词** | 每轮变 | 同上 |
| `$STATS_CTX_TOTAL_TOKENS` | **消息提示词** | 每轮变 | |
| `$STATS_CTX_PCT` | **消息提示词** | 每轮变 | |
| `$STATS_CTX_SYSTEM_TOKENS` | **消息提示词** | 每轮变 | |
| `$STATS_CTX_MESSAGES_TOKENS` | **消息提示词** | 每轮变 | |
| `$STATS_PEER_TODAY_COST_USD` | system prompt | 慢 | |
| `$STATS_PEER_TODAY_COST_CNY` | system prompt | 慢 | |

---

## 8. 通知与前端

### Evol 前端（AUN 消息）
每轮大模型调用结束后，evolclaw 向对端发一条 `status.completed` 事件（见 §11 完整 payload），
其 `metadata` 中包含本轮 token 用量、费用、cache 命中率、模型能力参数、会话累计。
前端解析此一条即可获取所有用量信息，不再单独发 custom 事件。

Evol 前端未收到通知时（超时/离线），通过 `ec stats` CLI 主动查询（见 token-stats-cli.md）。

### ecweb（WebSocket）
主进程通过 IPC → ecweb WebSocket 推同样的事件，Dashboard 实时刷新，不需要轮询。

---

## 9. Web 看板（ecweb）

### 9.1 技术栈
- 后端：`ecweb/src/sources/stats.ts`，`node:sqlite` 只读连接，HTTP GET endpoints
- 图表：ECharts 5（CDN：`https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js`）
- 主题：CSS variables，亮色（默认）/ 暗色切换，`localStorage` 持久化

### 9.2 亮色主题（新增默认）
```css
[data-theme="light"] {
  --bg: #f5f7fa;  --bg2: #ffffff;  --bg3: #eef1f6;
  --border: #e2e6ed;  --fg: #1a202c;  --dim: #718096;
  --accent: #4f6ef7;  --green: #38a169;  --red: #e53e3e;  --orange: #dd6b20;
}
```

### 9.3 Dashboard 页
- **topbar 常驻**：今日费用（USD + CNY）始终可见，无需切 tab
- **今日卡片行**：Input / Output / Cache 命中率 / 费用 / 调用次数
- **24 小时 stacked bar**：按小时，input/output/cache 堆叠
- **模型分布饼图**：今日各模型 token 占比
- **对端 Top 5**：今日消耗最多的 peer_key

### 9.4 Explorer 页
- **筛选栏**：时间范围 / agent / peer / model / session_id
- **粒度切换**：小时 / 天 / 周 / 月 / 按模型 / 按对端
- **图表区**：折线图（token 趋势）+ 柱状图（费用）双 Y 轴（左 tokens，右 USD）
- **Context Breakdown 视图**：选定 session 后，显示每轮各段 token 占比变化折线
- **明细表格**：分页，列：ts / peer / model / input / output / cache_hit_rate / 费用 / ctx_pct

---

## 10. 所有设计决策确认清单

- [x] 存储路径：`$EVOLCLAW_HOME/data/stats/`
- [x] 数据保留：按自然年归档到独立 `usage-{year}.db`，主库只保留最近约一年；查询跨年时自动附加归档库
- [x] 价格表：append-only JSONL，`billing_fn` 字段绑定算法函数；新价格追加新行，旧历史不变
- [x] 模型 ID 映射：`model-aliases.jsonl`，查价时精确匹配失败则映射到规范 ID 再查
- [x] 模型能力参数：`model-specs.jsonl`（context_window / max_input_tokens / max_output_tokens / supports_cache / supports_vision），按 effective_from 取最新
- [x] 归一化：按实际响应字段智能推断 `billing_fn`（归一化层关心 API 风格，计费层关心模型，两者正交）
- [x] 货币：USD 和 CNY 各自独立计算，跟随价格表 `currency` 字段，无汇率表，不做换算；前端切换展示
- [x] 预算三档：硬上限（入口拦截）/ 软上限（渲染层节流）/ 自主上限（消息提示词注入），支持 daily + monthly
- [x] cache 保护：会话级动态变量（turn_count / ctx_pct 等）注入消息提示词，不注入 system prompt
- [x] Evol 前端通知：合并到 `status.completed`（不再单独发 custom 事件），带 cost_usd/cost_cny/cache_hit_rate/model_spec/session_total
- [x] ecweb：WebSocket 实时推送 + HTTP API（/api/stats/dashboard, /api/stats/explorer, /api/stats/peers）
- [x] 图表库：ECharts 5 CDN
- [x] 主题：亮色（默认）+ 暗色切换，`localStorage` 持久化
- [x] context_breakdown：ECK 渲染层旁路采集（字符数/4 估算 token）
- [x] `ec stats --peer` AUN 简写：不含 `#` 时自动前缀 `aun#`
- [x] `ec stats --by model/peer/agent` 非时间维度分组
- [x] `ec stats --top-models` 各模型用量占比
- [x] `ec stats --sql "SELECT ..."` 直接执行只读 SQL，灵活查询
- [x] `ec stats --traffic` 网络流量统计（message_events 表，按 agent/peer/时间维度聚合）
- [x] `status.completed` 包含会话累计（session_total：input/output/cache_read/cache_creation/cost_usd/cost_cny/call_count）+ 模型能力参数（model_spec）

---

## 11. status.completed 完整 payload

每轮任务完成后向对端推送，前端解析此一条即可获取所有用量信息：

```json
{
  "kind": "status.completed",
  "metadata": {
    "durationMs": 3200,
    "ttftMs": 450,
    "numTurns": 3,
    "tokenUsage": {
      "input_tokens": 1200,
      "output_tokens": 340,
      "cache_read_input_tokens": 800,
      "cache_creation_input_tokens": 200
    },
    "contextUsage": {
      "totalTokens": 2200,
      "maxTokens": 1000000,
      "percentage": 0,
      "model": "claude-opus-4-8",
      "effort": "high"
    },
    "cost_usd": 0.028,
    "cost_cny": 0,
    "cache_hit_rate": 0.4,
    "model_spec": {
      "context_window": 1000000,
      "max_input_tokens": 900000,
      "max_output_tokens": 32768
    },
    "session_total": {
      "input_tokens": 5600,
      "output_tokens": 1200,
      "cache_read_tokens": 3200,
      "cache_creation_tokens": 800,
      "cost_usd": 0.12,
      "cost_cny": 0,
      "call_count": 4
    }
  }
}
```

---

## 12. 已实现文件清单

### 主包 `src/`

| 文件 | 角色 |
|------|------|
| `src/core/stats/db.ts` | SQLite 初始化、WAL、建表、索引、归档 |
| `src/core/stats/normalizer.ts` | 各模型字段智能推断 billing_fn |
| `src/core/stats/writer.ts` | INSERT usage_events + context_breakdown |
| `src/core/stats/billing.ts` | 计费引擎 + 价格表 + model-specs 读取 |
| `src/core/stats/query.ts` | 聚合查询（跨年归档支持） |
| `src/core/stats/budget.ts` | 三档预算控制 |
| `src/core/stats/eck-vars.ts` | ECK 变量分层注入 |
| `src/core/stats/index.ts` | 公开 API |
| `src/cli/stats.ts` | `ec stats` CLI 命令 |
| `src/cli/index.ts` | 注册 stats 子命令 |
| `src/core/message/message-processor.ts` | 硬上限 + stats 写入 + context_breakdown + status.completed 增强 |

### ecweb

| 文件 | 角色 |
|------|------|
| `ecweb/src/sources/stats.ts` | 只读 SQLite 数据源 + peers 聚合 |
| `ecweb/src/server.ts` | HTTP endpoints（dashboard/explorer/peers） |
| `ecweb/src/static/index.html` | Usage tab（Dashboard + Explorer）+ ECharts + 主题切换 |
| `ecweb/src/static/style.css` | 亮色/暗色双主题 + Usage 样式 |
| `ecweb/src/static/app.js` | Dashboard 渲染 + Explorer 交互 + 主题切换 |

### 数据文件

| 文件 | 内容 |
|------|------|
| `$PACKAGE_ROOT/data/stats/model-prices.jsonl` | 25 个模型初始价格表 |
| `$PACKAGE_ROOT/data/stats/model-specs.jsonl` | 模型能力参数 |
| `$PACKAGE_ROOT/data/stats/model-aliases.jsonl` | 模型 ID 映射（带版本号 → 定价表规范 ID） |

