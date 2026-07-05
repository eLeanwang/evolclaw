# 双会话响应模式 - 实施计划

**文档版本**: 1.0  
**创建时间**: 2026-07-04  
**预计工作量**: 2-3 周开发 + 1 周测试  
**状态**: 待实施

---

## 一、现有架构分析

### 1.1 核心组件现状

基于代码审查，evolclaw 已具备以下基础设施：

| 组件 | 文件路径 | 现状 | 复用程度 |
|------|---------|------|---------|
| **响应模式系统** | `src/response-modes/` | ✅ 已实现插件化架构 | **高** - 直接扩展 |
| **消息队列** | `src/core/message/message-queue.ts` | ✅ 已实现持久化队列 | **中** - 需扩展双队列 |
| **会话管理** | `src/core/session/session-manager.ts` | ✅ 已实现会话管理 | **高** - 直接复用 |
| **响应引擎** | `src/core/message/response-engine.ts` | ✅ 已实现处理流程 | **中** - 需适配双会话 |
| **AUN 适配器** | `src/channels/aun.ts` | ✅ 已实现 mention 过滤 | **低** - 需修改过滤逻辑 |
| **ECK 集成** | `src/eck/kit-renderer.ts` | ✅ 已实现上下文渲染 | **高** - 直接复用 |

### 1.2 响应模式系统架构

```typescript
// src/response-modes/types.ts
interface ResponseMode {
  id: string;
  initialize(context: ResponseModeContext): Promise<void>;
  handleInbound(message: InboundMessage): Promise<InboundDecision>;
  handleOutbound(payload: OutboundPayload): Promise<OutboundDecision>;
}
```

**关键发现**：
- ✅ 已有完整的响应模式插件化系统
- ✅ 已有 `interactive` 和 `proactive` 两个内置模式
- ✅ 已有 `ResponseModeCoordinator` 统一协调
- ✅ 支持配置驱动的模式选择

### 1.3 消息队列架构

```typescript
// src/core/message/message-queue.ts
class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private activeStates = new Map<string, ActiveQueueState>();
  // ... 已实现持久化、打断、优先级等机制
}
```

**关键发现**：
- ✅ 已有单队列实现，支持持久化
- ✅ 已有打断机制 (`interruptCallback`)
- ✅ 已有逻辑队列桥接 (`LogicalQueueBridge`)
- ⚠️ 需要扩展为双队列架构

---

## 二、实施策略

### 2.1 总体策略

**基于现有架构扩展，而非重写**：

1. **响应模式层**：新增 `dual-session-lite` 响应模式
2. **队列层**：扩展 `MessageQueue`，支持辅助队列 + 主队列
3. **会话层**：复用现有 `SessionManager`，区分辅助/主会话
4. **适配器层**：修改 `aun.ts` 的 mention 过滤逻辑

### 2.2 实施阶段

| 阶段 | 工作内容 | 工作量 | 依赖 |
|------|---------|--------|------|
| **Phase 1** | 数据结构定义 | 1 天 | 无 |
| **Phase 2** | 双队列实现 | 2-3 天 | Phase 1 |
| **Phase 3** | 响应模式实现 | 3-4 天 | Phase 1, 2 |
| **Phase 4** | ECK 集成 | 1-2 天 | Phase 3 |
| **Phase 5** | 适配器修改 | 1 天 | Phase 2 |
| **Phase 6** | 测试与调优 | 5-7 天 | Phase 1-5 |

---

## 三、详细实施步骤

### Phase 1：数据结构定义（1 天）

#### 步骤 1.1：创建类型定义文件

**新建文件**：`src/response-modes/dual-session/types.ts`

