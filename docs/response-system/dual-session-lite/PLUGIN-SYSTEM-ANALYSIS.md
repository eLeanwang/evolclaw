# 响应模式插件体系分析与重构方案

**文档版本**: 1.0  
**创建时间**: 2026-07-04  
**分析者**: Claude Code (Opus 4.8)

---

## 一、现有插件体系梳理

### 1.1 目录结构

```
src/response-modes/
├── types.ts                     # 核心类型定义（ResponseMode 接口）
├── registry.ts                  # 响应模式注册表
├── coordinator.ts               # 响应模式协调器（调度中枢）
├── resolver.ts                  # 响应模式解析器（配置 → 模式实例）
├── context-builder.ts           # 上下文构建器（依赖注入）
├── decision-executor.ts         # 决策执行器（InboundDecision → 实际操作）
├── builtin-meta.ts             # 内置模式元数据
├── extensions.ts                # 扩展能力类型守卫
├── index.ts                     # 公共 API 导出
├── core/                        # 内置响应模式
│   ├── index.ts                # 注册内置模式
│   ├── interactive.ts          # 交互模式（每条消息立即回复）
│   └── proactive.ts            # 主动模式（工具调用才回复）
└── queues/                      # 队列实现
    ├── fifo-queue.ts           # FIFO 队列
    ├── lifo-queue.ts           # LIFO 队列
    └── priority-queue.ts       # 优先级队列
```

### 1.2 核心接口

#### ResponseMode 接口（src/response-modes/types.ts）

```typescript
interface ResponseMode {
  // 元数据
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly type: 'builtin' | 'extension';
  readonly applicableScenes: ('private' | 'group')[];
  readonly configSchema?: JSONSchema;
  
  // 生命周期
  initialize(context: ResponseModeContext): Promise<void>;
  cleanup(): Promise<void>;
  
  // 核心能力
  handleInbound(message: InboundMessage): Promise<InboundDecision>;
  handleOutbound(payload: OutboundPayload): Promise<OutboundDecision>;
  getQueue(): MessageQueueInterface;
  
  // 处理流程钩子（可选）
  beforeProcess?(ctx: ProcessContext): Promise<void> | void;
  configureRun?(ctx: ProcessContext): RunConfig | undefined;
  onToolUse?(ctx: ToolUseContext): Promise<void> | void;
  onComplete?(ctx: CompleteContext): Promise<void> | void;
  afterProcess?(ctx: AfterProcessContext): Promise<void> | void;
}
```

**关键发现**：
- ✅ 已有完整的生命周期钩子
- ✅ 支持自定义队列实现
- ⚠️ `handleInbound` 假设**单次调用**（消息到达 → 立即决策）
- ⚠️ `handleOutbound` 假设**同步决策**（输出到达 → 立即决策是否发送）
- ❌ **不支持异步多阶段决策**（双会话需要：入队 → 辅助判断 → 投递 → 主处理）

### 1.3 协调器工作流程

#### ResponseModeCoordinator（src/response-modes/coordinator.ts）

```typescript
class ResponseModeCoordinator {
  // 解析会话该用哪个响应模式 + 运行 handleInbound
  async resolveInbound(
    message: InboundMessage,
    deps: CoordinatorInboundDeps,
    chatModeFallback: string | undefined,
  ): Promise<ResolvedInbound | null>
  
  // 对某个出站 payload 运行 handleOutbound
  async resolveOutbound(
    resolved: ResolvedInbound,
    payload: OutboundPayload,
  ): Promise<OutboundDecision>
}
```

**工作流程**：
```
消息到达 
  ↓
Coordinator.resolveInbound(message)
  ↓
ResponseMode.handleInbound(message)
  ↓ 返回 InboundDecision
{
  action: 'process' | 'drop' | 'defer',
  queueBehavior: 'enqueue' | 'priority' | 'interrupt',
  runtimeState: { ... }
}
  ↓
DecisionExecutor 执行决策
  ↓
消息入队 / 立即处理 / 丢弃
```

**关键发现**：
- ✅ `handleInbound` **一次调用，立即返回决策**
- ❌ 双会话需要：入队 → 防抖 → 辅助判断 → 投递（**多次异步决策**）
- ❌ 现有架构假设"消息到达 = 立即知道怎么处理"

---

## 二、双会话模式的架构挑战

### 2.1 核心冲突

