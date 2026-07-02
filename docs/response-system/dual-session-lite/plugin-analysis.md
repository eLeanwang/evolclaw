# 双会话模式作为响应模式插件的设计分析

## 文档说明

**版本**: 1.0  
**创建时间**: 2026-07-01  
**状态**: 设计分析

---

## 一、现有响应模式插件机制概览

### 1.1 核心接口

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
  
  // 队列管理
  getQueue(): MessageQueueInterface;
  
  // 可选钩子
  beforeProcess?(ctx: ProcessContext): Promise<void> | void;
  configureRun?(ctx: ProcessContext): RunConfig | undefined;
  onToolUse?(ctx: ToolUseContext): Promise<void> | void;
  onComplete?(ctx: CompleteContext): Promise<void> | void;
  afterProcess?(ctx: AfterProcessContext): Promise<void> | void;
}
```

### 1.2 关键概念

- **决策与执行分离**：响应模式只做决策（返回 Decision），执行层负责实际操作
- **队列在响应层**：每个响应模式可以有自己的队列实现
- **辅助会话工厂**：`context.createAuxiliarySession()` 提供辅助会话能力
- **处理流程钩子**：可选的生命周期钩子，支持细粒度控制

---

## 二、双会话模式与插件机制的匹配度分析

### 2.1 架构层面 ✅ 完全匹配

我们的双会话模式设计与响应模式插件机制的三层架构完全对齐：

```
我们的设计                    插件机制三层架构
─────────────                ─────────────────
[无]                    →    调度层（未实现，预留）
                              
辅助会话判断             →    响应层（ResponseMode）
主会话处理                    - handleInbound/handleOutbound
消息队列管理                  - getQueue()
                              
Channel/Runner          →    执行层（已有）
```

**结论**：双会话模式天然属于"响应层"，适合作为响应模式插件。

---

### 2.2 核心能力映射

| 双会话模式概念 | 响应模式接口 | 映射关系 |
|---------------|-------------|---------|
| 辅助队列触发逻辑 | handleInbound() | ✅ 完全匹配 |
| 辅助会话判断 | context.createAuxiliarySession() | ✅ 完全匹配 |
| 三种 action (hold/delay/transfer) | InboundDecision.action | ⚠️ 需调整（见下） |
| 打断机制 | InboundDecision.queueBehavior | ✅ 完全匹配 |
| 主会话发送控制 | handleOutbound() | ✅ 完全匹配 |
| 反馈机制 | 辅助会话内部逻辑 | ✅ 可实现 |

---

### 2.3 不匹配点与调整方案

#### ❌ 问题 1：action 类型不完全匹配

**我们的设计**：
```typescript
action: 'hold' | 'delay' | 'transfer'
```

**插件接口**：
```typescript
action: 'process' | 'drop' | 'defer'
```

**分析**：
- `hold` → `drop`（丢弃，不处理）✅ 匹配
- `delay` → `defer`（延迟处理）✅ 匹配
- `transfer` → `process`（立即处理）✅ 匹配

**调整方案**：
- 我们的文档中将 `hold/delay/transfer` 改为 `drop/defer/process`
- 或在实现时做映射：
  ```typescript
  const actionMap = {
    'hold': 'drop',
    'delay': 'defer',
    'transfer': 'process',
  };
  ```

---

#### ⚠️ 问题 2：辅助队列的位置

**我们的设计**：
- 辅助队列是独立的组件（AuxiliaryQueue）
- 辅助会话处理辅助队列中的消息

**插件机制**：
- 只有一个队列（MessageQueueInterface）
- 响应模式通过 `getQueue()` 返回队列实例

**冲突点**：
- 插件机制假设"一个响应模式 = 一个队列"
- 双会话模式需要"两个队列"（辅助队列 + 主队列）

**调整方案**：

**方案 A：辅助队列作为内部实现细节（推荐）**
```typescript
class DualSessionLiteMode implements ResponseMode {
  private auxiliaryQueue: AuxiliaryQueue;  // 内部队列
  private mainQueue: MessageQueueInterface; // 对外暴露的队列
  
