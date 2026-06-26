import path from 'path';
import crypto from 'crypto';
import type {
  FeedbackDisposition,
  FeedbackTarget,
  TriggerDefinition,
  TriggerEventFilter,
  TriggerExecution,
  TriggerExecutionSession,
  TriggerExecutionSessionStrategy,
  TriggerMatchValue,
  TriggerOrigin,
  TriggerReliability,
  TriggerScriptConfig,
  TriggerSource,
} from './types.js';

const MAX_SCRIPT_TIMEOUT_MS = 900_000;
const DEFAULT_NOOP_SENTINEL = '[[NOOP]]';

export function normalizeTriggerDefinition(input: unknown, opts: { now?: number } = {}): TriggerDefinition {
  if (!isObject(input)) throw new Error('trigger definition must be an object');
  const raw = input as Record<string, unknown>;
  const version = raw.$schema_version;
  if (version === 3) return normalizeV3(raw, opts);
  throw new Error(`trigger schema version 3 is required; got ${String(version)}`);
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

export function renderTemplate(
  template: string | undefined,
  ctx: {
    trigger: TriggerDefinition;
    reply?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { message?: string; code?: string };
    event?: Record<string, unknown>;
    source?: { type: TriggerSource['type']; payload: Record<string, unknown> };
    timestamp?: number;
    date?: string;
    time?: string;
  },
): string {
  const timestamp = ctx.timestamp ?? Date.now();
  const dateObj = new Date(timestamp);
  const fullCtx = {
    timestamp,
    date: ctx.date ?? dateObj.toISOString().slice(0, 10),
    time: ctx.time ?? dateObj.toISOString().slice(11, 19),
    trigger: ctx.trigger,
    execution: ctx.trigger.execution,
    reply: ctx.reply,
    result: ctx.result,
    error: ctx.error,
    event: ctx.event,
    source: ctx.source,
  };
  const source = template ?? defaultTemplate(fullCtx);
  return source.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    const value = readPath(fullCtx, key);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });
}

function defaultTemplate(ctx: { reply?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } }): string {
  if (ctx.reply?.text !== undefined) return String(ctx.reply.text);
  if (ctx.result?.text !== undefined) return String(ctx.result.text);
  if (ctx.error?.message) return ctx.error.message;
  return '';
}

function normalizeV3(raw: Record<string, unknown>, opts: { now?: number }): TriggerDefinition {
  const now = opts.now ?? Date.now();
  const id = optionalString(raw.id) || generateTriggerId();
  const agentAid = requiredString(raw.agentAid, 'agentAid');
  const name = requiredString(raw.name, 'name');
  const createdAt = optionalNumber(raw.createdAt) ?? now;
  const updatedAt = optionalNumber(raw.updatedAt) ?? now;
  const definition: TriggerDefinition = {
    $schema_version: 3,
    id,
    agentAid,
    enabled: raw.enabled === undefined ? true : requiredBoolean(raw.enabled, 'enabled'),
    name,
    description: optionalString(raw.description),
    createdAt,
    updatedAt,
    origin: normalizeOrigin(raw.origin),
    source: normalizeSource(raw.source),
    execution: normalizeExecution(raw.execution, { id }),
    feedback: normalizeFeedback(raw.feedback, raw.origin),
    reliability: normalizeReliability(raw.reliability),
  };
  validateTriggerSemantics(definition);
  return definition;
}

function normalizeOrigin(value: unknown): TriggerOrigin | undefined {
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
    case 'delay':
      return { type, afterMs: positiveNumber(raw.afterMs, 'source.afterMs') };
    case 'at': {
      const at = requiredString(raw.at, 'source.at');
      const ts = new Date(at).getTime();
      if (!Number.isFinite(ts)) throw new Error('source.at must be a valid ISO datetime');
      return { type, at };
    }
    case 'cron':
      return {
        type,
        expression: requiredString(raw.expression, 'source.expression'),
        timezone: optionalString(raw.timezone),
      };
    case 'interval':
      return { type, everyMs: positiveNumber(raw.everyMs, 'source.everyMs') };
    case 'event': {
      const eventPattern = requiredString(raw.eventPattern, 'source.eventPattern');
      validateEventPattern(eventPattern);
      const filter = normalizeEventFilter(raw.filter);
      return filter ? { type, eventPattern, filter } : { type, eventPattern };
    }
    default:
      throw new Error(`unsupported source.type: ${type}`);
  }
}

