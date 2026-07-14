import { loadSchema } from '../../config/schema-registry.js';

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
  // 运行时硬约束（非配置项）：system/service 对端始终同步交互
  if (kind === 'system' || kind === 'service') return 'interactive';
  const field = chatmodeFieldForPeer(params.chatType, params.peerType);
  return params.configured?.[field] ?? chatmodeFactoryDefaults()[field];
}

let _factoryChatmode: Required<ChatmodeDefaults> | null = null;

/**
 * chatMode 出厂默认表 —— 唯一来源是 agent-config schema 的 chatmode.default
 * （配置数据，非代码分支）。agent 级配置改默认表、关系级按键覆盖，均经
 * ConfigManager 合并后以 `configured` 传入；此表仅在配置链完全未设值时兜底。
 */
export function chatmodeFactoryDefaults(): Required<ChatmodeDefaults> {
  if (!_factoryChatmode) {
    const d = loadSchema('agent-config').fields.get('chatmode')?.default as Required<ChatmodeDefaults> | undefined;
    if (!d?.private || !d?.group || !d?.nothuman) {
      throw new Error('[peer-mode] agent-config schema 缺少 chatmode 出厂默认表（default.private/group/nothuman）');
    }
    _factoryChatmode = d;
  }
  return _factoryChatmode;
}

export function chatmodeFieldForPeer(chatType?: string | null, peerType?: unknown): ChatmodeField {
  const kind = normalizePeerType(peerType);
  if (kind === 'system' || kind === 'service') return 'private';
  if (chatType === 'group' || kind === 'group') return 'group';
  if (kind === 'agent' || kind === 'unknown') return 'nothuman';
  return 'private';
}
