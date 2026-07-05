# 响应模式插件体系架构设计（最终版）

**文档版本**: 2.0  
**创建时间**: 2026-07-04  
**设计者**: Claude Code (Opus 4.8)

---

## 一、核心概念

### 1.1 三层架构

```
用户配置层 (Agent Config)
    ↓ 选择响应模式
响应模式层 (Response Modes)
    ↓ 基于某个引擎实现
响应引擎层 (Response Engines)
```

### 1.2 核心理念

1. **用户视角**：Agent 针对某个对端，选择一个**响应模式**
2. **实现视角**：每个响应模式由某个**响应引擎**支撑
3. **引擎定位**：
   - 引擎可以**暴露接口**（允许基于此引擎实现多个响应模式）
   - 引擎可以**不暴露接口**（引擎本身就是一个完整的响应模式实现）

---

## 二、目录结构设计

```
src/response-system/
│
├── engines/                           # 响应引擎层
│   ├── v1/                           # V1 引擎（暴露接口）
│   │   ├── types.ts                 # V1 引擎接口定义
│   │   ├── engine.ts                # V1 引擎核心实现
│   │   ├── context.ts               # V1 上下文构建器
│   │   ├── coordinator.ts           # V1 协调器
│   │   ├── registry.ts              # V1 内部注册表
│   │   └── README.md                # V1 引擎文档
│   │
│   └── v2/                           # V2 引擎（不暴露接口，完整实现）
│       ├── engine.ts                # V2 引擎实现（完整的双会话逻辑）
│       ├── auxiliary-queue.ts
│       ├── auxiliary-session.ts
│       ├── main-queue.ts
│       ├── main-session.ts
│       ├── types.ts                 # V2 内部类型（不对外）
│       └── README.md                # V2 引擎文档
│
├── modes/                            # 响应模式层
│   ├── interactive/                 # 交互模式（基于 V1 引擎）
│   │   ── index.ts                # 实现 V1 引擎接口
│   │   └── config-schema.json      # 配置 Schema
│   │
│   ├── proactive/                   # 主动模式（基于 V1 引擎）
│   │   ├── index.ts                # 实现 V1 引擎接口
│   │   └── config-schema.json
│   │
│   ├── dual-session-lite/           # 双会话模式（直接使用 V2 引擎）
│   │   ├── index.ts                # 薄包装，直接导出 V2 引擎
│   │   └── config-schema.json
│   │
│   └── selective-response/          # 选择性响应（未来，基于 V1 或 V2）
│       ├── index.ts
│       └── config-schema.json
│
├── registry.ts                       # 响应模式注册表（统一注册）
├── selector.ts                       # 响应模式选择器
├── types.ts                          # 公共类型定义
└── index.ts                          # 公共 API 导出
```

---

## 三、架构详细设计

### 3.1 响应引擎层

#### V1 引擎（暴露接口）

**文件**：`src/response-system/engines/v1/types.ts`

```typescript
/**
 * V1 引擎接口
 * 基于原有的 ResponseMode 接口
 */
export interface V1ResponseMode {
  // 元数据
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly applicableScenes: ('private' | 'group')[];
  readonly configSchema?: JSONSchema;
  
  // 生命周期
  initialize(context: V1Context): Promise<void>;
  cleanup(): Promise<void>;
  
  // 核心能力
  handleInbound(message: InboundMessage): Promise<InboundDecision>;
  handleOutbound(payload: OutboundPayload): Promise<OutboundDecision>;
  getQueue(): MessageQueueInterface;
  
  // 处理流程钩子（可选）
  beforeProcess?(ctx: ProcessContext): void;
  configureRun?(ctx: ProcessContext): RunConfig | undefined;
  onToolUse?(ctx: ToolUseContext): void;
  onComplete?(ctx: CompleteContext): void;
  afterProcess?(ctx: AfterProcessContext): void;
}

/**
 * V1 引擎上下文
 */
export interface V1Context {
  session: Session;
  agentConfig: EffectiveAgentConfig;
  modeConfig: any;
  runner: AgentContext;
  channel: ChannelAdapter;
  logger: Logger;
  // ...
}
```

**文件**：`src/response-system/engines/v1/engine.ts`

