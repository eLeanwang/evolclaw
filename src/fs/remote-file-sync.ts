import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicReadJson, atomicWriteBytes, atomicWriteJson } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export type RemoteFileSyncStatus =
  | 'synced'
  | 'cached'
  | 'missing'
  | 'forbidden'
  | 'unreadable'
  | 'error'
  | 'too_large';

export type RemoteFileAccessStatus = 'missing' | 'forbidden' | 'unreadable';

export interface RemoteFileNode {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  mtimeMs?: number;
  hash?: string;
  contentType?: string;
}

export interface RemoteFileMetadata {
  path?: string;
  name?: string;
  type?: string;
  size?: number;
  mtimeMs?: number;
  hash?: string;
  contentType?: string;
}

export interface LocalFileMetadata {
  hash?: string;
  usable?: boolean;
  bytes?: number;
  lastValidAt?: string;
}

export interface RemoteFileSyncLast {
  checkedAt?: string;
  syncedAt?: string;
  status?: RemoteFileSyncStatus;
  error?: string;
}

export interface RemoteFileSyncEntry {
  remoteRef: string;
  localPath: string;
  remote?: RemoteFileMetadata;
  local?: LocalFileMetadata;
  last?: RemoteFileSyncLast;
}

export interface RemoteFileSyncRegistry {
  schemaVersion: 1;
  entries: Record<string, RemoteFileSyncEntry>;
}

export interface RemoteFileAdapter {
  stat(remoteRef: string): Promise<RemoteFileNode | null>;
  read(remoteRef: string, maxBytes: number): Promise<Uint8Array | ArrayBuffer | string>;
}

export interface RemoteFileTransformContext {
  remoteRef: string;
  localRelPath: string;
  checkedAt: string;
  syncedAt: string;
  node: RemoteFileNode;
}

export interface MaterializeRemoteFileOptions {
  baseDir: string;
  remoteRef: string;
  localRelPath: string;
  maxBytes: number;
  adapter: RemoteFileAdapter;
  transform?: (content: Uint8Array, ctx: RemoteFileTransformContext) => Uint8Array | ArrayBuffer | string;
  classifyError?: (error: unknown) => RemoteFileAccessStatus;
  now?: () => Date;
  logLabel?: string;
}

export interface MaterializeRemoteFileResult {
  status: RemoteFileSyncStatus;
  remoteRef: string;
  localRelPath: string;
  localPath: string;
  registryPath: string;
  checkedAt?: string;
  syncedAt?: string;
  error?: string;
  usable: boolean;
  changed: boolean;
  entry: RemoteFileSyncEntry;
}

export interface MarkRemoteFileSyncErrorOptions {
  baseDir: string;
  remoteRef: string;
  localRelPath: string;
  error: string;
  now?: () => Date;
}

export const REMOTE_FILE_SYNC_DIR = '_sync';
export const REMOTE_FILE_SYNC_REGISTRY = 'files.json';
export const DEFAULT_REMOTE_FILE_REFRESH_INTERVAL_MS = 60_000;

export function remoteFileRegistryPath(baseDir: string): string {
  return path.join(baseDir, REMOTE_FILE_SYNC_DIR, REMOTE_FILE_SYNC_REGISTRY);
}

export function normalizeRemoteFileLocalPath(value: string): string {
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw) throw new Error('local path is empty');
  if (path.posix.isAbsolute(raw)) throw new Error(`local path must be relative: ${value}`);
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`local path escapes base directory: ${value}`);
  }
  if (normalized === REMOTE_FILE_SYNC_DIR || normalized.startsWith(`${REMOTE_FILE_SYNC_DIR}/`)) {
    throw new Error(`local path is reserved for sync metadata: ${value}`);
  }
  return normalized;
}

export function materializedLocalPath(baseDir: string, localRelPath: string): string {
  const normalized = normalizeRemoteFileLocalPath(localRelPath);
  const resolvedBase = path.resolve(baseDir);
  const resolvedLocal = path.resolve(resolvedBase, ...normalized.split('/'));
  if (resolvedLocal !== resolvedBase && !resolvedLocal.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`local path escapes base directory: ${localRelPath}`);
  }
  return resolvedLocal;
}

