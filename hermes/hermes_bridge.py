#!/usr/bin/env python3
"""
EvolClaw ↔ Hermes Bridge

Stdin/stdout JSON bridge that connects EvolClaw's TypeScript runner
to Hermes' Python AIAgent.  Reads JSON commands from stdin, invokes
AIAgent.run_conversation(), and emits AgentEvent-compatible JSON
lines to stdout.

Protocol (stdin → bridge):
  {"method": "query", "params": {"prompt": "...", "sessionId": "...", "projectPath": "...", "systemPrompt": "..."}}
  {"method": "interrupt"}
  {"method": "set_model", "params": {"model": "..."}}
  {"method": "set_approval_mode", "params": {"mode": "manual|smart|off|deny"}}
  {"method": "approval_response", "params": {"choice": "once|session|deny"}}
  {"method": "shutdown"}

Protocol (bridge → stdout):
  {"type": "session_id", "sessionId": "..."}
  {"type": "text", "text": "..."}
  {"type": "status", "subtype": "...", "message": "..."}
  {"type": "tool_use", "name": "...", "input": {...}}
  {"type": "tool_result", "name": "...", "result": "...", "isError": false}
  {"type": "approval_request", "command": "...", "description": "...", "patternKeys": [...]}
  {"type": "complete", "result": "...", "durationMs": 0}
  {"type": "error", "error": "...", "errorType": "unknown"}

Env vars (set by HermesRunner):
  HERMES_PROJECT_PATH  — path to hermes-agent project (for sys.path)
  HERMES_MODEL         — default model name
  HERMES_BASE_URL      — API base URL
  HERMES_API_KEY       — API key
  HERMES_PROVIDER      — provider name (custom/openrouter/anthropic)
"""

import sys
import os
import json
import time
import asyncio
import logging
import threading
from typing import Any

# Ensure Hermes project root is importable
_hermes_project = os.environ.get('HERMES_PROJECT_PATH', '')
if _hermes_project and _hermes_project not in sys.path:
    sys.path.insert(0, _hermes_project)

# Load Hermes env before any Hermes imports
from pathlib import Path
from hermes_constants import get_hermes_home
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv(
    hermes_home=get_hermes_home(),
    project_env=Path(_hermes_project) / '.env' if _hermes_project else None,
)

from run_agent import AIAgent
from hermes_state import SessionDB

# Enable gateway approval mode — approval.py checks this env var to activate
# the blocking queue-based approval flow instead of CLI interactive prompts.
os.environ['HERMES_GATEWAY_SESSION'] = '1'

# Import approval system for gateway integration
from tools.approval import (
    register_gateway_notify,
    unregister_gateway_notify,
    resolve_gateway_approval,
    set_current_session_key,
)
import tools.approval as _approval_mod

# Monkey-patch _get_approval_mode to respect HERMES_APPROVAL_MODE env var,
# allowing the bridge to switch between manual/smart at runtime without
# modifying Hermes' config.yaml on disk.
_original_get_approval_mode = _approval_mod._get_approval_mode

def _patched_get_approval_mode() -> str:
    env_mode = os.environ.get('HERMES_APPROVAL_MODE')
    if env_mode:
        return env_mode
    return _original_get_approval_mode()

_approval_mod._get_approval_mode = _patched_get_approval_mode

logger = logging.getLogger(__name__)


# ── Emit helpers ──

def emit(event: dict) -> None:
    """Write a JSON event to stdout (one line)."""
    try:
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        pass


def emit_error(msg: str, error_type: str = 'unknown') -> None:
    emit({'type': 'error', 'error': msg, 'errorType': error_type})


def emit_status(subtype: str, message: str) -> None:
    emit({'type': 'status', 'subtype': subtype, 'message': message})


# ── Hermes callback wrappers ──

class TextBuffer:
    """Accumulates streaming text tokens, flushes on boundary signals."""

    def __init__(self):
        self._buf: list[str] = []

    def append(self, text: str) -> None:
        if text:
            self._buf.append(text)

    def flush(self) -> None:
        if self._buf:
            emit({'type': 'text', 'text': ''.join(self._buf)})
            self._buf.clear()


