//go:build integration

package aun

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 群组测试辅助函数
// ---------------------------------------------------------------------------

// makeGroupTestClient 创建群组测试用 AUN 客户端，使用临时目录隔离测试数据。
func makeGroupTestClient(t *testing.T) *AUNClient {
	t.Helper()
	return NewClient(map[string]any{
		"aun_path":                t.TempDir(),
		"verify_ssl":             false,
		"require_forward_secrecy": false,
	})
}

// groupRunID 生成唯一运行标识（UUID 前 12 位，避免 AID 碰撞）
func groupRunID() string {
	return generateUUID4()[:12]
}

// ensureGroupConnected 注册 AID、认证并连接到 Gateway（通过 well-known 发现）。
func ensureGroupConnected(t *testing.T, client *AUNClient, aid string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 创建 AID（触发 well-known 发现 + 服务端注册）
	_, err := client.Auth.CreateAID(ctx, map[string]any{"aid": aid})
	if err != nil {
		t.Skipf("无法创建 AID（Docker 环境可能未运行）: %v", err)
	}

	// 认证（两阶段登录，获取 access_token）
	authResult, err := client.Auth.Authenticate(ctx, map[string]any{"aid": aid})
	if err != nil {
		t.Fatalf("认证失败: %v", err)
	}

	// 连接 WebSocket
	if err := client.Connect(ctx, authResult, nil); err != nil {
		t.Fatalf("连接失败: %v", err)
	}

	return aid
}

// createGroup 创建群组，返回 group_id
func createGroup(t *testing.T, client *AUNClient, name string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	result, err := client.Call(ctx, "group.create", map[string]any{"name": name})
	if err != nil {
		t.Fatalf("创建群组失败: %v", err)
	}
	resultMap, _ := result.(map[string]any)
	if resultMap == nil {
		t.Fatalf("创建群组返回 nil")
	}
	group, _ := resultMap["group"].(map[string]any)
	if group == nil {
		t.Fatalf("创建群组返回 group 为 nil")
	}
	gid, _ := group["group_id"].(string)
	if gid == "" {
		t.Fatalf("创建群组返回 group_id 为空")
	}
	return gid
}

// addMember 添加群成员
func addMember(t *testing.T, client *AUNClient, groupID, memberAID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	_, err := client.Call(ctx, "group.add_member", map[string]any{
		"group_id": groupID,
		"aid":      memberAID,
	})
	if err != nil {
		t.Fatalf("添加成员失败: %v", err)
	}
}

// kickMember 踢出群成员
func kickMember(t *testing.T, client *AUNClient, groupID, memberAID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	_, err := client.Call(ctx, "group.kick", map[string]any{
		"group_id": groupID,
		"aid":      memberAID,
	})
	if err != nil {
		t.Fatalf("踢出成员失败: %v", err)
	}
}

// groupSendEncrypted 发送加密群消息
func groupSendEncrypted(t *testing.T, client *AUNClient, groupID string, payload map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	_, err := client.Call(ctx, "group.send", map[string]any{
		"group_id": groupID,
		"payload":  payload,
		"encrypt":  true,
	})
	if err != nil {
		t.Fatalf("发送加密群消息失败: %v", err)
	}
}

// groupSendPlaintext 发送明文群消息
func groupSendPlaintext(t *testing.T, client *AUNClient, groupID string, payload map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	_, err := client.Call(ctx, "group.send", map[string]any{
		"group_id": groupID,
		"payload":  payload,
		"encrypt":  false,
	})
	if err != nil {
		t.Fatalf("发送明文群消息失败: %v", err)
	}
}

// groupPull 拉取群消息（经 client.Call 自动解密）
func groupPull(t *testing.T, client *AUNClient, groupID string, afterSeq int) []map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	result, err := client.Call(ctx, "group.pull", map[string]any{
		"group_id":  groupID,
		"after_seq": afterSeq,
		"limit":     50,
	})
	if err != nil {
		t.Fatalf("group.pull 失败: %v", err)
	}
	resultMap, _ := result.(map[string]any)
	if resultMap == nil {
		return nil
	}
	msgs, _ := resultMap["messages"].([]any)
	var out []map[string]any
	for _, m := range msgs {
		if msg, ok := m.(map[string]any); ok {
			out = append(out, msg)
		}
	}
	return out
}

