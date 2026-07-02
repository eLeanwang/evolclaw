# 重构报告：费用计算从查询时迁移到写入时

**日期**：2026-06-14
**版本**：v3.4.0
**范围**：stats 子系统（计费、查询、展示）

---

## 1. 背景与动机

### 原有架构

```
模型调用 → normalizer → writer（只写 token 量）→ DB
                                                     ↓
查询时 → calcCost()（实时查价格表 × token）→ 返回 {usd, cny}
```

**设计理由**：价格可能变动，查询时实时算可自动适应调价。

### 问题

| # | 问题 | 影响 |
|---|---|---|
| 1 | ECWeb 独立进程找不到包基线价格表 | ECWeb 所有费用显示为 0 |
| 2 | 每个查询入口重复实现计费逻辑 | daemon `query.ts` vs ECWeb `stats.ts::_calcRowCost()` 口径不一致 |
| 3 | 查询时逐行调 calcCost | 数据量大时性能差（万条 × 查价格表 × 计费函数） |
| 4 | 不区分官方价格和网关真实价格 | 无法准确展示用户实际支出 |

### 根因分析

ECWeb 的 `_loadPrices()` 只读 `$EVOLCLAW_HOME/data/stats/model-prices.jsonl`（用户覆盖层），**不读包基线** `$PACKAGE_ROOT/data/stats/model-prices.jsonl`。而用户环境中覆盖层文件不存在 → `_resolvePrice()` 返回 null → `_calcRowCost()` 返回 `{usd: 0, cny: 0}`。

---

## 2. 新架构

```
模型调用 → normalizer → writer
                          ├─ resolvePrices(event, gatewayCache?)
                          │   ├─ 官方价格：网关接口 → model-prices.jsonl → NULL
                          │   └─ 网关价格：model-prices-gateway.jsonl → 网关接口 → 回退官方
                          │
                          ├─ INSERT usage_events（含 cost_official_*, cost_gateway_*）
                          └─ UPSERT usage_daily（累加 cost_*）

查询时 → SELECT SUM(cost_*) FROM usage_daily（纯 SQL 聚合，无需查价格表）
```

### 设计原则

1. **写入时算一次**：费用在事件产生时确定，存入 DB
2. **区分两套价格**：官方（成本核算）+ 网关（用户实际支出）
3. **统一入口**：所有查询端（CLI / ECWeb / ECK 变量）从 DB 读取
4. **向后兼容**：rebuild 命令回填历史，旧字段 `usd`/`cny` 映射到网关价格

---

## 3. 变更清单

### 新增文件

| 文件 | 作用 |
|---|---|
| `src/core/stats/price-resolver.ts` | 统一价格解析模块，支持官方 + 网关两套价格回退 |

### 修改文件

| 文件 | 变更内容 |
|---|---|
| `src/core/stats/billing.ts` | 导出 `BILLING_FNS`（原为 `const`，改为 `export const`） |
| `src/core/stats/db.ts` | Schema: `usage_events` / `usage_daily` 新增 4 列；Migration: 自动检测旧库并 ALTER；`rebuildDailyRollup()` 聚合 cost 列 |
| `src/core/stats/writer.ts` | `insertUsageEvent()` 增加可选参数 `gatewayPricing`，写入时调 `resolvePrices()` 计算并存储 cost |
| `src/core/stats/query.ts` | `queryAggregated`/`querySummary`/`queryTodaySummary` 改为从 DB 直接读 cost 列；`_enrichRow` 简化；`AggRow`/`PeerListRow`/`SummaryRow` 增加 cost 字段 |
| `src/core/stats/eck-vars.ts` | `_calcTodayCosts()` 改为单条 SUM SQL，不再逐行 calcCost |
| `src/cli/stats.ts` | `--rebuild` 增加回填 cost 逻辑；`--summary` 展示 Official/Gateway 两种价格 |
| `ecweb/src/sources/stats.ts` | 删除 `_loadPrices`/`_loadAliases`/`_resolvePrice`/`_calcRowCost`（约 80 行）；`queryStatsForDashboard`/`queryStatsOverview` 改为读 DB cost 列 |

### 删除代码（约 80 行）

- `ecweb/src/sources/stats.ts` 中的轻量计费逻辑（`_loadPrices`, `_loadAliases`, `_resolvePrice`, `_calcRowCost`）

---

## 4. Schema 变更

### 新增列

```sql
-- usage_events
ALTER TABLE usage_events ADD COLUMN cost_official_usd REAL;
ALTER TABLE usage_events ADD COLUMN cost_official_cny REAL;
ALTER TABLE usage_events ADD COLUMN cost_gateway_usd REAL;
ALTER TABLE usage_events ADD COLUMN cost_gateway_cny REAL;

-- usage_daily
ALTER TABLE usage_daily ADD COLUMN cost_official_usd REAL;
ALTER TABLE usage_daily ADD COLUMN cost_official_cny REAL;
ALTER TABLE usage_daily ADD COLUMN cost_gateway_usd REAL;
ALTER TABLE usage_daily ADD COLUMN cost_gateway_cny REAL;
```

### 字段语义

