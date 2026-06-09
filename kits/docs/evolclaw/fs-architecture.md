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

### 1.2 两种主机

| 类型 | 写法 | 解析方式 | 后端 |
|------|------|---------|------|
| 个人 AID | `alice.agentid.pub:/docs/f.txt` | 泛域名解析 | personal storage |
| 群 AID | `g-team.agentid.pub:/设计/x.png` | 泛域名解析（与普通 AID 无异） | group resource |

寻址模型里**只有 AID 这一种主机**——群也是一个 AID，写法和个人 AID 完全一致，无需任何特殊语法。是个人还是群，由后端路由按 `type` 字段判定（见 1.4），对寻址透明。

> **实现注记（不对外暴露）**：AUN 底层群可能以固定域名 + 群编号的形式存在（如 `group.ap:/12345/...`）。CLI 在**归一化层**把这种形式统一映射为群 AID 处理——`group.ap:/12345/<path>` 等价于该群 AID 的 `:/<path>`。**这是实现细节。归一化是双向的**：
>
> - **入向**：用户/agent 只用群 AID 写法输入，CLI 内部解析时若遇到底层数字群形式也接受并归一。
> - **出向（关键）**：CLI 的**所有输出**——`ls`/`df` 结果、错误信息、`ln -l` 的链接目标——必须把底层数字群形式转换回群 AID 再显示，**绝不让 `group.ap:/12345/...` 这种形式泄漏到任何对外输出**。
>
> 归一化点放在 CLI 的**输出序列化前的最后一道**（结果离开路由层、进入展示前统一过一遍映射），保证「群 ID 就是一个 AID，而不是 `aid/path`」这条对外契约处处成立。使用手册（`fs.md`）和 CLI 命令行中**一律只出现群 AID 写法**，不出现「数字群」概念。

### 1.3 操作者身份（--as）

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

> **设计文档 vs 使用手册**：`--as` 的两种来源和优先级是**实现契约**，必须在本设计文档讲清。但面向 agent 的使用手册（`fs.md`）里**一律省略 `--as`**——agent 会话内 `EVOLCLAW_SELF_AID` 已由 daemon 注入，手册中的示例不写 `--as`，避免大模型纠结「这次该不该带」。仅当需要跨身份操作（罕见）时手册才提一句可显式 `--as`。

### 1.4 后端路由判定（CLI 内部）

确定操作者后，CLI 需要知道目标 AID 是个人还是群，以路由到对应后端。判定**不靠路径启发式**（不去猜首段、不试探），而是查目标 AID 的 **`agent.md` `type` 字段**——泛域名服务器据此字段判断主体类型并响应对应服务。

`type` 的取值与路由：

| `type` | 含义 | 路由后端 |
|--------|------|---------|
| `group` | 群 | 群 resource |
| `human` | 人类 | personal storage |
| `agent` | AI agent | personal storage |
| `node` | 非人非 agent 的 AUN 节点（程序、嵌入式软件、evolclaw 自身等） | personal storage |

`node` 在文件系统语境下与个人 storage **行为完全一致**——它只是「既不是人也不是 agent」的 AUN 节点（如一段程序、嵌入式设备、evolclaw 进程本身的 AID），存储模型和个人 AID 没有区别。除 `group` 外的所有类型都走 personal storage。

判定流程：

1. 解析目标 AID，取其 `agent.md` 的 `type` 字段
2. `type == group` → 群 resource
3. 其余类型（`human`/`agent`/`node`） → personal storage

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
g-team.agentid.pub:/
├── announce/      # 公告区，仅 admin/owner 可写，成员可读
├── memberdata/    # 成员卷挂载区
│   ├── alice.aid.pub/   # alice 的卷挂载点，默认仅 alice 可写，成员可读
│   └── bob.aid.pub/     # bob 的卷挂载点
└── public/        # 群对外 Web 根（→ https://<群AID>/），admin+ 可写，任何人可读
```

| 目录 | 默认写权限 | 默认读权限 |
|------|-----------|-----------|
| `/announce/` | admin + owner | 全体成员 |
| `/memberdata/<aid>/` | 仅该成员 | 全体成员（可收窄） |
| `/public/` | admin + owner | 任何人（对外） |

**核心设计：成员只能写自己的卷（`/memberdata/<自己的AID>/`），这是物理隔离的默认状态。** 协作通过 ACL 授权实现——成员可以用 `setfacl` 把自己卷内某个目录的读/写/删权限授予其他成员，协作范围由发起方按需授权，不依赖任何特殊目录约定。

**没有 `/share/` 目录。** 协作发生在成员自己的卷里，通过 ACL + `.collab` 文件（见第 6 节）组织，群目录里不存在专用协作特区。

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
ec fs ln -s <真实路径> <链接路径>      # 真实路径在前，链接路径在后（同 cp/mv 方向）
ec fs ln -sf <真实路径> <链接路径>     # -f 覆盖已有软链（原子重指向）
```

**参数顺序：真实文件在前，软链在后**——和 `cp src dst`、Linux `ln -s target link` 完全一致。这是最容易写反的地方，务必对照：

```bash
# ✅ 正确：真实文件在前，软链在后
ec fs ln -s alice.agentid.pub:/private/identity/agent.md \
            alice.agentid.pub:/public/agent.md

# ❌ 错误：方向反了——会把真实文件当成链接去创建
ec fs ln -s alice.agentid.pub:/public/agent.md \
            alice.agentid.pub:/private/identity/agent.md
```

> 使用手册（`fs.md`）里同样要保留这组 ✅/❌ 例子并强调一次——看例子比读解释更不容易写反。

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

### 6.1 设计思想

协作不依赖任何特殊目录。**发起方在自己卷里创建协作目录，通过 ACL 授权参与者，放一个 `.collab` 文件作为发现锚点。** 这就是全部。

```
协作 = ACL 授权的目录 + .collab 说明文件 + collab 版本语义
```

没有「协作特区」，没有 `/share/`，没有引擎特权通道。collab 命令集只是 fs 之上的版本控制层——就像 git 对普通文件系统的关系。鉴权全走 ACL，collab 和 fs 共用同一套。

### 6.2 协作目录结构

以 alice 在群里发起一个协作项目为例：

```
alice.aid.pub:/projects/myapp/          ← 协作根（alice 自己的卷）
├── .collab                              ← 发现锚点（必须在协作根）
├── design.md@current  ──→ .collab-versions/design.md/alice.aid.pub/v3.md
├── design.md@ledger                     ← 版本台账（版本号/作者/时间/target）
├── .collab-versions/                    ← 版本文件区（managed，不要手动碰）
│   └── design.md/
│       ├── alice.aid.pub/v1.md, v3.md  ← alice 提交的版本（按作者分 namespace）
│       └── bob.aid.pub/v2.md           ← bob 提交的版本
└── （其他项目文件）
```

**两个固定约定**：
- `<doc>@current`：指向当前权威版本的软链，携带 version 号
- `<doc>@ledger`：版本台账文件，记录每个 version → `{author, target, time}`

