package aun

import (
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/anthropics/aun-sdk-core/go/keystore"
)

// ── 群组 E2EE 常量 ──────────────────────────────────────────

const (
	// ModeEpochGroupKey 群组 epoch 密钥加密模式
	ModeEpochGroupKey = "epoch_group_key"
	// OldEpochRetentionSeconds 旧 epoch 默认保留 7 天
	OldEpochRetentionSeconds = 7 * 24 * 3600
)

// ── GroupE2EEManager 群组端到端加密管理器 ────────────────────

// GroupE2EEManager 群组端到端加密工具类
// 纯密码学 + 本地状态，零 I/O 依赖。
// 所有网络操作（P2P 发送、RPC 调用）由调用方负责。
// 内置防重放、epoch 降级防护、密钥请求频率限制。
type GroupE2EEManager struct {
	mu                    sync.RWMutex
	identityFn            func() map[string]any // 获取当前身份的回调
	keystore              keystore.KeyStore     // 密钥存储后端
	config                *AUNConfig            // SDK 配置
	replayGuard           *GroupReplayGuard     // 防重放守卫
	requestThrottle       *GroupKeyRequestThrottle // 密钥请求频率限制
	responseThrottle      *GroupKeyRequestThrottle // 密钥响应频率限制
	senderCertResolver    func(string) string   // 发送方证书解析器
	initiatorCertResolver func(string) string   // 发起者证书解析器
}

// GroupE2EEManagerConfig 群组 E2EE 配置
type GroupE2EEManagerConfig struct {
	IdentityFn            func() map[string]any // 获取当前身份的回调
	Keystore              keystore.KeyStore     // 密钥存储后端
	Config                *AUNConfig            // SDK 配置
	RequestCooldown       float64               // 密钥请求冷却时间（秒），默认 30
	ResponseCooldown      float64               // 密钥响应冷却时间（秒），默认 30
	SenderCertResolver    func(string) string   // 通过 AID 获取发送方证书 PEM
	InitiatorCertResolver func(string) string   // 通过 AID 获取发起者证书 PEM
}

// NewGroupE2EEManager 创建群组 E2EE 管理器
func NewGroupE2EEManager(cfg GroupE2EEManagerConfig) *GroupE2EEManager {
	reqCooldown := cfg.RequestCooldown
	if reqCooldown == 0 {
		reqCooldown = 30.0
	}
	resCooldown := cfg.ResponseCooldown
	if resCooldown == 0 {
		resCooldown = 30.0
	}
	return &GroupE2EEManager{
		identityFn:            cfg.IdentityFn,
		keystore:              cfg.Keystore,
		config:                cfg.Config,
		replayGuard:           NewGroupReplayGuard(50000),
		requestThrottle:       NewGroupKeyRequestThrottle(reqCooldown),
		responseThrottle:      NewGroupKeyRequestThrottle(resCooldown),
		senderCertResolver:    cfg.SenderCertResolver,
		initiatorCertResolver: cfg.InitiatorCertResolver,
	}
}

// ── 密钥管理 ──────────────────────────────────────────────

// signManifest 用当前身份私钥签名 manifest
func (m *GroupE2EEManager) signManifest(manifest map[string]any) map[string]any {
	identity := m.identityFn()
	pkPEM, _ := identity["private_key_pem"].(string)
	if pkPEM == "" {
		return manifest
	}
	signed, err := SignMembershipManifest(manifest, pkPEM)
	if err != nil {
		return manifest
	}
	return signed
}

// CreateEpoch 创建首个 epoch
// 返回 {epoch, commitment, distributions: [{to, payload}]}
func (m *GroupE2EEManager) CreateEpoch(groupID string, memberAIDs []string) (map[string]any, error) {
	aid := m.currentAID()
	gs := GenerateGroupSecret()
	epoch := 1
	commitment := ComputeMembershipCommitment(memberAIDs, epoch, groupID, gs)
	_, err := StoreGroupSecret(m.keystore, aid, groupID, epoch, gs, commitment, memberAIDs)
	if err != nil {
		return nil, err
	}

	manifest := m.signManifest(BuildMembershipManifest(groupID, epoch, nil, memberAIDs, nil, nil, aid))
	distPayload := BuildKeyDistribution(groupID, epoch, gs, memberAIDs, aid, manifest)

	distributions := make([]map[string]any, 0)
	for _, member := range memberAIDs {
		if member != aid {
			distributions = append(distributions, map[string]any{
				"to":      member,
				"payload": distPayload,
			})
		}
	}

	return map[string]any{
		"epoch":         epoch,
		"commitment":    commitment,
		"distributions": distributions,
	}, nil
}

