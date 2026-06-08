# ec fs — AUN 网络文件系统：系统全景

> 本文是 `ec fs` 的**完整架构设计**。面向 agent 的精简操作手册见 `fs.md`。

## AID 是什么

AID 同时是三样东西：**密码学身份**、**Linux 主机**、**Web 主机**。整套文件系统从这里推导出来。

| 身份 | 含义 | 体现 |
|------|------|------|
| 身份（Identity） | 密码学鉴权主体 | X.509 证书链鉴权；权限/授权/分享都绑定到 AID |
| Linux 主机（Host） | 可挂盘、有目录树的远程机器 | `<AID>:<path>` 寻址，`ec fs` 全部命令作用于此 |
| Web 主机（Web Host） | 一个二级域名站点 | `https://<AID>/` ←→ `<AID>:/public/` |

所以 **`ec fs` 就是 `scp` + Linux 文件命令**——把 AID 当远程机器，用所有人都熟的 `ls`/`cat`/`cp`/`mv`/`rm`/`mkdir`/`ln`/`chmod`/`df` 操作它。用 Linux 命令操作（主机身份），按 AID 鉴权（密码学身份），软链进 `/public` 即对外发布（Web 身份）——这是整套设计唯一的认知入口，没有第二套词汇。

---

## 1. 寻址模型

### 1.1 统一格式

```
<AID>:<path>
```

继承 `scp`/`rsync` 的 `host:path` 范式：`:` 左边是主机（AID），右边是该主机上的 Unix 风格绝对路径。本地路径就是不带 `:` 的普通路径。

### 1.2 三种主机

| 类型 | 写法 | 解析方式 | 后端 |
|------|------|---------|------|
| 个人 AID | `alice.agentid.pub:/docs/f.txt` | 泛域名解析 | personal storage |
| 命名群 | `g-team.agentid.pub:/设计/x.png` | 泛域名解析（与普通 AID 无异） | group resource |
| 数字群 | `group.agentid.pub:/12345/x.png` | 群固定域名服务器 | group resource |

### 1.3 数字群与命名群的关系

群分两种，但底层逻辑统一在**数字群**上：

- **命名群** `g-team.agentid.pub`：和普通 AID 完全一样，走泛域名解析，本身就是一个 AID。
- **数字群** `group.agentid.pub/12345`：`group.agentid.pub` 是群专用固定域名（可换任意 AUN 网关域名），`12345` 是群编号。

关键等价关系：

```
group.agentid.pub:/12345/<path>   ≡   12345.agentid.pub:/<path>
```

即「`group.ap` 这台主机下的 `/12345` 路径」等效映射到「`12345.agentid.pub` 这台独立主机的根」。两种写法指向同一份数据，CLI 内部归一化处理。

### 1.4 操作者身份（--as）

`ec fs` 是一个 CLI 工具，任何外部程序都能调用，**进程本身没有「当前登录用户」的概念**。所以每条命令都必须知道「是谁在操作」——这个身份用来做密码学鉴权、权限判定、分享/授权归属。

操作者身份通过 `--as <self-aid>` 显式指定：

```bash
ec fs ls --as alice.agentid.pub  bob.agentid.pub:/public/
ec fs cp --as alice.agentid.pub  ./f.txt  alice.agentid.pub:/private/f.txt
```

| 来源 | 优先级 | 说明 |
|------|--------|------|
| `--as <aid>` 显式参数 | 1（最高） | 外部程序调用的标准方式 |
| `EVOLCLAW_SELF_AID` 环境变量 | 2 | daemon 启动 CLI 时注入，agent 会话内省略 `--as` 的依据 |

未设置任何来源时报错退出，提示使用 `--as`。

### 1.5 后端路由判定（CLI 内部）

确定操作者后，CLI 需要知道目标 AID 是个人还是群，以路由到对应后端。判定**不靠路径启发式**（不去猜「首段是不是数字」或试探 `group.get`），而是查目标 AID 的 **`agent.md` `type` 字段**——泛域名服务器据此字段判断主体类型并响应对应服务。

`type` 的取值与路由：

| `type` | 含义 | 路由后端 |
|--------|------|---------|
| `group` | 群 | 群 resource |
| `human` | 人类 | personal storage |
| `agent` | AI agent | personal storage |
| `host` | 非人非 agent 的节点（程序、嵌入式软件、evolclaw 自身等） | personal storage |

