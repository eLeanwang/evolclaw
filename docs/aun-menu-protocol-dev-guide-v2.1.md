# Menu Protocol — 客户端集成指南

> 本文是 EvolClaw `menu.*` 协议**唯一权威**集成文档。面向客户端开发者（App / Bot / Web UI / CLI）。
> 协议在 AUN `message.send` 之上传输 JSON payload，与文本消息共享同一通道。

最后更新：2026-06-05
对应代码：`src/types.ts` · `src/core/message/message-bridge.ts` · `src/core/command-handler.ts` · `src/core/message/command-handler-agent-control.ts` · `src/channels/aun.ts`

---

## 1. 协议概览

Menu Protocol 让远端客户端能够：

- **发现**当前 agent 可用的命令树
- **查询**配置项当前值
- **列举**配置项可选值
- **修改**配置项
- **触发**动词类操作（中断、重启、新建、删除...）

协议定义 6 种消息类型：

| type | 方向 | 用途 | 返回字段 |
|---|---|---|---|
| `menu.list` | 客户端 → Agent | 拉取**菜单结构**（按角色裁剪的命令树） | `data: MenuGroup[]` |
| `menu.query` | 客户端 → Agent | 查询某项**当前值** | `data: { ... }` |
| `menu.options` | 客户端 → Agent | 列举某项**可选值** | `data: MenuItem[]` |
| `menu.update` | 客户端 → Agent | 修改某项配置 | `data: { ... }` |
| `menu.action` | 客户端 → Agent | 触发**动词**操作 | `data: { action, success, ... }` |
| `menu.response` | Agent → 客户端 | 统一应答 | `data` 或 `error`，互斥 |

不识别 `menu.*` 类型的旧客户端会忽略这些消息，不影响普通文本通信。

---

## 2. 字段定义

### 2.1 menu.list

```typescript
interface MenuListRequest {
  type: 'menu.list';
  id: string;
}
```

### 2.2 menu.query / menu.options

```typescript
interface MenuQueryRequest {
  type: 'menu.query';
  id: string;
  name: string;
  cmd?: string;          // 逃生口：直接指定内部命令路径
  args?: Record<string, any>;  // 结构化参数（如 agent query 的 { aid }）
}

interface MenuOptionsRequest {
  type: 'menu.options';
  id: string;
  name: string;
  cmd?: string;
  args?: Record<string, any>;  // 结构化参数（如 agent/trigger options 的 { options: 'all'|'enabled' }）
}
```

### 2.3 menu.update

```typescript
interface MenuUpdateRequest {
  type: 'menu.update';
  id: string;
  name: string;
  value: string;
  cmd?: string;
}
```

### 2.4 menu.action

```typescript
interface MenuActionRequest {
  type: 'menu.action';
  id: string;
  name: string;
  action: string;        // 'stop' / 'restart' / 'new' / 'delete' / ...
  args?: Record<string, any>;
  cmd?: string;
}
```

### 2.5 menu.response

```typescript
interface MenuResponse {
  type: 'menu.response';
  id: string;            // 回显请求 id
  name?: string;         // 回显请求 name（menu.list 无 name）
  data?: any;            // 成功时（与 error 互斥）
  error?: { code: string; message: string };
}
```

通过 `data` / `error` 字段是否存在判断成败，无 `ok` 字段。响应中**不再回显 `cmd`**——客户端用 `id` 配对，用 `name` 区分语义即可。

---

## 3. name 能力矩阵

| name | list | query | options | update | action | 作用层级 | 说明 |
|---|:---:|:---:|:---:|:---:|:---:|---|---|
| (root) | ✅ | — | — | — | — | 进程级 | 菜单树，按角色裁剪 |
| `pwd` | — | ✅ | — | — | — | agent 级 | 无会话时 fallback evolagent 配置 |
| `session` | — | ✅ | ✅ | — | `stop` `new` `delete` `compact` `fork` `switch` | 会话级 | 部分 action 需要有活跃会话 |
| `baseagent` | — | ✅ | ✅ | ✅ | — | agent 级 | 无会话时 fallback evolagent 配置 |
| `model` | — | ✅ | ✅ | ✅ | — | 关系级 | 无会话时 fallback evolagent 配置 |
| `effort` | — | ✅ | ✅ | ✅ | — | 关系级 | 无会话时 fallback evolagent 配置 |
| `chatmode` | — | ✅ | ✅ | ✅ | — | 会话级 | **仅私聊**；群聊/非 human 强制 proactive |
| `dispatch` | — | ✅ | ✅ | ✅ | — | 会话级 | **仅群聊会话** |
| `permission` | — | ✅ | ✅ | ✅ | — | 关系级 | 需要有活跃会话 |
| `activity` | — | ✅ | ✅ | ✅ | — | agent 级 | 无需会话 |
| `system` | — | ✅ | — | — | `restart` `check` `upgrade` | 进程级 | 鉴权：`evolclaw.json` `owners` 名单（见 §3.1） |
| `agent` | — | ✅ | ✅ | — | `create` `delete` `enable` `disable` | 进程级 | 鉴权：`evolclaw.json` `owners` 名单（见 §3.1） |
| `trigger` | — | — | ✅ | ✅ | `set` `cancel` | 关系级 | scoped 可见性，见 §8.6 |
| `cli` | — | — | — | — | `exec` | 进程级 | owner-only，白名单透传后端 CLI，见 §8.3 |

### 内部 cmd 映射

