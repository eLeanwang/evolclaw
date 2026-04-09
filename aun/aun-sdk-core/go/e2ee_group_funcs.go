package aun

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/aun-sdk-core/go/keystore"
	"golang.org/x/crypto/hkdf"
)

// ── 群组 AAD 字段 ──────────────────────────────────────────

var (
	aadFieldsGroup = []string{
		"group_id", "from", "message_id", "timestamp",
		"epoch", "encryption_mode", "suite",
	}
	aadMatchFieldsGroup = []string{
		"group_id", "from", "message_id",
		"epoch", "encryption_mode", "suite",
	}
)

// ── 群组消息加密（纯函数）──────────────────────────────────

// EncryptGroupMessage 加密群组消息，返回 e2ee.group_encrypted 信封
// senderPrivateKeyPEM 可选，传入时附加发送方 ECDSA 签名（不可否认性）
func EncryptGroupMessage(
	groupSecret []byte,
	payload map[string]any,
	groupID, senderAID, messageID string,
	timestamp int64,
	epoch int,
	senderPrivateKeyPEM string,
) (map[string]any, error) {
	// 派生单条消息密钥
	msgKey, err := deriveGroupMsgKey(groupSecret, groupID, messageID)
	if err != nil {
		return nil, fmt.Errorf("群消息密钥派生失败: %w", err)
	}

	plaintext, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化 payload 失败: %w", err)
	}

	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("生成 nonce 失败: %w", err)
	}

	aad := map[string]any{
		"group_id":        groupID,
		"from":            senderAID,
		"message_id":      messageID,
		"timestamp":       timestamp,
		"epoch":           epoch,
		"encryption_mode": ModeEpochGroupKey,
		"suite":           SuiteP256,
	}
	aadBytes := aadBytesGroup(aad)

	block, err := aes.NewCipher(msgKey)
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
		"type":            "e2ee.group_encrypted",
		"version":         "1",
		"encryption_mode": ModeEpochGroupKey,
		"suite":           SuiteP256,
		"epoch":           epoch,
		"nonce":           base64.StdEncoding.EncodeToString(nonce),
		"ciphertext":      base64.StdEncoding.EncodeToString(ciphertext),
		"tag":             base64.StdEncoding.EncodeToString(tag),
		"aad":             aad,
	}

	// 发送方签名
	if senderPrivateKeyPEM != "" {
		pk, err := parseECPrivateKeyPEM(senderPrivateKeyPEM)
		if err == nil {
			signPayload := make([]byte, 0, len(ciphertext)+len(tag)+len(aadBytes))
			signPayload = append(signPayload, ciphertext...)
			signPayload = append(signPayload, tag...)
			signPayload = append(signPayload, aadBytes...)
			hash := sha256.Sum256(signPayload)
			sig, err := ecdsa.SignASN1(rand.Reader, pk, hash[:])
			if err == nil {
				envelope["sender_signature"] = base64.StdEncoding.EncodeToString(sig)
				// 公钥指纹
				pubDER, _ := x509.MarshalPKIXPublicKey(&pk.PublicKey)
				fp := sha256.Sum256(pubDER)
				envelope["sender_cert_fingerprint"] = fmt.Sprintf("sha256:%x", fp)
			} else {
				log.Printf("[e2ee_group] 群消息发送方签名失败: %v", err)
			}
		} else {
			log.Printf("[e2ee_group] 解析发送方私钥失败: %v", err)
		}
	}

	return envelope, nil
}

