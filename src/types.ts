export interface Config {
  anthropic?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  claude?: {
    apiKey: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
  };
  acp: {
    domain: string;
    agentName: string;
  };
  projects?: {
    defaultPath: string;
    autoCreate: boolean;
    list?: Record<string, string>;
  };
  flushDelay?: number;  // 消息批量发送间隔(ms)，默认 4000
  timeout?: {
    idle?: number;  // 无输出超时(ms)，默认 120000
  };
  healthCheck?: {
    enabled?: boolean;              // 是否启用健康检查，默认 true
    safeModeThreshold?: number;     // 连续错误几次进入安全模式，默认 3；设为 0 关闭 safe mode
  };
  owners?: {
    feishu?: string;
    acp?: string;
  };
}

export interface Session {
  id: string;
  channel: 'feishu' | 'acp';
  channelId: string;
  projectPath: string;
  claudeSessionId?: string;
  name?: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  channel: 'feishu' | 'acp';
  channelId: string;
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  timestamp?: number;
  userId?: string;
  userName?: string;
  messageId?: string;
  isGroup?: boolean;
}

// 渠道适配器接口
export interface ChannelAdapter {
  readonly name: string;
  sendText(channelId: string, text: string, options?: { title?: string; replyToMessageId?: string }): Promise<void>;
  sendFile?(channelId: string, filePath: string): Promise<void>;
  isGroupChat?(channelId: string): Promise<boolean>;
}

// 渠道配置选项
export interface ChannelOptions {
  systemPromptAppend?: string;      // Feishu: [SEND_FILE:] 指令
  fileMarkerPattern?: RegExp;       // Feishu: /\[SEND_FILE:([^\]]+)\]/g
  supportsImages?: boolean;         // Feishu: true, ACP: false
}

// 命令处理器类型
export type CommandHandler = (
  content: string,
  channel: 'feishu' | 'acp',
  channelId: string,
  userId?: string
) => Promise<string | null>;
