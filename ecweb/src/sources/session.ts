/**
 * 会话数据源 — CC（Claude Code / Agent SDK）transcript 历史展示。
 *
 * 列表数据源：~/.claude/projects/<encodedProject>/*.jsonl
 * 绑定状态交叉标注：evolclaw active.json 中的 agentSessionId。
 *
 * snapshot:
 *   - 无 sessionId: 项目列表 + 选中项目的全部 transcript 概要
 *   - 有 sessionId: 该 transcript 的结构化轮次 + 会话头统计
 * subscribe: 监听选中项目的 CC 目录 .jsonl 变化 + evolclaw sessionsDir active.json 变化，防抖 150ms。
 *
 * 注：完整复制 evolclaw session source 逻辑（含两层缓存、费用计算、ec msg send 检测）。
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths, ccProjectsDir } from '../paths.js';
import { encodePath, scanChatDirs, readJsonFile, type SessionFile } from '../fs-utils.js';
import type { WatchSource } from './types.js';

type LogFn = (line: string) => void;
let _dlog: LogFn | null = null;
export function setDebugLog(log: LogFn | null): void { _dlog = log; }
function dlog(line: string): void { if (_dlog) try { _dlog(line); } catch {} }

// ── transcript 概要缓存（内存 + 磁盘双层，按 mtime 失效）──

interface TranscriptMeta {
  id: string; title: string; firstUser: string; gitBranch: string; version: string;
  userMsgs: number; totalMsgs: number; sizeKB: number; lastActivity: number;
}

const CACHE_VERSION = 2;
const _metaCache = new Map<string, { mtime: number; meta: TranscriptMeta }>();

function cacheDir(encoded: string): string {
  const dataDir = resolvePaths().dataDir;
  const currentRoot = path.join(dataDir, 'ecweb-cache');
  const legacyRoot = path.join(dataDir, 'watch-web-cache');
  if (!fs.existsSync(currentRoot) && fs.existsSync(legacyRoot)) {
    try { fs.renameSync(legacyRoot, currentRoot); } catch {}
  }
  return path.join(currentRoot, encoded);
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

function extractMeta(file: string, id: string, stat: fs.Stats): TranscriptMeta {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch {}
  let title = '', firstUser = '', gitBranch = '', version = '', userMsgs = 0, totalMsgs = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const isAsst = line.indexOf('"type":"assistant"') !== -1;
    const isUser = !isAsst && line.indexOf('"type":"user"') !== -1;
    if (isAsst) totalMsgs++;
    else if (isUser) { totalMsgs++; if (line.indexOf('"tool_result"') === -1) userMsgs++; }
    if ((!gitBranch || !version || !firstUser) && (line.indexOf('gitBranch') !== -1 || line.indexOf('"version"') !== -1 || line.indexOf('ai-title') !== -1 || (isUser && !firstUser))) {
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
      if (!version && o.version) version = o.version;
      if (o.type === 'ai-title' && o.title) title = o.title;
      if (!firstUser && o.type === 'user' && o.message) {
        const c = o.message.content;
        const t = typeof c === 'string' ? c : (Array.isArray(c) ? ((c.find((x: any) => x?.type === 'text') || {}).text || '') : '');
        if (t && !t.startsWith('<')) firstUser = t.replace(/\s+/g, ' ').trim().slice(0, 120);
      }
    }
  }
  return { id, title, firstUser, gitBranch, version, userMsgs, totalMsgs, sizeKB: Math.round(stat.size / 1024), lastActivity: stat.mtimeMs };
}

function listTranscripts(encoded: string): TranscriptMeta[] {
  const dir = path.join(ccProjectsDir(), encoded);
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
  const out: TranscriptMeta[] = [];
  let parsed = 0, hitMem = 0, hitDisk = 0;
  for (const f of files) {
    const file = path.join(dir, f);
    const id = f.replace(/\.jsonl$/, '');
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { continue; }
    const mtime = stat.mtimeMs;
    const mem = _metaCache.get(file);
    if (mem && mem.mtime === mtime) { out.push(mem.meta); hitMem++; continue; }
    const disk = readDiskCache(encoded, id, mtime, stat.size);
    if (disk) { _metaCache.set(file, { mtime, meta: disk }); out.push(disk); hitDisk++; continue; }
    const meta = extractMeta(file, id, stat);
    _metaCache.set(file, { mtime, meta });
    writeDiskCache(encoded, id, mtime, stat.size, meta);
    out.push(meta); parsed++;
  }
  dlog(`[session] listTranscripts ${encoded.slice(-20)}: ${files.length} files (mem=${hitMem} disk=${hitDisk} parsed=${parsed})`);
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
}

interface ProjectEntry { encoded: string; cwd: string; label: string; count: number; lastActivity: number; }

function listProjects(): ProjectEntry[] {
  const base = ccProjectsDir();
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out: ProjectEntry[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(base, d.name);
    let files: string[];
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    let last = 0;
    for (const f of files) {
      try { const m = fs.statSync(path.join(dirPath, f)).mtimeMs; if (m > last) last = m; } catch {}
    }
    let cwd = d.name;
    try {
      const newest = files.map(f => ({ f, m: fs.statSync(path.join(dirPath, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
      if (newest) {
        const fd = fs.openSync(path.join(dirPath, newest.f), 'r');
        const buf = Buffer.alloc(16384);
        const n = fs.readSync(fd, buf, 0, 16384, 0);
        fs.closeSync(fd);
        for (const line of buf.toString('utf-8', 0, n).split('\n')) {
          if (!line.trim()) continue;
          try { const o = JSON.parse(line); if (o.cwd) { cwd = o.cwd; break; } } catch {}
        }
      }
    } catch {}
    out.push({ encoded: d.name, cwd, label: cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || d.name, count: files.length, lastActivity: last });
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
}

function resolveProject(params: Record<string, any>, projects: ProjectEntry[]): ProjectEntry | null {
  if (params.project) {
    const found = projects.find(p => p.encoded === params.project);
    if (found) { dlog(`[session] resolveProject: matched param project=${params.project.slice(-24)}`); return found; }
    dlog(`[session] resolveProject: param project=${params.project.slice(-24)} NOT in ${projects.length} projects → falling back`);
  }
  const curEncoded = encodePath(process.cwd());
  const cur = projects.find(p => p.encoded === curEncoded);
  if (cur) { dlog(`[session] resolveProject: default to cwd project=${curEncoded.slice(-24)}`); return cur; }
  dlog(`[session] resolveProject: cwd project=${curEncoded.slice(-24)} not found → using first=${projects[0]?.encoded.slice(-24)}`);
  return projects[0] || null;
}

interface BindInfo { channelType: string; channelId: string; selfAID: string; peerName: string | null; name: string | null; updatedAt: number; }

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

// ── 完整 transcript 解析（省略 tool 参数/chat send 检测等细节，保留费用计算）──

const PRICING: Record<string, [number, number, number, number]> = {
  'claude-opus-4-8': [5, 6.25, 0.5, 25], 'claude-opus-4': [5, 6.25, 0.5, 25],
  'claude-sonnet-4-6': [3, 3.75, 0.3, 15], 'claude-sonnet-4': [3, 3.75, 0.3, 15],
  'claude-haiku-4-5-20251001': [0.8, 1, 0.08, 4],
};

function pricingFor(model: string): [number, number, number, number] {
  for (const key of Object.keys(PRICING)) if (model.startsWith(key)) return PRICING[key];
  if (model.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5-20251001'];
  return PRICING['claude-opus-4-8'];
}

function readTranscriptFile(file: string): any {
  const empty = { turns: [], totalTurns: 0, userMsgs: 0, totalMsgs: 0, counts: { userInput: 0, modelOutput: 0, toolCall: 0, toolResult: 0, msgSend: 0 }, inputTokens: 0, outputTokens: 0, contextTokens: 0, costUsd: 0, model: '', gitBranch: '', version: '', title: '', cwd: '' };
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return empty; }
  const turns: any[] = [];
  const counts = { userInput: 0, modelOutput: 0, toolCall: 0, toolResult: 0, msgSend: 0 };
  let inTok = 0, outTok = 0, model = '', branch = '', version = '', title = '', cwd = '', userMsgs = 0, totalMsgs = 0, contextTokens = 0, costUsd = 0, lastUsageKey = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const isAsst = line.indexOf('"type":"assistant"') !== -1;
    const isUser = !isAsst && line.indexOf('"type":"user"') !== -1;
    if (isAsst) totalMsgs++; else if (isUser) { totalMsgs++; if (line.indexOf('"tool_result"') === -1) userMsgs++; }
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!branch && o.gitBranch) branch = o.gitBranch;
    if (!version && o.version) version = o.version;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.type === 'ai-title' && o.title) title = o.title;
    if (o.type === 'assistant' && o.message?.usage) {
      const u = o.message.usage;
      const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0, out = u.output_tokens || 0;
      contextTokens = inp + cr + cc;
      const key = `${inp},${cr},${cc},${out}`;
      if (key !== lastUsageKey) {
        lastUsageKey = key;
        const [pi, pcw, pcr, po] = pricingFor(model || o.message.model);
        costUsd += (inp * pi + cc * pcw + cr * pcr + out * po) / 1_000_000;
      }
      if (u.input_tokens) inTok += u.input_tokens;
      if (u.output_tokens) outTok += u.output_tokens;
      if (o.message.model) model = o.message.model;
    }
    if (o.type === 'user' || o.type === 'assistant') {
      const content = o.message?.content;
      const arr: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : []);
      const blocks: any[] = [];
      let hasToolUse = false, hasToolResult = false;
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && item.text) {
          blocks.push({ kind: 'text', text: item.text });
        } else if (item.type === 'thinking' && item.thinking) {
          blocks.push({ kind: 'thinking', text: item.thinking });
        } else if (item.type === 'tool_use') {
          const inputStr = item.input ? JSON.stringify(item.input, null, 2) : '';
          blocks.push({ kind: 'tool_use', name: item.name || '', input: item.input || {}, inputStr });
          hasToolUse = true;
        } else if (item.type === 'tool_result') {
          const c = item.content;
          const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n') : '');
          blocks.push({ kind: 'tool_result', text, isError: !!item.is_error });
          hasToolResult = true;
        }
      }
      let category: string;
      if (o.type === 'user') {
        category = hasToolResult ? 'tool_result' : 'user_input';
      } else {
        category = hasToolUse ? 'tool_call' : 'model_output';
      }
      counts[category === 'user_input' ? 'userInput' : category === 'model_output' ? 'modelOutput' : category === 'tool_call' ? 'toolCall' : 'toolResult']++;
      turns.push({ role: o.type, ts: o.timestamp ? Date.parse(o.timestamp) : 0, uuid: o.uuid, category, blocks });
    }
  }
  const shown = turns.length > 500 ? turns.slice(-500) : turns;
  return { turns: shown, totalTurns: turns.length, userMsgs, totalMsgs, counts, inputTokens: inTok, outputTokens: outTok, contextTokens, costUsd, model, gitBranch: branch, version, title, cwd };
}

function buildSnapshot(params: Record<string, any>): any {
  const projects = listProjects();
  const bindMap = buildBindMap();
  const project = resolveProject(params, projects);
  if (!project) return { projects: [], project: null, transcripts: [], turns: [], sessionId: null };
  const metas = listTranscripts(project.encoded);
  const transcripts = metas.map(m => {
    const bind = bindMap.get(m.id);
    return { ...m, bound: !!bind, boundChannel: bind?.channelType ?? null, boundPeer: bind ? (bind.peerName || bind.channelId) : null, online: bind ? (Date.now() - bind.updatedAt < 5 * 60 * 1000) : false };
  });
  const projList = projects.map(p => ({ encoded: p.encoded, label: p.label, cwd: p.cwd, count: p.count }));
  const sessionId: string | null = params.sessionId || null;
  if (!sessionId) return { projects: projList, project: project.encoded, transcripts, turns: [], sessionId: null };
  const detail = readTranscriptFile(path.join(ccProjectsDir(), project.encoded, `${sessionId}.jsonl`));
  const bind = bindMap.get(sessionId);
  const header = { sessionId, title: detail.title, model: detail.model, gitBranch: detail.gitBranch, version: detail.version, cwd: detail.cwd || project.cwd, totalTurns: detail.totalTurns, userMsgs: detail.userMsgs, totalMsgs: detail.totalMsgs, counts: detail.counts, inputTokens: detail.inputTokens, outputTokens: detail.outputTokens, contextTokens: detail.contextTokens, costUsd: detail.costUsd, bound: !!bind, boundChannel: bind?.channelType ?? null, boundPeer: bind ? (bind.peerName || bind.channelId) : null, online: bind ? (Date.now() - bind.updatedAt < 5 * 60 * 1000) : false };
  return { projects: projList, project: project.encoded, transcripts, turns: detail.turns, sessionId, header };
}

export const sessionSource: WatchSource = {
  kind: 'session',
  async snapshot(params: Record<string, any> = {}): Promise<any> { return buildSnapshot(params); },
  subscribe(params: Record<string, any>, push: (data: any) => void): () => void {
    const p = resolvePaths();
    let projectWatcher: fs.FSWatcher | null = null, sessionWatcher: fs.FSWatcher | null = null, debounce: NodeJS.Timeout | null = null;
    const fire = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { try { push(buildSnapshot(params)); } catch {} }, 150); };
    const projects = listProjects();
    const project = resolveProject(params, projects);
    if (project) {
      const dir = path.join(ccProjectsDir(), project.encoded);
      try { projectWatcher = fs.watch(dir, (_evt, filename) => { if (filename && String(filename).endsWith('.jsonl')) fire(); }); } catch {}
    }
    try { sessionWatcher = fs.watch(p.sessionsDir, { recursive: true }, (_evt, filename) => { if (filename && String(filename).endsWith('active.json')) fire(); }); } catch {}
    return () => { if (projectWatcher) projectWatcher.close(); if (sessionWatcher) sessionWatcher.close(); if (debounce) clearTimeout(debounce); };
  },
};
