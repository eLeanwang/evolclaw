# ECWeb Menu Control 视图设计

最后更新：2026-06-11
状态：历史设计，已按 2026-06-10 / 2026-06-11 控制面权限口径修订

## 1. 目标

在 ECWeb（`evolclaw-web` 独立监控面板）中新增一个 **Control** 视图，让用户通过浏览器查看本机 EvolClaw daemon 的运行状态，并通过 **Menu 协议**（`menu.*`）进行管理和控制。

核心约束：**完全复用现有 `menu.*` 协议能力，不新增协议、不重复造轮子。** Control 视图本质是一个"运行在浏览器里的通用 Menu 协议客户端"。

## 2. 背景

- **Menu 协议**（`docs/aun-menu-protocol-dev-guide-v2.2.md`）：`menu.*` JSON 请求/响应协议，定义 5 种请求（`list`/`query`/`options`/`update`/`action`）+ 统一响应（`menu.response`）。服务端在 `src/core/message/message-bridge.ts` 拦截，委派给 `src/core/command/command-handler.ts` 门面；具体执行在 `src/core/command/menu-handler.ts`。
- **ECWeb**（`ecweb/`）：独立 Node 进程，token 配对的只读浏览器面板。现有 4 个 tab（AID/Messages/Sessions/Cache），数据经 daemon 的 IPC socket（`ipcQuery`）+ `fs.watch` 获取。当前**纯只读**，无控制能力。
- **"ucloud" 澄清**：指本机运行的 EvolClaw daemon 本身（非 UCloud 云服务，非远程 agent）。

## 3. 架构

ECWeb 是独立进程，不持有 daemon 的 `CommandHandler` 引用。复用现有 IPC socket 作为进程间通道，新增一个 `menu.exec` 命令把 `menu.*` 请求代理给 daemon 执行。

```
浏览器 (Control tab)
  └─ WS { type:'menu', requestId, payload: <menu.* request> }
       └─ ECWeb server (server.ts)
            └─ ipcQuery(socket, { type:'menu.exec', payload })
                 └─ daemon IPC (ipc.ts) → menuExecutor(payload)   ← 注入 role:'owner'
                      └─ CommandHandler.execMenu{Query,Options,Update,Action} / getMenuItems
                           └─ menu.response → 原路 WS 回浏览器
```

为什么走 IPC 而非 AUN：用户已确认目标是本机 daemon。IPC 是现成的本地进程间通道，与 `aun-aids`/`status`/`evolagent.list` 等已有查询同一套机制，零额外依赖（不需要 AUN 连接、不需要 AID 配置）。

## 4. 鉴权（方案 A：IPC 注入 owner）

ECWeb 本身已有鉴权：6 位配对码（5 分钟有效）→ token（24h）。**能开浏览器访问 ECWeb 并完成配对 = 本机用户 = owner。** 因此 `menu.exec` 不再走 `resolveIdentity`（那是 channel+peerId 维度的绑定判定，ECWeb 没有对应的 channel owner 记录，会落到 guest）。

规则：

- daemon 侧 `menuExecutor` 对**会话级 / 关系级 / Agent 默认配置 / 本 agent 管理**操作（`session`/`model`/`baseagent`/`effort`/`chatmode`/`permission`/`activity`/`dispatch`/`trigger`/`agent.reload`/`agent.update` 等）一律以 `role:'owner'` 执行。
- 对**进程级**操作（`system.restart`/`system.upgrade`、`agent.create`/`delete`/`enable`/`disable`）额外加一道闸：`evolclaw.json` 的 `owners` 名单**非空**才放行，为空则返回 `FORBIDDEN`（防止裸机零配置下误触发重启/升级/agent 删除）。
- `cli`（owner-only CLI 透传）**不在 Control UI 暴露**——它是程序化 RCE 通道，非交互菜单。

实现要点：`isProcessLevelOwner(userId, owners)` 现有逻辑是"userId 在 owners 名单内"。ECWeb 路径需要一个绕过 userId 比对、改判"owners 非空"的入口。在 `menuExecutor` 层用一个 `ecwebMode: true` 标志区分，进程级操作改判 `owners.length > 0`。

