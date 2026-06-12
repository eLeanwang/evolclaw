# `/rewind` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/rewind` command that shows Claude conversation history and supports three rewind modes (chat/file/all).

**Architecture:** Extend `AgentRunner` with `getSessionMessages()` and `rewindFiles()` methods wrapping SDK APIs. Add `enableFileCheckpointing` to all queries. Store `resumeAt` in session metadata for deferred chat rewind. Command handler parses `/rewind [N] [chat|file|all]` syntax.

**Tech Stack:** Claude Agent SDK (`getSessionMessages`, `query` with `resumeSessionAt`/`enableFileCheckpointing`, `rewindFiles`), SQLite session metadata, vitest.

---

### Task 1: Add `getSessionMessages` and `rewindFiles` to AgentRunner

**Files:**
- Modify: `src/agents/claude-runner.ts:1` (imports)
- Modify: `src/agents/claude-runner.ts:677` (commonOptions — add enableFileCheckpointing)
- Modify: `src/agents/claude-runner.ts:702` (createQuery — add resumeSessionAt support)
- Modify: `src/agents/claude-runner.ts:897` (after forkSession — add new methods)
- Modify: `src/types.ts:136` (AgentRunnerFull interface)
- Modify: `src/types.ts:136` (SessionMetadata interface)
- Test: `tests/unit/rewind-command.test.ts`

- [ ] **Step 1: Write failing test for getSessionMessages**

```typescript
// tests/unit/rewind-command.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK module
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
}));

import { getSessionMessages as sdkGetSessionMessages } from '@anthropic-ai/claude-agent-sdk';

describe('/rewind command', () => {
  describe('getSessionMessages', () => {
    it('should call SDK getSessionMessages with correct params', async () => {
      const mockMessages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { role: 'assistant', content: 'hi' }, parent_tool_use_id: null },
      ];
      vi.mocked(sdkGetSessionMessages).mockResolvedValue(mockMessages);

      // Import after mock setup
      const { AgentRunner } = await import('../../src/agents/claude-runner.js');
      const runner = new (AgentRunner as any)({ agents: { anthropic: {} } });
      const result = await runner.getSessionMessages('session-123', '/home/project');

      expect(sdkGetSessionMessages).toHaveBeenCalledWith('session-123', { dir: '/home/project' });
      expect(result).toEqual(mockMessages);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/rewind-command.test.ts -v`
Expected: FAIL — `runner.getSessionMessages is not a function`

- [ ] **Step 3: Add SDK import and getSessionMessages method**

In `src/agents/claude-runner.ts`, update the import at line 1:

```typescript
import { query, forkSession as sdkForkSession, getSessionMessages as sdkGetSessionMessages } from '@anthropic-ai/claude-agent-sdk';
```

Add method after `forkSession` (after line 900):

```typescript
  async getSessionMessages(agentSessionId: string, projectPath: string) {
    return sdkGetSessionMessages(agentSessionId, { dir: projectPath });
  }

  async rewindFiles(agentSessionId: string, projectPath: string, userMessageId: string) {
    // Create a temporary query to access rewindFiles
    const tempQuery = query({
      prompt: '',
      options: {
        cwd: projectPath,
        resume: agentSessionId,
        enableFileCheckpointing: true,
        permissionMode: 'bypassPermissions',
      }
    });
    try {
      return await tempQuery.rewindFiles(userMessageId);
    } finally {
      if ('interrupt' in tempQuery && typeof (tempQuery as any).interrupt === 'function') {
        (tempQuery as any).interrupt();
      }
    }
  }
```

- [ ] **Step 4: Add enableFileCheckpointing to commonOptions**

In `src/agents/claude-runner.ts`, in the `commonOptions` object (around line 677), add:

```typescript
    const commonOptions = {
      cwd: projectPath,
      model: this.model,
      ...(this.effort ? { effort: this.effort } : {}),
      autoCompactWindow: 200000,
      advisorModel: 'haiku',
      canUseTool: canUseToolCallback,
      permissionMode: sdkPermissionMode,
      persistSession: true,
      enableFileCheckpointing: true,  // ← ADD THIS LINE
      hooks: {
```

- [ ] **Step 5: Add resumeSessionAt support to createQuery**

In `src/agents/claude-runner.ts`, modify the `createQuery` function. The `resumeSessionId` parameter already exists. We need to also accept an optional `resumeAt` UUID. Change the function signature and both branches:

