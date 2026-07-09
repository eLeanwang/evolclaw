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
import { resolveParentDistModule, toFileUrl } from './parent-package.js';

interface RoleWriteAuth {
  localDirect?: boolean;
  actorAid?: string | null;
}

export interface RoleAssignment {
  scope: 'private' | 'group' | 'group-member';
  peerId?: string;
  groupId?: string;
  peerKey: string;
  role: string;
  source: 'relation-config';
}

type ScopedAssignmentTarget =
  | ({ scope: 'private'; peerId: string; peerKey: string } & Record<string, unknown>)
  | ({ scope: 'group'; groupId: string; peerKey: string } & Record<string, unknown>)
  | ({ scope: 'group-member'; groupId: string; peerId: string; peerKey: string } & Record<string, unknown>);

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

async function getParentModules() {
  const configPath = resolveParentDistModule('config', 'config-manager.js');
  const rolesPath = resolveParentDistModule('config', 'roles.js');
  const resolverPath = resolveParentDistModule('config', 'peer-role-resolver.js');

  const config = await import(toFileUrl(configPath));
  const roles = await import(toFileUrl(rolesPath));
  const resolver = await import(toFileUrl(resolverPath));
  return { config, roles, resolver };
}

async function getCommandModules() {
  const permissionPath = resolveParentDistModule('core', 'command', 'command-permission.js');
  const auditPath = resolveParentDistModule('core', 'command', 'command-audit.js');
  const permission = await import(toFileUrl(permissionPath));
  const audit = await import(toFileUrl(auditPath));
  return { permission, audit };
}

export const ROLE_ASSIGNMENT_POLICY = {
  owner: {
    assign: 'user-roles',
    revoke: '*',
  },
  admin: {
    assign: 'user-roles',
    revoke: 'user-roles',
  },
} as const;

function isManagementRoleName(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

function isAssignableUserRole(role: string | null | undefined): role is string {
  return typeof role === 'string' && !!role && !isManagementRoleName(role);
}

export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (!isAssignableUserRole(targetRole)) return false;
  return actorRole === 'owner' || actorRole === 'admin';
}

export function canRevokeRole(actorRole: string, targetRole?: string): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole !== 'admin' || !targetRole) return false;
  return isAssignableUserRole(targetRole);
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

interface RoleAssignmentAuthorizationResult {
  allow: boolean;
  status?: number;
  error?: string;
  code?: string;
  reason?: string;
  actorRole?: string;
}

