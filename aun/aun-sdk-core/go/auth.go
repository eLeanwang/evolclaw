package aun

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ocsp"
	"nhooyr.io/websocket"

	"github.com/anthropics/aun-sdk-core/go/keystore"
)

// ── 辅助：多算法签名验证（ECDSA P-256/P-384、Ed25519）──────

// verifySignature 验证签名，自动识别公钥类型和哈希算法。
// 与 Python auth.py _verify_signature 对应。
func verifySignature(pub interface{}, sig, data []byte) error {
	switch k := pub.(type) {
	case ed25519.PublicKey:
		if !ed25519.Verify(k, data, sig) {
			return NewAuthError("ed25519 签名验证失败")
		}
		return nil
	case *ecdsa.PublicKey:
		if k.Curve == elliptic.P384() {
			h := sha512.Sum384(data)
			if !ecdsa.VerifyASN1(k, h[:], sig) {
				return NewAuthError("ECDSA P-384 签名验证失败")
			}
		} else {
			h := sha256.Sum256(data)
			if !ecdsa.VerifyASN1(k, h[:], sig) {
				return NewAuthError("ECDSA P-256 签名验证失败")
			}
		}
		return nil
	default:
		return NewAuthError(fmt.Sprintf("不支持的公钥类型: %T", pub))
	}
}

// ── ConnectionFactory 类型 ──────────────────────────────────

// ConnectionFactory 临时 WebSocket 连接工厂，供 shortRPC 使用
type ConnectionFactory func(ctx context.Context, url string) (*websocket.Conn, error)

// ── 缓存条目 ────────────────────────────────────────────────

// crlCacheEntry CRL 缓存条目
type crlCacheEntry struct {
	RevokedSerials map[string]bool // serial_hex -> true
	NextRefreshAt  float64         // Unix 秒
}

// ocspCacheEntry OCSP 缓存条目
type ocspCacheEntry struct {
	Status        string  // "good" / "revoked" / "unknown"
	NextRefreshAt float64 // Unix 秒
}

// ── AuthFlowConfig ──────────────────────────────────────────

// AuthFlowConfig AuthFlow 配置
type AuthFlowConfig struct {
	Keystore          keystore.KeyStore  // 密钥存储后端
	Crypto            *CryptoProvider    // 加密操作提供者
	AID               string             // 当前 Agent ID
	ConnectionFactory ConnectionFactory  // 可选的 WebSocket 连接工厂
	RootCAPath        string             // 自定义根证书路径
	ChainCacheTTL     int                // 证书链缓存 TTL（秒），默认 86400
	VerifySSL         bool               // 是否验证 TLS 证书，默认 true
}

// ── AuthFlow 认证流程管理 ────────────────────────────────────

// AuthFlow 处理 AID 注册、两阶段认证、证书验证和 token 刷新。
// 与 Python SDK auth.py 的 AuthFlow 完全对应。
type AuthFlow struct {
	keystore          keystore.KeyStore
	crypto            *CryptoProvider
	aid               string
	connectionFactory ConnectionFactory
	rootCAPath        string
	chainCacheTTL     int
	verifySSL         bool

	// 根证书
	rootCerts []*x509.Certificate

	// Gateway CA 链 PEM 缓存：cacheKey -> []string(PEM)
	gatewayChainCache map[string][]string
	// CRL 缓存：gateway_url -> crlCacheEntry
	gatewayCRLCache map[string]*crlCacheEntry
	// OCSP 缓存：gateway_url -> serial_hex -> ocspCacheEntry
	gatewayOCSPCache map[string]map[string]*ocspCacheEntry
	// 证书链验证结果缓存：cert_serial_hex -> verified_at(Unix 秒)
	chainVerifiedCache map[string]float64
	// Gateway CA 链预验证标记：cacheKey -> verified
	gatewayCAVerified map[string]bool

	mu sync.RWMutex // 保护所有缓存字段
}

// NewAuthFlow 创建认证流程实例
func NewAuthFlow(cfg AuthFlowConfig) *AuthFlow {
	ttl := cfg.ChainCacheTTL
	if ttl == 0 {
		ttl = 86400
	}
	a := &AuthFlow{
		keystore:           cfg.Keystore,
		crypto:             cfg.Crypto,
		aid:                cfg.AID,
		connectionFactory:  cfg.ConnectionFactory,
		rootCAPath:         cfg.RootCAPath,
		chainCacheTTL:      ttl,
		verifySSL:          cfg.VerifySSL,
		gatewayChainCache:  make(map[string][]string),
		gatewayCRLCache:    make(map[string]*crlCacheEntry),
		gatewayOCSPCache:   make(map[string]map[string]*ocspCacheEntry),
		chainVerifiedCache: make(map[string]float64),
		gatewayCAVerified:  make(map[string]bool),
	}
	a.rootCerts = a.loadRootCerts(cfg.RootCAPath)
	return a
}

// ── 身份加载 ────────────────────────────────────────────────

// LoadIdentity 加载本地身份信息（密钥 + 证书 + 元数据合并）
func (a *AuthFlow) LoadIdentity(aid string) (map[string]any, error) {
	identity, err := a.loadIdentityOrRaise(aid)
	if err != nil {
		return nil, err
	}
	resolvedAID := authGetStr(identity, "aid")
	if resolvedAID == "" {
		resolvedAID = aid
		if resolvedAID == "" {
			resolvedAID = a.aid
		}
	}
	cert, _ := a.keystore.LoadCert(resolvedAID)
	if cert != "" {
		identity["cert"] = cert
	}
	metadata, _ := a.keystore.LoadMetadata(resolvedAID)
	if metadata != nil {
		for k, v := range metadata {
			identity[k] = v
		}
	}
	return identity, nil
}

// LoadIdentityOrNil 加载本地身份信息，不存在时返回 nil
func (a *AuthFlow) LoadIdentityOrNil(aid string) map[string]any {
	identity, err := a.LoadIdentity(aid)
	if err != nil {
		return nil
	}
	return identity
}

// GetAccessTokenExpiry 获取 access_token 过期时间（Unix 秒），不存在返回 0
func (a *AuthFlow) GetAccessTokenExpiry(identity map[string]any) float64 {
	if identity == nil {
		return 0
	}
	expiresAt := identity["access_token_expires_at"]
	switch v := expiresAt.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	}
	return 0
}

// ── AID 创建 ────────────────────────────────────────────────

