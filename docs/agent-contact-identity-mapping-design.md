# Agent 级 contact.json 跨渠道身份映射设计

## 背景

当前 Agent 的 `owners` / `admins` 只适合保存 AUN AID 等统一身份：

```json
{
  "owners": ["elean.agentid.pub"]
}
```

但飞书、微信等渠道入站消息只携带渠道账号 ID，例如飞书 `ou_...`、微信 `wxid_...`。如果直接把这些渠道 ID 写进 `owners`，会让角色授权、渠道身份和长期联系人身份混在一起，后续降权、迁移和跨渠道合并都会变复杂。

本设计采用 Agent 级 `contact.json` 保存“渠道身份 -> 统一身份”的绑定关系。`owners` / `admins` 保持简单的 `string[]`，不改变 `evolclaw.json.owners`。

## 目标

- 在 Agent 层支持跨渠道身份识别。
- `owners` / `admins` 继续只保存统一身份 AID。
- 飞书、微信等渠道用户可以通过 `contact.json` 映射到统一身份后获得 owner/admin 权限。
- 不新增落盘索引文件；运行时如需加速，只构建内存反向 Map。
- 回复消息、会话目录、日志仍使用渠道原始 ID，避免破坏现有路由。
- 为未来完整身份统一预留扩展点。

## 实现状态

当前完成情况只覆盖 Agent 级身份映射 MVP：`contact.json` 的配置承载、读写解析、内存映射构建，以及 owner/admin 权限解析前的身份归一化。

不纳入本状态的内容：非 AUN 渠道 init 绑定、首条消息绑定 owner、钉钉绑定码等后续流程改造。

已完成：

- 新增 Agent 根目录 `contact.json` 作为联系人绑定真相源。
- 新增 `ConfigTarget.Contact`、`agentContactConfig()`、`contact-book` schema 和 schema 注册信息。
- 新增 `src/config/contact-book.ts`，通过 `ConfigManager` 读取/写入联系人配置，并构建运行时 `aliasToPrimary` 映射。
- 提供 `resolvePrimaryId()`、`bindContactAlias()`、`unbindContactAlias()` 等联系人身份操作。
- `resolvePeerRoleDetail()` 已在 owner/admin 判断前使用 `resolvePrimaryId()` 做身份归一化。
- relation role、会话 key、日志和出站路由仍使用渠道原始 `actorId`，没有做全局覆盖。
- `owners/admins` 仍保持 `string[]`，没有修改 `evolclaw.json.owners`。
- 已覆盖 contact-book、peer-role-resolver、ConfigManager 等核心路径测试。

仍属后续阶段：

- 独立 `ec contact ...` 管理命令。
- ECWeb 联系人绑定展示和管理入口。
- relation config 中的 `contactId` 扩展。
- contact 修改审计和迁移工具。

## 非目标

第一阶段不做以下事项：

- 不修改 `evolclaw.json.owners`。
- 不把 `owners` 改成对象或复杂结构。
- 不合并飞书、微信、AUN 的历史会话。
- 不迁移 `relations/` 目录结构。
- 不把 `profile.md` 作为鉴权真相源。
- 不做全局身份簿，只做单 Agent 内生效。
- 暂不提供独立 `ec contact bind` 命令；渠道 init 绑定流程不作为本文完成状态的一部分。

## 文件位置

每个 Agent 独立维护自己的联系人映射：

```text
agents/<agent-aid>/contact.json
```

示例：

```text
agents/evolai.agentid.pub/contact.json
```

`contact.json` 是该 Agent 的联系人绑定真相源。文件路径、schema 校验、原子写入和文件缓存统一复用 `ConfigManager`；运行时只构建内存反向 Map，不写出 `identity-index.json` 之类的派生文件。

## 数据结构

### Agent config

`agents/<aid>/config.json` 保持现状：

```json
{
  "$schema_version": 3,
  "aid": "evolai.agentid.pub",
  "owners": ["elean.agentid.pub"],
  "admins": [],
  "channels": []
}
```

### contact.json

推荐结构：