按作者分 namespace（`.collab-versions/<doc>/<author-aid>/vN`）保证各参与者写入物理不冲突，与目录在哪个卷无关。

### 6.3 .collab 文件格式

```markdown
# 项目名称
发起方：alice.aid.pub
描述：myapp 的设计协作
协作根：alice.aid.pub:/projects/myapp/
参与权限申请：向发起方发消息，或执行
  ec fs setfacl -m aid:<你的AID>:rw alice.aid.pub:/projects/myapp/
  （由发起方执行以授权）
```

**`find` 发现协作项目**：

```bash
# 扫描本群所有成员卷下的协作项目
ec fs find g-team.agentid.pub:/memberdata/ --name .collab

# 读说明
ec fs cat alice.aid.pub:/projects/myapp/.collab
```

找到 `.collab` 所在目录即协作根，路径直接写在文件里，agent 读完即可操作，无需拼接。

### 6.4 三文件模型（版本机制本质）

协作中每个文档涉及三个对象：

| 记号 | 对象 | 位置 | 角色 |
|------|------|------|------|
| **a** | 本地文件 | 本地磁盘 或 `<aid>:<path>` | 工作副本（source） |
| **b** | 版本文件 | `<协作根>/.collab-versions/<doc>/<author>/vN` | 某人某次提交，永不覆盖 |
| **c** | 当前指针 | `<协作根>/<doc>@current` | 软链 + version 号，指向权威版本的 b |

**b 的路径由系统推导，永不作参数**——`(协作根, doc, 操作者 AID, 系统自增版本号)` 唯一确定，调用方不感知。

数据流：

```
创建：  a ──→ b(author/v1) ──ln-sf──→ c(version=1)

协作：  读 c（→ 某人的 b）──→ 本地 a
        编辑 a
        a ──→ 自己的 b(author/vN) ──submit CAS──→ c(version+1)
```

**可追溯性硬规则**：submit 每次写新版本文件（单调递增，绝不覆盖）。台账记录每个 version 的 `{author, target, time}`。台账 + 不覆盖的 b = 完整可追溯历史。

**乐观锁（CAS）**：submit 切指针是后端提供的原子操作——「若 c 当前 version == baseVersion，则原子切 c 指向新 b 且 version+1，否则返回失败」。这不是 CLI 用户态能保证的，必须后端实现。

### 6.5 SDK 协作接口

坐标：`collabRoot`（协作根的完整 `<aid>:<path>`）、`doc`（相对协作根的文档路径）、`source`（本地文件路径 或 `<aid>:<path>`）。

| 接口 | 作用 | 底层动作 |
|------|------|---------|
| `collab.ls(collabRoot)` | 列出协作根下所有协作文档 | LIST 协作根，识别 `@current`，返回 `[{doc, version, author, currentTarget}]` |
| `collab.create(collabRoot, doc, source)` | 首次创建协作文档 | source→b(v1) → 建 c → version=1 |
| `collab.read(collabRoot, doc)` | 读当前内容+版本号 | 顺 c→b 读，返回 `{content, version, author, collabRoot, doc, currentTarget}` |
| `collab.submit(collabRoot, doc, source, baseVersion)` | 提交新版本（乐观锁） | source→自己的 b(vN)（**永不失败**）→ CAS 切 c |
| `collab.merge(collabRoot, doc, source, baseVersion)` | 三方合并 | base=`baseVersion` 对应的 b（由台账定位，**不依赖本地留底**）、ours=source、theirs=当前 c 指向的 b，输出合并结果，冲突用 `<<<<<<<` 标记 |
| `collab.history(collabRoot, doc)` | 查版本台账 | 返回 `[{version, author, target, time}]`，target 是完整 `<aid>:<path>` |
| `collab.get(collabRoot, doc, version)` | 读指定历史版本 | 按台账定位 b，返回内容 |
| `collab.diff(collabRoot, doc, vA, vB)` | 比较两版本 | 取 vA、vB 的 b 内容做差异比较 |

**所有响应都回吐完整 `<aid>:<path>`**（`collabRoot`、`currentTarget`、`target`），agent 可原样作为 fs 命令参数，不用拼接任何路径。

> **merge 的 base 来源（实现契约）**：三方合并的 base 是「调用方上次读到的版本」，由 `baseVersion` 显式指定，后端按台账从 `.collab-versions/` 定位对应的 b——**不依赖调用方本地是否还留着原始版本**。submit 失败响应已带出 `currentVersion`，merge 直接用提交者上次 read/submit 时的 `baseVersion` 即可。这保证三方合并永远有真正的 base，不会退化成两方合并。

> **collab 的封装定位（层边界）**：`ec collab` 是 `ec fs` 之上的**协作语义封装**，不是 fs 的全量代理。封装原则——**只封装「裸用 fs 就必须懂 collab 内部结构」的操作**（`ls`/`read`/`get`/`history`/`diff`：它们都要识别 `@current` 软链、`.collab-versions/` 布局、版本号语义），**不封装无 collab 语义的纯 fs 操作**（`mkdir 协作根`/`setfacl`/`find --name .collab`/`cp .collab`/回收空间的 `rm`——这些操作普通路径，直接走 fs）。鉴权始终下沉 fs ACL：collab 的 `ls`/`read` 内部走同一套 ACL 校验，无权限报 fs 的 `EACCES`，collab 不另起任何特权通道。这样既省去「裸 fs 多步 + 懂内部布局」的代价，又不让 collab 长成第二个文件系统。

### 6.5 协作时序

```
初始：alice 创建 design.md@current → alice/v1, version=1

① alice.read()  → content_v1, version=1
② bob.read()    → content_v1, version=1

③ alice.submit(source, baseVersion=1)
     写 alice/v2 ✓；CAS(version==1) ✓ → c→alice/v2, version=2；成功

④ bob.submit(source, baseVersion=1)
     写 bob/v2 ✓（数据安全，不丢）
     CAS(version==1)？当前已是 2 ✗ → 失败
     响应：{ok:false, currentVersion:2, currentTarget:"alice.aid.pub:/projects/myapp/.collab-versions/design.md/alice.aid.pub/v2.md",
            hint:"ec collab merge alice.aid.pub:/projects/myapp design.md <source>"}

⑤ bob.merge(source) → 三方合并 → 解决冲突
   bob.submit(merged, baseVersion=2)
     CAS(version==2) ✓ → c→bob/v3, version=3；成功
```

### 6.6 删除与改名

| 操作 | 命令 | 说明 |
|------|------|------|
| 下线协作文档（删 c） | `ec fs rm <协作根>/<doc>@current` | 删的是指针软链，b 历史全部保留，可重建 |
| 给协作文档改名（改 c 名） | `ec fs mv <协作根>/<doc>@current <协作根>/<newdoc>@current` | 只改软链名，`.collab-versions/<doc>/` **不改名**——c 继续指向原 b，历史不断 |
| 清理历史版本文件（删 b） | `ec fs rm <target>`（从 history 响应拿路径） | **危险**，破坏可追溯性；仅在协作废弃回收空间时操作 |
| 下线整个协作项目 | `ec fs rm -r <协作根>` | 卷主或有 rm 权限的人；数据全删，不可恢复 |

