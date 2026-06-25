# 致 fastaun SDK 团队 · AUN 文件系统能力需求清单

> **本文性质**：一份**提需求清单**，面向 fastaun（`@agentunion/fastaun`）SDK 与 AUN 后端团队。
>
> `ec fs` / `ec collab` / 群共享空间的整套设计（见 `docs/aun-fs/`）建立在存储层之上。本文把「设计依赖、但 fastaun 0.4.2 尚未提供」的能力集中成清单，每条给出：**为什么需要 → 接口契约 → 验收标准 → 优先级**。
>
> **基准版本**：fastaun 0.4.2。下文「现状」均指该版本。
> **命名约定**：SDK 层方法用驼峰（`storage.putObject`），底层 JSON-RPC 方法名用蛇形（`storage.put_object`）。本文给 SDK 层签名。

---

## 0. 一页速览

| # | 能力 | 现状 | 优先级 | 阻塞什么 |
|---|------|:---:|:---:|------|
| R1 | 软链 / 指针原语（含跨 AID + 原子重指 CAS） | ❌ 完全缺失 | **P0** | 整套设计的核心原语：`/public` 发布、collab `@current`/`@snapshot` |
| R2 | 细粒度 ACL（按 AID 授权 + 继承 + 限次/限时） | ❌ 仅 is_private 二元 | **P1** | setfacl、所有协作授权 |
| R3 | 虚拟卷跨主体挂载（+ 挂载表 + 访问路径转换 + 自动失效） | ❌ 缺失 | **P1** | 群共享空间成本归属模型 |
| R4 | 协作台账追加（appendLedger） | ❌ 缺失 | **P1** | collab create/submit 的可追溯性 |
| R5 | 服务端对象复制（copyObject） | ❌ 缺失 | **P2** | 跨主机 cp、collab export/adopt、群收养 |
| R6 | 批量删除（deleteObjects） | ❌ 缺失 | **P2** | `rm -r` 效率 |
| R7 | 通用访问令牌（token 签发/吊销/列举 + HTTP Bearer） | 🟡 仅下载 ticket | **P2** | 对外分享 |
| R8 | 卷生命周期（active/grace/expired + 续费） | 🟡 仅 quota/bucket | **P2** | df 状态、计费、群成员卷 |
| R9 | Range 读（取对象头部字节） | 🟡 待确认 | **P2** | cat 二进制返回魔数头 |
| R10 | 群成员加入/退出联动（槽位创建 + 挂载失效） | ❌ 缺失 | **P1** | 群成员卷生命周期 |

**已具备、无需新增**（设计直接复用，列此以免重复造）：
- 对象 CRUDL + 分页（put/get/head/delete/list_objects/list_prefixes）✅
- **对象级 CAS**（`expected_version` + version 递增 + `-32009` 冲突码）✅ —— 这是 collab 乐观锁的基石，最大的好消息
- 自定义元数据（metadata 参数）✅
- 配额查询（get_quota / get_limits / check_upload）✅
- 大文件预签名上传/下载（create_upload_session / complete_upload / create_download_ticket）✅
- 变更事件（event/storage.object_changed）✅
- 群资源角色制 API（group.resources.*）✅

---

## P0 — 阻塞整套设计

### R1 · 软链 / 指针原语

**为什么需要**：软链是整套设计的核心原语，三处强依赖——① `/public/x → /private/真实文件`（对外发布）；② collab `<doc>@current`、`@snapshot`（版本/快照指针）；③ 稳定别名。必须能跨 AID（alice 的链接指向 g-team 的文件），且支持**原子条件重指（CAS）**——这是 collab submit 与 snapshot create 乐观锁正确性的根基。

**关键实现要点**：软链**不是对象存储里的对象，而是元数据库一行**。OSS 没有 symlink 概念，硬塞成对象会带来一致性与原子性问题。建议存为 DB 表（`symlinks`），解析时做路径转换。

**接口契约**（SDK 层）：

```
storage.createSymlink({ src, dst, requesterAid, overwrite? })
  → { ok, dst, src } | { ok:false, error:"EEXIST" }

storage.resolveSymlink({ path, requesterAid })
  → { target, dangling:false } | { dangling:true, originalTarget }

storage.atomicRepoint({ symlinkPath, newTarget, expectedVersion:number|null, requesterAid })
  → { ok:true, version } | { ok:false, currentVersion, currentTarget }
  // expectedVersion 非 null = CAS（collab 用）；null = 普通重指（/public 发布用）

storage.renameSymlink({ path, newPath, requesterAid })   // 只改 key，target 不变
  → { ok, path:newPath } | { ok:false, error:"EEXIST"|"ENOENT" }

storage.deleteSymlink({ path, requesterAid })            // 只删软链，不删 target 对象
  → { ok }
```