  getQueue(): MessageQueueInterface {
    return this.mainQueue;  // 只暴露主队列
  }
  
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 1. 消息先进辅助队列（内部）
    this.auxiliaryQueue.enqueue(message);
    
    // 2. 检查触发条件，如果触发，调用辅助会话判断
    if (this.shouldTrigger()) {
      const decisions = await this.processAuxiliaryBatch();
      
      // 3. 根据辅助会话的判断返回决策
      for (const decision of decisions) {
        if (decision.action === 'transfer') {
          // 返回 process 决策，消息会进入主队列
          return {
            action: 'process',
            queueBehavior: decision.interrupt ? 'interrupt' : 'enqueue',
            reason: decision.reason,
          };
        }
      }
    }
    
    // 4. 如果不触发或判断为 hold/delay，返回 defer
    return {
      action: 'defer',
      reason: '消息在辅助队列中等待批次处理',
    };
  }
}
```

**优点**：
- ✅ 符合插件接口契约
- ✅ 辅助队列完全封装在模式内部
- ✅ 外部只看到一个队列（主队列）

**缺点**：
- ⚠️ `handleInbound` 的语义变复杂（不是"立即决策"，而是"可能延迟决策"）

---

**方案 B：辅助队列前置，主队列作为插件队列（备选）**
```typescript
// 在 Channel Adapter 层面，消息先进辅助队列
// 辅助会话判断后，只有需要处理的消息才到达 ResponseMode.handleInbound

class DualSessionLiteMode implements ResponseMode {
  private mainQueue: MessageQueueInterface;
  
  getQueue(): MessageQueueInterface {
    return this.mainQueue;
  }
  
  async handleInbound(message: InboundMessage): Promise<InboundDecision> {
    // 到这里的消息都是辅助会话判断后需要处理的
    // 直接返回 process
    return {
      action: 'process',
      queueBehavior: message.metadata?.interrupt ? 'interrupt' : 'enqueue',
      reason: '辅助会话判断需要处理',
    };
  }
}
```

**优点**：
- ✅ `handleInbound` 语义简单
- ✅ 辅助逻辑完全前置

**缺点**：
- ❌ 需要修改 Channel Adapter 或引入新的中间层
- ❌ 辅助队列逻辑不在响应模式内部，违反插件化原则

**推荐**：方案 A

---

#### ⚠️ 问题 3：延迟投递的随机数

**我们的设计**：
- 延迟基础值 3 秒 + 代码层随机 0-60 秒
- 随机数在代码层生成，防止多 agent 竞争

**插件机制**：
- `InboundDecision` 没有"延迟时间"字段
- `defer` 只是表示"暂时不处理"，具体何时再处理由响应模式内部决定

**调整方案**：
```typescript
async handleInbound(message: InboundMessage): Promise<InboundDecision> {
  // 如果辅助会话判断为 delay
  if (decision.action === 'delay') {
    // 在模式内部设置定时器
    const baseDelay = 3000;
    const randomDelay = Math.random() * 60000;
    const totalDelay = baseDelay + randomDelay;
    
    setTimeout(() => {
      // 延迟到期后，重新触发辅助会话判断
      this.triggerAuxiliaryBatch();
    }, totalDelay);
    
    // 返回 defer，消息暂时不进主队列
    return {
      action: 'defer',
      reason: `延迟 ${Math.round(totalDelay/1000)}s 后处理`,
    };
  }
}
```

---

#### ⚠️ 问题 4：反馈机制的实现

**我们的设计**：
- 主会话处理完 → 生成总结 → 追加到 jsonl → 通知辅助会话

**插件机制**：
- 没有明确的"反馈"钩子
- 但有 `afterProcess` 钩子（Runner 返回后）

**调整方案**：
```typescript
async afterProcess(ctx: AfterProcessContext): Promise<void> {
  // 1. 生成总结
  const summary = {
    processedMessageIds: [...],
    summary: '处理了...',
    replies: [...],
  };
  
  // 2. 追加到 jsonl
  await this.feedbackStore.append(summary);
  
  // 3. 通知辅助会话（更新上下文）
  await this.auxiliarySession.send(
    `[主会话反馈] ${summary.summary}`,
    'message'
  );
}
```

---

## 三、需要厘定的设计要点

### 3.1 插件元数据

```typescript
class DualSessionLiteMode implements ResponseMode {
  readonly id = 'dual-session-lite';
  readonly displayName = '双会话响应模式（简化版）';
  readonly description = '通过辅助会话判断消息相关性，优化群聊响应效率';
  readonly type = 'builtin';  // 或 'extension'
  readonly applicableScenes = ['group', 'private'];  // 主要用于群聊，但也支持私聊
  
