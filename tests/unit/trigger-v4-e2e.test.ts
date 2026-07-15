import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventBus, type GatewayEvent } from '../../src/core/event-bus.js';
import { MessageQueue } from '../../src/core/message/message-queue.js';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { DaemonChannel } from '../../src/channels/daemon.js';
import { TriggerAuditLogger } from '../../src/trigger/audit.js';
import { TriggerFeedbackDispatcher } from '../../src/trigger/feedback.js';
import { TriggerDefinitionManager } from '../../src/trigger/manager.js';
import { TriggerRuntimeScheduler } from '../../src/trigger/scheduler.js';
import { TriggerScriptExecutor } from '../../src/trigger/script-executor.js';
import { TriggerRunStateStore } from '../../src/trigger/state.js';
import { normalizeTriggerDefinition } from '../../src/trigger/validation.js';
import type { Message } from '../../src/types.js';

let tmpDir: string | undefined;
let scheduler: TriggerRuntimeScheduler | undefined;

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe('Trigger V4 e2e', () => {
  it('expands the implicit AUN target shorthand to the agent channel key', () => {
    const definition = normalizeTriggerDefinition({
      $schema_version: 4,
      agentAid: 'test.agentid.pub',
      name: 'implicit-aun-target',
      source: { type: 'once' },
      execution: {
        type: 'target_session',
        prompt: 'test',
        onError: 'fail',
        noopSentinel: '[[NOOP]]',
      },
      feedback: {
        strategy: 'target',
        target: {
          channelKey: 'aun',
          channelId: 'recipient.agentid.pub',
          session: 'main',
        },
      },
      reliability: {
        concurrency: 'forbid',
        missedPolicy: 'run_once',
        retry: { maxAttempts: 0, backoffMs: 30_000 },
      },
    });

    expect(definition.feedback.target?.channelKey).toBe('aun#test.agentid.pub#main');
  });

  it('runs once + target_session through scheduler, queue, event bus, and audit', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-v4-e2e-'));
    const projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });

    const eventBus = new EventBus();
    const events: GatewayEvent[] = [];
    eventBus.subscribeAll(event => events.push(event));

    const receivedMessages: Message[] = [];
    const messageQueue = new MessageQueue(async (message) => {
      receivedMessages.push(message);
      const meta = message.triggerMeta!;
      eventBus.publish({
        type: 'trigger:completed',
        triggerId: meta.triggerId!,
        name: meta.triggerName ?? 'trigger-v4-e2e',
        runId: meta.runId!,
        originTriggerId: meta.triggerId!,
        messageId: message.messageId ?? meta.runId!,
        durationMs: 5,
        targetChannel: message.channel,
        targetChannelId: message.channelId,
        fireTime: meta.fireTime ?? Date.now(),
      });
    });
    messageQueue.setEventBus(eventBus);

    const sessionManager = new SessionManager(
      path.join(tmpDir, 'sessions'),
      eventBus,
      () => ({ role: 'owner', mode: 'interactive' }),
    );

    const manager = new TriggerDefinitionManager('test.agentid.pub', path.join(tmpDir, 'triggers'));
    const state = new TriggerRunStateStore(manager);
    const audit = new TriggerAuditLogger(path.join(tmpDir, 'logs'), manager.history);
    const feedback = new TriggerFeedbackDispatcher({
      getChannel: (agentAid, channelKey) => {
        if (agentAid !== 'test.agentid.pub' || channelKey !== 'feishu-main') return undefined;
        return {
          adapter: {
            channelName: 'feishu-main',
            channelKey: 'feishu-main',
            capabilities: { file: false, image: false, interaction: false, markdown: true, thought: false, status: true, thread: true },
            send: vi.fn(),
          } as any,
          agentAid,
          agentName: 'test-agent',
          projectPath,
          baseagent: 'claude',
        };
      },
      sessionManager,
      messageQueue,
      eventBus,
    });
    const daemon = new DaemonChannel(sessionManager, messageQueue);

    scheduler = new TriggerRuntimeScheduler(
      manager,
      state,
      audit,
      new TriggerScriptExecutor(),
      feedback,
      daemon,
      { projectPath, baseagent: 'claude' },
      eventBus,
    );
    await scheduler.init();

    const created = scheduler.create({
      $schema_version: 4,
      id: 'trig_v4_e2e_once',
      agentAid: 'test.agentid.pub',
      enabled: true,
      name: 'trigger-v4-e2e',
      source: { type: 'once' },
      execution: {
        type: 'target_session',
        prompt: '生成一次状态摘要：{{trigger.name}}',
        model: 'gpt-e2e',
        effort: 'high',
        permissionMode: 'readonly',
        onError: 'fail',
        noopSentinel: '[[NOOP]]',
      },
      feedback: {
        strategy: 'target',
        target: {
          channelKey: 'feishu-main',
          channelId: 'oc_e2e',
          session: 'main',
        },
      },
      reliability: {
        concurrency: 'forbid',
        missedPolicy: 'run_once',
        retry: { maxAttempts: 0, backoffMs: 1 },
      },
    }, [], { enable: true });

    await waitFor(() => manager.require(created.id).enabled === false);

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].content).toBe('生成一次状态摘要：trigger-v4-e2e');
    expect(receivedMessages[0].source).toBe('trigger');
    expect(receivedMessages[0].triggerMeta?.triggerId).toBe(created.id);
    expect(receivedMessages[0].triggerMeta?.modelOverride).toBe('gpt-e2e');
    expect(receivedMessages[0].triggerMeta?.effortOverride).toBe('high');
    expect(receivedMessages[0].triggerMeta?.permissionModeOverride).toBe('readonly');

    const recent = audit.recent(created.id, 5);
    expect(recent).toHaveLength(1);
    expect(recent[0].definition.schemaVersion).toBe(4);
    expect(recent[0].status).toBe('completed');
    expect(recent[0].processing?.mode).toBe('target_session');
    expect(recent[0].feedback?.strategy).toBe('target');
    expect(recent[0].feedback?.target?.channelId).toBe('oc_e2e');
    expect(recent[0].effects[0]).toMatchObject({
      type: 'message.inbound',
      status: 'success',
      channelKey: 'feishu-main',
      channelId: 'oc_e2e',
    });
    expect(state.list(created.id)).toEqual([]);
    expect(events.some(event => event.type === 'trigger:registered' && event.triggerId === created.id)).toBe(true);
    expect(events.some(event => event.type === 'trigger:fired' && event.triggerId === created.id)).toBe(true);
    expect(events.some(event => event.type === 'trigger:completed' && event.triggerId === created.id)).toBe(true);
  });

  it('blocks a task:error caused by the same trigger before starting a second run', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-causation-e2e-'));
    const projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });

    const eventBus = new EventBus();
    const events: GatewayEvent[] = [];
    eventBus.subscribeAll(event => events.push(event));

    const receivedMessages: Message[] = [];
    const messageQueue = new MessageQueue(async message => {
      receivedMessages.push(message);
      const meta = message.triggerMeta!;
      eventBus.publish({
        type: 'task:error',
        sessionId: meta.boundSessionId ?? 'target-session',
        error: 'descendant failure',
        errorType: 'agent:test',
        causation: message.causation,
      });
      eventBus.publish({
        type: 'trigger:completed',
        triggerId: meta.triggerId,
        name: meta.triggerName ?? 'causation-cycle',
        runId: meta.runId!,
        originTriggerId: meta.triggerId,
        messageId: message.messageId ?? meta.runId!,
        durationMs: 1,
        targetChannel: message.channel,
        targetChannelId: message.channelId,
        fireTime: meta.fireTime ?? Date.now(),
        causation: message.causation,
      });
    });
    messageQueue.setEventBus(eventBus);

    const sessionManager = new SessionManager(
      path.join(tmpDir, 'sessions'),
      eventBus,
      () => ({ role: 'owner', mode: 'interactive' }),
    );
    const manager = new TriggerDefinitionManager('test.agentid.pub', path.join(tmpDir, 'triggers'));
    const state = new TriggerRunStateStore(manager);
    const audit = new TriggerAuditLogger(path.join(tmpDir, 'logs'), manager.history);
    const binding = {
      adapter: {
        channelName: 'aun#test.agentid.pub#main',
        channelKey: 'aun#test.agentid.pub#main',
        capabilities: { file: false, image: false, interaction: false, markdown: true, thought: false, status: true, thread: true },
        send: vi.fn(),
      } as any,
      agentAid: 'test.agentid.pub',
      agentName: 'test-agent',
      projectPath,
      baseagent: 'claude',
    };
    const feedback = new TriggerFeedbackDispatcher({
      getChannel: (_agentAid, channelKey) => channelKey === binding.adapter.channelKey ? binding : undefined,
      sessionManager,
      messageQueue,
      eventBus,
    });
    const daemon = new DaemonChannel(sessionManager, messageQueue);
    scheduler = new TriggerRuntimeScheduler(
      manager,
      state,
      audit,
      new TriggerScriptExecutor(),
      feedback,
      daemon,
      { projectPath, baseagent: 'claude' },
      eventBus,
    );
    await scheduler.init();

    const created = scheduler.create({
      $schema_version: 4,
      id: 'trig_causation_cycle',
      agentAid: 'test.agentid.pub',
      enabled: true,
      name: 'causation-cycle',
      source: { type: 'event', eventPattern: 'task:error' },
      execution: {
        type: 'target_session',
        prompt: 'diagnose {{event.error}}',
        onError: 'fail',
        noopSentinel: '[[NOOP]]',
      },
      feedback: {
        strategy: 'target',
        target: {
          channelKey: binding.adapter.channelKey,
          channelId: 'target.agentid.pub',
          session: 'main',
        },
      },
      reliability: {
        concurrency: 'allow',
        missedPolicy: 'run_once',
        retry: { maxAttempts: 0, backoffMs: 1 },
      },
      limits: { maxRuns: 10 },
    }, [], { enable: true });

    eventBus.publish({
      type: 'task:error',
      sessionId: 'external-session',
      error: 'initial failure',
      errorType: 'agent:test',
    });

    await waitFor(() => audit.recent(created.id, 10).length === 2);
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].causation?.trigger?.path).toHaveLength(1);
    expect(audit.recent(created.id, 10).map(record => record.status).sort()).toEqual(['completed', 'skipped']);
    expect(audit.recent(created.id, 10).find(record => record.status === 'skipped')?.reason).toBe('causation_cycle');
    expect(state.readLimitState(created.id)?.runCount).toBe(1);
    expect(events.filter(event => event.type === 'trigger:fired' && event.triggerId === created.id)).toHaveLength(1);
    expect(events.filter(event => event.type === 'trigger:failed' && event.triggerId === created.id)).toHaveLength(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (lastError) throw lastError;
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}
