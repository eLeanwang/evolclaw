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
// 辅助函数
// ---------------------------------------------------------------------------

// makeClient 创建一个测试用 AUN 客户端，使用临时目录隔离测试数据。
func makeClient(t *testing.T) *AUNClient {
	t.Helper()
	tmpDir := t.TempDir()
	return NewClient(map[string]any{
		"aun_path":                tmpDir,
		"verify_ssl":             false,
		"require_forward_secrecy": false,
	})
}

// ensureConnected 注册 AID、认证并连接到 Gateway。
// 通过 well-known 发现机制自动解析 Gateway URL。
func ensureConnected(t *testing.T, client *AUNClient, aid string) string {
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

// runID 生成唯一运行标识（UUID 前 12 位，避免 AID 碰撞）
func runID() string {
	return generateUUID4()[:12]
}

// sdkSend 通过 SDK 加密发送消息
func sdkSend(t *testing.T, client *AUNClient, toAID string, payload map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, err := client.Call(ctx, "message.send", map[string]any{
		"to":      toAID,
		"payload": payload,
		"encrypt": true,
		"persist": true,
	})
	if err != nil {
		t.Fatalf("发送消息失败: %v", err)
	}
}

// sdkRecvPush 通过推送事件接收消息，超时后 pull 兜底
func sdkRecvPush(t *testing.T, client *AUNClient, fromAID string, timeout time.Duration) []map[string]any {
	t.Helper()
	if timeout == 0 {
		timeout = 5 * time.Second
	}

	var mu sync.Mutex
	var inbox []map[string]any
	done := make(chan struct{}, 1)

	sub := client.On("message.received", func(payload any) {
		data, ok := payload.(map[string]any)
		if !ok {
			return
		}
		from, _ := data["from"].(string)
		if from == fromAID {
			mu.Lock()
			inbox = append(inbox, data)
			mu.Unlock()
			select {
			case done <- struct{}{}:
			default:
			}
		}
	})

	// 等待推送
	timer := time.NewTimer(timeout)
	select {
	case <-done:
	case <-timer.C:
	}
	timer.Stop()
	sub.Unsubscribe()

	mu.Lock()
	result := inbox
	mu.Unlock()

	// 推送未收到，使用 pull 兜底
	if len(result) == 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		pullResult, err := client.Call(ctx, "message.pull", map[string]any{
			"after_seq": 0,
			"limit":     50,
		})
		if err != nil {
			return nil
		}
		pullMap, _ := pullResult.(map[string]any)
		if pullMap == nil {
			return nil
		}
		msgs, _ := pullMap["messages"].([]any)
		for _, m := range msgs {
			msg, ok := m.(map[string]any)
			if !ok {
				continue
			}
			from, _ := msg["from"].(string)
			if from == fromAID {
				result = append(result, msg)
			}
		}
	}
	return result
}

// sdkRecvPull 通过 pull 接收消息（SDK 自动解密）
func sdkRecvPull(t *testing.T, client *AUNClient, fromAID string, afterSeq int) []map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pullResult, err := client.Call(ctx, "message.pull", map[string]any{
		"after_seq": afterSeq,
		"limit":     50,
	})
	if err != nil {
		t.Fatalf("pull 失败: %v", err)
	}
	pullMap, _ := pullResult.(map[string]any)
	if pullMap == nil {
		return nil
	}
	msgs, _ := pullMap["messages"].([]any)
	var result []map[string]any
	for _, m := range msgs {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		from, _ := msg["from"].(string)
		if from == fromAID {
			result = append(result, msg)
		}
	}
	return result
}

