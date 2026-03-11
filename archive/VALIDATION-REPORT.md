# EvolClaw 技术验证报告

## 验证时间
2026-03-07

## 验证目标
验证 Claude Agent SDK 的核心功能，确认 EvolClaw 设计方案的可行性。

## 验证结果总览

| 功能 | 状态 | 说明 |
|------|------|------|
| PostToolUse Hook | ✅ 完全可用 | Hook 正常触发，可访问完整上下文 |
| PreCompact Hook | ⚠️ 有限可用 | 需手动 `/compact` 或达到 token 阈值才触发 |
| SessionEnd Hook | ⚠️ 有限可用 | 需显式 `/clear` 命令或登出才触发 |
| JSONL 文件自动生成 | ✅ 完全可用 | SDK 自动管理，格式清晰 |
| 会话数据访问 | ✅ 完全可用 | Hook 可获取 transcript_path |

## 详细发现

### 1. PostToolUse Hook ✅

**验证结果**：完全可用

**Hook 提供的数据**：
```json
{
  "session_id": "52c57bd9-70a8-4737-bf1b-3965534c15a7",
  "transcript_path": "/root/.claude/projects/-home-happyclaw-data-groups-main-evolclaw/52c57bd9-70a8-4737-bf1b-3965534c15a7.jsonl",
  "cwd": "/home/happyclaw/data/groups/main/evolclaw",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Read",
  "tool_input": { ... },
  "tool_response": { ... },
  "tool_use_id": "toolu_01gDeAENBUOn4buC7thF3f2y"
}
```

**关键发现**：
- ✅ Hook 在每次工具使用后立即触发
- ✅ 提供 `transcript_path`，可直接定位 JSONL 文件
- ✅ 包含完整的工具输入和输出
- ✅ 提供 `session_id` 用于会话管理

**对 EvolClaw 的意义**：
- 可以在 PostToolUse Hook 中实现增量同步
- 通过 `transcript_path` 读取 JSONL 文件
- 通过 `session_id` 关联数据库记录

### 2. JSONL 文件格式 ✅

**文件位置**：
```
/root/.claude/projects/-home-happyclaw-data-groups-main-evolclaw/{session_id}.jsonl
```

**文件格式**：每行一个 JSON 对象，包含：
- `type`: 消息类型（user/assistant/queue-operation）
- `message`: 消息内容（role + content）
- `uuid`: 消息唯一标识
- `timestamp`: 时间戳
- `sessionId`: 会话 ID
- `cwd`: 工作目录
- `version`: SDK 版本

**示例消息**：
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{"type": "text", "text": "读取当前目录下的 package.json 文件"}]
  },
  "uuid": "9dab0b95-124f-458c-912e-0141470d198e",
  "timestamp": "2026-03-07T17:15:33.658Z",
  "sessionId": "52c57bd9-70a8-4737-bf1b-3965534c15a7"
}
```

**对 EvolClaw 的意义**：
- ✅ 格式清晰，易于解析
- ✅ Agent 可以直接用 Read/Grep 工具访问
- ✅ 包含完整的对话历史
- ✅ 支持增量读取（按行解析）

### 3. PreCompact Hook ⚠️

**验证结果**：有限可用

**触发条件**（已确认）：
1. **手动压缩**：用户执行 `/compact` 命令
2. **自动压缩**：输入 token 接近或超过上下文窗口阈值时自动触发

**测试结果**：
- ❌ 短会话（1-5 轮对话）未触发
- ❌ 中等会话（多次工具调用）未触发
- ✅ 需要达到 token 阈值或手动触发

**对 EvolClaw 的影响**：
- ⚠️ 不能作为可靠的同步触发点
- ✅ 可以作为长会话的兜底机制
- 💡 建议改用**定期全量同步**（每 5 分钟）作为兜底

### 4. SessionEnd Hook ⚠️

**验证结果**：有限可用

**触发条件**（已确认）：
1. 用户执行 `/clear` 命令
2. 用户登出
3. 会话因其他原因终止

**测试结果**：
- ❌ query() 自然结束时未触发
- ❌ 等待超时后未触发
- ✅ 需要显式的会话终止操作

**对 EvolClaw 的影响**：
- ⚠️ 在飞书/ACP 消息驱动场景中不适用（会话长期运行）
- ⚠️ 不能依赖作为同步触发点
- 💡 建议：忽略 SessionEnd Hook，不纳入设计

## 核心结论

### ✅ 设计方案可行

**PostToolUse Hook + JSONL 文件** 的组合完全可以支持 EvolClaw 的混合存储设计：

1. **实时同步**：PostToolUse Hook 在每次工具使用后触发，可以实现接近实时的同步
2. **文件访问**：Hook 提供 `transcript_path`，可以直接读取 JSONL 文件
3. **增量同步**：JSONL 格式支持按行解析，可以实现增量同步
4. **Agent 友好**：JSONL 文件格式清晰，Agent 可以直接访问

### 调整建议

1. **主要依赖 PostToolUse Hook**
   - 作为主要的同步触发点
   - 每次工具使用后增量同步

2. **PreCompact Hook 作为兜底**
   - 如果触发，执行全量同步
   - 确保数据一致性

3. **SessionEnd Hook 可选**
   - 如果可靠，作为最终同步点
   - 如果不可靠，可以忽略

4. **增加定期同步**
   - 每 N 分钟执行一次全量同步
   - 防止 Hook 失效导致的数据丢失

## 实施建议

### 同步策略

```typescript
class MessageSync {
  private lastSyncedLine: Map<string, number> = new Map();
  private lastFullSyncTime: Map<string, number> = new Map();

  // PostToolUse Hook 触发 - 主要同步机制（实时）
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

### 数据库 Schema

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  uuid TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  content TEXT,
  timestamp TEXT NOT NULL,
  line_number INTEGER NOT NULL
);

CREATE INDEX idx_session_id ON messages(session_id);
CREATE INDEX idx_timestamp ON messages(timestamp);
```

## 下一步行动

1. ✅ **核心验证完成**：PostToolUse Hook 和 JSONL 文件完全可用
2. ✅ **Hook 触发条件已确认**：PreCompact 和 SessionEnd 需要特定条件
3. 📋 **开始实施**：可以按照调整后的设计方案开始开发
4. 💡 **设计调整**：使用定期全量同步替代 PreCompact Hook

## 风险评估更新

| 风险 | 原评级 | 新评级 | 说明 |
|------|--------|--------|------|
| SDK Hook 机制 | 高 | 低 | PostToolUse Hook 完全可用 |
| JSONL 文件格式 | 中 | 低 | 格式清晰，易于解析 |
| 代码量估算 | 中 | 中 | 保持不变 |
| ACP 集成 | 中 | 中 | 保持不变 |

## 总体可行性评分

**从 7/10 提升到 9/10**

核心技术风险已消除，设计方案完全可行。剩余风险主要在实施细节和 ACP 集成复杂度。
