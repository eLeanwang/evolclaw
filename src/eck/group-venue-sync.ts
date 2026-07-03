import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AIDStore, AUNClient } from '@agentunion/fastaun';
import { getAidStore, isValidAid, loadClient, SLOT } from '../aun/aid/index.js';
import { agentVenuesDir } from '../paths.js';
import { atomicReadJson, atomicWriteJson, atomicWriteText } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { invalidateKitCache } from './kit-renderer.js';

export interface GroupVenueSyncConfig {
  enabled?: boolean;
  /** 群空间内的规则文件路径。默认 /announce/evolclaw/rules.md。 */
  rulesPath?: string;
  /** 群空间资源索引扫描根路径。默认 /。 */
  indexPath?: string;
  /** 资源索引最大条目数。默认 80。 */
  maxIndexItems?: number;
  /** 规则文件最大字节数。默认 65536。 */
  maxRulesBytes?: number;
  /** 两次远端 mtime 检查最小间隔。默认 60000ms。 */
  refreshIntervalMs?: number;
  /** false 时只读远端，同步到本地 venues 缓存；true 仅保留给显式管理命令使用。 */
  allowRemoteWrite?: boolean;
}

export interface GroupVenueSyncVars {
  venueKey?: string;
  venueDir?: string;
  groupRulesPath?: string;
  groupRulesRemotePath?: string;
  groupRulesUpdatedAt?: string;
  groupRulesSyncStatus?: string;
  groupRulesSyncError?: string;
  groupResourceIndexPath?: string;
  groupResourceIndexUpdatedAt?: string;
  groupResourceIndexCount?: number;
}

interface GroupVenueSyncState {
  schemaVersion: 1;
  groupId: string;
  venueKey: string;
  rulesRemotePath: string;
  indexRemotePath: string;
  remoteMtimeMs?: number;
  remoteSize?: number;
  remoteHash?: string;
  localHash?: string;
  lastCheckedAt?: string;
  lastSyncedAt?: string;
  lastIndexAt?: string;
  lastError?: string;
}

interface RemoteNode {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  mtimeMs?: number;
  contentType?: string;
}

const DEFAULT_RULES_PATH = '/announce/evolclaw/rules.md';
const DEFAULT_INDEX_PATH = '/';
const DEFAULT_MAX_INDEX_ITEMS = 80;
const DEFAULT_MAX_RULES_BYTES = 64 * 1024;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

export async function syncGroupVenueContext(opts: {
  selfAid?: string;
  groupId?: string;
  channel: string;
  config?: GroupVenueSyncConfig;
}): Promise<GroupVenueSyncVars> {
  const { selfAid, groupId, channel } = opts;
  if (!selfAid || !groupId || !isValidAid(selfAid)) return {};

  const cfg = normalizeConfig(opts.config);
  if (!cfg.enabled) return baseVars(selfAid, channel, groupId, 'disabled');

  const paths = venuePaths(selfAid, channel, groupId);
  fs.mkdirSync(paths.dir, { recursive: true });

  let state = readState(paths.statePath, groupId, paths.venueKey, cfg);
  const now = Date.now();
  const lastCheckedAtMs = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : NaN;
  const shouldRefresh = !Number.isFinite(lastCheckedAtMs)
    || now - lastCheckedAtMs >= cfg.refreshIntervalMs;

  if (!shouldRefresh) {
    return varsFromState(paths, state, 'cached');
  }

  let client: AUNClient | undefined;
  let store: AIDStore | undefined;
  try {
    store = await getAidStore({ slotId: SLOT.daemon });
    client = await loadClient(store, selfAid);
    await client.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false });

    const previousHash = state.localHash;
    let wroteLocalContext = false;
    state = {
      ...state,
      rulesRemotePath: cfg.rulesPath,
      indexRemotePath: cfg.indexPath,
      lastCheckedAt: new Date(now).toISOString(),
      lastError: undefined,
    };

    const rulesNode = await statRemote(client, groupId, cfg.rulesPath);
    if (!rulesNode) {
      state.remoteMtimeMs = undefined;
      state.remoteSize = undefined;
      state.remoteHash = undefined;
      state.lastError = `规则文件不存在或不可读: ${remoteRef(groupId, cfg.rulesPath)}`;
      atomicWriteJson(paths.statePath, state);
      return varsFromState(paths, state, 'missing', state.lastError);
    }

    state.remoteMtimeMs = rulesNode.mtimeMs;
    state.remoteSize = rulesNode.size;
    if ((rulesNode.size ?? 0) > cfg.maxRulesBytes) {
      state.lastError = `规则文件过大: ${rulesNode.size} bytes > ${cfg.maxRulesBytes}`;
      atomicWriteJson(paths.statePath, state);
      return varsFromState(paths, state, 'too_large', state.lastError);
    }

    const previousRemoteMtimeMs = readState(paths.statePath, groupId, paths.venueKey, cfg).remoteMtimeMs;
    const remoteNeedsRead = !fs.existsSync(paths.rulesPath)
      || state.remoteMtimeMs === undefined
      || state.remoteMtimeMs !== previousRemoteMtimeMs;
    if (remoteNeedsRead) {
      const text = await readRemoteText(client, groupId, cfg.rulesPath, cfg.maxRulesBytes);
      const hash = sha256(text);
      state.remoteHash = hash;
      state.localHash = hash;
      state.lastSyncedAt = new Date().toISOString();
      atomicWriteText(paths.rulesPath, normalizeRulesText(text, groupId, cfg.rulesPath));
      wroteLocalContext = true;
    }

    const index = await buildResourceIndex(client, groupId, cfg.indexPath, cfg.maxIndexItems);
    state.lastIndexAt = new Date().toISOString();
    atomicWriteText(paths.indexPath, renderResourceIndex(groupId, cfg.indexPath, index));
    wroteLocalContext = true;
    atomicWriteJson(paths.statePath, state);

    if (wroteLocalContext || previousHash !== state.localHash) invalidateKitCache();
    return varsFromState(paths, state, 'synced');
  } catch (e) {
    const error = errorMessage(e);
    state = {
      ...state,
      lastCheckedAt: new Date(now).toISOString(),
      lastError: error,
    };
    atomicWriteJson(paths.statePath, state);
    logger.warn(`[GroupVenueSync] ${groupId} sync failed: ${error}`);
    return varsFromState(paths, state, fs.existsSync(paths.rulesPath) ? 'stale' : 'error', error);
  } finally {
    if (client) {
      try { await client.close(); } catch { /* ignore */ }
    }
    if (store) {
      try { store.close(); } catch { /* ignore */ }
    }
  }
}