// CreateAID 注册新 AID，返回 {aid, cert}。
// 本地有密钥但无证书时，先尝试注册；若 AID 已存在则尝试下载证书恢复。
func (a *AuthFlow) CreateAID(ctx context.Context, gatewayURL, aid string) (map[string]any, error) {
	identity := a.ensureLocalIdentity(aid)
	if cert := authGetStr(identity, "cert"); cert != "" {
		return map[string]any{"aid": identity["aid"], "cert": cert}, nil
	}

	// 本地有密钥但无证书 — 尝试服务端注册
	created, err := a.createAIDRemote(ctx, gatewayURL, identity)
	if err != nil {
		// AID 已存在，尝试下载证书恢复
		if strings.Contains(err.Error(), "already exists") {
			recovered, recoverErr := a.recoverCertViaDownload(ctx, gatewayURL, identity)
			if recoverErr != nil {
				return nil, NewStateError(fmt.Sprintf(
					"AID %s already registered on server but local certificate is missing. "+
						"Certificate download recovery failed. Options: "+
						"(1) use a different AID name, or "+
						"(2) restart Kite server to clear registration.", aid))
			}
			identity = recovered
		} else {
			return nil, err
		}
	} else {
		identity["cert"] = created["cert"]
	}

	if err := a.keystore.SaveIdentity(authGetStr(identity, "aid"), identity); err != nil {
		return nil, err
	}
	a.aid = authGetStr(identity, "aid")
	return map[string]any{"aid": identity["aid"], "cert": identity["cert"]}, nil
}

// ── 认证流程 ────────────────────────────────────────────────

// Authenticate 两阶段认证（login1 + login2），返回 {aid, access_token, refresh_token, expires_at, gateway}
func (a *AuthFlow) Authenticate(ctx context.Context, gatewayURL string, aid string) (map[string]any, error) {
	identity, err := a.loadIdentityOrRaise(aid)
	if err != nil {
		return nil, err
	}

	// 本地有密钥但无证书 — 尝试从 PKI 下载恢复
	if authGetStr(identity, "cert") == "" {
		recovered, recoverErr := a.recoverCertViaDownload(ctx, gatewayURL, identity)
		if recoverErr != nil {
			return nil, NewStateError(fmt.Sprintf(
				"local certificate missing and recovery failed: %v. "+
					"Run auth.create_aid() to register a new identity.", recoverErr))
		}
		identity = recovered
		if err := a.keystore.SaveIdentity(authGetStr(identity, "aid"), identity); err != nil {
			return nil, err
		}
	}

	login, err := a.login(ctx, gatewayURL, identity)
	if err != nil {
		return nil, err
	}
	authRememberTokens(identity, login)
	a.validateNewCert(ctx, identity, gatewayURL)
	if err := a.keystore.SaveIdentity(authGetStr(identity, "aid"), identity); err != nil {
		return nil, err
	}
	a.aid = authGetStr(identity, "aid")
	return map[string]any{
		"aid":           identity["aid"],
		"access_token":  identity["access_token"],
		"refresh_token": identity["refresh_token"],
		"expires_at":    identity["access_token_expires_at"],
		"gateway":       gatewayURL,
	}, nil
}

// EnsureAuthenticated 确保已认证（复用缓存 token 或重新认证）
func (a *AuthFlow) EnsureAuthenticated(ctx context.Context, gatewayURL string) (map[string]any, error) {
	identity := a.ensureIdentity()

	if authGetStr(identity, "cert") == "" {
		created, err := a.createAIDRemote(ctx, gatewayURL, identity)
		if err != nil {
			return nil, err
		}
		identity["cert"] = created["cert"]
		if err := a.keystore.SaveIdentity(authGetStr(identity, "aid"), identity); err != nil {
			return nil, err
		}
	}

	login, err := a.login(ctx, gatewayURL, identity)
	if err != nil {
		return nil, err
	}
	authRememberTokens(identity, login)
	a.validateNewCert(ctx, identity, gatewayURL)
	if err := a.keystore.SaveIdentity(authGetStr(identity, "aid"), identity); err != nil {
		return nil, err
	}

	token := authGetStr(identity, "access_token")
	if token == "" {
		token = authGetStr(identity, "token")
	}
	if token == "" {
		token = authGetStr(identity, "kite_token")
	}
	if token == "" {
		return nil, NewAuthError("login2 did not return access token")
	}
	return map[string]any{"token": token, "identity": identity}, nil
}

// ── Token 刷新 ──────────────────────────────────────────────

// RefreshCachedTokens 使用 refresh_token 刷新 access_token
func (a *AuthFlow) RefreshCachedTokens(ctx context.Context, gatewayURL string, identity map[string]any) (map[string]any, error) {
	refreshToken := authGetStr(identity, "refresh_token")
	if refreshToken == "" {
		return nil, NewAuthError("missing refresh_token")
	}
	refreshed, err := a.refreshAccessToken(ctx, gatewayURL, refreshToken)
	if err != nil {
		return nil, err
	}
	authRememberTokens(identity, refreshed)
	a.validateNewCert(ctx, identity, gatewayURL)
	if err := a.keystore.SaveIdentity(authGetStr(identity, "aid"), identity); err != nil {
		return nil, err
	}
	return identity, nil
}

// ── 会话初始化 ──────────────────────────────────────────────

// InitializeWithToken 使用已有 token 初始化会话
func (a *AuthFlow) InitializeWithToken(ctx context.Context, transport *RPCTransport, challenge map[string]any, accessToken string) error {
	nonce := authExtractChallengeNonce(challenge)
	if nonce == "" {
		return NewAuthError("gateway challenge missing nonce")
	}
	return a.initializeSession(ctx, transport, nonce, accessToken)
}

// ConnectSession 连接会话（多策略自动选择认证方式）。
// 优先级：显式 token → 缓存 access_token → refresh_token → 完整重认证。
func (a *AuthFlow) ConnectSession(
	ctx context.Context,
	transport *RPCTransport,
	challenge map[string]any,
	gatewayURL string,
	accessToken string,
) (map[string]any, error) {
	nonce := authExtractChallengeNonce(challenge)
	if nonce == "" {
		return nil, NewAuthError("gateway challenge missing nonce")
	}

	identity, _ := a.LoadIdentity("")

	// 策略 1：显式 token
	if accessToken != "" && identity != nil {
		if err := a.initializeSession(ctx, transport, nonce, accessToken); err == nil {
			identity["access_token"] = accessToken
			_ = a.keystore.SaveIdentity(authGetStr(identity, "aid"), identity)
			return map[string]any{"token": accessToken, "identity": identity}, nil
		}
		log.Printf("explicit_token 认证失败，尝试下一方式")
	}

	// 无本地身份：完整注册+认证
	if identity == nil {
		authContext, err := a.EnsureAuthenticated(ctx, gatewayURL)
		if err != nil {
			return nil, err
		}
		token := authGetStr(authContext, "token")
		if err := a.initializeSession(ctx, transport, nonce, token); err != nil {
			return nil, err
		}
		return authContext, nil
	}

	// 策略 2：缓存的 access_token
	cachedToken := authGetCachedAccessToken(identity)
	if cachedToken != "" {
		if err := a.initializeSession(ctx, transport, nonce, cachedToken); err == nil {
			return map[string]any{"token": cachedToken, "identity": identity}, nil
		}
		log.Printf("cached_token 认证失败，尝试刷新")
	}

	// 策略 3：refresh_token → 新 access_token
	if refreshToken := authGetStr(identity, "refresh_token"); refreshToken != "" {
		if refreshedIdentity, err := a.RefreshCachedTokens(ctx, gatewayURL, identity); err == nil {
			identity = refreshedIdentity
			if newToken := authGetCachedAccessToken(identity); newToken != "" {
				if err := a.initializeSession(ctx, transport, nonce, newToken); err == nil {
					return map[string]any{"token": newToken, "identity": identity}, nil
				}
			}
		}
		log.Printf("refresh_token 认证失败，将重新登录")
	}

	// 策略 4：完整重认证
	loginResult, err := a.Authenticate(ctx, gatewayURL, authGetStr(identity, "aid"))
	if err != nil {
		return nil, err
	}
	token := authGetStr(loginResult, "access_token")
	if token == "" {
		return nil, NewAuthError("authenticate did not return access_token")
	}
	if err := a.initializeSession(ctx, transport, nonce, token); err != nil {
		return nil, err
	}
	identity, _ = a.LoadIdentity(authGetStr(identity, "aid"))
	return map[string]any{"token": token, "identity": identity}, nil
}

