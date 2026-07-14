# EvolClaw 响应模式体系架构

**文档版本**: 3.1  
**创建时间**: 2026-07-08  
**状态**: 架构定稿

---

## 一、整体架构

### 1.1 三层架构

```
┌─────────────────────────────────────────┐
│         用户配置层                        │
│   responseMode: 'single-session'        │
│   config: {                             │
│     chatMode: 'proactive',              │
│     mentionMode: 'disabled'             │
│   }                                     │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│      响应模式路由（Registry）             │
│   根据 responseMode 查找实现             │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│      响应模式实现                         │
│   - single-session (基于 V1 引擎)       │
│   - dual-session (基于 V2 引擎)         │
│   - workflow (未来)                     │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│      响应引擎层                          │
│   V1 / V2 / V3...                      │
└─────────────────────────────────────────┘
```

### 1.2 核心设计原则

#### 三层分离

1. **用户配置层**：选择响应模式 + 配置参数
2. **响应模式层**：用户可见的模式实现（插件）
3. **响应引擎层**：技术实现基础

#### 参数正交

| 维度 | 类型 | 说明 |
|------|------|------|
| **响应模式** | 架构维度 | 选择哪个模式（single-session / dual-session） |
| **通用参数** | 配置维度 | 所有模式都支持的参数（chatMode / mentionMode） |
| **特有参数** | 配置维度 | 特定模式独有的参数（debounceMs / auxiliaryModel） |

**正交性体现**：
- ✅ `chatMode` 是参数，不是模式（不需要 single-session-interactive 和 single-session-proactive 两个模式）
- ✅ `mentionMode` 是参数，不是模式（所有模式都支持）
- ✅ 新增模式时，不需要为每个 chatMode 创建变体

---

## 二、目录结构

### 2.1 代码目录

```
src/response-system/
│
├── registry.ts                          # 响应模式注册表
├── selector.ts                          # 响应模式选择器
├── types.ts                             # 公共类型定义
├── index.ts                             # 公共 API 导出
│
├── engines/                             # 响应引擎层
│   ├── v1/                             # V1 引擎（单会话）
│   │   ├── engine.ts
│   │   ├── types.ts
│   │   └── README.md
│   │
│   └── v2/                             # V2 引擎（双会话）
│       ├── engine.ts
│       ├── auxiliary-queue.ts
│       ├── auxiliary-session.ts
│       ├── main-queue.ts
│       ├── main-session.ts
│       ├── types.ts
│       └── README.md
│
└── modes/                              # 响应模式实现
    ├── single-session/                # 单会话模式
    │   ├── index.ts
    │   └── config-schema.json
    │
    ├── dual-session/                  # 双会话模式（原 dual-session-lite）
    │   ├── index.ts
    │   └── config-schema.json
    │
    └── workflow/                      # 工作流模式（未来）
        ├── index.ts
        └── config-schema.json
```

### 2.2 文档目录

```
docs/response-system/
├── ARCHITECTURE.md                    # 本文档（体系架构，入口）
│
├── dual-session/                      # dual-session 详细设计
│   ├── INDEX.md                      # 文档索引
│   ├── README.md                     # 总览和快速开始
│   ├── architecture.md               # dual-session 内部架构
│   ├── data-structures.md
│   ├── config/
│   └── prompts/
│
├── dual-session-lite/                 # 参考设计（完整文档目录）
│
└── _archive/                          # 归档的旧体系架构文档
    ├── RESPONSE-MODE-ARCHITECTURE-V2.md
    ├── ARCHITECTURE-FINAL.md
    └── RESPONSE-MODE-SYSTEM-ARCHITECTURE.md
```

---

## 三、通用参数

### 3.1 接口定义

```typescript
interface CommonResponseModeConfig {
  // 1. 交互方式（必选）
  chatMode: 'interactive' | 'proactive';
  
  // 2. Mention 处理策略（可选）
  mentionMode?: 'disabled' | 'mention-only';
  
  // 3. 模型选择（可选，默认由响应模式决定）
  model?: string;  // 如 'claude-opus', 'claude-sonnet'
}
```

### 3.2 chatMode（交互方式）

**语义**：决定如何投递回复

| 值 | 说明 | 适用场景 |
|---|------|---------|
| `interactive` | 输出即回复 | coding 模式（无渠道） |
| `proactive` | CLI 回复 | 单聊/群聊（有渠道） |

**所有响应模式的实现**：
- 单会话：直接在会话中根据 chatMode 决定回复方式
- 双会话：主会话根据 chatMode 决定回复方式
- 工作流：工作流结束后根据 chatMode 决定回复方式

