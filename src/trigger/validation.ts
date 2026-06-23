import path from 'path';
import crypto from 'crypto';
import type {
  TriggerDefinition,
  TriggerFeedbackAction,
  TriggerFeedbackConfig,
  TriggerFeedbackTarget,
  TriggerEventFilter,
  TriggerMatchValue,
  TriggerProcessing,
  TriggerReliability,
  TriggerScriptConfig,
  TriggerSession,
  TriggerSource,
  TriggerThreadMode,
} from './types.js';
import { isScriptFeedbackConfig } from './types.js';

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

  const source = normalizeSource(raw.source);
  const processing = normalizeProcessing(raw, agentAid);
  const session = normalizeSession(raw.session, {
    id,
    agentAid,
    fallbackTarget: firstLegacyTarget(raw.feedback),
  });
  const feedback = normalizeFeedback(raw.feedback, processing, session);

  const definition: TriggerDefinition = {
    $schema_version: 2,
    id,
    agentAid,
    enabled: raw.enabled === undefined ? true : requiredBoolean(raw.enabled, 'enabled'),
    name,
    description: optionalString(raw.description),
    createdAt,
    updatedAt,
    origin: normalizeOrigin(raw.origin),
    source,
    session,
    processing,
    feedback,
    reliability: normalizeReliability(raw.reliability),
  };

  validateTriggerSemantics(definition);
  return definition;
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
    session: ctx.trigger.session,
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

function normalizeProcessing(raw: Record<string, unknown>, agentAid: string): TriggerProcessing {
  if (raw.processing !== undefined) {
    if (!isObject(raw.processing)) throw new Error('processing must be an object');
    const procRaw = raw.processing as Record<string, unknown>;
    const mode = requiredString(procRaw.mode, 'processing.mode');
    if (mode === 'script') return { mode, script: normalizeScript(procRaw.script) };
    if (mode === 'template') return { mode, template: requiredString(procRaw.template, 'processing.template') };
    if (mode === 'prompt') return { mode, prompt: requiredString(procRaw.prompt, 'processing.prompt') };
    throw new Error(`unsupported processing.mode: ${mode}`);
  }

  if (raw.script !== undefined) {
    return { mode: 'script', script: normalizeScript(raw.script) };
  }

  const legacyAction = firstLegacyAction(raw.feedback);
  const text = optionalString(legacyAction?.template) ?? '';
  const mode = normalizeFeedbackMode(legacyAction?.mode);
  if (mode === 'agent-session' || mode === 'none') {
    return { mode: 'prompt', prompt: text };
  }

  void agentAid;
  return { mode: 'template', template: text };
}

