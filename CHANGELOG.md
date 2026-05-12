# Changelog

## v2.6.2 (2026-05-11)

### Improvements

- **AUN 群组 ID 新格式** — 支持 `group.{issuer}/{group_no}` 和纯数字群号格式，兼容旧 `grp_`/`g-` 前缀
- **AUN 群消息明文传输** — 群聊消息禁用 E2EE（`encrypt: false`），对齐协议规范
- **AUN welcome 消息持久化** — 首次欢迎消息使用 `persist_required: true` + 3s PKI 延迟，确保 Owner 证书就绪后可靠送达
- **`/chatmode` 权限下放** — 查看模式对所有人开放；群聊设置仍限管理员，单聊任何角色可设置
- **`/status` 显示会话模式** — 输出当前 interactive/proactive 状态及通道锁定标记
- **系统提示 self/peer identity** — 注入 Agent 自身名称+AID 和对端名称+ID，增强上下文感知
- **Thought ctl 命令可观测** — `evolclaw ctl send/file` 在 thought 中显示完整命令内容

---

## v2.6.1 (2026-05-11)

### Improvements

- **Thought 协议对齐 task_id** — `ChannelAdapter.putThought` / `sendProcessingStatus` 由 `replyToMessageId` 改为 `taskId`，对齐服务端 selector 协议（`context: {type: 'task', id}`）；同一次任务处理的所有 thought / 状态事件共享一个 `task-{10hex}`，replies/history 查询更精确
- **AUN dispatch_mode 分派** — 群聊接收服务端下发的 `dispatch_mode`：`mention` 模式仅在 @ 时响应，`broadcast` 模式响应全部消息；@mentions 字段也精简为只在 mention 命中时回填
- **SKILLS.md 实时刷新** — `data/SKILLS.md` 提示不再在进程内缓存，每次从磁盘读取；用户编辑 SKILLS.md 后立即生效，无需重启
- **AUN SDK 升级** — `@agentunion/fastaun` 0.2.14 → 0.2.15
- **event-bus 精简** — 移除 `message:new-inbound` 事件（task_id 取代了动态切换 replyTo 的需求）

### Bug Fixes

- **Thought 重复摘要** — proactive 模式下，流式 text 已推送过 thought 时，complete.result 不再重复发送最终 summary
- **Tool 结果空值** — `ToolResult` 返回内容为空时只输出 `✅ toolName`，不再拼接空字符串

---

## v2.6.0 (2026-05-08)

### New Features

- **Proactive session mode** — AUN 群聊支持主动会话模式，Agent 可主动发起对话而非仅响应
- **Menu protocol v2** — 服务端多级菜单协议，支持嵌套菜单结构和动态菜单生成
- **ExitPlanMode approval** — Plan 模式新增审批流程，移除超时机制，改为显式确认
- **AUN welcome message** — 首次连接 AUN 网络时自动向 Owner 发送欢迎消息并初始化 agent.md
- **CLI --version flag** — `evolclaw --version` / `-v` / `-V` 输出版本号
- **pathToClaudeCodeExecutable** — 支持在配置中显式指定 Claude Code CLI 路径（SDK 自动发现失败时的 escape hatch）

### Improvements

- **Windows IPC named pipe** — Windows 下 IPC 从 Unix socket 切换为 named pipe（`\\.\pipe\evolclaw-<hash>`），解决 EACCES 权限问题，支持多实例隔离
- **AUN init 全链路健壮性** — CA 下载与 agent.md 写入解耦；重建 client 显式传 `root_ca_path` + `aid`；本地写入后 existsSync 校验
- **Channel SDK 按需加载** — 重型渠道 SDK 移入 optionalDependencies，未安装时优雅跳过
- **`/send` → `/file` 重命名** — 文件发送命令统一为 `/file`，语义更清晰
- **AUN agent display name** — 从 owner 的 agent.md 派生显示名，而非 AID 前缀

### Bug Fixes

