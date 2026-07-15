import path from 'path';
import crypto from 'crypto';
import type {
  TriggerDefinition,
  TriggerEffort,
  TriggerEventFilter,
  TriggerExecution,
  TriggerExecutionThread,
  TriggerFeedbackConfig,
  TriggerFeedbackTarget,
  TriggerPermissionMode,
  TriggerLimits,
  TriggerMatchValue,
  TriggerOrigin,
  TriggerReliability,
  TriggerScriptConfig,
  TriggerSource,
} from './types.js';
import { normalizePermissionMode as normalizePermissionModeContract } from '../core/permission-mode.js';
import { formatChannelKey } from '../core/channel-loader.js';

const MAX_SCRIPT_TIMEOUT_MS = 900_000;
const DEFAULT_NOOP_SENTINEL = '[[NOOP]]';
const LIMIT_DURATION_RE = /^[1-9]\d*(s|m|h|d)$/;
const TRIGGER_EFFORTS = new Set<TriggerEffort>(['low', 'medium', 'high', 'xhigh', 'max']);
const PERMISSION_MODES = new Set<TriggerPermissionMode>([
  'readonly',
  'auto',
  'request',
  'bypass',
]);

export function normalizeTriggerDefinition(input: unknown, opts: { now?: number } = {}): TriggerDefinition {
  if (!isObject(input)) throw new Error('trigger definition must be an object');
  const raw = input as Record<string, unknown>;
  const version = raw.$schema_version;
  if (version === undefined) throw new Error('trigger definition missing required field: $schema_version');
  if (version !== 4) throw new Error(`trigger schema version 4 is required; got ${version}`);
  return normalizeV4(raw, opts);
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

export function splitScriptCommand(input: string): { path: string; args: string[] } {
  const text = String(input ?? '').trim();
  if (!text) return { path: '', args: [] };
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const ch of text) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (quote) throw new Error('script.path has an unterminated quoted argument');
  if (current) parts.push(current);
  return { path: parts[0] ?? '', args: parts.slice(1) };
}

export function resolveScriptPath(triggerDir: string, scriptPath: string): string {
  const command = splitScriptCommand(scriptPath);
  scriptPath = command.path;
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

export function parseDurationMs(value: string): number {
  if (!LIMIT_DURATION_RE.test(value)) {
    throw new Error('limits.maxDuration must match ^[1-9]\\d*(s|m|h|d)$');
  }
  const amount = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  const multiplier = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
  return amount * multiplier;
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
  const replyText = ctx.reply?.text === undefined || ctx.reply.text === null ? '' : String(ctx.reply.text);
  if (replyText.trim()) return replyText;
  const resultText = ctx.result?.text === undefined || ctx.result.text === null ? '' : String(ctx.result.text);
  if (resultText.trim()) return resultText;
  if (ctx.error?.message) return ctx.error.message;
  return '';
}

function normalizeV4(raw: Record<string, unknown>, opts: { now?: number }): TriggerDefinition {
  const now = opts.now ?? Date.now();
  const id = optionalString(raw.id) || generateTriggerId();
  const agentAid = requiredString(raw.agentAid, 'agentAid');
  const name = requiredString(raw.name, 'name');
  const createdAt = optionalNumber(raw.createdAt) ?? now;
  const updatedAt = optionalNumber(raw.updatedAt) ?? now;
  const definition: TriggerDefinition = {
    $schema_version: 4,
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
    feedback: normalizeFeedback(raw.feedback, agentAid),
    reliability: normalizeReliability(raw.reliability),
    limits: normalizeLimits(raw.limits),
  };
  validateTriggerSemantics(definition);
  return definition;
}

function normalizeOrigin(value: unknown): TriggerOrigin | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error('origin must be an object');
  const raw = value as Record<string, unknown>;
  const session = normalizeSessionKind(raw.session, 'origin.session');
  const threadId = optionalString(raw.threadId);
  if (session === 'main' && threadId) throw new Error('origin.threadId is not allowed when origin.session=main');
  if (session === 'thread' && !threadId) throw new Error('origin.threadId is required when origin.session=thread');
  return {
    channelKey: requiredString(raw.channelKey, 'origin.channelKey'),
    channelId: requiredString(raw.channelId, 'origin.channelId'),
    session,
    threadId,
    peerId: optionalString(raw.peerId),
    sessionKey: optionalString(raw.sessionKey),
  };
}

