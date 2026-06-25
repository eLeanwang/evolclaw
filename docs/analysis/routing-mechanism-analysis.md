# 路由机制分析与对比

## 一、现有的路由机制

### 1.1 核心概念

#### Channel Key（渠道键）

**格式**：`<aid>#<type>#<name>`

**示例**：
- `llbot.agentid.pub#aun#main`
- `dddd.agentid.pub#feishu#work`

**组成**：
- `aid`：Agent 的 AID
- `type`：渠道类型（aun, feishu, wechat 等）
- `name`：实例名（main, secondary 等）

**用途**：
- 唯一标识一个 channel 实例
- 通过 `channelIndex` 路由到对应的 agent
- 权限管理（isOwner, isAdmin）

#### Peer Key（对端键）

**格式**：`<channelType>#<urlEncode(peerId)>`

**示例**：
- `aun#dddd.agentid.pub`
- `feishu#ou_xxx`
- `wechat#wxid_xxx`

**用途**：
- 标识对端在特定渠道类型下的唯一身份
- 用于关系层（relations/）的目录命名
- 注入到 ECK 上下文中（`$PEER_DIR`）

#### Session（会话）

**路由维度**：
```typescript
{
  channel: string;       // 实例名（如 'aun_main'）
  channelType: string;   // 类型（'aun' | 'feishu' | ...）
  channelId: string;     // 路由键（AUN 私聊=peerAID，群聊=groupId）
  agentId: string;       // 默认 'claude'
  threadId: string;      // 默认 ''（空=主会话，非空=thread）
  projectPath: string;   // 工作目录
}
```

**存储位置**：
```
~/.evolclaw/data/sessions/<channelType>/<channelId>/<selfId>/
  ├── active.json          # 主会话
  └── threads/
      └── <threadId>.json  # thread 会话
```

**查找逻辑**：
1. 通过 `(channel, channelId, threadId)` 三元组定位
2. `threadId` 为空 → 主会话（active.json）
3. `threadId` 非空 → thread 会话（threads/<threadId>.json）

### 1.2 当前路由流程

#### 接收消息时

```
1. Channel Adapter 收到消息
   ↓
2. 提取 (channel, channelId, peerId, threadId)
   ↓
3. SessionManager.getOrCreateSession()
   ├─ threadId 存在 → getOrCreateThreadSession()
   └─ threadId 为空 → 查找/创建主会话
   ↓
4. 找到 Session → 关联 baseagent 会话 ID
   ↓
5. 路由到对应的 baseagent 会话
```

#### 发送消息时

```
1. Agent 输出 → MessageProcessor
   ↓
2. 从当前 Session 获取 (channel, channelId)
   ↓
3. 通过 Channel Adapter 发送
   ↓
4. 写入消息日志（messages.jsonl）
```

### 1.3 现有机制的问题

#### 问题1：无法区分消息来源

**现象**：
- Agent 调用 `ec msg send` → 标记为 `daemon`
- 用户手动 `ec msg send` → 标记为 `cli`
- 但实际上都标记为 `daemon`（因为环境变量没传递）

#### 问题2：Thread 机制不完善

**现状**：
- `threadId` 存在，但没有充分利用
- 无法在同一对端之间创建多个独立的话题

#### 问题3：Channel Name 没有充分利用

**现状**：
- Channel Key 中的 `name` 字段存在
- 但在消息收发时没有传递
- 无法基于 `name` 路由到不同的会话

---

## 二、你提出的新机制

### 2.1 核心思想

**通过 Channel Name 实现多话题路由**

#### 概念

1. **Channel Name = `<aid>#<type>#<name>`**
   - 同一对端，不同的 `name` → 不同的话题
   - 每个话题关联一系列 baseagent 会话 ID

2. **会话序列**
   - 一个 Channel Name 对应一系列会话 ID
   - 这些会话 ID 按时间顺序产生
   - 最后活跃的会话 ID 是当前活跃会话

3. **消息传递**
   - 发送消息时，通过 `--channel` 参数指定 Channel Name
   - 接收消息时，从 payload 中提取 Channel Name
   - 通过 Channel Name 路由到对应的会话

