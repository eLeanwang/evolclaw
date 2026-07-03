import { describe, expect, it, vi } from 'vitest';
import { EvolAgent } from '../../src/core/evolagent.js';
import type { AgentConfig, EffectiveAgentConfig } from '../../src/types.js';

vi.mock('../../src/config-store.js', () => ({
  saveAgent: vi.fn(),
}));

vi.mock('../../src/config/role-assignments.js', () => ({
  listRoleAssignments: vi.fn((aid: string, filter: any = {}) => {
    if (aid !== 'evolai.agentid.pub') return [];
    if (filter.scope === 'private' && filter.role === 'owner' && filter.peerId === 'legacy-owner.agentid.pub') {
      return [{ scope: 'private', role: 'owner', peerId: 'legacy-owner.agentid.pub' }];
    }
    if (filter.scope === 'private' && filter.role === 'owner' && !filter.peerId) {
      return [{ scope: 'private', role: 'owner', peerId: 'legacy-owner.agentid.pub' }];
    }
    return [];
  }),
  setPrivateRoleAssignment: vi.fn(),
}));

function makeAgent(owners?: string[]): EvolAgent {
  const raw: AgentConfig = {
    $schema_version: 2,
    aid: 'evolai.agentid.pub',
    enabled: true,
    owners,
    channels: [],
  };
  const merged: EffectiveAgentConfig = {
    $schema_version: 2,
    aid: 'evolai.agentid.pub',
    enabled: true,
    owners,
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

  it('keeps role-assignment owners as compatibility fallback', () => {
    const agent = makeAgent();
    expect(agent.isOwner(channelKey, 'legacy-owner.agentid.pub')).toBe(true);
    expect(agent.getOwner(channelKey)).toBe('legacy-owner.agentid.pub');
  });

  it('prefers static owner for getOwner', () => {
    const agent = makeAgent(['root.agentid.pub']);
    expect(agent.getOwner(channelKey)).toBe('root.agentid.pub');
  });
});
