# EvolClaw 权限模式与审批契约

本文定义 EvolClaw 对 baseagent 工具调用的统一权限语义。baseagent 提供执行、沙箱和审批回调，EvolClaw 负责角色默认值、不可审批边界、审批路由和最终决策。

## 1. 公开模式

`/perm`、菜单、配置字段和新建 trigger 只公开四种模式：

| 模式 | 常规操作 | 危险操作或扩权 | 人工审批 |
| --- | --- | --- | --- |
| `readonly` | 仅明确声明的只读工具自动执行 | 直接拒绝 | 不发起 |
| `auto` | 在 runner 基线沙箱内自动执行 | 直接拒绝 | 不发起 |
| `request` | runner 不要求升级时执行 | runner 发出 approval request 时询问 | 可达性取决于 runner |
| `bypass` | 在 runner 基线沙箱内自动执行 | 危险命令和显式扩权仍询问 | 可达性取决于 runner |

`bypass` 不是无边界的 `danger-full-access`。它只跳过常规操作的人审，不能跳过绝对禁止、H 类边界、EC 角色鉴权或危险操作审批。

以下规则高于模式本身：

- 系统绝对禁止命令始终拒绝，不能审批放行。
- H 类配置、证书、密钥、快照和迁移文件始终禁止 agent 读取、写入或外发，审批不能放行。
- `readonly` 中 Shell 和未知工具默认拒绝。通过独立角色鉴权的 EC 命令不受通用只读判断重复拦截。
- `auto` 中显式 sandbox 扩权直接拒绝。
- 需要审批但缺少 Gateway、已认证审批人或审批通道时失败关闭。
- 未知模式和异常兜底均为 `readonly`。
- BaseAgent runner 在没有收到已解析的 per-call 模式时也以 `readonly` 启动，不能回落旧的 `auto`。

## 2. 角色默认值

没有关系级或 agent 级显式覆盖时，按运行时角色使用以下默认值：

| 角色 | 默认模式 |
| --- | --- |
| `owner` | `bypass` |
| `admin` | `request` |
| `member` | `auto` |
| `visitor` | `readonly` |
| `none`、未知角色 | `readonly` |

解析优先级为：关系配置 > 角色配置 > agent 配置 > 内置角色默认值 > `readonly`。

## 3. 历史值迁移

| 历史值 | 运行时处理 |
| --- | --- |
| `edit` | 按 `request` 执行 |
| `noask` | 安全降级为 `readonly`；不再具有内部运行时语义 |
| `plan` | 权限按 `readonly` 执行；Claude 保留 legacy plan workflow |
| 未知值 | 按 `readonly` 执行 |

`plan` 是工作流状态，不再是公开权限等级。历史配置仍可读取，后续应迁移到独立 workflow 字段。

## 4. 审批形态

### 4.1 动作

所有可审批 runner 统一提供三个动作：

1. 允许本次。
2. 当前 EvolClaw session、同一工具类别、同一精确输入授权 30 分钟。
3. 拒绝。

精确输入先稳定序列化，再计算 SHA-256 指纹。授权键包含 EvolClaw session id、BaseAgent 权限 profile/mode、工具类别和输入指纹，不能跨 session、跨命令、跨路径、跨 BaseAgent 或跨权限 profile 复用。MCP/app 等外部工具还绑定本轮有效外部工具配置的 SHA-256；同名 server 改 URL、transport、app/plugin 开关或审批策略后，旧授权不能复用。

旧 `/perm always` 仅是第 2 个动作的兼容名称，不再产生整个工具永久放行。EvolClaw 对 baseagent 始终返回单次允许；后续同输入必须再次经过 PermissionGateway，才能检查指纹和过期时间。

审批 pending 和绑定审批人身份的交互路由必须在卡片/文本投递前注册，request id 使用不可猜测 UUID。投递失败、响应先到、超时或路由丢失都不能隐式放行；投递失败立即按拒绝收敛。
审批提示的发送闭包与 EvolClaw session 一起保存；共享 runner 上后设置的其他会话回调不能覆盖当前审批的投递目标。

pending 在 PermissionGateway 内同时绑定审批人 ID；卡片响应和 `/perm allow|always|deny` 文本降级都必须携带渠道认证的 operator ID 并精确匹配，不能只凭 session/requestId 解锁。

