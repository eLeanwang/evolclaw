# 20 · 文件层（ec fs）

> 权限/ACL/token 见 `topics/acl-auth.md`，软链机制见 `topics/symlink.md`，虚拟卷挂载见 `topics/virtual-volume.md`，群共享空间见 `topics/group-space.md`。

---

## 【使用】

`ec fs` 是个人空间和群空间的统一入口。群空间也使用 `ec fs <command> <group-aid>:<path>`，不再提供独立的 `ec group fs` 产品入口。

远程路径统一写作 `<AID>:<absolute-path>`。无 `:` 的路径按本地路径处理。

### 命令总表

| 命令 | 用途 | 支持性 |
|------|------|:---:|
| `ls <AID>:<path>` | 列目录 | 🟢 |
| `stat [-L] <AID>:<path>` | 查看节点元数据；默认不跟随软链，`-L` 跟随 | 🟢 |
| `lstat <AID>:<path>` | 查看节点本身 | 🟢 |
| `cat <AID>:<path>` | 查看文本；二进制/大文件返回头部摘要 | 🟢 |
| `cp <src> <dst>` | 上传/下载/远程复制 | 🟢 |
| `mv <src> <dst>` | 移动/改名 | 🟢 |
| `rm [-r] <AID>:<path>` | 删除文件或目录 | 🟢 |
| `mkdir [-p] <AID>:<path>` | 创建目录 | 🟢 |
| `ln -s <src> <dst>` | 创建软链 | 🟡 |
| `find <AID>:<path> [过滤]` | 查找 | 🟢 |
| `chmod <AID>:<path> [opts]` | 改可见性/角色约束 | 🟡 |
| `setfacl -m|-x <AID>:<path>` | 细粒度 AID 授权 | 🟡 |
| `getfacl <AID>:<path>` | 查看 ACL | 🟡 |
| `token issue|revoke|ls <path>` | 访问令牌管理 | 🟡 |
| `df <AID>:` | 查卷容量 | 🟢 |
| `mount <target> --volume|--source` | 挂载卷/虚拟卷 | 🟢 |
| `umount <target>` | 卸载 | 🟢 |
| `approve|reject <target>` | 审批挂载请求 | 🟡 |

支持性说明：

- 🟢：personal 和 group 当前路由都已接入，或该命令本身不区分两者。
- 🟡：仅 personal storage 已接入；group fs facade 当前没有对应接口。

通用选项：`--as <aid>`（操作者身份）、`--format json`（结构化输出）、`-r`（递归，用于 `rm/cp`）、`--token <tok>`（personal 读取访问令牌）。

**已取消**：`ec drive`（本地磁盘映射）已取消，见 `00-overview.md` §5。

---

### cp：上传/下载/远程复制

有 `:` 是远程，无 `:` 是本地：

```bash
ec fs cp ./local.txt alice.agentid.pub:/docs/f.txt
ec fs cp alice.agentid.pub:/docs/f.txt ./local.txt
ec fs cp alice.agentid.pub:/x bob.agentid.pub:/refs/x
```

远程到远程复制要求两端路由到同一类后端：

- personal 到 personal：使用 `storage.copy`，可跨 owner。
- group 到 group：使用 `group.fs.cp`。
- personal/group 混合：当前不支持，需先下载到本地再上传。

---

### mv：移动/改名

```bash
ec fs mv alice.agentid.pub:/docs/a.md alice.agentid.pub:/docs/b.md
ec fs mv g-team.agentid.pub:/archive/a.md g-team.agentid.pub:/archive/b.md
```

限制：

- personal `mv` 使用 `storage.rename`，仅支持同 owner。
- personal 跨 owner `mv` 不具备原子语义，拒绝执行；可先 `cp`，确认后再 `rm`。
- group `mv` 使用 `group.fs.mv`。
- personal/group 混合 `mv` 不支持。

---

### cat：二进制文件行为

文本直接返回内容。二进制或超过 `--max-bytes` 的文件不返回原始字节流，而是返回元数据和文件头部编码片段：

```json
{
  "path": "alice.agentid.pub:/private/app.zip",
  "size": 10485760,
  "content_type": "application/zip",
  "binary": true,
  "head": { "encoding": "base64", "bytes": 256, "data": "UEsDBBQ..." }
}
```

`head.data` 默认取前 256 字节，可用 `--head-bytes <n>` 覆盖。取完整文件用 `cp` 下载。

group route 当前没有 range read 接口，`cat --head-bytes` 会先通过 `group.fs.cp` 取得 blob，再截取头部用于输出。

---

### find：元数据过滤

```bash
ec fs find g-team.agentid.pub:/memberdata/ --name .collab
ec fs find alice.agentid.pub:/ --type f --size +10M
ec fs find alice.agentid.pub:/ --mtime -7
ec fs find alice.agentid.pub:/public/ --type l
```

支持：`--name`（glob）、`--type f|d|l`、`--size +/-N`、`--mtime +/-N`（天）、`--page`、`--page-size`。

不支持 `-exec`、按内容匹配、或任何需要读取文件内容的过滤。

---

### ln -s：软链

**真实路径在前，软链路径在后**：

```bash
ec fs ln -s alice.agentid.pub:/private/identity/agent.md alice.agentid.pub:/public/agent.md
```

