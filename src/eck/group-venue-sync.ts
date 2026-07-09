import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import type { AIDStore, AUNClient } from '@agentunion/fastaun';
import { getAidStore, isValidAid, loadClient, SLOT } from '../aun/aid/index.js';
import { checkGroupIndex as checkGroupIndexRpc, getGroupIndex as getGroupIndexRpc } from '../aun/msg/group-index.js';
import { agentVenuesDir } from '../paths.js';
import { atomicWriteBytes } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';
import { invalidateKitCache } from './kit-renderer.js';

export type GroupRulesStatus =
  | 'synced'
  | 'cached'
  | 'missing'
  | 'forbidden'
  | 'invalid_metadata'
  | 'file_mismatch'
  | 'too_large'
  | 'unreadable'
  | 'error';

export interface GroupVenueSyncVars {
  venueKey?: string;
  venueDir?: string;
  groupRulesPath?: string;
  groupRulesStatus?: GroupRulesStatus;
  groupRulesError?: string;
}

interface RulesFileMetadata {
  path: '/rules.md';
  size: number;
  mtimeMs: number;
}

interface RemoteRulesNode {
  size?: number;
  mtimeMs?: number;
}

interface GroupIndexResult {
  group_aid?: string;
  meta?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

interface RulesContentResult {
  groupAid: string;
  content?: unknown;
  pulled: boolean;
}

interface CheckGroupIndexResult {
  local_found?: boolean;
  needs_update?: boolean;
  in_sync?: boolean;
}

const RULES_REMOTE_PATH = '/rules.md';
const RULES_LOCAL_PATH = 'rules.md';
// Keep group rules aligned with AUN agent.md: an entry document, not a knowledge base.
const MAX_RULES_BYTES = 4 * 1024;
const MTIME_TOLERANCE_MS = 1;

export async function syncGroupVenueContext(opts: {
  selfAid?: string;
  groupId?: string;
  channel: string;
}): Promise<GroupVenueSyncVars> {
  const { selfAid, groupId, channel } = opts;
  if (!selfAid || !groupId || !isValidAid(selfAid)) return {};

  const paths = venuePaths(selfAid, channel, groupId);
  fs.mkdirSync(paths.dir, { recursive: true });

  const group = lazyGroupClient(selfAid);
  try {
    const resolved = await resolveGroupRules(group.client, groupId, paths.localRulesPath);
    if (resolved.changed) invalidateKitCache();
    return {
      venueKey: paths.venueKey,
      venueDir: paths.dir,
      groupRulesPath: resolved.usable ? paths.localRulesPath : undefined,
      groupRulesStatus: resolved.status,
      groupRulesError: resolved.error,
    };
  } catch (e) {
    const status = classifyError(e);
    const error = errorMessage(e);
    logger.warn(`[GroupVenueSync] ${groupId} rules sync failed: ${error}`);
    return {
      venueKey: paths.venueKey,
      venueDir: paths.dir,
      groupRulesStatus: status,
      groupRulesError: error,
    };
  } finally {
    await group.close();
  }
}

async function resolveGroupRules(
  clientPromise: () => Promise<AUNClient>,
  groupId: string,
  localPath: string,
): Promise<{ status: GroupRulesStatus; usable: boolean; changed: boolean; error?: string }> {
  const client = await clientPromise();
  const check = await safeCheckGroupIndex(client, groupId);
  const shouldPull = check === null || check.needs_update === true || check.local_found !== true;
  const rulesContent = await getRulesContent(client, groupId, shouldPull);

  const rawContent = rulesContent.content;
  if (rawContent === undefined || rawContent === null || rawContent === '') {
    return { status: 'missing', usable: false, changed: false };
  }

  const metadata = parseRulesMetadata(rawContent);
  if (metadata.size > MAX_RULES_BYTES) {
    return { status: 'too_large', usable: false, changed: false, error: `群规则过大: ${metadata.size} bytes > ${MAX_RULES_BYTES}` };
  }

  const remoteRefValue = `${rulesContent.groupAid || groupId}:${RULES_REMOTE_PATH}`;
  const remoteNode = normalizeRemoteRulesNode(await client.group.fs.stat(remoteRefValue));
  if (!remoteNode.size || remoteNode.mtimeMs === undefined) {
    return {
      status: 'unreadable',
      usable: false,
      changed: false,
      error: `远端规则文件缺少 size 或 mtimeMs: ${remoteRefValue}`,
    };
  }
  if (!metadataMatchesNode(metadata, remoteNode)) {
    return {
      status: 'file_mismatch',
      usable: false,
      changed: false,
      error: `远端 /rules.md 与 rules.content 不匹配: expected size=${metadata.size} mtimeMs=${metadata.mtimeMs}, actual size=${remoteNode.size} mtimeMs=${remoteNode.mtimeMs}`,
    };
  }

  if (localMaterializationMatches(localPath, metadata)) {
    return { status: rulesContent.pulled ? 'synced' : 'cached', usable: true, changed: false };
  }

  const bytes = await downloadGroupFileBytes(client, remoteRefValue);
  if (bytes.byteLength > MAX_RULES_BYTES) {
    return { status: 'too_large', usable: false, changed: false, error: `群规则过大: ${bytes.byteLength} bytes > ${MAX_RULES_BYTES}` };
  }
  if (bytes.byteLength !== metadata.size) {
    return {
      status: 'file_mismatch',
      usable: false,
      changed: false,
      error: `下载后的 /rules.md 与 rules.content 大小不匹配: expected ${metadata.size}, actual ${bytes.byteLength}`,
    };
  }
  try {
    assertUtf8(bytes);
  } catch (e) {
    return {
      status: 'unreadable',
      usable: false,
      changed: false,
      error: `远端 /rules.md 不是有效 UTF-8: ${errorMessage(e)}`,
    };
  }

  const previousMatches = localMaterializationMatches(localPath, metadata);
  atomicWriteBytes(localPath, bytes);
  const mtimeSeconds = metadata.mtimeMs / 1000;
  fs.utimesSync(localPath, mtimeSeconds, mtimeSeconds);

  if (!localMaterializationMatches(localPath, metadata)) {
    return {
      status: 'error',
      usable: false,
      changed: false,
      error: `本地物化文件 stat 与 rules.content 不匹配: ${localPath}`,
    };
  }

  return { status: 'synced', usable: true, changed: !previousMatches };
}

async function safeCheckGroupIndex(client: AUNClient, groupId: string): Promise<CheckGroupIndexResult | null> {
  try {
    return await checkGroupIndexRpc(client, groupId) as CheckGroupIndexResult;
  } catch (e) {
    logger.debug(`[GroupVenueSync] checkGroupIndex ignored for ${groupId}: ${errorMessage(e)}`);
    return null;
  }
}

async function getGroupIndex(client: AUNClient, groupId: string): Promise<GroupIndexResult> {
  const result = await getGroupIndexRpc(client, groupId) as GroupIndexResult;
  return {
    group_aid: typeof result.group_aid === 'string' ? result.group_aid : groupId,
    meta: isRecord(result.meta) ? result.meta : undefined,
    settings: isRecord(result.settings) ? result.settings : {},
  };
}

async function getRulesContent(client: AUNClient, groupId: string, forcePull: boolean): Promise<RulesContentResult> {
  if (forcePull) {
    const index = await getGroupIndex(client, groupId);
    return {
      groupAid: index.group_aid || groupId,
      content: index.settings?.['rules.content'],
      pulled: true,
    };
  }

  try {
    const result = await client.group.getRules({ group_id: groupId }) as Record<string, unknown>;
    const rules = isRecord(result.rules) ? result.rules : {};
    return {
      groupAid: typeof result.group_id === 'string' ? result.group_id : groupId,
      content: rules.content,
      pulled: false,
    };
  } catch (e) {
    logger.debug(`[GroupVenueSync] getRules fallback to getGroupIndex for ${groupId}: ${errorMessage(e)}`);
    const index = await getGroupIndex(client, groupId);
    return {
      groupAid: index.group_aid || groupId,
      content: index.settings?.['rules.content'],
      pulled: true,
    };
  }
}

function parseRulesMetadata(value: unknown): RulesFileMetadata {
  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw statusError('invalid_metadata', 'rules.content 不是合法 JSON');
    }
  } else {
    parsed = value;
  }

  if (!isRecord(parsed)) {
    throw statusError('invalid_metadata', 'rules.content 必须是对象');
  }
  if (parsed.path !== RULES_REMOTE_PATH) {
    throw statusError('invalid_metadata', `rules.content.path 必须是 ${RULES_REMOTE_PATH}`);
  }
  const size = numberField(parsed, ['size']);
  const mtimeMs = mtimeMsField(parsed);
  if (size === undefined || !Number.isInteger(size) || size <= 0) {
    throw statusError('invalid_metadata', 'rules.content.size 必须是正整数');
  }
  if (mtimeMs === undefined || !Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    throw statusError('invalid_metadata', 'rules.content.mtimeMs 必须是有效毫秒时间戳');
  }
  return { path: RULES_REMOTE_PATH, size, mtimeMs };
}

