# peerKey 和 channelKey 概念对比分析

## 你提出的设计

### peerKey
**格式**：`<channelType>#<urlEncode(对端peerId)>`

**用途**：关系层，存放指定对端的数据

**示例**：
- `aun#alice.aid.pub`
- `feishu#ou_xxx`
- `aun#group-id.group.example.com` （群组）

### channelKey
**格式**：`<channelType>#<urlEncode(本端peerId)>#<channelName>`

**特殊规则**：AUN 渠道下，channelName 固定值是 `main`

**示例**：
- `aun#toleiliang5.agentid.pub#main`
- `feishu#cli_xxx#feishu-1`

---

## 当前实现

### peerKey（已实现，符合设计）

**代码位置**：`peer-identity.ts:52` 和 `message-processor.ts:593-595`

```typescript
// peer-identity.ts
const peerKey = `${channel}#${encodeURIComponent(peerId)}`;

// message-processor.ts
const peerKey = (currentChannelType && peerIdRaw)
  ? `${currentChannelType}#${encodeURIComponent(peerIdRaw)}`
  : undefined;
```

**实际格式**：`<channel>#<urlEncode(peerId)>`

**用途**：
- 关系层目录：`~/.evolclaw/agents/<aid>/relations/<peerKey>/`
- peer-identity.json 存储路径

**✅ 符合你的设计**

---

### channelKey（不符合设计）

**代码位置**：`channel-loader.ts:227-229`

```typescript
export function formatChannelKey(k: ChannelKey): string {
  return `${k.aid}${SEP}${k.type}${SEP}${k.name}`;
}
```

**当前格式**：`<aid>#<type>#<name>`

**示例**：
- `toleiliang5.agentid.pub#aun#main`
- `alice.aid.pub#feishu#feishu-1`

**用途**：
- Agent Registry 索引：`channelIndex.get(channelKey)` → agent
- Session 的 channel 字段
- CLI 命令返回值

**❌ 不符合你的设计**

---

## 差异对比

| 维度 | 你的设计 | 当前实现 | 差异 |
|------|---------|---------|------|
| **格式** | `<channelType>#<urlEncode(本端peerId)>#<channelName>` | `<aid>#<type>#<name>` | 顺序不同 |
| **第一段** | channelType | aid | 完全不同 |
| **第二段** | urlEncode(本端peerId) | type | 完全不同 |
| **第三段** | channelName | name | 相同 |
| **编码** | 需要 urlEncode | 不需要（aid 本身合法） | 不同 |

### 示例对比

**AUN channel**：
- 你的设计：`aun#toleiliang5.agentid.pub#main`
- 当前实现：`toleiliang5.agentid.pub#aun#main`

**Feishu channel**：
- 你的设计：`feishu#cli_xxx#feishu-1`
- 当前实现：`alice.aid.pub#feishu#feishu-1`

---

## 为什么当前实现使用 aid 开头？

### 1. 跨 agent 唯一性

当前实现中，channelKey 需要在**全局范围**内唯一标识一个 channel 实例：

```typescript
// evolagent-registry.ts
private channelIndex: Map<string, string> = new Map();  // channelKey → agent aid
```

**场景**：多个 agent 可能使用相同的 channelType + channelName

```json
// Agent A
{
  "aid": "alice.aid.pub",
  "channels": [{ "type": "feishu", "name": "feishu-1" }]
}

// Agent B
{
  "aid": "bob.aid.pub",
  "channels": [{ "type": "feishu", "name": "feishu-1" }]
}
```

**当前实现**：
- Agent A 的 channelKey：`alice.aid.pub#feishu#feishu-1`
- Agent B 的 channelKey：`bob.aid.pub#feishu#feishu-1`
- ✅ 全局唯一

**你的设计**：
- Agent A 的 channelKey：`feishu#cli_xxx#feishu-1`
- Agent B 的 channelKey：`feishu#cli_yyy#feishu-1`
- ✅ 也能唯一（如果 cli_xxx 和 cli_yyy 不同）

### 2. AUN channel 的特殊性

**当前实现**：
- AUN channel 是隐式的，从 agent.aid 派生
- channelKey：`<aid>#aun#main`
- 本端 peerId 就是 aid

**你的设计**：
- channelKey：`aun#<aid>#main`
- 本端 peerId 也是 aid
- ✅ 语义更清晰（channelType 在前）

---

## 可行性分析

### 改成你的设计是否可行？

**✅ 可行**，但需要考虑以下问题：

### 1. 本端 peerId 的定义