function normalizeScript(value: unknown): TriggerScriptConfig {
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

function normalizeSession(value: unknown, opts: { id: string; agentAid: string; fallbackTarget?: Record<string, unknown> }): TriggerSession {
  const raw = isObject(value) ? value as Record<string, unknown> : undefined;
  const legacy = opts.fallbackTarget;

  const channelKey = optionalString(raw?.channelKey)
    ?? optionalString(legacy?.channelKey)
    ?? optionalString(legacy?.channelName)
    ?? optionalString(legacy?.channel)
    ?? optionalString(legacy?.channelType);
  const channelId = optionalString(raw?.channelId) ?? optionalString(legacy?.channelId);
  if (!channelKey) throw new Error('session.channelKey is required');
  if (!channelId) throw new Error('session.channelId is required');

  const strategy = (optionalString(raw?.strategy) ?? optionalString(legacy?.sessionStrategy) ?? 'latest') as TriggerSession['strategy'];
  if (strategy !== 'latest' && strategy !== 'current' && strategy !== 'thread') {
    throw new Error('session.strategy is invalid');
  }

  const session: TriggerSession = {
    channelKey,
    channelId,
    strategy,
    sessionId: optionalString(raw?.sessionId) ?? optionalString(legacy?.sessionId),
  };

  if (strategy === 'current' && !session.sessionId) {
    throw new Error('session.sessionId is required when strategy=current');
  }

  if (strategy === 'thread') {
    const threadRaw = isObject(raw?.thread) ? raw!.thread as Record<string, unknown> : {};
    const mode = (optionalString(threadRaw.mode) ?? optionalString(legacy?.threadMode) ?? 'reuse') as TriggerThreadMode;
    if (mode !== 'reuse' && mode !== 'once') {
      throw new Error('session.thread.mode must be reuse or once');
    }
    session.thread = {
      mode,
      threadId: optionalString(threadRaw.threadId) ?? optionalString(legacy?.threadId) ?? `trigger:${opts.id}`,
      name: optionalString(threadRaw.name),
    };
  }

  void opts.agentAid;
  return session;
}

function normalizeFeedback(value: unknown, processing: TriggerProcessing, session: TriggerSession): TriggerFeedbackConfig {
  if (!isObject(value)) throw new Error('feedback must be an object');
  const raw = value as Record<string, unknown>;

  if (processing.mode === 'script') {
    if ('mode' in raw) throw new Error('script processing requires branched feedback');
    return {
      onSuccess: normalizeFeedbackAction(raw.onSuccess, 'feedback.onSuccess', session),
      onNoop: raw.onNoop === undefined ? { mode: 'none' } : normalizeFeedbackAction(raw.onNoop, 'feedback.onNoop', session),
      onFailure: normalizeFeedbackAction(raw.onFailure, 'feedback.onFailure', session),
    };
  }

  if ('mode' in raw) {
    return normalizeFeedbackAction(raw, 'feedback', session);
  }

  const legacy = normalizeFeedbackAction(raw.onSuccess, 'feedback.onSuccess', session);
  return legacy;
}

function normalizeFeedbackAction(value: unknown, label: string, session: TriggerSession): TriggerFeedbackAction {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const mode = normalizeFeedbackMode(raw.mode);
  const action: TriggerFeedbackAction = {
    mode,
    template: optionalString(raw.template),
  };
  if (mode === 'none') return action;

  action.target = raw.target === undefined
    ? targetFromSession(session)
    : normalizeTarget(raw.target, `${label}.target`, session);
  return action;
}

function normalizeFeedbackMode(value: unknown): TriggerFeedbackAction['mode'] {
  const mode = typeof value === 'string' && value ? value : 'none';
  if (mode === 'agent-runner') return 'agent-session';
  if (mode !== 'none' && mode !== 'direct-message' && mode !== 'agent-session') {
    throw new Error('feedback.mode is invalid');
  }
  return mode;
}

function normalizeTarget(value: unknown, label: string, session: TriggerSession): TriggerFeedbackTarget {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const channelKey = optionalString(raw.channelKey)
    ?? optionalString(raw.channelName)
    ?? optionalString(raw.channel)
    ?? optionalString(raw.channelType)
    ?? session.channelKey;
  const channelId = optionalString(raw.channelId) ?? session.channelId;
  const sessionStrategy = (optionalString(raw.sessionStrategy) ?? session.strategy) as TriggerFeedbackTarget['sessionStrategy'];
  if (sessionStrategy !== 'latest' && sessionStrategy !== 'current' && sessionStrategy !== 'thread') {
    throw new Error(`${label}.sessionStrategy is invalid`);
  }
  const target: TriggerFeedbackTarget = {
    channelKey,
    channelId,
    channelType: optionalString(raw.channelType) ?? parseChannelType(channelKey),
    channelName: channelKey,
    sessionStrategy,
    sessionId: optionalString(raw.sessionId) ?? (sessionStrategy === session.strategy ? session.sessionId : undefined),
    threadId: optionalString(raw.threadId) ?? (sessionStrategy === 'thread' ? session.thread?.threadId : undefined),
    threadMode: (optionalString(raw.threadMode) as TriggerThreadMode | undefined) ?? (sessionStrategy === 'thread' ? session.thread?.mode : undefined),
  };
  if (sessionStrategy === 'current' && !target.sessionId) {
    throw new Error(`${label}.sessionId is required when sessionStrategy=current`);
  }
  if (sessionStrategy === 'thread') {
    if (target.threadMode !== undefined && target.threadMode !== 'reuse' && target.threadMode !== 'once') {
      throw new Error(`${label}.threadMode must be reuse or once`);
    }
    if (!target.threadId && (target.threadMode ?? 'reuse') === 'reuse') {
      throw new Error(`${label}.threadId is required when sessionStrategy=thread`);
    }
  }
  return target;
}

function targetFromSession(session: TriggerSession): TriggerFeedbackTarget {
  return {
    channelKey: session.channelKey,
    channelId: session.channelId,
    channelType: parseChannelType(session.channelKey),
    channelName: session.channelKey,
    sessionStrategy: session.strategy,
    sessionId: session.sessionId,
    threadId: session.thread?.threadId,
    threadMode: session.thread?.mode,
  };
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

function validateTriggerSemantics(definition: TriggerDefinition): void {
  if (definition.processing.mode === 'script') {
    if (!isScriptFeedbackConfig(definition.feedback)) {
      throw new Error('script processing requires branched feedback');
    }
    return;
  }

  if (isScriptFeedbackConfig(definition.feedback)) {
    throw new Error(`${definition.processing.mode} processing requires single feedback`);
  }

  if (definition.processing.mode === 'prompt' && definition.feedback.mode === 'none' && definition.session.strategy !== 'thread') {
    throw new Error('prompt + feedback:none is only allowed for thread session');
  }
}

function firstLegacyAction(feedback: unknown): Record<string, unknown> | undefined {
  if (!isObject(feedback)) return undefined;
  if ('mode' in feedback) return feedback as Record<string, unknown>;
  const raw = feedback as Record<string, unknown>;
  return isObject(raw.onSuccess) ? raw.onSuccess as Record<string, unknown> : undefined;
}

function firstLegacyTarget(feedback: unknown): Record<string, unknown> | undefined {
  const action = firstLegacyAction(feedback);
  return isObject(action?.target) ? action!.target as Record<string, unknown> : undefined;
}

function parseChannelType(channelKey: string): string {
  const idx = channelKey.indexOf('#');
  return idx > 0 ? channelKey.slice(0, idx) : channelKey;
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
