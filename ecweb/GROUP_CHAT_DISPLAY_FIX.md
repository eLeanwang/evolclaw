# 群聊显示修复总结

## 问题描述

群聊"爸爸真的好帅"（成员：你好123你、墨渊、蜡笔大心）显示问题：
1. ❌ 显示成员列表而不是群昵称
2. ❌ 会话数可能不正确
3. ❌ 消息数可能不正确

## 已修复的问题

### 1. 群昵称显示错误

**问题根源：**
`getPeerInfo` 函数错误地使用了 `metadata.groupName`（成员列表）作为显示名称，而不是 `name`（群昵称）。

**active.json 的实际结构：**
```json
{
  "name": "爸爸真的好帅",              // 群昵称 ✅ 应该显示这个
  "metadata": {
    "groupName": "你好123你、墨渊、蜡笔大心"  // 成员列表 ❌ 不应该显示这个
  }
}
```

**修复方案（stats.ts）：**
```typescript
// 修复前
const groupName = activeData.metadata?.groupName || null;
return { name: groupName, chatType: 'group', memberCount };

// 修复后
const displayName = activeData.name || activeData.metadata?.groupName || null;
const groupName = activeData.metadata?.groupName || null;
// 计算人数仍然使用 groupName（成员列表）
return { name: displayName, chatType: 'group', memberCount };
```

**修复逻辑：**
- 优先使用 `active.json` 的 `name` 字段（群昵称）
- 如果没有 `name`，fallback 到 `metadata.groupName`（成员列表）
- 人数计算仍然基于 `metadata.groupName` 的成员数

## 会话数和消息数统计

### 数据验证

**群聊 11722 的数据：**
- ✅ AUN 会话存在：`~/.evolclaw/data/sessions/aun/1lwj.agentid.pub/group.agentid.pub%2F11722/`
- ✅ active.json 存在，包含正确的群信息
- ✅ messages.jsonl 存在，包含 85 条消息
- ✅ CC 会话文件存在：`9581f531-c346-4ce6-97b7-785c0c22fbfe.jsonl`
- ✅ agentSessionId 绑定正确

### 统计逻辑

**会话数统计：**
```typescript
// server.ts - 使用 bindMap 筛选
const bindMap = buildBindMap();
const bindInfo = bindMap.get(sessionId);

// 检查 agent
if (params.agent_aid && bindInfo.selfAID !== params.agent_aid) continue;

// 检查 peer (支持群聊)
if (targetChannelId && bindInfo.channelId !== targetChannelId) continue;
```

**消息数统计：**
```typescript
// server.ts - 扫描 AUN 目录
const aids = params.agent_aid ? [params.agent_aid] : listLocalAids(aunDir);
for (const aid of aids) {
  const peers = params.peer_key ? [params.peer_key] : listPeers(aunDir, aid);
  for (const peer of peers) {
    for (const m of readMessages(aunDir, aid, peer)) {
      // 时间筛选 + 计数
    }
  }
}
```

## 可能的剩余问题

### 1. peer_key 格式匹配

**URL 编码问题：**
- 数据库 peer_key: `aun#1lwj.agentid.pub#main#group.agentid.pub%2F11722`
- bindInfo.channelId: `group.agentid.pub/11722` (解码后)

**提取逻辑（server.ts）：**
```typescript
const parts = params.peer_key.split('#');
const targetChannelId = parts[3]; // "group.agentid.pub%2F11722" (可能带编码)
```

**潜在问题：**
如果 `targetChannelId` 保留了 URL 编码（`%2F`），而 `bindInfo.channelId` 是解码后的（`/`），匹配会失败。

**解决方案：**
需要在比较前先解码：
```typescript
if (targetChannelId) {
  const decodedTarget = decodeURIComponent(targetChannelId);
  if (bindInfo.channelId !== decodedTarget) continue;
}
```

### 2. 消息数统计的 peer 参数

**当前 server.ts 逻辑：**
```typescript
const aids = params.agent_aid ? [params.agent_aid] : listLocalAids(aunDir);
for (const aid of aids) {
  const peers = params.peer_key ? [params.peer_key] : listPeers(aunDir, aid);
  // ...
}
```

**问题：**
`listPeers` 可能需要的是 `channelId` 而不是完整的 `peer_key`。

## 下一步调试建议

1. **检查 bindMap**
   - 启动服务器后访问 Explorer
   - 在浏览器控制台查看 `/api/stats/overview?agent=1lwj.agentid.pub` 的响应
   - 确认会话数是否包含群聊

2. **检查 peer_key 匹配**
   - 在 server.ts 中添加 console.log
   - 输出 `targetChannelId` 和 `bindInfo.channelId` 的值
   - 确认它们格式是否一致

3. **检查消息统计**
   - 查看 `/api/stats/overview?agent=1lwj.agentid.pub&peer=aun#...#11722` 的响应
   - 确认消息数是否正确

## 修改的文件

- `src/sources/stats.ts` - 修复群昵称显示逻辑
