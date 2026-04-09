package aun

import (
	"encoding/base64"
	"strings"
	"testing"
)

// TestGenerateIdentity 验证生成的身份包含正确的字段
func TestGenerateIdentity(t *testing.T) {
	cp := &CryptoProvider{}
	identity, err := cp.GenerateIdentity()
	if err != nil {
		t.Fatalf("GenerateIdentity 失败: %v", err)
	}

	privPEM, ok := identity["private_key_pem"].(string)
	if !ok || privPEM == "" {
		t.Error("缺少 private_key_pem")
	}
	if !strings.Contains(privPEM, "BEGIN PRIVATE KEY") {
		t.Error("private_key_pem 格式不正确")
	}

	pubDERB64, ok := identity["public_key_der_b64"].(string)
	if !ok || pubDERB64 == "" {
		t.Error("缺少 public_key_der_b64")
	}
	// 验证 base64 可解码
	_, err = base64.StdEncoding.DecodeString(pubDERB64)
	if err != nil {
		t.Errorf("public_key_der_b64 解码失败: %v", err)
	}

	curve, ok := identity["curve"].(string)
	if !ok || curve != "P-256" {
		t.Errorf("curve 应为 P-256, 实际: %s", curve)
	}
}

// TestSignLoginNonce 验证签名登录 nonce
func TestSignLoginNonce(t *testing.T) {
	cp := &CryptoProvider{}
	identity, err := cp.GenerateIdentity()
	if err != nil {
		t.Fatalf("GenerateIdentity 失败: %v", err)
	}
	privPEM := identity["private_key_pem"].(string)

	sig, usedTime, err := cp.SignLoginNonce(privPEM, "test-nonce-123", "")
	if err != nil {
		t.Fatalf("SignLoginNonce 失败: %v", err)
	}
	if sig == "" {
		t.Error("签名不应为空")
	}
	if usedTime == "" {
		t.Error("使用的时间戳不应为空")
	}

	// 验证 base64 可解码
	_, err = base64.StdEncoding.DecodeString(sig)
	if err != nil {
		t.Errorf("签名 base64 解码失败: %v", err)
	}

	// 使用指定时间戳
	sig2, usedTime2, err := cp.SignLoginNonce(privPEM, "test-nonce-123", "1234567890.0")
	if err != nil {
		t.Fatalf("SignLoginNonce 带时间戳失败: %v", err)
	}
	if sig2 == "" {
		t.Error("签名不应为空")
	}
	if usedTime2 != "1234567890.0" {
		t.Errorf("使用的时间戳应为 1234567890.0, 实际: %s", usedTime2)
	}
}

// TestSignLoginNonce_InvalidPEM 验证无效 PEM 返回错误
func TestSignLoginNonce_InvalidPEM(t *testing.T) {
	cp := &CryptoProvider{}
	_, _, err := cp.SignLoginNonce("not-a-pem", "nonce", "")
	if err == nil {
		t.Error("无效 PEM 应返回错误")
	}
}

// TestNewClientNonce 验证生成的客户端 nonce
func TestNewClientNonce(t *testing.T) {
	cp := &CryptoProvider{}
	nonce := cp.NewClientNonce()
	if nonce == "" {
		t.Error("nonce 不应为空")
	}
	// 验证 base64 可解码
	decoded, err := base64.StdEncoding.DecodeString(nonce)
	if err != nil {
		t.Errorf("nonce base64 解码失败: %v", err)
	}
	if len(decoded) != 12 {
		t.Errorf("nonce 解码后应为 12 字节, 实际: %d", len(decoded))
	}

	// 两次生成应不同
	nonce2 := cp.NewClientNonce()
	if nonce == nonce2 {
		t.Error("两次生成的 nonce 不应相同")
	}
}

// TestGenerateIdentity_Unique 验证每次生成的密钥对不同
func TestGenerateIdentity_Unique(t *testing.T) {
	cp := &CryptoProvider{}
	id1, _ := cp.GenerateIdentity()
	id2, _ := cp.GenerateIdentity()
	if id1["private_key_pem"] == id2["private_key_pem"] {
		t.Error("两次生成的私钥不应相同")
	}
	if id1["public_key_der_b64"] == id2["public_key_der_b64"] {
		t.Error("两次生成的公钥不应相同")
	}
}
