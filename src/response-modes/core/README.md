# 内置响应模式（core/）

10 种内置响应模式，type: 'builtin'，由 `registry.registerBuiltin()` 注册。

| 文件 | 模式 | 场景 | 实施任务 |
|------|------|------|----------|
| interactive.ts | 交互模式 | 私聊 | T6.1（迁移）|
| proactive.ts | 主动模式 | 私聊/群聊 | T6.2（迁移）|
| dual-session.ts | 双会话模式 | 群聊 | T6.3（依赖 D3）|
| thread-tracking.ts | 线索追踪 | 群聊 | T6.4 |
| workflow.ts | 工作流 | 群聊 | T6.4 |
| context-enhanced.ts | 上下文增强 | 群聊 | T6.4 |
| batch-processing.ts | 批量处理 | 群聊 | T6.4 |
| selective-response.ts | 选择性响应 | 群聊 | T6.4 |
| rate-limited.ts | 速率限制 | 私聊/群聊 | T6.4 |
| autonomous.ts | 自主模式 | 私聊/群聊 | T6.4 |

详见 `docs/response-system/builtin-modes.md`。当前为占位目录，待 Phase 6 填充。
