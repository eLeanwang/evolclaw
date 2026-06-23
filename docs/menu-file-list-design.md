# Menu File List 设计：项目文件浏览

> 状态：已实现（2026-06-18）。
> 实现位置：`src/core/command/menu-handler.ts`（单处改动，**无需动任何白名单**，见 §6）。

## 1. 目标

在客户端（Evol App/Web）提供**项目文件浏览器**能力：

- 列出指定目录下的文件和子目录（**仅当前层，不递归**）
- 逐层进入子目录浏览
- 点击文件触发查阅（复用现有 `action:fetch`）

是对现有 `menu name=file`（`query` 文件元信息 + `action:fetch` 拉取）的补完：新增 `action:list`，让客户端在 fetch 之前能先"看见"目录里有什么。

---

## 2. API 设计

`menu.action name=file action=list`（沿用 `file` 命名空间，与 `fetch` 并列）。

### 2.1 请求

```jsonc
{
  "type": "menu.action",
  "id": "a-ls-1",
  "name": "file",
  "action": "list",
  "args": {
    "path": "src/core",       // 可选，目录路径（相对/项目内绝对），默认 "."
    "offset": 0,              // 可选，分页偏移，默认 0
    "limit": 500,             // 可选，每页条目数，默认 500（上限见 §5）
    "includeHidden": false    // 可选，是否含 .* 文件/目录，默认 false
  }
}
```

### 2.2 响应

```jsonc
{
  "type": "menu.response",
  "id": "a-ls-1",
  "name": "file",
  "data": {
    "path": "src/core",        // 回显本次列出的目录（与请求 args.path 一致）
    "entries": [
      { "name": "session",            "type": "directory", "size": null,  "mtime": 1717900000000, "birthtime": 1717800000000 },
      { "name": "message",            "type": "directory", "size": null,  "mtime": 1717900000000, "birthtime": 1717800000000 },
      { "name": "command-handler.ts", "type": "file",      "size": 45678, "mtime": 1717900000000, "birthtime": 1717800000000 }
    ],
    "total": 1234,             // 过滤隐藏文件后的目录内条目总数
    "offset": 0,               // 本次请求的偏移
    "limit": 500,              // 本次请求的每页数量
    "hasMore": true            // offset + entries.length < total
  }
}
```

### 2.3 条目结构

每个条目仅包含 5 个字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 文件/目录名（不含路径） |
| `type` | `"file"` \| `"directory"` | 条目类型 |
| `size` | number \| null | 文件字节数；**目录为 `null`** |
| `mtime` | number | 修改时间（`fs.statSync().mtimeMs`） |
| `birthtime` | number | 创建时间（`fs.statSync().birthtimeMs`） |

> **不含 `path` 字段**：非递归模式下所有条目都在 `data.path` 这一层，客户端用 `data.path + "/" + name` 即可拼出完整路径用于后续 `fetch`/进入子目录。

---

## 3. 关键决策汇总