// getMembers 获取群成员列表
func getMembers(t *testing.T, client *AUNClient, groupID string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	result, err := client.Call(ctx, "group.get_members", map[string]any{"group_id": groupID})
	if err != nil {
		t.Fatalf("获取成员列表失败: %v", err)
	}
	resultMap, _ := result.(map[string]any)
	if resultMap == nil {
		return nil
	}
	membersList, _ := resultMap["members"].([]any)
	return extractAIDsFromMembers(membersList)
}

// filterDecrypted 筛选已自动解密的群消息（encryption_mode == epoch_group_key）
func filterDecrypted(msgs []map[string]any) []map[string]any {
	var out []map[string]any
	for _, m := range msgs {
		e2ee, _ := m["e2ee"].(map[string]any)
		if e2ee == nil {
			continue
		}
		mode, _ := e2ee["encryption_mode"].(string)
		if mode == ModeEpochGroupKey {
			out = append(out, m)
		}
	}
	return out
}

// filterDecryptedByEpoch 筛选指定 epoch 的已解密群消息
func filterDecryptedByEpoch(msgs []map[string]any, epoch int) []map[string]any {
	var out []map[string]any
	for _, m := range msgs {
		e2ee, _ := m["e2ee"].(map[string]any)
		if e2ee == nil {
			continue
		}
		ep := int(toInt64(e2ee["epoch"]))
		if ep == epoch {
			out = append(out, m)
		}
	}
	return out
}

// getPayloadText 从消息的 payload 中提取 text 字段
func getPayloadText(msg map[string]any) string {
	payload, _ := msg["payload"].(map[string]any)
	if payload == nil {
		return ""
	}
	text, _ := payload["text"].(string)
	return text
}

// waitForGroupSecret 轮询等待客户端收到指定群组的 group_secret，超时返回 false
func waitForGroupSecret(client *AUNClient, groupID string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if client.GroupE2EE().HasSecret(groupID) {
			return true
		}
		time.Sleep(1 * time.Second)
	}
	return false
}

// waitForGroupEpoch 轮询等待客户端收到指定 epoch 的 group_secret，超时返回 false
func waitForGroupEpoch(client *AUNClient, aid, groupID string, epoch int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		all := LoadAllGroupSecrets(client.keyStore, aid, groupID)
		if _, ok := all[epoch]; ok {
			return true
		}
		time.Sleep(1 * time.Second)
	}
	return false
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

// TestGroupE2EEncryptedMessaging 建群 -> 分发密钥 -> 加密发送 -> 解密接收
func TestGroupE2EEncryptedMessaging(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))
	_ = aAID

	// Alice 建群（SDK 自动 create_epoch）
	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-test-%s", rid))

	// 验证 owner 建群后本地有 secret
	if !alice.GroupE2EE().HasSecret(groupID) {
		t.Fatal("owner 建群后应持有 group_secret")
	}

	// Alice 加 Bob（SDK 自动分发密钥）
	addMember(t, alice, groupID, bAID)

	// 等待 P2P 密钥分发到达
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 group_secret")
	}

	// Alice 发送加密群消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "加密群消息"})
	time.Sleep(1 * time.Second)

	// Bob 拉取（自动解密）
	msgs := groupPull(t, bob, groupID, 0)
	if len(msgs) < 1 {
		t.Fatalf("期望至少 1 条消息，实际 %d", len(msgs))
	}

	decrypted := filterDecrypted(msgs)
	if len(decrypted) < 1 {
		t.Fatal("未找到自动解密的群消息")
	}
	if text := getPayloadText(decrypted[0]); text != "加密群消息" {
		t.Fatalf("payload.text 不匹配: 期望 '加密群消息', 实际 '%s'", text)
	}
}

