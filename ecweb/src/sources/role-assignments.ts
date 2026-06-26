import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import {
  getSessionsAunDir,
  listPeers,
  readJsonFile,
  readMessages,
  type MessageLogEntry,
  type SessionFile,
} from '../fs-utils.js';
import type { WatchSource } from './types.js';

interface RoleWriteAuth {
  localDirect?: boolean;
  actorAid?: string | null;
}

export interface RoleAssignment {
  scope: 'private' | 'group' | 'group-member';
  peerId?: string;
  groupId?: string;
  role: string;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface LocalAgentMdInfo {
  name?: string;
  declaredType?: string;
  peerType?: 'ai' | 'human' | 'system';
}

type LocalAgentMdLookup = (aid: string) => LocalAgentMdInfo | undefined;

export interface ConversationMemberSeed {
  peerId: string;
  peerAid: string;
  peerKey: string;
  peerName?: string | null;
  peerType?: 'ai' | 'human' | 'system';
  lastAt?: number;
  inbound?: number;
  outbound?: number;
}

export interface ConversationSeed {
  self: string;
  channelType: 'aun';
  chatType: 'private' | 'group';
  conversationId: string;
  name: string;
  peerId?: string;
  peerAid?: string;
  peerKey?: string;
  peerName?: string | null;
  peerType?: 'ai' | 'human' | 'system';
  groupId?: string;
  groupName?: string | null;
  lastAt?: number;
  inbound?: number;
  outbound?: number;
  members?: ConversationMemberSeed[];
}

function toUrl(p: string): string {
  return process.platform === 'win32'
    ? new URL('file:///' + p.replace(/\\/g, '/')).href
    : p;
}

async function getParentModules() {
  const dist = path.join(process.cwd(), 'dist', 'config');
  const assignmentsPath = path.join(dist, 'role-assignments.js');
  const rolesPath = path.join(dist, 'roles.js');
  const resolverPath = path.join(dist, 'peer-role-resolver.js');

  for (const p of [assignmentsPath, rolesPath, resolverPath]) {
    if (!fs.existsSync(p)) throw new Error(`module not found: ${p}. Is evolclaw built?`);
  }

  const assignments = await import(toUrl(assignmentsPath));
  const roles = await import(toUrl(rolesPath));
  const resolver = await import(toUrl(resolverPath));
  return { assignments, roles, resolver };
}

async function getAgentsFromIpc(): Promise<any[]> {
  try {
    const p = resolvePaths();
    const { ipcQuery } = await import('../ipc-client.js');
    const resp = await ipcQuery<{ ok: boolean; agents: any[] }>(
      p.socket,
      { type: 'evolagent.list' },
      3000,
    );
    return resp?.agents ?? [];
  } catch {
    return [];
  }
}

async function canManageAgent(aid: string, auth: RoleWriteAuth): Promise<boolean> {
  if (auth.localDirect) return true;
  if (!auth.actorAid) return false;
  const { assignments } = await getParentModules();
  ensureScopedRoleAssignments(assignments, aid);
  return assignments
    .listRoleAssignments(aid, { scope: 'private', role: 'owner' })
    .some((item: RoleAssignment) => item.peerId === auth.actorAid);
}

function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
  });
}

function sendJson(res: any, status: number, data: any): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function assignmentFromPath(urlPath: string): { aid: string; targetId: string } | null {
  const parts = urlPath.split('/').filter(Boolean);
  if (parts.length < 5) return null;
  return {
    aid: decodeURIComponent(parts[3]),
    targetId: decodeURIComponent(parts.slice(4).join('/')),
  };
}

function roleAssignmentKey(assignments: any, item: Pick<RoleAssignment, 'scope' | 'peerId' | 'groupId'>): string {
  if (item.scope === 'private') {
    return assignments.privateAssignmentKey
      ? assignments.privateAssignmentKey(item.peerId)
      : `private::${encodeURIComponent(item.peerId || '')}`;
  }
  if (item.scope === 'group') {
    return assignments.groupAssignmentKey
      ? assignments.groupAssignmentKey(item.groupId)
      : `group::${encodeURIComponent(item.groupId || '')}`;
  }
  return assignments.groupMemberAssignmentKey
    ? assignments.groupMemberAssignmentKey(item.groupId, item.peerId)
    : `group-member::${encodeURIComponent(item.groupId || '')}::${encodeURIComponent(item.peerId || '')}`;
}

