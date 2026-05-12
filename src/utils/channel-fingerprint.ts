/**
 * Channel Fingerprint
 *
 * 为每个 channel 实例提取一个全局唯一标识，用于冲突检测和路由索引。
 * 格式：{type}:{primaryKey}
 */

import type { Config } from '../types.js';

/** Channel 类型 → 主键字段映射 */
const PRIMARY_KEY_MAP: Record<string, string> = {
  feishu: 'appId',
  aun: 'aid',
  wechat: 'token',
  wecom: 'botId',
  dingtalk: 'clientId',
  qqbot: 'appId',
};

export function extractFingerprint(
  channelType: string,
  instance: Record<string, any>
): string | null {
  const keyField = PRIMARY_KEY_MAP[channelType];
  if (!keyField) return null;
  const value = instance[keyField];
  if (!value || typeof value !== 'string') return null;
  return `${channelType}:${value}`;
}

export interface DuplicateReport {
  fingerprint: string;
  channelType: string;
  instances: string[]; // instance names
}

export function detectDuplicates(config: Config): DuplicateReport[] {
  const seen = new Map<string, { channelType: string; instances: string[] }>();

  const channels = (config.channels as any) || {};
  for (const [type, raw] of Object.entries(channels)) {
    if (type === 'defaultChannel') continue;
    const instances = Array.isArray(raw) ? raw : [raw];
    for (const inst of instances) {
      if (!inst || typeof inst !== 'object') continue;
      const fingerprint = extractFingerprint(type, inst as any);
      if (!fingerprint) continue;
      const instName = (inst as any).name ?? type;
      const entry = seen.get(fingerprint);
      if (entry) {
        entry.instances.push(instName);
      } else {
        seen.set(fingerprint, { channelType: type, instances: [instName] });
      }
    }
  }

  const duplicates: DuplicateReport[] = [];
  for (const [fingerprint, entry] of seen) {
    if (entry.instances.length > 1) {
      duplicates.push({
        fingerprint,
        channelType: entry.channelType,
        instances: entry.instances,
      });
    }
  }
  return duplicates;
}
