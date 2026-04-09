package aun

import (
	"context"
	"crypto/ecdsa"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/aun-sdk-core/go/keystore"
	"github.com/anthropics/aun-sdk-core/go/namespace"
)

// ClientState 客户端状态
type ClientState string

const (
	StateIdle           ClientState = "idle"            // 空闲，尚未连接
	StateConnecting     ClientState = "connecting"      // 正在建立连接
	StateAuthenticating ClientState = "authenticating"  // 正在进行认证
	StateConnected      ClientState = "connected"       // 已连接并认证
	StateDisconnected   ClientState = "disconnected"    // 连接断开
	StateReconnecting   ClientState = "reconnecting"    // 正在重连
	StateTerminalFailed ClientState = "terminal_failed" // 不可恢复的失败
	StateClosed         ClientState = "closed"          // 已关闭
)

// ConnectOptions 连接选项
type ConnectOptions struct {
	AutoReconnect         bool           // 是否自动重连
	HeartbeatInterval     int            // 心跳间隔（秒），默认 30
	TokenRefreshBefore    int            // token 到期前多少秒刷新，默认 60
	PrekeyRefreshInterval int            // prekey 刷新间隔（秒），默认 3600
	Retry                 *RetryConfig   // 重试配置
	Timeouts              *TimeoutConfig // 超时配置
}

// RetryConfig 重试配置
type RetryConfig struct {
	InitialDelay float64 // 初始延迟（秒）
	MaxDelay     float64 // 最大延迟（秒）
}

// TimeoutConfig 超时配置
type TimeoutConfig struct {
	Connect float64 // 连接超时（秒）
	Call    float64 // RPC 调用超时（秒）
}

// 内部专用方法集合，禁止用户直接调用
var internalOnlyMethods = map[string]bool{
	"auth.login1":        true,
	"auth.aid_login1":    true,
	"auth.login2":        true,
	"auth.aid_login2":    true,
	"auth.connect":       true,
	"auth.refresh_token": true,
	"initialize":         true,
}

// 需要客户端签名的关键方法
var signedMethods = map[string]bool{
	"group.send":          true,
	"group.kick":          true,
	"group.add_member":    true,
	"group.leave":         true,
	"group.remove_member": true,
	"group.update_rules":  true,
}

// 对端证书缓存 TTL（秒）
const peerCertCacheTTL = 600

// cachedPeerCert 缓存的对端证书条目
type cachedPeerCert struct {
	certBytes    []byte  // PEM 编码的证书
	validatedAt  float64 // PKI 验证通过的时间（Unix 秒）
	refreshAfter float64 // 缓存过期时间（Unix 秒）
}

// AUNClient AUN 协议客户端主类
type AUNClient struct {
	mu          sync.RWMutex
	config      map[string]any
	configModel *AUNConfig
	state       ClientState
	aid         string
	identity    map[string]any
	gatewayURL  string
	closing     bool

	// 组件
	crypto    *CryptoProvider
	keyStore  keystore.KeyStore
	auth      *AuthFlow
	transport *RPCTransport
	events    *EventDispatcher
	discovery *GatewayDiscovery
	e2ee      *E2EEManager
	groupE2EE *GroupE2EEManager

	// 会话参数
	sessionParams  map[string]any
	sessionOptions map[string]any

	// 对端证书缓存
	certCache   map[string]*cachedPeerCert
	certCacheMu sync.RWMutex

	// 后台任务上下文
	ctx    context.Context
	cancel context.CancelFunc

	// Auth 命名空间
	Auth *namespace.AuthNamespace
}

// NewClient 创建 AUN 客户端
func NewClient(config map[string]any) *AUNClient {
	rawConfig := make(map[string]any)
	for k, v := range config {
		rawConfig[k] = v
	}
	cfg := ConfigFromMap(rawConfig)
	events := NewEventDispatcher()
	crypto := &CryptoProvider{}

	// 初始化 keystore（外部传入或默认 FileKeyStore）
	var ks keystore.KeyStore
	if v, ok := rawConfig["keystore"]; ok {
		if ksTyped, ok := v.(keystore.KeyStore); ok {
			ks = ksTyped
		}
	}
	if ks == nil {
		// FileKeyStore 需要由调用方提供，或者使用默认参数创建
		// 此处使用最简单的方式：尝试创建
		fks, err := keystore.NewFileKeyStore(cfg.AUNPath, nil, cfg.EncryptionSeed)
		if err != nil {
			log.Printf("创建默认 FileKeyStore 失败: %v, 使用空路径", err)
			fks, _ = keystore.NewFileKeyStore(cfg.AUNPath, nil, "")
		}
		ks = fks
	}

	// 创建 AuthFlow
	authFlow := NewAuthFlow(AuthFlowConfig{
		Keystore:   ks,
		Crypto:     crypto,
		VerifySSL:  cfg.VerifySSL,
		RootCAPath: cfg.RootCAPath,
	})

	c := &AUNClient{
		config:      rawConfig,
		configModel: cfg,
		state:       StateIdle,
		crypto:      crypto,
		keyStore:    ks,
		auth:        authFlow,
		events:      events,
		discovery:   NewGatewayDiscovery(cfg.VerifySSL),
		certCache:   make(map[string]*cachedPeerCert),
		sessionOptions: map[string]any{
			"auto_reconnect":       false,
			"heartbeat_interval":   30.0,
			"token_refresh_before": 60.0,
			"retry": map[string]any{
				"initial_delay": 0.5,
				"max_delay":     30.0,
			},
			"timeouts": map[string]any{
				"connect": 5.0,
				"call":    10.0,
				"http":    30.0,
			},
		},
	}

	// 创建 RPCTransport（使用断线回调）
	c.transport = NewRPCTransport(events, 10*time.Second, func(err error) {
		c.handleTransportDisconnect(err)
	}, cfg.VerifySSL)

	// 创建 E2EE 管理器
	c.e2ee = NewE2EEManager(E2EEManagerConfig{
		IdentityFn: func() map[string]any {
			c.mu.RLock()
			defer c.mu.RUnlock()
			if c.identity != nil {
				return c.identity
			}
			return map[string]any{}
		},
		Keystore:         ks,
		ReplayWindowSecs: cfg.ReplayWindowSeconds,
	})

	// 创建群组 E2EE 管理器
	c.groupE2EE = NewGroupE2EEManager(GroupE2EEManagerConfig{
		IdentityFn: func() map[string]any {
			c.mu.RLock()
			defer c.mu.RUnlock()
			if c.identity != nil {
				return c.identity
			}
			return map[string]any{}
		},
		Keystore:              ks,
		Config:                cfg,
		SenderCertResolver:    func(aid string) string { return c.getVerifiedPeerCert(aid) },
		InitiatorCertResolver: func(aid string) string { return c.getVerifiedPeerCert(aid) },
	})

	// Auth 命名空间
	c.Auth = namespace.NewAuthNamespace(c)

	// 订阅内部事件：推送消息自动解密后 re-publish
	events.Subscribe("_raw.message.received", func(payload any) {
		c.onRawMessageReceived(payload)
	})
	// 群组消息推送：自动解密后 re-publish
	events.Subscribe("_raw.group.message_created", func(payload any) {
		c.onRawGroupMessageCreated(payload)
	})
	// 群组变更事件：拦截处理成员变更触发的 epoch 轮换，然后透传
	events.Subscribe("_raw.group.changed", func(payload any) {
		c.onRawGroupChanged(payload)
	})
	// 其他事件直接透传
	events.Subscribe("_raw.message.recalled", func(payload any) {
		events.Publish("message.recalled", payload)
	})
	events.Subscribe("_raw.message.ack", func(payload any) {
		events.Publish("message.ack", payload)
	})

	return c
}

// ── 属性访问 ──────────────────────────────────────────────

// AID 返回当前认证的 Agent ID
func (c *AUNClient) AID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.aid
}

