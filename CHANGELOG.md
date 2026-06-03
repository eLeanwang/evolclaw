# Changelog

## v3.1.6 (2026-06-03)

### New Features

- **AUN 图片附件支持** — AUN 私聊/群聊附件中的图片自动检测（元数据/文件名/magic bytes 三重检测），base64 编码后直接传给 Agent，不再要求 Read 工具读取
- **selfAID session 注入** — 从 channel key 解析 selfAID，透传至 MessageBridge → CommandHandler → `getOrCreateSession`，修复 AUN 多身份场景 session 归属错误
- **watch-web 单实例保护** — 启动前清理旧实例（按 instance 文件 + 端口兜底），端口冲突时自动切换并提示；前端新增 token 失效自动回配对页、退出按钮、配对码过期刷新

### Improvements

- **init 流程优化** — `cmdInit` 一次性写入所有可用 baseagents（不只写选中的那个）；新增 projects 默认目录询问步骤；默认项目路径改为 `EVOLCLAW_HOME/projects`；取消 init 后自动进入 `agent new`，改为打印提示
- **1M 上下文窗口** — `claude-opus-4-8` / `claude-sonnet-4-6` 自动追加 `[1m]` 后缀，`autoCompactWindow` 随之调整为 900000
- **上下文用量追踪** — complete 事件新增 `contextUsage`（totalTokens/maxTokens/percentage），`usage` 字段重命名为 `tokenUsage`，随 `status.completed` 元数据下发
- **模型别名缓存 TTL** — 从 1h 缩短至 5min
- **`/cli` 远程透传** — 经消息通道远程执行 CLI，仅 owner 可用，白名单只读+配置命令，spawn 无 shell，15s 超时 + 128KB 截断
- **proximity ECK 注入** — `same_device/same_network/same_egress_ip` 从 V2 E2EE 解密结果提取，注入 venue.md 条件块渲染
- **fastaun 0.4.9** — 含 SPKI 双格式指纹匹配（0.4.8）和 watch-web 单实例相关修复（0.4.9）

### Bug Fixes

- **Feishu merge_forward 内容重复** — 直接转发时丢弃 quotedText，避免内容重复
- **Feishu seenMsg 文件写入** — 仅在有记录被 GC 清理时才重写文件；seenMessages 清空时改为 unlink
- **peer-identity 验签** — 新增 `agentmd-unverified` 来源；缓存命中时从 `verify_status` 恢复验签状态，修复 source 误降级
- **process-introspect** — 改用 `/proc/stat btime`（绝对 epoch）替代 uptime 计算进程启动时间，修复长时间运行后 PID 复用误判
- **evolagent.load IPC 超时** — AUN WebSocket 冷启动常 >3s，IPC 超时从默认值调整为 30s
- **交互路由 markWaiting/unmarkWaiting** — 新增提前占位方法，适配异步发卡片场景的等待计数

## v3.1.5 (2026-06-02)

### New Features

- **Web 监控面板（watch-web）** — 全新 `evolclaw watch` Web 面板：实时会话视图、对话视图、AID 状态、消息流，含上下文大小与费用估算；新增 `src/cli/watch-web/` server + 静态前端 + session/msg/aid 数据源
- **CLI model 命令** — 新增 `src/cli/model.ts`：动态模型目录管理，`/models` 端点拉取（1h 缓存）+ 静态表 fallback，注入已验证但未上线 API 的模型
- **飞书交互卡片 JSON 2.0 + 表单** — `FeishuCardManager` 管理 CardKit 实体生命周期，`buildActionCardV2()` 表单卡片，动态输入框追加（card.element.create API）
- **proactive→interactive 模式切换提示** — 模式切换时注入提示信息

### Improvements

