import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IMRenderer } from '../../src/core/message/im-renderer.js';
import type { ChannelAdapter, OutboundEnvelope, OutboundPayload } from '../../src/types.js';
import type { AgentEvent } from '../../src/agents/claude-runner.js';

function makeEnvelope(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    taskId: 't1',
    channel: 'test',
    channelId: 'c1',
    agentName: 'agent',
    chatmode: 'interactive',
    timestamp: Date.now(),
    ...over,
  };
}

function makeAdapter(): ChannelAdapter {
  return {
    channelName: 'test',
    sendText: vi.fn().mockResolvedValue(undefined),
  };
}

describe('IMRenderer — interactive mode (结构化聚合)', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('addText 聚合 thinking items；flush(true) 发送 result.text', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send });
    r.addText('hello ');
    r.addText('world');
    await r.flush(true);
    // isFinal 时仅发 result.text，thinking-only batch 被吞掉避免重复
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ kind: 'result.text', text: 'hello world', isFinal: true });
  });

  it('addToolCall + addToolResult 聚合到 activity.batch', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send });
    r.addToolCall('Read', { file_path: './README.md' }, 'call-1', 'Read: ./README.md');
    r.addToolResult('Read', true, 'content', undefined, 'call-1');
    await r.flush(false);
    expect(send).toHaveBeenCalledTimes(1);
    const [payload] = send.mock.calls[0];
    expect(payload.kind).toBe('activity.batch');
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({ kind: 'tool_call', call_id: 'call-1', name: 'Read' });
    expect(payload.items[1]).toMatchObject({ kind: 'tool_result', call_id: 'call-1', name: 'Read', ok: true });
  });

  it('flush(true) 同时发 batch（非 thinking）+ result.text', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send });
    r.addToolCall('Read', { file_path: 'a' }, 'c1', 'Read: a');
    r.addText('reply');
    await r.flush(true);
    expect(send).toHaveBeenCalledTimes(2);
    const [first] = send.mock.calls[0];
    const [second] = send.mock.calls[1];
    expect(first.kind).toBe('activity.batch');
    expect(first.items).toEqual([
      expect.objectContaining({ kind: 'tool_call', name: 'Read' }),
    ]);
    expect(second).toEqual({ kind: 'result.text', text: 'reply', isFinal: true });
  });

  it('suppressActivities=true 丢弃 tool/notice/progress', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send, suppressActivities: true });
    r.addToolCall('Read', {}, 'c1');
    r.addToolResult('Read', true, '', undefined, 'c1');
    r.addNotice('hint', 'info');
    r.addProgress('p');
    await r.flush(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('hasSentContent / hasContent / getFinalText 状态正确', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send });
    expect(r.hasSentContent()).toBe(false);
    expect(r.hasContent()).toBe(false);
    r.addText('hi');
    expect(r.hasContent()).toBe(true);
    expect(r.getFinalText()).toBe('hi');
    r.addToolCall('T', {}, 'c1');
    expect(r.hasContent()).toBe(true);
    await r.flush(true);
    expect(r.hasSentContent()).toBe(true);
  });

  it('文件标记 pattern 在 flush 时被过滤', async () => {
    const r = new IMRenderer({
      adapter: makeAdapter(),
      envelope: makeEnvelope(),
      send,
      fileMarkerPattern: /\[SEND_FILE:[^\]]+\]/g,
    });
    r.addText('hello [SEND_FILE:/tmp/a.md] world');
    await r.flush(true);
    const [payload] = send.mock.calls[0];
    expect(payload.kind).toBe('result.text');
    expect(payload.text).not.toContain('[SEND_FILE:');
  });

  it('flushActivitiesOnly 只清非 thinking items，保留 thinking', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send });
    r.addText('partial ');
    r.addToolCall('T', {}, 'c1');
    await r.flushActivitiesOnly();
    expect(send).toHaveBeenCalledTimes(1);
    const [payload] = send.mock.calls[0];
    expect(payload.kind).toBe('activity.batch');
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].kind).toBe('tool_call');
    // text buffer 还在
    expect(r.getRemainingText()).toContain('partial');
  });

  it('send 失败不抛出，继续后续发送', async () => {
    let callCount = 0;
    const failing = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve();
    });
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send: failing });
    r.addText('a');
    await r.flush(false);
    r.addText('b');
    await r.flush(true);
    expect(failing).toHaveBeenCalled();
    // 第二次发送应当成功
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('addText 多次合并到最后一个 thinking item', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send });
    r.addText('a');
    r.addText('b');
    r.addToolCall('T', {}, 'c1');
    r.addText('c');
    // 触发 flushActivitiesOnly 看 items 结构
    await r.flush(false);
    const items = send.mock.calls[0][0].items;
    // thinking('ab') + tool_call + thinking('c')
    expect(items[0]).toMatchObject({ kind: 'thinking', text: 'ab' });
    expect(items[1].kind).toBe('tool_call');
    expect(items[2]).toMatchObject({ kind: 'thinking', text: 'c' });
  });
});

