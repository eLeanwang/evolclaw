# EvolClaw 响应模式系统架构梳理

## 文档信息

| 项目 | 内容 |
|------|------|
| 类型 | 架构梳理 + 现状分析 |
| 创建日期 | 2026-06-24 |
| 作者 | Claude Code |
| 状态 | 工作文档 — 用于与 owner 逐项讨论 |
| 相关文档 | `docs/chatmode-mechanism.md`<br>`docs/proactive-reply-pitfall-design.md`<br>`docs/response-system/architecture.md` |

---

## 一、核心概念演进

### 1.1 ChatMode（旧体系，现在是会话级状态）

```
ChatMode 定位：
- 会话级状态（Session.sessionMode）
- 作用域：单个 (channel, channelId, threadId) 会话
- 两个值：interactive（响应模式）/ proactive（自主模式）
- 由响应模式配置或历史状态决定
```

### 1.2 Response Mode（新体系，插件化系统）

```
Response Mode 定位：
- 可插拔的响应策略模块
- 决定入站处理（process/drop/defer）和出站发送（direct/suppress/batch）
- 通过生命周期钩子控制整个处理流程
```

---

## 二、架构分层

```
                     ┌──────────────────────────────────┐
                     │   Message Processor (执行层)      │
                     │  - 消息队列管理                    │
                     │  - Runner 调用                     │
                     │  - 生命周期编排                    │
                     └────────────┬─────────────────────┘
                                  │ 调用
                     ┌────────────▼─────────────────────┐
                     │  Response Mode Coordinator       │
                     │  - 解析模式 (resolveMode)         │
                     │  - 入站决策 (resolveInbound)      │
                     │  - 出站决策 (resolveOutbound)     │
                     └────┬───────────────┬──────────────┘
                          │               │
          ┌───────────────▼──┐      ┌────▼──────────────┐
          │  Registry        │      │  Resolver          │
          │  注册所有模式     │      │  解析用哪个模式     │
          └──────────────────┘      └────────────────────┘
                    │
        ┌───────────┴──────────────┐
        │                          │
   ┌────▼────────┐        ┌────────▼──────┐
   │ Interactive │        │  Proactive     │
   │   Mode      │        │    Mode        │
   └─────────────┘        └────────────────┘
```

---

## 三、模式解析优先级

```typescript
// Resolver 的三层解析逻辑（高→低）

1. Relation Override（特定对端/群）
   配置位置：response_modes.overrides[peerKey].mode
   示例：为某个重要客户指定 workflow 模式

2. ChatType Default（场景默认）
   配置位置：response_modes.default_private / default_group
   示例：群聊默认用 proactive，私聊默认用 interactive

3. System Fallback（系统兜底）
   private → interactive
   group   → proactive
```

---

## 四、两种内置模式对比

| 维度 | Interactive | Proactive |
|------|-------------|-----------|
| **输出行为** | 输出即回复（直接发送） | 输出即思考展示（需工具调用才发） |
| **适用场景** | 人机单聊 | Agent 对话、群聊 |
| **入站决策** | `action: 'process', queueBehavior: 'enqueue'` | 同 Interactive |
| **出站决策** | `method: 'direct', type: 'message'` | activity.batch → `type: 'thought'`<br>工具调用 → `type: 'message'` |
| **生命周期钩子** | afterProcess（处理文件标记） | beforeProcess（初始化状态）<br>configureRun（首工具表态）<br>onToolUse（工具汇报提醒）<br>afterProcess（Unknown skill 兜底） |

---

## 五、Proactive 模式的核心机制

### 5.1 运行时状态（ProactiveState）

```typescript
{
  firstToolDone: boolean,         // 是否已调用首个工具
  toolCount: number,              // 非表态工具计数
  lastQueueReminderLen: number,   // 上次队列提醒的队列长度
  chatType: string,               // 私聊/群聊
  preTool1stMsgChk: boolean,      // 是否启用首工具表态检查
  toolUseReminder: boolean        // 是否启用工具汇报提醒
}
```

