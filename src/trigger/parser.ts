import { CronExpressionParser } from 'cron-parser';
import type { TriggerScheduleType } from '../types.js';
import type {
  TriggerEffort,
  TriggerExecutionThread,
  TriggerExecutionType,
  TriggerFeedbackStrategy,
  TriggerPermissionMode,
} from './types.js';

export interface ParsedTriggerSet {
  scheduleType: TriggerScheduleType;
  scheduleValue: string;
  timezone?: string;
  executionType: TriggerExecutionType;
  feedbackStrategy: TriggerFeedbackStrategy;
  targetChannel?: string;
  targetChannelId?: string;
  targetSession: 'main' | 'thread';
  targetThreadId?: string;
  agentId?: string;
  name?: string;
  prompt?: string;
  scriptPath?: string;
  scriptRuntime?: string;
  scriptArgs?: unknown;
  scriptTimeoutMs?: number;
  triggerThread?: TriggerExecutionThread;
  maxRuns?: number;
  maxDuration?: string;
  model?: string;
  effort?: TriggerEffort;
  permissionMode?: TriggerPermissionMode;
}

export type ParseResult =
  | { ok: true; value: ParsedTriggerSet }
  | { ok: false; error: string };

export interface ParsedTriggerUpdate {
  scheduleType?: TriggerScheduleType;
  scheduleValue?: string;
  timezone?: string;
  executionType?: TriggerExecutionType;
  feedbackStrategy?: TriggerFeedbackStrategy;
  targetChannel?: string;
  targetChannelId?: string;
  targetSession?: 'main' | 'thread';
  targetThreadId?: string;
  agentId?: string;
  name?: string;
  prompt?: string;
  scriptPath?: string | null;
  scriptRuntime?: string | null;
  scriptArgs?: unknown;
  scriptTimeoutMs?: number;
  triggerThread?: TriggerExecutionThread;
  maxRuns?: number;
  maxDuration?: string;
  model?: string;
  effort?: TriggerEffort;
  permissionMode?: TriggerPermissionMode;
}

export type UpdateParseResult =
  | { ok: true; nameOrId: string; value: ParsedTriggerUpdate }
  | { ok: false; error: string };

// Note: unquoted multi-word values (e.g. --prompt=hello world) are not supported.
// The second word would be treated as an unknown token. Always quote multi-word values:
//   --prompt "hello world"  or  --prompt='hello world'
function parseFlags(args: string): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  const re = /--(\w[\w-]*)(?:=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)|(?:\s+(?!--)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+))?)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3];
    flags.set(key, val === undefined ? true : val.replace(/^["']|["']$/g, ''));
  }
  return flags;
}

export function parseDuration(s: string): number | null {
  const m = /^([1-9]\d*)([dhms])$/.exec(s.trim().toLowerCase());
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2];
  const multiplier = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
  return amount * multiplier;
}

export function parseIsoDate(s: string): number | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getTime();
}

