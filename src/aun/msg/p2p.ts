import fs from 'fs';
import path from 'path';
import type { ShortConnectionOpts } from '../rpc/index.js';
import { createShortConnection } from '../rpc/index.js';
import { getAidStore, SLOT } from '../aid/store.js';
import { uploadFileAndBuildPayload, type UploadProgress } from './upload.js';
import { appendMessageLog, buildOutboundEntry, classifyAunPayloadForLog } from '../../core/message/message-log.js';
import { readBestTaskRuntimeContext, runtimeRefMessageIdForMsgSend, type TaskRuntimeContext } from '../../core/task-runtime-context.js';
import { chatDirPath } from '../../core/session/session-fs-store.js';
import { resolvePaths } from '../../paths.js';
import { ipcQuery, type IpcAunFileRequest, type IpcAunMsgSendResponse } from '../../ipc.js';
import { AGENT_DELEGATION_TOKEN_ENV } from '../../core/auth/agent-delegation.js';

// ==================== Types ====================

export interface MsgError {
  ok: false;
  error: string;
  code?: string | number;
}

export interface MsgSendResult {
  ok: true;
  message_id: string;
  handoff_id?: string;
  target_session_id?: string;
  seq?: number;
  timestamp?: number;
  status?: string;
  delivery_mode?: string;
}

export interface MsgPullResult {
  ok: true;
  messages: MsgItem[];
  count: number;
  latest_seq: number;
  earliest_available_seq?: number | null;
  ephemeral_earliest_available_seq?: number | null;
  ephemeral_dropped_count?: number;
}

export interface MsgItem {
  message_id: string;
  seq: number;
  from: string;
  to: string;
  timestamp: number;
  payload: Record<string, unknown>;
  delivery_mode?: string;
  encrypted?: boolean;
}

export interface MsgAckResult {
  ok: true;
  ack_seq: number;
  event_published?: boolean;
}

export interface MsgRecallResult {
  ok: true;
  accepted: number;
  recalled: number;
  errors: Array<{ message_id: string; error: string }> | null;
}

export interface MsgOnlineResult {
  ok: true;
  online: Record<string, boolean>;
}

// ==================== Common opts ====================

export interface MsgCommonOpts extends ShortConnectionOpts {}

// ==================== Send ====================

export type MsgSendBody =
  | { mode: 'text'; text: string }
  | { mode: 'payload'; payload: Record<string, unknown> }
  | { mode: 'link'; url: string; title?: string; description?: string }
  | {
      mode: 'file';
      filePath: string;
      as?: string;
      contentType?: string;
      text?: string;
      transcript?: string;
    };

export interface MsgSendArgs extends MsgCommonOpts {
  from: string;
  to: string;
  body: MsgSendBody;
  encrypt?: boolean;
  thread?: string;  // 话题 ID（用于多话题路由）
  returnPolicy?: 'required' | 'none';
  /** 文件上传进度回调（仅 body.mode==='file' 时触发）。 */
  onUploadProgress?: (info: UploadProgress) => void;
}

function buildSimplePayload(body: Exclude<MsgSendBody, { mode: 'file' }>): Record<string, unknown> {
  switch (body.mode) {
    case 'text':
      return { type: 'text', text: body.text };
    case 'payload':
      return { ...body.payload };
    case 'link': {
      const payload: Record<string, unknown> = { type: 'link', url: body.url };
      if (body.title) payload.title = body.title;
      if (body.description) payload.description = body.description;
      return payload;
    }
  }
}

function messageLogContent(body: MsgSendBody): string {
  return body.mode === 'text' ? body.text
    : body.mode === 'link' ? `[link] ${body.url}`
    : body.mode === 'file' ? `[file] ${body.filePath}`
    : `[payload]`;
}

function applyRoutingPayloadFields(
  payload: Record<string, unknown>,
  args: Pick<MsgSendArgs, 'from' | 'thread'>,
  runtimeContext?: TaskRuntimeContext | null,
  includeRuntimeRef = true,
): void {
  if (args.thread && !payload.thread_id) payload.thread_id = args.thread;
  if (!includeRuntimeRef) return;
  const refMessageId = runtimeRefMessageIdForMsgSend({ from: args.from, runtime: runtimeContext });
  if (refMessageId && !payload.ref_message_id) payload.ref_message_id = refMessageId;
}

