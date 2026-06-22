# 20 · 文件层（ec fs）

> 权限/ACL/token 见 `topics/acl-auth.md`，软链机制见 `topics/symlink.md`，虚拟卷挂载见 `topics/virtual-volume.md`，群共享空间见 `topics/group-space.md`。

---

## 【使用】

### 命令总表

| 命令 | 用途 | 支持性 |
|------|------|:---:|
| `ls <AID>:<path>` | 列目录 | 🟢 |
| `cat <AID>:<path>` | 查看文件（二进制返元数据） | 🟢 |
| `cp <src> <dst>` | 上传/下载/跨主机复制 | 🟢 |
| `mv <src> <dst>` | 移动/改名 | 🟡 |
| `rm [-r] <AID>:<path>` | 删除 | 🟢 |
| `mkdir <AID>:<path>` | 创建目录 | 🟡 |
| `ln -s <src> <dst>` | 创建软链 | 🟢 |
| `find <AID>:<path> [过滤]` | 查找 | 🟢 |
| `chmod <AID>:<path> [opts]` | 改权限/可见性 | 🟡 |
| `setfacl -m|-x <AID>:<path>` | 细粒度 AID 授权 | 🟡 |
| `token issue|revoke|ls <path>` | 访问令牌管理 | 🟡 |
| `df <AID>:` | 查卷容量 | 🟢 |
| `mount <target> --volume|--source` | 挂载卷/虚拟卷 | 🟡 |
| `umount <target>` | 卸载 | 🟡 |
| `approve|reject --request-id` | 审批挂载/上传 | 🟡 |

通用选项：`--format json`（结构化输出）、`-r`（递归，用于 rm/cp）、`--token <tok>`（携带访问令牌）。
命令可支持性完整表（🟢🟡🔴❌）见 `10-storage.md`。

**已取消**：`ec drive`（本地磁盘映射）已取消，见 `00-overview.md` §5。

---

### cp：上传/下载/跨主机

有 `:` 是远程，无 `:` 是本地：

```bash
ec fs cp ./local.txt alice.agentid.pub:/docs/f.txt     # 上传
ec fs cp alice.agentid.pub:/docs/f.txt ./local.txt     # 下载
ec fs cp a.agentid.pub:/x bob.agentid.pub:/refs/x      # 跨主机（服务端 copy，不经本地）
```

---

### cat：二进制文件行为

文本直接返回内容。二进制不返回原始字节流（污染终端），而是返回元数据 + 文件头部编码片段：

```json
{
  "path": "alice:/private/app.zip", "size": 10485760, "mime": "application/zip",
  "binary": true,
  "head": { "encoding": "base64", "bytes": 256, "data": "UEsDBBQ..." }
}
```

`head.data` 默认前 **256 字节**（base64，覆盖几乎所有常见格式魔数，含偏移靠后的 TAR `ustar@257`）。可用 `--head-bytes <n>` 覆盖。取完整文件用 `cp` 下载。

---

### find：元数据过滤

```bash
ec fs find g-team:/memberdata/ --name .collab       # 按名（发现协作锚点）
ec fs find alice:/ --type f --size +10M              # 按大小
ec fs find alice:/ --mtime -7                        # 按修改时间（7天内）
ec fs find alice:/public/ --type l                   # 只列软链（type=l）
```

支持：`--name`（glob）、`--path`（路径模式）、`--type f|d|l`、`--size +/-N`、`--mtime +/-N`（天）。
**不支持** `-exec` 对内容操作 / 按内容匹配（需碰内容的操作不在 find 范围）。

---

### ln -s：软链（详见 `topics/symlink.md`）

**真实路径在前，软链路径在后**：

```bash
# ✅ 正确
ec fs ln -s alice:/private/identity/agent.md  alice:/public/agent.md
# ❌ 错误（方向反了）
ec fs ln -s alice:/public/agent.md  alice:/private/identity/agent.md
```

`-f` 原子重指已有软链。

---

### 对外发布与分享（详见 `topics/acl-auth.md`）

```bash
# 发布：软链进 /public + 设权限
ec fs ln -s alice:/private/report.pdf  alice:/public/report.pdf
ec fs token issue alice:/public/report.pdf --expires 2026-12-01  # 签发 token

# 撤销
ec fs rm alice:/public/report.pdf          # 删软链（不动真实文件）
ec fs token revoke alice:/public/x --token tok_abc123

# 查看已分享的内容
ec fs ls -l alice:/public/                 # 不需要专门的 shares 命令
```

---

### 卷与挂载（简要，详见 `10-storage.md` 和 `topics/virtual-volume.md`）

```bash
ec fs df alice:                                        # 查主机卷状态
ec fs mount alice:/archive --volume vol_abc123         # 挂实体卷
ec fs mount g-team:/memberdata/alice/ --source alice.agentid.pub:/group-data/g-team/   # 虚拟卷
ec fs umount alice:/archive
```

---

### 端到端场景串烧

从上传文件到发布到分享的完整流程：