### 3.3 mentionMode（Mention 处理策略）

**语义**：决定如何处理 mention 消息

| 值 | 说明 | 所有模式通用语义 |
|---|------|-----------------|
| `disabled` | 所有消息都处理 | 默认值 |
| `mention-only` | 仅处理被 @ 的消息 | 未 @ 消息入队作引用上下文，不触发处理 |

**各响应模式的实现**：

#### single-session
- `disabled`：所有消息直接进入会话处理
- `mention-only`：只有被 @ 的消息触发处理，未 @ 消息入队作引用上下文（不丢弃）

#### dual-session
- `disabled`：所有消息进辅助队列 → 辅助会话判断
- `mention-only`：所有消息都进辅助队列，只有被 @ / 活跃发言人消息触发处理，其余作引用上下文

> 详细机制（引用读取边界、队列淘汰、活跃发言人）见 [MENTION-MODE-MECHANISM.md](./dual-session/MENTION-MODE-MECHANISM.md)

### 3.4 model（模型选择）

**语义**：主会话使用的模型

- 可选参数，默认由响应模式决定
- 单会话：直接使用该模型
- 双会话：主会话使用该模型（辅助会话有独立配置 `auxiliaryModel`）

---

## 四、响应模式清单

### 4.1 single-session（单会话模式）

**说明**：合并后的单会话模式，替代原有的 `interactive` 和 `proactive`

**基础引擎**：V1

**通用参数**：✅ 全部支持（chatMode / mentionMode / model）

**特有参数**：无

```typescript
interface SingleSessionConfig extends CommonResponseModeConfig {
  // 无特有参数
}
```

**适用场景**：
- coding 模式（`chatMode: 'interactive'`）
- 传统单聊/群聊（`chatMode: 'proactive'`）
- 简单的直接响应场景

---

### 4.2 dual-session（双会话模式）

**说明**：原 `dual-session-lite`，改名为 `dual-session`

**基础引擎**：V2

**通用参数**：✅ 全部支持（chatMode / mentionMode / model）

**特有参数**：

```typescript
interface DualSessionConfig extends CommonResponseModeConfig {
  // 辅助队列触发配置
  debounceMs?: number;        // 防抖时间（默认 3000ms）
  maxWaitMs?: number;         // 最早消息最长等待（默认 15000ms）
  maxQueueSize?: number;      // 队列最大容量（群聊 50，单聊 15）
  
  // 辅助会话模型
  auxiliaryModel?: string;    // 默认 'deepseek-v4-flash'
  
  // 会话压缩配置
  auxiliaryMaxTokens?: number;  // 辅助会话压缩阈值（默认 40k）
  mainMaxTokens?: number;       // 主会话压缩阈值（默认 160k）
  
  // 打断策略
  interruptEnabled?: boolean;   // 是否启用打断（默认 true）
}
```

**适用场景**：
- 多 agent 群聊（避免竞争回复）
- 快慢模型组合场景
- 需要智能判断消息相关性的场景

**详细设计**：见 [dual-session/README.md](./dual-session/README.md)

---

### 4.3 workflow（工作流模式，未来）

**说明**：基于工作流引擎的响应模式

**基础引擎**：V3（未实现）

**通用参数**：✅ 全部支持（chatMode / mentionMode / model）

**特有参数**：

```typescript
interface WorkflowConfig extends CommonResponseModeConfig {
  // 工作流引擎选择
  workflowEngine?: 'simple' | 'advanced';
  
  // 工作流定义文件
  workflowFile?: string;
  
  // 任务队列配置
  taskQueueSize?: number;
  taskPriority?: 'fifo' | 'lifo' | 'priority';
}
```

**适用场景**：
- 复杂的多步骤响应流程
- 需要状态机管理的场景
- 需要人工干预的半自动流程

---

## 五、注册表设计

```typescript
// src/response-system/registry.ts

export interface ResponseModeDescriptor {
  name: string;
  displayName: string;
  description: string;
  factory: (config: any) => ResponseModeImpl;
  configSchema: object;
  supportedCommonParams: string[];  // 声明支持的通用参数
  specificParams: string[];         // 声明特有参数
}

export const responseModeRegistry: Record<string, ResponseModeDescriptor> = {
  'single-session': {
    name: 'single-session',
    displayName: '单会话模式',
    description: '直接响应，无辅助会话',
    factory: (config: SingleSessionConfig) => new SingleSession(config),
    configSchema: singleSessionConfigSchema,
    supportedCommonParams: ['chatMode', 'mentionMode', 'model'],
    specificParams: [],  // 无特有参数
  },
  
  'dual-session': {
    name: 'dual-session',
    displayName: '双会话模式',
    description: '辅助会话判断，主会话处理',
    factory: (config: DualSessionConfig) => new DualSession(config),
    configSchema: dualSessionConfigSchema,
    supportedCommonParams: ['chatMode', 'mentionMode', 'model'],
    specificParams: [
      'debounceMs',
      'maxWaitMs',
      'maxQueueSize',
      'auxiliaryModel',
      'auxiliaryMaxTokens',
      'mainMaxTokens',
      'interruptEnabled',
    ],
  },
};
```

