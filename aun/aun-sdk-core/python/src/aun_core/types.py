from __future__ import annotations

from typing import Any, Literal, TypedDict


JsonValue = Any


class Message(TypedDict, total=False):
    message_id: str
    seq: int
    to: str
    type: str
    payload: JsonValue
    encrypted: bool
    persist: bool
    timestamp: int


class SendResult(TypedDict, total=False):
    message_id: str
    seq: int
    timestamp: int
    status: Literal["sent", "delivered", "duplicate"]
    persist: bool


class AckResult(TypedDict, total=False):
    ack_seq: int


class PullResult(TypedDict, total=False):
    messages: list[Message]
    count: int
    latest_seq: int