```typescript
    const createQuery = (promptInput: string | MessageStream, resumeSessionId?: string, resumeAt?: string) => {
      if (useSettingSources) {
        return query({
          prompt: promptInput as any,
          options: {
            ...commonOptions,
            settingSources: ['project', 'user'],
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              ...(excludeDynamic ? { excludeDynamicSections: true } : {}),
              ...(systemPromptAppend ? { append: systemPromptAppend } : {})
            },
            ...(resumeSessionId ? { resume: resumeSessionId } : {}),
            ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
          }
        });
      } else {
        // 旧方式 branch — add same two lines:
        // ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        // ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
      }
    };
```

Then at the call site (line 779), pass the `resumeAt` from session metadata:

```typescript
      // Before creating query, check for pending resumeAt
      let resumeAt: string | undefined;
      if (sessionManager && agentSessionId) {
        const session = await sessionManager.getSessionById?.(sessionId);
        if (session?.metadata?.resumeAt) {
          resumeAt = session.metadata.resumeAt;
          // Clear the resumeAt flag
          const newMeta = { ...session.metadata };
          delete newMeta.resumeAt;
          await sessionManager.updateSession(sessionId, { metadata: newMeta });
          logger.info(`[AgentRunner] Consuming resumeAt: ${resumeAt}`);
        }
      }
      sdkStream = createQuery(prompt, agentSessionId, resumeAt);
```

- [ ] **Step 6: Update AgentRunnerFull interface in types.ts**

In `src/types.ts`, add to the `AgentRunnerFull` interface (after `forkSession`):

```typescript
  /** 读取会话消息历史 */
  getSessionMessages?(agentSessionId: string, projectPath: string): Promise<Array<{
    type: 'user' | 'assistant' | 'system';
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: null;
  }>>;

  /** 回退文件到指定轮次 */
  rewindFiles?(agentSessionId: string, projectPath: string, userMessageId: string): Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
  }>;
```

- [ ] **Step 7: Add resumeAt to SessionMetadata in types.ts**

In `src/types.ts`, add to the `SessionMetadata` interface:

```typescript
  resumeAt?: string;  // /rewind chat 标记的回退点（assistant message uuid）
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/unit/rewind-command.test.ts -v`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/agents/claude-runner.ts src/types.ts tests/unit/rewind-command.test.ts
git commit -m "feat(rewind): add getSessionMessages, rewindFiles, enableFileCheckpointing to AgentRunner"
```

---

### Task 2: Register `/rewind` and `/rw` commands in CommandHandler

**Files:**
- Modify: `src/core/command-handler.ts:130` (commands array)
- Modify: `src/core/command-handler.ts:133` (aliases)
- Modify: `src/core/command-handler.ts:140` (quickCommandPrefixes)
- Modify: `src/core/command-handler.ts:527` (requiresIdle)
- Test: `tests/unit/rewind-command.test.ts`

- [ ] **Step 1: Add /rewind to commands array, aliases, and quickCommandPrefixes**

In `src/core/command-handler.ts`:

Line 130 — append `'/rewind'` to `commands` array:
```typescript
const commands = [...existing..., '/rewind'];
```

Line 133 — add `/rw` alias:
```typescript
const aliases: Record<string, string> = {
  '/p': '/project',
  '/s': '/session',
  '/name': '/rename',
  '/rw': '/rewind'
};
```

Line 140 — add `'/rewind'` and `'/rw '` to `quickCommandPrefixes`:
```typescript
const quickCommandPrefixes = [...existing..., '/rewind', '/rw '];
```

Line 527 — add `/rewind` to `requiresIdle`:
```typescript
const requiresIdle = [...existing..., '/rewind'];
```

- [ ] **Step 2: Add /rewind to admin help text**

In the help text section (around line 409), add entry:
```typescript
{ cmd: '/rewind', args: '[N] [chat|file|all]', label: '查看历史/回退会话' },
```

Alias `/rw` should also be documented.

- [ ] **Step 3: Commit**

```bash
git add src/core/command-handler.ts
git commit -m "feat(rewind): register /rewind and /rw commands"
```

---

### Task 3: Implement `/rewind` history display and rewind execution

**Files:**
- Modify: `src/core/command-handler.ts` (add handler block + helper methods)
- Test: `tests/unit/rewind-command.test.ts`

- [ ] **Step 1: Add /rewind handler block in command-handler.ts**

Insert after the `/fork` handler block (around line 2362). The handler dispatches three forms:

```typescript
    // /rewind 命令：查看历史 / 回退会话
    if (normalizedContent === '/rewind' || normalizedContent.startsWith('/rewind ')) {
      const result = await this.ensureSession(channel, channelId, threadId);
      if ('error' in result) return result.error;
      const { session } = result;

      const rewindAgent = this.getAgent(session.agentId);

      // 仅 Claude 后端支持
      if (rewindAgent.name !== 'claude') {
        return '❌ /rewind 仅支持 Claude 后端';
      }
      if (!session.agentSessionId) {
        return '❌ 当前会话无历史记录\n\n请先发送一条消息，然后再使用 /rewind';
      }
      if (!rewindAgent.getSessionMessages) {
        return '❌ 当前 Agent 不支持 /rewind';
      }

      const args = normalizedContent.slice('/rewind'.length).trim();

      // 无参数：显示历史
      if (!args) {
        return await this.handleRewindList(session, rewindAgent);
      }

      // 解析 N 和 mode
      const parts = args.split(/\s+/);
      const turnNum = parseInt(parts[0], 10);
      if (isNaN(turnNum) || turnNum < 1) {
        return '❌ 无效轮次，用法：/rewind <N> chat|file|all';
      }

      const mode = parts[1]?.toLowerCase();
      if (!mode) {
        return `❌ 请指定回退模式：/rewind ${turnNum} chat | file | all`;
      }
      if (!['chat', 'file', 'all'].includes(mode)) {
        return `❌ 无效模式 "${mode}"，可选：chat | file | all`;
      }

      return await this.handleRewind(
        session, rewindAgent, turnNum, mode as 'chat' | 'file' | 'all'
      );
    }
