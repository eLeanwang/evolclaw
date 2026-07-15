import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/event-bus.js';
import type { TextInferenceProvider, TextInferenceRequest } from '../../src/core/inference/text-inference.js';
import { MessageBridge } from '../../src/core/message/message-bridge.js';
import { buildInboundEntry, buildOutboundEntry, messageLogPath } from '../../src/core/message/message-log.js';
import {
  SessionRenewService,
  classifyExplicitSessionRenewSignal,
  isSessionRenewConversationEntry,
  selectLatestHaikuModel,
  selectSessionRenewContext,
} from '../../src/core/session/session-renew.js';
import { appendJsonl, readAllJsonlLines } from '../../src/core/session/session-fs-store.js';
import { SessionManager } from '../../src/core/session/session-manager.js';
import type { SessionRenewConfig } from '../../src/types.js';

const SELF_AID = 'self.agentid.pub';
const PEER_AID = 'peer.agentid.pub';
const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);
const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('classifyExplicitSessionRenewSignal', () => {
  it('requires a fixed phrase at the start followed immediately by punctuation', () => {
    expect(classifyExplicitSessionRenewSignal('新话题：讨论部署')).toBe('new');
    expect(classifyExplicitSessionRenewSignal('新会话：讨论部署')).toBe('new');
    expect(classifyExplicitSessionRenewSignal('  重新开始，换一个需求')).toBe('new');
    expect(classifyExplicitSessionRenewSignal('继续：把测试补完')).toBe('continue');
    expect(classifyExplicitSessionRenewSignal('接着\n处理昨天的问题')).toBe('continue');

    expect(classifyExplicitSessionRenewSignal('继续从 GitHub 下载')).toBeUndefined();
    expect(classifyExplicitSessionRenewSignal('我想换个话题，讨论部署')).toBeUndefined();
    expect(classifyExplicitSessionRenewSignal('继续 上次的问题')).toBeUndefined();
    expect(classifyExplicitSessionRenewSignal('这是继续教育项目')).toBeUndefined();
  });
});

describe('session renew history selection', () => {
  it('filters by EvolClaw sessionId and excludes non-conversation records', () => {
    const text = buildInboundEntry({
      from: PEER_AID,
      to: SELF_AID,
      sessionId: 'session-a',
      chatType: 'private',
      content: 'hello',
    });
    const command = buildInboundEntry({
      from: PEER_AID,
      to: SELF_AID,
      sessionId: 'session-a',
      chatType: 'private',
      content: '/status',
    });
    const other = { ...text, sessionId: 'session-b' };

    expect(isSessionRenewConversationEntry(text, 'session-a')).toBe(true);
    expect(isSessionRenewConversationEntry(command, 'session-a')).toBe(false);
    expect(isSessionRenewConversationEntry(other, 'session-a')).toBe(false);
  });

  it('keeps the first message and a bounded recent tail', () => {
    const entries = Array.from({ length: 60 }, (_, index) => buildInboundEntry({
      from: PEER_AID,
      to: SELF_AID,
      sessionId: 'session-a',
      chatType: 'private',
      content: `message-${index}`,
      timestamp: index + 1,
    }));

    const selected = selectSessionRenewContext(entries);
    expect(selected).toHaveLength(40);
    expect(selected[0].content).toBe('message-0');
    expect(selected.at(-1)?.content).toBe('message-59');
  });
});

describe('selectLatestHaikuModel', () => {
  it('selects the highest Haiku version and then the newest dated release', () => {
    expect(selectLatestHaikuModel([
      'claude-3-5-haiku-20241022',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20250929',
      JUDGE_MODEL,
      'claude-opus-4-8',
    ])).toBe(JUDGE_MODEL);
  });

  it('returns undefined when the provider exposes no Haiku model', () => {
    expect(selectLatestHaikuModel(['claude-sonnet-4-6', 'claude-opus-4-8'])).toBeUndefined();
  });
});

