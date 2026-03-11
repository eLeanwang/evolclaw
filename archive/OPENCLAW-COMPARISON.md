# OpenClaw vs EvolClaw：Feishu、ACP 与会话处理对比

## 项目定位对比

| 维度 | OpenClaw | EvolClaw（设计方案） |
|------|----------|---------------------|
| **定位** | 多渠道 AI 网关系统 | 简化的双渠道 Gateway |
| **协议基础** | ACP (Agent Communication Protocol) | Claude Agent SDK |
| **渠道支持** | 8+ 平台（飞书、Telegram、Discord、Slack、WhatsApp、LINE、iMessage 等） | 2 个渠道（飞书、ACP） |
| **运行模式** | Agent / Gateway / TUI / RPC | Gateway（单一模式） |
| **配置方式** | 单一 JSON 配置文件（openclaw.json） | 分散配置（config.json + 数据库） |
| **Skills 生态** | 60+ 内置 Skills | 无（依赖 Claude Code 内置能力） |

---

## 一、Feishu 模块对比

### OpenClaw：配置驱动的渠道管理

**配置结构**（openclaw.json）：
```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "allowFrom": ["ou_xxx", "ou_yyy"],  // 白名单
      "encryptKey": "xxx",
      "verificationToken": "xxx"
    }
  }
}
```

**架构特点**：
- ✅ 配置文件驱动（所有配置集中在 openclaw.json）
- ✅ 白名单机制（`allowFrom` 控制允许的群组/用户）
- ✅ 加密支持（`encryptKey` 用于消息加密）
- ✅ 验证令牌（`verificationToken` 用于 Webhook 验证）
- ✅ 统一的渠道抽象（所有渠道遵循相同的配置模式）

**实现方式**：
- 基于 `@larksuiteoapi/node-sdk`
- 支持 WebSocket 长连接
- 消息通过统一的 Channel 接口处理
- 与 ACP 协议集成（飞书消息可转发到 ACP 网络）

**消息流**：
```
飞书消息 → Channel Handler → ACP Dispatch（可选）→ Agent 处理
```

---

### EvolClaw：简化的连接管理

**配置结构**（config.json）：
```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx"
  }
}
```

**架构特点**（当前设计）：
- ⚠️ 简化配置（仅 appId 和 appSecret）
- ❌ 无白名单机制
- ❌ 无加密支持
- ❌ 无验证令牌
- ⚠️ 独立的渠道实现（与 ACP 分离）

**实现方式**（设计方案）：
```typescript
// evolclaw/src/channels/feishu.ts
export class FeishuChannel implements IChannel {
  private client: lark.Client;
  private wsClient: lark.WSClient;

  async connect(): Promise<void> {
    this.wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
    });
    await this.wsClient.start({ eventDispatcher });
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      data: {
        receive_id: channelId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }
}
```

**消息流**：
```
飞书消息 → FeishuChannel → SessionManager → InstanceManager → Claude Code
```

---

### 关键差异总结

| 特性 | OpenClaw | EvolClaw |
|------|----------|----------|
| **配置复杂度** | 高（完整的渠道配置） | 低（仅基础凭据） |
| **白名单控制** | ✅ 支持 | ❌ 不支持 |
| **消息加密** | ✅ 支持 | ❌ 不支持 |
| **Webhook 验证** | ✅ 支持 | ❌ 不支持 |
| **与 ACP 集成** | ✅ 深度集成 | ❌ 独立实现 |
| **卡片消息** | ✅ 支持（通过配置） | ⚠️ 需自行实现 |
| **消息去重** | ✅ 内置 | ❌ 需自行实现 |
| **健康检查** | ✅ 内置 | ❌ 需自行实现 |

**OpenClaw 的优势**：
- 完整的生产级特性（白名单、加密、验证）
- 统一的渠道抽象（易于扩展新渠道）
- 与 ACP 协议深度集成

**EvolClaw 的优势**：
- 配置简单（快速启动）
- 独立实现（不依赖 ACP）
- 灵活性高（可自定义行为）

