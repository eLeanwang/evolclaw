# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EvolClaw is a lightweight AI Agent gateway system that connects Claude Agent SDK to messaging channels (Feishu, WeChat). It uses unified message processing, a Channel Adapter pattern, and supports multi-project session management.

**Recent Architecture Improvements** (2026-03):
- Unified message processing eliminates ~250 lines of duplicate code
- Interrupt mechanism allows canceling long-running tasks
- Channel adapter pattern makes adding new channels trivial (~15 lines)
- StreamFlusher batches tool activities for better UX
- WeChat ClawBot ilink channel integration (official API, HTTP long-poll)
- Channel type decoupled from core: `Session.channel`/`Message.channel` are `string`, not enum
- Tiered command permissions: user-level vs admin-level commands
- Restart-monitor notifications support all channels (Feishu + WeChat)

## Development Commands

### Build and Run
```bash
# Development mode (hot reload)
npm run dev

# Production build
npm run build
npm start

# Quick start (after npm link)
evolclaw
```

### Testing
```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm test -- --coverage

# Hook verification tests
npm run test:hooks
```

### Configuration
- Config file: `{EVOLCLAW_HOME}/data/evolclaw.json` (default: `~/.evolclaw/data/evolclaw.json`)
- Required fields: `channels.aun.domain`, `channels.aun.agentName`, `projects.defaultPath`
- `agents.anthropic` section is entirely optional — auto-inherited from CLI config:
  ```
  token:   config.agents.anthropic.apiKey  → env.ANTHROPIC_AUTH_TOKEN → ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN
  baseUrl: config.agents.anthropic.baseUrl → env.ANTHROPIC_BASE_URL   → ~/.claude/settings.json env.ANTHROPIC_BASE_URL
  model:   config.agents.anthropic.model   → ~/.claude/settings.json model → 'sonnet'
  ```
  - Placeholder values (e.g., `your-api-key-here`, `api.anthropic.com`) are automatically ignored and fall back to environment variables
- Feishu credentials: use `evolclaw init feishu` for QR code login (channel disabled if missing)
- WeChat config: use `evolclaw init wechat` for QR code login (channel disabled if missing)
- Project list: `projects.list` maps names to absolute paths
- Development mode: set `EVOLCLAW_HOME=/home/evolclaw` to use project directory

## Architecture

### Data Directory
All runtime data is decoupled from the package directory via `EVOLCLAW_HOME`:
```
{EVOLCLAW_HOME}/                # default: ~/.evolclaw
├── data/
│   ├── evolclaw.json
│   ├── sessions.db
│   ├── wechat-sync-buf.txt      # WeChat 长轮询游标（持久化）
│   └── wechat-context-tokens.json # WeChat context_token 缓存（供 restart-monitor 读取）
└── logs/
    ├── evolclaw.pid
    ├── evolclaw.log
    ├── stdout.log
    ├── messages.log
    ├── line-stats.log
    ├── ready.signal          # 启动成功信号（时间戳）
    ├── restart.log           # restart-monitor 日志
    ├── self-heal.md          # 自愈修复记录（活跃）
    └── self-heal-*.md        # 自愈修复记录（归档）
```

Path resolution (`src/paths.ts`):
- `resolveRoot()` → `EVOLCLAW_HOME` env var or `~/.evolclaw`
- `resolvePaths()` → all derived paths (config, db, pid, logs, etc.)
- `ensureDataDirs()` → creates data/ and logs/ directories
- `getPackageRoot()` → package installation directory (via `import.meta.url`)

### Architecture
1. **Message Channel Layer** (`src/channels/`) - Feishu WebSocket, WeChat HTTP long-poll
2. **Message Queue Layer** (`src/core/message-queue.ts`) - Session-level serial processing with interrupt support
3. **Command Processing Layer** (`src/core/command-handler.ts`) - Slash command handling (CommandHandler class)
4. **Message Processing Layer** (`src/core/message-processor.ts`) - Unified event handling for all channels
5. **Session Management Layer** (`src/core/session-manager.ts`) - Multi-project session management
6. **Storage Layer** - JSONL files (SDK-managed) + SQLite metadata