// RotateEpoch 轮换 epoch（踢人/退出后调用）
func (m *GroupE2EEManager) RotateEpoch(groupID string, memberAIDs []string) (map[string]any, error) {
	aid := m.currentAID()
	ks := m.keystore
	current, _ := LoadGroupSecret(ks, aid, groupID, nil)
	var prevEpoch *int
	newEpoch := 1
	if current != nil {
		if ep, ok := current["epoch"]; ok {
			e := int(toInt64(ep))
			prevEpoch = &e
			newEpoch = e + 1
		}
	}

	gs := GenerateGroupSecret()
	commitment := ComputeMembershipCommitment(memberAIDs, newEpoch, groupID, gs)
	_, err := StoreGroupSecret(ks, aid, groupID, newEpoch, gs, commitment, memberAIDs)
	if err != nil {
		return nil, err
	}

	manifest := m.signManifest(BuildMembershipManifest(groupID, newEpoch, prevEpoch, memberAIDs, nil, nil, aid))
	distPayload := BuildKeyDistribution(groupID, newEpoch, gs, memberAIDs, aid, manifest)

	distributions := make([]map[string]any, 0)
	for _, member := range memberAIDs {
		if member != aid {
			distributions = append(distributions, map[string]any{
				"to":      member,
				"payload": distPayload,
			})
		}
	}

	return map[string]any{
		"epoch":         newEpoch,
		"commitment":    commitment,
		"distributions": distributions,
	}, nil
}

// RotateEpochTo 指定目标 epoch 号轮换（配合服务端 CAS 使用）
func (m *GroupE2EEManager) RotateEpochTo(groupID string, targetEpoch int, memberAIDs []string) (map[string]any, error) {
	aid := m.currentAID()
	gs := GenerateGroupSecret()
	commitment := ComputeMembershipCommitment(memberAIDs, targetEpoch, groupID, gs)
	_, err := StoreGroupSecret(m.keystore, aid, groupID, targetEpoch, gs, commitment, memberAIDs)
	if err != nil {
		return nil, err
	}

	prevEpoch := targetEpoch - 1
	manifest := m.signManifest(BuildMembershipManifest(groupID, targetEpoch, &prevEpoch, memberAIDs, nil, nil, aid))
	distPayload := BuildKeyDistribution(groupID, targetEpoch, gs, memberAIDs, aid, manifest)

	distributions := make([]map[string]any, 0)
	for _, member := range memberAIDs {
		if member != aid {
			distributions = append(distributions, map[string]any{
				"to":      member,
				"payload": distPayload,
			})
		}
	}

	return map[string]any{
		"epoch":         targetEpoch,
		"commitment":    commitment,
		"distributions": distributions,
	}, nil
}

// StoreSecret 手动存储 group_secret。返回 false 表示 epoch 降级被拒。
func (m *GroupE2EEManager) StoreSecret(groupID string, epoch int, groupSecret []byte, commitment string, memberAIDs []string) (bool, error) {
	return StoreGroupSecret(m.keystore, m.currentAID(), groupID, epoch, groupSecret, commitment, memberAIDs)
}

// LoadSecret 加载群组密钥
func (m *GroupE2EEManager) LoadSecret(groupID string) map[string]any {
	data, _ := LoadGroupSecret(m.keystore, m.currentAID(), groupID, nil)
	return data
}

// LoadSecretForEpoch 加载指定 epoch 的群组密钥
func (m *GroupE2EEManager) LoadSecretForEpoch(groupID string, epoch int) map[string]any {
	data, _ := LoadGroupSecret(m.keystore, m.currentAID(), groupID, &epoch)
	return data
}

// LoadAllSecrets 加载所有 epoch 的群组密钥
func (m *GroupE2EEManager) LoadAllSecrets(groupID string) map[int][]byte {
	return LoadAllGroupSecrets(m.keystore, m.currentAID(), groupID)
}

