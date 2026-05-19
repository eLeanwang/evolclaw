import type { ShortConnectionOpts } from '../rpc/index.js';
import { createShortConnection } from '../rpc/index.js';
import { uploadFileAndBuildPayload } from './upload.js';

// ==================== Types ====================

export interface MsgError {
  ok: false;
  error: string;
  code?: number;
}

export interface MsgSendResult {
  ok: true;
  message_id: string;
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
}

export async function msgSend(args: MsgSendArgs): Promise<MsgSendResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    let payload: Record<string, unknown>;

    switch (args.body.mode) {
      case 'text':
        payload = { type: 'text', text: args.body.text };
        break;
      case 'payload':
        payload = args.body.payload;
        break;
      case 'link':
        payload = { type: 'link', url: args.body.url };
        if (args.body.title) payload.title = args.body.title;
        if (args.body.description) payload.description = args.body.description;
        break;
      case 'file': {
        const built = await uploadFileAndBuildPayload(conn, args.from, args.body.filePath, {
          as: args.body.as,
          contentType: args.body.contentType,
          text: args.body.text,
          transcript: args.body.transcript,
        });
        payload = built.payload;
        break;
      }
    }

    const result = await conn.call('message.send', { to: args.to, payload });
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
    await conn.close();
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