### Entry Point
- **`src/index.ts`** - Main entry (~320 lines, default, production use)
  - Initialization, channel wiring, message queue setup
  - Command processing delegated to `CommandHandler`
  - Uses `AgentRunner` for direct SDK calls

### Message Processing Architecture

**Unified Processing**: All channels use the same event processing logic via `MessageProcessor`:
- Channels only handle I/O (connect, send, receive)
- `MessageProcessor` handles all event processing, tool activity formatting, and file markers
- `StreamFlusher` batches tool activities in 3-second windows
- Interrupt mechanism allows users to cancel long-running tasks

**Channel Adapter Pattern** (channel-agnostic core):
```typescript
interface ChannelAdapter {
  name: string;
  sendText(channelId: string, text: string): Promise<void>;
  sendFile?(channelId: string, filePath: string): Promise<void>;
  isGroupChat?(channelId: string): Promise<boolean>;  // 群聊检测，不实现则默认 false
}
```

**Channel decoupling**: Core types (`Session.channel`, `Message.channel`, `CommandHandler`) use `string`, not a union enum. Adding a new channel requires zero changes to `session-manager.ts`, `message-processor.ts`, or `command-handler.ts`. All channel-specific state (e.g., WeChat `context_token`, Feishu `replyToMessageId`) stays inside the channel implementation.

**File handling dispatch**: `index.ts` uses `adapter.sendFile` capability check (not channel name) to decide whether to process `[SEND_FILE:]` markers. No `if (channel === 'feishu')` branches in core.

**Message Flow**:
```
User Message → Channel.onMessage → MessageQueue.enqueue
  ↓
[Check if processing] → Yes → Trigger interrupt immediately
  ↓                            ↓
  No                    AgentRunner.interrupt()
  ↓                            ↓
MessageQueue.processNext  ←────┘
  ↓
MessageProcessor.processMessage
  ↓
├─ Command check → Send result
├─ Resolve session
├─ Create StreamFlusher (3s batching)
├─ AgentRunner.runQuery → Event stream
├─ Process events (system/assistant/result)
├─ Flush accumulated content
├─ Handle file markers (Feishu)
└─ Send final response
```

**Interrupt Mechanism**:
- When a new message arrives while processing, interrupt is triggered immediately
- `AgentRunner` tracks active streams and calls `stream.interrupt()`
- Current task terminates early, new message starts processing
- No polling or delays - interrupt happens at enqueue time

### Session Modes
- **Isolated mode** (default): Each channel session → separate Claude session
- Configured via `data/evolclaw.json` `session.mode` field

## Key Implementation Details

### Unified Message Processing

**MessageProcessor** (`src/core/message-processor.ts`) is the central event processing engine:
- Handles all channel messages through a single code path
- Eliminates ~250 lines of duplicate code between Feishu and AUN handlers
- Supports any tool type (MCP, Skill, Agent, built-in tools) via generic description extraction
- Integrates StreamFlusher for batched tool activity display

**Tool Description Formatting** (works for any tool):
```typescript
formatToolDescription(toolUse) {
  const input = toolUse.input || {};
  return (
    input.description ||
    input.file_path ||
    input.pattern ||
    input.command?.substring(0, 80) ||
    input.prompt?.substring(0, 80) ||
    input.query?.substring(0, 80) ||
    ''
  );
}
```

**StreamFlusher Integration**:
- Tool activities: `flusher.addActivity('🔧 ToolName: description')`
- Result text: `flusher.addText(event.result)`
- Automatic batching: Activities accumulated for 3 seconds before sending
- System events (compact notifications) bypass flusher for immediate delivery

### Message Flow
```
Channel → CommandHandler.handle() → AgentRunner.runQuery() → Extract session_id → Accumulate response → Send to channel
```

Messages starting with `/` are intercepted by `CommandHandler` before reaching the Agent.

### WeChat Channel (`src/channels/wechat.ts`)

**Protocol**: Official WeChat ClawBot ilink API (`ilinkai.weixin.qq.com`), same as `@tencent-weixin/openclaw-weixin`.

