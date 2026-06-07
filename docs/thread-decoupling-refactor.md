# EvolClaw 话题逻辑解耦重构方案

## 一、改造初衷

### 1.1 当前问题

EvolClaw 的话题（Thread）模块设计过度耦合 Feishu 渠道，存在以下问题：

1. **全局参数污染**：`threadId` 作为全局参数在核心层（Session、Message、CommandHandler）传递
2. **渠道耦合**：话题逻辑散落在 `index.ts`、`MessageProcessor`、`CommandHandler` 中，与 Feishu 强耦合
3. **扩展性差**：其他渠道（WeChat、Slack）无法复用话题机制
4. **职责不清**：`index.ts` 承担了消息路由、渠道特异化处理、主人绑定等多重职责
5. **代码重复**：主人绑定逻辑在三个渠道中重复实现

### 1.2 改造目标

1. **解耦话题逻辑**：将 `threadId` 从全局参数降级为可选的会话扩展维度
2. **渠道无关化**：核心层不感知具体渠道的特异化逻辑
3. **统一主人管理**：创建 OwnerManager 统一处理主人绑定
4. **规范队列 key**：通过 `SessionManager.getQueueKey()` 统一生成队列 key
5. **提升可维护性**：职责清晰，易于扩展新渠道

---

## 二、设计原则

### 2.1 核心原则

1. **单一职责原则**：每个模块只负责一件事
2. **开闭原则**：对扩展开放，对修改封闭
3. **依赖倒置原则**：依赖抽象而非具体实现
4. **最小改动原则**：保留现有逻辑，只改变参数传递方式

### 2.2 架构分层

```
┌─────────────────────────────────────────┐
│           index.ts (主入口)              │
│  - 初始化组件                            │
│  - 连接渠道                              │
│  - 消息路由                              │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         OwnerManager (主人管理)          │
│  - 自动绑定主人                          │
│  - 权限检查                              │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│      Channel Layer (渠道层)              │
│  - FeishuChannel: 处理 Feishu 特异化    │
│  - WechatChannel: 处理 WeChat 特异化    │
│  - AUNChannel: 处理 AUN 特异化          │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│       Core Layer (核心层)                │
│  - SessionManager: 会话管理              │
│  - MessageProcessor: 消息处理            │
│  - CommandHandler: 命令处理              │
│  - MessageQueue: 消息队列                │
└─────────────────────────────────────────┘
```

---

## 三、改造策略

### 3.1 话题参数传递策略

**当前方案**：
```typescript
// threadId 作为全局参数
Message.threadId: string
CommandHandler(content, channel, channelId, userId, threadId)
SessionManager.getOrCreateSession(channel, channelId, path, threadId, metadata, name)
```

**新方案**：
```typescript
// threadId 通过 options 对象传递
Message.metadata: Record<string, any>  // { feishu: { threadId, rootId } }
CommandHandler(content, channel, channelId, userId, options?)
SessionManager.getOrCreateSession(channel, channelId, path, options?)
```

**优势**：
- threadId 不再是必传参数，而是可选的扩展维度
- 其他渠道可以使用相同机制（如 WeChat 群聊子话题）
- 类型安全，通过 options 对象传递，避免参数列表过长

### 3.2 队列 key 生成策略

**当前方案**：
```typescript
// 话题：session.id
// 主会话：`${channel}-${channelId}`
// 散落在 index.ts 中
```

**新方案**：
```typescript
// 统一通过 SessionManager.getQueueKey() 获取
SessionManager.getQueueKey(session): string {
  return session.threadId ? session.id : `${session.channel}-${session.channelId}`;
}
```

**优势**：
- 规则集中管理，易于维护
- 主会话 key 稳定，不受项目切换影响
- 话题会话隔离，互不干扰

### 3.3 主人绑定策略

**当前方案**：
```typescript
// 在 index.ts 中每个渠道重复实现
if (userId && !config.channels?.feishu?.owner) {
  setOwner(config, 'feishu', userId);
}
```

**新方案**：
```typescript
// 统一通过 OwnerManager 处理
const ownerManager = new OwnerManager(config);
await ownerManager.autoBindOwner('feishu', userId, userName);
```

**优势**：
- 消除代码重复
- 职责清晰，易于扩展（如多主人、权限分级）
- 易于测试

---

## 四、主要改造模块

### 4.1 新增模块

#### OwnerManager (`src/utils/owner-manager.ts`)

**职责**：统一管理主人绑定和权限检查