function normalizeConfig(config?: GroupVenueSyncConfig): Required<GroupVenueSyncConfig> {
  return {
    enabled: config?.enabled ?? true,
    rulesPath: normalizeRemotePath(config?.rulesPath || DEFAULT_RULES_PATH),
    indexPath: normalizeRemotePath(config?.indexPath || DEFAULT_INDEX_PATH),
    maxIndexItems: positiveInt(config?.maxIndexItems, DEFAULT_MAX_INDEX_ITEMS),
    maxRulesBytes: positiveInt(config?.maxRulesBytes, DEFAULT_MAX_RULES_BYTES),
    refreshIntervalMs: positiveInt(config?.refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS),
    allowRemoteWrite: config?.allowRemoteWrite ?? false,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizeRemotePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === ':') return '/';
  const withoutAid = trimmed.includes(':/') ? trimmed.slice(trimmed.indexOf(':/') + 1) : trimmed;
  return path.posix.normalize(withoutAid.startsWith('/') ? withoutAid : `/${withoutAid}`);
}

function venuePaths(selfAid: string, channel: string, groupId: string) {
  const venueKey = `${channel}#${encodeURIComponent(groupId)}`;
  const dir = path.join(agentVenuesDir(selfAid), venueKey);
  return {
    venueKey,
    dir,
    rulesPath: path.join(dir, 'rules.md'),
    indexPath: path.join(dir, 'resource-index.md'),
    statePath: path.join(dir, 'group-sync.json'),
  };
}

function baseVars(selfAid: string, channel: string, groupId: string, status: string): GroupVenueSyncVars {
  const paths = venuePaths(selfAid, channel, groupId);
  return { venueKey: paths.venueKey, venueDir: paths.dir, groupRulesSyncStatus: status };
}

function varsFromState(
  paths: ReturnType<typeof venuePaths>,
  state: GroupVenueSyncState,
  status: string,
  error?: string,
): GroupVenueSyncVars {
  const rulesExists = fs.existsSync(paths.rulesPath);
  const indexExists = fs.existsSync(paths.indexPath);
  const indexCount = indexExists ? countIndexItems(paths.indexPath) : 0;
  return {
    venueKey: paths.venueKey,
    venueDir: paths.dir,
    groupRulesPath: rulesExists ? paths.rulesPath : undefined,
    groupRulesRemotePath: remoteRef(state.groupId, state.rulesRemotePath),
    groupRulesUpdatedAt: state.lastSyncedAt,
    groupRulesSyncStatus: status,
    groupRulesSyncError: error || state.lastError,
    groupResourceIndexPath: indexExists ? paths.indexPath : undefined,
    groupResourceIndexUpdatedAt: state.lastIndexAt,
    groupResourceIndexCount: indexCount || undefined,
  };
}

function readState(
  statePath: string,
  groupId: string,
  venueKey: string,
  cfg: Required<GroupVenueSyncConfig>,
): GroupVenueSyncState {
  try {
    const parsed = atomicReadJson<GroupVenueSyncState>(statePath);
    if (parsed?.schemaVersion === 1 && parsed.groupId === groupId) return parsed;
  } catch (e) {
    logger.warn(`[GroupVenueSync] ignored invalid state file ${statePath}: ${errorMessage(e)}`);
  }
  return {
    schemaVersion: 1,
    groupId,
    venueKey,
    rulesRemotePath: cfg.rulesPath,
    indexRemotePath: cfg.indexPath,
  };
}

async function statRemote(client: AUNClient, groupId: string, remotePath: string): Promise<RemoteNode | null> {
  try {
    return normalizeNode(await client.group.fs.stat(remoteRef(groupId, remotePath)));
  } catch {
    return null;
  }
}

