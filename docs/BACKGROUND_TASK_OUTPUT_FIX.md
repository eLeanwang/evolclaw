# 后台任务输出泄漏问题修复报告

## 问题描述

**现象**：
- 用户在项目A发送消息，任务开始执行
- 用户切换到项目B
- 项目A的输出仍然显示在聊天窗口中
- 用户在项目B看到了项目A的工具调用和输出

**聊天记录示例**：
```
用户: [在 openclaw] 请统计一下今天收发的消息条数
用户: /switch happyclaw
系统: ✓ 已切换到项目: happyclaw
系统: 🔧 Bash: List files in current directory  ← openclaw 的输出！
系统: 🔧 Bash: List files in .openclaw directory ← openclaw 的输出！
系统: 🔧 Read: /data/openclaw-root/feishu_stats.js ← openclaw 的输出！
系统: 今天（2026-03-11）的消息统计结果... ← openclaw 的输出！
```

## 根本原因

### 问题 1：isBackground 判断时机错误

**原代码**（src/core/message-processor.ts:66）：
```typescript
// 判断是否是后台任务
const activeSession = await this.sessionManager.getActiveSession(message.channel, message.channelId);
const isBackground = activeSession ? session.id !== activeSession.id : false;
```

**问题**：
- `isBackground` 只在**任务开始时**判断一次
- 如果任务执行过程中用户切换了项目，`isBackground` 不会更新
- 任务仍然认为自己是前台任务

### 问题 2：StreamFlusher 的 send 回调是静态的

**原代码**（src/core/message-processor.ts:96-100）：
```typescript
const flusher = new StreamFlusher(
  (text) => adapter.sendText(message.channelId, text),  // 静态回调
  3000,
  options?.fileMarkerPattern
);
```

**问题**：
- StreamFlusher 在任务开始时创建
- `send` 回调固定为 `adapter.sendText(channelId, text)`
- 即使任务变成后台，回调仍然会继续发送输出
- 无法感知项目切换

### 问题 3：processEventStream 中的判断无效

**原代码**（src/core/message-processor.ts:220-253）：
```typescript
// === 前台任务：正常处理所有事件 ===
if (!isBackground) {
  // 工具调用
  if (event.type === 'assistant' && event.message?.content) {
    for (const content of event.message.content) {
      if (content.type === 'tool_use') {
        const desc = this.formatToolDescription(content);
        flusher.addActivity(`🔧 ${content.name}${desc ? ': ' + desc : ''}`);
      }
    }
  }

  // 文本输出
  if (event.type === 'result' && event.result) {
    flusher.addText(event.result);
  }

  continue;
}
```

**问题**：
- 虽然后台任务不会调用 `flusher.addActivity()` 和 `flusher.addText()`
- 但 `isBackground` 是静态的，不会随着项目切换而更新
- 所以任务仍然会继续添加输出到 flusher

## 解决方案

### 修复：动态判断后台状态

**修改文件**：`src/core/message-processor.ts`

**修改内容**：
```typescript
// 创建 StreamFlusher，使用动态判断
const flusher = new StreamFlusher(
  async (text) => {
    // 动态判断是否是后台任务
    const currentActiveSession = await this.sessionManager.getActiveSession(
      message.channel,
      message.channelId
    );
    const isCurrentlyBackground = currentActiveSession
      ? session.id !== currentActiveSession.id
      : false;

    if (!isCurrentlyBackground) {
      await adapter.sendText(message.channelId, text);
    }
    // 后台任务：静默，不发送输出
  },
  3000,
  options?.fileMarkerPattern
);
```

**关键改进**：
1. **动态判断**：每次 flush 时都重新查询活跃会话
2. **实时感知**：能够感知项目切换
3. **静默后台**：后台任务的输出不会发送到聊天窗口

## 修复效果

### 修复前
```
用户: [在 projectA] 帮我分析代码
系统: 正在读取文件...
用户: /switch projectB
系统: ✓ 已切换到项目: projectB
系统: 🔧 Read: /projectA/file.ts  ← 泄漏！
系统: 🔧 Bash: grep ...            ← 泄漏！
系统: 分析结果：...                ← 泄漏！
```

### 修复后
```
用户: [在 projectA] 帮我分析代码
系统: 正在读取文件...
用户: /switch projectB
系统: ✓ 已切换到项目: projectB
[projectA 的输出被静默，不再显示]
系统: [后台-projectA] ✓ 任务完成  ← 只显示完成通知
```

## 测试验证

**测试场景**：
1. 在项目A发送消息，任务开始执行
2. 立即切换到项目B
3. 验证项目A的中间输出不会显示
4. 验证项目A的完成通知正常显示

**预期结果**：
- ✅ 项目A的工具调用不显示
- ✅ 项目A的文本输出不显示
- ✅ 项目A的完成通知正常显示
- ✅ 项目B的输出正常显示

## 相关文件

**修改文件**：
- `src/core/message-processor.ts` - 修复 StreamFlusher 的 send 回调

**测试文件**：
- `tests/unit/background-task-output.test.ts` - 验证修复

## 注意事项

1. **性能影响**：每次 flush 都会查询数据库，但影响很小（flush 间隔 3 秒）
2. **后台通知**：后台任务的完成/错误通知仍然会发送（这是预期行为）
3. **切换时机**：无论何时切换项目，都能立即生效

## 总结

这个修复解决了多项目并行执行中最严重的用户体验问题：**后台任务的输出泄漏**。

通过将静态的 `isBackground` 判断改为动态判断，确保了：
- 切换项目后，旧项目的输出立即停止
- 用户不会被后台任务的输出打扰
- 后台任务的关键事件（完成/错误）仍然能够通知用户

修复日期：2026-03-11