```bash
# 1. 上传文件到私有区
ec fs cp ./report-v2.pdf alice.agentid.pub:/private/reports/report-v2.pdf

# 2. 对外发布（软链进 /public，物理文件不动）
ec fs ln -s alice.agentid.pub:/private/reports/report-v2.pdf \
            alice.agentid.pub:/public/report.pdf
# → https://alice.agentid.pub/report.pdf 现在可访问（但默认私有，需授权）

# 3a. 公开给所有人
ec fs chmod +r alice.agentid.pub:/public/report.pdf

# 3b. 或：签发带期限的 token 给特定人
ec fs token issue alice.agentid.pub:/public/report.pdf \
  --expires 2026-12-31 --max-reads 20
# CLI 访问：ec fs cat alice.agentid.pub:/public/report.pdf --token tok_abc123
# HTTP 访问：GET https://alice.agentid.pub/report.pdf  Authorization: Bearer tok_abc123

# 4. 更新文件，切换发布版本（软链重指，URL 不变）
ec fs cp ./report-v3.pdf alice.agentid.pub:/private/reports/report-v3.pdf
ec fs ln -sf alice.agentid.pub:/private/reports/report-v3.pdf \
             alice.agentid.pub:/public/report.pdf

# 5. 撤销分享（删软链，原文件不动）
ec fs rm alice.agentid.pub:/public/report.pdf
```

发现群内协作并参与：

```bash
# 1. 发现群内协作项目（查注册表，不扇出各成员卷）
ec fs find g-team.agentid.pub:/memberdata/ --name .collab

# 2. 读 .collab 拿 collabRoot（root 字段）
ec fs cat alice.agentid.pub:/group-data/g-team/projects/myapp/.collab

# 3. 列协作文档（用 collab ls，不用裸 fs ls 猜后缀）
ec collab ls alice.agentid.pub:/group-data/g-team/projects/myapp

# 4. 读当前版本（拿 version 号，用于 submit 的 --base-version）
ec collab read alice.agentid.pub:/group-data/g-team/projects/myapp spec.md

# 5. 编辑后提交
ec collab submit alice.agentid.pub:/group-data/g-team/projects/myapp \
  spec.md ./spec-edited.md --base-version 5
```

---

### 与旧命令的对应

| 旧命令 | ec fs 等价 |
|--------|-----------|
| `ec storage upload <aid> ./f path` | `ec fs cp ./f <aid>:<path>` |
| `ec storage ls <aid> prefix/` | `ec fs ls <aid>:/<prefix>/` |
| `ec storage rm <aid> path` | `ec fs rm <aid>:<path>` |
| `ec storage quota <aid>` | `ec fs df <aid>:` |
| `ec group fs ls <gid> /path` | `ec fs ls <gid>:<path>` |

---

## 【实现】

### CLI 实现者

**参数来源**：每条命令的 `<AID>:<path>` 参数由用户/agent 提供，或来自上一条命令响应里回吐的完整 `<aid>:<path>`。所有响应**必须回吐完整 `<aid>:<path>`**——agent 原样用于下一条命令，无需拼接。

**操作者身份**：
- `--as <aid>`（显式，最高优先）
- `EVOLCLAW_SELF_AID` 环境变量（daemon 注入，agent 会话内省略 `--as`）
- 两者都缺 → 报错，提示使用 `--as`

**路由判定**（内部）：解析目标 AID 的 `agent.md` type 字段 → `group` 走群资源，其余走 personal storage。

**失败响应格式**（所有命令统一）：
```
✗ <错误描述>
  <self-contained 的下一步提示，含所有需要的参数>
```
若是权限错误，提示包含「联系 <授权方>执行哪条命令」。

**mv 的实现逻辑**：
- 若源是软链 → DB 更新 key（改名，廉价，原子）
- 若源是真实对象 → `copy_object + delete_object`（不原子，大文件昂贵，输出警告）
- 跨主机 mv 拒绝（无法服务端原子移动），提示用 `cp + rm`

**`rm -r` 实现**：list_objects(prefix) 分页 → 批量 delete_objects（后端支持批量的话一次调用）

### SDK 设计者

fs 命令对应的 SDK 方法都在 `10-storage.md` 的 SDK 小节中定义，不在此重复。fs 层是这些方法的**有序编排**（鉴权 → 路由判定 → 调对应方法 → 格式化输出）。

额外的 fs 层编排逻辑（不在单一 storage API 中）：

```
// cat 二进制探测
1. headObject → 取 mime
2. mime 属文本类型 → getObject
3. mime 属二进制 → getRangeBytes(offset=0, length=256) → 返回元数据+head

// cp 跨主机
1. 检查 src 和 dst 是否同一后端 → 是 → copyObject（服务端 copy）
2. 不同后端 → getObject(src) → putObject(dst)（经客户端中转，输出提示）
```

### AUN 后端实现者

fs 层的每条命令最终调用 `10-storage.md` 里定义的 RPC 方法。后端需要额外支持的（不在单一 put/get/list 中）：

1. **批量删除**（`rm -r` 效率）：提供 `storage.deleteObjects({ownerAid, keys: [...]})` 批量 RPC。
2. **服务端 copy**（跨主机 cp 效率）：提供 `storage.copyObject`，见 `10-storage.md` P2 优先级。
3. **目录标记**（mkdir）：OSS 无真目录，后端可选：① 写零字节 key `<path>/.keep`；② 纯 no-op（list prefix 即可探测存在性）。建议选②，不引入噪声对象。