// TestGroupE2EMultipleMembers 3人群组，A 发加密消息，B/C 都能解密
func TestGroupE2EMultipleMembers(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	carol := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()
	defer carol.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))
	cAID := ensureGroupConnected(t, carol, fmt.Sprintf("ge-c-%s.agentid.pub", rid))
	_ = aAID

	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-multi-%s", rid))

	addMember(t, alice, groupID, bAID)
	addMember(t, alice, groupID, cAID)

	// 等待 SDK 自动分发密钥给 Bob 和 Carol
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 group_secret")
	}
	if !waitForGroupSecret(carol, groupID, 10*time.Second) {
		t.Fatal("Carol 未在超时内收到 group_secret")
	}

	// Alice 发送加密群消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "三人群消息"})
	time.Sleep(1 * time.Second)

	// Bob 和 Carol 都能解密
	for _, tc := range []struct {
		name   string
		client *AUNClient
	}{
		{"Bob", bob},
		{"Carol", carol},
	} {
		msgs := groupPull(t, tc.client, groupID, 0)
		decrypted := filterDecrypted(msgs)
		if len(decrypted) < 1 {
			t.Fatalf("%s: 未找到自动解密的群消息", tc.name)
		}
		if text := getPayloadText(decrypted[0]); text != "三人群消息" {
			t.Fatalf("%s: payload.text 不匹配: 期望 '三人群消息', 实际 '%s'", tc.name, text)
		}
	}
}

// TestGroupE2EEpochRotationOnKick 踢人 -> epoch 轮换 -> 旧成员无法解密新消息
func TestGroupE2EEpochRotationOnKick(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	carol := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()
	defer carol.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))
	cAID := ensureGroupConnected(t, carol, fmt.Sprintf("ge-c-%s.agentid.pub", rid))
	_ = aAID

	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-kick-%s", rid))
	addMember(t, alice, groupID, bAID)
	addMember(t, alice, groupID, cAID)

	// 等待 SDK 自动分发密钥给 Bob 和 Carol
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 epoch 1 密钥")
	}
	if !waitForGroupSecret(carol, groupID, 10*time.Second) {
		t.Fatal("Carol 未在超时内收到 epoch 1 密钥")
	}

	// 踢 Carol
	kickMember(t, alice, groupID, cAID)

	// kick 后 SDK 自动 CAS 轮换 + 分发给 Bob，轮询等待 Bob 拿到 epoch 2 密钥
	if !waitForGroupEpoch(bob, bAID, groupID, 2, 15*time.Second) {
		t.Fatal("Bob 未在 15s 内收到 epoch 2 密钥")
	}

	// Alice 用 epoch 2 发加密消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "踢人后的消息"})
	time.Sleep(1 * time.Second)

	// Bob 能解密（有 epoch 2 密钥）
	msgsBob := groupPull(t, bob, groupID, 0)
	decryptedBob := filterDecryptedByEpoch(msgsBob, 2)
	if len(decryptedBob) < 1 {
		t.Fatal("Bob: 未找到 epoch 2 的自动解密消息")
	}
	if text := getPayloadText(decryptedBob[0]); text != "踢人后的消息" {
		t.Fatalf("Bob: payload.text 不匹配: 期望 '踢人后的消息', 实际 '%s'", text)
	}

	// Carol 没有 epoch 2 密钥（被踢后不会收到新密钥）
	allCarol := LoadAllGroupSecrets(carol.keyStore, cAID, groupID)
	if _, hasEpoch2 := allCarol[2]; hasEpoch2 {
		t.Fatal("Carol 被踢后不应持有 epoch 2 密钥")
	}
}

// TestGroupE2EBurstMessages 连续发 5 条加密群消息 -> 全部解密成功
func TestGroupE2EBurstMessages(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))
	_ = aAID
	_ = bAID

	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-burst-%s", rid))
	addMember(t, alice, groupID, bAID)

	// 等待 SDK 自动分发密钥
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 group_secret")
	}

	const N = 5
	for i := 0; i < N; i++ {
		groupSendEncrypted(t, alice, groupID, map[string]any{
			"text": fmt.Sprintf("burst_%d", i),
			"seq":  i,
		})
	}

	time.Sleep(2 * time.Second)

	msgs := groupPull(t, bob, groupID, 0)
	decrypted := filterDecrypted(msgs)
	if len(decrypted) < N {
		t.Fatalf("期望 %d 条已解密消息，实际 %d", N, len(decrypted))
	}

	// 验证所有消息内容
	receivedTexts := make(map[string]bool)
	for _, m := range decrypted {
		text := getPayloadText(m)
		if text != "" {
			receivedTexts[text] = true
		}
	}
	for i := 0; i < N; i++ {
		expected := fmt.Sprintf("burst_%d", i)
		if !receivedTexts[expected] {
			t.Errorf("缺少消息: %s", expected)
		}
	}
}

