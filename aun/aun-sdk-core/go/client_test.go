package aun

import (
	"context"
	"testing"
)

// ── 客户端构造测试 ───────────────────────────────────────

// TestConstructNoArgs 验证使用空配置创建客户端
func TestConstructNoArgs(t *testing.T) {
	c := NewClient(map[string]any{})
	if c == nil {
		t.Fatal("NewClient 不应返回 nil")
	}
	if c.State() != StateIdle {
		t.Errorf("初始状态应为 idle: %s", c.State())
	}
	if c.AID() != "" {
		t.Errorf("初始 AID 应为空: %s", c.AID())
	}
}

// TestConstructWithAunPath 验证使用自定义 AUNPath 创建客户端
func TestConstructWithAunPath(t *testing.T) {
	tmpDir := t.TempDir()
	c := NewClient(map[string]any{
		"aun_path": tmpDir,
	})
	if c == nil {
		t.Fatal("NewClient 不应返回 nil")
	}
	if c.configModel.AUNPath != tmpDir {
		t.Errorf("AUNPath 不正确: %s", c.configModel.AUNPath)
	}
}

// ── 连接验证测试 ─────────────────────────────────────────

// TestConnectRequiresAccessToken 验证连接需要 access_token
func TestConnectRequiresAccessToken(t *testing.T) {
	c := NewClient(map[string]any{
		"aun_path": t.TempDir(),
	})
	err := c.Connect(context.Background(), map[string]any{
		"gateway": "ws://localhost:20001",
	}, nil)
	if err == nil {
		t.Error("缺少 access_token 应返回错误")
	}
	// 应为 StateError
	if _, ok := err.(*StateError); !ok {
		t.Errorf("错误类型不正确: %T", err)
	}
}

// TestConnectRequiresGateway 验证连接需要 gateway
func TestConnectRequiresGateway(t *testing.T) {
	c := NewClient(map[string]any{
		"aun_path": t.TempDir(),
	})
	err := c.Connect(context.Background(), map[string]any{
		"access_token": "test-token",
	}, nil)
	if err == nil {
		t.Error("缺少 gateway 应返回错误")
	}
}

// ── 状态测试 ─────────────────────────────────────────────

// TestClientState 验证客户端初始状态
func TestClientState(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	if c.State() != StateIdle {
		t.Errorf("初始状态应为 idle: %s", c.State())
	}
}

// ── RPC 调用测试 ─────────────────────────────────────────

// TestCallNotConnected 验证未连接时调用 RPC 返回错误
func TestCallNotConnected(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	_, err := c.Call(context.Background(), "meta.ping", nil)
	if err == nil {
		t.Error("未连接时调用应返回错误")
	}
	if _, ok := err.(*ConnectionError); !ok {
		t.Errorf("错误类型应为 ConnectionError: %T", err)
	}
}

// TestCallInternalOnlyBlocked 验证内部专用方法被阻止
func TestCallInternalOnlyBlocked(t *testing.T) {
	// 需要先让状态变为 Connected 才能测到 internalOnly 检查
	// 由于无法真正连接，我们创建一个假连接状态
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	c.mu.Lock()
	c.state = StateConnected
	c.mu.Unlock()

	for _, method := range []string{
		"auth.login1", "auth.aid_login1", "auth.login2",
		"auth.aid_login2", "auth.connect", "auth.refresh_token",
		"initialize",
	} {
		_, err := c.Call(context.Background(), method, nil)
		if err == nil {
			t.Errorf("内部方法 %s 应被阻止", method)
			continue
		}
		if _, ok := err.(*PermissionError); !ok {
			// 可能是 ConnectionError（transport 未连接）
			// 但只要不是 nil 就说明被拦截了
			if _, ok2 := err.(*ConnectionError); ok2 {
				// transport 未连接的错误在 internalOnly 检查之后
				// 说明没被阻止（不正确）—— 但实际上代码先检查 state 再检查 internalOnly
				// 我们已设置 state = Connected，所以应先命中 internalOnly
				t.Errorf("方法 %s: 期望 PermissionError, 实际: %T", method, err)
			}
		}
	}
}

// ── E2EE 属性测试 ────────────────────────────────────────

// TestE2EEProperty 验证 E2EE 管理器属性
func TestE2EEProperty(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	if c.E2EE() == nil {
		t.Error("E2EE() 不应返回 nil")
	}
	if c.GroupE2EE() == nil {
		t.Error("GroupE2EE() 不应返回 nil")
	}
}

// ── Close 测试 ───────────────────────────────────────────

// TestCloseIdleClient 验证关闭空闲客户端
func TestCloseIdleClient(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	err := c.Close()
	if err != nil {
		t.Errorf("关闭空闲客户端不应报错: %v", err)
	}
	if c.State() != StateClosed {
		t.Errorf("关闭后状态应为 closed: %s", c.State())
	}
}