---

## 六、配置示例

### 6.1 coding 模式（无渠道）

```json
{
  "responseMode": "single-session",
  "config": {
    "chatMode": "interactive"
  }
}
```

### 6.2 传统单聊/群聊

```json
{
  "responseMode": "single-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "disabled"
  }
}
```

### 6.3 mention-only 单聊（只响应 @）

```json
{
  "responseMode": "single-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "mention-only"
  }
}
```

### 6.4 双会话群聊（标准配置）

```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "disabled",
    "debounceMs": 3000,
    "maxWaitMs": 15000,
    "auxiliaryModel": "deepseek-v4-flash"
  }
}
```

---

## 七、ECK 集成

### 7.1 ECK Vars

```typescript
interface ECKVars {
  // 当前响应模式
  responseMode: 'single-session' | 'dual-session' | 'workflow';
  
  // 通用参数（从 config 中提取）
  chatMode: 'interactive' | 'proactive';
  mentionMode: 'disabled' | 'mention-only';
  model: string;
  
  // dual-session 特有
  sessionType?: 'auxiliary' | 'main';
  
  // 其他参数
  chatType: 'private' | 'group' | null;
  channel: string;
  selfAid: string;
  peerId: string;
  peerKey: string;  // <channel>#<urlEncode(peerId)>
  // ...
}
```

### 7.2 Context Assembly Manifest

```jsonc
{
  "sections": [
    // 辅助会话提示词（dual-session 特有）
    {
      "id": "auxiliary-session-prompt",
      "type": "file",
      "file": "$KITS_DOCS/response-system/dual-session/prompts/auxiliary-base.md",
      "order": 20,
      "needsInjection": true,
      "when": { "and": [
        { "var": "responseMode", "eq": "dual-session" },
        { "var": "sessionType", "eq": "auxiliary" }
      ] }
    },
    // 主会话提示词（dual-session 特有）
    {
      "id": "main-session-prompt",
      "type": "file",
      "file": "$KITS_DOCS/response-system/dual-session/prompts/main-base.md",
      "order": 20,
      "needsInjection": true,
      "when": { "and": [
        { "var": "responseMode", "eq": "dual-session" },
        { "var": "sessionType", "eq": "main" }
      ] }
    },
    // chatMode 说明（所有模式通用）
    {
      "id": "chat-mode-guide-proactive",
      "type": "file",
      "file": "$KITS_DOCS/response-system/prompts/chat-mode-proactive.md",
      "order": 56,
      "needsInjection": false,
      "when": { "var": "chatMode", "eq": "proactive" }
    },
    {
      "id": "chat-mode-guide-interactive",
      "type": "file",
      "file": "$KITS_DOCS/response-system/prompts/chat-mode-interactive.md",
      "order": 56,
      "needsInjection": false,
      "when": { "var": "chatMode", "eq": "interactive" }
    }
  ]
}
```

---

## 八、总结

### 8.1 核心设计

1. **响应模式参数**：`responseMode`（`single-session` / `dual-session` / `workflow`）
2. **通用参数**：`chatMode`, `mentionMode`, `model`
3. **特有参数**：各响应模式各自定义

### 8.2 当前响应模式

| 模式 | 引擎 | 通用参数 | 特有参数 |
|------|------|---------|---------|
| `single-session` | V1 | ✅ 全部支持 | 无 |
| `dual-session` | V2 | ✅ 全部支持 | 7 个（队列/压缩/打断） |

### 8.3 设计优势

✅ **概念清晰**：响应模式 + 通用参数 + 特有参数  
✅ **参数正交**：chatMode/mentionMode 是参数，不是模式  
✅ **无组合爆炸**：新增模式不需要创建多个变体  
✅ **易于扩展**：新模式继承通用参数，定义特有参数  
✅ **配置直观**：用户只选模式，配置参数  

---

**最后更新**: 2026-07-08  
**维护者**: Claude Code
