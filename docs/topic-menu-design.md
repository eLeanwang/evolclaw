# 话题会话 menu.* 管理 — 方案定稿

> 状态：**已实现**（2026-06-09；2026-06-11 扩展 `rename`）
> 关联：[`aun-menu-protocol-dev-guide-v2.2.md`](./aun-menu-protocol-dev-guide-v2.2.md)、[`thread-decoupling-refactor.md`](./thread-decoupling-refactor.md)、[`multi-session-design.md`](./multi-session-design.md)
> 日期：2026-06-09

## 1. 背景与目标

前端（Evol App）通过 `menu.*` 协议管理 evolclaw / evolagent / 会话状态。当前 `menu.*` 已覆盖 CLI 式主会话（`name=session`），但**话题会话（thread/话题）尚无独立管理入口**。

本方案为话题会话设计 `name=topic` 的 menu 接口（options / query / rename / delete），供前端在权限范围内查看与操作话题；并补齐一条**全渠道**的话题创建准入规则。

## 2. 核心认知：两条正交的会话轴

代码中存在两条**路由模型根本不同**的会话轴，理解差异是本方案的前提。

| 维度 | CLI 式会话（主会话） | 话题会话（topic/thread） |
|---|---|---|
| `threadId` | `''`（空） | 非空 |
| 存储位置 | `chatDir/<sid>.jsonl` | `chatDir/_threads/<sid>.jsonl` + `_threads/thread-index.json` |
| `active.json` | **写入**（独占指针，`persistSession intent:'set'`） | **从不写**（`intent:'none'`，见 `session-manager.ts:284`） |
| 路由方式 | 手动独占切换：改 `active.json` 后裸消息都进它 | 自动并行路由：入站消息带 `threadId` → 直接命中对应 session |
| 并发模型 | 同一时刻**只有一个** active | 多话题**同时存活**，互不抢占 |
| 创建来源 | 用户显式 `/new` | 发起方分配 `thread_id`（Evol App / 飞书平台），首条消息带出 |

**结论**：话题没有"切换"语义——主会话靠 `active.json` 决定裸消息归属；话题靠传输层 `threadId` 路由。因此 `name=topic` **不提供 switch 动词**。

### 2.1 层级关系

```
channelId（一个聊天，私聊或群聊）
├── 主会话（CLI 式，active.json 独占指针，/s 切换）
└── 话题会话（并行，按 threadId 路由，_threads/ 下）—— 与主会话平级，不属于任何主会话
```

## 3. 设计决策（已逐条评审拍板）

| # | 决策 | 说明 |
|---|---|---|
| 1 | 独立命名空间 `name=topic` | 不并入 `session`；动词集不同（session 独占切换，topic 并行管理） |
| 2 | menu 动词 = options / query / rename / delete | 无 switch（无切换语义）、无 new（App 自助）、rename/delete 按同一管理权限 |
| 3 | 句柄用 `threadId` | `args.target = threadId`；内部经 thread-index 映射 sessionId |
| 4 | 创建不在 menu | Evol App 造 threadId + 首条消息带出，evolclaw 被动一聊就造（同 Feishu 机制） |
| 5 | menu 管理参考 `name=session` 接入 | AUN `MessageBridge.MENU_NAME_MAP` 与 ECWeb `execMenuForEcweb` nameMap 均支持 `topic`；Feishu 等普通 IM 渠道目前无法直接消费 menu 协议 |
| 6 | 创建准入全渠道 | 群聊 guest/anonymous 不能建话题，所有渠道生效 |
| 7 | projectPath 取 `resolveByChannel(channel).projectPath` | 每 agent 仅一个项目目录，与主会话同源，不绕 active 主会话 |
| 8 | chatType 跟所在 channelId 一致 | 私聊下话题为 private，群聊下为 group |
| 9 | delete 软删 | `unbindSession` → 移入 `_trash` + 出 thread-index |
| 10 | 名字唯一性：channelId 下主会话+话题共享名字空间 | 沿用现有 `getSessionByName` 行为 |
| 11 | 话题从 `/s` `/slist` 剥离 | 两轴真正独立 |

## 4. 话题创建准入（全渠道，非 menu）

话题创建走普通消息路径（不经 menu），故准入控制必须发生在**入站建 session 之前**。当前实现有两层：

- 主路径：`message-bridge.ts` 在调用 `getOrCreateSession()` 前检查，能向用户回复「群聊中无权限创建话题」
- 防御层：`message-processor.ts` `resolveSession` 在 `getOrCreateSession()` 前再次检查，防止绕过 bridge 的非 trigger/owner-inject 消息建新话题

**规则**：