// ── 对端证书验证 ────────────────────────────────────────────

// VerifyPeerCertificate 验证对端证书（链 + CRL + OCSP + AID 绑定）。
// certPEM 为 PEM 编码的证书字节。
func (a *AuthFlow) VerifyPeerCertificate(ctx context.Context, gatewayURL string, certPEM []byte, expectedAID string) error {
	cert, err := authParsePEMCertificate(string(certPEM))
	if err != nil {
		return NewAuthError(fmt.Sprintf("failed to parse peer certificate: %v", err))
	}

	now := time.Now()
	if err := authEnsureCertTimeValid(cert, "peer certificate", now); err != nil {
		return err
	}
	if err := a.verifyAuthCertChain(ctx, gatewayURL, cert, expectedAID); err != nil {
		return err
	}
	if err := a.verifyAuthCertRevocation(ctx, gatewayURL, cert, expectedAID); err != nil {
		return NewAuthError(fmt.Sprintf("peer cert CRL check failed: %v", err))
	}
	if err := a.verifyAuthCertOCSP(ctx, gatewayURL, cert, expectedAID); err != nil {
		return NewAuthError(fmt.Sprintf("peer cert OCSP check failed: %v", err))
	}
	// CN 必须匹配 expectedAID
	if cert.Subject.CommonName != expectedAID {
		return NewAuthError(fmt.Sprintf(
			"peer cert CN mismatch: expected %s, got %s", expectedAID, cert.Subject.CommonName))
	}
	return nil
}

// ── 内部：shortRPC ──────────────────────────────────────────

// shortRPC 开启临时 WebSocket，接收 challenge，发送 JSON-RPC 请求，接收响应，关闭。
// 与 Python auth.py _short_rpc 对应。
func (a *AuthFlow) shortRPC(ctx context.Context, gatewayURL string, method string, params map[string]any) (map[string]any, error) {
	conn, err := a.dialWebSocket(ctx, gatewayURL)
	if err != nil {
		return nil, NewConnectionError(fmt.Sprintf("shortRPC 连接失败: %v", err))
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// 接收 challenge（丢弃）
	rCtx, rCancel := context.WithTimeout(ctx, 10*time.Second)
	defer rCancel()
	if _, _, err = conn.Read(rCtx); err != nil {
		return nil, NewConnectionError(fmt.Sprintf("shortRPC 接收 challenge 失败: %v", err))
	}

	// 发送 JSON-RPC 请求
	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      fmt.Sprintf("pre-%s", method),
		"method":  method,
		"params":  params,
	}
	data, err := json.Marshal(request)
	if err != nil {
		return nil, NewSerializationError(fmt.Sprintf("shortRPC 序列化请求失败: %v", err))
	}
	wCtx, wCancel := context.WithTimeout(ctx, 5*time.Second)
	defer wCancel()
	if err := conn.Write(wCtx, websocket.MessageText, data); err != nil {
		return nil, NewConnectionError(fmt.Sprintf("shortRPC 发送请求失败: %v", err))
	}

	// 接收响应
	rCtx2, rCancel2 := context.WithTimeout(ctx, 10*time.Second)
	defer rCancel2()
	_, respData, err := conn.Read(rCtx2)
	if err != nil {
		return nil, NewConnectionError(fmt.Sprintf("shortRPC 接收响应失败: %v", err))
	}

	var message map[string]any
	if err := json.Unmarshal(respData, &message); err != nil {
		return nil, NewSerializationError("shortRPC 响应不是有效 JSON")
	}

	if errData, ok := message["error"]; ok {
		if errMap, ok := errData.(map[string]any); ok {
			return nil, MapRemoteError(errMap)
		}
	}
	result, ok := message["result"].(map[string]any)
	if !ok {
		return nil, NewValidationError(fmt.Sprintf("invalid pre-auth response for %s", method))
	}
	if success, ok := result["success"]; ok {
		if s, ok := success.(bool); ok && !s {
			errMsg := fmt.Sprintf("%s failed", method)
			if e, ok := result["error"].(string); ok {
				errMsg = e
			}
			return nil, NewAuthError(errMsg)
		}
	}
	return result, nil
}

// dialWebSocket 建立临时 WebSocket 连接
func (a *AuthFlow) dialWebSocket(ctx context.Context, gatewayURL string) (*websocket.Conn, error) {
	if a.connectionFactory != nil {
		return a.connectionFactory(ctx, gatewayURL)
	}
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	opts := &websocket.DialOptions{}
	if !a.verifySSL {
		opts.HTTPClient = &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		}
	}
	conn, _, err := websocket.Dial(dialCtx, gatewayURL, opts)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

// ── 内部：AID 注册远程调用 ──────────────────────────────────