**Message flow**: HTTP long-poll (`getupdates`) → extract text + cache `context_token` → `sendTyping` ack → callback to main pipeline → Agent processes → `sendmessage` with `context_token`.

**Internal state** (channel-internal, not exposed to core):
- `contextTokenCache: Map<string, string>` — `from_user_id → context_token` (required for every outbound send)
- `typingTicketCache` — `from_user_id → typing_ticket` with 5min TTL
- `getUpdatesBuf` — sync cursor, persisted to `{EVOLCLAW_HOME}/data/wechat-sync-buf.txt`
- `context_token` also persisted to `wechat-context-tokens.json` for restart-monitor

**Session expired handling** (errcode `-14`):
1. Short pause 30s → retry once
2. If recovered, silently resume
3. If still expired → 10min long pause (outbound blocked via `isSessionPaused()`)
4. After pause, auto-resume polling

**Acknowledge**: `sendTyping(status=1)` on message receipt (counterpart to Feishu's ✓ reaction). Requires `typing_ticket` from `getConfig` API, cached with TTL.

**Markdown**: Agent output converted to plain text via `markdownToPlainText()` before sending (WeChat doesn't render markdown).

**Current limitations** (planned for future):
- Text only (no image/file/video CDN upload/download)
- Single chat only (ClawBot doesn't support groups yet)
- Manual token setup via `evolclaw init wechat` (no auto-refresh on expiry)

### File Handling (Feishu Channel)

**System-level integration**: File sending capability is automatically injected at the system level in `src/index.ts`. Every Feishu message includes a system prompt explaining the `[SEND_FILE:路径]` marker, so this works across all projects without requiring project-specific CLAUDE.md configuration.

**Receiving files from users**:
- Files sent by users are automatically downloaded to `{projectPath}/.claude/uploads/`
- Agent receives a prompt: "用户发送了文件：{fileName}\n文件已保存到：{filePath}\n请使用 Read 工具读取并分析文件内容。"
- Use the Read tool to access file contents

**Sending files to users**:
- To send a file through Feishu, include `[SEND_FILE:路径]` marker in your response
- Example: `文件已创建完成！[SEND_FILE:./report.md]` or `[SEND_FILE:/absolute/path/file.txt]`
- The system automatically:
  - Resolves relative paths to absolute paths (relative to project directory)
  - Uploads the file to Feishu
  - Sends the file message
  - Removes the marker from the text response
- **Path resolution**: Relative paths like `./file.txt` are resolved to `{projectPath}/file.txt`
- **Important**: Always use this marker when users ask to receive a file you've created

### Session ID Management
Session IDs are automatically extracted and persisted to database:
- All SDK messages contain a `session_id` field
- The system extracts session IDs during event iteration
- `AgentRunner.updateSessionId()` triggers a callback that persists to database
- The `resume` parameter uses database-stored session IDs to continue sessions
- Database field mapping: snake_case (`claude_session_id`) ↔ camelCase (`claudeSessionId`)

**Persistence flow**:
1. Extract `session_id` from SDK events
2. Call `agentRunner.updateSessionId()` → triggers callback
3. Callback parses sessionId and calls `sessionManager.updateClaudeSessionId()`
4. Next query loads `claudeSessionId` from database and passes to `runQuery()`

### Project Path Switching (Multi-Session)
- Each session binds to a project directory (stored in `sessions.project_path`)
- Claude Agent works in that directory, using its `.claude/` folder
- **Session preservation**: Switching projects preserves each project's session history
- Commands: `/pwd`, `/plist`, `/switch <name|path>`, `/bind <path>`, `/new`, `/status`, `/help`
- Simplified commands (e.g., `/switch`) and full commands (e.g., `/project switch`) both supported

**Key methods**:
- `SessionManager.switchProject()` - Deactivates current session, activates/creates target project session
- `SessionManager.getOrCreateSession()` - Returns active session or creates new one
- `SessionManager.listSessions()` - Lists all sessions for a chat (for debugging)

**Behavior**:
- Switching to a previously used project restores its Claude session
- Switching to a new project creates a fresh session
- `/new` command only clears the active project's session, not others

### Database Schema (Multi-Session Support)
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  claude_session_id TEXT,
  name TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel, channel_id, project_path)
)
```

**Key design**:
- Each `(channel, channel_id, project_path)` combination has its own session
- `name` field allows user-friendly session naming (e.g., "CLI开发", "前端重构")
- `is_active` marks the currently active project for each chat
- Multiple chats (group A, group B, DM A, DM B) work independently
- Each chat can switch between projects while preserving session history

**Database migration**: Automatic on startup - detects old schema and migrates without data loss.

## Testing Strategy

### Test Structure
- `tests/unit/` - Unit tests for core components
- `tests/integration/` - Integration tests for channels

### Multi-Session Testing
Tests verify:
- Multiple chats work independently (group A, B, DM A, B)
- Project switching preserves session history
- Session restoration when switching back to previous project
- `/new` command only affects active project
- Database constraints prevent duplicate sessions

## Available Commands

EvolClaw supports slash commands with **tiered permissions**:

### Command Permissions

| Level | Commands | Who can use |
|-------|----------|-------------|
| **User** | `/new` `/slist` `/s` `/session` `/name` `/rename` `/status` `/help` | All users |
| **Admin** | `/pwd` `/plist` `/project` `/bind` `/restart` `/stop` `/model` `/clear` `/compact` `/repair` `/safe` `/fork` | Owner only |

- Owner is auto-bound on first interaction per channel (stored in `config.owners`)
- Non-admin `/help` only shows user-level commands
- Non-admin `/status` shows simplified info (no paths, IDs, or error details)
- Each user gets isolated sessions via unique `channelId` (Feishu `chat_id`, WeChat `from_user_id`)

### Project Management (Admin)
- `/pwd` - Show current project path
- `/plist` - List all configured projects with session idle time
  - Shows last session activity time for each project (e.g., "2小时前", "30分钟前", "刚刚")
  - Empty if project has no session history
  - Current active project marked with ✓
- `/p <name|path>`, `/project <name|path>` - Switch project
  - Supports project name (from config) or absolute path
  - **Preserves session history** - restores previous session if exists
  - Shows "(恢复已有会话)" or "(新建会话)" in response
- `/bind <path>` - Bind new project directory (群聊首次使用)
  - Must be absolute path
  - Preserves session history like `/switch`

### Session Management (New in v2.1)
- `/new [名称]` - Create new session with optional name
  - Example: `/new CLI开发` creates a session named "CLI开发"
  - Default name: "默认会话" if no name provided
  - Previous session history preserved, accessible via `/slist`
- `/slist` - List all sessions in current project
  - Shows session names, last activity time, and status
  - Active session marked with ✓
- `/s <名称>`, `/session <名称>` - Switch to session by name
  - Example: `/s CLI开发` switches to session named "CLI开发"
  - Continues previous conversation history
  - **Protection**: Cannot switch while processing messages (same project)
- `/name <新名称>`, `/rename <新名称>` - Rename current session
  - Example: `/name 前端重构` renames current session
  - Name must be unique within the same chat
- `/status` - Show session status (channel, IDs, name, project, active status, timestamps)

### Model Management
- `/model` - Show current model and available models
- `/model <model-id>` - Switch to different model

### Help
- `/help` - Show all available commands

**Command Aliases**:
- `/p` = `/project` (quick project switching)
- `/s` = `/session` (quick session switching)
- `/name` = `/rename` (quick renaming)

All commands are processed in `CommandHandler` (`src/core/command-handler.ts`) before being passed to the Agent.

### Adding a New Command
1. Add command to the `commands` array in `src/core/command-handler.ts`
2. Add handler logic in `CommandHandler.handle()` method
3. Interact with `SessionManager` or `AgentRunner` as needed
4. Return response string (or null to pass to Agent)

### Adding a New Channel
1. Create channel class in `src/channels/` implementing:
   - `connect()` / `disconnect()`
   - `onMessage(handler)` - register message callback
   - `sendMessage(id, content)` - send response
2. Create a `ChannelAdapter` in `src/index.ts`:
   ```typescript
   const adapter: ChannelAdapter = {
     name: 'channel-name',
     sendText: (channelId, text) => channel.sendMessage(channelId, text),
     sendFile: (channelId, filePath) => channel.sendFile(channelId, filePath), // optional
     isGroupChat: (channelId) => channel.isGroup(channelId), // optional
   };
   ```
3. Register adapter with `MessageProcessor` and `CommandHandler`:
   ```typescript
   processor.registerChannel(adapter, {
     systemPromptAppend: 'channel-specific instructions',
     fileMarkerPattern: /\[PATTERN:([^\]]+)\]/g,  // optional
     supportsImages: true  // optional
   });
   cmdHandler.registerAdapter(adapter);
   ```
4. Wire up message queue:
   ```typescript
   channel.onMessage(async (id, content) => {
     await messageQueue.enqueue(`channel-${id}`, {
       channel: 'channel-name',
       channelId: id,
       content,
       timestamp: Date.now()
     });
   });
   ```

Total code needed: ~15 lines. All event processing is handled automatically.

### Adding WeChat Channel (Reference Implementation)
WeChat uses a different transport model from Feishu (HTTP long-poll vs WebSocket push), but the adapter pattern makes this transparent to the core:
- `WechatChannel.connect()` starts a background poll loop (not awaited)
- `WechatChannel.sendMessage()` internally manages `context_token` lookup
- `WechatChannel.acknowledgeMessage()` sends typing indicator (counterpart to Feishu ✓ reaction)
- Session expired (`errcode=-14`) handled internally with retry + pause logic
- All channel-specific state stays inside `WechatChannel`, core layer is unaware

## Important Constraints

### TypeScript Module System
- Uses ES modules (`"type": "module"` in package.json)
- All imports must include `.js` extension (even for `.ts` files)
- Example: `import { foo } from './bar.js'` (not `./bar` or `./bar.ts`)

### Claude Agent SDK Integration
- SDK manages JSONL files automatically in `{projectPath}/.claude/`
- Do not manually write to JSONL files
- Use `resume` option to continue existing sessions
- Event stream is AsyncIterable - must iterate to get results

**Event handling**: SDK returns different event formats depending on configuration:
- `text_delta` events: Streaming text chunks (event.text)
- `assistant` events: Complete message format (event.message.content[].text)
- `result` events: Final result (event.result)

**Critical**: Code must handle all three formats. Current implementation in `src/core/message-processor.ts`:
```typescript
if (event.type === 'text_delta') {
  response += event.text;
} else if (event.type === 'assistant' && event.message?.content) {
  for (const content of event.message.content) {
    if (content.type === 'text' && content.text) {
      response += content.text;
    }
  }
} else if (event.type === 'result' && event.result) {
  if (!response) response = event.result;
}
```

**Custom API endpoints**: `baseUrl` is resolved via the fallback chain (config → env → settings.json) and passed directly to `AgentRunner`. No manual `process.env` setup needed.

### Feishu SDK Logging
Console log filtering is applied in `src/index.ts` to suppress noisy Feishu SDK logs (`[info]`, `[ws]` prefixes).

**Message validation**: Feishu API rejects empty or invalid messages with error code 230001. Always validate:
- Response content is not empty before sending
- Content is properly formatted as JSON: `{ text: "..." }`
- Current implementation includes empty message check in `FeishuChannel.sendMessage()`

## Documentation

- `docs/architecture.md` - Detailed architecture and module descriptions
- `docs/multi-project-and-commands.md` - Multi-project support and command reference (v2.0)
- `docs/multi-session-design.md` - Multi-session management design document
- `docs/multi-session-implementation-report.md` - Implementation details and test results
- `docs/wechat-integration-plan.md` - WeChat ilink channel integration plan and design
- `DESIGN-v2.md` - Complete design document with technical validation results
- `README.md` - Quick start and overview

## Development Workflow

1. Make code changes in `src/`
2. Run `npm run dev` for hot reload during development
3. Test with `npm test` or `npm run test:watch`
4. Build with `npm run build` before committing
5. Verify with `evolclaw` command (after `npm link`)

## Critical Files

- `src/index.ts` - Main entry point (~320 lines): channel setup, adapter wiring, message queue
- `src/paths.ts` - Path resolution: `resolveRoot`/`resolvePaths`/`ensureDataDirs`/`getPackageRoot`
- `src/config.ts` - Config loading/saving, re-exports path utilities
- `src/cli.ts` - CLI subcommands (init/start/stop/restart/status/logs), replaces evolclaw.sh
- `src/core/command-handler.ts` - Slash command processing (CommandHandler class)
- `src/core/message-processor.ts` - Unified event processing engine
- `src/core/message-queue.ts` - Serial processing with interrupt support
- `src/core/stream-flusher.ts` - Batched message sending (3s window)
- `src/core/agent-runner.ts` - Claude Agent SDK wrapper with interrupt support
- `src/core/session-manager.ts` - Session-to-project mapping (SQLite-backed)
- `src/channels/feishu.ts` - Production-grade Feishu connection (WebSocket push)
- `src/channels/wechat.ts` - WeChat ClawBot ilink channel (HTTP long-poll)
- `src/utils/init-wechat.ts` - WeChat QR code login setup
- `data/evolclaw.json` - Runtime configuration (not in git, contains secrets)

## Service Management

Use the `evolclaw` CLI for service control (after `npm link`):

```bash
# Initialize config (creates ~/.evolclaw/data/evolclaw.json)
evolclaw init