**collab 不提供 delete/rename 动词**——这些是纯 fs 操作，由 ACL 控制谁能执行，与 collab 无关。

### 6.7 权限模型

协作的权限完全走 `setfacl`，没有任何 collab 特权通道：

```bash
# 发起方授予 bob 读写权限
ec fs setfacl -m aid:bob.aid.pub:rw alice.aid.pub:/projects/myapp/

# 收回
ec fs setfacl -x aid:bob.aid.pub alice.aid.pub:/projects/myapp/

# 只读（仅查看不能提交）
ec fs setfacl -m aid:bob.aid.pub:r alice.aid.pub:/projects/myapp/
```

**「谁能 submit」= 「谁对协作根有写权限」**——`ec collab submit` 底层写 b 文件和切 c 指针都走 ACL，没有权限就报 `EACCES`，错误提示引导去找发起方授权：

```
✗ 无写权限：alice.aid.pub:/projects/myapp/
  请联系发起方 alice.aid.pub 执行：
  ec fs setfacl -m aid:<你的AID>:rw alice.aid.pub:/projects/myapp/
```

---

## 7. 命令集

全部对标 Linux 文件命令，语义一一对应。

| 命令 | Linux 语义 | ec fs 用法 |
|------|-----------|-----------|
| `ls` | 列目录 | `ec fs ls <AID>:<path>` |
| `cat` | 看文件 | `ec fs cat <AID>:<path>`（二进制返回元数据，见 7.1） |
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

> `mount`/`umount` 在文件层**专指卷挂载**（把远程卷挂到 AID 主机的某个目录，见第 3 节）——操作对象是 **AID 主机自身的文件系统**，是 Linux 文件命令的正统成员，故留在 `ec fs`。把整个 AID 主机挂成本地 OS 目录/盘符（sshfs 那种）操作对象是**你的本机**，是另一回事、另一命令集 `ec drive`，见第 14 节。判据：操作对象是「AID 主机的文件系统」就留在 `ec fs`，是「本机」就归 `ec drive`。

### 7.1 cat 二进制文件的行为

`cat` 文本文件直接返回内容。**`cat` 二进制文件不返回原始字节流**（会污染终端、对 agent 无意义），而是返回一份元数据，其中包含**文件头部字节的编码片段**，供判断文件格式（魔数）：

```
$ ec fs cat alice.agentid.pub:/private/app.zip
{
  "path": "alice.agentid.pub:/private/app.zip",
  "size": 10485760,
  "mime": "application/zip",
  "binary": true,
  "head": {
    "encoding": "base64",
    "bytes": 64,
    "data": "UEsDBBQAAAAIA..."
  },
  "modified": "2026-06-01T12:00:00Z"
}
```

`head.data` 是文件**前 N 字节**的编码（默认 base64）。要拿完整文件用 `ec fs cp` 下载，不要用 `cat`。

**头部截断长度建议值**：常见容器/可执行格式的魔数都在文件最前端，绝大多数 ≤ 8 字节即可判定（如 `PK\x03\x04`=zip、`MZ`=exe/PE、`\x7fELF`=ELF、`%PDF`=pdf、`\x89PNG`=png、`GIF8`=gif、`\xff\xd8\xff`=jpeg、`\x1f\x8b`=gzip、`ID3`/`\xff\xfb`=mp3）。少数格式魔数靠后或需更多上下文：

| 场景 | 所需头部长度 |
|------|------------|
| 绝大多数魔数判定 | ≤ 8 字节 |
| ISO-BMFF 系（mp4/mov/heic，`ftyp` 在偏移 4 起） | ~16 字节 |
| TAR（魔数 `ustar` 在偏移 257） | ~265 字节 |
| 综合保险值（覆盖上述全部 + 留余量） | **建议默认 256 字节** |

取 **256 字节**做默认截断：base64 编码后约 344 字符，体积可忽略，却能覆盖几乎所有常见格式（含偏移靠后的 TAR）的魔数识别。可用 `--head-bytes <n>` 覆盖默认值。

### cp 的方向

由 `:` 的有无判定：有 `:` 是远程，无 `:` 是本地。

```bash
ec fs cp ./local.txt alice.agentid.pub:/docs/f.txt          # 上传
ec fs cp alice.agentid.pub:/docs/f.txt ./local.txt          # 下载
ec fs cp a.agentid.pub:/x bob.agentid.pub:/refs/x           # 跨主机
```

> 跨主机 `cp` 的目标不能是群的 `/share/`（只读区，见 2.2）——往群里放协作文件请用 `ec collab`（见第 7.5 节），或上传到自己的 `/memberdata/<你的AID>/`。

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

`chmod` **只管权限位和可见性**，不签发凭证、不处理 AID 白名单（那些分别交给 `ec fs token` 和 `setfacl`）：

```bash
ec fs chmod +r <AID>:<path>                   # 公开可读
ec fs chmod o-r <AID>:<path>                  # 收回他人读权限
ec fs chmod <AID>:<path> --allow-roles admin  # 限定角色
ec fs chmod <AID>:<path> --visibility public|private
ec fs chmod <AID>:<path> --tags "a,b"
```

### 8.3 细粒度 AID 授权（setfacl）

对标 Linux ACL，给具体 AID 授权——**这是给特定 AID 授权的唯一方式**（`chmod` 不再有 `--allow-aids`）：

```bash
ec fs setfacl -m aid:bob.aid.pub:r <AID>:<path>   # 给 bob 读权限
ec fs setfacl -x aid:bob.aid.pub <AID>:<path>     # 移除 bob 的授权
# 附带次数/期限限制
ec fs setfacl -m aid:bob.aid.pub:r <AID>:<path> --expires 2026-12-01 --max-reads 100
```

### 8.4 卷级访问授权

卷的访问授权同样走 `chmod`（角色）+ `setfacl`（具体 AID），附带次数和时间限制：

```bash
ec fs chmod   <AID>:/memberdata/alice.aid.pub/ --allow-roles owner,admin
ec fs setfacl -m aid:bob.aid.pub:r <AID>:/memberdata/alice.aid.pub/ \
  --expires 2026-12-01 --max-reads 100
```

`/memberdata/<aid>/` 默认授权全体成员可读，持有人可收窄。

---

## 9. Token 与对外分享

### 9.1 分享 = 软链到 /public + 权限控制

系统**不提供** `share`/`unshare` 这类新词汇。对外分享拆解成 Linux 原生动作：

1. `ln -s` 把文件暴露到 `/public`（创建访问入口）
2. `chmod` / `setfacl` 控制谁能访问
3. 需令牌时，用 `ec fs token` 单独签发（token 是凭证，铸造它是独立动作，不混进 chmod）

四种分享场景：

| 场景 | 命令 |
|------|------|
| 公开给所有人 | `ln -s → /public/x` + `chmod +r x` |
| token 保护 | `ln -s → /public/x` + `ec fs token issue x` |
| 指定 AID | `ln -s → /public/x` + `setfacl -m aid:bob:r x` |
| 带次数/期限 | `... + ec fs token issue x --expires ... --max-reads ...` |

