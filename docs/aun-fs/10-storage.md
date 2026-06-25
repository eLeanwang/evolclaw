# 10 · 存储层

> 本文讲存储层的能力规格。软链见 `topics/symlink.md`，ACL/token 见 `topics/acl-auth.md`，虚拟卷挂载见 `topics/virtual-volume.md`。

---

## 【使用】

### 心智模型

```
AID = 主机（有目录树的远程机器）
卷  = 磁盘分区（挂在 AID 主机的某个目录）
对象 = 文件（不可变 blob，写一次永不原地改）
软链 = 指针（轻量元数据，不是对象）
```

个人 AID 的目录基线：

```
alice.agentid.pub:/
├── private/      ← 私有区（默认所有数据落这里）
├── public/       ← Web 根（软链进来才对外可见 → https://alice.agentid.pub/）
└── <挂载点>/     ← 额外挂载的卷（如 /archive/）
```

**默认私有，显式公开**：不在 `/public/` 下、也没软链进 `/public/` 的任何东西，永不对外可见。

### 卷生命周期

```
开通 → active（可读可写）
         │ 授权期到
         ▼
       grace（只读宽限，服务商策略，非保证，df 标注 *）
         │ 宽限期到
         ▼
       expired（数据回收）
```

续费延长授权期，回 active。

> **路径规划是一次性决策**：目录结构（挂载点路径、卷的 mount_point）一旦被其他文件、软链、collab 台账引用，就形成依赖——重命名或移动目录代价极高（OSS 没有 rename，只有 copy+delete，且所有引用都要改）。因此在开通卷/规划目录结构时应认真设计，用软链作为稳定入口（`/releases/latest → /releases/v2.3.1`），让真实路径可变而对外接口不变。规则：**不要把内部目录路径直接暴露给外部调用方**，始终通过软链或 API 封装一层。

---

## 【实现】

### 存储层的两半

后端**必须**把存储分成两半——这是软链/CAS/ACL 能正确实现的前提：

```
不可变大块数据（写一次永不改）  →  对象存储（OSS/S3 类）
  · 用户普通文件 blob
  · collab 版本文件（.collab-versions/...）
  · 快照 manifest（.collab-snapshots/...）

可变的「脊柱」（指针/计数器/ACL/台账）  →  元数据库（DB）
  · 软链（@current/@snapshot/public 映射）
  · version 计数器（CAS 的版本号）
  · setfacl 的 AID 白名单
  · chmod 可见性
  · token 记录
  · 卷/挂载/配额元数据
  · 群挂载表 / 群注册表
```

**为何必须劈成两半**：OSS 没有 symlink 概念、没有跨对象 CAS、原生 ACL 太粗——这些必须放 DB。OSS 擅长的是：write-once 大文件、CDN 加速、冷归档分层、按使用量计费。两者各司其职。

### 对象存储（CLI / SDK / 后端）

**CLI**：`cp`（上传/下载/跨主机）、`cat`（文本直接返回，二进制返元数据+魔数头）、`rm`、`head`（仅取元数据）、`find`（元数据过滤，不碰内容）。

**SDK**：

```
storage.putObject({ ownerAid, path, content|uploadUrl, contentType?, metadata?, isPublic? })
storage.getObject({ ownerAid, path, requesterAid, token? })
storage.headObject({ ownerAid, path, requesterAid }) → { size, mtime, mime, etag, version }
storage.deleteObject({ ownerAid, path, requesterAid })
storage.listObjects({ ownerAid, prefix, requesterAid, page?, size?, marker? })
  → { items: [{key, size, mtime, type}], nextMarker? }
storage.listPrefixes({ ownerAid, prefix, requesterAid })   // 直接子目录（CommonPrefixes）
storage.copyObject({ srcOwner, srcPath, dstOwner, dstPath, requesterAid })  // 服务端 copy
storage.createUploadSession({ ownerAid, path, sizeBytes, contentType? })
  → { uploadUrl, sessionId }
storage.completeUpload({ ownerAid, path, sha256, sessionId, expectedVersion? })
storage.getRangeBytes({ ownerAid, path, offset, length, requesterAid })     // cat 二进制头部
```

**后端 RPC 原语**（fastaun 已有但需对齐的方法）：

| RPC 方法 | 说明 | fastaun 0.4.2 现状 |
|---------|------|--------------------|
| `storage.put_object` | inline 写小对象（≤64KB） | ✅ 有，含 `expected_version` CAS |
| `storage.get_object` | 读对象 | ✅ |
| `storage.head_object` | 取元数据 | ✅ |
| `storage.delete_object` | 删除单个对象 | ✅ |
| `storage.delete_objects` | 批量删除（`rm -r` 效率，减少 RTT） | ❌ **缺失，需补** |
| `storage.list_objects` | prefix 列举 + 分页 | ✅ |
| `storage.list_prefixes` | 直接子前缀 | ✅ |
| `storage.create_upload_session` | 大文件预签名上传 | ✅ |
| `storage.complete_upload` | 确认上传 + CAS | ✅ |
| `storage.create_download_ticket` | 预签名下载 | ✅ |
| `storage.copy_object` | 服务端 copy（不经客户端） | ❌ **缺失，需补** |
| `storage.get_range` | Range 读（取文件头部字节） | 待确认 |
| `storage.append_ledger` | 协作台账追加（collab create/submit 调用） | ❌ **缺失，需补** |

