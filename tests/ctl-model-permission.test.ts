import { describe, expect, it, vi } from 'vitest';
import { CommandHandler } from '../src/core/command/command-handler.js';
import { ConfigTarget, write } from '../src/config/config-manager.js';
import type { Session } from '../src/types.js';

describe('ctl model permissions', () => {
  it('resolves current role assignments from ctl session context', async () => {
    const selfAid = 'ctl-owner.agentid.pub';
    const peerId = 'visitor-peer.agentid.pub';
    write(ConfigTarget.Agent, { aid: selfAid, channels: [] }, { self: selfAid });
    write(ConfigTarget.Relation, { roles: { assigned: 'visitor' } }, { self: selfAid, peerKey: `aun#${peerId}` });

    const session: Session = {
      id: 'sess-visitor',
      channel: `aun#${selfAid}#main`,
      channelType: 'aun',
      channelId: peerId,
      selfAID: selfAid,
      baseagent: 'claude',
      threadId: '',
      sessionKey: `aun#${peerId}#__main__`,
      chatType: 'private',
      chatMode: 'interactive',
      projectPath: 'H:/tmp/project',
      metadata: { peerId },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const sessionManager = {
      getSessionById: vi.fn(async () => session),
      getActiveSession: vi.fn(async () => session),
      getThreadSession: vi.fn(async () => session),
      resolveIdentity: vi.fn(() => ({ role: 'owner', mode: 'interactive' as const })),
    };
    const agent = {
      name: 'claude',
      listModels: vi.fn(async () => [
        'claude-opus-4-8',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
      ]),
      setModel: vi.fn(),
      getModel: vi.fn(() => 'claude-opus-4-8'),
      resolveModelId: vi.fn((model: string) => model),
    };
    const handler = new CommandHandler(
      sessionManager as any,
      new Map([['bot::claude', agent as any]]),
      {} as any,
      { publish: vi.fn() } as any,
      'bot::claude',
    );
    handler.setAgentRegistry({
      resolveByChannel: vi.fn(() => ({ aid: selfAid, name: 'bot', baseagent: 'claude', projectPath: 'H:/tmp/project', config: { aid: selfAid } })),
    } as any);

    const result = await handler.handleCtl('/setmodel', session.id);
    expect(result.ok).toBe(true);

    const payload = JSON.parse(result.result || '{}');
    expect(payload.models.data.map((model: any) => model.id)).toEqual([
      'claude-haiku-4-5-20251001',
    ]);
    expect(sessionManager.resolveIdentity).not.toHaveBeenCalled();
  });
});
