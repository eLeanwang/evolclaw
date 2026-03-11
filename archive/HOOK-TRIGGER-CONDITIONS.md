# Hook 触发条件验证报告

## PreCompact Hook

**触发条件**（根据官方文档）：
1. **手动压缩**：用户执行 `/compact` 命令
2. **自动压缩**：当输入 token 接近或超过上下文窗口阈值时自动触发

**我们的测试结果**：
- ❌ 短会话未触发（符合预期）
- ❌ 多轮对话未触发（可能未达到 token 阈值）

**结论**：PreCompact Hook 需要会话足够长才会自动触发，或者需要手动执行 `/compact` 命令。

## SessionEnd Hook

**触发条件**（根据官方文档）：
1. 用户执行 `/clear` 命令
2. 用户登出
3. 会话因其他原因终止

**我们的测试结果**：
- ❌ query() 自然结束未触发
- 需要显式调用 `/clear` 或其他终止命令

**结论**：SessionEnd Hook 不会在 query() 自然结束时触发，需要显式的会话终止操作。

## 对 EvolClaw 设计的影响

### 1. 依赖 PostToolUse Hook 作为主要同步机制 ✅

**理由**：
- PostToolUse 在每次工具使用后可靠触发
- 可以实现接近实时的增量同步
- 已验证可以访问 transcript_path 和完整上下文

### 2. PreCompact Hook 作为兜底机制 ⚠️

**调整**：
- PreCompact 只在长会话中触发，不能作为可靠的同步点
- 建议改为**定期全量同步**作为兜底机制
- 例如：每 5 分钟或每 N 条消息执行一次全量同步

### 3. SessionEnd Hook 可选 ⚠️

**调整**：
- SessionEnd 需要显式终止操作，在 EvolClaw 的使用场景中不太适用
- 飞书/ACP 消息驱动的场景中，会话通常是长期运行的
- 建议：不依赖 SessionEnd Hook

## 推荐的同步策略

```typescript
class MessageSync {
  private lastSyncedLine: Map<string, number> = new Map();
  private lastFullSyncTime: Map<string, number> = new Map();

  // PostToolUse Hook 触发 - 主要同步机制
  async syncLatest(sessionId: string, transcriptPath: string) {
    const lastLine = this.lastSyncedLine.get(sessionId) || 0;
    const newMessages = await this.readJSONLFromLine(transcriptPath, lastLine);

    for (const msg of newMessages) {
      await this.saveToDatabase(msg);
    }

    this.lastSyncedLine.set(sessionId, lastLine + newMessages.length);
  }

  // 定期全量同步 - 兜底机制（每 5 分钟）
  async syncAllIfNeeded(sessionId: string, transcriptPath: string) {
    const lastSync = this.lastFullSyncTime.get(sessionId) || 0;
    const now = Date.now();

    if (now - lastSync > 5 * 60 * 1000) { // 5 分钟
      this.lastSyncedLine.set(sessionId, 0);
      await this.syncLatest(sessionId, transcriptPath);
      this.lastFullSyncTime.set(sessionId, now);
    }
  }
}
```

## 参考资料

- [Claude Agent SDK Hook 系统](https://claude.com)
- [PreCompact Hook 触发条件](https://anthropic.com)

---

**最后更新**：2026-03-07