```typescript
MENU_NAME_MAP = {
  pwd:        '/pwd',
  session:    '/session',
  baseagent:  '/baseagent',
  model:      '/model',
  effort:     '/effort',
  chatmode:   '/chatmode',
  dispatch:   '/dispatch',
  permission: '/perm',
  activity:   '/activity',
  system:     '/system',
  cli:        '/cli',       // owner-only，透传后端 CLI（路由键，非真实 slash）
  agent:      '/agent',     // 进程级 owners 鉴权，evolagent 生命周期管理
  trigger:    '/trigger',   // 关系级，自主触发器
}
```

未在表中的 `name` → 客户端可改用 `cmd` 字段直传内部命令路径。推荐**优先用 `name`**。

### 3.1 Name 作用层级与鉴权

**「层级」指操作对象（操作什么），不是前置条件（需要什么参数）**。四层框架：

| 层级 | 操作对象 | menu name | 鉴权来源 |
|---|---|---|---|
| **进程级** | daemon 进程 / evolagent 集合生命周期 | `system`、`agent` | `evolclaw.json` `owners` 名单（静态 AID 比对） |
| **agent 级** | 单个 agent 全局配置（无论当前有无会话） | `baseagent`、`pwd` | `resolveIdentity`（channel 角色） |
| **关系级** | 对端关系级配置（按 peerId 隔离） | `model`、`effort`、`permission`、`trigger` | `resolveIdentity` + scoped 可见性 |
| **会话级** | 当前会话参数 | `chatmode`、`session`、`dispatch`、`activity` | `resolveIdentity` |

**鉴权来源只有两条路**，和层级不一一对应：
- 进程级 → `evolclaw.json` `owners` 名单，**不**经 `resolveIdentity`，不依赖 session/channel owner 绑定
- 其余三层 → `resolveIdentity()` 返回的 channel 角色（owner / admin / guest / anonymous）

`owners` 为空时所有进程级操作一律 `FORBIDDEN`（daemon 启动时 warn 提示）。

> ⚠️ **Breaking（v3.x）**：`system` 的 restart/upgrade 鉴权已从 role-based 迁移到 `evolclaw.json` `owners`。升级后必须配置 `owners`，否则 `system`/`agent` 操作全部 `FORBIDDEN`。
> ```json
> { "$schema_version": 1, "owners": ["eleans-2022.agentid.pub"], "admins": ["elean.agentid.pub"] }
> ```

---

## 4. menu.list — 菜单树

```jsonc
// →
{ "type": "menu.list", "id": "l-001" }

// ←
{
  "type": "menu.response", "id": "l-001",
  "data": [
    { "group": "项目", "commands": [
      { "cmd": "/pwd", "label": "显示当前项目路径" }
    ]},
    { "group": "会话管理", "commands": [
      { "cmd": "/new",  "label": "创建新会话",
        "next": { "type": "text" } },
      { "cmd": "/s",    "label": "切换会话",
        "next": { "type": "select", "dynamic": true } },
      { "cmd": "/del",  "label": "删除会话",
        "next": { "type": "select", "dynamic": true } }
    ]},
    { "group": "Agent 与模型", "commands": [
      { "cmd": "/baseagent", "label": "切换 Agent 后端",
        "next": { "type": "select", "dynamic": true } },
      { "cmd": "/model",     "label": "切换模型",
        "next": { "type": "select", "dynamic": true } },
      { "cmd": "/effort",    "label": "切换推理强度",
        "next": { "type": "select", "items": [
          { "value": "low",    "label": "Low" },
          { "value": "medium", "label": "Medium" },
          { "value": "high",   "label": "High" },
          { "value": "max",    "label": "Max" }
        ]}}
    ]}
  ]
}
```

服务端按 owner / admin / guest 角色和 private / group 场景裁剪可见命令。

### 节点类型

| 条件 | 类型 | 行为 |
|---|---|---|
| 无 `next` | 叶子 | 拼接路径并发送文本（普通命令） |
| `next.type == "select"` + `items` | 静态子菜单 | 直接展示 items |
| `next.type == "select"` + `dynamic: true` | 动态子菜单 | 发 `menu.options name=<对应名>` |
| `next.type == "text"` | 文本输入 | 等用户输入后拼接 |
| 无 `cmd` 也无 `value` | 纯 UI 分组 | 不参与拼接，只展开 `next.items` |

`next.items` 中的子项**可继续嵌套** `next`，客户端必须递归处理，不能假设固定层数。

---

## 5. menu.query — 当前值

返回某项的**当前生效值**。无会话时多数 name 会 fallback 到 evolagent 配置。

### 5.1 pwd — 当前项目路径

```jsonc
// →
{ "type": "menu.query", "id": "q-001", "name": "pwd" }

// ← 有会话
{ "type": "menu.response", "id": "q-001", "name": "pwd",
  "data": { "name": "review", "path": "/home/user/projects/review" } }

// ← 无会话（fallback evolagent.projectPath）
{ "type": "menu.response", "id": "q-001", "name": "pwd",
  "data": { "name": "review", "path": "/home/user/projects/review" } }

// ← 无会话且 evolagent 也无 projectPath
{ "type": "menu.response", "id": "q-001", "name": "pwd",
  "data": { "name": null, "path": null } }
```

### 5.2 session — 当前会话状态

```jsonc
// →
{ "type": "menu.query", "id": "q-002", "name": "session" }

// ← 有会话
{ "type": "menu.response", "id": "q-002", "name": "session",
  "data": {
    "name": "前端重构",
    "agentSessionId": "abc12345-89ef-...",
    "status": "processing",        // "idle" | "processing"
    "processingDuration": 12,      // 秒，仅 processing 时
    "queueLength": 1,
    "turns": 42,
    "lastSuccess": 1716700000000,
    "createdAt": 1716600000000,
    "updatedAt": 1716700000000
  }}

// ← 无会话
{ "type": "menu.response", "id": "q-002", "name": "session",
  "data": { "status": "no-session" } }
```