```typescript
/**
 * 双会话响应模式 - 类型定义
 */

// 消息状态
export enum MessageState {
  PENDING = 'pending',      // 未被辅助会话处理
  HOLD = 'hold',            // 已处理，暂时挂起
  DELAY = 'delay',          // 已处理，延迟投递
}

// 队列中的消息
export interface QueuedMessage {
  message: InboundMessage;
  state: MessageState;
  enqueuedAt: number;
  processedByAuxiliary: boolean;
  
  // DELAY 状态
  transferAt?: number;
  delayLevel?: 'short' | 'medium' | 'long';
  
  // HOLD 状态
  holdSince?: number;
  
  // 错误处理
  hasError?: boolean;
  lastErrorTime?: number;
  errorCount?: number;
}

// 辅助会话决策
export interface AuxiliaryDecision {
  action: 'hold' | 'delay' | 'transfer';
  delayLevel?: 'short' | 'medium' | 'long';
  interrupt?: boolean;
  interruptReason?: string;
  previousMessageStrategy?: 'ignore' | 'defer' | 'continue';
  reason: string;
}

// 主会话反馈
export interface MainFeedback {
  summary: string;
  replies: string[];
}

// 双会话配置
export interface DualSessionConfig {
  auxiliaryModel: string;
  mainModel: string;
  mentionMode: 'disabled' | 'fast-track';
  debounceMs: number;
  maxWaitMs: number;
  maxQueueSize: number;
  maxBatchSize: number;
  maxBatchBytes: number;
  // ... 其他配置
}
```

**验收标准**：
- [ ] 类型定义完整，覆盖所有设计文档中的数据结构
- [ ] 通过 TypeScript 编译
- [ ] 与 `response-modes/types.ts` 无冲突

---

### Phase 2：双队列实现（2-3 天）

#### 步骤 2.1：扩展消息队列

**修改文件**：`src/core/message/message-queue.ts`

**新增方法**：
```typescript
class MessageQueue {
  // 现有代码保持不变
  
  // 新增：双队列支持
  private auxiliaryQueues = new Map<string, QueuedMessage[]>();
  private mainQueues = new Map<string, QueuedMessage[]>();
  
  /** 入队到辅助队列 */
  enqueueAuxiliary(queueKey: string, message: Message): void {
    // 实现辅助队列入队逻辑
  }
  
  /** 从辅助队列提取批次 */
  extractAuxiliaryBatch(queueKey: string, maxSize: number, maxBytes: number): QueuedMessage[] {
    // 实现批次提取逻辑
  }
  
  /** 投递到主队列 */
  transferToMain(queueKey: string, messages: Message[], interrupt: boolean): void {
    // 实现投递逻辑
  }
  
  /** 持久化双队列 */
  private persistDualQueues(queueKey: string): void {
    // 实现持久化逻辑
  }
}
```

**实施细节**：
1. 保持现有单队列逻辑不变（向后兼容）
2. 新增 `auxiliaryQueues` 和 `mainQueues` 两个 Map
3. 双队列持久化路径：`$AGENT_DIR/relations/<peerKey>/_threads/<threadId>/_queues/`
4. 实现懒加载机制

**验收标准**：
- [ ] 双队列入队、出队、持久化功能正常
- [ ] 现有单队列功能不受影响
- [ ] 单元测试通过

---

#### 步骤 2.2：实现辅助队列管理器

**新建文件**：`src/response-modes/dual-session/auxiliary-queue.ts`

```typescript
export class AuxiliaryQueue {
  private config: DualSessionConfig;
  private messageQueue: MessageQueue;
  private debounceTimer: NodeJS.Timeout | null = null;
  private delayTimers = new Map<string, NodeJS.Timeout>();
  
  constructor(
    private queueKey: string,
    config: DualSessionConfig,
    messageQueue: MessageQueue,
    private chatType: 'private' | 'group'
  ) {
    this.config = config;
    // 单聊场景下队列容量限制为 15 条
    if (chatType === 'private') {
      this.config = { ...config, maxQueueSize: 15 };
    }
  }
  
  /** 消息入队 */
  enqueue(message: InboundMessage): void {
    // 1. 入队到 MessageQueue
    // 2. 重置防抖定时器
    // 3. 检查强制触发条件
  }
  
  /** 获取未处理的消息 */
  getUnprocessedMessages(): InboundMessage[] {
    // 过滤 processedByAuxiliary = false 的消息
  }
  
  /** 触发辅助会话处理 */
  private triggerAuxiliary(reason: TriggerReason): void {
    // 调用辅助会话处理
  }
}
```

**验收标准**：
- [ ] 防抖机制正常工作
- [ ] 强制触发条件正确（队列满、最早消息 15 秒、延迟超时）
- [ ] 单聊/群聊差异化正确

---

### Phase 3：响应模式实现（3-4 天）

