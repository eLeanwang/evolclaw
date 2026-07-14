import path from 'path';
import { isValidAid } from '../aid/identity.js';
import { isTransientProtocolMessage, messageLogPath, type MessageLogEntry } from '../../core/message/message-log.js';
import { chatDirPath, readAllJsonlLines, readJsonFile, readLastJsonlLine } from '../../core/session/session-fs-store.js';
import { resolvePaths } from '../../paths.js';

export type MsgHistoryDirection = 'in' | 'out' | 'all';

export interface MsgHistoryArgs {
  from: string;
  target: string;
  session?: 'latest' | 'all' | string;
  limit?: number;
  before?: number;
  after?: number;
  direction?: MsgHistoryDirection;
}

export interface MsgHistoryResult {
  ok: true;
  self_aid: string;
  target_aid: string;
  session_id?: string;
  count: number;
  messages: MessageLogEntry[];
}

export interface MsgHistoryError {
  ok: false;
  error: string;
  code: string;
}

interface SessionRecord {
  id?: string;
  channelType?: string;
  channelId?: string;
  selfAID?: string;
  selfId?: string;
}

const DEFAULT_LIMIT = 50;
export const MAX_MSG_HISTORY_LIMIT = 500;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export function msgHistory(
  args: MsgHistoryArgs,
  options: { sessionsDir?: string } = {},
): MsgHistoryResult | MsgHistoryError {
  if (!isValidAid(args.from)) {
    return error('INVALID_SELF_AID', `无效 self AID: ${args.from}`);
  }
  if (!isValidAid(args.target)) {
    return error('INVALID_TARGET_AID', `无效 target AID: ${args.target}`);
  }

  const limit = args.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MSG_HISTORY_LIMIT) {
    return error('INVALID_LIMIT', `limit 必须是 1-${MAX_MSG_HISTORY_LIMIT} 的整数`);
  }

  const direction = args.direction ?? 'all';
  if (direction !== 'in' && direction !== 'out' && direction !== 'all') {
    return error('INVALID_DIRECTION', `direction 仅支持 in|out|all: ${String(args.direction)}`);
  }
  if (args.before !== undefined && (!Number.isFinite(args.before) || args.before < 0)) {
    return error('INVALID_BEFORE', 'before 必须是有效时间');
  }
  if (args.after !== undefined && (!Number.isFinite(args.after) || args.after < 0)) {
    return error('INVALID_AFTER', 'after 必须是有效时间');
  }
  if (args.before !== undefined && args.after !== undefined && args.after >= args.before) {
    return error('INVALID_TIME_RANGE', 'after 必须早于 before');
  }

  const sessionsDir = options.sessionsDir ?? resolvePaths().sessionsDir;
  const chatDir = chatDirPath(sessionsDir, 'aun', args.target, args.from);
  const resolvedSession = resolveSessionFilter(chatDir, args.from, args.target, args.session ?? 'latest');
  if (!resolvedSession.ok) return resolvedSession;

  let entries: MessageLogEntry[];
  try {
    entries = readAllJsonlLines<MessageLogEntry>(messageLogPath(chatDir));
  } catch (cause) {
    return error('HISTORY_READ_FAILED', cause instanceof Error ? cause.message : String(cause));
  }

  const messages = entries
    .filter(entry => isMessageLogEntry(entry))
    .filter(entry => !isTransientProtocolMessage(entry))
    .filter(entry => resolvedSession.sessionId === undefined || entry.sessionId === resolvedSession.sessionId)
    .filter(entry => direction === 'all' || entry.dir === direction)
    .filter(entry => args.after === undefined || entry.ts > args.after)
    .filter(entry => args.before === undefined || entry.ts < args.before)
    .sort((left, right) => left.ts - right.ts)
    .slice(-limit);

  return {
    ok: true,
    self_aid: args.from,
    target_aid: args.target,
    session_id: resolvedSession.sessionId,
    count: messages.length,
    messages,
  };
}

function resolveSessionFilter(
  chatDir: string,
  selfAid: string,
  targetAid: string,
  requested: string,
): { ok: true; sessionId?: string } | MsgHistoryError {
  if (requested === 'all') return { ok: true };

  if (requested === 'latest') {
    const active = readJsonFile<SessionRecord>(path.join(chatDir, 'active.json'));
    if (!active?.id) {
      return error('LATEST_SESSION_NOT_FOUND', '该 AID 对暂无最新会话');
    }
    if (!sessionBelongsToPair(active, selfAid, targetAid)) {
      return error('SESSION_SCOPE_MISMATCH', 'active.json 不属于指定 AID 对');
    }
    return { ok: true, sessionId: active.id };
  }

  if (!SESSION_ID_RE.test(requested)) {
    return error('INVALID_SESSION_ID', `无效 session ID: ${requested}`);
  }

  const active = readJsonFile<SessionRecord>(path.join(chatDir, 'active.json'));
  if (active?.id === requested) {
    if (!sessionBelongsToPair(active, selfAid, targetAid)) {
      return error('SESSION_SCOPE_MISMATCH', '指定会话不属于该 AID 对');
    }
    return { ok: true, sessionId: requested };
  }

  for (const sessionPath of [
    path.join(chatDir, `${requested}.jsonl`),
    path.join(chatDir, '_threads', `${requested}.jsonl`),
  ]) {
    const session = readLastJsonlLine<SessionRecord>(sessionPath);
    if (!session || session.id !== requested) continue;
    if (!sessionBelongsToPair(session, selfAid, targetAid)) {
      return error('SESSION_SCOPE_MISMATCH', '指定会话不属于该 AID 对');
    }
    return { ok: true, sessionId: requested };
  }

  return error('SESSION_NOT_FOUND', `在该 AID 对中找不到会话: ${requested}`);
}

function sessionBelongsToPair(session: SessionRecord, selfAid: string, targetAid: string): boolean {
  if (session.channelType && session.channelType !== 'aun') return false;
  if (session.channelId && session.channelId !== targetAid) return false;
  const storedSelfAid = session.selfAID ?? session.selfId;
  if (storedSelfAid && storedSelfAid !== selfAid) return false;
  return true;
}

function isMessageLogEntry(value: unknown): value is MessageLogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MessageLogEntry>;
  return Number.isFinite(entry.ts)
    && (entry.dir === 'in' || entry.dir === 'out')
    && typeof entry.from === 'string'
    && typeof entry.to === 'string'
    && typeof entry.content === 'string'
    && typeof entry.msgType === 'string';
}

function error(code: string, message: string): MsgHistoryError {
  return { ok: false, code, error: message };
}
