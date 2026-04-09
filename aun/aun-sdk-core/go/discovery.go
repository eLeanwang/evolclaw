package aun

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"
)

// GatewayDiscovery Gateway 自动发现
// 通过 well-known URL 获取可用的 Gateway 列表并按优先级排序。
// 与 Python SDK discovery.py 对应。
type GatewayDiscovery struct {
	verifySSL bool
}

// NewGatewayDiscovery 创建 Gateway 发现器
func NewGatewayDiscovery(verifySSL bool) *GatewayDiscovery {
	return &GatewayDiscovery{verifySSL: verifySSL}
}

// gatewayEntry well-known 返回的单条 Gateway 信息
type gatewayEntry struct {
	URL      string `json:"url"`
	Priority int    `json:"priority"`
}

// Discover 从 well-known URL 发现 Gateway
// 返回优先级最高的 Gateway WebSocket URL
func (d *GatewayDiscovery) Discover(ctx context.Context, wellKnownURL string, timeout time.Duration) (string, error) {
	if timeout == 0 {
		timeout = 5 * time.Second
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// 创建 HTTP 客户端（根据 verifySSL 配置 TLS）
	transport := &http.Transport{}
	if !d.verifySSL {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	client := &http.Client{Transport: transport}

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, wellKnownURL, nil)
	if err != nil {
		return "", NewConnectionError(
			fmt.Sprintf("gateway 发现请求创建失败 (%s): %v", wellKnownURL, err),
			WithRetryable(true),
		)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", NewConnectionError(
			fmt.Sprintf("gateway 发现失败 (%s): %v", wellKnownURL, err),
			WithRetryable(true),
		)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", NewConnectionError(
			fmt.Sprintf("gateway 发现失败 (%s): HTTP %d", wellKnownURL, resp.StatusCode),
			WithRetryable(true),
		)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", NewConnectionError(
			fmt.Sprintf("读取 gateway 发现响应失败 (%s): %v", wellKnownURL, err),
			WithRetryable(true),
		)
	}

	var payload struct {
		Gateways []gatewayEntry `json:"gateways"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", NewValidationError(fmt.Sprintf("解析 well-known 响应失败: %v", err))
	}

	if len(payload.Gateways) == 0 {
		return "", NewValidationError("well-known 返回空的 gateways 列表")
	}

	// 按 priority 排序（升序）
	sort.Slice(payload.Gateways, func(i, j int) bool {
		pi := payload.Gateways[i].Priority
		pj := payload.Gateways[j].Priority
		if pi == 0 {
			pi = 999
		}
		if pj == 0 {
			pj = 999
		}
		return pi < pj
	})

	url := payload.Gateways[0].URL
	if url == "" {
		return "", NewValidationError("well-known 缺少 gateway url")
	}

	return url, nil
}
