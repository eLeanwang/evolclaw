# 微信 ilink 渠道接入改造计划

## Context

EvolClaw 是轻量 AI Agent 网关，当前支持 Feishu 和 AUN 两个渠道。微信官方发布了 ClawBot ilink API（`ilinkai.weixin.qq.com`），提供 HTTP 长轮询收消息 + REST 发消息的通道。本次改造目标是：

1. **阶段一**：消除核心层对渠道枚举 `'feishu' | 'aun'` 的硬编码，使新增渠道零侵入核心
2. **阶段二**：基于 ilink 官方协议新增微信渠道，走标准 ChannelAdapter 接入

设计原则：核心会话/用户模型不感知渠道细节；`context_token`/游标等渠道传输状态在 channel 内部闭环。

---

## 阶段一：渠道解耦（纯类型重构 + 消除 index.ts 业务分支）

### 1.1 `src/types.ts` — 泛化渠道类型

**当前问题**：`Session.channel`(L43)、`Message.channel`(L54)、`CommandHandler`(L82) 都写死 `'feishu' | 'aun'`。

**改动**：
- `Session.channel`: `'feishu' | 'aun'` → `string`
- `Message.channel`: `'feishu' | 'aun'` → `string`
- `CommandHandler` 类型的 `channel` 参数 → `string`
- `Config.owners`: `{ feishu?: string; aun?: string }` → `Record<string, string>`

**不改**：`ChannelAdapter`、`ChannelOptions`（已经是通用的）。

### 1.2 `src/core/session-manager.ts` — 方法签名泛化

**当前问题**：11 个方法写死 `channel: 'feishu' | 'aun'`。

**改动**：以下方法的 `channel` 参数类型从 `'feishu' | 'aun'` → `string`：
- `getOrCreateSession` (L201)
- `switchProject` (L278)
- `updateClaudeSessionId` (L318)
- `clearActiveSession` (L337)
- `getActiveSession` (L346)
- `listSessions` (L356)
- `getSessionByProjectPath` (L367)
- `getSessionByName` (L377)
- `switchToSession` (L387)
- `createNewSession` (L415)
- `getSessionByUuidPrefix` (L566)
- `importCliSession` (L580)

纯类型改动，零逻辑变更。DB schema 不动（`sessions.channel` 本来就是 TEXT）。

### 1.3 `src/core/command-handler.ts` — 方法签名泛化

**改动**：
- `ensureSession` (L102): `channel: 'feishu' | 'aun'` → `channel: string`
- `handle` (L134): `channel: 'feishu' | 'aun'` → `channel: string`

### 1.4 `src/config.ts` — owner 函数泛化

**改动**：
- `getOwner` (L67): `channel: 'feishu' | 'aun'` → `channel: string`
- `setOwner` (L71): `channel: 'feishu' | 'aun'` → `channel: string`
- `isOwner` (L79): `channel: 'feishu' | 'aun'` → `channel: string`

### 1.5 `src/core/message-processor.ts` — 删除类型断言

**改动**：
- L128: `message.channel as 'feishu' | 'aun'` → `message.channel`（删除断言，因为 SessionManager 已接受 string）

### 1.6 `src/index.ts` — 消除 sendFn 中的渠道分支

**当前问题**：L101-125 的 `sendFn` 闭包里有：
```typescript
if (channel === 'feishu') { ... feishu.sendFile ... feishu.sendMessage ... }
else if (channel === 'aun') { ... aun.sendMessage ... }
```
新增渠道就要加 `else if`。

**改动**：改为通过已注册的 adapter 查找发送：
```typescript
const sendFn = async (id: string, text: string) => {
  const adapter = cmdHandler.getAdapter(channel);
  if (!adapter) return;

  // 文件标记处理（通过 adapter.sendFile 能力判断，不按渠道名分支）
  if (adapter.sendFile) {
    const fileMarkerPattern = /\[SEND_FILE:([^\]]+)\]/g;
    const fileMatches = [...text.matchAll(fileMarkerPattern)];
    for (const match of fileMatches) {
      // ... 同现有逻辑 ...
      await adapter.sendFile(id, absoluteFilePath);
    }
    text = text.replace(fileMarkerPattern, '').trim();
  }

  if (text) {
    await adapter.sendText(id, text);
  }
};
```

**需要同时在 `CommandHandler` 增加**：
```typescript
getAdapter(channelName: string): ChannelAdapter | undefined {
  return this.adapters.get(channelName);
}
```

### 1.7 验证

- `npm run build` 零错误
- `npm test` 全量通过
- 手动验证 Feishu/AUN 行为不变（消息收发、命令、文件发送）

---

## 阶段二：微信渠道接入

### 2.1 新增 `src/channels/wechat.ts`

**类**：`WechatChannel`，对齐 `FeishuChannel` 的接口风格。

