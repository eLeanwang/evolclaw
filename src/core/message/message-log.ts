import path from 'path';
import { appendJsonl, chatDirPath } from '../session/session-fs-store.js';
import { logger } from '../../utils/logger.js';

export type MessageLogType =
  | 'text'
  | 'quote'
  | 'command'
  | 'thought'
  | 'voice'
  | 'image'
  | 'video'
  | 'file'
  | 'location'
  | 'link'
  | 'action_card'
  | 'action_card_reply'
  | 'merge'
  | 'personal_card'
  | 'status'
  | 'event'
  | 'json'
  | 'tool_call'
  | 'tool_result'
  | 'custom'
  | 'handoff_state'
  | 'handoff_result';

export interface MessageLogPayloadSummary {
  title?: string;
  text?: string;
  filename?: string;
  url?: string;
  kind?: string;
  actionCount?: number;
  attachmentCount?: number;
}

export interface AunPayloadLogDescriptor {
  msgType: MessageLogType;
  payloadType?: string;
  content: string;
  payloadSummary?: MessageLogPayloadSummary;
}

const KNOWN_AUN_PAYLOAD_TYPES = new Set<MessageLogType>([
  'text',
  'quote',
  'thought',
  'voice',
  'image',
  'video',
  'file',
  'location',
  'link',
  'action_card',
  'action_card_reply',
  'merge',
  'personal_card',
  'status',
  'event',
  'json',
  'tool_call',
  'tool_result',
  'custom',
]);

const PAYLOAD_SUMMARY_TEXT_LIMIT = 240;
const PAYLOAD_SUMMARY_FIELD_LIMIT = 160;

function truncatePayloadSummary(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function firstPayloadString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return truncatePayloadSummary(value, PAYLOAD_SUMMARY_FIELD_LIMIT);
    }
  }
  return undefined;
}

function payloadAttachmentFilename(payload: Record<string, unknown>): string | undefined {
  const direct = firstPayloadString(payload, ['filename', 'file_name', 'name']);
  if (direct) return direct;
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) continue;
    const filename = firstPayloadString(attachment as Record<string, unknown>, ['filename', 'file_name', 'name']);
    if (filename) return filename;
  }
  return undefined;
}