// DecryptGroupMessage 解密群组消息（纯函数）
// groupSecrets: {epoch: groupSecretBytes} 映射
// senderCertPEM: 发送方证书，用于验证签名
// requireSignature: 为 true 时强制要求签名 + 证书验证
func DecryptGroupMessage(
	groupSecrets map[int][]byte,
	message map[string]any,
	senderCertPEM []byte,
	requireSignature bool,
) map[string]any {
	payload, ok := message["payload"].(map[string]any)
	if !ok {
		return nil
	}
	payloadType, _ := payload["type"].(string)
	if payloadType != "e2ee.group_encrypted" {
		return nil
	}

	epoch := int(toInt64(payload["epoch"]))
	groupSecret, ok := groupSecrets[epoch]
	if !ok {
		return nil
	}

	// 解析 AAD 和路由字段
	aad, _ := payload["aad"].(map[string]any)
	outerGroupID, _ := message["group_id"].(string)

	var groupID, msgID, aadFrom string
	if aad != nil {
		groupID, _ = aad["group_id"].(string)
		if groupID == "" {
			groupID = outerGroupID
		}
		msgID, _ = aad["message_id"].(string)
		if msgID == "" {
			msgID, _ = message["message_id"].(string)
		}
		aadFrom, _ = aad["from"].(string)

		// 外层路由字段校验
		if outerGroupID != "" && groupID != outerGroupID {
			return nil
		}
		if aadFrom != "" {
			outerFrom, _ := message["from"].(string)
			outerSender, _ := message["sender_aid"].(string)
			if outerFrom != "" && outerFrom != aadFrom {
				return nil
			}
			if outerSender != "" && outerSender != aadFrom {
				return nil
			}
		}
	} else {
		groupID = outerGroupID
		msgID, _ = message["message_id"].(string)
	}

	if groupID == "" || msgID == "" {
		return nil
	}

	// 派生消息密钥 + 解密
	msgKey, err := deriveGroupMsgKey(groupSecret, groupID, msgID)
	if err != nil {
		return nil
	}

	nonce, _ := base64.StdEncoding.DecodeString(payload["nonce"].(string))
	ciphertext, _ := base64.StdEncoding.DecodeString(payload["ciphertext"].(string))
	tag, _ := base64.StdEncoding.DecodeString(payload["tag"].(string))

	var aadBytes []byte
	if aad != nil {
		aadBytes = aadBytesGroup(aad)
	}

	plaintext, err := aesGCMDecrypt(msgKey, nonce, ciphertext, tag, aadBytes)
	if err != nil {
		return nil
	}

	var decoded map[string]any
	if err := json.Unmarshal(plaintext, &decoded); err != nil {
		return nil
	}

	result := copyMapShallow(message)
	result["payload"] = decoded
	result["encrypted"] = true
	result["e2ee"] = map[string]any{
		"encryption_mode": ModeEpochGroupKey,
		"suite":           SuiteP256,
		"epoch":           epoch,
		"sender_verified": false,
	}

	// 发送方签名验证
	sigB64, _ := payload["sender_signature"].(string)

	if requireSignature {
		// 零信任模式：必须有签名且有证书
		if sigB64 == "" {
			log.Printf("[e2ee_group] 拒绝无签名群消息: group=%s from=%s", groupID, aadFrom)
			return nil
		}
		if senderCertPEM == nil {
			log.Printf("[e2ee_group] 拒绝群消息：有签名但无证书: group=%s from=%s", groupID, aadFrom)
			return nil
		}
		if !verifyGroupSenderSignature(senderCertPEM, sigB64, ciphertext, tag, aadBytes) {
			log.Printf("[e2ee_group] 群消息签名验证失败: group=%s from=%s", groupID, aadFrom)
			return nil
		}
		result["e2ee"].(map[string]any)["sender_verified"] = true
	} else if senderCertPEM != nil {
		// 非零信任但有证书：有证书时强制验签
		if sigB64 == "" {
			log.Printf("[e2ee_group] 拒绝无签名群消息: group=%s from=%s", groupID, aadFrom)
			return nil
		}
		if !verifyGroupSenderSignature(senderCertPEM, sigB64, ciphertext, tag, aadBytes) {
			log.Printf("[e2ee_group] 群消息签名验证失败: group=%s from=%s", groupID, aadFrom)
			return nil
		}
		result["e2ee"].(map[string]any)["sender_verified"] = true
	}

	return result
}

// verifyGroupSenderSignature 验证群消息发送方签名
func verifyGroupSenderSignature(certPEM []byte, sigB64 string, ciphertext, tag, aadBytes []byte) bool {
	cert, err := parseCertPEM(certPEM)
	if err != nil {
		return false
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return false
	}
	sigBytes, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return false
	}
	verifyPayload := make([]byte, 0, len(ciphertext)+len(tag)+len(aadBytes))
	verifyPayload = append(verifyPayload, ciphertext...)
	verifyPayload = append(verifyPayload, tag...)
	verifyPayload = append(verifyPayload, aadBytes...)
	hash := sha256.Sum256(verifyPayload)
	return ecdsa.VerifyASN1(pub, hash[:], sigBytes)
}

