/**
 * 场景测试：agent 命令集端到端用户旅程
 *
 * 模拟真实使用场景，验证多命令串联的正确性。
 * 不依赖 daemon 在线，全程 cold mode 操作。
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
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-scenario-'));
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

function seedAgent(aid: string, baseagent = 'claude', enabled = true): void {
  const agentDir = path.join(TEST_HOME, 'agents', aid);
  fs.mkdirSync(agentDir, { recursive: true });
  const config = {
    $schema_version: 2,
    aid,
    enabled,
    channels: [],
    projects: { defaultPath: `/tmp/${aid.split('.')[0]}` },
    active_baseagent: baseagent,
    baseagents: { [baseagent]: {} },
    chatmode: { private: 'interactive', group: 'proactive' },
  };
  fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify(config, null, 2));
}

function seedAgentMd(aid: string, name: string, description: string): void {
  const aidDir = path.join(TEST_HOME, 'AIDs', aid);
  fs.mkdirSync(aidDir, { recursive: true });
  fs.writeFileSync(path.join(aidDir, 'agent.md'), `---
aid: "${aid}"
name: "${name}"
description: "${description}"
---
`);
}

describe('scenario: agent CLI workflows', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_CLI)) {
      throw new Error(`dist/cli/index.js not found; run \`npm run build\` first`);
    }
  });

  beforeEach(() => {
    setupHome();
  });

  describe('Scenario 1: 用户管理多个 agent', () => {
    it('inspect → modify → verify lifecycle', () => {
      // Seed two agents
      seedAgent('alice.agentid.pub', 'claude');
      seedAgent('bob.agentid.pub', 'codex');
      seedAgentMd('alice.agentid.pub', 'Alice', 'Personal assistant');
      seedAgentMd('bob.agentid.pub', 'Bob', 'Code reviewer');

      // 1. List shows both
      const list1 = runCli(['agent', 'list', '--format', 'json']);
      expect(list1.code).toBe(0);
      const listed = JSON.parse(list1.stdout);
      expect(listed.agents.map((a: any) => a.aid).sort()).toEqual([
        'alice.agentid.pub',
        'bob.agentid.pub',
      ]);

      // 2. Show alice details
      const show1 = runCli(['agent', 'show', 'alice.agentid.pub', '--format', 'json']);
      expect(show1.code).toBe(0);
      const aliceDetail = JSON.parse(show1.stdout);
      expect(aliceDetail.identity.name).toBe('Alice');
      expect(aliceDetail.config.baseagent).toBe('claude');

      // 3. Disable alice
      const disable = runCli(['agent', 'disable', 'alice.agentid.pub']);
      expect(disable.code).toBe(0);

      // 4. Verify alice is disabled
      const get1 = runCli(['agent', 'get', 'alice.agentid.pub', 'enabled']);
      expect(get1.stdout.trim()).toBe('false');

      // 5. Switch alice's baseagent
      const set1 = runCli(['agent', 'set', 'alice.agentid.pub', 'active_baseagent', 'gemini']);
      expect(set1.code).toBe(0);

      // 6. Verify
      const get2 = runCli(['agent', 'get', 'alice.agentid.pub', 'active_baseagent']);
      expect(get2.stdout.trim()).toBe('gemini');

      // 7. Re-enable alice
      const enable = runCli(['agent', 'enable', 'alice.agentid.pub']);
      expect(enable.code).toBe(0);

      // 8. Final state check
      const finalShow = runCli(['agent', 'show', 'alice.agentid.pub', '--format', 'json']);
      const finalDetail = JSON.parse(finalShow.stdout);
      expect(finalDetail.config.baseagent).toBe('gemini');
    });
  });

  // Scenario 2: agent rename 命令已废弃，相关测试已移除

  describe('Scenario 3: 删除 agent 的两种模式', () => {
    it('delete without --purge keeps data, with --purge removes all', () => {
      seedAgent('alice.agentid.pub');
      const agentDir = path.join(TEST_HOME, 'agents', 'alice.agentid.pub');
      const personalDir = path.join(agentDir, 'personal');
      fs.mkdirSync(personalDir, { recursive: true });
      fs.writeFileSync(path.join(personalDir, 'note.md'), 'important data');

      // Delete config only
      const del1 = runCli(['agent', 'delete', 'alice.agentid.pub']);
      expect(del1.code).toBe(0);
      expect(fs.existsSync(path.join(agentDir, 'config.json'))).toBe(false);
      // Personal data preserved
      expect(fs.existsSync(path.join(personalDir, 'note.md'))).toBe(true);

      // Show confirms gone from registry
      const show = runCli(['agent', 'show', 'alice.agentid.pub']);
      expect(show.code).toBe(1);

      // Re-seed and purge
      seedAgent('alice.agentid.pub');
      const del2 = runCli(['agent', 'delete', 'alice.agentid.pub', '--purge']);
      expect(del2.code).toBe(0);
      expect(fs.existsSync(agentDir)).toBe(false);
    });
  });

  describe('Scenario 4: JSON 输出脚本可消费性', () => {
    it('all commands produce valid JSON when --format json', () => {
      seedAgent('alice.agentid.pub');
      seedAgentMd('alice.agentid.pub', 'Alice', 'desc');

      const commands = [
        ['agent', 'list'],
        ['agent', 'show', 'alice.agentid.pub'],
        ['agent', 'get', 'alice.agentid.pub', 'enabled'],
      ];

      for (const cmd of commands) {
        const r = runCli([...cmd, '--format', 'json']);
        expect(r.code, `cmd=${cmd.join(' ')}`).toBe(0);
        // Must be parseable
        let parsed: any;
        expect(() => { parsed = JSON.parse(r.stdout); }, `cmd=${cmd.join(' ')}`).not.toThrow();
        expect(parsed.ok, `cmd=${cmd.join(' ')}`).toBe(true);
      }
    });

    it('error responses also produce valid JSON', () => {
      const r = runCli(['agent', 'show', 'missing.agentid.pub', '--format', 'json']);
      expect(r.code).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
      expect(typeof parsed.error).toBe('string');
    });
  });

  describe('Scenario 5: 跨平台路径一致性', () => {
    it('all path output uses forward slashes regardless of OS', () => {
      seedAgent('alice.agentid.pub');

      // List
      const list = runCli(['agent', 'list', '--format', 'json']);
      const listed = JSON.parse(list.stdout);
      const project = listed.agents[0].projectPath;
      if (project) expect(project).not.toMatch(/\\/);

      // Show
      const show = runCli(['agent', 'show', 'alice.agentid.pub', '--format', 'json']);
      const detail = JSON.parse(show.stdout);
      expect(detail.paths.config).not.toMatch(/\\/);
      expect(detail.paths.agent_md).not.toMatch(/\\/);
      expect(detail.paths.data).not.toMatch(/\\/);
      // Even Windows paths should use forward slashes
      expect(detail.paths.config).toContain('/agents/');
      expect(detail.paths.agent_md).toContain('/AIDs/');
    });
  });

  describe('Scenario 6: 嵌套配置读写', () => {
    it('dot-path get/set works for nested fields', () => {
      seedAgent('alice.agentid.pub');

      // Read nested
      const get1 = runCli(['agent', 'get', 'alice.agentid.pub', 'chatmode.private']);
      expect(get1.code).toBe(0);
      expect(get1.stdout.trim()).toBe('interactive');

      // Set nested
      const set1 = runCli(['agent', 'set', 'alice.agentid.pub', 'chatmode.private', 'proactive']);
      expect(set1.code).toBe(0);

      // Verify
      const get2 = runCli(['agent', 'get', 'alice.agentid.pub', 'chatmode.private']);
      expect(get2.stdout.trim()).toBe('proactive');

      // Other nested fields unaffected
      const get3 = runCli(['agent', 'get', 'alice.agentid.pub', 'chatmode.group']);
      expect(get3.stdout.trim()).toBe('proactive');

      // Get whole nested object as JSON
      const get4 = runCli(['agent', 'get', 'alice.agentid.pub', 'chatmode', '--format', 'json']);
      expect(get4.code).toBe(0);
      const parsed = JSON.parse(get4.stdout);
      expect(parsed.value).toEqual({ private: 'proactive', group: 'proactive' });
    });
  });

  describe('Scenario 7: 错误处理一致性', () => {
    it('unknown agent returns error exit code 1 for all relevant commands', () => {
      const commands = [
        ['agent', 'show', 'ghost.agentid.pub'],
        ['agent', 'enable', 'ghost.agentid.pub'],
        ['agent', 'disable', 'ghost.agentid.pub'],
        ['agent', 'get', 'ghost.agentid.pub', 'enabled'],
        ['agent', 'set', 'ghost.agentid.pub', 'enabled', 'true'],
        ['agent', 'delete', 'ghost.agentid.pub'],
        ['agent', 'rename', 'ghost.agentid.pub', 'NewName'],
      ];

      for (const cmd of commands) {
        const r = runCli(cmd);
        expect(r.code, `cmd=${cmd.join(' ')}`).toBe(1);
      }
    });

    it('missing required arguments returns error', () => {
      const cases = [
        ['agent', 'show'],         // missing aid
        ['agent', 'enable'],
        ['agent', 'disable'],
        ['agent', 'get'],          // missing aid + key
        ['agent', 'get', 'alice.agentid.pub'],  // missing key
        ['agent', 'set', 'alice.agentid.pub'],  // missing key + value
        ['agent', 'set', 'alice.agentid.pub', 'foo'],  // missing value
        ['agent', 'rename'],
        ['agent', 'rename', 'alice.agentid.pub'],  // missing name
        ['agent', 'delete'],
      ];

      for (const cmd of cases) {
        const r = runCli(cmd);
        expect(r.code, `cmd=${cmd.join(' ')}`).toBe(1);
      }
    });
  });
});