同一 session 只有一个 pending 时可使用 `/perm allow|always|deny`；存在多个 pending 时必须使用 `/perm <requestId> allow|always|deny`，禁止模糊命中“第一个”请求。
本地和跨会话审批的文本降级都必须显示完整的 `/perm <requestId> allow|always|deny`；跨会话 owner 即使当前 AUN 私聊没有活跃任务，也可以通过 requestId 回答，Gateway 仍会校验该请求绑定的认证 operator。

### 4.2 审批人和路由

正常任务统一使用 `agent_owner` 策略：

- owner 在自己的私聊会话中可本地审批。
- admin 或其他来源的请求通过 EvolAgent 的 AUN 私聊通道发送给配置的 owner。
- 群聊中的 owner 请求也转到 owner 的 AUN 私聊，避免群成员代为点击。
- owner 未配置、没有可投递 AUN adapter、requester 身份缺失或 operator 身份无法认证时拒绝。AUN adapter 不支持卡片时使用带 requestId 的文本审批，不因 `capabilities.interaction=false` 提前判定审批不可达。

本地审批等待 20 分钟；跨会话审批默认也为 20 分钟。超时、中断和未知 action 都按拒绝处理。卡片只接受已认证且与 `initiatorId` 相同的 operator。

## 5. 各 BaseAgent 实现

### 5.1 Claude Agent SDK 0.3.170

- 四种公开模式均使用 SDK `permissionMode=default`；历史 `plan` workflow 使用 SDK `plan`。
- `PreToolUse` 始终执行绝对禁止、H 类、EC 鉴权、只读和危险命令判断。
- `readonly` 对明确只读工具返回 allow，对写工具、Shell 和未知工具返回 deny。
- `auto` 对常规工具返回 allow，对危险命令返回 deny。
- `request` 对常规工具返回 defer，由 SDK 判断何时调用 `canUseTool`；`canUseTool` 再接入 PermissionGateway。
- `bypass` 对常规工具返回 allow，危险命令在 `PreToolUse` 直接进入 PermissionGateway。
- SDK 始终设置 `strictMcpConfig=true`，只接受 EvolClaw 显式传入的 MCP；project/user settings、plugin、on-disk agent 及 subagent frontmatter MCP 均不加载。capability manager 只传 HTTP/SSE 远程 MCP，带 `command` 的 stdio MCP 在进程启动前剔除；legacy `useSettingSources=false` 路径也不能重新注入 `~/.claude/mcp.json`。
- SDK 通过 parent managed policy 设置 `allowManagedHooksOnly=true`、`disableSkillShellExecution=true`、`allowedHttpHookUrls=[]` 和 `allowManagedPermissionRulesOnly=true`：用户/项目及其插件提供的磁盘 hook、skill/自定义命令内联 Shell 和本地 permission allow rule 均不能绕过 EvolClaw；SDK `options.hooks` 中的 EvolClaw `PreToolUse/PermissionDenied/PreCompact` 宿主回调仍保留。机器管理员提供的 managed hook 属于更高信任域，不由关系角色或 `/perm` 放宽。
- MCP 和未识别工具不视为常规工具，因为其副作用可能发生在 Claude 本地 sandbox 之外：`readonly/auto` 在生命周期层不启用 MCP，Hook/callback 再次直接拒绝；`request/bypass` 必须先经过 PermissionGateway，临时授权绑定远程 MCP 配置哈希。
- `canUseTool` 会重复执行 blacklist、H 类和 EC 检查，防止 SDK 边缘路径绕过 Hook。
- `/compact`、`/clear` 和 rewind 辅助 query 同样清空 tools、skills、MCP 和 setting sources，启用 `strictMcpConfig` 与 managed hook policy；不能借内部生命周期 query 启动项目 hook、plugin hook 或 MCP 进程。
- 所有普通 Agent 运行都保留工具并请求 SDK sandbox，设置 H 类 `denyRead/denyWrite`、`allowUnsandboxedCommands=false`、`allowAllUnixSockets=false`、`allowLocalBinding=false` 和 `failIfUnavailable=true`；隔离运行时缺失时由 SDK 失败关闭整轮任务。
- 不使用 `bypassPermissions`，因为该 SDK 模式会跳过 `canUseTool`。