  readonly configSchema: JSONSchema = {
    type: 'object',
    properties: {
      auxiliaryModel: {
        type: 'string',
        description: '辅助会话使用的模型',
        default: 'deepseek-v4-flash',
      },
      debounceMs: {
        type: 'number',
        description: '防抖时间（毫秒）',
        default: 3000,
      },
      maxWaitMs: {
        type: 'number',
        description: '最早消息最长等待时间（毫秒）',
        default: 15000,
      },
      // ... 其他配置
    },
  };
}
```

**问题**：
- `type` 应该是 `builtin` 还是 `extension`？

**建议**：
- Phase 1：`builtin`（内置，与 EvolClaw 一起发布）
- Phase 2：可以提供 `extension` 版本（独立 npm 包）

---

### 3.2 初始化与清理

```typescript
async initialize(context: ResponseModeContext): Promise<void> {
  this.context = context;
  
  // 1. 创建辅助会话
  this.auxiliarySession = await context.createAuxiliarySession({
    model: context.modeConfig.auxiliaryModel || 'deepseek-v4-flash',
    purpose: 'dual-session-lite-judge',
    contextMode: 'minimal',
  });
  
  // 2. 初始化辅助队列
  this.auxiliaryQueue = new AuxiliaryQueue({
    debounceMs: context.modeConfig.debounceMs || 3000,
    maxWaitMs: context.modeConfig.maxWaitMs || 15000,
    maxSize: context.modeConfig.maxQueueSize || 50,
  });
  
  // 3. 初始化主队列（使用默认 FIFO 队列）
  this.mainQueue = context.session.queue;
  
  // 4. 初始化反馈存储
  this.feedbackStore = new FeedbackStore(
    path.join(context.dataDir, 'main-feedback.jsonl')
  );
  
  context.logger.info('[DualSessionLite] Initialized', {
    auxiliaryModel: this.auxiliarySession.model,
    config: context.modeConfig,
  });
}

async cleanup(): Promise<void> {
  // 1. 关闭辅助会话
  if (this.auxiliarySession) {
    await this.auxiliarySession.close();
  }
  
  // 2. 清理辅助队列（取消定时器）
  if (this.auxiliaryQueue) {
    this.auxiliaryQueue.clear();
  }
  
  this.context.logger.info('[DualSessionLite] Cleaned up');
}
```

---

### 3.3 handleInbound 的实现逻辑

**关键问题**：如何在 `handleInbound` 中实现"批次触发 + 辅助会话判断"？

**核心矛盾**：
- `handleInbound` 是**同步调用**（每条消息到达时调用一次）
- 辅助会话判断是**批次处理**（累积多条消息后一次性判断）

**解决方案**：

```typescript
async handleInbound(message: InboundMessage): Promise<InboundDecision> {
  // 1. 消息先进辅助队列
  this.auxiliaryQueue.enqueue(message);
  
  // 2. 检查是否需要触发批次处理
  const shouldTrigger = this.auxiliaryQueue.shouldTrigger();
  
  if (shouldTrigger) {
    // 3. 触发辅助会话批次处理（异步）
    this.processAuxiliaryBatch().catch(err => {
      this.context.logger.error('[DualSessionLite] Auxiliary batch failed', err);
    });
  }
  
  // 4. 立即返回 defer（消息在辅助队列中等待）
  return {
    action: 'defer',
    reason: '消息在辅助队列中等待批次处理',
  };
}