---

## 二、ACP 模块对比

### OpenClaw：原生 ACP 协议支持

**配置结构**（openclaw.json）：
```json
{
  "acp": {
    "dispatch": {
      "enabled": true
    }
  },
  "channels": {
    "acp": {
      "enabled": true,
      "agentName": "openclaw",
      "domain": "aid.pub",
      "ownerAid": "openclaw.aid.pub",
      "allowFrom": ["agent1.aid.pub", "agent2.aid.pub"],
      "agentMdPath": "/root/.openclaw/agent.md"
    }
  }
}
```

**架构特点**：
- ✅ 原生 ACP 协议实现（基于 `@agentclientprotocol/sdk`）
- ✅ AID 身份系统（X.509 数字证书）
- ✅ P2P 通信（Agent 间直接通信）
- ✅ 群组消息（50+ 群组操作）
- ✅ 值班调度（固定模式和轮换模式）
- ✅ 文件同步（公共文件双向同步）
- ✅ agent.md 描述文件（公开能力描述）

**核心能力**：

1. **身份管理**：
   - 创建、加载、导入、删除 AID
   - 支持访客身份
   - 证书存储在 `/root/.acp-storage/AIDs/{aid}/`

2. **P2P 通信**：
   - 基于 WebSocket 的实时双向消息
   - 会话创建和邀请机制
   - 消息路由通过 AP 服务器

3. **群组功能**：
   - 创建/加入/退出群组
   - 群消息广播
   - 成员管理
   - 管理员操作

4. **值班调度**：
   - 固定模式：指定 Agent 值班
   - 轮换模式：轮询或随机分配
   - 可配置班次时长和消息上限

**消息流**：
```
ACP 消息 → AP 服务器 → ACP Channel → Dispatch → Agent 处理
                                    ↓
                              其他 Agent（转发）
```

**ACP 存储结构**：
```
/root/.acp-storage/
└── AIDs/
    └── openclaw.aid.pub/
        ├── cert.pem          # 数字证书
        ├── private.key       # 私钥
        ├── agent.md          # 能力描述
        └── config.json       # AID 配置
```

---

### EvolClaw：基础 ACP 客户端

**配置结构**（config.json）：
```json
{
  "acp": {
    "domain": "aid.pub",
    "agentName": "evolclaw"
  }
}
```

**架构特点**（设计方案）：
- ⚠️ 基础 ACP 支持（仅客户端功能）
- ❌ 无 AID 身份管理
- ❌ 无 P2P 通信
- ❌ 无群组功能
- ❌ 无值班调度
- ❌ 无文件同步
- ⚠️ 简化的消息接收

**实现方式**（设计方案）：
```typescript
// evolclaw/src/channels/acp.ts
import { AgentCP } from 'acp-ts';

export class ACPChannel implements IChannel {
  private client: AgentCP;

  async connect(): Promise<void> {
    this.client = new AgentCP({
      domain: config.domain,
      agentName: config.agentName,
    });

    await this.client.connect();

    // 监听消息
    this.client.on('message', async (message) => {
      await this.handleMessage(message);
    });
  }

  private async handleMessage(message: any): Promise<void> {
    const session = await sessionManager.getOrCreateSession('acp', message.from);
    const result = await sessionQueue.enqueue(session.id, message.content);
    await this.client.sendMessage(message.from, result);
  }
}
```

**消息流**：
```
ACP 消息 → ACPChannel → SessionManager → InstanceManager → Claude Code
```

---

### 关键差异总结

| 特性 | OpenClaw | EvolClaw |
|------|----------|----------|
| **ACP 协议版本** | 完整实现 | 基础客户端 |
| **AID 身份** | ✅ 完整支持 | ❌ 不支持 |
| **P2P 通信** | ✅ 支持 | ❌ 不支持 |
| **群组功能** | ✅ 50+ 操作 | ❌ 不支持 |
| **值班调度** | ✅ 支持 | ❌ 不支持 |
| **文件同步** | ✅ 支持 | ❌ 不支持 |
| **agent.md** | ✅ 支持 | ❌ 不支持 |
| **消息路由** | ✅ 通过 AP 服务器 | ⚠️ 简化实现 |
| **证书管理** | ✅ X.509 证书 | ❌ 不支持 |

