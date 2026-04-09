package aun

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/anthropics/aun-sdk-core/go/keystore"
	"github.com/anthropics/aun-sdk-core/go/secretstore"
)

// ── 测试辅助函数 ─────────────────────────────────────────

// testGenerateECKeypair 生成 P-256 EC 密钥对（测试用）
func testGenerateECKeypair(t *testing.T) (*ecdsa.PrivateKey, string, string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成密钥对失败: %v", err)
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("序列化私钥失败: %v", err)
	}
	privPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}))
	pubDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatalf("序列化公钥失败: %v", err)
	}
	pubB64 := base64.StdEncoding.EncodeToString(pubDER)
	return priv, privPEM, pubB64
}

// testMakeSelfSignedCert 创建自签名证书（测试用）
func testMakeSelfSignedCert(t *testing.T, priv *ecdsa.PrivateKey, cn string) string {
	t.Helper()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("创建证书失败: %v", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	return string(certPEM)
}

// testBuildIdentity 构建身份字典（测试用）
func testBuildIdentity(aid, privPEM, pubB64, certPEM string) map[string]any {
	return map[string]any{
		"aid":                aid,
		"private_key_pem":    privPEM,
		"public_key_der_b64": pubB64,
		"curve":              "P-256",
		"cert":               certPEM,
	}
}

// testMakeE2EEPair 创建发送方/接收方 E2EEManager 对（测试用）
func testMakeE2EEPair(t *testing.T) (
	sender *E2EEManager, receiver *E2EEManager,
	senderAID, receiverAID string,
	senderIdentity, receiverIdentity map[string]any,
	senderCertPEM, receiverCertPEM string,
) {
	t.Helper()
	senderAID = "alice.test"
	receiverAID = "bob.test"

	senderPriv, senderPrivPEM, senderPubB64 := testGenerateECKeypair(t)
	senderCertPEM = testMakeSelfSignedCert(t, senderPriv, senderAID)
	senderIdentity = testBuildIdentity(senderAID, senderPrivPEM, senderPubB64, senderCertPEM)

	receiverPriv, receiverPrivPEM, receiverPubB64 := testGenerateECKeypair(t)
	receiverCertPEM = testMakeSelfSignedCert(t, receiverPriv, receiverAID)
	receiverIdentity = testBuildIdentity(receiverAID, receiverPrivPEM, receiverPubB64, receiverCertPEM)

	tmpDir := t.TempDir()
	ss, err := secretstore.NewFileSecretStore(tmpDir+"/secrets", "test-seed")
	if err != nil {
		t.Fatalf("创建 FileSecretStore 失败: %v", err)
	}

	senderKS, err := keystore.NewFileKeyStore(tmpDir+"/sender", ss, "test-seed")
	if err != nil {
		t.Fatalf("创建发送方 keystore 失败: %v", err)
	}
	_ = senderKS.SaveIdentity(senderAID, senderIdentity)
	_ = senderKS.SaveCert(receiverAID, receiverCertPEM) // 发送方存对方证书

	receiverKS, err := keystore.NewFileKeyStore(tmpDir+"/receiver", ss, "test-seed")
	if err != nil {
		t.Fatalf("创建接收方 keystore 失败: %v", err)
	}
	_ = receiverKS.SaveIdentity(receiverAID, receiverIdentity)
	_ = receiverKS.SaveCert(senderAID, senderCertPEM) // 接收方存对方证书

	sender = NewE2EEManager(E2EEManagerConfig{
		IdentityFn: func() map[string]any { return senderIdentity },
		Keystore:   senderKS,
	})
	receiver = NewE2EEManager(E2EEManagerConfig{
		IdentityFn: func() map[string]any { return receiverIdentity },
		Keystore:   receiverKS,
	})
	return
}

// ── AAD 测试 ─────────────────────────────────────────────

// TestAADBytesOfflineFieldCount 验证 AAD 序列化包含正确的字段数
func TestAADBytesOfflineFieldCount(t *testing.T) {
	aad := map[string]any{
		"from": "alice", "to": "bob", "message_id": "mid1",
		"timestamp": int64(12345), "encryption_mode": "prekey_ecdh_v2",
		"suite": "P256_HKDF_SHA256_AES_256_GCM", "ephemeral_public_key": "epk1",
		"recipient_cert_fingerprint": "sha256:abc", "sender_cert_fingerprint": "sha256:def",
		"prekey_id": "pk1",
	}
	data := aadBytesOffline(aad)
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("AAD 反序列化失败: %v", err)
	}
	if len(parsed) != len(aadFieldsOffline) {
		t.Errorf("AAD 字段数不正确: 期望 %d, 实际 %d", len(aadFieldsOffline), len(parsed))
	}
}

