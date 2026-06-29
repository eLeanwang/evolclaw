/**
 * 消息数据源：扫描 data/sessions 下所有渠道的 messages.jsonl。
 *
 * 左列按 agent 聚合；中列列出该 agent 下所有渠道的私聊/群聊会话。
 * 兼容旧参数名 aid/peer：前端的 aid 实际上传 scope id。
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';
import {
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
    const messages = readAllJsonlLines<MessageLogEntry>(file);
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

function buildSnapshot(params: Record<string, any>): any {
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

  return {
    scopes,
    aids: scopes,
    peers,
    messages,
    scope,
    aid: scope,
    peer,
  };
}

export const msgSource: WatchSource = {
  kind: 'msg',

  async snapshot(params: Record<string, any> = {}): Promise<any> {
    return buildSnapshot(params);
  },

  subscribe(params: Record<string, any>, push: (data: any) => void): () => void {
    const sessionsDir = resolvePaths().sessionsDir;
    let watcher: fs.FSWatcher | null = null;
    let debounce: NodeJS.Timeout | null = null;

    const fire = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try { push(buildSnapshot(params)); } catch { /* ignore */ }
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
