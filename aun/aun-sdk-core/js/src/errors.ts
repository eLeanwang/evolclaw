// ── AUN 协议错误层级 ──────────────────────────────────────

/** AUN 基础错误类型 */
export class AUNError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly retryable: boolean;
  readonly traceId: string | null;

  constructor(
    message: string,
    opts?: {
      code?: number;
      data?: unknown;
      retryable?: boolean;
      traceId?: string | null;
    },
  ) {
    super(message);
    this.name = 'AUNError';
    this.code = opts?.code ?? -1;
    this.data = opts?.data ?? null;
    this.retryable = opts?.retryable ?? false;
    this.traceId = opts?.traceId ?? null;
  }
}

/** 连接错误 */
export class ConnectionError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'ConnectionError';
  }
}

/** 超时错误 */
export class TimeoutError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'TimeoutError';
  }
}

/** 认证错误 */
export class AuthError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'AuthError';
  }
}

/** 权限错误 */
export class PermissionError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'PermissionError';
  }
}

/** 参数校验错误 */
export class ValidationError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'ValidationError';
  }
}

/** 资源不存在 */
export class NotFoundError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'NotFoundError';
  }
}

/** 限流错误 */
export class RateLimitError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'RateLimitError';
  }
}

/** 状态错误 */
export class StateError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'StateError';
  }
}

/** 序列化错误 */
export class SerializationError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'SerializationError';
  }
}

/** 会话错误 */
export class SessionError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'SessionError';
  }
}

/** 群组错误 */
export class GroupError extends AUNError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'GroupError';
  }
}

/** 群组不存在 */
export class GroupNotFoundError extends GroupError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'GroupNotFoundError';
  }
}

/** 群组状态错误 */
export class GroupStateError extends GroupError {
  constructor(message: string, opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, opts);
    this.name = 'GroupStateError';
  }
}

// ── E2EE 错误 ──────────────────────────────────────────

/** E2EE 基础错误 */
export class E2EEError extends AUNError {
  readonly localCode: string;
  readonly closeReason: string | null;

  constructor(
    message: string,
    opts?: ConstructorParameters<typeof AUNError>[1] & {
      localCode?: string;
      closeReason?: string | null;
    },
  ) {
    super(message, opts);
    this.name = 'E2EEError';
    this.localCode = opts?.localCode ?? 'E2EE_ERROR';
    this.closeReason = opts?.closeReason ?? null;
  }
}

/** E2EE 解密失败 */
export class E2EEDecryptFailedError extends E2EEError {
  constructor(message = 'e2ee decrypt failed', opts?: ConstructorParameters<typeof E2EEError>[1]) {
    super(message, {
      ...opts,
      localCode: 'E2EE_DECRYPT_FAILED',
      closeReason: 'decrypt_failed',
    });
    this.name = 'E2EEDecryptFailedError';
  }
}

/** 缺少群组密钥 */
export class E2EEGroupSecretMissingError extends E2EEError {
  constructor(message = 'group secret missing', opts?: ConstructorParameters<typeof E2EEError>[1]) {
    super(message, { ...opts, code: -32040, localCode: 'E2EE_GROUP_SECRET_MISSING' });
    this.name = 'E2EEGroupSecretMissingError';
  }
}

/** 群组 epoch 不匹配 */
export class E2EEGroupEpochMismatchError extends E2EEError {
  constructor(message = 'group epoch mismatch', opts?: ConstructorParameters<typeof E2EEError>[1]) {
    super(message, { ...opts, code: -32041, localCode: 'E2EE_GROUP_EPOCH_MISMATCH' });
    this.name = 'E2EEGroupEpochMismatchError';
  }
}

/** 成员 Commitment 验证失败 */
export class E2EEGroupCommitmentInvalidError extends E2EEError {
  constructor(message = 'group commitment invalid', opts?: ConstructorParameters<typeof E2EEError>[1]) {
    super(message, { ...opts, code: -32042, localCode: 'E2EE_GROUP_COMMITMENT_INVALID' });
    this.name = 'E2EEGroupCommitmentInvalidError';
  }
}

/** 请求者不是群成员 */
export class E2EEGroupNotMemberError extends E2EEError {
  constructor(message = 'not a group member', opts?: ConstructorParameters<typeof E2EEError>[1]) {
    super(message, { ...opts, code: -32043, localCode: 'E2EE_GROUP_NOT_MEMBER' });
    this.name = 'E2EEGroupNotMemberError';
  }
}

/** 群消息解密失败 */
export class E2EEGroupDecryptFailedError extends E2EEError {
  constructor(message = 'group message decrypt failed', opts?: ConstructorParameters<typeof E2EEError>[1]) {
    super(message, { ...opts, code: -32044, localCode: 'E2EE_GROUP_DECRYPT_FAILED' });
    this.name = 'E2EEGroupDecryptFailedError';
  }
}

/** 对端证书已被吊销 */
export class CertificateRevokedError extends AuthError {
  constructor(message = 'peer certificate has been revoked', opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, { ...opts, code: -32050 });
    this.name = 'CertificateRevokedError';
  }
}

/** E2EE 降级（无前向保密） */
export class E2EEDegradedError extends E2EEError {
  constructor(message = 'e2ee degraded: no forward secrecy', opts?: ConstructorParameters<typeof E2EEError>[1]) {
    super(message, { ...opts, localCode: 'E2EE_DEGRADED' });
    this.name = 'E2EEDegradedError';
  }
}

/** 客户端操作签名验证失败 */
export class ClientSignatureError extends ValidationError {
  constructor(message = 'client signature verification failed', opts?: ConstructorParameters<typeof AUNError>[1]) {
    super(message, { ...opts, code: -32051 });
    this.name = 'ClientSignatureError';
  }
}

// ── 远端错误映射 ──────────────────────────────────────────

/** 将服务端返回的 JSON-RPC error 对象映射为 SDK 错误类型 */
export function mapRemoteError(error: Record<string, unknown>): AUNError {
  const code = Number(error.code ?? -32603);
  const message = String(error.message ?? 'remote error');
  const data = error.data as Record<string, unknown> | undefined;
  const traceId = (data?.trace_id ?? data?.traceId ?? null) as string | null;

  let Cls: typeof AUNError;

  if ([4001, 4010, -32003].includes(code)) {
    Cls = AuthError;
  } else if ([4030, 403].includes(code)) {
    Cls = PermissionError;
  } else if ([4040, 404, -32004].includes(code)) {
    Cls = NotFoundError;
  } else if ([4290, 429, -32029].includes(code)) {
    Cls = RateLimitError;
  } else if ([-32010, -32011, -32013].includes(code)) {
    Cls = SessionError;
  } else if ([-32600, -32601, -32602, 4000].includes(code)) {
    Cls = ValidationError;
  } else if (code === -33001) {
    Cls = GroupNotFoundError;
  } else if ([-33002, -33003].includes(code)) {
    Cls = GroupStateError;
  } else if (code >= -33009 && code <= -33004) {
    Cls = GroupError;
  } else {
    Cls = AUNError;
  }

  const retryable = Cls === RateLimitError || (code >= 5000 && code < 6000);
  return new Cls(message, { code, data, retryable, traceId });
}