**OpenClaw 的优势**：
- 完整的 ACP 协议实现
- 支持 Agent 间通信（P2P + 群组）
- 去中心化身份（AID）
- 丰富的协作功能（值班调度、文件同步）

**EvolClaw 的优势**：
- 实现简单（无需证书管理）
- 配置简单（仅需域名和名称）
- 适合单向消息接收场景

**设计建议**：
- 如果只需接收 ACP 消息：当前设计足够
- 如果需要 Agent 间协作：建议完整实现 ACP 协议
- 如果需要去中心化身份：必须实现 AID 系统

---

## 三、会话处理对比

### OpenClaw：基于 ACP 的会话管理

**会话配置**（openclaw.json）：
```json
{
  "session": {
    "dmScope": "global"  // 'global' | 'per-channel'
  }
}
```

**会话模型**：

OpenClaw 的会话管理基于 ACP 协议的会话概念：

1. **ACP 会话**：
   - 每个 P2P 对话或群组对话是一个 ACP 会话
   - 会话 ID 由 ACP 协议生成
   - 会话数据存储在 `.acp-storage/` 目录

2. **dmScope 配置**：
   - `global`：所有私聊共享同一个 Agent 上下文
   - `per-channel`：每个私聊独立的 Agent 上下文

3. **会话持久化**：
   - ACP 会话数据由 ACP SDK 管理
   - Agent 上下文存储在 `memory/` 目录
   - 对话历史通过 ACP 协议同步

**架构特点**：
- ✅ 基于 ACP 协议的会话抽象
- ✅ 支持 P2P 和群组会话
- ✅ 会话数据自动同步
- ✅ 灵活的 dmScope 配置
- ✅ 与 ACP 身份系统集成

**会话生命周期**：
```
1. ACP 消息到达 → 提取 sessionId
2. 查询 ACP 会话数据
3. 加载 Agent 上下文（根据 dmScope）
4. Agent 处理消息
5. 更新 Agent 上下文
6. 通过 ACP 协议发送回复
```

**存储结构**：
```
/root/.openclaw/
├── memory/                    # Agent 记忆
│   ├── global/               # 全局记忆
│   └── sessions/             # 会话级记忆
├── .acp-storage/             # ACP 会话数据
│   └── sessions/
│       └── {sessionId}/
│           ├── messages.jsonl
│           └── metadata.json
└── workspace/                # 工作区
```

---

### EvolClaw：三层映射的会话管理

**会话模型**（设计方案）：

EvolClaw 采用三层映射架构：

```
渠道ID → EvolClaw会话ID → 项目路径 + Claude会话ID
```

**数据库结构**：
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- EvolClaw会话ID
  channel TEXT NOT NULL,            -- 'feishu' | 'acp'
  channel_id TEXT NOT NULL,         -- 渠道端会话ID
  project_path TEXT NOT NULL,       -- 项目路径
  claude_session_id TEXT,           -- Claude会话ID
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(channel, channel_id)
);
```

**架构特点**：
- ✅ 强制会话隔离（每个渠道会话独立）
- ✅ 项目路径绑定（可共享项目）
- ✅ Claude 会话持久化
- ✅ 独立的 Claude Code 实例
- ❌ 无跨会话通信

**会话生命周期**：
```
1. 渠道消息到达
2. SessionManager.getOrCreateSession(channel, channelId)
3. 查询数据库 → 获取 EvolClaw会话ID
4. InstanceManager.getOrCreateInstance(sessionId, projectPath)
5. 启动 Claude Code 实例（传入 claude_session_id）
6. 执行查询，获得 newSessionId
7. 更新数据库（保存 claude_session_id）
```

**存储结构**：
```
/data/
├── sessions.db               # 会话映射数据库
└── projects/
    └── {projectPath}/
        └── .claude/
            └── sessions/
                └── {claude_session_id}.jsonl
