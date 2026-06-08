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

export interface EvolclawAunConfig {
  encryptionSeed?: string | null;  // null 原样保留（迁移自旧 config.json）
}

export interface EvolclawConfig {
  $schema_version?: number;
  aid?: string;
  owners?: string[];          // 进程级控制面鉴权名单（AID）：谁能远程管理本 daemon（/agent /system）
  debug?: DebugBlock;
  tunnel?: TunnelConfig;
  aun?: EvolclawAunConfig;   // 从旧 config.json 迁入
  ecweb?: {
    enabled?: boolean;        // true = evolclaw start 时自动后台启动 ecweb
    port?: number;            // 监听端口，默认 42705
  };
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
