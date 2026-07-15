import { normalizeCausation } from './causation/context.js';
import type { CausationContext } from './causation/types.js';

export const TASK_RUNTIME_CONTEXT_ENV = 'EVOLCLAW_TASK_RUNTIME_CONTEXT';

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
  handoffIds?: string[];
  causation?: CausationContext;
}

interface TaskRuntimeContextIpcResponse {
  ok: boolean;
  context?: TaskRuntimeContext | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeTaskRuntimeContext(value: Record<string, unknown>): TaskRuntimeContext {
  const handoffIds = Array.isArray(value.handoffIds)
    ? value.handoffIds.filter((id): id is string => typeof id === 'string')
    : undefined;
  return {
    taskId: optionalString(value.taskId),
    sessionId: optionalString(value.sessionId),
    messageId: optionalString(value.messageId),
    channel: optionalString(value.channel),
    chatType: optionalString(value.chatType),
    selfAid: optionalString(value.selfAid),
    peerId: optionalString(value.peerId),
    peerName: optionalString(value.peerName),
    peerType: optionalString(value.peerType),
    peerRole: optionalString(value.peerRole),
    threadId: optionalString(value.threadId),
    handoffIds: handoffIds?.length ? handoffIds : undefined,
    causation: normalizeCausation(value.causation),
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
    return isPlainObject(parsed) ? normalizeTaskRuntimeContext(parsed) : undefined;
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
      import('../paths.js'),
      import('../ipc.js'),
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
  const clean = normalizeTaskRuntimeContext(ctx as Record<string, unknown>);
  return {
    EVOLCLAW_SESSION_ID: ctx.sessionId ?? '',
    [TASK_RUNTIME_CONTEXT_ENV]: JSON.stringify(clean),
  };
}
