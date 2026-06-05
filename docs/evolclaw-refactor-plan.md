# EvolClaw 三层重构完整方案

## 一、改造初衷

### 1.1 当前问题

EvolClaw 当前是一个"飞书+Claude 的 bot"，三个核心层边界模糊：

1. **Channel 越权访问 Gateway**：FeishuChannel 直接接收 `db` 参数，自建 `chat_types` 表缓存群聊判断结果
2. **Gateway 耦合 Channel 细节**：MessageProcessor 里有飞书特有的 rootId 处理逻辑（`session.metadata?.feishu?.rootId`）
3. **Gateway 耦合 Agent 实现**：MessageProcessor 硬编码了 Claude SDK 的事件类型（text_delta、assistant、result）
4. **index.ts 职责混乱**（413 行）：同时承担 Channel 条件创建、Adapter 包装、消息路由、命令分发，三个渠道各写一遍 onMessage 模板代码
5. **Agent Runner 不可替换**：AgentRunner 直接 import Claude SDK，没有抽象接口

### 1.2 改造目标

将 EvolClaw 从一个单体 bot 重构为**可组合的 Agent 网关框架**：

1. **模块独立**：Channel、Gateway、Agent Runner 各自有清晰的接口边界
2. **可自由组合**：Slack + Gemini、飞书 + Codex、微信 + DeepAgent 等任意组合
3. **可独立使用**：第三方可以只用 Channel 层或只用 Agent Runner 层
4. **可嵌入集成**：Gateway 可以作为独立模块被第三方系统引用

### 1.3 设计原则

1. **单一职责**：每层只负责一件事，不越界
2. **依赖倒置**：依赖抽象接口，不依赖具体实现
3. **开闭原则**：对扩展开放，对修改封闭
4. **最小知识**：每层只知道自己需要知道的
5. **单会话单 Agent**：一个会话同时只有一个 Agent 在运行（消息队列串行保证）

---

## 二、三层职责划分

### 2.1 Channel 层（渠道层）

**核心职责**：连接外部平台，收发消息。

**关键原则**：
- Channel 不知道"会话"、"命令"、"Agent"的概念
- Channel 只知道"我连着飞书/微信/Slack"、"这个 chatId 是群聊"
- Channel 把平台消息标准化后交给 Gateway，把 Gateway 的回复通过平台送达用户

**能力分类**：

1. **基础能力**（必须实现）：发送文本消息、接收消息并回调
2. **扩展能力**（可选）：消息确认（acknowledge）、发送文件、群聊检测
3. **回复定位**：Gateway 传递 `ReplyContext`，Channel 从 metadata 提取渠道特有信息
4. **消息形态适配**：Gateway 决定"发什么"，Channel 决定"怎么发"
5. **事件订阅**：Channel 订阅 Gateway 事件，自行决定如何呈现

### 2.2 Gateway 层（网关层）

**核心职责**：会话管理、消息队列、命令处理、事件发布、消息路由、权限审批、事件流处理。

**关键原则**：
- Gateway 知道"这条消息属于哪个会话"、"这个会话绑定了哪个 Agent"、"用户发了一个命令"
- Gateway 不知道飞书的 rootId、微信的 context_token、Claude SDK 的 API 细节
- Gateway 通过标准接口与 Channel 和 Agent Runner 交互

**核心组件**：

1. **SessionManager**：会话的创建、查找、切换、持久化；会话身份管理；Safe Mode 状态管理；群聊/单聊属性管理
2. **MessageQueue**：按会话串行处理消息，支持消息中断
3. **CommandHandler**：斜杠命令的解析和执行，权限检查
4. **MessageProcessor**：消费标准 `AgentEvent` 事件流、StreamFlusher、StreamIdleMonitor、Safe Mode 判断逻辑
5. **EventBus**：对外发布事件，提供标准订阅接口
6. **PermissionGateway**：权限审批机制（扩展自现有 `permission.ts`）

**会话身份（SessionIdentity）**：

```typescript
interface SessionIdentity {
  role: 'owner' | 'guest' | 'anonymous';  // 用户角色（基于 config.channels[channel].owner 判定）
  mode: 'interactive' | 'autonomous';      // 交互模式（会话创建时设定，之后不可变）
}
```

**会话属性（Session）**：

```typescript
interface Session {
  channel: string;
  channelId: string;
  isGroup: boolean;      // 群聊/单聊（会话创建时由 Channel 提供，持久化到数据库）
  identity: SessionIdentity;
  projectPath: string;
  agentSessionId?: string;
  // ...
}
```

**群聊/单聊判定流程**：
1. 新消息到达，Gateway 需要创建会话
2. Gateway 调用 `adapter.isGroupChat?(channelId)` — 仅此一次
3. Channel 未实现 `isGroupChat` → 默认 `false`（单聊）
4. 结果写入 Session 并持久化到数据库，后续直接从 Session 读取
5. FeishuChannel 不再需要 db 和 `chat_types` 表，只需实现 `isGroupChat()` 方法
6. 所有渠道共享此机制，群聊判断结果对 Gateway 层统一可用