- **AUN/AID 三主体模型重构** — fastaun 0.3.3 → 0.4.7 大版本跨越：适配三主体模型与 slot 隔离键，`createAid` 拆分为 `registerAid` + `authenticate`，新增 `AIDStore`，`uploadAgentMd` 迁移至 AIDStore
- **ECK 上下文组装体系对齐** — 四阶段改造：channelKey 第二段 `selfPeerId`→`selfAID`，sessions 目录统一三层化 `<channelType>/<selfAID>/<channelId>/`，新增 `peer-key.ts` helper，ECK manifest 诊断输出
- **Session 持久化重构** — 统一 `persistSession(session, intent, opts)` 原语替代 `writeSessionIfChanged`/快照模式，内置去重，`markProcessing`/`clearProcessing` 不再扫描全部 chat 目录
- **idle-check 消息队列可靠性** — 提升空闲检测与消息队列稳定性
- **飞书卡片 schema 2.0 统一** — 交互卡片统一为 schema 2.0 inline，用户交互期间暂停 idle monitor，修复 V2 卡片回调 schema 不一致（error 200830/200810）
- **IPC 出站统计** — 新增 `aun-aid-stats-record-outbound` IPC handler，p2p/group/thought.put 出站消息统计追踪
- **/model 列表逻辑简化** — `listModels` 走缓存，model 显示标签同时展示完整 ID 与短别名
- **清理冗余日志与代码** — 移除过时诊断日志和未使用的 skills 代码

### Bug Fixes

- **Trigger channelType 传播** — Trigger 新增 `targetChannelType` 字段，`buildSyntheticMessage` 正确填充 `channelType`，修复触发器消息无法创建 session
- **session selfAID/channelType 注入** — 修复 session 创建时 selfAID 与 channelType 注入缺失
- **/model 短别名解析** — `/model sonnet` 等短别名正确解析为完整 model ID
- **aidCreate 成功路径泄漏 AIDStore** — 修复 AID 创建成功后 AIDStore 资源泄漏
- **peer-identity type 解析** — 修复对端身份类型解析错误
- **飞书卡片标题重复 emoji** — 修复 resolved card 标题与 checkers summary 中的双 emoji
- **消息可靠性与 session 迁移** — 提升消息投递可靠性，改进 session 迁移逻辑
- **session-mapper 过滤 channelName** — `sessionToFile` 不再将 `channelName` 写入 metadata
- **resolveChatDirFromSession 严格校验** — 缺失 `channelType` 时抛出明确错误而非静默 fallback
- **test 脚本修复** — `package.json` test 脚本改为 `vitest run`

## v3.1.4 (2026-05-27)

### New Features

- **CLI help 系统重构 + ECK 注入** — 全新 help 子命令体系，ECK（EvolClaw Kit）注入机制重构，AID identity 管理命令
- **Menu 协议五动词拆分** — menu 协议拆分为 list/query/options/update/action 五个动词，命令收敛至 baseagent/session

### Improvements

- **npm-ops 去 CLI 依赖** — checkLatestVersion 改用 HTTP fetch 直接查 registry API，去除对 npm CLI 的运行时依赖
- **agent.md 适配 SDK 0.3.3** — 统一 aun_path 到 EVOLCLAW_HOME，适配最新 SDK 版本

### Bug Fixes

- **Session channelType 缺失修复** — 修复 channelType 缺失导致 chat dir 无法解析 + isBackgroundSession 同步化
- **SessionManager 查询路径 NPE** — 修复缺失 channelType 时的空指针异常

## v3.1.3 (2026-05-26)

### New Features

- **Menu 协议拆分为 5 动词** — `menu.list` / `menu.query` / `menu.options` / `menu.update` / `menu.action`，response 统一 `error.code` 透传（`NO_ACTIVE_SESSION` / `MISSING_VALUE` / ...），`name → cmd` 由 bridge 内部映射，AUN 白名单接纳全部 `menu.*` 类型
- **xhigh effort 档位** — Claude/Codex 新增 `xhigh` 推理强度档位，Codex 通过 `codex debug models` 动态拉取模型目录与各模型支持的 effort 列表
- **结构化 menu options 字段** — session 子菜单返回 `preview`（首条消息预览）/ `lastActive` / `agentSessionId` / `turns` 扩展字段，所有可选项菜单返回 `selected` 标记当前值

### Improvements

