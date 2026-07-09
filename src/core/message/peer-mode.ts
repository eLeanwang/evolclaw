export type PeerKind = 'human' | 'agent' | 'group' | 'system' | 'service' | 'unknown';
export type ChatMode = 'interactive' | 'proactive';
export type ChatmodeField = 'private' | 'group' | 'nothuman';

export interface ChatmodeDefaults {
  private?: ChatMode;
  group?: ChatMode;
  nothuman?: ChatMode;
}

export function normalizePeerType(value: unknown): PeerKind | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  if (key === 'human' || key === 'person' || key === 'user') return 'human';
  if (key === 'group' || key === 'room' || key === 'venue') return 'group';
  if (key === 'system' || key === 'trigger' || key === 'scheduler') return 'system';
  if (key === 'service' || key === 'daemon' || key === 'tool') return 'service';
  if (key === 'unknown') return 'unknown';
  return 'agent';
}

export function isSystemOrServicePeer(peerType: unknown): boolean {
  const kind = normalizePeerType(peerType);
  return kind === 'system' || kind === 'service';
}

export function resolveChatModeForPeer(params: {
  chatType?: string | null;
  peerType?: unknown;
  configured?: ChatmodeDefaults | null;
}): ChatMode {
  const kind = normalizePeerType(params.peerType);
  if (kind === 'system' || kind === 'service') return 'interactive';
  if (params.chatType === 'group' || kind === 'group') return 'proactive';
  if (kind === 'agent' || kind === 'unknown') return params.configured?.nothuman ?? 'proactive';
  return params.configured?.private ?? 'interactive';
}

export function chatmodeFieldForPeer(chatType?: string | null, peerType?: unknown): ChatmodeField {
  const kind = normalizePeerType(peerType);
  if (kind === 'system' || kind === 'service') return 'private';
  if (chatType === 'group' || kind === 'group') return 'group';
  if (kind === 'agent' || kind === 'unknown') return 'nothuman';
  return 'private';
}