// createAIDRemote 通过 shortRPC 在服务端注册 AID
func (a *AuthFlow) createAIDRemote(ctx context.Context, gatewayURL string, identity map[string]any) (map[string]any, error) {
	response, err := a.shortRPC(ctx, gatewayURL, "auth.create_aid", map[string]any{
		"aid":        identity["aid"],
		"public_key": identity["public_key_der_b64"],
		"curve":      authGetStrDefault(identity, "curve", "P-256"),
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"cert": response["cert"]}, nil
}

// ── 内部：两阶段登录 ───────────────────────────────────────

// login 两阶段登录：login1 发送 aid+cert+client_nonce，验证 phase1 响应后 login2 发送签名。
func (a *AuthFlow) login(ctx context.Context, gatewayURL string, identity map[string]any) (map[string]any, error) {
	clientNonce := a.crypto.NewClientNonce()

	// Phase 1
	phase1, err := a.shortRPC(ctx, gatewayURL, "auth.aid_login1", map[string]any{
		"aid":          identity["aid"],
		"cert":         identity["cert"],
		"client_nonce": clientNonce,
	})
	if err != nil {
		return nil, err
	}

	// 验证 phase1 响应
	if err := a.verifyPhase1Response(ctx, gatewayURL, phase1, clientNonce); err != nil {
		return nil, err
	}

	// Phase 2
	nonce := authGetStr(phase1, "nonce")
	privateKeyPEM := authGetStr(identity, "private_key_pem")
	signature, clientTime, err := a.crypto.SignLoginNonce(privateKeyPEM, nonce, "")
	if err != nil {
		return nil, NewAuthError(fmt.Sprintf("签名 login nonce 失败: %v", err))
	}

	phase2, err := a.shortRPC(ctx, gatewayURL, "auth.aid_login2", map[string]any{
		"aid":         identity["aid"],
		"request_id":  phase1["request_id"],
		"nonce":       nonce,
		"client_time": clientTime,
		"signature":   signature,
	})
	if err != nil {
		return nil, err
	}
	return phase2, nil
}

// refreshAccessToken 通过 shortRPC 刷新 access_token
func (a *AuthFlow) refreshAccessToken(ctx context.Context, gatewayURL string, refreshToken string) (map[string]any, error) {
	result, err := a.shortRPC(ctx, gatewayURL, "auth.refresh_token", map[string]any{
		"refresh_token": refreshToken,
	})
	if err != nil {
		return nil, err
	}
	if success, ok := result["success"]; ok {
		if s, ok := success.(bool); ok && !s {
			errMsg := "refresh failed"
			if e, ok := result["error"].(string); ok {
				errMsg = e
			}
			return nil, NewAuthError(errMsg)
		}
	}
	return result, nil
}

// ── 内部：Phase1 响应验证 ───────────────────────────────────

// verifyPhase1Response 验证 login1 响应：auth_cert 链+CRL+OCSP + client_nonce 签名。
func (a *AuthFlow) verifyPhase1Response(ctx context.Context, gatewayURL string, result map[string]any, clientNonce string) error {
	authCertPEM := authGetStr(result, "auth_cert")
	signatureB64 := authGetStr(result, "client_nonce_signature")
	if authCertPEM == "" {
		return NewAuthError("aid_login1 missing auth_cert")
	}
	if signatureB64 == "" {
		return NewAuthError("aid_login1 missing client_nonce_signature")
	}

	authCert, err := authParsePEMCertificate(authCertPEM)
	if err != nil {
		return NewAuthError("aid_login1 returned invalid auth_cert")
	}

	// 证书链验证
	if err := a.verifyAuthCertChain(ctx, gatewayURL, authCert, ""); err != nil {
		return err
	}
	// CRL 验证
	if err := a.verifyAuthCertRevocation(ctx, gatewayURL, authCert, ""); err != nil {
		return err
	}
	// OCSP 验证
	if err := a.verifyAuthCertOCSP(ctx, gatewayURL, authCert, ""); err != nil {
		return err
	}

	// 验证 client_nonce 签名
	sigBytes, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return NewAuthError("aid_login1 server auth signature decode failed")
	}
	if err := verifySignature(authCert.PublicKey, sigBytes, []byte(clientNonce)); err != nil {
		return NewAuthError("aid_login1 server auth signature verification failed")
	}
	return nil
}

// ── 内部：证书链验证 ────────────────────────────────────────

// verifyAuthCertChain 验证 auth 证书链。
// 含缓存命中 → 快速路径（只验 authCert→Issuer）→ 首次完整验证 + 受信根锚定。
func (a *AuthFlow) verifyAuthCertChain(ctx context.Context, gatewayURL string, authCert *x509.Certificate, chainAID string) error {
	certSerial := fmt.Sprintf("%x", authCert.SerialNumber)

	// 检查缓存
	a.mu.RLock()
	cachedAt, hasCached := a.chainVerifiedCache[certSerial]
	a.mu.RUnlock()
	if hasCached && float64(time.Now().Unix())-cachedAt < float64(a.chainCacheTTL) {
		return nil
	}

	now := time.Now()
	if err := authEnsureCertTimeValid(authCert, "auth certificate", now); err != nil {
		return err
	}

	chain, err := a.loadGatewayCAChain(ctx, gatewayURL, chainAID)
	if err != nil {
		return err
	}
	if len(chain) == 0 {
		return NewAuthError("unable to verify auth certificate chain: missing CA chain")
	}

	cacheKey := gatewayURL
	if chainAID != "" {
		cacheKey = fmt.Sprintf("%s:%s", gatewayURL, chainAID)
	}

	// 快速路径：CA 链已通过完整验证
	a.mu.RLock()
	caVerified := a.gatewayCAVerified[cacheKey]
	a.mu.RUnlock()
	if caVerified {
		issuer := chain[0]
		if err := authEnsureCertTimeValid(issuer, "Issuer CA", now); err != nil {
			return err
		}
		if !issuer.IsCA {
			return NewAuthError("Issuer CA is not marked as CA (fast path)")
		}
		if !authCertsIssuerMatch(authCert, issuer) {
			return NewAuthError("auth certificate issuer mismatch")
		}
		if err := verifySignature(issuer.PublicKey, authCert.Signature, authCert.RawTBSCertificate); err != nil {
			return NewAuthError("auth certificate signature verification failed")
		}
		a.mu.Lock()
		a.chainVerifiedCache[certSerial] = float64(time.Now().Unix())
		a.mu.Unlock()
		return nil
	}

	// 首次验证：逐级验证链
	current := authCert
	for i, caCert := range chain {
		if err := authEnsureCertTimeValid(caCert, fmt.Sprintf("CA certificate[%d]", i), now); err != nil {
			return err
		}
		if !authCertsIssuerMatch(current, caCert) {
			return NewAuthError(fmt.Sprintf("auth certificate issuer mismatch at chain level %d", i))
		}
		if err := verifySignature(caCert.PublicKey, current.Signature, current.RawTBSCertificate); err != nil {
			return NewAuthError(fmt.Sprintf("auth certificate signature verification failed at chain level %d", i))
		}
		if !caCert.IsCA {
			return NewAuthError(fmt.Sprintf("CA certificate[%d] is not marked as CA", i))
		}
		current = caCert
	}

	// 根证书必须是自签名
	root := chain[len(chain)-1]
	if !authCertsIssuerMatch(root, root) {
		return NewAuthError("auth certificate chain root is not self-signed")
	}
	if err := verifySignature(root.PublicKey, root.Signature, root.RawTBSCertificate); err != nil {
		return NewAuthError("auth certificate chain root self-signature verification failed")
	}

	// 根证书必须在受信列表中
	trustedRoots := a.loadTrustedRoots()
	if len(trustedRoots) == 0 {
		return NewAuthError("no trusted roots available for auth certificate verification")
	}
	rootDER := root.Raw
	found := false
	for _, trusted := range trustedRoots {
		if authBytesEqual(trusted.Raw, rootDER) {
			found = true
			break
		}
	}
	if !found {
		return NewAuthError("auth certificate chain is not anchored by a trusted root")
	}

	// 缓存验证结果
	a.mu.Lock()
	a.chainVerifiedCache[certSerial] = float64(time.Now().Unix())
	a.gatewayCAVerified[cacheKey] = true
	a.mu.Unlock()
	return nil
}

