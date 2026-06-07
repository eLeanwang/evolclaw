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

// ── 轻量计费（复制核心逻辑，避免跨包依赖）──────────────────────────────────

interface PriceRecord {
  model: string;
  effective_from: number;
  billing_fn: string;
  currency: 'USD' | 'CNY';
  [key: string]: unknown;
}

interface ModelAlias { alias: string; canonical: string; }

let _priceCache: PriceRecord[] | null = null;
let _aliasCache: ModelAlias[] | null = null;
let _priceCacheTs = 0;
const PRICE_CACHE_TTL = 5 * 60 * 1000;

function _loadPrices(): PriceRecord[] {
  const now = Date.now();
  if (_priceCache && now - _priceCacheTs < PRICE_CACHE_TTL) return _priceCache;
  const { root } = resolvePaths();
  const file = path.join(root, 'data', 'stats', 'model-prices.jsonl');
  if (!fs.existsSync(file)) { _priceCache = []; _priceCacheTs = now; return []; }
  try {
    _priceCache = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    _priceCacheTs = now;
    return _priceCache!;
  } catch { return []; }
}

function _loadAliases(): ModelAlias[] {
  const now = Date.now();
  if (_aliasCache && now - _priceCacheTs < PRICE_CACHE_TTL) return _aliasCache;
  const { root } = resolvePaths();
  const file = path.join(root, 'data', 'stats', 'model-aliases.jsonl');
  if (!fs.existsSync(file)) { _aliasCache = []; return []; }
  try {
    _aliasCache = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    return _aliasCache!;
  } catch { return []; }
}

function _resolvePrice(model: string, ts: number): PriceRecord | null {
  const prices = _loadPrices();
  let candidates = prices.filter(p => p.model === model && p.effective_from <= ts);
  if (!candidates.length) {
    const aliases = _loadAliases();
    const entry = aliases.find(a => a.alias === model);
    if (entry) candidates = prices.filter(p => p.model === entry.canonical && p.effective_from <= ts);
  }
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => a.effective_from >= b.effective_from ? a : b);
}

function _calcRowCost(row: any): { usd: number; cny: number } {
  const p = _resolvePrice(row.model, row.ts);
  if (!p) return { usd: 0, cny: 0 };
  let cost = 0;
  switch (p.billing_fn) {
    case 'per_token_v1':
      cost = ((p.price_input as number ?? 0) * (row.input_tokens ?? 0)
            + (p.price_output as number ?? 0) * (row.output_tokens ?? 0)
            + (p.price_cache_creation as number ?? 0) * (row.cache_creation_tokens ?? 0)
            + (p.price_cache_read as number ?? 0) * (row.cache_read_tokens ?? 0)) / 1e6;
      break;
    case 'per_token_deepseek_v1':
      cost = ((p.price_cache_hit as number ?? 0) * (row.cache_hit_tokens ?? 0)
            + (p.price_cache_miss as number ?? 0) * (row.cache_miss_tokens ?? 0)
            + (p.price_output as number ?? 0) * (row.output_tokens ?? 0)) / 1e6;
      break;
    case 'per_token_tiered_v1': {
      const tiers = p.tiers as Array<{ up_to_tokens: number | null; price_input: number; price_output: number; price_cache_read?: number }>;
      if (!Array.isArray(tiers)) break;
      const ctx = row.total_context_tokens ?? row.input_tokens ?? 0;
      const tier = tiers.find(t => t.up_to_tokens == null || ctx <= t.up_to_tokens) ?? tiers[tiers.length - 1];
      cost = ((tier.price_input ?? 0) * (row.input_tokens ?? 0)
            + (tier.price_output ?? 0) * (row.output_tokens ?? 0)
            + (tier.price_cache_read ?? 0) * (row.cache_read_tokens ?? 0)) / 1e6;
      break;
    }
    case 'per_token_image_v1':
      cost = ((p.price_input as number ?? 0) * (row.input_tokens ?? 0)
            + (p.price_output as number ?? 0) * (row.output_tokens ?? 0)
            + (p.price_image as number ?? 0) * (row.image_tokens ?? 0)) / 1e6;
      break;
  }
  return p.currency === 'CNY' ? { usd: 0, cny: cost } : { usd: cost, cny: 0 };
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
    // Today summary
    const todayRow = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count
      FROM usage_events WHERE ts >= ?
    `).get(todayStart) as any;

    const totalIn = (todayRow.input_tokens ?? 0) + (todayRow.cache_read_tokens ?? 0);
    const hitRate = totalIn > 0 ? (todayRow.cache_read_tokens ?? 0) / totalIn : 0;

    // Today cost (逐行计算)
    let costUsd = 0, costCny = 0;
    const costRows: any[] = db.prepare(
      `SELECT * FROM usage_events WHERE ts >= ?`
    ).all(todayStart);
    for (const r of costRows) {
      const c = _calcRowCost(r);
      costUsd += c.usd; costCny += c.cny;
    }

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
      today: { ...todayRow, cache_hit_rate: hitRate, cost_usd: costUsd, cost_cny: costCny },
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
