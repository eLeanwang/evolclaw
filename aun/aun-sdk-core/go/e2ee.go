package aun

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/anthropics/aun-sdk-core/go/internal"
	"github.com/anthropics/aun-sdk-core/go/keystore"
	"golang.org/x/crypto/hkdf"
)

// ── E2EE 常量 ──────────────────────────────────────────────

const (
	// SuiteP256 默认加密套件
	SuiteP256 = "P256_HKDF_SHA256_AES_256_GCM"
	// ModePrekeyECDHV2 prekey ECDH 模式（前向保密，四路 ECDH）
	ModePrekeyECDHV2 = "prekey_ecdh_v2"
	// ModeLongTermKey 长期密钥模式（无前向保密，二路 ECDH）
	ModeLongTermKey = "long_term_key"
	// PrekeyRetentionSeconds prekey 私钥本地保留时间（7 天）
	PrekeyRetentionSeconds = 7 * 24 * 3600
	// seenMaxSize 防重放集合最大容量
	seenMaxSize = 50000
)

// AAD 字段定义（P2P 离线模式）
var (
	aadFieldsOffline = []string{
		"from", "to", "message_id", "timestamp",
		"encryption_mode", "suite", "ephemeral_public_key",
		"recipient_cert_fingerprint", "sender_cert_fingerprint",
		"prekey_id",
	}
	aadMatchFieldsOffline = []string{
		"from", "to", "message_id",
		"encryption_mode", "suite", "ephemeral_public_key",
		"recipient_cert_fingerprint", "sender_cert_fingerprint",
		"prekey_id",
	}
)

// ── E2EEManager P2P 端到端加密管理器 ────────────────────────

// E2EEManager P2P 端到端加密管理器
// 加密策略：prekey_ecdh_v2（四路 ECDH）-> long_term_key（二路 ECDH）降级
// I/O（获取 prekey、证书）由调用方负责，内置本地防重放
type E2EEManager struct {
	mu                 sync.RWMutex
	identityFn         func() map[string]any // 获取当前身份的回调
	keystore           keystore.KeyStore     // 密钥存储后端
	prekeyCacheTTL     float64               // prekey 缓存 TTL（秒）
	replayWindow       int                   // 防重放时间窗口（秒）
	seenMessages       map[string]bool        // 防重放 seen set
	prekeyCache        map[string]*cachedPrekey // 对端 prekey 缓存
	localPrekeyCache   map[string]*ecdsa.PrivateKey // 本地 prekey 私钥内存缓存
}

// cachedPrekey 缓存的 prekey 条目
type cachedPrekey struct {
	Prekey   map[string]any // prekey 数据
	CachedAt float64        // 缓存时间（Unix 秒）
}

// E2EEManagerConfig E2EE 管理器配置
type E2EEManagerConfig struct {
	IdentityFn       func() map[string]any // 获取当前身份的回调
	Keystore         keystore.KeyStore     // 密钥存储后端
	PrekeyCacheTTL   float64               // prekey 缓存 TTL（秒），默认 3600
	ReplayWindowSecs int                   // 防重放时间窗口（秒），默认 300
}

// NewE2EEManager 创建 P2P E2EE 管理器
func NewE2EEManager(cfg E2EEManagerConfig) *E2EEManager {
	ttl := cfg.PrekeyCacheTTL
	if ttl == 0 {
		ttl = 3600
	}
	rw := cfg.ReplayWindowSecs
	if rw == 0 {
		rw = 300
	}
	return &E2EEManager{
		identityFn:       cfg.IdentityFn,
		keystore:         cfg.Keystore,
		prekeyCacheTTL:   ttl,
		replayWindow:     rw,
		seenMessages:     make(map[string]bool),
		prekeyCache:      make(map[string]*cachedPrekey),
		localPrekeyCache: make(map[string]*ecdsa.PrivateKey),
	}
}

// ── Prekey 缓存 ────────────────────────────────────────────

// CachePrekey 缓存对端 prekey
func (m *E2EEManager) CachePrekey(peerAID string, prekey map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.prekeyCache[peerAID] = &cachedPrekey{
		Prekey:   prekey,
		CachedAt: float64(time.Now().UnixMilli()) / 1000.0,
	}
}

// GetCachedPrekey 获取缓存的对端 prekey（TTL 超时返回 nil）
func (m *E2EEManager) GetCachedPrekey(peerAID string) map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cached, ok := m.prekeyCache[peerAID]
	if !ok {
		return nil
	}
	if float64(time.Now().UnixMilli())/1000.0-cached.CachedAt > m.prekeyCacheTTL {
		return nil
	}
	return cached.Prekey
}

// InvalidatePrekeyCache 清除指定对端的 prekey 缓存
func (m *E2EEManager) InvalidatePrekeyCache(peerAID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.prekeyCache, peerAID)
}

// ── 加密 ─────────────────────────────────────────────────

