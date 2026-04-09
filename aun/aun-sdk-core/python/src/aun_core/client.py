from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlparse, urlunparse

import aiohttp
import websockets

from .auth import AuthFlow
from .config import AUNConfig
from .crypto import CryptoProvider
from .discovery import GatewayDiscovery
from .e2ee import E2EEManager, GroupE2EEManager
from .errors import (
    AUNError,
    AuthError,
    ConnectionError,
    E2EEError,
    PermissionError as AUNPermissionError,
    StateError,
    ValidationError,
)
from .events import EventDispatcher, Subscription
from .keystore.file import FileKeyStore
from .namespaces.auth_namespace import AuthNamespace
from .transport import RPCTransport

_INTERNAL_ONLY_METHODS = {
    "auth.login1",
    "auth.aid_login1",
    "auth.login2",
    "auth.aid_login2",
    "auth.connect",
    "auth.refresh_token",
    "initialize",
}

_DEFAULT_SESSION_OPTIONS: dict[str, Any] = {
    "auto_reconnect": False,
    "heartbeat_interval": 30.0,
    "token_refresh_before": 60.0,
    "retry": {
        "initial_delay": 0.5,
        "max_delay": 30.0,
    },
    "timeouts": {
        "connect": 5.0,
        "call": 10.0,
        "http": 30.0,
    },
}


import ssl as _ssl
import logging as _logging

_client_log = _logging.getLogger("aun_core.client")
_ssl_warning_emitted = False

_NO_VERIFY_SSL = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
_NO_VERIFY_SSL.check_hostname = False
_NO_VERIFY_SSL.verify_mode = _ssl.CERT_NONE


def _make_connection_factory(verify_ssl: bool = True):
    """根据 verify_ssl 配置创建 WebSocket 连接工厂"""
    async def _factory(url: str) -> Any:
        global _ssl_warning_emitted
        kw: dict[str, Any] = {"open_timeout": 5, "close_timeout": 5, "ping_interval": None}
        if url.startswith("wss://"):
            if verify_ssl:
                pass  # 使用默认 SSL 上下文（验证证书）
            else:
                kw["ssl"] = _NO_VERIFY_SSL
                if not _ssl_warning_emitted:
                    _client_log.warning(
                        "TLS 证书验证已禁用（verify_ssl=False）。"
                        "生产环境应设为 True 以防止中间人攻击。"
                    )
                    _ssl_warning_emitted = True
        return await websockets.connect(url, **kw)
    return _factory


async def _default_connection_factory(url: str) -> Any:
    kw: dict[str, Any] = {"open_timeout": 5, "close_timeout": 5, "ping_interval": None}
    if url.startswith("wss://"):
        kw["ssl"] = _NO_VERIFY_SSL
    return await websockets.connect(url, **kw)


_PEER_CERT_CACHE_TTL = 600  # 10 分钟


@dataclass(slots=True)
class _CachedPeerCert:
    cert_bytes: bytes
    validated_at: float
    refresh_after: float


