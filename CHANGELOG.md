# Changelog

## v2.9.0 (2026-05-14)

### New Features

- **EvolAgent Mode** — 一等 agent 实体：一个 JSON 文件自包含 channels + baseagent + project + chatmode。多 agent 并发运行，各自独占 channel 资源
  - `evolclaw agent` CLI：list / show / new / reload
  - Channel fingerprint 冲突检测（启动时 + 热重载时）
  - 完整热重载：drain → disconnect → reconnect → route-update + rollback on failure
  - 凭证变更检测：kept channel 配置变化自动重连
  - Owner 自动绑定写回 agent.json
  - 命令拦截：agent-owned channel 上 /project /bind /plist /agent-switch 禁用
  - DefaultAgent 兜底处理 evolclaw.json channels
  - AgentRegistryHandle 类型接口（IPC/MessageProcessor/CommandHandler 类型安全）
  - Real drain via MessageQueue.isChannelProcessing（30s timeout + 100ms poll）

### Improvements

- **Channel Fingerprint** — `{type}:{primaryKey}` 统一格式，启动时检测 evolclaw.json 内重复凭证
- **ChannelLoader 幂性** — 验证 createAll 可安全多次调用（evolagent multi-source 基础）
- **Orphan session 检测** — `evolclaw status` 显示孤儿 session 总数
- **baseagent key 统一** — config.agents.{anthropic,openai,google} → {claude,codex,gemini}，启动时自动迁移

---

## v2.8.0 (2026-05-13)

### New Features

- **交互式 `/ask` 命令** — AskUserQuestion / ExitPlanMode 不再自动选第一个选项，注册到 `interactionRouter` 等待用户通过 `/ask` 回复；proactive 模式下系统提示明确禁用这两个工具
- **AUN 群聊 proactive 入站白名单** — proactive 模式下，仅放行规范 payload 类型（text/quote/image/video/voice/file/json/merge/link/location/personal_card），且必须显式 @ 自己或 @ all；其它消息直接 ack 丢弃，避免无差别介入群聊
- **E2EE 加密状态透传** — 入站 E2EE 加密状态通过 `ReplyContext.metadata.encrypted` 透传到出站发送，AUN 通道逐消息镜像加密态（包括 `thought.put`，不再硬编码 `encrypt=true`）
- **`execMenu()` 结构化菜单执行** — 为 `/perm`、`/chatmode` 等命令提供结构化查询 / 更新接口，便于 Agent 程序化改配置

### Improvements

- **`processing_state` 持久化 taskId** — Session 级保存当前处理任务的 `taskId`，`evolclaw ctl send` 可从上下文自动恢复
- **fastaun 依赖升级** — `@agentunion/fastaun` 从 0.2.15 升至 0.2.17

---

## v2.7.3 (2026-05-13)

### Bug Fixes

- **多 channel 并发时 AskUserQuestion 路由修复** — `sendPromptFn` 是全局单例，多 channel 同时活跃时会被覆盖导致提示发到错误 channel；现改为从 `permCtx.adapter/channelId` 构造 per-session 发送函数，确保交互卡片始终路由到正确 channel

## v2.7.2 (2026-05-13)

### Bug Fixes

- **`/stop` 命令对所有角色开放** — guest/AUN Agent 现在可以中断自己的任务，不再被权限拦截
- **`/perm` 显示修复** — 新会话的默认权限模式显示统一为 bypass，不再因角色不同而显示 auto

## v2.7.1 (2026-05-13)

### Bug Fixes

- **默认权限模式统一为 bypass** — 所有角色（owner/admin/guest）新建会话时默认使用 bypass 模式，避免 SDK AI 分类器拦截 `evolclaw ctl send` 等命令
- **Windows 实时日志修复** — `evolclaw logs` 在 Windows 上改用 `fs.watchFile` 轮询替代 `fs.watch`，解决跨进程 append 场景下日志不滚屏的问题
- **Feishu 回复上下文修复** — `replyContext` 仅在话题消息中设置，避免普通消息误带 thread 回复上下文

## v2.7.0 (2026-05-13)

### Breaking Changes

- **Config key rename** — `evolclaw.json` 的 `agents.anthropic` / `agents.openai` / `agents.google` 重命名为 `agents.claude` / `agents.codex` / `agents.gemini`，与 runner name 对齐。启动时 `loadConfig` 自动迁移旧 key 并回写 evolclaw.json，用户无需手动修改；同时 warn 日志提示迁移已发生。
- **Channel-level sessionMode 移除** — 通道实例配置中的 `sessionMode` 字段废弃，改由全局 `config.chatmode.{private,group}` 统一控制（不设时默认 `interactive`）。原先 AUN 群聊"默认 proactive"的硬编码逻辑也一并移除，需要的用户显式设置 `chatmode.group = "proactive"`。

### New Features

