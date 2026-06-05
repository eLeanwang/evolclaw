# AUN Agent 控制面设计方案

**日期**：2026-06-04  
**状态**：待实现  
**背景**：让 AUN 网络中已授权的客户端（owner）通过纯 AUN menu protocol 管理 daemon 上的 evolagent 生命周期。纯通道协议控制，无 HTTP 协议转换。

---

## 一、问题与目标

当前创建/删除/启停 agent 只能通过本地 `evolclaw agent` CLI。目标是让授权的 AUN 客户端通过 AUN 自定义消息远程管理 agent：

- 复用已有 menu protocol 框架（`message-bridge.ts` 的 `handleCustomPayload`）
- 纯 AUN 通道内协议控制，**无 HTTP 协议转换**（与 ControlTunnel 不同）
- 授权不依赖 session/channel owner 绑定，直接查 `defaults.owners`
- 支持：创建、删除、启用、停用、列表、详情

**与 ControlTunnel 的区别**：

| | ControlTunnel | AUN Agent 控制面（本设计） |
|---|---|---|
| 协议 | HTTP over AUN tunnel（集成进 fastaun SDK） | 纯 AUN menu protocol |
| 转换 | HTTP↔AUN | 无转换 |
| 用途 | 暴露本机 HTTP 服务 | 管理 evolagent 生命周期 |
| 承载 | fastaun SDK + daemon 调用 | 扩展 message-bridge + command-handler |

---

## 二、Menu Name 层级框架

这是指导 menu protocol 演进的概念框架。**「层级」指操作对象（操作什么），不是前置条件（需要什么参数）**——会话级操作也可以不带 session id。

| 层级 | 操作对象 | menu name | 鉴权来源 |
|---|---|---|---|
| **进程级** | daemon 进程 / agent 集合生命周期 | `system`、`agent`（★新增） | `defaults.owners` |
| **agent 级** | 单个 agent 全局配置 | `baseagent`、`pwd` | `resolveIdentity` |
| **关系级** | 对端关系（按 peerId） | `model`、`effort`、`perm`、`trigger` | `resolveIdentity` |
| **会话级** | 某个会话参数 | `chatmode`、`session`、`dispatch`、`activity` | `resolveIdentity` |

**关系级已有的底层基础**（暂未暴露 menu 操作，供未来参考）：
- `PeerIdentityCache`（`src/core/relation/peer-identity.ts`）——按 peerId 缓存对端身份
- `relations/` 目录（`agents/<aid>/relations/<peerKey>/`）
- `peerKey` 格式（`src/core/relation/peer-key.ts`）
- trigger 的 peerId scoping（`src/core/trigger/manager.ts`）

**本次代码实际改动**：仅两个进程级 name。agent/关系/会话级的归类是概念框架，本次不重构其鉴权。

---

## 三、Menu Protocol 方法语义

四个方法的语义边界（来自 `command-handler.ts` + `message-bridge.ts`）：

| 消息类型 | 方法 | 语义 | 判断标准 |
|---|---|---|---|
| `menu.query` | `execMenuQuery` | **查询当前状态** | 读，无副作用 |
| `menu.options` | `getSubMenuItems` | **列出候选/列表** | 枚举候选值（baseagent/model 选择器）或集合列表（trigger list、agent list） |
| `menu.update` | `execMenuUpdate` | **修改配置中某个值** | 写，可逆，无生命周期影响 |
| `menu.action` | `execMenuAction` | **生命周期状态调整或不可逆操作** | 创建/删除/启停/取消等 |

**判断规则**：
- 读状态 → `query`
- 列可选值（用于下拉/选择器）→ `options`
- 改某个配置值（可逆）→ `update`
- 触发生命周期变化或不可逆操作 → `action`

---

## 四、协议消息格式

### Agent 操作（name: `"agent"`，进程级）

**列表 → `menu.options`**（`options`: `enabled`（默认）/ `all`）：
```json
{ "type": "menu.options", "id": "r1", "name": "agent", "args": { "options": "enabled" } }
{ "type": "menu.options", "id": "r2", "name": "agent", "args": { "options": "all" } }
```

**查询单个 agent 状态 → `menu.query`**：
```json
{ "type": "menu.query", "id": "r4", "name": "agent", "args": { "aid": "mybot.example.agentid.pub" } }
```

**生命周期操作 → `menu.action`**：
```json
{ "type": "menu.action", "id": "r4", "name": "agent", "action": "create",
  "args": {
    "aid": "mybot.example.agentid.pub",
    "name": "MyBot",
    "baseagent": "claude",
    "project": "/home/user/projects/mybot",
    "model": "sonnet",
    "chatmode": { "private": "interactive" }
  }
}
{ "type": "menu.action", "id": "r5", "name": "agent", "action": "delete",  "args": { "aid": "mybot.example.agentid.pub" } }
{ "type": "menu.action", "id": "r6", "name": "agent", "action": "enable",  "args": { "aid": "mybot.example.agentid.pub" } }
{ "type": "menu.action", "id": "r7", "name": "agent", "action": "disable", "args": { "aid": "mybot.example.agentid.pub" } }
```