async function readRemoteText(
  client: AUNClient,
  groupId: string,
  remotePath: string,
  maxBytes: number,
): Promise<string> {
  const downloaded = await client.group.fs.cp(remoteRef(groupId, remotePath), { kind: 'blob' } as any, {
    verifyHash: true,
  });
  const data = (downloaded as any)?.data;
  const bytes = data instanceof Uint8Array
    ? data
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : undefined;
  if (!bytes) throw new Error('group.fs.cp did not return bytes');
  if (bytes.byteLength > maxBytes) throw new Error(`rules file exceeds max bytes after download: ${bytes.byteLength}`);
  return Buffer.from(bytes).toString('utf-8');
}

async function buildResourceIndex(
  client: AUNClient,
  groupId: string,
  remotePath: string,
  maxItems: number,
): Promise<RemoteNode[]> {
  try {
    const result = await client.group.fs.find(remoteRef(groupId, remotePath), {
      page_size: maxItems,
      pageSize: maxItems,
    });
    return extractNodes(result).slice(0, maxItems);
  } catch (e) {
    logger.debug(`[GroupVenueSync] find failed for ${remoteRef(groupId, remotePath)}: ${errorMessage(e)}`);
    try {
      const result = await client.group.fs.ls(remoteRef(groupId, remotePath));
      return extractNodes(result).slice(0, maxItems);
    } catch (inner) {
      logger.debug(`[GroupVenueSync] ls failed for ${remoteRef(groupId, remotePath)}: ${errorMessage(inner)}`);
      return [];
    }
  }
}

function extractNodes(value: unknown): RemoteNode[] {
  if (Array.isArray(value)) return value.map(normalizeNode).filter(Boolean) as RemoteNode[];
  if (!isRecord(value)) return [];
  const candidates = [
    value.items,
    value.entries,
    value.nodes,
    value.results,
    value.files,
    value.children,
    isRecord(value.result) ? value.result.items : undefined,
    isRecord(value.raw) ? value.raw.items : undefined,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(normalizeNode).filter(Boolean) as RemoteNode[];
  }
  return [];
}

function normalizeNode(value: unknown): RemoteNode | null {
  if (!isRecord(value)) return null;
  const rawPath = stringField(value, ['path', 'full_path', 'key', 'object_key', 'mountPath']);
  const name = stringField(value, ['name', 'filename', 'file_name']) || (rawPath ? path.posix.basename(rawPath) : undefined);
  const type = stringField(value, ['type', 'node_type', 'kind']);
  return {
    path: rawPath,
    name,
    type,
    size: numberField(value, ['size', 'sizeBytes', 'size_bytes', 'bytes']),
    mtimeMs: mtimeMsField(value),
    contentType: stringField(value, ['contentType', 'content_type', 'mime']),
  };
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function mtimeMsField(obj: Record<string, unknown>): number | undefined {
  const direct = numberField(obj, ['mtimeMs', 'mtime_ms', 'updatedAtMs', 'updated_at_ms']);
  if (direct !== undefined) return direct;
  const seconds = numberField(obj, ['mtime', 'updated_at', 'updatedAt', 'last_modified']);
  if (seconds !== undefined) return seconds > 10_000_000_000 ? seconds : seconds * 1000;
  for (const key of ['modifiedAt', 'modified_at', 'mtime_iso']) {
    const value = obj[key];
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function renderResourceIndex(groupId: string, rootPath: string, nodes: RemoteNode[]): string {
  const lines = [
    `# 群资源索引`,
    ``,
    `- group: ${groupId}`,
    `- root: ${remoteRef(groupId, rootPath)}`,
    `- indexedAt: ${new Date().toISOString()}`,
    `- count: ${nodes.length}`,
    ``,
  ];
  if (nodes.length === 0) {
    lines.push(`暂无可见资源，或当前 agent 对该群空间无读取权限。`);
  } else {
    for (const node of nodes) {
      const bits = [
        node.type || 'node',
        node.size !== undefined ? `${node.size} bytes` : '',
        node.mtimeMs ? new Date(node.mtimeMs).toISOString() : '',
        node.contentType || '',
      ].filter(Boolean).join(', ');
      lines.push(`- ${node.path || node.name || '(unknown)'}${bits ? ` (${bits})` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

function normalizeRulesText(text: string, groupId: string, remotePath: string): string {
  const body = text.replace(/\r\n/g, '\n').trim();
  return [
    `# 群规则`,
    ``,
    `> 来源：${remoteRef(groupId, remotePath)}`,
    `> 同步时间：${new Date().toISOString()}`,
    ``,
    body,
    ``,
  ].join('\n');
}

function remoteRef(groupId: string, remotePath: string): string {
  return `${groupId}:${normalizeRemotePath(remotePath)}`;
}

function countIndexItems(indexPath: string): number {
  try {
    return fs.readFileSync(indexPath, 'utf-8').split('\n').filter(line => /^- (?:[^:\s]+:)?\//.test(line)).length;
  } catch {
    return 0;
  }
}

function sha256(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf-8').digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