function normalizeRoleAssignment(item: any): RoleAssignment | null {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.role !== 'string' || !item.role) return null;
  const scope = item.scope || (item.groupId ? (item.peerId ? 'group-member' : 'group') : (item.peerId ? 'private' : ''));
  if (scope !== 'private' && scope !== 'group' && scope !== 'group-member') return null;
  if (scope === 'private' && !item.peerId) return null;
  if (scope === 'group' && !item.groupId) return null;
  if (scope === 'group-member' && (!item.groupId || !item.peerId)) return null;

  return {
    scope,
    ...(item.peerId ? { peerId: item.peerId } : {}),
    ...(item.groupId ? { groupId: item.groupId } : {}),
    role: item.role,
    ...(typeof item.note === 'string' ? { note: item.note } : {}),
    ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}),
    ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
  };
}

function ensureScopedRoleAssignments(assignments: any, aid: string): void {
  const config = assignments.readRoleAssignments(aid);
  const sourceAssignments = config.assignments || {};
  const nextAssignments: Record<string, RoleAssignment> = {};
  let changed = config.$schema_version !== 2;

  for (const [key, raw] of Object.entries<any>(sourceAssignments)) {
    const item = normalizeRoleAssignment(raw);
    if (!item) {
      nextAssignments[key] = raw as RoleAssignment;
      continue;
    }
    const nextKey = roleAssignmentKey(assignments, item);
    nextAssignments[nextKey] = item;
    if (key !== nextKey || JSON.stringify(raw) !== JSON.stringify(item)) changed = true;
  }

  if (!changed) return;
  assignments.writeRoleAssignments(aid, {
    $schema_version: 2,
    assignments: nextAssignments,
  });
}

function readActive(aunDir: string, aid: string, conversationId: string): SessionFile | undefined {
  return readJsonFile<SessionFile>(
    path.join(aunDir, encodeSegmentForRoleSource(aid), encodeSegmentForRoleSource(conversationId), 'active.json'),
  );
}

function encodeSegmentForRoleSource(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1F%]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\r\\n#]*))\\s*(?:#.*)?$`, 'm');
  const match = frontmatter.match(re);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function normalizeAgentPeerType(value?: string | null): 'ai' | 'human' | 'system' | undefined {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw || raw === 'unknown') return undefined;
  if (raw === 'human') return 'human';
  if (raw === 'system') return 'system';
  return 'ai';
}

export function parseAgentMdInfo(content: string): LocalAgentMdInfo | undefined {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const frontmatter = match[1];
  const declaredType = frontmatterValue(frontmatter, 'type');
  const name = frontmatterValue(frontmatter, 'name');
  return {
    ...(name ? { name } : {}),
    ...(declaredType ? { declaredType, peerType: normalizeAgentPeerType(declaredType) } : {}),
  };
}

function createLocalAgentMdLookup(): LocalAgentMdLookup {
  const cache = new Map<string, LocalAgentMdInfo | undefined>();
  const aidsDir = path.join(resolvePaths().root, 'AIDs');
  return (aid: string) => {
    if (!aid || !/^[A-Za-z0-9._-]+$/.test(aid)) return undefined;
    if (cache.has(aid)) return cache.get(aid);
    let info: LocalAgentMdInfo | undefined;
    try {
      const agentMdPath = path.join(aidsDir, aid, 'agent.md');
      if (fs.existsSync(agentMdPath)) {
        info = parseAgentMdInfo(fs.readFileSync(agentMdPath, 'utf-8'));
      }
    } catch {
      info = undefined;
    }
    cache.set(aid, info);
    return info;
  };
}

function latestMessageAt(messages: MessageLogEntry[]): number {
  let lastAt = 0;
  for (const message of messages) {
    if (message.ts > lastAt) lastAt = message.ts;
  }
  return lastAt;
}