// ── Membership Commitment ──────────────────────────────────

// ComputeMembershipCommitment 计算成员承诺哈希
// commitment = SHA-256(sort(aids).join("|") + "|" + str(epoch) + "|" + group_id + "|" + SHA256(group_secret).hex())
func ComputeMembershipCommitment(memberAIDs []string, epoch int, groupID string, groupSecret []byte) string {
	sorted := make([]string, len(memberAIDs))
	copy(sorted, memberAIDs)
	sort.Strings(sorted)

	secretHash := sha256.Sum256(groupSecret)
	data := strings.Join(sorted, "|") + "|" + fmt.Sprintf("%d", epoch) + "|" + groupID + "|" + fmt.Sprintf("%x", secretHash)

	hash := sha256.Sum256([]byte(data))
	return fmt.Sprintf("%x", hash)
}

// VerifyMembershipCommitment 验证成员承诺
// 1. 重算 commitment 是否匹配
// 2. 检查 myAID 是否在 memberAIDs 中
func VerifyMembershipCommitment(commitment string, memberAIDs []string, epoch int, groupID, myAID string, groupSecret []byte) bool {
	found := false
	for _, aid := range memberAIDs {
		if aid == myAID {
			found = true
			break
		}
	}
	if !found {
		return false
	}
	expected := ComputeMembershipCommitment(memberAIDs, epoch, groupID, groupSecret)
	// 常量时间比较
	if len(expected) != len(commitment) {
		return false
	}
	result := byte(0)
	for i := 0; i < len(expected); i++ {
		result |= expected[i] ^ commitment[i]
	}
	return result == 0
}

// ── Membership Manifest ────────────────────────────────────

// BuildMembershipManifest 构建 Membership Manifest（未签名）
func BuildMembershipManifest(
	groupID string, epoch int, prevEpoch *int,
	memberAIDs, added, removed []string,
	initiatorAID string,
) map[string]any {
	sortedMembers := make([]string, len(memberAIDs))
	copy(sortedMembers, memberAIDs)
	sort.Strings(sortedMembers)

	sortedAdded := make([]string, 0)
	if added != nil {
		sortedAdded = make([]string, len(added))
		copy(sortedAdded, added)
		sort.Strings(sortedAdded)
	}

	sortedRemoved := make([]string, 0)
	if removed != nil {
		sortedRemoved = make([]string, len(removed))
		copy(sortedRemoved, removed)
		sort.Strings(sortedRemoved)
	}

	result := map[string]any{
		"manifest_version": 1,
		"group_id":         groupID,
		"epoch":            epoch,
		"prev_epoch":       prevEpoch,
		"member_aids":      sortedMembers,
		"added":            sortedAdded,
		"removed":          sortedRemoved,
		"initiator_aid":    initiatorAID,
		"issued_at":        time.Now().UnixMilli(),
	}
	return result
}

// manifestSignData 序列化 manifest 为签名输入
func manifestSignData(manifest map[string]any) []byte {
	prevEpochStr := ""
	if pe := manifest["prev_epoch"]; pe != nil {
		prevEpochStr = numToStr(pe)
	}

	memberAIDs := toStringSlice(manifest["member_aids"])
	addedAIDs := toStringSlice(manifest["added"])
	removedAIDs := toStringSlice(manifest["removed"])

	fields := []string{
		numToStr(manifest["manifest_version"]),
		fmt.Sprintf("%v", manifest["group_id"]),
		numToStr(manifest["epoch"]),
		prevEpochStr,
		strings.Join(memberAIDs, "|"),
		strings.Join(addedAIDs, "|"),
		strings.Join(removedAIDs, "|"),
		fmt.Sprintf("%v", manifest["initiator_aid"]),
		numToStr(manifest["issued_at"]),
	}
	return []byte(strings.Join(fields, "\n"))
}

