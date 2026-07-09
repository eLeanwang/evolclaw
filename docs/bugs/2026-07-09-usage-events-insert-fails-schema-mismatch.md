# usage_events 写入静默失败导致「session消耗 < 本轮消耗」

- 日期：2026-07-09
- 库：`~/.evolclaw/data/stats/usage.db`（daemon 跑的是**本仓库** `H:\project\evolclaw` 产物）
- 现象 session：`meta_20260608_1780912604021`
- 结论：**不是求和顺序 bug，也不是"历史成本没回填"，而是 `usage_events` 表结构比代码旧了两列，导致每一轮的 INSERT 都抛异常被静默吞掉。**

---

## 一、用户观察到的现象

模型完成回执里三个数：

- 本轮消耗（turn）：`cost.official.usd = 0.28711035`
- 最后一次调用（lastModelCall）：`0.0187572`
- 当前 session 累计（session_total）：`0.004273428879`（gateway）/ `0.0257472`（official）

**session 累计 < 本轮消耗**，明显不合理——session 至少应 ≥ 本轮。

---

## 二、排查过程与铁证

### 1. token 列正确，只有 cost 看着不对（第一层假象）

`session_total` 的 token 是对的：`output_tokens=2547`、`cache_read_tokens=1327423`。
按 sonnet-4-6 官方价（input 3 / output 15 / cache_creation 3.75 / cache_read 0.3，USD per 1M）重算这些 token，官方成本应≈ **1.99 USD**，但 `session_total` 只报了 **0.0257 USD**。
→ 说明 token 求和没问题，**问题在 cost 列**。

### 2. 拉出该 session 全部 18 行：只有最后 1 行有 cost

```
row 1..17 : cost_official_usd = NULL   ← 全是 NULL
row 18    : cost_official_usd = 0.0257472   (ts=1781508343114 = 2026-06-15 15:25:43)
```

`querySessionSummary` 用 `COALESCE(SUM(cost_official_usd),0)`（`src/stats/query.ts:370`），**SUM 跳过 NULL**，于是 session 累计 = 只有第 18 行那一行的钱。
用第 18 行自己的 token（i=142,o=47,cc=684,cr=73504）重算官方价，**正好 = 0.0257472**，分毫不差。

> 到这一步，一度以为是"历史行 cost 列为 NULL、需要 `ec stats --rebuild` 回填"。**这个结论是错的**，见下。

### 3. 关键反证：本轮记录根本没进 usage_events

按本轮 token 特征（output=581 / cache_read=222677 / cache_creation=56419）查 `usage_events`：**匹配 0 行**。
`usage_events` 今天（07-09）**总共只有 1 行**，还是中午 12:34 别的 session 写的——本轮（~18:04）完全不在表里。

### 4. 但同一轮成功写进了 model_calls

`model_calls` 今天有 **8 行**，其中包含本轮：`2026-07-09 18:04:09 (o=46)`、`17:50:31 (o=7)`——正是回执里 `lastModelCall`（msgId `msg_011CcrJ15YyBHzNwBUAGXLmz`，output=46）那次。

→ **同一轮：`model_calls` 写成功，`usage_events` 写失败。** 这排除了"DB 不可用""进程没跑"等整体性原因，指向 `usage_events` 这条 INSERT 本身。

### 5. 直接复现 INSERT 失败

把 `usage.db` 拷一份，拿代码里的 INSERT 语句 `prepare`：

```
table usage_events has no column named usage_subject_key
```

实际 `usage_events` 表的列（PRAGMA table_info）：

```
id, ts, agent_aid, peer_key, peer_type, session_id, model, billing_fn,
input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
cache_hit_tokens, cache_miss_tokens, image_tokens, total_context_tokens,
turns, duration_ms, context_window_pct,
cost_official_usd, cost_official_cny, cost_gateway_usd, cost_gateway_cny
```

**没有 `usage_subject_key`，也没有 `role`。**
而代码 INSERT 的列清单里有这两列（`src/stats/writer.ts:41-49`，编译产物 `dist/stats/writer.js:17` 一致）：

```sql
INSERT INTO usage_events
  (ts, agent_aid, peer_key, usage_subject_key, role, peer_type, session_id, ...)
```

列对不上 → 整条 INSERT 抛异常。

---

## 三、根因

### 3.1 表结构比代码旧两列