## 5. 协议驱动渲染（关键设计）

Control 视图**不硬编码** section。渲染由协议驱动：

1. 启动时发 `menu.list` → 拿到服务端**按 owner 角色裁剪**的命令树。
2. 前端按每个 `name` 的**能力**渲染对应控件。能力来自前端内嵌的一份**能力矩阵描述符**（即协议文档 §3 的矩阵，属于协议知识，非业务逻辑）。

能力矩阵描述符（前端常量，协议加新 name 时加一行，渲染引擎不动）：

| name | query | options | update | action | 渲染成 |
|---|:--:|:--:|:--:|:--:|---|
| `pwd` | ✅ | | | | 只读状态卡 |
| `system` | ✅ | | | `restart` `check` `upgrade` | 状态卡 + 动词按钮 |
| `baseagent` | ✅ | ✅ | ✅ | | 当前值 + 下拉切换 |
| `model` | ✅ | ✅ | ✅ | | 当前值 + 下拉切换 |
| `effort` | ✅ | ✅ | ✅ | | 当前值 + 下拉切换 |
| `chatmode` | ✅ | ✅ | ✅ | | 当前值 + 下拉切换 |
| `permission` | ✅ | ✅ | ✅ | | 当前值 + 下拉切换 |
| `activity` | ✅ | ✅ | ✅ | | 当前值 + 下拉切换 |
| `dispatch` | ✅ | ✅ | ✅ | | 当前值 + 下拉（群聊才有意义） |
| `session` | ✅ | ✅ | | `stop` `new` `rename` `delete` `compact` `fork` `switch` | 状态 + 列表 + 行内动词 |
| `topic` | ✅ | ✅ | | `rename` `delete` | 话题状态 + 列表 + 行内动词 |
| `agent` | ✅ | ✅ | | `create` `delete` `enable` `disable` `reload` `update` | 列表 + toggle + create 表单 + 自管理动作 |
| `trigger` | | ✅ | ✅ | `set` `cancel` | 列表 + 编辑 + set/cancel |
| `cli` | | | | `exec` | **不渲染**（排除） |

通用渲染规则：

| 能力组合 | 控件 |
|---|---|
| 仅 `query` | 只读状态卡 |
| `query`+`options`+`update` | 当前值 + 下拉，选中即 `menu.update` |
| `query`+`options`+`action` | 状态 + 列表 + 行内动词按钮 |
| `options`+`update`+`action` | 列表 + 编辑 + 动词按钮 |
| 含 `action(exec)` | 排除，不渲染 |

好处：前端 control 逻辑是"一个通用渲染器 + 一份矩阵描述符"，而非一堆硬编码 section；协议演进零成本；权限/适用性由服务端 `error.code` 决定，前端不预判。

## 6. 数据流：读与写两条路

- **读（snapshot + 轮询）**：`ecweb/src/sources/control.ts` 通过 IPC `menu.exec` 拉各 `query`/`options` 当前值，1s 轮询、JSON diff、变化才 push（与 `aid.ts` 模式一致，IPC 无推送能力）。轮询集合 = 矩阵中所有支持 `query` 的 name + `agent`/`session`/`trigger` 的 `options` 列表。
- **写（按钮 / 下拉）**：浏览器直接发 WS `menu` 消息（`menu.update`/`menu.action`），用 `requestId` 配对响应，**不经轮询通道**。写成功后下一次轮询自然刷新显示。

## 7. 错误处理（复用协议 error.code）

`menu.response.error.code` 透传到前端，按 §13.4 降级：

| code | UI |
|---|---|
| `FORBIDDEN` / `NO_PERMISSION` | 按钮灰显 + tooltip "需要 owner 权限" |
| `NO_ACTIVE_SESSION` | 该项提示"先在聊天里发条消息建立会话" |
| `NOT_APPLICABLE` | 灰显（如私聊场景的 `dispatch`） |
| `INVALID_VALUE` | 重拉 `options` 让用户重选 |
| 其它 | toast 显示 `error.message` |

