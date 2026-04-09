package aun

import "fmt"

// ── AUN 错误层次 ──────────────────────────────────────────
// 与 Python SDK errors.py 完全对应，提供结构化错误码、重试标记和链路追踪。

// AUNError 基础错误，所有 AUN 错误的根类型
type AUNError struct {
	Message   string // 错误描述
	Code      int    // JSON-RPC 错误码
	Data      any    // 附加数据
	Retryable bool   // 是否可重试
	TraceID   string // 链路追踪 ID
}

func (e *AUNError) Error() string {
	if e.Code != 0 && e.Code != -1 {
		return fmt.Sprintf("[%d] %s", e.Code, e.Message)
	}
	return e.Message
}

// NewAUNError 创建基础 AUN 错误
func NewAUNError(message string, opts ...ErrorOption) *AUNError {
	e := &AUNError{Message: message, Code: -1}
	for _, opt := range opts {
		opt(e)
	}
	return e
}

// ErrorOption 错误构建选项
type ErrorOption func(*AUNError)

// WithCode 设置错误码
func WithCode(code int) ErrorOption {
	return func(e *AUNError) { e.Code = code }
}

// WithData 设置附加数据
func WithData(data any) ErrorOption {
	return func(e *AUNError) { e.Data = data }
}

// WithRetryable 设置可重试标记
func WithRetryable(retryable bool) ErrorOption {
	return func(e *AUNError) { e.Retryable = retryable }
}

// WithTraceID 设置链路追踪 ID
func WithTraceID(traceID string) ErrorOption {
	return func(e *AUNError) { e.TraceID = traceID }
}

// ── 子类型错误 ─────────────────────────────────────────────

// ConnectionError 连接错误
type ConnectionError struct{ AUNError }

// TimeoutError 超时错误（默认可重试）
type TimeoutError struct{ AUNError }

// AuthError 认证错误
type AuthError struct{ AUNError }

// PermissionError 权限错误
type PermissionError struct{ AUNError }

// ValidationError 参数校验错误
type ValidationError struct{ AUNError }

// NotFoundError 资源不存在错误
type NotFoundError struct{ AUNError }

// RateLimitError 限流错误
type RateLimitError struct{ AUNError }

// StateError 状态错误
type StateError struct{ AUNError }

// SerializationError 序列化错误
type SerializationError struct{ AUNError }

// SessionError 会话错误
type SessionError struct{ AUNError }

// GroupError 群组错误
type GroupError struct{ AUNError }

// GroupNotFoundError 群组不存在错误
type GroupNotFoundError struct{ GroupError }

// GroupStateError 群组状态错误
type GroupStateError struct{ GroupError }

// ── E2EE 错误 ──────────────────────────────────────────────

// E2EEError 端到端加密错误基类
type E2EEError struct {
	AUNError
	LocalCode   string // 本地错误代码
	CloseReason string // 关闭原因
}

// E2EEDecryptFailedError 解密失败
type E2EEDecryptFailedError struct{ E2EEError }

// E2EEGroupSecretMissingError 缺少群组密钥（code=-32040）
type E2EEGroupSecretMissingError struct{ E2EEError }

// E2EEGroupEpochMismatchError 消息 epoch 与本地不匹配（code=-32041）
type E2EEGroupEpochMismatchError struct{ E2EEError }

// E2EEGroupCommitmentInvalidError Membership Commitment 验证失败（code=-32042）
type E2EEGroupCommitmentInvalidError struct{ E2EEError }

// E2EEGroupNotMemberError 密钥请求者不是群成员（code=-32043）
type E2EEGroupNotMemberError struct{ E2EEError }

// E2EEGroupDecryptFailedError 群消息解密失败（code=-32044）
type E2EEGroupDecryptFailedError struct{ E2EEError }

// CertificateRevokedError 对端证书已被吊销（code=-32050，嵌入 AuthError）
type CertificateRevokedError struct{ AuthError }

// E2EEDegradedError E2EE 降级（无前向保密）
type E2EEDegradedError struct{ E2EEError }

// ClientSignatureError 客户端操作签名验证失败（code=-32051，嵌入 ValidationError）
type ClientSignatureError struct{ ValidationError }

// ── 错误构造辅助函数 ───────────────────────────────────────

