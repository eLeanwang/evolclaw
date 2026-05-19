import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEnvelope } from '../../src/core/message/message-processor.js';
import { sendSystemPayload } from '../../src/index.js';
import type { ChannelAdapter, OutboundEnvelope, OutboundPayload } from '../../src/types.js';

/**
 * 系统通知出站统一改造测试（Phase 3）
 *
 * 覆盖：
 * 1. buildEnvelope helper：字段填充正确，chatmode 默认 interactive
 * 2. sendSystemPayload helper：adapter.send 优先；缺失时按 kind 降级到 sendText
 * 3. 各调用点的 payload kind/subtype 与文档一致：
 *    - 上线通知 → system.notice / restarted
 *    - 重启完成通知 → system.notice / restarted
 *    - channel:error 告警 → system.error / channel_down
 */

function makeAdapterWithSend(): ChannelAdapter & { send: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn> } {
  const sendText = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  return {
    channelName: 'aun-test',
    capabilities: { file: true, image: true, interaction: true, markdown: true, thought: true, status: true },
    send,
    sendText,
  } as any;
}

function makeAdapterWithoutSend(): ChannelAdapter & { sendText: ReturnType<typeof vi.fn> } {
  const sendText = vi.fn().mockResolvedValue(undefined);
  return {
    channelName: 'legacy-test',
    sendText,
  } as any;
}

describe('buildEnvelope', () => {
  it('fills required fields and defaults chatmode to interactive', () => {
    const env = buildEnvelope({
      taskId: 't-1',
      channel: 'aun-foo',
      channelId: 'owner.agentid.pub',
      agentName: 'reviewer',
    });
    expect(env.taskId).toBe('t-1');
    expect(env.channel).toBe('aun-foo');
    expect(env.channelId).toBe('owner.agentid.pub');
    expect(env.agentName).toBe('reviewer');
    expect(env.chatmode).toBe('interactive');
    expect(env.replyContext).toBeUndefined();
    expect(typeof env.timestamp).toBe('number');
    expect(env.timestamp).toBeGreaterThan(0);
  });

  it('honors chatmode and replyContext when provided', () => {
    const env = buildEnvelope({
      taskId: 't-2',
      channel: 'feishu-1',
      channelId: 'chat-id',
      agentName: 'agent',
      chatmode: 'proactive',
      replyContext: { replyToMessageId: 'msg-1' },
    });
    expect(env.chatmode).toBe('proactive');
    expect(env.replyContext).toEqual({ replyToMessageId: 'msg-1' });
  });
});

