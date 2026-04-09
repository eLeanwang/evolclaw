from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

from .base import SecretStore

_log = logging.getLogger(__name__)


class _MigratingSecretStore:
    """写入统一用 FileSecretStore，读取时兼容旧平台原生 scheme。

    迁移策略：
    - protect() → 始终用 FileSecretStore（file_aes），新数据可备份/迁移
    - reveal()  → file_aes 走 FileSecretStore；dpapi/keychain/libsecret 走原生读取
    """

    def __init__(self, file_store: SecretStore, native: SecretStore | None) -> None:
        self._file = file_store
        self._native = native

    def protect(self, scope: str, name: str, plaintext: bytes) -> dict[str, Any]:
        return self._file.protect(scope, name, plaintext)

    def reveal(self, scope: str, name: str, record: dict[str, Any]) -> bytes | None:
        scheme = record.get("scheme", "")
        if scheme == "file_aes":
            return self._file.reveal(scope, name, record)
        if scheme in ("dpapi", "keychain", "libsecret") and self._native:
            try:
                return self._native.reveal(scope, name, record)
            except Exception as exc:
                _log.warning("旧格式 %s 读取失败: %s", scheme, exc)
        return None

    def clear(self, scope: str, name: str) -> None:
        self._file.clear(scope, name)
        if self._native:
            try:
                self._native.clear(scope, name)
            except Exception as _exc:
                import logging as _logging
                _logging.getLogger("aun_core").debug("清除失败: %s", _exc)


def create_default_secret_store(
    *,
    root: Path | None = None,
    encryption_seed: str | None = None,
) -> SecretStore:
    """所有平台写入用 FileSecretStore（可备份），读取兼容旧平台原生格式。"""
    from .file_store import FileSecretStore
    store_root = root or Path.home() / ".aun"
    file_store = FileSecretStore(store_root, encryption_seed=encryption_seed)

    native: SecretStore | None = None
    if sys.platform == "win32":
        from .dpapi import DPAPISecretStore
        if DPAPISecretStore.is_supported():
            native = DPAPISecretStore()
    elif sys.platform == "darwin":
        from .keychain import KeychainSecretStore
        if KeychainSecretStore.is_supported():
            native = KeychainSecretStore()
    elif sys.platform.startswith("linux"):
        from .libsecret import LibsecretSecretStore
        if LibsecretSecretStore.is_supported():
            native = LibsecretSecretStore()

    if native is not None:
        return _MigratingSecretStore(file_store, native)
    return file_store
