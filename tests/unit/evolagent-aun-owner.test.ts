import { describe, expect, it, vi } from 'vitest';
import { EvolAgent } from '../../src/core/evolagent.js';
import type { AgentConfig, EffectiveAgentConfig } from '../../src/types.js';

vi.mock('../../src/config-store.js', () => ({
  saveAgent: vi.fn(),
}));

function makeAgent(owners?: string[], admins?: string[]): EvolAgent {
  const raw: AgentConfig = {
    $schema_version: 2,
    aid: 'evolai.agentid.pub',
    enabled: true,
    owners,
    admins,
    channels: [],
  };
  const merged: EffectiveAgentConfig = {
    $schema_version: 2,
    aid: 'evolai.agentid.pub',
    enabled: true,
    owners,
    admins,
    channels: [],
  };
  return new EvolAgent(raw, merged);
}

describe('EvolAgent static owners', () => {
  const channelKey = 'aun#evolai.agentid.pub#main';

  it('treats config owners as agent owners', () => {
    const agent = makeAgent(['root.agentid.pub']);
    expect(agent.isOwner(channelKey, 'root.agentid.pub')).toBe(true);
    expect(agent.isOwner(channelKey, 'someone.agentid.pub')).toBe(false);
  });

  it('treats owner as admin', () => {
    const agent = makeAgent(['root.agentid.pub']);
    expect(agent.isAdmin(channelKey, 'root.agentid.pub')).toBe(true);
  });

  it('treats configured admins as admins but not owners', () => {
    const agent = makeAgent([], ['ops.agentid.pub']);
    expect(agent.isAdmin(channelKey, 'ops.agentid.pub')).toBe(true);
    expect(agent.isOwner(channelKey, 'ops.agentid.pub')).toBe(false);
  });

  it('prefers static owner for getOwner', () => {
    const agent = makeAgent(['root.agentid.pub']);
    expect(agent.getOwner(channelKey)).toBe('root.agentid.pub');
  });
});