### 2.2 使用场景

#### 场景A：Agent 之间多话题通信

```
llbot 和 dddd 之间有两个话题：

话题1（工作）：
  Channel Name: llbot.agentid.pub#aun#work
  ├─ llbot 本地会话: claude-session-xxx-1
  └─ dddd 本地会话: claude-session-yyy-1

话题2（闲聊）：
  Channel Name: llbot.agentid.pub#aun#chat
  ├─ llbot 本地会话: claude-session-xxx-2
  └─ dddd 本地会话: claude-session-yyy-2
```

#### 场景B：默认话题

```bash
# 不指定 --channel，使用最后活跃的 Channel Name
ec msg send llbot.aid.pub dddd.aid.pub "test"

# 如果没有活跃的 Channel Name，创建默认的 main
# Channel Name: llbot.agentid.pub#aun#main
```

#### 场景C：指定话题

```bash
# Agent 在会话中调用，指定 Channel Name
ec msg send llbot.aid.pub dddd.aid.pub "test" --channel "llbot.agentid.pub#aun#work"

# 通过 Channel Name 路由到对应的会话
```

### 2.3 新机制的优势

1. **多话题支持**：同一对端可以有多个独立的话题
2. **会话隔离**：不同话题的会话互不干扰
3. **来源识别**：通过 `--channel` 参数区分 agent 调用和用户手动
4. **灵活路由**：可以基于 Channel Name 路由到不同的会话

---

## 三、两种机制的对比

### 3.1 解决的问题

| 维度 | 现有机制 | 新机制 |
|------|----------|--------|
| **路由维度** | (channel, channelId, threadId) | (channel, channelId, **channelName**) |
| **多话题** | 通过 threadId（不完善） | 通过 channelName（完善） |
| **来源识别** | 无法区分 | 通过 --channel 参数 |
| **会话序列** | 单一会话 | 一个 channelName 对应多个会话 |
| **传递方式** | threadId 在 payload 中 | channelName 在 --channel 参数 |

### 3.2 是否解决同一个问题？

**部分重叠，但侧重点不同**

#### 现有机制（threadId）

- **目标**：支持多线程对话（如群聊中的回复线程）
- **实现**：通过 `threadId` 区分不同的线程
- **问题**：
  - `threadId` 没有充分利用
  - 无法在 CLI 中指定 `threadId`
  - 无法基于 `threadId` 实现多话题

#### 新机制（channelName）

- **目标**：支持多话题对话 + 来源识别
- **实现**：通过 `channelName` 区分不同的话题
- **优势**：
  - 可以在 CLI 中指定 `--channel`
  - 可以基于 `channelName` 路由到不同的会话
  - 可以区分 agent 调用和用户手动

### 3.3 两者的关系

**可以共存，互补**

```
路由维度：(channel, channelId, channelName, threadId)
  ├─ channelName: 话题级别（工作、闲聊、项目A、项目B）
  └─ threadId: 线程级别（群聊中的回复线程）
```

**示例**：

```
llbot 和 dddd 之间的"工作"话题：
  Channel Name: llbot.agentid.pub#aun#work
  ├─ 主会话（threadId = ''）
  └─ 回复线程（threadId = 'thread-123'）
```

---

## 四、实现方案

### 4.1 修改点

#### 1. 扩展 `ec msg send` 命令

```bash
ec msg send <from-aid> <to-aid> <text> [--channel <channelName>] [--encrypt]
```

**参数**：
- `--channel <channelName>`：指定 Channel Name（可选）
- 如果不指定，使用最后活跃的 Channel Name（默认 main）

#### 2. 修改 Session 路由逻辑

**当前**：
```typescript
getOrCreateSession(channel, channelId, threadId, ...)
```

**修改后**：
```typescript
getOrCreateSession(channel, channelId, channelName, threadId, ...)
```

**查找逻辑**：
1. 通过 `(channel, channelId, channelName)` 定位会话目录
2. 查找最后活跃的会话 ID
3. 如果不存在，创建新会话

