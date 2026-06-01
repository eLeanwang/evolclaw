/**
 * 会话数据源 — 展示 CC（Claude Code / Agent SDK）的会话日志。
 *
 * 列表数据源是 CC transcript 本身：~/.claude/projects/<encodedProject>/*.jsonl
 * 每个 .jsonl 就是一段对话历史。evolclaw 的 active.json 仅用于交叉标注
 * 「当前绑定 / 在线」（agentSessionId 匹配）。
 *
 * snapshot:
 *   - 无 sessionId: 返回项目列表 + 选中项目的全部 transcript 概要
 *   - 有 sessionId: 返回该 transcript 的结构化轮次 + 会话头统计
 * subscribe: 监听选中项目的 CC 目录 .jsonl 变化，防抖 150ms。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePaths } from '../../../paths.js';
import { encodePath } from '../../../utils/cross-platform.js';
import { scanChatDirs, readJsonFile, type SessionFile } from '../../../core/session/session-fs-store.js';
import { dlog } from '../debug-log.js';
import type { WatchSource } from './types.js';

interface ToolParam { k: string; v: string; }

/** 当一次工具调用其实是 `ec msg send` 发消息时，解析出的对话信息 */
interface ChatSend {
  peer: string;     // 对端（self 之后的那个 id）
  self: string;     // 发送者 self-aid
  text: string;     // 真正发出去的消息正文（完整，不截断）
}

interface Block {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  tool?: string;
  params?: ToolParam[];
  isError?: boolean;
  chat?: ChatSend;   // tool_use 块若是 ec msg send，则带上
}

type TurnCategory = 'user_input' | 'model_output' | 'tool_call' | 'tool_result' | 'system';

interface TurnEntry {
  role: 'user' | 'assistant' | 'system' | 'other';
  type: string;
  category: TurnCategory;
  blocks: Block[];
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  ts: number;
  uuid: string;
}

/** active.json 绑定信息：agentSessionId → 绑定的渠道/对端 */
interface BindInfo {
  channelType: string;
  channelId: string;
  selfAID: string;
  peerName: string | null;
  name: string | null;
  updatedAt: number;
}

function ccProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}


/** 扫描 evolclaw active.json，建 agentSessionId → 绑定信息 的映射 */
function buildBindMap(): Map<string, BindInfo> {
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
  } catch { /* sessionsDir may not exist */ }
  return map;
}

interface ProjectEntry {
  encoded: string;      // CC 目录名
  cwd: string;          // 真实工作目录（从 transcript 内读，回退解码目录名）
  label: string;        // 末级目录名
  count: number;        // transcript 数
  lastActivity: number; // 最近 mtime
}

