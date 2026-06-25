# ChatMode 决定规则实现方案

## 概述

本文档描述 chatmode 决定规则的完整实现方案，包括对端身份确定、缓存机制、以及四个来源的决定规则。

## 背景

根据 `chatmode-mechanism.md`，chatmode 由四个来源依次决定：

1. **来源1**：agent 配置默认值（新建会话时）
2. **来源2**：群聊强制 proactive
3. **来源3**：非 human 对端强制 proactive
4. **来源4**：owner 手动 `/chatmode` 切换

其中，**来源3** 依赖对端身份的准确判定。

## 对端身份确定机制

### 信源：agent.md

对端身份的唯一信源是对端的 `agent.md` 文件：

- **下载**：通过 AUN SDK 的 `fetchAgentMd(aid)` 下载
- **验签**：SDK 自动验签，失败抛异常
- **判定规则**：
  - `type === 'human'` → human
  - `type !== 'human'` → agent（包括 `Claude Code`、`Codex`、`Gemini CLI` 等）
  - 验签失败或无 agent.md → 当做 agent（安全策略）

### 缓存机制

#### 三层缓存

| 层 | 位置 | 时效 | 用途 |
|---|------|------|------|
| SDK 内存缓存 | AUN SDK 内部 | HTTP ETag/304 | 减少网络请求 |
| 进程内存缓存 | `AUNChannel.peerInfoCache` | 30 分钟 | 快速查询 |
| 文件缓存 | `$RELATIONS_DIR/<peerKey>/peer-identity.json` | 30 天 | 持久化，跨进程 |

#### peer-identity.json 格式

```json
{
  "aid": "alice.aid.pub",
  "type": "human",
  "isAgent": false,
  "name": "Alice",
  "agentMdHash": "sha256:abc123...",
  "verifiedAt": 1748102400000,
  "lastCheckedAt": 1748102400000,
  "source": "agentmd"
}
```

| 字段 | 说明 |
|------|------|
| `aid` | 对端 AID |
| `type` | agent.md 的 type 字段（`human` / `Claude Code` / ...） |
| `isAgent` | `type !== 'human'` |
| `name` | 显示名 |
| `agentMdHash` | agent.md 内容的 SHA256（用于检测变化） |
| `verifiedAt` | 验签成功的时间戳 |
| `lastCheckedAt` | 最后检查 agent.md 的时间戳 |
| `source` | `agentmd`（已验签）/ `unknown`（验签失败或无 agent.md） |

### 更新时机

#### 入站消息（收到消息时）

```
收到消息
  ↓
检查文件缓存 peer-identity.json
  ↓
lastCheckedAt < 30天？
  ├─ 是 → 使用缓存
  └─ 否 → 调用 SDK fetchAgentMd(fromAid)
           ↓
         SDK 内部：
           ├─ 有 ETag → 发送 If-None-Match
           ├─ 服务器返回 304 → 返回 SDK 缓存
           └─ 服务器返回 200 → 返回新内容
           ↓
         验签（SDK 自动）
           ├─ 成功 → 解析 type，更新 peer-identity.json
           └─ 失败 → isAgent=true，source='unknown'
           ↓
         返回 PeerIdentity
```

#### 出站消息（发送消息时）

```
准备发送消息
  ↓
检查文件缓存 peer-identity.json
  ↓
lastCheckedAt < 30天？
  ├─ 是 → 使用缓存
  └─ 否 → 调用 SDK fetchAgentMd(toAid)
           ↓
         （同入站流程）
```

## ChatMode 决定规则实现

### 来源1：agent 配置默认值

#### 配置格式

```json
{
  "chatmode": {
    "private": "interactive",
    "group": "proactive",
    "nothuman": "proactive"
  }
}
```

#### 默认值

```typescript
const DEFAULT_CHATMODE = {
  private: 'interactive',
  group: 'proactive',
  nothuman: 'proactive'
};
```

#### 实现位置

**`src/index.ts`**：注册 `sessionModeResolver`

