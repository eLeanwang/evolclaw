/**
 * query.ts — 聚合查询（只读，供 CLI 和 ecweb 共用）。
 * 支持跨年查询：自动附加归档库。
 */

import path from 'path';
import { openReadonlyDb, getDbPath, listArchivePaths } from './db.js';
import { calcCost } from './billing.js';

export type Granularity = 'hour' | 'day' | 'week' | 'month' | 'model' | 'peer' | 'agent';

export interface StatsFilter {
  from_ts?: number;
  to_ts?: number;
  agent_aid?: string;
  peer_key?: string;
  model?: string;
  session_id?: string;
  billing_fn?: string;
}

export interface AggRow {
  period: string;          // strftime 结果
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  image_tokens: number;
  total_context_tokens: number;
  turns: number;
  call_count: number;
  usd: number;
  cny: number;
  cache_hit_rate: number;  // 0-1
}

/** 私聊/群聊列表项：一个对端/群的累计汇总。 */
export interface PeerListRow {
  peer_key: string;        // 完整 peer_key（aun#self#main#encode(peer)）
  peer_id: string;         // 解析出的裸对端 AID / 群 ID
  peer_type: string;       // 'private' | 'group'
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;    // input+output+cache_read+cache_creation
  calls: number;
  session_count: number;
  first_day: string;       // MIN(day)
  last_day: string;        // MAX(day)
  usd: number;
  cny: number;
}

/** 总消耗汇总（单行）。 */
export interface SummaryRow {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  calls: number;
  cache_hit_rate: number;  // 0-1
  usd: number;
  cny: number;
}

export interface TurnRow {
  ts: number;
  model: string;
  billing_fn: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  image_tokens: number | null;
  total_context_tokens: number | null;
  turns: number;
  duration_ms: number | null;
  context_window_pct: number | null;
  usd: number;
  cny: number;
}

const GRAN_FMT: Record<string, string> = {
  hour:  '%Y-%m-%d %H:00',
  day:   '%Y-%m-%d',
  week:  '%Y-W%W',
  month: '%Y-%m',
};

// 非时间维度：按字段分组
const GRAN_GROUP_COL: Record<string, string> = {
  model: 'model',
  peer:  'peer_key',
  agent: 'agent_aid',
};