class AUNClient:
    """AUN Core SDK — 连接、认证、密钥管理、E2EE。"""

    def __init__(self, config: dict | None = None) -> None:
        raw_config = dict(config or {})
        self._config_model = AUNConfig.from_dict(raw_config)
        self.config = raw_config
        self._aid: str | None = None
        self._identity: dict[str, Any] | None = None
        self._state = "idle"
        self._gateway_url: str | None = None
        self._closing = False
        self._reconnect_task: asyncio.Task | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._token_refresh_task: asyncio.Task | None = None
        self._prekey_refresh_task: asyncio.Task | None = None
        self._session_params: dict[str, Any] | None = None
        self._session_options: dict[str, Any] = dict(_DEFAULT_SESSION_OPTIONS)
        self._dispatcher = EventDispatcher()
        self._discovery = GatewayDiscovery(verify_ssl=self._config_model.verify_ssl)

        # E2EE 编排状态（内存缓存，进程退出即清空）
        self._cert_cache: dict[str, _CachedPeerCert] = {}

        connection_factory = raw_config.get("connection_factory") or _make_connection_factory(
            self._config_model.verify_ssl
        )
        keystore = raw_config.get("keystore") or FileKeyStore(
            self._config_model.aun_path,
            secret_store=raw_config.get("secret_store"),
            encryption_seed=self._config_model.encryption_seed,
        )
        self._keystore = keystore
        self._auth = AuthFlow(
            keystore=keystore,
            crypto=raw_config.get("crypto") or CryptoProvider(),
            aid=None,
            connection_factory=connection_factory,
            root_ca_path=raw_config.get("root_ca_path"),
            verify_ssl=self._config_model.verify_ssl,
        )
        self._transport = RPCTransport(
            event_dispatcher=self._dispatcher,
            connection_factory=connection_factory,
            timeout=_DEFAULT_SESSION_OPTIONS["timeouts"]["call"],
            on_disconnect=self._handle_transport_disconnect,
        )
        self._e2ee = E2EEManager(
            identity_fn=lambda: self._identity or {},
            keystore=keystore,
            replay_window_seconds=self._config_model.replay_window_seconds,
        )
        self._group_e2ee = GroupE2EEManager(
            identity_fn=lambda: self._identity or {},
            keystore=keystore,
            sender_cert_resolver=lambda aid: self._get_verified_peer_cert(aid),
            initiator_cert_resolver=lambda aid: self._get_verified_peer_cert(aid),
        )
        self._group_epoch_rotate_task: asyncio.Task | None = None
        self._group_epoch_cleanup_task: asyncio.Task | None = None

        self.auth = AuthNamespace(self)

        # 内部订阅：推送消息自动解密后 re-publish 给用户
        self._dispatcher.subscribe("_raw.message.received", self._on_raw_message_received)
        # 群组消息推送：自动解密后 re-publish
        self._dispatcher.subscribe("_raw.group.message_created", self._on_raw_group_message_created)
        # 群组变更事件：拦截处理成员变更触发的 epoch 轮换，然后透传
        self._dispatcher.subscribe("_raw.group.changed", self._on_raw_group_changed)
        # 其他事件直接透传
        for evt in ("message.recalled", "message.ack"):
            self._dispatcher.subscribe(f"_raw.{evt}", lambda data, e=evt: self._dispatcher.publish(e, data))

    # ── 属性 ──────────────────────────────────────────────

    @property
    def aid(self) -> str | None:
        return self._aid

    @property
    def state(self) -> str:
        return self._state

    @property
    def e2ee(self) -> E2EEManager:
        return self._e2ee

    @property
    def group_e2ee(self) -> GroupE2EEManager:
        return self._group_e2ee

    # ── 生命周期 ──────────────────────────────────────────

    async def connect(self, auth: dict[str, Any], options: dict[str, Any] | None = None) -> None:
        if self._state not in {"idle", "closed"}:
            raise StateError(f"connect not allowed in state {self._state}")
        params = dict(auth)
        if options:
            params.update(options)
        normalized = self._normalize_connect_params(params)
        self._session_params = normalized
        self._session_options = self._build_session_options(normalized)
        self._transport.set_timeout(self._session_options["timeouts"]["call"])
        self._closing = False
        await self._connect_once(normalized, allow_reauth=False)

    async def close(self) -> None:
        self._closing = True
        await self._stop_background_tasks()
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            try:
                await self._reconnect_task
            except asyncio.CancelledError:
                pass  # 任务取消，正常清理
            self._reconnect_task = None
        if self._state in {"idle", "closed"}:
            self._state = "closed"
            return
        await self._transport.close()
        self._state = "closed"
        await self._dispatcher.publish("connection.state", {"state": self._state})

    # ── RPC ───────────────────────────────────────────────

    # 需要客户端签名的关键方法（渐进式部署：服务端有签名则验，无签名则放行）
    _SIGNED_METHODS = frozenset({
        "group.send", "group.kick", "group.add_member",
        "group.leave", "group.remove_member", "group.update_rules",
    })

    def _sign_client_operation(self, method: str, params: dict[str, Any]) -> None:
        """为关键操作附加客户端 ECDSA 签名（_client_signature 字段）。"""
        identity = self._identity
        if not identity or not identity.get("private_key_pem"):
            return
        try:
            from cryptography.hazmat.primitives.asymmetric import ec as _ec
            from cryptography.hazmat.primitives import hashes as _hashes, serialization as _ser
            aid = identity.get("aid", "")
            ts = str(int(time.time()))
            # 计算 params hash
            # 约定：签名覆盖所有非 _ 前缀且非 client_signature 的业务字段
            params_for_hash = {k: v for k, v in params.items()
                               if k != "client_signature" and not k.startswith("_")}
            params_json = json.dumps(params_for_hash, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            params_hash = hashlib.sha256(params_json.encode("utf-8")).hexdigest()
            sign_data = f"{method}|{aid}|{ts}|{params_hash}".encode("utf-8")
            pk = _ser.load_pem_private_key(
                identity["private_key_pem"].encode("utf-8"), password=None,
            )
            sig = pk.sign(sign_data, _ec.ECDSA(_hashes.SHA256()))
            params["client_signature"] = {
                "aid": aid,
                "timestamp": ts,
                "params_hash": params_hash,
                "signature": base64.b64encode(sig).decode("ascii"),
            }
        except Exception as exc:
            _client_log.warning("客户端签名失败，继续发送无签名请求: %s", exc)

    async def call(self, method: str, params: dict | None = None) -> Any:
        if self._state != "connected":
            raise ConnectionError("client is not connected")
        if self._is_internal_only_method(method):
            raise AUNPermissionError(f"method is internal_only: {method}")

        params = dict(params) if params else {}

        # 自动加密：message.send 默认加密（encrypt 默认 True）
        if method == "message.send":
            encrypt = params.pop("encrypt", True)
            if encrypt:
                return await self._send_encrypted(params)

        # 自动加密：group.send 默认加密（encrypt 默认 True）
        if method == "group.send":
            encrypt = params.pop("encrypt", True)
            if encrypt:
                return await self._send_group_encrypted(params)

        # 关键操作自动附加客户端签名
        if method in self._SIGNED_METHODS:
            self._sign_client_operation(method, params)

        result = await self._transport.call(method, params)

        # 自动解密：message.pull 返回的消息
        if method == "message.pull" and isinstance(result, dict):
            messages = result.get("messages")
            if isinstance(messages, list) and messages:
                result["messages"] = await self._decrypt_messages(messages)

        # 自动解密：group.pull 返回的群消息
        if method == "group.pull" and isinstance(result, dict):
            messages = result.get("messages")
            if isinstance(messages, list) and messages:
                result["messages"] = await self._decrypt_group_messages(messages)

        # ── Group E2EE 自动编排 ────────────────────────────
        if self._config_model.group_e2ee:
            loop = getattr(self, "_loop", None) or asyncio.get_running_loop()

            # 建群后自动创建 epoch（幂等：已有 secret 时跳过）
            # 同步到服务端确保 epoch 一致
            if method == "group.create" and isinstance(result, dict):
                group = result.get("group", {})
                gid = group.get("group_id", "")
                if gid and self._aid and not self._group_e2ee.has_secret(gid):
                    try:
                        self._group_e2ee.create_epoch(gid, [self._aid])
                        # 同步到服务端：将服务端 epoch 从 0 推到 1
                        loop.create_task(self._sync_epoch_to_server(gid))
                    except Exception as exc:
                        self._log_e2ee_error("create_epoch", gid, "", exc)

            # 加人后自动分发密钥给新成员（如 rotate_on_join 则先轮换）
            if method == "group.add_member":
                group_id = params.get("group_id", "")
                new_aid = params.get("aid", "")
                if group_id and new_aid:
                    if self._config_model.rotate_on_join:
                        loop.create_task(self._rotate_group_epoch(group_id))
                    else:
                        loop.create_task(self._distribute_key_to_new_member(group_id, new_aid))

            # 踢人后自动轮换 epoch
            if method == "group.kick":
                group_id = params.get("group_id", "")
                if group_id:
                    loop.create_task(self._rotate_group_epoch(group_id))

            # group.leave：按协议，离开者自身不执行轮换。
            # 剩余在线 admin/owner 收到 group.changed(action=member_left) 后自动补位轮换。

            # 审批通过后自动分发密钥给新成员
            if method == "group.review_join_request" and isinstance(result, dict):
                if result.get("approved") or result.get("status") == "approved":
                    group_id = params.get("group_id", "")
                    new_aid = params.get("aid", "")
                    if group_id and new_aid:
                        loop.create_task(self._distribute_key_to_new_member(group_id, new_aid))

            # 批量审批通过后分发密钥（根据 rotate_on_join 决定轮换或补发）
            if method == "group.batch_review_join_request" and isinstance(result, dict):
                group_id = params.get("group_id", "")
                approved_aids = [
                    item.get("aid", "")
                    for item in result.get("results", [])
                    if item.get("ok") and item.get("status") == "approved" and item.get("aid")
                ]
                if group_id and approved_aids:
                    if self._config_model.rotate_on_join:
                        # 批量审批触发一次轮换（覆盖所有新成员）
                        loop.create_task(self._rotate_group_epoch(group_id))
                    else:
                        # 逐个补发当前密钥
                        for aid in approved_aids:
                            loop.create_task(self._distribute_key_to_new_member(group_id, aid))

        return result

    def _log_e2ee_error(self, stage: str, group_id: str, aid: str, exc: Exception) -> None:
        """记录 E2EE 自动编排错误（发布事件，不吞掉异常信息）。"""
        try:
            loop = getattr(self, "_loop", None)
            if loop and loop.is_running():
                loop.create_task(self._dispatcher.publish(
                    "e2ee.orchestration_error",
                    {"stage": stage, "group_id": group_id, "aid": aid, "error": str(exc)},
                ))
        except Exception:
            pass  # 日志本身不应阻断主流程

    async def _send_encrypted(self, params: dict[str, Any]) -> Any:
        """自动加密并发送消息。"""
        import time as _time
        import uuid as _uuid

        to_aid = params.get("to")
        payload = params.get("payload")
        message_id = params.get("message_id") or str(_uuid.uuid4())
        timestamp = params.get("timestamp") or int(_time.time() * 1000)

        # 获取对方证书
        peer_cert_pem = await self._fetch_peer_cert(to_aid)

        # 获取对方 prekey（可能没有）
        prekey = await self._fetch_peer_prekey(to_aid)

        envelope, encrypt_result = self._e2ee.encrypt_outbound(
            peer_aid=to_aid,
            payload=payload,
            peer_cert_pem=peer_cert_pem,
            prekey=prekey,
            message_id=message_id,
            timestamp=timestamp,
        )
        if not encrypt_result.get("encrypted"):
            raise E2EEError(f"failed to encrypt message to {to_aid}")

        # 严格模式：拒绝无前向保密的降级
        if self._config_model.require_forward_secrecy and not encrypt_result.get("forward_secrecy"):
            raise E2EEError(
                f"forward secrecy required but unavailable for {to_aid} "
                f"(mode={encrypt_result.get('mode')})"
            )

        # 降级时发布安全事件
        if encrypt_result.get("degraded"):
            try:
                await self._dispatcher.publish("e2ee.degraded", {
                    "peer_aid": to_aid,
                    "mode": encrypt_result.get("mode"),
                    "reason": encrypt_result.get("degradation_reason"),
                })
            except Exception as exc:
                _client_log.warning("发布 e2ee.degraded 事件失败: %s", exc)

        send_params: dict[str, Any] = {
            "to": to_aid,
            "payload": envelope,
            "type": "e2ee.encrypted",
            "encrypted": True,
            "message_id": message_id,
            "timestamp": timestamp,
            "persist": params.get("persist", True),
        }
        return await self._transport.call("message.send", send_params)

    async def _send_group_encrypted(self, params: dict[str, Any]) -> Any:
        """自动加密并发送群组消息。"""
        group_id = params.get("group_id")
        payload = params.get("payload")
        if not group_id:
            raise ValidationError("group.send requires group_id")

        envelope = self._group_e2ee.encrypt(group_id, payload)

        send_params: dict[str, Any] = {
            "group_id": group_id,
            "payload": envelope,
            "type": "e2ee.group_encrypted",
            "encrypted": True,
        }
        self._sign_client_operation("group.send", send_params)
        return await self._transport.call("group.send", send_params)

    # ── 便利方法 ──────────────────────────────────────────

    async def ping(self, params: dict | None = None) -> Any:
        return await self.call("meta.ping", params or {})

    async def status(self, params: dict | None = None) -> Any:
        return await self.call("meta.status", params or {})

    async def trust_roots(self, params: dict | None = None) -> Any:
        return await self.call("meta.trust_roots", params or {})

    # ── 事件 ──────────────────────────────────────────────

    def on(self, event: str, handler: Callable[[Any], Any]) -> Subscription:
        return self._dispatcher.subscribe(event, handler)

    async def _on_raw_message_received(self, data: Any) -> None:
        """处理 transport 层推送的原始消息：解密后 re-publish 给用户。"""
        loop = getattr(self, "_loop", None) or asyncio.get_running_loop()
        loop.create_task(self._process_and_publish_message(data))

    async def _process_and_publish_message(self, data: Any) -> None:
        """实际处理推送消息的异步任务。"""
        try:
            if not isinstance(data, dict):
                await self._dispatcher.publish("message.received", data)
                return
            msg = dict(data)

            # 拦截 P2P 传输的群组密钥分发/请求/响应消息
            if await self._try_handle_group_key_message(msg):
                return

            decrypted = await self._decrypt_single_message(msg)
            await self._dispatcher.publish("message.received", decrypted)
        except Exception as _exc:
            import logging as _logging
            _logging.getLogger("aun_core").debug("解密失败: %s", _exc)

    async def _on_raw_group_message_created(self, data: Any) -> None:
        """处理群组消息推送：自动解密后 re-publish。"""
        loop = getattr(self, "_loop", None) or asyncio.get_running_loop()
        loop.create_task(self._process_and_publish_group_message(data))

    async def _on_raw_group_changed(self, data: Any) -> None:
        """处理群组变更事件：透传给用户，并在成员离开/被踢时自动触发 epoch 轮换。

        按协议，轮换由剩余在线 admin/owner 负责（离开者自身不执行）。
        _rotate_group_epoch 内部通过服务端 CAS + 角色校验保证只有一方成功。
        """
        await self._dispatcher.publish("group.changed", data)

        # 成员退出或被踢 → 剩余 admin/owner 自动补位轮换
        if isinstance(data, dict) and data.get("action") in ("member_left", "member_removed"):
            group_id = data.get("group_id", "")
            if group_id:
                loop = getattr(self, "_loop", None) or asyncio.get_running_loop()
                loop.create_task(self._rotate_group_epoch(group_id))

    async def _process_and_publish_group_message(self, data: Any) -> None:
        """处理群组推送消息的异步任务。"""
        try:
            if not isinstance(data, dict):
                await self._dispatcher.publish("group.message_created", data)
                return
            msg = dict(data)
            decrypted = await self._decrypt_group_message(msg)
            await self._dispatcher.publish("group.message_created", decrypted)
        except Exception as _exc:
            import logging as _logging
            _logging.getLogger("aun_core").debug("解密失败: %s", _exc)

    async def _decrypt_group_message(self, message: dict[str, Any]) -> dict[str, Any]:
        """解密单条群组消息。"""
        payload = message.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "e2ee.group_encrypted":
            return message

        # 确保发送方证书已缓存（签名验证需要）— 失败时拒绝解密
        sender_aid = message.get("from", message.get("sender_aid", ""))
        if sender_aid:
            cert_ok = await self._ensure_sender_cert_cached(sender_aid)
            if not cert_ok:
                _client_log.warning("群消息解密跳过：发送方 %s 证书不可用", sender_aid)
                return message

        # 先尝试直接解密
        result = self._group_e2ee.decrypt(message)
        if result is not None and result.get("e2ee"):
            return result

        # 解密失败，尝试密钥恢复后重试
        group_id = message.get("group_id", "")
        sender = message.get("from", message.get("sender_aid", ""))
        epoch = payload.get("epoch")
        if epoch is not None and group_id:
            recovery = self._group_e2ee.build_recovery_request(
                group_id, epoch, sender_aid=sender,
            )
            if recovery:
                try:
                    await self.call("message.send", {
                        "to": recovery["to"],
                        "payload": recovery["payload"],
                        "encrypt": True,
                        "persist": False,
                    })
                except Exception as _exc:
                    import logging as _logging
                    _logging.getLogger("aun_core").debug("操作失败: %s", _exc)

        return message

    async def _decrypt_group_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """批量解密群组消息（用于 group.pull）。"""
        result = []
        for msg in messages:
            decrypted = await self._decrypt_group_message(msg)
            result.append(decrypted)
        return result

    async def _try_handle_group_key_message(self, message: dict[str, Any]) -> bool:
        """尝试处理 P2P 传输的群组密钥消息。返回 True 表示已处理（不再传播）。"""
        payload = message.get("payload")
        if not isinstance(payload, dict):
            return False

        # 先解密 P2P E2EE（如果是加密的）
        # 注意：用 _decrypt_message 而非 decrypt_message，避免消耗 seen set
        actual_payload = payload
        if payload.get("type") == "e2ee.encrypted":
            # 确保发送方证书已缓存（签名验证需要）
            from_aid = message.get("from", "")
            if from_aid:
                await self._ensure_sender_cert_cached(from_aid)
            decrypted = self._e2ee._decrypt_message(message)
            if decrypted is None:
                return False
            actual_payload = decrypted.get("payload", {})
            if not isinstance(actual_payload, dict):
                return False

        result = self._group_e2ee.handle_incoming(actual_payload)
        if result is None:
            return False

        if result == "request":
            # 处理密钥请求并回复
            group_id = actual_payload.get("group_id", "")
            requester = actual_payload.get("requester_aid", "")
            members = self._group_e2ee.get_member_aids(group_id)

            # 请求者不在本地成员列表时，回源查询服务端最新成员列表
            # （覆盖 use_invite_code 等不经过 owner 客户端的入群路径）
            if requester and requester not in members:
                try:
                    members_result = await self.call("group.get_members", {"group_id": group_id})
                    members = [m["aid"] for m in members_result.get("members", [])]
                    # 更新本地当前 epoch 的 member_aids/commitment
                    if requester in members:
                        secret_data = self._group_e2ee.load_secret(group_id)
                        if secret_data:
                            from .e2ee import compute_membership_commitment, store_group_secret
                            epoch = secret_data["epoch"]
                            commitment = compute_membership_commitment(members, epoch, group_id, secret_data["secret"])
                            store_group_secret(
                                self._keystore, self._aid, group_id, epoch,
                                secret_data["secret"], commitment, members,
                            )
                except Exception as exc:
                    _client_log.warning("群组 %s 成员列表回源失败: %s", group_id, exc)

            response = self._group_e2ee.handle_key_request_msg(actual_payload, members)
            if response:
                if requester:
                    try:
                        await self.call("message.send", {
                            "to": requester,
                            "payload": response,
                            "encrypt": True,
                            "persist": False,
                        })
                    except Exception as exc:
                        _client_log.warning("向 %s 回复群组密钥失败: %s", requester, exc)

        return True

    # ── E2EE 编排（从 E2EEManager 上提）─────────────────

    async def _fetch_peer_cert(self, aid: str) -> bytes:
        """获取对方证书（带缓存 + 完整 PKI 验证：链 + CRL + OCSP + AID 绑定）

        跨域时自动将请求路由到 peer 所在域的 Gateway（URL 替换），
        同时 Gateway 侧也有代理 fallback。
        """
        cached = self._cert_cache.get(aid)
        if cached and time.time() < cached.refresh_after:
            return cached.cert_bytes
        gateway_url = self._gateway_url
        if not gateway_url:
            raise ValidationError("gateway url unavailable for e2ee cert fetch")

        # 跨域时用 peer 所在域的 Gateway URL
        peer_gateway_url = self._resolve_peer_gateway_url(gateway_url, aid)
        cert_url = self._build_cert_url(peer_gateway_url, aid)
        ssl_param = None if self._config_model.verify_ssl else False
        async with aiohttp.ClientSession() as session:
            async with session.get(cert_url, ssl=ssl_param) as response:
                response.raise_for_status()
                cert_pem = await response.text()
        cert_bytes = cert_pem.encode("utf-8")

        # 完整 PKI 验证：链 + CRL + OCSP + AID 绑定
        # 验证时也用 peer 的 Gateway URL（链/OCSP/CRL 都从 peer 域获取）
        from cryptography import x509 as _x509
        cert_obj = _x509.load_pem_x509_certificate(cert_bytes)
        try:
            await self._auth.verify_peer_certificate(peer_gateway_url, cert_obj, aid)
        except Exception as exc:
            raise ValidationError(f"peer cert verification failed for {aid}: {exc}")

        now = time.time()
        self._cert_cache[aid] = _CachedPeerCert(
            cert_bytes=cert_bytes,
            validated_at=now,
            refresh_after=now + _PEER_CERT_CACHE_TTL,
        )
        # 同步写入 keystore，保证 E2EE 解密时 _get_sender_cert 能读到
        try:
            self._keystore.save_cert(aid, cert_pem)
        except Exception as exc:
            _client_log.error("写入证书到 keystore 失败 (aid=%s): %s", aid, exc)
        return cert_bytes

    async def _fetch_peer_prekey(self, peer_aid: str) -> dict[str, Any] | None:
        """获取对方的 prekey（通过 E2EEManager 缓存）"""
        cached = self._e2ee.get_cached_prekey(peer_aid)
        if cached is not None:
            return cached
        try:
            result = await self._transport.call("message.e2ee.get_prekey", {"aid": peer_aid})
            if isinstance(result, dict) and result.get("found"):
                prekey = result.get("prekey")
                if prekey:
                    self._e2ee.cache_prekey(peer_aid, prekey)
                return prekey
        except Exception as _exc:
            import logging as _logging
            _logging.getLogger("aun_core").debug("prekey 操作失败: %s", _exc)
        return None

    async def _upload_prekey(self) -> dict[str, Any]:
        """生成 prekey 并上传到服务端"""
        prekey_material = self._e2ee.generate_prekey()
        result = await self._transport.call("message.e2ee.put_prekey", prekey_material)
        return result if isinstance(result, dict) else {"ok": True}

    async def _check_replay_guard(
        self, message_id: str, sender_aid: str, encryption_mode: str, message: dict[str, Any],
    ) -> bool:
        """服务端防重放检查（可通过 config.server_replay_guard=False 关闭）。

        本地防重放由 E2EEManager._seen_messages 处理，无需此方法。
        此方法提供跨进程/跨重启的持久化防重放增强。
        """
        if not self.config.get("server_replay_guard", False):
            return True
        if not message_id:
            return True

        from cryptography.hazmat.primitives import hashes as _hashes

        timestamp_ms = int(message.get("timestamp") or 0)
        ephemeral_pk_hash = None
        payload = message.get("payload", {})
        epk = payload.get("ephemeral_public_key")
        if epk:
            digest = _hashes.Hash(_hashes.SHA256())
            digest.update(epk.encode("utf-8") if isinstance(epk, str) else epk)
            ephemeral_pk_hash = digest.finalize().hex()[:32]

        try:
            result = await self._transport.call("message.e2ee.record_replay_guard", {
                "sender_aid": sender_aid,
                "message_id": message_id,
                "encryption_mode": encryption_mode,
                "timestamp_ms": timestamp_ms,
                "ephemeral_pk_hash": ephemeral_pk_hash,
            })
            if isinstance(result, dict) and result.get("duplicate"):
                return False
        except Exception as _exc:
            import logging as _logging
            _logging.getLogger("aun_core").debug("操作失败: %s", _exc)
        return True

    async def _decrypt_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """批量解密消息（用于 message.pull）。

        直接解密，不经过 E2EEManager 的 seen set（避免与推送冲突）。
        同一批次内按 message_id 去重。
        """
        seen_in_batch: set[str] = set()
        result = []
        for msg in messages:
            mid = msg.get("message_id", "")
            if mid and mid in seen_in_batch:
                continue
            if mid:
                seen_in_batch.add(mid)
            payload = msg.get("payload")
            if (isinstance(payload, dict)
                and payload.get("type") == "e2ee.encrypted"
                and (msg.get("encrypted") is True or "encrypted" not in msg)):
                # 确保发送方证书已缓存（签名验证需要）
                from_aid = msg.get("from", "")
                if from_aid:
                    cert_ready = await self._ensure_sender_cert_cached(from_aid)
                    if not cert_ready:
                        _client_log.warning("无法获取发送方 %s 的证书，跳过解密", from_aid)
                        result.append(msg)
                        continue
                decrypted = self._e2ee._decrypt_message(msg)
                result.append(decrypted if decrypted is not None else msg)
            else:
                result.append(msg)
        return result

    async def _decrypt_single_message(self, message: dict[str, Any]) -> dict[str, Any]:
        """解密单条消息：服务端 replay guard + 密码学解密（含本地防重放）"""
        payload = message.get("payload")
        if not isinstance(payload, dict):
            return message
        if payload.get("type") != "e2ee.encrypted":
            return message
        if message.get("encrypted") is not True and "encrypted" in message:
            return message

        # 服务端 replay guard（增强保护，E2EEManager 内部还有本地 seen set）
        message_id = message.get("message_id", "")
        from_aid = message.get("from", "")
        encryption_mode = payload.get("encryption_mode", "")
        if not await self._check_replay_guard(message_id, from_aid, encryption_mode, message):
            return message

        # 确保发送方证书已缓存到 keystore（三路 ECDH + 签名验证需要）
        if from_aid:
            cert_ready = await self._ensure_sender_cert_cached(from_aid)
            if not cert_ready:
                _client_log.warning("无法获取发送方 %s 的证书，跳过解密", from_aid)
                return message

        # 密码学解密（E2EEManager.decrypt_message 内含本地防重放）
        decrypted = self._e2ee.decrypt_message(message)
        return decrypted if decrypted is not None else message

    async def _ensure_sender_cert_cached(self, aid: str) -> bool:
        """确保发送方证书在本地 keystore 中可用且未过期。

        安全要点：不能永久信任旧证书，必须按 TTL 刷新并重新做 PKI 验证
        （链 + CRL + OCSP + AID 绑定），以使证书吊销和轮换及时生效。

        返回 True 表示证书已就绪（PKI 验证通过），False 表示不可用。
        """
        # 内存缓存未过期 → 跳过（_fetch_peer_cert 已做完整 PKI 验证）
        cached = self._cert_cache.get(aid)
        if cached and time.time() < cached.refresh_after:
            return True
        try:
            # _fetch_peer_cert 内部：下载 → 完整 PKI 验证 → 更新内存缓存
            cert_bytes = await self._fetch_peer_cert(aid)
            cert_pem = cert_bytes.decode("utf-8") if isinstance(cert_bytes, bytes) else cert_bytes
            self._keystore.save_cert(aid, cert_pem)
            return True
        except Exception as exc:
            # 刷新失败时：若内存缓存有 PKI 验证过的证书（未过期 × 2 倍 TTL）则继续用
            if cached and time.time() < cached.validated_at + _PEER_CERT_CACHE_TTL * 2:
                _client_log.debug("刷新发送方 %s 证书失败，继续使用已验证的内存缓存: %s", aid, exc)
                return True
            # 超出宽限期或从未验证过 → 不可信
            _client_log.warning(
                "获取发送方 %s 证书失败且无已验证缓存，拒绝信任: %s", aid, exc,
            )
            return False

    def _get_verified_peer_cert(self, aid: str) -> str | None:
        """获取经过 PKI 验证的 peer 证书（仅信任内存缓存中已验证的证书）。

        零信任要求：只返回经 _fetch_peer_cert 完整 PKI 验证后缓存的证书，
        不直接信任 keystore 中可能由恶意服务端注入的证书。
        """
        cached = self._cert_cache.get(aid)
        if cached and time.time() < cached.validated_at + _PEER_CERT_CACHE_TTL * 2:
            return cached.cert_bytes.decode("utf-8") if isinstance(cached.cert_bytes, bytes) else cached.cert_bytes
        return None

    @staticmethod
    def _build_cert_url(gateway_url: str, aid: str) -> str:
        parsed = urlparse(gateway_url)
        scheme = "https" if parsed.scheme == "wss" else "http"
        netloc = parsed.netloc
        path = f"/pki/cert/{quote(aid, safe='')}"
        return urlunparse((scheme, netloc, path, "", "", ""))

    @staticmethod
    def _resolve_peer_gateway_url(local_gateway_url: str, peer_aid: str) -> str:
        """跨域时将 Gateway URL 替换为 peer 所在域的 Gateway URL。

        例: local=wss://gateway.aid.com:20001/aun, peer=bob.aid.net
        → wss://gateway.aid.net:20001/aun
        """
        if "." not in peer_aid:
            return local_gateway_url
        _, peer_issuer = peer_aid.split(".", 1)
        import re
        m = re.search(r"gateway\.([^:/]+)", local_gateway_url)
        if not m:
            return local_gateway_url
        local_issuer = m.group(1)
        if local_issuer == peer_issuer:
            return local_gateway_url
        return local_gateway_url.replace(f"gateway.{local_issuer}", f"gateway.{peer_issuer}")

    # ── 内部：连接 ────────────────────────────────────────

    async def _connect_once(self, params: dict[str, Any], *, allow_reauth: bool) -> None:
        gateway_url = self._resolve_gateway(params)
        self._gateway_url = gateway_url
        self._loop = asyncio.get_running_loop()
        self._state = "connecting"
        challenge = await self._transport.connect(gateway_url)
        self._state = "authenticating"
        if allow_reauth:
            auth_context = await self._auth.connect_session(
                self._transport,
                challenge,
                gateway_url,
                access_token=params.get("access_token"),
            )
            identity = auth_context.get("identity") if isinstance(auth_context, dict) else None
            if isinstance(identity, dict):
                self._identity = identity
                self._aid = identity.get("aid", self._aid)
                if self._session_params is not None:
                    self._session_params["access_token"] = auth_context.get("token", params.get("access_token"))
        else:
            await self._auth.initialize_with_token(self._transport, challenge, str(params["access_token"]))
            self._sync_identity_after_connect(str(params["access_token"]))
        self._state = "connected"
        await self._dispatcher.publish("connection.state", {"state": self._state, "gateway": gateway_url})
        self._start_background_tasks()

        # 上线后自动上传 prekey（失败时记录日志）
        try:
            await self._upload_prekey()
        except Exception as exc:
            _client_log.warning("prekey 上传失败: %s", exc)

    def _resolve_gateway(self, params: dict[str, Any]) -> str:
        topology = params.get("topology")
        if isinstance(topology, dict):
            mode = str(topology.get("mode") or "gateway")
            if mode == "peer":
                peer = str(topology.get("peer") or "")
                if not peer:
                    raise ValidationError("peer topology requires 'peer'")
                raise ValidationError("peer topology is not implemented in the Python SDK")
            if mode == "relay":
                relay = str(topology.get("relay") or "")
                target = str(topology.get("target") or "")
                if not relay or not target:
                    raise ValidationError("relay topology requires 'relay' and 'target'")
                raise ValidationError("relay topology is not implemented in the Python SDK")
        gateway = str(params.get("gateway") or "")
        if not gateway:
            raise StateError("missing gateway in connect params")
        return gateway

    @staticmethod
    def _is_internal_only_method(method: str) -> bool:
        return method in _INTERNAL_ONLY_METHODS

    # ── 内部：后台任务 ────────────────────────────────────

    def _start_background_tasks(self) -> None:
        self._start_heartbeat_task()
        self._start_token_refresh_task()
        self._start_prekey_refresh_task()
        self._start_group_epoch_tasks()

    async def _stop_background_tasks(self) -> None:
        for attr in ("_heartbeat_task", "_token_refresh_task", "_prekey_refresh_task",
                      "_group_epoch_rotate_task", "_group_epoch_cleanup_task"):
            task = getattr(self, attr, None)
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass  # 任务取消，正常清理
            setattr(self, attr, None)

    def _start_heartbeat_task(self) -> None:
        if self._heartbeat_task is not None and not self._heartbeat_task.done():
            return
        interval = float(self._session_options["heartbeat_interval"])
        if interval <= 0:
            return
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(interval))

    def _start_token_refresh_task(self) -> None:
        if self._token_refresh_task is not None and not self._token_refresh_task.done():
            return
        self._token_refresh_task = asyncio.create_task(self._token_refresh_loop())

    def _start_prekey_refresh_task(self) -> None:
        if self._prekey_refresh_task is not None and not self._prekey_refresh_task.done():
            return
        interval = float(self.config.get("prekey_refresh_interval", 3600))
        self._prekey_refresh_task = asyncio.create_task(self._prekey_refresh_loop(interval))

    async def _heartbeat_loop(self, interval: float) -> None:
        try:
            while not self._closing:
                await asyncio.sleep(interval)
                if self._state != "connected":
                    continue
                try:
                    await self._transport.call("meta.ping", {})
                except Exception as exc:
                    await self._dispatcher.publish("connection.error", {"error": exc})
        except asyncio.CancelledError:
            raise

    async def _token_refresh_loop(self) -> None:
        lead = float(self._session_options.get("token_refresh_before", 60.0))
        minimum_sleep = 1.0
        try:
            while not self._closing:
                if self._state != "connected" or not self._gateway_url:
                    await asyncio.sleep(minimum_sleep)
                    continue
                identity = self._identity or self._auth.load_identity_or_none()
                if identity is None:
                    await asyncio.sleep(minimum_sleep)
                    continue
                self._identity = identity
                expires_at = self._auth.get_access_token_expiry(identity)
                if expires_at is None:
                    await asyncio.sleep(minimum_sleep)
                    continue
                delay = max(expires_at - lead - time.time(), minimum_sleep)
                await asyncio.sleep(delay)
                if self._state != "connected" or not self._gateway_url:
                    continue
                try:
                    identity = await self._auth.refresh_cached_tokens(self._gateway_url, identity)
                    self._identity = identity
                    if self._session_params is not None and identity.get("access_token"):
                        self._session_params["access_token"] = identity["access_token"]
                    await self._dispatcher.publish("token.refreshed", {
                        "aid": identity.get("aid"),
                        "expires_at": identity.get("access_token_expires_at"),
                    })
                except AuthError as exc:
                    _client_log.debug("token 刷新失败，下次重试: %s", exc)
                    continue
                except Exception as exc:
                    await self._dispatcher.publish("connection.error", {"error": exc})
        except asyncio.CancelledError:
            raise

    async def _prekey_refresh_loop(self, interval: float) -> None:
        """定时轮换 prekey"""
        try:
            while not self._closing:
                await asyncio.sleep(interval)
                if self._state != "connected":
                    continue
                try:
                    await self._upload_prekey()
                except Exception as exc:
                    _client_log.warning("prekey 轮换失败: %s", exc)
        except asyncio.CancelledError:
            raise

    def _build_rotation_signature(self, group_id: str, current_epoch: int, new_epoch: int = 0) -> dict[str, str]:
        """构建 epoch 轮换签名参数。"""
        identity = self._identity
        if not identity or not identity.get("private_key_pem"):
            return {}
        try:
            from cryptography.hazmat.primitives.asymmetric import ec as _ec
            from cryptography.hazmat.primitives import hashes as _hashes, serialization as _ser
            aid = identity.get("aid", "")
            ts = str(int(time.time()))
            sign_data = f"{group_id}|{current_epoch}|{new_epoch}|{aid}|{ts}".encode("utf-8")
            pk = _ser.load_pem_private_key(
                identity["private_key_pem"].encode("utf-8"), password=None,
            )
            sig = pk.sign(sign_data, _ec.ECDSA(_hashes.SHA256()))
            return {
                "rotation_signature": base64.b64encode(sig).decode("ascii"),
                "rotation_timestamp": ts,
            }
        except Exception:
            return {}

    async def _sync_epoch_to_server(self, group_id: str) -> None:
        """建群后将本地 epoch 1 同步到服务端（服务端初始为 0）。"""
        try:
            rotate_params = {
                "group_id": group_id,
                "current_epoch": 0,
            }
            rotate_params.update(self._build_rotation_signature(group_id, 0, 1))
            await self.call("group.e2ee.rotate_epoch", rotate_params)
        except Exception as exc:
            _client_log.debug("同步 epoch 到服务端失败 (group=%s，可能已同步): %s", group_id, exc)

    async def _rotate_group_epoch(self, group_id: str) -> None:
        """为指定群组轮换 epoch 并分发新密钥。

        使用服务端 CAS 保证只有一方成功。
        服务端同时校验 owner/admin 角色。
        """
        try:
            # 1. 读取服务端当前 epoch
            epoch_result = await self.call("group.e2ee.get_epoch", {"group_id": group_id})
            current_epoch = epoch_result.get("epoch", 0)

            # 2. CAS 尝试递增（服务端校验角色 + 原子递增）
            rotate_params = {
                "group_id": group_id,
                "current_epoch": current_epoch,
            }
            rotate_params.update(self._build_rotation_signature(group_id, current_epoch, current_epoch + 1))
            cas_result = await self.call("group.e2ee.rotate_epoch", rotate_params)
            if not cas_result.get("success"):
                return  # CAS 失败（别人先轮换了或角色不符），放弃

            new_epoch = cas_result["epoch"]

            # 3. 获取最新成员列表
            members_result = await self.call("group.get_members", {"group_id": group_id})
            member_aids = [m["aid"] for m in members_result.get("members", [])]

            # 4. 本地生成密钥 + 存储 + 分发
            info = self._group_e2ee.rotate_epoch_to(group_id, new_epoch, member_aids)
            for dist in info["distributions"]:
                try:
                    await self.call("message.send", {
                        "to": dist["to"],
                        "payload": dist["payload"],
                        "encrypt": True,
                        "persist": False,
                    })
                except Exception as _exc:
                    import logging as _logging
                    _logging.getLogger("aun_core").debug("操作失败: %s", _exc)
        except Exception as exc:
            self._log_e2ee_error("rotate_epoch", group_id, "", exc)

    async def _distribute_key_to_new_member(self, group_id: str, new_member_aid: str) -> None:
        """将当前 group_secret 通过 P2P E2EE 分发给新成员。

        先拉服务端最新成员列表，更新本地 member_aids/commitment，构建签名 manifest，再分发。
        """
        try:
            secret_data = self._group_e2ee.load_secret(group_id)
            if secret_data is None:
                return

            # 拉服务端最新成员列表（确保一致性）
            members_result = await self.call("group.get_members", {"group_id": group_id})
            member_aids = [m["aid"] for m in members_result.get("members", [])]

            # 用最新成员列表更新本地当前 epoch 的 member_aids/commitment
            from .e2ee import (
                compute_membership_commitment, store_group_secret,
                build_key_distribution, build_membership_manifest, sign_membership_manifest,
            )
            epoch = secret_data["epoch"]
            commitment = compute_membership_commitment(member_aids, epoch, group_id, secret_data["secret"])
            store_group_secret(
                self._keystore, self._aid, group_id, epoch,
                secret_data["secret"], commitment, member_aids,
            )

            # 构建并签名 manifest
            manifest = build_membership_manifest(
                group_id=group_id,
                epoch=epoch,
                prev_epoch=epoch,
                member_aids=member_aids,
                added=[new_member_aid],
                removed=[],
                initiator_aid=self._aid or "",
            )
            identity = self._identity
            if identity and identity.get("private_key_pem"):
                manifest = sign_membership_manifest(manifest, identity["private_key_pem"])

            dist_payload = build_key_distribution(
                group_id, epoch, secret_data["secret"],
                member_aids, self._aid or "",
                manifest=manifest,
            )
            await self.call("message.send", {
                "to": new_member_aid,
                "payload": dist_payload,
                "encrypt": True,
                "persist": False,
            })
        except Exception as exc:
            self._log_e2ee_error("distribute_key", group_id, new_member_aid, exc)

    def _start_group_epoch_tasks(self) -> None:
        """启动群组 epoch 相关后台任务"""
        if not self._config_model.group_e2ee:
            return
        # 旧 epoch 清理（每小时检查一次）
        if self._group_epoch_cleanup_task is None or self._group_epoch_cleanup_task.done():
            self._group_epoch_cleanup_task = asyncio.create_task(
                self._group_epoch_cleanup_loop(3600.0)
            )
        # 定时 epoch 轮换
        rotate_interval = self._config_model.epoch_auto_rotate_interval
        if rotate_interval > 0:
            if self._group_epoch_rotate_task is None or self._group_epoch_rotate_task.done():
                self._group_epoch_rotate_task = asyncio.create_task(
                    self._group_epoch_rotate_loop(float(rotate_interval))
                )

    async def _group_epoch_rotate_loop(self, interval: float) -> None:
        """定时轮换所有已知群组的 epoch"""
        try:
            while not self._closing:
                await asyncio.sleep(interval)
                if self._state != "connected":
                    continue
                my_aid = self._aid
                if not my_aid:
                    continue
                try:
                    metadata = self._keystore.load_metadata(my_aid) or {}
                    group_secrets = metadata.get("group_secrets", {})
                    for gid in list(group_secrets.keys()):
                        await self._rotate_group_epoch(gid)
                except Exception as _exc:
                    import logging as _logging
                    _logging.getLogger("aun_core").debug("epoch 轮换失败: %s", _exc)
        except asyncio.CancelledError:
            raise

    async def _group_epoch_cleanup_loop(self, interval: float) -> None:
        """定时清理过期的旧 epoch 密钥"""
        try:
            while not self._closing:
                await asyncio.sleep(interval)
                if self._state != "connected":
                    continue
                my_aid = self._aid
                if not my_aid:
                    continue
                try:
                    metadata = self._keystore.load_metadata(my_aid) or {}
                    group_secrets = metadata.get("group_secrets", {})
                    retention = self._config_model.old_epoch_retention_seconds
                    for gid in list(group_secrets.keys()):
                        self._group_e2ee.cleanup(gid, retention)
                except Exception as _exc:
                    import logging as _logging
                    _logging.getLogger("aun_core").debug("epoch 轮换失败: %s", _exc)
        except asyncio.CancelledError:
            raise

    # ── 内部：断线重连 ────────────────────────────────────

    async def _handle_transport_disconnect(self, error: Exception | None) -> None:
        if self._closing or self._state == "closed":
            return
        self._state = "disconnected"
        await self._dispatcher.publish("connection.state", {"state": self._state, "error": error})
        if not bool(self._session_options["auto_reconnect"]):
            return
        if self._reconnect_task is not None and not self._reconnect_task.done():
            return
        self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def _reconnect_loop(self) -> None:
        retry = dict(self._session_options["retry"])
        initial_delay = float(retry.get("initial_delay", 0.5))
        max_delay = float(retry.get("max_delay", 30.0))
        delay = initial_delay
        attempt = 0

        while not self._closing:
            attempt += 1
            self._state = "reconnecting"
            await self._dispatcher.publish("connection.state", {
                "state": self._state,
                "attempt": attempt,
            })
            try:
                await asyncio.sleep(delay)
                await self._transport.close()
                await self._invoke_reconnect_connect_once()
                self._reconnect_task = None
                return
            except asyncio.CancelledError:
                self._reconnect_task = None
                raise
            except Exception as exc:
                await self._dispatcher.publish("connection.error", {
                    "error": exc,
                    "attempt": attempt,
                })
                if not self._should_retry_reconnect(exc):
                    self._state = "terminal_failed"
                    self._reconnect_task = None
                    await self._dispatcher.publish("connection.state", {
                        "state": self._state,
                        "error": exc,
                        "attempt": attempt,
                    })
                    return
                delay = min(delay * 2, max_delay)

    # ── 内部：参数处理 ────────────────────────────────────

    def _normalize_connect_params(self, params: dict[str, Any]) -> dict[str, Any]:
        request = dict(params)
        access_token = str(request.get("access_token") or "")
        if not access_token:
            raise StateError("connect requires non-empty access_token")
        gateway = str(request.get("gateway") or self._gateway_url or "")
        if not gateway:
            raise StateError("connect requires non-empty gateway")
        request["access_token"] = access_token
        request["gateway"] = gateway
        topology = request.get("topology")
        if topology is not None and not isinstance(topology, dict):
            raise ValidationError("topology must be a dict")
        if "retry" in request and not isinstance(request["retry"], dict):
            raise ValidationError("retry must be a dict")
        if "timeouts" in request and not isinstance(request["timeouts"], dict):
            raise ValidationError("timeouts must be a dict")
        return request

    def _build_session_options(self, params: dict[str, Any]) -> dict[str, Any]:
        options: dict[str, Any] = {
            "auto_reconnect": _DEFAULT_SESSION_OPTIONS["auto_reconnect"],
            "heartbeat_interval": _DEFAULT_SESSION_OPTIONS["heartbeat_interval"],
            "token_refresh_before": _DEFAULT_SESSION_OPTIONS["token_refresh_before"],
            "retry": dict(_DEFAULT_SESSION_OPTIONS["retry"]),
            "timeouts": dict(_DEFAULT_SESSION_OPTIONS["timeouts"]),
        }
        if "auto_reconnect" in params:
            options["auto_reconnect"] = bool(params["auto_reconnect"])
        if "heartbeat_interval" in params:
            options["heartbeat_interval"] = float(params["heartbeat_interval"])
        if "token_refresh_before" in params:
            options["token_refresh_before"] = float(params["token_refresh_before"])
        if "retry" in params:
            options["retry"].update(params["retry"])
        if "timeouts" in params:
            options["timeouts"].update(params["timeouts"])
        return options

    def _sync_identity_after_connect(self, access_token: str) -> None:
        identity = self._auth.load_identity_or_none(self._aid)
        if identity is None:
            self._identity = None
            return
        identity["access_token"] = access_token
        self._identity = identity
        self._aid = identity.get("aid", self._aid)
        self._auth._keystore.save_identity(identity["aid"], identity)

    async def _invoke_reconnect_connect_once(self) -> None:
        if self._session_params is None:
            raise StateError("missing connect params for reconnect")
        await self._connect_once(self._session_params, allow_reauth=True)

    @staticmethod
    def _should_retry_reconnect(error: Exception) -> bool:
        if isinstance(error, (AuthError, AUNPermissionError, ValidationError, StateError)):
            return False
        if isinstance(error, ConnectionError):
            return True
        if isinstance(error, AUNError):
            return bool(error.retryable)
        if isinstance(error, (TimeoutError, OSError, ConnectionResetError, websockets.ConnectionClosed)):
            return True
        return True
