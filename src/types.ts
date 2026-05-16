// ── Channel config types ──
// Single-object form: `name` is optional (defaults to channel type name).
// Array form: `name` is required to distinguish instances.

export interface FeishuChannelConfig {
  name?: string;
  enabled?: boolean;
  appId: string;
  appSecret: string;
  owner?: string;
  admins?: string[];
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
  admins?: string[];
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
  gatewayUrl?: string;    // Gateway WebSocket URL（well-known 自动发现失败时的 fallback）
  accessToken?: string;   // 认证 access token（降级 fallback）
  owner?: string;
  admins?: string[];
  flushDelay?: number;  // flush 间隔(秒)，默认 3
  pythonBin?: string;   // Python 可执行路径（仅 evolclaw tui 命令使用），默认 python3
  encryptionSeed?: string; // FileSecretStore 加密种子，默认 evolclaw-aun-production-seed-2026
}

export interface AunChannelInstanceConfig extends AunChannelConfig {
  name: string;  // required in array form
}

export interface DingtalkChannelConfig {
  name?: string;
  enabled?: boolean;
  clientId: string;
  clientSecret: string;
  owner?: string;
  admins?: string[];
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
  requireMention?: boolean;       // default true — group chats require @mention
  freeResponseChats?: string[];   // conversationId whitelist (skip @mention gate)
}

export interface DingtalkChannelInstanceConfig extends DingtalkChannelConfig {
  name: string;
}

export interface QQBotChannelConfig {
  name?: string;
  enabled?: boolean;
  appId: string;
  clientSecret: string;
  owner?: string;
  admins?: string[];
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
}

export interface QQBotChannelInstanceConfig extends QQBotChannelConfig {
  name: string;
}

export interface WecomChannelConfig {
  name?: string;
  enabled?: boolean;
  botId: string;
  secret: string;
  owner?: string;
  admins?: string[];
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
}

export interface WecomChannelInstanceConfig extends WecomChannelConfig {
  name: string;
}

export interface Config {
  agents?: {
    claude?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'max';
      pathToClaudeCodeExecutable?: string; // Windows 上 SDK 找不到 claude 可执行体时手动指定
      useSettingSources?: boolean;        // 使用 SDK 原生配置加载，默认 true
      agentProgressSummaries?: boolean;   // 启用 AI 生成的子任务进度摘要，默认 true
      excludeDynamicSections?: boolean;   // 从 system prompt 移除动态内容以提升跨用户 prompt cache 命中率，默认 false
    };
    codex?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;     // 默认 'gpt-5.2-codex'
      effort?: string;    // 推理强度: low / medium / high / max
      reasoning?: string; // 别名（兼容旧配置）
    };
    gemini?: {
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
    dingtalk?: DingtalkChannelConfig | DingtalkChannelInstanceConfig[];
    qqbot?: QQBotChannelConfig | QQBotChannelInstanceConfig[];
    wecom?: WecomChannelConfig | WecomChannelInstanceConfig[];
  };
  projects?: {
    defaultPath: string;
    autoCreate?: boolean;
    list?: Record<string, string>;
  };
  enableRichContent?: boolean;  // 启用富内容渲染（LaTeX/Mermaid），默认 false
  flushDelay?: number;  // 消息批量发送间隔(秒)，默认 4
  debounce?: number;    // 入站消息去抖间隔(秒)，默认 2，设 0 关闭
  debug?: {
    logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';  // 日志级别，优先于 LOG_LEVEL 环境变量
    flusherDiag?: boolean;  // 启用 StreamFlusher 诊断日志 (flusher-diag.log)
    aunTrace?: boolean;     // 启用 AUN 通道数据追踪日志 (aun-trace.log)，记录所有收发数据
    aunSdkLog?: boolean;    // 启用 AUN SDK 内部日志 (~/.aun/logs/ts-sdk-YYYYMMDD.log)
  };
  idleMonitor?: {
    enabled?: boolean;              // 是否启用空闲监控，默认 true
    safeModeThreshold?: number;     // 连续错误几次进入安全模式，默认 0（已禁用）；设为正数启用
    timeout?: number;               // 无输出超时(秒)，默认 120
  };
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';  // 中间输出显示范围（工具活动+流式文本），默认 'all'
  chatmode?: {
    private?: 'interactive' | 'proactive';   // 单聊默认模式，默认 'interactive'
    group?: 'interactive' | 'proactive';     // 群聊默认模式，默认 'proactive'
  };
}

/** 错误字典规则 — 按数组顺序匹配，首条命中即决定行为 */
export interface ErrorRule {
  id: string;                              // 唯一标识，用于日志追踪
  match: string;                           // 字符串包含匹配（大小写不敏感）
  action: 'retry' | 'stop' | 'ignore';    // retry=可重试, stop=不可重试, ignore=静默忽略
  type?: string;                           // ErrorType 枚举值（可选，省略时按 action 推断）
  message?: string;                        // 用户提示（可选，覆盖默认消息）
}

