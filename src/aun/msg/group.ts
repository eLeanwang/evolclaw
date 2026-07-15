import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import type { AUNClient } from '@agentunion/fastaun';
import type { ShortConnectionOpts } from '../rpc/index.js';
import { createShortConnection } from '../rpc/index.js';
import { getAidStore, loadClient, SLOT } from '../aid/store.js';
import { uploadFileAndBuildPayload, type UploadProgress } from './upload.js';
import type { MsgError } from './p2p.js';
import { checkGroupIndex, getGroupIndex } from './group-index.js';
import { readBestTaskRuntimeContext, type TaskRuntimeContext } from '../../core/task-runtime-context.js';
import { ipcQuery, type IpcAunFileRequest, type IpcAunMsgSendResponse } from '../../ipc.js';
import { resolvePaths } from '../../paths.js';
import { AGENT_DELEGATION_TOKEN_ENV } from '../../core/auth/agent-delegation.js';

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

export interface GroupBanlistResult {
  ok: true;
  group_id: string;
  items: unknown[];
}

export interface GroupRulesResult {
  ok: true;
  group_id: string;
  rules: Record<string, unknown>;
}

export interface GroupRulesFileMetadata {
  path: '/rules.md';
  size: number;
  mtimeMs: number;
}

export interface GroupRulesFileNotice {
  ok: boolean;
  message_id?: string;
  error?: string;
}

export type GroupRulesFileStatus =
  | 'ok'
  | 'missing'
  | 'forbidden'
  | 'invalid_metadata'
  | 'file_mismatch'
  | 'too_large'
  | 'unreadable'
  | 'error';

export interface GroupRulesFileResult {
  ok: true;
  group_id: string;
  status: GroupRulesFileStatus;
  path: '/rules.md';
  metadata?: GroupRulesFileMetadata;
  remote?: Partial<GroupRulesFileMetadata>;
  content?: string;
  upload?: unknown;
  publish?: unknown;
  group_index_etag?: string;
  notice?: GroupRulesFileNotice;
  error?: string;
}

export interface GroupSimpleResult {
  ok: true;
  group_id: string;
  data?: Record<string, unknown>;
}

export interface GroupOwnerTransferResult {
  ok: true;
  group_id: string;
  data: {
    status: string;
    auto_completed: boolean;
    start: Record<string, unknown>;
    complete?: Record<string, unknown>;
    complete_error?: string;
  };
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
  encrypt?: boolean;
  /** 文件上传进度回调（仅 body.mode==='file' 时触发）。 */
  onUploadProgress?: (info: UploadProgress) => void;
}

function buildGroupPayload(body: Exclude<GroupSendBody, { mode: 'file' }>): Record<string, unknown> {
  return body.mode === 'text' ? { type: 'text', text: body.text } : { ...body.payload };
}

async function tryDaemonGroupSend(
  args: GroupSendArgs,
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

  const response = await ipcQuery<IpcAunMsgSendResponse>(resolvePaths().socket, {
    type: 'aun-msg-send',
    aid: args.from,
    to: args.groupId,
    scope: 'group',
    ...(payload ? { payload } : { file }),
    mentions: args.mentions,
    encrypt: args.encrypt === true,
    originSessionId: runtimeContext.sessionId,
    originMessageId: runtimeContext.messageId,
    delegationToken: process.env[AGENT_DELEGATION_TOKEN_ENV],
  }, file ? 120_000 : 5000);
  return response ?? {
    ok: false,
    code: 'AUN_DAEMON_UNAVAILABLE',
    error: 'EvolClaw daemon did not complete the delegated AUN group send',
  };
}

function daemonGroupSendResult(
  args: GroupSendArgs,
  result: IpcAunMsgSendResponse,
): GroupSendResult | MsgError {
  if (!result.ok) {
    return { ok: false, error: result.error || 'daemon AUN group send failed', code: result.code };
  }
  if (!result.group_id || !result.message) {
    return { ok: false, error: 'daemon AUN group send returned no group message' };
  }
  return {
    ok: true,
    group_id: result.group_id || args.groupId,
    message: result.message as unknown as GroupMessage,
    event: result.event,
  };
}

