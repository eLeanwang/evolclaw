# 40 · 场景 Cookbook

> **本文以「我想做 X」为索引**，每个场景给出可直接执行的完整命令序列、每步参数的来源、以及关键提示。
>
> 本文不重复定义机制——命令语法见 `20-fs-commands.md`，协作命令见 `30-collab.md`，权限见 `topics/acl-auth.md`，软链见 `topics/symlink.md`，虚拟卷见 `topics/virtual-volume.md`，群空间见 `topics/group-space.md`。
>
> **参数来源标注**：每条命令旁边的 `← 来自 X` 说明该参数从哪里取得，而不是手动填写。

---

## 目录

**个人文件操作**
- [S01 上传文件到私有区](#s01)
- [S02 下载文件到本地](#s02)
- [S03 查看目录内容](#s03)
- [S04 查看文件（含二进制）](#s04)
- [S05 移动/改名文件](#s05)
- [S06 删除文件或目录](#s06)
- [S07 查看存储用量](#s07)

**对外发布与分享**
- [S08 发布文件到公开 URL](#s08)
- [S09 更新已发布文件（URL 不变）](#s09)
- [S10 撤销发布](#s10)
- [S11 给特定人授权访问私有文件](#s11)
- [S12 签发限次/限时 token 分享](#s12)
- [S13 吊销 token 或撤销授权](#s13)
- [S14 查看我分享了哪些文件](#s14)

**协作——发起与管理**
- [S15 在自己卷上发起协作项目](#s15)
- [S16 邀请他人参与协作](#s16)
- [S17 移除协作者权限](#s17)
- [S18 协作项目改名或迁移](#s18)
- [S19 关闭协作（下线文档）](#s19)

**协作——日常提交**
- [S20 读取当前版本并提交修改](#s20)
- [S21 撞版本后合并再提交](#s21)
- [S22 查看某文档的历史版本](#s22)
- [S23 读取指定历史版本内容](#s23)
- [S24 对比两个版本差异](#s24)
- [S25 新增一个协作文档](#s25)
- [S26 删除/下线一个协作文档](#s26)
- [S27 协作文档改名](#s27)

**协作——快照**
- [S28 打一个目录快照（里程碑）](#s28)
- [S29 查看快照历史](#s29)
- [S30 对比两个快照差异](#s30)
- [S31 回滚到某个快照](#s31)
- [S32 清理旧快照](#s32)

**协作——备份与迁移**
- [S33 备份整个协作到自己的存储](#s33)
- [S34 从备份重建协作（换主理人）](#s34)

**发现与加入协作**
- [S35 在群里发现协作项目](#s35)
- [S36 通过卡片链接加入协作](#s36)

**群共享空间**
- [S37 加入群并挂载自己的目录](#s37)
- [S38 查看群共享空间的存储状态](#s38)
- [S39 在群存储上发起协作](#s39)
- [S40 收养成员贡献（固化进群存储）](#s40)
- [S41 踢出成员卷挂载](#s41)

**卷管理**
- [S42 挂载额外存储卷](#s42)
- [S43 卸载卷](#s43)
- [S44 查看卷状态和配额](#s44)

---

## 个人文件操作

<a name="s01"></a>
### S01 · 上传文件到私有区

```bash
ec fs cp ./report.pdf alice.agentid.pub:/private/reports/report-2026.pdf
```

- `./report.pdf`：本地文件路径
- `alice.agentid.pub`：自己的 AID（来自 `EVOLCLAW_SELF_AID` 或 `--as`）
- `/private/reports/`：目标目录（惯例，私有区不对外可见）

**SDK**：`storage.putObject` 或 `storage.createUploadSession` + `storage.completeUpload`（大文件）
**后端**：PUT 对象；若目录不存在，对象存储自动以 prefix 形式存在，无需 mkdir

---

<a name="s02"></a>
### S02 · 下载文件到本地

```bash
ec fs cp alice.agentid.pub:/private/reports/report-2026.pdf ./report.pdf
```

- 来源路径和目标路径由 `:` 有无判定远程/本地

**SDK**：`storage.getObject`（小文件）或 `storage.createDownloadTicket`（大文件预签名 URL）
**后端**：GET 对象；鉴权：requesterAid == ownerAid 或有 ACL/token

---

<a name="s03"></a>
### S03 · 查看目录内容

```bash
ec fs ls alice.agentid.pub:/private/reports/
ec fs ls -l alice.agentid.pub:/private/reports/   # 含软链目标、权限标注
```

**SDK**：`storage.listObjects(prefix)` + `storage.listPrefixes(prefix)`（子目录）
**后端**：LIST prefix；软链条目从 DB symlinks 表合并

---

<a name="s04"></a>
### S04 · 查看文件（含二进制）

```bash
# 文本文件——直接返回内容
ec fs cat alice.agentid.pub:/private/notes.md

# 二进制文件——返回元数据 + 文件头 256 字节（用于判断格式）
ec fs cat alice.agentid.pub:/private/app.zip
# 输出: {"mime":"application/zip","size":...,"binary":true,"head":{"data":"UEsD..."}}

# 取完整二进制文件用 cp 下载，不用 cat
ec fs cp alice.agentid.pub:/private/app.zip ./app.zip
```

**SDK**：`storage.headObject`（取 mime）→ 文本则 `storage.getObject`；二进制则 `storage.getRangeBytes(offset=0, length=256)`
**后端**：HEAD + 条件 Range GET

---

<a name="s05"></a>
### S05 · 移动/改名文件

```bash
# 改名（源是软链：DB 改一行，原子且廉价）
ec fs mv alice.agentid.pub:/public/old-name.md \
         alice.agentid.pub:/public/new-name.md

# 移动真实对象（copy + delete，不原子，大文件时有延迟警告）
ec fs mv alice.agentid.pub:/private/v1/spec.md \
         alice.agentid.pub:/private/v2/spec.md
```

> ⚠️ 跨主机 mv 不支持——对象存储无原子跨命名空间 rename。用 `cp + rm`。

**SDK**：软链情况 → `storage.renameSymlink`（定义见 `topics/symlink.md`）；真实对象 → `storage.copyObject` + `storage.deleteObject`
**后端**：`renameSymlink` 改 DB symlinks 表的 path 字段（不动 target）；`copyObject` 见 10-storage.md（P2 待实现）

---

<a name="s06"></a>
### S06 · 删除文件或目录

```bash
ec fs rm alice.agentid.pub:/private/old-file.txt
ec fs rm -r alice.agentid.pub:/private/old-project/   # 递归删目录
```

> 删软链不影响真实文件（`rm /public/x` 只删链接，`/private/x` 完好）

**SDK**：`storage.deleteObject`；`rm -r` → `storage.listObjects(prefix)` 分页 + `storage.deleteObjects(keys[])`（批量）
**后端**：`storage.deleteObjects` 批量 RPC，已在 `10-storage.md` 标记（P2 待实现）

---

<a name="s07"></a>
### S07 · 查看存储用量

```bash
ec fs df alice.agentid.pub:
```

输出示例：
```
Filesystem          Size   Used   Avail  Status   Expires      Mounted on
alice.agentid.pub   5G     1.2G   3.8G   active   -            /
alice.agentid.pub   30G    12G    18G    active   2026-09-01   /archive/
```

**SDK**：`storage.getVolumes(ownerAid)`
**后端**：查 volumes 表；used_bytes 需实时或定时统计

---

## 对外发布与分享

<a name="s08"></a>
### S08 · 发布文件到公开 URL

```bash
# 1. 文件在私有区
ec fs cp ./logo.png alice.agentid.pub:/private/assets/logo.png

# 2. 软链进 /public（真实路径在前，软链在后）
ec fs ln -s alice.agentid.pub:/private/assets/logo.png \
            alice.agentid.pub:/public/logo.png

# 3. 设为公开可读
ec fs chmod +r alice.agentid.pub:/public/logo.png
# → https://alice.agentid.pub/logo.png 任何人可访问
```

- 第 2 步软链：`/public/<x>` ←→ `https://<AID>/<x>`
- 默认私有，必须显式 `chmod +r` 才对外可读

**SDK**：`storage.createSymlink` + `storage.setVisibility(public)`
**后端**：DB 写 symlink 行 + 可见性标记；HTTP 网关解析 `https://<aid>/<path>` → `/public/<path>` → 软链 → 真实对象

---

<a name="s09"></a>
### S09 · 更新已发布文件（URL 不变）

```bash
# 上传新版本到私有区
ec fs cp ./logo-v2.png alice.agentid.pub:/private/assets/logo-v2.png

# 软链原子重指到新文件（-f 覆盖）
ec fs ln -sf alice.agentid.pub:/private/assets/logo-v2.png \
             alice.agentid.pub:/public/logo.png
# → https://alice.agentid.pub/logo.png 现在指向 v2，URL 没变
```

- `-f`：原子重指已有软链
- 这是「稳定别名」用途——URL 是接口，真实文件可换
- 注意：本场景用 **fs 层 `ln`** 管理发布 URL 指向，与 **collab 层 `submit`**（协作文档版本控制）是两回事，别混用

**SDK**：`storage.atomicRepoint`（普通重指传 `expectedVersion: null` 跳过 CAS，见 `topics/symlink.md`）
**后端**：DB UPDATE symlinks.target

---

<a name="s10"></a>
### S10 · 撤销发布

```bash
# 删软链（真实文件不动）
ec fs rm alice.agentid.pub:/public/logo.png

# 或：保留链接但收回公开读
ec fs chmod o-r alice.agentid.pub:/public/logo.png
```

**SDK**：`storage.deleteSymlink` 或 `storage.setVisibility(private)`
**后端**：DELETE symlinks 行 或 改可见性标记

---

<a name="s11"></a>
### S11 · 给特定人授权访问私有文件

```bash
# 不必发布到 /public，直接给 bob 的 AID 授读权
ec fs setfacl -m aid:bob.aid.pub:r alice.agentid.pub:/private/contract.pdf
```

- bob 用自己的 AID 身份访问，无需 token
- bob 访问：`ec fs cat alice.agentid.pub:/private/contract.pdf`（服务端验证 bob 的 ACL）

**SDK**：`storage.setAcl(path, aid=bob, perms=r)`
**后端**：写 path_acls 表；bob 访问时走统一权限求值（见 acl-auth.md）

---

<a name="s12"></a>
### S12 · 签发限次/限时 token 分享

```bash
# 文件已发布到 /public（或私有也可）
ec fs token issue alice.agentid.pub:/public/report.pdf \
  --expires 2026-12-31 --max-reads 10
# 输出: ✓ 令牌 tok_abc123  有效期至 2026-12-31  次数上限 10
```

接收方两种用法：
```bash
# CLI
ec fs cat alice.agentid.pub:/public/report.pdf --token tok_abc123
# HTTP
# GET https://alice.agentid.pub/report.pdf
# Authorization: Bearer tok_abc123
```

- token 无需接收方有 AID 身份（支持匿名 HTTP 访问）

**SDK**：`storage.issueToken(path, expires, maxReads)` → 返回 token 串
**后端**：写 access_tokens 表；每次访问递增 read_count，超限/过期拒绝

---

<a name="s13"></a>
### S13 · 吊销 token 或撤销授权

```bash
# 吊销 token（立即失效，不等过期）
ec fs token revoke alice.agentid.pub:/public/report.pdf --token tok_abc123
#   ← token 串来自 S12 签发输出，或 token ls 查询

# 撤销某 AID 的授权
ec fs setfacl -x aid:bob.aid.pub alice.agentid.pub:/private/contract.pdf
```

**SDK**：`storage.revokeToken` / `storage.removeAcl`
**后端**：access_tokens.revoked=true / DELETE path_acls 行

---

<a name="s14"></a>
### S14 · 查看我分享了哪些文件

```bash
# /public 下的软链就是发布清单
ec fs ls -l alice.agentid.pub:/public/
# lrwxr--r-- logo.png   → /private/assets/logo-v2.png  public
# lrwxr--r-- report.pdf → /private/report.pdf          token expires:2026-12-31 reads:3/10

# 查某文件签发的所有 token
ec fs token ls alice.agentid.pub:/public/report.pdf
```

**SDK**：`storage.listObjects(/public/)` + `storage.listTokens(path)`
**后端**：LIST + 查 access_tokens 表

---

## 协作——发起与管理

<a name="s15"></a>
### S15 · 在自己卷上发起协作项目

```bash
# 1. 建协作根目录
ec fs mkdir alice.agentid.pub:/projects/myapp/

# 2. 写 .collab 锚点文件（描述项目 + 授权方）
ec fs cp ./.collab alice.agentid.pub:/projects/myapp/.collab
#   .collab 内容格式见 30-collab.md（name/authority/root 字段）

# 3. 创建第一个协作文档
ec collab create alice.agentid.pub:/projects/myapp spec.md ./spec.md
#   → {version: 1, currentTarget: "alice.../.collab-versions/spec.md/alice.aid.pub/v1.md"}
```

- collabRoot = `alice.agentid.pub:/projects/myapp`（在自己卷，alice 即授权方）
- create 后自动建 `spec.md@current` 软链 + 台账 version=1

**SDK**：`collab.create(collabRoot, doc, source, requesterAid)`
**后端**：`putObject`(写 b) + `createSymlink`(@current) + `appendLedger`
**链路核查**：✅ 参数自包含——collabRoot 是用户指定路径，doc 是文档名，source 是本地文件

---

<a name="s16"></a>
### S16 · 邀请他人参与协作

```bash
# 授权方（alice，collabRoot 存储 owner）给 bob 读写权
ec fs setfacl -m aid:bob.aid.pub:rw alice.agentid.pub:/projects/myapp/

# 只读参与者（能 read/get，不能 submit）
ec fs setfacl -m aid:carol.aid.pub:r alice.agentid.pub:/projects/myapp/
```

- 「谁能 submit」≡「谁对 collabRoot 有写权限」，无独立的协作者名单
- ACL 作用于 collabRoot 前缀 → 其下所有文档继承

**SDK**：`storage.setAcl(collabRoot, aid=bob, perms=rw)`
**后端**：写 path_acls（path_prefix=collabRoot）；继承靠最近祖先匹配
**链路核查**：✅ 授权 = 纯 fs ACL，无 collab 专用授权接口

---

<a name="s17"></a>
### S17 · 移除协作者权限

```bash
ec fs setfacl -x aid:bob.aid.pub alice.agentid.pub:/projects/myapp/
```

- bob 立即失去 submit 能力；已提交的历史版本（bob 的 b 文件）保留，可追溯

**SDK**：`storage.removeAcl`
**后端**：DELETE path_acls 行

---

<a name="s18"></a>
### S18 · 协作项目改名或迁移

整个项目改名/换主理人用 export + adopt（见 [S33](#s33)/[S34](#s34)）。仅改 collabRoot 目录名（同卷内）：

```bash
ec fs mv alice.agentid.pub:/projects/myapp/ \
         alice.agentid.pub:/projects/myapp-v2/
```

> ⚠️ collabRoot 改名会让所有引用它的 `.collab` `root` 字段、外部分享的卡片链接失效。**不推荐随意改 collabRoot**——这正是「路径规划一次性决策」的体现（见 10-storage.md）。需要改时优先用 adopt 到新位置。

**SDK**：递归 rename（软链改 DB、真实对象 copy+delete）
**链路核查**：⚠️ 大目录 rename 在对象存储上是 O(n) copy+delete，且内部 target 是相对路径所以不需重写，但 `.collab` 的 `root` 绝对字段需同步更新——**建议 collabRoot 改名走 adopt 而非 mv**

---

<a name="s19"></a>
### S19 · 关闭协作（下线整个项目）

```bash
# 下线整个协作（数据全删，不可恢复）
ec fs rm -r alice.agentid.pub:/projects/myapp/

# 或仅备份后下线（保留可重建能力）
ec collab export alice.agentid.pub:/projects/myapp ./myapp-backup   # 先备份
ec fs rm -r alice.agentid.pub:/projects/myapp/
```

**SDK**：`storage.deleteObjects`(批量) / 先 `collab.export`
**后端**：LIST + 批量 DELETE

---

## 协作——日常提交

<a name="s20"></a>
### S20 · 读取当前版本并提交修改

```bash
# 1. 读当前版本（拿到 version 号）
ec collab read alice.agentid.pub:/projects/myapp spec.md
#   → {content: "...", version: 5, currentTarget: "..."}

# 2. 本地编辑（基于读到的 content）

# 3. 提交，base-version 用第 1 步读到的 version
ec collab submit alice.agentid.pub:/projects/myapp spec.md ./spec.md --base-version 5
#                                                                                 ↑ ← 来自 read 的 version
#   → {ok: true, version: 6, currentTarget: "..."}
```

**SDK**：`collab.read` → `collab.submit(..., baseVersion=5)`
**后端**：read = resolveSymlink + getObject；submit = putObject(b) + atomicRepoint(CAS, expectedVersion=5)
**链路核查**：✅ base-version 明确来自 read 响应的 version 字段

---

<a name="s21"></a>
### S21 · 撞版本后合并再提交

```bash
# submit 失败（他人已先提交）
ec collab submit alice.agentid.pub:/projects/myapp spec.md ./spec.md --base-version 5
#   → {ok: false, currentVersion: 6, currentTarget: "...", hint: "ec collab merge ... --base-version 5"}

# merge：base-version 用你原来的基线 5（不是 6）
ec collab merge alice.agentid.pub:/projects/myapp spec.md ./spec.md --base-version 5
#                                                                                ↑ ← 你原来的基线，来自上次 read
#   → {content: "...合并结果...", conflicts: false}   # 有冲突则 content 含 <<<<<<< 标记，需手动解决

# 重新提交，base-version 用失败响应里的 currentVersion 6
ec collab submit alice.agentid.pub:/projects/myapp spec.md ./merged.md --base-version 6
#                                                                                  ↑ ← 来自 submit 失败响应的 currentVersion
#   → {ok: true, version: 7}
```

**SDK**：`collab.merge(baseVersion=5)` → `collab.submit(baseVersion=6)`
**后端**：merge 的 base 由台账按 baseVersion=5 定位 b（不依赖本地留底）；theirs = 当前 @current 指向
**链路核查**：✅ 两个 base-version 来源不同但都明确——merge 用原基线（read 时的 version），resubmit 用失败响应的 currentVersion。这是最易混淆处，文档已点明

---

<a name="s22"></a>
### S22 · 查看某文档的历史版本

```bash
ec collab history alice.agentid.pub:/projects/myapp spec.md
#   → [{version:1, author:"alice", target:"...v1.md", time:...},
#      {version:2, author:"bob",   target:"...v2.md", time:...}, ...]
```

**SDK**：`collab.history` → 读台账
**后端**：查 collab_ledger 表（target 相对路径 → 响应时绝对化）

---

<a name="s23"></a>
### S23 · 读取指定历史版本内容

```bash
ec collab get alice.agentid.pub:/projects/myapp spec.md --version 3
#                                                                  ↑ ← 来自 history 的某条 version
```

**SDK**：`collab.get(version=3)`
**后端**：台账定位 b 路径 → getObject

---

<a name="s24"></a>
### S24 · 对比两个版本差异

```bash
ec collab diff alice.agentid.pub:/projects/myapp spec.md --from 3 --to 6
#                                                                ↑      ↑ ← 来自 history
#   → {diff: "unified diff text"}
```

**SDK**：`collab.diff(vA=3, vB=6)`
**后端**：取两个 b 内容 → 客户端 diff

---

<a name="s25"></a>
### S25 · 新增一个协作文档

```bash
ec collab create alice.agentid.pub:/projects/myapp api.md ./api.md
#   → {version: 1}   # 新文档独立的版本线
```

- 同一 collabRoot 下每个文档有独立 @current 和版本线，互不干扰

**SDK**：`collab.create`（同 S15 第 3 步）

---

<a name="s26"></a>
### S26 · 删除/下线一个协作文档

```bash
# 下线文档（删 @current 软链，历史 b 全保留，可重建）
ec fs rm alice.agentid.pub:/projects/myapp/spec.md@current
```

> collab 不提供 delete 动词——下线是纯 fs 操作（删软链）。历史版本文件仍在 `.collab-versions/`，需彻底回收空间才删 b（危险操作）

**SDK**：`storage.deleteSymlink`
**后端**：DELETE symlinks 行；.collab-versions 下的 b 不动

---

<a name="s27"></a>
### S27 · 协作文档改名

```bash
ec fs mv alice.agentid.pub:/projects/myapp/spec.md@current \
         alice.agentid.pub:/projects/myapp/design.md@current
```

> 只改 @current 软链名，`.collab-versions/spec.md/` 目录**不改名**——软链继续指向原 b，历史不断

**SDK**：`storage.renameSymlink`
**链路核查**：⚠️ 依赖 `renameSymlink`（S05 已暴露的缺口）；且改名后 doc 标识变了，台账里仍记旧 doc 名——**需明确：台账按「物理 .collab-versions 目录名」而非 @current 显示名索引**，否则 history 查不到。这是一个需要在 30-collab.md 澄清的设计点

---

## 协作——快照

<a name="s28"></a>
### S28 · 打一个目录快照（里程碑）

```bash
# 自动判定 bump（内容变=patch，文档增删=minor）
ec collab snapshot create alice.agentid.pub:/projects/myapp -m "完成 API 设计"
#   → {version: "2.4.0", bump: "minor", changed: ["api.md"]}

# 重大里程碑手动标大版本
ec collab snapshot create alice.agentid.pub:/projects/myapp --major -m "v3 定稿"
#   → {version: "3.0.0", bump: "major"}
```

- 快照只记录已 submit 的版本（`@current` 指向的），本地未提交草稿不在内
- 快照 = 引用（零拷贝），记录此刻所有文档各指向哪个版本

**SDK**：`collab.snapshot.create(opts={message, major})`
**后端**：collab.ls 收集当前指向 → putObject(manifest) → atomicRepoint(@snapshot, CAS)
**链路核查**：✅ 无需额外参数，bump 由后端对比父快照自动算

---

<a name="s29"></a>
### S29 · 查看快照历史

```bash
ec collab snapshot list alice.agentid.pub:/projects/myapp
#   → [{version:"1.0.0", time:..., message:"初版"},
#      {version:"2.4.0", time:..., message:"完成 API"}, ...]  （标注当前 @snapshot 指向）
```

**SDK**：`collab.snapshot.list` → 读 _ledger.jsonl
**后端**：读 .collab-snapshots/_ledger.jsonl

---

<a name="s30"></a>
### S30 · 对比两个快照差异

```bash
ec collab snapshot diff alice.agentid.pub:/projects/myapp 2.4.0 3.0.0
#                                                          ↑     ↑ ← 来自 snapshot list
#   → 新增文档: [deploy.md]  删除文档: []  内容变化: [spec.md(v5→v7)]
```

**SDK**：`collab.snapshot.diff(vA, vB)`
**后端**：读两个 manifest，对比 entries

---

<a name="s31"></a>
### S31 · 回滚到某个快照

```bash
ec collab snapshot restore alice.agentid.pub:/projects/myapp 2.4.0 -m "回退错误方向"
#                                                             ↑ ← 来自 snapshot list
#   → {restoredFrom: "2.4.0", newSnapshotVersion: "3.0.1", warnings: []}
```

- 非破坏：各 `@current` 重指回 2.4.0 记录的内容（以旧内容写新 b，version 不回退）
- 追加一个新快照（3.0.1）记录本次回滚；3.0.0 历史保留，可再前滚

**SDK**：`collab.snapshot.restore(version, opts={message})`
**后端**：读 manifest → 逐文档 putObject(新b,内容=旧版本) + atomicRepoint(@current) → 新建快照
**链路核查**：✅ forward-only 已在 30-collab.md 实现节明确——必须写新 b 而非重指旧 b

---

<a name="s32"></a>
### S32 · 清理旧快照

```bash
# 删指定快照（只删 manifest，底层版本文件不动）
ec collab snapshot rm alice.agentid.pub:/projects/myapp 1.0.0

# 按时间清理（保留最近 10 个，拒删当前活动快照）
ec collab snapshot prune alice.agentid.pub:/projects/myapp --before 2026-01-01 --keep-last 10
```

**SDK**：`collab.snapshot.rm` / `collab.snapshot.prune`
**后端**：删 .collab-snapshots/<version>.json；prune 拒删 @snapshot 当前指向的活动快照

---

## 协作——备份与迁移

<a name="s33"></a>
### S33 · 备份整个协作到自己的存储

```bash
ec collab export alice.agentid.pub:/projects/myapp \
                 alice.agentid.pub:/backups/myapp-20260609
#   → {ok: true, dest: "...", copiedObjects: 42}
```

- 深拷贝：所有版本文件 + 台账 + 快照 + 指针，自包含子树
- 因内部 target 相对 collabRoot，export 是纯子树拷贝，无需逐条改写

**SDK**：`collab.export(collabRoot, dest)`
**后端**：copyObject × n（服务端批量 copy，C11）；同后端不出网
**链路核查**：✅ 依赖 `copyObject`（fastaun 0.4.2 缺，已标 P2）

---

<a name="s34"></a>
### S34 · 从备份重建协作（换主理人）

```bash
# carol 把 alice 的备份在自己卷上重建为新协作
ec collab adopt alice.agentid.pub:/backups/myapp-20260609 \
                carol.agentid.pub:/projects/myapp
#   → {ok: true, newRoot: "carol.../projects/myapp", newAuthorityAid: "carol.aid.pub"}

# 重建后 carol 是新授权方，重新拉人
ec fs setfacl -m aid:bob.aid.pub:rw carol.agentid.pub:/projects/myapp/
```

- 新授权方 = newRoot 所在存储的 ACL owner（carol），无「原发起人特权」
- 适用：原主理人退出、迁移到群存储、灾难恢复

**SDK**：`collab.adopt(src, newRoot)`
**后端**：copyObject × n + 换 root 前缀（内部 target 相对，无需逐条改）
**链路核查**：✅ 自包含 + 相对 target 的设计让 adopt 顺畅

---

## 发现与加入协作

<a name="s35"></a>
### S35 · 在群里发现协作项目

```bash
# 扫群内所有成员卷的协作锚点（走群注册表，不实时扇出）
ec fs find g-team.agentid.pub:/memberdata/ --name .collab
#   → [g-team:/memberdata/alice/projects/myapp/.collab, ...]

# 读 .collab 拿 collabRoot
ec fs cat <上一步路径>/.collab
#   → root: alice.agentid.pub:/projects/myapp   ← collabRoot 参数来源
```

**SDK**：`group.queryRegistry(groupAid)`（find 内部走注册表）+ `storage.getObject(.collab)`
**后端**：查 group_registry.collab_roots（避免 O(n) 扇出）
**链路核查**：✅ collabRoot 从 .collab 的 root 字段取得，不手动拼

---

<a name="s36"></a>
### S36 · 通过卡片链接加入协作

```bash
# 收到分享卡片，含 collabRoot。先申请权限（私聊授权方或自助申请）
# 授权方执行 setfacl 后，你即可参与：

ec collab ls alice.agentid.pub:/projects/myapp        # 列文档
#   ← collabRoot 来自卡片
ec collab read alice.agentid.pub:/projects/myapp spec.md   # 读某文档
# 之后流程同 S20
```

**链路核查**：✅ collabRoot 来自卡片，doc 来自 collab ls 响应

---

## 群共享空间

<a name="s37"></a>
### S37 · 加入群并挂载自己的目录

```bash
# 1. 把自己卷上的目录挂进群的专属槽位（虚拟卷，地址映射不搬数据）
ec fs mount g-team.agentid.pub:/memberdata/alice/ \
  --source alice.agentid.pub:/group-data/g-team/ \
  --request-approval

# 2. 群 admin 批准（若需审批）
ec fs approve g-team.agentid.pub: --request-id req_xxx
#                                              ↑ ← 来自 mount 返回的 pending requestId

# 3. 给群里其他人存储层读写权（alice 是卷主）
ec fs setfacl -m aid:bob.aid.pub:rw alice.agentid.pub:/group-data/g-team/projects/
```

- 数据占 alice 的配额，群不买单；alice 退群 → 挂载自动失效，数据离开群
- 两层授权：群层（admin 批准挂载）+ 存储层（alice 的 ACL），见 group-space.md

**SDK**：`storage.mountVirtualVolume` → `group.approveMountRequest` → `storage.setAcl`
**后端**：写 group_mounts + group_registry；访问时路径转换 + 两层鉴权
**链路核查**：✅ requestId 来自 mount 返回；挂载点槽位由加入群时自动创建

---

<a name="s38"></a>
### S38 · 查看群共享空间的存储状态

```bash
ec fs df g-team.agentid.pub:
#   Filesystem        Size  Used  Status   Owner          Mounted on
#   g-team (own)      20G   5G    active   g-team         /
#   alice (mounted)   30G   12G   active   alice.aid.pub  /memberdata/alice/
#   bob   (mounted)   10G   9G    grace*   bob.aid.pub    /memberdata/bob/
```

- 混合视图：群自有卷 + 各成员挂载卷；`*` = 成员卷进 grace（只读）

**SDK**：`storage.getGroupDf(groupAid)`
**后端**：合并群自有卷 + group_mounts 各项状态

---

<a name="s39"></a>
### S39 · 在群存储上发起协作

```bash
# collabRoot 在群自己的 storage，授权方 = 群 admin（一层授权，不涉及成员卷挂载）
ec fs mkdir g-team.agentid.pub:/projects/shared-spec/        # admin 执行
ec fs cp ./.collab g-team.agentid.pub:/projects/shared-spec/.collab
ec fs setfacl -m aid:bob.aid.pub:rw g-team.agentid.pub:/projects/shared-spec/   # admin 授权
ec collab create g-team.agentid.pub:/projects/shared-spec doc.md ./doc.md
```

- 与「成员卷发起」平行——区别仅在 collabRoot 存储 owner 是群，授权方是群 admin
- 数据占群配额，与群同寿（不随某成员退群消失）

**链路核查**：✅ 授权权威 = collabRoot 存储 owner（此处群 admin），规则统一

---

<a name="s40"></a>
### S40 · 收养成员贡献（固化进群存储）

```bash
# 把 alice 在群里的协作产物深拷进群 archive（脱离 alice 卷生命周期）
ec collab adopt g-team.agentid.pub:/memberdata/alice/projects/myapp \
                g-team.agentid.pub:/archive/myapp
```

- 日常协作走成员卷（省群的钱），关键产物收养进群存储（保关键数据）
- 收养后 alice 退群/卷过期，群内副本仍可读；新授权方 = 群 admin

**SDK**：`collab.adopt`（同 S34，目标在群 storage）
**后端**：copyObject × n（成员卷 → 群卷）
**链路核查**：✅ 复用 adopt 机制；依赖 copyObject（P2）

---

<a name="s41"></a>
### S41 · 踢出成员卷挂载

```bash
# 群 admin 卸载某成员的挂载（成员数据不删，只解除群内映射）
ec fs umount g-team.agentid.pub:/memberdata/alice/
```

- 群层断开：bob 即使有 alice 的 ACL 也看不到群路径
- alice 卷上的原数据完好，可重挂或独立使用

**SDK**：`storage.umountVirtualVolume`（admin 权限）
**后端**：group_mounts.status=inactive；group_registry 移除
**链路核查**：✅ 与成员主动 umount 同机制，区别在执行者是 admin

---

## 卷管理

<a name="s42"></a>
### S42 · 挂载额外存储卷

```bash
# 开通的实体卷默认自动挂载；高阶自定义挂载点：
ec fs mount alice.agentid.pub:/archive --volume vol_abc123
#                                                ↑ ← 来自开通卷时分配的 volume_id
```

**SDK**：`storage.mountVolume(mountPoint, volumeId)`
**后端**：volumes 表更新 mount_point

---

<a name="s43"></a>
### S43 · 卸载卷

```bash
ec fs umount alice.agentid.pub:/archive
```

- 只解绑路径，不删数据，可重新挂到别处

**SDK**：`storage.umountVolume`
**后端**：volumes.mount_point = null

---

<a name="s44"></a>
### S44 · 查看卷状态和配额

```bash
ec fs df alice.agentid.pub:           # 见 S07
```

同 [S07](#s07)。

---

## 附录 · 本文核查暴露的设计缺口汇总

写本文时按「SDK 接口是否齐备 + 链路是否通 + 参数来源是否明确」核查，发现以下需回补到设计文档的点（**已全部回补**）：

| 缺口 | 涉及场景 | 处理 | 状态 |
|------|---------|------|------|
| `storage.renameSymlink`（改软链名/路径） | S05, S27 | 已补进 `topics/symlink.md` SDK 接口 | ✅ |
| `storage.deleteSymlink`（删软链，区别于删对象） | S10, S26 | 已补进 `topics/symlink.md` SDK 接口 | ✅ |
| `storage.deleteObjects`（批量删，rm -r 效率） | S06, S19 | 已补进 `10-storage.md` 后端 RPC 表 | ✅ |
| `storage.copyObject`（服务端 copy） | S33, S34, S40 | 已在 `10-storage.md` 标 P2（待 SDK 实现） | ✅ |
| 文档改名后台账索引依据 | S27 | 已在 `30-collab.md` 明确：台账按物理目录名索引，显示名可变 | ✅ |
| collabRoot 改名的处理 | S18 | 已在 `30-collab.md` 明确：用 adopt 而非 mv | ✅ |
| `atomicRepoint` 无 CAS 变体（普通重指 /public） | S09 | 已在 `topics/symlink.md` 说明 expectedVersion 可为 null | ✅ |

> 设计层面的接口与链路已闭环。剩余 `copyObject`/`deleteObjects` 是 fastaun SDK 的实现待办（已标优先级），不阻塞设计定稿。


