package aun

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

// eventNameMap 协议事件名到 SDK 事件名的映射
var eventNameMap = map[string]string{
	"message.received": "message.received",
	"message.recalled": "message.recalled",
	"message.ack":      "message.ack",
	"group.changed":    "group.changed",
}

// RPCTransport WebSocket JSON-RPC 2.0 传输层
// 与 Python SDK transport.py 对应。
type RPCTransport struct {
	dispatcher    *EventDispatcher
	timeout       time.Duration
	onDisconnect  func(error)
	verifySSL     bool
	ws            *websocket.Conn
	pending       map[string]chan map[string]any
	pendingMu     sync.Mutex
	closed        bool
	closedMu      sync.RWMutex
	challenge     map[string]any
	cancelReader  context.CancelFunc
	readerDone    chan struct{}
}

// NewRPCTransport 创建 RPC 传输层
func NewRPCTransport(dispatcher *EventDispatcher, timeout time.Duration, onDisconnect func(error), verifySSL bool) *RPCTransport {
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	return &RPCTransport{
		dispatcher:   dispatcher,
		timeout:      timeout,
		onDisconnect: onDisconnect,
		verifySSL:    verifySSL,
		pending:      make(map[string]chan map[string]any),
		closed:       true,
	}
}

// SetTimeout 设置 RPC 调用超时时间
func (t *RPCTransport) SetTimeout(timeout time.Duration) {
	t.timeout = timeout
}

// Challenge 返回连接时收到的 challenge 消息
func (t *RPCTransport) Challenge() map[string]any {
	return t.challenge
}

// Connect 连接到 WebSocket 服务端，返回 challenge 消息
func (t *RPCTransport) Connect(ctx context.Context, url string) (map[string]any, error) {
	opts := &websocket.DialOptions{}
	if !t.verifySSL {
		opts.HTTPClient = &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		}
	}
	conn, _, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		return nil, NewConnectionError(fmt.Sprintf("连接 WebSocket 失败: %v", err))
	}

	t.ws = conn
	t.closedMu.Lock()
	t.closed = false
	t.closedMu.Unlock()

	// 接收初始消息（challenge）
	challenge, err := t.recvInitialMessage(ctx)
	if err != nil {
		_ = conn.Close(websocket.StatusNormalClosure, "")
		return nil, err
	}
	t.challenge = challenge

	// 启动读取循环
	readerCtx, cancel := context.WithCancel(context.Background())
	t.cancelReader = cancel
	t.readerDone = make(chan struct{})
	go t.readerLoop(readerCtx)

	return challenge, nil
}

// Close 关闭传输层
func (t *RPCTransport) Close() error {
	t.closedMu.Lock()
	t.closed = true
	t.closedMu.Unlock()

	// 取消读取循环
	if t.cancelReader != nil {
		t.cancelReader()
		// 等待读取循环退出
		if t.readerDone != nil {
			<-t.readerDone
		}
	}

	// 关闭 WebSocket
	if t.ws != nil {
		_ = t.ws.Close(websocket.StatusNormalClosure, "")
		t.ws = nil
	}

	// 通知所有等待中的 RPC 调用
	t.pendingMu.Lock()
	for id, ch := range t.pending {
		close(ch)
		delete(t.pending, id)
	}
	t.pendingMu.Unlock()

	return nil
}

// Call 发起 JSON-RPC 调用
func (t *RPCTransport) Call(ctx context.Context, method string, params map[string]any) (any, error) {
	t.closedMu.RLock()
	if t.closed || t.ws == nil {
		t.closedMu.RUnlock()
		return nil, NewConnectionError("传输层未连接")
	}
	t.closedMu.RUnlock()

	// 生成请求 ID
	rpcID := generateRPCID()
	resultCh := make(chan map[string]any, 1)

	t.pendingMu.Lock()
	t.pending[rpcID] = resultCh
	t.pendingMu.Unlock()

	// 构造 JSON-RPC 请求
	if params == nil {
		params = make(map[string]any)
	}
	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      rpcID,
		"method":  method,
		"params":  params,
	}

	data, err := json.Marshal(request)
	if err != nil {
		t.pendingMu.Lock()
		delete(t.pending, rpcID)
		t.pendingMu.Unlock()
		return nil, NewSerializationError(fmt.Sprintf("序列化 RPC 请求失败: %v", err))
	}

	// 发送请求
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := t.ws.Write(writeCtx, websocket.MessageText, data); err != nil {
		t.pendingMu.Lock()
		delete(t.pending, rpcID)
		t.pendingMu.Unlock()
		return nil, NewConnectionError(fmt.Sprintf("发送 RPC %s 失败: %v", method, err))
	}

	// 等待响应（带超时）
	timer := time.NewTimer(t.timeout)
	defer timer.Stop()

	select {
	case response, ok := <-resultCh:
		if !ok {
			return nil, NewConnectionError("传输层已关闭")
		}
		// 检查错误
		if errData, ok := response["error"]; ok {
			if errMap, ok := errData.(map[string]any); ok {
				return nil, MapRemoteError(errMap)
			}
		}
		return response["result"], nil

	case <-timer.C:
		t.pendingMu.Lock()
		delete(t.pending, rpcID)
		t.pendingMu.Unlock()
		return nil, NewTimeoutError(fmt.Sprintf("RPC 超时: %s", method))

	case <-ctx.Done():
		t.pendingMu.Lock()
		delete(t.pending, rpcID)
		t.pendingMu.Unlock()
		return nil, NewTimeoutError(fmt.Sprintf("RPC 上下文取消: %s", method))
	}
}