### Trigger 操作（name: `"trigger"`，关系级）

`trigger` 本次一并补入 menu protocol（此前只有 slash 命令 `/trigger`，无结构化入口）。

**列表 → `menu.options`**（`options`: `enabled`（默认）/ `all`）：
```json
{ "type": "menu.options", "id": "t1", "name": "trigger", "args": { "options": "enabled" } }
{ "type": "menu.options", "id": "t2", "name": "trigger", "args": { "options": "all" } }
```

**修改调度参数 → `menu.update`**（可逆配置值，无生命周期影响）：
```json
{ "type": "menu.update", "id": "t3", "name": "trigger",
  "value": { "nameOrId": "daily-report", "scheduleValue": "0_10_*_*_*" } }
```

**生命周期操作 → `menu.action`**（创建 / 取消）：
```json
{ "type": "menu.action", "id": "t4", "name": "trigger", "action": "set",
  "args": {
    "name": "daily-report",
    "scheduleType": "cron",
    "scheduleValue": "0_9_*_*_*",
    "prompt": "生成日报",
    "targetSessionStrategy": "current"
  }
}
{ "type": "menu.action", "id": "t5", "name": "trigger", "action": "cancel",
  "args": { "nameOrId": "daily-report" } }
```

**关系级鉴权语义（保留现有 isAdmin 分支）**：
- admin → 可操作任意触发器（`getByName` / `getById`）
- 非 admin → scope 到 `(peerId, channel)`（`getByNameScoped` / `getByIdScoped`），避免信息泄露

**复用**：`handleTrigger` 内部逻辑（`parseTriggerSet` / `parseTriggerUpdate` / `manager.*` / `scheduler.*`），控制入口只做参数装配。

### 响应 → 复用 `menu.response`

**成功**：
```json
{ "type": "menu.response", "id": "r4", "name": "agent",
  "data": { "aid": "mybot.example.agentid.pub", "created": true } }
```

**失败**：
```json
{ "type": "menu.response", "id": "r4", "name": "agent",
  "error": { "code": "FORBIDDEN", "message": "操作需要owner权限" } }
```

**错误码**：`FORBIDDEN` / `CONFLICT`（AID已存在）/ `NOT_FOUND`（AID不存在）/ `INVALID_ARGS` / `INTERNAL`。

---

## 四、授权机制

### `DefaultsConfig` 新增 `owners` 字段

```typescript
// src/types.ts — DefaultsConfig
export interface DefaultsConfig {
  // ...已有字段...
  /** defaults.owners 提供全局 owner 基础（AID），与 per-agent owners 数组合并去重。
   *  用于进程级 menu 操作（system / agent）鉴权：仅名单内 AID 可执行。 */
  owners?: string[];
  admins?: string[];
  // ...
}
```

`defaults.json` 示例：
```json
{
  "owners": ["eleans-2022.agentid.pub"],
  "admins": ["elean.agentid.pub"]
}
```

机制作用域与 `admins` 相同：全局基础 + 与 per-agent `owners` 合并去重。

### 鉴权流程（进程级）

```
menu.action/query (name="agent" 或 "system") 到达 CommandHandler
  ↓ 发送方 AID = peerId（AUN 协议必带，见下）
  ↓ owners = loadDefaults()?.owners ?? []
  ↓ owners.includes(peerId)?
  ├─ 否 → { error: { code: "FORBIDDEN" } }
  └─ 是 → 执行操作
```

**关键约束**：进程级鉴权**不读** session/channel owner 绑定（`agentRegistry.getOwner`），**不调** `resolveIdentity`。直接比对 `defaults.owners` 与发送方 AID。无论是否有会话上下文，鉴权结果一致。

### peerId 始终可得（AUN 协议保证）

AUN 的 `message.received` / `group.message_created` 事件永远携带 `msg.from`（发送方 AID），见 `aun.ts:1029`（`fromAid = msg.from`）。evolclaw 据此构造 `channelId` 和 `peerId`。**AUN 不存在无发送方身份的自定义消息通道**——「身份即入口」是协议设计的必然。因此进程级鉴权所需的 `peerId` 在 menu handler 里始终有值。

### `name=system` 迁移

现有 `system`（restart/upgrade/cli）在 `execMenuAction/Query` 里用 `resolveIdentity` 判 `role==='owner'`。本次将其与 `agent` 对齐，统一改为 `defaults.owners` 鉴权。这是顺带的一致性修复。

---

## 五、操作执行（复用现有逻辑）

