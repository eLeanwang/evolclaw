# 非 AUN 渠道经 AUN 代理接入 EvolClaw 方案

## 1. 结论

Feishu、微信、钉钉、QQBot、企业微信等非 AUN 渠道不再作为 EvolClaw 内部的独立身份域。它们只是用户连接到 canonical AID 的入口。

本方案确定以下原则：

1. 权限、角色、关系、预算、模型、effort、permission mode、chatmode 等按 canonical AID 匹配。
2. 非 AUN 渠道的 `peerId`、`peerKey` 不再参与身份和配置解析。
3. `agents/<agent_aid>/connect.json` 是代理连接到 canonical AID 的授权映射。
4. 入口渠道的原生会话参数全部由代理保存，EvolClaw 不保存和解析 `open_id`、`union_id`、`chat_id`、`context_token`、`root_id`、`thread_id` 等路由参数。
5. 每个代理入口会话与一个 EvolClaw `session_id` 一对一绑定。
6. AUN 仍是实际传输层；非 AUN 渠道是用户入口和最终呈现层。
7. 不保留旧 `<channel>#...` 配置兼容读取，只提供一次性迁移。

整体关系如下：

```text
canonical principal
  principalAid = elean.agentid.pub
        |
        | connect.json 授权
        v
AUN proxy connection
  proxyAid + connectionId
        |
        | proxy 内部绑定
        v
origin actor / conversation / thread

origin route <----1:1----> EvolClaw session_id
```

## 2. 身份、传输和会话必须分开

### 2.1 Canonical 身份

canonical 身份是 AID：

```text
principalAid = elean.agentid.pub
principalKey = aid#elean.agentid.pub
```

它用于：

- owner/admin/自定义角色判断
- `relations/` 关系配置
- 关系级模型和 effort
- 关系级 permission mode、chatmode
- peer budget 和 role subject budget
- 用量统计中的 principal 归属
- ECK 中的 `peerId`、`peerKey` 和关系档案

Feishu `open_id`、微信 openid、钉钉 unionId、QQ/企业微信原生用户 ID 等不再进入上述任何 key。

### 2.2 传输身份

EvolClaw 在网络上实际看到的发送方是代理 AID：

```text
transportPeerAid = channel-proxy.agentid.pub
transportChannel = aun
```

代理 AID 只负责：

- AUN 鉴权
- 消息投递
- 加密和 ACK
- 代理连接授权
- 出站回复目标

代理 AID 不能直接替代最终用户身份，否则同一个代理下的所有入口用户都会被识别为同一个 peer。

### 2.3 会话身份

会话由 EvolClaw `session_id` 唯一标识：

```text
session_id = meta_20260710_...
```

代理内部的 origin route 与 `session_id` 一对一绑定。EvolClaw 不需要根据入口渠道参数计算 session key。

必须注意：群聊中一个 session 可以有多个发言者。`session_id` 标识对话，`principalAid` 标识当前这条消息的发言者，两者不能合并。

## 3. connect.json

### 3.1 作用

`connect.json` 不保存渠道配置，也不保存入口渠道原生用户 ID。它表达的是：

> 某个已认证的代理 AID，可以通过指定 connection 声明某个 canonical AID。

文件位置：

```text
agents/<agent_aid>/connect.json
```

推荐结构：

