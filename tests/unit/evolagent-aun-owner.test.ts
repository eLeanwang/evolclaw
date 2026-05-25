import { describe, it, expect, vi } from 'vitest';
import { EvolAgent } from '../../src/core/evolagent.js';
import type { AgentConfig, MergedAgentConfig } from '../../src/types.js';

// EvolAgent.persist() 走 saveAgent → 写文件，测试中 mock 掉
vi.mock('../../src/config-store.js', () => ({
  saveAgent: vi.fn(),
}));

function makeAgent(opts: {
  aid: string;
  owners?: string[];
  admins?: string[];
  channels?: any[];
}): EvolAgent {
  const raw: AgentConfig = {
    $schema_version: 1,
    aid: opts.aid,
    enabled: true,
    owners: opts.owners,
    admins: opts.admins,
    channels: (opts.channels ?? []) as any,
  };
  const merged: MergedAgentConfig = {
    $schema_version: 1,
    aid: opts.aid,
    enabled: true,
    owners: opts.owners,
    admins: opts.admins,
    channels: (opts.channels ?? []) as any,
  } as any;
  return new EvolAgent(raw, merged);
}

describe('EvolAgent AUN owner/admin (top-level resolution)', () => {
  const aid = 'evolai.agentid.pub';
  const aunKey = `aun#${aid}#main`;

  it('isOwner returns true for AID listed in top-level owners', () => {
    const agent = makeAgent({ aid, owners: ['eleans-2022.agentid.pub'] });
    expect(agent.isOwner(aunKey, 'eleans-2022.agentid.pub')).toBe(true);
    expect(agent.isOwner(aunKey, 'someone-else.agentid.pub')).toBe(false);
  });

  it('isAdmin returns true for top-level admins (and owners)', () => {
    const agent = makeAgent({
      aid,
      owners: ['eleans-2022.agentid.pub'],
      admins: ['elean.agentid.pub'],
    });
    expect(agent.isAdmin(aunKey, 'eleans-2022.agentid.pub')).toBe(true); // owner is admin
    expect(agent.isAdmin(aunKey, 'elean.agentid.pub')).toBe(true);       // listed admin
    expect(agent.isAdmin(aunKey, 'random.agentid.pub')).toBe(false);
  });

  it('returns false for AUN when top-level owners/admins empty', () => {
    const agent = makeAgent({ aid });
    expect(agent.isOwner(aunKey, 'anyone.agentid.pub')).toBe(false);
    expect(agent.isAdmin(aunKey, 'anyone.agentid.pub')).toBe(false);
  });

  it('getOwner returns first top-level owner for AUN', () => {
    const agent = makeAgent({
      aid,
      owners: ['first.agentid.pub', 'second.agentid.pub'],
    });
    expect(agent.getOwner(aunKey)).toBe('first.agentid.pub');
  });

  it('setOwner appends to top-level owners (not channel instance)', () => {
    const agent = makeAgent({ aid });
    agent.setOwner(aunKey, 'newcomer.agentid.pub');
    expect(agent.isOwner(aunKey, 'newcomer.agentid.pub')).toBe(true);
    expect(agent.config.owners).toContain('newcomer.agentid.pub');
  });

  it('setOwner does not duplicate existing owner', () => {
    const agent = makeAgent({ aid, owners: ['eleans-2022.agentid.pub'] });
    agent.setOwner(aunKey, 'eleans-2022.agentid.pub');
    expect(agent.config.owners?.filter(x => x === 'eleans-2022.agentid.pub').length).toBe(1);
  });

  it('non-AUN channels still use per-channel-instance owners', () => {
    const agent = makeAgent({
      aid,
      owners: ['top-level.agentid.pub'], // 顶层只对 AUN 生效
      channels: [{
        type: 'feishu',
        name: 'main',
        appId: 'a',
        appSecret: 'b',
        owners: ['ou_feishuuser'],
      }],
    });
    const fsKey = `feishu#${aid}#main`;
    // 顶层 owners 不应影响 feishu channel
    expect(agent.isOwner(fsKey, 'top-level.agentid.pub')).toBe(false);
    expect(agent.isOwner(fsKey, 'ou_feishuuser')).toBe(true);
    // AUN channel 仍然用顶层
    expect(agent.isOwner(aunKey, 'top-level.agentid.pub')).toBe(true);
    expect(agent.isOwner(aunKey, 'ou_feishuuser')).toBe(false);
  });

  it('isAunChannelKey rejects keys for other AIDs', () => {
    const agent = makeAgent({ aid, owners: ['eleans-2022.agentid.pub'] });
    const otherAunKey = `aun#other.agentid.pub#main`;
    // 别的 agent 的 AUN key 不应命中本 agent 的顶层 owners
    expect(agent.isOwner(otherAunKey, 'eleans-2022.agentid.pub')).toBe(false);
  });
});
