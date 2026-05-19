import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { IMRenderer } from '../../src/core/message/im-renderer.js';
import type { OutboundEnvelope, OutboundPayload } from '../../src/types.js';

function makeEnvelope(chatmode: 'interactive' | 'proactive' = 'interactive'): OutboundEnvelope {
  return {
    taskId: 'task-test',
    channel: 'aun',
    channelId: 'peer.agentid.pub',
    agentName: 'bot',
    chatmode,
    timestamp: Date.now(),
  };
}

function makeAdapter() {
  return {
    channelName: 'aun',
    capabilities: { file: false, image: false, interaction: false, markdown: false, thought: false, status: false },
    send: vi.fn().mockResolvedValue(undefined),
  };
}

// ── addNotice: suppressActivities + force ─────────────────────────────────────

describe('IMRenderer.addNotice — suppressActivities + force', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeRenderer(suppressActivities: boolean) {
    const sent: OutboundPayload[] = [];
    const adapter = makeAdapter();
    const renderer = new IMRenderer({
      adapter: adapter as any,
      envelope: makeEnvelope(),
      flushDelay: 0,
      suppressActivities,
      send: async (payload) => { sent.push(payload); },
    });
    return { renderer, sent };
  }

  it('suppresses notice when suppressActivities=true and force omitted', async () => {
    const { renderer, sent } = makeRenderer(true);

    renderer.addNotice('tool activity', 'info', 'tool');
    vi.runAllTimers();
    await Promise.resolve();

    const batches = sent.filter(p => p.kind === 'activity.batch');
    expect(batches).toHaveLength(0);
  });

  it('passes through notice when suppressActivities=true but force=true', async () => {
    const { renderer, sent } = makeRenderer(true);

    renderer.addNotice('compact 完成', 'info', 'compact-retry', true);
    vi.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();

    const batches = sent.filter(p => p.kind === 'activity.batch') as any[];
    expect(batches.length).toBeGreaterThan(0);
    const items = batches.flatMap((b: any) => b.items);
    const notice = items.find((i: any) => i.kind === 'notice' && i.subtype === 'compact-retry');
    expect(notice).toBeDefined();
    expect(notice.text).toBe('compact 完成');
  });

  it('passes through error notice (force=true) even when suppressed', async () => {
    const { renderer, sent } = makeRenderer(true);

    renderer.addNotice('任务失败', 'warn', 'task-error', true);
    vi.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();

    const batches = sent.filter(p => p.kind === 'activity.batch') as any[];
    const items = batches.flatMap((b: any) => b.items);
    expect(items.some((i: any) => i.kind === 'notice' && i.severity === 'warn')).toBe(true);
  });

  it('normal notice (no force) passes through when suppressActivities=false', async () => {
    const { renderer, sent } = makeRenderer(false);

    renderer.addNotice('tool info', 'info', 'tool');
    vi.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();

    const batches = sent.filter(p => p.kind === 'activity.batch') as any[];
    expect(batches.length).toBeGreaterThan(0);
  });

  it('retry notice (force=true) is suppressed in proactive mode regardless', async () => {
    const sent: OutboundPayload[] = [];
    const adapter = makeAdapter();
    const renderer = new IMRenderer({
      adapter: adapter as any,
      envelope: makeEnvelope('proactive'),
      flushDelay: 0,
      suppressActivities: false,
      send: async (payload) => { sent.push(payload); },
    });

    renderer.addNotice('retry', 'warn', 'retry', true);
    vi.runAllTimers();
    await Promise.resolve();

    // proactive mode: addNotice returns early before suppressActivities check
    const batches = sent.filter(p => p.kind === 'activity.batch');
    expect(batches).toHaveLength(0);
  });
});
