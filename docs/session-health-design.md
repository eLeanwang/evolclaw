# 会话健康监控与自动修复机制设计

## 设计目标

解决长上下文导致的 SDK 异常问题，通过异常监控和自动降级机制，提供自愈能力，避免硬超时影响正常长任务执行。

## 核心机制

### 1. 会话健康状态

每个会话维护独立的健康状态：

```typescript
interface SessionHealth {
  sessionId: string;
  consecutiveErrors: number;  // 连续错误次数
  lastError?: string;         // 最后一次错误信息
  lastErrorType?: ErrorType;  // 错误类型
  safeMode: boolean;          // 是否在安全模式
  lastSuccessTime: number;    // 最后成功时间戳
}

enum ErrorType {
  SDK_TIMEOUT = 'sdk_timeout',      // SDK 超时
  API_ERROR = 'api_error',          // API 5xx 错误
  FILE_CORRUPT = 'file_corrupt',    // 会话文件损坏
  STREAM_ERROR = 'stream_error',    // 流处理错误
  UNKNOWN = 'unknown'
}
```

### 2. 异常检测与计数

**触发条件：**
- SDK 查询超时（120秒）
- API 返回 5xx 错误
- 会话文件读取失败
- 流处理异常中断

**计数规则：**
- 每次异常：`consecutiveErrors += 1`
- 成功响应：`consecutiveErrors = 0`（重置）
- 达到阈值：自动进入安全模式

**阈值设置：**
- 连续 2 次异常 → 警告提示
- 连续 3 次异常 → 自动进入安全模式

### 3. 安全模式

**触发方式：**
1. 自动触发：连续 3 次异常
2. 手动触发：用户执行 `/safe` 命令

**行为变化：**
- ❌ 禁用 `resume` 参数（不加载会话历史）
- ✅ 所有工具功能正常（读写文件、执行命令等）
- ✅ 历史数据保留在 `.claude/` 目录
- ⚠️ 每次对话独立，无上下文记忆

**用户提示：**
```
⚠️ 安全模式已启用（连续 3 次异常）

当前限制：
- 无法记住之前的对话
- 每次提问需要提供完整上下文

建议操作：
1. /repair - 检查并修复会话（推荐，保留历史）
2. /new [名称] - 创建新会话（清空历史）
3. /status - 查看详细状态
```

### 4. 退出安全模式

| 命令 | 退出方式 | 历史上下文 | session_id | 适用场景 |
|------|---------|-----------|-----------|---------|
| `/repair` | ✅ 修复当前会话 | 保留（如果文件完好） | 不变 | 想保留历史 |
| `/new` | ✅ 创建新会话 | 清空（新会话） | 改变 | 想重新开始 |

**状态转换：**
```
正常模式
  ↓ (连续3次异常)
安全模式
  ↓
  ├─ /repair ──→ 正常模式 (同一会话，历史保留)
  └─ /new ─────→ 正常模式 (新会话，历史清空)
```

## 新增命令

### `/repair` - 修复会话

**功能：**
1. 备份当前 `.claude/` 目录
2. 检查 JSONL 会话文件健康度
3. 根据问题类型自动修复
4. 重置异常计数器
5. 退出安全模式

**检查项：**
- 文件是否存在
- 文件大小（>50MB 警告）
- JSON 格式完整性
- 文件可读性

**修复策略：**
- 无问题：仅重置计数器，退出安全模式
- 文件损坏：删除损坏文件，清空 `claude_session_id`，创建新会话
- 文件过大：提示用户使用 `/new`，不自动删除

**响应示例：**
```
✓ 修复完成，已退出安全模式

修复内容：
- 未发现问题
- 已重置异常计数器
- 已恢复正常会话模式

现在可以正常使用历史上下文了。
```

### `/safe` - 手动进入安全模式

**功能：**
手动触发安全模式，用于用户主动隔离问题。

**响应示例：**
```
✓ 已进入安全模式

当前行为：
- 暂时不加载会话历史（每次对话独立）
- 所有功能正常可用（读写文件、执行命令等）
- 不会丢失历史数据（仍保存在 .claude/ 目录）

退出安全模式：
- 使用 /repair 检查并修复会话
- 使用 /new 创建全新会话
```

### `/status` - 增强显示

**新增内容：**
- 异常计数器状态
- 安全模式状态
- 最后成功时间
- 退出安全模式的操作指引

**响应示例：**
```
会话状态：
- 会话 ID: feishu-oc_xxx-1773254120159
- 会话名称: CLI开发
- 项目路径: /home/evolclaw
- 异常计数: 0
- 安全模式: 否 ✓
- 最后成功: 2分钟前
- Claude 会话: 52ebbf0d-e952-4623-9632-d4f97063e4b4
```

或（安全模式下）：
```
会话状态：
- 会话 ID: feishu-oc_xxx-1773254120159
- 会话名称: CLI开发
- 项目路径: /home/evolclaw
- 异常计数: 3
- 安全模式: 是 ⚠️
- 最后成功: 10分钟前
- 最后错误: SDK 超时

⚠️ 当前处于安全模式（历史上下文已禁用）

退出方式：
1. /repair - 检查并修复会话（推荐，保留历史）
2. /new [名称] - 创建新会话（清空历史）
```

## 数据库变更

### 新增表：`session_health`

```sql
CREATE TABLE session_health (
  session_id TEXT PRIMARY KEY,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_type TEXT,
  safe_mode INTEGER NOT NULL DEFAULT 0,  -- 0=false, 1=true
  last_success_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_health_safe_mode ON session_health(safe_mode);
```

