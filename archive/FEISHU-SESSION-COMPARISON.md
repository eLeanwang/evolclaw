# HappyClaw vs EvolClaw：飞书模块与会话处理对比

## 核心差异总览

| 维度 | HappyClaw | EvolClaw（设计方案） |
|------|-----------|---------------------|
| **会话映射** | 渠道JID → 群组folder → Claude会话 | 渠道ID → EvolClaw会话ID → 项目路径 + Claude会话ID |
| **会话隔离** | 基于 folder（多个JID可映射到同一folder） | 基于 EvolClaw会话ID（每个渠道会话独立） |
| **项目共享** | 通过 folder 共享（同folder = 同会话） | 通过 project_path 共享（同项目 ≠ 同会话） |
| **执行隔离** | Docker容器 / 宿主机进程 | 宿主机进程（Claude Code实例） |
| **会话持久化** | `sessions` 表（folder → claude_session_id） | `sessions` 表（三层映射） |
| **自动注册** | 新JID自动注册到用户主容器 | 新渠道会话自动创建独立session |

---

## 1. 飞书模块架构

### HappyClaw：工厂模式 + 连接池

**核心设计**：
```typescript
// 工厂函数创建独立连接实例
export function createFeishuConnection(config: FeishuConnectionConfig): FeishuConnection

// IMConnectionManager 管理 per-user 连接池
class IMConnectionManager {
  private feishuConnections: Map<string, FeishuConnection>

  async connectUserFeishu(
    userId: string,
    config: FeishuConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    ignoreMessagesBefore?: number,
    onCommand?: (chatJid: string, command: string) => Promise<string | null>
  ): Promise<boolean>
}
```

**特点**：
- ✅ 每个用户独立的飞书连接（支持多用户多飞书应用）
- ✅ 工厂模式：无状态连接实例，易于测试和复用
- ✅ 热重连：`ignoreMessagesBefore` 过滤堆积消息
- ✅ 健康检查：15s 轮询 WebSocket 状态，自动重连
- ✅ 消息去重：LRU 缓存（1000条 / 30分钟TTL）
- ✅ Backfill 机制：重连后回填最近5分钟的消息

### EvolClaw：单一连接（设计方案）

**预期设计**：
```typescript
// 简化的单一飞书连接
class FeishuChannel implements IChannel {
  private client: lark.Client
  private wsClient: lark.WSClient

  async connect(): Promise<void>
  async sendMessage(sessionId: string, text: string): Promise<void>
}
```

**特点**：
- ⚠️ 单一飞书应用（不支持多用户多应用）
- ⚠️ 简化的连接管理（无热重连、无健康检查）
- ⚠️ 无消息去重机制
- ⚠️ 无 Backfill 机制

**差距**：
- 缺少生产级可靠性保障
- 缺少多用户隔离能力
- 缺少故障恢复机制

---

## 2. 会话映射机制

### HappyClaw：JID → Folder → Claude Session

**数据流**：
```
飞书消息到达
  ↓
chatJid = `feishu:${chatId}`
  ↓
onNewChat(chatJid, chatName) 回调
  ↓
registerGroup(chatJid, { folder: homeFolder, ... })
  ↓
registered_groups 表：
  - jid: feishu:ou_xxx
  - folder: home-{userId}  (或 main)
  - is_home: 1
  ↓
sessions 表：
  - group_folder: home-{userId}
  - session_id: claude-abc
  ↓
启动容器/进程时传入 sessionId
```

**关键特性**：
1. **多JID映射到同一folder**：
   - 飞书群组A → `feishu:ou_xxx` → `folder=main`
   - 飞书群组B → `feishu:ou_yyy` → `folder=main`
   - 两个群组**共享同一个Claude会话**（同一个对话历史）

2. **自动注册到主容器**：
   ```typescript
   function buildOnNewChat(userId: string, homeFolder: string) {
     return (chatJid: string, chatName: string) => {
       if (!registeredGroups[chatJid]) {
         registerGroup(chatJid, {
           name: chatName,
           folder: homeFolder,  // 自动绑定到用户主容器
           added_at: new Date().toISOString(),
         });
       }
     };
   }
   ```