async function authorizeRoleAssignmentWrite(
  modules: { roles: any; resolver: any },
  aid: string,
  auth: RoleWriteAuth,
  operation: 'role.assign' | 'role.revoke',
  targetRole: string | undefined,
  args: Record<string, unknown>,
): Promise<RoleAssignmentAuthorizationResult> {
  const { permission, audit } = await getCommandModules();
  const actorRole = auth.localDirect
    ? 'owner'
    : auth.actorAid
      ? (modules.resolver.resolvePeerRoleDetail({
        selfAid: aid,
        channelType: 'aun',
        chatType: 'private',
        actorId: auth.actorAid,
        conversationId: auth.actorAid,
      }).effectiveRole || 'none')
      : 'none';

  const targetPeerId = typeof args.peerId === 'string' ? args.peerId : undefined;
  if (targetPeerId && modules.resolver.isStaticAgentOwner?.(aid, targetPeerId)) {
    const reason = `Static owner ${targetPeerId} is defined in agents/${aid}/config.json and cannot be changed by relation role assignments`;
    await audit.auditCommandAuthorization({
      ts: Date.now(),
      source: 'ecweb',
      operation,
      scope: 'agent',
      dangerous: false,
      actorId: auth.localDirect ? 'local-direct' : auth.actorAid || undefined,
      selfAid: aid,
      role: actorRole,
      decision: 'deny',
      code: 'IMMUTABLE_STATIC_OWNER',
      reason,
      argsSummary: { ...args, targetRole },
    });
    return {
      allow: false,
      status: 403,
      error: 'forbidden: static owner cannot be changed by relation role assignments',
      code: 'IMMUTABLE_STATIC_OWNER',
      reason,
      actorRole,
    };
  }

  const decision = permission.authorizeCommand({
    intent: {
      operation,
      scope: 'agent',
      source: 'ecweb',
      args: {
        ...args,
        targetRole,
      },
    },
    actorId: auth.localDirect ? 'local-direct' : auth.actorAid || undefined,
    selfAid: aid,
    role: actorRole,
    source: 'ecweb',
  });

  if (!decision.allow) {
    await audit.auditCommandAuthorization({
      ts: Date.now(),
      source: 'ecweb',
      operation,
      scope: 'agent',
      dangerous: false,
      actorId: auth.localDirect ? 'local-direct' : auth.actorAid || undefined,
      selfAid: aid,
      role: actorRole,
      decision: 'deny',
      code: decision.code,
      reason: decision.reason,
      matchedRule: decision.matchedRule,
      argsSummary: { ...args, targetRole },
    });
    return {
      allow: false,
      status: 403,
      error: 'forbidden: role operation not allowed',
      code: decision.code,
      reason: decision.reason,
      actorRole,
    };
  }

  const policyAllowed = operation === 'role.assign'
    ? !!targetRole && canAssignRole(actorRole, targetRole)
    : canRevokeRole(actorRole, targetRole);
  if (!policyAllowed) {
    const reason = operation === 'role.assign'
      ? `Role ${actorRole} cannot assign target role ${targetRole || '(missing)'}`
      : `Role ${actorRole} cannot revoke target role ${targetRole || '(missing)'}`;
    await audit.auditCommandAuthorization({
      ts: Date.now(),
      source: 'ecweb',
      operation,
      scope: 'agent',
      dangerous: false,
      actorId: auth.localDirect ? 'local-direct' : auth.actorAid || undefined,
      selfAid: aid,
      role: actorRole,
      decision: 'deny',
      code: 'NOT_ALLOWED',
      reason,
      matchedRule: decision.matchedRule,
      argsSummary: { ...args, targetRole },
    });
    return {
      allow: false,
      status: 403,
      error: 'forbidden: target role not assignable',
      code: 'NOT_ALLOWED',
      reason,
      actorRole,
    };
  }

  await audit.auditCommandAuthorization({
    ts: Date.now(),
    source: 'ecweb',
    operation,
    scope: 'agent',
    dangerous: false,
    actorId: auth.localDirect ? 'local-direct' : auth.actorAid || undefined,
    selfAid: aid,
    role: actorRole,
    decision: 'allow',
    matchedRule: decision.matchedRule,
    argsSummary: { ...args, targetRole },
  });

  return { allow: true, actorRole };
}

