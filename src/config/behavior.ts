import fs from 'fs';
import path from 'path';
import { agentBehaviorConfig, agentRelationBehaviorConfig, agentRelationsDir } from '../paths.js';
import { atomicReadJson, atomicWriteJson } from '../utils/atomic-write.js';
import { fileCache } from '../core/daemon-file-cache.js';
import { loadSchema, currentVersion } from './schema-registry.js';
import { mergeLayers } from './merge.js';
import { readRolesConfig } from './roles.js';
import { normalizeRelationBehaviorForAssignedRole } from './role-model-sync.js';
import type { AgentConfig, EffectiveAgentConfig, RelationConfig } from '../types.js';

export type BehaviorConfig = Partial<Pick<
  EffectiveAgentConfig,
  | 'active_baseagent'
  | 'baseagents'
  | 'chatmode'
  | 'flush_delay'
  | 'debounce'
  | 'dispatch'
  | 'show_activities'
  | 'proactive'
  | 'group_venue_sync'
  | 'render'
  | 'enable_rich_content'
  | 'permissionMode'
  | 'roles'
>> & {
  $schema_version?: number;
};

export interface BehaviorReadOpts {
  cache?: boolean;
}

export function readAgentBehavior(aid: string, opts: BehaviorReadOpts = {}): BehaviorConfig | null {
  return readBehaviorFile(agentBehaviorConfig(aid), opts, `behavior:${aid}`);
}

export function writeAgentBehavior(aid: string, value: BehaviorConfig): void {
  writeBehaviorFile(agentBehaviorConfig(aid), value);
}

export function readRelationBehavior(aid: string, peerKey: string, opts: BehaviorReadOpts = {}): BehaviorConfig | null {
  return readBehaviorFile(agentRelationBehaviorConfig(aid, peerKey), opts, 'relation-prefs');
}

export function writeRelationBehavior(aid: string, peerKey: string, value: BehaviorConfig): void {
  const normalized = normalizeRelationBehaviorForAssignedRole(aid, peerKey, value, readRolesConfig());
  writeBehaviorFile(agentRelationBehaviorConfig(aid, peerKey), normalized);
}

export function ensureAgentBehavior(aid: string): void {
  ensureBehaviorFile(agentBehaviorConfig(aid));
}

export function ensureRelationBehavior(aid: string, peerKey: string): void {
  ensureBehaviorFile(agentRelationBehaviorConfig(aid, peerKey));
}

export function resolveBehavior(
  sel: { self?: string; peerKey?: string; role?: string },
  opts: BehaviorReadOpts = {},
): BehaviorConfig {
  if (!sel.self) return {};
  const schema = loadSchema('behavior');
  const agent = readAgentBehavior(sel.self, opts);
  const role = sel.role ? ((agent?.roles || {}) as any)[sel.role] : null;
  const relation = sel.peerKey ? readRelationBehavior(sel.self, sel.peerKey, opts) : null;
  return mergeLayers<BehaviorConfig>([agent, role, relation], schema.fields);
}

export function mergeBehaviorIntoEffective<T extends EffectiveAgentConfig | AgentConfig>(
  base: T,
  sel: { self?: string; peerKey?: string; role?: string },
  opts: BehaviorReadOpts = {},
): T {
  const behavior = resolveBehavior(sel, opts);
  if (!hasBehaviorFields(behavior)) return base;
  const schema = loadSchema('behavior');
  return mergeLayers<T>([base as any, behavior as any], schema.fields) as T;
}

export function mergeBehaviorLayers<T extends AgentConfig>(
  base: T,
  relation?: RelationConfig | null,
  sel: { self?: string; peerKey?: string; role?: string } = {},
  opts: BehaviorReadOpts = {},
): T {
  const h = relation ? mergeLayers<any>([base as any, relation as any], loadSchema('agent-config').fields) : base;
  return mergeBehaviorIntoEffective(h, sel, opts) as T;
}

export function listRelationBehaviorKeys(aid: string): string[] {
  const dir = agentRelationsDir(aid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'behavior.json')))
    .map(entry => entry.name);
}

function readBehaviorFile(file: string, opts: BehaviorReadOpts, cacheGroup: string): BehaviorConfig | null {
  let raw: BehaviorConfig | null;
  if (opts.cache) {
    raw = fileCache.get<BehaviorConfig | null>(
      file,
      () => atomicReadJson<BehaviorConfig>(file),
      { policy: 'mtime', group: cacheGroup },
    );
  } else {
    raw = atomicReadJson<BehaviorConfig>(file);
  }
  return raw;
}

function writeBehaviorFile(file: string, value: BehaviorConfig): void {
  const schema = loadSchema('behavior');
  const withVersion: BehaviorConfig = {
    $schema_version: value.$schema_version ?? currentVersion('behavior'),
    ...value,
  };
  const ok = schema.validate(withVersion);
  if (!ok) {
    const errs = (schema.validate.errors || [])
      .map(e => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(`behavior 配置不合 schema(behavior.v${schema.version}): ${errs}`);
  }
  atomicWriteJson(file, withVersion);
  try { fileCache.invalidate(file); } catch {}
}

function ensureBehaviorFile(file: string): void {
  if (fs.existsSync(file)) return;
  atomicWriteJson(file, { $schema_version: currentVersion('behavior') });
}

function hasBehaviorFields(value: BehaviorConfig | null | undefined): value is BehaviorConfig {
  if (!value) return false;
  return Object.keys(value).some(k => k !== '$schema_version');
}
