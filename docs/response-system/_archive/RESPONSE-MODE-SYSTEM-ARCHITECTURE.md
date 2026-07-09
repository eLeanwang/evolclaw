# EvolClaw 响应模式体系架构

**文档版本**: 3.0  
**创建时间**: 2026-07-08  
**状态**: 架构定稿

---

## 一、整体架构

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
│   - dual-session (于 V2 引擎)         │
│   - workflow (未来)                     │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│      响应引擎层                          │
│   V1 / V2 / V3...                      │
└─────────────────────────────────────────┘
```

---

## 二、核心设计原则

### 2.1 三层分离

1. **用户配置层**：选择响应模式 + 配置参数
2. **响应模式层**：用户可见的模式实现（插件）
3. **响应引擎层**：技术实现基础

### 2.2 参数正交

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

## 三、通用参数（所有响应模式都支持）

```typescript
interface CommonResponseModeConfig {
  // 1. 交互方式（必选）
  chatMode: 'interactive' | 'proactive';
  
  // 2. Mention 处理策略（可选）
  mentionMode?: 'disabled' | 'mention-only' | 'fast-track';
  
  // 3. 模型选择（可选，默认由响应模式决定）
  model?: string;  // 如 'claude-opus', 'claude-sonnet'
}
```

### 3.1 chatMode（交互方式）

**语义**：决定如何投递回复

| 值 | 说明 | 适用场景 |
|---|------|---------|
| `interactive` | 输出即回复 | coding 模式（无渠道） |
| `proactive` | CLI 回复 | 单聊/群聊（有渠道） |

**所有响应模式的实现**：
- 单会话：直接在会话中根据 chatMode 决定回复方式
- 双会话：主会话根据 chatMode 决定回复方式
- 工作流：工作流结束后根据 chatMode 决定回复方式

---

### 3.2 mentionMode（Mention 处理策略）

**语义**：决定如何处理 mention 消息

| 值 | 说明 | 所有模式通用语义 |
|---|------|-----------------|
| `disabled` | 所有消息都处理 | 默认值 |
| `mention-only` | 仅处理被 @ 的消息 | 过滤未 @ 的消息 |
| `fast-track` | 被 @ 消息走快速通道 | 特定模式有特殊语义 |

**各响应模式的实现**：

#### single-session
- `disabled`：所有消息直接进入会话处理
- `mention-only`：只有被 @ 的消息进入会话，其他过滤
- `fast-track`：等同于 `disabled`（无快速通道概念）

#### dual-session
- `disabled`：所有消息进辅助队列 → 辅助会话判断
- `mention-only`：只有被 @ 的消息进辅助队列，其他过滤
- `fast-track`：被 @ 的消息跳过辅助队列，直接投递主队列；未 @ 的消息进辅助队列

#### workflow（未来）
- `disabled`：所有消息进工作流
- `mention-only`：只有被 @ 的消息进工作流
- `fast-track`：被 @ 的消息高优先级处理

---

### 3.3 model（模型选择）

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
- 快慢模型不对齐场景
- 需要智能判断消息相关性的场景

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

## 五、配置示例

### 5.1 coding 模式（无渠道）

```json
{
  "responseMode": "single-session",
  "config": {
    "chatMode": "interactive"
  }
}
```

### 5.2 传统单聊/群聊

```json
{
  "responseMode": "single-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "disabled"
  }
}
```

### 5.3 mention-only 单聊（只响应 @）

```json
{
  "responseMode": "single-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "mention-only"
  }
}
```

### 5.4 双会话群聊（标准配置）

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

### 5.5 双会话群聊（快速通道）

```json
{
  "responseMode": "dual-session",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "fast-track",
    "debounceMs": 3000
  }
}
```

### 5.6 工作流模式（未来）

```json
{
  "responseMode": "workflow",
  "config": {
    "chatMode": "proactive",
    "mentionMode": "disabled",
    "workflowEngine": "advanced",
    "workflowFile": "./workflows/customer-support.yml"
  }
}
```

---

## 六、目录结构

```
src/response-system/
│
├── registry.ts                          # 响应模式注册表
├── router.ts                            # 响应模式路由器
├── types.ts                             # 公共类型定义
├── index.ts                             # 公共 API 导出
├── README.md                            # 响应系统总览
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
    │   ├── config-schema.json
    │   └── README.md
    │
    ├── dual-session/                  # 双会话模式（原 dual-session-lite）
    │   ├── index.ts
    │   ├── config-schema.json
    │   └── README.md
    │
    └── workflow/                      # 工作流模式（未来）
        ├── index.ts
        ├── config-schema.json
        └── README.md
