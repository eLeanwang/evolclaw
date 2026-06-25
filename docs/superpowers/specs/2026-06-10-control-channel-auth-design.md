# 控制面鉴权模型设计

**日期**：2026-06-10
**状态**：✅ 已实现（2026-06-11）
**关联**：
- `2026-06-04-aun-agent-control-design.md`（agent 控制面基础设计）
- `2026-06-05-owners-to-evolclaw-json.md`（owners 搬迁，已实现）
- D5 标注（现已拆分至 `src/core/command/menu-handler.ts` 的控制面闸门）

---

## 背景

当前 `/agent`、`/system` 等进程级操作仅用 `evolclaw.json.owners` 鉴权，任意 evolagent 的 AUN channel 均可作为入口（D5 注释占位）。这在多 evolagent 场景下过于宽松，需要收紧。

---

## 核心模型：三个正交维度

### 维度1：入口类型决定作用域

| 入口 | 作用域 |
|------|--------|
| 控制 channel（`evolclaw.json.aid`） | 整个 daemon（所有 agent + 进程级） |
| agent A 的 channel | 仅 agent A 自身 |

### 维度2：鉴权主体跟着入口走

| 入口 | 验谁 |
|------|------|
| 控制 channel | `evolclaw.json.owners` |
| agent A 的 channel | agent A 自身的 owner/admin 名单 |

### 维度3：操作分级

| 操作类 | 例子 | 控制 channel | agent channel |
|--------|------|:---:|:---:|
| 进程级 | `agent create/delete/enable/disable`、`system restart/upgrade` | ✅ | ❌ |
| 跨 agent 管理 | 对任意 agent 改配置/重载 | ✅（需显式 aid） | ❌ |
| 本 agent 管理 | `agent update`（改自身 owners/model/channels）、`agent reload` | ✅（需显式 aid） | ✅（`update` 仅 owner；`reload` owner/admin） |
| 关系级（自身） | session/trigger/model/chatmode/dispatch/perm/file | ✅（需显式 aid） | ✅（owner/admin） |
| 只读 | list/query/options | ✅（全量） | ✅（仅自身） |

> **本 agent 管理 vs 关系级的区别**：`agent update` 改的是 agent 的元配置（owners/channels/projects），
> 改完可能影响到这条 channel 自身的鉴权关系，因此 agent channel 侧仅 owner 可操作（不含 admin）。
> `agent reload` 只热重载已落盘配置，不直接修改鉴权关系；2026-06-11 新口径放宽为 owner/admin 可重载自身。
> 关系级操作（session/trigger/model/chatmode/dispatch/perm/file）不影响 agent 本身配置，owner/admin 均可。
> `model/chatmode/dispatch/perm` 同时存在 Agent 默认配置入口；Agent 级入口影响新关系/无覆盖关系的默认值，
> 关系级 slash/menu 入口只改当前关系或当前会话覆盖，二者不能混为一个权限层级。
> `file` 的项目内读取/发送按关系级 admin+；项目外文件和跨通道发送仍保留 owner-only。

---

## 判断逻辑

```
指令到达 execMenuAction / execMenuQuery / execMenuOptions
│
├── 来自控制 channel？
│   ├── 是 → 验 evolclaw.json.owners
│   │        ├── 不过 → FORBIDDEN
│   │        └── 过 → 全量权限；关系级操作需显式带 aid=目标（无隐含当前）
│   │
│   └── 否（来自 agent A 的 channel）
│        ├── 操作是进程级（create/delete/system）？ → 直接失败（此入口不存在该命令）
│        ├── 指令带 aid 且 ≠ A？ → 拒绝（无跨 agent 寻址）
│        └── 验 A 的 owner/admin
│             ├── 不过 → FORBIDDEN
│             └── 过 → 仅对 A 操作（session/trigger/model…）
```

---

## 设计要点

### 白名单而非黑名单

agent channel 使用**白名单**：只有关系级操作在允许列表内，进程级操作不在列表里。
新增操作时默认 agent channel 不可用，需显式开放——默认安全。