/** 列出 ~/.claude/projects 下所有含 transcript 的项目 */
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
      try { const m = fs.statSync(path.join(dirPath, f)).mtimeMs; if (m > last) last = m; } catch { /* skip */ }
    }
    // cwd: 从最近 transcript 的首行读 cwd 字段，回退用解码目录名
    let cwd = '';
    try {
      const newest = files.map(f => ({ f, m: fs.statSync(path.join(dirPath, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0];
      if (newest) cwd = readCwdFromTranscript(path.join(dirPath, newest.f));
    } catch { /* ignore */ }
    if (!cwd) cwd = d.name;
    out.push({
      encoded: d.name,
      cwd,
      label: cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || d.name,
      count: files.length,
      lastActivity: last,
    });
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
}

// ── transcript 概要缓存（内存 + 磁盘双层，按 mtime 失效）──
interface TranscriptMeta {
  id: string;           // 文件名去掉 .jsonl（= agentSessionId）
  title: string;
  firstUser: string;
  gitBranch: string;
  version: string;
  userMsgs: number;     // 用户输入消息数（不含 tool_result）
  totalMsgs: number;    // 总消息数（user + assistant）
  sizeKB: number;
  lastActivity: number;
}
const CACHE_VERSION = 2;   // 缓存格式版本，结构变更时 +1 使旧缓存失效
const _metaCache = new Map<string, { mtime: number; meta: TranscriptMeta }>();

// ── 磁盘缓存：每个 CC 日志文件对应一个摘要文件 ──
// 位置：$EVOLCLAW_HOME/data/watch-web-cache/<encodedProject>/<sessionId>.json
// 失效判据：缓存内记录的 mtime/size 与源文件不一致，或 CACHE_VERSION 变更。

function cacheDir(encoded: string): string {
  return path.join(resolvePaths().dataDir, 'watch-web-cache', encoded);
}

function cacheFilePath(encoded: string, id: string): string {
  return path.join(cacheDir(encoded), `${id}.json`);
}

interface CacheRecord {
  v: number;
  mtime: number;
  size: number;
  meta: TranscriptMeta;
}

function readDiskCache(encoded: string, id: string, mtime: number, size: number): TranscriptMeta | null {
  try {
    const raw = fs.readFileSync(cacheFilePath(encoded, id), 'utf-8');
    const rec = JSON.parse(raw) as CacheRecord;
    if (rec.v === CACHE_VERSION && rec.mtime === mtime && rec.size === size && rec.meta) {
      return rec.meta;
    }
  } catch { /* miss */ }
  return null;
}

function writeDiskCache(encoded: string, id: string, mtime: number, size: number, meta: TranscriptMeta): void {
  try {
    const dir = cacheDir(encoded);
    fs.mkdirSync(dir, { recursive: true });
    const rec: CacheRecord = { v: CACHE_VERSION, mtime, size, meta };
    const tmp = cacheFilePath(encoded, id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, cacheFilePath(encoded, id));
  } catch { /* best effort */ }
}

/** 读文件头部若干字节，提取首个带 cwd 字段的记录 */
function readCwdFromTranscript(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, 16384, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf-8', 0, n).split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.cwd) return o.cwd; } catch { /* 截断行跳过 */ }
    }
  } catch { /* ignore */ }
  return '';
}

/** 廉价提取单个 transcript 概要：读头部 32KB + 尾部 32KB，避免全读大文件 */
/**
 * 全量解析 transcript，提取摘要（含精确消息数）。
 * 仅在缓存失效时调用一次；结果写入磁盘缓存，文件不变就不再读。
 */
function extractMeta(file: string, id: string, stat: fs.Stats): TranscriptMeta {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { /* ignore */ }

  let title = '', firstUser = '', gitBranch = '', version = '';
  let userMsgs = 0, totalMsgs = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    // 廉价预筛：先用字符串判断类型再决定是否 JSON.parse（数消息不需要 parse）
    const isAsst = line.indexOf('"type":"assistant"') !== -1;
    const isUser = !isAsst && line.indexOf('"type":"user"') !== -1;
    if (isAsst) totalMsgs++;
    else if (isUser) {
      totalMsgs++;
      // 真实用户输入：content 不是 tool_result（工具结果也是 type:user）
      if (line.indexOf('"tool_result"') === -1) userMsgs++;
    }
    // 元数据只需在还没拿到时 parse
    if ((!gitBranch || !version || !firstUser) || isAsst === false) {
      // 仅对可能含元数据的行 parse：含 gitBranch/version/ai-title/首条 user
      if (line.indexOf('gitBranch') !== -1 || line.indexOf('"version"') !== -1 ||
          line.indexOf('ai-title') !== -1 || (isUser && !firstUser)) {
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        if (!gitBranch && o.gitBranch) gitBranch = o.gitBranch;
        if (!version && o.version) version = o.version;
        if (o.type === 'ai-title' && o.title) title = o.title;
        if (!firstUser && o.type === 'user' && o.message) {
          const c = o.message.content;
          const t = typeof c === 'string' ? c : (Array.isArray(c) ? ((c.find((x: any) => x && x.type === 'text') || {}).text || '') : '');
          if (t && !t.startsWith('<')) firstUser = t.replace(/\s+/g, ' ').trim().slice(0, 120);
        }
      }
    }
  }
  return {
    id,
    title: title || '',
    firstUser,
    gitBranch,
    version,
    userMsgs,
    totalMsgs,
    sizeKB: Math.round(stat.size / 1024),
    lastActivity: stat.mtimeMs,
  };
}