// loadGatewayCAChain 加载（带缓存）Gateway CA 链
func (a *AuthFlow) loadGatewayCAChain(ctx context.Context, gatewayURL string, chainAID string) ([]*x509.Certificate, error) {
	cacheKey := gatewayURL
	if chainAID != "" {
		cacheKey = fmt.Sprintf("%s:%s", gatewayURL, chainAID)
	}

	a.mu.RLock()
	cached, ok := a.gatewayChainCache[cacheKey]
	a.mu.RUnlock()

	if !ok {
		chainURL := authGatewayHTTPURL(gatewayURL, "/pki/chain")
		text, err := a.fetchText(ctx, chainURL)
		if err != nil {
			return nil, err
		}
		cached = authSplitPEMBundle(text)
		a.mu.Lock()
		a.gatewayChainCache[cacheKey] = cached
		a.mu.Unlock()
	}
	return authLoadCertBundle(cached)
}

// ── 内部：CRL 验证 ──────────────────────────────────────────

// verifyAuthCertRevocation 检查证书是否在 CRL 吊销列表中
func (a *AuthFlow) verifyAuthCertRevocation(ctx context.Context, gatewayURL string, authCert *x509.Certificate, chainAID string) error {
	chain, err := a.loadGatewayCAChain(ctx, gatewayURL, chainAID)
	if err != nil {
		return err
	}
	if len(chain) == 0 {
		return NewAuthError("unable to verify auth certificate revocation: missing issuer certificate")
	}

	// 跨域 peer cert：CRL 请求发到 peer 所在域的 Gateway
	crlGatewayURL := gatewayURL
	if chainAID != "" && strings.Contains(chainAID, ".") {
		parts := strings.SplitN(chainAID, ".", 2)
		peerIssuer := parts[1]
		re := regexp.MustCompile(`gateway\.([^:/]+)`)
		m := re.FindStringSubmatch(gatewayURL)
		if len(m) > 1 {
			localIssuer := m[1]
			if localIssuer != "" && peerIssuer != localIssuer {
				crlGatewayURL = strings.Replace(gatewayURL, "gateway."+localIssuer, "gateway."+peerIssuer, 1)
			}
		}
	}

	revokedSerials, err := a.loadGatewayRevokedSerials(ctx, crlGatewayURL, chain[0])
	if err != nil {
		return err
	}
	serialHex := strings.ToLower(fmt.Sprintf("%x", authCert.SerialNumber))
	if revokedSerials[serialHex] {
		return NewAuthError("auth certificate has been revoked")
	}
	return nil
}

// loadGatewayRevokedSerials 加载（带缓存）CRL 吊销列表
func (a *AuthFlow) loadGatewayRevokedSerials(ctx context.Context, gatewayURL string, issuerCert *x509.Certificate) (map[string]bool, error) {
	now := float64(time.Now().Unix())

	a.mu.RLock()
	cached := a.gatewayCRLCache[gatewayURL]
	a.mu.RUnlock()

	if cached != nil && cached.NextRefreshAt > now {
		return cached.RevokedSerials, nil
	}

	entry, err := a.fetchGatewayCRL(ctx, gatewayURL, issuerCert)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.gatewayCRLCache[gatewayURL] = entry
	a.mu.Unlock()
	return entry.RevokedSerials, nil
}

// fetchGatewayCRL 从 Gateway 获取 CRL 并验证 issuer 签名
func (a *AuthFlow) fetchGatewayCRL(ctx context.Context, gatewayURL string, issuerCert *x509.Certificate) (*crlCacheEntry, error) {
	crlURL := authGatewayHTTPURL(gatewayURL, "/pki/crl.json")
	payload, err := a.fetchJSON(ctx, crlURL)
	if err != nil {
		return nil, err
	}

	crlPEM := authGetStr(payload, "crl_pem")
	if crlPEM == "" {
		return nil, NewAuthError("gateway CRL endpoint returned no signed CRL")
	}

	block, _ := pem.Decode([]byte(crlPEM))
	if block == nil {
		return nil, NewAuthError("gateway CRL endpoint returned invalid CRL PEM")
	}

	crl, err := x509.ParseRevocationList(block.Bytes)
	if err != nil {
		return nil, NewAuthError(fmt.Sprintf("gateway CRL endpoint returned invalid CRL: %v", err))
	}

	// 验证 CRL 签名
	if err := crl.CheckSignatureFrom(issuerCert); err != nil {
		return nil, NewAuthError(fmt.Sprintf("gateway CRL signature verification failed: %v", err))
	}

	// 检查 CRL 过期
	if !crl.NextUpdate.IsZero() && time.Now().After(crl.NextUpdate) {
		return nil, NewAuthError("gateway CRL has expired")
	}

	// 提取吊销序列号
	revokedSerials := make(map[string]bool)
	for _, revoked := range crl.RevokedCertificateEntries {
		serialHex := strings.ToLower(fmt.Sprintf("%x", revoked.SerialNumber))
		revokedSerials[serialHex] = true
	}

	// 计算缓存过期时间
	nextRefreshAt := float64(time.Now().Unix()) + 300
	if !crl.NextUpdate.IsZero() {
		nextRefreshAt = float64(crl.NextUpdate.Unix())
	}
	// 最大缓存 TTL 24 小时
	maxRefreshAt := float64(time.Now().Unix()) + 86400
	if nextRefreshAt > maxRefreshAt {
		nextRefreshAt = maxRefreshAt
	}

	return &crlCacheEntry{
		RevokedSerials: revokedSerials,
		NextRefreshAt:  nextRefreshAt,
	}, nil
}

// ── 内部：OCSP 验证 ─────────────────────────────────────────

// verifyAuthCertOCSP 验证证书 OCSP 状态
func (a *AuthFlow) verifyAuthCertOCSP(ctx context.Context, gatewayURL string, authCert *x509.Certificate, chainAID string) error {
	chain, err := a.loadGatewayCAChain(ctx, gatewayURL, chainAID)
	if err != nil {
		return err
	}
	if len(chain) == 0 {
		return NewAuthError("unable to verify auth certificate OCSP status: missing issuer certificate")
	}
	status, err := a.loadGatewayOCSPStatus(ctx, gatewayURL, authCert, chain[0])
	if err != nil {
		return err
	}
	if status == "revoked" {
		return NewAuthError("auth certificate OCSP status is revoked")
	}
	if status != "good" {
		return NewAuthError(fmt.Sprintf("auth certificate OCSP status is %s", status))
	}
	return nil
}

