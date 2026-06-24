# 响应模式插件化架构设计

## 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | 响应模式插件化架构设计 |
| 版本 | v2.0 |
| 状态 | ✅ Phase 6 已实现 |
| 最后更新 | 2026-06-24 |
| 适用读者 | 架构师、核心开发者、插件开发者 |

---

## ⚠️ 重要更新（v2.0）

**Phase 6 已完成**（2026-06-24）：响应模式系统核心架构已实现并上线。

**已实现部分**：
- ✅ 响应层完整实现（Registry/Resolver/Coordinator/ContextBuilder/ResponseEngine）
- ✅ 2 个内置模式上线（InteractiveMode, ProactiveMode）
- ✅ 配置体系接入（response_modes 配置块）
- ✅ MessageProcessor 归档，ResponseEngine 为默认引擎
- ✅ 快照验证通过

**未实现部分**（设计保留，未来实现）：
- 🔄 调度层（SlotManager）- 设计完整，Phase 7 预留，当前不实施
- 🔄 更多内置模式（8 个占位模式待实现）
- 🔄 扩展插件机制（npm 包发现与加载）
- 🔄 CLI 命令支持（ec response list/info/set/config/current）

**相关文档**：
- [phase6-architecture-decisions.md](./phase6-architecture-decisions.md)：架构决策记录（ADR）
- [migration-complete.md](./migration-complete.md)：迁移完成报告
- [phase6-completion-and-next-steps.md](./phase6-completion-and-next-steps.md)：后续计划

---

---

## 一、为什么需要响应模式插件化？

### 1.1 当前痛点

EvolClaw 当前的会话响应机制存在以下问题：

#### 问题 1：响应策略硬编码

当前只有两种响应模式（`interactive`/`proactive`），且决定逻辑散落在多处：

- `session-manager.ts` 的 `resolveDefaultChatMode()` 决定默认模式
- `message-processor.ts` 中有运行时强制 proactive 的逻辑
- 各 channel 适配器中有 dispatch 过滤逻辑

新增一种响应模式需要修改多处代码，违反开放封闭原则。

#### 问题 2：队列机制固定

所有会话共享同一个 `MessageQueue`，只支持 FIFO + 优先级插队。无法实现：

- LIFO（后进先出）
- 根据消息内容动态排序
- 根据相关性过滤后入队

#### 问题 3：缺乏资源控制

Agent 像一个被动的服务器：消息来了就入队、排队处理。无法控制：

- 同时处理的会话数量
- 全局 token 预算
- 会话优先级动态调整

#### 问题 4：无法应对复杂场景

不同会话场景需要不同的响应机制，但当前架构无法支持：

- **繁忙群聊**：需要辅助会话判断消息相关性
- **任务群**：需要工作流式的顺序处理
- **工作群**：需要注入群规则文档作为上下文

### 1.2 设计目标

| 目标 | 说明 |
|------|------|
| **插件化** | 响应模式是可插拔的模块，新增模式不改核心代码 |
| **灵活队列** | 每个响应模式可以有自己的队列实现 |
| **智能调度** | 支持规则驱动、AI 驱动、混合三种调度策略 |
| **易扩展** | 实现标准接口即可开发新模式 |
| **可配置** | 不同会话/对端/群可以使用不同的模式和配置 |
| **可观测** | 提供命令行和前端查看/切换模式的能力 |

---

## 二、整体架构

### 2.1 三层架构

```
┌─────────────────────────────────────────────┐
│  调度层（Scheduling Layer）                   │
│  ─────────────────────────────────────────   │
│  问题域：哪些会话能运行？资源够吗？            │
│                                               │
│  - Slot 分配与释放                            │
│  - 调度策略（规则/AI/混合）                    │
│  - 全局预算控制                               │
│  - 并发控制                                   │
└────────────────┬────────────────────────────┘
                 │ 分配 slot 的会话
                 ↓
┌─────────────────────────────────────────────┐
│  响应层（Response Layer）                     │
│  ─────────────────────────────────────────   │
│  问题域：这个会话怎么处理消息？                │
│                                               │
│  - 入站处理策略（处理/丢弃/插队/清空）         │
│  - 出站发送策略（直接发/工具调用/缓冲）        │
│  - 队列管理（每个模式自己的队列）              │
│  - 扩展机制（辅助会话/线索追踪/工作流）        │
└────────────────┬────────────────────────────┘
                 │ 具体的执行指令
                 ↓
┌─────────────────────────────────────────────┐
│  执行层（Infrastructure Layer）               │
│  ─────────────────────────────────────────   │
│  问题域：执行具体的收发和模型调用              │
│                                               │
│  - Agent Runner（模型调用，已插件化）         │
│  - Channel Adapter（消息收发，已插件化）      │
│  - DecisionExecutor（执行响应模式的决策）     │
└─────────────────────────────────────────────┘
```

### 2.2 为什么是三层？

#### 三个不同的问题域

每一层回答一个独立的问题：

| 层 | 核心问题 | 关注点 | 类比 |
|----|----------|--------|------|
| **调度层** | Which sessions can run? | 资源分配、并发、预算 | 操作系统的进程调度器 |
| **响应层** | How to handle this session? | 处理策略、发送策略、队列 | 应用程序的业务逻辑 |
| **执行层** | Execute the instructions | 模型调用、消息收发 | 硬件驱动 |

#### 为什么不能合并？

**调度层 vs 响应层不能合并**：

- 调度层关心"还有多少 token 预算"，但不关心"这个消息是否相关"
- 响应层关心"这个消息怎么处理"，但不关心"是否有空闲 slot"
- 例：`dual-session` 模式判断消息相关性（响应层职责），但不关心全局预算（调度层职责）

**响应层 vs 执行层不能合并**：

- 响应层做"决策"（决定怎么处理）
- 执行层做"执行"（实际收发消息、调用模型）
- 例：`workflow` 模式决定"按什么顺序处理任务"（响应层），但不关心"MessageQueue 的具体实现"（执行层）

### 2.3 分层的好处