**群聊解散处理**（根据飞书官方文档，chat_id 不会重用）：
1. FeishuChannel 在 `sendMessage()` 捕获错误码 232009（"群组已解散"）
2. 触发 `onChatDissolved` 回调通知 Gateway
3. Gateway 软删除会话：`UPDATE sessions SET deleted_at = ? WHERE channel_id = ?`
4. 用户重新拉群时使用新 chat_id，需重新配置项目绑定（无继承规则）
5. 所有会话查询默认加 `WHERE deleted_at IS NULL` 过滤
5. 不需要定期刷新 isGroup 状态（chat_id 唯一且不重用）

### 2.3 Agent Runner 层（执行层）

**核心职责**：与具体的 AI 后端交互。

**关键原则**：
- Agent Runner 接收标准化的查询请求，返回标准化的事件流
- Agent Runner 不知道消息从哪个渠道来，也不知道会话是怎么管理的
- 不同 Agent（Claude、Gemini、Codex）实现相同的核心接口，通过能力接口声明差异化能力

---

## 三、接口设计

### 3.1 Channel 接口（扩展现有 `types.ts`）

```typescript
// src/types.ts 扩展

interface ChannelAdapter {
  readonly name: string;

  // 生命周期管理（可选）
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;

  // 基础能力
  sendText(channelId: string, text: string, context?: ReplyContext): Promise<void>;
  onMessage(handler: MessageHandler): void;

  // 扩展能力（可选）
  sendFile?(channelId: string, filePath: string, context?: ReplyContext): Promise<void>;
  acknowledge?(messageId: string): Promise<void>;
  isGroupChat?(channelId: string): Promise<boolean>;

  // 群聊解散通知（可选）
  onChatDissolved?(callback: (channelId: string) => void): void;
}

interface ReplyContext {
  sessionId: string;
  threadId?: string;
  metadata?: Record<string, any>;  // 包含 messageId、rootId 等渠道特有信息
}
```

### 3.2 Agent Runner 核心接口 + 能力接口（扩展现有 `agent-runner.ts`）

```typescript
// src/core/agent-runner.ts 顶部扩展

// ── 核心接口（必须实现）──
export interface AgentRunnerInterface {
  readonly name: string;
  runQuery(request: QueryRequest): AsyncIterable<AgentEvent>;
  interrupt(sessionKey: string): Promise<void>;
  dispose?(): Promise<void>;  // 资源清理（可选）
}

// ── 可选能力接口 ──
export interface ModelSwitcher {
  setModel(model: string): void;
  getModel(): string;
  listModels(): string[];
}

export interface Compactable {
  compact(sessionId: string, agentSessionId: string, projectPath: string): Promise<boolean>;
}

export interface PermissionController {
  setMode(mode: string): void;
  getMode(): string;
  listModes(): PermissionMode[];
}

export interface PermissionMode {
  key: string;
  nameZh: string;
  description: string;
}

// ── 类型守卫 ──
export function hasModelSwitcher(agent: any): agent is ModelSwitcher {
  return typeof agent.setModel === 'function' && typeof agent.listModels === 'function';
}

export function hasPermissionController(agent: any): agent is PermissionController {
  return typeof agent.setMode === 'function' && typeof agent.listModes === 'function';
}

export function hasCompact(agent: any): agent is Compactable {
  return typeof agent.compact === 'function';
}

// ── 标准事件流 ──
export type AgentEvent =
  | { type: 'text'; text: string }                                          // 文本输出（流式 chunk 或完整块，ClaudeRunner 内部统一处理）
  | { type: 'tool_use'; name: string; input: any }                          // 工具调用开始
  | { type: 'tool_result'; name: string; result: any; isError?: boolean }   // 工具执行结果
  | { type: 'compact'; preTokens: number }                                  // 会话压缩完成
  | { type: 'complete'; agentSessionId?: string }                           // 任务完成（携带 agentSessionId 供 Gateway 持久化，不携带 result 避免与累积文本混淆）
  | { type: 'error'; error: string; errorType: 'context_too_long' | 'auth' | 'network' | 'unknown' }; // 错误（预分类，Gateway 无需重复解析）

export interface QueryRequest {
  sessionId: string;
  prompt: string;
  projectPath: string;
  agentSessionId?: string;
  images?: ImageData[];
  systemPromptAppend?: string;
}
```

---

## 四、增强模块设计

### 4.1 插件注册机制（新建 `src/core/registry.ts`）

**理由**：这是一个独立的基础设施组件，与 SessionManager 和 AgentRunner 都无直接关系，放在哪个现有文件都不合理。

**设计**：采用实例注入模式（而非静态方法），保证测试隔离、依赖显式化，支持多实例场景。注册在 `index.ts` 中集中显式完成，不依赖 import 副作用，避免 tree-shaking 风险。

```typescript
// src/core/registry.ts（~40 行）

type ChannelFactory = (config: any) => ChannelAdapter;
type AgentFactory = (config: any) => AgentRunnerInterface;

export class ChannelRegistry {
  private factories = new Map<string, ChannelFactory>();

  register(name: string, factory: ChannelFactory): void {
    this.factories.set(name, factory);
  }

  create(name: string, config: any): ChannelAdapter {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown channel: ${name}`);
    return factory(config);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }
}

export class AgentRegistry {
  private factories = new Map<string, AgentFactory>();

  register(name: string, factory: AgentFactory): void {
    this.factories.set(name, factory);
  }

