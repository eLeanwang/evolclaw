/**
 * cmdInitNonInteractive 单元测试（云部署路径）
 *
 * 覆盖 docs/evolclaw-init-non-interactive.md §11.3 中可在单元层验证的场景：
 * - MISSING_OWNER：未传 --owner
 * - INVALID_OWNER：AID 非法 / 含逗号空格
 * - INVALID_BASEAGENT：白名单外
 * - INVALID_PROJECT_PATH：相对路径
 * - PROJECT_PATH_CREATE_FAILED：mkdir 失败
 * - OWNER_EXISTS：已有不同 owner 无 --force
 * - CONTROL_AID_CREATE_FAILED：Gateway 不可达
 * - 成功路径：写入 owner / control AID / ecweb，输出 init.result JSON
 * - --force：覆盖 owner，result 含 previousOwners
 * - 幂等：相同 owner 重复执行
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const generateControlAidMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/aun/aid/control-aid.js', () => ({
  generateControlAid: generateControlAidMock,
}));

const scanInstancesMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/instance-registry.js', () => ({
  scanInstances: scanInstancesMock,
}));

const commandExistsMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/cross-platform.js', () => ({
  commandExists: commandExistsMock,
}));

const isCodexAppServerAvailableMock = vi.hoisted(() => vi.fn());
const getCodexAppServerAvailabilityMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/agents/codex-runner.js', () => ({
  isCodexAppServerAvailable: isCodexAppServerAvailableMock,
  getCodexAppServerAvailability: getCodexAppServerAvailabilityMock,
}));

import { cmdInitNonInteractive } from '../../src/cli/init.js';
import { resolvePaths, _resetRoot } from '../../src/paths.js';
import { loadEvolclawConfig } from '../../src/config-store.js';

interface CapturedExit { code: number; result: any | null }

function captureExit(): { capture: CapturedExit; stdoutChunks: string[]; stderrChunks: string[]; restore: () => void } {
  const capture: CapturedExit = { code: -1, result: null };
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    capture.code = code ?? 0;
    throw new Error('__EXIT__');
  }) as any);

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    stdoutChunks.push(s);
    return true;
  });

  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    stderrChunks.push(s);
    return true;
  });

  return {
    capture,
    stdoutChunks,
    stderrChunks,
    restore: () => {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

async function runInit(opts: any): Promise<{ exitCode: number; result: any | null; stdout: string; stderr: string }> {
  const { capture, stdoutChunks, stderrChunks, restore } = captureExit();
  try {
    await cmdInitNonInteractive(opts);
  } catch (e: any) {
    if (e.message !== '__EXIT__') throw e;
  } finally {
    restore();
  }
  const stdout = stdoutChunks.join('');
  const stderr = stderrChunks.join('');
  // 函数正常返回（未调 process.exit）→ exitCode 0
  const exitCode = capture.code === -1 ? 0 : capture.code;
  let result: any = null;
  const trimmed = stdout.trim();
  if (trimmed) {
    try { result = JSON.parse(trimmed.split('\n')[0]); } catch { /* not JSON */ }
  }
  return { exitCode, result, stdout, stderr };
}

