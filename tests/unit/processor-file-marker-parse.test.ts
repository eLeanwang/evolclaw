import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, Message, ChannelAdapter, ChannelPolicy, ReplyContext } from '../../src/types.js';
import fs from 'node:fs';

const testPolicy: ChannelPolicy = {
  canSwitchProject: () => true,
  canListProjects: () => true,
  canCreateSession: () => true,
  canDeleteSession: () => true,
  canImportCliSession: () => true,
  messagePrefix: () => '',
  showMiddleResult: () => true,
  showIdleMonitor: () => false,
  accumulateErrors: () => false,
};

function createStreamingRunner(resultText: string) {
  return {
    runQuery: vi.fn().mockImplementation(async () => ({
      [Symbol.asyncIterator]() {
        const events = [
          { type: 'text', text: resultText },
          { type: 'complete', isError: false, result: resultText, subtype: 'success', durationMs: 10 },
        ];
        let i = 0;
        return {
          async next() {
            if (i >= events.length) return { done: true, value: undefined };
            return { done: false, value: events[i++] };
          },
        };
      },
    })),
    registerStream: vi.fn(),
    cleanupStream: vi.fn(),
    interrupt: vi.fn(),
    updateSessionId: vi.fn(),
    closeSession: vi.fn(),
    setSendPrompt: vi.fn(),
    setMode: vi.fn(),
    name: 'claude',
  };
}

function createSessionManager() {
  const baseSession = {
    id: 'sess-1',
    channel: 'aun',
    channelId: 'peer.agentid.pub',
    projectPath: '/tmp/test-project',
    threadId: '',
    agentId: 'claude',
    chatType: 'private' as const,
    sessionMode: 'interactive' as const,
    agentSessionId: 'agent-sid',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    identity: { role: 'owner' as const, mode: 'interactive' as const },
  };
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(baseSession),
    getActiveSession: vi.fn().mockResolvedValue(baseSession),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false, lastSuccessTime: Date.now() }),
    setSafeMode: vi.fn().mockResolvedValue(undefined),
    markProcessing: vi.fn(),
    clearProcessing: vi.fn(),
  };
}

function createCache() {
  return {
    getCount: vi.fn().mockReturnValue(0),
    addEvent: vi.fn(),
    getEvents: vi.fn().mockReturnValue([]),
    clearEvents: vi.fn(),
  };
}

function createAdapter(name = 'aun') {
  const sent: Array<{ text: string; context?: ReplyContext }> = [];
  const fileSent: Array<{ channelId: string; filePath: string }> = [];
  const adapter: ChannelAdapter & { sent: typeof sent; fileSent: typeof fileSent } = {
    channelName: name,
    capabilities: { file: true, image: false, interaction: false, markdown: false, thought: false, status: false },
    send: vi.fn().mockImplementation(async (_envelope: any, payload: any) => {
      if (payload.kind === 'result.file') {
        fileSent.push({ channelId: _envelope.channelId, filePath: payload.filePath });
      } else if ('text' in payload && payload.text) {
        sent.push({ text: payload.text, context: _envelope.replyContext });
      }
    }),
    sent,
    fileSent,
  };
  return adapter;
}

