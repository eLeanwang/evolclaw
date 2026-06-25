# Evol App 集成文档：项目文件浏览器

> 适用对象：Evol App / Web / Desktop 客户端。
> 协议范围：`menu name=file` 的 `query`、`action:list`、`action:fetch`。
> 传输方式：通过 AUN 普通消息发送 JSON payload，Agent 返回 `menu.response`。

## 1. 能力概览

Evol App 可通过 Menu Protocol 实现项目文件浏览器：

1. 打开文件浏览器时请求目录列表：`menu.action name=file action=list`
2. 点击目录时再次请求该目录列表
3. 点击文件时先查元信息：`menu.query name=file`
4. 本地缓存缺失或已过期时拉取文件：`menu.action name=file action=fetch`
5. `fetch` 成功响应只表示 Agent 已受理发送；文件会作为独立 `type:"file"` 消息异步到达

文件列表只返回当前目录一层，不递归。客户端通过 `data.path + "/" + entry.name` 拼出子路径。

## 2. 通用协议格式

### 请求

所有请求都必须带唯一 `id`，客户端用它配对 `menu.response`。

```json
{
  "type": "menu.action",
  "id": "request-id",
  "name": "file",
  "action": "list",
  "args": {}
}
```

### 成功响应

```json
{
  "type": "menu.response",
  "id": "request-id",
  "name": "file",
  "data": {}
}
```

### 错误响应

```json
{
  "type": "menu.response",
  "id": "request-id",
  "name": "file",
  "error": {
    "code": "NOT_FOUND",
    "message": "文件不存在"
  }
}
```

`data` 与 `error` 互斥。客户端不要依赖 `ok` 字段。

## 3. 浏览流程

### 3.1 打开项目根目录

请求：

```json
{
  "type": "menu.action",
  "id": "file-list-root-001",
  "name": "file",
  "action": "list",
  "args": {
    "path": ".",
    "offset": 0,
    "limit": 500,
    "includeHidden": false
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "file-list-root-001",
  "name": "file",
  "data": {
    "path": ".",
    "entries": [
      {
        "name": "docs",
        "type": "directory",
        "size": null,
        "mtime": 1781750000000,
        "birthtime": 1781749000000
      },
      {
        "name": "src",
        "type": "directory",
        "size": null,
        "mtime": 1781750000000,
        "birthtime": 1781749000000
      },
      {
        "name": "package.json",
        "type": "file",
        "size": 2048,
        "mtime": 1781750000000,
        "birthtime": 1781749000000
      }
    ],
    "total": 3,
    "offset": 0,
    "limit": 500,
    "hasMore": false
  }
}
```

### 3.2 进入子目录

客户端点击 `src` 后，下一次请求使用拼出的路径 `src`。

请求：

```json
{
  "type": "menu.action",
  "id": "file-list-src-001",
  "name": "file",
  "action": "list",
  "args": {
    "path": "src",
    "offset": 0,
    "limit": 500,
    "includeHidden": false
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "file-list-src-001",
  "name": "file",
  "data": {
    "path": "src",
    "entries": [
      {
        "name": "core",
        "type": "directory",
        "size": null,
        "mtime": 1781750000000,
        "birthtime": 1781749000000
      },
      {
        "name": "index.ts",
        "type": "file",
        "size": 8192,
        "mtime": 1781750000000,
        "birthtime": 1781749000000
      }
    ],
    "total": 2,
    "offset": 0,
    "limit": 500,
    "hasMore": false
  }
}
```

路径拼接规则：

| 当前 `data.path` | 条目 `name` | 子路径 |
|---|---|---|
| `"."` | `"src"` | `"src"` |
| `"src"` | `"core"` | `"src/core"` |
| `"src/core"` | `"command-handler.ts"` | `"src/core/command-handler.ts"` |

### 3.3 加载更多

当响应中 `hasMore:true` 时，客户端用下一页 `offset` 继续请求。

请求：

```json
{
  "type": "menu.action",
  "id": "file-list-src-core-page-2",
  "name": "file",
  "action": "list",
  "args": {
    "path": "src/core",
    "offset": 500,
    "limit": 500,
    "includeHidden": false
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "file-list-src-core-page-2",
  "name": "file",
  "data": {
    "path": "src/core",
    "entries": [],
    "total": 500,
    "offset": 500,
    "limit": 500,
    "hasMore": false
  }
}
```