无意义字段（如 `queueLength: 0`、`dispatchMode: null`）直接省略，客户端按字段是否存在渲染。

### 5.3 baseagent / model / effort

```jsonc
// →
{ "type": "menu.query", "id": "q-003", "name": "baseagent" }

// ← 有会话
{ "data": { "baseagent": "claude" } }

// ← 无会话（fallback evolagent.config.active_baseagent）
{ "data": { "baseagent": "claude" } }

// ← 无会话且无配置
{ "data": { "baseagent": null } }
```

`model` / `effort` 同结构：

```jsonc
{ "data": { "model": "claude-opus-4-7" } }
{ "data": { "effort": "high" } }
```

### 5.4 chatmode — 私聊响应模式

> ⚠️ chatmode 仅控制**私聊**响应模式。群聊和非 human 对话方强制 proactive，无可配置项。

```jsonc
// →
{ "type": "menu.query", "id": "q-004", "name": "chatmode" }

// ← 
{ "data": { "mode": "interactive" } }   // "interactive" | "proactive"
```

无会话时 fallback 到 `evolagent.config.chatmode.private`。

### 5.5 dispatch — 群聊分发模式

仅**群聊会话**有意义。私聊会话或无会话时返回错误：

```jsonc
// → 群聊会话
{ "data": { "mode": "broadcast" } }     // "mention" | "broadcast"

// → 私聊会话或无会话
{ "error": { "code": "NOT_APPLICABLE", "message": "dispatch 仅在群聊会话中有效" } }
```

### 5.6 permission

```jsonc
// →
{ "type": "menu.query", "id": "q-006", "name": "permission" }

// ← 有会话
{ "data": { "mode": "auto" } }

// ← 无会话
{ "error": { "code": "NO_ACTIVE_SESSION", "message": "当前无活跃会话" } }
```

permission 是 session 级配置，无 fallback。

### 5.7 activity — 中间输出可见范围

agent 级配置，无需会话：

```jsonc
{ "data": { "mode": "all" } }   // "all" | "dm-only" | "owner-dm-only" | "none"
```

### 5.8 system — 进程信息

```jsonc
// →
{ "type": "menu.query", "id": "q-008", "name": "system" }

// ←
{ "data": {
    "agent": "review-bot",
    "version": "3.1.2",
    "uptime": 86400,            // 秒
    "channels": ["aun", "feishu"],
    "pid": 12345,
    "node": "v22.17.1"
}}
```

### 5.9 agent — 查询单个 evolagent 详情（进程级）

需 owners 鉴权。用 `args.aid` 指定目标 agent，返回 `agentShow` 结果；若该 agent 正在/曾经通过 menu 创建，附加 `createProgress` 构建进度（见 §8.5）。

```jsonc
// →
{ "type": "menu.query", "id": "q-009", "name": "agent", "args": { "aid": "mybot.agentid.pub" } }

// ← 普通（无构建进度文件）
{ "data": { "aid": "mybot.agentid.pub", "name": "mybot", "status": "running", "enabled": true } }

// ← 创建中（附 createProgress）
{ "data": {
    "aid": "mybot.agentid.pub", "status": "stopped",
    "createProgress": {
      "status": "in_progress",          // "in_progress" | "ready" | "failed"
      "currentPhase": "hot_loading",
      "steps": [
        { "phase": "validating",        "state": "done", "ts": 1716700000000 },
        { "phase": "registering_aid",   "state": "done", "detail": "created", "ts": 1716700001000 },
        { "phase": "config_saved",      "state": "done", "ts": 1716700001500 },
        { "phase": "uploading_agentmd", "state": "done", "ts": 1716700004000 },
        { "phase": "applying_config",   "state": "done", "ts": 1716700004200 },
        { "phase": "hot_loading",       "state": "in_progress", "ts": 1716700004300 }
      ],
      "error": null
}}}

// ← 非 owner
{ "error": { "code": "FORBIDDEN", "message": "操作需要 owner 权限" } }
```

---

## 6. menu.options — 可选值列表

返回该 name 的可选项数组，客户端用于渲染下拉/单选 UI。

### 6.1 通用结构

```typescript
interface MenuItem {
  value: string;           // 选中时使用的值
  label: string;           // 展示名
  desc?: string;           // 辅助说明
  selected?: boolean;      // 当前是否已选
  preview?: string;        // 长描述/预览（如会话首条消息）
  // ... 其它 name 特有字段
}
```

### 6.2 baseagent / model / effort

```jsonc
// →
{ "type": "menu.options", "id": "o-001", "name": "model" }

// ←
{ "data": [
    { "value": "claude-opus-4-7",   "label": "claude-opus-4-7",   "selected": true },
    { "value": "claude-sonnet-4-6", "label": "claude-sonnet-4-6", "selected": false },
    { "value": "claude-haiku-4-5",  "label": "claude-haiku-4-5",  "selected": false }
]}
```

`selected` 在无会话时基于 evolagent config 当前值标注。

### 6.3 session

包含丰富的辅助字段帮助用户识别会话：

```jsonc
// →
{ "type": "menu.options", "id": "o-002", "name": "session" }

// ←
{ "data": [
    {
      "value": "前端重构",
      "label": "前端重构",
      "preview": "帮我重构 src/components/Header.tsx，把 props 改成...",
      "lastActive": 1716700000000,
      "agentSessionId": "abc12345-89ef-...",
      "turns": 42,
      "selected": true
    },
    {
      "value": "CLI开发",
      "label": "CLI开发",
      "preview": "新增 evolclaw watch 子命令，支持实时日志聚合",
      "lastActive": 1716699000000,
      "agentSessionId": "def45678-...",
      "turns": 18,
      "selected": false
    },
    {
      "value": "cli",
      "label": "查看 CLI 会话",
      "desc": "列出未导入的 CLI 本地会话"
    }
]}
```

