# 30 · 协作层（ec collab）

> 权限/ACL 见 `topics/acl-auth.md`，软链机制见 `topics/symlink.md`，群协作场景见 `topics/group-space.md`。

---

## 【使用】

### 心智模型

协作是「锚定在某块存储上的自包含版本化目录」：

```
协作根(collabRoot) = 一个普通目录 + .collab 锚点
                   + 每个协作文档有独立版本线（@current 软链 + @ledger 台账）
                   + 整目录有快照线（@snapshot 软链 + .collab-snapshots/）
```

**授权 = 存储 ACL**：谁能 submit = 谁对 collabRoot 有写权限（`setfacl`）。无独立的发起人特权——「发起人」只是第一个 create 的人，无任何后续特权。

**与群正交**：协作可在自己卷发起（群里贴卡片），也可在群 storage 发起（群 admin 授权）。详见 `topics/group-space.md`。

---

### 协作根目录结构

```
alice.aid.pub:/projects/myapp/           ← collabRoot
├── .collab                              ← 发现锚点（普通文件）
├── spec.md@current   ──→ .collab-versions/spec.md/alice.aid.pub/v5.md
├── spec.md@ledger                       ← 版本台账
├── api.md@current    ──→ .collab-versions/api.md/bob.aid.pub/v3.md
├── api.md@ledger
├── @snapshot         ──→ .collab-snapshots/2.3.1.json
├── .collab-versions/                    ← 不可变版本文件（managed，勿手动改）
│   ├── spec.md/alice.aid.pub/{v1..v5}
│   └── api.md/bob.aid.pub/{v1..v3}
└── .collab-snapshots/                   ← 目录级快照（managed）
    ├── 1.0.0.json … 2.3.1.json
    └── _ledger.jsonl
```

- `<doc>@current`：软链，指向当前权威版本 + 携带 version 号。
- `<doc>@ledger`：台账，每个 version → `{author, target, time}`。
- `.collab-versions/<doc>/<author>/vN`：不可变版本文件，按作者 namespace 隔离，写一次永不覆盖。
- **内部 target 一律相对 collabRoot**（如 `.collab-versions/spec.md/.../v5.md`）；API 响应时拼成绝对 `<aid>:<path>` 返回——这使 export/adopt 成为纯子树拷贝，无需逐条改写 target。

### .collab 文件格式

`.collab` 是 collabRoot 下的普通文本文件（YAML frontmatter + Markdown 正文），由发起人用 `ec fs cp` 放入。内容规范：

```markdown
---
name: myapp-design          # 协作项目标识（slug，唯一，不含空格）
authority: alice.aid.pub    # collabRoot 存储 owner（授权方）的 AID
root: alice.aid.pub:/projects/myapp   # 完整 collabRoot 路径（<aid>:<path>）
created: 2026-06-09         # 创建日期
---
myapp 的设计协作。

申请参与：向授权方 alice.aid.pub 发消息，或请 alice 执行：
  ec fs setfacl -m aid:<你的AID>:rw alice.aid.pub:/projects/myapp/
```

必填字段：`name`、`authority`、`root`。其余可选。`root` 字段是 `ec collab ls/read/submit` 等命令的 `<collab-root>` 参数来源——agent 读 `.collab` 后直接取 `root` 字段，无需手动拼路径。

---

### 命令集

```bash
ec collab ls      <collab-root>                                   # 列所有协作文档
ec collab create  <collab-root> <doc> <source>
ec collab read    <collab-root> <doc>
ec collab submit  <collab-root> <doc> <source> --base-version <n>
ec collab merge   <collab-root> <doc> <source> --base-version <n>
ec collab history <collab-root> <doc>
ec collab get     <collab-root> <doc> --version <n>
ec collab diff    <collab-root> <doc> --from <n> --to <m>
ec collab export  <collab-root> <dest>                            # 深拷贝备份
ec collab adopt   <src> <new-root>                                # 换 host 重建
ec collab snapshot create|list|show|diff|restore|rm|prune ...    # 目录快照
```

`<source>` = 本地文件路径 或 `<aid>:<path>`。