3. **主容器概念**：
   - admin：`folder=main`，执行模式=`host`
   - member：`folder=home-{userId}`，执行模式=`container`
   - 所有新飞书群组默认注册到主容器

4. **会话复用**：
   - 同一个 folder 的所有 JID 共享同一个 Claude 会话
   - 适合"单一助手"场景（所有渠道看到同一个对话历史）

### EvolClaw：Channel ID → Session ID → Project + Claude Session

**数据流**：
```
飞书消息到达
  ↓
channel = 'feishu'
channelId = chatId
  ↓
SessionManager.getOrCreateSession(channel, channelId)
  ↓
sessions 表：
  - id: feishu-ou_xxx-1234567890  (EvolClaw会话ID)
  - channel: feishu
  - channel_id: ou_xxx
  - project_path: /projects/default
  - claude_session_id: claude-abc
  ↓
InstanceManager.getOrCreateInstance(sessionId, projectPath)
  ↓
启动 Claude Code 实例，传入 claude_session_id
```

**关键特性**：
1. **每个渠道会话独立**：
   - 飞书群组A → `session-1` → `claude-abc`
   - 飞书群组B → `session-2` → `claude-def`
   - 两个群组**各自独立的对话历史**

2. **项目共享 ≠ 会话共享**：
   ```
   session-1 → project-a → claude-abc
   session-2 → project-a → claude-def
   ```
   - 两个会话可以操作同一个项目的文件
   - 但对话历史完全隔离

3. **无"主容器"概念**：
   - 每个渠道会话平等对待
   - 无默认绑定逻辑

4. **会话隔离**：
   - 每个渠道会话有独立的 Claude 会话ID
   - 适合"多助手"场景（每个渠道独立的对话上下文）

---

## 3. 数据库 Schema 对比

### HappyClaw

```sql
-- 群组注册表（多JID可映射到同一folder）
CREATE TABLE registered_groups (
  jid TEXT PRIMARY KEY,              -- feishu:ou_xxx
  name TEXT,
  folder TEXT NOT NULL,              -- home-{userId} 或 main
  is_home INTEGER DEFAULT 0,
  executionMode TEXT DEFAULT 'container',
  customCwd TEXT,
  added_at TEXT
);

-- Claude 会话表（folder → claude_session_id）
CREATE TABLE sessions (
  group_folder TEXT PRIMARY KEY,     -- home-{userId}
  session_id TEXT NOT NULL           -- claude-abc
);

-- 消息表（存储所有JID的消息）
CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT NOT NULL,            -- feishu:ou_xxx
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER DEFAULT 0,
  attachments TEXT,
  PRIMARY KEY (id, chat_jid)
);
```

**特点**：
- `registered_groups.folder` 允许重复（多JID → 同folder）
- `sessions` 表以 `folder` 为主键（一个folder = 一个Claude会话）
- 消息按 `chat_jid` 存储（保留渠道来源）

### EvolClaw（设计方案）

```sql
-- 会话表（三层映射）
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- feishu-ou_xxx-1234567890
  channel TEXT NOT NULL,             -- 'feishu' | 'acp'
  channel_id TEXT NOT NULL,          -- ou_xxx
  project_path TEXT NOT NULL,        -- /projects/default
  claude_session_id TEXT,            -- claude-abc
  created_at INTEGER,
  updated_at INTEGER,
  UNIQUE(channel, channel_id)        -- 渠道会话唯一
);

-- 消息表（按 session_id 存储）
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,          -- feishu-ou_xxx-1234567890
  sender TEXT,
  content TEXT,
  timestamp INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

**特点**：
- `sessions` 表以 `id` 为主键（每个渠道会话独立）
- `UNIQUE(channel, channel_id)` 约束（一个渠道会话 = 一个session）
- 消息按 `session_id` 存储（不保留原始渠道JID）

---

## 4. 消息处理流程对比

### HappyClaw：轮询 + 队列 + 容器/进程

```typescript
// 1. 飞书消息到达 → 存储到数据库
handleIncomingMessage(payload) {
  const chatJid = `feishu:${chatId}`;
  onNewChat?.(chatJid, chatName);  // 自动注册
  storeMessageDirect(messageId, chatJid, ...);
  broadcastNewMessage(chatJid, message);
}

