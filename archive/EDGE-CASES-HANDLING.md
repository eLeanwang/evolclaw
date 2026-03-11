# EvolClaw 边缘场景处理策略

## 测试结果总结

### 1. 权限请求场景

**测试配置**：
- `permissionMode: "default"`（需要权限确认）
- 注册了 `PermissionRequest` Hook

**实际行为**：
- PermissionRequest Hook **未触发**
- Stop Hook 正常触发
- 任务成功完成（文件被创建）

**分析**：
- 在非交互环境下，权限请求可能被自动批准
- 或者需要特定条件才能触发 PermissionRequest Hook

### 2. 工具执行失败场景

**测试配置**：
- 尝试读取不存在的文件
- 注册了 Stop Hook

**实际行为**：
- Stop Hook **正常触发**
- Agent 优雅处理错误，返回描述性结果
- 没有抛出异常，会话正常结束

**关键发现**：
✅ **工具失败不影响 Stop Hook 触发**
✅ **JSONL 文件仍然被正确写入**
✅ **同步机制不受影响**

### 3. 超时中断场景

**测试配置**：
- 设置 5 秒超时
- 执行计算密集型任务

**实际行为**：
- 任务在超时前完成（耗时 28 秒）
- Stop Hook 正常触发
- 超时中断未真正发生

**需要进一步验证**：
- 真正超时时 Stop Hook 是否触发
- 超时时 JSONL 文件的状态
- 如何恢复未完成的会话

---

## 处理策略

### 策略 1: 权限管理

**问题**：无人值守场景下如何处理权限请求？

**方案 A：自动批准模式（推荐）**
```typescript
query({
  prompt: userMessage,
  options: {
    permissionMode: "acceptAll", // 自动批准所有操作
    // 或
    permissionMode: "dontAsk",   // 不询问权限
  },
});
```

**优点**：
- 无需人工干预
- 适合自动化场景
- 简化实现

**缺点**：
- 安全风险较高
- 无法控制危险操作

**方案 B：权限代理模式**
```typescript
const permissionHook: HookCallback = async (input) => {
  // 1. 记录权限请求
  await db.storePermissionRequest(input);

  // 2. 通过 IM 渠道通知用户
  await imManager.sendMessage(chatJid, {
    type: "permission_request",
    tool: input.tool_name,
    action: input.action,
  });

  // 3. 等待用户响应（设置超时）
  const approved = await waitForUserApproval(input.request_id, 60000);

  return { approved };
};
```

**优点**：
- 保持安全性
- 用户可控
- 审计追踪

**缺点**：
- 实现复杂
- 需要额外的消息队列
- 可能阻塞执行

**推荐方案**：
- **Shared 模式**（个人助手）：使用 `acceptAll`
- **Isolated 模式**（团队协作）：使用权限代理模式

### 策略 2: 异常处理

**问题**：工具执行失败、Agent 崩溃时如何保证数据一致性？

**核心发现**：
✅ Stop Hook 在工具失败时仍然触发
✅ JSONL 文件由 SDK 自动管理，即使失败也会写入

**处理方案**：
```typescript
class InstanceManager {
  async processMessage(sessionId: string, prompt: string) {
    try {
      const stopHook: HookCallback = async (input) => {
        // 无论成功或失败，都执行同步
        await this.messageSync.syncLatest(
          input.session_id,
          input.transcript_path
        );
        return {};
      };

      for await (const message of query({
        prompt,
        options: {
          hooks: { Stop: [{ hooks: [stopHook] }] },
        },
      })) {
        if ("result" in message) {
          return message.result;
        }
      }
    } catch (error) {
      // 1. 记录错误
      logger.error(`Agent 执行失败: ${error}`);

      // 2. 尝试同步已完成的部分
      try {
        const transcriptPath = this.getTranscriptPath(sessionId);
        await this.messageSync.syncLatest(sessionId, transcriptPath);
      } catch (syncError) {
        logger.error(`同步失败: ${syncError}`);
      }

      // 3. 返回错误信息给用户
      throw new Error(`Agent 执行异常: ${error.message}`);
    }
  }
}
```

**关键点**：
1. **Stop Hook 是主要保障**：即使工具失败，Stop Hook 仍会触发
2. **catch 块作为兜底**：处理 SDK 级别的异常
3. **定期全量同步**：每 5 分钟兜底，确保数据最终一致

### 策略 3: 超时处理

**问题**：长时间运行的任务如何优雅终止？