| 命令 | 作用 | 参数来源 |
|------|------|---------|
| `ls` | 列文档清单（含当前 version） | collabRoot（来自 .collab 文件或上层响应） |
| `create` | 创建协作文档 | doc 名由用户指定，source 是初始内容 |
| `read` | 读当前内容 + version 号 | collabRoot + doc（来自 ls 响应） |
| `submit` | 提交新版本（乐观锁） | **base-version 来自 read 响应的 version 字段** |
| `merge` | 三方合并 | **base-version 来自 submit 失败响应的 currentVersion** |
| `history` | 查版本台账 | collabRoot + doc |
| `get` | 读指定历史版本 | version 来自 history 响应 |
| `diff` | 比较两版本 | from/to 来自 history 响应 |
| `export` | 深拷贝备份 | dest = 备份目标路径 |
| `adopt` | 换 host 重建 | new-root = 新 collabRoot |

**所有响应回吐完整 `<aid>:<path>`**——agent 原样用于下一条命令，无需拼接。

---

### submit 乐观锁与撞版本处理

```bash
ec collab submit alice:/projects/myapp design.md ./design.md --base-version 3
```

- 先写提交者的 b（永不失败，数据先存下）。
- 后端 CAS：若 `@current` version == base-version → 切 @current、version+1；否则失败。

**失败响应**（自带下一步全部参数，agent 直接用）：

```
✗ 提交失败：当前版本已更新（你的基线 3，当前 4）
  你的草稿已安全保存，数据不丢
  currentTarget: alice:/projects/myapp/.collab-versions/design.md/alice/v4.md
  请执行: ec collab merge alice:/projects/myapp design.md ./design.md --base-version 3
  合并后重新提交: ec collab submit alice:/projects/myapp design.md ./design.md --base-version 4
```

**并发时序**：

```
初始 version=1

alice.read → v1, version=1      bob.read → v1, version=1
alice.submit(base=1)
  → 写 alice/v2；CAS(==1)✓ → version=2
bob.submit(base=1)
  → 写 bob/v2（数据安全）；CAS(==1)✗ → 失败，返回 currentVersion=2
bob.merge(base=1) → 三方合并（base=v1, ours=bob本地, theirs=alice/v2）
bob.submit(base=2)
  → 写 bob/v3；CAS(==2)✓ → version=3
```

---

### 目录级快照

```bash
# 打快照（自动判 bump：内容变→patch，文档增删→minor，手动→major）
ec collab snapshot create alice:/projects/myapp [-m "说明"] [--major]

# 列/查/比较
ec collab snapshot list   alice:/projects/myapp
ec collab snapshot show   alice:/projects/myapp 2.3.1
ec collab snapshot diff   alice:/projects/myapp 2.3.1 3.0.0

# 回滚（非破坏：以旧内容建新版本，version 不回退）
ec collab snapshot restore alice:/projects/myapp 2.3.1 [-m "说明"]

# 清理
ec collab snapshot rm    alice:/projects/myapp 1.0.0
ec collab snapshot prune alice:/projects/myapp --before 2026-01-01 [--keep-last 10]
```

语义化版本自动判定：doc 集合变化 → minor；仅内容变化 → patch；`--major` 强制；无变化 → 报错。

**回滚是 forward-only**：restore 不回退 version 计数器，而是「以旧内容创建新版本 vN+1」——这保证 version 单调递增不变量在快照线与文档线交叉时依然成立。

---

### export / adopt：备份与迁移

```bash
# 深拷贝：把整个协作（所有版本文件+台账+快照）拷到新位置（用于备份）
ec collab export alice:/projects/myapp  bob:/backups/myapp-20260609

# 换 host 重建：在 new-root 重建协作，new-root 存储 owner 成为新授权方
ec collab adopt  bob:/backups/myapp-20260609  carol:/projects/myapp
```

export 是纯子树拷贝（因内部 target 相对化，无需逐条改写）；adopt 是拷贝 + 换 root 前缀。新授权方 = new-root 所在存储的 ACL owner，无「发起人特权」。

---

### 删除与改名（走 fs，不走 collab）

```bash
ec fs rm alice:/projects/myapp/spec.md@current      # 下线文档（历史 b 保留，可重建）
ec fs mv alice:/projects/myapp/spec.md@current \
         alice:/projects/myapp/api-spec.md@current  # 改名（只改 c 名，历史不断）
ec fs rm -r alice:/projects/myapp/                  # 下线整个协作
```