// EncryptOutbound P2P 加密外发消息
// 有 prekey -> prekey_ecdh_v2（四路 ECDH），无 prekey -> long_term_key（二路 ECDH）
// 返回 (envelope, resultInfo, error)
func (m *E2EEManager) EncryptOutbound(
	peerAID string,
	payload map[string]any,
	peerCertPEM []byte,
	prekey map[string]any,
	messageID string,
	timestamp int64,
) (map[string]any, map[string]any, error) {
	// 传入 prekey -> 缓存；传入 nil -> 查缓存
	if prekey != nil {
		m.CachePrekey(peerAID, prekey)
	} else {
		prekey = m.GetCachedPrekey(peerAID)
	}

	if prekey != nil {
		envelope, err := m.encryptWithPrekey(peerAID, payload, prekey, peerCertPEM, messageID, timestamp)
		if err == nil {
			return envelope, map[string]any{
				"encrypted":       true,
				"forward_secrecy": true,
				"mode":            ModePrekeyECDHV2,
				"degraded":        false,
			}, nil
		}
		log.Printf("[e2ee] prekey 加密失败，降级到 long_term_key: %v", err)
	}

	envelope, err := m.encryptWithLongTermKey(peerAID, payload, peerCertPEM, messageID, timestamp)
	if err != nil {
		return nil, nil, err
	}
	degraded := prekey != nil // 有 prekey 但失败了才算降级
	reason := "no_prekey_available"
	if degraded {
		reason = "prekey_encrypt_failed"
	}
	return envelope, map[string]any{
		"encrypted":          true,
		"forward_secrecy":    false,
		"mode":               ModeLongTermKey,
		"degraded":           degraded,
		"degradation_reason": reason,
	}, nil
}

// encryptWithPrekey 使用对方 prekey 加密（prekey_ecdh_v2 模式，四路 ECDH + 发送方签名）
func (m *E2EEManager) encryptWithPrekey(
	peerAID string,
	payload map[string]any,
	prekey map[string]any,
	peerCertPEM []byte,
	messageID string,
	timestamp int64,
) (map[string]any, error) {
	// 解析对端证书
	peerCert, err := parseCertPEM(peerCertPEM)
	if err != nil {
		return nil, fmt.Errorf("解析对端证书失败: %w", err)
	}
	peerIdentityPub, ok := peerCert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("对端证书非 EC 公钥")
	}

	// 验证 prekey 签名
	prekeyID, _ := prekey["prekey_id"].(string)
	publicKeyB64, _ := prekey["public_key"].(string)
	signatureB64, _ := prekey["signature"].(string)
	if prekeyID == "" || publicKeyB64 == "" || signatureB64 == "" {
		return nil, fmt.Errorf("prekey 字段不完整")
	}

	// 构建签名数据（支持含/不含 created_at）
	var signData []byte
	if createdAt, hasCreatedAt := prekey["created_at"]; hasCreatedAt && createdAt != nil {
		createdAtVal := toInt64(createdAt)
		signData = []byte(fmt.Sprintf("%s|%s|%d", prekeyID, publicKeyB64, createdAtVal))
		// 检查 prekey 年龄（30 天）
		ageMs := time.Now().UnixMilli() - createdAtVal
		if ageMs > 30*24*3600*1000 {
			return nil, fmt.Errorf("prekey 过期: %ds", ageMs/1000)
		}
	} else {
		signData = []byte(fmt.Sprintf("%s|%s", prekeyID, publicKeyB64))
	}

	sigBytes, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return nil, fmt.Errorf("解码 prekey 签名失败: %w", err)
	}
	if !ecdsaVerify(peerIdentityPub, signData, sigBytes) {
		return nil, fmt.Errorf("prekey 签名验证失败")
	}

	// 导入对方 prekey 公钥
	prekeyPubDER, err := base64.StdEncoding.DecodeString(publicKeyB64)
	if err != nil {
		return nil, fmt.Errorf("解码 prekey 公钥失败: %w", err)
	}
	peerPrekeyPub, err := parseECPublicKeyDER(prekeyPubDER)
	if err != nil {
		return nil, fmt.Errorf("解析 prekey 公钥失败: %w", err)
	}

	// 加载发送方 identity 私钥
	senderPriv, err := m.loadSenderIdentityPrivate()
	if err != nil {
		return nil, err
	}

	// 生成临时 ECDH 密钥对
	ephPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("生成临时密钥失败: %w", err)
	}
	ephPubBytes := elliptic.Marshal(elliptic.P256(), ephPriv.PublicKey.X, ephPriv.PublicKey.Y)

	// 四路 ECDH
	dh1 := ecdhSharedSecret(ephPriv, peerPrekeyPub)
	dh2 := ecdhSharedSecret(ephPriv, peerIdentityPub)
	dh3 := ecdhSharedSecret(senderPriv, peerPrekeyPub)
	dh4 := ecdhSharedSecret(senderPriv, peerIdentityPub)

	combined := make([]byte, 0, len(dh1)+len(dh2)+len(dh3)+len(dh4))
	combined = append(combined, dh1...)
	combined = append(combined, dh2...)
	combined = append(combined, dh3...)
	combined = append(combined, dh4...)

	// HKDF-SHA256 派生消息密钥
	info := []byte(fmt.Sprintf("aun-prekey-v2:%s", prekeyID))
	messageKey, err := hkdfDerive(combined, info, 32)
	if err != nil {
		return nil, fmt.Errorf("HKDF 派生失败: %w", err)
	}

	// AES-256-GCM 加密
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化 payload 失败: %w", err)
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("生成 nonce 失败: %w", err)
	}

	senderFP := m.localIdentityFingerprint()
	recipientFP := fingerprintCertPEM(peerCertPEM)
	ephPkB64 := base64.StdEncoding.EncodeToString(ephPubBytes)

	aad := map[string]any{
		"from":                       m.currentAID(),
		"to":                         peerAID,
		"message_id":                 messageID,
		"timestamp":                  timestamp,
		"encryption_mode":            ModePrekeyECDHV2,
		"suite":                      SuiteP256,
		"ephemeral_public_key":       ephPkB64,
		"recipient_cert_fingerprint": recipientFP,
		"sender_cert_fingerprint":    senderFP,
		"prekey_id":                  prekeyID,
	}
	aadBytes := aadBytesOffline(aad)

	block, err := aes.NewCipher(messageKey)
	if err != nil {
		return nil, fmt.Errorf("创建 AES cipher 失败: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("创建 GCM 失败: %w", err)
	}
	ciphertextWithTag := gcm.Seal(nil, nonce, plaintext, aadBytes)
	// 分割 ciphertext 和 tag（tag 是最后 16 字节）
	tagStart := len(ciphertextWithTag) - 16
	ciphertext := ciphertextWithTag[:tagStart]
	tag := ciphertextWithTag[tagStart:]

	envelope := map[string]any{
		"type":                 "e2ee.encrypted",
		"version":             "1",
		"encryption_mode":     ModePrekeyECDHV2,
		"suite":               SuiteP256,
		"prekey_id":           prekeyID,
		"ephemeral_public_key": ephPkB64,
		"nonce":               base64.StdEncoding.EncodeToString(nonce),
		"ciphertext":          base64.StdEncoding.EncodeToString(ciphertext),
		"tag":                 base64.StdEncoding.EncodeToString(tag),
		"aad":                 aad,
	}

	// 发送方签名：ciphertext + tag + aad_bytes（不可否认性）
	signPayload := make([]byte, 0, len(ciphertext)+len(tag)+len(aadBytes))
	signPayload = append(signPayload, ciphertext...)
	signPayload = append(signPayload, tag...)
	signPayload = append(signPayload, aadBytes...)
	sig, err := m.signBytes(signPayload)
	if err != nil {
		return nil, fmt.Errorf("发送方签名失败: %w", err)
	}
	envelope["sender_signature"] = sig
	envelope["sender_cert_fingerprint"] = senderFP

	return envelope, nil
}