### 3.4 App 界面操作示意

入口：会话详情页或工具菜单中提供“项目文件”入口。点击后打开文件浏览面板，并立即请求 `path:"."`。

```
会话页
  ↓ 点击“项目文件”
文件浏览面板：/
  ├─ docs/              目录，点击进入
  ├─ src/               目录，点击进入
  └─ package.json       文件，点击查看/拉取
```

目录页建议布局：

```text
┌────────────────────────────────────────┐
│ 项目文件                     [刷新]    │
│ / src / core                           │
├────────────────────────────────────────┤
│ ↑ 上一级                               │
│ 📁 command/                 06-18      │
│ 📁 message/                 06-18      │
│ 📄 menu-handler.ts          62 KB      │
│ 📄 permission.ts             8 KB      │
├────────────────────────────────────────┤
│ 显示 500 / 1234              加载更多 │
└────────────────────────────────────────┘
```

推荐交互：

| 用户操作 | App 行为 | 协议调用 |
|---|---|---|
| 打开文件面板 | 显示 loading，列项目根目录 | `action:list { path:"." }` |
| 点击目录 | 更新面包屑，进入该目录 | `action:list { path:"src/core" }` |
| 点击“上一级” | 回到父目录 | `action:list { path:"src" }` |
| 点击“加载更多” | 在当前列表尾部追加下一页 | `action:list { path, offset: offset + entries.length }` |
| 点击文件 | 先查缓存元信息 | `menu.query name=file` |
| 文件缓存未命中 | 显示拉取中状态 | `action:fetch` |
| 收到 `correlation_id` 匹配的文件消息 | 打开文件预览或保存缓存 | 处理异步 `type:"file"` 消息 |
| 点击刷新 | 保持当前 path，重新拉第一页 | `action:list { path, offset:0 }` |

## 4. 接口：目录列表

### 请求

```json
{
  "type": "menu.action",
  "id": "file-list-001",
  "name": "file",
  "action": "list",
  "args": {
    "path": "docs",
    "offset": 0,
    "limit": 500,
    "includeHidden": false
  }
}
```

### 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---:|---|---|
| `path` | string | 否 | `"."` | 要列出的目录路径。支持相对项目路径或项目内绝对路径 |
| `offset` | number | 否 | `0` | 分页偏移。负数、非有限数会按 `0` 处理 |
| `limit` | number | 否 | `500` | 每页条数。有效范围 `1..1000`，超过会被 clamp |
| `includeHidden` | boolean | 否 | `false` | 是否包含以 `.` 开头的文件和目录 |

### 成功返回

```json
{
  "type": "menu.response",
  "id": "file-list-001",
  "name": "file",
  "data": {
    "path": "docs",
    "entries": [
      {
        "name": "menu-file-list-design.md",
        "type": "file",
        "size": 12500,
        "mtime": 1781750000000,
        "birthtime": 1781749000000
      }
    ],
    "total": 1,
    "offset": 0,
    "limit": 500,
    "hasMore": false
  }
}
```

### 返回字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | 回显本次列出的目录路径 |
| `entries` | array | 当前页条目 |
| `total` | number | 过滤隐藏文件后的目录总条目数 |
| `offset` | number | 本次请求实际使用的 offset |
| `limit` | number | 本次请求实际使用的 limit |
| `hasMore` | boolean | 是否还有下一页 |

### 条目字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 文件或目录名，不含路径 |
| `type` | `"file"` 或 `"directory"` | 条目类型 |
| `size` | number 或 null | 文件字节数；目录为 `null` |
| `mtime` | number | 服务端文件修改时间，毫秒时间戳 |
| `birthtime` | number | 服务端文件创建时间，毫秒时间戳 |

### 排序与 symlink

- 服务端返回顺序为：目录优先，然后按名称排序。
- 指向目录的 symlink 返回 `type:"directory"`，客户端可按目录点击进入。
- 断链、不可访问、或非 owner 遇到指向项目外目录的 symlink，会按 `type:"file"` 降级展示。

## 5. 接口：文件元信息