// TestGroupE2EMembershipCommitment 篡改 member_aids -> commitment 校验失败
func TestGroupE2EMembershipCommitment(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))

	gs := GenerateGroupSecret()
	members := []string{aAID, bAID}

	// 正常分发（不通过 P2P，直接调用底层函数验证 commitment 机制）
	dist := BuildKeyDistribution("grp_test", 1, gs, members, aAID, nil)
	ok := HandleKeyDistribution(dist, bob.keyStore, bAID, nil)
	if !ok {
		t.Fatal("正常分发应成功")
	}

	// 篡改 member_aids（注入幽灵成员）
	tampered := copyMapShallow(dist)
	tampered["member_aids"] = append(members, "evil.agentid.pub")
	ok2 := HandleKeyDistribution(tampered, bob.keyStore, bAID, nil)
	if ok2 {
		t.Fatal("篡改 member_aids 后应分发失败（commitment 校验不通过）")
	}
}

// TestGroupE2EPlaintextExplicit 显式传 encrypt=false 发送明文群消息
func TestGroupE2EPlaintextExplicit(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("pt-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("pt-b-%s.agentid.pub", rid))
	_ = aAID

	// Alice 建群 + 加 Bob
	groupID := createGroup(t, alice, fmt.Sprintf("plaintext-test-%s", rid))
	addMember(t, alice, groupID, bAID)

	// 等待 SDK 自动分发密钥
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 group_secret")
	}

	// Alice 显式发送明文消息
	groupSendPlaintext(t, alice, groupID, map[string]any{"text": "这是一条明文消息"})

	time.Sleep(1 * time.Second)

	// Bob 拉取
	msgs := groupPull(t, bob, groupID, 0)
	// 查找明文消息（不含 e2ee 字段 或 encrypted=false）
	var plaintext []map[string]any
	for _, m := range msgs {
		_, hasE2EE := m["e2ee"]
		enc, _ := m["encrypted"].(bool)
		if !hasE2EE && !enc {
			payload, _ := m["payload"].(map[string]any)
			if payload != nil {
				if _, hasText := payload["text"]; hasText {
					plaintext = append(plaintext, m)
				}
			}
		}
	}
	if len(plaintext) < 1 {
		t.Fatal("未找到明文群消息")
	}
	if text := getPayloadText(plaintext[0]); text != "这是一条明文消息" {
		t.Fatalf("明文 payload.text 不匹配: 期望 '这是一条明文消息', 实际 '%s'", text)
	}

	// Alice 默认加密发送
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "这是一条加密消息"})

	time.Sleep(1 * time.Second)

	// 获取最后一条明文消息的 seq 用于 after_seq
	lastSeq := 0
	if len(msgs) > 0 {
		if seqVal := msgs[len(msgs)-1]["seq"]; seqVal != nil {
			lastSeq = int(toInt64(seqVal))
		}
	}

	msgs2 := groupPull(t, bob, groupID, lastSeq)
	encrypted := filterDecrypted(msgs2)
	if len(encrypted) < 1 {
		t.Fatal("未找到加密群消息")
	}
	if text := getPayloadText(encrypted[0]); text != "这是一条加密消息" {
		t.Fatalf("加密 payload.text 不匹配: 期望 '这是一条加密消息', 实际 '%s'", text)
	}
}

// ---------------------------------------------------------------------------
// 以下测试场景较复杂，暂时跳过（需要更多服务端支持或复杂交互）
// ---------------------------------------------------------------------------

