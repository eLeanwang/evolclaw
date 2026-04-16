// ── Channel config types ──
// Single-object form: `name` is optional (defaults to channel type name).
// Array form: `name` is required to distinguish instances.

export interface FeishuChannelConfig {
  name?: string;
  enabled?: boolean;
  appId: string;
  appSecret: string;
  owner?: string;
  flushDelay?: number;  // flush 间隔(秒)，默认使用全局值
  debounce?: number;    // 入站消息去抖间隔(秒)，覆盖全局 debounce
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';  // 覆盖全局 showActivities
}

export interface FeishuChannelInstanceConfig extends FeishuChannelConfig {
  name: string;  // required in array form
}

export interface WechatChannelConfig {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  token?: string;
  owner?: string;
  flushDelay?: number;  // flush 间隔(秒)，默认 3
  debounce?: number;    // 入站消息去抖间隔(秒)，覆盖全局 debounce
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';  // 覆盖全局 showActivities
}

export interface WechatChannelInstanceConfig extends WechatChannelConfig {
  name: string;  // required in array form
}

export interface AunChannelConfig {
  name?: string;
  enabled?: boolean;
  aid: string;            // 完整 AID，如 evolclaw-ai.agentid.pub
  keystorePath?: string;  // AUN keystore 路径，默认 ~/.aun
  gatewayPort?: number;   // Gateway 端口，默认 443（域名从 AID 推导）
  gatewayUrl?: string;    // Gateway WebSocket URL（兼容旧配置，优先级高于 gatewayPort）
  accessToken?: string;   // 认证 access token（降级 fallback）
  owner?: string;
  flushDelay?: number;  // flush 间隔(秒)，默认 3
  pythonBin?: string;   // Python 可执行路径（仅 evolclaw tui 命令使用），默认 python3
  encryptionSeed?: string; // FileSecretStore 加密种子，默认 evolclaw-aun-production-seed-2026
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';  // 覆盖全局 showActivities
}

export interface AunChannelInstanceConfig extends AunChannelConfig {
  name: string;  // required in array form
}

export interface Config {
  agents?: {
    anthropic?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'max';
      useSettingSources?: boolean;        // 使用 SDK 原生配置加载，默认 true
      agentProgressSummaries?: boolean;   // 启用 AI 生成的子任务进度摘要，默认 true
      excludeDynamicSections?: boolean;   // 从 system prompt 移除动态内容以提升跨用户 prompt cache 命中率，默认 false
    };
    openai?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;     // 默认 'gpt-5.2-codex'
      effort?: string;    // 推理强度: low / medium / high / max
      reasoning?: string; // 别名（兼容旧配置）
    };
    google?: {
      apiKey?: string;       // GEMINI_API_KEY（可选，CLI 有 OAuth）
      model?: string;        // 默认 'gemini-2.5-flash'
      cliPath?: string;      // gemini CLI 路径（可选，默认 PATH 查找）
      mode?: 'cli' | 'sdk';  // 运行模式，默认 'cli'
      useVertex?: boolean;   // 是否使用 Vertex AI
      project?: string;      // Vertex AI 项目 ID
      location?: string;     // Vertex AI 区域，如 'us-central1'
    };
    defaultAgent?: string;  // 默认 'claude'
  };
  channels?: {
    defaultChannel?: string;  // 默认渠道，完整性校验锚点
    feishu?: FeishuChannelConfig | FeishuChannelInstanceConfig[];
    wechat?: WechatChannelConfig | WechatChannelInstanceConfig[];
    aun?: AunChannelConfig | AunChannelInstanceConfig[];
  };
  projects?: {
    defaultPath: string;
    autoCreate: boolean;
    list?: Record<string, string>;
  };
  enableRichContent?: boolean;  // 启用富内容渲染（LaTeX/Mermaid），默认 false
  flushDelay?: number;  // 消息批量发送间隔(秒)，默认 4
  debounce?: number;    // 入站消息去抖间隔(秒)，默认 2，设 0 关闭
  debug?: {
    flusherDiag?: boolean;  // 启用 StreamFlusher 诊断日志 (flusher-diag.log)
    aunTrace?: boolean;     // 启用 AUN 通道数据追踪日志 (aun-trace.log)，记录所有收发数据
  };
  idleMonitor?: {
    enabled?: boolean;              // 是否启用空闲监控，默认 true
    safeModeThreshold?: number;     // 连续错误几次进入安全模式，默认 3；设为 0 关闭 safe mode
    timeout?: number;               // 无输出超时(秒)，默认 120
    connectionTimeout?: number;     // 连接阶段超时(秒)，默认 30；query() 调用到流开始前的最大等待
  };
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';  // 中间输出显示范围（工具活动+流式文本），默认 'all'
}

export interface SessionMetadata {
  isActive?: boolean;  // 由 Channel 维护，存储在 metadata 中
  replyContext?: ReplyContext;       // Channel 预构建的回复上下文（渠道无关）
  peerId?: string;                  // 私聊时存发送者 ID，用于跨通道文件投递查 channelId
  peerName?: string;                // 私聊时存发送者名称
  channelName?: string;             // 渠道实例名（审计/精确出站路由）
  agentSessions?: {
    codex?: string;
    gemini?: string;
  };
  permissionMode?: string;  // 权限模式（per-session）: auto | bypass | request | edit | plan | noask
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
  agentId: string;  // 路由维度，默认 'claude'
  threadId: string;  // 路由维度，默认 ''
  chatType: string;  // 'private' | 'group'，由 Channel 填充
  sessionMode: string;  // 'interactive' | 'autonomous'
  projectPath: string;
  agentSessionId?: string;
  name?: string;
  processingState?: string;  // null=空闲, 'processing'=处理中（含时间戳）
  metadata?: SessionMetadata;
  identity?: SessionIdentity;  // 运行时计算，不持久化
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;  // 软删除时间戳（null=活跃）
}

