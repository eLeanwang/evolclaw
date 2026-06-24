# Task 1: 场景验证日志

**开始时间**: 2026-06-23  
**目标**: 验证插件化响应引擎在不同场景下的表现

---

## 验证环境

- **引擎**: ResponseEngine (插件化)
- **可用 Agent**: llbot.agentid.pub (褚岩), dddd.agentid.pub (罗辑), llagent2.agentid.pub (栖梧)
- **快照探针**: 已启用（response-snapshot.ts 存在）

---

## 场景 1: 群聊场景（ProactiveMode）

### 测试点 1.1: @提及触发响应

**测试步骤**:
- [ ] 找一个测试群
- [ ] 发送 @agent 消息
- [ ] 验证响应行为

**预期结果**:
- agent 收到 @提及消息
- ProactiveMode 处理：工具调用才回复
- 首工具表态检查触发

**实际结果**: 待测试

---

### 测试点 1.2: 首工具表态验证

**测试步骤**:
- [x] 发送测试消息触发 agent
- [x] 检查是否触发 `pre_tool_1stmsgchk`
- [x] 验证 policyHook 行为

**预期结果**:
- policyHook: triggered=true, blocked=false（首工具是允许的）
- 快照中记录 `policyHook` 字段

**实际结果**: ✅ **通过**
- Agent: llagent2.agentid.pub
- 配置: `response_modes.default_private: "proactive"` with `pre_tool_1stmsgchk: true`
- 快照记录:
  - `chatMode: "proactive"`
  - `proactiveState: {preTool1stMsgChk:true, toolUseReminder:true, chatType:"private"}`
  - `policyHook: {triggered:true, blocked:false, toolName:"Bash"}`
  - `source: "plugin"`

---

### 测试点 1.3: 工具汇报提醒

**测试步骤**:
- [ ] 发送消息让 agent 执行多个工具
- [ ] 观察工具计数提醒
- [ ] 检查队列未读提醒

**预期结果**:
- 工具使用有计数提醒
- 快照中记录 `toolReminder` 字段

**实际结果**: 待测试

---

## 场景 2: Interactive 模式（私聊）

### 测试点 2.1: 普通文本立即回复

**测试步骤**:
- [x] 私聊发送普通文本消息
- [x] 验证 agent 立即回复（输出即回复）

**预期结果**:
- InteractiveMode 处理
- 普通文本立即作为回复发送
- chatMode = 'interactive'

**实际结果**: ✅ **通过**
- Agent: dddd.agentid.pub
- 配置: `response_modes.default_private: "interactive"`
- 快照记录:
  - `chatMode: "interactive"`
  - `proactiveState: null`
  - `source: "plugin"`
  - outbound 包含 `result.text` (文本立即发送)
- 日志确认: `chatmode=interactive`

---

### 测试点 2.2: 文件标记发送

**测试步骤**:
- [ ] 让 agent 输出 `[SEND_FILE:path/to/file]`
- [ ] 验证文件通过渠道发送

**预期结果**:
- afterProcess 钩子捕获文件标记
- 文件通过渠道 API 发送
- 快照中记录 `fileMarkers` 字段

**实际结果**: 待测试

---

### 测试点 2.3: 跨渠道文件发送

**测试步骤**:
- [ ] 让 agent 输出 `[SEND_FILE:feishu:path/to/file]`
- [ ] 验证跨渠道发送逻辑

**预期结果**:
- 正确解析渠道前缀
- 通过指定渠道发送文件

**实际结果**: 待测试

---

## 场景 3: 边界情况

### 测试点 3.1: 空消息

**测试步骤**:
- [ ] 发送空消息（仅空格或空字符串）
- [ ] 验证处理逻辑

**预期结果**:
- 不崩溃
- 按配置决定是否响应

**实际结果**: 待测试

---

### 测试点 3.2: 超长消息

**测试步骤**:
- [ ] 发送超长文本消息（>10000 字符）
- [ ] 验证处理和回复

**预期结果**:
- 正常处理，不截断
- 或按渠道限制处理

**实际结果**: 待测试

---

### 测试点 3.3: 多张图片附件

**测试步骤**:
- [ ] 发送带多张图片的消息
- [ ] 验证 agent 能接收和处理

**预期结果**:
- 所有图片正常接收
- agent 能识别和处理

**实际结果**: 待测试

---

### 测试点 3.4: 中断处理

**测试步骤**:
- [ ] 发送消息触发长时间处理
- [ ] 在处理过程中发送新消息
- [ ] 验证中断行为

**预期结果**:
- 优雅处理中断
- 新消息按优先级处理

**实际结果**: 待测试

---

## 快照对比验证

### 启用快照模式

```bash
export RESPONSE_SNAPSHOT=1
node dist/cli/index.js restart
```

### 快照文件位置

`~/.evolclaw/data/eck-debug/response-snapshots.jsonl`

### 验证关键字段

- [ ] `source`: 'plugin'
- [ ] `chatMode`: 'interactive' | 'proactive'
- [ ] `proactiveState`: {preTool1stMsgChk, toolUseReminder, chatType}
- [ ] `policyHook`: {triggered, blocked, toolName}
- [ ] `outbound`: [{kind, decision}]

---

## 日志分析

### 日志文件位置

`~/.evolclaw/logs/evolclaw.log`

### 验证点

- [ ] 钩子调用记录（beforeProcess, configureRun, onToolUse, onComplete, afterProcess）
- [ ] 无未处理异常
- [ ] 模式选择正确（Coordinator 日志）

---

## 测试结果汇总

**总测试点**: 13  
**通过**: 2  
**失败**: 0  
**跳过**: 11  

**整体状态**: 🔄 进行中

**已验证场景**:
- ✅ Interactive 模式：普通文本立即回复（测试点 2.1）
- ✅ Proactive 模式：首工具表态检查（测试点 1.2）

**关键发现**:
1. ✅ 配置字段：使用 `response_modes.default_private` / `response_modes.default_group`，而非旧的 `chatmode` 字段
2. ✅ Interactive 模式快照特征：`chatMode:"interactive"`, `proactiveState:null`, outbound 包含 `result.text`
3. ✅ Proactive 模式快照特征：`chatMode:"proactive"`, `proactiveState:{...}`, `policyHook:{...}`
4. ✅ 插件化引擎正常工作：所有快照 `source:"plugin"`

**剩余测试点**:
- 群聊场景（需要创建测试群）
- 文件标记发送（需要构造特殊场景）
- 边界情况（空消息、超长消息、多图片、中断）
- 工具汇报提醒（需要多工具调用场景）

---

## 发现的问题

（无）

---

## 后续行动

1. 逐个执行测试点
2. 记录实际结果
3. 对比快照数据
4. 分析日志
5. 总结验证结论
