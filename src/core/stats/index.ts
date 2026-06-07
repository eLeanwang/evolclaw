/**
 * src/core/stats/index.ts — Stats 模块公开 API。
 */

export { getDb, openReadonlyDb, getStatsDir, getDbPath, archiveOldData, listArchivePaths } from './db.js';
export { normalizeUsage, type UsageEvent, type RawUsage } from './normalizer.js';
export { insertUsageEvent, insertContextBreakdown, insertMessageEvent, type ContextBreakdown, type MessageEvent } from './writer.js';
export { calcCost, resolvePriceRow, resolveCanonicalModel, registerBillingFn } from './billing.js';
export { queryAggregated, queryTodaySummary, querySessionTurns, queryContextBreakdown, queryTopPeers, queryTopModels, queryMessageAggregated, queryMessageTodaySummary } from './query.js';
export { getBudgetStatus, type BudgetStatus } from './budget.js';
export { buildSystemVars, buildTurnVars } from './eck-vars.js';
