import fs from 'fs';
import { resolvePaths } from './paths.js';
import { atomicReadJson, atomicWriteJson } from './utils/atomic-write.js';
import { logger } from './utils/logger.js';

export interface ProcessConfig {
  $schema_version?: number;
  log?: {
    level?: string;
    retention_hours?: number;
    message_log?: boolean;
    event_log?: boolean;
  };
  aun?: {
    gateway?: string;
    keystorePath?: string;
    encryptionSeed?: string;
  };
}

export function loadProcessConfig(): ProcessConfig {
  const configPath = resolvePaths().processConfig;
  const raw = atomicReadJson<ProcessConfig>(configPath);
  if (raw === null) return {};
  return expandEnvRefs(raw);
}

export function saveProcessConfig(config: ProcessConfig): void {
  atomicWriteJson(resolvePaths().processConfig, config);
}

function expandEnvRefs<T>(value: T): T {
  return walk(value) as T;
}

function walk(v: any): any {
  if (typeof v === 'string') {
    if (v.startsWith('$ENV:')) {
      const name = v.slice(5);
      return process.env[name] ?? '';
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) out[k] = walk(val);
    return out;
  }
  return v;
}