// encryptWithLongTermKey 使用二路 ECDH 加密（long_term_key 模式 + 发送方签名）
func (m *E2EEManager) encryptWithLongTermKey(
	peerAID string,
	payload map[string]any,
	peerCertPEM []byte,
	messageID string,
	timestamp int64,
) (map[string]any, error) {
	peerCert, err := parseCertPEM(peerCertPEM)
	if err != nil {
		return nil, fmt.Errorf("解析对端证书失败: %w", err)
	}
	peerPub, ok := peerCert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("对端证书非 EC 公钥")
	}

	senderPriv, err := m.loadSenderIdentityPrivate()
	if err != nil {
		return nil, err
	}

	// 生成临时密钥对
	ephPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("生成临时密钥失败: %w", err)
	}
	ephPubBytes := elliptic.Marshal(elliptic.P256(), ephPriv.PublicKey.X, ephPriv.PublicKey.Y)

	// 二路 ECDH
	dh1 := ecdhSharedSecret(ephPriv, peerPub)
	dh2 := ecdhSharedSecret(senderPriv, peerPub)

	combined := make([]byte, 0, len(dh1)+len(dh2))
	combined = append(combined, dh1...)
	combined = append(combined, dh2...)

	messageKey, err := hkdfDerive(combined, []byte("aun-longterm-v2"), 32)
	if err != nil {
		return nil, fmt.Errorf("HKDF 派生失败: %w", err)
	}

	plaintext, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化 payload 失败: %w", err)
	}
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("生成 nonce 失败: %w", err)
	}

	senderFP := m.localIdentityFingerprint()
	recipientFP := fingerprintCertPEM(peerCertPEM)
	ephPkB64 := base64.StdEncoding.EncodeToString(ephPubBytes)

	aad := map[string]any{
		"from":                       m.currentAID(),
		"to":                         peerAID,
		"message_id":                 messageID,
		"timestamp":                  timestamp,
		"encryption_mode":            ModeLongTermKey,
		"suite":                      SuiteP256,
		"ephemeral_public_key":       ephPkB64,
		"recipient_cert_fingerprint": recipientFP,
		"sender_cert_fingerprint":    senderFP,
	}
	aadBytes := aadBytesOffline(aad)

	block, err := aes.NewCipher(messageKey)
	if err != nil {
		return nil, fmt.Errorf("创建 AES cipher 失败: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("创建 GCM 失败: %w", err)
	}
	ciphertextWithTag := gcm.Seal(nil, nonce, plaintext, aadBytes)
	tagStart := len(ciphertextWithTag) - 16
	ciphertext := ciphertextWithTag[:tagStart]
	tag := ciphertextWithTag[tagStart:]

	envelope := map[string]any{
		"type":                 "e2ee.encrypted",
		"version":             "1",
		"encryption_mode":     ModeLongTermKey,
		"suite":               SuiteP256,
		"ephemeral_public_key": ephPkB64,
		"nonce":               base64.StdEncoding.EncodeToString(nonce),
		"ciphertext":          base64.StdEncoding.EncodeToString(ciphertext),
		"tag":                 base64.StdEncoding.EncodeToString(tag),
		"aad":                 aad,
	}

	// 发送方签名
	signPayload := make([]byte, 0, len(ciphertext)+len(tag)+len(aadBytes))
	signPayload = append(signPayload, ciphertext...)
	signPayload = append(signPayload, tag...)
	signPayload = append(signPayload, aadBytes...)
	sig, err := m.signBytes(signPayload)
	if err != nil {
		return nil, fmt.Errorf("发送方签名失败: %w", err)
	}
	envelope["sender_signature"] = sig
	envelope["sender_cert_fingerprint"] = senderFP

	return envelope, nil
}

// ── 解密 ─────────────────────────────────────────────────

