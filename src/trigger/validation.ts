import path from 'path';
import crypto from 'crypto';
import type {
  TriggerDefinition,
  TriggerFeedbackAction,
  TriggerFeedbackTarget,
  TriggerReliability,
  TriggerSource,
} from './types.js';

const MAX_SCRIPT_TIMEOUT_MS = 900_000;

export function normalizeTriggerDefinition(input: unknown, opts: { now?: number } = {}): TriggerDefinition {
  if (!isObject(input)) throw new Error('trigger definition must be an object');
  const now = opts.now ?? Date.now();
  const raw = input as Record<string, unknown>;

  const id = optionalString(raw.id) || generateTriggerId();
  const agentAid = requiredString(raw.agentAid, 'agentAid');
  const name = requiredString(raw.name, 'name');
  const createdAt = optionalNumber(raw.createdAt) ?? now;
  const updatedAt = optionalNumber(raw.updatedAt) ?? now;

  return {
    $schema_version: 1,
    id,
    agentAid,
    enabled: raw.enabled === undefined ? true : requiredBoolean(raw.enabled, 'enabled'),
    name,
    description: optionalString(raw.description),
    createdAt,
    updatedAt,
    origin: normalizeOrigin(raw.origin),
    source: normalizeSource(raw.source),
    script: raw.script === undefined ? undefined : normalizeScript(raw.script),
    feedback: normalizeFeedback(raw.feedback),
    reliability: normalizeReliability(raw.reliability),
  };
}

export function validateTriggerDefinition(definition: TriggerDefinition): void {
  normalizeTriggerDefinition(definition);
}

export function definitionRevision(definition: TriggerDefinition): string {
  const stable = stableStringify(definition);
  return `sha256:${sha256(stable)}`;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function previewText(value: string, max = 240): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

export function resolveScriptPath(triggerDir: string, scriptPath: string): string {
  if (path.isAbsolute(scriptPath)) {
    throw new Error('script.path must be relative to trigger directory');
  }
  const normalized = scriptPath.replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('script.path is invalid');
  }
  const absolute = path.resolve(triggerDir, normalized);
  const root = path.resolve(triggerDir);
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('script.path must stay inside trigger directory');
  }
  return absolute;
}

export function safeRelativePath(input: string): string {
  if (!input || typeof input !== 'string') throw new Error('relativePath is required');
  if (path.isAbsolute(input) || input.includes('\0')) throw new Error(`invalid relativePath: ${input}`);
  const normalized = input.replace(/\\/g, '/').replace(/^\.\//, '');
  const resolved = path.posix.normalize(normalized);
  if (!resolved || resolved === '.' || resolved.startsWith('../') || resolved === '..') {
    throw new Error(`invalid relativePath: ${input}`);
  }
  return resolved;
}

export function renderTemplate(template: string | undefined, ctx: { trigger: TriggerDefinition; result?: Record<string, unknown>; error?: { message?: string; code?: string } }): string {
  const source = template ?? defaultTemplate(ctx);
  return source.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    const value = readPath(ctx, key);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });
}

function defaultTemplate(ctx: { result?: Record<string, unknown>; error?: { message?: string } }): string {
  if (ctx.result?.text !== undefined) return String(ctx.result.text);
  if (ctx.error?.message) return ctx.error.message;
  return '';
}

function normalizeOrigin(value: unknown): TriggerDefinition['origin'] {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error('origin must be an object');
  const raw = value as Record<string, unknown>;
  return {
    channel: optionalString(raw.channel),
    peerId: optionalString(raw.peerId),
    sessionKey: optionalString(raw.sessionKey),
  };
}

function normalizeSource(value: unknown): TriggerSource {
  if (!isObject(value)) throw new Error('source must be an object');
  const raw = value as Record<string, unknown>;
  const type = requiredString(raw.type, 'source.type');
  switch (type) {
    case 'delay': {
      const afterMs = positiveNumber(raw.afterMs, 'source.afterMs');
      return { type, afterMs };
    }
    case 'at': {
      const at = requiredString(raw.at, 'source.at');
      const ts = new Date(at).getTime();
      if (!Number.isFinite(ts)) throw new Error('source.at must be a valid ISO datetime');
      return { type, at };
    }
    case 'cron': {
      return {
        type,
        expression: requiredString(raw.expression, 'source.expression'),
        timezone: optionalString(raw.timezone),
      };
    }
    case 'interval': {
      return { type, everyMs: positiveNumber(raw.everyMs, 'source.everyMs') };
    }
    default:
      throw new Error(`unsupported source.type: ${type}`);
  }
}