### 9.2 token 的签发（独立动词）

token 由独立命令 `ec fs token` 铸造和吊销——**`chmod` 不再签发 token**：

```bash
ec fs token issue  <AID>:<path> [--expires 2026-12-01] [--max-reads 10]
ec fs token revoke <AID>:<path> --token tok_abc123
ec fs token ls     <AID>:<path>     # 列出该路径已签发的 token
```

`issue` 输出生成的 token：

```
✓ 已签发访问令牌
  路径: alice.agentid.pub:/public/report.pdf
  令牌: tok_abc123
  有效期至: 2026-12-01
  次数上限: 10
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
- **有 token**（`ec fs token issue`）：CLI 带 `--token`，HTTP 带 `Authorization: Bearer`
- **白名单 AID**（`setfacl`）：用自己 AID 身份访问，服务端验证，不需 token

### 9.3 撤销分享 = Linux 原生方式

| 撤销动作 | 命令 |
|---------|------|
| 删访问入口 | `ec fs rm <AID>:/public/x`（删软链，不动真实文件） |
| 收回公开读 | `ec fs chmod o-r <AID>:/public/x` |
| 吊销令牌 | `ec fs token revoke <AID>:/public/x --token tok_xxx` |
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
版本控制层（ec collab）  ls/read/get/history/diff（版本感知读）+ create/submit/merge/snapshot（版本写动词）
     │  封装协作语义；鉴权下沉 fs ACL，无特权通道
     ▼
文件层（ec fs）          ls/cat/cp/mv/rm/mkdir/ln/chmod/setfacl/find/df ← Linux 文件命令
     │
     ▼
路由层                   按 AID type 判定 personal storage / group memberdata
     │
     ▼
存储层（劈成两半）
   ├── 对象存储（OSS）        不可变 blob：.collab-versions/** 版本文件、用户普通文件
   │                          写一次永不改 = OSS 甜区；可上 CDN / 冷归档分层
   └── 元数据库（DB）          可变「脊柱」：@current/@snapshot 指针 + version 计数器、
                              setfacl 白名单 + chmod 角色、@ledger/_ledger 台账、卷/容量/授权期
                              CAS、软链、ACL 三件事全落这里，不落 OSS
```

**层边界是硬边界**：

- `ec fs` 承诺「Linux 语义，零新词汇」。
- `ec collab` 是 fs 之上的**协作语义封装**——封装「裸用 fs 必须懂 collab 内部结构」的**版本感知读**（`ls`/`read`/`get`/`history`/`diff`）+ 引入 Linux 没有的**版本写动词**（`submit`/`merge`/`snapshot`）。协作的发起/发现/纯路径授权仍走 `ec fs`（`mkdir`/`setfacl`/`find`），collab 不另起鉴权、不长成第二个文件系统。
- **存储层因 OSS 约束劈成两半**：OSS 存不可变 blob，元数据库存可变脊柱。这不是妥协，是 OSS 逼出来的正确架构——第 6.4 节「后端必须实现原子 CAS-on-symlink」的落地就是「指针 + version 存成 DB 一行，CAS = `UPDATE … WHERE version = baseVersion`」；软链在 OSS 上不是对象而是 DB 里一行指针，故 `@current`/`@snapshot` 的切换与回滚是毫秒级原子 DB 操作；细粒度 ACL 因 OSS 原生 ACL 太粗必须入库。详见第 18 节。

---

## 13. 设计评估

### 优点

- **零学习成本**：大模型已掌握 Linux 文件命令，`host:path → AID:path` 即可复用，无新名词。
- **一套鉴权**：collab 和 fs 共用同一套 ACL，无特权通道，「谁能做什么」永远只有一个答案。
- **认知统一**：个人文件、群文件、协作、对外分享，全是同一套命令，群里没有任何特殊目录。
- **底层透明**：storage 差异由路由层吸收，agent 不感知。
- **软链贯穿**：对外发布、稳定别名、协作版本指针，共用一个原语。
- **协作不丢数据**：按作者 namespace 隔离版本文件 + 软链指针 + 后端原子 CAS，写入永不失败、冲突不丢数据。
- **协作路径无关**：协作发生在任意卷任意路径，`.collab` 文件作为发现锚点，`find` 可扫描，不依赖群结构。
- **商业闭环**：卷 = 容量 + 授权期 + 续费，计费清晰；协作计费自然落到卷主头上。

### 待解决/权衡

- **路径规划是一次性决策**：挂载点/目录结构定了，引用依赖它——用软链做稳定入口缓解（真实路径可变）。
- **grace 期是策略非承诺**：到期数据保留多久由服务商定，需在 UI/`df` 明确标注。
- **后端必须实现原子 CAS-on-symlink**：乐观锁正确性依赖后端，CLI 用户态无法保证，这是实现的强约束。
- **可写期边界**：`mkdir`/`mv`/`chmod` 等是否算「写」需在实现时明确定义。

### 与云存储的本质区别

| 维度 | 云存储（S3/OSS） | 本系统 |
|------|-----------------|--------|
| 寻址 | `bucket/key`，全局唯一字符串 | `AID:path`，身份即地址 |
| 身份 | API Key / IAM | AID，密码学绑定 |
| 权限 | 手动配 Policy | ACL 按需授权，错误提示引导申请 |
| 协作 | 无内置版本协作 | collab 层：乐观锁 + 三方合并 + 版本追溯 |
| 使用者 | 服务端程序 | agent + 人，命令行友好 |
| 发现性 | 先知道桶名 | `ec fs ls <AID>:/` 直接探索；`find --name .collab` 发现协作 |

一句话：**云存储是基础设施，本系统是面向 agent 社会的文件系统**——AID 是公民，卷是名下土地，协作是公民间的契约（ACL 授权），不需要任何中央特区。

---

## 14. 本地驱动器映射（ec drive，独立命令集，非 ec fs）

> **注意**：把 AID 主机映射成本地盘符/目录这件事**不属于 `ec fs` 文件层**——它的操作对象是**你的本机 OS**，是跨越「网络主机 → 本地 OS」的映射；而 `ec fs mount` 的操作对象是 **AID 主机自身的文件系统**（远程卷挂到 AID 主机目录），两者方向相反。判据：操作对象是「AID 主机的文件系统」就留在 `ec fs`，是「本机」就归 `ec drive`。为彻底避免和 `ec fs mount` 混淆，本地映射用全新动词 `attach`/`detach`，命令集名为 `ec drive`。

把 AUN 文件系统映射成本地一个盘符/文件夹，之后用任何程序（资源管理器、VSCode、`cat`、Finder）直接访问——这就是 `sshfs` 干的事。

> `drive` 不是 POSIX 术语，是产品侧词汇，统一含义为「把 AID 当成一个本地可访问的盘」。Windows 下落到盘符，macOS/Linux 下落到挂载点目录——三平台共用同一组命令。

### 14.1 命令

```bash
# 把 AID 映射成本地盘/目录
ec drive attach <AID>:<远程路径> <本地盘符或目录>

# 解除映射
ec drive detach <本地盘符或目录>

# 查看当前已映射的 drive
ec drive list
```