`host` 在文件系统语境下与个人 storage **行为完全一致**——它只是「既不是人也不是 agent」的 AUN 节点（如一段程序、嵌入式设备、evolclaw 进程本身的 AID），存储模型和个人 AID 没有区别。除 `group` 外的所有类型都走 personal storage。

判定流程：

1. 解析目标 AID，取其 `agent.md` 的 `type` 字段
2. `type == group` → 群 resource；数字群 `group.ap:/<id>/...` 形式下，路径首段为 group_id
3. 其余类型（`human`/`agent`/`host`） → personal storage

> 数字群与命名群的等价（`group.ap:/12345/` ≡ `12345.agentid.pub:/`）只是寻址写法的归一化，与类型判定无关——两种写法解析到的都是同一个 `type==group` 的 AID。

---

## 2. 主机内部结构

### 2.1 个人 AID 的目录基线

每个 AID 既是 Linux 主机，又是二级域名。主机根下有两个约定目录：

```
alice.agentid.pub:/
├── private/      # 私有区，外部不可见（默认所有数据落这里）
├── public/       # Web 根，软链/文件放这里才对外可见
└── <挂载点>/      # 额外挂载的卷（如 /archive/）
```

**默认私有，显式公开**：不在 `/public/` 下、也没软链进 `/public/` 的任何东西，永远不在网上可见。

### 2.2 群 AID 的目录结构

群是一个独立 AID，有自己的 storage。群解散则数据随之回收（服务商保留多久是策略问题）。群根目录：

```
12345.agentid.pub:/            （≡ group.agentid.pub:/12345/）
├── share/         # 协作区：仅放软链接，经 SDK→群服务器 RPC 操作（非普通读写）
├── announce/      # 公告区，仅 admin/owner 可写，成员可读
├── memberdata/    # 成员私有卷挂载区
│   ├── alice.aid.pub/   # alice 的卷挂载点，仅 alice 可写，成员可读
│   └── bob.aid.pub/     # bob 的卷挂载点
├── archive/       # 归档区，admin+ 可管理
└── public/        # 群对外 Web 根（→ https://<群AID>/），群服务器代写
```

| 目录 | 写 | 读 |
|------|----|----|
| `/share/` | 群主 + 管理员 + 群服务器接口 | 全体成员 |
| `/announce/` | admin + owner | 全体成员 |
| `/memberdata/<aid>/` | 仅该成员 | 全体成员（默认，可收窄） |
| `/archive/` | admin + owner | 全体成员 |
| `/public/` | 群主 + 管理员 + 群服务器接口 | 任何人（对外） |

**`/share/` 是协作区，里面只放软链接，普通成员无权写。** 软链接的创建与重指向只能由群主/管理员、或群服务器（经 AUN SDK 的 `collab.*` 接口调用群服务器 RPC）来完成；普通成员对 `/share/` 只读。真实文件数据仍在各成员的 `/memberdata/<aid>/` 卷里，`/share/` 只持有指向它们的软链接 + 版本号。

**`/public/` 是群对外 Web 根**，写入同样限群主/管理员 + 群服务器（群服务器暴露专门接口代写），对外任何人可读。

**核心设计：每个群成员在群主机上被分配一个卷，挂载到 `/memberdata/<自己的AID>/`。** 成员写自己的卷，物理隔离——任何人写不进别人的卷。这是「协作无写冲突」的物理基础。

`/memberdata/` 永不对群外暴露。要对外分享群内文件，必须经 `/public/` 或落到个人 storage（见第 6 节）。

---

## 3. 卷（Volume）机制

### 3.1 概念

```
AID（主机）
 ├── 默认卷    → 挂在 /（账户自带，随账户存在）
 ├── 卷 A 30G  → 挂在 /archive/
 └── 卷 B 100G → 挂在 /backup/
```

**AID = 主机，Volume = 磁盘分区，挂载点 = 目录。** 一台主机可挂多块盘，每块盘有独立容量和生命周期。卷由 AID 持有人开通（付费），服务商按容量计费。

每个卷的属性：

| 属性 | 说明 |
|------|------|
| `volume_id` | 卷唯一标识，如 `vol_abc123` |
| `size` | 容量上限，如 30G |
| `mount_point` | 挂载到主机的哪个目录 |
| `status` | `active` / `grace` / `expired` |
| `expires` | 授权期到期时间 |

