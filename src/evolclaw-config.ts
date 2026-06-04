import { resolvePaths } from './paths.js';
import { atomicReadJson, atomicWriteJson } from './utils/atomic-write.js';
import type { DebugBlock } from './types.js';

export interface TunnelTarget {
  name: string;
  port: number;
  pathPrefix?: string;
}

export interface TunnelConfig {
  targets: TunnelTarget[];
}

export interface EvolclawConfig {
  $schema_version?: number;
  aid?: string;
  debug?: DebugBlock;
  tunnel?: TunnelConfig;
  // 注：`aun?: EvolclawAunConfig` 块由 Task 1.5 加入（吞并 config.json）
}

/** 读 {root}/evolclaw.json。文件不存在返回 {}，不报错。 */
export function loadEvolclawConfig(): EvolclawConfig {
  const raw = atomicReadJson<EvolclawConfig>(resolvePaths().evolclawJson);
  return raw ?? {};
}

/** 原子写入 {root}/evolclaw.json。调用方负责传完整对象（含要保留的字段）。 */
export function saveEvolclawConfig(value: EvolclawConfig): void {
  atomicWriteJson(resolvePaths().evolclawJson, value);
}