相比黑名单（"减去一些功能"），白名单能防止新增操作被遗漏而意外暴露。

### 作用域绑定，而非权限拦截

从 agent A 的 channel 发来的指令，操作对象**强制 = agent A 自身**：
- 不接受 `aid=B`（B ≠ A）的跨 agent 参数
- 不是"能寻址但拦住"，而是"压根没有跨 agent 入口"

### 控制 channel 的关系级操作

控制 channel 可以执行关系级操作（如给某 agent 设 trigger、切 model），但：
- 必须显式带 `aid=目标agent`
- 控制 channel 没有绑定业务 agent，没有"隐含当前 agent"概念

---

## 实现要点（已实现）

### 1. 标识控制 channel 来源

控制 channel 的消息需要携带标识，让 CommandHandler 能判断来源。

**方案**：在 `Message`（或 `InboundMessage`）中加 `isControlChannel?: boolean` 字段，由
`index.ts` 的 `controlChannel.onMessage` 回调在构造 InboundMessage 时注入。

### 2. execMenuAction 入口判断

在 `execMenuAction` / `execMenuQuery` / `execMenuOptions` 入口增加：

```typescript
const fromControlChannel = message?.isControlChannel ?? false;

// 进程级操作：只允许控制 channel
if (isProcessLevelCmd(cmdBase) && !fromControlChannel) {
  return { error: '此操作仅允许通过控制 AID channel 执行', code: 'FORBIDDEN' };
}

// 跨 agent 操作：只允许控制 channel
if (args?.aid && args.aid !== currentAgentAid && !fromControlChannel) {
  return { error: '跨 agent 操作仅允许通过控制 AID channel 执行', code: 'FORBIDDEN' };
}
```

### 3. 进程级命令白名单

```typescript
const PROCESS_LEVEL_CMDS = new Set(['/agent', '/system']);
// 关系级（agent channel 允许）：/session /trigger /model /chatmode /dispatch 等
```

### 4. 控制 channel 接入 CommandHandler

目前控制 channel 的消息在 `index.ts` 直接处理（只做 /pair），进程级 menu 指令同样需要路由到 CommandHandler。
接入时注入 `isControlChannel=true`，让鉴权判断生效。

---

## 当前代码状态

- ✅ `evolclaw.json.owners`、`isProcessLevelOwner` 已实现（owners 搬迁计划）
- ✅ 控制 channel 实例已创建（`index.ts`），有 owner 鉴权
- ✅ `isControlChannel` 标识字段已加（`types.ts` 的 `InboundMessage`）
- ✅ `isProcessLevelAction` + `gateControlScope` 双轨闸门已落地（`menu-handler.ts`）
- ✅ `/agent` 按 action 分级：进程级（create/delete/enable/disable）仅控制面；
  自管理强制自身 aid，其中 update 仅 owner、reload owner/admin；只读（list/show）仅自身
- ✅ 控制 channel 已接入 CommandHandler（`execMenuForControl`，路由 `menu.*`，注入 `fromControlChannel=true`）
- ✅ ECWeb 入口（`execMenuForEcweb`）按控制面 full-scope 放行

> 实现说明（与本文档原始设想的差异）：代码自 6-10 起重组，菜单 exec 函数现位于
> `src/core/command/menu-handler.ts`（非 `command-handler.ts`）。闸门实现为「白名单 action 集合 +
> gateControlScope helper」，在 `execMenuQuery/Update/Action/getSubMenuItems` 四个入口统一调用。
> 控制 channel 因是 `pureIdentity` 裸 AUNChannel（无 adapter），menu.response 以文本 JSON 经
> `sendMessage` 回发。控制 channel 的「关系级操作（带 aid 给某 agent 设 trigger/切 model）」
> 本轮未接入，留待后续。

### 测试
- 新增 `tests/unit/control-channel-auth.test.ts`（20 例，覆盖进程级闸/自管理/只读自身/控制面 full-scope/execMenuForControl）
- 更新 `menu-exec.test.ts`、`message-bridge-command-payload.test.ts`（适配 `fromControlChannel` 尾参与语义收紧）
- 全量 1587 测试通过