```json
{
  "$schema_version": 1,
  "connections": [
    {
      "connectionId": "conn_7d82175f2a6b4e6e",
      "principalAid": "elean.agentid.pub",
      "viaAid": "channel-proxy.agentid.pub",
      "enabled": true,
      "createdAt": "2026-07-10T08:00:00.000Z"
    }
  ]
}
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `connectionId` | 代理生成的稳定 opaque ID，不包含渠道账号信息 |
| `principalAid` | canonical 用户 AID |
| `viaAid` | 被授权声明该用户的代理 AID |
| `enabled` | 是否允许该连接 |
| `createdAt` | 审计字段 |

唯一约束：

```text
(viaAid, connectionId) -> principalAid
```

同一个 `principalAid` 可以有多个 connection，例如不同设备、不同代理或不同入口。

### 3.2 入站身份解析

代理发送：

```json
{
  "principal": {
    "aid": "elean.agentid.pub",
    "connection_id": "conn_7d82175f2a6b4e6e"
  }
}
```

EvolClaw 使用 AUN 已认证发送方作为 `viaAid`，执行严格匹配：

```text
connect.json[
  viaAid == authenticated AUN sender
  && connectionId == payload.principal.connection_id
  && principalAid == payload.principal.aid
  && enabled == true
]
```

未命中时 fail closed，消息不能进入命令处理、session 创建或模型队列。

直接 AUN 消息不需要 connection：

```text
principalAid = authenticated AUN sender AID
```

### 3.3 统一 PrincipalContext

身份解析只做一次，后续模块消费统一结果：

```ts
interface PrincipalContext {
  principalAid: string;
  principalKey: string;       // aid#<encoded AID>
  transportPeerAid: string;   // direct AUN 时等于 principalAid；代理时为 proxy AID
  connectionId?: string;
  authenticated: boolean;
  delegated: boolean;
}
```

禁止各模块继续自行使用 `channelType + peerId` 拼配置 key。

## 4. 入口渠道类型

本方案覆盖所有非 AUN 渠道。Feishu 是第一落地目标，其它渠道复用相同的代理协议和 session 绑定模型。

| 入口渠道 | origin type | 典型 actor ID | 典型 conversation ID | 特殊路由参数 | 首批要求 |
| --- | --- | --- | --- | --- | --- |
| Feishu | `feishu` | `open_id` / `union_id` | `chat_id` | `message_id` / `root_id` / `thread_id` / `file_key` / `image_key` | 完整对齐现有 `feishu.ts` |
| WeChat | `wechat` | openid / 用户标识 | conversation/context | `context_token` / client message id | 文本、图片、文件、typing/状态 |
| DingTalk | `dingtalk` | unionId / staffId | conversationId | stream offset / conversation token | 文本、文件、图片、卡片 |
| QQBot | `qqbot` | user id | guild/channel/direct message id | message id / seq / guild id | 文本、图片、文件、按钮 |
| WeCom | `wecom` | user id | chat id / bot id | webhook key / message id | 文本、图片、文件 |

入口渠道的原生 ID 都只用于代理内部 route 和 native API 调用，不进入 EvolClaw 的关系、角色、预算、模型 key。

## 5. 代理会话绑定

### 5.1 一对一模型

代理维护：

```text
ProxyRoute  <----1:1---->  EvolClaw session_id
```

其中 `ProxyRoute` 是代理内部概念。不同入口渠道可以使用不同原生字段组成 route，例如：

```text
feishu:   targetAid + connectorId + chatId + threadId
wechat:   targetAid + connectorId + openid/contextToken
dingtalk: targetAid + connectorId + conversationId + threadId
qqbot:    targetAid + connectorId + guildId/channelId/userId/threadId
wecom:    targetAid + connectorId + chatId/userId/threadId
```

这些字段只用于代理查表，不发给 EvolClaw，也不参与 EvolClaw 身份配置。

数据库推荐结构：

```sql
CREATE TABLE session_bindings (
  binding_id          TEXT PRIMARY KEY,
  target_aid          TEXT NOT NULL,
  origin_type         TEXT NOT NULL,
  origin_connector_id TEXT NOT NULL,
  origin_conversation TEXT NOT NULL,
  origin_thread       TEXT NOT NULL,
  evolclaw_session_id TEXT UNIQUE,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (
    target_aid,
    origin_type,
    origin_connector_id,
    origin_conversation,
    origin_thread
  )
);
```

`binding_id` 是代理生成的 opaque ID。EvolClaw 只看到 `binding_id` 和 `session_id`。

### 5.2 首条消息

首条消息还没有 `session_id`，流程如下：

```text
1. 入口渠道消息到达代理。
2. 代理按内部 ProxyRoute 查询 session binding。
3. 未命中时创建或复用一个 pending binding_id。
4. 代理向 EvolClaw 发送 session_id 为空、binding_id 非空的消息。
5. EvolClaw 按 (proxyAid, binding_id) 幂等创建 session。
6. EvolClaw 返回 session.bound，包含 binding_id + session_id。
7. 代理原子写入一对一绑定。
8. 后续消息直接携带 session_id。
```

协议示例：

```json
{
  "type": "proxy.message",
  "proxy_version": 1,
  "binding_id": "bind_394c8c7ab83845c6",
  "session_id": null,
  "principal": {
    "aid": "elean.agentid.pub",
    "connection_id": "conn_7d82175f2a6b4e6e"
  },
  "entry": {
    "type": "feishu",
    "connector_id": "fs-main",
    "chat_type": "private",
    "capabilities": [
      "text",
      "markdown",
      "image",
      "file",
      "interaction",
      "reaction",
      "recall",
      "thread"
    ]
  },
  "message": {
    "id": "pxmsg_02fb...",
    "kind": "text",
    "text": "你好"
  }
}
```

绑定确认：

```json
{
  "type": "proxy.session.bound",
  "binding_id": "bind_394c8c7ab83845c6",
  "session_id": "meta_20260710_1783670000000"
}
```

### 5.3 幂等要求

代理可以串行化同一 ProxyRoute 的首条消息，但仅靠代理不足以覆盖以下情况：

```text
EvolClaw 已创建 session
  -> session.bound 回复尚未到达
  -> 代理崩溃
  -> 代理重试首条消息
