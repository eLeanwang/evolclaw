/**
 * Stats DB — SQLite 初始化、WAL、建表、索引、归档。
 * 技术选型：node:sqlite (Node 22.5+)，与主包 config-store.ts 保持一致。
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { logger } from '../../utils/logger.js';

const requireFromHere = createRequire(import.meta.url);

let sqliteModule: any | null | undefined; // undefined=未尝试, null=不可用

function loadSqlite(): any | null {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = requireFromHere('node:sqlite');
  } catch {
    logger.warn(`[StatsDB] node:sqlite unavailable (Node < 22.5?). Stats disabled.`);
    sqliteModule = null;
  }
  return sqliteModule;
}

// 单例：写者（daemon）持有一个 read-write 实例
let _db: any = null;

export function getStatsDir(evolclawHome: string): string {
  return path.join(evolclawHome, 'data', 'stats');
}

export function getDbPath(evolclawHome: string): string {
  return path.join(getStatsDir(evolclawHome), 'usage.db');
}

/** 获取写者单例（daemon 调用）。首次调用时建表。 */
export function getDb(evolclawHome: string): any | null {
  if (_db) return _db;
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  const dir = getStatsDir(evolclawHome);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = getDbPath(evolclawHome);

  try {
    _db = new sqlite.DatabaseSync(dbPath);
    _db.exec('PRAGMA journal_mode=WAL');
    _db.exec('PRAGMA synchronous=NORMAL');
    _initTables(_db);
    logger.info(`[StatsDB] Opened: ${dbPath}`);
    return _db;
  } catch (e) {
    logger.error(`[StatsDB] Failed to open DB: ${e}`);
    return null;
  }
}

/** 只读连接（CLI / ecweb 调用）。每次返回新连接，调用方负责 close()。 */
export function openReadonlyDb(dbPath: string): any | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    logger.warn(`[StatsDB] Failed to open readonly DB ${dbPath}: ${e}`);
    return null;
  }
}

