from __future__ import annotations

from typing import Any


class AUNError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: int = -1,
        data: Any = None,
        retryable: bool = False,
        trace_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.data = data
        self.retryable = retryable
        self.trace_id = trace_id


class ConnectionError(AUNError):
    pass


class TimeoutError(AUNError):
    pass


class AuthError(AUNError):
    pass


class PermissionError(AUNError):
    pass


class ValidationError(AUNError):
    pass


class NotFoundError(AUNError):
    pass


class RateLimitError(AUNError):
    pass


class StateError(AUNError):
    pass


class SerializationError(AUNError):
    pass


class SessionError(AUNError):
    pass


class GroupError(AUNError):
    pass


class GroupNotFoundError(GroupError):
    pass


class GroupStateError(GroupError):
    pass


class E2EEError(AUNError):
    def __init__(
        self,
        message: str,
        *,
        local_code: str = "E2EE_ERROR",
        close_reason: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(message, **kwargs)
        self.local_code = local_code
        self.close_reason = close_reason


class E2EEDecryptFailedError(E2EEError):
    def __init__(self, message: str = "e2ee decrypt failed", **kwargs: Any) -> None:
        super().__init__(
            message,
            local_code="E2EE_DECRYPT_FAILED",
            close_reason="decrypt_failed",
            **kwargs,
        )


# ── 群组 E2EE 错误 ──────────────────────────────────────────

class E2EEGroupSecretMissingError(E2EEError):
    """缺少该群的 group_secret"""
    def __init__(self, message: str = "group secret missing", **kwargs: Any) -> None:
        super().__init__(message, code=-32040, local_code="E2EE_GROUP_SECRET_MISSING", **kwargs)


class E2EEGroupEpochMismatchError(E2EEError):
    """消息 epoch 与本地不匹配"""
    def __init__(self, message: str = "group epoch mismatch", **kwargs: Any) -> None:
        super().__init__(message, code=-32041, local_code="E2EE_GROUP_EPOCH_MISMATCH", **kwargs)


class E2EEGroupCommitmentInvalidError(E2EEError):
    """Membership Commitment 验证失败"""
    def __init__(self, message: str = "group commitment invalid", **kwargs: Any) -> None:
        super().__init__(message, code=-32042, local_code="E2EE_GROUP_COMMITMENT_INVALID", **kwargs)


class E2EEGroupNotMemberError(E2EEError):
    """密钥请求者不是群成员"""
    def __init__(self, message: str = "not a group member", **kwargs: Any) -> None:
        super().__init__(message, code=-32043, local_code="E2EE_GROUP_NOT_MEMBER", **kwargs)


class E2EEGroupDecryptFailedError(E2EEError):
    """群消息解密失败"""
    def __init__(self, message: str = "group message decrypt failed", **kwargs: Any) -> None:
        super().__init__(message, code=-32044, local_code="E2EE_GROUP_DECRYPT_FAILED", **kwargs)


class CertificateRevokedError(AuthError):
    """对端证书已被吊销"""
    def __init__(self, message: str = "peer certificate has been revoked", **kwargs: Any) -> None:
        super().__init__(message, code=-32050, **kwargs)


class E2EEDegradedError(E2EEError):
    """E2EE 降级（无前向保密）"""
    def __init__(self, message: str = "e2ee degraded: no forward secrecy", **kwargs: Any) -> None:
        super().__init__(message, local_code="E2EE_DEGRADED", **kwargs)


class ClientSignatureError(ValidationError):
    """客户端操作签名验证失败"""
    def __init__(self, message: str = "client signature verification failed", **kwargs: Any) -> None:
        super().__init__(message, code=-32051, **kwargs)


def map_remote_error(error: dict[str, Any]) -> AUNError:
    code = int(error.get("code", -32603))
    message = str(error.get("message", "remote error"))
    data = error.get("data")
    trace_id = None
    if isinstance(data, dict):
        trace_id = data.get("trace_id") or data.get("traceId")

    if code in {4001, 4010, -32003}:
        cls = AuthError
    elif code in {4030, 403}:
        cls = PermissionError
    elif code in {4040, 404, -32004}:
        cls = NotFoundError
    elif code in {4290, 429, -32029}:
        cls = RateLimitError
    elif code in {-32010, -32011, -32013}:
        cls = SessionError
    elif code in {-32600, -32601, -32602, 4000}:
        cls = ValidationError
    elif code == -33001:
        cls = GroupNotFoundError
    elif code in {-33002, -33003}:
        cls = GroupStateError
    elif -33009 <= code <= -33004:
        cls = GroupError
    else:
        cls = AUNError

    retryable = cls is RateLimitError or (5000 <= code < 6000)
    return cls(message, code=code, data=data, retryable=retryable, trace_id=trace_id)