describe('SessionRenewService', () => {
  it('creates a fresh logical session for an explicit new signal without calling the model', async () => {
    const fixture = await createFixture({ modelResult: modelDecision('continue', 1) });
    const result = await fixture.service.resolve(fixture.request('新话题：讨论部署'));

    expect(result.decision).toBe('new');
    expect(result.source).toBe('explicit');
    expect(result.session.id).not.toBe(fixture.session.id);
    expect(result.session.agentSessionId).toBeUndefined();
    expect(result.session.metadata?.peerId).toBe(PEER_AID);
    expect(fixture.modelCalls()).toBe(0);
  });

  it('continues for a strict continue signal and for an explicit reply to current history', async () => {
    const fixture = await createFixture({ modelResult: modelDecision('new', 1) });

    const explicit = await fixture.service.resolve(fixture.request('继续：补完测试'));
    expect(explicit.session.id).toBe(fixture.session.id);
    expect(explicit.source).toBe('explicit');

    const replyFixture = await createFixture({ modelResult: modelDecision('new', 1) });
    const reply = await replyFixture.service.resolve(replyFixture.request('补充一点', 'old-in'));
    expect(reply.session.id).toBe(replyFixture.session.id);
    expect(reply.source).toBe('reply');
    expect(replyFixture.modelCalls()).toBe(0);
  });

  it('uses the model for non-explicit text and requires high confidence before creating a new session', async () => {
    const low = await createFixture({ modelResult: modelDecision('new', 0.7) });
    const lowResult = await low.service.resolve(low.request('继续从 GitHub 下载'));
    expect(lowResult.decision).toBe('continue');
    expect(lowResult.source).toBe('model');
    expect(low.modelCalls()).toBe(1);

    const high = await createFixture({ modelResult: modelDecision('new', 0.95) });
    const highResult = await high.service.resolve(high.request('帮我规划一次旅行'));
    expect(highResult.decision).toBe('new');
    expect(highResult.session.id).not.toBe(high.session.id);
    expect(high.modelCalls()).toBe(1);
    expect(high.modelListCalls()).toBe(1);
    expect(high.requestedBaseagents()).toEqual(['claude']);
    expect(high.lastRequest()).toMatchObject({
      model: JUDGE_MODEL,
      effort: 'low',
      system: expect.stringContaining('session continuity classifier'),
      input: expect.any(String),
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(high.lastRequest()?.input || '{}')).toMatchObject({
      new_message: '帮我规划一次旅行',
      chat_type: 'private',
    });
  });

  it('uses the latest listed Haiku model regardless of the candidate session baseagent', async () => {
    const codex = await createFixture({
      baseagent: 'codex',
      availableModels: ['claude-3-5-haiku-20241022', 'claude-sonnet-4-6', JUDGE_MODEL],
    });
    const result = await codex.service.resolve(codex.request('帮我规划一次旅行'));

    expect(result.source).toBe('model');
    expect(codex.requestedBaseagents()).toEqual(['claude']);
    expect(codex.lastRequest()).toMatchObject({
      model: JUDGE_MODEL,
      effort: 'low',
    });
  });

  it('uses fallback when the Claude provider is unavailable or exposes no Haiku model', async () => {
    const unavailable = await createFixture({ baseagent: 'codex', unavailableBaseagents: ['claude'], config: { fallback_action: 'new' } });
    const unavailableResult = await unavailable.service.resolve(unavailable.request('帮我规划一次旅行'));
    expect(unavailableResult.decision).toBe('new');
    expect(unavailableResult.source).toBe('fallback');
    expect(unavailableResult.session.id).not.toBe(unavailable.session.id);
    expect(unavailable.modelCalls()).toBe(0);
    expect(unavailable.requestedBaseagents()).toEqual(['claude']);

    const noHaikuModel = await createFixture({
      availableModels: ['claude-sonnet-4-6'],
      config: { fallback_action: 'new' },
    });
    const noHaikuResult = await noHaikuModel.service.resolve(noHaikuModel.request('帮我规划一次旅行'));
    expect(noHaikuResult.decision).toBe('new');
    expect(noHaikuResult.source).toBe('fallback');
    expect(noHaikuModel.modelListCalls()).toBe(1);
    expect(noHaikuModel.modelCalls()).toBe(0);

    const explicit = await createFixture({ baseagent: 'gemini' });
    const explicitResult = await explicit.service.resolve(explicit.request('新话题：帮我规划一次旅行'));
    expect(explicitResult.decision).toBe('new');
    expect(explicitResult.source).toBe('explicit');
    expect(explicit.modelCalls()).toBe(0);
  });

  it('falls back to continue on invalid model output', async () => {
    const fixture = await createFixture({ modelResult: 'not-json' });
    const result = await fixture.service.resolve(fixture.request('看看这个问题'));

    expect(result.decision).toBe('continue');
    expect(result.source).toBe('fallback');
    expect(result.session.id).toBe(fixture.session.id);
  });

  it('skips renew when disabled, not expired, processing, or thread-bound', async () => {
    const disabled = await createFixture({ enabled: false });
    expect((await disabled.service.resolve(disabled.request('新话题：x'))).decision).toBeUndefined();

    const recent = await createFixture({ lastMessageAt: NOW - 60 * 60 * 1000 });
    expect((await recent.service.resolve(recent.request('新话题：x'))).decision).toBeUndefined();

    const processing = await createFixture();
    processing.session.processingState = `${NOW - 1000}:task`;
    expect((await processing.service.resolve(processing.request('新话题：x'))).decision).toBeUndefined();

    const thread = await createFixture();
    thread.session.threadId = 'topic-1';
    expect((await thread.service.resolve(thread.request('新话题：x'))).decision).toBeUndefined();

  });

  it('creates a new session for existing sessions without sessionId history regardless of age', async () => {
    const fixture = await createFixture({ writeHistory: false, sessionUpdatedAt: NOW - 60 * 60 * 1000 });
    const legacyEntry = buildInboundEntry({
      from: PEER_AID,
      to: SELF_AID,
      sessionId: fixture.session.id,
      msgId: 'legacy-in',
      chatType: 'private',
      content: '旧格式消息',
      timestamp: NOW - 30 * 60 * 1000,
    });
    delete legacyEntry.sessionId;
    appendJsonl(messageLogPath(fixture.manager.getChatDir(fixture.session)), legacyEntry);

    const result = await fixture.service.resolve(fixture.request('继续：旧任务还没结束'));

    expect(result.decision).toBe('new');
    expect(result.source).toBe('missing_history');
    expect(result.session.id).not.toBe(fixture.session.id);
    expect(fixture.modelCalls()).toBe(0);
  });

  it('keeps a newly created first session before its first message is logged', async () => {
    const fixture = await createFixture({ writeHistory: false });
    const result = await fixture.service.resolve(fixture.request('第一条消息', undefined, true));

    expect(result.decision).toBeUndefined();
    expect(result.session.id).toBe(fixture.session.id);
    expect(fixture.modelCalls()).toBe(0);
  });

  it('serializes concurrent renew decisions and creates only one new session', async () => {
    const fixture = await createFixture({ modelResult: modelDecision('new', 0.99), modelDelayMs: 10 });
    const [first, second] = await Promise.all([
      fixture.service.resolve(fixture.request('完全不同的问题')),
      fixture.service.resolve(fixture.request('另一个独立请求')),
    ]);

    expect(first.session.id).not.toBe(fixture.session.id);
    expect(second.session.id).toBe(first.session.id);
    expect(fixture.modelCalls()).toBe(1);
  });
});

describe('MessageBridge session renew integration', () => {
  it('writes the triggering inbound message with the renewed sessionId', async () => {
    const fixture = await createFixture();
    const queue = {
      getGlobalProcessingCount: () => 0,
      enqueue: vi.fn().mockResolvedValue(undefined),
    };
    const processor = {
      getAgent: vi.fn(),
      getAvailableAgents: vi.fn().mockReturnValue([]),
      getChannelInfo: vi.fn(),
    };
    const bridge = new MessageBridge(
      fixture.session.projectPath,
      fixture.manager,
      processor as any,
      queue as any,
      { isCommand: () => false } as any,
      new EventBus(),
      0,
    );
    (bridge as any).resolveInboundRole = () => ({
      effectiveRole: 'owner',
      source: 'agent-config-owner',
      isAuthenticated: true,
      allowAccess: true,
      roleExists: true,
    });

    let renewedSessionId = '';
    (bridge as any).sessionRenewService = {
      resolve: async ({ session }: { session: typeof fixture.session }) => {
        const renewed = await fixture.manager.createRenewedSession(session);
        renewedSessionId = renewed.id;
        return { session: renewed, renewed: true, decision: 'new', source: 'explicit' };
      },
    };

    let inboundHandler: ((message: any) => Promise<void>) | undefined;
    bridge.register('main', handler => { inboundHandler = handler; }, async () => {}, undefined, 'aun');
    await inboundHandler?.({
      channel: 'main',
      channelType: 'aun',
      channelId: PEER_AID,
      selfAID: SELF_AID,
      peerId: PEER_AID,
      chatType: 'private',
      messageId: 'renew-trigger',
      content: '新话题：讨论部署',
    });

    expect(renewedSessionId).not.toBe('');
    expect(queue.enqueue).toHaveBeenCalledWith(
      renewedSessionId,
      expect.any(Object),
      fixture.session.projectPath,
      expect.any(Object),
    );
    const entries = readAllJsonlLines<any>(messageLogPath(fixture.manager.getChatDir(fixture.session)));
    const triggeringEntry = entries.find(entry => entry.msgId === 'renew-trigger');
    expect(triggeringEntry?.sessionId).toBe(renewedSessionId);
  });
});

function modelDecision(decision: 'continue' | 'new', confidence: number): string {
  return JSON.stringify({ decision, confidence, reason_code: 'test' });
}

async function createFixture(options: {
  enabled?: boolean;
  lastMessageAt?: number;
  writeHistory?: boolean;
  modelResult?: string;
  modelDelayMs?: number;
  sessionUpdatedAt?: number;
  config?: Partial<SessionRenewConfig>;
  baseagent?: string;
  unavailableBaseagents?: string[];
  availableModels?: string[];
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-renew-'));
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const manager = new SessionManager(sessionsDir, new EventBus());
  const session = await manager.getOrCreateSession(
    'main',
    PEER_AID,
    projectPath,
    undefined,
    { peerId: PEER_AID, peerName: 'Peer', channelKey: `aun#${SELF_AID}#main` },
    undefined,
    PEER_AID,
    'private',
    options.baseagent ?? 'claude',
    SELF_AID,
    'aun',
  );
  if (options.sessionUpdatedAt !== undefined) session.updatedAt = options.sessionUpdatedAt;

  if (options.writeHistory !== false) {
    const timestamp = options.lastMessageAt ?? NOW - 48 * 60 * 60 * 1000;
    appendJsonl(messageLogPath(manager.getChatDir(session)), buildInboundEntry({
      from: PEER_AID,
      to: SELF_AID,
      sessionId: session.id,
      msgId: 'old-in',
      chatType: 'private',
      content: '帮我修复登录问题',
      timestamp: timestamp - 1000,
    }));
    appendJsonl(messageLogPath(manager.getChatDir(session)), buildOutboundEntry({
      from: SELF_AID,
      to: PEER_AID,
      sessionId: session.id,
      msgId: 'old-out',
      chatType: 'private',
      content: '登录问题已经修复',
      timestamp,
    }));
  }

  let calls = 0;
  let listCalls = 0;
  let lastRequest: TextInferenceRequest | undefined;
  const requestedBaseagents: Array<string | undefined> = [];
  const provider: TextInferenceProvider = {
    baseagent: 'claude',
    listModels: async () => {
      listCalls++;
      return options.availableModels ?? [JUDGE_MODEL];
    },
    completeText: async request => {
      calls++;
      lastRequest = request;
      const result = options.modelResult ?? modelDecision('continue', 0.95);
      const delay = options.modelDelayMs ?? 0;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return result;
    },
  };

  const config: SessionRenewConfig = {
    enabled: options.enabled ?? true,
    after_hours: 24,
    fallback_action: 'continue',
    ...options.config,
  };
  const service = new SessionRenewService(manager, { getTextInferenceProvider: (_channel, baseagent) => {
    requestedBaseagents.push(baseagent);
    if (baseagent && options.unavailableBaseagents?.includes(baseagent)) {
      return undefined;
    }
    return provider;
  } }, {
    now: () => NOW,
    resolveConfig: () => config,
  });

  return {
    manager,
    session,
    service,
    modelCalls: () => calls,
    modelListCalls: () => listCalls,
    requestedBaseagents: () => requestedBaseagents,
    lastRequest: () => lastRequest,
    request: (content: string, replyToMessageId?: string, isNewSession?: boolean) => ({
      session,
      channelName: 'main',
      channelType: 'aun',
      channelId: PEER_AID,
      selfAid: SELF_AID,
      peerId: PEER_AID,
      chatType: 'private' as const,
      role: 'owner',
      content,
      replyToMessageId,
      isNewSession,
    }),
  };
}