// DecryptMessage 解密收到的 P2P 消息（内置防重放 + timestamp 窗口）
func (m *E2EEManager) DecryptMessage(message map[string]any) (map[string]any, error) {
	payload, ok := message["payload"].(map[string]any)
	if !ok {
		return message, nil
	}
	payloadType, _ := payload["type"].(string)
	if payloadType != "e2ee.encrypted" {
		return message, nil
	}
	// 检查 encrypted 标记
	if enc, exists := message["encrypted"]; exists {
		if encBool, ok := enc.(bool); ok && !encBool {
			return message, nil
		}
	}
	if !m.shouldDecryptForCurrentAID(message, payload) {
		return message, nil
	}

	// timestamp 窗口检查
	ts := getTimestamp(message, payload)
	if ts > 0 && m.replayWindow > 0 {
		nowMs := time.Now().UnixMilli()
		diffS := abs64(nowMs-ts) / 1000
		if diffS > int64(m.replayWindow) {
			log.Printf("[e2ee] 消息 timestamp 超出窗口 (%ds > %ds)，拒绝: from=%v mid=%v",
				diffS, m.replayWindow, message["from"], message["message_id"])
			return nil, NewE2EEDecryptFailedError("timestamp 超出窗口")
		}
	}

	// 本地防重放
	messageID, _ := message["message_id"].(string)
	fromAID, _ := message["from"].(string)
	if messageID != "" && fromAID != "" {
		seenKey := fromAID + ":" + messageID
		m.mu.Lock()
		if m.seenMessages[seenKey] {
			m.mu.Unlock()
			return nil, NewE2EEDecryptFailedError("重放消息")
		}
		m.seenMessages[seenKey] = true
		m.trimSeenSet()
		m.mu.Unlock()
	}

	return m.decryptMessage(message)
}

// shouldDecryptForCurrentAID 仅解密发给当前 AID 的消息
func (m *E2EEManager) shouldDecryptForCurrentAID(message, payload map[string]any) bool {
	currentAID := m.currentAID()
	if currentAID == "" {
		return true
	}
	targetAID := ""
	if to, ok := message["to"].(string); ok && to != "" {
		targetAID = to
	} else if aad, ok := payload["aad"].(map[string]any); ok {
		if to, ok := aad["to"].(string); ok && to != "" {
			targetAID = to
		}
	}
	if targetAID == "" {
		return true
	}
	return targetAID == currentAID
}

// trimSeenSet LRU 裁剪防重放集合（需在持锁状态调用）
func (m *E2EEManager) trimSeenSet() {
	if len(m.seenMessages) > seenMaxSize {
		trimCount := len(m.seenMessages) - int(float64(seenMaxSize)*0.8)
		i := 0
		for k := range m.seenMessages {
			if i >= trimCount {
				break
			}
			delete(m.seenMessages, k)
			i++
		}
	}
}

// decryptMessage 内部解密（已通过防重放检查）
func (m *E2EEManager) decryptMessage(message map[string]any) (map[string]any, error) {
	payload := message["payload"].(map[string]any)

	if !m.shouldDecryptForCurrentAID(message, payload) {
		return message, nil
	}

	// 验证发送方签名
	if err := m.verifySenderSignature(payload, message); err != nil {
		log.Printf("[e2ee] 发送方签名验证失败: %v", err)
		return nil, err
	}

	mode, _ := payload["encryption_mode"].(string)
	switch mode {
	case ModePrekeyECDHV2:
		return m.decryptMessagePrekeyV2(message)
	case ModeLongTermKey:
		return m.decryptMessageLongTerm(message)
	default:
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("不支持的加密模式: %s", mode))
	}
}

// verifySenderSignature 验证发送方签名
func (m *E2EEManager) verifySenderSignature(payload, message map[string]any) error {
	sigB64, _ := payload["sender_signature"].(string)
	if sigB64 == "" {
		return NewE2EEDecryptFailedError("sender_signature 缺失")
	}

	fromAID := ""
	if f, ok := message["from"].(string); ok {
		fromAID = f
	} else if aad, ok := payload["aad"].(map[string]any); ok {
		fromAID, _ = aad["from"].(string)
	}
	if fromAID == "" {
		return NewE2EEDecryptFailedError("from_aid 缺失")
	}

	senderCertPEM := m.getSenderCert(fromAID)
	if senderCertPEM == nil {
		return NewE2EEDecryptFailedError(fmt.Sprintf("找不到 %s 的证书", fromAID))
	}

	senderCert, err := parseCertPEM(senderCertPEM)
	if err != nil {
		return NewE2EEDecryptFailedError(fmt.Sprintf("解析发送方证书失败: %v", err))
	}
	senderPub, ok := senderCert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return NewE2EEDecryptFailedError("发送方证书非 EC 公钥")
	}

	// 重建签名载荷
	ct, _ := base64.StdEncoding.DecodeString(payload["ciphertext"].(string))
	tagBytes, _ := base64.StdEncoding.DecodeString(payload["tag"].(string))
	var aadBytes []byte
	if aad, ok := payload["aad"].(map[string]any); ok {
		aadBytes = aadBytesOffline(aad)
	}
	signPayload := make([]byte, 0, len(ct)+len(tagBytes)+len(aadBytes))
	signPayload = append(signPayload, ct...)
	signPayload = append(signPayload, tagBytes...)
	signPayload = append(signPayload, aadBytes...)

	sigBytes, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return NewE2EEDecryptFailedError("解码签名失败")
	}
	if !ecdsaVerify(senderPub, signPayload, sigBytes) {
		return NewE2EEDecryptFailedError("发送方签名验证失败")
	}
	return nil
}

