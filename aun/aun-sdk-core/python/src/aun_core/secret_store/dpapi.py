from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
from typing import Any


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


class DPAPISecretStore:
    """Windows DPAPI-backed secret store."""

    CRYPTPROTECT_UI_FORBIDDEN = 0x01

    def __init__(self) -> None:
        self._crypt32 = ctypes.windll.crypt32
        self._kernel32 = ctypes.windll.kernel32

    @classmethod
    def is_supported(cls) -> bool:
        return hasattr(ctypes, "windll") and hasattr(ctypes.windll, "crypt32")

    def protect(self, scope: str, name: str, plaintext: bytes) -> dict[str, Any]:
        ciphertext = self._protect_bytes(plaintext, self._entropy(scope, name))
        return {
            "scheme": "dpapi",
            "name": name,
            "persisted": True,
            "blob": base64.b64encode(ciphertext).decode("ascii"),
        }

    def reveal(self, scope: str, name: str, record: dict[str, Any]) -> bytes | None:
        if record.get("scheme") != "dpapi":
            return None
        if str(record.get("name") or "") != name:
            return None
        blob_b64 = str(record.get("blob") or "")
        if not blob_b64:
            return None
        return self._unprotect_bytes(base64.b64decode(blob_b64), self._entropy(scope, name))

    def clear(self, scope: str, name: str) -> None:
        return

    def _protect_bytes(self, plaintext: bytes, entropy: bytes) -> bytes:
        in_blob, in_buffer = self._make_blob(plaintext)
        entropy_blob, entropy_buffer = self._make_blob(entropy)
        out_blob = _DATA_BLOB()
        if not self._crypt32.CryptProtectData(
            ctypes.byref(in_blob),
            None,
            ctypes.byref(entropy_blob),
            None,
            None,
            self.CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(out_blob),
        ):
            raise ctypes.WinError()
        try:
            return ctypes.string_at(out_blob.pbData, out_blob.cbData)
        finally:
            if out_blob.pbData:
                self._kernel32.LocalFree(out_blob.pbData)

    def _unprotect_bytes(self, ciphertext: bytes, entropy: bytes) -> bytes:
        in_blob, in_buffer = self._make_blob(ciphertext)
        entropy_blob, entropy_buffer = self._make_blob(entropy)
        out_blob = _DATA_BLOB()
        if not self._crypt32.CryptUnprotectData(
            ctypes.byref(in_blob),
            None,
            ctypes.byref(entropy_blob),
            None,
            None,
            self.CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(out_blob),
        ):
            raise ctypes.WinError()
        try:
            return ctypes.string_at(out_blob.pbData, out_blob.cbData)
        finally:
            if out_blob.pbData:
                self._kernel32.LocalFree(out_blob.pbData)

    @staticmethod
    def _make_blob(data: bytes) -> tuple[_DATA_BLOB, ctypes.Array[ctypes.c_byte]]:
        buffer = (ctypes.c_byte * len(data)).from_buffer_copy(data)
        return _DATA_BLOB(len(data), buffer), buffer

    @staticmethod
    def _entropy(scope: str, name: str) -> bytes:
        return f"aun:{scope}:{name}".encode("utf-8")