| 字段 | 含义 | 来源 |
|---|---|---|
| `cost_official_usd` | 官方价格计算的 USD 费用 | `model-prices.jsonl` 或网关 `pricing` 字段 |
| `cost_official_cny` | 官方价格计算的 CNY 费用 | 同上 |
| `cost_gateway_usd` | 网关真实价格计算的 USD 费用 | `model-prices-gateway.jsonl` 或网关 `effective_pricing` 字段 |
| `cost_gateway_cny` | 网关真实价格计算的 CNY 费用 | 同上 |

### Migration 策略

- `_initTables()` 中自动检测 `PRAGMA table_info` 判断是否已有 cost 列
- 缺失则执行 `ALTER TABLE` 添加（非破坏性，不影响旧数据）
- 旧数据 cost 列为 NULL，需执行 `ec stats --rebuild` 回填

---

## 5. 价格解析逻辑

### 官方价格优先级

1. 网关 `/v1/models` 返回的 `pricing` 字段（实时缓存）
2. 本地 `model-prices.jsonl`（包基线 + 用户覆盖层合并）
3. 查不到 → 存为 NULL

### 网关价格优先级

1. 用户手动设置（`$EVOLCLAW_HOME/data/stats/model-prices-gateway.jsonl`）
2. 网关 `/v1/models` 返回的 `effective_pricing` 字段
3. 查不到 → **回退到官方价格**（实际收费 = 成本价）

### 计费函数复用

price-resolver 复用 billing.ts 导出的 `BILLING_FNS` 和 `resolvePriceRow`，无需重复实现。

---

## 6. 性能影响

### 写入路径

| 操作 | 新增开销 | 评估 |
|---|---|---|
| 查价格表 | 内存 Map 查找（5min TTL 缓存） | < 0.1ms |
| 计费算法 | 4 次乘法 + 加法 | 可忽略 |
| 额外 4 个 bind 参数 | SQLite prepare | 可忽略 |
| **总增量** | | **< 1ms / event** |

### 查询路径

| 场景 | 旧耗时 | 新耗时 | 提升 |
|---|---|---|---|
| 今日概览（100 条） | 100 × calcCost | 1 × SUM SQL | ~100x |
| 月度统计（5000 条） | 5000 × calcCost | 1 × SUM SQL | ~5000x |
| ECWeb Overview（全量） | N × _calcRowCost | 1 × SUM SQL | 显著 |

---

## 7. 向后兼容

### 接口兼容

- `AggRow.usd` / `AggRow.cny` 保留，赋值为 `cost_gateway_*`
- `PeerListRow.usd` / `PeerListRow.cny` 同上
- ECWeb API 返回 `cost_usd` / `cost_cny` 字段不变（值为网关价格）

### 数据兼容

- 旧数据 cost 列为 NULL → `COALESCE(SUM(...), 0)` 处理
- `ec stats --rebuild` 回填后数据完整

### 代码兼容

- `calcCost()` 保留，仅 rebuild 和部分辅助函数使用
- `billing.ts` 无破坏性变更（仅 `const` → `export const`）

---

## 8. 部署与回填

### 部署步骤

1. 更新代码并构建 → Schema 自动 migration（添加列，零停机）
2. 重启 daemon → 新事件自动写入 cost 字段
3. 执行回填：

```bash
ec stats --rebuild
```

### 回填逻辑

1. 查询所有 `cost_official_usd IS NULL` 的 usage_events
2. 逐批（1000 条/事务）调用 `resolvePrices()` 回填
3. 全量重建 `usage_daily`（聚合 cost）

### 回填说明

- 回填时不传 `gatewayPricing` 参数（网关接口不保留历史）
- 历史数据的网关价格回退到官方价格（gateway = official）
- 仅新增事件才能获得真实的网关价格差异

---

## 9. 后续优化（可选）

| 项目 | 说明 | 优先级 |
|---|---|---|
| message-processor 传入 gatewayPricing | 让新事件获得真实网关价格 | P1 |
| ECWeb "改价"支持选择价格类型 | 区分改官方价格 vs 改网关价格 | P2 |
| 完全移除 query.ts 中的 calcCost 调用 | queryPeerDaily 等辅助函数迁移 | P3 |
| 前端展示区分两种价格 | ECWeb Dashboard 增加 Official/Gateway 切换 | P3 |
| 删除 billing.ts 的 calcCost 函数 | 迁移完成后清理 | P4 |

---

## 10. 影响范围

### 测试覆盖

- [x] 编译通过（TypeScript 零错误）
- [ ] 单元测试：price-resolver 价格回退逻辑
- [ ] 集成测试：写入 → 查询 → 验证 cost 非零
- [ ] 回归测试：EC CLI `ec stats --summary` / `--rebuild`
- [ ] 前端测试：ECWeb Dashboard 费用显示

### 风险评估

| 风险 | 级别 | 缓解措施 |
|---|---|---|
| 旧数据 cost 为 NULL 导致聚合为 0 | 低 | rebuild 回填；COALESCE 兜底 |
| 价格表缺失导致新事件 cost 为 NULL | 低 | 与旧行为一致（旧架构也是返回 0） |
| usage_daily 累加精度 | 极低 | SQLite REAL 为 64 位浮点，精度足够 |
