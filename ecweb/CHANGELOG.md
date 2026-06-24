# Changelog

## v1.2.2 (2026-06-19)

### New Features

- **计费/用量重构** — Gateway source 接管 token 计费逻辑，stats 增加按模型/用户/agent 的细粒度聚合；Explorer 子视图增强对比与筛选
- **运行统计来源切换** — Triggers/Stats 改从审计日志汇总，移除 in-memory `activeSessions`，重启后历史不丢
- **模型访问列表筛选** — Gateway 视图新增模型筛选器，支持按 provider/model 过滤访问记录
- **统计信息面板** — 新增 server 端 stats 聚合接口，前端展示 session/usage 维度汇总

### Improvements

- **页面状态保持** — 刷新后保留选中 tab 页
- **Settings.json 透传** — gateway 暂不动 `settings.json`，避免覆盖用户本地配置
- **样式/交互打磨** — Usage Explorer 与 Billing 视图多轮 UI 调整

### Bug Fixes

- 模型访问列表筛选条件下计数错位
- 多处小修

## v1.2.0 (2026-06-12)

### New Features

- **Monitor 视图** — 新增 `monitor` source，展示进程级 + 系统级 CPU/内存指标、全局统计与 per-agent 摘要；CPU 由后端 1s 采样循环提供
- **Agent 运行时控制** — Agent 页面支持 start / stop / mute / unmute / queue-clear：start/stop 连接/断开渠道（不改 config.enabled），stop 中断进行中的模型调用；mute/unmute 暂停/恢复队列消费但保留入队；queue-clear 清空待处理消息
- **Agent displayName 展示** — 从 agent.md 解析显示名（本地缓存 + 异步网络拉取）

### Improvements

- **Web token TTL 延长** — 登录 token 有效期延长至 30 天并支持滑动续期
- **端口冲突处理** — 端口被占时杀掉持有端口的旧进程，而非漂移到 port+1
- **StatsCollector 错误追踪** — 记录近期错误供 Monitor 展示
- **构建脚本清理** — build 前先清空 dist，避免陈旧产物残留

### Bug Fixes

- **启动就绪检测** — restart 后改用 HTTP 探测端口确认就绪，instance 文件清理逻辑修正

## v1.1.0 (2026-06-10)

### New Features

- **System 控制台** — 新增 `system` source，通过 menu 协议拉取三包版本（evolclaw / fastaun / evolclaw-web）、uptime、pid、node 版本，并做版本健康检查
- **Triggers 视图** — 新增 `triggers` source，展示定时任务列表与运行状态
- **Usage 统计视图** — 新增 `stats` source（356 行），对接 evolclaw stats 子系统，提供 Dashboard / Overview / Explorer 三个子视图，按 agent / peer / 模型聚合 token 用量与费用
- **Cache 监控视图** — 新增 cache source，监控 FileCache 命中情况
- **dev 工具** — 新增 `dev.mjs`，本地开发热重载

### Improvements

- **Control 视图** — 接入 Menu 协议控制台，control source 拆分为 system / triggers 两个独立 source
- **配对码安全** — 配对码改为 localhost-only，`ec watch web` 显示配对信息

## v1.0.1 (2026-06-04)

### Improvements

- **WebSocket NAT 保活** — 每 25s 发送 ping，防止中间设备切断长连接
- **关停强制断连** — `close()` 改用 `terminate()` + `closeAllConnections()`，避免进程挂死
- **幂等 cleanup** — 防止 Ctrl-C 连按触发多次重复退出
- **会话 transcript 解析增强** — 完整解析 thinking/tool_use/tool_result 块并分类计数
- **默认端口** — 20030 → 42705

### Bug Fixes

- **cleanup 兜底** — `close()` 卡住时 2s 强制 `process.exit(0)`

---

## v1.0.0 (2026-06-03)

Initial release — EvolClaw 监控面板独立 npm 包。
