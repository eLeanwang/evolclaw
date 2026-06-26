# Task 1 - 第一批测试执行记录

**执行日期**: 2026-06-25  
**执行人**: Claude Code  
**批次**: 第一批（简单边界情况，无需特殊环境）

---

## 测试清单

- [ ] 测试点 3.1: 空消息
- [ ] 测试点 3.2: 超长消息（>10000 字符）
- [ ] 快照对比验证（5 个关键字段）

---

## 测试点 3.1: 空消息

**测试目标**: 验证引擎对空消息、纯空格消息的处理

**测试方法**: 
1. 通过 AUN channel 发送空消息
2. 通过 AUN channel 发送纯空格消息 "   "
3. 观察引擎行为和日志

**预期结果**:
- 引擎优雅处理（不崩溃）
- 可能的行为：
  - 忽略空消息（drop）
  - 回复提示"消息为空"
  - 正常处理但 agent 回复"没有收到内容"

**执行步骤**:
```bash
# 1. 启用快照探针
export RESPONSE_SNAPSHOT=1

# 2. 启动 daemon
ec daemon start

# 3. 发送空消息（通过 AUN CLI）
# TODO: 确认如何发送空消息的方法

# 4. 查看日志
tail -f ~/.evolclaw/logs/daemon.log

# 5. 查看快照
cat ~/.evolclaw/data/response-snapshots/behavior.snapshot.jsonl | tail -5
```

**实际结果**: 待执行

**快照特征**: 待记录

---

## 测试点 3.2: 超长消息（>10000 字符）

**测试目标**: 验证引擎对超长消息的处理

**测试方法**:
1. 构造一条 15000 字符的消息
2. 通过 AUN channel 发送
3. 观察引擎行为和日志
4. 检查是否有截断、错误、性能问题

**预期结果**:
- 引擎正常处理（不崩溃）
- 可能的行为：
  - 消息被接收并传递给 agent
  - Agent 处理超长输入（可能截断）
  - 响应正常返回

**测试数据准备**:
```javascript
// 生成 15000 字符的测试消息
const testMsg = "测试".repeat(5000); // 10000 字符
const testMsg2 = "A".repeat(15000);  // 15000 字符
```

**执行步骤**:
```bash
# 1. 创建测试消息文件
echo "$(python3 -c "print('测试' * 5000)")" > /tmp/long_msg.txt

# 2. 发送消息（通过 CLI）
# TODO: 确认如何发送文件内容作为消息

# 3. 观察日志
grep -A10 "超长\|truncate\|too long" ~/.evolclaw/logs/daemon.log

# 4. 检查快照
# 检查 hasReceivedText, fullText 长度等
```

**实际结果**: 待执行

**快照特征**: 待记录

---

## 快照对比验证

**测试目标**: 验证快照中的 5 个关键字段一致性

**关键字段**:
1. `source`: 应该是 "plugin"（新引擎）
2. `chatMode`: "interactive" 或 "proactive"
3. `proactiveState`: proactive 下非 null
4. `policyHook`: proactive 下首工具表态时存在
5. `outbound`: 至少有一条出站记录

**验证方法**:
```bash
# 1. 读取最近的快照
SNAPSHOT_FILE=~/.evolclaw/data/response-snapshots/behavior.snapshot.jsonl

# 2. 提取关键字段
cat $SNAPSHOT_FILE | jq '{
  ts, sessionId, source, chatMode, 
  hasProactiveState: (.proactiveState != null),
  hasPolicyHook: (.policyHook != null),
  outboundCount: (.outbound | length)
}' | tail -10

# 3. 统计 source 分布（应该全是 plugin）
cat $SNAPSHOT_FILE | jq -r '.source' | sort | uniq -c

# 4. 统计 chatMode 分布
cat $SNAPSHOT_FILE | jq -r '.chatMode' | sort | uniq -c
```

**预期结果**:
- 所有快照 `source: "plugin"`（100%）
- chatMode 分布合理（interactive + proactive）
- proactive 快照有 proactiveState
- 首工具表态场景有 policyHook

**实际结果**: 待执行

---

## 测试前检查

### 环境确认
- [ ] evolclaw daemon 正在运行
- [ ] RESPONSE_SNAPSHOT=1 已设置
- [ ] 快照文件路径存在：`~/.evolclaw/data/response-snapshots/`
- [ ] 有可用的 AUN agent（llbot/dddd/llagent2）

### 工具确认
- [ ] `jq` 已安装（用于 JSON 分析）
- [ ] `python3` 已安装（用于生成测试数据）
- [ ] 日志路径可访问：`~/.evolclaw/logs/`

---

## 执行计划

1. **环境准备**（5 分钟）
   - 确认 daemon 状态
   - 启用快照探针
   - 备份当前快照文件

2. **测试点 3.1: 空消息**（10 分钟）
   - 执行测试
   - 记录结果
   - 分析快照

3. **测试点 3.2: 超长消息**（15 分钟）
   - 生成测试数据
   - 执行测试
   - 记录结果
   - 分析快照

4. **快照对比验证**（10 分钟）
   - 运行统计脚本
   - 分析数据
   - 记录结论

5. **总结**（5 分钟）
   - 汇总测试结果
   - 更新 task1-verification-log.md
   - 标记完成状态

**预计总时间**: 45 分钟

---

## 注意事项

1. **快照探针性能影响**: 快照会略微增加延迟，测试完成后记得关闭
2. **超长消息限制**: 注意 AUN 协议的消息大小限制（通常 1MB）
3. **日志大小**: 测试期间日志会增长，注意磁盘空间
4. **Agent 费用**: 每次测试都会调用 agent API，产生费用

---

## 测试结果汇总

（待测试完成后填写）

### 成功的测试
- [ ] 

### 失败的测试
- [ ] 

### 发现的问题
- [ ] 

### 建议的改进
- [ ] 

---

## 文档历史

| 日期 | 修改 | 作者 |
|------|------|------|
| 2026-06-25 | 创建第一批测试执行计划 | Claude Code |