// State 返回当前连接状态
func (c *AUNClient) State() ClientState {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

// E2EE 返回 P2P E2EE 管理器
func (c *AUNClient) E2EE() *E2EEManager {
	return c.e2ee
}

// GroupE2EE 返回群组 E2EE 管理器
func (c *AUNClient) GroupE2EE() *GroupE2EEManager {
	return c.groupE2EE
}

// ── namespace.ClientInterface 实现 ─────────────────────────

// GetGatewayURL 返回当前 Gateway URL
func (c *AUNClient) GetGatewayURL() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.gatewayURL
}

// SetGatewayURL 设置 Gateway URL
func (c *AUNClient) SetGatewayURL(u string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gatewayURL = u
}

// GetAID 返回当前 AID
func (c *AUNClient) GetAID() string {
	return c.AID()
}

// SetAID 设置当前 AID
func (c *AUNClient) SetAID(aid string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.aid = aid
}

// GetConfigDiscoveryPort 返回发现端口
func (c *AUNClient) GetConfigDiscoveryPort() int {
	return c.configModel.DiscoveryPort
}

// GetConfigVerifySSL 返回是否验证 SSL
func (c *AUNClient) GetConfigVerifySSL() bool {
	return c.configModel.VerifySSL
}

// AuthCreateAID 通过 AuthFlow 创建 AID
func (c *AUNClient) AuthCreateAID(ctx context.Context, gatewayURL, aid string) (map[string]any, error) {
	return c.auth.CreateAID(ctx, gatewayURL, aid)
}

// AuthAuthenticate 通过 AuthFlow 认证 AID
func (c *AUNClient) AuthAuthenticate(ctx context.Context, gatewayURL, aid string) (map[string]any, error) {
	return c.auth.Authenticate(ctx, gatewayURL, aid)
}

// AuthLoadIdentityOrNil 通过 AuthFlow 加载身份，不存在返回 nil
func (c *AUNClient) AuthLoadIdentityOrNil(aid string) map[string]any {
	return c.auth.LoadIdentityOrNil(aid)
}

// DiscoverGateway 通过 GatewayDiscovery 发现 Gateway URL
func (c *AUNClient) DiscoverGateway(ctx context.Context, wellKnownURL string, timeout time.Duration) (string, error) {
	return c.discovery.Discover(ctx, wellKnownURL, timeout)
}

// SetIdentity 设置当前身份信息
func (c *AUNClient) SetIdentity(identity map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.identity = identity
}

// ── 生命周期 ──────────────────────────────────────────────

// Connect 连接到 AUN Gateway
func (c *AUNClient) Connect(ctx context.Context, auth map[string]any, opts *ConnectOptions) error {
	c.mu.RLock()
	state := c.state
	c.mu.RUnlock()

	if state != StateIdle && state != StateClosed {
		return NewStateError(fmt.Sprintf("connect 不允许在状态 %s 下调用", state))
	}

	// 合并参数
	params := make(map[string]any)
	for k, v := range auth {
		params[k] = v
	}
	if opts != nil {
		if opts.AutoReconnect {
			params["auto_reconnect"] = true
		}
		if opts.HeartbeatInterval > 0 {
			params["heartbeat_interval"] = float64(opts.HeartbeatInterval)
		}
		if opts.TokenRefreshBefore > 0 {
			params["token_refresh_before"] = float64(opts.TokenRefreshBefore)
		}
		if opts.Retry != nil {
			params["retry"] = map[string]any{
				"initial_delay": opts.Retry.InitialDelay,
				"max_delay":     opts.Retry.MaxDelay,
			}
		}
		if opts.Timeouts != nil {
			params["timeouts"] = map[string]any{
				"connect": opts.Timeouts.Connect,
				"call":    opts.Timeouts.Call,
			}
		}
	}

	// 规范化参数
	normalized, err := c.normalizeConnectParams(params)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.sessionParams = normalized
	c.sessionOptions = c.buildSessionOptions(normalized)
	c.closing = false
	c.mu.Unlock()

	// 设置传输层超时
	c.mu.RLock()
	if timeouts, ok := c.sessionOptions["timeouts"].(map[string]any); ok {
		if callTimeout, ok := timeouts["call"].(float64); ok {
			c.transport.SetTimeout(time.Duration(callTimeout * float64(time.Second)))
		}
	}
	c.mu.RUnlock()

	return c.connectOnce(ctx, normalized, false)
}

// Close 关闭客户端，取消所有后台任务
func (c *AUNClient) Close() error {
	c.mu.Lock()
	c.closing = true
	state := c.state
	cancelFn := c.cancel
	c.mu.Unlock()

	// 取消所有后台任务
	if cancelFn != nil {
		cancelFn()
	}

	if state == StateIdle || state == StateClosed {
		c.mu.Lock()
		c.state = StateClosed
		c.mu.Unlock()
		return nil
	}

	// 关闭传输层
	if err := c.transport.Close(); err != nil {
		log.Printf("关闭传输层失败: %v", err)
	}

	c.mu.Lock()
	c.state = StateClosed
	c.mu.Unlock()

	c.events.Publish("connection.state", map[string]any{"state": string(StateClosed)})
	return nil
}

// ── RPC 调用 ──────────────────────────────────────────────

// Call 发送 RPC 调用（自动 E2EE 加解密）
func (c *AUNClient) Call(ctx context.Context, method string, params map[string]any) (any, error) {
	c.mu.RLock()
	state := c.state
	c.mu.RUnlock()

	if state != StateConnected {
		return nil, NewConnectionError("客户端未连接")
	}
	if internalOnlyMethods[method] {
		return nil, NewPermissionError(fmt.Sprintf("方法 %s 为内部专用", method))
	}

	if params == nil {
		params = make(map[string]any)
	} else {
		// 浅拷贝，避免修改调用方的 params
		copied := make(map[string]any, len(params))
		for k, v := range params {
			copied[k] = v
		}
		params = copied
	}

	// 自动加密：message.send 默认加密
	if method == "message.send" {
		encrypt := true
		if enc, ok := params["encrypt"]; ok {
			if encBool, ok := enc.(bool); ok {
				encrypt = encBool
			}
			delete(params, "encrypt")
		}
		if encrypt {
			return c.sendEncrypted(ctx, params)
		}
	}

	// 自动加密：group.send 默认加密
	if method == "group.send" {
		encrypt := true
		if enc, ok := params["encrypt"]; ok {
			if encBool, ok := enc.(bool); ok {
				encrypt = encBool
			}
			delete(params, "encrypt")
		}
		if encrypt {
			return c.sendGroupEncrypted(ctx, params)
		}
	}

	// 关键操作自动附加客户端签名
	if signedMethods[method] {
		c.signClientOperation(method, params)
	}

	result, err := c.transport.Call(ctx, method, params)
	if err != nil {
		return nil, err
	}

	// 自动解密：message.pull 返回的消息
	if method == "message.pull" {
		if resultMap, ok := result.(map[string]any); ok {
			if messages, ok := resultMap["messages"].([]any); ok && len(messages) > 0 {
				resultMap["messages"] = c.decryptMessages(ctx, messages)
			}
		}
	}

	// 自动解密：group.pull 返回的群消息
	if method == "group.pull" {
		if resultMap, ok := result.(map[string]any); ok {
			if messages, ok := resultMap["messages"].([]any); ok && len(messages) > 0 {
				resultMap["messages"] = c.decryptGroupMessages(ctx, messages)
			}
		}
	}

	// ── Group E2EE 自动编排 ────────────────────────────────
	if c.configModel.GroupE2EE {
		c.orchestrateGroupE2EE(ctx, method, params, result)
	}

	return result, nil
}

