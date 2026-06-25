# EvolClaw 三层模块化重构方案

## 一、改造初衷

### 1.1 当前问题

EvolClaw 当前是一个"飞书+Claude 的 bot"，三个核心层——Channel（渠道）、Gateway（网关）、Agent Runner（执行器）——边界模糊，互相渗透：

1. **Channel 越权访问 Gateway**：飞书渠道直接查询 sessions 表判断话题会话是否存在
2. **Gateway 耦合 Channel 细节**：MessageProcessor 里有飞书特有的 rootId 处理逻辑
3. **Gateway 耦合 Agent 实现**：MessageProcessor 硬编码了 Claude SDK 的事件类型（text_delta、assistant、result）
4. **index.ts 职责混乱**：同时承担 Channel 适配、Gateway 路由、Agent 初始化，三层胶水代码混在一起
5. **Agent Runner 不可替换**：当前只支持 Claude SDK，没有抽象接口

### 1.2 改造目标

将 EvolClaw 从一个单体 bot 重构为**可组合的 Agent 网关框架**，实现：

1. **模块独立**：Channel、Gateway、Agent Runner 各自有清晰的接口边界
2. **可自由组合**：Slack + Gemini、飞书 + Codex、微信 + DeepAgent 等任意组合
3. **可独立使用**：第三方可以只用 Channel 层或只用 Agent Runner 层
4. **可嵌入集成**：Gateway 可以作为独立模块被第三方系统引用

### 1.3 设计原则

1. **单一职责**：每层只负责一件事，不越界
2. **依赖倒置**：依赖抽象接口，不依赖具体实现
3. **开闭原则**：对扩展开放（添加新 Channel/Agent），对修改封闭（核心逻辑不变）
4. **最小知识**：每层只知道自己需要知道的，不感知其他层的内部细节

---

## 二、三层职责划分

### 2.1 Channel 层（渠道层）

**核心职责**：连接外部平台，收发消息。

**关键原则**：
- Channel 不知道"会话"、"命令"、"Agent"的概念
- Channel 只知道"我连着飞书/微信/Slack"、"这个 chatId 是群聊"
- Channel 把平台消息标准化后交给 Gateway，把 Gateway 的回复通过平台送达用户

**能力分类**：

1. **基础能力**（必须实现）：
   - 发送文本消息
   - 接收消息并回调

2. **扩展能力**（按平台能力选择实现）：
   - 消息确认（acknowledge）：飞书用表情回复，微信用 typing 状态
   - 发送文件
   - 群聊检测

3. **回复定位**：
   - Gateway 传递 `ReplyContext`（sessionId + threadId + metadata）
   - Channel 从 metadata 提取渠道特有信息（飞书的 rootId、微信的 context_token）
   - Gateway 不参与这个过程，完全不知道 rootId 是什么

4. **消息形态适配**：
   - Gateway 决定"发什么内容"，Channel 决定"怎么发"
   - 同样的超时警告，飞书可能用卡片+emoji，微信用纯文本，Slack 用 block

5. **事件订阅**：
   - Channel 订阅 Gateway 的事件（安全模式、超时、任务完成等）
   - Channel 自行决定如何呈现这些事件

### 2.2 Gateway 层（网关层）

**核心职责**：会话管理、消息队列、命令处理、事件发布、消息路由。

**关键原则**：
- Gateway 知道"这条消息属于哪个会话"、"这个会话绑定了哪个 Agent"、"用户发了一个命令"
- Gateway 不知道飞书的 rootId、微信的 context_token、Claude SDK 的 API 细节
- Gateway 通过标准接口与 Channel 和 Agent Runner 交互

**核心组件**：

1. **SessionManager**：
   - 会话的创建、查找、切换、持久化
   - 会话身份（SessionIdentity）管理
   - 队列 key 生成（`getQueueKey()`）
   - 会话存在性检查（`hasSession()`）

2. **MessageQueue**：
   - 按会话串行处理消息
   - 支持消息中断

3. **CommandHandler**：
   - 斜杠命令的解析和执行
   - 权限检查（基于 SessionIdentity）

4. **EventBus**：
   - 对外发布事件（会话创建、安全模式、超时、任务完成等）
   - 提供标准订阅接口

5. **AgentRunnerRegistry**：
   - 注册多个 Agent Runner
   - 根据 `session.agentType` 路由到对应的 runner

**会话身份（SessionIdentity）**：

```
interface SessionIdentity {
  role: 'owner' | 'guest' | 'anonymous';  // 用户角色（可变）
  mode: 'interactive' | 'autonomous';      // 交互模式（不可变）
}
```

- **role**：
  - Owner：主人，完全权限
  - Guest：客人，受限权限
  - Anonymous：匿名/未识别用户
  - 可变：用户可以从 anonymous 升级到 guest 或 owner

- **mode**：
  - Interactive：用户主动发起的对话
  - Autonomous：Agent 自主运行（定时任务、事件触发、自愈修复等）
  - 不可变：会话创建时确定，后续不变

- **会话类型**：由 `Session.threadId` 决定（空字符串=主会话，非空=话题会话）
- **聊天上下文**：dm/group 是 Channel 层信息，通过 `Message.isGroup` 传递，不存到 Session

