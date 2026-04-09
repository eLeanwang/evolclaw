package namespace

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
)

// ClientInterface 定义 AuthNamespace 所需的客户端接口
// 避免直接依赖 AUNClient 导致的循环引用
type ClientInterface interface {
	GetGatewayURL() string
	SetGatewayURL(url string)
	GetAID() string
	SetAID(aid string)
	GetConfigDiscoveryPort() int
	GetConfigVerifySSL() bool
	Call(ctx context.Context, method string, params map[string]any) (any, error)

	// 认证流程所需方法
	AuthCreateAID(ctx context.Context, gatewayURL, aid string) (map[string]any, error)
	AuthAuthenticate(ctx context.Context, gatewayURL, aid string) (map[string]any, error)
	AuthLoadIdentityOrNil(aid string) map[string]any
	DiscoverGateway(ctx context.Context, wellKnownURL string, timeout time.Duration) (string, error)
	SetIdentity(identity map[string]any)
}

// AuthNamespace 认证命名空间
// 封装 AID 创建、认证、证书管理等操作。
// 与 Python SDK namespaces/auth_namespace.py 对应。
type AuthNamespace struct {
	client ClientInterface
}

// NewAuthNamespace 创建认证命名空间
func NewAuthNamespace(client ClientInterface) *AuthNamespace {
	return &AuthNamespace{client: client}
}

// resolveGateway 解析 gateway URL。优先使用已预置的 gatewayURL，否则基于 AID 自动发现。
//
// 发现流程：
//  1. 若 gatewayURL 已预置，直接返回
//  2. https://{aid}/.well-known/aun-gateway（泛域名 nameservice）
//  3. https://gateway.{issuer}/.well-known/aun-gateway（Gateway 直连）
func (a *AuthNamespace) resolveGateway(ctx context.Context, aid string) (string, error) {
	if gw := a.client.GetGatewayURL(); gw != "" {
		return gw, nil
	}
	resolvedAID := aid
	if resolvedAID == "" {
		resolvedAID = a.client.GetAID()
	}
	if resolvedAID == "" {
		return "", fmt.Errorf("无法解析 gateway：需设置 gateway_url 或提供 'aid' 进行自动发现")
	}

	parts := strings.SplitN(resolvedAID, ".", 2)
	issuerDomain := resolvedAID
	if len(parts) > 1 {
		issuerDomain = parts[1]
	}

	port := a.client.GetConfigDiscoveryPort()
	portSuffix := ""
	if port > 0 {
		portSuffix = fmt.Sprintf(":%d", port)
	}

	// 首选：通过 AID 域名发现
	primaryURL := fmt.Sprintf("https://%s%s/.well-known/aun-gateway", resolvedAID, portSuffix)
	gwURL, err := a.client.DiscoverGateway(ctx, primaryURL, 5*time.Second)
	if err == nil {
		return gwURL, nil
	}
	log.Printf("gateway 发现失败 (%s): %v", primaryURL, err)

	// 备选：通过 gateway.{issuer} 发现
	fallbackURL := fmt.Sprintf("https://gateway.%s%s/.well-known/aun-gateway", issuerDomain, portSuffix)
	return a.client.DiscoverGateway(ctx, fallbackURL, 5*time.Second)
}

// CreateAID 创建新的 AID 身份
func (a *AuthNamespace) CreateAID(ctx context.Context, params map[string]any) (map[string]any, error) {
	aid, _ := params["aid"].(string)
	if aid == "" {
		return nil, fmt.Errorf("auth.create_aid 需要 'aid' 参数")
	}

	gatewayURL, err := a.resolveGateway(ctx, aid)
	if err != nil {
		return nil, fmt.Errorf("auth.create_aid gateway 发现失败: %w", err)
	}
	a.client.SetGatewayURL(gatewayURL)

	result, err := a.client.AuthCreateAID(ctx, gatewayURL, aid)
	if err != nil {
		return nil, err
	}

	resultAID, _ := result["aid"].(string)
	a.client.SetAID(resultAID)
	identity := a.client.AuthLoadIdentityOrNil(resultAID)
	a.client.SetIdentity(identity)

	return map[string]any{
		"aid":      resultAID,
		"cert_pem": result["cert"],
		"gateway":  gatewayURL,
	}, nil
}

// Authenticate 认证已有的 AID
func (a *AuthNamespace) Authenticate(ctx context.Context, params map[string]any) (map[string]any, error) {
	request := make(map[string]any)
	if params != nil {
		for k, v := range params {
			request[k] = v
		}
	}
	aid, _ := request["aid"].(string)

	gatewayURL, err := a.resolveGateway(ctx, aid)
	if err != nil {
		return nil, fmt.Errorf("auth.authenticate gateway 发现失败: %w", err)
	}
	a.client.SetGatewayURL(gatewayURL)

	result, err := a.client.AuthAuthenticate(ctx, gatewayURL, aid)
	if err != nil {
		return nil, err
	}

	resultAID, _ := result["aid"].(string)
	a.client.SetAID(resultAID)
	identity := a.client.AuthLoadIdentityOrNil(resultAID)
	a.client.SetIdentity(identity)

	return result, nil
}

// DownloadCert 下载证书
func (a *AuthNamespace) DownloadCert(ctx context.Context, params map[string]any) (any, error) {
	return a.client.Call(ctx, "auth.download_cert", params)
}

// RequestCert 请求证书
func (a *AuthNamespace) RequestCert(ctx context.Context, params map[string]any) (any, error) {
	return a.client.Call(ctx, "auth.request_cert", params)
}

// RenewCert 续期证书
func (a *AuthNamespace) RenewCert(ctx context.Context, params map[string]any) (any, error) {
	return a.client.Call(ctx, "auth.renew_cert", params)
}

// Rekey 重新生成密钥
func (a *AuthNamespace) Rekey(ctx context.Context, params map[string]any) (any, error) {
	return a.client.Call(ctx, "auth.rekey", params)
}

// TrustRoots 获取信任根
func (a *AuthNamespace) TrustRoots(ctx context.Context, params map[string]any) (any, error) {
	return a.client.Call(ctx, "meta.trust_roots", params)
}
