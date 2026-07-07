# 双会话响应模式 - 实施计划

**文档版本**: 2.0
**日期**: 2026-07-06
**状态**: 可实施
**架构决策**: 采用 `src/response-system/engines + modes` 新体系，不在旧 `src/response-modes/` 下扩展。

---

## 一、实施原则

### 1.1 唯一架构方向

本实施计划以方案 1 为唯一方向：

```text
src/response-system/
├── engines/
│   ├── v1/
│   └── v2/
├── modes/
│   ├── interactive/
│   ├── proactive/
│   └── dual-session-lite/
├── registry.ts
├── selector.ts
├── types.ts
└── index.ts
```

不采用以下路线：

```text
src/response-modes/dual-session/
```

旧 `src/response-modes/` 是现有系统事实，但不是 dual-session-lite 的目标落点。实现时应先建立新的 `src/response-system/`，再按阶段迁移或适配旧 V1 行为。

### 1.2 用户接口与实现层分离

用户只选择响应模式：

```json
{
  "response_mode": "dual-session-lite"
}
```

内部由响应模式固定绑定引擎：

| 用户可见响应模式 | 内部引擎 | 说明 |
|---|---|---|
| `interactive` | V1 | 迁移现有交互行为 |
| `proactive` | V1 | 迁移现有主动行为 |
| `dual-session-lite` | V2 | 新双会话实现，薄包装 V2Engine |

---

## 二、现有代码处理策略

### 2.1 旧系统定位

现有 `src/response-modes/` 只作为 V1 行为迁移来源，不作为新功能扩展位置。

处理原则：

1. 不在 `src/response-modes/dual-session*` 新增实现。
2. 不让 dual-session-lite 直接实现旧 `ResponseMode` 接口。
3. V1 行为通过 `src/response-system/engines/v1/` 包装或迁移。
4. `src/core/message/response-engine.ts` 最终只通过新 `ResponseModeSelector` 选择模式。

### 2.2 迁移边界

第一阶段允许旧系统和新系统短期并存，但入口必须明确：

```text
response-engine.ts
  -> ResponseModeSelector
     -> V1 mode wrapper
     -> V2 dual-session-lite mode
```

禁止出现两个并列入口分别处理响应模式选择。

---

## 三、实施阶段

### Phase 1：搭建新响应系统框架

**目标**：创建 `src/response-system/` 骨架，形成统一注册和选择入口。

**新增文件**：

```text
src/response-system/
├── types.ts
├── registry.ts
├── selector.ts
├── index.ts
├── engines/v1/types.ts
├── engines/v1/engine.ts
└── engines/v2/types.ts
```

**核心任务**：

1. 定义公共 `ResponseModeMeta`、`ResponseModeInstance`、`ResponseModeSelector` 相关类型。
2. 定义 V1 引擎接口，用于承接 interactive/proactive。
3. 定义 V2 内部类型边界，但不提前抽象公共 V2 接口。
4. 实现统一 registry，支持按 mode id 获取响应模式。

**验收标准**：

- [ ] TypeScript 编译通过。
- [ ] 新框架不改变现有运行行为。
- [ ] `interactive`、`proactive`、`dual-session-lite` 的元数据可以从新 registry 列出。

---

### Phase 2：迁移 V1 引擎和现有模式

**目标**：把现有 interactive/proactive 行为纳入新 `src/response-system/engines/v1`。

**新增/修改文件**：

```text
src/response-system/engines/v1/
├── types.ts
├── engine.ts
├── context.ts
└── adapter.ts

src/response-system/modes/
├── interactive/index.ts
└── proactive/index.ts
```

**核心任务**：

1. 将旧 `src/response-modes/core/interactive.ts` 行为迁移或包装为 `modes/interactive`。
2. 将旧 `src/response-modes/core/proactive.ts` 行为迁移或包装为 `modes/proactive`。
3. 保持 V1 的入站、出站、队列、hook 行为不变。
4. 将 `response-engine.ts` 的响应模式选择接到新 selector。

**验收标准**：

- [ ] interactive 回归测试通过。
- [ ] proactive 回归测试通过。
- [ ] 旧配置仍能选择 interactive/proactive。
- [ ] 新旧系统没有双重处理同一条消息。

---

### Phase 3：实现 V2 引擎

**目标**：实现 dual-session-lite 的完整技术核心，落点为 `engines/v2/`。

**新增文件**：

```text
src/response-system/engines/v2/
├── types.ts
├── auxiliary-queue.ts
├── auxiliary-session.ts
├── main-queue.ts
├── main-session.ts
├── engine.ts
└── README.md
```

**组件职责**：

| 组件 | 职责 |
|---|---|
| `V2Engine` | 串联辅助队列、辅助会话、主队列、主会话 |
| `AuxiliaryQueue` | 防抖、最大等待、队列满、delay timeout、HOLD 超时 |
| `AuxiliarySession` | 低成本模型判断 `hold/delay/transfer`，处理失败降级 |
| `MainQueue` | 批次构建、打断后重新提取、主会话投递 |
| `MainSession` | 主力模型处理批次，生成回复和 MainFeedback |

**关键行为**：

1. 群聊支持 `hold / delay / transfer`。
2. 单聊支持 `delay / transfer`，不使用 `hold`。
3. mention fast-track 在 V2Engine 中处理，不在 channel adapter 中丢弃普通消息。
4. 辅助会话失败后执行退避重试和降级投递。
5. HOLD 超时后强制投递，保证消息可达性。
6. 主会话反馈不单独触发辅助 LLM 调用，只作为后续辅助判断上下文。

**验收标准**：