function messageCounts(messages: MessageLogEntry[]): { inbound: number; outbound: number } {
  let inbound = 0;
  let outbound = 0;
  for (const message of messages) {
    if (message.dir === 'in') inbound++;
    else outbound++;
  }
  return { inbound, outbound };
}

function firstMessagePeerName(messages: MessageLogEntry[], peerId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.from === peerId && message.peerName) return message.peerName;
  }
  return undefined;
}

function firstMessagePeerType(messages: MessageLogEntry[], peerId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.from === peerId && message.peerType) return message.peerType;
  }
  return undefined;
}

function conversationSortName(seed: ConversationSeed): string {
  return (seed.name || seed.peerAid || seed.groupId || seed.conversationId).toLowerCase();
}

function groupMembersFromMessages(
  selfAid: string,
  messages: MessageLogEntry[],
  localAgentMdLookup: LocalAgentMdLookup,
): ConversationMemberSeed[] {
  const members = new Map<string, ConversationMemberSeed>();

  for (const message of messages) {
    const sender = message.from;
    if (!sender || sender === selfAid) continue;
    const current = members.get(sender) ?? {
      peerId: sender,
      peerAid: sender,
      peerKey: sender,
      lastAt: 0,
      inbound: 0,
      outbound: 0,
    };

    if (message.ts > (current.lastAt ?? 0)) current.lastAt = message.ts;
    if (message.dir === 'in') current.inbound = (current.inbound ?? 0) + 1;
    else current.outbound = (current.outbound ?? 0) + 1;
    if (message.peerName) current.peerName = message.peerName;
    if (message.peerType) current.peerType = normalizeAgentPeerType(message.peerType);
    members.set(sender, current);
  }

  for (const member of members.values()) {
    const localInfo = localAgentMdLookup(member.peerId);
    member.peerName = localInfo?.name ?? member.peerName;
    member.peerType = localInfo?.peerType ?? member.peerType;
  }

  return [...members.values()].sort((a, b) => {
    const lastDiff = (b.lastAt ?? 0) - (a.lastAt ?? 0);
    if (lastDiff !== 0) return lastDiff;
    return (a.peerName || a.peerAid).localeCompare(b.peerName || b.peerAid);
  });
}

export function buildConversationSeeds(
  aid: string,
  peerInfos: Array<{
    conversationId: string;
    active?: SessionFile;
    messages?: MessageLogEntry[];
  }>,
  localAgentMdLookup: LocalAgentMdLookup = () => undefined,
): ConversationSeed[] {
  const seeds: ConversationSeed[] = [];

  for (const peer of peerInfos) {
    const messages = peer.messages || [];
    const active = peer.active;
    const chatType = active?.chatType || messages.find(m => m.chatType)?.chatType || 'private';
    const lastAt = active?.updatedAt || latestMessageAt(messages);
    const counts = messageCounts(messages);

    if (chatType === 'group') {
      const groupId = active?.metadata?.groupId || messages.find(m => m.groupId)?.groupId || peer.conversationId;
      const groupName = active?.metadata?.groupName || active?.name || groupId;
      seeds.push({
        self: aid,
        channelType: 'aun',
        chatType: 'group',
        conversationId: groupId,
        groupId,
        groupName,
        name: groupName,
        lastAt,
        inbound: counts.inbound,
        outbound: counts.outbound,
        members: groupMembersFromMessages(aid, messages, localAgentMdLookup),
      });
      continue;
    }

    const peerId = active?.metadata?.peerId || peer.conversationId;
    const localInfo = localAgentMdLookup(peerId);
    const metadataName = active?.metadata?.peerName || firstMessagePeerName(messages, peerId);
    const metadataType = active?.metadata?.peerType || firstMessagePeerType(messages, peerId);
    const peerName = localInfo?.name ?? metadataName ?? peerId;
    const peerType = localInfo?.peerType ?? normalizeAgentPeerType(metadataType);

    seeds.push({
      self: aid,
      channelType: 'aun',
      chatType: 'private',
      conversationId: peerId,
      name: peerName,
      peerId,
      peerAid: peerId,
      peerKey: peerId,
      peerName,
      peerType,
      lastAt,
      inbound: counts.inbound,
      outbound: counts.outbound,
    });
  }

  return seeds.sort((a, b) => {
    const lastDiff = (b.lastAt ?? 0) - (a.lastAt ?? 0);
    if (lastDiff !== 0) return lastDiff;
    if (a.chatType !== b.chatType) return a.chatType === 'group' ? -1 : 1;
    return conversationSortName(a).localeCompare(conversationSortName(b));
  });
}