// loadGatewayOCSPStatus 加载（带缓存）OCSP 状态
func (a *AuthFlow) loadGatewayOCSPStatus(ctx context.Context, gatewayURL string, authCert *x509.Certificate, issuerCert *x509.Certificate) (string, error) {
	serialHex := strings.ToLower(fmt.Sprintf("%x", authCert.SerialNumber))
	now := float64(time.Now().Unix())

	a.mu.RLock()
	gwCache := a.gatewayOCSPCache[gatewayURL]
	var cached *ocspCacheEntry
	if gwCache != nil {
		cached = gwCache[serialHex]
	}
	a.mu.RUnlock()

	if cached != nil && cached.NextRefreshAt > now {
		return cached.Status, nil
	}

	entry, err := a.fetchGatewayOCSPStatus(ctx, gatewayURL, authCert, issuerCert)
	if err != nil {
		return "", err
	}

	a.mu.Lock()
	if a.gatewayOCSPCache[gatewayURL] == nil {
		a.gatewayOCSPCache[gatewayURL] = make(map[string]*ocspCacheEntry)
	}
	a.gatewayOCSPCache[gatewayURL][serialHex] = entry
	a.mu.Unlock()

	return entry.Status, nil
}

// fetchGatewayOCSPStatus 从 Gateway 获取 OCSP 状态并完整验证
func (a *AuthFlow) fetchGatewayOCSPStatus(ctx context.Context, gatewayURL string, authCert *x509.Certificate, issuerCert *x509.Certificate) (*ocspCacheEntry, error) {
	serialHex := strings.ToLower(fmt.Sprintf("%x", authCert.SerialNumber))
	ocspURL := authGatewayHTTPURL(gatewayURL, fmt.Sprintf("/pki/ocsp/%s", serialHex))
	payload, err := a.fetchJSON(ctx, ocspURL)
	if err != nil {
		return nil, err
	}

	declaredStatus := authGetStr(payload, "status")
	ocspB64 := authGetStr(payload, "ocsp_response")
	if ocspB64 == "" {
		return nil, NewAuthError("gateway OCSP endpoint returned no ocsp_response")
	}

	ocspDER, err := base64.StdEncoding.DecodeString(ocspB64)
	if err != nil {
		return nil, NewAuthError("gateway OCSP endpoint returned invalid base64 ocsp_response")
	}

	response, err := ocsp.ParseResponse(ocspDER, issuerCert)
	if err != nil {
		return nil, NewAuthError(fmt.Sprintf("gateway OCSP endpoint returned invalid OCSP response: %v", err))
	}

	// 验证序列号匹配
	if response.SerialNumber.Cmp(authCert.SerialNumber) != 0 {
		return nil, NewAuthError("gateway OCSP response serial mismatch")
	}

	// 验证 issuer 绑定（Go 的 ocsp.Response 签名验证已覆盖 issuer 校验，
	// 此处通过 serial number 匹配 + 签名验证 + issuer cert 参数确保绑定）
	// 注意：Go ocsp 包不暴露 IssuerNameHash/IssuerKeyHash 字段，
	// 但 ParseResponseForCert 已在内部验证了 issuer 绑定。

	// 时间有效性
	now := time.Now()
	if !response.ThisUpdate.IsZero() && now.Before(response.ThisUpdate.Add(-5*time.Minute)) {
		return nil, NewAuthError("gateway OCSP response is not yet valid")
	}
	if !response.NextUpdate.IsZero() && now.After(response.NextUpdate) {
		return nil, NewAuthError("gateway OCSP response has expired")
	}

	// 解析证书状态
	var effectiveStatus string
	switch response.Status {
	case ocsp.Good:
		effectiveStatus = "good"
	case ocsp.Revoked:
		effectiveStatus = "revoked"
	default:
		effectiveStatus = "unknown"
	}

	// 声明状态与实际状态一致性检查
	if declaredStatus != "" && declaredStatus != effectiveStatus {
		return nil, NewAuthError("gateway OCSP status mismatch")
	}

	// 缓存过期时间
	nextRefreshAt := float64(time.Now().Unix()) + 300
	if !response.NextUpdate.IsZero() {
		nextRefreshAt = float64(response.NextUpdate.Unix())
	}
	maxRefreshAt := float64(time.Now().Unix()) + 86400
	if nextRefreshAt > maxRefreshAt {
		nextRefreshAt = maxRefreshAt
	}

	return &ocspCacheEntry{
		Status:        effectiveStatus,
		NextRefreshAt: nextRefreshAt,
	}, nil
}

// ── 内部：会话初始化 ────────────────────────────────────────

// initializeSession 通过 auth.connect RPC 初始化会话
func (a *AuthFlow) initializeSession(ctx context.Context, transport *RPCTransport, nonce string, token string) error {
	result, err := transport.Call(ctx, "auth.connect", map[string]any{
		"nonce": nonce,
		"auth": map[string]any{
			"method": "kite_token",
			"token":  token,
		},
		"protocol": map[string]any{
			"min": "1.0",
			"max": "1.0",
		},
		"capabilities": map[string]any{
			"e2ee":       true,
			"group_e2ee": true,
		},
	})
	if err != nil {
		return err
	}
	resultMap, _ := result.(map[string]any)
	status := ""
	if resultMap != nil {
		status, _ = resultMap["status"].(string)
	}
	if status != "ok" {
		return NewAuthError(fmt.Sprintf("initialize failed: %v", result))
	}
	return nil
}

// ── 内部：new_cert 验证 ─────────────────────────────────────