### 5.2 Codex app-server / CLI 0.144.1

- runner 最低版本锁定为 0.144.1；更旧版本缺少本契约审计过的完整 named-profile / permission-request 协议时拒绝启用，不能降级成弱保护运行。
- 四种公开模式统一使用 `approvalPolicy=untrusted` 和 `approvalsReviewer=user`。
- `untrusted` 在这里是让非 trusted command 进入 EvolClaw 决策桥的底层策略，不直接等同于公开 `request` 模式；回调到达后仍按四种公开模式分别 allow、deny 或询问。
- 每个 EvolClaw session 注入独立 named permission profile：`readonly` 继承 `:read-only`，其余模式继承 `:workspace`，并叠加 H 类 filesystem deny rules；包含特殊字符或超长的 session id 使用原始 id 的 SHA-256 后缀，避免 sanitize/truncate 后 profile 撞名。
- named profile 在 thread start、resume、turn start、compact resume 和 fork 时重新注入。
- thread start/resume、compact resume 和 fork 在所有 capability/MCP/app 配置合并后强制注入 `features.hooks=false`；用户、项目、session 和 plugin lifecycle hooks 均不进入 EvolClaw thread，capability 配置也不能重新开启。
- `readonly` 对 command approval 再执行只读 allow-list，并拒绝 file change 和 permission grant。
- `auto` 自动允许非危险 command 和 workspace 内具体 file change；带 `grantRoot`、目标越过 workspace、permission grant、managed-network approval 或 command `additionalPermissions` 时直接拒绝。
- `request` 将 Codex 发出的 command、file change 和 permission request 交给 PermissionGateway。
- `bypass` 自动允许常规 command request 和 workspace 内具体 file change；危险命令、带 `grantRoot` 或目标越界的 file change、permission grant、managed-network approval 和 `additionalPermissions` 仍交给 PermissionGateway。
- permission grant 只返回原请求中的精确 permissions，scope 固定为 `turn`；command 和 file change 只返回单次 `accept`。
- 每次 start/resume/compact resume/fork 前先调用 `config/read`，以可写配置键白名单重建 MCP transport：本地 stdio 和未知 transport 保留精确 transport 但强制 `enabled=false`，避免仅覆盖 `{enabled:false}` 因 app-server 的替换语义丢失 transport、报 `invalid transport`；规范化结果中的 `null` 和只读派生字段不能原样回注。
- `readonly/auto` 在 lifecycle config 中同时关闭远程 MCP 和 apps；`request/bypass` 才允许远程 MCP/apps 启动，并强制 `default_tools_approval_mode=prompt`、所有已知 per-tool override=`prompt`、reviewer=`user`。已安装 plugin 通过 `plugin/installed` + `plugin/read` 枚举 bundled MCP 并逐个禁用；清单、详情或 marketplace 加载不完整时在 thread 创建前失败关闭。
- app/MCP 副作用审批由前序 `item/started` 的精确 `mcpToolCall` 与 `item/tool/requestUserInput` 关联；指纹包含 server、tool、arguments、plugin/app resource/context 和有效外部配置哈希。缺跟踪项、缺精确 arguments、缺 workspace/Gateway/配置绑定时回答 Decline/Cancel。允许时只选择可验证的单次 Accept；若 Codex 只提供 session/always 选项，也按拒绝处理，30 分钟复用只由 EvolClaw Gateway 管理。
- command approval 的 `networkApprovalContext`、网络策略变更和额外权限全部进入审批指纹；file change 从先到达的 `item/started` / `patchUpdated` 恢复实际变更路径，不能用空请求复用 30 分钟授权。
- legacy `execCommandApproval` 的原始 argv 边界也进入指纹；不同参数分组即使拼接后文本相同，也不能复用临时授权。
- FileChange 是否越界以 thread 记录并 canonicalize 后的 workspace 为准；目标路径解析现有祖先和 symlink 后再比较。command/grant 的 `cwd` 只用于解析普通相对权限路径，`project_roots` 特殊路径始终相对 thread workspace 解析；未记录 workspace 的 thread 审批直接拒绝，不接受 payload 自报的 `projectPath/cwd` 伪装边界。
- H 类 deny glob 设置 `glob_scan_max_depth`，避免 Linux/WSL/Windows 接受 `**` 规则却不做有界预展开。
- Linux 上 app-server 外层使用 bubblewrap 屏蔽 H 类真实内容和宿主 `/run`，避免工具协议以外的读取旁路及 Docker/Podman/containerd Unix socket 逃逸；若 `/etc/resolv.conf`、`hosts` 或 `hostname` 指向 `/run`，只回挂对应精确文件，不重新暴露同目录 socket。
- 所有普通 Agent 运行都保留 Codex 内建工具；`readonly` 通过 named profile 和审批桥限制工具，而不是尝试删除工具。