### 5.2 生命周期钩子串联

```
入站消息
   │
   ├─ handleInbound: 构造初始 runtimeState
   │
   ▼
出队后
   │
   ├─ beforeProcess: 将 runtimeState 落入 ctx.state（供后续钩子共享）
   │
   ▼
Runner 调用前
   │
   ├─ configureRun: 返回 policyHook（首工具表态检查）
   │              返回 promptVars（chatMode/preTool1stMsgChk 等）
   │
   ▼
流处理期间
   │
   ├─ onToolUse: 队列未读提醒 + 10 次工具调用警告
   │
   ▼
Runner 返回后
   │
   └─ afterProcess: Unknown skill 兜底发送
```

### 5.3 输出路径分流

```
Proactive 模式下的两条输出路径：

1. 普通文本输出（思考过程）
   大模型输出 → IMRenderer.emit() 
              → emitProactive() 
              → activity.batch
              → handleOutbound 返回 { method: 'direct', type: 'thought' }
              → AUN adapter 的 sendThought()
              → message.thought.put（仅前端可见，不入历史，不触发对端）

2. 工具调用（正式回复）
   ec msg send / ec ctl send
              → 命令执行
              → message.send
              → handleOutbound 返回 { method: 'direct', type: 'message' }
              → 对端的 message.received 事件
```

---

## 六、关键设计决策点

### 6.1 为什么普通文本不直接发送？

**问题**：两个 agent 之间，如果输出无条件触发对方输入 → 无限循环。

**解决方案**：
- Proactive 模式下，普通文本投影成 `thought`（思考过程）
- `thought.put` 走独立协议通道，**不触发对端的 `message.received`** 事件
- 只有显式工具调用（`ec msg send`）才发 `message.send`，触发对端处理
- **循环终止条件**：某一方不再调用回复工具 → 对话自然停止

### 6.2 首工具表态检查（pre_tool_1stmsgchk）

**目的**：防止 agent 在 proactive 模式下，第一个工具就去执行任务（如搜索、文件操作），而不先向对端说明意图。

**实现**：`configureRun` 返回的 `policyHook`，检查首个工具是否是表态命令（`ec msg send` 等）。

**白名单**：`isSendCommand(toolName, toolInput)` 判断工具是否是表态命令。

### 6.3 工具汇报提醒（tool_use_reminder）

**目的**：
1. 队列未读提醒：有新消息时提醒 agent
2. 10 次工具调用警告：防止 agent 长时间不向对端汇报

**实现**：`onToolUse` 钩子，每次工具调用时检查队列长度和工具计数，必要时向模型注入提醒。

---

## 七、已知问题与修复状态

### 7.1 Proactive "输出即回复"坑

**问题描述**：Base agent 沿用 interactive 习惯，直接输出文本想回复对端，但 proactive 下这些文本**不会发给对端**，而是投影成思考展示（`thought`）。

**当前唯一防线**：ECK 的 `session.md` fragment（`kits/templates/system-fragments/session.md:22-26`）

**三个弱点**：
1. 措辞弱且不准（"静默丢弃"，实为"投影成 thought"）
2. 位置靠后（order:60，倒数第二段）
3. 命令口径打架（session.md 注 `ctl send`，06-channel.md 注 `ec msg send` 优先）

**建议修复方向**（来自 `proactive-reply-pitfall-design.md`）：

#### 方向 A：强化唯一防线（纯改 kits 模板，零代码，热加载生效）⭐ 首选

1. **`kits/rules/06-channel.md` 补因果**（权威落点）
   - 该文件在 always 加载的 rules 里，位置靠前
   - 补充说明："proactive 下你的普通文本会作为思考过程实时展示给用户（可见，但不入历史、不是回复）；要正式回复对端必须显式跑 `ec msg send` / `ctl send`"
   - 讲清机制而非罗列命令——理解比死记耐用

