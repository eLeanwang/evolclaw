import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TriggerScheduler, calcNextFireAt } from '../../src/core/trigger/scheduler.js';
import { TriggerManager } from '../../src/core/trigger/manager.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Trigger } from '../../src/types.js';

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  const now = Date.now();
  return {
    id: 'sched-id-1',
    name: 'sched-trigger',
    scheduleType: 'delay',
    scheduleValue: String(100),
    nextFireAt: now + 100,
    targetChannel: 'feishu-main',
    targetChannelId: 'oc_xxx',
    targetSessionStrategy: 'latest',
    prompt: 'test',
    createdByPeerId: 'user-1',
    createdByChannel: 'feishu-main',
    fireCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('calcNextFireAt', () => {
  it('delay adds ms to now', () => {
    const now = 1000000;
    expect(calcNextFireAt('delay', '5000', now)).toBe(1005000);
  });

  it('at parses ISO string', () => {
    const iso = '2030-01-01T00:00:00.000Z';
    expect(calcNextFireAt('at', iso)).toBe(new Date(iso).getTime());
  });

  it('cron returns next occurrence after now', () => {
    const now = Date.now();
    const next = calcNextFireAt('cron', '* * * * *', now);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(2 * 60 * 1000);
  });
});

describe('TriggerScheduler', () => {
  let tmpDir: string;
  let manager: TriggerManager;
  let scheduler: TriggerScheduler;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
    manager = new TriggerManager('test-aid', tmpDir);
    eventBus = new EventBus();
    scheduler = new TriggerScheduler('test-aid', manager, eventBus);
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires delay trigger after delay', async () => {
    const fired: string[] = [];
    scheduler.setFireCallback((msg, trigger) => {
      fired.push(trigger.id);
    });

    const t = makeTrigger({ nextFireAt: Date.now() + 50 });
    manager.register(t);
    scheduler.register(t);

    await new Promise(r => setTimeout(r, 200));
    expect(fired).toContain('sched-id-1');
  });

  it('moves delay trigger to done after fire', async () => {
    scheduler.setFireCallback(() => {});
    const t = makeTrigger({ nextFireAt: Date.now() + 50 });
    manager.register(t);
    scheduler.register(t);

    await new Promise(r => setTimeout(r, 200));
    expect(manager.listActive()).toHaveLength(0);
    const { history } = manager.listAll();
    expect(history[0]?.doneReason).toBe('fired');
  });

  it('cancel removes trigger from heap', async () => {
    const fired: string[] = [];
    scheduler.setFireCallback((msg, trigger) => fired.push(trigger.id));

    const t = makeTrigger({ nextFireAt: Date.now() + 200 });
    manager.register(t);
    scheduler.register(t);
    scheduler.cancel(t.id);

    await new Promise(r => setTimeout(r, 300));
    expect(fired).toHaveLength(0);
  });

  it('init backfills missed delay trigger', async () => {
    const fired: string[] = [];
    const t = makeTrigger({ nextFireAt: Date.now() - 1000 });
    manager.register(t);

    scheduler.setFireCallback((msg, trigger) => fired.push(trigger.id));
    await scheduler.init();

    await new Promise(r => setTimeout(r, 100));
    expect(fired).toContain('sched-id-1');
  });

  it('init does not backfill missed cron', async () => {
    const fired: string[] = [];
    const t = makeTrigger({
      scheduleType: 'cron',
      scheduleValue: '* * * * *',
      nextFireAt: Date.now() - 60000,
    });
    manager.register(t);

    scheduler.setFireCallback((msg, trigger) => fired.push(trigger.id));
    await scheduler.init();

    await new Promise(r => setTimeout(r, 100));
    expect(fired).toHaveLength(0);
  });

  it('publishes trigger:fired event', async () => {
    const events: string[] = [];
    eventBus.subscribe('trigger:fired', (ev: any) => events.push(ev.triggerId));

    scheduler.setFireCallback(() => {});
    const t = makeTrigger({ nextFireAt: Date.now() + 50 });
    manager.register(t);
    scheduler.register(t);

    await new Promise(r => setTimeout(r, 200));
    expect(events).toContain('sched-id-1');
  });

  it('fire_count updated before moveToDone so history has correct count', async () => {
    scheduler.setFireCallback(() => {});
    const t = makeTrigger({ nextFireAt: Date.now() + 50 });
    manager.register(t);
    scheduler.register(t);

    await new Promise(r => setTimeout(r, 200));
    const { history } = manager.listAll();
    expect(history[0]?.fireCount).toBe(1);
    expect(history[0]?.lastFiredAt).toBeGreaterThan(0);
  });
});
