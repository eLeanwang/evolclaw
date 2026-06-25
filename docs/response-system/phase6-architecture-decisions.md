# Phase 6 架构决策记录（ADR）

**文档版本**: 1.0  
**创建日期**: 2026-06-24  
**状态**: ✅ 已定稿

---

## 目录

1. [ADR-001: Fork 策略而非直接重构](#adr-001-fork-策略而非直接重构)
2. [ADR-002: 决策对象而非直接执行](#adr-002-决策对象而非直接执行)
3. [ADR-003: 5 个钩子的设计](#adr-003-5-个钩子的设计)
4. [ADR-004: 依赖注入设计](#adr-004-依赖注入设计)
5. [ADR-005: Registry 与 Resolver 分离](#adr-005-registry-与-resolver-分离)

---

## ADR-001: Fork 策略而非直接重构

### 背景

MessageProcessor 是 EvolClaw 的核心消息处理引擎，承载了复杂的业务逻辑：
- 渠道适配器管理
- 会话状态管理
- 消息队列协调
- Agent Runner 调度
- 权限策略执行

目标：将响应逻辑从 MessageProcessor 迁移到插件化的响应模式系统。

### 决策

**选择**：Fork MessageProcessor 为 ResponseEngine，而非直接重构 MessageProcessor。

**理由**：

1. **零破坏性迁移**
   - MessageProcessor 保留作为参考真相（ground truth）
   - 可随时对比新旧引擎行为，快速定位回归
   - 迁移失败可立即回滚，不影响生产

2. **渐进式验证**
   - Fork 后可并行运行两个引擎，收集行为快照对比
   - 验证通过后再切换默认引擎
   - 降低迁移风险

3. **清晰的边界**
   - ResponseEngine 专注于响应模式协调
   - MessageProcessor 的其他职责（渠道管理、队列管理）保持不变
   - 职责分离更清晰

4. **未来可删除**
   - 迁移完成后，MessageProcessor 归档到 `_archived/`
   - 不参与编译，仅作历史参考
   - 代码库不会永久膨胀

### 替代方案

**方案 A**：直接在 MessageProcessor 中重构响应逻辑
- ❌ 风险高：单一代码路径，出错影响所有会话
- ❌ 难以验证：无法对比新旧行为
- ❌ 回滚困难：需要 git revert，可能引入新问题

**方案 B**：创建全新架构，废弃 MessageProcessor
- ❌ 工作量大：需要重新实现渠道管理、队列管理等
- ❌ 风险极高：可能引入大量新 bug
- ❌ 时间成本：数周到数月

### 结果

✅ Fork 策略成功：
- ResponseEngine 实现完成，行为与 MessageProcessor 一致
- 快照对比验证通过（source, chatMode, proactiveState, policyHook）
- MessageProcessor 已归档，零引用
- 迁移总耗时：约 3 天（vs. 全新架构的数周）

---

## ADR-002: 决策对象而非直接执行

### 背景

响应模式需要决定：
- **入站决策**：是否处理消息、是否立即响应、如何构造会话上下文
- **出站决策**：哪些输出作为回复、哪些作为思考过程、哪些被抑制

两种设计方向：
1. 响应模式直接执行（调用 adapter.send、修改会话状态）
2. 响应模式返回决策对象，由执行层统一执行

### 决策

**选择**：响应模式返回决策对象（InboundDecision / OutboundDecision），执行层负责执行。

**理由**：

1. **职责分离**
   - 响应模式：**决策逻辑**（"怎么判断"）
   - 执行层：**执行机制**（"怎么做"）
   - 单一职责原则，易于理解和维护

2. **可测试性**
   - 响应模式单元测试只需验证决策对象的字段
   - 无需 mock adapter、session、runner 等复杂依赖
   - 测试更快、更稳定

3. **可观察性**
   - 决策对象可序列化、可记录
   - 快照探针可捕获决策点，便于调试
   - 未来可实现"决策回放"功能

4. **灵活性**
   - 执行层可统一处理错误（重试、降级）
   - 可插入中间件（审计、限流、加密）
   - 决策和执行解耦，便于扩展

5. **防止副作用**
   - 响应模式不能直接修改全局状态
   - 避免模式间相互干扰
   - 提高系统可靠性

### 替代方案

**方案 A**：响应模式直接执行
- ❌ 职责不清：决策和执行混在一起
- ❌ 难以测试：需要 mock 大量依赖
- ❌ 难以调试：副作用分散，难以追踪
- ❌ 扩展性差：每个模式都要处理错误、重试等

### 实现

#### InboundDecision
```typescript
interface InboundDecision {
  action: 'process' | 'drop' | 'defer';
  context?: Partial<ResponseModeContext>;  // 可选：注入额外上下文
}
```

#### OutboundDecision
```typescript
interface OutboundDecision {
  action: 'send' | 'suppress';
  reason?: string;  // suppress 时的原因（thought/background/filtered）
}
```

#### 执行流程
```
用户消息 → ResponseMode.handleInbound() → InboundDecision
           ↓
         执行层解析决策
           ↓
         调用 Agent Runner 处理
           ↓
Agent 输出 → ResponseMode.handleOutbound() → OutboundDecision
           ↓
         执行层根据决策发送/抑制
```

### 结果

✅ 决策对象模式成功：
- 响应模式代码简洁（InteractiveMode ~80 行，ProactiveMode ~150 行）
- 单元测试易写（无需复杂 mock）
- 快照探针成功捕获所有决策点
- 未来扩展性强（可插入中间件）

---

## ADR-003: 5 个钩子的设计

### 背景

响应模式需要在消息处理的不同阶段介入：
- 构造初始状态
- 配置运行时策略
- 工具调用时提醒
- 处理完成时检查
- 后处理（文件发送、兜底逻辑）

需要设计合适的钩子点，既要覆盖所有需求，又要避免过度设计。

### 决策

**选择**：5 个钩子，不多不少。

```typescript
interface ResponseMode {
  // 必须实现（决策核心）
  handleInbound(msg: InboundMessage, ctx: ResponseModeContext): Promise<InboundDecision>;
  handleOutbound(payload: OutboundPayload, ctx: ResponseModeContext): Promise<OutboundDecision>;
  
  // 可选钩子（生命周期介入点）
  beforeProcess?(msg: InboundMessage, ctx: ResponseModeContext): Promise<void>;
  configureRun?(ctx: ResponseModeContext): Promise<ConfigureRunResult>;
  onToolUse?(toolName: string, ctx: ResponseModeContext): Promise<void>;
  onComplete?(ctx: ResponseModeContext): Promise<void>;
  afterProcess?(ctx: ResponseModeContext): Promise<void>;
}
```

**理由**：

### 钩子 1: `beforeProcess` - 构造初始状态

**用途**：在消息处理前构造响应模式特有的状态。

**ProactiveMode 用例**：
```typescript
async beforeProcess(msg, ctx) {
  const state = new ProactiveRuntimeState(
    this.config.pre_tool_1stmsgchk ?? true,
    this.config.tool_use_reminder ?? true,
    ctx.chatType
  );
  ctx.runtime.proactiveState = state;
}
```

**为什么需要**：
- 状态构造逻辑属于响应模式，不应写死在执行层
- 不同模式有不同的状态需求（InteractiveMode 不需要 ProactiveRuntimeState）

### 钩子 2: `configureRun` - 配置运行时策略

**用途**：提供 policyHook、streamHook 等运行时策略回调。

**ProactiveMode 用例**：
```typescript
async configureRun(ctx) {
  return {
    policyHook: (toolName) => {
      // 首工具表态检查
      if (ctx.runtime.proactiveState.preTool1stMsgChk && !hasUsedTool) {
        return toolName === 'ec msg send' || toolName === 'ec group send';
      }
      return true;
    }
  };
}
```

**为什么需要**：
- policyHook 是运行时注入的，不能在 beforeProcess 中设置
- 不同模式有不同的策略（InteractiveMode 无策略，ProactiveMode 有首工具表态）

### 钩子 3: `onToolUse` - 工具调用提醒

**用途**：Agent 调用工具时触发，用于计数、提醒、日志。

**ProactiveMode 用例**：
```typescript
async onToolUse(toolName, ctx) {
  const state = ctx.runtime.proactiveState;
  if (!state.toolUseReminder) return;
  
  state.toolUsageCount++;
  if (state.toolUsageCount === 10) {
    // 发送"已调用 10 次工具"提醒
  }
  // 检查队列未读消息，提醒用户
}
```

**为什么需要**：
- 工具汇报提醒是 ProactiveMode 特有的
- 执行层不应知道"10 次工具提醒"的业务规则

### 钩子 4: `onComplete` - 完成时检查

**用途**：Agent 处理完成时触发，用于标志位检查、状态重置。

**ProactiveMode 用例**：
```typescript
async onComplete(ctx) {
  const state = ctx.runtime.proactiveState;
  // 检查 lastProactiveFlag，决定是否需要特殊处理
  if (state.lastProactiveFlag) {
    // 处理逻辑
  }
}
```

**为什么需要**：
- Proactive 模式有特殊的完成逻辑（标志位检查）
- Interactive 模式无此需求

### 钩子 5: `afterProcess` - 后处理

**用途**：消息处理完成后的清理、兜底、特殊发送。

**InteractiveMode 用例**：
```typescript
async afterProcess(ctx) {
  // 处理文件标记 [SEND_FILE:path/to/file]
  const fileMarkers = extractFileMarkers(ctx.outputs);
  for (const marker of fileMarkers) {
    await sendFile(marker.path, marker.channel);
  }
}
```

**ProactiveMode 用例**：
```typescript
async afterProcess(ctx) {
  // Unknown skill 兜底：如果 Agent 调用了不存在的 skill，发送错误提示
  if (ctx.runtime.unknownSkillInvoked) {
    await sendError("未知技能");
  }
}
```

**为什么需要**：
- 文件标记处理是 Interactive 特有的
- Unknown skill 兜底是 Proactive 特有的
- 这些逻辑不属于主流程，应该在后处理中统一处理

### 为什么不更多钩子？

考虑过的钩子，但**不需要**：

- ❌ `onStreamStart` / `onStreamChunk` / `onStreamEnd`：流式输出由 baseagent 层处理，响应模式无需介入
- ❌ `onError`：错误处理由执行层统一处理，响应模式无需定制
- ❌ `onRetry`：重试逻辑在渠道层，响应模式无需感知
- ❌ `onQueueAdd` / `onQueuePop`：队列管理与响应模式无关

### 为什么不更少钩子？

如果合并钩子会怎样？

- ❌ 合并 `beforeProcess` 和 `configureRun`：configureRun 返回的是运行时回调，不能在 beforeProcess 中设置
- ❌ 合并 `onComplete` 和 `afterProcess`：onComplete 在 Agent 完成时立即触发，afterProcess 在所有输出处理完后触发，时机不同
- ❌ 删除 `onToolUse`：工具提醒是 Proactive 的核心功能，不能靠轮询实现

### 结果

✅ 5 个钩子恰到好处：
- 覆盖了所有迁移点（Phase 6 的 6 个迁移点全部接入）
- 没有冗余钩子（每个钩子都有实际用例）
- 扩展性强（未来新模式可复用这 5 个钩子）

---

## ADR-004: 依赖注入设计

### 背景

响应模式需要访问：
- 会话状态（Session）
- Agent 配置（AgentConfig）
- Agent Runner（执行工具、发送消息）
- 渠道能力（是否支持 thought、interaction）

两种设计方向：
1. 响应模式直接持有依赖（构造函数注入）
2. 响应模式无状态，依赖通过 Context 参数传递

### 决策

**选择**：响应模式无状态，依赖通过 `ResponseModeContext` 参数传递。

```typescript
interface ResponseModeContext {
  session: any;
  agentConfig: AgentConfig;
  runner: AgentRunnerFull;
  channel: {
    type: string;
    capabilities: {
      supportsThought: boolean;
      supportsInteraction: boolean;
    };
  };
  chatType: 'private' | 'group';
  peerKey?: string;
  runtime: Record<string, any>;  // 运行时状态存储
}
```

**理由**：

1. **无状态响应模式**
   - 响应模式实例可复用，不绑定特定会话
   - Registry 只需注册一次，所有会话共享
   - 减少内存开销

2. **依赖明确**
   - 每个钩子方法签名都包含 `ctx: ResponseModeContext`
   - 一眼看出响应模式可以访问什么
   - 避免隐式依赖

3. **测试友好**
   - 单元测试只需构造 mock Context 对象
   - 不需要构造完整的响应模式实例
   - 测试更简单、更快

4. **运行时灵活**
   - 不同会话可传递不同的 Context
   - 可在运行时动态调整依赖（如切换 runner）
   - 无需重新创建响应模式实例

5. **防止状态泄漏**
   - 响应模式不持有会话状态，不会跨会话污染
   - 所有状态存在 `ctx.runtime` 中，生命周期清晰
   - 提高系统可靠性

### 替代方案

**方案 A**：构造函数注入依赖
```typescript
class ProactiveMode {
  constructor(
    private session: any,
    private agentConfig: AgentConfig,
    private runner: AgentRunnerFull,
    private channel: any
  ) {}
}
```
- ❌ 有状态：每个会话需要创建新实例
- ❌ 内存开销：大量会话 = 大量实例
- ❌ 难以复用：响应模式实例与会话绑定

**方案 B**：全局单例 + Setter 注入
```typescript
const proactiveMode = ProactiveMode.getInstance();
proactiveMode.setSession(session);
proactiveMode.setRunner(runner);
```
- ❌ 线程不安全：并发会话会相互覆盖
- ❌ 难以测试：全局状态难以隔离
- ❌ 反模式：违反依赖注入原则

### 实现

#### ContextBuilder 负责构造 Context

```typescript
class ContextBuilder {
  build(
    session: any,
    agentConfig: AgentConfig,
    runner: AgentRunnerFull,
    channelType: string,
    chatType: 'private' | 'group',
    peerKey?: string
  ): ResponseModeContext {
    return {
      session,
      agentConfig,
      runner,
      channel: {
        type: channelType,
        capabilities: this.getChannelCapabilities(channelType),
      },
      chatType,
      peerKey,
      runtime: {},  // 空对象，响应模式可自由存储状态
    };
  }
}
```

#### 响应模式使用 Context

```typescript
class ProactiveMode implements ResponseMode {
  async beforeProcess(msg: InboundMessage, ctx: ResponseModeContext) {
    // 从 ctx 读取配置
    const config = ctx.agentConfig.response_modes?.configs?.proactive ?? {};
    
    // 存储状态到 ctx.runtime
    ctx.runtime.proactiveState = new ProactiveRuntimeState(
      config.pre_tool_1stmsgchk ?? true,
      config.tool_use_reminder ?? true,
      ctx.chatType
    );
  }
  
  async handleOutbound(payload: OutboundPayload, ctx: ResponseModeContext) {
    // 从 ctx.runtime 读取状态
    const state = ctx.runtime.proactiveState;
    
    // 使用 ctx.channel 能力判断
    if (ctx.channel.capabilities.supportsThought) {
      // 支持 thought，可发送思考过程
    }
    
    return { action: 'send' };
  }
}
```

### 结果

✅ Context 注入成功：
- 响应模式实例无状态，Registry 只注册一次
- 单元测试只需 mock Context，无需复杂依赖
- 运行时状态清晰（存在 `ctx.runtime`），无状态泄漏
- 代码简洁易懂

---

## ADR-005: Registry 与 Resolver 分离

### 背景

响应模式系统需要：
1. **注册**：内置模式 + 扩展插件的发现与注册
2. **解析**：根据配置（default_private / default_group / overrides）选择模式

两种设计方向：
1. Registry 同时负责注册和解析
2. Registry 负责注册，Resolver 负责解析

### 决策

**选择**：Registry 与 Resolver 分离。

**理由**：

1. **单一职责**
   - Registry：模式注册表（name → ResponseMode 映射）
   - Resolver：配置解析器（根据 chatType / peerKey / config 选择模式）
   - 职责清晰，易于理解

2. **解析逻辑复杂**
   - 配置有 3 层优先级（override > default > fallback）
   - 配置格式可能演化（未来可能支持正则匹配、条件表达式）
   - 解析逻辑独立出来，便于扩展和测试

3. **Registry 保持简单**
   - Registry 只做 `register(id, mode)` 和 `get(id)`
   - 不需要知道配置格式、优先级规则
   - 可被其他模块复用（如 CLI 查询模式列表）

4. **Resolver 可独立测试**
   - 解析逻辑单元测试：给定配置，验证选择的模式 ID
   - 无需 mock ResponseMode 实例
   - 测试更快、更专注

5. **未来扩展性**
   - 如果解析规则变复杂（如支持 Lua 脚本配置），只需改 Resolver
   - Registry 无需变动
   - 模式实现无需变动

### 替代方案

**方案 A**：Registry 包含解析逻辑
```typescript
class ResponseModeRegistry {
  register(id: string, mode: ResponseMode): void;
  get(id: string): ResponseMode | undefined;
  resolve(chatType, peerKey, config): ResponseMode;  // ❌ 职责混淆
}
```
- ❌ 职责不清：注册表为什么要知道配置格式？
- ❌ 难以扩展：解析规则变化影响注册表
- ❌ 难以测试：解析逻辑和注册逻辑耦合

### 实现

#### Registry：简单的注册表

```typescript
class ResponseModeRegistry {
  private modes = new Map<string, ResponseMode>();
  
  register(id: string, mode: ResponseMode): void {
    if (this.modes.has(id)) {
      throw new Error(`[Registry] mode '${id}' already registered`);
    }
    this.modes.set(id, mode);
  }
  
  get(id: string): ResponseMode | undefined {
    return this.modes.get(id);
  }
  
  list(): string[] {
    return Array.from(this.modes.keys());
  }
}
```

#### Resolver：配置解析器

```typescript
class ResponseModeResolver {
  constructor(private registry: ResponseModeRegistry) {}
  
  resolve(
    chatType: 'private' | 'group',
    peerKey: string | undefined,
    config: ResponseModesConfig | undefined
  ): ResolvedMode {
    // 1. relation override
    if (peerKey && config?.overrides?.[peerKey]) {
      const ov = config.overrides[peerKey];
      const mode = this.registry.get(ov.mode);
      if (mode) {
        return { mode, config: {...baseConfig, ...ov.config}, source: 'override' };
      }
    }
    
    // 2. chatType default
    const defaultId = chatType === 'group' ? config?.default_group : config?.default_private;
    if (defaultId) {
      const mode = this.registry.get(defaultId);
      if (mode) {
        return { mode, config: config?.configs?.[defaultId] ?? {}, source: 'default' };
      }
    }
    
    // 3. fallback
    const fallbackId = chatType === 'group' ? 'proactive' : 'interactive';
    const mode = this.registry.get(fallbackId);
    if (!mode) {
      throw new Error(`[Resolver] fallback mode '${fallbackId}' not registered`);
    }
    return { mode, config: {}, source: 'fallback' };
  }
}
```

#### Coordinator：协调 Registry 和 Resolver

```typescript
class ResponseCoordinator {
  private registry: ResponseModeRegistry;
  private resolver: ResponseModeResolver;
  
  constructor() {
    this.registry = new ResponseModeRegistry();
    this.resolver = new ResponseModeResolver(this.registry);
    this.registerBuiltinModes();
  }
  
  resolveMode(chatType, peerKey, config, chatModeFallback): ResolvedMode {
    return this.resolver.resolve(chatType, peerKey, config);
  }
}
```

### 结果

✅ Registry 与 Resolver 分离成功：
- Registry 简单稳定（<100 行）
- Resolver 专注解析逻辑（<100 行）
- 单元测试清晰（Registry 测试注册，Resolver 测试解析）
- CLI 可直接查询 Registry 列出所有模式（`ec response list`）

---

## 总结

Phase 6 的 5 个核心架构决策：

| ADR | 决策 | 核心理由 | 结果 |
|-----|------|----------|------|
| 001 | Fork 策略 | 零破坏性、渐进验证、可回滚 | ✅ 迁移成功，3 天完成 |
| 002 | 决策对象 | 职责分离、可测试、可观察 | ✅ 代码简洁，测试易写 |
| 003 | 5 个钩子 | 覆盖所有需求，无冗余 | ✅ 所有迁移点接入 |
| 004 | Context 注入 | 无状态、依赖明确、测试友好 | ✅ 响应模式可复用 |
| 005 | Registry/Resolver 分离 | 单一职责、易扩展、易测试 | ✅ 解析逻辑清晰 |

这些决策共同构成了响应模式系统的坚实架构基础，为未来扩展（更多内置模式、社区插件）铺平了道路。

---

**下一步**：阅读 [migration-complete.md](./migration-complete.md) 了解完整的迁移路径回顾。