function validateEventPattern(pattern: string): void {
  if (pattern === '*') return;
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(pattern) && !/^[A-Za-z0-9_-]+:\*$/.test(pattern)) {
    throw new Error('source.eventPattern must be "*", an exact event name, or a prefix pattern like "message:*"');
  }
}

function normalizeEventFilter(value: unknown): TriggerEventFilter | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error('source.filter must be an object');
  const raw = value as Record<string, unknown>;
  if ('where' in raw) throw new Error('source.filter.where is not supported in MVP');
  const allowed = new Set(['match']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`unsupported source.filter.${key}`);
  }
  if (raw.match === undefined) return undefined;
  if (!isObject(raw.match)) throw new Error('source.filter.match must be an object');
  const match: Record<string, TriggerMatchValue> = {};
  for (const [pathKey, expected] of Object.entries(raw.match as Record<string, unknown>)) {
    validateFilterPath(pathKey);
    match[pathKey] = normalizeMatchValue(expected, `source.filter.match.${pathKey}`);
  }
  return { match };
}

function validateFilterPath(pathKey: string): void {
  if (!pathKey || typeof pathKey !== 'string') throw new Error('source.filter.match path must be a non-empty string');
  for (const part of pathKey.split('.')) {
    if (!part) throw new Error(`source.filter.match path is invalid: ${pathKey}`);
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') {
      throw new Error(`source.filter.match path is not allowed: ${pathKey}`);
    }
  }
}

function normalizeMatchValue(value: unknown, label: string): TriggerMatchValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (!isObject(value)) throw new Error(`${label} must be a scalar or match operator object`);
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new Error(`${label} must not be empty`);
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    switch (key) {
      case '$in':
        if (!Array.isArray(raw[key])) throw new Error(`${label}.$in must be an array`);
        normalized[key] = raw[key];
        break;
      case '$regex':
        if (typeof raw[key] !== 'string') throw new Error(`${label}.$regex must be a string`);
        if (raw[key].length > 512) throw new Error(`${label}.$regex is too long`);
        try {
          new RegExp(raw[key]);
        } catch (err: any) {
          throw new Error(`${label}.$regex is invalid: ${err?.message || String(err)}`);
        }
        normalized[key] = raw[key];
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error(`${label}.${key} must be a finite number`);
        normalized[key] = raw[key];
        break;
      case '$exists':
        if (typeof raw[key] !== 'boolean') throw new Error(`${label}.$exists must be boolean`);
        normalized[key] = raw[key];
        break;
      default:
        throw new Error(`unsupported match operator: ${key}`);
    }
  }
  return normalized as TriggerMatchValue;
}

function normalizeExecution(value: unknown, opts: { id: string }): TriggerExecution {
  if (!isObject(value)) throw new Error('execution must be an object');
  const raw = value as Record<string, unknown>;
  const mode = requiredString(raw.mode, 'execution.mode');
  if (mode !== 'agent' && mode !== 'script') throw new Error('execution.mode must be agent or script');
  const execution: TriggerExecution = {
    mode,
    prompt: mode === 'agent' ? requiredString(raw.prompt, 'execution.prompt') : optionalString(raw.prompt),
    script: mode === 'script' ? normalizeScript(raw.script) : undefined,
    session: normalizeExecutionSession(raw.session, opts),
    onError: normalizeOnError(raw.onError),
    noopSentinel: optionalString(raw.noopSentinel) ?? DEFAULT_NOOP_SENTINEL,
  };
  return execution;
}

function normalizeExecutionSession(value: unknown, opts: { id: string }): TriggerExecutionSession {
  const raw = isObject(value) ? value as Record<string, unknown> : {};
  const strategy = (optionalString(raw.strategy) ?? 'isolated') as TriggerExecutionSessionStrategy;
  if (strategy !== 'isolated' && strategy !== 'thread' && strategy !== 'main') {
    throw new Error('execution.session.strategy must be isolated, thread, or main');
  }
  const session: TriggerExecutionSession = {
    strategy,
    baseagent: optionalString(raw.baseagent),
    channelKey: optionalString(raw.channelKey),
    channelId: optionalString(raw.channelId),
    sessionId: optionalString(raw.sessionId),
    threadId: optionalString(raw.threadId),
    name: optionalString(raw.name),
  };
  if (strategy === 'main') {
    if (!session.channelKey) throw new Error('execution.session.channelKey is required when strategy=main');
    if (!session.channelId) throw new Error('execution.session.channelId is required when strategy=main');
  }
  if (strategy === 'thread' && !session.threadId) {
    session.threadId = `trigger:${opts.id}`;
  }
  return session;
}

