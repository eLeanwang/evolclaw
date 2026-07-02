// ── Channel config types ──
// Single-object form: `name` is optional (defaults to channel type name).
// Array form: `name` is required to distinguish instances.

export type PermissionMode = 'auto' | 'bypass' | 'readonly' | 'plan' | 'edit' | 'request' | 'noask';

export interface FeishuChannelConfig {
  name?: string;
  enabled?: boolean;
  appId: string;
  appSecret: string;
  flushDelay?: number;  // flush 间隔(秒)，默认使用全局值
  debounce?: number;    // 入站消息去抖间隔(秒)，覆盖全局 debounce
  showActivities?: 'all' | 'none';  // 覆盖全局 showActivities
}

export interface FeishuChannelInstanceConfig extends FeishuChannelConfig {
  name: string;  // required in array form
}

export interface WechatChannelConfig {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  token?: string;
  flushDelay?: number;  // flush 间隔(秒)，默认 3
  debounce?: number;    // 入站消息去抖间隔(秒)，覆盖全局 debounce
  showActivities?: 'all' | 'none';  // 覆盖全局 showActivities
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
  flushDelay?: number;  // flush 间隔(秒)，默认 3
  pythonBin?: string;   // Python 可执行路径（仅 evolclaw tui 命令使用），默认 python3
  encryptionSeed?: string; // FileSecretStore 加密种子，留空时 SDK 自动从 {aun_path}/.seed 派生
}

export interface AunChannelInstanceConfig extends AunChannelConfig {
  name: string;  // required in array form
}

export interface DingtalkChannelConfig {
  name?: string;
  enabled?: boolean;
  clientId: string;
  clientSecret: string;
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'none';
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
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'none';
}

export interface QQBotChannelInstanceConfig extends QQBotChannelConfig {
  name: string;
}

export interface WecomChannelConfig {
  name?: string;
  enabled?: boolean;
  botId: string;
  secret: string;
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'none';
}

export interface WecomChannelInstanceConfig extends WecomChannelConfig {
  name: string;
}

/**
 * Config —— baseagent runner / resolver 兼容类型。
 *
 * 新结构下不再有全局 config 文件；此类型仅作为 baseagent resolver
 * （resolveAnthropicConfig 等）和各 runner 的 syntheticConfig 输入形态，
 * 字段来自 EvolAgent.config.baseagents 的翻译。
 *
 * 注意：channel plugin 已不再依赖本类型（改吃 ChannelInstance + ChannelBuildContext）。
 * 残留的 channels 字段仅为历史兼容，channel 路径不再读取。
 */
export interface Config {
  agents?: {
    claude?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      pathToClaudeCodeExecutable?: string;
      useSettingSources?: boolean;
      agentProgressSummaries?: boolean;
      excludeDynamicSections?: boolean;
      evolclawAgentAid?: string;
      evolclawAgentConfig?: AgentConfig | EffectiveAgentConfig;
    };
    codex?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      effort?: string;
      enableRequestUserInput?: boolean;
      approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent';
      evolclawAgentAid?: string;
      evolclawAgentConfig?: AgentConfig | EffectiveAgentConfig;
    };
    gemini?: {
      apiKey?: string;
      model?: string;
      cliPath?: string;
      mode?: 'cli' | 'sdk';
      useVertex?: boolean;
      project?: string;
      location?: string;
    };
    defaultAgent?: string;
  };
  channels?: {
    defaultChannel?: string;
    feishu?: FeishuChannelConfig | FeishuChannelInstanceConfig[];
    wechat?: WechatChannelConfig | WechatChannelInstanceConfig[];
    aun?: AunChannelConfig | AunChannelInstanceConfig[];
    dingtalk?: DingtalkChannelConfig | DingtalkChannelInstanceConfig[];
    qqbot?: QQBotChannelConfig | QQBotChannelInstanceConfig[];
    wecom?: WecomChannelConfig | WecomChannelInstanceConfig[];
  };
  projects?: {
    defaultPath: string;
  };
  debug?: {
    logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    flusherDiag?: boolean;
    aunTrace?: boolean;
    aunSdkLog?: boolean;
  };
  enableRichContent?: boolean;
  idleMonitor?: {
    enabled?: boolean;
    safeModeThreshold?: number;
    timeout?: number;
  };
  showActivities?: 'all' | 'none';
  flushDelay?: number;
  debounce?: number;
  chatmode?: {
    private?: 'interactive' | 'proactive';
    group?: 'interactive' | 'proactive';
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
  groupName?: string;               // 仅群聊：群显示名（首次群会话经 group.get 取得后缓存，渲染信封用）
  channelKey?: string;             // 完整 channelKey（<type>#<selfAID>#<name>，审计/精确出站路由）
  agentSessions?: {
    codex?: string;
    gemini?: string;
  };
  permissionMode?: string;  // 权限模式（per-session）: auto | bypass | readonly | request | edit | plan | noask
  dispatchMode?: string;           // 群聊分发模式缓存（服务器下发值，per-session）: mention | broadcast
  dispatchModeOverride?: string;   // 用户 /dispatch 命令写入的显式覆盖；undefined = 跟随服务器
  resumeAt?: string;  // /rewind chat 标记的回退点（assistant message uuid）
}

/** Default permission mode applied when no role/relation policy overrides it. */
export const DEFAULT_PERMISSION_MODE = 'auto';

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
  role: string;
  mode: 'interactive';
}

