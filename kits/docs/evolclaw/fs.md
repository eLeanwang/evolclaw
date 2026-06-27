# ec fs — AUN 文件系统

`ec fs` 是个人空间和群空间的统一文件入口。群空间也用 `ec fs`，没有 `ec group fs`。

路径格式：

```bash
<AID>:<absolute-path>
```

无 `:` 的路径是本地路径。操作者身份用 `--as <aid>`，agent 会话内通常由 `EVOLCLAW_SELF_AID` 注入，可省略。

## 已实现命令

```bash
ec fs ls  <AID>:<path>            # 列目录
ec fs cat <AID>:<path>            # 输出文本文件；二进制/大文件返回头部摘要
ec fs cp  <local> <AID>:<path>    # 上传
ec fs cp  <AID>:<path> <local>    # 下载
ec fs cp  <AID>:<path> <AID>:<path> # 远程复制（同后端）
ec fs stat [-L] <AID>:<path>      # 查看节点元数据（默认不跟随软链，-L 跟随）
ec fs lstat <AID>:<path>          # 查看节点本身（不跟随末级软链）
ec fs mv  <AID>:<path> <AID>:<path> # 移动/改名（同后端）
ec fs rm [-r] <AID>:<path>        # 删除文件或目录
ec fs mkdir [-p] <AID>:<path>     # 创建目录
ec fs ln -s <target> <AID>:<path> # 创建软链（personal storage）
ec fs chmod [mode] <AID>:<path>   # 切换公开/私有（personal storage）
ec fs setfacl <AID>:<path> -m|-x ... # 设置/移除 ACL（personal storage）
ec fs getfacl <AID>:<path>        # 查看 ACL（personal storage）
ec fs token issue|revoke|ls <path> # 管理访问 token（personal storage）
ec fs find <AID>:<path> [filters] # 查找节点
ec fs df  <AID>:                  # 查看容量/配额
ec fs mount <target> --volume <id>  # 挂载实体卷
ec fs mount <target> --source <src> # 挂载远程子树
ec fs approve <AID>:<path>        # 批准待审挂载（personal storage）
ec fs reject <AID>:<path>         # 拒绝待审挂载（personal storage）
ec fs umount <AID>:<path>         # 卸载挂载点
```

通用选项：

- `--format json`：结构化输出
- `--as <aid>`：显式指定操作者
- `--overwrite` / `--force`：`cp/mv/ln` 覆盖目标；`rm` 强制删除
- `-r` / `--recursive`：`rm/cp` 递归
- `-p` / `--parents`：`mkdir` 自动创建父目录
- `-L` / `--follow`：`stat` 跟随末级软链
- `--token <token>`：读取 personal storage 时携带访问 token
- `--content-type <mime>`：上传时指定 MIME
- `--max-bytes <n>`：`cat` 最大直接输出字节数，默认 1MB
- `--head-bytes <n>`：`cat` 二进制头部字节数，默认 256
- `--visibility public|private`：`chmod` 可见性
- `--allow-roles <roles>`：`chmod` 角色约束，逗号分隔
- `-m aid:<aid>:<perms>` / `-x aid:<aid>`：`setfacl` 增删 ACL
- `--source <AID>:<path>` / `--volume <id>`：`mount` 来源
- `--expires <time>`：`mount/token/ACL` 过期时间，Unix 秒或 ISO 日期

## 示例

```bash
ec fs ls alice.agentid.pub:/private/
ec fs cat alice.agentid.pub:/private/notes.md
ec fs cp ./report.md alice.agentid.pub:/private/report.md
ec fs cp alice.agentid.pub:/private/report.md ./report.md
ec fs cp alice.agentid.pub:/private/a.md bob.agentid.pub:/inbox/a.md
ec fs mkdir -p alice.agentid.pub:/private/reports/
ec fs ln -s alice.agentid.pub:/private/report.md alice.agentid.pub:/public/report.md
ec fs chmod +r alice.agentid.pub:/public/report.md
ec fs setfacl alice.agentid.pub:/private/report.md -m aid:bob.agentid.pub:r
ec fs token issue alice.agentid.pub:/public/report.md --expires 2026-12-31
ec fs find alice.agentid.pub:/private/ --name "*.md"
ec fs rm alice.agentid.pub:/private/report.md
ec fs df alice.agentid.pub:
```

群 AID 与个人 AID 写法相同：

```bash
ec fs ls g-team.agentid.pub:/archive/
ec fs cp ./weekly.md g-team.agentid.pub:/archive/weekly.md
```

## 路由规则

CLI 读取目标 AID 的 `agent.md`：

- `type: group` 走群文件后端
- 其他类型走个人 storage 后端
- 读取失败时先按个人 storage 尝试，并给出警告

权限由后端判断。CLI 只携带操作者、目标 AID、路径和操作。

## 能力边界

- `ln -s` 只在 personal storage 创建软链；group fs facade 暂无 symlink 接口。
- `chmod` 只映射到 personal storage 的 `setVisibility`；group fs facade 暂无 chmod/setVisibility 接口。
- `setfacl/getfacl/token/approve/reject` 只接 personal storage；group fs facade 暂无对应接口。
- personal storage 的 `mv` 仅支持同 owner；跨 owner 请先 `cp` 再 `rm`。
- personal/group 混合远程 `cp/mv` 不支持；请先下载到本地再上传。

需要底层调试时可用 `ec storage`。日常文件操作优先使用 `ec fs`。
