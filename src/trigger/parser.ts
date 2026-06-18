import { CronExpressionParser } from 'cron-parser';
import type { TriggerScheduleType, TriggerSessionStrategy } from '../types.js';

export interface ParsedTriggerSet {
  scheduleType: TriggerScheduleType;
  scheduleValue: string;
  timezone?: string;  // cron timezone
  targetChannel?: string;
  targetChannelId?: string;
  targetThreadId?: string;
  targetSessionStrategy: TriggerSessionStrategy;
  agentId?: string;
  name?: string;
  prompt: string;
  scriptPath?: string;
  scriptRuntime?: string;
  scriptArgs?: unknown;
  mode?: 'agent-runner' | 'direct-message';
  onFailure?: 'notify' | 'silent';
  onNoop?: 'notify' | 'silent';
}

export type ParseResult =
  | { ok: true; value: ParsedTriggerSet }
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
    if (val === undefined) {
      flags.set(key, true);
    } else {
      flags.set(key, val.replace(/^["']|["']$/g, ''));
    }
  }
  return flags;
}

export function parseDuration(s: string): number | null {
  const re = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const m = re.exec(s.trim().toLowerCase());
  if (!m || !s.trim()) return null;
  const [, d, h, min, sec] = m;
  const total =
    (parseInt(d ?? '0') * 86400 +
      parseInt(h ?? '0') * 3600 +
      parseInt(min ?? '0') * 60 +
      parseInt(sec ?? '0')) * 1000;
  return total > 0 ? total : null;
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

export interface ParsedTriggerUpdate {
  scheduleType?: TriggerScheduleType;
  scheduleValue?: string;
  timezone?: string;  // cron timezone
  nextFireAt?: number;  // Calculated by caller if schedule changed
  targetChannel?: string;
  targetChannelId?: string;
  targetChannelType?: string;  // Recomputed by caller when targetChannel changes
  targetThreadId?: string;
  targetSessionStrategy?: TriggerSessionStrategy;
  boundSessionId?: string;  // Rebound by caller per session strategy
  agentId?: string;
  name?: string;
  prompt?: string;
  scriptPath?: string;
  scriptRuntime?: string;
  scriptArgs?: unknown;
  mode?: 'agent-runner' | 'direct-message';
  onFailure?: 'notify' | 'silent';
  onNoop?: 'notify' | 'silent';
}

export type UpdateParseResult =
  | { ok: true; nameOrId: string; value: ParsedTriggerUpdate }
  | { ok: false; error: string };

export function parseTriggerUpdate(args: string): UpdateParseResult {
  // First token is the trigger name/id, rest is flags
  const trimmed = args.trim();
  if (!trimmed) {
    return { ok: false, error: '用法：/trigger update <名称|ID> [--参数...]' };
  }

  // Extract nameOrId: first non-flag token (could be quoted)
  let nameOrId: string;
  let rest: string;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    if (end === -1) {
      return { ok: false, error: '名称引号未闭合' };
    }
    nameOrId = trimmed.slice(1, end);
    rest = trimmed.slice(end + 1).trim();
  } else {
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      return { ok: false, error: '至少需要指定一个修改参数（如 --prompt、--delay 等）' };
    }
    nameOrId = trimmed.slice(0, spaceIdx);
    rest = trimmed.slice(spaceIdx + 1).trim();
  }

  if (!rest) {
    return { ok: false, error: '至少需要指定一个修改参数（如 --prompt、--delay 等）' };
  }

  const flags = parseFlags(rest);
  if (flags.size === 0) {
    return { ok: false, error: '至少需要指定一个修改参数（如 --prompt、--delay 等）' };
  }

  const result: ParsedTriggerUpdate = {};

  // Parse schedule if provided (only one allowed)
  const hasDelay = flags.has('delay');
  const hasAt = flags.has('at');
  const hasCron = flags.has('cron');
  const hasEvery = flags.has('every');
  const timeCount = [hasDelay, hasAt, hasCron, hasEvery].filter(Boolean).length;
  if (timeCount > 1) {
    return { ok: false, error: '--delay、--at、--cron、--every 互斥，只能指定一个' };
  }
  if (hasDelay) {
    const raw = flags.get('delay') as string;
    const ms = parseDuration(raw);
    if (ms === null) return { ok: false, error: `无法解析 --delay "${raw}"，支持格式：30m、2h、1d、2h30m` };
    result.scheduleType = 'delay';
    result.scheduleValue = String(ms);
  } else if (hasAt) {
    const raw = flags.get('at') as string;
    const ts = parseIsoDate(raw);
    if (ts === null) return { ok: false, error: `无法解析 --at "${raw}"，请使用 ISO 格式，如 2026-05-15T09:00` };
    if (ts <= Date.now()) return { ok: false, error: `--at 时间已过期：${raw}` };
    result.scheduleType = 'at';
    result.scheduleValue = new Date(ts).toISOString();
  } else if (hasCron) {
    const raw = flags.get('cron') as string;
    if (!validateCronExpr(raw)) {
      const truncated = /^[\d*/,-]+$/.test(raw) && /--cron\s+\S+\s+[*\d]/.test(args);
      const hint = truncated ? '（看起来 cron 表达式被空格截断了，请用引号包裹，如 --cron \'*/15 * * * *\'）' : '（需 5 段：分 时 日 月 周，如 */15 * * * *）';
      return { ok: false, error: `无效的 cron 表达式："${raw}" ${hint}` };
    }
    result.scheduleType = 'cron';
    result.scheduleValue = raw;
  } else if (hasEvery) {
    const raw = flags.get('every');
    if (!raw || raw === true) return { ok: false, error: '--every 不能为空' };
    const ms = parseDuration(raw);
    if (ms === null) return { ok: false, error: `无法解析 --every "${raw}"，支持格式：30m、2h、1d、2h30m` };
    result.scheduleType = 'interval';
    result.scheduleValue = String(ms);
  }

  // Parse optional fields
  if (flags.has('prompt')) {
    const prompt = flags.get('prompt');
    if (!prompt || prompt === true) return { ok: false, error: '--prompt 不能为空' };
    if (typeof prompt === 'string' && prompt.length > 4096) return { ok: false, error: '--prompt 超过 4096 字符限制' };
    result.prompt = prompt as string;
  }

  if (flags.has('name')) {
    const name = flags.get('name');
    if (!name || name === true) return { ok: false, error: '--name 不能为空' };
    result.name = name as string;
  }

  if (flags.has('session')) {
    const sv = flags.get('session') as string;
    if (sv !== 'latest' && sv !== 'current' && sv !== 'thread') return { ok: false, error: '--session 只接受 latest、current 或 thread' };
    result.targetSessionStrategy = sv;
  }

  if (flags.has('agent')) {
    const agent = flags.get('agent');
    if (!agent || agent === true) return { ok: false, error: '--agent 不能为空' };
    result.agentId = agent as string;
  }

  const hasChannel = flags.has('channel');
  const hasChannelId = flags.has('channelid');
  if (hasChannel !== hasChannelId) {
    return { ok: false, error: '--channel 与 --channelid 必须同时指定或同时省略' };
  }
  if (hasChannel) {
    result.targetChannel = flags.get('channel') as string;
    result.targetChannelId = flags.get('channelid') as string;
  }

  if (flags.has('thread')) {
    if (flags.has('session')) return { ok: false, error: '--thread 与 --session 互斥' };
    result.targetThreadId = flags.get('thread') as string;
  }

  // Parse optional new fields
  if (flags.has('tz')) {
    result.timezone = flags.get('tz') as string;
  }

  if (flags.has('script')) {
    const scriptPath = flags.get('script');
    if (!scriptPath || scriptPath === true) return { ok: false, error: '--script 不能为空' };
    result.scriptPath = scriptPath;
  }

  if (flags.has('runtime')) {
    const runtime = flags.get('runtime') as string;
    if (runtime !== 'node' && runtime !== 'python' && runtime !== 'bash') {
      return { ok: false, error: '--runtime 只接受 node、python 或 bash' };
    }
    result.scriptRuntime = runtime;
  }

  if (flags.has('script-args')) {
    const raw = flags.get('script-args') as string;
    try {
      result.scriptArgs = JSON.parse(raw);
    } catch {
      return { ok: false, error: '--script-args 必须是合法的 JSON' };
    }
  }

  if (flags.has('mode')) {
    const m = flags.get('mode') as string;
    if (m !== 'agent' && m !== 'direct') {
      return { ok: false, error: '--mode 只接受 agent 或 direct' };
    }
    result.mode = m === 'direct' ? 'direct-message' : 'agent-runner';
  }

  if (flags.has('on-fail')) {
    const f = flags.get('on-fail') as string;
    if (f !== 'notify' && f !== 'silent') {
      return { ok: false, error: '--on-fail 只接受 notify 或 silent' };
    }
    result.onFailure = f;
  }

  if (flags.has('on-noop')) {
    const n = flags.get('on-noop') as string;
    if (n !== 'notify' && n !== 'silent') {
      return { ok: false, error: '--on-noop 只接受 notify 或 silent' };
    }
    result.onNoop = n;
  }

  return { ok: true, nameOrId, value: result };
}