export interface Session {
  id: string;
  channel: string;       // 实例名（如 'aun_main'、'aun-2'）
  channelType?: string;  // 类型（'aun' | 'feishu' | 'wechat' | 'dingtalk' | 'qqbot' | 'wecom'）；缺失时用 channel 做 fallback
  channelId: string;     // 路由键。AUN 私聊=peerAID；AUN 群聊=groupId；其它 channel=原 channelId
  selfAID?: string;        // 本地身份（agent AID）；非 aun 渠道可为空
  baseagent: string;  // 路由维度，如 'claude'、'codex'、'gemini'
  threadId: string;  // 路由维度，默认 ''
  sessionKey: string;  // agent 内部会话路由键 (channelType#urlEncode(channelId)#urlEncode(threadId))
  chatType: string;  // 'private' | 'group'，由 Channel 填充
  chatMode: string;  // 'interactive' | 'proactive'
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

/**
 * 一条子消息渲染所需的最小信息。批量合并时每条保留自己的发送者与时刻，
 * 供消息渲染层逐条渲染。
 */
export interface SubMessage {
  peerId?: string;
  peerName?: string;
  peerType?: string;
  /** 入队时解析到的发送者权限角色。群聊批量合并后逐条保留，避免用批次顶层 role 覆盖所有发言。 */
  peerRole?: SessionIdentity['role'];
  /** 对端网络邻近性（SDK 0.4.9 起明文/密文消息均可携带，具体字段以网关下发为准；逐条保留以支持群聊批量逐条渲染）*/
  sameDevice?: boolean;
  sameNetwork?: boolean;
  sameEgressIp?: boolean;
  /** 本条入站消息是否端到端加密（仅 aun 渠道有意义；非 aun 渠道恒 undefined）。逐条保留以支持群聊批量逐条渲染加密标注。 */
  encrypted?: boolean;
  content: string;
  timestamp?: number;
  images?: Array<{ data: string; mimeType: string }>;
  /** 本条被 @ 的全部 AID（含 self；@all 时含字面 "all"）。仅供消息信封渲染，与过滤/回复用的 mentions 独立。 */
  mentionAids?: string[];
  /**
   * 子消息类别。缺省（普通对端消息）走 private/group 渲染模式；
   * 'owner-hint' 为观察者插话提示，走 inject 渲染模式（owner 信封头）。
   * 'restart-resume' 为队列恢复提示，仍走普通信封渲染，但处理器会用它切分 pending 插入段。
   * 详见 docs/observer-insert-design.md 第二部分。
   */
  kind?: 'owner-hint' | 'restart-resume';
  /** owner-hint 专用：提示发出时间（epoch ms），渲染成信封头 {{injectTime}}。 */
  injectTime?: number;
  /** owner-hint 专用：提示来源 owner AID。 */
  ownerAid?: string;
}

export interface Message {
  channel: string;          // 实例名
  channelType?: string;     // 类型（aun/feishu/...）
  channelId: string;
  selfAID?: string;  // 本地身份（agent AID）
  baseagent?: string;  // 如 'claude'、'codex'、'gemini'
  threadId?: string;  // 默认 ''
  topicName?: string;  // 话题会话创建时的显示名
  chatType?: 'private' | 'group';  // 由 Channel 层填充
  peerId: string;  // 发送者 ID
  peerName?: string;  // 发送者名称
  peerType?: string;  // 对端类型 (human/ai/unknown)，由支持 agent.md 的渠道填充
  /** 对端网络邻近性（SDK 0.4.9 起明文/密文消息均可携带，具体字段以网关下发为准）*/
  sameDevice?: boolean;   // 对端与本端同一物理设备
  sameNetwork?: boolean;  // 对端与本端同一网络
  sameEgressIp?: boolean; // 对端与本端同一出口 IP
  /** 本条入站消息是否端到端加密（仅 aun 渠道有意义；非 aun 渠道恒 undefined）。回复加密态跟随此值。 */
  encrypted?: boolean;
  /** 对端使用的客户端类型；来自入站消息信封，由 channel 适配层填充。当前阶段先 undefined。 */
  clientType?: 'desktop' | 'web' | 'mobile' | string;
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  /** 本条被 @ 的全部 AID（含 self；@all 时含字面 "all"）。仅供消息信封渲染。 */
  mentionAids?: string[];
  /** 是否 @ 了本 agent（群聊场景）。由 Channel 标记，响应模式据此判断是否响应。 */
  isMentioned?: boolean;
  messageId?: string;
  /** 队列批量合并时的批次 role。仅当批内 role 完全一致时设置；逐条 role 见 SubMessage.peerRole。 */
  batchRole?: SessionIdentity['role'];
  /**
   * 批量合并时保留的逐条子消息（每条带自己的发送者与时刻）。
   * 队列贪心合并多条消息后挂在这里；消息渲染层逐条渲染再组装。
   * 单条消息可不设（渲染层退回 content）。
   */
  items?: SubMessage[];
  /**
   * 队列重启恢复标记。
   * submitted=true 表示该消息来自重启前已提交给 runner 的 active batch，
   * 只能用恢复提示继续，不应重放原始 active 内容。
   * pendingInterrupted=true 表示恢复提示后面拼接了仍处于 queued 的新消息，
   * 渲染层只把 pending 部分包进“新消息插入”提示。
   */
  restartResume?: { submitted: true; pendingInterrupted?: boolean };
  replyContext?: ReplyContext;       // Channel 预构建的回复上下文（渠道无关）
  dispatchMode?: string;            // 群聊分发模式，由渠道适配器从服务器信封解析后注入（mention|broadcast）
  timestamp?: number;
  source?: 'user' | 'card-trigger' | 'trigger' | 'owner-inject';
  triggerMeta?: {
    triggerId: string;
    runId?: string;
    triggerName?: string;
    fireTime?: number;
    boundSessionId?: string;
    pendingThread?: boolean;
    rootMessageId?: string;
    chatModeOverride?: 'proactive';
    modelOverride?: string;
    effortOverride?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    permissionModeOverride?: PermissionMode;
  };
}

// 入站消息（渠道 → Gateway 的统一格式）
export interface InboundMessage {
  channel: string;          // 实例名
  channelType?: string;     // 类型
  channelId: string;
  selfAID?: string;  // 本地身份（agent AID）
  groupId?: string;  // 群聊：群 ID（仅 chatType==='group' 时有值）
  baseagent?: string;  // 如 'claude'、'codex'、'gemini'
  threadId?: string;  // 默认 ''
  topicName?: string;  // 话题会话创建时的显示名
  chatType: 'private' | 'group';  // 由 Channel 层填充
  peerId: string;  // 发送者 ID
  peerName?: string;  // 发送者名称
  peerType?: string;  // 对端类型 (human/ai/unknown)，由支持 agent.md 的渠道填充
  sameDevice?: boolean;
  sameNetwork?: boolean;
  sameEgressIp?: boolean;
  /** 本条入站消息是否端到端加密（仅 aun 渠道有意义；非 aun 渠道恒 undefined）。回复加密态跟随此值。 */
  encrypted?: boolean;
  content: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  /** 本条被 @ 的全部 AID（含 self；@all 时含字面 "all"）。仅供消息信封渲染。 */
  mentionAids?: string[];
  replyContext?: ReplyContext;       // Channel 预构建的回复上下文（渠道无关）
  dispatchMode?: string;            // 群聊分发模式（mention|broadcast）
  source?: 'user' | 'card-trigger';  // 消息来源：用户输入 / 卡片按钮触发
  /** 来自控制 AID channel（evolclaw.json.aid）。控制面入口拥有全量权限（进程级 + 跨 agent），
   *  由 index.ts 的 controlChannel.onMessage 在构造 InboundMessage 时注入。普通 agent channel 不设。 */
  isControlChannel?: boolean;
}

// ── 交互协议类型（渠道无关） ──

export interface CommandCard {
  kind: 'command-card';
  title: string;
  body?: string;
  buttons: Array<{
    label: string;
    command: string;
    style?: 'primary' | 'danger' | 'default';
    disabled?: boolean;
    confirm?: {
      title: string;
      body: string;
    };
  }>;
}

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
  checkers?: Array<{ key: string; label: string; description?: string }>;
  allowCustomInput?: boolean;
}