实例：

```bash
ec drive attach alice.agentid.pub:/  Z:              # Windows：映射成盘符
ec drive attach alice.agentid.pub:/  ~/aun/alice     # Linux/macOS：映射成目录
ec drive detach Z:
ec drive detach ~/aun/alice
```

### 14.2 原理：用户态文件系统

```
应用程序（VSCode / 资源管理器 / cat）
   │  普通文件 I/O
   ▼
内核 VFS ──→ FUSE/等价物 ──→ ec-drived（用户态驱动）
                                │ storage.* / group RPC
                                ▼
                            AUN 网络
```

把对挂载点的 `open/read/write/readdir` 转发给用户态驱动，由它翻译成 `storage.*` / group resource 的 RPC——`sshfs` 怎么把文件操作翻译成 SFTP，我们就怎么翻译成 AUN RPC。

### 14.3 三平台与权限

| 平台 | 机制 | 成熟度 | 一次性安装 | 日常使用 |
|------|------|--------|-----------|---------|
| Linux | FUSE（内核原生） | 最成熟 | 装包（可能需 sudo） | 普通用户 |
| macOS | macFUSE（kext，趋势转 FSKit） | 可用有坎 | 批准内核扩展（管理员+重启） | 普通用户 |
| Windows | WinFsp（类 FUSE） | 成熟 | 装驱动（管理员） | 普通用户 |

**关键：只有一次性安装驱动需要管理员权限，日常 attach/detach 都是普通用户权限。** 和装任何驱动类软件一样，不是高危操作。macOS 是唯一有摩擦的——新版系统对 kext 管控严，安装时需到「系统设置 → 隐私与安全性」批准并可能重启（一次性）。

### 14.4 实现路线：优先复用 rclone

不必自己写三套 FUSE 驱动。`rclone` 已把「远程后端 + 三平台挂载 + 缓存」做完（支持 70+ 后端，`rclone mount` 跨 Linux/Mac/Win）。两条路线：

| 路线 | 工作量 | 控制力 |
|------|--------|--------|
| 自研 FUSE 驱动 | 大（分别适配 libfuse / macFUSE / WinFsp） | 最强 |
| **写一个 rclone backend**（推荐先评估） | 小（挂载/缓存/三平台兼容全复用） | 够用 |

给 AUN 文件系统实现一个 rclone 后端插件，能省下约 80% 工作量。

### 14.5 真正的难点：非 POSIX 语义的映射/降级

attach 本身不难，难在本系统的语义和 POSIX 对不齐：

| 本系统特性 | 映射到本地后的问题 |
|-----------|----------------|
| 软链接带版本号、跨主机 | POSIX symlink 无版本概念，跨主机需驱动层模拟 |
| 协作乐观锁（submit 可失败） | 本地 `write()` 是覆盖语义，没有「提交失败」——冲突无处暴露 |
| token / 授权期 / 次数限制 | 文件突然不可读，本地程序只看到 `EACCES`，用户困惑 |
| 卷 grace 期只读 | 表现为整个目录突然只读 |
| 网络延迟 | 本地 FS 假设低延迟，`ls` 大目录可能卡顿 |

尤其**协作乐观锁**是应用层协议：本地编辑器只会「读-改-写覆盖」，绕过 `collab.submit` 的版本检查。attach 场景下协作目录大概率只能降级为 last-write-wins，或借 FUSE 的 `release`（关闭文件）钩子触发一次提交检查、冲突时报错。

### 14.6 演进策略：只读优先

1. **第一阶段——只读 attach**：把 AUN 文件系统映射成本地只读目录，覆盖「用本地工具浏览/打开 AUN 文件」这一最高频需求，避开全部写冲突语义难题。
2. **第二阶段——个人 storage 读写**：覆盖语义清晰的个人区先开放本地写。
3. **第三阶段——群协作目录**：暂不开放本地写，或明确降级为 last-write-wins 并告知用户；需要严格协作时仍走 `ec collab` 命令集（见第 16 节）。
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
ec fs token issue alice.agentid.pub:/public/report.pdf --expires 2026-12-01

# —— 群文件（成员操作自己的卷）——
ec fs ls g-team.agentid.pub:/memberdata/alice.aid.pub/
ec fs cp ./design.png alice.aid.pub:/projects/myapp/design.png

# —— 发现群内协作项目 ——
ec fs find g-team.agentid.pub:/memberdata/ --name .collab
ec fs cat alice.aid.pub:/projects/myapp/.collab

# —— 卷管理 ——
ec fs mount alice.agentid.pub:/archive --volume vol_abc123
ec fs df alice.agentid.pub:
```

---

## 16. 应用协作层：ec collab

### 16.1 层定位

`ec collab` 是**版本控制层**，不属于 `ec fs` 文件层。它解决的是「多人协作的版本语义」——乐观锁、版本追溯、三方合并，这些 Linux 文件系统里本就不存在，引入新动词是合理的。协作的发起、发现、权限授予全走 `ec fs`（`mkdir`/`setfacl`/`find`），collab 只管版本。

```
ec collab   ← 版本控制层：create/read/submit/merge/history/get/diff
ec fs       ← 文件层：ls/cat/cp/mv/rm/setfacl/find/... Linux 语义
存储层       ← 卷 / storage RPC + 原子 CAS-on-symlink
```

`ec collab` 的操作对象是**协作根下的文档**，坐标为 `<collabRoot> <doc>`——`collabRoot` 是完整的 `<aid>:<path>`，`doc` 是相对协作根的文档路径（详见第 6 节）。

### 16.2 命令集

```bash
ec collab ls      <collab-root>
ec collab create  <collab-root> <doc> <source>
ec collab read    <collab-root> <doc>
ec collab submit  <collab-root> <doc> <source> --base-version <n>
ec collab merge   <collab-root> <doc> <source> --base-version <n>
ec collab history <collab-root> <doc>
ec collab get     <collab-root> <doc> --version <n>
ec collab diff    <collab-root> <doc> --from <n> --to <m>
```

`<source>` 可以是本地文件路径，也可以是 `<aid>:<path>`（卷上的文件）。

| 命令 | 作用 | 底层动作 |
|------|------|---------|
| `ls` | 列出协作根下所有协作文档 | LIST 协作根，识别 `@current`，返回 `[{doc, version, author, currentTarget}]` |
| `create` | 首次创建协作文档 | source→b(v1) → 建 c（`<doc>@current`）→ version=1 |
| `read` | 读当前版本+版本号 | 顺 c→b 读，返回 `{content, version, author, collabRoot, doc, currentTarget}` |
| `submit` | 提交新版本（乐观锁） | source→自己的 b（永不失败）→ CAS 切 c |
| `merge` | 三方合并 | base=`--base-version` 对应的 b（台账定位，不依赖本地留底）、ours=source、theirs=当前 c 指向的 b，冲突用 `<<<<<<<` 标记 |
| `history` | 查版本台账 | 返回 `[{version, author, target, time}]`，target 是完整 `<aid>:<path>` |
| `get` | 读指定历史版本 | 按台账定位 b，返回内容 |
| `diff` | 比较两版本 | 取 vA、vB 的 b 内容做差异比较 |

> `ec collab ls` 是 read/submit/snapshot 共用的 doc 枚举源——发现协作根后，先 `ls` 拿到文档清单（含每个 doc 的当前 version），再 `read`/`submit` 具体文档。agent 无需 `ec fs ls` 裸目录后自己识别 `@current`/`@ledger`/`.collab-versions` 后缀。

### 16.3 submit 乐观锁

```bash
ec collab submit alice.aid.pub:/projects/myapp design.md ./design.md --base-version 3
```

- 先把 source 写到提交者的 `b`（**永不失败**，数据先存下）
- 后端原子 CAS：若 `c` 当前 version == base-version → 切 c、version+1；否则失败

失败响应：

```
✗ 提交失败：当前版本已更新（你的基线 3，当前 4）
  你的草稿已安全保存，数据不丢
  currentTarget: alice.aid.pub:/projects/myapp/.collab-versions/design.md/alice.aid.pub/v4.md
  请执行: ec collab merge alice.aid.pub:/projects/myapp design.md ./design.md
  合并后重新提交: ec collab submit ... --base-version 4