// orchestrateGroupE2EE 群组 E2EE 自动编排（建群、加人、踢人等后自动处理密钥）
func (c *AUNClient) orchestrateGroupE2EE(ctx context.Context, method string, params map[string]any, result any) {
	resultMap, _ := result.(map[string]any)

	// 建群后自动创建 epoch
	if method == "group.create" && resultMap != nil {
		group, _ := resultMap["group"].(map[string]any)
		gid, _ := group["group_id"].(string)
		c.mu.RLock()
		myAID := c.aid
		c.mu.RUnlock()
		if gid != "" && myAID != "" && !c.groupE2EE.HasSecret(gid) {
			_, err := c.groupE2EE.CreateEpoch(gid, []string{myAID})
			if err != nil {
				c.logE2EEError("create_epoch", gid, "", err)
			} else {
				// 后台同步到服务端
				go c.syncEpochToServer(context.Background(), gid)
			}
		}
	}

	// 加人后自动分发密钥给新成员
	if method == "group.add_member" {
		groupID, _ := params["group_id"].(string)
		newAID, _ := params["aid"].(string)
		if groupID != "" && newAID != "" {
			if c.configModel.RotateOnJoin {
				go c.rotateGroupEpoch(context.Background(), groupID)
			} else {
				go c.distributeKeyToNewMember(context.Background(), groupID, newAID)
			}
		}
	}

	// 踢人后自动轮换 epoch
	if method == "group.kick" {
		groupID, _ := params["group_id"].(string)
		if groupID != "" {
			go c.rotateGroupEpoch(context.Background(), groupID)
		}
	}

	// 审批通过后自动分发密钥给新成员
	if method == "group.review_join_request" && resultMap != nil {
		approved, _ := resultMap["approved"].(bool)
		status, _ := resultMap["status"].(string)
		if approved || status == "approved" {
			groupID, _ := params["group_id"].(string)
			newAID, _ := params["aid"].(string)
			if groupID != "" && newAID != "" {
				go c.distributeKeyToNewMember(context.Background(), groupID, newAID)
			}
		}
	}

	// 批量审批通过后分发密钥
	if method == "group.batch_review_join_request" && resultMap != nil {
		groupID, _ := params["group_id"].(string)
		results, _ := resultMap["results"].([]any)
		var approvedAIDs []string
		for _, item := range results {
			if itemMap, ok := item.(map[string]any); ok {
				isOK, _ := itemMap["ok"].(bool)
				status, _ := itemMap["status"].(string)
				aidStr, _ := itemMap["aid"].(string)
				if isOK && status == "approved" && aidStr != "" {
					approvedAIDs = append(approvedAIDs, aidStr)
				}
			}
		}
		if groupID != "" && len(approvedAIDs) > 0 {
			if c.configModel.RotateOnJoin {
				go c.rotateGroupEpoch(context.Background(), groupID)
			} else {
				for _, aidStr := range approvedAIDs {
					aidCopy := aidStr
					go c.distributeKeyToNewMember(context.Background(), groupID, aidCopy)
				}
			}
		}
	}
}

// signClientOperation 为关键操作附加客户端 ECDSA 签名
func (c *AUNClient) signClientOperation(method string, params map[string]any) {
	c.mu.RLock()
	identity := c.identity
	c.mu.RUnlock()
	if identity == nil {
		return
	}
	privPEM, _ := identity["private_key_pem"].(string)
	if privPEM == "" {
		return
	}

	aidStr, _ := identity["aid"].(string)
	ts := fmt.Sprintf("%d", time.Now().Unix())

	// 计算 params hash：签名覆盖所有非 _ 前缀且非 client_signature 的业务字段
	paramsForHash := make(map[string]any)
	for k, v := range params {
		if k != "client_signature" && !strings.HasPrefix(k, "_") {
			paramsForHash[k] = v
		}
	}
	paramsJSON, err := json.Marshal(paramsForHash)
	if err != nil {
		log.Printf("客户端签名序列化失败: %v", err)
		return
	}
	// Go json.Marshal 默认 UTF-8 直接输出 + 自动键排序，与 AUN Canonical JSON 规范一致
	paramsHash := fmt.Sprintf("%x", sha256.Sum256(paramsJSON))
	signData := []byte(fmt.Sprintf("%s|%s|%s|%s", method, aidStr, ts, paramsHash))

	pk, err := parseECPrivateKeyPEM(privPEM)
	if err != nil {
		log.Printf("客户端签名解析私钥失败: %v", err)
		return
	}
	hash := sha256.Sum256(signData)
	sig, err := ecdsa.SignASN1(cryptorand.Reader, pk, hash[:])
	if err != nil {
		log.Printf("客户端签名失败: %v", err)
		return
	}

	params["client_signature"] = map[string]any{
		"aid":         aidStr,
		"timestamp":   ts,
		"params_hash": paramsHash,
		"signature":   base64.StdEncoding.EncodeToString(sig),
	}
}

// ── 自动加密发送 ────────────────────────────────────────────

// sendEncrypted 自动加密并发送 P2P 消息
func (c *AUNClient) sendEncrypted(ctx context.Context, params map[string]any) (any, error) {
	toAID, _ := params["to"].(string)
	payload, _ := params["payload"].(map[string]any)
	messageID, _ := params["message_id"].(string)
	if messageID == "" {
		messageID = generateUUID4()
	}
	timestamp := toInt64(params["timestamp"])
	if timestamp == 0 {
		timestamp = time.Now().UnixMilli()
	}

	// 获取对方证书
	peerCertPEM, err := c.fetchPeerCert(ctx, toAID)
	if err != nil {
		return nil, err
	}

	// 获取对方 prekey（可能没有）
	prekey := c.fetchPeerPrekey(ctx, toAID)

	envelope, encryptResult, err := c.e2ee.EncryptOutbound(
		toAID, payload, peerCertPEM, prekey, messageID, timestamp,
	)
	if err != nil {
		return nil, err
	}

	encrypted, _ := encryptResult["encrypted"].(bool)
	if !encrypted {
		return nil, NewE2EEError(fmt.Sprintf("加密消息到 %s 失败", toAID), "E2EE_ENCRYPT_FAILED")
	}

	// 严格模式：拒绝无前向保密的降级
	forwardSecrecy, _ := encryptResult["forward_secrecy"].(bool)
	if c.configModel.RequireForwardSecrecy && !forwardSecrecy {
		mode, _ := encryptResult["mode"].(string)
		return nil, NewE2EEError(
			fmt.Sprintf("前向保密要求但 %s 不可用 (mode=%s)", toAID, mode),
			"E2EE_FORWARD_SECRECY_REQUIRED",
		)
	}

	// 降级时发布安全事件
	degraded, _ := encryptResult["degraded"].(bool)
	if degraded {
		c.events.Publish("e2ee.degraded", map[string]any{
			"peer_aid": toAID,
			"mode":     encryptResult["mode"],
			"reason":   encryptResult["degradation_reason"],
		})
	}

	persist := true
	if p, ok := params["persist"].(bool); ok {
		persist = p
	}

	sendParams := map[string]any{
		"to":         toAID,
		"payload":    envelope,
		"type":       "e2ee.encrypted",
		"encrypted":  true,
		"message_id": messageID,
		"timestamp":  timestamp,
		"persist":    persist,
	}
	return c.transport.Call(ctx, "message.send", sendParams)
}

// sendGroupEncrypted 自动加密并发送群组消息
func (c *AUNClient) sendGroupEncrypted(ctx context.Context, params map[string]any) (any, error) {
	groupID, _ := params["group_id"].(string)
	payload, _ := params["payload"].(map[string]any)
	if groupID == "" {
		return nil, NewValidationError("group.send 需要 group_id")
	}

	envelope, err := c.groupE2EE.Encrypt(groupID, payload)
	if err != nil {
		return nil, err
	}

	sendParams := map[string]any{
		"group_id":  groupID,
		"payload":   envelope,
		"type":      "e2ee.group_encrypted",
		"encrypted": true,
	}
	c.signClientOperation("group.send", sendParams)
	return c.transport.Call(ctx, "group.send", sendParams)
}

// ── 便利方法 ──────────────────────────────────────────────

// On 订阅事件
func (c *AUNClient) On(event string, handler EventHandler) *Subscription {
	return c.events.Subscribe(event, handler)
}

// Ping 发送心跳
func (c *AUNClient) Ping(ctx context.Context) (any, error) {
	return c.Call(ctx, "meta.ping", nil)
}

