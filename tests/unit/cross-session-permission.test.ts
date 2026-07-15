import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { PermissionGateway, planApprovalRoute } from '../../src/core/permission.js';
import { InteractionRouter, renderActionAsText } from '../../src/core/interaction-router.js';
import type { AuthorizationChallenge, ChannelAdapter, OutboundEnvelope, OutboundPayload } from '../../src/types.js';

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
  it('never routes a non-grantable challenge', () => {
    const challenge: AuthorizationChallenge = {
      id: 'challenge-1',
      sessionId: 'session-1',
      toolName: 'Bash',
      toolInput: { command: 'sudo make install' },
      summary: 'sudo make install',
      grantable: false,
      approverPolicy: 'agent_owner',
      createdAt: Date.now(),
    };

    expect(planApprovalRoute(challenge, {
      userId: 'admin.agentid.pub',
      approvalRouting: {
        approverPolicy: 'agent_owner',
        owners: ['owner.agentid.pub'],
        ownerAdapter: fakeAunAdapter([]),
        originSessionId: 'session-1',
      },
    })).toEqual({ kind: 'unavailable', reason: 'challenge_not_grantable' });
  });

  it('does not fall back to requester approval when agent-owner policy has no owner', () => {
    const challenge: AuthorizationChallenge = {
      id: 'challenge-2',
      sessionId: 'session-2',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/report.txt' },
      summary: 'Write /tmp/report.txt',
      grantable: true,
      approverPolicy: 'agent_owner',
      createdAt: Date.now(),
    };

    expect(planApprovalRoute(challenge, {
      userId: 'admin.agentid.pub',
      approvalRouting: {
        approverPolicy: 'agent_owner',
        owners: [],
        originSessionId: 'session-2',
      },
    })).toEqual({ kind: 'unavailable', reason: 'no_agent_owner_configured' });
  });

  it('fails requester approval closed when no requester identity is available', () => {
    const challenge: AuthorizationChallenge = {
      id: 'challenge-no-requester',
      sessionId: 'session-no-requester',
      toolName: 'Bash',
      toolInput: { command: 'npm install' },
      summary: 'npm install',
      grantable: true,
      approverPolicy: 'requester',
      createdAt: Date.now(),
    };

    expect(planApprovalRoute(challenge)).toEqual({
      kind: 'unavailable',
      reason: 'no_requester_approver',
    });
    expect(planApprovalRoute(challenge, { channelId: 'group.agentid.pub/room' })).toEqual({
      kind: 'unavailable',
      reason: 'no_requester_approver',
    });
    expect(planApprovalRoute({ ...challenge, approverPolicy: 'agent_owner' }, {
      approvalRouting: {
        approverPolicy: 'agent_owner',
        owners: ['owner.agentid.pub'],
        ownerAdapter: fakeAunAdapter([]),
        originSessionId: 'session-no-requester',
      },
    })).toEqual({
      kind: 'unavailable',
      reason: 'no_requester_approver',
    });
  });

  it('treats an unknown local approval action as deny', async () => {
    const gateway = new PermissionGateway();
    const decision = gateway.requestPermission(
      'session-unknown-action',
      'Bash',
      { command: 'npm install' },
      async () => {},
      { userId: 'user.agentid.pub', channelId: 'user.agentid.pub' },
    );
    await waitTick();
    const [requestId] = gateway.getPendingRequests('session-unknown-action');
    expect(gateway.resolvePermission('session-unknown-action', requestId, 'unexpected-action', 'user.agentid.pub')).toBe(true);
    await expect(decision).resolves.toBe('deny');
  });

  it('registers a local approval before the adapter can deliver an immediate response', async () => {
    const router = new InteractionRouter();
    const gateway = new PermissionGateway();
    let handled = false;
    const adapter: ChannelAdapter = {
      channelName: 'aun#self.agentid.pub#main',
      channelKey: 'aun#self.agentid.pub#main',
      capabilities: { interaction: true, file: false, image: false, markdown: true, thought: false, status: false, thread: false },
      async send(_envelope, payload) {
        if (payload.kind !== 'interaction') return;
        handled = router.handle({
          type: 'interaction.response',
          id: payload.interaction.id,
          action: 'allow',
          operatorId: 'owner.agentid.pub',
        });
      },
    };

    const decisionPromise = gateway.requestPermission(
      'immediate-local-session',
      'Bash',
      { command: 'npm install' },
      async () => {},
      {
        adapter,
        channelId: 'owner.agentid.pub',
        interactionRouter: router,
        userId: 'owner.agentid.pub',
        chatType: 'private',
        approvalRouting: {
          approverPolicy: 'agent_owner',
          owners: ['owner.agentid.pub'],
          ownerAdapter: adapter,
          originSessionId: 'immediate-local-session',
        },
      },
    );

    await waitTick();
    if (!handled) gateway.cancelAll('immediate-local-session', 'test_cleanup');
    expect(handled).toBe(true);
    await expect(decisionPromise).resolves.toBe('allow');
  });

  it('registers an owner handoff before the adapter can deliver an immediate response', async () => {
    const router = new InteractionRouter();
    const gateway = new PermissionGateway();
    let handled = false;
    const ownerAdapter: ChannelAdapter = {
      channelName: 'aun#self.agentid.pub#main',
      channelKey: 'aun#self.agentid.pub#main',
      capabilities: { interaction: true, file: false, image: false, markdown: true, thought: false, status: false, thread: false },
      async send(_envelope, payload) {
        if (payload.kind !== 'interaction') return;
        handled = router.handle({
          type: 'interaction.response',
          id: payload.interaction.id,
          action: 'approve_once',
          operatorId: 'owner.agentid.pub',
        });
      },
    };

    const decisionPromise = gateway.requestPermission(
      'immediate-handoff-session',
      'Bash',
      { command: 'sudo make install' },
      async () => {},
      {
        channelId: 'admin.agentid.pub',
        interactionRouter: router,
        userId: 'admin.agentid.pub',
        role: 'admin',
        chatType: 'private',
        approvalRouting: {
          approverPolicy: 'agent_owner',
          owners: ['owner.agentid.pub'],
          ownerAdapter,
          originSessionId: 'immediate-handoff-session',
          originPeerId: 'admin.agentid.pub',
          originRole: 'admin',
        },
      },
    );

    await waitTick();
    if (!handled) gateway.cancelAll('immediate-handoff-session', 'test_cleanup');
    expect(handled).toBe(true);
    await expect(decisionPromise).resolves.toBe('allow');
  });

  it('allows the bound owner to use the explicit /perm text fallback across sessions', async () => {
    const sent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const router = new InteractionRouter();
    const gateway = new PermissionGateway();
    const ownerAdapter = {
      ...fakeAunAdapter(sent),
      capabilities: {
        interaction: false,
        file: false,
        image: false,
        markdown: true,
        thought: false,
        status: false,
        thread: false,
      },
    } as ChannelAdapter;

    const decisionPromise = gateway.requestPermission(
      'text-fallback-origin-session',
      'Bash',
      { command: 'sudo make install' },
      async () => {},
      {
        channelId: 'admin.agentid.pub',
        interactionRouter: router,
        userId: 'admin.agentid.pub',
        role: 'admin',
        chatType: 'private',
        approvalRouting: {
          approverPolicy: 'agent_owner',
          owners: ['owner.agentid.pub'],
          ownerAdapter,
          originSessionId: 'text-fallback-origin-session',
          originPeerId: 'admin.agentid.pub',
          originRole: 'admin',
        },
      },
    );

    await waitTick();
    const payload = sent[0]?.payload;
    if (payload?.kind !== 'interaction') throw new Error('expected interaction payload');
    const requestId = payload.interaction.id;
    const fallback = renderActionAsText(payload.interaction);
    expect(fallback).toContain(`/perm ${requestId} allow`);
    expect(fallback).toContain(`/perm ${requestId} always`);
    expect(fallback).toContain(`/perm ${requestId} deny`);
    expect(payload.fallbackText).toBe(fallback);

    expect(gateway.resolvePermissionByRequestId(requestId, 'allow', 'other.agentid.pub')).toBe(false);
    expect(gateway.getPendingRequests('text-fallback-origin-session')).toEqual([requestId]);
    expect(gateway.resolvePermissionByRequestId(requestId, 'always', 'owner.agentid.pub')).toBe(true);
    await expect(decisionPromise).resolves.toBe('allow');
    expect(router.handle({
      type: 'interaction.response',
      id: requestId,
      action: 'approve_once',
      operatorId: 'owner.agentid.pub',
    })).toBe(false);
  });

  it('routes an admin challenge to the AUN owner and resolves allow on owner approval', async () => {
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
        role: 'admin',
        chatType: 'private',
        approvalRouting: {
          approverPolicy: 'agent_owner',
          owners: ['owner.agentid.pub'],
          ownerAdapter: fakeAunAdapter(sent),
          selfAid: 'self.agentid.pub',
          originSessionId: 'origin-session',
          originMessageId: 'origin-message',
          originChannel: 'aun',
          originChannelId: 'guest.agentid.pub',
          originPeerId: 'guest.agentid.pub',
          originRole: 'admin',
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
    expect(interactionPayload.interaction.kind.kind).toBe('action');
    if (interactionPayload.interaction.kind.kind !== 'action') throw new Error('expected action interaction');
    expect(interactionPayload.interaction.kind.title).toBe('临时授权申请');
    expect(interactionPayload.interaction.kind.buttons.map(button => button.key)).toEqual([
      'approve_once',
      'approve_session_30m',
      'deny',
    ]);
    expect(interactionPayload.interaction.kind.bodyFormat).toBe('markdown');
    expect(interactionPayload.interaction.kind.body).toContain('**申请信息**');
    expect(interactionPayload.interaction.kind.body).toContain('**申请主体**：`guest.agentid.pub` · role `admin` · via `aun`');
    expect(interactionPayload.interaction.kind.body).not.toContain('披露 / 审批给');
    expect(interactionPayload.interaction.kind.body).not.toContain('执行 Agent');
    expect(interactionPayload.interaction.kind.body).not.toContain('来源会话');
    expect(interactionPayload.interaction.kind.body).not.toContain('Session');
    expect(interactionPayload.interaction.kind.body).toContain('**申请能力**：`tool:Bash`');
    expect(interactionPayload.interaction.kind.body).toContain('```text\nrm -rf tmp\n```');
    expect(interactionPayload.interaction.kind.body).toContain('**申请原因**：危险命令需要 owner 临时授权');
    expect(interactionPayload.interaction.kind.body).toContain('**风险：中**');
    expect(interactionPayload.interaction.kind.body).not.toContain('仅当前 challenge');
    expect(interactionPayload.interaction.kind.body).not.toContain('仅同一 session');
    expect(sent[0].envelope.replyContext?.metadata?.source).toBe('handoff');
    expect(sent[0].envelope.replyContext?.metadata?.handoff).toBeUndefined();

    expect(router.handle({
      type: 'interaction.response',
      id: interactionPayload.interaction.id,
      action: 'approve_once',
    })).toBe(false);
    expect(gateway.getPendingRequests('origin-session')).toEqual([interactionPayload.interaction.id]);

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
        role: 'member',
        chatType: 'private',
        approvalRouting: {
          approverPolicy: 'agent_owner',
          owners: ['owner.agentid.pub'],
          ownerAdapter: fakeAunAdapter(sent),
          selfAid: 'self.agentid.pub',
          originSessionId: 'origin-session',
          originChannelId: 'guest.agentid.pub',
          originRole: 'member',
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

  it('keeps an agent-owner challenge in the current owner session', async () => {
    const localSent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const handoffSent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const router = new InteractionRouter();
    const gateway = new PermissionGateway();

    const decisionPromise = gateway.requestPermission(
      'owner-session',
      'Bash',
      { command: 'sudo make install' },
      async () => {},
      {
        adapter: fakeAunAdapter(localSent),
        channelId: 'owner.agentid.pub',
        interactionRouter: router,
        userId: 'owner.agentid.pub',
        channel: 'aun',
        role: 'owner',
        chatType: 'private',
        approvalRouting: {
          approverPolicy: 'agent_owner',
          owners: ['owner.agentid.pub'],
          ownerAdapter: fakeAunAdapter(handoffSent),
          originSessionId: 'owner-session',
        },
      },
      'sudo make install',
    );

    await waitTick();
    expect(localSent).toHaveLength(1);
    expect(handoffSent).toHaveLength(0);
    expect(localSent[0].envelope.replyContext?.metadata?.handoff).toBeUndefined();
    const payload = localSent[0].payload;
    if (payload.kind !== 'interaction') throw new Error('expected interaction payload');
    expect(payload.interaction.channelId).toBe('owner.agentid.pub');
    expect(payload.interaction.kind.kind).toBe('action');
    if (payload.interaction.kind.kind !== 'action') throw new Error('expected action interaction');
    expect(payload.interaction.kind.title).toBe('🔐 权限请求');
    expect(payload.interaction.kind.buttons.map(button => button.key)).toEqual(['allow', 'always', 'deny']);

    router.handle({
      type: 'interaction.response',
      id: payload.interaction.id,
      action: 'allow',
      operatorId: 'owner.agentid.pub',
    });
    await expect(decisionPromise).resolves.toBe('allow');
  });

  it('uses requester policy locally regardless of role', async () => {
    const localSent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const handoffSent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const router = new InteractionRouter();
    const gateway = new PermissionGateway();

    const decisionPromise = gateway.requestPermission(
      'admin-session',
      'Write',
      { file_path: '/tmp/report.txt' },
      async () => {},
      {
        adapter: fakeAunAdapter(localSent),
        channelId: 'admin.agentid.pub',
        interactionRouter: router,
        userId: 'admin.agentid.pub',
        channel: 'aun',
        role: 'admin',
        chatType: 'private',
        approvalRouting: {
          approverPolicy: 'requester',
          owners: ['owner.agentid.pub'],
          ownerAdapter: fakeAunAdapter(handoffSent),
          originSessionId: 'admin-session',
        },
      },
      'Write /tmp/report.txt',
    );

    await waitTick();
    expect(localSent).toHaveLength(1);
    expect(handoffSent).toHaveLength(0);
    const payload = localSent[0].payload;
    if (payload.kind !== 'interaction') throw new Error('expected interaction payload');
    expect(payload.interaction.channelId).toBe('admin.agentid.pub');

    router.handle({
      type: 'interaction.response',
      id: payload.interaction.id,
      action: 'deny',
      operatorId: 'admin.agentid.pub',
    });
    await expect(decisionPromise).resolves.toBe('deny');
  });

  it('routes an owner challenge from a group to the owner private handoff channel', async () => {
    const localSent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const handoffSent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const router = new InteractionRouter();
    const gateway = new PermissionGateway();

    const decisionPromise = gateway.requestPermission(
      'group-session',
      'Bash',
      { command: 'sudo make install' },
      async () => {},
      {
        adapter: fakeAunAdapter(localSent),
        channelId: 'group.agentid.pub/42',
        interactionRouter: router,
        userId: 'owner.agentid.pub',
        channel: 'aun',
        role: 'owner',
        chatType: 'group',
        approvalRouting: {
          approverPolicy: 'agent_owner',
          owners: ['owner.agentid.pub'],
          ownerAdapter: fakeAunAdapter(handoffSent),
          selfAid: 'self.agentid.pub',
          originSessionId: 'group-session',
          originChannel: 'aun',
          originChannelId: 'group.agentid.pub/42',
          originPeerId: 'owner.agentid.pub',
          originRole: 'owner',
        },
      },
      'sudo make install',
    );

    await waitTick();
    expect(localSent).toHaveLength(0);
    expect(handoffSent).toHaveLength(1);
    const payload = handoffSent[0].payload;
    if (payload.kind !== 'interaction') throw new Error('expected interaction payload');
    expect(payload.interaction.channelId).toBe('owner.agentid.pub');
    if (payload.interaction.kind.kind !== 'action') throw new Error('expected action interaction');
    expect(payload.interaction.kind.body).toContain('**申请主体**：`owner.agentid.pub` · role `owner` · via `aun`');
    expect(payload.interaction.kind.body).toContain('**来源会话**：`group.agentid.pub/42`');
    expect(handoffSent[0].envelope.replyContext?.metadata?.source).toBe('handoff');

    router.handle({
      type: 'interaction.response',
      id: payload.interaction.id,
      action: 'deny',
      operatorId: 'owner.agentid.pub',
    });
    await expect(decisionPromise).resolves.toBe('deny');
  });

  it('applies a 30-minute grant only to the same session, tool, and input', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00+08:00'));
    try {
      const sent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
      const router = new InteractionRouter();
      const gateway = new PermissionGateway();
      const context = {
        adapter: fakeAunAdapter([]),
        channelId: 'admin.agentid.pub',
        interactionRouter: router,
        userId: 'admin.agentid.pub',
        channel: 'aun',
        role: 'admin',
        chatType: 'private' as const,
        approvalRouting: {
          approverPolicy: 'agent_owner' as const,
          owners: ['owner.agentid.pub'],
          ownerAdapter: fakeAunAdapter(sent),
          selfAid: 'self.agentid.pub',
          originSessionId: 'session-1',
          originChannel: 'aun',
          originChannelId: 'admin.agentid.pub',
          originPeerId: 'admin.agentid.pub',
        },
      };
      const input = { command: 'sudo make install', timeout: 120_000 };

      const first = gateway.requestPermission('session-1', 'Bash', input, async () => {}, context);
      await vi.advanceTimersByTimeAsync(0);
      const firstPayload = sent[0].payload;
      if (firstPayload.kind !== 'interaction') throw new Error('expected interaction payload');
      router.handle({
        type: 'interaction.response',
        id: firstPayload.interaction.id,
        action: 'approve_session_30m',
        operatorId: 'owner.agentid.pub',
      });
      await expect(first).resolves.toBe('allow');

      await expect(gateway.requestPermission('session-1', 'Bash', {
        timeout: 120_000,
        command: 'sudo make install',
      }, async () => {}, context)).resolves.toBe('allow');
      expect(sent).toHaveLength(1);

      const differentInput = gateway.requestPermission(
        'session-1',
        'Bash',
        { command: 'sudo make uninstall', timeout: 120_000 },
        async () => {},
        context,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(2);
      gateway.cancelAll('session-1');
      await expect(differentInput).resolves.toBe('deny');

      const differentSession = gateway.requestPermission(
        'session-2',
        'Bash',
        input,
        async () => {},
        {
          ...context,
          approvalRouting: { ...context.approvalRouting, originSessionId: 'session-2' },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(3);
      gateway.cancelAll('session-2');
      await expect(differentSession).resolves.toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires the scoped session grant after 30 minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00+08:00'));
    try {
      const sent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
      const router = new InteractionRouter();
      const gateway = new PermissionGateway();
      const context = {
        adapter: fakeAunAdapter([]),
        channelId: 'admin.agentid.pub',
        interactionRouter: router,
        userId: 'admin.agentid.pub',
        channel: 'aun',
        role: 'admin',
        chatType: 'private' as const,
        approvalRouting: {
          approverPolicy: 'agent_owner' as const,
          owners: ['owner.agentid.pub'],
          ownerAdapter: fakeAunAdapter(sent),
          selfAid: 'self.agentid.pub',
          originSessionId: 'session-1',
          originChannel: 'aun',
          originChannelId: 'admin.agentid.pub',
          originPeerId: 'admin.agentid.pub',
        },
      };
      const input = { command: 'sudo make install' };

      const first = gateway.requestPermission('session-1', 'Bash', input, async () => {}, context);
      await vi.advanceTimersByTimeAsync(0);
      const firstPayload = sent[0].payload;
      if (firstPayload.kind !== 'interaction') throw new Error('expected interaction payload');
      router.handle({
        type: 'interaction.response',
        id: firstPayload.interaction.id,
        action: 'approve_session_30m',
        operatorId: 'owner.agentid.pub',
      });
      await expect(first).resolves.toBe('allow');

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
      const afterExpiry = gateway.requestPermission('session-1', 'Bash', input, async () => {}, context);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(2);
      gateway.cancelAll('session-1');
      await expect(afterExpiry).resolves.toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies an agent-owner challenge when the owner channel is unavailable', async () => {
    const localSent: Array<{ envelope: OutboundEnvelope; payload: OutboundPayload }> = [];
    const prompts: string[] = [];
    const gateway = new PermissionGateway();

    const decision = await gateway.requestPermission(
      'admin-session',
      'Bash',
      { command: 'sudo make install' },
      async text => { prompts.push(text); },
      {
        adapter: fakeAunAdapter(localSent),
        channelId: 'admin.agentid.pub',
        userId: 'admin.agentid.pub',
        channel: 'aun',
        role: 'admin',
        chatType: 'private',
        approvalRouting: {
          approverPolicy: 'agent_owner',
          owners: ['owner.agentid.pub'],
          originSessionId: 'admin-session',
        },
      },
      'sudo make install',
    );

    expect(decision).toBe('deny');
    expect(localSent).toHaveLength(0);
    expect(prompts).toContain('当前操作需要授权，但审批人不可用（owner_approval_channel_unavailable）。');
  });
});