const baseConfig: Config = {
  agents: { anthropic: { apiKey: 'test' } },
  channels: { aun: { aid: 'bot.agentid.pub' } },
  flushDelay: 0.01,
} as Config;

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    channel: 'aun',
    channelId: 'peer.agentid.pub',
    content: 'hello',
    peerId: 'peer.agentid.pub',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('MessageProcessor file marker parsing — channel prefix vs drive letter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Windows drive letter C: is NOT treated as channel name', async () => {
    const filePath = 'C:/Users/agentcp/projects/stale-connected-flag.md';
    const runner = createStreamingRunner(`[SEND_FILE:${filePath}]`);
    const sm = createSessionManager();
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    // Should NOT get "通道 C 未启用或不存在" error
    const errorMsg = adapter.sent.find(s => s.text.includes('通道') && s.text.includes('不存在'));
    expect(errorMsg).toBeUndefined();

    // Should attempt to send the file with the full path including C:
    expect(adapter.fileSent.length).toBe(1);
    expect(adapter.fileSent[0].filePath).toContain('Users/agentcp/projects/stale-connected-flag.md');
  });

  it('Windows drive letter D: is NOT treated as channel name', async () => {
    const filePath = 'D:/work/output.pdf';
    const runner = createStreamingRunner(`[SEND_FILE:${filePath}]`);
    const sm = createSessionManager();
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    const errorMsg = adapter.sent.find(s => s.text.includes('通道') && s.text.includes('不存在'));
    expect(errorMsg).toBeUndefined();

    expect(adapter.fileSent.length).toBe(1);
    expect(adapter.fileSent[0].filePath).toContain('work/output.pdf');
  });

  it('registered channel name IS correctly treated as cross-channel target', async () => {
    const runner = createStreamingRunner(`[SEND_FILE:feishu:/tmp/test-project/report.md]`);
    const sm = createSessionManager();
    (sm as any).getOwnerChatId = vi.fn().mockReturnValue('feishu-chat-123');
    const aunAdapter = createAdapter('aun');
    const feishuAdapter = createAdapter('feishu');
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(aunAdapter, testPolicy);
    processor.registerChannel(feishuAdapter, testPolicy);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    // Key assertion: "feishu" is recognized as a channel, NOT merged back into path
    // "通道不存在" would mean the whitelist rejected it (bug)
    const channelNotFoundErr = aunAdapter.sent.find(s => s.text.includes('未启用或不存在'));
    expect(channelNotFoundErr).toBeUndefined();

    // Cross-channel routing may fail due to missing owner config in test,
    // but the error should be about "未找到私聊会话", not "通道不存在"
    // If file was sent, great; if not, check it's the routing error not the parse error
    if (feishuAdapter.fileSent.length === 0) {
      const routingErr = aunAdapter.sent.find(s => s.text.includes('未找到') && s.text.includes('私聊会话'));
      expect(routingErr).toBeDefined();
    }
  });

  it('unregistered multi-char string is treated as path prefix, not channel', async () => {
    // "xyz" is not a registered channel — should be merged back into path
    const runner = createStreamingRunner(`[SEND_FILE:xyz:/some/path.txt]`);
    const sm = createSessionManager();
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    // Should NOT get "通道 xyz 未启用或不存在"
    const errorMsg = adapter.sent.find(s => s.text.includes('通道') && s.text.includes('不存在'));
    expect(errorMsg).toBeUndefined();

    // File sent via current channel with full path "xyz:/some/path.txt"
    expect(adapter.fileSent.length).toBe(1);
    expect(adapter.fileSent[0].filePath).toContain('xyz:');
  });

  it('simple path without colon still works (no regression)', async () => {
    const runner = createStreamingRunner(`[SEND_FILE:/tmp/test-project/output.md]`);
    const sm = createSessionManager();
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    expect(adapter.fileSent.length).toBe(1);
    expect(adapter.fileSent[0].filePath).toContain('output.md');
  });

  it('relative path without colon still works (no regression)', async () => {
    const runner = createStreamingRunner(`[SEND_FILE:./docs/readme.md]`);
    const sm = createSessionManager();
    const adapter = createAdapter();
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    expect(adapter.fileSent.length).toBe(1);
    expect(adapter.fileSent[0].filePath).toContain('docs/readme.md');
  });

  it('channelType mapping also counts as registered (not treated as path)', async () => {
    const runner = createStreamingRunner(`[SEND_FILE:wechat:/tmp/test-project/file.txt]`);
    const sm = createSessionManager();
    (sm as any).getOwnerChatId = vi.fn().mockReturnValue('wechat-user-456');
    const adapter = createAdapter('aun');
    const wxAdapter = createAdapter('wechat-instance');
    const processor = new MessageProcessor(runner as any, sm as any, baseConfig, createCache() as any, new EventBus());
    processor.registerChannel(adapter, testPolicy);
    // Register with channelType 'wechat' mapping to instance 'wechat-instance'
    processor.registerChannel(wxAdapter, testPolicy, { channelType: 'wechat' } as any);

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await processor.processMessage(createMessage());
    await new Promise(r => setTimeout(r, 100));

    // Key assertion: 'wechat' is in channelTypeMap → recognized as channel, NOT merged into path
    const channelNotFoundErr = adapter.sent.find(s => s.text.includes('未启用或不存在'));
    expect(channelNotFoundErr).toBeUndefined();

    // Cross-channel routing may fail due to missing owner config,
    // but the error should be routing-related, not parse-related
    if (wxAdapter.fileSent.length === 0) {
      const routingErr = adapter.sent.find(s => s.text.includes('未找到') && s.text.includes('私聊会话'));
      expect(routingErr).toBeDefined();
    }
  });
});