function _buildWhere(f: StatsFilter): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.from_ts)    { conds.push('ts >= ?'); params.push(f.from_ts); }
  if (f.to_ts)      { conds.push('ts < ?');  params.push(f.to_ts); }
  if (f.agent_aid)  { conds.push('agent_aid = ?'); params.push(f.agent_aid); }
  if (f.peer_key)   { conds.push('peer_key = ?');  params.push(f.peer_key); }
  if (f.model)      { conds.push('model = ?');     params.push(f.model); }
  if (f.session_id) { conds.push('session_id = ?');params.push(f.session_id); }
  if (f.billing_fn) { conds.push('billing_fn = ?');params.push(f.billing_fn); }
  return { clause: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

/** 查询哪些归档库需要参与（给定时间范围）。 */
function _relevantDbs(evolclawHome: string, f: StatsFilter): string[] {
  const dbPaths: string[] = [getDbPath(evolclawHome)];
  if (!f.from_ts) return dbPaths; // 无时间下界，只查主库（最近数据）
  const fromYear = new Date(f.from_ts).getUTCFullYear();
  const toYear   = f.to_ts ? new Date(f.to_ts).getUTCFullYear() : new Date().getUTCFullYear();
  for (const { year, path: p } of listArchivePaths(evolclawHome)) {
    if (year >= fromYear && year <= toYear) dbPaths.push(p);
  }
  return dbPaths;
}

function _sumRows(rows: any[]): any {
  if (!rows.length) return null;
  const sum: any = { ...rows[0] };
  for (let i = 1; i < rows.length; i++) {
    for (const k of Object.keys(rows[i])) {
      if (k === 'period') continue;
      sum[k] = (sum[k] ?? 0) + (rows[i][k] ?? 0);
    }
  }
  return sum;
}

/**
 * 聚合统计（按粒度分组）。
 * hour 粒度仍扫明细 usage_events（只查近期，本就快，且明细才有小时粒度）。
 * 其余粒度（day/week/month/model/peer/agent）改读预聚合表 usage_daily：
 *   工作量从"全表明细"降到"天×维度"小表。rollup 永留主库，无需跨归档库 union。
 * 成本仍按 (model, billing_fn) 分组现算 calcCost，口径不变。
 */
export function queryAggregated(
  evolclawHome: string,
  granularity: Granularity,
  filter: StatsFilter,
): AggRow[] {
  if (granularity === 'hour') return _queryAggregatedEvents(evolclawHome, granularity, filter);
  return _queryAggregatedDaily(evolclawHome, granularity, filter);
}

// rollup 时间粒度的 period 表达式（day 列是 'YYYY-MM-DD' 字符串，strftime 可直接解析）。
const DAILY_PERIOD_EXPR: Record<string, string> = {
  day:   'day',
  week:  `strftime('%Y-W%W', day)`,
  month: `substr(day,1,7)`,
};

/** 针对 usage_daily 构造 WHERE：时间过滤转成对 day 列的字符串比较，维度过滤直接相等。 */
function _buildDailyWhere(f: StatsFilter): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  // from_ts/to_ts（ms，含 to_ts 排他）转成 localtime 日期串，与 day 列同口径比较。
  if (f.from_ts)    { conds.push(`day >= strftime('%Y-%m-%d', ?/1000, 'unixepoch', 'localtime')`); params.push(f.from_ts); }
  if (f.to_ts)      { conds.push(`day <  strftime('%Y-%m-%d', ?/1000, 'unixepoch', 'localtime')`); params.push(f.to_ts); }
  if (f.agent_aid)  { conds.push('agent_aid = ?'); params.push(f.agent_aid); }
  if (f.peer_key)   { conds.push('peer_key = ?');  params.push(f.peer_key); }
  if (f.model)      { conds.push('model = ?');     params.push(f.model); }
  if (f.session_id) { conds.push('session_id = ?');params.push(f.session_id); }
  if (f.billing_fn) { conds.push('billing_fn = ?');params.push(f.billing_fn); }
  return { clause: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

/** 走预聚合表 usage_daily 的聚合（day/week/month/model/peer/agent）。 */
function _queryAggregatedDaily(
  evolclawHome: string,
  granularity: Granularity,
  filter: StatsFilter,
): AggRow[] {
  const { clause, params } = _buildDailyWhere(filter);
  const groupCol = GRAN_GROUP_COL[granularity];
  const periodExpr = groupCol || DAILY_PERIOD_EXPR[granularity] || 'day';

  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return [];
  try {
    const sql = `
      SELECT
        ${periodExpr} AS period,
        SUM(input_tokens)          AS input_tokens,
        SUM(output_tokens)         AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens)     AS cache_read_tokens,
        SUM(cache_hit_tokens)      AS cache_hit_tokens,
        SUM(cache_miss_tokens)     AS cache_miss_tokens,
        SUM(image_tokens)          AS image_tokens,
        SUM(total_context_tokens)  AS total_context_tokens,
        SUM(turns)                 AS turns,
        SUM(calls)                 AS call_count
      FROM usage_daily ${clause}
      GROUP BY ${periodExpr}
    `;
    const periodMap = new Map<string, any>();
    for (const r of db.prepare(sql).all(...params) as any[]) periodMap.set(r.period, r);

    // 按 period + model + billing_fn 分组精确计费（口径与原明细路径一致）。
    const costSql = `
      SELECT ${periodExpr} AS period, model, COALESCE(billing_fn,'') AS billing_fn,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_hit_tokens) AS cache_hit_tokens, SUM(cache_miss_tokens) AS cache_miss_tokens,
        SUM(image_tokens) AS image_tokens, SUM(total_context_tokens) AS total_context_tokens
      FROM usage_daily ${clause}
      GROUP BY ${periodExpr}, model, billing_fn
    `;
    const costMap = new Map<string, { usd: number; cny: number }>();
    for (const r of db.prepare(costSql).all(...params) as any[]) {
      const cost = calcCost(evolclawHome, {
        model: r.model || 'unknown',
        billing_fn: r.billing_fn || 'per_token_v1',
        ts: Date.now(),
        input_tokens: r.input_tokens ?? 0,
        output_tokens: r.output_tokens ?? 0,
        cache_creation_tokens: r.cache_creation_tokens ?? 0,
        cache_read_tokens: r.cache_read_tokens ?? 0,
        cache_hit_tokens: r.cache_hit_tokens ?? 0,
        cache_miss_tokens: r.cache_miss_tokens ?? 0,
        image_tokens: r.image_tokens ?? 0,
        total_context_tokens: r.total_context_tokens ?? 0,
      });
      const e = costMap.get(r.period) ?? { usd: 0, cny: 0 };
      e.usd += cost.usd ?? 0;
      e.cny += cost.cny ?? 0;
      costMap.set(r.period, e);
    }

    const sorted = Array.from(periodMap.entries());
    if (groupCol) {
      sorted.sort((a, b) => ((b[1].input_tokens ?? 0) + (b[1].output_tokens ?? 0)) - ((a[1].input_tokens ?? 0) + (a[1].output_tokens ?? 0)));
    } else {
      sorted.sort((a, b) => a[0].localeCompare(b[0]));
    }
    return sorted.map(([, r]) => _enrichRow(evolclawHome, r, costMap.get(r.period)));
  } finally { db.close(); }
}

/**
 * 走明细 usage_events 的聚合（仅 hour 粒度）。
 * 跨年时合并多个 DB 的结果，再按 period 聚合。
 */
function _queryAggregatedEvents(
  evolclawHome: string,
  granularity: Granularity,
  filter: StatsFilter,
): AggRow[] {
  const { clause, params } = _buildWhere(filter);
  const groupCol = GRAN_GROUP_COL[granularity];
  let sql: string;

  if (groupCol) {
    // 非时间维度：按字段分组
    sql = `
      SELECT
        ${groupCol} AS period,
        SUM(input_tokens)           AS input_tokens,
        SUM(output_tokens)          AS output_tokens,
        SUM(cache_creation_tokens)  AS cache_creation_tokens,
        SUM(cache_read_tokens)      AS cache_read_tokens,
        SUM(COALESCE(cache_hit_tokens,0))  AS cache_hit_tokens,
        SUM(COALESCE(cache_miss_tokens,0)) AS cache_miss_tokens,
        SUM(COALESCE(image_tokens,0))      AS image_tokens,
        SUM(COALESCE(total_context_tokens,0)) AS total_context_tokens,
        SUM(turns)                  AS turns,
        COUNT(*)                    AS call_count
      FROM usage_events ${clause}
      GROUP BY ${groupCol} ORDER BY (input_tokens + output_tokens) DESC
    `;
  } else {
    // 时间维度：strftime 分组
    const fmt = GRAN_FMT[granularity] || GRAN_FMT.day;
    sql = `
      SELECT
        strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS period,
        SUM(input_tokens)           AS input_tokens,
        SUM(output_tokens)          AS output_tokens,
        SUM(cache_creation_tokens)  AS cache_creation_tokens,
        SUM(cache_read_tokens)      AS cache_read_tokens,
        SUM(COALESCE(cache_hit_tokens,0))  AS cache_hit_tokens,
        SUM(COALESCE(cache_miss_tokens,0)) AS cache_miss_tokens,
        SUM(COALESCE(image_tokens,0))      AS image_tokens,
        SUM(COALESCE(total_context_tokens,0)) AS total_context_tokens,
        SUM(turns)                  AS turns,
        COUNT(*)                    AS call_count
      FROM usage_events ${clause}
      GROUP BY period ORDER BY period
    `;
  }

  // 收集所有相关 DB 的原始行，再按 period 合并
  const periodMap = new Map<string, any>();
  for (const dbPath of _relevantDbs(evolclawHome, filter)) {
    const db = openReadonlyDb(dbPath);
    if (!db) continue;
    try {
      const rows: any[] = db.prepare(sql).all(...params);
      for (const r of rows) {
        const existing = periodMap.get(r.period);
        periodMap.set(r.period, existing ? _sumRows([existing, r]) : r);
      }
    } finally { db.close(); }
  }

  const sorted = Array.from(periodMap.entries());
  if (groupCol) {
    // 非时间维度按 total tokens 降序
    sorted.sort((a, b) => ((b[1].input_tokens ?? 0) + (b[1].output_tokens ?? 0)) - ((a[1].input_tokens ?? 0) + (a[1].output_tokens ?? 0)));
  } else {
    sorted.sort((a, b) => a[0].localeCompare(b[0]));
  }

  // ── 方案 B：按 period + model + billing_fn 分组精确计费 ──
  // 辅助 SQL：保留 model/billing_fn 维度用于逐组调用 calcCost
  const costSql = groupCol
    ? `SELECT ${groupCol} AS period, model, COALESCE(billing_fn,'') AS billing_fn,
         SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
         SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(COALESCE(image_tokens,0)) AS image_tokens
       FROM usage_events ${clause}
       GROUP BY ${groupCol}, model, billing_fn`
    : `SELECT strftime('${GRAN_FMT[granularity] || GRAN_FMT.day}', ts/1000, 'unixepoch', 'localtime') AS period,
         model, COALESCE(billing_fn,'') AS billing_fn,
         SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
         SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(COALESCE(image_tokens,0)) AS image_tokens
       FROM usage_events ${clause}
       GROUP BY period, model, billing_fn`;

  const costMap = new Map<string, { usd: number; cny: number }>();
  for (const dbPath of _relevantDbs(evolclawHome, filter)) {
    const db = openReadonlyDb(dbPath);
    if (!db) continue;
    try {
      const rows: any[] = db.prepare(costSql).all(...params);
      for (const r of rows) {
        const cost = calcCost(evolclawHome, {
          model: r.model || 'unknown',
          billing_fn: r.billing_fn || 'per_token_v1',
          ts: Date.now(),
          input_tokens: r.input_tokens ?? 0,
          output_tokens: r.output_tokens ?? 0,
          cache_creation_tokens: r.cache_creation_tokens ?? 0,
          cache_read_tokens: r.cache_read_tokens ?? 0,
          image_tokens: r.image_tokens ?? 0,
        });
        const existing = costMap.get(r.period) ?? { usd: 0, cny: 0 };
        existing.usd += cost.usd ?? 0;
        existing.cny += cost.cny ?? 0;
        costMap.set(r.period, existing);
      }
    } finally { db.close(); }
  }

  return sorted.map(([, r]) => _enrichRow(evolclawHome, r, costMap.get(r.period)));
}

/** 查今日概览（单行汇总）。 */
export function queryTodaySummary(evolclawHome: string, agentAid?: string): AggRow | null {
  const now = new Date();
  const from_ts = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rows = queryAggregated(evolclawHome, 'day', { from_ts, agent_aid: agentAid });
  return rows[0] ?? null;
}

/** 查单个会话的每轮明细。 */
export function querySessionTurns(evolclawHome: string, sessionId: string): TurnRow[] {
  const { clause, params } = _buildWhere({ session_id: sessionId });
  const sql = `SELECT * FROM usage_events ${clause} ORDER BY ts`;
  const result: TurnRow[] = [];
  for (const dbPath of _relevantDbs(evolclawHome, {})) {
    const db = openReadonlyDb(dbPath);
    if (!db) continue;
    try {
      const rows: any[] = db.prepare(sql).all(...params);
      for (const r of rows) {
        const cost = calcCost(evolclawHome, r);
        result.push({ ...r, usd: cost.usd ?? 0, cny: cost.cny ?? 0 });
      }
    } finally { db.close(); }
  }
  return result.sort((a, b) => a.ts - b.ts);
}

/** 查会话 context_breakdown 细目（每轮各段 token）。 */
export function queryContextBreakdown(evolclawHome: string, sessionId: string): any[] {
  const sql = `SELECT * FROM context_breakdown WHERE session_id = ? ORDER BY ts`;
  const result: any[] = [];
  for (const dbPath of _relevantDbs(evolclawHome, {})) {
    const db = openReadonlyDb(dbPath);
    if (!db) continue;
    try { result.push(...db.prepare(sql).all(sessionId)); }
    finally { db.close(); }
  }
  return result.sort((a, b) => a.ts - b.ts);
}

/** Top-N 对端（按 token 总量排序）。读预聚合表 usage_daily。 */
export function queryTopPeers(evolclawHome: string, filter: StatsFilter, limit = 10): any[] {
  const { clause, params } = _buildDailyWhere(filter);
  const sql = `
    SELECT peer_key, SUM(input_tokens+output_tokens) AS total_tokens,
           SUM(calls) AS call_count
    FROM usage_daily ${clause}
    GROUP BY peer_key ORDER BY total_tokens DESC LIMIT ${limit}
  `;
  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return [];
  try {
    return (db.prepare(sql).all(...params) as any[]).map(r => ({ ...r }));
  } finally { db.close(); }
}

/** Top-N 模型（按 token 总量排序）。读预聚合表 usage_daily。 */
export function queryTopModels(evolclawHome: string, filter: StatsFilter, limit = 10): any[] {
  const { clause, params } = _buildDailyWhere(filter);
  const sql = `
    SELECT model, SUM(input_tokens+output_tokens) AS total_tokens,
           SUM(calls) AS call_count
    FROM usage_daily ${clause}
    GROUP BY model ORDER BY total_tokens DESC LIMIT ${limit}
  `;
  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return [];
  try {
    return (db.prepare(sql).all(...params) as any[]).map(r => ({ ...r }));
  } finally { db.close(); }
}

// ── 私聊/群聊列表 + 汇总 + 对端按天明细（owner 前端用）────────────────────────

/** 解析 peer_key 末段为裸 peer_id（对端 AID / 群 ID）。
 *  peer_key = aun#<selfAID>#main#<encodeURIComponent(peer)>，取第 4 段起 decode。 */
function _parsePeerId(peerKey: string): string {
  const parts = peerKey.split('#');
  if (parts.length < 4) {
    // 兼容两段式 aun#peer：取末段
    try { return decodeURIComponent(parts[parts.length - 1] ?? ''); } catch { return parts[parts.length - 1] ?? ''; }
  }
  try { return decodeURIComponent(parts.slice(3).join('#')); } catch { return parts.slice(3).join('#'); }
}

/** 对一组按 (model,billing_fn) 分组的行调用 calcCost 并累加，返回 {usd,cny}。 */
function _accumCost(evolclawHome: string, rows: any[]): { usd: number; cny: number } {
  let usd = 0, cny = 0;
  for (const r of rows) {
    const c = calcCost(evolclawHome, {
      model: r.model || 'unknown',
      billing_fn: r.billing_fn || 'per_token_v1',
      ts: Date.now(),
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      cache_creation_tokens: r.cache_creation_tokens ?? 0,
      cache_read_tokens: r.cache_read_tokens ?? 0,
      cache_hit_tokens: r.cache_hit_tokens ?? 0,
      cache_miss_tokens: r.cache_miss_tokens ?? 0,
      image_tokens: r.image_tokens ?? 0,
      total_context_tokens: r.total_context_tokens ?? 0,
    });
    usd += c.usd ?? 0;
    cny += c.cny ?? 0;
  }
  return { usd, cny };
}

export interface PeerListOpts {
  peer_type: 'private' | 'group';
  from_ts?: number;
  to_ts?: number;
  agent_aid?: string;
  limit?: number;
}

/** 私聊（peer_type='private'）或群聊（'group'）列表，每项带累计汇总。读 usage_daily。 */
export function queryPeerList(evolclawHome: string, opts: PeerListOpts): PeerListRow[] {
  const limit = opts.limit ?? 50;
  const { clause, params } = _buildDailyWhere({
    from_ts: opts.from_ts, to_ts: opts.to_ts, agent_aid: opts.agent_aid,
  });
  // peer_type 过滤拼到 WHERE 上（_buildDailyWhere 不含该字段）。
  const peerCond = clause ? `${clause} AND peer_type = ?` : 'WHERE peer_type = ?';
  const listParams = [...params, opts.peer_type];

  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return [];
  try {
    const listSql = `
      SELECT peer_key,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens) AS total_tokens,
        SUM(calls) AS calls,
        COUNT(DISTINCT session_id) AS session_count,
        MIN(day) AS first_day, MAX(day) AS last_day,
        MAX(peer_type) AS peer_type
      FROM usage_daily ${peerCond}
      GROUP BY peer_key ORDER BY total_tokens DESC LIMIT ${limit}
    `;
    const rows = db.prepare(listSql).all(...listParams) as any[];

    // 每个 peer 的成本：按 (peer_key, model, billing_fn) 分组算 calcCost 累加。
    const costSql = `
      SELECT peer_key, model, COALESCE(billing_fn,'') AS billing_fn,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_hit_tokens) AS cache_hit_tokens, SUM(cache_miss_tokens) AS cache_miss_tokens,
        SUM(image_tokens) AS image_tokens, SUM(total_context_tokens) AS total_context_tokens
      FROM usage_daily ${peerCond}
      GROUP BY peer_key, model, billing_fn
    `;
    const costByPeer = new Map<string, any[]>();
    for (const r of db.prepare(costSql).all(...listParams) as any[]) {
      const arr = costByPeer.get(r.peer_key) ?? [];
      arr.push(r);
      costByPeer.set(r.peer_key, arr);
    }

    return rows.map(r => {
      const cost = _accumCost(evolclawHome, costByPeer.get(r.peer_key) ?? []);
      return {
        peer_key: r.peer_key,
        peer_id: _parsePeerId(r.peer_key),
        peer_type: r.peer_type ?? opts.peer_type,
        input_tokens: r.input_tokens ?? 0,
        output_tokens: r.output_tokens ?? 0,
        cache_creation_tokens: r.cache_creation_tokens ?? 0,
        cache_read_tokens: r.cache_read_tokens ?? 0,
        total_tokens: r.total_tokens ?? 0,
        calls: r.calls ?? 0,
        session_count: r.session_count ?? 0,
        first_day: r.first_day ?? '',
        last_day: r.last_day ?? '',
        usd: cost.usd,
        cny: cost.cny,
      };
    });
  } finally { db.close(); }
}

export interface SummaryOpts {
  from_ts?: number;
  to_ts?: number;
  agent_aid?: string;
  peer_key?: string;
}

/** 指定时间范围（可选对端）的总消耗汇总，单行。读 usage_daily。 */
export function querySummary(evolclawHome: string, opts: SummaryOpts): SummaryRow {
  const { clause, params } = _buildDailyWhere({
    from_ts: opts.from_ts, to_ts: opts.to_ts, agent_aid: opts.agent_aid, peer_key: opts.peer_key,
  });
  const empty: SummaryRow = {
    input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0,
    total_tokens: 0, calls: 0, cache_hit_rate: 0, usd: 0, cny: 0,
  };
  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return empty;
  try {
    const row = db.prepare(`
      SELECT
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(calls) AS calls
      FROM usage_daily ${clause}
    `).get(...params) as any;
    if (!row || row.calls == null) return empty;

    const costRows = db.prepare(`
      SELECT model, COALESCE(billing_fn,'') AS billing_fn,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_hit_tokens) AS cache_hit_tokens, SUM(cache_miss_tokens) AS cache_miss_tokens,
        SUM(image_tokens) AS image_tokens, SUM(total_context_tokens) AS total_context_tokens
      FROM usage_daily ${clause}
      GROUP BY model, billing_fn
    `).all(...params) as any[];
    const cost = _accumCost(evolclawHome, costRows);

    const inTok = row.input_tokens ?? 0;
    const cacheRead = row.cache_read_tokens ?? 0;
    const totalIn = inTok + cacheRead;
    return {
      input_tokens: inTok,
      output_tokens: row.output_tokens ?? 0,
      cache_creation_tokens: row.cache_creation_tokens ?? 0,
      cache_read_tokens: cacheRead,
      total_tokens: inTok + (row.output_tokens ?? 0) + cacheRead + (row.cache_creation_tokens ?? 0),
      calls: row.calls ?? 0,
      cache_hit_rate: totalIn > 0 ? cacheRead / totalIn : 0,
      usd: cost.usd,
      cny: cost.cny,
    };
  } finally { db.close(); }
}

export interface PeerDailyOpts {
  peer_key?: string;       // 完整 peer_key，精确匹配
  peer_id?: string;        // 裸对端 AID / 群 ID，按 LIKE 'aun#%#main#<encode(id)>' 匹配
  from_ts?: number;
  to_ts?: number;
  agent_aid?: string;
}

/** 指定对端（peer_key 或 peer_id），按天返回消耗明细。读 usage_daily。 */
export function queryPeerDaily(evolclawHome: string, opts: PeerDailyOpts): AggRow[] {
  const { clause, params } = _buildDailyWhere({
    from_ts: opts.from_ts, to_ts: opts.to_ts, agent_aid: opts.agent_aid,
    peer_key: opts.peer_key,
  });
  // peer_id：按末段 LIKE 收窄（与 peer_key 精确匹配二选一）。
  let where = clause;
  const qParams = [...params];
  if (!opts.peer_key && opts.peer_id) {
    where = where ? `${where} AND peer_key LIKE ?` : 'WHERE peer_key LIKE ?';
    qParams.push(`aun#%#main#${encodeURIComponent(opts.peer_id)}`);
  }

  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return [];
  try {
    const sql = `
      SELECT day AS period,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_hit_tokens) AS cache_hit_tokens, SUM(cache_miss_tokens) AS cache_miss_tokens,
        SUM(image_tokens) AS image_tokens, SUM(total_context_tokens) AS total_context_tokens,
        SUM(turns) AS turns, SUM(calls) AS call_count
      FROM usage_daily ${where}
      GROUP BY day ORDER BY day
    `;
    const periodMap = new Map<string, any>();
    for (const r of db.prepare(sql).all(...qParams) as any[]) periodMap.set(r.period, r);

    const costSql = `
      SELECT day AS period, model, COALESCE(billing_fn,'') AS billing_fn,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_hit_tokens) AS cache_hit_tokens, SUM(cache_miss_tokens) AS cache_miss_tokens,
        SUM(image_tokens) AS image_tokens, SUM(total_context_tokens) AS total_context_tokens
      FROM usage_daily ${where}
      GROUP BY day, model, billing_fn
    `;
    const costMap = new Map<string, { usd: number; cny: number }>();
    const byPeriod = new Map<string, any[]>();
    for (const r of db.prepare(costSql).all(...qParams) as any[]) {
      const arr = byPeriod.get(r.period) ?? [];
      arr.push(r);
      byPeriod.set(r.period, arr);
    }
    for (const [period, rows] of byPeriod) costMap.set(period, _accumCost(evolclawHome, rows));

    return Array.from(periodMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, r]) => _enrichRow(evolclawHome, r, costMap.get(r.period)));
  } finally { db.close(); }
}

