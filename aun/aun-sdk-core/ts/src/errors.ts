/**
 * AUN SDK 错误层级体系
 *
 * 与 Python SDK 完全对齐，覆盖所有错误类型和远程错误映射逻辑。
 */

// ── 基础错误 ──────────────────────────────────────────────────

export class AUNError extends Error {
  /** JSON-RPC 错误码 */
  readonly code: number;
  /** 附加数据 */
  readonly data: unknown;
  /** 是否可重试 */
  readonly retryable: boolean;
  /** 链路追踪 ID */
  readonly traceId: string | undefined;

  constructor(
    message: string,
    opts: {
      code?: number;
      data?: unknown;
      retryable?: boolean;
      traceId?: string;
    } = {},
  ) {
    super(message);
    this.name = 'AUNError';
    this.code = opts.code ?? -1;
    this.data = opts.data;
    this.retryable = opts.retryable ?? false;
    this.traceId = opts.traceId;
  }
}

// ── 通用错误子类 ──────────────────────────────────────────────

export class ConnectionError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'ConnectionError';
  }
}

export class TimeoutError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'TimeoutError';
  }
}

export class AuthError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'AuthError';
  }
}

export class PermissionError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'PermissionError';
  }
}

export class ValidationError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'NotFoundError';
  }
}

export class RateLimitError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'RateLimitError';
  }
}

export class StateError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'StateError';
  }
}

export class SerializationError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'SerializationError';
  }
}

export class SessionError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'SessionError';
  }
}

// ── 群组错误 ──────────────────────────────────────────────────

export class GroupError extends AUNError {
  constructor(message: string, opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'GroupError';
  }
}

export class GroupNotFoundError extends GroupError {
  constructor(message: string = 'group not found', opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'GroupNotFoundError';
  }
}

export class GroupStateError extends GroupError {
  constructor(message: string = 'group state error', opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, opts);
    this.name = 'GroupStateError';
  }
}

// ── E2EE 错误 ─────────────────────────────────────────────────

export class E2EEError extends AUNError {
  /** 本地错误码 */
  readonly localCode: string;
  /** WebSocket 关闭原因 */
  readonly closeReason: string | undefined;

  constructor(
    message: string,
    opts: ConstructorParameters<typeof AUNError>[1] & {
      localCode?: string;
      closeReason?: string;
    } = {},
  ) {
    super(message, opts);
    this.name = 'E2EEError';
    this.localCode = opts.localCode ?? 'E2EE_ERROR';
    this.closeReason = opts.closeReason;
  }
}

export class E2EEDecryptFailedError extends E2EEError {
  constructor(message: string = 'e2ee decrypt failed', opts: ConstructorParameters<typeof E2EEError>[1] = {}) {
    super(message, {
      ...opts,
      localCode: 'E2EE_DECRYPT_FAILED',
      closeReason: 'decrypt_failed',
    });
    this.name = 'E2EEDecryptFailedError';
  }
}

// ── 群组 E2EE 错误 ────────────────────────────────────────────

/** 缺少该群的 group_secret */
export class E2EEGroupSecretMissingError extends E2EEError {
  constructor(message: string = 'group secret missing', opts: ConstructorParameters<typeof E2EEError>[1] = {}) {
    super(message, { ...opts, code: -32040, localCode: 'E2EE_GROUP_SECRET_MISSING' });
    this.name = 'E2EEGroupSecretMissingError';
  }
}

/** 消息 epoch 与本地不匹配 */
export class E2EEGroupEpochMismatchError extends E2EEError {
  constructor(message: string = 'group epoch mismatch', opts: ConstructorParameters<typeof E2EEError>[1] = {}) {
    super(message, { ...opts, code: -32041, localCode: 'E2EE_GROUP_EPOCH_MISMATCH' });
    this.name = 'E2EEGroupEpochMismatchError';
  }
}

/** Membership Commitment 验证失败 */
export class E2EEGroupCommitmentInvalidError extends E2EEError {
  constructor(message: string = 'group commitment invalid', opts: ConstructorParameters<typeof E2EEError>[1] = {}) {
    super(message, { ...opts, code: -32042, localCode: 'E2EE_GROUP_COMMITMENT_INVALID' });
    this.name = 'E2EEGroupCommitmentInvalidError';
  }
}