- **命令收敛** — 移除 `/plist` `/project` `/bind` `/agentmd` `/p` 别名；`/agent` 改为 EvolAgent 管理命令；baseagent 切换统一为 `/baseagent`（别名 `/base`）；`/aid` `/rpc` `/storage` `/evolagent` 改为 ctl 专属
- **execMenu 拆分** — `command-handler` 拆出 `execMenuQuery` / `execMenuUpdate` / `execMenuAction` 三入口，无活跃会话时多项 fallback 到 evolagent config（`/pwd` / `/chatmode` / `/dispatch` 等）
- **EvolAgent 持久化方法** — 新增 `setActiveBaseagent` / `setChatmodePrivate` / `setDispatch`，配置变更直接落盘
- **Codex 实例每次重建** — 通过 env 注入 `EVOLCLAW_SESSION_ID`，仅首轮拼接 `systemPromptAppend`，避免 resume 时重复污染历史
- **Agent plugin 启用判定** — `isEnabled` 改为按 `baseagents.<name>` 配置启用，Codex 额外检测 `@openai/codex-sdk` 是否可用，`init` / `agent new` CLI 同步该判定
- **context-too-long 提示文案** — 按 agent 是否支持 compact 区分提示，retry 后仍超长时清理 renderer 中混入的错误文本（新增 `IMRenderer.stripContextError`）

### Bug Fixes

- **Codex resume 历史污染** — systemPromptAppend 在 resume 轮次重复拼接到 prompt 头部，导致系统提示被反复写入对话历史

## v3.1.2 (2026-05-25)

### Improvements

- **`evolclaw status` 输出版本号** — status 显示 evolclaw 版本、fastaun 版本、PID
- **EvolAgent 热重载增强** — `loadNewAgent` 增加 channel fingerprint 冲突检测；支持 disabled↔enabled 状态转换的热重载
- **`evolclaw init` / `agent new` 体验** — 单 baseagent 自动选中跳过交互；agent.md 上传失败自动重试 3 次；defaults 已存在选 N 时不再强退；无 agent 时自动衔接 `agent new` 复用 readline；SDK 日志静默

### Bug Fixes

- **session 路径尾斜杠致 sessionId 丢失** — agent 配置 `projects.defaultPath` 带尾斜杠时，每条消息触发 `Invalid session file` 重置 sessionId，多轮对话失效；`encodePath` 编码前剥离尾随分隔符，`loadAgent` 自动 normalize 路径
- **EvolAgent reload 误断 AUN 连接** — reload 计算 newChannels 时未包含隐式 AUN，导致每次 reload 都把 AUN channel 归入 toRemove 断开
- **trigger 路由修复** — `/trigger` 命令现在从消息所属 agent 获取 scheduler/manager（而非固定 `runnableAgents()[0]`）。修复了通过 A agent 渠道创建的 trigger 被存到 B agent 目录的问题
- **飞书卡片回调 chatType 误判** — 卡片回调不再用 `oc_` 前缀盲推 chatType，由 session 继承；`card-trigger` 来源 chatType 置空避免覆盖
- **AUN interactive 模式重复发送** — interactive 模式不再重复 `thought.put`，只写入消息历史
- **npm 包文件缺失** — `package.json` files 字段改为 `*.md`（排除 CLAUDE.md），确保 CTL.md/TRIGGER.md/SKILLS.md 随包发布
- **测试稳定性** — wechat-media AES-ECB 错误密钥测试间歇性失败修复

## v3.1.1 (2026-05-24)

### New Features

- **status.progress 事件系统** — 新增实时进度事件，包含 activityType 和 outputTokens 元数据，支持工具调用进度追踪
- **/trigger update 命令** — 支持修改已有触发器配置

### Improvements

- **CLI 工具优化** — watch session/msg/aid 命令增强，agent list 表头国际化和动态列宽对齐
- **chatmode 机制增强** — 群聊强制 proactive 模式，PeerIdentityCache 初始化时创建 agentDir
- **消息流程梳理** — 优化消息监控和 AID 追踪，完善 task_id 诊断日志

### Bug Fixes

- **渠道 status.progress 处理** — 修复 Feishu、DingTalk、QQBot、WeCom、WeChat 五个渠道缺失 status.progress 事件处理
- **Feishu post 格式降级** — post 格式发送失败时自动降级为纯文本重试
- **im-renderer 错误抑制** — 抑制 context-too-long 错误输出
- **AUN agent 间消息 chatmode** — 修复 agent 间消息 chatmode 显示错误
- **turn counting 去重** — 修复 turn 计数重复，正确传递 outputTokens 到 tool_call progress
- **plan mode 显示优化** — 修复计划内容显示 + notice emoji 去重 + 命令输出精简

