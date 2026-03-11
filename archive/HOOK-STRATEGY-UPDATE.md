# Hook 同步策略更新报告

## 重大发现 🎯

通过全面测试，发现了比 PostToolUse 更可靠的 Hook 组合！

## Hook 触发条件验证

| Hook | 触发时机 | 纯文本回复 | 使用工具 | 提供数据 |
|------|---------|-----------|---------|---------|
| **Stop** | 每次响应完成后 | ✅ 触发 | ✅ 触发 | session_id, transcript_path |
| **UserPromptSubmit** | 用户提交消息时 | ✅ 触发 | ✅ 触发 | session_id, transcript_path, prompt |
| PostToolUse | 工具使用后 | ❌ 不触发 | ✅ 触发 | session_id, transcript_path, tool_* |

## 关键问题

**PostToolUse Hook 的局限性**：
- ❌ 只在使用工具时触发
- ❌ 如果 Agent 只回复文本（不调用工具），消息不会被同步
- ❌ 无法覆盖所有对话场景

**Stop Hook 的优势**：
- ✅ 在每次响应完成后都触发
- ✅ 覆盖纯文本回复场景
- ✅ 覆盖工具使用场景
- ✅ 提供完整的 session_id 和 transcript_path

## 推荐的新同步策略

### 方案 A：Stop Hook（推荐）

**使用 Stop Hook 作为主要同步点**

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

**优势**：
- ✅ 覆盖所有场景（纯文本 + 工具使用）
- ✅ 简单可靠，只需一个 Hook
- ✅ 在响应完成后同步，时机合适

**劣势**：
- ⚠️ 只在响应完成后同步，用户消息需要等到响应后才同步

### 方案 B：UserPromptSubmit + Stop（最完整）

**双向同步**

```typescript
hooks: {
  UserPromptSubmit: [{
    hooks: [async (input) => {
      // 用户消息提交后立即同步
      await messageSync.syncLatest(
        input.session_id,
        input.transcript_path
      );
      return {};
    }]
  }],
  Stop: [{
    hooks: [async (input) => {
      // Agent 响应完成后同步
      await messageSync.syncLatest(
        input.session_id,
        input.transcript_path
      );
      return {};
    }]
  }]
}
```

**优势**：
- ✅ 最完整的覆盖（用户输入 + Agent 输出）
- ✅ 实时性更好
- ✅ 可以分别处理用户消息和 Agent 响应

**劣势**：
- ⚠️ 需要两个 Hook，略微增加复杂度
- ⚠️ 可能有重复同步（但增量同步可以处理）

### 方案 C：Stop + 定期同步（平衡）

**结合 Stop Hook 和定期全量同步**

```typescript
// 主要同步
hooks: {
  Stop: [{ hooks: [syncHook] }]
}

// 兜底同步（每 5 分钟）
setInterval(() => {
  for (const session of activeSessions) {
    await messageSync.syncAllIfNeeded(session.id, session.transcriptPath);
  }
}, 5 * 60 * 1000);
```

**优势**：
- ✅ Stop Hook 覆盖所有场景
- ✅ 定期同步作为兜底
- ✅ 简单可靠

## 最终推荐

**推荐使用方案 C：Stop + 定期同步**

理由：
1. Stop Hook 覆盖所有对话场景
2. 定期同步提供可靠的兜底机制
3. 实现简单，维护成本低
4. 性能开销小

## 对 EvolClaw 设计的影响

### 需要更新的部分

1. **同步策略**：从 PostToolUse 改为 Stop
2. **Hook 配置**：更新 Hook 注册代码
3. **文档**：更新设计文档中的同步机制说明

### 不需要更改的部分

1. ✅ 数据库 Schema
2. ✅ JSONL 文件读取逻辑
3. ✅ 增量同步算法
4. ✅ 定期全量同步机制

---

**更新日期**：2026-03-07
**验证状态**：✅ 已完成全面测试
**推荐方案**：Stop Hook + 定期同步
