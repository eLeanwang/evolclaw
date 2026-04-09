"""macOS Keychain-backed secret store.

通过 ``security`` CLI 操作 Keychain，无需第三方依赖。
每个 secret 存为一条 Generic Password：
  - service = "aun:{scope}"
  - account = name
  - password = base64(plaintext)
"""

from __future__ import annotations

import base64
import subprocess
import sys
from typing import Any


class KeychainSecretStore:
    """macOS Keychain secret store (通过 security CLI)."""

    _SERVICE_PREFIX = "aun"

    @classmethod
    def is_supported(cls) -> bool:
        if sys.platform != "darwin":
            return False
        try:
            r = subprocess.run(
                ["security", "help"],
                capture_output=True,
                timeout=5,
            )
            # security help 返回码可能非 0，但只要命令存在即可
            return True
        except (FileNotFoundError, OSError):
            return False

    # ── SecretStore 接口 ──────────────────────────────────

    def protect(self, scope: str, name: str, plaintext: bytes) -> dict[str, Any]:
        service = self._service(scope)
        password = base64.b64encode(plaintext).decode("ascii")

        # 先尝试删除已有条目（忽略不存在的情况）
        self._delete(service, name)

        subprocess.run(
            [
                "security", "add-generic-password",
                "-s", service,
                "-a", name,
                "-w", password,
                "-U",  # 已存在则更新
            ],
            capture_output=True,
            check=True,
            timeout=10,
        )
        return {
            "scheme": "keychain",
            "name": name,
            "persisted": True,
        }

    def reveal(self, scope: str, name: str, record: dict[str, Any]) -> bytes | None:
        if record.get("scheme") != "keychain":
            return None
        if str(record.get("name") or "") != name:
            return None

        service = self._service(scope)
        try:
            r = subprocess.run(
                [
                    "security", "find-generic-password",
                    "-s", service,
                    "-a", name,
                    "-w",  # 仅输出 password 值
                ],
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            )
        except subprocess.CalledProcessError:
            return None

        password = r.stdout.strip()
        if not password:
            return None
        return base64.b64decode(password)

    def clear(self, scope: str, name: str) -> None:
        self._delete(self._service(scope), name)

    # ── 内部方法 ──────────────────────────────────────────

    def _service(self, scope: str) -> str:
        return f"{self._SERVICE_PREFIX}:{scope}"

    @staticmethod
    def _delete(service: str, account: str) -> None:
        """删除 Keychain 条目，不存在时静默忽略。"""
        try:
            subprocess.run(
                [
                    "security", "delete-generic-password",
                    "-s", service,
                    "-a", account,
                ],
                capture_output=True,
                timeout=10,
            )
        except (subprocess.CalledProcessError, OSError):
            pass  # 平台兼容 fallback