private async processAuxiliaryBatch(): Promise<void> {
  // 1. 提取批次
  const batch = this.auxiliaryQueue.extractBatch(50, 10240);
  
  // 2. 调用辅助会话判断
  const input = this.buildAuxiliaryInput(batch);
  const output = await this.auxiliarySession.judge(JSON.stringify(input));
  const decisions = JSON.parse(output);
  
  // 3. 根据判断结果操作主队列
  for (const decision of decisions) {
    if (decision.action === 'transfer') {
      // 将消息从辅助队列移到主队列
      const message = this.auxiliaryQueue.get(decision.messageId);
      
      if (decision.interrupt) {
        // 打断：清空主队列，插入消息
        await this.mainQueue.clear();
        await this.mainQueue.enqueue(message, 999);  // 高优先级
      } else {
        // 正常入队
        await this.mainQueue.enqueue(message);
      }
      
      // 标记为已投递
      this.auxiliaryQueue.markTransferred(decision.messageId);
      
      // 触发主会话处理（通过调用 session.processNext）
      this.context.session.processNext();
    } else if (decision.action === 'delay') {
      // 设置延迟定时器
      const delay = 3000 + Math.random() * 60000;
      setTimeout(() => {
        this.processAuxiliaryBatch();
      }, delay);
    } else if (decision.action === 'hold') {
      // 标记为已丢弃
      this.auxiliaryQueue.markDropped(decision.messageId);
    }
  }
}
```

**问题**：
- ❌ `handleInbound` 总是返回 `defer`，外部看不到真正的决策
- ❌ 辅助会话判断后，需要主动操作主队列和触发处理

**这是否违反插件机制的设计？**

查看现有实现（`src/response-modes/core/proactive.ts`），发现：
- Proactive 模式也是在 `handleInbound` 中返回 `process`，但具体行为由 `beforeProcess` 等钩子控制
- 没有"消息先进入内部队列，批次处理后再决策"的模式

**结论**：双会话模式的"批次判断"逻辑与现有插件机制有一定不匹配。

---

### 3.4 可能的架构调整

**方案 1：辅助队列作为前置过滤器（在 ResponseMode 外部）**

```
Channel Adapter → AuxiliaryQueue → AuxiliarySession → ResponseMode.handleInbound
```

- 辅助队列和辅助会话作为"前置组件"
- ResponseMode 只处理"已判断需要处理"的消息

**优点**：
- ✅ 符合插件接口语义
- ✅ 辅助逻辑可复用（其他模式也可使用）

**缺点**：
- ❌ 需要修改核心架构（引入新的前置层）
- ❌ 辅助逻辑不在响应模式内部，难以配置和扩展

---

**方案 2：双会话模式作为"复合模式"（在 ResponseMode 内部实现所有逻辑）**

```
ResponseMode.handleInbound → 总是返回 defer
ResponseMode 内部 → 辅助队列 + 辅助会话 + 批次处理 + 主队列操作
```

- `handleInbound` 只负责"入口接收"
- 真正的决策和处理在内部异步进行

**优点**：
- ✅ 无需修改核心架构
- ✅ 所有逻辑封装在应模式内部

**缺点**：
- ❌ `handleInbound` 的语义变复杂
- ❌ 可能绕过某些框架机制（如入站决策的统一日志）

---

**方案 3：引入新的插件接口（为批次模式设计）**

```typescript
interface BatchResponseMode extends ResponseMode {
  // 批次触发条件
  shouldTriggerBatch(queue: InboundMessage[]): boolean;
  
  // 批次处理
  handleBatch(batch: InboundMessage[]): Promise<BatchDecision[]>;
}