export type InteractionKind = CommandCard | ActionInteraction;

export interface InteractionFallback {
  command: string;
  buttonArgMap?: Record<string, string>;
  acceptFreeText?: boolean;
  freeTextHint?: string;
}

export interface InteractionRequest {
  type: 'interaction';
  id: string;
  channelId: string;
  sessionId: string;
  initiatorId?: string;
  expiresAt?: number;
  kind: InteractionKind;
  fallback?: InteractionFallback;
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
  readonly channelKey: string;  // 完整的 channel key: <type>#<selfAID>#<name>
  /** 渠道能力声明 */
  readonly capabilities: ChannelCapabilities;
  /** 统一出站入口，按 OutboundPayload.kind 分发 */
  send(envelope: OutboundEnvelope, payload: OutboundPayload): Promise<void>;

  /** 入站回调 */
  acknowledge?(messageId: string): Promise<void>;
  /** Runner 开始执行时调用：将收件确认（Pin）升级为处理中确认（CheckMark） */
  promoteAck?(messageId: string): Promise<void>;
  onInteraction?(callback: (response: InteractionResponse) => void): void;
  onChatDissolved?(callback: (channelId: string) => void): void;

  /** 连接管理 */
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;

  /** AUN 协议私有扩展 */
  uploadAgentMd?(content: string): Promise<void>;
  downloadAgentMd?(aid: string): Promise<string>;
  /** 群显示名解析（渠道私有，AUN 经 group.get；进程内缓存）。取不到返回 undefined，绝不抛出阻塞消息处理。 */
  getGroupName?(groupId: string): Promise<string | undefined>;
  /** 查询某成员在群里的角色（AUN 经 group.get_admins）。
   *  返回 'owner'|'admin'|'member'；非成员返回 'none'；查询失败返回 undefined（调用方按 fail-closed 处理）。
   *  不缓存：每次查权威源，结果天然最新。绝不抛出。 */
  getGroupMemberRole?(groupId: string, aid: string): Promise<'owner' | 'admin' | 'member' | 'none' | undefined>;
}

// 渠道配置选项
export interface ChannelOptions {
  channelType?: string;             // 渠道类型（第一级），多实例时与 adapter.channelName 不同
  systemPromptAppend?: string;      // 渠道专属系统提示追加
  fileMarkerPattern?: RegExp;       // Feishu: /\[SEND_FILE:([^\]]+)\]/g
  supportsImages?: boolean;         // Feishu: true, AUN: false
  flushDelay?: number;              // 渠道级 flush 间隔(秒)，覆盖全局 config.flushDelay
  showActivities?: 'all' | 'none';  // 覆盖全局 showActivities
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
) => Promise<OutboundPayload | string | null | undefined>;

// ── EvolAgent ──

