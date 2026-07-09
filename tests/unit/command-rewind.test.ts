import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandHandler } from '../../src/core/command/command-handler.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { Config, ChannelAdapter } from '../../src/types.js';

// === Mock Factories ===

function createMockSessionManager(overrides: Record<string, any> = {}) {
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(null),
    getActiveSession: vi.fn().mockResolvedValue({
      id: 'sess-1', channel: 'feishu', channelId: 'chat1',
      projectPath: '/tmp/test', threadId: '', agentId: 'claude',
      chatType: 'private', sessionMode: 'interactive',
      agentSessionId: 'claude-s1',
      metadata: {},
      createdAt: Date.now(), updatedAt: Date.now(),
      identity: { role: 'owner', mode: 'interactive' },
    }),
    resolveIdentity: vi.fn().mockReturnValue({ role: 'owner', mode: 'interactive' }),
    recordSuccess: vi.fn(),
    recordError: vi.fn().mockResolvedValue(0),
    getHealthStatus: vi.fn().mockResolvedValue({ consecutiveErrors: 0, safeMode: false }),
    setSafeMode: vi.fn(),
    switchProject: vi.fn(),
    createNewSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    switchSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    updateClaudeSessionId: vi.fn(),
    updateSession: vi.fn().mockResolvedValue(undefined),
    getSessionById: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as any;
}

function createMockAgentRunner(overrides: Record<string, any> = {}) {
  return {
    name: 'claude',
    runQuery: vi.fn(),
    interrupt: vi.fn(),
    updateSessionId: vi.fn(),
    closeSession: vi.fn(),
    compactSession: vi.fn(),
    getModel: vi.fn().mockReturnValue('sonnet'),
    getEffort: vi.fn().mockReturnValue('medium'),
    setModel: vi.fn(),
    listModels: vi.fn().mockReturnValue(['sonnet', 'opus', 'haiku']),
    setMode: vi.fn(),
    getMode: vi.fn().mockReturnValue('default'),
    listModes: vi.fn().mockReturnValue([]),
    compact: vi.fn().mockResolvedValue(true),
    hasActiveStream: vi.fn().mockReturnValue(false),
    capabilities: { fork: true },
    getSessionMessages: vi.fn().mockResolvedValue([]),
    rewindFiles: vi.fn().mockResolvedValue({ canRewind: true, filesChanged: ['a.ts'], insertions: 10, deletions: 5 }),
    ...overrides,
  } as any;
}

function createMockConfig(): Config {
  return {
    channels: {
      feishu: { appId: '', appSecret: '', owner: 'owner1' },
      aun: { aid: 'test.test' },
    },
    projects: { defaultPath: '/tmp/test', list: { test: '/tmp/test' } },
  } as any;
}

function createMockMessageCache() {
  return { getCount: vi.fn().mockReturnValue(0), addEvent: vi.fn(), getEvents: vi.fn().mockReturnValue([]), clearEvents: vi.fn() } as any;
}

function createMockAdapter(): ChannelAdapter {
  return { channelName: 'feishu', sendText: vi.fn().mockResolvedValue(undefined) };
}

// === Sample session messages ===

function makeSampleMessages() {
  return [
    { type: 'user', uuid: 'u1', session_id: 's1', message: { content: '帮我写一个函数' }, parent_tool_use_id: null },
    { type: 'assistant', uuid: 'a1', session_id: 's1', message: { content: [{ type: 'text', text: '好的' }] }, parent_tool_use_id: null },
    { type: 'user', uuid: 'u2', session_id: 's1', message: { content: '加个测试' }, parent_tool_use_id: null },
    { type: 'assistant', uuid: 'a2', session_id: 's1', message: { content: [{ type: 'text', text: '已添加' }] }, parent_tool_use_id: null },
    { type: 'user', uuid: 'u3', session_id: 's1', message: { content: '部署到生产' }, parent_tool_use_id: null },
    { type: 'assistant', uuid: 'a3', session_id: 's1', message: { content: [{ type: 'text', text: '完成' }] }, parent_tool_use_id: null },
  ];
}

// === Tests ===