export async function groupSend(args: GroupSendArgs): Promise<GroupSendResult | MsgError> {
  const runtimeContext = await readBestTaskRuntimeContext();
  if (args.body.mode !== 'file') {
    const payload = buildGroupPayload(args.body);
    const daemonResult = await tryDaemonGroupSend(args, payload, runtimeContext);
    if (daemonResult) return daemonGroupSendResult(args, daemonResult);
  } else {
    const daemonResult = await tryDaemonGroupSend(args, undefined, runtimeContext, {
      filePath: path.resolve(args.body.filePath),
      as: args.body.as,
      contentType: args.body.contentType,
      text: args.body.text,
      transcript: args.body.transcript,
    });
    if (daemonResult) return daemonGroupSendResult(args, daemonResult);
  }

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
          onProgress: args.onUploadProgress,
        });
        payload = built.payload;
        break;
      }
    }
    if (args.mentions && args.mentions.length > 0) {
      payload.mentions = args.mentions;
    }

    const sendParams: Record<string, unknown> = { group_id: args.groupId, payload };
    sendParams.encrypt = args.encrypt === true;
    const result = await conn.call('group.send', sendParams);
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
    const result = await conn.call('group.ack', { group_id: args.groupId, msg_seq: args.seq });
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      ack_seq: result?.cursor ?? result?.ack_seq ?? args.seq,
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
  const store = await getAidStore({ slotId: args.slotId ?? SLOT.cli, aunPath: args.aunPath });
  const conn = await loadClient(store, args.from);
  try {
    await conn.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false } as any);
    const params: Record<string, unknown> = { name: args.name };
    if (args.groupId) params.group_id = args.groupId;
    const groupName = groupNameFromGroupId(args.groupId);
    if (groupName) params.group_name = groupName;
    if (args.visibility) params.visibility = args.visibility;
    if (args.description) params.description = args.description;
    if (args.joinMode) params.join_mode = args.joinMode;

    const result = await (conn as any).createGroup(params);
    return { ok: true, group: result?.group ?? result };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
    try { store.close(); } catch {}
  }
}

export interface GroupInfoArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupInfo(args: GroupInfoArgs): Promise<GroupGetResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.get_info', { group_id: args.groupId });
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

export interface GroupSuspendArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupSuspend(args: GroupSuspendArgs): Promise<GroupSimpleResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.suspend', { group_id: args.groupId });
    return { ok: true, group_id: args.groupId, data: result };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupResumeArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupResume(args: GroupResumeArgs): Promise<GroupSimpleResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.resume', { group_id: args.groupId });
    return { ok: true, group_id: args.groupId, data: result };
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

export interface GroupSetRoleArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  memberAid: string;
  role: 'admin' | 'member';
}

export async function groupSetRole(args: GroupSetRoleArgs): Promise<GroupSimpleResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.set_role', {
      group_id: args.groupId,
      aid: args.memberAid,
      role: args.role,
    });
    return { ok: true, group_id: args.groupId, data: result };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupTransferOwnerArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  newOwner: string;
}

export async function groupTransferOwner(args: GroupTransferOwnerArgs): Promise<GroupOwnerTransferResult | MsgError> {
  const store = await getAidStore({ slotId: args.slotId ?? SLOT.cli, aunPath: args.aunPath });
  const conn = await loadClient(store, args.from);
  try {
    await conn.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false } as any);
    const start = await (conn as any).startGroupTransfer({
      group_id: args.groupId,
      new_owner: args.newOwner,
    }, { aidStore: store });
    if (!ownerTransferNeedsCompletion(start)) {
      return {
        ok: true,
        group_id: args.groupId,
        data: { status: 'completed', auto_completed: false, start: normalizeRecord(start) },
      };
    }

    try {
      const newOwnerConn = await loadClient(store, args.newOwner);
      try {
        await newOwnerConn.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false } as any);
        const complete = await (newOwnerConn as any).completeGroupTransfer({
          group_id: args.groupId,
        }, { aidStore: store });
        return {
          ok: true,
          group_id: args.groupId,
          data: {
            status: 'completed',
            auto_completed: true,
            start: normalizeRecord(start),
            complete: normalizeRecord(complete),
          },
        };
      } finally {
        await newOwnerConn.close();
      }
    } catch (completeError: any) {
      return {
        ok: true,
        group_id: args.groupId,
        data: {
          status: 'pending_rekey',
          auto_completed: false,
          start: normalizeRecord(start),
          complete_error: errorMessage(completeError),
        },
      };
    }
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
    try { store.close(); } catch {}
  }
}