```

---

## 七、注册表设计

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

## 八、ECK 集成

### 8.1 ECK Vars

```typescript
interface ECKVars {
  // 当前响应模式
  responseMode: 'single-session' | 'dual-session' | 'workflow';
  
  // 通用参数（从 config 中提取）
  chatMode: 'interactive' | 'proactive';
  mentionMode: 'disabled' | 'mention-only' | 'fast-track';
  
  // dual-session 特有
  sessionType?: 'auxiliary' | 'main';
  
  // 其他参数
  chatType: 'private' | 'group' | null;
  channel: string;
  selfAid: string;
  peerId: string;
  // ...
}
```

### 8.2 Context Assembly Manifest

```yaml
sections:
  # 辅助会话提示词（dual-session 特有）
  - id: auxiliary-session-prompt
    when: "responseMode === 'dual-session' && sessionType === 'auxiliary'"
    source:
      type: file
      path: "$KITS/docs/response-system/dual-session/prompts/auxiliary-base.md"
  
  # 主会话提示词（dual-session 特有）
  - id: main-session-prompt
    when: "responseMode === 'dual-session' && sessionType === 'main'"
    source:
      type: file
      path: "$KITS/docs/response-system/dual-session/prompts/main-base.md"
  
  # chatMode 说明（所有模式通用）
  - id: chat-mode-guide-proactive
    when: "chatMode === 'proactive'"
    content: |
      ## 回复方式
      使用 CLI 命令发送回复。
  
  - id: chat-mode-guide-interactive
    when: "chatMode === 'interactive'"
    content: |
      ## 回复方式
      直接输出即回复。
  
  # mentionMode 说明（所有模式通用）
  - id: mention-mode-guide
    when: "mentionMode === 'mention-only'"
    content: |
      ## Mention 策略
      当前启用 mention-only 模式，只处理被 @ 的消息。
```

---

## 九、迁移方案

### 9.1 旧配置 → 新配置映射

```typescript
function migrateConfig(oldConfig: any): ResponseModeConfig {
  // 旧的 responseMode 映射
  if (oldConfig.responseMode === 'interactive') {
    return {
      responseMode: 'single-session',
      config: {
        chatMode: 'interactive',
        ...oldConfig.config,
      },
    };
  }
  
  if (oldConfig.responseMode === 'proactive') {
    return {
      responseMode: 'single-session',
      config: {
        chatMode: 'proactive',
        ...oldConfig.config,
      },
    };
  }
  
  if (oldConfig.responseMode === 'dual-session-lite') {
    return {
      responseMode: 'dual-session',
      config: oldConfig.config,
    };
  }
  
  // 已经是新格式
  return oldConfig;
}
```

### 9.2 文档迁移

| 旧路径 | 新路径 | 操作 |
|--------|--------|------|
| `docs/response-system/dual-session-lite/` | `docs/response-system/dual-session/` | 重命名目录 |
| 文档中的 `dual-session-lite` | `dual-session` | 批量替换 |
| `responseMode: 'dual-session-lite'` | `responseMode: 'dual-session'` | 批量替换 |

---

## 十、总结

### 核心设计

1. **响应模式参数**：`responseMode`（`single-session` / `dual-session` / `workflow`）
2. **通用参数**：`chatMode`, `mentionMode`, `model`
3. **特有参数**：各响应模式各自定义

### 当前响应模式

| 模式 | 引擎 | 通用参数 | 特有参数 |
|------|------|---------|---------|
| `single-session` | V1 | ✅ 全部支持 | 无 |
| `dual-session` | V2 | ✅ 全部支持 | 7 个（队列/压缩/打断） |

### 设计优势

✅ **概念清晰**：响应模式 + 通用参数 + 特有参数  
✅ **参数正交**：chatMode/mentionMode 是参数，不是模式  
✅ **无组合爆炸**：新增模式不需要创建多个变体  
✅ **易于扩展**：新模式继承通用参数，定义特有参数  
✅ **配置直观**：用户只选模式，配置参数  

---

**文档维护者**: Claude Code (Opus 4.8)  
**最后更新**: 2026-07-08  
**状态**: ✅ 架构定稿
