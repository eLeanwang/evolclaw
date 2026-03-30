# Changelog

## v2.1.1 (2026-03-30)

### New Features

- **`/model` effort support** — display and switch model reasoning strength (effort)
  - Syntax: `/model` (show current), `/model <model>`, `/model <effort>`, `/model <model> <effort>`, `/model auto`
  - Visual effort indicator: `low ◆◇◇◇`, `medium ◆◆◇◇`, `high ◆◆◆◇`, `max ◆◆◆◆`
  - `max` effort restricted to Opus models only
  - `auto` clears effort setting, letting SDK decide
- **`/del` command** — unbind a session without deleting conversation files
  - Removes session from database while preserving `.claude/` JSONL files
  - Cannot delete the currently active session
- **`/fork` in threads** — fork now works correctly inside Feishu threads

### Improvements

- **Settings write target** — `/model` writes to `~/.claude/settings.json` (user-level), matching Claude CLI behavior
- **Runtime config sync** — model/effort synced from `~/.claude/settings.json` on every query (picks up CLI changes)
- **Config fallback chain** — `evolclaw.json → ~/.claude/settings.json → defaults` for model and effort
- **Thread session tags** — `/slist` shows `[话题]` tag for thread sessions
- **Empty session hint** — `/slist` shows `(空)` for sessions with no conversation history

### Bug Fixes

- **flushDelay double-conversion** — config value in seconds was multiplied by 1000 twice
- **Thread routing for `/compact`** — compact notifications now route to the correct thread
- **Session switch protection** — block cross-context session switching (main ↔ thread)
- **Context limit detection** — SDK throws `"Prompt is too long"` but `classifyError` didn't match it, causing auto-compact to never trigger. Added `prompt is too long` and `context limit` patterns
- **CLI session import** — `importCliSession` now reads session title from JSONL file and always creates a new session record

---

## v2.1.0 (2026-03-27)

### New Features

- **Feishu thread (话题) support** — threads create independent sessions with isolated conversation context
  - Each thread gets its own session (inherits project from main session)
  - Thread sessions run in parallel via `session.id` as queue key
  - Thread-creating message carries quoted content from the original message
  - Thread reply routing: all responses use `reply_in_thread` API
  - Thread command blocking: `/new`, `/slist`, `/fork` etc. disabled in threads
- **Database schema upgrade** — new fields for thread and multi-agent support
  - `thread_id` with partial unique index for thread session isolation
  - `agent_type` / `agent_session_id` (renamed from `claude_session_id`) for future multi-agent support
  - `metadata` JSON field for extensible per-session data (e.g. Feishu `rootId`)
  - Automatic migration preserves existing data
- **Feishu MessageHandler refactor** — 9 positional parameters replaced with `MessageHandlerOptions` interface
- **`/stop` accuracy** — now a quick command with `hasActiveStream()` check, no longer misreports "no active task"

### Bug Fixes

- **Thread command routing** — `/status`, `/help`, `/clear`, `/safe` responses now go to the thread, not main chat
- **Safe mode in threads** — notifications route to thread; hint uses `/clear` instead of `/new`
- **`/restart` in threads** — success notification replies in-thread via saved `rootId`
- **`/stop` in threads** — uses `session.id` as queue key to match thread message routing
- **`backupClaudeDir` EINVAL** — backup to sibling directory instead of inside `.claude` (self-copy error)
- **Thread quote detection** — DB-backed `hasThreadSession()` replaces in-memory Set (survives restarts)
- **Background task detection** — `isBackgroundSession()` helper consolidates 4 duplicate checks; thread sessions never flagged as background

### Code Quality

- Extract `isBackgroundSession()` helper in message-processor (replaces 4 duplicated blocks)
- Extract `getOrCreateThreadSession()` private method in session-manager
- Extract `getThreadSendOpts()` helper for consistent thread reply routing
- Add `AgentRunner.hasActiveStream()` for stream state inspection
- Pass `threadId` through `CommandHandler` type signature and all call sites
- Thread command blocking centralized in `CommandHandler.handle()`

---

**Full diff**: 31 files changed, +1973 / -411 lines

## v2.0.7 (2026-03-26)

### Bug Fixes

- **Session turn count accuracy** — `/status` now shows only real user input turns, excluding auto-generated `tool_result` messages
- **Windows path encoding** — `encodePath()` strips colons from drive letters to match Claude SDK convention

## v2.0.6 (2026-03-26)

### New Features

- **Full Windows compatibility** — EvolClaw now runs natively on Windows (PowerShell / CMD / Git Bash)
  - `getPackageRoot()` uses `import.meta.dirname` to avoid MSYS2 path translation issues
  - CLI entry point detection uses `pathToFileURL` for cross-platform correctness
  - `cleanEnv()` preserves `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` (only clears nesting markers)
  - `checkReady()` prioritizes ready-signal detection to avoid false startup failures on Windows
  - `init` script provides user-friendly permission error messages instead of calling `sudo`
  - `EVOLCLAW_HOME` set via `setx` on Windows (shell profile on Unix)
  - SQLite `ExperimentalWarning` suppressed in all CLI commands and child processes
- **WeChat CDN media download** — image, file, and video messages are now downloaded from WeChat CDN with AES-ECB decryption
- **Feishu @mention extraction** — `@` mentions are parsed and passed through to the Agent instead of being stripped

### Bug Fixes

- **WeChat token validation** — skip placeholder tokens during startup validation
- **SEND_FILE false positives** — filter out illustrative `[SEND_FILE:...]` markers in explanatory text
- **Feishu table rendering** — markdown tables now converted to structured Feishu card format
- **Quoted file download** — download actual file content for quoted file messages instead of showing placeholder
- **CLI session access** — restrict admin commands to owner only, non-admin users see simplified `/status` and `/help`

### Code Quality

- Deduplicate `init.ts`: reuse `isWindows` and `commandExists` from `platform.ts`
- Reuse `platform.isMainScript()` for CLI entry point detection
- Add `platform.ts` with cross-platform process management

### Breaking Changes

None.

---

**Full diff**: 18 files changed, +1001 / -174 lines
