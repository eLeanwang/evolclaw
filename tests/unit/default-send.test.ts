import { describe, it, expect, vi } from 'vitest';
import { defaultSend } from '../../src/core/message/default-send.js';
import type { ChannelAdapter, OutboundEnvelope, OutboundPayload, ChannelCapabilities } from '../../src/types.js';

function makeEnvelope(overrides: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    taskId: 't-001',
    channel: 'test',
    channelId: 'c1',
    agentName: 'test-agent',
    chatmode: 'interactive',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeAdapter(caps: Partial<ChannelCapabilities>, methods: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    channelName: 'test',
    capabilities: {
      file: false,
      image: false,
      interaction: false,
      markdown: false,
      thought: false,
      status: false,
      ...caps,
    },
    sendText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendInteraction: vi.fn().mockResolvedValue('msg-1'),
    sendProcessingStatus: vi.fn(),
    putThought: vi.fn().mockResolvedValue(undefined),
    sendCustomPayload: vi.fn(),
    ...methods,
  };
}

describe('defaultSend — result.text / command / system / error', () => {
  it('result.text 调用 sendText 并附 metadata', async () => {
    const adapter = makeAdapter({});
    const env = makeEnvelope();
    const payload: OutboundPayload = { kind: 'result.text', text: 'hello', isFinal: true };
    await defaultSend(adapter, env, payload);
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    const [chId, text, ctx] = (adapter.sendText as any).mock.calls[0];
    expect(chId).toBe('c1');
    expect(text).toBe('hello');
    expect(ctx.metadata).toMatchObject({ taskId: 't-001', chatmode: 'interactive' });
    expect(ctx.title).toBe('✓ 最终回复:');
  });

  it('result.text isFinal=false 不附 title', async () => {
    const adapter = makeAdapter({});
    await defaultSend(adapter, makeEnvelope(), { kind: 'result.text', text: 'partial', isFinal: false });
    const [, , ctx] = (adapter.sendText as any).mock.calls[0];
    expect(ctx.title).toBeUndefined();
  });

  it('command.result/error 走 sendText', async () => {
    const adapter = makeAdapter({});
    await defaultSend(adapter, makeEnvelope(), { kind: 'command.result', text: 'ok' });
    await defaultSend(adapter, makeEnvelope(), { kind: 'command.error', text: 'fail' });
    expect(adapter.sendText).toHaveBeenCalledTimes(2);
  });

  it('result.error / system.notice / system.error 走 sendText', async () => {
    const adapter = makeAdapter({});
    await defaultSend(adapter, makeEnvelope(), { kind: 'result.error', text: 'err' });
    await defaultSend(adapter, makeEnvelope(), { kind: 'system.notice', text: 'n', subtype: 'restarted' });
    await defaultSend(adapter, makeEnvelope(), { kind: 'system.error', text: 'e', subtype: 'fatal' });
    expect(adapter.sendText).toHaveBeenCalledTimes(3);
  });
});

