/**
 * Channel 配置归一化工具——给 ChannelLoader 时代的 channel adapter 用。
 *
 * 旧结构里 `Config.channels.<type>` 可以是 single object 或 array；这些工具
 * 用来抹平这种差异。新结构（agents/<aid>/config.json）的 channels 已经统一为
 * 列表形态，这些工具仍被 ChannelLoader 调用方使用——index.ts 把新结构翻成旧
 * dict 形态喂给 ChannelLoader，所以 normalizeChannelInstances 仍然有用武之地。
 *
 * 当 ChannelLoader 重写为直接吃 ChannelInstance[] 后，本文件可删。
 */

import type { Config } from '../types.js';

export const channelTypes = ['feishu', 'wechat', 'aun', 'dingtalk', 'qqbot', 'wecom'] as const;

/**
 * 把 channel 配置（单对象 / 数组 / undefined）归一为带 name 的数组。
 */
export function normalizeChannelInstances<T extends { name?: string }>(
  cfg: T | T[] | undefined,
  defaultName: string,
): (T & { name: string })[] {
  if (cfg === undefined || cfg === null) return [];
  if (Array.isArray(cfg)) {
    return cfg.map((item, i) => ({
      ...item,
      name: item.name ?? (cfg.length === 1 ? defaultName : `${defaultName}-${i + 1}`),
    })) as (T & { name: string })[];
  }
  return [{ ...cfg, name: cfg.name ?? defaultName } as T & { name: string }];
}

type ShowActivitiesMode = 'all' | 'dm-only' | 'owner-dm-only' | 'none';

/**
 * 从 globalConfig.channels 字典里按实例名找 showActivities，找不到回退到全局。
 */
export function getChannelShowActivities(config: Config, instanceName: string): ShowActivitiesMode {
  for (const type of channelTypes) {
    const raw = (config.channels as any)?.[type];
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      const inst = raw.find((item: any) => item.name === instanceName);
      if (inst) return inst.showActivities ?? config.showActivities ?? 'all';
    } else {
      const effectiveName = raw.name ?? type;
      if (effectiveName === instanceName) return raw.showActivities ?? config.showActivities ?? 'all';
    }
  }
  return config.showActivities ?? 'all';
}
