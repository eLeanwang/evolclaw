/* EvolClaw Watch — 前端 WS 客户端 + 三 tab 渲染 */

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'ecWatchToken';
const LANG_KEY = 'ecWatchLang';
const VIEW_KEY = 'ecWatchCurrentView';
const THEME_KEY = 'ecTheme';
const THEME_MODES = ['light', 'dark', 'system'];
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';

// ── 国际化 (i18n) ──
const translations = {
  'zh-CN': {
    // Tabs
    'tab.agents': '智能体',
    'tab.messages': '消息',
    'tab.sessions': '会话',
    'tab.triggers': '触发器',
    'tab.cache': '缓存',
    'tab.system': '系统',
    'tab.gateway': 'API 端点',
    'tab.usage': '用量',
    'tab.monitor': '监控',
    'tab.roles': '角色分配',
    'tab.roleDefinitions': '角色定义',

    // Status
    'status.connecting': '连接中…',
    'status.connected': '已连接',
    'status.disconnected': '已断开',
    'status.reconnecting': '重连中',
    'status.stopped': '停止',
    'status.idle': 'idle',
    'status.working': 'working',

    // Actions
    'action.logout': '退出',
    'action.pair': '配对',
    'action.stop': '停止',
    'action.start': '启动',
    'action.enable': '启用',
    'action.disable': '禁用',
    'action.reload': '重载配置',
    'action.edit': '编辑配置',
    'action.delete': '删除 Agent',
    'action.clearQueue': '清空队列',
    'action.new': '+ 新建',
    'action.query': '查询',
    'action.more': '更多',

    // Pair page
    'pair.title': '🔭 EvolClaw Watch',
    'pair.hint': '输入终端显示的 6 位配对码',
    'pair.placeholder': '000000',
    'pair.error.length': '请输入 6 位配对码',
    'pair.error.failed': '配对失败',
    'pair.error.network': '网络错误',
    'pair.error.tokenInvalid': 'token 已失效，请重新配对',
    'pair.loggedOut': '已退出配对',
    'pair.logoutTitle': '退出配对',

    // Common
    'common.loading': '加载中…',
    'common.empty': '暂无数据',
    'common.noData': '暂无',
    'common.operating': '操作中…',
    'common.buildTime': '构建时间',
    'common.notConnected': '未连接',
    'common.save': '保存',
    'common.saving': '保存中…',
    'common.saveAndReload': '保存并重载',
    'common.cancel': '取消',
    'common.create': '创建',
    'common.creating': '创建中…',
    'common.default': '默认',
    'common.defaultModel': '默认模型',
    'common.currentSuffix': '当前',
    'common.loadingSuffix': '加载中',
    'common.noChanges': '没有需要保存的改动',
    'common.close': '关闭',
    'common.rawJsonPreview': '原始 JSON 预览',
    'common.inherited': '继承',
    'common.noLimit': '无限制',
    'common.none': '无',
    'common.unknown': '未知',
    'common.online': '在线',
    'common.offline': '离线',
    'common.ago': '前',
    'theme.light': '浅色模式',
    'theme.dark': '深色模式',
    'theme.system': '跟随系统',
    'theme.buttonTitle': '主题：{mode}；点击切换',
    'language.buttonTitle': '切换语言',

    // Agents view
    'agents.subtitle.enabled': '启用',
    'agents.subtitle.disabled': '禁用',
    'agents.daemonStopped': '⚠ EvolClaw 主进程未运行，仅显示最近活动记录',
    'agents.empty.disabled': '暂无禁用 Agent',
    'agents.empty.enabled': '暂无启用 Agent',
    'agents.stats.gateway': 'Gateway',
    'agents.stats.aids': 'AIDs',
    'agents.stats.total': 'total',
    'agents.stats.online': '在线',
    'agents.stats.offline': '离线',
    'agents.stats.messages': 'Messages',
    'agents.stats.version': 'Version',
    'agents.stats.pid': 'PID',
    'agents.stats.uptime': 'Uptime',

    // Agent table headers
    'agents.th.agent': 'Agent',
    'agents.th.aid': 'AID',
    'agents.th.work': '工作',
    'agents.th.queue': '队列',
    'agents.th.model': '模型',
    'agents.th.runtime': '运行',
    'agents.th.received': '收',
    'agents.th.sent': '发',
    'agents.th.completed': '完',
    'agents.th.errors': '错',
    'agents.th.interrupts': '断',
    'agents.th.lastActivity': '最后活动',
    'agents.th.operations': '操作',
    'agents.th.projectPath': '项目路径',

    // Agent operations
    'agents.op.stopping': '停止中…',
    'agents.op.starting': '启动中…',
    'agents.op.reloading': '重载中…',
    'agents.op.disabling': '禁用中…',
    'agents.op.enabling': '启用中…',
    'agents.op.deleting': '删除中…',
    'agents.op.stopped': '✓ 已停止',
    'agents.op.started': '✓ 已启动',
    'agents.op.reloaded': '✓ 已重载',
    'agents.op.disabled': '✓ 已禁用',
    'agents.op.enabled': '✓ 已启用',
    'agents.op.deleted': '✓ 已删除',
    'agents.op.saved': '✓ 配置已保存，点「重载」生效',
    'agents.op.savedNoReload': '✓ 配置已保存',
    'agents.op.confirmReload': '确认强制重载？',
    'agents.op.confirmToggle': '确认强制',
    'agents.op.confirmToggleAction': '确认强制{action}？',
    'agents.op.confirmDelete': '删除 Agent {aid}？\n此操作不可恢复。',
    'agents.op.confirmForceDelete': '确认强制删除？',
    'agents.op.confirmClearQueue': '清空 {aid} 的待处理消息队列？',
    'agents.op.clearQueueTitle': '清空 {count} 条待处理消息',
    'agents.op.viewAgentMd': '查看 agent.md ↗',
    'agents.op.muting': '禁言中…',
    'agents.op.unmuting': '解禁中…',
    'agents.op.muted': '✓ 已禁言',
    'agents.op.unmuted': '✓ 已解禁',
    'agents.op.confirmPurge': '同时清除 agent 数据目录？',
    'agents.op.created': '✓ 创建请求已受理，稍后刷新查看',
    'agents.edit.createTitle': '新建 Agent',
    'agents.edit.createSubtitle': '创建新的智能体配置',
    'agents.edit.editTitle': '编辑 Agent 配置',
    'agents.edit.section.basic': '基础信息',
    'agents.edit.section.runtime': '运行配置',
    'agents.edit.section.channels': '渠道',
    'agents.edit.section.capabilities': '能力',
    'agents.edit.field.displayName': '显示名',
    'agents.edit.field.ownerAid': 'Owner AID',
    'agents.edit.field.projectPath': '项目路径',
    'agents.edit.field.activeBaseagent': '当前 Baseagent',
    'agents.edit.placeholder.defaultProjectPath': '留空使用默认项目路径',
    'agents.edit.validation.aidRequired': '请填写 Agent AID',
    'agents.edit.validation.invalidAid': 'Agent AID 需类似 mybot.agentid.pub',
    'agents.edit.validation.nameRequired': '请填写显示名',
    'agents.edit.validation.ownerRequired': '请填写 Owner AID',
    'agents.edit.validation.invalidOwner': 'Owner AID 需类似 alice.agentid.pub',
    'agents.edit.validation.invalidBaseagent': '无效 Baseagent: {baseagent}',
    'agents.edit.error.baseagentReadonly': '当前 baseagent 不可写: {baseagent}',
    'agents.channels.noChannels': '暂无渠道',
    'agents.channels.noOwners': '未配置',
    'agents.channels.status.enabled': '启用',
    'agents.channels.status.disabled': '停用',
    'agents.channels.status.unknown': '未知',
    'agents.cap.mode.all': '全部启用',
    'agents.cap.mode.none': '全部关闭',
    'agents.cap.mode.inherit': '继承',
    'agents.cap.enabled': '启用',
    'agents.cap.disabled': '关闭',
    'agents.cap.override.enabled': '显式启用',
    'agents.cap.override.disabled': '显式关闭',
    'agents.cap.override.none': '无覆盖',
    'agents.cap.runtime.enabled': '运行中启用',
    'agents.cap.runtime.disabled': '运行中关闭',
    'agents.cap.noInfo': '暂无能力信息',
    'agents.cap.noItems': '暂无条目',
    'agents.cap.loadingItems': '展开后加载',
    'agents.cap.loadFailed': '能力信息加载失败',
    'agents.cap.itemsLoadFailed': '能力条目加载失败',
    'agents.cap.overrides': '{count} 覆盖',
    'agents.cap.canUpdate': '可更新',
    'agents.cap.notSupported': '不支持',

    // Messages view
    'messages.colTitle.aid': 'Agent',
    'messages.colTitle.peers': 'Chats',
    'messages.colTitle.all': 'All',
    'messages.empty.selectAid': '← 选择一个 Agent',
    'messages.empty.selectToView': '选择 Agent 查看消息',
    'messages.empty.noMessages': '暂无消息',
    'messages.tag.group': '群聊',
    'messages.tag.groupShort': '群',
    'messages.all.aggregate': '聚合全部消息',
    'messages.tag.encrypted': '🔒密文',
    'messages.tag.plain': '明文',
    'messages.tag.proactive': '自主',
    'messages.tag.inject': '注入',
    'messages.tag.responsive': '响应',
    'messages.msgKind.reply': '回复',
    'messages.msgKind.thought': '思考',
    'messages.msgKind.inject': '注入',
    'messages.msgKind.notify': '通知',
    'messages.msgType.thought': '思考',
    'messages.msgType.image': '图片',
    'messages.msgType.file': '文件',
    'messages.msgType.command': '命令',
    'messages.groupCount': '群 {count}',
    'messages.privateCount': '单 {count}',

    // Sessions view
    'sessions.filter.normal': '🔍 仅有效',
    'sessions.filter.chat': '💬 对话',
    'sessions.search.placeholder': '🔎 搜索 peer / 内容',
    'sessions.empty.noMatch': '无匹配会话',
    'sessions.empty.noSessions': '该项目暂无会话',
    'sessions.empty.noContent': '该会话暂无内容',
    'sessions.header.project': '项目',
    'sessions.header.session': '会话',
    'sessions.stat.context': '📐 {tokens} ctx',
    'sessions.stat.cost': '💰 ${cost}',
    'sessions.turnType.modelOutput': '模型输出',
    'sessions.turnType.toolUse': '工具使用',
    'sessions.turnType.toolResult': '工具结果',
    'sessions.turnType.msgSend': '发送消息',
    'sessions.count': '{filtered} / {total} 个会话',
    'sessions.filter.valid': '有效',
    'sessions.filter.validTitle': '只显示有效会话（≥1 条用户消息）',
    'sessions.messageCountTitle': '用户输入 {user} 条 / 共 {total} 条消息',
    'sessions.selectLog': '选择会话查看 CC 日志',
    'sessions.chatView': '💬 对话视图',
    'sessions.fullView': '📜 完整视图',
    'sessions.chatHint': '只看用户与 Agent 的对话，处理过程已折叠',
    'sessions.fullHint': '显示全部消息',
    'sessions.procSummary': '⋯ {count} 条处理过程（思考·工具·结果）',
    'sessions.empty.noDialogue': '该会话没有用户对话消息',
    'sessions.turnType.userInput': '用户输入',
    'sessions.turnType.toolCall': '工具调用',
    'sessions.turnType.system': '系统',
    'sessions.block.thinking': '思考',
    'sessions.block.result': '结果',
    'sessions.block.resultError': '结果',
    'sessions.contextTitle': '最后一轮喂给模型的完整上下文大小',
    'sessions.costTitle': '累计费用（按模型定价估算）',
    'sessions.msgUnit': '条',

    // Cache view
    'cache.daemonStopped': '⚠ EvolClaw 主进程未运行，无缓存统计可显示',
    'cache.notSupported': '⚠ 当前 EvolClaw 版本不支持 cache-stats（请升级 daemon）',
    'cache.card.hitRate': '命中率',
    'cache.card.reads': '读取总数',
    'cache.card.entries': '缓存条目',
    'cache.card.statChecks': 'stat 检查',
    'cache.card.reReads': '重读',
    'cache.card.evictions': '驱逐',
    'cache.card.invalidations': '失效',
    'cache.card.since': '统计起始',
    'cache.card.ago': '前',
    'cache.card.memory': '近似内存',
    'cache.card.hit': '命中',
    'cache.card.miss': '未命中',
    'cache.section.byGroup': '按缓存组',
    'cache.section.byPolicy': '按策略',
    'cache.th.group': '组',
    'cache.th.type': '类型',
    'cache.th.reads': '读取',
    'cache.th.hits': '命中',
    'cache.th.misses': '未命中',
    'cache.th.hitRate': '命中率',
    'cache.th.reReads': '重读',
    'cache.th.evictions': '驱逐',
    'cache.th.entries': '条目',
    'cache.th.memory': '内存',
    'cache.th.capacity': '容量',
    'cache.th.policy': '策略',
    'cache.th.statChecks': 'stat 检查',
    'cache.note': '注：config/defaults 与关系级 preferences 的读取也已并入本统计；渲染后结果（按 vars）不缓存，故不在此列。',
    'cache.policy.onReload': '靠 reload 刷新，平时零检查',
    'cache.policy.manual': '显式单刷',
    'cache.policy.mtime': '每读 statSync 门控',
    'cache.group.identity': '身份层',
    'cache.group.global': '全局',
    'cache.group.relationPrefs': '关系模型偏好',

    // Monitor view
    'monitor.toolbar.timeRange': '时间范围',
    'monitor.range.2m': '2 分钟',
    'monitor.range.10m': '10 分钟',
    'monitor.range.1h': '1 小时',
    'monitor.legend.process': 'evolclaw 进程',
    'monitor.legend.system': '整机系统',
    'monitor.daemonStopped': 'daemon 未运行',
    'monitor.card.uptime': '运行时长',
    'monitor.card.messages1h': '消息 (1h)',
    'monitor.card.onlineAgents': '在线 Agent',
    'monitor.card.avgResponse': '平均响应',
    'monitor.card.errorRate': '错误率',
    'monitor.card.processCpu': '进程 CPU',
    'monitor.card.systemCpu': '系统 CPU',
    'monitor.card.processMemory': '进程内存',
    'monitor.card.systemMemory': '系统内存',
    'monitor.chart.cpu': 'CPU 占用',
    'monitor.chart.memory': '内存占用',
    'monitor.chart.activity1h': '近一小时活动',
    'monitor.chart.errors': '错误分布',
    'monitor.activity.received': '接收',
    'monitor.activity.completed': '完成',
    'monitor.activity.errors': '错误',
    'monitor.activity.interrupts': '中断',
    'monitor.activity.toolErrors': '工具错误',
    'monitor.series.processRss': 'evolclaw RSS',
    'monitor.series.systemUsed': '系统已用',
    'monitor.noErrors1h': '近一小时无错误',
    'monitor.section.agents': '各 Agent 运行状态',
    'monitor.th.agent': 'Agent',
    'monitor.th.status': '状态',
    'monitor.th.received': '收',
    'monitor.th.sent': '发',
    'monitor.th.errors': '错',
    'monitor.th.interrupts': '断',
    'monitor.th.completed': '完',
    'monitor.th.queue': '队列',
    'monitor.th.processing': '处理中',
    'monitor.noAgents': '暂无 Agent',
    'monitor.section.recentErrors': '最近错误',
    'monitor.section.recentErrorsSub': '最多 50 条',
    'monitor.tag.tool': '工具',
    'monitor.tag.task': '任务',
    'monitor.noErrorRecords': '暂无错误记录',

    // System view
    'system.card.uptime': '运行时间',
    'system.latest': '最新',
    'system.devHint': '⏭ 开发模式，升级需手动操作',
    'system.action.health': '🔍 健康检查',
    'system.action.checkUpdates': '⬆ 检查更新',
    'system.action.restart': '⟳ 重启服务',
    'system.confirmRestart': '确认重启服务？当前所有连接将断开。',
    'system.restarting': '重启中…',
    'system.summary.queue': '队列',
    'system.summary.lastHour': '近 1 小时',
    'system.label.project': '项目',
    'system.label.backend': '后端',
    'system.label.channels': '渠道',
    'system.label.load': '负载',
    'system.label.activity': '活动',
    'system.baseagent.unspecified': '未指定模型/强度',
    'system.meta.reconnect': '重连 {count}',
    'system.meta.flap': '抖动 {count}',
    'system.stat.pending': '{count} 待',
    'system.stat.processing': '{count} 处理中',
    'system.stat.received': '收 {count}',
    'system.stat.sent': '发 {count}',
    'system.stat.completed': '完 {count}',
    'system.stat.errors': '错 {count}',
    'system.stat.interrupts': '断 {count}',
    'system.stat.average': '均 {value}s',

    // Gateway view
    'gateway.intro': 'API 端点 = 各 AI 后端（baseagent）的接入配置。Base URL 即 API 端点地址，留空走官方端点。此处为只读展示，配置请通过配置文件（defaults.json / agents/<aid>/config.json）管理。',
    'gateway.scope.defaults': '🌐 全局默认 (defaults)',
    'gateway.empty.scope': '该作用域暂无 API 端点配置',
    'gateway.effective.title': '📋 Agent API 端点配置',
    'gateway.th.model': '模型',
    'gateway.th.source': '来源',
    'gateway.source.agent': '⚡ agent',
    'gateway.source.default': '🔗 默认',
    'gateway.official': '官方',
    'gateway.officialEndpoint': '官方端点',
    'gateway.defaultModel': '默认模型',
    'gateway.mode': '模式',
    'gateway.cliPath': 'CLI 路径',
    'gateway.notTested': '未测试',
    'gateway.modelsCount': '{count} 模型',
    'gateway.failed': '失败',
    'gateway.key.notConfigured': '未配置',
    'gateway.key.plainTitle': '明文密钥已隐藏，建议改用 $ENV 引用',
    'gateway.key.plainLabel': '*** (明文)',
    'gateway.error.daemonUnavailable': 'evolclaw 未运行或 socket 不可达',
    'gateway.error.daemonFailed': 'daemon 返回失败',

    // Triggers view
    'triggers.schedule.delay': '延迟',
    'triggers.schedule.at': '指定时间',
    'triggers.schedule.cron': 'Cron',
    'triggers.schedule.interval': '间隔',
    'triggers.schedule.event': '事件',
    'triggers.session.latest': '最新活跃会话',
    'triggers.session.thread': '指定话题会话',
    'triggers.status.active': '活跃',
    'triggers.status.disabled': '已禁用',
    'triggers.status.fired': '已触发',
    'triggers.status.cancelled': '已取消',
    'triggers.status.expired': '已过期',
    'triggers.op.run': '立即执行',
    'triggers.op.edit': '编辑',
    'triggers.op.disable': '停用',
    'triggers.op.delete': '删除',
    'triggers.op.running': '执行中…',
    'triggers.op.ran': '✓ 已执行{status}',
    'triggers.op.enabled': '✓ 已启用',
    'triggers.op.disabled': '✓ 已禁用',
    'triggers.op.deleted': '✓ 已删除',
    'triggers.op.runDisabledTitle': '已停用的触发器不能立即执行',
    'triggers.op.deleteDisabledTitle': '需先停用触发器后删除',
    'triggers.error.notFound': '触发器不存在或已刷新',
    'triggers.error.deleteEnabled': '请先禁用触发器再删除',
    'triggers.error.runDisabled': '触发器已禁用，不能立即执行',
    'triggers.confirmDelete': '删除触发器「{name}」？',
    'triggers.error.invalidScheduleType': '无效调度类型: {type}',
    'triggers.error.emptySchedule': '调度表达式不能为空',
    'triggers.error.scheduleDurationFormat': '{type}支持格式：30s、15m、2h、1d',
    'triggers.error.invalidAt': '指定时间格式不正确',
    'triggers.error.invalidEventPattern': '事件模式格式不正确，支持 *、message:received、message:*',
    'triggers.error.filterPathRequired': '过滤字段不能为空',
    'triggers.error.filterValueRequired': '过滤条件值不能为空',
    'triggers.error.filterJsonInvalid': '过滤条件 JSON 不合法',
    'triggers.error.nameRequired': '名称不能为空',
    'triggers.error.promptRequired': 'Prompt 不能为空',
    'triggers.error.channelRequired': '目标渠道不能为空',
    'triggers.error.channelIdRequired': '渠道 ID 不能为空',
    'triggers.error.scriptPathRequired': '脚本路径不能为空',
    'triggers.error.scriptRuntimeRequired': '脚本运行时不能为空',
    'triggers.error.threadRequired': '指定话题会话时必须填写话题会话 ID',
    'triggers.error.maxRunsPositive': '最大执行次数必须是正整数',
    'triggers.error.maxDurationFormat': '最长有效期支持格式：30s、15m、2h、1d',
    'triggers.saved': '✓ 触发器已保存',
    'triggers.editTitle': '编辑 Trigger',
    'triggers.section.basic': '触发',
    'triggers.section.execution': '执行',
    'triggers.section.target': '反馈',
    'triggers.section.limits': '限制',
    'triggers.field.name': '名称',
    'triggers.field.scheduleType': '调度类型',
    'triggers.field.timezone': '时区',
    'triggers.field.scheduleExpression': '调度表达式',
    'triggers.field.eventPattern': '事件模式',
    'triggers.field.eventFilter': '过滤条件',
    'triggers.field.filterField': '字段',
    'triggers.field.filterOperator': '操作符',
    'triggers.field.filterValue': '值',
    'triggers.eventCatalog.loading': '正在加载事件目录…',
    'triggers.eventCatalog.unavailable': '事件目录不可用',
    'triggers.eventCatalog.noEvents': '没有匹配的事件',
    'triggers.eventCatalog.noFields': '没有匹配的字段',
    'triggers.field.outputTemplate': '输出模板',
    'triggers.field.prompt': 'Prompt',
    'triggers.field.executionType': '执行类型',
    'triggers.execution.agent': 'Prompt',
    'triggers.execution.script': '脚本',
    'triggers.field.scriptPath': '脚本路径',
    'triggers.field.scriptRuntime': '运行时',
    'triggers.field.model': '模型',
    'triggers.field.effort': '推理强度',
    'triggers.field.permission': '权限模式',
    'triggers.field.targetChannel': '目标渠道',
    'triggers.field.channelId': '渠道 ID',
    'triggers.field.sessionStrategy': '会话选择',
    'triggers.field.threadId': '话题会话 ID',
    'triggers.field.maxRuns': '最大执行次数',
    'triggers.field.maxDuration': '最长有效期',
    'triggers.field.concurrency': '上一次未结束',
    'triggers.field.missedPolicy': '错过执行时机',
    'triggers.field.feedbackOnReply': '有回复时反馈',
    'triggers.field.feedbackOnNoop': '无输出时反馈',
    'triggers.field.feedbackOnFailure': '失败时反馈',
    'triggers.field.feedbackAction': '反馈方式',
    'triggers.field.feedbackDelivery': '反馈投递',
    'triggers.field.scriptContent': '脚本内容',
    'triggers.placeholder.scheduleDuration': '30s / 15m / 2h / 1d',
    'triggers.placeholder.maxDuration': '30s / 15m / 2h / 1d',
    'triggers.placeholder.scriptPath': 'scripts/job.js --foo bar',
    'triggers.placeholder.filterValue': '文本 / 数字 / true / false',
    'triggers.concurrency.forbid': '跳过本次执行',
    'triggers.concurrency.replace': '中断上次并执行本次',
    'triggers.concurrency.allow': '允许并行执行',
    'triggers.missed.skip': '跳过错过的执行',
    'triggers.missed.run_once': '补执行一次',
    'triggers.missed.run_all': '补执行全部',
    'triggers.feedback.forward': '发送到反馈目标',
    'triggers.feedback.reply-origin': '回复创建来源',
    'triggers.feedback.silent': '静默',
    'triggers.feedback.delivery.inbound': '进入 Agent 会话',
    'triggers.feedback.delivery.direct': 'Direct',
    'triggers.scriptPreview.empty': '暂无脚本内容',
    'triggers.scriptPreview.truncated': '内容已截断',
    'triggers.lastUnrecorded': '未记录',
    'triggers.collapse.expand': '展开 Agent 列表',
    'triggers.collapse.collapse': '收起 Agent 列表',
    'triggers.empty.noAgents': '暂无 Agent',
    'triggers.empty.noTriggers': '暂无触发器',
    'triggers.empty.noAgentTriggers': '该 Agent 暂无触发器',
    'triggers.th.status': '状态',
    'triggers.th.subscription': '订阅',
    'triggers.th.name': '名称',
    'triggers.th.type': '类型',
    'triggers.th.expression': '表达式',
    'triggers.th.lastFire': '上次触发',
    'triggers.th.nextFire': '下次触发',
    'triggers.th.fireCount': '触发次数',
    'triggers.th.failCount': '失败次数',
    'triggers.th.lastResult': '最后结果',
    'triggers.th.targetChannel': '目标渠道',
    'triggers.th.channelType': '渠道类型',
    'triggers.th.createdBy': '创建者',
    'triggers.th.createdChannel': '创建渠道',
    'triggers.th.createdAt': '创建时间',
    'triggers.th.operations': '操作',
    'triggers.subscription.active': '已订阅',
    'triggers.subscription.inactive': '未订阅',
    'triggers.subscription.event-bus-unavailable': '无事件总线',
    'triggers.filter.add': '添加条件',
    'triggers.filter.clear': '清空条件',
    'triggers.filter.none': '未设置过滤条件',
    'triggers.filter.op.eq': '等于',
    'triggers.filter.op.in': '包含于',
    'triggers.filter.op.regex': '正则匹配',
    'triggers.filter.op.gt': '大于',
    'triggers.filter.op.gte': '大于等于',
    'triggers.filter.op.lt': '小于',
    'triggers.filter.op.lte': '小于等于',
    'triggers.filter.op.exists': '存在',

    // Usage view
    'usage.subtab.overview': '总览',
    'usage.subtab.explorer': '详细统计',
    'usage.overview.range.today': '今日',
    'usage.overview.range.week': '本周',
    'usage.overview.range.lastWeek': '上周',
    'usage.overview.range.month': '本月',
    'usage.overview.range.last30': '最近30天',
    'usage.overview.range.custom': '自定义',
    'usage.card.input': '输入',
    'usage.card.output': '输出',
    'usage.card.cacheRead': '缓存读取',
    'usage.card.cacheHit': '缓存命中',
    'usage.card.calls': '调用',
    'usage.card.sessionCount': '会话数',
    'usage.card.msgIn': '收到消息',
    'usage.card.msgOut': '发出消息',
    'usage.card.modelCalls': '模型调用',
    'usage.card.inputTokens': '输入 Token',
    'usage.card.outputTokens': '输出 Token',
    'usage.card.cacheCreation': '缓存创建',
    'usage.card.cacheHitTokens': '缓存命中',
    'usage.card.cacheHitRate': '缓存命中率',
    'usage.card.totalCost': '总花费',
    'usage.card.costOfficial': '官方价格',
    'usage.card.costGateway': '网关价格',
    'usage.card.sessionInfo': '会话信息',
    'usage.card.usageInfo': '用量信息',
    'usage.card.costInfo': '花费信息',
    'usage.detail.title': '模型访问明细',
    'usage.detail.agent': '智能体',
    'usage.detail.model': '模型',
    'usage.detail.error': '查询失败',
    'usage.detail.th.time': '时间',
    'usage.detail.th.agent': '智能体',
    'usage.detail.th.peer': 'Peer',
    'usage.detail.th.model': '模型',
    'usage.detail.th.input': '输入',
    'usage.detail.th.output': '输出',
    'usage.detail.th.cacheCreation': '缓存创建',
    'usage.detail.th.cacheRead': '缓存读取',
    'usage.detail.th.costOfficial': '官方价格',
    'usage.detail.th.costGateway': '网关价格',
    'usage.detail.pageSize': '每页',
    'usage.detail.prevPage': '上一页',
    'usage.detail.nextPage': '下一页',
    'usage.detail.pagination': '显示 {start}-{end} / 共 {total} 条 (第 {page}/{totalPages} 页)',
    'usage.overview.title': '按 Agent 汇总（全时段）',
    'usage.overview.noData': '暂无数据',
    'usage.overview.th.agent': '智能体',
    'usage.overview.th.calls': '调用',
    'usage.overview.th.input': '输入',
    'usage.overview.th.output': '输出',
    'usage.overview.th.cacheCreation': '缓存创建',
    'usage.overview.th.cacheHit': '缓存命中',
    'usage.overview.th.cacheHitRate': '命中率',
    'usage.overview.th.costOfficial': '官方价格',
    'usage.overview.th.costGateway': '网关价格',
    'usage.overview.th.cost': '花费',
    'usage.dashboard.title.topPeers': 'Top Peers (Today)',
    'usage.dashboard.th.rank': '#',
    'usage.dashboard.th.peer': 'Peer',
    'usage.dashboard.th.tokens': 'Tokens',
    'usage.dashboard.th.calls': 'Calls',
    'usage.explorer.sidebar.agents': '智能体',
    'usage.explorer.sidebar.peers': '对端智能体',
    'usage.explorer.chatType.group': '群聊',
    'usage.explorer.chatType.private': '单聊',
    'usage.explorer.memberCount': '人',
    'usage.explorer.selectHint': '请从左侧选择 Agent 或 Peer',
    'usage.explorer.all': '全部',
    'usage.explorer.filter.from': 'From',
    'usage.explorer.filter.to': 'To',
    'usage.explorer.filter.model': 'Model',
    'usage.explorer.filter.granularity': '粒度',
    'usage.explorer.filter.granularity.hour': 'Hour',
    'usage.explorer.filter.granularity.day': 'Day',
    'usage.explorer.filter.granularity.week': 'Week',
    'usage.explorer.filter.granularity.month': 'Month',
    'usage.explorer.results': 'Results',
    'usage.explorer.noData': 'No data for selected range.',
    'usage.explorer.th.period': 'Period',
    'usage.explorer.th.input': 'Input',
    'usage.explorer.th.output': 'Output',
    'usage.explorer.th.cacheCreation': 'Cache↑',
    'usage.explorer.th.cacheHit': 'CacheHit',
    'usage.explorer.th.calls': 'Calls',

    // Role Definitions view
    'roleDefs.title': '角色定义管理',
    'roleDefs.owner': '所有者',
    'roleDefs.admin': '管理员',
    'roleDefs.member': '成员',
    'roleDefs.guest': '访客',
    'roleDefs.anonymous': '匿名',
    'roleDefs.viewDetails': '查看详情',
    'roleDefs.edit': '编辑',
    'roleDefs.reset': '重置',
    'roleDefs.save': '保存',
    'roleDefs.cancel': '取消',
    'roleDefs.permissionMode': '权限模式',
    'roleDefs.model': '模型',
    'roleDefs.dispatch': '分发模式',
    'roleDefs.allowOverride': '允许覆盖',
    'roleDefs.allowedModels': '允许的模型',
    'roleDefs.description': '描述',
    'roleDefs.resetConfirm': '确定要将 {role} 重置为默认配置吗？',
    'roleDefs.saveSuccess': '保存成功',
    'roleDefs.saveFailed': '保存失败',

    // Role permission values
    'roleDefs.effort.low': '低 (low)',
    'roleDefs.effort.medium': '中 (medium)',
    'roleDefs.effort.high': '高 (high)',
    'roleDefs.showActivities.true': '显示 (true)',
    'roleDefs.showActivities.false': '不显示 (false)',
    'roleDefs.permMode.bypass': '绕过 (bypass)',
    'roleDefs.permMode.request': '请求 (request)',
    'roleDefs.permMode.auto': '自动 (auto)',
    'roleDefs.permMode.readonly': '只读 (readonly)',
    'roleDefs.dispatch.broadcast': '广播 (broadcast)',
    'roleDefs.dispatch.mention': '提及 (mention)',

    // Roles view
    'roles.selectAgent': '选择智能体:',
    'roles.selectAgentPlaceholder': '-- 请选择智能体 --',
    'roles.searchPlaceholder': '搜索对端...',
    'roles.table.chatType': '会话',
    'roles.table.peerName': '昵称',
    'roles.table.peerAid': '对端AID',
    'roles.table.peerType': '类型',
    'roles.table.role': '有效角色',
    'roles.table.source': '来源',
    'roles.table.actions': '操作',
    'roles.chatType.private': '私聊',
    'roles.chatType.group': '群聊',
    'roles.filter.allChatType': '全部会话',
    'roles.filter.private': '💬 私聊',
    'roles.filter.group': '👥 群聊',
    'roles.filter.allVerify': '全部状态',
    'roles.filter.verified': '✅ 已验证',
    'roles.filter.invalid': '⚠️ 验证失败',
    'roles.filter.unverified': '⚠️ 未验证',
    'roles.filter.unknown': '❓ 未知',
  },
  'en-US': {
    // Tabs
    'tab.agents': 'Agents',
    'tab.messages': 'Messages',
    'tab.sessions': 'Sessions',
    'tab.triggers': 'Triggers',
    'tab.cache': 'Cache',
    'tab.system': 'System',
    'tab.gateway': 'API Endpoints',
    'tab.usage': 'Usage',
    'tab.monitor': 'Monitor',
    'tab.roles': 'Role Assignment',
    'tab.roleDefinitions': 'Roles',

    // Status
    'status.connecting': 'Connecting…',
    'status.connected': 'Connected',
    'status.disconnected': 'Disconnected',
    'status.reconnecting': 'Reconnecting',
    'status.stopped': 'Stopped',
    'status.idle': 'Idle',
    'status.working': 'Working',

    // Actions
    'action.logout': 'Logout',
    'action.pair': 'Pair',
    'action.stop': 'Stop',
    'action.start': 'Start',
    'action.enable': 'Enable',
    'action.disable': 'Disable',
    'action.reload': 'Reload Config',
    'action.edit': 'Edit Config',
    'action.delete': 'Delete Agent',
    'action.clearQueue': 'Clear Queue',
    'action.new': '+ New',
    'action.query': 'Query',
    'action.more': 'More',

    // Pair page
    'pair.title': '🔭 EvolClaw Watch',
    'pair.hint': 'Enter the 6-digit pairing code shown in terminal',
    'pair.placeholder': '000000',
    'pair.error.length': 'Please enter 6-digit pairing code',
    'pair.error.failed': 'Pairing failed',
    'pair.error.network': 'Network error',
    'pair.error.tokenInvalid': 'Token expired, please pair again',
    'pair.loggedOut': 'Logged out from pairing',
    'pair.logoutTitle': 'Logout pairing',

    // Common
    'common.loading': 'Loading…',
    'common.empty': 'No data',
    'common.noData': 'N/A',
    'common.operating': 'Operating…',
    'common.buildTime': 'Build Time',
    'common.notConnected': 'Not connected',
    'common.save': 'Save',
    'common.saving': 'Saving…',
    'common.saveAndReload': 'Save and Reload',
    'common.cancel': 'Cancel',
    'common.create': 'Create',
    'common.creating': 'Creating…',
    'common.default': 'Default',
    'common.defaultModel': 'Default model',
    'common.currentSuffix': 'current',
    'common.loadingSuffix': 'loading',
    'common.noChanges': 'No changes to save',
    'common.close': 'Close',
    'common.rawJsonPreview': 'Raw JSON Preview',
    'common.inherited': 'Inherited',
    'common.noLimit': 'No limit',
    'common.none': 'None',
    'common.unknown': 'Unknown',
    'common.online': 'Online',
    'common.offline': 'Offline',
    'common.ago': 'ago',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.system': 'System',
    'theme.buttonTitle': 'Theme: {mode}; click to switch',
    'language.buttonTitle': 'Switch language',

    // Agents view
    'agents.subtitle.enabled': 'Enabled',
    'agents.subtitle.disabled': 'Disabled',
    'agents.daemonStopped': '⚠ EvolClaw daemon not running, showing recent activity only',
    'agents.empty.disabled': 'No disabled agents',
    'agents.empty.enabled': 'No enabled agents',
    'agents.stats.gateway': 'Gateway',
    'agents.stats.aids': 'AIDs',
    'agents.stats.total': 'total',
    'agents.stats.online': 'online',
    'agents.stats.offline': 'offline',
    'agents.stats.messages': 'Messages',
    'agents.stats.version': 'Version',
    'agents.stats.pid': 'PID',
    'agents.stats.uptime': 'Uptime',

    // Agent table headers
    'agents.th.agent': 'Agent',
    'agents.th.aid': 'AID',
    'agents.th.work': 'Work',
    'agents.th.queue': 'Queue',
    'agents.th.model': 'Model',
    'agents.th.runtime': 'Runtime',
    'agents.th.received': 'Recv',
    'agents.th.sent': 'Sent',
    'agents.th.completed': 'Done',
    'agents.th.errors': 'Err',
    'agents.th.interrupts': 'Int',
    'agents.th.lastActivity': 'Last Activity',
    'agents.th.operations': 'Operations',
    'agents.th.projectPath': 'Project Path',

    // Agent operations
    'agents.op.stopping': 'Stopping…',
    'agents.op.starting': 'Starting…',
    'agents.op.reloading': 'Reloading…',
    'agents.op.disabling': 'Disabling…',
    'agents.op.enabling': 'Enabling…',
    'agents.op.deleting': 'Deleting…',
    'agents.op.stopped': '✓ Stopped',
    'agents.op.started': '✓ Started',
    'agents.op.reloaded': '✓ Reloaded',
    'agents.op.disabled': '✓ Disabled',
    'agents.op.enabled': '✓ Enabled',
    'agents.op.deleted': '✓ Deleted',
    'agents.op.saved': '✓ Config saved, click "Reload" to apply',
    'agents.op.savedNoReload': '✓ Config saved',
    'agents.op.confirmReload': 'Force reload?',
    'agents.op.confirmToggle': 'Force',
    'agents.op.confirmToggleAction': 'Force {action}?',
    'agents.op.confirmDelete': 'Delete agent {aid}?\nThis cannot be undone.',
    'agents.op.confirmForceDelete': 'Force delete?',
    'agents.op.confirmClearQueue': 'Clear pending message queue for {aid}?',
    'agents.op.clearQueueTitle': 'Clear {count} pending messages',
    'agents.op.viewAgentMd': 'View agent.md ↗',
    'agents.op.muting': 'Muting…',
    'agents.op.unmuting': 'Unmuting…',
    'agents.op.muted': '✓ Muted',
    'agents.op.unmuted': '✓ Unmuted',
    'agents.op.confirmPurge': 'Also remove the agent data directory?',
    'agents.op.created': '✓ Create request accepted, refresh shortly to view it',
    'agents.edit.createTitle': 'New Agent',
    'agents.edit.createSubtitle': 'Create a new agent configuration',
    'agents.edit.editTitle': 'Edit Agent Config',
    'agents.edit.section.basic': 'Basic Info',
    'agents.edit.section.runtime': 'Runtime Config',
    'agents.edit.section.channels': 'Channels',
    'agents.edit.section.capabilities': 'Capabilities',
    'agents.edit.field.displayName': 'Display Name',
    'agents.edit.field.ownerAid': 'Owner AID',
    'agents.edit.field.projectPath': 'Project Path',
    'agents.edit.field.activeBaseagent': 'Current Baseagent',
    'agents.edit.placeholder.defaultProjectPath': 'Leave blank to use the default project path',
    'agents.edit.validation.aidRequired': 'Agent AID is required',
    'agents.edit.validation.invalidAid': 'Agent AID should look like mybot.agentid.pub',
    'agents.edit.validation.nameRequired': 'Display name is required',
    'agents.edit.validation.ownerRequired': 'Owner AID is required',
    'agents.edit.validation.invalidOwner': 'Owner AID should look like alice.agentid.pub',
    'agents.edit.validation.invalidBaseagent': 'Invalid Baseagent: {baseagent}',
    'agents.edit.error.baseagentReadonly': 'Current baseagent is read-only: {baseagent}',
    'agents.channels.noChannels': 'No channels',
    'agents.channels.noOwners': 'Not configured',
    'agents.channels.status.enabled': 'Enabled',
    'agents.channels.status.disabled': 'Disabled',
    'agents.channels.status.unknown': 'Unknown',
    'agents.cap.mode.all': 'All enabled',
    'agents.cap.mode.none': 'All disabled',
    'agents.cap.mode.inherit': 'Inherited',
    'agents.cap.enabled': 'Enabled',
    'agents.cap.disabled': 'Disabled',
    'agents.cap.override.enabled': 'Explicitly enabled',
    'agents.cap.override.disabled': 'Explicitly disabled',
    'agents.cap.override.none': 'No override',
    'agents.cap.runtime.enabled': 'Runtime enabled',
    'agents.cap.runtime.disabled': 'Runtime disabled',
    'agents.cap.noInfo': 'No capability info',
    'agents.cap.noItems': 'No items',
    'agents.cap.loadingItems': 'Load when expanded',
    'agents.cap.loadFailed': 'Failed to load capability info',
    'agents.cap.itemsLoadFailed': 'Failed to load capability items',
    'agents.cap.overrides': '{count} overrides',
    'agents.cap.canUpdate': 'Can update',
    'agents.cap.notSupported': 'Not supported',

    // Messages view
    'messages.colTitle.aid': 'Agent',
    'messages.colTitle.peers': 'Chats',
    'messages.colTitle.all': 'All',
    'messages.empty.selectAid': '← Select Agent',
    'messages.empty.selectToView': 'Select Agent to view messages',
    'messages.empty.noMessages': 'No messages',
    'messages.tag.group': 'Group',
    'messages.tag.groupShort': 'G',
    'messages.all.aggregate': 'Aggregate messages',
    'messages.tag.encrypted': '🔒Encrypted',
    'messages.tag.plain': 'Plain',
    'messages.tag.proactive': 'Proactive',
    'messages.tag.inject': 'Inject',
    'messages.tag.responsive': 'Responsive',
    'messages.msgKind.reply': 'Reply',
    'messages.msgKind.thought': 'Thought',
    'messages.msgKind.inject': 'Inject',
    'messages.msgKind.notify': 'Notify',
    'messages.msgType.thought': 'Thought',
    'messages.msgType.image': 'Image',
    'messages.msgType.file': 'File',
    'messages.msgType.command': 'Command',
    'messages.groupCount': '{count} groups',
    'messages.privateCount': '{count} private',

    // Sessions view
    'sessions.filter.normal': '🔍 Valid Only',
    'sessions.filter.chat': '💬 Chat',
    'sessions.search.placeholder': '🔎 Search peer / content',
    'sessions.empty.noMatch': 'No matching sessions',
    'sessions.empty.noSessions': 'No sessions in this project',
    'sessions.empty.noContent': 'No content in this session',
    'sessions.header.project': 'Project',
    'sessions.header.session': 'Session',
    'sessions.stat.context': '📐 {tokens} ctx',
    'sessions.stat.cost': '💰 ${cost}',
    'sessions.turnType.modelOutput': 'Model Output',
    'sessions.turnType.toolUse': 'Tool Use',
    'sessions.turnType.toolResult': 'Tool Result',
    'sessions.turnType.msgSend': 'Send Message',
    'sessions.count': '{filtered} / {total} sessions',
    'sessions.filter.valid': 'Valid',
    'sessions.filter.validTitle': 'Only show valid sessions (at least 1 user message)',
    'sessions.messageCountTitle': '{user} user messages / {total} total messages',
    'sessions.selectLog': 'Select a session to view the CC log',
    'sessions.chatView': '💬 Chat View',
    'sessions.fullView': '📜 Full View',
    'sessions.chatHint': 'Only user and Agent messages; processing is collapsed',
    'sessions.fullHint': 'Show all messages',
    'sessions.procSummary': '⋯ {count} processing steps (thinking · tools · results)',
    'sessions.empty.noDialogue': 'No user dialogue messages in this session',
    'sessions.turnType.userInput': 'User Input',
    'sessions.turnType.toolCall': 'Tool Call',
    'sessions.turnType.system': 'System',
    'sessions.block.thinking': 'Thinking',
    'sessions.block.result': 'Result',
    'sessions.block.resultError': 'Result',
    'sessions.contextTitle': 'Full context size sent to the model in the last turn',
    'sessions.costTitle': 'Estimated cumulative cost by model pricing',
    'sessions.msgUnit': 'msgs',

    // Cache view
    'cache.daemonStopped': '⚠ EvolClaw daemon not running, no cache stats available',
    'cache.notSupported': '⚠ Current EvolClaw version does not support cache-stats (please upgrade daemon)',
    'cache.card.hitRate': 'Hit Rate',
    'cache.card.reads': 'Total Reads',
    'cache.card.entries': 'Cache Entries',
    'cache.card.statChecks': 'Stat Checks',
    'cache.card.reReads': 'Re-reads',
    'cache.card.evictions': 'Evictions',
    'cache.card.invalidations': 'Invalidations',
    'cache.card.since': 'Stats Since',
    'cache.card.ago': 'ago',
    'cache.card.memory': 'approx memory',
    'cache.card.hit': 'hit',
    'cache.card.miss': 'miss',
    'cache.section.byGroup': 'By Cache Group',
    'cache.section.byPolicy': 'By Policy',
    'cache.th.group': 'Group',
    'cache.th.type': 'Type',
    'cache.th.reads': 'Reads',
    'cache.th.hits': 'Hits',
    'cache.th.misses': 'Misses',
    'cache.th.hitRate': 'Hit Rate',
    'cache.th.reReads': 'Re-reads',
    'cache.th.evictions': 'Evictions',
    'cache.th.entries': 'Entries',
    'cache.th.memory': 'Memory',
    'cache.th.capacity': 'Capacity',
    'cache.th.policy': 'Policy',
    'cache.th.statChecks': 'Stat Checks',
    'cache.note': 'Note: Reads of config/defaults and relation-level preferences are included; rendered results (by vars) are not cached and not shown here.',
    'cache.policy.onReload': 'Refresh on reload, zero checks normally',
    'cache.policy.manual': 'Explicit single refresh',
    'cache.policy.mtime': 'statSync gate on each read',
    'cache.group.identity': 'identity layer',
    'cache.group.global': 'global',
    'cache.group.relationPrefs': 'relation model preferences',

    // Monitor view
    'monitor.toolbar.timeRange': 'Time Range',
    'monitor.range.2m': '2 minutes',
    'monitor.range.10m': '10 minutes',
    'monitor.range.1h': '1 hour',
    'monitor.legend.process': 'evolclaw process',
    'monitor.legend.system': 'system',
    'monitor.daemonStopped': 'daemon is not running',
    'monitor.card.uptime': 'Uptime',
    'monitor.card.messages1h': 'Messages (1h)',
    'monitor.card.onlineAgents': 'Online Agents',
    'monitor.card.avgResponse': 'Avg Response',
    'monitor.card.errorRate': 'Error Rate',
    'monitor.card.processCpu': 'Process CPU',
    'monitor.card.systemCpu': 'System CPU',
    'monitor.card.processMemory': 'Process Memory',
    'monitor.card.systemMemory': 'System Memory',
    'monitor.chart.cpu': 'CPU Usage',
    'monitor.chart.memory': 'Memory Usage',
    'monitor.chart.activity1h': 'Activity in Last Hour',
    'monitor.chart.errors': 'Error Breakdown',
    'monitor.activity.received': 'Received',
    'monitor.activity.completed': 'Completed',
    'monitor.activity.errors': 'Errors',
    'monitor.activity.interrupts': 'Interrupts',
    'monitor.activity.toolErrors': 'ToolErr',
    'monitor.series.processRss': 'evolclaw RSS',
    'monitor.series.systemUsed': 'System Used',
    'monitor.noErrors1h': 'No errors in the last hour',
    'monitor.section.agents': 'Agent Runtime Status',
    'monitor.th.agent': 'Agent',
    'monitor.th.status': 'Status',
    'monitor.th.received': 'Recv',
    'monitor.th.sent': 'Sent',
    'monitor.th.errors': 'Err',
    'monitor.th.interrupts': 'Int',
    'monitor.th.completed': 'Done',
    'monitor.th.queue': 'Queue',
    'monitor.th.processing': 'Processing',
    'monitor.noAgents': 'No agents',
    'monitor.section.recentErrors': 'Recent Errors',
    'monitor.section.recentErrorsSub': 'up to 50',
    'monitor.tag.tool': 'Tool',
    'monitor.tag.task': 'Task',
    'monitor.noErrorRecords': 'No error records',

    // System view
    'system.card.uptime': 'Uptime',
    'system.latest': 'latest',
    'system.devHint': '⏭ Development mode; upgrade manually',
    'system.action.health': '🔍 Health Check',
    'system.action.checkUpdates': '⬆ Check Updates',
    'system.action.restart': '⟳ Restart Service',
    'system.confirmRestart': 'Restart service? All current connections will be disconnected.',
    'system.restarting': 'Restarting…',
    'system.summary.queue': 'Queue',
    'system.summary.lastHour': 'Last Hour',
    'system.label.project': 'Project',
    'system.label.backend': 'Backend',
    'system.label.channels': 'Channels',
    'system.label.load': 'Load',
    'system.label.activity': 'Activity',
    'system.baseagent.unspecified': 'Model/effort not specified',
    'system.meta.reconnect': 'reconnect {count}',
    'system.meta.flap': 'flap {count}',
    'system.stat.pending': '{count} pending',
    'system.stat.processing': '{count} processing',
    'system.stat.received': 'recv {count}',
    'system.stat.sent': 'sent {count}',
    'system.stat.completed': 'done {count}',
    'system.stat.errors': 'err {count}',
    'system.stat.interrupts': 'int {count}',
    'system.stat.average': 'avg {value}s',

    // Gateway view
    'gateway.intro': 'API Endpoints are connection settings for each AI backend (baseagent). Base URL is the API endpoint address; leave it blank to use the official endpoint. This page is read-only; manage settings in config files (defaults.json / agents/<aid>/config.json).',
    'gateway.scope.defaults': '🌐 Global Defaults (defaults)',
    'gateway.empty.scope': 'No API endpoint config in this scope',
    'gateway.effective.title': '📋 Agent API Endpoint Config',
    'gateway.th.model': 'Model',
    'gateway.th.source': 'Source',
    'gateway.source.agent': '⚡ agent',
    'gateway.source.default': '🔗 default',
    'gateway.official': 'Official',
    'gateway.officialEndpoint': 'Official endpoint',
    'gateway.defaultModel': 'Default model',
    'gateway.mode': 'Mode',
    'gateway.cliPath': 'CLI Path',
    'gateway.notTested': 'Not tested',
    'gateway.modelsCount': '{count} models',
    'gateway.failed': 'Failed',
    'gateway.key.notConfigured': 'Not configured',
    'gateway.key.plainTitle': 'Plaintext key is hidden; $ENV references are recommended',
    'gateway.key.plainLabel': '*** (plaintext)',
    'gateway.error.daemonUnavailable': 'evolclaw is not running or the socket is unreachable',
    'gateway.error.daemonFailed': 'daemon returned an error',

    // Triggers view
    'triggers.schedule.delay': 'Delay',
    'triggers.schedule.at': 'Specific Time',
    'triggers.schedule.cron': 'Cron',
    'triggers.schedule.interval': 'Interval',
    'triggers.schedule.event': 'Event',
    'triggers.session.latest': 'Latest Active Session',
    'triggers.session.thread': 'Specific Topic Session',
    'triggers.status.active': 'Active',
    'triggers.status.disabled': 'Disabled',
    'triggers.status.fired': 'Fired',
    'triggers.status.cancelled': 'Cancelled',
    'triggers.status.expired': 'Expired',
    'triggers.op.run': 'Run Now',
    'triggers.op.edit': 'Edit',
    'triggers.op.disable': 'Disable',
    'triggers.op.delete': 'Delete',
    'triggers.op.running': 'Running…',
    'triggers.op.ran': '✓ Ran{status}',
    'triggers.op.enabled': '✓ Enabled',
    'triggers.op.disabled': '✓ Disabled',
    'triggers.op.deleted': '✓ Deleted',
    'triggers.op.runDisabledTitle': 'Disabled triggers cannot run now',
    'triggers.op.deleteDisabledTitle': 'Disable this trigger before deleting it',
    'triggers.error.notFound': 'Trigger does not exist or has refreshed',
    'triggers.error.deleteEnabled': 'Disable the trigger before deleting it',
    'triggers.error.runDisabled': 'Disabled triggers cannot be run now',
    'triggers.confirmDelete': 'Delete trigger "{name}"?',
    'triggers.error.invalidScheduleType': 'Invalid schedule type: {type}',
    'triggers.error.emptySchedule': 'Schedule expression is required',
    'triggers.error.scheduleDurationFormat': '{type} supports: 30s, 15m, 2h, 1d',
    'triggers.error.invalidAt': 'Specific time format is invalid',
    'triggers.error.invalidEventPattern': 'Invalid event pattern. Supported: *, message:received, message:*',
    'triggers.error.filterPathRequired': 'Filter field is required',
    'triggers.error.filterValueRequired': 'Filter value is required',
    'triggers.error.filterJsonInvalid': 'Filter JSON is invalid',
    'triggers.error.nameRequired': 'Name is required',
    'triggers.error.promptRequired': 'Prompt is required',
    'triggers.error.channelRequired': 'Target channel is required',
    'triggers.error.channelIdRequired': 'Channel ID is required',
    'triggers.error.scriptPathRequired': 'Script path is required',
    'triggers.error.scriptRuntimeRequired': 'Script runtime is required',
    'triggers.error.threadRequired': 'Topic session ID is required',
    'triggers.error.maxRunsPositive': 'Max runs must be a positive integer',
    'triggers.error.maxDurationFormat': 'Max duration supports: 30s, 15m, 2h, 1d',
    'triggers.saved': '✓ Trigger saved',
    'triggers.editTitle': 'Edit Trigger',
    'triggers.section.basic': 'Trigger',
    'triggers.section.execution': 'Execution',
    'triggers.section.target': 'Feedback',
    'triggers.section.limits': 'Limits',
    'triggers.field.name': 'Name',
    'triggers.field.scheduleType': 'Schedule Type',
    'triggers.field.timezone': 'Timezone',
    'triggers.field.scheduleExpression': 'Schedule Expression',
    'triggers.field.eventPattern': 'Event Pattern',
    'triggers.field.eventFilter': 'Filter',
    'triggers.field.filterField': 'Field',
    'triggers.field.filterOperator': 'Operator',
    'triggers.field.filterValue': 'Value',
    'triggers.eventCatalog.loading': 'Loading event catalog…',
    'triggers.eventCatalog.unavailable': 'Event catalog unavailable',
    'triggers.eventCatalog.noEvents': 'No matching events',
    'triggers.eventCatalog.noFields': 'No matching fields',
    'triggers.field.outputTemplate': 'Output Template',
    'triggers.field.prompt': 'Prompt',
    'triggers.field.executionType': 'Execution Type',
    'triggers.execution.agent': 'Prompt',
    'triggers.execution.script': 'Script',
    'triggers.field.scriptPath': 'Script Path',
    'triggers.field.scriptRuntime': 'Runtime',
    'triggers.field.model': 'Model',
    'triggers.field.effort': 'Effort',
    'triggers.field.permission': 'Permission Mode',
    'triggers.field.targetChannel': 'Target Channel',
    'triggers.field.channelId': 'Channel ID',
    'triggers.field.sessionStrategy': 'Session Selection',
    'triggers.field.threadId': 'Topic Session ID',
    'triggers.field.maxRuns': 'Max Runs',
    'triggers.field.maxDuration': 'Max Duration',
    'triggers.field.concurrency': 'When Previous Run Is Active',
    'triggers.field.missedPolicy': 'Missed Fire Time',
    'triggers.field.feedbackOnReply': 'On Reply',
    'triggers.field.feedbackOnNoop': 'On No Output',
    'triggers.field.feedbackOnFailure': 'On Failure',
    'triggers.field.feedbackAction': 'Feedback Action',
    'triggers.field.feedbackDelivery': 'Feedback Delivery',
    'triggers.field.scriptContent': 'Script Content',
    'triggers.placeholder.scheduleDuration': '30s / 15m / 2h / 1d',
    'triggers.placeholder.maxDuration': '30s / 15m / 2h / 1d',
    'triggers.placeholder.scriptPath': 'scripts/job.js --foo bar',
    'triggers.placeholder.filterValue': 'text / number / true / false',
    'triggers.concurrency.forbid': 'Skip this run',
    'triggers.concurrency.replace': 'Cancel previous and run',
    'triggers.concurrency.allow': 'Allow parallel runs',
    'triggers.missed.skip': 'Skip missed runs',
    'triggers.missed.run_once': 'Run once',
    'triggers.missed.run_all': 'Run all',
    'triggers.feedback.forward': 'Send to feedback target',
    'triggers.feedback.reply-origin': 'Reply to origin',
    'triggers.feedback.silent': 'Silent',
    'triggers.feedback.delivery.inbound': 'Into Agent session',
    'triggers.feedback.delivery.direct': 'Direct',
    'triggers.scriptPreview.empty': 'No script content',
    'triggers.scriptPreview.truncated': 'Content truncated',
    'triggers.lastUnrecorded': 'Not recorded',
    'triggers.collapse.expand': 'Expand Agent List',
    'triggers.collapse.collapse': 'Collapse Agent List',
    'triggers.empty.noAgents': 'No agents',
    'triggers.empty.noTriggers': 'No triggers',
    'triggers.empty.noAgentTriggers': 'No triggers for this agent',
    'triggers.th.status': 'Status',
    'triggers.th.subscription': 'Subscription',
    'triggers.th.name': 'Name',
    'triggers.th.type': 'Type',
    'triggers.th.expression': 'Expression',
    'triggers.th.lastFire': 'Last Fire',
    'triggers.th.nextFire': 'Next Fire',
    'triggers.th.fireCount': 'Fire Count',
    'triggers.th.failCount': 'Fail Count',
    'triggers.th.lastResult': 'Last Result',
    'triggers.th.targetChannel': 'Target Channel',
    'triggers.th.channelType': 'Channel Type',
    'triggers.th.createdBy': 'Created By',
    'triggers.th.createdChannel': 'Created Channel',
    'triggers.th.createdAt': 'Created At',
    'triggers.th.operations': 'Operations',
    'triggers.subscription.active': 'Subscribed',
    'triggers.subscription.inactive': 'Not subscribed',
    'triggers.subscription.event-bus-unavailable': 'No event bus',
    'triggers.filter.add': 'Add Condition',
    'triggers.filter.clear': 'Clear Conditions',
    'triggers.filter.none': 'No filter conditions',
    'triggers.filter.op.eq': 'Equals',
    'triggers.filter.op.in': 'In',
    'triggers.filter.op.regex': 'Regex',
    'triggers.filter.op.gt': 'Greater than',
    'triggers.filter.op.gte': 'Greater or equal',
    'triggers.filter.op.lt': 'Less than',
    'triggers.filter.op.lte': 'Less or equal',
    'triggers.filter.op.exists': 'Exists',

    // Usage view
    'usage.subtab.overview': 'Overview',
    'usage.subtab.explorer': 'Detailed Statistics',
    'usage.overview.range.today': 'Today',
    'usage.overview.range.week': 'This Week',
    'usage.overview.range.lastWeek': 'Last Week',
    'usage.overview.range.month': 'This Month',
    'usage.overview.range.last30': 'Last 30 Days',
    'usage.overview.range.custom': 'Custom',
    'usage.card.input': 'Input',
    'usage.card.output': 'Output',
    'usage.card.cacheRead': 'Cache Read',
    'usage.card.cacheHit': 'Cache Hit',
    'usage.card.calls': 'Calls',
    'usage.card.sessionCount': 'Sessions',
    'usage.card.msgIn': 'Received Messages',
    'usage.card.msgOut': 'Sent Messages',
    'usage.card.modelCalls': 'Model Calls',
    'usage.card.inputTokens': 'Input Tokens',
    'usage.card.outputTokens': 'Output Tokens',
    'usage.card.cacheCreation': 'Cache Creation',
    'usage.card.cacheHitTokens': 'Cache Hit',
    'usage.card.cacheHitRate': 'Cache Hit Rate',
    'usage.card.totalCost': 'Total Cost',
    'usage.card.costOfficial': 'Official Price',
    'usage.card.costGateway': 'Gateway Price',
    'usage.card.sessionInfo': 'Session Info',
    'usage.card.usageInfo': 'Usage Info',
    'usage.card.costInfo': 'Cost Info',
    'usage.detail.title': 'Model Access Details',
    'usage.detail.agent': 'Agent',
    'usage.detail.model': 'Model',
    'usage.detail.error': 'Query failed',
    'usage.detail.th.time': 'Time',
    'usage.detail.th.agent': 'Agent',
    'usage.detail.th.peer': 'Peer',
    'usage.detail.th.model': 'Model',
    'usage.detail.th.input': 'Input',
    'usage.detail.th.output': 'Output',
    'usage.detail.th.cacheCreation': 'Cache Creation',
    'usage.detail.th.cacheRead': 'Cache Read',
    'usage.detail.th.costOfficial': 'Official',
    'usage.detail.th.costGateway': 'Gateway',
    'usage.detail.pageSize': 'Per page',
    'usage.detail.prevPage': 'Previous',
    'usage.detail.nextPage': 'Next',
    'usage.detail.pagination': 'Showing {start}-{end} of {total} (Page {page}/{totalPages})',
    'usage.overview.title': 'Summary by Agent (All Time)',
    'usage.overview.noData': 'No data',
    'usage.overview.th.agent': 'Agent',
    'usage.overview.th.calls': 'Calls',
    'usage.overview.th.input': 'Input',
    'usage.overview.th.output': 'Output',
    'usage.overview.th.cacheCreation': 'Cache Creation',
    'usage.overview.th.cacheHit': 'Cache Hit',
    'usage.overview.th.cacheHitRate': 'Hit Rate',
    'usage.overview.th.costOfficial': 'Official Price',
    'usage.overview.th.costGateway': 'Gateway Price',
    'usage.overview.th.cost': 'Cost',
    'usage.dashboard.title.topPeers': 'Top Peers (Today)',
    'usage.dashboard.th.rank': '#',
    'usage.dashboard.th.peer': 'Peer',
    'usage.dashboard.th.tokens': 'Tokens',
    'usage.dashboard.th.calls': 'Calls',
    'usage.explorer.sidebar.agents': 'Agents',
    'usage.explorer.sidebar.peers': 'Peers',
    'usage.explorer.chatType.group': 'Group',
    'usage.explorer.chatType.private': 'Private',
    'usage.explorer.memberCount': ' members',
    'usage.explorer.selectHint': 'Select an Agent or Peer from the left',
    'usage.explorer.all': 'All',
    'usage.explorer.filter.from': 'From',
    'usage.explorer.filter.to': 'To',
    'usage.explorer.filter.model': 'Model',
    'usage.explorer.filter.granularity': 'Granularity',
    'usage.explorer.filter.granularity.hour': 'Hour',
    'usage.explorer.filter.granularity.day': 'Day',
    'usage.explorer.filter.granularity.week': 'Week',
    'usage.explorer.filter.granularity.month': 'Month',
    'usage.explorer.results': 'Results',
    'usage.explorer.noData': 'No data for selected range.',
    'usage.explorer.th.period': 'Period',
    'usage.explorer.th.input': 'Input',
    'usage.explorer.th.output': 'Output',
    'usage.explorer.th.cacheCreation': 'Cache↑',
    'usage.explorer.th.cacheHit': 'CacheHit',
    'usage.explorer.th.calls': 'Calls',

    // Role Definitions view
    'roleDefs.title': 'Role Definitions',
    'roleDefs.owner': 'Owner',
    'roleDefs.admin': 'Admin',
    'roleDefs.member': 'Member',
    'roleDefs.guest': 'Guest',
    'roleDefs.anonymous': 'Anonymous',
    'roleDefs.viewDetails': 'View Details',
    'roleDefs.edit': 'Edit',
    'roleDefs.reset': 'Reset',
    'roleDefs.save': 'Save',
    'roleDefs.cancel': 'Cancel',
    'roleDefs.permissionMode': 'Permission Mode',
    'roleDefs.model': 'Model',
    'roleDefs.dispatch': 'Dispatch',
    'roleDefs.allowOverride': 'Allow Override',
    'roleDefs.allowedModels': 'Allowed Models',
    'roleDefs.description': 'Description',
    'roleDefs.resetConfirm': 'Reset {role} to default configuration?',
    'roleDefs.saveSuccess': 'Saved successfully',
    'roleDefs.saveFailed': 'Save failed',

    // Role permission values
    'roleDefs.effort.low': 'Low (low)',
    'roleDefs.effort.medium': 'Medium (medium)',
    'roleDefs.effort.high': 'High (high)',
    'roleDefs.showActivities.true': 'Show (true)',
    'roleDefs.showActivities.false': 'Hide (false)',
    'roleDefs.permMode.bypass': 'Bypass (bypass)',
    'roleDefs.permMode.request': 'Request (request)',
    'roleDefs.permMode.auto': 'Auto (auto)',
    'roleDefs.permMode.readonly': 'Readonly (readonly)',
    'roleDefs.dispatch.broadcast': 'Broadcast (broadcast)',
    'roleDefs.dispatch.mention': 'Mention (mention)',

    // Roles view
    'roles.selectAgent': 'Select Agent:',
    'roles.selectAgentPlaceholder': '-- Select an Agent --',
    'roles.searchPlaceholder': 'Search peer...',
    'roles.table.chatType': 'Chat',
    'roles.table.peerName': 'Name',
    'roles.table.peerAid': 'Peer AID',
    'roles.table.peerType': 'Type',
    'roles.table.role': 'Role',
    'roles.table.source': 'Source',
    'roles.table.actions': 'Actions',
    'roles.chatType.private': 'Private',
    'roles.chatType.group': 'Group',
    'roles.filter.allChatType': 'All Chats',
    'roles.filter.private': '💬 Private',
    'roles.filter.group': '👥 Group',
    'roles.filter.allVerify': 'All Status',
    'roles.filter.verified': '✅ Verified',
    'roles.filter.invalid': '⚠️ Verification Failed',
    'roles.filter.unverified': '⚠️ Unverified',
    'roles.filter.unknown': '❓ Unknown',
  }
};

let currentLang = localStorage.getItem(LANG_KEY) || 'zh-CN';

function t(key) {
  return translations[currentLang]?.[key] || key;
}

function tf(key, vars) {
  const data = vars || {};
  return t(key).replace(/\{(\w+)\}/g, (_, k) => data[k] == null ? '' : String(data[k]));
}

function updateI18n() {
  // 处理元素文本内容
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = text;
    } else if (el.tagName === 'OPTION') {
      el.textContent = text;
    } else {
      el.textContent = text;
    }
  });
  // 处理 title 属性（单独的 data-i18n-title）
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.title = t(key);
  });
  // 更新 html lang 属性
  document.documentElement.lang = currentLang;
  updateThemeButton();
}

function toggleLang() {
  currentLang = currentLang === 'zh-CN' ? 'en-US' : 'zh-CN';
  localStorage.setItem(LANG_KEY, currentLang);
  updateI18n();
  // 强制重新渲染当前视图
  if (currentView === 'usage') refreshUsageView();
  else if (state[currentView]) renderView(currentView);
}

// ── 基础路径 ──
// 本地直连时页面在 "/"，经 AUN Service Proxy 时页面在 "/ecweb/"。
// 取当前页面所在目录（含尾斜杠）作为所有 API/WS 的前缀，使绝对路径在两种
// 部署下都正确（proxy-server 用首段路径选服务，前缀不能丢）。
const BASE = location.pathname.replace(/[^/]*$/, '');
const apiUrl = (p) => BASE + p.replace(/^\/+/, '');

// ── 配对 ──
async function pair(code) {
  const resp = await fetch(apiUrl('api/pair'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return resp.json();
}

// 本地直连免配对：用空码探测，服务端若判定本地直连会直接发 token。
// 远程（隧道/真远程）会返回配对码错误，此时回落到配对页。
async function tryLocalAutoPair() {
  try {
    const res = await pair('');
    if (res && res.ok && res.token) {
      localStorage.setItem(TOKEN_KEY, res.token);
      return true;
    }
  } catch {}
  return false;
}

function showPairPage(hint) {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  $('#pair-page').style.display = 'flex';
  $('#app').style.display = 'none';
  if (hint) $('#pair-error').textContent = hint;
}
function showApp() {
  $('#pair-page').style.display = 'none';
  $('#app').style.display = 'flex';
  $('#pair-error').textContent = '';
}

function initPairUI() {
  const input = $('#pair-input');
  const btn = $('#pair-btn');
  const err = $('#pair-error');
  const submit = async () => {
    const code = input.value.trim();
    if (code.length !== 6) { err.textContent = t('pair.error.length'); return; }
    btn.disabled = true; err.textContent = '';
    try {
      const res = await pair(code);
      if (res.ok) {
        localStorage.setItem(TOKEN_KEY, res.token);
        showApp();
        startApp();
      } else {
        err.textContent = res.reason || t('pair.error.failed');
      }
    } catch {
      err.textContent = t('pair.error.network');
    } finally {
      btn.disabled = false;
    }
  };
  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  input.focus();
}

// ── WebSocket 客户端（自动重连）──
let ws = null;
let reconnectDelay = 1000;
let currentView = localStorage.getItem(VIEW_KEY) || 'agents';
let pendingSub = null;        // 重连后要恢复的订阅
const state = { agents: null, msg: null, session: null, cache: null, system: null, triggers: null, monitor: null, gateway: null, roles: null, roleDefinitions: null };

function setConnStatus(text, cls) {
  const el = $('#conn-status');
  el.textContent = text;
  el.className = 'conn-status' + (cls ? ' ' + cls : '');
}

function connect() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) { showPairPage(); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${BASE}ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    setConnStatus('● ' + t('status.connected'), 'ok');
    reconnectDelay = 1000;
    // 获取可用的 baseagent
    fetch(`${BASE}api/available-baseagents`)
      .then(r => r.json())
      .then(data => {
        availableBaseagents = data;
        // 如果当前没有选中 baseagent，默认选第一个可用的
        if (!sessSel.baseagent) {
          sessSel.baseagent = data.claude ? 'claude' : (data.codex ? 'codex' : null);
        }
        console.log('[ecweb] Available baseagents:', availableBaseagents, 'Selected:', sessSel.baseagent);
        // 重新订阅当前视图（带上正确的参数）
        if (currentView === 'session') {
          subscribe('session', { sessionId: sessSel.sessionId, project: sessSel.project, baseagent: sessSel.baseagent });
        } else {
          subscribe(currentView, pendingSub || {});
        }
      })
      .catch(err => {
        console.warn('[ecweb] Failed to fetch available-baseagents:', err);
        // 失败时默认使用 claude
        availableBaseagents = { claude: true, codex: false };
        if (!sessSel.baseagent) sessSel.baseagent = 'claude';
        subscribe(currentView, pendingSub || {});
      });
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'error') { console.warn('[ecweb] Server error:', msg.message); return; }
    if (msg.type === 'menu.response') {
      const pend = _menuPending[msg.requestId];
      if (pend) { delete _menuPending[msg.requestId]; pend.resolve(msg.data); }
      return;
    }
    if (msg.type === 'ipc.response') {
      const pend = _ipcPending[msg.requestId];
      if (pend) { delete _ipcPending[msg.requestId]; pend.resolve(msg.data); }
      return;
    }
    if (msg.type === 'snapshot' || msg.type === 'delta') {
      console.log('[ecweb] Received', msg.type, 'for view:', msg.view, 'currentView:', currentView);
      // system 视图保留客户端写入的 check/upgrade，防止 3s 轮询覆盖
      if (msg.view === 'system' && state.system) {
        state.system = {
          ...msg.data,
          check: state.system.check ?? msg.data.check,
          upgrade: state.system.upgrade ?? msg.data.upgrade,
        };
      } else {
        state[msg.view] = msg.data;
      }
      if (msg.view === currentView) {
        console.log('[ecweb] Rendering view:', currentView, 'with data:', msg.data);
        renderView(currentView);
      }
    }
  };

  ws.onclose = (ev) => {
    if (ev.code === 4001) {
      localStorage.removeItem(TOKEN_KEY);
      showPairPage(t('pair.error.tokenInvalid'));
      return;
    }
    setConnStatus('○ ' + t('status.reconnecting') + '…', 'err');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

function subscribe(view, params) {
  pendingSub = params;
  if (ws && ws.readyState === WebSocket.OPEN) {
    // session 视图添加 baseagent 参数
    if (view === 'session' && sessSel.baseagent) {
      params = { ...params, baseagent: sessSel.baseagent };
    }
    console.log('[ecweb] Subscribing:', view, params);
    ws.send(JSON.stringify({ type: 'subscribe', view, ...params }));
  } else {
    console.warn('[ecweb] WebSocket not ready, subscription pending');
  }
}

// ── Menu 写请求（update/action）：经 WS menu 消息，requestId 配对响应 ──
const _menuPending = {};
let _menuSeq = 0;
function menuSend(payload) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error(t('common.notConnected'))); return; }
    const requestId = 'ecw-' + (++_menuSeq);
    const { timeoutMs, ...sendPayload } = payload || {};
    const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 6000;
    const withId = { ...sendPayload, id: sendPayload.id || requestId };
    _menuPending[requestId] = { resolve, reject };
    setTimeout(() => {
      if (_menuPending[requestId]) { delete _menuPending[requestId]; reject(new Error('timeout')); }
    }, timeout);
    ws.send(JSON.stringify({ type: 'menu', requestId, payload: withId, timeoutMs: timeout }));
  });
}

const _ipcPending = {};
let _ipcSeq = 0;
function ipcSend(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error(t('common.notConnected'))); return; }
    const requestId = 'ecw-ipc-' + (++_ipcSeq);
    const wait = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000;
    _ipcPending[requestId] = { resolve, reject };
    setTimeout(() => {
      if (_ipcPending[requestId]) { delete _ipcPending[requestId]; reject(new Error('timeout')); }
    }, wait + 1000);
    ws.send(JSON.stringify({ type: 'ipc', requestId, payload, timeoutMs: wait }));
  });
}

// 心跳
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
}, 20000);

// ── Tab 切换 ──
let msgSel = { aid: null, peer: null };
let sessSel = { sessionId: null, project: null, baseagent: null };
let trigSel = { agent: null };
let trigAgentsCollapsed = false;
const _trigOps = new Map(); // Map<triggerId, string>
let _triggerEdit = null;
let sessSearch = '';
let sessFilterNormal = false; // true=只显示有效会话（userMsgs >= 1）
let sessChatMode = false;   // false=完整视图，true=对话视图（折叠处理过程）
let monRange = '2m';        // Monitor 时间窗口：2m / 10m / 1h
let availableBaseagents = { claude: false, codex: false }; // 可用的 baseagent

function switchView(view) {
  currentView = view;
  localStorage.setItem(VIEW_KEY, view);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  // 切换时按当前选择恢复订阅
  if (view === 'msg') subscribe('msg', { aid: msgSel.aid, peer: msgSel.peer });
  else if (view === 'session') subscribe('session', { sessionId: sessSel.sessionId, project: sessSel.project, baseagent: sessSel.baseagent });
  else if (view === 'cache') subscribe('cache', {});
  else if (view === 'system') subscribe('system', {});
  else if (view === 'triggers') subscribe('triggers', { agent: trigSel.agent });
  else if (view === 'monitor') subscribe('monitor', { range: monRange });
  else if (view === 'gateway') subscribe('gateway', {});
  else if (view === 'usage') refreshUsageView();
  else if (view === 'roleDefinitions') subscribe('roleDefinitions', {});
  else if (view === 'roles') subscribe('roles', {});
  else subscribe('agents', {});
  if (state[view]) renderView(view);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => switchView(tab.dataset.view);
  });
}

function renderView(view) {
  if (view === 'agents') renderAgents(state.agents);
  else if (view === 'msg') renderMsg(state.msg);
  else if (view === 'session') renderSession(state.session);
  else if (view === 'cache') renderCache(state.cache);
  else if (view === 'system') renderSystem(state.system);
  else if (view === 'triggers') renderTriggers(state.triggers);
  else if (view === 'monitor') renderMonitor(state.monitor);
  else if (view === 'gateway') renderGateway(state.gateway);
  else if (view === 'roles') renderRoles(state.roles);
  else if (view === 'roleDefinitions') renderRoleDefinitions(state.roleDefinitions);
}

// ── 工具 ──
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function shortAid(aid) { return String(aid || '').split('.')[0]; }
function shortId(id) {
  const s = String(id || '');
  if (!s) return 'unknown';
  return s.includes('.') ? shortAid(s) : (s.length > 18 ? s.slice(0, 10) + '…' + s.slice(-5) : s);
}
function fmtBytes(b) {
  if (!b) return '0';
  const u = ['B', 'KB', 'MB', 'GB']; let i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + u[i];
}
function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
// 秒数 → 可读时长（如 3d 2h / 5h 12m / 8m 3s）
function fmtDur(sec) {
  if (sec == null) return '—';
  const s = Math.floor(Number(sec) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sx = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sx}s`;
  return `${sx}s`;
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// semver 比较：-1 (a<b) / 0 / 1 (a>b)，剥离 pre-release 标签
function compareVer(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number);
  const pb = String(b).split('-')[0].split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

// ── Agents 视图（对齐终端 watch aid：状态点前置 + 名字为主 + 两行 + 工作态着色 + 顶部统计条）──

// 逐 AID 异步操作状态：aid → 操作中的描述文字
const _agentOps = new Map(); // Map<aid, string>
let _agSubtab = 'enabled'; // 'enabled' | 'disabled'

// 工作状态徽标：一旦收到过消息就不再回 connected。
// stopped → connected(仅首次连接无消息时) → idle(收到第一条后) → working → idle ...
function agentStateBadge(s, agStatus, connStatus) {
  if (agStatus === 'stopped' || connStatus === 'disconnected' || connStatus === 'failed')
    return `<span class="state-badge stopped">${t('status.stopped')}</span>`;
  if (connStatus === 'reconnecting')
    return `<span class="state-badge stopped">${t('status.reconnecting')}</span>`;
  if ((s.processing || 0) > 0)
    return `<span class="state-badge working">${t('status.working')}</span>`;
  // 收到过消息 → 永远是 idle，不再回到 connected
  if ((s.received || 0) > 0 || (s.sent || 0) > 0 || (s.completed || 0) > 0 || (s.errors || 0) > 0 || (s.interrupts || 0) > 0 ||
      (s.messagesReceived || 0) > 0 || (s.messagesSent || 0) > 0)
    return `<span class="state-badge idle">${t('status.idle')}</span>`;
  return `<span class="state-badge connected">${t('status.connected')}</span>`;
}

// 发送方式图标标记
const MSG_KIND_META = {
  send: { icon: '💬', label: () => t('messages.msgKind.reply') },
  thought: { icon: '💭', label: () => t('messages.msgKind.thought') },
  inject: { icon: '📥', label: () => t('messages.msgKind.inject') },
  notify: { icon: '🔔', label: () => t('messages.msgKind.notify') }
};
// 消息详情流用：jsonl 持久化的 msgType 词汇（text 为普通回复，不另标）
const MSG_TYPE_META = {
  thought: { icon: '💭', label: () => t('messages.msgType.thought') },
  image: { icon: '🖼️', label: () => t('messages.msgType.image') },
  file: { icon: '📎', label: () => t('messages.msgType.file') },
  command: { icon: '⌘', label: () => t('messages.msgType.command') }
};
function msgTagsHtml(kind, encrypt, chatmode, dir) {
  let h = '';
  // 'send' 仅出向才是「回复」；入向是用户输入，不打回复标记
  const km = (kind === 'send' && dir === 'in') ? null : MSG_KIND_META[kind];
  if (km) h += `<span class="mtag${kind === 'send' ? ' mtag-reply' : ''}">${km.icon}${km.label()}</span>`;
  if (encrypt != null) h += `<span class="mtag">${encrypt ? t('messages.tag.encrypted') : t('messages.tag.plain')}</span>`;
  if (chatmode) h += `<span class="mtag">${chatmode === 'proactive' ? t('messages.tag.proactive') : (chatmode === 'inject' ? t('messages.tag.inject') : t('messages.tag.responsive'))}</span>`;
  return h;
}

// 消息行：方向箭头 + 标记 + 对端 + 文字
function agentPreviewHtml(s) {
  const clip = (t) => esc(String(t).replace(/\n/g, ' ').slice(0, 80));
  const line = (dir, peer, text, kind, encrypt, chatmode) => {
    const arrow = dir === 'in' ? '<span class="arrow-in">↓</span>' : '<span class="arrow-out">↑</span>';
    const tags = msgTagsHtml(kind, encrypt, chatmode, dir);
    const peerHtml = peer ? `<span class="peer">${esc(shortAid(peer))}</span>: ` : '';
    const textCls = dir === 'in' ? 'text-in' : 'text-out';
    return `${arrow}${tags ? ' ' + tags + ' ' : ' '}${peerHtml}<span class="${textCls}">${clip(text)}</span>`;
  };
  if ((s.processing || 0) > 0 && s.lastReceivedText)
    return line('in', s.lastReceivedFrom, s.lastReceivedText, s.lastReceivedKind, s.lastReceivedEncrypt, s.lastReceivedChatmode);
  const recvTs = s.lastReceivedAt || 0, sentTs = s.lastSentAt || 0;
  if (!recvTs && !sentTs) return '';
  if (sentTs > recvTs && s.lastSentText)
    return line('out', s.lastSentTo, s.lastSentText, s.lastSentKind, s.lastSentEncrypt, s.lastSentChatmode);
  if (s.lastReceivedText)
    return line('in', s.lastReceivedFrom, s.lastReceivedText, s.lastReceivedKind, s.lastReceivedEncrypt, s.lastReceivedChatmode);
  return '';
}

// HTML tooltip（最近 N 轮）：时间 + 彩色箭头 + 方式 + 对端 + 文字
// 渲染为隐藏的内容持有节点（.msg-tip-src）；实际展示由 initMsgTipFloat 的浮层负责
function recentMsgTooltipHtml(recent) {
  if (!recent || !recent.length) return '';
  let h = '<div class="msg-tip-src">';
  for (const m of recent) {
    const rcls = m.dir === 'in' ? 'tip-row-in' : 'tip-row-out';
    const arrow = m.dir === 'in' ? '↓' : '↑';
    // 'send' 仅出向才是「回复」；入向是用户输入，不打回复标记
    const km = (m.kind === 'send' && m.dir === 'in') ? null : MSG_KIND_META[m.kind];
    const kh = km ? `<span class="tip-kind${m.kind === 'send' ? ' tip-kind-reply' : ''}">${km.icon}${km.label()}</span>` : '';
    const enc = m.encrypt != null ? `<span class="tip-flag">${m.encrypt ? t('messages.tag.encrypted') : t('messages.tag.plain')}</span>` : '';
    const mode = m.chatmode ? `<span class="tip-flag">${m.chatmode === 'proactive' ? t('messages.tag.proactive') : (m.chatmode === 'inject' ? t('messages.tag.inject') : t('messages.tag.responsive'))}</span>` : '';
    const peer = m.peer ? esc(shortAid(m.peer)) : '';
    const text = esc(String(m.text).replace(/\n/g, ' ').slice(0, 140));
    const time = m.ts ? `<span class="tip-time">${fmtTime(m.ts)}</span>` : '';
    h += `<div class="tip-row ${rcls}">${time}${arrow}${kh}${enc}${mode} <b>${peer}</b> ${text}</div>`;
  }
  return h + '</div>';
}

// 单例浮层 tooltip：固定定位、自动翻转上下、横向夹取，确保始终在可视区域内；
// 鼠标可移动到 tooltip 上而不消失（延迟隐藏 + 进入取消）。
function initMsgTipFloat() {
  if (initMsgTipFloat._done) return;
  initMsgTipFloat._done = true;

  let floatEl = null, hideTimer = null, curWrap = null;
  const GAP = 8, MARGIN = 8;

  function ensureFloat() {
    if (floatEl) return floatEl;
    floatEl = document.createElement('div');
    floatEl.id = 'msg-tip-float';
    floatEl.className = 'msg-tip';
    document.body.appendChild(floatEl);
    floatEl.addEventListener('mouseenter', cancelHide);
    floatEl.addEventListener('mouseleave', scheduleHide);
    return floatEl;
  }
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  function scheduleHide() { cancelHide(); hideTimer = setTimeout(hideNow, 180); }
  function hideNow() { cancelHide(); curWrap = null; if (floatEl) floatEl.classList.remove('show'); }

  function position(wrap) {
    const f = floatEl;
    const r = wrap.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const fw = f.offsetWidth, fh = f.offsetHeight;
    // 纵向：优先放上方；上方放不下则放下方；都放不下则在视口内夹取
    let top;
    if (r.top - GAP - fh >= MARGIN) top = r.top - GAP - fh;
    else if (r.bottom + GAP + fh <= vh - MARGIN) top = r.bottom + GAP;
    else top = Math.max(MARGIN, Math.min(vh - MARGIN - fh, r.top - GAP - fh));
    // 横向：对齐左缘，超出右界则左移，再夹取左界
    let left = r.left;
    if (left + fw > vw - MARGIN) left = vw - MARGIN - fw;
    if (left < MARGIN) left = MARGIN;
    f.style.top = Math.round(top) + 'px';
    f.style.left = Math.round(left) + 'px';
  }

  function show(wrap) {
    const src = wrap.querySelector('.msg-tip-src');
    if (!src || !src.innerHTML.trim()) return;
    const f = ensureFloat();
    cancelHide();
    if (curWrap !== wrap) { f.innerHTML = src.innerHTML; curWrap = wrap; }
    f.classList.add('show');
    position(wrap);
  }

  document.addEventListener('mouseover', (e) => {
    const wrap = e.target.closest && e.target.closest('.ag-msg-wrap');
    if (wrap) show(wrap);
  });
  document.addEventListener('mouseout', (e) => {
    const wrap = e.target.closest && e.target.closest('.ag-msg-wrap');
    if (!wrap) return;
    const to = e.relatedTarget;
    if (to && (wrap.contains(to) || (floatEl && floatEl.contains(to)))) return;
    scheduleHide();
  });
  // 滚动时隐藏，避免浮层与行脱节
  window.addEventListener('scroll', hideNow, true);
}

// 顶部统计条：Gateway / AIDs total·connected·offline / Messages / Version·PID·Uptime
function agentsStatsBar(data, aids, agentStats) {
  const connected = aids.filter(a => (a.status || 'connected') === 'connected').length;
  const offline = aids.length - connected;
  let recv = 0, sent = 0, done = 0, errors = 0, interrupts = 0;
  for (const s of agentStats) {
    recv += s.received || 0;
    sent += s.sent || 0;
    done += s.completed || 0;
    errors += s.errors || 0;
    interrupts += s.interrupts || 0;
  }
  const gws = [...new Set(aids.filter(a => a.gatewayUrl).map(a => a.gatewayUrl))];
  const gw = gws.length ? gws.map(esc).join(', ') : '—';
  const st = data.status || {};
  const pid = st.pid != null ? st.pid : '—';
  const uptime = st.uptime != null ? fmtDur(st.uptime / 1000) : '—';
  const ver = data.version || '—';

  let h = '<div class="agents-stats">';
  h += `<span class="sg"><span class="sg-k">${t('agents.stats.gateway')}</span><span class="sg-gw">${gw}</span></span>`;
  h += `<span class="sg"><span class="sg-k">${t('agents.stats.aids')}</span>${aids.length} ${t('agents.stats.total')} · <span class="num-on">${connected} ${t('agents.stats.online')}</span>` +
    `${offline ? ` · <span class="num-off">${offline} ${t('agents.stats.offline')}</span>` : ''}</span>`;
  h += `<span class="sg"><span class="sg-k">${t('agents.stats.messages')}</span>${t('monitor.th.received')} ${recv} · ${t('monitor.th.sent')} ${sent} · ${t('monitor.th.errors')} ${errors} · ${t('monitor.th.interrupts')} ${interrupts} · ${t('monitor.th.completed')} ${done}</span>`;
  h += `<span class="sg"><span class="sg-k">${t('agents.stats.version')}</span>${esc(ver)} · <span class="sg-k">${t('agents.stats.pid')}</span>${pid} · <span class="sg-k">${t('agents.stats.uptime')}</span>${uptime}</span>`;
  h += '</div>';
  return h;
}

function agentQueueHtml(s) {
  const processing = s.processing || 0;
  const queued = s.queued || 0;
  if (processing === 0 && queued === 0) return '<span class="ag-queue-empty">-</span>';
  return `<span class="ag-queue-num">${processing}/${queued}</span>`;
}

function agentOpsBusyHtml(aid, label) {
  return `<div class="agent-ops agent-ops-busy" data-aid="${esc(aid)}"><span class="ops-busy-label">${esc(label || t('common.operating'))}</span></div>`;
}

function agentDisabledOpsHtml(aid) {
  return `<div class="agent-ops agent-ops-disabled" data-aid="${esc(aid)}" data-status="disabled">` +
    `<button class="ctrl-btn ops-enable" data-op="toggle">${t('action.enable')}</button>` +
    `<div class="ops-more"><button class="ctrl-btn ops-more-btn" data-op="more">···</button>` +
    `<div class="ops-dropdown">` +
    `<button class="ops-dd-item" data-op="edit">${t('action.edit')}</button>` +
    `<a class="ops-dd-item" href="https://${esc(aid)}/agent.md" target="_blank" rel="noopener">${t('agents.op.viewAgentMd')}</a>` +
    `<button class="ops-dd-item danger" data-op="delete">${t('action.delete')}</button>` +
    `</div></div>` +
    `</div>`;
}

// 操作列 HTML（启用页）：停止/启动 + 清空队列(conditional) + ···(禁用/重载/编辑/md/删除)
function agentOpsHtml(aid, ag, s) {
  if (_agentOps.has(aid)) {
    return agentOpsBusyHtml(aid, _agentOps.get(aid));
  }
  const queued = s.queued || 0;
  const running = ag.status === 'running';
  let h = `<div class="agent-ops" data-aid="${esc(aid)}" data-status="${esc(ag.status)}">`;
  if (running) h += `<button class="ctrl-btn ops-stop" data-op="stop">${t('action.stop')}</button>`;
  else         h += `<button class="ctrl-btn ops-start" data-op="start">${t('action.start')}</button>`;
  if (queued > 0) h += `<button class="ctrl-btn ops-clear-queue" data-op="clear-queue" title="${t('agents.op.clearQueueTitle').replace('{count}', queued)}">${t('action.clearQueue')}</button>`;
  h += `<div class="ops-more"><button class="ctrl-btn ops-more-btn" data-op="more">···</button>` +
    `<div class="ops-dropdown">` +
    `<button class="ops-dd-item" data-op="toggle">${t('action.disable')}</button>` +
    `<button class="ops-dd-item" data-op="reload">${t('action.reload')}</button>` +
    `<button class="ops-dd-item" data-op="edit">${t('action.edit')}</button>` +
    `<a class="ops-dd-item" href="https://${esc(aid)}/agent.md" target="_blank" rel="noopener">${t('agents.op.viewAgentMd')}</a>` +
    `<button class="ops-dd-item danger" data-op="delete">${t('action.delete')}</button>` +
    `</div></div>`;
  h += '</div>';
  return h;
}

function renderAgents(data) {
  const el = $('#view-agents');
  if (!data) { el.innerHTML = `<div class="empty">${t('common.loading')}</div>`; return; }
  if (el.querySelector('.ops-more.open')) return;

  const allAgents = data.agents || [];
  const aids = data.aids || [];
  const statsByAid = {};
  for (const s of (data.stats || [])) statsByAid[s.aid] = s;
  const agentStatsByAid = {};
  for (const s of (data.agentStats || [])) agentStatsByAid[s.aid] = s;
  const aidConnByAid = {};
  for (const a of aids) aidConnByAid[a.aid] = a;

  const enabledCount = allAgents.filter(ag => ag.status !== 'disabled').length;
  const disabledCount = allAgents.filter(ag => ag.status === 'disabled').length;

  // 子标签栏
  let html = '<div class="agents-toolbar">' +
    `<div class="ag-subtabs">` +
    `<button class="ag-subtab${_agSubtab === 'enabled' ? ' active' : ''}" data-subtab="enabled">${t('agents.subtitle.enabled')} (${enabledCount})</button>` +
    `<button class="ag-subtab${_agSubtab === 'disabled' ? ' active' : ''}" data-subtab="disabled">${t('agents.subtitle.disabled')} (${disabledCount})</button>` +
    `</div>` +
    `<button class="ctrl-btn agent-new-btn" id="agent-new-btn">${t('action.new')}</button>` +
    '</div>';

  if (!data.daemonRunning) {
    html += `<div class="banner">${t('agents.daemonStopped')}</div>`;
  }

  if (_agSubtab === 'disabled') {
    const disabledAgents = allAgents.filter(ag => ag.status === 'disabled');
    if (!disabledAgents.length) {
      html += `<div class="empty">${t('agents.empty.disabled')}</div>`;
    } else {
      html += `<table><thead><tr><th>${t('agents.th.agent')}</th><th>${t('agents.th.projectPath')}</th><th>${t('agents.th.operations')}</th></tr></thead><tbody>`;
      for (const ag of disabledAgents) {
        const busy = _agentOps.has(ag.aid);
        const ops = busy
          ? agentOpsBusyHtml(ag.aid, _agentOps.get(ag.aid))
          : agentDisabledOpsHtml(ag.aid);
        html += `<tr class="ag-main">` +
          `<td><div class="ag-id"><span class="dot off"></span><span class="ag-id-text"><span class="ag-name">${esc(ag.displayName || shortAid(ag.aid))}</span><span class="ag-aid">${esc(ag.aid)}</span></span></div></td>` +
          `<td style="font-size:11px;font-family:monospace">${esc(ag.projectPath || '—')}</td>` +
          `<td class="agent-ops-cell">${ops}</td></tr>`;
      }
      html += '</tbody></table>';
    }
    el.innerHTML = html;
    bindAgentsEvents(el);
    return;
  }

  // ── 启用页 ──
  // 按全渠道任务活动降序排序（活跃的排前面）
  const totalActivity = (ag) => {
    const s = agentStatsByAid[ag.aid] || {};
    return (s.received || 0) + (s.sent || 0) + (s.completed || 0) + (s.errors || 0) + (s.interrupts || 0);
  };
  const enabledAgents = allAgents.filter(ag => ag.status !== 'disabled')
    .sort((a, b) => totalActivity(b) - totalActivity(a));
  if (!enabledAgents.length) {
    html += `<div class="empty">${t('agents.empty.enabled')}</div>`;
    el.innerHTML = html;
    bindAgentsEvents(el);
    return;
  }

  html += '<table><thead><tr>' +
    `<th>${t('agents.th.aid')}</th><th>${t('agents.th.work')}</th><th>${t('agents.th.queue')}</th><th>${t('agents.th.model')}</th><th>${t('agents.th.runtime')}</th>` +
    `<th>${t('agents.th.received')}</th><th>${t('agents.th.sent')}</th><th>${t('agents.th.errors')}</th><th>${t('agents.th.interrupts')}</th><th>${t('agents.th.completed')}</th>` +
    `<th>${t('agents.th.lastActivity')}</th><th>${t('agents.th.operations')}</th>` +
    '</tr></thead><tbody>';

  for (const ag of enabledAgents) {
    const s = statsByAid[ag.aid] || {};
    const runStats = agentStatsByAid[ag.aid] || {};
    const conn = aidConnByAid[ag.aid] || {};
    const connStatus = conn.status || (ag.status === 'running' ? 'connected' : 'disconnected');
    const dotCls = connStatus === 'connected' ? 'on' : (connStatus === 'reconnecting' ? 'idle' : 'off');
    const name = s.selfName || ag.displayName || shortAid(ag.aid);
    const uptime = (connStatus === 'connected' && conn.lastConnectedAt) ? fmtDur((Date.now() - conn.lastConnectedAt) / 1000) : '—';
    const lastTs = Math.max(s.lastReceivedAt || 0, s.lastSentAt || 0, ag.lastActivity || 0);
    const preview = agentPreviewHtml(s);
    const queueCell = agentQueueHtml(runStats);
    const model = ag.model || ag.baseagent || '—';

    const idCell = `<div class="ag-id"><span class="dot ${dotCls}" title="${esc(connStatus)}"></span>` +
      `<span class="ag-id-text"><span class="ag-name">${esc(name)}</span>` +
      `<span class="ag-aid">${esc(ag.aid)}</span></span></div>`;

    html += `<tr class="ag-main">` +
      `<td>${idCell}</td>` +
      `<td>${agentStateBadge({ ...s, ...runStats }, ag.status, connStatus)}</td>` +
      `<td>${queueCell}</td>` +
      `<td style="font-size:11px;color:var(--dim)">${esc(model)}</td>` +
      `<td>${uptime}</td>` +
      `<td>${runStats.received || 0}</td>` +
      `<td>${runStats.sent || 0}</td>` +
      `<td>${runStats.errors || 0}</td>` +
      `<td>${runStats.interrupts || 0}</td>` +
      `<td>${runStats.completed || 0}</td>` +
      `<td>${fmtAgo(lastTs)}</td>` +
      `<td class="agent-ops-cell">${agentOpsHtml(ag.aid, ag, runStats)}</td>` +
      '</tr>';
    // 自定义 tooltip（HTML，hover 显示）
    const recent = (s.recentMessages || []);
    const tipHtml = recentMsgTooltipHtml(recent);

    html += `<tr class="ag-sub"><td colspan="12"><div class="ag-info">` +
      (ag.projectPath ? `<div class="ag-path">${esc(ag.projectPath)}</div>` : '') +
      (preview ? `<div class="ag-msg-wrap">${tipHtml}<div class="ag-msg">${preview}</div></div>` : '') +
      '</div></td></tr>';
  }
  html += '</tbody></table>';
  if (data.daemonRunning) {
    html += agentsStatsBar(data, aids, data.agentStats || []);
  }
  el.innerHTML = html;
  bindAgentsEvents(el);
}

// ── Cache 视图（daemon 统一 FileCache 运行统计）──
// fmtNum 复用文件内既有定义（千分位缩写）。
function hitRate(c) {
  const denom = (c.hits || 0) + (c.misses || 0);
  return denom ? (c.hits / denom) : null;
}
function fmtPct(r) {
  if (r == null) return '—';
  return (r * 100).toFixed(1) + '%';
}
function rateCls(r) {
  if (r == null) return '';
  if (r >= 0.9) return 'on';
  if (r >= 0.6) return 'idle';
  return 'off';
}
// group 名按用途归类，给出友好标签：config:<aid> / agent-files:<aid> 提取 aid
function groupLabel(g) {
  if (g.startsWith('agent-files:')) return { kind: 'agent', label: shortAid(g.slice('agent-files:'.length)), sub: t('cache.group.identity') };
  if (g.startsWith('config:')) return { kind: 'agent', label: shortAid(g.slice('config:'.length)), sub: 'config' };
  if (g === 'config') return { kind: 'global', label: 'defaults', sub: t('cache.group.global') };
  if (g === 'relation-prefs') return { kind: 'relation', label: 'relation-prefs', sub: t('cache.group.relationPrefs') };
  if (g === 'kits') return { kind: 'kits', label: 'kits', sub: 'manifest/fragment/md' };
  return { kind: 'other', label: g, sub: '' };
}

function renderCache(data) {
  const el = $('#view-cache');
  if (!data) { el.innerHTML = `<div class="empty">${t('common.loading')}</div>`; return; }
  if (!data.daemonRunning) {
    el.innerHTML = `<div class="banner">${t('cache.daemonStopped')}</div>`;
    return;
  }
  if (!data.supported || !data.stats) {
    el.innerHTML = `<div class="banner">${t('cache.notSupported')}</div>`;
    return;
  }
  const s = data.stats;
  const tot = s.totals;
  const occ = s.occupancy || {};
  // 全部组占用合计
  let totalBytes = 0;
  for (const g in occ) totalBytes += occ[g].bytes || 0;

  let html = '';

  // ① 总览卡片
  const rate = hitRate(tot);
  html += '<div class="cache-cards">';
  html += card(t('cache.card.hitRate'), fmtPct(rate), rateCls(rate), `${fmtNum(tot.hits)} ${t('cache.card.hit')} / ${fmtNum(tot.misses)} ${t('cache.card.miss')}`);
  html += card(t('cache.card.reads'), fmtNum(tot.gets), '', `${fmtNum(tot.hits)} ${t('cache.card.hit')} · ${fmtNum(tot.misses)} ${t('cache.card.miss')}`);
  html += card(t('cache.card.entries'), fmtNum(s.size), '', fmtBytes(totalBytes) + ' ' + t('cache.card.memory'));
  html += card(t('cache.card.statChecks'), fmtNum(tot.statChecks), '', 'mtime ' + t('cache.policy.mtime'));
  html += card(t('cache.card.reReads'), fmtNum(tot.reReads), '', t('cache.policy.manual'));
  html += card(t('cache.card.evictions'), fmtNum(tot.evictions), tot.evictions ? 'idle' : '', 'LRU');
  html += card(t('cache.card.invalidations'), fmtNum(tot.invalidations), '', 'reload');
  html += card(t('cache.card.since'), fmtAgo(s.since) + ' ' + t('cache.card.ago'), '', fmtTime(s.since));
  html += '</div>';

  // ② 按 group 表（每组命中率 + 占用 + 容量水位）
  html += `<h3 class="cache-h">${t('cache.section.byGroup')}</h3>`;
  html += '<table><thead><tr>' +
    `<th>${t('cache.th.group')}</th><th>${t('cache.th.type')}</th><th>${t('cache.th.reads')}</th><th>${t('cache.th.hits')}</th><th>${t('cache.th.misses')}</th><th>${t('cache.th.hitRate')}</th>` +
    `<th>${t('cache.th.reReads')}</th><th>${t('cache.th.evictions')}</th><th>${t('cache.th.entries')}</th><th>${t('cache.th.memory')}</th><th>${t('cache.th.capacity')}</th>` +
    '</tr></thead><tbody>';
  const groups = Object.keys(s.byGroup).sort((a, b) => (s.byGroup[b].gets || 0) - (s.byGroup[a].gets || 0));
  for (const g of groups) {
    const c = s.byGroup[g];
    const o = occ[g] || { size: 0, bytes: 0, cap: null };
    const gl = groupLabel(g);
    const r = hitRate(c);
    let capCell = '—';
    if (o.cap != null) {
      const pct = o.cap ? Math.round((o.size / o.cap) * 100) : 0;
      const cls = pct >= 90 ? 'off' : (pct >= 70 ? 'idle' : 'on');
      capCell = `<span class="dot ${cls}"></span>${o.size}/${o.cap}`;
    }
    html += '<tr>' +
      `<td>${esc(gl.label)}${gl.sub ? ` <span style="color:var(--dim)">${esc(gl.sub)}</span>` : ''}</td>` +
      `<td><span class="cache-tag cache-tag-${gl.kind}">${esc(gl.kind)}</span></td>` +
      `<td>${fmtNum(c.gets)}</td><td>${fmtNum(c.hits)}</td><td>${fmtNum(c.misses)}</td>` +
      `<td><span class="dot ${rateCls(r)}"></span>${fmtPct(r)}</td>` +
      `<td>${fmtNum(c.reReads)}</td><td>${fmtNum(c.evictions)}</td>` +
      `<td>${o.size}</td><td>${fmtBytes(o.bytes)}</td><td>${capCell}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';

  // ③ 按 policy 表
  html += `<h3 class="cache-h">${t('cache.section.byPolicy')}</h3>`;
  html += '<table><thead><tr>' +
    `<th>${t('cache.th.policy')}</th><th>${t('cache.th.reads')}</th><th>${t('cache.th.hits')}</th><th>${t('cache.th.misses')}</th><th>${t('cache.th.hitRate')}</th><th>${t('cache.th.statChecks')}</th><th>${t('cache.th.reReads')}</th>` +
    '</tr></thead><tbody>';
  const POLICY_DESC = {
    'on-reload': t('cache.policy.onReload'),
    'manual': t('cache.policy.manual'),
    'mtime': t('cache.policy.mtime')
  };
  for (const pol of ['on-reload', 'mtime', 'manual']) {
    const c = s.byPolicy[pol];
    if (!c || !c.gets) continue;
    const r = hitRate(c);
    html += '<tr>' +
      `<td>${esc(pol)} <span style="color:var(--dim)">${esc(POLICY_DESC[pol] || '')}</span></td>` +
      `<td>${fmtNum(c.gets)}</td><td>${fmtNum(c.hits)}</td><td>${fmtNum(c.misses)}</td>` +
      `<td><span class="dot ${rateCls(r)}"></span>${fmtPct(r)}</td>` +
      `<td>${fmtNum(c.statChecks)}</td><td>${fmtNum(c.reReads)}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';

  html += `<div class="cache-note">${t('cache.note')}</div>`;

  el.innerHTML = html;
}

function card(label, value, valCls, sub) {
  return `<div class="cache-card">` +
    `<div class="cc-label">${esc(label)}</div>` +
    `<div class="cc-value ${valCls || ''}">${esc(value)}</div>` +
    `<div class="cc-sub">${esc(sub || '')}</div>` +
    `</div>`;
}

// ── Messages 视图 ──
function renderMsg(data) {
  if (!data) return;
  const aids = data.scopes || data.aids || [];
  const peers = data.peers || [];
  const messages = data.messages || [];
  if (data.scope && data.scope !== msgSel.aid) msgSel.aid = data.scope;

  // 左：AID 列表
  let aidsHtml = `<div class="col-title">${t('messages.colTitle.aid')}</div>`;
  for (const a of aids) {
    const sel = a.aid === msgSel.aid ? ' sel' : '';
    const name = a.selfAID && a.selfAID !== 'unknown' ? shortAid(a.selfAID) : 'unknown';
    const privateCount = Math.max(0, (a.peerCount || 0) - (a.groupCount || 0));
    const privateBit = tf('messages.privateCount', { count: privateCount });
    const groupBit = a.groupCount ? ` · ${tf('messages.groupCount', { count: a.groupCount })}` : '';
    aidsHtml += `<div class="list-item${sel}" data-aid="${esc(a.aid)}">` +
      `<div class="name">${esc(name)}</div>` +
      `<div class="sub">↓${a.totalIn} ↑${a.totalOut} · ${privateBit}${groupBit} · ${fmtAgo(a.lastAt)}</div></div>`;
  }
  $('#msg-aids').innerHTML = aidsHtml;
  $('#msg-aids').querySelectorAll('.list-item').forEach(item => {
    item.onclick = () => { msgSel = { aid: item.dataset.aid, peer: null }; subscribe('msg', msgSel); };
  });

  // 中：对端列表
  let peersHtml = `<div class="col-title">${t('messages.colTitle.peers')}</div>`;
  if (msgSel.aid) {
    const allSel = msgSel.peer === null ? ' sel' : '';
    peersHtml += `<div class="list-item${allSel}" data-peer=""><div class="name">${t('messages.colTitle.all')}</div>` +
      `<div class="sub">${peers.length} chats · ${t('messages.all.aggregate')}</div></div>`;
    for (const p of peers) {
      const sel = p.peerId === msgSel.peer ? ' sel' : '';
      const isGroup = p.chatType === 'group';
      const displayName = p.chatType === 'group'
        ? (p.groupName || p.peerName || p.groupId || p.peerId)
        : (p.peerName || p.peerId);
      const channelLabel = p.channelName && p.channelName !== 'main' ? `${p.channelType}/${p.channelName}` : (p.channelType || '');
      const groupMark = isGroup ? `<span class="msg-group-mark">${esc(t('messages.tag.groupShort'))}</span>` : '';
      const channelTag = channelLabel ? `<span class="msg-tag">${esc(channelLabel)}</span>` : '';
      peersHtml += `<div class="list-item${sel}" data-peer="${esc(p.peerId)}">` +
        `<div class="name">${groupMark}<span class="msg-peer-title">${esc(shortId(displayName))}</span>${channelTag}</div>` +
        `<div class="sub">↓${p.inbound} ↑${p.outbound} · ${fmtAgo(p.lastAt)}</div></div>`;
    }
  } else {
    peersHtml += `<div class="empty">${t('messages.empty.selectAid')}</div>`;
  }
  $('#msg-peers').innerHTML = peersHtml;
  $('#msg-peers').querySelectorAll('.list-item').forEach(item => {
    item.onclick = () => { msgSel = { aid: msgSel.aid, peer: item.dataset.peer || null }; subscribe('msg', msgSel); };
  });

  // 右：消息流
  const stream = $('#msg-stream');
  if (!msgSel.aid) { stream.innerHTML = `<div class="empty">${t('messages.empty.selectToView')}</div>`; return; }
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 60;
  let msgHtml = '';
  for (const m of messages) {
    const cls = m.dir === 'in' ? 'in' : 'out';
    const arrow = m.dir === 'in' ? '↓' : '↑';
    const from = shortId(m.from), to = shortId(m.to);
    const tags = [];
    if (m.channelType) tags.push(m.channelType);
    if (m.chatType === 'group') tags.push(t('messages.tag.group'));
    // 消息详情流的 kind 来自 jsonl 的 msgType（text/thought/image/file/command），
    // 与 agents 页内存态的 MsgKind（send/thought/inject/notify）不是同一套词汇。
    const mt = MSG_TYPE_META[m.msgType];
    if (mt) tags.push(`${mt.icon}${mt.label()}`);
    if (m.encrypt != null) tags.push(m.encrypt ? t('messages.tag.encrypted') : t('messages.tag.plain'));
    if (m.chatmode) tags.push(m.chatmode === 'proactive' ? t('messages.tag.proactive') : (m.chatmode === 'inject' ? t('messages.tag.inject') : t('messages.tag.responsive')));
    const tagHtml = tags.map(tag => `<span class="msg-tag">${esc(tag)}</span>`).join('');
    msgHtml += `<div class="bubble ${cls}">` +
      `<div class="meta">${fmtTime(m.ts)} ${arrow} ${esc(from)}→${esc(to)}${tagHtml}</div>` +
      `<div class="body">${esc(m.content)}</div></div>`;
  }
  stream.innerHTML = msgHtml || `<div class="empty">${t('messages.empty.noMessages')}</div>`;
  if (atBottom) stream.scrollTop = stream.scrollHeight;
}

// ── Sessions 视图 ──
function renderSession(data) {
  if (!data) return;
  const projects = data.projects || [];
  const transcripts = data.transcripts || [];
  const turns = data.turns || [];
  // 项目选择：用户显式选过就以本地状态为准（避免 stale snapshot 把下拉拨回去）；
  // 否则跟随服务端解析出的默认项目。
  if (!sessSel.project) sessSel.project = data.project || null;
  // 若本次 snapshot 不是当前选中项目的数据（stale），忽略其列表，等正确的回来
  if (sessSel.project && data.project && data.project !== sessSel.project) {
    return;
  }

  // 有效筛选
  const filtered = transcripts
    .filter(t => !sessFilterNormal || (t.userMsgs || 0) >= 1);

  // 左栏：过滤条 + 列表
  const projOpts = projects.map(p =>
    `<option value="${esc(p.encoded)}"${p.encoded === sessSel.project ? ' selected' : ''}>${esc(p.label)} (${p.count})</option>`
  ).join('');

  // baseagent 下拉选择器（只显示可用的）
  let baseagentOpts = '';
  if (availableBaseagents.claude) {
    baseagentOpts += `<option value="claude"${sessSel.baseagent === 'claude' ? ' selected' : ''}>Claude</option>`;
  }
  if (availableBaseagents.codex) {
    baseagentOpts += `<option value="codex"${sessSel.baseagent === 'codex' ? ' selected' : ''}>Codex</option>`;
  }

  const normalCount = transcripts.filter(t => (t.userMsgs || 0) >= 1).length;
  let listHtml = '<div class="sess-filter">' +
    '<div class="sess-select-row">' +
      `<select id="sess-baseagent" title="Base Agent">${baseagentOpts}</select>` +
      `<select id="sess-project" title="${t('sessions.header.project')}">${projOpts}</select>` +
    '</div>' +
    '<div class="sess-filter-row">' +
      `<div class="sess-count">${tf('sessions.count', { filtered: filtered.length, total: transcripts.length })}</div>` +
      `<label class="sess-switch" title="${t('sessions.filter.validTitle')}">` +
        `<span>${t('sessions.filter.valid')}</span>` +
        `<input id="sess-filter-toggle" type="checkbox"${sessFilterNormal ? ' checked' : ''}>` +
        '<span class="sess-switch-track" aria-hidden="true"><span class="sess-switch-thumb"></span></span>' +
      '</label>' +
    '</div></div>' +
    '<div class="sess-items">';

  if (!filtered.length) {
    listHtml += '<div class="empty">' + (transcripts.length ? t('sessions.empty.noMatch') : t('sessions.empty.noSessions')) + '</div>';
  }
  for (const t of filtered) {
    const sel = t.id === sessSel.sessionId ? ' sel' : '';
    const title = t.title || t.firstUser || t.id.slice(0, 8);
    let badge = '';
    if (t.bound) {
      const dot = t.online ? '<span class="dot on"></span>' : '<span class="dot idle"></span>';
      badge = `<span class="bind-badge">${dot}${esc(t.boundChannel || '')}·${esc(shortAid(t.boundPeer || ''))}</span>`;
    }
    const msgs = `<span class="msg-count" title="${tf('sessions.messageCountTitle', { user: t.userMsgs || 0, total: t.totalMsgs || 0 })}">💬 ${t.userMsgs || 0}/${t.totalMsgs || 0}</span>`;
    listHtml += `<div class="list-item${sel}" data-sid="${esc(t.id)}">` +
      `<div class="name">${esc(title)}</div>` +
      `<div class="sub">${fmtAgo(t.lastActivity)} · ${msgs}${t.gitBranch ? ' · ' + esc(t.gitBranch) : ''}${badge}</div>` +
      '</div>';
  }
  listHtml += '</div>';
  $('#sess-list').innerHTML = listHtml;

  // 绑定交互
  const baseagentSel = $('#sess-baseagent');
  if (baseagentSel) baseagentSel.onchange = () => {
    console.log('[ecweb] Baseagent changed to:', baseagentSel.value);
    sessSel = { sessionId: null, project: null, baseagent: baseagentSel.value };
    console.log('[ecweb] Subscribing to session with baseagent:', sessSel.baseagent);
    subscribe('session', { baseagent: sessSel.baseagent });
  };
  const projSel = $('#sess-project');
  if (projSel) projSel.onchange = () => {
    sessSel = { sessionId: null, project: projSel.value, baseagent: sessSel.baseagent };
    subscribe('session', { project: sessSel.project, baseagent: sessSel.baseagent });
  };
  const filterToggle = $('#sess-filter-toggle');
  if (filterToggle) filterToggle.onchange = () => { sessFilterNormal = filterToggle.checked; renderSession(state.session); };
  $('#sess-list').querySelectorAll('.list-item').forEach(item => {
    item.onclick = () => { sessSel = { sessionId: item.dataset.sid, project: sessSel.project, baseagent: sessSel.baseagent }; subscribe('session', sessSel); };
  });

  // 右：transcript 详情
  const detail = $('#sess-detail');
  if (!sessSel.sessionId) { detail.innerHTML = `<div class="empty">${t('sessions.selectLog')}</div>`; return; }
  if (!turns.length) { detail.innerHTML = `<div class="empty">${t('sessions.empty.noContent')}</div>`; return; }
  const h = data.header || {};
  const atBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 60;
  let html = renderSessHeader(h);
  // 视图切换工具条
  html += '<div class="sess-toolbar">' +
    `<button class="view-toggle${sessChatMode ? ' active' : ''}" id="chat-toggle">` +
    `${sessChatMode ? t('sessions.chatView') : t('sessions.fullView')}</button>` +
    `<span class="toolbar-hint">${sessChatMode ? t('sessions.chatHint') : t('sessions.fullHint')}</span>` +
    '</div>';
  html += '<div class="turn-list">' + (sessChatMode ? renderChatView(turns) : renderFullView(turns)) + '</div>';
  detail.innerHTML = html;

  const toggle = $('#chat-toggle');
  if (toggle) toggle.onclick = () => { sessChatMode = !sessChatMode; renderSession(state.session); };
  if (atBottom) detail.scrollTop = detail.scrollHeight;
}

// 完整视图：所有轮次按 4 类渲染
function renderFullView(turns) {
  let html = '';
  for (const t of turns) {
    const cat = t.category || t.role;
    const c = CAT_META[cat] || CAT_META.system;
    const usage = (t.inputTokens || t.outputTokens)
      ? `<span class="turn-usage">${esc(t.model || '')} · in ${t.inputTokens || 0} / out ${t.outputTokens || 0}</span>` : '';
    html += `<div class="turn cat-${cat}">` +
      `<div class="turn-head"><span class="turn-role">${c.icon} ${c.label()}</span>` +
      `<span class="turn-time">${t.ts ? fmtTime(t.ts) : ''}</span>${usage}</div>` +
      `<div class="turn-blocks">${renderBlocks(t.blocks || [])}</div></div>`;
  }
  return html;
}

// 对话视图：仿微信。只显示用户输入(左) + ec msg send 发出的消息(右)，
// 其余连续的处理过程折叠成一个可展开的「处理过程」分隔条。
function renderChatView(turns) {
  // 先把 turns 摊平成「对话项」与「处理项」的线性序列
  const items = [];  // {type:'in'|'out'|'proc', ...}
  for (const t of turns) {
    if (t.category === 'user_input') {
      const text = (t.blocks || []).filter(b => b.kind === 'text').map(b => b.text).join('\n');
      items.push({ type: 'in', text, ts: t.ts });
      continue;
    }
    // 找该轮里的 ec msg send 发送块（可能多条）
    const sends = (t.blocks || []).filter(b => b.kind === 'tool_use' && b.chat);
    if (sends.length) {
      for (const s of sends) items.push({ type: 'out', text: s.chat.text, peer: s.chat.peer, self: s.chat.self, ts: t.ts });
    }
    // 该轮里非对话的内容 → 处理过程（含思考/其他工具/结果/模型纯文本）
    const procBlocks = (t.blocks || []).filter(b => !(b.kind === 'tool_use' && b.chat));
    if (procBlocks.length && !(t.category === 'user_input')) {
      items.push({ type: 'proc', cat: t.category, blocks: procBlocks, ts: t.ts });
    }
  }

  // 合并连续的 proc 项为一组，渲染成可折叠分隔条
  let html = '';
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.type === 'in') {
      html += `<div class="chat-row in"><div class="chat-bubble">${esc(it.text)}</div>` +
        `<div class="chat-time">${it.ts ? fmtTime(it.ts) : ''}</div></div>`;
      i++;
    } else if (it.type === 'out') {
      const peer = it.peer ? shortAid(it.peer) : '';
      html += `<div class="chat-row out"><div class="chat-bubble">${esc(it.text)}</div>` +
        `<div class="chat-time">${it.ts ? fmtTime(it.ts) : ''}${peer ? ' → ' + esc(peer) : ''}</div></div>`;
      i++;
    } else {
      // 收集连续 proc
      const group = [];
      while (i < items.length && items[i].type === 'proc') { group.push(items[i]); i++; }
      let inner = '';
      for (const g of group) {
        const c = CAT_META[g.cat] || CAT_META.system;
        inner += `<div class="turn cat-${g.cat}"><div class="turn-head"><span class="turn-role">${c.icon} ${c.label()}</span>` +
          `<span class="turn-time">${g.ts ? fmtTime(g.ts) : ''}</span></div>` +
          `<div class="turn-blocks">${renderBlocks(g.blocks)}</div></div>`;
      }
      html += `<details class="proc-group"><summary>${tf('sessions.procSummary', { count: group.length })}</summary><div class="proc-body">${inner}</div></details>`;
    }
  }
  if (!html) html = `<div class="empty">${t('sessions.empty.noDialogue')}</div>`;
  return html;
}

// 类别展示元数据
const CAT_META = {
  user_input:   { label: () => t('sessions.turnType.userInput'), icon: '🟢' },
  model_output: { label: () => t('sessions.turnType.modelOutput'), icon: '🔵' },
  tool_call:    { label: () => t('sessions.turnType.toolCall'), icon: '🟣' },
  tool_result:  { label: () => t('sessions.turnType.toolResult'), icon: '🟠' },
  msg_send:     { label: () => t('sessions.turnType.msgSend'), icon: '📤' },
  system:       { label: () => t('sessions.turnType.system'), icon: '⚪' },
};

function renderSessHeader(h) {
  if (!h || !h.sessionId) return '';
  const title = h.title || h.sessionId;
  const tok = (h.inputTokens || h.outputTokens)
    ? `<span class="sh-stat">🔢 in ${fmtNum(h.inputTokens)} / out ${fmtNum(h.outputTokens)}</span>` : '';
  const ctx = h.contextTokens
    ? `<span class="sh-stat" title="${t('sessions.contextTitle')}">📐 ${fmtNum(h.contextTokens)} ctx</span>` : '';
  const cost = h.costUsd != null && h.costUsd > 0
    ? `<span class="sh-stat" title="${t('sessions.costTitle')}">💰 $${h.costUsd < 0.01 ? h.costUsd.toFixed(4) : h.costUsd.toFixed(2)}</span>` : '';
  let bind = '';
  if (h.bound) {
    const dot = h.online ? `<span class="dot on"></span>${t('common.online')}` : `<span class="dot idle"></span>${t('common.offline')}`;
    bind = `<span class="sh-stat">🔗 ${esc(h.boundChannel || '')} · ${esc(shortAid(h.boundPeer || ''))} ${dot}</span>`;
  }
  return '<div class="sess-header">' +
    `<div class="sh-title">${esc(title)}</div>` +
    '<div class="sh-stats">' +
    `<span class="sh-stat" title="${tf('sessions.messageCountTitle', { user: h.userMsgs || 0, total: h.totalMsgs || 0 })}">💬 ${h.userMsgs || 0}/${h.totalMsgs || 0} ${t('sessions.msgUnit')}</span>` +
    (h.model ? `<span class="sh-stat">🤖 ${esc(h.model)}</span>` : '') +
    tok + ctx + cost +
    (h.gitBranch ? `<span class="sh-stat">🌿 ${esc(h.gitBranch)}</span>` : '') +
    (h.version ? `<span class="sh-stat">cc ${esc(h.version)}</span>` : '') +
    bind +
    '</div>' +
    renderCatBar(h.counts) +
    '</div>';
}

function renderCatBar(counts) {
  if (!counts) return '';
  const items = [
    ['user_input', counts.userInput],
    ['model_output', counts.modelOutput],
    ['tool_call', counts.toolCall],
    ['tool_result', counts.toolResult],
    ['msg_send', counts.msgSend],
  ];
  let s = '<div class="sh-cats">';
  for (const [cat, n] of items) {
    const m = CAT_META[cat];
    s += `<span class="cat-chip cat-${cat}"><span class="cat-swatch"></span>${m.label()} ${n || 0}</span>`;
  }
  return s + '</div>';
}

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const TOOL_ICONS = {
  Read: '📄', Write: '✏️', Edit: '✏️', MultiEdit: '✏️', NotebookEdit: '✏️',
  Bash: '⌘', Glob: '🔍', Grep: '🔍', Task: '🤖', WebFetch: '🌐', WebSearch: '🌐',
};

function renderBlocks(blocks) {
  let out = '';
  for (const b of blocks) {
    if (b.kind === 'text') {
      out += `<div class="blk blk-text">${esc(b.text)}</div>`;
    } else if (b.kind === 'thinking') {
      out += `<details class="blk blk-thinking"><summary>💭 ${t('sessions.block.thinking')}</summary><div class="blk-thinking-body">${esc(b.text)}</div></details>`;
    } else if (b.kind === 'tool_use') {
      const icon = TOOL_ICONS[b.tool] || '🔧';
      let params = '';
      for (const p of (b.params || [])) {
        params += `<div class="tool-param"><span class="pk">${esc(p.k)}</span><code class="pv">${esc(p.v)}</code></div>`;
      }
      out += `<div class="blk blk-tool"><div class="tool-head">${icon} <span class="tool-name">${esc(b.tool)}</span></div>${params}</div>`;
    } else if (b.kind === 'tool_result') {
      const cls = b.isError ? 'blk-result err' : 'blk-result';
      out += `<details class="blk ${cls}"><summary>${b.isError ? '✗ ' + t('sessions.block.resultError') : '↳ ' + t('sessions.block.result')}</summary><pre class="result-body">${esc(b.text)}</pre></details>`;
    }
  }
  return out;
}

// ── 通用 Menu 协议辅助（mResp / toast，供 Agents / System / Triggers 复用）──

// 提取 menu.response 的 data/error
function mResp(r) {
  if (!r) return { error: { code: 'INTERNAL', message: 'no response' } };
  if (r.error) return { error: r.error };
  return { data: r.data };
}

function toast(text, isErr) {
  let el = $('#ctrl-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ctrl-toast';
    el.className = 'ctrl-toast';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.className = 'ctrl-toast show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'ctrl-toast'; }, 2600);
}

// ── Agents 操作 ──

// 设置某 aid 的操作状态并立即刷新对应行的按钮区（不重渲整表）
function setAgentOp(aid, label) {
  if (label == null) _agentOps.delete(aid); else _agentOps.set(aid, label);
  const cell = document.querySelector(`.agent-ops[data-aid="${CSS.escape(aid)}"], .agent-ops-busy[data-aid="${CSS.escape(aid)}"]`)?.closest('td');
  if (!cell || !state.agents) return;
  const ag = (state.agents.agents || []).find(x => x.aid === aid);
  if (!ag) return;
  if (ag.status === 'disabled') {
    // 禁用页：启用 + 只保留配置/agent.md/删除操作
    cell.innerHTML = _agentOps.has(aid)
      ? agentOpsBusyHtml(aid, _agentOps.get(aid))
      : agentDisabledOpsHtml(aid);
  } else {
    const statsByAid = {};
    for (const s of (state.agents.stats || [])) statsByAid[s.aid] = s;
    cell.innerHTML = agentOpsHtml(aid, ag, statsByAid[aid] || {});
  }
  bindOpsCell(cell, aid, ag.status);
}

function bindOpsCell(cell, aid, status) {
  cell.querySelectorAll('button[data-op]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const op = btn.dataset.op;
      if (op === 'more') {
        const more = btn.closest('.ops-more');
        const wasOpen = more.classList.contains('open');
        document.querySelectorAll('.ops-more.open').forEach(m => m.classList.remove('open'));
        if (!wasOpen) more.classList.add('open');
        e.stopPropagation();
        return;
      }
      if (op === 'edit') agentOpEdit(aid);
      else if (op === 'reload') agentOpReload(aid);
      else if (op === 'toggle') agentOpToggle(aid, status);
      else if (op === 'delete') agentOpDelete(aid);
      else if (op === 'clear-queue') agentOpClearQueue(aid);
      else if (op === 'stop') agentOpStop(aid);
      else if (op === 'start') agentOpStart(aid);
      else if (op === 'mute') agentOpMute(aid);
      else if (op === 'unmute') agentOpUnmute(aid);
    });
  });
}

// click-outside 关闭下拉：全局只绑一次（避免每次重渲染叠加监听器）
let _opsOutsideBound = false;
function ensureOpsOutsideClose() {
  if (_opsOutsideBound) return;
  _opsOutsideBound = true;
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.ops-more')) return; // 点在菜单内不关
    document.querySelectorAll('.ops-more.open').forEach(m => m.classList.remove('open'));
  });
}

function bindAgentsEvents(el) {
  el.querySelector('#agent-new-btn')?.addEventListener('click', agentOpNew);
  ensureOpsOutsideClose();
  // 子标签切换：仅切视图变量并重渲，不重新订阅
  el.querySelectorAll('.ag-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.subtab;
      if (tab && tab !== _agSubtab) { _agSubtab = tab; renderAgents(state.agents); }
    });
  });
  el.querySelectorAll('.agent-ops').forEach(div => {
    const aid = div.dataset.aid;
    const status = div.dataset.status;
    bindOpsCell(div.closest('td'), aid, status);
  });
}

// 异步操作包装：设置 "操作中" 状态、执行、清除
async function withAgentOp(aid, label, fn) {
  setAgentOp(aid, label);
  try { await fn(); }
  finally { setAgentOp(aid, null); }
}

async function agentOpReload(aid, force = false) {
  await withAgentOp(aid, t('agents.op.reloading'), async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'reload', args: { aid, force } }));
    if (r.error?.code === 'BUSY') {
      if (confirm(r.error.message + '\n' + t('agents.op.confirmReload'))) { setAgentOp(aid, null); return agentOpReload(aid, true); }
      return;
    }
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(t('agents.op.reloaded'));
    subscribe('agents', {});
  });
}

async function agentOpToggle(aid, status) {
  const action = status === 'disabled' ? 'enable' : 'disable';
  const label = action === 'disable' ? t('agents.op.disabling') : t('agents.op.enabling');
  await withAgentOp(aid, label, async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action, args: { aid } }));
    if (r.error?.code === 'BUSY') {
      if (confirm(r.error.message + '\n' + tf('agents.op.confirmToggleAction', { action: action === 'disable' ? t('action.disable') : t('action.enable') }))) {
        const r2 = mResp(await menuSend({ type: 'menu.action', name: 'agent', action, args: { aid, force: true } }));
        if (r2.error) toast(r2.error.message || r2.error.code, true);
        else {
          toast(action === 'disable' ? t('agents.op.disabled') : t('agents.op.enabled'));
          // 禁用后立即切到禁用页；启用后等数据刷新（agent 需先完成启动才移到启用页）
          if (action === 'disable') _agSubtab = 'disabled';
          subscribe('agents', {});
        }
      }
      return;
    }
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(action === 'disable' ? t('agents.op.disabled') : t('agents.op.enabled'));
    if (action === 'disable') _agSubtab = 'disabled';
    subscribe('agents', {});
  });
}

async function agentOpDelete(aid) {
  if (!confirm(t('agents.op.confirmDelete').replace('{aid}', aid))) return;
  const purge = confirm(t('agents.op.confirmPurge'));
  await withAgentOp(aid, t('agents.op.deleting'), async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'delete', args: { aid, purge } }));
    if (r.error?.code === 'BUSY') {
      if (confirm(r.error.message + '\n' + t('agents.op.confirmForceDelete'))) {
        const r2 = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'delete', args: { aid, purge, force: true } }));
        if (r2.error) toast(r2.error.message || r2.error.code, true);
        else { toast(t('agents.op.deleted')); subscribe('agents', {}); }
      }
      return;
    }
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(t('agents.op.deleted'));
    subscribe('agents', {});
  });
}

async function agentOpClearQueue(aid) {
  if (!confirm(t('agents.op.confirmClearQueue').replace('{aid}', aid))) return;
  await withAgentOp(aid, t('common.operating'), async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'queue-clear', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(`✓ ${r.data?.cleared ?? 0} messages cleared`);
    subscribe('agents', {});
  });
}

async function agentOpStop(aid) {
  await withAgentOp(aid, t('agents.op.stopping'), async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'stop', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(t('agents.op.stopped'));
    subscribe('agents', {});
  });
}

async function agentOpStart(aid) {
  await withAgentOp(aid, t('agents.op.starting'), async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'start', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(t('agents.op.started'));
    subscribe('agents', {});
  });
}

async function agentOpMute(aid) {
  await withAgentOp(aid, t('agents.op.muting'), async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'mute', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(t('agents.op.muted'));
    subscribe('agents', {});
  });
}

async function agentOpUnmute(aid) {
  await withAgentOp(aid, t('agents.op.unmuting'), async () => {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'unmute', args: { aid } }));
    if (r.error) { toast(r.error.message || r.error.code, true); return; }
    toast(t('agents.op.unmuted'));
    subscribe('agents', {});
  });
}

function agentOpNew() {
  document.querySelectorAll('.ops-more.open').forEach(m => m.classList.remove('open'));
  openAgentCreateDrawer();
}

const AGENT_BASEAGENT_TYPES = ['claude', 'codex', 'gemini'];
const AGENT_EFFORT_FALLBACK = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high'],
  gemini: [],
};
const AGENT_AID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?){2,}$/;
let _agentEdit = null;
let _agentCreate = null;

function cloneJson(value) {
  try { return JSON.parse(JSON.stringify(value || {})); }
  catch { return {}; }
}

function agentSafeConfig(data) {
  return (data && typeof data.safeConfig === 'object' && data.safeConfig) ? data.safeConfig : {};
}

function agentActiveBaseagent(data) {
  const safe = agentSafeConfig(data);
  return String(safe.active_baseagent || data?.config?.active_baseagent || data?.config?.baseagent || 'claude');
}

function agentBaseagentBlock(data, type) {
  const safe = agentSafeConfig(data);
  const blocks = (safe.baseagents && typeof safe.baseagents === 'object') ? safe.baseagents : (data?.config?.baseagents || {});
  const block = (blocks && typeof blocks === 'object' && blocks[type] && typeof blocks[type] === 'object') ? blocks[type] : {};
  const fallback = {};
  if (type === agentActiveBaseagent(data)) {
    if (data?.config?.model != null) fallback.model = data.config.model;
    if (data?.config?.effort != null) fallback.effort = data.config.effort;
  }
  return { ...fallback, ...block };
}

function agentOriginalEditState(aid, data) {
  const safe = agentSafeConfig(data);
  const active = agentActiveBaseagent(data);
  const block = agentBaseagentBlock(data, active);
  const owners = Array.isArray(safe.owners)
    ? safe.owners
    : (Array.isArray(data?.config?.owners) ? data.config.owners : []);
  const projectPath = String(safe.projects?.defaultPath || data?.config?.projects?.defaultPath || data?.paths?.project || '');
  return {
    name: String(data?.identity?.name || data?.displayName || shortAid(aid)),
    owners: owners.map(String),
    projectPath,
    activeBaseagent: active,
    model: block.model == null ? '' : String(block.model),
    effort: block.effort == null ? '' : String(block.effort),
  };
}

function agentOwnersFromText(text) {
  return String(text || '')
    .split(/[\s,，]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

function agentBaseagentOptionValues(items) {
  const seen = new Set();
  const values = [];
  for (const item of items || []) {
    const value = agentOptionValue(item).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function agentBaseagentOptions(active, options = AGENT_BASEAGENT_TYPES) {
  const seen = new Set();
  const list = [];
  const push = value => {
    const type = String(value || '').trim();
    if (!type || seen.has(type)) return;
    seen.add(type);
    list.push(type);
  };
  (options || []).forEach(push);
  const activeWasProvided = seen.has(String(active || '').trim());
  if (active) push(active);
  if (!list.length) AGENT_BASEAGENT_TYPES.forEach(push);
  return list.map(type => {
    const label = !activeWasProvided && type === active ? `${type} (${t('common.currentSuffix')})` : type;
    return `<option value="${esc(type)}"${type === active ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

function agentListValues(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[\s,，]+/);
  return [];
}

function agentChannelOwners(item) {
  if (!item || typeof item !== 'object') return [];
  const owners = [];
  owners.push(...agentListValues(item.owners));
  owners.push(...agentListValues(item.admins));
  owners.push(...agentListValues(item.ownerIds));
  owners.push(...agentListValues(item.ownerAids));
  if (item.owner) owners.push(item.owner);
  if (item.ownerId) owners.push(item.ownerId);
  if (item.ownerAid) owners.push(item.ownerAid);
  return [...new Set(owners.map(String).map(s => s.trim()).filter(Boolean))];
}

function agentChannelStatus(item) {
  if (!item || typeof item !== 'object') return 'unknown';
  const raw = item.status ?? item.state ?? item.aidStatus;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (item.enabled === false || item.disabled === true) return 'disabled';
  if (item.connected === true || item.ready === true || item.enabled === true) return 'active';
  if (item.connected === false) return 'inactive';
  return 'unknown';
}

function agentChannelStatusLabel(status) {
  const s = String(status || 'unknown').toLowerCase();
  if (['active', 'enabled', 'running', 'connected', 'ready', 'ok'].includes(s)) return t('agents.channels.status.enabled');
  if (['disabled', 'stopped', 'off'].includes(s)) return t('agents.channels.status.disabled');
  if (['inactive', 'disconnected', 'error', 'failed', 'kicked'].includes(s)) return s;
  return t('agents.channels.status.unknown');
}

function agentChannelStatusClass(status) {
  const s = String(status || 'unknown').toLowerCase();
  if (['active', 'enabled', 'running', 'connected', 'ready', 'ok'].includes(s)) return 'active';
  if (['disabled', 'stopped', 'off'].includes(s)) return 'disabled';
  if (['inactive', 'disconnected', 'error', 'failed', 'kicked'].includes(s)) return 'inactive';
  return 'unknown';
}

function agentChannelRow(type, item, idx) {
  if (typeof item === 'string') {
    const parts = item.split(/[\/#]/);
    const itemType = parts[0] || type || 'channel';
    const itemName = parts.slice(1).join('/') || item;
    return {
      type: itemType,
      name: itemName,
      owners: [],
      status: 'unknown',
      runtimeName: item,
      key: item,
    };
  }
  if (item && typeof item === 'object') {
    return {
      type: String(item.type || item.channelType || type || 'channel'),
      name: String(item.name || item.instName || item.instanceName || item.channel || item.id || `${type || 'channel'}-${idx + 1}`),
      owners: agentChannelOwners(item),
      status: agentChannelStatus(item),
      key: String(item.name || item.instName || item.id || `${type || 'channel'}-${idx}`),
    };
  }
  return null;
}

function agentChannelsFromConfig(channels) {
  if (Array.isArray(channels)) {
    return channels.map((item, idx) => agentChannelRow('', item, idx)).filter(Boolean);
  }
  if (channels && typeof channels === 'object') {
    const rows = [];
    for (const [type, value] of Object.entries(channels)) {
      if (Array.isArray(value)) {
        value.forEach((item, idx) => {
          const row = agentChannelRow(type, item, idx);
          if (row) rows.push(row);
        });
      } else if (value && typeof value === 'object') {
        const row = agentChannelRow(type, value, 0);
        if (row) rows.push(row);
      } else if (value === true || value === false) {
        rows.push({ type, name: type, owners: [], status: value ? 'active' : 'disabled', key: type });
      }
    }
    return rows;
  }
  return [];
}

function agentRuntimeChannelRow(channel, idx) {
  const raw = String(channel || '');
  if (!raw) return null;
  const parts = raw.split(/[\/#]/);
  const type = parts[0] || 'channel';
  const rawName = parts[parts.length - 1] || raw;
  const name = parts.length >= 3 ? `${parts.slice(1, -1).join('/')}/${rawName}` : (parts.slice(1).join('/') || raw);
  return { type, name, rawName, owners: [], status: 'active', runtimeName: raw, key: raw || `${type}-${idx}` };
}

function agentChannelMatches(configRow, runtimeRow) {
  if (!configRow || !runtimeRow) return false;
  if (configRow.runtimeName && configRow.runtimeName === runtimeRow.runtimeName) return true;
  if (configRow.type !== runtimeRow.type) return false;
  return configRow.name === runtimeRow.name || configRow.name === runtimeRow.rawName || runtimeRow.name.endsWith(`/${configRow.name}`);
}

function agentMergeChannelRows(configRows, runtimeRows) {
  const rows = [];
  const usedConfig = new Set();
  for (const runtimeRow of runtimeRows) {
    const idx = configRows.findIndex((row, i) => !usedConfig.has(i) && agentChannelMatches(row, runtimeRow));
    if (idx >= 0) {
      usedConfig.add(idx);
      rows.push({
        ...runtimeRow,
        owners: configRows[idx].owners,
        status: configRows[idx].status === 'unknown' ? runtimeRow.status : configRows[idx].status,
      });
    } else {
      rows.push(runtimeRow);
    }
  }
  configRows.forEach((row, idx) => {
    if (!usedConfig.has(idx)) rows.push(row);
  });
  return rows;
}

function agentChannelsToRows(data) {
  const safe = agentSafeConfig(data);
  const configRows = agentChannelsFromConfig(safe.channels || data?.config?.channels || []);
  const runtimeChannels = [];
  if (Array.isArray(data?.channels)) runtimeChannels.push(...data.channels);
  if (Array.isArray(data?.config?.channels)) runtimeChannels.push(...data.config.channels);
  const runtimeRows = runtimeChannels
    .filter(item => typeof item === 'string')
    .map(agentRuntimeChannelRow)
    .filter(Boolean)
    .filter((row, idx, rows) => rows.findIndex(other => other.runtimeName === row.runtimeName) === idx);
  return agentMergeChannelRows(configRows, runtimeRows);
}

function agentChannelsHtml(data) {
  const safe = agentSafeConfig(data);
  const rows = agentChannelsToRows(data);
  const fallbackOwners = Array.isArray(safe.owners)
    ? safe.owners.map(String)
    : (Array.isArray(data?.config?.owners) ? data.config.owners.map(String) : []);
  if (!rows.length) return `<div class="ag-edit-empty">${t('agents.channels.noChannels')}</div>`;
  let html = '<div class="ag-edit-channel-list">';
  for (const row of rows) {
    const displayOwners = row.owners.length ? row.owners : (row.type === 'aun' ? fallbackOwners : []);
    const owners = displayOwners.length ? displayOwners.map(String).join(', ') : t('agents.channels.noOwners');
    const statusLabel = agentChannelStatusLabel(row.status);
    const statusClass = agentChannelStatusClass(row.status);
    html += `<div class="ag-edit-channel" title="${esc(row.type + '/' + row.name)}">` +
      `<span class="ag-edit-channel-type">${esc(row.type)}</span>` +
      `<span class="ag-edit-channel-owners" title="${esc(displayOwners.join(', '))}">${esc(owners)}</span>` +
      `<span class="ag-edit-channel-status ${esc(statusClass)}">${esc(statusLabel)}</span>` +
      `</div>`;
  }
  return html + '</div>';
}

function agentCapabilityConfigBlock(data, baseagent) {
  const safe = agentSafeConfig(data);
  const blocks = (safe.capabilities && typeof safe.capabilities === 'object')
    ? safe.capabilities
    : (data?.config?.capabilities || {});
  const block = blocks && typeof blocks === 'object' && blocks[baseagent] && typeof blocks[baseagent] === 'object'
    ? blocks[baseagent]
    : {};
  return block || {};
}

function agentCapabilityModeLabel(mode) {
  if (mode === 'all') return t('agents.cap.mode.all');
  if (mode === 'none') return t('agents.cap.mode.none');
  return t('agents.cap.mode.inherit');
}

function agentCapabilityTypeLabel(type) {
  if (type === 'skill') return 'Skills';
  if (type === 'mcp') return 'MCP';
  if (type === 'plugin') return 'Plugins';
  return type;
}

function agentCapabilityEnabledLabel(value) {
  if (value === true) return t('agents.cap.enabled');
  if (value === false) return t('agents.cap.disabled');
  return t('common.inherited');
}

function agentCapabilityEnabledClass(value) {
  if (value === true) return 'ok';
  if (value === false) return 'off';
  return 'inherit';
}

function agentCapabilityOverrideLabel(value) {
  if (value === 'enabled') return t('agents.cap.override.enabled');
  if (value === 'disabled') return t('agents.cap.override.disabled');
  return t('agents.cap.override.none');
}

function agentCapabilitySourceLabel(value) {
  const map = {
    project: 'project',
    user: 'user',
    plugin: 'plugin',
    marketplace: 'market',
    bundled: 'bundled',
    system: 'system',
    unknown: 'unknown',
  };
  return map[value] || value || 'unknown';
}

function agentCapabilityOverridesCount(data, baseagent, type) {
  const block = agentCapabilityConfigBlock(data, baseagent);
  const overrides = block?.[type]?.overrides;
  return overrides && typeof overrides === 'object' ? Object.keys(overrides).length : 0;
}

function agentCapabilityPlaceholderHtml(text = t('common.loading')) {
  return `<div class="ag-edit-cap-empty">${esc(text)}</div>`;
}

function agentCapabilityItemsHtml(items) {
  if (!Array.isArray(items) || !items.length) return agentCapabilityPlaceholderHtml(t('agents.cap.noItems'));
  let html = '<div class="ag-edit-cap-items-list">';
  for (const item of items) {
    const value = agentOptionValue(item);
    const label = agentOptionLabel(item) || value;
    const enabled = item?.enabled;
    const enabledClass = agentCapabilityEnabledClass(enabled);
    const meta = [
      agentCapabilitySourceLabel(item?.source),
      agentCapabilityOverrideLabel(item?.override),
      item?.runtimeEnabled === true ? t('agents.cap.runtime.enabled') : (item?.runtimeEnabled === false ? t('agents.cap.runtime.disabled') : ''),
      item?.status ? String(item.status) : '',
    ].filter(Boolean).join(' · ');
    html += `<div class="ag-edit-cap-item">` +
      `<div class="ag-edit-cap-item-main">` +
        `<span class="ag-edit-cap-item-name" title="${esc(value)}">${esc(label)}</span>` +
        `<span class="ag-edit-cap-item-state ${esc(enabledClass)}">${esc(agentCapabilityEnabledLabel(enabled))}</span>` +
      `</div>` +
      `<div class="ag-edit-cap-item-meta">${esc(meta || '—')}</div>` +
      `${item?.desc ? `<div class="ag-edit-cap-item-desc">${esc(item.desc)}</div>` : ''}` +
    `</div>`;
  }
  return html + '</div>';
}

function agentCapabilityHtml(data, capData, baseagent) {
  if (!capData || !capData.capabilities || typeof capData.capabilities !== 'object') {
    return agentCapabilityPlaceholderHtml(t('agents.cap.noInfo'));
  }
  const types = ['skill', 'mcp', 'plugin'];
  let html = '<div class="ag-edit-cap-list">';
  for (const type of types) {
    const state = capData.capabilities[type] || {};
    const canUpdate = state.canUpdate !== false;
    const overrideCount = agentCapabilityOverridesCount(data, baseagent, type);
    const reason = state.reason ? ` title="${esc(state.reason)}"` : '';
    html += `<details class="ag-edit-cap-details" data-cap-type="${esc(type)}"${reason}>` +
      `<summary class="ag-edit-cap-row">` +
        `<span class="ag-edit-cap-type">${esc(agentCapabilityTypeLabel(type))}</span>` +
        `<span class="ag-edit-cap-mode">${esc(agentCapabilityModeLabel(state.mode))}</span>` +
        `<span class="ag-edit-cap-overrides">${overrideCount ? esc(tf('agents.cap.overrides', { count: overrideCount })) : t('agents.cap.override.none')}</span>` +
        `<span class="ag-edit-cap-state ${canUpdate ? 'ok' : 'off'}">${canUpdate ? t('agents.cap.canUpdate') : t('agents.cap.notSupported')}</span>` +
      `</summary>` +
      `<div class="ag-edit-cap-items" data-cap-items="${esc(type)}">${agentCapabilityPlaceholderHtml(t('agents.cap.loadingItems'))}</div>` +
    `</details>`;
  }
  html += '</div>';
  return html;
}

function agentOptionValue(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  return String(item.value ?? item.id ?? item.name ?? item.label ?? '');
}

function agentOptionLabel(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  return String(item.label ?? item.name ?? item.value ?? item.id ?? '');
}

function agentSelectOptions(items, current, emptyLabel) {
  const selected = String(current || '');
  const seen = new Set();
  let html = `<option value=""${selected ? '' : ' selected'}>${esc(emptyLabel)}</option>`;
  for (const item of items || []) {
    const value = agentOptionValue(item).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = agentOptionLabel(item).trim() || value;
    const isSelected = value === selected;
    html += `<option value="${esc(value)}"${isSelected ? ' selected' : ''}>${esc(label)}</option>`;
  }
  if (selected && !seen.has(selected)) {
    html += `<option value="${esc(selected)}" selected>${esc(selected)} (${t('common.currentSuffix')})</option>`;
  }
  return html;
}

async function agentFetchOptions(name, aid, args) {
  const payload = { type: 'menu.options', name, args };
  if (aid) payload.agent = aid;
  const r = mResp(await menuSend(payload));
  if (r.error) throw new Error(r.error.message || r.error.code);
  return Array.isArray(r.data) ? r.data : [];
}

function setAgentSelectLoading(select, current, label) {
  if (!select) return;
  select.disabled = true;
  select.innerHTML = `<option value="${esc(current || '')}" selected>${esc(label)}</option>`;
}

function setAgentSelectError(select, current) {
  if (!select) return;
  select.innerHTML = agentSelectOptions([], current, t('common.default'));
}

function agentCreateDefaultBaseagent() {
  return AGENT_BASEAGENT_TYPES.find(type => availableBaseagents && availableBaseagents[type] === true) || 'claude';
}

function readAgentCreateValues(root) {
  const aid = (root.querySelector('#ag-create-aid')?.value || '').trim();
  return {
    aid,
    name: (root.querySelector('#ag-create-name')?.value || '').trim() || shortAid(aid),
    owner: (root.querySelector('#ag-create-owner')?.value || '').trim(),
    baseagent: root.querySelector('#ag-create-baseagent')?.value || agentCreateDefaultBaseagent(),
    project: (root.querySelector('#ag-create-project')?.value || '').trim(),
    model: root.querySelector('#ag-create-model')?.value || '',
    effort: root.querySelector('#ag-create-effort')?.value || '',
  };
}

function validateAgentCreateValues(values) {
  if (!values.aid) return t('agents.edit.validation.aidRequired');
  if (!AGENT_AID_RE.test(values.aid)) return t('agents.edit.validation.invalidAid');
  if (!values.name) return t('agents.edit.validation.nameRequired');
  if (!values.owner) return t('agents.edit.validation.ownerRequired');
  if (!AGENT_AID_RE.test(values.owner)) return t('agents.edit.validation.invalidOwner');
  if (!AGENT_BASEAGENT_TYPES.includes(values.baseagent)) return tf('agents.edit.validation.invalidBaseagent', { baseagent: values.baseagent });
  return '';
}

function setAgentCreateSaving(ctx, saving) {
  ctx.saving = saving;
  ctx.backdrop.querySelectorAll('button, input, select').forEach(el => { el.disabled = saving; });
  const submit = ctx.backdrop.querySelector('#ag-create-submit');
  if (submit) submit.textContent = saving ? t('common.creating') : t('common.create');
}

function closeAgentCreateDrawer() {
  const ctx = _agentCreate;
  if (!ctx) return;
  document.removeEventListener('keydown', ctx.onKeydown);
  try { ctx.backdrop.remove(); } catch {}
  _agentCreate = null;
}

async function syncAgentCreateOptionFields(ctx, values) {
  const modelSelect = ctx.backdrop.querySelector('#ag-create-model');
  const effortSelect = ctx.backdrop.querySelector('#ag-create-effort');
  const baseSelect = ctx.backdrop.querySelector('#ag-create-baseagent');
  const baseagent = values.baseagent || baseSelect?.value || agentCreateDefaultBaseagent();
  const currentModel = values.model || '';
  const currentEffort = values.effort || '';
  const token = (ctx.optionLoadToken || 0) + 1;
  ctx.optionLoadToken = token;

  setAgentSelectLoading(modelSelect, currentModel, currentModel ? `${currentModel} (${t('common.loadingSuffix')})` : t('common.loading'));
  setAgentSelectLoading(effortSelect, currentEffort, currentEffort ? `${currentEffort} (${t('common.loadingSuffix')})` : t('common.loading'));

  try {
    const models = await agentFetchOptions('model', '', { baseagent, model: currentModel });
    if (_agentCreate !== ctx || ctx.optionLoadToken !== token) return;
    modelSelect.innerHTML = agentSelectOptions(models, currentModel, t('common.defaultModel'));
  } catch (e) {
    if (_agentCreate === ctx && ctx.optionLoadToken === token) {
      setAgentSelectError(modelSelect, currentModel);
      toast(e.message || String(e), true);
    }
  } finally {
    if (_agentCreate === ctx && ctx.optionLoadToken === token) modelSelect.disabled = Boolean(ctx.saving);
  }

  const selectedModel = modelSelect?.value || currentModel;
  await syncAgentCreateEffortOptions(ctx, baseagent, selectedModel, currentEffort, token);
}

async function syncAgentCreateEffortOptions(ctx, baseagent, model, currentEffort, token) {
  const effortSelect = ctx.backdrop.querySelector('#ag-create-effort');
  if (!effortSelect) return;
  setAgentSelectLoading(effortSelect, currentEffort, currentEffort ? `${currentEffort} (${t('common.loadingSuffix')})` : t('common.loading'));
  try {
    let efforts = await agentFetchOptions('effort', '', { baseagent, model, effort: currentEffort || 'auto' });
    if (!efforts.length && AGENT_EFFORT_FALLBACK[baseagent]) efforts = AGENT_EFFORT_FALLBACK[baseagent];
    if (_agentCreate !== ctx || ctx.optionLoadToken !== token) return;
    effortSelect.innerHTML = agentSelectOptions(efforts, currentEffort, t('common.default'));
  } catch (e) {
    if (_agentCreate === ctx && ctx.optionLoadToken === token) {
      const fallback = AGENT_EFFORT_FALLBACK[baseagent] || [];
      effortSelect.innerHTML = agentSelectOptions(fallback, currentEffort, t('common.default'));
      toast(e.message || String(e), true);
    }
  } finally {
    if (_agentCreate === ctx && ctx.optionLoadToken === token) effortSelect.disabled = Boolean(ctx.saving);
  }
}

async function submitAgentCreateDrawer(ctx) {
  const values = readAgentCreateValues(ctx.backdrop);
  const error = validateAgentCreateValues(values);
  if (error) { toast(error, true); return; }

  const args = {
    aid: values.aid,
    name: values.name,
    owner: values.owner,
    baseagent: values.baseagent,
  };
  if (values.project) args.project = values.project;
  if (values.model) args.model = values.model;
  if (values.effort && values.effort !== 'auto') args.effort = values.effort;

  setAgentCreateSaving(ctx, true);
  try {
    const r = mResp(await menuSend({ type: 'menu.action', name: 'agent', action: 'create', args }));
    if (r.error) throw new Error(r.error.message || r.error.code);
    closeAgentCreateDrawer();
    _agSubtab = 'enabled';
    toast(t('agents.op.created'));
    subscribe('agents', {});
    setTimeout(() => subscribe('agents', {}), 3000);
  } catch (e) {
    toast(e.message || String(e), true);
    if (_agentCreate === ctx) setAgentCreateSaving(ctx, false);
  }
}

function openAgentCreateDrawer() {
  closeAgentConfigDrawer();
  closeAgentCreateDrawer();
  const baseagent = agentCreateDefaultBaseagent();
  const html = `<div class="ag-edit-backdrop" id="ag-create-backdrop">` +
    `<aside class="ag-edit-drawer" role="dialog" aria-modal="true" aria-labelledby="ag-create-title">` +
      `<header class="ag-edit-head">` +
        `<div class="ag-edit-title-wrap">` +
          `<div id="ag-create-title" class="ag-edit-title">${t('agents.edit.createTitle')}</div>` +
          `<div class="ag-edit-subtitle"><span>${t('agents.edit.createSubtitle')}</span></div>` +
        `</div>` +
        `<button class="ag-edit-close" id="ag-create-close" type="button" aria-label="${t('common.close')}">×</button>` +
      `</header>` +
      `<form id="ag-create-form" class="ag-create-form">` +
        `<div class="ag-edit-body">` +
          `<section class="ag-edit-section">` +
            `<h3>${t('agents.edit.section.basic')}</h3>` +
            `<div class="ag-edit-grid ag-create-grid">` +
              `<label class="ag-edit-field"><span>Agent AID</span><input id="ag-create-aid" type="text" autocomplete="off" spellcheck="false" placeholder="mybot.agentid.pub"></label>` +
              `<label class="ag-edit-field"><span>${t('agents.edit.field.displayName')}</span><input id="ag-create-name" type="text" autocomplete="off" placeholder="mybot"></label>` +
              `<label class="ag-edit-field"><span>${t('agents.edit.field.ownerAid')}</span><input id="ag-create-owner" type="text" autocomplete="off" spellcheck="false" placeholder="alice.agentid.pub"></label>` +
              `<label class="ag-edit-field ag-edit-field-wide"><span>${t('agents.edit.field.projectPath')}</span><input id="ag-create-project" type="text" autocomplete="off" spellcheck="false" placeholder="${t('agents.edit.placeholder.defaultProjectPath')}"></label>` +
            `</div>` +
          `</section>` +
          `<section class="ag-edit-section">` +
            `<h3>${t('agents.edit.section.runtime')}</h3>` +
            `<div class="ag-edit-grid ag-create-grid">` +
              `<label class="ag-edit-field"><span>Baseagent</span><select id="ag-create-baseagent">${agentBaseagentOptions(baseagent)}</select></label>` +
              `<label class="ag-edit-field"><span>${t('agents.th.model')}</span><select id="ag-create-model">${agentSelectOptions([], '', t('common.defaultModel'))}</select></label>` +
              `<label class="ag-edit-field"><span>Effort</span><select id="ag-create-effort">${agentSelectOptions([], '', t('common.default'))}</select></label>` +
            `</div>` +
          `</section>` +
        `</div>` +
      `</form>` +
      `<footer class="ag-edit-actions">` +
        `<button class="ctrl-btn" id="ag-create-cancel" type="button">${t('common.cancel')}</button>` +
        `<button class="ctrl-btn primary" id="ag-create-submit" type="submit" form="ag-create-form">${t('common.create')}</button>` +
      `</footer>` +
    `</aside>` +
  `</div>`;

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const backdrop = wrap.firstChild;
  document.body.appendChild(backdrop);

  const ctx = {
    backdrop,
    onKeydown: (e) => { if (e.key === 'Escape') closeAgentCreateDrawer(); },
  };
  _agentCreate = ctx;

  const aidInput = backdrop.querySelector('#ag-create-aid');
  const nameInput = backdrop.querySelector('#ag-create-name');
  let nameTouched = false;
  nameInput.addEventListener('input', () => { nameTouched = true; });
  aidInput.addEventListener('input', () => {
    if (!nameTouched) nameInput.value = shortAid(aidInput.value.trim());
  });

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAgentCreateDrawer(); });
  backdrop.querySelector('#ag-create-close').addEventListener('click', closeAgentCreateDrawer);
  backdrop.querySelector('#ag-create-cancel').addEventListener('click', closeAgentCreateDrawer);
  backdrop.querySelector('#ag-create-baseagent').addEventListener('change', () => {
    syncAgentCreateOptionFields(ctx, {
      baseagent: backdrop.querySelector('#ag-create-baseagent')?.value || agentCreateDefaultBaseagent(),
      model: '',
      effort: '',
    });
  });
  backdrop.querySelector('#ag-create-model').addEventListener('change', () => {
    const baseagent = backdrop.querySelector('#ag-create-baseagent')?.value || agentCreateDefaultBaseagent();
    const effort = backdrop.querySelector('#ag-create-effort')?.value || '';
    const token = (ctx.optionLoadToken || 0) + 1;
    ctx.optionLoadToken = token;
    syncAgentCreateEffortOptions(ctx, baseagent, backdrop.querySelector('#ag-create-model')?.value || '', effort, token);
  });
  backdrop.querySelector('#ag-create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAgentCreateDrawer(ctx);
  });
  document.addEventListener('keydown', ctx.onKeydown);
  syncAgentCreateOptionFields(ctx, { baseagent, model: '', effort: '' });
  setTimeout(() => aidInput?.focus(), 0);
}

function readAgentEditValues(root) {
  return {
    owners: agentOwnersFromText(root.querySelector('#ag-edit-owners')?.value || ''),
    activeBaseagent: root.querySelector('#ag-edit-active')?.value || 'claude',
    model: root.querySelector('#ag-edit-model')?.value.trim() || '',
    effort: root.querySelector('#ag-edit-effort')?.value.trim() || '',
  };
}

function collectAgentEditPatch(ctx) {
  const values = readAgentEditValues(ctx.backdrop);
  const configPatch = {};

  if (!sameStringArray(values.owners, ctx.original.owners)) configPatch.owners = values.owners;
  if (values.activeBaseagent !== ctx.original.activeBaseagent) {
    if (Array.isArray(ctx.availableBaseagents) && ctx.availableBaseagents.length && !ctx.availableBaseagents.includes(values.activeBaseagent)) {
      return { error: tf('agents.edit.error.baseagentReadonly', { baseagent: values.activeBaseagent }) };
    }
    configPatch.active_baseagent = values.activeBaseagent;
  }

  const originalBlock = agentBaseagentBlock(ctx.data, values.activeBaseagent);
  const originalModel = originalBlock.model == null ? '' : String(originalBlock.model);
  const originalEffort = originalBlock.effort == null ? '' : String(originalBlock.effort);
  const baseagentPatch = {};
  if (values.model !== originalModel) baseagentPatch.model = values.model || null;
  if (values.effort !== originalEffort) baseagentPatch.effort = values.effort || null;
  if (Object.keys(baseagentPatch).length > 0) configPatch.baseagents = { [values.activeBaseagent]: baseagentPatch };

  return {
    configPatch,
    changed: Object.keys(configPatch).length > 0,
  };
}

function setAgentEditSaving(ctx, saving) {
  ctx.saving = saving;
  ctx.backdrop.querySelectorAll('button, input, textarea, select').forEach(el => { el.disabled = saving; });
  const save = ctx.backdrop.querySelector('#ag-edit-save');
  const saveReload = ctx.backdrop.querySelector('#ag-edit-save-reload');
  if (save) save.textContent = saving ? t('common.saving') : t('common.save');
  if (saveReload) saveReload.textContent = saving ? t('common.saving') : t('common.saveAndReload');
}

function closeAgentConfigDrawer() {
  const ctx = _agentEdit;
  if (!ctx) return;
  document.removeEventListener('keydown', ctx.onKeydown);
  try { ctx.backdrop.remove(); } catch {}
  _agentEdit = null;
}

async function saveAgentConfigDrawer(ctx, reloadAfter) {
  const collected = collectAgentEditPatch(ctx);
  if (collected.error) { toast(collected.error, true); return; }
  if (!collected.changed) { toast(t('common.noChanges')); return; }

  setAgentEditSaving(ctx, true);
  let requiresReload = false;
  try {
    if (Object.keys(collected.configPatch).length > 0) {
      const r = mResp(await menuSend({
        type: 'menu.action',
        name: 'agent',
        action: 'update',
        args: { aid: ctx.aid, patch: collected.configPatch },
      }));
      if (r.error) throw new Error(r.error.message || r.error.code);
      requiresReload = Boolean(r.data?.requiresReload);
    }

    closeAgentConfigDrawer();
    if (reloadAfter && requiresReload) {
      await agentOpReload(ctx.aid);
    } else {
      toast(requiresReload ? t('agents.op.saved') : t('agents.op.savedNoReload'));
      subscribe('agents', {});
    }
  } catch (e) {
    toast(e.message || String(e), true);
    if (_agentEdit === ctx) setAgentEditSaving(ctx, false);
  }
}

function syncAgentBaseagentFields(ctx) {
  const active = ctx.backdrop.querySelector('#ag-edit-active')?.value || ctx.original.activeBaseagent;
  const block = agentBaseagentBlock(ctx.data, active);
  syncAgentOptionFields(ctx, {
    baseagent: active,
    model: block.model == null ? '' : String(block.model),
    effort: block.effort == null ? '' : String(block.effort),
  });
  syncAgentCapabilityInfo(ctx, active);
}

async function syncAgentBaseagentOptions(ctx) {
  const select = ctx.backdrop.querySelector('#ag-edit-active');
  if (!select) return;
  const current = select.value || ctx.original.activeBaseagent;
  select.disabled = true;
  try {
    const items = await agentFetchOptions('baseagent', ctx.aid, { aid: ctx.aid });
    if (_agentEdit !== ctx) return;
    const values = agentBaseagentOptionValues(items);
    ctx.availableBaseagents = values.length ? values : [current].filter(Boolean);
    const selected = ctx.availableBaseagents.includes(current) ? current : (ctx.availableBaseagents[0] || current);
    select.innerHTML = agentBaseagentOptions(selected, ctx.availableBaseagents);
    if (selected !== current) syncAgentBaseagentFields(ctx);
  } catch (e) {
    if (_agentEdit === ctx) {
      ctx.availableBaseagents = [current].filter(Boolean);
      select.innerHTML = agentBaseagentOptions(current, ctx.availableBaseagents);
      toast(e.message || String(e), true);
    }
  } finally {
    if (_agentEdit === ctx) select.disabled = Boolean(ctx.saving);
  }
}

async function syncAgentCapabilityInfo(ctx, baseagent) {
  const box = ctx.backdrop.querySelector('#ag-edit-capability');
  if (!box) return;
  const token = (ctx.capabilityLoadToken || 0) + 1;
  ctx.capabilityLoadToken = token;
  box.innerHTML = agentCapabilityPlaceholderHtml();
  try {
    const r = mResp(await menuSend({
      type: 'menu.query',
      name: 'capability',
      agent: ctx.aid,
      args: { aid: ctx.aid, baseagent },
    }));
    if (_agentEdit !== ctx || ctx.capabilityLoadToken !== token) return;
    if (r.error) throw new Error(r.error.message || r.error.code);
    box.innerHTML = agentCapabilityHtml(ctx.data, r.data, baseagent);
    bindAgentCapabilityDetails(ctx, baseagent);
  } catch (e) {
    if (_agentEdit === ctx && ctx.capabilityLoadToken === token) {
      box.innerHTML = agentCapabilityPlaceholderHtml(e.message || t('agents.cap.loadFailed'));
    }
  }
}

function bindAgentCapabilityDetails(ctx, baseagent) {
  const box = ctx.backdrop.querySelector('#ag-edit-capability');
  if (!box) return;
  box.querySelectorAll('.ag-edit-cap-details').forEach(details => {
    details.addEventListener('toggle', () => {
      if (!details.open || details.dataset.loaded === '1') return;
      loadAgentCapabilityItems(ctx, baseagent, details.dataset.capType, details);
    });
  });
}

async function loadAgentCapabilityItems(ctx, baseagent, type, details) {
  const target = details?.querySelector('.ag-edit-cap-items');
  if (!target || !type) return;
  target.innerHTML = agentCapabilityPlaceholderHtml(t('common.loading'));
  try {
    const r = mResp(await menuSend({
      type: 'menu.options',
      name: 'capability',
      agent: ctx.aid,
      args: { aid: ctx.aid, baseagent, type },
    }));
    if (_agentEdit !== ctx) return;
    if (r.error) throw new Error(r.error.message || r.error.code);
    target.innerHTML = agentCapabilityItemsHtml(r.data);
    details.dataset.loaded = '1';
  } catch (e) {
    if (_agentEdit === ctx) target.innerHTML = agentCapabilityPlaceholderHtml(e.message || t('agents.cap.itemsLoadFailed'));
  }
}

async function syncAgentOptionFields(ctx, values) {
  const modelSelect = ctx.backdrop.querySelector('#ag-edit-model');
  const effortSelect = ctx.backdrop.querySelector('#ag-edit-effort');
  const activeSelect = ctx.backdrop.querySelector('#ag-edit-active');
  const baseagent = values.baseagent || activeSelect?.value || ctx.original.activeBaseagent;
  const currentModel = values.model || '';
  const currentEffort = values.effort || '';
  const token = (ctx.optionLoadToken || 0) + 1;
  ctx.optionLoadToken = token;

  setAgentSelectLoading(modelSelect, currentModel, currentModel ? `${currentModel} (${t('common.loadingSuffix')})` : t('common.loading'));
  setAgentSelectLoading(effortSelect, currentEffort, currentEffort ? `${currentEffort} (${t('common.loadingSuffix')})` : t('common.loading'));

  try {
    const models = await agentFetchOptions('model', ctx.aid, { baseagent, model: currentModel });
    if (_agentEdit !== ctx || ctx.optionLoadToken !== token) return;
    modelSelect.innerHTML = agentSelectOptions(models, currentModel, t('common.defaultModel'));
  } catch (e) {
    if (_agentEdit === ctx && ctx.optionLoadToken === token) {
      setAgentSelectError(modelSelect, currentModel);
      toast(e.message || String(e), true);
    }
  } finally {
    if (_agentEdit === ctx && ctx.optionLoadToken === token) modelSelect.disabled = false;
  }

  const selectedModel = modelSelect?.value || currentModel;
  await syncAgentEffortOptions(ctx, baseagent, selectedModel, currentEffort, token);
}

async function syncAgentEffortOptions(ctx, baseagent, model, currentEffort, token) {
  const effortSelect = ctx.backdrop.querySelector('#ag-edit-effort');
  if (!effortSelect) return;
  setAgentSelectLoading(effortSelect, currentEffort, currentEffort ? `${currentEffort} (${t('common.loadingSuffix')})` : t('common.loading'));
  try {
    let efforts = await agentFetchOptions('effort', ctx.aid, { baseagent, model, effort: currentEffort || 'auto' });
    if (!efforts.length && AGENT_EFFORT_FALLBACK[baseagent]) efforts = AGENT_EFFORT_FALLBACK[baseagent];
    if (_agentEdit !== ctx || ctx.optionLoadToken !== token) return;
    effortSelect.innerHTML = agentSelectOptions(efforts, currentEffort, t('common.default'));
  } catch (e) {
    if (_agentEdit === ctx && ctx.optionLoadToken === token) {
      const fallback = AGENT_EFFORT_FALLBACK[baseagent] || [];
      effortSelect.innerHTML = agentSelectOptions(fallback, currentEffort, t('common.default'));
      toast(e.message || String(e), true);
    }
  } finally {
    if (_agentEdit === ctx && ctx.optionLoadToken === token) effortSelect.disabled = false;
  }
}

function openAgentConfigDrawer(aid, data) {
  closeAgentConfigDrawer();
  const safe = agentSafeConfig(data);
  const original = agentOriginalEditState(aid, data);
  const active = original.activeBaseagent;
  const titleName = original.name || shortAid(aid);
  const jsonText = esc(JSON.stringify(safe, null, 2));

  const html = `<div class="ag-edit-backdrop" id="ag-edit-backdrop">` +
    `<aside class="ag-edit-drawer" role="dialog" aria-modal="true" aria-labelledby="ag-edit-title">` +
      `<header class="ag-edit-head">` +
        `<div class="ag-edit-title-wrap">` +
          `<div id="ag-edit-title" class="ag-edit-title">${t('agents.edit.editTitle')}</div>` +
          `<div class="ag-edit-subtitle"><span>${esc(titleName)}</span><code>${esc(aid)}</code><span class="ag-edit-subtitle-path" title="${esc(original.projectPath)}">${esc(original.projectPath || '—')}</span></div>` +
        `</div>` +
        `<button class="ag-edit-close" id="ag-edit-close" type="button" aria-label="${t('common.close')}">×</button>` +
      `</header>` +
      `<div class="ag-edit-body">` +
        `<section class="ag-edit-section">` +
          `<label class="ag-edit-field"><span>Owners</span><textarea id="ag-edit-owners" rows="2" spellcheck="false">${esc(original.owners.join('\n'))}</textarea></label>` +
        `</section>` +
        `<section class="ag-edit-section">` +
          `<h3>${t('agents.edit.section.runtime')}</h3>` +
          `<div class="ag-edit-grid">` +
            `<label class="ag-edit-field"><span>${t('agents.edit.field.activeBaseagent')}</span><select id="ag-edit-active">${agentBaseagentOptions(active, [active])}</select></label>` +
            `<label class="ag-edit-field"><span>${t('agents.th.model')}</span><select id="ag-edit-model">${agentSelectOptions([], original.model, t('common.defaultModel'))}</select></label>` +
            `<label class="ag-edit-field"><span>Effort</span><select id="ag-edit-effort">${agentSelectOptions([], original.effort, t('common.default'))}</select></label>` +
          `</div>` +
        `</section>` +
        `<section class="ag-edit-section">` +
          `<h3>${t('agents.edit.section.channels')}</h3>` +
          `${agentChannelsHtml(data)}` +
        `</section>` +
        `<section class="ag-edit-section">` +
          `<h3>${t('agents.edit.section.capabilities')}</h3>` +
          `<div id="ag-edit-capability">${agentCapabilityPlaceholderHtml()}</div>` +
        `</section>` +
        `<section class="ag-edit-section ag-edit-section-json">` +
          `<details open>` +
            `<summary>${t('common.rawJsonPreview')}</summary>` +
            `<textarea id="ag-edit-json" class="ag-edit-json" readonly spellcheck="false">${jsonText}</textarea>` +
          `</details>` +
        `</section>` +
      `</div>` +
      `<footer class="ag-edit-actions">` +
        `<button class="ctrl-btn" id="ag-edit-cancel" type="button">${t('common.cancel')}</button>` +
        `<button class="ctrl-btn" id="ag-edit-save-reload" type="button">${t('common.saveAndReload')}</button>` +
        `<button class="ctrl-btn primary" id="ag-edit-save" type="button">${t('common.save')}</button>` +
      `</footer>` +
    `</aside>` +
  `</div>`;

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const backdrop = wrap.firstChild;
  document.body.appendChild(backdrop);

  const ctx = {
    aid,
    data,
    safeConfig: safe,
    original,
    availableBaseagents: [active].filter(Boolean),
    backdrop,
    onKeydown: (e) => { if (e.key === 'Escape') closeAgentConfigDrawer(); },
  };
  _agentEdit = ctx;

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAgentConfigDrawer(); });
  backdrop.querySelector('#ag-edit-close').addEventListener('click', closeAgentConfigDrawer);
  backdrop.querySelector('#ag-edit-cancel').addEventListener('click', closeAgentConfigDrawer);
  backdrop.querySelector('#ag-edit-save').addEventListener('click', () => saveAgentConfigDrawer(ctx, false));
  backdrop.querySelector('#ag-edit-save-reload').addEventListener('click', () => saveAgentConfigDrawer(ctx, true));
  backdrop.querySelector('#ag-edit-active').addEventListener('change', () => syncAgentBaseagentFields(ctx));
  backdrop.querySelector('#ag-edit-model').addEventListener('change', () => {
    const baseagent = backdrop.querySelector('#ag-edit-active')?.value || ctx.original.activeBaseagent;
    const effort = backdrop.querySelector('#ag-edit-effort')?.value || '';
    const token = (ctx.optionLoadToken || 0) + 1;
    ctx.optionLoadToken = token;
    syncAgentEffortOptions(ctx, baseagent, backdrop.querySelector('#ag-edit-model')?.value || '', effort, token);
  });
  document.addEventListener('keydown', ctx.onKeydown);
  syncAgentBaseagentFields(ctx);
  syncAgentBaseagentOptions(ctx);
  setTimeout(() => backdrop.querySelector('#ag-edit-owners')?.focus(), 0);
}

async function agentOpEdit(aid) {
  await withAgentOp(aid, t('common.operating'), async () => {
    document.querySelectorAll('.ops-more.open').forEach(m => m.classList.remove('open'));
    const qr = await menuSend({ type: 'menu.query', name: 'agent', args: { aid } });
    const q = mResp(qr);
    if (q.error) { toast(q.error.message || q.error.code, true); return; }
    openAgentConfigDrawer(aid, q.data);
  });
}

// ── System 视图 ──
function channelHealthRow(c) {
  const dot = c.connected ? 'on' : (c.aidStatus === 'reconnecting' || c.aidStatus === 'kicked' ? 'idle' : 'off');
  let meta = '';
  if (c.aidStatus && c.aidStatus !== 'connected') meta += ` <span style="color:var(--dim)">${esc(c.aidStatus)}</span>`;
  if (c.reconnectCount > 0) meta += ` <span style="color:var(--dim)">${tf('system.meta.reconnect', { count: c.reconnectCount })}</span>`;
  if (c.flapCount > 0) meta += ` <span style="color:var(--red)">${tf('system.meta.flap', { count: c.flapCount })}</span>`;
  const reason = c.kickReason || c.lastError;
  if (reason && !c.connected) meta += ` <span style="color:var(--red)" title="${esc(reason)}">"${esc(reason)}"</span>`;
  return `<div class="ch-row"><span class="dot ${dot}"></span>${esc(c.type)}${c.instName ? ' ' + esc(c.instName) : ''}${meta}</div>`;
}

function agentHealthCard(ag) {
  const dot = ag.status === 'running' ? 'on' : ag.status === 'disabled' ? 'idle' : 'off';
  let h = `<div class="agent-health-card">`;
  h += `<div class="ahc-head"><span class="dot ${dot}"></span><span class="ahc-aid">${esc(ag.aid || ag.name)}</span><span class="ahc-status">${esc(ag.status)}</span></div>`;
  // 项目路径
  if (ag.projectPath) h += `<div class="ahc-row"><span class="ahc-k">${t('system.label.project')}</span><span class="ahc-v ahc-path" title="${esc(ag.projectPath)}">${esc(ag.projectPath)}</span></div>`;
  // 后端
  const backend = [ag.baseagent, ag.model, ag.effort].filter(Boolean).map(esc).join(' · ');
  h += `<div class="ahc-row"><span class="ahc-k">${t('system.label.backend')}</span><span class="ahc-v">${backend || '—'}</span></div>`;
  // 渠道
  let chans = '';
  for (const c of (ag.channels || [])) chans += channelHealthRow(c);
  h += `<div class="ahc-row"><span class="ahc-k">${t('system.label.channels')}</span><span class="ahc-v">${chans || `<span style="color:var(--dim)">${t('common.none')}</span>`}</span></div>`;
  // 负载
  const load = `${tf('system.stat.processing', { count: ag.processing ?? 0 })} · ${tf('system.stat.pending', { count: ag.pending ?? 0 })}`;
  h += `<div class="ahc-row"><span class="ahc-k">${t('system.label.load')}</span><span class="ahc-v">${load}</span></div>`;
  // 活动
  if (ag.lastActivity) h += `<div class="ahc-row"><span class="ahc-k">${t('system.label.activity')}</span><span class="ahc-v">${fmtAgo(ag.lastActivity)} ${t('common.ago')}</span></div>`;
  // 错误
  if (ag.error) h += `<div class="ahc-err">⚠ ${esc(String(ag.error).slice(0, 120))}</div>`;
  h += '</div>';
  return h;
}

function systemBaseagentCards(baseagents) {
  const list = Array.isArray(baseagents) ? baseagents : [];
  return list.map(ba => {
    const ver = ba.version ? `・${ba.version}` : '';
    const title = `Baseagent・${ba.active ? '✓ ' : ''}${ba.name || 'unknown'}${ver}`;
    const detail = [ba.model, ba.effort].filter(Boolean).map(esc).join(' · ') || t('system.baseagent.unspecified');
    return `<div class="cache-card"><div class="card-label">${esc(title)}</div><div class="card-val">${detail}</div></div>`;
  }).join('');
}

function systemDaemonCard(daemon, sys) {
  const d = daemon || {};
  const aid = d.aid || sys?.aid || sys?.agent || '—';
  const aun = d.aun || {};
  const connected = aun.connected === true || aun.status === 'connected';
  const dot = connected ? 'on' : (aun.status === 'reconnecting' || aun.status === 'kicked' ? 'idle' : 'off');
  const detail = connected ? 'connected' : 'disconnect';
  return `<div class="cache-card daemon-card"><div class="card-label">Daemon</div><div class="daemon-line daemon-aid" title="${esc(String(aid))}">${esc(String(aid))}</div><div class="daemon-line"><span class="dot ${dot}"></span>${esc(detail)}</div></div>`;
}

function renderSystem(data) {
  const el = $('#view-system');
  if (!data) { el.innerHTML = `<div class="empty">${t('common.loading')}</div>`; return; }
  const sys = data.system || {};
  const up = data.upgrade;
  const chk = data.check;

  const vcard = (label, local, upInfo) => {
    let badge = '';
    if (upInfo?.hasUpdate && upInfo.remote) badge = ` <span style="color:var(--accent)">⬆ ${esc(upInfo.remote)}</span>`;
    else if (upInfo?.remote) badge = ` <span style="color:var(--dim)">✓ ${t('system.latest')}</span>`;
    return `<div class="cache-card"><div class="card-label">${esc(label)}</div><div class="card-val">${esc(local || '—')}${badge}</div></div>`;
  };

  let html = '<div class="sys-wrap">';

  // ① 版本卡
  html += '<div class="cache-cards" style="margin-bottom:16px">';
  html += vcard('evolclaw', sys.version, up?.evolclaw);
  html += vcard('FASTAUN', sys.fastaunVersion, up?.fastaun);
  html += vcard('ECWEB', data.ecwebVersion, up?.ecweb ? {
    remote: up.ecweb.remote,
    hasUpdate: !!(up.ecweb.remote && data.ecwebVersion && compareVer(data.ecwebVersion, up.ecweb.remote) < 0),
  } : null);
  html += `<div class="cache-card"><div class="card-label">NodeJS</div><div class="card-val">${esc(sys.node || '—')}</div></div>`;
  html += `<div class="cache-card"><div class="card-label">${t('system.card.uptime')}</div><div class="card-val">${esc(fmtDur(sys.uptime))}</div></div>`;
  html += `<div class="cache-card"><div class="card-label">PID</div><div class="card-val">${sys.pid || '—'}</div></div>`;
  html += '</div>';

  // ② 操作区
  const devHint = up?.devMode ? ` <span style="color:var(--dim);font-size:0.85em">${t('system.devHint')}</span>` : '';
  html += '<div class="sys-actions" style="margin-bottom:16px">' +
    `<button class="ctrl-btn" id="sys-check-btn">${t('system.action.health')}</button> ` +
    `<button class="ctrl-btn" id="sys-upgrade-btn">${t('system.action.checkUpdates')}</button> ` +
    `<button class="ctrl-btn danger" id="sys-restart-btn">${t('system.action.restart')}</button>` +
    devHint +
    '</div>';

  // ③ 健康快照
  if (chk) {
    // 从 chk.structured 读取数据（后端返回的数据结构）
    const s = chk.structured || chk;  // 兼容旧版本（如果 chk 本身就是 structured）
    html += '<div class="sys-health">';
    // 队列 + 近 1 小时 + daemon + baseagent（数字卡片同一行）
    html += '<div class="cache-cards sys-health-summary">';
    html += `<div class="cache-card"><div class="card-label">${t('system.summary.queue')}</div><div class="card-val">${tf('system.stat.pending', { count: s.queue?.pending ?? 0 })} · ${tf('system.stat.processing', { count: s.queue?.processing ?? 0 })}</div></div>`;
    const h = s.lastHour;
    if (h) {
      const errDetail = h.errors > 0 ? ` (${Object.entries(h.errorsByType || {}).map(([t, c]) => `${t}:${c}`).join(', ')})` : '';
      const avg = h.completed > 0 ? ` · ${tf('system.stat.average', { value: (h.avgResponseMs / 1000).toFixed(1) })}` : '';
      html += `<div class="cache-card"><div class="card-label">${t('system.summary.lastHour')}</div><div class="card-val">${tf('system.stat.received', { count: h.received })} · ${tf('system.stat.sent', { count: h.sent ?? 0 })} · ${tf('system.stat.completed', { count: h.completed })} · ${tf('system.stat.errors', { count: h.errors })}${errDetail} · ${tf('system.stat.interrupts', { count: h.interrupts })}${avg}</div></div>`;
    }
    html += systemDaemonCard(s.daemon, sys);
    html += systemBaseagentCards(sys.baseagents);
    html += '</div>';
    // 每个 EvolAgent 实例一张卡片：后端 + 通道健康 + 负载
    // 排序：启用的（非 disabled）在前，停用的（disabled）在后
    if (s.evolagents?.length) {
      const sortedAgents = s.evolagents.slice().sort((a, b) => {
        const aDisabled = a.status === 'disabled' ? 1 : 0;
        const bDisabled = b.status === 'disabled' ? 1 : 0;
        return aDisabled - bDisabled;
      });
      html += '<div class="agent-health-grid">';
      for (const ag of sortedAgents) html += agentHealthCard(ag);
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
  bindSystemEvents(el, data);
}

function bindSystemEvents(el, data) {
  el.querySelector('#sys-check-btn')?.addEventListener('click', async () => {
    try {
      const r = mResp(await menuSend({ type: 'menu.action', name: 'system', action: 'check' }));
      if (r.error) { toast(r.error.message || r.error.code, true); return; }
      state.system = { ...(state.system || {}), check: r.data };
      renderSystem(state.system);
    } catch (e) { toast(e.message, true); }
  });
  el.querySelector('#sys-upgrade-btn')?.addEventListener('click', async () => {
    try {
      const r = mResp(await menuSend({ type: 'menu.action', name: 'system', action: 'upgrade' }));
      if (r.error) { toast(r.error.message || r.error.code, true); return; }
      state.system = { ...(state.system || {}), upgrade: r.data };
      renderSystem(state.system);
    } catch (e) { toast(e.message, true); }
  });
  el.querySelector('#sys-restart-btn')?.addEventListener('click', async () => {
    if (!confirm(t('system.confirmRestart'))) return;
    try {
      await menuSend({ type: 'menu.action', name: 'system', action: 'restart' });
      toast(t('system.restarting'));
    } catch (e) { toast(e.message, true); }
  });
}

// ── Gateway 视图（API 端点 = baseagent 后端接入配置） ──
// 数据来自 daemon menu.query name=gateway（apiKey 已掩码）。
// 写操作走 menuSend({name:'gateway', ...})：update/test/delete。

const GATEWAY_TYPE_ICON = { claude: '🟣', codex: '🟢', gemini: '🔵' };

// 标记每条网关的运行时测试结果：`${scope}#${type}` → { ok, latency, modelCount, error }
const _gwTest = new Map();

function gwKey(scope, type) { return scope + '#' + type; }

function gatewayModelValue(model, effort) {
  const modelHtml = model ? esc(model) : '<span class="gw-dim">—</span>';
  if (!effort) return modelHtml;
  return `${modelHtml}<span class="gw-model-effort"> · ${esc(effort)}</span>`;
}

function renderGateway(data) {
  const el = $('#view-gateway');

  if (!data) { el.innerHTML = `<div class="empty">${t('common.loading')}</div>`; return; }
  if (data.error) {
    const errorText = data.error === 'evolclaw 未运行或 socket 不可达'
      ? t('gateway.error.daemonUnavailable')
      : (data.error === 'daemon 返回失败' ? t('gateway.error.daemonFailed') : data.error);
    el.innerHTML = `<div class="empty">⚠ ${esc(errorText)}</div>`;
    return;
  }
  const gateways = data.gateways || [];
  const scopes = data.scopes || ['defaults'];

  // 按 scope 分组
  const byScope = new Map();
  for (const s of scopes) byScope.set(s, []);
  for (const g of gateways) {
    if (!byScope.has(g.scope)) byScope.set(g.scope, []);
    byScope.get(g.scope).push(g);
  }

  let html = '<div class="gw-wrap">';

  html += `<div class="gw-intro">${esc(t('gateway.intro')).replace('&lt;aid&gt;', '&lt;aid&gt;')}</div>`;

  // 只展示全局默认配置块（用于编辑）
  for (const [scope, list] of byScope) {
    if (scope !== 'defaults') continue;  // 跳过 per-agent 原始配置块（已在下方 effective 展示）
    const scopeLabel = t('gateway.scope.defaults');
    html += `<div class="gw-scope">`;
    html += `<div class="gw-scope-head"><span class="gw-scope-title">${scopeLabel}</span></div>`;
    html += '<div class="gw-cards">';
    if (!list.length) {
      html += `<div class="empty" style="padding:12px">${t('gateway.empty.scope')}</div>`;
    } else {
      for (const g of list) html += gatewayCard(g);
    }
    html += '</div></div>';
  }

  // ── Agent 使用配置（effective）：紧凑表格 + 编辑按钮 ──
  const effective = data.effective || [];
  if (effective.length > 0) {
    html += '<div class="gw-effective-section">';
    html += `<div class="gw-scope-head"><span class="gw-scope-title">${t('gateway.effective.title')}</span></div>`;
    html += '<table class="gw-eff-table"><thead><tr>' +
      `<th>Agent</th><th>Base Agent</th><th>Base URL</th><th>${t('gateway.th.model')}</th><th>API Key</th><th>Effort</th><th>${t('gateway.th.source')}</th>` +
      '</tr></thead><tbody>';
    for (const eff of effective) {
      const f = eff.fields || {};
      const blockSrc = eff.blockSource || 'defaults';
      const srcCls = blockSrc === 'agent' ? 'gw-src-agent' : 'gw-src-defaults';
      const srcLabel = blockSrc === 'agent' ? t('gateway.source.agent') : t('gateway.source.default');
      const baseUrlVal = f.baseUrl?.value || '';
      const modelVal = f.model?.value || '';
      const keyVal = f.apiKey?.value || '';
      const effortVal = f.effort?.value || '';

      html += `<tr class="gw-eff-tr${blockSrc === 'defaults' ? ' gw-eff-tr-inherited' : ''}">` +
        `<td class="gw-eff-td-aid" title="${esc(eff.aid)}">${esc(shortAid(eff.aid))}</td>` +
        `<td>${GATEWAY_TYPE_ICON[eff.type] || ''} ${esc(eff.type)}</td>` +
        `<td class="gw-eff-td-url" title="${esc(baseUrlVal)}">${baseUrlVal ? esc(baseUrlVal) : `<span class="gw-dim">${t('gateway.official')}</span>`}</td>` +
        `<td>${modelVal ? esc(modelVal) : '<span class="gw-dim">—</span>'}</td>` +
        `<td>${keyVal ? esc(keyVal) : '<span class="gw-dim">—</span>'}</td>` +
        `<td>${effortVal ? esc(effortVal) : '<span class="gw-dim">—</span>'}</td>` +
        `<td><span class="gw-eff-src-tag ${srcCls}">${srcLabel}</span></td>` +
        `</tr>`;
    }
    html += '</tbody></table></div>';
  }

  html += '</div>';
  el.innerHTML = html;
  bindGatewayEvents(el, data);
}

function gatewayCard(g) {
  const key = gwKey(g.scope, g.type);
  const icon = GATEWAY_TYPE_ICON[g.type] || '⚙';
  const test = _gwTest.get(key);

  // 连通性测试状态点
  let dot = `<span class="gw-dot gw-dot-unknown" title="${t('gateway.notTested')}"></span>`;
  if (test) {
    if (test.ok) dot = `<span class="gw-dot gw-dot-ok" title="${test.latency}ms · ${tf('gateway.modelsCount', { count: test.modelCount })}"></span>`;
    else dot = `<span class="gw-dot gw-dot-err" title="${esc(test.error || t('gateway.failed'))}"></span>`;
  }

  // API Key 展示
  let keyHtml;
  if (!g.apiKeyMask) keyHtml = `<span class="gw-dim">${t('gateway.key.notConfigured')}</span>`;
  else if (g.apiKeyIsEnvRef) keyHtml = `<code class="gw-env">${esc(g.apiKeyMask)}</code>`;
  else keyHtml = `<span class="gw-dim" title="${t('gateway.key.plainTitle')}">${t('gateway.key.plainLabel')}</span>`;

  const rows = [];
  rows.push(['Base URL', g.baseUrl ? esc(g.baseUrl) : `<span class="gw-dim">${t('gateway.officialEndpoint')}</span>`]);
  rows.push(['API Key', keyHtml]);
  rows.push([t('gateway.defaultModel'), gatewayModelValue(g.model, g.effort)]);
  if (g.mode) rows.push([t('gateway.mode'), esc(g.mode)]);
  if (g.cliPath) rows.push([t('gateway.cliPath'), esc(g.cliPath)]);
  if (g.project) rows.push(['Project', esc(g.project)]);
  if (g.location) rows.push(['Location', esc(g.location)]);

  let html = `<div class="gw-card" data-key="${esc(key)}">`;
  html += `<div class="gw-card-head">${dot}<span class="gw-card-icon">${icon}</span>` +
    `<span class="gw-card-title">${esc(g.name)}</span>` +
    `<span class="gw-card-type">${esc(g.type)}</span></div>`;
  html += '<div class="gw-card-body">';
  for (const [label, val] of rows) {
    html += `<div class="gw-row"><span class="gw-row-label">${esc(label)}</span><span class="gw-row-val">${val}</span></div>`;
  }
  html += '</div>';
  // 卡片操作按钮已移除（只读模式）
  html += '</div>';
  return html;
}

function bindGatewayEvents(el, data) {
  // 已移除所有编辑操作事件绑定（API 端点配置现为只读展示）
  void el; void data;
}

// ── Triggers 视图 ──
const TRIGGER_SCHEDULE_TYPES = [
  ['delay', () => t('triggers.schedule.delay')],
  ['at', () => t('triggers.schedule.at')],
  ['cron', () => t('triggers.schedule.cron')],
  ['interval', () => t('triggers.schedule.interval')],
  ['event', () => t('triggers.schedule.event')],
];
const TRIGGER_EXECUTION_MODES = [
  ['agent', () => t('triggers.execution.agent')],
  ['script', () => t('triggers.execution.script')],
];
const TRIGGER_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const TRIGGER_PERMISSION_MODES = ['auto', 'bypass', 'readonly', 'plan', 'edit', 'request', 'noask'];
const TRIGGER_SESSION_STRATEGIES = [
  ['latest', () => t('triggers.session.latest')],
  ['thread', () => t('triggers.session.thread')],
];
const TRIGGER_CONCURRENCY_OPTIONS = [
  ['forbid', () => t('triggers.concurrency.forbid')],
  ['replace', () => t('triggers.concurrency.replace')],
  ['allow', () => t('triggers.concurrency.allow')],
];
const TRIGGER_MISSED_POLICY_OPTIONS = [
  ['skip', () => t('triggers.missed.skip')],
  ['run_once', () => t('triggers.missed.run_once')],
  ['run_all', () => t('triggers.missed.run_all')],
];
const TRIGGER_DURATION_UNIT_MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
const TRIGGER_DURATION_UNIT_ORDER = ['d', 'h', 'm', 's'];
const TRIGGER_MAX_DURATION_FORMAT = { units: ['d', 'h', 'm', 's'], allowCombined: false };
const TRIGGER_SCHEDULE_DURATION_FORMAT = { units: ['d', 'h', 'm', 's'], allowCombined: false };
const TRIGGER_FEEDBACK_ACTION_OPTIONS = [
  ['forward', () => t('triggers.feedback.forward')],
  ['reply-origin', () => t('triggers.feedback.reply-origin')],
];
const TRIGGER_FEEDBACK_DELIVERY_OPTIONS = [
  ['inbound', () => t('triggers.feedback.delivery.inbound')],
  ['direct', () => t('triggers.feedback.delivery.direct')],
];
const TRIGGER_FILTER_OPERATORS = [
  ['eq', () => t('triggers.filter.op.eq')],
  ['in', () => t('triggers.filter.op.in')],
  ['regex', () => t('triggers.filter.op.regex')],
  ['gt', () => t('triggers.filter.op.gt')],
  ['gte', () => t('triggers.filter.op.gte')],
  ['lt', () => t('triggers.filter.op.lt')],
  ['lte', () => t('triggers.filter.op.lte')],
  ['exists', () => t('triggers.filter.op.exists')],
];
let _triggerEventCatalog = { namespaces: [], events: [] };
let _triggerEventCatalogPromise = null;
let _triggerEventCatalogLoading = false;
let _triggerEventCatalogError = '';

function trigStatusBadge(status) {
  const map = {
    active:    [t('triggers.status.active'), 'trig-badge-active'],
    disabled:  [t('triggers.status.disabled'), 'trig-badge-disabled'],
    fired:     [t('triggers.status.fired'), 'trig-badge-fired'],
    cancelled: [t('triggers.status.cancelled'), 'trig-badge-cancelled'],
    expired:   [t('triggers.status.expired'), 'trig-badge-expired'],
  };
  const [label, cls] = map[status] || [status, 'trig-badge-fired'];
  return `<span class="trig-badge ${cls}">${esc(label)}</span>`;
}

function trigSubscriptionBadge(subscription, sourceType) {
  if (sourceType !== 'event') return '<span class="trig-sub muted">—</span>';
  const status = subscription?.status || 'inactive';
  const map = {
    active: [t('triggers.subscription.active'), 'ok'],
    inactive: [t('triggers.subscription.inactive'), 'warn'],
    'event-bus-unavailable': [t('triggers.subscription.event-bus-unavailable'), 'err'],
  };
  const [label, cls] = map[status] || [status, 'warn'];
  const title = subscription?.warning ? ` title="${esc(subscription.warning)}"` : '';
  return `<span class="trig-sub ${cls}"${title}>${esc(label)}</span>`;
}

function triggerSourceType(trigger) {
  return trigger?.definition?.source?.type || trigger?.scheduleType || '';
}

function triggerRefresh() {
  subscribe('triggers', trigSel.agent ? { agent: trigSel.agent } : {});
}

function triggerIdOf(t) {
  return String(t?.id ?? t?.value ?? '');
}

function triggerAgentOf(t) {
  return String(t?.agentAid || t?.schedulerAid || trigSel.agent || '');
}

function triggerOpKey(id, agent) {
  return `${agent || ''}::${id || ''}`;
}

function triggerIsEnabled(t) {
  if (t?.definition && typeof t.definition.enabled === 'boolean') return t.definition.enabled;
  if (typeof t?.enabled === 'boolean') return t.enabled;
  return (t?.status || 'active') === 'active';
}

function findTriggerItem(id, agent) {
  const list = state.triggers?.triggers || [];
  return list.find(t => triggerIdOf(t) === id && (!agent || triggerAgentOf(t) === agent))
    || list.find(t => triggerIdOf(t) === id)
    || null;
}

function setTriggerOp(id, agent, label) {
  const key = triggerOpKey(id, agent);
  if (label == null) _trigOps.delete(key); else _trigOps.set(key, label);
  if (state.triggers && currentView === 'triggers') renderTriggers(state.triggers);
}

async function withTriggerOp(id, agent, label, fn) {
  setTriggerOp(id, agent, label);
  try { await fn(); }
  finally { setTriggerOp(id, agent, null); }
}

function triggerOptionHtml(items, current, emptyLabel) {
  const selected = String(current || '');
  let html = emptyLabel == null ? '' : `<option value=""${selected ? '' : ' selected'}>${esc(emptyLabel)}</option>`;
  let seen = new Set();
  for (const item of items) {
    const value = Array.isArray(item) ? String(item[0]) : String(item);
    const rawLabel = Array.isArray(item) ? item[1] : item;
    const label = typeof rawLabel === 'function' ? rawLabel() : String(rawLabel);
    if (seen.has(value)) continue;
    seen.add(value);
    html += `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }
  if (selected && !seen.has(selected)) {
    html += `<option value="${esc(selected)}" selected>${esc(selected)} (${t('common.currentSuffix')})</option>`;
  }
  return html;
}

async function triggerEnsureEventCatalog(ctx) {
  if (!_triggerEventCatalogPromise) {
    _triggerEventCatalogLoading = true;
    _triggerEventCatalogError = '';
    if (ctx && _triggerEdit === ctx) triggerRefreshEventDatalists(ctx);
    _triggerEventCatalogPromise = ipcSend({ type: 'trigger.eventCatalog' }, 10000)
      .then(resp => {
        if (!resp?.ok) throw new Error(resp?.error || 'event catalog unavailable');
        _triggerEventCatalog = {
          namespaces: Array.isArray(resp.namespaces) ? resp.namespaces : [],
          events: Array.isArray(resp.events) ? resp.events : [],
        };
        _triggerEventCatalogLoading = false;
        _triggerEventCatalogError = '';
        return _triggerEventCatalog;
      })
      .catch(err => {
        _triggerEventCatalogLoading = false;
        _triggerEventCatalogError = err?.message || String(err);
        _triggerEventCatalogPromise = null;
        throw err;
      });
  }
  const catalog = await _triggerEventCatalogPromise;
  if (ctx && _triggerEdit === ctx) triggerRefreshEventDatalists(ctx);
  return catalog;
}

function triggerEventPatternOptionsHtml(current) {
  const selected = String(current || '');
  const values = new Map();
  values.set('*', '*');
  for (const ns of _triggerEventCatalog.namespaces || []) values.set(`${ns}:*`, `${ns}:*`);
  for (const ev of _triggerEventCatalog.events || []) values.set(ev.type, `${ev.type} - ${ev.description || ''}`.trim());
  if (selected && !values.has(selected)) values.set(selected, selected);
  return [...values.entries()]
    .map(([value, label]) => `<option value="${esc(value)}" label="${esc(label)}"></option>`)
    .join('');
}

function triggerEventFieldsForPattern(pattern) {
  const text = String(pattern || '').trim();
  const events = _triggerEventCatalog.events || [];
  let matched = events;
  if (text && text !== '*') {
    if (text.endsWith(':*')) {
      const prefix = text.slice(0, -1);
      matched = events.filter(ev => ev.type.startsWith(prefix));
    } else {
      matched = events.filter(ev => ev.type === text);
    }
  }
  const fields = new Map();
  for (const ev of matched) {
    for (const field of ev.fields || []) {
      if (!field?.path || fields.has(field.path)) continue;
      fields.set(field.path, field);
    }
  }
  return [...fields.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

function triggerEventFieldOptionsHtml(pattern) {
  return triggerEventFieldsForPattern(pattern)
    .map(field => `<option value="${esc(field.path)}" label="${esc(`${field.path} (${field.type}${field.optional ? '?' : ''})`)}"></option>`)
    .join('');
}

function triggerRefreshEventDatalists(ctx) {
  const root = ctx.backdrop;
  const pattern = root.querySelector('#trig-edit-schedule-value')?.value || ctx.original.scheduleValue || '';
  const patternList = root.querySelector('#trig-event-pattern-list');
  if (patternList) patternList.innerHTML = triggerEventPatternOptionsHtml(pattern);
  const fieldList = root.querySelector('#trig-event-field-list');
  if (fieldList) fieldList.innerHTML = triggerEventFieldOptionsHtml(pattern);
}

function triggerFilterOperatorOptions(current) {
  return triggerOptionHtml(TRIGGER_FILTER_OPERATORS, current || 'eq', null);
}

function triggerFilterRowsFromMatch(match) {
  const rows = [];
  if (!match || typeof match !== 'object') return rows;
  for (const [path, expected] of Object.entries(match)) {
    if (typeof expected === 'string' || typeof expected === 'number' || typeof expected === 'boolean') {
      rows.push({ path, op: 'eq', value: String(expected) });
      continue;
    }
    if (!expected || typeof expected !== 'object') {
      rows.push({ path, op: 'eq', value: String(expected ?? '') });
      continue;
    }
    if ('$in' in expected) rows.push({ path, op: 'in', value: Array.isArray(expected.$in) ? expected.$in.map(v => String(v)).join(', ') : '' });
    if ('$regex' in expected) rows.push({ path, op: 'regex', value: String(expected.$regex ?? '') });
    if ('$gt' in expected) rows.push({ path, op: 'gt', value: String(expected.$gt ?? '') });
    if ('$gte' in expected) rows.push({ path, op: 'gte', value: String(expected.$gte ?? '') });
    if ('$lt' in expected) rows.push({ path, op: 'lt', value: String(expected.$lt ?? '') });
    if ('$lte' in expected) rows.push({ path, op: 'lte', value: String(expected.$lte ?? '') });
    if ('$exists' in expected) rows.push({ path, op: 'exists', value: String(expected.$exists ?? true) });
  }
  return rows;
}

function triggerFilterRowHtml(row = {}) {
  const path = String(row.path || '');
  const op = String(row.op || 'eq');
  const value = String(row.value ?? (op === 'exists' ? 'true' : ''));
  return `<div class="trig-filter-row">` +
    `<label class="ag-edit-field"><span>${t('triggers.field.filterField')}</span><input class="trig-filter-path" list="trig-event-field-list" type="text" autocomplete="off" spellcheck="false" value="${esc(path)}"></label>` +
    `<label class="ag-edit-field"><span>${t('triggers.field.filterOperator')}</span><select class="trig-filter-op">${triggerFilterOperatorOptions(op)}</select></label>` +
    `<label class="ag-edit-field"><span>${t('triggers.field.filterValue')}</span><input class="trig-filter-value" type="text" autocomplete="off" spellcheck="false" value="${esc(value)}" placeholder="${t('triggers.placeholder.filterValue')}"></label>` +
    `<button class="ctrl-btn danger trig-filter-remove" type="button" title="${t('triggers.op.delete')}">×</button>` +
  `</div>`;
}

function triggerRenderFilterRows(ctx, rows) {
  const list = ctx.backdrop.querySelector('#trig-filter-list');
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = `<div class="trig-filter-empty">${t('triggers.filter.none')}</div>`;
  } else {
    list.innerHTML = rows.map(row => triggerFilterRowHtml(row)).join('');
  }
  triggerUpdateFilterJsonPreview(ctx);
}

function triggerFilterRows(ctx) {
  return [...ctx.backdrop.querySelectorAll('.trig-filter-row')].map(row => ({
    path: row.querySelector('.trig-filter-path')?.value || '',
    op: row.querySelector('.trig-filter-op')?.value || 'eq',
    value: row.querySelector('.trig-filter-value')?.value || '',
  }));
}

function triggerParseFilterScalar(text) {
  const value = String(text ?? '').trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function triggerFilterMatchFromRows(rows) {
  const match = {};
  const setOperator = (path, op, expected) => {
    const current = match[path];
    if (!current || typeof current !== 'object' || Array.isArray(current)) match[path] = {};
    match[path][op] = expected;
  };
  for (const row of rows) {
    const path = String(row.path || '').trim();
    const op = String(row.op || 'eq');
    const value = String(row.value ?? '').trim();
    if (!path && !value) continue;
    if (!path) return { error: t('triggers.error.filterPathRequired') };
    for (const part of path.split('.')) {
      if (!part || part === '__proto__' || part === 'prototype' || part === 'constructor') {
        return { error: t('triggers.error.filterPathRequired') };
      }
    }
    if (op !== 'exists' && !value) return { error: t('triggers.error.filterValueRequired') };
    if (op === 'eq') match[path] = triggerParseFilterScalar(value);
    else if (op === 'in') setOperator(path, '$in', value.split(',').map(v => triggerParseFilterScalar(v)).filter(v => String(v).trim() !== ''));
    else if (op === 'regex') setOperator(path, '$regex', value);
    else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      const n = Number(value);
      if (!Number.isFinite(n)) return { error: t('triggers.error.filterValueRequired') };
      setOperator(path, `$${op}`, n);
    } else if (op === 'exists') {
      setOperator(path, '$exists', value === '' ? true : value !== 'false');
    }
  }
  return { match };
}

function triggerReadEventFilter(ctx) {
  const result = triggerFilterMatchFromRows(triggerFilterRows(ctx));
  if (result.error) return result;
  return Object.keys(result.match).length ? { value: { match: result.match } } : { value: null };
}

function triggerStableJson(value) {
  if (value === undefined) return '';
  const normalize = v => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = normalize(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(normalize(value ?? null));
}

function triggerUpdateFilterJsonPreview(ctx) {
  const preview = ctx.backdrop.querySelector('#trig-filter-json-preview');
  if (!preview) return;
  const result = triggerReadEventFilter(ctx);
  preview.value = result.error ? result.error : JSON.stringify(result.value || {}, null, 2);
}

function triggerFeedbackKind(definition, branch, fallback) {
  const kind = definition?.feedback?.[branch]?.kind;
  return kind === 'forward' || kind === 'reply-origin' || kind === 'silent' ? kind : fallback;
}

function triggerFeedbackDelivery(definition, branch, fallback = 'direct') {
  const disposition = definition?.feedback?.[branch];
  const raw = disposition?.kind === 'reply-origin'
    ? disposition.delivery
    : disposition?.kind === 'forward'
      ? disposition.targets?.[0]?.delivery
      : undefined;
  return raw === 'inbound' || raw === 'direct' ? raw : fallback;
}

function triggerFeedbackAction(kind, fallback = 'forward') {
  return kind === 'forward' || kind === 'reply-origin' ? kind : fallback;
}

function triggerFeedbackRowHtml(key, label, kind, delivery, fallback = 'forward') {
  const enabled = kind !== 'silent';
  const action = triggerFeedbackAction(kind, fallback);
  return `<label class="sess-switch trig-feedback-switch" data-feedback-row="${esc(key)}">` +
      `<input id="trig-edit-feedback-${esc(key)}-enabled" type="checkbox"${enabled ? ' checked' : ''}>` +
      `<span class="sess-switch-track"><span class="sess-switch-thumb"></span></span>` +
      `<span>${esc(label)}</span>` +
    `</label>` +
    `<label class="ag-edit-field"><span>${t('triggers.field.feedbackDelivery')}</span><select id="trig-edit-feedback-${esc(key)}-delivery">${triggerOptionHtml(TRIGGER_FEEDBACK_DELIVERY_OPTIONS, delivery, null)}</select></label>` +
    `<label class="ag-edit-field"><span>${t('triggers.field.feedbackAction')}</span><select id="trig-edit-feedback-${esc(key)}">${triggerOptionHtml(TRIGGER_FEEDBACK_ACTION_OPTIONS, action, null)}</select></label>`;
}

function triggerReadFeedbackKind(root, key, fallback = 'forward') {
  const enabled = root.querySelector(`#trig-edit-feedback-${key}-enabled`)?.checked;
  if (!enabled) return 'silent';
  const action = root.querySelector(`#trig-edit-feedback-${key}`)?.value || fallback;
  return action === 'reply-origin' ? 'reply-origin' : 'forward';
}

function triggerReadFeedbackDelivery(root, key, fallback = 'direct') {
  const delivery = root.querySelector(`#trig-edit-feedback-${key}-delivery`)?.value || fallback;
  return delivery === 'inbound' ? 'inbound' : 'direct';
}

function triggerPad2(n) {
  return String(n).padStart(2, '0');
}

function triggerAtInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 19);
  return `${date.getFullYear()}-${triggerPad2(date.getMonth() + 1)}-${triggerPad2(date.getDate())}` +
    `T${triggerPad2(date.getHours())}:${triggerPad2(date.getMinutes())}:${triggerPad2(date.getSeconds())}`;
}

function triggerAtScheduleValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : text;
}

function triggerIsDurationSchedule(type) {
  return type === 'delay' || type === 'interval';
}

function triggerParseDuration(value, format = TRIGGER_SCHEDULE_DURATION_FORMAT) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  const units = new Set(format.units || []);
  const tokenRe = /([1-9]\d*)([dhms])/g;
  let total = 0;
  let offset = 0;
  let count = 0;
  let lastOrder = -1;
  let match;
  while ((match = tokenRe.exec(text))) {
    if (match.index !== offset) return null;
    const unit = match[2];
    const order = TRIGGER_DURATION_UNIT_ORDER.indexOf(unit);
    if (!units.has(unit) || order < 0 || order <= lastOrder) return null;
    if (!format.allowCombined && count > 0) return null;
    total += Number(match[1]) * TRIGGER_DURATION_UNIT_MS[unit];
    offset = tokenRe.lastIndex;
    lastOrder = order;
    count += 1;
  }
  return count > 0 && offset === text.length && total > 0 ? total : null;
}

function triggerDurationValueValid(value, format) {
  return triggerParseDuration(value, format) !== null;
}

function triggerDurationStringFromMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return String(value || '');
  for (const unit of TRIGGER_DURATION_UNIT_ORDER) {
    const unitMs = TRIGGER_DURATION_UNIT_MS[unit];
    if (ms % unitMs === 0) return `${ms / unitMs}${unit}`;
  }
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function triggerScheduleDurationInputValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (triggerDurationValueValid(text, TRIGGER_SCHEDULE_DURATION_FORMAT)) return text.toLowerCase();
  if (/^[1-9]\d*$/.test(text)) return triggerDurationStringFromMs(text);
  return text;
}

function triggerScheduleDurationComparable(value) {
  const text = String(value || '').trim();
  const parsed = triggerParseDuration(text, TRIGGER_SCHEDULE_DURATION_FORMAT);
  if (parsed !== null) return String(parsed);
  return /^[1-9]\d*$/.test(text) ? String(Number(text)) : text;
}

function triggerEventPatternValueValid(value) {
  const text = String(value || '').trim();
  return text === '*' || /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(text) || /^[A-Za-z0-9_-]+:\*$/.test(text);
}

function triggerScheduleValueLabel(type, value) {
  if (triggerIsDurationSchedule(type)) return triggerScheduleDurationInputValue(value);
  if (type === 'at' && value) return fmtTime(new Date(value).getTime());
  return String(value ?? '');
}

function triggerComparableScheduleValue(type, value) {
  if (triggerIsDurationSchedule(type)) return triggerScheduleDurationComparable(value);
  if (type !== 'at') return String(value || '');
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? String(date.getTime()) : String(value || '');
}

function triggerActiveBaseagentForAgent(agentAid) {
  const list = state.agents?.agents || [];
  const ag = list.find(x => x.aid === agentAid || x.value === agentAid);
  return ag?.baseagent || ag?.activeBaseagent || ag?.active_baseagent || 'claude';
}

function triggerScheduleLabel(type) {
  const found = TRIGGER_SCHEDULE_TYPES.find(x => x[0] === type);
  if (!found) return type || '';
  return typeof found[1] === 'function' ? found[1]() : found[1];
}

function triggerSessionStrategyLabel(strategy) {
  const normalized = triggerUiSessionStrategy(strategy);
  const found = TRIGGER_SESSION_STRATEGIES.find(x => x[0] === normalized);
  if (!found) return normalized || '';
  return typeof found[1] === 'function' ? found[1]() : found[1];
}

function triggerSourceView(definition, fallback) {
  const source = definition?.source || null;
  if (source?.type === 'delay') return { scheduleType: 'delay', scheduleValue: String(source.afterMs ?? '') };
  if (source?.type === 'at') return { scheduleType: 'at', scheduleValue: String(source.at ?? '') };
  if (source?.type === 'cron') return { scheduleType: 'cron', scheduleValue: String(source.expression ?? ''), timezone: String(source.timezone ?? '') };
  if (source?.type === 'interval') return { scheduleType: 'interval', scheduleValue: String(source.everyMs ?? '') };
  if (source?.type === 'event') return { scheduleType: 'event', scheduleValue: String(source.eventPattern ?? '') };
  return {
    scheduleType: String(fallback?.scheduleType ?? ''),
    scheduleValue: String(fallback?.scheduleValue ?? ''),
    timezone: '',
  };
}

function triggerUiSessionStrategy(strategy) {
  const s = String(strategy || '');
  if (s === 'thread') return 'thread';
  return 'latest';
}

function triggerPrimaryTarget(definition) {
  const dispositions = [
    definition?.feedback?.onReply,
    definition?.feedback?.onFailure,
    definition?.feedback?.onNoop,
  ];
  for (const d of dispositions) {
    if (d?.kind === 'forward' && Array.isArray(d.targets) && d.targets.length > 0) return d.targets[0];
  }
  const session = definition?.execution?.session;
  if (session?.channelKey || session?.channelId) {
    return { channelKey: session.channelKey || '', channelId: session.channelId || '', threadId: session.threadId || '' };
  }
  return null;
}

function triggerPrompt(definition, fallback) {
  if (definition?.execution?.mode === 'agent') return String(definition.execution.prompt ?? fallback?.prompt ?? '');
  const onReply = definition?.feedback?.onReply;
  if (onReply && (onReply.kind === 'forward' || onReply.kind === 'reply-origin')) return String(onReply.template ?? fallback?.prompt ?? '');
  return String(fallback?.prompt ?? '');
}

function triggerShellQuoteArg(value) {
  const text = String(value ?? '');
  if (!text) return "''";
  return /[\s"'\\]/.test(text) ? `"${text.replace(/(["\\$`])/g, '\\$1')}"` : text;
}

function triggerScriptCommandText(script) {
  const scriptPath = String(script?.path ?? '');
  if (!scriptPath) return '';
  const args = Array.isArray(script?.args) ? script.args.map(triggerShellQuoteArg).join(' ') : '';
  const command = triggerShellQuoteArg(scriptPath);
  return args ? `${command} ${args}` : command;
}

function triggerScriptPreviewText(preview) {
  if (!preview) return t('triggers.scriptPreview.empty');
  if (preview.error) return preview.error;
  const content = String(preview.content ?? '');
  if (!content) return t('triggers.scriptPreview.empty');
  return preview.truncated ? `${content}\n\n[${t('triggers.scriptPreview.truncated')}]` : content;
}

function triggerScriptPreviewHtml(preview) {
  return `<label class="ag-edit-field trig-script-field trig-script-preview-field">` +
    `<span>${t('triggers.field.scriptContent')}</span>` +
    `<textarea id="trig-edit-script-preview" class="trig-script-preview" rows="8" readonly spellcheck="false">${esc(triggerScriptPreviewText(preview))}</textarea>` +
  `</label>`;
}

function triggerOriginalEditState(t) {
  const definition = t?.definition || null;
  const source = triggerSourceView(definition, t);
  const target = triggerPrimaryTarget(definition) || {};
  const session = definition?.execution?.session || {};
  const limits = definition?.limits || t?.limits || {};
  const reliability = definition?.reliability || {};
  const id = triggerIdOf(t);
  const agentAid = triggerAgentOf(t);
  return {
    id,
    agentAid,
    name: String(definition?.name ?? t?.name ?? t?.label ?? ''),
    enabled: triggerIsEnabled(t),
    mode: String(definition?.execution?.mode ?? 'agent'),
    scriptPath: triggerScriptCommandText(definition?.execution?.script),
    scriptRuntime: String(definition?.execution?.script?.runtime ?? ''),
    scriptPreview: t?.scriptPreview ?? null,
    scheduleType: source.scheduleType,
    scheduleValue: source.scheduleValue,
    eventFilter: definition?.source?.type === 'event' ? (definition.source.filter ?? null) : null,
    timezone: String(source.timezone ?? ''),
    prompt: triggerPrompt(definition, t),
    baseagent: String(definition?.execution?.session?.baseagent ?? t?.baseagent ?? triggerActiveBaseagentForAgent(agentAid)),
    model: String(definition?.execution?.model ?? t?.model ?? ''),
    effort: String(definition?.execution?.effort ?? t?.effort ?? ''),
    permissionMode: String(definition?.execution?.permissionMode ?? t?.permissionMode ?? ''),
    targetChannel: String(target.channelKey ?? t?.targetChannel ?? ''),
    targetChannelId: String(target.channelId ?? t?.targetChannelId ?? ''),
    targetSessionStrategy: triggerUiSessionStrategy(session.strategy ?? t?.targetSessionStrategy),
    targetThreadId: String(session.threadId ?? target.threadId ?? t?.targetThreadId ?? ''),
    maxRuns: limits.maxRuns == null ? '' : String(limits.maxRuns),
    maxDuration: limits.maxDuration == null ? '' : String(limits.maxDuration),
    concurrency: String(reliability.concurrency ?? 'forbid'),
    missedPolicy: String(reliability.missedPolicy ?? 'run_once'),
    feedbackOnReply: triggerFeedbackKind(definition, 'onReply', 'forward'),
    feedbackOnReplyDelivery: triggerFeedbackDelivery(definition, 'onReply', 'direct'),
    feedbackOnNoop: triggerFeedbackKind(definition, 'onNoop', 'silent'),
    feedbackOnNoopDelivery: triggerFeedbackDelivery(definition, 'onNoop', 'direct'),
    feedbackOnFailure: triggerFeedbackKind(definition, 'onFailure', 'silent'),
    feedbackOnFailureDelivery: triggerFeedbackDelivery(definition, 'onFailure', 'direct'),
    createdByPeerId: String(definition?.origin?.peerId ?? t?.createdByPeerId ?? ''),
    createdByChannel: String(definition?.origin?.channel ?? t?.createdByChannel ?? ''),
    rawPreview: definition || t || {},
  };
}

function triggerOpsHtml(trigger) {
  const id = triggerIdOf(trigger);
  const agent = triggerAgentOf(trigger);
  const enabled = triggerIsEnabled(trigger);
  const busy = _trigOps.get(triggerOpKey(id, agent));
  if (busy) return `<div class="trig-ops trig-ops-busy" data-trigid="${esc(id)}" data-agent="${esc(agent)}"><span>${esc(busy)}</span></div>`;
  let html = `<div class="trig-ops" data-trigid="${esc(id)}" data-agent="${esc(agent)}">`;
  html += `<button class="ctrl-btn" data-trig-op="edit" title="${t('triggers.op.edit')}">${t('triggers.op.edit')}</button>`;
  html += `<div class="ops-more"><button class="ctrl-btn ops-more-btn" data-trig-op="more" title="${t('action.more')}" aria-label="${t('action.more')}">…</button>` +
    `<div class="ops-dropdown">` +
    `<button class="ops-dd-item ops-run" data-trig-op="run"${enabled ? '' : ` disabled title="${t('triggers.op.runDisabledTitle')}"`}>${t('triggers.op.run')}</button>` +
    `<button class="ops-dd-item" data-trig-op="edit">${t('triggers.op.edit')}</button>` +
    (enabled
      ? `<button class="ops-dd-item ops-disable" data-trig-op="disable">${t('triggers.op.disable')}</button>`
      : `<button class="ops-dd-item ops-enable" data-trig-op="enable">${t('action.enable')}</button>`) +
    `<button class="ops-dd-item danger" data-trig-op="delete"${enabled ? ` disabled title="${t('triggers.op.deleteDisabledTitle')}"` : ''}>${t('triggers.op.delete')}</button>` +
    `</div></div>`;
  html += '</div>';
  return html;
}

async function triggerRunAction(action, id, agent) {
  const item = findTriggerItem(id, agent);
  if (!item) { toast(t('triggers.error.notFound'), true); return; }
  const name = String(item.name ?? item.label ?? id);
  const enabled = triggerIsEnabled(item);
  if (action === 'delete' && enabled) { toast(t('triggers.error.deleteEnabled'), true); return; }
  if (action === 'run' && !enabled) { toast(t('triggers.error.runDisabled'), true); return; }
  if (action === 'delete' && !confirm(tf('triggers.confirmDelete', { name }))) return;

  const labels = { enable: t('agents.op.enabling'), disable: t('agents.op.disabling'), delete: t('agents.op.deleting'), run: t('triggers.op.running') };
  await withTriggerOp(id, agent, labels[action] || t('common.operating'), async () => {
    try {
      const r = mResp(await menuSend({
        type: 'menu.action',
        name: 'trigger',
        action,
        args: { nameOrId: id },
        agent,
        timeoutMs: action === 'run' ? 120000 : 10000,
      }));
      if (r.error) { toast(r.error.message || r.error.code, true); return; }
      if (action === 'run') {
        const status = r.data?.status ? `: ${r.data.status}${r.data.reason ? ` / ${r.data.reason}` : ''}` : '';
        toast(tf('triggers.op.ran', { status }));
      } else if (action === 'enable') toast(t('triggers.op.enabled'));
      else if (action === 'disable') toast(t('triggers.op.disabled'));
      else if (action === 'delete') toast(t('triggers.op.deleted'));
      triggerRefresh();
    } catch (e) {
      toast(e.message || String(e), true);
    }
  });
}

function closeTriggerEditDrawer() {
  const ctx = _triggerEdit;
  if (!ctx) return;
  document.removeEventListener('keydown', ctx.onKeydown);
  try { ctx.backdrop.remove(); } catch {}
  _triggerEdit = null;
}

function triggerEditMode(root, fallback) {
  return root.querySelector('#trig-edit-mode')?.value || fallback || 'agent';
}

async function syncTriggerOptionFields(ctx, values) {
  const modelSelect = ctx.backdrop.querySelector('#trig-edit-model');
  const effortSelect = ctx.backdrop.querySelector('#trig-edit-effort');
  const currentModel = values.model || '';
  const currentEffort = values.effort || '';
  const baseagent = values.baseagent || ctx.original.baseagent || 'claude';
  const token = (ctx.optionLoadToken || 0) + 1;
  ctx.optionLoadToken = token;

  setAgentSelectLoading(modelSelect, currentModel, currentModel ? `${currentModel} (${t('common.loadingSuffix')})` : t('common.loading'));
  setAgentSelectLoading(effortSelect, currentEffort, currentEffort ? `${currentEffort} (${t('common.loadingSuffix')})` : t('common.loading'));

  try {
    const models = await agentFetchOptions('model', ctx.original.agentAid, { baseagent, model: currentModel });
    if (_triggerEdit !== ctx || ctx.optionLoadToken !== token) return;
    modelSelect.innerHTML = agentSelectOptions(models, currentModel, t('common.inherited'));
  } catch (e) {
    if (_triggerEdit === ctx && ctx.optionLoadToken === token) {
      modelSelect.innerHTML = agentSelectOptions([], currentModel, t('common.inherited'));
      toast(e.message || String(e), true);
    }
  } finally {
    if (_triggerEdit === ctx && ctx.optionLoadToken === token) modelSelect.disabled = Boolean(ctx.saving);
  }

  const selectedModel = modelSelect?.value || currentModel;
  await syncTriggerEffortOptions(ctx, baseagent, selectedModel, currentEffort, token);
}

async function syncTriggerEffortOptions(ctx, baseagent, model, currentEffort, token) {
  const effortSelect = ctx.backdrop.querySelector('#trig-edit-effort');
  if (!effortSelect) return;
  setAgentSelectLoading(effortSelect, currentEffort, currentEffort ? `${currentEffort} (${t('common.loadingSuffix')})` : t('common.loading'));
  try {
    let efforts = await agentFetchOptions('effort', ctx.original.agentAid, { baseagent, model, effort: currentEffort || 'auto' });
    if (!efforts.length && AGENT_EFFORT_FALLBACK[baseagent]) efforts = AGENT_EFFORT_FALLBACK[baseagent];
    if (_triggerEdit !== ctx || ctx.optionLoadToken !== token) return;
    effortSelect.innerHTML = agentSelectOptions(efforts, currentEffort, t('common.inherited'));
  } catch (e) {
    if (_triggerEdit === ctx && ctx.optionLoadToken === token) {
      const fallback = AGENT_EFFORT_FALLBACK[baseagent] || [];
      effortSelect.innerHTML = agentSelectOptions(fallback, currentEffort, t('common.inherited'));
      toast(e.message || String(e), true);
    }
  } finally {
    if (_triggerEdit === ctx && ctx.optionLoadToken === token) effortSelect.disabled = Boolean(ctx.saving);
  }
}

function syncTriggerEditFields(ctx) {
  const root = ctx.backdrop;
  const type = root.querySelector('#trig-edit-schedule-type')?.value || ctx.original.scheduleType;
  const typeSelect = root.querySelector('#trig-edit-schedule-type');
  const valueInput = root.querySelector('#trig-edit-schedule-value');
  const valueLabel = root.querySelector('#trig-edit-schedule-value-label');
  const eventFields = root.querySelectorAll('.trig-event-field');
  const strategy = root.querySelector('#trig-edit-session-strategy')?.value || ctx.original.targetSessionStrategy;
  const threadField = root.querySelector('#trig-edit-thread-field');
  const threadInput = root.querySelector('#trig-edit-thread');
  const mode = triggerEditMode(root, ctx.original.mode);
  const promptLabel = root.querySelector('#trig-edit-prompt-label');

  if (typeSelect) typeSelect.disabled = Boolean(ctx.saving);
  if (valueLabel) valueLabel.textContent = type === 'event' ? t('triggers.field.eventPattern') : t('triggers.field.scheduleExpression');
  if (valueInput) {
    const previousType = valueInput.dataset.scheduleType || '';
    valueInput.disabled = Boolean(ctx.saving);
    valueInput.removeAttribute('min');
    valueInput.removeAttribute('step');
    valueInput.removeAttribute('inputmode');
    valueInput.removeAttribute('list');
    if (triggerIsDurationSchedule(type)) {
      const currentValue = triggerIsDurationSchedule(previousType)
        ? valueInput.value
        : (previousType ? '' : ctx.original.scheduleValue);
      valueInput.type = 'text';
      valueInput.value = triggerScheduleDurationInputValue(currentValue);
    } else if (type === 'at') {
      const currentValue = previousType === 'at'
        ? valueInput.value
        : (triggerIsDurationSchedule(previousType) ? '' : triggerAtInputValue(valueInput.value));
      valueInput.type = 'datetime-local';
      valueInput.step = '1';
      valueInput.value = currentValue;
    } else {
      const currentValue = previousType === 'at'
        ? triggerAtScheduleValue(valueInput.value)
        : (triggerIsDurationSchedule(previousType) ? '' : valueInput.value);
      valueInput.type = 'text';
      valueInput.value = currentValue;
      if (type === 'event') valueInput.setAttribute('list', 'trig-event-pattern-list');
    }
    valueInput.dataset.scheduleType = type;
    const placeholders = {
      delay: t('triggers.placeholder.scheduleDuration'),
      interval: t('triggers.placeholder.scheduleDuration'),
      at: '2026-06-30T15:30:00',
      cron: '30 15 * * *',
      event: 'message:*',
    };
    valueInput.placeholder = placeholders[type] || '';
  }
  eventFields.forEach(el => { el.hidden = type !== 'event'; });
  if (type === 'event') triggerRefreshEventDatalists(ctx);
  if (threadField) threadField.hidden = strategy !== 'thread';
  if (threadInput) threadInput.disabled = strategy !== 'thread';
  root.querySelectorAll('.trig-agent-field').forEach(el => { el.hidden = mode !== 'agent'; });
  root.querySelectorAll('.trig-script-field').forEach(el => { el.hidden = mode !== 'script'; });
  if (promptLabel) promptLabel.textContent = mode === 'script' ? t('triggers.field.outputTemplate') : t('triggers.field.prompt');
  ['reply', 'noop', 'failure'].forEach(key => {
    const checkbox = root.querySelector(`#trig-edit-feedback-${key}-enabled`);
    const select = root.querySelector(`#trig-edit-feedback-${key}`);
    const delivery = root.querySelector(`#trig-edit-feedback-${key}-delivery`);
    const row = root.querySelector(`[data-feedback-row="${key}"]`);
    const enabled = Boolean(checkbox?.checked);
    if (select) select.disabled = ctx.saving || !enabled;
    if (delivery) delivery.disabled = ctx.saving || !enabled;
    if (row) row.classList.toggle('is-off', !enabled);
  });
}

function readTriggerEditValues(root) {
  const scheduleType = root.querySelector('#trig-edit-schedule-type')?.value || '';
  const scheduleInput = root.querySelector('#trig-edit-schedule-value');
  const scheduleRawValue = (scheduleInput?.value || '').trim();
  const scheduleValue = triggerIsDurationSchedule(scheduleType)
    ? scheduleRawValue.toLowerCase()
    : (scheduleType === 'at' ? triggerAtScheduleValue(scheduleRawValue) : scheduleRawValue);
  return {
    name: (root.querySelector('#trig-edit-name')?.value || '').trim(),
    scheduleType,
    scheduleValue,
    mode: root.querySelector('#trig-edit-mode')?.value || 'agent',
    prompt: root.querySelector('#trig-edit-prompt')?.value || '',
    scriptPath: (root.querySelector('#trig-edit-script-path')?.value || '').trim(),
    scriptRuntime: root.querySelector('#trig-edit-script-runtime')?.value || '',
    model: (root.querySelector('#trig-edit-model')?.value || '').trim(),
    effort: root.querySelector('#trig-edit-effort')?.value || '',
    permissionMode: root.querySelector('#trig-edit-permission')?.value || '',
    targetChannel: (root.querySelector('#trig-edit-channel')?.value || '').trim(),
    targetChannelId: (root.querySelector('#trig-edit-channel-id')?.value || '').trim(),
    targetSessionStrategy: root.querySelector('#trig-edit-session-strategy')?.value || 'latest',
    targetThreadId: (root.querySelector('#trig-edit-thread')?.value || '').trim(),
    feedbackOnReply: triggerReadFeedbackKind(root, 'reply', 'forward'),
    feedbackOnReplyDelivery: triggerReadFeedbackDelivery(root, 'reply', 'direct'),
    feedbackOnNoop: triggerReadFeedbackKind(root, 'noop', 'forward'),
    feedbackOnNoopDelivery: triggerReadFeedbackDelivery(root, 'noop', 'direct'),
    feedbackOnFailure: triggerReadFeedbackKind(root, 'failure', 'forward'),
    feedbackOnFailureDelivery: triggerReadFeedbackDelivery(root, 'failure', 'direct'),
    maxRuns: (root.querySelector('#trig-edit-max-runs')?.value || '').trim(),
    maxDuration: (root.querySelector('#trig-edit-max-duration')?.value || '').trim().toLowerCase(),
    concurrency: root.querySelector('#trig-edit-concurrency')?.value || 'forbid',
    missedPolicy: root.querySelector('#trig-edit-missed-policy')?.value || 'run_once',
  };
}

function validateTriggerSchedule(type, value) {
  if (!['delay', 'at', 'cron', 'interval', 'event'].includes(type)) return tf('triggers.error.invalidScheduleType', { type });
  if (!value) return t('triggers.error.emptySchedule');
  if (type === 'delay' || type === 'interval') {
    if (!triggerDurationValueValid(value, TRIGGER_SCHEDULE_DURATION_FORMAT)) {
      return tf('triggers.error.scheduleDurationFormat', { type: triggerScheduleLabel(type) });
    }
  }
  if (type === 'at' && !Number.isFinite(new Date(value).getTime())) return t('triggers.error.invalidAt');
  if (type === 'event' && !triggerEventPatternValueValid(value)) return t('triggers.error.invalidEventPattern');
  return null;
}

function collectTriggerEditPatch(ctx) {
  const values = readTriggerEditValues(ctx.backdrop);
  const original = ctx.original;
  const patch = { nameOrId: original.id };

  if (!values.name) return { error: t('triggers.error.nameRequired') };
  if (values.name !== original.name) patch.name = values.name;

  const scheduleError = validateTriggerSchedule(values.scheduleType, values.scheduleValue);
  if (scheduleError) return { error: scheduleError };
  const originalScheduleComparable = triggerComparableScheduleValue(original.scheduleType, original.scheduleValue);
  const nextScheduleComparable = triggerComparableScheduleValue(values.scheduleType, values.scheduleValue);
  if (values.scheduleType !== original.scheduleType || nextScheduleComparable !== originalScheduleComparable) {
    patch.scheduleType = values.scheduleType;
    patch.scheduleValue = values.scheduleValue;
  }
  if (values.scheduleType === 'event') {
    const eventFilter = triggerReadEventFilter(ctx);
    if (eventFilter.error) return { error: eventFilter.error };
    if (triggerStableJson(eventFilter.value) !== triggerStableJson(original.eventFilter || null)) {
      patch.eventFilter = eventFilter.value;
    }
  }

  if (values.mode === 'agent' && !values.prompt.trim()) return { error: t('triggers.error.promptRequired') };
  if (values.mode === 'script') {
    if (!values.scriptPath) return { error: t('triggers.error.scriptPathRequired') };
    if (!values.scriptRuntime) return { error: t('triggers.error.scriptRuntimeRequired') };
  }
  if (values.mode !== original.mode) patch.executionMode = values.mode;
  if (values.prompt !== original.prompt) patch.prompt = values.prompt;
  if (values.mode === 'script' && values.mode !== original.mode) {
    patch.scriptPath = values.scriptPath;
    patch.scriptRuntime = values.scriptRuntime;
  } else {
    if (values.scriptPath !== original.scriptPath) patch.scriptPath = values.mode === 'script' ? values.scriptPath : null;
    if (values.scriptRuntime !== original.scriptRuntime) patch.scriptRuntime = values.mode === 'script' ? values.scriptRuntime : null;
  }
  if (values.model !== original.model) patch.model = values.model || null;
  if (values.effort !== original.effort) patch.effort = values.effort || null;
  if (values.permissionMode !== original.permissionMode) patch.permissionMode = values.permissionMode || null;

  const targetChanged = values.targetChannel !== original.targetChannel
    || values.targetChannelId !== original.targetChannelId
    || values.targetSessionStrategy !== original.targetSessionStrategy
    || values.targetThreadId !== original.targetThreadId;
  if (targetChanged) {
    if (!values.targetChannel) return { error: t('triggers.error.channelRequired') };
    if (!values.targetChannelId) return { error: t('triggers.error.channelIdRequired') };
  }
  if (values.targetSessionStrategy === 'thread' && !values.targetThreadId) return { error: t('triggers.error.threadRequired') };
  if (values.targetChannel !== original.targetChannel) patch.targetChannel = values.targetChannel;
  if (values.targetChannelId !== original.targetChannelId) patch.targetChannelId = values.targetChannelId;
  if (values.targetSessionStrategy !== original.targetSessionStrategy) patch.targetSessionStrategy = values.targetSessionStrategy;
  if (values.targetThreadId !== original.targetThreadId) {
    patch.targetThreadId = values.targetThreadId || '';
    if (values.targetSessionStrategy === 'thread') patch.targetSessionStrategy = 'thread';
  }
  if (values.targetSessionStrategy !== 'thread' && original.targetThreadId) patch.targetThreadId = '';

  const feedbackPatch = {};
  const addFeedbackPatch = (branch, kind, delivery, originalKind, originalDelivery) => {
    if (kind === originalKind && (kind === 'silent' || delivery === originalDelivery)) return;
    feedbackPatch[branch] = kind === 'silent' ? { kind } : { kind, delivery };
  };
  addFeedbackPatch('onReply', values.feedbackOnReply, values.feedbackOnReplyDelivery, original.feedbackOnReply, original.feedbackOnReplyDelivery);
  addFeedbackPatch('onNoop', values.feedbackOnNoop, values.feedbackOnNoopDelivery, original.feedbackOnNoop, original.feedbackOnNoopDelivery);
  addFeedbackPatch('onFailure', values.feedbackOnFailure, values.feedbackOnFailureDelivery, original.feedbackOnFailure, original.feedbackOnFailureDelivery);
  if (Object.keys(feedbackPatch).length > 0) patch.feedback = feedbackPatch;

  if (values.maxRuns) {
    if (!/^[1-9]\d*$/.test(values.maxRuns)) return { error: t('triggers.error.maxRunsPositive') };
    if (values.maxRuns !== original.maxRuns) patch.maxRuns = Number(values.maxRuns);
  } else if (original.maxRuns) {
    patch.maxRuns = null;
  }
  if (values.maxDuration) {
    if (!triggerDurationValueValid(values.maxDuration, TRIGGER_MAX_DURATION_FORMAT)) return { error: t('triggers.error.maxDurationFormat') };
    if (values.maxDuration !== original.maxDuration) patch.maxDuration = values.maxDuration;
  } else if (original.maxDuration) {
    patch.maxDuration = null;
  }
  if (values.concurrency !== original.concurrency) patch.concurrency = values.concurrency;
  if (values.missedPolicy !== original.missedPolicy) patch.missedPolicy = values.missedPolicy;

  return {
    patch,
    changed: Object.keys(patch).length > 1,
  };
}

function setTriggerEditSaving(ctx, saving) {
  ctx.saving = saving;
  ctx.backdrop.querySelectorAll('button, input, textarea, select').forEach(el => { el.disabled = saving; });
  const save = ctx.backdrop.querySelector('#trig-edit-save');
  if (save) save.textContent = saving ? t('common.saving') : t('common.save');
  if (!saving) syncTriggerEditFields(ctx);
}

async function saveTriggerEditDrawer(ctx) {
  const collected = collectTriggerEditPatch(ctx);
  if (collected.error) { toast(collected.error, true); return; }
  if (!collected.changed) { toast(t('common.noChanges')); return; }
  setTriggerEditSaving(ctx, true);
  try {
    const r = mResp(await menuSend({
      type: 'menu.update',
      name: 'trigger',
      value: JSON.stringify(collected.patch),
      agent: ctx.original.agentAid,
      timeoutMs: 10000,
    }));
    if (r.error) throw new Error(r.error.message || r.error.code);
    closeTriggerEditDrawer();
    toast(t('triggers.saved'));
    triggerRefresh();
  } catch (e) {
    toast(e.message || String(e), true);
    if (_triggerEdit === ctx) setTriggerEditSaving(ctx, false);
  }
}

function openTriggerEditDrawer(id, agent) {
  const item = findTriggerItem(id, agent);
  if (!item) { toast(t('triggers.error.notFound'), true); return; }
  closeTriggerEditDrawer();
  const original = triggerOriginalEditState(item);
  const scheduleTypeOptions = triggerOptionHtml(TRIGGER_SCHEDULE_TYPES, original.scheduleType, null);
  const filterRows = triggerFilterRowsFromMatch(original.eventFilter?.match);
  const jsonText = esc(JSON.stringify(original.rawPreview, null, 2));
  const subtitleName = original.name || id;
  const feedbackRows = [
    triggerFeedbackRowHtml('reply', t('triggers.field.feedbackOnReply'), original.feedbackOnReply, original.feedbackOnReplyDelivery, 'forward'),
    triggerFeedbackRowHtml('noop', t('triggers.field.feedbackOnNoop'), original.feedbackOnNoop, original.feedbackOnNoopDelivery, 'forward'),
    triggerFeedbackRowHtml('failure', t('triggers.field.feedbackOnFailure'), original.feedbackOnFailure, original.feedbackOnFailureDelivery, 'forward'),
  ].join('');
  const scriptPreviewHtml = triggerScriptPreviewHtml(original.scriptPreview);

  const html = `<div class="ag-edit-backdrop" id="trig-edit-backdrop">` +
    `<aside class="ag-edit-drawer trig-edit-drawer" role="dialog" aria-modal="true" aria-labelledby="trig-edit-title">` +
      `<header class="ag-edit-head">` +
        `<div class="ag-edit-title-wrap">` +
          `<div id="trig-edit-title" class="ag-edit-title">${t('triggers.editTitle')}</div>` +
          `<div class="ag-edit-subtitle"><span>${esc(subtitleName)}</span><code>${esc(id)}</code><code>${esc(original.agentAid || '—')}</code></div>` +
        `</div>` +
        `<button class="ag-edit-close" id="trig-edit-close" type="button" aria-label="${t('common.close')}">×</button>` +
      `</header>` +
      `<div class="ag-edit-body">` +
        `<section class="ag-edit-section">` +
          `<h3>${t('triggers.section.basic')}</h3>` +
          `<div class="ag-edit-grid trig-edit-grid">` +
            `<label class="ag-edit-field"><span>${t('triggers.field.name')}</span><input id="trig-edit-name" type="text" autocomplete="off" value="${esc(original.name)}"></label>` +
            `<label class="ag-edit-field"><span>${t('triggers.field.scheduleType')}</span><select id="trig-edit-schedule-type">${scheduleTypeOptions}</select></label>` +
            `<label class="ag-edit-field"><span id="trig-edit-schedule-value-label">${original.scheduleType === 'event' ? t('triggers.field.eventPattern') : t('triggers.field.scheduleExpression')}</span><input id="trig-edit-schedule-value" type="text" autocomplete="off" spellcheck="false" value="${esc(original.scheduleValue)}"><datalist id="trig-event-pattern-list"></datalist></label>` +
          `</div>` +
          `<div class="trig-event-field trig-filter-box">` +
            `<div class="trig-filter-head">` +
              `<span>${t('triggers.field.eventFilter')}</span>` +
              `<div class="trig-filter-actions">` +
                `<button class="ctrl-btn" id="trig-filter-add" type="button">${t('triggers.filter.add')}</button>` +
                `<button class="ctrl-btn" id="trig-filter-clear" type="button">${t('triggers.filter.clear')}</button>` +
              `</div>` +
            `</div>` +
            `<datalist id="trig-event-field-list"></datalist>` +
            `<div id="trig-filter-list" class="trig-filter-list"></div>` +
            `<details class="trig-filter-json">` +
              `<summary>${t('common.rawJsonPreview')}</summary>` +
              `<textarea id="trig-filter-json-preview" readonly spellcheck="false"></textarea>` +
            `</details>` +
          `</div>` +
        `</section>` +
        `<section class="ag-edit-section">` +
          `<h3>${t('triggers.section.execution')}</h3>` +
          `<div class="ag-edit-grid trig-edit-grid trig-exec-grid">` +
            `<label class="ag-edit-field"><span>${t('triggers.field.executionType')}</span><select id="trig-edit-mode">${triggerOptionHtml(TRIGGER_EXECUTION_MODES, original.mode, null)}</select></label>` +
            `<label class="ag-edit-field trig-agent-field"><span>${t('triggers.field.model')}</span><select id="trig-edit-model">${agentSelectOptions([], original.model, t('common.inherited'))}</select></label>` +
            `<label class="ag-edit-field trig-agent-field"><span>${t('triggers.field.effort')}</span><select id="trig-edit-effort">${agentSelectOptions([], original.effort, t('common.inherited'))}</select></label>` +
            `<label class="ag-edit-field trig-agent-field"><span>${t('triggers.field.permission')}</span><select id="trig-edit-permission">${triggerOptionHtml(TRIGGER_PERMISSION_MODES, original.permissionMode, t('common.inherited'))}</select></label>` +
            `<label class="ag-edit-field trig-script-field"><span>${t('triggers.field.scriptRuntime')}</span><select id="trig-edit-script-runtime">${triggerOptionHtml(['node', 'python', 'bash'], original.scriptRuntime, null)}</select></label>` +
            `<label class="ag-edit-field trig-script-field trig-script-path-field"><span>${t('triggers.field.scriptPath')}</span><input id="trig-edit-script-path" type="text" autocomplete="off" spellcheck="false" value="${esc(original.scriptPath)}" placeholder="${t('triggers.placeholder.scriptPath')}"></label>` +
          `</div>` +
          scriptPreviewHtml +
          `<label class="ag-edit-field"><span id="trig-edit-prompt-label">${original.mode === 'script' ? t('triggers.field.outputTemplate') : t('triggers.field.prompt')}</span><textarea id="trig-edit-prompt" rows="6" spellcheck="false">${esc(original.prompt)}</textarea></label>` +
        `</section>` +
        `<section class="ag-edit-section">` +
          `<h3>${t('triggers.section.target')}</h3>` +
          `<div class="ag-edit-grid trig-edit-grid">` +
            `<label class="ag-edit-field"><span>${t('triggers.field.targetChannel')}</span><input id="trig-edit-channel" type="text" autocomplete="off" spellcheck="false" value="${esc(original.targetChannel)}"></label>` +
            `<label class="ag-edit-field"><span>${t('triggers.field.channelId')}</span><input id="trig-edit-channel-id" type="text" autocomplete="off" spellcheck="false" value="${esc(original.targetChannelId)}"></label>` +
            `<label class="ag-edit-field"><span>${t('triggers.field.sessionStrategy')}</span><select id="trig-edit-session-strategy">${triggerOptionHtml(TRIGGER_SESSION_STRATEGIES, original.targetSessionStrategy, null)}</select></label>` +
            `<label id="trig-edit-thread-field" class="ag-edit-field ag-edit-field-wide"><span>${t('triggers.field.threadId')}</span><input id="trig-edit-thread" type="text" autocomplete="off" spellcheck="false" value="${esc(original.targetThreadId)}"></label>` +
          `</div>` +
          `<div class="ag-edit-grid trig-edit-grid trig-feedback-list">${feedbackRows}</div>` +
        `</section>` +
        `<section class="ag-edit-section">` +
          `<h3>${t('triggers.section.limits')}</h3>` +
          `<div class="ag-edit-grid trig-edit-grid trig-limit-grid">` +
            `<label class="ag-edit-field"><span>${t('triggers.field.maxRuns')}</span><input id="trig-edit-max-runs" type="number" min="1" step="1" value="${esc(original.maxRuns)}" placeholder="${t('common.noLimit')}"></label>` +
            `<label class="ag-edit-field"><span>${t('triggers.field.maxDuration')}</span><input id="trig-edit-max-duration" type="text" autocomplete="off" spellcheck="false" value="${esc(original.maxDuration)}" placeholder="${t('triggers.placeholder.maxDuration')}"></label>` +
            `<label class="ag-edit-field"><span>${t('triggers.field.concurrency')}</span><select id="trig-edit-concurrency">${triggerOptionHtml(TRIGGER_CONCURRENCY_OPTIONS, original.concurrency, null)}</select></label>` +
            `<label class="ag-edit-field"><span>${t('triggers.field.missedPolicy')}</span><select id="trig-edit-missed-policy">${triggerOptionHtml(TRIGGER_MISSED_POLICY_OPTIONS, original.missedPolicy, null)}</select></label>` +
          `</div>` +
        `</section>` +
        `<section class="ag-edit-section ag-edit-section-json">` +
          `<details>` +
            `<summary>${t('common.rawJsonPreview')}</summary>` +
            `<textarea class="ag-edit-json" readonly spellcheck="false">${jsonText}</textarea>` +
          `</details>` +
        `</section>` +
      `</div>` +
      `<footer class="ag-edit-actions">` +
        `<button class="ctrl-btn" id="trig-edit-cancel" type="button">${t('common.cancel')}</button>` +
        `<button class="ctrl-btn primary" id="trig-edit-save" type="button">${t('common.save')}</button>` +
      `</footer>` +
    `</aside>` +
  `</div>`;

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const backdrop = wrap.firstChild;
  document.body.appendChild(backdrop);

  const ctx = {
    original,
    backdrop,
    onKeydown: (e) => { if (e.key === 'Escape') closeTriggerEditDrawer(); },
  };
  _triggerEdit = ctx;

  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeTriggerEditDrawer(); });
  backdrop.querySelector('#trig-edit-close').addEventListener('click', closeTriggerEditDrawer);
  backdrop.querySelector('#trig-edit-cancel').addEventListener('click', closeTriggerEditDrawer);
  backdrop.querySelector('#trig-edit-save').addEventListener('click', () => saveTriggerEditDrawer(ctx));
  backdrop.querySelector('#trig-edit-schedule-type').addEventListener('change', () => syncTriggerEditFields(ctx));
  backdrop.querySelector('#trig-edit-schedule-value').addEventListener('input', () => {
    triggerRefreshEventDatalists(ctx);
    triggerUpdateFilterJsonPreview(ctx);
  });
  backdrop.querySelector('#trig-edit-mode').addEventListener('change', () => syncTriggerEditFields(ctx));
  backdrop.querySelector('#trig-edit-model').addEventListener('change', () => {
    const token = (ctx.optionLoadToken || 0) + 1;
    ctx.optionLoadToken = token;
    syncTriggerEffortOptions(ctx, ctx.original.baseagent || 'claude', backdrop.querySelector('#trig-edit-model')?.value || '', backdrop.querySelector('#trig-edit-effort')?.value || '', token);
  });
  backdrop.querySelector('#trig-edit-session-strategy').addEventListener('change', () => {
    const strategy = backdrop.querySelector('#trig-edit-session-strategy')?.value;
    if (strategy !== 'thread') {
      const thread = backdrop.querySelector('#trig-edit-thread');
      if (thread) thread.value = '';
    }
    syncTriggerEditFields(ctx);
  });
  ['reply', 'noop', 'failure'].forEach(key => {
    backdrop.querySelector(`#trig-edit-feedback-${key}-enabled`)?.addEventListener('change', () => syncTriggerEditFields(ctx));
  });
  backdrop.querySelector('#trig-filter-add').addEventListener('click', () => {
    triggerRenderFilterRows(ctx, [...triggerFilterRows(ctx), { op: 'eq' }]);
  });
  backdrop.querySelector('#trig-filter-clear').addEventListener('click', () => triggerRenderFilterRows(ctx, []));
  backdrop.querySelector('#trig-filter-list').addEventListener('input', () => triggerUpdateFilterJsonPreview(ctx));
  backdrop.querySelector('#trig-filter-list').addEventListener('change', () => triggerUpdateFilterJsonPreview(ctx));
  backdrop.querySelector('#trig-filter-list').addEventListener('click', e => {
    if (!e.target.closest('.trig-filter-remove')) return;
    e.target.closest('.trig-filter-row')?.remove();
    if (!backdrop.querySelector('.trig-filter-row')) triggerRenderFilterRows(ctx, []);
    else triggerUpdateFilterJsonPreview(ctx);
  });
  document.addEventListener('keydown', ctx.onKeydown);
  triggerRenderFilterRows(ctx, filterRows);
  syncTriggerEditFields(ctx);
  triggerEnsureEventCatalog(ctx).catch(e => {
    if (_triggerEdit === ctx) toast(e.message || String(e), true);
  });
  syncTriggerOptionFields(ctx, original);
  setTimeout(() => backdrop.querySelector('#trig-edit-name')?.focus(), 0);
}

function renderTriggers(data) {
  if (!data) { $('#view-triggers').innerHTML = `<div class="empty">${t('common.loading')}</div>`; return; }
  const agents = data.agents || [];
  const triggers = data.triggers || [];
  const selAid = data.selectedAgent || null;

  // 左列：agent 列表（仿 msg list-item 风格）
  let aHtml = '<div class="col-title trig-title">' +
    '<span>Agent</span>' +
    `<button id="trig-agents-toggle" class="trig-collapse-btn" title="${trigAgentsCollapsed ? t('triggers.collapse.expand') : t('triggers.collapse.collapse')}">${trigAgentsCollapsed ? '›' : '‹'}</button>` +
    '</div>';
  if (!trigAgentsCollapsed) {
    if (!agents.length) aHtml += `<div class="empty">${t('triggers.empty.noAgents')}</div>`;
    for (const ag of agents) {
      const sel = ag.value === selAid ? ' sel' : '';
      aHtml += `<div class="list-item${sel}" data-aid="${esc(ag.value)}">` +
        `<div class="name">${esc(ag.label)}</div>` +
        `<div class="sub">${esc(ag.value)}</div></div>`;
    }
  }
  const agentCol = $('#trig-agents');
  agentCol.classList.toggle('collapsed', trigAgentsCollapsed);
  agentCol.innerHTML = aHtml;
  const collapseBtn = $('#trig-agents-toggle');
  if (collapseBtn) collapseBtn.onclick = (e) => {
    e.stopPropagation();
    trigAgentsCollapsed = !trigAgentsCollapsed;
    renderTriggers(data);
  };
  agentCol.onclick = (e) => {
    if (e.target.closest('.list-item')) return;
    if (e.target.closest('.col-title, .empty')) return;
    if (trigAgentsCollapsed) return;
    if (!trigSel.agent) return;
    trigSel.agent = null;
    subscribe('triggers', {});
  };
  agentCol.querySelectorAll('.list-item').forEach(item => {
    item.onclick = () => {
      trigSel.agent = item.dataset.aid;
      subscribe('triggers', { agent: trigSel.agent });
    };
  });

  // 右列：table，每字段一列
  const el = $('#trig-table');
  if (!triggers.length) {
    el.innerHTML = `<div class="empty" style="padding:16px">${selAid ? t('triggers.empty.noAgentTriggers') : t('triggers.empty.noTriggers')}</div>`;
    return;
  }

  let html = '<table><thead><tr>' +
    `<th>Agent</th><th>${t('triggers.th.status')}</th><th>${t('triggers.th.subscription')}</th><th>${t('triggers.th.name')}</th><th>ID</th><th>${t('triggers.th.type')}</th><th>${t('triggers.th.expression')}</th>` +
    `<th>${t('triggers.th.lastFire')}</th><th>${t('triggers.th.nextFire')}</th><th>${t('triggers.th.fireCount')}</th><th>${t('triggers.th.failCount')}</th><th>${t('triggers.th.lastResult')}</th><th>${t('triggers.field.sessionStrategy')}</th>` +
    `<th>${t('triggers.th.targetChannel')}</th><th>${t('triggers.field.channelId')}</th><th>${t('triggers.th.channelType')}</th>` +
    `<th>${t('triggers.th.createdBy')}</th><th>${t('triggers.th.createdChannel')}</th><th>${t('triggers.th.createdAt')}</th><th>${t('triggers.th.operations')}</th>` +
    '</tr></thead><tbody>';
  for (const trigger of triggers) {
    const active = triggerIsEnabled(trigger);
    const status = trigger.status || (active ? 'active' : 'disabled');
    const lastFireTime = trigger.lastFiredAt || trigger.lastScheduledAt;
    const lastResult = trigger.lastResult || (trigger.lastScheduledAt ? t('triggers.lastUnrecorded') : '');
    const agentAid = trigger.agentAid || trigger.schedulerAid || selAid || '';
    const agentLabel = trigger.agentLabel || (agentAid ? shortAid(agentAid) : '');
    const sourceType = triggerSourceType(trigger);
    html += `<tr class="${active ? '' : 'trig-disabled'}">` +
      `<td title="${esc(agentAid)}">${esc(agentLabel)}</td>` +
      `<td>${trigStatusBadge(status)}</td>` +
      `<td>${trigSubscriptionBadge(trigger.subscription, sourceType)}</td>` +
      `<td>${esc(trigger.name ?? trigger.label ?? '')}</td>` +
      `<td>${esc(trigger.id ?? trigger.value ?? '')}</td>` +
      `<td>${esc(triggerScheduleLabel(sourceType || trigger.scheduleType || ''))}</td>` +
      `<td>${esc(triggerScheduleValueLabel(trigger.scheduleType, trigger.scheduleValue))}</td>` +
      `<td>${lastFireTime ? fmtTime(lastFireTime) : '—'}</td>` +
      `<td>${trigger.nextFireAt ? fmtTime(trigger.nextFireAt) : '—'}</td>` +
      `<td>${trigger.fireCount ?? 0}</td>` +
      `<td>${trigger.failCount ? `<span style="color:var(--red)">${trigger.failCount}</span>` : '0'}</td>` +
      `<td>${lastResult ? esc(lastResult) : '—'}</td>` +
      `<td>${esc(triggerSessionStrategyLabel(trigger.targetSessionStrategy ?? ''))}</td>` +
      `<td>${esc(trigger.targetChannel ?? '')}</td>` +
      `<td>${esc(trigger.targetChannelId ?? '')}</td>` +
      `<td>${esc(trigger.targetChannelType ?? '')}</td>` +
      `<td>${esc(trigger.createdByPeerId ?? '')}</td>` +
      `<td>${esc(trigger.createdByChannel ?? '')}</td>` +
      `<td>${trigger.createdAt ? fmtTime(trigger.createdAt) : '—'}</td>` +
      `<td>${triggerOpsHtml(trigger)}</td>` +
      '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
  ensureOpsOutsideClose();

  el.querySelectorAll('.trig-ops button[data-trig-op]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const op = btn.dataset.trigOp;
      if (op === 'more') {
        const more = btn.closest('.ops-more');
        const wasOpen = more?.classList.contains('open');
        document.querySelectorAll('.ops-more.open').forEach(m => m.classList.remove('open'));
        if (more && !wasOpen) more.classList.add('open');
        e.stopPropagation();
        return;
      }
      const box = btn.closest('.trig-ops');
      const id = box?.dataset.trigid || '';
      const agent = box?.dataset.agent || trigSel.agent || '';
      btn.closest('.ops-more.open')?.classList.remove('open');
      if (op === 'edit') openTriggerEditDrawer(id, agent);
      else await triggerRunAction(op, id, agent);
    });
  });
}


function startApp() {
  initTabs();
  initRolesTab();
  initRoleDefinitionsTab();
  // 恢复保存的 tab 视图
  switchView(currentView);
  connect();
  $('#logout-btn').onclick = () => {
    localStorage.removeItem(TOKEN_KEY);
    showPairPage(t('pair.loggedOut'));
  };
}

// ── 主题切换 ──
let themePreference = 'light';
let themeMediaBound = false;
const themeMedia = window.matchMedia ? window.matchMedia(SYSTEM_THEME_QUERY) : null;

function normalizeThemePreference(value) {
  if (value === 'auto') return 'system';
  return THEME_MODES.includes(value) ? value : 'light';
}

function getSystemTheme() {
  return themeMedia && themeMedia.matches ? 'dark' : 'light';
}

function resolveTheme(preference) {
  return preference === 'system' ? getSystemTheme() : preference;
}

function updateThemeButton() {
  const btn = $('#theme-btn');
  if (!btn) return;
  const icons = { light: '☀️', dark: '🌙', system: '🖥️' };
  const label = t('theme.buttonTitle').replace('{mode}', t('theme.' + themePreference));
  btn.textContent = icons[themePreference] || icons.light;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.dataset.themeMode = themePreference;
}

function disposeWindowChart(key) {
  const chart = window[key];
  if (chart && typeof chart.dispose === 'function') {
    chart.dispose();
    window[key] = null;
  }
}

function refreshThemeSensitiveViews() {
  ['_hourlyChart', '_modelChart', '_monCpu', '_monMem', '_monMsg', '_monErr'].forEach(disposeWindowChart);
  if (typeof _explorerChart !== 'undefined' && _explorerChart) {
    _explorerChart.dispose();
    _explorerChart = null;
  }
  if (currentView === 'monitor') renderMonitor(state.monitor);
  const explorer = $('#usage-explorer');
  if (currentView === 'usage' && explorer && explorer.classList.contains('active')) {
    runExplorerQuery();
  }
}

function applyThemePreference(preference, options) {
  const opts = options || {};
  const previousTheme = document.documentElement.getAttribute('data-theme');
  themePreference = normalizeThemePreference(preference);
  const theme = resolveTheme(themePreference);

  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-theme-pref', themePreference);
  if (opts.persist !== false) localStorage.setItem(THEME_KEY, themePreference);
  updateThemeButton();

  if (opts.refresh !== false && previousTheme && previousTheme !== theme) {
    refreshThemeSensitiveViews();
  }
}

function initTheme() {
  themePreference = normalizeThemePreference(localStorage.getItem(THEME_KEY) || 'light');
  applyThemePreference(themePreference, { refresh: false });

  const btn = $('#theme-btn');
  if (btn) {
    btn.onclick = () => {
      const next = THEME_MODES[(THEME_MODES.indexOf(themePreference) + 1) % THEME_MODES.length];
      applyThemePreference(next);
    };
  }

  if (themeMedia && !themeMediaBound) {
    const onSystemThemeChange = () => {
      if (themePreference === 'system') applyThemePreference('system', { persist: false });
    };
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', onSystemThemeChange);
    else if (themeMedia.addListener) themeMedia.addListener(onSystemThemeChange);
    themeMediaBound = true;
  }
}

// ── Usage 相关函数 ──
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// ── Usage Overview（总览，支持日期范围筛选）──
let _ovCurrentRange = 'today'; // 当前选择的范围

async function loadUsageOverview(rangeType, customFrom, customTo) {
  rangeType = rangeType || _ovCurrentRange;
  _ovCurrentRange = rangeType;

  // 计算日期范围
  let fromTs, toTs;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

  switch (rangeType) {
    case 'today':
      fromTs = todayStart;
      toTs = todayEnd;
      break;
    case 'week': // 本周（周一到今天）
      const dayOfWeek = now.getDay() || 7; // 周日=7
      const weekStart = new Date(todayStart - (dayOfWeek - 1) * 86400000);
      fromTs = weekStart.getTime();
      toTs = todayEnd;
      break;
    case 'lastWeek': // 上周（上周一到上周日）
      const lastWeekEnd = new Date(todayStart - now.getDay() * 86400000);
      const lastWeekStart = new Date(lastWeekEnd.getTime() - 6 * 86400000);
      fromTs = lastWeekStart.getTime();
      toTs = new Date(lastWeekEnd.getTime() + 86400000 - 1).getTime();
      break;
    case 'month': // 本月
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      fromTs = monthStart.getTime();
      toTs = todayEnd;
      break;
    case 'last30': // 最近30天
      fromTs = todayStart - 29 * 86400000;
      toTs = todayEnd;
      break;
    case 'custom': // 自定义
      if (customFrom && customTo) {
        // 支持 datetime-local 输入，直接解析时间戳
        fromTs = new Date(customFrom).getTime();
        toTs = new Date(customTo).getTime();
      } else {
        fromTs = todayStart;
        toTs = todayEnd;
      }
      break;
    default:
      fromTs = null;
      toTs = null;
  }

  // 保存当前时间范围到全局变量，供详细统计使用
  window._currentOverviewTimeRange = { fromTs, toTs, rangeType, customFrom, customTo };

  // 时间范围变化后，刷新明细的模型列表与查询结果（重置到第一页）
  if ($('#detail-model')) {
    const detailPageEl = $('#detail-page');
    if (detailPageEl) detailPageEl.value = '1';
    loadDetailModelList();
    queryDetailUsage();
  }

  let data;
  try {
    const params = new URLSearchParams();
    if (fromTs) params.set('from', String(fromTs));
    if (toTs) params.set('to', String(toTs));

    const resp = await fetch(apiUrl('api/stats/overview?' + params.toString()), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    data = resp.ok ? await resp.json() : null;
  } catch { data = null; }

  const ts = (data && data.token_stats && data.token_stats.all_time) ? data.token_stats.all_time
    : { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, call_count: 0, cost_official_usd: 0, cost_official_cny: 0, cost_usd: 0, cost_cny: 0 };
  const sessionCount = (data && data.session_count) || 0;
  const msgIn = (data && data.msg_in) || 0;
  const msgOut = (data && data.msg_out) || 0;
  // 新的缓存命中率计算规则：缓存命中 / (缓存命中 + 缓存写入 + 输入token + 输出token)
  const totalTokens = ts.cache_read_tokens + ts.cache_creation_tokens + ts.input_tokens + ts.output_tokens;
  const hitRate = totalTokens > 0 ? (ts.cache_read_tokens / totalTokens) * 100 : 0;

  const cardsEl = $('#ov-cards');
  if (cardsEl) {
    // 合并相关信息到大卡片中
    const sessionCard = makeMultiValueCard([
      { label: t('usage.card.sessionCount'), value: sessionCount },
      { label: t('usage.card.msgIn'), value: msgIn },
      { label: t('usage.card.msgOut'), value: msgOut }
    ], t('usage.card.sessionInfo'), 'session-group');

    const usageCard = makeMultiValueCard([
      { label: t('usage.card.modelCalls'), value: ts.call_count },
      { label: t('usage.card.inputTokens'), value: fmtTokens(ts.input_tokens) },
      { label: t('usage.card.outputTokens'), value: fmtTokens(ts.output_tokens) },
      { label: t('usage.card.cacheCreation'), value: fmtTokens(ts.cache_creation_tokens) },
      { label: t('usage.card.cacheHitTokens'), value: fmtTokens(ts.cache_read_tokens) },
      { label: t('usage.card.cacheHitRate'), value: hitRate.toFixed(1) + '%' }
    ], t('usage.card.usageInfo'), 'usage-group');

    const costCard = makeMultiValueCard([
      { label: t('usage.card.costOfficial'), value: fmtCost(ts.cost_official_usd, ts.cost_official_cny) },
      { label: t('usage.card.costGateway'), value: fmtCost(ts.cost_usd, ts.cost_cny) }
    ], t('usage.card.costInfo'), 'cost-group');

    cardsEl.innerHTML = sessionCard + usageCard + costCard;
  }

  const agentTbl = $('#ov-agent-table');
  const agents = (data && data.token_stats && data.token_stats.by_agent) || [];
  if (agentTbl) {
    if (!agents.length) {
      agentTbl.innerHTML = '<tbody><tr><td>' + t('usage.overview.noData') + '</td></tr></tbody>';
    } else {
      agentTbl.innerHTML =
        '<thead><tr><th>' + t('usage.overview.th.agent') + '</th><th>' + t('usage.overview.th.calls') + '</th><th>' + t('usage.overview.th.input') + '</th><th>' + t('usage.overview.th.output') + '</th><th>' + t('usage.overview.th.cacheCreation') + '</th><th>' + t('usage.overview.th.cacheHit') + '</th><th>' + t('usage.overview.th.cacheHitRate') + '</th><th>' + t('usage.overview.th.costOfficial') + '</th><th>' + t('usage.overview.th.costGateway') + '</th></tr></thead>' +
        '<tbody>' + agents.map(function(a) {
          var name = a.agent_name || (a.agent_aid ? a.agent_aid.split('.')[0] : '(unknown)');
          // 计算缓存命中率
          var totalTokens = (a.cache_read_tokens || 0) + (a.cache_creation_tokens || 0) + (a.input_tokens || 0) + (a.output_tokens || 0);
          var hitRate = totalTokens > 0 ? ((a.cache_read_tokens || 0) / totalTokens * 100).toFixed(1) : '0.0';

          return '<tr><td title="' + esc(a.agent_aid) + '">' + esc(name) + '</td>' +
            '<td>' + a.call_count + '</td>' +
            '<td>' + fmtTokens(a.input_tokens) + '</td>' +
            '<td>' + fmtTokens(a.output_tokens) + '</td>' +
            '<td>' + fmtTokens(a.cache_creation_tokens) + '</td>' +
            '<td>' + fmtTokens(a.cache_read_tokens) + '</td>' +
            '<td>' + hitRate + '%</td>' +
            '<td>' + fmtCostSplit(a.cost_official_usd, a.cost_official_cny) + '</td>' +
            '<td>' + fmtCostSplit(a.cost_usd, a.cost_cny) + '</td></tr>';
        }).join('') + '</tbody>';
    }
  }

  // 保存总览数据供详细统计使用
  window._currentOverviewData = { ts, sessionCount, msgIn, msgOut, hitRate };
}

function initOverviewFilters() {
  // 范围按钮切换
  document.querySelectorAll('.ov-range-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.ov-range-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');

      const range = btn.getAttribute('data-range');
      const customDateEl = $('#ov-custom-date');

      if (range === 'custom') {
        if (customDateEl) customDateEl.style.display = 'flex';
      } else {
        if (customDateEl) customDateEl.style.display = 'none';
        loadUsageOverview(range);
      }
    });
  });

  // 自定义日期查询按钮
  const queryBtn = $('#ov-query-btn');
  if (queryBtn) {
    queryBtn.addEventListener('click', function() {
      const fromEl = $('#ov-from');
      const toEl = $('#ov-to');
      if (fromEl && toEl && fromEl.value && toEl.value) {
        loadUsageOverview('custom', fromEl.value, toEl.value);
      }
    });
  }

  // 设置默认日期为最近7天
  const now = new Date();
  const from = new Date(now.getTime() - 6 * 86400000);
  const fromEl = $('#ov-from');
  const toEl = $('#ov-to');
  if (fromEl) fromEl.value = formatDatetimeLocal(from);
  if (toEl) toEl.value = formatDatetimeLocal(now);

  // 初始化明细查询
  initDetailQuery();
}

// 格式化为 datetime-local 输入框的格式 (YYYY-MM-DDTHH:mm)
function formatDatetimeLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// 模型访问明细查询
function initDetailQuery() {
  // 填充Agent选择器
  loadDetailAgentList();
  // 填充Model选择器（按上面总览的时间范围）
  loadDetailModelList();

  // 绑定分页大小变化
  const pageSizeEl = $('#detail-page-size');
  if (pageSizeEl) {
    pageSizeEl.addEventListener('change', function() {
      // 重置到第一页并查询
      const pageEl = $('#detail-page');
      if (pageEl) pageEl.value = '1';
      queryDetailUsage();
    });
  }

  // 绑定上一页/下一页按钮
  const prevBtn = $('#detail-prev-page');
  const nextBtn = $('#detail-next-page');
  if (prevBtn) {
    prevBtn.addEventListener('click', function() {
      const pageEl = $('#detail-page');
      if (pageEl && Number(pageEl.value) > 1) {
        pageEl.value = String(Number(pageEl.value) - 1);
        queryDetailUsage();
      }
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', function() {
      const pageEl = $('#detail-page');
      if (pageEl) {
        pageEl.value = String(Number(pageEl.value) + 1);
        queryDetailUsage();
      }
    });
  }

  // 绑定页码输入框回车事件
  const pageEl = $('#detail-page');
  if (pageEl) {
    pageEl.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        queryDetailUsage();
      }
    });
  }

  // 绑定Agent选择器变化事件
  const agentEl = $('#detail-agent');
  if (agentEl) {
    agentEl.addEventListener('change', function() {
      const pageEl = $('#detail-page');
      if (pageEl) pageEl.value = '1';
      queryDetailUsage();
    });
  }

  // 绑定Model选择器变化事件
  const modelEl = $('#detail-model');
  if (modelEl) {
    modelEl.addEventListener('change', function() {
      const pageEl = $('#detail-page');
      if (pageEl) pageEl.value = '1';
      queryDetailUsage();
    });
  }
}

async function loadDetailAgentList() {
  try {
    const resp = await fetch(apiUrl('api/stats/agents'), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    if (!resp.ok) return;
    const agents = await resp.json();

    const selectEl = $('#detail-agent');
    if (selectEl && agents.length) {
      // 清空除第一个"全部"选项之外的所有选项
      while (selectEl.options.length > 1) {
        selectEl.remove(1);
      }

      agents.forEach(function(a) {
        const option = document.createElement('option');
        option.value = a.agent_aid;
        // 优先显示agent_name，没有则显示aid前缀
        option.textContent = a.agent_name || a.agent_aid.split('.')[0];
        selectEl.appendChild(option);
      });
      // 默认选中第一个agent
      if (agents.length > 0) {
        selectEl.value = agents[0].agent_aid;
      }
      // 加载完成后自动查询一次
      queryDetailUsage();
    }
  } catch {}
}

// 加载模型列表（按上面总览的时间范围）
async function loadDetailModelList() {
  const selectEl = $('#detail-model');
  if (!selectEl) return;
  // 记住当前选中值，刷新后尽量保持
  const prev = selectEl.value;
  try {
    const timeRange = window._currentOverviewTimeRange || {};
    const params = new URLSearchParams();
    if (timeRange.fromTs) params.set('from', String(timeRange.fromTs));
    if (timeRange.toTs) params.set('to', String(timeRange.toTs));

    const resp = await fetch(apiUrl('api/stats/models?' + params.toString()), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    if (!resp.ok) return;
    const models = await resp.json();

    // 清空除第一个"全部"选项之外的所有选项
    while (selectEl.options.length > 1) {
      selectEl.remove(1);
    }
    (models || []).forEach(function(m) {
      const option = document.createElement('option');
      option.value = m;
      option.textContent = m;
      selectEl.appendChild(option);
    });
    // 恢复之前的选择（若仍存在）
    if (prev && Array.prototype.some.call(selectEl.options, function(o) { return o.value === prev; })) {
      selectEl.value = prev;
    } else {
      selectEl.value = '';
    }
  } catch {}
}

async function queryDetailUsage() {
  // 使用总览的时间范围
  const timeRange = window._currentOverviewTimeRange || {};
  const fromTs = timeRange.fromTs;
  const toTs = timeRange.toTs;

  const agentEl = $('#detail-agent');
  const modelEl = $('#detail-model');
  const pageEl = $('#detail-page');
  const pageSizeEl = $('#detail-page-size');

  const page = pageEl ? Number(pageEl.value) || 1 : 1;
  const pageSize = pageSizeEl ? Number(pageSizeEl.value) || 50 : 50;
  const offset = (page - 1) * pageSize;

  const params = new URLSearchParams();
  if (fromTs) params.set('from', String(fromTs));
  if (toTs) params.set('to', String(toTs));
  if (agentEl && agentEl.value) params.set('agent', agentEl.value);
  if (modelEl && modelEl.value) params.set('model', modelEl.value);
  params.set('limit', String(pageSize));
  params.set('offset', String(offset));

  try {
    const resp = await fetch(apiUrl('api/stats/detail?' + params.toString()), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    if (!resp.ok) {
      showDetailError(t('usage.detail.error'));
      return;
    }
    const result = await resp.json();
    renderDetailTable(result.data, result.total, page, pageSize);
  } catch {
    showDetailError(t('usage.detail.error'));
  }
}

function renderDetailTable(data, total, currentPage, pageSize) {
  const tableEl = $('#detail-table');
  if (!tableEl) return;

  if (!data || !data.length) {
    tableEl.innerHTML = '<tbody><tr><td colspan="10" style="text-align:center;color:var(--dim)">' + t('usage.explorer.noData') + '</td></tr></tbody>';
    updatePaginationInfo(0, currentPage, pageSize);
    return;
  }

  const html = '<thead><tr>' +
    '<th>' + t('usage.detail.th.time') + '</th>' +
    '<th>' + t('usage.detail.th.agent') + '</th>' +
    '<th>' + t('usage.detail.th.peer') + '</th>' +
    '<th>' + t('usage.detail.th.model') + '</th>' +
    '<th>' + t('usage.detail.th.input') + '</th>' +
    '<th>' + t('usage.detail.th.output') + '</th>' +
    '<th>' + t('usage.detail.th.cacheCreation') + '</th>' +
    '<th>' + t('usage.detail.th.cacheRead') + '</th>' +
    '<th>' + t('usage.detail.th.costOfficial') + '</th>' +
    '<th>' + t('usage.detail.th.costGateway') + '</th>' +
    '</tr></thead><tbody>' +
    data.map(function(row) {
      const time = new Date(row.ts).toLocaleString();
      const agentName = row.agent_name || (row.agent_aid || '').split('.')[0];
      const peerName = (row.peer_key || '').replace(/^aun#/, '').split('.')[0];
      return '<tr>' +
        '<td style="white-space:nowrap">' + time + '</td>' +
        '<td title="' + esc(row.agent_aid) + '">' + esc(agentName) + '</td>' +
        '<td title="' + esc(row.peer_key) + '">' + esc(peerName) + '</td>' +
        '<td>' + esc(row.model || '') + '</td>' +
        '<td>' + fmtTokens(row.input_tokens || 0) + '</td>' +
        '<td>' + fmtTokens(row.output_tokens || 0) + '</td>' +
        '<td>' + fmtTokens(row.cache_creation_tokens || 0) + '</td>' +
        '<td>' + fmtTokens(row.cache_read_tokens || 0) + '</td>' +
        '<td>' + fmtCostCompact(row.cost_official_usd, row.cost_official_cny) + '</td>' +
        '<td>' + fmtCostCompact(row.cost_gateway_usd, row.cost_gateway_cny) + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody>';

  tableEl.innerHTML = html;
  updatePaginationInfo(total, currentPage, pageSize);
}

function updatePaginationInfo(total, currentPage, pageSize) {
  const infoEl = $('#detail-pagination-info');
  const prevBtn = $('#detail-prev-page');
  const nextBtn = $('#detail-next-page');

  if (infoEl) {
    const start = total > 0 ? (currentPage - 1) * pageSize + 1 : 0;
    const end = Math.min(currentPage * pageSize, total);
    const totalPages = Math.ceil(total / pageSize) || 1;
    infoEl.textContent = t('usage.detail.pagination')
      .replace('{start}', start)
      .replace('{end}', end)
      .replace('{total}', total)
      .replace('{page}', currentPage)
      .replace('{totalPages}', totalPages);
  }

  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= Math.ceil(total / pageSize);
}

function showDetailError(msg) {
  const tableEl = $('#detail-table');
  if (tableEl) {
    tableEl.innerHTML = '<tbody><tr><td colspan="10" style="text-align:center;color:var(--red)">' + esc(msg) + '</td></tr></tbody>';
  }
}

function fmtCostCompact(usd, cny) {
  var parts = [];
  if (usd > 0) parts.push('$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)));
  if (cny > 0) parts.push('¥' + (cny < 0.01 ? cny.toFixed(4) : cny.toFixed(2)));
  if (parts.length === 0) return '-';
  return parts.join(' / ');
}

function ovCard(value, label, groupClass) {
  var cls = 'usage-card' + (groupClass ? ' ' + groupClass : '');
  return '<div class="' + cls + '"><div class="card-value">' + value + '</div><div class="card-label">' + label + '</div></div>';
}

// 创建多值卡片（合并多个指标到一个卡片中）
function makeMultiValueCard(items, title, groupClass) {
  var cls = 'usage-card multi-value-card' + (groupClass ? ' ' + groupClass : '');
  var itemsHtml = items.map(function(item) {
    return '<div class="card-item"><div class="card-item-label">' + item.label + '</div><div class="card-item-value">' + item.value + '</div></div>';
  }).join('');
  return '<div class="' + cls + '"><div class="card-title">' + title + '</div><div class="card-items">' + itemsHtml + '</div></div>';
}

function fmtCost(usd, cny) {
  var parts = [];
  if (usd > 0) parts.push('$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)));
  if (cny > 0) parts.push('¥' + (cny < 0.01 ? cny.toFixed(4) : cny.toFixed(2)));
  return parts.length ? parts.join(' / ') : '$0';
}

// 分行显示美元和人民币
function fmtCostSplit(usd, cny) {
  var parts = [];
  if (usd > 0) parts.push('$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)));
  if (cny > 0) parts.push('¥' + (cny < 0.01 ? cny.toFixed(4) : cny.toFixed(2)));
  if (parts.length === 0) return '<span style="color:var(--dim)">$0</span>';
  if (parts.length === 1) return parts[0];
  return parts[0] + '<br><span style="font-size:10px;color:var(--dim)">' + parts[1] + '</span>';
}

// 带标签的价格显示（用于卡片）
function fmtCostWithLabel(usd, cny, label) {
  var parts = [];
  if (usd > 0) parts.push('$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)));
  if (cny > 0) parts.push('¥' + (cny < 0.01 ? cny.toFixed(4) : cny.toFixed(2)));
  var value = parts.length ? parts.join(' / ') : '$0';
  return '<div class="card-label" style="margin-bottom:4px;margin-top:0">' + label + '</div><div class="card-value" style="font-size:18px">' + value + '</div>';
}

// ── Usage subtab switching ──
var _usageSubtabsBound = false;

function activeOverviewRange() {
  const active = document.querySelector('.ov-range-btn.active');
  return active ? active.getAttribute('data-range') || 'today' : 'today';
}

function refreshUsageView() {
  initUsageSubtabs();
  const activeSubtab = document.querySelector('.usage-subtab.active')?.getAttribute('data-subview') || 'overview';
  if (activeSubtab === 'explorer') {
    loadExplorerModels();
    loadExplorerSidebar();
    setTimeout(() => runExplorerQuery(), 0);
    return;
  }

  const range = activeOverviewRange();
  if (range === 'custom') {
    const fromEl = $('#ov-from');
    const toEl = $('#ov-to');
    loadUsageOverview('custom', fromEl?.value || '', toEl?.value || '');
  } else {
    loadUsageOverview(range);
  }
}

function initUsageSubtabs() {
  if (_usageSubtabsBound) return;
  _usageSubtabsBound = true;
  var btns = document.querySelectorAll('.usage-subtab');
  btns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      btns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var target = btn.getAttribute('data-subview');
      document.querySelectorAll('.usage-subpanel').forEach(function(p) {
        p.classList.remove('active');
        p.style.display = '';
      });
      var panel = $('#usage-' + target);
      if (panel) { panel.classList.add('active'); panel.style.display = ''; }
      if (target === 'overview') {
        initOverviewFilters();
        loadUsageOverview();
      } else if (target === 'explorer') {
        initExplorer();
        // 自动加载模型列表和执行查询
        loadExplorerModels();
        setTimeout(() => runExplorerQuery(), 100);
      }
    });
  });

  // 初始化总览页面的过滤器并加载默认数据（今日）
  initOverviewFilters();
  loadUsageOverview('today');
}

// ── Explorer ──
var _explorerChart = null;
var _explorerInited = false;
var _expSelection = { type: null, key: null }; // { type: 'agent'|'peer', key: string } or null
var _expCurrentRange = 'today'; // Explorer 当前选择的时间范围
var _expTimeRange = { fromTs: null, toTs: null }; // Explorer 的时间范围

function initExplorer() {
  if (_explorerInited) return;
  _explorerInited = true;

  // 初始化时间范围选择
  initExplorerTimeFilters();

  // 绑定查询按钮
  var btn = $('#exp-query-btn');
  if (btn) btn.onclick = runExplorerQuery;

  // Load sidebar lists
  loadExplorerSidebar();
}

// 初始化 Explorer 的时间范围选择
function initExplorerTimeFilters() {
  // 范围按钮切换
  document.querySelectorAll('.exp-range-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.exp-range-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');

      const range = btn.getAttribute('data-range');
      const customDateEl = $('#exp-custom-date');

      if (range === 'custom') {
        if (customDateEl) customDateEl.style.display = 'flex';
      } else {
        if (customDateEl) customDateEl.style.display = 'none';
        _expCurrentRange = range;
        calculateExplorerTimeRange(range);
        loadExplorerModels(); // 加载可用模型
        runExplorerQuery();
      }
    });
  });

  // 自定义时间查询按钮
  const timeQueryBtn = $('#exp-time-query-btn');
  if (timeQueryBtn) {
    timeQueryBtn.addEventListener('click', function() {
      const fromEl = $('#exp-from');
      const toEl = $('#exp-to');
      if (fromEl && toEl && fromEl.value && toEl.value) {
        _expCurrentRange = 'custom';
        _expTimeRange.fromTs = new Date(fromEl.value).getTime();
        _expTimeRange.toTs = new Date(toEl.value).getTime();
        loadExplorerModels(); // 加载可用模型
        runExplorerQuery();
      }
    });
  }

  // 设置默认时间范围（今日）并初始化日期选择器
  const now = new Date();
  const fromEl = $('#exp-from');
  const toEl = $('#exp-to');
  if (fromEl) fromEl.value = formatDatetimeLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  if (toEl) toEl.value = formatDatetimeLocal(now);

  // 计算默认时间范围（今日）
  calculateExplorerTimeRange('today');
}

// 计算 Explorer 的时间范围
function calculateExplorerTimeRange(rangeType) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

  switch (rangeType) {
    case 'today':
      _expTimeRange.fromTs = todayStart;
      _expTimeRange.toTs = todayEnd;
      break;
    case 'week':
      const dayOfWeek = now.getDay() || 7;
      const weekStart = new Date(todayStart - (dayOfWeek - 1) * 86400000);
      _expTimeRange.fromTs = weekStart.getTime();
      _expTimeRange.toTs = todayEnd;
      break;
    case 'lastWeek':
      const lastWeekEnd = new Date(todayStart - now.getDay() * 86400000);
      const lastWeekStart = new Date(lastWeekEnd.getTime() - 6 * 86400000);
      _expTimeRange.fromTs = lastWeekStart.getTime();
      _expTimeRange.toTs = new Date(lastWeekEnd.getTime() + 86400000 - 1).getTime();
      break;
    case 'month':
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      _expTimeRange.fromTs = monthStart.getTime();
      _expTimeRange.toTs = todayEnd;
      break;
    case 'last30':
      _expTimeRange.fromTs = todayStart - 29 * 86400000;
      _expTimeRange.toTs = todayEnd;
      break;
  }
}

// 加载 Explorer 可用的模型列表（根据当前时间范围）
async function loadExplorerModels() {
  const params = new URLSearchParams();
  if (_expTimeRange.fromTs) params.set('from', String(_expTimeRange.fromTs));
  if (_expTimeRange.toTs) params.set('to', String(_expTimeRange.toTs));

  try {
    const resp = await fetch(apiUrl('api/stats/models?' + params.toString()), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    if (!resp.ok) return;
    const models = await resp.json();

    const selectEl = $('#exp-model');
    if (selectEl) {
      const currentValue = selectEl.value;
      selectEl.innerHTML = '<option value="">' + t('usage.explorer.all') + '</option>';
      models.forEach(function(model) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        selectEl.appendChild(option);
      });
      // 恢复之前的选择（如果还存在）
      if (currentValue && models.includes(currentValue)) {
        selectEl.value = currentValue;
      }
    }
  } catch {}
}

// 获取 Explorer 时间范围的总览数据
async function fetchExplorerOverviewData(filterParams) {
  try {
    const params = new URLSearchParams();
    if (_expTimeRange.fromTs) params.set('from', String(_expTimeRange.fromTs));
    if (_expTimeRange.toTs) params.set('to', String(_expTimeRange.toTs));

    // 添加筛选参数
    if (filterParams) {
      if (filterParams.agent) params.set('agent', filterParams.agent);
      if (filterParams.peer) params.set('peer', filterParams.peer);
    }

    const resp = await fetch(apiUrl('api/stats/overview?' + params.toString()), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    const data = resp.ok ? await resp.json() : null;

    if (data) {
      const ts = (data.token_stats && data.token_stats.all_time) ? data.token_stats.all_time
        : { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, call_count: 0, cost_official_usd: 0, cost_official_cny: 0, cost_usd: 0, cost_cny: 0 };
      const sessionCount = data.session_count || 0;
      const msgIn = data.msg_in || 0;
      const msgOut = data.msg_out || 0;
      const totalTokens = ts.cache_read_tokens + ts.cache_creation_tokens + ts.input_tokens + ts.output_tokens;
      const hitRate = totalTokens > 0 ? (ts.cache_read_tokens / totalTokens) * 100 : 0;

      return { ts, sessionCount, msgIn, msgOut, hitRate };
    }
  } catch {}

  // 返回空数据
  return {
    ts: { call_count: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_official_usd: 0, cost_official_cny: 0, cost_usd: 0, cost_cny: 0 },
    sessionCount: 0,
    msgIn: 0,
    msgOut: 0,
    hitRate: 0
  };
}

async function loadExplorerSidebar() {
  var token = localStorage.getItem(TOKEN_KEY);
  var headers = { Authorization: 'Bearer ' + token };
  try {
    var agentsResp = await fetch(apiUrl('api/stats/agents'), { headers });
    var agents = agentsResp.ok ? await agentsResp.json() : [];
    renderExplorerAgentList(agents);

    // 初始加载时不加载 peers（等待用户选择 agent）
    renderExplorerPeerList([]);
  } catch {}
}

// 渲染 Agent 列表
function renderExplorerAgentList(agents) {
  var agentList = $('#exp-agent-list');
  if (!agentList) return;

  // "All" item for agents
  var allHtml = '<div class="exp-sidebar-item active" data-type="all" data-key="">' +
    '<span class="item-name">' + t('usage.explorer.all') + '</span></div>';

  agentList.innerHTML = allHtml + agents.map(function(a) {
    var name = a.agent_name || (a.agent_aid ? a.agent_aid.split('.')[0] : 'unknown');
    return '<div class="exp-sidebar-item" data-type="agent" data-key="' + escHtml(a.agent_aid) + '">' +
      '<span class="item-name" title="' + escHtml(a.agent_aid) + '">' + escHtml(name) + '</span></div>';
  }).join('');

  // 绑定点击事件
  agentList.querySelectorAll('.exp-sidebar-item').forEach(function(el) {
    el.addEventListener('click', async function() {
      // Clear active from all
      document.querySelectorAll('#exp-agent-list .exp-sidebar-item').forEach(function(x) { x.classList.remove('active'); });
      el.classList.add('active');

      var type = el.getAttribute('data-type');
      var key = el.getAttribute('data-key');

      if (type === 'all') {
        _expSelection = { type: null, key: null };
        $('#exp-selected-name').textContent = t('usage.explorer.all');
        // 选择"全部"时，清空 peers 列表
        renderExplorerPeerList([]);
      } else {
        _expSelection = { type: type, key: key };
        var name = el.querySelector('.item-name').textContent.trim();
        $('#exp-selected-name').textContent = name;
        // 选择特定 agent 时，加载该 agent 的 peers
        await loadPeersForAgent(key);
      }

      runExplorerQuery();
    });
  });
}

// 加载指定 agent 的 peers
async function loadPeersForAgent(agentAid) {
  var token = localStorage.getItem(TOKEN_KEY);
  var headers = { Authorization: 'Bearer ' + token };
  try {
    const params = new URLSearchParams();
    params.set('agent', agentAid);
    // 不传递时间范围，获取该 agent 的所有 peers

    var resp = await fetch(apiUrl('api/stats/peers?' + params.toString()), { headers });
    var peers = resp.ok ? await resp.json() : [];
    renderExplorerPeerList(peers);
  } catch {
    renderExplorerPeerList([]);
  }
}

// 渲染 Peer 列表
function renderExplorerPeerList(peers) {
  var peerList = $('#exp-peer-list');
  if (!peerList) return;

  if (!peers || peers.length === 0) {
    peerList.innerHTML = '<div style="padding: 12px; color: var(--dim); font-size: 12px; text-align: center;">' + t('common.noData') + '</div>';
    return;
  }

  peerList.innerHTML = peers.map(function(p) {
    var name = p.peer_key || 'unknown';
    // 优先显示peer_name，否则简化显示peer_key
    var display = p.peer_name || name.replace(/^aun#/, '').split('#')[0].split('.')[0];

    // 添加聊天类型标签
    var typeTag = '';
    if (p.peer_chat_type === 'group') {
      typeTag = '<span class="peer-tag peer-tag-group">' + t('usage.explorer.chatType.group') + '</span>';
    } else if (p.peer_chat_type === 'private') {
      typeTag = '<span class="peer-tag peer-tag-private">' + t('usage.explorer.chatType.private') + '</span>';
    }

    // 群聊人数标签
    var memberTag = '';
    if (p.peer_chat_type === 'group' && p.peer_group_member_count) {
      memberTag = '<span class="peer-tag peer-tag-count">' + p.peer_group_member_count + t('usage.explorer.memberCount') + '</span>';
    }

    return '<div class="exp-sidebar-item" data-type="peer" data-key="' + escHtml(p.peer_key) + '">' +
      '<span class="item-name" title="' + escHtml(name) + '">' +
      (typeTag ? typeTag + ' ' : '') + escHtml(display) + (memberTag ? ' ' + memberTag : '') +
      '</span>' +
      '<span class="item-meta">' + fmtTokens((p.input_tokens || 0) + (p.output_tokens || 0)) + '</span></div>';
  }).join('');

  // Bind click events for peers
  peerList.querySelectorAll('.exp-sidebar-item').forEach(function(el) {
    el.addEventListener('click', function() {
      // Clear active from all peers
      document.querySelectorAll('#exp-peer-list .exp-sidebar-item').forEach(function(x) { x.classList.remove('active'); });
      el.classList.add('active');

      var type = el.getAttribute('data-type');
      var key = el.getAttribute('data-key');
      _expSelection = { type: type, key: key };
      var name = el.querySelector('.item-name').textContent.trim();
      $('#exp-selected-name').textContent = name;

      runExplorerQuery();
    });
  });
}

function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function runExplorerQuery() {
  // 使用 Explorer 自己的时间范围
  const fromTs = _expTimeRange.fromTs;
  const toTs = _expTimeRange.toTs;

  var params = new URLSearchParams();
  if (fromTs) params.set('from', String(fromTs));
  if (toTs) params.set('to', String(toTs));
  // Inject selection from sidebar
  if (_expSelection.type === 'agent' && _expSelection.key) params.set('agent', _expSelection.key);
  if (_expSelection.type === 'peer' && _expSelection.key) params.set('peer', _expSelection.key);
  var modelEl = $('#exp-model');
  if (modelEl && modelEl.value) params.set('model', modelEl.value);
  var granEl = $('#exp-granularity');
  if (granEl) params.set('granularity', granEl.value);

  var data;
  try {
    var resp = await fetch(apiUrl('api/stats/explorer?' + params.toString()), {
      headers: { Authorization: 'Bearer ' + localStorage.getItem(TOKEN_KEY) }
    });
    if (!resp.ok) return;
    data = await resp.json();
  } catch { return; }

  // 根据查询结果计算卡片数据
  var cardsEl = $('#exp-detail-cards');
  if (cardsEl) {
    // 如果有筛选条件（agent/peer），使用查询结果计算；否则需要获取总览数据
    const hasFilter = _expSelection.type && _expSelection.key;

    let cardData;
    let cardTitle = null; // 用于显示选中的 agent/peer 信息

    if (hasFilter) {
      // 有筛选：根据查询结果计算 token 数据，并获取会话信息
      var totIn = 0, totOut = 0, totCacheCreation = 0, totCacheRead = 0, totCalls = 0;
      if (data && data.length) {
        data.forEach(function(r) {
          totIn += r.input_tokens || 0;
          totOut += r.output_tokens || 0;
          totCacheCreation += r.cache_creation_tokens || 0;
          totCacheRead += r.cache_read_tokens || 0;
          totCalls += r.call_count || 0;
        });
      }
      const totalTokens = totCacheRead + totCacheCreation + totIn + totOut;
      const hitRate = totalTokens > 0 ? (totCacheRead / totalTokens) * 100 : 0;

      // 构建筛选参数
      const filterParams = {};
      if (_expSelection.type === 'agent') filterParams.agent = _expSelection.key;
      if (_expSelection.type === 'peer') filterParams.peer = _expSelection.key;

      // 获取该筛选条件下的会话信息
      const overviewData = await fetchExplorerOverviewData(filterParams);

      cardData = {
        ts: {
          call_count: totCalls,
          input_tokens: totIn,
          output_tokens: totOut,
          cache_creation_tokens: totCacheCreation,
          cache_read_tokens: totCacheRead,
          cost_official_usd: overviewData.ts.cost_official_usd || 0,
          cost_official_cny: overviewData.ts.cost_official_cny || 0,
          cost_usd: overviewData.ts.cost_usd || 0,
          cost_cny: overviewData.ts.cost_cny || 0
        },
        sessionCount: overviewData.sessionCount || 0,
        msgIn: overviewData.msgIn || 0,
        msgOut: overviewData.msgOut || 0,
        hitRate: hitRate
      };

      // 构建卡片标题
      if (_expSelection.type === 'agent') {
        // 从侧边栏获取 agent 名称
        const selectedItem = document.querySelector('#exp-agent-list .exp-sidebar-item.active .item-name');
        const agentName = selectedItem ? selectedItem.textContent.trim() : '';
        const agentAid = _expSelection.key;
        cardTitle = agentName && agentName !== agentAid.split('.')[0]
          ? `${agentName} (AID: ${agentAid})`
          : `AID: ${agentAid}`;
      } else if (_expSelection.type === 'peer') {
        // 从侧边栏获取 peer 名称（去掉标签）
        const selectedItem = document.querySelector('#exp-peer-list .exp-sidebar-item.active .item-name');
        if (selectedItem) {
          // 克隆节点并移除所有标签元素
          const clone = selectedItem.cloneNode(true);
          const tags = clone.querySelectorAll('.peer-tag');
          tags.forEach(tag => tag.remove());
          const peerName = clone.textContent.trim();
          const peerKey = _expSelection.key;
          cardTitle = peerName ? `${peerName} (Peer: ${peerKey.split('#')[3] || peerKey.split('#')[0]})` : `Peer: ${peerKey}`;
        } else {
          cardTitle = `Peer: ${_expSelection.key}`;
        }
      }
    } else {
      // 无筛选：获取 Explorer 时间范围的总览数据
      cardData = await fetchExplorerOverviewData();
    }

    const { ts, sessionCount, msgIn, msgOut, hitRate } = cardData;

    // 不显示标题行，直接显示卡片
    // 注意：会话信息是该时间范围的总数（不区分 agent/peer）
    const sessionCard = makeMultiValueCard([
      { label: t('usage.card.sessionCount'), value: sessionCount },
      { label: t('usage.card.msgIn'), value: msgIn },
      { label: t('usage.card.msgOut'), value: msgOut }
    ], t('usage.card.sessionInfo'), 'session-group');

    const usageCard = makeMultiValueCard([
      { label: t('usage.card.modelCalls'), value: ts.call_count },
      { label: t('usage.card.inputTokens'), value: fmtTokens(ts.input_tokens) },
      { label: t('usage.card.outputTokens'), value: fmtTokens(ts.output_tokens) },
      { label: t('usage.card.cacheCreation'), value: fmtTokens(ts.cache_creation_tokens) },
      { label: t('usage.card.cacheHitTokens'), value: fmtTokens(ts.cache_read_tokens) },
      { label: t('usage.card.cacheHitRate'), value: hitRate.toFixed(1) + '%' }
    ], t('usage.card.usageInfo'), 'usage-group');

    const costCard = makeMultiValueCard([
      { label: t('usage.card.costOfficial'), value: fmtCost(ts.cost_official_usd, ts.cost_official_cny) },
      { label: t('usage.card.costGateway'), value: fmtCost(ts.cost_usd, ts.cost_cny) }
    ], t('usage.card.costInfo'), 'cost-group');

    cardsEl.innerHTML = sessionCard + usageCard + costCard;
    cardsEl.style.display = 'flex';
  }

  if (!data || !data.length) {
    var tbl = $('#usage-explorer-table');
    if (tbl) tbl.innerHTML = '<tr><td>' + t('usage.explorer.noData') + '</td></tr>';
    var chartEl = $('#usage-explorer-chart');
    if (chartEl && _explorerChart) { _explorerChart.dispose(); _explorerChart = null; }
    return;
  }

  // Chart
  var chartEl = $('#usage-explorer-chart');
  if (chartEl) {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (_explorerChart) { _explorerChart.dispose(); _explorerChart = null; }
    _explorerChart = echarts.init(chartEl, isDark ? 'dark' : null);
    var periods = data.map(function(r) { return r.period; });
    _explorerChart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: [t('usage.card.input'), t('usage.card.output')], top: 0, textStyle: { fontSize: 11 } },
      grid: { top: 30, bottom: 30, left: 60, right: 16 },
      xAxis: { type: 'category', data: periods, axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { type: 'value', axisLabel: { formatter: function(v) { return fmtTokens(v); } } },
      series: [
        { name: t('usage.card.input'), type: 'line', data: data.map(function(r) { return r.input_tokens; }), smooth: true, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#4f6ef7' } },
        { name: t('usage.card.output'), type: 'line', data: data.map(function(r) { return r.output_tokens; }), smooth: true, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#38a169' } },
      ]
    });
  }

  // Table
  var tbl = $('#usage-explorer-table');
  if (tbl) {
    tbl.innerHTML =
      '<thead><tr><th>' + t('usage.explorer.th.period') + '</th><th>' + t('usage.explorer.th.input') + '</th><th>' + t('usage.explorer.th.output') + '</th><th>' + t('usage.explorer.th.cacheCreation') + '</th><th>' + t('usage.explorer.th.cacheHit') + '</th><th>' + t('usage.explorer.th.calls') + '</th></tr></thead>' +
      '<tbody>' + data.map(function(r) {
        return '<tr><td>' + r.period + '</td><td>' + fmtTokens(r.input_tokens) + '</td><td>' + fmtTokens(r.output_tokens) +
          '</td><td>' + fmtTokens(r.cache_creation_tokens) + '</td><td>' + fmtTokens(r.cache_read_tokens) +
          '</td><td>' + r.call_count + '</td></tr>';
      }).join('') + '</tbody>';
  }
}

// ── Monitor ──────────────────────────────────────
// 绑定时间范围切换按钮（只绑一次）
let _monRangeBound = false;
function bindMonRangeTabs() {
  if (_monRangeBound) return;
  var tabs = document.querySelectorAll('#view-monitor .mon-range');
  if (!tabs.length) return;
  tabs.forEach(function (btn) {
    btn.onclick = function () {
      monRange = btn.dataset.range;
      document.querySelectorAll('#view-monitor .mon-range').forEach(function (b) {
        b.classList.toggle('active', b.dataset.range === monRange);
      });
      // 切范围 → 重新订阅（源按 range 返回不同分辨率的 history）
      subscribe('monitor', { range: monRange });
    };
  });
  _monRangeBound = true;
}

function renderMonitor(data) {
  var wrap = $('#view-monitor .mon-layout');
  if (!wrap) return;
  bindMonRangeTabs();
  if (!data) { return; }
  if (!data.daemonRunning) {
    // 不清空骨架，仅在卡片区提示，避免破坏 toolbar
    var cardsEl0 = $('#mon-cards');
    if (cardsEl0) cardsEl0.innerHTML = `<div class="empty" style="grid-column:1/-1">${t('monitor.daemonStopped')}</div>`;
    return;
  }

  var s = data.snapshot;
  // history 是三档分辨率对象 { fine, mid, coarse }；按当前范围选一档
  var rangeKey = { '2m': 'fine', '10m': 'mid', '1h': 'coarse' }[monRange] || 'fine';
  var hist = data.history || {};
  var h = Array.isArray(hist) ? hist : (hist[rangeKey] || []);
  var sys = s.system || {};
  var lh = (s.stats && s.stats.lastHour) || {};
  var recentErrs = (s.stats && s.stats.recentErrors) || [];
  var errRate = (lh.received > 0) ? ((lh.errors / lh.received) * 100).toFixed(1) + '%' : '0%';
  var agents = s.agents || [];
  var connected = agents.filter(function (a) { return a.status === 'connected'; }).length;

  // ── Stat cards ──
  var sysMemPct = (sys.memTotal > 0) ? Math.round((sys.memUsed / sys.memTotal) * 100) : 0;
  var cards = [
    [t('monitor.card.uptime'), fmtDur(s.uptimeMs / 1000)],
    [t('monitor.card.messages1h'), lh.received || 0],
    [t('monitor.card.onlineAgents'), connected + '/' + agents.length],
    [t('monitor.card.avgResponse'), Math.round(lh.avgResponseMs || 0) + 'ms'],
    [t('monitor.card.errorRate'), errRate],
    [t('monitor.card.processCpu'), (s.cpuPercent != null ? s.cpuPercent : 0) + '%'],
    [t('monitor.card.systemCpu'), (sys.cpuPercent != null ? sys.cpuPercent : 0) + '%'],
    [t('monitor.card.processMemory'), fmtBytes(s.memory ? s.memory.rss : 0)],
    [t('monitor.card.systemMemory'), sysMemPct + '%'],
  ];
  $('#mon-cards').innerHTML = cards.map(function (c) {
    return '<div class="usage-card"><div class="card-value">' + c[1] + '</div><div class="card-label">' + c[0] + '</div></div>';
  }).join('');

  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var ts = h.map(function (p) { return new Date(p.ts).toLocaleTimeString(); });
  var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };
  var cProc = css('--accent'), cSys = css('--orange');

  // ── CPU dual-line：进程 vs 系统 ──
  monDualLine('mon-cpu-chart', '_monCpu', ts, isDark, t('monitor.chart.cpu'),
    [
      { name: t('monitor.legend.process'), data: h.map(function (p) { return p.procCpu; }), color: cProc },
      { name: t('monitor.legend.system'), data: h.map(function (p) { return p.sysCpu != null ? p.sysCpu : null; }), color: cSys },
    ],
    function (v) { return Number(v).toFixed(1) + '%'; }, [0, 100]);

  // ── Memory dual-line：进程 RSS vs 系统已用 ──
  monDualLine('mon-mem-chart', '_monMem', ts, isDark, t('monitor.chart.memory'),
    [
      { name: t('monitor.series.processRss'), data: h.map(function (p) { return p.procRss; }), color: cProc },
      { name: t('monitor.series.systemUsed'), data: h.map(function (p) { return p.sysMemUsed != null ? p.sysMemUsed : null; }), color: cSys },
    ],
    function (v) { return fmtBytes(v); }, null);

  // ── Message activity bar chart ──
  var msgEl = $('#mon-msg-chart');
  if (msgEl) {
    if (!window._monMsg) window._monMsg = echarts.init(msgEl, isDark ? 'dark' : null);
    window._monMsg.setOption({
      title: { text: t('monitor.chart.activity1h'), left: 'center', top: 4, textStyle: { fontSize: 12, color: isDark ? '#e6edf3' : '#1a202c' } },
      tooltip: { trigger: 'axis' },
      grid: { top: 36, bottom: 24, left: 44, right: 12 },
      xAxis: {
        type: 'category',
        data: [
          t('monitor.activity.received'),
          t('monitor.activity.completed'),
          t('monitor.activity.errors'),
          t('monitor.activity.interrupts'),
          t('monitor.activity.toolErrors'),
        ],
        axisLabel: { fontSize: 9 },
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{
        type: 'bar', barWidth: '45%',
        data: [
          { value: lh.received || 0, itemStyle: { color: css('--accent') } },
          { value: lh.completed || 0, itemStyle: { color: css('--green') } },
          { value: lh.errors || 0, itemStyle: { color: css('--red') } },
          { value: lh.interrupts || 0, itemStyle: { color: css('--orange') } },
          { value: lh.toolErrors || 0, itemStyle: { color: css('--blue') } },
        ],
      }],
      animation: false,
    });
  }

  // ── Error breakdown donut ──
  var errEntries = Object.entries(lh.errorsByType || {});
  var errEl = $('#mon-err-chart');
  if (errEl) {
    if (errEntries.length) {
      if (!window._monErr) window._monErr = echarts.init(errEl, isDark ? 'dark' : null);
      window._monErr.setOption({
        title: { text: t('monitor.chart.errors'), left: 'center', top: 4, textStyle: { fontSize: 12, color: isDark ? '#e6edf3' : '#1a202c' } },
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        series: [{
          type: 'pie', radius: ['32%', '64%'], center: ['50%', '56%'],
          label: { fontSize: 10 },
          data: errEntries.map(function (e) { return { name: e[0], value: e[1] }; }),
        }],
        animation: false,
      });
    } else {
      if (window._monErr) { window._monErr.dispose(); window._monErr = null; }
      errEl.innerHTML = `<div class="empty" style="padding:24px;font-size:12px">${t('monitor.noErrors1h')}</div>`;
    }
  }

  // ── Per-agent table ──
  var dotMap = { connected: 'on', reconnecting: 'idle', aid_blocked: 'idle', kicked: 'off', kicked_no_retry: 'off', failed: 'off', disabled: 'off' };
  $('#mon-agent-table-wrap').innerHTML =
    `<div class="mon-section-title">${t('monitor.section.agents')}</div>` +
    '<table class="usage-table"><thead><tr>' +
    `<th>${t('monitor.th.agent')}</th><th>${t('monitor.th.status')}</th><th>${t('monitor.th.received')}</th><th>${t('monitor.th.sent')}</th><th>${t('monitor.th.errors')}</th><th>${t('monitor.th.interrupts')}</th><th>${t('monitor.th.completed')}</th><th>${t('monitor.th.queue')}</th><th>${t('monitor.th.processing')}</th>` +
    '</tr></thead><tbody>' +
    (agents.length ? agents.map(function (a) {
      var st = a.runtimeStats || {};
      var dot = dotMap[a.status] || 'off';
      return '<tr>' +
        '<td title="' + esc(a.aid) + '">' + esc(a.agentName || shortAid(a.aid)) + '</td>' +
        '<td><span class="dot ' + dot + '"></span>' + esc(a.status) + '</td>' +
        '<td>' + (st.received || 0) + '</td>' +
        '<td>' + (st.sent || 0) + '</td>' +
        '<td>' + (st.errors || 0) + '</td>' +
        '<td>' + (st.interrupts || 0) + '</td>' +
        '<td>' + (st.completed || 0) + '</td>' +
        '<td>' + (st.queued || 0) + '</td>' +
        '<td>' + (st.processing || 0) + '</td>' +
        '</tr>';
    }).join('') : `<tr><td colspan="9" style="text-align:center;color:var(--dim)">${t('monitor.noAgents')}</td></tr>`) +
    '</tbody></table>';

  // ── Recent errors（替换原 Channels 位置）──
  $('#mon-err-list').innerHTML =
    `<div class="mon-section-title">${t('monitor.section.recentErrors')} <span class="mon-section-sub">(${t('monitor.section.recentErrorsSub')})</span></div>` +
    (recentErrs.length
      ? '<div class="mon-err-rows">' + recentErrs.map(function (e) {
          var who = e.agentName ? shortAid(e.agentName) : '—';
          var tag = e.kind === 'tool'
            ? `<span class="mon-err-tag tag-tool">${t('monitor.tag.tool')}</span>`
            : `<span class="mon-err-tag tag-task">${t('monitor.tag.task')}</span>`;
          var label = e.kind === 'tool' ? (e.toolName || 'tool') : (e.errorType || 'error');
          var msg = e.message ? esc(e.message) : '';
          return '<div class="mon-err-row">' +
            '<span class="mon-err-time">' + fmtAgo(e.ts) + '</span>' +
            tag +
            '<span class="mon-err-aid" title="' + esc(e.agentName || '') + '">' + esc(who) + '</span>' +
            '<span class="mon-err-kind">' + esc(label) + '</span>' +
            '<span class="mon-err-msg" title="' + msg + '">' + msg + '</span>' +
            '</div>';
        }).join('') + '</div>'
      : `<div class="empty" style="padding:24px;font-size:12px">${t('monitor.noErrorRecords')}</div>`);
}

// 双线时序图（进程 + 系统）。series: [{name,data,color}]
function monDualLine(elId, varKey, times, isDark, title, series, fmtY, yRange) {
  var el = $('#' + elId);
  if (!el) return;
  if (!window[varKey]) window[varKey] = echarts.init(el, isDark ? 'dark' : null);
  window[varKey].setOption({
    title: { text: title, left: 'center', top: 4, textStyle: { fontSize: 12, color: isDark ? '#e6edf3' : '#1a202c' } },
    legend: { show: false },
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        var lines = [params[0].axisValue];
        params.forEach(function (pt) {
          if (pt.value == null) return;
          lines.push(pt.marker + pt.seriesName + ': ' + (fmtY ? fmtY(pt.value) : pt.value));
        });
        return lines.join('<br/>');
      },
    },
    grid: { top: 36, bottom: 24, left: 56, right: 12 },
    xAxis: { type: 'category', data: times, boundaryGap: false, axisLabel: { fontSize: 9 } },
    yAxis: {
      type: 'value',
      min: (yRange ? yRange[0] : 0),
      max: (yRange ? yRange[1] : undefined),
      axisLabel: { formatter: fmtY ? function (v) { return fmtY(v); } : '{value}' },
    },
    series: series.map(function (sr) {
      return {
        name: sr.name, type: 'line', data: sr.data, smooth: true, symbol: 'none',
        connectNulls: true,
        lineStyle: { width: 2, color: sr.color },
        areaStyle: { color: sr.color, opacity: 0.08 },
        itemStyle: { color: sr.color },
      };
    }),
    animation: false,
  });
}

function renderRoles(data) {
  if (!data) return;

  const agentSelect = $('#roles-agent-select');
  if (!agentSelect) return;

  agentSelect.innerHTML = '';
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.setAttribute('data-i18n', 'roles.selectAgentPlaceholder');
  placeholderOption.textContent = t('roles.selectAgentPlaceholder');
  agentSelect.appendChild(placeholderOption);

  const agentList = data.agents || [];
  agentList.forEach(agent => {
    const opt = document.createElement('option');
    opt.value = agent.aid;
    const name = agent.displayName || agent.name || shortAid(agent.aid);
    const sa = shortAid(agent.aid);
    opt.textContent = (name && name !== sa && name !== agent.aid) ? `${name} (${sa})` : sa;
    agentSelect.appendChild(opt);
  });

  if (agentList.length > 0) {
    if (!rolesCurrentAgent || !agentList.find(a => a.aid === rolesCurrentAgent)) {
      rolesCurrentAgent = agentList[0].aid;
    }
    agentSelect.value = rolesCurrentAgent;
    renderAgentPeerRelations(data, rolesCurrentAgent);
  } else {
    rolesCurrentAgent = null;
    renderRelationsTable(data, null);
  }
}

function renderAgentPeerRelations(data, aid) {
  renderRelationsTable(data, aid);
}

function roleSourceLabel(source) {
  const labels = {
    assignment: 'Explicit',
    'private-inherited': 'Private role',
    'group-default': 'Group role',
    default: 'Default',
  };
  return labels[source] || source || '-';
}

function peerTypeText(peerType) {
  if (peerType === 'ai') return 'AI';
  if (peerType === 'human') return 'Human';
  if (peerType === 'system') return 'System';
  return '-';
}

function roleClass(role) {
  return String(role || 'anonymous').replace(/[^a-z0-9_-]/gi, '-');
}

function memberMatchesSearch(member) {
  if (!rolesSearchTerm) return true;
  const s = rolesSearchTerm.toLowerCase();
  return [member.peerName, member.peerAid, member.peerKey, member.peerId].some(v =>
    String(v || '').toLowerCase().includes(s)
  );
}

function renderRelationsTable(data, filterAid = null) {
  const tbody = document.querySelector('#relations-table tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  let conversations = data.conversations || [];

  if (filterAid) {
    conversations = conversations.filter(conv => conv.self === filterAid);
  }

  if (rolesSearchTerm) {
    const s = rolesSearchTerm.toLowerCase();
    conversations = conversations.filter(conv => {
      const ownMatch = [
        conv.name,
        conv.conversationId,
        conv.groupId,
        conv.groupName,
        conv.peerName,
        conv.peerAid,
        conv.peerKey,
      ].some(v => String(v || '').toLowerCase().includes(s));
      const memberMatch = (conv.members || []).some(member => memberMatchesSearch(member));
      return ownMatch || memberMatch;
    });
  }

  if (rolesChatTypeFilter) {
    conversations = conversations.filter(conv => conv.chatType === rolesChatTypeFilter);
  }

  conversations.sort((a, b) => {
    const lastDiff = (b.lastAt || 0) - (a.lastAt || 0);
    if (lastDiff !== 0) return lastDiff;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  if (conversations.length === 0) {
    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 7;
    cell.textContent = (rolesSearchTerm || rolesVerifyFilter || rolesChatTypeFilter)
      ? (t('common.noResults') || 'No matching results')
      : (filterAid ? (t('roles.noPeerRelations') || 'No conversations for this agent') : t('common.empty'));
    cell.style.textAlign = 'center';
    cell.style.color = 'var(--dim)';
    cell.style.padding = '40px';
    return;
  }

  conversations.forEach(conv => {
    if (conv.chatType === 'group') renderGroupConversationRow(tbody, conv);
    else renderPrivateConversationRow(tbody, conv);
  });
}

function renderPrivateConversationRow(tbody, conv) {
  const peerId = conv.peerId || conv.peerAid || conv.peerKey || conv.conversationId;
  const name = conv.peerName || conv.name || shortAid(peerId);
  const assignedRole = conv.source === 'assignment' ? (conv.assignment?.role || conv.role || '') : '';
  const row = tbody.insertRow();
  row.innerHTML = `
    <td><span class="chat-tag chat-tag-private">${esc(t('roles.chatType.private') || 'Private')}</span></td>
    <td><strong>${esc(name)}</strong></td>
    <td><code>${esc(peerId)}</code></td>
    <td>${esc(peerTypeText(conv.peerType))}</td>
    <td><span class="role-badge role-${esc(roleClass(conv.role))}">${esc(conv.role || 'anonymous')}</span></td>
    <td><span class="role-source">${esc(roleSourceLabel(conv.source))}</span></td>
    <td>
      <button class="edit-peer-role-btn"
              data-aid="${esc(conv.self)}"
              data-scope="private"
              data-peer-id="${esc(peerId)}"
              data-role="${esc(conv.role || '')}"
              data-assigned-role="${esc(assignedRole)}"
              data-label="${esc(name)}">
        ${t('action.edit') || 'Edit'}
      </button>
    </td>
  `;
}

function renderGroupConversationRow(tbody, conv) {
  const groupId = conv.groupId || conv.conversationId;
  const groupKey = `${conv.self}::${groupId}`;
  const members = (conv.members || []).filter(member => memberMatchesSearch(member));
  const expanded = rolesExpandedGroups.has(groupKey) || (!!rolesSearchTerm && members.length > 0);
  const assignedRole = conv.source === 'assignment' ? (conv.assignment?.role || conv.role || '') : '';
  const row = tbody.insertRow();
  row.className = 'group-conversation-row';
  row.innerHTML = `
    <td>
      <button class="group-expand-btn" data-group-key="${esc(groupKey)}" title="${expanded ? 'Collapse' : 'Expand'}">${expanded ? '-' : '+'}</button>
      <span class="chat-tag chat-tag-group">${esc(t('roles.chatType.group') || 'Group')}</span>
    </td>
    <td><strong>${esc(conv.groupName || conv.name || groupId)}</strong></td>
    <td><code>${esc(groupId)}</code></td>
    <td>-</td>
    <td><span class="role-badge role-${esc(roleClass(conv.role))}">${esc(conv.role || 'guest')}</span></td>
    <td><span class="role-source">${esc(roleSourceLabel(conv.source))}</span></td>
    <td>
      <button class="edit-peer-role-btn"
              data-aid="${esc(conv.self)}"
              data-scope="group"
              data-group-id="${esc(groupId)}"
              data-role="${esc(conv.role || '')}"
              data-assigned-role="${esc(assignedRole)}"
              data-label="${esc(conv.groupName || conv.name || groupId)}">
        ${t('action.edit') || 'Edit'}
      </button>
    </td>
  `;

  if (!expanded) return;
  if (members.length === 0) {
    const empty = tbody.insertRow();
    empty.className = 'group-member-row group-member-empty';
    empty.innerHTML = `<td></td><td colspan="6">No group member message records</td>`;
    return;
  }
  members.forEach(member => renderGroupMemberRow(tbody, conv, member));
}

function renderGroupMemberRow(tbody, conv, member) {
  const groupId = conv.groupId || conv.conversationId;
  const peerId = member.peerId || member.peerAid || member.peerKey;
  const name = member.peerName || shortAid(peerId);
  const assignedRole = member.source === 'assignment' ? (member.assignment?.role || member.role || '') : '';
  const row = tbody.insertRow();
  row.className = 'group-member-row';
  row.innerHTML = `
    <td></td>
    <td><span class="group-member-indent">${esc(name)}</span></td>
    <td><code>${esc(peerId)}</code></td>
    <td>${esc(peerTypeText(member.peerType))}</td>
    <td><span class="role-badge role-${esc(roleClass(member.role))}">${esc(member.role || 'guest')}</span></td>
    <td><span class="role-source">${esc(roleSourceLabel(member.source))}</span></td>
    <td>
      <button class="edit-peer-role-btn"
              data-aid="${esc(conv.self)}"
              data-scope="group-member"
              data-group-id="${esc(groupId)}"
              data-peer-id="${esc(peerId)}"
              data-role="${esc(member.role || '')}"
              data-assigned-role="${esc(assignedRole)}"
              data-label="${esc(name)}">
        ${t('action.edit') || 'Edit'}
      </button>
    </td>
  `;
}

async function updatePeerRoleOverride(agentAid, scope, targetId, role, groupId, peerId) {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const body = { scope };
    if (groupId) body.groupId = groupId;
    if (peerId) body.peerId = peerId;
    if (role) body.role = role;

    const res = await fetch(apiUrl(`api/assignments/peer/${encodeURIComponent(agentAid)}/${encodeURIComponent(targetId)}`), {
      method: role ? 'PUT' : 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json();
      alert(t('roleDefs.saveFailed') + ': ' + (err.error || 'unknown'));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[updatePeerRoleOverride] Exception:', err);
    alert(t('pair.error.network') + ': ' + err.message);
    return false;
  }
}

let _rolesTabBound = false;
function initRolesTab() {
  if (_rolesTabBound) return;
  _rolesTabBound = true;

  const agentSelect = $('#roles-agent-select');
  if (agentSelect) {
    agentSelect.addEventListener('change', (e) => {
      rolesCurrentAgent = e.target.value;
      if (state.roles) renderRelationsTable(state.roles, rolesCurrentAgent || null);
    });
  }

  const searchInput = $('#peer-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      rolesSearchTerm = e.target.value.trim();
      if (state.roles) renderRelationsTable(state.roles, rolesCurrentAgent || null);
    });
  }

  const verifyFilter = $('#filter-verify');
  if (verifyFilter) {
    verifyFilter.addEventListener('change', (e) => {
      rolesVerifyFilter = e.target.value;
      if (state.roles) renderRelationsTable(state.roles, rolesCurrentAgent || null);
    });
  }

  const chatTypeFilter = $('#filter-chattype');
  if (chatTypeFilter) {
    chatTypeFilter.addEventListener('change', (e) => {
      rolesChatTypeFilter = e.target.value;
      if (state.roles) renderRelationsTable(state.roles, rolesCurrentAgent || null);
    });
  }

  const relationsTable = $('#relations-table');
  if (relationsTable) {
    relationsTable.addEventListener('click', (e) => {
      const expandBtn = e.target.closest('.group-expand-btn');
      if (expandBtn) {
        const key = expandBtn.dataset.groupKey;
        if (rolesExpandedGroups.has(key)) rolesExpandedGroups.delete(key);
        else rolesExpandedGroups.add(key);
        if (state.roles) renderRelationsTable(state.roles, rolesCurrentAgent || null);
        return;
      }

      const btn = e.target.closest('.edit-peer-role-btn');
      if (!btn) return;
      openPeerRoleModal({
        agentAid: btn.dataset.aid,
        scope: btn.dataset.scope || 'private',
        peerId: btn.dataset.peerId || '',
        groupId: btn.dataset.groupId || '',
        effectiveRole: btn.dataset.role || '',
        assignedRole: btn.dataset.assignedRole || '',
        label: btn.dataset.label || btn.dataset.peerId || btn.dataset.groupId,
      });
    });
  }

  const modal = $('#peer-role-modal');
  const closeBtn = $('#peer-role-close');
  const cancelBtn = $('#peer-role-cancel');
  if (closeBtn) closeBtn.addEventListener('click', closePeerRoleModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closePeerRoleModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closePeerRoleModal();
    });
  }

  const saveBtn = $('#peer-role-save');
  if (saveBtn) saveBtn.addEventListener('click', savePeerRole);
}

function openPeerRoleModal(options) {
  const modal = $('#peer-role-modal');
  const title = $('#peer-role-title');
  const body = $('#peer-role-body');
  if (!modal || !body) return;

  const { agentAid, scope, peerId, groupId, effectiveRole, assignedRole, label } = options;
  if (title) title.textContent = `${t('roles.editPeerRole') || 'Edit Peer Role'}: ${label || peerId || groupId}`;

  const builtinRoles = ['owner', 'admin', 'member', 'guest', 'anonymous'];
  const definedRoles = state.roleDefinitions?.roles ? Object.keys(state.roleDefinitions.roles) : [];
  const roles = Array.from(new Set([...builtinRoles, ...definedRoles]));
  body.innerHTML = `
    <div style="margin-bottom: 16px;">
      <label style="display: block; margin-bottom: 8px; font-weight: 500;">
        ${t('roles.selectRole') || 'Select Role'}:
      </label>
      <select id="peer-role-select" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--ink);">
        <option value="" ${assignedRole ? '' : 'selected'}>${currentLang === 'zh-CN' ? '使用继承/默认角色' : 'Use inherited/default role'}</option>
        ${roles.map(r => `<option value="${esc(r)}" ${r === assignedRole ? 'selected' : ''}>${esc(t(ROLE_NAMES[r] || r) || r)}${!assignedRole && r === effectiveRole ? ' *' : ''}</option>`).join('')}
      </select>
    </div>
    <p style="font-size: 12px; color: var(--dim); margin-top: 12px;">
      ${t('roles.editHint') || 'Role changes will update role-assignments.'}
    </p>
  `;

  modal.dataset.agentAid = agentAid || '';
  modal.dataset.scope = scope || 'private';
  modal.dataset.peerId = peerId || '';
  modal.dataset.groupId = groupId || '';
  modal.dataset.assignedRole = assignedRole || '';
  modal.style.display = 'flex';
}

function closePeerRoleModal() {
  const modal = $('#peer-role-modal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.dataset.agentAid = '';
  modal.dataset.scope = '';
  modal.dataset.peerId = '';
  modal.dataset.groupId = '';
  modal.dataset.assignedRole = '';
}

function savePeerRole() {
  const modal = $('#peer-role-modal');
  const select = $('#peer-role-select');
  if (!modal || !select) return;

  const agentAid = modal.dataset.agentAid;
  const scope = modal.dataset.scope || 'private';
  const peerId = modal.dataset.peerId || '';
  const groupId = modal.dataset.groupId || '';
  const assignedRole = modal.dataset.assignedRole || '';
  const newRole = select.value || '';

  if (!agentAid || (scope === 'private' && !peerId) || (scope === 'group' && !groupId) || (scope === 'group-member' && (!groupId || !peerId))) {
    alert(t('pair.error.failed') + ': missing role assignment target');
    return;
  }

  if (newRole === assignedRole) {
    closePeerRoleModal();
    return;
  }

  const targetId = scope === 'group' ? groupId : peerId;
  updatePeerRoleOverride(agentAid, scope, targetId, newRole, groupId, peerId).then(ok => {
    if (!ok) return;
    closePeerRoleModal();
    subscribe('roles', {});
  }).catch(err => {
    alert(t('common.error') + ': ' + err.message);
  });
}

// ========== Role Definitions Tab ==========
const ROLE_ICONS = {
  owner: '👑',
  admin: '🛡️',
  member: '👥',
  guest: '👤',
  anonymous: '🚫'
};

const ROLE_NAMES = {
  owner: 'roleDefs.owner',
  admin: 'roleDefs.admin',
  member: 'roleDefs.member',
  guest: 'roleDefs.guest',
  anonymous: 'roleDefs.anonymous'
};

function renderRoleDefinitions(data) {
  console.log('[roleDefinitions] renderRoleDefinitions called with data:', data);

  const grid = $('#role-cards-grid');
  if (!grid) {
    console.error('[roleDefinitions] Grid element not found (#role-cards-grid)');
    return;
  }

  if (!data) {
    console.warn('[roleDefinitions] No data received');
    grid.innerHTML = '<div class="role-error">❌ 未收到角色定义数据</div>';
    return;
  }

  if (!data.roles) {
    console.warn('[roleDefinitions] Data received but no roles field:', data);
    grid.innerHTML = '<div class="role-error">❌ 角色定义数据格式错误（缺少 roles 字段）</div>';
    return;
  }

  if (Object.keys(data.roles).length === 0) {
    console.warn('[roleDefinitions] Roles object is empty');
    grid.innerHTML = '<div class="role-error">⚠️ 暂无角色定义</div>';
    return;
  }

  // 渲染全局默认角色选择器
  renderDefaultRoleSelector(data);

  console.log('[roleDefinitions] Rendering', Object.keys(data.roles).length, 'roles');
  grid.innerHTML = '';

  Object.entries(data.roles).forEach(([roleName, roleDef]) => {
    try {
      const card = createRoleCard(roleName, roleDef);
      grid.appendChild(card);
    } catch (err) {
      console.error(`[roleDefinitions] Failed to create card for role ${roleName}:`, err);
    }
  });
}

function renderDefaultRoleSelector(data) {
  const container = $('#role-default-selector');
  if (!container) return;

  const defaults = {
    private: data.defaultRoles?.private || 'anonymous',
    group: data.defaultRoles?.group || 'guest',
  };

  const roleOptions = Object.keys(data.roles || {}).map(roleName =>
    `<option value="${esc(roleName)}">${esc(ROLE_NAMES[roleName] ? t(ROLE_NAMES[roleName]) : roleName)}</option>`
  ).join('');

  container.innerHTML = `
    <label class="role-default-label">
      <span>${currentLang === 'zh-CN' ? '私聊默认角色:' : 'Private default role:'}</span>
      <select id="default-private-role-select" class="form-select">${roleOptions}</select>
    </label>
    <label class="role-default-label">
      <span>${currentLang === 'zh-CN' ? '群聊默认角色:' : 'Group default role:'}</span>
      <select id="default-group-role-select" class="form-select">${roleOptions}</select>
    </label>
    <small style="color: var(--dim);">${currentLang === 'zh-CN' ? '私聊和群聊使用独立的默认角色。' : 'Private and group conversations use separate fallback roles.'}</small>
  `;

  const privateSelect = $('#default-private-role-select');
  const groupSelect = $('#default-group-role-select');
  if (!privateSelect || !groupSelect) return;
  privateSelect.value = defaults.private;
  groupSelect.value = defaults.group;

  const save = async () => {
    const next = { private: privateSelect.value, group: groupSelect.value };
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const writeRes = await fetch(apiUrl('api/role-definitions'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ defaultRoles: next })
      });

      if (!writeRes.ok) {
        let detail = '';
        try { detail = (await writeRes.json()).error || ''; } catch {}
        alert('保存默认角色失败' + (detail ? ': ' + detail : ''));
        privateSelect.value = defaults.private;
        groupSelect.value = defaults.group;
      }
    } catch (err) {
      console.error('[roleDefinitions] Failed to save defaultRoles:', err);
      alert('网络错误');
      privateSelect.value = defaults.private;
      groupSelect.value = defaults.group;
    }
  };

  privateSelect.onchange = save;
  groupSelect.onchange = save;
}

const COMMAND_PERMISSION_SCOPE_VALUES = ['relation', 'role', 'agent', 'process', 'filesystem', 'control', 'raw-cli'];
const COMMAND_PERMISSION_CATEGORY_ORDER = ['read', 'diagnose', 'write-own', 'write-agent', 'process', 'dangerous'];
const COMMAND_PERMISSION_BOOLEAN_CONSTRAINTS = [
  'ownPeerOnly',
  'ownAgentOnly',
  'privateOnly',
  'groupOnly',
  'requireDaemonOwner',
  'requireControlChannel',
  'requireExplicitDangerousGrant'
];
let roleOperationsCache = null;

function getCommandPermissionsObject(commandPermissions) {
  return commandPermissions && typeof commandPermissions === 'object' && !Array.isArray(commandPermissions)
    ? commandPermissions
    : {};
}

function getCommandPermissionStats(commandPermissions) {
  const entries = Object.values(getCommandPermissionsObject(commandPermissions));
  return entries.reduce((stats, permission) => {
    const perm = permission && typeof permission === 'object' ? permission : {};
    stats.total += 1;
    if (perm.allow === true) stats.allow += 1;
    else if (perm.allow === false) stats.deny += 1;
    if (perm.dangerous === true) stats.dangerous += 1;
    return stats;
  }, { total: 0, allow: 0, deny: 0, dangerous: 0 });
}

function formatCommandPermissions(commandPermissions) {
  return JSON.stringify(getCommandPermissionsObject(commandPermissions), null, 2);
}

async function fetchRoleOperationsCatalog() {
  if (roleOperationsCache) return roleOperationsCache;
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(apiUrl('api/role-definitions/operations'), {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Failed to load CLI operation catalog');
  const json = await res.json();
  roleOperationsCache = Array.isArray(json.operations) ? json.operations : [];
  return roleOperationsCache;
}

async function loadRoleOperationsForEditor() {
  try {
    return await fetchRoleOperationsCatalog();
  } catch (err) {
    console.warn('[roleDefinitions] Failed to load CLI operation catalog:', err);
    return [];
  }
}

function commandCategoryLabel(category) {
  const labels = {
    read: currentLang === 'zh-CN' ? '读取' : 'Read',
    diagnose: currentLang === 'zh-CN' ? '诊断' : 'Diagnose',
    'write-own': currentLang === 'zh-CN' ? '写入本人范围' : 'Write Own',
    'write-agent': currentLang === 'zh-CN' ? '写入 Agent' : 'Write Agent',
    process: currentLang === 'zh-CN' ? '进程/系统' : 'Process',
    dangerous: currentLang === 'zh-CN' ? '危险操作' : 'Dangerous',
  };
  return labels[category] || category;
}

function commandConstraintLabel(key) {
  const labels = {
    ownPeerOnly: currentLang === 'zh-CN' ? '仅本人 Peer' : 'Own peer only',
    ownAgentOnly: currentLang === 'zh-CN' ? '仅当前 Agent' : 'Own agent only',
    privateOnly: currentLang === 'zh-CN' ? '仅私聊' : 'Private only',
    groupOnly: currentLang === 'zh-CN' ? '仅群聊' : 'Group only',
    requireDaemonOwner: currentLang === 'zh-CN' ? '需要 daemon owner' : 'Require daemon owner',
    requireControlChannel: currentLang === 'zh-CN' ? '需要控制通道' : 'Require control channel',
    requireExplicitDangerousGrant: currentLang === 'zh-CN' ? '需要危险授权' : 'Require dangerous grant',
  };
  return labels[key] || key;
}

function getCommandRuleRank(rule, permission, operation) {
  const namespace = operation.id.split('.')[0];
  const denyOffset = permission?.allow ? 0 : 1;
  if (rule === operation.id) return 1000 + denyOffset;
  if (rule === `${namespace}.*`) return 800 + denyOffset;
  if (rule.startsWith('category:') && rule.slice('category:'.length) === operation.category) return 600 + denyOffset;
  if (rule === 'dangerous:*' && operation.dangerous) return 400 + denyOffset;
  if (rule === '*' && !operation.dangerous) return 200 + denyOffset;
  return 0;
}

function getEffectiveCommandPermission(operation, commandPermissions) {
  const permissions = getCommandPermissionsObject(commandPermissions);
  let best = null;
  Object.entries(permissions).forEach(([rule, permission]) => {
    if (!permission || typeof permission !== 'object') return;
    const rank = getCommandRuleRank(rule, permission, operation);
    if (rank > 0 && (!best || rank > best.rank)) {
      best = { rule, permission, rank };
    }
  });
  return best;
}

function getCommandPermissionScopes(operation, permission) {
  const scopes = Array.isArray(permission?.scopes) && permission.scopes.length
    ? permission.scopes
    : (Array.isArray(operation.defaultScopes) ? operation.defaultScopes : []);
  return new Set(scopes);
}

function renderCommandScopeControls(operation, permission) {
  const selected = getCommandPermissionScopes(operation, permission);
  return COMMAND_PERMISSION_SCOPE_VALUES.map(scope => `
    <label class="cli-scope-option">
      <input type="checkbox"
             data-command-scope="${esc(scope)}"
             ${selected.has(scope) ? 'checked' : ''}>
      <span>${esc(scope)}</span>
    </label>
  `).join('');
}

function renderCommandConstraintControls(permission) {
  const constraints = permission?.constraints && typeof permission.constraints === 'object'
    ? permission.constraints
    : {};
  return `
    <div class="cli-constraint-grid">
      ${COMMAND_PERMISSION_BOOLEAN_CONSTRAINTS.map(key => `
        <label class="cli-constraint-option">
          <input type="checkbox"
                 data-command-constraint="${esc(key)}"
                 ${constraints[key] ? 'checked' : ''}>
          <span>${esc(commandConstraintLabel(key))}</span>
        </label>
      `).join('')}
    </div>
    <label class="cli-field-row">
      <span>requireFieldOverride</span>
      <input type="text"
             class="form-input"
             data-command-field="requireFieldOverride"
             value="${esc(constraints.requireFieldOverride || '')}"
             placeholder="baseagents.claude.model">
    </label>
  `;
}

function groupCommandOperations(operations) {
  const groups = new Map();
  COMMAND_PERMISSION_CATEGORY_ORDER.forEach(category => groups.set(category, []));
  (operations || []).forEach(operation => {
    const category = operation.category || 'other';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(operation);
  });
  return [...groups.entries()].filter(([, items]) => items.length > 0);
}

function renderCommandPermissionRow(operation, commandPermissions, readonly = false) {
  const match = getEffectiveCommandPermission(operation, commandPermissions);
  const permission = match?.permission || {};
  const allowed = permission.allow === true;
  const denied = match ? permission.allow === false : true;
  const status = allowed ? 'allow' : 'deny';
  const statusText = allowed
    ? (currentLang === 'zh-CN' ? '允许' : 'Allowed')
    : (denied && match ? (currentLang === 'zh-CN' ? '拒绝' : 'Denied') : (currentLang === 'zh-CN' ? '未授权' : 'No rule'));
  const scopes = getCommandPermissionScopes(operation, permission);
  const sourceText = Array.isArray(operation.sources) ? operation.sources.join(', ') : '—';
  const matchedRule = match?.rule || '—';
  const description = operation.description || '';

  if (readonly) {
    return `
      <div class="cli-permission-row readonly ${status}">
        <div class="cli-op-main">
          <div class="cli-op-title">
            <code>${esc(operation.id)}</code>
            <span class="cli-status ${status}">${esc(statusText)}</span>
            ${operation.dangerous ? '<span class="cli-danger">dangerous</span>' : ''}
          </div>
          <div class="cli-op-desc">${esc(description)}</div>
          <div class="cli-op-meta">category=${esc(operation.category)} · scopes=${esc([...scopes].join(', ') || '—')} · sources=${esc(sourceText)} · rule=${esc(matchedRule)}</div>
        </div>
      </div>
    `;
  }

  return `
    <div class="cli-permission-row ${status}"
         data-command-operation="${esc(operation.id)}"
         data-command-dangerous="${operation.dangerous ? 'true' : 'false'}">
      <div class="cli-op-main">
        <div class="cli-op-title">
          <code>${esc(operation.id)}</code>
          <span class="cli-status ${status}">${esc(statusText)}</span>
          ${operation.dangerous ? '<span class="cli-danger">dangerous</span>' : ''}
        </div>
        <div class="cli-op-desc">${esc(description)}</div>
        <div class="cli-op-meta">category=${esc(operation.category)} · sources=${esc(sourceText)} · matched rule=${esc(matchedRule)}</div>
      </div>
      <div class="cli-op-controls">
        <label class="cli-field-row compact">
          <span>${currentLang === 'zh-CN' ? '授权' : 'Grant'}</span>
          <select class="form-select" data-command-field="decision">
            <option value="keep">${currentLang === 'zh-CN' ? '保持当前' : 'Keep current'}</option>
            <option value="allow">${currentLang === 'zh-CN' ? '允许' : 'Allow'}</option>
            <option value="deny">${currentLang === 'zh-CN' ? '拒绝' : 'Deny'}</option>
            <option value="remove">${currentLang === 'zh-CN' ? '移除精确规则' : 'Remove exact rule'}</option>
          </select>
        </label>
        <label class="cli-danger-grant">
          <input type="checkbox"
                 data-command-field="dangerousGrant"
                 ${operation.dangerous && (permission.dangerous || allowed) ? 'checked' : ''}
                 ${operation.dangerous ? '' : 'disabled'}>
          <span>${currentLang === 'zh-CN' ? '危险授权' : 'Dangerous grant'}</span>
        </label>
      </div>
      <details class="cli-advanced">
        <summary>${currentLang === 'zh-CN' ? 'Scopes 与约束' : 'Scopes and constraints'}</summary>
        <div class="cli-advanced-grid">
          <div>
            <div class="cli-subtitle">Scopes</div>
            <div class="cli-scope-grid">${renderCommandScopeControls(operation, permission)}</div>
          </div>
          <div>
            <div class="cli-subtitle">${currentLang === 'zh-CN' ? '约束' : 'Constraints'}</div>
            ${renderCommandConstraintControls(permission)}
          </div>
          <label class="cli-field-row cli-reason">
            <span>Reason</span>
            <input type="text"
                   class="form-input"
                   data-command-field="reason"
                   value="${esc(permission.reason || '')}">
          </label>
        </div>
      </details>
    </div>
  `;
}

function renderCommandPermissionsList(roleDef, operations, readonly = false) {
  if (!operations || operations.length === 0) {
    return `<div class="model-empty">${currentLang === 'zh-CN' ? '未加载到 CLI 清单' : 'No CLI operations loaded.'}</div>`;
  }

  const commandPermissions = getCommandPermissionsObject(roleDef?.commandPermissions);
  return groupCommandOperations(operations).map(([category, items]) => `
    <section class="cli-category-section">
      <h5>${esc(commandCategoryLabel(category))} <span>${items.length}</span></h5>
      <div class="cli-permission-list">
        ${items.map(operation => renderCommandPermissionRow(operation, commandPermissions, readonly)).join('')}
      </div>
    </section>
  `).join('');
}

function renderCommandPermissionsEditor(roleDef, operations) {
  const stats = getCommandPermissionStats(roleDef?.commandPermissions);
  return `
    <div class="form-section command-permissions-section">
      <h4>Command / CLI Permissions</h4>
      <div class="cli-summary">
        <span>${stats.total} rules</span>
        <span>${stats.allow} allow</span>
        <span>${stats.deny} deny</span>
        <span>${stats.dangerous} dangerous</span>
      </div>
      <div class="cli-help">
        ${currentLang === 'zh-CN'
          ? '清单来自后端 operation registry。每行显示当前有效权限和命中的规则；修改后会写入精确 operation 规则。若要撤销内置继承规则，请对同名 operation 设置“拒绝”。'
          : 'The list comes from the backend operation registry. Each row shows the current effective permission and matched rule. Changes are saved as exact operation rules.'}
      </div>
      ${renderCommandPermissionsList(roleDef, operations, false)}
    </div>
  `;
}

function validateCommandPermissionsClient(commandPermissions) {
  if (!commandPermissions || typeof commandPermissions !== 'object' || Array.isArray(commandPermissions)) {
    return 'Command permissions must be a JSON object.';
  }

  for (const [rule, permission] of Object.entries(commandPermissions)) {
    if (!permission || typeof permission !== 'object' || Array.isArray(permission)) {
      return `Command permission "${rule}" must be an object.`;
    }
    if (typeof permission.allow !== 'boolean') {
      return `Command permission "${rule}" must include boolean allow.`;
    }
    if (permission.dangerous !== undefined && typeof permission.dangerous !== 'boolean') {
      return `Command permission "${rule}" dangerous must be a boolean.`;
    }
    if (permission.scopes !== undefined) {
      if (!Array.isArray(permission.scopes)) {
        return `Command permission "${rule}" scopes must be an array.`;
      }
      const badScope = permission.scopes.find(scope => !COMMAND_PERMISSION_SCOPE_VALUES.includes(scope));
      if (badScope) return `Command permission "${rule}" has unsupported scope: ${badScope}.`;
    }
    if (permission.constraints !== undefined && (
      !permission.constraints ||
      typeof permission.constraints !== 'object' ||
      Array.isArray(permission.constraints)
    )) {
      return `Command permission "${rule}" constraints must be an object.`;
    }
  }

  return '';
}

function collectCommandPermissions(container, fallback = {}) {
  const rows = Array.from(container.querySelectorAll('[data-command-operation]'));
  if (rows.length === 0) {
    const input = container.querySelector('#edit-commandPermissions');
    if (!input) return { ok: true, value: getCommandPermissionsObject(fallback) };
    try {
      const parsed = JSON.parse(input.value.trim() || '{}');
      const validationError = validateCommandPermissionsClient(parsed);
      if (validationError) return { ok: false, error: validationError };
      return { ok: true, value: parsed };
    } catch (err) {
      return { ok: false, error: `Command permissions JSON is invalid: ${err.message}` };
    }
  }

  const operationsById = new Map((roleOperationsCache || []).map(operation => [operation.id, operation]));
  const commandPermissions = { ...getCommandPermissionsObject(fallback) };

  for (const row of rows) {
    const operationId = row.dataset.commandOperation;
    const operation = operationsById.get(operationId);
    if (!operation) continue;

    const decision = row.querySelector('[data-command-field="decision"]')?.value || 'keep';
    const dirty = row.dataset.commandDirty === 'true';
    if (decision === 'keep' && !dirty) continue;

    if (decision === 'remove') {
      delete commandPermissions[operationId];
      continue;
    }

    const match = getEffectiveCommandPermission(operation, commandPermissions);
    const basePermission = commandPermissions[operationId] || match?.permission || {};
    const nextAllow = decision === 'allow'
      ? true
      : decision === 'deny'
        ? false
        : basePermission.allow === true;

    const scopes = Array.from(row.querySelectorAll('[data-command-scope]:checked'))
      .map(input => input.dataset.commandScope)
      .filter(Boolean);
    if (nextAllow && scopes.length === 0) {
      return { ok: false, error: `Command permission "${operationId}" must allow at least one scope.` };
    }

    const constraints = { ...(basePermission.constraints || {}) };
    COMMAND_PERMISSION_BOOLEAN_CONSTRAINTS.forEach(key => {
      delete constraints[key];
    });
    row.querySelectorAll('[data-command-constraint]').forEach(input => {
      const key = input.dataset.commandConstraint;
      if (key && input.checked) constraints[key] = true;
    });

    const requireFieldOverride = row.querySelector('[data-command-field="requireFieldOverride"]')?.value.trim();
    if (requireFieldOverride) constraints.requireFieldOverride = requireFieldOverride;
    else delete constraints.requireFieldOverride;

    const dangerousGrant = !!row.querySelector('[data-command-field="dangerousGrant"]')?.checked;
    const reason = row.querySelector('[data-command-field="reason"]')?.value.trim();

    const nextPermission = {
      ...basePermission,
      allow: nextAllow,
    };
    if (nextAllow) nextPermission.scopes = scopes;
    else delete nextPermission.scopes;
    if (operation.dangerous || dangerousGrant) nextPermission.dangerous = operation.dangerous ? true : dangerousGrant;
    else delete nextPermission.dangerous;
    if (Object.keys(constraints).length) nextPermission.constraints = constraints;
    else delete nextPermission.constraints;
    if (reason) nextPermission.reason = reason;
    else delete nextPermission.reason;

    commandPermissions[operationId] = nextPermission;
  }

  const validationError = validateCommandPermissionsClient(commandPermissions);
  if (validationError) return { ok: false, error: validationError };
  return { ok: true, value: commandPermissions };
}

function createRoleCard(roleName, roleDef) {
  const card = document.createElement('div');
  card.className = `role-card role-${roleName}`;

  const icon = ROLE_ICONS[roleName] || '📋';
  const nameKey = ROLE_NAMES[roleName] || roleName;
  const permMode = roleDef.permissions?.permissionMode?.default || '—';
  const model = roleDef.permissions?.['baseagents.claude.model']?.default || '—';
  const commandStats = getCommandPermissionStats(roleDef.commandPermissions);

  // 判断是否为内置角色
  const builtinRoles = ['owner', 'admin', 'member', 'guest', 'anonymous'];
  const isBuiltin = builtinRoles.includes(roleName);

  card.innerHTML = `
    <div class="role-card-header">
      <span class="role-icon">${icon}</span>
      <h3 class="role-name" data-i18n="${nameKey}">${t(nameKey)}</h3>
      ${!isBuiltin ? '<span class="role-custom-badge">自定义</span>' : ''}
    </div>
    <p class="role-description">${esc(roleDef.description || '')}</p>
    <div class="role-preview">
      <div class="role-preview-item">
        <span class="label">${t('roleDefs.permissionMode')}:</span>
        <span class="value">${esc(permMode)}</span>
      </div>
      <div class="role-preview-item">
        <span class="label">${t('roleDefs.model')}:</span>
        <span class="value">${esc(model)}</span>
      </div>
      <div class="role-preview-item">
        <span class="label">CLI rules:</span>
        <span class="value">${commandStats.total} (${commandStats.allow} allow / ${commandStats.deny} deny)</span>
      </div>
      <div class="role-preview-item">
        <span class="label">Dangerous:</span>
        <span class="value">${commandStats.dangerous}</span>
      </div>
    </div>
    <div class="role-card-actions">
      <button class="btn-view-role" data-role="${roleName}">${t('roleDefs.viewDetails')}</button>
      <button class="btn-edit-role" data-role="${roleName}">${t('roleDefs.edit')}</button>
      ${isBuiltin ? `<button class="btn-reset-role" data-role="${roleName}">${t('roleDefs.reset')}</button>` :
                    `<button class="btn-delete-role" data-role="${roleName}">删除</button>`}
    </div>
  `;

  return card;
}

let _roleDefinitionsTabBound = false;
function initRoleDefinitionsTab() {
  if (_roleDefinitionsTabBound) return;
  _roleDefinitionsTabBound = true;

  // 新增角色按钮
  $('#btn-new-role')?.addEventListener('click', () => {
    showNewRoleModal();
  });

  // View Details 按钮
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.btn-view-role');
    if (btn) {
      const roleName = btn.dataset.role;
      if (state.roleDefinitions?.roles[roleName]) {
        showRoleDetailsModal(roleName, state.roleDefinitions.roles[roleName]);
      }
    }
  });

  // Edit 按钮
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.btn-edit-role');
    if (btn) {
      const roleName = btn.dataset.role;
      if (state.roleDefinitions?.roles[roleName]) {
        showRoleEditModal(roleName, state.roleDefinitions.roles[roleName]);
      }
    }
  });

  // Reset 按钮
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('.btn-reset-role');
    if (btn) {
      const roleName = btn.dataset.role;
      const confirmMsg = t('roleDefs.resetConfirm').replace('{role}', roleName);

      if (!confirm(confirmMsg)) return;

      try {
        const token = localStorage.getItem(TOKEN_KEY);
        const res = await fetch(apiUrl(`api/role-definitions/${roleName}/reset`), {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) {
          alert(t('roleDefs.saveFailed'));
        } else {
          alert(t('roleDefs.saveSuccess'));
        }
      } catch (err) {
        alert(t('pair.error.network'));
      }
    }
  });

  // 删除角色按钮
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('.btn-delete-role');
    if (btn) {
      const roleName = btn.dataset.role;

      if (!confirm(`确定要删除角色 "${roleName}" 吗？\n\n注意：内置角色（owner/admin/member/guest/anonymous）不能删除。`)) return;

      try {
        const token = localStorage.getItem(TOKEN_KEY);
        const res = await fetch(apiUrl(`api/role-definitions/${roleName}`), {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) {
          const err = await res.json();
          alert(t('roleDefs.saveFailed') + ': ' + (err.error || 'unknown'));
        } else {
          alert('角色已删除');
        }
      } catch (err) {
        alert(t('pair.error.network'));
      }
    }
  });

  // 关闭弹窗
  $('#role-edit-close')?.addEventListener('click', () => {
    $('#role-edit-modal').style.display = 'none';
  });

  $('#role-edit-cancel')?.addEventListener('click', () => {
    $('#role-edit-modal').style.display = 'none';
  });

  // 保存按钮
  $('#role-edit-save')?.addEventListener('click', async () => {
    await saveRoleDefinition();
  });
}

const CLAUDE_MODEL_PERMISSION_KEY = 'baseagents.claude.model';
const CLAUDE_ALLOWED_MODELS_LEGACY_KEY = 'baseagents.claude.allowedModels';
const DEFAULT_MODEL_PATTERN_OPTIONS = ['*', 'claude-opus-*', 'claude-sonnet-*', 'claude-haiku-*'];

function getClaudeModelPermission(roleDef) {
  const perm = roleDef?.permissions?.[CLAUDE_MODEL_PERMISSION_KEY];
  return perm && typeof perm === 'object' ? perm : null;
}

function normalizeAllowedModels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  value.forEach(item => {
    if (typeof item !== 'string') return;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  });
  return out;
}

function inferModelSelectionMode(allowedModels) {
  const list = normalizeAllowedModels(allowedModels);
  if (!list.length) return 'explicit';
  const patternCount = list.filter(m => m === '*' || m.endsWith('*')).length;
  if (patternCount === list.length) return 'pattern';
  if (patternCount === 0) return 'explicit';
  return 'mixed';
}

function modelAllowedByPatterns(model, allowedModels) {
  const list = normalizeAllowedModels(allowedModels);
  if (list.includes('*')) return true;
  return list.some(pattern => {
    if (pattern.endsWith('*')) return model.startsWith(pattern.slice(0, -1));
    return model === pattern;
  });
}

function renderRoleModelPermissionSection(roleDef) {
  const perm = getClaudeModelPermission(roleDef);
  if (!perm) return '';

  const allowedModels = normalizeAllowedModels(perm.allowedModels);
  const selectionMode = inferModelSelectionMode(allowedModels);
  const patternOptions = DEFAULT_MODEL_PATTERN_OPTIONS;

  return `
    <div class="form-group perm-group model-permissions-panel" data-model-permissions>
      <div class="perm-header">
        <label class="perm-label">${esc(t('roleDefs.model'))}</label>
        <label class="perm-override">
          <input type="checkbox"
                 data-model-field="allowOverride"
                 ${perm.allowOverride ? 'checked' : ''}>
          <span>${t('roleDefs.allowOverride')}</span>
        </label>
      </div>

      <label class="model-field-label">Default model</label>
      <input type="text"
             data-model-field="default"
             value="${esc(perm.default || '')}"
             list="role-model-options"
             class="form-input">
      <datalist id="role-model-options"></datalist>

      <label class="model-field-label">${t('roleDefs.allowedModels')}</label>
      <div class="model-allowed-editor">
        <div class="model-allowed-list" data-model-allowed-list></div>
        <div class="model-allowed-add">
          <input type="text"
                 class="form-input model-allowed-input"
                 data-model-allowed-input
                 list="role-model-options"
                 placeholder="${currentLang === 'zh-CN' ? '输入模型 ID 或通配模式' : 'Model ID or wildcard pattern'}">
          <button type="button" class="btn-secondary" data-model-allowed-add>${currentLang === 'zh-CN' ? '添加' : 'Add'}</button>
        </div>
      </div>

      <div class="model-mode-tabs">
        ${['pattern', 'explicit', 'mixed'].map(mode => `
          <label class="model-mode-option">
            <input type="radio"
                   name="role-model-selection-mode"
                   value="${mode}"
                   ${selectionMode === mode ? 'checked' : ''}>
            <span>${mode}</span>
          </label>
        `).join('')}
        <span class="model-mode-note">derived from allowedModels</span>
      </div>

      <div class="model-mode-panel" data-model-panel="pattern">
        <div class="model-option-grid">
          ${patternOptions.map(pattern => `
            <label class="model-option">
              <input type="checkbox"
                     class="model-pattern-checkbox"
                     value="${esc(pattern)}"
                     ${allowedModels.includes(pattern) ? 'checked' : ''}>
              <span>${esc(pattern)}</span>
            </label>
          `).join('')}
        </div>
      </div>

      <div class="model-mode-panel" data-model-panel="explicit">
        <div class="model-explicit-list" data-loading="true">Loading models...</div>
      </div>

      <div class="model-preview" data-model-preview>Loading preview...</div>
    </div>
  `;
}

async function fetchRoleModelPermissionData(roleName) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(apiUrl(`api/role-definitions/${encodeURIComponent(roleName)}/configurable-models`), {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Failed to load role model permissions');
  const json = await res.json();
  return json.data;
}

async function fetchModelCatalogData() {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(apiUrl('api/models/catalog?baseagent=claude'), {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Failed to load model catalog');
  const json = await res.json();
  return json.data;
}

function renderModelCatalogControls(section, models, allowedModels) {
  const realModels = (models || []).filter(model => !model.isAlias);
  const datalist = section.querySelector('#role-model-options');
  if (datalist) {
    datalist.innerHTML = realModels
      .map(model => `<option value="${esc(model.id)}"></option>`)
      .join('');
  }

  const explicitList = section.querySelector('.model-explicit-list');
  if (!explicitList) return;

  if (!realModels.length) {
    explicitList.innerHTML = '<div class="model-empty">No catalog models available.</div>';
    return;
  }

  explicitList.innerHTML = realModels.map(model => `
    <label class="model-option model-option-row">
      <input type="checkbox"
             class="model-explicit-checkbox"
             value="${esc(model.id)}"
             ${allowedModels.includes(model.id) ? 'checked' : ''}>
      <span>${esc(model.id)}</span>
      <small>${esc(model.family || model.owned_by || '')}</small>
    </label>
  `).join('');
}

function getRoleAllowedModelsFromList(section) {
  return normalizeAllowedModels(Array.from(section.querySelectorAll('[data-model-allowed-item]'))
    .map(item => item.dataset.modelAllowedItem));
}

function syncModelSelectionMode(section, allowedModels = getRoleAllowedModelsFromList(section)) {
  const mode = inferModelSelectionMode(allowedModels);
  const radio = section.querySelector(`input[name="role-model-selection-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
}

function syncModelCatalogChecks(section, allowedModels = getRoleAllowedModelsFromList(section)) {
  const selected = new Set(allowedModels);
  section.querySelectorAll('.model-pattern-checkbox, .model-explicit-checkbox').forEach(input => {
    input.checked = selected.has(input.value);
  });
  syncModelSelectionMode(section, allowedModels);
}

function renderRoleAllowedModels(section, allowedModels) {
  const list = section.querySelector('[data-model-allowed-list]');
  if (!list) return;

  const normalized = normalizeAllowedModels(allowedModels);
  if (!normalized.length) {
    list.innerHTML = `<div class="model-empty">${currentLang === 'zh-CN' ? '未配置可用模型' : 'No allowed models configured.'}</div>`;
    syncModelCatalogChecks(section, normalized);
    return;
  }

  list.innerHTML = normalized.map(model => `
    <span class="model-allowed-chip" data-model-allowed-item="${esc(model)}">
      <span>${esc(model)}</span>
      <button type="button"
              class="model-allowed-remove"
              data-model-allowed-remove="${esc(model)}"
              aria-label="${currentLang === 'zh-CN' ? '移除模型' : 'Remove model'}">x</button>
    </span>
  `).join('');
  syncModelCatalogChecks(section, normalized);
}

function addRoleAllowedModel(section, value) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model) return false;
  const next = normalizeAllowedModels([...getRoleAllowedModelsFromList(section), model]);
  renderRoleAllowedModels(section, next);
  return true;
}

function collectRoleModelPermission(container) {
  const section = container.matches?.('[data-model-permissions]')
    ? container
    : container.querySelector('[data-model-permissions]');
  if (!section) return null;

  const defaultInput = section.querySelector('[data-model-field="default"]');
  const overrideInput = section.querySelector('[data-model-field="allowOverride"]');

  return {
    default: defaultInput?.value.trim() || '',
    allowOverride: !!overrideInput?.checked,
    allowedModels: getRoleAllowedModelsFromList(section)
  };
}

function validateRoleModelPermissionClient(permission) {
  if (!permission.default) return 'Default model is required.';
  if (!permission.allowedModels.length) return 'At least one allowed model or pattern is required.';
  if (!modelAllowedByPatterns(permission.default, permission.allowedModels)) {
    return 'Default model must be allowed by allowedModels.';
  }
  return '';
}

function renderModelPreview(section, models, errorMessage) {
  const preview = section.querySelector('[data-model-preview]');
  if (!preview) return;

  if (errorMessage) {
    preview.innerHTML = `<span class="model-preview-error">${esc(errorMessage)}</span>`;
    return;
  }

  const shown = (models || []).slice(0, 12);
  const rest = Math.max(0, (models || []).length - shown.length);
  preview.innerHTML = `
    <div class="model-preview-count">${(models || []).length} matched model(s)</div>
    <div class="model-preview-list">
      ${shown.map(model => `<span class="model-chip">${esc(model.id || model)}</span>`).join('')}
      ${rest ? `<span class="model-chip">+${rest}</span>` : ''}
    </div>
  `;
}

async function updateRoleModelPreview(section, roleName) {
  const permission = collectRoleModelPermission(section);
  if (!permission) return;

  const validationError = validateRoleModelPermissionClient(permission);
  if (validationError) {
    renderModelPreview(section, [], validationError);
    return;
  }

  const catalogModels = section._modelCatalog || [];
  const localMatches = catalogModels
    .filter(model => !model.isAlias && modelAllowedByPatterns(model.id, permission.allowedModels));
  renderModelPreview(section, localMatches);

  if (!roleName || roleName === '__new__') return;

  clearTimeout(section._previewTimer);
  section._previewTimer = setTimeout(async () => {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch(apiUrl(`api/role-definitions/${encodeURIComponent(roleName)}/preview-models`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          defaultModel: permission.default,
          allowOverride: permission.allowOverride,
          allowedModels: permission.allowedModels
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        renderModelPreview(section, localMatches, err.error || 'Preview failed');
        return;
      }
      const json = await res.json();
      renderModelPreview(section, json.data?.matchingModels || localMatches);
    } catch (err) {
      renderModelPreview(section, localMatches);
    }
  }, 250);
}

function updateModelModeVisibility(section) {
  const mode = section.querySelector('input[name="role-model-selection-mode"]:checked')?.value || 'explicit';
  section.querySelectorAll('[data-model-panel]').forEach(panel => {
    const panelMode = panel.dataset.modelPanel;
    panel.style.display = (mode === 'mixed' || mode === panelMode) ? '' : 'none';
  });
}

async function initRoleModelPermissionEditor(container, roleName, roleDef) {
  const section = container.querySelector('[data-model-permissions]');
  if (!section) return;

  const initialAllowed = normalizeAllowedModels(getClaudeModelPermission(roleDef)?.allowedModels);
  let catalogModels = [];
  section._initialAllowedModels = initialAllowed;

  try {
    const data = roleName && roleName !== '__new__'
      ? await fetchRoleModelPermissionData(roleName)
      : await fetchModelCatalogData();
    catalogModels = data?.catalog?.models || data?.models || [];
  } catch (err) {
    console.warn('[roleDefinitions] Failed to load model catalog:', err);
  }

  section._modelCatalog = catalogModels;
  renderModelCatalogControls(section, catalogModels, initialAllowed);
  renderRoleAllowedModels(section, initialAllowed);
  updateModelModeVisibility(section);

  section.querySelector('[data-model-allowed-add]')?.addEventListener('click', () => {
    const input = section.querySelector('[data-model-allowed-input]');
    if (addRoleAllowedModel(section, input?.value || '')) {
      if (input) input.value = '';
      updateRoleModelPreview(section, roleName);
    }
  });

  section.querySelector('[data-model-allowed-input]')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (addRoleAllowedModel(section, e.currentTarget.value || '')) {
      e.currentTarget.value = '';
      updateRoleModelPreview(section, roleName);
    }
  });

  section.addEventListener('click', (e) => {
    const remove = e.target.closest?.('[data-model-allowed-remove]');
    if (!remove) return;
    const next = getRoleAllowedModelsFromList(section)
      .filter(model => model !== remove.dataset.modelAllowedRemove);
    renderRoleAllowedModels(section, next);
    updateRoleModelPreview(section, roleName);
  });

  section.addEventListener('change', (e) => {
    const target = e.target;
    if (target?.classList?.contains('model-pattern-checkbox') || target?.classList?.contains('model-explicit-checkbox')) {
      const allowed = new Set(getRoleAllowedModelsFromList(section));
      if (target.checked) allowed.add(target.value);
      else allowed.delete(target.value);
      renderRoleAllowedModels(section, [...allowed]);
    }
    updateModelModeVisibility(section);
    updateRoleModelPreview(section, roleName);
  });
  section.addEventListener('input', (e) => {
    if (e.target?.matches?.('[data-model-allowed-input]')) return;
    updateRoleModelPreview(section, roleName);
  });

  updateRoleModelPreview(section, roleName);
}

async function showNewRoleModal() {
  const modal = $('#role-edit-modal');
  const title = $('#role-edit-title');
  const body = $('#role-edit-body');
  const saveBtn = $('#role-edit-save');

  if (!modal || !title || !body) return;

  title.textContent = '新增自定义角色';
  saveBtn.style.display = 'inline-block';
  saveBtn.dataset.role = '__new__';

  // 基于 member 角色的默认配置
  const defaultDef = state.roleDefinitions?.roles?.member || {
    description: '',
    permissions: {
      permissionMode: { default: 'request', allowOverride: false },
      'baseagents.claude.model': { default: 'claude-sonnet-4', allowOverride: false, allowedModels: ['claude-sonnet-*', 'claude-haiku-*'] },
      dispatch: { default: 'mention', allowOverride: false }
    },
    commandPermissions: {
      'category:read': { allow: true },
      'category:write-own': { allow: true },
      'model.*': { allow: true, scopes: ['relation', 'agent'], constraints: { ownPeerOnly: true, ownAgentOnly: true } },
      'cli.exec.raw': { allow: false, dangerous: true }
    }
  };
  const operations = await loadRoleOperationsForEditor();

  body.innerHTML = `
    <div class="role-edit-form">
      <div class="form-section">
        <h4>角色名称</h4>
        <input type="text"
               id="new-role-name"
               class="form-input"
               placeholder="输入角色名称（如：developer, viewer 等）"
               pattern="[a-z0-9_-]+"
               required>
        <small style="color: var(--dim);">只能包含小写字母、数字、下划线和连字符</small>
      </div>

      <div class="form-section">
        <h4>${t('roleDefs.description')}</h4>
        <textarea id="edit-description" rows="3" class="form-textarea">${esc(defaultDef.description)}</textarea>
      </div>

      <div class="form-section">
        <h4>${currentLang === 'zh-CN' ? '是否允许访问' : 'Allow Access'}</h4>
        <select id="edit-allowAccess" data-value-type="boolean" class="form-select">
          <option value="true" ${(defaultDef.allowAccess ?? true) ? 'selected' : ''}>${currentLang === 'zh-CN' ? '允许 (true)' : 'Allow (true)'}</option>
          <option value="false" ${(defaultDef.allowAccess ?? true) ? '' : 'selected'}>${currentLang === 'zh-CN' ? '拒绝 (false)' : 'Deny (false)'}</option>
        </select>
        <small style="color: var(--dim);">${currentLang === 'zh-CN' ? '拒绝时，该角色用户访问将收到"暂无权限"提示' : 'When denied, users with this role will receive "no permission" message'}</small>
      </div>

      <div class="role-editor-tabs" role="tablist">
        <button type="button" class="role-editor-tab active" data-role-tab="fields">Field Permissions</button>
        <button type="button" class="role-editor-tab" data-role-tab="cli">CLI Permissions</button>
      </div>

      <div class="role-editor-tab-panel active" data-role-tab-panel="fields">
        <div class="form-section">
          <h4>权限配置</h4>
  `;

  const permissions = defaultDef.permissions;
  const permissionMeta = {
    permissionMode: {
      label: t('roleDefs.permissionMode'),
      type: 'select',
      options: [
        { value: 'bypass', label: 'roleDefs.permMode.bypass' },
        { value: 'request', label: 'roleDefs.permMode.request' },
        { value: 'auto', label: 'roleDefs.permMode.auto' },
        { value: 'readonly', label: 'roleDefs.permMode.readonly' }
      ]
    },
    'baseagents.claude.model': {
      label: t('roleDefs.model'),
      type: 'text'
    },
    'baseagents.claude.effort': {
      label: currentLang === 'zh-CN' ? '推理强度 (effort)' : 'Reasoning Effort (effort)',
      type: 'select',
      options: [
        { value: 'low', label: 'roleDefs.effort.low' },
        { value: 'medium', label: 'roleDefs.effort.medium' },
        { value: 'high', label: 'roleDefs.effort.high' }
      ]
    },
    dispatch: {
      label: t('roleDefs.dispatch'),
      type: 'select',
      options: [
        { value: 'broadcast', label: 'roleDefs.dispatch.broadcast' },
        { value: 'mention', label: 'roleDefs.dispatch.mention' }
      ]
    },
    'baseagents.claude.allowedModels': {
      label: t('roleDefs.allowedModels'),
      type: 'tags',
      placeholder: '按回车添加模型'
    },
    'baseagents.claude.show_activities': {
      label: currentLang === 'zh-CN' ? '显示活动 (show_activities)' : 'Show Activities (show_activities)',
      type: 'select',
      options: [
        { value: 'true', label: 'roleDefs.showActivities.true' },
        { value: 'false', label: 'roleDefs.showActivities.false' }
      ]
    },
    chatmode: {
      label: currentLang === 'zh-CN' ? '聊天模式 (chatmode)' : 'Chat Mode (chatmode)',
      type: 'chatmode',
      // 聊天模式按场景配置，可选值固定（放在默认配置里，非用户自由填写）
      scenes: [
        { key: 'private', label: currentLang === 'zh-CN' ? '私聊' : 'Private' },
        { key: 'group', label: currentLang === 'zh-CN' ? '群聊' : 'Group' },
        { key: 'nothuman', label: currentLang === 'zh-CN' ? '非人类(机器对端)' : 'Non-human' }
      ],
      options: [
        { value: 'interactive', label: currentLang === 'zh-CN' ? '交互式 (interactive)' : 'Interactive (interactive)' },
        { value: 'proactive', label: currentLang === 'zh-CN' ? '主动式 (proactive)' : 'Proactive (proactive)' }
      ]
    },
    show_activities: {
      label: currentLang === 'zh-CN' ? '显示活动 (show_activities)' : 'Show Activities (show_activities)',
      type: 'select',
      options: [
        { value: 'all', label: currentLang === 'zh-CN' ? '全部 (all)' : 'All (all)' },
        { value: 'none', label: currentLang === 'zh-CN' ? '不显示 (none)' : 'None (none)' }
      ]
    },
    flush_delay: {
      label: currentLang === 'zh-CN' ? '刷新延迟 (flush_delay)' : 'Flush Delay (flush_delay)',
      type: 'number'
    },
    debounce: {
      label: currentLang === 'zh-CN' ? '防抖延迟 (debounce)' : 'Debounce (debounce)',
      type: 'number'
    },
    enable_rich_content: {
      label: currentLang === 'zh-CN' ? '富文本内容 (enable_rich_content)' : 'Rich Content (enable_rich_content)',
      type: 'boolean'
    }
  };

  body.innerHTML += renderRoleModelPermissionSection(defaultDef);

  Object.keys(permissions).forEach(permKey => {
    if (permKey === CLAUDE_MODEL_PERMISSION_KEY || permKey === CLAUDE_ALLOWED_MODELS_LEGACY_KEY) return;
    const perm = permissions[permKey];
    const meta = permissionMeta[permKey] || { label: permKey, type: 'text' };

    body.innerHTML += `
      <div class="form-group perm-group">
        <div class="perm-header">
          <label class="perm-label">${esc(meta.label)}</label>
          <label class="perm-override">
            <input type="checkbox"
                   data-perm="${esc(permKey)}"
                   data-field="allowOverride"
                   ${perm.allowOverride ? 'checked' : ''}>
            <span>${t('roleDefs.allowOverride')}</span>
          </label>
        </div>
    `;

    if (meta.type === 'select') {
      body.innerHTML += `<select data-perm="${esc(permKey)}" data-field="default" class="form-select">`;
      meta.options.forEach(opt => {
        const optValue = typeof opt === 'string' ? opt : opt.value;
        const optLabel = typeof opt === 'string' ? opt : t(opt.label);
        const selected = perm.default === optValue ? 'selected' : '';
        body.innerHTML += `<option value="${esc(optValue)}" ${selected}>${esc(optLabel)}</option>`;
      });
      body.innerHTML += `</select>`;
    } else if (meta.type === 'chatmode') {
      // 聊天模式：按场景（私聊/群聊/非人类）各一个下拉，选项来自默认配置
      const cm = (perm.default && typeof perm.default === 'object') ? perm.default : {};
      body.innerHTML += `<div class="chatmode-grid" data-perm="${esc(permKey)}" data-field="default">`;
      meta.scenes.forEach(scene => {
        body.innerHTML += `<div class="chatmode-scene"><label class="chatmode-scene-label">${esc(scene.label)}</label><select data-scene="${esc(scene.key)}" class="form-select">`;
        meta.options.forEach(opt => {
          const selected = cm[scene.key] === opt.value ? 'selected' : '';
          body.innerHTML += `<option value="${esc(opt.value)}" ${selected}>${esc(opt.label)}</option>`;
        });
        body.innerHTML += `</select></div>`;
      });
      body.innerHTML += `</div>`;
    } else if (meta.type === 'boolean') {
      // 布尔开关：true / false 下拉
      body.innerHTML += `<select data-perm="${esc(permKey)}" data-field="default" data-value-type="boolean" class="form-select">`;
      [{ v: 'true', l: currentLang === 'zh-CN' ? '是 (true)' : 'True (true)' },
       { v: 'false', l: currentLang === 'zh-CN' ? '否 (false)' : 'False (false)' }].forEach(o => {
        const selected = String(perm.default) === o.v ? 'selected' : '';
        body.innerHTML += `<option value="${o.v}" ${selected}>${o.l}</option>`;
      });
      body.innerHTML += `</select>`;
    } else if (meta.type === 'number') {
      // 数值输入
      const value = perm.default ?? '';
      body.innerHTML += `<input type="number" data-perm="${esc(permKey)}" data-field="default" data-value-type="number" value="${esc(String(value))}" class="form-input">`;
    } else if (meta.type === 'tags') {
      const values = Array.isArray(perm.default) ? perm.default : [];
      body.innerHTML += `
        <div class="tags-input-container" data-perm="${esc(permKey)}">
          <div class="tags-list">
            ${values.map(v => `
              <span class="tag">
                ${esc(v)}
                <button type="button" class="tag-remove" data-value="${esc(v)}">×</button>
              </span>
            `).join('')}
          </div>
          <input type="text"
                 class="tags-input"
                 placeholder="${esc(meta.placeholder || '')}"
                 data-perm="${esc(permKey)}"
                 data-field="default">
        </div>
      `;
    } else {
      const value = perm.default || '';
      body.innerHTML += `
        <input type="text"
               data-perm="${esc(permKey)}"
               data-field="default"
               value="${esc(value)}"
               class="form-input">
      `;
    }

    body.innerHTML += `</div>`;
  });

  body.innerHTML += `</div></div>
      <div class="role-editor-tab-panel" data-role-tab-panel="cli">
        ${renderCommandPermissionsEditor(defaultDef, operations)}
      </div>
    </div>`;

  bindTagsInputEvents(body);
  initRoleEditorTabs(body);
  initCommandPermissionEditor(body);
  initRoleModelPermissionEditor(body, '__new__', defaultDef);

  modal.style.display = 'flex';

  // 聚焦到角色名称输入框
  setTimeout(() => $('#new-role-name')?.focus(), 100);
}

async function showRoleEditModal(roleName, roleDef) {
  const modal = $('#role-edit-modal');
  const title = $('#role-edit-title');
  const body = $('#role-edit-body');
  const saveBtn = $('#role-edit-save');

  if (!modal || !title || !body || !saveBtn) return;

  title.textContent = `${t(ROLE_NAMES[roleName] || roleName)} - ${t('roleDefs.edit')}`;
  saveBtn.style.display = 'inline-block';
  saveBtn.dataset.role = roleName;
  const operations = await loadRoleOperationsForEditor();

  let formHtml = `<div class="role-edit-form">`;

  formHtml += `
    <div class="form-section">
      <h4>${t('roleDefs.description')}</h4>
      <textarea id="edit-description" rows="3" class="form-textarea">${esc(roleDef.description || '')}</textarea>
    </div>
  `;

  const allowAccess = roleDef.allowAccess ?? true;
  formHtml += `
    <div class="form-section">
      <h4>${currentLang === 'zh-CN' ? '是否允许访问' : 'Allow Access'}</h4>
      <select id="edit-allowAccess" data-value-type="boolean" class="form-select">
        <option value="true" ${allowAccess ? 'selected' : ''}>${currentLang === 'zh-CN' ? '允许 (true)' : 'Allow (true)'}</option>
        <option value="false" ${allowAccess ? '' : 'selected'}>${currentLang === 'zh-CN' ? '拒绝 (false)' : 'Deny (false)'}</option>
      </select>
      <small style="color: var(--dim);">${currentLang === 'zh-CN' ? '拒绝时，该角色用户访问将收到"暂无权限"提示' : 'When denied, users with this role will receive "no permission" message'}</small>
    </div>
  `;

  formHtml += `
    <div class="role-editor-tabs" role="tablist">
      <button type="button" class="role-editor-tab active" data-role-tab="fields">Field Permissions</button>
      <button type="button" class="role-editor-tab" data-role-tab="cli">CLI Permissions</button>
    </div>

    <div class="role-editor-tab-panel active" data-role-tab-panel="fields">
      <div class="form-section">
        <h4>权限配置</h4>
  `;

  const permissions = roleDef.permissions || {};
  const permissionMeta = {
    permissionMode: {
      label: t('roleDefs.permissionMode'),
      type: 'select',
      options: [
        { value: 'bypass', label: 'roleDefs.permMode.bypass' },
        { value: 'request', label: 'roleDefs.permMode.request' },
        { value: 'auto', label: 'roleDefs.permMode.auto' },
        { value: 'readonly', label: 'roleDefs.permMode.readonly' }
      ]
    },
    'baseagents.claude.model': {
      label: t('roleDefs.model'),
      type: 'text'
    },
    'baseagents.claude.effort': {
      label: currentLang === 'zh-CN' ? '推理强度 (effort)' : 'Reasoning Effort (effort)',
      type: 'select',
      options: [
        { value: 'low', label: 'roleDefs.effort.low' },
        { value: 'medium', label: 'roleDefs.effort.medium' },
        { value: 'high', label: 'roleDefs.effort.high' }
      ]
    },
    dispatch: {
      label: t('roleDefs.dispatch'),
      type: 'select',
      options: [
        { value: 'broadcast', label: 'roleDefs.dispatch.broadcast' },
        { value: 'mention', label: 'roleDefs.dispatch.mention' }
      ]
    },
    'baseagents.claude.allowedModels': {
      label: t('roleDefs.allowedModels'),
      type: 'tags',
      placeholder: '按回车添加模型'
    },
    'baseagents.claude.show_activities': {
      label: currentLang === 'zh-CN' ? '显示活动 (show_activities)' : 'Show Activities (show_activities)',
      type: 'select',
      options: [
        { value: 'true', label: 'roleDefs.showActivities.true' },
        { value: 'false', label: 'roleDefs.showActivities.false' }
      ]
    },
    chatmode: {
      label: currentLang === 'zh-CN' ? '聊天模式 (chatmode)' : 'Chat Mode (chatmode)',
      type: 'chatmode',
      scenes: [
        { key: 'private', label: currentLang === 'zh-CN' ? '私聊' : 'Private' },
        { key: 'group', label: currentLang === 'zh-CN' ? '群聊' : 'Group' },
        { key: 'nothuman', label: currentLang === 'zh-CN' ? '非人类(机器对端)' : 'Non-human' }
      ],
      options: [
        { value: 'interactive', label: currentLang === 'zh-CN' ? '交互式 (interactive)' : 'Interactive (interactive)' },
        { value: 'proactive', label: currentLang === 'zh-CN' ? '主动式 (proactive)' : 'Proactive (proactive)' }
      ]
    },
    show_activities: {
      label: currentLang === 'zh-CN' ? '显示活动 (show_activities)' : 'Show Activities (show_activities)',
      type: 'select',
      options: [
        { value: 'all', label: currentLang === 'zh-CN' ? '全部 (all)' : 'All (all)' },
        { value: 'none', label: currentLang === 'zh-CN' ? '不显示 (none)' : 'None (none)' }
      ]
    },
    flush_delay: {
      label: currentLang === 'zh-CN' ? '刷新延迟 (flush_delay)' : 'Flush Delay (flush_delay)',
      type: 'number'
    },
    debounce: {
      label: currentLang === 'zh-CN' ? '防抖延迟 (debounce)' : 'Debounce (debounce)',
      type: 'number'
    },
    enable_rich_content: {
      label: currentLang === 'zh-CN' ? '富文本内容 (enable_rich_content)' : 'Rich Content (enable_rich_content)',
      type: 'boolean'
    }
  };

  formHtml += renderRoleModelPermissionSection(roleDef);

  Object.keys(permissions).forEach(permKey => {
    if (permKey === CLAUDE_MODEL_PERMISSION_KEY || permKey === CLAUDE_ALLOWED_MODELS_LEGACY_KEY) return;
    const perm = permissions[permKey];
    const meta = permissionMeta[permKey] || { label: permKey, type: 'text' };

    formHtml += `
      <div class="form-group perm-group">
        <div class="perm-header">
          <label class="perm-label">${esc(meta.label)}</label>
          <label class="perm-override">
            <input type="checkbox"
                   data-perm="${esc(permKey)}"
                   data-field="allowOverride"
                   ${perm.allowOverride ? 'checked' : ''}>
            <span>${t('roleDefs.allowOverride')}</span>
          </label>
        </div>
    `;

    if (meta.type === 'select') {
      formHtml += `<select data-perm="${esc(permKey)}" data-field="default" class="form-select">`;
      meta.options.forEach(opt => {
        const optValue = typeof opt === 'string' ? opt : opt.value;
        const optLabel = typeof opt === 'string' ? opt : t(opt.label);
        const selected = perm.default === optValue ? 'selected' : '';
        formHtml += `<option value="${esc(optValue)}" ${selected}>${esc(optLabel)}</option>`;
      });
      formHtml += `</select>`;
    } else if (meta.type === 'chatmode') {
      const cm = (perm.default && typeof perm.default === 'object') ? perm.default : {};
      formHtml += `<div class="chatmode-grid" data-perm="${esc(permKey)}" data-field="default">`;
      meta.scenes.forEach(scene => {
        formHtml += `<div class="chatmode-scene"><label class="chatmode-scene-label">${esc(scene.label)}</label><select data-scene="${esc(scene.key)}" class="form-select">`;
        meta.options.forEach(opt => {
          const selected = cm[scene.key] === opt.value ? 'selected' : '';
          formHtml += `<option value="${esc(opt.value)}" ${selected}>${esc(opt.label)}</option>`;
        });
        formHtml += `</select></div>`;
      });
      formHtml += `</div>`;
    } else if (meta.type === 'boolean') {
      formHtml += `<select data-perm="${esc(permKey)}" data-field="default" data-value-type="boolean" class="form-select">`;
      [{ v: 'true', l: currentLang === 'zh-CN' ? '是 (true)' : 'True (true)' },
       { v: 'false', l: currentLang === 'zh-CN' ? '否 (false)' : 'False (false)' }].forEach(o => {
        const selected = String(perm.default) === o.v ? 'selected' : '';
        formHtml += `<option value="${o.v}" ${selected}>${o.l}</option>`;
      });
      formHtml += `</select>`;
    } else if (meta.type === 'number') {
      const value = perm.default ?? '';
      formHtml += `<input type="number" data-perm="${esc(permKey)}" data-field="default" data-value-type="number" value="${esc(String(value))}" class="form-input">`;
    } else if (meta.type === 'tags') {
      const values = Array.isArray(perm.default) ? perm.default : [];
      formHtml += `
        <div class="tags-input-container" data-perm="${esc(permKey)}">
          <div class="tags-list">
            ${values.map(v => `
              <span class="tag">
                ${esc(v)}
                <button type="button" class="tag-remove" data-value="${esc(v)}">×</button>
              </span>
            `).join('')}
          </div>
          <input type="text"
                 class="tags-input"
                 placeholder="${esc(meta.placeholder || '')}"
                 data-perm="${esc(permKey)}"
                 data-field="default">
        </div>
      `;
    } else {
      const value = perm.default || '';
      formHtml += `
        <input type="text"
               data-perm="${esc(permKey)}"
               data-field="default"
               value="${esc(value)}"
               class="form-input">
      `;
    }

    formHtml += `</div>`;
  });

  formHtml += `</div></div>
    <div class="role-editor-tab-panel" data-role-tab-panel="cli">
      ${renderCommandPermissionsEditor(roleDef, operations)}
    </div>
  </div>`;

  body.innerHTML = formHtml;

  bindTagsInputEvents(body);
  initRoleEditorTabs(body);
  initCommandPermissionEditor(body);
  initRoleModelPermissionEditor(body, roleName, roleDef);

  modal.style.display = 'flex';
}

async function showRoleDetailsModal(roleName, roleDef) {
  const modal = $('#role-edit-modal');
  const title = $('#role-edit-title');
  const body = $('#role-edit-body');
  const saveBtn = $('#role-edit-save');

  if (!modal || !title || !body) return;

  title.textContent = `${t(ROLE_NAMES[roleName] || roleName)} - ${t('roleDefs.viewDetails')}`;
  saveBtn.style.display = 'none'; // 只读模式隐藏保存按钮
  const operations = await loadRoleOperationsForEditor();

  body.innerHTML = `
    <div class="role-edit-form">
      <h4>${t('roleDefs.description')}</h4>
      <p>${esc(roleDef.description)}</p>

      <h4>Field Permissions</h4>
      <pre>${JSON.stringify(roleDef.permissions || {}, null, 2)}</pre>

      <h4>Command / CLI Permissions</h4>
      ${renderCommandPermissionsList(roleDef, operations, true)}
    </div>
  `;

  modal.style.display = 'flex';
}

function bindTagsInputEvents(container) {
  // 标签输入：按回车添加
  container.querySelectorAll('.tags-input').forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;

        const tagsContainer = input.closest('.tags-input-container');
        const tagsList = tagsContainer.querySelector('.tags-list');

        // 检查是否已存在
        const existing = Array.from(tagsList.querySelectorAll('.tag')).map(t => t.textContent.trim().replace('×', ''));
        if (existing.includes(value)) {
          input.value = '';
          return;
        }

        // 添加标签
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.innerHTML = `
          ${esc(value)}
          <button type="button" class="tag-remove" data-value="${esc(value)}">×</button>
        `;
        tagsList.appendChild(tag);
        input.value = '';
      }
    });
  });

  // 标签删除
  container.addEventListener('click', (e) => {
    if (e.target.classList.contains('tag-remove')) {
      e.target.closest('.tag').remove();
    }
  });
}

function initRoleEditorTabs(container) {
  container.querySelectorAll('[data-role-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.roleTab;
      container.querySelectorAll('[data-role-tab]').forEach(item => {
        item.classList.toggle('active', item.dataset.roleTab === target);
      });
      container.querySelectorAll('[data-role-tab-panel]').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.roleTabPanel === target);
      });
    });
  });
}

function initCommandPermissionEditor(container) {
  container.querySelectorAll('[data-command-operation]').forEach(row => {
    row.addEventListener('change', (e) => {
      if (e.target?.matches?.('[data-command-field="decision"]')) {
        row.dataset.commandDecision = e.target.value;
      } else {
        row.dataset.commandDirty = 'true';
      }
    });
    row.addEventListener('input', () => {
      row.dataset.commandDirty = 'true';
    });
  });
}

async function saveRoleDefinition() {
  const saveBtn = $('#role-edit-save');
  const roleName = saveBtn?.dataset.role;

  if (!roleName) return;

  const body = $('#role-edit-body');
  const isNew = roleName === '__new__';

  let actualRoleName = roleName;

  // 如果是新增角色，获取角色名称
  if (isNew) {
    const nameInput = $('#new-role-name');
    actualRoleName = nameInput?.value.trim();

    if (!actualRoleName) {
      alert('请输入角色名称');
      nameInput?.focus();
      return;
    }

    // 验证角色名称格式
    if (!/^[a-z0-9_-]+$/.test(actualRoleName)) {
      alert('角色名称只能包含小写字母、数字、下划线和连字符');
      nameInput?.focus();
      return;
    }

    // 检查是否与内置角色重名
    const builtinRoles = ['owner', 'admin', 'member', 'guest', 'anonymous'];
    if (builtinRoles.includes(actualRoleName)) {
      alert('角色名称不能与内置角色重名');
      nameInput?.focus();
      return;
    }

    // 检查是否已存在
    if (state.roleDefinitions?.roles[actualRoleName]) {
      alert(`角色 "${actualRoleName}" 已存在`);
      nameInput?.focus();
      return;
    }
  }

  const currentDef = isNew
    ? (state.roleDefinitions?.roles?.member || {
      description: '',
      permissions: {
        permissionMode: { default: 'request', allowOverride: false },
        [CLAUDE_MODEL_PERMISSION_KEY]: { default: 'claude-sonnet-4', allowOverride: false, allowedModels: ['claude-sonnet-*', 'claude-haiku-*'] },
        dispatch: { default: 'mention', allowOverride: false }
      },
      commandPermissions: {
        'category:read': { allow: true },
        'category:write-own': { allow: true },
        'model.*': { allow: true, scopes: ['relation', 'agent'], constraints: { ownPeerOnly: true, ownAgentOnly: true } },
        'cli.exec.raw': { allow: false, dangerous: true }
      }
    })
    : (state.roleDefinitions?.roles[actualRoleName] || {});

  // 收集描述
  const description = $('#edit-description')?.value;

  // 收集是否允许访问
  const allowAccessSelect = $('#edit-allowAccess');
  const allowAccess = allowAccessSelect ? (allowAccessSelect.value === 'true') : true;

  // 收集所有权限配置
  const permissions = {};

  // 获取所有权限项的键
  const permKeys = new Set();
  body.querySelectorAll('[data-perm]').forEach(el => {
    permKeys.add(el.dataset.perm);
  });

  permKeys.forEach(permKey => {
    const defaultInput = body.querySelector(`[data-perm="${permKey}"][data-field="default"]`);
    const overrideInput = body.querySelector(`[data-perm="${permKey}"][data-field="allowOverride"]`);

    let defaultValue = currentDef.permissions?.[permKey]?.default;

    // 根据输入类型获取值
    if (defaultInput) {
      if (defaultInput.classList.contains('chatmode-grid')) {
        // 聊天模式：按场景收集为对象 { private, group, nothuman }
        const obj = {};
        defaultInput.querySelectorAll('select[data-scene]').forEach(sel => {
          obj[sel.dataset.scene] = sel.value;
        });
        defaultValue = obj;
      } else if (defaultInput.classList.contains('tags-input')) {
        // 标签输入：收集所有标签
        const tagsContainer = defaultInput.closest('.tags-input-container');
        const tags = Array.from(tagsContainer.querySelectorAll('.tag')).map(tag => {
          return tag.textContent.trim().replace('×', '');
        });
        defaultValue = tags;
      } else {
        defaultValue = defaultInput.value;
        // 按声明的值类型转换：布尔/数值不能存成字符串
        const valueType = defaultInput.dataset.valueType;
        if (valueType === 'boolean') {
          defaultValue = defaultValue === 'true';
        } else if (valueType === 'number') {
          const n = Number(defaultValue);
          defaultValue = Number.isFinite(n) ? n : 0;
        }
      }
    }

    permissions[permKey] = {
      ...(currentDef.permissions?.[permKey] || {}),
      default: defaultValue,
      allowOverride: overrideInput ? overrideInput.checked : false
    };
    delete permissions[permKey].selectionMode;
  });

  const modelPermission = collectRoleModelPermission(body);
  if (modelPermission) {
    const modelValidationError = validateRoleModelPermissionClient(modelPermission);
    if (modelValidationError) {
      alert(modelValidationError);
      return;
    }
    permissions[CLAUDE_MODEL_PERMISSION_KEY] = {
      ...(currentDef.permissions?.[CLAUDE_MODEL_PERMISSION_KEY] || {}),
      default: modelPermission.default,
      allowOverride: modelPermission.allowOverride,
      allowedModels: modelPermission.allowedModels
    };
    delete permissions[CLAUDE_MODEL_PERMISSION_KEY].selectionMode;
  }

  const commandPermissionsResult = collectCommandPermissions(body, currentDef.commandPermissions);
  if (!commandPermissionsResult.ok) {
    alert(commandPermissionsResult.error);
    return;
  }

  const updates = {
    description,
    allowAccess,
    permissions,
    commandPermissions: commandPermissionsResult.value
  };

  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const method = isNew ? 'POST' : 'PUT';
    const url = isNew ? apiUrl('api/role-definitions') : apiUrl(`api/role-definitions/${encodeURIComponent(actualRoleName)}`);

    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(isNew ? { name: actualRoleName, ...updates } : updates)
    });

    if (!res.ok) {
      let message = t('roleDefs.saveFailed');
      try {
        const data = await res.json();
        message = data?.error || data?.message || message;
      } catch {}
      throw new Error(message);
    }

    toast(t('roleDefs.saveSuccess'));
    const modal = $('#role-edit-modal');
    if (modal) modal.style.display = 'none';
    subscribe('roleDefinitions', {});
  } catch (e) {
    toast(e.message || String(e), true);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initPairUI();
  initMsgTipFloat();

  // 初始化语言切换
  const langBtn = $('#lang-btn');
  if (langBtn) {
    langBtn.addEventListener('click', toggleLang);
  }
  updateI18n(); // 应用当前语言

  // 已有 token 直接进；否则先试本地直连免配对，失败再回落配对页。
  if (!localStorage.getItem(TOKEN_KEY)) {
    await tryLocalAutoPair();
  }
  if (localStorage.getItem(TOKEN_KEY)) {
    showApp();
    startApp();
    initUsageSubtabs();
  } else {
    showPairPage();
  }
});
