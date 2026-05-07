import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

const CLI = resolve(import.meta.dirname, '../../dist/cli.js');

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, EVOLCLAW_HOME: '/tmp/evolclaw-test-nonexist' },
      timeout: 5000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', code: e.status ?? 1 };
  }
}

describe('evolclaw init routing', () => {
  it('rejects unknown channel name', () => {
    const r = run(['init', 'wework']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('不支持的渠道: wework');
    expect(r.stderr).toContain('支持的渠道:');
  });

  it('rejects another unknown channel', () => {
    const r = run(['init', 'slack']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('不支持的渠道: slack');
  });

  it('does not reject --non-interactive as a channel name', () => {
    const r = run(['init', '--non-interactive', '--default-path', '/tmp']);
    // Should not error with "不支持的渠道"
    expect(r.stderr).not.toContain('不支持的渠道');
  });

  it('does not reject --help as a channel name', () => {
    const r = run(['init', '--help']);
    expect(r.stderr).not.toContain('不支持的渠道');
  });

  it('lists all supported channels in error message', () => {
    const r = run(['init', 'xyz']);
    const supported = ['feishu', 'wechat', 'aun', 'dingtalk', 'qqbot', 'wecom'];
    for (const ch of supported) {
      expect(r.stderr).toContain(ch);
    }
  });
});
