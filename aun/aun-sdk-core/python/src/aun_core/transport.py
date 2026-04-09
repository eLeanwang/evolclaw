from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import Awaitable, Callable
from typing import Any

from .errors import ConnectionError, SerializationError, TimeoutError, map_remote_error
from .events import EventDispatcher


ConnectionFactory = Callable[[str], Awaitable[Any]]
DisconnectCallback = Callable[[Exception | None], Awaitable[None]]

EVENT_NAME_MAP = {
    "message.received": "message.received",
    "message.recalled": "message.recalled",
    "message.ack": "message.ack",
    "group.changed": "group.changed",
}


class RPCTransport:
    def __init__(
        self,
        *,
        event_dispatcher: EventDispatcher,
        connection_factory: ConnectionFactory,
        timeout: float = 10.0,
        on_disconnect: DisconnectCallback | None = None,
    ) -> None:
        self._dispatcher = event_dispatcher
        self._connection_factory = connection_factory
        self._timeout = timeout
        self._on_disconnect = on_disconnect
        self._ws: Any | None = None
        self._reader_task: asyncio.Task | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._closed = True
        self._challenge: dict[str, Any] | None = None

    def set_timeout(self, timeout: float) -> None:
        self._timeout = timeout

    @property
    def challenge(self) -> dict[str, Any] | None:
        return self._challenge

    async def connect(self, url: str) -> dict[str, Any] | None:
        self._ws = await self._connection_factory(url)
        self._closed = False
        challenge = await self._recv_initial_message()
        self._challenge = challenge
        self._reader_task = asyncio.create_task(self._reader_loop())
        return challenge

    async def close(self) -> None:
        self._closed = True
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass  # 任务取消，正常清理
            self._reader_task = None
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(ConnectionError("transport closed"))
        self._pending.clear()

    async def call(self, method: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        if self._closed or self._ws is None:
            raise ConnectionError("transport not connected")

        rpc_id = f"rpc-{secrets.token_hex(8)}"
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[rpc_id] = future

        try:
            await self._ws.send(json.dumps({
                "jsonrpc": "2.0",
                "id": rpc_id,
                "method": method,
                "params": params or {},
            }))
        except Exception as exc:
            self._pending.pop(rpc_id, None)
            raise ConnectionError(f"failed to send rpc {method}: {exc}") from exc

        try:
            response = await asyncio.wait_for(future, timeout=timeout or self._timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(rpc_id, None)
            raise TimeoutError(f"rpc timeout: {method}", retryable=True) from exc

        if "error" in response:
            raise map_remote_error(response["error"])
        return response.get("result")

    async def _recv_initial_message(self) -> dict[str, Any] | None:
        if self._ws is None:
            return None
        raw = await self._ws.recv()
        message = self._decode_message(raw)
        if message.get("method") == "challenge":
            return message
        await self._route_message(message)
        return None

    async def _reader_loop(self) -> None:
        disconnect_error: Exception | None = None
        unexpected_disconnect = False
        try:
            while not self._closed and self._ws is not None:
                raw = await self._ws.recv()
                message = self._decode_message(raw)
                await self._route_message(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            disconnect_error = exc
            unexpected_disconnect = not self._closed
            if not self._closed:
                await self._dispatcher.publish("connection.error", {"error": exc})
        finally:
            self._closed = True
            if unexpected_disconnect:
                if self._on_disconnect is not None:
                    await self._on_disconnect(disconnect_error)

    async def _route_message(self, message: dict[str, Any]) -> None:
        if "id" in message:
            rpc_id = str(message["id"])
            future = self._pending.pop(rpc_id, None)
            if future is not None and not future.done():
                future.set_result(message)
            return

        method = str(message.get("method", ""))
        if method == "challenge":
            self._challenge = message
            await self._dispatcher.publish("connection.challenge", message.get("params", {}))
            return

        if method.startswith("event/"):
            protocol_event = method.removeprefix("event/")
            sdk_event = EVENT_NAME_MAP.get(protocol_event, protocol_event)
            # 发布为 _raw.{event}，由 AUNClient 处理后再发布用户可见的事件
            await self._dispatcher.publish(f"_raw.{sdk_event}", message.get("params", {}))
            return

        await self._dispatcher.publish("notification", message)

    @staticmethod
    def _decode_message(raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        if not isinstance(raw, str):
            raise SerializationError(f"unsupported websocket payload type: {type(raw)!r}")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SerializationError("invalid json payload") from exc