function msgSendLogMetadata(args: MsgSendArgs, payload?: unknown, runtimeContext?: TaskRuntimeContext | null): {
  content: string;
  sessionId?: string;
  msgType?: ReturnType<typeof classifyAunPayloadForLog>['msgType'];
  payloadType?: string;
  payloadSummary?: ReturnType<typeof classifyAunPayloadForLog>['payloadSummary'];
  source: 'cli' | 'msg';
} {
  const isInSession = !!process.env.EVOLCLAW_SESSION_ID || !!runtimeContext;
  const source = isInSession ? 'msg' : 'cli';
  const classified = payload === undefined ? undefined : classifyAunPayloadForLog(payload);
  const sessionId = runtimeContext?.channel === 'aun'
    && runtimeContext.chatType === 'private'
    && runtimeContext.selfAid === args.from
    && runtimeContext.peerId === args.to
    ? runtimeContext.sessionId
    : undefined;
  return {
    content: classified?.content ?? messageLogContent(args.body),
    sessionId,
    msgType: classified?.msgType,
    payloadType: classified?.payloadType,
    payloadSummary: classified?.payloadSummary,
    source,
  };
}

async function tryDaemonMsgSend(
  args: MsgSendArgs,
  payload: Record<string, unknown> | undefined,
  runtimeContext?: TaskRuntimeContext | null,
  file?: IpcAunFileRequest,
): Promise<IpcAunMsgSendResponse | null> {
  const delegatedTask = !!process.env.EVOLCLAW_SESSION_ID
    || !!process.env[AGENT_DELEGATION_TOKEN_ENV];
  if (!runtimeContext) {
    return delegatedTask
      ? { ok: false, code: 'DELEGATION_REQUIRED', error: 'Task runtime context is unavailable' }
      : null;
  }
  if (!runtimeContext.selfAid || runtimeContext.selfAid !== args.from) {
    return { ok: false, code: 'INVALID_DELEGATION', error: 'Task sender does not match the delegated agent' };
  }
  if (!runtimeContext.sessionId || !runtimeContext.messageId) {
    return { ok: false, code: 'INVALID_DELEGATION', error: 'Task runtime context is incomplete' };
  }
  if (args.slotId || args.aunPath) {
    return { ok: false, code: 'INVALID_DELEGATION', error: 'Task sends cannot override the daemon AUN connection' };
  }
  const payloadThread = typeof payload?.thread_id === 'string' && payload.thread_id.trim()
    ? payload.thread_id.trim()
    : undefined;

  const response = await ipcQuery<IpcAunMsgSendResponse>(
    resolvePaths().socket,
    {
      type: 'aun-msg-send',
      aid: args.from,
      to: args.to,
      scope: 'msg',
      ...(payload ? { payload } : { file }),
      encrypt: args.encrypt === true,
      thread: args.thread || payloadThread,
      returnPolicy: args.returnPolicy,
      originSessionId: runtimeContext.sessionId,
      originMessageId: runtimeContext.messageId,
      delegationToken: process.env[AGENT_DELEGATION_TOKEN_ENV],
      log: msgSendLogMetadata(args, payload, runtimeContext),
    },
    file ? 120_000 : 5000,
  );
  return response ?? {
    ok: false,
    code: 'AUN_DAEMON_UNAVAILABLE',
    error: 'EvolClaw daemon did not complete the delegated AUN send',
  };
}

async function daemonMsgSendResult(
  args: MsgSendArgs,
  payload: Record<string, unknown>,
  runtimeContext: TaskRuntimeContext | null | undefined,
  daemonResult: IpcAunMsgSendResponse,
): Promise<MsgSendResult | MsgError> {
  if (!daemonResult.ok) {
    return {
      ok: false,
      error: daemonResult.error || 'daemon AUN message send failed',
      code: daemonResult.code,
    };
  }
  if (!daemonResult.message_id && !daemonResult.handoff_id) {
    return { ok: false, error: 'daemon AUN message send returned no message_id' };
  }
  const sent: MsgSendResult = {
    ok: true,
    message_id: daemonResult.message_id || daemonResult.handoff_id || '',
    handoff_id: daemonResult.handoff_id,
    target_session_id: daemonResult.target_session_id,
    seq: daemonResult.seq,
    timestamp: daemonResult.timestamp,
    status: daemonResult.status,
    delivery_mode: daemonResult.delivery_mode,
  };
  if (!daemonResult.handoff_id && !daemonResult.log_written) {
    await appendMsgSendOutboundLog(args, sent, {
      payload,
      runtimeContext,
      chatmode: daemonResult.chatmode,
      encrypt: daemonResult.encrypt ?? args.encrypt === true,
    });
  }
  return sent;
}