```json
{
  "$schema_version": 1,
  "contacts": {
    "elean.agentid.pub": {
      "displayName": "Elean",
      "aliases": [
        "aun:elean.agentid.pub",
        "feishu:ou_2114acae0d376b26dfbc14bbca5b1f7e",
        "wechat:wxid_xxx"
      ]
    },
    "bradtest.agentid.pub": {
      "aliases": [
        "aun:bradtest.agentid.pub"
      ]
    }
  }
}
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `$schema_version` | number | 当前为 `1` |
| `contacts` | object | key 是统一身份 ID，建议使用 AUN AID |
| `contacts[primaryId].displayName` | string | 可选，仅展示使用，不参与鉴权 |
| `contacts[primaryId].aliases` | string[] | 渠道身份列表，格式为 `<channelType>:<peerId>` |

### Alias 格式

第一阶段使用简单格式：

```text
<channelType>:<peerId>
```

示例：

```text
feishu:ou_2114acae0d376b26dfbc14bbca5b1f7e
wechat:wxid_xxx
aun:elean.agentid.pub
```

暂不引入 `channelName`，以降低实现复杂度。若后续出现同类型多实例 ID 冲突，再升级为：

```text
<channelType>#<channelName>:<peerId>
```

或扩展为结构化 alias 对象。

## 权限解析流程

收到飞书消息：

```text
channelType = feishu
actorId     = ou_2114acae0d376b26dfbc14bbca5b1f7e
```

解析流程：

```text
1. 读取 agents/evolai.agentid.pub/contact.json
2. 构建内存反向映射：
   feishu:ou_2114... -> elean.agentid.pub
   wechat:wxid_xxx   -> elean.agentid.pub
3. 将 actorId 映射为 primaryId = elean.agentid.pub
4. 用 primaryId 判断 config.json owners/admins
5. 会话、日志、回复仍使用原始 actorId
```

伪代码：

```ts
function resolvePrimaryId(selfAid: string, channelType: string, actorId: string): string {
  if (isAuthenticated(actorId)) return actorId;

  const contacts = loadAgentContacts(selfAid);
  const alias = `${channelType}:${actorId}`;
  return contacts.aliasToPrimary.get(alias) ?? actorId;
}
```

在 `resolvePeerRoleDetail()` 中只替换角色判断主体：

```ts
export function resolvePeerRoleDetail(ctx: PeerRoleContext): ResolvedPeerRole {
  const checkId = resolvePrimaryId(ctx.selfAid, ctx.channelType, ctx.actorId);
  const auth = isAuthenticated(checkId);

  if (isStaticAgentOwner(ctx.selfAid, checkId)) {
    return resultFor('owner', 'agent-config-owner', auth, ctx.selfAid, true);
  }

  if (isStaticAgentAdmin(ctx.selfAid, checkId)) {
    return resultFor('admin', 'agent-config-admin', auth, ctx.selfAid, true);
  }

  // 第一阶段：后续 relation role 解析保持现状，仍按渠道原始 actorId 查。
}
```

注意：不要全局覆盖 `ctx.actorId`。`actorId` 仍是渠道原始 ID，用于出站路由、日志、会话和关系目录。

## 生效范围

第一阶段只影响：

- Agent 级 owner 判断。
- Agent 级 admin 判断。
- 依赖 `resolvePeerRoleDetail()` 的命令权限判断。

第一阶段不影响：

- `evolclaw.json.owners` 进程级鉴权。
- 会话 key。
- `relations/<peerKey>/config.json` 的读取路径。
- 出站消息收件人。
- 群成员实时角色判断。

## 渠道绑定流程边界

本文只定义 `contact.json` 如何承载已确认的身份映射，以及权限解析如何使用映射。非 AUN 渠道 init 绑定、首条消息确认、二维码或验证码交互等流程另行设计；这些流程最终只需要调用 contact-book 的绑定操作写入 alias，不改变本文的数据结构和权限解析原则。

## 缓存策略

`contact.json` 的文件级缓存由 `ConfigManager.read(ConfigTarget.Contact, { self }, { cache: true })` 负责：

```text
1. ConfigManager 解析 agents/<aid>/contact.json
2. ConfigManager 执行 schema 版本处理、mtime 文件缓存和读取失败处理
3. contact-book.ts 基于读取到的 ContactBookConfig 对象构建 aliasToPrimary
4. 派生 Map 只放内存，可用 WeakMap 按配置对象引用缓存
5. ConfigManager.write() 原子写入后失效文件缓存，下次读取得到新对象并重建派生 Map
```

不落盘任何索引文件；也不在 `contact-book.ts` 中重复实现 stat、路径拼接或原子写入。

## 冲突处理

同一个 alias 不能绑定到多个 primaryId。

示例非法配置：

```json
{
  "contacts": {
    "alice.agentid.pub": {
      "aliases": ["feishu:ou_xxx"]
    },
    "bob.agentid.pub": {
      "aliases": ["feishu:ou_xxx"]
    }
  }
}
```

建议处理方式：

- 加载时记录 warn。
- 冲突 alias 不进入内存反向映射。
- 该渠道身份按未映射处理，不获得 owner/admin 权限。

这样比任选一个 primaryId 更安全。

## 与 relations 的关系

`contact.json` 表示“这个人是谁”：

```text
feishu:ou_xxx 和 wechat:wxid_xxx 属于 elean.agentid.pub
```

`relations/` 表示“某个渠道会话关系如何配置”：

```text
relations/feishu#ou_xxx/config.json
relations/wechat#wxid_xxx/config.json
```

第一阶段二者不合并。未来如果要完整身份统一，可以在 relation config 中增加指针：

```json
{
  "contactId": "elean.agentid.pub"
}
```

然后再决定模型偏好、权限模式、记忆、配额是否按 contact 聚合。

## 主要代码改动

### 新增模块

建议新增：

```text
src/config/contact-book.ts
```

职责：

- 通过 `ConfigManager` 读取 contact book。
- 构建内存 `aliasToPrimary`。
- 提供 `resolvePrimaryId(selfAid, channelType, actorId)`。
- 提供显式 `bindContactAlias()` / `unbindContactAlias()` 关系绑定操作。
- 校验 primaryId、alias 格式和 alias 冲突。

边界：

- `ConfigManager` 负责路径、schema 校验、原子写入、文件缓存和缓存失效。
- `contact-book.ts` 负责联系人身份领域逻辑，不直接操作 `fs`。

### 修改 peer-role-resolver

位置：

```text
src/config/peer-role-resolver.ts
```

改动：

- 在 owner/admin 判断前调用 `resolvePrimaryId()`。
- owner/admin 使用 `checkId`。
- relation role 第一阶段继续使用原始 `ctx.actorId`。

### 修改路径工具

可选新增路径 helper：

```ts
export function agentContactConfig(aid: string): string;
```

位置可放在：

```text
src/paths.ts
```

或直接在 `contact-book.ts` 中基于现有 `agentDir(aid)` 拼接。

### 类型定义

可在 `src/types.ts` 或 `src/config/contact-book.ts` 内定义：

```ts
export interface ContactBookConfig {
  $schema_version?: number;
  contacts?: Record<string, ContactEntry>;
}

