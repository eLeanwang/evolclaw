# channelKey 和 "main" 的真相

## 核心发现

`toleiliang5.agentid.pub#aun#main` 这个字符串**不是**旧版本遗留数据，而是**当前版本的标准格式**！

## channelKey 格式

**定义位置**：`channel-loader.ts:227-229`

```typescript
export function formatChannelKey(k: ChannelKey): string {
  return `${k.aid}${SEP}${k.type}${SEP}${k.name}`;
}
```

**格式**：`{aid}#{type}#{name}`

**示例**：
- `toleiliang5.agentid.pub#aun#main`
- `alice.aid.pub#feishu#feishu-1`
- `bob.aid.pub#wechat#wechat`

## "main" 的来源

**代码位置**：`evolagent.ts:100-107`

```typescript
channelInstanceNames(): string[] {
  // AUN channel 隐式存在（从 agent.aid 派生），不需要在 channels[] 里声明
  const aunKey = this.effectiveChannelName('aun', 'main');  // ← 硬编码 'main'
  const others = this.merged.channels
    .filter(c => c.type !== 'aun')
    .map(c => this.effectiveChannelName(c.type, c.name));
  return [aunKey, ...others];
}
```

**关键点**：
- AUN channel 是**隐式存在**的，不需要在 `config.json` 的 `channels[]` 中声明
- 每个 agent 自动拥有一个 AUN channel，name 固定为 `"main"`
- 其他类型的 channel（feishu, wechat 等）需要显式声明

## channelKey 的用途

### 1. 内存索引

**位置**：`evolagent-registry.ts:100-101`

```typescript
/** channel key (`<aid>#<type>#<name>`) → agent aid */
private channelIndex: Map<string, string> = new Map();
```

**用途**：
- 从 channelKey 快速查找对应的 agent
- `agentRegistry.resolveByChannel(channelKey)` 返回 agent

### 2. Session 的 channel 字段

**位置**：`active.json`

```json
{
  "channel": "toleiliang5.agentid.pub#aun#main",
  "channelType": "toleiliang5.agentid.pub#aun#main",
  "channelId": "llagent2.agentid.pub"
}
```

**问题**：
- `channel` 字段存储的是 channelKey（正确）
- `channelType` 字段也存储了 channelKey（**错误**！应该只是 `"aun"`）

### 3. CLI 命令

**位置**：`agent.ts:925`

```typescript
return {
  ok: true,
  aid: opts.aid,
  channelKey: `${opts.aid}#${opts.channel.type}#${opts.channel.name}`,
  reloaded,
};
```

**用途**：`evolclaw agent channel` 命令返回 channelKey

### 4. 孤儿 Session 检测

**位置**：`cli/index.ts:888-889`

```typescript
// effective key: <aid>#<type>#<name>
configChannelNames.add(`${cfg.aid}#${inst.type}#${inst.name}`);
```

**用途**：检测 session 是否属于已配置的 channel

## channelKey vs channelName vs channelType

| 概念 | 格式 | 示例 | 用途 |
|------|------|------|------|
| **channelKey** | `{aid}#{type}#{name}` | `alice.aid.pub#aun#main` | 全局唯一标识符，跨 agent 索引 |
| **channelName** | `{name}` 或 `{type}-{n}` | `main`, `aun`, `feishu-1` | ChannelAdapter 的 name 字段 |
| **channelType** | `{type}` | `aun`, `feishu`, `wechat` | 文件系统路径、Plugin 选择 |

### 关系图

```
channelKey (全局唯一)
  ↓ 解析
┌─────────────────────────────────────┐
│ aid: alice.aid.pub                  │
│ type: aun                           │ ← channelType（文件系统路径）
│ name: main                          │ ← channelName（adapter 标识）
└─────────────────────────────────────┘
```

## AUN Channel 的特殊性

### 1. 隐式存在

**其他 channel**（需要显式声明）：
```json
{
  "channels": [
    {
      "type": "feishu",
      "name": "feishu-bot1",
      "appId": "xxx",
      "appSecret": "yyy"
    }
  ]
}
```

**AUN channel**（自动存在）：
```json
{
  "aid": "alice.aid.pub",
  "channels": []  // ← 不需要声明 AUN，自动拥有
}
```

### 2. 固定 name = "main"

- 每个 agent 只有一个 AUN channel
- name 固定为 `"main"`，不可配置
- channelKey 格式：`{aid}#aun#main`

### 3. Owner/Admin 存储位置不同

**其他 channel**：
```json
{
  "channels": [
    {
      "type": "feishu",
      "name": "feishu-1",
      "owners": ["user123"],
      "admins": ["user456"]
    }
  ]
}
```

**AUN channel**：
```json
{
  "aid": "alice.aid.pub",
  "owners": ["bob.aid.pub"],    // ← AUN channel 的 owner
  "admins": ["charlie.aid.pub"] // ← AUN channel 的 admin
}
```

**代码位置**：`evolagent.ts:131-142`

