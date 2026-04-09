from __future__ import annotations

import base64
import hmac as _hmac
import json
import logging
import secrets
import time as _time_mod
import uuid
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .errors import (
    E2EEDecryptFailedError,
    E2EEError,
    E2EEGroupCommitmentInvalidError,
    E2EEGroupDecryptFailedError,
    E2EEGroupEpochMismatchError,
    E2EEGroupNotMemberError,
    E2EEGroupSecretMissingError,
)


_e2ee_log = logging.getLogger("aun_core.e2ee")


SUITE = "P256_HKDF_SHA256_AES_256_GCM"

# 加密模式
MODE_PREKEY_ECDH_V2 = "prekey_ecdh_v2"  # 四路 ECDH：prekey + identity
MODE_LONG_TERM_KEY = "long_term_key"    # 降级：长期公钥加密

# AAD 字段
AAD_FIELDS_OFFLINE = (
    "from", "to", "message_id", "timestamp",
    "encryption_mode", "suite", "ephemeral_public_key",
    "recipient_cert_fingerprint", "sender_cert_fingerprint",
    "prekey_id",
)
AAD_MATCH_FIELDS_OFFLINE = (
    "from", "to", "message_id",
    "encryption_mode", "suite", "ephemeral_public_key",
    "recipient_cert_fingerprint", "sender_cert_fingerprint",
    "prekey_id",
)

# prekey 私钥本地保留时间（秒）
PREKEY_RETENTION_SECONDS = 7 * 24 * 3600  # 7 天

# ── 群组 E2EE 常量 ──────────────────────────────────────────
MODE_EPOCH_GROUP_KEY = "epoch_group_key"

AAD_FIELDS_GROUP = (
    "group_id", "from", "message_id", "timestamp",
    "epoch", "encryption_mode", "suite",
)
AAD_MATCH_FIELDS_GROUP = (
    "group_id", "from", "message_id",
    "epoch", "encryption_mode", "suite",
)