function loadConversationSeeds(aid: string): ConversationSeed[] {
  const aunDir = getSessionsAunDir();
  const localAgentMdLookup = createLocalAgentMdLookup();
  const peerInfos = listPeers(aunDir, aid).map(conversationId => ({
    conversationId,
    active: readActive(aunDir, aid, conversationId),
    messages: readMessages(aunDir, aid, conversationId),
  }));
  return buildConversationSeeds(aid, peerInfos, localAgentMdLookup);
}

function resolveGroupRoleDetail(assignments: any, roles: any, aid: string, groupId: string): { effectiveRole: string; source: string; assignment?: RoleAssignment } {
  const assignment = assignments.getGroupRoleAssignment(aid, groupId) as RoleAssignment | undefined;
  if (assignment) {
    return { effectiveRole: assignment.role, source: 'assignment', assignment };
  }
  const rolesConfig = roles.readRolesConfig();
  return { effectiveRole: rolesConfig.defaultRoles?.group || 'guest', source: 'default' };
}

function withResolvedRoles(seed: ConversationSeed, modules: { assignments: any; roles: any; resolver: any }): any {
  if (seed.chatType === 'private') {
    const detail = modules.resolver.resolvePeerRoleDetail({
      selfAid: seed.self,
      channelType: seed.channelType,
      chatType: 'private',
      actorId: seed.peerId,
      conversationId: seed.conversationId,
      peerType: seed.peerType,
    });
    return {
      ...seed,
      role: detail.effectiveRole,
      source: detail.source,
      assignment: detail.assignment,
    };
  }

  const groupId = seed.groupId || seed.conversationId;
  const groupDetail = resolveGroupRoleDetail(modules.assignments, modules.roles, seed.self, groupId);
  const members = (seed.members || []).map(member => {
    const detail = modules.resolver.resolvePeerRoleDetail({
      selfAid: seed.self,
      channelType: seed.channelType,
      chatType: 'group',
      actorId: member.peerId,
      conversationId: groupId,
      peerType: member.peerType,
    });
    return {
      ...member,
      role: detail.effectiveRole,
      source: detail.source,
      assignment: detail.assignment,
    };
  });

  return {
    ...seed,
    conversationId: groupId,
    groupId,
    role: groupDetail.effectiveRole,
    source: groupDetail.source,
    assignment: groupDetail.assignment,
    members,
  };
}

async function buildSnapshot(): Promise<any> {
  const modules = await getParentModules();
  const agents = await getAgentsFromIpc();
  const snapshotAgents: any[] = [];
  const conversations: any[] = [];

  for (const agent of agents) {
    const aid = agent.aid;
    if (!aid) continue;
    ensureScopedRoleAssignments(modules.assignments, aid);
    const config = modules.assignments.readRoleAssignments(aid);
    const roleItems = Object.values(config.assignments || {}) as RoleAssignment[];
    snapshotAgents.push({
      aid,
      displayName: agent.displayName ?? agent.personalName,
      name: agent.name,
      assignments: roleItems,
    });

    for (const seed of loadConversationSeeds(aid)) {
      conversations.push(withResolvedRoles(seed, modules));
    }
  }

  return { agents: snapshotAgents, conversations };
}

export const roleAssignmentsSource: WatchSource = {
  kind: 'roles',

  async snapshot(): Promise<any> {
    try { return await buildSnapshot(); }
    catch (err) { return { agents: [], conversations: [], error: String(err) }; }
  },

  subscribe(_params: Record<string, any>, push: (data: any) => void): () => void {
    let lastJson = '';
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const snap = await buildSnapshot();
        const json = JSON.stringify(snap);
        if (json !== lastJson) {
          lastJson = json;
          push(snap);
        }
      } catch (err) {
        console.error('[role-assignments] polling error:', err);
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  },
};