function roleExists(roles: any, aid: string, role: string): boolean {
  if (!isAssignableUserRole(role)) return false;
  if (typeof roles.roleExists === 'function') return !!roles.roleExists(role, aid);
  return !!roles.readRolesConfig(aid).roles?.[role];
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

function sendAuthorizationDenied(res: any, decision: RoleAssignmentAuthorizationResult): void {
  sendJson(res, decision.status ?? 403, {
    error: decision.error || 'forbidden',
    ...(decision.code ? { code: decision.code } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.actorRole ? { actorRole: decision.actorRole } : {}),
  });
}

function assignmentFromPath(urlPath: string): { aid: string; targetId: string } | null {
  const parts = urlPath.split('/').filter(Boolean);
  if (parts.length < 5) return null;
  return {
    aid: decodeURIComponent(parts[3]),
    targetId: decodeURIComponent(parts.slice(4).join('/')),
  };
}

function formatPeerKey(channelType: string, channelId: string): string {
  return `${channelType}#${encodeURIComponent(channelId)}`;
}

function looksLikePeerKey(value: string): boolean {
  return /^[a-z][a-z0-9_-]*#/i.test(value);
}

function parsePeerKey(peerKey: string): { channelType: string; channelId: string } {
  const idx = peerKey.indexOf('#');
  if (idx <= 0) return { channelType: 'aun', channelId: peerKey };
  return {
    channelType: peerKey.slice(0, idx),
    channelId: decodeURIComponent(peerKey.slice(idx + 1)),
  };
}

function relationTargetFromId(raw: string): { peerKey: string; channelId: string } {
  const value = String(raw || '').trim();
  if (!value) throw new Error('target id is required');
  if (looksLikePeerKey(value)) {
    const parsed = parsePeerKey(value);
    return { peerKey: formatPeerKey(parsed.channelType, parsed.channelId), channelId: parsed.channelId };
  }
  return { peerKey: formatPeerKey('aun', value), channelId: value };
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

function readRelationConfig(config: any, aid: string, peerKey: string): any {
  return config.read(config.ConfigTarget.Relation, { self: aid, peerKey }, { cache: true }) || {};
}

function writeRelationConfig(config: any, aid: string, peerKey: string, value: any): void {
  config.write(config.ConfigTarget.Relation, value, { self: aid, peerKey });
}

function explicitAssignment(scope: RoleAssignment['scope'], peerKey: string, role: string | null | undefined, ids: { peerId?: string; groupId?: string }): RoleAssignment | undefined {
  if (!role) return undefined;
  return {
    scope,
    peerKey,
    role,
    ...(ids.peerId ? { peerId: ids.peerId } : {}),
    ...(ids.groupId ? { groupId: ids.groupId } : {}),
    source: 'relation-config',
  };
}

function resolveGroupRoleDetail(modules: { config: any; roles: any }, aid: string, groupId: string): { effectiveRole: string | null; source: string; assignment?: RoleAssignment } {
  const target = relationTargetFromId(groupId);
  const relation = readRelationConfig(modules.config, aid, target.peerKey);
  const assigned = typeof relation.roles?.assigned === 'string' && roleExists(modules.roles, aid, relation.roles.assigned)
    ? relation.roles.assigned
    : null;
  if (assigned) {
    return {
      effectiveRole: assigned,
      source: 'relation-assigned',
      assignment: explicitAssignment('group', target.peerKey, assigned, { groupId: target.channelId }),
    };
  }

  const defaultRole = modules.roles.readRolesConfig(aid).defaultRoles?.group ?? null;
  const effective = defaultRole && roleExists(modules.roles, aid, defaultRole) ? defaultRole : null;
  return { effectiveRole: effective, source: effective ? 'default' : 'none' };
}

function assignmentForDetail(
  detail: any,
  modules: { config: any; roles: any },
  seed: ConversationSeed,
  member?: ConversationMemberSeed,
): RoleAssignment | undefined {
  const role = detail?.effectiveRole;
  if (!role) return undefined;
  if (seed.chatType === 'private' && detail.source === 'relation-assigned') {
    const target = relationTargetFromId(seed.peerId || seed.conversationId);
    return explicitAssignment('private', target.peerKey, role, { peerId: target.channelId });
  }
  const groupId = seed.groupId || seed.conversationId;
  const groupTarget = relationTargetFromId(groupId);
  if (member && detail.source === 'group-member') {
    return explicitAssignment('group-member', groupTarget.peerKey, role, { groupId: groupTarget.channelId, peerId: member.peerId });
  }
  if (member && detail.source === 'private-inherited') {
    const privateTarget = relationTargetFromId(member.peerId);
    return explicitAssignment('private', privateTarget.peerKey, role, { peerId: member.peerId });
  }
  if (member && detail.source === 'group-default') {
    return explicitAssignment('group', groupTarget.peerKey, role, { groupId: groupTarget.channelId });
  }
  void modules;
  return undefined;
}

function withResolvedRoles(seed: ConversationSeed, modules: { config: any; roles: any; resolver: any }): any {
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
      assignment: assignmentForDetail(detail, modules, seed),
    };
  }

  const groupId = seed.groupId || seed.conversationId;
  const groupDetail = resolveGroupRoleDetail(modules, seed.self, groupId);
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
      assignment: assignmentForDetail(detail, modules, seed, member),
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

function listRelationRoleAssignments(config: any, aid: string): RoleAssignment[] {
  const out: RoleAssignment[] = [];
  const relationsDir = path.join(resolvePaths().root, 'agents', aid, 'relations');
  if (!fs.existsSync(relationsDir)) return out;

  for (const entry of fs.readdirSync(relationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const peerKey = entry.name;
    const relation = readRelationConfig(config, aid, peerKey);
    const roles = relation.roles;
    if (!roles || typeof roles !== 'object') continue;

    const parsed = parsePeerKey(peerKey);
    const hasMembers = roles.members && typeof roles.members === 'object' && Object.keys(roles.members).length > 0;
    if (typeof roles.assigned === 'string') {
      out.push({
        scope: hasMembers ? 'group' : 'private',
        peerKey,
        role: roles.assigned,
        ...(hasMembers ? { groupId: parsed.channelId } : { peerId: parsed.channelId }),
        source: 'relation-config',
      });
    }
    if (roles.members && typeof roles.members === 'object') {
      for (const [peerId, role] of Object.entries(roles.members)) {
        if (typeof role !== 'string') continue;
        out.push({
          scope: 'group-member',
          peerKey,
          groupId: parsed.channelId,
          peerId,
          role,
          source: 'relation-config',
        });
      }
    }
  }

  return out;
}

async function buildSnapshot(): Promise<any> {
  const modules = await getParentModules();
  const agents = await getAgentsFromIpc();
  const snapshotAgents: any[] = [];
  const conversations: any[] = [];

  for (const agent of agents) {
    const aid = agent.aid;
    if (!aid) continue;
    const roleConfig = modules.roles.readRolesConfig(aid);
    snapshotAgents.push({
      aid,
      displayName: agent.displayName ?? agent.personalName,
      name: agent.name,
      roles: Object.keys(roleConfig.roles || {}),
      defaultRoles: roleConfig.defaultRoles,
      assignments: listRelationRoleAssignments(modules.config, aid),
    });

    for (const seed of loadConversationSeeds(aid)) {
      conversations.push(withResolvedRoles(seed, modules));
    }
  }

  return { agents: snapshotAgents, conversations };
}

export const relationRolesSource: WatchSource = {
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
        console.error('[relation-roles] polling error:', err);
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

function scopedAssignmentArgs(body: any, fallbackTargetId?: string): ScopedAssignmentTarget {
  const scope = requireScope(body);
  if (scope === 'private') {
    const raw = body.peerKey || body.peerId || fallbackTargetId;
    if (!raw) throw new Error('peerId is required');
    const target = relationTargetFromId(raw);
    return { scope, peerId: target.channelId, peerKey: target.peerKey };
  }
  if (scope === 'group') {
    const raw = body.peerKey || body.groupId || fallbackTargetId;
    if (!raw) throw new Error('groupId is required');
    const target = relationTargetFromId(raw);
    return { scope, groupId: target.channelId, peerKey: target.peerKey };
  }
  const groupRaw = body.groupKey || body.groupPeerKey || body.groupId;
  const peerId = body.peerId || fallbackTargetId;
  if (!groupRaw || !peerId) throw new Error('groupId and peerId are required');
  const target = relationTargetFromId(groupRaw);
  return { scope, groupId: target.channelId, peerId, peerKey: target.peerKey };
}

function pruneEmptyRoles(config: any): any {
  const roles = config.roles;
  if (!roles || typeof roles !== 'object') return config;
  if (roles.members && typeof roles.members === 'object' && Object.keys(roles.members).length === 0) {
    delete roles.members;
  }
  if (!Object.prototype.hasOwnProperty.call(roles, 'assigned') && !roles.members) {
    delete config.roles;
  }
  return config;
}

function setScopedAssignment(configMod: any, aid: string, body: any, fallbackTargetId?: string): RoleAssignment {
  const target = scopedAssignmentArgs(body, fallbackTargetId);
  const role = body.role;
  if (!role) throw new Error('role is required');

  const config = readRelationConfig(configMod, aid, target.peerKey);
  const roles = config.roles && typeof config.roles === 'object' ? { ...config.roles } : {};
  if (target.scope === 'group-member') {
    roles.members = roles.members && typeof roles.members === 'object' ? { ...roles.members } : {};
    roles.members[target.peerId] = role;
  } else {
    roles.assigned = role;
  }
  writeRelationConfig(configMod, aid, target.peerKey, { ...config, roles });

  if (target.scope === 'private') return { scope: 'private', peerId: target.peerId, peerKey: target.peerKey, role, source: 'relation-config' };
  if (target.scope === 'group') return { scope: 'group', groupId: target.groupId, peerKey: target.peerKey, role, source: 'relation-config' };
  return { scope: 'group-member', groupId: target.groupId, peerId: target.peerId, peerKey: target.peerKey, role, source: 'relation-config' };
}

function getScopedAssignment(configMod: any, aid: string, body: any, fallbackTargetId?: string): RoleAssignment | undefined {
  const target = scopedAssignmentArgs(body, fallbackTargetId);
  const config = readRelationConfig(configMod, aid, target.peerKey);
  if (target.scope === 'group-member') {
    const role = config.roles?.members?.[target.peerId];
    return explicitAssignment('group-member', target.peerKey, role, { groupId: target.groupId, peerId: target.peerId });
  }
  const role = config.roles?.assigned;
  if (target.scope === 'private') return explicitAssignment('private', target.peerKey, role, { peerId: target.peerId });
  return explicitAssignment('group', target.peerKey, role, { groupId: target.groupId });
}

function deleteScopedAssignment(configMod: any, aid: string, body: any, fallbackTargetId?: string): boolean {
  const target = scopedAssignmentArgs(body, fallbackTargetId);
  const config = readRelationConfig(configMod, aid, target.peerKey);
  if (!config.roles || typeof config.roles !== 'object') return false;

  const roles = { ...config.roles };
  let deleted = false;
  if (target.scope === 'group-member') {
    const members = roles.members && typeof roles.members === 'object' ? { ...roles.members } : {};
    deleted = Object.prototype.hasOwnProperty.call(members, target.peerId);
    delete members[target.peerId];
    roles.members = members;
  } else {
    deleted = Object.prototype.hasOwnProperty.call(roles, 'assigned');
    delete roles.assigned;
  }

  writeRelationConfig(configMod, aid, target.peerKey, pruneEmptyRoles({ ...config, roles }));
  return deleted;
}

export async function handleRelationRolesApi(req: any, res: any, auth: RoleWriteAuth = {}): Promise<void> {
  try {
    const modules = await getParentModules();
    const { config, roles } = modules;
    const urlPath = (req.url || '').split('?')[0];

    if (req.method === 'GET' && urlPath.startsWith('/api/roles/agent/')) {
      const aid = decodeURIComponent(urlPath.split('/').filter(Boolean).pop() || '');
      if (!aid) return sendJson(res, 400, { error: 'missing aid' });
      return sendJson(res, 200, {
        $schema_version: 1,
        assignments: listRelationRoleAssignments(config, aid),
      });
    }

    if ((req.method === 'POST' || req.method === 'PUT') && urlPath.startsWith('/api/roles/agent/')) {
      const aid = decodeURIComponent(urlPath.split('/').filter(Boolean).pop() || '');
      if (!aid) return sendJson(res, 400, { error: 'missing aid' });

      const body = await parseBody(req);
      if (typeof body.role !== 'string' || !body.role) {
        return sendJson(res, 400, { error: 'role is required' });
      }
      if (!roleExists(roles, aid, body.role)) {
        return sendJson(res, 400, { error: `Unknown user role: ${body.role}` });
      }

      const args = scopedAssignmentArgs(body);
      const authorization = await authorizeRoleAssignmentWrite(
        modules,
        aid,
        auth,
        'role.assign',
        body.role,
        args,
      );
      if (!authorization.allow) return sendAuthorizationDenied(res, authorization);

      const item = setScopedAssignment(config, aid, body);
      return sendJson(res, 200, { ok: true, assignment: item });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err: any) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}

export async function handlePeerRoleApi(req: any, res: any, auth: RoleWriteAuth = {}): Promise<void> {
  try {
    const modules = await getParentModules();
    const { config, roles } = modules;
    const urlPath = (req.url || '').split('?')[0];
    const target = assignmentFromPath(urlPath);
    if (!target) return sendJson(res, 400, { error: 'missing aid or target id' });

    if (req.method === 'DELETE') {
      const body = await parseBody(req);
      const args = scopedAssignmentArgs(body, target.targetId);
      const existing = getScopedAssignment(config, target.aid, body, target.targetId);
      const authorization = await authorizeRoleAssignmentWrite(
        modules,
        target.aid,
        auth,
        'role.revoke',
        existing?.role,
        args,
      );
      if (!authorization.allow) return sendAuthorizationDenied(res, authorization);

      const deleted = deleteScopedAssignment(config, target.aid, body, target.targetId);
      return sendJson(res, 200, { ok: true, deleted });
    }
    if (req.method === 'PUT') {
      const body = await parseBody(req);
      if (typeof body.role !== 'string' || !body.role) {
        return sendJson(res, 400, { error: 'role is required' });
      }
      if (!roleExists(roles, target.aid, body.role)) {
        return sendJson(res, 400, { error: `Unknown user role: ${body.role}` });
      }

      const args = scopedAssignmentArgs(body, target.targetId);
      const authorization = await authorizeRoleAssignmentWrite(
        modules,
        target.aid,
        auth,
        'role.assign',
        body.role,
        args,
      );
      if (!authorization.allow) return sendAuthorizationDenied(res, authorization);

      const item = setScopedAssignment(config, target.aid, body, target.targetId);
      return sendJson(res, 200, { ok: true, assignment: item });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err: any) {
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
}
