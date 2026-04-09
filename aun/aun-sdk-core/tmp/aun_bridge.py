#!/usr/bin/env python3
"""AUN Bridge — stdio JSON-RPC sidecar for EvolClaw."""
import asyncio
import base64
import hashlib
import json
import os
import sys
from typing import Any

from aun_core.client import AUNClient


def emit(event: dict) -> None:
    """Write JSON event to stdout (one line, flushed)."""
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(msg: str) -> None:
    """Write log to stderr."""
    print(f'[aun_bridge] {msg}', file=sys.stderr, flush=True)


class FileSecretStore:
    """File-based SecretStore using seed-derived key for private key protection.
    Ensures private keys survive process restarts on Linux without platform keyring."""

    def __init__(self, seed: str):
        self._key = hashlib.sha256(seed.encode()).digest()

    def protect(self, scope: str, name: str, plaintext: bytes) -> dict[str, Any]:
        key = self._key
        encrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(plaintext))
        return {
            'scheme': 'file_seed',
            'name': name,
            'persisted': True,
            'data': base64.b64encode(encrypted).decode(),
        }

    def reveal(self, scope: str, name: str, record: dict[str, Any]) -> bytes | None:
        if record.get('scheme') != 'file_seed':
            return None
        encrypted = base64.b64decode(record['data'])
        key = self._key
        return bytes(b ^ key[i % len(key)] for i, b in enumerate(encrypted))

    def clear(self, scope: str, name: str) -> None:
        pass


