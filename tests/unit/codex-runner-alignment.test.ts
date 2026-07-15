import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  CodexRunner,
  isCodexCliVersionSupported,
  MIN_CODEX_CLI_VERSION,
  parseCodexCliVersion,
} from '../../src/agents/codex-runner.js';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import { IMRenderer } from '../../src/core/message/im-renderer.js';
import { EventBus } from '../../src/core/event-bus.js';
import { InteractionRouter } from '../../src/core/interaction-router.js';
import { resolvePaths } from '../../src/paths.js';
import { fileCache } from '../../src/core/daemon-file-cache.js';
import type { OutboundEnvelope, OutboundPayload } from '../../src/types.js';
import { AgentRunner as ClaudeRunner } from '../../src/agents/claude-runner.js';
import { GeminiRunner } from '../../src/agents/gemini-runner.js';
import { AGENT_DELEGATION_TOKEN_ENV } from '../../src/core/auth/agent-delegation.js';

function makeRunner() {
  const runner = new CodexRunner({ agents: { codex: { apiKey: 'test-key', model: 'gpt-5.4', effort: 'high' } } } as any, { onSessionIdUpdate: vi.fn() } as any);
  const notificationHandlers = new Set<(notification: any) => void>();
  const emitNotification = (notification: any) => {
    for (const handler of notificationHandlers) handler(notification);
  };
  const appServer = {
    modelList: vi.fn().mockResolvedValue({ data: [{ id: 'gpt-5.5' }, { slug: 'gpt-5.4' }] }),
    threadCompactStart: vi.fn(async (threadId: string) => {
      queueMicrotask(() => emitNotification({ method: 'thread/compacted', params: { threadId, turnId: 'compact-turn' } }));
      return true;
    }),
    threadResume: vi.fn().mockResolvedValue({ thread: { id: 'thread-1' } }),
    threadFork: vi.fn().mockResolvedValue({ thread: { id: 'forked-thread' } }),
    threadSetName: vi.fn().mockResolvedValue(true),
    threadMetadataUpdate: vi.fn().mockResolvedValue(true),
    turnInterrupt: vi.fn().mockResolvedValue(true),
    threadRead: vi.fn(),
    onNotification: vi.fn((handler: (notification: any) => void) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    }),
  };
  (runner as any).getAppServerClient = () => appServer;
  (runner as any).threadProjectPaths.set('thread-1', '/repo');
  (runner as any).threadExternalToolFingerprints.set('thread-1', 'test-external-config');
  return { runner, appServer, emitNotification };
}

describe('IMRenderer Codex streaming newline preservation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not trim Markdown block newlines during non-final timer flushes', async () => {
    const sent: OutboundPayload[] = [];
    const envelope: OutboundEnvelope = {
      taskId: 'task-test',
      channel: 'feishu',
      channelId: 'chat-1',
      agentName: 'bot',
      chatmode: 'interactive',
      timestamp: Date.now(),
    };
    const renderer = new IMRenderer({
      adapter: {
        channelName: 'feishu',
        capabilities: { file: false, image: false, interaction: false, markdown: true, thought: false, status: false },
        send: vi.fn(),
      } as any,
      envelope,
      flushDelay: 0,
      suppressActivities: false,
      send: async (payload) => { sent.push(payload); },
    });

    renderer.addText('按三类重新排版如下。\n\n');
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    renderer.addText('**可直接执行**\n\n');
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    await Promise.resolve();

    renderer.addText('- Codex 权限白名单补齐');
    await renderer.flush(true);

    const textPayloads = sent.filter((payload): payload is Extract<OutboundPayload, { kind: 'result.text' }> =>
      payload.kind === 'result.text'
    );
    expect(textPayloads.map(payload => ({ text: payload.text, isFinal: payload.isFinal }))).toEqual([
      { text: '按三类重新排版如下。\n\n', isFinal: false },
      { text: '**可直接执行**\n\n', isFinal: false },
      { text: '- Codex 权限白名单补齐', isFinal: true },
    ]);
  });
});

