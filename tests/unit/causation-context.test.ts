import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAunCausationForTests,
  consumeAunCausation,
  createRootCausation,
  deriveCausation,
  enterTrigger,
  normalizeCausation,
  queryCausationTrace,
  recordCausationSpan,
  registerAunCausation,
  resetCausationAuditForTests,
} from '../../src/core/causation/index.js';
import { _resetRoot } from '../../src/paths.js';
import { MessageQueue } from '../../src/core/message/message-queue.js';

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-causation-'));
  process.env.EVOLCLAW_HOME = tempRoot;
  _resetRoot();
  clearAunCausationForTests();
  resetCausationAuditForTests();
});

afterEach(() => {
  vi.useRealTimers();
  clearAunCausationForTests();
  resetCausationAuditForTests();
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('causation context', () => {
  it('keeps the generic carrier fixed-size across long chains', () => {
    let context = createRootCausation();
    const initialKeys = Object.keys(context).sort();
    for (let index = 0; index < 10_000; index++) context = deriveCausation(context);

    expect(Object.keys(context).sort()).toEqual([...initialKeys, 'parentSpanId'].sort());
    expect(context.traceId).toMatch(/^trace_/);
    expect(context.parentSpanId).toMatch(/^span_/);
    expect(JSON.stringify(context).length).toBeLessThan(180);
  });

  it('blocks repeated triggers and caps the trigger path', () => {
    const root = createRootCausation();
    const first = enterTrigger(root, 'trigger-a', 'run-a');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(enterTrigger(first.causation, 'trigger-a', 'run-a2')).toMatchObject({
      ok: false,
      reason: 'causation_cycle',
    });

    let context = first.causation;
    for (let index = 1; index < 16; index++) {
      const entered = enterTrigger(context, `trigger-${index}`, `run-${index}`);
      expect(entered.ok).toBe(true);
      if (!entered.ok) return;
      context = entered.causation;
    }
    expect(enterTrigger(context, 'trigger-overflow', 'run-overflow')).toEqual({
      ok: false,
      reason: 'causation_depth_exceeded',
    });
  });

  it('rejects malformed and oversized carrier data', () => {
    expect(normalizeCausation({ version: 1, traceId: 'bad id', spanId: 'span_ok' })).toBeUndefined();
    expect(normalizeCausation({
      ...createRootCausation(),
      trigger: { path: Array.from({ length: 17 }, (_, index) => ({ triggerId: `t-${index}`, runId: `r-${index}` })) },
    })).toBeUndefined();
  });

  it('restores AUN causation only for the expected sender and recipient', () => {
    const context = createRootCausation();
    expect(registerAunCausation('message-1', 'a.agentid.pub', 'b.agentid.pub', context)).toBe(true);
    expect(consumeAunCausation('message-1', 'mallory.agentid.pub', 'b.agentid.pub')).toBeUndefined();
    expect(consumeAunCausation('message-1', 'a.agentid.pub', 'b.agentid.pub')).toEqual(context);
    expect(consumeAunCausation('message-1', 'a.agentid.pub', 'b.agentid.pub')).toBeUndefined();
  });

  it('prunes expired AUN associations while registering new sends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    expect(registerAunCausation('expired', 'a.agentid.pub', 'b.agentid.pub', createRootCausation(), 10)).toBe(true);

    vi.setSystemTime(2_000);
    expect(registerAunCausation('current', 'a.agentid.pub', 'b.agentid.pub', createRootCausation(), 10)).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(path.join(tempRoot, 'data', 'causation-aun.json'), 'utf8'));
    expect(persisted.map((item: { messageId: string }) => item.messageId)).toEqual(['current']);
  });

  it('rebuilds a trace from persisted parent pointers', () => {
    const root = createRootCausation();
    const child = deriveCausation(root);
    recordCausationSpan(root, 'message.inbound', { status: 'completed', refs: { messageId: 'm-1' } });
    recordCausationSpan(child, 'task.run', { status: 'completed', refs: { taskId: 'task-1' } });

    const trace = queryCausationTrace(root.traceId);
    expect(trace.spans.map(span => span.spanId)).toEqual([root.spanId, child.spanId]);
    expect(trace.spans[1].parentSpanId).toBe(root.spanId);
  });

  it('drops invalid causation while restoring persisted messages', async () => {
    const persistencePath = path.join(tempRoot, 'data', 'message-queue.json');
    fs.mkdirSync(path.dirname(persistencePath), { recursive: true });
    fs.writeFileSync(persistencePath, JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      queues: [{
        queueKey: 'session-1::/project',
        items: [{
          projectPath: '/project',
          message: {
            channel: 'aun',
            channelId: 'peer.agentid.pub',
            peerId: 'peer.agentid.pub',
            content: 'restored',
            messageId: 'message-restored',
            causation: { version: 1, traceId: 'invalid id', spanId: 'span_valid' },
          },
        }],
      }],
    }));

    const handled: Array<{ causation?: unknown }> = [];
    const queue = new MessageQueue(async message => { handled.push(message); }, { persistencePath });
    expect(queue.restorePersisted()).toBe(1);
    await vi.waitFor(() => expect(handled).toHaveLength(1));
    expect(handled[0].causation).toBeUndefined();
  });
});
