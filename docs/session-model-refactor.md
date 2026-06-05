# Gateway 会话模型重构方案

## 一、核心原则

**Gateway 是无差别的会话引擎**，只认维度，不做策略判断。

- 路由维度：`channel`、`channelId`、`agentId`、`threadId`
- 这些维度的组合确定一个**会话空间**
- 会话空间内可以有多个 session（不同 projectPath、不同 name）
- Gateway 提供 session CRUD，不做互斥约束、不做策略限制

**Channel 负责策略和路由**：

- 群聊能否切项目、消息前缀、后台会话通知 → channel 的策略
- 当前用户在跟哪个 session 对话 → channel 维护的路由状态
- 消息入站时填充 `chatType`、`peerId` → channel 的职责

## 二、Session 表结构

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,

  -- 会话空间维度（路由需要）
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'claude',
  thread_id TEXT NOT NULL DEFAULT '',

  -- 会话属性（Gateway 高频使用）
  chat_type TEXT NOT NULL DEFAULT 'private',      -- 'private' | 'group'
  session_mode TEXT NOT NULL DEFAULT 'interactive', -- 'interactive' | 'autonomous'
  project_path TEXT NOT NULL,
  agent_session_id TEXT,
  name TEXT,

  -- 生命周期
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,

  -- channel 透传存储
  metadata TEXT
);