1. **职责清晰**：每层只关心自己的问题域，认知负担低
2. **独立演进**：改 Slot 调度算法不影响响应模式；新增响应模式不影响基础设施
3. **可测试性**：每层可以独立测试，mock 上下层依赖
4. **复用性**：所有响应模式共享同一套执行层基础设施

### 2.4 插件化范围

| 层 | 插件化策略 | 理由 |
|----|-----------|------|
| **调度层** | 单一实现 + 预留接口 | 调度算法复杂，错误风险高；大部分场景用默认即可。预留 `SchedulingStrategy` 接口供未来扩展 |
| **响应层** | 完全插件化 ✅ | 需求多样性高，变化频繁，是核心价值所在 |
| **执行层** | 已有模块化 | Runner（claude/codex/gemini）、Channel（aun/feishu/wechat）已是插件架构 |

**关键决策**：只有响应层完全插件化。调度层和执行层保持现状，但预留扩展点。

**为什么不全部插件化？**

- ❌ **过度设计**：80% 的场景用不到三层都自定义
- ❌ **复杂度爆炸**：三层插件组合数 = N × M × K，测试和维护成本指数级增长
- ❌ **容易乱**：用户不知道该选哪个插件组合
- ❌ **调试困难**：出问题时不知道是哪一层的插件

---

## 三、响应层设计（核心）

### 3.1 设计思路

#### 核心抽象：响应模式 = 决策器

响应模式的本质是一个**决策器**，它回答两个核心问题：

1. **入站**：收到消息怎么办？（处理/丢弃/插队/清空队列）
2. **出站**：要发送消息怎么办？（直接发/工具调用/缓冲批量发）

**关键原则：决策与执行分离**

- 响应模式只做**决策**（返回 Decision 对象）
- 执行层负责**执行**（实际操作队列、发送消息）

为什么这样设计？

- **可测试**：决策逻辑是纯函数，易于单元测试
- **解耦**：响应模式不依赖执行层的具体实现
- **统一**：所有响应模式遵循同样的"决策 → 执行"流程

#### 队列在响应层

**重要变化**：队列管理放在响应层，每个响应模式可以有自己的队列实现。

为什么？

- 不同模式需要不同的队列机制：
  - `interactive`：FIFO
  - `dual-session`：按相关性排序的优先级队列
  - `batch-processing`：攒批队列
- 队列行为是"响应策略"的一部分，应该由响应模式控制

同时提供**默认队列实现**（FIFO/LIFO/Priority），简单模式直接复用，无需重复造轮子。

### 3.2 ResponseMode 接口

#### 数据类型定义

```typescript
/**
 * 入站消息（由 Channel Adapter 构造）
 */
interface InboundMessage {
  messageId?: string;
  peerId: string;
  content: string;
  chatType: 'private' | 'group';
  attachments?: Attachment[];
  /** 提及的 AID 列表（群聊场景） */
  mentionAids?: string[];
  /** 是否提及了本 agent（由 Channel 标记，响应模式据此判断是否响应） */
  isMentioned?: boolean;
  metadata?: Record<string, any>;
}

/**
 * 出站内容（由 Agent Runner 产生，传递给响应模式）
 */
interface OutboundPayload {
  /**
   * 内容类型：
   *   - text: 普通文本
   *   - tool-call: 工具调用
   *   - tool-result: 工具结果
   *   - thought: 思考过程
   *   - image/file: 富媒体
   */
  kind: 'text' | 'tool-call' | 'tool-result' | 'thought' | 'image' | 'file';
  content: string | Buffer;
  /** 便捷判断，等价于 kind === 'tool-call' */
  isToolCall?: boolean;
  metadata?: Record<string, any>;
}
```

#### 核心接口

```typescript
/**
 * 响应模式接口
 * 所有响应模式必须实现此接口
 */
interface ResponseMode {
  // ─── 元数据 ───
  /** 模式唯一标识（如 'interactive'） */
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
  readonly configSchema: JSONSchema;

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
}
```

#### 为什么这样设计接口？

**元数据字段**：

- `id`：唯一标识，用于注册、查找、配置引用
- `displayName`：与 `id` 分离，便于国际化和前端展示
- `configSchema`：用 JSON Schema 描述配置，前端可以据此自动生成配置表单，后端可以据此校验配置
- `applicableScenes`：声明适用场景，避免在群聊使用私聊专属模式

**生命周期方法**：

- `initialize()`：会话首次使用此模式时调用，注入依赖、准备资源（如辅助会话）
- `cleanup()`：切换模式或会话结束时调用，释放资源

**核心能力方法**：

- `handleInbound()` / `handleOutbound()`：决策器的核心，返回决策对象
- `getQueue()`：暴露队列，让执行层知道用哪个队列取消息

### 3.3 决策对象设计

#### 入站决策（InboundDecision）

```typescript
/**
 * 入站决策：告诉执行层"这条消息怎么办"
 */
interface InboundDecision {
  /** 处理动作 */
  action: 'process' | 'drop' | 'defer';

  /**
   * 队列行为（仅 action='process' 时有效）
   * 注：队列已在响应模式内部，此字段描述如何入队
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
```

#### 出站决策（OutboundDecision）

```typescript
/**
 * 出站决策：告诉执行层"这个输出怎么发"
 */
interface OutboundDecision {
  /** 发送方式 */
  method: 'direct' | 'tool-required' | 'buffered' | 'suppress' | 'custom';

  /**
   * 缓冲配置（仅 method='buffered' 时有效）
   */
  bufferConfig?: {
    /** 缓冲区最大字节数 */
    maxBytes: number;
    /** 刷新间隔（毫秒） */
    flushInterval: number;
  };

  /** 是否加密发送 */
  encrypted?: boolean;

  /**
   * 调度提示（可选，预留给未来调度层）
   * 响应模式可建议处理完本条消息后的动作：
   *   - continue: 继续处理下一条
   *   - switch: 切换到其他会话
   *   - pause: 暂停等待（如预算耗尽）
   * 当前阶段被忽略；未来调度层上线时可参考此提示（非强制）。
   */
  yieldHint?: 'continue' | 'switch' | 'pause';

  /**
   * 自定义发送器（逃生舱）
   */
  customSender?: (payload: OutboundPayload, context: ResponseModeContext) => Promise<void>;
}
```

