/**
 * budget.ts — 三档预算控制（硬上限 / 软上限 / 自主上限）。
 */

import fs from 'fs';
import path from 'path';
import { queryTodaySummary, queryAggregated } from './query.js';
import { calcCost } from './billing.js';
import { openReadonlyDb, getDbPath } from './db.js';

export interface BudgetConfig {
  daily_usd?: number;
  monthly_usd?: number;
  hard_limit_pct?: number;   // default 100
  soft_limit_pct?: number;   // default 80
  auto_limit_pct?: number;   // default 60
  on_hard_limit?: 'block';
  downgrade_model?: string;
}

export interface BudgetsFile {
  global?: BudgetConfig;
  agents?: Record<string, BudgetConfig>;
  peers?: Record<string, BudgetConfig>;
}

export interface BudgetStatus {
  daily_limit_usd: number;
  daily_used_usd: number;
  daily_remaining_usd: number;
  monthly_limit_usd: number;    // -1 = unlimited
  monthly_used_usd: number;
  monthly_remaining_usd: number; // -1 = unlimited
  pct_used: number;           // 0-100（取 daily/monthly 中更高者）
  hard_blocked: boolean;
  soft_warn: boolean;
  auto_warn: boolean;
  downgrade_model?: string;
}

function loadBudgets(evolclawHome: string): BudgetsFile {
  const file = path.join(evolclawHome, 'data', 'stats', 'budgets.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return {}; }
}

function _resolveCfg(budgets: BudgetsFile, agentAid?: string, peerKey?: string): BudgetConfig {
  const g = budgets.global ?? {};
  const a = agentAid ? (budgets.agents?.[agentAid] ?? {}) : {};
  const p = peerKey  ? (budgets.peers?.[peerKey]   ?? {}) : {};
  // 取最严格的限额
  const daily_usd = Math.min(
    g.daily_usd ?? Infinity,
    a.daily_usd ?? Infinity,
    p.daily_usd ?? Infinity,
  );
  return {
    daily_usd: isFinite(daily_usd) ? daily_usd : undefined,
    monthly_usd: g.monthly_usd,
    hard_limit_pct: g.hard_limit_pct ?? 100,
    soft_limit_pct: g.soft_limit_pct ?? 80,
    auto_limit_pct: g.auto_limit_pct ?? 60,
    on_hard_limit: g.on_hard_limit ?? 'block',
    downgrade_model: g.downgrade_model,
  };
}

/** 计算今日实际 USD 消耗（逐行算 cost，以避免聚合误差）。 */
function _calcTodayUsd(evolclawHome: string, agentAid?: string): number {
  const now = new Date();
  const from_ts = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return _calcRangeUsd(evolclawHome, from_ts, agentAid);
}

/** 计算本月实际 USD 消耗。 */
function _calcMonthUsd(evolclawHome: string, agentAid?: string): number {
  const now = new Date();
  const from_ts = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return _calcRangeUsd(evolclawHome, from_ts, agentAid);
}

/** 计算指定时间范围的 USD 消耗（逐行算 cost）。 */
function _calcRangeUsd(evolclawHome: string, from_ts: number, agentAid?: string): number {
  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return 0;
  let total = 0;
  try {
    const clause = agentAid ? 'WHERE ts >= ? AND agent_aid = ?' : 'WHERE ts >= ?';
    const params = agentAid ? [from_ts, agentAid] : [from_ts];
    const rows: any[] = db.prepare(`SELECT * FROM usage_events ${clause}`).all(...params);
    for (const r of rows) {
      const cost = calcCost(evolclawHome, r);
      total += cost.usd ?? 0;
    }
  } finally { db.close(); }
  return total;
}

export function getBudgetStatus(
  evolclawHome: string,
  agentAid?: string,
  peerKey?: string,
): BudgetStatus {
  const budgets = loadBudgets(evolclawHome);
  const cfg = _resolveCfg(budgets, agentAid, peerKey);

  const dailyLimit = cfg.daily_usd ?? Infinity;
  const dailyUsed  = _calcTodayUsd(evolclawHome, agentAid);
  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  const dailyPct = isFinite(dailyLimit) && dailyLimit > 0 ? (dailyUsed / dailyLimit) * 100 : 0;

  const monthlyLimit = cfg.monthly_usd ?? Infinity;
  const monthlyUsed  = isFinite(monthlyLimit) ? _calcMonthUsd(evolclawHome, agentAid) : 0;
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlyUsed);
  const monthlyPct = isFinite(monthlyLimit) && monthlyLimit > 0 ? (monthlyUsed / monthlyLimit) * 100 : 0;

  // 取 daily/monthly 中更高的百分比作为整体判断依据
  const pct = Math.max(dailyPct, monthlyPct);

  return {
    daily_limit_usd: isFinite(dailyLimit) ? dailyLimit : -1,
    daily_used_usd: dailyUsed,
    daily_remaining_usd: isFinite(dailyLimit) ? dailyRemaining : -1,
    monthly_limit_usd: isFinite(monthlyLimit) ? monthlyLimit : -1,
    monthly_used_usd: monthlyUsed,
    monthly_remaining_usd: isFinite(monthlyLimit) ? monthlyRemaining : -1,
    pct_used: pct,
    hard_blocked: pct >= (cfg.hard_limit_pct ?? 100),
    soft_warn:    pct >= (cfg.soft_limit_pct ?? 80),
    auto_warn:    pct >= (cfg.auto_limit_pct ?? 60),
    downgrade_model: cfg.downgrade_model,
  };
}