**构造函数**：
```typescript
interface WechatConfig {
  baseUrl: string;   // 默认 https://ilinkai.weixin.qq.com
  token: string;     // bot_token（扫码登录后获取）
}
```

**公开方法**：
- `connect()`: 启动 `getupdates` 长轮询循环（while 循环 + AbortController）
- `disconnect()`: 触发 AbortController.abort()
- `onMessage(handler: MessageHandler)`: 注册消息回调
- `sendMessage(to: string, text: string)`: 发送文本消息
  - 从 `contextTokenCache` 取 `context_token`
  - 缺 token 时拒发并记 error 日志
  - Markdown → 纯文本转换（参考官方 `stripMarkdown`）
  - 调用 `ilink/bot/sendmessage`

**内部状态**（全部在 channel 内部闭环，不外泄到核心层）：
- `contextTokenCache: Map<string, string>` — `from_user_id → context_token`（内存级，和官方源码一致：`/tmp/openclaw-weixin-src/package/src/messaging/inbound.ts:16`）
- `typingTicketCache: Map<string, { ticket: string; fetchedAt: number }>` — `from_user_id → typing_ticket`（内存级，带 TTL）
- `getUpdatesBuf: string` — 游标，持久化到文件 `{EVOLCLAW_HOME}/data/wechat-sync-buf.txt`

**收消息流程**（`connect()` 内部）：
```
while (!aborted) {
  resp = POST ilink/bot/getupdates { get_updates_buf }
  if (error) → 退避重试（同官方：3次连续失败后 backoff 30s）
  update get_updates_buf → 持久化到文件
  for (msg of resp.msgs) {
    if (msg.message_type !== 1) continue  // 只处理用户消息
    缓存 context_token
    提取文本（text_item / voice_item.text / ref_msg 引用）
    acknowledgeMessage(from_user_id)  // sendTyping
    回调 messageHandler(from_user_id, text, userId=from_user_id)
  }
}
```

**acknowledgeMessage 流程**（对标 Feishu 的 ✓ reaction）：
```
1. 检查 typingTicketCache 是否有有效 ticket
2. 若无/过期 → 调 ilink/bot/getconfig 获取 typing_ticket，缓存
3. 调 ilink/bot/sendtyping { status: 1 }
4. 失败静默（不阻塞主流程，和 Feishu addAckReaction 一致）
```

**ilink API 封装**（WechatChannel 内部 private 方法）：
- `apiFetch(endpoint, body, timeoutMs)` — 通用 POST JSON + Bearer token + X-WECHAT-UIN header
- `getUpdates(getUpdatesBuf)` → `ilink/bot/getupdates`
- `postSendMessage(body)` → `ilink/bot/sendmessage`
- `getConfig(userId, contextToken?)` → `ilink/bot/getconfig`
- `postSendTyping(body)` → `ilink/bot/sendtyping`

参考实现：
- 官方 API 封装：`/tmp/openclaw-weixin-src/package/src/api/api.ts`
- 官方 header 构建：`buildHeaders()`（L68-86）
- 官方消息解析：`/tmp/openclaw-weixin-src/package/src/messaging/inbound.ts:81-106` (`bodyFromItemList`)
- 官方发送构建：`/tmp/openclaw-weixin-src/package/src/messaging/send.ts:39-60` (`buildTextMessageReq`)
- 官方 context_token 缓存：`/tmp/openclaw-weixin-src/package/src/messaging/inbound.ts:16-37`
- 官方轮询循环：`/tmp/openclaw-weixin-src/package/src/monitor/monitor.ts:37-207`

### 2.2 `src/types.ts` — Config 增加 wechat 段

```typescript
wechat?: {
  enabled?: boolean;    // 默认 false
  baseUrl?: string;     // 默认 https://ilinkai.weixin.qq.com
  token?: string;       // bot_token
}
```

整段可选，缺失则渠道不启动。

### 2.3 `src/config.ts` — validateConfig 增加 wechat 校验

在 `validateConfig` 函数末尾增加（和 Feishu 校验风格一致）：
```typescript
if (config.wechat?.enabled && !config.wechat?.token) {
  logger.warn('⚠ WeChat enabled but token not configured (WeChat channel will be disabled)');
}
```

### 2.4 `src/index.ts` — 初始化 + 注册 + 接线

在现有 AUN 注册后增加 WeChat 块，模式完全对齐 Feishu/AUN：