describe('CodexRunner Claude alignment capabilities', () => {
  it('propagates per-task delegation through Claude, Codex, and Gemini environments', () => {
    const runtimeEnv = { [AGENT_DELEGATION_TOKEN_ENV]: 'delegation-token' };

    const claude = new ClaudeRunner('test-key');
    expect((claude as any).getAgentEnv(runtimeEnv)[AGENT_DELEGATION_TOKEN_ENV]).toBe('delegation-token');

    const { runner: codex } = makeRunner();
    const codexConfig = (codex as any).mergeThreadConfig(
      (codex as any).buildEvolclawShellEnvironmentConfig('session-1'),
      { shell_environment_policy: { set: runtimeEnv } },
    );
    expect(codexConfig.shell_environment_policy.set).toMatchObject({
      EVOLCLAW_SESSION_ID: 'session-1',
      [AGENT_DELEGATION_TOKEN_ENV]: 'delegation-token',
    });

    const gemini = new GeminiRunner({
      agents: { gemini: { apiKey: 'test-key', cliPath: 'gemini' } },
    } as any, { onSessionIdUpdate: vi.fn() } as any);
    expect((gemini as any).buildAgentEnv('session-1', runtimeEnv)).toMatchObject({
      EVOLCLAW_SESSION_ID: 'session-1',
      [AGENT_DELEGATION_TOKEN_ENV]: 'delegation-token',
    });
  });

  it('advertises compact and fork support', () => {
    const { runner } = makeRunner();
    expect(runner.getMode()).toBe('readonly');
    expect(runner.capabilities.compact).toBe(true);
    expect(runner.capabilities.fork).toBe(true);
    expect(runner.capabilities.askUserQuestion).toBe(true);
    expect(runner.capabilities.planApproval).toBe(false);
    expect(runner.capabilities.fileRewind).toBe('git-head');
    expect(runner.listModes().map(mode => mode.key)).toContain('readonly');
  });

  it('allows requestUserInput support to be explicitly disabled', () => {
    const runner = new CodexRunner({
      agents: {
        codex: {
          apiKey: 'test-key',
          model: 'gpt-5.4',
          enableRequestUserInput: false,
        },
      },
    } as any, { onSessionIdUpdate: vi.fn() } as any);
    expect(runner.capabilities.askUserQuestion).toBe(false);
  });

  it('parses and enforces the minimum Codex CLI version for the audited permission protocol', () => {
    expect(MIN_CODEX_CLI_VERSION).toBe('0.144.1');
    expect(parseCodexCliVersion('codex-cli 0.137.0')).toBe('0.137.0');
    expect(parseCodexCliVersion('WARNING: noisy\ncodex-cli 0.144.1')).toBe('0.144.1');
    expect(isCodexCliVersionSupported('0.144.0')).toBe(false);
    expect(isCodexCliVersionSupported('0.144.1')).toBe(true);
    expect(isCodexCliVersionSupported('0.145.0')).toBe(true);
  });

  it('keeps lossy Codex permission profile names bound to the original session id', () => {
    const { runner } = makeRunner();
    const profileName = (sessionId: string) => (runner as any).permissionProfileName(sessionId) as string;

    expect(profileName('safe-session_1')).toBe('__evolclaw_safe-session_1_hclass_v1');
    expect(profileName('a/b')).not.toBe(profileName('a?b'));
    expect(profileName('a/b')).not.toBe(profileName('a_b'));

    const sharedPrefix = 'x'.repeat(80);
    expect(profileName(`${sharedPrefix}-one`)).not.toBe(profileName(`${sharedPrefix}-two`));
    expect(profileName('a/b')).toMatch(/^__evolclaw_[A-Za-z0-9_-]+_hclass_v1$/);
  });

  it('forces Codex lifecycle hooks off after all capability config merges', () => {
    const { runner } = makeRunner();
    const config = (runner as any).mergeThreadConfig(
      { features: { hooks: true, multi_agent: true } },
      (runner as any).buildLifecycleLockdownConfig(),
    );

    expect(config.features).toEqual({ hooks: false, multi_agent: true });
  });

  it('forces remote MCP/apps through prompts and disables local MCP process transports', () => {
    const { runner } = makeRunner();
    const config = (runner as any).buildExternalToolApprovalConfig({
      mcp_servers: {
        remote: {
          url: 'https://mcp.example.test',
          environment_id: 'local',
          tool_timeout_sec: null,
          default_tools_approval_mode: 'approve',
          tools: { mutate: { approval_mode: 'approve' } },
        },
        local: {
          command: 'node',
          args: ['server.js'],
          env_vars: ['TOKEN'],
          environment_id: 'local',
          tool_timeout_sec: null,
          enabled: true,
        },
      },
      apps: {
        drive: {
          approvals_reviewer: 'auto_review',
          default_tools_approval_mode: 'approve',
          tools: { delete: { approval_mode: 'approve' } },
        },
      },
      plugins: {
        formatter: {
          mcp_servers: { helper: { default_tools_approval_mode: 'approve' } },
        },
      },
    }, {}, {}, 'request');

    expect(config).toMatchObject({
      mcp_servers: {
        remote: {
          url: 'https://mcp.example.test',
          default_tools_approval_mode: 'prompt',
          tools: { mutate: { approval_mode: 'prompt' } },
        },
        local: { command: 'node', args: ['server.js'], env_vars: ['TOKEN'], enabled: false },
      },
      apps: {
        _default: { approvals_reviewer: 'user', default_tools_approval_mode: 'prompt' },
        drive: {
          approvals_reviewer: 'user',
          default_tools_approval_mode: 'prompt',
          tools: { delete: { approval_mode: 'prompt' } },
        },
      },
      plugins: {
        formatter: {
          mcp_servers: {
            helper: { enabled: false },
          },
        },
      },
    });
    expect((config as any).mcp_servers.remote).not.toHaveProperty('environment_id');
    expect((config as any).mcp_servers.remote).not.toHaveProperty('tool_timeout_sec');
    expect((config as any).mcp_servers.local).not.toHaveProperty('environment_id');
    expect((config as any).mcp_servers.local).not.toHaveProperty('tool_timeout_sec');
  });

  it.each(['readonly', 'auto'])('disables remote MCP and apps at lifecycle level in %s mode', (mode) => {
    const { runner } = makeRunner();
    const config = (runner as any).buildExternalToolApprovalConfig({
      mcp_servers: { remote: { url: 'https://mcp.example.test', enabled: true } },
      apps: { drive: { enabled: true } },
    }, {}, {}, mode);

    expect(config).toMatchObject({
      mcp_servers: { remote: { url: 'https://mcp.example.test', enabled: false } },
      apps: {
        _default: { enabled: false, approvals_reviewer: 'user', default_tools_approval_mode: 'prompt' },
        drive: { enabled: false, approvals_reviewer: 'user', default_tools_approval_mode: 'prompt' },
      },
    });
  });

  it('discovers installed plugin MCP servers and disables them before thread start', async () => {
    const { runner } = makeRunner();
    const appServer = {
      configRead: vi.fn().mockResolvedValue({
        config: {
          mcp_servers: {
            local: { command: 'node', args: ['server.js'], enabled: true },
          },
        },
      }),
      pluginInstalled: vi.fn().mockResolvedValue({
        marketplaces: [{
          name: 'tools',
          path: '/marketplace.json',
          plugins: [{ id: 'formatter@tools', name: 'formatter', installed: true, enabled: true }],
        }],
      }),
      pluginRead: vi.fn().mockResolvedValue({ plugin: { mcpServers: ['helper'] } }),
    };

    await expect((runner as any).resolveExternalToolApprovalConfig(appServer, '/repo', {}, 'request'))
      .resolves.toMatchObject({
        mcp_servers: {
          local: { command: 'node', args: ['server.js'], enabled: false },
        },
        plugins: {
          'formatter@tools': { mcp_servers: { helper: { enabled: false } } },
        },
      });
    expect(appServer.pluginInstalled).toHaveBeenCalledWith('/repo');
    expect(appServer.pluginRead).toHaveBeenCalledWith('formatter', {
      name: 'tools',
      path: '/marketplace.json',
    });
  });

  it('uses app-server for model listing with fallback-capable ids', async () => {
    const { runner, appServer } = makeRunner();
    await expect(runner.listModels()).resolves.toEqual(['gpt-5.5', 'gpt-5.4']);
    expect(appServer.modelList).toHaveBeenCalledWith(false);
  });

  it('uses app-server for compact, fork, title, and metadata sync', async () => {
    const { runner, appServer } = makeRunner();
    runner.setMode('bypass');
    const onCompactStart = vi.fn();
    runner.setCompactStartCallback(onCompactStart);

    await expect(runner.compactSession('sess-1', 'thread-1', '/repo')).resolves.toBe(true);
    await expect(runner.forkSession('thread-1', '/repo', 'fork name')).resolves.toBe('forked-thread');
    await expect(runner.setSessionName('thread-1', 'new name')).resolves.toBe(true);
    await expect(runner.updateSessionMetadata('thread-1', { gitInfo: { branch: 'main' } })).resolves.toBe(true);

    expect(onCompactStart).toHaveBeenCalledWith('sess-1');
    expect(appServer.threadCompactStart).toHaveBeenCalledWith('thread-1');
    expect(appServer.threadFork).toHaveBeenCalledWith('thread-1', '/repo', 'fork name', expect.objectContaining({
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      permissions: '__evolclaw_thread-1_hclass_v1',
      config: expect.objectContaining({
        features: { hooks: false },
        default_permissions: '__evolclaw_thread-1_hclass_v1',
        permissions: expect.objectContaining({
          '__evolclaw_thread-1_hclass_v1': expect.objectContaining({ extends: ':workspace' }),
        }),
      }),
    }));
    expect(appServer.threadSetName).toHaveBeenCalledWith('thread-1', 'new name');
    expect(appServer.threadMetadataUpdate).toHaveBeenCalledWith('thread-1', { branch: 'main' });
  });

  it('does not finish manual compact until thread/compacted arrives', async () => {
    const { runner, appServer, emitNotification } = makeRunner();
    appServer.threadCompactStart.mockResolvedValueOnce(true);

    let resolved = false;
    const compact = runner.compactSession('sess-1', 'thread-1', '/repo').then(value => {
      resolved = true;
      return value;
    });
    await vi.waitFor(() => expect(appServer.threadCompactStart).toHaveBeenCalledWith('thread-1'));
    await Promise.resolve();

    expect(resolved).toBe(false);

    emitNotification({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'compact-turn' } });

    await expect(compact).resolves.toBe(true);
    expect(resolved).toBe(true);
  });

  it('finishes manual compact when Codex session log records completion', async () => {
    const { runner, appServer } = makeRunner();
    appServer.threadCompactStart.mockResolvedValueOnce(true);
    const persisted = vi.spyOn(runner as any, 'hasPersistedCompactCompletion')
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    const compact = runner.compactSession('sess-1', 'thread-1', '/repo');
    await vi.waitFor(() => expect(appServer.threadCompactStart).toHaveBeenCalledWith('thread-1'));

    await expect(compact).resolves.toBe(true);
    expect(persisted).toHaveBeenCalledWith('thread-1', expect.any(Number));
  });

  it('resumes stale Codex app-server threads before compacting after restart', async () => {
    const { runner, appServer, emitNotification } = makeRunner();
    const onCompactStart = vi.fn();
    runner.setCompactStartCallback(onCompactStart);
    appServer.threadCompactStart
      .mockRejectedValueOnce(new Error('thread/compact/start failed: thread not found: thread-1'))
      .mockImplementationOnce(async (threadId: string) => {
        queueMicrotask(() => emitNotification({ method: 'thread/compacted', params: { threadId, turnId: 'compact-turn' } }));
        return true;
      });

    await expect(runner.compactSession('sess-1', 'thread-1', '/repo')).resolves.toBe(true);

    expect(onCompactStart).toHaveBeenCalledTimes(1);
    expect(appServer.threadResume).toHaveBeenCalledWith('thread-1', '/repo', expect.objectContaining({
      model: 'gpt-5.4',
      effort: 'high',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      permissions: '__evolclaw_sess-1_hclass_v1',
      config: expect.objectContaining({
        features: { hooks: false },
        default_permissions: '__evolclaw_sess-1_hclass_v1',
        permissions: expect.objectContaining({
          '__evolclaw_sess-1_hclass_v1': expect.objectContaining({ extends: ':read-only' }),
        }),
      }),
    }));
    expect(appServer.threadResume.mock.calls[0][2]).not.toHaveProperty('sandbox');
    expect(appServer.threadCompactStart).toHaveBeenCalledTimes(2);
  });

  it('requests app-server turn interrupt when active turn is known', async () => {
    const { runner, appServer } = makeRunner();
    (runner as any).activeAbortControllers.set('sess-1', new AbortController());
    (runner as any).activeStreams.set('sess-1', {});
    (runner as any).activeTurns.set('sess-1', { threadId: 'thread-1', turnId: 'turn-1' });

    await runner.interrupt('sess-1');

    expect(appServer.turnInterrupt).toHaveBeenCalledWith('thread-1', 'turn-1');
    expect((runner as any).activeTurns.has('sess-1')).toBe(false);
  });

  it('treats abort controllers and active turns as active stream state', () => {
    const { runner } = makeRunner();
    expect(runner.hasActiveStream('sess-1')).toBe(false);

    (runner as any).activeAbortControllers.set('sess-1', new AbortController());
    expect(runner.hasActiveStream('sess-1')).toBe(true);

    (runner as any).activeAbortControllers.delete('sess-1');
    (runner as any).activeTurns.set('sess-1', { threadId: 'thread-1', turnId: 'turn-1' });
    expect(runner.hasActiveStream('sess-1')).toBe(true);
  });

  it('requests app-server turn interrupt even before stream registration', async () => {
    const { runner, appServer } = makeRunner();
    (runner as any).activeTurns.set('sess-1', { threadId: 'thread-1', turnId: 'turn-1' });

    await runner.interrupt('sess-1');

    expect(appServer.turnInterrupt).toHaveBeenCalledWith('thread-1', 'turn-1');
    expect((runner as any).activeTurns.has('sess-1')).toBe(false);
  });

  it('keeps Codex auto approval callbacks reachable with a named workspace profile', async () => {
    const runner = new CodexRunner({ agents: { codex: { apiKey: 'test-key', model: 'gpt-5.4' } } } as any, { onSessionIdUpdate: vi.fn() } as any);
    const appServer = {
      threadStart: vi.fn().mockResolvedValue({ thread: { id: 'thread-1' } }),
      onNotification: vi.fn().mockReturnValue(() => {}),
      turnStart: vi.fn().mockResolvedValue({ turn: { id: 'turn-1', status: 'completed' } }),
    };
    (runner as any).getAppServerClient = () => appServer;
    runner.setMode('auto');

    const events: any[] = [];
    const stream = await runner.runQuery('sess-1', 'hello', '/repo');
    for await (const event of stream) events.push(event);

    expect(appServer.threadStart).toHaveBeenCalledWith('/repo', expect.objectContaining({
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      permissions: '__evolclaw_sess-1_hclass_v1',
      config: expect.objectContaining({
        features: { hooks: false },
        default_permissions: '__evolclaw_sess-1_hclass_v1',
        permissions: expect.objectContaining({
          '__evolclaw_sess-1_hclass_v1': expect.objectContaining({ extends: ':workspace' }),
        }),
      }),
    }));
    expect(appServer.turnStart).toHaveBeenCalledWith('thread-1', expect.anything(), expect.objectContaining({
      approvalPolicy: 'untrusted',
      permissions: '__evolclaw_sess-1_hclass_v1',
    }));
    expect(appServer.threadStart.mock.calls[0][1]).not.toHaveProperty('sandbox');
    expect(appServer.turnStart.mock.calls[0][2]).not.toHaveProperty('sandbox');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'complete', subtype: 'success' }),
    ]));
  });

  it('passes EvolClaw session environment through Codex thread config', async () => {
    const runner = new CodexRunner({ agents: { codex: { apiKey: 'test-key', model: 'gpt-5.4' } } } as any, { onSessionIdUpdate: vi.fn() } as any);
    const appServer = {
      threadStart: vi.fn().mockResolvedValue({ thread: { id: 'thread-1' } }),
      threadResume: vi.fn().mockResolvedValue({ thread: { id: 'thread-2' } }),
      onNotification: vi.fn().mockReturnValue(() => {}),
      turnStart: vi.fn().mockResolvedValue({ turn: { id: 'turn-1', status: 'completed' } }),
    };
    (runner as any).getAppServerClient = () => appServer;

    const stream = await runner.runQuery('sess-env-1', 'hello', '/repo');
    for await (const _event of stream) {
      // consume stream
    }

    expect(appServer.threadStart).toHaveBeenCalledWith('/repo', expect.objectContaining({
      config: expect.objectContaining({
        shell_environment_policy: {
          set: {
            EVOLCLAW_SESSION_ID: 'sess-env-1',
            EVOLCLAW_HOME: expect.any(String),
          },
        },
      }),
    }));

    const resumedStream = await runner.runQuery('sess-env-2', 'hello again', '/repo', 'thread-existing');
    for await (const _event of resumedStream) {
      // consume stream
    }

    expect(appServer.threadResume).toHaveBeenCalledWith('thread-existing', '/repo', expect.objectContaining({
      config: expect.objectContaining({
        shell_environment_policy: {
          set: {
            EVOLCLAW_SESSION_ID: 'sess-env-2',
            EVOLCLAW_HOME: expect.any(String),
          },
        },
      }),
    }));
  });

  it('forces Codex approvalsReviewer=user so auto_review cannot bypass EvolClaw', async () => {
    const runner = new CodexRunner({
      agents: {
        codex: {
          apiKey: 'test-key',
          model: 'gpt-5.4',
          approvalsReviewer: 'auto_review',
        },
      },
    } as any, { onSessionIdUpdate: vi.fn() } as any);
    const appServer = {
      threadStart: vi.fn().mockResolvedValue({ thread: { id: 'thread-1' } }),
      onNotification: vi.fn().mockReturnValue(() => {}),
      turnStart: vi.fn().mockResolvedValue({ turn: { id: 'turn-1', status: 'completed' } }),
    };
    (runner as any).getAppServerClient = () => appServer;

    const stream = await runner.runQuery('sess-1', 'hello', '/repo');
    for await (const _event of stream) {
      // consume stream
    }

    expect(appServer.threadStart).toHaveBeenCalledWith('/repo', expect.objectContaining({
      approvalsReviewer: 'user',
    }));
  });

  it('uses named Codex profiles for request and readonly modes', async () => {
    for (const mode of ['request', 'readonly']) {
      const runner = new CodexRunner({ agents: { codex: { apiKey: 'test-key', model: 'gpt-5.4' } } } as any, { onSessionIdUpdate: vi.fn() } as any);
      const appServer = {
        threadStart: vi.fn().mockResolvedValue({ thread: { id: `thread-${mode}` } }),
        onNotification: vi.fn().mockReturnValue(() => {}),
        turnStart: vi.fn().mockResolvedValue({ turn: { id: `turn-${mode}`, status: 'completed' } }),
      };
      (runner as any).getAppServerClient = () => appServer;
      runner.setMode(mode);

      const stream = await runner.runQuery(`sess-${mode}`, 'hello', '/repo');
      for await (const _event of stream) {
        // drain stream
      }

      const profile = `__evolclaw_sess-${mode}_hclass_v1`;
      const expectedParent = mode === 'request' ? ':workspace' : ':read-only';
      const expectedApproval = 'untrusted';
      expect(appServer.threadStart).toHaveBeenCalledWith('/repo', expect.objectContaining({
        approvalPolicy: expectedApproval,
        permissions: profile,
        config: expect.objectContaining({
          default_permissions: profile,
          permissions: expect.objectContaining({
            [profile]: expect.objectContaining({ extends: expectedParent }),
          }),
        }),
      }));
      expect(appServer.turnStart).toHaveBeenCalledWith(`thread-${mode}`, expect.anything(), expect.objectContaining({
        approvalPolicy: expectedApproval,
        permissions: profile,
      }));
      expect(appServer.threadStart.mock.calls[0][1]).not.toHaveProperty('sandbox');
      expect(appServer.turnStart.mock.calls[0][2]).not.toHaveProperty('sandbox');
    }
  });
});