### 3.2 生命周期

```
开通 → active（可读可写）
          │ 授权期到
          ▼
        grace（只读宽限期，服务商策略，如 3 个月）
          │ 宽限期到
          ▼
        expired（数据回收）
```

- **active**：正常读写。
- **grace**：授权期已过，转只读，可续费恢复 active。grace 时长由服务商定义，**是策略不是承诺**——`df` 中展示但标注非保证。
- **expired**：数据回收，不可访问。

续费延长授权期，自动回到 active。

### 3.3 挂载操作

**默认自动挂载**：开通一个卷后自动挂到默认路径，普通用户/agent 直接就能用，不需要任何额外操作。高阶用户才需要自定义挂载点。

```bash
# 把卷挂到指定目录（高阶，自定义）
ec fs mount <AID>:/archive --volume vol_abc123

# 解除挂载（不删数据，只解绑路径，可重新挂到别处）
ec fs umount <AID>:/archive

# 查看主机上所有卷及状态
ec fs df <AID>:
```

`df` 输出：

```
Filesystem           Size   Used  Avail  Status   Expires       Mounted on
alice.agentid.pub    5G     1G    4G     active   -             /
alice.agentid.pub    30G    12G   18G    active   2026-09-01    /archive/
alice.agentid.pub    50G    48G   2G     grace    2026-03-01*   /old-project/
```

`*` 标注 grace 宽限期（已过授权期，服务商宽限中，非保证）。

---

## 4. 文件系统 → 网址映射

### 4.1 核心映射

AID 既是 Linux 主机，又是二级域名。两个身份的接缝就是 `/public`：

```
<AID>:/public/          ←→  https://<AID>/
<AID>:/public/agent.md  ←→  https://<AID>/agent.md
<AID>:/public/x.png     ←→  https://<AID>/x.png
```

`/public` 是这台主机的 **Web 文档根**（类比 nginx 的 `/var/www/html`）。访问 `https://<AID>/<path>` 实际命中 `<AID>:/public/<path>`。

### 4.2 物理位置与对外网址解耦

文件**真实存哪**和**对外网址结构**彻底分离——靠软链接连接：

```bash
# agent.md 真实存在私有身份目录
alice.agentid.pub:/private/identity/agent.md

# 软链到 public 才对外可见
ec fs ln -s alice.agentid.pub:/private/identity/agent.md \
            alice.agentid.pub:/public/agent.md
```

访问 `https://alice.agentid.pub/agent.md` → 命中 `/public/agent.md` 软链 → 读到 `/private/identity/agent.md`。

好处：
- 真实文件怎么组织随意（按身份/版本/项目分目录），对外网址结构由 `/public` 下的软链单独规划
- 想换真实存储位置，改软链即可，网址不变
- 没软链进 `/public` 的东西永不对外可见——**默认私有，显式公开**

---

## 5. 软链接（ln -s）：贯穿全系统的核心原语

软链接是「指向另一个路径的小文件」，访问时自动跳转到真实文件（类比快捷方式）。它是本系统**对外暴露、稳定别名、群协作**三件事的统一底层原语。

```bash
ec fs ln -s <真实路径> <链接路径>      # 源在前，链接在后（同 cp/mv 方向）
ec fs ln -sf <真实路径> <链接路径>     # -f 覆盖已有软链（原子重指向）
```

三种用途，同一个机制：

| 用途 | 软链 | 真实数据在哪 |
|------|------|------------|
| 对外发布 | `/public/x → /private/真实文件` | 私有区 |
| 稳定别名 | `/releases/latest → /releases/v2.3.1` | 版本目录 |
| 群协作 | `/share/doc → /memberdata/某人/版本` | 成员各自的卷 |

跨主机软链接合法：

```bash
ec fs ln -s g-team.agentid.pub:/share/spec.md \
            alice.agentid.pub:/refs/team-spec.md
```

访问 `alice.../refs/team-spec.md` → CLI 解析软链 → 用 alice 身份去访问群文件。**权限不随软链传递**——软链只是入口，访问时仍按目标资源的真实权限校验（alice 必须本就有群访问权）。

---

## 6. 群协作机制

### 6.1 设计思想：把「锁问题」转化为「指针问题」

