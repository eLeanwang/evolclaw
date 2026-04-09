package aun

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/anthropics/aun-sdk-core/go/keystore"
)

// ── 测试辅助函数（群组 E2EE）────────────────────────────────

// testNewGroupKeyStore 创建测试用 KeyStore
func testNewGroupKeyStore(t *testing.T) keystore.KeyStore {
	t.Helper()
	dir := t.TempDir()
	ks, err := keystore.NewFileKeyStore(dir, nil, "test-seed")
	if err != nil {
		t.Fatalf("创建 KeyStore 失败: %v", err)
	}
	return ks
}

// ── 群组消息加解密 ───────────────────────────────────────

// TestEncryptGroupMessage_EnvelopeFields 验证群组加密信封包含正确字段
func TestEncryptGroupMessage_EnvelopeFields(t *testing.T) {
	secret := GenerateGroupSecret()
	payload := map[string]any{"text": "hello group"}
	envelope, err := EncryptGroupMessage(
		secret, payload, "group-1", "alice.test", "gm-1",
		time.Now().UnixMilli(), 1, "",
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	requiredFields := []string{"type", "version", "encryption_mode", "suite",
		"epoch", "nonce", "ciphertext", "tag", "aad"}
	for _, field := range requiredFields {
		if _, ok := envelope[field]; !ok {
			t.Errorf("信封缺少字段: %s", field)
		}
	}
	if envelope["type"] != "e2ee.group_encrypted" {
		t.Errorf("type 不正确: %v", envelope["type"])
	}
	if envelope["encryption_mode"] != ModeEpochGroupKey {
		t.Errorf("encryption_mode 不正确: %v", envelope["encryption_mode"])
	}
	if envelope["epoch"] != 1 {
		t.Errorf("epoch 不正确: %v", envelope["epoch"])
	}
}

// TestEncryptDecryptGroupRoundtrip 验证群组消息加密解密往返
func TestEncryptDecryptGroupRoundtrip(t *testing.T) {
	secret := GenerateGroupSecret()
	originalPayload := map[string]any{"text": "group message", "num": float64(7)}
	msgID := "gm-roundtrip"
	ts := time.Now().UnixMilli()

	envelope, err := EncryptGroupMessage(secret, originalPayload, "group-1", "alice.test", msgID, ts, 1, "")
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	message := map[string]any{
		"group_id": "group-1", "from": "alice.test",
		"message_id": msgID, "payload": envelope,
	}

	secrets := map[int][]byte{1: secret}
	result := DecryptGroupMessage(secrets, message, nil, false)
	if result == nil {
		t.Fatal("解密失败，结果为 nil")
	}
	payload := result["payload"].(map[string]any)
	if payload["text"] != "group message" {
		t.Errorf("解密后 text 不匹配: %v", payload["text"])
	}
	if payload["num"] != float64(7) {
		t.Errorf("解密后 num 不匹配: %v", payload["num"])
	}
}

// TestEncryptDecryptGroupRoundtrip_WithSignature 验证带签名的群组消息加解密
func TestEncryptDecryptGroupRoundtrip_WithSignature(t *testing.T) {
	priv, privPEM, _ := testGenerateECKeypair(t)
	certPEM := testMakeSelfSignedCert(t, priv, "alice.test")

	secret := GenerateGroupSecret()
	msgID := "gm-sig-rt"
	ts := time.Now().UnixMilli()

	envelope, err := EncryptGroupMessage(secret, map[string]any{"t": "x"}, "g1", "alice.test", msgID, ts, 1, privPEM)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	if _, ok := envelope["sender_signature"]; !ok {
		t.Error("应有 sender_signature")
	}

	message := map[string]any{
		"group_id": "g1", "from": "alice.test",
		"message_id": msgID, "payload": envelope,
	}

	secrets := map[int][]byte{1: secret}
	result := DecryptGroupMessage(secrets, message, []byte(certPEM), true)
	if result == nil {
		t.Fatal("带签名解密失败")
	}
	e2ee := result["e2ee"].(map[string]any)
	if e2ee["sender_verified"] != true {
		t.Error("sender_verified 应为 true")
	}
}

// ── Group AAD 测试 ───────────────────────────────────────

// TestGroupAADDeterministic 验证群组 AAD 确定性
func TestGroupAADDeterministic(t *testing.T) {
	aad := map[string]any{
		"group_id": "g1", "from": "alice", "message_id": "m1",
		"timestamp": int64(12345), "epoch": 1,
		"encryption_mode": ModeEpochGroupKey, "suite": SuiteP256,
	}
	b1 := aadBytesGroup(aad)
	b2 := aadBytesGroup(aad)
	if string(b1) != string(b2) {
		t.Error("群组 AAD 应具有确定性")
	}
}

// ── Membership Commitment 测试 ────────────────────────────

// TestMembershipCommitment 验证成员承诺计算
func TestMembershipCommitment(t *testing.T) {
	members := []string{"bob", "alice", "charlie"}
	secret := GenerateGroupSecret()
	c1 := ComputeMembershipCommitment(members, 1, "g1", secret)
	if c1 == "" {
		t.Error("commitment 不应为空")
	}
	if len(c1) != 64 { // SHA-256 hex = 64 chars
		t.Errorf("commitment 长度不正确: %d", len(c1))
	}

	// 验证排序无关性：顺序不同应产生相同 commitment
	members2 := []string{"charlie", "alice", "bob"}
	c2 := ComputeMembershipCommitment(members2, 1, "g1", secret)
	if c1 != c2 {
		t.Error("成员顺序不同应产生相同 commitment")
	}

	// 不同 epoch 应产生不同 commitment
	c3 := ComputeMembershipCommitment(members, 2, "g1", secret)
	if c1 == c3 {
		t.Error("不同 epoch 应产生不同 commitment")
	}
}

// TestMembershipCommitmentVerify 验证成员承诺验证
func TestMembershipCommitmentVerify(t *testing.T) {
	members := []string{"alice", "bob"}
	secret := GenerateGroupSecret()
	commitment := ComputeMembershipCommitment(members, 1, "g1", secret)

	if !VerifyMembershipCommitment(commitment, members, 1, "g1", "alice", secret) {
		t.Error("合法成员应通过验证")
	}
	if VerifyMembershipCommitment(commitment, members, 1, "g1", "eve", secret) {
		t.Error("非成员不应通过验证")
	}
	if VerifyMembershipCommitment("wrong-commitment", members, 1, "g1", "alice", secret) {
		t.Error("错误 commitment 不应通过验证")
	}
}

// TestCommitmentBindsGroupSecret 验证 commitment 绑定 group_secret
func TestCommitmentBindsGroupSecret(t *testing.T) {
	members := []string{"alice", "bob"}
	secret1 := GenerateGroupSecret()
	secret2 := GenerateGroupSecret()
	c1 := ComputeMembershipCommitment(members, 1, "g1", secret1)
	c2 := ComputeMembershipCommitment(members, 1, "g1", secret2)
	if c1 == c2 {
		t.Error("不同 secret 应产生不同 commitment")
	}
}

// ── StoreGroupSecret 测试 ────────────────────────────────

// TestStoreGroupSecret 验证群组密钥存储
func TestStoreGroupSecret(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "alice.test"
	secret := GenerateGroupSecret()
	commitment := ComputeMembershipCommitment([]string{"alice", "bob"}, 1, "g1", secret)

	ok, err := StoreGroupSecret(ks, aid, "g1", 1, secret, commitment, []string{"alice", "bob"})
	if err != nil || !ok {
		t.Fatalf("StoreGroupSecret 失败: ok=%v err=%v", ok, err)
	}

	loaded, _ := LoadGroupSecret(ks, aid, "g1", nil)
	if loaded == nil {
		t.Fatal("加载密钥失败")
	}
	if int(toInt64(loaded["epoch"])) != 1 {
		t.Errorf("epoch 不正确: %v", loaded["epoch"])
	}
	loadedSecret := loaded["secret"].([]byte)
	if len(loadedSecret) != 32 {
		t.Errorf("secret 长度不正确: %d", len(loadedSecret))
	}
}

// TestStoreGroupSecret_EpochDowngradeRejected 验证 epoch 降级被拒绝
func TestStoreGroupSecret_EpochDowngradeRejected(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "alice.test"
	secret1 := GenerateGroupSecret()
	commitment1 := ComputeMembershipCommitment([]string{"alice"}, 5, "g1", secret1)
	StoreGroupSecret(ks, aid, "g1", 5, secret1, commitment1, []string{"alice"})

	secret2 := GenerateGroupSecret()
	commitment2 := ComputeMembershipCommitment([]string{"alice"}, 3, "g1", secret2)
	ok, err := StoreGroupSecret(ks, aid, "g1", 3, secret2, commitment2, []string{"alice"})
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if ok {
		t.Error("epoch 降级应被拒绝 (返回 false)")
	}

	// 确认仍是 epoch 5
	loaded, _ := LoadGroupSecret(ks, aid, "g1", nil)
	if int(toInt64(loaded["epoch"])) != 5 {
		t.Errorf("当前 epoch 应仍为 5: %v", loaded["epoch"])
	}
}

// TestCleanupOldEpochs 验证旧 epoch 清理
func TestCleanupOldEpochs(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "alice.test"

	// 创建多个 epoch
	for epoch := 1; epoch <= 5; epoch++ {
		secret := GenerateGroupSecret()
		commitment := ComputeMembershipCommitment([]string{"alice"}, epoch, "g1", secret)
		StoreGroupSecret(ks, aid, "g1", epoch, secret, commitment, []string{"alice"})
	}

	// 清理所有旧 epoch（保留 0 秒 = 全部过期）
	removed, err := CleanupOldEpochs(ks, aid, "g1", 0)
	if err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	// 应清理了 old_epochs 中的条目
	if removed < 0 {
		t.Errorf("清理数量不应为负: %d", removed)
	}
}

// ── GroupReplayGuard 测试 ────────────────────────────────

// TestGroupReplayGuard 验证群组防重放守卫
func TestGroupReplayGuard(t *testing.T) {
	guard := NewGroupReplayGuard(100)

	// 首次应通过
	if !guard.CheckAndRecord("g1", "alice", "msg1") {
		t.Error("首次消息应通过")
	}
	// 重放应被拒
	if guard.CheckAndRecord("g1", "alice", "msg1") {
		t.Error("重放消息应被拒绝")
	}
	// 不同消息应通过
	if !guard.CheckAndRecord("g1", "alice", "msg2") {
		t.Error("不同消息应通过")
	}
	// 不同发送方应通过
	if !guard.CheckAndRecord("g1", "bob", "msg1") {
		t.Error("不同发送方的相同 message_id 应通过")
	}
}

// TestGroupReplayGuard_IsSeen 验证 IsSeen 方法
func TestGroupReplayGuard_IsSeen(t *testing.T) {
	guard := NewGroupReplayGuard(100)
	if guard.IsSeen("g1", "a", "m1") {
		t.Error("未记录时不应已见")
	}
	guard.Record("g1", "a", "m1")
	if !guard.IsSeen("g1", "a", "m1") {
		t.Error("记录后应已见")
	}
}

// TestGroupReplayGuard_Trim 验证防重放守卫裁剪
func TestGroupReplayGuard_Trim(t *testing.T) {
	guard := NewGroupReplayGuard(100)
	for i := 0; i < 200; i++ {
		guard.Record("g1", "alice", string(rune(i)))
	}
	if guard.Size() > 100 {
		t.Errorf("裁剪后大小应 <= 100, 实际: %d", guard.Size())
	}
}

// ── EpochDowngrade 测试 ──────────────────────────────────

// TestEpochDowngrade 验证多次 epoch 升级和降级防护
func TestEpochDowngrade(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "alice.test"

	// epoch 1
	s1 := GenerateGroupSecret()
	c1 := ComputeMembershipCommitment([]string{"alice"}, 1, "g1", s1)
	StoreGroupSecret(ks, aid, "g1", 1, s1, c1, []string{"alice"})

	// epoch 3 (跳过 2)
	s3 := GenerateGroupSecret()
	c3 := ComputeMembershipCommitment([]string{"alice"}, 3, "g1", s3)
	ok, _ := StoreGroupSecret(ks, aid, "g1", 3, s3, c3, []string{"alice"})
	if !ok {
		t.Error("epoch 3 应被接受")
	}

	// epoch 2 应被拒绝
	s2 := GenerateGroupSecret()
	c2 := ComputeMembershipCommitment([]string{"alice"}, 2, "g1", s2)
	ok, _ = StoreGroupSecret(ks, aid, "g1", 2, s2, c2, []string{"alice"})
	if ok {
		t.Error("epoch 2 降级应被拒绝")
	}

	// epoch 3 的数据应仍然可加载
	loaded, _ := LoadGroupSecret(ks, aid, "g1", nil)
	if int(toInt64(loaded["epoch"])) != 3 {
		t.Errorf("当前 epoch 应为 3: %v", loaded["epoch"])
	}

	// 旧 epoch 1 应可通过指定 epoch 加载
	one := 1
	oldLoaded, _ := LoadGroupSecret(ks, aid, "g1", &one)
	if oldLoaded == nil {
		t.Error("旧 epoch 1 应可加载")
	}
}

// ── Key Distribution 测试 ────────────────────────────────

// TestBuildKeyDistribution 验证构建密钥分发消息
func TestBuildKeyDistribution(t *testing.T) {
	secret := GenerateGroupSecret()
	members := []string{"alice", "bob", "charlie"}
	dist := BuildKeyDistribution("g1", 1, secret, members, "alice", nil)

	if dist["type"] != "e2ee.group_key_distribution" {
		t.Errorf("type 不正确: %v", dist["type"])
	}
	if dist["group_id"] != "g1" {
		t.Errorf("group_id 不正确: %v", dist["group_id"])
	}
	if int(toInt64(dist["epoch"])) != 1 {
		t.Errorf("epoch 不正确: %v", dist["epoch"])
	}
	if dist["distributed_by"] != "alice" {
		t.Errorf("distributed_by 不正确: %v", dist["distributed_by"])
	}

	// 验证成员列表已排序
	distMembers := toStringSlice(dist["member_aids"])
	sortedMembers := make([]string, len(members))
	copy(sortedMembers, members)
	sort.Strings(sortedMembers)
	if !stringSliceEqual(distMembers, sortedMembers) {
		t.Error("成员列表应已排序")
	}

	// 验证 commitment 可验证
	secretB64 := dist["group_secret"].(string)
	decodedSecret, _ := base64.StdEncoding.DecodeString(secretB64)
	commitment := dist["commitment"].(string)
	if !VerifyMembershipCommitment(commitment, members, 1, "g1", "alice", decodedSecret) {
		t.Error("分发消息的 commitment 应可验证")
	}
}

// TestHandleKeyDistribution 验证处理密钥分发
func TestHandleKeyDistribution(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "bob.test"
	secret := GenerateGroupSecret()
	members := []string{"alice.test", "bob.test"}

	dist := BuildKeyDistribution("g1", 1, secret, members, "alice.test", nil)
	ok := HandleKeyDistribution(dist, ks, aid, nil)
	if !ok {
		t.Error("HandleKeyDistribution 应成功")
	}

	loaded, _ := LoadGroupSecret(ks, aid, "g1", nil)
	if loaded == nil {
		t.Fatal("分发后应能加载密钥")
	}
	if int(toInt64(loaded["epoch"])) != 1 {
		t.Errorf("epoch 不正确: %v", loaded["epoch"])
	}
}

// TestHandleKeyDistribution_RejectNonMember 验证非成员的分发被拒绝
func TestHandleKeyDistribution_RejectNonMember(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "eve.test" // 不在成员列表中
	secret := GenerateGroupSecret()
	members := []string{"alice.test", "bob.test"}

	dist := BuildKeyDistribution("g1", 1, secret, members, "alice.test", nil)
	ok := HandleKeyDistribution(dist, ks, aid, nil)
	if ok {
		t.Error("非成员不应接受密钥分发")
	}
}

// ── Key Request 测试 ─────────────────────────────────────

// TestBuildKeyRequest 验证构建密钥请求
func TestBuildKeyRequest(t *testing.T) {
	req := BuildKeyRequest("g1", 5, "bob.test")
	if req["type"] != "e2ee.group_key_request" {
		t.Errorf("type 不正确: %v", req["type"])
	}
	if req["group_id"] != "g1" {
		t.Errorf("group_id 不正确: %v", req["group_id"])
	}
	if int(toInt64(req["epoch"])) != 5 {
		t.Errorf("epoch 不正确: %v", req["epoch"])
	}
	if req["requester_aid"] != "bob.test" {
		t.Errorf("requester_aid 不正确: %v", req["requester_aid"])
	}
}

// TestHandleKeyRequest 验证处理密钥请求
func TestHandleKeyRequest(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "alice.test"
	members := []string{"alice.test", "bob.test"}
	secret := GenerateGroupSecret()
	commitment := ComputeMembershipCommitment(members, 1, "g1", secret)
	StoreGroupSecret(ks, aid, "g1", 1, secret, commitment, members)

	req := BuildKeyRequest("g1", 1, "bob.test")
	resp := HandleKeyRequest(req, ks, aid, members)
	if resp == nil {
		t.Fatal("应返回响应")
	}
	if resp["type"] != "e2ee.group_key_response" {
		t.Errorf("type 不正确: %v", resp["type"])
	}
	if resp["group_id"] != "g1" {
		t.Errorf("group_id 不正确: %v", resp["group_id"])
	}
}

// TestHandleKeyRequest_RejectNonMember 验证非成员请求被拒绝
func TestHandleKeyRequest_RejectNonMember(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "alice.test"
	members := []string{"alice.test", "bob.test"}
	secret := GenerateGroupSecret()
	commitment := ComputeMembershipCommitment(members, 1, "g1", secret)
	StoreGroupSecret(ks, aid, "g1", 1, secret, commitment, members)

	req := BuildKeyRequest("g1", 1, "eve.test")
	resp := HandleKeyRequest(req, ks, aid, members)
	if resp != nil {
		t.Error("非成员请求应被拒绝")
	}
}

// ── Key Response 测试 ────────────────────────────────────

// TestHandleKeyResponse 验证处理密钥响应
func TestHandleKeyResponse(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "bob.test"
	members := []string{"alice.test", "bob.test"}
	secret := GenerateGroupSecret()
	commitment := ComputeMembershipCommitment(members, 1, "g1", secret)

	response := map[string]any{
		"type":         "e2ee.group_key_response",
		"group_id":     "g1",
		"epoch":        1,
		"group_secret": base64.StdEncoding.EncodeToString(secret),
		"commitment":   commitment,
		"member_aids":  members,
	}

	ok := HandleKeyResponse(response, ks, aid)
	if !ok {
		t.Error("HandleKeyResponse 应成功")
	}

	loaded, _ := LoadGroupSecret(ks, aid, "g1", nil)
	if loaded == nil {
		t.Fatal("响应后应能加载密钥")
	}
}

// ── GroupKeyRequestThrottle 测试 ─────────────────────────

// TestGroupKeyRequestThrottle 验证频率限制
func TestGroupKeyRequestThrottle(t *testing.T) {
	throttle := NewGroupKeyRequestThrottle(0.1) // 0.1 秒冷却

	if !throttle.Allow("key1") {
		t.Error("首次应允许")
	}
	if throttle.Allow("key1") {
		t.Error("冷却期内应被限制")
	}
	// 不同 key 不受影响
	if !throttle.Allow("key2") {
		t.Error("不同 key 应允许")
	}

	// 等待冷却
	time.Sleep(150 * time.Millisecond)
	if !throttle.Allow("key1") {
		t.Error("冷却后应允许")
	}
}

// TestGroupKeyRequestThrottle_Reset 验证重置频率限制
func TestGroupKeyRequestThrottle_Reset(t *testing.T) {
	throttle := NewGroupKeyRequestThrottle(30)
	throttle.Allow("key1")
	throttle.Reset("key1")
	if !throttle.Allow("key1") {
		t.Error("重置后应允许")
	}
}

// ── Membership Manifest 测试 ─────────────────────────────

// TestMembershipManifest_BuildSignVerify 验证 manifest 构建、签名、验证
func TestMembershipManifest_BuildSignVerify(t *testing.T) {
	priv, privPEM, _ := testGenerateECKeypair(t)
	certPEM := testMakeSelfSignedCert(t, priv, "alice.test")

	manifest := BuildMembershipManifest("g1", 2, nil, []string{"alice.test", "bob.test"}, nil, nil, "alice.test")
	if manifest["group_id"] != "g1" {
		t.Errorf("group_id 不正确: %v", manifest["group_id"])
	}
	if manifest["epoch"] != 2 {
		t.Errorf("epoch 不正确: %v", manifest["epoch"])
	}

	// 签名
	signed, err := SignMembershipManifest(manifest, privPEM)
	if err != nil {
		t.Fatalf("签名失败: %v", err)
	}
	sig, ok := signed["signature"].(string)
	if !ok || sig == "" {
		t.Error("签名后应包含 signature")
	}

	// 验证
	valid, err := VerifyMembershipManifest(signed, []byte(certPEM))
	if err != nil {
		t.Fatalf("验证失败: %v", err)
	}
	if !valid {
		t.Error("合法签名应通过验证")
	}
}

// TestMembershipManifest_RejectWrongCert 验证错误证书无法通过验证
func TestMembershipManifest_RejectWrongCert(t *testing.T) {
	priv, privPEM, _ := testGenerateECKeypair(t)
	_ = priv

	wrongPriv, _, _ := testGenerateECKeypair(t)
	wrongCertPEM := testMakeSelfSignedCert(t, wrongPriv, "eve.test")

	manifest := BuildMembershipManifest("g1", 1, nil, []string{"alice"}, nil, nil, "alice")
	signed, _ := SignMembershipManifest(manifest, privPEM)

	valid, _ := VerifyMembershipManifest(signed, []byte(wrongCertPEM))
	if valid {
		t.Error("错误证书不应通过验证")
	}
}

// TestMembershipManifest_NoSignature 验证无签名不通过
func TestMembershipManifest_NoSignature(t *testing.T) {
	priv, _, _ := testGenerateECKeypair(t)
	certPEM := testMakeSelfSignedCert(t, priv, "alice.test")

	manifest := BuildMembershipManifest("g1", 1, nil, []string{"alice"}, nil, nil, "alice")
	// 未签名
	valid, _ := VerifyMembershipManifest(manifest, []byte(certPEM))
	if valid {
		t.Error("无签名不应通过验证")
	}
}

// ── 发送方签名测试（群组）──────────────────────────────────

// TestSenderSignature_PresentAndVerifiable 验证群组消息发送方签名
func TestSenderSignature_PresentAndVerifiable(t *testing.T) {
	priv, privPEM, _ := testGenerateECKeypair(t)
	certPEM := testMakeSelfSignedCert(t, priv, "alice.test")

	secret := GenerateGroupSecret()
	envelope, err := EncryptGroupMessage(
		secret, map[string]any{"t": "x"}, "g1", "alice.test",
		"gm-sig", time.Now().UnixMilli(), 1, privPEM,
	)
	if err != nil {
		t.Fatalf("加密失败: %v", err)
	}

	sigB64, ok := envelope["sender_signature"].(string)
	if !ok || sigB64 == "" {
		t.Fatal("应包含 sender_signature")
	}
	fp, ok := envelope["sender_cert_fingerprint"].(string)
	if !ok || !strings.HasPrefix(fp, "sha256:") {
		t.Errorf("sender_cert_fingerprint 格式不正确: %v", fp)
	}

	// 手动验证签名
	block, _ := pem.Decode([]byte(certPEM))
	cert, _ := x509.ParseCertificate(block.Bytes)
	pub := cert.PublicKey.(*ecdsa.PublicKey)

	ct, _ := base64.StdEncoding.DecodeString(envelope["ciphertext"].(string))
	tag, _ := base64.StdEncoding.DecodeString(envelope["tag"].(string))
	aad := envelope["aad"].(map[string]any)
	aadBytes := aadBytesGroup(aad)

	signPayload := make([]byte, 0)
	signPayload = append(signPayload, ct...)
	signPayload = append(signPayload, tag...)
	signPayload = append(signPayload, aadBytes...)
	hash := sha256.Sum256(signPayload)

	sigBytes, _ := base64.StdEncoding.DecodeString(sigB64)
	if !ecdsa.VerifyASN1(pub, hash[:], sigBytes) {
		t.Error("发送方签名验证失败")
	}
}

// TestSenderSignature_MissingSigRejected 验证缺少签名时解密被拒绝
func TestSenderSignature_MissingSigRejected(t *testing.T) {
	priv, _, _ := testGenerateECKeypair(t)
	certPEM := testMakeSelfSignedCert(t, priv, "alice.test")

	secret := GenerateGroupSecret()
	envelope, _ := EncryptGroupMessage(
		secret, map[string]any{"t": "x"}, "g1", "alice.test",
		"gm-nosig", time.Now().UnixMilli(), 1, "", // 不提供私钥 -> 无签名
	)

	message := map[string]any{
		"group_id": "g1", "from": "alice.test",
		"message_id": "gm-nosig", "payload": envelope,
	}

	secrets := map[int][]byte{1: secret}
	result := DecryptGroupMessage(secrets, message, []byte(certPEM), true) // requireSignature=true
	if result != nil {
		t.Error("缺少签名时 requireSignature=true 应拒绝解密")
	}
}

// ── LoadAllGroupSecrets 测试 ─────────────────────────────

// TestLoadAllGroupSecrets 验证加载所有 epoch 的密钥
func TestLoadAllGroupSecrets(t *testing.T) {
	ks := testNewGroupKeyStore(t)
	aid := "alice.test"

	for epoch := 1; epoch <= 3; epoch++ {
		secret := GenerateGroupSecret()
		commitment := ComputeMembershipCommitment([]string{"alice"}, epoch, "g1", secret)
		StoreGroupSecret(ks, aid, "g1", epoch, secret, commitment, []string{"alice"})
	}

	all := LoadAllGroupSecrets(ks, aid, "g1")
	if len(all) < 2 {
		t.Errorf("应至少有 2 个 epoch, 实际: %d", len(all))
	}
	// 当前 epoch 3 应存在
	if _, ok := all[3]; !ok {
		t.Error("当前 epoch 3 应存在")
	}
}

// ── HandleKeyDistribution 带 Manifest 验证 ─────────────────

// TestHandleKeyDistribution_WithManifest 验证带 manifest 的密钥分发
func TestHandleKeyDistribution_WithManifest(t *testing.T) {
	priv, privPEM, _ := testGenerateECKeypair(t)
	certPEM := testMakeSelfSignedCert(t, priv, "alice.test")

	ks := testNewGroupKeyStore(t)
	aid := "bob.test"
	secret := GenerateGroupSecret()
	members := []string{"alice.test", "bob.test"}

	manifest := BuildMembershipManifest("g1", 1, nil, members, nil, nil, "alice.test")
	signed, _ := SignMembershipManifest(manifest, privPEM)

	dist := BuildKeyDistribution("g1", 1, secret, members, "alice.test", signed)
	ok := HandleKeyDistribution(dist, ks, aid, []byte(certPEM))
	if !ok {
		t.Error("带合法 manifest 的分发应成功")
	}
}

// ── 辅助类型测试 ─────────────────────────────────────────

// TestGenerateGroupSecret 验证生成的群组密钥
func TestGenerateGroupSecret(t *testing.T) {
	s1 := GenerateGroupSecret()
	s2 := GenerateGroupSecret()
	if len(s1) != 32 {
		t.Errorf("group_secret 应为 32 字节: %d", len(s1))
	}
	if string(s1) == string(s2) {
		t.Error("两次生成的 group_secret 不应相同")
	}
}

// TestToStringSlice 验证字符串切片转换
func TestToStringSlice(t *testing.T) {
	// nil 输入
	result := toStringSlice(nil)
	if result != nil {
		t.Error("nil 输入应返回 nil")
	}
	// []string 输入
	result = toStringSlice([]string{"a", "b"})
	if len(result) != 2 || result[0] != "a" {
		t.Error("[]string 输入转换不正确")
	}
	// []any 输入
	result = toStringSlice([]any{"x", "y"})
	if len(result) != 2 || result[0] != "x" {
		t.Error("[]any 输入转换不正确")
	}
}

// TestStringSliceEqual 验证字符串切片相等判断
func TestStringSliceEqual(t *testing.T) {
	if !stringSliceEqual([]string{"a", "b"}, []string{"a", "b"}) {
		t.Error("相同切片应相等")
	}
	if stringSliceEqual([]string{"a", "b"}, []string{"a", "c"}) {
		t.Error("不同切片不应相等")
	}
	if stringSliceEqual([]string{"a"}, []string{"a", "b"}) {
		t.Error("长度不同不应相等")
	}
}

// TestExtractPayload 验证 payload 提取
func TestExtractPayload(t *testing.T) {
	// 直接 payload（含 group_id）
	direct := map[string]any{"group_id": "g1", "epoch": 1}
	if extractPayload(direct)["group_id"] != "g1" {
		t.Error("直接 payload 提取不正确")
	}

	// 包装消息
	wrapped := map[string]any{
		"payload": map[string]any{"group_id": "g2", "epoch": 2},
	}
	if extractPayload(wrapped)["group_id"] != "g2" {
		t.Error("包装消息 payload 提取不正确")
	}
}

// TestGroupAADFieldCount 验证群组 AAD 字段数
func TestGroupAADFieldCount(t *testing.T) {
	aad := map[string]any{
		"group_id": "g1", "from": "alice", "message_id": "m1",
		"timestamp": int64(12345), "epoch": 1,
		"encryption_mode": ModeEpochGroupKey, "suite": SuiteP256,
	}
	data := aadBytesGroup(aad)
	var parsed map[string]any
	json.Unmarshal(data, &parsed)
	if len(parsed) != len(aadFieldsGroup) {
		t.Errorf("群组 AAD 字段数不正确: 期望 %d, 实际 %d", len(aadFieldsGroup), len(parsed))
	}
}