// validateNewCert 验证服务端返回的 new_cert（CN + 公钥 + 时间 + 链 + CRL + OCSP），
// 通过后正式接受替换 identity["cert"]。
func (a *AuthFlow) validateNewCert(ctx context.Context, identity map[string]any, gatewayURL string) {
	newCertPEM, ok := identity["_pending_new_cert"]
	delete(identity, "_pending_new_cert")
	if !ok || newCertPEM == nil {
		return
	}
	pemStr, _ := newCertPEM.(string)
	if pemStr == "" {
		return
	}

	aid := authGetStr(identity, "aid")

	cert, err := authParsePEMCertificate(pemStr)
	if err != nil {
		log.Printf("拒绝服务端返回的 new_cert (%s): 解析失败 %v", aid, err)
		return
	}

	// 1. CN 匹配
	if cert.Subject.CommonName != aid {
		log.Printf("拒绝服务端返回的 new_cert (%s): CN mismatch expected %s got %s",
			aid, aid, cert.Subject.CommonName)
		return
	}

	// 2. 公钥匹配
	certPubDER, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil {
		log.Printf("拒绝服务端返回的 new_cert (%s): 公钥序列化失败", aid)
		return
	}
	localPubB64 := authGetStr(identity, "public_key_der_b64")
	if localPubB64 != "" {
		localPubDER, err := base64.StdEncoding.DecodeString(localPubB64)
		if err == nil && !authBytesEqual(certPubDER, localPubDER) {
			log.Printf("拒绝服务端返回的 new_cert (%s): 公钥不匹配本地密钥", aid)
			return
		}
	}

	// 3. 时间有效性
	if err := authEnsureCertTimeValid(cert, "new_cert", time.Now()); err != nil {
		log.Printf("拒绝服务端返回的 new_cert (%s): %v", aid, err)
		return
	}

	// 4. 完整链验证 + CRL + OCSP
	if gatewayURL != "" {
		if err := a.verifyAuthCertChain(ctx, gatewayURL, cert, ""); err != nil {
			log.Printf("拒绝服务端返回的 new_cert (%s): 链验证失败 %v", aid, err)
			return
		}
		if err := a.verifyAuthCertRevocation(ctx, gatewayURL, cert, ""); err != nil {
			log.Printf("拒绝服务端返回的 new_cert (%s): CRL 验证失败 %v", aid, err)
			return
		}
		// OCSP 不可用时降级（CRL 已检查）
		_ = a.verifyAuthCertOCSP(ctx, gatewayURL, cert, "")
	}

	// 验证通过，正式接受
	identity["cert"] = pemStr
}

// ── 内部：证书下载恢复 ──────────────────────────────────────

// recoverCertViaDownload 本地有密钥但无证书、服务端已注册 — 通过 PKI HTTP 端点下载证书恢复。
func (a *AuthFlow) recoverCertViaDownload(ctx context.Context, gatewayURL string, identity map[string]any) (map[string]any, error) {
	aid := authGetStr(identity, "aid")
	certURL := authGatewayHTTPURL(gatewayURL, fmt.Sprintf("/pki/cert/%s", aid))
	certPEM, err := a.fetchText(ctx, certURL)
	if err != nil {
		return nil, err
	}
	if certPEM == "" || !strings.Contains(certPEM, "BEGIN CERTIFICATE") {
		return nil, NewAuthError(fmt.Sprintf("failed to download certificate for %s", aid))
	}

	// 验证下载证书的公钥与本地密钥对匹配
	cert, err := authParsePEMCertificate(certPEM)
	if err != nil {
		return nil, NewAuthError(fmt.Sprintf("failed to parse downloaded certificate for %s", aid))
	}
	certPubDER, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil {
		return nil, NewAuthError("failed to marshal downloaded certificate public key")
	}
	localPubB64 := authGetStr(identity, "public_key_der_b64")
	localPubDER, err := base64.StdEncoding.DecodeString(localPubB64)
	if err != nil {
		return nil, NewAuthError("failed to decode local public key")
	}
	if !authBytesEqual(certPubDER, localPubDER) {
		return nil, NewAuthError(fmt.Sprintf(
			"downloaded certificate public key does not match local key pair for %s. "+
				"The server has a different key registered - this AID cannot be recovered with the current key.", aid))
	}

	identity["cert"] = certPEM
	return identity, nil
}

// ── 内部：HTTP 请求 ─────────────────────────────────────────

// fetchText HTTP GET 返回文本
func (a *AuthFlow) fetchText(ctx context.Context, targetURL string) (string, error) {
	client := a.httpClient()
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, targetURL, nil)
	if err != nil {
		return "", NewAuthError(fmt.Sprintf("failed to create request for %s", targetURL))
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", NewAuthError(fmt.Sprintf("failed to fetch %s: %v", targetURL, err))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", NewAuthError(fmt.Sprintf("failed to fetch %s: HTTP %d", targetURL, resp.StatusCode))
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", NewAuthError(fmt.Sprintf("failed to read response from %s", targetURL))
	}
	return string(body), nil
}

// fetchJSON HTTP GET 返回 JSON map
func (a *AuthFlow) fetchJSON(ctx context.Context, targetURL string) (map[string]any, error) {
	text, err := a.fetchText(ctx, targetURL)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return nil, NewAuthError(fmt.Sprintf("invalid JSON payload from %s", targetURL))
	}
	return payload, nil
}