传统多人编辑同一文件要解决写锁/冲突。本系统换一个思路：

```
每个人写自己的卷（物理隔离，写入永不冲突）
        +
一个共享软链 latest 指向「当前权威版本」
        +
所有人通过软链读取
        ↓
发布 = 把软链重指向自己的版本（原子操作）
```

这是 Capistrano/Git 的 `current → releases/vX` 模式搬进群文件系统。写入永远成功（各写各卷），冲突只发生在「切指针」这一步，且**没有任何人的数据会丢**。

### 6.2 底层结构

以群里协作《设计文档》为例：

```
g-team.agentid.pub:/
├── share/
│   └── design.md ──→ /memberdata/alice.aid.pub/design/v2.md   # 软链 + 版本号
└── memberdata/
    ├── alice.aid.pub/design/v1.md, v2.md   # alice 历史版本
    └── bob.aid.pub/design/v2.md            # bob 基于 v1 改的版本
```

软链 `share/design.md` 携带一个**版本号**，每重指向一次 +1。

### 6.3 三文件模型（机制本质）

协作涉及**三个文件**，理解了它们的关系就理解了整套机制：

| 记号 | 文件 | 位置 | 角色 |
|------|------|------|------|
| **a** | 本地文件 | 本地磁盘 | 你正在编辑的工作副本 |
| **b** | 卷文件 | `/memberdata/<自己AID>/<doc>/vN.md` | 你的版本，物理存在你自己的卷里 |
| **c** | 共享软链 | `/share/<doc>` | 指向「当前权威版本」那个 b 的软链 + 版本号 |

完整数据流：

```
创建：  a ──cp──▶ b(v1) ──ln-sf──▶ c(version=1)

协作：  读 c（→ 指向某成员的 b）──cp──▶ 本地 a
        编辑 a
        a ──cp──▶ 自己的 b(vN) ──submit 切──▶ c(version+1)
```

- **写永远写自己的 b**，各成员卷物理隔离，永不冲突
- **c 只是软链**，所有人读 c 自动跳到当前权威版本的 b
- **发布 = 把 c 重指向自己的 b**（原子操作）

**可追溯性的硬规则：submit 每次写一个新版本号文件（`v1/v2/v3…` 单调递增），绝不覆盖旧文件。** 只要不覆盖，每个历史版本都完整留在各成员卷里，可随时回溯；一旦覆盖同名文件，那个历史即丢失。submit 同时在 c 的版本台账里记录「version → 指向的 b 路径 + 提交者 AID + 时间」，台账 + 不覆盖的 b 文件 = 完整可追溯历史。

### 6.4 SDK 协作接口（应用层封装）

协作是有状态的多步流程，封装成 SDK 接口比让 agent 裸拼 `ln -sf` 更稳。`group` + `path` 指向共享软链 c（如 `g-team.ap` + `/share/design.md`），`localFile` 是本地文件 a：

| 接口 | 作用 | 底层动作 |
|------|------|---------|
| `collab.create(group, path, localFile)` | 创建协作文件 | a→b(v1) → 建软链 c → version=1 |
| `collab.read(group, path)` | 读当前内容+版本号 | 顺 c→b 读，返回 `{content, version, currentTarget, author}` |
| `collab.submit(group, path, localFile, baseVersion)` | 提交新版本 | a→自己的 b(vN) → 版本检查 → 切 c |
| `collab.history(group, path)` | 查版本历史 | 读 c 的版本台账，返回各版本的 `{version, author, target, time}` |
| `collab.getVersion(group, path, version)` | 读指定历史版本 | 按台账定位该版本的 b，返回其内容 |
| `collab.diff(group, path, vA, vB)` | 比较两个版本 | 取 vA、vB 两个 b 的内容做差异比较 |

`submit` 的版本检查（乐观锁）：
- 把 `localFile` 写到提交者自己的 `memberdata/<self>/<doc>/vN.md`（**永不失败**）
- 检查软链 c 当前 version 是否仍等于 `baseVersion`
  - **相等** → c 重指向新文件，version+1，提交成功
  - **不等** → 提交失败，返回 `{ok:false, currentVersion, currentContent}`，要求重读-合并-重提交

### 6.5 协作时序

