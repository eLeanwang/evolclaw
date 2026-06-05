# AUN 菜单执行协议：query / update 模式

> ⚠️ **已废弃 (2026-05-26)**：本文档描述的 `mode` 字段方案已被 `menu.query` / `menu.update` 双类型协议取代。
> 当前规范见 [`aun-menu-protocol-dev-guide-v2.md`](./aun-menu-protocol-dev-guide-v2.md)。
> 本文保留为历史变更参考。

## 概述

在现有 `menu.query` 协议基础上，新增 `mode` 字段，支持通过菜单协议直接查询状态或执行命令，返回结构化数据供调用方（CLI、APP、小程序等）做自定义渲染。

## 协议设计

### 请求格式

```json
{ "type": "menu.query", "cmd": "/perm", "mode": "query" }
{ "type": "menu.query", "cmd": "/perm bypass", "mode": "update" }
```

### `mode` 字段

| 值 | 含义 | 返回 |
|----|------|------|
| 不传 | 现有行为：返回子菜单列表 | `items` |
| `"query"` | 查询当前状态（只读） | `data` |
| `"update"` | 执行命令并返回结果 | `data` |

`mode` 仅在有 `cmd` 时有意义。无 `cmd` 时忽略 `mode`，始终返回全量菜单。

### 响应格式

**子菜单列表（现有行为）：**
```json
{ "type": "menu.response", "cmd": "/perm", "items": [...] }
```

**query / update 成功：**
```json
{ "type": "menu.response", "cmd": "/perm", "data": { "mode": "bypass" } }
```

**query / update 失败：**
```json
{ "type": "menu.response", "cmd": "/perm", "error": "无权限" }
```

### 区分响应类型

调用方通过返回字段判断：
- 有 `items` → 子菜单列表
- 有 `data` → query/update 成功结果
- 有 `error` → 执行失败

## 支持的命令

### `/perm`

**query：**
```json
→ { "type": "menu.query", "cmd": "/perm", "mode": "query" }
← { "type": "menu.response", "cmd": "/perm", "data": { "mode": "auto" } }
```

**update：**
```json
→ { "type": "menu.query", "cmd": "/perm bypass", "mode": "update" }
← { "type": "menu.response", "cmd": "/perm", "data": { "mode": "bypass" } }
```

### `/chatmode`

**query：**
```json
→ { "type": "menu.query", "cmd": "/chatmode", "mode": "query" }
← { "type": "menu.response", "cmd": "/chatmode", "data": { "mode": "interactive" } }
```

**update：**
```json
→ { "type": "menu.query", "cmd": "/chatmode proactive", "mode": "update" }
← { "type": "menu.response", "cmd": "/chatmode", "data": { "mode": "proactive" } }
```

## 实现

### 服务端改动

**`handleCustomPayload()`**（`src/core/message/message-bridge.ts`）：

```
if (parsed.cmd && parsed.mode === 'query' || parsed.mode === 'update') {
  → 调用 cmdHandler.execMenu(cmd, mode, channel, channelId, userId)
  → 返回 { type: 'menu.response', cmd, data } 或 { ..., error }
}
```

**`CommandHandler.execMenu()`**（`src/core/command-handler.ts`，新增）：

```typescript
async execMenu(cmd: string, mode: 'query' | 'update', channel, channelId, userId?):
  Promise<{ data: Record<string, any> } | { error: string }>
```

- 解析 cmd 前缀（`/perm`、`/chatmode`）
- query → 读取当前状态，返回 data
- update → 执行切换，返回新状态 data
- 不支持的命令 → `{ error: "不支持 exec 模式" }`

### 扩展新命令

后续给其他命令加 exec 支持只需在 `execMenu()` 里加分支，返回对应 data 结构即可。