## v3.1.0 (2026-05-23)

### New Features

- **ECK 上下文系统重构** — 引入 `kit-renderer.ts` 替代旧 `templates.ts`，系统 prompt 按片段动态组装（baseagent/channel/identity/relation/runtime/venue）；新增 `eck_manifest.json` 声明 kit 结构，支持参数动态注入
- **`/upgrade` 命令** — 一键升级 evolclaw 到 npm latest，AUN SDK 同步自动升级
- **Feishu merge_forward 消息支持** — 合并转发消息类型解析，自动展开为多条消息内容
- **AUN quote 附件支持** — quote 消息携带附件时正确解析并传递给 Agent
- **CTL 白名单扩展** — `/trigger`、`/chatmode`、`/dispatch`、`/activity` 加入 `ctl` 可调用命令列表
- **agent.md description 保留** — AID 重初始化时保留用户自定义 description，不再覆盖为默认值
- **启动版本信息** — `evolclaw start` 成功后显示 evolclaw 版本号和 fastaun 版本号

### Improvements

- **`ec` 命令** — 新增 `bin/ec.js` 快捷入口，`link-rules` 命令调优
- **`evolclaw watch-msg`** — 优化消息监控命令，支持更多过滤选项
- **`evolclaw bench`** — 性能测试命令完善
- **`agent/aid --help`** — 支持 `--help`、`-h` 标志，不再只识别 `help` 子命令
- **task_id 诊断日志** — 新增 task_id 追踪日志，便于消息关联排查
- **activity 工具摘要统一** — Bash desc 与工具摘要显示格式统一

### Bug Fixes

- **proactive chatMode 持久化** — AI peer 的 proactive chatMode 跨会话正确持久化，session 写入去重
- **permission timeout 修复** — 权限超时处理 + agent context 全局 chatmode fallback
- **error-utils 字典路径修复** — bundled dict fallback 路径修正
- **AUN CommandCard 群聊点击身份丢失** — 群聊卡片点击时 initiator 身份正确传递
- **AUN group.send message_id 提取** — 所有路径完整提取 message_id
- **context-too-long 检测增强** — 新增文本 fallback 触发 compact，避免漏检
- **session activeTask 保留** — updateSession 写入时不再丢失 activeTask 状态
- **permission diff 渲染** — 使用 Unicode diff 标记和真实行号，Feishu 渲染正确
- **activity 多行工具描述** — 标题单独一行渲染，不再与内容混排

---

## v3.0.0 (2026-05-20)

> Major release: 重构存储后端、统一出站消息协议、引入触发器与交互卡片体系。
> 旧 SQLite 时代代码归档于仓库 `evolclaw_db`（tag `v2.8.3-db-final`，commit `a7c5e19`）。

### Breaking Changes

- **Session 存储后端切换** — 从 SQLite 迁移到文件系统：`data/sessions/<channelType>/<encoded-id>/` 目录布局，每个 chat 含 `active.json` + `meta_*.jsonl` + `messages.jsonl` + `health.jsonl` + `_threads/`。`sessions.db` 已弃用，启动时 warn 提示用户手动删除。
- **Config key rename**（v2.7.0 起逐步推进）— `evolclaw.json` 中 `agents.{anthropic,openai,google}` 重命名为 `agents.{claude,codex,gemini}`，启动时自动迁移并回写
- **Channel-level sessionMode 字段废弃** — 改由 `config.chatmode.{private,group}` 全局控制
- **AUN channel 隐式化** — 不再需要在 `channels[]` 中显式声明 AUN，从 agent.aid 自动派生
- **`evolclaw.pid` 文件淘汰** — 替换为 `data/instance/main-<pid>.json` 实例登记机制

### New Features

