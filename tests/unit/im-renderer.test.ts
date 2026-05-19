import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IMRenderer } from '../../src/core/message/im-renderer.js';
import type { ChannelAdapter } from '../../src/types.js';
import type { AgentEvent } from '../../src/agents/claude-runner.js';

function createAdapter(opts: { putThought?: any } = {}): ChannelAdapter {
  return {
    channelName: 'test',
    sendText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    putThought: opts.putThought ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe('IMRenderer — interactive mode (聚合窗口)', () => {
  let sendTextCb: any;

  beforeEach(() => {
    vi.useFakeTimers();
    sendTextCb = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('addText 聚合后 flush 调用 sendText', async () => {
    const adapter = createAdapter();
    const r = new IMRenderer({
      adapter,
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      flushDelay: 4000,
      sendText: sendTextCb,
    });
    r.addText('hello ');
    r.addText('world');
    await r.flush(true);
    expect(sendTextCb).toHaveBeenCalledTimes(1);
    expect(sendTextCb).toHaveBeenCalledWith('hello world', true, true);
  });

  it('addActivity 聚合到 queue', async () => {
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      sendText: sendTextCb,
    });
    r.addActivity('🔧 Read: ./README.md');
    r.addActivity('✅ Read');
    await r.flush(true);
    expect(sendTextCb).toHaveBeenCalledTimes(1);
    const [text, isFinal, hasText] = sendTextCb.mock.calls[0];
    expect(text).toContain('🔧 Read: ./README.md');
    expect(text).toContain('✅ Read');
    expect(isFinal).toBe(true);
    expect(hasText).toBe(false);
  });

  it('text + activity 按入队顺序合并', async () => {
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      sendText: sendTextCb,
    });
    r.addActivity('🔧 Tool A');
    r.addText('reply text');
    await r.flush(true);
    const text = sendTextCb.mock.calls[0][0];
    // activity 在前，text 在后
    expect(text.indexOf('🔧 Tool A')).toBeLessThan(text.indexOf('reply text'));
  });

  it('suppressActivities=true 时 addActivity 被丢弃', async () => {
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      suppressActivities: true,
      sendText: sendTextCb,
    });
    r.addActivity('🔧 Tool A');
    await r.flush(true);
    expect(sendTextCb).not.toHaveBeenCalled();
  });

  it('hasContent / hasSentContent 状态正确', async () => {
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      sendText: sendTextCb,
    });
    expect(r.hasContent()).toBe(false);
    expect(r.hasSentContent()).toBe(false);
    r.addText('x');
    expect(r.hasContent()).toBe(true);
    expect(r.hasSentContent()).toBe(false);
    await r.flush(true);
    expect(r.hasSentContent()).toBe(true);
  });

  it('getFinalText 返回累积全文', () => {
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      sendText: sendTextCb,
    });
    r.addText('part 1 ');
    r.addText('part 2');
    expect(r.getFinalText()).toBe('part 1 part 2');
  });

  it('文件标记 pattern 在 flush 时被过滤', async () => {
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      fileMarkerPattern: /\[SEND_FILE:[^\]]+\]/g,
      sendText: sendTextCb,
    });
    r.addText('文件已创建 [SEND_FILE:./report.md] 完成');
    await r.flush(true);
    const text = sendTextCb.mock.calls[0][0];
    expect(text).not.toContain('[SEND_FILE:');
  });

  it('flushActivitiesOnly 只清 activities 保留 text buffer', async () => {
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      sendText: sendTextCb,
    });
    r.addActivity('🔧 Tool A');
    r.addText('pending text');
    await r.flushActivitiesOnly();
    expect(sendTextCb).toHaveBeenCalledTimes(1);
    expect(sendTextCb.mock.calls[0][0]).toContain('🔧 Tool A');
    expect(sendTextCb.mock.calls[0][0]).not.toContain('pending text');
    expect(r.hasContent()).toBe(true); // text 还在 buffer
    await r.flush(true);
    expect(sendTextCb).toHaveBeenCalledTimes(2);
    expect(sendTextCb.mock.calls[1][0]).toContain('pending text');
  });

  it('sendText 失败不抛出，继续后续发送', async () => {
    const failOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('send fail'))
      .mockResolvedValueOnce(undefined);
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      sendText: failOnce,
    });
    r.addText('first');
    await r.flush(false);
    r.addText('second');
    await r.flush(true);
    expect(failOnce).toHaveBeenCalledTimes(2);
  });
});

