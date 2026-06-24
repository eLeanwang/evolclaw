# 插件开发指南

## 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | 响应模式插件开发指南 |
| 版本 | v1.0 |
| 状态 | Draft |
| 适用读者 | 插件开发者 |
| 前置阅读 | [architecture.md](./architecture.md) |

---

## 一、快速上手（30分钟实现第一个插件）

本节通过实现一个简单的"回声模式"（Echo Mode），让你快速掌握插件开发流程。

### 1.1 目标

实现一个 `EchoMode`：
- 收到任何消息都立即处理（FIFO 队列）
- 输出直接发送给对端

### 1.2 步骤一：创建模块文件

在 `src/response-modes/extensions/` 目录创建 `echo.ts`：

```typescript
import type {
  ResponseMode,
  ResponseModeContext,
  InboundMessage,
  InboundDecision,
  OutboundPayload,
  OutboundDecision,
  MessageQueueInterface,
} from '../types.js';
import { FIFOQueue } from '../queues/fifo-queue.js';

export class EchoMode implements ResponseMode {
  // ─── 元数据 ───
  readonly id = 'echo';
  readonly displayName = '回声模式';
  readonly description = '收到消息立即处理，输出直接发送';
  readonly type = 'extension' as const;
  readonly applicableScenes = ['private', 'group'] as const;
  readonly configSchema = {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: '回复前缀',
        default: '',
      },
    },
  };

  // ─── 内部状态 ───
  private queue = new FIFOQueue();
  private context!: ResponseModeContext;

  // ─── 生命周期 ───
  async initialize(context: ResponseModeContext): Promise<void> {
    this.context = context;
    this.context.logger.debug('[EchoMode] initialized');
  }

  async cleanup(): Promise<void> {
    this.queue.clear();
  }

  // ─── 核心能力 ───
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 所有消息都正常入队处理
    return {
      action: 'process',
      queueBehavior: 'enqueue',
    };
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    // 输出直接发送
    return {
      method: 'direct',
    };
  }

  // ─── 队列管理 ───
  getQueue(): MessageQueueInterface {
    return this.queue;
  }
}
```

### 1.3 步骤二：注册模式

在 `src/response-modes/extensions/index.ts` 中注册：

```typescript
import { ResponseModeRegistry } from '../registry.js';
import { EchoMode } from './echo.js';

export function registerExtensions(registry: ResponseModeRegistry): void {
  registry.registerExtension(new EchoMode());
  // 注册其他扩展模式...
}
```

### 1.4 步骤三：测试

#### 命令行测试

```bash
# 查看是否注册成功
ec response list

# 输出应包含：
# echo - 回声模式 (extension)

# 切换到 echo 模式
ec response set echo

# 查看当前模式
ec response current
# 输出：echo - 回声模式
```

#### 前端测试

通过前端的响应模式选择器，应该能看到"回声模式"选项，选中即可切换。

### 1.5 恭喜！

你已经实现了第一个响应模式插件。接下来学习更复杂的能力。

---

## 二、接口详解

### 2.1 元数据字段

```typescript
readonly id: string;
```
**唯一标识**，用于注册、查找、配置引用。命名规范：小写字母 + 连字符（如 `dual-session`）。

```typescript
readonly displayName: string;
```
**显示名称**，用于前端展示。与 `id` 分离便于国际化。

```typescript
readonly description: string;
```
**描述**，简要说明模式的用途和适用场景。

```typescript
readonly type: 'builtin' | 'extension';
```
**模式类型**。内置模式用 `builtin`，扩展模式用 `extension`。决定注册到哪个注册表。

```typescript
readonly applicableScenes: ('private' | 'group')[];
```
**适用场景**。声明此模式适用于私聊、群聊或两者。系统会阻止在不适用的场景使用此模式。

```typescript
readonly configSchema: JSONSchema;
```
**配置 Schema**，JSON Schema 格式。用途：
- 前端据此自动生成配置表单
- 后端据此校验配置合法性
- 文档据此生成配置说明

示例：
```typescript
readonly configSchema = {
  type: 'object',
  properties: {
    auxiliary_model: {
      type: 'string',
      description: '辅助会话使用的模型',
      default: 'haiku',
      enum: ['haiku', 'sonnet', 'opus'],
    },
    relevance_threshold: {
      type: 'number',
      description: '相关性阈值（0-1）',
      default: 0.7,
      minimum: 0,
      maximum: 1,
    },
  },
  required: ['auxiliary_model'],
};
```