export interface EvolAgentConfig {
  name: string;
  enabled?: boolean;
  agents: Record<string, any>;
  channels: Record<string, any>;
  projects: { defaultPath: string };
  chatmode?: { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' };
}

/** Placeholder agent name for legacy code paths that haven't been migrated. */
export const DEFAULT_AGENT_NAME = '<unknown>';

/**
 * 进程级全局设置——不属于任何 self-agent，属于 evolclaw 进程本身。
 * 从 defaults.json 或环境变量取，运行期不变。
 */
export interface GlobalSettings {
  idleMonitor?: {
    enabled?: boolean;
    timeout?: number;
  };
  debug?: {
    logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    flusherDiag?: boolean;
    aunTrace?: boolean;
    aunSdkLog?: boolean;
  };
  chatmode?: { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' };
}

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
  /** agent.md 里的友好名（本地缓存优先，缺失时异步从网络拉取）；无则回退 aid 短名 */
  displayName?: string;
  /** personal/persona.md 里 "我叫**名字**" 提取的个人名 */
  personalName?: string;
  aid: string;
  status: AgentStatus;
  channels: string[];
  projectPath: string;
  baseagent: string;
  model?: string;
  effort?: string;
  owners: string[];
  lastActivity?: number;
  activeSessions?: number;
  error?: string;
  /** 单聊场景下的响应模式 ID（如 'interactive'） */
  responseModePrivate?: string;
  /** 群聊场景下的响应模式 ID（如 'proactive'） */
  responseModeGroup?: string;
}

/**
 * Structural handle for EvolAgent — captures the surface needed by IpcServer,
 * MessageProcessor, and CommandHandler without importing the EvolAgent class
 * (avoids circular imports). The actual EvolAgent class satisfies this shape.
 */
export interface EvolAgentHandle {
  readonly aid: string;
  readonly name: string;
  readonly baseagent: string;
  readonly projectPath: string;
  readonly config: EffectiveAgentConfig;
  lastActivity?: number;
  getContext(channelName: string, chatType: string, globalChatmode?: { private?: 'interactive' | 'proactive'; group?: 'interactive' | 'proactive' }): AgentContext;
  getShowActivities(channelName: string): 'all' | 'none';
  setShowActivities(channelName: string, mode: 'all' | 'none'): void;
  setActiveBaseagent(value: string | undefined): void;
  setLifecycle(value: AgentLifecycle): void;
  setBaseagentModel(value: string | undefined, baseagentName?: string): void;
  setBaseagentEffort(value: string | undefined, baseagentName?: string): void;
  setChatmodePrivate(value: 'interactive' | 'proactive' | undefined): void;
  setDispatch(value: 'mention' | 'broadcast' | undefined): void;
  getObservable(): boolean;
  setObservable(value: boolean): void;
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
  stopAgent?(name: string, hooks: unknown): Promise<void>;
  startAgent?(name: string, hooks: unknown): Promise<void>;
  getShowActivities(channelName: string): 'all' | 'none';
  setShowActivities(channelName: string, mode: 'all' | 'none'): void;
  invalidateAgentDisplayCache?(aid: string): void;
}

// ── AUN AID Connection State ───────────────────────────────────────
// 单个 AID 在本进程内的连接状态。一个 EvolAgent 持有一个 AUNChannel，
// 一个 AUNChannel 对应一个 AID。多 agent 场景下每个 AID 都有自己的状态。
export type AidStatus =
  | 'connected'        // 已连接
  | 'reconnecting'     // 重连中（含 SDK 自动重连 + TS 层退避）
  | 'aid_blocked'      // 锁被别的进程持有，等待释放
  | 'kicked'           // server kicked，处于退避重试中
  | 'kicked_no_retry'  // server kicked，不再重试（被挤掉 / AID 无效 / ACL 拒绝）
  | 'failed'           // 启动 / auth 失败，处于 1min 退避
  | 'disabled';        // 配置禁用 / 未启动

export interface AidKickDetail {
  code: number;
  reason: string;
  ts: number;
  evictedBy?: { aid?: string; deviceId?: string; slotId?: string; app?: string; hostname?: string };
  quotaKind?: string;
  limit?: number;
  selfExtra?: Record<string, unknown>;
  newExtra?: Record<string, unknown>;
}

export interface AidConnectionState {
  aid: string;
  agentName: string;            // EvolAgent AID（如 'review-bot.agentid.pub'）
  channelName: string;          // channel 实例名
  status: AidStatus;
  reconnectCount: number;       // 累计重连次数（含 flap）
  flapCount: number;            // 当前未消化的 flap 计数
  lastAttemptAt?: number;       // 最近一次连接尝试时间戳
  lastConnectedAt?: number;     // 最近一次成功 connected 时间戳
  lastError?: string;           // 最近一次失败简述（≤ 80 字符）
  gatewayUrl?: string;          // 当前连接的网关地址
  kickDetail?: AidKickDetail;   // 被踢详情（仅 kicked / kicked_no_retry 时填充）
  blockedBy?: {                 // 仅 aid_blocked 时填充
    pid: number;
    evolclawHome: string;
    agentName?: string;
  };
  queueStatus?: {               // 队列状态（IPC provider 注入）
    processing: number;         // 正在处理的消息数
    queued: number;             // 排队等待的消息数
  };
}

// ── 新结构：defaults.json + per-agent config.json（evolclaw-home-directory.md）──
//
// 旧 Config / EvolAgentConfig 保留至阶段 3 退场。新结构的承载是
// DefaultsConfig（agents/defaults.json）+ AgentConfig（agents/<aid>/config.json），
// 由 ConfigStore 加载并算 effective merged 值。

export const CONFIG_SCHEMA_VERSION = 2;

export type AgentLifecycle = 'created' | 'bootstrapping' | 'active';

export interface BaseagentClaudeConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  pathToClaudeCodeExecutable?: string;
  useSettingSources?: boolean;
  agentProgressSummaries?: boolean;
  excludeDynamicSections?: boolean;
}

export interface BaseagentCodexConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  effort?: string;
  enableRequestUserInput?: boolean;
  approvalsReviewer?: 'user' | 'auto_review' | 'guardian_subagent';
}

export interface BaseagentGeminiConfig {
  apiKey?: string;
  model?: string;
  cliPath?: string;
  mode?: 'cli' | 'sdk';
  useVertex?: boolean;
  project?: string;
  location?: string;
}

export interface BaseagentsBlock {
  claude?: BaseagentClaudeConfig;
  codex?: BaseagentCodexConfig;
  gemini?: BaseagentGeminiConfig;
  hermes?: Record<string, any>;
}

export interface ModelsBlock {
  default?: string;
  allowed?: string[];
}