// Status 查询服务状态
func (c *AUNClient) Status(ctx context.Context) (any, error) {
	return c.Call(ctx, "meta.status", nil)
}

// TrustRoots 获取信任根
func (c *AUNClient) TrustRoots(ctx context.Context) (any, error) {
	return c.Call(ctx, "meta.trust_roots", nil)
}

// ── 事件处理 ──────────────────────────────────────────────

// onRawMessageReceived 处理 transport 层推送的原始消息
func (c *AUNClient) onRawMessageReceived(data any) {
	go c.processAndPublishMessage(data)
}

// processAndPublishMessage 实际处理推送消息的 goroutine
func (c *AUNClient) processAndPublishMessage(data any) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("processAndPublishMessage panic: %v", r)
		}
	}()

	dataMap, ok := data.(map[string]any)
	if !ok {
		c.events.Publish("message.received", data)
		return
	}

	msg := copyMapShallow(dataMap)

	// 拦截 P2P 传输的群组密钥分发/请求/响应消息
	if c.tryHandleGroupKeyMessage(msg) {
		return
	}

	ctx := context.Background()
	decrypted := c.decryptSingleMessage(ctx, msg)
	c.events.Publish("message.received", decrypted)
}

// onRawGroupMessageCreated 处理群组消息推送
func (c *AUNClient) onRawGroupMessageCreated(data any) {
	go c.processAndPublishGroupMessage(data)
}

// processAndPublishGroupMessage 处理群组推送消息的 goroutine
func (c *AUNClient) processAndPublishGroupMessage(data any) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("processAndPublishGroupMessage panic: %v", r)
		}
	}()

	dataMap, ok := data.(map[string]any)
	if !ok {
		c.events.Publish("group.message_created", data)
		return
	}

	msg := copyMapShallow(dataMap)
	ctx := context.Background()
	decrypted := c.decryptGroupMessage(ctx, msg)
	c.events.Publish("group.message_created", decrypted)
}

// onRawGroupChanged 处理群组变更事件
func (c *AUNClient) onRawGroupChanged(data any) {
	// 透传给用户
	c.events.Publish("group.changed", data)

	// 成员退出或被踢 → 剩余 admin/owner 自动补位轮换
	dataMap, ok := data.(map[string]any)
	if !ok {
		return
	}
	action, _ := dataMap["action"].(string)
	if action == "member_left" || action == "member_removed" {
		groupID, _ := dataMap["group_id"].(string)
		if groupID != "" {
			go c.rotateGroupEpoch(context.Background(), groupID)
		}
	}
}

// tryHandleGroupKeyMessage 尝试处理 P2P 传输的群组密钥消息。返回 true 表示已处理。
func (c *AUNClient) tryHandleGroupKeyMessage(message map[string]any) bool {
	payload, ok := message["payload"].(map[string]any)
	if !ok {
		return false
	}

	// 先解密 P2P E2EE（如果是加密的）
	actualPayload := payload
	payloadType, _ := payload["type"].(string)
	if payloadType == "e2ee.encrypted" {
		fromAID, _ := message["from"].(string)
		if fromAID != "" {
			c.ensureSenderCertCached(context.Background(), fromAID)
		}
		// 使用内部解密，避免消耗 seen set
		decrypted, err := c.e2ee.decryptMessage(message)
		if err != nil || decrypted == nil {
			return false
		}
		ap, ok := decrypted["payload"].(map[string]any)
		if !ok {
			return false
		}
		actualPayload = ap
	}

	result := c.groupE2EE.HandleIncoming(actualPayload)
	if result == "" {
		return false
	}

	if result == "request" {
		// 处理密钥请求并回复
		groupID, _ := actualPayload["group_id"].(string)
		requester, _ := actualPayload["requester_aid"].(string)
		members := c.groupE2EE.GetMemberAIDs(groupID)

		// 请求者不在本地成员列表时，回源查询服务端最新成员列表
		if requester != "" && !stringSliceContains(members, requester) {
			ctx := context.Background()
			membersResult, err := c.Call(ctx, "group.get_members", map[string]any{"group_id": groupID})
			if err == nil {
				if mr, ok := membersResult.(map[string]any); ok {
					if membersList, ok := mr["members"].([]any); ok {
						members = extractAIDsFromMembers(membersList)
						// 更新本地当前 epoch 的 member_aids/commitment
						if stringSliceContains(members, requester) {
							secretData := c.groupE2EE.LoadSecret(groupID)
							if secretData != nil {
								c.mu.RLock()
								myAID := c.aid
								c.mu.RUnlock()
								epoch := int(toInt64(secretData["epoch"]))
								secret, _ := secretData["secret"].([]byte)
								commitment := ComputeMembershipCommitment(members, epoch, groupID, secret)
								StoreGroupSecret(c.keyStore, myAID, groupID, epoch, secret, commitment, members)
							}
						}
					}
				}
			}
		}

		response := c.groupE2EE.HandleKeyRequestMsg(actualPayload, members)
		if response != nil && requester != "" {
			ctx := context.Background()
			_, err := c.Call(ctx, "message.send", map[string]any{
				"to":      requester,
				"payload": response,
				"encrypt": true,
				"persist": false,
			})
			if err != nil {
				log.Printf("向 %s 回复群组密钥失败: %v", requester, err)
			}
		}
	}

	return true
}

// ── E2EE 编排辅助 ────────────────────────────────────────

// fetchPeerCert 获取对方证书（带缓存 + 完整 PKI 验证）
func (c *AUNClient) fetchPeerCert(ctx context.Context, aid string) ([]byte, error) {
	c.certCacheMu.RLock()
	cached := c.certCache[aid]
	c.certCacheMu.RUnlock()
	if cached != nil && float64(time.Now().Unix()) < cached.refreshAfter {
		return cached.certBytes, nil
	}

	c.mu.RLock()
	gatewayURL := c.gatewayURL
	c.mu.RUnlock()
	if gatewayURL == "" {
		return nil, NewValidationError("gateway url 不可用，无法获取证书")
	}

	// 跨域时用 peer 所在域的 Gateway URL
	peerGatewayURL := resolvePeerGatewayURL(gatewayURL, aid)
	certURL := buildCertURL(peerGatewayURL, aid)

	// HTTP GET 下载证书
	transport := &http.Transport{}
	if !c.configModel.VerifySSL {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	client := &http.Client{Timeout: 5 * time.Second, Transport: transport}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, certURL, nil)
	if err != nil {
		return nil, NewAuthError(fmt.Sprintf("创建证书请求失败: %v", err))
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, NewAuthError(fmt.Sprintf("获取证书失败 (%s): %v", aid, err))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, NewAuthError(fmt.Sprintf("获取证书失败 (%s): HTTP %d", aid, resp.StatusCode))
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, NewAuthError(fmt.Sprintf("读取证书响应失败 (%s): %v", aid, err))
	}
	certBytes := body

	// 完整 PKI 验证：链 + CRL + OCSP + AID 绑定
	if err := c.auth.VerifyPeerCertificate(ctx, peerGatewayURL, certBytes, aid); err != nil {
		return nil, NewValidationError(fmt.Sprintf("对端证书验证失败 (%s): %v", aid, err))
	}

	now := float64(time.Now().Unix())
	c.certCacheMu.Lock()
	c.certCache[aid] = &cachedPeerCert{
		certBytes:    certBytes,
		validatedAt:  now,
		refreshAfter: now + peerCertCacheTTL,
	}
	c.certCacheMu.Unlock()

	// 同步写入 keystore
	if err := c.keyStore.SaveCert(aid, string(certBytes)); err != nil {
		log.Printf("写入证书到 keystore 失败 (aid=%s): %v", aid, err)
	}

	return certBytes, nil
}