所有操作复用 `src/cli/agent.ts` 已导出的函数（CLI 与 AUN 控制面共用同一套，DRY）：

| 操作 | 复用的导出函数 | 签名 |
|---|---|---|
| create | `agentCreateNonInteractive` | `(opts: AgentCreateNonInteractiveOpts)` |
| delete | `agentDelete` | `(aid, purge=false)` |
| enable | `agentEnable` | `(aid)` |
| disable | `agentDisable` | `(aid)` |
| list | `agentList` | `()` |
| show | `agentShow` | `(aid)` |

均返回统一的 `AgentResult<T>`（`{ ok, error?, ... }`），control-handler 把它映射为 `menu.response`。

### 创建参数集

**必须提交**：

| 参数 | 说明 |
|---|---|
| `aid` | agent 的 AID |
| `name` | 显示名 |
| `baseagent` | `claude` / `codex` / `gemini` |

**可选（有兜底）**：

| 参数 | 兜底来源 |
|---|---|
| `project` | `defaults.json` `projects.rootPath` 合成 `<rootPath>/<aid第一段>`；或 `projects.defaultPath` |
| `model` | `defaults.json` `models.*` |
| `chatmode` | `defaults.json` `chatmode` |

**自动填充 / daemon 处理**：

| 参数 | 来源 |
|---|---|
| `channels.aun.owner` | 发送方 AID（peerId 自动填） |
| `enabled` | 创建后默认 true |
| `keystorePath` / `gateway` / `wellKnownUrl` | `config.json` `aun.*` 继承 |
| `admins` | `defaults.admins` 继承 |

---

## 六、改动落点

| 文件 | 改动 |
|---|---|
| `src/types.ts` | `DefaultsConfig` 新增 `owners?: string[]` |
| `src/core/message/message-bridge.ts` | `MENU_NAME_MAP` 加 `agent`、`trigger`（或直接处理） |
| `src/core/command-handler.ts` | `execMenuAction`/`execMenuQuery` 新增 `/agent`、`/trigger` 分支；进程级（`/agent`+`/system`）鉴权改为 `defaults.owners`；`/trigger` 复用现有 `handleTrigger` 内部逻辑 |
| `src/cli/agent.ts` | 复用已导出的 `agentCreateNonInteractive` / `agentDelete` / `agentEnable` / `agentDisable` / `agentList` / `agentShow` |

---

## 七、错误处理与测试

### 错误处理

- 鉴权失败 → `FORBIDDEN`，不泄露 agent 是否存在
- 创建时 AID 已存在 → `CONFLICT`
- delete/enable/disable 时 AID 不存在 → `NOT_FOUND`
- 缺必填参数（aid/name/baseagent）→ `INVALID_ARGS`
- 内部异常 → `INTERNAL`，详细原因写日志，不回传堆栈

### 测试

| 测试 | 内容 |
|---|---|
| 鉴权单测 | owners 名单内/外 AID 的放行与拒绝 |
| create 单测 | 必填校验、兜底填充、CONFLICT |
| delete/enable/disable 单测 | NOT_FOUND、正常路径 |
| list/show 单测 | 返回结构 |
| 迁移测试 | `system` 改用 owners 后，名单外 AID 被拒 |
| trigger menu 单测 | set/update/cancel/query 经 menu 入口；admin 全局 vs 非 admin scoped 隔离 |

---

## 八、交付边界

| 模块 | 本次实现 |
|---|---|
| `DefaultsConfig.owners` 字段 | ✅ |
| 进程级鉴权（owners，含 system 迁移） | ✅ |
| `name=agent` 的 create/delete/enable/disable/list/show | ✅ |
| `name=trigger` 的 set/update/cancel/query（补 menu protocol） | ✅ |
| 协议消息解析与 menu.response 回发 | ✅ |
| 单元测试 | ✅ |
| agent/关系/会话级鉴权重构 | ❌ 不在本次范围（概念框架记录供未来） |

---

## 九、未决事项

无。

### 已决事项（自审 + 复核）

- ✅ list/show 直接透传 `agentList()` / `agentShow()` 的完整 `AgentResult` 结构，不裁剪——进程级操作仅 owner 可用，无需隐藏敏感字段
- ✅ `DefaultsConfig.projects` 同时有 `rootPath` 和 `defaultPath`（`src/types.ts:619`），project 兜底可用
- ✅ 复用函数均已导出于 `src/cli/agent.ts`：`agentCreateNonInteractive` / `agentDelete` / `agentEnable` / `agentDisable` / `agentList` / `agentShow`
- ✅ enable/disable 是 `agentEnable/agentDisable`（cli/agent.ts），非 registry 方法
- ✅ AUN 消息必带发送方 AID（`aun.ts:1029`），进程级鉴权所需 peerId 始终可得
