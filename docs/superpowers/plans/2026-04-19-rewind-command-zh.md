# `/rewind` 命令实现计划

> **给 agentic worker：** 必须使用子技能：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 添加 `/rewind` 命令，显示 Claude 对话历史，并支持三种回退模式（chat/file/all）。

**架构：** 扩展 `AgentRunner`，添加 `getSessionMessages()` 和 `rewindFiles()` 方法封装 SDK API。为所有查询添加 `enableFileCheckpointing`。将 `resumeAt` 存储在会话元数据中实现延迟对话回退。命令处理器解析 `/rewind [N] [chat|file|all]` 语法。

**技术栈：** Claude Agent SDK（`getSessionMessages`、带 `resumeSessionAt`/`enableFileCheckpointing` 的 `query`、`rewindFiles`）、SQLite 会话元数据、vitest。

---

### 任务 1：向 AgentRunner 添加 `getSessionMessages` 和 `rewindFiles`

**涉及文件：**
- 修改：`src/agents/claude-runner.ts:1`（imports）
- 修改：`src/agents/claude-runner.ts:677`（commonOptions — 添加 enableFileCheckpointing）
- 修改：`src/agents/claude-runner.ts:702`（createQuery — 添加 resumeSessionAt 支持）
- 修改：`src/agents/claude-runner.ts:897`（forkSession 之后 — 添加新方法）
- 修改：`src/types.ts:136`（AgentRunnerFull 接口）
- 修改：`src/types.ts:136`（SessionMetadata 接口）
- 测试：`tests/unit/rewind-command.test.ts`

- [ ] **步骤 1：编写 getSessionMessages 的失败测试**

```typescript
// tests/unit/rewind-command.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SDK 模块
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  forkSession: vi.fn(),
  getSessionMessages: vi.fn(),
}));

import { getSessionMessages as sdkGetSessionMessages } from '@anthropic-ai/claude-agent-sdk';

describe('/rewind 命令', () => {
  describe('getSessionMessages', () => {
    it('应使用正确参数调用 SDK getSessionMessages', async () => {
      const mockMessages = [
        { type: 'user', uuid: 'u1', session_id: 's1', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null },
        { type: 'assistant', uuid: 'a1', session_id: 's1', message: { role: 'assistant', content: 'hi' }, parent_tool_use_id: null },
      ];
      vi.mocked(sdkGetSessionMessages).mockResolvedValue(mockMessages);

      // mock 设置后再导入
      const { AgentRunner } = await import('../../src/agents/claude-runner.js');
      const runner = new (AgentRunner as any)({ agents: { anthropic: {} } });
      const result = await runner.getSessionMessages('session-123', '/home/project');

      expect(sdkGetSessionMessages).toHaveBeenCalledWith('session-123', { dir: '/home/project' });
      expect(result).toEqual(mockMessages);
    });
  });
});
```

- [ ] **步骤 2：运行测试，确认失败**

运行：`npx vitest run tests/unit/rewind-command.test.ts -v`
预期：FAIL — `runner.getSessionMessages is not a function`

- [ ] **步骤 3：添加 SDK import 和 getSessionMessages 方法**

在 `src/agents/claude-runner.ts` 中，更新第 1 行的 import：

```typescript
import { query, forkSession as sdkForkSession, getSessionMessages as sdkGetSessionMessages } from '@anthropic-ai/claude-agent-sdk';
```

在 `forkSession` 之后（第 900 行之后）添加方法：

```typescript
  async getSessionMessages(agentSessionId: string, projectPath: string) {
    return sdkGetSessionMessages(agentSessionId, { dir: projectPath });
  }

  async rewindFiles(agentSessionId: string, projectPath: string, userMessageId: string) {
    // 创建临时 query 以访问 rewindFiles
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

- [ ] **步骤 4：向 commonOptions 添加 enableFileCheckpointing**

在 `src/agents/claude-runner.ts` 的 `commonOptions` 对象中（约第 677 行），添加：

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
      enableFileCheckpointing: true,  // ← 添加此行
      hooks: {
```