### 2.2 生命周期方法

#### initialize

```typescript
initialize(context: ResponseModeContext): Promise<void>;
```

**调用时机**：会话首次使用此模式时。

**职责**：
- 保存 context 引用
- 初始化内部状态
- 准备资源（如创建辅助会话、加载文档）
- 读取配置（`context.modeConfig`）

**注意**：同一个模式实例可能被多个会话共享，如果需要会话隔离的状态，应在 context 中区分。

#### cleanup

```typescript
cleanup(): Promise<void>;
```

**调用时机**：会话切换到其他模式，或会话结束时。

**职责**：
- 清空队列
- 释放资源（如关闭辅助会话）
- 持久化必要状态

### 2.3 核心能力方法

#### handleInbound

```typescript
handleInbound(message: InboundMessage): Promise<InboundDecision>;
```

**职责**：决定如何处理入站消息。

**返回决策对象**，详见 [2.4 决策对象](#24-决策对象)。

**典型实现模式**：

```typescript
async handleInbound(message: InboundMessage): Promise<InboundDecision> {
  // 1. 判断是否处理
  if (!this.shouldProcess(message)) {
    return { action: 'drop', reason: '不符合处理条件' };
  }

  // 2. 计算队列行为
  const behavior = this.calculateQueueBehavior(message);

  // 3. 判断是否需要附加指令
  const instructions = this.buildInstructions(message);

  return {
    action: 'process',
    queueBehavior: behavior,
    instructions,
  };
}
```

#### handleOutbound

```typescript
handleOutbound(payload: OutboundPayload): Promise<OutboundDecision>;
```

**职责**：决定如何发送出站消息。

**返回决策对象**，详见 [2.4 决策对象](#24-决策对象)。

**典型实现模式**：

```typescript
async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
  // interactive：直接发送
  // proactive：必须工具调用
  // batch：缓冲
  return {
    method: this.config.requireTool ? 'tool-required' : 'direct',
  };
}
```

### 2.4 决策对象

#### InboundDecision

```typescript
interface InboundDecision {
  action: 'process' | 'drop' | 'defer';
  queueBehavior?: 'enqueue' | 'priority' | 'clear-and-enqueue' | 'interrupt';
  instructions?: {
    switchModel?: string;
    injectContext?: string[];
    interruptCurrent?: boolean;
  };
  customHandler?: (message: InboundMessage, context: ResponseModeContext) => Promise<void>;
  reason?: string;
}
```

**action 取值**：

| 值 | 含义 | 适用场景 |
|----|------|----------|
| `process` | 正常处理 | 消息需要处理 |
| `drop` | 丢弃 | 消息无关（如群聊中未 @ 的消息） |
| `defer` | 延迟处理 | 暂时不处理，但保留（如速率限制冷却期） |

**queueBehavior 取值**（仅 `action='process'` 时有效）：

| 值 | 含义 | 适用场景 |
|----|------|----------|
| `enqueue` | 正常入队 | 标准处理 |
| `priority` | 优先入队 | 高优先级消息（优先级队列自动排序） |
| `clear-and-enqueue` | 清空队列后入队 | 紧急消息，丢弃旧消息 |
| `interrupt` | 中断当前处理并插入 | 立即响应（如 owner 的命令） |

**instructions（附加指令）**：

```typescript
instructions: {
  switchModel: 'opus',           // 切换模型（如处理图片时切换视觉模型）
  injectContext: ['group-rules'], // 注入上下文（如工作群规则文档）
  interruptCurrent: true,         // 中断当前处理
}
```

**customHandler（逃生舱）**：

当标准 `action`/`queueBehavior` 无法表达时使用：

```typescript
return {
  action: 'process',
  customHandler: async (message, context) => {
    // 完全自定义的处理逻辑
    await context.runner.execute(customPrompt);
  },
};
```

#### OutboundDecision

```typescript
interface OutboundDecision {
  method: 'direct' | 'tool-required' | 'buffered' | 'suppress' | 'custom';
  bufferConfig?: {
    maxBytes: number;
    flushInterval: number;
  };
  encrypted?: boolean;
  customSender?: (payload: OutboundPayload, context: ResponseModeContext) => Promise<void>;
}
```

**method 取值**：

| 值 | 含义 | 适用场景 |
|----|------|----------|
| `direct` | 直接发送 | interactive 模式 |
| `tool-required` | 仅工具调用发送 | proactive 模式 |
| `buffered` | 缓冲批量发送 | batch 模式 |
| `suppress` | 抑制发送 | 静默处理 |
| `custom` | 自定义发送 | 复杂场景 |

### 2.5 队列管理

#### getQueue

```typescript
getQueue(): MessageQueueInterface;
```

**职责**：返回此模式使用的队列实例。执行层据此取消息处理。

**选择队列实现**：

```typescript
// 简单模式：FIFO
private queue = new FIFOQueue();

// 后进先出
private queue = new LIFOQueue();

// 优先级队列（值越大越优先）
private queue = new PriorityQueue(msg => msg.metadata?.priority ?? 0);

// 自定义排序
private queue = new CustomQueue((a, b) => {
  // 返回负数表示 a 优先
  return b.timestamp - a.timestamp;
});
```

---

## 三、扩展机制

### 3.1 可选接口

复杂模式通过实现可选接口获得额外能力。

#### 辅助会话

```typescript
import type { WithAuxiliarySession, AuxiliarySession } from '../types.js';

export class DualSessionMode implements ResponseMode, WithAuxiliarySession {
  private auxSession!: AuxiliarySession;

  async initialize(context: ResponseModeContext) {
    // 创建辅助会话（轻量模型）
    this.auxSession = await context.createAuxiliarySession({
      model: this.config.auxiliary_model ?? 'haiku',
    });
  }

  getAuxiliarySession(): AuxiliarySession {
    return this.auxSession;
  }

  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 用辅助会话判断相关性
    const relevance = await this.auxSession.judge(
      `这条消息是否与我有关？\n消息：${message.content}`
    );

    if (relevance < this.config.relevance_threshold) {
      return { action: 'drop', reason: `相关性 ${relevance} 低于阈值` };
    }

    return { action: 'process', queueBehavior: 'priority' };
  }
}
```

#### 线索追踪

```typescript
import type { WithThreadTracking, ThreadManager } from '../types.js';

export class ThreadTrackingMode implements ResponseMode, WithThreadTracking {
  private threadManager!: ThreadManager;

  getThreadManager(): ThreadManager {
    return this.threadManager;
  }

  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 检查消息是否属于活跃线索
    const thread = this.threadManager.findThread(message);

    if (thread?.isActive) {
      // 活跃线索的消息都处理
      return { action: 'process', queueBehavior: 'enqueue' };
    }

    // 被 @ 时加入新线索
    if (message.mentionAids?.includes(this.context.session.selfAID)) {
      this.threadManager.joinThread(message);
      return { action: 'process', queueBehavior: 'priority' };
    }

    return { action: 'drop', reason: '不属于活跃线索且未被@' };
  }
}
```

### 3.2 类型守卫

执行层通过类型守卫判断模式是否具备某能力：

```typescript
function hasAuxiliarySession(mode: ResponseMode): mode is ResponseMode & WithAuxiliarySession {
  return 'getAuxiliarySession' in mode;
}

// 使用
if (hasAuxiliarySession(mode)) {
  const aux = mode.getAuxiliarySession();
  // ...
}
```

---

## 四、最佳实践

### 4.1 配置读取

始终从 `context.modeConfig` 读取配置，并提供默认值：

```typescript
async initialize(context: ResponseModeContext) {
  const config = context.modeConfig ?? {};
  this.threshold = config.relevance_threshold ?? 0.7;
  this.model = config.auxiliary_model ?? 'haiku';
}
```

### 4.2 错误处理

`handleInbound`/`handleOutbound` 抛出的异常会被 Coordinator 捕获，但应尽量优雅降级：

```typescript
async handleInbound(message: InboundMessage): Promise<InboundDecision> {
  try {
    const relevance = await this.auxSession.judge(message);
    // ...
  } catch (error) {
    this.context.logger.warn(`[DualSession] 相关性判断失败，降级为处理: ${error}`);
    // 降级：判断失败时默认处理，避免漏消息
    return { action: 'process', queueBehavior: 'enqueue' };
  }
}
```

### 4.3 日志

使用 `context.logger` 记录关键决策，便于调试：

```typescript
this.context.logger.debug(`[${this.id}] 消息 ${message.messageId} 决策: ${decision.action}`);
```

决策的 `reason` 字段也应填写，便于追踪：

```typescript
return { action: 'drop', reason: '群聊未@self且非活跃线索' };
```

### 4.4 状态管理

#### 会话隔离

如果模式实例被多个会话共享，会话级状态应用 Map 隔离：

```typescript
export class MyMode implements ResponseMode {
  // 按 sessionId 隔离状态
  private sessionStates = new Map<string, MySessionState>();

  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    const sessionId = message.sessionId;
    let state = this.sessionStates.get(sessionId);
    if (!state) {
      state = this.createInitialState();
      this.sessionStates.set(sessionId, state);
    }
    // 使用 state...
  }
}
```

#### 持久化

需要跨重启保留的状态，应持久化到文件：

```typescript
async cleanup() {
  await this.persistState();
}

private async persistState() {
  const statePath = path.join(this.context.dataDir, `${this.id}-state.json`);
  await atomicWriteJson(statePath, this.state);
}
```

### 4.5 性能

#### 避免阻塞

`handleInbound` 在消息处理热路径上，避免耗时操作：

```typescript
// ❌ 不好：每条消息都同步读文件
async handleInbound(message) {
  const rules = fs.readFileSync('rules.md');  // 阻塞
}

// ✅ 好：初始化时加载，缓存
async initialize(context) {
  this.rules = await this.loadRules();  // 一次性加载
}
```

#### 辅助会话成本

辅助会话每次调用消耗 token，应：
- 用轻量模型（haiku）
- 缓存判断结果
- 设置合理的触发条件（不是每条都判断）

---

## 五、调试与测试

### 5.1 单元测试

决策逻辑是纯函数，易于测试：

```typescript
import { describe, it, expect } from 'vitest';
import { EchoMode } from '../src/response-modes/extensions/echo.js';
import { createMockContext, createMockMessage } from './helpers.js';

describe('EchoMode', () => {
  it('所有消息都正常处理', async () => {
    const mode = new EchoMode();
    await mode.initialize(createMockContext());

    const message = createMockMessage({ content: 'hello' });
    const decision = await mode.handleInbound(message);

    expect(decision.action).toBe('process');
    expect(decision.queueBehavior).toBe('enqueue');
  });

  it('输出直接发送', async () => {
    const mode = new EchoMode();
    await mode.initialize(createMockContext());

    const decision = await mode.handleOutbound({ kind: 'result.text', text: 'hi', isFinal: true });

    expect(decision.method).toBe('direct');
  });
});
```

### 5.2 Mock Context

测试时注入 mock context：

```typescript
function createMockContext(overrides?: Partial<ResponseModeContext>): ResponseModeContext {
  return {
    session: createMockSession(),
    agentConfig: createMockAgentConfig(),
    modeConfig: {},
    runner: createMockRunner(),
    channel: createMockChannel(),
    logger: createMockLogger(),
    ...overrides,
  };
}
```

### 5.3 集成测试

通过命令行验证模式切换：

```bash
# 切换到测试模式
ec response set my-mode

# 发送测试消息（通过另一个 agent 或前端）
# 观察日志输出
ec ctl log --tail
```

### 5.4 调试技巧

#### 启用 debug 日志

```bash
# 查看响应模式的决策日志
ec ctl log --grep "ResponseMode"
```

#### 查看当前模式状态

```bash
ec response current --format json
# 输出包含模式 ID、配置、内部状态
```

---

## 六、高级模式示例

### 6.1 双会话模式（完整实现）

```typescript
export class DualSessionMode implements ResponseMode, WithAuxiliarySession {
  readonly id = 'dual-session';
  readonly displayName = '双会话模式';
  readonly description = '辅助会话判断相关性，主会话处理';
  readonly type = 'builtin' as const;
  readonly applicableScenes = ['group'] as const;
  readonly configSchema = {
    type: 'object',
    properties: {
      auxiliary_model: { type: 'string', default: 'haiku' },
      relevance_threshold: { type: 'number', default: 0.7 },
    },
  };

  private queue!: MessageQueueInterface;
  private auxSession!: AuxiliarySession;
  private context!: ResponseModeContext;
  private config!: { auxiliary_model: string; relevance_threshold: number };

  async initialize(context: ResponseModeContext) {
    this.context = context;
    this.config = {
      auxiliary_model: context.modeConfig?.auxiliary_model ?? 'haiku',
      relevance_threshold: context.modeConfig?.relevance_threshold ?? 0.7,
    };
    // 按相关性排序的优先级队列
    this.queue = new PriorityQueue(msg => msg.metadata?.relevance ?? 0);
    // 创建辅助会话
    this.auxSession = await context.createAuxiliarySession({
      model: this.config.auxiliary_model,
    });
  }

  async cleanup() {
    this.queue.clear();
    await this.auxSession?.close();
  }

  getQueue() { return this.queue; }
  getAuxiliarySession() { return this.auxSession; }

  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    try {
      // 辅助会话判断相关性
      const result = await this.auxSession.judge(`
判断这条群消息是否与我有关，输出 0-1 的相关性分数和处理建议。
消息：${message.content}
发送者：${message.peerName}
输出 JSON：{ "relevance": 0.8, "action": "priority|enqueue|drop" }
`);
      const { relevance, action } = JSON.parse(result);

      message.metadata = { ...message.metadata, relevance };

      // 检查是否涉及图片，需要切换模型
      const instructions = message.images?.length
        ? { switchModel: 'opus' }  // 视觉任务用 opus
        : undefined;

      if (relevance < this.config.relevance_threshold) {
        return { action: 'drop', reason: `相关性 ${relevance} 过低` };
      }

      return {
        action: 'process',
        queueBehavior: action === 'priority' ? 'priority' : 'enqueue',
        instructions,
        reason: `相关性 ${relevance}`,
      };
    } catch (error) {
      this.context.logger.warn(`[DualSession] 判断失败，降级处理: ${error}`);
      return { action: 'process', queueBehavior: 'enqueue' };
    }
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    // 群聊用工具调用发送
    return { method: 'tool-required' };
  }
}
```

### 6.2 上下文增强模式

```typescript
export class ContextEnhancedMode implements ResponseMode {
  readonly id = 'context-enhanced';
  readonly displayName = '上下文增强模式';
  readonly description = '处理前注入群规则文档';
  readonly type = 'builtin' as const;
  readonly applicableScenes = ['group'] as const;
  readonly configSchema = {
    type: 'object',
    properties: {
      document_sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['file', 'url', 'storage'] },
            path: { type: 'string' },
          },
        },
      },
    },
  };

  private queue = new FIFOQueue();
  private documents: string[] = [];
  private context!: ResponseModeContext;

  async initialize(context: ResponseModeContext) {
    this.context = context;
    // 加载群规则文档
    this.documents = await this.loadDocuments(context.modeConfig?.document_sources ?? []);
  }

  async cleanup() {
    this.queue.clear();
  }

  getQueue() { return this.queue; }

  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    return {
      action: 'process',
      queueBehavior: 'enqueue',
      instructions: {
        // 注入群规则文档作为上下文
        injectContext: this.documents,
      },
    };
  }

  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    return { method: 'tool-required' };
  }

  private async loadDocuments(sources: any[]): Promise<string[]> {
    const docs: string[] = [];
    for (const source of sources) {
      if (source.type === 'file') {
        docs.push(await fs.promises.readFile(source.path, 'utf-8'));
      }
      // url / storage 处理...
    }
    return docs;
  }
}
```

---

## 七、检查清单

开发新模式时，确保：

- [ ] 实现了 `ResponseMode` 接口的所有必需方法
- [ ] 元数据字段完整（id/displayName/description/type/applicableScenes/configSchema）
- [ ] `configSchema` 准确描述了所有配置参数
- [ ] `initialize` 正确读取配置并提供默认值
- [ ] `cleanup` 释放了所有资源
- [ ] `handleInbound`/`handleOutbound` 有错误处理和降级逻辑
- [ ] 决策对象填写了 `reason` 字段
- [ ] 选择了合适的队列实现
- [ ] 会话级状态做了隔离（如果实例共享）
- [ ] 编写了单元测试
- [ ] 在 `extensions/index.ts` 注册
- [ ] 更新了 `builtin-modes.md` 文档（如果是内置模式）

---

## 附录：相关文档

- [架构设计](./architecture.md)
- [命令参考](./command-reference.md)
- [配置参考](./config-reference.md)
- [内置模式文档](./builtin-modes.md)