// decryptMessagePrekeyV2 解密 prekey_ecdh_v2 模式的消息
func (m *E2EEManager) decryptMessagePrekeyV2(message map[string]any) (map[string]any, error) {
	payload := message["payload"].(map[string]any)

	ephPubBytes, err := base64.StdEncoding.DecodeString(payload["ephemeral_public_key"].(string))
	if err != nil {
		return nil, NewE2EEDecryptFailedError("解码 ephemeral key 失败")
	}
	prekeyID, _ := payload["prekey_id"].(string)
	nonce, _ := base64.StdEncoding.DecodeString(payload["nonce"].(string))
	ct, _ := base64.StdEncoding.DecodeString(payload["ciphertext"].(string))
	tag, _ := base64.StdEncoding.DecodeString(payload["tag"].(string))

	// 加载 prekey 私钥
	prekeyPriv := m.loadPrekeyPrivateKey(prekeyID)
	if prekeyPriv == nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("prekey 不存在: %s", prekeyID))
	}

	// 加载接收方 identity 私钥
	myPriv, err := m.loadMyIdentityPrivate()
	if err != nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("identity 私钥加载失败: %v", err))
	}

	// 获取发送方公钥
	fromAID := ""
	if f, ok := message["from"].(string); ok {
		fromAID = f
	} else if aad, ok := payload["aad"].(map[string]any); ok {
		fromAID, _ = aad["from"].(string)
	}
	senderPub := m.loadSenderPublicKey(fromAID)
	if senderPub == nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("发送方 %s 公钥不可用", fromAID))
	}

	// 解析临时公钥
	ephPubX, ephPubY := elliptic.Unmarshal(elliptic.P256(), ephPubBytes)
	if ephPubX == nil {
		return nil, NewE2EEDecryptFailedError("解析 ephemeral 公钥失败")
	}
	ephPub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: ephPubX, Y: ephPubY}

	// 四路 ECDH（接收方视角：prekey↔ephemeral, identity↔ephemeral, prekey↔sender, identity↔sender）
	dh1 := ecdhSharedSecret(prekeyPriv, ephPub)
	dh2 := ecdhSharedSecret(myPriv, ephPub)
	dh3 := ecdhSharedSecret(prekeyPriv, senderPub)
	dh4 := ecdhSharedSecret(myPriv, senderPub)

	combined := make([]byte, 0, len(dh1)+len(dh2)+len(dh3)+len(dh4))
	combined = append(combined, dh1...)
	combined = append(combined, dh2...)
	combined = append(combined, dh3...)
	combined = append(combined, dh4...)

	info := []byte(fmt.Sprintf("aun-prekey-v2:%s", prekeyID))
	messageKey, err := hkdfDerive(combined, info, 32)
	if err != nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("HKDF 派生失败: %v", err))
	}

	// AAD 校验 + 解密
	var aadBytes []byte
	if aad, ok := payload["aad"].(map[string]any); ok {
		expected := m.buildInboundAADOffline(message, payload)
		if !aadMatchesOffline(expected, aad) {
			return nil, NewE2EEDecryptFailedError("AAD 不匹配")
		}
		aadBytes = aadBytesOffline(aad)
	}

	plaintext, err := aesGCMDecrypt(messageKey, nonce, ct, tag, aadBytes)
	if err != nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("AES-GCM 解密失败: %v", err))
	}

	var decoded map[string]any
	if err := json.Unmarshal(plaintext, &decoded); err != nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("解析明文 JSON 失败: %v", err))
	}

	result := copyMapShallow(message)
	result["payload"] = decoded
	result["encrypted"] = true
	result["e2ee"] = map[string]any{
		"encryption_mode": ModePrekeyECDHV2,
		"suite":           getStr(payload, "suite", SuiteP256),
		"prekey_id":       prekeyID,
	}
	return result, nil
}

// decryptMessageLongTerm 解密 long_term_key 模式的消息
func (m *E2EEManager) decryptMessageLongTerm(message map[string]any) (map[string]any, error) {
	payload := message["payload"].(map[string]any)

	ephPubBytes, err := base64.StdEncoding.DecodeString(payload["ephemeral_public_key"].(string))
	if err != nil {
		return nil, NewE2EEDecryptFailedError("解码 ephemeral key 失败")
	}
	nonce, _ := base64.StdEncoding.DecodeString(payload["nonce"].(string))
	ct, _ := base64.StdEncoding.DecodeString(payload["ciphertext"].(string))
	tag, _ := base64.StdEncoding.DecodeString(payload["tag"].(string))

	// 加载接收方 identity 私钥
	myPriv, err := m.loadMyIdentityPrivate()
	if err != nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("identity 私钥加载失败: %v", err))
	}

	// 获取发送方公钥
	fromAID := ""
	if f, ok := message["from"].(string); ok {
		fromAID = f
	} else if aad, ok := payload["aad"].(map[string]any); ok {
		fromAID, _ = aad["from"].(string)
	}
	senderPub := m.loadSenderPublicKey(fromAID)
	if senderPub == nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("发送方 %s 公钥不可用", fromAID))
	}

	// 解析临时公钥
	ephPubX, ephPubY := elliptic.Unmarshal(elliptic.P256(), ephPubBytes)
	if ephPubX == nil {
		return nil, NewE2EEDecryptFailedError("解析 ephemeral 公钥失败")
	}
	ephPub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: ephPubX, Y: ephPubY}

	// 二路 ECDH
	dh1 := ecdhSharedSecret(myPriv, ephPub)
	dh2 := ecdhSharedSecret(myPriv, senderPub)

	combined := make([]byte, 0, len(dh1)+len(dh2))
	combined = append(combined, dh1...)
	combined = append(combined, dh2...)

	messageKey, err := hkdfDerive(combined, []byte("aun-longterm-v2"), 32)
	if err != nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("HKDF 派生失败: %v", err))
	}

	// AAD 校验 + 解密
	var aadBytes []byte
	if aad, ok := payload["aad"].(map[string]any); ok {
		expected := m.buildInboundAADOffline(message, payload)
		if !aadMatchesOffline(expected, aad) {
			return nil, NewE2EEDecryptFailedError("AAD 不匹配")
		}
		aadBytes = aadBytesOffline(aad)
	}

	plaintext, err := aesGCMDecrypt(messageKey, nonce, ct, tag, aadBytes)
	if err != nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("AES-GCM 解密失败: %v", err))
	}

	var decoded map[string]any
	if err := json.Unmarshal(plaintext, &decoded); err != nil {
		return nil, NewE2EEDecryptFailedError(fmt.Sprintf("解析明文 JSON 失败: %v", err))
	}

	result := copyMapShallow(message)
	result["payload"] = decoded
	result["encrypted"] = true
	result["e2ee"] = map[string]any{
		"encryption_mode": ModeLongTermKey,
		"suite":           getStr(payload, "suite", SuiteP256),
	}
	return result, nil
}

