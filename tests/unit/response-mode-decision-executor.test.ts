import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DecisionExecutor, type ExecutorSinks } from '../../src/response-modes/decision-executor.js';
import type { InboundMessage, OutboundPayload, ResponseModeContext } from '../../src/response-modes/types.js';

function makeSinks(): ExecutorSinks & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = { enqueue: [], clearQueue: [], interrupt: [], switchModel: [], injectContext: [], send: [] };
  return {
    calls,
    enqueue: async (m, b) => { calls.enqueue.push([m, b]); },
    clearQueue: async () => { calls.clearQueue.push([]); },
    interrupt: async () => { calls.interrupt.push([]); },
    switchModel: async (m) => { calls.switchModel.push([m]); },
    injectContext: async (d) => { calls.injectContext.push([d]); },
    send: async (p, t) => { calls.send.push([p, t]); },
  };
}

const logger: ResponseModeContext['logger'] = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

const msg: InboundMessage = { peerId: 'p1', content: 'hi', chatType: 'private' };
const ctx = {} as ResponseModeContext;

describe('DecisionExecutor - inbound', () => {
  let sinks: ReturnType<typeof makeSinks>;
  let exec: DecisionExecutor;
  beforeEach(() => { sinks = makeSinks(); exec = new DecisionExecutor(sinks, logger); });

  it('process + enqueue', async () => {
    const got = await exec.executeInbound({ action: 'process', queueBehavior: 'enqueue' }, msg, ctx);
    expect(got).toBe(true);
    expect(sinks.calls.enqueue).toEqual([[msg, 'enqueue']]);
  });

  it('drop does not enqueue', async () => {
    const got = await exec.executeInbound({ action: 'drop', reason: 'x' }, msg, ctx);
    expect(got).toBe(false);
    expect(sinks.calls.enqueue).toEqual([]);
  });

  it('defer does not enqueue', async () => {
    const got = await exec.executeInbound({ action: 'defer' }, msg, ctx);
    expect(got).toBe(false);
    expect(sinks.calls.enqueue).toEqual([]);
  });

  it('clear-and-enqueue clears then enqueues', async () => {
    await exec.executeInbound({ action: 'process', queueBehavior: 'clear-and-enqueue' }, msg, ctx);
    expect(sinks.calls.clearQueue.length).toBe(1);
    expect(sinks.calls.enqueue).toEqual([[msg, 'enqueue']]);
  });

  it('executes instructions: switchModel + injectContext + interrupt', async () => {
    await exec.executeInbound({
      action: 'process',
      queueBehavior: 'enqueue',
      instructions: { switchModel: 'opus', injectContext: ['rules.md'], interruptCurrent: true },
    }, msg, ctx);
    expect(sinks.calls.switchModel).toEqual([['opus']]);
    expect(sinks.calls.injectContext).toEqual([[['rules.md']]]);
    expect(sinks.calls.interrupt.length).toBe(1);
  });

  it('customHandler bypasses standard enqueue', async () => {
    const handler = vi.fn(async () => {});
    const got = await exec.executeInbound({ action: 'process', customHandler: handler }, msg, ctx);
    expect(got).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
    expect(sinks.calls.enqueue).toEqual([]);
  });

  it('defaults queueBehavior to enqueue', async () => {
    await exec.executeInbound({ action: 'process' }, msg, ctx);
    expect(sinks.calls.enqueue).toEqual([[msg, 'enqueue']]);
  });
});

describe('DecisionExecutor - outbound', () => {
  let sinks: ReturnType<typeof makeSinks>;
  let exec: DecisionExecutor;
  const payload: OutboundPayload = { kind: 'text', content: 'hi' };
  beforeEach(() => { sinks = makeSinks(); exec = new DecisionExecutor(sinks, logger); });

  it('direct sends as message by default', async () => {
    const got = await exec.executeOutbound({ method: 'direct' }, payload, ctx);
    expect(got).toBe(true);
    expect(sinks.calls.send).toEqual([[payload, 'message']]);
  });

  it('direct with type=thought', async () => {
    await exec.executeOutbound({ method: 'direct', type: 'thought' }, payload, ctx);
    expect(sinks.calls.send).toEqual([[payload, 'thought']]);
  });

  it('suppress does not send', async () => {
    const got = await exec.executeOutbound({ method: 'suppress' }, payload, ctx);
    expect(got).toBe(false);
    expect(sinks.calls.send).toEqual([]);
  });

  it('defer/batch held by mode', async () => {
    expect(await exec.executeOutbound({ method: 'defer' }, payload, ctx)).toBe(false);
    expect(await exec.executeOutbound({ method: 'batch' }, payload, ctx)).toBe(false);
    expect(sinks.calls.send).toEqual([]);
  });

  it('customSender bypasses standard send', async () => {
    const sender = vi.fn(async () => {});
    const got = await exec.executeOutbound({ method: 'suppress', customSender: sender }, payload, ctx);
    expect(got).toBe(true);
    expect(sender).toHaveBeenCalledOnce();
  });
});