// TestCloseIdempotent 验证重复关闭不报错
func TestCloseIdempotent(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	_ = c.Close()
	err := c.Close()
	if err != nil {
		t.Errorf("重复关闭不应报错: %v", err)
	}
}

// ── On 事件订阅测试 ──────────────────────────────────────

// TestOnEventSubscription 验证通过客户端订阅事件
func TestOnEventSubscription(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	var received any
	sub := c.On("test.event", func(payload any) {
		received = payload
	})
	if sub == nil {
		t.Fatal("On 应返回 Subscription")
	}
	c.events.Publish("test.event", "hello")
	if received != "hello" {
		t.Errorf("收到的 payload 不正确: %v", received)
	}
}

// ── Client 配置测试 ──────────────────────────────────────

// TestClientGroupE2EEConfig 验证群组 E2EE 配置传递
func TestClientGroupE2EEConfig(t *testing.T) {
	c := NewClient(map[string]any{
		"aun_path":   t.TempDir(),
		"group_e2ee": false,
	})
	if c.configModel.GroupE2EE {
		t.Error("group_e2ee 应为 false")
	}
}

// TestClientVerifySSLConfig 验证 SSL 验证配置传递
func TestClientVerifySSLConfig(t *testing.T) {
	c := NewClient(map[string]any{
		"aun_path":   t.TempDir(),
		"verify_ssl": false,
	})
	if c.configModel.VerifySSL {
		t.Error("verify_ssl 应为 false")
	}
}

// ── Client Group E2EE stub 测试 ─────────────────────────

// TestClientGroupE2EE_EncryptNoSecret stub 测试：无密钥时加密返回错误
func TestClientGroupE2EE_EncryptNoSecret(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	c.mu.Lock()
	c.aid = "alice.test"
	c.identity = map[string]any{"aid": "alice.test"}
	c.mu.Unlock()

	_, err := c.GroupE2EE().Encrypt("non-existent-group", map[string]any{"text": "hello"})
	if err == nil {
		t.Error("无密钥时加密应返回错误")
	}
}

// TestClientGroupE2EE_HasSecret stub 测试：无密钥时返回 false
func TestClientGroupE2EE_HasSecret(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	c.mu.Lock()
	c.aid = "alice.test"
	c.identity = map[string]any{"aid": "alice.test"}
	c.mu.Unlock()

	if c.GroupE2EE().HasSecret("nonexistent") {
		t.Error("不存在的群组不应有密钥")
	}
}

// TestClientGroupE2EE_CurrentEpoch stub 测试：无密钥时返回 nil
func TestClientGroupE2EE_CurrentEpoch(t *testing.T) {
	c := NewClient(map[string]any{"aun_path": t.TempDir()})
	c.mu.Lock()
	c.aid = "alice.test"
	c.identity = map[string]any{"aid": "alice.test"}
	c.mu.Unlock()

	if c.GroupE2EE().CurrentEpoch("nonexistent") != nil {
		t.Error("不存在的群组 epoch 应为 nil")
	}
}

// ── 静态辅助函数测试 ─────────────────────────────────────

// TestBuildCertURL 验证证书 URL 构建
func TestBuildCertURL(t *testing.T) {
	url := buildCertURL("wss://gateway.example.com:20001", "alice.example.com")
	if url != "https://gateway.example.com:20001/pki/cert/alice.example.com" {
		t.Errorf("URL 不正确: %s", url)
	}

	url2 := buildCertURL("ws://gateway.local:20001", "bob.local")
	if url2 != "http://gateway.local:20001/pki/cert/bob.local" {
		t.Errorf("ws URL 不正确: %s", url2)
	}
}

// TestResolvePeerGatewayURL 验证跨域 Gateway URL 解析
func TestResolvePeerGatewayURL(t *testing.T) {
	// 同域
	url := resolvePeerGatewayURL("wss://gateway.example.com:20001", "alice.example.com")
	if url != "wss://gateway.example.com:20001" {
		t.Errorf("同域 URL 应不变: %s", url)
	}

	// 不含点的 AID（无域信息）
	url2 := resolvePeerGatewayURL("wss://gateway.example.com:20001", "alice")
	if url2 != "wss://gateway.example.com:20001" {
		t.Errorf("无域 AID URL 应不变: %s", url2)
	}
}

// TestShouldRetryReconnect 验证重连重试判断
func TestShouldRetryReconnect(t *testing.T) {
	if shouldRetryReconnect(NewAuthError("auth")) {
		t.Error("AuthError 不应重试")
	}
	if shouldRetryReconnect(NewPermissionError("perm")) {
		t.Error("PermissionError 不应重试")
	}
	if !shouldRetryReconnect(NewConnectionError("conn")) {
		t.Error("ConnectionError 应重试")
	}
	if !shouldRetryReconnect(NewTimeoutError("timeout")) {
		t.Error("TimeoutError 应重试")
	}
}
