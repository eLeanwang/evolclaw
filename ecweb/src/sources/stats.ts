/**
 * ecweb/src/sources/stats.ts — Stats 数据源，直接只读查 usage.db。
 */

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { resolvePaths } from '../paths.js';
import { encodeSegment } from '../fs-utils.js';

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
    // Today summary with cost
    const todayRow = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count,
        COALESCE(SUM(cost_gateway_usd),0) AS cost_usd,
        COALESCE(SUM(cost_gateway_cny),0) AS cost_cny
      FROM usage_events WHERE ts >= ?
    `).get(todayStart) as any;

    const totalIn = (todayRow.input_tokens ?? 0) + (todayRow.cache_read_tokens ?? 0);
    const hitRate = totalIn > 0 ? (todayRow.cache_read_tokens ?? 0) / totalIn : 0;

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
      today: { ...todayRow, cache_hit_rate: hitRate },
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
}): Array<{
  peer_key: string;
  peer_name: string | null;
  peer_type: string | null;
  peer_chat_type: 'group' | 'private' | null;
  peer_group_member_count: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  call_count: number
}> {
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
    const rows = db.prepare(`
      SELECT peer_key, peer_type,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count
      FROM usage_events ${where}
      GROUP BY peer_key ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC LIMIT ${limit}
    `).all(...p) as any[];

    // 为每个peer添加名称和详细信息
    return rows.map((row: any) => {
      const peerInfo = getPeerInfo(row.peer_key);
      return {
        ...row,
        peer_name: peerInfo.name,
        peer_chat_type: peerInfo.chatType,
        peer_group_member_count: peerInfo.memberCount
      };
    });
  } finally { db.close(); }
}

export interface OverviewStatsResult {
  all_time: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    call_count: number;
    cost_official_usd: number;
    cost_official_cny: number;
    cost_usd: number;
    cost_cny: number;
  };
  by_agent: Array<{
    agent_aid: string;
    agent_name: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    call_count: number;
    cost_official_usd: number;
    cost_official_cny: number;
    cost_usd: number;
    cost_cny: number;
  }>;
}

export function queryStatsOverview(params?: {
  from_ts?: number; to_ts?: number; agent_aid?: string; peer_key?: string;
}): OverviewStatsResult | null {
  const db = openDb();
  if (!db) return null;
  try {
    // 构建WHERE条件
    const conds: string[] = [];
    const p: unknown[] = [];
    if (params?.from_ts) { conds.push('ts >= ?'); p.push(params.from_ts); }
    if (params?.to_ts)   { conds.push('ts <= ?'); p.push(params.to_ts); }
    if (params?.agent_aid) { conds.push('agent_aid = ?'); p.push(params.agent_aid); }
    if (params?.peer_key) { conds.push('peer_key = ?'); p.push(params.peer_key); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    // Token and cost aggregation with filters
    const allRow = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count,
        COALESCE(SUM(cost_official_usd),0) AS cost_official_usd,
        COALESCE(SUM(cost_official_cny),0) AS cost_official_cny,
        COALESCE(SUM(cost_gateway_usd),0) AS cost_usd,
        COALESCE(SUM(cost_gateway_cny),0) AS cost_cny
      FROM usage_events ${where}
    `).get(...p) as any;

    // By agent aggregation with filters
    const byAgentRows: any[] = db.prepare(`
      SELECT agent_aid,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count,
        COALESCE(SUM(cost_official_usd),0) AS cost_official_usd,
        COALESCE(SUM(cost_official_cny),0) AS cost_official_cny,
        COALESCE(SUM(cost_gateway_usd),0) AS cost_usd,
        COALESCE(SUM(cost_gateway_cny),0) AS cost_cny
      FROM usage_events ${where}
      GROUP BY agent_aid
      ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC
    `).all(...p);

    // 为每个agent添加名称
    const byAgentWithNames = byAgentRows.map((row: any) => ({
      ...row,
      agent_name: getAgentName(row.agent_aid)
    }));

    return {
      all_time: allRow,
      by_agent: byAgentWithNames,
    };
  } finally { db.close(); }
}