```

- [ ] **Step 2: Implement buildTurnList and extractUserContent helpers**

Add private methods to `CommandHandler` class:

```typescript
  /** 从 SDK 消息列表构建轮次列表 */
  private buildTurnList(messages: Array<{
    type: string; uuid: string; message: unknown
  }>): Array<{
    index: number; userContent: string;
    userUuid: string; assistantUuid: string;
  }> {
    const turns: typeof result = [];
    let pendingUser: { content: string; uuid: string } | null = null;

    for (const msg of messages) {
      if (msg.type === 'user') {
        // 跳过 tool_result-only 消息（SDK 将工具结果嵌入 user 消息）
        const m = msg.message as any;
        if (Array.isArray(m?.content)
            && m.content.every((c: any) => c.type === 'tool_result')) {
          continue;
        }
        const content = this.extractUserContent(msg.message);
        if (content) {
          pendingUser = { content, uuid: msg.uuid };
        }
      } else if (msg.type === 'assistant' && pendingUser) {
        turns.push({
          index: turns.length + 1,
          userContent: pendingUser.content,
          userUuid: pendingUser.uuid,
          assistantUuid: msg.uuid,
        });
        pendingUser = null;
      }
    }
    return turns;
  }

  /** 提取用户消息文本（截断到 50 字符） */
  private extractUserContent(message: unknown): string {
    const m = message as any;
    let text = '';
    if (typeof m?.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m?.content)) {
      text = m.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join(' ');
    }
    text = text.trim().replace(/\s+/g, ' ');
    if (!text) return '';
    return text.length > 50 ? text.substring(0, 50) + '…' : text;
  }
```

- [ ] **Step 3: Implement handleRewindList**

```typescript
  private async handleRewindList(
    session: Session, agent: AgentRunnerFull
  ): Promise<string> {
    try {
      const messages = await agent.getSessionMessages!(
        session.agentSessionId!, session.projectPath
      );
      const turns = this.buildTurnList(messages);

      if (turns.length === 0) {
        return '📋 当前会话暂无对话记录';
      }

      const lines = turns.map((t, i) => `#${i + 1} ${t.userContent}`);
      return [
        `📋 会话历史 (共 ${turns.length} 轮)`,
        '',
        ...lines,
        '',
        '💡 /rewind <N> chat|file|all',
      ].join('\n');
    } catch (error) {
      logger.error('[CommandHandler] Failed to read session messages:', error);
      return `❌ 读取会话历史失败: ${
        error instanceof Error ? error.message : '未知错误'
      }`;
    }
  }