```typescript
sessionManager.setSessionModeResolver((channelKey, chatType, peerType) => {
  const agent = agentRegistry.resolveByChannel(channelKey);
  const cm = agent?.config.chatmode;
  if (!cm) return undefined;
  
  // 优先级：群聊 > nothuman > private
  if (chatType === 'group') return cm.group;
  if (peerType && peerType !== 'human' && peerType !== 'unknown') return cm.nothuman;
  return cm.private;
});
```

**修改点**：
1. `sessionModeResolver` 签名增加 `peerType` 参数
2. 读取 `cm.nothuman` 字段

### 来源2：群聊强制 proactive

#### 实现位置1：`SessionManager.resolveDefaultSessionMode()`

```typescript
// src/core/session/session-manager.ts

private resolveDefaultSessionMode(
  channel: string,
  chatType?: string,
  peerType?: string
): 'interactive' | 'proactive' {
  const ct = chatType || 'private';
  
  // 来源2：群聊强制 proactive（最高优先级）
  if (ct === 'group') return 'proactive';
  
  // 来源3：非 human 对端强制 proactive
  if (peerType && peerType !== 'human' && peerType !== 'unknown') return 'proactive';
  
  // 来源1：agent 配置默认值
  const resolved = this.sessionModeResolver?.(channel, ct, peerType);
  return resolved || 'interactive';
}
```

#### 实现位置2：`MessageProcessor.resolveSession()`（兜底纠正）

```typescript
// src/core/message/message-processor.ts

private async resolveSession(message: Message): Promise<{
  session: Session;
  absoluteProjectPath: string;
}> {
  // ... 获取或创建 session
  
  // 兜底纠正1：群聊强制 proactive
  if (message.chatType === 'group' && session.sessionMode !== 'proactive') {
    logger.info(`[MessageProcessor] group proactive upgrade: sessionId=${session.id} ${session.sessionMode} -> proactive`);
    session.sessionMode = 'proactive';
    await this.sessionManager.updateSession(session.id, { sessionMode: 'proactive' });
  }
  
  // 兜底纠正2：非 human 对端强制 proactive
  if (message.peerType && message.peerType !== 'human' && message.peerType !== 'unknown' && session.sessionMode !== 'proactive') {
    logger.info(`[MessageProcessor] proactive upgrade: sessionId=${session.id} ${session.sessionMode} -> proactive (peerType=${message.peerType})`);
    session.sessionMode = 'proactive';
    await this.sessionManager.updateSession(session.id, { sessionMode: 'proactive' });
  }
  
  return { session, absoluteProjectPath };
}
```

**说明**：兜底纠正用于修正历史会话（在规则变更前创建的会话）。

### 来源3：非 human 对端强制 proactive

#### 实现位置1：`SessionManager.resolveDefaultSessionMode()`

见"来源2"的实现。

#### 实现位置2：`MessageProcessor.resolveSession()`（兜底纠正）

见"来源2"的实现。

#### 对端身份传递

**入站消息**：

```typescript
// src/channels/aun.ts

async handleP2PMessage(data: any) {
  const fromAid = data.from;
  
  // 解析对端身份
  const peerIdentity = await PeerIdentityCache.resolve(
    'aun',
    fromAid,
    this.agentDir,
    this.client,
    false  // 不强制刷新，按 30 天时效
  );
  
  // 传递给 MessageProcessor
  this.handleMessage({
    channel: 'aun',
    channelId: fromAid,
    chatType: 'private',
    peerId: fromAid,
    peerType: peerIdentity.type,  // ← 传递 type
    peerName: peerIdentity.name,
    content: text,
    // ...
  });
}
```

**出站消息**：