代码期望 `usage_events` 含 `usage_subject_key` / `role` 两列，并在 `getDb()` 里带补列迁移（`src/stats/db.ts:236-243`）：

```js
if (!cols.some(c => c.name === 'usage_subject_key')) {
  db.exec(`ALTER TABLE usage_events ADD COLUMN usage_subject_key TEXT NOT NULL DEFAULT ''`);
}
if (!cols.some(c => c.name === 'role')) {
  db.exec(`ALTER TABLE usage_events ADD COLUMN role TEXT NOT NULL DEFAULT ''`);
}
```

但线上这张库**至今没有这两列**，说明该迁移**从未在当前 daemon 进程里成功执行过**。可能：

- daemon 常驻旧进程 / 旧编译产物，`getDb` 单例首次建连后不再重跑建表迁移；
- 或 `ALTER` 在 `try/catch` 中抛错被吞（`db.ts` 迁移块也是 catch 只 warn）。

### 3.2 写失败被静默吞掉，主流程无感

`insertUsageEvent`（`src/stats/writer.ts:104-110`）把 INSERT + rollup 包在一个事务里，catch 只打一句日志就返回：

```js
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  logger.warn(`[StatsWriter] insertUsageEvent failed: ${e}`);   // 只 warn，不抛
}
return prices;   // 照样把内存现算的价返回给回执
```

于是形成诡异组合：

| 通道 | 结果 | 原因 |
|---|---|---|
| 本轮 cost（0.287） | **正确显示** | 来自 `insertUsageEvent` **返回值**（内存现算），不依赖写库成败 |
| `usage_events` 落库 | **失败 / ROLLBACK** | INSERT 列名对不上，抛异常被 catch 吞 |
| `model_calls` 落库 | 成功 | 是另一条 INSERT（`insertModelCalls`），列名匹配，照写 |
| `session_total`（0.026） | 只剩旧行的钱 | 06-15 之后所有轮次 `usage_events` 写入全失败，SUM 停在最后一次成功写入的旧行 |

**这也解释了用户的疑问"最后一次为什么没成功记录、还要人工"**：不是老数据没回填，而是 **06-15 之后每一轮的 `usage_events` 写入都在实时失败**，一行没进。

---

## 四、为什么 `ec stats --rebuild` 解决不了

`--rebuild` 的回填只处理 `cost_official_usd IS NULL` 的**已存在行**（`src/cli/stats.ts:138-168`）。
本 bug 是**行本身缺失**（INSERT 就没成功），没有 NULL 行可填，回填无效。必须先修表结构让写入恢复。

---

## 五、修复建议（本次仅分析，未改动代码）

1. **补表结构（治本第一步）** —— 对 `~/.evolclaw/data/stats/usage.db`：
   ```sql
   ALTER TABLE usage_events ADD COLUMN usage_subject_key TEXT NOT NULL DEFAULT '';
   ALTER TABLE usage_events ADD COLUMN role TEXT NOT NULL DEFAULT '';
   ```
   补完后 INSERT 列匹配，新轮次可正常落库。

2. **确认 daemon 加载含迁移的新代码并重启**，否则单例重连仍走老路径、列迁移仍不生效。

3. **代码层防复发（建议）**：
   - `insertUsageEvent` 的 catch 目前是 `logger.warn` 且吞异常——正是本 bug 潜伏约三周（06-15→07-09）无人察觉的根源。应升级为 `error`，并在检测到 "no column" 类 schema 错误时**重跑 `_initTables` 迁移后重试一次**（写失败自愈）。
   - schema migration 不应只在 `getDb` 首次建连时跑一次；列缺失是"写时才暴露"的，需让写路径能触发自愈。
   - 可考虑：INSERT 失败时在回执 metadata 里带一个 `stats_write_ok=false` 标记，避免"本轮有数、session 停滞"这种矛盾静默发生。

---

## 六、结论

- **不是** 求和顺序 bug（先写后 SUM 顺序正确）。
- **不是** 字段命名口径不一致（token 列命名/求和都正确）。
- **不是** 单纯"历史成本没回填"。
- **是** `usage_events` 表缺 `usage_subject_key` / `role` 两列，与代码 INSERT 不匹配，导致 06-15 之后每轮写入静默失败；`session_total` 因此停滞在最后一次成功写入的旧行，远小于内存现算的本轮消耗。
