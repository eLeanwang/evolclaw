import { isManagementRole } from '../config/builtin-roles.js';
import { getRoleDefinition } from '../config/roles.js';
import { formatPeerKey } from '../core/relation/peer-identity.js';
import type { RoleUsageCostBasis, RoleUsageCurrency, RoleUsageLimitScope, RoleUsageLimits, RoleUsageResetMode } from '../types.js';
import { getDbPath, openReadonlyDb } from './db.js';

export interface RoleBudgetRequest {
  selfAid?: string;
  role?: string | null;
  channelType: string;
  chatType?: 'private' | 'group' | string;
  channelId: string;
  peerId?: string;
}

export interface RoleBudgetStatus {
  role: string;
  enabled: boolean;
  scope: RoleUsageLimitScope;
  cost_basis: RoleUsageCostBasis;
  reset_mode: RoleUsageResetMode;
  currency: RoleUsageCurrency;
  period_start_ts: number | null;
  usage_subject_key: string;
  limit_amount: number;
  used_amount: number;
  remaining_amount: number;
  pct_used: number;
  hard_blocked: boolean;
  reason?: string;
}

interface PeriodUsage {
  cny: number;
  usd: number;
}

const DEFAULT_COST_BASIS: RoleUsageCostBasis = 'gateway';
const DEFAULT_SCOPE: RoleUsageLimitScope = 'subject';
const DEFAULT_RESET_MODE: RoleUsageResetMode = 'daily';
const DEFAULT_CURRENCY: RoleUsageCurrency = 'CNY';
const RESET_MODES = new Set<RoleUsageResetMode>(['never', 'daily', 'weekly', 'monthly']);
const CURRENCIES = new Set<RoleUsageCurrency>(['CNY', 'USD']);

export function formatUsageSubjectKey(
  channelType: string,
  chatType: string | undefined,
  channelId: string,
  peerId?: string,
): string {
  const subjectId = (peerId || (chatType === 'private' ? channelId : '') || channelId || '').trim();
  return subjectId ? formatPeerKey(channelType, subjectId) : '';
}

export function getRoleBudgetStatus(evolclawHome: string, req: RoleBudgetRequest): RoleBudgetStatus {
  const role = req.role || 'none';
  const usageSubjectKey = formatUsageSubjectKey(req.channelType, req.chatType, req.channelId, req.peerId);
  const disabled = (reason?: string, overrides: Partial<RoleBudgetStatus> = {}): RoleBudgetStatus => ({
    role,
    enabled: false,
    scope: DEFAULT_SCOPE,
    cost_basis: DEFAULT_COST_BASIS,
    reset_mode: DEFAULT_RESET_MODE,
    currency: DEFAULT_CURRENCY,
    period_start_ts: null,
    usage_subject_key: usageSubjectKey,
    limit_amount: -1,
    used_amount: 0,
    remaining_amount: -1,
    pct_used: 0,
    hard_blocked: false,
    reason,
    ...overrides,
  });

  if (!req.selfAid || !role || role === 'none') return disabled('no_role');
  if (isManagementRole(role)) return disabled('management_role');

  const limits = resolveRoleUsageLimits(role, req.selfAid);
  if (!limits) return disabled('no_limits');

  const limitAmount = normalizeAmount(limits.limitAmount);
  const currency = normalizeCurrency(limits.currency);
  const resetMode = normalizeResetMode(limits.resetMode);
  const periodStartTs = periodStartTsFor(resetMode);
  const costBasis = limits.costBasis ?? DEFAULT_COST_BASIS;
  const scope = limits.scope ?? DEFAULT_SCOPE;
  const enabled = limits.enabled !== false && limitAmount !== undefined;
  if (!enabled) {
    return disabled('disabled', {
      scope,
      cost_basis: costBasis,
      reset_mode: resetMode,
      currency,
      period_start_ts: periodStartTs,
    });
  }

  const usage = queryPeriodUsage(evolclawHome, {
    selfAid: req.selfAid,
    role,
    scope,
    costBasis,
    usageSubjectKey,
    fromTs: periodStartTs,
  });

  const usedAmount = currency === 'USD' ? usage.usd : usage.cny;
  const pct = percentage(usedAmount, limitAmount);

  return {
    role,
    enabled: true,
    scope,
    cost_basis: costBasis,
    reset_mode: resetMode,
    currency,
    period_start_ts: periodStartTs,
    usage_subject_key: usageSubjectKey,
    limit_amount: limitAmount,
    used_amount: usedAmount,
    remaining_amount: Math.max(0, limitAmount - usedAmount),
    pct_used: pct,
    hard_blocked: pct >= 100,
  };
}