describe('CodexRunner app-server turn notification filtering', () => {
  it('ignores stale resumed-turn notifications before latching the new turn', async () => {
    const runner = new CodexRunner({ agents: { codex: { apiKey: 'test-key', model: 'gpt-5.4' } } } as any, { onSessionIdUpdate: vi.fn() } as any);
    const handlers = new Set<(notification: any) => void>();
    const appServer = {
      threadResume: vi.fn().mockResolvedValue({ thread: { id: 'thread-1' } }),
      onNotification: vi.fn((handler: (notification: any) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      }),
      turnStart: vi.fn().mockImplementation(async (threadId: string) => {
        for (const handler of handlers) {
          handler({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'old-turn', tokenUsage: { last: { inputTokens: 1, outputTokens: 2 } } } });
          handler({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'old-turn', itemId: 'old-msg', delta: 'stale' } });
          handler({ method: 'item/completed', params: { threadId, turnId: 'old-turn', item: { type: 'agentMessage', id: 'old-msg', text: 'stale' } } });
          handler({ method: 'turn/completed', params: { threadId, turn: { id: 'old-turn', status: 'completed' } } });
          handler({ method: 'turn/started', params: { threadId, turn: { id: 'new-turn' } } });
          handler({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'new-turn', itemId: 'new-msg', delta: 'fr' } });
          handler({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'new-turn', itemId: 'new-msg', delta: 'esh' } });
          handler({ method: 'item/completed', params: { threadId, turnId: 'new-turn', item: { type: 'agentMessage', id: 'new-msg', text: 'fresh' } } });
          handler({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'new-turn', tokenUsage: { last: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3 } } } });
          handler({ method: 'turn/completed', params: { threadId, turn: { id: 'new-turn', status: 'completed', durationMs: 5, ttftMs: 7, totalCostUsd: 0.01, sessionTitle: 'Follow up', numTurns: 2 } } });
        }
        return { turn: { id: 'new-turn', status: 'inProgress' } };
      }),
    };
    (runner as any).getAppServerClient = () => appServer;

    const events: any[] = [];
    const stream = await runner.runQuery('sess-1', 'follow up', '/repo', 'thread-1');
    for await (const event of stream) events.push(event);

    expect(events).toEqual(expect.arrayContaining([
      { type: 'session_id', sessionId: 'thread-1' },
      { type: 'state_changed', state: 'running' },
      { type: 'text', text: 'fresh' },
      expect.objectContaining({
        type: 'complete',
        subtype: 'success',
        durationMs: 5,
        ttftMs: 7,
        costUsd: 0.01,
        sessionTitle: 'Follow up',
        numTurns: 2,
        tokenUsage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: undefined },
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([{ type: 'text', text: 'stale' }]));
    expect((runner as any).activeTurns.has('sess-1')).toBe(false);
  });
});

