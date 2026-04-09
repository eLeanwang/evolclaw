from __future__ import annotations

import copy
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from .base import KeyStore
from ..secret_store import SecretStore, create_default_secret_store

import logging

_log = logging.getLogger("aun_core.keystore")

_SENSITIVE_TOKEN_FIELDS = ("access_token", "refresh_token", "kite_token")
_CRITICAL_METADATA_KEYS = ("e2ee_prekeys", "e2ee_sessions", "group_secrets")


def _secure_file_permissions(path: Path) -> None:
    """在 Unix 系统上将文件权限设为 0o600（仅属主可读写）"""
    if sys.platform != "win32":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass  # 平台兼容 fallback


class FileKeyStore(KeyStore):
    def __init__(
        self,
        root: str | Path | None = None,
        *,
        secret_store: SecretStore | None = None,
        encryption_seed: str | None = None,
    ) -> None:
        preferred = Path(root or Path.home() / ".aun")
        fallback = Path.cwd() / ".aun"
        resolved_root = self._prepare_root(preferred, fallback)
        self._secret_store = secret_store or create_default_secret_store(
            root=resolved_root, encryption_seed=encryption_seed,
        )
        if resolved_root.name == "keys":
            self._root = resolved_root.parent
            self._legacy_roots = [resolved_root, self._root / "keys"]
        else:
            self._root = resolved_root
            self._legacy_roots = [self._root / "keys", self._root]
        self._aids_root = self._root / "AIDs"
        self._aids_root.mkdir(parents=True, exist_ok=True)
        self._sync_bundled_root_ca()

    def load_identity(self, aid: str) -> dict | None:
        identity = self._load_identity_from_split_files(aid)
        if identity is not None:
            return identity
        path = self._identity_path(aid)
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        # 兼容旧格式：~/.aun/{aid}/AIDs/{aid}/（旧版 SDK 按 cwd 生成子目录）
        legacy_subdir = self._root / self._safe_aid(aid)
        if legacy_subdir.is_dir():
            legacy_ks = FileKeyStore(legacy_subdir, secret_store=self._secret_store)
            return legacy_ks._load_identity_from_split_files(aid)
        return None

    def save_identity(self, aid: str, identity: dict) -> None:
        key_pair = {
            key: identity[key]
            for key in ("private_key_pem", "public_key_der_b64", "curve")
            if key in identity
        }
        if key_pair:
            self.save_key_pair(aid, key_pair)
        cert = identity.get("cert")
        if isinstance(cert, str) and cert:
            self.save_cert(aid, cert)
        # 合并 metadata 而非覆盖：先加载已有数据，再更新 identity 中的字段
        # 保护 e2ee_prekeys、group_secrets 等由其他流程写入的关键数据不被丢失
        new_fields = {
            key: value
            for key, value in identity.items()
            if key not in {"private_key_pem", "public_key_der_b64", "curve", "cert"}
        }
        existing = self.load_metadata(aid) or {}
        existing.update(new_fields)
        self.save_metadata(aid, existing)

    def delete_identity(self, aid: str) -> None:
        scope = self._safe_aid(aid)
        self._secret_store.clear(scope, "identity/private_key")
        self.delete_key_pair(aid)
        cert_path = self._cert_path(aid)
        if cert_path.exists():
            cert_path.unlink()
        meta_path = self._metadata_path(aid)
        if meta_path.exists():
            meta_path.unlink()
        identity_dir = self._identity_dir(aid)
        if identity_dir.exists():
            shutil.rmtree(identity_dir, ignore_errors=True)
        for legacy_root in self._legacy_roots:
            self._delete_legacy_identity_files(legacy_root, aid)

    def load_key_pair(self, aid: str) -> dict | None:
        path = self._key_pair_path(aid)
        if path.exists():
            key_pair = json.loads(path.read_text(encoding="utf-8"))
            return self._restore_key_pair(aid, key_pair)
        legacy_key_path = self._load_legacy_split_file(aid, ".key.json")
        if legacy_key_path is not None:
            key_pair = json.loads(legacy_key_path.read_text(encoding="utf-8"))
            return self._restore_key_pair(aid, key_pair)
        identity = self._load_legacy_identity(aid)
        if identity is not None:
            key_pair = {k: identity[k] for k in ("private_key_pem", "public_key_der_b64", "curve") if k in identity}
            return key_pair or None
        # fallback: 旧格式子目录 ~/.aun/{aid}/AIDs/{aid}/
        lks = self._legacy_subdir_ks(aid)
        return lks.load_key_pair(aid) if lks else None

    def save_key_pair(self, aid: str, key_pair: dict) -> None:
        path = self._key_pair_path(aid)
        path.parent.mkdir(parents=True, exist_ok=True)

        # 保护私钥
        protected_key_pair = copy.deepcopy(key_pair)
        scope = self._safe_aid(aid)
        private_key_pem = protected_key_pair.pop("private_key_pem", None)
        if isinstance(private_key_pem, str) and private_key_pem:
            protection = self._secret_store.protect(
                scope,
                "identity/private_key",
                private_key_pem.encode("utf-8"),
            )
            if not protection.get("persisted"):
                raise RuntimeError(
                    f"SecretStore 无法持久化私钥 (scheme={protection.get('scheme')})。"
                    f"私钥必须能跨进程重启保留，请检查密钥存储配置。"
                )
            protected_key_pair["private_key_protection"] = protection
        elif "private_key_protection" not in protected_key_pair:
            self._secret_store.clear(scope, "identity/private_key")

        path.write_text(json.dumps(protected_key_pair, ensure_ascii=False, indent=2), encoding="utf-8")
        _secure_file_permissions(path)

    def load_cert(self, aid: str) -> str | None:
        path = self._cert_path(aid)
        if path.exists():
            return path.read_text(encoding="utf-8")
        legacy_cert_path = self._load_legacy_split_file(aid, ".cert.pem")
        if legacy_cert_path is not None:
            return legacy_cert_path.read_text(encoding="utf-8")
        identity = self._load_legacy_identity(aid)
        cert = identity.get("cert") if identity else None
        if isinstance(cert, str) and cert:
            return cert
        lks = self._legacy_subdir_ks(aid)
        return lks.load_cert(aid) if lks else None

    def save_cert(self, aid: str, cert_pem: str) -> None:
        path = self._cert_path(aid)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(cert_pem, encoding="utf-8")

    def load_metadata(self, aid: str) -> dict | None:
        path = self._metadata_path(aid)
        if path.exists():
            return self._restore_metadata(aid, json.loads(path.read_text(encoding="utf-8")))
        legacy_meta_path = self._load_legacy_split_file(aid, ".meta.json")
        if legacy_meta_path is not None:
            return self._restore_metadata(aid, json.loads(legacy_meta_path.read_text(encoding="utf-8")))
        identity = self._load_legacy_identity(aid)
        if identity is not None:
            return self._restore_metadata(aid, {
                key: value
                for key, value in identity.items()
                if key not in {"private_key_pem", "public_key_der_b64", "curve", "cert"}
            })
        lks = self._legacy_subdir_ks(aid)
        return lks.load_metadata(aid) if lks else None

    def save_metadata(self, aid: str, metadata: dict) -> None:
        path = self._metadata_path(aid)
        path.parent.mkdir(parents=True, exist_ok=True)

        # 防御性检查：如果磁盘上已有关键数据，而传入的 metadata 中缺失，
        # 说明调用方可能没有先 load_metadata 就直接写入——这会导致数据丢失。
        # 此时先从磁盘还原已有值并合并到 metadata 中。
        if path.exists():
            try:
                existing = self._restore_metadata(
                    aid, json.loads(path.read_text(encoding="utf-8")),
                )
            except Exception:
                existing = {}
            for key in _CRITICAL_METADATA_KEYS:
                if key in existing and existing[key] and key not in metadata:
                    _log.warning(
                        "save_metadata: 传入数据缺少 '%s' (aid=%s)，自动合并磁盘已有数据",
                        key, aid,
                    )
                    metadata[key] = existing[key]

        protected = self._protect_metadata(aid, metadata)
        path.write_text(json.dumps(protected, ensure_ascii=False, indent=2), encoding="utf-8")
        _secure_file_permissions(path)

    def load_any_identity(self) -> dict | None:
        candidates: set[str] = set()
        if not self._root.exists():
            return None
        if self._aids_root.exists():
            for path in self._aids_root.iterdir():
                if path.is_dir():
                    candidates.add(path.name)
        for legacy_root in self._legacy_roots:
            if not legacy_root.exists():
                continue
            for path in legacy_root.glob("*.meta.json"):
                candidates.add(path.name.removesuffix(".meta.json"))
            for path in legacy_root.glob("*.key.json"):
                candidates.add(path.name.removesuffix(".key.json"))
            for path in legacy_root.glob("*.cert.pem"):
                candidates.add(path.name.removesuffix(".cert.pem"))
            for path in legacy_root.glob("*.json"):
                name = path.name
                if name.endswith(".meta.json") or name.endswith(".key.json"):
                    continue
                candidates.add(path.name.removesuffix(".json"))
        for aid in sorted(candidates):
            identity = self.load_identity(aid)
            if identity is not None:
                return identity
        return None

    def delete_key_pair(self, aid: str) -> None:
        path = self._key_pair_path(aid)
        if path.exists():
            path.unlink()

    def _identity_path(self, aid: str) -> Path:
        return self._legacy_file_path(self._root, aid, ".json")

    def _key_pair_path(self, aid: str) -> Path:
        return self._identity_dir(aid) / "private" / "key.json"

    def _cert_path(self, aid: str) -> Path:
        return self._identity_dir(aid) / "public" / "cert.pem"

    def _metadata_path(self, aid: str) -> Path:
        return self._identity_dir(aid) / "tokens" / "meta.json"

    def _load_legacy_identity(self, aid: str) -> dict | None:
        for legacy_root in self._legacy_roots:
            path = self._legacy_file_path(legacy_root, aid, ".json")
            if path.exists():
                return json.loads(path.read_text(encoding="utf-8"))
        return None

    def _load_identity_from_split_files(self, aid: str) -> dict | None:
        key_pair = self.load_key_pair(aid)
        cert = self.load_cert(aid)
        metadata = self.load_metadata(aid)
        if key_pair is None and cert is None and metadata is None:
            return None
        identity: dict = {}
        if isinstance(metadata, dict):
            identity.update(metadata)
        if isinstance(key_pair, dict):
            identity.update(key_pair)
        if cert:
            identity["cert"] = cert
        return identity

    def _load_legacy_split_file(self, aid: str, suffix: str) -> Path | None:
        for legacy_root in self._legacy_roots:
            path = self._legacy_file_path(legacy_root, aid, suffix)
            if path.exists():
                return path
        return None

    def _identity_dir(self, aid: str) -> Path:
        return self._aids_root / self._safe_aid(aid)

    @staticmethod
    def _safe_aid(aid: str) -> str:
        return aid.replace("/", "_").replace("\\", "_").replace(":", "_")

    def _legacy_file_path(self, legacy_root: Path, aid: str, suffix: str) -> Path:
        return legacy_root / f"{self._safe_aid(aid)}{suffix}"

    def _delete_legacy_identity_files(self, legacy_root: Path, aid: str) -> None:
        for suffix in (".json", ".key.json", ".cert.pem", ".meta.json"):
            path = self._legacy_file_path(legacy_root, aid, suffix)
            if path.exists():
                path.unlink()

    def _protect_metadata(self, aid: str, metadata: dict[str, Any]) -> dict[str, Any]:
        protected = copy.deepcopy(metadata)
        scope = self._safe_aid(aid)
        for field in _SENSITIVE_TOKEN_FIELDS:
            value = protected.pop(field, None)
            if isinstance(value, str) and value:
                protected[f"{field}_protection"] = self._secret_store.protect(scope, field, value.encode("utf-8"))
            elif f"{field}_protection" not in protected:
                self._secret_store.clear(scope, field)

        sessions = protected.get("e2ee_sessions")
        if isinstance(sessions, list):
            sanitized_sessions: list[dict[str, Any]] = []
            for raw in sessions:
                if not isinstance(raw, dict):
                    continue
                session = copy.deepcopy(raw)
                secret_name = self._session_secret_name(session)
                value = session.pop("key", None)
                if isinstance(value, str) and value and secret_name:
                    session["key_protection"] = self._secret_store.protect(
                        scope,
                        secret_name,
                        value.encode("utf-8"),
                    )
                elif secret_name and "key_protection" not in session:
                    self._secret_store.clear(scope, secret_name)
                sanitized_sessions.append(session)
            protected["e2ee_sessions"] = sanitized_sessions

        # 保护 prekey 私钥
        prekeys = protected.get("e2ee_prekeys")
        if isinstance(prekeys, dict):
            sanitized_prekeys: dict[str, dict[str, Any]] = {}
            for prekey_id, prekey_data in prekeys.items():
                if not isinstance(prekey_data, dict):
                    continue
                prekey = copy.deepcopy(prekey_data)
                secret_name = f"e2ee_prekeys/{prekey_id}/private_key"
                value = prekey.pop("private_key_pem", None)
                if isinstance(value, str) and value:
                    prekey["private_key_protection"] = self._secret_store.protect(
                        scope,
                        secret_name,
                        value.encode("utf-8"),
                    )
                elif "private_key_protection" not in prekey:
                    self._secret_store.clear(scope, secret_name)
                sanitized_prekeys[prekey_id] = prekey
            protected["e2ee_prekeys"] = sanitized_prekeys

        # 保护 group_secret
        group_secrets = protected.get("group_secrets")
        if isinstance(group_secrets, dict):
            sanitized_groups: dict[str, dict[str, Any]] = {}
            for group_id, group_data in group_secrets.items():
                if not isinstance(group_data, dict):
                    continue
                group = copy.deepcopy(group_data)
                secret_name = f"group_secrets/{group_id}/secret"
                value = group.pop("secret", None)
                if isinstance(value, str) and value:
                    group["secret_protection"] = self._secret_store.protect(
                        scope, secret_name, value.encode("utf-8"),
                    )
                elif "secret_protection" not in group:
                    self._secret_store.clear(scope, secret_name)
                # 保护 old_epochs 中的 secret
                old_epochs = group.get("old_epochs")
                if isinstance(old_epochs, list):
                    sanitized_old: list[dict[str, Any]] = []
                    for old_data in old_epochs:
                        if not isinstance(old_data, dict):
                            continue
                        old = copy.deepcopy(old_data)
                        old_epoch = old.get("epoch", "?")
                        old_secret_name = f"group_secrets/{group_id}/old/{old_epoch}"
                        old_value = old.pop("secret", None)
                        if isinstance(old_value, str) and old_value:
                            old["secret_protection"] = self._secret_store.protect(
                                scope, old_secret_name, old_value.encode("utf-8"),
                            )
                        elif "secret_protection" not in old:
                            self._secret_store.clear(scope, old_secret_name)
                        sanitized_old.append(old)
                    group["old_epochs"] = sanitized_old
                sanitized_groups[group_id] = group
            protected["group_secrets"] = sanitized_groups

        return protected

    def _restore_metadata(self, aid: str, metadata: dict[str, Any]) -> dict[str, Any]:
        restored = copy.deepcopy(metadata)
        scope = self._safe_aid(aid)
        for field in _SENSITIVE_TOKEN_FIELDS:
            record = restored.get(f"{field}_protection")
            if isinstance(record, dict):
                value = self._secret_store.reveal(scope, field, record)
                if value is not None:
                    restored[field] = value.decode("utf-8")
                else:
                    restored.pop(field, None)

        sessions = restored.get("e2ee_sessions")
        if isinstance(sessions, list):
            for raw in sessions:
                if not isinstance(raw, dict):
                    continue
                record = raw.get("key_protection")
                secret_name = self._session_secret_name(raw)
                if isinstance(record, dict) and secret_name:
                    value = self._secret_store.reveal(scope, secret_name, record)
                    if value is not None:
                        raw["key"] = value.decode("utf-8")
                    else:
                        raw.pop("key", None)

        # 恢复 prekey 私钥
        prekeys = restored.get("e2ee_prekeys")
        if isinstance(prekeys, dict):
            for prekey_id, prekey_data in prekeys.items():
                if not isinstance(prekey_data, dict):
                    continue
                record = prekey_data.get("private_key_protection")
                secret_name = f"e2ee_prekeys/{prekey_id}/private_key"
                if isinstance(record, dict):
                    value = self._secret_store.reveal(scope, secret_name, record)
                    if value is not None:
                        prekey_data["private_key_pem"] = value.decode("utf-8")
                    else:
                        prekey_data.pop("private_key_pem", None)

        # 恢复 group_secret
        group_secrets = restored.get("group_secrets")
        if isinstance(group_secrets, dict):
            for group_id, group_data in group_secrets.items():
                if not isinstance(group_data, dict):
                    continue
                record = group_data.get("secret_protection")
                secret_name = f"group_secrets/{group_id}/secret"
                if isinstance(record, dict):
                    value = self._secret_store.reveal(scope, secret_name, record)
                    if value is not None:
                        group_data["secret"] = value.decode("utf-8")
                    else:
                        group_data.pop("secret", None)
                # 恢复 old_epochs 中的 secret
                old_epochs = group_data.get("old_epochs")
                if isinstance(old_epochs, list):
                    for old_data in old_epochs:
                        if not isinstance(old_data, dict):
                            continue
                        old_record = old_data.get("secret_protection")
                        old_epoch = old_data.get("epoch", "?")
                        old_secret_name = f"group_secrets/{group_id}/old/{old_epoch}"
                        if isinstance(old_record, dict):
                            old_value = self._secret_store.reveal(scope, old_secret_name, old_record)
                            if old_value is not None:
                                old_data["secret"] = old_value.decode("utf-8")
                            else:
                                old_data.pop("secret", None)

        return restored

    @staticmethod
    def _session_secret_name(session: dict[str, Any]) -> str | None:
        session_id = str(session.get("session_id") or "")
        if not session_id:
            return None
        return f"e2ee_sessions/{session_id}/key"

    def _restore_key_pair(self, aid: str, key_pair: dict[str, Any]) -> dict[str, Any]:
        """从 SecretStore 恢复身份私钥（如果被保护）"""
        restored = copy.deepcopy(key_pair)
        scope = self._safe_aid(aid)
        record = restored.get("private_key_protection")
        if isinstance(record, dict):
            value = self._secret_store.reveal(scope, "identity/private_key", record)
            if value is not None:
                restored["private_key_pem"] = value.decode("utf-8")
            else:
                restored.pop("private_key_pem", None)
        return restored

    def _sync_bundled_root_ca(self) -> None:
        """将 SDK 内置根证书同步到 {aun_path}/CA/root/。"""
        bundled_dir = Path(__file__).resolve().parent.parent / "certs"
        if not bundled_dir.exists():
            return
        dest_dir = self._root / "CA" / "root"
        for src in sorted(bundled_dir.glob("*.crt")):
            dest = dest_dir / src.name
            if dest.exists():
                continue
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(src.read_bytes())
            except OSError:
                pass  # 平台兼容 fallback

    @staticmethod
    def _prepare_root(preferred: Path, fallback: Path) -> Path:
        try:
            preferred.mkdir(parents=True, exist_ok=True)
            return preferred
        except Exception:
            fallback.mkdir(parents=True, exist_ok=True)
            return fallback

    def _legacy_subdir_ks(self, aid: str) -> "FileKeyStore | None":
        """返回旧格式子目录的 FileKeyStore，不存在则返回 None。
        旧版 SDK 把 aun_path 设为 ~/.aun/{aid}，数据在 ~/.aun/{aid}/AIDs/{aid}/。
        """
        subdir = self._root / self._safe_aid(aid)
        if subdir.is_dir() and (subdir / "AIDs").is_dir():
            return FileKeyStore(subdir, secret_store=self._secret_store)
        return None