```

- [ ] **Step 4: Implement handleRewind (chat/file/all)**

```typescript
  private async handleRewind(
    session: Session,
    agent: AgentRunnerFull,
    turnNum: number,
    mode: 'chat' | 'file' | 'all',
  ): Promise<string> {
    try {
      const messages = await agent.getSessionMessages!(
        session.agentSessionId!, session.projectPath
      );
      const turns = this.buildTurnList(messages);

      if (turnNum > turns.length) {
        return `❌ 轮次超出范围，当前共 ${turns.length} 轮`;
      }
      if (turnNum === turns.length) {
        return '❌ 已在最新一轮，无需回退';
      }

      const target = turns[turnNum - 1];
      const results: string[] = [];

      // File rewind (immediate)
      if (mode === 'file' || mode === 'all') {
        if (!agent.rewindFiles) {
          return '❌ 当前 Agent 不支持文件回退';
        }
        const fileResult = await agent.rewindFiles(
          session.agentSessionId!, session.projectPath, target.userUuid
        );
        if (!fileResult.canRewind) {
          if (mode === 'file') {
            return `❌ 当前会话无文件快照，无法回退文件${
              fileResult.error ? `\n原因: ${fileResult.error}` : ''
            }`;
          }
          // all mode: file failed, still do chat
          results.push(`⚠️ 文件回退失败${
            fileResult.error ? `: ${fileResult.error}` : '（无文件快照）'
          }`);
        } else {
          const count = fileResult.filesChanged?.length || 0;
          results.push(`✅ 已恢复文件到第 ${turnNum} 轮的状态（恢复了 ${count} 个文件）`);
        }
      }

      // Chat rewind (deferred — takes effect on next message)
      if (mode === 'chat' || mode === 'all') {
        const meta = { ...(session.metadata || {}), resumeAt: target.assistantUuid };
        await this.sessionManager.updateSession(session.id, { metadata: meta });

        const discarded = turns.length - turnNum;
        results.push(
          `✅ 已标记对话回退到第 ${turnNum} 轮："${target.userContent}"`,
          `下次发言将从此处继续（后续 ${discarded} 轮对话将被丢弃）`
        );
      }

      this.eventBus.publish({
        type: 'session:rewind',
        sessionId: session.id,
        turnNum,
        mode,
      });

      return results.join('\n');
    } catch (error) {
      logger.error('[CommandHandler] Rewind failed:', error);
      return `❌ 回退失败: ${
        error instanceof Error ? error.message : '未知错误'
      }`;
    }
  }
```

- [ ] **Step 5: Write tests for history display and rewind**

```typescript
// tests/unit/rewind-command.test.ts — append

describe('/rewind history display', () => {
  it('should display numbered user messages', async () => {
    // Setup: mock agent with getSessionMessages returning 3 turns
    // Call: handler.handle('/rewind', ...)
    // Assert: output contains '#1', '#2', '#3' and truncated content
  });

  it('should return empty message for no history', async () => {
    // getSessionMessages returns []
    // Assert: '📋 当前会话暂无对话记录'
  });

  it('should skip tool_result-only user messages', async () => {
    // Include user messages with only tool_result content blocks
    // Assert: those are not counted as turns
  });
});

describe('/rewind N chat', () => {
  it('should store resumeAt in session metadata', async () => {
    // Call: handler.handle('/rewind 2 chat', ...)
    // Assert: sessionManager.updateSession called with metadata.resumeAt = assistant uuid
  });

  it('should reject out-of-range turn number', async () => {
    // 3 turns, /rewind 5 chat → '❌ 轮次超出范围，当前共 3 轮'
  });

  it('should reject rewind to last turn', async () => {
    // 3 turns, /rewind 3 chat → '❌ 已在最新一轮，无需回退'
  });

  it('should reject missing mode', async () => {
    // /rewind 2 → '❌ 请指定回退模式：/rewind 2 chat | file | all'
  });
});

describe('/rewind N file', () => {
  it('should call rewindFiles with user message uuid', async () => {
    // Call: handler.handle('/rewind 2 file', ...)
    // Assert: agent.rewindFiles called with userUuid of turn 2
  });

  it('should report file count on success', async () => {
    // rewindFiles returns { canRewind: true, filesChanged: ['a.ts', 'b.ts'] }
    // Assert: output contains '恢复了 2 个文件'
  });

  it('should report error when no snapshots', async () => {
    // rewindFiles returns { canRewind: false, error: 'no checkpoints' }
    // Assert: output contains '无文件快照'
  });
});