describe('CodexRunner file change event mapping', () => {
  it('maps app-server thread/compacted notifications to compact events', () => {
    const { runner } = makeRunner();
    const state = {
      threadId: 'thread-1',
      streamedAgentMessageIds: new Set(),
      agentMessageDeltaText: new Map(),
      completedItemIds: new Set(),
      completedTurnIds: new Set(),
    };

    const events = Array.from((runner as any).mapAppServerNotification({
      method: 'thread/compacted',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }, 'sess-1', state));

    expect(events).toEqual([{ type: 'compact', preTokens: 0 }]);
  });

  it('renders object-shaped file change kinds without [object Object]', () => {
    const { runner } = makeRunner();

    const events = Array.from((runner as any).mapAppServerItemStarted({
      type: 'fileChange',
      id: 'file-1',
      changes: [
        { kind: { type: 'create' }, path: '/home/evolclaw/.evolclaw/tmp/readonly-check.txt' },
        { type: { kind: 'update' }, path: 'src/index.ts' },
      ],
    }));

    expect(events).toEqual([{
      type: 'tool_use',
      name: 'FileChange',
      input: {
        description: 'create /home/evolclaw/.evolclaw/tmp/readonly-check.txt, update src/index.ts',
      },
      callId: 'file-1',
    }]);
    expect((events[0] as any).input.description).not.toContain('[object Object]');
  });

  it('normalizes object-map file changes for session history', () => {
    const { runner } = makeRunner();

    const content = (runner as any).mapFileChangeToContent({
      type: 'file_change',
      changes: {
        '.evolclaw/tmp/report.txt': { kind: { action: 'create' } },
      },
    });

    expect(content).toEqual([{
      type: 'file_change',
      path: '.evolclaw/tmp/report.txt',
      kind: 'create',
    }]);
  });
});