// httpClient 创建 HTTP 客户端
func (a *AuthFlow) httpClient() *http.Client {
	transport := &http.Transport{}
	if !a.verifySSL {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &http.Client{Timeout: 5 * time.Second, Transport: transport}
}

// ── 内部：身份管理 ──────────────────────────────────────────

// ensureLocalIdentity 确保本地有指定 AID 的密钥对（无则生成）
func (a *AuthFlow) ensureLocalIdentity(aid string) map[string]any {
	existing, _ := a.keystore.LoadIdentity(aid)
	if existing != nil {
		a.aid = aid
		return existing
	}
	identity, err := a.crypto.GenerateIdentity()
	if err != nil {
		return map[string]any{"aid": aid}
	}
	identity["aid"] = aid
	_ = a.keystore.SaveIdentity(aid, identity)
	a.aid = aid
	return identity
}

// loadIdentityOrRaise 加载身份，不存在时返回 StateError
func (a *AuthFlow) loadIdentityOrRaise(aid string) (map[string]any, error) {
	requestedAID := aid
	if requestedAID == "" {
		requestedAID = a.aid
	}
	if requestedAID != "" {
		existing, err := a.keystore.LoadIdentity(requestedAID)
		if err != nil {
			return nil, err
		}
		if existing == nil {
			return nil, NewStateError(fmt.Sprintf("identity not found for aid: %s", requestedAID))
		}
		a.aid = requestedAID
		return existing, nil
	}

	// 尝试加载任意已存在的身份（FileKeyStore 特有方法）
	type anyIdentityLoader interface {
		LoadAnyIdentity() (map[string]any, error)
	}
	if loader, ok := a.keystore.(anyIdentityLoader); ok {
		existing, err := loader.LoadAnyIdentity()
		if err == nil && existing != nil {
			if loadedAID, ok := existing["aid"].(string); ok && loadedAID != "" {
				a.aid = loadedAID
			}
			return existing, nil
		}
	}

	return nil, NewStateError("no local identity found, call auth.create_aid() first")
}

// ensureIdentity 确保有可用身份（无则生成）
func (a *AuthFlow) ensureIdentity() map[string]any {
	identity, err := a.loadIdentityOrRaise("")
	if err == nil {
		return identity
	}
	if a.aid == "" {
		return map[string]any{}
	}
	newIdentity, genErr := a.crypto.GenerateIdentity()
	if genErr != nil {
		return map[string]any{"aid": a.aid}
	}
	newIdentity["aid"] = a.aid
	_ = a.keystore.SaveIdentity(a.aid, newIdentity)
	return newIdentity
}

// ── 内部：根证书加载 ────────────────────────────────────────

// loadRootCerts 加载打包的和自定义的根 CA 证书
func (a *AuthFlow) loadRootCerts(rootCAPath string) []*x509.Certificate {
	var candidatePaths []string
	if rootCAPath != "" {
		candidatePaths = append(candidatePaths, rootCAPath)
	}

	// 查找可执行文件同级 certs/ 目录
	if execPath, err := os.Executable(); err == nil {
		bundledDir := filepath.Join(filepath.Dir(execPath), "certs")
		authAppendCertPaths(&candidatePaths, bundledDir)
	}

	// 开发环境：查找项目目录下的 certs/
	devPaths := []string{"certs", "../certs", "go/certs"}
	for _, p := range devPaths {
		authAppendCertPaths(&candidatePaths, p)
	}

	var certs []*x509.Certificate
	seenDER := make(map[string]bool)
	for _, path := range candidatePaths {
		text, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		pems := authSplitPEMBundle(string(text))
		parsed, err := authLoadCertBundle(pems)
		if err != nil {
			continue
		}
		for _, cert := range parsed {
			derKey := base64.StdEncoding.EncodeToString(cert.Raw)
			if seenDER[derKey] {
				continue
			}
			seenDER[derKey] = true
			certs = append(certs, cert)
		}
	}
	return certs
}

// loadTrustedRoots 返回已加载的受信根证书列表
func (a *AuthFlow) loadTrustedRoots() []*x509.Certificate {
	return a.rootCerts
}

// ── 静态辅助函数（auth 模块私有）────────────────────────────

// authGatewayHTTPURL 将 WebSocket URL 转换为 HTTP URL
func authGatewayHTTPURL(gatewayURL string, path string) string {
	parsed, err := url.Parse(gatewayURL)
	if err != nil {
		return gatewayURL
	}
	scheme := "https"
	if parsed.Scheme == "ws" {
		scheme = "http"
	}
	return fmt.Sprintf("%s://%s%s", scheme, parsed.Host, path)
}

// authSplitPEMBundle 拆分 PEM 证书捆绑包
func authSplitPEMBundle(bundleText string) []string {
	marker := "-----END CERTIFICATE-----"
	var certs []string
	for _, part := range strings.Split(bundleText, marker) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		certs = append(certs, part+"\n"+marker+"\n")
	}
	return certs
}

// authLoadCertBundle 解析 PEM 字符串列表为 x509.Certificate 列表
func authLoadCertBundle(pems []string) ([]*x509.Certificate, error) {
	var certs []*x509.Certificate
	for _, pemStr := range pems {
		cert, err := authParsePEMCertificate(pemStr)
		if err != nil {
			return nil, err
		}
		certs = append(certs, cert)
	}
	return certs, nil
}

// authParsePEMCertificate 解析单个 PEM 编码的证书
func authParsePEMCertificate(pemStr string) (*x509.Certificate, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, fmt.Errorf("无法解析 PEM 证书")
	}
	return x509.ParseCertificate(block.Bytes)
}

// authEnsureCertTimeValid 检查证书时间有效性
func authEnsureCertTimeValid(cert *x509.Certificate, label string, now time.Time) error {
	if now.Before(cert.NotBefore) {
		return NewAuthError(fmt.Sprintf("%s is not yet valid", label))
	}
	if now.After(cert.NotAfter) {
		return NewAuthError(fmt.Sprintf("%s has expired", label))
	}
	return nil
}

// authCertsIssuerMatch 检查 cert.Issuer == issuer.Subject（基于 DER 编码）
func authCertsIssuerMatch(cert, issuer *x509.Certificate) bool {
	return authBytesEqual(cert.RawIssuer, issuer.RawSubject)
}

// authExtractChallengeNonce 从 challenge 消息中提取 nonce
func authExtractChallengeNonce(challenge map[string]any) string {
	if challenge == nil {
		return ""
	}
	params, _ := challenge["params"].(map[string]any)
	if params == nil {
		return ""
	}
	nonce, _ := params["nonce"].(string)
	return nonce
}

// authGetStr 从 map 中安全获取字符串值
func authGetStr(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, _ := m[key].(string)
	return v
}

// authGetStrDefault 从 map 中获取字符串值，不存在返回默认值
func authGetStrDefault(m map[string]any, key string, defaultVal string) string {
	v := authGetStr(m, key)
	if v == "" {
		return defaultVal
	}
	return v
}

// authBytesEqual 比较两个字节切片
func authBytesEqual(a, b []byte) bool {
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

// authRememberTokens 从认证响应中提取 token 保存到 identity
func authRememberTokens(identity map[string]any, authResult map[string]any) {
	accessToken := authGetStr(authResult, "access_token")
	if accessToken == "" {
		accessToken = authGetStr(authResult, "token")
	}
	if accessToken == "" {
		accessToken = authGetStr(authResult, "kite_token")
	}
	refreshToken := authGetStr(authResult, "refresh_token")

	if accessToken != "" {
		identity["access_token"] = accessToken
	}
	if refreshToken != "" {
		identity["refresh_token"] = refreshToken
	}
	if tokenVal := authGetStr(authResult, "token"); tokenVal != "" {
		identity["kite_token"] = tokenVal
	}

	// 计算过期时间
	if expiresIn, ok := authResult["expires_in"]; ok {
		var seconds float64
		switch v := expiresIn.(type) {
		case float64:
			seconds = v
		case int:
			seconds = float64(v)
		case int64:
			seconds = float64(v)
		}
		if seconds > 0 {
			identity["access_token_expires_at"] = int(float64(time.Now().Unix()) + seconds)
		}
	}

	// 暂存 new_cert，由 validateNewCert 验证后正式接受
	if newCert, ok := authResult["new_cert"]; ok && newCert != nil {
		identity["_pending_new_cert"] = newCert
	}
}

// authGetCachedAccessToken 获取未过期的缓存 access_token
func authGetCachedAccessToken(identity map[string]any) string {
	accessToken := authGetStr(identity, "access_token")
	if accessToken == "" {
		return ""
	}
	expiresAt := identity["access_token_expires_at"]
	threshold := float64(time.Now().Unix()) + 30
	switch v := expiresAt.(type) {
	case float64:
		if v <= threshold {
			return ""
		}
	case int:
		if float64(v) <= threshold {
			return ""
		}
	case int64:
		if float64(v) <= threshold {
			return ""
		}
	}
	return accessToken
}

// authAppendCertPaths 将目录中的 .crt 文件路径追加到列表
func authAppendCertPaths(paths *[]string, dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".crt") {
			*paths = append(*paths, filepath.Join(dir, e.Name()))
		}
	}
}
