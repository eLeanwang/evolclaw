# 故障排查

## 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | 响应模式故障排查 |
| 版本 | v1.0 |
| 状态 | Draft |
| 适用读者 | 运维、开发者、终端用户 |

---

## 一、常见问题

### Q1：切换响应模式后没有生效

**症状**：执行 `ec response set` 后，会话行为没变化。

**排查**：

1. 确认设置成功：
   ```bash
   ec response current --self <aid>
   ```
   检查输出的模式是否为目标模式。

2. 确认作用域正确：
   - 改的是 agent 级还是 relation 级？
   - relation override 优先级高于 agent 默认，可能被覆盖。

3. 确认生效时机：
   - 配置在**下一条消息**生效，当前正在处理的消息不受影响。

**解决**：
- 如果 relation override 覆盖了 agent 默认，用 `ec response reset --peer <X>` 清除。

### Q2：扩展模式注册失败

**症状**：`ec response register` 报错。

**排查**：

1. 模块路径是否正确？
2. 模块是否导出了实现 `ResponseMode` 接口的类？
3. `id` 是否与现有模式冲突？

**解决**：
- 检查模块导出，确保实现所有必需方法。
- 更换唯一的 `id`。

### Q3：群聊中所有消息都被丢弃

**症状**：使用 `dual-session` 或 `selective-response` 后，群里没有任何响应。

**排查**：

1. 检查阈值配置：
   ```bash
   ec response config dual-session --self <aid>
   ```
   - `relevance_threshold` 是否过高？
   - 白名单是否配置错误？

2. 查看决策日志：
   ```bash
   ec ctl log --grep "ResponseMode"
   ```
   查看每条消息的 `reason` 字段。

**解决**：
- 降低 `relevance_threshold`（如 0.7 → 0.5）。
- 检查白名单/黑名单配置。

### Q4：双会话模式响应很慢

**症状**：`dual-session` 模式下，每条消息处理延迟明显。

**原因**：辅助会话每条消息都调用模型。

**解决**：
- 使用更轻量的模型：
  ```bash
  ec response config set auxiliary_model haiku --mode dual-session --self <aid>
  ```
- 考虑切换到 `selective-response`（规则过滤，无模型调用）。

### Q5：proactive 模式下 agent 不回复

**症状**：proactive 模式下，agent 输出了内容但对端收不到。

**原因**：proactive 模式下普通文本被投影为"思考过程"，不是正式回复。必须通过工具调用发送。

**解决**：
- 这是设计行为。agent 需要显式调用 `ec msg send` 才能发送正式回复。
- 检查 agent 的系统提示是否正确说明了 proactive 行为。

详见 [架构文档 - proactive 设计](./architecture.md)。

### Q6：配置参数被拒绝

**症状**：`ec response config set` 报错"参数无效"。

**原因**：参数不符合模式的 `configSchema`。

**排查**：
```bash
ec response info <mode-id>
```
查看模式支持的配置参数及类型。

**解决**：
- 确认参数名拼写正确。
- 确认参数类型匹配（数字不要加引号）。
- 确认数值在允许范围内。

---

## 二、诊断命令

### 查看当前模式

```bash
ec response current --self <aid> [--peer <X>] --format json
```

输出包含：模式 ID、来源、生效配置。

### 查看模式详情

```bash
ec response info <mode-id>
```

输出包含：描述、适用场景、配置 schema。

### 查看响应决策日志

```bash
# 查看所有响应模式日志
ec ctl log --grep "ResponseMode"

# 查看特定模式日志
ec ctl log --grep "dual-session"

# 实时跟踪
ec ctl log --tail --grep "ResponseMode"
```

### 查看调度状态

```bash
ec scheduler status --format json
```

输出包含：活跃 slot 数、等待队列、预算状态。

### 查看队列状态

```bash
ec ctl queue
```

输出当前会话队列中的消息。

---

## 三、日志分析

