/**
 * src/stats/index.ts — Stats 模块公开 API。
 */

export { getDb, openReadonlyDb, getStatsDir, getDbPath, closeStatsDb, archiveOldData, listArchivePaths, rebuildDailyRollup } from './db.js';
export { normalizeUsage, type UsageEvent, type RawUsage } from './normalizer.js';
export { insertUsageEvent, insertContextBreakdown, insertMessageEvent, insertModelCalls, type ContextBreakdown, type MessageEvent, type ModelCallRow } from './writer.js';
export { calcCost, resolvePriceRow, resolveCanonicalModel, registerBillingFn } from './billing.js';
export { queryAggregated, queryTodaySummary, querySessionTurns, queryContextBreakdown, queryTopPeers, queryTopModels, queryMessageAggregated, queryMessageTodaySummary, queryPeerList, querySummary, queryPeerDaily, queryTaskModelCalls, querySessionModelCalls, type PeerListRow, type SummaryRow, type PeerListOpts, type SummaryOpts, type PeerDailyOpts, type ModelCallDetailRow } from './query.js';
export { getBudgetStatus, type BudgetStatus } from './budget.js';
export { getRoleBudgetStatus, formatUsageSubjectKey, type RoleBudgetRequest, type RoleBudgetStatus } from './role-budget.js';
export { buildSystemVars, buildTurnVars } from './eck-vars.js';
