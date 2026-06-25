# 专题 · 软链机制

> **本文是软链（symlink）的单一事实源（SSOT）**。其他文档只引用本文，不复述。

---

## 【使用】

### 心智模型

软链是「指向另一路径的轻量指针」——类比桌面快捷方式。访问软链时自动跳转到真实文件，真实文件在哪随意组织，对外地址由软链决定。

三种核心用途，同一机制：

| 用途 | 软链写法 | 真实数据在哪 |
|------|---------|------------|
| 对外发布 | `/public/x → /private/真实文件` | 私有区 |
| 稳定别名 | `/releases/latest → /releases/v2.3.1` | 版本目录 |
| 协作版本指针 | `<doc>@current → .collab-versions/.../vN` | 协作根（见 `30-collab.md`） |

软链可跨主机（alice 的链接指向 g-team 的文件），但**权限不随软链传递**——软链只是入口，访问时仍按目标资源真实 ACL 校验。

### 命令

```bash
# 创建软链（真实路径在前，软链路径在后）
ec fs ln -s <真实路径> <链接路径>

# 原子重指（-f 覆盖已有软链，原子操作）
ec fs ln -sf <真实路径> <链接路径>
```

**参数顺序**：真实文件在前，软链在后——和 `cp src dst`、Linux `ln -s target link` 一致。最容易写反：

```bash
# ✅ 正确
ec fs ln -s alice.agentid.pub:/private/identity/agent.md \
            alice.agentid.pub:/public/agent.md

# ❌ 错误：方向反了
ec fs ln -s alice.agentid.pub:/public/agent.md \
            alice.agentid.pub:/private/identity/agent.md
```

### 行为约定

- 删除软链**不影响**其指向的真实对象。
- 真实文件删除后，软链变**悬空**（dangling）；`ls -l` 标注 `⚠ dangling`；访问悬空链接报 `EDANGLING`（不是 `ENOENT`，让调用方区分）。
- 跨主机软链访问失败时，优先报目标资源的 ACL 错误（`EACCES`），不暴露软链内部结构。

---

## 【实现】

### CLI 实现者

`ec fs ln [-s] [-f] <src> <dst>`

- `-s` 必须存在（无硬链接支持，见 `20-fs-commands.md`）；缺失报错。
- 解析 `<src>` 与 `<dst>` 为 `<AID>:<path>`（或本地路径）。
- `<dst>` 如已存在且为软链：`-f` 则原子重指，否则报 `EEXIST`。
- `<dst>` 如已存在且为真实对象：始终报 `EEXIST`（不覆盖真实对象）。
- 成功输出：`✓ 已创建软链  <dst> → <src>`。

### SDK 设计者

```
storage.createSymlink({
  src:          "<aid>:<path>",    // 真实路径（软链指向的目标）
  dst:          "<aid>:<path>",    // 软链路径（要创建的软链）
  requesterAid: "<aid>",
  overwrite:    false              // true = 等价 -f
}) → { ok: true, dst, src }

storage.resolveSymlink({ path: "<aid>:<path>", requesterAid })
  → { target: "<aid>:<path>", dangling: false }
  | { dangling: true, originalTarget: "<aid>:<path>" }

storage.atomicRepoint({
  symlinkPath:     "<aid>:<path>",  // 已有软链的路径
  newTarget:       "<aid>:<path>",  // 新指向
  expectedVersion: number | null,   // CAS：collab @current/@snapshot 切换必填；普通重指（如 /public 发布版本切换）传 null 跳过 CAS
  requesterAid:    "<aid>"
}) → { ok: true, version: newVersion }
  | { ok: false, currentVersion, currentTarget }  // CAS 失败（仅 expectedVersion 非 null 时可能）

storage.renameSymlink({
  path:         "<aid>:<path>",     // 现有软链路径
  newPath:      "<aid>:<path>",     // 新软链路径（同一 owner 命名空间内）
  requesterAid: "<aid>"
}) → { ok: true, path: newPath }
  | { ok: false, error: "EEXIST" | "ENOENT" }
  // 只改软链自身的 key，target 不变——用于 collab 文档改名（@current 重命名，指向的 b 不动）

storage.deleteSymlink({
  path:         "<aid>:<path>",     // 要删除的软链路径
  requesterAid: "<aid>"
}) → { ok: true }
  // 只删软链记录，不影响 target 指向的真实对象——区别于 deleteObject（删真实对象）
```

> `atomicRepoint` 是 `collab submit` 和 `snapshot create` 乐观锁的底层原语，CAS 模式（`expectedVersion` 非 null）**必须原子**（见 `topics/acl-auth.md` 的 CAS 说明和 `30-collab.md` 的时序图）。普通发布场景（如 `/public/x` 切换指向新版本文件，无并发竞争语义）传 `expectedVersion: null` 即可。

> `renameSymlink` vs `deleteSymlink` vs `deleteObject`：前两个作用于**软链记录**（DB 一行），最后一个作用于**真实对象**（OSS blob）。`ec fs rm <软链>` 走 deleteSymlink（真实文件保留）；`ec fs rm <真实文件>` 走 deleteObject。`ec fs mv <软链> <新名>` 走 renameSymlink。CLI 据目标是软链还是真实对象分派。

### AUN 后端实现者

**软链存在哪**：软链是**元数据库一行**，不是对象存储中的对象。

```sql
CREATE TABLE symlinks (
  owner_aid  TEXT NOT NULL,         -- 软链所在命名空间的 AID
  path       TEXT NOT NULL,         -- 软链路径（如 /public/agent.md）
  target     TEXT NOT NULL,         -- 指向的完整 aid:path
  version    BIGINT NOT NULL DEFAULT 1,  -- 用于 CAS（atomicRepoint 的 expectedVersion）
  created_at TIMESTAMP,
  PRIMARY KEY (owner_aid, path)
);
```

**解析流程**（访问含软链的路径时）：

```
1. 路由层检查路径: 查 symlinks 表，path 命中?
2. 命中 → 取 target
3. dangling 检测: 对 target 做 HEAD → 404? → status=dangling，返回 EDANGLING
4. 非悬空 → 用 target 重新发起访问（一跳，不递归展开多层软链以防循环）
5. 权限校验: 用**访问者 AID** 对 **target 资源** 做 ACL 校验（不用软链本身的权限）
6. 通过 → 返回数据
```

**atomicRepoint 的原子保证**：

```sql
-- 必须作为单一 DB 事务执行，不可拆成多步
UPDATE symlinks
   SET target = :newTarget, version = version + 1
 WHERE owner_aid = :ownerAid
   AND path = :symlinkPath
   AND version = :expectedVersion;
-- 0 rows affected → CAS 失败，返回当前实际 (version, target)
```

**跨主机软链的存储**：target 字段存完整 `aid:path`（如 `g-team.agentid.pub:/share/spec.md`）；解析时路由到目标 AID 所在的后端，再做权限校验。