2. **`kits/templates/system-fragments/session.md` 改措辞 + 统一命令口径**
   - 把 "文本输出静默丢弃"（弱且不准）改为 "投影成思考过程实时展示，非正式回复"
   - 命令口径与 06-channel 对齐（统一以 `ec msg send` 为主、`ctl send` 为兜底）

#### 方向 B：闭环标志位机制（须 owner 定夺设计意图）

标志位 `[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)]` 是半成品，不是孤儿。三选一：

| 选项 | 内容 | 工作量 / 影响 |
|------|------|---------------|
| **(a) 补全** | 写产出端提示词 + 实现纠错重试，激活完整机制 | 有蓝图（`agent-to-agent-validation-implementation.md`），但需先建地基（`PROACTIVE_MODE_PROMPT` 等常量本不存在） |
| (b) 仅激活切换提示 | 补产出端提示词，让已实现的检测端/切换提示生效，搁置纠错重试 | 中小。但单独的切换提示对"本坑"价值有限 |
| (c) 整体废弃 | 删检测端（:1454-1461）+ 提示注入（:1204-1209）+ 标志位约定 | 小。但放弃了一个可能的运行时解药 |

#### 方向 C：运行时兜底（降级为纯 observability 或不做）

原始设想"一轮 proactive 结束、agent 既没 ctl send 也没实质输出 → warn/提醒"有缺陷：
- `chatmode-mechanism.md:5,132` 明确把"某一方不再调回复工具 → 对话自然停止"定为**核心设计目标**
- 按"没发=可疑"会在每个正常收尾轮误报

→ 若做，只能是**纯日志/度量**（给 owner 观测掉坑频率，不打扰 agent），或干脆不做。优先级最低。

#### 修复状态：已完成 ✅（2026-06-24 最终版）

**已修复**：
1. ✅ **完整因果链已补全**（`channel.md` fragment）
   - 补充了 thought.put 不触发 message.received → 对端不唤醒 → 不构成回复的完整机制
   - 讲清了设计意图：避免 agent↔agent 无限循环
   - 修复了"输出静默"旧词 bug

2. ✅ **消除重复，职责清晰**
   - channel.md fragment（order:50）：唯一事实源，讲完整机制
   - session.md（order:60）：行为规范（首消息表态/10次汇报）+ 命令速查
   - 06-channel.md（order:10）：恒定知识，明确指向 channel 段

3. ✅ **群聊前置判断补充**
   - 要求先判断是否需要响应
   - 不需要响应时：给出简短静默理由，然后直接结束
   - 避免不必要的处理和工具调用

**未完成**：
- ❌ 标志位机制的产出端（ECK 提示词）未落地
  - 本轮已搁置，需 owner 后续决策是补全、废弃还是继续搁置

---

### 7.2 标志位机制 — 已废弃 ❌（2026-06-25）

**机制设计**：`[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)]` 标志位，用于：
1. Agent-to-Agent 回复校验 / 纠错重试（原始用途）
2. Proactive→Interactive 模式切换提示（次要复用）

**废弃原因**：
1. **产出端从未实现**：ECK 中无任何提示词要求 agent 输出标志位
2. **检测端空转**：proactive.ts 的 onComplete 钩子检测标志位，但永远匹配不到
3. **边缘场景，性价比低**：
   - 用途 1（纠错重试）：提示词防线已加固（2026-06-24），需实际数据验证必要性
   - 用途 2（切换提示）：proactive↔interactive 切换是边缘场景
4. **后续有更好方案**：Delta 机制（参数带外变化时插入通知消息）

**清理动作**（2026-06-25）：
- 删除代码：4 个文件，17 行（proactive.ts、response-engine.ts、response-snapshot.ts、types.ts）
- 删除文档：3 个设计文档，~1700 行
- 归档文件保持原样：`_archived/_message-processor.ts`（历史快照）

