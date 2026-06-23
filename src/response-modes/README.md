# 响应模式系统（src/response-modes/）

响应模式插件化系统的实现目录。设计文档：`docs/response-system/`。

## 目录结构

```
response-modes/
├── types.ts            接口定义（ResponseMode / Decision / Queue 等）
├── registry.ts         注册与发现（builtin + extension）
├── resolver.ts         模式选择（overrides > chatType 默认 > 兜底）
├── context-builder.ts  构造并缓存 ResponseModeContext
├── coordinator.ts      串联 解析→handleInbound→执行，统一容错
├── decision-executor.ts 执行 Inbound/Outbound 决策，异常降级
├── config-store.ts     响应模式配置读写
├── core/               内置响应模式（10 种）
├── extensions/         扩展响应模式（用户自定义）
└── queues/             队列实现（FIFO/LIFO/Priority/Custom）
```

## 实施状态

当前为**占位骨架**。实施按 `docs/response-system/implementation-plan.md` 的 Phase 1-7 推进。

⚠️ 实施前须确认 6 个决策门（D1-D6），见 `architecture.md` 第十章「待决策的对接难点」。

## 分层定位

- **内置模式** → `core/`（type: 'builtin'）
- **扩展模式** → `extensions/`（type: 'extension'）
- 二者通过 `registry.ts` 分别注册，物理隔离。