# Shared buffer instance (created per-query in handle_query)
_text_buffer: TextBuffer | None = None


def make_stream_delta_callback():
    """Returns a callback that accumulates text and flushes on tool-call boundaries."""
    def cb(text: str | None):
        if text is None:
            # Boundary signal: text block done, about to execute tools
            if _text_buffer:
                _text_buffer.flush()
        elif text:
            if _text_buffer:
                _text_buffer.append(text)
    return cb


def make_tool_start_callback():
    """Returns a callback that emits tool_use events."""
    def cb(tool_id: str, name: str, args: dict):
        emit({'type': 'tool_use', 'name': name, 'input': args if isinstance(args, dict) else {}})
    return cb


def make_tool_complete_callback():
    """Returns a callback that emits tool_result events."""
    def cb(tool_id: str, name: str, args: dict, result):
        is_error = False
        result_str = ''
        if isinstance(result, dict):
            is_error = result.get('error', False) or result.get('isError', False)
            result_str = result.get('output', '') or result.get('result', '') or json.dumps(result, ensure_ascii=False)
        elif isinstance(result, str):
            result_str = result
        else:
            result_str = str(result) if result else ''

        emit({
            'type': 'tool_result',
            'name': name,
            'result': result_str[:2000],  # truncate large results
            'isError': bool(is_error),
        })
    return cb


def make_status_callback():
    """Returns a callback for status/lifecycle events (optional, logged as text)."""
    def cb(kind: str, message: str):
        if message:
            emit({'type': 'text', 'text': f'[{kind}] {message}'})
    return cb


# ── Agent manager ──