function normalizeRemoteRulesNode(value: unknown): RemoteRulesNode {
  if (!isRecord(value)) return {};
  return {
    size: numberField(value, ['size', 'sizeBytes', 'size_bytes', 'bytes']),
    mtimeMs: mtimeMsField(value),
  };
}

function metadataMatchesNode(metadata: RulesFileMetadata, node: RemoteRulesNode): boolean {
  return node.size === metadata.size
    && node.mtimeMs !== undefined
    && Math.abs(node.mtimeMs - metadata.mtimeMs) <= MTIME_TOLERANCE_MS;
}

function localMaterializationMatches(localPath: string, metadata: RulesFileMetadata): boolean {
  try {
    const st = fs.statSync(localPath);
    return st.isFile()
      && st.size === metadata.size
      && Math.abs(st.mtimeMs - metadata.mtimeMs) <= MTIME_TOLERANCE_MS;
  } catch {
    return false;
  }
}

function lazyGroupClient(selfAid: string): { client: () => Promise<AUNClient>; close: () => Promise<void> } {
  let client: AUNClient | undefined;
  let store: AIDStore | undefined;

  return {
    client: async () => {
      if (client) return client;
      store = await getAidStore({ slotId: SLOT.daemon });
      client = await loadClient(store, selfAid);
      await client.connect({ connection_kind: 'short', short_ttl_ms: 30000, auto_reconnect: false });
      return client;
    },
    close: async () => {
      if (client) {
        try { await client.close(); } catch { /* ignore */ }
      }
      if (store) {
        try { store.close(); } catch { /* ignore */ }
      }
    },
  };
}