// numToStr 将数值类型转为字符串（避免 float64 的科学计数法，处理指针类型）
func numToStr(v any) string {
	switch n := v.(type) {
	case float64:
		return fmt.Sprintf("%d", int64(n))
	case int:
		return fmt.Sprintf("%d", n)
	case int64:
		return fmt.Sprintf("%d", n)
	case *int:
		if n != nil {
			return fmt.Sprintf("%d", *n)
		}
		return ""
	case *int64:
		if n != nil {
			return fmt.Sprintf("%d", *n)
		}
		return ""
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", v)
	}
}

// SignMembershipManifest 签名 Membership Manifest
func SignMembershipManifest(manifest map[string]any, privateKeyPEM string) (map[string]any, error) {
	pk, err := parseECPrivateKeyPEM(privateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("解析私钥失败: %w", err)
	}
	signData := manifestSignData(manifest)
	hash := sha256.Sum256(signData)
	sig, err := ecdsa.SignASN1(rand.Reader, pk, hash[:])
	if err != nil {
		return nil, fmt.Errorf("签名失败: %w", err)
	}

	signed := copyMapShallow(manifest)
	signed["signature"] = base64.StdEncoding.EncodeToString(sig)
	return signed, nil
}

// VerifyMembershipManifest 验证 Membership Manifest 签名
func VerifyMembershipManifest(manifest map[string]any, initiatorCertPEM []byte) (bool, error) {
	sigB64, _ := manifest["signature"].(string)
	if sigB64 == "" {
		return false, nil
	}
	cert, err := parseCertPEM(initiatorCertPEM)
	if err != nil {
		return false, fmt.Errorf("解析证书失败: %w", err)
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return false, fmt.Errorf("证书非 EC 公钥")
	}
	sigBytes, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return false, fmt.Errorf("解码签名失败: %w", err)
	}
	signData := manifestSignData(manifest)
	hash := sha256.Sum256(signData)
	return ecdsa.VerifyASN1(pub, hash[:], sigBytes), nil
}

// ── Group Secret 生命周期管理 ──────────────────────────────

// GenerateGroupSecret 生成 32 字节随机 group_secret
func GenerateGroupSecret() []byte {
	secret := make([]byte, 32)
	_, _ = io.ReadFull(rand.Reader, secret)
	return secret
}

// StoreGroupSecret 存储 group_secret 到 keystore metadata
// 拒绝低于本地最新 epoch 的写入（防降级攻击）
// 返回 (true, nil) 已存储; (false, nil) epoch 降级被拒; (false, err) 存储出错
func StoreGroupSecret(ks keystore.KeyStore, aid, groupID string, epoch int, groupSecret []byte, commitment string, memberAIDs []string) (bool, error) {
	metadata, _ := ks.LoadMetadata(aid)
	if metadata == nil {
		metadata = make(map[string]any)
	}
	groupSecrets, _ := metadata["group_secrets"].(map[string]any)
	if groupSecrets == nil {
		groupSecrets = make(map[string]any)
	}
	existing, _ := groupSecrets[groupID].(map[string]any)

	// epoch 降级防护
	if existing != nil {
		localEpoch := int(toInt64(existing["epoch"]))
		if epoch < localEpoch {
			return false, nil
		}
	}

	// 旧 epoch 移入 old_epochs
	if existing != nil && int(toInt64(existing["epoch"])) != epoch {
		oldEpochs, _ := existing["old_epochs"].([]any)
		oldEntry := map[string]any{
			"epoch":      existing["epoch"],
			"secret":     existing["secret"],
			"commitment": existing["commitment"],
			"member_aids": existing["member_aids"],
			"updated_at": existing["updated_at"],
		}
		if sp, ok := existing["secret_protection"]; ok {
			oldEntry["secret_protection"] = sp
		}
		oldEpochs = append(oldEpochs, oldEntry)
		existing["old_epochs"] = oldEpochs
	}

	nowMs := time.Now().UnixMilli()
	sorted := make([]string, len(memberAIDs))
	copy(sorted, memberAIDs)
	sort.Strings(sorted)

	var prevOldEpochs []any
	if existing != nil {
		prevOldEpochs, _ = existing["old_epochs"].([]any)
	}

	groupSecrets[groupID] = map[string]any{
		"epoch":       epoch,
		"secret":      base64.StdEncoding.EncodeToString(groupSecret),
		"commitment":  commitment,
		"member_aids": sorted,
		"updated_at":  nowMs,
		"old_epochs":  prevOldEpochs,
	}
	metadata["group_secrets"] = groupSecrets

	if err := ks.SaveMetadata(aid, metadata); err != nil {
		return false, fmt.Errorf("保存 group_secret 失败: %w", err)
	}
	return true, nil
}