/** 密钥请求者不是群成员 */
export class E2EEGroupNotMemberError extends E2EEError {
  constructor(message: string = 'not a group member', opts: ConstructorParameters<typeof E2EEError>[1] = {}) {
    super(message, { ...opts, code: -32043, localCode: 'E2EE_GROUP_NOT_MEMBER' });
    this.name = 'E2EEGroupNotMemberError';
  }
}

/** 群消息解密失败 */
export class E2EEGroupDecryptFailedError extends E2EEError {
  constructor(message: string = 'group message decrypt failed', opts: ConstructorParameters<typeof E2EEError>[1] = {}) {
    super(message, { ...opts, code: -32044, localCode: 'E2EE_GROUP_DECRYPT_FAILED' });
    this.name = 'E2EEGroupDecryptFailedError';
  }
}

/** 对端证书已被吊销 */
export class CertificateRevokedError extends AuthError {
  constructor(message: string = 'peer certificate has been revoked', opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, { ...opts, code: -32050 });
    this.name = 'CertificateRevokedError';
  }
}

/** E2EE 降级（无前向保密） */
export class E2EEDegradedError extends E2EEError {
  constructor(message: string = 'e2ee degraded: no forward secrecy', opts: ConstructorParameters<typeof E2EEError>[1] = {}) {
    super(message, { ...opts, localCode: 'E2EE_DEGRADED' });
    this.name = 'E2EEDegradedError';
  }
}

/** 客户端操作签名验证失败 */
export class ClientSignatureError extends ValidationError {
  constructor(message: string = 'client signature verification failed', opts: ConstructorParameters<typeof AUNError>[1] = {}) {
    super(message, { ...opts, code: -32051 });
    this.name = 'ClientSignatureError';
  }
}

// ── 远程错误映射 ──────────────────────────────────────────────

/**
 * 将 JSON-RPC error 对象映射为具体的 AUNError 子类。
 * 与 Python SDK 的 map_remote_error 逻辑完全一致。
 */
export function mapRemoteError(error: { code?: number; message?: string; data?: unknown }): AUNError {
  const code = Number(error.code ?? -32603);
  const message = String(error.message ?? 'remote error');
  const data = error.data;

  let traceId: string | undefined;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    traceId = (d.trace_id ?? d.traceId) as string | undefined;
  }

  // 认证错误
  const AUTH_CODES = new Set([4001, 4010, -32003]);
  const PERMISSION_CODES = new Set([4030, 403]);
  const NOT_FOUND_CODES = new Set([4040, 404, -32004]);
  const RATE_LIMIT_CODES = new Set([4290, 429, -32029]);
  const SESSION_CODES = new Set([-32010, -32011, -32013]);
  const VALIDATION_CODES = new Set([-32600, -32601, -32602, 4000]);

  const opts = { code, data, traceId, retryable: false };

  let err: AUNError;

  if (AUTH_CODES.has(code)) {
    err = new AuthError(message, opts);
  } else if (PERMISSION_CODES.has(code)) {
    err = new PermissionError(message, opts);
  } else if (NOT_FOUND_CODES.has(code)) {
    err = new NotFoundError(message, opts);
  } else if (RATE_LIMIT_CODES.has(code)) {
    err = new RateLimitError(message, { ...opts, retryable: true });
  } else if (SESSION_CODES.has(code)) {
    err = new SessionError(message, opts);
  } else if (VALIDATION_CODES.has(code)) {
    err = new ValidationError(message, opts);
  } else if (code === -33001) {
    err = new GroupNotFoundError(message, opts);
  } else if (code === -33002 || code === -33003) {
    err = new GroupStateError(message, opts);
  } else if (code >= -33009 && code <= -33004) {
    err = new GroupError(message, opts);
  } else {
    // 5000-5999 范围的服务端错误可重试
    const retryable = code >= 5000 && code < 6000;
    err = new AUNError(message, { ...opts, retryable });
  }

  return err;
}
