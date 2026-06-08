import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { CodexRunner } from '../../src/agents/codex-runner.js';
import { MessageProcessor } from '../../src/core/message/message-processor.js';
import { EventBus } from '../../src/core/event-bus.js';
import { resolvePaths } from '../../src/paths.js';
import { fileCache } from '../../src/core/cache/file-cache.js';

function makeRunner() {
  const runner = new CodexRunner({ agents: { codex: { apiKey: 'test-key', model: 'gpt-5.4', effort: 'high' } } } as any, { onSessionIdUpdate: vi.fn() } as any);
  const appServer = {
    modelList: vi.fn().mockResolvedValue({ data: [{ id: 'gpt-5.5' }, { slug: 'gpt-5.4' }] }),
    threadCompactStart: vi.fn().mockResolvedValue(true),
    threadFork: vi.fn().mockResolvedValue({ thread: { id: 'forked-thread' } }),
    threadSetName: vi.fn().mockResolvedValue(true),
    threadMetadataUpdate: vi.fn().mockResolvedValue(true),
    turnInterrupt: vi.fn().mockResolvedValue(true),
    threadRead: vi.fn(),
  };
  (runner as any).getAppServerClient = () => appServer;
  return { runner, appServer };
}

describe('CodexRunner Claude alignment capabilities', () => {
  it('advertises compact and fork support', () => {
    const { runner } = makeRunner();
    expect(runner.capabilities.compact).toBe(true);
    expect(runner.capabilities.fork).toBe(true);
    expect(runner.capabilities.askUserQuestion).toBe(false);
    expect(runner.capabilities.planApproval).toBe(false);
  });

  it('uses app-server for model listing with fallback-capable ids', async () => {
    const { runner, appServer } = makeRunner();
    await expect(runner.listModels()).resolves.toEqual(['gpt-5.5', 'gpt-5.4']);
    expect(appServer.modelList).toHaveBeenCalledWith(false);
  });

  it('uses app-server for compact, fork, title, and metadata sync', async () => {
    const { runner, appServer } = makeRunner();

    await expect(runner.compactSession('sess-1', 'thread-1', '/repo')).resolves.toBe(true);
    await expect(runner.forkSession('thread-1', '/repo', 'fork name')).resolves.toBe('forked-thread');
    await expect(runner.setSessionName('thread-1', 'new name')).resolves.toBe(true);
    await expect(runner.updateSessionMetadata('thread-1', { gitInfo: { branch: 'main' } })).resolves.toBe(true);

    expect(appServer.threadCompactStart).toHaveBeenCalledWith('thread-1');
    expect(appServer.threadFork).toHaveBeenCalledWith('thread-1', '/repo', 'fork name');
    expect(appServer.threadSetName).toHaveBeenCalledWith('thread-1', 'new name');
    expect(appServer.threadMetadataUpdate).toHaveBeenCalledWith('thread-1', { branch: 'main' });
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