// LoadGroupSecret 加载 group_secret
// epoch=nil 时返回最新 epoch；指定 epoch 时先查当前再查 old_epochs
func LoadGroupSecret(ks keystore.KeyStore, aid, groupID string, epoch *int) (map[string]any, error) {
	metadata, err := ks.LoadMetadata(aid)
	if err != nil || metadata == nil {
		return nil, err
	}
	groupSecrets, _ := metadata["group_secrets"].(map[string]any)
	entry, _ := groupSecrets[groupID].(map[string]any)
	if entry == nil {
		return nil, nil
	}

	entryEpoch := int(toInt64(entry["epoch"]))
	if epoch == nil || entryEpoch == *epoch {
		secretStr, _ := entry["secret"].(string)
		if secretStr == "" {
			return nil, nil
		}
		secretBytes, err := base64.StdEncoding.DecodeString(secretStr)
		if err != nil {
			return nil, nil
		}
		return map[string]any{
			"epoch":       entryEpoch,
			"secret":      secretBytes,
			"commitment":  entry["commitment"],
			"member_aids": toStringSlice(entry["member_aids"]),
		}, nil
	}

	// 查 old_epochs
	oldEpochs, _ := entry["old_epochs"].([]any)
	for _, oldRaw := range oldEpochs {
		old, ok := oldRaw.(map[string]any)
		if !ok {
			continue
		}
		oldEp := int(toInt64(old["epoch"]))
		if oldEp == *epoch {
			secretStr, _ := old["secret"].(string)
			if secretStr == "" {
				return nil, nil
			}
			secretBytes, err := base64.StdEncoding.DecodeString(secretStr)
			if err != nil {
				return nil, nil
			}
			return map[string]any{
				"epoch":       oldEp,
				"secret":      secretBytes,
				"commitment":  old["commitment"],
				"member_aids": toStringSlice(old["member_aids"]),
			}, nil
		}
	}

	return nil, nil
}

// LoadAllGroupSecrets 加载某群组所有 epoch 的 group_secret
// 返回 {epoch: secretBytes} 映射
func LoadAllGroupSecrets(ks keystore.KeyStore, aid, groupID string) map[int][]byte {
	metadata, _ := ks.LoadMetadata(aid)
	if metadata == nil {
		return nil
	}
	groupSecrets, _ := metadata["group_secrets"].(map[string]any)
	entry, _ := groupSecrets[groupID].(map[string]any)
	if entry == nil {
		return nil
	}

	result := make(map[int][]byte)

	secretStr, _ := entry["secret"].(string)
	entryEpoch := int(toInt64(entry["epoch"]))
	if secretStr != "" {
		if decoded, err := base64.StdEncoding.DecodeString(secretStr); err == nil {
			result[entryEpoch] = decoded
		}
	}

	oldEpochs, _ := entry["old_epochs"].([]any)
	for _, oldRaw := range oldEpochs {
		old, ok := oldRaw.(map[string]any)
		if !ok {
			continue
		}
		oldSecret, _ := old["secret"].(string)
		oldEp := int(toInt64(old["epoch"]))
		if oldSecret != "" {
			if decoded, err := base64.StdEncoding.DecodeString(oldSecret); err == nil {
				result[oldEp] = decoded
			}
		}
	}

	return result
}