```

因此 EvolClaw 必须保证：

```text
(authenticated proxyAid, binding_id) -> 唯一 session_id
```

这只是 session 创建幂等索引，不是第二套渠道 session 路由。

### 5.4 已绑定消息

携带 `session_id` 时，EvolClaw：

1. 按 `session_id` 精确读取 session。
2. 校验 session 属于当前目标 agent。
3. 校验 `(proxyAid, binding_id)` 与 session 创建记录一致。
4. 解析当前消息的 `PrincipalContext`。
5. 将消息放入该 session 队列。

不得再回退到 `channelId` 或 active session 猜测。

### 5.5 Session 切换

`/session new`、`/session switch` 等操作发生后，EvolClaw 返回：

```json
{
  "type": "proxy.session.rebind",
  "binding_id": "bind_394c8c7ab83845c6",
  "previous_session_id": "meta_old",
  "session_id": "meta_new"
}
```

代理在同一个事务中更新 binding。旧 session 继续保留历史，但不再接收该 ProxyRoute 的新消息。

## 6. 代理协议边界

### 6.1 EvolClaw 应看到的字段

EvolClaw 只需要：

- AUN authenticated sender，即 proxy AID
- `binding_id`
- `session_id`
- canonical `principal.aid`
- `principal.connection_id`
- 用户入口类型 `entry.type`
- 入口连接标识 `entry.connector_id`
- `entry.chat_type`
- 有效能力集合
- 标准化消息内容
- 标准化附件、引用、mentions 和 interaction

### 6.2 只保存在代理的字段

以下入口渠道原生字段不进入 EvolClaw session 路由和身份配置：

- `open_id`
- `union_id`
- `chat_id`
- `app_id`
- `context_token`
- `conversation_id`
- `guild_id`
- `channel_id`
- `bot_id`
- `message_id`
- `event_id`
- `parent_id`
- `root_id`
- `thread_id`
- `file_key`
- `image_key`
- reaction ID
- CardKit/interactive message ID

代理可以在自己的审计和路由库中保存这些字段。

### 6.3 出站协议

EvolClaw 的每一条代理出站消息都必须携带：

```json
{
  "type": "proxy.result",
  "binding_id": "bind_394c8c7ab83845c6",
  "session_id": "meta_20260710_1783670000000",
  "kind": "text",
  "text": "回复内容"
}
```

代理按 `session_id` 查回 origin route，再使用保存的原生参数发送。

不能依赖 `correlation_id` 作为长期会话路由。`correlation_id` 只适合单次请求/响应关联和审计，重启、主动发送、trigger、`ctl send` 都必须依赖持久化 `session_id` 绑定。

## 7. 入口渠道原生能力归属

代理是入口渠道原生协议的唯一 owner。EvolClaw core 不再处理 Feishu message ID、微信 context token、钉钉 conversation cursor、QQ guild/channel ID、企业微信 botId 等渠道细节或 SDK 错误码。

### 7.1 通用能力矩阵

能力转换如下：

| 入口渠道能力 | 代理职责 | EvolClaw 接口 |
| --- | --- | --- |
| 消息去重、过期过滤 | 代理完成 | 标准入站消息 |
| text/markdown/rich text 解析 | 代理完成 | text/structured content |
| 引用消息拉取 | 代理完成 | quote item |
| 转发/合并消息展开 | 代理完成 | 多个标准 message item |
| 图片下载 | 代理完成 | AUN image/attachment |
| 文件下载 | 代理完成 | AUN file/attachment |
| markdown/rich text 出站转换 | 代理完成 | result.text |
| 图片/文件上传 | 代理完成 | result.image/result.file |
| thread/reply/context token | 代理完成 | session_id + generic reply |
| queued/started 反馈 | 代理映射到渠道可用反馈 | status.queued/status.started |
| 撤回 | 代理映射原生消息 ID 后发 generic recall | message.recalled |
| 交互卡片 | 代理渲染和回调 | generic interaction |
| 卡片过期/更新 | 代理完成 | interaction state |
| 渠道错误码降级 | 代理完成 | delivery result/error |

各渠道能力不完全相同，代理必须声明当前入口实际支持的能力集合。EvolClaw 根据代理声明和自身能力取交集渲染提示，不直接使用 AUN adapter 的能力作为入口能力。

### 7.2 Feishu 与现有 feishu.ts 的关系

当前 `/home/evolclaw/projects/aunproxy` 是 Python，不能直接 import TypeScript 的 `src/channels/feishu.ts`。

推荐目标是把 `feishu.ts` 中的原生能力拆成明确的协议契约和测试夹具：

```text
Origin channel event
  -> normalized proxy message