export interface Message {
  channel: string;
  channelId: string;
  agentId?: string;  // 默认 'claude'
  threadId?: string;  // 默认 ''
  chatType?: 'private' | 'group';  // 由 Channel 层填充
  peerId: string;  // 发送者 ID
  peerName?: string;  // 发送者名称
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  messageId?: string;
  replyContext?: ReplyContext;       // Channel 预构建的回复上下文（渠道无关）
  timestamp?: number;
}

// 入站消息（渠道 → Gateway 的统一格式）
export interface InboundMessage {
  channel: string;
  channelId: string;
  agentId?: string;  // 默认 'claude'
  threadId?: string;  // 默认 ''
  chatType: 'private' | 'group';  // 由 Channel 层填充
  peerId: string;  // 发送者 ID
  peerName?: string;  // 发送者名称
  content: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  replyContext?: ReplyContext;       // Channel 预构建的回复上下文（渠道无关）
}

// ── 交互协议类型（渠道无关） ──

interface FieldBase {
  type: string;
  key: string;
  label: string;
  hint?: string;
}

export interface TextField extends FieldBase {
  type: 'text';
  placeholder?: string;
  defaultValue?: string;
  validation?: 'text' | 'number' | 'path';
  required?: boolean;
}

export interface SelectField extends FieldBase {
  type: 'select';
  placeholder?: string;
  options: Array<{
    value: string;
    label: string;
    description?: string;
    selected?: boolean;
  }>;
  required?: boolean;
}

export interface MultiSelectField extends FieldBase {
  type: 'multi-select';
  options: Array<{
    value: string;
    label: string;
    selected?: boolean;
  }>;
  minSelect?: number;
  maxSelect?: number;
}

export interface ToggleField extends FieldBase {
  type: 'toggle';
  defaultValue?: boolean;
}

export type InteractionField = TextField | SelectField | MultiSelectField | ToggleField;

export interface ActionInteraction {
  kind: 'action';
  title: string;
  body?: string;
  buttons: Array<{
    key: string;
    label: string;
    style?: 'primary' | 'danger' | 'default';
    confirm?: {
      title: string;
      body: string;
    };
  }>;
}

export interface FormInteraction {
  kind: 'form';
  title: string;
  body?: string;
  fields: InteractionField[];
  submitLabel?: string;
  submitStyle?: 'primary' | 'danger';
  submitConfirm?: {
    title: string;
    body: string;
  };
  cancelable?: boolean;
}

export interface MenuInteraction {
  kind: 'menu';
  groups: Array<{
    group: string;
    items: Array<{
      key: string;
      label: string;
      args?: string;
      interaction?: 'form' | 'confirm';
    }>;
  }>;
}

export type InteractionKind = ActionInteraction | FormInteraction | MenuInteraction;

export interface InteractionRequest {
  type: 'interaction';
  id: string;
  channelId: string;
  sessionId: string;
  expiresAt?: number;
  kind: InteractionKind;
}

export interface InteractionResponse {
  type: 'interaction.response';
  id: string;
  action: string;
  values?: Record<string, unknown>;
  operatorId?: string;
}

// 渠道适配器接口
export interface ChannelAdapter {
  readonly channelName: string;
  sendText(channelId: string, text: string, context?: ReplyContext): Promise<void>;
  sendFile?(channelId: string, filePath: string, context?: ReplyContext): Promise<void>;
  sendImage?(channelId: string, png: Buffer, context?: ReplyContext): Promise<void>;
  acknowledge?(messageId: string): Promise<void>;
  sendProcessingStatus?(channelId: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout', sessionId: string, context?: ReplyContext): void;
  sendCustomPayload?(channelId: string, payload: string): void;
  sendInteraction?(channelId: string, interaction: InteractionRequest, context?: ReplyContext): Promise<string | false>;
  patchInteractionCard?(messageId: string, card: object): Promise<void>;
  onInteraction?(callback: (response: InteractionResponse) => void): void;
  onChatDissolved?(callback: (channelId: string) => void): void;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}

// 渠道配置选项
export interface ChannelOptions {
  channelType?: string;             // 渠道类型（第一级），多实例时与 adapter.channelName 不同
  systemPromptAppend?: string;      // 渠道专属系统提示追加
  fileMarkerPattern?: RegExp;       // Feishu: /\[SEND_FILE:([^\]]+)\]/g
  supportsImages?: boolean;         // Feishu: true, AUN: false
  flushDelay?: number;              // 渠道级 flush 间隔(秒)，覆盖全局 config.flushDelay
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';  // 覆盖全局 showActivities
}

// 渠道策略接口
export interface ChannelPolicy {
  canSwitchProject(chatType: string, identity: string): boolean;
  canListProjects(chatType: string, identity: string): boolean;
  canCreateSession(chatType: string, identity: string): boolean;
  canDeleteSession(chatType: string, identity: string): boolean;
  canImportCliSession(chatType: string, identity: string): boolean;
  messagePrefix(chatType: string, peerName?: string): string;
  showMiddleResult(chatType: string, identity: string): boolean;
  showIdleMonitor(chatType: string, identity: string): boolean;
  accumulateErrors(chatType: string, identity: string): boolean;
}

// 命令处理器类型
export type CommandHandler = (
  content: string,
  channel: string,
  channelId: string,
  userId?: string,
  threadId?: string
) => Promise<string | null | undefined>;