// CleanupOldEpochs 清理过期的旧 epoch 记录，返回 (清理数量, error)
func CleanupOldEpochs(ks keystore.KeyStore, aid, groupID string, retentionSeconds int) (int, error) {
	metadata, err := ks.LoadMetadata(aid)
	if err != nil || metadata == nil {
		return 0, err
	}
	groupSecrets, _ := metadata["group_secrets"].(map[string]any)
	entry, _ := groupSecrets[groupID].(map[string]any)
	if entry == nil {
		return 0, nil
	}

	oldEpochs, _ := entry["old_epochs"].([]any)
	if len(oldEpochs) == 0 {
		return 0, nil
	}

	cutoffMs := time.Now().UnixMilli() - int64(retentionSeconds)*1000
	var remaining []any
	for _, oldRaw := range oldEpochs {
		old, ok := oldRaw.(map[string]any)
		if !ok {
			continue
		}
		updatedAt := toInt64(old["updated_at"])
		if updatedAt >= cutoffMs {
			remaining = append(remaining, old)
		}
	}

	removed := len(oldEpochs) - len(remaining)
	if removed > 0 {
		entry["old_epochs"] = remaining
		if err := ks.SaveMetadata(aid, metadata); err != nil {
			return 0, err
		}
	}
	return removed, nil
}

// ── GroupReplayGuard 群组消息防重放守卫 ──────────────────────

// GroupReplayGuard 群组消息防重放守卫
// key = "{group_id}:{sender_aid}:{message_id}"，内置 LRU 裁剪
type GroupReplayGuard struct {
	mu      sync.Mutex
	seen    map[string]bool
	maxSize int
}

// NewGroupReplayGuard 创建防重放守卫
func NewGroupReplayGuard(maxSize int) *GroupReplayGuard {
	if maxSize <= 0 {
		maxSize = 50000
	}
	return &GroupReplayGuard{
		seen:    make(map[string]bool),
		maxSize: maxSize,
	}
}

// CheckAndRecord 检查并记录。返回 true 表示首次（通过），false 表示重放
func (g *GroupReplayGuard) CheckAndRecord(groupID, senderAID, messageID string) bool {
	key := groupID + ":" + senderAID + ":" + messageID
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.seen[key] {
		return false
	}
	g.seen[key] = true
	g.trim()
	return true
}

// IsSeen 仅检查是否已记录
func (g *GroupReplayGuard) IsSeen(groupID, senderAID, messageID string) bool {
	key := groupID + ":" + senderAID + ":" + messageID
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.seen[key]
}

// Record 仅记录，不检查
func (g *GroupReplayGuard) Record(groupID, senderAID, messageID string) {
	key := groupID + ":" + senderAID + ":" + messageID
	g.mu.Lock()
	defer g.mu.Unlock()
	g.seen[key] = true
	g.trim()
}

// Size 返回已记录的数量
func (g *GroupReplayGuard) Size() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.seen)
}

// trim LRU 裁剪（需在持锁状态调用）
func (g *GroupReplayGuard) trim() {
	if len(g.seen) > g.maxSize {
		trimCount := len(g.seen) - int(float64(g.maxSize)*0.8)
		i := 0
		for k := range g.seen {
			if i >= trimCount {
				break
			}
			delete(g.seen, k)
			i++
		}
	}
}

// ── GroupKeyRequestThrottle 密钥请求频率限制 ────────────────

// GroupKeyRequestThrottle 群组密钥请求/响应频率限制
type GroupKeyRequestThrottle struct {
	mu       sync.Mutex
	last     map[string]float64
	cooldown float64
}

// NewGroupKeyRequestThrottle 创建频率限制器
func NewGroupKeyRequestThrottle(cooldown float64) *GroupKeyRequestThrottle {
	if cooldown <= 0 {
		cooldown = 30.0
	}
	return &GroupKeyRequestThrottle{
		last:     make(map[string]float64),
		cooldown: cooldown,
	}
}

// Allow 检查是否允许操作。返回 true 并记录时间戳，或 false 表示被限制
func (t *GroupKeyRequestThrottle) Allow(key string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := float64(time.Now().UnixMilli()) / 1000.0
	if last, ok := t.last[key]; ok && (now-last) < t.cooldown {
		return false
	}
	t.last[key] = now
	return true
}

// Reset 重置指定 key 的频率限制
func (t *GroupKeyRequestThrottle) Reset(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.last, key)
}

// ── Group Key 分发与恢复协议 ──────────────────────────────