/** 列出某项目下全部 transcript 概要（内存 + 磁盘双层缓存，按 mtime+size 失效） */
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

    // L1 内存缓存
    const mem = _metaCache.get(file);
    if (mem && mem.mtime === mtime) { out.push(mem.meta); hitMem++; continue; }

    // L2 磁盘缓存
    const disk = readDiskCache(encoded, id, mtime, stat.size);
    if (disk) {
      _metaCache.set(file, { mtime, meta: disk });
      out.push(disk); hitDisk++; continue;
    }

    // miss：全量解析 + 双写缓存
    const meta = extractMeta(file, id, stat);
    _metaCache.set(file, { mtime, meta });
    writeDiskCache(encoded, id, mtime, stat.size, meta);
    out.push(meta); parsed++;
  }
  dlog(`[session] listTranscripts ${encoded.slice(-20)}: ${files.length} files (mem=${hitMem} disk=${hitDisk} parsed=${parsed})`);
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
}


function toolParams(name: string, input: any): ToolParam[] {
  if (!input || typeof input !== 'object') return [];

  // 已知工具：挑最有信息量的参数优先展示
  const PRIMARY: Record<string, string[]> = {
    Read: ['file_path'],
    Write: ['file_path'],
    Edit: ['file_path'],
    MultiEdit: ['file_path'],
    NotebookEdit: ['notebook_path'],
    Bash: ['command'],
    Glob: ['pattern', 'path'],
    Grep: ['pattern', 'path', 'glob'],
    Task: ['description'],
    WebFetch: ['url'],
    WebSearch: ['query'],
  };

  const clip = (v: any, max = 400): string => {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s == null) return '';
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  };

  const keys = PRIMARY[name] || Object.keys(input);
  const params: ToolParam[] = [];
  for (const k of keys) {
    if (input[k] === undefined || input[k] === null || input[k] === '') continue;
    params.push({ k, v: clip(input[k]) });
  }
  return params;
}

/**
 * 检测一次 Bash 调用是否在执行 `ec msg send <self> <peer> "<text>"`
 * （也兼容 evolclaw / ec、group send 不算私聊对话）。
 * 返回解析出的发送方/对端/正文（完整文本），否则 null。
 */
function detectMsgSend(name: string, input: any): ChatSend | null {
  if (name !== 'Bash' || !input || typeof input.command !== 'string') return null;
  const cmd: string = input.command;
  // 必须是 msg send（私聊）；排除 group send
  if (!/\b(ec|evolclaw)\s+msg\s+send\b/.test(cmd)) return null;

  // 粗切：取 "msg send" 之后的部分，做简单 shell 分词（支持双引号/单引号）
  const after = cmd.replace(/^[\s\S]*?\bmsg\s+send\b/, '').trim();
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(after)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\(["\\])/g, '$1'));
    else if (m[2] !== undefined) tokens.push(m[2]);
    else tokens.push(m[3]);
  }
  // 跳过 --flag / --opt value 形式的选项，取前两个位置参数为 self/peer，其余拼为正文
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) { if (!t.includes('=') && tokens[i + 1] && !tokens[i + 1].startsWith('-') && positional.length < 2) i++; continue; }
    positional.push(t);
  }
  if (positional.length < 3) return null;
  const self = positional[0];
  const peer = positional[1];
  const text = positional.slice(2).join(' ').trim();
  if (!text) return null;
  return { self, peer, text };
}

function extractBlocks(content: any): Block[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) {
      blocks.push({ kind: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      const chat = detectMsgSend(block.name, block.input);
      const b: Block = { kind: 'tool_use', tool: block.name || '?', params: toolParams(block.name, block.input) };
      if (chat) b.chat = chat;
      blocks.push(b);
    } else if (block.type === 'tool_result') {
      const c = block.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text || '').join('') : '';
      const clipped = txt.length > 1200 ? txt.slice(0, 1200) + `\n… (共 ${txt.length} 字符)` : txt;
      blocks.push({ kind: 'tool_result', text: clipped, isError: !!block.is_error });
    } else if (block.type === 'thinking') {
      blocks.push({ kind: 'thinking', text: block.thinking || '' });
    }
  }
  return blocks;
}

interface CategoryCounts {
  userInput: number;
  modelOutput: number;
  toolCall: number;
  toolResult: number;
  msgSend: number;     // 通过 ec msg send 自主发送的消息数
}