```typescript
/**
 * V1 引擎实现
 * 包装现有的响应模式系统
 */
export class V1Engine {
  private registry = new Map<string, V1ResponseMode>();
  private currentMode?: V1ResponseMode;
  
  /**
   * 注册基于 V1 的响应模式
   */
  register(mode: V1ResponseMode): void {
    this.registry.set(mode.id, mode);
  }
  
  /**
   * 选择并初始化响应模式
   */
  async selectMode(modeId: string, context: V1Context): Promise<void> {
    const mode = this.registry.get(modeId);
    if (!mode) {
      throw new Error(`V1 mode not found: ${modeId}`);
    }
    
    await mode.initialize(context);
    this.currentMode = mode;
  }
  
  /**
   * 处理入站消息
   */
  async processInbound(message: InboundMessage): Promise<InboundDecision> {
    if (!this.currentMode) {
      throw new Error('No mode selected');
    }
    return await this.currentMode.handleInbound(message);
  }
  
  /**
   * 处理出站消息
   */
  async processOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    if (!this.currentMode) {
      throw new Error('No mode selected');
    }
    return await this.currentMode.handleOutbound(payload);
  }
}
```

---

#### V2 引擎（不暴露接口）

**文件**：`src/response-system/engines/v2/engine.ts`

```typescript
/**
 * V2 引擎实现
 * 完整的双会话逻辑，不暴露接口
 */
export class V2Engine {
  private auxiliaryQueue: AuxiliaryQueue;
  private auxiliarySession: AuxiliarySession;
  private mainQueue: MainQueue;
  private mainSession: MainSession;
  private config: DualSessionConfig;
  
  constructor(config: DualSessionConfig) {
    this.config = config;
  }
  
  async initialize(context: V2Context): Promise<void> {
    // 初始化双队列、双会话
    this.auxiliaryQueue = new AuxiliaryQueue(context, this.config);
    this.auxiliarySession = new AuxiliarySession(context, this.config);
    this.mainQueue = new MainQueue(context, this.config);
    this.mainSession = new MainSession(context, this.config);
    
    // 连接辅助队列 → 辅助会话 → 主队列
    this.auxiliaryQueue.onTrigger((batch) => {
      return this.auxiliarySession.process(batch);
    });
    
    this.auxiliarySession.onDecision((decision) => {
      if (decision.action === 'transfer') {
        return this.mainQueue.enqueue(decision.messages, decision.interrupt);
      }
    });
    
    // 连接主队列 → 主会话
    this.mainQueue.onReady((batch) => {
      return this.mainSession.process(batch);
    });
    
    // 连接主会话 → 辅助会话（反馈）
    this.mainSession.onFeedback((feedback) => {
      return this.auxiliarySession.processFeedback(feedback);
    });
  }
  
  async processInbound(message: InboundMessage): Promise<void> {
    // mention 快速通道
    if (this.config.mentionMode === 'fast-track' && message.isMentioned) {
      await this.mainQueue.interrupt([message]);
      return;
    }
    
    // 入队到辅助队列
    await this.auxiliaryQueue.enqueue(message);
  }
  
  async processOutbound(payload: OutboundPayload): Promise<void> {
    // proactive 模式：普通文本不发送
    if (payload.kind === 'activity.batch') {
      // 思考过程，不发送
      return;
    }
    
    // 实际回复通过 CLI 发送
    // （主会话在 turn 内已发送，这里无需处理）
  }
  
  async cleanup(): Promise<void> {
    await this.auxiliaryQueue.cleanup();
    await this.mainQueue.cleanup();
  }
}

interface V2Context {
  session: Session;
  agentConfig: EffectiveAgentConfig;
  runner: AgentContext;
  channel: ChannelAdapter;
  logger: Logger;
  dataDir: string;
}
```

**关键设计**：
- ✅ V2 引擎**不暴露接口**，内部实现完整的双会话逻辑
- ✅ `V2Engine` 是一个完整的、独立的实现
- ✅ 外部不需要理解 V2 的内部结构（AuxiliaryQueue、AuxiliarySession 等）

---

### 3.2 响应模式层

#### 基于 V1 的响应模式

**文件**：`src/response-system/modes/interactive/index.ts`

```typescript
import type { V1ResponseMode, V1Context, InboundDecision, OutboundDecision } from '../../engines/v1/types.js';

/**
 * 交互模式（基于 V1 引擎）
 */
export class InteractiveMode implements V1ResponseMode {
  readonly id = 'interactive';
  readonly displayName = '交互模式';
  readonly description = '每条消息立即回复';
  readonly applicableScenes = ['private', 'group'] as const;
  
  private context!: V1Context;
  
  async initialize(context: V1Context): Promise<void> {
    this.context = context;
  }
  
  async cleanup(): Promise<void> {}
  
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    return {
      action: 'process',
      queueBehavior: 'enqueue',
    };
  }
  
  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    return { method: 'direct', type: 'message' };
  }
  
  getQueue(): MessageQueueInterface {
    return new FIFOQueue();
  }
}
```

