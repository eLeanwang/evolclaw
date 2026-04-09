from __future__ import annotations

from typing import Any


class VolatileSecretStore:
    """Phase 1 fallback: keep sensitive material in-memory only."""

    def __init__(self) -> None:
        self._values: dict[tuple[str, str], bytes] = {}

    def protect(self, scope: str, name: str, plaintext: bytes) -> dict[str, Any]:
        self._values[(scope, name)] = plaintext
        return {
            "scheme": "volatile",
            "name": name,
            "persisted": False,
        }

    def reveal(self, scope: str, name: str, record: dict[str, Any]) -> bytes | None:
        if record.get("scheme") != "volatile":
            return None
        if str(record.get("name") or "") != name:
            return None
        return self._values.get((scope, name))

    def clear(self, scope: str, name: str) -> None:
        self._values.pop((scope, name), None)
