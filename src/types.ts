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
  aun: {
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
  idleMonitor?: {
    enabled?: boolean;              // 是否启用空闲监控，默认 true
    safeModeThreshold?: number;     // 连续错误几次进入安全模式，默认 3；设为 0 关闭 safe mode
  };
  sdk?: {
    useSettingSources?: boolean;        // 使用 SDK 原生配置加载，默认 true
    agentProgressSummaries?: boolean;   // 启用 AI 生成的子任务进度摘要，默认 true
  };
  owners?: {
    feishu?: string;
    aun?: string;
  };
}

export interface Session {
  id: string;
  channel: 'feishu' | 'aun';
  channelId: string;
  projectPath: string;
  claudeSessionId?: string;
  name?: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  channel: 'feishu' | 'aun';
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
  supportsImages?: boolean;         // Feishu: true, AUN: false
}

// 命令处理器类型
export type CommandHandler = (
  content: string,
  channel: 'feishu' | 'aun',
  channelId: string,
  userId?: string
) => Promise<string | null>;