/**
 * 角色级配置覆盖块——内嵌在 AgentConfig.roles[role] 下。
 * 只承载真正"按角色派生值"的字段：model/effort（baseagents）+ permissionMode。
 * 其余字段（show_activities/chatmode/dispatch）与角色无关，不在此。
 */
export interface RoleOverride {
  baseagents?: BaseagentsBlock;
  permissionMode?: string;
}

export interface ProjectsBlock {
  /** Defaults 作用域可用：创建 agent 时自动合成 `<rootPath>/<aid第一段>` 作为 defaultPath。 */
  rootPath?: string;
  /** Agent 作用域中唯一公开项目路径。 */
  defaultPath?: string;
}

export type CapabilityType = 'skill' | 'mcp' | 'plugin';
export type CapabilityMode = 'inherit' | 'all' | 'none';
export type CapabilityOverride = 'enabled' | 'disabled';

export interface CapabilityTypeConfig {
  mode?: CapabilityMode;
  overrides?: Record<string, CapabilityOverride>;
}

export type CapabilitiesBlock = Record<string, Partial<Record<CapabilityType, CapabilityTypeConfig>>>;

export interface ChatmodeBlock {
  private?: 'interactive' | 'proactive';
  group?: 'interactive' | 'proactive';
  nothuman?: 'interactive' | 'proactive';
}

/**
 * 响应模式配置块（响应系统插件化）。
 *
 * 解析优先级（高→低）：overrides[peerKey] > default_private/default_group > 系统兜底。
 * 接入点：src/response-modes/resolver.ts。
 *
 * 注：当前与 chatmode/dispatch 并存（过渡期）。Phase 6 真实模式接管后，
 * chatmode/dispatch 将被删除（D4），届时 interactive/proactive 成为内置响应模式。
 */
export interface ResponseModesConfig {
  /** 单聊默认模式 id（如 'interactive'） */
  default_private?: string;
  /** 群聊默认模式 id（如 'proactive'） */
  default_group?: string;
  /** 各模式的配置参数（modeId → 该模式的配置对象） */
  configs?: Record<string, any>;
  /** 按对端/群覆盖（peerKey → 指定模式 + 该对端专属配置） */
  overrides?: Record<string, { mode: string; config?: any }>;
}

export interface AunRuntimeBlock {
  keystorePath?: string;
  encryptionSeed?: string;
  gatewayUrl?: string;
}

export interface DebugBlock {
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  flusherDiag?: boolean;
  aunTrace?: boolean;
  aunSdkLog?: boolean;
  upmsg?: boolean;
}

export type ShowActivitiesMode = 'all' | 'none';

export interface ProactiveBehaviorBlock {
  /** proactive 下首个工具调用是否必须先通过 send/file 表态。 */
  pre_tool_1stmsgchk?: boolean;
  /** proactive 下是否启用队列未读提醒和 10 次工具汇报提醒。 */
  tool_use_reminder?: boolean;
}

// channels[].* —— per-agent，新结构里以列表形式存储。
// 元素必带 type + name，name 是该 agent 内 channel 类型下的本地标识（不含 '#'）。
// AUN 类型一个 agent 只允许一个实例，name 通常约定 'main'。
//
interface ChannelInstanceCommon {
  type: string;
  name: string;
  enabled?: boolean;
  flushDelay?: number;
  debounce?: number;
  showActivities?: ShowActivitiesMode;
}

export interface AunChannelInstance extends ChannelInstanceCommon {
  type: 'aun';
  gatewayUrl?: string;
  accessToken?: string;
  pythonBin?: string;
}

export interface FeishuChannelInstance extends ChannelInstanceCommon {
  type: 'feishu';
  appId: string;
  appSecret: string;
}

export interface WechatChannelInstance extends ChannelInstanceCommon {
  type: 'wechat';
  baseUrl?: string;
  token?: string;
}

export interface DingtalkChannelInstance extends ChannelInstanceCommon {
  type: 'dingtalk';
  clientId: string;
  clientSecret: string;
  requireMention?: boolean;
  freeResponseChats?: string[];
}

export interface QQBotChannelInstance extends ChannelInstanceCommon {
  type: 'qqbot';
  appId: string;
  clientSecret: string;
}

export interface WecomChannelInstance extends ChannelInstanceCommon {
  type: 'wecom';
  botId: string;
  secret: string;
}

export type ChannelInstance =
  | AunChannelInstance
  | FeishuChannelInstance
  | WechatChannelInstance
  | DingtalkChannelInstance
  | QQBotChannelInstance
  | WecomChannelInstance;

// ════════════════════════════════════════════════════════════════════════
// 配置体系 v3（H 配置链 + HA 行为链）
//
// H 覆盖链：defaults.json → agent/config.json → relation/config.json。
// HA 行为链：agent/behavior.json → role(behavior.roles) → relation/behavior.json。
// 进程级 evolclaw.json 是链外单独作用域。
//
// schema 是「字段 → 类型」唯一事实源（kits/schemas/）。
// ════════════════════════════════════════════════════════════════════════

/**
 * 进程级 evolclaw.json（独立作用域，不进覆盖链）。
 * 与 config-store.ts 的 EvolclawConfig 同构——逐步统一到此。
 */
export interface ProcessConfig {
  $schema_version?: number;
  aid?: string;
  owners?: string[];
  debug?: DebugBlock;
  tunnel?: { targets: Array<{ name: string; port: number; pathPrefix?: string }> };
  aun?: { encryptionSeed?: string | null };
  serviceProxy?: {
    enabled?: boolean;
    services?: Array<Record<string, unknown>>;
  };
  idleMonitor?: {
    enabled?: boolean;
    timeout?: number;
  };
  ecweb?: { enabled?: boolean; port?: number };
  watch?: { logTypes?: string[] };
}

/**
 * 全局级 agents/defaults.json —— 覆盖链最低优先级。
 * 提供 H 链配置参数的默认值，被 agent/config 和 relation/config 覆盖。
 */
