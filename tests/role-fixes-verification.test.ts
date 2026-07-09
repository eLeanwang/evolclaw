import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ConfigTarget, validateConfig, write } from '../src/config/config-manager.js';
import { resolveRoot } from '../src/paths.js';
import { closeStatsDb, getDb } from '../src/stats/db.js';
import { formatUsageSubjectKey, getRoleBudgetStatus } from '../src/stats/role-budget.js';
import { insertUsageEvent } from '../src/stats/writer.js';

const SELF_AID = 'agent.agentid.pub';
const requireFromHere = createRequire(import.meta.url);

function writeAgentConfig(definitions: Record<string, any> = {}): void {
  write(ConfigTarget.Agent, {
    aid: SELF_AID,
    channels: [],
    roles: Object.keys(definitions).length ? { definitions } : undefined,
  }, { self: SELF_AID });
}

function insertUsage(row: {
  role: string;
  subject: string;
  peerKey?: string;
  ts?: number;
  gatewayCny?: number;
  gatewayUsd?: number;
  officialCny?: number;
  officialUsd?: number;
}): void {
  const db = getDb(resolveRoot());
  if (!db) throw new Error('stats db unavailable');
  db.prepare(`
    INSERT INTO usage_events
      (ts, agent_aid, peer_key, usage_subject_key, role, model, billing_fn,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, turns,
       cost_gateway_cny, cost_gateway_usd, cost_official_cny, cost_official_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.ts ?? Date.now(),
    SELF_AID,
    row.peerKey ?? 'aun#conversation',
    row.subject,
    row.role,
    'test-model',
    'per_token_v1',
    1,
    1,
    0,
    0,
    1,
    row.gatewayCny ?? 0,
    row.gatewayUsd ?? 0,
    row.officialCny ?? 0,
    row.officialUsd ?? 0,
  );
}

function startOfTodayTs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function startOfWeekTs(): number {
  const now = new Date();
  const daysSinceMonday = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday).getTime();
}

function startOfMonthTs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

describe('role source cleanup verification', () => {
  it('accepts static agent owner/admin fields', () => {
    expect(validateConfig(ConfigTarget.Agent, {
      aid: 'clean.agentid.pub',
      channels: [],
      owners: ['alice.aid.pub'],
      admins: ['ops.aid.pub'],
    })).toEqual([]);
  });

  it('accepts relation roles through roles.assigned and roles.members', () => {
    expect(validateConfig(ConfigTarget.Relation, {
      roles: {
        assigned: 'member',
        members: {
          'alice.aid.pub': 'visitor',
        },
      },
    })).toEqual([]);
  });

  it('rejects management roles in relation user-role assignments', () => {
    expect(validateConfig(ConfigTarget.Relation, {
      roles: { assigned: 'owner' },
    })).not.toEqual([]);
    expect(validateConfig(ConfigTarget.Relation, {
      roles: { members: { 'alice.aid.pub': 'admin' } },
    })).not.toEqual([]);
  });

  it('rejects custom definitions that reuse management role names', () => {
    expect(validateConfig(ConfigTarget.Agent, {
      aid: 'clean.agentid.pub',
      channels: [],
      roles: {
        definitions: {
          owner: {
            description: 'must not be user-defined',
            allowAccess: true,
            permissions: {},
          },
        },
      },
    })).not.toEqual([]);
  });

  it('blocks member at the default daily CNY usage limit', () => {
    writeAgentConfig();
    const subject = formatUsageSubjectKey('aun', 'private', 'alice.aid.pub', 'alice.aid.pub');

    let status = getRoleBudgetStatus(resolveRoot(), {
      selfAid: SELF_AID,
      role: 'member',
      channelType: 'aun',
      chatType: 'private',
      channelId: 'alice.aid.pub',
      peerId: 'alice.aid.pub',
    });
    expect(status.reset_mode).toBe('daily');
    expect(status.period_start_ts).toBe(startOfTodayTs());
    expect(status.currency).toBe('CNY');
    expect(status.limit_amount).toBe(50);
    expect(status.hard_blocked).toBe(false);

    insertUsage({ role: 'member', subject, gatewayCny: 50 });
    status = getRoleBudgetStatus(resolveRoot(), {
      selfAid: SELF_AID,
      role: 'member',
      channelType: 'aun',
      chatType: 'private',
      channelId: 'alice.aid.pub',
      peerId: 'alice.aid.pub',
    });
    expect(status.used_amount).toBe(50);
    expect(status.hard_blocked).toBe(true);
  });

  it('lets custom roles inherit the member daily limit when unset', () => {
    writeAgentConfig({
      reviewer: {
        description: 'review role',
        allowAccess: true,
        permissions: {},
      },
    });
    const subject = formatUsageSubjectKey('aun', 'private', 'reviewer.aid.pub', 'reviewer.aid.pub');
    insertUsage({ role: 'reviewer', subject, gatewayCny: 49 });

    const status = getRoleBudgetStatus(resolveRoot(), {
      selfAid: SELF_AID,
      role: 'reviewer',
      channelType: 'aun',
      chatType: 'private',
      channelId: 'reviewer.aid.pub',
      peerId: 'reviewer.aid.pub',
    });
    expect(status.currency).toBe('CNY');
    expect(status.limit_amount).toBe(50);
    expect(status.hard_blocked).toBe(false);
  });

  it('supports USD limits on official cost basis', () => {
    writeAgentConfig({
      paid: {
        description: 'paid role',
        allowAccess: true,
        permissions: {},
        usageLimits: {
          enabled: true,
          resetMode: 'daily',
          currency: 'USD',
          limitAmount: 0.01,
          costBasis: 'official',
          scope: 'subject',
        },
      },
    });
    const subject = formatUsageSubjectKey('aun', 'private', 'paid.aid.pub', 'paid.aid.pub');
    insertUsage({ role: 'paid', subject, gatewayUsd: 0, officialUsd: 0.01 });

    const status = getRoleBudgetStatus(resolveRoot(), {
      selfAid: SELF_AID,
      role: 'paid',
      channelType: 'aun',
      chatType: 'private',
      channelId: 'paid.aid.pub',
      peerId: 'paid.aid.pub',
    });
    expect(status.cost_basis).toBe('official');
    expect(status.currency).toBe('USD');
    expect(status.used_amount).toBe(0.01);
    expect(status.hard_blocked).toBe(true);
  });

  it('separates group usage by sender subject', () => {
    writeAgentConfig();
    const alice = formatUsageSubjectKey('aun', 'group', 'group-1', 'alice.aid.pub');
    insertUsage({ role: 'member', subject: alice, peerKey: 'aun#group-1', gatewayCny: 50 });

    const bobStatus = getRoleBudgetStatus(resolveRoot(), {
      selfAid: SELF_AID,
      role: 'member',
      channelType: 'aun',
      chatType: 'group',
      channelId: 'group-1',
      peerId: 'bob.aid.pub',
    });
    expect(bobStatus.usage_subject_key).toBe(formatUsageSubjectKey('aun', 'group', 'group-1', 'bob.aid.pub'));
    expect(bobStatus.used_amount).toBe(0);
    expect(bobStatus.hard_blocked).toBe(false);
  });

  it('uses weekly reset windows for role usage limits', () => {
    writeAgentConfig({
      weekly: {
        description: 'weekly role',
        allowAccess: true,
        permissions: {},
        usageLimits: {
          enabled: true,
          resetMode: 'weekly',
          currency: 'CNY',
          limitAmount: 5,
          costBasis: 'gateway',
          scope: 'subject',
        },
      },
    });
    const subject = formatUsageSubjectKey('aun', 'private', 'weekly.aid.pub', 'weekly.aid.pub');
    insertUsage({ role: 'weekly', subject, gatewayCny: 50, ts: startOfWeekTs() - 1000 });
    insertUsage({ role: 'weekly', subject, gatewayCny: 5, ts: Date.now() });

    const status = getRoleBudgetStatus(resolveRoot(), {
      selfAid: SELF_AID,
      role: 'weekly',
      channelType: 'aun',
      chatType: 'private',
      channelId: 'weekly.aid.pub',
      peerId: 'weekly.aid.pub',
    });
    expect(status.reset_mode).toBe('weekly');
    expect(status.period_start_ts).toBe(startOfWeekTs());
    expect(status.currency).toBe('CNY');
    expect(status.used_amount).toBe(5);
    expect(status.hard_blocked).toBe(true);
  });

  it('uses monthly reset windows for role usage limits', () => {
    writeAgentConfig({
      monthly: {
        description: 'monthly role',
        allowAccess: true,
        permissions: {},
        usageLimits: {
          enabled: true,
          resetMode: 'monthly',
          currency: 'CNY',
          limitAmount: 3,
          costBasis: 'gateway',
          scope: 'subject',
        },
      },
    });
    const subject = formatUsageSubjectKey('aun', 'private', 'monthly.aid.pub', 'monthly.aid.pub');
    insertUsage({ role: 'monthly', subject, gatewayCny: 30, ts: startOfMonthTs() - 1000 });
    insertUsage({ role: 'monthly', subject, gatewayCny: 3, ts: Date.now() });

    const status = getRoleBudgetStatus(resolveRoot(), {
      selfAid: SELF_AID,
      role: 'monthly',
      channelType: 'aun',
      chatType: 'private',
      channelId: 'monthly.aid.pub',
      peerId: 'monthly.aid.pub',
    });
    expect(status.reset_mode).toBe('monthly');
    expect(status.period_start_ts).toBe(startOfMonthTs());
    expect(status.currency).toBe('CNY');
    expect(status.used_amount).toBe(3);
    expect(status.hard_blocked).toBe(true);
  });

  it('counts all historical usage when reset mode is never', () => {
    writeAgentConfig({
      cumulative: {
        description: 'cumulative role',
        allowAccess: true,
        permissions: {},
        usageLimits: {
          enabled: true,
          resetMode: 'never',
          currency: 'CNY',
          limitAmount: 5,
          costBasis: 'gateway',
          scope: 'subject',
        },
      },
    });
    const subject = formatUsageSubjectKey('aun', 'private', 'cumulative.aid.pub', 'cumulative.aid.pub');
    insertUsage({ role: 'cumulative', subject, gatewayCny: 5, ts: startOfMonthTs() - 1000 });

    const status = getRoleBudgetStatus(resolveRoot(), {
      selfAid: SELF_AID,
      role: 'cumulative',
      channelType: 'aun',
      chatType: 'private',
      channelId: 'cumulative.aid.pub',
      peerId: 'cumulative.aid.pub',
    });
    expect(status.reset_mode).toBe('never');
    expect(status.period_start_ts).toBeNull();
    expect(status.currency).toBe('CNY');
    expect(status.used_amount).toBe(5);
    expect(status.hard_blocked).toBe(true);
  });

  it('migrates old usage_events schema before creating role budget index', () => {
    const dbPath = createOldStatsDb();
    const db = getDb(resolveRoot());
    if (!db) throw new Error('stats db unavailable');

    const cols = db.prepare(`PRAGMA table_info(usage_events)`).all() as Array<{ name: string }>;
    const indexes = db.prepare(`PRAGMA index_list(usage_events)`).all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'usage_subject_key')).toBe(true);
    expect(cols.some(c => c.name === 'role')).toBe(true);
    expect(indexes.some(i => i.name === 'idx_ue_role_budget')).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('retries usage_events insert after repairing old schema', () => {
    createOldStatsDb();
    const firstDb = getDb(resolveRoot());
    if (!firstDb) throw new Error('stats db unavailable');
    firstDb.exec(`DROP INDEX IF EXISTS idx_ue_role_budget`);
    firstDb.exec(`ALTER TABLE usage_events DROP COLUMN usage_subject_key`);
    firstDb.exec(`ALTER TABLE usage_events DROP COLUMN role`);

    insertUsageEvent(resolveRoot(), {
      ts: Date.now(),
      agent_aid: SELF_AID,
      peer_key: 'aun#conversation',
      usage_subject_key: 'aun:private:alice.aid.pub',
      role: 'member',
      peer_type: 'private',
      session_id: 'schema-retry-session',
      model: 'test-model',
      billing_fn: 'per_token_v1',
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      turns: 1,
    });

    const retryDb = getDb(resolveRoot());
    const row = retryDb.prepare(`
      SELECT usage_subject_key, role, input_tokens, output_tokens
      FROM usage_events
      WHERE session_id = ?
    `).get('schema-retry-session') as any;
    expect(row).toMatchObject({
      usage_subject_key: 'aun:private:alice.aid.pub',
      role: 'member',
      input_tokens: 1,
      output_tokens: 2,
    });
  });
});

function createOldStatsDb(): string {
  closeStatsDb();
  const statsDir = path.join(resolveRoot(), 'data', 'stats');
  fs.mkdirSync(statsDir, { recursive: true });
  const dbPath = path.join(statsDir, 'usage.db');
  const sqlite = requireFromHere('node:sqlite');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE usage_events (
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
      context_window_pct    REAL,
      cost_official_usd     REAL,
      cost_official_cny     REAL,
      cost_gateway_usd      REAL,
      cost_gateway_cny      REAL
    );
    CREATE TABLE usage_daily (
      day          TEXT NOT NULL,
      agent_aid    TEXT NOT NULL,
      peer_key     TEXT NOT NULL,
      peer_type    TEXT NOT NULL DEFAULT '',
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
      cost_official_usd     REAL,
      cost_official_cny     REAL,
      cost_gateway_usd      REAL,
      cost_gateway_cny      REAL,
      PRIMARY KEY (day, agent_aid, peer_key, session_id, model, billing_fn)
    );
  `);
  db.close();
  return dbPath;
}