**AUN**：
- 本端 peerId = agent.aid ✅

**Feishu**：
- 本端 peerId = appId? 还是 bot_id?
- 需要明确定义

**Wechat**：
- 本端 peerId = appId? 还是其他?
- 需要明确定义

### 2. 唯一性保证

**你的设计依赖**：
- `<channelType>#<本端peerId>#<channelName>` 全局唯一
- 需要确保不同 agent 的同类型 channel 有不同的本端 peerId

**示例**：
```json
// Agent A - Feishu Bot 1
{
  "aid": "alice.aid.pub",
  "channels": [{
    "type": "feishu",
    "name": "feishu-1",
    "appId": "cli_xxx"  // ← 本端 peerId
  }]
}

// Agent B - Feishu Bot 2
{
  "aid": "bob.aid.pub",
  "channels": [{
    "type": "feishu",
    "name": "feishu-1",
    "appId": "cli_yyy"  // ← 不同的本端 peerId
  }]
}
```

**channelKey**：
- Agent A：`feishu#cli_xxx#feishu-1` ✅ 唯一
- Agent B：`feishu#cli_yyy#feishu-1` ✅ 唯一

### 3. 迁移成本

**需要修改的地方**：
1. `formatChannelKey()` 函数
2. `parseChannelKey()` 函数
3. `EvolAgent.effectiveChannelName()` 方法
4. 所有使用 channelKey 的地方
5. 迁移现有的 session 数据（active.json 中的 channel 字段）

---

## 你的设计的优势

### 1. 语义更清晰

```
aun#alice.aid.pub#main
↑   ↑                ↑
类型 本端标识         实例名
```

比当前的 `alice.aid.pub#aun#main` 更符合直觉

### 2. 与 peerKey 格式一致

```
peerKey:    aun#bob.aid.pub           (对端)
channelKey: aun#alice.aid.pub#main    (本端)
```

都以 channelType 开头，便于理解

### 3. 便于按 channelType 分组

```typescript
// 当前实现：需要解析才能按 type 分组
const channels = allChannelKeys.map(parseChannelKey).filter(k => k.type === 'aun');

// 你的设计：可以直接前缀匹配
const aunChannels = allChannelKeys.filter(k => k.startsWith('aun#'));
```

---

## 当前实现的优势

### 1. aid 在前，便于按 agent 分组

```typescript
// 查找某个 agent 的所有 channel
const agentChannels = allChannelKeys.filter(k => k.startsWith(`${aid}#`));
```

### 2. 不需要定义"本端 peerId"

- 直接使用 agent.aid，概念简单
- 不需要为每种 channelType 定义本端 peerId 的提取规则

---

## 建议

### 方案 A：采用你的设计（推荐）

**理由**：
1. 语义更清晰，channelType 在前
2. 与 peerKey 格式一致
3. 便于按类型分组

**需要做的**：
1. 为每种 channelType 定义本端 peerId 的提取规则
2. 修改 channelKey 格式化和解析函数
3. 迁移现有数据

**本端 peerId 定义**：
```typescript
function extractSelfPeerId(channelType: string, instance: ChannelInstance, agentAid: string): string {
  switch (channelType) {
    case 'aun':
      return agentAid;  // AUN 使用 agent.aid
    case 'feishu':
      return instance.appId;  // Feishu 使用 appId
    case 'wechat':
      return instance.appId;  // Wechat 使用 appId
    case 'dingtalk':
      return instance.appKey;  // Dingtalk 使用 appKey
    default:
      return agentAid;  // 默认使用 agent.aid
  }
}
```

### 方案 B：保持当前实现

**理由**：
1. 已经运行稳定
2. 迁移成本高
3. 功能上没有问题

**改进**：
- 在文档中明确说明 channelKey 和 peerKey 的区别
- 添加辅助函数便于按 type 分组

---

## 结论

**当前实现**：
- peerKey：✅ 符合你的设计
- channelKey：❌ 不符合你的设计（格式为 `<aid>#<type>#<name>`）

**可以改成你的设计吗**：
- ✅ 可以，但需要：
  1. 定义每种 channelType 的本端 peerId 提取规则
  2. 修改代码
  3. 迁移数据

**是否应该改**：
- 如果追求概念一致性和语义清晰：**建议改**
- 如果优先考虑稳定性和迁移成本：**可以不改**

我的建议是**采用你的设计**，因为它在概念上更清晰，与 peerKey 保持一致，长期来看更易维护。

## 日期

2026-05-24