async function appendMsgSendOutboundLog(args: MsgSendArgs, result: MsgSendResult, opts: {
  payload: unknown;
  runtimeContext?: TaskRuntimeContext | null;
  chatmode?: string;
  encrypt?: boolean;
}): Promise<void> {
  const sessionsDir = resolvePaths().sessionsDir;
  const chatDir = chatDirPath(sessionsDir, 'aun', args.to, args.from);
  const log = msgSendLogMetadata(args, opts.payload, opts.runtimeContext);

  fs.mkdirSync(chatDir, { recursive: true });
  appendMessageLog(chatDir, buildOutboundEntry({
    from: args.from,
    to: args.to,
    sessionId: log.sessionId,
    chatType: 'private',
    msgId: result.message_id,
    content: log.content,
    encrypt: opts.encrypt === true,
    chatmode: opts.chatmode,
    msgType: log.msgType,
    payloadType: log.payloadType,
    payloadSummary: log.payloadSummary,
    source: log.source,
  }));

  // 通知 daemon 更新 stats（如果 daemon 在运行）
  try {
    await ipcQuery(resolvePaths().socket, {
      type: 'aun-aid-stats-record-outbound',
      aid: args.from,
      toPeer: args.to,
      text: log.content,
      encrypt: opts.encrypt === true,
      chatmode: opts.chatmode,
    }, 1000);
  } catch { /* daemon 不在或 IPC 失败都忽略 */ }
}

export async function msgSend(args: MsgSendArgs): Promise<MsgSendResult | MsgError> {
  if (args.returnPolicy === 'none') {
    return {
      ok: false,
      code: 'HANDOFF_RETURN_POLICY_UNSUPPORTED',
      error: 'return policy none is not supported in handoff v2 phase 1',
    };
  }
  const runtimeContext = await readBestTaskRuntimeContext();
  let conn;
  try {
    let payload: Record<string, unknown> | undefined;
    if (args.body.mode !== 'file') {
      payload = buildSimplePayload(args.body);
      applyRoutingPayloadFields(payload, args, runtimeContext, false);

      const daemonResult = await tryDaemonMsgSend(args, payload, runtimeContext);
      if (daemonResult) return daemonMsgSendResult(args, payload, runtimeContext, daemonResult);
    } else {
      const daemonResult = await tryDaemonMsgSend(args, undefined, runtimeContext, {
        filePath: path.resolve(args.body.filePath),
        as: args.body.as,
        contentType: args.body.contentType,
        text: args.body.text,
        transcript: args.body.transcript,
      });
      if (daemonResult) {
        return daemonMsgSendResult(args, { type: args.body.as || 'file' }, runtimeContext, daemonResult);
      }
    }

    conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });

    if (args.body.mode === 'file') {
      const built = await uploadFileAndBuildPayload(conn, args.from, args.body.filePath, {
        as: args.body.as,
        contentType: args.body.contentType,
        text: args.body.text,
        transcript: args.body.transcript,
        onProgress: args.onUploadProgress,
      });
      payload = built.payload;
      applyRoutingPayloadFields(payload, args, runtimeContext, false);
      const daemonResult = await tryDaemonMsgSend(args, payload, runtimeContext);
      if (daemonResult) return daemonMsgSendResult(args, payload, runtimeContext, daemonResult);
    }

    // 1. 解析对端身份（30天缓存）。身份解析走 HTTP+PKI（store），与发消息的短连接无关。
    const { agentsDir } = resolvePaths();
    const selfAgentDir = path.join(agentsDir, args.from);
    const { PeerIdentityCache } = await import('../../core/relation/peer-identity.js');
    const idStore = await getAidStore({ slotId: args.slotId ?? SLOT.cli, aunPath: args.aunPath });
    let peerIdentity;
    try {
      peerIdentity = await PeerIdentityCache.resolve('aun', args.to, selfAgentDir, idStore, false);
    } finally {
      try { idStore.close(); } catch { /* ignore */ }
    }

    // 2. 决定 chatmode（遵循来源1-3）
    // 私聊：非 human 对端 → proactive，human 对端 → interactive
    const chatmode = peerIdentity.isAgent ? 'proactive' : 'interactive';

    // 3. 构建 payload
    if (!payload) {
      payload = buildSimplePayload(args.body as Exclude<MsgSendBody, { mode: 'file' }>);
    }

    // 4. 写入 payload.chatmode
    payload.chatmode = chatmode;

    // 5. 写入 payload.thread_id/ref_message_id（如果指定）
    applyRoutingPayloadFields(payload, args, runtimeContext, false);

    applyRoutingPayloadFields(payload, args, runtimeContext);

    const sendParams: Record<string, unknown> = { to: args.to, payload };
    // Default: plaintext. Set encrypt: true to enable E2EE.
    sendParams.encrypt = args.encrypt === true;
    const result = await conn.call('message.send', sendParams);

    // 5. 写出方向 jsonl（与 daemon 一致格式，标记 source）
    // source 标记：
    // - 'cli': 用户手动调用 ec msg send
    // - 'msg': agent 在会话中调用 ec msg send
    if (result?.message_id) {
      try {
        await appendMsgSendOutboundLog(args, { ok: true, message_id: result.message_id }, {
          payload,
          runtimeContext,
          chatmode,
          encrypt: args.encrypt === true,
        });
      } catch {}
    }

    return {
      ok: true,
      message_id: result?.message_id,
      seq: result?.seq,
      timestamp: result?.timestamp,
      status: result?.status,
      delivery_mode: result?.delivery_mode,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    if (conn) await conn.close();
  }
}