| 维度 | 现有架构 | 双会话需求 | 冲突点 |
|------|---------|-----------|--------|
| **决策时机** | 消息到达时立即决策 | 入队 → 防抖 → 辅助判断 → 延迟决策 | ⚠️ 高冲突 |
| **决策阶段** | 单阶段（handleInbound 一次返回） | 多阶段（辅助 → 主会话，两次决策） | ⚠️ 高冲突 |
| **队列管理** | 单队列（ResponseMode.getQueue()） | 双队列（辅助队列 + 主队列） | ⚠️ 高冲突 |
| **会话管理** | 单会话（通过 context.runner 调用） | 双会话（辅助会话 + 主会话，独立管理） | ⚠️ 中冲突 |
| **钩子时机** | 同步调用（beforeProcess/onToolUse） | 异步触发（防抖超时、延迟超时） | ⚠️ 中冲突 |

### 2.2 具体问题

#### 问题 1：handleInbound 无法表达"延迟决策"

**现有模式**：
```typescript
// proactive.ts
async handleInbound(message: InboundMessage): Promise<InboundDecision> {
  return {
    action: 'process',  // 立即决定"要处理"
    queueBehavior: 'enqueue',  // 立即决定"入队到主队列"
  };
}
```

**双会话需求**：
```typescript
// 需要的流程
async handleInbound(message: InboundMessage): Promise<InboundDecision> {
  // 阶段 1：入队到辅助队列（不是主队列！）
  auxiliaryQueue.enqueue(message);
  
  // 阶段 2：防抖 3 秒后触发辅助会话
  // 阶段 3：辅助会话判断 hold/delay/transfer
  // 阶段 4：delay 消息等待延迟超时
  // 阶段 5：transfer 消息投递到主队列
  
  // ❌ 问题：这些是异步的，handleInbound 不能立即返回最终决策
  
  return {
    action: 'drop',  // ？？？临时方案：先"不处理"，等后续异步决策
  };
}
```

#### 问题 2：没有"辅助队列"的概念

现有架构：
```
消息 → handleInbound → action='process' → 主队列 → 主会话
```

双会话需求：
```
消息 → 辅助队列 → 防抖 → 辅助会话判断 → 主队列 → 主会话
        ↑                    ↓
      新增的                hold/delay（不投递）
```

**问题**：
- `ResponseMode.getQueue()` 返回**单个队列**
- 没有"辅助队列"和"主队列"的概念
- `InboundDecision.queueBehavior` 只能控制**主队列**

#### 问题 3：钩子时机不匹配

现有钩子：
```typescript
beforeProcess(ctx)    // 出队后、Runner 调用前
configureRun(ctx)     // Runner 调用前
onToolUse(ctx)        // 流处理期间
onComplete(ctx)       // 流处理完成
afterProcess(ctx)     // Runner 返回后
```

双会话需要的钩子：
```typescript
onAuxiliaryEnqueue()      // 消息入队到辅助队列
onAuxiliaryTrigger()      // 防抖超时，触发辅助会话
onAuxiliaryDecision()     // 辅助会话判断完成
onMainTransfer()          // 消息投递到主队列
onMainProcess()           // 主会话开始处理
onMainFeedback()          // 主会话反馈到辅助会话
```

**问题**：
- 现有钩子都是"主会话处理流程"的钩子
- 双会话的"辅助判断流程"没有对应的钩子

---

## 三、重构方案对比

### 方案 A：扩展现有插件体系

**思路**：在现有 `ResponseMode` 接口基础上扩展

#### 优点
- ✅ 保持向后兼容
- ✅ 复用现有基础设施（Registry、Coordinator、ContextBuilder）
- ✅ 学习成本低

#### 缺点
- ❌ 需要大量 Hack：用 `action: 'drop'` + 自定义处理器绕过
- ❌ 接口语义扭曲：`handleInbound` 变成"只是入队，不是真的决策"
- ❌ 双队列管理复杂：需要在 `MessageQueue` 中硬编码双队列逻辑
- ❌ 后续扩展困难：每个新的多阶段模式都需要重新 Hack

#### 实施难度
- 核心修改：中等（需要修改 `MessageQueue`、`DecisionExecutor`）
- 兼容性风险：中等（可能影响现有模式）
- 维护成本：高（Hack 代码难以理解和维护）

---

### 方案 B：新插件引擎（推荐）

**思路**：实现新的插件引擎，现有引擎作为其中一个插件

#### 架构设计

```
新插件引擎：ResponseEngine
├── ResponseEngineV1Plugin      # 包装现有整个响应模式系统
│   ├── Registry
│   ├── Coordinator
│   ├── interactive.ts
│   ├── proactive.ts
│   └── ...
└── ResponseEngineV2Plugin      # 双会话响应模式（新实现）
    ├── DualSessionEngine
    ├── AuxiliaryQueue
    ├── AuxiliarySession
    ├── MainQueue
    └── MainSession
```