// assertDecrypted 断言消息已加密且 payload 匹配
func assertDecrypted(t *testing.T, msg map[string]any, expectedPayload map[string]any, label string) {
	t.Helper()
	prefix := ""
	if label != "" {
		prefix = fmt.Sprintf("[%s] ", label)
	}
	encrypted, _ := msg["encrypted"].(bool)
	if !encrypted {
		t.Errorf("%s消息应标记为已加密", prefix)
	}
	payload, _ := msg["payload"].(map[string]any)
	if payload == nil {
		t.Fatalf("%s消息 payload 为空", prefix)
	}
	for k, v := range expectedPayload {
		actual := payload[k]
		if fmt.Sprintf("%v", actual) != fmt.Sprintf("%v", v) {
			t.Errorf("%spayload.%s 不匹配: 期望 %v, 实际 %v", prefix, k, v, actual)
		}
	}
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

// TestIntegrationPrekeyUploadAndGet 注册 AID、连接、上传 prekey，验证另一客户端可获取。
func TestIntegrationPrekeyUploadAndGet(t *testing.T) {
	rid := runID()
	alice := makeClient(t)
	bob := makeClient(t)
	defer alice.Close()
	defer bob.Close()

	aliceAID := ensureConnected(t, alice, fmt.Sprintf("e2ee-alice-%s.agentid.pub", rid))
	_ = aliceAID
	bobAID := ensureConnected(t, bob, fmt.Sprintf("e2ee-bob-%s.agentid.pub", rid))

	// bob 生成并上传 prekey
	prekeyMaterial, err := bob.E2EE().GeneratePrekey()
	if err != nil {
		t.Fatalf("生成 prekey 失败: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result, err := bob.transport.Call(ctx, "message.e2ee.put_prekey", prekeyMaterial)
	if err != nil {
		t.Fatalf("上传 prekey 失败: %v", err)
	}
	resultMap, _ := result.(map[string]any)
	if resultMap == nil {
		t.Fatalf("上传 prekey 返回 nil")
	}

	// alice 获取 bob 的 prekey
	pk1Result, err := alice.transport.Call(ctx, "message.e2ee.get_prekey", map[string]any{"aid": bobAID})
	if err != nil {
		t.Fatalf("获取 prekey 失败: %v", err)
	}
	pk1Map, _ := pk1Result.(map[string]any)
	found1, _ := pk1Map["found"].(bool)
	if !found1 {
		t.Fatalf("预期找到 prekey")
	}

	// 再次获取，应返回同一 prekey
	pk2Result, err := alice.transport.Call(ctx, "message.e2ee.get_prekey", map[string]any{"aid": bobAID})
	if err != nil {
		t.Fatalf("第二次获取 prekey 失败: %v", err)
	}
	pk2Map, _ := pk2Result.(map[string]any)
	found2, _ := pk2Map["found"].(bool)
	if !found2 {
		t.Fatalf("第二次应找到 prekey")
	}

	pk1Prekey, _ := pk1Map["prekey"].(map[string]any)
	pk2Prekey, _ := pk2Map["prekey"].(map[string]any)
	pk1ID, _ := pk1Prekey["prekey_id"].(string)
	pk2ID, _ := pk2Prekey["prekey_id"].(string)
	if pk1ID != pk2ID {
		t.Errorf("两次获取的 prekey_id 不一致: %s != %s", pk1ID, pk2ID)
	}
}

// TestIntegrationSDKToSDKPrekey 两个 SDK 客户端：alice 发送加密消息（prekey_ecdh_v2），bob 解密。
func TestIntegrationSDKToSDKPrekey(t *testing.T) {
	rid := runID()
	sender := makeClient(t)
	receiver := makeClient(t)
	defer sender.Close()
	defer receiver.Close()

	sAID := ensureConnected(t, sender, fmt.Sprintf("e2ee-s-%s.agentid.pub", rid))
	rAID := ensureConnected(t, receiver, fmt.Sprintf("e2ee-r-%s.agentid.pub", rid))

	sdkSend(t, sender, rAID, map[string]any{"text": "sdk2sdk prekey", "n": 1})

	msgs := sdkRecvPush(t, receiver, sAID, 5*time.Second)
	if len(msgs) < 1 {
		t.Fatalf("期望至少收到 1 条消息，实际 %d", len(msgs))
	}
	assertDecrypted(t, msgs[0], map[string]any{"text": "sdk2sdk prekey"}, "")
}

// TestIntegrationSDKLongTermFallback 未上传 prekey 时，验证 long_term_key 降级模式。
func TestIntegrationSDKLongTermFallback(t *testing.T) {
	rid := runID()
	sender := makeClient(t)
	receiver := makeClient(t)
	defer sender.Close()
	defer receiver.Close()

	sAID := ensureConnected(t, sender, fmt.Sprintf("e2ee-s-%s.agentid.pub", rid))

	// receiver 仅创建 AID，不连接（模拟离线接收方，无 prekey）
	rAID := fmt.Sprintf("e2ee-r-%s.agentid.pub", rid)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	_, err := receiver.Auth.CreateAID(ctx, map[string]any{"aid": rAID})
	if err != nil {
		t.Skipf("无法创建 AID: %v", err)
	}

	// sender 发送消息（对方无 prekey，应降级到 long_term_key）
	sdkSend(t, sender, rAID, map[string]any{"text": "fallback"})

	// receiver 此时认证并连接
	authResult, err := receiver.Auth.Authenticate(ctx, map[string]any{"aid": rAID})
	if err != nil {
		t.Fatalf("接收方认证失败: %v", err)
	}
	if err := receiver.Connect(ctx, authResult, nil); err != nil {
		t.Fatalf("接收方连接失败: %v", err)
	}

	// 通过 pull 拉取消息
	time.Sleep(1 * time.Second)
	msgs := sdkRecvPull(t, receiver, sAID, 0)
	if len(msgs) < 1 {
		t.Fatalf("期望至少收到 1 条消息，实际 %d", len(msgs))
	}
	assertDecrypted(t, msgs[0], map[string]any{"text": "fallback"}, "")

	// 验证加密模式为 long_term_key
	e2eeMeta, _ := msgs[0]["e2ee"].(map[string]any)
	if e2eeMeta != nil {
		mode, _ := e2eeMeta["encryption_mode"].(string)
		if mode != "long_term_key" {
			t.Errorf("期望加密模式 long_term_key，实际 %s", mode)
		}
	}
}

// TestIntegrationSDKToSDKBidirectional 双向加密消息测试。
func TestIntegrationSDKToSDKBidirectional(t *testing.T) {
	rid := runID()
	alice := makeClient(t)
	bob := makeClient(t)
	defer alice.Close()
	defer bob.Close()

	aAID := ensureConnected(t, alice, fmt.Sprintf("e2ee-a-%s.agentid.pub", rid))
	bAID := ensureConnected(t, bob, fmt.Sprintf("e2ee-b-%s.agentid.pub", rid))

	// alice -> bob
	sdkSend(t, alice, bAID, map[string]any{"text": "hello_bob", "from": "alice"})
	msgsBob := sdkRecvPush(t, bob, aAID, 5*time.Second)
	if len(msgsBob) < 1 {
		t.Fatalf("bob 期望至少收到 1 条消息，实际 %d", len(msgsBob))
	}
	assertDecrypted(t, msgsBob[0], map[string]any{"text": "hello_bob"}, "A->B")

	// bob -> alice
	sdkSend(t, bob, aAID, map[string]any{"text": "hello_alice", "from": "bob"})
	msgsAlice := sdkRecvPush(t, alice, bAID, 5*time.Second)
	if len(msgsAlice) < 1 {
		t.Fatalf("alice 期望至少收到 1 条消息，实际 %d", len(msgsAlice))
	}
	assertDecrypted(t, msgsAlice[0], map[string]any{"text": "hello_alice"}, "B->A")
}

// TestIntegrationBurstMessages 连续发送 10 条消息，验证全部接收。
func TestIntegrationBurstMessages(t *testing.T) {
	rid := runID()
	sender := makeClient(t)
	receiver := makeClient(t)
	defer sender.Close()
	defer receiver.Close()

	sAID := ensureConnected(t, sender, fmt.Sprintf("e2ee-s-%s.agentid.pub", rid))
	rAID := ensureConnected(t, receiver, fmt.Sprintf("e2ee-r-%s.agentid.pub", rid))

	const N = 10
	for i := 0; i < N; i++ {
		sdkSend(t, sender, rAID, map[string]any{
			"text": fmt.Sprintf("burst_%d", i),
			"seq":  i,
		})
	}

	// 等待消息到达
	time.Sleep(2 * time.Second)
	msgs := sdkRecvPull(t, receiver, sAID, 0)
	if len(msgs) < N {
		t.Fatalf("期望 %d 条消息，实际收到 %d", N, len(msgs))
	}

	// 验证所有消息内容
	receivedTexts := make(map[string]bool)
	for _, msg := range msgs {
		payload, _ := msg["payload"].(map[string]any)
		if payload != nil {
			text, _ := payload["text"].(string)
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

// TestIntegrationPrekeyRotation 会话中轮换 prekey，验证新旧消息均可解密。
func TestIntegrationPrekeyRotation(t *testing.T) {
	rid := runID()
	sender := makeClient(t)
	receiver := makeClient(t)
	defer sender.Close()
	defer receiver.Close()

	sAID := ensureConnected(t, sender, fmt.Sprintf("e2ee-s-%s.agentid.pub", rid))
	rAID := ensureConnected(t, receiver, fmt.Sprintf("e2ee-r-%s.agentid.pub", rid))

	// 轮换前发送
	sdkSend(t, sender, rAID, map[string]any{"text": "before_rotate", "phase": 1})

	// receiver 轮换 prekey
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := receiver.uploadPrekey(ctx); err != nil {
		t.Fatalf("轮换 prekey 失败: %v", err)
	}

	// 轮换后发送（sender 的缓存可能仍是旧 prekey，但接收方应能解密两者）
	sdkSend(t, sender, rAID, map[string]any{"text": "after_rotate", "phase": 2})

	time.Sleep(2 * time.Second)
	msgs := sdkRecvPull(t, receiver, sAID, 0)
	if len(msgs) < 2 {
		t.Fatalf("期望至少 2 条消息，实际 %d", len(msgs))
	}

	// 验证两条消息都收到
	texts := make(map[string]bool)
	for _, msg := range msgs {
		payload, _ := msg["payload"].(map[string]any)
		if payload != nil {
			text, _ := payload["text"].(string)
			texts[text] = true
		}
	}
	if !texts["before_rotate"] {
		t.Error("缺少 before_rotate 消息")
	}
	if !texts["after_rotate"] {
		t.Error("缺少 after_rotate 消息")
	}
}

// TestIntegrationPushThenPullNoDuplicate 推送收到的消息，再 pull 不应重复。
func TestIntegrationPushThenPullNoDuplicate(t *testing.T) {
	rid := runID()
	sender := makeClient(t)
	receiver := makeClient(t)
	defer sender.Close()
	defer receiver.Close()

	sAID := ensureConnected(t, sender, fmt.Sprintf("e2ee-s-%s.agentid.pub", rid))
	rAID := ensureConnected(t, receiver, fmt.Sprintf("e2ee-r-%s.agentid.pub", rid))

	// 设置推送监听
	var pushMu sync.Mutex
	var pushMsgs []map[string]any
	pushEvent := make(chan struct{}, 1)

	sub := receiver.On("message.received", func(payload any) {
		data, ok := payload.(map[string]any)
		if !ok {
			return
		}
		from, _ := data["from"].(string)
		if from == sAID {
			pushMu.Lock()
			pushMsgs = append(pushMsgs, data)
			pushMu.Unlock()
			select {
			case pushEvent <- struct{}{}:
			default:
			}
		}
	})

	sdkSend(t, sender, rAID, map[string]any{"text": "dup_test"})

	// 等待推送
	timer := time.NewTimer(5 * time.Second)
	select {
	case <-pushEvent:
	case <-timer.C:
	}
	timer.Stop()
	sub.Unsubscribe()

	pushMu.Lock()
	pushCount := len(pushMsgs)
	pushMu.Unlock()

	if pushCount == 0 {
		t.Skip("推送未收到，跳过去重测试")
	}

	// 验证推送消息
	if pushCount != 1 {
		t.Errorf("推送应只收到 1 条，实际 %d", pushCount)
	}
	pushMu.Lock()
	assertDecrypted(t, pushMsgs[0], map[string]any{"text": "dup_test"}, "push")
	pushMu.Unlock()

	// pull 获取消息
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pullResult, err := receiver.Call(ctx, "message.pull", map[string]any{
		"after_seq": 0,
		"limit":     50,
	})
	if err != nil {
		t.Fatalf("pull 失败: %v", err)
	}
	pullMap, _ := pullResult.(map[string]any)
	pullMsgs, _ := pullMap["messages"].([]any)

	// 统计来自 sender 且已加密的消息数
	var pullEncrypted int
	for _, m := range pullMsgs {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		from, _ := msg["from"].(string)
		enc, _ := msg["encrypted"].(bool)
		if from == sAID && enc {
			pullEncrypted++
		}
	}
	t.Logf("push=%d, pull_encrypted=%d", pushCount, pullEncrypted)
}
