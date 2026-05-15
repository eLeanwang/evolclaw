# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EvolClaw is a lightweight AI Agent gateway system that connects multiple AI backends (Claude, Codex, Hermes) to messaging channels (Feishu, WeChat). It uses unified message processing, a Channel Adapter pattern, and supports multi-project session management.

**Recent Architecture Improvements** (2026-03/04):
- Unified message processing eliminates ~250 lines of duplicate code
- Interrupt mechanism allows canceling long-running tasks
- Channel adapter pattern makes adding new channels trivial (~15 lines)
- StreamFlusher batches tool activities for better UX
- Per-channel flushDelay configuration (Feishu: 4s, WeChat: 2s, configurable)
- Reply context generalization: Channel pre-builds standard `ReplyContext`, Gateway transparently passes through
- WeChat ClawBot ilink channel integration (official API, HTTP long-poll)
- WeChat CDN media download with AES-ECB decryption (image/file/video)
- Feishu @mention extraction and passthrough
- Channel type decoupled from core: `Session.channel`/`Message.channel` are `string`, not enum
- Tiered command permissions: user-level vs admin-level commands
- Restart-monitor notifications support all channels (Feishu + WeChat)
- Full Windows compatibility (path handling, process management, CLI entry point detection)
- Multi-agent backend support: Claude (SDK), Codex (OpenAI Responses API), Hermes (Python bridge), Gemini (CLI subprocess)
- Unified media cache framework with SSRF protection, dedup, and filename sanitization

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
- `agents.claude` section is entirely optional — auto-inherited from CLI config:
  ```
  token:   config.agents.claude.apiKey  → env.ANTHROPIC_AUTH_TOKEN → ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN
  baseUrl: config.agents.claude.baseUrl → env.ANTHROPIC_BASE_URL   → ~/.claude/settings.json env.ANTHROPIC_BASE_URL
  model:   config.agents.claude.model   → ~/.claude/settings.json model → 'sonnet'
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
- `getPackageRoot()` → package installation directory (via `import.meta.dirname`)

### Architecture
1. **Message Channel Layer** (`src/channels/`) - Feishu WebSocket, WeChat HTTP long-poll, AUN sidecar
2. **Message Queue Layer** (`src/core/message/message-queue.ts`) - Session-level serial processing with interrupt support
3. **Command Processing Layer** (`src/core/command-handler.ts`) - Slash command handling (CommandHandler class)
4. **Message Processing Layer** (`src/core/message/message-processor.ts`) - Unified event handling for all channels
5. **Agent Backend Layer** (`src/agents/`) - Claude (SDK), Codex (OpenAI Responses API), Hermes (Python bridge), Gemini (CLI subprocess)
6. **Session Management Layer** (`src/core/session/session-manager.ts`) - Multi-project session management
7. **Plugin Loaders** (`src/core/agent-loader.ts`, `src/core/channel-loader.ts`) - Dynamic agent/channel plugin discovery and initialization
8. **IPC Layer** (`src/ipc.ts`) - Unix socket status server for CLI queries
9. **Storage Layer** - JSONL files (SDK-managed) + SQLite metadata

### Entry Point
- **`src/index.ts`** - Main entry (~560 lines, default, production use)
  - Initialization, channel wiring, message queue setup
  - Plugin-based agent/channel loading via `AgentLoader` and `ChannelLoader`
  - Command processing delegated to `CommandHandler`

### Message Processing Architecture

**Unified Processing**: All channels use the same event processing logic via `MessageProcessor`:
- Channels only handle I/O (connect, send, receive)
- `MessageProcessor` handles all event processing, tool activity formatting, and file markers
- `StreamFlusher` batches tool activities using per-channel `flushDelay` (Feishu: 4s, WeChat: 2s, configurable)
- Interrupt mechanism allows users to cancel long-running tasks

**Channel Adapter Pattern** (channel-agnostic core):
```typescript
interface ChannelAdapter {
  readonly channelName: string;
  sendText(channelId: string, text: string, context?: ReplyContext): Promise<void>;
  sendFile?(channelId: string, filePath: string, context?: ReplyContext): Promise<void>;
  sendImage?(channelId: string, png: Buffer, context?: ReplyContext): Promise<void>;
  acknowledge?(messageId: string): Promise<void>;
  sendProcessingStatus?(channelId: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout', sessionId: string, context?: ReplyContext): void;
  sendCustomPayload?(channelId: string, payload: string): void;
  onChatDissolved?(callback: (channelId: string) => void): void;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}
```

**Channel Configuration** (`ChannelOptions`):
- `flushDelay`: Per-channel flush interval (seconds). Priority: `channelOptions.flushDelay → config.flushDelay → 4`
- `fileMarkerPattern`: Regex for extracting file markers (e.g., `[SEND_FILE:]`)
- `systemPromptAppend`: Channel-specific system prompt additions
- `supportsImages`: Whether channel supports image input

**Reply Context**: Channels pre-build a standard `ReplyContext` at inbound time (e.g., Feishu maps `rootId` to `{ replyToMessageId, replyInThread }`). Gateway transparently passes this through without channel-specific transformations.

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

**MessageProcessor** (`src/core/message/message-processor.ts`) is the central event processing engine:
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

### Hermes Agent Backend (`hermes/` + `src/agents/hermes-runner.ts`)

**Architecture**: Python subprocess bridge connecting EvolClaw's TypeScript runner to Hermes' Python AIAgent.

**Bridge** (`hermes/hermes_bridge.py`):
- Stdin/stdout JSON protocol (one JSON object per line)
- Methods: `query`, `interrupt`, `set_model`, `reset_agent`, `shutdown`
- `TextBuffer` class for tool boundary segmentation (flushes accumulated text on `None` delta signal)
- `AgentManager` holds long-lived AIAgent instance, supports crash recovery
- `HERMES_PROJECT_PATH` env var for `sys.path` injection

**Runner** (`src/agents/hermes-runner.ts`):
- Implements `AgentRunnerFull` + `ModelSwitcher` interfaces
- Long-lived bridge process: spawned once, reused across queries
- Crash detection: `onBridgeExit` callback notifies active event streams
- `clearSession()` sends `reset_agent` (keeps process alive, discards agent state)
- Plugin pattern: `HermesAgentPlugin` checks `pythonPath` + `bridgePath` existence at init

**Config** (`evolclaw.json` → `agents.hermes`):
```json
{
  "agents": {
    "hermes": {
      "pythonPath": "/path/to/.venv/bin/python",
      "bridgePath": "/path/to/hermes_bridge.py",
      "model": "Claude-Sonnet-4.6",
      "provider": "custom",
      "baseUrl": "https://...",
      "apiKey": "sk-..."
    }
  }
}
```

**Config resolution** (`resolveHermesConfig()` in `src/config.ts`):
- `bridgePath` defaults to `{packageRoot}/hermes/hermes_bridge.py`
- `pythonPath` defaults to `{hermesProjectPath}/.venv/bin/python`
- API key chain: config → env `HERMES_API_KEY` → `~/.hermes/.env`
- `hermesProjectPath` resolved from `HERMES_PROJECT_PATH` env or `~/projects/hermes-agent`

**Switching**: Use `/agent hermes` command to switch to Hermes backend per-session.

### Gemini Agent Backend (`src/agents/gemini-runner.ts`)

**Architecture**: Gemini CLI subprocess bridge. Each `runQuery` spawns `gemini -p "prompt" --output-format stream-json`, parsing the JSONL event stream into EvolClaw `AgentEvent`.

**Runner** (`src/agents/gemini-runner.ts`):
- Implements `AgentRunnerFull` + `ModelSwitcher` interfaces
- Per-query subprocess: spawns `gemini` CLI, kills on interrupt
- stdout JSONL parsing via `readline`
- Session resume: passes `-r {sessionId}` to CLI
- Image handling: writes temp files, passes as `@file` references
- Plugin pattern: `GeminiAgentPlugin` checks `commandExists('gemini')`

**Config** (`evolclaw.json` → `agents.gemini`):
```json
{
  "agents": {
    "gemini": {
      "model": "gemini-2.5-flash",
      "cliPath": "/path/to/gemini",
      "apiKey": "optional-api-key"
    }
  }
}
```

**Config resolution** (`resolveGoogleConfig()` in `src/config.ts`):
- `cliPath`: config → `which gemini` (PATH lookup)
- `model`: config → `'gemini-2.5-flash'`
- `apiKey`: config → env `GEMINI_API_KEY` → env `GOOGLE_API_KEY` → undefined (CLI has OAuth)

**Capabilities**: `{ clear: true, compact: false, fork: false }`

**Switching**: Use `/agent gemini` command to switch to Gemini backend per-session.

### Media Cache (`src/utils/media-cache.ts`)

Unified file download/cache/SSRF protection framework, shared across all channels:

- **`sanitizeFileName(name)`** — path traversal prevention, illegal character replacement
- **`validateImage(buffer)`** — image type whitelist (png/jpeg/gif/webp) + 10MB size limit
- **`saveToUploads(buffer, fileName, projectPath)`** — save to `{project}/.evolclaw/uploads/`, auto-dedup via MD5
- **`safeFetch(url, opts?)`** — SSRF-protected download: private IP block + CDN domain whitelist + timeout + size limit
- **`validateUrl(url)`** — URL safety check (protocol, private IP, domain allowlist)
- **`DownloadCache`** — in-memory download cache with TTL (5min) and max entries (100)

**SSRF whitelist**: `novac2c.cdn.weixin.qq.com`, `open.feishu.cn`, `internal-api-lark-file.feishu.cn`

**Channel integration**:
- Feishu: uses `saveToUploads()` + `sanitizeFileName()` for file downloads, `validateImage()` for image validation
- WeChat: uses `safeFetch()` for CDN downloads (with AES-ECB decryption), `saveToUploads()` for file saving

### File Handling (Feishu Channel)

**System-level integration**: File sending capability is automatically injected at the system level in `src/index.ts`. Every Feishu message includes a system prompt explaining the `[SEND_FILE:路径]` marker, so this works across all projects without requiring project-specific CLAUDE.md configuration.

**Receiving files from users**:
- Files sent by users are automatically downloaded to `{projectPath}/.evolclaw/uploads/`
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

## EvolAgent Mode

EvolAgents are first-class agent entities defined by `~/.evolclaw/agents/<name>.json`. Each agent self-contains channels + single baseagent + project + optional chatmode.

### CLI Commands

```bash
evolclaw agent              # 列出所有 agent 及状态
evolclaw agent <name>       # 查看 agent 详情
evolclaw agent new <name>   # 交互式创建新 agent
evolclaw agent reload <name> # 热重载 agent 配置（IPC）
```

删除 agent：直接删 `~/.evolclaw/agents/<name>.json` + `evolclaw restart`。

### agent.json 格式

```json
{
  "name": "review-bot",
  "enabled": true,
  "agents": { "claude": { "model": "sonnet", "effort": "high" } },
  "channels": {
    "aun": { "aid": "review.agentid.pub", "owner": "molian.agentid.pub" }
  },
  "projects": { "defaultPath": "/home/user/projects/review" },
  "chatmode": { "private": "interactive", "group": "proactive" }
}
```

### 运行时行为

- **资源独占**：channel fingerprint `{type}:{primaryKey}` 全局唯一，冲突即报错
- **命令拦截**：agent-owned channel 上 `/project /bind /plist` 禁用，`/agent <name>` 切换禁用
- **Owner 绑定**：首次交互自动绑定，写回 agent.json
- **热重载**：`evolclaw agent reload <name>` 触发 drain → disconnect → reconnect → route-update
- **凭证变更检测**：reload 时 kept channel 的配置变化自动触发重连
- **DefaultAgent**：evolclaw.json 中的 channels 归 DefaultAgent，行为与 evolagent 完全一致

### 关键文件

- `src/core/evolagent.ts` — EvolAgent 类
- `src/core/agent-registry.ts` — AgentRegistry（扫描/冲突检测/路由/热重载）
- `src/core/evolagent-schema.ts` — agent.json 校验
- `src/core/reload-hooks.ts` — 热重载 hooks（drain/disconnect/start）
- `src/utils/channel-fingerprint.ts` — fingerprint 提取 + 重复检测

## Testing Strategy

### Test Structure
- `tests/unit/` - Unit tests for core components
- `tests/integration/` - Integration tests for channels
- 45 test files, ~585 tests (vitest)

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
     channelName: 'channel-name',
     sendText: (channelId, text) => channel.sendMessage(channelId, text),
     sendFile: (channelId, filePath) => channel.sendFile(channelId, filePath), // optional
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

### Windows Compatibility
The project runs on both Unix and Windows. Key rules:
- **Path handling**: Always use `path.join()`, `path.resolve()`, `os.homedir()` — never hardcode `/` in file paths
- **`getPackageRoot()`**: Uses `import.meta.dirname` (Node 21.2+), which returns correct OS-native paths on all platforms including Git Bash/MSYS2
- **Process management**: `src/utils/cross-platform.ts` abstracts all platform differences (`isProcessRunning`, `killProcess`, `findProcesses`, `commandExists`, `tailFile`, `onShutdown`). Use these instead of Unix-specific commands
- **`isMainScript()`**: Use `platform.isMainScript(import.meta.url)` for entry point detection — never use `file://${process.argv[1]}` string concatenation
- **`cleanEnv()`**: Only clears Claude Code nesting markers (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, etc.) — never clear `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL`
- **`init.ts`**: Import `isWindows` and `commandExists` from `cross-platform.ts` — do not redeclare locally
- **Child processes**: Use `--no-warnings=ExperimentalWarning` flag when spawning node subprocesses

### TypeScript Module System
- Uses ES modules (`"type": "module"` in package.json)
- All imports must include `.js` extension (even for `.ts` files)
- Example: `import { foo } from './bar.js'` (not `./bar` or `./bar.ts`)

### Claude Agent SDK Integration
- SDK manages JSONL files automatically in `{projectPath}/.claude/`
- Do not manually write to JSONL files
- Use `resume` option to continue existing sessions
- Event stream is AsyncIterable - must iterate to get results

**Event handling**: All Agent backends emit unified `AgentEvent` types:
- `text` — streaming text chunks
- `tool_use` / `tool_result` — tool invocations and results
- `session_id` — session ID for resume
- `complete` — final result with `isError`, `subtype`, `errors`, `durationMs`
- `error` — runtime errors
- `compact` / `task_progress` — lifecycle events

SDK-specific event formats are normalized in each runner's `transformStream()` before reaching `MessageProcessor`.

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

- `src/index.ts` - Main entry point (~560 lines): channel setup, plugin loading, message queue
- `src/paths.ts` - Path resolution: `resolveRoot`/`resolvePaths`/`ensureDataDirs`/`getPackageRoot`
- `src/config.ts` - Config loading/saving, re-exports path utilities
- `src/cli.ts` - CLI subcommands (init/start/stop/restart/status/logs), replaces evolclaw.sh
- `src/ipc.ts` - Unix socket IPC server for CLI status queries
- `src/types.ts` - Shared type definitions (ChannelAdapter, Config, Session, Message, etc.)
- `src/core/command-handler.ts` - Slash command processing (CommandHandler class)
- `src/core/agent-loader.ts` - Dynamic agent backend plugin discovery/init
- `src/core/channel-loader.ts` - Dynamic channel plugin discovery/init (multi-instance support)
- `src/core/event-bus.ts` - Internal event bus for cross-module communication
- `src/core/permission.ts` - Command permission tier enforcement
- `src/core/message/message-processor.ts` - Unified event processing engine
- `src/core/message/message-queue.ts` - Serial processing with interrupt support
- `src/core/message/stream-flusher.ts` - Batched message sending (3s window)
- `src/core/message/message-cache.ts` - Message history cache
- `src/core/message/stream-debouncer.ts` - Input debouncing for rapid messages
- `src/core/session/session-manager.ts` - Session-to-project mapping (SQLite-backed)
- `src/core/session/session-file-adapter.ts` - Session file management
- `src/core/session/adapters/` - Per-backend session file adapters (claude, codex, gemini, hermes)
- `src/channels/feishu.ts` - Production-grade Feishu connection (WebSocket push)
- `src/channels/wechat.ts` - WeChat ClawBot ilink channel (HTTP long-poll)
- `src/channels/aun.ts` - AUN protocol sidecar channel
- `src/agents/claude-runner.ts` - Claude Agent SDK runner with interrupt support
- `src/agents/codex-runner.ts` - Codex/OpenAI Responses API runner
- `src/agents/hermes-runner.ts` - Hermes Python bridge runner (AgentRunnerFull + ModelSwitcher)
- `src/agents/gemini-runner.ts` - Gemini CLI subprocess runner (AgentRunnerFull + ModelSwitcher)
- `hermes/hermes_bridge.py` - Python bridge: EvolClaw ↔ Hermes AIAgent (stdin/stdout JSON)
- `src/utils/media-cache.ts` - Unified media download/cache/SSRF protection
- `src/utils/init-channel.ts` - Channel init flows (Feishu, WeChat, AUN)
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
