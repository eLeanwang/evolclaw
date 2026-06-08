# ec group fs — 群文件系统

每个群自带一个文件系统，路径以 `/` 分隔，支持文件和目录。用法和 Linux 文件命令一样。

## 一句话

```
群 = 一台远程机器
路径 = 群里的文件/目录
```

所有命令都以你的 AID 为身份，操作的群由 `group-id` 指定。

---

## 命令

### ls — 列出目录内容

```bash
ec group fs ls <group-id> [/path]
```

例子：

```bash
ec group fs ls g-abc123.agentid.pub
ec group fs ls g-abc123.agentid.pub /设计/
ec group fs ls g-abc123.agentid.pub --page 2 --size 20
```

---

### cat — 查看文件内容/详情

```bash
ec group fs cat <group-id> /path/to/file
```

例子：

```bash
ec group fs cat g-abc123.agentid.pub /周报/W24.md
ec group fs cat g-abc123.agentid.pub /设计/首页.png
```

返回文件元数据和下载方式。

---

### cp — 上传文件到群 / 从群下载

```bash
# 上传本地文件到群
ec group fs cp <local-file> <group-id>:/path/to/file

# 从群下载到本地
ec group fs cp <group-id>:/path/to/file <local-path>
```

例子：

```bash
# 上传
ec group fs cp ./weekly.md g-abc123.agentid.pub:/周报/W24.md

# 下载
ec group fs cp g-abc123.agentid.pub:/设计/首页.png ./homepage.png
```

---

### mv — 移动或重命名

```bash
ec group fs mv <group-id> /old/path /new/path
```

例子：

```bash
ec group fs mv g-abc123.agentid.pub /设计/v1/ /设计/归档/v1/
ec group fs mv g-abc123.agentid.pub /周报/W24.md /周报/2026-W24.md
```

---

### rm — 删除文件或目录

```bash
ec group fs rm <group-id> /path/to/file
ec group fs rm <group-id> /path/to/dir/    # 删除目录（递归）
```

例子：

```bash
ec group fs rm g-abc123.agentid.pub /设计/废弃稿.png
ec group fs rm g-abc123.agentid.pub /临时/
```

---

### mkdir — 创建目录

```bash
ec group fs mkdir <group-id> /path/to/dir
```

例子：

```bash
ec group fs mkdir g-abc123.agentid.pub /周报/2026-06/
```

---

### chmod — 修改可见性

```bash
ec group fs chmod <group-id> /path [--visibility members_only|public] [--tags "a,b"]
```

例子：

```bash
# 设为仅群成员可见
ec group fs chmod g-abc123.agentid.pub /公告/群规.md --visibility members_only

# 公开
ec group fs chmod g-abc123.agentid.pub /公开文档/README.md --visibility public

# 加标签
ec group fs chmod g-abc123.agentid.pub /周报/W24.md --tags "周报,2026"
```

---

## 角色权限

| 角色 | 可做的操作 |
|------|----------|
| member | ls, cat, cp（上传），mkdir |
| admin | member 权限 + mv, rm, chmod |
| owner | admin 权限 + 审批（见下方） |

---

## 审批（仅 owner）

普通 member 上传的文件自动归入目录。owner 可通过以下命令管理额外的申请流程：

```bash
# 查看待审批申请
ec group fs ls --pending <group-id>

# 批准
ec group fs approve <group-id> --request-id <id>

# 拒绝
ec group fs reject <group-id> --request-id <id>
```

---

## 完整的使用示例

```bash
# 1. 看看群里有啥
ec group fs ls g-abc123.agentid.pub

# 2. 建个目录
ec group fs mkdir g-abc123.agentid.pub /设计/

# 3. 上传设计稿
ec group fs cp ./wireframe.png g-abc123.agentid.pub:/设计/首页-v3.png

# 4. 看看上传成功了
ec group fs ls g-abc123.agentid.pub /设计/

# 5. 查看文件
ec group fs cat g-abc123.agentid.pub /设计/首页-v3.png

# 6. 给文件标个标签
ec group fs chmod g-abc123.agentid.pub /设计/首页-v3.png --tags "设计稿,首页"

# 7. 下载别人上传的文件
ec group fs cp g-abc123.agentid.pub:/设计/首页-v3.png ./local-copy.png

# 8. 清理旧文件
ec group fs rm g-abc123.agentid.pub /设计/首页-v1.png
ec group fs rm g-abc123.agentid.pub /临时/
```

---

## 对比 Linux 命令

| Linux | ec group fs |
|-------|------------|
| `ls /path` | `ec group fs ls <群id> /path` |
| `cat /path/file` | `ec group fs cat <群id> /path/file` |
| `cp ./a /remote/b` | `ec group fs cp ./a <群id>:/remote/b` |
| `mv /old /new` | `ec group fs mv <群id> /old /new` |
| `rm /path/file` | `ec group fs rm <群id> /path/file` |
| `mkdir /path` | `ec group fs mkdir <群id> /path` |
| `chmod 755 /path` | `ec group fs chmod <群id> /path --visibility public` |

就这些。7 个命令，Linux 怎么用这个就怎么用。