describe('CodexRunner rewind file mapping', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rewind-'));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'original');
    execFileSync('git', ['add', 'a.txt'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tempDir, 'a.txt'), 'changed');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores files recorded by Codex file_change items', async () => {
    const { runner, appServer } = makeRunner();
    appServer.threadRead.mockResolvedValue({
      thread: {
        id: 'thread-1',
        turns: [{
          id: 'turn-1',
          items: [
            { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'edit file' }] },
            { type: 'file_change', id: 'f1', changes: [{ path: 'a.txt', kind: 'update' }] },
            { type: 'agentMessage', id: 'a1', text: 'done' },
          ],
        }],
      },
    });

    await expect(runner.rewindFiles('thread-1', tempDir, 'u1')).resolves.toEqual({
      canRewind: true,
      filesChanged: ['a.txt'],
    });
    expect(fs.readFileSync(path.join(tempDir, 'a.txt'), 'utf8')).toBe('original');
  });
});

describe('CodexRunner app-server approval bridge', () => {
  it('auto-approves safe Bash commands after local safety filters', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'npm test' },
    });

    expect(result).toEqual({ decision: 'accept' });
  });

  it('auto-approves concrete file changes inside the workspace in auto mode', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-file-auto',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-1',
        fileChanges: [{ path: 'src/index.ts', kind: { type: 'update' }, diff: 'diff' }],
      },
    });

    expect(result).toEqual({ decision: 'accept' });
  });

  it('denies out-of-workspace file-change expansion in auto mode', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-file-auto-outside',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-outside',
        fileChanges: [{ path: '../outside.ts', kind: { type: 'update' }, diff: 'diff' }],
      },
    });

    expect(result).toEqual({ decision: 'decline' });
  });

  it('uses the tracked thread workspace instead of an untrusted approval cwd', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');
    (runner as any).threadProjectPaths.set('thread-1', '/repo');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-file-cwd-confusion',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-cwd-confusion',
        cwd: '/outside',
        fileChanges: [{ path: '/outside/escaped.ts', kind: { type: 'update' }, diff: 'diff' }],
      },
    });

    expect(result).toEqual({ decision: 'decline' });
  });

  it('fails closed when an approval references an untracked thread and forged projectPath', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');
    (runner as any).threadProjectPaths.delete('thread-1');

    await expect((runner as any).handleAppServerRequest({
      id: 'req-file-unknown-thread',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        projectPath: '/forged-workspace',
        fileChanges: [{ path: '/forged-workspace/escaped.ts', kind: { type: 'create' }, diff: 'diff' }],
      },
    })).resolves.toEqual({ decision: 'decline' });
  });

  it('denies a file change that escapes the workspace through a symlink', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-workspace-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-outside-'));
    try {
      fs.symlinkSync(outside, path.join(workspace, 'linked-outside'));
      const { runner } = makeRunner();
      runner.setMode('auto');
      (runner as any).threadProjectPaths.set('thread-1', workspace);

      await expect((runner as any).handleAppServerRequest({
        id: 'req-file-symlink-escape',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'file-symlink-escape',
          fileChanges: [{ path: 'linked-outside/escaped.ts', kind: { type: 'create' }, diff: 'diff' }],
        },
      })).resolves.toEqual({ decision: 'decline' });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('denies managed-network expansion in auto mode and preserves its target for bypass approval', async () => {
    const { runner } = makeRunner();
    const networkApprovalContext = { host: 'registry.npmjs.org:443', protocol: 'https' };

    runner.setMode('auto');
    await expect((runner as any).handleAppServerRequest({
      id: 'req-network-auto',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: '', networkApprovalContext },
    })).resolves.toEqual({ decision: 'decline' });

    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode('bypass');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);
    await expect((runner as any).handleAppServerRequest({
      id: 'req-network-bypass',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: '', networkApprovalContext, reason: 'download package' },
    })).resolves.toEqual({ decision: 'accept' });

    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'thread-1',
      'Bash',
      expect.objectContaining({ networkApprovalContext }),
      expect.any(Function),
      undefined,
      '允许网络访问：https://registry.npmjs.org:443',
      'download package',
      'codex:__evolclaw_thread-1_hclass_v1:bypass',
    );
  });

  it('uses the preceding fileChange item for H-class checks when approval params omit changes', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    const projectPath = process.env.EVOLCLAW_HOME!;
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);
    (runner as any).threadProjectPaths.set('thread-1', projectPath);
    (runner as any).trackApprovalItemNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'file-1',
          type: 'fileChange',
          changes: [{ path: 'agents/demo/config.json', kind: { type: 'update' }, diff: 'redacted' }],
        },
      },
    });

    await expect((runner as any).handleAppServerRequest({
      id: 'req-file-hclass',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', reason: 'apply patch' },
    })).resolves.toEqual({ decision: 'decline' });
    expect(gateway.requestPermission).not.toHaveBeenCalled();
  });

  it('routes bypass file-change expansion through the Gateway with the cached target', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode('bypass');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);
    (runner as any).trackApprovalItemNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'file-1',
          type: 'fileChange',
          changes: [{ path: '../outside.ts', kind: { type: 'update' }, diff: 'diff' }],
        },
      },
    });

    await expect((runner as any).handleAppServerRequest({
      id: 'req-file-bypass',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-1', reason: 'outside sandbox' },
    })).resolves.toEqual({ decision: 'accept' });

    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'thread-1',
      'FileChange',
      expect.objectContaining({
        fileChanges: [expect.objectContaining({ path: '../outside.ts' })],
      }),
      expect.any(Function),
      undefined,
      'update ../outside.ts',
      'outside sandbox',
      'codex:__evolclaw_thread-1_hclass_v1:bypass',
    );
  });

  it('fails closed when an approval callback is missing its command or file target', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);

    await expect((runner as any).handleAppServerRequest({
      id: 'req-empty-command',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-missing' },
    })).resolves.toEqual({ decision: 'decline' });
    await expect((runner as any).handleAppServerRequest({
      id: 'req-empty-file',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'file-missing' },
    })).resolves.toEqual({ decision: 'decline' });
    expect(gateway.requestPermission).not.toHaveBeenCalled();
  });

  it('maps the 30-minute EvolClaw grant to a one-shot Codex accept', async () => {
    const { runner } = makeRunner();
    const gateway = {
      requestPermission: vi.fn().mockResolvedValue('always'),
    };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);
    runner.setPermissionContext('sess-1', { channelId: 'chat1' } as any);
    (runner as any).activeSessions.set('sess-1', 'thread-1');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'npm test', reason: 'needs shell' },
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'sess-1',
      'Bash',
      expect.objectContaining({ command: 'npm test' }),
      expect.any(Function),
      expect.objectContaining({ channelId: 'chat1' }),
      'npm test',
      'needs shell',
      'codex:__evolclaw_sess-1_hclass_v1:request',
    );
  });

  it('does not consult a broad tool-wide allow cache', async () => {
    const { runner } = makeRunner();
    const gateway = {
      isAlwaysAllowed: vi.fn().mockReturnValue(true),
      requestPermission: vi.fn().mockResolvedValue('allow'),
    };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'npm test' },
    });

    expect(result).toEqual({ decision: 'accept' });
    expect(gateway.isAlwaysAllowed).not.toHaveBeenCalled();
    expect(gateway.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('maps the legacy noask value to readonly app-server behavior', async () => {
    const { runner } = makeRunner();
    runner.setMode('noask');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', grantRoot: '/repo' },
    });

    expect(result).toEqual({ decision: 'decline' });
  });

  it('allows EvolClaw ctl send/file commands even in restrictive modes', async () => {
    const { runner } = makeRunner();
    runner.setPermissionContext('thread-1', {
      userId: 'owner-1',
      channel: 'control#local',
      channelId: 'owner-1',
      role: 'owner',
      selfAid: 'agent.agentid.pub',
    } as any);
    runner.setMode('readonly');

    await expect((runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'ec ctl send "hello"' },
    })).resolves.toEqual({ decision: 'accept' });

    runner.setMode('readonly');
    await expect((runner as any).handleAppServerRequest({
      id: 'req-2',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'evolclaw ctl file report.txt' },
    })).resolves.toEqual({ decision: 'accept' });
  });

  it('does not whitelist chained ctl commands', async () => {
    const { runner } = makeRunner();
    runner.setMode('readonly');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'ec ctl send "hello" && npm test' },
    });

    expect(result).toEqual({ decision: 'decline' });
  });

  it('blocks dangerous Bash commands before auto approval', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'rm -rf /tmp/example' },
    });

    expect(result).toEqual({ decision: 'decline' });
  });

  it('blocks H-class paths in Bash and FileChange approval requests', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');

    await expect((runner as any).handleAppServerRequest({
      id: 'req-h-bash',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'printf value > agents/demo/config.json' },
    })).resolves.toEqual({ decision: 'decline' });

    await expect((runner as any).handleAppServerRequest({
      id: 'req-h-file',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', fileChanges: { 'agents/demo/config.json': { kind: 'update' } } },
    })).resolves.toEqual({ decision: 'decline' });
  });

  it('auto-denies permission profile escalation', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');
    const permissions = { network: { enabled: true } };

    await expect((runner as any).handleAppServerRequest({
      id: 'req-permissions',
      method: 'item/permissions/requestApproval',
      params: { threadId: 'thread-1', cwd: '/repo', permissions, reason: 'download dependency' },
    })).rejects.toThrow('Permission request denied');
  });

  it('auto-denies additional command permissions instead of treating them as ordinary Bash', async () => {
    const { runner } = makeRunner();
    runner.setMode('auto');

    await expect((runner as any).handleAppServerRequest({
      id: 'req-command-network-auto',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        command: 'npm install',
        additionalPermissions: { network: { enabled: true } },
      },
    })).resolves.toEqual({ decision: 'decline' });
  });

  it('routes bypass command permission expansion through PermissionGateway', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode('bypass');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);

    await expect((runner as any).handleAppServerRequest({
      id: 'req-command-network-bypass',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        command: 'npm install',
        reason: 'registry access',
        additionalPermissions: { network: { enabled: true } },
      },
    })).resolves.toEqual({ decision: 'accept' });
    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'thread-1',
      'Bash',
      expect.objectContaining({
        command: 'npm install',
        additionalPermissions: { network: { enabled: true } },
      }),
      expect.any(Function),
      undefined,
      'npm install',
      'registry access',
      'codex:__evolclaw_thread-1_hclass_v1:bypass',
    );
  });

  it('denies H-class additional command permissions before prompting', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);

    await expect((runner as any).handleAppServerRequest({
      id: 'req-command-hclass',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        cwd: '/home/evolclaw',
        command: 'cat report.txt',
        additionalPermissions: { fileSystem: { read: ['/home/evolclaw/.env'] } },
      },
    })).resolves.toEqual({ decision: 'decline' });
    expect(gateway.requestPermission).not.toHaveBeenCalled();
  });

  it('resolves relative permission grants from the protocol cwd, not the workspace', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    const root = process.env.EVOLCLAW_HOME!;
    const grantCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-grant-cwd-'));
    const protectedFile = path.join(root, '.env');
    const linkedSecret = path.join(grantCwd, 'linked-secret');
    fs.writeFileSync(protectedFile, 'SECRET=value\n');
    fs.symlinkSync(protectedFile, linkedSecret);
    try {
      runner.setMode('request');
      runner.setSendPrompt(vi.fn());
      runner.setPermissionGateway(gateway as any);
      (runner as any).threadProjectPaths.set('thread-1', '/repo');

      await expect((runner as any).handleAppServerRequest({
        id: 'req-relative-grant-hclass',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'grant-relative',
          cwd: grantCwd,
          permissions: { fileSystem: { read: ['linked-secret'] } },
          reason: 'read linked file',
        },
      })).rejects.toThrow('Permission request denied');
      expect(gateway.requestPermission).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(grantCwd, { recursive: true, force: true });
    }
  });

  it('resolves special project_roots grants from the thread workspace, not protocol cwd', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    const root = process.env.EVOLCLAW_HOME!;
    const externalCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-roots-cwd-'));
    try {
      runner.setMode('request');
      runner.setSendPrompt(vi.fn());
      runner.setPermissionGateway(gateway as any);
      (runner as any).threadProjectPaths.set('thread-1', root);

      await expect((runner as any).handleAppServerRequest({
        id: 'req-project-roots-hclass',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'grant-project-roots',
          cwd: externalCwd,
          permissions: {
            fileSystem: {
              entries: [{
                access: 'read',
                path: { type: 'special', value: { kind: 'project_roots', subpath: '.' } },
              }],
            },
          },
          reason: 'read project root',
        },
      })).rejects.toThrow('Permission request denied');
      expect(gateway.requestPermission).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(externalCwd, { recursive: true, force: true });
    }
  });

  it('returns an approved permission profile only for the current turn with strict review', async () => {
    const { runner } = makeRunner();
    const permissions = { network: { enabled: true } };
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);

    await expect((runner as any).handleAppServerRequest({
      id: 'req-permissions-request',
      method: 'item/permissions/requestApproval',
      params: { threadId: 'thread-1', cwd: '/repo', permissions, reason: 'download dependency' },
    })).resolves.toEqual({ permissions, scope: 'turn', strictAutoReview: true });
    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'thread-1',
      'PermissionGrant',
      expect.objectContaining({ permissions }),
      expect.any(Function),
      undefined,
      'download dependency',
      'download dependency',
      'codex:__evolclaw_thread-1_hclass_v1:request',
    );
  });

  it('uses the session-bound approval prompt instead of the shared runner callback', async () => {
    const { runner } = makeRunner();
    const sharedPrompt = vi.fn();
    const sessionPrompt = vi.fn();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('deny') };
    runner.setMode('request');
    runner.setSendPrompt(sharedPrompt);
    runner.setPermissionGateway(gateway as any);
    runner.setPermissionContext('thread-1', {
      userId: 'owner.agentid.pub',
      sendPrompt: sessionPrompt,
    } as any);

    await expect((runner as any).handleAppServerRequest({
      id: 'req-session-prompt',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'npm test' },
    })).resolves.toEqual({ decision: 'decline' });

    expect(gateway.requestPermission.mock.calls[0][3]).toBe(sessionPrompt);
    expect(gateway.requestPermission.mock.calls[0][3]).not.toBe(sharedPrompt);
  });

  it('preserves legacy command argv boundaries in the approval fingerprint input', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);

    await expect((runner as any).handleAppServerRequest({
      id: 'req-legacy-argv',
      method: 'execCommandApproval',
      params: {
        conversationId: 'thread-1',
        command: ['printf', 'a b'],
        cwd: '/repo',
      },
    })).resolves.toEqual({ decision: 'approved' });

    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'thread-1',
      'Bash',
      expect.objectContaining({
        command: 'printf a b',
        commandArgv: ['printf', 'a b'],
      }),
      expect.any(Function),
      undefined,
      'printf a b',
      undefined,
      'codex:__evolclaw_thread-1_hclass_v1:request',
    );
  });

  it('fails request mode closed when PermissionGateway is unavailable', async () => {
    const { runner } = makeRunner();
    runner.setMode('request');

    await expect((runner as any).handleAppServerRequest({
      id: 'req-no-gateway',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'npm test' },
    })).resolves.toEqual({ decision: 'decline' });
  });

  it('blocks Codex file changes in readonly mode even inside .evolclaw/tmp', async () => {
    const { runner } = makeRunner();
    runner.setMode('readonly');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        cwd: '/repo',
        fileChanges: { '.evolclaw/tmp/report.txt': { kind: 'create' } },
      },
    });

    expect(result).toEqual({ decision: 'decline' });
  });

  it('blocks Codex file changes in readonly mode outside .evolclaw/tmp', async () => {
    const { runner } = makeRunner();
    runner.setMode('readonly');

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        cwd: '/repo',
        fileChanges: { 'src/index.ts': { kind: 'update' } },
      },
    });

    expect(result).toEqual({ decision: 'decline' });
  });

  it('routes tracked MCP approval through the Gateway with exact arguments and accepts once', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('always') };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);
    (runner as any).trackApprovalItemNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'payments',
          tool: 'charge',
          arguments: { cents: 100, account: 'acct-1' },
          pluginId: 'payments@tools',
          mcpAppResourceUri: 'ui://payments/charge',
          appContext: { tenant: 'tenant-1' },
        },
      },
    });

    await expect((runner as any).handleAppServerRequest({
      id: 'req-mcp',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'mcp-1',
        questions: [{
          id: 'approval',
          question: 'Allow this app action?',
          options: [
            { label: 'Accept for session', description: 'Remember' },
            { label: 'Accept once', description: 'One call' },
            { label: 'Decline', description: 'Block' },
          ],
        }],
      },
    })).resolves.toEqual({ answers: { approval: { answers: ['Accept once'] } } });

    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'thread-1',
      'MCP:payments/charge',
      {
        server: 'payments',
        tool: 'charge',
        arguments: { cents: 100, account: 'acct-1' },
        pluginId: 'payments@tools',
        mcpAppResourceUri: 'ui://payments/charge',
        appContext: { tenant: 'tenant-1' },
      },
      expect.any(Function),
      undefined,
      'MCP payments/charge',
      'Allow this app action?',
      'codex:__evolclaw_thread-1_hclass_v1:request:external:test-external-config',
    );
  });

  it.each(['readonly', 'auto'])('declines tracked MCP approval without Gateway in %s mode', async (mode) => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode(mode);
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);
    (runner as any).trackApprovalItemNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'mcp-1', type: 'mcpToolCall', server: 'payments', tool: 'charge', arguments: { cents: 100 } },
      },
    });

    await expect((runner as any).handleAppServerRequest({
      id: `req-mcp-${mode}`,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'mcp-1',
        questions: [{ id: 'approval', options: [{ label: 'Accept' }, { label: 'Decline' }] }],
      },
    })).resolves.toEqual({ answers: { approval: { answers: ['Decline'] } } });
    expect(gateway.requestPermission).not.toHaveBeenCalled();
  });

  it('declines an approval-shaped requestUserInput when mcpToolCall metadata is missing', async () => {
    const { runner } = makeRunner();
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway({ requestPermission: vi.fn().mockResolvedValue('allow') } as any);

    await expect((runner as any).handleAppServerRequest({
      id: 'req-untracked-mcp',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'missing',
        questions: [{ id: 'approval', options: [{ label: 'Accept' }, { label: 'Cancel' }] }],
      },
    })).resolves.toEqual({ answers: { approval: { answers: ['Cancel'] } } });
  });

  it('declines tracked MCP approval when request mode has no Gateway', async () => {
    const { runner } = makeRunner();
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    (runner as any).trackApprovalItemNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'mcp-1', type: 'mcpToolCall', server: 'payments', tool: 'charge', arguments: { cents: 100 } },
      },
    });

    await expect((runner as any).handleAppServerRequest({
      id: 'req-mcp-no-gateway',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'mcp-1',
        questions: [{ id: 'approval', options: [{ label: 'Accept' }, { label: 'Decline' }] }],
      },
    })).resolves.toEqual({ answers: { approval: { answers: ['Decline'] } } });
  });

  it('never converts an EvolClaw approval into a persistent Codex grant', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('always') };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);
    (runner as any).trackApprovalItemNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'mcp-1', type: 'mcpToolCall', server: 'payments', tool: 'charge', arguments: { cents: 100 } },
      },
    });

    await expect((runner as any).handleAppServerRequest({
      id: 'req-mcp-persistent-only',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'mcp-1',
        questions: [{ id: 'approval', options: [{ label: 'Accept for session' }, { label: 'Decline' }] }],
      },
    })).resolves.toEqual({ answers: { approval: { answers: ['Decline'] } } });
  });

  it('declines tracked MCP approval when exact arguments are absent', async () => {
    const { runner } = makeRunner();
    const gateway = { requestPermission: vi.fn().mockResolvedValue('allow') };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);
    (runner as any).trackApprovalItemNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'mcp-1', type: 'mcpToolCall', server: 'payments', tool: 'charge' },
      },
    });

    await expect((runner as any).handleAppServerRequest({
      id: 'req-mcp-missing-args',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'mcp-1',
        questions: [{ id: 'approval', options: [{ label: 'Accept' }, { label: 'Decline' }] }],
      },
    })).resolves.toEqual({ answers: { approval: { answers: ['Decline'] } } });
    expect(gateway.requestPermission).not.toHaveBeenCalled();
  });

  it('answers requestUserInput with the first option when no interaction context exists', async () => {
    const { runner } = makeRunner();

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        questions: [{
          id: 'q1',
          header: 'Mode',
          question: 'Choose mode',
          options: [{ label: 'Safe', description: 'No writes' }, { label: 'Fast', description: 'Allow writes' }],
        }],
      },
    });

    expect(result).toEqual({ answers: { q1: { answers: ['Safe'] } } });
  });

  it('cancels MCP elicitation and rejects unaudited app-server request types', async () => {
    const { runner } = makeRunner();

    await expect((runner as any).handleAppServerRequest({
      id: 'req-elicitation',
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread-1', serverName: 'remote', mode: 'url', url: 'https://example.test' },
    })).resolves.toEqual({ action: 'cancel', content: null, _meta: null });

    await expect((runner as any).handleAppServerRequest({
      id: 'req-dynamic',
      method: 'item/tool/call',
      params: { threadId: 'thread-1', tool: 'mutate', arguments: {} },
    })).rejects.toThrow('Unsupported Codex app-server request: item/tool/call');
  });

  it('answers requestUserInput through InteractionRouter fallback responses', async () => {
    const { runner } = makeRunner();
    const router = new InteractionRouter();
    const registerSpy = vi.spyOn(router, 'register');
    const sendPrompt = vi.fn().mockResolvedValue(undefined);
    runner.setSendPrompt(sendPrompt);
    runner.setPermissionContext('sess-1', {
      channelId: 'chat1',
      interactionRouter: router,
      userId: 'user1',
    } as any);
    (runner as any).activeSessions.set('sess-1', 'thread-1');

    const promise = (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        questions: [{
          id: 'q1',
          header: 'Mode',
          question: 'Choose mode',
          isOther: true,
          options: [{ label: 'Safe', description: 'No writes' }, { label: 'Fast', description: 'Allow writes' }],
        }],
      },
    });

    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalled());
    const pending = router.getPending('sess-1')[0];
    expect(pending).toMatch(/^codex-ask-/);
    const registerOptions = registerSpy.mock.calls[0]?.[3];
    expect(registerOptions).toMatchObject({ initiatorId: 'user1', fallbackCommand: 'ask' });
    expect(registerOptions).not.toHaveProperty('timeoutMs');
    expect(registerOptions).not.toHaveProperty('onTimeout');
    router.handle({ type: 'interaction.response', id: pending, action: '2', operatorId: 'user1' });

    await expect(promise).resolves.toEqual({ answers: { q1: { answers: ['Fast'] } } });
  });
});