describe('/rewind command', () => {
  let cmdHandler: CommandHandler;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let runner: ReturnType<typeof createMockAgentRunner>;
  let eventBus: EventBus;
  let adapter: ChannelAdapter;

  beforeEach(() => {
    sessionManager = createMockSessionManager();
    runner = createMockAgentRunner();
    eventBus = new EventBus();
    adapter = createMockAdapter();

    cmdHandler = new CommandHandler(
      sessionManager, runner,
      createMockMessageCache(), eventBus,
    );
    cmdHandler.registerAdapter(adapter);
  });

  // ── Precondition checks ──

  describe('preconditions', () => {
    it('should reject for non-claude agent', async () => {
      sessionManager.getActiveSession.mockResolvedValue({
        id: 'sess-1', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'hermes', agentSessionId: 'h-1',
        metadata: {}, identity: { role: 'owner', mode: 'interactive' },
      });
      // hermes runner has no getSessionMessages
      const hermesRunner = createMockAgentRunner({ name: 'hermes', getSessionMessages: undefined, rewindFiles: undefined });
      // 使用默认的 primaryRunnerKey ('<unknown>::claude') 对应的 map keys
      const agentMap = new Map([['<unknown>::claude', runner], ['<unknown>::hermes', hermesRunner]]);
      cmdHandler = new CommandHandler(sessionManager, agentMap as any, createMockMessageCache(), eventBus);
      cmdHandler.registerAdapter(adapter);

      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || '').toContain('不支持 /rewind');
    });

    it('should reject when session has no agentSessionId', async () => {
      sessionManager.getActiveSession.mockResolvedValue({
        id: 'sess-1', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', agentId: 'claude', agentSessionId: '',
        metadata: {}, identity: { role: 'owner', mode: 'interactive' },
      });
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('无历史记录');
    });
  });

  // ── /rewind (list) ──

  describe('/rewind (list history)', () => {
    it('should show empty message when no turns', async () => {
      runner.getSessionMessages.mockResolvedValue([]);
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('暂无对话记录');
    });

    it('should list turns with numbered history', async () => {
      runner.getSessionMessages.mockResolvedValue(makeSampleMessages());
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('共 3 轮');
      expect((result as any)?.text || "").toContain('#1 帮我写一个函数');
      expect((result as any)?.text || "").toContain('#2 加个测试');
      expect((result as any)?.text || "").toContain('#3 部署到生产');
      expect((result as any)?.text || "").toContain('/rewind <N> chat|file|all');
    });

    it('should skip tool_result-only user messages', async () => {
      const messages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { content: '你好' }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null },
        // tool_result-only user message — should be skipped
        { type: 'user', uuid: 'u-tool', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a2', session_id: 's1', message: { content: [{ type: 'text', text: 'done' }] }, parent_tool_use_id: null },
        { type: 'user', uuid: 'u2', session_id: 's1', message: { content: '再见' }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a3', session_id: 's1', message: { content: [{ type: 'text', text: 'bye' }] }, parent_tool_use_id: null },
      ];
      runner.getSessionMessages.mockResolvedValue(messages);
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('共 2 轮');
      expect((result as any)?.text || "").toContain('#1 你好');
      expect((result as any)?.text || "").toContain('#2 再见');
    });

    it('should truncate long user content to 50 chars', async () => {
      const longText = 'A'.repeat(80);
      const messages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { content: longText }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null },
      ];
      runner.getSessionMessages.mockResolvedValue(messages);
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('A'.repeat(50) + '…');
    });

    it('should handle getSessionMessages error gracefully', async () => {
      runner.getSessionMessages.mockRejectedValue(new Error('SDK error'));
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('读取会话历史失败');
      expect((result as any)?.text || "").toContain('SDK error');
    });

    it('/rw alias should work the same as /rewind', async () => {
      runner.getSessionMessages.mockResolvedValue(makeSampleMessages());
      const result = await cmdHandler.handle('/rw', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('共 3 轮');
    });
  });

  // ── Argument validation ──

  describe('argument validation', () => {
    it('should reject non-numeric turn number', async () => {
      const result = await cmdHandler.handle('/rewind abc chat', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('无效轮次');
    });

    it('should reject turn number 0', async () => {
      const result = await cmdHandler.handle('/rewind 0 chat', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('无效轮次');
    });

    it('should reject negative turn number', async () => {
      const result = await cmdHandler.handle('/rewind -1 chat', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('无效轮次');
    });

    it('should require mode argument', async () => {
      const result = await cmdHandler.handle('/rewind 1', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('请指定回退模式');
    });

    it('should reject invalid mode', async () => {
      const result = await cmdHandler.handle('/rewind 1 reset', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('无效模式');
      expect((result as any)?.text || "").toContain('reset');
    });
  });

  // ── /rewind N chat ──

  describe('/rewind N chat', () => {
    beforeEach(() => {
      runner.getSessionMessages.mockResolvedValue(makeSampleMessages());
    });

    it('should reject turn number exceeding total turns', async () => {
      const result = await cmdHandler.handle('/rewind 5 chat', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('轮次超出范围');
      expect((result as any)?.text || "").toContain('3 轮');
    });

    it('should rewind latest turn (turn 3 of 3)', async () => {
      const result = await cmdHandler.handle('/rewind 3 chat', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('已撤销第 3 轮');
      expect((result as any)?.text || "").toContain('下次发言将从第 2 轮继续');

      expect(sessionManager.updateSession).toHaveBeenCalledWith('sess-1', {
        metadata: expect.objectContaining({ resumeAt: 'a2' }),
      });
    });

    it('should clear session when rewinding turn 1 (clear all)', async () => {
      const result = await cmdHandler.handle('/rewind 1 chat', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('已撤销第 1 轮');
      expect((result as any)?.text || "").toContain('下次发言将开始全新对话');

      expect(sessionManager.updateSession).toHaveBeenCalledWith('sess-1', {
        metadata: expect.not.objectContaining({ resumeAt: expect.anything() }),
        agentSessionId: null,
      });
    });

    it('should emit session:rewind event', async () => {
      const events: any[] = [];
      eventBus.subscribeAll(e => events.push(e));

      await cmdHandler.handle('/rewind 2 chat', 'feishu', 'chat1', undefined, 'owner1');

      const rewindEvent = events.find(e => e.type === 'session:rewind');
      expect(rewindEvent).toBeDefined();
      expect(rewindEvent.turnNum).toBe(2);
      expect(rewindEvent.mode).toBe('chat');
    });

    it('should rollback codex thread directly when supported', async () => {
      sessionManager.getActiveSession.mockResolvedValue({
        id: 'sess-1', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', threadId: '', agentId: 'codex',
        chatType: 'private', sessionMode: 'interactive',
        agentSessionId: 'codex-thread-1',
        metadata: {}, identity: { role: 'owner', mode: 'interactive' },
      });
      const codexRunner = createMockAgentRunner({
        name: 'codex',
        getSessionMessages: vi.fn().mockResolvedValue(makeSampleMessages()),
        rollbackSessionTurns: vi.fn().mockResolvedValue(true),
        rewindFiles: undefined,
      });
      cmdHandler = new CommandHandler(sessionManager, codexRunner, createMockMessageCache(), eventBus);
      cmdHandler.registerAdapter(adapter);

      const result = await cmdHandler.handle('/rewind 2 chat', 'feishu', 'chat1', undefined, 'owner1');

      expect((result as any)?.text || '').toContain('已撤销第 2 轮');
      expect(codexRunner.rollbackSessionTurns).toHaveBeenCalledWith('codex-thread-1', '/tmp/test', 2);
      expect(sessionManager.updateSession).toHaveBeenCalledWith('sess-1', { metadata: {} });
    });

    it('should report codex rollback failure', async () => {
      sessionManager.getActiveSession.mockResolvedValue({
        id: 'sess-1', channel: 'feishu', channelId: 'chat1',
        projectPath: '/tmp/test', threadId: '', agentId: 'codex',
        chatType: 'private', sessionMode: 'interactive',
        agentSessionId: 'codex-thread-1',
        metadata: {}, identity: { role: 'owner', mode: 'interactive' },
      });
      const codexRunner = createMockAgentRunner({
        name: 'codex',
        getSessionMessages: vi.fn().mockResolvedValue(makeSampleMessages()),
        rollbackSessionTurns: vi.fn().mockResolvedValue(false),
        rewindFiles: undefined,
      });
      cmdHandler = new CommandHandler(sessionManager, codexRunner, createMockMessageCache(), eventBus);
      cmdHandler.registerAdapter(adapter);

      const result = await cmdHandler.handle('/rewind 2 chat', 'feishu', 'chat1', undefined, 'owner1');

      expect((result as any)?.text || '').toContain('对话回退失败');
      expect(codexRunner.rollbackSessionTurns).toHaveBeenCalledWith('codex-thread-1', '/tmp/test', 2);
    });
  });

  // ── /rewind N file ──

  describe('/rewind N file', () => {
    beforeEach(() => {
      runner.getSessionMessages.mockResolvedValue(makeSampleMessages());
    });

    it('should call rewindFiles with correct userUuid', async () => {
      const result = await cmdHandler.handle('/rewind 1 file', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('已恢复文件到第 1 轮');
      expect((result as any)?.text || "").toContain('1 个文件');
      expect(runner.rewindFiles).toHaveBeenCalledWith('claude-s1', '/tmp/test', 'u1');
    });

    it('should report failure when canRewind is false', async () => {
      runner.rewindFiles.mockResolvedValue({ canRewind: false, error: 'no checkpoints' });
      const result = await cmdHandler.handle('/rewind 1 file', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('无文件快照');
      expect((result as any)?.text || "").toContain('no checkpoints');
    });

    it('should not store resumeAt for file-only rewind', async () => {
      await cmdHandler.handle('/rewind 1 file', 'feishu', 'chat1', undefined, 'owner1');
      expect(sessionManager.updateSession).not.toHaveBeenCalled();
    });

    it('should reject when agent has no rewindFiles', async () => {
      runner.rewindFiles = undefined;
      const result = await cmdHandler.handle('/rewind 1 file', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('不支持文件回退');
    });
  });

  // ── /rewind N all ──

  describe('/rewind N all', () => {
    beforeEach(() => {
      runner.getSessionMessages.mockResolvedValue(makeSampleMessages());
    });

    it('should rewind both files and chat', async () => {
      const result = await cmdHandler.handle('/rewind 2 all', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('已恢复文件到第 2 轮之前');
      expect((result as any)?.text || "").toContain('已撤销第 2 轮');
      // rewindFiles uses the user UUID of the turn being undone
      expect(runner.rewindFiles).toHaveBeenCalledWith('claude-s1', '/tmp/test', 'u2');
      // resumeAt uses the assistant UUID of the turn before (turn 1)
      expect(sessionManager.updateSession).toHaveBeenCalledWith('sess-1', {
        metadata: expect.objectContaining({ resumeAt: 'a1' }),
      });
    });

    it('should continue chat rewind even if file rewind fails', async () => {
      runner.rewindFiles.mockResolvedValue({ canRewind: false });
      const result = await cmdHandler.handle('/rewind 2 all', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('文件回退失败');
      expect((result as any)?.text || "").toContain('已撤销第 2 轮');
      expect(sessionManager.updateSession).toHaveBeenCalled();
    });

    it('should emit session:rewind event with mode=all', async () => {
      const events: any[] = [];
      eventBus.subscribeAll(e => events.push(e));

      await cmdHandler.handle('/rewind 1 all', 'feishu', 'chat1', undefined, 'owner1');

      const rewindEvent = events.find(e => e.type === 'session:rewind');
      expect(rewindEvent).toBeDefined();
      expect(rewindEvent.mode).toBe('all');
    });
  });

  // ── Error handling ──

  describe('error handling', () => {
    it('should catch and report rewind execution errors', async () => {
      runner.getSessionMessages.mockRejectedValue(new Error('connection lost'));
      const result = await cmdHandler.handle('/rewind 1 chat', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('回退失败');
      expect((result as any)?.text || "").toContain('connection lost');
    });
  });

  // ── Edge: content extraction ──

  describe('content extraction', () => {
    it('should handle array content with text blocks', async () => {
      const messages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null },
      ];
      runner.getSessionMessages.mockResolvedValue(messages);
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || "").toContain('hello world');
    });

    it('should handle single turn (rewind clears all)', async () => {
      const messages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { content: '唯一消息' }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null },
      ];
      runner.getSessionMessages.mockResolvedValue(messages);
      // List should show 1 turn
      const listResult = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((listResult as any)?.text || '').toContain('共 1 轮');

      // Rewind turn 1 should clear all (only turn)
      const rewindResult = await cmdHandler.handle('/rewind 1 chat', 'feishu', 'chat1', undefined, 'owner1');
      expect((rewindResult as any)?.text || '').toContain('已撤销第 1 轮');
      expect((rewindResult as any)?.text || '').toContain('下次发言将开始全新对话');
    });

    it('should strip current ‹metadata› envelope and show only message body', async () => {
      const wrapped = '‹2026-06-08 15:40:00 +08:00 · from:ou_2114acae(轮子) → self:evolai.agentid.pub›\n帮我重构这个函数';
      const messages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { content: wrapped }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null },
      ];
      runner.getSessionMessages.mockResolvedValue(messages);
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || '').toContain('#1 帮我重构这个函数');
      expect((result as any)?.text || '').not.toContain('from:ou_2114acae');
      expect((result as any)?.text || '').not.toContain('‹');
    });

    it('should strip legacy <messages> XML wrapper', async () => {
      const wrapped = '<messages>\n<message sender="ou_fd9172e1" time="2026-03-09T06:35:59.620Z">重启下容器</message>\n</messages>';
      const messages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { content: wrapped }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null },
      ];
      runner.getSessionMessages.mockResolvedValue(messages);
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || '').toContain('#1 重启下容器');
      expect((result as any)?.text || '').not.toContain('sender=');
      expect((result as any)?.text || '').not.toContain('<message');
    });

    it('should strip interrupt wrapper 【新消息插入】', async () => {
      const wrapped = '【新消息插入】\n\n‹2026-06-08 15:40:00 +08:00 · from:ou_abc → self:x›\n继续之前的任务\n\n【请无视之前中断继续处理】';
      const messages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { content: wrapped }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null },
      ];
      runner.getSessionMessages.mockResolvedValue(messages);
      const result = await cmdHandler.handle('/rewind', 'feishu', 'chat1', undefined, 'owner1');
      expect((result as any)?.text || '').toContain('继续之前的任务');
      expect((result as any)?.text || '').not.toContain('新消息插入');
      expect((result as any)?.text || '').not.toContain('无视之前中断');
    });
  });
});
