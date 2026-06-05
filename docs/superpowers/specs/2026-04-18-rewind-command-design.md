# `/rewind` Command Design

Date: 2026-04-19

## Overview

A multi-purpose slash command:
1. View conversation history (user messages only) for the current Claude session
2. Rewind to a specific turn with three modes: chat-only, file-only, or both

Claude-only. Other backends return a not-supported message.

## Command Syntax

```
/rewind              → Show conversation turn list (user messages only)
/rw                  → Alias for /rewind

/rewind <N> chat     → Chat rewind only (next message resumes from turn N)
/rewind <N> file     → File rewind only (immediately restore files to turn N state)
/rewind <N> all      → Chat + file rewind

/rewind <N>          → Error: missing mode, show usage hint
```

**No default mode** — `/rewind 3` without a mode does NOT execute rewind. Instead:
```
❌ 请指定回退模式：/rewind 3 chat | file | all
```
This prevents accidental rewinds.

## Output Formats

### History List (`/rewind`)

```
📋 会话历史 (共 6 轮)

#1 帮我写一个排序算法
#2 改成归并排序
#3 加上单元测试
#4 测试跑不过，帮我修一下
#5 加一个 benchmark
#6 把结果写到 README

💡 /rewind <N> chat|file|all
```

Each line: index + user message truncated to 50 chars.

### Chat Rewind (`/rewind 3 chat`)

```
✅ 已标记对话回退到第 3 轮："加上单元测试"
下次发言将从此处继续（后续 3 轮对话将被丢弃）
```

### File Rewind (`/rewind 3 file`)

```
✅ 已恢复文件到第 3 轮的状态
恢复了 4 个文件
```

If no snapshots available:
```
❌ 当前会话无文件快照，无法回退文件
```

### Full Rewind (`/rewind 3 all`)

```
✅ 已恢复文件到第 3 轮的状态（恢复了 4 个文件）
✅ 已标记对话回退到第 3 轮："加上单元测试"
下次发言将从此处继续（后续 3 轮对话将被丢弃）
```

## Implementation

### SDK APIs Used

| API | Purpose | UUID source |
|-----|---------|------------|
| `getSessionMessages(sessionId, { dir })` | Read session transcript | — |
| `resumeSessionAt` (query option) | Chat rewind | assistant message uuid |
| `query.rewindFiles(userMessageId)` | File rewind | user message uuid |
| `enableFileCheckpointing` (query option) | Enable file snapshots | — |

**The two rewind APIs use different UUIDs**:
- `resumeSessionAt` → N-th turn **assistant** reply uuid
- `rewindFiles()` → N-th turn **user** message uuid

Each turn must record both user uuid and assistant uuid.

### CLI Implementation Reference

Claude Code CLI implements `resumeSessionAt` via simple message slicing:

```javascript
// In loadInitialMessages:
if (resumeSessionAt) {
  let idx = messages.findIndex(m => m.uuid === resumeSessionAt);
  messages = messages.slice(0, idx + 1);  // truncate
}
```

JSONL file is never modified (append-only). New messages form branches via `parentUuid`.

CLI's three modes:
- `--resume <id> --resume-session-at <uuid>` → chat only
- `--resume <id> --rewind-files <uuid>` → file only
- Both combined → full rewind

### enableFileCheckpointing

**Enabled by default in this implementation.**

Added to `createQuery` in `claude-runner.ts`. When enabled:
- SDK creates file backups before each modification
- Backups stored in `.claude/` directory, managed by SDK
- Disk overhead is minimal (snapshots only on actual file changes)
- All sessions from this version onward have file snapshots

### Data Flow

```
/rewind (no args):
  1. ensureSession() → get session with agentSessionId
  2. SDK getSessionMessages(agentSessionId, { dir: projectPath })
  3. Filter type === 'user'
  4. Format numbered list with truncated content
  5. Return formatted text

/rewind N (no mode):
  → Return: "❌ 请指定回退模式：/rewind N chat | file | all"

/rewind N chat:
  1. ensureSession() → get session with agentSessionId
  2. SDK getSessionMessages → build turn list, validate N
  3. Get N-th turn assistant reply uuid
  4. Store uuid in session.metadata.resumeAt
  5. Return confirmation

  On next user message (in runQuery):
  1. Check session.metadata.resumeAt
  2. If present, pass query({ resume: agentSessionId, resumeSessionAt: uuid })
  3. SDK resumes from that turn
  4. Clear session.metadata.resumeAt

/rewind N file:
  1. ensureSession() → get session with agentSessionId
  2. SDK getSessionMessages → get N-th turn user message uuid
  3. Create temp query (empty prompt + resume + enableFileCheckpointing)
  4. Call query.rewindFiles(userUuid)
  5. Check canRewind in result, error if false
  6. Return confirmation with file count

/rewind N all:
  1. Execute file flow first (immediate file restore)
  2. Execute chat flow (mark rewind point)
  3. Return combined confirmation
```

### Files to Modify

**`src/agents/claude-runner.ts`**:
- Add `getSessionMessages()` method
- Add `rewindFiles(userMessageId)` method (temp query for file rewind)
- Add `enableFileCheckpointing: true` to `createQuery`
- Check `metadata.resumeAt` in `runQuery`, pass `resumeSessionAt` if present

**`src/types.ts`**:
- Add to `AgentRunnerFull`:
  ```typescript
  getSessionMessages?(agentSessionId: string, projectPath: string): Promise<SessionMessage[]>;
  rewindFiles?(agentSessionId: string, projectPath: string, userMessageId: string): Promise<RewindFilesResult>;
  ```

**`src/core/command-handler.ts`**:
- Register `/rewind` and `/rw` commands
- Parse subcommands: no args → list, `N` → hint, `N chat|file|all` → execute
- Permission: admin-only

**`src/core/session/session-manager.ts`**:
- `resumeAt` field in session metadata
- Check and consume before `runQuery`

### Edge Cases

| Case | Behavior |
|------|----------|
| No active session | `"❌ 当前没有活跃会话"` |
| No agentSessionId | `"❌ 当前会话无历史记录"` |
| Non-Claude backend | `"❌ /rewind 仅支持 Claude 后端"` |
| Empty history | `"📋 当前会话暂无对话记录"` |
| N out of range | `"❌ 轮次超出范围，当前共 X 轮"` |
| N = last turn | `"❌ 已在最新一轮，无需回退"` |
| /rewind N (no mode) | `"❌ 请指定回退模式：/rewind N chat \| file \| all"` |
| Invalid mode | `"❌ 无效模式，可选：chat \| file \| all"` |
| Session processing | Blocked by idle check (existing mechanism) |
| No file snapshots | `"❌ 当前会话无文件快照，无法回退文件"` |
| resumeSessionAt fails | `"❌ 回退失败: {error.message}"`, clear metadata.resumeAt |
| Existing unconsumed resumeAt | Overwrite with new value (last `/rewind` wins) |

### Permission

Admin-level command (owner only), consistent with `/fork`, `/clear`, `/compact`.

### Content Extraction

```typescript
function extractUserContent(msg: SessionMessage): string {
  const m = msg.message as any;
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) {
    return m.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join(' ');
  }
  return '';
}
```

Truncate to 50 chars for list display with `…` suffix.

## Scope Exclusions

- No Codex/Gemini support (future extension via `SessionFileAdapter.readMessages()`)
- No pagination for history list — most sessions are < 50 turns
- No `rewindFiles` dry-run mode (preview without executing) — can be added later