字段说明：
- `value` — 切换时使用的值（会话名/uuid/cli）
- `preview` — 首条用户消息（≤ 80 字）
- `lastActive` — Unix ms，客户端按本地时区格式化
- `agentSessionId` — 完整 runner session id，便于精确识别
- `turns` — 会话轮次

### 6.4 chatmode / dispatch / permission

静态枚举，selected 跟随当前值：

```jsonc
// chatmode
{ "data": [
    { "value": "interactive", "label": "交互模式", "selected": true },
    { "value": "proactive",   "label": "主动模式", "selected": false }
]}

// permission
{ "data": [
    { "value": "auto",    "label": "auto",    "selected": true },
    { "value": "bypass",  "label": "bypass",  "selected": false },
    { "value": "plan",    "label": "plan",    "selected": false }
    // ... agent 上报的可用模式
]}
```

### 6.5 activity

```jsonc
{ "data": [
    { "value": "all",   "label": "全部显示",        "selected": true },
    { "value": "dm",    "label": "仅私聊显示",      "selected": false },
    { "value": "owner", "label": "仅 owner 私聊显示", "selected": false },
    { "value": "none",  "label": "全部静默",        "selected": false }
]}
```

`value` 是输入值，对应内部存储值见下表（update 章节）。

### 6.6 agent — evolagent 列表（进程级）

需 owners 鉴权。`args.options` 控制范围：`enabled`（默认，过滤 disabled）或 `all`。

```jsonc
// →
{ "type": "menu.options", "id": "o-006", "name": "agent", "args": { "options": "all" } }

// ←
{ "data": [
    { "value": "mybot.agentid.pub",   "label": "mybot",   "desc": "running" },
    { "value": "review.agentid.pub",  "label": "review",  "desc": "disabled" }
]}
```

### 6.7 trigger — 触发器列表（关系级）

非 admin 仅可见自己创建的触发器（按 `createdByPeerId` + channel 过滤）。`args.options`：`enabled`（默认，仅活跃）或 `all`（含历史）。每个触发器映射为一个 MenuItem。

```jsonc
// →
{ "type": "menu.options", "id": "o-007", "name": "trigger" }

// ←
{ "data": [
    { "value": "<uuid>", "label": "晨报", "desc": "cron | 下次 2026/6/6 09:00:00" },
    { "value": "<uuid>", "label": "提醒", "desc": "delay | 下次 2026/6/5 18:00:00" }
]}
```

---

## 7. menu.update — 写入新值

### 7.1 baseagent / model / effort

```jsonc
// →
{ "type": "menu.update", "id": "u-001", "name": "baseagent", "value": "codex" }

// ←
{ "data": { "baseagent": "codex" } }
```

写入位置：
- **baseagent**：有会话时先走 `/baseagent <value>` slash 命令切换 runner；只有命令成功后才写 `evolagent.config.active_baseagent`，避免失败时配置脏
- **model / effort**：写 `evolagent.config.baseagents[active].model|effort`，并同步当前 runner 的 `setModel/setEffort`

`model` / `effort` 同结构：

```jsonc
{ "data": { "model": "claude-opus-4-7" } }
{ "data": { "effort": "max" } }
```

### 7.2 chatmode

```jsonc
// →
{ "type": "menu.update", "id": "u-002", "name": "chatmode", "value": "proactive" }

// ←
{ "data": { "mode": "proactive" } }
```

写入位置：
- 有会话：`session.sessionMode`（仅当前会话生效）
- 无会话：`evolagent.config.chatmode.private`（影响后续新会话）

### 7.3 dispatch（仅群聊）

```jsonc
// → 群聊会话
{ "type": "menu.update", "id": "u-003", "name": "dispatch", "value": "broadcast" }

// ←
{ "data": { "mode": "broadcast" } }

// → 私聊会话或无会话
{ "error": { "code": "NOT_APPLICABLE", "message": "dispatch 仅在群聊会话中有效" } }
```

### 7.4 permission（owner-only）

```jsonc
// →
{ "type": "menu.update", "id": "u-004", "name": "permission", "value": "bypass" }

// ←
{ "data": { "mode": "bypass" } }

// 非 owner
{ "error": { "code": "NO_PERMISSION", "message": "无权限" } }
```

### 7.5 activity（owner-only）

```jsonc
// →
{ "type": "menu.update", "id": "u-005", "name": "activity", "value": "owner" }

// ←
{ "data": { "mode": "owner-dm-only" } }
```

input → 存储值映射：

| value 输入 | 存储 mode |
|---|---|
| `all` | `all` |
| `dm` | `dm-only` |
| `owner` | `owner-dm-only` |
| `none` | `none` |

---

## 8. menu.action — 触发动词

### 8.1 session 系列

#### stop — 中断当前任务

```jsonc
// →
{ "type": "menu.action", "id": "a-001", "name": "session", "action": "stop" }

// ← 成功
{ "data": { "action": "stop", "success": true } }

// ← 无活跃会话
{ "error": { "code": "NO_ACTIVE_SESSION", "message": "当前无活跃会话" } }

// ← 有会话但无任务在跑
{ "error": { "code": "NO_ACTIVE_TASK", "message": "当前没有正在处理的任务" } }
```

#### new — 创建新会话

```jsonc
// →
{ "type": "menu.action", "id": "a-002", "name": "session", "action": "new",
  "args": { "name": "前端重构" } }

// ← 成功
{ "data": {
    "action": "new",
    "success": true,
    "message": "✓ 已创建会话: 前端重构",
    "session": { "id": "...", "name": "前端重构", "agentSessionId": "abc12345-..." }
}}
```