**消息展示控制**：
- Gateway 决策"发不发"和"发什么内容"（基于 SessionIdentity、会话状态、配置策略）
- Channel 决策"怎么发"（消息形态适配）

### 2.3 Agent Runner 层（执行层）

**核心职责**：与具体的 AI 后端交互。

**关键原则**：
- Agent Runner 接收标准化的查询请求，返回标准化的事件流
- Agent Runner 不知道消息从哪个渠道来，也不知道会话是怎么管理的
- 不同 Agent（Claude、Gemini、Codex）实现相同的接口

**标准接口**：

```
interface AgentRunnerInterface {
  runQuery(request: QueryRequest): AsyncIterable<AgentEvent>;
  interrupt(sessionKey: string): Promise<void>;
  setModel?(model: string): void;
}
```

**标准事件流**：

基于 ACP 协议和 Claude SDK 的能力，定义通用事件类型：

- `text`：文本增量（streaming）
- `tool_use`：工具调用开始
- `tool_result`：工具执行结果
- `artifact`：生成的文件/代码片段
- `progress`：进度通知（可选，用于长任务）
- `complete`：任务完成
- `error`：错误

不同 Agent 按自身能力发送事件：
- Claude：支持全部事件类型
- Gemini CLI：可能只有 text + complete
- Codex：可能有 text + artifact + complete

Gateway 按统一格式消费，不关心具体 Agent 的差异。

---

## 三、关键设计决策

### 3.1 回复上下文传递

**问题**：Gateway 告诉 Channel "这条回复发到哪里"，传什么？

**方案**：传递轻量的 `ReplyContext`，而不是整个 Session 对象。

```
interface ReplyContext {
  sessionId: string;
  threadId?: string;
  metadata?: Record<string, any>;
}
```

- Gateway 不知道 metadata 里有什么，只负责透传
- Channel 从 metadata 提取自己需要的信息（飞书提取 rootId，微信提取 context_token）
- 避免 Channel 依赖 Gateway 的 Session 类型

### 3.2 多 Agent Runner 路由

**问题**：Gateway 怎么根据 `session.agentType` 选择对应的 Agent Runner？

**方案**：Gateway 内部维护 `AgentRunnerRegistry`。

- 初始化时注册各个 Agent Runner：`registry.register('claude', claudeRunner)`
- 使用时查找：`registry.get(session.agentType)`
- 添加新 Agent 只需实现接口并注册，不用改 Gateway 核心逻辑

### 3.3 事件系统边界

**问题**：Gateway 的事件系统是进程内还是跨进程？

**方案**：Gateway 对外提供事件发布服务，任何外部系统都可以订阅。

- Gateway 暴露标准订阅接口：`subscribe(eventType, handler)`
- Channel 订阅事件并决定如何呈现
- restart-monitor 订阅 `system:restart-complete` 发送通知
- 第三方系统可以订阅任何感兴趣的事件
- 实现上使用 EventEmitter（进程内），但接口设计为可扩展到跨进程

### 3.4 队列 key 生成

**问题**：消息队列的 key 怎么生成？

**方案**：由 SessionManager 统一管理。

- 提供 `getQueueKey(session)` 方法
- 话题会话：使用 `session.id`（唯一且不变）
- 主会话：使用 `channel-channelId`（稳定，不受项目切换影响）
- 规则集中在一处，易于维护

### 3.5 Agent 事件流标准化

**问题**：不同 Agent 的能力差异很大，标准格式要抽象到什么粒度？

**方案**：定义核心事件类型，Agent 按自身能力发送。

- 核心事件：text、tool_use、tool_result、complete、error
- 扩展事件：artifact、progress（可选）
- Gateway 按统一格式消费，不关心 Agent 是否支持所有事件
- 对齐 ACP 协议的 Message 结构（role + parts）

---

## 四、接口设计

### 4.1 Channel 接口

```
interface ChannelAdapter {
  readonly name: string;

  // 基础能力
  sendText(channelId: string, text: string, context?: ReplyContext): Promise<void>;
  onMessage(handler: MessageHandler): void;

  // 扩展能力（可选）
  sendFile?(channelId: string, filePath: string, context?: ReplyContext): Promise<void>;
  acknowledge?(messageId: string): Promise<void>;
  isGroupChat?(channelId: string): Promise<boolean>;
}

interface ReplyContext {
  sessionId: string;
  threadId?: string;
  metadata?: Record<string, any>;
}
```

### 4.2 Gateway 接口

```
interface GatewayEventBus {
  subscribe(eventType: string, handler: EventHandler): void;
  unsubscribe(eventType: string, handler: EventHandler): void;
}

interface SessionIdentity {
  role: 'owner' | 'guest' | 'anonymous';
  mode: 'interactive' | 'autonomous';
}

interface SessionManager {
  getOrCreateSession(...): Promise<Session>;
  getQueueKey(session: Session): string;
  hasSession(channel: string, channelId: string, threadId: string): boolean;
  // ... 其他方法
}
```

### 4.3 Agent Runner 接口