// TestAADBytesOfflineDeterministic 验证相同输入产生相同 AAD 字节
func TestAADBytesOfflineDeterministic(t *testing.T) {
	aad := map[string]any{
		"from": "alice", "to": "bob", "message_id": "mid1",
		"timestamp": int64(12345), "encryption_mode": "prekey_ecdh_v2",
		"suite": SuiteP256, "ephemeral_public_key": "epk1",
		"recipient_cert_fingerprint": "sha256:abc", "sender_cert_fingerprint": "sha256:def",
		"prekey_id": "pk1",
	}
	data1 := aadBytesOffline(aad)
	data2 := aadBytesOffline(aad)
	if string(data1) != string(data2) {
		t.Error("相同 AAD 输入应产生相同字节输出")
	}
}

// TestAADMatchesOffline 验证 AAD 匹配检查
func TestAADMatchesOffline(t *testing.T) {
	aad1 := map[string]any{
		"from": "alice", "to": "bob", "message_id": "mid1",
		"encryption_mode": "prekey_ecdh_v2", "suite": SuiteP256,
		"ephemeral_public_key": "epk1",
		"recipient_cert_fingerprint": "sha256:abc", "sender_cert_fingerprint": "sha256:def",
		"prekey_id": "pk1",
	}
	aad2 := copyMapShallow(aad1)
	if !aadMatchesOffline(aad1, aad2) {
		t.Error("相同 AAD 应匹配")
	}
	aad3 := copyMapShallow(aad1)
	aad3["from"] = "eve"
	if aadMatchesOffline(aad1, aad3) {
		t.Error("不同 from 的 AAD 不应匹配")
	}
}

// ── Prekey 加密解密 ──────────────────────────────────────

// TestPrekeyEncryptEnvelopeFields 验证 prekey 加密产生的信封字段
func TestPrekeyEncryptEnvelopeFields(t *testing.T) {
	sender, receiver, _, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	// 接收方生成 prekey
	prekey, err := receiver.GeneratePrekey()
	if err != nil {
		t.Fatalf("生成 prekey 失败: %v", err)
	}

	envelope, info, err := sender.EncryptOutbound(
		receiverAID,
		map[string]any{"text": "hello"},
		[]byte(receiverCertPEM),
		prekey,
		"test-msg-1",
		time.Now().UnixMilli(),
	)
	if err != nil {
		t.Fatalf("EncryptOutbound 失败: %v", err)
	}

	// 验证信封字段
	requiredFields := []string{"type", "version", "encryption_mode", "suite", "prekey_id",
		"ephemeral_public_key", "nonce", "ciphertext", "tag", "aad", "sender_signature"}
	for _, field := range requiredFields {
		if _, ok := envelope[field]; !ok {
			t.Errorf("信封缺少字段: %s", field)
		}
	}

	if envelope["type"] != "e2ee.encrypted" {
		t.Errorf("type 不正确: %v", envelope["type"])
	}
	if envelope["encryption_mode"] != ModePrekeyECDHV2 {
		t.Errorf("encryption_mode 不正确: %v", envelope["encryption_mode"])
	}

	// 验证加密信息
	encrypted, _ := info["encrypted"].(bool)
	forwardSecrecy, _ := info["forward_secrecy"].(bool)
	if !encrypted || !forwardSecrecy {
		t.Error("prekey 加密应标记 encrypted=true, forward_secrecy=true")
	}
	if info["mode"] != ModePrekeyECDHV2 {
		t.Errorf("mode 不正确: %v", info["mode"])
	}
}

