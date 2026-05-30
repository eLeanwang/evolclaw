import fs from 'fs';
import path from 'path';

export interface SessionFile {
  id: string;
  channel: string;            // 实例名（channelName，短名，如 'main' 或 'secretary-bot'）
  channelType: string;        // 类型（aun/feishu/wechat/...）；写入时确保填充
  channelId: string;          // 路由键
  sessionKey: string;         // agent 内部会话路由键 (channelType#urlEncode(channelId)#urlEncode(threadId))
  selfAID: string;            // 本地身份（agent AID）
  agentType: string;
  threadId: string;
  chatType: string;
  chatMode: string;
  projectPath: string;
  agentSessionId: string | null;
  name: string | null;
  activeTask: string | null;
  permissionMode: string;
  metadata: Record<string, any>;
  createdAt: number;
  createdAtStr: string;
  updatedAt: number;
  updatedAtStr: string;
}

export interface HealthRecord {
  type: 'success' | 'error' | 'reset';
  sessionId: string;
  agentType?: string;
  agentName?: string;
  errorType?: string;
  error?: string;
  durationMs?: number;
  reason?: string;
  at: number;
  atStr: string;
}

// 文件系统非法字符（Windows 最严格）：< > : " / \ | ? *
// 还有控制字符 0x00-0x1F。我们把这些字符编码为 %XX（hex 大写）。
// `%` 本身也要转义为 %25，保证可逆。
const UNSAFE_CHARS_RE = /[<>:"/\\|?*\x00-\x1F%]/g;

function encodeSegment(s: string): string {
  return s.replace(UNSAFE_CHARS_RE, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function decodeSegment(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * 计算 chat 目录的完整路径。
 * 统一三层：sessionsDir/<channelType>/<urlEncode(selfAID)>/<urlEncode(channelId)>/
 *
 * 注：channelType 自身不编码（限定枚举值，不含非法字符）。
 */
export function chatDirPath(sessionsDir: string, channelType: string, channelId: string, selfAID: string): string {
  return path.join(sessionsDir, channelType, encodeSegment(selfAID), encodeSegment(channelId));
}

/** 解码目录段（用于扫描时把目录名还原为原始 channelId/selfAID） */
export function decodeDirSegment(seg: string): string {
  return decodeSegment(seg);
}

export function generateSessionId(now?: number): string {
  const ts = now ?? Date.now();
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `meta_${yyyy}${mm}${dd}_${ts}`;
}

export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}`;
}

export function atomicWriteJson(filePath: string, data: any): void {
  const tmpPath = filePath + '.tmp';
  const content = JSON.stringify(data, null, 2) + '\n';
  const fd = fs.openSync(tmpPath, 'w');
  fs.writeSync(fd, content);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  try { fs.unlinkSync(filePath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  fs.renameSync(tmpPath, filePath);
}

export function appendJsonl(filePath: string, record: any): void {
  const line = JSON.stringify(record) + '\n';
  const fd = fs.openSync(filePath, 'a');
  fs.writeSync(fd, line);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export function readJsonFile<T = any>(filePath: string): T | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (e: any) {
    if (e.code === 'ENOENT') return undefined;
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
}

export function readLastJsonlLine<T = any>(filePath: string): T | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try { return JSON.parse(line) as T; } catch { continue; }
    }
    return undefined;
  } catch (e: any) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
}

export function readAllJsonlLines<T = any>(filePath: string): T[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const results: T[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { results.push(JSON.parse(trimmed) as T); } catch { /* skip corrupt line */ }
    }
    return results;
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 扫描所有 chat 目录。
 * 统一三层：channelType / selfAID / channelId。
 */
export function scanChatDirs(sessionsDir: string): {
  channelType: string;
  selfAID: string;
  channelId: string;
  dirPath: string;
}[] {
  const results: { channelType: string; selfAID: string; channelId: string; dirPath: string }[] = [];

  let typeEntries: fs.Dirent[];
  try {
    typeEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  for (const typeEntry of typeEntries) {
    if (!typeEntry.isDirectory()) continue;
    const channelType = typeEntry.name;
    const typeDir = path.join(sessionsDir, channelType);
    let selfEntries: fs.Dirent[];
    try {
      selfEntries = fs.readdirSync(typeDir, { withFileTypes: true });
    } catch { continue; }
    for (const selfEntry of selfEntries) {
      if (!selfEntry.isDirectory()) continue;
      const selfDir = path.join(typeDir, selfEntry.name);
      let chatEntries: fs.Dirent[];
      try {
        chatEntries = fs.readdirSync(selfDir, { withFileTypes: true });
      } catch { continue; }
      for (const chatEntry of chatEntries) {
        if (!chatEntry.isDirectory()) continue;
        results.push({
          channelType,
          selfAID: decodeSegment(selfEntry.name),
          channelId: decodeSegment(chatEntry.name),
          dirPath: path.join(selfDir, chatEntry.name),
        });
      }
    }
  }
  return results;
}

export function scanMetaFiles(chatDir: string): string[] {
  try {
    const entries = fs.readdirSync(chatDir);
    return entries
      .filter(f => f.startsWith('meta_') && f.endsWith('.jsonl'))
      .sort();
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export function ensureChatDir(sessionsDir: string, channelType: string, channelId: string, selfAID: string): string {
  const dir = chatDirPath(sessionsDir, channelType, channelId, selfAID);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '_threads'), { recursive: true });
  fs.mkdirSync(path.join(dir, '_trash'), { recursive: true });
  return dir;
}

export interface ThreadIndexEntry {
  sessionId: string;
  sessionKey: string;
  metaFile: string;
}

export function readThreadIndex(chatDir: string): Record<string, ThreadIndexEntry> {
  const raw = readJsonFile<Record<string, string | ThreadIndexEntry>>(path.join(chatDir, '_threads', 'thread-index.json')) || {};
  // Migrate legacy format: { threadId: sessionId } → { threadId: { sessionId, sessionKey, metaFile } }
  const result: Record<string, ThreadIndexEntry> = {};
  for (const [tid, val] of Object.entries(raw)) {
    if (typeof val === 'string') {
      // Legacy: val is sessionId
      result[tid] = { sessionId: val, sessionKey: '', metaFile: `${val}.jsonl` };
    } else {
      result[tid] = val;
    }
  }
  return result;
}

export function writeThreadIndex(chatDir: string, index: Record<string, ThreadIndexEntry>): void {
  atomicWriteJson(path.join(chatDir, '_threads', 'thread-index.json'), index);
}