**核心方法**：
- `autoBindOwner(channel, userId, userName?)`: 自动绑定主人
- `isOwner(channel, userId)`: 检查是否为主人

### 4.2 修改模块

#### SessionManager (`src/core/session-manager.ts`)

**新增方法**：
- `getQueueKey(session)`: 获取会话的队列 key
- `hasSession(channel, channelId, threadId)`: 检查话题会话是否存在

**修改方法**：
- `getOrCreateSession()`: 参数改为 options 对象

#### Message 类型 (`src/types.ts`)

**修改**：
- 删除 `threadId: string`
- 新增 `metadata?: Record<string, any>`

#### CommandHandler 类型 (`src/types.ts`)

**修改**：
- 参数从 `threadId?: string` 改为 `options?: { threadId?: string; metadata?: Record<string, any> }`

#### MessageProcessor (`src/core/message-processor.ts`)

**修改**：
- 从 `message.metadata` 提取 `threadId`
- 调用 `commandHandler` 和 `getOrCreateSession` 时传递 options

#### CommandHandler (`src/core/command-handler.ts`)

**修改**：
- `handle()` 方法参数改为 options
- `ensureSession()` 方法参数改为 options
- `getQueueKey()` 委托给 SessionManager

#### FeishuChannel (`src/channels/feishu.ts`)

**修改**：
- 删除 `hasThreadSession()` 方法（越权访问 sessions 表）
- 新增 `setSessionManager()` 方法
- 话题检测改用 `SessionManager.hasSession()`

#### index.ts (`src/index.ts`)

**修改**：
- 初始化 OwnerManager
- 三个渠道统一使用 `ownerManager.autoBindOwner()`
- 三个渠道统一使用 `sessionManager.getQueueKey()`
- Message 携带 metadata 而非 threadId

---

## 五、详细方案

### 5.1 OwnerManager 实现

```typescript
// src/utils/owner-manager.ts
export class OwnerManager {
  constructor(private config: Config) {}

  async autoBindOwner(channel: string, userId: string, userName?: string): Promise<boolean> {
    const currentOwner = this.config.channels?.[channel]?.owner;
    if (currentOwner) return false;

    const { setOwner } = await import('../config.js');
    setOwner(this.config, channel, userId);

    const displayName = userName ? `${userName} (${userId})` : userId;
    logger.info(`[Owner] Auto-bound ${channel} owner: ${displayName}`);
    return true;
  }

  isOwner(channel: string, userId: string): boolean {
    return this.config.channels?.[channel]?.owner === userId;
  }
}
```

### 5.2 SessionManager 新增方法

```typescript
// src/core/session-manager.ts

/**
 * 获取会话的队列 key
 * - 话题会话：使用 session.id（唯一且不变）
 * - 主会话：使用 channel-channelId（稳定，不受项目切换影响）
 */
getQueueKey(session: Session): string {
  return session.threadId
    ? session.id
    : `${session.channel}-${session.channelId}`;
}

/**
 * 检查话题会话是否存在
 */
hasSession(channel: string, channelId: string, threadId: string): boolean {
  const row = this.db.prepare(
    'SELECT 1 FROM sessions WHERE channel = ? AND channel_id = ? AND thread_id = ? LIMIT 1'
  ).get(channel, channelId, threadId);
  return !!row;
}

/**
 * 获取或创建会话（参数改为 options）
 */
async getOrCreateSession(
  channel: string,
  channelId: string,
  defaultProjectPath: string,
  options?: {
    threadId?: string;
    metadata?: any;
    name?: string;
  }
): Promise<Session> {
  const threadId = options?.threadId;
  const metadata = options?.metadata;
  const name = options?.name;

  // 话题会话逻辑
  if (threadId) {
    return this.getOrCreateThreadSession(
      channel, channelId, threadId, defaultProjectPath, metadata, name
    );
  }

  // 主会话逻辑（保持不变）
  // ...
}
```

### 5.3 类型定义修改

```typescript
// src/types.ts

export interface Message {
  channel: string;
  channelId: string;
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  timestamp?: number;
  userId?: string;
  userName?: string;
  messageId?: string;
  isGroup?: boolean;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;
  metadata?: Record<string, any>;  // 新增：渠道扩展数据
}

export type CommandHandler = (
  content: string,
  channel: string,
  channelId: string,
  userId?: string,
  options?: {
    threadId?: string;
    metadata?: Record<string, any>;
  }
) => Promise<string | null>;
```

### 5.4 index.ts 改造示例

