export interface Config {
  anthropic: {
    apiKey: string;
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
}

export interface Session {
  id: string;
  channel: 'feishu' | 'acp';
  channelId: string;
  projectPath: string;
  claudeSessionId?: string;
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
}

// 渠道适配器接口
export interface ChannelAdapter {
  readonly name: 'feishu' | 'acp';
  sendText(channelId: string, text: string): Promise<void>;
  sendFile?(channelId: string, filePath: string): Promise<void>;
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
  channelId: string
) => Promise<string | null>;
