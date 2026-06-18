/**
 * 集成测试：evolclaw init --non-interactive（云部署路径）
 *
 * 跑真实 dist/cli/index.js（需要先 npm run build），通过 EVOLCLAW_HOME 隔离 home 目录。
 *
 * 验证目标（单元测试无法覆盖的真实进程边界）：
 * - argv 解析：--owner/--projectpath/--ecweb/--format/--force 真的能透传到 cmdInitNonInteractive
 * - 进程边界：真实退出码 0 / 1 / 2
 * - stdout/stderr 清洁：format=json 下 stdout 仅一行 JSON，无 SDK 噪声
 * - 文件系统：evolclaw.json / defaults.json 落盘内容正确
 * - 重试幂等：相同参数二次执行成功
 *
 * 不验：网络（generateControlAid）→ 用预置 aid 的 evolclaw.json 跳过该路径。
 * 单元测试 cmd-init-non-interactive.test.ts 已覆盖 controlAid 生成失败/成功分支。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_CLI = path.join(REPO_ROOT, 'dist/cli/index.js');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  json: any | null;
}

function setupHome(opts?: { preCreateAid?: string; existingOwners?: string[]; existingEcweb?: any }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-it-init-'));
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  if (opts?.preCreateAid || opts?.existingOwners || opts?.existingEcweb) {
    const cfg: any = { $schema_version: 1 };
    if (opts.preCreateAid) cfg.aid = opts.preCreateAid;
    if (opts.existingOwners) cfg.owners = opts.existingOwners;
    if (opts.existingEcweb) cfg.ecweb = opts.existingEcweb;
    fs.writeFileSync(path.join(root, 'evolclaw.json'), JSON.stringify(cfg));
  }
  return root;
}

function runInit(home: string, args: string[], timeoutMs = 8000): RunResult {
  const r = spawnSync('node', [DIST_CLI, 'init', '--non-interactive', ...args], {
    env: {
      ...process.env,
      EVOLCLAW_HOME: home,
      ANTHROPIC_AUTH_TOKEN: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
    },
    encoding: 'utf-8',
    timeout: timeoutMs,
  });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  let json: any = null;
  const trimmed = stdout.trim();
  if (trimmed.startsWith('{')) {
    try { json = JSON.parse(trimmed.split('\n')[0]); } catch { /* not JSON */ }
  }
  return { stdout, stderr, code: r.status, json };
}

