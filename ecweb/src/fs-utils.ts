/**
 * 文件系统工具层（独立版）— 内联自 evolclaw session-fs-store + watch-msg 数据层。
 *
 * 只包含 watch-web 实际用到的函数，无任何 npm 依赖。
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from './paths.js';

// ── 编解码（与 evolclaw encodeSegment / decodeDirSegment 一致）──

const UNSAFE_CHARS_RE = /[<>:"/\\|?*\x00-\x1F%]/g;

export function encodeSegment(s: string): string {
  return s.replace(UNSAFE_CHARS_RE, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

export function decodeDirSegment(seg: string): string {
  return seg.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 与 evolclaw cross-platform.ts encodePath 一致（CC transcript 目录名） */
export function encodePath(p: string): string {
  const isWindows = process.platform === 'win32';
  const norm = isWindows ? p.replace(/\\/g, '/') : p;
  return encodeURIComponent(norm).replace(/%2F/gi, '-').replace(/%3A/gi, '-').replace(/^-/, '');
}

// ── SessionFile（active.json 结构，仅用到的字段）──

export interface SessionFile {
  agentSessionId: string | null;
  channelType: string;
  channelId: string;
  chatType?: 'private' | 'group';
  selfAID?: string;
  name: string | null;
  updatedAt: number;
  metadata?: Record<string, any>;
}

// ── chat 目录扫描（与 evolclaw scanChatDirs 一致）──

export interface ChatDirInfo {
  dirPath: string;
  channelType: string;
  channelId: string;
  selfAID: string;
}

export function scanChatDirs(sessionsDir: string): ChatDirInfo[] {
  const results: ChatDirInfo[] = [];
  let channelTypes: fs.Dirent[];
  try { channelTypes = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch { return results; }
  for (const ct of channelTypes) {
    if (!ct.isDirectory()) continue;
    const channelType = ct.name;
    const ctDir = path.join(sessionsDir, channelType);
    let level2: fs.Dirent[];
    try { level2 = fs.readdirSync(ctDir, { withFileTypes: true }); } catch { continue; }
    if (channelType === 'aun') {
      for (const selfEnc of level2) {
        if (!selfEnc.isDirectory()) continue;
        const selfAID = decodeDirSegment(selfEnc.name);
        const selfDir = path.join(ctDir, selfEnc.name);
        let peers: fs.Dirent[];
        try { peers = fs.readdirSync(selfDir, { withFileTypes: true }); } catch { continue; }
        for (const peerEnc of peers) {
          if (!peerEnc.isDirectory() || peerEnc.name.startsWith('_')) continue;
          results.push({
            dirPath: path.join(selfDir, peerEnc.name),
            channelType,
            channelId: decodeDirSegment(peerEnc.name),
            selfAID,
          });
        }
      }
    } else {
      for (const chanEnc of level2) {
        if (!chanEnc.isDirectory()) continue;
        results.push({
          dirPath: path.join(ctDir, chanEnc.name),
          channelType,
          channelId: decodeDirSegment(chanEnc.name),
          selfAID: '',
        });
      }
    }
  }
  return results;
}

export function readJsonFile<T = any>(filePath: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return undefined; }
}

export function readAllJsonlLines<T = any>(filePath: string): T[] {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
      .filter((x): x is T => x !== null);
  } catch { return []; }
}

// ── watch-msg 数据层函数 ──

export interface MessageLogEntry {
  ts: number; dir: 'in' | 'out'; from: string; to: string;
  chatType: 'private' | 'group'; groupId: string | null;
  msgId: string | null; msgType: string; content: string;
  replyTo: string | null; agent: string | null; model: string | null;
  permMode: string | null; durationMs: number | null;
  numTurns?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  payloadType?: string;
  encrypt?: boolean; chatmode?: string; source?: string;
  channelType?: string; selfAID?: string; peerName?: string | null; peerType?: string; groupName?: string | null;
}

export function isTransientProtocolMessage(
  entry: Pick<MessageLogEntry, 'msgType' | 'payloadType'> | null | undefined,
): boolean {
  if (!entry) return false;
  const transient = (value?: string): boolean => {
    const type = value?.trim().toLowerCase();
    if (!type) return false;
    return [
      'status', 'event', 'events', 'task.status', 'activity', 'thought',
      'handoff_state', 'handoff_result',
    ].includes(type)
      || ['menu.', 'status.', 'event.', 'events.', 'task.status.', 'activity.']
        .some(prefix => type.startsWith(prefix));
  };
  return transient(entry.payloadType) || transient(entry.msgType);
}

export interface PeerInfo {
  peerId: string; peerName: string | null; inbound: number; outbound: number; lastAt: number;
}

export interface AidInfo {
  aid: string; totalIn: number; totalOut: number; peerCount: number;
}

export function getSessionsAunDir(): string {
  return path.join(resolvePaths().sessionsDir, 'aun');
}

export function listLocalAids(aunDir: string): string[] {
  try {
    return fs.readdirSync(aunDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => decodeDirSegment(e.name));
  } catch { return []; }
}

export function listPeers(aunDir: string, localAid: string): string[] {
  const aidDir = path.join(aunDir, encodeSegment(localAid));
  try {
    return fs.readdirSync(aidDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => decodeDirSegment(e.name));
  } catch { return []; }
}

export function readMessages(aunDir: string, localAid: string, peerId: string): MessageLogEntry[] {
  return readAllJsonlLines<MessageLogEntry>(
    path.join(aunDir, encodeSegment(localAid), encodeSegment(peerId), 'messages.jsonl'),
  ).filter(m => !isTransientProtocolMessage(m));
}

function readPeerName(aunDir: string, localAid: string, peerId: string): string | null {
  return readJsonFile<any>(
    path.join(aunDir, encodeSegment(localAid), encodeSegment(peerId), 'active.json'),
  )?.metadata?.peerName ?? null;
}

export function loadAidInfo(aunDir: string, aid: string): AidInfo {
  const peers = listPeers(aunDir, aid);
  let totalIn = 0, totalOut = 0;
  for (const peer of peers) {
    for (const m of readMessages(aunDir, aid, peer)) {
      if (m.dir === 'in') totalIn++; else totalOut++;
    }
  }
  return { aid, totalIn, totalOut, peerCount: peers.length };
}

export function loadPeerInfos(aunDir: string, localAid: string): PeerInfo[] {
  return listPeers(aunDir, localAid).map(peerId => {
    const msgs = readMessages(aunDir, localAid, peerId);
    let inbound = 0, outbound = 0, lastAt = 0;
    for (const m of msgs) {
      if (m.dir === 'in') inbound++; else outbound++;
      if (m.ts > lastAt) lastAt = m.ts;
    }
    return { peerId, peerName: readPeerName(aunDir, localAid, peerId), inbound, outbound, lastAt };
  }).sort((a, b) => b.lastAt - a.lastAt);
}

export function loadAllMessages(aunDir: string, localAid: string): MessageLogEntry[] {
  const all: MessageLogEntry[] = [];
  for (const peer of listPeers(aunDir, localAid)) all.push(...readMessages(aunDir, localAid, peer));
  all.sort((a, b) => a.ts - b.ts);
  return all.length > 1000 ? all.slice(-1000) : all;
}