// fetchPeerPrekey 获取对方的 prekey
func (c *AUNClient) fetchPeerPrekey(ctx context.Context, peerAID string) map[string]any {
	cached := c.e2ee.GetCachedPrekey(peerAID)
	if cached != nil {
		return cached
	}
	result, err := c.transport.Call(ctx, "message.e2ee.get_prekey", map[string]any{"aid": peerAID})
	if err != nil {
		log.Printf("获取 prekey 失败 (%s): %v", peerAID, err)
		return nil
	}
	resultMap, ok := result.(map[string]any)
	if !ok {
		return nil
	}
	found, _ := resultMap["found"].(bool)
	if !found {
		return nil
	}
	prekey, _ := resultMap["prekey"].(map[string]any)
	if prekey != nil {
		c.e2ee.CachePrekey(peerAID, prekey)
	}
	return prekey
}

// uploadPrekey 生成 prekey 并上传到服务端
func (c *AUNClient) uploadPrekey(ctx context.Context) error {
	prekeyMaterial, err := c.e2ee.GeneratePrekey()
	if err != nil {
		return err
	}
	_, err = c.transport.Call(ctx, "message.e2ee.put_prekey", prekeyMaterial)
	return err
}

// ensureSenderCertCached 确保发送方证书在本地 keystore 中可用
func (c *AUNClient) ensureSenderCertCached(ctx context.Context, aid string) bool {
	c.certCacheMu.RLock()
	cached := c.certCache[aid]
	c.certCacheMu.RUnlock()

	if cached != nil && float64(time.Now().Unix()) < cached.refreshAfter {
		return true
	}

	certBytes, err := c.fetchPeerCert(ctx, aid)
	if err != nil {
		// 刷新失败时：若内存缓存有 PKI 验证过的证书则继续用
		if cached != nil && float64(time.Now().Unix()) < cached.validatedAt+peerCertCacheTTL*2 {
			log.Printf("刷新发送方 %s 证书失败，继续使用已验证的内存缓存: %v", aid, err)
			return true
		}
		log.Printf("获取发送方 %s 证书失败且无已验证缓存，拒绝信任: %v", aid, err)
		return false
	}
	certPEM := string(certBytes)
	if err := c.keyStore.SaveCert(aid, certPEM); err != nil {
		log.Printf("保存证书失败 (aid=%s): %v", aid, err)
	}
	return true
}

// getVerifiedPeerCert 获取经过 PKI 验证的 peer 证书（零信任：仅信任内存缓存中已验证的证书）
func (c *AUNClient) getVerifiedPeerCert(aid string) string {
	c.certCacheMu.RLock()
	cached := c.certCache[aid]
	c.certCacheMu.RUnlock()
	if cached != nil && float64(time.Now().Unix()) < cached.validatedAt+peerCertCacheTTL*2 {
		return string(cached.certBytes)
	}
	return ""
}

// ── 解密辅助 ──────────────────────────────────────────────

// decryptSingleMessage 解密单条 P2P 消息
func (c *AUNClient) decryptSingleMessage(ctx context.Context, message map[string]any) map[string]any {
	payload, ok := message["payload"].(map[string]any)
	if !ok {
		return message
	}
	payloadType, _ := payload["type"].(string)
	if payloadType != "e2ee.encrypted" {
		return message
	}
	// 检查 encrypted 标记
	if enc, exists := message["encrypted"]; exists {
		if encBool, ok := enc.(bool); ok && !encBool {
			return message
		}
	}

	// 确保发送方证书已缓存
	fromAID, _ := message["from"].(string)
	if fromAID != "" {
		if !c.ensureSenderCertCached(ctx, fromAID) {
			log.Printf("无法获取发送方 %s 的证书，跳过解密", fromAID)
			return message
		}
	}

	// 密码学解密（E2EEManager.DecryptMessage 内含本地防重放）
	decrypted, err := c.e2ee.DecryptMessage(message)
	if err != nil || decrypted == nil {
		return message
	}
	return decrypted
}

// decryptMessages 批量解密 P2P 消息（用于 message.pull）
func (c *AUNClient) decryptMessages(ctx context.Context, messages []any) []any {
	seenInBatch := make(map[string]bool)
	var result []any
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			result = append(result, raw)
			continue
		}
		mid, _ := msg["message_id"].(string)
		if mid != "" && seenInBatch[mid] {
			continue
		}
		if mid != "" {
			seenInBatch[mid] = true
		}

		payload, _ := msg["payload"].(map[string]any)
		payloadType, _ := payload["type"].(string)
		if payloadType == "e2ee.encrypted" {
			fromAID, _ := msg["from"].(string)
			if fromAID != "" {
				if !c.ensureSenderCertCached(ctx, fromAID) {
					result = append(result, raw)
					continue
				}
			}
			// 使用内部解密，避免消耗 seen set
			decrypted, err := c.e2ee.decryptMessage(msg)
			if err == nil && decrypted != nil {
				result = append(result, decrypted)
			} else {
				result = append(result, raw)
			}
		} else {
			result = append(result, raw)
		}
	}
	return result
}

// decryptGroupMessage 解密单条群组消息
func (c *AUNClient) decryptGroupMessage(ctx context.Context, message map[string]any) map[string]any {
	payload, ok := message["payload"].(map[string]any)
	if !ok {
		return message
	}
	payloadType, _ := payload["type"].(string)
	if payloadType != "e2ee.group_encrypted" {
		return message
	}

	// 确保发送方证书已缓存
	senderAID, _ := message["from"].(string)
	if senderAID == "" {
		senderAID, _ = message["sender_aid"].(string)
	}
	if senderAID != "" {
		if !c.ensureSenderCertCached(ctx, senderAID) {
			log.Printf("群消息解密跳过：发送方 %s 证书不可用", senderAID)
			return message
		}
	}

	// 尝试直接解密
	result, err := c.groupE2EE.Decrypt(message)
	if err == nil && result != nil {
		if _, ok := result["e2ee"]; ok {
			return result
		}
	}

	// 解密失败，尝试密钥恢复
	groupID, _ := message["group_id"].(string)
	sender, _ := message["from"].(string)
	if sender == "" {
		sender, _ = message["sender_aid"].(string)
	}
	epoch := payload["epoch"]
	if epoch != nil && groupID != "" {
		epochInt := int(toInt64(epoch))
		recovery := c.groupE2EE.BuildRecoveryRequest(groupID, epochInt, sender)
		if recovery != nil {
			to, _ := recovery["to"].(string)
			recPayload, _ := recovery["payload"].(map[string]any)
			if to != "" && recPayload != nil {
				_, err := c.Call(ctx, "message.send", map[string]any{
					"to":      to,
					"payload": recPayload,
					"encrypt": true,
					"persist": false,
				})
				if err != nil {
					log.Printf("密钥恢复请求失败: %v", err)
				}
			}
		}
	}

	return message
}

// decryptGroupMessages 批量解密群组消息（用于 group.pull）
func (c *AUNClient) decryptGroupMessages(ctx context.Context, messages []any) []any {
	var result []any
	for _, raw := range messages {
		msg, ok := raw.(map[string]any)
		if !ok {
			result = append(result, raw)
			continue
		}
		decrypted := c.decryptGroupMessage(ctx, msg)
		result = append(result, decrypted)
	}
	return result
}

// ── 内部：连接 ──────────────────────────────────────────────