#### 新引擎接口

```typescript
/**
 * 响应引擎接口（V2）
 * 支持多阶段异步决策、双队列、双会话
 */
interface ResponseEngine {
  // 元数据
  readonly id: string;
  readonly version: 'v1' | 'v2';
  readonly displayName: string;
  
  // 生命周期
  initialize(context: ResponseEngineContext): Promise<void>;
  cleanup(): Promise<void>;
  
  // 核心能力
  /**
   * 接管消息处理流程
   * @param message 入站消息
   * @returns 处理完成的 Promise（支持异步多阶段）
   */
  processMessage(message: InboundMessage): Promise<void>;
  
  /**
   * 处理出站消息
   * @param payload 出站内容
   */
  processOutbound(payload: OutboundPayload): Promise<void>;
}
```

#### V1Plugin 实现（包装现有系统）

```typescript
class ResponseEngineV1Plugin implements ResponseEngine {
  readonly id = 'v1-legacy';
  readonly version = 'v1';
  readonly displayName = '传统响应模式（interactive/proactive）';
  
  private registry: ResponseModeRegistry;
  private coordinator: ResponseModeCoordinator;
  
  async initialize(context: ResponseEngineContext): Promise<void> {
    // 初始化现有的响应模式系统
    this.registry = new ResponseModeRegistry();
    registerBuiltinModes(this.registry);
    this.coordinator = new ResponseModeCoordinator(this.registry);
  }
  
  async processMessage(message: InboundMessage): Promise<void> {
    // 调用现有的 Coordinator.resolveInbound
    const resolved = await this.coordinator.resolveInbound(message, ...);
    
    if (resolved && resolved.decision.action === 'process') {
      // 执行现有的入队逻辑
      await this.enqueueToLegacyQueue(message, resolved.decision);
    }
  }
  
  async processOutbound(payload: OutboundPayload): Promise<void> {
    // 调用现有的 Coordinator.resolveOutbound
    const decision = await this.coordinator.resolveOutbound(..., payload);
    
    if (decision.method === 'direct') {
      await this.sendDirect(payload, decision.type);
    }
  }
}
```

#### V2Plugin 实现（双会话模式）

```typescript
class ResponseEngineV2Plugin implements ResponseEngine {
  readonly id = 'v2-dual-session';
  readonly version = 'v2';
  readonly displayName = '双会话响应模式';
  
  private auxiliaryQueue: AuxiliaryQueue;
  private auxiliarySession: AuxiliarySession;
  private mainQueue: MainQueue;
  private mainSession: MainSession;
  
  async initialize(context: ResponseEngineContext): Promise<void> {
    // 初始化双队列、双会话
    this.auxiliaryQueue = new AuxiliaryQueue(context);
    this.auxiliarySession = new AuxiliarySession(context);
    this.mainQueue = new MainQueue(context);
    this.mainSession = new MainSession(context);
  }
  
  async processMessage(message: InboundMessage): Promise<void> {
    // mention 快速通道
    if (this.config.mentionMode === 'mention-only' && message.isMentioned) {
      await this.mainQueue.interrupt([message]);
      return;
    }
    
    // 入队到辅助队列（异步流程开始）
    await this.auxiliaryQueue.enqueue(message);
    
    // 防抖、辅助判断、投递都由 AuxiliaryQueue 内部异步处理
    // processMessage 返回并不代表消息处理完成
  }
  
  async processOutbound(payload: OutboundPayload): Promise<void> {
    // proactive 模式：普通文本不发送
    if (payload.kind === 'activity.batch') {
      // 思考过程，不发送
      return;
    }
    
    // 实际回复通过 CLI 发送（在主会话 turn 内）
    await this.sendDirect(payload);
  }
}
```

#### 引擎选择器

```typescript
class ResponseEngineSelector {
  private engines = new Map<string, ResponseEngine>();
  
  register(engine: ResponseEngine): void {
    this.engines.set(engine.id, engine);
  }
  
  select(config: AgentConfig, chatType: 'private' | 'group'): ResponseEngine {
    const engineId = config.response_engine?.id;
    
    if (engineId === 'v2-dual-session') {
      return this.engines.get('v2-dual-session')!;
    }
    
    // 默认使用 V1（向后兼容）
    return this.engines.get('v1-legacy')!;
  }
}
```

### 方案 B 的优点

1. **构清晰**：
   - V1 和 V2 完全隔离，互不影响
   - 现有系统（interactive/proactive）零修改
   - 双会话模式独立实现，无需 Hack

2. **接口语义正确**：
   - `processMessage()` 明确表达"接管整个处理流程"
   - 不需要扭曲 `handleInbound` 的语义