| 项 | 决策 | 理由 |
|---|---|---|
| 操作类型 | `action: list` | `query` 语义是单资源元信息，列表用 action 动词更清晰，与 `fetch` 对称 |
| 条目字段 | name / type / size / mtime / birthtime | 最小够用；去掉 path（非递归不需要）、extension（客户端可从 name 提取） |
| 目录 size | `null` | 语义明确"无大小"，不递归统计 |
| 递归 | **不支持** | 文件浏览器逐层进入符合心智；避免大项目性能爆炸；与"去 path"一致 |
| 隐藏文件 | 默认隐藏 `.*`，`includeHidden:true` 开启 | `.env`/`.git` 等通常不需浏览，且 `.env` 可能含敏感信息 |
| 忽略列表 | **无硬编码忽略** | 非递归下 `node_modules`/`dist` 只是普通目录条目，不会真正遍历；不武断隐藏 |
| 分页 | `offset`/`limit`，默认 `limit=500` | 大目录可翻页加载，不丢文件（区别于截断方案） |
| 参数防御 | `offset` 非有限数/负数 → 0；`limit` 非有限数/空值 → 500，范围 clamp 到 1..1000 | 防止 `Infinity`、小数、负数、空字符串等异常输入影响分页 |
| 性能 | readdir 全量 + 轻量类型判定 + 排序 → 切片 → 本页 stat | 普通目录/文件走 Dirent；symlink 需额外 realpath/stat 才能判断目标类型 |
| 排序 | 服务端：目录优先 + 名称序（`localeCompare`） | 翻页一致性需要稳定排序；客户端可在此基础上自行重排 |
| symlink | 指向目录的 symlink 显示为 `directory`；断链或不可访问则按 `file` 降级 | 满足客户端逐层进入目录 symlink 的需求；失败时不中断整个列表 |
| symlink 权限 | 非 owner 不跟随指向项目外的 symlink；owner 可沿用项目外访问规则 | 避免 admin 通过项目内 symlink 浏览项目外目录 |
| 权限 | 沿用 `query`/`fetch`：owner/admin；项目外仅 owner | list/query/fetch 是一套浏览流程，权限须一致 |
| 路径校验 | `resolveMenuFilePath` 加 `expectType` 参数 | 现有函数拒绝目录，list 恰好只接受目录，加参数区分 file/directory |
| 错误码 | 复用现有 + 新增 `NOT_A_DIRECTORY`；目录读取权限错误返回 `NO_PERMISSION` | 路径指向文件而非目录、或目录不可读时返回结构化错误 |

---

## 4. 实现细节

### 4.1 改造 `resolveMenuFilePath` 加 `expectType` 参数

现有函数末尾**专门拒绝目录**（query/fetch 只处理文件）：

```typescript
const stat = fs.statSync(realPath);
if (stat.isDirectory()) {
  return { error: '暂不支持目录', code: 'NOT_SUPPORTED' };  // ← 现状
}
```

改为按期望类型校验：

```typescript
function resolveMenuFilePath(
  input: string,
  session: { projectPath: string } | null | undefined,
  role: string | undefined,
  expectType?: 'file' | 'directory',   // 新增；不传则不校验类型
): { realPath: string; projectPath: string; stat: fs.Stats } | { error: string; code: string } {
  // ... 前段不变（空值、.. 穿越、解析、existsSync、realpathSync、项目内外权限）...

  const stat = fs.statSync(realPath);
  if (expectType === 'file' && stat.isDirectory()) {
    return { error: '暂不支持目录', code: 'NOT_SUPPORTED' };
  }
  if (expectType === 'directory' && !stat.isDirectory()) {
    return { error: '不是目录', code: 'NOT_A_DIRECTORY' };
  }
  return { realPath, projectPath: realProjectPath, stat };
}
```

调用方调整：
- `execMenuQuery` 的 `/file`（元信息）→ 传 `'file'`
- `execMenuAction` 的 `/file` `fetch` → 传 `'file'`
- `execMenuAction` 的 `/file` `list`（新增）→ 传 `'directory'`

> 注意：`args.path` 默认为 `"."`（项目根）时，`resolveMenuFilePath` 会把它解析到 `projectPath` 本身，`realPath === realProjectPath`，`inProject` 判定为真，正常放行。

### 4.2 新增 `listDirectory` 辅助函数