- **AUN init CA verification** — 修复首次 init 时 uploadAgentMd 报 "no trusted roots available"（SDK 需显式 root_ca_path）
- **AUN init identity** — 修复重建 client 后 uploadAgentMd 报 "no local identity found"（需传 aid 参数）
- **Feishu empty config** — appId/appSecret 均为空时不再输出无意义的验证警告
- **Message recall interrupt** — 消息撤回事件正确触发 'recalled' 中断类型
- **CLI unknown channel** — `evolclaw init <unknown>` 现在报错并列出支持的渠道，而非静默失败

---

## v2.5.0 (2026-04-28)

### New Features

- **DingTalk channel** — 钉钉 Stream 模式集成，支持文本/图片/文件收发，自动去重，Markdown 转纯文本
- **QQBot channel** — QQ 频道机器人集成（pure-qqbot SDK），支持文本/图片/文件收发，自动去重
- **WeCom channel** — 企业微信 AI Bot 集成，完整 channel plugin 支持（624 行，`evolclaw init wecom` 配置）
- **Agent self-management (ctl)** — Agent 可通过 `evolclaw ctl <cmd>` 管理运行时：切换模型、调整推理强度、查看状态、压缩上下文、管理权限、发送文件、重启渠道。命令白名单 + 路径沙箱保护
- **Session rewind** — `/rewind <turn>` 回退会话到指定轮次，支持文件快照恢复（dryRun 预览 + 实际回退）
- **Admin role** — 新增 admin 角色（owner 之下），支持分级权限控制（user/admin/owner）
- **AUN file attachments** — AUN 私聊/群聊支持文件附件收发，SHA256 校验，自动下载到项目 `.evolclaw/uploads/`
- **AUN protocol v2** — 结构化 payload 格式 `{type, text, thread_id}` 替代扁平 text+task_id；事件化处理状态；通过 agent.md 解析 peer info（30min TTL 缓存）
- **`/agentmd` command** — 查看、发布、管理 AUN 网络上的 agent.md（`/agentmd`、`/agentmd put`、`/agentmd set <内容>`）
- **Message recall → interrupt** — 撤回消息现在会中断正在执行的任务（所有渠道，不仅飞书）
- **AskUserQuestion action cards** — 问题卡片从表单模式升级为 action card（按钮模式），已解决卡片保留正文

### Improvements

- **Permission refinements** — `/check` 提升为 user 级（guest 看摘要，admin 看详情）；`/activity` 查看降为 admin（切换仍需 owner）；`/restart <channel>` 重连渠道（admin+），`/restart` 重启服务（owner only）
- **SKILLS.md global placement** — 从项目级 `.evolclaw/` 迁移到全局 `{EVOLCLAW_HOME}/data/SKILLS.md`，懒加载 + semver 版本管理 + trigger 字段提供更好的 agent 上下文
- **AUN peer info display** — `peerType` 字段独立于 `peerName`（不再是 "name (type)" 格式）；仅在 peerType 非 'unknown' 时显示到系统提示
- **System prompt optimization** — 提取 SKILLS.md frontmatter description 生成简洁 ctl 提示；记录 systemPromptAppend 预览（前 100 字符）
- **AUN SDK upgrades** — 升级到 aun-core 0.2.9，强化群聊回声去重 + SDK 兼容性；well-known discovery 用于网关 URL 解析
- **AUN CLI enhancements** — 静默模式（`-s`）、文件管理（`//sendfile`、`//history`）、群组管理（`//qid`）、AID 快速切换（`//aid`）
- **Post-interrupt error suppression** — 用户主动中断后的 SDK telemetry 噪音不再记录为错误
- **`/rewind` improvements** — DryRun 预览 + 实际回退，改进日志和错误消息
- **Dynamic error handling** — 运行时错误字典（`data/error-dict.json`），支持热更新和模式匹配

### Bug Fixes

- **AUN CLI unread count** — 切换目标时自动 mark_read；自动补全中隐藏当前目标未读数；移除底部工具栏冗余未读计数
- **AUN CLI message dedup** — 内存级去重（500 条 LRU 缓存）防止 SDK 重复触发竞争窗口
- **AUN tests async** — 群聊/私聊消息处理测试加 async/await（fetchPeerInfo 是异步的）
- **Tests version control** — 从 `.gitignore` 移除 `tests/`（测试应纳入版本控制）

---