interface BatchDecision {
  messageId: string;
  action: 'process' | 'drop' | 'defer';
  queueBehavior?: 'enqueue' | 'priority' | 'interrupt';
}
```

**优点**：
- ✅ 明确支持批次模式
- ✅ 语义清晰

**缺点**：
- ❌ 需要扩展核心接口
- ❌ 增加复杂度

---

## 四、最终建议

### 4.1 实施策略

**Phase 1：内部实现版（方案 2）**
- 使用现有 `ResponseMode` 接口
- 辅助队列、辅助会话、批次处理都在模式内部
- `handleInbound` 返回 `defer`，内部异步处理
- `type: 'builtin'`

**优点**：
- 快速实施，无需修改核心
- 验证双会话模式的效果

**缺点**：
- 绕过部分框架机制
- 可能有一些"不优雅"的实现

---

**Phase 2：优化版（根据 Phase 1 效果决定）**

**如果效果好**：
- 提炼出"批次处理"的通用模式
- 扩展插件接口（如方案 3）
- 或引入前置过滤层（如方案 1）

**如果效果一般**：
- 保持 Phase 1 的实现
- 或简化为"快速过滤器"（非批次）

---

### 4.2 需要明确的设计决策

| 问题 | 建议 | 理由 |
|------|------|------|
| 插件类型（builtin / extension） | Phase 1: builtin | 与核心一起发布，便于集成测试 |
| 辅助队列位置（内部 / 外部） | 内部 | 封装在响应模式内，符合插件化原则 |
| handleInbound 语义（立即决策 / 延迟决策） | 延迟决策（返回 defer） | 批次模式的特点，需要累积后判断 |
| 是否扩展核心接口 | Phase 1 不扩展 | 先验证效果，再决定是否值得扩展 |
| 反馈机制钩子 | 使用 afterProcess | 符合现有钩子设计 |
| 主会话发送方式 | handleOutbound + CLI | 与现有 proactive 模式对齐 |

---

### 4.3 需要补充的文档

基于插件机制，我们需要补充以下文档：

1. **plugin-implementation.md** — 双会话模式的插件实现细节
   - 如何实现 `ResponseMode` 接口
   - 辅助队列的内部实现
   - 批次触发逻辑
   - 主队列操作机制

2. **plugin-config.md** — 配置说明
   - configSchema 完整定义
   - 配置层级（全局 / Agent / 关系）
   - 配置示例

3. **plugin-testing.md** — 测试指南
   - 单元测试（辅助会话判断逻辑）
   - 集成测试（完整消息流程）
   - 性能测试（批次处理延迟）

4. **migration-from-v2.md** — 从完整版迁移到插件版
   - 架构变化对比
   - 配置迁移
   - API 变化

---

## 五、风险与缓解

### 风险 1：handleInbound 语义不清

**风险**：`handleInbound` 总是返回 `defer`，外部看不到真正的决策过程。

**缓解**：
- 在日志中详细记录批次处理过程
- 提供调试命令查看辅助队列状态
- 文档中明确说明这种设计

---

### 风险 2：绕过框架机制

**风险**：内部直接操作主队列，可能绕过某些框架层的日志、监控、权限检查。

**缓解**：
- 使用 `context.logger` 记录所有关键操作
- 通过 `context.session.processNext()` 触发处理（而非直接调用）
- Phase 2 考虑引入框架级支持

---

### 风险 3：性能问题

**风险**：辅助会话判断增加延迟（3-15秒防抖 + 辅助会话调用时间）。

**缓解**：
- 监控关键指标（批次触发频率、辅助会话延迟、过滤率）
- 提供配置调优（debounceMs / maxWaitMs 可配置）
- 必要时增加"紧急消息快速通道"

---

## 六、总结

### 匹配度评估：⭐⭐⭐⭐☆ (4/5)

**匹配的部分**：
- ✅ 架构层面完全对齐（响应层）
- ✅ 辅助会话工厂可直接使用
- ✅ 生命周期钩子满足需求
- ✅ 队列接口可复用

**不匹配的部分**：
- ⚠️ 批次处理逻辑与"逐条决策"的接口语义有差异
- ⚠️ 需要在 `handleInbound` 中返回 `defer`，真正决策在内部异步进行

### 最终建议：✅ 可以作为响应模式插件实现

**实施路径**：
1. Phase 1：使用现有接口，内部实现批次逻辑（builtin）
2. 验证效果，收集反馈
3. Phase 2：根据效果决定是否扩展核心接口

**需要补充的文档**：
- plugin-implementation.md（实现细节）
- plugin-config.md（配置说明）
- plugin-testing.md（测试指南）

**需要调整的现有文档**：
- README.md → 增加"作为响应模式插件"的说明
- architecture.md → 更新为"实现 ResponseMode 接口"
- eck-integration.md → 改为"配置响应模式"

---

**分析完成时间**: 2026-07-01  
**分析者**: Claude Code (Opus 4.8)
