# 记忆与压缩机制设计

> **状态**: 草稿  
> **创建时间**: 2026-07-03  
> **相关**: [dual-session-lite/REVIEW-SUPPLEMENT.md P1-5](dual-session-lite/REVIEW-SUPPLEMENT.md#p1-5)

---

## 一、概述

当前会话压缩机制只是调用 SDK 的 `/compact` 和 `/clear`，没有生成会话总结和关键事实。本文档设计一套完整的记忆与压缩机制，支持会话总结、关键事实提取、持久化存储和记忆搜索。

---

## 二、当前压缩机制

### 2.1 触发条件

- 上下文过长（`ErrorType.CONTEXT_TOO_LONG`）
- 硬编码阈值：180k tokens

### 2.2 压缩流程

```
1. 调用 agent.compact() → SDK /compact 命令
2. 压缩成功 → 继续处理
3. 压缩失败 → 调用 agent.clearSession() → SDK /clear 命令
4. 重新开始新会话
```

### 2.3 问题

- ❌ 压缩阈值不可配置
- ❌ 不产生会话总结
- ❌ 不提取关键事实
- ❌ 无法搜索历史记忆

---

## 三、设计目标

1. **可配置的压缩阈值**：高/中/低三档
2. **会话总结生成**：压缩前自动生成总结
3. **关键事实提取**：结构化记录重要信息
4. **持久化存储**：按时间组织，便于检索
5. **记忆搜索**：通过索引快速查找历史会话

---

## 四、压缩阈值配置

### 4.1 三档阈值

| 等级 | 阈值 | 适用场景 |
|------|------|---------|
| 低（aggressive） | 120k tokens | 频繁压缩，保持上下文精简 |
| 中（balanced） | 180k tokens | 默认，平衡性能和上下文长度 |
| 高（conservative） | 240k tokens | 最大化上下文保留 |

### 4.2 配置方式

```json
// evolclaw config
{
  "memory": {
    "compressionThreshold": "balanced"  // aggressive | balanced | conservative
  }
}
```

### 4.3 SDK 上下文窗口占用查询

**问题**：SDK 能否获取当前会话上下文窗口占用情况？

**调研**：
- Claude SDK 在每次 API 调用后返回 `usage` 信息
- 包含 `input_tokens`（当前上下文使用量）
- evolclaw 已在 `contextUsage` 中记录（`claude-runner.ts:1082-1089`）

**实现**：
- 每次调用后检查 `contextUsage.totalTokens`
- 达到阈值时触发主动压缩

---

## 五、会话总结生成

### 5.1 总结时机

**压缩前生成总结**：
```
1. 检测到上下文达到阈值
2. 暂停当前会话
3. 启动专门的总结会话（独立 session）
4. 生成总结后写入文件
5. 执行压缩（SDK /compact）
6. 继续处理
```

### 5.2 总结会话

**专门的总结 prompt**：
```
你是一个会话总结助手。请总结以下会话的内容：

【会话上下文】
{会话历史}

请按以下格式输出：

## 会话总结
（200字以内的总结）

## 关键事实
- 事实1：描述
- 事实2：描述
...

## 关键词
keyword1, keyword2, keyword3
```

### 5.3 总结内容结构

```markdown
---
sessionId: <agentSessionId>
startTime: <ISO 8601>
endTime: <ISO 8601>
baseagent: claude-code
messageCount: 42
keywords: ["bug修复", "数据库", "性能优化"]
---

## 会话总结
用户报告了一个数据库查询性能问题，经过调试发现是索引缺失导致。
添加索引后性能提升 10 倍，问题解决。

## 关键事实
- 问题：用户表查询耗时 2 秒
- 原因：缺少 email 字段索引
- 解决方案：添加 B-tree 索引
- 结果：查询耗时降至 200ms

## 相关文件
- `src/models/user.ts`
- `migrations/20260703_add_user_email_index.sql`

## 工具调用统计
- Read: 5 次
- Edit: 3 次
- Bash: 2 次
```

---

## 六、持久化存储

### 6.1 目录结构

```
$RELATIONS_DIR/<channel>#<peerId>/
├── profile.md
├── history.jsonl
└── memory/
    ├── index.json                    # 索引文件
    ├── 2026/
    │   ├── 01/
    │   │   ├── session_abc123.md     # 会话总结
    │   │   └── session_def456.md
    │   ├── 02/
    │   └── 03/
    └── 2027/
```

### 6.2 索引文件格式

```json
{
  "sessions": [
    {
      "sessionId": "abc123",
      "summary": "修复数据库查询性能问题",
      "startTime": "2026-01-15T10:00:00Z",
      "endTime": "2026-01-15T11:30:00Z",
      "messageCount": 42,
      "keywords": ["bug修复", "数据库", "性能优化"],
      "filePath": "memory/2026/01/session_abc123.md"
    },
    {
      "sessionId": "def456",
      "summary": "实现用户登录功能",
      "startTime": "2026-01-16T14:00:00Z",
      "endTime": "2026-01-16T16:00:00Z",
      "messageCount": 28,
      "keywords": ["功能开发", "认证", "JWT"],
      "filePath": "memory/2026/01/session_def456.md"
    }
  ],
  "lastUpdated": "2026-01-16T16:00:00Z"
}
```

---

## 七、记忆搜索

### 7.1 搜索接口

```typescript
interface MemorySearchQuery {
  keywords?: string[];       // 关键词匹配
  timeRange?: {             // 时间范围
    start: Date;
    end: Date;
  };
  summary?: string;         // 总结文本搜索（模糊匹配）
}

interface MemorySearchResult {
  sessionId: string;
  summary: string;
  startTime: Date;
  endTime: Date;
  keywords: string[];
  filePath: string;
  relevanceScore: number;   // 相关性评分
}
```

### 7.2 搜索流程

```
1. 加载索引文件（index.json）
2. 按查询条件过滤：
   - 关键词匹配（交集）
   - 时间范围过滤
   - 总结文本模糊匹配
3. 计算相关性评分
4. 排序返回结果
5. 可选：读取完整的会话总结文件
```

### 7.3 使用场景

**用户查询历史**：
```
用户：我之前修复过一个数据库性能问题，在哪？
→ 搜索关键词：["数据库", "性能"]
→ 返回：session_abc123.md
→ 读取总结，告诉用户
```

---

## 八、实现优先级

### Phase 1（双会话模式实现时）
- ✅ 保持当前压缩机制不变
- ✅ 主会话和辅助会话都使用 SDK /compact

### Phase 2（后续独立设计）
- [ ] 可配置压缩阈值
- [ ] 会话总结生成
- [ ] 持久化存储
- [ ] 索引文件维护

### Phase 3（进一步增强）
- [ ] 记忆搜索功能
- [ ] 关键事实提取优化
- [ ] 跨会话关联分析

---

## 九、待完善

- [ ] SDK 上下文占用查询的具体 API
- [ ] 总结会话的 prompt 优化
- [ ] 索引文件的更新策略（增量 vs 全量）
- [ ] 搜索算法的相关性评分细节
- [ ] 会话总结文件的命名规则
- [ ] 压缩失败时的总结保存策略

---

**下一步**：
1. 完成双会话模式实现（使用当前压缩机制）
2. 单独设计并实现记忆与压缩增强功能