function requireScope(body: any): RoleAssignment['scope'] {
  if (body.scope !== 'private' && body.scope !== 'group' && body.scope !== 'group-member') {
    throw new Error('scope must be private, group, or group-member');
  }
  return body.scope;
}

function setScopedAssignment(assignments: any, aid: string, body: any, fallbackTargetId?: string): RoleAssignment {
  ensureScopedRoleAssignments(assignments, aid);
  const scope = requireScope(body);
  const role = body.role;
  if (!role) throw new Error('role is required');
  if (scope === 'private') {
    const peerId = body.peerId || fallbackTargetId;
    if (!peerId) throw new Error('peerId is required');
    return assignments.setPrivateRoleAssignment(aid, peerId, role, { note: body.note });
  }
  if (scope === 'group') {
    const groupId = body.groupId || fallbackTargetId;
    if (!groupId) throw new Error('groupId is required');
    return assignments.setGroupRoleAssignment(aid, groupId, role, { note: body.note });
  }
  const groupId = body.groupId;
  const peerId = body.peerId || fallbackTargetId;
  if (!groupId || !peerId) throw new Error('groupId and peerId are required');
  return assignments.setGroupMemberRoleAssignment(aid, groupId, peerId, role, { note: body.note });
}

function deleteScopedAssignment(assignments: any, aid: string, body: any, fallbackTargetId?: string): boolean {
  ensureScopedRoleAssignments(assignments, aid);
  const scope = requireScope(body);
  if (scope === 'private') {
    const peerId = body.peerId || fallbackTargetId;
    if (!peerId) throw new Error('peerId is required');
    return assignments.deletePrivateRoleAssignment(aid, peerId);
  }
  if (scope === 'group') {
    const groupId = body.groupId || fallbackTargetId;
    if (!groupId) throw new Error('groupId is required');
    return assignments.deleteGroupRoleAssignment(aid, groupId);
  }
  const groupId = body.groupId;
  const peerId = body.peerId || fallbackTargetId;
  if (!groupId || !peerId) throw new Error('groupId and peerId are required');
  return assignments.deleteGroupMemberRoleAssignment(aid, groupId, peerId);
}

export async function handleRoleAssignmentsApi(req: any, res: any, auth: RoleWriteAuth = {}): Promise<void> {
  try {
    const { assignments } = await getParentModules();
    const urlPath = (req.url || '').split('?')[0];

    if (req.method === 'GET' && urlPath.startsWith('/api/roles/agent/')) {
      const aid = decodeURIComponent(urlPath.split('/').filter(Boolean).pop() || '');
      if (!aid) return sendJson(res, 400, { error: 'missing aid' });
      return sendJson(res, 200, assignments.readRoleAssignments(aid));
    }

    if ((req.method === 'POST' || req.method === 'PUT') && urlPath.startsWith('/api/roles/agent/')) {
      const aid = decodeURIComponent(urlPath.split('/').filter(Boolean).pop() || '');
      if (!aid) return sendJson(res, 400, { error: 'missing aid' });
      if (!(await canManageAgent(aid, auth))) return sendJson(res, 403, { error: 'forbidden: owner required' });

      const body = await parseBody(req);
      const item = setScopedAssignment(assignments, aid, body);
      return sendJson(res, 200, { ok: true, assignment: item });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err: any) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}

export async function handlePeerRoleApi(req: any, res: any, auth: RoleWriteAuth = {}): Promise<void> {
  try {
    const { assignments } = await getParentModules();
    const urlPath = (req.url || '').split('?')[0];
    const target = assignmentFromPath(urlPath);
    if (!target) return sendJson(res, 400, { error: 'missing aid or target id' });
    if (!(await canManageAgent(target.aid, auth))) return sendJson(res, 403, { error: 'forbidden: owner required' });

    if (req.method === 'DELETE') {
      const body = await parseBody(req);
      const deleted = deleteScopedAssignment(assignments, target.aid, body, target.targetId);
      return sendJson(res, 200, { ok: true, deleted });
    }
    if (req.method === 'PUT') {
      const body = await parseBody(req);
      const item = setScopedAssignment(assignments, target.aid, body, target.targetId);
      return sendJson(res, 200, { ok: true, assignment: item });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err: any) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}
