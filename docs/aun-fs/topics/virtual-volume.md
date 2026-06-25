# 专题 · 虚拟卷挂载机制

> **本文是虚拟卷的单一事实源（SSOT）**。其他文档（`10-storage.md`、`topics/group-space.md`）只引用本文，不复述。
>
> 结构：【使用】面向 Agent + 人类 → 【实现】面向 CLI / SDK / AUN 后端。

---

## 【使用】

### 心智模型

- **实体卷（Physical Volume）**：独立开通、独立付费、独立配额的存储卷，有 `volume_id`（如 `vol_abc123`）。类比「买了一块硬盘」。
- **虚拟卷（Virtual Volume）**：**不开通、不付费、零额外配额**——把某个 AID 已有的一个目录，声明为「可挂载到别处的单元」。挂载是纯地址映射，数据仍在原 AID 的实体卷上，配额仍计在原 AID 头上。类比「把自己的一个文件夹共享给别人当网络盘符」。

一句话：**实体卷是「磁盘」，虚拟卷是「把已有目录映射成别处的一个挂载点」。**

虚拟卷的核心用途：**群成员把自己卷上的目录挂进群的 `memberdata/<自己AID>/`**——这样成员贡献的数据占自己的配额，群不为成员数据买单，成员退群数据自动离开群空间。

### 命令：两种挂载形态

```bash
# 实体卷挂载（--volume = volume_id，挂载自己 AID 名下的付费卷）
ec fs mount alice.agentid.pub:/archive --volume vol_abc123

# 虚拟卷挂载（--source = <owner-aid>:<path>，把已有目录跨主体映射到挂载点）
ec fs mount g-team.agentid.pub:/memberdata/alice/ \
  --source alice.agentid.pub:/group-data/g-team/ \
  [--request-approval]

# 卸载（解除映射，不删数据）
ec fs umount g-team.agentid.pub:/memberdata/alice/
```

`--volume vol_id`（实体卷）与 `--source <aid>:<path>`（虚拟卷）是**两个互斥参数**，决定挂载形态。

### 典型场景：alice 把工作目录挂进群

```bash
# ① alice 把自己卷上的目录挂到群里属于她的槽位
ec fs mount g-team.agentid.pub:/memberdata/alice/ --source alice.agentid.pub:/group-data/g-team/

# ② （若群要求审批）群 admin 批准
ec fs approve g-team: --request-id req_xxx

# ③ 挂载生效后，g:/memberdata/alice/projects/x 与 alice:/group-data/g-team/projects/x
#    是同一份数据的两个视图。数据占 alice 的配额。
```

### 关键性质（使用者必须知道）

| 性质 | 说明 |
|------|------|
| 不预分配容量 | 虚拟卷挂载不消耗新配额，数据占原 AID 的实体卷 |
| 双视图一致 | 群路径与 owner 路径指向同一份物理数据 |
| 卸载不删数据 | umount 只解除映射，原数据完好，可重挂别处 |
| 退群自动失效 | 成员退群 → 挂载自动失效，数据离开群空间 |
| 源卷过期则不可用 | 原 AID 的卷进入 expired → 挂载降级 unavailable，`df` 标注 |
| 双层授权 | 群场景下叠加群层授权，见 `topics/group-space.md` |

---

## 【实现】

### CLI 实现者

`ec fs mount <mount-target> [--volume <id> | --source <aid>:<path>] [--request-approval]`

解析逻辑：
1. 解析 `<mount-target>` 为 `<AID>:<path>`（挂载点所在主机 + 挂载点路径）。
2. 互斥校验：`--volume` 与 `--source` 必须恰有其一；都缺或都给 → 报错。
3. `--volume` → 实体卷挂载分支；`--source` → 虚拟卷挂载分支。
4. 携带操作者身份（`--as` 或 `EVOLCLAW_SELF_AID`）。
5. `--request-approval` → 调审批接口而非直接挂载。
6. 输出：成功 `{status: "mounted"|"pending", mountPoint, ...}`；失败带错误码与下一步提示。

`ec fs umount <mount-target>`：解析挂载点 → 调卸载接口 → 输出解除结果（强调「数据未删」）。

### SDK 设计者