collab 不提供 delete/rename——这些是纯 fs 操作，由 ACL 控制谁能执行。

> **文档改名后台账如何定位（重要）**：台账（collab_ledger）与版本文件目录（`.collab-versions/<dir>/`）**按物理目录名索引，不随 `@current` 显示名变化**。`ec fs mv spec.md@current api-spec.md@current` 只改软链显示名，`@current` 仍指向原 `.collab-versions/spec.md/` 下的 b——history/get/diff 仍按原物理名 `spec.md` 查得到完整历史。即：**显示名可变，台账锚点（物理目录名）不变**。CLI 在 `collab ls` 响应里同时给出 `doc`（当前显示名）和内部锚点，避免改名后查不到历史。

> **collabRoot 整体改名/迁移：用 adopt，不要用 `mv`**。`ec fs mv` collabRoot 在对象存储上是 O(n) copy+delete，且会让外部分享卡片、`.collab` 的 `root` 绝对字段失效。需要迁移整个协作（换位置/换主理人）时走 `ec collab adopt`（见上一节），它处理好 root 前缀重写与授权方转移。仅本卷内、无外部引用的轻量改名才用 mv。

---

## 【实现】

### CLI 实现者

**ls 实现**：`list_objects(prefix=collabRoot/)` → 过滤出 `<name>@current` 后缀的软链 → 对每个 resolve symlink → 读 version 号 → 组成 `[{doc, version, author, currentTarget}]`。是 read/submit/snapshot 的共用枚举源，不让 agent 自己过滤裸 ls 结果。

**submit 实现**：
1. `putObject(b-path, source)`（永不失败，先存数据）
2. `atomicRepoint(@current, newTarget=b-path, expectedVersion=base-version)`
3. 成功 → 返回 `{version: base+1, currentTarget}`
4. CAS 失败 → `resolveSymlink(@current)` 取当前 version 和 target → 返回失败响应（含 merge hint）

**merge 实现**：
1. 按 `--base-version` 查 ledger → 定位 base 版本文件路径
2. 下载 base（`.collab-versions/.../vN`）、ours（source 参数）、theirs（当前 @current 指向）
3. 三方合并（文本用 diff3；冲突标记 `<<<<<<< ours ... ======= ... >>>>>>> theirs`）
4. 返回合并后内容；有冲突 → `ok: false`，提示编辑后重试

**snapshot create 实现**：
1. `collab ls` 获当前所有文档及 version（复用 ls 逻辑）
2. 读 `@snapshot` 当前版本（resolveSymlink）→ 读父快照 entries
3. 对比当前 vs 父快照 → 判 bump
4. 无变化 → 报错「无变更可快照」
5. 写快照文件（`putObject(.collab-snapshots/<newVersion>.json, manifest)`）
6. `atomicRepoint(@snapshot, .collab-snapshots/<newVersion>.json, expectedVersion=parentVersion)`
7. CAS 失败 → 「快照头已移动，请重试」

**snapshot restore 实现**：
1. 读目标版本快照文件 → entries
2. 对 entries 里每个 doc：
   a. 从 OSS 取 `entry.target` 对应的版本文件内容
   b. **写一个新的 b 文件**（`<author>/vN+1`），内容等于该版本文件——**不能直接重指 @current 到旧 b**，否则台账里同一 version 号对应不同 b 路径，破坏不变量
   c. 台账追加一条 `{version: N+1, author: requester, target: 新b路径, time}`
   d. `atomicRepoint(<doc>@current, 新b路径, expectedVersion=currentVersion)` 切指针
   - 若 CAS 失败（他人在此期间提交）→ 记录警告，继续其余文档，最后汇总失败列表
3. 对当前存在但 entries 里没有的 doc（快照后新增的）→ `rm <doc>@current`（仅删软链，b 保留）
4. **以「回滚后的状态」为 source 创建新快照**（forward-only，保持 version 单调）
5. 返回 `{restoredFrom, newSnapshotVersion, warnings[]}`

> **为什么必须写新 b 而不是直接重指旧 b**：台账的不变量是「每个 version 号对应唯一的 b 文件路径」。若直接重指 @current 到旧 b（如 alice/v3），则台账里 version=3 和 version=8（restore 后）指向同一 b，version 号不再唯一标识一次提交，history 和 diff 会返回混乱结果。写新 b（内容复制）使 version=8 有自己的物理文件，保持台账整洁可追溯。