前端不预判权限，发请求拿 code 决定 UI。

## 8. 组件改动

| 文件 | 改动 | 估算 |
|---|---|---|
| `src/core/command/command-handler.ts` + `src/core/command/menu-handler.ts` | 新增顶层入口 `execMenuForEcweb(payload)`：按 `payload.type` 分发到现有 `getMenuItems`/`getSubMenuItems`/`execMenuQuery`/`execMenuUpdate`/`execMenuAction`，注入 owner identity；进程级操作改判 owners 非空 | +60 行 |
| `src/ipc.ts` | 新增 `case 'menu.exec'` → 调 `this.menuExecutor`；新增 `menuExecutor` 字段 + setter | +25 行 |
| `src/index.ts` | 构造 `menuExecutor` 闭包（绑定 cmdHandler，固定 channel=`__ecweb__`、ecwebMode=true）注入 IPC server | +15 行 |
| `ecweb/src/sources/types.ts` | `ViewKind` 加 `'control'` | +1 行 |
| `ecweb/src/sources/control.ts`（新建） | snapshot + 1s 轮询，经 IPC `menu.exec` 拉 query/options | ~120 行 |
| `ecweb/src/server.ts` | `SOURCES` 注册 control；WS 加 `menu` 消息类型 → IPC 代理 → 回 `menu.response` | +25 行 |
| `ecweb/src/static/index.html` | Control tab + `<section id="view-control">` | +3 行 |
| `ecweb/src/static/app.js` | 通用 Menu 渲染器：矩阵描述符 + `renderControl()` + 控件渲染 + WS 写请求配对 | ~200 行 |
| `ecweb/src/static/style.css` | control 样式（状态卡 / 下拉 / 列表 / 按钮态） | +50 行 |

## 9. 关键接口

daemon 侧 IPC 新增命令：

```typescript
// 请求
{ type: 'menu.exec', payload: <menu.* request object> }
// 响应
{ ok: true, response: <menu.response object> }   // 协议层成败在 response.data/error
{ ok: false, error: string }                      // IPC 层失败（menuExecutor 未注入等）
```

ECWeb WS 新增消息：

```typescript
// 浏览器 → server
{ type: 'menu', requestId: string, payload: <menu.* request> }
// server → 浏览器
{ type: 'menu.response', requestId: string, data: <menu.response object> }
```

`menuExecutor` 签名（daemon 侧注入）：

```typescript
type MenuExecutor = (payload: any) => Promise<MenuResponse>;
// 内部固定 channel='__ecweb__'、role='owner'、ecwebMode=true
```

## 10. 测试

- **daemon 侧单测**（vitest）：
  - `execMenuForEcweb` 按 type 正确分发到各 execMenu* 方法。
  - owner 注入：会话级/关系级操作以 owner 身份执行成功。
  - 进程级闸门：`owners` 为空 → `system.restart`/`agent.create` 返回 `FORBIDDEN`；`owners` 非空 → 放行；`agent.reload`/`agent.update` 按自管理 action 覆盖。
  - `cli` 类型被拒绝（不在 ecweb 入口暴露）。
- **ECWeb 侧**：项目无前端测试框架，手动验证——启动 daemon + `evolclaw-web`，浏览器配对后走查 Control 三类控件（状态卡 / 下拉切换 / 列表动词），确认读轮询刷新与写回显正常，确认无 daemon / owners 空时降级正确。

## 11. 范围与非目标

- **范围内**：本机 daemon 的 System 状态、Agent 配置（baseagent/model/effort/chatmode/permission/activity）、Session 控制、EvolAgent 管理（create/delete/enable/disable/reload/update）、trigger，全部经通用渲染器自动覆盖。
- **非目标**：远程 AUN agent 控制（本期走 IPC 本机）；`cli` 透传 UI；ECWeb 自身鉴权模型改动（沿用配对码 + token）。