#### 为什么用决策对象而非直接执行？

**对比两种设计**：

```typescript
// 设计 A：响应模式直接执行（不推荐）
async handleInbound(message) {
  this.queue.enqueue(message);        // 直接操作队列
  this.runner.switchModel('haiku');   // 直接调用 runner
}

// 设计 B：响应模式返回决策（推荐）
async handleInbound(message): Promise<InboundDecision> {
  return {
    action: 'process',
    queueBehavior: 'enqueue',
    instructions: { switchModel: 'haiku' }
  };
}
```

**设计 B 的优势**：

1. **可测试**：决策是纯数据，测试时只需断言返回值，无需 mock 队列和 runner
2. **可审计**：所有决策可以记录日志，便于追踪"为什么这条消息被丢弃"
3. **解耦**：响应模式不依赖执行层的具体方法签名
4. **统一执行**：所有决策由 `DecisionExecutor` 统一执行，便于加错误处理、监控

#### 标准路径 + 逃生舱

决策对象采用"**枚举为主、自定义为辅**"的设计：

- **标准路径**：用 `action` / `queueBehavior` / `method` 枚举覆盖 90% 场景
- **逃生舱**：用 `customHandler` / `customSender` 应对极端场景

这样既保证大部分模式简单实现，又不限制复杂模式的灵活性。

### 3.4 队列管理

#### 队列接口

```typescript
/**
 * 队列接口（响应模式可以自定义实现）
 */
interface MessageQueueInterface {
  /** 入队 */
  enqueue(message: Message): void;

  /** 出队（返回下一个要处理的消息，空队列返回 null） */
  dequeue(): Message | null;

  /** 查看队首（不出队） */
  peek(): Message | null;

  /** 队列长度 */
  size(): number;

  /** 清空队列 */
  clear(): void;

  /** 是否为空 */
  isEmpty(): boolean;

  /**
   * 中断当前处理并插入消息（可选实现）
   * 用于 interrupt 行为
   */
  interrupt?(message: Message): void;
}
```

#### 默认队列实现

系统提供以下内置队列实现，响应模式可直接复用：

```typescript
/** FIFO 队列（先进先出，默认） */
class FIFOQueue implements MessageQueueInterface { ... }

/** LIFO 队列（后进先出，栈） */
class LIFOQueue implements MessageQueueInterface { ... }

/**
 * 优先级队列
 * @param priorityFn 计算消息优先级的函数（值越大越优先）
 */
class PriorityQueue implements MessageQueueInterface {
  constructor(private priorityFn: (msg: Message) => number) {}
}

/**
 * 自定义排序队列
 * @param compareFn 比较函数（返回负数表示 a 优先）
 */
class CustomQueue implements MessageQueueInterface {
  constructor(private compareFn: (a: Message, b: Message) => number) {}
}
```

#### 响应模式如何使用队列

```typescript
// 简单模式：使用默认 FIFO 队列
class InteractiveMode implements ResponseMode {
  private queue = new FIFOQueue();
  getQueue() { return this.queue; }
}

// 复杂模式：使用优先级队列
class DualSessionMode implements ResponseMode {
  private queue: MessageQueueInterface;

  async initialize(context) {
    // 按相关性排序的优先级队列
    this.queue = new PriorityQueue(msg => msg.metadata?.relevance ?? 0);
  }

  getQueue() { return this.queue; }

  async handleInbound(message) {
    // 辅助会话判断相关性
    const relevance = await this.judgeRelevance(message);
    message.metadata = { ...message.metadata, relevance };

    if (relevance < 0.3) {
      return { action: 'drop', reason: '相关性过低' };
    }

    return { action: 'process', queueBehavior: 'enqueue' };
    // PriorityQueue 会自动按 relevance 排序
  }
}
```

### 3.5 扩展机制

#### 可选扩展接口

复杂模式可能需要额外能力，通过**可选接口**实现，避免简单模式被迫实现空方法：

```typescript
/**
 * 辅助会话能力（dual-session 模式需要）
 */
interface WithAuxiliarySession {
  getAuxiliarySession(): AuxiliarySession;
}

/**
 * 线索追踪能力（thread-tracking 模式需要）
 */
interface WithThreadTracking {
  getThreadManager(): ThreadManager;
}

/**
 * 工作流能力（workflow 模式需要）
 */
interface WithWorkflow {
  getWorkflowEngine(): WorkflowEngine;
}

// 复杂模式组合多个能力
class DualSessionMode implements ResponseMode, WithAuxiliarySession {
  getAuxiliarySession(): AuxiliarySession { ... }
}
```

#### 扩展能力的支撑接口

上面三个可选接口暴露的 `AuxiliarySession` / `ThreadManager` / `WorkflowEngine`
本身也是接口，由系统提供默认实现（响应模式通过 `context` 工厂方法创建）：

```typescript
/**
 * 辅助会话：用于轻量判断、过滤、分析的独立会话。
 * 与主会话隔离——它的输出不直接发给对端，只回传给响应模式做决策。
 */
interface AuxiliarySession {
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
interface ThreadManager {
  /** 查找消息所属的线索（无则返回 undefined） */
  findThread(message: InboundMessage): Thread | undefined;
  /** 加入新线索（被 @ 时调用） */
  joinThread(message: InboundMessage): Thread;
  /** 列出当前活跃线索 */
  activeThreads(): Thread[];
}

interface Thread {
  id: string;
  isActive: boolean;
  lastActiveAt: number;
  participantAids: string[];
}

/**
 * 工作流引擎：按状态机推进任务处理。
 * 由 workflow 模式使用，系统提供默认实现。
 */
interface WorkflowEngine {
  /** 当前消息匹配哪个工作流节点（无则 undefined） */
  matchNode(message: InboundMessage): WorkflowNode | undefined;
  /** 推进工作流状态 */
  advance(node: WorkflowNode): void;
  /** 当前阶段 */
  currentStage(): string;
}

interface WorkflowNode {
  id: string;
  stage: string;
  handler: string;
}
```