```
interface AgentRunnerInterface {
  runQuery(request: QueryRequest): AsyncIterable<AgentEvent>;
  interrupt(sessionKey: string): Promise<void>;
  setModel?(model: string): void;
}

interface QueryRequest {
  sessionId: string;
  prompt: string;
  projectPath: string;
  agentSessionId?: string;
  images?: ImageData[];
  systemPromptAppend?: string;
}

type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolName: string; input: any }
  | { type: 'tool_result'; toolName: string; result: any }
  | { type: 'artifact'; name: string; content: string }
  | { type: 'progress'; message: string; percent?: number }
  | { type: 'complete'; result: string }
  | { type: 'error'; error: string };
```

---

## 五、事件系统设计

### 5.1 事件类型

**会话事件**：
- `session:created` - 会话创建
- `session:switched` - 项目切换
- `session:safe-mode-entered` - 进入安全模式
- `session:safe-mode-exited` - 退出安全模式
- `session:timeout` - 会话超时

**Agent 事件**：
- `agent:task-start` - 任务开始
- `agent:task-complete` - 任务完成
- `agent:task-error` - 任务错误

**系统事件**：
- `system:restart-complete` - 系统重启完成
- `system:compact-start` - 会话压缩开始

### 5.2 事件订阅示例

**Channel 订阅**：
```
gateway.eventBus.subscribe('session:safe-mode-entered', (event) => {
  // 飞书：发送带操作按钮的卡片
  // 微信：发送纯文本提示
  // Slack：发送带 action 的 block
});
```

**restart-monitor 订阅**：
```
gateway.eventBus.subscribe('system:restart-complete', (event) => {
  // 通过 Channel 发送通知
});
```

---

## 六、迁移策略

### 6.1 迁移原则

**直接重构，不考虑向后兼容**：
- 数据库 schema 保持不变（Session 表结构已经够用）
- 只改代码层的接口和调用关系
- 一次性完成，不做渐进式迁移

### 6.2 数据保留

**保留**：
- sessions 表结构（增加 identity 字段）
- JSONL 会话文件（Agent Runner 层继续使用）
- 配置文件格式（config.json）

**不保留**：
- 旧的接口签名
- 旧的调用关系
- 旧的事件处理逻辑

---

## 七、预期收益

### 7.1 架构收益

1. **模块独立**：Channel、Gateway、Agent Runner 可以独立开发、测试、部署
2. **可自由组合**：任意 Channel + 任意 Agent 的组合
3. **可独立使用**：第三方可以只用某一层
4. **易于扩展**：添加新 Channel 或新 Agent 不影响其他层

### 7.2 开发收益

1. **职责清晰**：每层只关心自己的事情，认知负担降低
2. **易于测试**：每层可以独立测试，不需要启动整个系统
3. **易于调试**：问题定位更快，边界清晰

### 7.3 生态收益

1. **第三方集成**：其他 bot 框架可以使用 EvolClaw 的 Gateway
2. **Agent 生态**：支持多种 Agent 后端，不绑定 Claude
3. **Channel 生态**：支持更多消息平台，不限于飞书和微信

---

## 八、实施计划

### 8.1 阶段划分

**阶段 1：接口定义**
- 定义 Channel、Gateway、Agent Runner 的标准接口
- 定义事件类型和事件系统接口
- 定义 SessionIdentity 和 ReplyContext

**阶段 2：Agent Runner 层重构**
- 抽象 AgentRunnerInterface
- 重构 ClaudeRunner 实现标准接口
- 实现 AgentRunnerRegistry

**阶段 3：Gateway 层重构**
- SessionManager 增加 identity、getQueueKey、hasSession
- 实现 EventBus
- MessageProcessor 改为消费标准事件流
- CommandHandler 基于 SessionIdentity 做权限检查

**阶段 4：Channel 层重构**
- Channel 接口标准化（sendText 接收 ReplyContext）
- Channel 订阅 Gateway 事件
- 移除 Channel 对 Gateway 内部的越权访问

**阶段 5：index.ts 重构**
- 职责分离：只做初始化和连接
- 移除渠道特有的消息预处理逻辑
- 移除主人绑定的重复代码

**阶段 6：测试验证**
- 单元测试：每层独立测试
- 集成测试：端到端测试
- 多 Agent 测试：切换不同 Agent 验证

### 8.2 风险控制

| 风险 | 级别 | 应对措施 |
|------|------|----------|
| 接口设计不合理 | 高 | 先定义接口，review 后再实施 |
| 事件系统性能问题 | 中 | 使用成熟的 EventEmitter 库 |
| Agent 事件流不兼容 | 中 | 定义最小公共集，扩展事件可选 |
| 数据迁移失败 | 低 | 数据库 schema 不变，只改代码 |

---

## 九、总结

本次重构的核心目标是**将 EvolClaw 从单体 bot 重构为可组合的 Agent 网关框架**。通过清晰的三层职责划分、标准化的接口设计、事件驱动的解耦架构，实现模块独立、可自由组合、可独立使用、可嵌入集成。

改动范围大，但收益明显：架构清晰、易于扩展、生态友好。