describe('sendSystemPayload — adapter.send happy path', () => {
  it('forwards (envelope, payload) to adapter.send when available', async () => {
    const adapter = makeAdapterWithSend();
    const envelope = buildEnvelope({ taskId: 't-1', channel: 'aun-test', channelId: 'peer', agentName: 'agent' });
    const payload: OutboundPayload = { kind: 'system.notice', text: 'hi', subtype: 'restarted' };
    await sendSystemPayload(adapter, envelope, payload);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledWith(envelope, payload);
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it('still forwards system.error', async () => {
    const adapter = makeAdapterWithSend();
    const envelope = buildEnvelope({ taskId: 't-2', channel: 'aun-test', channelId: 'peer', agentName: 'agent' });
    const payload: OutboundPayload = {
      kind: 'system.error',
      text: 'auth failed',
      subtype: 'channel_down',
      recoverable: false,
    };
    await sendSystemPayload(adapter, envelope, payload);
    expect(adapter.send).toHaveBeenCalledWith(envelope, payload);
  });
});

describe('sendSystemPayload — fallback to sendText', () => {
  it('uses sendText when adapter.send missing (system.notice)', async () => {
    const adapter = makeAdapterWithoutSend();
    const envelope = buildEnvelope({
      taskId: 't-1',
      channel: 'legacy-test',
      channelId: 'owner-id',
      agentName: 'agent',
      replyContext: { replyToMessageId: 'm-9' },
    });
    await sendSystemPayload(adapter, envelope, {
      kind: 'system.notice',
      text: '✓ 上线了',
      subtype: 'restarted',
    });
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect(adapter.sendText).toHaveBeenCalledWith('owner-id', '✓ 上线了', { replyToMessageId: 'm-9' });
  });

  it('uses sendText for system.error fallback', async () => {
    const adapter = makeAdapterWithoutSend();
    const envelope = buildEnvelope({ taskId: 't-2', channel: 'legacy-test', channelId: 'owner-id', agentName: 'agent' });
    await sendSystemPayload(adapter, envelope, {
      kind: 'system.error',
      text: 'auth failed',
      subtype: 'channel_down',
      recoverable: false,
    });
    expect(adapter.sendText).toHaveBeenCalledWith('owner-id', 'auth failed', undefined);
  });

  it('skips silently for non-text payloads (file/image) when send absent', async () => {
    const adapter = makeAdapterWithoutSend();
    const envelope = buildEnvelope({ taskId: 't-3', channel: 'legacy-test', channelId: 'owner-id', agentName: 'agent' });
    await sendSystemPayload(adapter, envelope, {
      kind: 'result.image',
      data: Buffer.from('x'),
    } as any);
    expect(adapter.sendText).not.toHaveBeenCalled();
  });
});

describe('call-site simulation: online notification', () => {
  it('builds system.notice/restarted with agent name + projectDir', async () => {
    const adapter = makeAdapterWithSend();
    // 复刻 src/index.ts 上线通知的 payload 构造逻辑
    const agentName = '夙夜无偕';
    const projectDir = 'review-bot';
    const ownerAid = 'owner.agentid.pub';
    const text = `✓ ${agentName} 已上线 | 工作目录: ${projectDir}`;
    const envelope = buildEnvelope({
      taskId: `system-online-abc12`,
      channel: adapter.channelName,
      channelId: ownerAid,
      agentName,
    });
    await sendSystemPayload(adapter, envelope, {
      kind: 'system.notice',
      text,
      subtype: 'restarted',
    });
    expect(adapter.send).toHaveBeenCalledTimes(1);
    const [envArg, payloadArg] = adapter.send.mock.calls[0];
    expect(envArg.channelId).toBe(ownerAid);
    expect(envArg.agentName).toBe(agentName);
    expect(envArg.chatmode).toBe('interactive');
    expect(payloadArg).toMatchObject({
      kind: 'system.notice',
      subtype: 'restarted',
    });
    expect(payloadArg.text).toContain(agentName);
    expect(payloadArg.text).toContain(projectDir);
  });
});

describe('call-site simulation: restart-pending notification', () => {
  it('preserves replyContext and emits subtype=restarted', async () => {
    const adapter = makeAdapterWithSend();
    const replyContext = { replyToMessageId: 'orig-msg', replyInThread: false };
    const envelope = buildEnvelope({
      taskId: `system-restart-${process.pid}`,
      channel: adapter.channelName,
      channelId: 'oc_xxx',
      agentName: 'reviewer',
      replyContext,
    });
    await sendSystemPayload(adapter, envelope, {
      kind: 'system.notice',
      text: '✅ 服务重启成功！',
      subtype: 'restarted',
    });
    const [envArg, payloadArg] = adapter.send.mock.calls[0];
    expect(envArg.replyContext).toEqual(replyContext);
    expect(payloadArg.subtype).toBe('restarted');
    expect(payloadArg.text).toContain('重启成功');
  });
});

describe('call-site simulation: channel:error → system.error/channel_down', () => {
  it('emits one system.error per other channelType (no recoverable)', async () => {
    // 复刻 channel:error 跨通道通知的 payload 构造
    const adapter = makeAdapterWithSend();
    const ownerId = 'owner.agentid.pub';
    const errMsg = 'feishu auth_error: invalid token';
    const envelope = buildEnvelope({
      taskId: `system-channel-down-deadbe`,
      channel: adapter.channelName,
      channelId: ownerId,
      agentName: 'reviewer',
    });
    await sendSystemPayload(adapter, envelope, {
      kind: 'system.error',
      text: errMsg,
      subtype: 'channel_down',
      recoverable: false,
    });
    const [, payloadArg] = adapter.send.mock.calls[0];
    expect(payloadArg).toMatchObject({
      kind: 'system.error',
      subtype: 'channel_down',
      recoverable: false,
      text: errMsg,
    });
  });
});