#### 步骤 3.1：创建双会话响应模式

**新建文件**：`src/response-modes/dual-session/index.ts`

```typescript
import type { ResponseMode, InboundDecision, OutboundDecision, ResponseModeContext } from '../types.js';
import type { InboundMessage, OutboundPayload } from '../types.js';

export class DualSessionLiteMode implements ResponseMode {
  readonly id = 'dual-session-lite';
  
  private auxiliaryQueue!: AuxiliaryQueue;
  private auxiliarySession!: AuxiliarySession;
  private mainSession!: MainSession;
  
  async initialize(context: ResponseModeContext): Promise<void> {
    // 初始化辅助队列、辅助会话、主会话
  }
  
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // mention 快速通道检查
    if (this.config.mentionMode === 'fast-track' && message.isMentioned) {
      return {
        action: 'process',
        queueBehavior: 'interrupt',
        instructions: { interruptCurrent: true },
      };
    }
    
    // 入队到辅助队列
    this.auxiliaryQueue.enqueue(message);
    
    return {
      action: 'drop',  // 不立即处理，等辅助会话决策
    };
  }
  
  async handleOutbound(payload: OutboundPayload): Promise<OutboundDecision> {
    // proactive 模式：普通文本输出不发送
    // 实际回复通过 CLI 发送
    return { method: 'direct', type: 'message' };
  }
}
```

**验收标准**：
- [ ] 响应模式正确实现 `ResponseMode` 接口
- [ ] mention 快速通道正常工作
- [ ] 消息正确入队到辅助队列

---

#### 步骤 3.2：实现辅助会话

**新建文件**：`src/response-modes/dual-session/auxiliary-session.ts`

```typescript
export class AuxiliarySession {
  private conversationId: string;
  private model: string;
  private sessionManager: SessionManager;
  private errorState: AuxiliaryErrorState = {
    isInError: false,
    consecutiveFailures: 0,
  };
  
  constructor(
    private config: DualSessionConfig,
    private agentConfig: EffectiveAgentConfig,
    sessionManager: SessionManager
  ) {
    this.model = config.auxiliaryModel;
    this.sessionManager = sessionManager;
  }
  
  /** 处理消息批次 */
  async process(batch: InboundMessage[], reason: TriggerReason): Promise<void> {
    try {
      // 1. 构建输入
      const input = this.buildInput(batch, reason);
      
      // 2. 调用辅助会话模型
      const output = await this.callModel(input);
      
      // 3. 解析输出
      const decision = this.parseDecision(output);
      
      // 4. 执行决策
      await this.executeDecision(decision);
      
      // 5. 清除错误状态
      this.errorState.isInError = false;
      this.errorState.consecutiveFailures = 0;
      
    } catch (error) {
      await this.handleError(error, batch);
    }
  }
  
  /** 处理主会话反馈 */
  async processFeedback(feedback: MainFeedback): Promise<void> {
    // 插入到辅助队列（被动触发）
    // 不主动调用 LLM
  }
  
  /** 错误处理和降级 */
  private async handleError(error: unknown, batch: InboundMessage[]): Promise<void> {
    // 第一次失败：重试 3 次
    // 重试失败：标记错误状态，延迟 2 分钟投递
    // 后续失败：直接延迟投递（不重试）
  }
}
```

**验收标准**：
- [ ] 辅助会话正确调用模型
- [ ] 决策解析正确（hold/delay/transfer）
- [ ] 错误处理和降级机制正常

---

#### 步骤 3.3：实现主会话

**新建文件**：`src/response-modes/dual-session/main-session.ts`