Codex 的 `request` 有效。旧实现使用 `approvalPolicy=never` 和 `danger-full-access`，操作不需要升级，因此 app-server 不会产生 approval request；Gateway 虽已注册却没有事件可处理，这就是旧版“审批不可达”的根因。

公开依据与版本边界：

- [Advanced Configuration](https://developers.openai.com/codex/config-advanced) 定义 `untrusted / on-request / never`、sandbox 配置和 `approvals_reviewer`；[Auto-review](https://developers.openai.com/codex/sandboxing/auto-review) 明确 `approval_policy=never` 时没有可审核请求，reviewer 只处理本来就需要审批的动作；安全模型总览见 [Sandboxing and approvals](https://developers.openai.com/codex/agent-approvals-security)。
- [Permissions](https://developers.openai.com/codex/permissions) 定义 named profile、deny glob 和 `glob_scan_max_depth`，并说明 profile 与旧 `sandbox_mode` 不组合。EvolClaw 通过 app-server 的显式 `permissions` 字段选择 profile；Codex 0.144.1 实际协议探针确认该显式选择不会被同一配置中的旧 `sandbox_mode` 覆盖。
- [Codex App Server](https://developers.openai.com/codex/app-server) 公开 command/file change 的 server-initiated approval 协议，并明确网络目标位于 `networkApprovalContext`、file change 目标先由 `item/started` 给出；app 副作用审批通过 `item/tool/requestUserInput` 给出 Accept/Decline/Cancel，拒绝后相关 `mcpToolCall` 不执行。
- [MCP](https://developers.openai.com/codex/mcp) 和 [Configuration Reference](https://developers.openai.com/codex/config-reference) 定义 stdio/HTTP transport、`enabled`、server/per-tool approval mode 及 plugin-bundled MCP 覆盖。0.144.1 真实进程探针确认 EvolClaw 的完整 transport + `enabled=false` 配置可以创建 thread，且恶意 stdio 哨兵不会启动。
- [Hooks](https://developers.openai.com/codex/hooks) 明确 hooks 默认开启、多个配置层会累加，且 `features.hooks=false` 是关闭入口。0.144.1 对照探针确认同一已加载 hook 在开启时执行、关闭时不执行；真实 app-server thread 探针确认该 config override 可被接受。
- `item/permissions/requestApproval`、thread/turn 的 `permissions` 字段和 permission grant 响应目前以本机 Codex CLI 0.144.1 生成的 v2 JSON Schema 与真实协议探针为准；它们尚未在上述 App Server 页面完整公开，因此升级 Codex 时必须重新生成 schema 并运行协议测试。

### 5.3 Gemini CLI 0.38.0 headless

- headless 模式没有可接入 EvolClaw 的异步 tool approval callback。
- `readonly` 使用 `approval-mode=plan` 和临时 Admin policy，只允许已知只读工具及身份已授权的严格 EC ctl 命令，其余工具拒绝。
- `auto` 使用 `approval-mode=auto_edit`，允许列入策略的常规读写工具；Shell、`ask_user`、未知工具和 MCP 工具默认拒绝。身份已授权的严格 EC ctl 命令例外放行。
- 不使用 `--yolo`。
- `request` 和 `bypass` 在 runner 能力列表中标记 unavailable；历史或角色默认值命中时降级为 `readonly`。
- Linux 上外层 bubblewrap 使 workspace 可写、其他路径只读，屏蔽 H 类路径并使用私有 `/run`；没有外层运行时时回退到 Gemini `--sandbox`。
- 如果系统级 Gemini Admin policy 会覆盖临时策略，则本轮拒绝启动。

要让 Gemini 完整支持 `request/bypass`，需要改用 Gemini ACP，并把 tool approval request 接入 PermissionGateway。

### 5.4 无状态纯文本推理

- session-renew 连续性判断固定调用独立 Claude `TextInferenceProvider`，不进入 `AgentRunner`，也不创建或恢复 Claude/Codex Agent 会话。
- 该接口没有 project path、session id、工具、MCP、hook、权限模式或会话持久化参数；先通过 Claude Models API 选择列表中最新的 Haiku，再直接调用 Messages API。
- provider 只复用当前 EvolAgent effective config 的 Claude 模型网关地址和凭证。列表中没有 Haiku、凭证不可用或请求失败时，调用方按显式 fallback 策略处理。
- 纯文本推理不能作为普通用户任务入口；普通用户任务始终保留工具，由 `readonly` 等公开权限模式限制工具能力。

## 6. H 类绝对边界

H 类包括 EvolClaw 主配置（`evolclaw.json` 及遗留 `config.json`）、agent/关系配置、`agents/<aid>/contact.json`、配置备份、快照、CA、AID 证书和密钥、`.env`、device/seed/lock/pid 及迁移残留文件。

边界采用多层防护：

- runner 语义层检查工具路径、Shell 引用、FileChange、permission profile 和额外权限。
- Codex filesystem grant 的 path、glob、`project_roots.subpath` 和 unknown special path 都按真实范围检查，不能利用未识别的 schema 分支绕过 H 类判定。
- Claude SDK sandbox、Codex named profile、Gemini Admin policy 拒绝 H 类访问。
- Linux 外层 bubblewrap 对已有 H 类文件使用空文件或 tmpfs mask。
- symlink 使用真实存在祖先解析，父目录和 glob grant 按权限范围拒绝。
- `EVOLCLAW_HOME` 本身为 symlink 时，语义检查、deny glob 和外层 mask 统一使用 canonical root，不留真实路径别名。
- EC 文件命令在执行前检查 H 类路径。
- daemon 代上传文件时再次检查 H 类路径，不能利用 daemon 的高权限读取。

H 类拒绝发生在 PermissionGateway 之前，因此不存在“人工批准后放行 H 类”的路径。

## 7. EC 命令与任务 delegation

特权 EC 路径只接受单个 literal argv 调用。变量展开、命令替换、pipeline、重定向、glob、脚本包装和不确定文件参数全部拒绝。

任务内 `msg/group send|file`、`ctl`、config 和 `handoff return` 使用 `EVOLCLAW_DELEGATION_TOKEN`。daemon 校验 token 是否仍为当前任务有效，并绑定：

- EvolClaw session 和 task；
- self AID 和 origin message；
- 每次请求的目标 peer/group 及发起者角色对应的 operation 权限。

任务内 AUN 私聊、群聊和文件上传必须走 daemon IPC。daemon 不可达、身份不匹配或尝试覆盖短连接参数时失败关闭，不回退到未鉴权短连接。文件由 daemon 长连接上传，上传前再次执行 H 类检查。

## 8. 验证要求

权限变更至少覆盖：

- 四种公开模式和历史值迁移；
- 角色默认值及未知角色 `readonly` fallback；
- Claude 真实 `PreToolUse` 和 `canUseTool` 路径；
- Codex thread/turn profile、reviewer 和三类 approval request/response；
- Claude/Codex MCP 生命周期：stdio 不启动、远程 MCP/app 模式开关、tracked `mcpToolCall` 精确审批、持久 Codex 选项降级拒绝及外部配置变更后授权失效；
- Claude/Codex hook 生命周期：磁盘/plugin hook 不执行、Claude 宿主权限 hook 保留、内部 compact/clear/rewind 入口不重新加载 hooks；
- session-renew 只调用无状态 Claude 普通模型 API，请求中不出现工具或 Agent 会话字段，并覆盖 Models API 精确名称校验；
- Gemini argv、Admin policy、真实 CLI policy 解析和 sandbox argv；
- Bash、FileChange、permission profile、symlink、父目录和 glob 的 H 类拒绝；
- 30 分钟授权的同输入命中、不同输入/不同 session 不命中及过期；
- 缺少 owner、requester、adapter、Gateway 或 operator identity 时失败关闭；
- delegation token 的跨 session、跨 message、跨 sender、跨 target 和文件操作升级拒绝；
- daemon 不可达时不回退短连接。