- [ ] 辅助队列触发条件正确。
- [ ] 辅助决策解析稳定。
- [ ] 主队列批次限制正确。
- [ ] 打断行为符合设计。
- [ ] 错误重试和降级可测试。
- [ ] 队列持久化路径符合设计。

---

### Phase 4：实现 dual-session-lite 模式薄包装

**目标**：用户选择 `dual-session-lite` 时，实际委托给 `V2Engine`。

**新增文件**：

```text
src/response-system/modes/dual-session-lite/
├── index.ts
└── config-schema.json
```

**实现要求**：

1. `DualSessionLiteMode` 只负责元数据、配置解析、生命周期委托。
2. 不暴露 V2 内部队列和会话。
3. 不实现 V1 的 `handleInbound/handleOutbound` 接口。
4. 对外只提供新体系统一的 mode instance。

**验收标准**：

- [ ] `response_mode: "dual-session-lite"` 能选择该模式。
- [ ] 模式初始化会创建并初始化 V2Engine。
- [ ] cleanup 能正确释放 V2 队列和会话资源。

---

### Phase 5：ECK 集成

**目标**：让辅助会话和主会话拿到不同 system prompt。

**修改文件**：

```text
src/eck/kit-renderer.ts
kits/templates/manifest.yaml
```

**新增 ECK vars**：

```typescript
responseMode: 'dual-session-lite' | string | null;
sessionType: 'auxiliary' | 'main' | null;
```

**manifest 目标**：

```text
responseMode == dual-session-lite && sessionType == auxiliary
  -> docs/response-system/dual-session-lite/prompts/auxiliary-base.md

responseMode == dual-session-lite && sessionType == main
  -> docs/response-system/dual-session-lite/prompts/main-base.md
```

**验收标准**：

- [ ] ECK debug 输出能看到 `responseMode` 和 `sessionType`。
- [ ] 辅助会话只加载辅助 prompt。
- [ ] 主会话只加载主 prompt。
- [ ] 不影响普通 interactive/proactive ECK 注入。

---

### Phase 6：AUN 适配器调整

**目标**：群消息不再在 AUN channel 层按 mention 直接丢弃，而是交给响应模式判断。

**修改文件**：

```text
src/channels/aun.ts
```

**实现要求**：

1. 保留 `isMentioned` 标记。
2. dual-session-lite 下，普通群消息进入辅助队列
3. mention fast-track 由 V2Engine 处理。
4. interactive/proactive 的既有行为必须回归验证。

**验收标准**：

- [ ] 群聊未 mention 消息能进入 dual-session-lite 辅助队列。
- [ ] 被 mention 消息能触发 fast-track。
- [ ] 非 dual-session-lite 模式不发生行为回归。

---

### Phase 7：测试与验证

**测试目录建议**：

```text
tests/response-system/
├── engines/v1/
├── engines/v2/
└── modes/
```

**必测范围**：

1. V1 interactive/proactive 回归。
2. V2 auxiliary queue 入队、触发、状态转换、持久化。
3. V2 auxiliary session 决策解析、错误重试、降级。
4. V2 main queue 批次构建、打断、大小限制。
5. V2 main session 反馈生成。
6. dual-session-lite 模式选择和生命周期。
7. AUN mention fast-track 与普通群消息路径。
8. ECK prompt 分流。

**验收标准**：

- [ ] `npm test -- tests/response-system/` 通过。
- [ ] 关键路径集成测试覆盖 private 和 group。
- [ ] 不依赖真实 LLM，runner 使用 mock。
- [ ] 不依赖真实 AUN 网络，channel 使用 mock。

---

## 四、交付物清单

### 新增代码

```text
src/response-system/types.ts
src/response-system/registry.ts
src/response-system/selector.ts
src/response-system/index.ts
src/response-system/engines/v1/*
src/response-system/engines/v2/*
src/response-system/modes/interactive/*
src/response-system/modes/proactive/*
src/response-system/modes/dual-session-lite/*
```

### 修改代码

```text
src/core/message/response-engine.ts
src/channels/aun.ts
src/eck/kit-renderer.ts
kits/templates/manifest.yaml
```

### 新增/更新测试

```text
tests/response-system/engines/v1/
tests/response-system/engines/v2/
tests/response-system/modes/
```

---

## 五、风险控制

| 风险 | 控制方式 |
|---|---|
| 新旧响应系统并存导致双重处理 | 只允许 `response-engine.ts -> ResponseModeSelector` 一个入口 |
| V1 迁移引发回归 | Phase 2 单独完成并跑 interactive/proactive 回归 |
| V2 复杂度过高 | V2 内部先完整实现，不急于提取公共接口 |
| AUN mention 行为回归 | 对 dual-session-lite 和非 dual-session-lite 分别测试 |
| ECK prompt 混用 | 通过 ECK debug 文件验证命中 section |

---

## 六、后续增强

以下内容不阻塞第一版 dual-session-lite：

1. 记忆与压缩增强：见 `docs/response-system/memory-compression-design.md`。
2. 监控指标与可视化。
3. 延迟等级基于真实使用数据调优。
4. 关系层与环境层边界进一步厘定。

---

## 七、唯一事实来源

本实施计划必须与以下文档保持一致：

1. `docs/response-system/INDEX.md`
2. `docs/response-system/RESPONSE-MODE-ARCHITECTURE-V2.md`
3. `docs/response-system/dual-session-lite/ARCHITECTURE-FINAL.md`
4. `docs/response-system/dual-session-lite/ISSUES-SUMMARY.md`
5. `docs/response-system/dual-session-lite/data-structures.md`
6. `docs/response-system/dual-session-lite/message-flow.md`
7. `docs/response-system/dual-session-lite/eck-integration.md`

如果旧文档与上述文档冲突，以上述文档为准。
