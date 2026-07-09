import { appendMessageLog, buildOutboundEntry, isHandoffStateMessage, type MessageLogEntry } from './message-log.js';
import { messageLogPath } from './message-log.js';
import { readAllJsonlLines } from '../session/session-fs-store.js';
import { logger } from '../../utils/logger.js';

export const TASK_RUNTIME_CONTEXT_ENV = 'EVOLCLAW_TASK_RUNTIME_CONTEXT';
export const HANDOFF_ASSOCIATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HandoffKind = 'request_to_target' | 'response_to_origin';
export type HandoffMatchKind = 'ref' | 'inferred';

export interface HandoffOrigin {
  session_id?: string;
  message_id?: string;
  channel?: string;
  peerId?: string;
  threadId?: string;
  peerName?: string;
  peerType?: string;
  role?: string;
}

export interface HandoffMetadata {
  kind?: HandoffKind;
  event?: 'consumed';
  origin?: HandoffOrigin;
  consumed_by_msg_id?: string;
  match?: HandoffMatchKind;
}

export interface ConsumedHandoffContext {
  kind: HandoffKind;
  origin: HandoffOrigin;
  sourceMessage: {
    msgId: string | null;
    content: string;
    from: string;
    to: string;
    ts: number;
    time?: string;
  };
  consumedByMessageId: string;
  match: HandoffMatchKind;
}

export interface TaskRuntimeContext {
  taskId?: string;
  sessionId?: string;
  messageId?: string;
  channel?: string;
  chatType?: 'private' | 'group' | string;
  selfAid?: string;
  peerId?: string;
  peerName?: string;
  peerType?: string;
  peerRole?: string;
  threadId?: string;
  consumedHandoff?: ConsumedHandoffContext | null;
}

export interface TaskRuntimeContextIpcResponse {
  ok: boolean;
  context?: TaskRuntimeContext | null;
  error?: string;
}

export interface ConsumableHandoffMatch {
  entry: MessageLogEntry;
  match: HandoffMatchKind;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isHandoffKind(value: unknown): value is HandoffKind {
  return value === 'request_to_target' || value === 'response_to_origin';
}

function entryHandoff(entry: MessageLogEntry): HandoffMetadata | undefined {
  const handoff = entry.handoff as HandoffMetadata | undefined;
  return handoff && typeof handoff === 'object' ? handoff : undefined;
}

export function isHandoffOutbound(entry: MessageLogEntry, kinds?: HandoffKind[]): boolean {
  const handoff = entryHandoff(entry);
  if (
    entry.dir !== 'out' ||
    entry.source !== 'msg' ||
    isHandoffStateMessage(entry) ||
    !isHandoffKind(handoff?.kind)
  ) {
    return false;
  }
  return !kinds || kinds.includes(handoff.kind);
}

export function replayHandoffState(entries: MessageLogEntry[], kinds?: HandoffKind[]): MessageLogEntry[] {
  const candidates = new Map<string, MessageLogEntry>();
  const consumed = new Set<string>();
  const seenStateEvents = new Set<string>();

  for (const entry of entries) {
    const handoff = entryHandoff(entry);
    if (isHandoffStateMessage(entry)) {
      if (handoff?.event !== 'consumed' || !entry.replyTo) continue;
      if (entry.msgId && seenStateEvents.has(entry.msgId)) continue;
      if (entry.msgId) seenStateEvents.add(entry.msgId);
      consumed.add(entry.replyTo);
      continue;
    }

    if (!isHandoffOutbound(entry, kinds) || !entry.msgId) continue;
    if (!candidates.has(entry.msgId)) candidates.set(entry.msgId, entry);
  }

  return [...candidates.values()].filter(entry => entry.msgId && !consumed.has(entry.msgId));
}

export function selectConsumableHandoff(
  chatDir: string,
  opts: {
    replyToMessageId?: string | null;
    inboundMessageId?: string | null;
    inboundTs: number;
    kinds?: HandoffKind[];
    maxAgeMs?: number;
  },
): ConsumableHandoffMatch | null {
  const entries = readAllJsonlLines<MessageLogEntry>(messageLogPath(chatDir));
  const open = replayHandoffState(entries, opts.kinds);
  const replyTo = opts.replyToMessageId || undefined;

  if (replyTo) {
    const exact = open.filter(entry => entry.msgId === replyTo);
    if (exact.length === 1) return { entry: exact[0], match: 'ref' };
    return null;
  }

  const maxAgeMs = opts.maxAgeMs ?? HANDOFF_ASSOCIATION_WINDOW_MS;
  const eligible = open.filter(entry => {
    const ts = typeof entry.ts === 'number' ? entry.ts : 0;
    return ts > 0 && ts <= opts.inboundTs && opts.inboundTs - ts <= maxAgeMs;
  });
  if (eligible.length !== 1) return null;

  logger.info(`[Handoff] inferred handoff consumption: out=${eligible[0].msgId ?? '<none>'} in=${opts.inboundMessageId ?? '<none>'}`);
  return { entry: eligible[0], match: 'inferred' };
}

export function toConsumedHandoffContext(
  match: ConsumableHandoffMatch,
  consumedByMessageId: string,
): ConsumedHandoffContext | null {
  const handoff = entryHandoff(match.entry);
  if (!isHandoffKind(handoff?.kind)) return null;
  return {
    kind: handoff.kind,
    origin: handoff.origin ?? {},
    sourceMessage: {
      msgId: match.entry.msgId,
      content: match.entry.content ?? '',
      from: match.entry.from,
      to: match.entry.to,
      ts: match.entry.ts,
      time: match.entry.time,
    },
    consumedByMessageId,
    match: match.match,
  };
}

export function appendHandoffConsumedEvent(
  chatDir: string,
  consumed: ConsumedHandoffContext,
  selfAid: string,
  peerAid: string,
): void {
  const targetMsgId = consumed.sourceMessage.msgId;
  if (!targetMsgId || !consumed.consumedByMessageId) return;

  const stateMsgId = `handoff-consumed:${targetMsgId}:${consumed.consumedByMessageId}`;
  appendMessageLog(chatDir, buildOutboundEntry({
    from: selfAid,
    to: peerAid,
    chatType: 'private',
    groupId: null,
    msgId: stateMsgId,
    msgType: 'handoff_state',
    content: '',
    replyTo: targetMsgId,
    source: 'msg',
    handoff: {
      event: 'consumed',
      consumed_by_msg_id: consumed.consumedByMessageId,
      match: consumed.match,
    },
  }));
}

function normalizedThreadId(threadId: unknown): string | undefined {
  if (typeof threadId !== 'string') return undefined;
  const trimmed = threadId.trim();
  return trimmed && trimmed !== 'main' ? trimmed : undefined;
}

function originFromRuntime(runtime: TaskRuntimeContext): HandoffOrigin {
  return {
    session_id: runtime.sessionId,
    message_id: runtime.messageId,
    channel: runtime.channel,
    peerId: runtime.peerId,
    threadId: normalizedThreadId(runtime.threadId),
    peerName: runtime.peerName,
    peerType: runtime.peerType,
    role: runtime.peerRole,
  };
}

export function resolveMsgSendHandoff(args: {
  from: string;
  to: string;
  runtime?: TaskRuntimeContext | null;
}): HandoffMetadata | undefined {
  const runtime = args.runtime;
  if (!runtime) return undefined;
  if (runtime.channel !== 'aun' || runtime.chatType !== 'private') return undefined;
  if (!runtime.selfAid || runtime.selfAid !== args.from) return undefined;
  if (!runtime.messageId) return undefined;

  const consumed = runtime.consumedHandoff;
  if (
    consumed?.kind === 'request_to_target' &&
    consumed.origin?.peerId &&
    consumed.origin.peerId === args.to
  ) {
    return {
      kind: 'response_to_origin',
      origin: originFromRuntime(runtime),
    };
  }

  if (!runtime.peerId) return undefined;
  if (args.to === runtime.peerId) return undefined;

  return {
    kind: 'request_to_target',
    origin: originFromRuntime(runtime),
  };
}

export function runtimeRefMessageIdForMsgSend(args: {
  from: string;
  runtime?: TaskRuntimeContext | null;
}): string | undefined {
  const runtime = args.runtime;
  if (!runtime) return undefined;
  if (runtime.channel !== 'aun' || runtime.chatType !== 'private') return undefined;
  if (!runtime.selfAid || runtime.selfAid !== args.from) return undefined;
  return runtime.messageId || undefined;
}

export function parseTaskRuntimeContext(raw: string | undefined): TaskRuntimeContext | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return undefined;
    return parsed as TaskRuntimeContext;
  } catch {
    return undefined;
  }
}