  create(name: string, config: any): AgentRunnerInterface {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown agent: ${name}`);
    return factory(config);
  }
}
```

**在 `index.ts` 中显式注册**：

```typescript
// src/index.ts 顶部
import { ChannelRegistry, AgentRegistry } from './core/registry.js';
import { FeishuChannel } from './channels/feishu.js';
import { WechatChannel } from './channels/wechat.js';

const channelRegistry = new ChannelRegistry();
channelRegistry.register('feishu', (config) => new FeishuChannel(config));
channelRegistry.register('wechat', (config) => new WechatChannel(config));

const agentRegistry = new AgentRegistry();
agentRegistry.register('claude', (config) => new AgentRunner(config));

// 按需创建（注册点类型安全，factory 参数与 Channel 构造函数对齐）
if (config.channels?.feishu?.appId) {
  const channel = channelRegistry.create('feishu', config.channels.feishu);
}
```

### 4.2 能力接口（合并到现有 `agent-runner.ts`）

**理由**：AgentRunner 已有 339 行，`setModel()`/`getModel()` 已经存在（第 46-52 行），能力接口是对它的自然扩展。

```typescript
// src/core/agent-runner.ts 顶部追加接口定义（见 3.2 节）

// AgentRunner 类扩展实现 PermissionController
export class AgentRunner implements ModelSwitcher, PermissionController {
  // 现有的 setModel/getModel 已满足 ModelSwitcher
  // 新增：
  listModels(): string[] {
    return ['opus', 'sonnet', 'haiku'];
  }

  private mode: string = 'autonomous';

  setMode(mode: string): void { this.mode = mode; }
  getMode(): string { return this.mode; }
  listModes(): PermissionMode[] {
    return [
      { key: 'interactive', nameZh: '交互模式', description: '每次工具调用都需确认' },
      { key: 'autonomous', nameZh: '自主模式', description: '自动批准所有工具调用' },
    ];
  }
}
```

**CommandHandler 使用能力检查**（修改现有 `command-handler.ts`）：

```typescript
// command-handler.ts 中 /model 命令改用能力检查
import { hasModelSwitcher, hasPermissionController } from './agent-runner.js';

// 替换现有硬编码的 availableModels 数组
if (hasModelSwitcher(this.agentRunner)) {
  const models = this.agentRunner.listModels();
  // ...
}
```

### 4.3 权限审批机制（扩展现有 `utils/permission.ts`）

**理由**：`permission.ts` 已有 `canUseTool()` 黑名单逻辑（51 行），权限审批是对它的自然扩展。

**关键设计**：
- `/perm` 命令必须是快速路径命令（不进入消息队列），否则会与 `requestPermission()` 的阻塞等待形成死锁
- `cancelAll()` 方法在消息中断时主动清理所有 pending Promise，防止中断后旧 Promise 泄漏

```typescript
// src/utils/permission.ts 追加（~80 行）

interface PendingPermission {
  sessionId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class PermissionGateway {
  private pending = new Map<string, PendingPermission>();
  private timeout = 5 * 60 * 1000;

  async requestPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    mode: string,
    sendPrompt: (text: string) => Promise<void>
  ): Promise<boolean> {
    // 自主模式直接批准
    if (mode === 'autonomous') return true;

    // 先走黑名单检查
    const blacklistResult = await canUseTool(toolName, toolInput);
    if (blacklistResult.behavior === 'deny') return false;

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const summary = summarizeToolInput(toolName, toolInput);

    await sendPrompt(
      `🔐 权限请求 [${requestId}]\n工具：${toolName}\n操作：${summary}\n\n` +
      `回复 /perm ${requestId} allow 批准\n回复 /perm ${requestId} deny 拒绝`
    );

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.eventBus?.publish({ type: 'permission:timeout', sessionId, requestId });
        resolve(false);
      }, this.timeout);
      this.pending.set(requestId, { sessionId, resolve, timer });
    });
  }

  resolvePermission(sessionId: string, requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;  // 防止跨会话操作
    clearTimeout(pending.timer);
    pending.resolve(approved);
    this.pending.delete(requestId);
    return true;
  }

  /** 中断时取消指定会话的所有 pending 权限请求 */
  cancelAll(sessionId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.pending.delete(requestId);
      }
    }
  }
}

// 工具输入摘要（提取工具调用的可读描述，供权限审批和消息展示使用）
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  if (!input) return '';

  const extractors: Record<string, (i: any) => string | undefined> = {
    'Read':  (i) => i.file_path,
    'Edit':  (i) => i.file_path,
    'Write': (i) => i.file_path,
    'Bash':  (i) => i.command?.substring(0, 80),
    'Grep':  (i) => `pattern: ${i.pattern}`,
    'Glob':  (i) => `pattern: ${i.pattern}`,
    'Agent': (i) => i.description || i.prompt?.substring(0, 80),
  };

  const extractor = extractors[toolName];
  if (extractor) {
    const result = extractor(input);
    if (result) return result;
  }

  return (input as any).description
    || (input as any).file_path
    || (input as any).pattern
    || (input as any).command?.substring(0, 80)
    || (input as any).prompt?.substring(0, 80)
    || '';
}
```

### 4.4 事件系统（新建 `src/core/event-bus.ts`）

**理由**：EventBus 是 Gateway 层的核心组件，有独立的事件类型定义和订阅逻辑，不适合塞进 session-manager.ts（已 786 行）。

**设计目标**：事件系统的主要消费者是**外部程序**，用于监控面板、日志审计、自定义 UI 等场景。外部程序需要完整追踪 EvolClaw 的执行过程，因此事件需要覆盖从消息接收到任务完成的完整生命周期。

**EventBus 功能**：在 EventEmitter 基础上提供 wildcard 订阅（`subscribe('*', handler)` 监听所有事件）和前缀订阅（`subscribePrefix('session:', handler)` 监听所有会话事件），便于外部程序按需订阅。

```typescript
// src/core/event-bus.ts（~100 行）

import { EventEmitter } from 'events';

// ── 系统事件（3 个）──
export type SystemEvent =
  | { type: 'system:started'; channels: string[]; timestamp: number }
  | { type: 'system:shutdown'; reason: string }
  | { type: 'system:restart'; channel: string; channelId: string };

// ── 渠道事件（3 个）──
export type ChannelEvent =
  | { type: 'channel:connected'; channel: string }
  | { type: 'channel:disconnected'; channel: string; reason?: string }
  | { type: 'channel:owner-bound'; channel: string; userId: string };

// ── 会话事件（8 个）──
export type SessionEvent =
  | { type: 'session:created'; sessionId: string; channel: string; channelId: string; isGroup: boolean; threadId?: string }
  | { type: 'session:switched'; sessionId: string; fromSessionId: string; toSessionId: string }
  | { type: 'session:deleted'; sessionId: string }
  | { type: 'session:renamed'; sessionId: string; oldName: string; newName: string }
  | { type: 'session:forked'; sessionId: string; sourceSessionId: string; name?: string }
  | { type: 'session:imported'; sessionId: string; agentSessionId: string; projectPath: string }
  | { type: 'session:safe-mode-entered'; sessionId: string; consecutiveErrors: number }
  | { type: 'session:safe-mode-exited'; sessionId: string };

// ── 项目事件（2 个）──
export type ProjectEvent =
  | { type: 'project:switched'; sessionId: string; fromProject: string; toProject: string }
  | { type: 'project:bound'; sessionId: string; projectPath: string };

// ── 消息事件（6 个）──
export type MessageEvent =
  | { type: 'message:received'; sessionId: string; channel: string; channelId: string; content: string; userId?: string }
  | { type: 'message:processing'; sessionId: string }
  | { type: 'message:text'; sessionId: string; text: string; isFinal: boolean }
  | { type: 'message:complete'; sessionId: string; finalText: string; durationMs: number }
  | { type: 'message:error'; sessionId: string; error: string; errorType: string }
  | { type: 'message:interrupted'; sessionId: string };

// ── 工具事件（3 个）──
export type ToolEvent =
  | { type: 'tool:start'; sessionId: string; toolName: string; input: string }
  | { type: 'tool:complete'; sessionId: string; toolName: string }
  | { type: 'tool:error'; sessionId: string; toolName: string; error: string };

// ── 权限事件（3 个）──
export type PermissionEvent =
  | { type: 'permission:requested'; sessionId: string; requestId: string; toolName: string; input: string }
  | { type: 'permission:resolved'; sessionId: string; requestId: string; approved: boolean }
  | { type: 'permission:timeout'; sessionId: string; requestId: string };

// ── Agent 运行事件（5 个）──
export type AgentEvent =
  | { type: 'agent:compact-start'; sessionId: string }
  | { type: 'agent:compact-complete'; sessionId: string; preTokens: number }
  | { type: 'agent:model-changed'; oldModel: string; newModel: string }
  | { type: 'agent:idle-timeout'; sessionId: string; idleSec: number }
  | { type: 'agent:file-sent'; sessionId: string; filePath: string; channel: string };

// ── 自愈事件（3 个）──
export type SelfHealEvent =
  | { type: 'self-heal:started'; reason: string }
  | { type: 'self-heal:attempt'; attemptNumber: number; maxAttempts: number }
  | { type: 'self-heal:completed'; success: boolean; attempts: number };

export type GatewayEvent =
  | SystemEvent
  | ChannelEvent
  | SessionEvent
  | ProjectEvent
  | MessageEvent
  | ToolEvent
  | PermissionEvent
  | AgentEvent
  | SelfHealEvent;

export class EventBus extends EventEmitter {
  publish(event: GatewayEvent): void {
    // 逐个调用 handler，错误隔离到单个 handler 粒度
    const handlers = [
      ...this.listeners(event.type),
      ...this.listeners('*'),
    ];
    for (const handler of handlers) {
      try {
        (handler as (event: GatewayEvent) => void)(event);
      } catch (err) {
        console.error(`[EventBus] Handler error for ${event.type}:`, err);
      }
    }
  }

  subscribe(eventType: string, handler: (event: GatewayEvent) => void): void {
    this.on(eventType, handler);
  }

  /** 监听所有事件 */
  subscribeAll(handler: (event: GatewayEvent) => void): void {
    this.on('*', handler);
  }

  /** 按前缀订阅（如 'session:' 监听所有会话事件） */
  subscribePrefix(prefix: string, handler: (event: GatewayEvent) => void): void {
    this.on('*', (event: GatewayEvent) => {
      if (event.type.startsWith(prefix)) handler(event);
    });
  }

  unsubscribe(eventType: string, handler: (event: GatewayEvent) => void): void {
    this.off(eventType, handler);
  }
}
```

---

## 五、GatewayEvent 完整列表

事件系统的主要消费者是**外部程序**（监控面板、日志审计、自定义 UI），事件需要覆盖完整的执行生命周期。

### 系统事件（3 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `system:started` | 所有渠道连接完成，ready signal 写入 | index.ts |
| `system:shutdown` | 收到 SIGTERM/SIGINT，开始优雅关闭 | index.ts |
| `system:restart` | /restart 命令触发重启流程 | CommandHandler |

### 渠道事件（3 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `channel:connected` | 单个渠道连接成功 | index.ts |
| `channel:disconnected` | 单个渠道断开（正常关闭或异常） | index.ts |
| `channel:owner-bound` | 首次交互自动绑定渠道 owner | index.ts |

### 会话事件（8 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `session:created` | 新会话创建（含线程会话） | SessionManager |
| `session:switched` | 切换到另一个会话 | CommandHandler |
| `session:deleted` | 会话解绑删除 | CommandHandler |
| `session:renamed` | 会话重命名 | CommandHandler |
| `session:forked` | 会话分支创建 | CommandHandler |
| `session:imported` | CLI 会话导入 | CommandHandler |
| `session:safe-mode-entered` | 连续错误达阈值进入安全模式 | MessageProcessor |
| `session:safe-mode-exited` | /repair 修复后退出安全模式 | CommandHandler |

### 项目事件（2 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `project:switched` | 切换项目 | CommandHandler |
| `project:bound` | /bind 绑定新项目目录 | CommandHandler |

### 消息事件（6 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `message:received` | 收到用户消息（含文本、图片、文件） | MessageProcessor |
| `message:processing` | 开始处理消息（出队） | MessageProcessor |
| `message:text` | Agent 输出文本 | MessageProcessor |
| `message:complete` | 消息处理完成 | MessageProcessor |
| `message:error` | 处理出错 | MessageProcessor |
| `message:interrupted` | 被新消息中断 | MessageQueue |

### 工具事件（3 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `tool:start` | 工具开始执行 | MessageProcessor |
| `tool:complete` | 工具执行成功 | MessageProcessor |
| `tool:error` | 工具执行失败或权限拒绝 | MessageProcessor |

### 权限事件（3 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `permission:requested` | interactive 模式请求权限审批 | PermissionGateway |
| `permission:resolved` | 用户批准/拒绝 | PermissionGateway |
| `permission:timeout` | 权限请求超时未响应 | PermissionGateway |

### Agent 运行事件（5 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `agent:compact-start` | 会话压缩开始（手动或自动） | MessageProcessor |
| `agent:compact-complete` | 会话压缩完成 | MessageProcessor |
| `agent:model-changed` | 模型切换 | CommandHandler |
| `agent:idle-timeout` | 流式空闲超时被终止 | MessageProcessor |
| `agent:file-sent` | 文件发送给用户 | MessageProcessor |

### 自愈事件（3 个）

| 事件 | 触发时机 | 发布位置 |
|------|---------|---------|
| `self-heal:started` | restart-monitor 检测到启动失败，开始自愈 | cli.ts |
| `self-heal:attempt` | 单次自愈尝试（Claude 诊断+修复） | cli.ts |
| `self-heal:completed` | 自愈成功或全部失败 | cli.ts |

**总计 36 个事件**

### 事件流示例

用户发送"帮我创建一个文件"的完整事件流：

```
message:received    { sessionId, content: "帮我创建一个文件", channel: "feishu" }
message:processing  { sessionId }
message:text        { sessionId, text: "好的，我来创建文件。", isFinal: false }
tool:start          { sessionId, toolName: "Write", input: "/path/to/file.txt" }
tool:complete       { sessionId, toolName: "Write" }
message:text        { sessionId, text: "文件已创建完成。", isFinal: false }
message:complete    { sessionId, finalText: "好的，我来创建文件。文件已创建完成。", durationMs: 1234 }
```

### 后台任务的事件发布策略

当用户切换项目后，之前项目的正在处理的消息变成后台任务：
- **GatewayEvent 仍然发布**：外部监控需要知道后台任务的状态
- **Channel 不发送消息**：后台任务结果缓存到 MessageCache，用户切回时推送

---

## 六、关键设计决策

### 6.1 回复上下文传递

传递轻量的 `ReplyContext`，而不是整个 Session 对象：
- Gateway 不知道 metadata 里有什么，只负责透传
- Channel 从 metadata 提取自己需要的信息（例如飞书提取 rootId 用于话题回复定位）
- `messageId` 通过 `Message.messageId` 传递，在 MessageProcessor 中设置到 metadata
- 消除 `session.metadata.feishu.rootId` 这类跨层泄漏

### 6.2 多 Agent Runner 路由

AgentRegistry 实例注入，动态创建和路由：
- 初始化时在 index.ts 显式注册：`agentRegistry.register('claude', factory)`
- 使用时查找：`agentRegistry.create(session.agentType, config)`
- 添加新 Agent 只需实现接口并注册

### 6.3 队列 key 生成

由 SessionManager 统一管理：
- 话题会话：使用 `session.id`（唯一且不变）
- 主会话：使用 `channel-channelId`（稳定，不受项目切换影响）

### 6.4 Agent 事件流标准化

定义核心事件类型，ClaudeRunner 负责转换：
- 核心事件：`text`、`tool_use`、`tool_result`、`compact`、`complete`、`error`
- `text` 事件统一处理流式 chunk 和完整块（ClaudeRunner 内部决定来源，Gateway 无需区分）
- `complete` 事件**不携带 result**，只携带 `agentSessionId`（Gateway 使用 flusher 累积的文本，避免混淆）
- `error` 事件携带 `errorType` 预分类，MessageProcessor 直接读取字段，无需重复解析 SDK 错误
- ClaudeRunner 的 compact 能力作为可选接口，MessageProcessor 检查能力后决定是否重试
- SDK 的 `system/task_progress` 事件继续由 ClaudeRunner 转发，不需要新增 `progress` 事件类型

### 6.5 自动 compact 重试

collect 重试逻辑留在 MessageProcessor（Gateway 层），不下沉到 Agent Runner：
- **决策属于 Gateway**：是否重试、是否通知用户、失败后进入安全模式，这些是业务策略
- **Agent Runner 只提供能力**：`compact?()` 作为可选接口，不同 Agent（Gemini 等）可以不实现

```typescript
// MessageProcessor 中的重试逻辑（接口不变，仅替换能力检查方式）
if (event.errorType === 'context_too_long' && hasCompact(agent)) {
  const compacted = await agent.compact(session.id, session.agentSessionId, projectPath);
  if (compacted) { /* 重新调用 runQuery 重试 */ }
}
```

### 6.6 StreamFlusher 与 IdleMonitor 集成

两者不需要改动，只修改 MessageProcessor 的事件消费循环：
- 消费 `AgentEvent` 替代原来的 SDK 原始事件
- `text` 事件 → `flusher.addText(event.text)`
- `tool_use` 事件 → `flusher.addActivity()`
- `tool_result` 且 isError → `flusher.addActivity(⚠️)`
- `complete` 事件 → `flusher.flush(true)` + 持久化 agentSessionId
- 任何事件到达 → `idleMonitor.reset(event.type)`
- 去掉 `hasTextDelta` 标记（AgentRunner 内部统一处理，外部不需要区分）
- `complete` 事件不使用 result 字段，Gateway 使用 flusher 累积的文本

**IdleMonitor 空闲判定**：
- 监听 AgentEvent 流，任何事件到达即重置计时器
- 超时阈值沿用现有配置（默认 120s）
- 超时触发 `agent:idle-timeout` 事件 + 中断当前 Agent stream
- 用户在 flusher 延迟窗口内发送新消息时，中断机制（MessageQueue）会立即触发 flush 并终止当前任务

### 6.8 Gateway 消息去重

网络抖动或 WebSocket 重连可能导致 Channel 层重复推送同一条消息。Gateway 在 MessageQueue 入队前基于 `messageId` 去重：

```typescript
// MessageQueue 或 MessageProcessor 中
private recentMessageIds = new Set<string>();
private readonly DEDUP_WINDOW = 60_000; // 1 分钟窗口

shouldProcess(message: Message): boolean {
  if (!message.messageId) return true; // 无 ID 的消息不去重
  if (this.recentMessageIds.has(message.messageId)) return false;
  this.recentMessageIds.add(message.messageId);
  setTimeout(() => this.recentMessageIds.delete(message.messageId), this.DEDUP_WINDOW);
  return true;
}
```

- 仅对有 `messageId` 的消息生效（Channel 层负责提供）
- 1 分钟滑动窗口，内存开销极低
- 不影响用户主动重发（不同 messageId）

### 6.7 PermissionGateway 中断安全

`/perm` 命令必须是快速路径命令（加入 `quickCommandPrefixes`），绕过消息队列直接处理，避免死锁。

中断流程：
```typescript
// 新消息触发中断时
async onInterrupt(sessionId: string) {
  permissionGateway.cancelAll(sessionId);  // 先取消 pending permissions
  await agentRunner.interrupt(sessionId);  // 再中断 Agent stream
}
```

---

## 七、文件变更清单

### 新建文件（3 个）

| 文件 | 代码量 | 理由 |
|------|-------|------|
| `src/core/registry.ts` | ~40 行 | 独立基础设施，与任何现有文件无关 |
| `src/core/event-bus.ts` | ~100 行 | 36 个事件类型定义 + EventBus 类（逐 handler 错误隔离 + wildcard/prefix 订阅），不宜塞进 session-manager（786 行） |
| `src/core/permission.ts` | ~90 行 | PermissionGateway 类（含 cancelAll），有状态的 Gateway 层组件 |

### 修改文件（7 个）

| 文件 | 当前行数 | 变更 | 说明 |
|------|---------|------|------|
| `src/types.ts` | 106 | +20 行 | 扩展 ChannelAdapter 接口（ReplyContext、MessageHandler）；Session 增加 isGroup、deleted_at 字段 |
| `src/core/agent-runner.ts` | 339 | +70 行 | 追加 AgentRunnerInterface、AgentEvent 类型、能力接口（ModelSwitcher、Compactable、hasCompact）；complete/error 事件携带 agentSessionId/errorType |
| `src/utils/permission.ts` → `src/utils/permission-utils.ts` | 51 | 重命名 | 保留 canUseTool() + summarizeToolInput()（无状态工具函数） |
| `src/core/message-processor.ts` | 721 | +25/-20 行 | processEventStream 改为消费标准 AgentEvent；去除 SDK 事件硬编码；集成 PermissionGateway；发布 GatewayEvent；添加中断时 cancelAll；import 改为 permission-utils |
| `src/core/command-handler.ts` | 1049 | +40/-10 行 | /model /mode 改用能力检查；新增 /perm 快速路径命令；发布 project/session/agent 事件 |
| `src/index.ts` | 413 | -200/+80 行 | 用 ChannelRegistry/AgentRegistry 实例替换硬编码创建；统一 onMessage 模板；Session 创建时写入 isGroup；发布 channel/system 事件 |
| `bin/evolclaw` | - | 修改 import | 更新 cli.ts 路径为 utils/cli.ts |

### 移动文件（2 个）

| 原路径 | 新路径 | 理由 |
|--------|--------|------|
| `src/utils/platform.ts` | `src/platform.ts` | 跨层基础设施，与 config.ts、paths.ts、types.ts 同级 |
| `src/cli.ts` | `src/utils/cli.ts` | 服务管理工具，非核心业务逻辑，归入 utils |

### 不变文件

- `src/core/session-manager.ts` - 仅添加 isGroup、deleted_at 字段到 Session schema（数据库 migration）；所有查询默认加 `WHERE deleted_at IS NULL`
- `src/core/message-queue.ts` - 不变
- `src/core/message-stream.ts` - 不变
- `src/core/message-cache.ts` - 不变
- `src/utils/stream-flusher.ts` - 不变
- `src/utils/stream-idle-monitor.ts` - 不变（MessageProcessor 运行时监控，职责单一）
- `src/utils/session-file-health.ts` - 不变（/repair 命令辅助工具，按需 dynamic import）
- `src/channels/feishu.ts` - 移除 db 参数；isGroupChat() 方法替代 chat_types 表；合并 `markdown-to-feishu.ts`（唯一调用者，纯渠道内部实现）
- `src/channels/wechat.ts` - 不变

### 删除文件（1 个）

- `src/utils/markdown-to-feishu.ts` - 合并到 `src/channels/feishu.ts`（飞书 Markdown → post 富文本转换属于 Channel 层"怎么发"的职责）

### 代码量统计

| 项目 | 数量 |
|------|------|
| 新建文件 | 3 个（~230 行） |
| 修改文件 | 7 个 |
| 移动文件 | 2 个 |
| 删除文件 | 1 个 |
| 新增代码 | ~325 行 |
| 删除代码 | ~230 行 |
| **净增代码** | **~95 行** |
| GatewayEvent 类型 | 36 个 |

---

## 八、实施计划

### 阶段 1：接口定义 + 插件注册（2-3 小时）

1. 新建 `src/core/registry.ts`（实例模式，非静态）
2. 扩展 `src/types.ts`：ReplyContext、MessageHandler；Session 增加 isGroup 字段
3. 扩展 `src/core/agent-runner.ts`：AgentRunnerInterface、AgentEvent（含 agentSessionId/errorType）、能力接口
4. 重构 `src/index.ts`：创建 ChannelRegistry/AgentRegistry 实例，显式注册所有 Channel/Agent，统一 onMessage 模板，Session 创建时写入 isGroup
5. FeishuChannel 移除 db 参数，改用 isGroupChat() 方法
6. SessionManager 添加 isGroup、deleted_at 字段的数据库 migration；所有查询默认过滤 `deleted_at IS NULL`

**验证**：启动服务，确认所有渠道正常工作，群聊判断正确

### 阶段 2：事件系统（1-2 小时）

1. 新建 `src/core/event-bus.ts`（36 个事件类型 + 逐 handler 错误隔离 + wildcard/prefix 订阅）
2. MessageProcessor 发布 message:*/tool:*/agent:* 事件
3. CommandHandler 发布 session:*/project:*/agent:model-changed 事件
4. SessionManager 发布 session:created
5. index.ts 发布 system:*/channel:* 事件
6. cli.ts 发布 self-heal:* 事件

**验证**：subscribeAll 订阅，日志确认 35 类事件正常发布

### 阶段 3：权限审批 + 工具摘要（2-3 小时）

1. 扩展 `src/utils/permission.ts`：PermissionGateway（含 cancelAll）+ summarizeToolInput
2. MessageProcessor 集成权限检查，中断时调用 cancelAll
3. MessageProcessor 替换 formatToolDescription 为 summarizeToolInput
4. CommandHandler 添加 /perm 为快速路径命令

**验证**：测试 interactive/autonomous 模式；测试中断时 pending permission 正确取消

### 阶段 4：能力接口 + 命令重构（1-2 小时）

1. AgentRunner 实现 ModelSwitcher、PermissionController、compact 可选接口
2. CommandHandler /model 改用 hasModelSwitcher
3. CommandHandler /mode 改用 hasPermissionController
4. MessageProcessor 自动 compact 重试改用 hasCompact 能力检查

**验证**：测试 /model、/mode 命令；测试上下文过长自动 compact 重试

---

## 九、迁移策略

**直接重构，不考虑向后兼容**：
- 数据库 schema：Session 表增加 isGroup 字段（自动 migration，默认 false）和 deleted_at 字段（自动 migration，默认 NULL）
- JSONL 会话文件继续由 Agent Runner 层使用
- 配置文件格式（evolclaw.json）保持不变

---

## 十、风险控制

| 风险 | 级别 | 应对措施 |
|------|------|----------|
| index.ts 重构范围大 | 高 | 先提取统一 onMessage 模板，再引入 Registry 实例 |
| PermissionGateway 跨会话操作 | 中 | resolvePermission 增加 sessionId 校验（pending.sessionId === sessionId） |
| EventBus 订阅者异常阻塞 | 中 | publish 逐个调用 handler 并 try-catch 隔离，单个 handler 异常不影响其他 handler |
| Agent 事件流不兼容 | 中 | 定义最小公共集，ClaudeRunner 做事件转换；errorType 预分类减少 Gateway 解析 |
| FeishuChannel 移除 db 后群聊判断性能 | 低 | isGroupChat() 每个 channelId 只在 Session 创建时调用一次，后续从 Session 读取 |
| 群聊解散后会话失效 | 低 | FeishuChannel 捕获错误码 232009，触发 onChatDissolved 回调，Gateway 软删除会话（`deleted_at` 时间戳） |

---

## 十一、方案更新记录（2026-03-30）

本次更新基于代码核实和设计评审，修正了以下关键点：

### 接口设计优化

1. **ChannelAdapter 增强**：
   - 新增 `connect()` / `disconnect()` 生命周期管理（可选）
   - 新增 `onChatDissolved()` 群聊解散通知回调（可选）
   - `ReplyContext.metadata` 注释说明包含 messageId、rootId 等渠道特有信息

2. **AgentRunnerInterface 增强**：
   - 新增 `dispose()` 资源清理方法（可选）

3. **AgentEvent 修正**：
   - `complete` 事件移除 `result` 字段，避免与 flusher 累积文本混淆
   - 注释说明 Gateway 使用 flusher 累积的文本作为最终输出

### 核心逻辑修正

4. **PermissionGateway 安全加固**：
   - `resolvePermission()` 增加 `sessionId` 参数和校验
   - 防止跨会话操作（用户 A 批准用户 B 的权限请求）

5. **EventBus 错误隔离**：
   - `publish()` 方法用 try-catch 包裹每个 `emit()` 调用
   - 防止单个订阅者异常阻塞其他订阅者

6. **群聊解散处理机制**：
   - 根据飞书官方文档确认：chat_id 唯一且不重用
   - FeishuChannel 捕获错误码 232009（"群组已解散"）
   - 触发 `onChatDissolved` 回调通知 Gateway 标记会话失效
   - 不需要定期刷新 isGroup 状态

### 设计决策澄清

7. **messageId 传递**：
   - 确认通过 `Message.messageId` 传递，在 MessageProcessor 中设置到 metadata
   - `ReplyContext` 不需要单独的 messageId 字段

8. **progress 事件**：
   - 确认不需要新增 `progress` 事件类型
   - SDK 的 `system/task_progress` 事件继续由 ClaudeRunner 转发

9. **complete 事件时机**：
   - 确认当前策略正确：flusher 累积文本，complete 触发 flush
   - `complete` 事件只携带 `agentSessionId`，不携带 `result`

### 风险控制更新

10. **风险清单调整**：
    - 移除"PermissionGateway 死锁"（通过 sessionId 校验解决）
    - 移除"事件系统内存泄漏"（EventEmitter 成熟机制）
    - 新增"PermissionGateway 跨会话操作"风险及应对
    - 新增"EventBus 订阅者异常阻塞"风险及应对
    - 新增"群聊解散后会话失效"风险及应对

### 核实依据

- 代码审查：确认 messageId、complete 事件、群聊判断的当前实现
- 飞书官方文档：确认 chat_id 唯一性和解散后不重用
- Node.js EventEmitter 测试：确认异常会阻塞后续 handler

**更新后评分**：9.5/10（原 9/10）

### 第二轮更新（2026-03-30）

基于设计评审反馈，补充以下改进：

11. **EventBus 错误隔离升级**：
    - `publish()` 从 `emit()` + try-catch 改为逐个调用 handler + try-catch
    - 确保单个 handler 异常不影响同事件类型的其他 handler（`emit()` 只能隔离到事件级别）

12. **PermissionGateway 超时通知**：
    - 新增 `permission:timeout` 事件（总事件数 35 → 36）
    - 超时时发布事件，Gateway 层可据此清理 UI 状态（如移除 Feishu 审批卡片）

13. **群聊解散处理明确化**：
    - 解散后软删除会话：`UPDATE sessions SET deleted_at = ? WHERE channel_id = ?`
    - 保留历史记录，所有查询默认加 `WHERE deleted_at IS NULL` 过滤
    - 重新拉群使用新 chat_id，需重新配置项目绑定，无继承规则

14. **Gateway 消息去重**：
    - MessageQueue 入队前基于 `messageId` 去重（1 分钟滑动窗口）
    - 防止网络抖动或 WebSocket 重连导致重复处理

15. **StreamFlusher/IdleMonitor 集成细节**：
    - IdleMonitor 监听 AgentEvent 流，任何事件重置计时器
    - 用户在 flusher 延迟窗口内发新消息时，中断机制立即触发 flush