function normalizeScript(value: unknown): TriggerScriptConfig {
  if (!isObject(value)) throw new Error('execution.script must be an object');
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

function normalizeFeedback(value: unknown, origin: unknown): TriggerDefinition['feedback'] {
  if (!isObject(value)) throw new Error('feedback must be an object');
  const raw = value as Record<string, unknown>;
  return {
    onReply: normalizeDisposition(raw.onReply, 'feedback.onReply', { fallback: { kind: 'reply-origin' }, origin }),
    onNoop: normalizeDisposition(raw.onNoop, 'feedback.onNoop', { fallback: { kind: 'silent' }, origin }),
    default: normalizeDisposition(raw.default, 'feedback.default', { fallback: { kind: 'silent' }, origin }),
  };
}

function normalizeDisposition(value: unknown, label: string, opts?: { fallback: FeedbackDisposition; origin: unknown }): FeedbackDisposition {
  if (value === undefined) {
    if (!opts?.fallback) throw new Error(`${label} is required`);
    return opts.fallback;
  }
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const kind = requiredString(raw.kind, `${label}.kind`);
  if (kind === 'silent') return { kind };
  if (kind === 'reply-origin') return { kind, template: optionalString(raw.template) };
  if (kind === 'forward') {
    if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
      throw new Error(`${label}.targets must be a non-empty array`);
    }
    return {
      kind,
      targets: raw.targets.map((target, i) => normalizeTarget(target, `${label}.targets[${i}]`)),
      template: optionalString(raw.template),
    };
  }
  throw new Error(`${label}.kind must be forward, reply-origin, or silent`);
}

function normalizeTarget(value: unknown, label: string, fallback?: FeedbackTarget): FeedbackTarget {
  if (!isObject(value)) {
    if (fallback) return { ...fallback };
    throw new Error(`${label} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const channelKey = optionalString(raw.channelKey)
    ?? optionalString(raw.channelName)
    ?? optionalString(raw.channel)
    ?? optionalString(raw.channelType)
    ?? fallback?.channelKey;
  const channelId = optionalString(raw.channelId) ?? fallback?.channelId;
  if (!channelKey) throw new Error(`${label}.channelKey is required`);
  if (!channelId) throw new Error(`${label}.channelId is required`);
  const delivery = optionalString(raw.delivery) ?? fallback?.delivery ?? 'direct';
  if (delivery !== 'direct' && delivery !== 'inbound') throw new Error(`${label}.delivery must be direct or inbound`);
  return {
    channelKey,
    channelId,
    delivery,
    threadId: optionalString(raw.threadId) ?? fallback?.threadId,
  };
}

function normalizeReliability(value: unknown): TriggerReliability {
  if (value === undefined) {
    return { concurrency: 'forbid', missedPolicy: 'run_once', retry: { maxAttempts: 0, backoffMs: 30_000 } };
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
  const retryRaw = isObject(raw.retry) ? raw.retry as Record<string, unknown> : {};
  const maxAttempts = optionalNumber(retryRaw.maxAttempts) ?? 0;
  const backoffMs = optionalNumber(retryRaw.backoffMs) ?? 30_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 20) {
    throw new Error('reliability.retry.maxAttempts must be an integer between 0 and 20');
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error('reliability.retry.backoffMs must be a non-negative number');
  }
  return { concurrency, missedPolicy, retry: { maxAttempts, backoffMs } };
}

function normalizeOnError(value: unknown): 'fail' | 'retry' {
  const onError = optionalString(value) ?? 'fail';
  if (onError !== 'fail' && onError !== 'retry') throw new Error('execution.onError must be fail or retry');
  return onError;
}

function validateTriggerSemantics(definition: TriggerDefinition): void {
  if (definition.execution.mode === 'agent' && !definition.execution.prompt) {
    throw new Error('execution.prompt is required when execution.mode=agent');
  }
  if (definition.execution.mode === 'script' && !definition.execution.script) {
    throw new Error('execution.script is required when execution.mode=script');
  }
  if (!definition.feedback.onReply && !definition.feedback.onNoop && !definition.feedback.default) {
    throw new Error('feedback must define onReply, onNoop, or default');
  }
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