function payloadArrayCount(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

function compactPayloadSummary(summary: MessageLogPayloadSummary): MessageLogPayloadSummary | undefined {
  return Object.values(summary).some((value) => value !== undefined) ? summary : undefined;
}

function prefixedPayloadSummary(prefix: string, value?: string): string {
  return value
    ? `[${prefix}] ${truncatePayloadSummary(value, PAYLOAD_SUMMARY_TEXT_LIMIT)}`
    : `[${prefix}]`;
}

export function classifyAunPayloadForLog(payload: unknown): AunPayloadLogDescriptor {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const content = typeof payload === 'string'
      ? truncatePayloadSummary(payload, PAYLOAD_SUMMARY_TEXT_LIMIT)
      : String(payload ?? '');
    return { msgType: 'text', content };
  }

  const record = payload as Record<string, unknown>;
  const rawType = typeof record.type === 'string' && record.type.trim()
    ? record.type.trim()
    : undefined;
  if (!rawType) {
    return {
      msgType: 'text',
      content: firstPayloadString(record, ['text', 'fallback_text', 'title']) ?? '[payload]',
    };
  }

  const msgType: MessageLogType = KNOWN_AUN_PAYLOAD_TYPES.has(rawType as MessageLogType)
    ? rawType as MessageLogType
    : 'custom';
  const title = firstPayloadString(record, ['title', 'name']);
  const text = firstPayloadString(record, ['text', 'fallback_text', 'description', 'body']);
  const filename = payloadAttachmentFilename(record);
  const url = firstPayloadString(record, ['url', 'href']);
  const kind = firstPayloadString(record, ['kind', 'event', 'status']);
  const actionCount = payloadArrayCount(record, ['actions', 'buttons']);
  const attachmentCount = payloadArrayCount(record, ['attachments']);
  const payloadSummary = compactPayloadSummary({ title, text, filename, url, kind, actionCount, attachmentCount });

  let content: string;
  switch (msgType) {
    case 'text':
    case 'quote':
    case 'thought':
      content = text ?? `[${msgType}]`;
      break;
    case 'voice':
      content = prefixedPayloadSummary('voice', firstPayloadString(record, ['transcript']) ?? filename ?? text);
      break;
    case 'image':
      content = prefixedPayloadSummary('image', firstPayloadString(record, ['alt', 'title']) ?? filename ?? text);
      break;
    case 'video':
      content = prefixedPayloadSummary('video', title ?? filename ?? text);
      break;
    case 'file':
      content = prefixedPayloadSummary('file', filename ?? text);
      break;
    case 'location': {
      const coordinates = typeof record.latitude === 'number' && typeof record.longitude === 'number'
        ? `${record.latitude},${record.longitude}`
        : typeof record.lat === 'number' && typeof record.lng === 'number'
          ? `${record.lat},${record.lng}`
          : undefined;
      content = prefixedPayloadSummary('location', firstPayloadString(record, ['name', 'address']) ?? coordinates ?? text);
      break;
    }
    case 'link':
      content = prefixedPayloadSummary('link', title ?? url ?? text);
      break;
    case 'action_card':
      content = prefixedPayloadSummary('card', title ?? text);
      break;
    case 'action_card_reply':
      content = firstPayloadString(record, ['text', 'action_value', 'value', 'action_label', 'label']) ?? '[action_card_reply]';
      break;
    case 'merge':
      content = prefixedPayloadSummary('merge', title ?? (Array.isArray(record.items) ? `${record.items.length} items` : text));
      break;
    case 'personal_card':
      content = prefixedPayloadSummary('personal_card', title ?? firstPayloadString(record, ['aid', 'agent_id']) ?? text);
      break;
    case 'status':
      content = prefixedPayloadSummary('status', firstPayloadString(record, ['status', 'text']) ?? kind);
      break;
    case 'event':
      content = prefixedPayloadSummary('event', kind ?? title ?? text);
      break;
    case 'json':
      content = prefixedPayloadSummary('json', kind ?? title ?? text);
      break;
    case 'tool_call':
      content = prefixedPayloadSummary('tool_call', firstPayloadString(record, ['name', 'tool_name']) ?? text);
      break;
    case 'tool_result': {
      const name = firstPayloadString(record, ['name', 'tool_name']);
      const status = firstPayloadString(record, ['status', 'error']);
      content = prefixedPayloadSummary('tool_result', [name, status].filter(Boolean).join(' '));
      break;
    }
    case 'custom':
      content = text ?? prefixedPayloadSummary(rawType === 'custom' ? 'custom' : `payload:${rawType}`);
      break;
    default:
      content = text ?? `[${msgType}]`;
  }

  return {
    msgType,
    payloadType: rawType,
    content: truncatePayloadSummary(content, PAYLOAD_SUMMARY_TEXT_LIMIT),
    payloadSummary,
  };
}

export interface MessageLogEntry {
  ts: number;
  time: string;
  dir: 'in' | 'out';
  from: string;
  to: string;
  chatType: 'private' | 'group';
  groupId: string | null;
  msgId: string | null;
  msgType: MessageLogType;
  payloadType?: string;
  payloadSummary?: MessageLogPayloadSummary;
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
    event?: 'consumed' | 'decided' | 'cancelled' | 'expired' | 'failed';
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
    auth?: Record<string, unknown>;
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
  msgType?: MessageLogType;
  payloadType?: string;
  payloadSummary?: MessageLogPayloadSummary;
}): MessageLogEntry {
  const ts = opts.timestamp || Date.now();
  const isCommandCapable = !opts.msgType || opts.msgType === 'text' || opts.msgType === 'quote' || opts.msgType === 'action_card_reply';
  const isCommand = isCommandCapable && opts.content.startsWith('/');
  return {
    ts,
    time: formatTimestampMs(ts),
    dir: 'in',
    from: opts.from,
    to: opts.to,
    chatType: opts.chatType,
    groupId: opts.groupId ?? null,
    msgId: opts.msgId ?? null,
    msgType: isCommand ? 'command' : (opts.msgType ?? 'text'),
    payloadType: opts.payloadType,
    payloadSummary: opts.payloadSummary,
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
  msgType?: MessageLogType;
  payloadType?: string;
  payloadSummary?: MessageLogPayloadSummary;
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
    payloadType: opts.payloadType,
    payloadSummary: opts.payloadSummary,
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