# WeChat QR code login (writes token to evolclaw.json)
evolclaw init wechat

# Feishu QR code login (writes appId/appSecret to evolclaw.json)
evolclaw init feishu

# Start service
evolclaw start

# Stop service
evolclaw stop

# Restart service
evolclaw restart

# Check status
evolclaw status

# View logs
evolclaw logs
```

Environment variables:
- `EVOLCLAW_HOME` - Data directory (default: `~/.evolclaw`)
- `LOG_LEVEL` - Log level (default: `INFO`)
- `MESSAGE_LOG` - Enable message logging (default: `true`)
- `EVENT_LOG` - Enable event logging (default: `true`)

**Error Handling**: If startup fails, the CLI displays the last 10 lines of stdout log showing the actual error (e.g., missing config file, API key issues).

### Self-Heal Mechanism

When `/restart` triggers `restart-monitor` and the new process fails to start, the system automatically attempts self-repair:

**Ready Signal**: `src/index.ts` writes `logs/ready.signal` (timestamp) after all initialization completes. Both `cmdStart()` and `restart-monitor` use this signal (15s timeout) instead of simple PID checks.

**Self-Heal Flow**:
1. `restart-monitor` detects startup failure (no ready signal within 15s)
2. Invokes `claude -p` CLI with a diagnostic prompt (project dir, log paths, self-heal.md path)
3. Claude reads error logs, analyzes root cause, fixes code, runs `npm run build`
4. Claude appends fix details to `logs/self-heal.md`
5. `restart-monitor` attempts startup again
6. Repeats up to 3 times; notifies Feishu at each step

**self-heal.md Lifecycle**:
- During healing: Claude appends each fix attempt to `logs/self-heal.md`
- On success: Renamed to `logs/self-heal-{timestamp}.md` (archived)
- Next failure: Fresh `self-heal.md` = new problem; archives available for reference

**Channel Notifications**: `notifyChannel()` in `src/cli.ts` routes notifications by `pendingInfo.channel`:
- Feishu: lightweight `lark.Client` directly (no FeishuChannel needed)
- WeChat: direct `ilink/bot/sendmessage` call, reads `context_token` from `wechat-context-tokens.json`

**Key functions** in `src/cli.ts`:
- `spawnAndWaitReady()` - Spawn process + poll for ready.signal
- `invokeClaude()` - Call `claude -p` with diagnostic prompt
- `archiveSelfHealLog()` - Rename self-heal.md on success
- `notifyChannel()` - Lightweight channel-routed notification (Feishu / WeChat)
