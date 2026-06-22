# 专题 · 群共享空间

> **本文是群共享空间的单一事实源（SSOT）**。其他文档只引用本文，不复述。
> 虚拟卷挂载链路见 `topics/virtual-volume.md`；权限模型见 `topics/acl-auth.md`。

---

## 【使用】

### 心智模型：群空间是混合体

群共享空间由两部分构成，归属、付费、持久性完全不同：

| 区域 | 物理后端 | 谁付费 | 持久性 | 用途 |
|------|---------|--------|--------|------|
| **群自有区**（announce/public/archive） | 群 storage | 群 | 与群同寿 | 群权威数据、对外发布、收养产物 |
| **成员挂载区**（memberdata/<aid>/） | 该成员 storage | 该成员 | 随成员卷 + 在群状态 | 成员贡献、成员发起的协作根 |

### 群目录基线

```
g-team.agentid.pub:/
├── announce/        ← 公告区，admin/owner 可写，成员可读
├── public/          ← 群对外 Web 根（→ https://<群AID>/）
├── archive/         ← 收养区，关键产物的群兜底持久化
└── memberdata/
    ├── alice.aid.pub/   ← alice 的卷（虚拟卷挂载，alice storage）
    └── bob.aid.pub/     ← bob 的卷
```

**没有 `/share/` 协作特区**：协作走 ACL + `.collab` 组织（见 `30-collab.md`），群目录里不存在专用协作特区。

### 两层授权串联

成员卷挂进群后，访问群路径需要**两层都通过**：

| 层 | 授权方 | 管什么 | 失败报什么 |
|----|--------|--------|-----------|
| **群层** | 群 admin | 挂载是否 active，成员是否在群 | 「资源不在群内」 |
| **存储层** | 卷主（成员） | 访问者对该路径是否有 ACL | `EACCES` |

缺任一层都失败，报错性质不同——调用方据此区分是群问题还是权限问题。

群存储上（announce/archive/public）只有群层（一层）——授权方是群 admin。

### 操作链路

```bash
# ① 成员挂载自己的目录进群
ec fs mount g-team.agentid.pub:/memberdata/alice/ \
  --source alice.agentid.pub:/group-data/g-team/ \
  [--request-approval]

# ② 群 admin 批准（若需审批）
ec fs approve g-team: --request-id req_xxx

# ③ alice 给群里其他人存储层读写权限（alice 是卷主才能做）
ec fs setfacl -m aid:bob.aid.pub:rw alice:/group-data/g-team/projects/x/

# 虚拟卷挂载完整链路见 topics/virtual-volume.md
# setfacl 完整语法见 topics/acl-auth.md
```

### df 的群空间视图

`ec fs df g-team:` 展示混合构成——群自有卷 + 各成员挂载卷的状态：

```
Filesystem              Size   Used  Avail  Status   Owner          Mounted on
g-team (own)            20G    5G    15G    active   g-team         /  (announce,public,archive)
alice (mounted)         30G    12G   18G    active   alice.aid.pub  /memberdata/alice/
bob   (mounted)         10G    9G    1G     grace*   bob.aid.pub    /memberdata/bob/
```

`*` = bob 的卷已进 grace（只读），其群内数据暂不可写。

### 收养（adopt）：关键产物固化进群

成员贡献存在自己卷——退群/卷过期则数据离开群空间。若群需要保留某产物，由 admin 执行收养（把数据深拷进群 storage，脱离成员卷生命周期）：

```bash
# 把 alice 协作根的当前权威版本深拷进群 archive
ec collab adopt alice:/group-data/g-team/projects/myapp  g-team:/archive/myapp
```

- **日常协作走成员卷**（省群的钱），**关键产物收养进群 storage**（保关键数据）。
- 收养产生独立副本（服务端 copy，见 `10-storage.md` C11）：源删除不影响副本。
- 收养后授权方变成群 admin（new-root 在群 storage，ACL owner 是群）。

### 群级注册表（协作发现）

```bash
ec fs find g-team:/memberdata/ --name .collab   # ← 触发注册表查询，不实时扇出
```

群注册表缓存「哪个成员挂了什么、哪些路径有 .collab」，避免向所有成员卷实时扇出（O(n) + 单点宕机导致列表残缺）。成员挂载/卸载、collab create 时自动更新注册表。

---

## 【实现】

### CLI 实现者

**mount**：见 `topics/virtual-volume.md`。

**approve/reject**：
```
ec fs approve <group-aid>: --request-id <id>
ec fs reject  <group-aid>: --request-id <id> --note "原因"
ec fs ls --pending <group-aid>:            # 查待审批列表
```

**adopt**：转发给 `ec collab adopt`（见 `30-collab.md`）。

**df 群视图**：调 `storage.getGroupDf(groupAid)`，后端合并群自有卷 + 所有 active/grace/unavailable 挂载项，返回统一格式（CLI 按格式渲染，grace 标 `*`，unavailable 标 `⚠`）。

### SDK 设计者

```
// 群成员管理（加入/退出联动挂载槽位创建/销毁）
group.addMember({ groupAid, memberAid, role, adminAid })
  → 后端同步创建 memberdata/<memberAid>/ 槽位 + 授予该成员对槽位的 mount 权限

group.removeMember({ groupAid, memberAid, adminAid })
  → 后端同步将该成员所有挂载标 inactive，槽位不再可见

// 审批
group.listPendingMounts({ groupAid, adminAid }) → [{requestId, memberAid, sourcePath, requestedAt}]
group.approveMountRequest({ groupAid, requestId, adminAid })
group.rejectMountRequest({ groupAid, requestId, adminAid, note? })

// df 群视图
storage.getGroupDf({ groupAid, requesterAid })
  → {
      own: { size, used, avail, status },
      mounts: [{ memberAid, mountPoint, sourceAid, size, used, status, expires? }]
    }

// 群注册表
group.updateRegistry({ groupAid, memberAid, mountPoint?, collabRoots? })  // 内部调用
group.queryRegistry({ groupAid }) → [{memberAid, mountPoint, collabRoots, status}]
```

### AUN 后端实现者

**群成员槽位的自动创建**：`group.addMember` 触发时，后端在群 storage 元数据里创建 `/memberdata/<memberAid>/` 条目（纯元数据，无存储分配），同时在 `path_acls` 里写一条「`<memberAid>` 对 `g:/memberdata/<memberAid>/` 有 mount/umount 权限」。

**注册表维护**（`group_registry` 表，见 `virtual-volume.md`）：
- 挂载成功 → `UPDATE group_registry SET mount_point=..., status=active`
- 卸载/退群 → `UPDATE ... SET mount_point=null, status=inactive`
- collab create → `UPDATE ... SET collab_roots = collab_roots || [new_root]`
- `find --name .collab` → `SELECT collab_roots FROM group_registry WHERE group_aid=?`（无跨卷扇出）

**成员退群联动**（原子事务）：
```sql
BEGIN;
  UPDATE group_mounts    SET status='inactive' WHERE group_aid=? AND source_aid=?;
  UPDATE group_registry  SET mount_point=null, status='inactive' WHERE group_aid=? AND member_aid=?;
  DELETE FROM path_acls  WHERE owner_aid LIKE 'g-team%' AND grantee_aid=?;  -- 撤销群内 ACL
COMMIT;
```

**部分不可达的处理**：访问 `g:/memberdata/<aid>/` 时若挂载状态为 `unavailable`（源卷 expired），返回：
```json
{ "error": "VOLUME_EXPIRED", "owner": "<aid>", "path": "g:/memberdata/<aid>/", "suggestion": "contact <aid> to renew or admin to ec collab adopt" }
```