export interface DefaultsConfig {
  $schema_version: number;
  models?: ModelsBlock;
  projects?: ProjectsBlock;
  aun?: AunRuntimeBlock;
  debug?: DebugBlock;
}

/**
 * Agent 级 agents/<aid>/config.json —— 覆盖 defaults。
 * 包含 agent 的身份、凭证、管控字段与基础设施配置。
 *
 * channels[] 是该 agent 接入的所有渠道实例（含 AUN）。
 */
export interface AgentConfig {
  $schema_version: number;
  aid: string;
  enabled?: boolean;
  /** Agent 生命周期：created → bootstrapping → active。缺失时由 initialized 兼容映射。 */
  lifecycle?: AgentLifecycle;
  /** 首次连接 AUN 网络后置 true：触发"补全 agent.md + 发欢迎消息"的一次性流程。 */
  initialized?: boolean;
  /** Agent owner AID 列表；当前控制面仍需要读取旧 config 字段。 */
  owners?: string[];
  aun?: AunRuntimeBlock;
  channels: ChannelInstance[];
  models?: ModelsBlock;
  projects?: ProjectsBlock;
  capabilities?: CapabilitiesBlock;
  debug?: DebugBlock;
  /** 观察者模式：开启后入站/出站各转发一份给 owner 角色对端。默认 false。 */
  observable?: boolean;
  /** 快照额外备份声明（不得指向 .env）。 */
  extra_backup?: Array<{ path: string; pattern?: string }>;

  // Runtime configuration parameters
  // 模型配置
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  // 对话模式
  chatmode?: ChatmodeBlock;
  // 响应模式（响应系统插件化；过渡期与 chatmode/dispatch 并存）
  response_modes?: ResponseModesConfig;
  // 消息合并/节流
  flush_delay?: number;
  debounce?: number;
  // 群聊分发
  dispatch?: 'mention' | 'broadcast';
  // 可见性
  show_activities?: ShowActivitiesMode;
  // proactive 模式细粒度策略
  proactive?: ProactiveBehaviorBlock;
  // 渲染
  render?: { private?: string; group?: string; inject?: string };
  // 富内容
  enable_rich_content?: boolean;
  // 执行权限模式
  permissionMode?: string;
  // 角色级覆盖
  roles?: Record<string, RoleOverride>;
}

/**
 * 关系级 agents/<aid>/relations/<peerKey>/config.json —— 覆盖链最高优先级。
 * 支持针对不同用户的 H 链个性化配置；行为覆盖写 relation behavior.json。
 */
export interface RelationConfig {
  $schema_version: number;
  extra_backup?: Array<{ path: string; pattern?: string }>;

  // Relation-level personalization parameters
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  chatmode?: ChatmodeBlock;
  response_modes?: ResponseModesConfig;
  flush_delay?: number;
  debounce?: number;
  dispatch?: 'mention' | 'broadcast';
  show_activities?: ShowActivitiesMode;
  proactive?: ProactiveBehaviorBlock;
  render?: { private?: string; group?: string; inject?: string };
  enable_rich_content?: boolean;
  permissionMode?: string;
  roles?: Record<string, RoleOverride>;
}

/**
 * 运行时合并结果（下游统一视图）。
 * 先合并 H 链：defaults → agent/config → relation/config，
 * 再叠加 HA 行为链：agent behavior → role → relation behavior。
 * 字段保持 optional——覆盖链全空即 undefined，由消费方按字段语义处理。
 */
export interface EffectiveAgentConfig {
  $schema_version: number;
  aid: string;
  enabled?: boolean;
  lifecycle?: AgentLifecycle;
  initialized?: boolean;
  owners?: string[];
  aun?: AunRuntimeBlock;
  channels: ChannelInstance[];
  models?: ModelsBlock;
  projects?: ProjectsBlock;
  capabilities?: CapabilitiesBlock;
  debug?: DebugBlock;
  observable?: boolean;
  extra_backup?: Array<{ path: string; pattern?: string }>;

  // Effective runtime configuration (merged from defaults → agent → relation)
  // 模型配置
  active_baseagent?: string;
  baseagents?: BaseagentsBlock;
  // 对话模式
  chatmode?: ChatmodeBlock;
  // 响应模式（响应系统插件化；过渡期与 chatmode/dispatch 并存）
  response_modes?: ResponseModesConfig;
  // 消息合并/节流
  flush_delay?: number;
  debounce?: number;
  // 群聊分发
  dispatch?: 'mention' | 'broadcast';
  // 可见性
  show_activities?: ShowActivitiesMode;
  // proactive 模式细粒度策略
  proactive?: ProactiveBehaviorBlock;
  // 渲染
  render?: { private?: string; group?: string; inject?: string };
  // 富内容
  enable_rich_content?: boolean;
  // 执行权限模式
  permissionMode?: string;
  // 角色级覆盖
  roles?: Record<string, RoleOverride>;
}

// ── 出站协议类型（OutboundPayload / OutboundEnvelope / ChannelCapabilities） ──

/**
 * ThoughtItem — 结构化思考单元
 * 多个 item 在 IMRenderer 聚合窗口内打包成 activity.batch 发送
 */
export type ThoughtItem =
  | { kind: 'text'; text: string; duration_ms?: number }
  | { kind: 'reasoning'; text: string; duration_ms?: number }
  | { kind: 'tool_call'; call_id: string; name: string; arguments?: Record<string, unknown>; text?: string }
  | { kind: 'tool_result'; call_id: string; name: string; ok: boolean; result?: unknown; error?: string; duration_ms?: number; text?: string }
  | { kind: 'progress'; text: string; state?: 'processing' | 'waiting'; tool_uses?: number; duration_ms?: number }
  | { kind: 'started'; text?: string; metadata?: Record<string, unknown> }
  | { kind: 'completed'; text?: string; metadata?: Record<string, unknown> }
  | { kind: 'notice'; text: string; severity: 'info' | 'warn'; subtype?: string }
  | { kind: 'summary'; text: string; subtype?: string; is_error?: boolean; duration_ms?: number };

