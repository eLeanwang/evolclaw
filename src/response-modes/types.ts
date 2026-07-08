/**
 * Response Mode System - Core Types
 *
 * 响应模式插件化系统的核心类型定义。
 * 所有响应模式必须实现 ResponseMode 接口。
 */

import type { Session, AgentContext, EffectiveAgentConfig, OutboundPayload } from '../types.js';

// Re-export OutboundPayload 供本模块其他文件使用
export type { OutboundPayload };

// ============================================================================
// 数据类型
// ============================================================================

/**
 * 入站消息（由 Channel Adapter 构造）
 */
export interface InboundMessage {
  /** 消息 ID */
  messageId?: string;
  /** 发送者 ID（渠道原生 ID） */
  peerId: string;
  /** 消息内容 */
  content: string;
  /** 聊天类型 */
  chatType: 'private' | 'group';
  /** 附件（图片/文件等） */
  attachments?: Array<{
    type: 'image' | 'file' | 'audio' | 'video';
    url?: string;
    path?: string;
    data?: Buffer;
    metadata?: Record<string, any>;
  }>;
  /** 提及的 AID 列表（群聊场景） */
  mentionAids?: string[];
  /** 是否提及了本 agent（由 Channel 标记，响应模式据此判断是否响应） */
  isMentioned?: boolean;
  /** 元数据 */
  metadata?: Record<string, any>;
  /** 渠道类型（aun/feishu/wechat） */
  channel?: string;
  /** 渠道 ID（群 ID 或对端 ID） */
  channelId?: string;
  /** 消息来源（'user' | 'trigger'） */
  source?: string;
}

/**
 * 出站内容（由 Agent Runner 产生，传递给响应模式）
 */
// ============================================================================
// 决策对象
// ============================================================================

/**
 * 入站决策：告诉执行层"这条消息怎么处理"
 */
export interface InboundDecision {
  /** 处理动作 */
  action: 'process' | 'drop' | 'defer';

  /**
   * 队列行为（仅 action='process' 时有效）
   *   - enqueue: 入队到队尾（FIFO 默认）
   *   - priority: 插入队首（紧急消息）
   *   - clear-and-enqueue: 清空队列后入队（独占模式）
   *   - interrupt: 中断当前处理并立即开始
   */
  queueBehavior?: 'enqueue' | 'priority' | 'clear-and-enqueue' | 'interrupt';

  /**
   * 附加指令（执行层据此执行额外操作）
   */
  instructions?: {
    /** 切换模型（如处理图片时切换到视觉模型） */
    switchModel?: string;
    /** 注入上下文（如工作群注入群规则文档） */
    injectContext?: string[];
    /** 中断当前处理（用于 interrupt 行为） */
    interruptCurrent?: boolean;
  };

  /**
   * 运行时状态（传递给处理流程，用于模式特定的行为控制）
   * 例如 proactive 模式：
   *   { suspendUntilCall: true, preTool1stMsgChk: true, toolUseReminder: false }
   * MessageProcessor 将此存入 context.sessionState，
   * IMRenderer 或响应模式可从中读取，实现细粒度控制。
   */
  runtimeState?: Record<string, any>;

  /**
   * 自定义处理器（逃生舱：绕过标准流程）
   * 用于极端场景，标准 action/queueBehavior 无法表达的逻辑
   */
  customHandler?: (message: InboundMessage, context: ResponseModeContext) => Promise<void>;

  /** 决策原因（用于日志和调试） */
  reason?: string;
}

/**
 * 出站决策：告诉执行层"这个输出怎么发"
 */
export interface OutboundDecision {
  /**
   * 发送方式：
   *   - direct: 直接发送（立即调用 channel.send）
   *   - suppress: 抑制输出（不发送）
   *   - defer: 延迟发送（暂存，稍后由模式主动发送）
   *   - batch: 批量累积（与后续输出合并后发送）
   */
  method: 'direct' | 'suppress' | 'defer' | 'batch';

  /**
   * 发送类型（仅 method='direct' 时有效）
   *   - message: 普通消息
   *   - thought: 思考过程（proactive 模式）
   */
  type?: 'message' | 'thought';

  /**
   * 批量累积策略（仅 method='batch' 时有效）
   */
  batchOptions?: {
    /** 最大等待时间（毫秒），超时后强制发送 */
    maxWaitMs?: number;
    /** 最大累积条数，达到后立即发送 */
    maxItems?: number;
    /** 合并策略（'concat' | 'summarize'） */
    mergeStrategy?: 'concat' | 'summarize';
  };

  /**
   * 自定义发送器（逃生舱：完全自定义发送逻辑）
   */
  customSender?: (payload: OutboundPayload, context: ResponseModeContext) => Promise<void>;