```typescript
const FILE_LIST_DEFAULT_LIMIT = 500;
const FILE_LIST_MAX_LIMIT = 1000;   // 防御性 clamp，单页硬上限

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number | null;
  mtime: number;
  birthtime: number;
}

function listDirectory(
  realPath: string,
  options: {
    offset: number;
    limit: number;
    includeHidden: boolean;
    projectPath: string;
    role: string | undefined;
  },
): { data: { entries: FileEntry[]; total: number; offset: number; limit: number; hasMore: boolean } } | { error: string; code: string } {
  const { offset, limit, includeHidden, projectPath, role } = options;

  // 1. readdir 全量（withFileTypes：拿到 name + entry 基础类型）
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(realPath, { withFileTypes: true });
  } catch (e: any) {
    const code = e?.code === 'EACCES' || e?.code === 'EPERM' ? 'NO_PERMISSION' : 'EXEC_FAILED';
    return { error: `目录读取失败: ${e?.message ?? e}`, code };
  }

  // 2. 过滤隐藏文件
  if (!includeHidden) {
    dirents = dirents.filter(d => !d.name.startsWith('.'));
  }

  // 3. 计算排序/返回类型：
  //    - 普通目录直接按 Dirent.isDirectory()
  //    - symlink 用 realpath/stat 跟随目标；指向目录则显示为 directory
  //    - 非 owner 遇到指向项目外的 symlink 不跟随，按 file 降级
  const entryInfoByName = new Map<string, { isDirectory: boolean; followTarget: boolean }>();
  for (const d of dirents) {
    entryInfoByName.set(d.name, getDirectoryEntryInfo(realPath, projectPath, role, d));
  }

  // 4. 排序：目录优先，再按名称 localeCompare
  dirents.sort((a, b) => {
    const ad = entryInfoByName.get(a.name)?.isDirectory ?? false;
    const bd = entryInfoByName.get(b.name)?.isDirectory ?? false;
    if (ad !== bd) return ad ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const total = dirents.length;

  // 5. 切片
  const page = dirents.slice(offset, offset + limit);

  // 6. 仅对本页 statSync / lstatSync（拿 size / mtime / birthtime）
  const entries: FileEntry[] = page.map(d => {
    const full = path.join(realPath, d.name);
    const info = entryInfoByName.get(d.name) ?? { isDirectory: false, followTarget: true };
    let stat: fs.Stats | null = null;
    try {
      stat = info.followTarget ? fs.statSync(full) : fs.lstatSync(full);
    } catch { /* 竞态删除：size/time 缺省 */ }
    return {
      name: d.name,
      type: info.isDirectory ? 'directory' : 'file',
      size: info.isDirectory ? null : (stat?.size ?? null),
      mtime: stat?.mtimeMs ?? 0,
      birthtime: stat?.birthtimeMs ?? 0,
    };
  });

  return { data: { entries, total, offset, limit, hasMore: offset + entries.length < total } };
}
```

> **符号链接**：已支持指向目录的 symlink 显示为 `directory`，并参与目录优先排序。非 owner 遇到指向项目外的 symlink 不跟随，按普通 `file` 降级；owner 仍沿用项目外路径访问权限。断链、目标删除、无权限等竞态不导致整个列表失败。

### 4.3 在 `execMenuAction` 的 `/file` 分支新增 `list`

```typescript
if (cmdBase === '/file') {
  if (action === 'list') {
    // 权限：与 query/fetch 一致
    if (identity.role !== 'owner' && identity.role !== 'admin') {
      return { error: '无权限', code: 'NO_PERMISSION' };
    }
    const dirArg = (args?.path ?? '.').toString().trim() || '.';
    const resolved = resolveMenuFilePath(dirArg, session, identity.role, 'directory');
    if ('error' in resolved) return resolved;

    const offset = parseFileListOffset(args?.offset);
    const limit = parseFileListLimit(args?.limit);
    const includeHidden = args?.includeHidden === true;

    const result = listDirectory(resolved.realPath, {
      offset,
      limit,
      includeHidden,
      projectPath: resolved.projectPath,
      role: identity.role,
    });
    if ('error' in result) return result;
    return { data: { path: dirArg, ...result.data } };
  }

  if (action === 'fetch') {
    // ... 现有实现（resolveMenuFilePath(..., 'file')）...
  }

  return { error: `不支持的 file action: ${action}`, code: 'NOT_SUPPORTED' };
}
```