```typescript
// src/aun/msg/p2p.ts

export async function msgSend(args: MsgSendArgs): Promise<MsgSendResult | MsgError> {
  const conn = await createShortConnection(args.from, { aunPath: args.aunPath, slotId: args.slotId });
  
  try {
    // 1. 解析对端身份
    const { agentsDir } = resolvePaths();
    const selfAgentDir = path.join(agentsDir, args.from);
    
    const peerIdentity = await PeerIdentityCache.resolve(
      'aun',
      args.to,
      selfAgentDir,
      conn,
      false
    );
    
    // 2. 决定 chatmode（遵循来源1-3）
    const chatmode = peerIdentity.isAgent ? 'proactive' : 'interactive';
    
    // 3. 构建 payload
    let payload: Record<string, unknown>;
    // ... (原有逻辑)
    
    // 4. 写入 payload.chatmode
    payload.chatmode = chatmode;
    
    // 5. 发送
    const sendParams: Record<string, unknown> = { to: args.to, payload };
    sendParams.encrypt = args.encrypt === true;
    const result = await conn.call('message.send', sendParams);
    
    // 6. 写入本地日志
    if (result?.message_id) {
      appendMessageLog(chatDir, buildOutboundEntry({
        from: args.from,
        to: args.to,
        chatType: 'private',
        msgId: result.message_id,
        content: textContent,
        encrypt: args.encrypt === true,
        chatmode,  // 使用解析出的 chatmode
        msgType: 'text',
        source: 'cli',
      }));
    }
    
    return { ok: true, message_id: result?.message_id, seq: result?.seq, status: result?.status };
  } finally {
    conn.close();
  }
}
```

### 来源4：owner 手动 `/chatmode` 切换

#### 实现位置

**`src/core/command-handler.ts`**：`/chatmode` 命令

```typescript
async handleChatmodeCommand(args: string[], session: Session): Promise<string> {
  const mode = args[0];
  
  if (!mode || !['interactive', 'proactive'].includes(mode)) {
    return `用法: /chatmode <interactive|proactive>\n当前模式: ${session.sessionMode}`;
  }
  
  // 权限检查
  if (session.chatType === 'group' && session.identity?.role !== 'owner' && session.identity?.role !== 'admin') {
    return '❌ 群聊中只有 owner/admin 可以切换 chatmode';
  }
  
  // 更新 session
  await this.sessionManager.updateSession(session.id, { sessionMode: mode });
  session.sessionMode = mode;
  
  return `✓ chatmode 已切换为 ${mode}`;
}
```

**说明**：
- 单聊：任何角色可切换（但下一条 agent 消息进来时，来源3 会再次强制 proactive）
- 群聊：仅 owner/admin 可切换

## 优先级总结

| 优先级 | 来源 | 条件 | 结果 |
|--------|------|------|------|
| 1 | 来源2 | `chatType === 'group'` | `proactive` |
| 2 | 来源3 | `peerType !== 'human' && peerType !== 'unknown'` | `proactive` |
| 3 | 来源4 | owner 手动切换 | 用户指定 |
| 4 | 来源1 | 新建会话 | 配置默认值 |

**注意**：
- 来源2 和来源3 是**强制规则**，会覆盖来源4（owner 手动切换）
- 来源4 只在下一条消息到来前有效，之后会被来源2/3 重新纠正

## payload.chatmode 字段

### 含义

`payload.chatmode` 记录的是**发送侧的 sessionMode**，用于：
- 日志追踪：记录消息是在什么模式下发出的
- 对端日志：对端收到消息时，记录发送侧的模式

### 写入位置

**daemon 发送**（通过 MessageProcessor）：

```typescript
// src/channels/aun.ts: deliverTextEntry()

if (context?.metadata?.chatmode) {
  payload.chatmode = context.metadata.chatmode;
}
```

**CLI 发送**（通过 msgSend）：

```typescript
// src/aun/msg/p2p.ts: msgSend()

payload.chatmode = chatmode;  // 从对端身份决定
```

### 读取位置

**入站消息**：

```typescript
// src/channels/aun.ts

const chatmode = payload.chatmode;  // 对端的 sessionMode

// 传递给 message-bridge
replyContext.metadata = {
  ...replyContext.metadata,
  chatmode,
};
```

**消息日志**：

```typescript
// src/core/message/message-bridge.ts

appendMessageLog(chatDir, buildInboundEntry({
  from: message.peerId,
  to: selfId,
  chatType: message.chatType,
  msgId: message.messageId,
  content: message.content,
  chatmode: message.replyContext?.metadata?.chatmode,  // 对端的 sessionMode
  // ...
}));
```