- **触发器系统** — Agent 可自主设置延迟 / 定时 / 周期任务（`/trigger` 命令），支持 cron 表达式；触发器在独立 silent session 中执行，发布 `trigger:completed` 事件
- **交互卡片二分体系** — `CommandCard`（按钮直接触发 slash 命令）+ `ActionInteraction`（按钮回写 InteractionRouter）；Feishu 与 AUN 统一支持，旧卡片新卡发送时自动作废为"已过期"灰色卡片
- **EvolAgent 重构** — v2.8.3 引入的 EvolAgent 在 v3.0.0 大幅扩展：完整热重载（drain → disconnect → reconnect → route-update + rollback on failure）；per-agent runner 实例 + per-agent credentials 真正隔离；channel fingerprint 跨实例冲突检测
- **出站消息统一协议** — 命令回显 / 系统通知 / interaction 全部走 `adapter.send` 统一入口，`OutboundPayload` 结构化
- **/dispatch 命令** — 群聊分发模式切换：`mention`（仅@响应）/ `all`（广播响应）；proactive 模式 mention 过滤统一由 dispatchMode 决定
- **AUN write-ahead outbox** — `data/outbox/<aid>.jsonl` 写前持久化（每 AID 上限 20 条 / TTL 5min），断网期间消息不丢，重连后 drainOutbox
- **`evolclaw watch` 命令** — 聚合 tail 所有 `*.log`，颜色区分文件、JSON 行特殊渲染、AUN 多格式 JSON 解析（消息/事件/trace）、ESC 退出
- **`evolclaw status` 扩展** — 新增 🔑 AUN AIDs 表格（per-AID 连接状态 via IPC）+ orphan session 总数
- **AUN 群聊 proactive 入站白名单** — proactive 模式下仅放行规范 payload 类型，且必须显式 @ 自己或 @all
- **AUN quote 消息支持** — quote 类型自动拼接被引用内容到正文前
- **`/restart` 优雅关闭** — 改用 SIGTERM 让 Feishu WebSocket 正常关闭，避免服务端重推未 ack 消息

### Improvements

- **CommandHandler 结构化输出** — 返回 `OutboundPayload` 替代字符串，`thought` 结构化聚合替代格式化文本
- **ChannelAdapter 接口收敛** — 删除旧出站方法，统一 `adapter.send`
- **channel 消息桥接下沉** — 从 index.ts 下沉到插件 `registerBridge`，新增 channel 模板化
- **src/ 目录结构整理** — `cli/` 收拢、`aun/` 工具归位、`config-store.ts` 替代 `config.ts`，小文件合并
- **身份维度拆分** — Session/Message/InboundMessage 新增 `channelType` + `selfId` + `groupId`，channel 字段固定为实例名；`SessionMetadata.peerId` 含义统一
- **每个 chat 消息日志** — `messages.jsonl` 用于 audit/replay
- **Feishu 过期消息丢弃** — 超过阈值的旧消息直接丢弃
- **`/activity /chatmode /dispatch` UI 改进** — 改用交互卡片，无参数时弹出按钮列表
- **日志轮转** — `evolclaw-YYYYMMDD-HH.log` 按小时切片，`logs`/`watch` 命令自动检测最新文件并无缝切换
- **统一日志管理** — 所有模块走 `utils/logger.ts`，`utils/log-writer.ts` 处理 rotation
- **孤儿进程检测** — `evolclaw status` 检测残留 node 进程
- **AUN reconnect 重写** — SDK 跑无限退避，TS 层只在 flap（短命连接 ≥3 次）和被踢类 terminal_failed 时接管（5min 退避）；新增 `connect.extra_info` 自描述身份
- **fastaun 升级** — `@agentunion/fastaun` 升至 ^0.2.20

### Bug Fixes

- **proactive 模式 mention 过滤** — 统一交给 dispatchMode，避免无差别介入群聊
- **多 channel 并发时 AskUserQuestion 路由修复** — `sendPromptFn` 改为 per-session 构造，避免被全局单例覆盖
- **Windows 实时日志** — 改用 `fs.watchFile` 轮询替代 `fs.watch`，解决跨进程 append 不滚屏问题
- **Windows 终端闪烁** — 减少不必要的 stdout flush
- **Feishu 回复上下文** — `replyContext` 仅在话题消息中设置，避免普通消息误带 thread 回复
- **EvolAgent runner 隔离** — per-EvolAgent runner 实例 + per-agent credentials，避免多 agent 凭证混淆
- **AUN 加密状态透传** — `ReplyContext.metadata.encrypted` 透传到出站，逐消息镜像加密态
- **echo 防链式爆炸** — 超过 2 行丢弃

---

## v2.8.3 (2026-05-14)

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