> **命名规范**：上表沿用 fastaun 0.4.2 的蛇形命名（`storage.put_object`），与高层 SDK 封装（`storage.putObject` 驼峰）是**两套**——后者是 fastaun 对外暴露的 TypeScript SDK 方法，前者是底层 JSON-RPC 方法名。`appendLedger` / `copyObject` / `deleteObjects` 等新增原语在 SDK 层用驼峰，RPC 层用蛇形。

> 软链相关原语（`createSymlink`/`resolveSymlink`/`atomicRepoint`/`renameSymlink`/`deleteSymlink`）见 `topics/symlink.md`——它们作用于元数据库的 symlinks 表，不是对象存储 RPC，独立一套。

### 卷（CLI / SDK / 后端）

**CLI**：`df <AID>:`（查卷状态）、`mount <AID>:<path> --volume <id>`（挂实体卷）、`umount`。虚拟卷挂载见 `topics/virtual-volume.md`。

**SDK**：

```
storage.getVolumes({ ownerAid, requesterAid })
  → [{ volumeId, size, used, avail, status, expires, mountPoint }]
storage.mountVolume({ ownerAid, mountPoint, volumeId, requesterAid })
storage.umountVolume({ ownerAid, mountPoint, requesterAid })
```

**后端**：

```sql
CREATE TABLE volumes (
  volume_id    TEXT PRIMARY KEY,
  owner_aid    TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  used_bytes   BIGINT NOT NULL DEFAULT 0,
  mount_point  TEXT,             -- 当前挂载点（null = 未挂载）；一卷当前最多挂一个点，可 umount 后重挂别处
  status       TEXT NOT NULL,    -- active | grace | expired
  expires_at   TIMESTAMP,
  created_at   TIMESTAMP
);
```

### CAS（条件写入）——跨两半的关键

对象的 CAS（`expected_version`）：OSS 层的 `storage.put_object`/`complete_upload` 已实现（fastaun 0.4.2 已有），version 随每次写入递增。

软链的 CAS（`atomicRepoint`）：DB 层的原子 UPDATE，见 `topics/symlink.md`。

两者共同支撑 collab 乐观锁的正确性——不能只有其中一个。

### 命令可支持性边界

🟢 原生/廉价　🟡 有代价/受限　🔴 贵或难　❌ 不可行。**判据：只碰 key 与元数据的操作廉价，必须碰对象内容的操作昂贵。**

| 命令 | 支持性 | 说明 |
|------|:---:|------|
| `ls` `stat` `head` `df` `find`（元数据过滤） | 🟢 | 只碰 key/元数据，LIST 就够 |
| `cat` | 🟢 | 文本直接返回；二进制返元数据+头部256字节 |
| `cp` `rm` | 🟢 | `rm -r` = list + 批量 DELETE；跨主机 `cp` 走服务端 copy |
| `ln -s` | 🟢 | DB 一行指针，不存 OSS |
| `mkdir` | 🟡 | 无真目录，写零字节标记对象或 no-op |
| `du` `tree` | 🟡 | LIST + 累加，O(n)，大目录有延迟 |
| `mv` | 🟡 | 小指针（改 DB 一行，廉价）；大真实文件（copy+delete，不原子） |
| `chmod` `setfacl` `token` | 🟡 | DB 写 ACL/token 元数据 |
| `grep`（单文件） | 🟡 | 下载单文件本地扫描，代价可控 |
| `grep -r`（递归） | 🔴 | **显式拒绝**：报错「请缩小到单文件，或申请全文索引服务」 |
| `sed -i` / 原地编辑 / `truncate` | 🔴 | 对象不可原地改，须整体重写 |
| `tail -f` | ❌ | 无追加流，需事件总线另案 |
| `ln`（硬链接）`chown` | ❌ | 无对应概念 |

> `sort`/`uniq`/`awk`/`sed`（非 -i）是管道工具，不是 fs 操作，不进 `ec fs`。

### 现状对照与补齐优先级（fastaun 0.4.2）

| 能力 | 现状 | 优先级 |
|------|:---:|:---:|
| 对象 CRUDL + 分页 | ✅ | — |
| 对象级 CAS（expected_version） | ✅ | — |
| 自定义元数据 | ✅ | — |
| 配额查询 | ✅ | — |
| 变更事件通知 | ✅ | — |
| 软链原语（DB 指针 + atomicRepoint） | ❌ | P0 最高 |
| 细粒度 ACL（setfacl） | ❌ | P1 |
| 虚拟卷跨主体挂载 + 挂载表 | ❌ | P1 |
| 服务端 copy（copy_object） | ❌ | P2 |
| 卷生命周期（grace/expired） | ❌ | P2 |
| 通用 token（HTTP Bearer + 吊销 + 列举） | 🟡 仅下载 ticket | P2 |