// connectOnce 单次连接尝试
func (c *AUNClient) connectOnce(ctx context.Context, params map[string]any, allowReauth bool) error {
	gatewayURL := c.resolveGateway(params)

	c.mu.Lock()
	c.gatewayURL = gatewayURL
	c.state = StateConnecting
	c.mu.Unlock()

	// 连接 WebSocket
	challenge, err := c.transport.Connect(ctx, gatewayURL)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.state = StateAuthenticating
	c.mu.Unlock()

	// 认证
	if allowReauth {
		accessToken, _ := params["access_token"].(string)
		authContext, err := c.auth.ConnectSession(ctx, c.transport, challenge, gatewayURL, accessToken)
		if err != nil {
			return err
		}
		if authContext != nil {
			identity, _ := authContext["identity"].(map[string]any)
			if identity != nil {
				c.mu.Lock()
				c.identity = identity
				if aidStr, ok := identity["aid"].(string); ok {
					c.aid = aidStr
				}
				if c.sessionParams != nil {
					if token, ok := authContext["token"].(string); ok && token != "" {
						c.sessionParams["access_token"] = token
					}
				}
				c.mu.Unlock()
			}
		}
	} else {
		accessToken, _ := params["access_token"].(string)
		if err := c.auth.InitializeWithToken(ctx, c.transport, challenge, accessToken); err != nil {
			return err
		}
		c.syncIdentityAfterConnect(accessToken)
	}

	c.mu.Lock()
	c.state = StateConnected
	c.mu.Unlock()

	c.events.Publish("connection.state", map[string]any{"state": "connected", "gateway": gatewayURL})

	// 启动后台任务
	c.startBackgroundTasks(ctx)

	// 上线后自动上传 prekey
	if err := c.uploadPrekey(ctx); err != nil {
		log.Printf("prekey 上传失败: %v", err)
	}

	return nil
}

// resolveGateway 解析 Gateway URL
func (c *AUNClient) resolveGateway(params map[string]any) string {
	gateway, _ := params["gateway"].(string)
	if gateway == "" {
		c.mu.RLock()
		gateway = c.gatewayURL
		c.mu.RUnlock()
	}
	return gateway
}

// syncIdentityAfterConnect 使用 token 连接后同步本地身份
func (c *AUNClient) syncIdentityAfterConnect(accessToken string) {
	c.mu.RLock()
	aidStr := c.aid
	c.mu.RUnlock()

	identity := c.auth.LoadIdentityOrNil(aidStr)
	if identity == nil {
		c.mu.Lock()
		c.identity = nil
		c.mu.Unlock()
		return
	}
	identity["access_token"] = accessToken

	c.mu.Lock()
	c.identity = identity
	if loadedAID, ok := identity["aid"].(string); ok {
		c.aid = loadedAID
	}
	c.mu.Unlock()

	if aidVal, ok := identity["aid"].(string); ok {
		_ = c.keyStore.SaveIdentity(aidVal, identity)
	}
}

// ── 后台任务 ──────────────────────────────────────────────

// startBackgroundTasks 启动所有后台 goroutine
func (c *AUNClient) startBackgroundTasks(parentCtx context.Context) {
	c.mu.Lock()
	// 取消旧的后台任务
	if c.cancel != nil {
		c.cancel()
	}
	ctx, cancel := context.WithCancel(parentCtx)
	c.ctx = ctx
	c.cancel = cancel
	c.mu.Unlock()

	// 心跳循环
	go c.heartbeatLoop(ctx)
	// Token 刷新循环
	go c.tokenRefreshLoop(ctx)
	// Prekey 刷新循环
	go c.prekeyRefreshLoop(ctx)
	// 群组 epoch 相关任务
	c.startGroupEpochTasks(ctx)
}

// heartbeatLoop 心跳循环
func (c *AUNClient) heartbeatLoop(ctx context.Context) {
	c.mu.RLock()
	interval := 30.0
	if opts := c.sessionOptions; opts != nil {
		if v, ok := opts["heartbeat_interval"].(float64); ok && v > 0 {
			interval = v
		}
	}
	c.mu.RUnlock()

	if interval <= 0 {
		return
	}

	ticker := time.NewTicker(time.Duration(interval * float64(time.Second)))
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.mu.RLock()
			isClosing := c.closing
			state := c.state
			c.mu.RUnlock()
			if isClosing {
				return
			}
			if state != StateConnected {
				continue
			}
			_, err := c.transport.Call(ctx, "meta.ping", map[string]any{})
			if err != nil {
				c.events.Publish("connection.error", map[string]any{"error": err})
			}
		}
	}
}

// tokenRefreshLoop Token 主动刷新循环
func (c *AUNClient) tokenRefreshLoop(ctx context.Context) {
	c.mu.RLock()
	lead := 60.0
	if opts := c.sessionOptions; opts != nil {
		if v, ok := opts["token_refresh_before"].(float64); ok && v > 0 {
			lead = v
		}
	}
	c.mu.RUnlock()

	const minimumSleep = 1 * time.Second

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		c.mu.RLock()
		isClosing := c.closing
		state := c.state
		gateway := c.gatewayURL
		identity := c.identity
		c.mu.RUnlock()

		if isClosing {
			return
		}
		if state != StateConnected || gateway == "" {
			sleepWithCancel(ctx, minimumSleep)
			continue
		}

		if identity == nil {
			identity = c.auth.LoadIdentityOrNil("")
			if identity != nil {
				c.mu.Lock()
				c.identity = identity
				c.mu.Unlock()
			}
		}
		if identity == nil {
			sleepWithCancel(ctx, minimumSleep)
			continue
		}

		expiresAt := c.auth.GetAccessTokenExpiry(identity)
		if expiresAt == 0 {
			sleepWithCancel(ctx, minimumSleep)
			continue
		}

		delay := expiresAt - lead - float64(time.Now().Unix())
		if delay < 1.0 {
			delay = 1.0
		}
		sleepWithCancel(ctx, time.Duration(delay*float64(time.Second)))

		// 检查 context 是否已取消
		select {
		case <-ctx.Done():
			return
		default:
		}

		// 再次检查状态
		c.mu.RLock()
		isClosing = c.closing
		state = c.state
		gateway = c.gatewayURL
		c.mu.RUnlock()
		if isClosing || state != StateConnected || gateway == "" {
			continue
		}

		// 刷新 token
		refreshedIdentity, err := c.auth.RefreshCachedTokens(ctx, gateway, identity)
		if err != nil {
			log.Printf("token 刷新失败: %v", err)
			continue
		}

		c.mu.Lock()
		c.identity = refreshedIdentity
		if c.sessionParams != nil {
			if at, ok := refreshedIdentity["access_token"].(string); ok {
				c.sessionParams["access_token"] = at
			}
		}
		c.mu.Unlock()

		c.events.Publish("token.refreshed", map[string]any{
			"aid":        refreshedIdentity["aid"],
			"expires_at": refreshedIdentity["access_token_expires_at"],
		})
	}
}

// prekeyRefreshLoop Prekey 定时轮换循环
func (c *AUNClient) prekeyRefreshLoop(ctx context.Context) {
	interval := 3600.0
	if v, ok := c.config["prekey_refresh_interval"].(float64); ok && v > 0 {
		interval = v
	}

	ticker := time.NewTicker(time.Duration(interval * float64(time.Second)))
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.mu.RLock()
			isClosing := c.closing
			state := c.state
			c.mu.RUnlock()
			if isClosing {
				return
			}
			if state != StateConnected {
				continue
			}
			if err := c.uploadPrekey(ctx); err != nil {
				log.Printf("prekey 轮换失败: %v", err)
			}
		}
	}
}

// startGroupEpochTasks 启动群组 epoch 相关后台任务
func (c *AUNClient) startGroupEpochTasks(ctx context.Context) {
	if !c.configModel.GroupE2EE {
		return
	}

	// 旧 epoch 清理（每小时检查一次）
	go c.groupEpochCleanupLoop(ctx, 3600.0)

	// 定时 epoch 轮换
	rotateInterval := c.configModel.EpochAutoRotateInterval
	if rotateInterval > 0 {
		go c.groupEpochRotateLoop(ctx, float64(rotateInterval))
	}
}

// groupEpochRotateLoop 定时轮换所有已知群组的 epoch
func (c *AUNClient) groupEpochRotateLoop(ctx context.Context, interval float64) {
	ticker := time.NewTicker(time.Duration(interval * float64(time.Second)))
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.mu.RLock()
			isClosing := c.closing
			state := c.state
			myAID := c.aid
			c.mu.RUnlock()
			if isClosing {
				return
			}
			if state != StateConnected || myAID == "" {
				continue
			}

			metadata, _ := c.keyStore.LoadMetadata(myAID)
			if metadata == nil {
				continue
			}
			groupSecrets, _ := metadata["group_secrets"].(map[string]any)
			for gid := range groupSecrets {
				c.rotateGroupEpoch(ctx, gid)
			}
		}
	}
}