// recvInitialMessage 接收初始消息（通常为 challenge）
func (t *RPCTransport) recvInitialMessage(ctx context.Context) (map[string]any, error) {
	readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, data, err := t.ws.Read(readCtx)
	if err != nil {
		return nil, NewConnectionError(fmt.Sprintf("接收初始消息失败: %v", err))
	}

	message, err := decodeMessage(data)
	if err != nil {
		return nil, err
	}

	if method, ok := message["method"].(string); ok && method == "challenge" {
		return message, nil
	}

	// 非 challenge 消息，路由到事件处理
	t.routeMessage(message)
	return nil, nil
}

// readerLoop 后台读取循环
func (t *RPCTransport) readerLoop(ctx context.Context) {
	defer close(t.readerDone)
	var disconnectErr error
	unexpectedDisconnect := false

	defer func() {
		t.closedMu.Lock()
		wasClosed := t.closed
		t.closed = true
		t.closedMu.Unlock()

		if unexpectedDisconnect && !wasClosed && t.onDisconnect != nil {
			t.onDisconnect(disconnectErr)
		}
	}()

	for {
		t.closedMu.RLock()
		isClosed := t.closed
		t.closedMu.RUnlock()
		if isClosed {
			return
		}

		select {
		case <-ctx.Done():
			return
		default:
		}

		_, data, err := t.ws.Read(ctx)
		if err != nil {
			t.closedMu.RLock()
			wasClosed := t.closed
			t.closedMu.RUnlock()
			if !wasClosed {
				disconnectErr = err
				unexpectedDisconnect = true
				t.dispatcher.Publish("connection.error", map[string]any{"error": err})
			}
			return
		}

		message, err := decodeMessage(data)
		if err != nil {
			log.Printf("解码消息失败: %v", err)
			continue
		}
		t.routeMessage(message)
	}
}

// routeMessage 路由消息到对应的处理器
func (t *RPCTransport) routeMessage(message map[string]any) {
	// 有 id 的是 RPC 响应
	if id, ok := message["id"]; ok {
		rpcID := fmt.Sprintf("%v", id)
		t.pendingMu.Lock()
		ch, exists := t.pending[rpcID]
		if exists {
			delete(t.pending, rpcID)
		}
		t.pendingMu.Unlock()

		if exists {
			ch <- message
		}
		return
	}

	// challenge 消息
	method, _ := message["method"].(string)
	if method == "challenge" {
		t.challenge = message
		params, _ := message["params"].(map[string]any)
		t.dispatcher.Publish("connection.challenge", params)
		return
	}

	// 事件消息
	if len(method) > 6 && method[:6] == "event/" {
		protocolEvent := method[6:]
		sdkEvent := protocolEvent
		if mapped, ok := eventNameMap[protocolEvent]; ok {
			sdkEvent = mapped
		}
		params, _ := message["params"].(map[string]any)
		t.dispatcher.Publish("_raw."+sdkEvent, params)
		return
	}

	// 其他通知
	t.dispatcher.Publish("notification", message)
}

// decodeMessage 解码 WebSocket 消息为 map
func decodeMessage(data []byte) (map[string]any, error) {
	var message map[string]any
	if err := json.Unmarshal(data, &message); err != nil {
		return nil, NewSerializationError("无效的 JSON 载荷")
	}
	return message, nil
}

// generateRPCID 生成随机的 RPC 请求 ID
func generateRPCID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "rpc-" + hex.EncodeToString(b)
}
