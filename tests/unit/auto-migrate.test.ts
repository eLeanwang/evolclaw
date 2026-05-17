import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { autoMigrateIfNeeded, loadDefaults, loadAgent, loadAllAgents } from '../../src/config-store.js';
import { _resetRoot } from '../../src/paths.js';

function setupHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-mig-'));
  process.env.EVOLCLAW_HOME = root;
  _resetRoot();
  return root;
}

describe('autoMigrateIfNeeded', () => {
  beforeEach(() => {
    setupHome();
  });

  it('does nothing when defaults.json already exists', () => {
    const root = process.env.EVOLCLAW_HOME!;
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents/defaults.json'), '{"$schema_version":1}');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/evolclaw.json'), '{"agents":{"claude":{}}}');

    autoMigrateIfNeeded();

    // evolclaw.json should NOT be renamed
    expect(fs.existsSync(path.join(root, 'data/evolclaw.json'))).toBe(true);
  });

  it('does nothing when neither defaults.json nor evolclaw.json exists', () => {
    const root = process.env.EVOLCLAW_HOME!;
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });

    autoMigrateIfNeeded();

    expect(fs.existsSync(path.join(root, 'agents/defaults.json'))).toBe(false);
  });

  it('migrates evolclaw.json global channels into per-agent config', () => {
    const root = process.env.EVOLCLAW_HOME!;
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });

    const oldConfig = {
      agents: {
        claude: { apiKey: 'sk-test', model: 'opus', effort: 'high' },
        defaultAgent: 'claude',
      },
      channels: {
        defaultChannel: 'aun',
        aun: { enabled: true, aid: 'mybot.agentid.pub', owner: 'owner.agentid.pub', admins: ['admin.agentid.pub'] },
      },
      projects: { defaultPath: '/tmp/proj', list: { proj1: '/tmp/proj' } },
      chatmode: { private: 'interactive', group: 'proactive' },
      flushDelay: 4,
      debounce: 2,
      showActivities: 'all',
    };
    fs.writeFileSync(path.join(root, 'data/evolclaw.json'), JSON.stringify(oldConfig));

    autoMigrateIfNeeded();

    // defaults.json created
    const defaults = loadDefaults();
    expect(defaults).not.toBeNull();
    expect(defaults!.$schema_version).toBe(1);
    expect(defaults!.active_baseagent).toBe('claude');
    expect(defaults!.baseagents?.claude?.apiKey).toBe('sk-test');
    expect(defaults!.flush_delay).toBe(4);
    expect(defaults!.debounce).toBe(2);

    // per-agent config created
    const agent = loadAgent('mybot.agentid.pub');
    expect(agent).not.toBeNull();
    expect(agent!.aid).toBe('mybot.agentid.pub');
    expect(agent!.owners).toEqual(['owner.agentid.pub']);
    expect(agent!.admins).toEqual(['admin.agentid.pub']);
    expect(agent!.channels.length).toBeGreaterThanOrEqual(1);
    expect(agent!.channels[0].type).toBe('aun');
    expect(agent!.channels[0].name).toBe('main');
    expect(agent!.projects?.defaultPath).toBe('/tmp/proj');
    expect(agent!.chatmode?.group).toBe('proactive');

    // old file renamed
    expect(fs.existsSync(path.join(root, 'data/evolclaw.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'data/evolclaw.json_'))).toBe(true);

    // directory skeleton created
    expect(fs.existsSync(path.join(root, 'agents/mybot.agentid.pub/personal'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'agents/mybot.agentid.pub/identities/contacts'))).toBe(true);
  });

  it('migrates old agents/<name>.json files', () => {
    const root = process.env.EVOLCLAW_HOME!;
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });

    // Global config (minimal)
    fs.writeFileSync(path.join(root, 'data/evolclaw.json'), JSON.stringify({
      agents: { claude: {}, defaultAgent: 'claude' },
      channels: { aun: { enabled: true, aid: 'global.agentid.pub', owner: 'o.agentid.pub' } },
      projects: { defaultPath: '/tmp' },
    }));

    // Named agent file
    fs.writeFileSync(path.join(root, 'agents/llbot.json'), JSON.stringify({
      name: 'llbot',
      enabled: true,
      agents: { claude: {} },
      channels: { aun: { enabled: true, aid: 'llbot.agentid.pub', owner: 'boss.agentid.pub' } },
      projects: { defaultPath: '/tmp/llbot' },
    }));

    autoMigrateIfNeeded();

    // Named agent migrated
    const llbot = loadAgent('llbot.agentid.pub');
    expect(llbot).not.toBeNull();
    expect(llbot!.owners).toEqual(['boss.agentid.pub']);

    // Old file renamed
    expect(fs.existsSync(path.join(root, 'agents/llbot.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'agents/llbot.json_'))).toBe(true);

    // Global AUN also migrated (separate agent)
    const global = loadAgent('global.agentid.pub');
    expect(global).not.toBeNull();
    expect(global!.owners).toEqual(['o.agentid.pub']);

    // loadAllAgents finds both
    const { agents } = loadAllAgents();
    expect(agents.map(a => a.aid).sort()).toEqual(['global.agentid.pub', 'llbot.agentid.pub']);
  });

  it('is idempotent — second call is a no-op', () => {
    const root = process.env.EVOLCLAW_HOME!;
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/evolclaw.json'), JSON.stringify({
      agents: { claude: {}, defaultAgent: 'claude' },
      channels: { aun: { enabled: true, aid: 'bot.agentid.pub', owner: 'o.agentid.pub' } },
      projects: { defaultPath: '/tmp' },
    }));

    autoMigrateIfNeeded();
    autoMigrateIfNeeded(); // second call

    const { agents } = loadAllAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].aid).toBe('bot.agentid.pub');
  });
});