> `list` 是只读查询，**不需要** `fetch` 那段 `adapter.capabilities?.file` 检查（它返回 JSON，不发文件）。

---

## 5. 限制与边界

| 限制项 | 值 | 说明 |
|---|---|---|
| 默认每页 | 500 | `args.limit` 未指定时 |
| 单页上限 | 1000 | 超过按 1000 clamp（防御性，防止单次 statSync 过多） |
| 递归 | 不支持 | 只列当前层 |
| 路径穿越 | 拒绝 `..` | 复用 `resolveMenuFilePath` 校验链 |
| 项目外目录 | 仅 owner | 复用 §6.2 of `file-link-cache-design.md` 同款判定 |
| symlink 目录 | 支持 | 指向目录的 symlink 返回 `type:"directory"`；非 owner 不跟随项目外 symlink |
| 竞态删除 | statSync 失败则该条 size/time 缺省（0/null） | 不整体报错 |
| 目录读取失败 | `NO_PERMISSION` 或 `EXEC_FAILED` | `EACCES`/`EPERM` 返回 `NO_PERMISSION`，其它异常返回 `EXEC_FAILED` |

---

## 6. 白名单：无需改动 ✅

> ⚠️ **关键纠正**（复核 2026-06-18）：`action:list` 不需要修改任何白名单。

EvolClaw 有两套相关机制，**都已覆盖** `menu.action name=file action=list`：

| 机制 | 位置 | 粒度 | 对 list 的覆盖 |
|---|---|---|---|
| `MENU_NAME_MAP` | `message-bridge.ts:252` | name → cmd 映射 | `file: '/file'` 已存在 |
| `MENU_REQUEST_TYPES` | `aun.ts:583` | **type 级**（`menu.list/query/options/update/action`） | `menu.action` 已在内 |

`MENU_REQUEST_TYPES` 是 **type 级**白名单（只识别到 `menu.action` 这一层，不细分 action），因此新增 action 动词无需登记。`MENU_NAME_MAP` 的 `file` 也早已存在。

→ 实现只动 `menu-handler.ts` 一个文件。

---

## 7. 客户端使用流程

### 7.1 文件浏览器交互

```
打开浏览器 → list {path:"."}                     列出项目根
  ↓ 点击目录 "src"
list {path:"src"}                                列出 src/
  ↓ 点击目录 "core"
list {path:"src/core"}                           列出 src/core/
  ↓ 目录条目过多（hasMore:true）
list {path:"src/core", offset:500}               下一页
  ↓ 点击文件 "command-handler.ts"
fetch {path:"src/core/command-handler.ts"}       拉取查阅（复用现有 action:fetch）
```

路径拼接：`childPath = data.path === "." ? name : data.path + "/" + name`。

### 7.2 界面示意

```
┌─────────────────────────────────────┐
│ 📁 src/core              [↑ 上级]    │
├─────────────────────────────────────┤
│ 📁 message/              06-10       │
│ 📁 session/              06-10       │
│ 📄 command-handler.ts    45 KB       │
│ 📄 event-bus.ts          12 KB       │
│ 📄 permission.ts          8 KB       │
├─────────────────────────────────────┤
│ 显示 500 / 1234   [加载更多]         │  ← hasMore:true 时
└─────────────────────────────────────┘
```

---

## 8. 错误码

| 情况 | 错误码 | 来源 |
|---|---|---|
| 角色不足（非 owner/admin） | `NO_PERMISSION` | list 分支自检 |
| `..` 路径穿越 | `NO_PERMISSION` | `resolveMenuFilePath` |
| 项目外目录 + 非 owner | `NO_PERMISSION` | `resolveMenuFilePath` |
| 目录不存在 | `NOT_FOUND` | `resolveMenuFilePath` |
| 路径是文件而非目录 | `NOT_A_DIRECTORY` | `resolveMenuFilePath`（`expectType:'directory'`，**新增码**） |
| 目录读取权限不足 | `NO_PERMISSION` | `listDirectory` 捕获 `EACCES`/`EPERM` |
| 目录读取其它失败 | `EXEC_FAILED` | `listDirectory` 捕获非权限异常 |
| 无活跃会话 | `NO_ACTIVE_SESSION` | `resolveMenuFilePath` |