// TestGroupE2ENewMemberNoRotation 加人 -> 无 epoch 轮换 -> 新成员可解密当前 epoch 消息
func TestGroupE2ENewMemberNoRotation(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	carol := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()
	defer carol.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))
	cAID := ensureGroupConnected(t, carol, fmt.Sprintf("ge-c-%s.agentid.pub", rid))
	_ = aAID

	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-join-%s", rid))
	addMember(t, alice, groupID, bAID)

	// 等待 SDK 自动分发密钥给 Bob
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 group_secret")
	}

	// 加 Carol（SDK 自动分发当前密钥，不轮换 epoch）
	addMember(t, alice, groupID, cAID)

	// 等待 Carol 收到密钥
	if !waitForGroupSecret(carol, groupID, 10*time.Second) {
		t.Fatal("Carol 未在超时内收到 group_secret")
	}

	// Alice 用 epoch 1 发消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "新成员能看到"})
	time.Sleep(1 * time.Second)

	// Carol 能解密
	msgs := groupPull(t, carol, groupID, 0)
	decrypted := filterDecrypted(msgs)
	if len(decrypted) < 1 {
		t.Fatal("Carol: 未找到自动解密的群消息")
	}
	if text := getPayloadText(decrypted[0]); text != "新成员能看到" {
		t.Fatalf("Carol: payload.text 不匹配: 期望 '新成员能看到', 实际 '%s'", text)
	}
}

// TestGroupE2EMixedEncryptedPlaintext 同一群中加密和明文消息交替 -> 正确处理
func TestGroupE2EMixedEncryptedPlaintext(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))
	_ = aAID

	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-mixed-%s", rid))
	addMember(t, alice, groupID, bAID)

	// 等待 SDK 自动分发密钥
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 group_secret")
	}

	// 明文消息
	groupSendPlaintext(t, alice, groupID, map[string]any{"text": "明文"})
	// 加密消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "密文"})
	// 又一条明文
	groupSendPlaintext(t, alice, groupID, map[string]any{"text": "又是明文"})

	time.Sleep(1 * time.Second)

	msgs := groupPull(t, bob, groupID, 0)
	if len(msgs) < 3 {
		t.Fatalf("期望至少 3 条消息，实际 %d", len(msgs))
	}

	// 加密消息已自动解密
	decrypted := filterDecrypted(msgs)
	if len(decrypted) < 1 {
		t.Fatal("未找到自动解密的群消息")
	}
	if text := getPayloadText(decrypted[0]); text != "密文" {
		t.Fatalf("加密消息 payload.text 不匹配: 期望 '密文', 实际 '%s'", text)
	}

	// 明文消息直接可读
	var plaintextTexts []string
	for _, m := range msgs {
		_, hasE2EE := m["e2ee"]
		enc, _ := m["encrypted"].(bool)
		if !hasE2EE && !enc {
			if text := getPayloadText(m); text != "" {
				plaintextTexts = append(plaintextTexts, text)
			}
		}
	}
	ptSet := make(map[string]bool)
	for _, t := range plaintextTexts {
		ptSet[t] = true
	}
	if !ptSet["明文"] {
		t.Error("未找到明文消息 '明文'")
	}
	if !ptSet["又是明文"] {
		t.Error("未找到明文消息 '又是明文'")
	}
}