```typescript
// ---- WeChat 渠道（条件初始化）----
let wechat: WechatChannel | null = null;

if (config.wechat?.enabled && config.wechat?.token) {
  wechat = new WechatChannel({
    baseUrl: config.wechat.baseUrl || 'https://ilinkai.weixin.qq.com',
    token: config.wechat.token,
  });

  const wechatAdapter: ChannelAdapter = {
    name: 'wechat',
    sendText: (channelId, text) => wechat!.sendMessage(channelId, text),
  };

  processor.registerChannel(wechatAdapter);
  cmdHandler.registerAdapter(wechatAdapter);

  wechat.onMessage(async (channelId, content, userId) => {
    content = content.trim();

    // 首次交互自动绑定主人
    if (userId && !config.owners?.wechat) {
      const { setOwner } = await import('./config.js');
      setOwner(config, 'wechat', userId);
      logger.info(`[Owner] Auto-bound WeChat owner: ${userId}`);
    }

    // 命令快速路径
    if (cmdHandler.isCommand(content)) {
      const cmdResult = await cmdHandler.handle(content, 'wechat', channelId, undefined, userId);
      if (cmdResult !== null) {
        if (cmdResult) {
          try {
            await wechat!.sendMessage(channelId, cmdResult);
          } catch (error) {
            logger.error('[WeChat] Failed to send command response:', error);
          }
        }
        return;
      }
    }

    const session = await sessionManager.getOrCreateSession(
      'wechat', channelId, config.projects?.defaultPath || process.cwd()
    );

    await messageQueue.enqueue(
      `wechat-${channelId}`,
      { channel: 'wechat', channelId, content, timestamp: Date.now(), userId },
      session.projectPath
    );
  });
}

// 连接渠道列表增加 wechat
const channelInstances = [
  { name: 'Feishu', instance: feishu },
  { name: 'AUN', instance: aun },
  ...(wechat ? [{ name: 'WeChat', instance: wechat }] : []),
];
```

shutdown 逻辑也要加上 `wechat?.disconnect()`。

### 2.5 首版不做

| 功能 | 原因 | 计划 |
|------|------|------|
| 图片/文件入站 | CDN 下载 + AES-128-ECB 解密链路 | 二期 |
| 文件出站 `[SEND_FILE:]` | CDN 上传 + 加密链路 | 二期 |
| 群聊 | 官方 ClawBot 目前只支持单聊 | 等官方支持 |
| 扫码登录 | 首版手动配 token | 二期做 `/wechat setup` 命令 |
| 语音消息（带音频） | 需 SILK 转码 | 二期（文字转写已支持） |

### 2.6 功能对照表（WeChat vs Feishu）

| 功能 | Feishu | WeChat 首版 |
|------|--------|------------|
| 文本收发 | ✅ | ✅ |
| 多项目/多会话 | ✅ | ✅（核心层，渠道无关） |
| 斜杠命令 | ✅ | ✅ |
| 消息中断 | ✅ | ✅ |
| 安全模式 | ✅ | ✅ |
| Owner 绑定 | ✅ | ✅ |
| 收到消息确认 | ✓ reaction | sendTyping 打字指示器 |
| Markdown 渲染 | 转 Feishu Post | 转纯文本 |
| 首条回复引用 | replyToMessageId | 不支持（ilink 无 reply-to） |
| 引用消息解析 | API 回查 parent_id | 入站 ref_msg 字段直接提取 |
| 图片入站 | ✅ base64 | ❌ 二期 |
| 文件收发 | ✅ SEND_FILE | ❌ 二期 |
| 群聊 | ✅ | ❌ 官方未支持 |

---

## 验证方案

### 阶段一验证
```bash
npm run build    # 零 TypeScript 错误
npm test         # 全量通过（现有 21 个测试文件）
```
手动验证：Feishu 消息收发、命令执行、文件发送均不受影响。

### 阶段二验证
1. 配置 `evolclaw.json` 加入 wechat 段（token 从扫码登录获取）
2. 启动服务，日志应显示 `✓ WeChat connected`
3. 微信发 "你好" → EvolClaw 日志显示 getupdates 收到消息 → Agent 处理 → sendmessage 回复
4. 微信发 `/status` → 收到会话状态回复
5. 重启服务 → 验证游标恢复（不重复拉历史消息）
6. 验证 Feishu/AUN 不受影响

```bash
npm run build
npm test
EVOLCLAW_HOME=/home/evolclaw npm run dev  # 热重载开发测试
```

---

## 改动影响范围汇总

### 阶段一（修改 5 个文件，零新增）
| 文件 | 改动性质 |
|------|----------|
| `src/types.ts` | 类型泛化 |
| `src/core/session-manager.ts` | 类型泛化（11处签名） |
| `src/core/command-handler.ts` | 类型泛化 + 新增 `getAdapter()` 方法 |
| `src/config.ts` | 类型泛化（3处签名） |
| `src/index.ts` | sendFn 改为 adapter 查找（消除 if/else 分支） |
| `src/core/message-processor.ts` | 删除 1 处类型断言 |

### 阶段二（新增 1 个文件，修改 3 个文件）
| 文件 | 改动性质 |
|------|----------|
| `src/channels/wechat.ts` | **新增**：微信渠道实现 |
| `src/types.ts` | Config 增加 `wechat?` 段 |
| `src/config.ts` | validateConfig 增加 wechat 校验 |
| `src/index.ts` | 初始化 + 注册 + 接线 + shutdown |
