# ec fs — AUN 文件系统设计

## 一句话

AID 就是主机，`ec fs` 就是 `scp` + `sshfs`，但操作的是 AUN 网络上的任何 AID。

---

## 核心概念

### AID = 主机

AID（Agent Identifier）在文件系统语境下就是一个网络主机：

```
toleiliang5.agentid.pub   →  个人主机
group.agentid.pub         →  群主机（issuer 域）
g-myteam.agentid.pub      →  命名群主机（也是 AID）
```

### 路径格式

```
<AID>:/<path>
```

继承自 `scp`/`rsync` 的 `host:path` 范式，Unix 世界 40 年历史，大模型 100% 熟悉。

| 语义 | 写法 |
|------|------|
| 个人文件 | `toleiliang5.agentid.pub:/docs/notes.md` |
| 群文件 | `group.agentid.pub:/12345/周报/W24.md` |
| 命名群文件 | `g-myteam.agentid.pub:/设计/首页.png` |

> `:` 左边是主机（AID），右边是主机上的路径。
> 群路径中 `:` 右边第一个分段 `/12345` 是群编号，之后是文件目录。

---

## 命令集

### 基础命令（对标 Linux 文件命令）

| 命令 | Linux 语义 | ec fs 用法 | 说明 |
|------|-----------|-----------|------|
| `ls` | 列出目录 | `ec fs ls <AID>:<path>` | 查看目录内容 |
| `cat` | 查看文件 | `ec fs cat <AID>:<path>` | 查看文件元数据/下载方式 |
| `cp` | 复制文件 | `ec fs cp <src> <dst>` | 上传或下载 |
| `mv` | 移动/改名 | `ec fs mv <AID>:<old> <AID>:<new>` | 重命名或移动 |
| `rm` | 删除 | `ec fs rm <AID>:<path>` | 删除文件或目录 |
| `mkdir` | 建目录 | `ec fs mkdir <AID>:<path>` | 创建目录 |
| `chmod` | 改权限 | `ec fs chmod <AID>:<path>` | 修改可见性/标签 |

### cp 的两种方向

```bash
# 上传：本地 → 远程 AID
ec fs cp ./local-file.txt toleiliang5.agentid.pub:/docs/file.txt
          ↑本地文件            ↑远程路径

# 下载：远程 AID → 本地
ec fs cp toleiliang5.agentid.pub:/docs/file.txt ./local-file.txt
          ↑远程路径              ↑本地文件
```

### chmod 的参数

```bash
ec fs chmod group.agentid.pub:/12345/设计/首页.png --visibility public
ec fs chmod group.agentid.pub:/12345/设计/首页.png --tags "设计稿,已评审"
```

---

## 底层存储

`ec fs` 统一了两种底层存储，但对用户透明：

| 操作主体 | 底层存储 | 权限模型 |
|---------|---------|---------|
| 个人 AID 操作自己的文件 | **Storage**（个人云盘） | 仅自己可写；公开文件可读 |
| 群成员操作群的文件 | **Resource**（群资源系统） | member 可 ls/cat/cp/mkdir；admin+ 可 mv/rm/chmod；owner 可审批 |

**agent 不需要知道底层是 Storage 还是 Resource**，只需要知道：

> AID 是谁的，就按谁的权限规则来。

---

## 权限模型

| 角色 | ls | cat | cp | mkdir | mv | rm | chmod | approve/reject |
|------|----|-----|----|-------|----|----|-------|---------------|
| member | ✅ | ✅ | ✅（上传） | ✅ | ❌ | ❌ | ❌ | ❌ |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 外部（公开文件） | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

### 审批流程（仅 owner）

不熟悉 Linux 的成员也可以在群里操作。owner 可设置审批模式，此时普通 member 的上传需要 owner 批准：

```bash
ec fs approve group.agentid.pub:/12345 --request-id req_xxx
ec fs reject  group.agentid.pub:/12345 --request-id req_xxx --note "需要脱敏"
```

---

## 与现有命令的关系

| 现有命令 | 新 `ec fs` 的关系 |
|---------|------------------|
| `ec storage` | 个人场景被 `ec fs` 覆盖，保留作为底层调试用 |
| `ec group resource` | 群场景被 `ec fs` 覆盖，保留作为底层调试用 |

`ec fs` 是面向 agent 的统一前端，`ec storage`/`ec group resource` 是底层命令，日常场景 agent 只用 `ec fs`。

---

## 设计原则

1. **零学习成本** — 大模型都懂 `scp`/`ls`/`cat`/`cp`/`mv`/`rm`/`mkdir`/`chmod`
2. **AID = 主机** — 不需要额外概念，AID 就是地址
3. **`:` = 远程** — `scp` 协议继承来的语义
4. **底层透明** — agent 不关心 Storage 还是 Resource，只说 AID 和路径

---

## 例子

```bash
# 个人文件操作
ec fs ls toleiliang5.agentid.pub:/docs/
ec fs cp ./notes.md toleiliang5.agentid.pub:/docs/notes.md

# 群文件操作
ec fs ls group.agentid.pub:/12345/设计/
ec fs cp ./wireframe.png group.agentid.pub:/12345/设计/首页-v3.png
ec fs cat group.agentid.pub:/12345/设计/首页-v3.png
ec fs cp group.agentid.pub:/12345/设计/首页-v3.png ./local-copy.png

# 访问他人的公开文件
ec fs ls bob.agentid.pub:/public/
ec fs cat bob.agentid.pub:/public/resume.md
```
