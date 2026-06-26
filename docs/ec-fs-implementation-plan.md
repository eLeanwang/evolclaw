# ec fs 实现方案

本文描述 EvolClaw 中 `ec fs` 的落地方案和当前实现口径。重点是产品入口、命令范围、personal/group 路由、能力边界和验收标准。

本文不定义新的 AUN 后端能力，不扩展当前 SDK 没有的能力，也不包含代码示例。

## 1. 产品定位

`ec fs` 是 EvolClaw 面向用户和 agent 的统一 AUN 文件系统入口。

用户只需要记住一个文件命令集：`ec fs <command> <AID>:<path>`。AID 可以是个人 AID，也可以是群 AID。用户不需要在命令层区分个人空间和群空间；EvolClaw 在路由层根据 AID 类型分派到不同后端。

因此，不设计独立的 `ec group fs` 产品入口。群空间访问也统一通过 `ec fs`。

## 2. 对齐来源

当前实现以 Python `aun_cli` 已暴露的命令面和 npm SDK 的实际类型为准。

已对齐的 Python personal `aun fs` 命令包括：`ls`、`stat`、`cat`、`cp`、`mv`、`rm`、`ln`、`mkdir`、`df`、`mount`、`approve`、`reject`、`umount`、`find`、`chmod`、`setfacl`、`getfacl`、`token issue`、`token revoke`、`token ls`。

已对齐的 Python group `aun group fs` 命令包括：`ls`、`find`、`stat`、`lstat`、`mkdir`、`rm`、`cp`、`mv`、`df`、`mount`、`umount`。

EvolClaw 对外不保留 `ec group fs`，而是把 group 能力收敛到统一的 `ec fs` 路由里。

## 3. 设计原则

### 3.1 统一入口

所有 AUN 文件空间访问都从 `ec fs` 进入。

个人空间和群空间都使用 `<AID>:<absolute-path>`。命令层不暴露 personal/group 的入口差异。

### 3.2 能力诚实

`ec fs` 只暴露当前后端和 SDK facade 已经具备、且 EvolClaw 能稳定适配的能力。

personal storage 能力不自动推导为 group fs 能力。group fs facade 没有的接口，在群 AID 上返回 `UNSUPPORTED`，不通过客户端拼凑语义。

### 3.3 路由隔离

`ec fs` 是统一产品入口，但不是单一后端实现。

内部流程是路径解析、AID 类型解析、personal backend 或 group backend 分派、统一输出。

个人空间和群空间可以复用路径解析、输出格式化和错误处理，但后端适配层必须隔离，避免把个人 storage 的行为错误投射到群资源上。

### 3.4 权限下沉

CLI 不自行实现权限系统。

`ec fs` 只负责携带操作者身份、目标 AID、路径和操作参数。具体权限由 personal storage 后端或 group fs 后端判定。

CLI 只做错误归一化、能力边界提示和可读输出。

## 4. 路径模型

远程路径格式统一为 `<AID>:<absolute-path>`。

规则：

- `:` 左侧是 AID。
- `:` 右侧必须是以 `/` 开头的绝对路径。
- 本地路径不带 `:`。
- `df` 可使用 `<AID>:` 表示查看该 AID 文件空间容量。

内部拆分为：

| 字段 | 含义 |
|------|------|
| `ownerAid` | 路径所属 AID |
| `remotePath` | 绝对路径 |
| `objectKey` | 去掉前导 `/` 后供 storage 类接口使用的 key |

路径解析必须独立于具体后端，供 personal backend、group backend 和未来协作层复用。

## 5. 操作者身份

`ec fs` 每次执行都需要明确操作者身份。

操作者身份来源优先级：

1. 显式 `--as <aid>`。
2. daemon 注入的 `EVOLCLAW_SELF_AID`。
3. 无法确定时报错。

不默认使用目标 AID 作为操作者。目标 AID 是资源归属者，不一定是当前执行者。

## 6. AID 类型解析

`ec fs` 根据目标 AID 选择后端。

解析顺序：

1. 读取目标 AID 的 `agent.md`。
2. `type: group` 路由到 group backend。
3. 其他类型路由到 personal backend。
4. 读取失败时默认按 personal backend 尝试，并在 route 信息中保留 warning。

后续可加入短期缓存，减少连续文件操作时的网络探测成本。缓存只影响性能，不改变路由语义。

## 7. 当前命令范围

### 7.1 personal backend

personal backend 适配 `client.storage` / `StorageVFS`。