describe('defaultSend — result.file / result.image 降级矩阵', () => {
  it('有 file 能力调用 sendFile', async () => {
    const adapter = makeAdapter({ file: true });
    await defaultSend(adapter, makeEnvelope(), { kind: 'result.file', filePath: '/x/y.md' });
    expect(adapter.sendFile).toHaveBeenCalledWith('c1', '/x/y.md', expect.objectContaining({ metadata: expect.any(Object) }));
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it('无 file 能力降级 sendText 输出路径', async () => {
    const adapter = makeAdapter({ file: false });
    await defaultSend(adapter, makeEnvelope(), { kind: 'result.file', filePath: '/x/y.md', fileName: 'y.md' });
    expect(adapter.sendFile).not.toHaveBeenCalled();
    const text = (adapter.sendText as any).mock.calls[0][1];
    expect(text).toContain('y.md');
    expect(text).toContain('/x/y.md');
  });

  it('有 image 能力调用 sendImage', async () => {
    const adapter = makeAdapter({ image: true });
    const buf = Buffer.from('png');
    await defaultSend(adapter, makeEnvelope(), { kind: 'result.image', data: buf });
    expect(adapter.sendImage).toHaveBeenCalledWith('c1', buf, expect.any(Object));
  });

  it('无 image 能力丢弃（不调用任何方法）', async () => {
    const adapter = makeAdapter({ image: false });
    await defaultSend(adapter, makeEnvelope(), { kind: 'result.image', data: Buffer.from('x') });
    expect(adapter.sendImage).not.toHaveBeenCalled();
    expect(adapter.sendText).not.toHaveBeenCalled();
  });
});

describe('defaultSend — interaction 降级', () => {
  it('有 interaction 能力调用 sendInteraction', async () => {
    const adapter = makeAdapter({ interaction: true });
    const interaction: any = { type: 'interaction', id: 'i1', channelId: 'c1', sessionId: 's1', kind: { kind: 'action', title: 't', buttons: [] } };
    await defaultSend(adapter, makeEnvelope(), { kind: 'interaction', interaction });
    expect(adapter.sendInteraction).toHaveBeenCalledTimes(1);
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it('无 interaction 能力降级 sendText(fallbackText)', async () => {
    const adapter = makeAdapter({ interaction: false });
    const interaction: any = { type: 'interaction', id: 'i1', channelId: 'c1', sessionId: 's1', kind: { kind: 'action', title: 't', buttons: [] } };
    await defaultSend(adapter, makeEnvelope(), { kind: 'interaction', interaction, fallbackText: '请确认' });
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    expect((adapter.sendText as any).mock.calls[0][1]).toBe('请确认');
  });
});

describe('defaultSend — status.* 降级', () => {
  it('有 status 能力调用 sendProcessingStatus', async () => {
    const adapter = makeAdapter({ status: true });
    await defaultSend(adapter, makeEnvelope(), { kind: 'status.started' });
    expect(adapter.sendProcessingStatus).toHaveBeenCalledTimes(1);
    expect((adapter.sendProcessingStatus as any).mock.calls[0][1]).toBe('start');
  });

  it('status.completed → done', async () => {
    const adapter = makeAdapter({ status: true });
    await defaultSend(adapter, makeEnvelope(), { kind: 'status.completed', metadata: { durationMs: 100 } });
    expect((adapter.sendProcessingStatus as any).mock.calls[0][1]).toBe('done');
  });

  it('status.timeout → timeout', async () => {
    const adapter = makeAdapter({ status: true });
    await defaultSend(adapter, makeEnvelope(), { kind: 'status.timeout' });
    expect((adapter.sendProcessingStatus as any).mock.calls[0][1]).toBe('timeout');
  });

  it('无 status 能力静默跳过', async () => {
    const adapter = makeAdapter({ status: false });
    await defaultSend(adapter, makeEnvelope(), { kind: 'status.started' });
    expect(adapter.sendProcessingStatus).not.toHaveBeenCalled();
    expect(adapter.sendText).not.toHaveBeenCalled();
  });
});

describe('defaultSend — activity.* (proactive)', () => {
  it('proactive + thought 能力 → putThought (stage=tool)', async () => {
    const adapter = makeAdapter({ thought: true });
    await defaultSend(adapter, makeEnvelope({ chatmode: 'proactive' }), {
      kind: 'activity.tool_use',
      text: '🔧 Read',
      metadata: { tool: 'Read', callId: 'c1' },
    });
    expect(adapter.putThought).toHaveBeenCalledTimes(1);
    const payload = (adapter.putThought as any).mock.calls[0][2];
    expect(payload).toMatchObject({ type: 'thought', stage: 'tool', task_id: 't-001', chatmode: 'proactive' });
    expect(payload.metadata).toEqual({ tool: 'Read', callId: 'c1' });
  });

  it('proactive 无 thought 能力静默丢弃', async () => {
    const adapter = makeAdapter({ thought: false });
    await defaultSend(adapter, makeEnvelope({ chatmode: 'proactive' }), {
      kind: 'activity.thinking',
      text: 'thinking',
    });
    expect(adapter.putThought).not.toHaveBeenCalled();
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it('interactive 模式 activity 走 sendText（兜底）', async () => {
    const adapter = makeAdapter({});
    await defaultSend(adapter, makeEnvelope({ chatmode: 'interactive' }), {
      kind: 'activity.notice',
      text: '⚠️ retry',
      severity: 'warn',
    });
    expect(adapter.sendText).toHaveBeenCalledTimes(1);
  });

  it('activity.thinking → stage=thinking', async () => {
    const adapter = makeAdapter({ thought: true });
    await defaultSend(adapter, makeEnvelope({ chatmode: 'proactive' }), {
      kind: 'activity.thinking',
      text: 'pondering',
    });
    expect((adapter.putThought as any).mock.calls[0][2].stage).toBe('thinking');
  });

  it('activity.progress → stage=planning', async () => {
    const adapter = makeAdapter({ thought: true });
    await defaultSend(adapter, makeEnvelope({ chatmode: 'proactive' }), {
      kind: 'activity.progress',
      text: '⏳ progress',
    });
    expect((adapter.putThought as any).mock.calls[0][2].stage).toBe('planning');
  });
});

describe('defaultSend — custom', () => {
  it('有 sendCustomPayload 透传 JSON', async () => {
    const adapter = makeAdapter({});
    await defaultSend(adapter, makeEnvelope(), { kind: 'custom', channelType: 'aun', payload: { foo: 'bar' } });
    expect(adapter.sendCustomPayload).toHaveBeenCalledTimes(1);
    expect((adapter.sendCustomPayload as any).mock.calls[0][1]).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('payload 已是字符串则直接透传', async () => {
    const adapter = makeAdapter({});
    await defaultSend(adapter, makeEnvelope(), { kind: 'custom', channelType: 'aun', payload: 'raw-str' });
    expect((adapter.sendCustomPayload as any).mock.calls[0][1]).toBe('raw-str');
  });

  it('无 sendCustomPayload 静默丢弃', async () => {
    const adapter = makeAdapter({});
    delete (adapter as any).sendCustomPayload;
    await defaultSend(adapter, makeEnvelope(), { kind: 'custom', channelType: 'x', payload: {} });
    // 不抛即可
  });
});

describe('defaultSend — capabilities 缺省时按方法存在性推断', () => {
  it('adapter 无 capabilities 时按 sendFile/sendImage 等推断', async () => {
    const adapter: ChannelAdapter = {
      channelName: 'legacy',
      sendText: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
      // 无 sendImage / sendInteraction
    };
    // 有 sendFile → 推断 file=true
    await defaultSend(adapter, makeEnvelope(), { kind: 'result.file', filePath: '/x' });
    expect(adapter.sendFile).toHaveBeenCalledTimes(1);

    // 无 sendImage → 推断 image=false → 丢弃
    await defaultSend(adapter, makeEnvelope(), { kind: 'result.image', data: Buffer.from('x') });
    expect(adapter.sendText).not.toHaveBeenCalled();
  });
});
