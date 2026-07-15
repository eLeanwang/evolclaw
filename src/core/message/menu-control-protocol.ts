import { createHash } from 'crypto';
import type { MenuResponse } from '../../types.js';

export const MENU_REQUEST_TYPES = new Set([
  'menu.list',
  'menu.query',
  'menu.options',
  'menu.update',
  'menu.action',
]);

export interface MenuRequestHeader {
  id: string;
  name?: string;
}

export interface MenuProtocolError {
  code: string;
  message: string;
  data?: unknown;
}

export type ParsedMenuControl =
  | { isMenu: false }
  | {
      isMenu: true;
      raw: string;
      request: Record<string, unknown>;
      type: string;
      id?: string;
      name?: string;
      action?: string;
    };

export function parseMenuControl(content: string): ParsedMenuControl {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { isMenu: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { isMenu: false };
  const request = value as Record<string, unknown>;
  if (typeof request.type !== 'string' || !request.type.startsWith('menu.')) return { isMenu: false };
  return {
    isMenu: true,
    raw: content,
    request,
    type: request.type,
    id: typeof request.id === 'string' ? request.id : undefined,
    name: typeof request.name === 'string' ? request.name : undefined,
    action: typeof request.action === 'string' ? request.action : undefined,
  };
}

export function hasValidMenuId(parsed: Extract<ParsedMenuControl, { isMenu: true }>): parsed is Extract<ParsedMenuControl, { isMenu: true }> & { id: string } {
  return typeof parsed.id === 'string' && parsed.id.trim().length > 0;
}

export function validateMenuRequest(request: Record<string, unknown>): MenuProtocolError | null {
  const type = request.type as string;
  if (!MENU_REQUEST_TYPES.has(type)) {
    return { code: 'METHOD_NOT_FOUND', message: `Unknown menu request type: ${type}` };
  }

  const hasName = typeof request.name === 'string' && request.name.trim().length > 0;
  const hasCompatCmd = typeof request.cmd === 'string' && request.cmd.trim().length > 0;
  if (type !== 'menu.list' && !hasName && !hasCompatCmd) {
    return { code: 'INVALID_ARGUMENT', message: 'Menu request name is required' };
  }
  if (request.args !== undefined && (!request.args || typeof request.args !== 'object' || Array.isArray(request.args))) {
    return { code: 'INVALID_ARGUMENT', message: 'Menu request args must be an object' };
  }
  if (type === 'menu.update' && (typeof request.value !== 'string' || request.value.length === 0)) {
    return { code: 'INVALID_ARGUMENT', message: 'Menu request value is required' };
  }
  if (type === 'menu.action' && (typeof request.action !== 'string' || request.action.trim().length === 0)) {
    return { code: 'INVALID_ARGUMENT', message: 'Menu request action is required' };
  }

  if (type === 'menu.action' && request.name === 'cli' && request.action === 'exec') {
    const args = request.args as Record<string, unknown> | undefined;
    const hasArgv = Array.isArray(args?.argv) && args.argv.length > 0;
    const hasLegacyCommand = typeof args?.command === 'string' && args.command.trim().length > 0;
    if (!hasArgv && !hasLegacyCommand) {
      return { code: 'INVALID_ARGUMENT', message: 'CLI exec requires args.argv' };
    }
  }

  if (type === 'menu.action' && request.name === 'file' && request.action === 'fetch') {
    const args = request.args as Record<string, unknown> | undefined;
    if (typeof args?.path !== 'string' || args.path.trim().length === 0) {
      return { code: 'INVALID_ARGUMENT', message: 'File fetch requires args.path' };
    }
  }
  return null;
}

export function menuSuccess(header: MenuRequestHeader, data: unknown): MenuResponse {
  return {
    type: 'menu.response',
    id: header.id,
    ...(header.name ? { name: header.name } : {}),
    data,
  };
}

export function menuFailure(header: MenuRequestHeader, error: MenuProtocolError): MenuResponse {
  return {
    type: 'menu.response',
    id: header.id,
    ...(header.name ? { name: header.name } : {}),
    error: {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    },
  };
}

const INVALID_ARGUMENT_CODES = new Set([
  'ARGUMENT_MISMATCH', 'FILE_TOO_LARGE', 'INVALID_ARGS', 'INVALID_DELEGATION',
  'INVALID_FIELD', 'INVALID_SCOPE', 'INVALID_TYPE', 'INVALID_VALUE', 'MISSING_AID',
  'MISSING_ARGV', 'MISSING_BASEAGENT', 'MISSING_CMD', 'MISSING_PEER', 'MISSING_VALUE',
  'NOT_A_DIRECTORY',
]);

const STABLE_CODES = new Set([
  'ROLE_ACCESS_DENIED', 'PERMISSION_DENIED', 'UNAUTHORIZED', 'FORBIDDEN',
  'INVALID_ARGUMENT', 'NOT_ALLOWED', 'NOT_SUPPORTED', 'UNSUPPORTED',
  'METHOD_NOT_FOUND', 'NOT_FOUND', 'CONFLICT', 'EXECUTION_TIMEOUT',
  'TEMPORARILY_UNAVAILABLE', 'INTERNAL_ERROR',
]);

export function normalizeMenuError(error: unknown): MenuProtocolError {
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const rawCode = typeof source.code === 'string' ? source.code : 'INTERNAL_ERROR';
  const message = typeof source.message === 'string'
    ? source.message
    : typeof source.error === 'string'
      ? source.error
      : error instanceof Error
        ? error.message
        : 'Internal server error';

  let code = rawCode;
  if (INVALID_ARGUMENT_CODES.has(rawCode)) code = 'INVALID_ARGUMENT';
  else if (rawCode === 'UNKNOWN_NAME' || rawCode === 'NOT_APPLICABLE' || rawCode === 'UNSUPPORTED_FIELD') code = 'NOT_SUPPORTED';
  else if (rawCode === 'NO_PERMISSION' || rawCode === 'SCOPE_MISMATCH') code = 'PERMISSION_DENIED';
  else if (rawCode === 'DANGEROUS_NOT_GRANTED') code = 'NOT_ALLOWED';
  else if (rawCode === 'NO_ACTIVE_SESSION' || rawCode === 'NO_ACTIVE_TASK' || rawCode === 'INVALID_SESSION') code = 'NOT_FOUND';
  else if (rawCode === 'BUSY' || rawCode === 'INVALID_STATE' || rawCode === 'DELEGATION_REQUIRED') code = 'CONFLICT';
  else if (rawCode === 'TIMEOUT') code = 'EXECUTION_TIMEOUT';
  else if (rawCode === 'EXEC_FAILED' || rawCode === 'DELETE_FAILED' || rawCode === 'INTERNAL') code = 'INTERNAL_ERROR';
  else if (!STABLE_CODES.has(rawCode)) code = 'INTERNAL_ERROR';

  return {
    code,
    message,
    ...(source.data !== undefined ? { data: source.data } : {}),
  };
}

export function menuPayloadFingerprint(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface DedupEntry<T> {
  fingerprint: string;
  promise: Promise<T>;
  expiresAt: number;
}

export class MenuRequestDeduper<T> {
  private readonly entries = new Map<string, DedupEntry<T>>();

  constructor(private readonly ttlMs = 30_000, private readonly maxEntries = 2_048) {}

  async execute(
    key: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<{ value: T; replayed: boolean } | { conflict: true }> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { conflict: true };
      return { value: await existing.promise, replayed: true };
    }

    const promise = operation();
    const entry: DedupEntry<T> = { fingerprint, promise, expiresAt: Date.now() + this.ttlMs };
    this.entries.set(key, entry);
    this.enforceLimit();
    try {
      const value = await promise;
      entry.expiresAt = Date.now() + this.ttlMs;
      return { value, replayed: false };
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private enforceLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

export class MenuDiagnosticLimiter {
  private readonly last = new Map<string, { at: number; suppressed: number }>();

  check(key: string, intervalMs = 60_000): { log: boolean; suppressed: number } {
    const now = Date.now();
    const previous = this.last.get(key);
    if (!previous || now - previous.at >= intervalMs) {
      const suppressed = previous?.suppressed ?? 0;
      this.last.set(key, { at: now, suppressed: 0 });
      return { log: true, suppressed };
    }
    previous.suppressed += 1;
    return { log: false, suppressed: previous.suppressed };
  }
}