  /**
   * 调度提示（预留给未来调度层）
   *   - continue: 继续执行，不让出控制权
   *   - pause: 暂停当前任务，允许其他任务插入
   *   - yield: 完成当前输出后主动让出，允许切换任务
   */
  yieldHint?: 'continue' | 'pause' | 'yield';

  /** 决策原因（用于日志和调试） */
  reason?: string;
}

// ============================================================================
// 响应模式接口
// ============================================================================

/**
 * 响应模式接口
 * 所有响应模式必须实现此接口
 */
export interface ResponseMode {
  // ─── 元数据 ───
  /** 模式唯一标识（ 'interactive'） */
  readonly id: string;

  /** 显示名称（用于前端展示，如 '交互模式'） */
  readonly displayName: string;

  /** 模式描述 */
  readonly description: string;

  /** 模式类型 */
  readonly type: 'builtin' | 'extension';

  /** 适用场景 */
  readonly applicableScenes: ('private' | 'group')[];

  /** 配置 Schema（JSON Schema 格式，用于校验和前端表单生成） */
  readonly configSchema?: JSONSchema;

  // ─── 生命周期 ───
  /**
   * 初始化模式（会话首次使用此模式时调用）
   * @param context 响应模式上下文（注入依赖）
   */
  initialize(context: ResponseModeContext): Promise<void>;

  /**
   * 清理资源（会话切换模式或结束时调用）
   */
  cleanup(): Promise<void>;

  // ─── 核心能力 ───
  /**
   * 处理入站消息
   * @param message 入站消息
   * @returns 入站决策
   */
  handleInbound(message: InboundMessage): Promise<InboundDecision>;

  /**
   * 处理出站消息
   * @param payload 出站内容
   * @returns 出站决策
   */
  handleOutbound(payload: OutboundPayload): Promise<OutboundDecision>;

  // ─── 队列管理 ───
  /**
   * 获取此模式使用的队列实例
   * 简单模式返回默认队列，复杂模式返回自定义队列
   */
  getQueue(): MessageQueueInterface;

  // ─── 处理流程钩子（全部可选，引擎判断存在才调，零成本）───
  // 设计见 docs/response-system/phase6-plugin-lifecycle-design.md

  /**
   * 出队后、Runner 调用前：准备模式运行时状态（如 ProactiveRuntimeState）。
   * 写入 ctx.state，供后续钩子（onToolUse/onComplete）读取。
   */
  beforeProcess?(ctx: ProcessContext): Promise<void> | void;

  /**
   * Runner 调用前：提供本次运行的配置（policyHook、renderer 抑制、系统提示变量）。
   * 返回的 RunConfig 由引擎应用到本次 Runner 调用。
   */
  configureRun?(ctx: ProcessContext): RunConfig | undefined;

  /**
   * 流处理期间：工具调用事件（proactive 首工具表态、工具汇报提醒）。
   */
  onToolUse?(ctx: ToolUseContext): Promise<void> | void;

  /**
   * 流处理期间：完成事件（proactive 标志位检查）。
   */
  onComplete?(ctx: CompleteContext): Promise<void> | void;

  /**
   * Runner 返回后：后处理（interactive 文件标记发送、proactive Unknown skill 兜底）。
   */
  afterProcess?(ctx: AfterProcessContext): Promise<void> | void;
}

// ============================================================================
// 响应模式上下文（依赖注入）
// ============================================================================

/**
 * 响应模式上下文（依赖注入）
 * 响应模式通过此接口获取依赖，不直接 import 具体实现
 */
export interface ResponseModeContext {
  /** 当前会话 */
  session: Session;

  /** Agent 配置（合并后的有效配置） */
  agentConfig: EffectiveAgentConfig;

  /** 本模式的配置（从配置层级解析） */
  modeConfig: any;

  /** Agent Runner（用于调用模型，如辅助会话） */
  runner: AgentContext;

  /**
   * Channel Adapter（用于发送消息和查询能力）
   */
  channel: {
    /** 渠道类型（aun/feishu/wechat） */
    type: string;

    /** 渠道能力查询 */
    capabilities: {
      /** 是否支持 thought 协议（proactive 模式需要） */
      supportsThought: boolean;
      /** 是否支持交互式组件（按钮/菜单） */
      supportsInteraction: boolean;
      /** 是否支持富文本 */
      supportsRichText: boolean;
      /** 是否支持文件 */
      supportsFile: boolean;
      /** 是否支持图片 */
      supportsImage: boolean;
    };

    /** 发送消息 */
    send(content: string, type?: 'message' | 'thought'): Promise<void>;
  };

  /** 日志器 */
  logger: {
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
  };