**文件**：`src/response-system/modes/proactive/index.ts`

```typescript
import type { V1ResponseMode } from '../../engines/v1/types.js';

/**
 * 主动模式（基于 V1 引擎）
 */
export class ProactiveMode implements V1ResponseMode {
  readonly id = 'proactive';
  readonly displayName = '主动模式';
  // ... 实现 V1ResponseMode 接口
  
  // 使用 V1 的钩子
  beforeProcess(ctx: ProcessContext): void { /* ... */ }
  configureRun(ctx: ProcessContext): RunConfig { /* ... */ }
  onToolUse(ctx: ToolUseContext): void { /* ... */ }
}
```

---

#### 基于 V2 的响应模式

**文件**：`src/response-system/modes/dual-session-lite/index.ts`

```typescript
import { V2Engine } from '../../engines/v2/engine.js';
import type { DualSessionConfig } from '../../engines/v2/types.js';

/**
 * 双会话模式（直接使用 V2 引擎）
 * 
 * 这是一个薄包装，直接导出 V2 引擎实例
 */
export class DualSessionLiteMode {
  readonly id = 'dual-session-lite';
  readonly displayName = '双会话响应模式';
  readonly description = '辅助会话判断时机，主会话处理内容';
  readonly applicableScenes = ['private', 'group'] as const;
  readonly engineType = 'v2' as const;  // 标记使用 V2 引擎
  
  private engine: V2Engine;
  
  constructor(config: DualSessionConfig) {
    this.engine = new V2Engine(config);
  }
  
  async initialize(context: any): Promise<void> {
    await this.engine.initialize(context);
  }
  
  async cleanup(): Promise<void> {
    await this.engine.cleanup();
  }
  
  /**
   * 处理入站消息（直接委托给 V2 引擎）
   */
  async processInbound(message: InboundMessage): Promise<void> {
    await this.engine.processInbound(message);
  }
  
  /**
   * 处理出站消息（直接委托给 V2 引擎）
   */
  async processOutbound(payload: OutboundPayload): Promise<void> {
    await this.engine.processOutbound(payload);
  }
}
```

**关键设计**：
- ✅ `DualSessionLiteMode` 是一个**薄包装**
- ✅ 内部直接使用 `V2Engine` 实例
- ✅ 不需要实现 V1 的接口（`handleInbound/handleOutbound`）
- ✅ 标记 `engineType = 'v2'`，供选择器识别

---

### 3.3 统一注册与选择

#### 响应模式注册表

**文件**：`src/response-system/registry.ts`

```typescript
/**
 * 响应模式注册表（统一）
 */
export class ResponseModeRegistry {
  private v1Modes = new Map<string, V1ResponseMode>();
  private v2Modes = new Map<string, any>();  // V2 模式（完整实现）
  
  /**
   * 注册基于 V1 引擎的响应模式
   */
  registerV1(mode: V1ResponseMode): void {
    this.v1Modes.set(mode.id, mode);
  }
  
  /**
   * 注册基于 V2 引擎的响应模式
   */
  registerV2(mode: any): void {
    if (mode.engineType !== 'v2') {
      throw new Error(`Mode ${mode.id} is not a V2 mode`);
    }
    this.v2Modes.set(mode.id, mode);
  }
  
  /**
   * 获取响应模式
   */
  get(id: string): any {
    return this.v1Modes.get(id) || this.v2Modes.get(id);
  }
  
  /**
   * 列出所有响应模式
   */
  list(scene?: 'private' | 'group'): any[] {
    const all = [
      ...Array.from(this.v1Modes.values()),
      ...Array.from(this.v2Modes.values()),
    ];
    
    if (!scene) return all;
    return all.filter(m => m.applicableScenes.includes(scene));
  }
}
```

---

#### 响应模式选择器

**文件**：`src/response-system/selector.ts`

```typescript
/**
 * 响应模式选择器
 */
export class ResponseModeSelector {
  constructor(private registry: ResponseModeRegistry) {}
  
  /**
   * 选择响应模式
   */
  async select(
    modeId: string,
    context: any,
  ): Promise<ResponseModeInstance> {
    const mode = this.registry.get(modeId);
    if (!mode) {
      throw new Error(`Response mode not found: ${modeId}`);
    }
    
    // 初始化模式
    await mode.initialize(context);
    
    // 返回统一的实例接口
    return {
      id: mode.id,
      engineType: (mode as any).engineType || 'v1',
      mode,
    };
  }
}

interface ResponseModeInstance {
  id: string;
  engineType: 'v1' | 'v2';
  mode: any;
}
```

---

### 3.4 集成到 response-engine.ts