**设计文档备份**：删除前已提交 git，可从历史查看：
- `agent-to-agent-validation-implementation.md`
- `proactive-to-interactive-hint-design.md`
- `proactive-to-interactive-hint-implementation.md`

---

### 7.3 ChatMode 配置缺口

来自 `docs/chatmode-mechanism.md:134-160`：

| # | 缺口 | 影响 | 修复状态 |
|---|------|------|----------|
| 1 | 群聊未在 `resolveSession()` 中硬强制 proactive | 历史群聊可能是 interactive | ✅ **已修复**<br>`response-engine.ts:2113-2118` 兜底纠正1：群聊强制 proactive<br>`session-manager.ts:54` 新建会话时群聊默认 proactive |
| 2 | `chatmode.nothuman` 配置未被读取 | Agent 对端新建会话默认 interactive | ✅ **已修复**<br>`session-manager.ts:59-60` 已实现：`peerType !== 'human'` 强制 proactive |
| 3 | `sessionModeResolver` 签名不接收 peerType | 无法在新建时落到 nothuman 默认 | ✅ **已修复**<br>`session-manager.ts:50` 签名已包含 `peerType?` 参数 |
| 4 | thought.put 的 chatmode 字段嵌套位置不一致 | 跨服务观测不统一 | ✅ **已修复**（2026-06-25）<br>`aun.ts:2951-2955` 补齐 payload.chatmode<br>前端审查确认：强依赖此字段，缺失导致 proactive 思考过程泄漏 |

---

## 八、配置示例

```jsonc
// agent config.json 中的 response_modes 块
{
  "response_modes": {
    // 场景默认模式
    "default_private": "interactive",
    "default_group": "proactive",
    
    // 每个模式的配置
    "configs": {
      "proactive": {
        "pre_tool_1stmsgchk": true,  // 首工具表态检查
        "tool_use_reminder": true     // 工具汇报提醒
      }
    },
    
    // 特定对端 override
    "overrides": {
      "aun#important-customer.aid.pub": {
        "mode": "workflow",
        "config": {
          "workflow_file": "customer-service.yaml"
        }
      }
    }
  }
}
```

---

## 九、文件位置索引

| 模块 | 文件 |
|------|------|
| **类型定义** | `src/response-modes/types.ts` |
| **Coordinator** | `src/response-modes/coordinator.ts` |
| **Resolver** | `src/response-modes/resolver.ts` |
| **Registry** | `src/response-modes/registry.ts` |
| **Interactive 实现** | `src/response-modes/core/interactive.ts` |
| **Proactive 实现** | `src/response-modes/core/proactive.ts` |
| **设计文档** | `docs/chatmode-mechanism.md`（owner 亲笔）<br>`docs/proactive-reply-pitfall-design.md`（问题分析）<br>`docs/response-system/architecture.md`（插件化架构设计） |
| **ECK 规则** | `kits/rules/06-channel.md`（通信规则）<br>`kits/templates/system-fragments/session.md`（唯一防线） |

---

## 十、待办清单

### 已完成 ✅

1. **ECK 提示词修复（3/3）**
   - [x] `kits/templates/system-fragments/session.md` 措辞已修正 ✅
   - [x] 命令口径（`ec msg send` vs `ctl send`）已统一 ✅
   - [x] `kits/rules/06-channel.md` 已补充 proactive 因果说明 ✅（2026-06-24 三处提示词加固）

2. **ChatMode 配置缺口（3/4）**
   - [x] 群聊已强制 proactive ✅（新建时 + 运行时兜底纠正）
   - [x] `chatmode.nothuman` 已被读取 ✅（`peerType !== 'human'` 强制 proactive）
   - [x] `sessionModeResolver` 签名已接收 peerType ✅

### 待办 ⏳（0/10） — 全部完成 🎉

**无待办项**，响应模式系统核心工作已全部完成。

### 最近完成（2026-06-25）

