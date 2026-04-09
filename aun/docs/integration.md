# AUN Channel 集成方案

> 文档状态：设计阶段（2026-04-04）
> 基于 aun-sdk-core Python SDK

---

## 一、架构定位

```
EvolClaw (TypeScript)          Sidecar (Python)           AUN Network
┌──────────────────────┐       ┌─────────────────┐       ┌──────────┐
│  AunChannel          │◄─────►│  aun_bridge.py  │◄─WS──►│ Gateway  │
│  (ChannelAdapter)    │ stdio  │  (AUNClient)    │       │          │
└──────────────────────┘ JSON- └─────────────────┘       └──────────┘
                          RPC
```

Python SDK 等价于"AUN 的远程服务器端接口"，通过 stdio 而非网络连接。
EvolClaw core 层零改动，与 Feishu/WeChat 接入模式完全一致。

---

## 二、核心概念映射

| EvolClaw 概念 | Feishu | WeChat | AUN |
|---|---|---|---|
| `channel` | `'feishu'` | `'wechat'` | `'aun'` |
| `channelId` | `chat_id` | `from_user_id` | 单聊: 对端AID / 群聊: `group_id` |
| `userId` | `open_id` | `from_user_id` | `sender AID` |
| `chatType` | `chat_type` 字段 | `'private'` | 有 `group_id` → group |
| 本地身份 | `appId` | `bot_id` | 本地 AID |
| 主会话 | `chat_id`（无 thread） | `from_user_id` | 无 `task_id` 的消息流 |
| 话题/线程 | `root_id` 标记的 thread | — | 有 `task_id` 的消息 |
| 话题回溯 | `root_id` | — | `parent_task_id` |
| `ReplyContext` | `rootId → thread` | 无 | `task_id`（可选） |
| owner 判定 | `config.owners` | `config.owners` | `config.owners` |
| 消息去重 | `message_id` | — | `message_id` |
| 消息确认 | ✓ reaction | `sendTyping` | `message.ack` |
| 连接方式 | WebSocket 推送 | HTTP 长轮询 | stdio → WS |
| 加密 | 平台 TLS | 平台 TLS | SDK 内 E2EE（透明） |
| @mention | `mentions` 字段 | — | payload 内 `@aid` 约定 |
| 文件收发 | Feishu API | CDN+AES | 初期不支持 |
| 在线状态 | 平台管理 | 平台管理 | SDK 自维护 |

---

## 三、会话空间映射

```
AUN 消息 → EvolClaw Session Key

单聊消息 (message.received，无 task_id):
  channel    = 'aun'
  channelId  = msg.from          // 对端 AID，等价于 Feishu DM chat_id
  userId     = msg.from
  chatType   = 'private'

单聊话题消息 (message.received，有 task_id):
  channel    = 'aun'
  channelId  = msg.from          // 同一对端，同一 session
  replyContext.taskId       = task_id         // 当前话题
  replyContext.parentTaskId = parent_task_id  // 话题回溯（如有）

群聊消息 (event/group.message_created，无 task_id):
  channel    = 'aun'
  channelId  = msg.group_id      // 群组标识，等价于 Feishu 群 chat_id
  userId     = msg.sender_aid    // 发言人 AID
  chatType   = 'group'

群聊话题消息 (event/group.message_created，有 task_id):
  channel    = 'aun'
  channelId  = msg.group_id
  userId     = msg.sender_aid
  replyContext.taskId = task_id
```

---

## 四、Owner / 权限

```json
// evolclaw.json
{
  "owners": [
    { "channel": "feishu", "userId": "ou_xxxx" },
    { "channel": "wechat", "userId": "wxid_xxxx" },
    { "channel": "aun",    "userId": "alice.agentid.pub" }
  ]
}
```

AUN 群组自带 owner/admin/member/observer 四级角色，与 EvolClaw 的 admin/user
权限体系完全独立，互不干涉。EvolClaw 只关心 config.owners 中的 AID。

---