// groupEpochCleanupLoop 定时清理过期的旧 epoch 密钥
func (c *AUNClient) groupEpochCleanupLoop(ctx context.Context, interval float64) {
	ticker := time.NewTicker(time.Duration(interval * float64(time.Second)))
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.mu.RLock()
			isClosing := c.closing
			state := c.state
			myAID := c.aid
			c.mu.RUnlock()
			if isClosing {
				return
			}
			if state != StateConnected || myAID == "" {
				continue
			}

			metadata, _ := c.keyStore.LoadMetadata(myAID)
			if metadata == nil {
				continue
			}
			groupSecrets, _ := metadata["group_secrets"].(map[string]any)
			retention := c.configModel.OldEpochRetentionSeconds
			for gid := range groupSecrets {
				c.groupE2EE.Cleanup(gid, retention)
			}
		}
	}
}

// ── Group E2EE 编排 ─────────────────────────────────────────

// buildRotationSignature 构建 epoch 轮换签名参数
func (c *AUNClient) buildRotationSignature(groupID string, currentEpoch, newEpoch int) map[string]any {
	c.mu.RLock()
	identity := c.identity
	c.mu.RUnlock()
	if identity == nil {
		return nil
	}
	privPEM, _ := identity["private_key_pem"].(string)
	if privPEM == "" {
		return nil
	}

	aidStr, _ := identity["aid"].(string)
	ts := fmt.Sprintf("%d", time.Now().Unix())
	signData := []byte(fmt.Sprintf("%s|%d|%d|%s|%s", groupID, currentEpoch, newEpoch, aidStr, ts))

	pk, err := parseECPrivateKeyPEM(privPEM)
	if err != nil {
		return nil
	}
	hash := sha256.Sum256(signData)
	sig, err := ecdsa.SignASN1(cryptorand.Reader, pk, hash[:])
	if err != nil {
		return nil
	}

	return map[string]any{
		"rotation_signature": base64.StdEncoding.EncodeToString(sig),
		"rotation_timestamp": ts,
	}
}

// syncEpochToServer 建群后将本地 epoch 1 同步到服务端
func (c *AUNClient) syncEpochToServer(ctx context.Context, groupID string) {
	rotateParams := map[string]any{
		"group_id":      groupID,
		"current_epoch": 0,
	}
	sigParams := c.buildRotationSignature(groupID, 0, 1)
	for k, v := range sigParams {
		rotateParams[k] = v
	}
	_, err := c.Call(ctx, "group.e2ee.rotate_epoch", rotateParams)
	if err != nil {
		log.Printf("同步 epoch 到服务端失败 (group=%s，可能已同步): %v", groupID, err)
	}
}

// rotateGroupEpoch 为指定群组轮换 epoch 并分发新密钥（使用服务端 CAS 保证只有一方成功）
func (c *AUNClient) rotateGroupEpoch(ctx context.Context, groupID string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("rotateGroupEpoch panic: %v", r)
		}
	}()

	// 1. 读取服务端当前 epoch
	epochResult, err := c.Call(ctx, "group.e2ee.get_epoch", map[string]any{"group_id": groupID})
	if err != nil {
		c.logE2EEError("rotate_epoch", groupID, "", err)
		return
	}
	epochMap, ok := epochResult.(map[string]any)
	if !ok {
		return
	}
	currentEpoch := int(toInt64(epochMap["epoch"]))

	// 2. CAS 尝试递增（服务端校验角色 + 原子递增）
	rotateParams := map[string]any{
		"group_id":      groupID,
		"current_epoch": currentEpoch,
	}
	sigParams := c.buildRotationSignature(groupID, currentEpoch, currentEpoch+1)
	for k, v := range sigParams {
		rotateParams[k] = v
	}
	casResult, err := c.Call(ctx, "group.e2ee.rotate_epoch", rotateParams)
	if err != nil {
		c.logE2EEError("rotate_epoch", groupID, "", err)
		return
	}
	casMap, ok := casResult.(map[string]any)
	if !ok {
		return
	}
	success, _ := casMap["success"].(bool)
	if !success {
		return // CAS 失败（别人先轮换了或角色不符），放弃
	}
	newEpoch := int(toInt64(casMap["epoch"]))

	// 3. 获取最新成员列表
	membersResult, err := c.Call(ctx, "group.get_members", map[string]any{"group_id": groupID})
	if err != nil {
		c.logE2EEError("rotate_epoch", groupID, "", err)
		return
	}
	membersMap, ok := membersResult.(map[string]any)
	if !ok {
		return
	}
	membersList, _ := membersMap["members"].([]any)
	memberAIDs := extractAIDsFromMembers(membersList)

	// 4. 本地生成密钥 + 存储 + 分发
	info, err := c.groupE2EE.RotateEpochTo(groupID, newEpoch, memberAIDs)
	if err != nil {
		c.logE2EEError("rotate_epoch", groupID, "", err)
		return
	}
	distributions, _ := info["distributions"].([]map[string]any)
	for _, dist := range distributions {
		to, _ := dist["to"].(string)
		distPayload, _ := dist["payload"].(map[string]any)
		if to != "" && distPayload != nil {
			_, err := c.Call(ctx, "message.send", map[string]any{
				"to":      to,
				"payload": distPayload,
				"encrypt": true,
				"persist": false,
			})
			if err != nil {
				log.Printf("分发 epoch 密钥失败 (%s → %s): %v", groupID, to, err)
			}
		}
	}
}

// distributeKeyToNewMember 将当前 group_secret 通过 P2P E2EE 分发给新成员
func (c *AUNClient) distributeKeyToNewMember(ctx context.Context, groupID, newMemberAID string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("distributeKeyToNewMember panic: %v", r)
		}
	}()

	secretData := c.groupE2EE.LoadSecret(groupID)
	if secretData == nil {
		return
	}

	// 拉服务端最新成员列表
	membersResult, err := c.Call(ctx, "group.get_members", map[string]any{"group_id": groupID})
	if err != nil {
		c.logE2EEError("distribute_key", groupID, newMemberAID, err)
		return
	}
	membersMap, ok := membersResult.(map[string]any)
	if !ok {
		return
	}
	membersList, _ := membersMap["members"].([]any)
	memberAIDs := extractAIDsFromMembers(membersList)

	// 更新本地 member_aids/commitment
	c.mu.RLock()
	myAID := c.aid
	c.mu.RUnlock()

	epoch := int(toInt64(secretData["epoch"]))
	secret, _ := secretData["secret"].([]byte)
	commitment := ComputeMembershipCommitment(memberAIDs, epoch, groupID, secret)
	StoreGroupSecret(c.keyStore, myAID, groupID, epoch, secret, commitment, memberAIDs)

	// 构建并签名 manifest
	prevEpoch := epoch
	manifest := BuildMembershipManifest(
		groupID, epoch, &prevEpoch,
		memberAIDs, []string{newMemberAID}, nil, myAID,
	)

	c.mu.RLock()
	identity := c.identity
	c.mu.RUnlock()
	if identity != nil {
		if privPEM, ok := identity["private_key_pem"].(string); ok && privPEM != "" {
			signed, err := SignMembershipManifest(manifest, privPEM)
			if err == nil {
				manifest = signed
			}
		}
	}

	distPayload := BuildKeyDistribution(groupID, epoch, secret, memberAIDs, myAID, manifest)
	_, err = c.Call(ctx, "message.send", map[string]any{
		"to":      newMemberAID,
		"payload": distPayload,
		"encrypt": true,
		"persist": false,
	})
	if err != nil {
		c.logE2EEError("distribute_key", groupID, newMemberAID, err)
	}
}

// logE2EEError 记录 E2EE 自动编排错误
func (c *AUNClient) logE2EEError(stage, groupID, aid string, err error) {
	log.Printf("[e2ee] 编排错误: stage=%s group=%s aid=%s error=%v", stage, groupID, aid, err)
	c.events.Publish("e2ee.orchestration_error", map[string]any{
		"stage":    stage,
		"group_id": groupID,
		"aid":      aid,
		"error":    err.Error(),
	})
}