```

### 16.4 典型协作流程

```bash
# —— 发起协作（alice）——
ec fs mkdir alice.aid.pub:/projects/myapp/
# 写 .collab 说明文件
ec fs cp ./.collab alice.aid.pub:/projects/myapp/.collab
# 授权 bob 读写
ec fs setfacl -m aid:bob.aid.pub:rw alice.aid.pub:/projects/myapp/
# 创建第一个协作文档
ec collab create alice.aid.pub:/projects/myapp spec.md ./spec.md

# —— 参与协作（bob）——
# 发现：从消息 or find
ec fs find g-team.agentid.pub:/memberdata/ --name .collab
ec fs cat alice.aid.pub:/projects/myapp/.collab   # 读说明，拿到 collabRoot

# 读当前版本
ec collab read alice.aid.pub:/projects/myapp spec.md

# 编辑后提交（基线 version=1）
ec collab submit alice.aid.pub:/projects/myapp spec.md ./spec-local.md --base-version 1

# 若 alice 已先提交（version=2），收到冲突提示，三方合并后重提交
ec collab merge  alice.aid.pub:/projects/myapp spec.md ./spec-local.md
ec collab submit alice.aid.pub:/projects/myapp spec.md ./spec-local.md --base-version 2

# 查历史 / 看旧版
ec collab history alice.aid.pub:/projects/myapp spec.md
ec collab get     alice.aid.pub:/projects/myapp spec.md --version 1
```

### 16.5 删除与改名（走 fs，不走 collab）

```bash
# 下线协作文档（删 c 软链，历史 b 保留）
ec fs rm alice.aid.pub:/projects/myapp/spec.md@current

# 协作文档改名（只改 c 的名字，.collab-versions/ 目录不改）
ec fs mv alice.aid.pub:/projects/myapp/spec.md@current \
         alice.aid.pub:/projects/myapp/api-spec.md@current

# 撤销某人权限
ec fs setfacl -x aid:bob.aid.pub alice.aid.pub:/projects/myapp/
```

---

## 17. 目录级快照层：ec collab snapshot

### 17.1 层定位与解决的问题

第 6 节的 collab 把**单个文档**作为版本单位：每个 `<doc>` 有独立的 `@current` 指针、`@ledger` 台账、按作者隔离的版本文件。这覆盖了「多人协作同一文件」的高频场景。

但**协作根（目录）本身没有版本概念**——`.collab` 只是发现锚点，不带版本。这导致两个缺口：

- **无跨文件一致性**：`spec.md` v3 和 `schema.json` v2 是一组配套改动，系统不知道；别人可能读到 `spec.md` v3 配 `schema.json` v1 的不一致组合。
- **无法整体回滚**：想回到「上周五那个目录状态」，得逐个文件查 history 对时间，没有统一的时间点。

`ec collab snapshot` 是补这个缺口的**目录级快照层**——把「此刻整个协作根下所有文档各指向哪个版本」作为一个不可变的时间点记录下来，可列举、可比较、可回滚、可清理。语义对标 `git tag` + ZFS/restic snapshot。

```
ec collab snapshot  ← 目录级快照层：create/list/show/diff/restore/rm/prune  ← 语义化版本 + 时间点
ec collab           ← 文档级版本层：create/read/submit/merge/history/get/diff  ← 单文档乐观锁
ec fs               ← 文件层：ls/cat/cp/mv/rm/setfacl/find/...  ← Linux 语义
存储层               ← 卷 / storage RPC + 原子 CAS-on-symlink
```

### 17.2 核心洞察：快照 = 引用，不是拷贝

因为 `.collab-versions/` 里的版本文件**永不覆盖、永久不可变**（第 6.4 节硬规则），快照不需要复制任何内容——它只记下「此刻每个 doc 的 `@current` 指向哪个不可变版本文件」。

- **创建快照** = 把当前所有 `@current` 的指向收集成一份 manifest，零数据拷贝。
- **回滚快照** = 把各 `@current` 软链重新指回 manifest 记录的 target，纯软链重指，零数据拷贝。

这是整个方案优雅与廉价的根源：快照层不引入任何新存储原语，只多一个 manifest 目录和一个目录级指针。

### 17.3 数据结构

```
alice.aid.pub:/projects/myapp/
├── .collab                              ← 发现锚点（第 6.3 节）
├── spec.md@current     ──→ .collab-versions/spec.md/alice.aid.pub/v5.md
├── api.md@current      ──→ .collab-versions/api.md/bob.aid.pub/v3.md
├── schema.json@current ──→ .collab-versions/schema.json/alice.aid.pub/v2.md
├── @snapshot           ──→ .collab-snapshots/2.3.1.json   ← 目录级当前快照指针（软链，携带快照版本号）
├── .collab-versions/                    ← 文档级版本区（第 6 节，快照层不碰）
└── .collab-snapshots/                   ← 目录级快照区（新增，append-only，managed，勿手动改）
    ├── 1.0.0.json
    ├── 1.1.0.json
    ├── 2.0.0.json
    ├── 2.3.1.json
    └── _ledger.jsonl                    ← 快照台账（append-only：每行一条 {version, author, time, bump, parent, message}）