## 五、Sidecar RPC 接口

Sidecar 对 EvolClaw 暴露最小接口，屏蔽所有 AUN 协议细节。

### EvolClaw → Sidecar

```jsonc
// 发送消息（单聊）
{ "method": "send", "params": { "channelId": "bob.aid.pub", "text": "hello", "taskId": "task_01xxx" } }

// 发送消息（群聊）
{ "method": "send", "params": { "channelId": "grp_abc123", "text": "hello", "taskId": "task_01xxx" } }
```

### Sidecar → EvolClaw

```jsonc
// 收到消息
{
  "event": "message",
  "channelId": "bob.aid.pub",       // 单聊: 对端AID / 群聊: group_id
  "userId": "bob.aid.pub",          // 发言人 AID
  "text": "hello",
  "taskId": "task_01xxx",           // 主话题标识（可选，有则为话题消息）
  "parentTaskId": "task_parent",    // 话题回溯（可选）
  "chatType": "private",            // "private" | "group"
  "mentions": ["my.aid.pub"]        // @mention 列表（可选）
}

// Sidecar 就绪
{ "event": "ready", "aid": "evolclaw.agentid.pub" }

// 连接断开
{ "event": "disconnected", "reason": "..." }
```

---

## 六、AunChannel 实现骨架

```typescript
// src/channels/aun.ts
class AunChannel {
  private sidecar: ChildProcess;
  private onMessageCallback: (channelId: string, content: InboundMessage) => void;

  async connect() {
    this.sidecar = spawn('python', ['aun_bridge.py'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, AUN_AID: this.config.aid }
    });
    // 读 stdout JSON-RPC events，等待 { event: 'ready' }
  }

  async sendMessage(channelId: string, text: string, context?: ReplyContext) {
    this.write({ method: 'send', params: { channelId, text, taskId: context?.taskId } });
  }

  onMessage(handler: (channelId: string, content: InboundMessage) => void) {
    this.onMessageCallback = handler;
  }
}
```

```typescript
// src/index.ts — adapter 注册（~15行）
const adapter: ChannelAdapter = {
  name: 'aun',
  sendText: (channelId, text, ctx) => aun.sendMessage(channelId, text, ctx),
};
processor.registerChannel(adapter, { systemPromptAppend: '...' });
cmdHandler.registerAdapter(adapter);
aun.onMessage(async (channelId, content) => {
  await messageQueue.enqueue(`aun-${channelId}`, {
    channel: 'aun', channelId, content, timestamp: Date.now()
  });
});
```

---

## 七、配置结构

```json
// evolclaw.json 新增 aun channel 配置
{
  "channels": {
    "aun": {
      "aid": "evolclaw.agentid.pub",
      "keystorePath": "~/.aun/AIDs/",
      "gatewayUrl": "wss://gateway.agentid.pub",
      "flushDelay": 3
    }
  }
}
```

---

## 八、待开发计划

| 优先级 | 功能 | 说明 |
|---|---|---|
| P0 | 单聊文本收发 | 核心功能，无 task_id 消息流 |
| P0 | 群聊文本收发 | group_id 映射，@mention 过滤 |
| P1 | 话题会话 | task_id / parent_task_id → ReplyContext |
| P1 | 消息持久性 | persist 策略配置（默认 false） |
| P2 | 文件收发 | Storage 协议对接 |
| P2 | 消息撤回 | event/message.recalled 处理 |
| P3 | 跨 Issuer 路由 | 协议层实现后自动生效，无需改动 |

---

## 九、工作量估算

| 组件 | 行数 | 说明 |
|---|---|---|
| `aun_bridge.py` | ~150行 | Python sidecar，AUNClient 封装 |
| `src/channels/aun.ts` | ~80行 | ChannelAdapter 实现 |
| `src/index.ts` 新增 | ~15行 | adapter 注册 |
| `evolclaw.json` 新增 | ~8行 | aun channel 配置 |
| EvolClaw core 改动 | 0行 | 零改动 |