`-f` 用于重指已有软链；当前 personal 使用 `storage.repoint`。group fs facade 暂无 symlink/repoint 接口，群 AID 上返回 `UNSUPPORTED`。

---

### 对外发布与分享

当前发布、ACL 和 token 能力只接 personal storage。

```bash
ec fs ln -s alice.agentid.pub:/private/report.pdf alice.agentid.pub:/public/report.pdf
ec fs chmod +r alice.agentid.pub:/public/report.pdf
ec fs token issue alice.agentid.pub:/public/report.pdf --expires 2026-12-01
ec fs token revoke alice.agentid.pub:/public/report.pdf --token tok_abc123
ec fs ls alice.agentid.pub:/public/
```

group fs facade 当前没有 `ln`、`chmod`、`setfacl`、`getfacl`、`token` 接口。

---

### 卷与挂载

```bash
ec fs df alice.agentid.pub:
ec fs mount alice.agentid.pub:/archive --volume vol_abc123
ec fs mount g-team.agentid.pub:/memberdata/alice/ --source alice.agentid.pub:/group-data/g-team/
ec fs umount alice.agentid.pub:/archive
```

`mount` 支持 `--volume <id>` 和 `--source <AID>:<path>` 二选一，默认只读，可用 `--readwrite` 切换。

personal route 使用 `storage.mount` / `storage.mountVolume`。group route 使用 `group.fs.mount`。

`approve` / `reject` 当前只接 personal storage 的挂载审批接口。

---

### 端到端场景串烧

从上传文件到发布到分享的完整流程：

```bash
ec fs cp ./report-v2.pdf alice.agentid.pub:/private/reports/report-v2.pdf

ec fs ln -s alice.agentid.pub:/private/reports/report-v2.pdf \
            alice.agentid.pub:/public/report.pdf

ec fs chmod +r alice.agentid.pub:/public/report.pdf

ec fs token issue alice.agentid.pub:/public/report.pdf \
  --expires 2026-12-31 --max-reads 20

ec fs cat alice.agentid.pub:/public/report.pdf --token tok_abc123

ec fs cp ./report-v3.pdf alice.agentid.pub:/private/reports/report-v3.pdf
ec fs ln -sf alice.agentid.pub:/private/reports/report-v3.pdf \
             alice.agentid.pub:/public/report.pdf

ec fs rm alice.agentid.pub:/public/report.pdf
```

发现群内协作并参与：

```bash
ec fs find g-team.agentid.pub:/memberdata/ --name .collab
ec fs cat alice.agentid.pub:/group-data/g-team/projects/myapp/.collab
ec collab ls alice.agentid.pub:/group-data/g-team/projects/myapp
ec collab read alice.agentid.pub:/group-data/g-team/projects/myapp spec.md
ec collab submit alice.agentid.pub:/group-data/g-team/projects/myapp \
  spec.md ./spec-edited.md --base-version 5
```

---

### 与旧命令的对应

| 旧入口 | ec fs 等价 |
|--------|-----------|
| `ec storage upload <aid> ./f path` | `ec fs cp ./f <aid>:/<path>` |
| `ec storage ls <aid> prefix/` | `ec fs ls <aid>:/<prefix>/` |
| `ec storage rm <aid> path` | `ec fs rm <aid>:/<path>` |
| `ec storage quota <aid>` | `ec fs df <aid>:` |
| 旧群文件入口 | `ec fs <group-aid>:<path>` |

---

## 【实现】

### CLI 实现者

**参数来源**：每条命令的 `<AID>:<path>` 参数由用户/agent 提供，或来自上一条命令响应里回吐的完整 `<aid>:<path>`。所有响应应回吐完整 `<aid>:<path>`，便于 agent 原样用于下一条命令。

**操作者身份**：

- `--as <aid>`：显式指定，最高优先。
- `EVOLCLAW_SELF_AID`：daemon 注入，agent 会话内可省略 `--as`。
- 两者都缺失时：报错，提示使用 `--as`。

**路由判定**：解析目标 AID 的 `agent.md` type 字段；`type: group` 走群文件后端，其余走 personal storage。读取失败时先按 personal storage 尝试，并在 route 信息里保留 warning。

**失败响应格式**：

```text
✗ <错误描述>
  <self-contained 的下一步提示，含所有需要的参数>
```

权限错误由后端判定。CLI 不自行模拟 ACL、角色或群成员关系。

### 后端适配

personal backend 使用 `client.storage` / `StorageVFS`：

- `ls/stat/lstat/cat/cp/mv/rm/mkdir/find/df`
- `ln/chmod/setfacl/getfacl/token`
- `mount/approve/reject/umount`

group backend 使用 `client.group.fs` / `GroupFSVFS`：

- `ls/find/stat/lstat/mkdir/rm/cp/mv/df/mount/umount`
- `cat` 通过 `group.fs.stat` + `group.fs.cp` 到 blob 适配

group backend 当前不适配 `ln/chmod/setfacl/getfacl/token/approve/reject`，因为 SDK facade 没有对应接口。

### 输出要求

`--format json` 输出需要稳定，至少包含：

- `command`
- `backend`
- `route`
- 完整远程路径
- 节点元数据、列表项或操作结果

人类可读输出可以简洁，但不能丢失关键路径信息。
