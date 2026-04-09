from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import logging

import aiohttp
import websockets
from cryptography import x509
from cryptography.x509 import ocsp
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

from .crypto import CryptoProvider
from .errors import AuthError, StateError, ValidationError, map_remote_error, AUNError
from .keystore.file import FileKeyStore


_auth_log = logging.getLogger("aun_core.auth")


def _verify_signature(public_key: Any, sig_bytes: bytes, data_bytes: bytes) -> None:
    if isinstance(public_key, ed25519.Ed25519PublicKey):
        public_key.verify(sig_bytes, data_bytes)
        return
    if isinstance(public_key, ec.EllipticCurvePublicKey):
        if isinstance(public_key.curve, ec.SECP384R1):
            public_key.verify(sig_bytes, data_bytes, ec.ECDSA(hashes.SHA384()))
        else:
            public_key.verify(sig_bytes, data_bytes, ec.ECDSA(hashes.SHA256()))
        return
    raise AuthError(f"unsupported identity public key type: {type(public_key)!r}")


class AuthFlow:
    def __init__(
        self,
        *,
        keystore: FileKeyStore,
        crypto: CryptoProvider,
        aid: str | None = None,
        connection_factory=None,
        root_ca_path: str | None = None,
        chain_cache_ttl: int = 86400,
        verify_ssl: bool = False,
    ) -> None:
        self._keystore = keystore
        self._crypto = crypto
        self._aid = aid
        self._connection_factory = connection_factory or self._default_connection_factory
        self._root_ca_path = root_ca_path
        self._verify_ssl = verify_ssl
        self._root_certs = self._load_root_certs(root_ca_path)
        self._gateway_chain_cache: dict[str, list[str]] = {}
        self._gateway_crl_cache: dict[str, dict[str, Any]] = {}
        self._gateway_ocsp_cache: dict[str, dict[str, dict[str, Any]]] = {}
        # 证书链验证结果缓存：cert_serial -> verified_at
        self._chain_verified_cache: dict[str, float] = {}
        self._chain_cache_ttl = chain_cache_ttl
        # Gateway CA 链预验证标记：gateway_url -> verified
        self._gateway_ca_verified: dict[str, bool] = {}

    def load_identity(self, aid: str | None = None) -> dict[str, Any]:
        identity = self._load_identity_or_raise(aid)
        cert = self._keystore.load_cert(identity["aid"])
        if cert:
            identity["cert"] = cert
        metadata = self._keystore.load_metadata(identity["aid"]) or {}
        identity.update(metadata)
        return identity

    def load_identity_or_none(self, aid: str | None = None) -> dict[str, Any] | None:
        try:
            return self.load_identity(aid)
        except StateError:
            return None

    def get_access_token_expiry(self, identity: dict[str, Any]) -> float | None:
        expires_at = identity.get("access_token_expires_at")
        if isinstance(expires_at, (int, float)):
            return float(expires_at)
        return None

    async def create_aid(self, gateway_url: str, aid: str) -> dict[str, Any]:
        identity = self._ensure_local_identity(aid)
        if identity.get("cert"):
            return {"aid": identity["aid"], "cert": identity["cert"]}

        # 本地有密钥但无证书 — 可能是上次 create_aid 网络失败后的残留状态，
        # 也可能是服务端已注册但本地证书丢失。两种情况都先尝试注册。
        try:
            created = await self._create_aid(gateway_url, identity)
            identity.update(created)
        except AUNError as e:
            if "already exists" not in str(e):
                raise
            # AID 已在服务端注册，本地有密钥但证书丢失。
            # 通过 HTTP PKI 端点下载已注册的证书，验证公钥匹配后恢复。
            try:
                identity = await self._recover_cert_via_download(gateway_url, identity)
            except Exception:
                raise StateError(
                    f"AID {aid} already registered on server but local certificate is missing. "
                    f"Certificate download recovery failed. Options: "
                    f"(1) use a different AID name, or "
                    f"(2) restart Kite server to clear registration."
                ) from e
        self._keystore.save_identity(identity["aid"], identity)
        self._aid = identity["aid"]
        return {"aid": identity["aid"], "cert": identity["cert"]}

    async def _recover_cert_via_download(self, gateway_url: str, identity: dict[str, Any]) -> dict[str, Any]:
        """本地有密钥但无证书、服务端已注册 — 通过 PKI HTTP 端点下载证书恢复。"""
        cert_url = self._gateway_http_url(gateway_url, f"/pki/cert/{identity['aid']}")
        cert_pem = await self._fetch_text(cert_url)
        if not cert_pem or "BEGIN CERTIFICATE" not in cert_pem:
            raise AuthError(f"failed to download certificate for {identity['aid']}")

        # 验证下载的证书公钥与本地密钥对匹配
        cert = x509.load_pem_x509_certificate(cert_pem.encode("utf-8"))
        cert_pub_der = cert.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        local_pub_der = base64.b64decode(identity["public_key_der_b64"])
        if cert_pub_der != local_pub_der:
            raise AuthError(
                f"downloaded certificate public key does not match local key pair for {identity['aid']}. "
                f"The server has a different key registered — this AID cannot be recovered with the current key."
            )

        identity["cert"] = cert_pem
        return identity

    async def authenticate(self, gateway_url: str, *, aid: str | None = None) -> dict[str, Any]:
        identity = self._load_identity_or_raise(aid)
        if not identity.get("cert"):
            # 本地有密钥但无证书 — 尝试从 PKI 下载恢复
            try:
                identity = await self._recover_cert_via_download(gateway_url, identity)
                self._keystore.save_identity(identity["aid"], identity)
            except Exception as e:
                raise StateError(
                    f"local certificate missing and recovery failed: {e}. "
                    f"Run auth.create_aid() to register a new identity."
                ) from e
        login = await self._login(gateway_url, identity)
        self._remember_tokens(identity, login)
        await self._validate_new_cert(identity, gateway_url)
        self._keystore.save_identity(identity["aid"], identity)
        self._aid = identity["aid"]
        return {
            "aid": identity["aid"],
            "access_token": identity.get("access_token"),
            "refresh_token": identity.get("refresh_token"),
            "expires_at": identity.get("access_token_expires_at"),
            "gateway": gateway_url,
        }

    async def ensure_authenticated(self, gateway_url: str) -> dict[str, Any]:
        identity = self._ensure_identity()
        if not identity.get("cert"):
            created = await self._create_aid(gateway_url, identity)
            identity.update(created)
            self._keystore.save_identity(identity["aid"], identity)

        login = await self._login(gateway_url, identity)
        self._remember_tokens(identity, login)
        await self._validate_new_cert(identity, gateway_url)
        self._keystore.save_identity(identity["aid"], identity)

        token = identity.get("access_token") or identity.get("token") or identity.get("kite_token")
        if not token:
            raise AuthError("login2 did not return access token")
        return {"token": token, "identity": identity}

    async def refresh_cached_tokens(self, gateway_url: str, identity: dict[str, Any]) -> dict[str, Any]:
        refresh_token = str(identity.get("refresh_token") or "")
        if not refresh_token:
            raise AuthError("missing refresh_token")
        refreshed = await self._refresh_access_token(gateway_url, refresh_token)
        self._remember_tokens(identity, refreshed)
        await self._validate_new_cert(identity, gateway_url)
        self._keystore.save_identity(identity["aid"], identity)
        return identity

    async def initialize_with_token(
        self,
        transport,
        challenge: dict[str, Any] | None,
        access_token: str,
    ) -> None:
        nonce = challenge.get("params", {}).get("nonce", "")
        if not nonce:
            raise AuthError("gateway challenge missing nonce")
        await self._initialize_session(transport, nonce, access_token)

    async def connect_session(
        self,
        transport,
        challenge: dict[str, Any] | None,
        gateway_url: str,
        *,
        access_token: str | None = None,
    ) -> dict[str, Any]:
        nonce = challenge.get("params", {}).get("nonce", "")
        if not nonce:
            raise AuthError("gateway challenge missing nonce")

        try:
            identity = self.load_identity()
        except StateError:
            identity = None

        explicit_token = str(access_token or "")
        if explicit_token and identity is not None:
            try:
                await self._initialize_session(transport, nonce, explicit_token)
                identity["access_token"] = explicit_token
                self._keystore.save_identity(identity["aid"], identity)
                return {"token": explicit_token, "identity": identity}
            except AuthError as exc:
                _auth_log.debug("explicit_token 认证失败，尝试下一方式: %s", exc)

        if identity is None:
            auth_context = await self.ensure_authenticated(gateway_url)
            token = auth_context["token"]
            await self._initialize_session(transport, nonce, token)
            return auth_context

        cached_token = self._get_cached_access_token(identity)
        if cached_token:
            try:
                await self._initialize_session(transport, nonce, cached_token)
                return {"token": cached_token, "identity": identity}
            except AuthError as exc:
                _auth_log.debug("cached_token 认证失败，尝试刷新: %s", exc)

        refresh_token = str(identity.get("refresh_token") or "")
        if refresh_token:
            try:
                identity = await self.refresh_cached_tokens(gateway_url, identity)
                cached_token = self._get_cached_access_token(identity)
                if cached_token:
                    await self._initialize_session(transport, nonce, cached_token)
                    return {"token": cached_token, "identity": identity}
            except AuthError as exc:
                _auth_log.debug("refresh_token 认证失败，将重新登录: %s", exc)

        login = await self.authenticate(gateway_url, aid=identity.get("aid"))
        token = str(login.get("access_token") or "")
        if not token:
            raise AuthError("authenticate did not return access_token")
        await self._initialize_session(transport, nonce, token)
        identity = self.load_identity(identity.get("aid"))
        return {"token": token, "identity": identity}

    async def _initialize_session(self, transport, nonce: str, token: str) -> None:
        # The SDK lifecycle concept is "initialize(token)"; the gateway currently
        # serves it through its internal auth.connect entrypoint.
        result = await transport.call("auth.connect", {
            "nonce": nonce,
            "auth": {"method": "kite_token", "token": token},
            "protocol": {"min": "1.0", "max": "1.0"},
            "capabilities": {
                "e2ee": True,
                "group_e2ee": True,
            },
        })
        status = (result or {}).get("status")
        if status != "ok":
            raise AuthError(f"initialize failed: {result}")

    async def _create_aid(self, gateway_url: str, identity: dict[str, Any]) -> dict[str, Any]:
        response = await self._short_rpc(gateway_url, "auth.create_aid", {
            "aid": identity["aid"],
            "public_key": identity["public_key_der_b64"],
            "curve": identity.get("curve", "P-256"),
        })
        return {"cert": response["cert"]}

    async def _login(self, gateway_url: str, identity: dict[str, Any]) -> dict[str, Any]:
        client_nonce = self._crypto.new_client_nonce()
        phase1 = await self._short_rpc(gateway_url, "auth.aid_login1", {
            "aid": identity["aid"],
            "cert": identity["cert"],
            "client_nonce": client_nonce,
        })
        await self._verify_phase1_response(gateway_url, phase1, client_nonce)
        signature, client_time = self._crypto.sign_login_nonce(identity["private_key_pem"], phase1["nonce"])
        phase2 = await self._short_rpc(gateway_url, "auth.aid_login2", {
            "aid": identity["aid"],
            "request_id": phase1["request_id"],
            "nonce": phase1["nonce"],
            "client_time": client_time,
            "signature": signature,
        })
        return phase2

    async def _refresh_access_token(self, gateway_url: str, refresh_token: str) -> dict[str, Any]:
        result = await self._short_rpc(gateway_url, "auth.refresh_token", {
            "refresh_token": refresh_token,
        })
        if not result.get("success"):
            raise AuthError(str(result.get("error", "refresh failed")))
        return result

    async def _short_rpc(self, gateway_url: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
        ws = await self._connection_factory(gateway_url)
        try:
            await ws.recv()
            await ws.send(json.dumps({
                "jsonrpc": "2.0",
                "id": f"pre-{method}",
                "method": method,
                "params": params,
            }))
            raw = await ws.recv()
            message = raw if isinstance(raw, dict) else json.loads(raw)
        finally:
            await ws.close()

        if "error" in message:
            raise map_remote_error(message["error"])
        result = message.get("result")
        if not isinstance(result, dict):
            raise ValidationError(f"invalid pre-auth response for {method}")
        if result.get("success") is False:
            raise AuthError(str(result.get("error", f"{method} failed")))
        return result

    async def _verify_phase1_response(self, gateway_url: str, result: dict[str, Any], client_nonce: str) -> None:
        auth_cert_pem = str(result.get("auth_cert") or "")
        signature_b64 = str(result.get("client_nonce_signature") or "")
        if not auth_cert_pem:
            raise AuthError("aid_login1 missing auth_cert")
        if not signature_b64:
            raise AuthError("aid_login1 missing client_nonce_signature")

        try:
            auth_cert = x509.load_pem_x509_certificate(auth_cert_pem.encode("utf-8"))
        except Exception as exc:
            raise AuthError("aid_login1 returned invalid auth_cert") from exc

        await self._verify_auth_cert_chain(gateway_url, auth_cert)
        await self._verify_auth_cert_revocation(gateway_url, auth_cert)
        await self._verify_auth_cert_ocsp(gateway_url, auth_cert)

        try:
            signature = base64.b64decode(signature_b64)
            _verify_signature(auth_cert.public_key(), signature, client_nonce.encode("utf-8"))
        except (ValueError, InvalidSignature, AuthError) as exc:
            raise AuthError("aid_login1 server auth signature verification failed") from exc

    async def _verify_auth_cert_chain(self, gateway_url: str, auth_cert: x509.Certificate, chain_aid: str = "") -> None:
        # 检查缓存：已验证过且未过期则跳过
        cert_serial = format(auth_cert.serial_number, "x")
        cached_at = self._chain_verified_cache.get(cert_serial)
        if cached_at and time.time() - cached_at < self._chain_cache_ttl:
            return

        now = time.time()
        self._ensure_cert_time_valid(auth_cert, "auth certificate", now)

        chain = await self._load_gateway_ca_chain(gateway_url, chain_aid)

        if not chain:
            raise AuthError("unable to verify auth certificate chain: missing CA chain")

        # 如果 CA 链已通过完整验证（含受信根锚定），走快速路径：只验 auth_cert → Issuer
        cache_key = f"{gateway_url}:{chain_aid}" if chain_aid else gateway_url
        if self._gateway_ca_verified.get(cache_key):
            issuer = chain[0]
            self._ensure_cert_time_valid(issuer, "Issuer CA", now)
            # 快速路径仍需检查 BasicConstraints
            try:
                bc = issuer.extensions.get_extension_for_class(x509.BasicConstraints).value
                if not bc.ca:
                    raise AuthError("Issuer CA is not marked as CA (fast path)")
            except x509.ExtensionNotFound:
                raise AuthError("Issuer CA missing BasicConstraints (fast path)")
            if auth_cert.issuer != issuer.subject:
                raise AuthError("auth certificate issuer mismatch")
            try:
                _verify_signature(issuer.public_key(), auth_cert.signature, auth_cert.tbs_certificate_bytes)
            except Exception as exc:
                raise AuthError("auth certificate signature verification failed") from exc
            self._chain_verified_cache[cert_serial] = time.time()
            return

        # 首次验证：完整验证 + 预验证 CA 链
        # 构建验证对（cert, issuer_ca, level）
        current = auth_cert
        verify_pairs = []
        for index, ca_cert in enumerate(chain):
            self._ensure_cert_time_valid(ca_cert, f"CA certificate[{index}]", now)
            if current.issuer != ca_cert.subject:
                raise AuthError(f"auth certificate issuer mismatch at chain level {index}")
            verify_pairs.append((current, ca_cert, index))
            current = ca_cert

        # 并行验证所有签名
        import concurrent.futures
        def verify_level(cert, issuer, level):
            try:
                _verify_signature(issuer.public_key(), cert.signature, cert.tbs_certificate_bytes)
                constraints = issuer.extensions.get_extension_for_class(x509.BasicConstraints).value
                if not constraints.ca:
                    raise AuthError(f"CA certificate[{level}] is not marked as CA")
            except x509.ExtensionNotFound:
                raise AuthError(f"CA certificate[{level}] missing BasicConstraints")

        with concurrent.futures.ThreadPoolExecutor(max_workers=len(verify_pairs)) as executor:
            futures = [executor.submit(verify_level, c, ca, i) for c, ca, i in verify_pairs]
            for future in concurrent.futures.as_completed(futures):
                future.result()

        root = chain[-1]
        if root.issuer != root.subject:
            raise AuthError("auth certificate chain root is not self-signed")
        try:
            _verify_signature(root.public_key(), root.signature, root.tbs_certificate_bytes)
        except Exception as exc:
            raise AuthError("auth certificate chain root self-signature verification failed") from exc

        trusted_roots = self._load_trusted_roots()
        root_der = root.public_bytes(serialization.Encoding.DER)
        if not any(
            trusted.public_bytes(serialization.Encoding.DER) == root_der
            for trusted in trusted_roots
        ):
            raise AuthError("auth certificate chain is not anchored by a trusted root")

        # 验证成功，保存到缓存并标记 CA 链已预验证
        self._chain_verified_cache[cert_serial] = time.time()
        self._gateway_ca_verified[cache_key] = True

    async def _load_gateway_ca_chain(self, gateway_url: str, chain_aid: str = "") -> list[x509.Certificate]:
        cache_key = f"{gateway_url}:{chain_aid}" if chain_aid else gateway_url
        cached = self._gateway_chain_cache.get(cache_key)
        if cached is None:
            cached = await self._fetch_gateway_ca_chain(gateway_url, chain_aid)
            self._gateway_chain_cache[cache_key] = cached
            # 注意：此处只缓存 PEM 数据，不设置 _gateway_ca_verified。
            # 信任标记只能在 _verify_auth_cert_chain 完整验证（含受信根锚定）通过后设置。
        return self._load_cert_bundle(cached)

    async def _verify_auth_cert_revocation(self, gateway_url: str, auth_cert: x509.Certificate, chain_aid: str = "") -> None:
        chain = await self._load_gateway_ca_chain(gateway_url, chain_aid)
        if not chain:
            raise AuthError("unable to verify auth certificate revocation: missing issuer certificate")

        # 跨域 peer cert：CRL 请求发到 peer 所在域的 Gateway
        crl_gateway_url = gateway_url
        if chain_aid and "." in chain_aid:
            _, peer_issuer = chain_aid.split(".", 1)
            import re as _re
            m = _re.search(r"gateway\.([^:/]+)", gateway_url)
            local_issuer = m.group(1) if m else ""
            if local_issuer and peer_issuer != local_issuer:
                crl_gateway_url = gateway_url.replace(f"gateway.{local_issuer}", f"gateway.{peer_issuer}")

        revoked_serials = await self._load_gateway_revoked_serials(crl_gateway_url, chain[0])
        serial_hex = format(auth_cert.serial_number, "x").lower()
        if serial_hex in revoked_serials:
            raise AuthError("auth certificate has been revoked")

    async def _verify_auth_cert_ocsp(self, gateway_url: str, auth_cert: x509.Certificate, chain_aid: str = "") -> None:
        chain = await self._load_gateway_ca_chain(gateway_url, chain_aid)
        if not chain:
            raise AuthError("unable to verify auth certificate OCSP status: missing issuer certificate")
        status = await self._load_gateway_ocsp_status(gateway_url, auth_cert, chain[0])
        if status == "revoked":
            raise AuthError("auth certificate OCSP status is revoked")
        if status != "good":
            raise AuthError(f"auth certificate OCSP status is {status}")

    async def verify_peer_certificate(
        self, gateway_url: str, cert: x509.Certificate, expected_aid: str,
    ) -> None:
        """统一的对端证书验证入口：时间有效性 + 链验证 + CRL + OCSP + AID 绑定。"""
        self._ensure_cert_time_valid(cert, "peer certificate", time.time())
        await self._verify_auth_cert_chain(gateway_url, cert, chain_aid=expected_aid)
        try:
            await self._verify_auth_cert_revocation(gateway_url, cert, chain_aid=expected_aid)
        except AuthError:
            raise
        except Exception as exc:
            raise AuthError(f"peer cert CRL check failed: {exc}") from exc
        try:
            await self._verify_auth_cert_ocsp(gateway_url, cert, chain_aid=expected_aid)
        except AuthError:
            raise
        except Exception as exc:
            raise AuthError(f"peer cert OCSP check failed: {exc}") from exc
        cn_attrs = cert.subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)
        if not cn_attrs or cn_attrs[0].value != expected_aid:
            cert_cn = cn_attrs[0].value if cn_attrs else "none"
            raise AuthError(f"peer cert CN mismatch: expected {expected_aid}, got {cert_cn}")

    async def _load_gateway_revoked_serials(
        self,
        gateway_url: str,
        issuer_cert: x509.Certificate,
    ) -> set[str]:
        cached = self._gateway_crl_cache.get(gateway_url)
        now = time.time()
        if cached is None or float(cached.get("next_refresh_at") or 0.0) <= now:
            cached = await self._fetch_gateway_crl(gateway_url, issuer_cert)
            self._gateway_crl_cache[gateway_url] = cached
        return set(cached.get("revoked_serials") or [])

    async def _load_gateway_ocsp_status(
        self,
        gateway_url: str,
        auth_cert: x509.Certificate,
        issuer_cert: x509.Certificate,
    ) -> str:
        serial_hex = format(auth_cert.serial_number, "x").lower()
        gateway_cache = self._gateway_ocsp_cache.setdefault(gateway_url, {})
        cached = gateway_cache.get(serial_hex)
        now = time.time()
        if cached is None or float(cached.get("next_refresh_at") or 0.0) <= now:
            cached = await self._fetch_gateway_ocsp_status(gateway_url, auth_cert, issuer_cert)
            gateway_cache[serial_hex] = cached
        return str(cached.get("status") or "unknown")

    def _load_trusted_roots(self) -> list[x509.Certificate]:
        if not self._root_certs:
            raise AuthError("no trusted roots available for auth certificate verification")
        return self._root_certs

    async def _fetch_gateway_ca_chain(self, gateway_url: str, chain_aid: str = "") -> list[str]:
        # 始终用 /pki/chain（不带 AID），返回纯 CA 链
        # 跨域时 gateway_url 已经是 peer 域的 URL
        url = self._gateway_http_url(gateway_url, "/pki/chain")
        text = await self._fetch_text(url)
        return self._split_pem_bundle(text)

    async def _fetch_gateway_crl(
        self,
        gateway_url: str,
        issuer_cert: x509.Certificate,
    ) -> dict[str, Any]:
        url = self._gateway_http_url(gateway_url, "/pki/crl.json")
        payload = await self._fetch_json(url)
        crl_pem = str(payload.get("crl_pem") or "")
        if not crl_pem:
            raise AuthError("gateway CRL endpoint returned no signed CRL")
        try:
            crl = x509.load_pem_x509_crl(crl_pem.encode("utf-8"))
        except Exception as exc:
            raise AuthError("gateway CRL endpoint returned invalid CRL") from exc
        try:
            _verify_signature(
                issuer_cert.public_key(),
                crl.signature,
                crl.tbs_certlist_bytes,
            )
        except Exception as exc:
            raise AuthError("gateway CRL signature verification failed") from exc

        if crl.next_update_utc and time.time() > crl.next_update_utc.timestamp():
            raise AuthError("gateway CRL has expired")

        revoked_serials = {
            format(revoked.serial_number, "x").lower()
            for revoked in crl
        }
        next_refresh_at = crl.next_update_utc.timestamp() if crl.next_update_utc else time.time() + 300
        # 客户端最大缓存 TTL：不信任服务端设置超过 24 小时的 next_update
        max_refresh_at = time.time() + 86400
        next_refresh_at = min(next_refresh_at, max_refresh_at)
        return {
            "revoked_serials": revoked_serials,
            "next_refresh_at": next_refresh_at,
        }

    async def _fetch_gateway_ocsp_status(
        self,
        gateway_url: str,
        auth_cert: x509.Certificate,
        issuer_cert: x509.Certificate,
    ) -> dict[str, Any]:
        serial_hex = format(auth_cert.serial_number, "x").lower()
        url = self._gateway_http_url(gateway_url, f"/pki/ocsp/{serial_hex}")
        payload = await self._fetch_json(url)
        status = str(payload.get("status") or "")
        ocsp_b64 = str(payload.get("ocsp_response") or "")
        if not ocsp_b64:
            raise AuthError("gateway OCSP endpoint returned no ocsp_response")
        try:
            response = ocsp.load_der_ocsp_response(base64.b64decode(ocsp_b64))
        except Exception as exc:
            raise AuthError("gateway OCSP endpoint returned invalid OCSP response") from exc

        if response.response_status is not ocsp.OCSPResponseStatus.SUCCESSFUL:
            raise AuthError(f"gateway OCSP response status is {response.response_status.name.lower()}")
        if response.serial_number != auth_cert.serial_number:
            raise AuthError("gateway OCSP response serial mismatch")
        expected_issuer_name_hash = hashlib.sha256(issuer_cert.subject.public_bytes()).digest()
        expected_issuer_key_hash = hashlib.sha256(
            issuer_cert.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        ).digest()
        if response.issuer_name_hash != expected_issuer_name_hash:
            raise AuthError("gateway OCSP issuer name hash mismatch")
        if response.issuer_key_hash != expected_issuer_key_hash:
            raise AuthError("gateway OCSP issuer key hash mismatch")
        try:
            _verify_signature(
                issuer_cert.public_key(),
                response.signature,
                response.tbs_response_bytes,
            )
        except Exception as exc:
            raise AuthError("gateway OCSP signature verification failed") from exc

        now = time.time()
        if response.this_update_utc and now < response.this_update_utc.timestamp() - 300:
            raise AuthError("gateway OCSP response is not yet valid")
        if response.next_update_utc and now > response.next_update_utc.timestamp():
            raise AuthError("gateway OCSP response has expired")

        cert_status = response.certificate_status
        if cert_status == ocsp.OCSPCertStatus.GOOD:
            effective_status = "good"
        elif cert_status == ocsp.OCSPCertStatus.REVOKED:
            effective_status = "revoked"
        else:
            effective_status = "unknown"
        if status and status != effective_status:
            raise AuthError("gateway OCSP status mismatch")

        next_refresh_at = response.next_update_utc.timestamp() if response.next_update_utc else time.time() + 300
        # 客户端最大缓存 TTL：不信任服务端设置超过 24 小时的 next_update
        max_refresh_at = time.time() + 86400
        next_refresh_at = min(next_refresh_at, max_refresh_at)
        return {
            "status": effective_status,
            "next_refresh_at": next_refresh_at,
        }

    async def _fetch_text(self, url: str) -> str:
        try:
            timeout = aiohttp.ClientTimeout(total=5.0)
            ssl_param = None if self._verify_ssl else False
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, ssl=ssl_param) as response:
                    response.raise_for_status()
                    return await response.text()
        except Exception as exc:
            raise AuthError(f"failed to fetch {url}") from exc

    async def _fetch_json(self, url: str) -> dict[str, Any]:
        try:
            timeout = aiohttp.ClientTimeout(total=5.0)
            ssl_param = None if self._verify_ssl else False
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, ssl=ssl_param) as response:
                    response.raise_for_status()
                    payload = await response.json()
        except Exception as exc:
            raise AuthError(f"failed to fetch {url}") from exc
        if not isinstance(payload, dict):
            raise AuthError(f"invalid JSON payload from {url}")
        return payload

    @staticmethod
    def _gateway_http_url(gateway_url: str, path: str) -> str:
        parsed = urlparse(gateway_url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        return urlunparse((scheme, parsed.netloc, path, "", "", ""))

    @staticmethod
    def _split_pem_bundle(bundle_text: str) -> list[str]:
        marker = "-----END CERTIFICATE-----"
        certs: list[str] = []
        for part in bundle_text.split(marker):
            part = part.strip()
            if not part:
                continue
            certs.append(f"{part}\n{marker}\n")
        return certs

    @staticmethod
    def _load_cert_bundle(pems: list[str]) -> list[x509.Certificate]:
        certs: list[x509.Certificate] = []
        for pem in pems:
            certs.append(x509.load_pem_x509_certificate(pem.encode("utf-8")))
        return certs

    @staticmethod
    def _ensure_cert_time_valid(cert: x509.Certificate, label: str, now: float) -> None:
        current_ts = now
        if current_ts < cert.not_valid_before_utc.timestamp():
            raise AuthError(f"{label} is not yet valid")
        if current_ts > cert.not_valid_after_utc.timestamp():
            raise AuthError(f"{label} has expired")

    @staticmethod
    def _load_root_certs(root_ca_path: str | None) -> list[x509.Certificate]:
        candidate_paths: list[Path] = []
        if root_ca_path:
            candidate_paths.append(Path(root_ca_path))
        bundled_dir = Path(__file__).resolve().parent / "certs"
        if bundled_dir.exists():
            candidate_paths.extend(sorted(bundled_dir.glob("*.crt")))

        certs: list[x509.Certificate] = []
        seen_der: set[bytes] = set()
        for path in candidate_paths:
            try:
                text = path.read_text(encoding="utf-8")
            except OSError as exc:
                raise AuthError(f"failed to read root certificate bundle: {path}") from exc
            for cert in AuthFlow._load_cert_bundle(AuthFlow._split_pem_bundle(text)):
                der = cert.public_bytes(serialization.Encoding.DER)
                if der in seen_der:
                    continue
                seen_der.add(der)
                certs.append(cert)
        return certs

    @staticmethod
    def _remember_tokens(identity: dict[str, Any], auth_result: dict[str, Any]) -> None:
        access_token = auth_result.get("access_token") or auth_result.get("token") or auth_result.get("kite_token")
        refresh_token = auth_result.get("refresh_token")
        expires_in = auth_result.get("expires_in")

        if access_token:
            identity["access_token"] = access_token
        if refresh_token:
            identity["refresh_token"] = refresh_token
        if auth_result.get("token"):
            identity["kite_token"] = auth_result["token"]
        if isinstance(expires_in, (int, float)):
            identity["access_token_expires_at"] = int(time.time() + float(expires_in))
        # 协议要求：login2 响应含 new_cert 时（证书过半自动续期），客户端必须保存
        # 先暂存到 _pending_new_cert，由 _validate_new_cert 验证后再正式接受
        new_cert = auth_result.get("new_cert")
        if new_cert:
            identity["_pending_new_cert"] = new_cert

    async def _validate_new_cert(self, identity: dict[str, Any], gateway_url: str = "") -> None:
        """验证服务端返回的 new_cert，通过后才正式接受。

        安全要点：除 CN/公钥/时间外，还必须做完整链验证 + 受信根锚定 + CRL/OCSP，
        防止恶意网关塞入"同公钥但不受信链"的证书。
        """
        new_cert_pem = identity.pop("_pending_new_cert", None)
        if not new_cert_pem:
            return
        try:
            cert = x509.load_pem_x509_certificate(
                new_cert_pem.encode("utf-8") if isinstance(new_cert_pem, str) else new_cert_pem
            )
            # 1. CN 必须匹配当前 AID
            aid = identity.get("aid", "")
            cn_attrs = cert.subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)
            if not cn_attrs or cn_attrs[0].value != aid:
                raise AuthError(
                    f"new_cert CN mismatch: expected {aid}, got {cn_attrs[0].value if cn_attrs else 'none'}"
                )
            # 2. 公钥必须匹配本地私钥
            cert_pub_der = cert.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            local_pub_b64 = identity.get("public_key_der_b64", "")
            if local_pub_b64:
                local_pub_der = base64.b64decode(local_pub_b64)
                if cert_pub_der != local_pub_der:
                    raise AuthError("new_cert public key does not match local identity key")
            # 3. 时间有效性
            self._ensure_cert_time_valid(cert, "new_cert", time.time())
            # 4. 完整证书链验证 + 受信根锚定 + CRL/OCSP
            if gateway_url:
                await self._verify_auth_cert_chain(gateway_url, cert)
                await self._verify_auth_cert_revocation(gateway_url, cert)
                try:
                    await self._verify_auth_cert_ocsp(gateway_url, cert)
                except AuthError:
                    pass  # OCSP 不可用时降级（CRL 已检查）
            # 验证通过，正式接受
            identity["cert"] = new_cert_pem if isinstance(new_cert_pem, str) else new_cert_pem.decode("utf-8")
        except AuthError as exc:
            _auth_log.warning("拒绝服务端返回的 new_cert (%s): %s", identity.get("aid"), exc)
        except Exception as exc:
            _auth_log.warning("new_cert 验证异常 (%s): %s", identity.get("aid"), exc)

    @staticmethod
    def _get_cached_access_token(identity: dict[str, Any]) -> str:
        access_token = str(identity.get("access_token") or "")
        if not access_token:
            return ""
        expires_at = identity.get("access_token_expires_at")
        if isinstance(expires_at, (int, float)) and float(expires_at) <= time.time() + 30:
            return ""
        return access_token

    def _ensure_local_identity(self, aid: str) -> dict[str, Any]:
        existing = self._keystore.load_identity(aid)
        if existing:
            self._aid = aid
            return existing
        identity = self._crypto.generate_identity()
        identity["aid"] = aid
        self._keystore.save_identity(aid, identity)  # 立即持久化 keypair，避免服务端拒绝后丢失
        self._aid = aid
        return identity

    def _load_identity_or_raise(self, aid: str | None = None) -> dict[str, Any]:
        requested_aid = aid or self._aid
        if requested_aid:
            existing = self._keystore.load_identity(requested_aid)
            if existing is None:
                raise StateError(f"identity not found for aid: {requested_aid}")
            self._aid = requested_aid
            return existing

        load_any_identity = getattr(self._keystore, "load_any_identity", None)
        if callable(load_any_identity):
            existing = load_any_identity()
            if existing is not None:
                loaded_aid = existing.get("aid")
                if isinstance(loaded_aid, str) and loaded_aid:
                    self._aid = loaded_aid
                return existing

        raise StateError("no local identity found, call auth.create_aid() first")

    def _ensure_identity(self) -> dict[str, Any]:
        try:
            return self._load_identity_or_raise()
        except StateError:
            if not self._aid:
                raise StateError("no local identity found, call auth.create_aid() first")
            identity = self._crypto.generate_identity()
            identity["aid"] = self._aid
            self._keystore.save_identity(self._aid, identity)  # 立即持久化，避免后续网络失败丢失密钥
            return identity

    async def _default_connection_factory(self, url: str):
        return await websockets.connect(url, open_timeout=5, close_timeout=5, ping_interval=None)
