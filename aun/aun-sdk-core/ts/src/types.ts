/**
 * AUN SDK 核心类型定义
 */

/** 消息结构 */
export interface Message {
  message_id?: string;
  seq?: number;
  from?: string;
  to?: string;
  type?: string;
  payload?: unknown;
  encrypted?: boolean;
  persist?: boolean;
  timestamp?: number;
}

/** 发送结果 */
export interface SendResult {
  message_id?: string;
  seq?: number;
  timestamp?: number;
  status?: 'sent' | 'delivered' | 'duplicate';
  persist?: boolean;
}

/** 确认结果 */
export interface AckResult {
  ack_seq?: number;
}

/** 拉取结果 */
export interface PullResult {
  messages?: Message[];
  count?: number;
  latest_seq?: number;
}
