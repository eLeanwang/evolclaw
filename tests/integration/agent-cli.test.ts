/**
 * 集成测试：agent CLI 命令集
 *
 * 跑真正的 dist/cli/index.js（需要先 npm run build），通过 EVOLCLAW_HOME + AUN_HOME 隔离环境。
 * 验证：
 *   - 所有命令的退出码、文本输出、JSON 输出
 *   - 命令链路：create → list → show → enable/disable → get/set → rename → delete
 *   - 跨平台路径斜杠归一化
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_CLI = path.join(REPO_ROOT, 'dist/cli/index.js');

let TEST_HOME: string;
let TEST_AUN: string;

function setupHome(): void {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-agent-it-'));
  TEST_AUN = path.join(TEST_HOME, '.aun');
  fs.mkdirSync(TEST_AUN, { recursive: true });
}

function runCli(args: string[], timeoutMs = 10000): { stdout: string; stderr: string; code: number | null } {
  const r = spawnSync('node', [DIST_CLI, ...args], {
    env: {
      ...process.env,
      EVOLCLAW_HOME: TEST_HOME,
      AUN_HOME: TEST_AUN,
    },
    encoding: 'utf-8',
    timeout: timeoutMs,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function seedAgent(aid: string, enabled = true): void {
  const agentDir = path.join(TEST_HOME, 'agents', aid);
  fs.mkdirSync(agentDir, { recursive: true });
  // 配置体系 v2：H 字段进 config.json，HA 字段（active_baseagent/baseagents）进 behavior.json。
  const config = {
    $schema_version: 1,
    aid,
    enabled,
    channels: [],
    projects: { defaultPath: '/tmp/test' },
  };
  fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify(config, null, 2));
  const behavior = { $schema_version: 1, active_baseagent: 'claude', baseagents: { claude: {} } };
  fs.writeFileSync(path.join(agentDir, 'behavior.json'), JSON.stringify(behavior, null, 2));
}

function seedAgentMd(aid: string, name: string, description = ''): void {
  const aidDir = path.join(TEST_HOME, 'AIDs', aid);
  fs.mkdirSync(aidDir, { recursive: true });
  const content = `---
aid: "${aid}"
name: "${name}"
description: "${description}"
---
`;
  fs.writeFileSync(path.join(aidDir, 'agent.md'), content);
}

describe('integration: agent CLI', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`dist/cli/index.js not found; run \`npm run build\` first`);
    }
  });

  beforeEach(() => {
    setupHome();
  });

  describe('agent help', () => {
    it('prints help text', () => {
      const r = runCli(['agent', 'help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/用法: evolclaw agent/);
      expect(r.stdout).toMatch(/list/);
      expect(r.stdout).toMatch(/show/);
      expect(r.stdout).toMatch(/enable/);
      expect(r.stdout).toMatch(/disable/);
      expect(r.stdout).toMatch(/get/);
      expect(r.stdout).toMatch(/set/);
      expect(r.stdout).toMatch(/rename/);
      expect(r.stdout).toMatch(/delete/);
      expect(r.stdout).toMatch(/--format json/);
    });
  });

  describe('agent list', () => {
    it('shows "No agents configured" when empty', () => {
      const r = runCli(['agent', 'list']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/No agents configured/);
    });

    it('--format json returns empty agents array', () => {
      const r = runCli(['agent', 'list', '--format', 'json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.agents).toEqual([]);
    });

    it('lists seeded agents', () => {
      seedAgent('alice.agentid.pub');
      seedAgent('bob.agentid.pub', false);
      const r = runCli(['agent', 'list']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/alice\.agentid\.pub/);
      expect(r.stdout).toMatch(/bob\.agentid\.pub/);
    });

    it('--format json returns structured list', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'list', '--format', 'json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0].aid).toBe('alice.agentid.pub');
    });
  });

  describe('agent show', () => {
    it('returns error for missing agent', () => {
      const r = runCli(['agent', 'show', 'missing.agentid.pub']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/not found/);
    });

    it('shows agent details', () => {
      seedAgent('alice.agentid.pub');
      seedAgentMd('alice.agentid.pub', 'Alice', 'My agent');
      const r = runCli(['agent', 'show', 'alice.agentid.pub']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/alice\.agentid\.pub/);
      expect(r.stdout).toMatch(/Alice/);
      expect(r.stdout).toMatch(/My agent/);
      expect(r.stdout).toMatch(/Baseagent:\s*claude/);
      expect(r.stdout).toMatch(/Paths/);
      expect(r.stdout).toMatch(/Agent\.md:/);
    });

    it('--format json returns structured detail', () => {
      seedAgent('alice.agentid.pub');
      seedAgentMd('alice.agentid.pub', 'Alice', 'desc');
      const r = runCli(['agent', 'show', 'alice.agentid.pub', '--format', 'json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.aid).toBe('alice.agentid.pub');
      expect(parsed.identity.name).toBe('Alice');
      expect(parsed.identity.description).toBe('desc');
      expect(parsed.config.baseagent).toBe('claude');
      expect(parsed.paths.config).toContain('alice.agentid.pub');
      expect(parsed.paths.agent_md).toContain('alice.agentid.pub');
    });

    it('normalizes paths to forward slashes (cross-platform)', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'show', 'alice.agentid.pub', '--format', 'json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.paths.config).not.toMatch(/\\/);
      expect(parsed.paths.agent_md).not.toMatch(/\\/);
      expect(parsed.paths.data).not.toMatch(/\\/);
    });

    it('shorthand `agent <aid>` is same as `agent show <aid>`', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'alice.agentid.pub']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/alice\.agentid\.pub/);
      expect(r.stdout).toMatch(/Baseagent/);
    });
  });

  describe('agent get / set', () => {
    it('get returns error for missing agent', () => {
      const r = runCli(['agent', 'get', 'missing.agentid.pub', 'enabled']);
      expect(r.code).toBe(1);
    });

    it('get top-level field', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'get', 'alice.agentid.pub', 'enabled']);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('true');
    });

    it('get with --format json', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'get', 'alice.agentid.pub', 'enabled', '--format', 'json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.value).toBe(true);
    });

    it('get nested field with dot path', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'get', 'alice.agentid.pub', 'projects.defaultPath']);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('/tmp/test');
    });

    it('set boolean value', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'set', 'alice.agentid.pub', 'enabled', 'false']);
      expect(r.code).toBe(0);

      const r2 = runCli(['agent', 'get', 'alice.agentid.pub', 'enabled']);
      expect(r2.stdout.trim()).toBe('false');
    });

    it('set string value', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'set', 'alice.agentid.pub', 'active_baseagent', 'codex']);
      expect(r.code).toBe(0);

      const r2 = runCli(['agent', 'get', 'alice.agentid.pub', 'active_baseagent']);
      expect(r2.stdout.trim()).toBe('codex');
    });

    it('set nested field with dot path', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'set', 'alice.agentid.pub', 'projects.defaultPath', '/new/path']);
      expect(r.code).toBe(0);

      const r2 = runCli(['agent', 'get', 'alice.agentid.pub', 'projects.defaultPath']);
      expect(r2.stdout.trim()).toBe('/new/path');
    });
  });

  describe('agent enable / disable', () => {
    it('enable sets enabled=true', () => {
      seedAgent('alice.agentid.pub', false);
      const r = runCli(['agent', 'enable', 'alice.agentid.pub']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/enabled/);

      const r2 = runCli(['agent', 'get', 'alice.agentid.pub', 'enabled']);
      expect(r2.stdout.trim()).toBe('true');
    });

    it('disable sets enabled=false', () => {
      seedAgent('alice.agentid.pub', true);
      const r = runCli(['agent', 'disable', 'alice.agentid.pub']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/disabled/);

      const r2 = runCli(['agent', 'get', 'alice.agentid.pub', 'enabled']);
      expect(r2.stdout.trim()).toBe('false');
    });

    it('enable --format json', () => {
      seedAgent('alice.agentid.pub', false);
      const r = runCli(['agent', 'enable', 'alice.agentid.pub', '--format', 'json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.enabled).toBe(true);
    });
  });

  describe('agent rename', () => {
    it('errors when agent.md missing', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'rename', 'alice.agentid.pub', 'NewName']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/agent\.md not found/);
    });

    it('updates name in agent.md', () => {
      seedAgent('alice.agentid.pub');
      seedAgentMd('alice.agentid.pub', 'OldName', 'desc');

      const r = runCli(['agent', 'rename', 'alice.agentid.pub', 'NewName']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/NewName/);

      const agentMdContent = fs.readFileSync(
        path.join(TEST_HOME, 'AIDs', 'alice.agentid.pub', 'agent.md'),
        'utf-8'
      );
      expect(agentMdContent).toMatch(/name:\s*"NewName"/);
    });
  });

  describe('agent delete', () => {
    it('removes config without --purge', () => {
      seedAgent('alice.agentid.pub');
      const configPath = path.join(TEST_HOME, 'agents', 'alice.agentid.pub', 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const r = runCli(['agent', 'delete', 'alice.agentid.pub']);
      expect(r.code).toBe(0);
      expect(fs.existsSync(configPath)).toBe(false);
    });

    it('removes whole directory with --purge', () => {
      seedAgent('alice.agentid.pub');
      const agentDir = path.join(TEST_HOME, 'agents', 'alice.agentid.pub');
      fs.mkdirSync(path.join(agentDir, 'personal'), { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'personal', 'note.md'), 'data');

      const r = runCli(['agent', 'delete', 'alice.agentid.pub', '--purge']);
      expect(r.code).toBe(0);
      expect(fs.existsSync(agentDir)).toBe(false);
    });

    it('--format json returns structured result', () => {
      seedAgent('alice.agentid.pub');
      const r = runCli(['agent', 'delete', 'alice.agentid.pub', '--purge', '--format', 'json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.purged).toBe(true);
    });
  });

  describe('agent reload (daemon offline)', () => {
    it('reports daemon offline gracefully', () => {
      const r = runCli(['agent', 'reload']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/未运行/);
    });

    it('--format json returns error', () => {
      const r = runCli(['agent', 'reload', '--format', 'json']);
      expect(r.code).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
    });
  });

  describe('error JSON format consistency', () => {
    it('all errors output `{ok:false,error:...}` in JSON mode', () => {
      const cases = [
        ['agent', 'show', 'missing.agentid.pub', '--format', 'json'],
        ['agent', 'get', 'missing.agentid.pub', 'foo', '--format', 'json'],
        ['agent', 'set', 'missing.agentid.pub', 'foo', 'bar', '--format', 'json'],
        ['agent', 'enable', 'missing.agentid.pub', '--format', 'json'],
        ['agent', 'disable', 'missing.agentid.pub', '--format', 'json'],
        ['agent', 'delete', 'missing.agentid.pub', '--format', 'json'],
        ['agent', 'rename', 'missing.agentid.pub', 'name', '--format', 'json'],
      ];
      for (const args of cases) {
        const r = runCli(args);
        expect(r.code, `args=${args.join(' ')}`).toBe(1);
        const parsed = JSON.parse(r.stdout);
        expect(parsed.ok, `args=${args.join(' ')}`).toBe(false);
        expect(typeof parsed.error, `args=${args.join(' ')}`).toBe('string');
      }
    });
  });
});