## 实现清单

### 新增模块

| 文件 | 说明 |
|------|------|
| `src/core/relation/peer-identity.ts` | PeerIdentityCache 类，管理对端身份缓存 |

### 修改模块

| 文件 | 修改内容 |
|------|----------|
| `src/core/session/session-manager.ts` | 1. `sessionModeResolver` 签名增加 `peerType` 参数<br>2. `resolveDefaultSessionMode()` 增加群聊强制逻辑 |
| `src/index.ts` | `sessionModeResolver` 实现读取 `chatmode.nothuman` |
| `src/core/message/message-processor.ts` | `resolveSession()` 增加兜底纠正逻辑 |
| `src/channels/aun.ts` | 1. `handleP2PMessage()` 调用 `PeerIdentityCache.resolve()`<br>2. 传递 `peerType` 给 MessageProcessor<br>3. 入站消息提取 `payload.chatmode` 并传递 |
| `src/aun/msg/p2p.ts` | 1. `msgSend()` 调用 `PeerIdentityCache.resolve()`<br>2. 根据对端身份决定 chatmode<br>3. 写入 `payload.chatmode` |
| `src/aun/msg/group.ts` | 同 `p2p.ts`（群消息发送） |

## 测试场景

### 场景1：human ↔ agent 单聊

| 步骤 | 操作 | 预期 chatmode |
|------|------|---------------|
| 1 | human 发消息给 agent | agent 收到，session 为 `interactive` |
| 2 | agent 回复 | 大模型输出直接发送（`message.send`） |

### 场景2：agent ↔ agent 单聊

| 步骤 | 操作 | 预期 chatmode |
|------|------|---------------|
| 1 | agent A 发消息给 agent B | B 收到，session 为 `proactive` |
| 2 | agent B 大模型输出 | 发送 `thought.put`（A 收不到） |
| 3 | agent B 调用回复工具 | 发送 `message.send`（A 收到） |
| 4 | agent A 收到回复 | session 为 `proactive` |
| 5 | agent A 大模型输出 | 发送 `thought.put`（B 收不到） |
| 6 | agent A 不调用回复工具 | 对话终止 |

### 场景3：群聊

| 步骤 | 操作 | 预期 chatmode |
|------|------|---------------|
| 1 | 任何人发消息到群 | 所有 agent 收到，session 为 `proactive` |
| 2 | agent 大模型输出 | 发送 `thought.put`（群成员收不到） |
| 3 | agent 被 @ 且调用回复工具 | 发送 `message.send`（群成员收到） |

### 场景4：CLI 发送

| 步骤 | 操作 | 预期 chatmode |
|------|------|---------------|
| 1 | `ec msg send agent-a.aid.pub agent-b.aid.pub "test"` | 查询 agent-b 身份 → `proactive` |
| 2 | `ec msg send agent-a.aid.pub human.aid.pub "test"` | 查询 human 身份 → `interactive` |

### 场景5：缓存时效

| 步骤 | 操作 | 预期行为 |
|------|------|----------|
| 1 | 首次收到 alice 的消息 | 下载 agent.md，缓存 30 天 |
| 2 | 29 天内再次收到 alice 的消息 | 使用缓存，不下载 |
| 3 | 31 天后收到 alice 的消息 | 重新下载 agent.md，更新缓存 |

## 注意事项

1. **验签失败 → 当做 agent**：这是安全策略，防止伪造身份绕过 proactive 限制
2. **兜底纠正**：用于修正历史会话，确保规则变更后的一致性
3. **owner 手动切换的局限性**：对 agent 对端切换为 `interactive` 只在下一条消息到来前有效
4. **payload.chatmode 的含义**：记录的是发送侧的 sessionMode，不是接收侧的
5. **缓存时效**：30 天是平衡性能和准确性的折中，可根据实际情况调整

## 相关文档

- `chatmode-mechanism.md`：ChatMode 机制说明（设计文档）
- `kits/rules/04-relation.md`：关系层规范
- `kits/rules/05-venue.md`：环境层规范