```
if (chatType === 'group' && message.threadId) {
  const existing = await sessionManager.getThreadSession(channel, channelId, threadId)
  if (!existing) {                         // 新话题（thread-index 查不到）
    role = sessionManager.resolveIdentity(channel, peerId).role
    if (role !== 'owner' && role !== 'admin') {
      → 回错误「群聊中无权限创建话题」，不建 session
    }
  }
  // existing 命中：放行（已存在话题，任何角色可继续发消息）
}
```

| 场景 | 允许创建话题 |
|---|---|
| 私聊 + 任意角色 | ✅ |
| 群聊 + admin/owner | ✅ |
| 群聊 + guest/anonymous | ❌ 拒绝 + 回「群聊中无权限创建话题」 |

**关键边界**：拦的是**新建**（threadId 在 thread-index 查不到）。**已存在的话题**，guest 继续在其中发消息**放行**——否则 admin 建的话题别人无法参与。

**creator 记录**：建话题时把发送者 `message.peerId` 写入 `session.metadata.peerId`（复用现有字段），供 delete 鉴权；后续同一话题内其它用户发言不会覆盖该创建者字段。

**topic name**：话题显示名创建时传入，优先读取普通消息 `topicName` 字段，兼容 `replyContext.title` / `replyContext.metadata.topicName` / `replyContext.metadata.title`。

## 5. 协议设计：`name=topic`

### 5.1 动词总览

| 操作 | 协议类型 | 句柄 | 说明 |
|---|---|---|---|
| 列举话题 | `menu.options` `{name:'topic'}` | — | 返回本 channelId 下所有话题 |
| 查单话题 | `menu.query` `{name:'topic', args:{target}}` | `target=threadId` | 返回该话题状态 |
| 重命名话题 | `menu.action` `{name:'topic', action:'rename', args:{target,name}}` | `target=threadId` | 修改话题显示名 |
| 删除话题 | `menu.action` `{name:'topic', action:'delete', args:{target}}` | `target=threadId` | 软删 + 出 thread-index |

### 5.2 options（列举，对齐 `getSubMenuItems('/s')`）

```json
→ { "type":"menu.options", "id":"x1", "name":"topic" }
← { "type":"menu.response", "id":"x1", "name":"topic", "data":[
     { "value":"<threadId>", "label":"重构讨论",
       "turns":12, "preview":"帮我看下…", "lastActive":1730000000000,
       "agentSessionId":"abcd1234" }
   ] }
```

字段对齐主会话 options，差异：
- `value` 用 **threadId**（主会话用 name/sid 前8位）
- **无 `selected`**（话题无 active 概念）

### 5.3 query（查单个，对齐 `name=session` query）

```json
→ { "type":"menu.query", "id":"x2", "name":"topic", "args":{"target":"<threadId>"} }
← { "type":"menu.response", "id":"x2", "name":"topic", "data":{
     "threadId":"<threadId>",
     "name":"重构讨论", "agentSessionId":"…", "status":"idle",
     "createdAt":…, "updatedAt":…, "turns":12 } }
```

字段对齐 `command-handler.ts:884`：`name / agentSessionId / status(processing|idle) / createdAt / updatedAt`，可选 `processingDuration / queueLength / turns / lastSuccess / consecutiveErrors / lastError`，额外回 `threadId`。

### 5.4 rename（重命名）

```json
→ { "type":"menu.action", "id":"x3", "name":"topic", "action":"rename",
    "args":{ "target":"<threadId>", "name":"新话题名" } }
← { "type":"menu.response", "id":"x3", "name":"topic",
     "data":{ "action":"rename", "success":true,
              "topic":{ "id":"<sessionId>", "threadId":"<threadId>", "name":"新话题名" } } }
```

实现：`getThreadSession(target)` → 鉴权 → `renameSession(session.id, name)`，如有 `agentSessionId` 同步 runner session 标题。

### 5.5 delete（软删）

```json
→ { "type":"menu.action", "id":"x4", "name":"topic", "action":"delete",
    "args":{ "target":"<threadId>" } }
← { "type":"menu.response", "id":"x4", "name":"topic", "data":{ "deleted":true } }
```

实现：`getThreadSession(target)` → `unbindSession(session.id)`（已处理 `_threads/*.jsonl` 移入 `_trash` + thread-index 清理）。

### 5.6 错误码

| code | 触发 |
|---|---|
| `NOT_SUPPORTED` | 未知 action |
| `NOT_FOUND` | `target` threadId 在 thread-index 不存在 |
| `MISSING_VALUE` | 缺 `args.target` 或 rename 缺 `args.name` |
| `CONFLICT` | rename 的新名称已存在 |
| `FORBIDDEN` | 鉴权不通过 |