generic proxy result
  -> origin channel API operation
```

短期在 Python 代理中实现契约对齐；长期若要求真正共享同一份实现，应把 Feishu edge 抽成独立 Node 模块/服务，或将代理迁移到 TypeScript。其它渠道也遵循同一契约：每个原生 adapter 必须把入站事件标准化为 proxy message，把 generic proxy result 转换回原生 API。禁止长期维护无契约约束的渠道行为。

当前 `aunproxy` 只支持 Feishu P2P text，不能视为与 `feishu.ts` 能力对齐。切换前至少需要补齐：

- 群聊和 mention
- thread
- quote
- image/file
- post/markdown
- merge_forward
- recall
- reaction ACK
- interaction card
- 长消息拆分和错误降级

### 7.3 其它非 AUN 渠道

其它入口渠道按同一方式接入：

| 渠道 | 代理 native adapter 必须处理 |
| --- | --- |
| WeChat | `context_token`、图片/文件、typing/状态、消息去重、长连接/HTTP 回调重试 |
| DingTalk | stream offset、conversationId、文件/图片、卡片按钮、机器人群聊 mention |
| QQBot | guild/channel/direct message、图片/文件、按钮回调、消息 seq/去重 |
| WeCom | botId/webhook key、用户/群聊 ID、图片/文件、卡片/模板消息能力 |

这些能力在 EvolClaw 中都只表现为标准 `proxy.message`、`proxy.result`、`message.recalled`、`interaction` 和状态事件。

## 8. EvolClaw 运行时改造

### 8.1 Identity Resolver

新增统一 resolver，例如：

```text
src/config/connect-map.ts
src/core/identity/principal-resolver.ts
kits/schemas/connect.schema.1.json
```

移除运行时对 `contact.json` alias 的依赖。

所有身份相关模块接收 `PrincipalContext`，不再自行拼 `peerKey`。

### 8.2 MessageBridge

`src/core/message/message-bridge.ts` 需要：

1. 识别 `proxy.message`。
2. 在命令处理前验证 connect mapping。
3. 按 `session_id` 精确路由。
4. 无 `session_id` 时按 `(proxyAid, binding_id)` 幂等创建 session。
5. 每条消息保存当前 `principalAid`，群聊不能复用上一条消息的角色。
6. 将 `entry.type`、`entry.chat_type`、capabilities 传给渲染和响应引擎。

### 8.3 SessionManager

`src/core/session/session-manager.ts` 需要新增：

- `getBoundSessionById(selfAid, sessionId)`
- `getOrCreateProxyBoundSession(proxyAid, bindingId, ...)`
- `(proxyAid, bindingId)` 幂等索引
- session binding ownership 校验
- rebind event

代理绑定 session 不使用 `active.json` 作为入站路由真相源。`active.json` 可以继续服务直接渠道和 CLI，但代理消息只认显式 `session_id`。

session 本身仍可将 `channelId` 保存为 proxy AID，用于 AUN 出站。多个代理绑定 session 可以位于同一个 proxy chat 目录，因为实际选择由 `session_id` 完成。

### 8.4 统一配置选择器

新增单一函数：

```ts
function principalSelector(ctx: PrincipalContext, selfAid: string) {
  return {
    self: selfAid,
    peerKey: ctx.principalKey,
  };
}
```

以下位置改为使用它：

- access/role
- response mode
- permission mode
- model/effort
- chatmode
- slash/menu authorization
- peer budget
- role usage subject
- usage stats

禁止继续出现：

```ts
formatPeerKey(currentChannelType, message.peerId)
formatPeerKey(session.channelType, session.channelId)
```

### 8.5 Prompt 和 ECK

渲染变量改为：

```text
channel          = <entry.type>  # 用户实际入口，例如 feishu/wechat/dingtalk/qqbot/wecom
entryChannel     = <entry.type>
transportChannel = aun
peerId           = canonical principal AID
peerKey          = aid#canonical principal AID
```

capabilities 使用代理声明且 EvolClaw 允许的交集，不直接使用 AUN adapter 的全部能力。

这样入口渠道代理消息可以加载对应场景提示，例如 Feishu 可加载 `feishu-private.md` / `feishu-group.md`，微信可加载 `wechat-private.md` / `wechat-group.md`。诊断信息仍能说明实际 transport 是 AUN。

### 8.6 Restart 和主动消息

`restart-pending.json` 不再保存入口渠道原生 reply/thread 字段，改存：

```json
{
  "channel": "aun#<selfAid>#main",
  "channelId": "channel-proxy.agentid.pub",
  "bindingId": "bind_...",
  "sessionId": "meta_..."
}
```

正常重启完成通知通过 AUN adapter 发给代理。

restart-monitor 在主进程无法启动时，如仍要求发送失败通知，应使用轻量 AUN sender 向 proxy AID 发送带 `session_id` 的通知，不再直接 import 任一入口渠道 SDK。

## 9. 配置和数据迁移

本次只做一次迁移，迁移完成后删除旧读取逻辑。

### 9.1 contact.json / 旧渠道 alias

对每个：

```text
<channel>:<native_actor_id> -> principalAid
```

执行：

1. 在代理中为该身份建立稳定 `connection_id`。
2. 代理内部保存 `connection_id -> origin actor`，例如 Feishu `open_id`、微信 openid、钉钉 unionId。
3. 在目标 agent 的 `connect.json` 写入：

```text
(proxyAid, connectionId) -> principalAid
```

4. 迁移完成后不再读取 `contact.json`。

### 9.2 私聊 relation

迁移：

```text
relations/<channel>#<native_actor_id>/
  ->