export interface ContactEntry {
  displayName?: string;
  aliases?: string[];
}
```

### CLI / ECWeb

第一阶段不做独立 contact 管理 UI；非 AUN 渠道 init 绑定入口不纳入本文完成状态。

后续再考虑：

- `ec contact list --self <aid>`
- `ec contact bind --self <aid> <primaryId> <channelType:peerId>`
- ECWeb Agent 详情页展示联系人绑定。

## 迁移策略

当前配置里可能存在：

- `agents/<aid>/config.json.owners` 中混入渠道 ID。
- `channels[].owners` 中配置渠道 owner。

迁移建议：

1. 保留 AID owner 到 `config.json.owners`。
2. 把渠道 ID 写入 `contact.json.contacts[primaryId].aliases`。
3. 若只有一个 AID owner，可以自动归属到该 owner。
4. 若有多个 AID owner，无法判断渠道 ID 归属，生成报告人工确认。
5. 暂时保留旧字段读取兼容，确认迁移完成后再删除。

## 安全要求

- `owners/admins` 仍是权限真相源。
- `contact.json` 只提供身份归一化，不直接授予角色。
- alias 冲突时 fail closed。
- 未映射渠道账号不能自动成为 owner。
- 修改 `contact.json` 应视为敏感操作，未来纳入审计。

## 测试计划

至少覆盖：

1. `contact.json` 不存在时，维持旧行为。
2. `feishu:ou_xxx` 映射到 owner AID 后获得 owner 权限。
3. `wechat:wxid_xxx` 映射到 admin AID 后获得 admin 权限。
4. 未映射渠道 ID 不获得 owner/admin 权限。
5. alias 冲突时不映射。
6. 通过 `ConfigManager.write(ConfigTarget.Contact)` 修改 `contact.json` 后能刷新派生 Map。
7. AUN AID 直接入站时不依赖 contact.json，仍按原 owner/admin 判断。
8. `bindContactAlias()` 幂等、冲突拒绝，`unbindContactAlias()` 可移除绑定。

## 分阶段实施

### 阶段一：权限识别 MVP

状态：已完成。

- 新增 `ConfigTarget.Contact` 和 `contact-book` schema。
- 新增 `contact-book.ts` 领域服务。
- `resolvePeerRoleDetail()` owner/admin 前接入映射。
- 添加单元测试。
- 不改 UI、不改会话、不改 relations。

### 阶段二：管理入口

- CLI 支持查看和绑定 contact alias。
- ECWeb 展示联系人映射。
- contact 修改纳入审计。

### 阶段三：完整身份统一

- relation config 增加 `contactId`。
- 决定哪些配置从 relation 级提升到 contact 级。
- 评估跨渠道会话、记忆、配额、观察者视图是否聚合。

## 决策

采用 Agent 根目录 `contact.json` 作为第一阶段跨渠道身份映射真相源：

```text
agents/<aid>/contact.json
```

不新增落盘索引文件，不改变 `owners/admins` 类型，不改变 `evolclaw.json.owners`，只在 Agent 级权限解析前进行身份归一化。