`NOT_A_DIRECTORY` 需加入错误码表（见 §10 文档更新）。

---

## 9. 测试与评审结果

本地补充在 `tests/unit/menu-file.test.ts`（当前 `tests/` 被 `.gitignore` 忽略，作为本地回归验证文件存在）：

- ✅ 列出目录当前层
- ✅ 列出子目录
- ✅ 默认隐藏 `.*` 文件/目录
- ✅ `includeHidden:true` 时包含 `.*`
- ✅ 排序：目录优先 + 名称序
- ✅ 分页：`offset`/`limit`、`total`/`hasMore`
- ✅ `offset` 负数/小数回落到 0，`limit` 非有限数回落到 500，超过 1000 被 clamp
- ✅ 目录条目 `size:null`，文件条目 `size` 为字节数
- ✅ 条目含 `mtime` + `birthtime`
- ✅ 权限：owner/admin 放行，guest `NO_PERMISSION`
- ✅ `..` 穿越 `NO_PERMISSION`
- ✅ 项目外目录：非 owner `NO_PERMISSION`，owner 放行
- ✅ 路径是文件 → `NOT_A_DIRECTORY`
- ✅ 目录不存在 → `NOT_FOUND`
- ✅ 指向目录的 symlink 返回 `type:"directory"` 并参与目录优先排序
- ✅ 非 owner 遇到指向项目外目录的 symlink 不跟随，按 `file` 降级
- ✅ 回归：确认 `query`/`fetch` 传 `'file'` 后对目录仍返回 `NOT_SUPPORTED`（行为不变）

代码评审确认：

- ✅ `MENU_NAME_MAP` 已有 `file: '/file'`
- ✅ `MENU_REQUEST_TYPES` 已有 `menu.action`
- ✅ ECWeb / 控制 channel 入口复用 `execMenuAction`，无需额外 action 白名单
- ✅ `list` 不检查 `adapter.capabilities.file`，因为它只返回 JSON
- ✅ `fetch` 仍检查通道文件发送能力，行为不变

---

## 10. 后续文档同步

`docs/aun-menu-protocol-dev-guide-v2.2.md`（或后续版本）：

1. §3 能力矩阵 `file` 行：`action` 列 `fetch` → `fetch` `list`
2. §8.8 file 系列：新增 `action: list` 小节（请求/响应示例）
3. §9 错误码表：新增 `NOT_A_DIRECTORY`
4. §15 速查卡 `file` 行：`action(fetch)` → `action(fetch/list)`

---

## 11. 已否决备选（留档，避免重复讨论）

| 备选 | 否决理由 |
|---|---|
| 扩展 `query`，path 为目录时返回列表 | 重载 query 单资源语义，不清晰 |
| 新建 `name=browse` 独立命名空间 | 文件能力分散，不如聚合在 `file` |
| 递归列出 | 性能风险 + 需保留 path 字段，与极简结构冲突 |
| glob `pattern` 过滤 / `minimatch` 依赖 | 初版不引入；逐层浏览已够用，搜索另议 |
| `sortBy`/`sortOrder` 排序参数 | 服务端给稳定默认即可，重排交客户端 |
| 硬编码忽略 `node_modules`/`dist`/`.git` | 非递归下无性能必要，且武断隐藏 |
| 超 500 截断（`truncated` 标记） | 会丢文件；改用分页（方案 C） |
| `extension` / `isSymlink` / `permissions` / `sha256` 字段 | 浏览场景用不上；需要详情走 `query` |
| 目录列表缓存 / `.gitignore` 集成 / 文件预览 | 后续迭代可选，初版不做 |

---
