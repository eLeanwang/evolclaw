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
 * 支持时间维度（hour/day/week/month）和非时间维度（model/peer/agent）。
 * 跨年时合并多个 DB 的结果，再按 period 聚合。
 */
export function queryAggregated(
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

/** Top-N 对端（按 output_tokens 排序）。 */
export function queryTopPeers(evolclawHome: string, filter: StatsFilter, limit = 10): any[] {
  const { clause, params } = _buildWhere(filter);
  const sql = `
    SELECT peer_key, SUM(input_tokens+output_tokens) AS total_tokens,
           COUNT(*) AS call_count
    FROM usage_events ${clause}
    GROUP BY peer_key ORDER BY total_tokens DESC LIMIT ${limit}
  `;
  const map = new Map<string, any>();
  for (const dbPath of _relevantDbs(evolclawHome, filter)) {
    const db = openReadonlyDb(dbPath);
    if (!db) continue;
    try {
      for (const r of db.prepare(sql).all(...params) as any[]) {
        const e = map.get(r.peer_key);
        if (e) { e.total_tokens += r.total_tokens; e.call_count += r.call_count; }
        else map.set(r.peer_key, { ...r });
      }
    } finally { db.close(); }
  }
  return Array.from(map.values()).sort((a, b) => b.total_tokens - a.total_tokens).slice(0, limit);
}

/** Top-N 模型（按 token 总量排序）。 */
export function queryTopModels(evolclawHome: string, filter: StatsFilter, limit = 10): any[] {
  const { clause, params } = _buildWhere(filter);
  const sql = `
    SELECT model, SUM(input_tokens+output_tokens) AS total_tokens,
           COUNT(*) AS call_count
    FROM usage_events ${clause}
    GROUP BY model ORDER BY total_tokens DESC LIMIT ${limit}
  `;
  const map = new Map<string, any>();
  for (const dbPath of _relevantDbs(evolclawHome, filter)) {
    const db = openReadonlyDb(dbPath);
    if (!db) continue;
    try {
      for (const r of db.prepare(sql).all(...params) as any[]) {
        const e = map.get(r.model);
        if (e) { e.total_tokens += r.total_tokens; e.call_count += r.call_count; }
        else map.set(r.model, { ...r });
      }
    } finally { db.close(); }
  }
  return Array.from(map.values()).sort((a, b) => b.total_tokens - a.total_tokens).slice(0, limit);
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
