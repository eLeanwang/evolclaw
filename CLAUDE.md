# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EvolClaw is a lightweight AI Agent gateway system that connects Claude Agent SDK to messaging channels (Feishu). It uses unified message processing, a Channel Adapter pattern, and supports multi-project session management.

**Recent Architecture Improvements** (2026-03):
- Unified message processing eliminates ~250 lines of duplicate code
- Interrupt mechanism allows canceling long-running tasks
- Channel adapter pattern makes adding new channels trivial (~15 lines)
- StreamFlusher batches tool activities for better UX

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
- Config file: `data/config.json`
- Required fields: `acp.domain`, `acp.agentName`, `projects.defaultPath`
- `anthropic` section is entirely optional — auto-inherited from CLI config:
  ```
  token:   config.anthropic.apiKey  → env.ANTHROPIC_AUTH_TOKEN → ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN
  baseUrl: config.anthropic.baseUrl → env.ANTHROPIC_BASE_URL   → ~/.claude/settings.json env.ANTHROPIC_BASE_URL
  model:   config.anthropic.model   → ~/.claude/settings.json model → 'sonnet'
  ```
- Feishu credentials optional (channel disabled if missing)
- Project list: `projects.list` maps names to absolute paths

## Architecture

### Architecture
1. **Message Channel Layer** (`src/channels/`) - Feishu WebSocket
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

**Channel Adapter Pattern**:
```typescript
interface ChannelAdapter {
  name: string;
  sendText(channelId: string, text: string): Promise<void>;
  sendFile?(channelId: string, filePath: string): Promise<void>;
  isGroupChat?(channelId: string): Promise<boolean>;  // 群聊检测，不实现则默认 false
}
```

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
- Configured via `data/config.json` `session.mode` field

## Key Implementation Details

### Unified Message Processing

**MessageProcessor** (`src/core/message-processor.ts`) is the central event processing engine:
- Handles all channel messages through a single code path
- Eliminates ~250 lines of duplicate code between Feishu and ACP handlers
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

EvolClaw supports slash commands for project and session management:

### Project Management
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
- `src/core/command-handler.ts` - Slash command processing (CommandHandler class)
- `src/core/message-processor.ts` - Unified event processing engine
- `src/core/message-queue.ts` - Serial processing with interrupt support
- `src/core/stream-flusher.ts` - Batched message sending (3s window)
- `src/core/agent-runner.ts` - Claude Agent SDK wrapper with interrupt support
- `src/core/session-manager.ts` - Session-to-project mapping (SQLite-backed)
- `src/channels/feishu.ts` - Production-grade Feishu connection
- `data/config.json` - Runtime configuration (not in git, contains secrets)

## Service Management

Use the `evolclaw.sh` script for service control:

```bash
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

**Error Handling**: If startup fails, the script displays the last 10 lines of stdout log showing the actual error (e.g., missing config file, API key issues).
