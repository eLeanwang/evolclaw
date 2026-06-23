# Slash 指令与 Menu 协议权限对齐

**日期**：2026-06-11
**状态**：✅ 已实现
**关联**：
- [`2026-06-10-control-channel-auth-design.md`](2026-06-10-control-channel-auth-design.md)（控制面双轨鉴权，已实现）

---

## 背景

控制面双轨鉴权（menu 协议侧）落地后，发现 slash 指令路径与 menu 协议存在权限不一致：

| 操作 | menu 协议（`/system restart`） | slash 指令（`/restart`） |
|------|-------------------------------|------------------------|
| 鉴权主体 | `evolclaw.json.owners`（daemon owner） | agent-channel role（`isOwner`）|
| 范围 | 进程级，仅控制面 | 关系级，任意 agent channel owner 均可触发 |

此外缺少 `/reload` slash 指令（menu 协议已支持 `/agent reload`），用户无法通过 slash 热重载 agent 配置。

---

## 目标

1. **对齐**：`/restart` slash 指令改为验 daemon owner（`evolclaw.json.owners`），与 menu 协议 `/system restart` 一致
2. **新增**：`/reload [aid]` slash 指令，权限与 menu 协议 `/agent reload` 一致
3. **最小权限原则**：daemon owner 在 guest 角色的 channel 上只能执行进程级命令，不能越权获得 admin 级别的关系级命令权限

---

## 权限模型

### `/restart`（进程级，对齐后）

| 条件 | 结果 |
|------|------|
| `userId ∈ evolclaw.json.owners` | ✅ 允许重启 |
| `userId ∉ evolclaw.json.owners`（无论 agent-channel role） | ❌ FORBIDDEN |

### `/reload [aid]`（新增）

| 调用者 | 条件 | 行为 |
|--------|------|------|
| daemon owner（`evolclaw.json.owners`） | — | 可 reload 任意 aid；无参则 reload 当前 channel 绑定的 agent |
| agent channel owner/admin | `resolveIdentity` 返回 owner/admin | 只能 reload 自身 aid；指定他人 aid → FORBIDDEN |
| guest | — | FORBIDDEN |

两者共同规则：目标 agent 有任务执行中时拒绝（繁忙检查，`messageQueue`）。

### 权限隔离原则

daemon owner 对 `guardRoleCommand` 的 bypass **仅限进程级 slash 命令**（`/restart` / `/reload`），
不扩展到关系级命令（`/model`、`/chatmode`、`/fork` 等）。

```
daemon owner + guest role:
  /restart → 允许  ✅（进程级 bypass）
  /reload  → 允许  ✅（进程级 bypass）
  /model   → 拒绝  ❌（关系级不越权）
  /fork    → 拒绝  ❌（关系级不越权）
```

### 关系级与 Agent 级设置

以下命令存在两个层级，不能全部视为关系级：

| 命令 | 关系级 slash/menu | Agent 级默认配置 |
|------|-------------------|------------------|
| `/model <x>` | 当前关系/会话的模型覆盖，owner/admin 可改 | Agent 默认模型，owner/admin 可改 |
| `/chatmode <x>` | 当前关系/会话模式覆盖，owner/admin 可改 | Agent 默认 chatmode，owner/admin 可改 |
| `/dispatch <x>` | 当前群关系/venue 分发覆盖，owner/admin 可改 | Agent 默认群分发策略，owner/admin 可改 |
| `/perm <mode>` | 当前关系/会话权限模式，owner/admin 可改 | Agent 默认权限模式，owner/admin 可改 |

`/file <path>` 属于当前关系操作，项目内文件 owner/admin 可发送；跨通道发送和项目外文件仍保留 owner-only。

---

## 实现

### 改动文件

**`src/core/command/slash-handler.ts`**

1. 新增 import：`loadEvolclawConfig`（config-store）、`isProcessLevelOwner`（menu-handler）、`execAgentAction`（command-handler-agent-control）
2. 在 `guardRoleCommand` 调用前缓存 `evolclawConfig` 并计算 `isDaemonOwner`；bypass 仅对进程级 slash 命令生效：
   ```typescript
   const evolclawConfig = loadEvolclawConfig();
   const isDaemonOwner = isProcessLevelOwner(userId, evolclawConfig.owners);
   const isProcessLevelSlash = normalizedContent === '/restart'
     || normalizedContent === '/reload'
     || normalizedContent.startsWith('/reload ');
   const roleGuard = guardRoleCommand(normalizedContent, activeChatType, isAdmin || (isDaemonOwner && isProcessLevelSlash));
   ```
3. `/restart` 检查改为 `if (!isDaemonOwner)` —— 复用缓存，不再调用 `loadEvolclawConfig()`
4. 新增 `/reload [aid]` handler（插入 `/agent` 拒绝块之前）

**`src/core/command/slash-gate.ts`**

- `commands` 和 `quickCommandPrefixes` 列表加入 `/reload`
- `/reload` 不加入 `guestGroupCommands`（关系级对 guest 仍拒绝；daemon owner 通过 roleGuard bypass 进入）

### `/reload` handler 核心逻辑

```
/reload [aid]
  ├── !isDaemonOwner && !isAdmin → FORBIDDEN
  ├── !isDaemonOwner && aidArg && aidArg !== selfAid → 跨 agent FORBIDDEN
  ├── targetAid = aidArg ?? selfAid
  ├── !targetAid → 提示指定 aid
  ├── agentRegistry 存在 && 繁忙 → 拒绝
  └── execAgentAction('reload', { aid: targetAid }, userId)
```

---

## 测试

| 文件 | 新增 / 修改 | 覆盖点 |
|------|------------|--------|
| `tests/unit/slash-reload.test.ts` | 新增（14 例） | daemon owner 全场景、agent owner/admin 自身、guest、繁忙、边界、权限隔离（不越权） |
| `tests/unit/command-handler-restart.test.ts` | 修改（加 afterEach + daemon owner mock） | 非 daemon owner 拒绝（即便 agent-channel owner）、daemon owner 执行成功 |

全量测试：141 文件 / 1601 例通过。

---

## 设计要点

- **不修改 `guardRoleCommand` 本身**：bypass 在调用侧通过 `isAdmin || (isDaemonOwner && isProcessLevelSlash)` 实现，最小侵入
- **config 缓存**：`loadEvolclawConfig()` 在函数入口调用一次，`/restart` 和 `/reload` 共用结果，避免重复 I/O 和时序不一致
- **`/reload` 对齐 menu 协议**：底层调用路径相同（`execAgentAction('reload', ...)`），繁忙检查逻辑相同