```
初始：share/design.md → alice/v1.md, version=1

① alice.read() → content_v1, version=1
② bob.read()   → content_v1, version=1

③ alice.submit(file, baseVersion=1)
     写 alice/v2.md ✓；version==1 ✓ → 软链→alice/v2, version=2；成功

④ bob.submit(file, baseVersion=1)
     写 bob/v2.md ✓（数据安全存下，不丢）
     version==1？当前已是 2 ✗ → 失败，返回 currentVersion=2 + alice 的 v2 内容

⑤ bob.read() → 拿 alice 的 v2 → 合并自己改动得 v3
   bob.submit(merged, baseVersion=2)
     version==2 ✓ → 软链→bob/v3, version=3；成功
```

这就是「基线版本变了就提交失败，重读-重改-重提交」的逻辑。

### 6.6 要点

| 特性 | 说明 |
|------|------|
| 写入永不失败 | 各写各卷，物理隔离；失败的只是「切指针」 |
| 数据永不丢 | 所有版本留在各自 memberdata，未被覆盖 |
| 版本号挂在软链上 | 不是文件属性；每次重指向 +1 |
| 历史可追溯 | submit 不覆盖、版本号递增；`collab.history/getVersion/diff` 查历史、读旧版、比差异（见 6.4） |
| 回滚 | 软链指回旧版的 b 即回滚 |
| 谁能发布 | 软链本身的写权限 = 发布权（见 6.7） |
| 合并在应用层 | 文件系统只管存储和指针，三方合并由 agent/人做 |

### 6.7 发布权 = 软链写权限

```bash
# 默认：全体成员可发布（小团队自由协作）
ec fs chmod g-team.agentid.pub:/share/design.md --allow-roles members

# 收紧：仅 admin 可发布（需审核的场景）
ec fs chmod g-team.agentid.pub:/share/design.md --allow-roles admin
```

「谁能切 latest 指针」= 「谁能发布权威版本」，用软链的权限位控制。

---

## 7. 命令集

全部对标 Linux 文件命令，语义一一对应。

| 命令 | Linux 语义 | ec fs 用法 |
|------|-----------|-----------|
| `ls` | 列目录 | `ec fs ls <AID>:<path>` |
| `cat` | 看文件 | `ec fs cat <AID>:<path>` |
| `cp` | 复制（上传/下载/跨主机） | `ec fs cp <src> <dst>` |
| `mv` | 移动/改名 | `ec fs mv <AID>:<old> <AID>:<new>` |
| `rm` | 删除 | `ec fs rm <AID>:<path>` |
| `mkdir` | 建目录 | `ec fs mkdir <AID>:<path>` |
| `ln -s` | 软链接 | `ec fs ln -s <真实路径> <链接路径>` |
| `chmod` | 改权限/可见性 | `ec fs chmod <AID>:<path> [opts]` |
| `setfacl` | 细粒度授权 | `ec fs setfacl -m aid:<AID>:r <path>` |
| `df` | 查容量 | `ec fs df <AID>:` |
| `mount` | 挂载卷 | `ec fs mount <AID>:<path> --volume <id>` |
| `umount` | 卸载卷 | `ec fs umount <AID>:<path>` |

### cp 的方向

由 `:` 的有无判定：有 `:` 是远程，无 `:` 是本地。

```bash
ec fs cp ./local.txt alice.agentid.pub:/docs/f.txt     # 上传
ec fs cp alice.agentid.pub:/docs/f.txt ./local.txt     # 下载
ec fs cp a.agentid.pub:/x g-team.agentid.pub:/share/x  # 跨主机
```

### 通用选项

| 选项 | 作用 |
|------|------|
| `--format json` | JSON 输出 |
| `-r` | 递归（rm/cp 目录） |
| `--public` | 上传即公开（仅个人 storage） |
| `--token <tok>` | 携带访问令牌 |

---

## 8. 权限体系

三层权限，从粗到细：

### 8.1 角色权限（群 resource）

| 角色 | ls | cat | cp上传 | mkdir | mv | rm | chmod | approve |
|------|----|----|-------|-------|----|----|-------|---------|
| member | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| owner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 外部（公开文件） | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

个人 storage：仅 AID 持有人可写，公开文件任何人可读。

### 8.2 文件/目录权限（chmod）