### SDK 设计者

```
collab.ls(collabRoot, requesterAid)
  → [{doc, version, author, currentTarget}]

collab.create(collabRoot, doc, source, requesterAid)
  → {version: 1, currentTarget}

collab.read(collabRoot, doc, requesterAid)
  → {content, version, author, collabRoot, doc, currentTarget}

collab.submit(collabRoot, doc, source, baseVersion, requesterAid)
  → {ok: true, version, currentTarget}
  | {ok: false, currentVersion, currentTarget, hint}
  // hint：由后端返回的「已格式化好的下一步命令行字符串」（含完整 merge/resubmit 命令），CLI 直接输出不再二次拼装

collab.merge(collabRoot, doc, source, baseVersion, requesterAid)
  → {content, conflicts: false}
  | {content, conflicts: true}   // content 含 <<<<<<< 标记

collab.history(collabRoot, doc, requesterAid)
  → [{version, author, target, time}]   // target = 完整 <aid>:<path>

collab.get(collabRoot, doc, version, requesterAid)
  → {content, version, author, time}

collab.diff(collabRoot, doc, vA, vB, requesterAid)
  → {diff: "unified diff text"}

collab.export(collabRoot, dest, requesterAid)
  → {ok: true, dest, copiedObjects: n}

collab.adopt(src, newRoot, requesterAid)
  → {ok: true, newRoot, newAuthorityAid}

collab.snapshot.create(collabRoot, opts: {message?, major?}, requesterAid)
  → {version, bump, changed: [doc]}

collab.snapshot.restore(collabRoot, version, opts: {message?}, requesterAid)
  → {restoredFrom, newSnapshotVersion, warnings: []}
```

### AUN 后端实现者

collab 层是**纯应用层编排**——它不需要后端提供专用的 collab RPC。所有操作最终分解成下列存储层原语（均定义在 `10-storage.md` 与 `topics/symlink.md`）：

| collab 操作 | 分解为的后端原语 | 原语定义处 |
|------------|----------------|----------|
| create | `putObject`（写 b）+ `createSymlink`（建 @current）+ `appendLedger`（写台账） | 10-storage.md / symlink.md |
| submit | `putObject`（写 b，永不失败）+ `atomicRepoint`（CAS 切 @current）+ `appendLedger` | 10-storage.md / symlink.md |
| merge | `getObject`(base b) + `getObject`(theirs b) + 客户端 diff3 | 10-storage.md |
| 文档下线/改名 | `deleteSymlink` / `renameSymlink`（只动 @current，b 不动） | symlink.md |
| export | `copyObject` × n（服务端批量 copy，**依赖 storage.copyObject，见 10-storage.md，P2 待补**） | 10-storage.md |
| snapshot create | `putObject`（写 manifest）+ `atomicRepoint`（CAS 切 @snapshot） | 10-storage.md / symlink.md |

关键：**atomicRepoint 是核心依赖**（见 `topics/symlink.md`）。没有它，并发 submit 和并发 snapshot create 都无法保证正确性。

> **群内 create 联动注册表**：当 collabRoot 位于群成员卷（即在群空间内）时，`create` 还会触发群注册表更新（在 `group_registry.collab_roots` 追加该 collabRoot），使 `find --name .collab` 无需扇出即可发现。详见 `topics/group-space.md`。

`appendLedger`（台账追加）——后端建议实现为 append-only 对象（OSS AppendObject）或 DB 行：

```sql
CREATE TABLE collab_ledger (
  collab_root TEXT NOT NULL,
  doc         TEXT NOT NULL,
  version     INT  NOT NULL,
  author_aid  TEXT NOT NULL,
  target      TEXT NOT NULL,   -- 相对 collabRoot 的路径（内部存相对，响应时绝对化）
  created_at  TIMESTAMP,
  PRIMARY KEY (collab_root, doc, version)
);
```

快照 manifest 存为不可变对象（`.collab-snapshots/<version>.json`），不存 DB——快照文件本身就是历史，OSS 的 write-once 特性天然保证不可篡改。`@snapshot` 软链（DB 一行）是「当前活动快照指针」，通过 atomicRepoint CAS 保证并发安全切换。