**字段说明：**
- `consecutive_errors`: 连续错误次数
- `last_error`: 最后一次错误信息（用于调试）
- `last_error_type`: 错误类型枚举
- `safe_mode`: 是否在安全模式（0/1）
- `last_success_time`: 最后成功时间戳

## 实现要点

### 1. 异常捕获位置

**在 `message-processor.ts` 中：**
```typescript
try {
  await this._processMessageInternal(message);
  // 成功 → 重置计数器
  await sessionManager.recordSuccess(sessionId);
} catch (error) {
  // 失败 → 记录异常
  const errorType = classifyError(error);
  await sessionManager.recordError(sessionId, errorType, error.message);

  // 检查是否需要进入安全模式
  const health = await sessionManager.getHealthStatus(sessionId);
  if (health.consecutiveErrors >= 3 && !health.safeMode) {
    await sessionManager.setSafeMode(sessionId, true);
    // 发送安全模式提示
  }
}
```

### 2. 安全模式下的查询

**在 `agent-runner.ts` 中：**
```typescript
async runQuery(sessionId, prompt, projectPath, initialClaudeSessionId, ...) {
  const health = await sessionManager.getHealthStatus(sessionId);

  let claudeSessionId = initialClaudeSessionId;

  if (health.safeMode) {
    // 安全模式：不使用 resume
    claudeSessionId = undefined;
    logger.warn(`[AgentRunner] Safe mode enabled for ${sessionId}, not resuming session`);
  }

  // 正常的 SDK 调用
  queryStream = createQuery(prompt, claudeSessionId);
  // ...
}
```

### 3. 错误分类

```typescript
function classifyError(error: any): ErrorType {
  const msg = error.message || '';

  if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
    return ErrorType.SDK_TIMEOUT;
  }
  if (msg.includes('5') && msg.includes('0')) { // 5xx
    return ErrorType.API_ERROR;
  }
  if (msg.includes('ENOENT') || msg.includes('corrupt')) {
    return ErrorType.FILE_CORRUPT;
  }
  if (msg.includes('stream') || msg.includes('aborted')) {
    return ErrorType.STREAM_ERROR;
  }
  return ErrorType.UNKNOWN;
}
```

### 4. 会话文件健康检查

```typescript
async checkSessionFileHealth(projectPath: string, claudeSessionId: string) {
  const issues: string[] = [];
  const sessionFile = path.join(projectPath, '.claude', `${claudeSessionId}.jsonl`);

  // 检查文件是否存在
  if (!await fileExists(sessionFile)) {
    return { healthy: true, issues: [] }; // 新会话，没有文件是正常的
  }

  // 检查文件大小
  const stats = await fs.stat(sessionFile);
  if (stats.size > 50 * 1024 * 1024) {
    issues.push(`会话文件过大: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
  }

  // 检查 JSON 格式
  try {
    const content = await fs.readFile(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      JSON.parse(line); // 验证每行都是合法 JSON
    }
  } catch (e) {
    issues.push('会话文件格式损坏');
    return { healthy: false, issues, corrupt: true };
  }

  return {
    healthy: issues.length === 0,
    issues,
    fileSize: stats.size
  };
}
```

## 超时时间调整

**移除硬超时限制：**
- 当前 40 秒超时 → 改为 120 秒（仅用于检测卡死）
- 120 秒超时触发时：
  1. 中断 SDK 子进程
  2. 记录为 `SDK_TIMEOUT` 错误
  3. 增加异常计数器
  4. 不向用户发送超时错误（由异常机制处理）

**理由：**
- 长任务（大文件读取、复杂分析）可能需要超过 40 秒
- 120 秒足以检测真正的卡死情况
- 异常计数器会自动处理重复超时问题

## 用户体验优化

### 1. 异常警告（2次异常时）

```
⚠️ 检测到会话异常（2次）

如果问题持续，系统将自动进入安全模式。

建议：
- 使用 /status 查看会话状态
- 使用 /repair 检查会话健康度
```

### 2. 安全模式提示（每次响应后）

```
[正常响应内容]

💡 当前处于安全模式（无历史上下文）。使用 /repair 修复会话或 /new 创建新会话。
```

### 3. 修复成功提示

```
✓ 修复完成，已退出安全模式

修复内容：
- 未发现问题
- 已重置异常计数器
- 已恢复正常会话模式

现在可以正常使用历史上下文了。
```

## 实施步骤

1. **数据库迁移**
   - 创建 `session_health` 表
   - 为现有会话初始化健康状态

2. **SessionManager 扩展**
   - 添加健康状态管理方法
   - 实现异常记录和计数逻辑

3. **MessageProcessor 集成**
   - 添加异常捕获和分类
   - 实现自动安全模式触发

4. **AgentRunner 修改**
   - 添加安全模式检查
   - 禁用 resume 逻辑

5. **命令实现**
   - `/repair` - 会话修复
   - `/safe` - 手动安全模式
   - `/status` - 增强显示

6. **测试验证**
   - 模拟连续异常触发
   - 验证安全模式行为
   - 测试修复流程

## 预期效果

1. **自动检测** - 无需用户手动判断会话是否异常
2. **自动降级** - 异常时自动进入安全模式，保证系统可用
3. **明确指引** - 清晰的修复路径和操作提示
4. **数据安全** - 修复前自动备份，不丢失历史
5. **用户可控** - 提供手动触发和修复工具

## 未来优化方向

1. **智能压缩** - 检测到文件过大时，自动触发 SDK 压缩
2. **异常分析** - 统计异常模式，识别根本原因
3. **预防性检查** - 定期检查会话健康度，提前预警
4. **自动清理** - 定期清理过期会话文件

---

**文档版本**: v1.0
**创建日期**: 2026-03-15
**作者**: EvolClaw Team