export interface GroupBanArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  memberAid: string;
  durationSeconds?: number;
}

export async function groupBan(args: GroupBanArgs): Promise<GroupSimpleResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = { group_id: args.groupId, aid: args.memberAid };
    if (args.durationSeconds !== undefined) params.duration_seconds = args.durationSeconds;
    const result = await conn.call('group.ban', params);
    return { ok: true, group_id: args.groupId, data: result };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupUnbanArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  memberAid: string;
}

export async function groupUnban(args: GroupUnbanArgs): Promise<GroupSimpleResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.unban', { group_id: args.groupId, aid: args.memberAid });
    return { ok: true, group_id: args.groupId, data: result };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupBanlistArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupBanlist(args: GroupBanlistArgs): Promise<GroupBanlistResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.get_banlist', { group_id: args.groupId });
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      items: result?.items ?? [],
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

// ==================== Rules ====================

export interface GroupRulesArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupRules(args: GroupRulesArgs): Promise<GroupRulesResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const result = await conn.call('group.get_rules', { group_id: args.groupId });
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      rules: result?.rules ?? result ?? {},
    };
  } catch (e: any) {
    if (e?.code === -32000 && String(e?.message ?? '').toLowerCase().includes('rules not found')) {
      return { ok: true, group_id: args.groupId, rules: {} };
    }
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

export interface GroupUpdateRulesArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  mode?: 'open' | 'approval' | 'invite_only' | 'closed';
  question?: string;
  autoApprovePatterns?: string[];
  maxPending?: number;
}

export interface GroupRulesFileGetArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export interface GroupRulesFileSetArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
  filePath: string;
}

export interface GroupRulesFilePublishArgs extends GroupCommonOpts {
  from: string;
  groupId: string;
}

export async function groupUpdateRules(args: GroupUpdateRulesArgs): Promise<GroupRulesResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  try {
    const params: Record<string, unknown> = { group_id: args.groupId };
    if (args.mode !== undefined) params.mode = args.mode;
    if (args.question !== undefined) params.question = args.question;
    if (args.autoApprovePatterns !== undefined) params.auto_approve_patterns = args.autoApprovePatterns;
    if (args.maxPending !== undefined) params.max_pending = args.maxPending;
    const result = await conn.call('group.update_rules', params);
    return {
      ok: true,
      group_id: result?.group_id ?? args.groupId,
      rules: result?.rules ?? result ?? {},
    };
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    await conn.close();
  }
}

const GROUP_RULES_FILE_PATH = '/rules.md' as const;
const MAX_GROUP_RULES_BYTES = 4 * 1024;
const MTIME_TOLERANCE_MS = 1;

export async function groupRulesFileGet(args: GroupRulesFileGetArgs): Promise<GroupRulesFileResult | MsgError> {
  return withAunClient(args.from, args, async (client) => {
    const resolved = await resolvePublishedRulesFile(client, args.groupId, true);
    if (resolved.status !== 'ok') {
      return {
        ok: true,
        group_id: args.groupId,
        status: resolved.status,
        path: GROUP_RULES_FILE_PATH,
        metadata: resolved.metadata,
        remote: resolved.remote,
        error: resolved.error,
      };
    }

    let bytes: Uint8Array;
    try {
      bytes = await readGroupRulesBytes(client, args.groupId);
    } catch (e) {
      return {
        ok: true,
        group_id: args.groupId,
        status: rulesFileStatusFromError(e),
        path: GROUP_RULES_FILE_PATH,
        metadata: resolved.metadata,
        remote: resolved.remote,
        error: errorMessage(e),
      };
    }
    if (bytes.byteLength > MAX_GROUP_RULES_BYTES) {
      return {
        ok: true,
        group_id: args.groupId,
        status: 'too_large',
        path: GROUP_RULES_FILE_PATH,
        metadata: resolved.metadata,
      };
    }

    let content: string;
    try {
      content = decodeRulesText(bytes);
    } catch (e) {
      return {
        ok: true,
        group_id: args.groupId,
        status: 'unreadable',
        path: GROUP_RULES_FILE_PATH,
        metadata: resolved.metadata,
        remote: resolved.remote,
        error: `规则文件不是有效 UTF-8: ${errorMessage(e)}`,
      };
    }

    return {
      ok: true,
      group_id: args.groupId,
      status: 'ok',
      path: GROUP_RULES_FILE_PATH,
      metadata: resolved.metadata,
      content,
    };
  });
}