3. **扩展性好**：
   - 未来可以继续添加 V3、V4 引擎
   - 每个引擎独立演进，不互相干扰

4. **向后兼容**：
   - 现有配置不变，默认使用 V1
   - 用户可以逐步迁移到 V2

5. **测试友好**：
   - V1 和 V2 可以独立测试
   - 不会因为测试 V2 而破坏 V1

### 方案 B 的缺点

1. **初期工作量稍大**：
   - 需要设计新的 `ResponseEngine` 接口
   - 需要包装现有系统为 `V1Plugin`

2. **概念学习成本**：
   - 新概念：ResponseEngine（但比 Hack 现有接口更容易理解）

---

## 四、推荐方案：方案 B（新插件引擎）

### 4.1 实施路径

#### 阶段 1：设计新引擎接口（1 天）

**新建文件**：
- `src/response-engine/types.ts`（新引擎接口定义）
- `src/response-engine/selector.ts`（引擎选择器）

#### 阶段 2：包装现有系统为 V1Plugin（2 天）

**新建文件**：
- `src/response-engine/v1-legacy/index.ts`（V1Plugin 实现）
- `src/response-engine/v1-legacy/adapter.ts`（适配器，连接 V1Plugin 和现有系统）

**修改文件**：
- `src/core/message/response-engine.ts`（接入 ResponseEngineSelector）

#### 阶段 3：实现 V2Plugin（双会话模式）（2 周）

**新建目录**：
- `src/response-engine/v2-dual-session/`（双会话引擎实现）

#### 阶段 4：集成测试（1 周）

---

### 4.2 目录结构（重构后）

```
src/
├── response-modes/                    # V1：现有响应模式系统（不动）
│   ├── types.ts
│   ├── registry.ts
│   ├── coordinator.ts
│   ├── core/
│   │   ├── interactive.ts
│   │   └── proactive.ts
│   └── ...
│
├── response-engine/                   # 新增：响应引擎系统
│   ├── types.ts                      # ResponseEngine 接口定义
│   ├── selector.ts                   # 引擎选择器
│   ├── context.ts                    # 引擎上下文（依赖注入）
│   │
│   ├── v1-legacy/                    # V1Plugin：包装现有响应模式系统
│   │   ├── index.ts                 # V1Plugin 实现
│   │   └── adapter.ts               # 适配器
│   │
│   └── v2-dual-session/              # V2Plugin：双会话响应模式
│       ├── index.ts                 # V2Plugin 实现
│       ├── auxiliary-queue.ts
│       ├── auxiliary-session.ts
│       ├── main-queue.ts
│       ├── main-session.ts
│       └── types.ts
│
└── core/message/
    └── response-engine.ts            # 修改：接入 ResponseEngineSelector
```

---

### 4.3 配置方式

#### 使用 V1（现有模式，默认）

```json
{
  "aid": "agent.aid.pub",
  "response_modes": {
    "private": "proactive",
    "group": "proactive"
  }
}
```

#### 使用 V2（双会话模式）

```json
{
  "aid": "agent.aid.pub",
  "response_engine": {
    "id": "v2-dual-session",
    "config": {
      "auxiliaryModel": "deepseek-v4-flash",
      "mainModel": "claude-opus",
      "mentionMode": "disabled",
      "debounceMs": 3000,
      "maxQueueSize": 50
    }
  }
}
```

---

### 4.4 迁移路径

#### 阶段 1：共存（V1 为默认）
- V1 和 V2 共存
- 默认使用 V1（向后兼容）
- 用户可以手动切换到 V2

#### 阶段 2：推荐 V2
- 文档推荐使用 V2
- V1 进入维护模式（不再新增功能）

#### 阶段 3：废弃 V1（可选，1 年后）
- V1 标记为 deprecated
- 提供自动迁移工具

---

## 五、结论

### 推荐采用方案 B：新插件引擎

**理由**：
1. ✅ **架构清晰**：V1 和 V2 完全隔离
2. ✅ **语义正确**：不需要扭曲现有接口
3. ✅ **向后兼容**：现有系统零修改
4. ✅ **扩展性好**：未来可以继续添加新引擎
5. ✅ **维护成本低**：避免 Hack 代码

**实施计划**：
- Phase 1：设计新引擎接口（1 天）
- Phase 2：包装现有系统为 V1Plugin（2 天）
- Phase 3：实现 V2Plugin（2 周）
- Phase 4：集成测试（1 周）

**总工作量**：2-3 周（与直接扩展现有系统的工作量相当，但架构更清晰）

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-04  
**状态**: ✅ 推荐采用方案 B