relations/aid#<principalAid>/
```

冲突规则：

1. canonical 目标已存在时，不静默覆盖。
2. 对 JSON 字段执行显式 merge 并输出报告。
3. 无法自动合并的字段写入 migration conflict 文件，迁移命令失败退出。
4. `profile.md` 等文本文件保留两份并要求人工选择，不能直接拼接成生效配置。

### 9.3 群和频道关系

旧 `<channel>#<native_conversation_id>` 表示的是 conversation/venue，不是用户身份，不能迁入 `connect.json`。

应迁移到 session/venue scope：

```text
relations/<channel>#<native_conversation_id>/
  ->
venues/<proxy-binding-or-venue-id>/
```

或者将需要随当前会话生效的字段迁移为 session override。

把群或频道的 native conversation ID 映射成某个 canonical 用户 AID 是错误迁移。

### 9.4 Budget 和模型

迁移私聊 key：

```text
<channel>#<native_actor_id>
  ->
aid#<principalAid>
```

覆盖：

- `data/stats/budgets.json` 的 `peers`
- relation model/effort
- relation permission mode
- relation chatmode/response mode
- role member assignment 中以旧渠道 ID 为 key 的条目

历史 usage 数据不参与运行时兼容。若要求报表连续性，可单独执行一次数据库 key 重写；否则新版本从切换时开始按 `principalKey` 统计。