  /**
   * 会话级状态存储（响应模式可存储 per-session 运行时状态）
   * 例如 proactive 模式存储 { suspendUntilCall: true }，
   * MessageProcessor 读取后控制行为。
   */
  sessionState: Map<string, any>;

  /**
   * 本模式的持久化数据目录。
   * 用于存储跨重启的状态（如工作流状态、线索表）。
   * 由系统按 `<agentDir>/response-modes/<modeId>/` 派生并确保存在。
   */
  dataDir: string;

  // ─── 扩展能力工厂（按需调用，懒创建） ───
  /**
   * 创建辅助会话（轻量模型，独立成本统计）。
   * dual-session 等模式在 initialize 时调用。
   *
   * @param options 创建选项
   * @param options.model 使用的模型（如 'haiku'）
   * @param options.purpose 用途标识（用于成本统计和调试，如 'relevance-judge'）
   * @param options.contextMode 上下文模式（'full'=完整，'minimal'=精简，默认 'minimal'）
   * @returns 辅助会话实例
   */
  createAuxiliarySession(options?: {
    model?: string;
    purpose?: string;
    contextMode?: 'full' | 'minimal';
  }): Promise<AuxiliarySession>;

  /** 创建线索管理器（thread-tracking 模式用） */
  createThreadManager?(options?: {
    maxActiveThreads?: number;
    timeoutMs?: number;
  }): ThreadManager;

  /** 创建工作流引擎（workflow 模式用） */
  createWorkflowEngine?(options: { workflowFile: string }): Promise<WorkflowEngine>;
}

// ============================================================================
// 队列接口
// ============================================================================

/**
 * 消息队列接口（响应模式可提供自己的队列实现）
 */
export interface MessageQueueInterface {
  /**
   * 入队（异步）
   * @param message 消息
   * @param priority 优先级（可选，用于优先队列）
   */
  enqueue(message: InboundMessage, priority?: number): Promise<void>;

  /**
   * 出队（异步）
   * @returns 消息，队列空时返回 undefined
   */
  dequeue(): Promise<InboundMessage | undefined>;

  /**
   * 出队（同步版本，用于 processNext 循环）
   * @returns 消息，队列空时返回 undefined
   */
  dequeueSync(): InboundMessage | undefined;

  /**
   * 查看队首消息（不出队）
   */
  peek(): Promise<InboundMessage | undefined>;

  /**
   * 查看队首消息（同步版本，不出队）
   */
  peekSync?(): InboundMessage | undefined;

  /**
   * 队列长度
   */
  size(): number;

  /**
   * 清空队列
   */
  clear(): Promise<void>;

  /**
   * 重排队列（切换模式时调用，按新模式的出队策略重排）
   * @param strategy 排序策略（'fifo' | 'lifo' | 'priority'）
   */
  reorder?(strategy: 'fifo' | 'lifo' | 'priority'): Promise<void>;
}

// ============================================================================
// 辅助类型
// ============================================================================

/**
 * JSON Schema 类型（简化版）
 */
export interface JSONSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
  default?: any;
  enum?: any[];
  [key: string]: any;
}

/**
 * 辅助会话：用于轻量判断、过滤、分析的独立会话。
 * 与主会话隔离——它的输出不直接发给对端，只回传给响应模式做决策。
 */
export interface AuxiliarySession {
  /**
   * 提交一段提示，返回模型输出（通常是 JSON 或简短文本判断）。
   * @param prompt 判断提示（如「这条消息是否与我有关？」）
   */
  judge(prompt: string): Promise<string>;

  /**
   * 发送状态或通知消息（可选能力，预留给未来响应模式）。
   * 典型场景：
   *   - thought: 发送处理状态（"正在批量处理 50 条消息..."）
   *   - message: 发送结果通知（"批量处理完成，无相关消息"）
   * 注意：辅助会话不应发送"回复对端问题"的消息，那是主会话的职责。
   * @param content 消息内容
   * @param type 消息类型（thought=状态/思考过程，message=实际消息）
   */
  send(content: string, type: 'thought' | 'message'): Promise<void>;

  /** 关闭会话，释放资源（在响应模式 cleanup 时调用） */
  close(): Promise<void>;
}

/**
 * 线索管理器：维护活跃对话线索，判断消息归属。
 * 由 thread-tracking 模式使用，系统提供默认实现。
 */
export interface ThreadManager {
  /** 查找消息所属的线索（无则返回 undefined） */
  findThread(message: InboundMessage): Thread | undefined;

  /** 加入新线索（被 @ 时调用） */
  joinThread(message: InboundMessage): Thread;

  /** 列出当前活跃线索 */
  activeThreads(): Thread[];