-- 索引（查询优化，无唯一约束）
CREATE INDEX idx_session_space ON sessions(channel, channel_id, agent_id, thread_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_session_active ON sessions(channel, channel_id) WHERE deleted_at IS NULL;
```

**字段说明**：

| 字段 | 用途 | 谁读写 |
|------|------|--------|
| `channel` | 路由维度 | Gateway |
| `channel_id` | 路由维度 | Gateway |
| `agent_id` | 路由维度 | Gateway |
| `thread_id` | 路由维度 | Gateway |
| `chat_type` | 查询过滤、policy 判断 | Channel 写入，Gateway 存储 |
| `session_mode` | 查询过滤、后台任务标识 | Gateway |
| `project_path` | Agent 工作目录 | Gateway |
| `agent_session_id` | Agent SDK session ID | Gateway |
| `name` | 用户友好标识 | Gateway |
| `metadata` | channel 特有状态 | Channel 读写，Gateway 透传 |

**metadata 示例**：

```jsonc
// 飞书 channel
{
  "isActive": true,
  "replyOpts": { "rootId": "om_xxx" }
}

// 微信 channel
{
  "isActive": true,
  "contextToken": "xxx"
}
```

## 三、Message 类型

```typescript
interface Message {
  // 路由维度
  channel: string;
  channelId: string;
  agentId?: string;        // 可选，默认 'claude'
  threadId?: string;       // 可选，默认 ''

  // 发送者
  peerId: string;          // 发送者 ID（原 userId）
  peerName?: string;       // 发送者名称（原 userName）

  // 消息内容
  content: string;
  images?: Array<{ data: string; mimeType: string }>;
  mentions?: Array<{ userId: string; name?: string; key?: string }>;

  // 元信息
  messageId?: string;
  timestamp?: number;
}
```

**变更**：
- `userId` → `peerId`（语义明确）
- `userName` → `peerName`（对应关系清晰）
- 删除 `isGroup`（由 session 的 `chatType` 承载）

## 四、Gateway 职责边界

**Gateway 做的事**：

1. **Session CRUD**
   - `createSession(channel, channelId, agentId, threadId, projectPath, ...)`
   - `getSession(sessionId)`
   - `listSessions(channel, channelId, agentId?, threadId?)`
   - `updateSession(sessionId, updates)`
   - `deleteSession(sessionId)` (软删除)

2. **Identity 解析**
   - `resolveIdentity(channel, peerId)` → `{ role: 'owner'|'guest'|'anonymous' }`
   - 基于 config 的 owner 配置

3. **Agent 调用**
   - 读取 `projectPath`、`agent_session_id`
   - 调用 Agent SDK
   - 更新 `agent_session_id`

4. **Metadata 透传**
   - `getMetadata(sessionId)` → JSON
   - `updateMetadata(sessionId, patch)` → 合并更新

**Gateway 不做的事**：

1. 不维护 active/current 状态（channel 存在 metadata 里）
2. 不做互斥约束（channel 自己保证）
3. 不判断群聊策略（通过 policy 机制）
4. 不查询 chatType（channel 在创建 session 时写入）
5. 不加消息前缀（channel 的展示逻辑）
6. 不决定后台 session 的通知策略

## 五、Channel Policy 机制

Channel 注册时声明策略，Gateway 核心代码调用 policy 方法，不写 `if (chatType === 'group')` 分支。

```typescript
interface ChannelPolicy {
  // 项目管理
  canSwitchProject(chatType: string, identity: string): boolean;
  canListProjects(chatType: string, identity: string): boolean;

  // 会话管理
  canCreateSession(chatType: string, identity: string): boolean;
  canDeleteSession(chatType: string, identity: string): boolean;
  canImportCliSession(chatType: string, identity: string): boolean;

  // 消息展示
  messagePrefix(chatType: string, peerName?: string): string;
  showActivities(chatType: string, identity: string): boolean;
  quietMode(chatType: string, identity: string): boolean;

  // 错误处理
  accumulateErrors(chatType: string, identity: string): boolean;
}
```

**飞书 channel 的 policy 实现**：

```typescript
const feishuPolicy: ChannelPolicy = {
  canSwitchProject: (chatType) =>
    chatType === 'private',

  canListProjects: (chatType) =>
    chatType === 'private',

  canImportCliSession: (chatType, identity) =>
    chatType === 'private' && identity === 'owner',

  canDeleteSession: (chatType, identity) =>
    identity === 'owner',

  canCreateSession: () => true,

  messagePrefix: (chatType, peerName) =>
    chatType === 'group' && peerName ? `[${peerName}] ` : '',

  showActivities: (chatType, identity) => {
    const mode = config.showActivities || 'all';
    if (mode === 'none') return false;
    if (mode === 'dm-only') return chatType === 'private';
    if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
    return true;
  },

  quietMode: (chatType, identity) =>
    chatType === 'group' || identity !== 'owner',

  accumulateErrors: (chatType, identity) =>
    chatType === 'private' && identity === 'owner',
};
```

**Gateway 使用 policy**：

```typescript
// command-handler.ts
const policy = this.getPolicy(channel);
if (!policy.canSwitchProject(session.chatType, identity.role)) {
  return '❌ 当前聊天类型不支持切换项目';
}

// message-processor.ts
const shouldSuppress = !policy.showActivities(session.chatType, identity.role);
const quietMode = policy.quietMode(session.chatType, identity.role);
```

## 六、消息流转

```
1. 用户消息 → Channel 收到
   ↓
2. Channel 填充维度
   - channel, channelId, peerId, peerName
   - threadId (如果是话题)
   - agentId (默认 'claude')
   ↓
3. Channel 确定 chatType
   - 私聊: 'private'
   - 群聊: 'group'
   ↓
4. Channel 路由到 session
   - 查询 metadata 中的 isActive 标记
   - 或根据 threadId 直接定位
   ↓
5. Gateway 处理
   - getSession(sessionId)
   - resolveIdentity(channel, peerId)
   - 应用 policy 检查
   - 调用 agent
   ↓
6. 结果返回 Channel
   - Channel 应用 policy.messagePrefix()
   - Channel 决定静默/通知
   - Channel 发送给用户
```

## 七、迁移步骤

### Phase 1: 类型定义

1. `types.ts`
   - Session: 删除 `isGroup`/`isActive`/`identity`，加 `chatType`/`agentId`/`sessionMode`
   - Message: `userId` → `peerId`, `userName` → `peerName`，删除 `isGroup`
   - 新增 `ChannelPolicy` 接口

### Phase 2: 数据库迁移

2. `session-manager.ts`
   - 迁移脚本：`is_group` → `chat_type`, `agent_type` → `agent_id`
   - 删除 `is_active` 字段（channel 用 metadata 存）
   - 删除唯一索引约束
   - 删除 `deactivateAll()` 方法

### Phase 3: Channel 改造

3. `channels/feishu.ts`
   - onMessage 回调填充 `chatType`、`peerId`、`peerName`
   - 实现 `ChannelPolicy`
   - metadata 中维护 `isActive` 状态

4. `channels/wechat.ts` — 同上

### Phase 4: Gateway 核心

5. `core/message-processor.ts`
   - 所有 `if (isGroup)` 替换为 `policy.xxx(chatType, identity)`
   - 删除 `isBackgroundSession()`（channel 自己判断）

6. `core/command-handler.ts`
   - 所有 `if (isGroup)` 替换为 `policy.xxx(chatType, identity)`
   - 删除 `isGroupChat()` 方法

7. `index.ts`
   - 删除 `adapter.isGroupChat()` 调用
   - 删除 `[userName]` 前缀逻辑（移到 channel policy）
   - 删除 `isGroup` 持久化逻辑

### Phase 5: 测试验证

8. 更新所有测试用例
9. 验证私聊、群聊、话题会话的完整流程
10. 验证多 session 切换、后台 session 通知

## 八、关键设计决策总结

| 问题 | 决策 | 理由 |
|------|------|------|
| projectPath 是否参与主键？ | 否 | 它是 session 属性，不是身份维度 |
| agentId 会变吗？ | 否 | 创建时确定，想换 agent 就切 session |
| is_active 谁维护？ | Channel | Gateway 不做互斥约束 |
| chatType 谁填充？ | Channel | Channel 在收消息时就知道 |
| 群聊策略谁判断？ | Policy | Gateway 调 policy 方法，不写分支 |
| metadata 存什么？ | Channel 特有状态 | Gateway 透传，不解析 |
| agent_session_id 放哪？ | 顶层字段 | Gateway 高频使用，不套 JSON |