export interface SessionMetadata {
  isActive?: boolean;  // 由 Channel 维护，存储在 metadata 中
  replyContext?: ReplyContext;       // 仅话题会话：创建时写入，用于 threadId 路由（不做 per-message 刷新）
  peerId?: string;                  // 私聊：对端 AID/userId；群聊：当前消息发送者 AID
  peerName?: string;                // 对端/发送者显示名
  groupId?: string;                 // 仅群聊：群 ID（如 AUN 的 group.issuer/grp_xxx）
  channelName?: string;             // 渠道实例名（审计/精确出站路由）
  agentSessions?: {
    codex?: string;
    gemini?: string;
  };
  permissionMode?: string;  // 权限模式（per-session）: auto | bypass | request | edit | plan | noask
  resumeAt?: string;  // /rewind chat 标记的回退点（assistant message uuid）
}

/** Default permission mode applied to new sessions. Change here to affect all roles. */
export const DEFAULT_PERMISSION_MODE = 'bypass';

export interface ReplyContext {
  sessionId?: string;
  threadId?: string;
  metadata?: Record<string, any>;
  title?: string;
  replyToMessageId?: string;
  mentionUserIds?: string[];
  replyInThread?: boolean;
  peerId?: string;  // 发送者 ID，出站时兜底 @ 补全用
}

export interface SessionIdentity {
  role: 'owner' | 'admin' | 'guest' | 'anonymous';
  mode: 'interactive' | 'autonomous';
}

export interface Session {
  id: string;
  channel: string;       // 实例名（如 'aun_main'、'aun-2'）
  channelType?: string;  // 类型（'aun' | 'feishu' | 'wechat' | 'dingtalk' | 'qqbot' | 'wecom'）；缺失时用 channel 做 fallback
  channelId: string;     // 路由键。AUN 私聊=peerAID；AUN 群聊=groupId；其它 channel=原 channelId
  selfId?: string;       // 本地身份（AUN: 本地 AID；飞书: bot_open_id 等）
  agentId: string;  // 路由维度，默认 'claude'
  threadId: string;  // 路由维度，默认 ''
  chatType: string;  // 'private' | 'group'，由 Channel 填充
  sessionMode: string;  // 'interactive' | 'proactive'（'autonomous' 预留未实现）
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
  channel: string;          // 实例名
  channelType?: string;     // 类型（aun/feishu/...）
  channelId: string;
  selfId?: string;  // 本地身份（AUN 本地 AID / 飞书 bot_open_id 等）
  agentId?: string;  // 默认 'claude'
  threadId?: string;  // 默认 ''
  chatType?: 'private' | 'group';  // 由 Channel 层填充
  peerId: string;  // 发送者 ID
  peerName?: string;  // 发送者名称
  peerType?: string;  // 对端类型 (human/ai/unknown)，由支持 agent.md 的渠道填充
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  messageId?: string;
  replyContext?: ReplyContext;       // Channel 预构建的回复上下文（渠道无关）
  timestamp?: number;
}

// 入站消息（渠道 → Gateway 的统一格式）
export interface InboundMessage {
  channel: string;          // 实例名
  channelType?: string;     // 类型
  channelId: string;
  selfId?: string;  // 本地身份（AUN 本地 AID / 飞书 bot_open_id 等）
  groupId?: string;  // 群聊：群 ID（仅 chatType==='group' 时有值）
  agentId?: string;  // 默认 'claude'
  threadId?: string;  // 默认 ''
  chatType: 'private' | 'group';  // 由 Channel 层填充
  peerId: string;  // 发送者 ID
  peerName?: string;  // 发送者名称
  peerType?: string;  // 对端类型 (human/ai/unknown)，由支持 agent.md 的渠道填充
  content: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  replyContext?: ReplyContext;       // Channel 预构建的回复上下文（渠道无关）
}

// ── 交互协议类型（渠道无关） ──

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

