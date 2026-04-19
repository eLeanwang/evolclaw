# QQBot Channel Design Spec

> EvolClaw QQ Bot 渠道集成设计文档
> 日期：2026-04-19

---

## 一、目标

为 EvolClaw 新增 QQ Bot 消息渠道，支持私聊（C2C）和群聊（@消息），文本 + 图片 + 文件双向收发。

## 二、决策摘要

| 决策项 | 选择 | 理由 |
|--------|------|------|
| SDK | `pure-qqbot` v2.0.0 | ESM 原生，仅依赖 ws，与 EvolClaw 架构最契合 |
| 消息类型 | 文本 + 图片 + 文件（收发） | 覆盖主要使用场景 |
| 聊天类型 | C2C + 群聊 | 不做频道/频道私信（API 完全独立，场景不同） |
| 发送格式 | 默认 Markdown，失败 fallback 纯文本 | 自动适应平台权限，无需配置开关 |
| 回复方式 | 仅被动回复（携带 msg_id） | 主动消息每月配额极低（4条/用户），窗口过期则丢弃 |
| 群聊门控 | 不需要 | QQ Bot API 群聊事件本身就是 `GROUP_AT_MESSAGE_CREATE`，只有 @bot 才推送 |

## 三、SDK 接口（pure-qqbot v2.0.0）

### 3.1 构造与生命周期

```typescript
import { QQBotClient, MessageEvent } from 'pure-qqbot';

const client = new QQBotClient({
  appId: string,
  clientSecret: string,
  sessionDir?: string,        // 会话持久化目录（跨重启可恢复连接）
  typingKeepAlive?: boolean,  // 处理消息期间发送"正在输入"
  parseFaceEmoji?: boolean,   // QQ 表情标签 → 可读文本
  logger?: Logger,            // 自定义日志
});

await client.start();
client.startBackgroundRefresh();  // 后台 token 自动刷新

// 销毁
client.stopBackgroundRefresh();
client.stop();
```

### 3.2 消息接收

```typescript
client.onMessage(async (event: MessageEvent) => {
  // event.type: 'c2c' | 'group' | 'guild' | 'dm'
  // event.senderId: string (user_openid / member_openid)
  // event.senderName?: string
  // event.content: string
  // event.messageId: string
  // event.groupOpenid?: string (群聊时)
  // event.attachments?: MessageAttachment[] (图片/文件)
});
```

### 3.3 消息发送

```typescript
// 被动回复（推荐，携带 msg_id）
await client.reply(event, content);

// 指定方法
await client.sendPrivateMessage(openid, content, msgId);
await client.sendGroupMessage(groupOpenid, content, msgId);

// Markdown（需平台开通）
await client.sendPrivateMarkdown(openid, content, msgId);

// 媒体
await client.sendPrivateImage(openid, fileUrl);
await client.sendGroupImage(groupOpenid, fileUrl);
await client.sendPrivateFile(openid, fileUrl);
await client.sendGroupFile(groupOpenid, fileUrl);
```

## 四、类型定义变更（`src/types.ts`）

在 `DingtalkChannelInstanceConfig` 之后添加：

```typescript
export interface QQBotChannelConfig {
  name?: string;
  enabled?: boolean;
  appId: string;
  clientSecret: string;
  owner?: string;
  flushDelay?: number;
  debounce?: number;
  showActivities?: 'all' | 'dm-only' | 'owner-dm-only' | 'none';
}

export interface QQBotChannelInstanceConfig extends QQBotChannelConfig {
  name: string;
}
```

在 `Config.channels` 中添加：
```typescript
qqbot?: QQBotChannelConfig | QQBotChannelInstanceConfig[];
```

注意：没有 `markdownSupport` 配置项 — Markdown/纯文本自动切换，发送失败时 fallback。

## 五、QQBotChannel 实现（`src/channels/qqbot.ts`）

### 5.1 QQBotChannel 类

```
文件: src/channels/qqbot.ts
依赖: pure-qqbot, ../utils/logger.js, ../utils/media-cache.js
```

**内部状态**：

| 字段 | 类型 | 用途 |
|------|------|------|
| `client` | `QQBotClient \| null` | SDK 客户端 |
| `seenMessages` | `Map<string, number>` | msgId → timestamp，去重用 |
| `chatTypeCache` | `Map<string, 'private' \| 'group'>` | chatId → chatType，出站路由 |
| `msgIdCache` | `Map<string, string>` | chatId → 最近入站 msgId，被动回复用 |
| `groupOpenidCache` | `Map<string, string>` | chatId → groupOpenid，群聊出站时需要 |
| `markdownFailed` | `boolean` | 全局标记，Markdown 发送失败后降级纯文本（平台级权限） |
| `cleanupInterval` | timer | 定期清理过期 dedup 条目 |
| `projectPathProvider` | callback | 解析 chatId → projectPath |

**公开方法（可测试）**：

- `isDuplicate(msgId: string): boolean` — 去重检查
- `resolveChatId(event: MessageEvent): string` — 群聊用 `event.groupOpenid`，私聊用 `event.senderId`

