import { CronExpressionParser } from 'cron-parser';
import type { TriggerScheduleType, TriggerSessionStrategy } from '../../types.js';

export interface ParsedTriggerSet {
  scheduleType: TriggerScheduleType;
  scheduleValue: string;
  targetChannel?: string;
  targetChannelId?: string;
  targetThreadId?: string;
  targetSessionStrategy: TriggerSessionStrategy;
  agentId?: string;
  name?: string;
  prompt: string;
}

export type ParseResult =
  | { ok: true; value: ParsedTriggerSet }
  | { ok: false; error: string };

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

export function parseTriggerSet(args: string): ParseResult {
  const flags = parseFlags(args);

  const hasDelay = flags.has('delay');
  const hasAt = flags.has('at');
  const hasCron = flags.has('cron');
  const timeCount = [hasDelay, hasAt, hasCron].filter(Boolean).length;

  if (timeCount === 0) {
    return { ok: false, error: '必须指定时间参数：--delay <时长> | --at <ISO时间> | --cron <表达式>' };
  }
  if (timeCount > 1) {
    return { ok: false, error: '--delay、--at、--cron 互斥，只能指定一个' };
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
  } else {
    const raw = flags.get('cron') as string;
    if (!validateCronExpr(raw)) {
      return { ok: false, error: `无效的 cron 表达式："${raw}"` };
    }
    scheduleType = 'cron';
    scheduleValue = raw;
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
    if (sv !== 'latest' && sv !== 'silent') {
      return { ok: false, error: '--session 只接受 latest 或 silent' };
    }
    targetSessionStrategy = sv;
  }

  return {
    ok: true,
    value: {
      scheduleType,
      scheduleValue,
      targetChannel: hasChannel ? (flags.get('channel') as string) : undefined,
      targetChannelId: hasChannelId ? (flags.get('channelid') as string) : undefined,
      targetThreadId: hasThread ? (flags.get('thread') as string) : undefined,
      targetSessionStrategy,
      agentId: flags.has('agent') ? (flags.get('agent') as string) : undefined,
      name: flags.has('name') ? (flags.get('name') as string) : undefined,
      prompt: prompt as string,
    },
  };
}