// 2. 主循环轮询新消息（2s间隔）
async function messageLoop() {
  const newMessages = getNewMessages(globalMessageCursor);

  // 按 chat_jid 分组
  const byJid = groupBy(newMessages, 'chat_jid');

  for (const [jid, messages] of byJid) {
    const group = registeredGroups[jid];
    const folder = group.folder;

    // 入队到 GroupQueue
    for (const msg of messages) {
      queue.enqueueMessageCheck(folder, jid, msg);
    }
  }
}

// 3. GroupQueue 处理
class GroupQueue {
  async enqueueMessageCheck(folder, jid, message) {
    // 检查容器/进程状态
    if (isIdle) {
      runContainerAgent(folder, jid, message);
    } else if (isRunning) {
      sendMessage(folder, message);  // IPC注入
    } else {
      waitingGroups.add(folder);     // 排队
    }
  }
}

// 4. 容器/进程执行
runContainerAgent(folder, jid, message) {
  const sessionId = sessions[folder];  // 复用同一个Claude会话
  const input: ContainerInput = {
    prompt: message.content,
    sessionId,
    groupFolder: folder,
    chatJid: jid,
    isHome: group.is_home,
    isAdminHome: folder === 'main',
  };

  // 启动容器或宿主机进程
  if (group.executionMode === 'host') {
    runHostAgent(input);
  } else {
    runContainerAgent(input);
  }
}
```

**特点**：
- ✅ 轮询模式：2s 间隔，批量处理
- ✅ 队列管理：会话级队列 + 全局并发限制
- ✅ IPC 注入：运行中的容器/进程可接收新消息
- ✅ 会话复用：同 folder 的所有 JID 共享同一个 Claude 会话

### EvolClaw：事件驱动 + 实例池（设计方案）

```typescript
// 1. 飞书消息到达 → 直接处理
feishuChannel.on('message', async (channelId, content) => {
  // 获取或创建会话
  const session = await sessionManager.getOrCreateSession('feishu', channelId);

  // 获取或创建实例
  const instance = await instanceManager.getOrCreateInstance(
    session.id,
    session.projectPath
  );

  // 执行查询
  const result = await instance.query(content);

  // 发送回复
  await feishuChannel.sendMessage(channelId, result);
});

// 2. SessionManager
class SessionManager {
  async getOrCreateSession(channel, channelId) {
    // 查询数据库
    let session = db.query('SELECT * FROM sessions WHERE channel=? AND channel_id=?', [channel, channelId]);

    if (!session) {
      // 创建新会话
      const id = `${channel}-${channelId}-${Date.now()}`;
      session = {
        id,
        channel,
        channel_id: channelId,
        project_path: config.defaultProjectPath,
        claude_session_id: null,
      };
      db.insert('sessions', session);
    }

    return session;
  }
}

// 3. InstanceManager
class InstanceManager {
  async getOrCreateInstance(sessionId, projectPath) {
    let instance = this.instances.get(sessionId);

    if (!instance || instance.state === 'STOPPED') {
      // 启动新实例
      instance = new ClaudeInstance(sessionId, projectPath);
      await instance.start();
      this.instances.set(sessionId, instance);
    }

    return instance;
  }
}