`args.name` 可省（默认 "默认会话"）。响应中 `data.session` 是新建并切到 active 后的会话信息，`agentSessionId` 仅在 runner 已生成 session 时存在；`message` 是面向人类的提示文案。

#### delete — 删除指定会话

```jsonc
// →
{ "type": "menu.action", "id": "a-003", "name": "session", "action": "delete",
  "args": { "target": "测试会话" } }

// ← 成功
{ "data": { "action": "delete", "success": true, "message": "✓ 已删除会话: 测试会话" } }

// ← 不能删 active
{ "error": { "code": "EXEC_FAILED", "message": "无法删除当前活跃会话" } }
```

`args.target` 接受：会话名 / 8 位 uuid 前缀 / 完整 runner session id（与 `/del` 命令一致）。

#### switch — 切换会话

```jsonc
// →
{ "type": "menu.action", "id": "a-004", "name": "session", "action": "switch",
  "args": { "target": "前端重构" } }

// ← 成功
{ "data": {
    "action": "switch", "success": true,
    "message": "✓ 已切换到会话: 前端重构",
    "session": { "id": "...", "name": "前端重构", "agentSessionId": "abc12345-..." }
}}

// ← 不存在
{ "error": { "code": "EXEC_FAILED", "message": "❌ 会话不存在: 前端重构" } }
```

`args.target` 接受四种格式（与 `/s` 命令完全一致）：
- 会话名（精确匹配 `session.name`）
- 数字序号（按 `/slist` 显示顺序）
- 8 位 uuid 前缀
- 完整 runner session id（uuid 全长）
- `cli`（查看未导入的 CLI 会话列表）

#### compact — 压缩当前会话上下文

```jsonc
// →
{ "type": "menu.action", "id": "a-005", "name": "session", "action": "compact" }

// ← 成功
{ "data": { "action": "compact", "success": true, "message": "✓ 上下文已压缩" } }
```

需要会话；委派给当前 agent runner 的 compact 能力。Runner 不支持 compact 时返回 `EXEC_FAILED`。

#### fork — 分支当前会话

```jsonc
// →
{ "type": "menu.action", "id": "a-006", "name": "session", "action": "fork",
  "args": { "name": "实验分支" } }

// ← 成功
{ "data": {
    "action": "fork", "success": true,
    "message": "✓ 已分支到会话: 实验分支",
    "session": { "id": "...", "name": "实验分支", "agentSessionId": "..." }
}}
```

`args.name` 可省。需要会话且 runner 支持 fork。

### 8.2 system 系列

#### restart — 重启服务（owner-only）

```jsonc
// →
{ "type": "menu.action", "id": "a-101", "name": "system", "action": "restart" }

// ← 成功
{ "data": { "action": "restart", "success": true } }
```

#### check — 渠道健康检查

```jsonc
// →
{ "type": "menu.action", "id": "a-102", "name": "system", "action": "check" }

// ←
{ "data": {
    "action": "check",
    "success": true,
    "channels": [
      { "name": "aun",    "status": "connected", "lastActive": 1716700000000 },
      { "name": "feishu", "status": "connected", "lastActive": 1716699000000 }
    ]
}}
```

#### upgrade — 升级 evolclaw（owner-only）

```jsonc
// →
{ "type": "menu.action", "id": "a-103", "name": "system", "action": "upgrade" }

// ← 成功
{ "data": { "action": "upgrade", "success": true, "version": "3.2.0" } }

// ← 已是最新
{ "data": { "action": "upgrade", "success": true, "alreadyLatest": true } }
```

### 8.3 cli 系列（CLI 透传，owner-only）

在子进程中执行后端 evolclaw 的 CLI 命令并取回结果，供前端**程序化调用**（不经聊天页面、不经菜单交互）。

> ⚠️ 本质是经消息通道的远程命令执行（RCE）。强制 **owner-only + 命令白名单 + 无 shell + 15s 超时 + 128KB 输出截断**。
> 完整集成细节（白名单逐命令说明、model 多作用域、各命令 JSON 形状）见专文 `docs/menu-protocol-cli-exec-frontend.md`。

#### exec — 执行白名单内 CLI 命令

```jsonc
// → argv 数组（推荐，无注入风险）
{ "type": "menu.action", "id": "c-001", "name": "cli", "action": "exec",
  "args": { "argv": ["model", "list", "--format", "json"] } }

// → 或 command 字符串（daemon 侧分词，尊重单/双引号，不走 shell）
{ "type": "menu.action", "id": "c-002", "name": "cli", "action": "exec",
  "args": { "command": "status" } }

// ← 成功（命令跑完，exitCode 才是命令成败判据）
{ "data": {
    "exitCode": 0,
    "stdout": "{ ...JSON... }",
    "stderr": "",
    "truncated": false,        // true = 输出超 128KB 被截断
    "durationMs": 320
}}

// ← 透传层拒绝（命令未执行）
{ "error": { "code": "NOT_ALLOWED", "message": "命令不在白名单: restart" } }
```

要点：
- `argv` 与 `command` 二选一，同时给时 `argv` 优先；`argv[0]` 是子命令名（如 `model`），**不要**写 `evolclaw`/`ec` 前缀。
- 命令**自身**失败（如模型不存在）走 `data.exitCode != 0`，错误在 `stderr` 或 `stdout` 的 `{ok:false}`；`menu.response.error` 只代表透传层拒绝。
- 白名单（只读+配置）：`status`、`model`（全部）、`agent list/show/get`、`aid list/show/lookup`、`storage ls/quota`。其余（`restart`/`stop`/`msg`/`group`/写操作子命令等）→ `NOT_ALLOWED`。
- 错误码：`NO_PERMISSION`（非 owner）、`NOT_ALLOWED`、`MISSING_VALUE`、`NOT_SUPPORTED`（action 非 exec）、`TIMEOUT`、`INTERNAL`。

