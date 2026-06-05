# Changelog

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
