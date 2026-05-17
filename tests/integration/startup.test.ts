/**
 * 集成测试：启动期主流程（不连 AUN，只验"加载 + 引导"链路）
 *
 * 跑真正的 dist/index.js（需要先 npm run build），通过 EVOLCLAW_HOME 隔离 home 目录。
 * 用例：
 *   - 完全空 home → 应 fail-fast，提示 `evolclaw aid new`
 *   - 一个合法 self-agent 但缺凭证 → 应进 anthropic resolve 失败的退出路径（不进 IPC 启动）
 *
 * 不验：channel 实际连接 / IPC server / 真实消息收发——这些超出"启动期"边界。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_INDEX = path.join(REPO_ROOT, 'dist/index.js');

function setupHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-it-'));
  return root;
}

function runEvolclaw(home: string, timeoutMs = 8000): { stdout: string; stderr: string; code: number | null } {
  const r = spawnSync('node', [DIST_INDEX], {
    env: {
      ...process.env,
      EVOLCLAW_HOME: home,
      // 防止真去连 AUN——把所有可能的 baseagent 凭证置空
      ANTHROPIC_AUTH_TOKEN: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
    },
    encoding: 'utf-8',
    timeout: timeoutMs,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

describe('integration: startup', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_INDEX)) {
      throw new Error(`dist/index.js not found; run \`npm run build\` first`);
    }
  });

  it('fails fast with helpful message when no self-agent configured', () => {
    const home = setupHome();
    fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
    const r = runEvolclaw(home);
    expect(r.code).toBe(1);
    const all = r.stdout + r.stderr;
    expect(all).toContain('No self-agent configured');
    expect(all).toContain('evolclaw aid new');
  });

  it('skips invalid agent dirs and reports them in error message', () => {
    const home = setupHome();
    const agentsDir = path.join(home, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // 非法 AID 目录
    fs.mkdirSync(path.join(agentsDir, 'not-an-aid'));
    fs.writeFileSync(path.join(agentsDir, 'not-an-aid', 'config.json'), '{}');
    // 缺 config.json
    fs.mkdirSync(path.join(agentsDir, 'orphan.agentid.pub'));
    const r = runEvolclaw(home);
    expect(r.code).toBe(1);
    const all = r.stdout + r.stderr;
    expect(all).toContain('No self-agent configured');
    expect(all).toContain('not-an-aid');
    expect(all).toContain('orphan.agentid.pub');
  });

  it('proceeds past agent loading when at least one valid self-agent exists', () => {
    const home = setupHome();
    const agentsDir = path.join(home, 'agents');
    const aliceDir = path.join(agentsDir, 'alice.agentid.pub');
    fs.mkdirSync(aliceDir, { recursive: true });
    fs.writeFileSync(path.join(aliceDir, 'config.json'), JSON.stringify({
      $schema_version: 1,
      aid: 'alice.agentid.pub',
      enabled: true,
      owners: [],
      channels: [{ type: 'aun', name: 'main' }],
      active_baseagent: 'claude',
      baseagents: { claude: {} },
      projects: { defaultPath: home },
    }));

    const r = runEvolclaw(home);
    const all = r.stdout + r.stderr;

    // 启动应该走过 self-agent 加载阶段，被 anthropic 凭证缺失阻止——
    // 这个错误信息只能在 baseagent resolve 阶段抛出，证明 agent loading 通过了
    expect(all).toMatch(/No API key found/);
    expect(all).toMatch(/baseagents\.claude\.apiKey/);
    expect(r.code).not.toBe(0);
  });
});
