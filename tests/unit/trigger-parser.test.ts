import { describe, it, expect } from 'vitest';
import { parseTriggerSet, parseDuration, parseIsoDate, validateCronExpr } from '../../src/core/trigger/parser.js';

describe('parseDuration', () => {
  it('parses minutes', () => expect(parseDuration('30m')).toBe(30 * 60 * 1000));
  it('parses hours', () => expect(parseDuration('2h')).toBe(2 * 3600 * 1000));
  it('parses days', () => expect(parseDuration('1d')).toBe(86400 * 1000));
  it('parses combined', () => expect(parseDuration('2h30m')).toBe((2 * 3600 + 30 * 60) * 1000));
  it('parses seconds', () => expect(parseDuration('10s')).toBe(10 * 1000));
  it('returns null for empty', () => expect(parseDuration('')).toBeNull());
  it('returns null for zero', () => expect(parseDuration('0m')).toBeNull());
  it('returns null for invalid', () => expect(parseDuration('abc')).toBeNull());
});

describe('validateCronExpr', () => {
  it('accepts valid cron', () => expect(validateCronExpr('0 9 * * *')).toBe(true));
  it('rejects invalid cron', () => expect(validateCronExpr('not-a-cron')).toBe(false));
  it('accepts every minute', () => expect(validateCronExpr('* * * * *')).toBe(true));
});

describe('parseTriggerSet', () => {
  it('parses delay', () => {
    const r = parseTriggerSet('--delay 30m --prompt "check CI"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scheduleType).toBe('delay');
    expect(r.value.scheduleValue).toBe(String(30 * 60 * 1000));
    expect(r.value.prompt).toBe('check CI');
  });

  it('parses cron', () => {
    const r = parseTriggerSet('--cron "0 9 * * *" --prompt "daily report"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scheduleType).toBe('cron');
    expect(r.value.scheduleValue).toBe('0 9 * * *');
  });

  it('parses session silent', () => {
    const r = parseTriggerSet('--delay 1h --session silent --prompt "cleanup"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.targetSessionStrategy).toBe('silent');
  });

  it('defaults session to latest', () => {
    const r = parseTriggerSet('--delay 1h --prompt "test"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.targetSessionStrategy).toBe('latest');
  });

  it('parses optional name', () => {
    const r = parseTriggerSet('--delay 1h --name my-trigger --prompt "test"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe('my-trigger');
  });

  it('errors on missing time', () => {
    const r = parseTriggerSet('--prompt "test"');
    expect(r.ok).toBe(false);
  });

  it('errors on multiple time params', () => {
    const r = parseTriggerSet('--delay 1h --at 2026-05-15T09:00 --prompt "test"');
    expect(r.ok).toBe(false);
  });

  it('errors on missing prompt', () => {
    const r = parseTriggerSet('--delay 1h');
    expect(r.ok).toBe(false);
  });

  it('errors on thread + session together', () => {
    const r = parseTriggerSet('--delay 1h --thread t1 --session latest --prompt "test"');
    expect(r.ok).toBe(false);
  });

  it('errors on channel without channelid', () => {
    const r = parseTriggerSet('--delay 1h --channel feishu-main --prompt "test"');
    expect(r.ok).toBe(false);
  });

  it('errors on invalid session value', () => {
    const r = parseTriggerSet('--delay 1h --session new --prompt "test"');
    expect(r.ok).toBe(false);
  });

  it('errors on invalid cron', () => {
    const r = parseTriggerSet('--cron "not-valid" --prompt "test"');
    expect(r.ok).toBe(false);
  });

  it('errors on prompt too long', () => {
    const r = parseTriggerSet(`--delay 1h --prompt "${'x'.repeat(4097)}"`);
    expect(r.ok).toBe(false);
  });
});