// ── Prekey 生成 ──────────────────────────────────────────

// GeneratePrekey 生成新的 prekey 并保存私钥到本地 keystore
// 返回 dict 包含 prekey_id、public_key、signature、created_at，可直接用于 RPC 上传
func (m *E2EEManager) GeneratePrekey() (map[string]any, error) {
	ks := m.keystore
	if ks == nil {
		return nil, NewE2EEError("keystore 不可用", "E2EE_NO_KEYSTORE")
	}
	aid := m.currentAID()
	if aid == "" {
		return nil, NewE2EEError("AID 不可用", "E2EE_NO_AID")
	}

	// 生成新 P-256 密钥对
	privKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("生成 prekey 失败: %w", err)
	}

	// 公钥 DER（SubjectPublicKeyInfo）
	pubDER, err := x509.MarshalPKIXPublicKey(&privKey.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("序列化 prekey 公钥失败: %w", err)
	}

	prekeyID := generateUUID4()
	pubKeyB64 := base64.StdEncoding.EncodeToString(pubDER)
	nowMs := time.Now().UnixMilli()

	// 签名: prekey_id|public_key|created_at
	signData := []byte(fmt.Sprintf("%s|%s|%d", prekeyID, pubKeyB64, nowMs))
	sig, err := m.signBytes(signData)
	if err != nil {
		return nil, fmt.Errorf("签名 prekey 失败: %w", err)
	}

	// 私钥 PEM
	pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(privKey)
	if err != nil {
		return nil, fmt.Errorf("序列化 prekey 私钥失败: %w", err)
	}
	privKeyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8Bytes}))

	// 保存到 keystore metadata
	metadata, err := ks.LoadMetadata(aid)
	if err != nil || metadata == nil {
		metadata = make(map[string]any)
	}
	localPrekeys, _ := metadata["e2ee_prekeys"].(map[string]any)
	if localPrekeys == nil {
		localPrekeys = make(map[string]any)
	}
	localPrekeys[prekeyID] = map[string]any{
		"private_key_pem": privKeyPEM,
		"created_at":      nowMs,
	}
	metadata["e2ee_prekeys"] = localPrekeys
	if err := ks.SaveMetadata(aid, metadata); err != nil {
		return nil, fmt.Errorf("保存 prekey 元数据失败: %w", err)
	}

	// 内存缓存私钥
	m.mu.Lock()
	m.localPrekeyCache[prekeyID] = privKey
	m.mu.Unlock()

	// 清理过期 prekey
	m.cleanupExpiredPrekeys(ks, aid)

	return map[string]any{
		"prekey_id":  prekeyID,
		"public_key": pubKeyB64,
		"signature":  sig,
		"created_at": nowMs,
	}, nil
}

// cleanupExpiredPrekeys 清理过期的本地 prekey 私钥
func (m *E2EEManager) cleanupExpiredPrekeys(ks keystore.KeyStore, aid string) {
	metadata, err := ks.LoadMetadata(aid)
	if err != nil || metadata == nil {
		return
	}
	localPrekeys, _ := metadata["e2ee_prekeys"].(map[string]any)
	if len(localPrekeys) == 0 {
		return
	}

	nowMs := time.Now().UnixMilli()
	cutoffMs := nowMs - PrekeyRetentionSeconds*1000

	var expired []string
	for pid, data := range localPrekeys {
		if pd, ok := data.(map[string]any); ok {
			createdAt := toInt64(pd["created_at"])
			if createdAt < cutoffMs {
				expired = append(expired, pid)
			}
		}
	}

	if len(expired) > 0 {
		m.mu.Lock()
		for _, pid := range expired {
			delete(localPrekeys, pid)
			delete(m.localPrekeyCache, pid)
		}
		m.mu.Unlock()
		metadata["e2ee_prekeys"] = localPrekeys
		_ = ks.SaveMetadata(aid, metadata)
	}
}