> 这些支撑接口的**完整契约与默认实现细节**在各自的内置模式文档中展开
> （见 [builtin-modes.md](./builtin-modes.md)）。此处只声明响应模式可见的最小表面。

#### 为什么用可选接口而非强制方法？

```typescript
// 方案 A：接口强制所有模式实现（不推荐）
interface ResponseMode {
  getAuxiliarySession(): AuxiliarySession | null;  // 大部分模式返回 null
  getThreadManager(): ThreadManager | null;        // 大部分模式返回 null
}

// 方案 B：可选接口（推荐）
interface ResponseMode { /* 只有核心方法 */ }
interface WithAuxiliarySession { getAuxiliarySession(): AuxiliarySession; }
```

**方案 B 优势**：

- 简单模式不需要实现用不到的方法
- 通过 `'getAuxiliarySession' in mode` 类型守卫判断能力
- 接口职责单一，符合接口隔离原则

### 3.6 Context 注入

响应模式通过 `ResponseModeContext` 获取依赖，不直接 import 具体实现：

```typescript
/**
 * 响应模式上下文（依赖注入）
 */
interface ResponseModeContext {
  /** 当前会话 */
  session: Session;

  /** Agent 配置（合并后的有效配置） */
  agentConfig: EffectiveAgentConfig;

  /** 本模式的配置（从配置层级解析） */
  modeConfig: any;

  /** Agent Runner（用于调用模型，如辅助会话） */
  runner: AgentRunnerHandle;

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
    };
    
    /** 发送消息 */
    send(content: string, type?: 'message' | 'thought'): Promise<void>;
  };

  /** 日志器 */
  logger: Logger;

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
  createThreadManager?(options?: { maxActiveThreads?: number; timeoutMs?: number }): ThreadManager;

  /** 创建工作流引擎（workflow 模式用） */
  createWorkflowEngine?(options: { workflowFile: string }): Promise<WorkflowEngine>;
}
```