```typescript
export class MainSession {
  private conversationId: string;
  private model: string;
  private sessionManager: SessionManager;
  private status: 'idle' | 'processing' = 'idle';
  private currentBatch: InboundMessage[] = [];
  
  constructor(
    private config: DualSessionConfig,
    private agentConfig: EffectiveAgentConfig,
    sessionManager: SessionManager
  ) {
    this.model = config.mainModel;
    this.sessionManager = sessionManager;
  }
  
  /** 处理批次 */
  async process(batch: InboundMessage[]): Promise<void> {
    this.status = 'processing';
    this.currentBatch = batch;
    
    try {
      // 1. 调用主会话模型（主会话在 turn 内通过 CLI 发送回复）
      const response = await this.callModel(batch);
      
      // 2. 提取自然语言总结
      const summary = this.extractSummary(response);
      
      // 3. 从工具调用历史中提取回复内容
      const replies = this.extractRepliesFromToolCalls();
      
      // 4. 组装反馈
      const feedback: MainFeedback = { summary, replies };
      
      // 5. 通知辅助会话
      await auxiliarySession.processFeedback(feedback);
      
      // 6. 标记完成
      mainQueue.completeBatch();
      this.status = 'idle';
      this.currentBatch = [];
      
    } catch (error) {
      await this.handleError(error, batch);
    }
  }
  
  /** 打断 */
  async interrupt(): Promise<void> {
    // 调用 SDK 的 interrupt()
    this.status = 'idle';
  }
}
```

**验收标准**：
- [ ] 主会话正确调用模型
- [ ] 回复通过 CLI 发送
- [ ] MainFeedback 正确传递给辅助会话
- [ ] 打断机制正常

---

### Phase 4：ECK 集成（1-2 天）

#### 步骤 4.1：更新 Manifest

**修改文件**：`kits/templates/manifest.yaml`（或对应文件）

```yaml
sections:
  # ... 现有 sections
  
  # 双会话响应模式 - 辅助会话
  - id: dual-session-lite-auxiliary
    when: "responseMode === 'dual-session-lite' && sessionType === 'auxiliary'"
    source:
      type: file
      path: "$KITS/docs/response-system/dual-session-lite/prompts/auxiliary-base.md"
    priority: 100
    order: 50
  
  # 双会话响应模式 - 主会话
  - id: dual-session-lite-main
    when: "responseMode === 'dual-session-lite' && sessionType === 'main'"
    source:
      type: file
      path: "$KITS/docs/response-system/dual-session-lite/prompts/main-base.md"
    priority: 100
    order: 50
```

**验收标准**：
- [ ] Manifest 正确加载
- [ ] `when` 条件正确求值
- [ ] 辅助/主会话提示词正确渲染

---

#### 步骤 4.2：扩展 ECK Vars

**修改文件**：`src/eck/kit-renderer.ts`

```typescript
function buildECKVars(session: Session, sessionType?: 'auxiliary' | 'main'): ECKVars {
  return {
    // 现有参数
    chatMode: session.chatMode,
    channel: session.channel,
    // ...
    
    // 新增参数
    responseMode: config.responseMode || null,
    sessionType: sessionType || null,
  };
}
```

**验收标准**：
- [ ] `responseMode` 和 `sessionType` 正确注入
- [ ] 不影响现有 ECK 渲染逻辑

---

### Phase 5：适配器修改（1 天）

#### 步骤 5.1：修改 AUN 适配器

**修改文件**：`src/channels/aun.ts:1606-1616`

**删除旧逻辑**：
```typescript
// 删除这段代码
const enforceMention = dispatchMode === 'mention' || isCommandMsg;
const isMentioned = mentionedSelf || mentionedAll;

if (enforceMention && !isMentioned) {
  this.acknowledgeImmediately(messageId, seq);
  logger.info(`Group dropped: unmentioned`);
  return;
}
```

**新增逻辑**：
```typescript
// 标记 isMentioned（所有消息都保留此标记）
const isMentioned = mentionedSelf || mentionedAll;

// mention 快速通道由响应模式处理
// 此处不再过滤，所有群消息都向下传递
```

**验收标准**：
- [ ] 所有群消息都传递到响应模式
- [ ] `isMentioned` 标记正确设置
- [ ] 现有单会话模式不受影响

---

### Phase 6：测试与调优（5-7 天）

#### 步骤 6.1：单元测试

**新建文件**：`src/response-modes/dual-session/__tests__/`

测试用例：
- [ ] 辅助队列入队、出队、持久化
- [ ] 辅助会话决策解析
- [ ] 主会话批次处理
- [ ] 错误处理和降级
- [ ] mention 快速通道

#### 步骤 6.2：集成测试

测试场景：
- [ ] 单聊场景：防抖、延迟、主会话空闲触发
- [ ] 群聊场景：hold/delay/transfer、多 agent 竞争
- [ ] mention 快速通道：被 @ 直接投递并打断
- [ ] 错误场景：辅助会话失败降级、主会话失败重试
- [ ] 打断场景：紧急消息打断、打断策略