| 命令 | 当前状态 | 对应能力 |
|------|----------|----------|
| `ls` | 已实现 | `storage.list` |
| `stat` / `lstat` | 已实现 | `storage.stat` / `storage.lstat` |
| `cat` | 已实现 | `storage.stat` + `storage.readBytes` |
| `cp` 上传/下载 | 已实现 | `storage.uploadFile` / `storage.downloadFile` |
| `cp` 远程复制 | 已实现 | `storage.copy` |
| `mv` | 已实现 | `storage.rename` |
| `rm` / `rm -r` | 已实现 | `storage.remove` |
| `mkdir` | 已实现 | `storage.mkdir` |
| `ln -s` / `ln -sf` | 已实现 | `storage.symlink` / `storage.repoint` |
| `chmod` | 已实现 | `storage.setVisibility` |
| `setfacl` / `getfacl` | 已实现 | `storage.setAcl` / `storage.removeAcl` / `storage.listAcl` |
| `token issue/revoke/ls` | 已实现 | `storage.issueToken` / `storage.revokeToken` / `storage.listTokens` |
| `find` | 已实现 | `storage.find` |
| `df` | 已实现 | `storage.df` |
| `mount` | 已实现 | `storage.mount` / `storage.mountVolume` |
| `approve` / `reject` | 已实现 | `storage.approveMount` / `storage.rejectMount` |
| `umount` | 已实现 | `storage.unmount` |

### 7.2 group backend

group backend 适配 `client.group.fs` / `GroupFSVFS`。EvolClaw 不再暴露 `ec group fs`，但会把群 AID 的 `ec fs` 调用路由到 group facade。

| 命令 | 当前状态 | 对应能力 |
|------|----------|----------|
| `ls` | 已实现 | `group.fs.ls` |
| `stat` / `lstat` | 已实现 | `group.fs.stat` / `group.fs.lstat` |
| `cat` | 已实现 | `group.fs.stat` + `group.fs.cp` 到 blob |
| `cp` 上传/下载/群远程复制 | 已实现 | `group.fs.cp` |
| `mv` | 已实现 | `group.fs.mv` |
| `rm` / `rm -r` | 已实现 | `group.fs.rm` |
| `mkdir` | 已实现 | `group.fs.mkdir` |
| `find` | 已实现 | `group.fs.find` |
| `df` | 已实现 | `group.fs.df` |
| `mount` | 已实现 | `group.fs.mount` |
| `umount` | 已实现 | `group.fs.umount` |

group backend 当前不支持：`ln`、`chmod`、`setfacl`、`getfacl`、`token`、`approve`、`reject`。原因是当前 `GroupFSVFS` facade 没有对应接口。

## 8. 命令行为口径

### 8.1 ls

列出目标路径下的文件或目录节点。

personal 路由到 `storage.list`。group 路由到 `group.fs.ls`。

### 8.2 stat / lstat

`stat` 默认跟 Python `aun fs` 口径对齐：不跟随末级软链。传入 `-L` 或 `--follow` 时跟随软链。

`lstat` 始终查看节点本身。

### 8.3 cat

文本内容直接输出。

二进制内容不直接输出原始字节，而是返回包含 `binary: true` 和 base64 文件头的结构化信息。默认头部字节数为 256，可通过 `--head-bytes` 调整。

超过 `--max-bytes` 的内容不直接整段输出，按二进制/头部摘要形式返回。完整文件读取使用 `cp` 下载。

group backend 当前没有 range read 接口，`cat --head-bytes` 在 group 路由上会先通过 `group.fs.cp` 取得 blob，再截取头部用于输出。

### 8.4 cp

支持本地上传、远程下载和远程到远程复制。

personal 远程复制使用 `storage.copy`。personal 到 personal 的跨 owner 复制由 `storage.copy` 的 `dstOwner` 参数承载。

group 远程复制使用 `group.fs.cp`。

personal/group 混合远程复制当前不支持，返回 `UNSUPPORTED`，提示先下载到本地再上传。

### 8.5 mv

personal `mv` 使用 `storage.rename`，仅支持同 owner。跨 owner 移动不具备原子语义，当前返回 `UNSUPPORTED`，提示使用 `cp` 后确认再 `rm`。

group `mv` 使用 `group.fs.mv`。

personal/group 混合远程移动当前不支持。

### 8.6 rm / mkdir

`rm` 支持 `-r` / `--recursive`，由后端执行递归语义。

`mkdir` 支持 `-p` / `--parents`，由后端执行父目录创建语义。

CLI 不通过 `.keep` 等约定模拟目录。

### 8.7 ln

`ln` 当前只支持 `-s` 软链。

personal `ln -s` 使用 `storage.symlink`。`ln -sf` 使用 `storage.repoint` 重指已有软链，并可携带 `--expected-version`。

group backend 当前没有 symlink/repoint facade，群 AID 上返回 `UNSUPPORTED`。

### 8.8 chmod / ACL / token

`chmod` 当前只覆盖已落地的可见性语义：`+r`、`o-r`、`--visibility public|private`，以及可选 `--allow-roles`。

`setfacl` 支持 `-m aid:<AID>:<perms>` 和 `-x aid:<AID>`，可携带 `--expires`、`--max-uses`。

`token` 支持 `issue`、`revoke`、`ls`，可携带 `--expires`、`--max-reads`、`--token`。

这些能力当前只接 personal storage。group backend 返回 `UNSUPPORTED`。