  /** 关闭线索（超时或明确退出） */
  closeThread(threadId: string): void;
}

/**
 * 对话线索
 */
export interface Thread {
  id: string;
  isActive: boolean;
  lastActiveAt: number;
  metadata?: Record<string, any>;
}

/**
 * 工作流引擎（workflow 模式用）
 */
export interface WorkflowEngine {
  /** 执行工作流 */
  execute(input: any): Promise<any>;

  /** 获取当前状态 */
  getState(): WorkflowState;

  /** 暂停工作流 */
  pause(): Promise<void>;

  /** 恢复工作流 */
  resume(): Promise<void>;

  /** 停止工作流 */
  stop(): Promise<void>;
}

/**
 * 工作流状态
 */
export interface WorkflowState {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  currentNode?: string;
  progress?: number;
  result?: any;
  error?: Error;
}

/**
 * 工作流节点
 */
export interface WorkflowNode {
  id: string;
  type: 'start' | 'task' | 'decision' | 'end';
  execute(input: any, context: any): Promise<any>;
}

// ============================================================================
// 处理流程钩子的 Context 类型
// 设计见 docs/response-system/phase6-plugin-lifecycle-design.md §3
//
// 原则：Context 只暴露该钩子需要的运行时能力（最小授权），
// 不直接传 agent/renderer/adapter 大对象，而是把能力包装成小函数。
// ============================================================================

/** 钩子共用的日志器形状 */
export interface ResponseLogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/** beforeProcess / configureRun 用：出队后、Runner 前的处理上下文 */
export interface ProcessContext {
  session: Session;
  message: InboundMessage;
  /** 本模式配置（resolver 解析） */
  modeConfig: any;
  /** per-(session,mode) 状态存储，跨钩子共享（如 ProactiveRuntimeState 存这里） */
  state: Map<string, any>;
  /** 判断工具是否是「表态」命令（ec msg send 等）——proactive 首工具表态用 */
  isSendCommand: (toolName: string, toolInput: any) => boolean;
  logger: ResponseLogger;
}

/** configureRun 返回值：本次 Runner 运行的模式配置 */
export interface RunConfig {
  /** 工具调用策略钩子（proactive 首工具表态）。返回 block 决定是否拦截工具。 */
  policyHook?: (toolName: string, toolInput: any) => { block: boolean; reason: string } | undefined;
  /** 是否抑制 renderer 活动输出 */
  suppressActivities?: boolean;
  /** 注入系统提示的模式相关变量（chatMode/preTool1stMsgChk 等） */
  promptVars?: Record<string, any>;
}

/** onToolUse 用：工具调用事件上下文 */
export interface ToolUseContext {
  session: Session;
  /** 读写模式状态（如 ProactiveRuntimeState 的 toolCount/firstToolDone） */
  state: Map<string, any>;
  toolName: string;
  toolInput: any;
  /** 向模型上下文注入消息（不发给对端）——proactive 汇报提醒用 */
  injectToModel: (text: string) => void;
  /** 查询当前队列待处理数——proactive 队列提醒用 */
  getQueueLength: () => number;
  /** 判断工具是否是「表态」命令（ec msg send 等）——proactive 工具计数白名单用 */
  isSendCommand: (toolName: string, toolInput: any) => boolean;
  logger: ResponseLogger;
}

/** onComplete 用：完成事件上下文 */
export interface CompleteContext {
  session: Session;
  state: Map<string, any>;
  /** 本轮最终回复文本（标志位检查用） */
  lastReplyText: string;
  /** 持久化 session metadata（标志位写入用） */
  updateSessionMeta: (patch: Record<string, any>) => Promise<void>;
  logger: ResponseLogger;
}

/** afterProcess 用：Runner 返回后的后处理上下文 */
export interface AfterProcessContext {
  session: Session;
  /** Runner 全部输出的完整文本（文件标记扫描用） */
  fullText: string;
  streamResult: { hasReceivedText: boolean };
  /** 发送出站 payload（Unknown skill 兜底用） */
  send: (payload: OutboundPayload) => Promise<void>;
  /** 渠道能力查询 */
  channelCapabilities: { file: boolean; thought: boolean; [k: string]: boolean };
  /**
   * 处理文本中的文件标记并发送（interactive 用）。
   * 引擎能力：扫描 [SEND_FILE:...] 标记 → 多通道路由 + 权限校验 + 发文件。
   * 模式只需决定「是否调用」，发送动作由引擎实现（依赖多通道路由等基础设施）。
   * @param text 要扫描的全文
   * @returns 处理的文件标记数
   */
  processFileMarkers: (text: string) => Promise<number>;
  logger: ResponseLogger;
}