**生命周期**：

- `connect()`:
  1. 校验 appId/clientSecret（非空，非 placeholder）
  2. `new QQBotClient({ appId, clientSecret, sessionDir, typingKeepAlive: true, logger })`
  3. `client.onMessage(handler)` — 注册消息处理
  4. `await client.start()`
  5. `client.startBackgroundRefresh()`
  6. 启动 dedup 清理定时器（1h 周期，清理 24h 前的条目）
- `disconnect()`:
  1. `client.stopBackgroundRefresh()`
  2. `client.stop()`
  3. 清除定时器

**入站消息处理** (`handleIncoming`):

1. 过滤 `event.type` — 只处理 `'c2c'` 和 `'group'`，忽略 `'guild'` / `'dm'`
2. 去重 — `isDuplicate(event.messageId)`
3. 解析 chatId — 私聊 `event.senderId`，群聊 `event.groupOpenid`
4. 缓存 chatType、msgId、groupOpenid
5. 按消息内容分发：
   - 纯文本（无 attachments 或 attachments 为空）→ 提取 `event.content`，dispatch
   - 图片附件 → 下载（`safeFetch` + `skipSsrfCheck: true`）→ `validateImage` → base64 传给 Agent
   - 文件附件 → 下载 → `saveToUploads` → 告知 Agent 文件路径
   - 图文混合 → 提取文本 + 下载图片，合并 dispatch

**出站文本发送** (`sendMessage`):

```
1. 查 chatTypeCache → 确定 private/group
2. 查 msgIdCache → 取被动回复 msgId
3. 如果 markdownFailed === false：
   a. 尝试 Markdown 发送（sendPrivateMarkdown / sendGroupMessage with msg_type=2）
   b. 成功 → 返回
   c. 失败（权限不足）→ 设 markdownFailed = true，继续步骤 4
4. 纯文本 fallback：
   a. markdownToPlainText(content)
   b. sendPrivateMessage / sendGroupMessage（msg_type=0）
```

**出站图片发送** (`sendImage`):

```
1. 将 Buffer 写入临时文件
2. 查 chatTypeCache → 确定 private/group
3. 调用 client.sendPrivateImage / sendGroupImage
```

**出站文件发送** (`sendFile`):

```
1. 检测文件是否是图片 → 是则走 sendImage
2. 查 chatTypeCache → 确定 private/group
3. 调用 client.sendPrivateFile / sendGroupFile
```

### 5.2 Markdown Fallback 机制

不用配置开关。运行时自动检测：

- 首次发送默认尝试 Markdown（msg_type=2）
- 如果 API 返回错误（权限不足），设置全局 `markdownFailed = true`（Markdown 权限是平台级的，不是 per-chat）
- 后续所有 chat 直接用纯文本
- 纯文本发送前用 `markdownToPlainText()` 转换

`markdownToPlainText()` 当前是 `wechat.ts` 的私有函数。QQBot 也需要它，应提取到共享位置 `src/utils/format.ts`（或直接在 qqbot.ts 内复制一份，视代码量决定）。

### 5.3 QQBotChannelPlugin

和 DingtalkChannelPlugin 完全对齐：

```typescript
export class QQBotChannelPlugin implements ChannelPlugin {
  readonly name = 'qqbot';

  isEnabled(config: Config): boolean {
    // 检查 config.channels.qqbot，验证 appId/clientSecret 非空非 placeholder
  }

  async createChannels(config: Config): Promise<ChannelInstance[]> {
    // normalizeChannelInstances → 遍历 → 创建 QQBotChannel + adapter + policy + options
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    // 委托 createChannels，返回第一个
  }
}
```

**adapter**:
```typescript
{
  channelName: inst.name || 'qqbot',
  sendText: (id, text) => channel.sendMessage(id, text),
  sendFile: (id, filePath) => channel.sendFile(id, filePath),
  sendImage: (id, png) => channel.sendImage(id, png),
}
```

**policy**: 和 DingTalk 一致（owner 权限控制，群聊 prefix，showActivities 层级）。

**options**:
```typescript
{
  fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g,
  supportsImages: true,
  flushDelay: inst.flushDelay,
}
```

## 六、注册接入（`src/index.ts`）

### 6.1 导入和注册

```typescript
import { QQBotChannelPlugin } from './channels/qqbot.js';

channelLoader.register(new QQBotChannelPlugin());
```

### 6.2 消息桥接

在 `channelType === 'dingtalk'` 块之后添加：

```typescript
if (channelType === 'qqbot') {
  msgBridge.register(inst.adapter.channelName,
    (handler) => inst.channel.onMessage(async (opts: any) => {
      handler({
        channel: channelType,
        channelId: opts.channelId,
        content: opts.content,
        chatType: opts.chatType || 'private',
        peerId: opts.peerId || '',
        peerName: opts.peerName,
        messageId: opts.messageId,
        images: opts.images,
      });
    }),
    (channelId, text) => inst.channel.sendMessage(channelId, text),
    inst.adapter,
    channelType
  );
}
```