export function readTaskRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): TaskRuntimeContext | undefined {
  return parseTaskRuntimeContext(env[TASK_RUNTIME_CONTEXT_ENV]);
}

export async function readTaskRuntimeContextFromDaemon(
  sessionId: string | undefined,
  timeoutMs = 500,
): Promise<TaskRuntimeContext | undefined> {
  if (!sessionId) return undefined;
  try {
    const [{ resolvePaths }, { ipcQuery }] = await Promise.all([
      import('../../paths.js'),
      import('../../ipc.js'),
    ]);
    const response = await ipcQuery<TaskRuntimeContextIpcResponse>(
      resolvePaths().socket,
      { type: 'task-runtime-context', sessionId },
      timeoutMs,
    );
    return response?.ok && response.context ? response.context : undefined;
  } catch {
    return undefined;
  }
}

export async function readBestTaskRuntimeContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskRuntimeContext | undefined> {
  const envContext = readTaskRuntimeContextFromEnv(env);
  const sessionId = env.EVOLCLAW_SESSION_ID || envContext?.sessionId;
  return (await readTaskRuntimeContextFromDaemon(sessionId)) ?? envContext;
}

export function buildTaskRuntimeEnv(ctx: TaskRuntimeContext): Record<string, string> {
  const clean = JSON.parse(JSON.stringify(ctx)) as TaskRuntimeContext;
  return {
    EVOLCLAW_SESSION_ID: ctx.sessionId ?? '',
    [TASK_RUNTIME_CONTEXT_ENV]: JSON.stringify(clean),
  };
}

export function formatEcMsgSendCommand(fromAid: string | undefined, toAid: string | undefined, textPlaceholder: string, threadId?: string): string {
  const from = fromAid || '<self-aid>';
  const to = toAid || '<target-aid>';
  const body = JSON.stringify(textPlaceholder);
  const thread = normalizedThreadId(threadId);
  return `ec msg send ${from} ${to} ${body}${thread ? ` --thread ${JSON.stringify(thread)}` : ''}`;
}