```

单个快照文件 `2.3.1.json` 的格式：

```json
{
  "version": "2.3.1",
  "collabRoot": "alice.aid.pub:/projects/myapp",
  "author": "alice.aid.pub",
  "time": "2026-06-09T10:00:00Z",
  "parent": "2.3.0",
  "bump": "patch",
  "message": "修正 schema 字段拼写",
  "entries": {
    "spec.md":     { "version": 5, "target": "alice.aid.pub:/projects/myapp/.collab-versions/spec.md/alice.aid.pub/v5.md" },
    "api.md":      { "version": 3, "target": "alice.aid.pub:/projects/myapp/.collab-versions/api.md/bob.aid.pub/v3.md" },
    "schema.json": { "version": 2, "target": "alice.aid.pub:/projects/myapp/.collab-versions/schema.json/alice.aid.pub/v2.md" }
  }
}
```

`entries` 是这一刻整个目录的完整状态切片。所有 `target` 都是完整 `<aid>:<path>`，agent 拿来可原样作为 `ec fs` / `ec collab get` 的参数，无需拼接。

### 17.4 语义化版本规则

打快照时，系统拿**当前各 `@current` 指向**对比 `@snapshot` 当前指向的父快照 `entries`，自动判定 bump：

| 变化 | bump | 版本号示例 |
|------|------|-----------|
| 手动 `--major` | MAJOR | `3.0.0`（minor/patch 归零） |
| doc 集合变化（新增或删除文档） | MINOR | `2.4.0`（patch 归零） |
| 仅文档内容变化（doc 集合不变，version 号变了） | PATCH | `2.3.2` |
| 无任何变化 | —— | 报错「无变更可快照」 |

`--major` 永远优先；不带参数时自动判定 minor / patch。首次快照默认 `1.0.0`。

> **硬规则：快照只记录已 `submit` 的版本（`@current` 指向的）**，本地未提交草稿不在内。想纳入快照，先 `ec collab submit`。这样「快照」语义干净——它标记的是「已发布的目录状态」，不是工作区。

### 17.5 命令集

```bash
ec collab snapshot create  <collab-root> [--major] [-m "说明"]      # 创建快照（默认自动算 bump）
ec collab snapshot list    <collab-root>                           # 列出所有快照
ec collab snapshot show    <collab-root> <version>                 # 看某快照的完整 entries
ec collab snapshot diff    <collab-root> <vA> <vB>                 # 比较两快照（doc 增删 / 版本变化）
ec collab snapshot restore <collab-root> <version> [-m "说明"]      # 回滚到某快照（非破坏性）
ec collab snapshot rm      <collab-root> <version>                 # 删除指定快照（只删 manifest）
ec collab snapshot prune   <collab-root> --before <date> [--keep-last <n>]   # 按时间清理
```

| 命令 | 作用 | 底层动作 |
|------|------|---------|
| `create` | 创建目录级快照 | 收集所有 `@current` 指向 → 算 bump → 写 `<新版本>.json` → CAS 切 `@snapshot` → 追加 `_ledger.jsonl` |
| `list` | 列快照 | 读 `_ledger.jsonl`，返回 `[{version, author, time, bump, message}]`，标注哪个是 `@snapshot` 当前指向 |
| `show` | 看快照内容 | 读 `<version>.json`，返回完整 `entries`（含每个 doc 的 version 和完整 target） |
| `diff` | 比较两快照 | 对比两份 `entries`：列出新增 doc、删除 doc、version 变化的 doc |
| `restore` | 回滚 | 按目标快照 `entries` 重指各 `@current`（零拷贝）→ 追加一个新快照记录本次回滚 |
| `rm` | 删快照 | 只删 `.collab-snapshots/<version>.json`，**不动** `.collab-versions/` 底层版本文件 |
| `prune` | 按时间清理 | 删除 `--before` 之前的快照 manifest，拒删 `@snapshot` 当前指向的活动快照 |

### 17.6 四条健壮性保证

**① 创建用 CAS，并发安全。** `create` 读当前 `@snapshot` 的版本，算出新版本号，后端原子 CAS 切 `@snapshot`。两人同时打快照，一个成功，另一个收到「快照头已移动，请重试」——复用文档级同一套 CAS-on-symlink 机制（第 6.4 节），不引入新并发模型。

**② 回滚非破坏性（对齐「数据永不丢失」承诺）。** `restore <version>` 不是 `git reset --hard`，而是 `git revert` 思路：

- 把每个 doc 的 `@current` 重新指向目标快照 `entries` 里记录的 `target`（纯软链重指，零拷贝）。
- 对目标快照里没有、但当前存在的 doc（之后新增的），撤下其 `@current`（版本文件仍在 `.collab-versions/`，可恢复）。
- **追加一个新快照**（bump 照常算），`message` 自动记 `restored from <version>`。

forward 历史全部保留，任何时候都能再前滚。

> **文档级 version 必须 forward-only（两条版本线交叉处的不变量）**：restore 重指 `@current` 时，**文档级 version 计数器绝不回退**。回滚到「内容为 v3」不等于「version 退回 3」——而是**以 v3 的内容创建一个新版本 vN+1**（写一个新的不可变 b，台账追加一条 `{version: N+1, target: 指向 v3 内容, time}`），`@current` 的 version 计数继续单调递增。这样：回滚后 `collab read` 返回 `version=N+1`、内容=v3 副本；协作者 `submit --base-version N+1` 正常工作，不会和历史用过的版本号冲突。**「version 单调递增、永不倒退」这条贯穿全系统的不变量，在文档级与目录级两条版本线交叉时依然成立**——这是回滚不破坏并发正确性的关键。

**③ 删快照绝不删数据。** `rm` / `prune` 只删 `.collab-snapshots/` 里的 manifest——底层 `.collab-versions/` 版本文件被文档级历史和其他快照共享，快照层无权删。要回收版本文件空间，走 fs 层 `ec fs rm <target>`（第 6.6 节标记的「危险」操作），职责清晰分离。

**④ prune 安全栏。** `prune --before` 拒绝删除 `@snapshot` 当前指向的活动快照，即使它落在时间窗内；可选 `--keep-last N` 兜底保留最近 N 个。

### 17.7 结构化响应（agent 友好）

`create` 成功：

```json
{
  "ok": true,
  "version": "2.3.1",
  "bump": "patch",
  "collabRoot": "alice.aid.pub:/projects/myapp",
  "snapshotFile": "alice.aid.pub:/projects/myapp/.collab-snapshots/2.3.1.json",
  "changed": ["schema.json"]
}
```

`create` 遇 CAS 失败：

```
✗ 快照创建失败：快照头已被他人推进（你基于 2.3.0，当前已是 2.4.0）
  你的目录状态未受影响
  请重新执行: ec collab snapshot create alice.aid.pub:/projects/myapp -m "..."
```

### 17.8 典型流程

```bash
# 当前 @snapshot = 2.3.0。bob 改 schema.json 内容并提交（文档级）
ec collab submit alice.aid.pub:/projects/myapp schema.json ./schema.json --base-version 1

# alice 打快照——只动了内容，自动 PATCH
ec collab snapshot create alice.aid.pub:/projects/myapp -m "修正 schema 字段"
# → 2.3.1 (bump=patch, changed=[schema.json])

# alice 新增 deploy.md（doc 集合变化）后打快照——自动 MINOR
ec collab create alice.aid.pub:/projects/myapp deploy.md ./deploy.md
ec collab snapshot create alice.aid.pub:/projects/myapp -m "加部署文档"
# → 2.4.0 (bump=minor)

# 里程碑，手动标大版本
ec collab snapshot create alice.aid.pub:/projects/myapp --major -m "v3 设计定稿"
# → 3.0.0