1. **ChatMode 配置缺口（1/4）**
   - thought.put 的 chatmode 字段位置对齐 ✅
   - 状态：已修复（`aun.ts:2951-2955` 补齐 payload.chatmode）
   - 前端审查确认：强依赖此字段，缺失会导致 proactive 思考过程泄漏

### 已废弃 🗑️

1. **标志位机制（2026-06-25）**
   - 产出端从未实现，检测端空转
   - 边缘场景，性价比低
   - 后续用 Delta 机制替代
   - 已清理：17 行代码 + 3 个设计文档

---

## 十一、修复状态总结

### 🎉 全部完成 ✅（10/10）

**响应模式系统核心工作全部完成！**

#### 1. ChatMode 配置缺口（4/4）
   - ✅ 群聊强制 proactive（新建 + 运行时兜底）
   - ✅ peerType 强制 proactive（agent 对端）
   - ✅ SessionManager 签名已包含 peerType
   - ✅ thought.put 的 chatmode 字段已对齐（2026-06-25）

#### 2. ECK 提示词（3/3）
   - ✅ session.md 措辞已修正
   - ✅ 命令口径已统一
   - ✅ 06-channel.md 已补充 proactive 因果说明

#### 3. 群聊响应优化（2/2）
   - ✅ 群聊前置判断（先判断是否需要响应）
   - ✅ 静默理由要求（不响应时给出简短理由）

#### 4. 标志位机制清理（1/1）
   - ✅ 已废弃并清理（17 行代码 + 3 个文档）

---

## 当前状态

**✅ 响应模式系统核心工作已全部完成**（2026-06-25）

**本轮改动汇总**：
1. **提示词加固**（2026-06-24）：三处改动，补因果 + 去重 + 群聊优化
2. **标志位清理**（2026-06-25）：删除空转机制，-1764 行
3. **chatmode 字段对齐**（2026-06-25）：补齐 thought.put，+6 行

**后续观察**：
- 观测实际使用中 agent 是否还会踩 proactive "输出即回复"坑
- 观测 thought.put 的 chatmode 字段是否正常工作（前端过滤生效）

---

## 附录：核心决策流程图

```
入站消息到达
   │
   ▼
Coordinator.resolveInbound
   │
   ├─ Resolver.resolve (三层优先级)
   │  ├─ 1. override[peerKey].mode
   │  ├─ 2. default_private / default_group
   │  └─ 3. system fallback
   │
   ├─ ContextBuilder.build
   │
   └─ mode.handleInbound
      │
      └─ 返回 InboundDecision { action, queueBehavior, runtimeState }
         │
         ▼
MessageProcessor 入队 (或 drop/defer)
   │
   ▼
出队后，开始处理
   │
   ├─ mode.beforeProcess (初始化 ctx.state)
   │
   ├─ mode.configureRun (返回 RunConfig)
   │  ├─ policyHook (首工具表态)
   │  ├─ suppressActivities
   │  └─ promptVars
   │
   ▼
Runner 调用（流式处理）
   │
   ├─ 工具调用 → mode.onToolUse
   │
   └─ 完成 → mode.onComplete
      │
      ▼
Runner 返回
   │
   └─ mode.afterProcess
      │
      ▼
处理完成
```

---

## 文档历史

| 日期 | 修改 | 作者 |
|------|------|------|
| 2026-06-24 | 初始版本，基于代码梳理 | Claude Code |
| 2026-06-24 | 补充修复状态核实（§7.1-7.3 + §10） | Claude Code |
| 2026-06-24 | 完成 proactive 防线加固（三处改动已落地） | Claude Code |
| 2026-06-25 | 清理标志位机制（17 行代码 + 3 个文档） | Claude Code |
| 2026-06-25 | 文档清理：更新所有已完成项，删除过时描述 | Claude Code |
| 2026-06-25 | 🎉 全部完成：补齐 thought.put chatmode 字段 | Claude Code |