describe('CodexRunner telemetry mapping', () => {
  it('normalizes app-server complete metadata and usage fields', () => {
    const { runner } = makeRunner();

    const event = (runner as any).mapAppServerTurnComplete({
      status: 'completed',
      durationMs: 1234,
      ttft_ms: 25,
      total_cost_usd: 0.045,
      session_title: 'Telemetry title',
      num_turns: 4,
      contextUsage: {
        total_tokens: 1024,
        max_tokens: 4096,
        model: 'gpt-5.4',
        effort: 'high',
      },
    }, {
      tokenUsage: {
        last: {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 10,
          cacheCreationInputTokens: 5,
        },
      },
    });

    expect(event).toEqual(expect.objectContaining({
      type: 'complete',
      subtype: 'success',
      isError: false,
      durationMs: 1234,
      ttftMs: 25,
      costUsd: 0.045,
      sessionTitle: 'Telemetry title',
      numTurns: 4,
      tokenUsage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      contextUsage: {
        totalTokens: 1024,
        maxTokens: 4096,
        percentage: 25,
        model: 'gpt-5.4',
        effort: 'high',
      },
    }));
  });
});

describe('CodexRunner model scope alignment', () => {
  beforeEach(() => {
    fileCache.invalidateAll();
  });

  it('does not inherit global claude opus override when processing with codex', async () => {
    const paths = resolvePaths();
    fs.mkdirSync(path.dirname(paths.defaultsConfig), { recursive: true });
    fs.writeFileSync(paths.defaultsConfig, JSON.stringify({
      $schema_version: 1,
      active_baseagent: 'claude',
      baseagents: {
        claude: { model: 'opus', effort: 'high' },
        codex: {},
      },
    }), 'utf-8');

    const runner = {
      name: 'codex',
      getModel: vi.fn().mockReturnValue('gpt-5.5'),
      runQuery: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done) return { done: true, value: undefined };
              done = true;
              return {
                done: false,
                value: { type: 'complete', isError: false, result: 'ok', subtype: 'success', durationMs: 10 },
              };
            },
          };
        },
      }),
      registerStream: vi.fn(),
      cleanupStream: vi.fn(),
      interrupt: vi.fn(),
      updateSessionId: vi.fn(),
      closeSession: vi.fn(),
      setSendPrompt: vi.fn(),
      setMode: vi.fn(),
    };
    const session = {
      id: 'sess-1',
      channel: 'feishu',
      channelId: 'chat-1',
      projectPath: '/tmp/test-project',
      threadId: '',
      agentId: 'codex',
      chatType: 'private',
      sessionMode: 'interactive',
      agentSessionId: 'thread-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      identity: { role: 'owner', mode: 'interactive' },
    };
    const sessionManager = {
      getOrCreateSession: vi.fn().mockResolvedValue(session),
      getActiveSession: vi.fn().mockResolvedValue(session),
      getActiveSessionSync: vi.fn().mockReturnValue(session),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordError: vi.fn().mockResolvedValue(undefined),
      getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false, lastSuccessTime: Date.now() }),
      setSafeMode: vi.fn().mockResolvedValue(undefined),
      markProcessing: vi.fn(),
      clearProcessing: vi.fn(),
    };
    const adapter = {
      channelName: 'feishu',
      capabilities: { file: false, image: false, interaction: false, markdown: false, thought: false, status: false },
      send: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
    };
    const policy = {
      canSwitchProject: () => true,
      canListProjects: () => true,
      canCreateSession: () => true,
      canDeleteSession: () => true,
      canImportCliSession: () => true,
      messagePrefix: () => '',
      showMiddleResult: () => true,
      showIdleMonitor: () => false,
      accumulateErrors: () => false,
    };

    const processor = new MessageProcessor(runner as any, sessionManager as any, {}, {} as any, new EventBus());
    processor.registerChannel(adapter as any, policy as any);

    await processor.processMessage({
      channel: 'feishu',
      channelId: 'chat-1',
      content: 'hello',
      peerId: 'ou_test',
      timestamp: Date.now(),
    } as any);

    expect(runner.runQuery.mock.calls[0][7]).toBeUndefined();
  });
});
