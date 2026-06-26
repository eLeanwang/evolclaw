# 响应模式系统架构文档

**版本**: 1.0  
**更新时间**: 2026-06-26  
**状态**: 生产就绪

---

## 📋 目录

1. [系统概述](#系统概述)
2. [核心概念](#核心概念)
3. [架构设计](#架构设计)
4. [组件详解](#组件详解)
5. [数据流](#数据流)
6. [决策点](#决策点)
7. [扩展指南](#扩展指南)

---

## 系统概述

### 设计目标

响应模式系统是 EvolClaw 的核心消息处理引擎，负责：

1. **统一消息处理** - 所有渠道的消息经由统一的响应引擎处理
2. **模式自适应** - 根据场景自动选择 Interactive 或 Proactive 模式
3. **行为可追溯** - 通过快照记录所有决策点
4. **插件化架构** - 支持扩展和自定义响应模式

### 核心价值

- ✅ **一致性** - 不同渠道、不同模式行为一致
- ✅ **可观测** - 快照记录提供完整的行为追踪
- ✅ **可扩展** - 插件化设计支持添加新模式
- ✅ **高性能** - 平均延迟 6.6ms，支持高并发

---

## 核心概念

### 响应模式（Response Mode）

系统支持两种基本响应模式：

#### Interactive 模式

**适用场景**: Coding 场景（无渠道，本地交互）

**特征**:
- 直接输出即回复
- 无主动状态构造
- 实时反馈（status.progress + result.text）
- 每条消息都响应

**快照标识**:
```json
{
  "chatMode": "interactive",
  "proactiveState": null
}
```

#### Proactive 模式

**适用场景**: AUN 私聊/群聊

**特征**:
- 构造主动运行时状态
- 工具使用前消息检查
- 工具提醒机制
- 自主决定是否响应

**快照标识**:
```json
{
  "chatMode": "proactive",
  "proactiveState": {
    "preTool1stMsgChk": true,
    "toolUseReminder": true,
    "chatType": "private"
  }
}
```

### 快照（Snapshot）

快照是响应系统的"黑盒录像"，记录：

- **模式判定结果** - chatMode
- **状态构造参数** - proactiveState
- **决策点** - policyHook、toolReminder 等
- **出站决策** - 每个消息的发送/抑制决策

**用途**:
- 迁移验证（对比新旧系统）
- 行为审计
- 问题排查
- 性能分析

---

## 架构设计

### 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         EvolClaw                             │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Channel Adapters                          │  │
│  │   (AUN / 飞书 / 微信 / Coding)                          │  │
│  └────────────────────┬──────────────────────────────────┘  │
│                       │                                       │
│                       ▼                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           Message Processor (入口)                     │  │
│  │  ├─ 消息接收                                            │  │
│  │  ├─ Session 管理                                        │  │
│  │  └─ 调用 Response Engine                               │  │
│  └────────────────────┬──────────────────────────────────┘  │
│                       │                                       │
│                       ▼                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │          Response Engine (核心)                        │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  1. 模式判定 (chatMode)                          │  │  │
│  │  │     ├─ 检查渠道类型                               │  │  │
│  │  │     ├─ 检查场景 (private/group/coding)           │  │  │
│  │  │     └─ 返回 interactive/proactive                │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  2. 状态构造                                      │  │  │
│  │  │     ├─ Interactive: 无状态                        │  │  │
│  │  │     └─ Proactive: ProactiveRuntimeState          │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  3. Base Agent 调用                               │  │  │
│  │  │     └─ 传递状态、上下文、工具                      │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  4. 出站处理                                      │  │  │
│  │  │     ├─ 决策：发送 / 抑制                          │  │  │
│  │  │     └─ 记录到快照                                 │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └────────────────────┬──────────────────────────────────┘  │
│                       │                                       │
│                       ▼                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │        Response Snapshot (观测)                        │  │
│  │  ├─ 记录决策点                                          │  │
│  │  ├─ 写入 response-snapshots.jsonl                      │  │
│  │  └─ 用于验证、审计、排查                                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### 关键路径

1. **消息到达** → Channel Adapter
2. **入口处理** → Message Processor
3. **模式判定** → Response Engine
4. **状态构造** → ProactiveRuntimeState (如果需要)
5. **Base Agent 调用** → Claude Code / Codex / Gemini
6. **出站决策** → 发送 / 抑制
7. **快照记录** → response-snapshots.jsonl

---

## 组件详解

### 1. Response Engine

**位置**: `src/core/message/response-engine.ts`

**职责**:
- 模式判定（chatMode）
- 状态构造（proactiveState）
- Base Agent 调用
- 出站处理

**关键方法**:

```typescript
// 核心入口
async processMessage(ctx: MessageContext): Promise<Response>

// 模式判定
determineChatMode(ctx: MessageContext): 'interactive' | 'proactive'

// 状构造
buildProactiveState(ctx: MessageContext): ProactiveRuntimeState | null

// 出站决策
handleOutbound(message: OutboundMessage): 'sent' | 'suppressed'
```

**设计要点**:
- 插件化架构
- 统一入口
- 决策透明（快照记录）

### 2. Response Snapshot

**位置**: `src/core/message/response-snapshot.ts`

**职责**:
- 记录决策点
- 写入 JSONL 文件
- 零侵入设计（关闭时 no-op）

**数据结构**:

```typescript
interface BehaviorSnapshot {
  ts: number;                    // 时间戳
  msgId?: string;               // 消息 ID
  sessionId: string;            // 会话 ID
  taskId: string;               // 任务 ID
  source: 'legacy' | 'plugin';  // 来源标记
  
  // 模式决策
  chatMode?: 'interactive' | 'proactive';
  proactiveState?: ProactiveRuntimeState | null;
  
  // 流程介入点
  policyHook?: { triggered: boolean; blocked: boolean };
  toolReminder?: { queueReminders: number; tenWarning: boolean };
  
  // 出站决策
  outbound?: Array<{
    kind: string;
    decision: 'sent' | 'suppressed-thought' | 'suppressed-bg';
  }>;
}
```

**控制开关**:
```bash
# 启用
export RESPONSE_SNAPSHOT=1

# 关闭（默认）
export RESPONSE_SNAPSHOT=0
```

**输出位置**:
```
$EVOLCLAW_HOME/data/eck-debug/response-snapshots.jsonl
```

### 3. Message Processor

**位置**: `src/core/message/message-processor.ts`

**职责**:
- 消息接收入口
- Session 生命周期管理
- 调用 Response Engine
- 错误处理

**工作流程**:

```
1. 接收消息
2. 创建/恢复 Session
3. 调用 Response Engine
4. 处理响应
5. 清理资源
```

### 4. Proactive Runtime State

**构造内容**:

```typescript
interface ProactiveRuntimeState {
  preTool1stMsgChk: boolean;     // 首工具前消息检查
  toolUseReminder: boolean;      // 工具使用提醒
  chatType: 'private' | 'group'; // 场景类型
}
```

**用途**:
- 传递给 Base Agent
- 影响 Base Agent 行为
- 记录在快照中

---

## 数据流

### Interactive 模式数据流

```
消息到达
  ↓
判定 chatMode = 'interactive'
  ↓
proactiveState = null
  ↓
调用 Base Agent（无主动状态）
  ↓
Base Agent 输出
  ↓
直接发送（output = reply）
  ↓
记录快照
```

**特点**:
- 无状态构造
- 直接输出即回复
- 简单快速

### Proactive 模式数据流

```
消息到达
  ↓
判定 chatMode = 'proactive'
  ↓
构造 ProactiveRuntimeState {
  preTool1stMsgChk: true,
  toolUseReminder: true,
  chatType: 'private'
}
  ↓
调用 Base Agent（传递主动状态）
  ↓
Base Agent 处理
  ├─ 工具调用前检查
  ├─ 工具提醒机制
  └─ 自主决定响应
  ↓
出站消息
  ├─ thought → suppressed
  ├─ activity.batch → sent
  └─ result.text → sent
  ↓
记录快照
```

**特点**:
- 有状态构造
- 自主响应决策
- 丰富的决策点

---

## 决策点

### 1. chatMode 判定逻辑

**输入**:
- 渠道类型（channel）
- 场景类型（chatType: private/group/null）
- 对端信息（peerId）

**判定规则**:

```typescript
if (!channel && !peerId) {
  // Coding 场景（无渠道）
  return 'interactive';
}

if (channel && (chatType === 'private' || chatType === 'group')) {
  // AUN 私聊/群聊
  return 'proactive';
}

// 默认
return 'interactive';
```

### 2. proactiveState 构造

**Interactive 模式**:
```typescript
proactiveState = null
```

**Proactive 模式**:
```typescript
proactiveState = {
  preTool1stMsgChk: true,    // 启用首工具前检查
  toolUseReminder: true,      // 启用工具提醒
  chatType: chatType,         // 传递场景类型
}
```

### 3. 工具提醒机制

**触发条件**:
- Proactive 模式
- toolUseReminder = true
- 有工具在队列中

**行为**:
- 记录 queueReminders 计数
- 10 次时发出警告（tenWarning = true）

### 4. 出站决策

**decision 类型**:
- `sent` - 发送
- `suppressed-thought` - 抑制（思考过程）
- `suppressed-bg` - 抑制（后台任务）

**决策规则**:
- Interactive: 所有 result.text 都发送
- Proactive: 按策略决定

---

## 扩展指南

### 如何添加新响应模式

#### 1. 定义模式

在 `response-engine.ts` 中添加新模式类型：

```typescript
type ChatMode = 'interactive' | 'proactive' | 'selective'; // 新增
```

#### 2. 添加判定逻辑

更新 `determineChatMode()` 方法：

```typescript
determineChatMode(ctx: MessageContext): ChatMode {
  // 现有逻辑...
  
  // 新模式判定
  if (ctx.config?.responseMode === 'selective') {
    return 'selective';
  }
  
  // ...
}
```

#### 3. 构造状态

更新 `buildProactiveState()` 或创建新方法：

```typescript
buildSelectiveState(ctx: MessageContext): SelectiveRuntimeState {
  return {
    keywords: ctx.config?.keywords || [],
    matchMode: 'any',
    // ...
  };
}
```

#### 4. 更新快照

在 `response-snapshot.ts` 中添加新字段：

```typescript
interface BehaviorSnapshot {
  // 现有字段...
  
  selectiveState?: SelectiveRuntimeState; // 新增
}
```

#### 5. 测试

创建测试用例验证新模式行为。

### 插件开发

响应系统支持插件化扩展。插件可以：

1. **拦截决策点** - policyHook
2. **修改状态** - 动态调整 proactiveState
3. **自定义出站逻辑** - 覆盖默认决策

**插件接口**:

```typescript
interface ResponsePlugin {
  name: string;
  
  // 模式判定后
  onChatModeDecided?(mode: ChatMode, ctx: MessageContext): void;
  
  // 状态构造后
  onStateBuilt?(state: any, ctx: MessageContext): void;
  
  // 出站决策前
  onBeforeOutbound?(message: OutboundMessage): 'allow' | 'suppress';
}
```

---

## 性能考虑

### 关键指标

- **平均延迟**: 6.6ms/条
- **并发能力**: ~150 条/秒
- **内存占用**: 稳定（无泄漏）
- **快照开销**: < 1ms（启用时）

### 优化建议

1. **快照** - 生产环境关闭，测试/调试时开启
2. **状态构造** - 避免重复计算
3. **出站决策** - 缓存策略结果

---

## 故障排查

### 问题：消息未响应

**检查点**:
1. chatMode 判定是否正确
2. proactiveState 是否构造
3. 查看快照文件确认决策点

**快照分析**:
```bash
# 查看最新快照
tail -1 ~/.evolclaw/data/eck-debug/response-snapshots.jsonl

# 检查 chatMode
grep '"chatMode":"proactive"' response-snapshots.jsonl | wc -l
```

### 问题：快照未生成

**检查点**:
1. 环境变量 `RESPONSE_SNAPSHOT=1`
2. 目录权限 `~/.evolclaw/data/eck-debug/`
3. Daemon 是否运行

### 问题：模式判定错误

**检查点**:
1. Channel 类型
2. chatType 值
3. peerId 是否存在

**调试方法**:
```typescript
// 添加日志
console.log('chatMode决策:', {
  channel: ctx.channel,
  chatType: ctx.chatType,
  peerId: ctx.peerId,
  result: chatMode
});
```

---

## 相关文档

- [测试报告](final-test-summary.md)
- [快照系统指南](response-snapshot-guide.md)（待创建）
- [故障排查指南](troubleshooting-guide.md)（待创建）

---

**版本**: 1.0  
**作者**: Claude (Opus 4.8)  
**更新时间**: 2026-06-26  
**状态**: 生产就绪
