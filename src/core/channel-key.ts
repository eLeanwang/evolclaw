/**
 * Channel key 编码：`<aid>#<type>#<name>`
 *
 * `#` 不在 AID 合法字符集（多级域名）内，因此天然能跟 AID 段无歧义切分。
 * 所有 channel 类型（含 AUN）统一三段；AUN 通常约定 name="main"。
 */

export interface ChannelKey {
  aid: string;
  type: string;
  name: string;
}

const SEP = '#';

export function formatChannelKey(k: ChannelKey): string {
  return `${k.aid}${SEP}${k.type}${SEP}${k.name}`;
}

export function parseChannelKey(key: string): ChannelKey {
  const parts = key.split(SEP);
  if (parts.length !== 3) {
    throw new Error(`Invalid channel key (expected 3 segments separated by '#'): ${key}`);
  }
  const [aid, type, name] = parts;
  if (!aid || !type || !name) {
    throw new Error(`Invalid channel key (empty segment): ${key}`);
  }
  return { aid, type, name };
}

export function tryParseChannelKey(key: string): ChannelKey | null {
  try { return parseChannelKey(key); } catch { return null; }
}

/**
 * config.json 里 channels[].name 字段的合法性：
 *   - 非空
 *   - 不含 '#'（会破坏 channel key 编码）
 */
export function isValidChannelName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && !name.includes(SEP);
}