// BuildKeyDistribution 构建 group key 分发消息 payload
// manifest: 可选的已签名 Membership Manifest
func BuildKeyDistribution(
	groupID string, epoch int, groupSecret []byte,
	memberAIDs []string, distributedBy string,
	manifest map[string]any,
) map[string]any {
	commitment := ComputeMembershipCommitment(memberAIDs, epoch, groupID, groupSecret)
	sorted := make([]string, len(memberAIDs))
	copy(sorted, memberAIDs)
	sort.Strings(sorted)

	result := map[string]any{
		"type":           "e2ee.group_key_distribution",
		"group_id":       groupID,
		"epoch":          epoch,
		"group_secret":   base64.StdEncoding.EncodeToString(groupSecret),
		"commitment":     commitment,
		"member_aids":    sorted,
		"distributed_by": distributedBy,
		"distributed_at": time.Now().UnixMilli(),
	}
	if manifest != nil {
		result["manifest"] = manifest
	}
	return result
}

// HandleKeyDistribution 处理收到的 group key 分发消息
// 验证 manifest 签名 -> commitment -> 成员资格 -> 存储
func HandleKeyDistribution(
	message map[string]any,
	ks keystore.KeyStore,
	aid string,
	initiatorCertPEM []byte,
) bool {
	payload := extractPayload(message)

	groupID, _ := payload["group_id"].(string)
	epoch := int(toInt64(payload["epoch"]))
	secretB64, _ := payload["group_secret"].(string)
	commitment, _ := payload["commitment"].(string)
	memberAIDs := toStringSlice(payload["member_aids"])

	if groupID == "" || secretB64 == "" || commitment == "" {
		return false
	}

	// 验证 Membership Manifest 签名
	manifest, _ := payload["manifest"].(map[string]any)
	if initiatorCertPEM != nil {
		if manifest == nil {
			log.Printf("[e2ee_group] 拒绝无 manifest 的密钥分发: group=%s epoch=%d", groupID, epoch)
			return false
		}
		valid, _ := VerifyMembershipManifest(manifest, initiatorCertPEM)
		if !valid {
			log.Printf("[e2ee_group] manifest 签名验证失败: group=%s epoch=%d", groupID, epoch)
			return false
		}
		// manifest 与分发消息一致性检查
		mGroupID, _ := manifest["group_id"].(string)
		mEpoch := int(toInt64(manifest["epoch"]))
		if mGroupID != groupID || mEpoch != epoch {
			return false
		}
		mMembers := toStringSlice(manifest["member_aids"])
		if !stringSliceEqual(sorted(mMembers), sorted(memberAIDs)) {
			return false
		}
	} else if manifest != nil {
		mGroupID, _ := manifest["group_id"].(string)
		mEpoch := int(toInt64(manifest["epoch"]))
		if mGroupID != groupID || mEpoch != epoch {
			return false
		}
		mMembers := toStringSlice(manifest["member_aids"])
		if !stringSliceEqual(sorted(mMembers), sorted(memberAIDs)) {
			return false
		}
	}

	groupSecret, err := base64.StdEncoding.DecodeString(secretB64)
	if err != nil {
		return false
	}

	// 验证 commitment
	if !VerifyMembershipCommitment(commitment, memberAIDs, epoch, groupID, aid, groupSecret) {
		return false
	}

	ok, _ := StoreGroupSecret(ks, aid, groupID, epoch, groupSecret, commitment, memberAIDs)
	return ok
}

// BuildKeyRequest 构建密钥请求 payload
func BuildKeyRequest(groupID string, epoch int, requesterAID string) map[string]any {
	return map[string]any{
		"type":          "e2ee.group_key_request",
		"group_id":      groupID,
		"epoch":         epoch,
		"requester_aid": requesterAID,
	}
}