// TestPrekeyEncryptDecryptRoundtrip 验证 prekey 加密解密往返
func TestPrekeyEncryptDecryptRoundtrip(t *testing.T) {
	sender, receiver, senderAID, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	// 接收方生成 prekey
	prekey, err := receiver.GeneratePrekey()
	if err != nil {
		t.Fatalf("生成 prekey 失败: %v", err)
	}

	originalPayload := map[string]any{"text": "hello world", "count": float64(42)}
	messageID := "test-msg-roundtrip"
	ts := time.Now().UnixMilli()

	envelope, _, err := sender.EncryptOutbound(
		receiverAID, originalPayload, []byte(receiverCertPEM), prekey, messageID, ts,
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	// 构造接收消息
	message := map[string]any{
		"from":       senderAID,
		"to":         receiverAID,
		"message_id": messageID,
		"timestamp":  ts,
		"payload":    envelope,
		"encrypted":  true,
	}

	decrypted, err := receiver.DecryptMessage(message)
	if err != nil {
		t.Fatalf("解密失败: %v", err)
	}
	if decrypted == nil {
		t.Fatal("解密结果不应为 nil")
	}

	payload, ok := decrypted["payload"].(map[string]any)
	if !ok {
		t.Fatal("解密后 payload 类型不正确")
	}
	if payload["text"] != "hello world" {
		t.Errorf("解密后 text 不正确: %v", payload["text"])
	}
	if payload["count"] != float64(42) {
		t.Errorf("解密后 count 不正确: %v", payload["count"])
	}

	// 验证 e2ee 元数据
	e2ee, ok := decrypted["e2ee"].(map[string]any)
	if !ok {
		t.Fatal("缺少 e2ee 元数据")
	}
	if e2ee["encryption_mode"] != ModePrekeyECDHV2 {
		t.Errorf("e2ee 元数据 encryption_mode 不正确: %v", e2ee["encryption_mode"])
	}
}

// ── Long-term key 加密解密 ────────────────────────────────

// TestLongTermKeyEnvelopeAadFields 验证 long-term key 模式的信封和 AAD 字段
func TestLongTermKeyEnvelopeAadFields(t *testing.T) {
	sender, _, _, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	envelope, info, err := sender.EncryptOutbound(
		receiverAID,
		map[string]any{"text": "hello"},
		[]byte(receiverCertPEM),
		nil, // 无 prekey，降级到 long_term_key
		"test-msg-lt",
		time.Now().UnixMilli(),
	)
	if err != nil {
		t.Fatalf("EncryptOutbound 失败: %v", err)
	}

	if envelope["encryption_mode"] != ModeLongTermKey {
		t.Errorf("应为 long_term_key 模式: %v", envelope["encryption_mode"])
	}

	// AAD 不应包含 prekey_id
	aad, ok := envelope["aad"].(map[string]any)
	if !ok {
		t.Fatal("缺少 aad")
	}
	// long_term_key 模式 AAD 中 prekey_id 应为 nil 或空
	if pid, exists := aad["prekey_id"]; exists && pid != nil && pid != "" {
		t.Errorf("long_term_key 模式不应有 prekey_id: %v", pid)
	}

	// 验证不是前向保密
	if info["forward_secrecy"] != false {
		t.Error("long_term_key 模式应标记 forward_secrecy=false")
	}
}

// TestLongTermKeyRoundtrip 验证 long-term key 加密解密往返
func TestLongTermKeyRoundtrip(t *testing.T) {
	sender, receiver, senderAID, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	originalPayload := map[string]any{"text": "long term test"}
	messageID := "test-msg-lt-rt"
	ts := time.Now().UnixMilli()

	envelope, _, err := sender.EncryptOutbound(
		receiverAID, originalPayload, []byte(receiverCertPEM),
		nil, messageID, ts,
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	message := map[string]any{
		"from": senderAID, "to": receiverAID,
		"message_id": messageID, "timestamp": ts,
		"payload": envelope, "encrypted": true,
	}

	decrypted, err := receiver.DecryptMessage(message)
	if err != nil {
		t.Fatalf("解密失败: %v", err)
	}
	payload := decrypted["payload"].(map[string]any)
	if payload["text"] != "long term test" {
		t.Errorf("解密后 text 不正确: %v", payload["text"])
	}
}

// ── 降级测试 ─────────────────────────────────────────────

// TestEncryptOutboundPrekeyAvailable 验证有 prekey 时使用 prekey 模式
func TestEncryptOutboundPrekeyAvailable(t *testing.T) {
	sender, receiver, _, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	prekey, _ := receiver.GeneratePrekey()
	_, info, err := sender.EncryptOutbound(
		receiverAID, map[string]any{"t": "x"}, []byte(receiverCertPEM),
		prekey, "msg1", time.Now().UnixMilli(),
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}
	if info["mode"] != ModePrekeyECDHV2 {
		t.Errorf("有 prekey 时应使用 prekey_ecdh_v2: %v", info["mode"])
	}
	if info["forward_secrecy"] != true {
		t.Error("prekey 模式应有前向保密")
	}
}

// TestEncryptOutboundNoPrekeyFallback 验证无 prekey 时降级到 long_term_key
func TestEncryptOutboundNoPrekeyFallback(t *testing.T) {
	sender, _, _, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	_, info, err := sender.EncryptOutbound(
		receiverAID, map[string]any{"t": "x"}, []byte(receiverCertPEM),
		nil, "msg2", time.Now().UnixMilli(),
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}
	if info["mode"] != ModeLongTermKey {
		t.Errorf("无 prekey 时应降级到 long_term_key: %v", info["mode"])
	}
	if info["forward_secrecy"] != false {
		t.Error("long_term_key 模式不应有前向保密")
	}
}

// ── 防重放测试 ───────────────────────────────────────────

// TestLocalSeenSetBlocksDuplicate 验证本地 seen set 阻止重复消息
func TestLocalSeenSetBlocksDuplicate(t *testing.T) {
	sender, receiver, senderAID, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	prekey, _ := receiver.GeneratePrekey()
	envelope, _, _ := sender.EncryptOutbound(
		receiverAID, map[string]any{"t": "x"}, []byte(receiverCertPEM),
		prekey, "dup-msg-1", time.Now().UnixMilli(),
	)

	message := map[string]any{
		"from": senderAID, "to": receiverAID,
		"message_id": "dup-msg-1", "timestamp": time.Now().UnixMilli(),
		"payload": envelope, "encrypted": true,
	}

	// 第一次解密应成功
	result1, err := receiver.DecryptMessage(message)
	if err != nil {
		t.Fatalf("首次解密失败: %v", err)
	}
	if result1 == nil {
		t.Fatal("首次解密结果不应为 nil")
	}

	// 第二次解密应因重放被拒
	_, err = receiver.DecryptMessage(message)
	if err == nil {
		t.Error("重放消息应返回错误")
	}
}

// TestSeenSetTrim 验证 seen set 超过限制时触发裁剪
func TestSeenSetTrim(t *testing.T) {
	mgr := NewE2EEManager(E2EEManagerConfig{
		IdentityFn: func() map[string]any { return map[string]any{"aid": "test"} },
	})
	// 手动填充 seen set 到超过限制
	mgr.mu.Lock()
	for i := 0; i < seenMaxSize+100; i++ {
		mgr.seenMessages[strings.Repeat("x", 10)+string(rune(i))] = true
	}
	mgr.trimSeenSet()
	size := len(mgr.seenMessages)
	mgr.mu.Unlock()

	if size > seenMaxSize {
		t.Errorf("裁剪后 seen set 大小应 <= %d, 实际: %d", seenMaxSize, size)
	}
}

// ── Prekey 生成测试 ──────────────────────────────────────

// TestGeneratePrekeyStoresPrivateKey 验证生成 prekey 后私钥被保存到 keystore
func TestGeneratePrekeyStoresPrivateKey(t *testing.T) {
	_, receiver, _, _, _, _, _, _ := testMakeE2EEPair(t)

	prekey, err := receiver.GeneratePrekey()
	if err != nil {
		t.Fatalf("生成 prekey 失败: %v", err)
	}

	prekeyID, ok := prekey["prekey_id"].(string)
	if !ok || prekeyID == "" {
		t.Error("prekey 应包含 prekey_id")
	}

	pubKey, ok := prekey["public_key"].(string)
	if !ok || pubKey == "" {
		t.Error("prekey 应包含 public_key")
	}

	sig, ok := prekey["signature"].(string)
	if !ok || sig == "" {
		t.Error("prekey 应包含 signature")
	}
}

// TestGeneratePrekeyIncludesCreatedAt 验证生成的 prekey 包含 created_at
func TestGeneratePrekeyIncludesCreatedAt(t *testing.T) {
	_, receiver, _, _, _, _, _, _ := testMakeE2EEPair(t)

	prekey, err := receiver.GeneratePrekey()
	if err != nil {
		t.Fatalf("生成 prekey 失败: %v", err)
	}

	createdAt, ok := prekey["created_at"]
	if !ok || createdAt == nil {
		t.Error("prekey 应包含 created_at")
	}
	ts := toInt64(createdAt)
	if ts <= 0 {
		t.Errorf("created_at 应为正数: %v", createdAt)
	}
}

// ── 明文消息透传测试 ─────────────────────────────────────

// TestPlaintextPassthrough 验证非加密消息原样返回
func TestPlaintextPassthrough(t *testing.T) {
	_, receiver, _, _, _, _, _, _ := testMakeE2EEPair(t)

	message := map[string]any{
		"from": "alice", "to": "bob",
		"message_id": "plain-1",
		"payload":    map[string]any{"text": "hello"},
	}
	result, err := receiver.DecryptMessage(message)
	if err != nil {
		t.Fatalf("明文消息不应返回错误: %v", err)
	}
	payload := result["payload"].(map[string]any)
	if payload["text"] != "hello" {
		t.Errorf("明文消息应原样返回: %v", payload)
	}
}

// TestEncryptedDecrypted 验证加密后再解密得到原文
func TestEncryptedDecrypted(t *testing.T) {
	sender, receiver, senderAID, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	prekey, _ := receiver.GeneratePrekey()
	originalPayload := map[string]any{"secret": "top-secret-data", "number": float64(99)}
	msgID := "e2e-roundtrip"
	ts := time.Now().UnixMilli()

	envelope, _, err := sender.EncryptOutbound(
		receiverAID, originalPayload, []byte(receiverCertPEM),
		prekey, msgID, ts,
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	message := map[string]any{
		"from": senderAID, "to": receiverAID,
		"message_id": msgID, "timestamp": ts,
		"payload": envelope, "encrypted": true,
	}

	decrypted, err := receiver.DecryptMessage(message)
	if err != nil {
		t.Fatalf("解密失败: %v", err)
	}
	payload := decrypted["payload"].(map[string]any)
	if payload["secret"] != "top-secret-data" {
		t.Errorf("解密数据不匹配: %v", payload)
	}
	if payload["number"] != float64(99) {
		t.Errorf("解密数据不匹配: %v", payload)
	}
}

// ── 发送方签名测试 ───────────────────────────────────────

// TestSenderSignature 验证信封包含发送方签名
func TestSenderSignature(t *testing.T) {
	sender, receiver, _, receiverAID, _, _, _, receiverCertPEM := testMakeE2EEPair(t)

	prekey, _ := receiver.GeneratePrekey()
	envelope, _, err := sender.EncryptOutbound(
		receiverAID, map[string]any{"t": "x"}, []byte(receiverCertPEM),
		prekey, "sig-msg-1", time.Now().UnixMilli(),
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	sig, ok := envelope["sender_signature"].(string)
	if !ok || sig == "" {
		t.Error("信封应包含 sender_signature")
	}
	fp, ok := envelope["sender_cert_fingerprint"].(string)
	if !ok || fp == "" {
		t.Error("信封应包含 sender_cert_fingerprint")
	}
	if !strings.HasPrefix(fp, "sha256:") {
		t.Errorf("sender_cert_fingerprint 应以 sha256: 开头: %s", fp)
	}
}

// TestSenderSignature_Verifiable 验证发送方签名可被验证
func TestSenderSignature_Verifiable(t *testing.T) {
	sender, _, senderAID, receiverAID, senderIdentity, _, _, receiverCertPEM := testMakeE2EEPair(t)

	envelope, _, err := sender.EncryptOutbound(
		receiverAID, map[string]any{"t": "x"}, []byte(receiverCertPEM),
		nil, "sig-verify-1", time.Now().UnixMilli(),
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	sigB64 := envelope["sender_signature"].(string)
	sigBytes, _ := base64.StdEncoding.DecodeString(sigB64)

	// 从发送方身份获取公钥
	certPEM := senderIdentity["cert"].(string)
	block, _ := pem.Decode([]byte(certPEM))
	cert, _ := x509.ParseCertificate(block.Bytes)
	pub := cert.PublicKey.(*ecdsa.PublicKey)

	ct, _ := base64.StdEncoding.DecodeString(envelope["ciphertext"].(string))
	tag, _ := base64.StdEncoding.DecodeString(envelope["tag"].(string))
	aad := envelope["aad"].(map[string]any)
	aadBytes := aadBytesOffline(aad)

	signPayload := make([]byte, 0, len(ct)+len(tag)+len(aadBytes))
	signPayload = append(signPayload, ct...)
	signPayload = append(signPayload, tag...)
	signPayload = append(signPayload, aadBytes...)

	hash := sha256.Sum256(signPayload)
	if !ecdsa.VerifyASN1(pub, hash[:], sigBytes) {
		t.Error("发送方签名验证失败")
	}
	_ = senderAID // 消除 unused 警告
}

// ── Prekey 缓存测试 ──────────────────────────────────────

// TestPrekeyCacheTTL 验证 prekey 缓存 TTL
func TestPrekeyCacheTTL(t *testing.T) {
	mgr := NewE2EEManager(E2EEManagerConfig{
		IdentityFn:     func() map[string]any { return map[string]any{"aid": "test"} },
		PrekeyCacheTTL: 1, // 1 秒 TTL
	})
	pk := map[string]any{"prekey_id": "pk1", "public_key": "key1"}
	mgr.CachePrekey("peer1", pk)

	cached := mgr.GetCachedPrekey("peer1")
	if cached == nil {
		t.Error("缓存应命中")
	}

	// 等待 TTL 过期
	time.Sleep(1100 * time.Millisecond)
	expired := mgr.GetCachedPrekey("peer1")
	if expired != nil {
		t.Error("TTL 过期后缓存应失效")
	}
}

// TestPrekeyInvalidateCache 验证清除 prekey 缓存
func TestPrekeyInvalidateCache(t *testing.T) {
	mgr := NewE2EEManager(E2EEManagerConfig{
		IdentityFn: func() map[string]any { return map[string]any{"aid": "test"} },
	})
	pk := map[string]any{"prekey_id": "pk1", "public_key": "key1"}
	mgr.CachePrekey("peer1", pk)
	mgr.InvalidatePrekeyCache("peer1")

	cached := mgr.GetCachedPrekey("peer1")
	if cached != nil {
		t.Error("清除后缓存应为空")
	}
}
