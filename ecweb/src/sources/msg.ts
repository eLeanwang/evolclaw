/**
 * 消息数据源：扫描 data/sessions 下所有渠道的 messages.jsonl。
 *
 * 左列按 agent 聚合；中列列出该 agent 下所有渠道的私聊/群聊会话。
 * 兼容旧参数名 aid/peer：前端的 aid 实际上传 scope id。
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import { resolveParentDistModule, toFileUrl } from './parent-package.js';
import {
  isTransientProtocolMessage,
  readAllJsonlLines,
  readJsonFile,
} from '../fs-utils.js';
import type { MessageLogEntry } from '../fs-utils.js';
import type { WatchSource } from './types.js';

type ChatRecord = {
  id: string;
  dirPath: string;
  channelType: string;
  channel: string;
  channelId: string;
  selfAID: string;
  chatType: string;
  peerId: string;
  peerName: string | null;
  groupId: string | null;
  groupName: string | null;
  updatedAt: number;
  messages: MessageLogEntry[];
  active: Record<string, any>;
};

type ScopeInfo = {
  id: string;
  aid: string; // 兼容旧前端字段
  selfAID: string;
  totalIn: number;
  totalOut: number;
  peerCount: number;
  groupCount: number;
  channelCount: number;
  channelTypes: string[];
  channels: string[];
  lastAt: number;
};

type PeerInfo = {
  id: string;
  peerId: string; // 兼容旧前端字段
  peerName: string | null;
  channel: string;
  channelType: string;
  channelName: string | null;
  chatType: string;
  groupId: string | null;
  groupName: string | null;
  inbound: number;
  outbound: number;
  lastAt: number;
};

type ChannelKeyParts = {
  type: string;
  selfAID: string;
  name: string;
};

type ChatIdentity = {
  channelType: string;
  channel: string;
  channelId: string;
  selfAID: string;
};

type SessionContext = {
  sessionId: string | null;
  evolclawSessionId: string | null;
  name: string | null;
  baseagent: string | null;
  chatMode: string | null;
  permissionMode: string | null;
  role: string | null;
  turns: number;
  status: 'processing' | 'idle';
  updatedAt: number;
};

let contextModulesPromise: Promise<{ resolver: any; modelScope: any }> | null = null;
const sessionAdapterPromises = new Map<string, Promise<any | null>>();

function getContextModules(): Promise<{ resolver: any; modelScope: any }> {
  if (!contextModulesPromise) {
    contextModulesPromise = Promise.all([
      import(toFileUrl(resolveParentDistModule('config', 'peer-role-resolver.js'))),
      import(toFileUrl(resolveParentDistModule('core', 'model', 'config-scope.js'))),
    ]).then(([resolver, modelScope]) => ({ resolver, modelScope }));
  }
  return contextModulesPromise;
}

function getSessionAdapter(baseagent: string): Promise<any | null> {
  if (!sessionAdapterPromises.has(baseagent)) {
    const classNames: Record<string, string> = {
      claude: 'ClaudeSessionFileAdapter',
      codex: 'CodexSessionFileAdapter',
      gemini: 'GeminiSessionFileAdapter',
    };
    const className = classNames[baseagent];
    const promise = !className
      ? Promise.resolve(null)
      : Promise.resolve()
        .then(() => import(toFileUrl(resolveParentDistModule('core', 'session', 'adapters', `${baseagent}-session-file-adapter.js`))))
        .then(mod => mod[className] ? new mod[className]() : null)
        .catch(() => null);
    sessionAdapterPromises.set(baseagent, promise);
  }
  return sessionAdapterPromises.get(baseagent)!;
}

function safeId(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function findMessageFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name === 'messages.jsonl') out.push(full);
    }
  };
  visit(root);
  return out;
}

function listConfiguredAgentAids(root: string): Set<string> {
  const agentsDir = path.join(root, 'agents');
  const aids = new Set<string>();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return aids; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const config = readJsonFile<any>(path.join(agentsDir, entry.name, 'config.json'));
    const aid = typeof config?.aid === 'string' ? config.aid : entry.name;
    if (looksLikeAID(aid)) aids.add(aid);
  }
  return aids;
}

function decodeDirSegment(seg: string): string {
  return seg.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseChannelKey(value: any): ChannelKeyParts | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('#');
  if (parts.length !== 3) return null;
  const [type, selfAID, name] = parts;
  if (!type || !selfAID || !name) return null;
  return { type, selfAID, name };
}

function looksLikeAID(value: string | undefined): value is string {
  return !!value && value !== 'self' && value !== '_unknown' && /^[^./#\s]+\.[^/#\s]+/.test(value);
}

function parseLegacySessionKey(value: any, channelType: string): ChannelKeyParts | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('#');
  if (parts.length < 3 || parts[0] !== channelType) return null;
  if (!looksLikeAID(parts[1])) return null;
  return { type: parts[0], selfAID: parts[1], name: parts[2] || 'main' };
}

function pathIdentity(sessionsDir: string, dirPath: string): Partial<ChatIdentity> {
  const relParts = path.relative(sessionsDir, dirPath).split(path.sep).filter(Boolean);
  if (!relParts.length) return {};

  const firstKey = parseChannelKey(decodeDirSegment(relParts[0]));
  if (firstKey) {
    return {
      channelType: firstKey.type,
      channel: `${firstKey.type}#${firstKey.selfAID}#${firstKey.name}`,
      channelId: relParts[1] ? decodeDirSegment(relParts[1]) : undefined,
      selfAID: firstKey.selfAID,
    };
  }

  if (relParts[0] === 'aun' && relParts.length >= 3) {
    const selfAID = decodeDirSegment(relParts[1]);
    return {
      channelType: 'aun',
      channel: looksLikeAID(selfAID) ? `aun#${selfAID}#main` : undefined,
      channelId: decodeDirSegment(relParts[2]),
      selfAID: looksLikeAID(selfAID) ? selfAID : undefined,
    };
  }

  return {
    channelType: decodeDirSegment(relParts[0]),
    channelId: relParts[1] ? decodeDirSegment(relParts[1]) : undefined,
  };
}

function inferSelfAID(active: any, messages: MessageLogEntry[], hints: Partial<ChatIdentity>): string {
  if (looksLikeAID(active?.selfAID)) return String(active.selfAID);
  if (looksLikeAID(hints.selfAID)) return hints.selfAID;
  const channelKey = parseChannelKey(active?.channel) || parseChannelKey(active?.channelType);
  if (channelKey) return channelKey.selfAID;
  const sessionKey = parseLegacySessionKey(active?.sessionKey, hints.channelType || active?.channelType || '');
  if (sessionKey) return sessionKey.selfAID;
  const out = messages.find(m => m.dir === 'out' && m.from && m.from !== 'self');
  if (out?.from) return String(out.from);
  const inboundTo = messages.find(m => m.dir === 'in' && m.to && m.to !== 'self');
  if (inboundTo?.to) return String(inboundTo.to);
  return 'unknown';
}

function normalizeChatIdentity(sessionsDir: string, dirPath: string, active: any, messages: MessageLogEntry[]): ChatIdentity {
  const pathHints = pathIdentity(sessionsDir, dirPath);
  const activeChannelKey = parseChannelKey(active?.channel);
  const activeTypeKey = parseChannelKey(active?.channelType);
  const msgChannelType = messages.find(m => (m as any).channelType)?.channelType;
  const rawType = String(
    activeChannelKey?.type
    || activeTypeKey?.type
    || active?.channelType
    || msgChannelType
    || pathHints.channelType
    || 'unknown',
  );
  const channelType = parseChannelKey(rawType)?.type || rawType;
  const selfAID = inferSelfAID(active, messages, { ...pathHints, channelType });
  const rawChannel = typeof active?.channel === 'string' && active.channel
    ? active.channel
    : pathHints.channel || `${channelType}#${selfAID}#main`;
  const channelKey = parseChannelKey(rawChannel);
  const channel = channelKey
    ? `${channelKey.type}#${channelKey.selfAID}#${channelKey.name}`
    : (selfAID !== 'unknown' ? `${channelType}#${selfAID}#main` : rawChannel);
  const channelId = String(active.channelId || pathHints.channelId || path.basename(dirPath));

  return { channelType, channel, channelId, selfAID };
}

function chatDisplayId(active: any, messages: MessageLogEntry[]): { peerId: string; peerName: string | null; groupId: string | null; groupName: string | null } {
  const metadata = active?.metadata ?? {};
  const chatType = active?.chatType || messages.find(m => m.chatType)?.chatType || 'private';
  const groupId = chatType === 'group'
    ? String(metadata.groupId || active?.channelId || messages.find(m => m.groupId)?.groupId || '')
    : null;
  const groupName = chatType === 'group' && metadata.groupName ? String(metadata.groupName) : null;
  if (chatType === 'group') {
    return {
      peerId: groupId || String(active?.channelId || 'group'),
      peerName: groupName,
      groupId,
      groupName,
    };
  }
  const peerId = String(metadata.peerId || active?.channelId || messages.find(m => m.dir === 'in')?.from || messages.find(m => m.dir === 'out')?.to || 'unknown');
  return {
    peerId,
    peerName: metadata.peerName ? String(metadata.peerName) : null,
    groupId: null,
    groupName: null,
  };
}

function loadChats(): ChatRecord[] {
  const paths = resolvePaths();
  const sessionsDir = paths.sessionsDir;
  const configuredAids = listConfiguredAgentAids(paths.root);
  const files = findMessageFiles(sessionsDir);
  const chats: ChatRecord[] = [];
  for (const file of files) {
    const dirPath = path.dirname(file);
    const active = readJsonFile<any>(path.join(dirPath, 'active.json')) ?? {};
    const messages = readAllJsonlLines<MessageLogEntry>(file)
      .filter(m => !isTransientProtocolMessage(m));
    if (!messages.length) continue;
    const identity = normalizeChatIdentity(sessionsDir, dirPath, active, messages);
    const { channelType, channel, channelId, selfAID } = identity;
    if (configuredAids.size && !configuredAids.has(selfAID)) continue;
    const chatType = String(active.chatType || messages.find(m => m.chatType)?.chatType || 'private');
    const display = chatDisplayId({ ...active, chatType, channelId }, messages);
    const lastMsgAt = messages.reduce((max, m) => Math.max(max, m.ts || 0), 0);
    const updatedAt = Math.max(Number(active.updatedAt || 0), lastMsgAt);
    chats.push({
      id: safeId(`${selfAID}\n${channelType}\n${channelId}\n${chatType}`),
      dirPath,
      channelType,
      channel,
      channelId,
      selfAID,
      chatType,
      peerId: display.peerId,
      peerName: display.peerName,
      groupId: display.groupId,
      groupName: display.groupName,
      updatedAt,
      messages,
      active,
    });
  }
  return chats;
}

function scopeId(chat: Pick<ChatRecord, 'selfAID'>): string {
  return safeId(chat.selfAID);
}

function legacyChannelScopeId(chat: Pick<ChatRecord, 'selfAID' | 'channelType' | 'channel'>): string {
  return safeId(`${chat.selfAID}\n${chat.channelType}\n${chat.channel}`);
}

function buildScopes(chats: ChatRecord[]): ScopeInfo[] {
  const map = new Map<string, ScopeInfo>();
  const seenChats = new Map<string, Set<string>>();
  const seenChannels = new Map<string, Set<string>>();
  const seenChannelTypes = new Map<string, Set<string>>();
  for (const chat of chats) {
    const id = scopeId(chat);
    let scope = map.get(id);
    if (!scope) {
      scope = {
        id,
        aid: id,
        selfAID: chat.selfAID,
        totalIn: 0,
        totalOut: 0,
        peerCount: 0,
        groupCount: 0,
        channelCount: 0,
        channelTypes: [],
        channels: [],
        lastAt: 0,
      };
      map.set(id, scope);
      seenChats.set(id, new Set());
      seenChannels.set(id, new Set());
      seenChannelTypes.set(id, new Set());
    }
    const channelSeen = seenChannels.get(id)!;
    if (!channelSeen.has(chat.channel)) {
      channelSeen.add(chat.channel);
      scope.channels.push(chat.channel);
      scope.channelCount = channelSeen.size;
    }
    const typeSeen = seenChannelTypes.get(id)!;
    if (!typeSeen.has(chat.channelType)) {
      typeSeen.add(chat.channelType);
      scope.channelTypes.push(chat.channelType);
      scope.channelTypes.sort();
    }
    let hasIn = false;
    let hasOut = false;
    for (const msg of chat.messages) {
      if (msg.dir === 'in') { scope.totalIn++; hasIn = true; }
      else if (msg.dir === 'out') { scope.totalOut++; hasOut = true; }
      if (msg.ts > scope.lastAt) scope.lastAt = msg.ts;
    }
    if (hasIn || hasOut) {
      const chatKey = `${chat.channel}\n${chat.channelId}\n${chat.chatType}`;
      const seen = seenChats.get(id)!;
      if (!seen.has(chatKey)) {
        seen.add(chatKey);
        scope.peerCount++;
        if (chat.chatType === 'group') scope.groupCount++;
      }
    }
    if (chat.updatedAt > scope.lastAt) scope.lastAt = chat.updatedAt;
  }
  return Array.from(map.values())
    .sort((a, b) => b.lastAt - a.lastAt);
}

function channelName(channel: string): string | null {
  return parseChannelKey(channel)?.name ?? null;
}

function chatKey(chat: Pick<ChatRecord, 'channelType' | 'channel' | 'channelId' | 'chatType'>): string {
  return safeId(`${chat.channelType}\n${chat.channel}\n${chat.channelId}\n${chat.chatType}`);
}

function mergePeerInfo(chats: ChatRecord[]): PeerInfo[] {
  const map = new Map<string, PeerInfo>();
  for (const chat of chats) {
    const key = chatKey(chat);
    let peer = map.get(key);
    if (!peer) {
      peer = {
        id: key,
        peerId: key,
        peerName: chat.chatType === 'group' ? (chat.groupName || chat.groupId || chat.channelId) : (chat.peerName || chat.peerId),
        channel: chat.channel,
        channelType: chat.channelType,
        channelName: channelName(chat.channel),
        chatType: chat.chatType,
        groupId: chat.groupId,
        groupName: chat.groupName,
        inbound: 0,
        outbound: 0,
        lastAt: 0,
      };
      map.set(key, peer);
    }
    for (const msg of chat.messages) {
      if (msg.dir === 'in') peer.inbound++;
      else if (msg.dir === 'out') peer.outbound++;
      if (msg.ts > peer.lastAt) peer.lastAt = msg.ts;
    }
    if (chat.updatedAt > peer.lastAt) peer.lastAt = chat.updatedAt;
  }
  return Array.from(map.values()).sort((a, b) => b.lastAt - a.lastAt);
}

function selectedChats(chats: ChatRecord[], scope: string | null): ChatRecord[] {
  if (!scope) return [];
  return chats.filter(chat => scopeId(chat) === scope);
}

function messagesFor(chats: ChatRecord[], peer: string | null): MessageLogEntry[] {
  const selected = peer
    ? chats.filter(chat => chatKey(chat) === peer)
    : chats;
  const messages = selected.flatMap(chat => chat.messages.map(msg => ({
    ...msg,
    channel: chat.channel,
    channelType: chat.channelType,
    selfAID: chat.selfAID,
    peerName: chat.peerName,
    groupName: chat.groupName,
  } as MessageLogEntry & Record<string, any>)));
  messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return messages.length > 1000 ? messages.slice(-1000) : messages;
}

function latestInbound(chat: ChatRecord): MessageLogEntry | undefined {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    if (chat.messages[i].dir === 'in') return chat.messages[i];
  }
  return undefined;
}

async function sessionTurns(active: Record<string, any>, messages: MessageLogEntry[]): Promise<number> {
  const baseagent = String(active.baseagent || active.agentType || '').toLowerCase();
  const agentSessionId = typeof active.agentSessionId === 'string' ? active.agentSessionId : '';
  const projectPath = typeof active.projectPath === 'string' ? active.projectPath : '';
  if (baseagent && agentSessionId && projectPath) {
    try {
      const adapter = await getSessionAdapter(baseagent);
      const turns = Number(adapter?.getFileInfo(projectPath, agentSessionId)?.turns);
      if (Number.isFinite(turns) && turns > 0) return turns;
    } catch {}
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const turns = Number(messages[i].numTurns);
    if (Number.isFinite(turns) && turns >= 0) return turns;
  }
  return 0;
}

async function buildSessionContext(chat: ChatRecord | undefined): Promise<SessionContext | null> {
  if (!chat) return null;
  const active = chat.active || {};
  const inbound = latestInbound(chat);
  const actorId = String(
    inbound?.from
    || active.metadata?.peerId
    || chat.peerId
    || chat.channelId
    || '',
  );
  const conversationId = String(chat.groupId || chat.channelId || chat.peerId || '');
  let role = inbound?.permMode || null;
  let permissionMode = active.permissionMode || null;
  const peerKey = `${chat.channelType}#${encodeURIComponent(conversationId)}`;
  try {
    const { resolver, modelScope } = await getContextModules();
    const detail = resolver.resolvePeerRoleDetail({
      selfAid: chat.selfAID,
      channelType: chat.channelType,
      chatType: chat.chatType === 'group' ? 'group' : 'private',
      actorId,
      conversationId,
      peerType: inbound?.peerType || active.metadata?.peerType,
    });
    role = detail.effectiveRole || 'none';
    permissionMode = modelScope.resolvePermissionMode({ self: chat.selfAID, peerKey, role });
  } catch {}

  return {
    sessionId: active.agentSessionId || active.id || null,
    evolclawSessionId: active.id || null,
    name: active.name || null,
    baseagent: active.baseagent || active.agentType || null,
    chatMode: active.chatMode || inbound?.chatmode || null,
    permissionMode,
    role,
    turns: await sessionTurns(active, chat.messages),
    status: active.activeTask ? 'processing' : 'idle',
    updatedAt: Number(active.updatedAt || chat.updatedAt || 0),
  };
}

async function buildSnapshot(params: Record<string, any>): Promise<any> {
  const chats = loadChats();
  const scopes = buildScopes(chats);
  const requestedScope = params.scope || params.aid || null;
  const scope = requestedScope && !scopes.some(s => s.id === requestedScope)
    ? (chats.find(chat => legacyChannelScopeId(chat) === requestedScope)
      ? scopeId(chats.find(chat => legacyChannelScopeId(chat) === requestedScope)!)
      : requestedScope)
    : requestedScope;
  const peer = params.peer || null;
  const inScope = selectedChats(chats, scope);
  const peers = scope ? mergePeerInfo(inScope) : [];
  const messages = scope ? messagesFor(inScope, peer) : [];
  const currentChat = peer ? inScope.find(chat => chatKey(chat) === peer) : undefined;
  const sessionContext = await buildSessionContext(currentChat);

  return {
    scopes,
    aids: scopes,
    peers,
    messages,
    scope,
    aid: scope,
    peer,
    sessionContext,
  };
}

export const msgSource: WatchSource = {
  kind: 'msg',

  async snapshot(params: Record<string, any> = {}): Promise<any> {
    return await buildSnapshot(params);
  },

  subscribe(params: Record<string, any>, push: (data: any) => void): () => void {
    const sessionsDir = resolvePaths().sessionsDir;
    let watcher: fs.FSWatcher | null = null;
    let debounce: NodeJS.Timeout | null = null;

    const fire = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        try { push(await buildSnapshot(params)); } catch { /* ignore */ }
      }, 150);
    };

    try {
      watcher = fs.watch(sessionsDir, { recursive: true }, (_evt, filename) => {
        const name = String(filename || '');
        if (name.endsWith('messages.jsonl') || name.endsWith('active.json')) fire();
      });
    } catch { /* sessionsDir may not exist yet */ }

    return () => {
      if (watcher) watcher.close();
      if (debounce) clearTimeout(debounce);
    };
  },
};
