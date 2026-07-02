import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { _resetRoot } from '../../src/paths.js';
import { cmdLinkRules } from '../../src/cli/link-rules.js';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as any);

describe('link-rules', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eck-lr-'));
    originalHome = process.env.EVOLCLAW_HOME;
    originalCwd = process.cwd();
    process.env.EVOLCLAW_HOME = tmpDir;
    _resetRoot();
    fs.mkdirSync(path.join(tmpDir, 'eck'), { recursive: true });
    mockExit.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome !== undefined) {
      process.env.EVOLCLAW_HOME = originalHome;
    } else {
      delete process.env.EVOLCLAW_HOME;
    }
    _resetRoot();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no args shows help', () => {
    const spy = vi.spyOn(console, 'log');
    cmdLinkRules([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Usage: evolclaw link-rules'));
    spy.mockRestore();
  });

  it('--help prints usage', () => {
    const spy = vi.spyOn(console, 'log');
    cmdLinkRules(['--help']);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Usage: evolclaw link-rules'));
    spy.mockRestore();
  });

  it('connect creates symlink in cwd', () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    process.chdir(projectDir);

    cmdLinkRules(['connect']);

    const target = path.join(projectDir, '.claude', 'rules', 'eck');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
  });

  it('connect with --dir uses specified directory', () => {
    const projectDir = path.join(tmpDir, 'myproject');
    fs.mkdirSync(projectDir, { recursive: true });

    cmdLinkRules(['connect', 'cc', '--dir', projectDir]);

    const target = path.join(projectDir, '.claude', 'rules', 'eck');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('connect replaces old link when connecting to new dir', () => {
    const dir1 = path.join(tmpDir, 'proj1');
    const dir2 = path.join(tmpDir, 'proj2');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    cmdLinkRules(['connect', 'cc', '--dir', dir1]);
    const target1 = path.join(dir1, '.claude', 'rules', 'eck');
    expect(fs.existsSync(target1)).toBe(true);

    cmdLinkRules(['connect', 'cc', '--dir', dir2]);
    const target2 = path.join(dir2, '.claude', 'rules', 'eck');
    expect(fs.existsSync(target2)).toBe(true);
    // old link removed
    expect(fs.existsSync(target1)).toBe(false);
  });

  it('disconnect removes link and cleans empty dirs', () => {
    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });

    cmdLinkRules(['connect', 'cc', '--dir', projectDir]);
    const target = path.join(projectDir, '.claude', 'rules', 'eck');
    expect(fs.existsSync(target)).toBe(true);

    cmdLinkRules(['disconnect', 'cc']);
    expect(fs.existsSync(target)).toBe(false);
    // empty parent dirs should be cleaned
    expect(fs.existsSync(path.join(projectDir, '.claude', 'rules'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.claude'))).toBe(false);
  });

  it('disconnect is idempotent', () => {
    // no connection exists — should not throw
    cmdLinkRules(['disconnect', 'cc']);
  });

  it('status shows all baseagents', () => {
    const spy = vi.spyOn(console, 'log');
    cmdLinkRules(['status']);
    const output = spy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('[cc]');
    expect(output).toContain('[codex]');
    expect(output).toContain('[gemini]');
    spy.mockRestore();
  });

  it('status shows connected path after connect', () => {
    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    cmdLinkRules(['connect', 'cc', '--dir', projectDir]);

    const spy = vi.spyOn(console, 'log');
    cmdLinkRules(['status']);
    const output = spy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('connected');
    expect(output).toContain(projectDir);
    spy.mockRestore();
  });

  it('different baseagents have independent connections', () => {
    const dir1 = path.join(tmpDir, 'cc-proj');
    const dir2 = path.join(tmpDir, 'codex-proj');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    cmdLinkRules(['connect', 'cc', '--dir', dir1]);
    cmdLinkRules(['connect', 'codex', '--dir', dir2]);

    expect(fs.existsSync(path.join(dir1, '.claude', 'rules', 'eck'))).toBe(true);
    expect(fs.existsSync(path.join(dir2, '.codex', 'rules', 'eck'))).toBe(true);
  });

  it('connect codex replaces old and cleans empty dirs', () => {
    const dir1 = path.join(tmpDir, 'projA');
    const dir2 = path.join(tmpDir, 'projB');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    cmdLinkRules(['connect', 'codex', '--dir', dir1]);
    expect(fs.existsSync(path.join(dir1, '.codex', 'rules', 'eck'))).toBe(true);

    // connect to new dir — old should be disconnected and cleaned
    cmdLinkRules(['connect', 'codex', '--dir', dir2]);
    expect(fs.existsSync(path.join(dir2, '.codex', 'rules', 'eck'))).toBe(true);
    expect(fs.existsSync(path.join(dir1, '.codex', 'rules', 'eck'))).toBe(false);
    expect(fs.existsSync(path.join(dir1, '.codex'))).toBe(false);
  });

  it('errors on unknown baseagent', () => {
    expect(() => cmdLinkRules(['connect', 'unknown-agent'])).toThrow('process.exit called');
  });

  it('keeps history of last 5 connections', () => {
    for (let i = 1; i <= 6; i++) {
      const dir = path.join(tmpDir, `proj${i}`);
      fs.mkdirSync(dir, { recursive: true });
      cmdLinkRules(['connect', 'cc', '--dir', dir]);
    }

    const spy = vi.spyOn(console, 'log');
    cmdLinkRules(['status']);
    const output = spy.mock.calls.map(c => c[0]).join('\n');
    // should have proj6 as current, and history contains proj5..proj2 (5 entries max)
    expect(output).toContain('proj6');
    expect(output).not.toContain('proj1'); // pushed out of history
    spy.mockRestore();
  });
});
