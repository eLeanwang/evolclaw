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
  it('advertises compact and fork support', () => {
    const { runner } = makeRunner();
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

  it('parses and enforces the minimum Codex CLI version for requestUserInput', () => {
    expect(MIN_CODEX_CLI_VERSION).toBe('0.117.0');
    expect(parseCodexCliVersion('codex-cli 0.137.0')).toBe('0.137.0');
    expect(parseCodexCliVersion('WARNING: noisy\ncodex-cli 0.117.0')).toBe('0.117.0');
    expect(isCodexCliVersionSupported('0.116.9')).toBe(false);
    expect(isCodexCliVersionSupported('0.117.0')).toBe(true);
    expect(isCodexCliVersionSupported('0.137.0')).toBe(true);
  });

  it('uses app-server for model listing with fallback-capable ids', async () => {
    const { runner, appServer } = makeRunner();
    await expect(runner.listModels()).resolves.toEqual(['gpt-5.5', 'gpt-5.4']);
    expect(appServer.modelList).toHaveBeenCalledWith(false);
  });

  it('uses app-server for compact, fork, title, and metadata sync', async () => {
    const { runner, appServer } = makeRunner();
    const onCompactStart = vi.fn();
    runner.setCompactStartCallback(onCompactStart);

    await expect(runner.compactSession('sess-1', 'thread-1', '/repo')).resolves.toBe(true);
    await expect(runner.forkSession('thread-1', '/repo', 'fork name')).resolves.toBe('forked-thread');
    await expect(runner.setSessionName('thread-1', 'new name')).resolves.toBe(true);
    await expect(runner.updateSessionMetadata('thread-1', { gitInfo: { branch: 'main' } })).resolves.toBe(true);

    expect(onCompactStart).toHaveBeenCalledWith('sess-1');
    expect(appServer.threadCompactStart).toHaveBeenCalledWith('thread-1');
    expect(appServer.threadFork).toHaveBeenCalledWith('thread-1', '/repo', 'fork name');
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
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }));
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

  it('keeps Codex auto as local-guarded app-server approvalPolicy=never', async () => {
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

    expect(appServer.threadStart).toHaveBeenCalledWith('/repo', expect.objectContaining({ approvalPolicy: 'never' }));
    expect(appServer.turnStart).toHaveBeenCalledWith('thread-1', expect.anything(), expect.objectContaining({ approvalPolicy: 'never' }));
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
      config: {
        shell_environment_policy: {
          set: {
            EVOLCLAW_SESSION_ID: 'sess-env-1',
            EVOLCLAW_HOME: expect.any(String),
          },
        },
      },
    }));

    const resumedStream = await runner.runQuery('sess-env-2', 'hello again', '/repo', 'thread-existing');
    for await (const _event of resumedStream) {
      // consume stream
    }

    expect(appServer.threadResume).toHaveBeenCalledWith('thread-existing', '/repo', expect.objectContaining({
      config: {
        shell_environment_policy: {
          set: {
            EVOLCLAW_SESSION_ID: 'sess-env-2',
            EVOLCLAW_HOME: expect.any(String),
          },
        },
      },
    }));
  });

  it('passes configured approvalsReviewer to Codex app-server thread options', async () => {
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
      approvalsReviewer: 'auto_review',
    }));
  });

  it('uses read-only app-server sandbox for Codex request/noask/readonly modes', async () => {
    for (const mode of ['request', 'noask', 'readonly']) {
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

      expect(appServer.threadStart).toHaveBeenCalledWith('/repo', expect.objectContaining({ sandbox: 'read-only' }));
      expect(appServer.turnStart).toHaveBeenCalledWith(`thread-${mode}`, expect.anything(), expect.objectContaining({ sandbox: 'read-only' }));
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

  it('maps PermissionGateway always decisions to app-server acceptForSession', async () => {
    const { runner } = makeRunner();
    const gateway = {
      isAlwaysAllowed: vi.fn().mockReturnValue(false),
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

    expect(result).toEqual({ decision: 'acceptForSession' });
    expect(gateway.requestPermission).toHaveBeenCalledWith(
      'sess-1',
      'Bash',
      expect.objectContaining({ command: 'npm test' }),
      expect.any(Function),
      expect.objectContaining({ channelId: 'chat1' }),
      'npm test',
      'needs shell',
    );
  });

  it('uses PermissionGateway always allow without prompting again', async () => {
    const { runner } = makeRunner();
    const gateway = {
      isAlwaysAllowed: vi.fn().mockReturnValue(true),
      requestPermission: vi.fn(),
    };
    runner.setMode('request');
    runner.setSendPrompt(vi.fn());
    runner.setPermissionGateway(gateway as any);

    const result = await (runner as any).handleAppServerRequest({
      id: 'req-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', command: 'npm test' },
    });

    expect(result).toEqual({ decision: 'acceptForSession' });
    expect(gateway.isAlwaysAllowed).toHaveBeenCalledWith('Bash');
    expect(gateway.requestPermission).not.toHaveBeenCalled();
  });

  it('maps noask mode to app-server decline', async () => {
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
    runner.setMode('noask');

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
    runner.setMode('noask');

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

  it('allows Codex file changes in readonly mode inside .evolclaw/tmp', async () => {
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

    expect(result).toEqual({ decision: 'accept' });
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