用于点击文件前做缓存校验。客户端已有本地文件缓存时，推荐先调用该接口。

### 请求

```json
{
  "type": "menu.query",
  "id": "file-query-001",
  "name": "file",
  "args": {
    "path": "docs/menu-file-list-design.md"
  }
}
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `path` | string | 是 | 文件路径。支持相对项目路径或项目内绝对路径 |

### 成功返回

```json
{
  "type": "menu.response",
  "id": "file-query-001",
  "name": "file",
  "data": {
    "path": "docs/menu-file-list-design.md",
    "sha256": "ab12cd34ef56",
    "size": 12500,
    "mtime": 1781750000000
  }
}
```

大文件返回：

```json
{
  "type": "menu.response",
  "id": "file-query-large-001",
  "name": "file",
  "data": {
    "path": "dist/large.bin",
    "sha256": null,
    "size": 5242880,
    "mtime": 1781750000000
  }
}
```

### 返回字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | 回显请求路径 |
| `sha256` | string 或 null | 文件内容 hash。仅文件不超过 2 MB 时计算；更大文件返回 `null` |
| `size` | number | 文件字节数 |
| `mtime` | number | 服务端文件修改时间，毫秒时间戳 |

缓存判断建议：

| 情况 | 客户端行为 |
|---|---|
| 本地无缓存 | 直接调用 `action:fetch` |
| `sha256` 为 string | 优先用 sha256 比对缓存 |
| `sha256` 为 null | 用 `size + mtime` 比对缓存 |
| 元信息不同 | 调用 `action:fetch` 重新拉取 |
| 元信息相同 | 使用本地缓存 |

## 6. 接口：拉取文件

`fetch` 会触发 Agent 通过当前 AUN 会话发送文件。同步 `menu.response` 只代表受理成功；真正文件作为独立 `type:"file"` 消息异步到达。

### 请求

```json
{
  "type": "menu.action",
  "id": "file-fetch-001",
  "name": "file",
  "action": "fetch",
  "args": {
    "path": "docs/menu-file-list-design.md"
  }
}
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `path` | string | 是 | 文件路径。支持相对项目路径或项目内绝对路径 |

### 受理成功响应

```json
{
  "type": "menu.response",
  "id": "file-fetch-001",
  "name": "file",
  "data": {
    "action": "fetch",
    "success": true,
    "size": 12500
  }
}
```

### 异步文件消息

随后客户端会在消息流中收到文件消息。AUN 文件 payload 顶层会带 `correlation_id`，值等于 fetch 请求的 `id`。

```json
{
  "type": "file",
  "text": "menu-file-list-design.md",
  "correlation_id": "file-fetch-001",
  "attachments": [
    {
      "filename": "menu-file-list-design.md",
      "size": 12500,
      "url": "https://..."
    }
  ]
}
```

客户端应使用 `correlation_id` 将异步文件消息配对回本次 `fetch` 请求。

### 文件大小限制

`fetch` 单文件上限为 10 MB。超过限制时返回 `FILE_TOO_LARGE`，不会发送异步文件消息。

```json
{
  "type": "menu.response",
  "id": "file-fetch-large-001",
  "name": "file",
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "文件过大: 12.3 MB (限制 10 MB)"
  }
}
```

## 7. 权限与路径规则

### 角色权限

| 操作 | owner | admin | guest / anonymous |
|---|:---:|:---:|:---:|
| `action:list` 项目内目录 | 是 | 是 | 否 |
| `query` 项目内文件 | 是 | 是 | 否 |
| `action:fetch` 项目内文件 | 是 | 是 | 否 |
| 项目外路径 | 是 | 否 | 否 |

### 路径规则

| 规则 | 说明 |
|---|---|
| 相对路径 | 基于当前会话的 `projectPath` 解析 |
| 项目内绝对路径 | 允许 |
| 项目外路径 | 仅 owner 允许 |
| `..` 路径穿越 | 拒绝 |
| `list` 目标 | 必须是目录 |
| `query` / `fetch` 目标 | 必须是文件 |

## 8. 错误码