**验收标准**：
- `createSymlink(alice:/public/a → alice:/private/a)`，删 `/public/a` 后 `/private/a` 完好。
- 跨 AID：`alice:/refs/x → g-team:/share/x`，alice 无群权限时 resolve 后访问报 `EACCES`（**权限不随软链传递**，按目标真实 ACL 重新校验）。
- 悬空检测：目标删除后 resolve 返回 `dangling:true`。
- **原子重指 CAS**：两个并发 `atomicRepoint(expectedVersion=N)` 恰好一个成功（version→N+1），另一个返回 `{ok:false, currentVersion:N+1}`，无副作用。
- `renameSymlink` 改名后 target 不变（用于 collab 文档改名，历史不断）。

---

## P1 — 阻塞协作与群核心功能

### R2 · 细粒度 ACL（按 AID 授权）

**为什么需要**：`setfacl` 是协作授权的唯一机制——「谁能 collab submit」≡「谁对 collabRoot 有写权限」。还需支持限次/限时。现状 fastaun 0.4.2 个人 storage 只有 `is_private` 二元权限（仅 owner / 公开只读），不够。

**接口契约**：

```
storage.setAcl({ path, requesterAid, aid, perms:"r"|"rw"|"rwx", expires?, maxUses? })
storage.removeAcl({ path, requesterAid, aid })
storage.listAcl({ path, requesterAid }) → [{aid, perms, expires, maxUses, usedCount}]
storage.checkAccess({ path, requesterAid, operation:"read"|"write"|"delete", token? })
  → { allowed:true } | { allowed:false, reason:"EACCES"|"acl_expired"|"acl_exhausted" }
```

**统一权限求值顺序**（后端必须按此实现，见 `topics/acl-auth.md`）：
```
公开位 → token → 细粒度 ACL → 角色权限(群) → owner → 否则 EACCES
```

**继承**：对前缀（目录）授权，其下现存与新建对象默认继承；子路径具体条目可覆盖父级（取最近祖先前缀匹配）。

**验收标准**：
- 给 bob 授 `alice:/projects/myapp/` 的 rw，bob 可写其下任意子文件；撤销后立即 `EACCES`。
- `maxUses=10` 的读授权，第 11 次读被拒。
- 子目录单设 `r` 能覆盖父目录的 `rw`。

---

### R3 · 虚拟卷跨主体挂载

**为什么需要**：群共享空间的成本归属模型基础——成员把自己卷上的目录挂进群 `memberdata/<aid>/`，数据占成员自己配额，群不买单，成员退群数据自动离开。详见 `topics/virtual-volume.md`（完整链路）。

**接口契约**：

```
storage.mountVirtualVolume({ mountTarget, sourceAid, sourcePath, requesterAid, requireApproval? })
  → { status:"mounted"|"pending", requestId?, mountPoint }
storage.umountVirtualVolume({ mountTarget, requesterAid }) → { status:"unmounted", dataPreserved:true }
storage.approveMountRequest({ groupAid, requestId, approverAid }) → { status:"mounted" }
```

**后端必须实现**：
- 挂载表 `group_mounts {group_aid, mount_point, source_aid, source_path, status}`。
- **访问路径转换**：访问 `g:/memberdata/alice/x` → 查挂载表 → 转 `alice:/group-data/g-team/x` → 两层鉴权（群层挂载 active + 存储层 alice 的 ACL）→ 读 alice 物理存储。
- **配额归属**：写入计入 source_aid 的卷，不计群。
- 挂载是地址映射，不搬数据；umount 只解绑不删数据。

**验收标准**：
- 把 `alice:/group-data/g-team/` 挂到 `g:/memberdata/alice/`，两地址访问同一数据，占 alice 配额。
- 群 admin umount 后，他人即使有 alice 的 ACL 也访问不到群路径（群层断）。
- 自动失效：alice 退群 / 源卷 expired → 挂载自动失效，原数据完好。

---

### R4 · 协作台账追加（appendLedger）

**为什么需要**：collab 的可追溯性硬规则——每次 create/submit 在台账记一条 `{version, author, target, time}`。台账 + 不可变版本文件 = 完整历史。

**接口契约**：

```
storage.appendLedger({ collabRoot, doc, version, authorAid, target, requesterAid })
  → { ok }
storage.readLedger({ collabRoot, doc, requesterAid })
  → [{ version, authorAid, target, time }]   // target 内部相对 collabRoot，响应时绝对化
```

**关键**：台账按**物理 .collab-versions 目录名（doc）** 索引，不随 `@current` 显示名变化（支持文档改名后历史不断）。`target` 内部存相对 collabRoot 的路径，API 响应时拼成绝对 `<aid>:<path>`。

**验收标准**：
- 连续 submit 后 readLedger 返回单调递增的 version 列表，每条带正确 author/target/time。
- 文档 `@current` 改名后，按原 doc 名仍查得到完整历史。

---

### R10 · 群成员加入/退出联动

**为什么需要**：成员卷挂载的生命周期要和群成员关系绑定——加入时自动创建挂载槽位，退出时自动失效其所有挂载并回收群内 ACL。

**接口契约**：

