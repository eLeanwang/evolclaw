import { describe, it, expect, vi } from 'vitest';
import { CommandHandler } from '../../src/core/command/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { EvolAgentHandle, EvolAgentRegistryHandle } from '../../src/types.js';

function makeSession() {
  return {
    id: 'sess-codex',
    channel: 'review-aun',
    channelId: 'chat1',
    projectPath: '/tmp/p',
    threadId: '',
    agentId: 'codex',
    chatType: 'private',
    sessionMode: 'interactive',
    identity: { role: 'owner', mode: 'interactive' },
  };
}

function makeSessionManager() {
  const session = makeSession();
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(session),
    getActiveSession: vi.fn().mockResolvedValue(session),
    resolveIdentity: vi.fn().mockReturnValue({ role: 'owner', mode: 'interactive' }),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false }),
  } as any;
}

function makeRunner() {
  return {
    name: 'codex',
    capabilities: { clear: false, compact: false, fork: false },
    getModel: vi.fn().mockReturnValue('gpt-5.4'),
    setModel: vi.fn(),
    getEffort: vi.fn().mockReturnValue('high'),
    setEffort: vi.fn(),
    listModels: vi.fn().mockReturnValue(['gpt-5.5', 'gpt-5.4']),
    listModes: vi.fn().mockReturnValue([]),
    getMode: vi.fn().mockReturnValue('auto'),
    hasActiveStream: vi.fn().mockReturnValue(false),
  } as any;
}

function makeOwningAgent(): EvolAgentHandle {
  return {
    name: 'review',
    baseagent: 'codex',
    projectPath: '/tmp/p',
    config: { baseagents: { codex: {} } },
    getContext: vi.fn(),
    getOwner: vi.fn(),
    isOwner: vi.fn().mockReturnValue(true),
    isAdmin: vi.fn().mockReturnValue(true),
    setOwner: vi.fn(),
    getShowActivities: vi.fn().mockReturnValue('all'),
    setShowActivities: vi.fn(),
    setBaseagentModel: vi.fn(),
    setBaseagentEffort: vi.fn(),
    getProjects: vi.fn().mockReturnValue({}),
    addProject: vi.fn(),
    channelInstanceNames: vi.fn().mockReturnValue(['review-aun']),
  } as any;
}

function makeRegistry(agent: EvolAgentHandle): EvolAgentRegistryHandle {
  return {
    resolveByChannel: vi.fn((channel: string) => (channel === 'review-aun' ? agent : null)),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    isOwner: vi.fn((_c, _u, fb) => fb(_c, _u)),
    isAdmin: vi.fn((_c, _u, fb) => fb(_c, _u)),
    getOwner: vi.fn(),
    setChannelOwner: vi.fn(),
    getShowActivities: vi.fn(),
    setShowActivities: vi.fn(),
  } as any;
}

describe('CommandHandler /setmodel for codex', () => {
  it('returns codex fallback model list instead of claude fallback', async () => {
    const runner = makeRunner();
    const handler = new CommandHandler(
      makeSessionManager(),
      new Map([['review::codex', runner]]),
      null as any,
      new EventBus(),
      'review::codex',
    );
    handler.setAgentRegistry(makeRegistry(makeOwningAgent()));

    const result = await handler.handle('/setmodel', 'review-aun', 'chat1', undefined, 'owner1');
    expect(result && typeof result === 'object' && 'text' in result).toBe(true);
    const payload = JSON.parse((result as any).text);
    expect(payload.current_model).toBe('gpt-5.4');
    expect(payload.models.data.map((m: any) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4']);
    expect(payload.models.data.every((m: any) => m.owned_by === 'openai')).toBe(true);
  });
});
