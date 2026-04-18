# Changelog

## v2.4.0 (2026-04-18)

### New Features

- **AUN CLI overhaul** — 全面重构 AUN 命令行客户端：文件传输（`//sendfile`）、消息历史（`//history`）、群组管理（`//qid`）、AID 快速切换（`//aid`）、数据日志查看器（`aun --log N`，支持 JSON 高亮和跨天轮转）
- **AUN SDK monkey-patches** — 修复 E2EEManager 三个 bug：`clean_expired_caches` 缺失、GroupE2EEManager `_prekey_cache` 引用错误、`sender_fingerprint` 错误 fallback 到 SPKI
- **AUN group ID format** — 支持 `g-xxx.agentid.pub` 格式的群组 ID 识别
- **AUN @mention extraction** — 群聊中支持 `@aid` mention 补全和提取

### Improvements

- **Interactive card lifecycle** — 发送新交互卡片时自动作废旧卡片（PATCH 置灰 + 取消回调），统一 `sendInteractionCard` 流程
- **`patchInteractionCard` adapter** — ChannelAdapter 和 FeishuChannel 新增卡片 PATCH 能力，`sendInteraction` 返回 `message_id`
- **Reply context per-message** — `replyContext` 从 session 级改为 message 级（跟着任务走），修复中断后回复上下文丢失和话题路由问题
- **`evolclaw logs` enhanced** — 彩色日志渲染、`--level`/`--module` 过滤、`--raw` 原始模式、长消息自动截断（200 字符）
- **StreamFlusher `hasText`** — 仅在含真实文字时消费 `replyToMessageId`，避免纯工具活动消息占用引用
- **Permission mode at creation** — 会话创建时即写入默认权限模式（owner → bypass，guest → readonly），无需运行时推断
- **`/effort` quick command** — `/effort` 加入快速命令路径，不再进入消息队列
- **`/project` `/agent` idle guard** — 加入 `requiresIdle` 列表，处理中不允许切换
- **AUN dep version check** — 依赖检查从缺失检测升级为版本比对（`aun-core>=0.2.4`），版本过低自动升级
- **AUN group commands simplified** — 群命令表从 20+ 扁平命令精简为 7 个分类入口（list/info/user/join/setup/group/quit）
- **AUN send result stripping** — 精简 SDK send 返回值，剔除 E2EE 密文 payload 和重复 event 块

### Bug Fixes

- **Vitest external project exclusion** — 排除 `projects/**` 外部项目测试，避免缺失依赖导致测试失败
- **AUN acknowledge behavior** — acknowledge 不再发送 RPC `message.ack`（网关自动 delivery-ack 已足够），避免发送端重复"已送达"

---

## v2.3.0 (2026-04-15)

### New Features

- **Interactive card UI** — `/perm`、`/model`、`/effort`、`/agent`、`/plist`、`/slist` 命令在飞书中以交互卡片呈现，支持一键操作，不支持卡片的渠道自动降级为纯文本
- **`/effort` command** — 独立的推理强度控制命令（从 `/model` 拆出），支持交互卡片选择
- **Readonly permission mode** — 只读权限模式，拦截所有写入操作（文件写入仅允许 `.evolclaw/tmp/`，Bash 写入命令黑名单）
- **Multi-instance channel support** — 同一渠道类型可配置多个实例（如多个飞书 bot），每个实例独立会话和配置
- **CLI session listing** — `/slist cli` 列出未导入的 CLI 会话，支持卡片一键导入
- **Gemini session resume** — Gemini 后端支持会话恢复（`-r sessionId`）

### Improvements

- **Card lifecycle management** — 发送新卡片时自动作废旧卡片（PATCH 置灰 + 取消回调），避免过期卡片误操作
- **Permission mode defaults** — 会话创建时即写入默认权限模式（owner → bypass，guest → readonly），无需运行时推断
- **Reply quote precision** — StreamFlusher 仅在含真实文字时消费 replyToMessageId，避免纯工具活动消息占用引用
- **InteractionRouter** — 通用交互路由器，管理卡片回调注册、超时清理、会话级取消
- **Channel routing refactor** — session.channel 存储实例名（非渠道类型），多实例场景精确路由
- **Config auto-recovery** — 配置文件丢失时自动从备份恢复（`evolclaw.backup.json` → timestamped → sample）
- **AUN trace logging** — 可选数据追踪日志（`debug.aunTrace`），记录所有收发数据
- **AUN SDK payload update** — payload 格式从字符串升级为对象（适配 SDK 0.3.0 E2EE）
- **Process isolation** — `EVOLCLAW_HOME` 级别进程隔离，orphan cleanup 不再误杀其他实例
- **Local timestamps** — 日志时间戳使用本地时间（替代 UTC ISO 格式）
- **Source directory reorganization** — `src/core/message/`、`src/core/session/` 子目录结构

### Bug Fixes

- **Codex session persistence** — 修复 Codex 会话 ID 未正确持久化的问题
- **Startup warnings** — 消除启动时的冗余日志和警告
- **Error classification** — 新增 "is not valid JSON" API 错误模式（算力池切换场景）
- **`/new` session reset** — 创建新会话时正确清理后端状态（`clearSession`）
- **Self-heal test skip** — 测试环境跳过 self-heal 流程，避免误触 `claude -p`

### Removals

- **Hermes backend archived** — 移除 `hermes-runner.ts`、`hermes-session-file-adapter.ts` 和配置解析器

---

## v2.2.0 (2026-04-09)

### New Features

- **Multi-agent backend** — Claude + Codex dual-agent support with adapter pattern, per-session agent routing
- **AUN channel** — full sidecar-based AUN mesh network channel with auto-reconnect, health monitoring, and `evolclaw init aun` setup wizard
- **Rich content rendering** — LaTeX formula (KaTeX) and Mermaid diagram rendering to PNG images
- **`/check` dashboard** — config integrity validation, stats collector, system health at a glance
- **`/send` command** — cross-channel file send with `[SEND_FILE:]` marker
- **Message recall** — recall/unsend support with FIFO greedy merge
- **Feishu image extraction** — extract images from rich-text (post) messages and pass to Agent
- **Processing status & menu system** — visual processing indicators, interactive menu for commands
- **Project migration** — `evolclaw migrate` command for upgrading project structures
- **IPC status server** — Unix socket daemon status query from CLI

### Improvements

- **Plugin architecture** — agents and channels loaded via plugin system
- **Event bus** — decoupled internal event routing
- **Permission gateway** — tiered permission enforcement refactored as middleware
- **Outbound architecture** — optimized message stream with StreamFlusher per-channel `flushDelay`
- **Group chat FIFO queue** — debounce ceiling and command idle check for group scenarios
- **Persistent processing state** — restart recovery for in-flight messages
- **AUN SDK core** — multi-language reference implementation (Go/JS/Python/TS) added to repository

### Bug Fixes

- **`/status` output** — cleaner display, backfill peerId for legacy private sessions
- **`/stop` interrupt** — publish interrupt event correctly on `/stop` command
- **Feishu isEnabled** — require credentials before marking channel enabled
- **`/model` write-back** — persist model changes to correct config source
- **Thread message leak** — prevent thread messages from leaking to Agent SDK after restart
- **Session agentId** — preserve agentId when creating new sessions
- **Test compatibility** — skip rich-content-renderer tests when optional deps not installed

---

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