## v2.4.0 (2026-04-18)

### New Features

- **AUN CLI overhaul** — 全面重构 AUN 命令行客户端：文件传输（`//sendfile`）、消息历史（`//history`）、群组管理（`//qid`）、AID 快速切换（`//aid`）、数据日志查看器（`aun --log N`，支持 JSON 高亮和跨天轮转）
- **AUN SDK monkey-patches** — 修复 E2EEManager 三个 bug：`clean_expired_caches` 缺失、GroupE2EEManager `_prekey_cache` 引用错误、`sender_fingerprint` 错误 fallback 到 SPKI
- **AUN group ID format** — 支持 `g-xxx.agentid.pub` 格式的群组 ID 识别
- **AUN @mention extraction** — 群聊中支持 `@aid` mention 补全和提取

### Improvements

- **Interactive card lifecycle** — 发送新交互卡片时自动作废旧卡片（PATCH 置灰 + 取消回调），统一 `sendInteractionCard` 流程
- **`patchInteractionCard` adapter** — ChannelAdapter 和 FeishuChannel 新增卡片 PATCH 能力，`sendInteraction` 返回 `message_id`
- **Reply context per-message** — `replyContext` 从 session 级改为 message 级（跟着任务走），修复中断后回复上下文丢失和话题路由问题
- **`evolclaw logs` enhanced** — 彩色日志渲染、`--level`/`--module` 过滤、`--raw` 原始模式、长消息自动截断（200 字符）
- **StreamFlusher `hasText`** — 仅在含真实文字时消费 `replyToMessageId`，避免纯工具活动消息占用引用
- **Permission mode at creation** — 会话创建时即写入默认权限模式（owner → bypass，guest → readonly），无需运行时推断
- **`/effort` quick command** — `/effort` 加入快速命令路径，不再进入消息队列
- **`/project` `/agent` idle guard** — 加入 `requiresIdle` 列表，处理中不允许切换
- **AUN dep version check** — 依赖检查从缺失检测升级为版本比对（`aun-core>=0.2.4`），版本过低自动升级
- **AUN group commands simplified** — 群命令表从 20+ 扁平命令精简为 7 个分类入口（list/info/user/join/setup/group/quit）
- **AUN send result stripping** — 精简 SDK send 返回值，剔除 E2EE 密文 payload 和重复 event 块

### Bug Fixes

- **Vitest external project exclusion** — 排除 `projects/**` 外部项目测试，避免缺失依赖导致测试失败
- **AUN acknowledge behavior** — acknowledge 不再发送 RPC `message.ack`（网关自动 delivery-ack 已足够），避免发送端重复"已送达"

---

## v2.3.0 (2026-04-15)

### New Features

- **Interactive card UI** — `/perm`、`/model`、`/effort`、`/agent`、`/plist`、`/slist` 命令在飞书中以交互卡片呈现，支持一键操作，不支持卡片的渠道自动降级为纯文本
- **`/effort` command** — 独立的推理强度控制命令（从 `/model` 拆出），支持交互卡片选择
- **Readonly permission mode** — 只读权限模式，拦截所有写入操作（文件写入仅允许 `.evolclaw/tmp/`，Bash 写入命令黑名单）
- **Multi-instance channel support** — 同一渠道类型可配置多个实例（如多个飞书 bot），每个实例独立会话和配置
- **CLI session listing** — `/slist cli` 列出未导入的 CLI 会话，支持卡片一键导入
- **Gemini session resume** — Gemini 后端支持会话恢复（`-r sessionId`）

### Improvements

- **Card lifecycle management** — 发送新卡片时自动作废旧卡片（PATCH 置灰 + 取消回调），避免过期卡片误操作
- **Permission mode defaults** — 会话创建时即写入默认权限模式（owner → bypass，guest → readonly），无需运行时推断
- **Reply quote precision** — StreamFlusher 仅在含真实文字时消费 replyToMessageId，避免纯工具活动消息占用引用
- **InteractionRouter** — 通用交互路由器，管理卡片回调注册、超时清理、会话级取消
- **Channel routing refactor** — session.channel 存储实例名（非渠道类型），多实例场景精确路由