function _initTables(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                    INTEGER NOT NULL,
      agent_aid             TEXT    NOT NULL,
      peer_key              TEXT    NOT NULL,
      peer_type             TEXT,
      session_id            TEXT,
      model                 TEXT    NOT NULL,
      billing_fn            TEXT    NOT NULL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens      INTEGER,
      cache_miss_tokens     INTEGER,
      image_tokens          INTEGER,
      total_context_tokens  INTEGER,
      turns                 INTEGER NOT NULL DEFAULT 1,
      duration_ms           INTEGER,
      context_window_pct    REAL
    );
    CREATE INDEX IF NOT EXISTS idx_ue_ts         ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_ue_agent_ts   ON usage_events(agent_aid, ts);
    CREATE INDEX IF NOT EXISTS idx_ue_peer_ts    ON usage_events(agent_aid, peer_key, ts);
    CREATE INDEX IF NOT EXISTS idx_ue_model_ts   ON usage_events(model, ts);
    CREATE INDEX IF NOT EXISTS idx_ue_session_ts ON usage_events(session_id, ts);

    CREATE TABLE IF NOT EXISTS context_breakdown (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              INTEGER NOT NULL,
      agent_aid       TEXT    NOT NULL,
      session_id      TEXT    NOT NULL,
      turn_count      INTEGER NOT NULL,
      model           TEXT    NOT NULL,
      max_tokens      INTEGER NOT NULL,
      system_prompt   INTEGER,
      system_tools    INTEGER,
      mcp_tools       INTEGER,
      custom_agents   INTEGER,
      memory_files    INTEGER,
      skills          INTEGER,
      messages        INTEGER,
      free_space      INTEGER,
      total_estimated INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cb_session ON context_breakdown(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_cb_agent   ON context_breakdown(agent_aid, ts);

    CREATE TABLE IF NOT EXISTS message_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      agent_aid   TEXT    NOT NULL,
      peer_key    TEXT    NOT NULL,
      direction   TEXT    NOT NULL,
      msg_type    TEXT,
      bytes       INTEGER NOT NULL DEFAULT 0,
      encrypted   INTEGER DEFAULT 0,
      chatmode    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_me_ts       ON message_events(ts);
    CREATE INDEX IF NOT EXISTS idx_me_agent_ts ON message_events(agent_aid, ts);
    CREATE INDEX IF NOT EXISTS idx_me_peer_ts  ON message_events(agent_aid, peer_key, ts);

    -- 按天预聚合表：grain = 天 × agent × peer × session × model × billing_fn。
    -- 由 writer.ts 写时增量 UPSERT 维护，rebuildDailyRollup() 全量重建纠偏。
    -- 保留 model+billing_fn 维度以便查询时仍按 calcCost 现算成本。
    -- 日级行很小，永留主库、不参与年度归档。
    CREATE TABLE IF NOT EXISTS usage_daily (
      day          TEXT NOT NULL,           -- 'YYYY-MM-DD' localtime
      agent_aid    TEXT NOT NULL,
      peer_key     TEXT NOT NULL,
      peer_type    TEXT NOT NULL DEFAULT '',-- 'private' | 'group'，由 peer_key 唯一决定
      session_id   TEXT NOT NULL DEFAULT '',
      model        TEXT NOT NULL,
      billing_fn   TEXT NOT NULL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_miss_tokens     INTEGER NOT NULL DEFAULT 0,
      image_tokens          INTEGER NOT NULL DEFAULT 0,
      total_context_tokens  INTEGER NOT NULL DEFAULT 0,
      turns        INTEGER NOT NULL DEFAULT 0,
      calls        INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, agent_aid, peer_key, session_id, model, billing_fn)
    );
    CREATE INDEX IF NOT EXISTS idx_ud_day     ON usage_daily(day);
    CREATE INDEX IF NOT EXISTS idx_ud_session ON usage_daily(session_id);

    -- 大模型调用明细：每次大模型调用一行（尽力而为；非 Claude 拿不到逐次时降级为单行累计）。
    -- 关联三个 ID：task_id（一次 runQuery）、session_id（evolclaw 会话）、agent_session_id（SDK 会话）。
    CREATE TABLE IF NOT EXISTS model_calls (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            INTEGER NOT NULL,
      task_id       TEXT    NOT NULL,
      session_id    TEXT,
      agent_session_id TEXT,
      agent_aid     TEXT    NOT NULL,
      peer_key      TEXT    NOT NULL,
      call_index    INTEGER NOT NULL,
      model         TEXT    NOT NULL,
      request_id    TEXT,
      message_id    TEXT,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      context_tokens        INTEGER,
      max_tokens            INTEGER,
      auto_compact_tokens   INTEGER,
      degraded      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mc_task        ON model_calls(task_id);
    CREATE INDEX IF NOT EXISTS idx_mc_session     ON model_calls(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_mc_agentsession ON model_calls(agent_session_id);
    CREATE INDEX IF NOT EXISTS idx_mc_ts          ON model_calls(ts);
  `);

  // 轻量迁移：旧库的 usage_daily 可能缺 peer_type 列（无 migration 机制，CREATE IF NOT EXISTS
  // 不会补列）。检测后 ALTER 补上；补列后旧行 peer_type 为空，需跑一次 rebuildDailyRollup 回填。
  try {
    const cols = db.prepare(`PRAGMA table_info(usage_daily)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'peer_type')) {
      db.exec(`ALTER TABLE usage_daily ADD COLUMN peer_type TEXT NOT NULL DEFAULT ''`);
    }
  } catch (e) {
    logger.warn(`[StatsDB] usage_daily peer_type 迁移检测失败: ${e}`);
  }

  // 轻量迁移：model_calls 早期只记录 usage 原始 token，task.start 自动压缩需要
  // 使用上轮真实 context/max/compact window，避免按模型名猜窗口。
  try {
    const cols = db.prepare(`PRAGMA table_info(model_calls)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'context_tokens')) {
      db.exec(`ALTER TABLE model_calls ADD COLUMN context_tokens INTEGER`);
    }
    if (!cols.some(c => c.name === 'max_tokens')) {
      db.exec(`ALTER TABLE model_calls ADD COLUMN max_tokens INTEGER`);
    }
    if (!cols.some(c => c.name === 'auto_compact_tokens')) {
      db.exec(`ALTER TABLE model_calls ADD COLUMN auto_compact_tokens INTEGER`);
    }
  } catch (e) {
    logger.warn(`[StatsDB] model_calls context window 迁移检测失败: ${e}`);
  }
}

/**
 * 全量重建 usage_daily：从 usage_events 明细按天聚合重算。
 * 用途：首次回填历史数据、每日自愈纠正写时漂移、手动 `ec stats --rebuild`。
 * 单事务内 DELETE + INSERT...SELECT，失败回滚不破坏现有 rollup。
 * 仅扫主库明细（往年明细已归档，但其 rollup 行已在归档前写入并永留主库）。
 * @returns 重建后的行数，DB 不可用时返回 -1。
 */
export function rebuildDailyRollup(evolclawHome: string): number {
  const db = getDb(evolclawHome);
  if (!db) return -1;
  try {
    db.exec('BEGIN');
    db.exec('DELETE FROM usage_daily');
    db.exec(`
      INSERT INTO usage_daily
        (day, agent_aid, peer_key, peer_type, session_id, model, billing_fn,
         input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
         cache_hit_tokens, cache_miss_tokens, image_tokens, total_context_tokens,
         turns, calls)
      SELECT
        strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
        agent_aid, peer_key, MAX(COALESCE(peer_type, '')),
        COALESCE(session_id, ''), model, billing_fn,
        SUM(input_tokens), SUM(output_tokens),
        SUM(cache_creation_tokens), SUM(cache_read_tokens),
        SUM(COALESCE(cache_hit_tokens, 0)), SUM(COALESCE(cache_miss_tokens, 0)),
        SUM(COALESCE(image_tokens, 0)), SUM(COALESCE(total_context_tokens, 0)),
        SUM(turns), COUNT(*)
      FROM usage_events
      GROUP BY day, agent_aid, peer_key, COALESCE(session_id, ''), model, billing_fn
    `);
    db.exec('COMMIT');
    const row = db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get() as { n: number };
    logger.info(`[StatsDB] Rebuilt usage_daily: ${row.n} rows`);
    return row.n;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    logger.error(`[StatsDB] rebuildDailyRollup failed: ${e}`);
    return -1;
  }
}

// ── 归档 ────────────────────────────────────────────────────────────────────

/**
 * 归档超过一整个自然年的数据到 usage-{year}.db，然后从主库删除。
 * 例：当前 2026-05 → 归档所有 ts < 2025-01-01 00:00:00 的数据（即 2024 年及更早）。
 * 安全：归档失败不删除主库数据。
 */
export function archiveOldData(evolclawHome: string): void {
  const db = getDb(evolclawHome);
  if (!db) return;

  const now = new Date();
  // 归档截止：当前年份第一天 00:00:00
  const cutoffYear = now.getFullYear();           // e.g. 2026
  const cutoffTs = Date.UTC(cutoffYear, 0, 1);    // 2026-01-01 00:00:00 UTC

  // 找出主库中所有早于 cutoff 的年份
  const years: number[] = db.prepare(
    `SELECT DISTINCT CAST(strftime('%Y', ts/1000, 'unixepoch') AS INTEGER) AS y
     FROM usage_events WHERE ts < ? ORDER BY y`
  ).all(cutoffTs).map((r: any) => r.y as number);

  if (years.length === 0) return;

  const statsDir = getStatsDir(evolclawHome);
  const sqlite = loadSqlite();
  if (!sqlite) return;

  for (const year of years) {
    const archivePath = path.join(statsDir, `usage-${year}.db`);
    const yearStart = Date.UTC(year, 0, 1);
    const yearEnd   = Date.UTC(year + 1, 0, 1);

    try {
      // 打开/创建归档库，建同结构表
      const archDb = new sqlite.DatabaseSync(archivePath);
      archDb.exec('PRAGMA journal_mode=WAL');
      _initTables(archDb);
      archDb.close();

      // ATTACH 方式批量迁移（同进程内最简洁）
      db.exec(`ATTACH DATABASE '${archivePath.replace(/'/g, "''")}' AS arch`);

      db.exec('BEGIN');
      db.exec(`INSERT OR IGNORE INTO arch.usage_events SELECT * FROM main.usage_events WHERE ts >= ${yearStart} AND ts < ${yearEnd}`);
      db.exec(`INSERT OR IGNORE INTO arch.context_breakdown SELECT * FROM main.context_breakdown WHERE ts >= ${yearStart} AND ts < ${yearEnd}`);
      db.exec(`DELETE FROM main.usage_events WHERE ts >= ${yearStart} AND ts < ${yearEnd}`);
      db.exec(`DELETE FROM main.context_breakdown WHERE ts >= ${yearStart} AND ts < ${yearEnd}`);
      db.exec('COMMIT');

      db.exec('DETACH DATABASE arch');
      logger.info(`[StatsDB] Archived year ${year} → ${archivePath}`);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      try { db.exec('DETACH DATABASE arch'); } catch {}
      logger.error(`[StatsDB] Archive failed for year ${year}: ${e}`);
    }
  }

  // VACUUM 回收空间（WAL 模式下安全）
  try { db.exec('VACUUM'); } catch {}
}

/** 列出所有可用的归档库路径（按年份排序）。 */
export function listArchivePaths(evolclawHome: string): Array<{ year: number; path: string }> {
  const dir = getStatsDir(evolclawHome);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(f => { const m = f.match(/^usage-(\d{4})\.db$/); return m ? { year: +m[1], path: path.join(dir, f) } : null; })
    .filter(Boolean) as Array<{ year: number; path: string }>;
}