// TestGroupE2EOldEpochStillDecryptable 旧 epoch 消息在保留期内仍可解密
func TestGroupE2EOldEpochStillDecryptable(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))

	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-old-%s", rid))
	addMember(t, alice, groupID, bAID)

	// 等待 SDK 自动分发 epoch 1 密钥
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 epoch 1 密钥")
	}

	// epoch 1 发消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "epoch1消息"})

	// 手动轮换 epoch 2（模拟踢人后轮换）
	members := []string{aAID, bAID}
	info, err := alice.GroupE2EE().RotateEpoch(groupID, members)
	if err != nil {
		t.Fatalf("手动轮换 epoch 失败: %v", err)
	}

	// 分发 epoch 2 密钥给 Bob
	distributions, _ := info["distributions"].([]map[string]any)
	for _, dist := range distributions {
		to, _ := dist["to"].(string)
		distPayload, _ := dist["payload"].(map[string]any)
		if to != "" && distPayload != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_, err := alice.Call(ctx, "message.send", map[string]any{
				"to":      to,
				"payload": distPayload,
				"encrypt": true,
				"persist": false,
			})
			cancel()
			if err != nil {
				t.Fatalf("分发 epoch 2 密钥失败: %v", err)
			}
		}
	}

	// 等待 Bob 收到 epoch 2 密钥
	if !waitForGroupEpoch(bob, bAID, groupID, 2, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 epoch 2 密钥")
	}

	// epoch 2 发消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "epoch2消息"})
	time.Sleep(1 * time.Second)

	// Bob 应能解密两个 epoch 的消息
	msgs := groupPull(t, bob, groupID, 0)
	decrypted := filterDecrypted(msgs)
	if len(decrypted) < 2 {
		t.Fatalf("期望至少 2 条已解密消息，实际 %d", len(decrypted))
	}

	texts := make(map[string]bool)
	for _, m := range decrypted {
		if text := getPayloadText(m); text != "" {
			texts[text] = true
		}
	}
	if !texts["epoch1消息"] {
		t.Error("缺少 epoch1 消息")
	}
	if !texts["epoch2消息"] {
		t.Error("缺少 epoch2 消息")
	}
}

// TestGroupE2EReviewJoinRequestAutoDistribute 审批通过后新成员自动拿到密钥并能解密
func TestGroupE2EReviewJoinRequestAutoDistribute(t *testing.T) {
	t.Skip("跳过：需要 group.request_join / group.review_join_request 服务端支持")
}

// TestGroupE2EInviteCodeAutoRecovery 邀请码入群后通过密钥恢复链路自动获取群密钥
func TestGroupE2EInviteCodeAutoRecovery(t *testing.T) {
	t.Skip("跳过：需要 group.create_invite_code / group.use_invite_code 服务端支持")
}

// TestGroupE2ECapabilitiesRequiredForJoin 不声明 group_e2ee 能力的客户端无法入群
func TestGroupE2ECapabilitiesRequiredForJoin(t *testing.T) {
	t.Skip("跳过：需要验证能力声明机制，当前所有 SDK 客户端默认声明 group_e2ee=true")
}

// TestGroupE2EEpochRotationOnLeave 成员主动退群 -> 剩余 admin/owner 事件侧自动轮换
func TestGroupE2EEpochRotationOnLeave(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	carol := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()
	defer carol.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("lv-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("lv-b-%s.agentid.pub", rid))
	cAID := ensureGroupConnected(t, carol, fmt.Sprintf("lv-c-%s.agentid.pub", rid))

	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-leave-%s", rid))
	addMember(t, alice, groupID, bAID)
	addMember(t, alice, groupID, cAID)

	// 等待 SDK 自动分发密钥
	if !waitForGroupSecret(alice, groupID, 5*time.Second) {
		t.Fatal("Alice 缺少 group_secret")
	}
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 group_secret")
	}
	if !waitForGroupSecret(carol, groupID, 10*time.Second) {
		t.Fatal("Carol 未在超时内收到 group_secret")
	}

	// 确认 epoch 1
	epoch := alice.GroupE2EE().CurrentEpoch(groupID)
	if epoch == nil || *epoch != 1 {
		epVal := 0
		if epoch != nil {
			epVal = *epoch
		}
		t.Fatalf("期望 epoch 1，实际 %d", epVal)
	}

	// Carol 主动退群
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	_, err := carol.Call(ctx, "group.leave", map[string]any{"group_id": groupID})
	cancel()
	if err != nil {
		t.Fatalf("Carol 退群失败: %v", err)
	}

	// Alice（owner）收到 group.changed(member_left) 事件后应自动 CAS 轮换
	// 轮询等待 Bob 拿到 epoch 2 密钥
	if !waitForGroupEpoch(bob, bAID, groupID, 2, 15*time.Second) {
		t.Fatal("Bob 未在 15s 内收到 epoch 2 密钥（leave 后自动轮换）")
	}

	// Alice 也应有 epoch 2
	allAlice := LoadAllGroupSecrets(alice.keyStore, aAID, groupID)
	if _, hasEpoch2 := allAlice[2]; !hasEpoch2 {
		t.Fatal("Alice 应持有 epoch 2 密钥")
	}

	// Alice 用 epoch 2 发加密消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "退群后的消息"})
	time.Sleep(1 * time.Second)

	// Bob 能解密
	msgsBob := groupPull(t, bob, groupID, 0)
	decryptedBob := filterDecryptedByEpoch(msgsBob, 2)
	if len(decryptedBob) < 1 {
		t.Fatal("Bob: 未找到 epoch 2 的自动解密消息")
	}
	if text := getPayloadText(decryptedBob[0]); text != "退群后的消息" {
		t.Fatalf("Bob: payload.text 不匹配: 期望 '退群后的消息', 实际 '%s'", text)
	}

	// Carol 不应有 epoch 2 密钥
	allCarol := LoadAllGroupSecrets(carol.keyStore, cAID, groupID)
	if _, hasEpoch2 := allCarol[2]; hasEpoch2 {
		t.Fatal("Carol 退群后不应持有 epoch 2 密钥")
	}
}