---

### 8.4 agent 系列（evolagent 生命周期，进程级 owners 鉴权）

管理远端 evolagent 的创建/删除/启停。全部需发送方 AID 在 `evolclaw.json` `owners` 名单中，否则 `FORBIDDEN`。

#### create — 创建 agent（受理即返回）

create 涉及 AID 网络注册 + agent.md 上传 + 热加载，最坏 30s+。协议采用**受理即返回**：同步必填校验通过后立即回 `{ accepted: true, aid }`，完整创建在后台进行。客户端随后用 `menu.query name=agent` 轮询构建进度（见 §8.5）。

```jsonc
// →
{ "type": "menu.action", "id": "a-201", "name": "agent", "action": "create",
  "args": {
    "aid": "mybot.agentid.pub",     // 必填，合法多级域名
    "name": "mybot",                // 必填，展示名
    "baseagent": "claude",          // 必填，claude / codex / gemini
    "project": "/home/u/proj",      // 可选；缺省由 defaults.projects.rootPath/defaultPath 兜底
    "model": "sonnet",              // 可选，创建后落盘 models.default
    "chatmode": { "private": "interactive" }  // 可选，创建后落盘 chatmode
  }}

// ← 受理（不代表创建完成！）
{ "data": { "accepted": true, "aid": "mybot.agentid.pub" } }

// ← 同步校验失败（必填缺失 / project 无法兜底 / 发送方 AID 为空）
{ "error": { "code": "INVALID_ARGS", "message": "缺少必填参数：aid / name / baseagent" } }

// ← 非 owner
{ "error": { "code": "FORBIDDEN", "message": "操作需要 owner 权限" } }
```

新 agent 的 owner 自动设为**发送方 AID**。`project` 兜底顺序：显式值 > `defaults.projects.rootPath`/`<aid第一段>` 合成 > `defaults.projects.defaultPath`。

#### delete / enable / disable — 同步等结果

```jsonc
// →
{ "type": "menu.action", "id": "a-202", "name": "agent", "action": "delete",
  "args": { "aid": "mybot.agentid.pub" } }

// ← 成功
{ "data": { "aid": "mybot.agentid.pub", "purged": false } }

// →
{ "type": "menu.action", "id": "a-203", "name": "agent", "action": "enable",
  "args": { "aid": "mybot.agentid.pub" } }

// ← 成功
{ "data": { "aid": "mybot.agentid.pub", "enabled": true, "reloaded": true } }

// ← 目标不存在
{ "error": { "code": "NOT_FOUND", "message": "Agent \"mybot\" not found" } }
```

`disable` 同 `enable`，`data.enabled` 为 `false`。错误码：`INVALID_ARGS`、`NOT_FOUND`、`CONFLICT`（已存在）、`INTERNAL`。

### 8.5 agent create 构建进度（轮询）

create 受理后，config 很早落盘，`menu.query name=agent` 立即可查。后台逐环节把进度写入
`agents/<aid>/create-status.json`，并在 query 响应里以 `createProgress` 透出。客户端轮询
`createProgress.status` 直到 `ready` / `failed`。

**环节序列**（`steps[].phase`）：

| phase | 含义 | 失败语义 |
|---|---|---|
| `validating` | AID/baseagent/project 校验 | **硬失败** → `status='failed'` |
| `registering_aid` | AID 网络注册 | **硬失败** → `status='failed'` |
| `config_saved` | 配置落盘 | **硬失败** → `status='failed'` |
| `uploading_agentmd` | agent.md 生成+上传（3×2s 重试） | **软失败** → `state='warn'`，仍 `ready` |
| `applying_config` | model/chatmode 落盘 | **软失败** → `warn` |
| `hot_loading` | IPC 热加载连 AUN（30s） | **软失败**（daemon 未运行也正常） |

`steps[].state`：`in_progress` / `done` / `warn` / `failed`。硬失败（前 3 环节）整体 `failed`，agent 不可用；软失败（后 3 环节）agent 已可用，对应 step 记 `warn` 但终态 `ready`。

```jsonc
// 轮询：重复发送直到 status 为 ready/failed
{ "type": "menu.query", "id": "a-204", "name": "agent", "args": { "aid": "mybot.agentid.pub" } }

// ← 完成
{ "data": { "aid": "mybot.agentid.pub", "status": "running",
    "createProgress": { "status": "ready", "currentPhase": null, "steps": [ ... ], "error": null } }}

// ← 硬失败
{ "data": { "createProgress": {
    "status": "failed", "currentPhase": null,
    "steps": [ { "phase": "registering_aid", "state": "failed", "detail": "AID creation failed: ...", "ts": ... } ],
    "error": "AID creation failed: ..." }}}
```

建议轮询间隔 1-2s，总超时 60s。`create-status.json` 随 agent 删除一并清理。

### 8.6 trigger 系列（自主触发器，关系级）

set/cancel 用结构化 args **直接调底层**（绕过文本解析，无 flag 注入风险）。鉴权走 channel 角色 + scoped：非 admin 仅能操作自己创建的触发器。

#### set — 注册触发器

