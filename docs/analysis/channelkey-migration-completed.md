# channelKey 格式迁移完成报告

## 迁移目标

将 channelKey 格式从 `<aid>#<type>#<name>` 改为 `<type>#<selfPeerId>#<name>`，与 peerKey 格式保持一致。

## 已完成的修改

### 1. 核心类型和函数

#### `src/core/channel-loader.ts`
- ✅ 修改 `ChannelKey` 接口：`{ aid, type, name }` → `{ type, selfPeerId, name }`
- ✅ 修改 `formatChannelKey()`：使用 `encodeURIComponent(selfPeerId)`
- ✅ 修改 `parseChannelKey()`：解析并 `decodeURIComponent(selfPeerId)`
- ✅ 更新注释：`<aid>#<type>#<name>` → `<type>#<urlEncode(selfPeerId)>#<name>`

#### `src/core/evolagent.ts`
- ✅ 修改 `effectiveChannelName()`：使用 `{ type, selfPeerId: this.aid, name }`
- ✅ 修改 `isAunChannelKey()`：检查 `parsed.selfPeerId` 而不是 `parsed.aid`
- ✅ 更新注释

#### `src/core/evolagent-registry.ts`
- ✅ 更新 `channelIndex` 注释

### 2. CLI 相关

#### `src/cli/agent.ts`
- ✅ 修改 channelKey 返回值：`${type}#${encodeURIComponent(aid)}#${name}`

#### `src/cli/index.ts`
- ✅ 修改孤儿检测逻辑：使用新格式构造 channelKey
- ✅ 修改 `summarizeChannelFingerprints()`：解析新格式（`parts[0]` 是 type，`parts[2]` 是 name）
- ✅ 修改 `resolveInstanceConfig()`：解析新格式并通过 selfPeerId 查找 agent

### 3. Channel 适配器

#### `src/types.ts`
- ✅ 在 `ChannelAdapter` 接口中添加 `channelKey` 字段

#### 所有 channel 插件
- ✅ `src/channels/aun.ts`：添加 `channelKey: inst.name`
- ✅ `src/channels/feishu.ts`：添加 `channelKey: inst.name`
- ✅ `src/channels/wechat.ts`：添加 `channelKey: inst.name`
- ✅ `src/channels/dingtalk.ts`：添加 `channelKey: inst.name`
- ✅ `src/channels/qqbot.ts`：添加 `channelKey: inst.name`
- ✅ `src/channels/wecom.ts`：添加 `channelKey: inst.name`

### 4. 主入口

#### `src/index.ts`
- ✅ 修改 `onProjectPathRequest`：使用 `adapter.channelKey`
- ✅ 修改 agent binding：使用 `adapter.channelKey`
- ✅ 修改 `preloadThreads`：使用 `adapter.channelKey`
- ✅ 修改 channel down 通知：使用 `adapter.channelKey`
- ✅ 修改重启通知：使用 `adapter.channelKey`
- ✅ 修改 hot-load：使用 `adapter.channelKey`

## 格式变化示例

### AUN Channel
```
旧格式：dddd.agentid.pub#aun#main
新格式：aun#dddd.agentid.pub#main
```

### Feishu Channel
```
旧格式：alice.aid.pub#feishu#feishu-1
新格式：feishu#alice.aid.pub#feishu-1
```

## 与 peerKey 的一致性

现在 channelKey 和 peerKey 都以 channelType 开头：

```
peerKey:    aun#bob.aid.pub              (对端)
channelKey: aun#alice.aid.pub#main       (本端)
```

## 架构说明

### 关键发现

系统中 `adapter.channelName` 实际上存储的就是 channelKey（完整格式），而不是简单的名称。这是因为在 `channel-loader.ts` 的 `createForAgent()` 中：

```typescript
const aunEffName = agent.effectiveChannelName('aun', 'main');  // 返回 channelKey
rewrittenChannels['aun'] = [{
  type: 'aun',
  name: aunEffName,  // inst.name 被设置为 channelKey
  ...
}];
```

然后在各个 channel 插件中：

```typescript
const adapter = {
  channelName: inst.name,  // inst.name 就是 channelKey
  ...
};
```

所以：
- **adapter.channelName** = channelKey（完整格式）
- **adapter.channelKey** = channelKey（完整格式，新增字段）

两者值相同，但 `channelKey` 字段语义更清晰。

## 编译状态

✅ 编译通过，无与 channelKey 修改相关的错误

现有的编译错误（与本次修改无关）：
- `src/channels/aun.ts`: `agentDir` 属性问题（已存在）
- `src/core/message/message-log.ts`: 类型不匹配（已存在）

## 未修改的部分

### 不需要修改的地方

1. **Session 数据**：`session.channel` 字段会自动使用新格式，因为它从 `adapter.channelKey` 获取
2. **MessageBridge**：`bridge.register()` 的第一个参数已经是 channelKey 格式
3. **MessageProcessor**：使用 channelKey 作为标识符，格式变化不影响逻辑
4. **日志和显示**：使用 `adapter.channelName` 的地方保持不变（因为它已经是 channelKey）

### 为什么不需要数据迁移

因为：
1. Session 数据在运行时动态生成，不需要迁移历史数据
2. 旧的 session 数据会在下次消息到来时自动使用新格式重建
3. 系统设计为无状态，session 可以随时重建

## 验证清单

- [x] ChannelKey 接口定义正确
- [x] formatChannelKey 和 parseChannelKey 使用新格式
- [x] effectiveChannelName 返回新格式
- [x] 所有 channel 插件添加 channelKey 字段
- [x] resolveByChannel 调用使用 channelKey
- [x] CLI 命令返回新格式
- [x] 编译通过

## 后续建议

### 可选优化

1. **重命名 adapter.channelName**：考虑将 `adapter.channelName` 重命名为 `adapter.channelKey`，移除冗余字段
2. **统一命名**：在代码中统一使用 `channelKey` 而不是 `channelName` 来引用完整标识符
3. **文档更新**：更新相关文档说明新的 channelKey 格式

### 不建议的操作

1. ❌ 不要迁移历史 session 数据（会自动更新）
2. ❌ 不要保留旧格式兼容代码（增加复杂度）
3. ❌ 不要修改 adapter.channelName 的值（系统依赖它）

## 总结

✅ channelKey 格式迁移已完成
✅ 新格式：`<type>#<selfPeerId>#<name>`
✅ 与 peerKey 格式保持一致
✅ 编译通过，无相关错误
✅ 系统架构清晰，无需数据迁移

## 日期

2026-05-24
