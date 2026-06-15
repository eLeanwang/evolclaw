# 会话数按 Agent 筛选修复

## 问题描述

之前切换智能体时：
- ✅ Token 统计数据正确变化
- ✅ 消息数（收到/发出）正确变化
- ❌ **会话数不变化**（始终显示全部）

## 根本原因

### 数据架构

1. **CC 会话文件**（Claude Code transcripts）
   - 存储路径：`~/.claude/projects/<项目路径>/<sessionId>.jsonl`
   - 按**项目**组织，不包含 agent_aid 字段
   - 文件名就是 sessionId（UUID）

2. **AUN 会话**（Agent User Network sessions）
   - 存储路径：`~/.evolclaw/data/sessions/aun/<agent_aid>/<peer_id>/`
   - 按**agent**组织
   - `active.json` 中包含 `agentSessionId` 字段，链接到 CC 会话

3. **绑定关系**
   ```
   AUN Session (active.json)
   ├── selfAID: "1lwj.agentid.pub"        ← Agent 标识
   ├── channelId: "peer.agentid.pub"      ← Peer 标识
   └── agentSessionId: "uuid-xxx-xxx"     ← 链接到 CC 会话文件名
   ```

### 之前的实现

会话数统计直接扫描所有 CC 会话文件，**没有使用绑定映射**：
```typescript
// 错误：统计所有 CC 会话
for (const sessionFile of sessionFiles) {
  if (within_time_range) sessionCount++;
}
```

## 解决方案

### 1. 导出 `buildBindMap()` 函数（session.ts）

将私有函数改为导出：
```typescript
export function buildBindMap(): Map<string, BindInfo>
```

该函数扫描所有 AUN 会话目录，构建 `agentSessionId → agent_aid` 的映射。

### 2. 使用 bindMap 筛选会话（server.ts）

```typescript
// 1. 构建映射
const bindMap = buildBindMap();

// 2. 遍历 CC 会话文件
for (const sessionFile of sessionFiles) {
  const sessionId = sessionFile.replace('.jsonl', '');
  
  // 3. 如果指定了 agent，检查该会话是否属于该 agent
  if (params.agent_aid) {
    const bindInfo = bindMap.get(sessionId);
    if (!bindInfo || bindInfo.selfAID !== params.agent_aid) continue;
  }
  
  // 4. 时间范围筛选（保持不变）
  if (within_time_range) sessionCount++;
}
```

## 修改的文件

1. **`src/sources/session.ts`**
   - 将 `buildBindMap()` 从私有函数改为导出函数
   - 新增导出：`export function buildBindMap()`

2. **`src/server.ts`**
   - 导入 `buildBindMap`
   - 修改 `/api/stats/overview` 的会话统计逻辑
   - 添加按 agent_aid 筛选逻辑

## 数据流

```
用户选择 Agent
    ↓
前端调用：/api/stats/overview?agent=xxx&from=xxx&to=xxx
    ↓
后端处理：
  1. 调用 buildBindMap() 构建 sessionId → agent 映射
  2. 扫描所有 CC 会话文件
  3. 对每个会话，检查是否属于指定 agent
  4. 应用时间范围筛选
  5. 返回筛选后的会话数
    ↓
前端显示：会话数正确反映所选 agent 的数据
```

## 筛选逻辑总结

现在所有数据都按 agent 正确筛选：

| 数据类型 | 数据源 | 筛选方式 |
|---------|--------|---------|
| Token 统计 | usage.db | SQL WHERE agent_aid = ? |
| 费用统计 | usage.db | SQL WHERE agent_aid = ? |
| 会话数 | CC 会话文件 | bindMap 映射筛选 |
| 消息数 | AUN 消息文件 | 目录结构筛选 |

## 性能考虑

- `buildBindMap()` 需要扫描所有 AUN 会话目录
- 建议后续优化：缓存 bindMap，只在需要时重建
- 当前实现：每次调用 `/api/stats/overview` 都会重建，但对于监控面板的使用场景可以接受

## 测试验证

切换 agent 时，所有卡片数据都应该变化：
- ✅ 会话数：只统计该 agent 的会话
- ✅ 消息数：只统计该 agent 的消息
- ✅ Token 统计：只统计该 agent 的 token
- ✅ 费用统计：只统计该 agent 的费用
