import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 真实运行时验证（不 mock 生产代码）：构造真实 MessageProcessor + 真实 SessionManager
// + 真实渲染管线，喂一条合成对端 Message 进 processMessage，断言真实的 consumeOwnerHints
// 接线把 owner 提示消费并注入到喂给 runQuery 的 prompt。不连 LLM（用捕获式 fake runner）、
// 不连 AUN 网关。这覆盖了纯函数单测覆盖不到的 processMessage 真实接线。

import { EventBus } from '../../src/core/event-bus.js';
import { MessageCache } from '../../src/core/message/message-cache.js';
import { SessionManager } from '../../src/core/session/session-manager.js';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import { appendHintAdd } from '../../src/core/message/pending-hints.js';
import { _resetRoot, resolvePaths } from '../../src/paths.js';
import { ConfigTarget, write } from '../../src/config/config-manager.js';
import { formatPeerKey } from '../../src/core/relation/peer-identity.js';
import type {
  AgentContext, ChannelAdapter, ChannelPolicy, EvolAgentRegistryHandle,
  EvolAgentHandle, GlobalSettings, Message, MergedAgentConfig,
} from '../../src/types.js';
import type { AgentRunnerFull, AgentEvent } from '../../src/agents/claude-runner.js';

const SELF = 'agent.agentid.pub';
const PEER = 'peer.agentid.pub';
const OWNER = 'owner.agentid.pub';
const CH = 'aun_main';

let home: string;
let captured: { prompt?: string; systemPrompt?: string };

// ── 捕获式 fake runner：不调 LLM，记录 runQuery 收到的 prompt，返回即时结束的流 ──
function makeRunner(): AgentRunnerFull {
  const noop = () => {};
  const runner: Partial<AgentRunnerFull> = {
    name: 'claude',
    capabilities: { clear: true, compact: true, fork: true },
    async runQuery(_sid: string, prompt: string, _pp, _asid, _imgs, systemPromptAppend?: string) {
      captured.prompt = prompt;
      captured.systemPrompt = systemPromptAppend;
      async function* empty(): AsyncIterable<AgentEvent> {
        yield { type: 'complete', result: '', isError: false, terminalReason: 'end_turn', numTurns: 1 } as AgentEvent;
      }
      return empty();
    },
    registerStream: noop,
    cleanupStream: noop,
    hasActiveStream: () => false,
    updateSessionId: noop,
    setSendPrompt: noop,
    setMode: noop,
    getMode: () => 'default',
  };
  return runner as AgentRunnerFull;
}

// ── 最小真实 channel adapter（捕获出站，不真发） ──
function makeAdapter(): ChannelAdapter {
  return {
    channelName: CH,
    channelKey: `aun#${SELF}#main`,
    capabilities: { images: false } as any,
    async send() { /* 捕获出站：本测试不校验出站 */ },
    async acknowledge() {},
  } as unknown as ChannelAdapter;
}

const allowAll: ChannelPolicy = {
  canSwitchProject: () => true, canListProjects: () => true,
  canCreateSession: () => true, canDeleteSession: () => true,
  canImportCliSession: () => true,
  messagePrefix: () => '',
  showMiddleResult: () => false, showIdleMonitor: () => false,
  accumulateErrors: () => false,
};

// ── 最小真实 agentRegistry handle ──
function makeRegistry(): EvolAgentRegistryHandle {
  const config = { $schema_version: 1, aid: SELF } as unknown as MergedAgentConfig;
  const handle: Partial<EvolAgentHandle> = {
    name: 'agent', baseagent: 'claude', projectPath: process.cwd(), config,
    getContext: (_c, chatType): AgentContext => ({
      name: 'agent', isOwned: true, baseagent: 'claude',
      chatMode: 'interactive', projectPath: process.cwd(),
    }),
    getOwner: () => OWNER,
    isOwner: (_c, u) => u === OWNER,
    isAdmin: () => false,
    getObservable: () => true,
  };
  return {
    resolveByChannel: () => handle as EvolAgentHandle,
    get: () => handle as EvolAgentHandle,
    list: () => [],
    isOwner: (_c, u) => u === OWNER,
    isAdmin: () => false,
    getOwner: () => OWNER,
    setChannelOwner: () => {},
    getShowActivities: () => 'none',
    setShowActivities: () => {},
  };
}

