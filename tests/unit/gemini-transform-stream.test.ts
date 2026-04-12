import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { GeminiRunner } from '../../src/agents/gemini-runner.js';
import type { Config } from '../../src/types.js';

function makeConfig(): Config {
  return {
    agents: {
      google: {
        cliPath: '/usr/bin/gemini',
        model: 'gemini-2.5-flash',
      },
    },
    channels: {
      feishu: { appId: 'test', appSecret: 'test' },
      aun: { aid: 'test.agent' },
    },
    projects: {
      defaultPath: '/tmp',
      autoCreate: false,
    },
  };
}

/**
 * Create a mock ChildProcess with a writable stdout PassThrough.
 * Write JSONL lines to `stdout`, then call `finish()` to close the stream
 * and emit the exit event.
 */
function createMockChild() {
  const stdout = new PassThrough();
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null; // mirrors real ChildProcess (null = still running)
  child.kill = vi.fn(() => { child.killed = true; });
  child.pid = 12345;

  return {
    child,
    writeLine(obj: any) {
      stdout.write(JSON.stringify(obj) + '\n');
    },
    finish(code = 0) {
      stdout.end();
      // Emit exit after stream ends so readline processes all lines first
      setImmediate(() => {
        child.exitCode = code; // real ChildProcess sets this on exit
        child.emit('exit', code);
      });
    },
  };
}

async function collectEvents(stream: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('GeminiRunner.transformStream', () => {
  let runner: GeminiRunner;
  let onSessionIdUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSessionIdUpdate = vi.fn();
    runner = new GeminiRunner(makeConfig(), {
      onSessionIdUpdate,
    });
  });

  it('parses init event and emits session_id', async () => {
    const { child, writeLine, finish } = createMockChild();

    writeLine({ type: 'init', session_id: 'session-abc-123' });
    writeLine({ type: 'result', status: 'success', stats: { duration_ms: 100 } });
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    expect(events[0]).toEqual({ type: 'session_id', sessionId: 'session-abc-123' });
    expect(onSessionIdUpdate).toHaveBeenCalledWith('test-session', 'session-abc-123');
  });

  it('accumulates message events and flushes text on result', async () => {
    const { child, writeLine, finish } = createMockChild();

    writeLine({ type: 'message', role: 'assistant', content: 'Hello ' });
    writeLine({ type: 'message', role: 'assistant', content: 'world!' });
    writeLine({ type: 'result', status: 'success', stats: { duration_ms: 200 } });
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    // text event flushed before complete
    const textEvent = events.find((e: any) => e.type === 'text');
    expect(textEvent).toEqual({ type: 'text', text: 'Hello world!' });

    const completeEvent = events.find((e: any) => e.type === 'complete');
    expect(completeEvent?.isError).toBe(false);
    expect(completeEvent?.result).toBe('Hello world!');
  });

  it('skips user message echo', async () => {
    const { child, writeLine, finish } = createMockChild();

    writeLine({ type: 'message', role: 'user', content: 'my prompt' });
    writeLine({ type: 'message', role: 'assistant', content: 'reply' });
    writeLine({ type: 'result', status: 'success' });
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    const textEvents = events.filter((e: any) => e.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].text).toBe('reply');
  });

  it('flushes text buffer before tool_use', async () => {
    const { child, writeLine, finish } = createMockChild();

    writeLine({ type: 'message', role: 'assistant', content: 'I will edit the file.' });
    writeLine({ type: 'tool_use', tool_name: 'edit_file', tool_id: 't1', parameters: { path: '/src/main.ts' } });
    writeLine({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'file updated' });
    writeLine({ type: 'result', status: 'success' });
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    // Text should be flushed before tool_use
    const types = events.map((e: any) => e.type);
    const textIdx = types.indexOf('text');
    const toolUseIdx = types.indexOf('tool_use');
    expect(textIdx).toBeLessThan(toolUseIdx);

    // tool_use details
    expect(events[toolUseIdx]).toEqual({
      type: 'tool_use',
      name: 'edit_file',
      input: { path: '/src/main.ts' },
    });

    // tool_result
    const toolResult = events.find((e: any) => e.type === 'tool_result');
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      name: 'edit_file',
      result: 'file updated',
      isError: false,
    });
  });

  it('handles error events (non-fatal)', async () => {
    const { child, writeLine, finish } = createMockChild();

    writeLine({ type: 'error', message: 'Rate limit exceeded' });
    writeLine({ type: 'message', role: 'assistant', content: 'Retrying...' });
    writeLine({ type: 'result', status: 'success' });
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    const errorEvent = events.find((e: any) => e.type === 'error');
    expect(errorEvent).toEqual({
      type: 'error',
      error: 'Rate limit exceeded',
      errorType: 'unknown',
    });
    // Should still continue and complete
    expect(events.some((e: any) => e.type === 'complete' && !e.isError)).toBe(true);
  });

  it('handles fatal error events with immediate complete', async () => {
    const { child, writeLine, finish } = createMockChild();

    writeLine({ type: 'error', message: 'Authentication failed', fatal: true });
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    expect(events[0]).toMatchObject({ type: 'error', error: 'Authentication failed' });
    expect(events[1]).toMatchObject({ type: 'complete', isError: true });
  });

  it('handles process exit without result event', async () => {
    const { child, writeLine, finish } = createMockChild();

    writeLine({ type: 'message', role: 'assistant', content: 'partial' });
    finish(1);

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    // Text should be flushed
    expect(events.some((e: any) => e.type === 'text' && e.text === 'partial')).toBe(true);
    // Error + complete for non-zero exit
    expect(events.some((e: any) => e.type === 'error' && e.error.includes('exited with code 1'))).toBe(true);
    expect(events.some((e: any) => e.type === 'complete' && e.isError === true)).toBe(true);
  });

  it('handles result with error status', async () => {
    const { child, writeLine, finish } = createMockChild();

    writeLine({
      type: 'result',
      status: 'error',
      error: { message: 'Context too long' },
      stats: { duration_ms: 500 },
    });
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    const complete = events.find((e: any) => e.type === 'complete');
    expect(complete?.isError).toBe(true);
    expect(complete?.errors).toContain('Context too long');
    expect(complete?.durationMs).toBe(500);
  });

  it('skips non-JSON lines gracefully', async () => {
    const { child, finish } = createMockChild();

    // Write raw text directly (not JSON)
    child.stdout.write('This is not JSON\n');
    child.stdout.write('{"type":"result","status":"success"}\n');
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    // Should have complete event, non-JSON line ignored
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');
  });

  it('processes all buffered lines before signaling done (readline close ordering)', async () => {
    const { child, writeLine, finish } = createMockChild();

    // Write multiple lines rapidly then close — tests that rl 'close'
    // fires after all 'line' events are emitted
    writeLine({ type: 'init', session_id: 'sess-1' });
    writeLine({ type: 'message', role: 'assistant', content: 'chunk1 ' });
    writeLine({ type: 'message', role: 'assistant', content: 'chunk2' });
    writeLine({ type: 'result', status: 'success', stats: { duration_ms: 50 } });
    finish();

    const stream = (runner as any).transformStream(child, 'test-session');
    const events = await collectEvents(stream);

    // All events should be present — nothing lost to race condition
    expect(events.find((e: any) => e.type === 'session_id')).toBeDefined();
    expect(events.find((e: any) => e.type === 'text')?.text).toBe('chunk1 chunk2');
    expect(events.find((e: any) => e.type === 'complete')?.isError).toBe(false);
  });
});
