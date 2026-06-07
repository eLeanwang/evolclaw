import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _resetRoot } from '../../src/paths.js';

vi.mock('../../src/utils/cross-platform.js', () => ({
  commandExists: vi.fn((cmd: string) => cmd === 'claude' ? false : cmd === 'gemini' ? false : false),
}));

vi.mock('../../src/agents/codex-runner.js', () => ({
  isCodexSdkAvailable: vi.fn(() => true),
}));

describe('codex availability via SDK', () => {
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

  it('agentCreateNonInteractive accepts codex when SDK is available', async () => {
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
