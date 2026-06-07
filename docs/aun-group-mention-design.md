# AUN 群聊 mention / @all 设计说明

## 背景

AUN SDK 已支持群聊基础能力：

- 入站：订阅 `group.message_created`
- 出站：`group.send`
- 发送者：消息中包含 `sender_aid`
- 群标识：`group_id`

EvolClaw 当前 `src/channels/aun.ts` 已具备群消息收发能力，但还缺少一套清晰的群聊触发与回复机制：

- 群里什么消息应该触发 Agent
- Agent 回复时如何 `@` 回发言者
- 是否支持 `@all`
- 群聊消息合并时，是否还应保留 `[peerName]` 文本前缀

本文只给出设计，不直接实现 `@all` 权限控制。

---

## 现状确认

### 1. AUN 群消息里有发言人信息

根据 AUN group 协议文档，`event/group.message_created` 的消息体包含：

- `group_id`
- `message.seq`
- `message.message_id`
- `message.sender_aid`
- `message.payload`

因此，AUN 群聊**不是没有发言人信息**，而是发言人标识采用 `sender_aid`。

对 EvolClaw 而言：

- `peerId = sender_aid`
- `peerName = sender_aid` 的第一段
  - 例如：`alice.agentid.pub -> alice`

### 2. 当前群聊前缀与队列合并机制有冲突

当前群聊会在 `src/core/message-queue.ts` 中按连续相同 `peerId` 做 FIFO 贪心合并：

- 相同 `peerId` 的多条消息会被拼成一个 `content`
- 合并方式是 `contents.join('\n')`

而 `src/core/message-bridge.ts` 当前会在入站阶段给群聊文本加前缀：

- `[peerName] xxx`

这样一旦同一人连续发两三条消息，被队列合并后就会变成：

```text
[alice] 第一条
[alice] 第二条
[alice] 第三条
```

对 Agent 来说信息重复，对最终 prompt 也比较脏。

**结论**：AUN 群聊不应继续依赖文本前缀表达说话人身份。

更合理的做法是：

- 保留 `peerId` / `peerName` 结构化字段
- 让 `message-processor` 的运行时上下文告诉 Agent 当前说话人是谁
- 不再把 `[peerName]` 注入到群聊正文中

这也更适合后续跨渠道统一。

---

## 设计目标

1. 群聊只在被明确提及时触发 Agent
2. 回复时显式 `@` 原发言人
3. `@all` 使用统一的跨渠道抽象，但权限控制先只设计不实现
4. 尽量复用 EvolClaw 现有 `ReplyContext.mentionUserIds` 通路
5. 避免把渠道语义硬编码进核心层

---

## 一、AUN 群聊触发策略

### 方案

AUN 群聊消息默认**不全部触发**，只在以下情况触发：

- 文本包含 `@{self_aid}`
- 文本包含 `@all`

同时增加两个保护：

- 如果 `sender_aid === self_aid`，直接忽略，避免自回复循环
- 触发后应从正文中剥离 `@{self_aid}` / `@all`，避免把 mention 噪音传给 Agent

### 说明

AUN 的 `group.message_created` 是原始群流，应用层必须自己决定什么消息值得进入 Agent。

因此，AUN 在 channel 层做 mention 过滤是合理的，不应把这个责任推给 core 层。

---

## 二、AUN 出站 mention 机制

## 统一抽象

EvolClaw 现有 `ReplyContext` 已有：

- `mentionUserIds?: string[]`

这本身就是很适合复用的跨渠道抽象：

- Feishu：渲染为结构化 `at` tag
- AUN：渲染为纯文本 `@aid`

### AUN 渲染规则

AUN channel 的群聊出站规则：

- `mentionUserIds = ['alice.agentid.pub']` → 文本前缀 `@alice.agentid.pub `
- `mentionUserIds = ['all']` → 文本前缀 `@all `
- 如果同时包含 `'all'` 和普通 AID，优先按 `@all` 渲染

### peerName 与 mention 的区别

需要区分两个概念：

- **展示名**：`peerName = alice`，用于日志/上下文/界面展示
- **可识别 mention 标识**：`@alice.agentid.pub`

AUN 的触发条件基于 AID，因此出站 mention 也应基于 AID，不能只发 `@alice`，否则会引入歧义。

换句话说：

- 给 Agent 看：可用短名 `alice`
- 给 AUN 客户端识别：应使用完整 `@aid`

---

## 三、群聊回复时是否需要继续注入 `[peerName]` 前缀

**建议：不需要。**

### 原因

1. **与队列合并冲突**
   - 同一人连续发言会被拼接
   - 多个重复前缀会污染文本

2. **结构化字段已经足够**
   - `peerId` 已保留发送者唯一身份
   - `peerName` 已可作为展示名

3. **运行时上下文已经存在承载位置**
   - `message-processor.ts` 会把“对端名称”等信息写入运行时上下文
   - 群聊按相同 `peerId` 合并时，最后一条的 `peerName` 仍可代表该组消息的发言者

### 替代方式

群聊中说话人身份由以下信息承载：

- `message.peerId`
- `message.peerName`
- `message-processor` 注入的运行时上下文
- 出站回复中的 `@aid`

因此，**群聊文本正文应尽量保持干净**。

---

## 四、@all 设计（先设计，不实现权限控制）

## 统一语义

在 EvolClaw core 中，`@all` 使用特殊 token 表达：

- `mentionUserIds = ['all']`

各渠道按自身能力渲染：

- Feishu：结构化 `at all`
- AUN：文本 `@all`

### 入站触发

AUN 群聊中，如果任意用户发送 `@all`，则视为满足触发条件。

