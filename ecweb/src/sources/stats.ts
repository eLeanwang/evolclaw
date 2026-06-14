/**
 * ecweb/src/sources/stats.ts — Stats 数据源，直接只读查 usage.db。
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { resolvePaths } from '../paths.js';

const requireFromHere = createRequire(import.meta.url);

let sqliteModule: any | null | undefined;

function loadSqlite(): any | null {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = requireFromHere('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function getDbPath(): string {
  const { root } = resolvePaths();
  return path.join(root, 'data', 'stats', 'usage.db');
}

function openDb(): any | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch { return null; }
}

export interface StatsApiResult {
  today: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    call_count: number;
    cache_hit_rate: number;
    cost_usd: number;
    cost_cny: number;
  };
  hourly: Array<{
    hour: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    call_count: number;
  }>;
  top_models: Array<{ model: string; total_tokens: number; call_count: number }>;
  top_peers: Array<{ peer_key: string; total_tokens: number; call_count: number }>;
}

export function queryStatsForDashboard(): StatsApiResult | null {
  const db = openDb();
  if (!db) return null;

  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const h24ago = Date.now() - 24 * 60 * 60 * 1000;

  try {
    // Today summary with cost
    const todayRow = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count,
        COALESCE(SUM(cost_gateway_usd),0) AS cost_usd,
        COALESCE(SUM(cost_gateway_cny),0) AS cost_cny
      FROM usage_events WHERE ts >= ?
    `).get(todayStart) as any;

    const totalIn = (todayRow.input_tokens ?? 0) + (todayRow.cache_read_tokens ?? 0);
    const hitRate = totalIn > 0 ? (todayRow.cache_read_tokens ?? 0) / totalIn : 0;

    // Hourly (last 24h)
    const hourly: any[] = db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00', ts/1000, 'unixepoch', 'localtime') AS hour,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count
      FROM usage_events WHERE ts >= ?
      GROUP BY hour ORDER BY hour
    `).all(h24ago);

    // Top models (today)
    const top_models: any[] = db.prepare(`
      SELECT model, SUM(input_tokens+output_tokens) AS total_tokens, COUNT(*) AS call_count
      FROM usage_events WHERE ts >= ?
      GROUP BY model ORDER BY total_tokens DESC LIMIT 10
    `).all(todayStart);

    // Top peers (today)
    const top_peers: any[] = db.prepare(`
      SELECT peer_key, SUM(input_tokens+output_tokens) AS total_tokens, COUNT(*) AS call_count
      FROM usage_events WHERE ts >= ?
      GROUP BY peer_key ORDER BY total_tokens DESC LIMIT 5
    `).all(todayStart);

    return {
      today: { ...todayRow, cache_hit_rate: hitRate },
      hourly,
      top_models,
      top_peers,
    };
  } finally { db.close(); }
}

export function queryStatsExplorer(params: {
  from_ts?: number; to_ts?: number;
  agent_aid?: string; peer_key?: string; model?: string;
  granularity?: string;
}): any[] {
  const db = openDb();
  if (!db) return [];
  const gran = params.granularity || 'day';
  const fmt: Record<string, string> = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' };
  const strfmt = fmt[gran] || fmt.day;
  const conds: string[] = [];
  const p: unknown[] = [];
  if (params.from_ts)   { conds.push('ts >= ?'); p.push(params.from_ts); }
  if (params.to_ts)     { conds.push('ts < ?');  p.push(params.to_ts); }
  if (params.agent_aid) { conds.push('agent_aid = ?'); p.push(params.agent_aid); }
  if (params.peer_key)  { conds.push('peer_key = ?');  p.push(params.peer_key); }
  if (params.model)     { conds.push('model = ?');     p.push(params.model); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  try {
    return db.prepare(`
      SELECT
        strftime('${strfmt}', ts/1000, 'unixepoch', 'localtime') AS period,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count
      FROM usage_events ${where}
      GROUP BY period ORDER BY period
    `).all(...p);
  } finally { db.close(); }
}

/** 按 peer 分组聚合（支持时间范围过滤）。 */
export function queryStatsByPeer(params: {
  from_ts?: number; to_ts?: number; agent_aid?: string; limit?: number;
}): Array<{ peer_key: string; peer_type: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; call_count: number }> {
  const db = openDb();
  if (!db) return [];
  const conds: string[] = [];
  const p: unknown[] = [];
  if (params.from_ts) { conds.push('ts >= ?'); p.push(params.from_ts); }
  if (params.to_ts)   { conds.push('ts < ?');  p.push(params.to_ts); }
  if (params.agent_aid) { conds.push('agent_aid = ?'); p.push(params.agent_aid); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = params.limit ?? 50;
  try {
    return db.prepare(`
      SELECT peer_key, peer_type,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count
      FROM usage_events ${where}
      GROUP BY peer_key ORDER BY (input_tokens+output_tokens) DESC LIMIT ${limit}
    `).all(...p) as any[];
  } finally { db.close(); }
}

export interface OverviewStatsResult {
  all_time: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    call_count: number;
    cost_usd: number;
    cost_cny: number;
  };
  by_agent: Array<{
    agent_aid: string;
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    call_count: number;
    cost_usd: number;
    cost_cny: number;
  }>;
}

export function queryStatsOverview(): OverviewStatsResult | null {
  const db = openDb();
  if (!db) return null;
  try {
    // All-time token and cost aggregation
    const allRow = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count,
        COALESCE(SUM(cost_gateway_usd),0) AS cost_usd,
        COALESCE(SUM(cost_gateway_cny),0) AS cost_cny
      FROM usage_events
    `).get() as any;

    // By agent aggregation
    const byAgentRows: any[] = db.prepare(`
      SELECT agent_aid,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count,
        COALESCE(SUM(cost_gateway_usd),0) AS cost_usd,
        COALESCE(SUM(cost_gateway_cny),0) AS cost_cny
      FROM usage_events
      GROUP BY agent_aid
      ORDER BY (input_tokens+output_tokens) DESC
    `).all();

    return {
      all_time: allRow,
      by_agent: byAgentRows,
    };
  } finally { db.close(); }
}

/** 按 agent 分组聚合（支持时间范围过滤）。 */
export function queryStatsByAgent(params: {
  from_ts?: number; to_ts?: number; limit?: number;
}): Array<{ agent_aid: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; call_count: number }> {
  const db = openDb();
  if (!db) return [];
  const conds: string[] = [];
  const p: unknown[] = [];
  if (params.from_ts) { conds.push('ts >= ?'); p.push(params.from_ts); }
  if (params.to_ts)   { conds.push('ts < ?');  p.push(params.to_ts); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = params.limit ?? 50;
  try {
    return db.prepare(`
      SELECT agent_aid,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count
      FROM usage_events ${where}
      GROUP BY agent_aid ORDER BY (input_tokens+output_tokens) DESC LIMIT ${limit}
    `).all(...p) as any[];
  } finally { db.close(); }
}
