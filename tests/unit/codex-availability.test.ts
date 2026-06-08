import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _resetRoot } from '../../src/paths.js';

vi.mock('../../src/utils/cross-platform.js', () => ({
  commandExists: vi.fn((cmd: string) => cmd === 'claude' ? false : cmd === 'gemini' ? false : false),
}));

vi.mock('../../src/agents/codex-runner.js', () => ({
  isCodexAppServerAvailable: vi.fn(() => true),
}));

describe('codex availability via app-server', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-codex-avail-'));
    process.env.EVOLCLAW_HOME = tmpRoot;
    _resetRoot();
    fs.mkdirSync(path.join(tmpRoot, 'agents'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.EVOLCLAW_HOME;
    _resetRoot();
  });

  it('cmdInit accepts codex even when no baseagent CLI is on PATH', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { cmdInit } = await import('../../src/cli/init.js');
    await cmdInit({ nonInteractive: true, baseagent: 'codex', force: true });
    const defaultsPath = path.join(tmpRoot, 'agents', 'defaults.json');
    const cfg = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
    expect(cfg.active_baseagent).toBe('codex');
    expect(cfg.baseagents.codex).toBeDefined();
    logSpy.mockRestore();
  });

  it('agentCreateNonInteractive accepts codex when app-server is available', async () => {
    const { agentCreateNonInteractive } = await import('../../src/cli/agent.js');
    const result = await agentCreateNonInteractive({
      aid: 'mybot.agentid.pub',
      baseagent: 'codex',
      project: 'relative/path',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/must be absolute/);
    }
  });
});

describe('session title sanitization', () => {
  it('strips injected system prompt markers from persisted titles', async () => {
    const { displaySessionTitle, sanitizeSessionTitle } = await import('../../src/core/session/session-title.js');
    const polluted = [
      '‹2026-06-08 16:58:01 +08:00 · from:user → self:›',
      '在吗？',
      '',
      '--- [SYSTEM_PROMPT_END] ---',
      '<system-reminder>',
      'EvolClaw Context Kit documents are shown below.',
    ].join('\n');

    expect(sanitizeSessionTitle(polluted)).toBe('在吗？');
    expect(displaySessionTitle(polluted)).not.toContain('SYSTEM_PROMPT_END');
    expect(displaySessionTitle('')).toBe('默认会话');
    expect(displaySessionTitle('...')).toBe('默认会话');
  });

  it('falls back when a polluted title only contains a route prefix', async () => {
    const { displaySessionTitle } = await import('../../src/core/session/session-title.js');
    const title = '‹2026-06-08 16:58:01 +08:00 · from:ou_xxx → self:›';
    expect(displaySessionTitle(title)).toBe('默认会话');
  });
});
