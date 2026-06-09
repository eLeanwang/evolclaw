# Changelog

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