```jsonc
// →
{ "type": "menu.action", "id": "a-301", "name": "trigger", "action": "set",
  "args": {
    "scheduleType": "cron",          // 必填：delay / at / cron
    "scheduleValue": "0 9 * * *",    // 必填：delay=毫秒数；at=ISO时间；cron=表达式
    "prompt": "生成每日晨报",         // 必填：触发时发给 agent 的内容
    "name": "晨报",                  // 可选，缺省自动生成
    "targetSessionStrategy": "latest" // 可选：latest（默认）/ current / thread
  }}

// ← 成功
{ "data": { "id": "<uuid>", "name": "晨报", "nextFireAt": 1716700000000 } }

// ← 参数非法（含非法 scheduleType/scheduleValue/strategy）
{ "error": { "code": "INVALID_ARGS", "message": "delay 的 scheduleValue 需为正整数毫秒: abc" } }

// ← 名称冲突
{ "error": { "code": "CONFLICT", "message": "..." } }
```

#### cancel — 取消触发器

```jsonc
// →
{ "type": "menu.action", "id": "a-302", "name": "trigger", "action": "cancel",
  "args": { "nameOrId": "晨报" } }

// ← 成功
{ "data": { "id": "<uuid>", "cancelled": true } }

// ← 不存在或无权限
{ "error": { "code": "NOT_FOUND", "message": "触发器不存在或无权限" } }
```

#### update（menu.update）— 修改调度参数

```jsonc
// → value 为 JSON 字符串
{ "type": "menu.update", "id": "u-301", "name": "trigger",
  "value": "{\"nameOrId\":\"晨报\",\"scheduleValue\":\"0 8 * * *\"}" }

// ← 成功（调度参数变化时自动重算 nextFireAt）
{ "data": { "id": "<uuid>", "nextFireAt": 1716690000000 } }
```

`value` 内可改字段：`scheduleType` / `scheduleValue` / `prompt`。改调度参数会重算 `nextFireAt`，非法值返回 `INVALID_ARGS`（不会写入 NaN）。

---

## 9. 错误响应

```jsonc
{ "type": "menu.response", "id": "u-001", "name": "permission",
  "error": { "code": "NO_PERMISSION", "message": "无权限" } }
```

### 错误码表

| code | 触发场景 | 客户端建议 |
|---|---|---|
| `UNKNOWN_NAME` | `name` 不在映射表内且未提供 `cmd` | 协议层错误，开发期排查 |
| `MISSING_CMD` | 请求中既无 `name` 也无 `cmd`（极少触发） | 协议层错误 |
| `MISSING_VALUE` | update 缺 `value` / action 缺必需 args | 协议层错误 |
| `INVALID_ARGS` | 进程级/触发器操作参数非法（缺必填、非法枚举/数值） | 校正 args 后重试 |
| `FORBIDDEN` | 进程级操作（`system`/`agent`）发送方 AID 不在 `evolclaw.json` `owners` | UI 隐藏该项 |
| `CONFLICT` | 目标已存在（如 agent create 重名、trigger 重名） | 提示已存在 |
| `NO_ACTIVE_SESSION` | 此操作必须有活跃会话 | 提示用户先发条消息建立会话 |
| `NO_ACTIVE_TASK` | session.action.stop 时会话存在但无任务 | 灰显 stop 按钮 |
| `NO_PERMISSION` | 角色不足（owner-only / admin-only） | UI 隐藏该项 |
| `INVALID_VALUE` | 值不在白名单 | 让用户从下拉重选 |
| `NOT_APPLICABLE` | 操作在当前上下文无意义（如私聊改 dispatch） | 灰显该项 |
| `NOT_FOUND` | 目标会话/项目不存在 | 刷新列表后重试 |
| `EXEC_FAILED` | 业务层兜底拒绝（含 delegated slash 命令失败） | 展示 message |
| `NOT_SUPPORTED` | 该操作未实现 | — |
| `NOT_ALLOWED` | cli 命令/子命令不在白名单 | 不开放任意命令输入；开发期排查 |
| `TIMEOUT` | cli 执行超 15s，子进程已被强杀 | 提示超时 |
| `INTERNAL` | 未分类的运行时异常 | 上报 |

`error.message` 是面向人类的中文短句，UI 可直接展示。

---

## 10. 命令拼接（list 视图）

`menu.list` 返回的菜单树是给客户端渲染交互式 UI 的。叶子节点选中后，沿路径收集 `cmd` 与 `value`，空格拼接成普通文本消息发给 agent（**不走 menu.update / menu.action**）。

```
路径                                              拼接结果
────────────────────────────────────────────────  ──────────────────
cmd:/model → value:opus                           /model opus
cmd:/del → value:重构会话                          /del 重构会话
cmd:/new → (text 输入 "我的会话")                  /new 我的会话
cmd:/safe                                         /safe
```

list 视图里 `dynamic: true` 节点对应一个 `name`：客户端可以拉子菜单时改用 `menu.options`：

```jsonc
// 等价
{ "type": "menu.options", "id": "o-1", "name": "session" }
{ "type": "menu.options", "id": "o-1", "name": "any", "cmd": "/s" }
```

推荐**优先用 `name`**，仅当客户端需要触达映射表外的内部命令时才用 `cmd`。

---

## 11. 权限 & 会话约束

服务端在执行各类请求前会校验。常见拒绝场景：

| 约束 | code | 触发 name |
|---|---|---|
| 无活跃会话 | `NO_ACTIVE_SESSION` | `permission` query/update；`session.action.stop` / `compact` / `fork` |
| 会话存在但无任务 | `NO_ACTIVE_TASK` | `session.action.stop` |
| 私聊会话/无会话上调 dispatch | `NOT_APPLICABLE` | `dispatch` query/update |
| 非 owner | `NO_PERMISSION` | `permission` update / `activity` update |
| 进程级非 owners 名单 | `FORBIDDEN` | `system` query/action / `agent` query/options/action |
| 群聊非管理员改 chatmode/dispatch | `NO_PERMISSION` | `chatmode` update / `dispatch` update |
| 参数非法 | `INVALID_ARGS` | `agent` / `trigger` 操作 |
| 无效值 | `INVALID_VALUE` | 任何会话类 update |

