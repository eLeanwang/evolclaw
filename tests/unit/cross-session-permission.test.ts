import path from 'path';
import { describe, expect, it } from 'vitest';
import { PermissionGateway } from '../../src/core/permission.js';
import { InteractionRouter } from '../../src/core/interaction-router.js';
import type { ChannelAdapter, OutboundEnvelope, OutboundPayload } from '../../src/types.js';

function waitTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function fakeAunAdapter(sent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }>): ChannelAdapter {
  return {
    channelName: 'aun#self.agentid.pub#main',
    channelKey: 'aun#self.agentid.pub#main',
    capabilities: { interaction: true, file: false, image: false, markdown: true, thought: false, status: false, thread: false },
    async send(envelope, payload) {
      sent.push({ envelope, payload });
    },
  };
}

describe('cross-session permission approval', () => {
  it('routes non-owner approval to AUN owner and resolves allow on owner approval', async () => {
    const sent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const prompts: string[] = [];
    const router = new InteractionRouter();
    const gateway = new PermissionGateway();
    const home = process.env.EVOLCLAW_HOME!;

    const decisionPromise = gateway.requestPermission(
      'origin-session',
      'Bash',
      { command: 'rm -rf tmp' },
      async text => { prompts.push(text); },
      {
        adapter: fakeAunAdapter(sent),
        channelId: 'guest.agentid.pub',
        interactionRouter: router,
        userId: 'guest.agentid.pub',
        channel: 'aun',
        agentName: 'self.agentid.pub',
        taskId: 'task-1',
        chatmode: 'interactive',
        role: 'guest',
        chatType: 'private',
        crossSessionApproval: {
          adapter: fakeAunAdapter(sent),
          ownerAid: 'owner.agentid.pub',
          owners: ['owner.agentid.pub'],
          selfAid: 'self.agentid.pub',
          originSessionId: 'origin-session',
          originMessageId: 'origin-message',
          originChannel: 'aun',
          originChannelId: 'guest.agentid.pub',
          originPeerId: 'guest.agentid.pub',
          originRole: 'guest',
          originChatDir: path.join(home, 'origin-chat'),
          approvalTtlMs: 2_000,
        },
      },
      'rm -rf tmp',
      '危险命令需要 owner 临时授权',
    );

    await waitTick();
    expect(sent).toHaveLength(1);
    const interactionPayload = sent[0].payload;
    expect(interactionPayload.kind).toBe('interaction');
    if (interactionPayload.kind !== 'interaction') throw new Error('expected interaction payload');
    expect(interactionPayload.interaction.channelId).toBe('owner.agentid.pub');
    expect(interactionPayload.interaction.initiatorId).toBe('owner.agentid.pub');
    expect(sent[0].envelope.replyContext?.metadata?.source).toBe('handoff');
    expect(sent[0].envelope.replyContext?.metadata?.handoff?.auth?.kind).toBe('authorization_request');

    router.handle({
      type: 'interaction.response',
      id: interactionPayload.interaction.id,
      action: 'approve_once',
      values: { card_message_id: 'card-message-1' },
      operatorId: 'owner.agentid.pub',
    });

    await expect(decisionPromise).resolves.toBe('allow');
    expect(prompts.some(text => text.includes('已向 owner'))).toBe(true);
  });

  it('cancels pending cross-session approvals when the origin session is interrupted', async () => {
    const sent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const router = new InteractionRouter();
    const gateway = new PermissionGateway();
    const home = process.env.EVOLCLAW_HOME!;

    const decisionPromise = gateway.requestPermission(
      'origin-session',
      'Bash',
      { command: 'sudo make install' },
      async () => {},
      {
        adapter: fakeAunAdapter(sent),
        channelId: 'guest.agentid.pub',
        interactionRouter: router,
        userId: 'guest.agentid.pub',
        channel: 'aun',
        agentName: 'self.agentid.pub',
        taskId: 'task-2',
        chatmode: 'interactive',
        role: 'guest',
        chatType: 'private',
        crossSessionApproval: {
          adapter: fakeAunAdapter(sent),
          ownerAid: 'owner.agentid.pub',
          selfAid: 'self.agentid.pub',
          originSessionId: 'origin-session',
          originChannelId: 'guest.agentid.pub',
          originRole: 'guest',
          originChatDir: path.join(home, 'origin-chat'),
          approvalTtlMs: 2_000,
        },
      },
      'sudo make install',
      '危险命令需要 owner 临时授权',
    );

    await waitTick();
    expect(sent).toHaveLength(1);
    gateway.cancelAll('origin-session', 'new_message');

    await expect(decisionPromise).resolves.toBe('deny');
    const interactionPayload = sent[0].payload;
    if (interactionPayload.kind !== 'interaction') throw new Error('expected interaction payload');
    expect(router.handle({
      type: 'interaction.response',
      id: interactionPayload.interaction.id,
      action: 'approve_once',
      operatorId: 'owner.agentid.pub',
    })).toBe(false);
  });
});
