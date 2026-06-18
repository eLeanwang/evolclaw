/**
 * 集成测试：deploy-server 视角的部署 happy path
 *
 * 角色：模拟 deploy-server 调用 evolclaw CLI 并消费输出。
 *
 * 跑真实 dist/cli/index.js（需要先 npm run build），通过 EVOLCLAW_HOME 隔离 home 目录。
 *
 * 验证目标（跨命令边界，单测覆盖不到）：
 * - init.result JSON schema 完整：deploy-server 解析得到的字段够拼出部署状态
 * - 关键路径（defaultsPath/evolclawPath）真实存在
 * - controlAid 在 init 和 evolclaw.json 中一致
 * - owner 在 init.result 和 evolclaw.json 中一致
 * - 重试（部署侧 retry）→ 第二次 init 输出 schema 与第一次相同
 *
 * 不验：
 * - agent new 命令（依赖真实 AUN Gateway，CI 无法跑）→ deploy 完整流程的人工验收手册见 docs/evolclaw-init-non-interactive.md
 * - daemon start（依赖 AUN 连接）→ 同上
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

interface InitResult {
  type: 'init.result';
  success: boolean;
  controlAid?: string;
  ownerAid?: string;
  owners?: string[];
  ecwebEnabled?: boolean;
  baseagent?: string;
  projectsDefaultPath?: string | null;
  defaultsPath?: string;
  evolclawPath?: string;
  forced?: boolean;
  previousOwners?: string[];
  error?: { code: string; message: string };
}

function setupHome(preCreateAid: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-deploy-'));
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  // 预置 controlAid 跳过 Gateway 网络依赖（单测已覆盖 generateControlAid 路径）
  fs.writeFileSync(path.join(root, 'evolclaw.json'), JSON.stringify({
    $schema_version: 1,
    aid: preCreateAid,
  }));
  return root;
}

function runInit(home: string, args: string[], timeoutMs = 8000): { code: number | null; result: InitResult | null; raw: string } {
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
  let result: InitResult | null = null;
  const line = stdout.trim().split('\n')[0];
  if (line?.startsWith('{')) {
    try { result = JSON.parse(line); } catch { /* not JSON */ }
  }
  return { code: r.status, result, raw: stdout };
}

describe('integration: deploy-server happy path', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`dist/cli/index.js not found; run \`npm run build\` first`);
    }
  });

  it('init.result JSON contains all fields deploy-server needs to render status', () => {
    const home = setupHome('ec-ctrl.agentid.pub');
    const projectDir = path.join(home, 'workspace');
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--projectpath', projectDir,
      '--ecweb',
      '--format', 'json',
    ]);

    expect(r.code).toBe(0);
    expect(r.result?.success).toBe(true);

    // deploy-server 必须能从这条 JSON 拼出：controlAid（远程 menu 目标）+ owners（鉴权名单）+ 配置文件位置（运维介入）
    expect(r.result?.controlAid).toBe('ec-ctrl.agentid.pub');
    expect(r.result?.ownerAid).toBe('alice.agentid.pub');
    expect(r.result?.owners).toEqual(['alice.agentid.pub']);
    expect(r.result?.ecwebEnabled).toBe(true);
    expect(r.result?.baseagent).toMatch(/^(claude|codex|gemini)$/);
    expect(r.result?.projectsDefaultPath).toBe(projectDir);
    expect(r.result?.defaultsPath).toBeDefined();
    expect(r.result?.evolclawPath).toBeDefined();

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('init.result paths point to real files on disk', () => {
    const home = setupHome('ec-ctrl.agentid.pub');
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
    ]);

    expect(r.code).toBe(0);
    expect(fs.existsSync(r.result!.defaultsPath!)).toBe(true);
    expect(fs.existsSync(r.result!.evolclawPath!)).toBe(true);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('controlAid + ownerAid in init.result match what was written to evolclaw.json', () => {
    const home = setupHome('ec-ctrl.agentid.pub');
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
    ]);

    expect(r.code).toBe(0);
    const onDisk = JSON.parse(fs.readFileSync(r.result!.evolclawPath!, 'utf-8'));
    expect(onDisk.aid).toBe(r.result!.controlAid);
    expect(onDisk.owners).toEqual(r.result!.owners);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('init.result baseagent matches defaults.json active_baseagent', () => {
    const home = setupHome('ec-ctrl.agentid.pub');
    const r = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
    ]);

    expect(r.code).toBe(0);
    const defaults = JSON.parse(fs.readFileSync(r.result!.defaultsPath!, 'utf-8'));
    expect(defaults.active_baseagent).toBe(r.result!.baseagent);
    expect(defaults.baseagents[r.result!.baseagent!]).toBeDefined();

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('deploy retry: re-running with same owner is idempotent (same JSON shape)', () => {
    const home = setupHome('ec-ctrl.agentid.pub');
    const args = [
      '--owner', 'alice.agentid.pub',
      '--projectpath', path.join(home, 'workspace'),
      '--ecweb',
      '--format', 'json',
    ];

    const r1 = runInit(home, args);
    expect(r1.code).toBe(0);
    expect(r1.result?.success).toBe(true);
    expect(r1.result?.forced).toBeUndefined();

    const r2 = runInit(home, args);
    expect(r2.code).toBe(0);
    expect(r2.result?.success).toBe(true);
    expect(r2.result?.forced).toBeUndefined();

    // 关键字段在两次执行间稳定
    expect(r2.result?.controlAid).toBe(r1.result?.controlAid);
    expect(r2.result?.ownerAid).toBe(r1.result?.ownerAid);
    expect(r2.result?.ecwebEnabled).toBe(r1.result?.ecwebEnabled);
    expect(r2.result?.projectsDefaultPath).toBe(r1.result?.projectsDefaultPath);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('deploy reset: --force replaces owner and reports previousOwners for audit', () => {
    const home = setupHome('ec-ctrl.agentid.pub');

    const r1 = runInit(home, [
      '--owner', 'bob.agentid.pub',
      '--format', 'json',
    ]);
    expect(r1.code).toBe(0);

    const r2 = runInit(home, [
      '--owner', 'alice.agentid.pub',
      '--format', 'json',
      '--force',
    ]);
    expect(r2.code).toBe(0);
    expect(r2.result?.forced).toBe(true);
    expect(r2.result?.previousOwners).toEqual(['bob.agentid.pub']);
    expect(r2.result?.ownerAid).toBe('alice.agentid.pub');

    const onDisk = JSON.parse(fs.readFileSync(r2.result!.evolclawPath!, 'utf-8'));
    expect(onDisk.owners).toEqual(['alice.agentid.pub']);

    fs.rmSync(home, { recursive: true, force: true });
  });

  it('failure JSON shape is parseable: deploy-server can route by error.code', () => {
    const home = setupHome('ec-ctrl.agentid.pub');
    const r = runInit(home, [
      '--owner', 'not-a-valid-aid',
      '--format', 'json',
    ]);

    expect(r.code).toBe(1);
    expect(r.result?.success).toBe(false);
    expect(r.result?.error?.code).toBeDefined();
    expect(r.result?.error?.message).toBeDefined();
    expect(typeof r.result?.error?.code).toBe('string');

    fs.rmSync(home, { recursive: true, force: true });
  });
});