// ==================== Pull ====================

export interface MsgPullArgs extends MsgCommonOpts {
  from: string;
  afterSeq?: number;
  limit?: number;
}

export async function msgPull(args: MsgPullArgs): Promise<MsgPullResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = {};
    if (args.afterSeq !== undefined) params.after_seq = args.afterSeq;
    if (args.limit !== undefined) params.limit = args.limit;

    const result = await conn.call('message.pull', params);
    return {
      ok: true,
      messages: result?.messages ?? [],
      count: result?.count ?? 0,
      latest_seq: result?.latest_seq ?? 0,
      earliest_available_seq: result?.earliest_available_seq ?? null,
      ephemeral_earliest_available_seq: result?.ephemeral_earliest_available_seq ?? null,
      ephemeral_dropped_count: result?.ephemeral_dropped_count ?? 0,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Ack ====================

export interface MsgAckArgs extends MsgCommonOpts {
  from: string;
  seq: number;
}

export async function msgAck(args: MsgAckArgs): Promise<MsgAckResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('message.ack', { seq: args.seq });
    return {
      ok: true,
      ack_seq: result?.ack_seq ?? args.seq,
      event_published: result?.event_published,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Recall ====================

export interface MsgRecallArgs extends MsgCommonOpts {
  from: string;
  messageIds: string[];
}

export async function msgRecall(args: MsgRecallArgs): Promise<MsgRecallResult | MsgError> {
  if (args.messageIds.length === 0) {
    return { ok: false, error: 'message_ids 不能为空' };
  }
  if (args.messageIds.length > 100) {
    return { ok: false, error: 'message_ids 最多 100 个' };
  }
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('message.recall', { message_ids: args.messageIds });
    return {
      ok: true,
      accepted: result?.accepted ?? 0,
      recalled: result?.recalled ?? 0,
      errors: result?.errors ?? null,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Online ====================

export interface MsgOnlineArgs extends MsgCommonOpts {
  from: string;
  targets: string[];
}

export async function msgOnline(args: MsgOnlineArgs): Promise<MsgOnlineResult | MsgError> {
  if (args.targets.length === 0) {
    return { ok: false, error: '查询目标不能为空' };
  }
  if (args.targets.length > 100) {
    return { ok: false, error: '一次最多查询 100 个 AID' };
  }
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('message.query_online', { aids: args.targets });
    return {
      ok: true,
      online: result?.online ?? {},
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Internal ====================

function formatRpcError(e: any): MsgError {
  if (e?.code !== undefined && e?.message !== undefined) {
    return { ok: false, error: String(e.message), code: e.code };
  }
  return { ok: false, error: String(e?.message ?? e) };
}
