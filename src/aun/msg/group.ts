import type { ShortConnectionOpts } from '../rpc/index.js';
import { createShortConnection } from '../rpc/index.js';
import { uploadFileAndBuildPayload } from './upload.js';
import type { MsgError } from './p2p.js';

// ==================== Types ====================

export interface GroupInfo {
  group_id: string;
  name: string;
  owner_aid: string;
  creator_aid?: string;
  visibility?: string;
  status?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  member_count?: number;
  message_seq?: number;
  event_seq?: number;
  created_at?: number;
}

export interface GroupMember {
  aid: string;
  role: string;
  member_type?: string;
  joined_at?: number;
  [k: string]: unknown;
}

export interface GroupMessage {
  seq: number;
  message_id: string;
  sender_aid: string;
  message_type?: string;
  payload: Record<string, unknown>;
  attachments?: unknown[];
  created_at: number;
}

export interface GroupSendResult {
  ok: true;
  group_id: string;
  message: GroupMessage;
  event?: Record<string, unknown>;
}

export interface GroupPullResult {
  ok: true;
  group_id: string;
  messages: GroupMessage[];
  latest_message_seq: number;
  has_more: boolean;
}

export interface GroupAckResult {
  ok: true;
  group_id: string;
  ack_seq: number;
  latest_message_seq?: number;
}

export interface GroupCreateResult {
  ok: true;
  group: GroupInfo;
}

export interface GroupGetResult {
  ok: true;
  group: GroupInfo;
}

export interface GroupListResult {
  ok: true;
  items: GroupInfo[];
  total: number;
}

export interface GroupUpdateResult {
  ok: true;
  group: GroupInfo;
}

export interface GroupDissolveResult {
  ok: true;
  group_id: string;
  status: string;
}

export interface GroupMembersResult {
  ok: true;
  members: GroupMember[];
  total: number;
  page: number;
  size: number;
}

export interface GroupOnlineResult {
  ok: true;
  group_id: string;
  members: GroupMember[];
  online_count: number;
  total: number;
}

export interface GroupSimpleResult {
  ok: true;
  group_id: string;
  data?: Record<string, unknown>;
}

// ==================== Common opts ====================

export interface GroupCommonOpts extends ShortConnectionOpts {}

// ==================== Send ====================

export type GroupSendBody =
  | { mode: 'text'; text: string }
  | { mode: 'payload'; payload: Record<string, unknown> }
  | {
      mode: 'file';
      filePath: string;
      as?: string;
      contentType?: string;
      text?: string;
      transcript?: string;
    };

export interface GroupSendArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  body: GroupSendBody;
  /** payload.mentions：[{aid: ...}] 或 {scope: "all"} */
  mentions?: Array<Record<string, unknown>>;
}

export async function groupSend(args: GroupSendArgs): Promise<GroupSendResult | MsgError> {
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
    if (args.mentions && args.mentions.length > 0) {
      payload.mentions = args.mentions;
    }

    const result = await conn.call('group.send', { group_id: args.groupId, payload });
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      message: result?.message,
      event: result?.event,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Pull ====================

export interface GroupPullArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  afterSeq?: number;
  limit?: number;
}

export async function groupPull(args: GroupPullArgs): Promise<GroupPullResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = { group_id: args.groupId };
    if (args.afterSeq !== undefined) params.after_message_seq = args.afterSeq;
    if (args.limit !== undefined) params.limit = args.limit;

    const result = await conn.call('group.pull', params);
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      messages: result?.messages ?? [],
      latest_message_seq: result?.latest_message_seq ?? 0,
      has_more: !!result?.has_more,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Ack ====================

export interface GroupAckArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  seq: number;
}

export async function groupAck(args: GroupAckArgs): Promise<GroupAckResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.ack', { group_id: args.groupId, seq: args.seq });
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      ack_seq: result?.ack_seq ?? args.seq,
      latest_message_seq: result?.latest_message_seq,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Lifecycle ====================

export interface GroupCreateArgs extends GroupCommonOpts {
  from: string;
  name: string;
  groupId?: string;
  visibility?: 'public' | 'private';
  description?: string;
  joinMode?: 'open' | 'approval' | 'invite_only' | 'closed';
}