class AgentManager:
    """Manages a single AIAgent instance, handles queries and interrupts."""

    # Session key used for approval system integration.
    # Single-agent bridge, so one key suffices.
    SESSION_KEY = 'evolclaw-bridge'

    def __init__(self):
        self.agent: AIAgent | None = None
        self.model: str = os.environ.get('HERMES_MODEL', 'Claude-Sonnet-4.6')
        self.base_url: str | None = os.environ.get('HERMES_BASE_URL', None)
        self.api_key: str | None = os.environ.get('HERMES_API_KEY', None) or os.environ.get('OPENAI_API_KEY', None)
        self.provider: str = os.environ.get('HERMES_PROVIDER', 'custom')
        self.session_db = SessionDB()
        self._lock = threading.Lock()

        # Register gateway approval callback — when Hermes' approval.py
        # detects a dangerous command, it calls this callback to emit an
        # approval_request event, then blocks the agent thread until
        # resolve_gateway_approval() is called from approval_response.
        set_current_session_key(self.SESSION_KEY)
        register_gateway_notify(self.SESSION_KEY, self._on_approval_request)

    def _create_agent(self, session_id: str | None = None) -> AIAgent:
        """Create a fresh agent instance for this query.

        Hermes' own gateway creates a new AIAgent per incoming message and
        restores transcript history explicitly. Reusing a single in-memory
        agent here causes cross-session leakage and makes session_id alone look
        like a resumable thread handle, which it is not.
        """
        kwargs: dict[str, Any] = {
            'model': self.model,
            'provider': self.provider,
            'stream_delta_callback': make_stream_delta_callback(),
            'tool_start_callback': make_tool_start_callback(),
            'tool_complete_callback': make_tool_complete_callback(),
            'status_callback': make_status_callback(),
            'persist_session': True,
            'session_db': self.session_db,
        }
        if self.base_url:
            kwargs['base_url'] = self.base_url
        if self.api_key:
            kwargs['api_key'] = self.api_key
        if session_id:
            kwargs['session_id'] = session_id
        return AIAgent(**kwargs)

    def _load_history(self, session_id: str | None) -> list[dict[str, Any]] | None:
        if not session_id:
            return None
        try:
            if self.session_db.get_session(session_id):
                history = self.session_db.get_messages_as_conversation(session_id)
                return history or None
        except Exception as e:
            logger.warning("Failed to restore Hermes history from DB for %s: %s", session_id, e)

        # Fallback: restore from JSON session log file when DB session is missing.
        # This handles cases where SQLite persistence failed (e.g. write-lock
        # contention) but the session log file was successfully written.
        try:
            log_path = get_hermes_home() / "sessions" / f"session_{session_id}.json"
            if log_path.exists():
                logger.warning(
                    "Session %s missing from state.db, restoring from log file: %s",
                    session_id, log_path,
                )
                data = json.loads(log_path.read_text(encoding="utf-8"))
                msgs = data if isinstance(data, list) else data.get("messages", [])
                if msgs:
                    # Convert to conversation format (list of {role, content} dicts)
                    history = []
                    for msg in msgs:
                        role = msg.get("role")
                        content = msg.get("content")
                        if role and content is not None:
                            history.append({"role": role, "content": content})
                    return history or None
        except Exception as e:
            logger.warning("Failed to restore Hermes history from log file for %s: %s", session_id, e)

        return None

    def handle_query(self, params: dict) -> None:
        """Run a query and emit events."""
        prompt = params.get('prompt', '')
        session_id = params.get('sessionId')
        system_prompt = params.get('systemPrompt')

        if not prompt:
            emit_error('Empty prompt')
            emit({'type': 'complete', 'result': '', 'durationMs': 0})
            return

        start = time.time()

        global _text_buffer
        _text_buffer = TextBuffer()

        try:
            agent = self._create_agent(session_id)
            self.agent = agent
            restored_history = self._load_history(session_id)

            # Emit the effective session id for this run.
            emitted_session_id = agent.session_id
            emit({'type': 'session_id', 'sessionId': emitted_session_id})

            # Run conversation (callbacks emit text/tool events during execution)
            result = agent.run_conversation(
                user_message=prompt,
                system_message=system_prompt,
                conversation_history=restored_history,
                task_id=agent.session_id,
            )

            # Context compression can split a Hermes session. Propagate the new
            # session id back to EvolClaw so future turns load the right history.
            if agent.session_id != emitted_session_id:
                emit({'type': 'session_id', 'sessionId': agent.session_id})

            # Flush remaining buffered text (covers pure-text replies with no tool calls)
            _text_buffer.flush()

            duration_ms = int((time.time() - start) * 1000)
            final_response = result.get('final_response', '') or ''
            completed = result.get('completed', True)
            interrupted = result.get('interrupted', False)

            if interrupted:
                emit({
                    'type': 'complete',
                    'result': final_response,
                    'subtype': 'interrupted',
                    'durationMs': duration_ms,
                })
            elif not completed:
                error_msg = result.get('error', 'Conversation did not complete')
                emit_error(error_msg)
                emit({
                    'type': 'complete',
                    'result': final_response,
                    'isError': True,
                    'durationMs': duration_ms,
                })
            else:
                emit({
                    'type': 'complete',
                    'result': final_response,
                    'durationMs': duration_ms,
                })

        except Exception as e:
            if _text_buffer:
                _text_buffer.flush()
            duration_ms = int((time.time() - start) * 1000)
            emit_error(str(e))
            emit({
                'type': 'complete',
                'result': '',
                'isError': True,
                'errors': [str(e)],
                'durationMs': duration_ms,
            })
        finally:
            self.agent = None

    def handle_interrupt(self) -> None:
        """Interrupt the current agent operation."""
        if self.agent:
            try:
                self.agent.request_interrupt()
            except Exception:
                pass

    def handle_reset_agent(self) -> None:
        """Discard the current agent instance, if any."""
        if self.agent:
            try:
                self.agent.shutdown_memory_provider()
            except Exception:
                pass
        self.agent = None

    def handle_set_model(self, params: dict) -> None:
        """Switch model (recreates agent on next query)."""
        new_model = params.get('model')
        if new_model:
            self.model = new_model
            emit_status('model_changed', f'Model switched to {new_model}')

    def handle_set_approval_mode(self, params: dict) -> None:
        """Switch Hermes approval mode at runtime.

        Modes:
          manual — prompt user for every dangerous command (default)
          smart  — use auxiliary LLM to pre-evaluate, escalate to user if unsure
          off    — bypass all approval checks (YOLO)
          deny   — auto-deny everything (for EvolClaw's 'noask' mode)
        """
        mode = params.get('mode', 'manual')
        if mode == 'off':
            os.environ['HERMES_YOLO_MODE'] = '1'
        else:
            os.environ.pop('HERMES_YOLO_MODE', None)

        if mode == 'deny':
            # deny mode: unregister the gateway notify so approval.py
            # cannot send requests; all commands are auto-blocked
            unregister_gateway_notify(self.SESSION_KEY)
        else:
            # (re-)register so approval requests flow through
            register_gateway_notify(self.SESSION_KEY, self._on_approval_request)

        # Override approval mode via env var (approval.py reads via _get_approval_mode)
        if mode in ('manual', 'smart'):
            os.environ['HERMES_APPROVAL_MODE'] = mode
        else:
            os.environ.pop('HERMES_APPROVAL_MODE', None)

        emit_status('approval_mode_changed', f'Approval mode set to: {mode}')

    def handle_approval_response(self, params: dict) -> None:
        """Resolve a pending gateway approval request.

        Called when EvolClaw's PermissionGateway receives the user's decision.
        Maps EvolClaw's 3-state decision to Hermes' choice vocabulary:
          allow  → once  (one-time approval)
          always → session (approved for this session)
          deny   → deny  (block execution)
        """
        choice = params.get('choice', 'deny')
        resolved = resolve_gateway_approval(self.SESSION_KEY, choice)
        if resolved == 0:
            logger.debug('approval_response: no pending request to resolve')

    def _on_approval_request(self, approval_data: dict) -> None:
        """Gateway notify callback — emits an approval_request event to stdout.

        Called from the agent thread (synchronous context) when approval.py
        detects a dangerous command and needs user confirmation.  The agent
        thread is blocked on a threading.Event until approval_response arrives.
        """
        emit({
            'type': 'approval_request',
            'command': approval_data.get('command', ''),
            'description': approval_data.get('description', ''),
            'patternKeys': approval_data.get('pattern_keys', []),
        })

    def cleanup(self) -> None:
        """Unregister gateway callback on shutdown."""
        unregister_gateway_notify(self.SESSION_KEY)