// loadPrekeyPrivateKey 从内存缓存或 keystore 加载 prekey 私钥
func (m *E2EEManager) loadPrekeyPrivateKey(prekeyID string) *ecdsa.PrivateKey {
	// 优先内存缓存
	m.mu.RLock()
	cached := m.localPrekeyCache[prekeyID]
	m.mu.RUnlock()
	if cached != nil {
		return cached
	}

	aid := m.currentAID()
	if aid == "" {
		return nil
	}
	metadata, err := m.keystore.LoadMetadata(aid)
	if err != nil || metadata == nil {
		return nil
	}
	prekeys, _ := metadata["e2ee_prekeys"].(map[string]any)
	prekeyData, _ := prekeys[prekeyID].(map[string]any)
	if prekeyData == nil {
		return nil
	}
	privPEM, _ := prekeyData["private_key_pem"].(string)
	if privPEM == "" {
		return nil
	}

	pk, err := parseECPrivateKeyPEM(privPEM)
	if err != nil {
		log.Printf("[e2ee] prekey %s 私钥加载失败: %v", prekeyID, err)
		return nil
	}

	// 回填内存缓存
	m.mu.Lock()
	m.localPrekeyCache[prekeyID] = pk
	m.mu.Unlock()
	return pk
}

// ── AAD 工具 ─────────────────────────────────────────────

// aadBytesOffline 序列化 P2P AAD（排序键 + 紧凑格式）
func aadBytesOffline(aad map[string]any) []byte {
	filtered := make(map[string]any, len(aadFieldsOffline))
	for _, field := range aadFieldsOffline {
		filtered[field] = aad[field]
	}
	data, _ := json.Marshal(filtered)
	return data
}

// aadMatchesOffline P2P AAD 字段匹配检查
func aadMatchesOffline(expected, actual map[string]any) bool {
	for _, field := range aadMatchFieldsOffline {
		ev, av := expected[field], actual[field]
		// nil 和 "" 视为等价（long_term_key 模式无 prekey_id 字段）
		es := fmt.Sprintf("%v", ev)
		as := fmt.Sprintf("%v", av)
		if ev == nil {
			es = ""
		}
		if av == nil {
			as = ""
		}
		if es != as {
			return false
		}
	}
	return true
}

// buildInboundAADOffline 从收到的消息构建预期 AAD
func (m *E2EEManager) buildInboundAADOffline(message, payload map[string]any) map[string]any {
	aad, _ := payload["aad"].(map[string]any)
	senderFP := ""
	if fp, ok := payload["sender_cert_fingerprint"].(string); ok {
		senderFP = fp
	} else if aad != nil {
		senderFP, _ = aad["sender_cert_fingerprint"].(string)
	}
	prekeyID := ""
	if pid, ok := payload["prekey_id"].(string); ok {
		prekeyID = pid
	} else if aad != nil {
		prekeyID, _ = aad["prekey_id"].(string)
	}

	return map[string]any{
		"from":                       message["from"],
		"to":                         message["to"],
		"message_id":                 message["message_id"],
		"timestamp":                  message["timestamp"],
		"encryption_mode":            payload["encryption_mode"],
		"suite":                      getStr(payload, "suite", SuiteP256),
		"ephemeral_public_key":       payload["ephemeral_public_key"],
		"recipient_cert_fingerprint": m.localCertFingerprint(),
		"sender_cert_fingerprint":    senderFP,
		"prekey_id":                  prekeyID,
	}
}

// ── 证书指纹工具 ────────────────────────────────────────

// fingerprintCertPEM 从 PEM 证书计算公钥 SHA-256 指纹
func fingerprintCertPEM(certPEM []byte) string {
	cert, err := parseCertPEM(certPEM)
	if err != nil {
		return ""
	}
	return internal.CertFingerprint(cert)
}

// localCertFingerprint 返回当前身份的证书指纹
func (m *E2EEManager) localCertFingerprint() string {
	return m.localIdentityFingerprint()
}

// localIdentityFingerprint 计算当前身份的公钥指纹
func (m *E2EEManager) localIdentityFingerprint() string {
	identity := m.identityFn()
	// 优先使用 public_key_der_b64
	if pubDERB64, ok := identity["public_key_der_b64"].(string); ok && pubDERB64 != "" {
		der, err := base64.StdEncoding.DecodeString(pubDERB64)
		if err == nil {
			return internal.PEMFingerprint(der)
		}
	}
	// 尝试从证书获取
	if certPEM, ok := identity["cert"].(string); ok && certPEM != "" {
		cert, err := parseCertPEM([]byte(certPEM))
		if err == nil {
			return internal.CertFingerprint(cert)
		}
	}
	// 从私钥派生公钥
	if privPEM, ok := identity["private_key_pem"].(string); ok && privPEM != "" {
		pk, err := parseECPrivateKeyPEM(privPEM)
		if err == nil {
			der, err := x509.MarshalPKIXPublicKey(&pk.PublicKey)
			if err == nil {
				return internal.PEMFingerprint(der)
			}
		}
	}
	return ""
}

// ── 签名工具 ─────────────────────────────────────────────