#### 3. 修改消息 payload

**发送时**：
```json
{
  "type": "text",
  "text": "...",
  "chatmode": "proactive",
  "channel_name": "llbot.agentid.pub#aun#work"
}
```

**接收时**：
```typescript
const channelName = payload.channel_name || `${selfAid}#${channelType}#main`;
```

#### 4. 修改 source 判断逻辑

```typescript
// 有 --channel 参数 → agent 调用
const source = args.channel ? 'msg' : 'cli';
```

### 4.2 存储结构

#### 当前

```
~/.evolclaw/data/sessions/<channelType>/<channelId>/<selfId>/
  ├── active.json
  └── threads/
```

#### 修改后（方案A：扁平化）

```
~/.evolclaw/data/sessions/<channelType>/<channelId>/<selfId>/
  ├── main/
  │   ├── active.json
  │   └── threads/
  ├── work/
  │   ├── active.json
  │   └── threads/
  └── chat/
      ├── active.json
      └── threads/
```

#### 修改后（方案B：保持兼容）

```
~/.evolclaw/data/sessions/<channelType>/<channelId>/<selfId>/
  ├── active.json          # 默认话题（main）
  ├── threads/             # 默认话题的 threads
  └── channels/
      ├── work/
      │   ├── active.json
      │   └── threads/
      └── chat/
          ├── active.json
          └── threads/
```

**推荐方案B**：保持向后兼容，默认话题不需要 `channels/` 子目录。

### 4.3 实现步骤

#### 阶段1：基础支持

1. ✅ 扩展 `ec msg send` 命令，增加 `--channel` 参数
2. ✅ 修改 source 判断逻辑（有 --channel → msg，无 → cli）
3. ✅ 在 payload 中传递 `channel_name`

#### 阶段2：路由支持

4. 修改 `SessionManager.getOrCreateSession()`，增加 `channelName` 参数
5. 修改会话查找逻辑，基于 `channelName` 定位
6. 修改存储结构，支持多 channelName

#### 阶段3：完善功能

7. 实现"最后活跃的 channelName"查找逻辑
8. 实现 channelName 的创建和管理
9. 更新文档和测试

---

## 五、建议

### 5.1 短期方案（解决 source 标记问题）

**只实现阶段1**：

1. 给 `ec msg send` 增加 `--channel` 参数
2. 通过 `--channel` 参数判断 source
3. 在 payload 中传递 `channel_name`（但暂不路由）

**优势**：
- 快速解决 source 标记问题
- 不需要大规模重构
- 为后续扩展留下接口

### 5.2 长期方案（完整的多话题路由）

**实现阶段1-3**：

1. 完整的 channelName 路由机制
2. 支持多话题对话
3. 会话序列管理

**优势**：
- 完整的多话题支持
- 更灵活的会话管理
- 更好的用户体验

### 5.3 我的建议

**先实现短期方案，验证可行性后再实现长期方案**

理由：
1. source 标记是当前的痛点，需要快速解决
2. 多话题路由是更大的功能，需要充分设计和测试
3. 短期方案可以为长期方案铺路

---

## 六、问题和讨论

### Q1：channelName 和 threadId 的关系？

**建议**：
- `channelName`：话题级别（工作、闲聊、项目A）
- `threadId`：线程级别（群聊中的回复线程）
- 两者可以共存，互补

### Q2：如何处理向后兼容？

**建议**：
- 默认 channelName 是 `main`
- 旧的会话自动映射到 `main`
- 新的会话可以指定其他 channelName

### Q3：如何管理 channelName 的生命周期？

**建议**：
- 自动创建：首次使用时创建
- 自动清理：长期不活跃的 channelName 可以归档
- 手动管理：提供 CLI 命令查看和删除

### Q4：peerKey 和 channelName 的关系？

**当前理解**：
- `peerKey`：`<channelType>#<urlEncode(peerId)>`，用于关系层
- `channelName`：`<aid>#<type>#<name>`，用于会话路由
- 两者独立，互不影响

**是否正确？请确认。**