function normalizeScript(value: unknown): TriggerDefinition['script'] {
  if (!isObject(value)) throw new Error('script must be an object');
  const raw = value as Record<string, unknown>;
  const timeoutMs = optionalNumber(raw.timeoutMs) ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SCRIPT_TIMEOUT_MS) {
    throw new Error(`script.timeoutMs must be between 1 and ${MAX_SCRIPT_TIMEOUT_MS}`);
  }
  return {
    path: requiredString(raw.path, 'script.path'),
    runtime: requiredString(raw.runtime, 'script.runtime'),
    args: raw.args,
    timeoutMs,
  };
}

function normalizeFeedback(value: unknown): TriggerDefinition['feedback'] {
  if (!isObject(value)) throw new Error('feedback must be an object');
  const raw = value as Record<string, unknown>;
  return {
    onSuccess: normalizeFeedbackAction(raw.onSuccess, 'feedback.onSuccess'),
    onNoop: raw.onNoop === undefined ? { mode: 'none' } : normalizeFeedbackAction(raw.onNoop, 'feedback.onNoop'),
    onFailure: normalizeFeedbackAction(raw.onFailure, 'feedback.onFailure'),
  };
}

function normalizeFeedbackAction(value: unknown, label: string): TriggerFeedbackAction {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const mode = requiredString(raw.mode, `${label}.mode`);
  if (mode !== 'none' && mode !== 'direct-message' && mode !== 'agent-runner') {
    throw new Error(`${label}.mode is invalid`);
  }
  const action: TriggerFeedbackAction = {
    mode,
    template: optionalString(raw.template),
  };
  if (mode === 'none') return action;
  action.target = normalizeTarget(raw.target, `${label}.target`);
  return action;
}

function normalizeTarget(value: unknown, label: string): TriggerFeedbackTarget {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const sessionStrategy = (optionalString(raw.sessionStrategy) ?? 'latest') as TriggerFeedbackTarget['sessionStrategy'];
  if (sessionStrategy !== 'latest' && sessionStrategy !== 'current' && sessionStrategy !== 'thread') {
    throw new Error(`${label}.sessionStrategy is invalid`);
  }
  const target: TriggerFeedbackTarget = {
    channelType: requiredString(raw.channelType, `${label}.channelType`),
    channelName: optionalString(raw.channelName),
    channelId: requiredString(raw.channelId, `${label}.channelId`),
    sessionStrategy,
    sessionId: optionalString(raw.sessionId),
    threadId: optionalString(raw.threadId),
  };
  if (sessionStrategy === 'current' && !target.sessionId) {
    throw new Error(`${label}.sessionId is required when sessionStrategy=current`);
  }
  if (sessionStrategy === 'thread' && !target.threadId) {
    throw new Error(`${label}.threadId is required when sessionStrategy=thread`);
  }
  return target;
}

function normalizeReliability(value: unknown): TriggerReliability {
  if (value === undefined) {
    return { concurrency: 'forbid', missedPolicy: 'run_once', scriptRetry: { maxAttempts: 0, backoffMs: 30_000 } };
  }
  if (!isObject(value)) throw new Error('reliability must be an object');
  const raw = value as Record<string, unknown>;
  const concurrency = optionalString(raw.concurrency) ?? 'forbid';
  if (concurrency !== 'forbid' && concurrency !== 'replace' && concurrency !== 'allow') {
    throw new Error('reliability.concurrency is invalid');
  }
  const missedPolicy = optionalString(raw.missedPolicy) ?? 'run_once';
  if (missedPolicy !== 'skip' && missedPolicy !== 'run_once' && missedPolicy !== 'run_all') {
    throw new Error('reliability.missedPolicy is invalid');
  }
  const retryRaw = isObject(raw.scriptRetry) ? raw.scriptRetry as Record<string, unknown> : {};
  const maxAttempts = optionalNumber(retryRaw.maxAttempts) ?? 0;
  const backoffMs = optionalNumber(retryRaw.backoffMs) ?? 30_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 20) {
    throw new Error('reliability.scriptRetry.maxAttempts must be an integer between 0 and 20');
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error('reliability.scriptRetry.backoffMs must be a non-negative number');
  }
  return { concurrency, missedPolicy, scriptRetry: { maxAttempts, backoffMs } };
}

function generateTriggerId(): string {
  return `trig_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown, label: string): number {
  const n = optionalNumber(value);
  if (n === undefined || n <= 0) throw new Error(`${label} must be a positive number`);
  return n;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPath(root: unknown, key: string): unknown {
  let cur: any = root;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