export async function materializeRemoteFile(opts: MaterializeRemoteFileOptions): Promise<MaterializeRemoteFileResult> {
  if (!Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive integer: ${opts.maxBytes}`);
  }

  const localRelPath = normalizeRemoteFileLocalPath(opts.localRelPath);
  const localPath = materializedLocalPath(opts.baseDir, localRelPath);
  const registryPath = remoteFileRegistryPath(opts.baseDir);
  fs.mkdirSync(opts.baseDir, { recursive: true });

  const registry = readRemoteFileSyncRegistry(opts.baseDir);
  let entry = normalizeEntry(registry.entries[localRelPath], localRelPath, opts.remoteRef);
  const previousEntry = cloneEntry(entry);

  if (entry.remoteRef !== opts.remoteRef) {
    const error = `remote file sync conflict: ${localRelPath} already maps to ${entry.remoteRef}, refused ${opts.remoteRef}`;
    const conflictEntry = hideLocalEntry(entry);
    return resultFromEntry({
      status: 'error',
      error,
      entry: conflictEntry,
      localPath,
      registryPath,
      changed: false,
    });
  }

  registry.entries[localRelPath] = entry;

  const now = opts.now?.() ?? new Date();
  const checkedAt = now.toISOString();
  const lastCheckedMs = entry.last?.checkedAt ? Date.parse(entry.last.checkedAt) : NaN;
  const shouldRefresh = !Number.isFinite(lastCheckedMs)
    || entry.last?.status === undefined
    || now.getTime() - lastCheckedMs >= DEFAULT_REMOTE_FILE_REFRESH_INTERVAL_MS
    || (entry.local?.usable === true && !localCacheMatches(entry, localPath));

  if (!shouldRefresh) {
    const cachedStatus = entry.last?.status === 'synced'
      ? 'cached'
      : entry.last?.status ?? 'cached';
    return resultFromEntry({
      status: cachedStatus,
      entry,
      localPath,
      registryPath,
      changed: false,
    });
  }

  try {
    let node: RemoteFileNode | null;
    try {
      node = await opts.adapter.stat(opts.remoteRef);
    } catch (e) {
      const status = (opts.classifyError ?? classifyRemoteFileAccessError)(e);
      const error = remoteAccessMessage(status, opts.remoteRef, e);
      applyAccessFailure(entry, status, checkedAt, error);
      writeRemoteFileSyncRegistry(opts.baseDir, registry);
      return resultFromEntry({ status, error, entry, localPath, registryPath, changed: false });
    }

    if (!node) {
      const status: RemoteFileAccessStatus = 'unreadable';
      const error = `远端文件元信息不可读: ${opts.remoteRef}`;
      applyAccessFailure(entry, status, checkedAt, error);
      writeRemoteFileSyncRegistry(opts.baseDir, registry);
      return resultFromEntry({ status, error, entry, localPath, registryPath, changed: false });
    }

    const remoteMeta = metadataFromNode(node);
    entry.remote = remoteMeta;

    if ((node.size ?? 0) > opts.maxBytes) {
      const error = `远端文件过大: ${node.size} bytes > ${opts.maxBytes}`;
      entry.last = { ...entry.last, checkedAt, status: 'too_large', error };
      writeRemoteFileSyncRegistry(opts.baseDir, registry);
      return resultFromEntry({ status: 'too_large', error, entry, localPath, registryPath, changed: false });
    }

    if (needsRemoteRead(previousEntry, entry, node, localPath)) {
      let rawBytes: Uint8Array;
      try {
        rawBytes = bytesFromPayload(await opts.adapter.read(opts.remoteRef, opts.maxBytes));
      } catch (e) {
        const error = remoteAccessMessage('unreadable', opts.remoteRef, e);
        entry.last = { ...entry.last, checkedAt, status: 'unreadable', error };
        writeRemoteFileSyncRegistry(opts.baseDir, registry);
        logger.debug(`[RemoteFileSync] ${opts.logLabel ?? opts.remoteRef} read failed: ${errorMessage(e)}`);
        return resultFromEntry({ status: 'unreadable', error, entry, localPath, registryPath, changed: false });
      }

      if (rawBytes.byteLength > opts.maxBytes) {
        const error = `远端文件过大: ${rawBytes.byteLength} bytes > ${opts.maxBytes}`;
        entry.last = { ...entry.last, checkedAt, status: 'too_large', error };
        writeRemoteFileSyncRegistry(opts.baseDir, registry);
        return resultFromEntry({ status: 'too_large', error, entry, localPath, registryPath, changed: false });
      }

      const syncedAt = (opts.now?.() ?? new Date()).toISOString();
      const transformed = opts.transform
        ? opts.transform(rawBytes, { remoteRef: opts.remoteRef, localRelPath, checkedAt, syncedAt, node })
        : rawBytes;
      const localBytes = bytesFromPayload(transformed);
      const remoteHash = sha256(rawBytes);
      const localHash = sha256(localBytes);
      entry.remote = { ...remoteMeta, hash: remoteMeta.hash ?? remoteHash };
      entry.local = {
        hash: localHash,
        usable: true,
        bytes: localBytes.byteLength,
        lastValidAt: syncedAt,
      };
      entry.last = { ...entry.last, checkedAt, syncedAt, status: 'synced', error: undefined };
      atomicWriteBytes(localPath, localBytes);
      writeRemoteFileSyncRegistry(opts.baseDir, registry);
      return resultFromEntry({
        status: 'synced',
        entry,
        localPath,
        registryPath,
        changed: previousEntry.local?.hash !== localHash,
      });
    }

    entry.local = { ...entry.local, usable: entry.local?.usable === true };
    entry.last = { ...entry.last, checkedAt, status: 'synced', error: undefined };
    writeRemoteFileSyncRegistry(opts.baseDir, registry);
    return resultFromEntry({ status: 'synced', entry, localPath, registryPath, changed: false });
  } catch (e) {
    const error = errorMessage(e);
    entry.last = { ...entry.last, checkedAt, status: 'error', error };
    writeRemoteFileSyncRegistry(opts.baseDir, registry);
    logger.warn(`[RemoteFileSync] ${opts.logLabel ?? opts.remoteRef} sync failed: ${error}`);
    return resultFromEntry({ status: 'error', error, entry, localPath, registryPath, changed: false });
  }
}

export function markRemoteFileSyncError(opts: MarkRemoteFileSyncErrorOptions): MaterializeRemoteFileResult {
  const localRelPath = normalizeRemoteFileLocalPath(opts.localRelPath);
  const localPath = materializedLocalPath(opts.baseDir, localRelPath);
  const registryPath = remoteFileRegistryPath(opts.baseDir);
  const registry = readRemoteFileSyncRegistry(opts.baseDir);
  const entry = normalizeEntry(registry.entries[localRelPath], localRelPath, opts.remoteRef);
  const checkedAt = (opts.now?.() ?? new Date()).toISOString();
  if (entry.remoteRef !== opts.remoteRef) {
    const conflictEntry = hideLocalEntry(entry);
    return resultFromEntry({
      status: 'error',
      error: `remote file sync conflict: ${localRelPath} already maps to ${entry.remoteRef}, refused ${opts.remoteRef}`,
      entry: conflictEntry,
      localPath,
      registryPath,
      changed: false,
    });
  }

  entry.last = { ...entry.last, checkedAt, status: 'error', error: opts.error };
  registry.entries[localRelPath] = entry;
  writeRemoteFileSyncRegistry(opts.baseDir, registry);
  return resultFromEntry({
    status: 'error',
    error: opts.error,
    entry,
    localPath,
    registryPath,
    changed: false,
  });
}

export function readRemoteFileSyncRegistry(baseDir: string): RemoteFileSyncRegistry {
  const registryPath = remoteFileRegistryPath(baseDir);
  try {
    const parsed = atomicReadJson<unknown>(registryPath);
    if (isRegistry(parsed)) return normalizeRegistry(parsed);
  } catch (e) {
    logger.warn(`[RemoteFileSync] ignored invalid registry ${registryPath}: ${errorMessage(e)}`);
  }
  return { schemaVersion: 1, entries: {} };
}

export function writeRemoteFileSyncRegistry(baseDir: string, registry: RemoteFileSyncRegistry): void {
  atomicWriteJson(remoteFileRegistryPath(baseDir), normalizeRegistry(registry));
}

export function normalizeRemoteFileNode(value: unknown): RemoteFileNode | null {
  if (!isRecord(value)) return null;
  const rawPath = stringField(value, ['path', 'full_path', 'key', 'object_key', 'mountPath']);
  const name = stringField(value, ['name', 'filename', 'file_name']) || (rawPath ? path.posix.basename(rawPath) : undefined);
  const type = stringField(value, ['type', 'node_type', 'kind']);
  return stripUndefined({
    path: rawPath,
    name,
    type,
    size: numberField(value, ['size', 'sizeBytes', 'size_bytes', 'bytes']),
    mtimeMs: mtimeMsField(value),
    hash: stringField(value, ['hash', 'sha256', 'content_hash', 'contentHash', 'etag']),
    contentType: stringField(value, ['contentType', 'content_type', 'mime']),
  });
}

export function classifyRemoteFileAccessError(error: unknown): RemoteFileAccessStatus {
  const haystack = errorHaystack(error);
  if (/(forbidden|unauthorized|permission|denied|no_permission|permission_denied|无权限|权限|拒绝|\b401\b|\b403\b)/i.test(haystack)) {
    return 'forbidden';
  }
  if (/(not[_ -]?found|notfound|no such|enoent|missing|不存在|\b404\b)/i.test(haystack)) {
    return 'missing';
  }
  return 'unreadable';
}

function normalizeRegistry(registry: RemoteFileSyncRegistry): RemoteFileSyncRegistry {
  const entries: Record<string, RemoteFileSyncEntry> = {};
  for (const [rawKey, rawEntry] of Object.entries(registry.entries ?? {})) {
    try {
      const key = normalizeRemoteFileLocalPath(rawKey);
      const remoteRef = isRecord(rawEntry) && typeof rawEntry.remoteRef === 'string'
        ? rawEntry.remoteRef
        : '';
      const entry = normalizeEntry(rawEntry, key, remoteRef);
      if (!entry.remoteRef) continue;
      entries[key] = entry;
    } catch {
      // Ignore malformed entries. A corrupt registry should not block unrelated files.
    }
  }
  return { schemaVersion: 1, entries };
}

function normalizeEntry(value: unknown, localRelPath: string, remoteRef: string): RemoteFileSyncEntry {
  const entry = isRecord(value) ? value : {};
  const storedRemoteRef = typeof entry.remoteRef === 'string' && entry.remoteRef.trim()
    ? entry.remoteRef
    : remoteRef;
  return {
    remoteRef: storedRemoteRef,
    localPath: localRelPath,
    remote: isRecord(entry.remote) ? normalizeRemoteMetadata(entry.remote) : undefined,
    local: isRecord(entry.local) ? normalizeLocalMetadata(entry.local) : undefined,
    last: isRecord(entry.last) ? normalizeLast(entry.last) : undefined,
  };
}

function normalizeRemoteMetadata(value: Record<string, unknown>): RemoteFileMetadata {
  return stripUndefined({
    path: stringValue(value.path),
    name: stringValue(value.name),
    type: stringValue(value.type),
    size: numberValue(value.size),
    mtimeMs: numberValue(value.mtimeMs),
    hash: stringValue(value.hash),
    contentType: stringValue(value.contentType),
  });
}

function normalizeLocalMetadata(value: Record<string, unknown>): LocalFileMetadata {
  return stripUndefined({
    hash: stringValue(value.hash),
    usable: typeof value.usable === 'boolean' ? value.usable : undefined,
    bytes: numberValue(value.bytes),
    lastValidAt: stringValue(value.lastValidAt),
  });
}

function normalizeLast(value: Record<string, unknown>): RemoteFileSyncLast {
  return stripUndefined({
    checkedAt: stringValue(value.checkedAt),
    syncedAt: stringValue(value.syncedAt),
    status: normalizeStatus(value.status),
    error: stringValue(value.error),
  });
}

function normalizeStatus(value: unknown): RemoteFileSyncStatus | undefined {
  return value === 'synced'
    || value === 'cached'
    || value === 'missing'
    || value === 'forbidden'
    || value === 'unreadable'
    || value === 'error'
    || value === 'too_large'
    ? value
    : undefined;
}

function metadataFromNode(node: RemoteFileNode): RemoteFileMetadata {
  return stripUndefined({
    path: node.path,
    name: node.name,
    type: node.type,
    size: node.size,
    mtimeMs: node.mtimeMs,
    hash: node.hash,
    contentType: node.contentType,
  });
}

function needsRemoteRead(
  previousEntry: RemoteFileSyncEntry,
  entry: RemoteFileSyncEntry,
  node: RemoteFileNode,
  localPath: string,
): boolean {
  if (!localCacheMatches(entry, localPath)) return true;
  const previousRemote = previousEntry.remote;
  if (!previousRemote) return true;
  if (node.hash !== undefined) {
    return node.hash !== previousRemote.hash;
  }
  if (node.mtimeMs !== undefined && previousRemote.mtimeMs !== undefined) {
    return node.mtimeMs !== previousRemote.mtimeMs || node.size !== previousRemote.size;
  }
  return true;
}

function localCacheMatches(entry: RemoteFileSyncEntry, localPath: string): boolean {
  if (entry.local?.usable !== true || !entry.local.hash || !fs.existsSync(localPath)) return false;
  try {
    return sha256(fs.readFileSync(localPath)) === entry.local.hash;
  } catch {
    return false;
  }
}

function applyAccessFailure(
  entry: RemoteFileSyncEntry,
  status: RemoteFileAccessStatus,
  checkedAt: string,
  error: string,
): void {
  if (status === 'missing' || status === 'forbidden') {
    entry.remote = undefined;
    entry.local = { ...entry.local, usable: false };
  }
  entry.last = { ...entry.last, checkedAt, status, error };
}

function resultFromEntry(opts: {
  status: RemoteFileSyncStatus;
  entry: RemoteFileSyncEntry;
  localPath: string;
  registryPath: string;
  changed: boolean;
  error?: string;
}): MaterializeRemoteFileResult {
  const checkedAt = opts.entry.last?.checkedAt;
  const syncedAt = opts.entry.last?.syncedAt;
  const error = opts.error ?? opts.entry.last?.error;
  return {
    status: opts.status,
    remoteRef: opts.entry.remoteRef,
    localRelPath: opts.entry.localPath,
    localPath: opts.localPath,
    registryPath: opts.registryPath,
    checkedAt,
    syncedAt,
    error,
    usable: shouldUseLocal(opts.status) && localCacheMatches(opts.entry, opts.localPath),
    changed: opts.changed,
    entry: opts.entry,
  };
}

function hideLocalEntry(entry: RemoteFileSyncEntry): RemoteFileSyncEntry {
  return {
    ...entry,
    local: { ...entry.local, usable: false },
  };
}

function shouldUseLocal(status: RemoteFileSyncStatus): boolean {
  return status === 'synced'
    || status === 'cached'
    || status === 'unreadable'
    || status === 'error'
    || status === 'too_large';
}

function remoteAccessMessage(status: RemoteFileAccessStatus, remoteRef: string, error: unknown): string {
  const prefix = status === 'missing'
    ? '远端文件不存在'
    : status === 'forbidden'
      ? '远端文件无权限'
      : '远端文件不可读';
  const detail = errorMessage(error);
  return `${prefix}: ${remoteRef}${detail ? ` (${detail})` : ''}`;
}

function bytesFromPayload(payload: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof payload === 'string') return Buffer.from(payload, 'utf-8');
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  throw new Error('remote file payload is not bytes or text');
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function cloneEntry(entry: RemoteFileSyncEntry): RemoteFileSyncEntry {
  return JSON.parse(JSON.stringify(entry)) as RemoteFileSyncEntry;
}

function isRegistry(value: unknown): value is RemoteFileSyncRegistry {
  return isRecord(value) && value.schemaVersion === 1 && isRecord(value.entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorHaystack(error: unknown): string {
  if (!isRecord(error)) return errorMessage(error);
  const fields = [
    error.name,
    error.message,
    error.code,
    error.status,
    error.statusCode,
    error.error,
  ];
  return fields.map(value => value === undefined ? '' : String(value)).join(' ');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