// ── 大模型调用明细查询（model_calls）────────────────────────────────────────

export interface ModelCallDetailRow {
  ts: number;
  task_id: string;
  session_id: string | null;
  agent_session_id: string | null;
  agent_aid: string;
  peer_key: string;
  call_index: number;
  model: string;
  request_id: string | null;
  message_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  context_tokens: number | null;
  max_tokens: number | null;
  auto_compact_tokens: number | null;
  degraded: number;
}

/** 查一个 task 的所有大模型调用明细，按 call_index 排序。 */
export function queryTaskModelCalls(evolclawHome: string, taskId: string): ModelCallDetailRow[] {
  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT * FROM model_calls WHERE task_id = ? ORDER BY call_index`
    ).all(taskId) as ModelCallDetailRow[];
  } finally { db.close(); }
}

/** 查一个 evolclaw session 的所有大模型调用明细，按时间 + call_index 排序。 */
export function querySessionModelCalls(evolclawHome: string, sessionId: string): ModelCallDetailRow[] {
  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT * FROM model_calls WHERE session_id = ? ORDER BY ts, call_index`
    ).all(sessionId) as ModelCallDetailRow[];
  } finally { db.close(); }
}

function _enrichRow(evolclawHome: string, r: any, cost?: { usd: number; cny: number }): AggRow {
  const totalIn = (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0);
  const cacheHitRate = totalIn > 0 ? (r.cache_read_tokens ?? 0) / totalIn : 0;
  return {
    period: r.period,
    input_tokens: r.input_tokens ?? 0,
    output_tokens: r.output_tokens ?? 0,
    cache_creation_tokens: r.cache_creation_tokens ?? 0,
    cache_read_tokens: r.cache_read_tokens ?? 0,
    cache_hit_tokens: r.cache_hit_tokens ?? 0,
    cache_miss_tokens: r.cache_miss_tokens ?? 0,
    image_tokens: r.image_tokens ?? 0,
    total_context_tokens: r.total_context_tokens ?? 0,
    turns: r.turns ?? 0,
    call_count: r.call_count ?? 0,
    usd: cost?.usd ?? 0,
    cny: cost?.cny ?? 0,
    cache_hit_rate: cacheHitRate,
  };
}