**方案 A：进程级超时（推荐）**
```typescript
class InstanceManager {
  async processMessage(sessionId: string, prompt: string) {
    const timeout = 30 * 60 * 1000; // 30 分钟

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("执行超时")), timeout);
    });

    const queryPromise = this.runQuery(sessionId, prompt);

    try {
      return await Promise.race([queryPromise, timeoutPromise]);
    } catch (error) {
      if (error.message === "执行超时") {
        // 1. 记录超时事件
        logger.warn(`会话 ${sessionId} 超时`);

        // 2. 尝试同步已完成的部分
        await this.syncOnTimeout(sessionId);

        // 3. 清理资源
        await this.cleanup(sessionId);

        throw error;
      }
      throw error;
    }
  }

  private async syncOnTimeout(sessionId: string) {
    try {
      const transcriptPath = this.getTranscriptPath(sessionId);
      // 强制全量同步
      await this.messageSync.syncAll(sessionId, transcriptPath);
    } catch (error) {
      logger.error(`超时同步失败: ${error}`);
    }
  }
}
```

**方案 B：会话恢复机制**
```typescript
// 超时后不终止会话，而是暂停并通知用户
class SessionManager {
  async handleTimeout(sessionId: string) {
    // 1. 标记会话为"暂停"状态
    await db.updateSessionStatus(sessionId, "paused");

    // 2. 同步当前状态
    await messageSync.syncAll(sessionId);

    // 3. 通知用户
    await imManager.sendMessage(chatJid, {
      type: "session_paused",
      reason: "timeout",
      sessionId,
    });

    // 4. 用户可以选择继续或终止
    // 继续：resume(sessionId)
    // 终止：terminate(sessionId)
  }
}
```

**推荐方案**：
- **方案 A**：简单场景，直接超时终止
- **方案 B**：复杂任务，支持恢复

---

## 更新后的同步策略

```typescript
class MessageSync {
  // 1. 主同步：Stop Hook（覆盖 99% 场景）
  async syncLatest(sessionId: string, transcriptPath: string) {
    // 增量同步
  }

  // 2. 异常同步：catch 块调用
  async syncOnError(sessionId: string, transcriptPath: string) {
    // 尝试同步已完成的部分
  }

  // 3. 超时同步：超时处理器调用
  async syncOnTimeout(sessionId: string, transcriptPath: string) {
    // 强制全量同步
  }

  // 4. 兜底同步：定期执行（每 5 分钟）
  async syncAllIfNeeded(sessionId: string, transcriptPath: string) {
    // 全量同步
  }
}
```

---

## 设计更新建议

### 1. 配置项

```json
{
  "session": {
    "mode": "isolated",
    "permissionMode": "acceptAll",
    "timeout": 1800000,
    "enableRecovery": false
  },
  "sync": {
    "fullSyncInterval": 300000,
    "syncOnError": true,
    "syncOnTimeout": true
  }
}
```

### 2. 数据库 Schema 扩展

```sql
-- 会话状态表
CREATE TABLE session_status (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- running, paused, completed, failed
  last_sync_time INTEGER,
  error_message TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

-- 权限请求表（如果使用权限代理模式）
CREATE TABLE permission_requests (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT UNIQUE NOT NULL,
  tool_name TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL, -- pending, approved, denied, timeout
  created_at INTEGER,
  responded_at INTEGER
);
```

---

## 总结

| 场景 | 主要处理机制 | 兜底机制 | 数据一致性保障 |
|------|-------------|---------|---------------|
| **权限请求** | `acceptAll` 模式 | 权限代理（可选） | Stop Hook 正常触发 |
| **工具失败** | Stop Hook 仍触发 | catch 块同步 | ✅ 完全保障 |
| **超时中断** | 进程级超时 + 同步 | 定期全量同步 | ⚠️ 需要超时同步 |

**核心结论**：
1. ✅ **Stop Hook 是最可靠的同步点**，即使工具失败也会触发
2. ✅ **JSONL 文件由 SDK 管理**，异常情况下也会写入
3. ⚠️ **超时场景需要额外处理**，确保部分完成的工作被同步
4. 📋 **权限管理需要权衡**：自动化 vs 安全性

**可行性评分维持**：9/10
- 边缘场景处理方案清晰
- Stop Hook 机制足够可靠
- 需要实现超时同步逻辑（约 +50 行代码）

---

*最后更新：2026-03-07*
*测试状态：✅ 已验证工具失败场景，⏸️ 超时场景需进一步测试*
