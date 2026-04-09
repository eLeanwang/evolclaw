from __future__ import annotations

from typing import Any, Protocol


class SecretStore(Protocol):
    def protect(self, scope: str, name: str, plaintext: bytes) -> dict[str, Any]: ...

    def reveal(self, scope: str, name: str, record: dict[str, Any]) -> bytes | None: ...

    def clear(self, scope: str, name: str) -> None: ...