export type OutboundPayload =
  | { kind: 'result.text'; text: string; isFinal: boolean; format?: 'markdown' | 'plain' }
  | { kind: 'result.file'; filePath: string; fileName?: string; targetChannel?: string; correlationId?: string }
  | { kind: 'result.image'; data: Buffer; mimeType?: string; alt?: string }
  | { kind: 'result.error'; text: string; reason?: string }
  | { kind: 'activity.batch'; items: ThoughtItem[] }
  | { kind: 'status.started'; metadata?: Record<string, unknown> }
  | { kind: 'status.progress'; metadata?: { activityType: 'text' | 'tool_call' | 'tool_result' | 'progress'; turn?: number; outputTokens?: number; toolName?: string; callId?: string; ok?: boolean; durationMs?: number; text?: string; state?: 'processing' | 'waiting'; toolUses?: number } }
  | { kind: 'status.queued'; metadata?: Record<string, unknown> }
  | { kind: 'status.completed'; metadata?: { durationMs?: number; ttftMs?: number; numTurns?: number; tokenUsage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; contextUsage?: { totalTokens: number; maxTokens: number; percentage: number; autoCompactTokens?: number; model: string; effort?: string }; lastModelCall?: { messageId?: string; uuid?: string; requestId?: string; model?: string; tokenUsage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; [key: string]: unknown }; contextUsage?: { totalTokens: number; maxTokens: number; percentage: number; autoCompactTokens?: number; model: string; effort?: string } } } }
  | { kind: 'status.interrupted'; metadata?: { reason: string } }
  | { kind: 'status.error'; metadata?: { errorType?: string } }
  | { kind: 'status.timeout'; metadata?: { idleSec?: number } }
  | { kind: 'command.result'; text: string; format?: 'markdown' | 'plain' }
  | { kind: 'command.error'; text: string; reason?: string }
  | { kind: 'interaction'; interaction: InteractionRequest; fallbackText?: string }
  | { kind: 'system.notice'; text: string; subtype: string }
  | { kind: 'system.error'; text: string; subtype: string; recoverable?: boolean }
  | { kind: 'custom'; channelType: string; payload: unknown };

export interface OutboundEnvelope {
  taskId: string;
  /** EvolClaw 会话 ID（跨任务稳定，(channel,channelId,project) 维度）。命令回显/系统通知等无会话上下文的出站可缺省。 */
  sessionId?: string;
  channel: string;
  channelId: string;
  agentName: string;
  chatmode: 'interactive' | 'proactive';
  replyContext?: ReplyContext;
  timestamp: number;
}

export interface ChannelCapabilities {
  file: boolean;
  image: boolean;
  interaction: boolean;
  markdown: boolean;
  thought: boolean;
  status: boolean;
  thread: boolean;
}

// ── Trigger types ──

export type TriggerScheduleType = 'delay' | 'at' | 'cron' | 'interval';
export type TriggerSessionStrategy = 'latest' | 'current' | 'thread';

export interface Trigger {
  id: string;
  name: string;
  scheduleType: TriggerScheduleType;
  scheduleValue: string;       // delay: ms as string; at: ISO string; cron: expression
  nextFireAt: number;          // Unix ms
  targetChannel: string;
  targetChannelId: string;
  targetChatType?: 'private' | 'group';
  /** Channel type resolved at creation time (CommandHandler has channelTypeMap);
   *  the scheduler has no channelTypeMap, so it relies on this stored value. */
  targetChannelType?: string;
  targetThreadId?: string;
  targetSessionStrategy: TriggerSessionStrategy;
  baseagent?: string;
  prompt: string;
  createdByPeerId: string;
  createdByChannel: string;
  schedulerAid: string;          // 拥有/调度/执行这条 trigger 的 agent aid（= parseChannelKey(targetChannel).selfAID）
  lastFiredAt?: number;
  fireCount: number;
  failCount: number;
  lastResult?: 'completed' | 'failed' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  boundSessionId?: string;       // current：注册时绑定的 sessionId
  threadKind?: 'aun' | 'feishu'; // thread：实现路径
  rootMessageId?: string;        // thread(feishu)：注册时命令消息的 messageId
  pendingThread?: boolean;       // thread(feishu)：首次触发待建话题
}

// ── Menu Protocol types ──
//
// 6 种消息类型：
//   menu.list    → 拉取整个菜单树
//   menu.query   → 查询某项当前值
//   menu.options → 列举某项可选值
//   menu.update  → 写入新值
//   menu.action  → 触发动词（stop / restart / new / rename / delete / ...）
//   menu.response → 统一响应

export interface MenuListRequest {
  type: 'menu.list';
  id: string;
}

export interface MenuQueryRequest {
  type: 'menu.query';
  id: string;
  name: string;          // 通用操作标识（如 'pwd' / 'baseagent' / 'session'）
  cmd?: string;          // 逃生口：直接指定内部命令
  args?: Record<string, any>;
}

export interface MenuOptionsRequest {
  type: 'menu.options';
  id: string;
  name: string;
  cmd?: string;
  args?: Record<string, any>;
}

export interface MenuUpdateRequest {
  type: 'menu.update';
  id: string;
  name: string;
  value: string;         // 目标值
  cmd?: string;
  // 结构化附加参数。baseagent 支持 args.scope:
  //   'session' 仅切当前会话 | 'default' 仅改 agent 默认 | 'both'（默认）两者都改
  args?: Record<string, any>;
}