## 6. 权限矩阵（menu 操作）

| 场景 | anonymous | guest | admin / owner |
|---|---|---|---|
| 私聊 | 无 | options / query / rename / delete（**限自己创建**） | 全部 |
| 群聊 | 无 | options / query（只读，所有话题） | 全部 |

- anonymous 一律无权限
- 私聊 guest：自己的地盘，话题都是自己建的，读写均可；rename/delete 仍校验 `metadata.peerId === userId`（创建者约束）
- 群聊 guest：群是公共空间，可浏览全量话题（options）与查状态（query），但**不能建、不能重命名/删除**
- rename/delete「需是创建者」约束实际只作用于私聊 guest（群聊 guest 本就无写权限）；admin/owner 无此限制

## 7. 实现接线点（底层 primitives 已全）

| 能力 | 现成方法 | 位置 |
|---|---|---|
| threadId → session | `getThreadSession(channel, channelId, threadId)` | `session-manager.ts:894` |
| 列举话题 | `listSessions()` 过滤 `s.threadId` | `:911` |
| 重命名 | `renameSession(sessionId, newName)` | `:1029` |
| 删除（thread-index 感知） | `unbindSession(sessionId)` | `:1038` |
| 已知 threadId 列表 | `getKnownThreadIds(channel)` | `:415` |

**改动清单**：

1. **创建准入**：`message-bridge.ts` 建 session 前加主闸；`message-processor.ts` `resolveSession` 加防御闸（见 §4）。
2. **`message-bridge.ts` `MENU_NAME_MAP` / `command-handler.ts` ECWeb nameMap**：新增 `topic: '/topic'`（伪命令前缀，仅 menu 路由分发，不进 `commands[]`）。
3. **`command-handler.ts` `getMenuItems()`**：新增「话题管理」分组（仅一项 `cmd:'/topic'`，`next:{type:'select', dynamic:true}`）。
4. **`command-handler.ts` `getSubMenuItems()`**：新增 `if (cmd === '/topic')` 分支，`listSessions` 过滤 `s.threadId`，`value=threadId`，复用 fileInfo/preview 拼装。
5. **`command-handler.ts` `execMenuQuery()`**：新增 `/topic` 分支，`args.target=threadId` → `getThreadSession` → 返回状态。
6. **`command-handler.ts` `execMenuAction()`**：新增 `/topic` 分支，支持 `rename` / `delete`：`getThreadSession(target)` → `renameSession` 或 `unbindSession`；未知 action → `NOT_SUPPORTED`。
7. **鉴权**：options/query/rename/delete 按 §6 矩阵收敛（关系级 role，非进程级 owner）。rename/delete 私聊 guest 校验 creator。

**前置清理（话题从 `/s` `/slist` 剥离）**：

8. **`getSubMenuItems('/s'|'/session'|'/del')`**：过滤掉 `s.threadId`，`name=session` options 只剩主会话，`/del` 不再删除话题。
9. **`/slist`**（:3318 一带）：不再展示 `[话题]` 行。
10. **`/s <序号/名/uuid>` 切换**（:3367）：候选集排除 `s.threadId`；即使命中 thread session 也返回错误，不写 `active.json`。

## 8. 不做的事（语义诚实边界）

- ❌ `topic switch` — 话题靠 threadId 传输路由，无切换语义
- ❌ `topic new` 在 menu — App 自助（本地造 threadId + 首条消息带出）
- ❌ 话题进 `active.json` / 进 `/s` 候选
- ❌ Feishu 等普通 IM 渠道直接消费 menu 话题管理（无法消费 menu 协议）；ECWeb 走 `execMenuForEcweb` 已接入

## 9. 测试要点（已覆盖/待扩展）

- **创建准入**：群聊 guest 发新 threadId → 拒绝 + 错误文案；群聊 admin 发新 threadId → 建成；已存在话题群聊 guest 发消息 → 放行；私聊任意角色 → 建成。
- **options**：仅返回 `threadId` 非空的 session；`name=session` options 不再混入话题。
- **query**：`target` 不存在 → `NOT_FOUND`；字段与 `name=session` query 对齐。
- **rename**：`target` 不存在 → `NOT_FOUND`；缺 `name` → `MISSING_VALUE`；私聊 guest 改非自己创建 → `FORBIDDEN`；成功后同步 DB/FS 与 runner session 标题。
- **delete**：`target` 不存在 → `NOT_FOUND`；私聊 guest 删非自己创建 → `FORBIDDEN`；删除后 `_threads/*.jsonl` 入 `_trash` 且 thread-index 同步。
- **回归**：`getSubMenuItems('/s')` / `/slist` / `/s` 切换均**不再**含话题。
