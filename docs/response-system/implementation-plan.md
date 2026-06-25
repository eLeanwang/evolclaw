# 实施路线

## 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | 响应模式插件化实施路线 |
| 版本 | v1.0 |
| 状态 | Draft |
| 适用读者 | 实施者、项目协调者 |
| 前置阅读 | [architecture.md](./architecture.md)（尤其第十章「待决策的对接难点」）|

---

## 一、实施前的决策门

实施**不能**在以下决策拍板前开始。这些来自 [architecture.md 第十章](./architecture.md#十待决策的对接难点)，
每一项都改变后续代码形态：

| # | 待决策 | 拍板结果 | 阻塞的 Phase |
|---|--------|----------|-------------|
| D1 | 队列机制与 agent 隔离 | ✅ **已确认**：D1.1 修复 agent 隔离（queueKey 加 selfAID 前缀）；D1.2 入队/出队策略分离（切换模式时已入队不动、出队重排） | Phase 2 |
| D2 | 调度层兼容性预留 | ✅ **已确认**：D2.1 预留 yieldHint（可选字段，当前忽略）；D2.2 Phase 7 暂不实施，接口已预留扩展点 | 无（Phase 7 暂不实施） |
| D3 | 辅助会话接口能力 | ✅ **已确认**：选 B（扩展接口），AuxiliarySession 加 send() 方法支持出站（thought/message）；createAuxiliarySession 支持 purpose/contextMode 配置 | Phase 6（dual-session） |
| D4 | 旧配置参数迁移 | ✅ **已确认**：无需兼容，直接删除 chatmode/dispatch，只用 response_modes 新结构（项目未对外发布） | Phase 4 |
| D5 | 作用域读写机制 | ✅ **已确认**：泛化 config-scope 为 field-scope（提取通用框架，字段路径适配） | Phase 5 |
| D6 | 响应模式异常处理 | ✅ **已确认**：不降级；记录日志 + reject Promise + 发送用户友好错误提示（含异常信息） | Phase 3 |
| D7 | 现有机制迁移评估 | ✅ **已确认**：D7.1 InboundDecision.runtimeState；D7.2 扩展 OutboundPayload.kind + isToolCall；D7.3 Channel 标记不过滤；D7.4 IMRenderer 退化 | Phase 1/2/3/6 |

> **进度**：所有决策已确认 ✅，接口已调整，可开始实施。

---

## 二、Phase 总览

```
Phase 1  接口骨架（types.ts）         ← 无行为，可编译
   ↓
Phase 2  队列分层 + agent 隔离修复    ← 依赖 D1
   ↓
Phase 3  Registry/Resolver/Coordinator/Executor  ← 依赖 D6
   ↓
Phase 4  配置集成（response_modes）    ← 依赖 D4
   ↓
Phase 5  ec response 命令集 + Menu     ← 依赖 D5
   ↓
Phase 6  内置模式迁移与新增            ← 依赖 D3
```

每个 Phase 结束都应可编译、可测试、不破坏现有行为。

**Phase 7（调度层）暂不实施**：
- 响应层接口已预留扩展点（OutboundDecision.yieldHint）
- 流程图已标注调度层插入点
- 未来实施调度层时可无缝对接，不需要改响应层

---

## 三、任务清单

> 格式：每个任务标注 **输入 / 产出 / 依赖 / 影响文件**。
> 影响文件中「新建」是新文件，「改」是改现有文件。

### Phase 1：接口骨架

目标：把 architecture.md 的接口落成可编译的 TypeScript，无任何实现。

**T1.1 定义核心接口**
- 输入：architecture.md §3 接口定义
- 产出：`ResponseMode`、`ResponseModeContext`、`InboundDecision`、`OutboundDecision`、`MessageQueueInterface` 类型
- 依赖：无
- 影响：新建 `src/response-modes/types.ts`

**T1.2 定义扩展接口**
- 输入：architecture.md §3.5
- 产出：`WithAuxiliarySession`/`WithThreadTracking`/`WithWorkflow` + `AuxiliarySession`/`ThreadManager`/`WorkflowEngine`/`Thread`/`WorkflowNode`
- 依赖：T1.1
- 影响：改 `src/response-modes/types.ts`

**T1.3 定义调度接口**
- 输入：architecture.md §4.3
- 产出：`SchedulingStrategy`、`SchedulingContext`、`SlotManager`、`SlotStatus`
- 依赖：无
- 影响：新建 `src/scheduler/types.ts`

**验收**：`tsc --noEmit` 通过，接口可被 import，无实现。

### Phase 2：队列分层与 agent 隔离修复

目标：落实 D1 决策（分层队列 + agent 隔离），提供默认队列实现。

**T2.0 修复 agent 隔离（D1.1）**
- 输入：D1.1 拍板方案
- 产出：`queueKey = selfAID::sessionKey::projectPath`（加 selfAID 前缀）
- 依赖：无
- 影响：改 `src/core/message/message-queue.ts`（`getQueueKey` 方法）、持久化格式可能需要迁移逻辑
- 备注：此修复与响应模式插件化独立，但必须一起做（否则多 agent 场景队列冲突）

**T2.1 逻辑队列默认实现（D1.2）**
- 输入：D1.2 入队/出队策略分离、MessageQueueInterface
- 产出：`FIFOQueue`/`LIFOQueue`/`PriorityQueue`/`CustomQueue`（只管出队顺序，持有 messageId 排序视图）
- 依赖：T1.1、T2.0
- 影响：新建 `src/response-modes/queues/*.ts`

**T2.2 物理队列对接**
- 输入：现有 `MessageQueue` 单例职责清单
- 产出：逻辑队列与物理队列的桥接——Runner 取消息时问逻辑队列顺序、从物理队列取本体；去重/持久化/中断仍走物理队列
- 依赖：T2.1
- 影响：改 `src/core/message/message-queue.ts`（暴露按 messageId 取本体的接口）、新建桥接逻辑

**T2.3 Channel Adapter 改为"标记不过滤"（D7.3）**
- 输入：D7.3 决策（mention 过滤下移到响应层）
- 产出：aun.ts/feishu.ts 等不再过滤未 @ 的消息，只标记 `message.isMentioned = true/false`，全部入队
- 依赖：无
- 影响：改 `src/channels/aun.ts`（移除 1456 行的 return）、`src/channels/feishu.ts` 等

**验收**：
- T2.0：不同 agent 与同一对端的队列独立，不冲突
- T2.1/T2.2：默认 FIFO 行为与现有完全一致（回归测试）；PriorityQueue 单测通过；切换模式时出队顺序正确重排
- T2.3：群聊未 @ 的消息也能入队（响应模式可在 handleInbound 中判断）

### Phase 3：核心运行时（独立组件）

目标：Registry / Resolver / ContextBuilder / DecisionExecutor 四个独立、可单测的组件。

> **范围调整（已拍板）**：T3.5（IMRenderer 退化）和 Coordinator 接入 message-processor
> **挪到 Phase 6**，与真实内置模式一起做。原因：此刻配置层（Phase 4）和真实模式（Phase 6）
> 都未就位，改现有热路径（IMRenderer 10 处 chatmode 分支 + message-processor 57 处 proactive 逻辑）
> 会产生悬空改动和临时垫片。详见 phase3-progress.md。

**T3.1 Registry** ✅
- 产出：`ResponseModeRegistry`（registerBuiltin/registerExtension/unregister/get/list/has）
- 影响：新建 `src/response-modes/registry.ts`

**T3.2 Resolver** ✅
- 输入：架构 §7 解析优先级
- 产出：`ResponseModeResolver`（override > chatType 默认 > 兜底）+ `ResponseModesConfig` 形状
- 影响：新建 `src/response-modes/resolver.ts`

**T3.3 ContextBuilder** ✅
- 产出：`ResponseModeContextBuilder`，构造 Context + 缓存 per-(session,mode) sessionState + 派生 dataDir
- 影响：新建 `src/response-modes/context-builder.ts`
- 备注：扩展能力工厂（createAuxiliarySession）为懒创建占位，Phase 6 接入 Runner

**T3.4 DecisionExecutor** ✅
- 输入：D6 决策（不降级，增强错误提示）
- 产出：`DecisionExecutor`（决策与执行分离，副作用经 ExecutorSinks 注入便于单测）
- 影响：新建 `src/response-modes/decision-executor.ts`

**验收** ✅：四个组件编译通过，34 个单元测试全部通过。

> **挪到 Phase 6 的任务**：
> - **T6.x Coordinator**：串起解析→handleInbound→执行，接入 message-processor
> - **T6.x IMRenderer 退化（D7.4）**：移除 chatMode 感知，由响应模式 handleOutbound 接管
> - 这两项依赖真实 InteractiveMode/ProactiveMode 作为接管者，故与 Phase 6 一起做。

### Phase 4：配置集成

目标：response_modes 进配置体系，与 chatmode/dispatch 兼容（D4）。

**T4.1 配置类型** ✅
- 产出：`ResponseModesConfig`（types.ts 权威定义）+ AgentConfig/RelationConfig/EffectiveAgentConfig 加 `response_modes` 字段；resolver.ts re-export 复用
- 影响：改 `src/types.ts`、`src/response-modes/resolver.ts`

**T4.2 合并** ✅
- 产出：`resolveEffective` 搬运 `response_modes` 到 effective（合并由 schema 驱动的 mergeLayers 完成）
- 影响：改 `src/config/config-manager.ts`
- 备注：D4「删除 chatmode/dispatch」推迟到 Phase 6 —— 现删会破坏 108 处引用（57 处 proactive 逻辑），需真实模式接管后才安全删

**T4.3 Schema 落 SSOT** ✅
- 产出：`response_modes` 字段进 agent-config + relation-config schema，x-merge=dict（与 chatmode 一致）
- 影响：改 `kits/schemas/agent-config.schema.1.json`、`kits/schemas/relation-config.schema.1.json`

**验收** ✅：4 个配置合并测试通过（schema 声明 dict、relation 覆盖保留兄弟键、configs 整键覆盖、overrides 不污染 defaults）；构建无破坏。

### Phase 5：命令集与前端

目标：`ec response` 命令集 + Menu Protocol，作用域复用（D5）。

> **范围调整（已拍板）**：T5.3（Menu Protocol 对接）**挪到 Phase 6**，与会话内 `/response` slash 命令一起做。
> 原因：Menu Protocol 走**会话内 slash 命令**路径（`/model`、`/chatmode`），`ec model`（持久化配置）本身不在 Menu 里——
> 持久化配置类命令走 CLI 即可。真正需要 Menu 对接的是会话内即时切换响应模式（未来的 `/response` slash 命令），
> 它依赖 Coordinator 接入（Phase 6），现在做又是悬空。详见 phase5-progress.md。

**T5.1 作用域框架（D5）** ✅
- 输入：D5 决策（提取通用部分，model 专用逻辑保留）
- 产出：`field-scope.ts` 处理顶层字段作用域读写（H 链 config.json）；复用 config-scope 的 `normalizePeer`/`determineScope`
- 影响：新建 `src/core/model/field-scope.ts`

**T5.2 命令实现** ✅
- 输入：command-reference.md
- 产出：`ec response` 6 个子命令（list/current/info/set/reset/config [set]）+ 内置模式元数据清单（builtin-meta.ts）
- 依赖：T3.1、T4.1、T5.1
- 影响：新建 `src/cli/response.ts`、`src/response-modes/builtin-meta.ts`、改 `src/cli/index.ts`（注册 response 分支 + help 文本）
- 备注：写操作要求 --self（response_modes 是行为参数，从 agent 级起步，与 `ec model` 一致）

**T5.4 命令集知识文档** ✅
- 产出：`kits/docs/evolclaw/response.md` + INDEX 登记 + 06-channel.md 命令表
- 影响：新建 `kits/docs/evolclaw/response.md`、改 INDEX/06-channel

**验收** ✅：list/info/set/config/reset 全通（JSON + 文本输出）；作用域（agent/relation）正确；scene 校验生效；友好报错（无 --self、scene 不匹配）。

> **挪到 Phase 6 的任务**：
> - **T6.x Menu Protocol 对接**：会话内 `/response` slash 命令 + menu-handler 查询/切换/配置
> - 依赖 Coordinator 接入（会话内即时切换运行模式实例），与 Phase 6 一起做。

### Phase 6：内置模式 + 接入

目标：迁移现有 + 实现新模式 + 把响应系统接入消息流。建议先迁移再接入再新增。

**T6.0 Coordinator + 接入（从 Phase 3 挪入）**
- 产出：`ResponseModeCoordinator`，串起解析→handleInbound→执行；缓存模式实例、统一容错
- 依赖：T3.1-T3.4、T6.1、T6.2（需真实模式作接管者）
- 影响：新建 `src/response-modes/coordinator.ts`、改 `src/core/message/message-processor.ts`（接入点）

**T6.0b IMRenderer 退化（D7.4，从 Phase 3 挪入）**
- 输入：D7.4 决策（退化为纯缓冲器）
- 产出：移除 IMRenderer 的 chatMode 感知（10 处分支），由响应模式 handleOutbound 接管
- 依赖：T6.2（ProactiveMode 接管 thought 逻辑）
- 影响：改 `src/core/message/im-renderer.ts`、`src/core/message/message-processor.ts`

**T6.1 迁移 interactive**
- 产出：`InteractiveMode`（FIFO + direct）
- 依赖：Phase 3
- 影响：新建 `src/response-modes/core/interactive.ts`

**T6.2 迁移 proactive**
- 产出：`ProactiveMode`（tool-required；runtimeState 传递 suspendUntilCall 等）
- 依赖：Phase 3
- 影响：新建 `src/response-modes/core/proactive.ts`

**T6.3 dual-session**（D3）
- 输入：D3 辅助会话隔离方案、plugin-guide §6.1
- 产出：`DualSessionMode` + 辅助会话默认实现（接入 Runner，补全 ContextBuilder 占位）
- 依赖：T3.3、T6.1
- 影响：新建 `src/response-modes/core/dual-session.ts`、补 `context-builder.ts` 的 createAuxiliarySession

**T6.4 其余 7 个模式**
- 产出：thread-tracking/workflow/context-enhanced/batch-processing/selective-response/rate-limited/autonomous
- 依赖：按需（thread/workflow 依赖对应支撑接口实现）
- 影响：新建 `src/response-modes/core/*.ts`
- 备注：可逐个独立交付，非一次性

**验收**：interactive/proactive 行为与迁移前一致；IMRenderer 无 chatMode 判断；dual-session 在测试群验证过滤生效。

---

## 四、关键路径

```
Phase 1 ─→ Phase 2 ─→ Phase 3 ─→ Phase 4 ─→ Phase 5 ─→ Phase 6
```

- **关键路径**：1→2→3→4→5→6
- **可增量**：Phase 6 的 7 个新模式可逐个交付，不阻塞整体
- **Phase 7（调度层）暂不实施**：接口已预留，未来可无缝对接

---

## 五、风险控制原则

1. **每 Phase 不破坏现有行为**：迁移 interactive/proactive 必须与现状逐字节对齐（回归测试守住）。
2. **兼容层先行**：Phase 4 的 chatmode/dispatch 派生映射先到位，再迁移模式。
3. **逃生通道**：response_modes 配置可整体移除，系统回落旧 chatmode/dispatch（见 troubleshooting §7）。
4. **决策门**：D1/D2 已确认 ✅；D3/D4/D5/D6 在对应 Phase 启动前确认。

---

## 六、验收总览

| Phase | 核心验收 |
|-------|----------|
| 1 | tsc 通过，接口可 import；InboundDecision 有 runtimeState；OutboundPayload 有 kind 扩展和 isToolCall；ResponseModeContext 有 sessionState 和 channel.capabilities |
| 2 | agent 隔离修复生效；默认 FIFO 与现状一致；PriorityQueue 单测过；切换模式时出队重排；群聊未 @ 消息可入队 |
| 3 | mock 模式跑通全链路；异常不崩且发错误提示；IMRenderer 无 chatMode 判断 |
| 4 | 旧配置行为不变；新配置正确解析 |
| 5 | 命令全通；前端可切换 |
| 6 | interactive/proactive 对齐（含 runtimeState 传递）；dual-session 过滤生效 |

---

## 附录：相关文档

- [架构设计](./architecture.md)（第十章为本路线的决策依据）
- [插件开发指南](./plugin-guide.md)
- [命令参考](./command-reference.md)
- [配置参考](./config-reference.md)
- [内置模式文档](./builtin-modes.md)
- [故障排查](./troubleshooting.md)
