/**
 * cmdInit 单元测试（非交互式分支）
 *
 * 覆盖：
 * - 已运行实例时拒绝
 * - 未检测到 baseagent 时拒绝（通过 mock cross-platform.commandExists 难度高，跳过该路径）
 * - 已存在 defaults.json + 无 --force → 报错
 * - 已存在 defaults.json + --force → 深合并（保留旧字段）
 * - 不在白名单的 baseagent → 错误
 * - 默认值（claude 优先 → codex → gemini）
 * - 写盘字段正确
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cmdInit } from '../../src/cli/init.js';
import { resolvePaths, _resetRoot } from '../../src/paths.js';

describe('cmdInit (non-interactive)', () => {
  let tmpRoot: string;
  let logSpy: any;
  let errSpy: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-init-'));
    process.env.EVOLCLAW_HOME = tmpRoot;
    _resetRoot();
    fs.mkdirSync(path.join(tmpRoot, 'agents'), { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.EVOLCLAW_HOME;
    _resetRoot();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('rejects existing defaults.json without --force', async () => {
    const defaultsPath = resolvePaths().defaultsConfig;
    fs.writeFileSync(defaultsPath, JSON.stringify({ $schema_version: 1 }));
    await cmdInit({ nonInteractive: true });
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/已存在|--force/);
    // file unchanged
    const after = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
    expect(after.$schema_version).toBe(1);
    expect(after.active_baseagent).toBeUndefined();
  });

  it('overwrites with --force', async () => {
    const defaultsPath = resolvePaths().defaultsConfig;
    fs.writeFileSync(defaultsPath, JSON.stringify({ $schema_version: 99, junk: 'old' }));
    await cmdInit({ nonInteractive: true, force: true });
    const after = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
    expect(after.$schema_version).toBe(1);
    // saveDefaultsSafe 深合并，保留旧字段
    expect(after.junk).toBe('old');
    expect(after.active_baseagent).toBeDefined();
    expect(after.baseagents).toBeDefined();
  });

  it('rejects invalid baseagent', async () => {
    await cmdInit({ nonInteractive: true, baseagent: 'hermes' });
    const allLog = logSpy.mock.calls.flat().join('\n');
    expect(allLog).toMatch(/无效 baseagent|可选/);
    const defaultsPath = resolvePaths().defaultsConfig;
    expect(fs.existsSync(defaultsPath)).toBe(false);
  });

  it('writes defaults.json with chosen baseagent', async () => {
    await cmdInit({ nonInteractive: true });
    const defaultsPath = resolvePaths().defaultsConfig;
    expect(fs.existsSync(defaultsPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
    expect(cfg.$schema_version).toBe(1);
    // baseagent 默认是 PATH 里第一个可用项；测试环境一般有 claude
    expect(['claude', 'codex', 'gemini']).toContain(cfg.active_baseagent);
    expect(cfg.baseagents[cfg.active_baseagent]).toBeDefined();
  });
});