// Cleanup 清理过期的旧 epoch
func (m *GroupE2EEManager) Cleanup(groupID string, retentionSeconds int) (int, error) {
	if retentionSeconds == 0 {
		retentionSeconds = OldEpochRetentionSeconds
	}
	return CleanupOldEpochs(m.keystore, m.currentAID(), groupID, retentionSeconds)
}

// ── 加解密 ────────────────────────────────────────────────

// Encrypt 加密群组消息（含发送方签名）
// 无密钥时返回 E2EEGroupSecretMissingError
func (m *GroupE2EEManager) Encrypt(groupID string, payload map[string]any) (map[string]any, error) {
	aid := m.currentAID()
	secretData, _ := LoadGroupSecret(m.keystore, aid, groupID, nil)
	if secretData == nil {
		return nil, NewE2EEGroupSecretMissingError(fmt.Sprintf("群 %s 无密钥", groupID))
	}

	identity := m.identityFn()
	senderPkPEM, _ := identity["private_key_pem"].(string)

	epoch := int(toInt64(secretData["epoch"]))
	secret, _ := secretData["secret"].([]byte)

	msgID := fmt.Sprintf("gm-%s", generateUUID4())
	ts := time.Now().UnixMilli()

	return EncryptGroupMessage(secret, payload, groupID, aid, msgID, ts, epoch, senderPkPEM)
}

// Decrypt 解密单条群组消息
// 内置防重放 + 发送方验签 + 外层字段校验
// 非加密消息原样返回，解密失败返回 nil
func (m *GroupE2EEManager) Decrypt(message map[string]any) (map[string]any, error) {
	payload, ok := message["payload"].(map[string]any)
	if !ok {
		return message, nil
	}
	payloadType, _ := payload["type"].(string)
	if payloadType != "e2ee.group_encrypted" {
		return message, nil
	}

	groupID, _ := message["group_id"].(string)
	sender, _ := message["from"].(string)
	if sender == "" {
		sender, _ = message["sender_aid"].(string)
	}

	// 防重放预检：优先使用 AAD 内 message_id
	aad, _ := payload["aad"].(map[string]any)
	aadMsgID := ""
	if aad != nil {
		aadMsgID, _ = aad["message_id"].(string)
	}
	msgID := aadMsgID
	if msgID == "" {
		msgID, _ = message["message_id"].(string)
	}
	if groupID != "" && sender != "" && msgID != "" {
		if m.replayGuard.IsSeen(groupID, sender, msgID) {
			return message, nil // 已处理过，原样返回
		}
	}

	// 解析发送方证书（零信任：无证书则拒绝）
	var senderCertPEM []byte
	if m.senderCertResolver != nil && sender != "" {
		raw := m.senderCertResolver(sender)
		if raw != "" {
			senderCertPEM = []byte(raw)
		}
	}
	if senderCertPEM == nil {
		log.Printf("[e2ee_group] 拒绝群消息：无法获取发送方 %s 的证书: group=%s", sender, groupID)
		return nil, nil
	}

	allSecrets := LoadAllGroupSecrets(m.keystore, m.currentAID(), groupID)
	if len(allSecrets) == 0 {
		return nil, nil
	}

	result := DecryptGroupMessage(allSecrets, message, senderCertPEM, true)
	if result != nil {
		// 解密成功后记录防重放
		finalMsgID := aadMsgID
		if finalMsgID == "" {
			finalMsgID, _ = message["message_id"].(string)
		}
		if groupID != "" && sender != "" && finalMsgID != "" {
			m.replayGuard.Record(groupID, sender, finalMsgID)
		}
	}
	return result, nil
}

// DecryptBatch 批量解密群组消息
func (m *GroupE2EEManager) DecryptBatch(messages []map[string]any) []map[string]any {
	results := make([]map[string]any, len(messages))
	for i, msg := range messages {
		decrypted, _ := m.Decrypt(msg)
		if decrypted != nil {
			results[i] = decrypted
		} else {
			results[i] = msg
		}
	}
	return results
}

// ── 密钥协议消息处理 ──────────────────────────────────────