也就是说，AUN 群聊触发条件为：

- `@self_aid` 或 `@all`

### 出站行为

如果内部回复上下文要求 `mentionUserIds = ['all']`：

- AUN 发 `@all xxx`
- 不额外补自己

这符合“消息本来就是自己发出去的，不需要再把自己算进 mention 范围”的要求。

---

## 五、@all 权限控制设计（暂不实现）

用户要求支持三档策略：

- `all`：谁都可以 `@all`
- `admin`：仅群主 / 管理员可 `@all`
- `none`：禁用 `@all`

### 配置建议

AUN 渠道配置可扩展：

```json
{
  "channels": {
    "aun": {
      "mentionAllPolicy": "all | admin | none"
    }
  }
}
```

默认值建议：

- `all`

原因：

- AUN 当前更偏实验/内部协作渠道
- 先降低使用门槛
- 未来若群规模扩大，再收紧到 `admin`

### 角色判断所需数据

AUN `group.message_created` 本身不带成员角色。

如果要实现 `admin` 策略，需要补足“消息发送者在当前群里的角色”这一能力。

### 可选实现路径

#### 路径 A：事件驱动 + 本地缓存（推荐）

维护：

- `groupRoleCache: Map<groupId, Map<aid, role>>`

数据来源：

- 首次懒加载：`group.get_members`
- 后续增量更新：监听 `group.changed`
  - `member_added`
  - `member_removed`
  - `member_left`
  - `role_changed`
  - `owner_transferred`

优点：

- 运行期开销小
- 更接近实时
- 与 AUN group 协议模型一致

缺点：

- channel 层状态会变复杂
- 需要处理冷启动与缓存失效

#### 路径 B：每次现查（不推荐）

收到 `@all` 时即时调用：

- `group.get_members`

优点：

- 实现简单

缺点：

- 每次触发都打 RPC
- 群大时性能差
- 对消息热路径不友好

### 推荐结论

如果未来真正实现 `mentionAllPolicy=admin`，应采用：

- **首次懒加载 + `group.changed` 增量维护缓存**

但本轮先只保留设计，不落地实现。

---

## 六、与 Feishu 群聊设计的对比

## 已对齐部分

### 1. 使用统一的 `peerId / peerName / chatType`

两边都已有：

- `peerId`
- `peerName`
- `chatType = 'group'`

因此，AUN 不需要为群聊引入新的 core 概念。

### 2. 使用统一的 `ReplyContext.mentionUserIds`

这是最关键的对齐点。

建议把群聊回复 mention 都收敛到：

- `replyContext.mentionUserIds`

然后：

- Feishu 渲染结构化 at tag
- AUN 渲染文本 `@aid`

这使 core 只表达“要 @谁”，不关心渠道具体写法。

## 不完全对齐但合理的部分

### 1. AUN 需要显式 mention 过滤，Feishu 当前代码没有同等应用层过滤

当前仓库里的 Feishu channel：

- 会读取 `text_without_at_bot`
- 但**没有**在应用层自己检查“是否必须 @bot 才处理”
- 更像是依赖上游投递约定

AUN 不同：

- `group.message_created` 明确是群内原始消息流
- 如果不做 channel 层过滤，Agent 会被群聊所有消息触发

所以这里不需要强行做“代码形式一致”，而应做“语义一致”：

- **Feishu：依赖上游平台提供过滤后的投递语义**
- **AUN：由 channel 层显式补上 mention 过滤**

两者最终效果一致：

- 只有被提及时才进入 Agent

### 2. Feishu 可结构化 @，AUN 只能文本 @

这不是设计不一致，而是渠道能力差异。

更合理的抽象方式不是把 AUN 硬改成结构化 mention，而是：

- core 统一表达 `mentionUserIds`
- channel 自己选择渲染方式

这比在 core 里分支判断 `if feishu ... else if aun ...` 更干净。

## 当前 Feishu 仍有一个未对齐点

当前代码里，Feishu 虽然支持 `mentionUserIds`，但实际上**没有把群聊发言人的 `peerId` 写入回复上下文**，因此目前也不会自动 `@` 原发言人。

如果未来要真正做跨渠道一致，应该把 Feishu 和 AUN 一起收敛到同一规则：

- 群聊被某人触发后，默认回复时 `@` 触发者
- 特殊广播场景再使用 `['all']`

---

## 七、建议的落地顺序

### 第一阶段

只做最小闭环：

1. AUN 群聊仅响应 `@self_aid` / `@all`
2. 忽略自己发出的群消息
3. 去掉群聊正文中的 `[peerName]` 文本前缀
4. 回复时通过 `mentionUserIds` 渲染 `@sender_aid`
5. `peerName` 统一取 AID 第一段

### 第二阶段

跨渠道统一回复 mention：

1. Feishu 群聊也默认 `@` 触发者
2. AUN / Feishu 都走 `replyContext.mentionUserIds`

### 第三阶段（未来）

再考虑真正落地 `@all` 权限控制：

1. 增加 `mentionAllPolicy`
2. 引入 group role cache
3. 基于 `group.changed` 增量维护角色

---

## 结论

本设计的核心判断有四个：

1. **AUN 群消息有发送者信息**，可直接用 `sender_aid` 作为 `peerId`
2. **群聊正文不应再注入 `[peerName]` 前缀**，因为会与 FIFO 合并机制冲突
3. **跨渠道统一抽象应是 `ReplyContext.mentionUserIds`**，而不是在 core 层硬编码各渠道 mention 写法
4. **`@all` 先定义语义和权限模型，不在本轮实现角色鉴权**