function makeProcessor(): MessageProcessor {
  const eventBus = new EventBus();
  const sm = new SessionManager(resolvePaths().sessionsDir, eventBus);
  const settings: GlobalSettings = { idleMonitor: { enabled: false } };
  const proc = new MessageProcessor(makeRunner(), sm, settings, new MessageCache(), eventBus);
  proc.setAgentRegistry(makeRegistry());
  proc.registerChannel(makeAdapter(), allowAll, { channelType: 'aun' });
  return proc;
}

function peerMessage(content: string, threadId?: string): Message {
  return {
    channel: CH, channelType: 'aun', channelId: PEER, selfAID: SELF,
    peerId: PEER, peerType: 'human', chatType: 'private',
    content, timestamp: Date.now(), threadId: threadId ?? '',
    messageId: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'evolclaw-rt-'));
  process.env.EVOLCLAW_HOME = home;
  _resetRoot();
  fs.mkdirSync(resolvePaths().sessionsDir, { recursive: true });
  write(ConfigTarget.Agent, {
    aid: SELF,
    owners: [OWNER],
    channels: [],
  }, { self: SELF });
  write(ConfigTarget.Relation, {
    roles: { assigned: 'member' },
  }, { self: SELF, peerKey: formatPeerKey('aun', PEER) });
  captured = {};
});
afterEach(() => {
  delete process.env.EVOLCLAW_HOME;
  _resetRoot();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('真实运行时：owner 提示经 processMessage 注入 prompt', () => {
  it('seeded pending-hint is consumed and injected into the real runQuery prompt', async () => {
    // 1) 真实落盘一条 owner 提示到 agent↔对端 会话
    appendHintAdd(resolvePaths().sessionsDir, 'aun', PEER, SELF, {
      id: 'h1', text: '这个人是重要客户，语气客气些', ownerAid: OWNER, ts: Date.now(),
    });

    // 2) 真实驱动 processMessage（对端发来一条消息）
    await makeProcessor().processMessage(peerMessage('在吗？想问个事'));

    // 3) 断言：喂给 runQuery 的真实 prompt 同时含 owner 提示 + 对端原文，且提示在前
    expect(captured.prompt).toBeDefined();
    expect(captured.prompt).toContain('这个人是重要客户，语气客气些');
    expect(captured.prompt).toContain('在吗？想问个事');
    expect(captured.prompt!.indexOf('这个人是重要客户'))
      .toBeLessThan(captured.prompt!.indexOf('在吗？想问个事'));
    // inject 信封头标注（来自真实渲染管线）
    expect(captured.prompt).toContain('owner');

    // 4) 一次性：提示文件已被真实消费删除
    const fp = path.join(resolvePaths().sessionsDir, 'aun', encodeURIComponent(SELF), encodeURIComponent(PEER), 'pending-hints.jsonl');
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('no pending-hint → prompt has peer text only, no owner header', async () => {
    await makeProcessor().processMessage(peerMessage('普通消息'));
    expect(captured.prompt).toBeDefined();
    expect(captured.prompt).toContain('普通消息');
    expect(captured.prompt).not.toContain('owner 提示');
  });

  it('hint on a different thread is NOT consumed by a main-thread message', async () => {
    appendHintAdd(resolvePaths().sessionsDir, 'aun', PEER, SELF, {
      id: 'h1', text: 'THREAD-A-ONLY', threadId: 'A', ownerAid: OWNER, ts: Date.now(),
    });
    await makeProcessor().processMessage(peerMessage('主线程消息'));  // threadId ''
    expect(captured.prompt).toContain('主线程消息');
    expect(captured.prompt).not.toContain('THREAD-A-ONLY');
  });
});

