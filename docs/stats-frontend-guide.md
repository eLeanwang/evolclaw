# 统计数据前端取数指南

本文档说明前端如何通过 aun 远程命令获取 evolclaw 的统计数据。所有统计命令均为**只读**,
经消息通道透传执行,仅 owner 可调用。

---

## 1. 调用机制

前端通过 aun 渠道发送 `menu.action`(`name=cli`, `action=exec`)远程执行 `ec stats` 命令。

### 请求

```jsonc
{
  "name": "cli",
  "action": "exec",
  "args": {
    // 二选一:
    "argv": ["stats", "--peers", "--month", "--format", "json"],   // 推荐:数组,无需分词
    "command": "stats --peers --month --format json"                // 或:字符串,服务端按引号分词
  }
}
```

### 响应

成功:
```jsonc
{
  "data": {
    "exitCode": 0,
    "stdout": "<命令标准输出，--format json 时即 JSON 文本>",
    "stderr": "",
    "truncated": false,        // true = 输出超 128KB 被截断
    "durationMs": 123
  }
}
```

失败:
```jsonc
{ "error": "错误信息", "code": "NO_PERMISSION | NOT_ALLOWED | TIMEOUT | INTERNAL | ..." }
```

### 约束(重要)

| 约束 | 值 | 说明 |
|---|---|---|
| 权限 | 仅 owner | 非 owner 返回 `NO_PERMISSION` |
| 白名单 | `stats` 全子命令放行 | 已配置,无需改动 |
| 服务端超时 | **15 秒** | 超时返回 `code=TIMEOUT`;前端等待超时应 **≥ 15s** |
| 输出上限 | **128KB** | 超出 `truncated=true`;大结果集请用时间范围/limit 收窄 |

**前端务必加 `--format json`**,然后 `JSON.parse(response.data.stdout)` 得到结构化数据。
不加则返回人读表格文本。

---

## 2. 通用参数

下列参数可与多数命令组合:

| 参数 | 含义 |
|---|---|
| `--format json` | **必加**,JSON 输出 |
| `--today`(默认) | 今日 |
| `--week` | 本周 |
| `--month` | 本月 |
| `--from <YYYY-MM-DD> --to <YYYY-MM-DD>` | 任意区间(to 排他) |
| `--agent <aid>` | 限定某 agent(不传=该库全部 agent) |
| `--limit <N>` | 列表类命令的返回条数上限 |

时间范围说明:`--peers/--groups/--summary/--peer-detail` 默认时间窗口是**今日**;
要看更大范围必须显式带 `--month` / `--week` / `--from..--to`。

---

## 3. 各接口详解

### 3.1 私聊列表 / 群聊列表

**用途**:当前 agent 和谁单聊(私聊列表)、在哪些群(群聊列表),每项带累计汇总。

```bash
stats --peers  --month --format json      # 私聊
stats --groups --month --format json      # 群聊
stats --peers  --month --limit 20 --format json
```

返回 `PeerListRow[]`:
```jsonc
[
  {
    "peer_key": "aun#1lwj.agentid.pub#main#lwjccccc.agentid.pub",  // 完整路由键(回查用)
    "peer_id": "lwjccccc.agentid.pub",     // 解析后的裸对端AID(私聊)/群ID(群聊)——直接展示
    "peer_type": "private",                // private | group
    "input_tokens": 4315,
    "output_tokens": 21686,
    "cache_creation_tokens": 320083,
    "cache_read_tokens": 2972055,
    "total_tokens": 3318139,               // 四项之和
    "calls": 15,                           // 调用次数
    "session_count": 2,                    // 涉及多少个会话
    "first_day": "2026-06-08",             // 最早活跃日
    "last_day": "2026-06-08",              // 最近活跃日
    "usd": 0,
    "cny": 0
  }
]
```
按 `total_tokens` 降序。群聊的 `peer_id` 形如 `group.agentid.pub/11722` 或 `11722.agentid.pub`。

### 3.2 总消耗汇总

**用途**:指定时间范围(可选对端)的总消耗,一行。

```bash
stats --summary --month --format json
stats --summary --from 2026-06-01 --to 2026-06-09 --format json
stats --summary --month --agent bot.agentid.pub --format json
```

返回 `SummaryRow`(单对象):
```jsonc
{
  "input_tokens": 6611,
  "output_tokens": 27062,
  "cache_creation_tokens": 544193,
  "cache_read_tokens": 3886867,
  "total_tokens": 4464733,
  "calls": 28,
  "cache_hit_rate": 0.998,        // 0~1
  "usd": 0,
  "cny": 0
}
```

### 3.3 对端按天明细

**用途**:某个对端/群在指定范围内,**每天**的消耗。

```bash
# 传裸对端 AID（推荐，前端从列表的 peer_id 拿）
stats --peer-detail lwjccccc.agentid.pub --month --format json
# 或传完整 peer_key（从列表的 peer_key 拿，精确匹配）
stats --peer-detail "aun#1lwj.agentid.pub#main#lwjccccc.agentid.pub" --month --format json
```
> 判定规则:参数含 `#` → 当作完整 peer_key 精确匹配;否则当作裸 peer_id 模糊匹配末段。