export function parseTriggerSet(args: string): ParseResult {
  const flags = parseFlags(args);

  const hasDelay = flags.has('delay');
  const hasAt = flags.has('at');
  const hasCron = flags.has('cron');
  const hasEvery = flags.has('every');
  const timeCount = [hasDelay, hasAt, hasCron, hasEvery].filter(Boolean).length;

  if (timeCount === 0) {
    return { ok: false, error: '必须指定时间参数：--delay <时长> | --at <ISO时间> | --cron <表达式> | --every <时长>' };
  }
  if (timeCount > 1) {
    return { ok: false, error: '--delay、--at、--cron、--every 互斥，只能指定一个' };
  }

  let scheduleType: TriggerScheduleType;
  let scheduleValue: string;

  if (hasDelay) {
    const raw = flags.get('delay') as string;
    const ms = parseDuration(raw);
    if (ms === null) {
      return { ok: false, error: `无法解析 --delay "${raw}"，支持格式：30m、2h、1d、2h30m` };
    }
    scheduleType = 'delay';
    scheduleValue = String(ms);
  } else if (hasAt) {
    const raw = flags.get('at') as string;
    const ts = parseIsoDate(raw);
    if (ts === null) {
      return { ok: false, error: `无法解析 --at "${raw}"，请使用 ISO 格式，如 2026-05-15T09:00` };
    }
    if (ts <= Date.now()) {
      return { ok: false, error: `--at 时间已过期：${raw}` };
    }
    scheduleType = 'at';
    scheduleValue = new Date(ts).toISOString();
  } else if (hasCron) {
    const raw = flags.get('cron') as string;
    if (!validateCronExpr(raw)) {
      // Detect likely space-truncation: raw looks like one cron segment and args contains space-separated * or digits after it
      const truncated = /^[\d*/,-]+$/.test(raw) && /--cron\s+\S+\s+[*\d]/.test(args);
      const hint = truncated ? '（看起来 cron 表达式被空格截断了，请用引号包裹，如 --cron \'*/15 * * * *\'）' : '（需 5 段：分 时 日 月 周，如 */15 * * * *）';
      return { ok: false, error: `无效的 cron 表达式："${raw}" ${hint}` };
    }
    scheduleType = 'cron';
    scheduleValue = raw;
  } else {
    const raw = flags.get('every');
    if (!raw || raw === true) {
      return { ok: false, error: '--every 不能为空' };
    }
    const ms = parseDuration(raw);
    if (ms === null) {
      return { ok: false, error: `无法解析 --every "${raw}"，支持格式：30m、2h、1d、2h30m` };
    }
    scheduleType = 'interval';
    scheduleValue = String(ms);
  }

  const prompt = flags.get('prompt');
  if (!prompt || prompt === true) {
    return { ok: false, error: '--prompt 为必填项' };
  }
  if (typeof prompt === 'string' && prompt.length > 4096) {
    return { ok: false, error: '--prompt 超过 4096 字符限制' };
  }

  const hasThread = flags.has('thread');
  const hasSession = flags.has('session');
  if (hasThread && hasSession) {
    return { ok: false, error: '--thread 与 --session 互斥，只能指定一个' };
  }

  const hasChannel = flags.has('channel');
  const hasChannelId = flags.has('channelid');
  if (hasChannel !== hasChannelId) {
    return { ok: false, error: '--channel 与 --channelid 必须同时指定或同时省略' };
  }

  let targetSessionStrategy: TriggerSessionStrategy = 'latest';
  if (hasSession) {
    const sv = flags.get('session') as string;
    if (sv !== 'latest' && sv !== 'current' && sv !== 'thread') {
      return { ok: false, error: '--session 只接受 latest、current 或 thread' };
    }
    targetSessionStrategy = sv;
  }

  // Parse optional timezone (only for cron)
  let timezone: string | undefined;
  if (flags.has('tz')) {
    if (scheduleType !== 'cron') {
      return { ok: false, error: '--tz 只能和 --cron 一起使用' };
    }
    timezone = flags.get('tz') as string;
  }

  // Parse optional script
  let scriptPath: string | undefined;
  let scriptRuntime: string | undefined;
  let scriptArgs: unknown;
  if (flags.has('script')) {
    const sp = flags.get('script');
    if (!sp || sp === true) {
      return { ok: false, error: '--script 不能为空' };
    }
    scriptPath = sp;
    if (!flags.has('runtime')) {
      return { ok: false, error: '--script 必须配合 --runtime 使用（node|python|bash）' };
    }
    const rt = flags.get('runtime');
    if (!rt || rt === true) {
      return { ok: false, error: '--runtime 不能为空' };
    }
    if (rt !== 'node' && rt !== 'python' && rt !== 'bash') {
      return { ok: false, error: '--runtime 只接受 node、python 或 bash' };
    }
    scriptRuntime = rt;
    if (flags.has('script-args')) {
      const raw = flags.get('script-args') as string;
      try {
        scriptArgs = JSON.parse(raw);
      } catch {
        return { ok: false, error: '--script-args 必须是合法的 JSON' };
      }
    }
  } else if (flags.has('runtime')) {
    return { ok: false, error: '--runtime 必须配合 --script 使用' };
  }

  // Parse optional mode
  let mode: 'agent-runner' | 'direct-message' | undefined;
  if (flags.has('mode')) {
    const m = flags.get('mode') as string;
    if (m !== 'agent' && m !== 'direct') {
      return { ok: false, error: '--mode 只接受 agent 或 direct' };
    }
    mode = m === 'direct' ? 'direct-message' : 'agent-runner';
  }

  // Parse optional on-fail / on-noop
  let onFailure: 'notify' | 'silent' | undefined;
  if (flags.has('on-fail')) {
    const f = flags.get('on-fail') as string;
    if (f !== 'notify' && f !== 'silent') {
      return { ok: false, error: '--on-fail 只接受 notify 或 silent' };
    }
    onFailure = f;
  }

  let onNoop: 'notify' | 'silent' | undefined;
  if (flags.has('on-noop')) {
    const n = flags.get('on-noop') as string;
    if (n !== 'notify' && n !== 'silent') {
      return { ok: false, error: '--on-noop 只接受 notify 或 silent' };
    }
    onNoop = n;
  }

  return {
    ok: true,
    value: {
      scheduleType,
      scheduleValue,
      timezone,
      targetChannel: hasChannel ? (flags.get('channel') as string) : undefined,
      targetChannelId: hasChannelId ? (flags.get('channelid') as string) : undefined,
      targetThreadId: hasThread ? (flags.get('thread') as string) : undefined,
      targetSessionStrategy,
      agentId: flags.has('agent') ? (flags.get('agent') as string) : undefined,
      name: flags.has('name') ? (flags.get('name') as string) : undefined,
      prompt: prompt as string,
      scriptPath,
      scriptRuntime,
      scriptArgs,
      mode,
      onFailure,
      onNoop,
    },
  };
}
