export interface Config {
  agents?: {
    anthropic?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      useSettingSources?: boolean;        // 使用 SDK 原生配置加载，默认 true
      agentProgressSummaries?: boolean;   // 启用 AI 生成的子任务进度摘要，默认 true
    };
  };
  channels?: {
    feishu?: {
      enabled?: boolean;
      appId: string;
      appSecret: string;
      owner?: string;
    };
    wechat?: {
      enabled?: boolean;
      baseUrl?: string;
      token?: string;
      owner?: string;
    };
    aun?: {
      enabled?: boolean;
      domain: string;
      agentName: string;
      owner?: string;
    };
  };
  projects?: {
    defaultPath: string;
    autoCreate: boolean;
    list?: Record<string, string>;
  };
  flushDelay?: number;  // 消息批量发送间隔(ms)，默认 4000
  idleMonitor?: {
    enabled?: boolean;              // 是否启用空闲监控，默认 true
    safeModeThreshold?: number;     // 连续错误几次进入安全模式，默认 3；设为 0 关闭 safe mode
    timeout?: number;               // 无输出超时(ms)，默认 120000
  };
}

export interface Session {
  id: string;
  channel: string;
  channelId: string;
  projectPath: string;
  claudeSessionId?: string;
  name?: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  channel: string;
  channelId: string;
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  timestamp?: number;
  userId?: string;
  userName?: string;
  messageId?: string;
  isGroup?: boolean;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
}

// 渠道适配器接口
export interface ChannelAdapter {
  readonly name: string;
  sendText(channelId: string, text: string, options?: { title?: string; replyToMessageId?: string; mentionUserIds?: string[] }): Promise<void>;
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
  channel: string,
  channelId: string,
  userId?: string
) => Promise<string | null>;