| code | 触发场景 | 建议 UI 行为 |
|---|---|---|
| `NO_ACTIVE_SESSION` | 当前没有活跃会话或项目路径 | 提示先建立会话，文件浏览器置灰 |
| `NO_PERMISSION` | 角色不足、项目外路径非 owner、目录不可读 | 提示无权限 |
| `NOT_FOUND` | 文件或目录不存在 | 刷新当前目录，提示目标已不存在 |
| `NOT_A_DIRECTORY` | `list` 的 path 指向文件 | 按文件处理或刷新当前目录 |
| `NOT_SUPPORTED` | `query/fetch` 的 path 指向目录，或未知 action | 刷新 UI 状态 |
| `FILE_TOO_LARGE` | `fetch` 文件超过 10 MB | 提示文件过大 |
| `EXEC_FAILED` | 目录读取或文件发送出现其它失败 | 提示操作失败，可允许用户重试 |

## 9. 客户端状态建议

### 目录面板状态

| 状态 | 触发 |
|---|---|
| loading | 已发出 `action:list`，等待同 id 的 `menu.response` |
| ready | 收到 `data.entries` |
| empty | `total` 为 0 |
| error | 收到 `error` |
| loadingMore | `hasMore:true` 且正在请求下一页 |

### 文件拉取状态

| 状态 | 触发 |
|---|---|
| checking | 已发出 `menu.query name=file` |
| cached | 元信息与本地缓存一致 |
| fetching | 已发出 `action:fetch`，等待同 id response 或后续 `correlation_id` 文件消息 |
| accepted | 收到 `action:fetch` 的成功 `menu.response` |
| received | 收到 `correlation_id` 匹配的文件消息 |
| failed | 收到错误响应或超时 |

## 10. 超时与重试

| 请求 | 建议超时 | 重试建议 |
|---|---:|---|
| `action:list` | 5 秒 | 可静默重试一次 |
| `menu.query name=file` | 5 秒 | 可静默重试一次 |
| `action:fetch` 的 `menu.response` | 5 秒 | 不建议自动重试，避免重复发送文件 |
| 异步文件消息 | 30 秒 | 超时后允许用户手动重试 |

## 11. 端到端示例

### 1. 打开根目录

请求：

```json
{
  "type": "menu.action",
  "id": "e2e-list-root",
  "name": "file",
  "action": "list",
  "args": { "path": "." }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "e2e-list-root",
  "name": "file",
  "data": {
    "path": ".",
    "entries": [
      { "name": "docs", "type": "directory", "size": null, "mtime": 1781750000000, "birthtime": 1781749000000 }
    ],
    "total": 1,
    "offset": 0,
    "limit": 500,
    "hasMore": false
  }
}
```

### 2. 进入 docs

请求：

```json
{
  "type": "menu.action",
  "id": "e2e-list-docs",
  "name": "file",
  "action": "list",
  "args": { "path": "docs" }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "e2e-list-docs",
  "name": "file",
  "data": {
    "path": "docs",
    "entries": [
      { "name": "menu-file-list-design.md", "type": "file", "size": 12500, "mtime": 1781750000000, "birthtime": 1781749000000 }
    ],
    "total": 1,
    "offset": 0,
    "limit": 500,
    "hasMore": false
  }
}
```

### 3. 查询文件元信息

请求：

```json
{
  "type": "menu.query",
  "id": "e2e-query-file",
  "name": "file",
  "args": { "path": "docs/menu-file-list-design.md" }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "e2e-query-file",
  "name": "file",
  "data": {
    "path": "docs/menu-file-list-design.md",
    "sha256": "ab12cd34ef56",
    "size": 12500,
    "mtime": 1781750000000
  }
}
```

### 4. 拉取文件

请求：

```json
{
  "type": "menu.action",
  "id": "e2e-fetch-file",
  "name": "file",
  "action": "fetch",
  "args": { "path": "docs/menu-file-list-design.md" }
}
```

同步响应：

```json
{
  "type": "menu.response",
  "id": "e2e-fetch-file",
  "name": "file",
  "data": {
    "action": "fetch",
    "success": true,
    "size": 12500
  }
}
```

异步文件消息：

```json
{
  "type": "file",
  "correlation_id": "e2e-fetch-file",
  "attachments": [
    {
      "filename": "menu-file-list-design.md",
      "size": 12500,
      "url": "https://..."
    }
  ]
}
```
