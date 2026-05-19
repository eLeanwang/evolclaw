/**
 * 集成测试：触发器功能端到端链路
 *
 * 测试范围：TriggerManager + TriggerScheduler + CommandHandler.handleTrigger 联动
 * 不启动完整进程，不连接真实 channel，但测试多模块协作的真实行为。
 *
 * 用例：
 *   - /trigger set → 注册 → 到期触发 → 合成消息投递到 MessageQueue
 *   - /trigger list / /trigger（无参）显示正确内容
 *   - /trigger cancel 权限边界（owner vs guest）
 *   - 持久化恢复：重建 scheduler 后触发器仍然存在并触发
 *   - cron 重叠跳过：上次未完成时跳过本次
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TriggerManager } from '../../src/core/trigger/manager.js';
import { TriggerScheduler } from '../../src/core/trigger/scheduler.js';
import { EventBus } from '../../src/core/event-bus.js';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { MessageQueue } from '../../src/core/message/message-queue.js';
import { MessageCache } from '../../src/core/message/message-cache.js';
import { CommandHandler } from '../../src/core/command-handler.js';
import type { Message } from '../../src/types.js';

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
    const { cmdHandler, triggerScheduler, enqueuedMessages, session } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1s --prompt "hello from trigger"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(result).toContain('✅');
    expect(result).toContain('已注册');

    // Wait for trigger to fire
    await new Promise(r => setTimeout(r, 1500));

    expect(enqueuedMessages).toHaveLength(1);
    const msg = enqueuedMessages[0];
    expect(msg.source).toBe('trigger');
    expect(msg.content).toBe('hello from trigger');
    expect(msg.peerId).toBe('__trigger__');
    expect(msg.triggerMeta?.silent).toBe(false);

    triggerScheduler.stop();
  });

  it('registers a silent trigger with --session silent', async () => {
    const { cmdHandler, triggerScheduler, enqueuedMessages } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    await cmdHandler.handle(
      '/trigger set --delay 1s --session silent --prompt "background task"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

    await new Promise(r => setTimeout(r, 1500));

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
    expect(result).toContain('my-task');
    expect(result).toContain('delay');

    triggerScheduler.stop();
  });

  it('/trigger list shows all triggers including history', async () => {
    const { cmdHandler, triggerScheduler, triggerManager } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // Register and immediately fire (50ms delay)
    await cmdHandler.handle(
      '/trigger set --delay 1s --name fired-task --prompt "done"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    await new Promise(r => setTimeout(r, 1500));

    const result = await cmdHandler.handle('/trigger list', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(result).toContain('fired-task');
    expect(result).toContain('fired');  // doneReason in history

    triggerScheduler.stop();
  });

  it('/trigger shows empty message when no active triggers', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle('/trigger', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(result).toContain('没有活跃');

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
    expect(result).toContain('✅');
    expect(result).toContain('cancel-me');

    // Verify removed from active
    const listResult = await cmdHandler.handle('/trigger', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(listResult).toContain('没有活跃');

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
    expect(result).toContain('❌');

    // Trigger still active
    const listResult = await cmdHandler.handle('/trigger', 'feishu-main', 'oc_test', undefined, 'owner-user');
    expect(listResult).toContain('owner-task');

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
    expect(result).toContain('✅');

    triggerScheduler.stop();
  });

  // ── Persistence & recovery ─────────────────────────────────────────────────

  it('persists triggers to disk and recovers after restart', async () => {
    const { cmdHandler, triggerScheduler, triggersDir, enqueuedMessages, projectPath } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // Register a trigger that fires in 100ms
    await cmdHandler.handle(
      '/trigger set --delay 1s --name persist-test --prompt "recovered"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );

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
    await new Promise(r => setTimeout(r, 1500));
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
    expect(result).toContain('❌');
    expect(result).toContain('prompt');

    triggerScheduler.stop();
  });

  it('rejects /trigger set with conflicting time params', async () => {
    const { cmdHandler, triggerScheduler } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const result = await cmdHandler.handle(
      '/trigger set --delay 1h --cron "0 9 * * *" --prompt "test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(result).toContain('❌');
    expect(result).toContain('互斥');

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
    expect(result).toContain('❌');

    triggerScheduler.stop();
  });

  // ── EventBus events ────────────────────────────────────────────────────────

  it('publishes trigger:registered and trigger:fired events', async () => {
    const { cmdHandler, triggerScheduler, eventBus } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const registered: any[] = [];
    const fired: any[] = [];
    eventBus.subscribe('trigger:registered', (ev) => registered.push(ev));
    eventBus.subscribe('trigger:fired', (ev) => fired.push(ev));

    await cmdHandler.handle(
      '/trigger set --delay 1s --prompt "event test"',
      'feishu-main', 'oc_test', undefined, 'owner-user',
    );
    expect(registered).toHaveLength(1);

    await new Promise(r => setTimeout(r, 1500));
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
});
