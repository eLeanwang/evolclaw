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

// 控制 AID 生成走网络——mock 掉，保持单测 hermetic。
// 默认抛错（模拟无网降级），个别用例覆写为成功。
const generateControlAidMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/aun/aid/control-aid.js', () => ({
  generateControlAid: generateControlAidMock,
}));

import { cmdInit } from '../../src/cli/init.js';
import { resolvePaths, _resetRoot } from '../../src/paths.js';
import { loadEvolclawConfig } from '../../src/config-store.js';

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
    generateControlAidMock.mockReset();
    // 默认：模拟无网（Gateway 不可达）→ tail 降级，不写 aid
    generateControlAidMock.mockRejectedValue(new Error('Gateway 不可达'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.EVOLCLAW_HOME;
    _resetRoot();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('rejects existing defaults.json without --force (no defaults rewrite)', async () => {
    const defaultsPath = resolvePaths().defaultsConfig;
    fs.writeFileSync(defaultsPath, JSON.stringify({ $schema_version: 1 }));
    await cmdInit({ nonInteractive: true });
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/已存在|--force/);
    // defaults.json 未被重写（单一出口下该分支不写 defaults，仅落 tail）
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

  it('rejects invalid baseagent (hard error, no tail)', async () => {
    await cmdInit({ nonInteractive: true, baseagent: 'hermes' });
    const allLog = logSpy.mock.calls.flat().join('\n');
    expect(allLog).toMatch(/无效 baseagent|可选/);
    const defaultsPath = resolvePaths().defaultsConfig;
    expect(fs.existsSync(defaultsPath)).toBe(false);
    // 硬错误早返回：不应触达 tail（不调用 generateControlAid）
    expect(generateControlAidMock).not.toHaveBeenCalled();
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

  it('tail generates and writes control AID to evolclaw.json', async () => {
    generateControlAidMock.mockResolvedValue({ aid: 'ec54321.agentid.pub', gateway: 'g' });
    await cmdInit({ nonInteractive: true });
    expect(generateControlAidMock).toHaveBeenCalled();
    const evc = loadEvolclawConfig();
    expect(evc.aid).toBe('ec54321.agentid.pub');
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/已生成控制 AID/);
  });

  it('tail is idempotent: existing aid is not regenerated', async () => {
    // 预置 evolclaw.json 已有 aid
    fs.writeFileSync(path.join(tmpRoot, 'evolclaw.json'),
      JSON.stringify({ $schema_version: 1, aid: 'ec11111.agentid.pub' }));
    await cmdInit({ nonInteractive: true });
    expect(generateControlAidMock).not.toHaveBeenCalled();
    const evc = loadEvolclawConfig();
    expect(evc.aid).toBe('ec11111.agentid.pub');
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/控制 AID 已存在/);
  });

  it('tail graceful degradation when AID generation fails (no aid written)', async () => {
    generateControlAidMock.mockRejectedValue(new Error('Gateway 不可达'));
    await cmdInit({ nonInteractive: true });
    expect(generateControlAidMock).toHaveBeenCalled();
    const evc = loadEvolclawConfig();
    expect(evc.aid).toBeUndefined();
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/控制 AID 生成失败/);
  });

  it('config-exists path still reaches tail (generates AID despite no defaults rewrite)', async () => {
    generateControlAidMock.mockResolvedValue({ aid: 'ec99999.agentid.pub', gateway: 'g' });
    const defaultsPath = resolvePaths().defaultsConfig;
    fs.writeFileSync(defaultsPath, JSON.stringify({ $schema_version: 1, active_baseagent: 'claude' }));
    await cmdInit({ nonInteractive: true }); // exists && !force → 落 tail
    expect(generateControlAidMock).toHaveBeenCalled();
    expect(loadEvolclawConfig().aid).toBe('ec99999.agentid.pub');
  });
});

