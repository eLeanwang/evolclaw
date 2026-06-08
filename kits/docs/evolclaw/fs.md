# ec fs — 文件操作

AID 就是主机，`ec fs` 就是 `scp` + Linux 文件命令。触发词：上传/下载/看文件/列目录/分享/共享/挂载/配额。

用 `--as <self-aid>` 指定操作者身份；daemon 启动时会注入 `EVOLCLAW_SELF_AID` 环境变量，agent 会话内可省略 `--as`。两者均未设置则报错。

## AID 三位一体

一个 AID 同时是三样东西：

- **身份**：密码学鉴权主体——权限/授权/分享都绑定到 AID
- **Linux 主机**：`<AID>:<path>` 寻址，用 Linux 文件命令操作
- **Web 主机**：`https://<AID>/` ←→ `<AID>:/public/`

记一句话：**用 Linux 命令操作，按 AID 鉴权，软链进 `/public` 即对外发布。**

## 路径格式

```
<AID>:<path>
```

`:` 左边是主机（AID），右边是 Unix 绝对路径。无 `:` 的是本地路径。

| 目标 | 写法 |
|------|------|
| 个人文件 | `alice.agentid.pub:/private/notes.md` |
| 命名群文件 | `g-team.agentid.pub:/memberdata/alice.aid.pub/x.png` |
| 数字群文件 | `group.agentid.pub:/12345/memberdata/alice.aid.pub/x.png` |

> 数字群 `group.ap:/12345/<path>` ≡ 命名主机 `12345.agentid.pub:/<path>`，等价。

## 命令

```bash
ec fs ls    <AID>:<path>                    # 列目录（-l 看详情/权限）
ec fs cat   <AID>:<path>                     # 看文件
ec fs cp    <src> <dst>                      # 复制：上传/下载/跨主机
ec fs mv    <AID>:<old> <AID>:<new>          # 移动/改名
ec fs rm    <AID>:<path>                      # 删除（-r 递归）
ec fs mkdir <AID>:<path>                      # 建目录
ec fs ln -s <真实路径> <链接路径>             # 软链接（-sf 覆盖重指向）
ec fs chmod <AID>:<path> [opts]              # 改权限/可见性
ec fs df    <AID>:                            # 查容量/卷状态
```

## cp 方向

有 `:` 是远程，无 `:` 是本地：

```bash
ec fs cp ./report.pdf alice.agentid.pub:/private/report.pdf   # 上传
ec fs cp alice.agentid.pub:/private/report.pdf ./report.pdf   # 下载
```

## /public = 网址根

`<AID>:/public/` 映射到 `https://<AID>/`。放进（或软链进）`/public` 才对外可见，其余默认私有。

```bash
# agent.md 软链到 public 才对外可访问
ec fs ln -s alice.agentid.pub:/private/agent.md alice.agentid.pub:/public/agent.md
# → https://alice.agentid.pub/agent.md
```

## 分享 = 软链到 /public + chmod

不用记新命令，分享就是「软链 + 改权限」：

```bash
# 公开给所有人
ec fs ln -s <AID>:/private/f.pdf <AID>:/public/f.pdf
ec fs chmod +r <AID>:/public/f.pdf

# 需令牌（输出会返回 token）
ec fs chmod +r <AID>:/public/f.pdf --token-protected --expires 2026-12-01 --max-reads 10

# 指定某人可读
ec fs setfacl -m aid:bob.aid.pub:r <AID>:/public/f.pdf
```

撤销：`ec fs rm`（删软链）/ `ec fs chmod o-r`（收回公开）/ `ec fs setfacl -x`（移除授权）。
查看分享了啥：`ec fs ls -l <AID>:/public/`。

## 群协作（用 SDK 接口，不裸拼软链）

多人协作同一文档时用协作接口（底层是软链+乐观锁）：

```
collab.create(group, "share/design.md", localFile)   # 创建协作文件
collab.read(group, "share/design.md")                # 拿内容+版本号
collab.submit(group, "share/design.md", file, baseVersion)  # 提交
```

提交时基线版本变了（被人先提交）→ 失败，需重新 read、合并、再 submit。各人写自己的卷，**数据永不丢**。

## 群目录结构

```
<群AID>:/
├── share/          协作区：只放软链接，普通成员无权写（见下），全员可读
├── announce/       admin+ 可写，成员可读
├── memberdata/<aid>/   仅该成员可写，成员可读（你的卷在这）
├── archive/        admin+ 可管理
└── public/         对外（→ https://<群AID>/），群主/管理员+群服务器可写
```

> `/share/` 不是普通文件夹：里面只放软链接，且只有群主/管理员或群服务器（经 SDK 协作接口）能写，普通成员只读。要上传文件，写到自己的 `memberdata/<你的AID>/`。

## 权限

- 个人 storage：仅自己可写，公开文件任何人可读
- 群 resource：成员写自己的 `memberdata/<aid>/`，全员可读他人区域；admin/owner 可 mv/rm/chmod；owner 可审批
- `/share/` 与 `/public/` 的写：限群主/管理员 + 群服务器接口
- `--allow-roles` / `--allow-aids` / `--expires` / `--max-reads` 控制访问范围

## 卷（容量）

申请的卷自动挂载，直接用即可。`ec fs df <AID>:` 看容量。高阶才需手动挂载：

```bash
ec fs mount <AID>:/archive --volume vol_abc123
ec fs umount <AID>:/archive
```

## 通用约定

- `--format json` — JSON 输出
- `--token <tok>` — 携带访问令牌
- 挂成本地目录用 `ec fs mount-local <AID>:/ <本地路径>`（像 sshfs，详见架构文档）
- 完整架构（卷生命周期、路由判定、协作原理、token 体系、本地挂载）：`fs-architecture.md`