// NewConnectionError 创建连接错误
func NewConnectionError(msg string, opts ...ErrorOption) *ConnectionError {
	e := &ConnectionError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewTimeoutError 创建超时错误（默认可重试）
func NewTimeoutError(msg string, opts ...ErrorOption) *TimeoutError {
	e := &TimeoutError{AUNError{Message: msg, Code: -1, Retryable: true}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewAuthError 创建认证错误
func NewAuthError(msg string, opts ...ErrorOption) *AuthError {
	e := &AuthError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewPermissionError 创建权限错误
func NewPermissionError(msg string, opts ...ErrorOption) *PermissionError {
	e := &PermissionError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewValidationError 创建参数校验错误
func NewValidationError(msg string, opts ...ErrorOption) *ValidationError {
	e := &ValidationError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewNotFoundError 创建资源不存在错误
func NewNotFoundError(msg string, opts ...ErrorOption) *NotFoundError {
	e := &NotFoundError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewRateLimitError 创建限流错误
func NewRateLimitError(msg string, opts ...ErrorOption) *RateLimitError {
	e := &RateLimitError{AUNError{Message: msg, Code: -1, Retryable: true}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewStateError 创建状态错误
func NewStateError(msg string, opts ...ErrorOption) *StateError {
	e := &StateError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewSerializationError 创建序列化错误
func NewSerializationError(msg string, opts ...ErrorOption) *SerializationError {
	e := &SerializationError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewSessionError 创建会话错误
func NewSessionError(msg string, opts ...ErrorOption) *SessionError {
	e := &SessionError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewGroupError 创建群组错误
func NewGroupError(msg string, opts ...ErrorOption) *GroupError {
	e := &GroupError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewGroupNotFoundError 创建群组不存在错误
func NewGroupNotFoundError(msg string, opts ...ErrorOption) *GroupNotFoundError {
	base := &GroupError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&base.AUNError)
	}
	return &GroupNotFoundError{*base}
}

// NewGroupStateError 创建群组状态错误
func NewGroupStateError(msg string, opts ...ErrorOption) *GroupStateError {
	base := &GroupError{AUNError{Message: msg, Code: -1}}
	for _, opt := range opts {
		opt(&base.AUNError)
	}
	return &GroupStateError{*base}
}

// NewE2EEError 创建 E2EE 错误
func NewE2EEError(msg string, localCode string, opts ...ErrorOption) *E2EEError {
	e := &E2EEError{
		AUNError:  AUNError{Message: msg, Code: -1},
		LocalCode: localCode,
	}
	for _, opt := range opts {
		opt(&e.AUNError)
	}
	return e
}

// NewE2EEDecryptFailedError 创建解密失败错误
func NewE2EEDecryptFailedError(msg string) *E2EEDecryptFailedError {
	if msg == "" {
		msg = "e2ee decrypt failed"
	}
	return &E2EEDecryptFailedError{E2EEError{
		AUNError:    AUNError{Message: msg, Code: -1},
		LocalCode:   "E2EE_DECRYPT_FAILED",
		CloseReason: "decrypt_failed",
	}}
}

// NewE2EEGroupSecretMissingError 创建群组密钥缺失错误
func NewE2EEGroupSecretMissingError(msg string) *E2EEGroupSecretMissingError {
	if msg == "" {
		msg = "group secret missing"
	}
	return &E2EEGroupSecretMissingError{E2EEError{
		AUNError:  AUNError{Message: msg, Code: -32040},
		LocalCode: "E2EE_GROUP_SECRET_MISSING",
	}}
}

// NewE2EEGroupEpochMismatchError 创建 epoch 不匹配错误
func NewE2EEGroupEpochMismatchError(msg string) *E2EEGroupEpochMismatchError {
	if msg == "" {
		msg = "group epoch mismatch"
	}
	return &E2EEGroupEpochMismatchError{E2EEError{
		AUNError:  AUNError{Message: msg, Code: -32041},
		LocalCode: "E2EE_GROUP_EPOCH_MISMATCH",
	}}
}

// NewE2EEGroupCommitmentInvalidError 创建 Membership Commitment 验证失败错误
func NewE2EEGroupCommitmentInvalidError(msg string) *E2EEGroupCommitmentInvalidError {
	if msg == "" {
		msg = "group commitment invalid"
	}
	return &E2EEGroupCommitmentInvalidError{E2EEError{
		AUNError:  AUNError{Message: msg, Code: -32042},
		LocalCode: "E2EE_GROUP_COMMITMENT_INVALID",
	}}
}

// NewE2EEGroupNotMemberError 创建非群成员错误
func NewE2EEGroupNotMemberError(msg string) *E2EEGroupNotMemberError {
	if msg == "" {
		msg = "not a group member"
	}
	return &E2EEGroupNotMemberError{E2EEError{
		AUNError:  AUNError{Message: msg, Code: -32043},
		LocalCode: "E2EE_GROUP_NOT_MEMBER",
	}}
}

// NewE2EEGroupDecryptFailedError 创建群消息解密失败错误
func NewE2EEGroupDecryptFailedError(msg string) *E2EEGroupDecryptFailedError {
	if msg == "" {
		msg = "group message decrypt failed"
	}
	return &E2EEGroupDecryptFailedError{E2EEError{
		AUNError:  AUNError{Message: msg, Code: -32044},
		LocalCode: "E2EE_GROUP_DECRYPT_FAILED",
	}}
}

// NewCertificateRevokedError 创建证书吊销错误
func NewCertificateRevokedError(msg string) *CertificateRevokedError {
	if msg == "" {
		msg = "peer certificate has been revoked"
	}
	return &CertificateRevokedError{AuthError{AUNError{Message: msg, Code: -32050}}}
}

// NewE2EEDegradedError 创建 E2EE 降级错误
func NewE2EEDegradedError(msg string) *E2EEDegradedError {
	if msg == "" {
		msg = "e2ee degraded: no forward secrecy"
	}
	return &E2EEDegradedError{E2EEError{
		AUNError:  AUNError{Message: msg, Code: -1},
		LocalCode: "E2EE_DEGRADED",
	}}
}

// NewClientSignatureError 创建客户端签名验证失败错误
func NewClientSignatureError(msg string) *ClientSignatureError {
	if msg == "" {
		msg = "client signature verification failed"
	}
	return &ClientSignatureError{ValidationError{AUNError{Message: msg, Code: -32051}}}
}

// ── 远程错误映射 ───────────────────────────────────────────

// MapRemoteError 将 JSON-RPC 错误字典映射为类型化错误
// 错误码映射规则与 Python SDK 完全一致
func MapRemoteError(errMap map[string]any) error {
	code := -32603
	if c, ok := errMap["code"]; ok {
		switch v := c.(type) {
		case float64:
			code = int(v)
		case int:
			code = v
		}
	}

	message := "remote error"
	if m, ok := errMap["message"]; ok {
		if s, ok := m.(string); ok {
			message = s
		}
	}

	data, _ := errMap["data"]
	traceID := ""
	if dataMap, ok := data.(map[string]any); ok {
		if tid, ok := dataMap["trace_id"]; ok {
			if s, ok := tid.(string); ok {
				traceID = s
			}
		}
		if traceID == "" {
			if tid, ok := dataMap["traceId"]; ok {
				if s, ok := tid.(string); ok {
					traceID = s
				}
			}
		}
	}

	// 根据错误码判断是否可重试
	retryable := false

	// 按错误码创建对应类型的错误
	switch {
	case code == 4001 || code == 4010 || code == -32003:
		return &AuthError{AUNError{Message: message, Code: code, Data: data, Retryable: false, TraceID: traceID}}

	case code == 4030 || code == 403:
		return &PermissionError{AUNError{Message: message, Code: code, Data: data, Retryable: false, TraceID: traceID}}

	case code == 4040 || code == 404 || code == -32004:
		return &NotFoundError{AUNError{Message: message, Code: code, Data: data, Retryable: false, TraceID: traceID}}

	case code == 4290 || code == 429 || code == -32029:
		return &RateLimitError{AUNError{Message: message, Code: code, Data: data, Retryable: true, TraceID: traceID}}

	case code == -32010 || code == -32011 || code == -32013:
		return &SessionError{AUNError{Message: message, Code: code, Data: data, Retryable: false, TraceID: traceID}}

	case code == -32600 || code == -32601 || code == -32602 || code == 4000:
		return &ValidationError{AUNError{Message: message, Code: code, Data: data, Retryable: false, TraceID: traceID}}

	case code == -33001:
		base := &GroupError{AUNError{Message: message, Code: code, Data: data, Retryable: false, TraceID: traceID}}
		return &GroupNotFoundError{*base}

	case code == -33002 || code == -33003:
		base := &GroupError{AUNError{Message: message, Code: code, Data: data, Retryable: false, TraceID: traceID}}
		return &GroupStateError{*base}

	case code >= -33009 && code <= -33004:
		return &GroupError{AUNError{Message: message, Code: code, Data: data, Retryable: false, TraceID: traceID}}

	default:
		// 5000 <= code < 6000 为可重试的服务端错误
		if code >= 5000 && code < 6000 {
			retryable = true
		}
		return &AUNError{Message: message, Code: code, Data: data, Retryable: retryable, TraceID: traceID}
	}
}