```bash
ec fs chmod +r <AID>:<path>                   # 公开可读
ec fs chmod o-r <AID>:<path>                  # 收回他人读权限
ec fs chmod +r <AID>:<path> --token-protected # 需令牌可读
ec fs chmod <AID>:<path> --allow-roles admin  # 限定角色
ec fs chmod <AID>:<path> --visibility public|private
ec fs chmod <AID>:<path> --tags "a,b"
```

### 8.3 细粒度 AID 授权（setfacl）

对标 Linux ACL，给具体 AID 授权：

```bash
ec fs setfacl -m aid:bob.aid.pub:r <AID>:<path>   # 给 bob 读权限
ec fs setfacl -x aid:bob.aid.pub <AID>:<path>     # 移除 bob 的授权
```

### 8.4 卷级访问授权

每个卷可配置允许哪些角色/AID 访问，附带次数和时间限制：

```bash
ec fs chmod <AID>:/memberdata/alice.aid.pub/ \
  --allow-roles owner,admin \
  --allow-aids bob.aid.pub \
  --expires 2026-12-01 \
  --max-reads 100
```

`/memberdata/<aid>/` 默认授权全体成员可读，持有人可收窄。

---

## 9. Token 与对外分享

### 9.1 分享 = 软链到 /public + 权限控制

系统**不提供** `share`/`unshare` 这类新词汇。对外分享拆解成两个 Linux 原生动作：

1. `ln -s` 把文件暴露到 `/public`（创建访问入口）
2. `chmod` / `setfacl` 控制谁能访问、怎么访问

四种分享场景：

| 场景 | 命令 |
|------|------|
| 公开给所有人 | `ln -s → /public/x` + `chmod +r x` |
| token 保护 | `... + chmod +r x --token-protected` |
| 指定 AID | `... + setfacl -m aid:bob:r x` |
| 带次数/期限 | `... + chmod +r x --token-protected --expires ... --max-reads ...` |

### 9.2 token 的产生

`chmod --token-protected` 设权限时，命令输出里返回生成的 token：

```
✓ 已开放读权限（需令牌）
  路径: alice.agentid.pub:/public/report.pdf
  令牌: tok_abc123
  有效期至: 2026-12-01
```

token 是统一凭证，两种通道均可使用：

**CLI（文件命令）：**
```bash
ec fs cat alice.agentid.pub:/public/report.pdf --token tok_abc123
ec fs cp  alice.agentid.pub:/public/report.pdf ./local.pdf --token tok_abc123
```

**HTTP（网页/程序直接访问）：**
```
GET https://alice.agentid.pub/report.pdf
Authorization: Bearer tok_abc123
```

这正是 AID 三位一体的体现：同一个文件，CLI 以 `<AID>:<path>` 访问，网页以 `https://<AID>/<path>` 访问，token 在两侧通用——Linux 主机身份和 Web 主机身份共用一套鉴权。

- **无 token**（`chmod +r` 公开）：CLI 和 HTTP 均可直接访问，无需任何凭证
- **有 token**：CLI 带 `--token`，HTTP 带 `Authorization: Bearer`
- **白名单 AID**（`setfacl`）：用自己 AID 身份访问，服务端验证，不需 token

### 9.3 撤销分享 = Linux 原生方式

| 撤销动作 | 命令 |
|---------|------|
| 删访问入口 | `ec fs rm <AID>:/public/x`（删软链，不动真实文件） |
| 收回公开读 | `ec fs chmod o-r <AID>:/public/x` |
| 移除某人授权 | `ec fs setfacl -x aid:bob.aid.pub <AID>:/public/x` |

### 9.4 查看分享了什么 = ls 公开目录

```bash
$ ec fs ls -l alice.agentid.pub:/public/
lrwxrwxrwx report.pdf → /private/report.pdf  r--  token  expires:2026-12-01  reads:3/10
lrwxrwxrwx slides.pdf → /private/q2/slides.pdf r-- public
```

不需要专门的 `shares` 命令，`ls -l /public/` 就是分享清单。

---

## 10. 审批流程（仅 owner）

群里不熟悉 Linux 的成员也能操作。owner 可设审批模式，此时 member 的上传需 owner 批准：

```bash
ec fs ls --pending <AID>:                      # 查看待审批
ec fs approve <AID>: --request-id req_xxx
ec fs reject  <AID>: --request-id req_xxx --note "需脱敏"
```