interface TranscriptDetail {
  turns: TurnEntry[];
  totalTurns: number;     // 渲染出的轮次（去掉空内容后，可能 <消息数）
  userMsgs: number;       // 与列表口径一致：用户输入消息数（不含 tool_result）
  totalMsgs: number;      // 与列表口径一致：user + assistant 消息数
  counts: CategoryCounts; // 4 类计数
  inputTokens: number;
  outputTokens: number;
  model: string;
  gitBranch: string;
  version: string;
  title: string;
  cwd: string;
}

function readTranscriptFile(file: string): TranscriptDetail {
  const empty: TranscriptDetail = { turns: [], totalTurns: 0, userMsgs: 0, totalMsgs: 0, counts: { userInput: 0, modelOutput: 0, toolCall: 0, toolResult: 0, msgSend: 0 }, inputTokens: 0, outputTokens: 0, model: '', gitBranch: '', version: '', title: '', cwd: '' };
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return empty; }
  const turns: TurnEntry[] = [];
  let inTok = 0, outTok = 0, model = '', branch = '', version = '', title = '', cwd = '';
  let userMsgs = 0, totalMsgs = 0;
  // 计数：用户输入 / 模型输出 / 工具调用 / 工具结果 / 发送消息
  let cUserInput = 0, cModelOutput = 0, cToolCall = 0, cToolResult = 0, cMsgSend = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // 消息计数与列表 extractMeta 口径一致：数 user/assistant，user 排除 tool_result
    const isAsst = line.indexOf('"type":"assistant"') !== -1;
    const isUser = !isAsst && line.indexOf('"type":"user"') !== -1;
    if (isAsst) totalMsgs++;
    else if (isUser) { totalMsgs++; if (line.indexOf('"tool_result"') === -1) userMsgs++; }

    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!branch && o.gitBranch) branch = o.gitBranch;
    if (!version && o.version) version = o.version;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (o.type === 'ai-title' && o.title) title = o.title;
    const type = o.type || 'other';
    if (type !== 'user' && type !== 'assistant' && type !== 'system') continue;
    const msg = o.message || {};
    const role: TurnEntry['role'] = type === 'user' ? 'user' : type === 'assistant' ? 'assistant' : 'system';
    const blocks: Block[] = type === 'system'
      ? (o.content || o.text ? [{ kind: 'text', text: String(o.content || o.text) }] : [])
      : extractBlocks(msg.content);
    if (!blocks.length) continue;

    // 归类（block 级，因为 CC 的 tool_result 在协议上是 type:user）
    const hasText = blocks.some(b => b.kind === 'text' || b.kind === 'thinking');
    const nToolUse = blocks.filter(b => b.kind === 'tool_use').length;
    const nToolResult = blocks.filter(b => b.kind === 'tool_result').length;
    let category: TurnEntry['category'];
    if (role === 'system') category = 'system';
    else if (role === 'user') category = hasText ? 'user_input' : 'tool_result';
    else category = (nToolUse > 0 && !hasText) ? 'tool_call' : 'model_output';
    if (category === 'user_input') cUserInput++;
    else if (category === 'model_output') cModelOutput++;
    cToolCall += nToolUse;
    cToolResult += nToolResult;
    cMsgSend += blocks.filter(b => b.kind === 'tool_use' && b.chat).length;

    const usage = msg.usage || {};
    if (usage.input_tokens) inTok += usage.input_tokens;
    if (usage.output_tokens) outTok += usage.output_tokens;
    if (msg.model) model = msg.model;
    turns.push({
      role,
      type,
      category,
      blocks,
      model: msg.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ts: o.timestamp ? Date.parse(o.timestamp) : 0,
      uuid: o.uuid || '',
    });
  }
  const totalTurns = turns.length;
  const shown = totalTurns > 500 ? turns.slice(-500) : turns;
  return {
    turns: shown, totalTurns, userMsgs, totalMsgs,
    counts: { userInput: cUserInput, modelOutput: cModelOutput, toolCall: cToolCall, toolResult: cToolResult, msgSend: cMsgSend },
    inputTokens: inTok, outputTokens: outTok, model, gitBranch: branch, version, title, cwd,
  };
}