# ── Main loop ──

async def main():
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    manager = AgentManager()

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break  # EOF

        line_str = line.decode('utf-8', errors='replace').strip()
        if not line_str:
            continue

        try:
            request = json.loads(line_str)
        except json.JSONDecodeError as e:
            emit_error(f'Invalid JSON: {e}')
            continue

        method = request.get('method', '')
        params = request.get('params', {})

        if method == 'query':
            # Run query in thread pool to not block stdin reading
            await loop.run_in_executor(None, manager.handle_query, params)
        elif method == 'interrupt':
            # Must run in thread pool too — handle_query blocks the default executor,
            # but request_interrupt() is thread-safe and sets a flag
            loop.run_in_executor(None, manager.handle_interrupt)
        elif method == 'reset_agent':
            manager.handle_reset_agent()
        elif method == 'set_model':
            manager.handle_set_model(params)
        elif method == 'set_approval_mode':
            manager.handle_set_approval_mode(params)
        elif method == 'approval_response':
            # Must run in thread pool — resolve_gateway_approval signals
            # a threading.Event that unblocks the agent thread
            loop.run_in_executor(None, manager.handle_approval_response, params)
        elif method == 'shutdown':
            manager.cleanup()
            break
        else:
            emit_error(f'Unknown method: {method}')


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        emit_error(str(e))
        sys.exit(1)
