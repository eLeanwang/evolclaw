/**
 * writer.ts — 写入 usage_events 和 context_breakdown。
 */

import { getDb } from './db.js';
import type { UsageEvent } from './normalizer.js';

export interface ContextBreakdown {
  ts: number;
  agent_aid: string;
  session_id: string;
  turn_count: number;
  model: string;
  max_tokens: number;
  system_prompt?: number;
  system_tools?: number;
  mcp_tools?: number;
  custom_agents?: number;
  memory_files?: number;
  skills?: number;
  messages?: number;
  free_space?: number;
  total_estimated?: number;
}

export function insertUsageEvent(evolclawHome: string, event: UsageEvent): void {
  const db = getDb(evolclawHome);
  if (!db) return;
  try {
    // 明细 INSERT + rollup UPSERT 包进同一事务：进程在两者间崩溃也不会让 rollup 与明细漂移。
    db.exec('BEGIN');
    db.prepare(`
      INSERT INTO usage_events
        (ts, agent_aid, peer_key, peer_type, session_id, model, billing_fn,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         cache_hit_tokens, cache_miss_tokens, image_tokens, total_context_tokens,
         turns, duration_ms, context_window_pct)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.ts, event.agent_aid, event.peer_key, event.peer_type ?? null,
      event.session_id ?? null, event.model, event.billing_fn,
      event.input_tokens, event.output_tokens,
      event.cache_creation_tokens, event.cache_read_tokens,
      event.cache_hit_tokens ?? null, event.cache_miss_tokens ?? null,
      event.image_tokens ?? null, event.total_context_tokens ?? null,
      event.turns, event.duration_ms ?? null, event.context_window_pct ?? null,
    );
    // 写时增量：累加到日级预聚合表（grain 与 db.ts rebuildDailyRollup 一致）。
    db.prepare(`
      INSERT INTO usage_daily
        (day, agent_aid, peer_key, peer_type, session_id, model, billing_fn,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         cache_hit_tokens, cache_miss_tokens, image_tokens, total_context_tokens,
         turns, calls)
      VALUES
        (strftime('%Y-%m-%d', ?/1000, 'unixepoch', 'localtime'),
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(day, agent_aid, peer_key, session_id, model, billing_fn) DO UPDATE SET
        peer_type             = excluded.peer_type,
        input_tokens          = input_tokens          + excluded.input_tokens,
        output_tokens         = output_tokens         + excluded.output_tokens,
        cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
        cache_read_tokens     = cache_read_tokens     + excluded.cache_read_tokens,
        cache_hit_tokens      = cache_hit_tokens      + excluded.cache_hit_tokens,
        cache_miss_tokens     = cache_miss_tokens     + excluded.cache_miss_tokens,
        image_tokens          = image_tokens          + excluded.image_tokens,
        total_context_tokens  = total_context_tokens  + excluded.total_context_tokens,
        turns                 = turns                 + excluded.turns,
        calls                 = calls                 + 1
    `).run(
      event.ts,
      event.agent_aid, event.peer_key, event.peer_type ?? '', event.session_id ?? '',
      event.model, event.billing_fn,
      event.input_tokens, event.output_tokens,
      event.cache_creation_tokens, event.cache_read_tokens,
      event.cache_hit_tokens ?? 0, event.cache_miss_tokens ?? 0,
      event.image_tokens ?? 0, event.total_context_tokens ?? 0,
      event.turns,
    );
    db.exec('COMMIT');
  } catch (e) {
    // 写入失败不影响主流程
    try { db.exec('ROLLBACK'); } catch {}
    import('../../utils/logger.js').then(({ logger }) =>
      logger.warn(`[StatsWriter] insertUsageEvent failed: ${e}`)
    );
  }
}

export function insertContextBreakdown(evolclawHome: string, bd: ContextBreakdown): void {
  const db = getDb(evolclawHome);
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO context_breakdown
        (ts, agent_aid, session_id, turn_count, model, max_tokens,
         system_prompt, system_tools, mcp_tools, custom_agents,
         memory_files, skills, messages, free_space, total_estimated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bd.ts, bd.agent_aid, bd.session_id, bd.turn_count, bd.model, bd.max_tokens,
      bd.system_prompt ?? null, bd.system_tools ?? null, bd.mcp_tools ?? null,
      bd.custom_agents ?? null, bd.memory_files ?? null, bd.skills ?? null,
      bd.messages ?? null, bd.free_space ?? null, bd.total_estimated ?? null,
    );
  } catch (e) {
    import('../../utils/logger.js').then(({ logger }) =>
      logger.warn(`[StatsWriter] insertContextBreakdown failed: ${e}`)
    );
  }
}

export interface MessageEvent {
  ts: number;
  agent_aid: string;
  peer_key: string;
  direction: 'in' | 'out';
  msg_type?: string;    // 'private' | 'group' | 'system'
  bytes: number;
  encrypted?: boolean;
  chatmode?: string;
}

export function insertMessageEvent(evolclawHome: string, event: MessageEvent): void {
  const db = getDb(evolclawHome);
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO message_events
        (ts, agent_aid, peer_key, direction, msg_type, bytes, encrypted, chatmode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.ts, event.agent_aid, event.peer_key, event.direction,
      event.msg_type ?? null, event.bytes,
      event.encrypted ? 1 : 0, event.chatmode ?? null,
    );
  } catch (e) {
    import('../../utils/logger.js').then(({ logger }) =>
      logger.warn(`[StatsWriter] insertMessageEvent failed: ${e}`)
    );
  }
}

export interface ModelCallRow {
  ts: number;
  task_id: string;
  session_id?: string;
  agent_session_id?: string;
  agent_aid: string;
  peer_key: string;
  call_index: number;
  model: string;
  request_id?: string;
  message_id?: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  context_tokens?: number;
  max_tokens?: number;
  auto_compact_tokens?: number;
  degraded: 0 | 1;
}

/** 批量写入大模型调用明细。单事务；失败不影响主流程。 */
export function insertModelCalls(evolclawHome: string, rows: ModelCallRow[]): void {
  if (!rows.length) return;
  const db = getDb(evolclawHome);
  if (!db) return;
  try {
    const stmt = db.prepare(`
      INSERT INTO model_calls
        (ts, task_id, session_id, agent_session_id, agent_aid, peer_key, call_index, model,
         request_id, message_id, input_tokens, output_tokens, cache_creation_tokens,
         cache_read_tokens, context_tokens, max_tokens, auto_compact_tokens, degraded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    for (const r of rows) {
      stmt.run(
        r.ts, r.task_id, r.session_id ?? null, r.agent_session_id ?? null,
        r.agent_aid, r.peer_key, r.call_index, r.model,
        r.request_id ?? null, r.message_id ?? null,
        r.input_tokens, r.output_tokens, r.cache_creation_tokens, r.cache_read_tokens,
        r.context_tokens ?? null, r.max_tokens ?? null, r.auto_compact_tokens ?? null,
        r.degraded,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    import('../../utils/logger.js').then(({ logger }) =>
      logger.warn(`[StatsWriter] insertModelCalls failed: ${e}`)
    );
  }
}
