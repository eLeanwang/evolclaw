# EvolClaw 模块架构设计

## 架构概览

EvolClaw 采用分层模块化架构，从下到上分为：基础设施层、核心服务层、渠道适配层、应用层。

```
┌─────────────────────────────────────────────────────────┐
│                      应用层 (App)                         │
│                   Main Orchestrator                      │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                  渠道适配层 (Channels)                     │
│         FeishuChannel  │  ACPChannel  │  [Future]        │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                  核心服务层 (Core Services)                │
│   SessionManager  │  AgentRunner  │  MessageRouter      │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                  基础设施层 (Infrastructure)               │
│   Database  │  FileSystem  │  Config  │  Logger         │
└─────────────────────────────────────────────────────────┘
```

## 模块详细设计

### 1. 基础设施层 (Infrastructure)

#### 1.1 Database Module
**职责**：数据持久化
**文件**：`src/infrastructure/database.ts`
**接口**：
```typescript
interface IDatabase {
  init(): void;
  query<T>(sql: string, params: any[]): T[];
  execute(sql: string, params: any[]): void;
  close(): void;
}
```

#### 1.2 FileSystem Module
**职责**：文件系统操作
**文件**：`src/infrastructure/filesystem.ts`
**接口**：
```typescript
interface IFileSystem {
  ensureDir(path: string): void;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
}
```

#### 1.3 Config Module
**职责**：配置加载与验证
**文件**：`src/infrastructure/config.ts`
**接口**：
```typescript
interface IConfigLoader {
  load(path: string): Config;
  validate(config: Config): boolean;
  get<T>(key: string): T;
}
```

#### 1.4 Logger Module
**职责**：日志记录
**文件**：`src/infrastructure/logger.ts`
**接口**：
```typescript
interface ILogger {
  info(message: string, meta?: any): void;
  error(message: string, error?: Error): void;
  debug(message: string, meta?: any): void;
}
```

### 2. 核心服务层 (Core Services)

#### 2.1 SessionManager
**职责**：会话生命周期管理
**文件**：`src/core/session-manager.ts`
**依赖**：Database, FileSystem
**接口**：
```typescript
interface ISessionManager {
  getOrCreate(channel: string, channelId: string): Promise<Session>;
  update(sessionId: string, updates: Partial<Session>): Promise<void>;
  delete(sessionId: string): Promise<void>;
  bindProject(sessionId: string, projectPath: string): Promise<void>;
}
```

**数据模型**：
```typescript
interface Session {
  id: string;
  channel: 'feishu' | 'acp';
  channelId: string;
  projectPath: string;
  claudeSessionId?: string;
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}
```

#### 2.2 AgentRunner
**职责**：Claude Agent SDK 封装与执行
**文件**：`src/core/agent-runner.ts`
**依赖**：FileSystem, Logger
**接口**：
```typescript
interface IAgentRunner {
  query(sessionId: string, prompt: string, options: QueryOptions): Promise<AgentResponse>;
  stream(sessionId: string, prompt: string, options: QueryOptions): AsyncIterator<StreamEvent>;
  closeSession(sessionId: string): Promise<void>;
}

interface QueryOptions {
  projectPath: string;
  claudeSessionId?: string;
  tools?: Tool[];
}

interface AgentResponse {
  text: string;
  newSessionId?: string;
  toolCalls?: ToolCall[];
}
```

#### 2.3 MessageRouter
**职责**：消息路由与分发
**文件**：`src/core/message-router.ts`
**依赖**：SessionManager, AgentRunner
**接口**：
```typescript
interface IMessageRouter {
  route(message: IncomingMessage): Promise<OutgoingMessage>;
  registerChannel(channel: IChannel): void;
}

interface IncomingMessage {
  channel: string;
  channelId: string;
  content: string;
  metadata?: Record<string, any>;
}

interface OutgoingMessage {
  channel: string;
  channelId: string;
  content: string;
  metadata?: Record<string, any>;
}
```

### 3. 渠道适配层 (Channels)

#### 3.1 IChannel 接口
**文件**：`src/channels/base.ts`
**定义**：
```typescript
interface IChannel {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  sendMessage(channelId: string, content: string): Promise<void>;
  isConnected(): boolean;
}

type MessageHandler = (channelId: string, content: string) => Promise<void>;
```

#### 3.2 FeishuChannel
**职责**：飞书 WebSocket 连接
**文件**：`src/channels/feishu.ts`
**实现**：`IChannel`
**特性**：
- WebSocket 长连接
- 消息去重
- 自动重连
- 富文本支持

#### 3.3 ACPChannel
**职责**：ACP 协议连接
**文件**：`src/channels/acp.ts`
**实现**：`IChannel`
**特性**：
- AID 身份管理
- P2P 会话
- 群组消息
- 心跳保活

### 4. 应用层 (App)

#### 4.1 Main Orchestrator
**职责**：应用启动与协调
**文件**：`src/index.ts`
**流程**：
```typescript
async function main() {
  // 1. 加载配置
  const config = configLoader.load();

  // 2. 初始化基础设施
  database.init();
  logger.init();

  // 3. 初始化核心服务
  const sessionManager = new SessionManager(database);
  const agentRunner = new AgentRunner(config.anthropic.apiKey);
  const messageRouter = new MessageRouter(sessionManager, agentRunner);

  // 4. 初始化渠道
  const feishu = new FeishuChannel(config.feishu);
  const acp = new ACPChannel(config.acp);

  // 5. 注册渠道到路由器
  messageRouter.registerChannel(feishu);
  messageRouter.registerChannel(acp);

  // 6. 连接所有渠道
  await Promise.all([
    feishu.connect(),
    acp.connect()
  ]);

  // 7. 优雅关闭
  process.on('SIGINT', shutdown);
}
```

