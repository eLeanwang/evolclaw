/**
 * Codex 会话数据源 — Codex thread 历史展示。
 *
 * 数据源：
 * - ~/.codex/state_*.sqlite（元数据索引）
 * - ~/.codex/sessions/YYYY/MM/DD/*.jsonl（rollout 文件）
 *
 * 与 Claude session source 接口对齐，返回相同的数据结构。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { resolvePaths } from '../paths.js';
import { encodePath, scanChatDirs, readJsonFile, type SessionFile } from '../fs-utils.js';

const requireFromHere = createRequire(import.meta.url);

type LogFn = (line: string) => void;
let _dlog: LogFn | null = null;
export function setDebugLog(log: LogFn | null): void { _dlog = log; }
function dlog(line: string): void { if (_dlog) try { _dlog(line); } catch {} }

// ── SQLite 数据库访问 ──

let sqliteModule: any | null | undefined; // undefined = not tried, null = unavailable

function loadSqlite(): any | null {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = requireFromHere('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

function resolveStateDbPath(): string | null {
  const codexHome = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexHome)) return null;

  try {
    const files = fs.readdirSync(codexHome)
      .filter(f => /^state_\d+\.sqlite$/.test(f))
      .sort((a, b) => {
        const va = parseInt(a.match(/state_(\d+)/)?.[1] || '0');
        const vb = parseInt(b.match(/state_(\d+)/)?.[1] || '0');
        return vb - va;
      });
    return files.length > 0 ? path.join(codexHome, files[0]) : null;
  } catch {
    return null;
  }
}

let _db: any | null = null;
let _dbInitialized = false;

function getDb(): any | null {
  if (_dbInitialized) return _db;
  _dbInitialized = true;

  const sqlite = loadSqlite();
  if (!sqlite) return null;

  const dbPath = resolveStateDbPath();
  if (!dbPath) return null;

  try {
    _db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    dlog(`[codex] Opened state DB: ${dbPath}`);
  } catch (error) {
    dlog(`[codex] Failed to open state DB: ${dbPath}`);
    _db = null;
  }
  return _db;
}

// ── 数据结构 ──

interface TranscriptMeta {
  id: string;
  title: string;
  firstUser: string;
  gitBranch: string;
  version: string;
  userMsgs: number;
  totalMsgs: number;
  sizeKB: number;
  lastActivity: number;
}

interface ProjectEntry {
  encoded: string;
  cwd: string;
  label: string;
  count: number;
  lastActivity: number;
}

interface BindInfo {
  channelType: string;
  channelId: string;
  selfAID: string;
  peerName: string | null;
  name: string | null;
  updatedAt: number;
}

// ── 项目列表 ──

function listProjects(): ProjectEntry[] {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = db.prepare(`
      SELECT cwd, COUNT(*) as count, MAX(updated_at) as lastActivity
      FROM threads
      WHERE archived = 0
      GROUP BY cwd
      ORDER BY lastActivity DESC
    `).all() as any[];

    return rows.map(r => {
      const cwd = r.cwd || '';
      const label = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'unknown';
      return {
        encoded: encodePath(cwd),
        cwd,
        label,
        count: r.count || 0,
        lastActivity: (r.lastActivity || 0) * 1000, // Codex uses Unix timestamp (seconds)
      };
    });
  } catch (error) {
    dlog(`[codex] listProjects failed: ${error}`);
    return [];
  }
}

// ── 会话列表 ──

const CACHE_VERSION = 1;
const _metaCache = new Map<string, { mtime: number; meta: TranscriptMeta }>();

function cacheDir(encoded: string): string {
  const dataDir = resolvePaths().dataDir;
  return path.join(dataDir, 'ecweb-cache', 'codex', encoded);
}

interface CacheRecord { v: number; mtime: number; size: number; meta: TranscriptMeta; }

function readDiskCache(encoded: string, id: string, mtime: number, size: number): TranscriptMeta | null {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(cacheDir(encoded), `${id}.json`), 'utf-8')) as CacheRecord;
    if (rec.v === CACHE_VERSION && rec.mtime === mtime && rec.size === size && rec.meta) return rec.meta;
  } catch {}
  return null;
}

function writeDiskCache(encoded: string, id: string, mtime: number, size: number, meta: TranscriptMeta): void {
  try {
    const dir = cacheDir(encoded);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${id}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, mtime, size, meta }));
    fs.renameSync(tmp, path.join(dir, `${id}.json`));
  } catch {}
}

function extractMetaFromRollout(file: string, id: string): TranscriptMeta {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch {}

  let title = '', firstUser = '', gitBranch = '', version = '', userMsgs = 0, totalMsgs = 0;
  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);

      // 提取 cwd 和 version
      if (event.type === 'session_meta' && event.payload) {
        if (!gitBranch && event.payload.cwd) gitBranch = event.payload.cwd;
        if (!version && event.payload.cli_version) version = event.payload.cli_version;
      }

      // 提取 title（从第一个 user_message）
      if (event.type === 'event_msg' && event.payload?.type === 'user_message' && event.payload.message) {
        totalMsgs++;
        userMsgs++;
        if (!firstUser) {
          const text = event.payload.message.trim().replace(/\s+/g, ' ');
          firstUser = text.substring(0, 120);
        }
      }

      // 统计 assistant 消息
      if (event.type === 'event_msg' && event.payload?.type === 'assistant_message') {
        totalMsgs++;
      }
    } catch {}
  }

  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { stat = { size: 0, mtimeMs: 0 } as fs.Stats; }

  return {
    id,
    title: title || firstUser.substring(0, 50) || 'Untitled',
    firstUser,
    gitBranch,
    version,
    userMsgs,
    totalMsgs,
    sizeKB: Math.round(stat.size / 1024),
    lastActivity: stat.mtimeMs,
  };
}

function listTranscripts(encoded: string, cwd: string): TranscriptMeta[] {
  const db = getDb();
  if (!db) return [];

  try {
    const rows = db.prepare(`
      SELECT id, title, first_user_message, updated_at, rollout_path
      FROM threads
      WHERE cwd = ? AND archived = 0
      ORDER BY updated_at DESC
    `).all(cwd) as any[];

    const out: TranscriptMeta[] = [];
    let parsed = 0, hitMem = 0, hitDisk = 0;

    for (const row of rows) {
      const id = row.id;
      const rolloutPath = row.rollout_path;

      if (!rolloutPath || !fs.existsSync(rolloutPath)) {
        // Fallback: 从 DB 直接构造 meta
        const firstUser = (row.first_user_message || '').trim().replace(/\s+/g, ' ').substring(0, 120);
        out.push({
          id,
          title: row.title || firstUser.substring(0, 50) || 'Untitled',
          firstUser,
          gitBranch: cwd,
          version: '',
          userMsgs: 0,
          totalMsgs: 0,
          sizeKB: 0,
          lastActivity: (row.updated_at || 0) * 1000,
        });
        continue;
      }

      let stat: fs.Stats;
      try { stat = fs.statSync(rolloutPath); } catch { continue; }

      const mtime = stat.mtimeMs;
      const mem = _metaCache.get(rolloutPath);
      if (mem && mem.mtime === mtime) {
        out.push(mem.meta);
        hitMem++;
        continue;
      }

      const disk = readDiskCache(encoded, id, mtime, stat.size);
      if (disk) {
        _metaCache.set(rolloutPath, { mtime, meta: disk });
        out.push(disk);
        hitDisk++;
        continue;
      }

      const meta = extractMetaFromRollout(rolloutPath, id);
      _metaCache.set(rolloutPath, { mtime, meta });
      writeDiskCache(encoded, id, mtime, stat.size, meta);
      out.push(meta);
      parsed++;
    }

    dlog(`[codex] listTranscripts ${cwd.slice(-20)}: ${rows.length} threads (mem=${hitMem} disk=${hitDisk} parsed=${parsed})`);
    return out;
  } catch (error) {
    dlog(`[codex] listTranscripts failed: ${error}`);
    return [];
  }
}

// ── 绑定关系 ──

export function buildBindMap(): Map<string, BindInfo> {
  const map = new Map<string, BindInfo>();
  try {
    const p = resolvePaths();
    for (const dir of scanChatDirs(p.sessionsDir)) {
      const active = readJsonFile<SessionFile>(path.join(dir.dirPath, 'active.json'));
      if (!active || !active.agentSessionId) continue;
      map.set(active.agentSessionId, {
        channelType: active.channelType || dir.channelType,
        channelId: active.channelId || dir.channelId,
        selfAID: active.selfAID || dir.selfAID,
        peerName: (active.metadata && active.metadata.peerName) || null,
        name: active.name,
        updatedAt: active.updatedAt || 0,
      });
    }
  } catch {}
  return map;
}

// ── 项目解析 ──

function resolveProject(params: Record<string, any>, projects: ProjectEntry[]): ProjectEntry | null {
  if (params.project) {
    const found = projects.find(p => p.encoded === params.project);
    if (found) {
      dlog(`[codex] resolveProject: matched param project=${params.project.slice(-24)}`);
      return found;
    }
    dlog(`[codex] resolveProject: param project=${params.project.slice(-24)} NOT in ${projects.length} projects → falling back`);
  }

  const curEncoded = encodePath(process.cwd());
  const cur = projects.find(p => p.encoded === curEncoded);
  if (cur) {
    dlog(`[codex] resolveProject: default to cwd project=${curEncoded.slice(-24)}`);
    return cur;
  }

  dlog(`[codex] resolveProject: cwd project=${curEncoded.slice(-24)} not found → using first=${projects[0]?.encoded.slice(-24)}`);
  return projects[0] || null;
}

// ── 会话详情 ──

// OpenAI 定价表（2026-06 更新）
const PRICING: Record<string, [number, number, number, number]> = {
  // [input, cache_write, cache_read, output] per 1M tokens
  'gpt-5.5': [5, 0.5, 0.5, 30],
  'gpt-5.5-pro': [30, 30, 30, 180],
  'gpt-5.4': [2.5, 0.25, 0.25, 15],
  'gpt-5.4-mini': [0.75, 0.075, 0.075, 3.75],
  'gpt-5.4-nano': [0.25, 0.025, 0.025, 1.25],
  'gpt-5.2': [1.75, 0.175, 0.175, 14],
  'gpt-4.1': [2.50, 0.625, 0.125, 10],
  'gpt-4.1-mini': [0.40, 0.10, 0.10, 1.60],
  'gpt-4.1-nano': [0.10, 0.025, 0.025, 0.40],
  'gpt-4o': [2.50, 1.25, 0.25, 10],
  'gpt-4o-mini': [0.15, 0.075, 0.075, 0.60],
  'o3': [2.00, 2.00, 2.00, 8.00],
  'o3-pro': [20.00, 20.00, 20.00, 80.00],
  'o4-mini': [1.10, 1.10, 1.10, 4.40],
};

function pricingFor(model: string): [number, number, number, number] {
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  // 默认按 gpt-5.4 计算
  return PRICING['gpt-5.4'];
}

function readTranscriptFile(threadId: string, cwd: string): any {
  const empty = {
    turns: [],
    totalTurns: 0,
    userMsgs: 0,
    totalMsgs: 0,
    counts: { userInput: 0, modelOutput: 0, toolCall: 0, toolResult: 0, msgSend: 0 },
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    costUsd: 0,
    model: '',
    gitBranch: cwd,
    version: '',
    title: '',
    cwd,
  };

  const db = getDb();
  if (!db) return empty;

  let rolloutPath: string;
  try {
    const row = db.prepare('SELECT rollout_path, title FROM threads WHERE id = ?').get(threadId) as any;
    if (!row || !row.rollout_path) return empty;
    rolloutPath = row.rollout_path;
    empty.title = row.title || '';
  } catch {
    return empty;
  }

  if (!fs.existsSync(rolloutPath)) return empty;

  let raw: string;
  try {
    raw = fs.readFileSync(rolloutPath, 'utf-8');
  } catch {
    return empty;
  }

  const turns: any[] = [];
  const counts = { userInput: 0, modelOutput: 0, toolCall: 0, toolResult: 0, msgSend: 0 };
  let inTok = 0, outTok = 0, model = '', version = '', userMsgs = 0, totalMsgs = 0, contextTokens = 0, costUsd = 0;
  let lastUsageKey = '';

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    // 提取 session_meta
    if (event.type === 'session_meta' && event.payload) {
      if (!version && event.payload.cli_version) version = event.payload.cli_version;
    }

    // 提取 model 信息（从 payload.model）
    if (event.payload?.model && !model) {
      model = event.payload.model;
    }

    // 处理 token_count 事件（Codex 的 usage 信息）
    if (event.type === 'event_msg' && event.payload?.type === 'token_count' && event.payload.info) {
      const u = event.payload.info.last_token_usage;
      if (u) {
        const inp = u.input_tokens || 0;
        const cached = u.cached_input_tokens || 0;
        const out = u.output_tokens || 0;

        // 避免重复计算同一个 usage
        const key = `${inp},${cached},${out}`;
        if (key !== lastUsageKey) {
          lastUsageKey = key;
          inTok += inp;
          outTok += out;
          contextTokens = inp + cached;

          // 计算费用
          const [pi, pcw, pcr, po] = pricingFor(model || 'gpt-5.4');
          // Codex 的 cached_input_tokens 对应 cache_read
          costUsd += (inp * pi + cached * pcr + out * po) / 1_000_000;
        }
      }
    }

    // 处理消息事件
    if (event.type === 'event_msg' && event.payload) {
      const payload = event.payload;

      if (payload.type === 'user_message' && payload.message) {
        totalMsgs++;
        userMsgs++;
        counts.userInput++;

        const text = payload.message.trim();
        turns.push({
          role: 'user',
          ts: event.timestamp ? Date.parse(event.timestamp) : 0,
          uuid: payload.id || '',
          category: 'user_input',
          blocks: [{ kind: 'text', text }],
        });
      } else if (payload.type === 'agent_message' && payload.message) {
        totalMsgs++;
        counts.modelOutput++;

        const blocks: any[] = [];

        // 提取 message
        if (payload.message) {
          blocks.push({ kind: 'text', text: payload.message });
        }

        turns.push({
          role: 'assistant',
          ts: event.timestamp ? Date.parse(event.timestamp) : 0,
          uuid: payload.id || '',
          category: 'model_output',
          blocks,
        });
      } else if (payload.type === 'reasoning' && payload.message) {
        // Codex reasoning 对应 Claude 的 thinking
        const lastTurn = turns[turns.length - 1];
        if (lastTurn && lastTurn.role === 'assistant') {
          lastTurn.blocks.unshift({ kind: 'thinking', text: payload.message });
        }
      }
    }

    // 处理 function_call 事件（对应 tool_use）
    if (event.type === 'event_msg' && event.payload?.type === 'function_call') {
      const payload = event.payload;
      counts.toolCall++;

      const inputStr = payload.arguments ? JSON.stringify(JSON.parse(payload.arguments), null, 2) : '';
      turns.push({
        role: 'assistant',
        ts: event.timestamp ? Date.parse(event.timestamp) : 0,
        uuid: payload.call_id || '',
        category: 'tool_call',
        blocks: [{
          kind: 'tool_use',
          name: payload.name || '',
          input: payload.arguments ? JSON.parse(payload.arguments) : {},
          inputStr,
        }],
      });
    }

    // 处理 function_call_output 事件（对应 tool_result）
    if (event.type === 'event_msg' && event.payload?.type === 'function_call_output') {
      const payload = event.payload;
      counts.toolResult++;

      turns.push({
        role: 'user',
        ts: event.timestamp ? Date.parse(event.timestamp) : 0,
        uuid: payload.call_id || '',
        category: 'tool_result',
        blocks: [{
          kind: 'tool_result',
          text: payload.output || '',
          isError: false,
        }],
      });
    }
  }

  const shown = turns.length > 500 ? turns.slice(-500) : turns;
  return {
    turns: shown,
    totalTurns: turns.length,
    userMsgs,
    totalMsgs,
    counts,
    inputTokens: inTok,
    outputTokens: outTok,
    contextTokens,
    costUsd,
    model,
    gitBranch: empty.gitBranch,
    version,
    title: empty.title,
    cwd,
  };
}

// ── Snapshot ──

function buildSnapshot(params: Record<string, any>): any {
  const projects = listProjects();
  const bindMap = buildBindMap();
  const project = resolveProject(params, projects);

  if (!project) {
    return {
      baseagent: 'codex',
      projects: [],
      project: null,
      transcripts: [],
      turns: [],
      sessionId: null,
    };
  }

  const metas = listTranscripts(project.encoded, project.cwd);
  const transcripts = metas.map(m => {
    const bind = bindMap.get(m.id);
    return {
      ...m,
      bound: !!bind,
      boundChannel: bind?.channelType ?? null,
      boundPeer: bind ? (bind.peerName || bind.channelId) : null,
      online: bind ? (Date.now() - bind.updatedAt < 5 * 60 * 1000) : false,
    };
  });

  const projList = projects.map(p => ({
    encoded: p.encoded,
    label: p.label,
    cwd: p.cwd,
    count: p.count,
  }));

  const sessionId: string | null = params.sessionId || null;
  if (!sessionId) {
    return {
      baseagent: 'codex',
      projects: projList,
      project: project.encoded,
      transcripts,
      turns: [],
      sessionId: null,
    };
  }

  const detail = readTranscriptFile(sessionId, project.cwd);
  const bind = bindMap.get(sessionId);
  const header = {
    sessionId,
    title: detail.title,
    model: detail.model,
    gitBranch: detail.gitBranch,
    version: detail.version,
    cwd: detail.cwd,
    totalTurns: detail.totalTurns,
    userMsgs: detail.userMsgs,
    totalMsgs: detail.totalMsgs,
    counts: detail.counts,
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    contextTokens: detail.contextTokens,
    costUsd: detail.costUsd,
    bound: !!bind,
    boundChannel: bind?.channelType ?? null,
    boundPeer: bind ? (bind.peerName || bind.channelId) : null,
    online: bind ? (Date.now() - bind.updatedAt < 5 * 60 * 1000) : false,
  };

  return {
    baseagent: 'codex',
    projects: projList,
    project: project.encoded,
    transcripts,
    turns: detail.turns,
    sessionId,
    header,
  };
}

// ── Export ──

export async function snapshotCodex(params: Record<string, any> = {}): Promise<any> {
  return buildSnapshot(params);
}

export function subscribeCodex(params: Record<string, any>, push: (data: any) => void): () => void {
  const p = resolvePaths();
  let dbWatcher: fs.FSWatcher | null = null;
  let sessionWatcher: fs.FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;

  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        push(buildSnapshot(params));
      } catch {}
    }, 150);
  };

  // 监听 state_*.sqlite 变化
  const dbPath = resolveStateDbPath();
  if (dbPath && fs.existsSync(dbPath)) {
    try {
      dbWatcher = fs.watch(dbPath, () => fire());
    } catch {}
  }

  // 监听 evolclaw sessionsDir 的 active.json 变化
  try {
    sessionWatcher = fs.watch(p.sessionsDir, { recursive: true }, (_evt, filename) => {
      if (filename && String(filename).endsWith('active.json')) fire();
    });
  } catch {}

  return () => {
    if (dbWatcher) dbWatcher.close();
    if (sessionWatcher) sessionWatcher.close();
    if (debounce) clearTimeout(debounce);
  };
}