```
group.addMember({ groupAid, memberAid, role, adminAid })
  // 副作用：创建 /memberdata/<memberAid>/ 槽位（纯元数据）+ 授予该成员对槽位的 mount 权限
group.removeMember({ groupAid, memberAid, adminAid })
  // 副作用：该成员所有挂载标 inactive + 槽位不可见 + 回收群内 ACL（原子事务）
group.listPendingMounts({ groupAid, adminAid }) → [{requestId, memberAid, sourcePath, requestedAt}]
group.queryRegistry({ groupAid }) → [{memberAid, mountPoint, collabRoots, status}]
```

**验收标准**：
- addMember 后该成员可直接 mount 自己的槽位（无需 admin 再授 mount 权）。
- removeMember 后该成员的群内数据与 ACL 在同一事务内全部回收。
- `group_registry` 在挂载/卸载/collab create 时自动更新，`find --name .collab` 查注册表不向各成员卷扇出。

---

## P2 — 效率与完整性，可后置但定稿前需确认

### R5 · 服务端对象复制（copyObject）

**为什么需要**：跨主机 `cp`、collab `export`/`adopt`、群 `adopt` 收养——都需把对象从一处复制到另一处。同后端复制应避免「下载到客户端再上传」的出网流量。

```
storage.copyObject({ srcOwner, srcPath, dstOwner, dstPath, requesterAid })
  → { ok, dstPath }
```

**验收**：`cp a:/x g:/archive/x` 在服务端完成不下载；adopt 后删源，副本仍可读（独立对象）。

---

### R6 · 批量删除（deleteObjects）

**为什么需要**：`rm -r` 删目录 = LIST prefix + 逐个删，逐个删 RTT 太多。

```
storage.deleteObjects({ ownerAid, keys:[...], requesterAid }) → { deleted:n, failed:[] }
```

**验收**：`rm -r` 一个含 1000 对象的目录，调用次数与延迟显著低于逐个 deleteObject。

---

### R7 · 通用访问令牌

**为什么需要**：对外分享（`ec fs token issue`）——给公开路径签发带期限/次数的凭证，CLI（`--token`）与 HTTP（`Authorization: Bearer`）两侧通用。现状仅有 `create_download_ticket`（单次下载预签名），缺通用 token 的签发/吊销/列举与 HTTP Bearer 校验。

```
storage.issueToken({ path, requesterAid, expires?, maxReads? }) → { token, path, expires, maxReads }
storage.revokeToken({ path, token, requesterAid })
storage.listTokens({ path, requesterAid }) → [{token, expires, maxReads, usedCount}]
```

**验收**：`maxReads=10` 的 token，HTTP 第 11 次带 Bearer 被拒；吊销后立即失效（未到 expires 也失效）；匿名 HTTP 携带有效 token 可访问私有对象。

---

### R8 · 卷生命周期

**为什么需要**：计费与 df 状态展示。卷需有 active → grace（只读宽限）→ expired（回收）的生命周期，续费回 active。现状仅有 quota/bucket 概念。

```
storage.getVolumes({ ownerAid, requesterAid })
  → [{ volumeId, size, used, avail, status:"active"|"grace"|"expired", expires, mountPoint }]
storage.mountVolume({ ownerAid, mountPoint, volumeId, requesterAid })
storage.umountVolume({ ownerAid, mountPoint, requesterAid })
```

**验收**：`df` 列出各卷 size/used/avail/status/expires/挂载点；grace 卷可读不可写；续费恢复可写。

---

### R9 · Range 读

**为什么需要**：`cat` 二进制文件返回「元数据 + 文件头部 256 字节」（用于判魔数），不传完整文件。需要按 offset+length 取对象片段。

```
storage.getRangeBytes({ ownerAid, path, offset, length, requesterAid }) → { bytes(base64) }
```

**验收**：取前 256 字节用于识别 zip/pdf/png/tar 等魔数（含偏移靠后的 TAR `ustar@257`）。**现状待确认**——若 `get_object` 已支持 HTTP Range 则无需新增，请 SDK 团队确认。

---

## 实施建议

1. **先做 P0（R1 软链）**：它是整套设计的地基，其中 `atomicRepoint` 的 CAS 又是 collab 全部并发正确性的根。建议第一个原型验证——用 DB 行 + 条件 UPDATE 实现，参考已有的对象级 `expected_version` 机制（同一套乐观锁思路，从对象延伸到指针）。
2. **P1 并行**：R2（ACL）、R3+R10（虚拟卷+群联动）、R4（台账）相互独立，可并行。R3 与 R10 联系紧密，建议同一人/组负责。
3. **P2 视排期**：R5/R6 是效率优化（无则降级为多次单操作，功能不缺）；R7/R8 是完整性（无则分享/计费功能受限）；R9 先确认 Range 是否已有。
4. **复用而非新建**：对象 CAS、分页、元数据、预签名上传、群角色 API 都已具备，新能力应建立在其上，不重复造。

> 本文是需求，不规定实现。SDK/后端如何用 OSS + 元数据库满足这些契约，是 SDK 团队的自由——只要通过各条的验收标准。设计侧的接口与链路已在 `docs/aun-fs/` 闭环。