// 4. ClaudeInstance
class ClaudeInstance {
  async query(prompt) {
    // 通过 stdin 发送 JSON
    this.process.stdin.write(JSON.stringify({ prompt }));

    // 从 stdout 读取响应
    return await this.readResponse();
  }
}
```

**特点**：
- ⚠️ 事件驱动：消息到达立即处理（无轮询）
- ⚠️ 实例池：每个会话独立实例（无队列管理）
- ⚠️ 无 IPC 注入：实例运行中无法接收新消息
- ⚠️ 会话隔离：每个渠道会话独立的 Claude 会话

**差距**：
- 缺少并发控制（可能同时启动过多实例）
- 缺少消息队列（实例忙时新消息会丢失或阻塞）
- 缺少批量处理优化

---

## 5. 会话生命周期对比

### HappyClaw

```
1. 新飞书群组发消息
   ↓
2. onNewChat 回调 → registerGroup(jid, { folder: homeFolder })
   ↓
3. registered_groups 表插入：jid → folder
   ↓
4. messageLoop 轮询到消息 → queue.enqueueMessageCheck(folder, jid, msg)
   ↓
5. 检查 folder 状态：
   - 空闲 → runContainerAgent(folder, jid, msg)
   - 运行中 → sendMessage(folder, msg)  // IPC注入
   - 满载 → waitingGroups.add(folder)
   ↓
6. 容器/进程启动：
   - 读取 sessions[folder] → sessionId
   - 传入 ContainerInput { sessionId, groupFolder, chatJid, ... }
   - 容器内 agent-runner 调用 Claude SDK query({ sessionId })
   ↓
7. 首次查询返回 newSessionId → 更新 sessions[folder] = newSessionId
   ↓
8. 后续消息复用同一个 sessionId
   ↓
9. 空闲超时（30分钟）→ 容器/进程停止
   ↓
10. sessions[folder] 保留 → 下次启动时恢复会话
```

**特点**：
- ✅ 自动注册：新JID自动绑定到主容器
- ✅ 会话复用：同folder的所有JID共享会话
- ✅ IPC注入：运行中可接收新消息
- ✅ 持久化：sessions表保留会话ID

### EvolClaw（设计方案）

```
1. 新飞书群组发消息
   ↓
2. SessionManager.getOrCreateSession('feishu', chatId)
   ↓
3. sessions 表插入：
   - id: feishu-ou_xxx-1234567890
   - channel: feishu
   - channel_id: ou_xxx
   - project_path: /projects/default
   - claude_session_id: null
   ↓
4. InstanceManager.getOrCreateInstance(sessionId, projectPath)
   ↓
5. 启动 Claude Code 进程：
   - cwd: projectPath
   - env: CLAUDE_SESSION_ID=null
   ↓
6. 首次查询返回 newSessionId → 更新 sessions.claude_session_id
   ↓
7. 后续消息：
   - 查询 sessions 表 → 找到已存在的 session
   - 检查实例状态：
     - 运行中 → 直接查询（⚠️ 无IPC注入，需等待当前查询完成）
     - 已停止 → 重新启动实例
   ↓
8. 空闲超时（30分钟）→ 实例停止
   ↓