async function downloadGroupFileBytes(client: AUNClient, remoteRef: string): Promise<Uint8Array> {
  const ticket = await (client as any).call('group.fs.create_download_ticket', { path: remoteRef });
  if (!isRecord(ticket)) {
    throw statusError('unreadable', 'group.fs.create_download_ticket returned invalid response');
  }
  const downloadUrl = stringField(ticket, ['download_url', 'url']);
  if (!downloadUrl) {
    throw statusError('unreadable', 'group.fs.create_download_ticket did not return download_url');
  }
  const bytes = await client.group.fs.lowlevel.httpGet(downloadUrl, bearerHeaders(client));
  const expectedSha = stringField(ticket, ['sha256']);
  if (expectedSha && sha256Hex(bytes).toLowerCase() !== expectedSha.toLowerCase()) {
    throw statusError('unreadable', 'download hash verification failed');
  }
  return bytes;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bearerHeaders(client: AUNClient): Record<string, string> | undefined {
  const token = accessTokenFromClient(client);
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function accessTokenFromClient(client: AUNClient): string {
  const anyClient = client as any;
  if (typeof anyClient.getAccessToken === 'function') {
    const token = stringValue(anyClient.getAccessToken());
    if (token) return token;
  }
  return stringValue(anyClient.accessToken)
    || stringValue(anyClient.access_token)
    || stringValue(anyClient._identity?.access_token)
    || stringValue(anyClient._sessionParams?.access_token);
}

function assertUtf8(bytes: Uint8Array): void {
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function venuePaths(selfAid: string, channel: string, groupId: string) {
  const venueKey = `${channel}#${encodeURIComponent(groupId)}`;
  const dir = path.join(agentVenuesDir(selfAid), venueKey);
  return {
    venueKey,
    dir,
    localRulesPath: path.join(dir, RULES_LOCAL_PATH),
  };
}

function statusError(status: GroupRulesStatus, message: string): Error & { groupRulesStatus?: GroupRulesStatus } {
  const error = new Error(message) as Error & { groupRulesStatus?: GroupRulesStatus };
  error.groupRulesStatus = status;
  return error;
}

function classifyError(error: unknown): GroupRulesStatus {
  if (isRecord(error) && typeof error.groupRulesStatus === 'string') {
    const status = error.groupRulesStatus;
    if (isGroupRulesStatus(status)) return status;
  }
  const haystack = errorHaystack(error);
  if (/(forbidden|unauthorized|permission|denied|no_permission|permission_denied|无权限|权限|拒绝|\b401\b|\b403\b)/i.test(haystack)) {
    return 'forbidden';
  }
  if (/(not[_ -]?found|notfound|no such|enoent|missing|不存在|\b404\b|rules not found)/i.test(haystack)) {
    return 'missing';
  }
  if (/(signature|verify|verification|signed_by|body_hash|invalid signature|验签|签名)/i.test(haystack)) {
    return 'invalid_metadata';
  }
  if (/(timeout|temporar|unavailable|econn|network|socket|reset|下载|读取)/i.test(haystack)) {
    return 'unreadable';
  }
  return 'error';
}

function isGroupRulesStatus(value: string): value is GroupRulesStatus {
  return value === 'synced'
    || value === 'cached'
    || value === 'missing'
    || value === 'forbidden'
    || value === 'invalid_metadata'
    || value === 'file_mismatch'
    || value === 'too_large'
    || value === 'unreadable'
    || value === 'error';
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function mtimeMsField(obj: Record<string, unknown>): number | undefined {
  const direct = numberField(obj, ['mtimeMs', 'mtime_ms', 'updatedAtMs', 'updated_at_ms']);
  if (direct !== undefined) return direct;
  const seconds = numberField(obj, ['mtime', 'updated_at', 'updatedAt', 'last_modified', 'modified_at']);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorHaystack(error: unknown): string {
  if (!isRecord(error)) return errorMessage(error);
  return [
    error.name,
    error.message,
    error.code,
    error.status,
    error.statusCode,
    error.error,
  ].map(value => value === undefined ? '' : String(value)).join(' ');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
