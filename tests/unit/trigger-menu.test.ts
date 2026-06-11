/**
 * menu protocol → trigger 入口测试（D4 直调底层）
 *
 * 验证 menu.action set/cancel、menu.update、menu.options(list) 路由到 manager/scheduler
 * 的真实调用，且结构化 args 绕过文本解析（无注入路径）。
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
import { CommandHandler } from '../../src/core/command/command-handler.js';

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
    (_ch, uid) => uid === 'owner-user',
    (_ch, uid) => uid === 'admin-user',
  );
  const messageCache = new MessageCache();
  const cmdHandler = new CommandHandler(sessionManager, makeFakeRunner(), messageCache, eventBus);

  const triggerManager = new TriggerManager('test.agentid.pub', triggersDir);
  const triggerScheduler = new TriggerScheduler('test.agentid.pub', triggerManager, eventBus);
  cmdHandler.setTriggerScheduler(triggerScheduler, triggerManager);

  await sessionManager.getOrCreateSession('feishu-main', 'oc_test', projectPath, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'feishu');

  const messageQueue = new MessageQueue(async () => {});
  messageQueue.setEventBus(eventBus);
  cmdHandler.setMessageQueue(messageQueue);

  return { cmdHandler, triggerManager, triggerScheduler };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('menu /trigger set (action, direct call)', () => {
  it('registers a trigger via structured args and persists to manager', async () => {
    const { cmdHandler, triggerManager } = await setupEnv(tmpDir);
    const r = await cmdHandler.execMenuAction(
      '/trigger', 'set',
      { scheduleType: 'delay', scheduleValue: '60000', prompt: 'do it', name: 'menu-t1', targetSessionStrategy: 'latest' },
      'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.data.name).toBe('menu-t1');
    expect(r.data.id).toBeTruthy();
    expect(triggerManager.getByName('menu-t1')).toBeTruthy();
  });

  it('rejects missing required args', async () => {
    const { cmdHandler } = await setupEnv(tmpDir);
    const r = await cmdHandler.execMenuAction(
      '/trigger', 'set', { scheduleType: 'delay' }, 'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.code).toBe('INVALID_ARGS');
  });

  it('does not interpret prompt text as flags (no injection)', async () => {
    const { cmdHandler, triggerManager } = await setupEnv(tmpDir);
    const r = await cmdHandler.execMenuAction(
      '/trigger', 'set',
      { scheduleType: 'delay', scheduleValue: '60000', prompt: '--session current --channel evil', name: 'menu-inj' },
      'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.data.name).toBe('menu-inj');
    const t = triggerManager.getByName('menu-inj')!;
    // prompt 原样保存，未被当作 flag 解析
    expect(t.prompt).toBe('--session current --channel evil');
    expect(t.targetSessionStrategy).toBe('latest');
  });

  it('rejects non-numeric delay scheduleValue (no NaN nextFireAt)', async () => {
    const { cmdHandler, triggerManager } = await setupEnv(tmpDir);
    const r = await cmdHandler.execMenuAction(
      '/trigger', 'set',
      { scheduleType: 'delay', scheduleValue: 'abc', prompt: 'p', name: 'bad-delay' },
      'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.code).toBe('INVALID_ARGS');
    expect(triggerManager.getByName('bad-delay')).toBeFalsy();
  });

  it('rejects unknown scheduleType', async () => {
    const { cmdHandler } = await setupEnv(tmpDir);
    const r = await cmdHandler.execMenuAction(
      '/trigger', 'set',
      { scheduleType: 'interval', scheduleValue: '5', prompt: 'p', name: 'bad-type' },
      'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.code).toBe('INVALID_ARGS');
  });

  it('rejects invalid targetSessionStrategy', async () => {
    const { cmdHandler } = await setupEnv(tmpDir);
    const r = await cmdHandler.execMenuAction(
      '/trigger', 'set',
      { scheduleType: 'delay', scheduleValue: '60000', prompt: 'p', name: 'bad-strat', targetSessionStrategy: 'immediate' },
      'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.code).toBe('INVALID_ARGS');
  });
});

describe('menu /trigger cancel (action)', () => {
  it('cancels by name (admin scope)', async () => {
    const { cmdHandler, triggerManager, triggerScheduler } = await setupEnv(tmpDir);
    await cmdHandler.execMenuAction(
      '/trigger', 'set',
      { scheduleType: 'delay', scheduleValue: '60000', prompt: 'p', name: 'to-cancel' },
      'feishu-main', 'oc_test', 'owner-user',
    );
    const cancelSpy = vi.spyOn(triggerScheduler, 'cancel');
    const r = await cmdHandler.execMenuAction(
      '/trigger', 'cancel', { nameOrId: 'to-cancel' }, 'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.data.cancelled).toBe(true);
    expect(cancelSpy).toHaveBeenCalledWith(r.data.id);
    expect(triggerManager.getByName('to-cancel')).toBeFalsy();
  });

  it('returns NOT_FOUND for unknown trigger', async () => {
    const { cmdHandler } = await setupEnv(tmpDir);
    const r = await cmdHandler.execMenuAction(
      '/trigger', 'cancel', { nameOrId: 'nope' }, 'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.code).toBe('NOT_FOUND');
  });
});

describe('menu /trigger update', () => {
  it('updates scheduleValue and recomputes nextFireAt', async () => {
    const { cmdHandler, triggerManager } = await setupEnv(tmpDir);
    await cmdHandler.execMenuAction(
      '/trigger', 'set',
      { scheduleType: 'delay', scheduleValue: '60000', prompt: 'p', name: 'to-update' },
      'feishu-main', 'oc_test', 'owner-user',
    );
    const before = triggerManager.getByName('to-update')!.nextFireAt;
    const r = await cmdHandler.execMenuUpdate(
      '/trigger', JSON.stringify({ nameOrId: 'to-update', scheduleValue: '600000' }),
      'feishu-main', 'oc_test', 'owner-user',
    ) as any;
    expect(r.data.id).toBeTruthy();
    expect(r.data.nextFireAt).toBeGreaterThan(before);
  });

  it('rejects non-JSON value', async () => {
    const { cmdHandler } = await setupEnv(tmpDir);
    const r = await cmdHandler.execMenuUpdate('/trigger', 'not json', 'feishu-main', 'oc_test', 'owner-user') as any;
    expect(r.code).toBe('INVALID_ARGS');
  });
});

describe('menu /trigger list (options)', () => {
  it('maps each trigger to one MenuItem', async () => {
    const { cmdHandler } = await setupEnv(tmpDir);
    await cmdHandler.execMenuAction('/trigger', 'set', { scheduleType: 'delay', scheduleValue: '60000', prompt: 'p', name: 'L1' }, 'feishu-main', 'oc_test', 'owner-user');
    await cmdHandler.execMenuAction('/trigger', 'set', { scheduleType: 'delay', scheduleValue: '60000', prompt: 'p', name: 'L2' }, 'feishu-main', 'oc_test', 'owner-user');
    const items = await cmdHandler.getSubMenuItems('/trigger', 'feishu-main', 'oc_test', 'owner-user');
    expect(items!.length).toBe(2);
    expect(items!.map(i => i.label).sort()).toEqual(['L1', 'L2']);
  });
});