export interface MenuActionRequest {
  type: 'menu.action';
  id: string;
  name: string;          // 动词所属 name（如 'session' / 'system'）
  action: string;        // 'stop' / 'restart' / 'new' / 'rename' / 'delete' / ...
  // cli/exec 透传约定：args 为 { argv?: string[]; command?: string }
  //   argv    优先，已是数组免分词（推荐，无注入面）
  //   command 退化路径，字符串由 daemon 侧分词（尊重单/双引号，不走 shell）
  args?: Record<string, any>;
  cmd?: string;
}

export interface MenuResponse {
  type: 'menu.response';
  id: string;
  name?: string;         // 回显 name（menu.list 无 name）
  data?: any;            // 成功（与 error 互斥）
  error?: { code: string; message: string };  // 失败（与 data 互斥）
}

// ── Command Authorization Types ──

export type CommandSource = 'slash' | 'menu' | 'menu.cli' | 'ctl' | 'ipc' | 'ecweb' | 'control' | 'agent-tool';

export type CommandScope =
  | 'relation'
  | 'role'
  | 'agent'
  | 'process'
  | 'filesystem'
  | 'control'
  | 'raw-cli';

export type OperationCategory =
  | 'read'
  | 'diagnose'
  | 'write-own'
  | 'write-agent'
  | 'process'
  | 'dangerous';

export interface OperationMeta {
  id: string;
  category: OperationCategory;
  dangerous: boolean;
  defaultScopes: CommandScope[];
  description: string;
  sources?: CommandSource[];
}

export interface CommandIntent {
  operation: string;
  scope: CommandScope;
  source: CommandSource;
  args: Record<string, unknown>;
  rawArgv?: string[];
  dangerous?: boolean;
}

export interface CommandAuthorizationContext {
  intent: CommandIntent;

  actorId?: string;
  channel?: string;
  channelId?: string;
  chatType?: 'private' | 'group';

  selfAid?: string;
  peerKey?: string;
  role: string;

  isDaemonOwner?: boolean;
  fromControlChannel?: boolean;
  source: CommandSource;
}

export interface CommandPermissionConstraints {
  ownPeerOnly?: boolean;
  ownAgentOnly?: boolean;
  privateOnly?: boolean;
  groupOnly?: boolean;
  requireDaemonOwner?: boolean;
  requireControlChannel?: boolean;
  requireExplicitDangerousGrant?: boolean;
  requireFieldOverride?: string;

  allowedArgs?: Record<string, Array<string | number | boolean>>;
  deniedArgs?: Record<string, Array<string | number | boolean>>;
  forbiddenFlags?: string[];
  allowedConfigKeys?: string[];
  allowedPrefixes?: string[];

  timeoutMs?: number;
  outputLimitBytes?: number;
  cwdPolicy?: 'agentProject' | 'evolclawHome' | 'none';
  envAllowlist?: string[];
}

export interface CommandPermission {
  allow: boolean;
  dangerous?: boolean;
  scopes?: CommandScope[];
  constraints?: CommandPermissionConstraints;
  reason?: string;
}

export type CommandAuthorizationDecision =
  | {
      allow: true;
      operation: string;
      scope: CommandScope;
      role: string;
      dangerous: boolean;
      matchedRule?: string;
      constraints?: CommandPermissionConstraints;
    }
  | {
      allow: false;
      code:
        | 'NO_PERMISSION'
        | 'NOT_ALLOWED'
        | 'SCOPE_MISMATCH'
        | 'ARGUMENT_MISMATCH'
        | 'DANGEROUS_NOT_GRANTED'
        | 'ROLE_ACCESS_DENIED';
      reason: string;
      operation: string;
      scope?: CommandScope;
      role: string;
      dangerous?: boolean;
      matchedRule?: string;
    };

export interface CommandAuthorizationAuditEvent {
  ts: number;
  source: CommandSource;
  operation: string;
  scope: CommandScope;
  dangerous: boolean;

  actorId?: string;
  selfAid?: string;
  peerKey?: string;
  channel?: string;
  channelId?: string;
  role: string;
  isDaemonOwner?: boolean;
  fromControlChannel?: boolean;

  decision: 'allow' | 'deny';
  code?: string;
  reason?: string;
  matchedRule?: string;

  argvHash?: string;
  argsSummary?: Record<string, unknown>;
  durationMs?: number;
  exitCode?: number;
}

// ── Role System Types ──

export type BuiltinRole = 'owner' | 'admin' | 'member' | 'guest' | 'anonymous';

export interface RolesConfig {
  $schema_version: number;
  defaultRoles?: {
    private: string;
    group: string;
  };
  roles: Record<string, RoleDefinition>;
}

export interface RoleDefinition {
  description: string;
  allowAccess?: boolean;  // 该角色是否允许访问，默认 true（anonymous 默认 false）
  permissions: Record<string, FieldPermission>;
  commandPermissions?: Record<string, CommandPermission>;  // 命令权限配置
}

export type RoleAssignmentScope = 'private' | 'group' | 'group-member';

export interface RoleAssignment {
  scope: RoleAssignmentScope;
  peerId?: string;
  groupId?: string;
  role: string;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface RoleAssignmentsConfig {
  $schema_version: number;
  assignments: Record<string, RoleAssignment>;
}

export interface FieldPermission<T = any> {
  default: T;
  allowOverride: boolean;
  allowedModels?: string[];    // for baseagents.*.model
  allowedValues?: T[];         // for enum fields
  reason?: string;
}

export interface RoleContext {
  self: string;
  peerKey: string;
  role: string;
}

export interface ConstraintViolation {
  field: string;
  reason: 'override_not_allowed' | 'model_not_allowed' | 'value_not_allowed';
  attempted: any;
  allowed: any;
  role: string;
}

export interface ConstraintCheckResult {
  valid: boolean;
  violations: ConstraintViolation[];
  effectiveConfig: any;  // Will be typed as BehaviorConfig in the implementation
}