function normalizeSource(value: unknown): TriggerSource {
  if (!isObject(value)) throw new Error('source must be an object');
  const raw = value as Record<string, unknown>;
  const type = requiredString(raw.type, 'source.type');
  switch (type) {
    case 'once':
      rejectFields(raw, ['afterMs', 'at', 'expression', 'timezone', 'everyMs', 'eventPattern', 'filter'], 'source');
      return { type };
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

function normalizeExecution(value: unknown, _opts: { id: string }): TriggerExecution {
  if (!isObject(value)) throw new Error('execution must be an object');
  const raw = value as Record<string, unknown>;
  if ('mode' in raw) throw new Error('execution.mode is not supported in schema v4; use execution.type');
  if ('session' in raw) throw new Error('execution.session is not supported in schema v4; use execution.thread or feedback.target');
  const type = requiredString(raw.type, 'execution.type');
  if (type !== 'script' && type !== 'trigger_session' && type !== 'target_session') {
    throw new Error('execution.type must be script, trigger_session, or target_session');
  }
  const thread = normalizeExecutionThread(raw.thread);
  const execution: TriggerExecution = {
    type,
    prompt: type === 'script' ? optionalString(raw.prompt) : requiredString(raw.prompt, 'execution.prompt'),
    script: type === 'script' ? normalizeScript(raw.script) : undefined,
    thread: type === 'trigger_session' ? (thread ?? 'per_run') : thread,
    model: optionalString(raw.model),
    effort: normalizeEffort(raw.effort),
    permissionMode: normalizeTriggerPermissionMode(raw.permissionMode),
    onError: normalizeOnError(raw.onError),
    noopSentinel: optionalString(raw.noopSentinel) ?? DEFAULT_NOOP_SENTINEL,
  };
  return execution;
}

function normalizeExecutionThread(value: unknown): TriggerExecutionThread | undefined {
  const thread = optionalString(value);
  if (thread === undefined) return undefined;
  if (thread !== 'per_run' && thread !== 'by_trigger') {
    throw new Error('execution.thread must be per_run or by_trigger');
  }
  return thread;
}

function normalizeEffort(value: unknown): TriggerEffort | undefined {
  const effort = optionalString(value);
  if (effort === undefined) return undefined;
  if (!TRIGGER_EFFORTS.has(effort as TriggerEffort)) {
    throw new Error('execution.effort must be one of low, medium, high, xhigh, max');
  }
  return effort as TriggerEffort;
}

function normalizeTriggerPermissionMode(value: unknown): TriggerPermissionMode | undefined {
  const mode = optionalString(value);
  if (mode === undefined) return undefined;
  if (PERMISSION_MODES.has(mode as TriggerPermissionMode)) {
    return mode as TriggerPermissionMode;
  }
  // Persisted v4 triggers may still contain legacy values. Normalize those at
  // load time while new CLI/menu input only accepts the four public modes.
  if (mode === 'edit' || mode === 'noask' || mode === 'plan') {
    return normalizePermissionModeContract(mode).mode;
  }
  throw new Error('execution.permissionMode must be one of readonly, auto, request, bypass');
}

function normalizeScript(value: unknown): TriggerScriptConfig {
  if (!isObject(value)) throw new Error('execution.script must be an object');
  const raw = value as Record<string, unknown>;
  const command = splitScriptCommand(requiredString(raw.path, 'script.path'));
  if (!command.path) throw new Error('script.path is required');
  const timeoutMs = optionalNumber(raw.timeoutMs) ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SCRIPT_TIMEOUT_MS) {
    throw new Error(`script.timeoutMs must be between 1 and ${MAX_SCRIPT_TIMEOUT_MS}`);
  }
  const args = raw.args !== undefined
    ? raw.args
    : (command.args.length > 0 ? command.args : undefined);
  return {
    path: command.path,
    runtime: requiredString(raw.runtime, 'script.runtime'),
    args,
    timeoutMs,
  };
}

function normalizeFeedback(value: unknown, agentAid: string): TriggerFeedbackConfig {
  if (!isObject(value)) throw new Error('feedback must be an object');
  const raw = value as Record<string, unknown>;
  const strategy = requiredString(raw.strategy, 'feedback.strategy');
  if (strategy !== 'origin' && strategy !== 'target' && strategy !== 'silent') {
    throw new Error('feedback.strategy must be origin, target, or silent');
  }
  return {
    strategy,
    target: raw.target === undefined ? undefined : normalizeFeedbackTarget(raw.target, 'feedback.target', agentAid),
    onReply: normalizeFeedbackTemplate(raw.onReply, 'feedback.onReply'),
    onNoop: normalizeFeedbackTemplate(raw.onNoop, 'feedback.onNoop'),
    onFailure: normalizeFeedbackTemplate(raw.onFailure, 'feedback.onFailure'),
  };
}

function normalizeFeedbackTarget(value: unknown, label: string, agentAid: string): TriggerFeedbackTarget {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const session = normalizeSessionKind(raw.session, `${label}.session`);
  const threadId = optionalString(raw.threadId);
  if (session === 'main' && threadId) throw new Error(`${label}.threadId is not allowed when ${label}.session=main`);
  if (session === 'thread' && !threadId) throw new Error(`${label}.threadId is required when ${label}.session=thread`);
  const channelKey = requiredString(raw.channelKey, `${label}.channelKey`);
  return {
    channelKey: channelKey === 'aun'
      ? formatChannelKey({ type: 'aun', selfAID: agentAid, name: 'main' })
      : channelKey,
    channelId: requiredString(raw.channelId, `${label}.channelId`),
    session,
    threadId,
  };
}

function normalizeFeedbackTemplate(value: unknown, label: string): { template?: string } | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  return { template: optionalTemplate(raw.template) };
}