export type InteractionKind = ActionInteraction;

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
  sendProcessingStatus?(channelId: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout', sessionId: string, taskId: string, context?: ReplyContext): void;
  sendCustomPayload?(channelId: string, payload: string): void;
  uploadAgentMd?(content: string): Promise<void>;
  downloadAgentMd?(aid: string): Promise<string>;
  sendInteraction?(channelId: string, interaction: InteractionRequest, context?: ReplyContext): Promise<string | false>;
  patchInteractionCard?(messageId: string, card: object): Promise<void>;
  onInteraction?(callback: (response: InteractionResponse) => void): void;
  onChatDissolved?(callback: (channelId: string) => void): void;
  // 发送 thought（Proactive 模式可观测）
  // channelId: 群聊时为 groupId，私聊时为对方 AID
  // adapter 内部按 chatType 分发到 group.thought.put 或 message.thought.put
  /**
   * 发送 thought 内容
   * channelId 在群聊时为 groupId，私聊时为对方 AID
   * taskId 是任务唯一标识，同一次任务处理的所有 thought 共享同一 task_id
   * adapter 内部按 chatType 分发到 group.thought.put 或 message.thought.put
   */
  putThought?(channelId: string, taskId: string, payload: object, context?: ReplyContext): Promise<void>;
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

// ── EvolAgent ──

export interface EvolAgentConfig {
  name: string;
  enabled?: boolean;
  agents: Record<string, any>;
  channels: Record<string, any>;
  projects: { defaultPath: string; list?: Record<string, string>; autoCreate?: boolean };
  chatmode?: { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' };
}

/** Reserved agent name used for DefaultAgent (no agent.json file). */
export const DEFAULT_AGENT_NAME = '[default]';

export interface AgentContext {
  name: string;
  isOwned: boolean;
  baseagent: string;
  model?: string;
  effort?: string;
  chatMode: 'interactive' | 'proactive';
  projectPath: string;
}

export type AgentStatus = 'running' | 'stopped' | 'disabled' | 'error';

export interface AgentInfo {
  name: string;
  status: AgentStatus;
  channels: string[];
  projectPath: string;
  baseagent: string;
  model?: string;
  effort?: string;
  lastActivity?: number;
  activeSessions?: number;
  error?: string;
  isDefault?: boolean;
}

/**
 * Structural handle for EvolAgent — captures the surface needed by IpcServer,
 * MessageProcessor, and CommandHandler without importing the EvolAgent class
 * (avoids circular imports). The actual EvolAgent class satisfies this shape.
 */
export interface EvolAgentHandle {
  readonly name: string;
  readonly isDefault: boolean;
  readonly baseagent: string;
  readonly projectPath: string;
  lastActivity?: number;
  getContext(channelName: string, chatType: string, globalChatmode?: { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' }): AgentContext;
  getOwner(channelName: string): string | undefined;
  isOwner(channelName: string, userId: string): boolean;
  isAdmin(channelName: string, userId: string): boolean;
  setOwner(channelName: string, userId: string): void;
  getShowActivities(channelName: string): 'all' | 'dm-only' | 'owner-dm-only' | 'none';
  setShowActivities(channelName: string, mode: 'all' | 'dm-only' | 'owner-dm-only' | 'none'): void;
  setBaseagentModel(value: string | undefined): void;
  setBaseagentEffort(value: string | undefined): void;
  getProjects(): Record<string, string>;
  addProject(name: string, projectPath: string): void;
  channelInstanceNames(): string[];
}

/**
 * Structural handle for EvolAgentRegistry — captures the surface needed by IpcServer,
 * MessageProcessor, and CommandHandler without importing the EvolAgentRegistry class
 * (avoids circular imports). The actual EvolAgentRegistry class satisfies this shape.
 */
export interface EvolAgentRegistryHandle {
  resolveByChannel(channelName: string): EvolAgentHandle | null;
  get(name: string): EvolAgentHandle | null;
  list(): AgentInfo[];
  reload?(name: string, hooks: unknown): Promise<void>;
  isOwner(channelName: string, userId: string, globalFallback: (ch: string, uid: string) => boolean): boolean;
  isAdmin(channelName: string, userId: string, globalFallback: (ch: string, uid: string) => boolean): boolean;
  getOwner(channelName: string): string | undefined;
  setChannelOwner(channelName: string, userId: string): void;
  getShowActivities(channelName: string): 'all' | 'dm-only' | 'owner-dm-only' | 'none';
  setShowActivities(channelName: string, mode: 'all' | 'dm-only' | 'owner-dm-only' | 'none'): void;
}

// ── AUN AID Connection State ───────────────────────────────────────
// 单个 AID 在本进程内的连接状态。一个 EvolAgent 持有一个 AUNChannel，
// 一个 AUNChannel 对应一个 AID。多 agent 场景下每个 AID 都有自己的状态。
export type AidStatus =
  | 'connected'        // 已连接
  | 'reconnecting'     // 重连中（含 SDK 自动重连 + TS 层退避）
  | 'aid_blocked'      // 锁被别的进程持有，等待释放
  | 'kicked'           // server kicked，处于 5min 退避
  | 'failed'           // 启动 / auth 失败，处于 1min 退避
  | 'disabled';        // 配置禁用 / 未启动

export interface AidConnectionState {
  aid: string;
  agentName: string;            // EvolAgent 名（'[default]' / 'review-bot' / ...）
  channelName: string;          // channel 实例名
  status: AidStatus;
  reconnectCount: number;       // 累计重连次数（含 flap）
  flapCount: number;            // 当前未消化的 flap 计数
  lastAttemptAt?: number;       // 最近一次连接尝试时间戳
  lastConnectedAt?: number;     // 最近一次成功 connected 时间戳
  lastError?: string;           // 最近一次失败简述（≤ 80 字符）
  blockedBy?: {                 // 仅 aid_blocked 时填充
    pid: number;
    evolclawHome: string;
    agentName?: string;
  };
}