### 日志格式

响应模式的关键操作都会记录日志：

```
[ResponseMode] [dual-session] 消息 msg_xxx 决策: drop, reason: 相关性 0.3 过低
[ResponseMode] [dual-session] 消息 msg_yyy 决策: process, queueBehavior: priority, reason: 相关性 0.85
[Coordinator] 解析模式: session=xxx, mode=dual-session, source=relation
[DecisionExecutor] 执行入站决策: action=process, queueBehavior=enqueue
[SlotManager] 分配 slot: session=xxx, priority=85
[SlotManager] yieldControl: session=xxx, decision=continue, tokenUsed=1200
```

### 关键日志点

| 日志前缀 | 含义 |
|----------|------|
| `[Coordinator]` | 模式解析 |
| `[ResponseMode]` | 决策过程 |
| `[DecisionExecutor]` | 决策执行 |
| `[SlotManager]` | 调度决策 |

### 追踪一条消息

```bash
# 用 messageId 追踪完整流程
ec ctl log --grep "msg_xxx"
```

应该看到：
1. 模式解析
2. 入站决策
3. 队列操作
4. slot 分配
5. 处理
6. 出站决策
7. yieldControl

---

## 四、性能问题

### 辅助会话开销

**问题**：`dual-session` 辅助会话调用频繁。

**诊断**：
```bash
ec stats --grep "auxiliary"
```

**优化**：
- 用轻量模型（haiku）
- 提高 `relevance_threshold` 减少误判
- 考虑用规则过滤替代（`selective-response`）

### 队列积压

**问题**：消息处理不过来，队列积压。

**诊断**：
```bash
ec ctl queue
ec scheduler status
```

**优化**：
- 增加 `max_concurrent_sessions`
- 检查是否有会话卡住
- 考虑 `batch-processing` 攒批处理

### 调度延迟

**问题**：AI 驱动调度延迟高。

**原因**：每次调度都调用模型。

**优化**：
- 切换到 `hybrid` 策略
- 提高 `ai_trigger_threshold`
- 用轻量调度模型

---

## 五、配置问题

### 配置不生效

**排查顺序**：

1. 确认配置文件位置正确
2. 确认配置层级（defaults < agent < relation）
3. 确认 JSON 格式正确（无语法错误）
4. 查看加载日志：
   ```bash
   ec ctl log --grep "config"
   ```

### 配置冲突

**问题**：多个作用域配置冲突。

**解决**：
- 用 `ec response current` 查看最终生效值及来源
- 高优先级作用域会覆盖低优先级

---

## 六、模式开发调试

### 模式未加载

**排查**：
1. 是否在 `extensions/index.ts` 注册？
2. 注册函数是否被调用？
3. 模块是否有语法/导入错误？

```bash
ec response list
```
确认模式是否出现在列表中。

### 决策异常

**排查**：
- 在 `handleInbound`/`handleOutbound` 中添加日志
- 检查决策对象是否符合接口
- 确认 `action`/`method` 枚举值正确

### 队列问题

**排查**：
- `getQueue()` 是否返回有效队列
- 队列实现是否正确
- 优先级函数是否合理

---

## 七、紧急恢复

### 重置为默认模式

```bash
# 清除 agent 级响应模式配置
ec response reset --self <aid>

# 清除所有 relation override
# （逐个清除或编辑配置文件）
```

### 回退到 chatmode

如果响应模式系统出现严重问题，可临时回退：

1. 移除 `response_modes` 配置块
2. 系统回落到旧的 `chatmode` + `dispatch` 机制

### 重启 agent

```bash
ec agent reload <aid>
# 或
ec agent restart <aid>
```

---

## 附录：相关文档

- [架构设计](./architecture.md)
- [插件开发指南](./plugin-guide.md)
- [命令参考](./command-reference.md)
- [配置参考](./config-reference.md)
- [内置模式文档](./builtin-modes.md)