**文件**：`src/core/message/response-engine.ts`

```typescript
import { ResponseModeRegistry } from '../../response-system/registry.js';
import { ResponseModeSelector } from '../../response-system/selector.js';

// 初始化响应系统
const registry = new ResponseModeRegistry();

// 注册 V1 模式
import { InteractiveMode } from '../../response-system/modes/interactive/index.js';
import { ProactiveMode } from '../../response-system/modes/proactive/index.js';
registry.registerV1(new InteractiveMode());
registry.registerV1(new ProactiveMode());

// 注册 V2 模式
import { DualSessionLiteMode } from '../../response-system/modes/dual-session-lite/index.js';
// DualSessionLiteMode 需要配置，暂时不在这里注册
// 在选择时根据配置动态创建

const selector = new ResponseModeSelector(registry);

// 在消息处理流程中
async function processMessage(message: Message) {
  // 解析配置
  const modeId = resolveResponseMode(agentConfig, message.chatType);
  const modeConfig = resolveModeConfig(agentConfig, modeId);
  
  // 选择响应模式
  let modeInstance: ResponseModeInstance;
  
  if (modeId === 'dual-session-lite') {
    // V2 模式：动态创建
    const mode = new DualSessionLiteMode(modeConfig);
    await mode.initialize(context);
    modeInstance = { id: modeId, engineType: 'v2', mode };
  } else {
    // V1 模式：从注册表选择
    modeInstance = await selector.select(modeId, context);
  }
  
  // 根据引擎类型处理
  if (modeInstance.engineType === 'v1') {
    // V1 处理流程
    const decision = await modeInstance.mode.handleInbound(message);
    await executeV1Decision(decision, message);
  } else if (modeInstance.engineType === 'v2') {
    // V2 处理流程
    await modeInstance.mode.processInbound(message);
    // V2 引擎内部异步处理，无需等待
  }
}
```

---

## 四、配置方式

### 4.1 使用 V1 模式（interactive/proactive）

```json
{
  "aid": "agent.aid.pub",
  "response_mode": "proactive"
}
```

### 4.2 使用 V2 模式（dual-session-lite）

```json
{
  "aid": "agent.aid.pub",
  "response_mode": "dual-session-lite",
  "response_mode_config": {
    "dual-session-lite": {
      "auxiliaryModel": "deepseek-v4-flash",
      "mainModel": "claude-opus",
      "mentionMode": "disabled",
      "debounceMs": 3000
    }
  }
}
```

---

## 五、架构总结

### 5.1 三层关系

```
用户层
  └── 选择响应模式：interactive / proactive / dual-session-lite

响应模式层
  ├── interactive（基于 V1 引擎）
  ├── proactive（基于 V1 引擎）
  └── dual-session-lite（基于 V2 引擎）

响应引擎层
  ├── V1 引擎（暴露接口，支持多个模式）
  └── V2 引擎（不暴露接口，完整实现）
```

### 5.2 关键设计原则

1. **用户只选择响应模式**：
   - 用户不需要知道"引擎"的概念
   - 配置：`"response_mode": "dual-session-lite"`

2. **响应模式决定引擎**：
   - `interactive/proactive` → 使用 V1 引擎
   - `dual-session-lite` → 使用 V2 引擎
   - 一个响应模式只对应一个引擎

3. **引擎是实现手段**：
   - V1 引擎：暴露接口，允许多个模式共享
   - V2 引擎：不暴露接口，独立完整实现
   - 未来 V3 引擎：可以选择暴露或不暴露接口

4. **目录结构清晰**：
   ```
   response-system/
   ├── engines/     # 引擎层（技术实现）
   └── modes/       # 模式层（用户可见）
   ```

---

## 六、实施路径

### Phase 1：搭建基础框架（2 天）
- [ ] 创建 `src/response-system/` 目录结构
- [ ] 实现 `registry.ts` 和 `selector.ts`
- [ ] 定义公共类型 `types.ts`

### Phase 2：迁移 V1 引擎（2 天）
- [ ] 创建 `engines/v1/` 目录
- [ ] 将现有 `response-modes/` 重构为 V1 引擎
- [ ] 迁移 `interactive` 和 `proactive` 模式

### Phase 3：实现 V2 引擎（2 周）
- [ ] 创建 `engines/v2/` 目录
- [ ] 实现双队列、双会话逻辑
- [ ] 创建 `modes/dual-session-lite/` 薄包装

### Phase 4：集成测试（1 周）
- [ ] V1 模式回归测试
- [ ] V2 模式功能测试
- [ ] 模式切换测试

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-04  
**状态**: ✅ 最终架构确定