### 9.5 Cutover

迁移步骤：

```text
1. 停止 EvolClaw 和代理写入。
2. 备份 agents/、data/stats/、session 数据和代理数据库。
3. 生成代理 connection_id。
4. 写 connect.json。
5. 迁移 private relation/budget/model 等 key。
6. 迁移 group relation 到 venue/session scope。
7. 扫描并确认不存在运行时旧 `<channel>#...` 身份 key。
8. 启动代理。
9. 启动 EvolClaw。
10. 发送测试消息并建立 session binding。
11. 禁用/删除 EvolClaw 直连非 AUN channel。
12. 删除 contact.json 和旧 alias resolver。
```

不设置双读期。

## 10. 代理实现改造

基于当前目录：

```text
/home/evolclaw/projects/aunproxy
```

主要改造：

| 模块 | 改造 |
| --- | --- |
| `src/core/models.py` | 新增 proxy message/result/session binding 协议 |
| `src/routing/router.py` | correlation 路由升级为 session binding 路由 |
| `src/routing/service.py` | 首次绑定、session rebind、generic payload 转换 |
| `src/core/message_store.py` | 增加 session binding 和 native message mapping 表 |
| `src/feishu/adapter.py` | 从 P2P text 扩展到完整 Feishu native adapter，作为首个契约实现 |
| `src/<origin>/adapter.py` | 后续接入 WeChat、DingTalk、QQBot、WeCom 等 native adapter |
| `src/aun/client.py` | 支持结构化 proxy payload 和 session_id |
| tests | 增加身份伪造、幂等、重启恢复、thread/card/file 等测试 |

现有 `correlation_id -> native actor id` 仍可保留用于单次消息审计，但不再承担长期反向路由。

## 11. 安全要求

### 11.1 代理声明身份

仅凭 payload 中的 `principal.aid` 不可信。必须同时满足：

- AUN sender 已认证
- sender 等于 connect entry 的 `viaAid`
- `connection_id` 精确匹配
- entry enabled
- target agent 正确

### 11.2 Session 劫持

携带合法 `session_id` 仍不能直接进入 session，必须验证：

```text
session.selfAid == target agent
session.proxyAid == authenticated sender
session.bindingId == payload.binding_id
```

### 11.3 重放和重复

- AUN message ID 去重
- 入口渠道 event/message ID 去重
- `(proxyAid, binding_id)` session 创建幂等
- interaction callback 去重
- recall 重复事件幂等

### 11.4 connection 吊销

禁用 connect entry 后：

- 新消息立即拒绝
- 已有 session binding 不赋予绕过权限
- 主动消息是否继续允许由代理 binding 状态决定
- 建议同步禁用代理中的 actor connection

## 12. 实施阶段

### Phase 1：协议与身份

- 定义 `connect.json` schema
- 实现 `PrincipalResolver`
- 定义 `proxy.message/result/session.bound/rebind`
- AUN 入站完成代理身份验证
- 所有配置选择器切换到 `principalKey`

### Phase 2：Session 绑定

- 代理 session binding 持久化
- EvolClaw 显式 `session_id` 路由
- 首条消息幂等创建
- `/session` 操作触发 rebind
- 主动发送、trigger、ctl 全部携带 `session_id`

### Phase 3：入口渠道能力对齐

- 以 Feishu 为首个 adapter，对齐 `feishu.ts` 入站解析
- 对齐图片、文件、引用、merge_forward 或各渠道等价能力
- 对齐 thread、reply、context token、recall 或各渠道等价能力
- 对齐 card/button/interaction 和 reaction/status ACK
- 对齐 markdown/post/rich text 和错误降级
- 为 WeChat、DingTalk、QQBot、WeCom 逐个补齐 native adapter 契约测试

### Phase 4：迁移和切换

- 执行一次性迁移
- 输出迁移报告和冲突清单
- 禁用 EvolClaw 直连非 AUN channel
- 删除旧运行时兼容逻辑

### Phase 5：清理

- 删除 `contact.json` resolver
- 删除旧渠道 peerKey 推导
- 删除 restart-monitor 直连入口渠道 SDK 直发
- 删除 core 中入口渠道原生 route 特判
- 视部署选择删除 direct 非 AUN plugin，或只保留为代理 native adapter

## 13. 验收标准

### 身份

- 同一用户通过直接 AUN 和任一入口渠道代理访问时得到相同角色。
- relation/model/effort/permission/budget 命中同一个 `principalKey`。
- 修改 Feishu `open_id`、微信 openid、钉钉 unionId 等原生 ID 不需要迁移 EvolClaw 关系配置，只更新代理 connection。
- 未在 `connect.json` 授权的代理身份声明被拒绝。

### Session

- 同一 origin route 重启代理和 EvolClaw 后仍命中原 `session_id`。
- 两个入口私聊/群/话题不会串 session。
- 并发首条消息只创建一个 session。
- `/session new` 和 `/session switch` 后代理绑定正确更新。
- `ctl send`、trigger、重启通知可以仅凭 `session_id` 投递回原入口 route。

### 群聊

- 同一个群 session 中，不同发言者按各自 canonical AID 解析角色和预算。
- session 不缓存并复用上一位发言者的角色。
- 群配置迁移到 venue/session scope，不伪装成用户 identity。

### 渲染

- 代理消息的 `channel` 为实际 `entry.type`。
- `transportChannel` 为 `aun`。
- 加载入口渠道场景提示，而不是 AUN 用户场景提示。
- 能力提示与代理实际支持能力一致。

### 入口渠道能力

- text/post/markdown/rich text、图片、文件、引用、转发或各渠道等价能力正常入站。
- thread/reply/context token 不丢失。
- recall 或各渠道等价撤回事件能中断对应 EvolClaw 消息。
- queued/started 状态映射为入口渠道可用反馈，例如 Feishu reaction、微信状态提示、钉钉卡片状态。
- interaction card/button 回调回到正确 session。
- 长消息和无效 reply target 有明确降级。

## 14. 最终边界

完成后，各层只承担以下职责：

```text
EvolClaw
  - canonical identity
  - role/relation/model/budget
  - session and agent execution
  - generic message/interaction semantics

AUN
  - authenticated transport
  - encryption
  - proxy delivery

Origin channel proxy
  - origin account/chat/thread/message mapping
  - session_id binding
  - native channel parsing and rendering
  - attachments/cards/reactions/recall
  - delivery retries and native error handling
```

这样 EvolClaw 不会因为实际 transport 是 AUN 而把最终用户识别成代理，也不会为了支持任一非 AUN 渠道而继续在 core 中保留原生 ID、thread、context token 等特判。