describe('cmdInitNonInteractive', () => {
  let tmpRoot: string;
  let logSpy: any;
  let errSpy: any;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-ni-init-'));
    process.env.EVOLCLAW_HOME = tmpRoot;
    _resetRoot();
    fs.mkdirSync(path.join(tmpRoot, 'agents'), { recursive: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    generateControlAidMock.mockReset();
    generateControlAidMock.mockResolvedValue({ aid: 'ec77777.agentid.pub', gateway: 'g' });
    scanInstancesMock.mockReset();
    scanInstancesMock.mockReturnValue({ mains: [], monitors: [], aids: [] });
    commandExistsMock.mockReset();
    commandExistsMock.mockReturnValue(true);
    isCodexAppServerAvailableMock.mockReset();
    isCodexAppServerAvailableMock.mockReturnValue(false);
    getCodexAppServerAvailabilityMock.mockReset();
    getCodexAppServerAvailabilityMock.mockReturnValue({ available: false, reason: 'not installed' });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.EVOLCLAW_HOME;
    _resetRoot();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('MISSING_OWNER when --owner is absent', async () => {
    const { exitCode, result } = await runInit({ format: 'json' });
    expect(exitCode).toBe(1);
    expect(result?.success).toBe(false);
    expect(result?.error?.code).toBe('MISSING_OWNER');
  });

  it('INVALID_OWNER when owner contains comma', async () => {
    const { exitCode, result } = await runInit({ owner: 'a.agentid.pub,b.agentid.pub', format: 'json' });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('INVALID_OWNER');
  });

  it('INVALID_OWNER when owner is malformed', async () => {
    const { exitCode, result } = await runInit({ owner: 'not-a-valid-aid', format: 'json' });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('INVALID_OWNER');
  });

  it('INVALID_BASEAGENT for unknown baseagent', async () => {
    const { exitCode, result } = await runInit({
      owner: 'alice.agentid.pub',
      baseagent: 'hermes',
      format: 'json',
    });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('INVALID_BASEAGENT');
  });

  it('INVALID_PROJECT_PATH for relative path', async () => {
    const { exitCode, result } = await runInit({
      owner: 'alice.agentid.pub',
      projectpath: 'rel/path',
      format: 'json',
    });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('INVALID_PROJECT_PATH');
  });

  it('OWNER_EXISTS when prior owner differs and --force absent', async () => {
    fs.writeFileSync(
      resolvePaths().evolclawJson,
      JSON.stringify({ $schema_version: 1, aid: 'ec11111.agentid.pub', owners: ['bob.agentid.pub'] }),
    );
    const { exitCode, result } = await runInit({ owner: 'alice.agentid.pub', format: 'json' });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('OWNER_EXISTS');
  });

  it('CONTROL_AID_CREATE_FAILED when gateway is unreachable', async () => {
    generateControlAidMock.mockRejectedValueOnce(new Error('gateway down'));
    const { exitCode, result } = await runInit({ owner: 'alice.agentid.pub', format: 'json' });
    expect(exitCode).toBe(2);
    expect(result?.error?.code).toBe('CONTROL_AID_CREATE_FAILED');
  });

  it('happy path: writes owner + control AID + ecweb, emits init.result', async () => {
    const projectDir = path.join(tmpRoot, 'workspace');
    const { exitCode, result, stdout } = await runInit({
      owner: 'alice.agentid.pub',
      baseagent: undefined,
      projectpath: projectDir,
      ecweb: true,
      format: 'json',
    });
    expect(exitCode).toBe(0);
    expect(result?.type).toBe('init.result');
    expect(result?.success).toBe(true);
    expect(result?.ownerAid).toBe('alice.agentid.pub');
    expect(result?.owners).toEqual(['alice.agentid.pub']);
    expect(result?.controlAid).toBe('ec77777.agentid.pub');
    expect(result?.ecwebEnabled).toBe(true);
    expect(result?.projectsDefaultPath).toBe(projectDir);
    expect(result?.forced).toBeUndefined();
    // stdout 必须是单行 JSON
    expect(stdout.trim().split('\n').length).toBe(1);

    const cfg = loadEvolclawConfig();
    expect(cfg.aid).toBe('ec77777.agentid.pub');
    expect(cfg.owners).toEqual(['alice.agentid.pub']);
    expect(cfg.ecweb?.enabled).toBe(true);
    expect(fs.existsSync(projectDir)).toBe(true);
  });

  it('--force overrides existing different owner with previousOwners in result', async () => {
    fs.writeFileSync(
      resolvePaths().evolclawJson,
      JSON.stringify({ $schema_version: 1, aid: 'ec11111.agentid.pub', owners: ['bob.agentid.pub'] }),
    );
    const { exitCode, result } = await runInit({
      owner: 'alice.agentid.pub',
      format: 'json',
      force: true,
    });
    expect(exitCode).toBe(0);
    expect(result?.success).toBe(true);
    expect(result?.forced).toBe(true);
    expect(result?.previousOwners).toEqual(['bob.agentid.pub']);
    expect(result?.controlAid).toBe('ec11111.agentid.pub'); // 复用已有 aid
    expect(loadEvolclawConfig().owners).toEqual(['alice.agentid.pub']);
  });

  it('idempotent: same owner without --force succeeds', async () => {
    fs.writeFileSync(
      resolvePaths().evolclawJson,
      JSON.stringify({ $schema_version: 1, aid: 'ec22222.agentid.pub', owners: ['alice.agentid.pub'] }),
    );
    const { exitCode, result } = await runInit({ owner: 'alice.agentid.pub', format: 'json' });
    expect(exitCode).toBe(0);
    expect(result?.success).toBe(true);
    expect(result?.forced).toBeUndefined();
    expect(result?.controlAid).toBe('ec22222.agentid.pub');
  });

  it('human format prints to stdout only summary line, not JSON', async () => {
    const { exitCode, stdout } = await runInit({ owner: 'alice.agentid.pub' });
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('init.result');
  });

  it('DAEMON_RUNNING when main process is alive', async () => {
    scanInstancesMock.mockReturnValue({
      mains: [{ alive: true, record: { pid: 9999 } }],
      monitors: [],
      aids: [],
    });
    const { exitCode, result } = await runInit({ owner: 'alice.agentid.pub', format: 'json' });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('DAEMON_RUNNING');
  });

  it('BASEAGENT_UNAVAILABLE when no baseagent CLI detected', async () => {
    commandExistsMock.mockReturnValue(false);
    const { exitCode, result } = await runInit({ owner: 'alice.agentid.pub', format: 'json' });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('BASEAGENT_UNAVAILABLE');
  });

  it('BASEAGENT_UNAVAILABLE when specified baseagent is not in PATH', async () => {
    commandExistsMock.mockImplementation((cmd: string) => cmd !== 'codex');
    isCodexAppServerAvailableMock.mockReturnValue(false);
    getCodexAppServerAvailabilityMock.mockReturnValue({ available: false, reason: 'not installed' });
    const { exitCode, result } = await runInit({ owner: 'alice.agentid.pub', baseagent: 'codex', format: 'json' });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('BASEAGENT_UNAVAILABLE');
  });

  it('INVALID_OWNER when owner contains space', async () => {
    const { exitCode, result } = await runInit({ owner: 'a.agentid.pub b.agentid.pub', format: 'json' });
    expect(exitCode).toBe(1);
    expect(result?.error?.code).toBe('INVALID_OWNER');
  });

  it('does not overwrite existing ecweb config when --ecweb is not set', async () => {
    fs.writeFileSync(
      resolvePaths().evolclawJson,
      JSON.stringify({ $schema_version: 1, aid: 'ec11111.agentid.pub', owners: ['alice.agentid.pub'], ecweb: { enabled: true, port: 9999 } }),
    );
    const { exitCode } = await runInit({ owner: 'alice.agentid.pub', format: 'json' });
    expect(exitCode).toBe(0);
    const cfg = loadEvolclawConfig();
    expect(cfg.ecweb?.enabled).toBe(true);
    expect(cfg.ecweb?.port).toBe(9999);
  });

  it('reuses existing controlAid without regenerating', async () => {
    fs.writeFileSync(
      resolvePaths().evolclawJson,
      JSON.stringify({ $schema_version: 1, aid: 'ec-existing.agentid.pub' }),
    );
    const { exitCode, result } = await runInit({ owner: 'alice.agentid.pub', format: 'json' });
    expect(exitCode).toBe(0);
    expect(result?.controlAid).toBe('ec-existing.agentid.pub');
    expect(generateControlAidMock).not.toHaveBeenCalled();
  });

  it('stdout is clean JSON only in format=json (no console.log leakage)', async () => {
    const { exitCode, stdout } = await runInit({
      owner: 'alice.agentid.pub',
      projectpath: path.join(tmpRoot, 'proj'),
      ecweb: true,
      format: 'json',
    });
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('init.result');
    expect(parsed.success).toBe(true);
  });

  it('PROJECT_PATH_CREATE_FAILED when mkdir throws', async () => {
    const badPath = path.join(tmpRoot, 'no-perm', 'sub');
    fs.writeFileSync(path.join(tmpRoot, 'no-perm'), 'file-not-dir');
    const { exitCode, result } = await runInit({
      owner: 'alice.agentid.pub',
      projectpath: badPath,
      format: 'json',
    });
    expect(exitCode).toBe(2);
    expect(result?.error?.code).toBe('PROJECT_PATH_CREATE_FAILED');
  });
});