/** 获取所有本地agent列表 */
export function getAllLocalAgents(): Array<{ agent_aid: string; agent_name: string | null }> {
  try {
    const root = resolvePaths().root;
    const aidsDir = path.join(root, 'AIDs');

    if (!fs.existsSync(aidsDir)) return [];

    const agentDirs = fs.readdirSync(aidsDir);
    const agents: Array<{ agent_aid: string; agent_name: string | null }> = [];

    for (const agentAid of agentDirs) {
      // 跳过非目录项
      const agentPath = path.join(aidsDir, agentAid);
      if (!fs.statSync(agentPath).isDirectory()) continue;

      // 获取agent名称
      const agentName = getAgentName(agentAid);
      agents.push({ agent_aid: agentAid, agent_name: agentName });
    }

    // 按名称排序
    agents.sort((a, b) => {
      const nameA = a.agent_name || a.agent_aid;
      const nameB = b.agent_name || b.agent_aid;
      return nameA.localeCompare(nameB);
    });

    return agents;
  } catch {
    return [];
  }
}

/** 按 agent 分组聚合（支持时间范围过滤）。 */
export function queryStatsByAgent(params: {
  from_ts?: number; to_ts?: number; limit?: number;
}): Array<{ agent_aid: string; agent_name: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; call_count: number }> {
  const db = openDb();
  if (!db) return [];
  const conds: string[] = [];
  const p: unknown[] = [];
  if (params.from_ts) { conds.push('ts >= ?'); p.push(params.from_ts); }
  if (params.to_ts)   { conds.push('ts < ?');  p.push(params.to_ts); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = params.limit ?? 50;
  try {
    const rows = db.prepare(`
      SELECT agent_aid,
        COALESCE(SUM(input_tokens),0) AS input_tokens,
        COALESCE(SUM(output_tokens),0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
        COUNT(*) AS call_count
      FROM usage_events ${where}
      GROUP BY agent_aid ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC LIMIT ${limit}
    `).all(...p) as any[];

    // 为每个agent添加名称
    return rows.map((row: any) => ({
      ...row,
      agent_name: getAgentName(row.agent_aid)
    }));
  } finally { db.close(); }
}

/** 查询模型访问明细（支持分页）*/
export function queryUsageDetail(params: {
  from_ts?: number; to_ts?: number; agent_aid?: string; model?: string; limit?: number; offset?: number;
}): { data: Array<{
  ts: number;
  agent_aid: string;
  agent_name: string | null;
  peer_key: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_official_usd: number;
  cost_official_cny: number;
  cost_gateway_usd: number;
  cost_gateway_cny: number;
}>; total: number } {
  const db = openDb();
  if (!db) return { data: [], total: 0 };

  const conds: string[] = [];
  const p: unknown[] = [];
  if (params.from_ts) { conds.push('ts >= ?'); p.push(params.from_ts); }
  if (params.to_ts)   { conds.push('ts <= ?'); p.push(params.to_ts); }
  if (params.agent_aid) { conds.push('agent_aid = ?'); p.push(params.agent_aid); }
  if (params.model)     { conds.push('model = ?');     p.push(params.model); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  try {
    // 获取总数
    const countRow = db.prepare(`SELECT COUNT(*) as total FROM usage_events ${where}`).get(...p) as any;
    const total = countRow?.total || 0;

    // 获取数据
    const data = db.prepare(`
      SELECT ts, agent_aid, peer_key, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        COALESCE(cost_official_usd, 0) AS cost_official_usd,
        COALESCE(cost_official_cny, 0) AS cost_official_cny,
        COALESCE(cost_gateway_usd, 0) AS cost_gateway_usd,
        COALESCE(cost_gateway_cny, 0) AS cost_gateway_cny
      FROM usage_events ${where}
      ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}
    `).all(...p) as any[];

    // 为每条记录添加agent_name (需要从文件系统读取agent.md)
    const dataWithNames = data.map((row: any) => ({
      ...row,
      agent_name: getAgentName(row.agent_aid)
    }));

    return { data: dataWithNames, total };
  } finally { db.close(); }
}

/** 查询指定时间范围内使用过的模型列表 */
export function queryUsedModels(params: {
  from_ts?: number; to_ts?: number;
}): string[] {
  const db = openDb();
  if (!db) return [];
  const conds: string[] = [];
  const p: unknown[] = [];
  if (params.from_ts) { conds.push('ts >= ?'); p.push(params.from_ts); }
  if (params.to_ts)   { conds.push('ts <= ?'); p.push(params.to_ts); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  try {
    const rows = db.prepare(`
      SELECT DISTINCT model
      FROM usage_events ${where}
      ORDER BY model
    `).all(...p) as any[];
    return rows.map((row: any) => row.model).filter(Boolean);
  } finally { db.close(); }
}

// 辅助函数：从agent.md获取agent名称
function getAgentName(agentAid: string): string | null {
  if (!agentAid) return null;
  try {
    const root = resolvePaths().root;
    const agentMdPath = path.join(root, 'AIDs', agentAid, 'agent.md');
    if (!fs.existsSync(agentMdPath)) return null;

    const content = fs.readFileSync(agentMdPath, 'utf-8');
    // 解析YAML frontmatter中的name字段
    const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (yamlMatch) {
      const yamlContent = yamlMatch[1];
      const nameMatch = yamlContent.match(/^name:\s*["']?([^"'\n]+)["']?$/m);
      if (nameMatch) {
        return nameMatch[1].trim();
      }
    }

    // fallback: 尝试匹配第一个markdown标题
    const titleMatch = content.match(/^#\s+(.+)$/m);
    return titleMatch ? titleMatch[1].trim() : null;
  } catch {
    return null;
  }
}

// 辅助函数：从peer_key解析peer信息
// peer_key格式：
// 1. 群聊：aun#{agent_aid}#main#{group_id} (URL encoded)
// 2. 单聊：aun#{agent_aid}#main#{peer_agent_aid}
function getPeerInfo(peerKey: string): {
  name: string | null;
  chatType: 'group' | 'private' | null;
  memberCount: number | null;
} {
  if (!peerKey) return { name: null, chatType: null, memberCount: null };

  try {
    // peer_key格式：aun#{agent_aid}#main#{target}
    const parts = peerKey.split('#');
    if (parts.length < 4) return { name: null, chatType: null, memberCount: null };

    const agentAid = parts[1]; // 自己的agent_aid
    const target = parts[3]; // 群ID或对端agent_aid

    // 判断是群聊还是单聊
    if (target.startsWith('group.')) {
      // 群聊：读取群信息
      const { sessionsDir } = resolvePaths();
      const groupDir = path.join(sessionsDir, 'aun', encodeSegment(agentAid), encodeSegment(target));
      const activeJsonPath = path.join(groupDir, 'active.json');

      if (fs.existsSync(activeJsonPath)) {
        const activeData = JSON.parse(fs.readFileSync(activeJsonPath, 'utf-8'));
        // 使用 metadata.groupName 作为显示名称
        const groupName = activeData.metadata?.groupName || null;

        // 计算群人数：从groupName中的成员数量（以"、"分隔）+ "..."表示还有更多
        let memberCount = null;
        if (groupName) {
          // groupName格式："用户1、用户2、用户3..."
          const members = groupName.split('、');
          memberCount = members.length;
          // 如果最后一个成员包含"..."，说明还有更多成员
          if (members[members.length - 1].includes('...')) {
            memberCount = memberCount - 1; // 减去"..."那个元素
            // 实际人数可能更多，但我们只能从显示的名字估算
          }
        }

        return { name: groupName, chatType: 'group', memberCount };
      }
      return { name: null, chatType: 'group', memberCount: null };
    } else {
      // 单聊：target是对端agent_aid，获取其名称
      const name = getAgentName(target);
      return { name, chatType: 'private', memberCount: null };
    }
  } catch {
    return { name: null, chatType: null, memberCount: null };
  }
}
