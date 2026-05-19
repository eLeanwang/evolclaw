/**
 * 集成测试：触发器功能端到端链路
 *
 * 测试范围：TriggerManager + TriggerScheduler + CommandHandler.handleTrigger 联动
 * 不启动完整进程，不连接真实 channel，但测试多模块协作的真实行为。
 *
 * 用例分组：
 *   1. 注册与触发（delay / at / cron）
 *   2. 合成消息结构验证
 *   3. 列表与显示
 *   4. 取消权限边界
 *   5. 持久化与恢复
 *   6. 参数校验
 *   7. 并发与调度行为
 *   8. EventBus 事件
 *   9. 边界与防御
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { TriggerManager } from '../../src/core/trigger/manager.js';
import { TriggerScheduler, calcNextFireAt } from '../../src/core/trigger/scheduler.js';
import { EventBus } from '../../src/core/event-bus.js';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { MessageQueue } from '../../src/core/message/message-queue.js';
import { MessageCache } from '../../src/core/message/message-cache.js';
import { CommandHandler } from '../../src/core/command-handler.js';
import type { Message, Trigger } from '../../src/types.js';

// Short delay for fast-firing triggers in tests (ms)
const FIRE_DELAY_MS = 200;
const FIRE_WAIT_MS = 500;  // wait longer than FIRE_DELAY_MS to ensure firing

/** Build a trigger that fires in FIRE_DELAY_MS ms */
function makeFastTrigger(overrides: Partial<Trigger> = {}): Trigger {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: `fast-${Date.now()}`,
    scheduleType: 'delay',
    scheduleValue: String(FIRE_DELAY_MS),
    nextFireAt: now + FIRE_DELAY_MS,
    targetChannel: 'feishu-main',
    targetChannelId: 'oc_test',
    targetSessionStrategy: 'latest',
    prompt: 'fast trigger',
    createdByPeerId: 'owner-user',
    createdByChannel: 'feishu-main',
    fireCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeFakeRunner(): any {
  return {
    name: 'claude',
    runQuery: vi.fn(),
    interrupt: vi.fn(),
    hasActiveStream: vi.fn().mockReturnValue(false),
    clearSession: vi.fn(),
  };
}

/** Extract text from OutboundPayload | string | null | undefined */
function getText(result: any): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && 'text' in result) return result.text ?? '';
  return String(result);
}