# 方向错了，非破坏回滚到 2.3.1
ec collab snapshot restore alice.aid.pub:/projects/myapp 2.3.1 -m "回退到 schema 修正版"
# → 各 @current 重指回 2.3.1 的 target；deploy.md 的 @current 撤下（版本文件仍在）
#   追加新快照 3.0.1，记录 "restored from 2.3.1"；3.0.0 历史保留

# 列举 / 比较 / 清理
ec collab snapshot list  alice.aid.pub:/projects/myapp
ec collab snapshot diff  alice.aid.pub:/projects/myapp 2.3.1 3.0.0
ec collab snapshot prune alice.aid.pub:/projects/myapp --before 2026-01-01 --keep-last 10
```

---

## 18. 存储后端：对象存储（OSS）的影响与命令可支持性

存储池基于 OSS 类云对象存储（S3 / 阿里云 OSS 等）。对象存储与 POSIX 文件系统有几处根本差异，直接决定了本设计的存储分层和命令能力边界。

### 18.1 存储劈成两半（OSS + 元数据库）

OSS 的几个特性逼出一个明确的劈分：没有真目录（只有 key 前缀）、没有 rename（只能 copy+delete）、没有 symlink、原生 ACL 太粗、对象写后基本不可原地改、跨对象无服务端 CAS。结论——

```
不可变大块数据（写一次永不改）  →  OSS 对象存储
  · .collab-versions/<doc>/<author>/vN     ← 版本文件，天然契合 OSS 不可变性
  · 用户普通文件 blob                        ← 可上 CDN、可冷归档分层降价

可变的「脊柱」（指针/计数器/ACL/台账）  →  元数据库（DB）
  · @current / @snapshot 软链指向 + version 计数器   ← CAS 在这里做条件更新
  · setfacl 的 AID 白名单、chmod 角色（OSS 原生 ACL 太粗，不用）
  · @ledger / _ledger.jsonl 台账
  · 卷 / 容量 / 授权期
```

三个关键落地：

- **CAS = DB 条件更新**：第 6.4 节「原子 CAS-on-symlink」在 OSS 上的实现是 `UPDATE pointers SET target=?, version=version+1 WHERE doc=? AND version=baseVersion`。S3 的 `If-None-Match` 只能做 put-if-absent，不足以实现版本 CAS——必须靠 DB。
- **软链是 DB 一行，不是对象**：`@current`/`@snapshot`/`/public` 软链全在 DB。故切指针、回滚快照、重指 public 入口都是毫秒级原子 DB 操作，零对象拷贝——这也解释了为什么「用指针而非移动文件」在 OSS 上是正确设计（OSS 的 mv 是全量 copy+delete，不原子不便宜）。
- **不可变版本文件是 OSS 甜区**：write-once、无并发覆盖、可挂 CDN、可分层冷归档。第 6.4 节「永不覆盖」硬规则与 OSS 不可变性天然对齐。

### 18.2 Linux 命令在 OSS 上的可支持性

🟢 原生/廉价　🟡 有代价/受限　🔴 贵或难　❌ 不可行

| 命令 | 支持性 | OSS 实现方式 | 说明 |
|------|:---:|------------|------|
| `ls` | 🟢 | LIST(prefix, delimiter) | 目录是 LIST 出的幻觉 |
| `cat` | 🟢 | GET object | 二进制返元数据（第 7.1 节） |
| `stat` | 🟢 | HEAD object | 大小/mtime/mime |
| `head` | 🟢 | GET + Range（前 N 字节） | 正是 cat 取魔数头的能力 |
| `cp` | 🟢 | GET/PUT；同区走服务端 CopyObject | 同区拷贝不出网 |
| `rm` | 🟢 | DELETE；`rm -r`=LIST+批量 Delete | |
| `df` | 🟢 | 查卷/容量元数据库 | 不查 OSS |
| `find`（名字/路径/大小/时间） | 🟢 | LIST + 按 key/元数据过滤 | **可实现**，只碰元数据；`--name .collab` 属此类 |
| `ln -s` | 🟢 | 元数据库写一行指针 | 不存成对象 |
| `mkdir` | 🟡 | 写零字节标记对象 或 no-op | OSS 无真目录 |
| `du` | 🟡 | LIST + 累加 size | O(n) LIST，大目录有计费/延迟 |
| `tree` | 🟡 | 递归 LIST 后呈现 | find 的展示形态 |
| `mv` | 🟡 | 小指针：DB 改一行；大真实文件：CopyObject+Delete | 后者全量拷贝、不原子；collab 切指针走前者故快 |
| `chmod` | 🟡 | 元数据库写角色/可见位 | OSS 原生 ACL 太粗 |
| `setfacl` | 🟡 | 元数据库写 AID 白名单 | 同上，必须入库 |
| `tail`（取尾 N 字节） | 🟡 | HEAD 取 size → GET Range 尾部 | 可做 |
| `wc` | 🟡 | 下载内容后计数 | 要碰内容，但输出小于 grep |
| `touch`（改 mtime） | 🟡 | CopyObject-to-self 改元数据 | 原地改 mtime 需自拷一次 |
| `grep`（内容搜索） | 🔴 | 无服务端跨对象全文扫描 | **不便于实现**，见 18.3 |
| `sed -i` / `truncate` / 原地编辑 | 🔴 | 对象不可原地改，须整体重写 | 大文件昂贵 |
| `tail -f`（跟随） | ❌ | OSS 无追加通知/流 | 需事件总线或轮询，另案 |
| `ln`（硬链接） | ❌ | OSS 无硬链概念 | 只有软链模拟 |
| `chown` | ❌ | 所有权由 AID/路径固定 | 不适用 |

> `sort`/`uniq`/`awk`/`sed`（无 `-i`）是作用于 stdout 的**管道工具**，不是文件系统操作，不进 `ec fs`——agent 在本地对下载下来的内容跑即可，服务端无对应概念。

### 18.3 grep 的边界（诚实暴露能力，不假装支持）

OSS 没有跨对象的服务端全文扫描。三条路各有局限：① 逐对象下载扫描——正确但贵（每对象一次 GET + 出网流量 + 请求计费），递归 grep 大树是灾难；② S3 Select / OSS Select——只对**单对象**且仅结构化格式（CSV/JSON/Parquet），不能跨对象 grep 任意文本；③ 外挂搜索索引（OpenSearch/ES）——能力最强但需额外基础设施和一致性维护。

**分阶段策略**：

1. **第一阶段**：`grep` **只支持单文件**（`ec fs grep <pattern> <AID>:<单文件>`，下载+扫描，代价可控）。
2. **递归 grep 显式拒绝**：`grep -r <大目录>` 直接报错「对象存储不支持高效内容搜索，请缩小到单文件，或申请全文索引」——能力边界诚实暴露，不静默退化成昂贵的全量下载。
3. **全文检索后续上索引服务**（OpenSearch/ES），作为独立能力，而非硬塞进 fs 原语。

对比 `find`：find 只碰 key 和元数据，LIST 就够，故 🟢 可实现；grep 必须碰对象内容，必须下载，故 🔴 不便于实现。这条「碰元数据 vs 碰内容」的分界，是判断任一命令在 OSS 上成本的通用标尺。
