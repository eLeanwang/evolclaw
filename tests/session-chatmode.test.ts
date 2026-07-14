import path from 'path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/event-bus.js';
import { SessionManager, type ChatModeDefaultsProvider } from '../src/core/session/session-manager.js';
import { resolvePaths } from '../src/paths.js';

function createManager(provider: ChatModeDefaultsProvider) {
  return new SessionManager(
    path.join(resolvePaths().root, 'data', 'sessions'),
    new EventBus(),
    undefined,
    provider,
  );
}

describe('SessionManager chatmode defaults', () => {
  it('uses configured private chatmode for new private human sessions', async () => {
    const manager = createManager(() => ({ private: 'proactive' }));
    const session = await manager.getOrCreateSession(
      'aun#bot.agentid.pub#main',
      'peer.agentid.pub',
      'H:/tmp/project',
      undefined,
      undefined,
      undefined,
      'peer.agentid.pub',
      'private',
      'claude',
      'bot.agentid.pub',
      'aun',
      'human',
    );

    expect(session.chatMode).toBe('proactive');
  });

  it('keeps hard runtime chatmode rules for group, system, and non-human peers', async () => {
    const manager = createManager(() => ({
      private: 'proactive',
      group: 'interactive',
      nothuman: 'interactive',
    }));

    const group = await manager.getOrCreateSession(
      'aun#bot.agentid.pub#main',
      'group-1',
      'H:/tmp/project',
      undefined,
      undefined,
      undefined,
      'peer.agentid.pub',
      'group',
      'claude',
      'bot.agentid.pub',
      'aun',
      'human',
    );
    const system = await manager.getOrCreateSession(
      'aun#bot.agentid.pub#main',
      'system-peer',
      'H:/tmp/project',
      undefined,
      undefined,
      undefined,
      'system',
      'private',
      'claude',
      'bot.agentid.pub',
      'aun',
      'system',
    );
    const systemGroup = await manager.getOrCreateSession(
      'aun#bot.agentid.pub#main',
      'system-group-peer',
      'H:/tmp/project',
      undefined,
      undefined,
      undefined,
      'system',
      'group',
      'claude',
      'bot.agentid.pub',
      'aun',
      'system',
    );
    const bot = await manager.getOrCreateSession(
      'aun#bot.agentid.pub#main',
      'bot-peer',
      'H:/tmp/project',
      undefined,
      undefined,
      undefined,
      'bot-peer',
      'private',
      'claude',
      'bot.agentid.pub',
      'aun',
      'agent',
    );

    expect(group.chatMode).toBe('interactive');
    expect(system.chatMode).toBe('interactive');
    expect(systemGroup.chatMode).toBe('interactive');
    expect(bot.chatMode).toBe('interactive');
  });
});