function normalizeSessionKind(value: unknown, label: string): 'main' | 'thread' {
  const session = optionalString(value) ?? 'main';
  if (session !== 'main' && session !== 'thread') throw new Error(`${label} must be main or thread`);
  return session;
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

function normalizeLimits(value: unknown): TriggerLimits | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error('limits must be an object');
  const raw = value as Record<string, unknown>;
  const limits: TriggerLimits = {};

  if (raw.maxRuns !== undefined) {
    const maxRuns = optionalNumber(raw.maxRuns);
    if (maxRuns === undefined || !Number.isInteger(maxRuns) || maxRuns <= 0) {
      throw new Error('limits.maxRuns must be a positive integer');
    }
    limits.maxRuns = maxRuns;
  }

  if (raw.maxDuration !== undefined) {
    const maxDuration = requiredString(raw.maxDuration, 'limits.maxDuration');
    parseDurationMs(maxDuration);
    limits.maxDuration = maxDuration;
  }

  return limits.maxRuns === undefined && limits.maxDuration === undefined ? undefined : limits;
}

function normalizeOnError(value: unknown): 'fail' | 'retry' {
  const onError = optionalString(value) ?? 'fail';
  if (onError !== 'fail' && onError !== 'retry') throw new Error('execution.onError must be fail or retry');
  return onError;
}

function validateTriggerSemantics(definition: TriggerDefinition): void {
  const execution = definition.execution;
  if (execution.type === 'script') {
    if (!execution.script) throw new Error('execution.script is required when execution.type=script');
    if (execution.prompt !== undefined) throw new Error('execution.prompt is not allowed when execution.type=script');
    if (execution.thread !== undefined) throw new Error('execution.thread is not allowed when execution.type=script');
  }
  if (execution.type === 'trigger_session') {
    if (!execution.prompt) throw new Error('execution.prompt is required when execution.type=trigger_session');
    if (execution.script !== undefined) throw new Error('execution.script is not allowed when execution.type=trigger_session');
  }
  if (execution.type === 'target_session') {
    if (!execution.prompt) throw new Error('execution.prompt is required when execution.type=target_session');
    if (execution.script !== undefined) throw new Error('execution.script is not allowed when execution.type=target_session');
    if (execution.thread !== undefined) throw new Error('execution.thread is not allowed when execution.type=target_session');
    if (definition.feedback.strategy === 'silent') throw new Error('feedback.strategy=silent is not allowed when execution.type=target_session');
  }
  if (definition.feedback.strategy === 'target' && !definition.feedback.target) {
    throw new Error('feedback.target is required when feedback.strategy=target');
  }
  if (definition.feedback.strategy !== 'target' && definition.feedback.target) {
    throw new Error('feedback.target is only allowed when feedback.strategy=target');
  }
  if (execution.type !== 'script' && (definition.feedback.onReply || definition.feedback.onNoop || definition.feedback.onFailure)) {
    throw new Error('feedback.onReply/onNoop/onFailure are only allowed when execution.type=script');
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

function optionalTemplate(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('feedback template must be a string when provided');
  return value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown, label: string): number {
  const n = optionalNumber(value);
  if (n === undefined || n <= 0) throw new Error(`${label} must be a positive number`);
  return n;
}

function rejectFields(raw: Record<string, unknown>, fields: string[], label: string): void {
  for (const field of fields) {
    if (raw[field] !== undefined) throw new Error(`${label}.${field} is not allowed`);
  }
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