describe('IMRenderer — proactive mode (逐事件 activity.batch)', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('text 事件投影为 batch[1] with kind=thinking', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'text', text: 'hello' } as AgentEvent);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    const [payload] = send.mock.calls[0];
    expect(payload.kind).toBe('activity.batch');
    expect(payload.items).toEqual([{ kind: 'thinking', text: 'hello' }]);
  });

  it('tool_use 事件投影为 batch[1] with kind=tool_call', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'tool_use', name: 'Read', input: { file_path: './a.md' }, callId: 'call-x' } as AgentEvent);
    await Promise.resolve();
    const [payload] = send.mock.calls[0];
    expect(payload.items[0]).toMatchObject({
      kind: 'tool_call',
      call_id: 'call-x',
      name: 'Read',
      arguments: { file_path: './a.md' },
    });
  });

  it('tool_result(ok) 投影为 batch[1] with kind=tool_result ok=true', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'tool_result', name: 'Read', result: 'content', isError: false, callId: 'call-x' } as AgentEvent);
    await Promise.resolve();
    const item = send.mock.calls[0][0].items[0];
    expect(item).toMatchObject({ kind: 'tool_result', call_id: 'call-x', name: 'Read', ok: true });
  });

  it('tool_result(error) 投影为 batch[1] with ok=false + error', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'tool_result', name: 'Read', result: '', isError: true, error: '权限被拒', callId: 'call-x' } as AgentEvent);
    await Promise.resolve();
    const item = send.mock.calls[0][0].items[0];
    expect(item).toMatchObject({ kind: 'tool_result', call_id: 'call-x', name: 'Read', ok: false, error: '权限被拒' });
  });

  it('text 已发后 complete.result 被去重跳过', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'text', text: 'final answer' } as AgentEvent);
    r.emit({ type: 'complete', result: 'final answer', isError: false } as AgentEvent);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('未发 text 时 complete.result 投影为 batch[1] with kind=summary', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'complete', result: 'summary text', isError: false, durationMs: 1234 } as AgentEvent);
    await Promise.resolve();
    const item = send.mock.calls[0][0].items[0];
    expect(item).toMatchObject({ kind: 'summary', text: 'summary text', duration_ms: 1234 });
  });

  it('complete(isError) 投影为 summary with is_error=true', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'complete', isError: true, errors: ['boom'] } as AgentEvent);
    await Promise.resolve();
    const item = send.mock.calls[0][0].items[0];
    expect(item).toMatchObject({ kind: 'summary', is_error: true, text: 'boom' });
  });

  it('compact 事件投影为 notice(subtype=compact)', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'compact', preTokens: 9999 } as AgentEvent);
    await Promise.resolve();
    const item = send.mock.calls[0][0].items[0];
    expect(item.kind).toBe('notice');
    expect(item.subtype).toBe('compact');
  });

  it('task_progress 事件投影为 progress', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'task_progress', summary: 'Step 1', toolUses: 3, durationMs: 5000 } as AgentEvent);
    await Promise.resolve();
    const item = send.mock.calls[0][0].items[0];
    expect(item).toMatchObject({ kind: 'progress', tool_uses: 3, duration_ms: 5000 });
  });

  it('error 事件投影为 notice(severity=warn)', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'error', error: 'connection lost', errorType: 'network' } as AgentEvent);
    await Promise.resolve();
    const item = send.mock.calls[0][0].items[0];
    expect(item).toMatchObject({ kind: 'notice', severity: 'warn', text: 'connection lost' });
  });

  it('session_id/state_changed/status 事件被跳过', async () => {
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.emit({ type: 'session_id', sessionId: 's1' } as AgentEvent);
    r.emit({ type: 'state_changed', state: 'idle' } as AgentEvent);
    r.emit({ type: 'status', subtype: 'reset', message: 'r' } as AgentEvent);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });

  it('send 失败不抛出（fire-and-forget）', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('rpc fail'));
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send: failing });
    expect(() => r.emit({ type: 'text', text: 'x' } as AgentEvent)).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(failing).toHaveBeenCalled();
  });
});

describe('IMRenderer — 通用', () => {
  it('proactive 模式 addText 是 noop', () => {
    const send = vi.fn();
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope({ chatmode: 'proactive' }), send });
    r.addText('x');
    expect(send).not.toHaveBeenCalled();
  });

  it('stripFromBuffer 移除 thinking item 中的指定 pattern', () => {
    const send = vi.fn();
    const r = new IMRenderer({ adapter: makeAdapter(), envelope: makeEnvelope(), send });
    r.addText('hello [SEND_FILE:a]world');
    r.stripFromBuffer(/\[SEND_FILE:[^\]]+\]/g);
    expect(r.getRemainingText()).not.toContain('[SEND_FILE:');
  });
});