describe('integration: evolclaw init --non-interactive', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`dist/cli/index.js not found; run \`npm run build\` first`);
    }
  });

  it('happy path: writes evolclaw.json owners + emits init.result JSON', () => {
    const home = setupHome({ preCreateAid: 'ec-pre.agentid.pub' });
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
    ]);
    expect(r.code).toBe(0);
    expect(r.json?.type).toBe('init.result');
    expect(r.json?.success).toBe(true);
    expect(r.json?.ownerAid).toBe('alice.agentid.pub');
    expect(r.json?.owners).toEqual(['alice.agentid.pub']);
    expect(r.json?.controlAid).toBe('ec-pre.agentid.pub');

    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'evolclaw.json'), 'utf-8'));
    expect(cfg.owners).toEqual(['alice.agentid.pub']);
    expect(cfg.aid).toBe('ec-pre.agentid.pub');

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('exits 1 with MISSING_OWNER when --owner is absent (json format)', () => {
    const home = setupHome({ preCreateAid: 'ec-pre.agentid.pub' });
    const r = runInit(home, ['--format', 'json']);
    expect(r.code).toBe(1);
    expect(r.json?.success).toBe(false);
    expect(r.json?.error?.code).toBe('MISSING_OWNER');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('exits 1 with OWNER_EXISTS when owner conflicts without --force', () => {
    const home = setupHome({
      preCreateAid: 'ec-pre.agentid.pub',
      existingOwners: ['bob.agentid.pub'],
    });
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
    ]);
    expect(r.code).toBe(1);
    expect(r.json?.error?.code).toBe('OWNER_EXISTS');

    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'evolclaw.json'), 'utf-8'));
    expect(cfg.owners).toEqual(['bob.agentid.pub']);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('--force overrides existing owner and reports previousOwners', () => {
    const home = setupHome({
      preCreateAid: 'ec-pre.agentid.pub',
      existingOwners: ['bob.agentid.pub'],
    });
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
      '--force',
    ]);
    expect(r.code).toBe(0);
    expect(r.json?.success).toBe(true);
    expect(r.json?.forced).toBe(true);
    expect(r.json?.previousOwners).toEqual(['bob.agentid.pub']);

    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'evolclaw.json'), 'utf-8'));
    expect(cfg.owners).toEqual(['alice.agentid.pub']);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes ecweb.enabled and absolute projectpath into config', () => {
    const home = setupHome({ preCreateAid: 'ec-pre.agentid.pub' });
    const projectDir = path.join(home, 'workspace');
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--projectpath', projectDir,
      '--ecweb',
      '--format', 'json',
    ]);
    expect(r.code).toBe(0);
    expect(r.json?.ecwebEnabled).toBe(true);
    expect(r.json?.projectsDefaultPath).toBe(projectDir);

    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'evolclaw.json'), 'utf-8'));
    expect(cfg.ecweb?.enabled).toBe(true);

    const defaultsPath = path.join(home, 'agents', 'defaults.json');
    expect(fs.existsSync(defaultsPath)).toBe(true);
    const defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
    expect(defaults.projects?.defaultPath).toBe(projectDir);

    expect(fs.existsSync(projectDir)).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('idempotent: same command run twice succeeds and config is stable', () => {
    const home = setupHome({ preCreateAid: 'ec-pre.agentid.pub' });
    const args = [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
    ];
    const r1 = runInit(home, args);
    expect(r1.code).toBe(0);
    const cfg1 = fs.readFileSync(path.join(home, 'evolclaw.json'), 'utf-8');

    const r2 = runInit(home, args);
    expect(r2.code).toBe(0);
    expect(r2.json?.forced).toBeUndefined();
    const cfg2 = fs.readFileSync(path.join(home, 'evolclaw.json'), 'utf-8');
    expect(cfg2).toBe(cfg1);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('stdout in --format json is exactly one JSON line (no SDK noise)', () => {
    const home = setupHome({ preCreateAid: 'ec-pre.agentid.pub' });
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
    ]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('init.result');
    expect(parsed.success).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('INVALID_OWNER for malformed AID (exit 1, JSON error)', () => {
    const home = setupHome({ preCreateAid: 'ec-pre.agentid.pub' });
    const r = runInit(home, [
      '--owner', 'not-a-valid-aid',
      '--format', 'json',
    ]);
    expect(r.code).toBe(1);
    expect(r.json?.error?.code).toBe('INVALID_OWNER');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('INVALID_PROJECT_PATH for relative path', () => {
    const home = setupHome({ preCreateAid: 'ec-pre.agentid.pub' });
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--projectpath', 'rel/path',
      '--format', 'json',
    ]);
    expect(r.code).toBe(1);
    expect(r.json?.error?.code).toBe('INVALID_PROJECT_PATH');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('human format (without --format) prints non-JSON summary to stdout', () => {
    const home = setupHome({ preCreateAid: 'ec-pre.agentid.pub' });
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
    ]);
    expect(r.code).toBe(0);
    // 没有 --format json 时，cmdInit 不会分流到非交互式路径，会走交互式 tail。
    // 但带 --owner 时必须分流（cmdInit 的分流条件是 owner 或 format=json）。
    // 实际行为：分流到 cmdInitNonInteractive，emitResult 走 console.log 分支。
    expect(r.stdout).toContain('初始化成功');
    expect(r.stdout).not.toContain('"type":"init.result"');

    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'evolclaw.json'), 'utf-8'));
    expect(cfg.owners).toEqual(['alice.agentid.pub']);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