返回每天一行(`AggRow[]`):
```jsonc
[
  {
    "period": "2026-06-08",        // YYYY-MM-DD
    "input_tokens": 4315,
    "output_tokens": 21686,
    "cache_creation_tokens": 320083,
    "cache_read_tokens": 2972055,
    "cache_hit_tokens": 0,
    "cache_miss_tokens": 0,
    "image_tokens": 0,
    "total_context_tokens": 3296453,
    "turns": 62,
    "call_count": 15,
    "usd": 0,
    "cny": 0,
    "cache_hit_rate": 0.998
  }
]
```

### 3.4 时间序列聚合(无参/按粒度)

**用途**:整体趋势(不限对端)。

```bash
stats --month --format json                  # 本月按天
stats --month --by model --format json       # 本月按模型
stats --hour --format json                    # 最近24h按小时(走明细，仅此粒度)
```
`--by` 取值:`day|week|month|model|peer|agent`。返回 `AggRow[]`,`period` 随粒度变化
(日期串 / 模型名 / peer_key / agent_aid)。

### 3.5 单会话每轮明细

```bash
stats --session <sessionId> --format json            # 该会话历次 task 用量
stats --session <sessionId> --last --format json     # 最后一轮 + 会话累计(等价 status.completed)
```

### 3.6 逐次大模型调用明细(最细粒度)

**用途**:每一次大模型调用一行,关联 task / 会话 / SDK 会话。

```bash
stats --task-calls <taskId> --format json        # 一个 task 内的逐次调用
stats --session-calls <sessionId> --format json  # 一个会话内全部逐次调用
```

返回 `ModelCallDetailRow[]`:
```jsonc
[
  {
    "id": 1,
    "ts": 1780993416094,
    "task_id": "task-ab12cd34ef",        // 一次 runQuery
    "session_id": "meta_20260608_...",   // evolclaw 会话
    "agent_session_id": "sdk-...",       // base_agent(SDK) 会话
    "agent_aid": "1lwj.agentid.pub",
    "peer_key": "aun#...#main#...",
    "call_index": 0,                     // 该 task 内第几次调用(0起)
    "model": "claude-opus-4-8",
    "request_id": "req_...",             // SDK 请求ID(可能为 null)
    "message_id": null,
    "input_tokens": 100,
    "output_tokens": 50,
    "cache_creation_tokens": 10,
    "cache_read_tokens": 200,
    "degraded": 0                        // 1 = 非Claude降级，仅累计无逐次明细
  }
]
```
**注意**:`degraded=1` 表示该模型拿不到干净的逐次数据,这一行是整个 task 的累计值
(只有 call_index=0 一行)。Claude 模型通常 `degraded=0` 且逐次连续。

---

## 4. 统计口径(前端展示时须知)

理解数据粒度,避免误读:

- **一次大模型调用** → `model_calls` 一行(尽力而为,见 §3.6)。最细。
- **一次 task 执行(用户一条消息/一次 runQuery)** → `usage_events` 一行。其 token 是内部
  `turns` 次大模型调用的**累计**。这是权威的 task 级口径。
- **一天 × 对端 × 模型 ...** → `usage_daily` 一行(预聚合)。`--peers/--groups/--summary/
  --peer-detail` 及各聚合查询都读它,快。
- **一个会话** → 一个 `session_id`(`meta_*`),含多条 usage_events。

成本(`usd`/`cny`)是查询时按模型定价**实时计算**的,不入库;定价缺失时为 0。

`session_id` 是 **evolclaw 的会话 ID**,不是 SDK 的。SDK 会话是 `agent_session_id`
(仅 model_calls 表有)。

---

## 5. 前端取数最小示例(伪代码)

```js
async function fetchStats(argv) {
  const resp = await aun.sendMenuAction({
    name: 'cli', action: 'exec',
    args: { argv: [...argv, '--format', 'json'] },
  }, { timeoutMs: 20000 });           // ≥ 服务端 15s
  if (resp.error) throw new Error(`${resp.code}: ${resp.error}`);
  if (resp.data.exitCode !== 0) throw new Error(resp.data.stderr || 'stats failed');
  if (resp.data.truncated) console.warn('结果被截断,请收窄范围');
  return JSON.parse(resp.data.stdout);
}

// 用法
const peers   = await fetchStats(['stats', '--peers', '--month']);
const groups  = await fetchStats(['stats', '--groups', '--month']);
const summary = await fetchStats(['stats', '--summary', '--month']);
const detail  = await fetchStats(['stats', '--peer-detail', peers[0].peer_id, '--month']);
const calls   = await fetchStats(['stats', '--session-calls', someSessionId]);
```

---

## 6. 错误码

| code | 含义 | 前端处理 |
|---|---|---|
| `NO_PERMISSION` | 非 owner | 提示无权限 |
| `NOT_ALLOWED` | 命令不在白名单 | 不应出现(stats 已放行) |
| `TIMEOUT` | 服务端 15s 超时 | 收窄时间范围/limit 后重试 |
| `MISSING_VALUE` | 缺 argv/command | 检查请求体 |
| `INTERNAL` | 子进程错误 | 看 stderr |

命令本身的错误(如 SQL 错误)体现在 `data.exitCode !== 0` 与 `data.stderr`,需单独判断。
