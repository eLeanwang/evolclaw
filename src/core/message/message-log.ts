import path from 'path';
import { appendJsonl, chatDirPath } from '../session/session-fs-store.js';
import { logger } from '../../utils/logger.js';

export interface MessageLogEntry {
  ts: number;
  time: string;
  dir: 'in' | 'out';
  from: string;
  to: string;
  chatType: 'private' | 'group';
  groupId: string | null;
  msgId: string | null;
  msgType: 'text' | 'image' | 'file' | 'command' | 'thought' | 'handoff_state' | 'handoff_result';
  content: string;
  replyTo: string | null;
  agent: string | null;
  model: string | null;
  permMode: string | null;
  cmdParsed: string | null;
  durationMs: number | null;
  numTurns?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  encrypt?: boolean;
  chatmode?: string;
  peerName?: string;
  peerType?: string;
  source?: 'daemon' | 'cli' | 'msg' | 'ctl' | 'owner-inject' | 'handoff';
  handoff?: {
    kind?: 'request_to_target' | 'response_to_origin';
    event?: 'consumed';
    origin?: {
      session_id?: string;
      message_id?: string;
      channel?: string;
      peerId?: string;
      threadId?: string;
      peerName?: string;
      peerType?: string;
      role?: string;
    };
    consumed_by_msg_id?: string;
    match?: 'ref' | 'inferred';
    request_content?: string;
  };
}

const MESSAGE_LOG_FILE = 'messages.jsonl';

// 入方向去重：最近 msgId 缓存（LRU 风格，最多 200 条）
const recentMsgIds = new Set<string>();
const DEDUP_MAX = 200;

function isDuplicate(msgId: string | null): boolean {
  if (!msgId) return false;
  if (recentMsgIds.has(msgId)) return true;
  if (recentMsgIds.size >= DEDUP_MAX) {
    const first = recentMsgIds.values().next().value!;
    recentMsgIds.delete(first);
  }
  recentMsgIds.add(msgId);
  return false;
}

function formatTimestampMs(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mo}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

export function messageLogPath(chatDir: string): string {
  return path.join(chatDir, MESSAGE_LOG_FILE);
}

export function resolveChatDir(sessionsDir: string, channelType: string, channelId: string, selfAID: string): string {
  return chatDirPath(sessionsDir, channelType, channelId, selfAID);
}

export function appendMessageLog(chatDir: string, entry: MessageLogEntry): void {
  if (entry.dir === 'in' && isDuplicate(entry.msgId)) {
    logger.debug(`[MessageLog] Duplicate msgId skipped: ${entry.msgId}`);
    return;
  }
  try {
    appendJsonl(messageLogPath(chatDir), entry);
  } catch (e) {
    logger.warn(`[MessageLog] Failed to write message log: ${e}`);
  }
}

export function buildInboundEntry(opts: {
  from: string;
  to: string;
  chatType: 'private' | 'group';
  groupId?: string | null;
  msgId?: string | null;
  content: string;
  replyTo?: string | null;
  permMode?: string | null;
  timestamp?: number;
  encrypt?: boolean;
  chatmode?: string;
  peerName?: string;
  peerType?: string;
  source?: 'daemon' | 'cli' | 'msg' | 'ctl' | 'owner-inject';
}): MessageLogEntry {
  const ts = opts.timestamp || Date.now();
  const isCommand = opts.content.startsWith('/');
  return {
    ts,
    time: formatTimestampMs(ts),
    dir: 'in',
    from: opts.from,
    to: opts.to,
    chatType: opts.chatType,
    groupId: opts.groupId ?? null,
    msgId: opts.msgId ?? null,
    msgType: isCommand ? 'command' : 'text',
    content: opts.content,
    replyTo: opts.replyTo ?? null,
    agent: null,
    model: null,
    permMode: opts.permMode ?? null,
    cmdParsed: isCommand ? opts.content.split(/\s/)[0] : null,
    durationMs: null,
    encrypt: opts.encrypt,
    chatmode: opts.chatmode,
    peerName: opts.peerName,
    peerType: opts.peerType,
    source: opts.source,
  };
}

export function buildOutboundEntry(opts: {
  from: string;
  to: string;
  chatType: 'private' | 'group';
  groupId?: string | null;
  msgId?: string | null;
  content: string;
  replyTo?: string | null;
  agent?: string | null;
  model?: string | null;
  durationMs?: number | null;
  numTurns?: number | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  timestamp?: number;
  encrypt?: boolean;
  chatmode?: string;
  peerType?: string;
  msgType?: 'text' | 'image' | 'file' | 'thought' | 'handoff_state' | 'handoff_result';
  source?: 'daemon' | 'cli' | 'msg' | 'ctl' | 'owner-inject' | 'handoff';
  handoff?: MessageLogEntry['handoff'];
}): MessageLogEntry {
  const ts = opts.timestamp || Date.now();
  return {
    ts,
    time: formatTimestampMs(ts),
    dir: 'out',
    from: opts.from,
    to: opts.to,
    chatType: opts.chatType,
    groupId: opts.groupId ?? null,
    msgId: opts.msgId ?? null,
    msgType: opts.msgType ?? 'text',
    content: opts.content,
    replyTo: opts.replyTo ?? null,
    agent: opts.agent ?? null,
    model: opts.model ?? null,
    permMode: null,
    cmdParsed: null,
    durationMs: opts.durationMs ?? null,
    numTurns: opts.numTurns ?? null,
    usage: opts.usage ?? null,
    encrypt: opts.encrypt,
    chatmode: opts.chatmode,
    peerType: opts.peerType,
    source: opts.source ?? 'daemon',
    handoff: opts.handoff,
  };
}

export function isHandoffStateMessage(entry: Pick<MessageLogEntry, 'msgType'> | null | undefined): boolean {
  return entry?.msgType === 'handoff_state';
}