- **`chatmode` 全局配置** — `config.chatmode.private` / `config.chatmode.group` 分别控制单聊/群聊的默认会话模式，替代通道级 `sessionMode` 锁定
- **`debug.logLevel` 配置项** — 日志级别优先级：`config.debug.logLevel → LOG_LEVEL 环境变量 → 'INFO'`，无需重启即可通过 reload config 调整
- **orphan session 统计** — `evolclaw status` 显示通道已下线但会话仍残留的条数（按通道分组），帮助识别配置变更后的陈旧数据
- **通道指纹去重检测** — 启动时检测 Feishu/QQBot/WeCom 等通道的 `appId` 是否跨实例重复配置，冲突时输出 warn 日志（跨通道类型不算冲突）
- **`projects.autoCreate` 生效于 `/bind`** — 配置开启时，`/bind <path>` 遇到不存在的目录自动创建

### Improvements

- **`evolclaw ctl send/file` 全权限放行** — Claude Runner 在任何权限模式（含 readonly/noask/auto）下都不拦截这两个命令，proactive 模式 agent 可靠发送消息的前提
- **默认权限模式收敛** — guest/admin 统一为 `auto`（原 guest 为 `noask`），owner 仍为 `bypass`；`/perm` 无参查询和 MessageProcessor 初始化同步
- **AUN RPC 统一 trace** — 新增 `callAndTrace` 包装所有 `client.call`，成对记录 `OUT`/`OUT.ok`/`OUT.error`；auth.authenticate、client.connect、client.close、storage.create_download_ticket 全部走统一链路
- **AUN 日志分级** — `message.received` / `group.message_created` 等高频 DIAG 日志从 info 降为 debug；新增 `P2P dispatched` / `Group dispatched` / `Group missed` 等结构化关键路径日志
- **单 agent/channel 推断** — `validateConfigIntegrity` 在只有一个 agent 或 channel 时不再要求显式 `defaultAgent`/`defaultChannel`
- **SDK fallback 消息兜底** — 识别 Claude SDK 本地拦截的 "Unknown skill: xxx" 等预处理消息，proactive 模式下主动发送给用户，避免无反馈
- **命令快速路径补全** — `/rewind`、`/rw`、`/activity`、`/chatmode`、`/aid`、`/agentmd` 加入 quick command prefix 白名单，确保不进入消息队列
- **`/perm` 切换后自动刷新** — 切换权限模式成功后重新发交互卡片（自动 invalidate 旧卡片），UI 状态实时一致

### Bug Fixes

- **config validation 误报** — 多 agent 场景下的 `defaultAgent` 校验逻辑修正，避免对仅有一个 agent 的最简配置误报
- **通道指纹重复告警守卫** — 仅在 `duplicates.length > 0` 时输出 warn，避免日志噪音

---

## v2.6.4 (2026-05-11)

### New Features

- **Prompt 模板化** — 系统提示从硬编码迁移到模板文件（`src/templates/prompts.md`），支持用户级覆盖（`{EVOLCLAW_HOME}/data/prompts.md`）；`runtime`/`group`/`proactive` 三段分别控制，支持 `{{var}}` 变量和 `{{?cond}}…{{/}}` 条件段
- **Gemini noask 模式** — 映射到 `--approval-mode=default`，Gemini CLI 现支持静默模式

### Improvements

- **Readonly 模式暂时禁用** — 所有 Agent 后端（Claude/Codex/Gemini）下线 `readonly` 权限模式，与 proactive 模式系统提示词语义冲突；READONLY_WRITE_PATTERNS 未覆盖 `evolclaw ctl send/file`，契约不稳固
- **默认权限模式调整** — 新逻辑：`owner → bypass / admin → auto / guest → noask`（历史会话 `readonly` 自动迁移至 `noask`）
- **日志可观测性增强** — MessageProcessor 事件日志附带 text/tool 摘要；AUN `thought.put` 成功/失败、`task.status` 发送均有结构化日志；ThoughtEmitter 创建时记录 channel/task/chatmode

---

## v2.6.3 (2026-05-11)

### New Features

- **AUN E2EE 自适应降级** — 发送消息时自动探测对端加密能力：首次尝试 E2EE，遇 `E2EEError` 自动降级明文重发并缓存结果（10min TTL），后续直接走明文通道
- **命令权限读写分离** — `/model`、`/agent`、`/effort`、`/perm`、`/activity` 等命令无参查询对所有人开放，带参切换仍需管理员权限；guest 在群聊/私聊中可查看运行状态
- **出站 payload 统一 task_id/chatmode** — 所有出站消息（text/file/thought/status）统一携带 `task_id` 和 `chatmode` 字段，便于客户端关联同一任务的全部消息

### Improvements

- **AUN SDK 日志开关** — 新增 `aunSdkLog` 配置项，控制 SDK 内部日志写入（默认开启）
- **AUN undecryptable 事件监听** — 监听 `message.undecryptable` / `group.message_undecryptable` 事件并记录告警
- **AUN init gateway 自动发现** — `createAidSilent` 和 `setupAunAid` 使用 `GatewayDiscovery` well-known 自动解析网关 URL，移除手动端口输入
- **交互卡片 idle 守卫** — 会话忙碌时不发送交互卡片（降级为文本），已弹卡片被点击时二次校验忙碌状态
- **idle 检查精细化** — 仅对写/破坏性命令要求 idle，纯读无参形态始终放行
- **AUN selfName 暴露** — adapter 新增 `_selfName()` 方法，系统提示可展示 Agent 自身名称
- **AUN send 结果校验** — `message.send` / `group.send` 返回值缺少 `message_id` 时记录告警

---

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