// signBytes 用当前身份私钥签名数据，返回 base64 编码的签名
func (m *E2EEManager) signBytes(data []byte) (string, error) {
	identity := m.identityFn()
	privPEM, _ := identity["private_key_pem"].(string)
	if privPEM == "" {
		return "", fmt.Errorf("identity 私钥不可用")
	}
	pk, err := parseECPrivateKeyPEM(privPEM)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(data)
	sig, err := ecdsa.SignASN1(rand.Reader, pk, hash[:])
	if err != nil {
		return "", fmt.Errorf("ECDSA 签名失败: %w", err)
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

// loadSenderIdentityPrivate 加载发送方自己的 identity 私钥
func (m *E2EEManager) loadSenderIdentityPrivate() (*ecdsa.PrivateKey, error) {
	identity := m.identityFn()
	privPEM, _ := identity["private_key_pem"].(string)
	if privPEM == "" {
		return nil, fmt.Errorf("发送方 identity 私钥不可用")
	}
	return parseECPrivateKeyPEM(privPEM)
}

// loadMyIdentityPrivate 加载接收方自己的 identity 私钥（从 keystore）
func (m *E2EEManager) loadMyIdentityPrivate() (*ecdsa.PrivateKey, error) {
	aid := m.currentAID()
	if aid == "" {
		return nil, fmt.Errorf("AID 不可用")
	}
	keyPair, err := m.keystore.LoadKeyPair(aid)
	if err != nil || keyPair == nil {
		return nil, fmt.Errorf("密钥对加载失败")
	}
	privPEM, _ := keyPair["private_key_pem"].(string)
	if privPEM == "" {
		return nil, fmt.Errorf("identity 私钥不存在")
	}
	return parseECPrivateKeyPEM(privPEM)
}

// getSenderCert 获取发送方证书
func (m *E2EEManager) getSenderCert(aid string) []byte {
	if m.keystore == nil {
		return nil
	}
	certPEM, err := m.keystore.LoadCert(aid)
	if err != nil || certPEM == "" {
		return nil
	}
	return []byte(certPEM)
}

// loadSenderPublicKey 获取发送方的 identity EC 公钥（从证书）
func (m *E2EEManager) loadSenderPublicKey(aid string) *ecdsa.PublicKey {
	if aid == "" {
		return nil
	}
	certPEM := m.getSenderCert(aid)
	if certPEM == nil {
		return nil
	}
	cert, err := parseCertPEM(certPEM)
	if err != nil {
		return nil
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return nil
	}
	return pub
}

// currentAID 获取当前 AID
func (m *E2EEManager) currentAID() string {
	identity := m.identityFn()
	if aid, ok := identity["aid"].(string); ok {
		return aid
	}
	return ""
}

// ── 底层加密工具 ─────────────────────────────────────────

// ecdhSharedSecret 使用 elliptic.P256 执行 ECDH，返回共享密钥（x 坐标）
func ecdhSharedSecret(priv *ecdsa.PrivateKey, pub *ecdsa.PublicKey) []byte {
	x, _ := priv.Curve.ScalarMult(pub.X, pub.Y, priv.D.Bytes())
	// 固定 32 字节输出（P-256）
	b := x.Bytes()
	if len(b) < 32 {
		padded := make([]byte, 32)
		copy(padded[32-len(b):], b)
		return padded
	}
	return b
}

// hkdfDerive HKDF-SHA256 密钥派生
func hkdfDerive(secret, info []byte, length int) ([]byte, error) {
	reader := hkdf.New(sha256.New, secret, nil, info)
	key := make([]byte, length)
	if _, err := io.ReadFull(reader, key); err != nil {
		return nil, err
	}
	return key, nil
}

// aesGCMDecrypt AES-256-GCM 解密（ciphertext + tag 分离输入）
func aesGCMDecrypt(key, nonce, ciphertext, tag, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	// Go 的 GCM.Open 期望 ciphertext+tag 连接在一起
	ct := make([]byte, 0, len(ciphertext)+len(tag))
	ct = append(ct, ciphertext...)
	ct = append(ct, tag...)
	return gcm.Open(nil, nonce, ct, aad)
}

// ecdsaVerify 验证 ECDSA-SHA256 签名
func ecdsaVerify(pub *ecdsa.PublicKey, data, sig []byte) bool {
	hash := sha256.Sum256(data)
	return ecdsa.VerifyASN1(pub, hash[:], sig)
}

// parseCertPEM 解析 PEM 证书
func parseCertPEM(pemData []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, fmt.Errorf("无法解析 PEM 格式")
	}
	return x509.ParseCertificate(block.Bytes)
}

// parseECPrivateKeyPEM 从 PEM 解析 EC 私钥
func parseECPrivateKeyPEM(pemStr string) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("无法解析 PEM 格式私钥")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		// 尝试 EC 私钥格式
		ecKey, err2 := x509.ParseECPrivateKey(block.Bytes)
		if err2 != nil {
			return nil, fmt.Errorf("解析私钥失败: PKCS8=%v, EC=%v", err, err2)
		}
		return ecKey, nil
	}
	ecKey, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("私钥类型不是 ECDSA")
	}
	return ecKey, nil
}

// parseECPublicKeyDER 从 DER（SubjectPublicKeyInfo）解析 EC 公钥
func parseECPublicKeyDER(der []byte) (*ecdsa.PublicKey, error) {
	pub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	ecPub, ok := pub.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("公钥不是 EC 类型")
	}
	return ecPub, nil
}

// ── 辅助函数 ─────────────────────────────────────────────

// copyMapShallow 浅拷贝 map
func copyMapShallow(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

// getStr 从 map 获取字符串，不存在时返回默认值
func getStr(m map[string]any, key, defaultVal string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return defaultVal
}

// toInt64 将 any 转换为 int64
func toInt64(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}

// getTimestamp 从消息中提取 timestamp
func getTimestamp(message, payload map[string]any) int64 {
	if ts := toInt64(message["timestamp"]); ts > 0 {
		return ts
	}
	if aad, ok := payload["aad"].(map[string]any); ok {
		return toInt64(aad["timestamp"])
	}
	return 0
}

// abs64 int64 绝对值
func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