async function setupEnv(tmpDir: string) {
  const triggersDir = path.join(tmpDir, 'triggers', 'test.agentid.pub');
  const sessionsDir = path.join(tmpDir, 'sessions');
  const projectPath = path.join(tmpDir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });

  const eventBus = new EventBus();
  const sessionManager = new SessionManager(
    sessionsDir,
    eventBus,
    (_ch, uid) => uid === 'owner-user',   // ownerResolver
    (_ch, uid) => uid === 'admin-user',   // adminResolver
  );
  const messageCache = new MessageCache();
  const runner = makeFakeRunner();
  const cmdHandler = new CommandHandler(sessionManager, runner, messageCache, eventBus);

  const triggerManager = new TriggerManager('test.agentid.pub', triggersDir);
  const triggerScheduler = new TriggerScheduler('test.agentid.pub', triggerManager, eventBus);
  cmdHandler.setTriggerScheduler(triggerScheduler, triggerManager);

  // Create a real session so CommandHandler can resolve identity
  const session = await sessionManager.getOrCreateSession('feishu-main', 'oc_test', projectPath);

  const enqueuedMessages: Message[] = [];
  const messageQueue = new MessageQueue(async (msg) => { enqueuedMessages.push(msg); });
  messageQueue.setEventBus(eventBus);
  cmdHandler.setMessageQueue(messageQueue);

  // Wire fire callback
  triggerScheduler.setFireCallback((msg) => {
    const sessionKey = `${msg.channel}:${msg.channelId}`;
    messageQueue.enqueue(sessionKey, msg, projectPath, { interruptible: false });
  });

  return {
    eventBus,
    sessionManager,
    cmdHandler,
    triggerManager,
    triggerScheduler,
    messageQueue,
    enqueuedMessages,
    session,
    projectPath,
    triggersDir,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('trigger integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-it-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── /trigger set → fire → enqueue ──────────────────────────────────────────

  it('registers a delay trigger and fires it into MessageQueue', async () => {
    const { triggerManager, triggerScheduler, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({ prompt: 'hello from trigger' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    expect(enqueuedMessages).toHaveLength(1);
    const msg = enqueuedMessages[0];
    expect(msg.source).toBe('trigger');
    expect(msg.content).toBe('hello from trigger');
    expect(msg.peerId).toMatch(/^__trigger__:/);
    expect(msg.triggerMeta?.silent).toBe(false);

    triggerScheduler.stop();
  });

  it('/trigger set command registers trigger and returns success', async () => {
    const { cmdHandler, triggerScheduler, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1s --prompt "hello from trigger"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('✅');
    expect(getText(result)).toContain('已注册');
    expect(triggerManager.listActive()).toHaveLength(1);

    triggerScheduler.stop();
  });

  it('registers a silent trigger with --session silent', async () => {
    const { triggerManager, triggerScheduler, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({ targetSessionStrategy: 'silent', prompt: 'background task' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    expect(enqueuedMessages).toHaveLength(1);
    expect(enqueuedMessages[0].triggerMeta?.silent).toBe(true);

    triggerScheduler.stop();
  });

  // ── /trigger list / bare /trigger ──────────────────────────────────────────

  it('/trigger shows active triggers', async () => {
    const { cmdHandler, triggerScheduler, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    await cmdHandler.handle(
      '/trigger set --delay 1h --name my-task --prompt "check CI"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    const result = await cmdHandler.handle('/trigger', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(getText(result)).toContain('my-task');
    expect(getText(result)).toContain('delay');

    triggerScheduler.stop();
  });

  it('/trigger list shows all triggers including history', async () => {
    const { cmdHandler, triggerScheduler, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const firedTask = makeFastTrigger({ name: 'fired-task', prompt: 'done' });
    triggerManager.register(firedTask);
    triggerScheduler.register(firedTask);
    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    const result = await cmdHandler.handle('/trigger list', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(getText(result)).toContain('fired-task');
    expect(getText(result)).toContain('fired');  // doneReason in history

    triggerScheduler.stop();
  });

  it('/trigger shows empty message when no active triggers', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle('/trigger', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(getText(result)).toContain('没有活跃');

    triggerScheduler.stop();
  });

  // ── /trigger cancel ────────────────────────────────────────────────────────

  it('owner can cancel own trigger', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    await cmdHandler.handle(
      '/trigger set --delay 1h --name cancel-me --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    const result = await cmdHandler.handle(
      '/trigger cancel cancel-me',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('✅');
    expect(getText(result)).toContain('cancel-me');

    // Verify removed from active
    const listResult = await cmdHandler.handle('/trigger', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(getText(listResult)).toContain('没有活跃');

    triggerScheduler.stop();
  });

  it('guest cannot cancel another user trigger', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // owner registers trigger
    await cmdHandler.handle(
      '/trigger set --delay 1h --name owner-task --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    // guest tries to cancel
    const result = await cmdHandler.handle(
      '/trigger cancel owner-task',
      'feishu-main', 'oc_test', undefined, 'guest-user',
    );
    expect(getText(result)).toContain('❌');

    // Trigger still active
    const listResult = await cmdHandler.handle('/trigger', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(getText(listResult)).toContain('owner-task');

    triggerScheduler.stop();
  });

  it('admin can cancel any trigger', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // owner registers trigger
    await cmdHandler.handle(
      '/trigger set --delay 1h --name owner-task --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    // admin cancels it
    const result = await cmdHandler.handle(
      '/trigger cancel owner-task',
      'feishu-main', 'oc_test', undefined, 'admin-user',
    );
    expect(getText(result)).toContain('✅');

    triggerScheduler.stop();
  });

  // ── Persistence & recovery ─────────────────────────────────────────────────

  it('persists triggers to disk and recovers after restart', async () => {
    const { cmdHandler, triggerManager, triggerScheduler, triggersDir, enqueuedMessages, projectPath } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // Register a trigger that fires in 100ms
    const _t_persist_test = makeFastTrigger({ name: 'persist-test', prompt: 'recovered' });
    triggerManager.register(_t_persist_test);
    triggerScheduler.register(_t_persist_test);

    // Verify written to disk
    const triggersFile = path.join(triggersDir, 'triggers.json');
    expect(fs.existsSync(triggersFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(triggersFile, 'utf8'));
    const triggers = Object.values(data.triggers) as any[];
    expect(triggers.some((t: any) => t.name === 'persist-test')).toBe(true);

    // Stop scheduler (simulate restart)
    triggerScheduler.stop();

    // Rebuild from disk
    const eventBus2 = new EventBus();
    const manager2 = new TriggerManager('test.agentid.pub', triggersDir);
    const scheduler2 = new TriggerScheduler('test.agentid.pub', manager2, eventBus2);
    const fired2: Message[] = [];
    scheduler2.setFireCallback((msg) => fired2.push(msg));
    await scheduler2.init();

    // Wait for backfill fire (trigger was already past due)
    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));
    expect(fired2.some(m => m.content === 'recovered')).toBe(true);

    scheduler2.stop();
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  it('rejects /trigger set with missing --prompt', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1h',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('prompt');

    triggerScheduler.stop();
  });

  it('rejects /trigger set with conflicting time params', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1h --cron "0 9 * * *" --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('互斥');

    triggerScheduler.stop();
  });

  it('rejects duplicate trigger name', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    await cmdHandler.handle(
      '/trigger set --delay 1h --name dup --prompt "first"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    const result = await cmdHandler.handle(
      '/trigger set --delay 2h --name dup --prompt "second"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');

    triggerScheduler.stop();
  });

  // ── EventBus events ────────────────────────────────────────────────────────

  it('publishes trigger:registered and trigger:fired events', async () => {
    const { cmdHandler, triggerManager, triggerScheduler, eventBus } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const registered: any[] = [];
    const fired: any[] = [];
    eventBus.subscribe('trigger:registered', (ev) => registered.push(ev));
    eventBus.subscribe('trigger:fired', (ev) => fired.push(ev));

    const _t_event = makeFastTrigger({ prompt: 'event test' });
    triggerManager.register(_t_event);
    triggerScheduler.register(_t_event);
    expect(registered).toHaveLength(1);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));
    expect(fired).toHaveLength(1);
    expect(fired[0].triggerId).toBe(registered[0].triggerId);

    triggerScheduler.stop();
  });

  it('publishes trigger:cancelled event on cancel', async () => {
    const { cmdHandler, triggerScheduler, eventBus } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const cancelled: any[] = [];
    eventBus.subscribe('trigger:cancelled', (ev) => cancelled.push(ev));

    await cmdHandler.handle(
      '/trigger set --delay 1h --name cancel-event --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    await cmdHandler.handle(
      '/trigger cancel cancel-event',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].by).toBe('owner-user');

    triggerScheduler.stop();
  });

  // ── 1b. --at 绝对时间触发 ──────────────────────────────────────────────────

  it('--at trigger fires at the specified absolute time', async () => {
    const { triggerManager, triggerScheduler, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({
      scheduleType: 'at',
      scheduleValue: new Date(Date.now() + FIRE_DELAY_MS).toISOString(),
      prompt: 'at-trigger fired',
    });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));
    expect(enqueuedMessages).toHaveLength(1);
    expect(enqueuedMessages[0].content).toBe('at-trigger fired');

    triggerScheduler.stop();
  });

  it('--at trigger is one-shot: moves to history after firing', async () => {
    const { triggerManager, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({
      name: 'at-oneshot',
      scheduleType: 'at',
      scheduleValue: new Date(Date.now() + FIRE_DELAY_MS).toISOString(),
      prompt: 'once',
    });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    expect(triggerManager.listActive()).toHaveLength(0);
    const { history } = triggerManager.listAll();
    expect(history.some((h: any) => h.name === 'at-oneshot' && h.doneReason === 'fired')).toBe(true);

    triggerScheduler.stop();
  });

  // ── 1c. cron 触发器 ────────────────────────────────────────────────────────

  it('cron trigger fires multiple times and stays active', async () => {
    const { triggerManager, triggerScheduler, eventBus, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const now = Date.now();
    const cronTrigger = {
      id: 'cron-multi-id',
      name: 'cron-multi',
      scheduleType: 'cron' as const,
      scheduleValue: '* * * * * *',  // every second (6-field)
      nextFireAt: now + 200,
      targetChannel: 'feishu-main',
      targetChannelId: 'oc_test',
      targetSessionStrategy: 'latest' as const,
      prompt: 'cron tick',
      createdByPeerId: 'owner-user',
      createdByChannel: 'feishu-main',
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    triggerManager.register(cronTrigger);
    triggerScheduler.register(cronTrigger);

    // In tests there's no MessageProcessor to emit trigger:completed,
    // so manually clear inflight state when trigger fires
    eventBus.subscribe('trigger:fired', (ev: any) => {
      triggerScheduler.onTriggerComplete(ev.triggerId, 'completed');
    });

    // Wait 2.5 seconds — should fire at ~200ms, ~1200ms, ~2200ms
    await new Promise(r => setTimeout(r, 2500));

    const cronMessages = enqueuedMessages.filter(m => m.content === 'cron tick');
    expect(cronMessages.length).toBeGreaterThanOrEqual(2);

    triggerScheduler.stop();
  });

  it('cron trigger remains active after firing', async () => {
    const { cmdHandler, triggerScheduler, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    await cmdHandler.handle(
      '/trigger set --cron "* * * * * *" --name cron-active --prompt "tick"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    // Cron trigger should still be in active list
    const active = triggerManager.listActive();
    expect(active.some(t => t.name === 'cron-active')).toBe(true);

    triggerScheduler.stop();
  });

  it('cron trigger skips when previous run still inflight', async () => {
    const { triggerManager, triggerScheduler, eventBus } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const skipped: any[] = [];
    eventBus.subscribe('trigger:skipped', (ev) => skipped.push(ev));

    // Register a cron trigger
    const now = Date.now();
    const trigger = {
      id: 'cron-overlap-id',
      name: 'cron-overlap',
      scheduleType: 'cron' as const,
      scheduleValue: '* * * * * *',
      nextFireAt: now + 500,
      targetChannel: 'feishu-main',
      targetChannelId: 'oc_test',
      targetSessionStrategy: 'latest' as const,
      prompt: 'overlap test',
      createdByPeerId: 'owner-user',
      createdByChannel: 'feishu-main',
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    triggerManager.register(trigger);
    triggerScheduler.register(trigger);

    // Simulate inflight: mark as running before it fires again
    await new Promise(r => setTimeout(r, 600));
    // Manually mark as inflight to simulate overlap
    (triggerScheduler as any).inflightCron.add('cron-overlap-id');

    // Wait for next tick
    await new Promise(r => setTimeout(r, 1200));

    expect(skipped.some((ev: any) => ev.reason === 'overlap')).toBe(true);

    triggerScheduler.stop();
  });

  // ── 2. 合成消息结构验证 ────────────────────────────────────────────────────

  it('synthetic message has correct structure', async () => {
    const { cmdHandler, triggerManager, triggerScheduler, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const _t_msg_struct = makeFastTrigger({ name: 'msg-struct', prompt: 'structure check' });
    triggerManager.register(_t_msg_struct);
    triggerScheduler.register(_t_msg_struct);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));
    expect(enqueuedMessages).toHaveLength(1);

    const msg = enqueuedMessages[0];
    expect(msg.source).toBe('trigger');
    expect(msg.peerId).toMatch(/^__trigger__:/);
    expect(msg.channel).toBe('feishu-main');
    expect(msg.channelId).toBe('oc_test');
    expect(msg.selfId).toBe('test.agentid.pub');
    expect(msg.messageId).toMatch(/^trigger:[a-z0-9-]+:\d+$/);
    expect(msg.triggerMeta).toBeDefined();
    expect(msg.triggerMeta!.triggerId).toBeTruthy();
    expect(typeof msg.triggerMeta!.silent).toBe('boolean');

    triggerScheduler.stop();
  });

  it('fire_count and last_fired_at are updated after firing', async () => {
    const { triggerManager, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({ name: 'count-test', prompt: 'count' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    const updated = triggerManager.getByName('count-test');
    // delay trigger moves to history after firing, check history
    const { history } = triggerManager.listAll();
    const h = history.find((e: any) => e.name === 'count-test');
    expect(h).toBeDefined();
    expect((h as any).fireCount).toBeGreaterThanOrEqual(1);
    expect((h as any).lastFiredAt).toBeGreaterThan(0);

    triggerScheduler.stop();
  });

  // ── 3b. /trigger list 显示 ─────────────────────────────────────────────────

  it('/trigger list shows both active and history sections', async () => {
    const { cmdHandler, triggerManager, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // One active trigger
    await cmdHandler.handle(
      '/trigger set --delay 1h --name active-one --prompt "active"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    // One that fires immediately
    const _t_fired_one = makeFastTrigger({ name: 'fired-one', prompt: 'fired' });
    triggerManager.register(_t_fired_one);
    triggerScheduler.register(_t_fired_one);
    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    const result = await cmdHandler.handle('/trigger list', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(getText(result)).toContain('活跃');
    expect(getText(result)).toContain('历史');
    expect(getText(result)).toContain('active-one');
    expect(getText(result)).toContain('fired-one');

    triggerScheduler.stop();
  });

  it('/trigger shows count of active triggers', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    await cmdHandler.handle('/trigger set --delay 1h --name t1 --prompt "a"', 'feishu-main', 'oc_test', undefined, 'owner-user');
    await cmdHandler.handle('/trigger set --delay 2h --name t2 --prompt "b"', 'feishu-main', 'oc_test', undefined, 'owner-user');

    const result = await cmdHandler.handle('/trigger', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(getText(result)).toContain('2');
    expect(getText(result)).toContain('t1');
    expect(getText(result)).toContain('t2');

    triggerScheduler.stop();
  });

  // ── 4b. 取消权限边界（补充）──────────────────────────────────────────────

  it('guest can cancel their own trigger', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // guest registers trigger
    await cmdHandler.handle(
      '/trigger set --delay 1h --name guest-task --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'guest-user',
    );

    // guest cancels own trigger
    const result = await cmdHandler.handle(
      '/trigger cancel guest-task',
      'feishu-main', 'oc_test', undefined, 'guest-user',
    );
    expect(getText(result)).toContain('✅');

    triggerScheduler.stop();
  });

  it('cancel nonexistent trigger returns error', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger cancel nonexistent',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');

    triggerScheduler.stop();
  });

  it('cancel without name returns usage hint', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger cancel',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('用法');

    triggerScheduler.stop();
  });

  it('cancelled trigger does not fire', async () => {
    const { cmdHandler, triggerManager, triggerScheduler, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // Use a longer delay so we have time to cancel before it fires
    const now = Date.now();
    const t = {
      ...makeFastTrigger({ name: 'cancel-before-fire', prompt: 'should not fire' }),
      scheduleValue: String(800),
      nextFireAt: now + 800,
    };
    triggerManager.register(t);
    triggerScheduler.register(t);

    // Cancel immediately (well before 800ms)
    await cmdHandler.handle(
      '/trigger cancel cancel-before-fire',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    await new Promise(r => setTimeout(r, 1000));
    expect(enqueuedMessages).toHaveLength(0);

    triggerScheduler.stop();
  });

  it('admin can cancel by trigger ID', async () => {
    const { cmdHandler, triggerScheduler, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    await cmdHandler.handle(
      '/trigger set --delay 1h --name id-cancel-test --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    const trigger = triggerManager.getByName('id-cancel-test');
    expect(trigger).toBeDefined();

    const result = await cmdHandler.handle(
      `/trigger cancel ${trigger!.id}`,
      'feishu-main', 'oc_test', undefined, 'admin-user',
    );
    expect(getText(result)).toContain('✅');

    triggerScheduler.stop();
  });

  // ── 5b. 持久化（补充）────────────────────────────────────────────────────

  it('cron trigger nextFireAt is recalculated on recovery (no backfill)', async () => {
    const { triggersDir } = await setupEnv(tmpDir);

    // Write a cron trigger with a past nextFireAt directly to disk
    const pastTime = Date.now() - 60000;
    const triggerData = {
      version: 1,
      triggers: {
        'cron-past-id': {
          id: 'cron-past-id',
          name: 'cron-past',
          scheduleType: 'cron',
          scheduleValue: '* * * * *',
          nextFireAt: pastTime,
          targetChannel: 'feishu-main',
          targetChannelId: 'oc_test',
          targetSessionStrategy: 'latest',
          prompt: 'cron recovery',
          createdByPeerId: 'owner-user',
          createdByChannel: 'feishu-main',
          fireCount: 5,
          createdAt: pastTime - 3600000,
          updatedAt: pastTime,
        },
      },
    };
    fs.mkdirSync(triggersDir, { recursive: true });
    fs.writeFileSync(path.join(triggersDir, 'triggers.json'), JSON.stringify(triggerData));

    const eventBus = new EventBus();
    const manager = new TriggerManager('test.agentid.pub', triggersDir);
    const scheduler = new TriggerScheduler('test.agentid.pub', manager, eventBus);
    const fired: Message[] = [];
    scheduler.setFireCallback((msg) => fired.push(msg));
    await scheduler.init();

    // Cron should NOT fire immediately (nextFireAt recalculated to future)
    await new Promise(r => setTimeout(r, 200));
    expect(fired).toHaveLength(0);

    // nextFireAt should be updated to future
    const t = manager.getById('cron-past-id');
    expect(t!.nextFireAt).toBeGreaterThan(Date.now() - 1000);

    scheduler.stop();
  });

  it('multiple triggers survive restart and all fire', async () => {
    const { triggerManager, triggerScheduler, triggersDir } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // Register two triggers to disk (they'll be past-due when scheduler2 loads them)
    const now = Date.now();
    const t1 = { ...makeFastTrigger({ name: 'r1', prompt: 'first' }), nextFireAt: now + 100 };
    const t2 = { ...makeFastTrigger({ name: 'r2', prompt: 'second' }), nextFireAt: now + 100 };
    triggerManager.register(t1);
    triggerManager.register(t2);
    triggerScheduler.stop();

    // Wait for triggers to become past-due
    await new Promise(r => setTimeout(r, 200));

    // Rebuild — init() will backfill past-due delay triggers
    const eventBus2 = new EventBus();
    const manager2 = new TriggerManager('test.agentid.pub', triggersDir);
    const scheduler2 = new TriggerScheduler('test.agentid.pub', manager2, eventBus2);
    const fired: string[] = [];
    scheduler2.setFireCallback((msg) => fired.push(msg.content));
    await scheduler2.init();

    await new Promise(r => setTimeout(r, 300));
    expect(fired).toContain('first');
    expect(fired).toContain('second');

    scheduler2.stop();
  });

  // ── 6b. 参数校验（补充）──────────────────────────────────────────────────

  it('rejects --at with past time', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const pastTime = new Date(Date.now() - 60000).toISOString();
    const result = await cmdHandler.handle(
      `/trigger set --at ${pastTime} --prompt "past"`,
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('过期');

    triggerScheduler.stop();
  });

  it('rejects invalid cron expression', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --cron "not-valid-cron" --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('cron');

    triggerScheduler.stop();
  });

  it('rejects --thread and --session together', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1h --thread t1 --session latest --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('互斥');

    triggerScheduler.stop();
  });

  it('rejects --channel without --channelid', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1h --channel feishu-main --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('同时');

    triggerScheduler.stop();
  });

  it('rejects --session with invalid value', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1h --session new --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('session');

    triggerScheduler.stop();
  });

  it('rejects missing time parameter', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --prompt "no time"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('时间');

    triggerScheduler.stop();
  });

  // ── 7. 并发与调度行为 ──────────────────────────────────────────────────────

  it('multiple triggers firing simultaneously all enqueue messages', async () => {
    const { triggerManager, triggerScheduler, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const tm1 = makeFastTrigger({ name: 'm1', prompt: 'msg1' });
    const tm2 = makeFastTrigger({ name: 'm2', prompt: 'msg2' });
    const tm3 = makeFastTrigger({ name: 'm3', prompt: 'msg3' });
    triggerManager.register(tm1); triggerScheduler.register(tm1);
    triggerManager.register(tm2); triggerScheduler.register(tm2);
    triggerManager.register(tm3); triggerScheduler.register(tm3);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    const contents = enqueuedMessages.map(m => m.content);
    expect(contents).toContain('msg1');
    expect(contents).toContain('msg2');
    expect(contents).toContain('msg3');

    triggerScheduler.stop();
  });

  it('trigger message uses interruptible:false (does not interrupt current processing)', async () => {
    const { cmdHandler, triggerManager, triggerScheduler, messageQueue, projectPath } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // Track interrupt calls
    let interruptCalled = false;
    messageQueue.setInterruptCallback(async () => { interruptCalled = true; });

    // Simulate a "processing" state by enqueuing a long-running user message
    const userMsg = {
      channel: 'feishu-main', channelId: 'oc_test', peerId: 'owner-user',
      content: 'user message', chatType: 'private' as const,
    };
    // Enqueue user message (starts processing)
    messageQueue.enqueue('feishu-main:oc_test', userMsg, projectPath);

    // Now register and fire a trigger
    const _t_proc = makeFastTrigger({ prompt: 'trigger while processing' });
    triggerManager.register(_t_proc);
    triggerScheduler.register(_t_proc);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    // Trigger should NOT have called interrupt
    expect(interruptCalled).toBe(false);

    triggerScheduler.stop();
  });

  // ── 8b. EventBus 事件（补充）─────────────────────────────────────────────

  it('trigger:fired event contains correct triggerId and name', async () => {
    const { cmdHandler, triggerScheduler, eventBus, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const fired: any[] = [];
    eventBus.subscribe('trigger:fired', (ev) => fired.push(ev));

    const _t_event_check = makeFastTrigger({ name: 'event-check', prompt: 'test' });
    triggerManager.register(_t_event_check);
    triggerScheduler.register(_t_event_check);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    expect(fired).toHaveLength(1);
    expect(fired[0].name).toBe('event-check');
    expect(fired[0].fireTime).toBeGreaterThan(0);

    triggerScheduler.stop();
  });

  it('trigger:skipped event is published when cron overlaps', async () => {
    const { triggerManager, triggerScheduler, eventBus } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const skipped: any[] = [];
    eventBus.subscribe('trigger:skipped', (ev) => skipped.push(ev));

    const now = Date.now();
    const trigger = {
      id: 'skip-test-id',
      name: 'skip-test',
      scheduleType: 'cron' as const,
      scheduleValue: '* * * * * *',
      nextFireAt: now + 500,
      targetChannel: 'feishu-main',
      targetChannelId: 'oc_test',
      targetSessionStrategy: 'latest' as const,
      prompt: 'skip test',
      createdByPeerId: 'owner-user',
      createdByChannel: 'feishu-main',
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    triggerManager.register(trigger);
    triggerScheduler.register(trigger);

    // Wait for first fire, then mark inflight
    await new Promise(r => setTimeout(r, 600));
    (triggerScheduler as any).inflightCron.add('skip-test-id');

    // Wait for next tick to trigger skip
    await new Promise(r => setTimeout(r, 1200));

    expect(skipped.some((ev: any) => ev.triggerId === 'skip-test-id' && ev.reason === 'overlap')).toBe(true);

    triggerScheduler.stop();
  });

  // ── 9. 边界与防御 ─────────────────────────────────────────────────────────

  it('auto-generates name when --name not provided', async () => {
    const { cmdHandler, triggerScheduler, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    await cmdHandler.handle(
      '/trigger set --delay 1h --prompt "no name given"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    const active = triggerManager.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].name).toBeTruthy();
    expect(active[0].name.length).toBeGreaterThan(0);

    triggerScheduler.stop();
  });

  it('--channel and --channelid override default routing', async () => {
    const { cmdHandler, triggerManager, triggerScheduler, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const _t_cross = makeFastTrigger({ prompt: 'cross channel', targetChannel: 'wechat', targetChannelId: 'wx_user_123' });
    triggerManager.register(_t_cross);
    triggerScheduler.register(_t_cross);

    await new Promise(r => setTimeout(r, FIRE_WAIT_MS));

    expect(enqueuedMessages).toHaveLength(1);
    expect(enqueuedMessages[0].channel).toBe('wechat');
    expect(enqueuedMessages[0].channelId).toBe('wx_user_123');

    triggerScheduler.stop();
  });

  it('guest user can register a trigger (all users allowed)', async () => {
    const { cmdHandler, triggerScheduler, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1h --name guest-trigger --prompt "guest task"',
      'feishu-main', 'oc_test', undefined, 'guest-user',
    );
    expect(getText(result)).toContain('✅');

    const t = triggerManager.getByName('guest-trigger');
    expect(t).toBeDefined();
    expect(t!.createdByPeerId).toBe('guest-user');

    triggerScheduler.stop();
  });

  it('trigger feature disabled returns helpful message', async () => {
    const { cmdHandler } = await setupEnv(tmpDir);
    // Do NOT call setTriggerScheduler — simulate disabled state
    const cmdHandlerNoTrigger = new CommandHandler(
      (cmdHandler as any).sessionManager,
      makeFakeRunner(),
      new MessageCache(),
      new EventBus(),
    );
    await (cmdHandler as any).sessionManager.getOrCreateSession('feishu-main', 'oc_test', '/tmp');

    const result = await cmdHandlerNoTrigger.handle(
      '/trigger set --delay 1h --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('未启用');
  });

  it('unknown /trigger subcommand returns usage hint', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger foobar',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(getText(result)).toContain('❌');
    expect(getText(result)).toContain('用法');

    triggerScheduler.stop();
  });
});