```

---

### 关键差异总结

| 维度 | OpenClaw | EvolClaw |
|------|----------|----------|
| **会话抽象** | ACP 会话 | 三层映射 |
| **会话隔离** | 可配置（dmScope） | 强制隔离 |
| **会话持久化** | ACP SDK 管理 | SQLite + .claude/ |
| **跨会话通信** | ✅ 支持（ACP 协议） | ❌ 不支持 |
| **会话同步** | ✅ 自动同步（ACP） | ❌ 本地存储 |
| **项目绑定** | ❌ 无（单一工作区） | ✅ 支持 |
| **实例管理** | 单一 Agent 实例 | 每会话独立实例 |
| **并发模型** | 单线程事件循环 | 多进程并发 |

**OpenClaw 的会话特点**：

1. **基于 ACP 协议**：
   - 会话由 ACP 协议管理
   - 支持跨 Agent 通信
   - 会话数据自动同步

2. **灵活的 dmScope**：
   - `global`：所有私聊共享上下文（适合个人助手）
   - `per-channel`：每个私聊独立上下文（适合多用户）

3. **单一 Agent 实例**：
   - 所有会话共享同一个 Agent 进程
   - 通过上下文切换处理不同会话
   - 资源效率高

**EvolClaw 的会话特点**：

1. **强制会话隔离**：
   - 每个渠道会话独立的 EvolClaw 会话ID
   - 每个会话独立的 Claude 会话ID
   - 每个会话独立的 Claude Code 实例

2. **项目共享机制**：
   - 多个会话可绑定同一项目路径
   - 文件系统层面共享
   - 对话历史层面隔离

3. **多进程并发**：
   - 每个会话独立进程
   - 进程级隔离
   - 可并发处理多个会话

---

## 四、核心设计哲学差异

### OpenClaw：协议优先的 Agent 网络

**设计理念**：
- 基于 ACP 协议构建 Agent 互联网
- Agent 间可通信、可协作
- 去中心化身份（AID）
- 统一的渠道抽象

**适用场景**：
- Agent 间协作（P2P 通信、群组协作）
- 多渠道统一管理
- 需要去中心化身份
- 需要值班调度等高级功能

**技术栈**：
- `@agentclientprotocol/sdk` - ACP 协议
- `@mariozechner/pi-agent-core` - Agent 核心
- 单一 Agent 实例 + 事件循环

---

### EvolClaw：简化的 Gateway 模式

**设计理念**：
- 每个会话独立的 Claude Code 实例
- 强制会话隔离
- 项目共享机制
- 进程级并发

**适用场景**：
- 团队协作（项目共享 + 会话隔离）
- 多项目管理
- 不需要 Agent 间通信
- 需要进程级隔离

**技术栈**：
- `@anthropic-ai/claude-agent-sdk` - Claude Agent SDK
- 多进程架构
- SQLite 会话管理

---

## 五、改进建议

### 对 EvolClaw 的建议

基于与 OpenClaw 的对比，EvolClaw 可以借鉴以下设计：

#### 1. Feishu 模块改进

**借鉴 OpenClaw 的配置模式**：
```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "allowFrom": ["ou_xxx", "ou_yyy"],  // 白名单
      "encryptKey": "xxx",                 // 消息加密
      "verificationToken": "xxx"           // Webhook 验证
    }
  }
}
```

**收益**：
- 更完善的安全控制
- 统一的配置管理
- 易于扩展新渠道

#### 2. ACP 模块改进

**选项A：完整实现 ACP 协议**（如需 Agent 间协作）
```typescript
import { AgentCP, AgentWS, FileSync } from '@agentclientprotocol/sdk';

export class ACPChannel implements IChannel {
  private agentCP: AgentCP;
  private agentWS: AgentWS;

