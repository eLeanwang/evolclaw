# 调度层（src/scheduler/）

资源调度层。管"哪些会话能处理"，不管"怎么处理"。设计文档：`docs/response-system/architecture.md` §4。

## 目录结构

```
scheduler/
├── types.ts          SlotManager / SchedulingStrategy 接口
├── slot-manager.ts   Slot 分配/释放/yieldControl（per-agent）
└── strategies/       调度策略
    ├── rule-based.ts   规则驱动（默认）
    ├── ai-based.ts     AI 驱动
    └── hybrid.ts       混合
```

## 实施状态

当前为**占位骨架**。

⚠️ SlotManager 采用渐进集成（决策门 D2）：先上 no-op 骨架（allocate 永远成功、
yield 永远 continue），埋入 MessageProcessor 调用点确认链路通，再填调度算法。

实施任务：implementation-plan.md Phase 7。

## 定位

- **插件化程度**：不完全插件化。内置三种策略，通过 `SchedulingStrategy` 接口预留扩展点。
- **粒度**：per-agent（挂在 EvolAgent 上），不与其他 agent 共享 slot 池。
