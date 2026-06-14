/**
 * eck-vars.ts — 组装 $STATS_* ECK 注入变量。
 *
 * 分层原则（保护 prompt cache）：
 *   - system prompt 层：今日累计、预算状态（变化慢，稳定可缓存）
 *   - 消息提示词层：会话级动态数据（每轮变，不注入 system）
 */

import { openReadonlyDb, getDbPath } from './db.js';
import { getBudgetStatus } from './budget.js';

export interface StatsSystemVars {
  STATS_TODAY_INPUT_TOKENS: string;
  STATS_TODAY_OUTPUT_TOKENS: string;
  STATS_TODAY_CACHE_READ_TOKENS: string;
  STATS_TODAY_CACHE_HIT_RATE: string;      // "72.3%"
  STATS_TODAY_COST_USD: string;
  STATS_TODAY_COST_CNY: string;
  STATS_TODAY_CALL_COUNT: string;
  STATS_PEER_TODAY_COST_USD: string;
  STATS_PEER_TODAY_COST_CNY: string;
  STATS_BUDGET_DAILY_LIMIT_USD: string;
  STATS_BUDGET_DAILY_USED_USD: string;
  STATS_BUDGET_DAILY_REMAINING_USD: string;
  STATS_BUDGET_PCT_USED: string;
  STATS_BUDGET_WARN: string;               // "true" | "false"
}

export interface StatsTurnVars {
  SESSION_TURN_COUNT: string;
  SESSION_LLM_CALL_COUNT: string;
  STATS_CTX_TOTAL_TOKENS: string;
  STATS_CTX_PCT: string;
  STATS_CTX_SYSTEM_TOKENS: string;
  STATS_CTX_MESSAGES_TOKENS: string;
  STATS_CTX_TOOLS_TOKENS: string;
  STATS_BUDGET_AUTO_WARN: string;
}

function _todayRange(): { from_ts: number } {
  const now = new Date();
  return { from_ts: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) };
}

function _calcTodayCosts(evolclawHome: string, agentAid?: string, peerKey?: string): {
  usd: number; cny: number; input: number; output: number; cacheRead: number; calls: number;
} {
  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return { usd: 0, cny: 0, input: 0, output: 0, cacheRead: 0, calls: 0 };
  const { from_ts } = _todayRange();
  const conds = ['ts >= ?'];
  const params: unknown[] = [from_ts];
  if (agentAid) { conds.push('agent_aid = ?'); params.push(agentAid); }
  if (peerKey)  { conds.push('peer_key = ?');  params.push(peerKey); }
  try {
    const row = db.prepare(`
      SELECT
        SUM(input_tokens) AS input,
        SUM(output_tokens) AS output,
        SUM(cache_read_tokens) AS cacheRead,
        COUNT(*) AS calls,
        COALESCE(SUM(cost_gateway_usd), 0) AS usd,
        COALESCE(SUM(cost_gateway_cny), 0) AS cny
      FROM usage_events WHERE ${conds.join(' AND ')}
    `).get(...params) as any;
    return {
      usd: row?.usd ?? 0,
      cny: row?.cny ?? 0,
      input: row?.input ?? 0,
      output: row?.output ?? 0,
      cacheRead: row?.cacheRead ?? 0,
      calls: row?.calls ?? 0,
    };
  } finally { db.close(); }
}

/** 注入 system prompt 的变量（变化慢，可缓存）。 */
export function buildSystemVars(
  evolclawHome: string,
  agentAid?: string,
  peerKey?: string,
): StatsSystemVars {
  const agent = _calcTodayCosts(evolclawHome, agentAid);
  const peer  = peerKey ? _calcTodayCosts(evolclawHome, agentAid, peerKey) : { usd: 0, cny: 0 };
  const totalIn = agent.input + agent.cacheRead;
  const hitRate = totalIn > 0 ? ((agent.cacheRead / totalIn) * 100).toFixed(1) + '%' : '0%';
  const budget = getBudgetStatus(evolclawHome, agentAid, peerKey);

  return {
    STATS_TODAY_INPUT_TOKENS:          String(agent.input),
    STATS_TODAY_OUTPUT_TOKENS:         String(agent.output),
    STATS_TODAY_CACHE_READ_TOKENS:     String(agent.cacheRead),
    STATS_TODAY_CACHE_HIT_RATE:        hitRate,
    STATS_TODAY_COST_USD:              agent.usd.toFixed(4),
    STATS_TODAY_COST_CNY:              agent.cny.toFixed(4),
    STATS_TODAY_CALL_COUNT:            String(agent.calls),
    STATS_PEER_TODAY_COST_USD:         (peer as any).usd?.toFixed(4) ?? '0',
    STATS_PEER_TODAY_COST_CNY:         (peer as any).cny?.toFixed(4) ?? '0',
    STATS_BUDGET_DAILY_LIMIT_USD:      budget.daily_limit_usd >= 0 ? budget.daily_limit_usd.toFixed(2) : 'unlimited',
    STATS_BUDGET_DAILY_USED_USD:       budget.daily_used_usd.toFixed(4),
    STATS_BUDGET_DAILY_REMAINING_USD:  budget.daily_remaining_usd >= 0 ? budget.daily_remaining_usd.toFixed(2) : 'unlimited',
    STATS_BUDGET_PCT_USED:             budget.pct_used.toFixed(1),
    STATS_BUDGET_WARN:                 String(budget.soft_warn),
  };
}

/** 注入消息提示词的变量（每轮变，不进 system prompt）。 */
export function buildTurnVars(opts: {
  sessionTurnCount: number;
  sessionLlmCallCount: number;
  ctxTotalTokens?: number;
  ctxPct?: number;
  ctxSystemTokens?: number;
  ctxMessagesTokens?: number;
  ctxToolsTokens?: number;
  autoBudgetWarn: boolean;
}): StatsTurnVars {
  return {
    SESSION_TURN_COUNT:       String(opts.sessionTurnCount),
    SESSION_LLM_CALL_COUNT:   String(opts.sessionLlmCallCount),
    STATS_CTX_TOTAL_TOKENS:   String(opts.ctxTotalTokens ?? 0),
    STATS_CTX_PCT:            opts.ctxPct != null ? opts.ctxPct.toFixed(1) : '0',
    STATS_CTX_SYSTEM_TOKENS:  String(opts.ctxSystemTokens ?? 0),
    STATS_CTX_MESSAGES_TOKENS:String(opts.ctxMessagesTokens ?? 0),
    STATS_CTX_TOOLS_TOKENS:   String(opts.ctxToolsTokens ?? 0),
    STATS_BUDGET_AUTO_WARN:   String(opts.autoBudgetWarn),
  };
}