## 七、Config 变更（`src/config.ts`）

- `channelTypes` 数组添加 `'qqbot'`
- `validateConfig` 添加校验：和 DingTalk 一样，检查 appId/clientSecret 完整性

## 八、共享工具提取

`markdownToPlainText()` 从 `src/channels/wechat.ts` 提取到 `src/utils/format.ts`，供 WeChat 和 QQBot 共用。WeChat 改为从 format.ts 导入。

## 九、配置格式（`evolclaw.json`）

单实例：
```jsonc
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "your-app-id",
      "clientSecret": "your-client-secret",
      "owner": "user-openid-of-admin",
      "flushDelay": 3
    }
  }
}
```

多实例：
```jsonc
{
  "channels": {
    "qqbot": [
      { "name": "qq-prod", "appId": "...", "clientSecret": "...", "owner": "..." },
      { "name": "qq-dev",  "appId": "...", "clientSecret": "...", "owner": "..." }
    ]
  }
}
```

## 十、文件变更清单

| 文件 | 变更 |
|------|------|
| `package.json` | 添加 `pure-qqbot` 依赖 |
| `src/types.ts` | 新增 `QQBotChannelConfig`, `QQBotChannelInstanceConfig`, `Config.channels.qqbot` |
| `src/config.ts` | `channelTypes` 加 `'qqbot'`，`validateConfig` 加 QQBot 校验 |
| `src/utils/format.ts` | **新建** — 提取 `markdownToPlainText()` 共享工具 |
| `src/channels/wechat.ts` | 改为从 `../utils/format.js` 导入 `markdownToPlainText` |
| `src/channels/qqbot.ts` | **新建** — `QQBotChannel` + `QQBotChannelPlugin` |
| `src/index.ts` | 导入 + 注册 + 消息桥接 |
| `tests/unit/qqbot-channel.test.ts` | **新建** — 单元测试 |

## 十一、关键注意事项

| 问题 | 说明 | 处理 |
|------|------|------|
| Token 刷新 | access_token 2h 过期 | SDK `startBackgroundRefresh()` 自动管理 |
| 被动回复约束 | 必须携带原始 `msg_id` | `msgIdCache` 缓存最近入站 msgId |
| 被动回复窗口 | C2C 60分钟 / 群聊 5分钟 | 窗口过期则丢弃，不尝试主动发送 |
| Markdown 权限 | 需平台侧开通 | 自动 fallback：先尝试 Markdown，失败后降级纯文本 |
| 消息去重 | 网络抖动可能重推 | 按 `messageId` 去重（Map + 1h 清理） |
| chatType 路由 | 发送时需区分 C2C/群 | 入站时缓存 `chatId → chatType` 映射 |
| 主动消息配额 | 每月每用户/群仅 4 条 | 不做主动消息 |
| 频道/频道私信 | API 和事件完全独立 | 不做，只处理 c2c + group 事件 |
| 图片/文件附件 | `event.attachments` 包含 url | 入站时下载处理，出站用 SDK 媒体方法 |
| sessionDir | 跨重启恢复 WebSocket 会话 | 设为 `{EVOLCLAW_HOME}/data/qqbot-session/` |

## 十二、架构对齐验证

| 维度 | Feishu | WeChat | DingTalk | QQBot |
|------|--------|--------|----------|-------|
| Channel 类 | `FeishuChannel` | `WechatChannel` | `DingtalkChannel` | `QQBotChannel` |
| Plugin 类 | `FeishuChannelPlugin` | `WechatChannelPlugin` | `DingtalkChannelPlugin` | `QQBotChannelPlugin` |
| 传输协议 | WebSocket (Lark SDK) | HTTP long-poll | WebSocket (Stream SDK) | WebSocket (Gateway v2) |
| SDK | @larksuiteoapi/node-sdk | 无（原生 HTTP） | dingtalk-stream | pure-qqbot |
| 认证方式 | appId + appSecret | token | clientId + clientSecret | appId + clientSecret → OAuth2 |
| 配置位置 | `channels.feishu` | `channels.wechat` | `channels.dingtalk` | `channels.qqbot` |
| 多实例支持 | 是 | 是 | 是 | 是 |
| ChannelAdapter | sendText, sendFile, sendImage, acknowledge | sendText, sendFile | sendText, sendFile, sendImage | sendText, sendFile, sendImage |
| 发送格式 | 富文本/Markdown | 纯文本 | Markdown | Markdown → 纯文本 fallback |
| 图片入站 | 是 | 否 | 是 | 是 |
| 文件入站 | 是 | 否 | 是 | 是 |

## 十三、不做的事（YAGNI）

- 频道/频道私信支持
- 主动消息发送
- `markdownSupport` 配置开关（用自动 fallback 替代）
- 群聊 @门控配置（API 天然过滤）
- 语音/视频消息
- Inline Keyboard / 交互按钮
- 流式消息（sendStreamMessage）