> **设计说明**：核心依赖（session/config/runner/channel/logger/dataDir）是字段，
> 进入 `initialize` 时已就绪；扩展能力（createAuxiliarySession 等）是**工厂方法**，
> 由响应模式按需调用、懒创建——简单模式从不触碰，不付出代价。
> 谁构造 Context、何时注入、生命周期如何管理，见
> [§5.3 ResponseModeCoordinator](#53-新增组件) 与
> [implementation-plan.md](./implementation-plan.md)。

**为什么依赖注入？**

- **解耦**：响应模式不依赖具体实现，只依赖接口
- **可测试**：测试时注入 mock context
- **灵活**：不同会话可以注入不同的依赖实例

---

## 四、调度层设计

### 4.1 职责边界

调度层管"**能不能处理**"，不管"**怎么处理**"。

核心问题：

1. 现在有多少会话在处理？还能再接受吗？
2. 这个会话处理完一条消息后，是继续还是切换？
3. 全局预算还剩多少？

### 4.2 Slot 机制

#### 什么是 Slot？

Slot 是"处理槽位"的抽象。同时处理的会话数量受 slot 数量限制。

```
配置：max_concurrent_sessions = 3

会话 A ──┐
会话 B ──┼─→ [Slot 1] [Slot 2] [Slot 3]  ← 最多 3 个会话同时处理
会话 C ──┤        ↑        ↑        ↑
会话 D ──┘     正在处理  正在处理  正在处理
会话 E ──→ 等待队列（无可用 slot）
```

#### Slot 粒度：per-agent

每个 agent 有自己的 slot 池，不与其他 agent 共享。

**理由**：不同 agent 的预算、优先级独立，owner 希望控制自己 agent 的资源，而不被其他 agent 影响。

#### Slot 生命周期

```
1. 会话有消息待处理
   ↓
2. 向 SlotManager 申请 slot（allocateSlot）
   ↓
3a. 有空闲 slot → 分配，开始处理
3b. 无空闲 slot → 进入等待队列
   ↓
4. 处理完一条消息 → 归还控制权（yieldControl）
   ↓
5. SlotManager 决策：
   - continue：继续处理下一条
   - switch：让出 slot 给其他会话
   - pause：暂停等待预算刷新
   ↓
6. 会话结束 → 释放 slot（releaseSlot）
```

#### Slot 接口

```typescript
interface SlotManager {
  /**
   * 申请 slot
   * @returns 是否分配成功（false 表示进入等待队列）
   */
  allocateSlot(sessionId: string, priority: number): Promise<boolean>;

  /**
   * 处理完一条消息后归还控制权
   * @param tokenUsed 本轮消耗的 token
   * @returns 下一步动作
   */
  yieldControl(sessionId: string, tokenUsed: number): Promise<'continue' | 'switch' | 'pause'>;

  /** 释放 slot */
  releaseSlot(sessionId: string): void;

  /** 查询状态 */
  getStatus(): SlotStatus;
}
```

### 4.3 调度策略（统一接口）

调度策略决定会话的优先级。提供三种策略，通过**统一接口**实现：

```typescript
/**
 * 调度策略接口
 */
interface SchedulingStrategy {
  /**
   * 计算会话优先级
   * @returns 优先级（值越大越优先）
   */
  calculatePriority(session: Session, context: SchedulingContext): Promise<number>;
}

/**
 * 调度上下文
 */
interface SchedulingContext {
  /** 当前所有待处理会话 */
  pendingSessions: Session[];
  /** 全局预算状态 */
  budget: BudgetStatus;
}
```

#### 策略 1：规则驱动（RuleBasedScheduling）

根据配置参数计算优先级，快速、可预测、成本低。

```typescript
class RuleBasedScheduling implements SchedulingStrategy {
  async calculatePriority(session, context): Promise<number> {
    let priority = 0;
    // 角色权重
    priority += this.config.roleWeights[session.identity.role] ?? 0;
    // 会话类型权重
    priority += this.config.chatTypeWeights[session.chatType] ?? 0;
    // 等待时间（避免饥饿）
    const waitTime = Date.now() - (session.metadata?.enqueuedAt ?? Date.now());
    priority += Math.min(waitTime / 1000 * this.config.waitTimeFactor, 50);
    return priority;
  }
}
```

**适用**：80% 的场景，默认策略。

#### 策略 2：AI 驱动（AIBasedScheduling）

调用调度 Agent，根据上下文智能判断优先级。

```typescript
class AIBasedScheduling implements SchedulingStrategy {
  async calculatePriority(session, context): Promise<number> {
    // 构造调度提示词，列出所有待处理会话
    const prompt = this.buildSchedulingPrompt(context.pendingSessions);
    // 调用轻量模型（如 haiku）
    const result = await this.schedulerAgent.execute(prompt, { format: 'json' });
    // 解析 AI 输出的优先级
    return this.parsePriority(result, session.id);
  }
}
```

**工作原理**：

- 每次调度时，载入当前所有待处理会话的信息
- 调度 Agent 根据消息内容、对端角色、等待时长、紧急程度综合判断
- 输出每个会话的优先级排序

**适用**：复杂场景，用户显式开启。

**代价**：每次调度消耗 token，延迟较高（秒级）。

#### 策略 3：混合（HybridScheduling）

规则驱动为主，AI 驱动为辅，平衡性能和智能。

```typescript
class HybridScheduling implements SchedulingStrategy {
  async calculatePriority(session, context): Promise<number> {
    // 触发条件满足时用 AI（如队列长、有紧急关键词）
    if (this.shouldUseAI(context)) {
      return this.aiStrategy.calculatePriority(session, context);
    }
    // 否则用规则
    return this.ruleStrategy.calculatePriority(session, context);
  }

  private shouldUseAI(context): boolean {
    // 队列超过阈值，或有紧急信号
    return context.pendingSessions.length > this.config.aiTriggerThreshold
        || context.pendingSessions.some(s => this.hasUrgentSignal(s));
  }
}
```

**适用**：推荐的平衡方案。平时用规则（快），关键时刻用 AI（智能）。

### 4.4 调度层的扩展性

当前调度层**不完全插件化**，但通过 `SchedulingStrategy` 接口预留扩展点：

- 内置三种策略（规则/AI/混合）
- 未来可以新增自定义策略（如 DeadlineScheduling）
- 通过配置选择策略

```json
{
  "scheduler": {
    "strategy": "hybrid",
    "rule_config": { ... },
    "ai_config": { ... },
    "hybrid_config": { ... }
  }
}
```

---

## 五、执行层对接

### 5.1 执行层职责

执行层**执行指令**，不做决策。

- 响应模式说"enqueue"，执行层操作队列
- 响应模式说"switch model"，执行层切换模型
- 响应模式说"custom handler"，执行层调用它

### 5.2 现有能力复用

执行层的核心组件已经成熟且模块化，**不需要大改**：

| 组件 | 状态 | 说明 |
|------|------|------|
| `AgentRunner` | 已插件化 | claude/codex/gemini 各自独立 runner |
| `ChannelAdapter` | 已插件化 | aun/feishu/wechat 各自独立 adapter |
| `MessageQueue` | 保留为默认实现 | 响应模式可用，也可自定义队列 |

### 5.3 新增组件

为对接响应模式，执行层新增两个组件：

#### DecisionExecutor（决策执行器）

执行响应模式返回的决策对象。

```typescript
class DecisionExecutor {
  async executeInbound(
    decision: InboundDecision,
    message: InboundMessage,
    mode: ResponseMode,
    context: ResponseModeContext
  ): Promise<void> {
    // 逃生舱优先
    if (decision.customHandler) {
      await decision.customHandler(message, context);
      return;
    }

    if (decision.action === 'drop') {
      context.logger.debug(`Message dropped: ${decision.reason}`);
      return;
    }

    // 执行附加指令
    if (decision.instructions?.switchModel) {
      context.runner.switchModel(decision.instructions.switchModel);
    }

    // 操作响应模式的队列
    const queue = mode.getQueue();
    switch (decision.queueBehavior) {
      case 'enqueue': queue.enqueue(message); break;
      case 'priority': queue.enqueue(message); break;  // 优先级队列自动排序
      case 'clear-and-enqueue': queue.clear(); queue.enqueue(message); break;
      case 'interrupt': queue.interrupt?.(message); break;
    }
  }
}
```

#### ResponseModeCoordinator（协调器）

连接执行层和响应模式的中介。

```typescript
class ResponseModeCoordinator {
  /**
   * 处理入站消息
   * 1. 根据 session 找到对应的 ResponseMode
   * 2. 调用 mode.handleInbound 得到决策
   * 3. 调用 DecisionExecutor 执行决策
   */
  async handleInbound(message: InboundMessage): Promise<void> {
    const mode = await this.resolveMode(message.session);
    const decision = await mode.handleInbound(message);
    await this.executor.executeInbound(decision, message, mode, context);
  }
}
```

#### 为什么需要 Coordinator？

- **解耦**：执行层不直接知道有多少种响应模式，只知道 Coordinator
- **缓存**：Coordinator 缓存 ResponseMode 实例，避免每条消息重新创建
- **容错**：统一处理响应模式抛出的异常

---

## 六、一条消息的完整流程

### 6.1 入站流程

```
1. Channel 收到消息
   （aun.ts / feishu.ts 等适配器）
   ↓
2. 构造 InboundMessage
   ↓
3. ResponseModeCoordinator.handleInbound(message)
   ↓
4. 解析响应模式
   - 根据 session 的 channel/channelId 查配置
   - 优先级：relation override > chatType 默认 > 全局默认
   ↓
5. mode.handleInbound(message) → InboundDecision
   - 例（dual-session）：辅助会话判断相关性
   - 返回 { action: 'process', queueBehavior: 'enqueue' }
   ↓
6. DecisionExecutor.executeInbound(decision)
   - 执行附加指令（如切换模型）
   - 操作响应模式的队列（mode.getQueue().enqueue）
   ↓
7. 通知有消息待处理
   ↓
8. [预留：未来调度层插入点]
   - 调度层决定是否分配处理资源（slot）
   - 当前阶段：直接进入处理
   ↓
9. Agent Runner 从 mode.getQueue() 取消息处理
```

### 6.2 出站流程

```
1. Agent Runner 产生输出（流式文本/工具调用）
   ↓
2. ResponseModeCoordinator.handleOutbound(payload)
   ↓
3. mode.handleOutbound(payload) → OutboundDecision
   - 例（proactive）：返回 { method: 'tool-required' }
   - 例（interactive）：返回 { method: 'direct' }
   - 可选：返回 yieldHint（当前忽略，预留给未来调度层）
   ↓
4. DecisionExecutor.executeOutbound(decision)
   - direct：直接通过 Channel 发送
   - tool-required：只有工具调用才发送，普通文本投影为 thought
   - buffered：缓冲到阈值再发送
   - custom：调用 customSender
   ↓
5. Channel Adapter 发送消息
   ↓
6. [预留：未来调度层插入点]
   - 调度层参考 yieldHint 决定：继续/切换/暂停
   - 当前阶段：直接继续处理下一条
```
5. Channel Adapter 发送消息
   ↓
6. SlotManager.yieldControl(sessionId, tokenUsed)
   - continue / switch / pause
```

### 6.3 流程图

```
                    ┌──────────────┐
                    │   Channel    │ 收到消息
                    └──────┬───────┘
                           ↓
              ┌────────────────────────┐
              │ ResponseModeCoordinator │
              └────────────┬───────────┘
                           ↓
                  ┌─────────────────┐
                  │  解析响应模式    │ ← 配置层级解析
                  └────────┬────────┘
                           ↓
                  ┌─────────────────┐
                  │ mode.handleInbound │ → InboundDecision
                  └────────┬────────┘
                           ↓
                  ┌─────────────────┐
                  │ DecisionExecutor │ 操作队列、执行指令
                  └────────┬────────┘
                           ↓
                  ┌─────────────────┐
                  │  SlotManager     │ ← 调度层：分配 slot
                  └────────┬────────┘
                           ↓
                  ┌─────────────────┐
                  │  Agent Runner    │ ← 执行层：从队列取消息处理
                  └────────┬────────┘
                           ↓ 产生输出
                  ┌─────────────────┐
                  │ mode.handleOutbound │ → OutboundDecision
                  └────────┬────────┘
                           ↓
                  ┌─────────────────┐
                  │ DecisionExecutor │ 发送消息
                  └────────┬────────┘
                           ↓
                  ┌─────────────────┐
                  │ SlotManager      │ ← yieldControl 决定下一步
                  │ .yieldControl    │
                  └─────────────────┘
```

---

## 七、配置体系

### 7.1 配置层级

复用现有配置体系，响应模式配置遵循同样的覆盖链：

```
defaults.json                                  # 全局默认
  ↓ 覆盖
agents/<aid>/config.json                       # Agent 级
  ↓ 覆盖
agents/<aid>/relations/<peerKey>/config.json   # Relation 级（最高优先级）
```

### 7.2 配置结构

```typescript
interface AgentConfig {
  // ... 现有字段

  /** 响应模式配置 */
  response_modes?: {
    /** 默认响应模式（单聊） */
    default_private?: string;   // 模式 ID

    /** 默认响应模式（群聊） */
    default_group?: string;     // 模式 ID

    /** 每个模式的配置参数 */
    configs?: {
      [modeId: string]: any;
    };

    /** 会话级覆盖（特定对端/群使用特定模式） */
    overrides?: {
      [peerKey: string]: {
        mode: string;
        config?: any;
      };
    };
  };
}
```

### 7.3 解析优先级

```
1. relation override（特定对端的 overrides[peerKey]）
   ↓ 未命中
2. chatType 默认（default_private / default_group）
   ↓ 未命中
3. 全局兜底（private→interactive, group→proactive）
```

详见 [config-reference.md](./config-reference.md)。

---

## 八、目录结构

```
src/response-modes/
├── core/                       # 内置响应模式
│   ├── index.ts               # 内置模式注册表
│   ├── interactive.ts
│   ├── proactive.ts
│   ├── dual-session.ts
│   ├── thread-tracking.ts
│   ├── workflow.ts
│   ├── context-enhanced.ts
│   ├── batch-processing.ts
│   ├── selective-response.ts
│   ├── rate-limited.ts
│   └── autonomous.ts
│
├── extensions/                 # 扩展响应模式（用户自定义）
│   ├── index.ts               # 扩展模式注册表
│   └── (用户模块)
│
├── queues/                     # 队列实现
│   ├── fifo-queue.ts
│   ├── lifo-queue.ts
│   ├── priority-queue.ts
│   └── custom-queue.ts
│
├── types.ts                    # 接口定义
├── registry.ts                 # 注册与发现
├── resolver.ts                 # 模式选择与解析
├── coordinator.ts              # 协调器
├── decision-executor.ts        # 决策执行器
└── config-store.ts             # 配置存储

src/scheduler/                  # 调度层
├── slot-manager.ts            # Slot 管理
├── strategies/                # 调度策略
│   ├── rule-based.ts
│   ├── ai-based.ts
│   └── hybrid.ts
└── types.ts
```

---

## 九、设计决策记录

### 决策 1：为什么三层架构？

**问题**：会话响应涉及资源、策略、执行三个不同问题域。

**决策**：分为调度层、响应层、执行层。

**理由**：职责清晰、独立演进、可测试、可复用。三个问题域有本质区别，合并会导致职责混乱。

### 决策 2：为什么只有响应层完全插件化？

**问题**：是否三层都插件化？

**决策**：只有响应层完全插件化，调度层预留接口，执行层保持现状。

**理由**：响应层需求多样、变化频繁，是核心价值；调度层复杂度高、错误风险大，收益低；执行层已模块化。全部插件化会导致复杂度爆炸（N×M×K 组合）。

### 决策 3：为什么队列在响应层？

**问题**：队列放基础设施层还是响应层？

**决策**：放响应层，每个模式可自定义队列，同时提供默认实现。

**理由**：不同模式需要不同队列机制（FIFO/LIFO/Priority），队列行为是响应策略的一部分。提供默认实现避免重复造轮子。

### 决策 4：为什么决策与执行分离？

**问题**：响应模式直接执行还是返回决策？

**决策**：返回决策对象，由 DecisionExecutor 统一执行。

**理由**：决策是纯数据，易测试、可审计、解耦。统一执行便于加错误处理和监控。

### 决策 5：为什么用可选接口扩展？

**问题**：复杂能力（辅助会话等）如何扩展？

**决策**：用可选接口（WithAuxiliarySession 等），而非强制方法。

**理由**：简单模式不需要实现用不到的方法，符合接口隔离原则。

### 决策 6：为什么调度支持三种策略？

**问题**：调度用规则还是 AI？

**决策**：统一接口，支持规则/AI/混合三种。

**理由**：规则快但不灵活，AI 灵活但慢且贵。混合模式平衡性能和智能，覆盖不同场景。

---

## 十、待决策的对接难点

> 本章诚实记录设计与现有代码集成时的薄弱处与未定方向。
> 这些不是文档笔误，而是需要 owner 拍板的架构决策。落地前必须逐项澄清。
> 标 ⚠️ 的是被前期设计**低估**的根本性难点。

### 难点 1 ⚠️：per-mode 队列 vs 现有进程级单例 MessageQueue

### 难点 1 ⚠️：队列机制与 agent 隔离

**现状澄清**（代码审查确认）：

- **队列粒度**：per-queueKey，其中 `queueKey = sessionKey::projectPath`，
  `sessionKey = channelType#channelId#threadId`（不含 session.id，不含 selfAID）
- **队列共享**：同一 agent 与同一对端的多个会话（不同 session.id）共享同一队列
- **严重 bug**：sessionKey 不含 selfAID → 不同 agent 与同一对端的队列会冲突
  - `alice.aid → bob.aid` 的 queueKey = `aun#bob.aid#main::path`
  - `carol.aid → bob.aid` 的 queueKey = `aun#bob.aid#main::path`（相同！冲突）

**已拍板方案**：

**D1.1 修复 agent 隔离** ✅：
- `queueKey = selfAID::sessionKey::projectPath`（在现有基础上加前缀）
- 最小影响：sessionKey 格式不变（不破坏其他依赖），只改 MessageQueue 内部

**D1.2 入队 vs 出队策略分离** ✅：
- **入队策略**：响应模式的 `handleInbound` 决定（process/drop、enqueue/priority/interrupt）
- **出队策略**：逻辑队列的 `dequeue()` 决定（FIFO/LIFO/Priority/Custom 排序）
- **切换响应模式时**：已入队消息不动，但出队顺序按新模式逻辑队列重排 → 无需锁定模式

**分层队列**：
- **物理队列**（现有 MessageQueue 单例）：per-queueKey 存储，全局去重/持久化/中断/合并
- **逻辑队列**（响应模式持有）：per-queueKey 排序视图，只决定出队顺序
- **取消息流程**：Runner → 问逻辑队列"下一个是谁？"→ 拿 messageId → 从物理队列取本体

### 难点 2：调度层的兼容性预留

**现状**：调度层（SlotManager）是独立的、后置的设计，**当前不实施**。

**核心问题**：响应层插件化的接口设计是否会在未来加入调度层时导致推倒重来？

**已拍板方案** ✅：

**D2.1 响应模式不决定调度，但可提供提示**：
- `OutboundDecision` 预留可选字段 `yieldHint?: 'continue' | 'switch' | 'pause'`
- 响应模式可选返回（如 batch 模式可提示"攒批完成，建议切换"）
- 当前阶段 hint 被忽略；未来调度层上线时可参考（非强制）
- 切换成本低：可选字段向后兼容，响应层复杂度增加有限

**D2.2 流程图标注预留，Phase 7 暂不实施**：
- 文档流程图在调度层插入点标注"[预留：未来调度层]"
- implementation-plan 的 Phase 7（SlotManager）改为"预留设计，当前不实施"
- 响应层接口已预留扩展点，未来调度层可无缝对接

**兼容性保证**：
- 插入点清晰：队列与 Runner 之间（响应层无感知）
- 接口不假设立即处理：`handleInbound` 只决定入队，不管何时处理
- 队列与调度正交：逻辑队列管排序，调度层管资源分配

### 难点 3：辅助会话接口能力

**现状**：辅助会话用于轻量判断/过滤（如 dual-session 模式判断消息相关性）。

**已拍板方案** ✅：

**接口扩展**（选 B）：
- `AuxiliarySession` 新增 `send(content, type)` 方法
  - type='thought'：发送处理状态（"正在批量处理 50 条消息..."）
  - type='message'：发送结果通知（"批量处理完成，无相关消息"）
- 职责边界：辅助会话可发状态/通知，但不应发"回复对端问题"的消息（那是主会话职责）

**配置选项**：
- `purpose`：用途标识（用于成本统计和调试）
- `contextMode`：'minimal'（默认，精简上下文）/ 'full'（完整 ECK）
- 工具/技能权限：当前阶段默认无，接口预留未来扩展

**职责对比**：

| 维度 | 主会话 | 辅助会话 |
|------|--------|----------|
| 职责 | 生成最终回复、处理复杂任务 | 判断/过滤/轻量分析 |
| 上下文 | 完整 ECK | 精简（可配置） |
| 模型 | 主力（如 sonnet） | 轻量（如 haiku） |
| 出站 | 回复对端 | 状态/通知 |
| 工具/技能 | 完整权限 | 默认无（预留） |

### 难点 4：旧配置参数迁移

**现状**：`AgentConfig` 已有 `chatmode`（private/group → interactive/proactive）
和 `dispatch`（mention/broadcast）配置参数。

**已确认** ✅：**无需兼容，直接新结构**

项目尚在开发阶段、未对外发布，因此：
- 直接删除旧参数（`chatmode`、`dispatch`）
- 只使用新的 `response_modes` 块
- interactive/proactive 变成内置响应模式，原参数成为模式配置
- `dispatch: 'mention'` → `default_group: 'selective-response'`
- `dispatch: 'broadcast'` → `default_group: 'proactive'`

实施任务：Phase 4（T4.1 配置类型）直接替换，无迁移逻辑。

**缺口**：config-reference.md §8 只讲了单向迁移（旧→新），没讲**运行时**谁优先、
`resolveEffective()` 怎么改、两者都设时如何裁决。

**推荐方案**：
- `response_modes` 存在时完全接管，`chatmode`/`dispatch` 视为**派生兼容层**：
  - 无 `response_modes.default_private` 时，回落读 `chatmode.private` 并映射
    （interactive→interactive 模式，proactive→proactive 模式）。
  - `dispatch: mention` 映射到 `selective-response`（仅@响应），
    `broadcast` 映射到 `proactive`。
- 映射逻辑集中在一处（resolver），不散落。

**待 owner 拍板**：兼容层保留多久？是否设弃用期后移除 chatmode/dispatch？

### 难点 5：作用域读写机制复用

**现状**：`ec model` 复用 `src/core/model/config-scope.ts` 的作用域读写（--self/--peer），
但该文件是 model 专用（针对 `baseagents.<ba>.model` 嵌套结构）。
`response_modes` 是平级顶层字段，不是嵌套的。

**已拍板方案** ✅：**泛化为 field-scope**

- 把 `config-scope.ts` 的作用域**框架**抽象成通用 `field-scope.ts`
- 提供字段路径适配器（model 适配器 → `baseagents.<ba>.model`，response 适配器 → `response_modes`）
- 作用域逻辑（determineScope/peer 规范化/错误码）只维护一份
- 未来其他命令（如 `ec skill`）可复用

实施任务：Phase 5（T5.1）重构 config-scope，提取通用层。

### 难点 6：响应模式异常处理

**现状**：消息处理异常时，记录日志 + reject Promise，继续处理下一条。
没有降级机制（不会自动回落到其他模式）。

**已拍板方案** ✅：**保持现状 + 增强提示**

- 响应模式 `handleInbound/handleOutbound` 抛异常时：
  1. 记录日志（包含堆栈）
  2. reject Promise（通知调用方失败）
  3. **新增**：发送用户友好的错误提示（"响应模式处理异常：[异常信息]，已跳过本条消息"）
- **不降级**（不自动回落到其他模式）

理由：
- 现有机制简单清晰（失败跳过、继续下一条），用户已习惯
- 降级逻辑复杂（需判断模式类型、区分场景），维护成本高
- 响应模式异常通常是开发者问题，应修复模式而非静默降级

实施任务：Phase 3（T3.4 DecisionExecutor）捕获异常，调用 Channel 发送错误提示。

### 难点 7：现有机制迁移到插件化

**问题**：现有的 interactive/proactive/mention 机制能否顺利迁移到插件化接口？

**迁移评估结果** ✅：**需要调整接口，已完成**

通过代码审查发现 4 个关键问题，全部已通过接口调整解决：

#### D7.1 ProactiveRuntimeState 传递

**问题**：proactive 模式需要传递细粒度控制状态（suspendUntilCall、preTool1stMsgChk）。  
**方案** ✅：`InboundDecision.runtimeState` 字段，MessageProcessor 存入 `context.sessionState`。

#### D7.2 OutboundPayload 结构明确化

**问题**：无法判断是否工具调用，proactive 模式核心逻辑受阻。  
**方案** ✅：扩展 `kind` 枚举（加 tool-call/tool-result/thought），加 `isToolCall` 便捷字段。

#### D7.3 Mention 过滤时机

**问题**：Channel 层在入队前过滤未 @ 的消息，响应模式拿不到。  
**方案** ✅：Channel 只标记 `isMentioned`，不过滤，响应模式决定 drop。

#### D7.4 IMRenderer 职责重叠

**问题**：IMRenderer 已有 chatMode 感知，与响应模式的 handleOutbound 重叠。  
**方案** ✅：IMRenderer 退化为纯"输出缓冲器"，chatMode 逻辑由响应模式接管。

详细评估见 `migration-assessment.md`。

实施任务：
- Phase 1（T1.1）：接口定义包含上述调整
- Phase 2（T2.4）：Channel Adapter 改为"标记不过滤"
- Phase 3（T3.5）：IMRenderer 退化重构
- Phase 6（T6.1/T6.2）：验证 interactive/proactive 完整迁移

### 难点小结

| # | 难点 | 状态 | 方案要点 |
|---|------|------|----------|
| 1 | 队列机制与 agent 隔离 | ✅ 已确认 | 修复 agent 隔离（queueKey 加 selfAID）；入队/出队策略分离；分层队列 |
| 2 | 调度层兼容性预留 | ✅ 已确认 | 预留 yieldHint；Phase 7 暂不实施 |
| 3 | 辅助会话接口能力 | ✅ 已确认 | 扩展接口（加 send()）；支持 purpose/contextMode 配置 |
| 4 | 旧配置参数迁移 | ✅ 已确认 | 无需兼容，直接删除 chatmode/dispatch |
| 5 | 作用域读写机制 | ✅ 已确认 | 泛化 config-scope 为 field-scope |
| 6 | 响应模式异常处理 | ✅ 已确认 | 不降级；增强错误提示（含异常信息） |
| 7 | 现有机制迁移到插件化 | ✅ 已确认 | 接口调整（runtimeState/OutboundPayload/isMentioned/IMRenderer 退化） |

---

## 十一、术语表

| 术语 | 英文 | 说明 |
|------|------|------|
| 响应模式 | Response Mode | 定义会话如何处理消息的策略 |
| 入站决策 | Inbound Decision | 响应模式对入站消息的处理决策 |
| 出站决策 | Outbound Decision | 响应模式对出站消息的发送决策 |
| 槽位 | Slot | 处理槽位，限制并发会话数 |
| 调度策略 | Scheduling Strategy | 计算会话优先级的算法 |
| 协调器 | Coordinator | 连接执行层和响应模式的中介 |
| 决策执行器 | Decision Executor | 执行响应模式决策的组件 |
| 辅助会话 | Auxiliary Session | 用于判断消息相关性的轻量会话 |
| 线索追踪 | Thread Tracking | 追踪特定对话线索的机制 |

---

## 附录：相关文档

- [插件开发指南](./plugin-guide.md)
- [命令参考](./command-reference.md)
- [配置参考](./config-reference.md)
- [内置模式文档](./builtin-modes.md)
- [故障排查](./troubleshooting.md)