- [ ] **步骤 5：向 createQuery 添加 resumeSessionAt 支持**

修改 `createQuery` 函数，接受可选的 `resumeAt` UUID 参数：

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
        // 旧方式分支 — 同样添加两行：
        // ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        // ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
      }
    };
```

- [ ] **步骤 6：更新 types.ts 中的 AgentRunnerFull 接口**

在 `src/types.ts` 的 `AgentRunnerFull` 接口中（`forkSession` 之后）添加：

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

- [ ] **步骤 7：向 SessionMetadata 添加 resumeAt**

在 `src/types.ts` 的 `SessionMetadata` 接口中添加：

```typescript
  resumeAt?: string;  // /rewind chat 标记的回退点（assistant message uuid）
```

- [ ] **步骤 8：运行测试，确认通过**

运行：`npx vitest run tests/unit/rewind-command.test.ts -v`
预期：PASS

- [ ] **步骤 9：提交**

```bash
git add src/agents/claude-runner.ts src/types.ts tests/unit/rewind-command.test.ts
git commit -m "feat(rewind): add getSessionMessages, rewindFiles, enableFileCheckpointing to AgentRunner"
```

---

### 任务 2：在 CommandHandler 中注册 `/rewind` 和 `/rw` 命令

**涉及文件：**
- 修改：`src/core/command-handler.ts:130`（commands 数组）
- 修改：`src/core/command-handler.ts:133`（aliases）
- 修改：`src/core/command-handler.ts:140`（quickCommandPrefixes）
- 修改：`src/core/command-handler.ts:527`（requiresIdle）
- 测试：`tests/unit/rewind-command.test.ts`

- [ ] **步骤 1：添加 /rewind 到 commands、aliases 和 quickCommandPrefixes**

在 `src/core/command-handler.ts` 中：

第 130 行 — 向 `commands` 数组追加 `'/rewind'`：
```typescript
const commands = [...已有命令..., '/rewind'];
```

第 133 行 — 添加 `/rw` 别名：
```typescript
const aliases: Record<string, string> = {
  '/p': '/project',
  '/s': '/session',
  '/name': '/rename',
  '/rw': '/rewind'
};
```

第 140 行 — 向 `quickCommandPrefixes` 添加 `'/rewind'` 和 `'/rw '`：
```typescript
const quickCommandPrefixes = [...已有前缀..., '/rewind', '/rw '];
```

第 527 行 — 向 `requiresIdle` 添加 `/rewind`：
```typescript
const requiresIdle = [...已有命令..., '/rewind'];
```

- [ ] **步骤 2：在帮助文本中添加 /rewind 条目**

在帮助文本区域（约第 409 行）添加：
```typescript
{ cmd: '/rewind', args: '[N] [chat|file|all]', label: '查看历史/回退会话' },
```

同时记录 `/rw` 别名。

- [ ] **步骤 3：提交**

```bash
git add src/core/command-handler.ts
git commit -m "feat(rewind): register /rewind and /rw commands"
```

---

### 任务 3：实现 `/rewind` 历史显示和回退执行

**涉及文件：**
- 修改：`src/core/command-handler.ts`（添加处理块 + 辅助方法）
- 测试：`tests/unit/rewind-command.test.ts`

- [ ] **步骤 1：在 command-handler.ts 中添加 /rewind 处理块**

在 `/fork` 处理块之后插入（约第 2362 行）：

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

- [ ] **步骤 2：实现 buildTurnList 和 extractUserContent 辅助方法**

```typescript
  /** 从 SDK 消息列表构建轮次列表 */
  private buildTurnList(messages: Array<{
    type: string; uuid: string; message: unknown
  }>): Array<{
    index: number; userContent: string;
    userUuid: string; assistantUuid: string;
  }> {
    const turns: Array<{ index: number; userContent: string; userUuid: string; assistantUuid: string }> = [];
    let pendingUser: { content: string; uuid: string } | null = null;

    for (const msg of messages) {
      if (msg.type === 'user') {
        // 跳过 tool_result-only 消息
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

- [ ] **步骤 3：实现 handleRewindList**

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

- [ ] **步骤 4：实现 handleRewind（chat/file/all）**

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

      // 文件回退（立即执行）
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
          // all 模式：文件失败，仍继续对话回退
          results.push(`⚠️ 文件回退失败${
            fileResult.error ? `: ${fileResult.error}` : '（无文件快照）'
          }`);
        } else {
          const count = fileResult.filesChanged?.length || 0;
          results.push(`✅ 已恢复文件到第 ${turnNum} 轮的状态（恢复了 ${count} 个文件）`);
        }
      }

      // 对话回退（延迟执行 — 下次发消息时生效）
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

- [ ] **步骤 5：编写历史显示和回退的测试**

```typescript
// tests/unit/rewind-command.test.ts — 追加

describe('/rewind 历史显示', () => {
  it('应显示带编号的用户消息', async () => {
    // 设置：mock agent，getSessionMessages 返回 3 轮
    // 调用：handler.handle('/rewind', ...)
    // 断言：输出包含 '#1'、'#2'、'#3' 和截断内容
  });

  it('无历史时应返回空消息', async () => {
    // getSessionMessages 返回 []
    // 断言：'📋 当前会话暂无对话记录'
  });

  it('应跳过 tool_result-only 的用户消息', async () => {
    // 包含只有 tool_result 内容块的用户消息
    // 断言：这些消息不计入轮次
  });
});

describe('/rewind N chat', () => {
  it('应将 resumeAt 存储到会话元数据', async () => {
    // 调用：handler.handle('/rewind 2 chat', ...)
    // 断言：sessionManager.updateSession 以 metadata.resumeAt = assistant uuid 调用
  });

  it('应拒绝超出范围的轮次', async () => {
    // 3 轮，/rewind 5 chat → '❌ 轮次超出范围，当前共 3 轮'
  });

  it('应拒绝回退到最新一轮', async () => {
    // 3 轮，/rewind 3 chat → '❌ 已在最新一轮，无需回退'
  });

  it('应拒绝缺少模式的命令', async () => {
    // /rewind 2 → '❌ 请指定回退模式：/rewind 2 chat | file | all'
  });
});

describe('/rewind N file', () => {
  it('应使用用户消息 uuid 调用 rewindFiles', async () => {
    // 调用：handler.handle('/rewind 2 file', ...)
    // 断言：agent.rewindFiles 以第 2 轮的 userUuid 调用
  });

  it('成功时应报告文件数量', async () => {
    // rewindFiles 返回 { canRewind: true, filesChanged: ['a.ts', 'b.ts'] }
    // 断言：输出包含 '恢复了 2 个文件'
  });

  it('无快照时应报告错误', async () => {
    // rewindFiles 返回 { canRewind: false, error: 'no checkpoints' }
    // 断言：输出包含 '无文件快照'
  });
});

describe('/rewind N all', () => {
  it('应同时执行文件和对话回退', async () => {
    // 断言：rewindFiles 被调用 且 metadata.resumeAt 被设置
  });

  it('文件回退失败时仍应继续对话回退', async () => {
    // rewindFiles 返回 { canRewind: false }
    // 断言：输出包含警告 + 对话回退成功
  });
});
```

- [ ] **步骤 6：运行所有测试**

运行：`npx vitest run tests/unit/rewind-command.test.ts -v`

- [ ] **步骤 7：提交**

```bash
git add src/core/command-handler.ts tests/unit/rewind-command.test.ts
git commit -m "feat(rewind): implement history display and rewind execution (chat/file/all)"
```

---

### 任务 4：在 runQuery 中消费 `resumeAt` 并完成集成

**涉及文件：**
- 修改：`src/agents/claude-runner.ts`（runQuery — 消费会话元数据中的 resumeAt）
- 修改：`src/core/command-handler.ts`（事件类型注册）
- 测试：`tests/unit/rewind-command.test.ts`

- [ ] **步骤 1：修改 runQuery 以消费 resumeAt**

在 `src/agents/claude-runner.ts` 的 `runQuery()` 方法中，在 `createQuery` 调用之前（约第 778 行）添加：

```typescript
    // 检查待处理的 resumeAt（由 /rewind N chat 设置）
    let resumeAt: string | undefined;
    if (sessionManager && agentSessionId) {
      try {
        const currentSession = await sessionManager.getSessionById?.(sessionId);
        if (currentSession?.metadata?.resumeAt) {
          resumeAt = currentSession.metadata.resumeAt;
          // 立即清除 resumeAt 标记
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

然后修改 `createQuery` 调用以传入 `resumeAt`：
```typescript
    sdkStream = createQuery(prompt, agentSessionId, resumeAt);
```

- [ ] **步骤 2：修改 createQuery 以接受 resumeAt 参数**

修改函数签名：
```typescript
    const createQuery = (
      promptInput: string | MessageStream,
      resumeSessionId?: string,
      resumeAt?: string
    ) => {
```

在两个分支（useSettingSources 和旧方式）中均添加：
```typescript
    ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
```

与现有的 `resume` 展开并列。

- [ ] **步骤 3：如不存在则向 SessionManager 添加 getSessionById**

检查 `sessionManager.getSessionById()` 是否存在。若不存在，添加：

```typescript
  getSessionById(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    return row ? this.rowToSession(row) : null;
  }
```

（注意：`runQuery` 以 `any` 类型接收 `sessionManager`，因此该方法只需存在即可。）

- [ ] **步骤 4：添加 session:rewind 事件类型**

在 `src/core/event-bus.ts` 中，如果使用了类型化事件系统，则向事件类型联合中添加 `'session:rewind'`。若 EventBus 是泛型（接受任意 `type` 字符串），则无需修改。

- [ ] **步骤 5：编写 resumeAt 消费的集成测试**

```typescript
describe('runQuery 中的 resumeAt 消费', () => {
  it('当 resumeAt 已设置时应向 SDK query 传入 resumeSessionAt', async () => {
    // 设置：会话元数据中 resumeAt = 'assistant-uuid-123'
    // Mock sessionManager.getSessionById 返回该会话
    // Mock sessionManager.updateSession
    // 调用 runQuery
    // 断言：SDK query() 以 resumeSessionAt: 'assistant-uuid-123' 调用
    // 断言：sessionManager.updateSession 被调用以清除 resumeAt
  });

  it('元数据中无 resumeAt 时不应传入 resumeSessionAt', async () => {
    // 设置：会话无 resumeAt
    // 断言：SDK query() 调用时不含 resumeSessionAt
  });
});
```

- [ ] **步骤 6：运行完整测试套件**

运行：`npm test`
预期：所有现有测试通过 + 新的 rewind 测试通过。

- [ ] **步骤 7：构建验证**

运行：`npm run build`
预期：无 TypeScript 错误。

- [ ] **步骤 8：提交**

```bash
git add src/agents/claude-runner.ts src/core/command-handler.ts src/core/session/session-manager.ts tests/unit/rewind-command.test.ts
git commit -m "feat(rewind): consume resumeAt in runQuery, complete /rewind implementation"
```

---

## 汇总

| 任务 | 描述 | 关键文件 |
|------|------|----------|
| 1 | SDK 方法 + enableFileCheckpointing | `claude-runner.ts`、`types.ts` |
| 2 | 命令注册 | `command-handler.ts` |
| 3 | 历史显示 + 回退执行 | `command-handler.ts` |
| 4 | resumeAt 消费 + 集成 | `claude-runner.ts`、`session-manager.ts` |

**预计改动量：** 约 250 行生产代码，约 200 行测试代码。
