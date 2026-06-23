# Phase 6 迁移分析

## 迁移边界

### 响应模式的职责（应该迁移）

1. **handleInbound 决策**：
   - 消息是否入队（process/drop/defer）
   - 队列行为（enqueue/clear-and-enqueue/interrupt）
   - 运行时状态传递（ProactiveRuntimeState、suspendUntilCall 等）

2. **handleOutbound 决策**：
   - 输出是否发送（direct/suppress/defer/batch）
   - 输出类型（message/thought）
   - 特殊逻辑（proactive 的 tool-required、pre_tool_1stmsgchk）

### message-processor 保留的职责（不应该迁移）

1. **会话生命周期管理**：创建/恢复/序列化 Session
2. **队列操作**：enqueue/dequeue（通过 MessageQueue 接口）
3. **Runner 集成**：构造 envelope、调用 runner.process
4. **渲染与发送**：IMRenderer + adapter.send
5. **错误处理与重试**：异常捕获、压缩、重试循环
6. **能力探测**：adapter.capabilities
7. **工具注入**：MCP 工具发现与注入

### 灰色地带（需要协商）

- **chatmode 字段在 envelope 中的传递**：现在 envelope 带 chatmode，响应模式接管后是否还需要？
- **proactive 的 runtimeState（suspendUntilCall 等）**：现在在 envelope.proactive 里，响应模式如何传递给 Runner？
- **IMRenderer 的 chatmode 分支**：10 处 `chatmode === 'proactive'` 分支，响应模式如何接管？

---

## 当前 interactive/proactive 逻辑分布（57 处）

| 位置 | 行号 | 逻辑 | 归属 |
|------|------|------|------|
| **消息处理入口** |
| 764 | effectiveChatMode 解析（triggerMeta override → session.chatMode → 'interactive'） | **迁移**：handleInbound 决策 |
| 780 | `isProactive = effectiveChatMode === 'proactive'` | **迁移**：模式内部判断 |
| 812-826 | 构造 ProactiveRuntimeState（suspendUntilCall 等） | **迁移**：proactive 模式的 handleInbound 构造 runtimeState |
| **Runner envelope** |
| 826 | `chatmode: isProactive ? 'proactive' : 'interactive'` | **灰色**：响应模式接管后，envelope 是否还需要 chatmode？ |
| 967 | envelope.chatmode（第二处） | 同上 |
| **IMRenderer** |
| 897-910 | 创建 IMRenderer，传入 chatmode | **灰色**：IMRenderer 退化后，如何接管 chatmode 逻辑？ |
| 910 | `if (isProactive && payload.kind === 'activity.batch' && !adapter.capabilities?.thought) return;` | **迁移**：proactive 的 handleOutbound 决策 |
| 941 | `if (isProactive)` 分支（发送逻辑） | **迁移**：proactive 的 handleOutbound |
| **能力探测与提示** |
| 1030 | `if (!isProactive && channelInfo.adapter.capabilities?.file) capParts.push('文件发送');` | **保留**：能力探测属于 message-processor |
| 1157 | `chatMode: isProactive ? 'proactive' : 'interactive'` | 同 826 |
| 1413-1497 | `if (!isProactive)` 大段（工具注入、能力提示） | **保留**：工具注入属于 message-processor，但"是否显示提示"可由响应模式决策 |
| 1503 | `if (isProactive && !streamResult.hasReceivedText && /^Unknown skill:/ ...)` | **迁移**：proactive 的特殊错误处理 |
| **模式切换提示** |
| 2104-2106 | Proactive→Interactive 切换提示（lastProactiveFlag） | **迁移**：响应模式切换由 Coordinator 管理 |

---

## 迁移策略（建议）

### 阶段 1：最小可用迁移（InteractiveMode/ProactiveMode）

**目标**：让 2 个模式跑通，行为与现状一致。

**范围**：
- `InteractiveMode`：handleInbound 永远 process+enqueue，handleOutbound 永远 direct
- `ProactiveMode`：
  - handleInbound：构造 runtimeState（suspendUntilCall/pre_tool_1stmsgchk 等）
  - handleOutbound：tool-required 逻辑（text suppress，tool_call direct）

**不改动**：
- envelope 保留 chatmode 字段（现阶段 Runner/IMRenderer 依赖）
- IMRenderer 保留 chatmode 分支（T6.0b 才退化）
- message-processor 的 57 处逻辑**暂时保留**（用 session.chatMode 判断，与响应模式并存）

### 阶段 2：Coordinator 接入 + 配置驱动

**目标**：message-processor 通过 Coordinator 解析模式，调用 handleInbound/handleOutbound。

**范围**：
- 新建 `ResponseModeCoordinator`（T6.0）
- message-processor 入口调用 `coordinator.handleInbound(msg)` → 入队决策
- message-processor 出站调用 `coordinator.handleOutbound(payload)` → 发送决策
- 配置解析：从 `config.response_modes` 读取（已有 resolver）

**不改动**：
- 57 处逻辑依然保留（响应模式返回的决策只是"建议"，message-processor 自己判断后执行）

### 阶段 3：IMRenderer 退化（T6.0b）

**目标**：移除 IMRenderer 的 10 处 chatmode 分支，由响应模式 handleOutbound 接管。

**范围**：
- ProactiveMode.handleOutbound 判断 `payload.kind === 'activity.batch'` → suppress（不进 renderer）
- ProactiveMode.handleOutbound 判断 `payload.kind === 'result.text' && !toolCallBefore` → suppress
- IMRenderer 退化为纯缓冲器（收集输出、格式化、缓冲），不再判断 chatmode

### 阶段 4：清理 57 处遗留逻辑

**目标**：删除 message-processor 的 isProactive 判断，完全由响应模式接管。

**风险**：这是最高风险阶段，需要逐段核对行为一致。

---

## Phase 6 任务分解（调整后）

| 任务 | 范围 | 风险 |
|------|------|------|
| **T6.1 InteractiveMode** | 最简单模式（FIFO + direct） | 低 |
| **T6.2 ProactiveMode** | tool-required + runtimeState | 中（runtimeState 传递） |
| **T6.0 Coordinator（最小）** | 解析模式 + 调用 handleInbound/handleOutbound，**不删旧逻辑** | 中 |
| **集成测试 1** | 用 interactive/proactive 跑真实会话，验证行为一致 | **关键检查点** |
| **T6.0b IMRenderer 退化** | 移除 10 处 chatmode 分支 | 高 |
| **集成测试 2** | 验证 IMRenderer 退化后行为不变 | **关键检查点** |
| **清理 57 处遗留** | 删除 message-processor 的 isProactive 判断 | 高 |
| **集成测试 3** | 最终回归测试 | **关键检查点** |
| **T6.3 dual-session** | 辅助会话 + 相关性过滤 | 中（依赖 createAuxiliarySession 实现） |
| **T6.4 其余 7 个模式** | 逐个独立交付 | 低（独立，不影响现有） |
| **T6.x Menu 对接** | `/response` slash 命令 + menu-handler | 低 |

---

最后更新：2026-06-23