---

## 11. 与现有命令的关系

`ec fs` 是面向 agent 的**统一前端**，底层命令保留作调试。

| 旧命令 | 新等价 |
|--------|--------|
| `ec storage upload <aid> ./f r/f` | `ec fs cp ./f <aid>:/r/f` |
| `ec storage download <aid> <url> ./f` | `ec fs cp <owner>:/path ./f` |
| `ec storage ls <aid> prefix/` | `ec fs ls <aid>:/prefix/` |
| `ec storage rm <aid> path` | `ec fs rm <aid>:/path` |
| `ec storage quota <aid>` | `ec fs df <aid>:` |
| `ec group fs ls <gid> /path` | `ec fs ls <gid>:/path` |
| `ec group fs cp ./f <gid>:/p` | `ec fs cp ./f <gid>:/p` |

`ec storage` / `ec group resource` 降为底层调试命令，日常 agent 只用 `ec fs`。

---

## 12. 分层架构

```
应用层（SDK）   collab.create / read / submit     ← 带乐观锁的协作语义
     │
     ▼
命令层（ec fs） ls/cat/cp/mv/rm/mkdir/ln/chmod/df  ← Linux 文件命令，统一前端
     │
     ▼
路由层          按 AID 判定 storage / group resource
     │
     ▼
存储层          卷（物理隔离）+ storage / group resource RPC
```

---

## 13. 设计评估

### 优点

- **零学习成本**：大模型已掌握 Linux 文件命令，`host:path → AID:path` 即可复用，无新名词。
- **认知统一**：个人文件、群文件、他人公开文件、对外分享、协作，全是同一套命令。
- **底层透明**：storage / group resource 的差异由路由层吸收，agent 不感知。
- **软链贯穿**：对外发布、稳定别名、群协作三件事共用一个原语。
- **协作不丢数据**：各写各卷 + 软链指针 + 提交乐观锁，写入永不失败、冲突不丢数据。
- **商业闭环**：卷 = 容量 + 授权期 + 续费，计费清晰。

### 待解决/权衡

- **路径规划是一次性决策**：挂载点/目录结构定了，引用依赖它——用软链做稳定入口缓解（真实路径可变）。
- **grace 期是策略非承诺**：到期数据保留多久由服务商定，需在 UI/`df` 明确标注。
- **可写期边界**：`mkdir`/`mv`/`chmod` 等是否算「写」需在实现时明确定义。

### 与云存储的本质区别

| 维度 | 云存储（S3/OSS） | 本系统 |
|------|-----------------|--------|
| 寻址 | `bucket/key`，全局唯一字符串 | `AID:path`，身份即地址 |
| 身份 | API Key / IAM | AID，密码学绑定 |
| 权限 | 手动配 Policy | 从关系层继承（群成员自动有群权限） |
| 使用者 | 服务端程序 | agent + 人，命令行友好 |
| 发现性 | 先知道桶名 | `ec fs ls <AID>:/` 直接探索 |

一句话：**云存储是基础设施，本系统是面向 agent 社会的文件系统**——AID 是公民，卷是名下土地，权限跟着关系走。

---

## 14. 本地挂载（mount-local）

把 AUN 文件系统挂成本地一个文件夹/盘符，之后用任何程序（资源管理器、VSCode、`cat`）直接访问——这就是 `sshfs` 干的事。和第 3 节的卷 `mount`（远程卷挂到 AID 主机目录）不是一回事：这里是把远程主机挂到**本地操作系统**。

### 14.1 原理：用户态文件系统

```
应用程序（VSCode / 资源管理器 / cat）
   │  普通文件 I/O
   ▼
内核 VFS ──→ FUSE/等价物 ──→ ec-fsd（用户态驱动）
                                │ storage.* / group RPC
                                ▼
                            AUN 网络
```

把对挂载点的 `open/read/write/readdir` 转发给用户态驱动，由它翻译成 `storage.*` / group resource 的 RPC——`sshfs` 怎么把文件操作翻译成 SFTP，我们就怎么翻译成 AUN RPC。

```bash
ec fs mount-local alice.agentid.pub:/  ~/aun-alice    # Linux/Mac：挂到目录
ec fs mount-local alice.agentid.pub:/  Z:             # Windows：挂成盘符
ec fs umount-local ~/aun-alice
```

