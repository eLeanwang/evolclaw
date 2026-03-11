# EvolClaw Hook 同步策略（最终版）

## 测试结论 ✅

经过全面对比测试，确认了最佳 Hook 组合：

### 场景测试结果

| 场景 | Stop Hook | PostToolUse Hook |
|------|-----------|------------------|
| 纯文本回复（无工具） | ✅ 触发 1 次 | ❌ 不触发 |
| 使用 1 个工具 | ✅ 触发 1 次 | ✅ 触发 1 次 |
| 使用 2 个工具 | ✅ 触发 1 次 | ✅ 触发 2 次 |

### 关键发现

**Stop Hook 的特性**：
- ✅ 在每次响应完成后触发（无论是否使用工具）
- ✅ 每次对话只触发 1 次
- ✅ 覆盖所有场景
- ✅ 提供 session_id 和 transcript_path

**PostToolUse Hook 的局限**：
- ❌ 只在使用工具时触发
- ❌ 纯文本回复场景下不触发
- ⚠️ 多次工具使用会触发多次（可能导致重复同步）

## 最终推荐方案

### 主同步机制：Stop Hook

```typescript
hooks: {
  Stop: [{
    hooks: [async (input) => {
      // 每次响应完成后同步
      await messageSync.syncLatest(
        input.session_id,
        input.transcript_path
      );
      return {};
    }]
  }]
}
```

### 兜底机制：定期全量同步

```typescript
// 每 5 分钟执行一次全量同步
setInterval(async () => {
  for (const session of activeSessions) {
    await messageSync.syncAllIfNeeded(
      session.id,
      session.transcriptPath
    );
  }
}, 5 * 60 * 1000);
```

## 优势总结

1. **完整覆盖**：Stop Hook 覆盖所有对话场景
2. **简单可靠**：只需一个 Hook，逻辑清晰
3. **避免重复**：每次响应只同步一次
4. **时机合适**：响应完成后同步，确保数据完整
5. **性能优化**：比 PostToolUse 触发次数更少

## 实现示例

```typescript
class InstanceManager {
  private messageSync: MessageSync;

  async processMessage(sessionId: string, prompt: string, cwd: string) {
    const stopHook: HookCallback = async (input) => {
      // 响应完成后同步
      await this.messageSync.syncLatest(
        input.session_id,
        input.transcript_path
      );
      return {};
    };

    let fullResponse = '';

    for await (const message of query({
      prompt,
      options: {
        cwd,
        hooks: {
          Stop: [{ hooks: [stopHook] }],
        },
      },
    })) {
      if ('result' in message) {
        fullResponse = message.result;
      }
    }

    return fullResponse;
  }
}
```

---

**更新日期**：2026-03-07
**验证状态**：✅ 已完成对比测试
**最终方案**：Stop Hook + 定期同步
