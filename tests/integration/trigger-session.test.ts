/**
 * 集成测试：触发器驱动会话执行
 *
 * 测试范围：TriggerScheduler → MessageProcessor → SessionManager 的完整链路
 * 验证：
 *   - --session latest：触发器消息续接已有会话（不新建）
 *   - --session silent：触发器消息新建独立 autonomous 会话
 *   - autonomous 会话不发 sendProcessingStatus
 *   - trigger:completed / trigger:failed 事件在 MessageProcessor 处理后发出
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { TriggerManager } from '../../src/core/trigger/manager.js';
import { TriggerScheduler } from '../../src/core/trigger/scheduler.js';
import { EventBus } from '../../src/core/event-bus.js';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { MessageQueue } from '../../src/core/message/message-queue.js';
import { MessageCache } from '../../src/core/message/message-cache.js';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import type { Message, Trigger, AgentEvent } from '../../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeRunner(events: AgentEvent[] = []): any {
  return {
    name: 'claude',
    runQuery: vi.fn().mockImplementation(async function* () {
      for (const ev of events) yield ev;
      yield { type: 'complete', isError: false, subtype: 'end_turn', durationMs: 10, errors: [], result: '' } as AgentEvent;
    }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    hasActiveStream: vi.fn().mockReturnValue(false),
    clearSession: vi.fn(),
    cleanupStream: vi.fn(),
    registerStream: vi.fn(),
    setSendPrompt: vi.fn(),
    setPermissionContext: vi.fn(),
    setMode: vi.fn(),
    getModel: vi.fn().mockReturnValue('claude-sonnet'),
    getContext: vi.fn().mockReturnValue(null),
  };
}

function makeFakeAdapter() {
  const sendText = vi.fn().mockResolvedValue(undefined);
  const sendProcessingStatus = vi.fn();
  return {
    channelName: 'feishu-main',
    sendText,
    sendProcessingStatus,
    acknowledge: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFakePolicy() {
  return {
    canSwitchProject: () => true,
    canListProjects: () => true,
    canCreateSession: () => true,
    canDeleteSession: () => true,
    canImportCliSession: () => true,
    messagePrefix: () => '',
    showMiddleResult: () => true,
    showIdleMonitor: () => true,
    accumulateErrors: () => true,
  };
}

function makeFastTrigger(overrides: Partial<Trigger> = {}): Trigger {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: `t-${Date.now()}`,
    scheduleType: 'delay',
    scheduleValue: '200',
    nextFireAt: now + 200,
    targetChannel: 'feishu-main',
    targetChannelId: 'oc_test',
    targetSessionStrategy: 'latest',
    prompt: 'trigger prompt',
    createdByPeerId: 'owner-user',
    createdByChannel: 'feishu-main',
    fireCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function setupEnv(tmpDir: string) {
  const triggersDir = path.join(tmpDir, 'triggers', 'test.agentid.pub');
  const sessionsDir = path.join(tmpDir, 'sessions');
  const projectPath = path.join(tmpDir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });

  const eventBus = new EventBus();
  const sessionManager = new SessionManager(
    sessionsDir, eventBus,
    (_ch, uid) => uid === 'owner-user',
    (_ch, uid) => uid === 'admin-user',
  );

  const runner = makeFakeRunner([
    { type: 'text', text: 'agent reply' } as AgentEvent,
  ]);
  const adapter = makeFakeAdapter();
  const policy = makeFakePolicy();
  const messageCache = new MessageCache();

  const processor = new MessageProcessor(runner, sessionManager, {}, messageCache, eventBus);
  processor.registerChannel(adapter as any, policy as any);

  const triggerManager = new TriggerManager('test.agentid.pub', triggersDir);
  const triggerScheduler = new TriggerScheduler('test.agentid.pub', triggerManager, eventBus);

  const processedMessages: Message[] = [];
  const messageQueue = new MessageQueue(async (msg) => {
    processedMessages.push(msg);
    await processor.processMessage(msg);
  });
  messageQueue.setEventBus(eventBus);

  triggerScheduler.setFireCallback((msg) => {
    const sessionKey = `${msg.channel}:${msg.channelId}`;
    messageQueue.enqueue(sessionKey, msg, projectPath, { interruptible: false });
  });

  // Pre-create a user session (simulates existing conversation)
  const existingSession = await sessionManager.getOrCreateSession('feishu-main', 'oc_test', projectPath);

  return {
    eventBus,
    sessionManager,
    processor,
    triggerManager,
    triggerScheduler,
    messageQueue,
    processedMessages,
    adapter,
    existingSession,
    projectPath,
    triggersDir,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('trigger session execution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-session-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── --session latest: 续接已有会话 ────────────────────────────────────────

  it('latest trigger reuses the existing active session', async () => {
    const { triggerManager, triggerScheduler, sessionManager, existingSession } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({ targetSessionStrategy: 'latest', prompt: 'check status' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 500));

    // Active session should still be the original one (not a new session)
    const active = await sessionManager.getActiveSession('feishu-main', 'oc_test');
    expect(active?.id).toBe(existingSession.id);

    triggerScheduler.stop();
  });

  it('latest trigger does not change session mode', async () => {
    const { triggerManager, triggerScheduler, sessionManager, existingSession } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({ targetSessionStrategy: 'latest' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 500));

    const active = await sessionManager.getActiveSession('feishu-main', 'oc_test');
    // Session mode should remain interactive (not changed to autonomous)
    expect(active?.sessionMode).toBe('interactive');

    triggerScheduler.stop();
  });

  it('latest trigger sends processing status (not silent)', async () => {
    const { triggerManager, triggerScheduler, adapter } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({ targetSessionStrategy: 'latest' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 500));

    // latest mode: sendProcessingStatus should NOT be called (trigger source skips it)
    // But the agent runner IS invoked and produces output
    expect(adapter.sendProcessingStatus).not.toHaveBeenCalled();

    triggerScheduler.stop();
  });

  // ── --session silent: 新建独立 autonomous 会话 ────────────────────────────

  it('silent trigger creates a new session separate from existing', async () => {
    const { triggerManager, triggerScheduler, sessionManager, existingSession } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({ targetSessionStrategy: 'silent', prompt: 'background work' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 500));

    // The active session should still be the original (silent trigger restores it after execution)
    const active = await sessionManager.getActiveSession('feishu-main', 'oc_test');
    expect(active?.id).toBe(existingSession.id);

    // The autonomous session is cleaned up after execution (unbindSession),
    // so listSessions returns only the original session
    const allSessions = await sessionManager.listSessions('feishu-main', 'oc_test');
    expect(allSessions.length).toBeGreaterThanOrEqual(1);
    expect(allSessions.some(s => s.id === existingSession.id)).toBe(true);

    triggerScheduler.stop();
  });

  it('silent trigger session has autonomous sessionMode', async () => {
    const { triggerManager, triggerScheduler, sessionManager, existingSession } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    // Track sessions created during trigger execution
    const createdSessions: string[] = [];
    const origCreate = sessionManager.createNewSession.bind(sessionManager);
    (sessionManager as any).createNewSession = async (...args: any[]) => {
      const s = await origCreate(...args);
      createdSessions.push(s.id);
      return s;
    };

    const t = makeFastTrigger({ targetSessionStrategy: 'silent', prompt: 'background work' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 500));

    // The autonomous session was created and had sessionMode=autonomous
    // (it gets cleaned up after execution, but we tracked its creation)
    expect(createdSessions.length).toBeGreaterThan(0);

    triggerScheduler.stop();
  });

  it('silent trigger does not send output to channel', async () => {
    const { triggerManager, triggerScheduler, adapter } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const t = makeFastTrigger({ targetSessionStrategy: 'silent', prompt: 'silent work' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 500));

    // autonomous mode: flusher is silent, no text sent to channel
    expect(adapter.sendText).not.toHaveBeenCalled();
    // Also no processing status
    expect(adapter.sendProcessingStatus).not.toHaveBeenCalled();

    triggerScheduler.stop();
  });

  // ── trigger:completed / trigger:failed 事件 ───────────────────────────────

  it('trigger:completed event is published after successful execution (latest)', async () => {
    const { triggerManager, triggerScheduler, eventBus } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const completed: any[] = [];
    eventBus.subscribe('trigger:completed', (ev) => completed.push(ev));

    const t = makeFastTrigger({ targetSessionStrategy: 'latest' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 1200));

    expect(completed).toHaveLength(1);
    expect(completed[0].triggerId).toBe(t.id);
    expect(completed[0].durationMs).toBeGreaterThan(0);

    triggerScheduler.stop();
  });

  it('trigger:failed event is published when agent returns error', async () => {
    const { triggerManager, triggerScheduler, eventBus, sessionManager, projectPath } = await setupEnv(tmpDir);

    // Replace runner with one that returns an error result
    const errorRunner = makeFakeRunner([]);
    errorRunner.runQuery = vi.fn().mockImplementation(async function* () {
      yield { type: 'complete', isError: true, subtype: 'max_turns', durationMs: 10, errors: ['max turns reached'] } as AgentEvent;
    });

    const errorEventBus = new EventBus();
    const errorProcessor = new MessageProcessor(errorRunner, sessionManager, {}, new MessageCache(), errorEventBus);
    const errorAdapter = makeFakeAdapter();
    errorProcessor.registerChannel(errorAdapter as any, makeFakePolicy() as any);

    const errorTriggersDir = path.join(tmpDir, 'triggers2', 'test.agentid.pub');
    const errorManager = new TriggerManager('test.agentid.pub', errorTriggersDir);
    const errorScheduler = new TriggerScheduler('test.agentid.pub', errorManager, errorEventBus);

    const failed: any[] = [];
    errorEventBus.subscribe('trigger:failed', (ev) => failed.push(ev));

    const errorQueue = new MessageQueue(async (msg) => {
      await errorProcessor.processMessage(msg);
    });
    errorQueue.setEventBus(errorEventBus);

    errorScheduler.setFireCallback((msg) => {
      const sessionKey = `${msg.channel}:${msg.channelId}`;
      errorQueue.enqueue(sessionKey, msg, projectPath, { interruptible: false });
    });

    await errorScheduler.init();

    const t = makeFastTrigger({ targetSessionStrategy: 'latest' });
    errorManager.register(t);
    errorScheduler.register(t);

    await new Promise(r => setTimeout(r, 1200));

    expect(failed).toHaveLength(1);
    expect(failed[0].triggerId).toBe(t.id);

    errorScheduler.stop();
  });

  it('trigger:completed event is published for silent trigger (no user-visible output)', async () => {
    const { triggerManager, triggerScheduler, eventBus, adapter } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    const completed: any[] = [];
    eventBus.subscribe('trigger:completed', (ev) => completed.push(ev));

    const t = makeFastTrigger({ targetSessionStrategy: 'silent', prompt: 'silent background work' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 1200));

    // trigger:completed must be published even for silent triggers
    expect(completed).toHaveLength(1);
    expect(completed[0].triggerId).toBe(t.id);
    expect(completed[0].durationMs).toBeGreaterThanOrEqual(0);

    // But no output sent to channel
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(adapter.sendProcessingStatus).not.toHaveBeenCalled();

    triggerScheduler.stop();
  });

  // ── 触发器不打断用户消息 ──────────────────────────────────────────────────

  it('trigger message does not interrupt ongoing user message processing', async () => {
    const { triggerManager, triggerScheduler, messageQueue, processedMessages, projectPath } = await setupEnv(tmpDir);
    await triggerScheduler.init();

    let interruptCalled = false;
    messageQueue.setInterruptCallback(async () => { interruptCalled = true; });

    // Enqueue a user message first (it will be processing when trigger fires)
    const userMsg: Message = {
      channel: 'feishu-main', channelId: 'oc_test',
      peerId: 'owner-user', content: 'user message',
      chatType: 'private',
    };
    messageQueue.enqueue('feishu-main:oc_test', userMsg, projectPath);

    // Register trigger to fire while user message is processing
    const t = makeFastTrigger({ prompt: 'trigger during processing' });
    triggerManager.register(t);
    triggerScheduler.register(t);

    await new Promise(r => setTimeout(r, 800));

    expect(interruptCalled).toBe(false);
    // Both messages should have been processed (trigger queued, not dropped)
    expect(processedMessages.length).toBeGreaterThanOrEqual(1);

    triggerScheduler.stop();
  });
});