```typescript
private isAunChannelKey(channelKey: string): boolean {
  const parsed = tryParseChannelKey(channelKey);
  return parsed?.type === 'aun' && parsed.aid === this.aid;
}

getOwner(channelKey: string): string | undefined {
  if (this.isAunChannelKey(channelKey)) {
    return this.merged.owners?.[0];  // ← 从顶层 owners 读取
  }
  const inst = this.findChannelInstance(channelKey);
  return inst?.owners?.[0];  // ← 从 channel 实例读取
}
```

## Session 目录结构的问题

### 当前实际情况

```
~/.evolclaw/data/sessions/
├── aun/                                      ← channelType（正确）
│   ├── alice.aid.pub/
│   └── bob.aid.pub/
└── toleiliang5.agentid.pub#aun#main/         ← channelKey（错误！）
    └── llagent2.agentid.pub/
        └── active.json
```

### active.json 的问题

```json
{
  "channel": "toleiliang5.agentid.pub#aun#main",      // ← channelKey（正确）
  "channelType": "toleiliang5.agentid.pub#aun#main",  // ← 应该是 "aun"（错误！）
  "channelId": "llagent2.agentid.pub"
}
```

### 根本原因

**代码位置**：`session-fs-store.ts:59-65`

```typescript
export function chatDirPath(sessionsDir: string, channelType: string, channelId: string, selfId?: string | null): string {
  if (channelType === 'aun') {
    const self = selfId || '_unknown';
    return path.join(sessionsDir, 'aun', encodeSegment(self), encodeSegment(channelId));
  }
  return path.join(sessionsDir, channelType, encodeSegment(channelId));
}
```

**问题**：
- 函数期望 `channelType` 参数是纯类型（如 `"aun"`）
- 但某些调用方传入了 `channelKey`（如 `"alice.aid.pub#aun#main"`）
- 导致目录名变成了 channelKey

### 正确的目录结构应该是

```
~/.evolclaw/data/sessions/
└── aun/                           ← channelType
    ├── alice.aid.pub/             ← selfId
    │   ├── bob.aid.pub/           ← channelId
    │   └── charlie.aid.pub/
    └── toleiliang5.agentid.pub/   ← selfId
        └── llagent2.agentid.pub/  ← channelId
```

## 数据流分析

### 正确的流程

```
1. Agent 配置
   aid: "alice.aid.pub"
   ↓
2. EvolAgent.channelInstanceNames()
   生成 channelKey: "alice.aid.pub#aun#main"
   ↓
3. EvolAgentRegistry.buildChannelIndex()
   channelIndex.set("alice.aid.pub#aun#main", "alice.aid.pub")
   ↓
4. MessageProcessor 收到消息
   channelKey = "alice.aid.pub#aun#main"
   ↓
5. SessionManager.getOrCreateSession()
   参数：
   - channel: "alice.aid.pub#aun#main" (channelKey)
   - channelType: "aun" (应该传入)
   - selfId: "alice.aid.pub" (应该传入)
   ↓
6. chatDirPath()
   返回：sessions/aun/alice.aid.pub/bob.aid.pub/
```

### 错误的流程（导致问题）

```
5. SessionManager.getOrCreateSession()
   参数：
   - channel: "alice.aid.pub#aun#main" (channelKey)
   - channelType: 未传入或传入了 channelKey
   - selfId: 未传入
   ↓
6. resolveChatDir() fallback
   把 channel 当成 channelType 使用
   ↓
7. chatDirPath()
   channelType = "alice.aid.pub#aun#main" (错误！)
   返回：sessions/alice.aid.pub#aun#main/bob.aid.pub/
```

## 修复建议

### 1. 确保 channelType 和 selfId 正确传递

在调用 `SessionManager.getOrCreateSession()` 时，应该：
- 解析 channelKey 得到 `{ aid, type, name }`
- 传入 `channelType = type`（如 `"aun"`）
- 传入 `selfId = aid`（如 `"alice.aid.pub"`）

### 2. 迁移旧数据

将 `toleiliang5.agentid.pub#aun#main/` 目录下的数据迁移到正确的位置：
```bash
# 从
~/.evolclaw/data/sessions/toleiliang5.agentid.pub#aun#main/llagent2.agentid.pub/

# 迁移到
~/.evolclaw/data/sessions/aun/toleiliang5.agentid.pub/llagent2.agentid.pub/
```

### 3. 修正 active.json

```json
{
  "channel": "toleiliang5.agentid.pub#aun#main",  // ← 保持不变（channelKey）
  "channelType": "aun",                           // ← 修正为纯类型
  "channelId": "llagent2.agentid.pub"
}
```

## 总结

1. **channelKey** 是全局唯一标识符，格式为 `{aid}#{type}#{name}`
2. **"main"** 是 AUN channel 的固定 name，硬编码在 `EvolAgent.channelInstanceNames()` 中
3. **AUN channel 是隐式的**，每个 agent 自动拥有，不需要在配置中声明
4. **目录结构问题**：某些地方错误地把 channelKey 当成 channelType 使用，导致目录名错误
5. **修复方向**：确保 channelType 和 selfId 正确传递，迁移旧数据到正确位置

## 日期

2026-05-24