### 8.9 find

`find` 支持元数据过滤：`--name`、`--type`、`--size`、`--mtime`、`--page`、`--page-size`。

不支持 `-exec`、内容搜索或需要读取文件内容的过滤。

### 8.10 mount / approve / reject / umount

`mount` 支持 `--source <AID>:<path>` 和 `--volume <id>` 二选一，默认只读，可通过 `--readwrite` 切换。

personal route 使用 `storage.mount` / `storage.mountVolume`，支持 `--require-approval`、`--expires`、`--source-bucket`。

group route 使用 `group.fs.mount`，只传递 group facade 当前可接收的参数。

`approve` / `reject` 当前只接 personal storage 的挂载审批能力。group facade 没有对应接口。

`umount` 在 personal 和 group 上都已实现。

## 9. 输出和错误模型

`ec fs` 支持人类可读输出和 `--format json`。

JSON 输出面向 agent 消费，应包含：

- `command`
- `backend`
- `route`
- 完整远程路径
- 操作结果或节点元数据

常见错误码：

| 错误码 | 含义 |
|--------|------|
| `INVALID_PATH` | 路径不是合法 `<AID>:<path>` |
| `INVALID_AID` | AID 格式非法 |
| `INVALID_ARGUMENT` | 参数缺失或非法 |
| `UNSUPPORTED` | 当前后端或路由组合不支持该操作 |
| `LOCAL_IO_ERROR` | 本地文件读写失败 |
| `BACKEND_ERROR` | 后端返回未知错误或 SDK 调用失败 |

错误提示必须给出下一步建议，特别是权限不足、group facade 缺能力、personal/group 混合复制移动等场景。

## 10. 与现有命令关系

### 10.1 与 ec storage

`ec storage` 保留为底层调试入口。

面向用户和 agent 的文件操作优先使用 `ec fs`。

### 10.2 与 ec group

`ec group` 继续负责群消息和群生命周期管理。

群文件空间不新增 `ec group fs`，统一纳入 `ec fs`。

### 10.3 与 ec collab

`ec collab` 是未来的版本协作层，不属于 `ec fs` 的文件操作语义。

`ec fs` 可以作为 collab 的底层文件读写能力，但不提供版本协作语义，例如 merge、history、snapshot、adopt。

## 11. 文档同步要求

实现和维护 `ec fs` 时，需要同步更新：

- `kits/docs/evolclaw/fs.md`
- `kits/docs/evolclaw/INDEX.md`
- `kits/templates/system-fragments/commands.md`
- CLI help
- `docs/aun-fs/20-fs-commands.md`
- 本文档

文档原则：

- 只写已实现能力。
- 不出现 `ec group fs` 作为可调用入口，只可在迁移说明中说明旧入口已并入 `ec fs`。
- 不出现已取消的本地磁盘映射能力。
- 不把 personal-only 能力写成 group 也支持。
- 不把 SDK facade 没有的能力写成 CLI 已支持。

## 12. 当前验收清单

当前实现应满足：

- `ec fs` 是唯一文件空间产品入口。
- 个人空间和群空间都使用 `<AID>:<path>`。
- `ec fs --help` 列出当前真实命令面。
- `stat` 默认不跟随软链，`stat -L` 跟随软链。
- `cat` 对文本、二进制、大文件有稳定输出，不污染终端。
- personal `mv/mkdir/rm -r/ln/chmod/setfacl/token/mount/find` 对齐 Python `aun fs` 能力。
- group `ls/find/stat/lstat/mkdir/rm/cp/mv/df/mount/umount` 对齐 Python `aun group fs` 能力，并通过统一 `ec fs` 入口访问。
- group 缺失的 `ln/chmod/setfacl/getfacl/token/approve/reject` 明确返回 `UNSUPPORTED`。
- personal 跨 owner `mv` 明确拒绝，提示 `cp` 后确认再 `rm`。
- personal/group 混合远程 `cp/mv` 明确拒绝。
- 所有成功结果都回吐完整远程路径。
- JSON 输出可被 agent 稳定消费。
- 运行时 ECK 手册、方案文档和 CLI help 对能力边界一致。

## 13. 后续准入规则

未来新增或放宽 `ec fs` 能力前，必须满足：

1. 后端或 SDK facade 已有稳定能力。
2. personal backend 和 group backend 的语义差异已经明确。
3. 权限模型由后端定义，CLI 不自行模拟。
4. CLI 能给出稳定 JSON 输出和清晰错误提示。
5. 文档能清楚描述可用范围、失败行为和替代路径。

当前可考虑的后续项：

- 为 AID 类型解析增加缓存。
- 当 group facade 暴露 symlink、ACL、token 或审批接口后，再把对应命令扩展到群 AID。
- 当 group facade 支持 range read 后，优化 group `cat --head-bytes`，避免完整下载。
- 根据后端能力进一步明确 remote-to-remote copy 的跨 owner、跨群、跨后端语义。