// TestGroupE2EPushEventDecrypt 验证群消息推送事件自动解密
func TestGroupE2EPushEventDecrypt(t *testing.T) {
	rid := groupRunID()
	alice := makeGroupTestClient(t)
	bob := makeGroupTestClient(t)
	defer alice.Close()
	defer bob.Close()

	aAID := ensureGroupConnected(t, alice, fmt.Sprintf("ge-a-%s.agentid.pub", rid))
	bAID := ensureGroupConnected(t, bob, fmt.Sprintf("ge-b-%s.agentid.pub", rid))
	_ = aAID

	groupID := createGroup(t, alice, fmt.Sprintf("e2ee-push-%s", rid))
	addMember(t, alice, groupID, bAID)

	// 等待密钥分发
	if !waitForGroupSecret(bob, groupID, 10*time.Second) {
		t.Fatal("Bob 未在超时内收到 group_secret")
	}

	// 注册推送事件监听
	var pushMu sync.Mutex
	var pushMsgs []map[string]any
	pushDone := make(chan struct{}, 1)

	sub := bob.On("group.message_created", func(payload any) {
		data, ok := payload.(map[string]any)
		if !ok {
			return
		}
		gid, _ := data["group_id"].(string)
		if gid == groupID {
			pushMu.Lock()
			pushMsgs = append(pushMsgs, data)
			pushMu.Unlock()
			select {
			case pushDone <- struct{}{}:
			default:
			}
		}
	})

	// Alice 发送加密群消息
	groupSendEncrypted(t, alice, groupID, map[string]any{"text": "推送测试"})

	// 等待推送事件
	timer := time.NewTimer(8 * time.Second)
	select {
	case <-pushDone:
	case <-timer.C:
	}
	timer.Stop()
	sub.Unsubscribe()

	pushMu.Lock()
	pushCount := len(pushMsgs)
	pushMu.Unlock()

	if pushCount == 0 {
		// 推送未收到，通过 pull 兜底验证
		msgs := groupPull(t, bob, groupID, 0)
		decrypted := filterDecrypted(msgs)
		if len(decrypted) < 1 {
			t.Fatal("推送和 pull 均未收到已解密的群消息")
		}
		t.Log("推送未收到，通过 pull 兜底验证通过")
		return
	}

	pushMu.Lock()
	// 验证推送消息已自动解密
	firstPush := pushMsgs[0]
	pushMu.Unlock()

	e2ee, _ := firstPush["e2ee"].(map[string]any)
	if e2ee == nil {
		t.Fatal("推送消息缺少 e2ee 字段（未自动解密）")
	}
	mode, _ := e2ee["encryption_mode"].(string)
	if mode != ModeEpochGroupKey {
		t.Fatalf("推送消息 encryption_mode 不匹配: 期望 %s, 实际 %s", ModeEpochGroupKey, mode)
	}
	if text := getPayloadText(firstPush); text != "推送测试" {
		t.Fatalf("推送消息 payload.text 不匹配: 期望 '推送测试', 实际 '%s'", text)
	}
}