// ── 断线重连 ──────────────────────────────────────────────

// handleTransportDisconnect 传输层断线回调
func (c *AUNClient) handleTransportDisconnect(err error) {
	c.mu.RLock()
	isClosing := c.closing
	state := c.state
	c.mu.RUnlock()

	if isClosing || state == StateClosed {
		return
	}

	c.mu.Lock()
	c.state = StateDisconnected
	c.mu.Unlock()

	c.events.Publish("connection.state", map[string]any{
		"state": "disconnected",
		"error": err,
	})

	c.mu.RLock()
	autoReconnect := false
	if opts := c.sessionOptions; opts != nil {
		if v, ok := opts["auto_reconnect"].(bool); ok {
			autoReconnect = v
		}
	}
	c.mu.RUnlock()

	if !autoReconnect {
		return
	}

	go c.reconnectLoop()
}

// reconnectLoop 重连循环（无限重试 + 指数退避，仅在不可重试错误或 close() 时终止）
func (c *AUNClient) reconnectLoop() {
	c.mu.RLock()
	opts := c.sessionOptions
	c.mu.RUnlock()

	retryConfig, _ := opts["retry"].(map[string]any)
	initialDelay := 0.5
	maxDelay := 30.0
	if retryConfig != nil {
		if v, ok := retryConfig["initial_delay"].(float64); ok {
			initialDelay = v
		}
		if v, ok := retryConfig["max_delay"].(float64); ok {
			maxDelay = v
		}
	}

	delay := initialDelay
	for attempt := 1; !c.closing; attempt++ {
		c.mu.Lock()
		c.state = StateReconnecting
		c.mu.Unlock()

		c.events.Publish("connection.state", map[string]any{
			"state":   "reconnecting",
			"attempt": attempt,
		})

		time.Sleep(time.Duration(delay * float64(time.Second)))

		// close() 可能在 sleep 期间被调用
		if c.closing {
			return
		}

		// 关闭旧连接
		_ = c.transport.Close()

		// 重新连接
		c.mu.RLock()
		params := c.sessionParams
		c.mu.RUnlock()
		if params == nil {
			c.mu.Lock()
			c.state = StateTerminalFailed
			c.mu.Unlock()
			c.events.Publish("connection.state", map[string]any{"state": "terminal_failed"})
			return
		}

		err := c.connectOnce(context.Background(), params, true)
		if err == nil {
			return
		}

		c.events.Publish("connection.error", map[string]any{
			"error":   err,
			"attempt": attempt,
		})

		if !shouldRetryReconnect(err) {
			c.mu.Lock()
			c.state = StateTerminalFailed
			c.mu.Unlock()
			c.events.Publish("connection.state", map[string]any{
				"state":   "terminal_failed",
				"error":   err,
				"attempt": attempt,
			})
			return
		}

		delay = delay * 2
		if delay > maxDelay {
			delay = maxDelay
		}
	}
}

// shouldRetryReconnect 判断错误是否应该重试
func shouldRetryReconnect(err error) bool {
	switch e := err.(type) {
	case *AuthError:
		return false
	case *PermissionError:
		return false
	case *ValidationError:
		return false
	case *StateError:
		return false
	case *ConnectionError:
		return true
	case *TimeoutError:
		return true
	case *AUNError:
		return e.Retryable
	default:
		return true
	}
}

// ── 参数处理 ──────────────────────────────────────────────

// normalizeConnectParams 规范化连接参数
func (c *AUNClient) normalizeConnectParams(params map[string]any) (map[string]any, error) {
	request := copyMapShallow(params)

	accessToken, _ := request["access_token"].(string)
	if accessToken == "" {
		return nil, NewStateError("connect 需要非空 access_token")
	}

	gateway, _ := request["gateway"].(string)
	if gateway == "" {
		c.mu.RLock()
		gateway = c.gatewayURL
		c.mu.RUnlock()
	}
	if gateway == "" {
		return nil, NewStateError("connect 需要非空 gateway")
	}

	request["access_token"] = accessToken
	request["gateway"] = gateway

	if topology, exists := request["topology"]; exists {
		if topology != nil {
			if _, ok := topology.(map[string]any); !ok {
				return nil, NewValidationError("topology 必须是 map")
			}
		}
	}
	if retry, exists := request["retry"]; exists {
		if _, ok := retry.(map[string]any); !ok {
			return nil, NewValidationError("retry 必须是 map")
		}
	}
	if timeouts, exists := request["timeouts"]; exists {
		if _, ok := timeouts.(map[string]any); !ok {
			return nil, NewValidationError("timeouts 必须是 map")
		}
	}

	return request, nil
}

// buildSessionOptions 构建会话选项
func (c *AUNClient) buildSessionOptions(params map[string]any) map[string]any {
	options := map[string]any{
		"auto_reconnect":       false,
		"heartbeat_interval":   30.0,
		"token_refresh_before": 60.0,
		"retry": map[string]any{
			"initial_delay": 0.5,
			"max_delay":     30.0,
		},
		"timeouts": map[string]any{
			"connect": 5.0,
			"call":    10.0,
			"http":    30.0,
		},
	}

	if v, ok := params["auto_reconnect"].(bool); ok {
		options["auto_reconnect"] = v
	}
	if v, ok := params["heartbeat_interval"].(float64); ok {
		options["heartbeat_interval"] = v
	}
	if v, ok := params["token_refresh_before"].(float64); ok {
		options["token_refresh_before"] = v
	}
	if retryParams, ok := params["retry"].(map[string]any); ok {
		retryOpts, _ := options["retry"].(map[string]any)
		for k, v := range retryParams {
			retryOpts[k] = v
		}
	}
	if timeoutParams, ok := params["timeouts"].(map[string]any); ok {
		timeoutOpts, _ := options["timeouts"].(map[string]any)
		for k, v := range timeoutParams {
			timeoutOpts[k] = v
		}
	}

	return options
}

// ── 静态辅助函数 ──────────────────────────────────────────

// buildCertURL 构建证书下载 URL
func buildCertURL(gatewayURL, aid string) string {
	parsed, err := url.Parse(gatewayURL)
	if err != nil {
		return gatewayURL
	}
	scheme := "https"
	if parsed.Scheme == "ws" {
		scheme = "http"
	}
	return fmt.Sprintf("%s://%s/pki/cert/%s", scheme, parsed.Host, url.PathEscape(aid))
}

// resolvePeerGatewayURL 跨域时将 Gateway URL 替换为 peer 所在域的 Gateway URL
func resolvePeerGatewayURL(localGatewayURL, peerAID string) string {
	if !strings.Contains(peerAID, ".") {
		return localGatewayURL
	}
	parts := strings.SplitN(peerAID, ".", 2)
	peerIssuer := parts[1]

	re := regexp.MustCompile(`gateway\.([^:/]+)`)
	m := re.FindStringSubmatch(localGatewayURL)
	if len(m) < 2 {
		return localGatewayURL
	}
	localIssuer := m[1]
	if localIssuer == peerIssuer {
		return localGatewayURL
	}
	return strings.Replace(localGatewayURL, "gateway."+localIssuer, "gateway."+peerIssuer, 1)
}

// sleepWithCancel 可取消的 sleep
func sleepWithCancel(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

// stringSliceContains 检查字符串切片是否包含指定元素
func stringSliceContains(slice []string, s string) bool {
	for _, item := range slice {
		if item == s {
			return true
		}
	}
	return false
}

// extractAIDsFromMembers 从成员列表中提取 AID 列表
func extractAIDsFromMembers(membersList []any) []string {
	var aids []string
	for _, item := range membersList {
		if m, ok := item.(map[string]any); ok {
			if aid, ok := m["aid"].(string); ok {
				aids = append(aids, aid)
			}
		}
	}
	return aids
}