owner / admin 由 evolclaw 服务端的 `resolveIdentity()` 决定（关系级）；进程级 `system`/`agent` 改由 `evolclaw.json` `owners` 名单决定（见 §3.1）。客户端无须感知。

---

## 12. 传输层

Menu 消息走 AUN `message.send`，payload 是 JSON 字符串。

```typescript
// 发送 menu.query
await client.call('message.send', {
  to: targetAid,
  payload: JSON.stringify({
    type: 'menu.query',
    id: 'q-001',
    name: 'baseagent',
  }),
  encrypt: true,
});

// 接收响应
function onMessage(payload: string) {
  let parsed: any;
  try { parsed = JSON.parse(payload); } catch { return; }
  if (parsed?.type !== 'menu.response') return;

  const pending = pendingRequests.get(parsed.id);
  if (!pending) return;
  pendingRequests.delete(parsed.id);

  if (parsed.error) {
    pending.reject(new MenuError(parsed.error.code, parsed.error.message));
  } else {
    pending.resolve(parsed.data);
  }
}
```

服务端使用 `taskId: menu-<hex>` 作为响应信封 ID，客户端不需要关心——以 `payload.id` 为准。

> 💡 **服务端维护提示**：AUN channel 在入站时维护一个 `MENU_REQUEST_TYPES` 白名单（`src/channels/aun.ts`），未列入的 menu 请求类型会被作为信号类消息丢弃。新增 `menu.*` 类型时**必须同时**更新该白名单和 message-bridge 的分发器。

---

## 13. 客户端实现建议

### 13.1 请求 ID 生成

`id` 必须**全客户端生命周期唯一**，避免并发冲突。推荐 `nanoid(8)` 或单调递增计数器（`q-1` / `o-1` / `u-1` / `a-1`...）。

### 13.2 缓存策略

| 数据 | 推荐 TTL | 触发刷新 |
|---|---|---|
| `menu.list` | 5 分钟 | 用户主动 reload / 切换目标 AID |
| `menu.options`（model / agent / session） | 不缓存或 30 秒 | 每次进入子菜单刷新 |
| `menu.query`（当前值） | 不缓存 | 用户每次打开设置项时拉取 |

### 13.3 超时与重试

- `menu.query` / `menu.options` 5 秒无响应 → 超时，提示"对端暂无响应"
- 不要自动重试 `menu.update` / `menu.action`——可能造成重复写入或重复触发
- `menu.list` / `menu.query` / `menu.options` 可静默重试一次

### 13.4 按 code 决定降级策略

| 收到 code | UI 行为 |
|---|---|
| `NO_ACTIVE_SESSION` | 提示"先发条消息建立会话"；设置项可灰显 |
| `NO_ACTIVE_TASK` | stop 按钮灰显或隐藏 |
| `NOT_APPLICABLE` | 该项在当前上下文不可用，灰显 |
| `NO_PERMISSION` | 隐藏该项（不让用户看到自己用不了的功能） |
| `INVALID_VALUE` | 重新拉 `menu.options` 让用户重选 |
| `NOT_FOUND` | 刷新列表 |
| 其它 | 展示 error.message 作为 toast |

### 13.5 UI 适配

| 客户端类型 | 推荐实现 |
|---|---|
| CLI / Terminal | Tab 补全 + 多级导航（参考 `aun-cli ///`） |
| 移动端 App | 底部弹出菜单 → 列表选择 → 逐级深入 |
| Web UI | 下拉菜单 / Command Palette（Cmd+K） |
| Bot 平台 | 交互卡片 / 按钮组（Slack Block Kit、飞书互动卡片） |

---

## 14. 旧文档说明

本文档是当前唯一规范。以下文档已被取代：

- `docs/aun-custom-menu.md`（v1，无 id/name）
- `docs/aun-menu-exec-protocol.md`（query/update mode 早期方案）
- `docs/menu-protocol-refactor.md`（重构记录，仍可作为变更史参考）

旧协议（`name=list` 单 type、`state: true` 字段、`mode` 字段）已全部废弃。

---

## 15. 速查卡

```
请求结构（按 type 分）

menu.list                                          → MenuGroup[]
menu.query   name=<key> [cmd?]                     → 当前值对象
menu.options name=<key> [cmd?]                     → MenuItem[]
menu.update  name=<key> value=<v> [cmd?]           → 新值对象
menu.action  name=<key> action=<verb> [args? cmd?] → { action, success, ... }

menu.response { id, name?, data | error: { code, message } }

name 速查
  pwd       query                              当前项目路径
  session   query / options / action(*)       会话状态/列表/stop+new+delete+compact+fork+switch
  baseagent query / options / update          Agent 后端
  model     query / options / update          模型
  effort    query / options / update          推理强度
  chatmode  query / options / update          私聊响应模式
  dispatch  query / options / update          群聊分发（仅群聊）
  permission query / options / update         权限模式（owner/session）
  activity  query / options / update          中间输出可见性（owner/agent）
  system    query / action(*)                 进程信息 / restart+check+upgrade（进程级 owners 鉴权）
  agent     query / options / action(*)       evolagent 详情/列表/create+delete+enable+disable（进程级 owners 鉴权）
  trigger   options / update / action(*)      触发器列表/改调度/set+cancel（关系级 scoped）
  cli       action(exec)                       owner-only 透传后端 CLI（见 menu-protocol-cli-exec-frontend.md）
```