  async connect(): Promise<void> {
    // 创建 AID
    this.agentCP = new AgentCP({
      domain: config.domain,
      agentName: config.agentName,
    });
    await this.agentCP.createAID();

    // 建立 WebSocket 连接
    this.agentWS = new AgentWS(this.agentCP);
    await this.agentWS.connect();

    // 监听消息
    this.agentWS.on('message', async (message) => {
      await this.handleMessage(message);
    });
  }

  async sendToAgent(targetAid: string, content: string): Promise<void> {
    // P2P 消息
    await this.agentWS.sendMessage(targetAid, content);
  }
}
```

**选项B：保持简化实现**（如只需接收消息）
- 当前设计足够
- 无需额外复杂度

#### 3. 会话管理改进

**借鉴 OpenClaw 的 dmScope 概念**：
```typescript
// 支持两种会话模式
interface SessionConfig {
  mode: 'isolated' | 'shared';  // 类似 dmScope
  projectPath?: string;
}

// isolated 模式：每个渠道会话独立（当前设计）
// shared 模式：同一渠道的所有会话共享（类似 OpenClaw global）
```

**实现**：
```typescript
async getOrCreateSession(
  channel: string,
  channelId: string,
  config: SessionConfig
): Promise<Session> {
  if (config.mode === 'shared') {
    // 共享模式：所有该渠道的会话映射到同一个 session
    return this.getSharedSession(channel);
  } else {
    // 隔离模式：每个渠道会话独立 session
    return this.getIsolatedSession(channel, channelId);
  }
}
```

**收益**：
- 支持个人助手场景（shared 模式）
- 支持团队协作场景（isolated 模式）
- 用户可选择适合的模式

---

## 六、总结

### 核心差异

| 维度 | OpenClaw | EvolClaw |
|------|----------|----------|
| **协议基础** | ACP 协议 | Claude Agent SDK |
| **Feishu 模块** | 完整配置 + 白名单 + 加密 | 简化配置 |
| **ACP 模块** | 完整实现（P2P + 群组 + 值班） | 基础客户端 |
| **会话管理** | ACP 会话 + dmScope | 三层映射 + 强制隔离 |
| **并发模型** | 单实例 + 事件循环 | 多进程 + 进程隔离 |
| **Agent 协作** | ✅ 支持 | ❌ 不支持 |
| **项目共享** | ❌ 不支持 | ✅ 支持 |

### 适用场景

**OpenClaw 适合**：
- 需要 Agent 间通信和协作
- 需要去中心化身份（AID）
- 需要值班调度等高级功能
- 多渠道统一管理
- 单用户/多账号场景

**EvolClaw 适合**：
- 团队协作（项目共享 + 会话隔离）
- 多项目管理
- 不需要 Agent 间通信
- 需要进程级隔离
- 简化部署和配置

### 可借鉴的设计

**从 OpenClaw 借鉴**：
1. 完善的 Feishu 配置（白名单、加密、验证）
2. 统一的渠道抽象
3. dmScope 概念（支持 shared/isolated 模式）
4. 配置文件驱动的架构

**保持 EvolClaw 特色**：
1. 三层映射的会话管理
2. 项目共享机制
3. 多进程并发
4. 简化的配置和部署

### 实施建议

**高优先级**：
1. 完善 Feishu 模块（白名单、加密、验证）
2. 支持 shared/isolated 会话模式
3. 统一配置管理

**中优先级**：
4. 完善 ACP 模块（如需 Agent 协作）
5. 统一渠道抽象

**低优先级**：
6. 完整的 ACP 协议实现（P2P、群组、值班）

### 最终建议

**如果目标是简化的 Gateway**：
- 保持当前设计
- 补充生产级可靠性（健康检查、消息去重等）
- 添加 shared/isolated 会话模式

**如果目标是 Agent 网络**：
- 完整实现 ACP 协议
- 借鉴 OpenClaw 的架构
- 考虑直接使用 OpenClaw 或基于其扩展