export async function groupCreate(args: GroupCreateArgs): Promise<GroupCreateResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = { name: args.name };
    if (args.groupId) params.group_id = args.groupId;
    if (args.visibility) params.visibility = args.visibility;
    if (args.description) params.description = args.description;
    if (args.joinMode) params.join_mode = args.joinMode;

    const result = await conn.call('group.create', params);
    return { ok: true, group: result?.group };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupInfoArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupInfo(args: GroupInfoArgs): Promise<GroupGetResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.get', { group_id: args.groupId });
    return { ok: true, group: result?.group };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupListArgs extends GroupCommonOpts {
  from: string;
  size?: number;
}

export async function groupList(args: GroupListArgs): Promise<GroupListResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = {};
    if (args.size !== undefined) params.size = args.size;
    const result = await conn.call('group.list_my', params);
    return {
      ok: true,
      items: result?.items ?? [],
      total: result?.total ?? 0,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupUpdateArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  name?: string;
  description?: string;
}

export async function groupUpdate(args: GroupUpdateArgs): Promise<GroupUpdateResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = { group_id: args.groupId };
    if (args.name !== undefined) params.name = args.name;
    if (args.description !== undefined) params.description = args.description;
    const result = await conn.call('group.update', params);
    return { ok: true, group: result?.group };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupDissolveArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupDissolve(args: GroupDissolveArgs): Promise<GroupDissolveResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.dissolve', { group_id: args.groupId });
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      status: result?.status ?? 'dissolved',
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Members ====================

export interface GroupJoinArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  message?: string;
  answer?: string;
}

export async function groupJoin(args: GroupJoinArgs): Promise<GroupSimpleResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = { group_id: args.groupId };
    if (args.message) params.message = args.message;
    if (args.answer) params.answer = args.answer;
    const result = await conn.call('group.request_join', params);
    return { ok: true, group_id: args.groupId, data: result };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupLeaveArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupLeave(args: GroupLeaveArgs): Promise<GroupSimpleResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.leave', { group_id: args.groupId });
    return { ok: true, group_id: args.groupId, data: result };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupInviteArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  members: string[];
}

export interface GroupInviteResult {
  ok: true;
  group_id: string;
  added: string[];
  failed: Array<{ aid: string; error: string }>;
}

export async function groupInvite(args: GroupInviteArgs): Promise<GroupInviteResult | MsgError> {
  if (args.members.length === 0) {
    return { ok: false, error: '至少需要一个成员 AID' };
  }
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  const added: string[] = [];
  const failed: Array<{ aid: string; error: string }> = [];
  try {
    for (const memberAid of args.members) {
      try {
        await conn.call('group.add_member', { group_id: args.groupId, aid: memberAid });
        added.push(memberAid);
      } catch (e: any) {
        failed.push({ aid: memberAid, error: String(e?.message ?? e) });
      }
    }
    return { ok: true, group_id: args.groupId, added, failed };
  } finally {
    await conn.close();
  }
}

export interface GroupKickArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  memberAid: string;
}

export async function groupKick(args: GroupKickArgs): Promise<GroupSimpleResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.kick', { group_id: args.groupId, aid: args.memberAid });
    return { ok: true, group_id: args.groupId, data: result };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupMembersArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  page?: number;
  size?: number;
}

export async function groupMembers(args: GroupMembersArgs): Promise<GroupMembersResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = { group_id: args.groupId };
    if (args.page !== undefined) params.page = args.page;
    if (args.size !== undefined) params.size = args.size;
    const result = await conn.call('group.get_members', params);
    return {
      ok: true,
      members: result?.members ?? [],
      total: result?.total ?? 0,
      page: result?.page ?? 1,
      size: result?.size ?? 50,
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupOnlineArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupOnline(args: GroupOnlineArgs): Promise<GroupOnlineResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.get_online_members', { group_id: args.groupId });
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      members: result?.members ?? [],
      online_count: result?.online_count ?? 0,
      total: result?.total ?? 0,
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
