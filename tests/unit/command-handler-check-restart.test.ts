import { describe, it, expect } from 'vitest';

/**
 * Pattern-only tests for /check + /restart agent-ownership scoping.
 *
 * Mirrors the runtime logic in CommandHandler so we can verify the filter
 * predicates and scope-resolution branches without a fully constructed
 * CommandHandler instance (which has heavy dependencies).
 */

interface FakeAgent {
  name: string;
  isDefault: boolean;
  channelInstanceNames(): string[];
}

function resolveAllowedChannels(owningAgent: FakeAgent | null): Set<string> | null {
  return owningAgent ? new Set(owningAgent.channelInstanceNames()) : null;
}

function filterChannels(
  adapters: string[],
  allowed: Set<string> | null
): string[] {
  return adapters.filter(name => !allowed || allowed.has(name));
}

function resolveRestartScope(
  type: string,
  adapters: string[],
  channelTypeMap: Map<string, string>,
  owningAgent: FakeAgent | null,
  resolveByChannel: (name: string) => FakeAgent | null
): string[] {
  const scoped: string[] = [];
  if (owningAgent) {
    for (const name of owningAgent.channelInstanceNames()) {
      if (channelTypeMap.get(name) === type) scoped.push(name);
    }
  } else {
    for (const name of adapters) {
      if (channelTypeMap.get(name) !== type) continue;
      const owner = resolveByChannel(name);
      if (owner && !owner.isDefault) continue;
      scoped.push(name);
    }
  }
  return scoped;
}

describe('/check filters by owning agent', () => {
  const adapters = ['aun', 'feishu', 'review-bot-aun', 'support-bot-feishu'];
  const reviewBot: FakeAgent = {
    name: 'review-bot',
    isDefault: false,
    channelInstanceNames: () => ['review-bot-aun'],
  };

  it('agent-owned channel only sees its own channels', () => {
    const allowed = resolveAllowedChannels(reviewBot);
    const visible = filterChannels(adapters, allowed);
    expect(visible).toEqual(['review-bot-aun']);
    expect(visible).not.toContain('aun');
    expect(visible).not.toContain('feishu');
    expect(visible).not.toContain('support-bot-feishu');
  });

  it('default channel context sees all channels', () => {
    const allowed = resolveAllowedChannels(null);
    const visible = filterChannels(adapters, allowed);
    expect(visible).toEqual(adapters);
  });

  it('agent with multiple channels sees all of its own', () => {
    const multi: FakeAgent = {
      name: 'multi-bot',
      isDefault: false,
      channelInstanceNames: () => ['multi-bot-aun', 'multi-bot-feishu'],
    };
    const ownedAdapters = [...adapters, 'multi-bot-aun', 'multi-bot-feishu'];
    const visible = filterChannels(ownedAdapters, resolveAllowedChannels(multi));
    expect(visible.sort()).toEqual(['multi-bot-aun', 'multi-bot-feishu']);
  });
});

describe('/restart <type> scope resolution', () => {
  const reviewBot: FakeAgent = {
    name: 'review-bot',
    isDefault: false,
    channelInstanceNames: () => ['review-bot-aun', 'review-bot-feishu'],
  };
  const supportBot: FakeAgent = {
    name: 'support-bot',
    isDefault: false,
    channelInstanceNames: () => ['support-bot-aun'],
  };
  const defaultAgent: FakeAgent = {
    name: 'default',
    isDefault: true,
    channelInstanceNames: () => ['aun', 'feishu'],
  };

  const adapters = ['aun', 'feishu', 'review-bot-aun', 'review-bot-feishu', 'support-bot-aun'];
  const channelTypeMap = new Map<string, string>([
    ['aun', 'aun'],
    ['feishu', 'feishu'],
    ['review-bot-aun', 'aun'],
    ['review-bot-feishu', 'feishu'],
    ['support-bot-aun', 'aun'],
  ]);

  const ownerMap = new Map<string, FakeAgent>([
    ['aun', defaultAgent],
    ['feishu', defaultAgent],
    ['review-bot-aun', reviewBot],
    ['review-bot-feishu', reviewBot],
    ['support-bot-aun', supportBot],
  ]);
  const resolveByChannel = (name: string) => ownerMap.get(name) ?? null;

  it('EvolAgent reconnects only its own channels of given type', () => {
    const scope = resolveRestartScope('aun', adapters, channelTypeMap, reviewBot, resolveByChannel);
    expect(scope).toEqual(['review-bot-aun']);
    expect(scope).not.toContain('aun');
    expect(scope).not.toContain('support-bot-aun');
  });

  it('EvolAgent feishu type only matches its own feishu', () => {
    const scope = resolveRestartScope('feishu', adapters, channelTypeMap, reviewBot, resolveByChannel);
    expect(scope).toEqual(['review-bot-feishu']);
  });

  it('Default context excludes agent-owned channels', () => {
    const scope = resolveRestartScope('aun', adapters, channelTypeMap, null, resolveByChannel);
    expect(scope).toEqual(['aun']);
    expect(scope).not.toContain('review-bot-aun');
    expect(scope).not.toContain('support-bot-aun');
  });

  it('returns empty when type does not match any in scope', () => {
    const scope = resolveRestartScope('wechat', adapters, channelTypeMap, reviewBot, resolveByChannel);
    expect(scope).toEqual([]);
  });

  it('default context with unowned channels still works', () => {
    const map = new Map<string, FakeAgent>([
      ['aun', defaultAgent],
    ]);
    const scope = resolveRestartScope(
      'aun',
      ['aun'],
      new Map([['aun', 'aun']]),
      null,
      (n) => map.get(n) ?? null
    );
    expect(scope).toEqual(['aun']);
  });
});