export function validateCronExpr(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

function parsePositiveIntegerFlag(flags: Map<string, string | true>, name: string, label: string): { ok: true; value?: number } | { ok: false; error: string } {
  if (!flags.has(name)) return { ok: true };
  const raw = flags.get(name);
  if (!raw || raw === true) return { ok: false, error: `${label} 不能为空` };
  if (!/^[1-9]\d*$/.test(raw)) return { ok: false, error: `${label} 必须是正整数` };
  return { ok: true, value: Number(raw) };
}

function parseDurationFlag(flags: Map<string, string | true>, name: string, label: string): { ok: true; value?: number } | { ok: false; error: string } {
  if (!flags.has(name)) return { ok: true };
  const raw = flags.get(name);
  if (!raw || raw === true) return { ok: false, error: `${label} 不能为空` };
  const value = parseDuration(raw);
  if (value === null) return { ok: false, error: `${label} 支持格式：30s、15m、2h、1d` };
  return { ok: true, value };
}

function parseLimitDurationFlag(flags: Map<string, string | true>, name: string, label: string): { ok: true; value?: string } | { ok: false; error: string } {
  if (!flags.has(name)) return { ok: true };
  const raw = flags.get(name);
  if (!raw || raw === true) return { ok: false, error: `${label} 不能为空` };
  if (!/^[1-9]\d*(s|m|h|d)$/.test(raw)) return { ok: false, error: `${label} 支持格式：30s、15m、2h、1d` };
  return { ok: true, value: raw };
}

const PERMISSION_MODES = new Set<TriggerPermissionMode>([
  'auto',
  'bypass',
  'readonly',
  'plan',
  'edit',
  'request',
  'noask',
]);

const TRIGGER_EFFORTS = new Set<TriggerEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

function parsePermissionModeFlag(flags: Map<string, string | true>): { ok: true; value?: TriggerPermissionMode } | { ok: false; error: string } {
  if (!flags.has('permission')) return { ok: true };
  const raw = flags.get('permission');
  if (!raw || raw === true) return { ok: false, error: '--permission 不能为空' };
  if (!PERMISSION_MODES.has(raw as TriggerPermissionMode)) {
    return { ok: false, error: '--permission 只接受 auto、bypass、readonly、plan、edit、request 或 noask' };
  }
  return { ok: true, value: raw as TriggerPermissionMode };
}

function parseModelFlag(flags: Map<string, string | true>): { ok: true; value?: string } | { ok: false; error: string } {
  if (!flags.has('model')) return { ok: true };
  const raw = flags.get('model');
  if (!raw || raw === true) return { ok: false, error: '--model 不能为空' };
  return { ok: true, value: raw as string };
}

function parseEffortFlag(flags: Map<string, string | true>): { ok: true; value?: TriggerEffort } | { ok: false; error: string } {
  if (!flags.has('effort')) return { ok: true };
  const raw = flags.get('effort');
  if (!raw || raw === true) return { ok: false, error: '--effort 不能为空' };
  if (!TRIGGER_EFFORTS.has(raw as TriggerEffort)) {
    return { ok: false, error: '--effort 只接受 low、medium、high、xhigh 或 max' };
  }
  return { ok: true, value: raw as TriggerEffort };
}

function rejectDeprecatedFlags(flags: Map<string, string | true>): string | undefined {
  if (flags.has('mode')) return '--mode 已废弃，请使用 --exec script|trigger-session|target-session';
  if (flags.has('session')) return '--session 已废弃，请使用 --feedback/--target-session 或 --trigger-thread';
  if (flags.has('thread')) return '--thread 已废弃，请使用 --target-thread-id';
  if (flags.has('script')) return '--script 已废弃，请使用 --exec script --script-path';
  if (flags.has('runtime')) return '--runtime 已废弃，请使用 --script-runtime';
  if (flags.has('channel') || flags.has('channelid')) return '--channel/--channelid 已废弃，请使用 --target-channel/--target-channel-id';
  return undefined;
}

function parseExecutionType(flags: Map<string, string | true>): { ok: true; value?: TriggerExecutionType } | { ok: false; error: string } {
  if (!flags.has('exec')) return { ok: true };
  const raw = flags.get('exec');
  if (!raw || raw === true) return { ok: false, error: '--exec 不能为空' };
  if (raw === 'script') return { ok: true, value: 'script' };
  if (raw === 'trigger-session' || raw === 'trigger_session') return { ok: true, value: 'trigger_session' };
  if (raw === 'target-session' || raw === 'target_session') return { ok: true, value: 'target_session' };
  return { ok: false, error: '--exec 只接受 script、trigger-session 或 target-session' };
}

function parseFeedbackStrategy(flags: Map<string, string | true>): { ok: true; value?: TriggerFeedbackStrategy } | { ok: false; error: string } {
  if (!flags.has('feedback')) return { ok: true };
  const raw = flags.get('feedback');
  if (!raw || raw === true) return { ok: false, error: '--feedback 不能为空' };
  if (raw === 'origin' || raw === 'target' || raw === 'silent') return { ok: true, value: raw };
  return { ok: false, error: '--feedback 只接受 origin、target 或 silent' };
}

function parseTriggerThread(flags: Map<string, string | true>): { ok: true; value?: TriggerExecutionThread } | { ok: false; error: string } {
  if (!flags.has('trigger-thread')) return { ok: true };
  const raw = flags.get('trigger-thread');
  if (!raw || raw === true) return { ok: false, error: '--trigger-thread 不能为空' };
  if (raw === 'per-run') return { ok: true, value: 'per_run' };
  if (raw === 'by-trigger') return { ok: true, value: 'by_trigger' };
  if (raw === 'per_run' || raw === 'by_trigger') return { ok: true, value: raw };
  return { ok: false, error: '--trigger-thread 只接受 per-run 或 by-trigger' };
}

function parseTargetSession(flags: Map<string, string | true>): { ok: true; value?: 'main' | 'thread' } | { ok: false; error: string } {
  if (!flags.has('target-session')) return { ok: true };
  const raw = flags.get('target-session');
  if (!raw || raw === true) return { ok: false, error: '--target-session 不能为空' };
  if (raw === 'main' || raw === 'thread') return { ok: true, value: raw };
  return { ok: false, error: '--target-session 只接受 main 或 thread' };
}

function parseSourceFlags(flags: Map<string, string | true>, opts: { update?: boolean } = {}): { ok: true; scheduleType?: TriggerScheduleType; scheduleValue?: string; timezone?: string } | { ok: false; error: string } {
  const hasOnce = flags.has('once');
  const hasDelay = flags.has('delay');
  const hasAt = flags.has('at');
  const hasCron = flags.has('cron');
  const hasEvery = flags.has('every');
  const hasEvent = flags.has('event');
  const count = [hasOnce, hasDelay, hasAt, hasCron, hasEvery, hasEvent].filter(Boolean).length;
  if (!opts.update && count === 0) {
    return { ok: false, error: '必须指定触发参数：--once | --delay <时长> | --at <ISO时间> | --cron <表达式> | --every <时长> | --event <事件模式>' };
  }
  if (count > 1) return { ok: false, error: '--once、--delay、--at、--cron、--every、--event 互斥，只能指定一个' };
  if (count === 0) return { ok: true };

  if (hasOnce) return { ok: true, scheduleType: 'once', scheduleValue: '' };
  if (hasDelay) {
    const raw = flags.get('delay');
    if (!raw || raw === true) return { ok: false, error: '--delay 不能为空' };
    const ms = parseDuration(raw);
    if (ms === null) return { ok: false, error: `无法解析 --delay "${raw}"，支持格式：30s、15m、2h、1d` };
    return { ok: true, scheduleType: 'delay', scheduleValue: String(ms) };
  }
  if (hasAt) {
    const raw = flags.get('at');
    if (!raw || raw === true) return { ok: false, error: '--at 不能为空' };
    const ts = parseIsoDate(raw);
    if (ts === null) return { ok: false, error: `无法解析 --at "${raw}"，请使用 ISO 格式，如 2026-05-15T09:00` };
    if (!opts.update && ts <= Date.now()) return { ok: false, error: `--at 时间已过期：${raw}` };
    return { ok: true, scheduleType: 'at', scheduleValue: new Date(ts).toISOString() };
  }
  if (hasCron) {
    const raw = flags.get('cron');
    if (!raw || raw === true) return { ok: false, error: '--cron 不能为空' };
    if (!validateCronExpr(raw)) {
      const truncated = /^[\d*/,-]+$/.test(raw) && /--cron\s+\S+\s+[*\d]/.test(String(raw));
      const hint = truncated ? '（看起来 cron 表达式被空格截断了，请用引号包裹）' : '（需 5 段：分 时 日 月 周，如 */15 * * * *）';
      return { ok: false, error: `无效的 cron 表达式："${raw}" ${hint}` };
    }
    const timezone = flags.has('tz') ? flags.get('tz') : undefined;
    if (timezone === true) return { ok: false, error: '--tz 不能为空' };
    return { ok: true, scheduleType: 'cron', scheduleValue: raw, timezone: timezone as string | undefined };
  }
  if (hasEvery) {
    const raw = flags.get('every');
    if (!raw || raw === true) return { ok: false, error: '--every 不能为空' };
    const ms = parseDuration(raw);
    if (ms === null) return { ok: false, error: `无法解析 --every "${raw}"，支持格式：30s、15m、2h、1d` };
    return { ok: true, scheduleType: 'interval', scheduleValue: String(ms) };
  }
  const raw = flags.get('event');
  if (!raw || raw === true) return { ok: false, error: '--event 不能为空' };
  return { ok: true, scheduleType: 'event', scheduleValue: raw };
}

function commonParsed(flags: Map<string, string | true>, opts: { update?: boolean } = {}) {
  const deprecated = rejectDeprecatedFlags(flags);
  if (deprecated) return { ok: false as const, error: deprecated };

  const source = parseSourceFlags(flags, opts);
  if (!source.ok) return source;

  if (flags.has('tz') && source.scheduleType !== 'cron') {
    return { ok: false as const, error: '--tz 只能和 --cron 一起使用' };
  }

  const execution = parseExecutionType(flags);
  if (!execution.ok) return execution;

  const feedback = parseFeedbackStrategy(flags);
  if (!feedback.ok) return feedback;

  const triggerThread = parseTriggerThread(flags);
  if (!triggerThread.ok) return triggerThread;

  const targetSession = parseTargetSession(flags);
  if (!targetSession.ok) return targetSession;

  const scriptTimeout = parseDurationFlag(flags, 'script-timeout', '--script-timeout');
  if (!scriptTimeout.ok) return scriptTimeout;

  const maxRuns = parsePositiveIntegerFlag(flags, 'max-runs', '--max-runs');
  if (!maxRuns.ok) return maxRuns;

  const maxDuration = parseLimitDurationFlag(flags, 'max-duration', '--max-duration');
  if (!maxDuration.ok) return maxDuration;

  const model = parseModelFlag(flags);
  if (!model.ok) return model;

  const effort = parseEffortFlag(flags);
  if (!effort.ok) return effort;

  const permissionMode = parsePermissionModeFlag(flags);
  if (!permissionMode.ok) return permissionMode;

  let scriptArgs: unknown;
  if (flags.has('script-args')) {
    const raw = flags.get('script-args');
    if (!raw || raw === true) return { ok: false as const, error: '--script-args 不能为空' };
    try {
      scriptArgs = JSON.parse(raw);
    } catch {
      return { ok: false as const, error: '--script-args 必须是合法的 JSON' };
    }
  }

  const prompt = flags.get('prompt');
  if (prompt === true) return { ok: false as const, error: '--prompt 不能为空' };
  if (typeof prompt === 'string' && prompt.length > 4096) return { ok: false as const, error: '--prompt 超过 4096 字符限制' };

  const scriptPath = flags.get('script-path');
  if (scriptPath === true) return { ok: false as const, error: '--script-path 不能为空' };
  const scriptRuntime = flags.get('script-runtime');
  if (scriptRuntime === true) return { ok: false as const, error: '--script-runtime 不能为空' };
  if (scriptRuntime !== undefined && scriptRuntime !== 'node' && scriptRuntime !== 'python' && scriptRuntime !== 'bash') {
    return { ok: false as const, error: '--script-runtime 只接受 node、python 或 bash' };
  }

  const targetChannel = flags.get('target-channel');
  if (targetChannel === true) return { ok: false as const, error: '--target-channel 不能为空' };
  const targetChannelId = flags.get('target-channel-id');
  if (targetChannelId === true) return { ok: false as const, error: '--target-channel-id 不能为空' };
  const targetThreadId = flags.get('target-thread-id');
  if (targetThreadId === true) return { ok: false as const, error: '--target-thread-id 不能为空' };

  const hasTargetField = targetChannel !== undefined || targetChannelId !== undefined || targetSession.value !== undefined || targetThreadId !== undefined;
  if ((targetChannel === undefined) !== (targetChannelId === undefined)) {
    return { ok: false as const, error: '--target-channel 与 --target-channel-id 必须同时指定或同时省略' };
  }

  const inferredExecution = execution.value ?? (scriptPath ? 'script' : 'target_session');
  if (inferredExecution === 'script') {
    if (!scriptPath && !opts.update) return { ok: false as const, error: '--exec script 需要 --script-path' };
    if (scriptPath && !scriptRuntime && !opts.update) return { ok: false as const, error: '--script-path 必须配合 --script-runtime 使用（node|python|bash）' };
  } else if (!prompt && !opts.update) {
    return { ok: false as const, error: '--prompt 为必填项' };
  }

  const targetSessionValue = targetSession.value ?? (targetThreadId ? 'thread' : 'main');
  const feedbackStrategy = feedback.value ?? (hasTargetField ? 'target' : 'origin');

  return {
    ok: true as const,
    value: {
      ...source,
      executionType: execution.value,
      inferredExecution,
      feedbackStrategy,
      targetChannel: targetChannel as string | undefined,
      targetChannelId: targetChannelId as string | undefined,
      targetSession: targetSessionValue,
      targetThreadId: targetThreadId as string | undefined,
      agentId: flags.has('agent') ? flags.get('agent') as string : undefined,
      name: flags.has('name') ? flags.get('name') as string : undefined,
      prompt: prompt as string | undefined,
      scriptPath: scriptPath as string | undefined,
      scriptRuntime: scriptRuntime as string | undefined,
      scriptArgs,
      scriptTimeoutMs: scriptTimeout.value,
      triggerThread: triggerThread.value,
      maxRuns: maxRuns.value,
      maxDuration: maxDuration.value,
      model: model.value,
      effort: effort.value,
      permissionMode: permissionMode.value,
    },
  };
}

export function parseTriggerSet(args: string): ParseResult {
  const flags = parseFlags(args);
  const parsed = commonParsed(flags);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  return {
    ok: true,
    value: {
      scheduleType: value.scheduleType!,
      scheduleValue: value.scheduleValue ?? '',
      timezone: value.timezone,
      executionType: value.inferredExecution,
      feedbackStrategy: value.feedbackStrategy,
      targetChannel: value.targetChannel,
      targetChannelId: value.targetChannelId,
      targetSession: value.targetSession,
      targetThreadId: value.targetThreadId,
      agentId: value.agentId,
      name: value.name,
      prompt: value.prompt,
      scriptPath: value.scriptPath,
      scriptRuntime: value.scriptRuntime,
      scriptArgs: value.scriptArgs,
      scriptTimeoutMs: value.scriptTimeoutMs,
      triggerThread: value.triggerThread,
      maxRuns: value.maxRuns,
      maxDuration: value.maxDuration,
      model: value.model,
      effort: value.effort,
      permissionMode: value.permissionMode,
    },
  };
}

export function parseTriggerUpdate(args: string): UpdateParseResult {
  const trimmed = args.trim();
  if (!trimmed) return { ok: false, error: '用法：/trigger update <名称|ID> [--参数...]' };

  let nameOrId: string;
  let rest: string;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    if (end === -1) return { ok: false, error: '名称引号未闭合' };
    nameOrId = trimmed.slice(1, end);
    rest = trimmed.slice(end + 1).trim();
  } else {
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) return { ok: false, error: '至少需要指定一个修改参数（如 --prompt、--delay、--event 等）' };
    nameOrId = trimmed.slice(0, spaceIdx);
    rest = trimmed.slice(spaceIdx + 1).trim();
  }
  if (!rest) return { ok: false, error: '至少需要指定一个修改参数（如 --prompt、--delay、--event 等）' };

  const flags = parseFlags(rest);
  if (flags.size === 0) return { ok: false, error: '至少需要指定一个修改参数（如 --prompt、--delay、--event 等）' };
  const parsed = commonParsed(flags, { update: true });
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  const update: ParsedTriggerUpdate = {};
  if (value.scheduleType !== undefined) update.scheduleType = value.scheduleType;
  if (value.scheduleValue !== undefined) update.scheduleValue = value.scheduleValue;
  if (value.timezone !== undefined) update.timezone = value.timezone;
  if (value.executionType !== undefined) update.executionType = value.inferredExecution;
  if (flags.has('feedback')) update.feedbackStrategy = value.feedbackStrategy;
  if (value.targetChannel !== undefined) update.targetChannel = value.targetChannel;
  if (value.targetChannelId !== undefined) update.targetChannelId = value.targetChannelId;
  if (flags.has('target-session') || value.targetThreadId !== undefined) update.targetSession = value.targetSession;
  if (value.targetThreadId !== undefined) update.targetThreadId = value.targetThreadId;
  if (value.agentId !== undefined) update.agentId = value.agentId;
  if (value.name !== undefined) update.name = value.name;
  if (value.prompt !== undefined) update.prompt = value.prompt;
  if (value.scriptPath !== undefined) update.scriptPath = value.scriptPath;
  if (value.scriptRuntime !== undefined) update.scriptRuntime = value.scriptRuntime;
  if (value.scriptArgs !== undefined) update.scriptArgs = value.scriptArgs;
  if (value.scriptTimeoutMs !== undefined) update.scriptTimeoutMs = value.scriptTimeoutMs;
  if (value.triggerThread !== undefined) update.triggerThread = value.triggerThread;
  if (value.maxRuns !== undefined) update.maxRuns = value.maxRuns;
  if (value.maxDuration !== undefined) update.maxDuration = value.maxDuration;
  if (value.model !== undefined) update.model = value.model;
  if (value.effort !== undefined) update.effort = value.effort;
  if (value.permissionMode !== undefined) update.permissionMode = value.permissionMode;
  return { ok: true, nameOrId, value: update };
}
