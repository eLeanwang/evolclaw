package aun

import (
	"testing"
)

// TestMapRemoteError_AuthCodes 验证认证错误码映射
func TestMapRemoteError_AuthCodes(t *testing.T) {
	for _, code := range []int{4001, 4010, -32003} {
		err := MapRemoteError(map[string]any{"code": code, "message": "auth err"})
		if _, ok := err.(*AuthError); !ok {
			t.Errorf("code=%d 应映射为 AuthError, 实际: %T", code, err)
		}
		if ae, ok := err.(*AuthError); ok && ae.Retryable {
			t.Errorf("code=%d AuthError 不应可重试", code)
		}
	}
}

// TestMapRemoteError_PermissionCodes 验证权限错误码映射
func TestMapRemoteError_PermissionCodes(t *testing.T) {
	for _, code := range []int{4030, 403} {
		err := MapRemoteError(map[string]any{"code": code, "message": "perm err"})
		if _, ok := err.(*PermissionError); !ok {
			t.Errorf("code=%d 应映射为 PermissionError, 实际: %T", code, err)
		}
	}
}

// TestMapRemoteError_NotFoundCodes 验证资源不存在错误码映射
func TestMapRemoteError_NotFoundCodes(t *testing.T) {
	for _, code := range []int{4040, 404, -32004} {
		err := MapRemoteError(map[string]any{"code": code, "message": "not found"})
		if _, ok := err.(*NotFoundError); !ok {
			t.Errorf("code=%d 应映射为 NotFoundError, 实际: %T", code, err)
		}
	}
}

// TestMapRemoteError_RateLimitCodes 验证限流错误码映射（retryable=true）
func TestMapRemoteError_RateLimitCodes(t *testing.T) {
	for _, code := range []int{4290, 429, -32029} {
		err := MapRemoteError(map[string]any{"code": code, "message": "rate limit"})
		rl, ok := err.(*RateLimitError)
		if !ok {
			t.Errorf("code=%d 应映射为 RateLimitError, 实际: %T", code, err)
			continue
		}
		if !rl.Retryable {
			t.Errorf("code=%d RateLimitError 应可重试", code)
		}
	}
}

// TestMapRemoteError_SessionCodes 验证会话错误码映射
func TestMapRemoteError_SessionCodes(t *testing.T) {
	for _, code := range []int{-32010, -32011, -32013} {
		err := MapRemoteError(map[string]any{"code": code, "message": "session err"})
		if _, ok := err.(*SessionError); !ok {
			t.Errorf("code=%d 应映射为 SessionError, 实际: %T", code, err)
		}
	}
}

// TestMapRemoteError_ValidationCodes 验证参数校验错误码映射
func TestMapRemoteError_ValidationCodes(t *testing.T) {
	for _, code := range []int{-32600, -32601, -32602, 4000} {
		err := MapRemoteError(map[string]any{"code": code, "message": "validation err"})
		if _, ok := err.(*ValidationError); !ok {
			t.Errorf("code=%d 应映射为 ValidationError, 实际: %T", code, err)
		}
	}
}

// TestMapRemoteError_GroupCodes 验证群组错误码映射
func TestMapRemoteError_GroupCodes(t *testing.T) {
	// -33001 -> GroupNotFoundError
	err := MapRemoteError(map[string]any{"code": -33001, "message": "group not found"})
	if _, ok := err.(*GroupNotFoundError); !ok {
		t.Errorf("code=-33001 应映射为 GroupNotFoundError, 实际: %T", err)
	}

	// -33002, -33003 -> GroupStateError
	for _, code := range []int{-33002, -33003} {
		err := MapRemoteError(map[string]any{"code": code, "message": "group state err"})
		if _, ok := err.(*GroupStateError); !ok {
			t.Errorf("code=%d 应映射为 GroupStateError, 实际: %T", code, err)
		}
	}

	// -33004 ~ -33009 -> GroupError
	for _, code := range []int{-33004, -33005, -33009} {
		err := MapRemoteError(map[string]any{"code": code, "message": "group err"})
		if _, ok := err.(*GroupError); !ok {
			t.Errorf("code=%d 应映射为 GroupError, 实际: %T", code, err)
		}
	}
}

// TestMapRemoteError_ServerRetryable 验证 5000-5999 服务端可重试错误
func TestMapRemoteError_ServerRetryable(t *testing.T) {
	for _, code := range []int{5000, 5001, 5500, 5999} {
		err := MapRemoteError(map[string]any{"code": code, "message": "server err"})
		ae, ok := err.(*AUNError)
		if !ok {
			t.Errorf("code=%d 应映射为 AUNError, 实际: %T", code, err)
			continue
		}
		if !ae.Retryable {
			t.Errorf("code=%d 应为可重试", code)
		}
	}
	// 6000 不应可重试
	err := MapRemoteError(map[string]any{"code": 6000, "message": "not retryable"})
	ae, ok := err.(*AUNError)
	if !ok {
		t.Fatalf("code=6000 应映射为 AUNError, 实际: %T", err)
	}
	if ae.Retryable {
		t.Error("code=6000 不应可重试")
	}
}

// TestMapRemoteError_DefaultCode 验证默认错误码映射
func TestMapRemoteError_DefaultCode(t *testing.T) {
	err := MapRemoteError(map[string]any{"code": -32603, "message": "internal"})
	ae, ok := err.(*AUNError)
	if !ok {
		t.Fatalf("默认 code 应映射为 AUNError, 实际: %T", err)
	}
	if ae.Code != -32603 {
		t.Errorf("Code 不正确: %d", ae.Code)
	}
	if ae.Retryable {
		t.Error("默认 code -32603 不应可重试")
	}
}

// TestMapRemoteError_TraceID 验证 trace_id 提取
func TestMapRemoteError_TraceID(t *testing.T) {
	err := MapRemoteError(map[string]any{
		"code":    -32603,
		"message": "test",
		"data":    map[string]any{"trace_id": "abc-123"},
	})
	ae, ok := err.(*AUNError)
	if !ok {
		t.Fatalf("应映射为 AUNError, 实际: %T", err)
	}
	if ae.TraceID != "abc-123" {
		t.Errorf("TraceID 不正确: %s", ae.TraceID)
	}
}

// TestMapRemoteError_Message 验证错误消息提取
func TestMapRemoteError_Message(t *testing.T) {
	err := MapRemoteError(map[string]any{
		"code":    4001,
		"message": "custom auth error",
	})
	ae, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("应映射为 AuthError, 实际: %T", err)
	}
	if ae.Message != "custom auth error" {
		t.Errorf("Message 不正确: %s", ae.Message)
	}
}