export async function groupRulesFileSet(args: GroupRulesFileSetArgs): Promise<GroupRulesFileResult | MsgError> {
  return withAunClient(args.from, args, async (client) => {
    assertLocalRulesFile(args.filePath);
    const upload = await client.group.fs.cp(args.filePath, `${args.groupId}:${GROUP_RULES_FILE_PATH}`, {
      force: true,
      overwrite: true,
      parents: true,
      contentType: 'text/markdown; charset=utf-8',
    });
    const published = await publishCurrentRulesFile(client, args.groupId, args.from);
    return { ...published, upload };
  });
}

export async function groupRulesFilePublish(args: GroupRulesFilePublishArgs): Promise<GroupRulesFileResult | MsgError> {
  return withAunClient(args.from, args, async (client) => {
    return publishCurrentRulesFile(client, args.groupId, args.from);
  });
}

// ==================== Internal ====================

async function withAunClient<T>(
  from: string,
  opts: GroupCommonOpts,
  fn: (client: AUNClient) => Promise<T>,
): Promise<T | MsgError> {
  const store = await getAidStore({ slotId: opts.slotId ?? SLOT.cli, aunPath: opts.aunPath });
  let client: AUNClient | undefined;
  try {
    client = await loadClient(store, from);
    await client.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false });
    return await fn(client);
  } catch (e: any) {
    return formatRpcError(e);
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
    try { store.close(); } catch { /* ignore */ }
  }
}

async function resolvePublishedRulesFile(
  client: AUNClient,
  groupId: string,
  forcePull: boolean,
): Promise<{
  status: GroupRulesFileStatus;
  metadata?: GroupRulesFileMetadata;
  remote?: Partial<GroupRulesFileMetadata>;
  error?: string;
}> {
  let content: unknown;
  if (forcePull) {
    try {
      const index = await getGroupIndex(client, groupId);
      const settings = isRecord(index.settings) ? index.settings : {};
      content = settings['rules.content'];
    } catch (e) {
      return {
        status: rulesFileStatusFromError(e),
        error: errorMessage(e),
      };
    }
  } else {
    try {
      const result = await client.group.getRules({ group_id: groupId }) as Record<string, unknown>;
      const rules = isRecord(result.rules) ? result.rules : {};
      content = rules.content;
    } catch (e) {
      return {
        status: rulesFileStatusFromError(e),
        error: errorMessage(e),
      };
    }
  }
  if (content === undefined || content === null || content === '') {
    return { status: 'missing' };
  }

  let metadata: GroupRulesFileMetadata;
  try {
    metadata = parseRulesFileMetadata(content);
  } catch (e) {
    return {
      status: statusFromTaggedError(e) ?? 'invalid_metadata',
      error: errorMessage(e),
    };
  }
  if (metadata.size > MAX_GROUP_RULES_BYTES) {
    return { status: 'too_large', metadata };
  }

  let remote: Partial<GroupRulesFileMetadata>;
  try {
    remote = metadataFromRulesStat(await client.group.fs.stat(`${groupId}:${GROUP_RULES_FILE_PATH}`));
  } catch (e) {
    return {
      status: rulesFileStatusFromError(e),
      metadata,
      error: errorMessage(e),
    };
  }
  if (!remote.size || remote.mtimeMs === undefined) {
    return {
      status: 'unreadable',
      metadata,
      remote,
      error: `远端 ${GROUP_RULES_FILE_PATH} 缺少 size 或 mtimeMs`,
    };
  }
  if (!metadataMatches(metadata, remote)) {
    return { status: 'file_mismatch', metadata, remote };
  }
  return { status: 'ok', metadata, remote };
}