class E2EEManager:
    """端到端加密工具类 — 纯密码学操作，无 I/O 依赖。

    加密策略：prekey_ecdh_v2（双 ECDH）→ long_term_key 两层降级。
    I/O（获取 prekey、证书）由调用方（AUNClient）负责。
    内置本地防重放（seen set），裸 WebSocket 开发者无需额外实现。
    """

    def __init__(
        self,
        *,
        identity_fn: Any,
        keystore: Any,
        prekey_cache_ttl: float = 3600.0,
        replay_window_seconds: int = 300,
    ) -> None:
        self._identity_fn = identity_fn
        self._keystore_ref = keystore
        # 本地防重放 seen set
        self._seen_messages: dict[str, bool] = {}
        self._seen_max_size = 50000
        # 对方 prekey 内存缓存（TTL 默认 1 小时）
        self._prekey_cache: dict[str, tuple[dict[str, Any], float]] = {}
        self._prekey_cache_ttl = prekey_cache_ttl
        # 本地 prekey 私钥内存缓存 {prekey_id: EllipticCurvePrivateKey}
        self._local_prekey_cache: dict[str, ec.EllipticCurvePrivateKey] = {}
        # 防重放时间窗口（秒）
        self._replay_window_seconds = replay_window_seconds

    # ── 便利方法 ──────────────────────────────────────────────

    def encrypt_message(
        self,
        to_aid: str,
        payload: dict[str, Any],
        *,
        peer_cert_pem: bytes,
        prekey: dict[str, Any] | None = None,
        message_id: str | None = None,
        timestamp: int | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """加密消息（便利方法）。

        调用方负责提前获取 peer_cert_pem 和 prekey（可选）。
        有 prekey 时用 prekey_ecdh_v2（四路 ECDH），无 prekey 时降级为 long_term_key。
        返回 (envelope, result_info)，result_info 包含 encrypted/forward_secrecy/mode 等状态。
        """
        message_id = message_id or str(uuid.uuid4())
        timestamp = timestamp or int(_time_mod.time() * 1000)
        return self.encrypt_outbound(
            peer_aid=to_aid,
            payload=payload,
            peer_cert_pem=peer_cert_pem,
            prekey=prekey,
            message_id=message_id,
            timestamp=timestamp,
        )

    def decrypt_message(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """解密单条消息（便利方法，内置本地防重放 + timestamp 窗口）。"""
        payload = message.get("payload")
        if not isinstance(payload, dict):
            return message
        payload_type = payload.get("type")
        if payload_type != "e2ee.encrypted":
            return message
        if message.get("encrypted") is not True and "encrypted" in message:
            return message
        if not self._should_decrypt_for_current_aid(message, payload):
            return message

        # timestamp 窗口检查
        ts = message.get("timestamp") or (payload.get("aad") or {}).get("timestamp")
        if isinstance(ts, (int, float)) and self._replay_window_seconds > 0:
            now_ms = int(_time_mod.time() * 1000)
            diff_s = abs(now_ms - ts) / 1000
            if diff_s > self._replay_window_seconds:
                _e2ee_log.warning(
                    "消息 timestamp 超出窗口 (%.0fs > %ds)，拒绝: from=%s mid=%s",
                    diff_s, self._replay_window_seconds,
                    message.get("from"), message.get("message_id"),
                )
                return None

        # 本地防重放
        message_id = message.get("message_id", "")
        from_aid = message.get("from", "")
        if message_id and from_aid:
            seen_key = f"{from_aid}:{message_id}"
            if seen_key in self._seen_messages:
                return None  # 重放消息
            self._seen_messages[seen_key] = True
            self._trim_seen_set()

        return self._decrypt_message(message)

    def _should_decrypt_for_current_aid(self, message: dict[str, Any], payload: dict[str, Any]) -> bool:
        """仅解密发给当前 AID 的消息，避免发送端回显消息误走接收端解密流程。"""
        current_aid = self._current_aid()
        if not current_aid:
            return True
        target_aid = (
            message.get("to")
            or (payload.get("aad") or {}).get("to")
            or payload.get("to")
        )
        if not target_aid:
            return True
        return str(target_aid) == str(current_aid)

    def _trim_seen_set(self) -> None:
        if len(self._seen_messages) > self._seen_max_size:
            trim_count = len(self._seen_messages) - int(self._seen_max_size * 0.8)
            keys = list(self._seen_messages.keys())[:trim_count]
            for k in keys:
                del self._seen_messages[k]

    # ── Prekey 缓存 ────────────────────────────────────────────

    def cache_prekey(self, peer_aid: str, prekey: dict[str, Any]) -> None:
        """缓存对方的 prekey（调用方获取后存入，后续 encrypt 自动复用）"""
        self._prekey_cache[peer_aid] = (prekey, _time_mod.time() + self._prekey_cache_ttl)

    def get_cached_prekey(self, peer_aid: str) -> dict[str, Any] | None:
        """获取缓存的 prekey（过期返回 None）"""
        cached = self._prekey_cache.get(peer_aid)
        if cached is None:
            return None
        prekey, expire_at = cached
        if _time_mod.time() >= expire_at:
            del self._prekey_cache[peer_aid]
            return None
        return prekey

    def invalidate_prekey_cache(self, peer_aid: str) -> None:
        """使指定 peer 的 prekey 缓存失效"""
        self._prekey_cache.pop(peer_aid, None)

    # ── 加密 ─────────────────────────────────────────────────

    def encrypt_outbound(
        self,
        peer_aid: str,
        payload: dict[str, Any],
        *,
        peer_cert_pem: bytes,
        prekey: dict[str, Any] | None = None,
        message_id: str,
        timestamp: int,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """加密出站消息：有 prekey → prekey_ecdh_v2（四路 ECDH），无 prekey → long_term_key。

        返回 (envelope, result_info)，result_info 包含加密状态详情：
          encrypted: bool, forward_secrecy: bool, mode: str, degraded: bool
        prekey 传入时自动缓存；传入 None 时自动查缓存。
        """
        # 传入 prekey → 缓存；传入 None → 查缓存
        if prekey is not None:
            self.cache_prekey(peer_aid, prekey)
        else:
            prekey = self.get_cached_prekey(peer_aid)

        if prekey:
            try:
                envelope, ok = self._encrypt_with_prekey(
                    peer_aid, payload, prekey, peer_cert_pem,
                    message_id=message_id, timestamp=timestamp,
                )
                return envelope, {
                    "encrypted": True,
                    "forward_secrecy": True,
                    "mode": MODE_PREKEY_ECDH_V2,
                    "degraded": False,
                }
            except Exception as exc:
                _e2ee_log.warning(
                    "prekey 加密失败，降级到 long_term_key（无前向保密）: %s", exc
                )

        envelope, ok = self._encrypt_with_long_term_key(
            peer_aid, payload, peer_cert_pem,
            message_id=message_id, timestamp=timestamp,
        )
        degraded = prekey is not None  # 有 prekey 但失败了才算降级
        return envelope, {
            "encrypted": True,
            "forward_secrecy": False,
            "mode": MODE_LONG_TERM_KEY,
            "degraded": degraded,
            "degradation_reason": "prekey_encrypt_failed" if degraded else "no_prekey_available",
        }

    def _encrypt_with_prekey(
        self,
        peer_aid: str,
        payload: dict[str, Any],
        prekey: dict[str, Any],
        peer_cert_pem: bytes,
        *,
        message_id: str,
        timestamp: int,
    ) -> tuple[dict[str, Any], bool]:
        """使用对方 prekey 加密（prekey_ecdh_v2 模式，四路 ECDH + 发送方签名）

        四路 ECDH:
          DH1 = ECDH(ephemeral, peer_prekey)
          DH2 = ECDH(ephemeral, peer_identity)
          DH3 = ECDH(sender_identity, peer_prekey)   ← 绑定发送方身份
          DH4 = ECDH(sender_identity, peer_identity)  ← 双方身份互绑
        """
        # 验证 prekey 签名
        cert = x509.load_pem_x509_certificate(
            peer_cert_pem if isinstance(peer_cert_pem, bytes) else peer_cert_pem.encode("utf-8")
        )
        peer_identity_public = cert.public_key()

        # 验证 prekey 签名（支持含/不含 created_at 的格式）
        created_at = prekey.get("created_at")
        if created_at is not None:
            sign_data = f"{prekey['prekey_id']}|{prekey['public_key']}|{created_at}".encode("utf-8")
            # 检查 prekey 年龄（默认 30 天）
            age_ms = int(_time_mod.time() * 1000) - int(created_at)
            if age_ms > 30 * 24 * 3600 * 1000:
                raise E2EEError(f"prekey too old: {age_ms // 1000}s")
        else:
            sign_data = f"{prekey['prekey_id']}|{prekey['public_key']}".encode("utf-8")
        signature_bytes = base64.b64decode(prekey["signature"])
        try:
            peer_identity_public.verify(signature_bytes, sign_data, ec.ECDSA(hashes.SHA256()))
        except Exception as exc:
            raise E2EEError(f"prekey signature verification failed: {exc}")

        # 导入对方 prekey 公钥
        peer_prekey_public = serialization.load_der_public_key(
            base64.b64decode(prekey["public_key"])
        )

        # 加载发送方自己的 identity 私钥
        sender_identity_private = self._load_sender_identity_private()

        # 生成临时 ECDH 密钥对
        ephemeral_private = ec.generate_private_key(ec.SECP256R1())
        ephemeral_public_bytes = ephemeral_private.public_key().public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )

        # 四路 ECDH + HKDF
        dh1 = ephemeral_private.exchange(ec.ECDH(), peer_prekey_public)
        dh2 = ephemeral_private.exchange(ec.ECDH(), peer_identity_public)
        dh3 = sender_identity_private.exchange(ec.ECDH(), peer_prekey_public)
        dh4 = sender_identity_private.exchange(ec.ECDH(), peer_identity_public)
        combined = dh1 + dh2 + dh3 + dh4
        hkdf = HKDF(
            algorithm=hashes.SHA256(), length=32, salt=None,
            info=f"aun-prekey-v2:{prekey['prekey_id']}".encode("utf-8"),
        )
        message_key = hkdf.derive(combined)

        # AES-GCM 加密
        plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        nonce = secrets.token_bytes(12)
        aesgcm = AESGCM(message_key)

        sender_fingerprint = self._local_identity_fingerprint()
        recipient_fingerprint = self._fingerprint_cert_pem(peer_cert_pem)
        ephemeral_pk_b64 = base64.b64encode(ephemeral_public_bytes).decode("ascii")
        aad = {
            "from": self._current_aid(),
            "to": peer_aid,
            "message_id": message_id,
            "timestamp": timestamp,
            "encryption_mode": MODE_PREKEY_ECDH_V2,
            "suite": SUITE,
            "ephemeral_public_key": ephemeral_pk_b64,
            "recipient_cert_fingerprint": recipient_fingerprint,
            "sender_cert_fingerprint": sender_fingerprint,
            "prekey_id": prekey["prekey_id"],
        }
        ciphertext_with_tag = aesgcm.encrypt(nonce, plaintext, self._aad_bytes_offline(aad))
        ciphertext = ciphertext_with_tag[:-16]
        tag = ciphertext_with_tag[-16:]

        envelope = {
            "type": "e2ee.encrypted",
            "version": "1",
            "encryption_mode": MODE_PREKEY_ECDH_V2,
            "suite": SUITE,
            "prekey_id": prekey["prekey_id"],
            "ephemeral_public_key": ephemeral_pk_b64,
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
            "tag": base64.b64encode(tag).decode("ascii"),
            "aad": aad,
        }
        # 发送方签名：对 ciphertext + tag + aad_bytes 签名（不可否认性）
        sign_payload = ciphertext + tag + self._aad_bytes_offline(aad)
        envelope["sender_signature"] = self._sign_bytes(sign_payload)
        envelope["sender_cert_fingerprint"] = sender_fingerprint
        return envelope, True

    def _encrypt_with_long_term_key(
        self,
        peer_aid: str,
        payload: dict[str, Any],
        peer_cert_pem: bytes,
        *,
        message_id: str,
        timestamp: int,
    ) -> tuple[dict[str, Any], bool]:
        """使用 2DH 加密（long_term_key 模式 + 发送方签名）

        2DH:
          DH1 = ECDH(ephemeral, peer_identity)   ← 前向保密（每消息）
          DH2 = ECDH(sender_identity, peer_identity) ← 绑定双方身份
        """
        cert = x509.load_pem_x509_certificate(
            peer_cert_pem if isinstance(peer_cert_pem, bytes) else peer_cert_pem.encode("utf-8")
        )
        peer_public_key = cert.public_key()

        if not isinstance(peer_public_key, ec.EllipticCurvePublicKey):
            raise E2EEError("Peer certificate does not contain EC public key")

        sender_identity_private = self._load_sender_identity_private()

        # 生成临时密钥对
        ephemeral_private = ec.generate_private_key(ec.SECP256R1())
        ephemeral_public_bytes = ephemeral_private.public_key().public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )

        # 2DH + HKDF
        dh1 = ephemeral_private.exchange(ec.ECDH(), peer_public_key)
        dh2 = sender_identity_private.exchange(ec.ECDH(), peer_public_key)
        combined = dh1 + dh2
        hkdf = HKDF(
            algorithm=hashes.SHA256(), length=32, salt=None,
            info=b"aun-longterm-v2",
        )
        message_key = hkdf.derive(combined)

        plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        nonce = secrets.token_bytes(12)
        aesgcm = AESGCM(message_key)

        sender_fingerprint = self._local_identity_fingerprint()
        recipient_fingerprint = self._fingerprint_cert_pem(peer_cert_pem)
        ephemeral_pk_b64 = base64.b64encode(ephemeral_public_bytes).decode("ascii")
        aad = {
            "from": self._current_aid(),
            "to": peer_aid,
            "message_id": message_id,
            "timestamp": timestamp,
            "encryption_mode": MODE_LONG_TERM_KEY,
            "suite": SUITE,
            "ephemeral_public_key": ephemeral_pk_b64,
            "recipient_cert_fingerprint": recipient_fingerprint,
            "sender_cert_fingerprint": sender_fingerprint,
        }
        ciphertext_with_tag = aesgcm.encrypt(nonce, plaintext, self._aad_bytes_offline(aad))
        ciphertext = ciphertext_with_tag[:-16]
        tag = ciphertext_with_tag[-16:]

        envelope = {
            "type": "e2ee.encrypted",
            "version": "1",
            "encryption_mode": MODE_LONG_TERM_KEY,
            "suite": SUITE,
            "ephemeral_public_key": ephemeral_pk_b64,
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
            "tag": base64.b64encode(tag).decode("ascii"),
            "aad": aad,
        }
        # 发送方签名（不可否认性）
        sign_payload = ciphertext + tag + self._aad_bytes_offline(aad)
        envelope["sender_signature"] = self._sign_bytes(sign_payload)
        envelope["sender_cert_fingerprint"] = sender_fingerprint
        return envelope, True

    # ── 解密 ─────────────────────────────────────────────────

    def _verify_sender_signature(self, payload: dict[str, Any], message: dict[str, Any]) -> None:
        """验证发送方签名。无签名或验签失败直接抛异常。"""
        sender_sig_b64 = payload.get("sender_signature")
        if not sender_sig_b64:
            raise E2EEDecryptFailedError("sender_signature missing: 拒绝无发送方签名的消息")

        # 获取发送方证书公钥
        from_aid = message.get("from") or (payload.get("aad") or {}).get("from")
        if not from_aid:
            raise E2EEDecryptFailedError("from_aid missing in message")

        sender_cert_pem = self._get_sender_cert(from_aid)
        if sender_cert_pem is None:
            raise E2EEDecryptFailedError(f"sender cert not found for {from_aid}")

        cert = x509.load_pem_x509_certificate(
            sender_cert_pem if isinstance(sender_cert_pem, bytes) else sender_cert_pem.encode("utf-8")
        )
        sender_public_key = cert.public_key()

        # 重建签名载荷
        ciphertext = base64.b64decode(payload["ciphertext"])
        tag = base64.b64decode(payload["tag"])
        aad = payload.get("aad")
        aad_bytes = self._aad_bytes_offline(aad) if isinstance(aad, dict) else b""
        sign_payload = ciphertext + tag + aad_bytes

        sig_bytes = base64.b64decode(sender_sig_b64)
        try:
            sender_public_key.verify(sig_bytes, sign_payload, ec.ECDSA(hashes.SHA256()))
        except Exception as exc:
            raise E2EEDecryptFailedError(f"sender signature verification failed: {exc}")

    def _get_sender_cert(self, aid: str) -> bytes | None:
        """从 keystore 或缓存获取发送方证书"""
        keystore = self._keystore()
        if keystore is None:
            return None
        cert_pem = keystore.load_cert(aid)
        if cert_pem:
            return cert_pem.encode("utf-8") if isinstance(cert_pem, str) else cert_pem
        return None

    def _load_sender_public_key(self, aid: str | None) -> ec.EllipticCurvePublicKey | None:
        """获取发送方的 identity 公钥（从本地证书缓存）"""
        if not aid:
            return None
        cert_pem = self._get_sender_cert(aid)
        if cert_pem is None:
            return None
        try:
            cert = x509.load_pem_x509_certificate(cert_pem)
            pk = cert.public_key()
            if isinstance(pk, ec.EllipticCurvePublicKey):
                return pk
        except Exception as exc:
            _e2ee_log.warning("加载发送方 %s 证书公钥失败: %s", aid, exc)
        return None

    def _decrypt_message(self, message: dict[str, Any]) -> dict[str, Any] | None:
        payload = message["payload"]
        if isinstance(payload, dict) and not self._should_decrypt_for_current_aid(message, payload):
            return message
        encryption_mode = payload.get("encryption_mode", "")

        # 验证发送方签名（适用于所有模式）
        try:
            self._verify_sender_signature(payload, message)
        except E2EEDecryptFailedError as exc:
            _e2ee_log.warning("发送方签名验证失败: %s", exc)
            return None

        if encryption_mode == MODE_PREKEY_ECDH_V2:
            return self._decrypt_message_prekey_v2(message)
        elif encryption_mode == MODE_LONG_TERM_KEY:
            return self._decrypt_message_long_term(message)
        else:
            _e2ee_log.warning("不支持的加密模式: %s", encryption_mode)
            return None

    def _decrypt_message_prekey_v2(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """解密 prekey_ecdh_v2 模式的消息（四路 ECDH：prekey + identity + sender_identity）"""
        payload = message["payload"]
        try:
            ephemeral_public_bytes = base64.b64decode(payload["ephemeral_public_key"])
            prekey_id = payload.get("prekey_id", "")
            nonce = base64.b64decode(payload["nonce"])
            ciphertext = base64.b64decode(payload["ciphertext"])
            tag = base64.b64decode(payload["tag"])

            keystore = self._keystore()
            if not keystore:
                raise E2EEError("Keystore unavailable")
            prekey_private_key = self._load_prekey_private_key(keystore, prekey_id)
            if prekey_private_key is None:
                raise E2EEError(f"prekey not found: {prekey_id}")

            # 加载接收方自己的 identity 私钥
            my_aid = self._current_aid()
            key_pair = keystore.load_key_pair(my_aid)
            if not key_pair or "private_key_pem" not in key_pair:
                raise E2EEError("Identity private key not found")
            my_identity_private = serialization.load_pem_private_key(
                key_pair["private_key_pem"].encode("utf-8"), password=None
            )
            if not isinstance(my_identity_private, ec.EllipticCurvePrivateKey):
                raise E2EEError("Identity private key is not EC key")

            # 获取发送方公钥（四路 ECDH 需要）
            from_aid = message.get("from") or (payload.get("aad") or {}).get("from")
            sender_public_key = self._load_sender_public_key(from_aid)
            if sender_public_key is None:
                raise E2EEError(f"sender public key not found for {from_aid}")

            # 四路 ECDH + HKDF
            ephemeral_public = ec.EllipticCurvePublicKey.from_encoded_point(
                ec.SECP256R1(), ephemeral_public_bytes
            )
            dh1 = prekey_private_key.exchange(ec.ECDH(), ephemeral_public)
            dh2 = my_identity_private.exchange(ec.ECDH(), ephemeral_public)
            dh3 = prekey_private_key.exchange(ec.ECDH(), sender_public_key)
            dh4 = my_identity_private.exchange(ec.ECDH(), sender_public_key)
            combined = dh1 + dh2 + dh3 + dh4
            hkdf = HKDF(
                algorithm=hashes.SHA256(), length=32, salt=None,
                info=f"aun-prekey-v2:{prekey_id}".encode("utf-8"),
            )
            message_key = hkdf.derive(combined)

            # 验证 AAD 并解密
            aesgcm = AESGCM(message_key)
            aad = payload.get("aad")
            if isinstance(aad, dict):
                expected_aad = self._build_inbound_aad_offline(message, payload)
                if not self._aad_matches_offline(expected_aad, aad):
                    raise E2EEDecryptFailedError("aad mismatch")
                aad_bytes = self._aad_bytes_offline(aad)
            else:
                aad_bytes = b""
            plaintext = aesgcm.decrypt(nonce, ciphertext + tag, aad_bytes)

            decoded = json.loads(plaintext.decode("utf-8"))
            transformed = dict(message)
            transformed["payload"] = decoded
            transformed["encrypted"] = True
            transformed["e2ee"] = {
                "encryption_mode": MODE_PREKEY_ECDH_V2,
                "suite": payload.get("suite", SUITE),
                "prekey_id": prekey_id,
            }
            return transformed
        except E2EEError as exc:
            _e2ee_log.warning("prekey_ecdh_v2 解密失败 (E2EE): %s", exc)
            return None
        except Exception as exc:
            _e2ee_log.warning("prekey_ecdh_v2 解密失败: %s", exc)
            return None

    def _decrypt_message_long_term(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """解密 long_term_key 模式的消息（2DH：ephemeral↔identity + sender_identity↔identity）"""
        payload = message["payload"]
        try:
            ephemeral_public_bytes = base64.b64decode(payload["ephemeral_public_key"])
            nonce = base64.b64decode(payload["nonce"])
            ciphertext = base64.b64decode(payload["ciphertext"])
            tag = base64.b64decode(payload["tag"])

            keystore = self._keystore()
            if not keystore:
                raise E2EEError("Keystore unavailable")
            my_aid = self._current_aid()
            key_pair = keystore.load_key_pair(my_aid)
            if not key_pair or "private_key_pem" not in key_pair:
                raise E2EEError("Private key not found")
            private_key = serialization.load_pem_private_key(
                key_pair["private_key_pem"].encode("utf-8"), password=None
            )
            if not isinstance(private_key, ec.EllipticCurvePrivateKey):
                raise E2EEError("Private key is not EC key")

            # 获取发送方公钥（2DH 需要）
            from_aid = message.get("from") or (payload.get("aad") or {}).get("from")
            sender_public_key = self._load_sender_public_key(from_aid)
            if sender_public_key is None:
                raise E2EEError(f"sender public key not found for {from_aid}")

            # 2DH + HKDF
            ephemeral_public = ec.EllipticCurvePublicKey.from_encoded_point(
                ec.SECP256R1(), ephemeral_public_bytes
            )
            dh1 = private_key.exchange(ec.ECDH(), ephemeral_public)
            dh2 = private_key.exchange(ec.ECDH(), sender_public_key)
            combined = dh1 + dh2
            hkdf = HKDF(
                algorithm=hashes.SHA256(), length=32, salt=None,
                info=b"aun-longterm-v2",
            )
            message_key = hkdf.derive(combined)

            aesgcm = AESGCM(message_key)
            aad = payload.get("aad")
            if isinstance(aad, dict):
                expected_aad = self._build_inbound_aad_offline(message, payload)
                if not self._aad_matches_offline(expected_aad, aad):
                    raise E2EEDecryptFailedError("aad mismatch")
                aad_bytes = self._aad_bytes_offline(aad)
            else:
                aad_bytes = b""
            plaintext = aesgcm.decrypt(nonce, ciphertext + tag, aad_bytes)

            decoded = json.loads(plaintext.decode("utf-8"))
            transformed = dict(message)
            transformed["payload"] = decoded
            transformed["encrypted"] = True
            transformed["e2ee"] = {
                "encryption_mode": MODE_LONG_TERM_KEY,
                "suite": payload["suite"],
            }
            return transformed
        except E2EEError as exc:
            _e2ee_log.warning("long_term_key 解密失败 (E2EE): %s", exc)
            return None
        except Exception as exc:
            _e2ee_log.warning("long_term_key 解密失败: %s", exc)
            return None

    # ── AAD 工具 ─────────────────────────────────────────────

    @staticmethod
    def _aad_bytes_offline(aad: dict[str, Any]) -> bytes:
        return json.dumps(
            {field: aad.get(field) for field in AAD_FIELDS_OFFLINE},
            ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")

    @staticmethod
    def _aad_matches_offline(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
        return all(expected.get(field) == actual.get(field) for field in AAD_MATCH_FIELDS_OFFLINE)

    def _build_inbound_aad_offline(self, message: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "from": message.get("from"),
            "to": message.get("to"),
            "message_id": message.get("message_id"),
            "timestamp": message.get("timestamp"),
            "encryption_mode": payload.get("encryption_mode"),
            "suite": payload.get("suite", SUITE),
            "ephemeral_public_key": payload.get("ephemeral_public_key"),
            "recipient_cert_fingerprint": self._local_cert_fingerprint(),
            "sender_cert_fingerprint": payload.get("sender_cert_fingerprint") or (payload.get("aad") or {}).get("sender_cert_fingerprint"),
            "prekey_id": payload.get("prekey_id") or (payload.get("aad") or {}).get("prekey_id"),
        }

    # ── Prekey 生成 ──────────────────────────────────────────

    def generate_prekey(self) -> dict[str, Any]:
        """生成 prekey 材料并保存私钥到本地 keystore。

        返回 dict 包含 prekey_id、public_key、signature，可直接用于 RPC 上传。
        调用方负责调 transport.call("message.e2ee.put_prekey", result) 上传。
        """
        keystore = self._keystore()
        if keystore is None:
            raise E2EEError("Keystore unavailable for prekey generation")
        aid = self._current_aid()
        if not aid:
            raise E2EEError("AID unavailable for prekey generation")

        # 生成新 prekey
        private_key = ec.generate_private_key(ec.SECP256R1())
        public_der = private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        prekey_id = str(uuid.uuid4())
        public_key_b64 = base64.b64encode(public_der).decode("ascii")
        now_ms = int(_time_mod.time() * 1000)

        # 签名：prekey_id|public_key|created_at（绑定时间戳，防止旧 prekey 重放）
        sign_data = f"{prekey_id}|{public_key_b64}|{now_ms}".encode("utf-8")
        signature = self._sign_bytes(sign_data)

        # 保存私钥到本地 keystore
        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("utf-8")

        metadata = keystore.load_metadata(aid) or {}
        local_prekeys = metadata.get("e2ee_prekeys", {})
        local_prekeys[prekey_id] = {
            "private_key_pem": private_key_pem,
            "created_at": now_ms,
        }
        metadata["e2ee_prekeys"] = local_prekeys
        keystore.save_metadata(aid, metadata)

        # 内存缓存私钥（即使磁盘 metadata 被覆盖也不丢）
        self._local_prekey_cache[prekey_id] = private_key

        # 清理过期的旧 prekey 私钥
        self._cleanup_expired_prekeys(keystore, aid)

        return {
            "prekey_id": prekey_id,
            "public_key": public_key_b64,
            "signature": signature,
            "created_at": now_ms,
        }

    def _cleanup_expired_prekeys(self, keystore: Any, aid: str) -> None:
        """清理本地过期的 prekey 私钥"""
        metadata = keystore.load_metadata(aid) or {}
        local_prekeys = metadata.get("e2ee_prekeys", {})
        if not local_prekeys:
            return

        now_ms = int(_time_mod.time() * 1000)
        cutoff_ms = now_ms - PREKEY_RETENTION_SECONDS * 1000
        expired = [pid for pid, data in local_prekeys.items()
                   if data.get("created_at", 0) < cutoff_ms]
        if expired:
            for pid in expired:
                del local_prekeys[pid]
                self._local_prekey_cache.pop(pid, None)  # 同步清理内存缓存
            metadata["e2ee_prekeys"] = local_prekeys
            keystore.save_metadata(aid, metadata)

    def _load_prekey_private_key(self, keystore: Any, prekey_id: str) -> ec.EllipticCurvePrivateKey | None:
        """从内存缓存或 keystore 加载 prekey 私钥"""
        # 优先从内存缓存获取（不受磁盘 metadata 覆盖影响）
        cached = self._local_prekey_cache.get(prekey_id)
        if cached is not None:
            return cached

        aid = self._current_aid()
        if not aid:
            return None
        metadata = keystore.load_metadata(aid) or {}
        prekeys = metadata.get("e2ee_prekeys", {})
        prekey_data = prekeys.get(prekey_id)
        if not prekey_data:
            return None
        private_key_pem = prekey_data.get("private_key_pem")
        if not private_key_pem:
            return None

        # 尝试加密存储（向后兼容）
        key_pair = keystore.load_key_pair(aid)
        if key_pair and "private_key_pem" in key_pair:
            identity_key_hash = hashes.Hash(hashes.SHA256())
            identity_key_hash.update(key_pair["private_key_pem"].encode("utf-8"))
            encryption_password = identity_key_hash.finalize()[:32]
            try:
                pk = serialization.load_pem_private_key(
                    private_key_pem.encode("utf-8"), password=encryption_password
                )
                if isinstance(pk, ec.EllipticCurvePrivateKey):
                    self._local_prekey_cache[prekey_id] = pk  # 回填内存缓存
                    return pk
            except Exception as exc:
                _e2ee_log.debug("prekey %s 加密格式加载失败: %s", prekey_id, exc)

        try:
            pk = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
            if isinstance(pk, ec.EllipticCurvePrivateKey):
                self._local_prekey_cache[prekey_id] = pk  # 回填内存缓存
                return pk
        except Exception as exc:
            _e2ee_log.debug("prekey %s 明文格式加载失败: %s", prekey_id, exc)
        _e2ee_log.warning("prekey %s 私钥加载失败，所有格式均不可用", prekey_id)
        return None

    # ── 证书指纹工具 ────────────────────────────────────────

    @classmethod
    def _fingerprint_cert_pem(cls, cert_pem: bytes) -> str:
        """从 PEM 证书计算公钥指纹"""
        cert_bytes = cert_pem if isinstance(cert_pem, bytes) else cert_pem.encode("utf-8")
        cert = x509.load_pem_x509_certificate(cert_bytes)
        return cls._fingerprint_public_key(cert.public_key())

    def _local_cert_fingerprint(self) -> str:
        return self._local_identity_fingerprint()

    def _sign_bytes(self, data: bytes) -> str:
        identity = self._identity_fn()
        private_key_pem = identity.get("private_key_pem")
        if not private_key_pem:
            raise E2EEError("identity private key unavailable")
        private_key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
        signature = private_key.sign(data, ec.ECDSA(hashes.SHA256()))
        return base64.b64encode(signature).decode("ascii")

    def _load_sender_identity_private(self) -> ec.EllipticCurvePrivateKey:
        """加载发送方自己的 identity 私钥（用于四路 ECDH）"""
        identity = self._identity_fn()
        private_key_pem = identity.get("private_key_pem")
        if not private_key_pem:
            raise E2EEError("sender identity private key unavailable")
        pk = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
        if not isinstance(pk, ec.EllipticCurvePrivateKey):
            raise E2EEError("sender identity key is not EC key")
        return pk

    def _local_identity_fingerprint(self) -> str:
        identity = self._identity_fn()
        public_key_der_b64 = identity.get("public_key_der_b64")
        if isinstance(public_key_der_b64, str) and public_key_der_b64:
            return self._fingerprint_der_public_key(base64.b64decode(public_key_der_b64))
        cert_pem = identity.get("cert")
        if isinstance(cert_pem, str) and cert_pem:
            cert = x509.load_pem_x509_certificate(cert_pem.encode("utf-8"))
            return self._fingerprint_public_key(cert.public_key())
        private_key_pem = identity.get("private_key_pem")
        if isinstance(private_key_pem, str) and private_key_pem:
            private_key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
            return self._fingerprint_public_key(private_key.public_key())
        raise E2EEError("identity fingerprint unavailable")

    @classmethod
    def _fingerprint_public_key(cls, public_key: Any) -> str:
        der = public_key.public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return cls._fingerprint_der_public_key(der)

    @staticmethod
    def _fingerprint_der_public_key(der: bytes) -> str:
        digest = hashes.Hash(hashes.SHA256())
        digest.update(der)
        return f"sha256:{digest.finalize().hex()}"

    # ── 内部工具 ─────────────────────────────────────────────

    def _current_aid(self) -> str | None:
        identity = self._identity_fn()
        aid = identity.get("aid")
        return str(aid) if aid else None

    def _keystore(self) -> Any | None:
        return self._keystore_ref


# ── 群组 E2EE 函数 ─────────────────────────────────────────


def _derive_group_msg_key(
    group_secret: bytes, group_id: str, message_id: str,
) -> bytes:
    """从 group_secret 派生单条群消息的加密密钥。"""
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=f"aun-group:{group_id}:msg:{message_id}".encode("utf-8"),
    )
    return hkdf.derive(group_secret)


def _aad_bytes_group(aad: dict[str, Any]) -> bytes:
    """群组 AAD 序列化（sorted keys, compact JSON）。"""
    return json.dumps(
        {field: aad.get(field) for field in AAD_FIELDS_GROUP},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")


def _aad_matches_group(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    """群组 AAD 字段匹配检查。"""
    return all(expected.get(f) == actual.get(f) for f in AAD_MATCH_FIELDS_GROUP)


def encrypt_group_message(
    group_id: str,
    epoch: int,
    group_secret: bytes,
    payload: dict[str, Any],
    *,
    from_aid: str,
    message_id: str,
    timestamp: int,
    sender_private_key_pem: str | None = None,
) -> dict[str, Any]:
    """加密群组消息，返回 e2ee.group_encrypted 信封。

    sender_private_key_pem: 可选，传入时为密文附加发送方 ECDSA 签名（不可否认性）。
    """
    msg_key = _derive_group_msg_key(group_secret, group_id, message_id)
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    nonce = secrets.token_bytes(12)
    aesgcm = AESGCM(msg_key)

    aad = {
        "group_id": group_id,
        "from": from_aid,
        "message_id": message_id,
        "timestamp": timestamp,
        "epoch": epoch,
        "encryption_mode": MODE_EPOCH_GROUP_KEY,
        "suite": SUITE,
    }
    ciphertext_with_tag = aesgcm.encrypt(nonce, plaintext, _aad_bytes_group(aad))
    ciphertext = ciphertext_with_tag[:-16]
    tag = ciphertext_with_tag[-16:]

    envelope = {
        "type": "e2ee.group_encrypted",
        "version": "1",
        "encryption_mode": MODE_EPOCH_GROUP_KEY,
        "suite": SUITE,
        "epoch": epoch,
        "nonce": base64.b64encode(nonce).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "tag": base64.b64encode(tag).decode("ascii"),
        "aad": aad,
    }

    # 发送方签名：对 ciphertext + tag + aad_bytes 签名（不可否认性）
    if sender_private_key_pem:
        try:
            pk = serialization.load_pem_private_key(
                sender_private_key_pem.encode("utf-8") if isinstance(sender_private_key_pem, str)
                else sender_private_key_pem,
                password=None,
            )
            sign_payload = ciphertext + tag + _aad_bytes_group(aad)
            sig = pk.sign(sign_payload, ec.ECDSA(hashes.SHA256()))
            envelope["sender_signature"] = base64.b64encode(sig).decode("ascii")
            # 公钥指纹便于接收方查找证书
            pub_der = pk.public_key().public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
            fp = hashes.Hash(hashes.SHA256())
            fp.update(pub_der)
            envelope["sender_cert_fingerprint"] = f"sha256:{fp.finalize().hex()}"
        except Exception as exc:
            _e2ee_log.warning("群消息发送方签名失败: %s", exc)

    return envelope


def decrypt_group_message(
    message: dict[str, Any],
    group_secrets: dict[int, bytes],
    sender_cert_pem: bytes | None = None,
    *,
    require_signature: bool = True,
) -> dict[str, Any] | None:
    """解密群组消息。

    group_secrets: {epoch: group_secret_bytes} 映射。
    sender_cert_pem: 发送方证书，用于验证签名。
    require_signature: 为 True 时（默认），若消息含签名但无证书可验证，或缺少签名，
        则拒绝消息（零信任模式）。设为 False 可退回旧的兼容行为（不推荐）。
    返回解密后的 message，或 None 表示失败。
    """
    payload = message.get("payload")
    if not isinstance(payload, dict):
        return None
    if payload.get("type") != "e2ee.group_encrypted":
        return None

    epoch = payload.get("epoch")
    if epoch is None:
        return None

    group_secret = group_secrets.get(epoch)
    if group_secret is None:
        return None

    try:
        # 优先从 AAD 读取 group_id 和 message_id（SDK 加密时的原始值）
        # 外层的 message_id 可能是 Group Service 重新生成的
        aad = payload.get("aad")
        outer_group_id = message.get("group_id", "")

        if isinstance(aad, dict):
            group_id = aad.get("group_id", outer_group_id)
            message_id = aad.get("message_id", message.get("message_id", ""))
            aad_from = aad.get("from", "")

            # 外层路由字段与 AAD 绑定校验：
            # group_id 必须一致（防止跨群路由篡改）
            if outer_group_id and group_id != outer_group_id:
                return None
            # from 和 sender_aid 都必须与 AAD 中的 from 一致（防止发送者冒充）
            if aad_from:
                outer_from = message.get("from", "")
                outer_sender = message.get("sender_aid", "")
                if outer_from and outer_from != aad_from:
                    return None
                if outer_sender and outer_sender != aad_from:
                    return None
        else:
            group_id = outer_group_id
            message_id = message.get("message_id", "")

        if not group_id or not message_id:
            return None

        msg_key = _derive_group_msg_key(group_secret, group_id, message_id)
        nonce = base64.b64decode(payload["nonce"])
        ciphertext = base64.b64decode(payload["ciphertext"])
        tag = base64.b64decode(payload["tag"])

        # AAD 校验：直接用 payload 中的 AAD（因为加密时写入的就是这些值）
        if isinstance(aad, dict):
            aad_bytes = _aad_bytes_group(aad)
        else:
            aad_bytes = b""

        aesgcm = AESGCM(msg_key)
        plaintext = aesgcm.decrypt(nonce, ciphertext + tag, aad_bytes)
        decoded = json.loads(plaintext.decode("utf-8"))

        result = dict(message)
        result["payload"] = decoded
        result["encrypted"] = True
        result["e2ee"] = {
            "encryption_mode": MODE_EPOCH_GROUP_KEY,
            "suite": SUITE,
            "epoch": epoch,
            "sender_verified": False,
        }

        # 发送方签名验证（零信任：默认强制要求签名 + 证书）
        sender_sig_b64 = payload.get("sender_signature")
        if require_signature:
            # 零信任模式：必须有签名且有证书可验证
            if not sender_sig_b64:
                _e2ee_log.warning("拒绝无发送方签名的群消息（require_signature=True）: group=%s from=%s", group_id, aad_from)
                return None
            if not sender_cert_pem:
                _e2ee_log.warning(
                    "拒绝群消息：有签名但无发送方证书可验证（零信任模式禁止跳过验签）: group=%s from=%s",
                    group_id, aad_from,
                )
                return None
            try:
                sender_cert = x509.load_pem_x509_certificate(
                    sender_cert_pem if isinstance(sender_cert_pem, bytes)
                    else sender_cert_pem.encode("utf-8")
                )
                sender_pub = sender_cert.public_key()
                sig_bytes = base64.b64decode(sender_sig_b64)
                verify_payload = ciphertext + tag + aad_bytes
                sender_pub.verify(sig_bytes, verify_payload, ec.ECDSA(hashes.SHA256()))
                result["e2ee"]["sender_verified"] = True
            except Exception:
                _e2ee_log.warning("群消息发送方签名验证失败: group=%s from=%s", group_id, aad_from)
                return None
        elif sender_cert_pem:
            # 非零信任模式但提供了证书：有证书时强制验签
            if not sender_sig_b64:
                _e2ee_log.warning("拒绝无发送方签名的群消息: group=%s from=%s", group_id, aad_from)
                return None
            try:
                sender_cert = x509.load_pem_x509_certificate(
                    sender_cert_pem if isinstance(sender_cert_pem, bytes)
                    else sender_cert_pem.encode("utf-8")
                )
                sender_pub = sender_cert.public_key()
                sig_bytes = base64.b64decode(sender_sig_b64)
                verify_payload = ciphertext + tag + aad_bytes
                sender_pub.verify(sig_bytes, verify_payload, ec.ECDSA(hashes.SHA256()))
                result["e2ee"]["sender_verified"] = True
            except Exception:
                _e2ee_log.warning("群消息发送方签名验证失败: group=%s from=%s", group_id, aad_from)
                return None

        return result
    except Exception:
        return None


# ── Membership Manifest（成员变更授权证明）──────────────


def build_membership_manifest(
    group_id: str,
    epoch: int,
    prev_epoch: int | None,
    member_aids: list[str],
    added: list[str] | None = None,
    removed: list[str] | None = None,
    initiator_aid: str = "",
) -> dict[str, Any]:
    """构建 Membership Manifest（未签名）。"""
    return {
        "manifest_version": 1,
        "group_id": group_id,
        "epoch": epoch,
        "prev_epoch": prev_epoch,
        "member_aids": sorted(member_aids),
        "added": sorted(added or []),
        "removed": sorted(removed or []),
        "initiator_aid": initiator_aid,
        "issued_at": int(_time_mod.time() * 1000),
    }


def _manifest_sign_data(manifest: dict[str, Any]) -> bytes:
    """序列化 manifest 为签名输入。"""
    # 固定字段顺序，确保签名确定性
    fields = [
        str(manifest.get("manifest_version", 1)),
        manifest.get("group_id", ""),
        str(manifest.get("epoch", 0)),
        str(manifest.get("prev_epoch", "")),
        "|".join(manifest.get("member_aids", [])),
        "|".join(manifest.get("added", [])),
        "|".join(manifest.get("removed", [])),
        manifest.get("initiator_aid", ""),
        str(manifest.get("issued_at", 0)),
    ]
    return "\n".join(fields).encode("utf-8")


def sign_membership_manifest(
    manifest: dict[str, Any],
    private_key_pem: str,
) -> dict[str, Any]:
    """对 Membership Manifest 签名，返回带 signature 字段的新 manifest。"""
    pk = serialization.load_pem_private_key(
        private_key_pem.encode("utf-8") if isinstance(private_key_pem, str) else private_key_pem,
        password=None,
    )
    sign_data = _manifest_sign_data(manifest)
    sig = pk.sign(sign_data, ec.ECDSA(hashes.SHA256()))
    signed = dict(manifest)
    signed["signature"] = base64.b64encode(sig).decode("ascii")
    return signed


def verify_membership_manifest(
    manifest: dict[str, Any],
    initiator_cert_pem: bytes,
) -> bool:
    """验证 Membership Manifest 签名。"""
    sig_b64 = manifest.get("signature")
    if not sig_b64:
        return False
    try:
        cert = x509.load_pem_x509_certificate(
            initiator_cert_pem if isinstance(initiator_cert_pem, bytes)
            else initiator_cert_pem.encode("utf-8")
        )
        pub_key = cert.public_key()
        sig_bytes = base64.b64decode(sig_b64)
        sign_data = _manifest_sign_data(manifest)
        pub_key.verify(sig_bytes, sign_data, ec.ECDSA(hashes.SHA256()))
        return True
    except Exception:
        return False


def compute_membership_commitment(
    member_aids: list[str], epoch: int, group_id: str,
    group_secret: bytes,
) -> str:
    """计算 Membership Commitment。

    commitment = SHA-256(sort(aids).join("|") + "|" + str(epoch) + "|" + group_id + "|" + SHA256(group_secret).hex())
    强制绑定 group_secret，防止恶意服务端替换密钥但保持 commitment 不变。
    """
    sorted_aids = sorted(member_aids)
    secret_hash = hashes.Hash(hashes.SHA256())
    secret_hash.update(group_secret)
    data = "|".join(sorted_aids) + "|" + str(epoch) + "|" + group_id + "|" + secret_hash.finalize().hex()
    digest = hashes.Hash(hashes.SHA256())
    digest.update(data.encode("utf-8"))
    return digest.finalize().hex()


def verify_membership_commitment(
    commitment: str,
    member_aids: list[str],
    epoch: int,
    group_id: str,
    my_aid: str,
    group_secret: bytes,
) -> bool:
    """验证 Membership Commitment。

    1. 重算 commitment 是否匹配
    2. 检查 my_aid 是否在 member_aids 中
    """
    if my_aid not in member_aids:
        return False
    expected = compute_membership_commitment(member_aids, epoch, group_id, group_secret)
    return _hmac.compare_digest(expected.encode("utf-8"), commitment.encode("utf-8"))


# ── Group Secret 生命周期管理 ──────────────────────────────

# 旧 epoch 默认保留 7 天
OLD_EPOCH_RETENTION_SECONDS = 7 * 24 * 3600


def store_group_secret(
    keystore: Any,
    aid: str,
    group_id: str,
    epoch: int,
    group_secret: bytes,
    commitment: str,
    member_aids: list[str],
) -> bool:
    """存储 group_secret 到 keystore metadata。

    如果已有旧 epoch，将旧的移入 old_epochs 列表。
    拒绝低于本地最新 epoch 的写入（防止降级攻击）。
    返回 True 表示已存储，False 表示被拒绝（epoch 降级）。
    """
    metadata = keystore.load_metadata(aid) or {}
    group_secrets = metadata.setdefault("group_secrets", {})
    existing = group_secrets.get(group_id)

    # epoch 降级防护：拒绝低于本地最新 epoch 的写入
    if existing and existing.get("epoch") is not None:
        local_epoch = existing["epoch"]
        if epoch < local_epoch:
            return False

    # 旧 epoch 移入 old_epochs
    if existing and existing.get("epoch") != epoch:
        old_epochs = existing.get("old_epochs", [])
        old_entry = {
            "epoch": existing.get("epoch"),
            "secret": existing.get("secret"),
            "commitment": existing.get("commitment"),
            "member_aids": existing.get("member_aids"),
            "updated_at": existing.get("updated_at"),
        }
        # 保留 secret_protection（如果存在，来自 restore）
        if "secret_protection" in existing:
            old_entry["secret_protection"] = existing["secret_protection"]
        old_epochs.append(old_entry)
        existing["old_epochs"] = old_epochs

    now_ms = int(_time_mod.time() * 1000)
    group_secrets[group_id] = {
        "epoch": epoch,
        "secret": base64.b64encode(group_secret).decode("ascii"),
        "commitment": commitment,
        "member_aids": sorted(member_aids),
        "updated_at": now_ms,
        "old_epochs": (existing or {}).get("old_epochs", []),
    }
    metadata["group_secrets"] = group_secrets
    keystore.save_metadata(aid, metadata)
    return True

def load_group_secret(
    keystore: Any,
    aid: str,
    group_id: str,
    epoch: int | None = None,
) -> dict[str, Any] | None:
    """读取 group_secret。

    epoch=None 时返回最新 epoch。
    指定 epoch 时先查当前，再查 old_epochs。
    返回的 dict 包含 epoch, secret(bytes), commitment, member_aids。
    """
    metadata = keystore.load_metadata(aid) or {}
    group_secrets = metadata.get("group_secrets", {})
    entry = group_secrets.get(group_id)
    if entry is None:
        return None

    if epoch is None or entry.get("epoch") == epoch:
        secret_str = entry.get("secret")
        if not secret_str:
            return None
        return {
            "epoch": entry["epoch"],
            "secret": base64.b64decode(secret_str),
            "commitment": entry.get("commitment"),
            "member_aids": entry.get("member_aids", []),
        }

    # 查 old_epochs
    for old in entry.get("old_epochs", []):
        if old.get("epoch") == epoch:
            secret_str = old.get("secret")
            if not secret_str:
                return None
            return {
                "epoch": old["epoch"],
                "secret": base64.b64decode(secret_str),
                "commitment": old.get("commitment"),
                "member_aids": old.get("member_aids", []),
            }

    return None


def load_all_group_secrets(
    keystore: Any,
    aid: str,
    group_id: str,
) -> dict[int, bytes]:
    """加载某群组所有 epoch 的 group_secret。

    返回 {epoch: secret_bytes} 映射，可直接传入 decrypt_group_message。
    """
    metadata = keystore.load_metadata(aid) or {}
    group_secrets = metadata.get("group_secrets", {})
    entry = group_secrets.get(group_id)
    if entry is None:
        return {}

    result: dict[int, bytes] = {}
    secret_str = entry.get("secret")
    if secret_str and entry.get("epoch") is not None:
        result[entry["epoch"]] = base64.b64decode(secret_str)

    for old in entry.get("old_epochs", []):
        old_secret = old.get("secret")
        if old_secret and old.get("epoch") is not None:
            result[old["epoch"]] = base64.b64decode(old_secret)

    return result


def cleanup_old_epochs(
    keystore: Any,
    aid: str,
    group_id: str,
    retention_seconds: int = OLD_EPOCH_RETENTION_SECONDS,
) -> int:
    """清理过期的旧 epoch 记录。返回清理数量。"""
    metadata = keystore.load_metadata(aid) or {}
    group_secrets = metadata.get("group_secrets", {})
    entry = group_secrets.get(group_id)
    if entry is None:
        return 0

    old_epochs = entry.get("old_epochs", [])
    if not old_epochs:
        return 0

    cutoff_ms = int(_time_mod.time() * 1000) - retention_seconds * 1000
    remaining = [e for e in old_epochs if e.get("updated_at", 0) >= cutoff_ms]
    removed = len(old_epochs) - len(remaining)

    if removed > 0:
        entry["old_epochs"] = remaining
        keystore.save_metadata(aid, metadata)

    return removed


class GroupReplayGuard:
    """群组消息防重放守卫。

    key = "{group_id}:{sender_aid}:{message_id}"
    内置 LRU 裁剪。
    """

    def __init__(self, max_size: int = 50000) -> None:
        self._seen: dict[str, bool] = {}
        self._max_size = max_size

    def check_and_record(self, group_id: str, sender_aid: str, message_id: str) -> bool:
        """检查并记录。返回 True 表示首次（通过），False 表示重放（拒绝）。"""
        key = f"{group_id}:{sender_aid}:{message_id}"
        if key in self._seen:
            return False
        self._seen[key] = True
        self._trim()
        return True

    def is_seen(self, group_id: str, sender_aid: str, message_id: str) -> bool:
        """仅检查是否已记录，不修改状态。"""
        key = f"{group_id}:{sender_aid}:{message_id}"
        return key in self._seen

    def record(self, group_id: str, sender_aid: str, message_id: str) -> None:
        """仅记录，不检查。"""
        key = f"{group_id}:{sender_aid}:{message_id}"
        self._seen[key] = True
        self._trim()

    def _trim(self) -> None:
        if len(self._seen) > self._max_size:
            trim_count = len(self._seen) - int(self._max_size * 0.8)
            keys = list(self._seen.keys())[:trim_count]
            for k in keys:
                del self._seen[k]

    @property
    def size(self) -> int:
        return len(self._seen)


class GroupKeyRequestThrottle:
    """群组密钥请求/响应频率限制。

    同一 key 在 cooldown 秒内不允许重复操作。
    """

    def __init__(self, cooldown: float = 30.0) -> None:
        self._last: dict[str, float] = {}
        self._cooldown = cooldown

    def allow(self, key: str) -> bool:
        """检查是否允许操作。返回 True 并记录时间戳，或 False 表示被限制。"""
        now = _time_mod.time()
        last = self._last.get(key)
        if last is not None and (now - last) < self._cooldown:
            return False
        self._last[key] = now
        return True

    def reset(self, key: str) -> None:
        self._last.pop(key, None)


def check_epoch_downgrade(
    message_epoch: int,
    local_latest_epoch: int,
    *,
    allow_old_epoch: bool = False,
) -> bool:
    """检查 epoch 降级。

    返回 True 表示允许处理，False 表示拒绝。
    allow_old_epoch=True 时允许解密旧 epoch 消息（但 caller 应标记为历史消息）。
    """
    if message_epoch >= local_latest_epoch:
        return True
    return allow_old_epoch


# ── Group Key 分发与恢复协议 ──────────────────────────────

def generate_group_secret() -> bytes:
    """生成 32 字节随机 group_secret。"""
    return secrets.token_bytes(32)


def build_key_distribution(
    group_id: str,
    epoch: int,
    group_secret: bytes,
    member_aids: list[str],
    distributed_by: str,
    manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构建 group key 分发消息 payload。

    此 payload 应通过 P2P E2EE 通道逐个发送给每个群成员。
    manifest: 可选的已签名 Membership Manifest，附加后接收方可验证成员变更授权。
    """
    commitment = compute_membership_commitment(member_aids, epoch, group_id, group_secret)
    result = {
        "type": "e2ee.group_key_distribution",
        "group_id": group_id,
        "epoch": epoch,
        "group_secret": base64.b64encode(group_secret).decode("ascii"),
        "commitment": commitment,
        "member_aids": sorted(member_aids),
        "distributed_by": distributed_by,
        "distributed_at": int(_time_mod.time() * 1000),
    }
    if manifest:
        result["manifest"] = manifest
    return result


def handle_key_distribution(
    message: dict[str, Any],
    keystore: Any,
    aid: str,
    initiator_cert_pem: bytes | None = None,
) -> bool:
    """处理收到的 group key 分发消息。

    验证 manifest 签名 → 验证 commitment → 验证自己在 member_aids 中 → 存储 group_secret。
    initiator_cert_pem: 传入时强制要求 manifest 存在且签名有效。
    返回 True 表示成功处理，False 表示验证失败。
    """
    payload = message if "group_id" in message else message.get("payload", message)

    group_id = payload.get("group_id")
    epoch = payload.get("epoch")
    group_secret_b64 = payload.get("group_secret")
    commitment = payload.get("commitment")
    member_aids = payload.get("member_aids", [])

    if not all([group_id, epoch is not None, group_secret_b64, commitment]):
        return False

    # 验证 Membership Manifest 签名
    manifest = payload.get("manifest")
    if initiator_cert_pem:
        # 有验证能力时强制要求 manifest
        if not manifest:
            _e2ee_log.warning("拒绝无 manifest 的密钥分发: group=%s epoch=%s", group_id, epoch)
            return False
        if not verify_membership_manifest(manifest, initiator_cert_pem):
            _e2ee_log.warning("group key distribution manifest 签名验证失败: group=%s epoch=%s", group_id, epoch)
            return False
        # 验证 manifest 与分发消息一致
        if manifest.get("group_id") != group_id or manifest.get("epoch") != epoch:
            return False
        if sorted(manifest.get("member_aids", [])) != sorted(member_aids):
            return False
    elif manifest:
        # 无验证能力但有 manifest → 只做字段一致性检查
        if manifest.get("group_id") != group_id or manifest.get("epoch") != epoch:
            return False
        if sorted(manifest.get("member_aids", [])) != sorted(member_aids):
            return False

    group_secret = base64.b64decode(group_secret_b64)

    # 验证 commitment（强制绑定 group_secret）
    if not verify_membership_commitment(commitment, member_aids, epoch, group_id, aid, group_secret):
        return False

    return store_group_secret(keystore, aid, group_id, epoch, group_secret, commitment, member_aids)


def build_key_request(
    group_id: str,
    epoch: int,
    requester_aid: str,
) -> dict[str, Any]:
    """构建密钥请求 payload。通过 P2P E2EE 通道发送。"""
    return {
        "type": "e2ee.group_key_request",
        "group_id": group_id,
        "epoch": epoch,
        "requester_aid": requester_aid,
    }


def handle_key_request(
    request: dict[str, Any],
    keystore: Any,
    aid: str,
    current_members: list[str],
) -> dict[str, Any] | None:
    """处理收到的密钥请求。

    验证请求者是群成员 → 查本地密钥 → 构建响应。
    返回响应 payload（通过 P2P E2EE 回复），或 None 表示拒绝。
    """
    payload = request if "group_id" in request else request.get("payload", request)

    requester_aid = payload.get("requester_aid")
    group_id = payload.get("group_id")
    epoch = payload.get("epoch")

    if not all([requester_aid, group_id, epoch is not None]):
        return None

    # 验证请求者是群成员
    if requester_aid not in current_members:
        return None

    # 查本地密钥
    secret_data = load_group_secret(keystore, aid, group_id, epoch)
    if secret_data is None:
        return None

    commitment = secret_data.get("commitment", "")
    member_aids = secret_data.get("member_aids", [])
    if not commitment:
        commitment = compute_membership_commitment(member_aids or current_members, epoch, group_id, secret_data["secret"])

    return {
        "type": "e2ee.group_key_response",
        "group_id": group_id,
        "epoch": epoch,
        "group_secret": base64.b64encode(secret_data["secret"]).decode("ascii"),
        "commitment": commitment,
        "member_aids": member_aids or sorted(current_members),
    }


def handle_key_response(
    response: dict[str, Any],
    keystore: Any,
    aid: str,
) -> bool:
    """处理收到的密钥响应。

    验证 commitment → 存储。返回 True 表示成功。
    """
    payload = response if "group_id" in response else response.get("payload", response)

    group_id = payload.get("group_id")
    epoch = payload.get("epoch")
    group_secret_b64 = payload.get("group_secret")
    commitment = payload.get("commitment")
    member_aids = payload.get("member_aids", [])

    if not all([group_id, epoch is not None, group_secret_b64, commitment]):
        return False

    group_secret = base64.b64decode(group_secret_b64)

    if not verify_membership_commitment(commitment, member_aids, epoch, group_id, aid, group_secret):
        return False

    return store_group_secret(keystore, aid, group_id, epoch, group_secret, commitment, member_aids)


# ── GroupE2EEManager ─────────────────────────────────────────


class GroupE2EEManager:
    """群组端到端加密工具类 — 纯密码学 + 本地状态，零 I/O 依赖。

    与 E2EEManager 平行：所有网络操作（P2P 发送、RPC 调用）由调用方负责。
    内置防重放、epoch 降级防护、密钥请求频率限制。

    裸 WebSocket 开发者用法::

        group_e2ee = GroupE2EEManager(
            identity_fn=lambda: my_identity,
            keystore=FileKeyStore(),
        )
        info = group_e2ee.create_epoch("grp_abc", ["alice.aid", "bob.aid"])
        for dist in info["distributions"]:
            p2p_send(dist["to"], dist["payload"])
        envelope = group_e2ee.encrypt("grp_abc", {"text": "hello"})
        decrypted = group_e2ee.decrypt(raw_group_message)
        group_e2ee.handle_incoming(decrypted_p2p_payload)
    """

    def __init__(
        self, *, identity_fn: Any, keystore: Any,
        request_cooldown: float = 30.0, response_cooldown: float = 30.0,
        sender_cert_resolver: Any = None,
        initiator_cert_resolver: Any = None,
    ) -> None:
        self._identity_fn = identity_fn
        self._keystore_ref = keystore
        self._replay_guard = GroupReplayGuard()
        self._request_throttle = GroupKeyRequestThrottle(cooldown=request_cooldown)
        self._response_throttle = GroupKeyRequestThrottle(cooldown=response_cooldown)
        self._sender_cert_resolver = sender_cert_resolver
        self._initiator_cert_resolver = initiator_cert_resolver

    # ── 密钥管理 ──────────────────────────────────────────

    def _sign_manifest(self, manifest: dict[str, Any]) -> dict[str, Any]:
        """用当前身份私钥签名 manifest，无私钥时返回原始 manifest。"""
        identity = self._identity_fn()
        pk_pem = identity.get("private_key_pem")
        if not pk_pem:
            return manifest
        return sign_membership_manifest(manifest, pk_pem)

    def create_epoch(self, group_id: str, member_aids: list[str]) -> dict[str, Any]:
        """创建首个 epoch。返回 {epoch, commitment, distributions: [{to, payload}]}。"""
        aid = self._current_aid()
        gs = generate_group_secret()
        epoch = 1
        commitment = compute_membership_commitment(member_aids, epoch, group_id, gs)
        store_group_secret(self._keystore(), aid, group_id, epoch, gs, commitment, member_aids)
        manifest = self._sign_manifest(build_membership_manifest(
            group_id, epoch, None, member_aids, initiator_aid=aid,
        ))
        dist_payload = build_key_distribution(group_id, epoch, gs, member_aids, aid, manifest=manifest)
        return {
            "epoch": epoch, "commitment": commitment,
            "distributions": [{"to": m, "payload": dist_payload} for m in member_aids if m != aid],
        }

    def rotate_epoch(self, group_id: str, member_aids: list[str]) -> dict[str, Any]:
        """轮换 epoch（踢人/退出后调用）。返回格式与 create_epoch 相同。"""
        aid = self._current_aid()
        ks = self._keystore()
        current = load_group_secret(ks, aid, group_id)
        prev_epoch = current["epoch"] if current else None
        new_epoch = (prev_epoch or 0) + 1
        gs = generate_group_secret()
        commitment = compute_membership_commitment(member_aids, new_epoch, group_id, gs)
        store_group_secret(ks, aid, group_id, new_epoch, gs, commitment, member_aids)
        manifest = self._sign_manifest(build_membership_manifest(
            group_id, new_epoch, prev_epoch, member_aids, initiator_aid=aid,
        ))
        dist_payload = build_key_distribution(group_id, new_epoch, gs, member_aids, aid, manifest=manifest)
        return {
            "epoch": new_epoch, "commitment": commitment,
            "distributions": [{"to": m, "payload": dist_payload} for m in member_aids if m != aid],
        }

    def rotate_epoch_to(
        self, group_id: str, target_epoch: int, member_aids: list[str],
    ) -> dict[str, Any]:
        """指定目标 epoch 号轮换（配合服务端 CAS 使用）。"""
        aid = self._current_aid()
        gs = generate_group_secret()
        commitment = compute_membership_commitment(member_aids, target_epoch, group_id, gs)
        store_group_secret(self._keystore(), aid, group_id, target_epoch, gs, commitment, member_aids)
        manifest = self._sign_manifest(build_membership_manifest(
            group_id, target_epoch, target_epoch - 1, member_aids, initiator_aid=aid,
        ))
        dist_payload = build_key_distribution(group_id, target_epoch, gs, member_aids, aid, manifest=manifest)
        return {
            "epoch": target_epoch, "commitment": commitment,
            "distributions": [{"to": m, "payload": dist_payload} for m in member_aids if m != aid],
        }

    def store_secret(
        self, group_id: str, epoch: int, group_secret_bytes: bytes,
        commitment: str, member_aids: list[str],
    ) -> bool:
        """手动存储 group_secret。返回 False 表示 epoch 降级被拒。"""
        return store_group_secret(
            self._keystore(), self._current_aid(), group_id, epoch,
            group_secret_bytes, commitment, member_aids,
        )

    def load_secret(self, group_id: str, epoch: int | None = None) -> dict[str, Any] | None:
        return load_group_secret(self._keystore(), self._current_aid(), group_id, epoch)

    def load_all_secrets(self, group_id: str) -> dict[int, bytes]:
        return load_all_group_secrets(self._keystore(), self._current_aid(), group_id)

    def cleanup(self, group_id: str, retention_seconds: int = OLD_EPOCH_RETENTION_SECONDS) -> int:
        return cleanup_old_epochs(self._keystore(), self._current_aid(), group_id, retention_seconds)

    # ── 加解密 ────────────────────────────────────────────

    def encrypt(
        self, group_id: str, payload: dict[str, Any], *,
        message_id: str | None = None, timestamp: int | None = None,
    ) -> dict[str, Any]:
        """加密群消息（含发送方签名）。无密钥时抛 E2EEGroupSecretMissingError。"""
        aid = self._current_aid()
        secret_data = load_group_secret(self._keystore(), aid, group_id)
        if secret_data is None:
            raise E2EEGroupSecretMissingError(f"no group secret for {group_id}")
        # 获取发送方私钥用于签名
        identity = self._identity_fn()
        sender_pk_pem = identity.get("private_key_pem") if identity else None
        return encrypt_group_message(
            group_id=group_id, epoch=secret_data["epoch"], group_secret=secret_data["secret"],
            payload=payload, from_aid=aid,
            message_id=message_id or f"gm-{uuid.uuid4()}",
            timestamp=timestamp or int(_time_mod.time() * 1000),
            sender_private_key_pem=sender_pk_pem,
        )

    def decrypt(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """解密单条群消息。内置防重放 + 发送方验签 + 外层字段校验。非加密消息原样返回。"""
        payload = message.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "e2ee.group_encrypted":
            return message
        group_id = message.get("group_id", "")
        sender = message.get("from", message.get("sender_aid", ""))

        # 防重放预检：优先使用 AAD 内 message_id（在 AEAD 保护范围内，不可被服务端篡改）
        aad = payload.get("aad")
        aad_msg_id = aad.get("message_id", "") if isinstance(aad, dict) else ""
        msg_id = aad_msg_id or message.get("message_id", "")
        if group_id and sender and msg_id:
            if self._replay_guard.is_seen(group_id, sender, msg_id):
                return message

        # 解析发送方证书（用于签名验证）— 零信任：无证书则拒绝
        sender_cert_pem = None
        if self._sender_cert_resolver and sender:
            raw = self._sender_cert_resolver(sender)
            if raw:
                sender_cert_pem = raw.encode("utf-8") if isinstance(raw, str) else raw
        if sender_cert_pem is None:
            _e2ee_log.warning(
                "拒绝群消息：无法获取发送方 %s 的证书（零信任模式禁止跳过验签）: group=%s",
                sender, group_id,
            )
            return None

        all_secrets = load_all_group_secrets(self._keystore(), self._current_aid(), group_id)
        if not all_secrets:
            return None
        result = decrypt_group_message(message, all_secrets, sender_cert_pem=sender_cert_pem)

        # 解密成功后，使用 AAD 内 message_id 记录防重放
        if result is not None:
            # 从解密结果确认 AAD message_id
            final_msg_id = aad_msg_id or message.get("message_id", "")
            if group_id and sender and final_msg_id:
                self._replay_guard.record(group_id, sender, final_msg_id)
        return result

    def decrypt_batch(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [self.decrypt(m) or m for m in messages]

    # ── 密钥协议消息处理 ──────────────────────────────────

    def handle_incoming(self, payload: dict[str, Any]) -> str | None:
        """处理已解密的 P2P 密钥消息。

        返回 "distribution"/"request"/"response" 表示已成功处理。
        返回 "distribution_rejected"/"response_rejected" 表示被拒绝（如 epoch 降级、manifest 验证失败）。
        返回 None 表示不是密钥消息。
        """
        if not isinstance(payload, dict):
            return None
        msg_type = payload.get("type", "")
        aid = self._current_aid()
        if msg_type == "e2ee.group_key_distribution":
            # 解析发起者证书用于 manifest 验证
            initiator_cert = None
            distributed_by = payload.get("distributed_by", "")
            if self._initiator_cert_resolver and distributed_by:
                raw = self._initiator_cert_resolver(distributed_by)
                if raw:
                    initiator_cert = raw.encode("utf-8") if isinstance(raw, str) else raw
            ok = handle_key_distribution(payload, self._keystore(), aid, initiator_cert_pem=initiator_cert)
            return "distribution" if ok else "distribution_rejected"
        if msg_type == "e2ee.group_key_response":
            ok = handle_key_response(payload, self._keystore(), aid)
            return "response" if ok else "response_rejected"
        if msg_type == "e2ee.group_key_request":
            return "request"
        return None

    def build_recovery_request(
        self, group_id: str, epoch: int, *, sender_aid: str | None = None,
    ) -> dict[str, Any] | None:
        """构建恢复请求。返回 {to, payload} 或 None（限流/无目标）。"""
        aid = self._current_aid()
        if not self._request_throttle.allow(f"request:{group_id}:{epoch}"):
            return None
        candidates: list[str] = []
        secret_data = load_group_secret(self._keystore(), aid, group_id)
        if secret_data and secret_data.get("member_aids"):
            candidates = [m for m in secret_data["member_aids"] if m != aid]
        if not candidates and sender_aid and sender_aid != aid:
            candidates = [sender_aid]
        if not candidates:
            return None
        return {"to": candidates[0], "payload": build_key_request(group_id, epoch, aid)}

    def handle_key_request_msg(
        self, request_payload: dict[str, Any], current_members: list[str],
    ) -> dict[str, Any] | None:
        """处理密钥请求。返回响应 payload（受频率限制 + 成员资格验证）。"""
        requester = request_payload.get("requester_aid", "")
        group_id = request_payload.get("group_id", "")
        if not requester or not group_id:
            return None
        # 成员资格验证：仅响应当前群成员的请求
        if requester not in current_members:
            _e2ee_log.warning(
                "拒绝密钥恢复请求：%s 不在群 %s 的当前成员列表中", requester, group_id,
            )
            return None
        if not self._response_throttle.allow(f"response:{group_id}:{requester}"):
            return None
        return handle_key_request(
            request_payload, self._keystore(), self._current_aid(), current_members,
        )

    # ── 状态查询 ──────────────────────────────────────────

    def has_secret(self, group_id: str) -> bool:
        return load_group_secret(self._keystore(), self._current_aid(), group_id) is not None

    def current_epoch(self, group_id: str) -> int | None:
        s = load_group_secret(self._keystore(), self._current_aid(), group_id)
        return s["epoch"] if s else None

    def get_member_aids(self, group_id: str) -> list[str]:
        s = load_group_secret(self._keystore(), self._current_aid(), group_id)
        return s.get("member_aids", []) if s else []

    def _current_aid(self) -> str:
        identity = self._identity_fn()
        aid = identity.get("aid")
        if not aid:
            raise E2EEError("AID unavailable")
        return str(aid)

    def _keystore(self) -> Any:
        return self._keystore_ref