function resolveRoleUsageLimits(role: string, selfAid: string): RoleUsageLimits | null {
  const roleDef = getRoleDefinition(role, selfAid);
  if (!roleDef) return null;
  if (roleDef.usageLimits && (role === 'member' || role === 'visitor' || hasExplicitUsageLimit(roleDef.usageLimits))) {
    return roleDef.usageLimits;
  }
  if (role !== 'member' && role !== 'visitor') {
    return getRoleDefinition('member', selfAid)?.usageLimits ?? null;
  }
  return null;
}

function hasExplicitUsageLimit(limits: RoleUsageLimits): boolean {
  return limits.enabled === false
    || limits.resetMode != null
    || limits.currency != null
    || limits.limitAmount != null
    || limits.costBasis != null
    || limits.scope != null;
}

function normalizeAmount(value: number | null | undefined): number | undefined {
  if (value == null) return undefined;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function percentage(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return (used / limit) * 100;
}

function normalizeResetMode(value: RoleUsageResetMode | undefined): RoleUsageResetMode {
  return value && RESET_MODES.has(value) ? value : DEFAULT_RESET_MODE;
}

function normalizeCurrency(value: RoleUsageCurrency | undefined): RoleUsageCurrency {
  return value && CURRENCIES.has(value) ? value : DEFAULT_CURRENCY;
}

function queryPeriodUsage(
  evolclawHome: string,
  opts: {
    selfAid: string;
    role: string;
    scope: RoleUsageLimitScope;
    costBasis: RoleUsageCostBasis;
    usageSubjectKey: string;
    fromTs: number | null;
  },
): PeriodUsage {
  const db = openReadonlyDb(getDbPath(evolclawHome));
  if (!db) return { cny: 0, usd: 0 };

  try {
    const columns = db.prepare(`PRAGMA table_info(usage_events)`).all() as Array<{ name: string }>;
    const names = new Set(columns.map(c => c.name));
    if (!names.has('role') || !names.has('usage_subject_key')) return { cny: 0, usd: 0 };

    const prefix = opts.costBasis === 'official' ? 'cost_official' : 'cost_gateway';
    const where = ['agent_aid = ?', 'role = ?'];
    const params: Array<string | number> = [opts.selfAid, opts.role];
    if (opts.fromTs !== null) {
      where.unshift('ts >= ?');
      params.unshift(opts.fromTs);
    }
    if (opts.scope === 'subject') {
      where.push('usage_subject_key = ?');
      params.push(opts.usageSubjectKey);
    }

    const row = db.prepare(`
      SELECT
        COALESCE(SUM(${prefix}_cny), 0) AS cny,
        COALESCE(SUM(${prefix}_usd), 0) AS usd
      FROM usage_events
      WHERE ${where.join(' AND ')}
    `).get(...params) as { cny?: number; usd?: number } | undefined;

    return {
      cny: Number(row?.cny ?? 0),
      usd: Number(row?.usd ?? 0),
    };
  } finally {
    db.close();
  }
}

function periodStartTsFor(resetMode: RoleUsageResetMode): number | null {
  if (resetMode === 'never') return null;
  const now = new Date();
  if (resetMode === 'weekly') {
    const daysSinceMonday = (now.getDay() + 6) % 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday).getTime();
  }
  if (resetMode === 'monthly') {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