async function publishCurrentRulesFile(
  client: AUNClient,
  groupId: string,
  actorAid: string,
): Promise<GroupRulesFileResult> {
  let metadata: Partial<GroupRulesFileMetadata>;
  try {
    metadata = metadataFromRulesStat(await client.group.fs.stat(`${groupId}:${GROUP_RULES_FILE_PATH}`));
  } catch (e) {
    return {
      ok: true,
      group_id: groupId,
      status: rulesFileStatusFromError(e),
      path: GROUP_RULES_FILE_PATH,
      error: errorMessage(e),
    };
  }
  if (!metadata.size || metadata.mtimeMs === undefined) {
    return {
      ok: true,
      group_id: groupId,
      status: 'unreadable',
      path: GROUP_RULES_FILE_PATH,
      remote: metadata,
      error: `远端 ${GROUP_RULES_FILE_PATH} 缺少 size 或 mtimeMs`,
    };
  }
  const rulesMetadata: GroupRulesFileMetadata = {
    path: GROUP_RULES_FILE_PATH,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
  };
  if (rulesMetadata.size > MAX_GROUP_RULES_BYTES) {
    return {
      ok: true,
      group_id: groupId,
      status: 'too_large',
      path: GROUP_RULES_FILE_PATH,
      metadata: rulesMetadata,
    };
  }

  const publish = await client.group.updateRules({
    group_id: groupId,
    content: JSON.stringify(rulesMetadata),
    attachments: [],
  }) as Record<string, unknown>;

  let after: Partial<GroupRulesFileMetadata>;
  try {
    after = metadataFromRulesStat(await client.group.fs.stat(`${groupId}:${GROUP_RULES_FILE_PATH}`));
  } catch (e) {
    return {
      ok: true,
      group_id: groupId,
      status: rulesFileStatusFromError(e),
      path: GROUP_RULES_FILE_PATH,
      metadata: rulesMetadata,
      publish,
      error: errorMessage(e),
    };
  }
  if (!metadataMatches(rulesMetadata, after)) {
    return {
      ok: true,
      group_id: groupId,
      status: 'file_mismatch',
      path: GROUP_RULES_FILE_PATH,
      metadata: rulesMetadata,
      remote: after,
      publish,
    };
  }

  const groupIndexEtag = groupIndexEtagFromUpdate(publish, groupId) ?? await currentGroupIndexEtag(client, groupId);
  const notice = await sendGroupRulesUpdatedNotice(client, {
    groupId,
    actorAid,
    metadata: rulesMetadata,
    groupIndexEtag,
  });

  return {
    ok: true,
    group_id: groupId,
    status: 'ok',
    path: GROUP_RULES_FILE_PATH,
    metadata: rulesMetadata,
    publish,
    group_index_etag: groupIndexEtag,
    notice,
  };
}