// HandleIncoming 处理已解密的 P2P 密钥消息
// 返回 "distribution"/"request"/"response" 表示已成功处理
// 返回 "distribution_rejected"/"response_rejected" 表示被拒绝
// 返回 "" 表示不是密钥消息
func (m *GroupE2EEManager) HandleIncoming(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	msgType, _ := payload["type"].(string)
	aid := m.currentAID()

	switch msgType {
	case "e2ee.group_key_distribution":
		// 解析发起者证书用于 manifest 验证
		var initiatorCert []byte
		distributedBy, _ := payload["distributed_by"].(string)
		if m.initiatorCertResolver != nil && distributedBy != "" {
			raw := m.initiatorCertResolver(distributedBy)
			if raw != "" {
				initiatorCert = []byte(raw)
			}
		}
		ok := HandleKeyDistribution(payload, m.keystore, aid, initiatorCert)
		if ok {
			return "distribution"
		}
		return "distribution_rejected"

	case "e2ee.group_key_response":
		ok := HandleKeyResponse(payload, m.keystore, aid)
		if ok {
			return "response"
		}
		return "response_rejected"

	case "e2ee.group_key_request":
		return "request"
	}
	return ""
}

// BuildRecoveryRequest 构建密钥恢复请求
// 返回 {to, payload} 或 nil（限流/无目标）
func (m *GroupE2EEManager) BuildRecoveryRequest(groupID string, epoch int, senderAID string) map[string]any {
	aid := m.currentAID()
	throttleKey := fmt.Sprintf("request:%s:%d", groupID, epoch)
	if !m.requestThrottle.Allow(throttleKey) {
		return nil
	}

	var candidates []string
	secretData, _ := LoadGroupSecret(m.keystore, aid, groupID, nil)
	if secretData != nil {
		if members, ok := secretData["member_aids"].([]string); ok {
			for _, member := range members {
				if member != aid {
					candidates = append(candidates, member)
				}
			}
		}
	}
	if len(candidates) == 0 && senderAID != "" && senderAID != aid {
		candidates = []string{senderAID}
	}
	if len(candidates) == 0 {
		return nil
	}

	return map[string]any{
		"to":      candidates[0],
		"payload": BuildKeyRequest(groupID, epoch, aid),
	}
}

// HandleKeyRequestMsg 处理密钥请求
// 返回响应 payload（受频率限制 + 成员资格验证），或 nil 拒绝
func (m *GroupE2EEManager) HandleKeyRequestMsg(requestPayload map[string]any, currentMembers []string) map[string]any {
	requester, _ := requestPayload["requester_aid"].(string)
	groupID, _ := requestPayload["group_id"].(string)
	if requester == "" || groupID == "" {
		return nil
	}

	// 成员资格验证
	found := false
	for _, member := range currentMembers {
		if member == requester {
			found = true
			break
		}
	}
	if !found {
		log.Printf("[e2ee_group] 拒绝密钥恢复请求：%s 不在群 %s 成员列表中", requester, groupID)
		return nil
	}

	throttleKey := fmt.Sprintf("response:%s:%s", groupID, requester)
	if !m.responseThrottle.Allow(throttleKey) {
		return nil
	}

	return HandleKeyRequest(requestPayload, m.keystore, m.currentAID(), currentMembers)
}

// ── 状态查询 ──────────────────────────────────────────────

// HasSecret 判断是否持有群组密钥
func (m *GroupE2EEManager) HasSecret(groupID string) bool {
	data, _ := LoadGroupSecret(m.keystore, m.currentAID(), groupID, nil)
	return data != nil
}

// CurrentEpoch 获取群组当前 epoch，未知则返回 nil
func (m *GroupE2EEManager) CurrentEpoch(groupID string) *int {
	data, _ := LoadGroupSecret(m.keystore, m.currentAID(), groupID, nil)
	if data == nil {
		return nil
	}
	ep := int(toInt64(data["epoch"]))
	return &ep
}

// GetMemberAIDs 获取群组成员列表
func (m *GroupE2EEManager) GetMemberAIDs(groupID string) []string {
	data, _ := LoadGroupSecret(m.keystore, m.currentAID(), groupID, nil)
	if data == nil {
		return nil
	}
	if members, ok := data["member_aids"].([]string); ok {
		return members
	}
	return nil
}

// currentAID 获取当前 AID
func (m *GroupE2EEManager) currentAID() string {
	identity := m.identityFn()
	if aid, ok := identity["aid"].(string); ok {
		return aid
	}
	return ""
}