```
storage.mountVirtualVolume({
  mountTarget:    "g-team:/memberdata/alice/",   // 挂载点（含主机 AID + 路径）
  sourceAid:      "alice.agentid.pub",           // 数据来源 AID
  sourcePath:     "/group-data/g-team/",          // 数据来源路径
  requesterAid:   "alice.agentid.pub",           // 操作者
  requireApproval: false                          // 是否走审批
}) → { status: "mounted" | "pending", requestId?, mountPoint }

storage.umountVirtualVolume({ mountTarget, requesterAid })
  → { status: "unmounted", dataPreserved: true }

storage.approveMountRequest({ groupAid, requestId, approverAid })
  → { status: "mounted" }

storage.mountPhysicalVolume({ mountTarget, volumeId, requesterAid })
  → { status: "mounted" }
```

### AUN 后端实现者

**挂载点的来源**：成员加入群时，后端自动在群目录树创建 `/memberdata/<aid>/` 槽位（纯元数据，无存储分配），并授予该成员对自己槽位的 mount/umount 权限。alice 执行 mount 时槽位已存在。

**完整挂载链路**：

```
1. alice 执行 mount g-team.agentid.pub:/memberdata/alice/ --source alice.agentid.pub:/group-data/g-team/

2. SDK → storage.mountVirtualVolume({...})

3. 后端处理:
   a. 鉴权: alice 拥有 g:/memberdata/alice/ 的 mount 权限? (加入群时授予)
   b. 鉴权: alice 拥有 alice:/group-data/g-team/ 的读权限? (卷主，显然有)
   c. 若 requireApproval:
      - 写 pending_mounts 记录，通知群 admin
      - 返回 {status: "pending", requestId}
   d. 否则（或审批通过后）:
      - 写 group_mounts 一行: {mountPoint, sourceAid, sourcePath, status: active}
      - 更新 group_registry 中 alice 的挂载状态
      - 返回 {status: "mounted"}

4. （审批分支）群 admin: approveMountRequest → 把 pending 改 active，触发 3d
```

**挂载生效后的访问解析流程**（访问 `g-team:/memberdata/alice/projects/x`）：

```
a. 路由层识别 g-team 为群 AID
b. 查 group_mounts: /memberdata/alice/ 有 active 挂载 → sourceAid=alice, sourcePath=/group-data/g-team/
c. 路径转换: g:/memberdata/alice/projects/x → alice:/group-data/g-team/projects/x
d. 两层鉴权串联（见 group-space.md）:
   - 群层: 挂载 active? alice 未退群? → 通过
   - 存储层: 访问者对 alice:/group-data/g-team/projects/x 有 ACL? → 按 alice 的 setfacl 校验
e. 从 alice 的物理存储读数据
f. 配额: 计入 alice 的卷，不计入群
```

**挂载自动失效的三种触发**：

| 触发 | 后端动作 |
|------|---------|
| alice 主动 umount | group_mounts 记录标 inactive，从 group_registry 移除；alice 数据完好 |
| alice 退群 | 退群事件 → alice 的所有挂载标 inactive，槽位不再可见 |
| alice 源卷 expired | 存储事件 → 挂载降级 unavailable；访问返回 `{status: "volume_expired", owner: "alice"}`，`df` 标注 ⚠ |

**数据结构**：

```sql
-- 群挂载表
CREATE TABLE group_mounts (
  group_aid    TEXT NOT NULL,
  mount_point  TEXT NOT NULL,          -- "/memberdata/alice/"
  source_aid   TEXT NOT NULL,          -- "alice.agentid.pub"
  source_path  TEXT NOT NULL,          -- "/group-data/g-team/"
  status       TEXT NOT NULL,          -- active | inactive | unavailable
  mounted_at   TIMESTAMP,
  PRIMARY KEY (group_aid, mount_point)
);

-- 群注册表（协作发现，避免向各成员卷实时扇出，见 group-space.md）
CREATE TABLE group_registry (
  group_aid    TEXT NOT NULL,
  member_aid   TEXT NOT NULL,
  mount_point  TEXT,                   -- null = 未挂载
  collab_roots JSONB,                  -- ["/group-data/g-team/projects/x", ...]
  updated_at   TIMESTAMP,
  PRIMARY KEY (group_aid, member_aid)
);
```

> 表结构是契约示意（说明后端需持有哪些信息），非强制 schema。后端可用任意实现，只要满足上述链路与失效语义。

### 现状对照（fastaun 0.4.2）

无跨主体虚拟卷挂载，无卷生命周期（grace/expired）。需后端补齐：挂载表 + 访问解析时的路径转换 + 退群/过期的自动失效。详见 `10-storage.md` 现状对照节。