#### 步骤 6.3：性能测试

测试指标：
- [ ] 辅助会话响应延迟 < 2 秒
- [ ] mention 快速通道响应延迟 < 1 秒
- [ ] 队列持久化不影响性能
- [ ] 内存占用在合理范围内

---

## 四、关键风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| 双队列持久化与现有队列冲突 | 高 | 中 | 隔离双队列持久化路径，保持向后兼容 |
| 响应模式系统扩展性不足 | 中 | 低 | 已验证现有架构支持扩展 |
| ECK 集成复杂度超预期 | 中 | 低 | 复用现有 Manifest 机制 |
| mention 过滤逻辑影响现有功能 | 高 | 中 | 保持现有单会话模式不变 |
| 辅助会话模型调用成本 | 中 | 高 | 使用便宜模型（deepseek-v4-flash） |

---

## 五、实施检查清单

### Phase 1：数据结构定义
- [ ] `src/response-modes/dual-session/types.ts` 创建完成
- [ ] 类型定义通过 TypeScript 编译
- [ ] 与现有类型无冲突

### Phase 2：双队列实现
- [ ] `MessageQueue` 扩展双队列支持
- [ ] `AuxiliaryQueue` 实现完成
- [ ] 双队列持久化机制实现
- [ ] 单元测试通过

### Phase 3：响应模式实现
- [ ] `DualSessionLiteMode` 实现完成
- [ ] `AuxiliarySession` 实现完成
- [ ] `MainSession` 实现完成
- [ ] 错误处理和降级机制实现
- [ ] 单元测试通过

### Phase 4：ECK 集成
- [ ] Manifest 更新完成
- [ ] ECK Vars 扩展完成
- [ ] 提示词正确渲染

### Phase 5：适配器修改
- [ ] AUN 适配器 mention 过滤逻辑修改
- [ ] 现有功能不受影响
- [ ] 单元测试通过

### Phase 6：测试与调优
- [ ] 单元测试全部通过
- [ ] 集成测试全部通过
- [ ] 性能测试达标
- [ ] 文档更新完成

---

## 六、交付物清单

### 代码文件

**新增文件**：
- `src/response-modes/dual-session/types.ts`
- `src/response-modes/dual-session/index.ts`
- `src/response-modes/dual-session/auxiliary-queue.ts`
- `src/response-modes/dual-session/auxiliary-session.ts`
- `src/response-modes/dual-session/main-session.ts`
- `src/response-modes/dual-session/__tests__/` （测试文件）

**修改文件**：
- `src/core/message/message-queue.ts` （扩展双队列）
- `src/channels/aun.ts` （修改 mention 过滤）
- `src/eck/kit-renderer.ts` （扩展 ECK Vars）
- `kits/templates/manifest.yaml` （更新 Manifest）

### 文档文件

**已完成**：
- `docs/response-system/dual-session-lite/README.md`
- `docs/response-system/dual-session-lite/architecture.md`
- `docs/response-system/dual-session-lite/data-structures.md`
- `docs/response-system/dual-session-lite/message-flow.md`
- `docs/response-system/dual-session-lite/eck-integration.md`
- `docs/response-system/dual-session-lite/prompts/auxiliary-base.md`
- `docs/response-system/dual-session-lite/prompts/main-base.md`
- `docs/response-system/dual-session-lite/ISSUES-SUMMARY.md`
- `docs/response-system/dual-session-lite/REVIEW-SUPPLEMENT.md`
- `docs/response-system/dual-session-lite/REVISION-SUMMARY.md`

**待补充**：
- `docs/response-system/dual-session-lite/TESTING-GUIDE.md` （测试指南）
- `docs/response-system/dual-session-lite/DEPLOYMENT-GUIDE.md` （部署指南）

---

## 七、后续工作（Phase 2）

**优化建议**（实施后 1-2 个月）：
1. 监控指标与可视化
2. 压缩机制增强（专门的总结会话）
3. 延迟等级调优（根据实际使用情况）
4. 环境层与关系层边界厘定

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-04  
**状态**: ✅ 可实施