// ── 网络流量查询（message_events）────────────────────────────────────────────

export interface MsgAggRow {
  period: string;
  msg_in: number;
  msg_out: number;
  bytes_in: number;
  bytes_out: number;
}

/** 流量聚合统计（按时间/agent/peer 分组）。 */
export function queryMessageAggregated(
  evolclawHome: string,
  granularity: Granularity,
  filter: StatsFilter,
): MsgAggRow[] {
  const groupCol = GRAN_GROUP_COL[granularity];
  const { clause, params } = _buildMsgWhere(filter);
  let sql: string;

  if (groupCol) {
    const col = groupCol === 'model' ? 'agent_aid' : groupCol; // model 无意义，降级 agent
    sql = `
      SELECT ${col} AS period,
        SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) AS msg_in,
        SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) AS msg_out,
        SUM(CASE WHEN direction='in' THEN bytes ELSE 0 END) AS bytes_in,
        SUM(CASE WHEN direction='out' THEN bytes ELSE 0 END) AS bytes_out
      FROM message_events ${clause}
      GROUP BY ${col} ORDER BY (bytes_in + bytes_out) DESC
    `;
  } else {
    const fmt = GRAN_FMT[granularity] || GRAN_FMT.day;
    sql = `
      SELECT strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS period,
        SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) AS msg_in,
        SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) AS msg_out,
        SUM(CASE WHEN direction='in' THEN bytes ELSE 0 END) AS bytes_in,
        SUM(CASE WHEN direction='out' THEN bytes ELSE 0 END) AS bytes_out
      FROM message_events ${clause}
      GROUP BY period ORDER BY period
    `;
  }

  const periodMap = new Map<string, MsgAggRow>();
  for (const dbPath of _relevantDbs(evolclawHome, filter)) {
    const db = openReadonlyDb(dbPath);
    if (!db) continue;
    try {
      const rows: any[] = db.prepare(sql).all(...params);
      for (const r of rows) {
        const existing = periodMap.get(r.period);
        if (existing) {
          existing.msg_in += r.msg_in ?? 0;
          existing.msg_out += r.msg_out ?? 0;
          existing.bytes_in += r.bytes_in ?? 0;
          existing.bytes_out += r.bytes_out ?? 0;
        } else {
          periodMap.set(r.period, {
            period: r.period,
            msg_in: r.msg_in ?? 0, msg_out: r.msg_out ?? 0,
            bytes_in: r.bytes_in ?? 0, bytes_out: r.bytes_out ?? 0,
          });
        }
      }
    } finally { db.close(); }
  }

  const sorted = Array.from(periodMap.values());
  if (groupCol) {
    sorted.sort((a, b) => (b.bytes_in + b.bytes_out) - (a.bytes_in + a.bytes_out));
  } else {
    sorted.sort((a, b) => a.period.localeCompare(b.period));
  }
  return sorted;
}

/** 今日流量概览。 */
export function queryMessageTodaySummary(evolclawHome: string, agentAid?: string): MsgAggRow | null {
  const now = new Date();
  const from_ts = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rows = queryMessageAggregated(evolclawHome, 'day', { from_ts, agent_aid: agentAid });
  return rows[0] ?? null;
}

function _buildMsgWhere(f: StatsFilter): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.from_ts)    { conds.push('ts >= ?'); params.push(f.from_ts); }
  if (f.to_ts)      { conds.push('ts < ?');  params.push(f.to_ts); }
  if (f.agent_aid)  { conds.push('agent_aid = ?'); params.push(f.agent_aid); }
  if (f.peer_key)   { conds.push('peer_key = ?');  params.push(f.peer_key); }
  return { clause: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}