async function sendGroupRulesUpdatedNotice(
  client: AUNClient,
  args: {
    groupId: string;
    actorAid: string;
    metadata: GroupRulesFileMetadata;
    groupIndexEtag?: string;
  },
): Promise<GroupRulesFileNotice> {
  const payload = {
    type: 'notice',
    subtype: 'group.rules.updated',
    text: `群规则已发布：${args.groupId}:${GROUP_RULES_FILE_PATH}\n操作者：${args.actorAid}`,
    actor_aid: args.actorAid,
    group_id: args.groupId,
    path: GROUP_RULES_FILE_PATH,
    group_index_etag: args.groupIndexEtag,
    size: args.metadata.size,
    mtimeMs: args.metadata.mtimeMs,
  };

  try {
    const result = await client.group.send({
      group_id: args.groupId,
      payload,
      encrypt: false,
    }) as Record<string, unknown>;
    const message = isRecord(result.message) ? result.message : {};
    const messageId = typeof result.message_id === 'string'
      ? result.message_id
      : typeof message.message_id === 'string'
        ? message.message_id
        : undefined;
    return { ok: true, message_id: messageId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function assertLocalRulesFile(filePath: string): void {
  const st = fs.statSync(filePath);
  if (!st.isFile()) {
    throw new Error(`规则文件不是普通文件: ${filePath}`);
  }
  if (st.size > MAX_GROUP_RULES_BYTES) {
    throw new Error(`规则文件过大: ${st.size} bytes > ${MAX_GROUP_RULES_BYTES}`);
  }
  const bytes = fs.readFileSync(filePath);
  try {
    decodeRulesText(bytes);
  } catch (e) {
    throw new Error(`规则文件不是有效 UTF-8: ${errorMessage(e)}`);
  }
}

async function readGroupRulesBytes(client: AUNClient, groupId: string): Promise<Uint8Array> {
  const remoteRef = `${groupId}:${GROUP_RULES_FILE_PATH}`;
  const ticket = await (client as any).call('group.fs.create_download_ticket', { path: remoteRef });
  if (!isRecord(ticket)) {
    throw new Error('group.fs.create_download_ticket returned invalid response');
  }
  const downloadUrl = stringField(ticket, ['download_url', 'url']);
  if (!downloadUrl) {
    throw new Error('group.fs.create_download_ticket did not return download_url');
  }
  const bytes = await client.group.fs.lowlevel.httpGet(downloadUrl, bearerHeaders(client));
  const expectedSha = stringField(ticket, ['sha256']);
  if (expectedSha && sha256Hex(bytes).toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error('download hash verification failed');
  }
  return bytes;
}

function decodeRulesText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseRulesFileMetadata(value: unknown): GroupRulesFileMetadata {
  let parsed: unknown;
  if (typeof value === 'string') {
    parsed = JSON.parse(value);
  } else {
    parsed = value;
  }
  if (!isRecord(parsed)) {
    throw statusError('invalid_metadata', 'rules.content metadata must be an object');
  }
  if (parsed.path !== GROUP_RULES_FILE_PATH) {
    throw statusError('invalid_metadata', `rules.content.path must be ${GROUP_RULES_FILE_PATH}`);
  }
  const size = numberField(parsed, ['size']);
  const mtimeMs = mtimeMsField(parsed);
  if (size === undefined || !Number.isInteger(size) || size <= 0) {
    throw statusError('invalid_metadata', 'rules.content.size must be a positive integer');
  }
  if (mtimeMs === undefined || !Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    throw statusError('invalid_metadata', 'rules.content.mtimeMs must be a valid millisecond timestamp');
  }
  return { path: GROUP_RULES_FILE_PATH, size, mtimeMs };
}

function metadataFromRulesStat(value: unknown): Partial<GroupRulesFileMetadata> {
  if (!isRecord(value)) return { path: GROUP_RULES_FILE_PATH };
  return {
    path: GROUP_RULES_FILE_PATH,
    size: numberField(value, ['size', 'sizeBytes', 'size_bytes', 'bytes']),
    mtimeMs: mtimeMsField(value),
  };
}

function metadataMatches(expected: GroupRulesFileMetadata, actual: Partial<GroupRulesFileMetadata>): boolean {
  return actual.size === expected.size
    && actual.mtimeMs !== undefined
    && Math.abs(actual.mtimeMs - expected.mtimeMs) <= MTIME_TOLERANCE_MS;
}

function groupIndexEtagFromUpdate(result: Record<string, unknown>, groupId: string): string | undefined {
  const meta = isRecord(result._meta) ? result._meta : {};
  const groupIndexes = isRecord(meta.group_indexes) ? meta.group_indexes : {};
  const direct = isRecord(groupIndexes[groupId]) ? groupIndexes[groupId] : undefined;
  if (typeof direct?.etag === 'string') return direct.etag;
  for (const value of Object.values(groupIndexes)) {
    if (isRecord(value) && typeof value.etag === 'string') return value.etag;
  }
  return undefined;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bearerHeaders(client: AUNClient): Record<string, string> | undefined {
  const token = accessTokenFromClient(client);
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function accessTokenFromClient(client: AUNClient): string {
  const anyClient = client as any;
  if (typeof anyClient.getAccessToken === 'function') {
    const token = stringValue(anyClient.getAccessToken());
    if (token) return token;
  }
  return stringValue(anyClient.accessToken)
    || stringValue(anyClient.access_token)
    || stringValue(anyClient._identity?.access_token)
    || stringValue(anyClient._sessionParams?.access_token);
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

async function currentGroupIndexEtag(client: AUNClient, groupId: string): Promise<string | undefined> {
  try {
    const check = await checkGroupIndex(client, groupId);
    for (const key of ['remote_etag', 'local_etag', 'etag']) {
      const value = check[key];
      if (typeof value === 'string' && value) return value;
    }
  } catch {
    // Fall through to a pulled index below.
  }
  try {
    const index = await getGroupIndex(client, groupId);
    const meta = isRecord(index.meta) ? index.meta : {};
    return typeof meta.etag === 'string' ? meta.etag : undefined;
  } catch {
    return undefined;
  }
}

function statusError(status: GroupRulesFileStatus, message: string): Error & { groupRulesFileStatus?: GroupRulesFileStatus } {
  const error = new Error(message) as Error & { groupRulesFileStatus?: GroupRulesFileStatus };
  error.groupRulesFileStatus = status;
  return error;
}

function statusFromTaggedError(error: unknown): GroupRulesFileStatus | undefined {
  if (isRecord(error) && typeof error.groupRulesFileStatus === 'string') {
    const status = error.groupRulesFileStatus;
    if (isGroupRulesFileStatus(status)) return status;
  }
  return undefined;
}

function rulesFileStatusFromError(error: unknown): GroupRulesFileStatus {
  const tagged = statusFromTaggedError(error);
  if (tagged) return tagged;
  const haystack = errorHaystack(error);
  if (/(forbidden|unauthorized|permission|denied|no_permission|permission_denied|无权限|权限|拒绝|\b401\b|\b403\b)/i.test(haystack)) {
    return 'forbidden';
  }
  if (/(not[_ -]?found|notfound|no such|enoent|missing|不存在|\b404\b|rules not found)/i.test(haystack)) {
    return 'missing';
  }
  if (/(signature|verify|verification|signed_by|body_hash|invalid signature|验签|签名|json|metadata)/i.test(haystack)) {
    return 'invalid_metadata';
  }
  if (/(timeout|temporar|unavailable|econn|network|socket|reset|下载|读取)/i.test(haystack)) {
    return 'unreadable';
  }
  return 'error';
}

function isGroupRulesFileStatus(value: string): value is GroupRulesFileStatus {
  return value === 'ok'
    || value === 'missing'
    || value === 'forbidden'
    || value === 'invalid_metadata'
    || value === 'file_mismatch'
    || value === 'too_large'
    || value === 'unreadable'
    || value === 'error';
}

function errorHaystack(error: unknown): string {
  if (!isRecord(error)) return errorMessage(error);
  return [
    error.name,
    error.message,
    error.code,
    error.status,
    error.statusCode,
    error.error,
  ].map(value => value === undefined ? '' : String(value)).join(' ');
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function mtimeMsField(obj: Record<string, unknown>): number | undefined {
  const direct = numberField(obj, ['mtimeMs', 'mtime_ms', 'updatedAtMs', 'updated_at_ms']);
  if (direct !== undefined) return direct;
  const seconds = numberField(obj, ['mtime', 'updated_at', 'updatedAt', 'last_modified', 'modified_at']);
  if (seconds !== undefined) return seconds > 10_000_000_000 ? seconds : seconds * 1000;
  for (const key of ['modifiedAt', 'modified_at', 'mtime_iso']) {
    const value = obj[key];
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatRpcError(e: any): MsgError {
  if (e?.code !== undefined && e?.message !== undefined) {
    return { ok: false, error: String(e.message), code: e.code };
  }
  return { ok: false, error: String(e?.message ?? e) };
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : { value };
}

function ownerTransferNeedsCompletion(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  const status = String(data.status ?? data.transfer_status ?? '').toLowerCase();
  return status === 'pending_rekey' || status === 'requires_ca_rekey' || data.requires_ca_rekey === true;
}

function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message?: unknown }).message);
  return String(e);
}

function groupNameFromGroupId(groupId?: string): string | undefined {
  if (!groupId) return undefined;
  const raw = String(groupId).trim().toLowerCase();
  const first = raw.split(/[.@/]/, 1)[0] ?? '';
  const slug = first.startsWith('g-') ? first.slice(2) : first;
  if (/^[a-z0-9][a-z0-9_-]{3,63}$/.test(slug)) return slug;
  return undefined;
}
