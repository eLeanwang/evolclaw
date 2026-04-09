"""Linux Secret Service (libsecret / D-Bus) backed secret store.

通过 ``secret-tool`` CLI 操作 GNOME Keyring / KWallet 等兼容后端，
无需 Python 绑定库（如 ``secretstorage``）。
每个 secret 存为一条 Secret Service 条目：
  - attribute "aun_scope" = scope
  - attribute "aun_name"  = name
  - secret = base64(plaintext)
  - label  = "aun:{scope}:{name}"
"""

from __future__ import annotations

import base64
import shutil
import subprocess
import sys
from typing import Any


class LibsecretSecretStore:
    """Linux Secret Service secret store (通过 secret-tool CLI)."""

    @classmethod
    def is_supported(cls) -> bool:
        if sys.platform not in ("linux", "linux2"):
            return False
        if shutil.which("secret-tool") is None:
            return False
        # 检查 Secret Service 后端是否可用
        try:
            r = subprocess.run(
                ["secret-tool", "search", "--all", "aun_probe", "1"],
                capture_output=True,
                timeout=5,
            )
            # 即使无结果，只要不超时/不报 D-Bus 连接错误即可
            # 如果 stderr 包含 "Cannot autolaunch" 等 D-Bus 错误则不可用
            stderr = r.stderr.decode("utf-8", errors="replace").lower()
            if "cannot autolaunch" in stderr or "not provided" in stderr:
                return False
            return True
        except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
            return False

    # ── SecretStore 接口 ──────────────────────────────────

    def protect(self, scope: str, name: str, plaintext: bytes) -> dict[str, Any]:
        password = base64.b64encode(plaintext).decode("ascii")
        label = f"aun:{scope}:{name}"

        # 先清除旧条目
        self.clear(scope, name)

        # secret-tool store 从 stdin 读取 secret
        subprocess.run(
            [
                "secret-tool", "store",
                "--label", label,
                "aun_scope", scope,
                "aun_name", name,
            ],
            input=password.encode("utf-8"),
            capture_output=True,
            check=True,
            timeout=10,
        )
        return {
            "scheme": "libsecret",
            "name": name,
            "persisted": True,
        }

    def reveal(self, scope: str, name: str, record: dict[str, Any]) -> bytes | None:
        if record.get("scheme") != "libsecret":
            return None
        if str(record.get("name") or "") != name:
            return None

        try:
            r = subprocess.run(
                [
                    "secret-tool", "lookup",
                    "aun_scope", scope,
                    "aun_name", name,
                ],
                capture_output=True,
                timeout=10,
            )
        except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired):
            return None

        if r.returncode != 0:
            return None

        password = r.stdout.decode("utf-8", errors="replace").strip()
        if not password:
            return None
        return base64.b64decode(password)

    def clear(self, scope: str, name: str) -> None:
        """删除条目，不存在时静默忽略。"""
        try:
            subprocess.run(
                [
                    "secret-tool", "clear",
                    "aun_scope", scope,
                    "aun_name", name,
                ],
                capture_output=True,
                timeout=10,
            )
        except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired):
            pass  # 平台兼容 fallback