describe('/rewind N all', () => {
  it('should execute both file and chat rewind', async () => {
    // Assert: both rewindFiles called AND metadata.resumeAt set
  });

  it('should continue chat rewind even if file rewind fails', async () => {
    // rewindFiles returns { canRewind: false }
    // Assert: output contains warning + chat rewind success
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run tests/unit/rewind-command.test.ts -v`

- [ ] **Step 7: Commit**

```bash
git add src/core/command-handler.ts tests/unit/rewind-command.test.ts
git commit -m "feat(rewind): implement history display and rewind execution (chat/file/all)"
```

---

### Task 4: Consume `resumeAt` in runQuery and final integration

**Files:**
- Modify: `src/agents/claude-runner.ts` (runQuery — consume resumeAt from session metadata)
- Modify: `src/core/command-handler.ts` (event type registration)
- Test: `tests/unit/rewind-command.test.ts`

- [ ] **Step 1: Modify runQuery to consume resumeAt**

In `src/agents/claude-runner.ts`, in `runQuery()` method, before the `createQuery` call (around line 778), add logic to check for pending `resumeAt`:

```typescript
    // Check for pending resumeAt (set by /rewind N chat)
    let resumeAt: string | undefined;
    if (sessionManager && agentSessionId) {
      try {
        const currentSession = await sessionManager.getSessionById?.(sessionId);
        if (currentSession?.metadata?.resumeAt) {
          resumeAt = currentSession.metadata.resumeAt;
          // Clear the resumeAt flag immediately
          const newMeta = { ...currentSession.metadata };
          delete newMeta.resumeAt;
          await sessionManager.updateSession(sessionId, { metadata: newMeta });
          logger.info(`[AgentRunner] Consuming resumeAt: ${resumeAt}`);
        }
      } catch (err) {
        logger.warn('[AgentRunner] Failed to check resumeAt:', err);
      }
    }
```

Then modify the `createQuery` call to pass `resumeAt`:
```typescript
    sdkStream = createQuery(prompt, agentSessionId, resumeAt);
```

- [ ] **Step 2: Modify createQuery to accept resumeAt parameter**

Change the `createQuery` function signature:
```typescript
    const createQuery = (
      promptInput: string | MessageStream,
      resumeSessionId?: string,
      resumeAt?: string
    ) => {
```

In both branches (useSettingSources and legacy), add:
```typescript
    ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
```

alongside the existing `resume` spread.

- [ ] **Step 3: Add getSessionById to SessionManager if not present**

Check if `sessionManager.getSessionById()` exists. If not, add:

```typescript
  getSessionById(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    return row ? this.rowToSession(row) : null;
  }
```

(Note: `runQuery` receives `sessionManager` as `any`, so the method just needs to exist.)

- [ ] **Step 4: Add event type for session:rewind**

In `src/core/event-bus.ts`, add `'session:rewind'` to the event type union if it uses a typed event system. If EventBus is generic (accepts any `type` string), no change needed.

- [ ] **Step 5: Write integration test for resumeAt consumption**

```typescript
describe('resumeAt consumption in runQuery', () => {
  it('should pass resumeSessionAt to SDK query when resumeAt is set', async () => {
    // Setup: session with metadata.resumeAt = 'assistant-uuid-123'
    // Mock sessionManager.getSessionById to return that session
    // Mock sessionManager.updateSession
    // Call runQuery
    // Assert: SDK query() called with resumeSessionAt: 'assistant-uuid-123'
    // Assert: sessionManager.updateSession called to clear resumeAt
  });

  it('should not pass resumeSessionAt when no resumeAt in metadata', async () => {
    // Setup: session without resumeAt
    // Assert: SDK query() called without resumeSessionAt
  });
});
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All existing tests pass + new rewind tests pass.

- [ ] **Step 7: Build verification**

Run: `npm run build`
Expected: No TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/agents/claude-runner.ts src/core/command-handler.ts src/core/session/session-manager.ts tests/unit/rewind-command.test.ts
git commit -m "feat(rewind): consume resumeAt in runQuery, complete /rewind implementation"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | SDK methods + enableFileCheckpointing | `claude-runner.ts`, `types.ts` |
| 2 | Command registration | `command-handler.ts` |
| 3 | History display + rewind execution | `command-handler.ts` |
| 4 | resumeAt consumption + integration | `claude-runner.ts`, `session-manager.ts` |

**Total estimated changes:** ~250 lines of production code, ~200 lines of tests.
