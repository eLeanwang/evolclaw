# 配置参数归一化 + 角色级/关系级配置方案

**状态**：✅ 已实施完成（2026-06-13/14）  
**实施报告**：[role-relation-config-implementation.md](./role-relation-config-implementation.md)

---

## 背景与目标

把分散在多处的会话配置参数**归一化**到统一的存储与解析体系，并**启用关系级配置文件**（此前 `relations/<peerKey>/` 下只有 `peer-identity.json`，model-scope 设计的 `preferences.json` 从未产出过数据）。顺手清理几个不合理的历史设定。

**核心约束**：简单优先。不新增目录/文件，不造大引擎。角色配置**内嵌进 agent config.json 的 `roles` 块**。

## 三层 + 角色内嵌的存储结构

```
全局     agents/defaults.json                          （已有）
agent    agents/<aid>/config.json                      （已有，新增 roles 块）
 └ 角色  └ config.json 内的 "roles" 块                 （内嵌，非独立文件）
关系     agents/<aid>/relations/<peerKey>/config.json  （新启用，原 preferences.json 升级）
```

**不新增 `roles/` 目录**——角色配置是"这个 agent 怎么对待不同角色"，内嵌进 agent 自己的 config.json 名正言顺。

## 字段归属（定版）

| 字段 | 形状 | 进角色层？ | 适用场景 |
|------|------|:---:|------|
| model / effort | `baseagents.<ba>.{model,effort}` | ✅ | 全部 |
| permissionMode | 标量 | ✅ | 全部 |
| show_activities | 标量 `all\|none` | ❌ | 仅私聊有意义 |
| chatmode | 标量 | ❌ | 仅私聊 |
| dispatch | 标量 | ❌ | 仅群聊 |

**角色层只承载 model/effort + permissionMode**——这是核实代码后的结论：只有这两个真正"按角色派生值"。

- `show_activities`：群聊强制 proactive，proactive 本就不发中间活动，故群聊档冗余 → 退回标量，只管私聊。
- `chatmode`：群聊强制 proactive（硬码保留），group 档是死配置 → 退回标量，只管聊。
- `dispatch`：仅群聊概念。

## 统一 schema（agent config.json，定版）

```json
{
  "$schema_version": 1,
  "aid": "...",
  "baseagents": { "claude": { "model": "opus", "effort": "high" } },
  "chatmode": "interactive",
  "show_activities": "all",
  "dispatch": "mention",
  "roles": {
    "owner":     { "baseagents": { "claude": { "model": "opus"   } }, "permissionMode": "bypass"   },
    "admin":     { "permissionMode": "bypass" },
    "guest":     { "baseagents": { "claude": { "model": "sonnet" } }, "permissionMode": "readonly" },
    "anonymous": { "permissionMode": "readonly" }
  }
}
```

`roles[role]` 用 `RoleOverride = { baseagents?, permissionMode? }`，只含这两类字段。seed 值复刻现有 `resolvePermissionMode` 硬编码映射（owner/admin→bypass，guest/anonymous→readonly），把死代码变可配置数据，行为不变。

## 关系级 config.json（同形状，无 roles 子块）

```json
{
  "$schema_version": 1,
  "baseagents": { "claude": { "model": "opus" } },
  "permissionMode": "bypass",
  "updatedAt": 0
}
```

关系级针对具体对端，已足够具体，不再分角色。

## 解析链（按字段，越具体越优先；每字段独立回退）

| 字段 | 解析链 | 兜底 |
|------|--------|------|
| **model / effort** | 关系 > roles[role] > agent顶层 > 全局 | undefined（交 SDK 默认，不硬编码） |
| **permissionMode** | 关系 > roles[role] > 全局 | `'auto'` |
| **show_activities** | 关系 > agent > 全局（跳过角色层） | `'all'` |
| **chatmode**（仅私聊） | 关系 > agent > 全局，群聊忽略（强制 proactive） | `'interactive'` |
| **dispatch**（仅群聊） | 关系 > agent > 全局 | server 下发值 |

- model/effort 各自独立回退（关系级只设 model 时，effort 继续向下找）。
- 运行时 per-message 解析，不写进 session.metadata、不绑会话。
- `models.by_role` 的"按角色给模型"语义由 `roles[role].baseagents.<ba>.model` 表达（既分角色又分 baseagent，强于原设计）。

## 改动清单

### 1. src/types.ts
- `AgentConfig` 加 `roles?: Record<string, RoleOverride>`；新增 `RoleOverride = { baseagents?: BaseagentsBlock; permissionMode?: string }`
- `ShowActivitiesMode` 四值 → 二值 `'all' | 'none'`
- `ChatmodeBlock { private, group }` → 标量 `string`（'interactive' | 'proactive'）
- 删 `ModelsBlock.by_role`

### 2. src/core/model/model-scope.ts → config-scope.ts（改名）
- 关系级从 `config.json` 读（非 `preferences.json`）
- `ScopeSelector` 加 `role?: string`
- `ModelScope` 加 `'role'`；`determineScope`/`readScope`/`writeScope`/`clearScope` 加 role 分支
- `resolveEffectiveModel`：解析链插入 `roles[role]` 层；model/effort 独立回退
- 新增 `resolvePermissionMode(sel, role)`：关系 > roles[role] > 全局，兜底 'auto'

### 3. 运行时接入
- **permissionMode**：message-processor 9 处 `session.metadata?.permissionMode` → 改读解析器，**不再写 metadata**
- **show_activities**：channel-loader `showActivitiesPolicy` 改读标量（删 `dm-only`/`owner-dm-only` 判 chatType+role 逻辑；群聊直接 none，私聊读标量）
- **model/effort**：已接入，补传 role

### 4. 命令写入改向
- `/perm` 写关系级 config.json（让关系级文件真正产出）
- `/activity` 简化为 `all|none` 二选一（删 dm/owner 选项）
- `/chatmode` 私聊标量，`/chatmode interactive|proactive`（群聊不配）

### 5. 删硬编码
- `resolvePermissionMode(role)`（session-manager.ts:101）被 roles 块数据取代

### 6. 清历史
- show_activities 去编码（四值→二值）
- chatmode 退标量（group 分支删；强制 proactive 保留）
- preferences.json → config.json 命名对齐
- 删 `/safe` 死代码（slash-handler / slash-gate）

## 保留不动的设定

- **群聊强制 proactive**（session-manager.ts:65 硬码）保留——不动群聊响应逻辑。
- **命令权限门控**（isOwner/isAdmin）保留——这是"谁能改"，与配置值无关。
- `ModelsBlock` 其余字段（default/allowed）本期不清理。

## 验证

- 单元测试：解析链各字段四层优先级、model/effort 独立回退、permissionMode 角色派生 + 兜底
- 关系级文件读写：`/perm` 执行后产出 `relations/<peerKey>/config.json`，下条消息生效
- 运行时：guest/owner 不同角色拿到不同 model/permissionMode
- `npm run build` + 相关测试通过

## 范围边界（明确不做）

- CLI `--role`（写入靠手改 JSON 或 `/perm` 等命令）
- 统一单入口 `resolveEffectiveConfig`（本期仍 per-field 解析器，共用 readScope 底座）
- 统一 ConfigResolver 大引擎
- ModelsBlock default/allowed 清理
- 群聊 chatmode 可配（强制 proactive 保留）