### 14.2 三平台与权限

| 平台 | 机制 | 成熟度 | 一次性安装 | 日常使用 |
|------|------|--------|-----------|---------|
| Linux | FUSE（内核原生） | 最成熟 | 装包（可能需 sudo） | 普通用户 |
| macOS | macFUSE（kext，趋势转 FSKit） | 可用有坎 | 批准内核扩展（管理员+重启） | 普通用户 |
| Windows | WinFsp（类 FUSE） | 成熟 | 装驱动（管理员） | 普通用户 |

**关键：只有一次性安装驱动需要管理员权限，日常挂载/使用都是普通用户权限。** 和装任何驱动类软件一样，不是高危操作。macOS 是唯一有摩擦的——新版系统对 kext 管控严，安装时需到「系统设置 → 隐私与安全性」批准并可能重启（一次性）。

### 14.3 实现路线：优先复用 rclone

不必自己写三套 FUSE 驱动。`rclone` 已把「远程后端 + 三平台挂载 + 缓存」做完（支持 70+ 后端，`rclone mount` 跨 Linux/Mac/Win）。两条路线：

| 路线 | 工作量 | 控制力 |
|------|--------|--------|
| 自研 FUSE 驱动 | 大（分别适配 libfuse / macFUSE / WinFsp） | 最强 |
| **写一个 rclone backend**（推荐先评估） | 小（挂载/缓存/三平台兼容全复用） | 够用 |

给 `ec fs` 实现一个 rclone 后端插件，能省下约 80% 工作量。

### 14.4 真正的难点：非 POSIX 语义的映射/降级

挂载本身不难，难在本系统的语义和 POSIX 对不齐：

| 本系统特性 | 挂到本地后的问题 |
|-----------|----------------|
| 软链接带版本号、跨主机 | POSIX symlink 无版本概念，跨主机需驱动层模拟 |
| 协作乐观锁（submit 可失败） | 本地 `write()` 是覆盖语义，没有「提交失败」——冲突无处暴露 |
| token / 授权期 / 次数限制 | 文件突然不可读，本地程序只看到 `EACCES`，用户困惑 |
| 卷 grace 期只读 | 表现为整个目录突然只读 |
| 网络延迟 | 本地 FS 假设低延迟，`ls` 大目录可能卡顿 |

尤其**协作乐观锁**是应用层协议：本地编辑器只会「读-改-写覆盖」，绕过 `collab.submit` 的版本检查。挂载场景下协作目录大概率只能降级为 last-write-wins，或借 FUSE 的 `release`（关闭文件）钩子触发一次提交检查、冲突时报错。

### 14.5 演进策略：只读优先

1. **第一阶段——只读挂载**：把 AUN 文件系统挂成本地只读目录，覆盖「用本地工具浏览/打开 AUN 文件」这一最高频需求，避开全部写冲突语义难题。
2. **第二阶段——个人 storage 读写**：覆盖语义清晰的个人区先开放本地写。
3. **第三阶段——群协作目录**：暂不开放本地写，或明确降级为 last-write-wins 并告知用户；需要严格协作时仍走 `collab.*` SDK 接口。
4. **缓存层是刚需**：网络延迟下必须做元数据 + 内容缓存，否则 `ls`/打开体验差。

---

## 15. 完整示例

```bash
# —— 个人文件 ——
ec fs ls alice.agentid.pub:/docs/
ec fs cp ./notes.md alice.agentid.pub:/private/notes.md
ec fs df alice.agentid.pub:

# —— 对外发布 agent.md ——
ec fs ln -s alice.agentid.pub:/private/identity/agent.md \
            alice.agentid.pub:/public/agent.md
# → https://alice.agentid.pub/agent.md 可访问

# —— 对外分享（token + 期限）——
ec fs ln -s alice.agentid.pub:/private/report.pdf alice.agentid.pub:/public/report.pdf
ec fs chmod +r alice.agentid.pub:/public/report.pdf --token-protected --expires 2026-12-01

# —— 群文件 ——
ec fs ls group.agentid.pub:/12345/share/
ec fs cp ./design.png group.agentid.pub:/12345/memberdata/alice.aid.pub/design.png

# —— 卷管理 ——
ec fs mount alice.agentid.pub:/archive --volume vol_abc123
ec fs df alice.agentid.pub:
```
