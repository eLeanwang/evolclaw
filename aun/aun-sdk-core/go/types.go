package aun

// ── 消息与结果类型 ─────────────────────────────────────────
// 与 Python SDK 中的协议消息结构完全对应。

// Message AUN 协议消息
type Message struct {
	MessageID string `json:"message_id,omitempty"` // 消息唯一标识
	Seq       int64  `json:"seq,omitempty"`        // 消息序列号
	From      string `json:"from,omitempty"`       // 发送方 AID
	To        string `json:"to,omitempty"`         // 接收方 AID
	Type      string `json:"type,omitempty"`       // 消息类型
	Payload   any    `json:"payload,omitempty"`     // 消息载荷
	Encrypted bool   `json:"encrypted,omitempty"`   // 是否已加密
	Persist   bool   `json:"persist,omitempty"`     // 是否持久化
	Timestamp int64  `json:"timestamp,omitempty"`   // 时间戳（毫秒）
}

// SendResult 发送消息的返回结果
type SendResult struct {
	MessageID string `json:"message_id,omitempty"` // 消息唯一标识
	Seq       int64  `json:"seq,omitempty"`        // 分配的序列号
	Timestamp int64  `json:"timestamp,omitempty"`  // 服务端时间戳
	Status    string `json:"status,omitempty"`     // "sent", "delivered", "duplicate"
	Persist   bool   `json:"persist,omitempty"`    // 是否已持久化
}

// AckResult 消息确认结果
type AckResult struct {
	AckSeq int64 `json:"ack_seq,omitempty"` // 确认到的序列号
}

// PullResult 拉取消息的返回结果
type PullResult struct {
	Messages  []Message `json:"messages,omitempty"`  // 消息列表
	Count     int       `json:"count,omitempty"`     // 消息数量
	LatestSeq int64     `json:"latest_seq,omitempty"` // 最新序列号
}