## 数据流设计

### 消息处理流程

```
1. 消息接收
   FeishuChannel/ACPChannel.onMessage()
        ↓
2. 消息路由
   MessageRouter.route(IncomingMessage)
        ↓
3. 会话查找/创建
   SessionManager.getOrCreate(channel, channelId)
        ↓
4. Agent 执行
   AgentRunner.query(sessionId, prompt, options)
        ↓
5. 响应发送
   Channel.sendMessage(channelId, response)
```

### 会话绑定流程

```
1. 首次消息到达
        ↓
2. SessionManager 创建新会话
   - 生成 sessionId
   - 分配默认项目路径
   - 写入数据库
        ↓
3. AgentRunner 初始化 Claude 会话
   - 设置工作目录 (cwd)
   - 创建 .claude/ 目录
   - 返回 claudeSessionId
        ↓
4. SessionManager 更新会话
   - 保存 claudeSessionId
   - 后续消息复用此会话
```

## 扩展性设计

### 1. 新增渠道

实现 `IChannel` 接口即可：

```typescript
class TelegramChannel implements IChannel {
  name = 'telegram';

  async connect() { /* ... */ }
  async disconnect() { /* ... */ }
  onMessage(handler) { /* ... */ }
  async sendMessage(channelId, content) { /* ... */ }
  isConnected() { /* ... */ }
}

// 注册到路由器
messageRouter.registerChannel(new TelegramChannel(config.telegram));
```

### 2. 新增存储后端

实现 `IDatabase` 接口：

```typescript
class PostgresDatabase implements IDatabase {
  init() { /* ... */ }
  query<T>(sql, params) { /* ... */ }
  execute(sql, params) { /* ... */ }
  close() { /* ... */ }
}
```

### 3. 自定义 Agent 行为

通过 `QueryOptions` 传递自定义工具：

```typescript
const response = await agentRunner.query(sessionId, prompt, {
  projectPath: '/path/to/project',
  tools: [customTool1, customTool2]
});
```

## 目录结构

```
evolclaw/
├── src/
│   ├── infrastructure/
│   │   ├── database.ts
│   │   ├── filesystem.ts
│   │   ├── config.ts
│   │   └── logger.ts
│   ├── core/
│   │   ├── session-manager.ts
│   │   ├── agent-runner.ts
│   │   └── message-router.ts
│   ├── channels/
│   │   ├── base.ts
│   │   ├── feishu.ts
│   │   └── acp.ts
│   ├── types/
│   │   ├── config.ts
│   │   ├── session.ts
│   │   └── message.ts
│   └── index.ts
├── data/
│   ├── config.json
│   └── sessions.db
├── projects/
│   └── default/
│       └── .claude/
├── logs/
│   └── evolclaw.log
└── tests/
    ├── unit/
    └── integration/
```

## 依赖关系图

```
index.ts
  ├─→ MessageRouter
  │     ├─→ SessionManager
  │     │     └─→ Database
  │     └─→ AgentRunner
  │           └─→ FileSystem
  ├─→ FeishuChannel
  └─→ ACPChannel

所有模块 ─→ Logger
所有模块 ─→ Config
```

## 配置管理

### 分层配置

```typescript
interface Config {
  // 基础配置
  app: {
    name: string;
    version: string;
    env: 'development' | 'production';
  };

  // 服务配置
  anthropic: {
    apiKey: string;
    model?: string;
  };

  // 渠道配置
  channels: {
    feishu?: FeishuConfig;
    acp?: ACPConfig;
  };

  // 项目配置
  projects: {
    defaultPath: string;
    autoCreate: boolean;
    allowedPaths?: string[];
  };

  // 基础设施配置
  database: {
    type: 'sqlite' | 'postgres';
    path: string;
  };

  logging: {
    level: 'debug' | 'info' | 'error';
    file?: string;
  };
}
```

### 环境变量覆盖

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=...
ACP_DOMAIN=aid.pub
ACP_AGENT_NAME=evolclaw
```

## 错误处理策略

### 1. 渠道层错误
- 连接失败：自动重连（指数退避）
- 消息发送失败：重试 3 次
- 认证失败：记录日志并停止

### 2. 核心服务层错误
- 会话创建失败：返回错误消息
- Agent 执行超时：终止并清理
- 数据库错误：事务回滚

### 3. 基础设施层错误
- 配置加载失败：退出程序
- 文件系统错误：降级处理
- 日志写入失败：输出到 stderr

## 性能优化

### 1. 连接池
- 数据库连接池
- HTTP 客户端连接复用

### 2. 缓存
- 会话信息内存缓存（LRU）
- 配置热重载

### 3. 并发控制
- 单个会话串行处理
- 多会话并发处理
- 最大并发数限制

## 监控与可观测性

### 1. 指标
- 消息处理延迟
- Agent 执行时间
- 渠道连接状态
- 活跃会话数

### 2. 日志
- 结构化日志（JSON）
- 请求追踪 ID
- 错误堆栈

### 3. 健康检查
- `/health` 端点（可选）
- 渠道连接状态
- 数据库连接状态