/** 解析选中的项目：params.project 是 encoded 目录名；缺省用当前 cwd 对应项目 */
function resolveProject(params: Record<string, any>, projects: ProjectEntry[]): ProjectEntry | null {
  if (params.project) {
    const found = projects.find(p => p.encoded === params.project);
    if (found) { dlog(`[session] resolveProject: matched param project=${params.project.slice(-24)}`); return found; }
    dlog(`[session] resolveProject: param project=${params.project.slice(-24)} NOT in ${projects.length} projects → falling back`);
  }
  // 默认：当前工作目录对应的项目
  const curEncoded = encodePath(process.cwd());
  const cur = projects.find(p => p.encoded === curEncoded);
  if (cur) { dlog(`[session] resolveProject: default to cwd project=${curEncoded.slice(-24)}`); return cur; }
  dlog(`[session] resolveProject: cwd project=${curEncoded.slice(-24)} not found → using first=${projects[0]?.encoded.slice(-24)}`);
  return projects[0] || null;
}

function buildSnapshot(params: Record<string, any>): any {
  const projects = listProjects();
  const bindMap = buildBindMap();
  const project = resolveProject(params, projects);

  if (!project) {
    return { projects: [], project: null, transcripts: [], turns: [], sessionId: null };
  }

  const metas = listTranscripts(project.encoded);
  // 附加绑定信息
  const transcripts = metas.map(m => {
    const bind = bindMap.get(m.id);
    return {
      ...m,
      bound: !!bind,
      boundChannel: bind ? bind.channelType : null,
      boundPeer: bind ? (bind.peerName || bind.channelId) : null,
      online: bind ? (Date.now() - bind.updatedAt < 5 * 60 * 1000) : false,
    };
  });

  const projList = projects.map(p => ({ encoded: p.encoded, label: p.label, cwd: p.cwd, count: p.count }));
  const sessionId: string | null = params.sessionId || null;

  if (!sessionId) {
    return { projects: projList, project: project.encoded, transcripts, turns: [], sessionId: null };
  }

  // 详情：按 sessionId（= 文件名）读全量
  const file = path.join(ccProjectsDir(), project.encoded, `${sessionId}.jsonl`);
  const detail = readTranscriptFile(file);
  const bind = bindMap.get(sessionId);
  const header = {
    sessionId,
    title: detail.title,
    model: detail.model,
    gitBranch: detail.gitBranch,
    version: detail.version,
    cwd: detail.cwd || project.cwd,
    totalTurns: detail.totalTurns,
    userMsgs: detail.userMsgs,
    totalMsgs: detail.totalMsgs,
    counts: detail.counts,
    inputTokens: detail.inputTokens,
    outputTokens: detail.outputTokens,
    bound: !!bind,
    boundChannel: bind ? bind.channelType : null,
    boundPeer: bind ? (bind.peerName || bind.channelId) : null,
    online: bind ? (Date.now() - bind.updatedAt < 5 * 60 * 1000) : false,
  };
  return { projects: projList, project: project.encoded, transcripts, turns: detail.turns, sessionId, header };
}

export const sessionSource: WatchSource = {
  kind: 'session',

  async snapshot(params: Record<string, any> = {}): Promise<any> {
    return buildSnapshot(params);
  },

  subscribe(params: Record<string, any>, push: (data: any) => void): () => void {
    const p = resolvePaths();
    let projectWatcher: fs.FSWatcher | null = null;
    let sessionWatcher: fs.FSWatcher | null = null;
    let debounce: NodeJS.Timeout | null = null;

    const fire = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try { push(buildSnapshot(params)); } catch { /* ignore */ }
      }, 150);
    };

    // 监听选中项目的 CC 目录（.jsonl 新增/变化 = 会话活动）
    const projects = listProjects();
    const project = resolveProject(params, projects);
    if (project) {
      const dir = path.join(ccProjectsDir(), project.encoded);
      try {
        projectWatcher = fs.watch(dir, (_evt, filename) => {
          if (filename && String(filename).endsWith('.jsonl')) fire();
        });
      } catch { /* dir may not exist */ }
    }

    // 监听 evolclaw 会话目录（active.json 变化 → 绑定/在线状态变化）
    try {
      sessionWatcher = fs.watch(p.sessionsDir, { recursive: true }, (_evt, filename) => {
        if (filename && String(filename).endsWith('active.json')) fire();
      });
    } catch { /* sessionsDir may not exist */ }

    return () => {
      if (projectWatcher) projectWatcher.close();
      if (sessionWatcher) sessionWatcher.close();
      if (debounce) clearTimeout(debounce);
    };
  },
};
