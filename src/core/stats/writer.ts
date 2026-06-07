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
  } catch (e) {
    // 写入失败不影响主流程
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