class AUNBridge:
    def __init__(self):
        self.client: AUNClient | None = None
        self.aid: str | None = None

    async def start(self):
        aun_path = os.environ.get('AUN_PATH', os.path.expanduser('~/.aun/AIDs'))
        gateway = os.environ.get('AUN_GATEWAY', '')
        aid_name = os.environ.get('AUN_AID', '')

        if not gateway:
            emit({'event': 'error', 'message': 'AUN_GATEWAY not set'})
            return

        # Create client (FileSecretStore ensures private key persistence without platform keyring)
        encryption_seed = os.environ.get('AUN_ENCRYPTION_SEED', 'evolclaw-aun-production-seed-2026')
        self.client = AUNClient({
            'aun_path': aun_path,
            'secret_store': FileSecretStore(encryption_seed),
        })
        self.client._gateway_url = gateway

        # Register event handlers before connecting
        self.client.on('message.received', self._on_message_received)
        self.client.on('group.message_created', self._on_group_message_created)
        self.client.on('connection.state', self._on_connection_state)

        # Authenticate (loads identity + private key, gets fresh token)
        try:
            if aid_name:
                auth = await self.client.auth.authenticate({'aid': aid_name})
            else:
                # Try to find an existing AID in the keystore
                auth = await self.client.auth.authenticate()
            access_token = auth['access_token']
            gateway = auth.get('gateway', gateway)
            log(f'Authenticated as {auth.get("aid", "?")}')
        except Exception as e:
            # Fallback: try direct token from env (legacy)
            access_token = os.environ.get('AUN_ACCESS_TOKEN', '')
            if not access_token:
                emit({'event': 'error', 'message': f'Authentication failed and no AUN_ACCESS_TOKEN: {e}'})
                return
            log(f'Auth failed ({e}), using AUN_ACCESS_TOKEN fallback')

        # Connect (SDK auto_reconnect handles transient failures: 5 attempts, exp backoff up to 30s)
        try:
            await self.client.connect(
                {'access_token': access_token, 'gateway': gateway},
                {'auto_reconnect': True, 'retry': {'max_attempts': 5, 'initial_delay': 1.0, 'max_delay': 30.0}}
            )
            self.aid = self.client.aid
            emit({'event': 'ready', 'aid': self.aid or ''})
            log(f'Connected as {self.aid}')
        except Exception as e:
            emit({'event': 'error', 'message': str(e)})
            log(f'Connection failed: {e}')
            return

        # Start reading stdin
        await self._read_stdin()

    async def _on_message_received(self, data: Any) -> None:
        """Handle incoming private message."""
        try:
            if not isinstance(data, dict):
                return

            from_aid = data.get('from', '')
            payload = data.get('payload', '')
            text = payload if isinstance(payload, str) else json.dumps(payload) if payload else ''

            task_id = data.get('task_id')
            parent_task_id = data.get('parent_task_id')
            message_id = data.get('message_id', '')
            seq = data.get('seq')

            # Detect @mentions in text
            mentions = []
            if self.aid and f'@{self.aid}' in text:
                mentions.append(self.aid)

            event: dict[str, Any] = {
                'event': 'message',
                'channelId': from_aid,
                'userId': from_aid,
                'text': text,
                'chatType': 'private',
                'messageId': message_id,
            }
            if seq is not None:
                event['seq'] = seq
            if task_id:
                event['taskId'] = task_id
            if parent_task_id:
                event['parentTaskId'] = parent_task_id
            if mentions:
                event['mentions'] = mentions

            emit(event)
        except Exception as e:
            log(f'Error handling message: {e}')

    async def _on_group_message_created(self, data: Any) -> None:
        """Handle incoming group message."""
        try:
            if not isinstance(data, dict):
                return

            group_id = data.get('group_id', '')
            sender_aid = data.get('sender_aid', data.get('from', ''))
            payload = data.get('payload', '')
            text = payload if isinstance(payload, str) else json.dumps(payload) if payload else ''
            task_id = data.get('task_id')
            message_id = data.get('message_id', '')
            seq = data.get('seq')

            # Detect @mentions
            mentions = []
            if self.aid and f'@{self.aid}' in text:
                mentions.append(self.aid)

            event: dict[str, Any] = {
                'event': 'message',
                'channelId': group_id,
                'userId': sender_aid,
                'text': text,
                'chatType': 'group',
                'messageId': message_id,
            }
            if seq is not None:
                event['seq'] = seq
            if task_id:
                event['taskId'] = task_id
            if mentions:
                event['mentions'] = mentions

            emit(event)
        except Exception as e:
            log(f'Error handling group message: {e}')

    async def _on_connection_state(self, data: Any) -> None:
        """Handle connection state changes."""
        if not isinstance(data, dict):
            return
        state = data.get('state', '')
        if state == 'disconnected':
            reason = str(data.get('error', 'unknown'))
            emit({'event': 'disconnected', 'reason': reason})
            log(f'Disconnected: {reason}')
        elif state == 'reconnecting':
            attempt = data.get('attempt', '?')
            max_attempts = data.get('max_attempts', '?')
            emit({'event': 'reconnecting', 'attempt': attempt, 'maxAttempts': max_attempts})
            log(f'Reconnecting attempt {attempt}/{max_attempts}')
        elif state == 'terminal_failed':
            error = str(data.get('error', 'unknown'))
            emit({'event': 'terminal_failed', 'reason': error})
            log(f'Terminal failure: {error}, exiting for TS-layer restart')
            sys.exit(1)

    async def _read_stdin(self) -> None:
        """Read JSON-RPC commands from stdin."""
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        while True:
            try:
                line = await reader.readline()
                if not line:
                    break  # EOF
                line_str = line.decode('utf-8').strip()
                if not line_str:
                    continue
                request = json.loads(line_str)
                await self._handle_request(request)
            except json.JSONDecodeError as e:
                log(f'Invalid JSON: {e}')
            except Exception as e:
                log(f'Error reading stdin: {e}')
                break

    async def _handle_request(self, request: dict) -> None:
        """Handle JSON-RPC request from EvolClaw."""
        method = request.get('method', '')
        params = request.get('params', {})

        if method == 'send':
            await self._handle_send(params)
        elif method == 'ack':
            await self._handle_ack(params)
        elif method == 'processing':
            await self._handle_processing(params)
        elif method == 'custom_payload':
            await self._handle_custom_payload(params)
        else:
            log(f'Unknown method: {method}')

    async def _handle_send(self, params: dict) -> None:
        """Send a message via AUN."""
        if not self.client:
            log('Cannot send: not connected')
            return

        channel_id = params.get('channelId', '')
        text = params.get('text', '')
        task_id = params.get('taskId')

        try:
            if channel_id.startswith('grp_'):
                # Group message
                send_params: dict[str, Any] = {
                    'group_id': channel_id,
                    'payload': text,
                    'encrypt': True,
                }
                if task_id:
                    send_params['task_id'] = task_id
                await self.client.call('group.send', send_params)
            else:
                # Private message
                send_params = {
                    'to': channel_id,
                    'payload': text,
                    'encrypt': True,
                }
                if task_id:
                    send_params['task_id'] = task_id
                await self.client.call('message.send', send_params)
            log(f'Sent to {channel_id}')
        except Exception as e:
            log(f'Send failed to {channel_id}: {e}')

    async def _handle_ack(self, params: dict) -> None:
        """Acknowledge messages up to a given seq."""
        if not self.client:
            return
        seq = params.get('seq')
        if seq is None:
            return
        try:
            await self.client.call('message.ack', {'seq': seq})
            log(f'Acked seq {seq}')
        except Exception as e:
            log(f'Ack failed: {e}')

    async def _handle_processing(self, params: dict) -> None:
        """Send processing status notification to client (persist: false)."""
        if not self.client:
            return
        channel_id = params.get('channelId', '')
        status = params.get('status', 'start')
        session_id = params.get('sessionId', '')
        if not channel_id:
            return
        import time
        payload = json.dumps({
            'type': 'processing',
            'status': status,
            'sessionId': session_id,
            'timestamp': int(time.time()),
        })
        try:
            send_params: dict[str, Any] = {
                'to': channel_id, 'payload': payload,
                'encrypt': True, 'persist': False,
            }
            task_id = params.get('taskId')
            if task_id:
                send_params['task_id'] = task_id
            await self.client.call('message.send', send_params)
        except Exception as e:
            log(f'Processing status failed: {e}')

    async def _handle_custom_payload(self, params: dict) -> None:
        """Send a custom JSON payload to client (persist: false)."""
        if not self.client:
            return
        channel_id = params.get('channelId', '')
        payload = params.get('payload', '')
        if not channel_id or not payload:
            return
        try:
            await self.client.call('message.send', {
                'to': channel_id, 'payload': payload,
                'encrypt': True, 'persist': False,
            })
        except Exception as e:
            log(f'Custom payload failed: {e}')

    async def shutdown(self) -> None:
        """Clean shutdown."""
        if self.client:
            try:
                await self.client.close()
            except Exception:
                pass


async def main():
    bridge = AUNBridge()
    try:
        await bridge.start()
    except KeyboardInterrupt:
        pass
    finally:
        await bridge.shutdown()


if __name__ == '__main__':
    asyncio.run(main())