9. sessions 表保留 → 下次启动时恢复会话
```

**特点**：
- ⚠️ 手动创建：无自动注册逻辑
- ⚠️ 会话隔离：每个渠道会话独立
- ⚠️ 无IPC注入：实例忙时新消息需等待或丢失
- ✅ 持久化：sessions表保留三层映射

---

## 6. 核心设计哲学差异

### HappyClaw：单一助手模型

**理念**：
- 用户有一个"主助手"（主容器）
- 所有渠道（飞书、Telegram、Web）都与同一个助手对话
- 助手能看到所有渠道的对话历史
- 适合个人使用场景

**优势**：
- ✅ 上下文连续：跨渠道的对话历史统一
- ✅ 简化管理：一个用户 = 一个主会话
- ✅ 资源高效：多个JID共享一个容器/进程

**劣势**：
- ❌ 隐私问题：不同群组的对话互相可见
- ❌ 上下文混乱：多个群组的对话混在一起
- ❌ 灵活性差：无法为不同群组配置不同的项目

### EvolClaw：多助手模型

**理念**：
- 每个渠道会话有独立的"助手实例"
- 不同群组的对话历史完全隔离
- 可以为不同会话配置不同的项目
- 适合团队协作场景

**优势**：
- ✅ 隐私保护：对话历史隔离
- ✅ 上下文清晰：每个会话独立的上下文
- ✅ 灵活配置：不同会话可绑定不同项目

**劣势**：
- ❌ 资源开销：每个会话独立实例
- ❌ 上下文割裂：跨渠道的对话无法关联
- ❌ 管理复杂：需要管理多个会话

---

## 7. 适用场景对比

### HappyClaw 适合：

1. **个人助手场景**：
   - 一个用户在多个渠道（飞书、Telegram、Web）与同一个助手对话
   - 希望助手能记住所有渠道的对话历史

2. **单项目场景**：
   - 主要在一个项目上工作
   - 不需要频繁切换项目

3. **资源受限场景**：
   - 服务器资源有限
   - 希望多个渠道共享一个容器/进程

### EvolClaw 适合：

1. **团队协作场景**：
   - 多个团队在同一个项目上工作
   - 每个团队有独立的飞书群组
   - 希望对话历史隔离

2. **多项目场景**：
   - 用户在多个项目间切换
   - 每个项目有独立的对话上下文

3. **隐私敏感场景**：
   - 不同群组的对话不应互相可见
   - 需要严格的会话隔离

---

## 8. 关键技术差异总结

| 技术点 | HappyClaw | EvolClaw |
|--------|-----------|----------|
| **消息处理** | 轮询（2s间隔） | 事件驱动（实时） |
| **并发控制** | GroupQueue（会话级队列 + 全局限制） | InstanceManager（实例池） |
| **IPC通信** | 支持（运行中注入消息） | 不支持（需等待当前查询完成） |
| **会话复用** | 同folder共享会话 | 每个渠道会话独立 |
| **项目共享** | 同folder = 同项目 | 同project_path ≠ 同会话 |
| **自动注册** | onNewChat回调自动注册到主容器 | 手动创建session |
| **健康检查** | 15s轮询WebSocket状态 | 无 |
| **消息去重** | LRU缓存（1000条/30分钟） | 无 |
| **Backfill** | 重连后回填5分钟消息 | 无 |
| **热重连** | ignoreMessagesBefore过滤堆积消息 | 无 |

---

## 9. 建议与改进方向

### 对 EvolClaw 的建议：

1. **补充生产级可靠性**：
   - 添加健康检查和自动重连机制
   - 实现消息去重和 Backfill
   - 添加热重连支持

2. **完善并发控制**：
   - 实现会话级消息队列
   - 添加全局并发限制
   - 支持 IPC 消息注入

3. **考虑混合模型**：
   - 支持"主会话"模式（类似HappyClaw）
   - 支持"独立会话"模式（当前设计）
   - 让用户选择适合的模式

4. **优化资源使用**：
   - 实现实例池复用
   - 添加智能空闲超时
   - 支持实例预热

### 对 HappyClaw 的建议：

1. **支持会话隔离**：
   - 添加"独立会话"模式
   - 允许用户为不同JID创建独立会话
   - 保留当前"共享会话"模式作为默认

2. **优化项目管理**：
   - 支持多项目切换
   - 允许不同JID绑定不同项目
   - 保持会话隔离

3. **增强隐私保护**：
   - 添加会话隔离选项
   - 支持临时会话（不保存历史）
   - 支持会话分组

---

## 10. 结论

**HappyClaw** 和 **EvolClaw** 代表了两种不同的设计哲学：

- **HappyClaw**：成熟的生产级系统，适合个人助手场景，强调上下文连续性和资源效率
- **EvolClaw**：简化的多助手模型，适合团队协作场景，强调会话隔离和灵活性

两者各有优劣，最佳方案可能是**混合模型**：
- 保留 HappyClaw 的生产级可靠性和并发控制
- 引入 EvolClaw 的会话隔离和项目共享机制
- 让用户根据场景选择合适的模式