```typescript
// src/index.ts

// 初始化 OwnerManager
const ownerManager = new OwnerManager(config);

// Feishu 消息处理
feishu.onMessage(async ({ channelId, content, threadId, rootId, userId, userName, ... }) => {
  // 自动绑定主人
  if (userId) {
    await ownerManager.autoBindOwner('feishu', userId, userName);
  }

  // 构造 options（Feishu 特异化）
  const options = (threadId || rootId) ? {
    threadId,
    metadata: { feishu: { threadId, rootId } }
  } : undefined;

  // 命令处理
  if (cmdHandler.isCommand(content)) {
    const cmdResult = await cmdHandler.handle(content, 'feishu', channelId, undefined, userId, options);
    // ...
  }

  // 获取会话
  const session = await sessionManager.getOrCreateSession(
    'feishu', channelId, defaultPath, options
  );

  // 获取队列 key
  const queueKey = sessionManager.getQueueKey(session);

  // 入队
  await messageQueue.enqueue(queueKey, {
    channel: 'feishu',
    channelId,
    content,
    metadata: options?.metadata
  }, session.projectPath);
});
```

---

## 六、实施计划

### 6.1 阶段划分

#### 阶段 1：基础设施（1-2 小时）
- [ ] 创建 `src/utils/owner-manager.ts`
- [ ] SessionManager 新增 `getQueueKey()` 和 `hasSession()`
- [ ] 修改类型定义（Message、CommandHandler）

#### 阶段 2：核心层改造（2-3 小时）
- [ ] MessageProcessor 改造（提取 threadId、传递 options）
- [ ] CommandHandler 改造（参数改为 options、委托 getQueueKey）
- [ ] FeishuChannel 改造（删除 hasThreadSession、新增 setSessionManager）

#### 阶段 3：入口层改造（1-2 小时）
- [ ] index.ts 初始化 OwnerManager
- [ ] Feishu 消息处理改造
- [ ] WeChat 消息处理改造
- [ ] AUN 消息处理改造

#### 阶段 4：测试验证（2-3 小时）
- [ ] 主会话消息收发测试
- [ ] 话题会话消息收发测试
- [ ] 命令在主会话和话题中的行为测试
- [ ] 项目切换后队列 key 稳定性测试
- [ ] 首次交互自动绑定主人测试

### 6.2 风险控制

| 风险 | 级别 | 应对措施 |
|------|------|----------|
| 类型签名变更导致编译错误 | 低 | TypeScript 编译时检查 |
| metadata 传递链路遗漏 | 中 | 关键节点打日志验证 |
| hasThreadSession 替换 | 低 | 功能等价，单元测试覆盖 |
| 队列 key 生成错误 | 中 | 单元测试 + 集成测试 |

### 6.3 回滚方案

- 所有改动通过 Git 管理
- 每个阶段完成后提交一次
- 如遇问题可快速回滚到上一阶段

---

## 七、预期收益

### 7.1 架构收益

1. **解耦渠道逻辑**：核心层不再感知 Feishu 特异化逻辑
2. **提升扩展性**：其他渠道可复用话题机制
3. **职责清晰**：每个模块职责单一，易于维护
4. **代码复用**：消除主人绑定的重复代码

### 7.2 开发收益

1. **易于测试**：OwnerManager、getQueueKey 可独立测试
2. **易于调试**：队列 key 生成规则集中管理
3. **易于扩展**：添加新渠道只需实现消息处理逻辑

### 7.3 维护收益

1. **降低认知负担**：参数传递方式统一
2. **减少 Bug 风险**：队列 key 生成不会出错
3. **提升代码质量**：符合 SOLID 原则

---

## 八、不改动的部分

为了最小化改动风险，以下部分保持不变：

1. **Session.threadId 字段**：保留在 Session 模型中
2. **数据库 thread_id 列**：保留唯一索引
3. **getOrCreateThreadSession() 方法**：内部逻辑不变
4. **isBackgroundSession() 逻辑**：仍用 `session.threadId` 判断
5. **话题会话的 projectPath 继承**：逻辑不变

---

## 九、总结

本次重构的核心目标是**将话题逻辑从全局参数解耦，改为可选的会话扩展维度**，同时**统一主人管理和队列 key 生成规则**。

通过引入 OwnerManager 和 SessionManager.getQueueKey()，实现了：
- 渠道无关化
- 职责清晰化
- 代码复用化
- 易于扩展化

改动范围可控，风险可控，预期收益明显。