describe('IMRenderer — proactive mode (逐事件 putThought)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('text 事件投影为 thought(stage=thinking)', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const adapter = createAdapter({ putThought });
    const r = new IMRenderer({
      adapter,
      channelId: 'g1',
      taskId: 'task-001',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'text', text: 'hello' } as AgentEvent);
    await new Promise(r => setImmediate(r));
    expect(putThought).toHaveBeenCalledTimes(1);
    const payload = putThought.mock.calls[0][2];
    expect(payload).toMatchObject({ type: 'thought', text: 'hello', stage: 'thinking', task_id: 'task-001', chatmode: 'proactive' });
  });

  it('tool_use 事件投影为 thought(stage=tool) 带 metadata', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'tool_use', name: 'Read', input: { file_path: './a.md' } } as AgentEvent);
    await new Promise(r => setImmediate(r));
    const payload = putThought.mock.calls[0][2];
    expect(payload.stage).toBe('tool');
    expect(payload.text).toContain('🔧 Read');
    expect(payload.metadata).toEqual({ tool: 'Read', input: './a.md' });
  });

  it('tool_result(ok) 投影为 thought(✅)', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'tool_result', name: 'Read', result: 'file content' } as AgentEvent);
    await new Promise(r => setImmediate(r));
    const payload = putThought.mock.calls[0][2];
    expect(payload.text).toContain('✅ Read');
    expect(payload.metadata).toEqual({ tool: 'Read', ok: true });
  });

  it('tool_result(error) 投影为 thought(⚠️)', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'tool_result', name: 'Read', result: null, isError: true, error: 'not found' } as AgentEvent);
    await new Promise(r => setImmediate(r));
    const payload = putThought.mock.calls[0][2];
    expect(payload.text).toContain('⚠️ Read');
    expect(payload.text).toContain('not found');
    expect(payload.metadata).toEqual({ tool: 'Read', ok: false });
  });

  it('text 已发后 complete.result 被去重跳过', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'text', text: 'streamed' } as AgentEvent);
    r.emit({ type: 'complete', result: 'streamed', isError: false } as AgentEvent);
    await new Promise(r => setImmediate(r));
    // 只有 text 那次（complete 因 hasEmittedThinking 被跳过）
    expect(putThought).toHaveBeenCalledTimes(1);
    expect(putThought.mock.calls[0][2].stage).toBe('thinking');
  });

  it('未发 text 时 complete.result 投影为 thought(summary)', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'complete', result: 'final answer', isError: false } as AgentEvent);
    await new Promise(r => setImmediate(r));
    expect(putThought).toHaveBeenCalledTimes(1);
    expect(putThought.mock.calls[0][2]).toMatchObject({ stage: 'summary', text: 'final answer' });
  });

  it('session_id/state_changed/status 事件被跳过', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'session_id', sessionId: 'xxx' } as AgentEvent);
    r.emit({ type: 'state_changed', state: 'idle' } as AgentEvent);
    r.emit({ type: 'status', subtype: 'reset', message: 'msg' } as AgentEvent);
    await new Promise(r => setImmediate(r));
    expect(putThought).not.toHaveBeenCalled();
  });

  it('adapter 无 putThought 时静默跳过', async () => {
    const adapter = createAdapter({ putThought: undefined });
    delete (adapter as any).putThought;
    const r = new IMRenderer({
      adapter,
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    // 不应抛
    r.emit({ type: 'text', text: 'x' } as AgentEvent);
    await new Promise(r => setImmediate(r));
  });

  it('putThought 失败不抛出（fire-and-forget）', async () => {
    const putThought = vi.fn().mockRejectedValue(new Error('thought fail'));
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'text', text: 'x' } as AgentEvent);
    // 不抛即通过
    await new Promise(r => setImmediate(r));
    expect(putThought).toHaveBeenCalled();
  });

  it('compact 事件投影为 thought(stage=system)', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'compact', preTokens: 5000 } as AgentEvent);
    await new Promise(r => setImmediate(r));
    const payload = putThought.mock.calls[0][2];
    expect(payload.stage).toBe('system');
    expect(payload.text).toContain('压缩完成');
    expect(payload.text).toContain('5000');
  });

  it('task_progress 事件投影为 thought(stage=planning)', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'task_progress', summary: 'doing X', toolUses: 3, durationMs: 12000 } as AgentEvent);
    await new Promise(r => setImmediate(r));
    const payload = putThought.mock.calls[0][2];
    expect(payload.stage).toBe('planning');
    expect(payload.text).toContain('doing X');
    expect(payload.text).toContain('3 tools');
    expect(payload.text).toContain('12s');
  });

  it('error 事件投影为 thought(stage=error)', async () => {
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    r.emit({ type: 'error', error: 'boom', errorType: 'network' } as AgentEvent);
    await new Promise(r => setImmediate(r));
    const payload = putThought.mock.calls[0][2];
    expect(payload.stage).toBe('error');
    expect(payload.text).toContain('boom');
  });
});

describe('IMRenderer — 通用', () => {
  it('emit() 在 proactive 模式触发 logger.event 旁路', async () => {
    // 间接验证：emit 不抛即可（logger.event 在 logger.ts 里有 EVENT_LOG 环境变量控制）
    const putThought = vi.fn().mockResolvedValue(undefined);
    const r = new IMRenderer({
      adapter: createAdapter({ putThought }),
      channelId: 'g1',
      taskId: 't1',
      chatmode: 'proactive',
      sendText: vi.fn(),
    });
    expect(() => r.emit({ type: 'text', text: 'x' } as AgentEvent)).not.toThrow();
  });

  it('stripFromBuffer 移除指定 pattern', () => {
    const r = new IMRenderer({
      adapter: createAdapter(),
      channelId: 'c1',
      taskId: 't1',
      chatmode: 'interactive',
      sendText: vi.fn(),
    });
    r.addText('keep [REMOVE:x] this');
    r.stripFromBuffer(/\[REMOVE:[^\]]+\]/g);
    expect(r.getRemainingText()).toBe('keep  this');
  });
});