// HandleKeyRequest 处理收到的密钥请求
// 验证请求者是群成员 -> 查本地密钥 -> 构建响应
func HandleKeyRequest(
	request map[string]any,
	ks keystore.KeyStore,
	aid string,
	currentMembers []string,
) map[string]any {
	payload := extractPayload(request)

	requesterAID, _ := payload["requester_aid"].(string)
	groupID, _ := payload["group_id"].(string)
	epoch := int(toInt64(payload["epoch"]))

	if requesterAID == "" || groupID == "" {
		return nil
	}

	// 验证请求者是群成员
	found := false
	for _, m := range currentMembers {
		if m == requesterAID {
			found = true
			break
		}
	}
	if !found {
		return nil
	}

	// 查本地密钥
	epochPtr := &epoch
	secretData, _ := LoadGroupSecret(ks, aid, groupID, epochPtr)
	if secretData == nil {
		return nil
	}

	secret, _ := secretData["secret"].([]byte)
	commitmentStr, _ := secretData["commitment"].(string)
	members := toStringSlice(secretData["member_aids"])
	if commitmentStr == "" {
		if len(members) == 0 {
			members = currentMembers
		}
		commitmentStr = ComputeMembershipCommitment(members, epoch, groupID, secret)
	}

	sorted := make([]string, len(members))
	copy(sorted, members)
	if len(sorted) == 0 {
		sorted = make([]string, len(currentMembers))
		copy(sorted, currentMembers)
	}
	sort.Strings(sorted)

	return map[string]any{
		"type":         "e2ee.group_key_response",
		"group_id":     groupID,
		"epoch":        epoch,
		"group_secret": base64.StdEncoding.EncodeToString(secret),
		"commitment":   commitmentStr,
		"member_aids":  sorted,
	}
}

// HandleKeyResponse 处理收到的密钥响应
// 验证 commitment -> 存储
func HandleKeyResponse(
	response map[string]any,
	ks keystore.KeyStore,
	aid string,
) bool {
	payload := extractPayload(response)

	groupID, _ := payload["group_id"].(string)
	epoch := int(toInt64(payload["epoch"]))
	secretB64, _ := payload["group_secret"].(string)
	commitment, _ := payload["commitment"].(string)
	memberAIDs := toStringSlice(payload["member_aids"])

	if groupID == "" || secretB64 == "" || commitment == "" {
		return false
	}

	groupSecret, err := base64.StdEncoding.DecodeString(secretB64)
	if err != nil {
		return false
	}

	if !VerifyMembershipCommitment(commitment, memberAIDs, epoch, groupID, aid, groupSecret) {
		return false
	}

	ok, _ := StoreGroupSecret(ks, aid, groupID, epoch, groupSecret, commitment, memberAIDs)
	return ok
}

// ── 群组 AAD 工具 ──────────────────────────────────────────

// aadBytesGroup 群组 AAD 序列化
func aadBytesGroup(aad map[string]any) []byte {
	filtered := make(map[string]any, len(aadFieldsGroup))
	for _, field := range aadFieldsGroup {
		filtered[field] = aad[field]
	}
	data, _ := json.Marshal(filtered)
	return data
}

// deriveGroupMsgKey 从 group_secret 派生单条群消息的加密密钥
func deriveGroupMsgKey(groupSecret []byte, groupID, messageID string) ([]byte, error) {
	info := []byte(fmt.Sprintf("aun-group:%s:msg:%s", groupID, messageID))
	reader := hkdf.New(sha256.New, groupSecret, nil, info)
	key := make([]byte, 32)
	if _, err := io.ReadFull(reader, key); err != nil {
		return nil, err
	}
	return key, nil
}

// ── 辅助函数 ─────────────────────────────────────────────

// extractPayload 从消息中提取 payload（兼容直接传入 payload 或包装消息）
func extractPayload(message map[string]any) map[string]any {
	if _, ok := message["group_id"]; ok {
		return message
	}
	if p, ok := message["payload"].(map[string]any); ok {
		return p
	}
	return message
}

// toStringSlice 将 any 转换为 []string
func toStringSlice(v any) []string {
	if v == nil {
		return nil
	}
	switch s := v.(type) {
	case []string:
		return s
	case []any:
		result := make([]string, 0, len(s))
		for _, item := range s {
			if str, ok := item.(string); ok {
				result = append(result, str)
			}
		}
		return result
	}
	return nil
}

// sorted 返回排序后的字符串切片副本
func sorted(s []string) []string {
	result := make([]string, len(s))
	copy(result, s)
	sort.Strings(result)
	return result
}

// stringSliceEqual 比较两个字符串切片是否相等
func stringSliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
