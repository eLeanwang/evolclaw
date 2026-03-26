# Changelog

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

- **Session turn count accuracy** — `/status` now shows only real user input turns, excluding auto-generated `tool_result` messages
- **Windows path encoding** — `encodePath()` now strips colons from drive letters (e.g. `C:\Users\...` → `C-Users-...`) to match Claude SDK convention
- **WeChat token validation** — skip placeholder tokens during startup validation
- **SEND_FILE false positives** — filter out illustrative `[SEND_FILE:...]` markers in explanatory text
- **Feishu table rendering** — markdown tables now converted to structured Feishu card format
- **Quoted file download** — download actual file content for quoted file messages instead of showing placeholder
- **CLI session access** — restrict admin commands to owner only, non-admin users see simplified `/status` and `/help`

### Code Quality

- Deduplicate `init.ts`: reuse `isWindows` and `commandExists` from `platform.ts`
- Reuse `platform.isMainScript()` for CLI entry point detection
- Add `platform.ts` with cross-platform process management (137 unit tests)

### Breaking Changes

None.

---

**Full diff**: 18 files changed, +1001 / -174 lines

**npm**: `npm install -g evolclaw@2.0.6`
