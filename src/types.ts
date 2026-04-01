export interface Config {
  agents?: {
    anthropic?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'max';
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
  flushDelay?: number;  // 消息批量发送间隔(秒)，默认 4
  debug?: {
    flusherDiag?: boolean;  // 启用 StreamFlusher 诊断日志 (flusher-diag.log)
  };
  idleMonitor?: {
    enabled?: boolean;              // 是否启用空闲监控，默认 true
    safeModeThreshold?: number;     // 连续错误几次进入安全模式，默认 3；设为 0 关闭 safe mode
    timeout?: number;               // 无输出超时(秒)，默认 120
  };
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';  // 中间输出显示范围（工具活动+流式文本），默认 'all'
}

export interface SessionMetadata {
  replyOpts?: Record<string, any>;  // 渠道特定回复上下文（如 { rootId: 'om_xxx' }）
  agentSessions?: {
    codex?: string;
    gemini?: string;
  };
}

export interface ReplyContext {
  sessionId?: string;
  threadId?: string;
  metadata?: Record<string, any>;
  title?: string;
  replyToMessageId?: string;
  mentionUserIds?: string[];
  replyInThread?: boolean;
}

export interface SessionIdentity {
  role: 'owner' | 'guest' | 'anonymous';
  mode: 'interactive' | 'autonomous';
}

export interface Session {
  id: string;
  channel: string;
  channelId: string;
  projectPath: string;
  threadId: string;
  agentType: string;
  agentSessionId?: string;
  metadata?: SessionMetadata;
  identity?: SessionIdentity;
  name?: string;
  isGroup?: boolean;  // 会话创建时由 Channel 提供，持久化到数据库
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;  // 软删除时间戳（null=活跃）
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
  threadId?: string;
}

// 入站消息（渠道 → Gateway 的统一格式）
export interface InboundMessage {
  channel: string;
  channelId: string;
  content: string;
  userId?: string;
  userName?: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  threadId?: string;
  isGroup?: boolean;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  replyOpts?: Record<string, any>;  // 渠道特定回复上下文（如 Feishu 的 rootId）
}

// 渠道适配器接口
export interface ChannelAdapter {
  readonly name: string;
  sendText(channelId: string, text: string, context?: ReplyContext): Promise<void>;
  sendFile?(channelId: string, filePath: string): Promise<void>;
  isGroupChat?(channelId: string): Promise<boolean>;
  acknowledge?(messageId: string): Promise<void>;
  onChatDissolved?(callback: (channelId: string) => void): void;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
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
  userId?: string,
  threadId?: string
) => Promise<string | null>;
