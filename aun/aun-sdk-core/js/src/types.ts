// ── AUN 协议类型定义 ──────────────────────────────────────

/** JSON 值类型 */
export type JsonValue = unknown;

/** 消息类型 */
export interface Message {
  message_id?: string;
  seq?: number;
  to?: string;
  from?: string;
  type?: string;
  payload?: JsonValue;
  encrypted?: boolean;
  persist?: boolean;
  timestamp?: number;
  e2ee?: Record<string, unknown>;
}

/** 发送结果 */
export interface SendResult {
  message_id?: string;
  seq?: number;
  timestamp?: number;
  status?: 'sent' | 'delivered' | 'duplicate';
  persist?: boolean;
}

/** ACK 结果 */
export interface AckResult {
  ack_seq?: number;
}

/** 拉取结果 */
export interface PullResult {
  messages?: Message[];
  count?: number;
  latest_seq?: number;
}
