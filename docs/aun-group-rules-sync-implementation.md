# AUN 群规则同步实现方案

> 状态：Implemented
> 最后更新：2026-07-09

本文说明 AUN 群资源空间中的 `/rules.md` 如何同步到本地 venue，并通过 ECK 的 vars + manifest 机制注入上下文。本文也说明本地状态文件、更新判定、读写权限、通知策略和使用方法。

## 目标

- 每个 AUN 群可以维护自己的规则入口文件：`<group-aid>:/rules.md`。
- EvolClaw 在处理 AUN 群聊前只读同步该文件到本地当前 agent 的 venue 目录。
- ECK 通过 vars + manifest 按条件加载本地缓存，使不同群拥有不同工作流程、职责分工和交付规则。
- 同步状态抽象为通用 remote fs 文件 materialization 能力，不绑定到“群规则”概念，后续可以复用于其它远端 fs 文件。
- 群内其它资源不预先生成 `resource-index.md`，需要时通过 `ec fs ls/find/stat/cat <group-aid>:/...` 按权限查询。

## 路径约定

### 远端规则文件

固定路径：

```text
<group-aid>:/rules.md
```

`/rules.md` 是入口规则文档，不是知识库。大小上限固定为 4KB，对齐 AUN `agent.md` 的入口文档定位。

### 本地缓存路径

当前 agent 的 venue 根目录由 `agentVenuesDir(selfAid)` 决定。群 venue key 为：

```text
<channel>#<urlEncode(groupId)>
```

AUN 群规则同步后的文件：

```text
$VENUES_DIR/<venueKey>/rules.md
```

同步状态：

```text
$VENUES_DIR/<venueKey>/_sync/files.json
```

示例：

```text
agents/<self-aid>/venues/aun#team.group.agentid.pub/
├── rules.md
└── _sync/
    └── files.json
```

`group-sync.json` 只作为旧版本兼容迁移读取；新状态不再写入该文件。

## 通用同步 registry

`_sync/files.json` 是通用远端 fs 文件同步 registry，不是群专用配置。一个目录下所有被 materialize 的远端文件共用一个 registry。

entries 的 key 是规范化本地相对路径，而不是 basename：

```json
{
  "schemaVersion": 1,
  "entries": {
    "rules.md": {
      "remoteRef": "team.group.agentid.pub:/rules.md",
      "localPath": "rules.md",
      "remote": {
        "path": "team.group.agentid.pub:/rules.md",
        "type": "file",
        "size": 1200,
        "mtimeMs": 1783000000000,
        "hash": "sha256:..."
      },
      "local": {
        "hash": "sha256:...",
        "usable": true,
        "bytes": 1200,
        "lastValidAt": "2026-07-03T10:00:00.000Z"
      },
      "last": {
        "checkedAt": "2026-07-03T10:01:00.000Z",
        "syncedAt": "2026-07-03T10:00:00.000Z",
        "status": "synced"
      }
    }
  }
}
```

同名文件在不同目录下不会冲突，例如：

```text
rules.md
docs/rules.md
```

两个不同远端文件映射到同一个本地相对路径会被拒绝，避免静默覆盖。`_sync/` 是保留目录，不能作为 materialized 文件目标。

## 同步流程

入口函数：

```ts
syncGroupVenueContext({ selfAid, groupId, channel })
```

调用条件：

- 当前会话是群聊：`session.chatType === 'group'`
- 当前渠道是 AUN：`currentChannelType === 'aun'`
- 当前 agent 有合法 `selfAid`

流程：

1. 计算 `venueKey` 和本地 venue 目录。
2. 读取或创建 `_sync/files.json`。
3. 使用 AUN group fs adapter 查询远端 `stat(<group-aid>:/rules.md)`。
4. 如果远端存在且大小不超过 4KB，根据远端 `hash` 或 `mtimeMs + size` 判断是否需要重新下载。
5. 需要下载时，通过 `group.fs.cp(remoteRef, { kind: 'blob' })` 读取字节。
6. 将规则内容按 UTF-8 文本处理，统一换行为 LF，并原子写入本地 `rules.md`。
7. 更新 `_sync/files.json` 中的远端元数据、本地 hash 和最后状态。
8. 如果本地规则内容发生变化，调用 `invalidateKitCache()`，让后续 ECK 重新读取文件。

同步检查窗口固定为 60 秒，作为内部硬编码常量，不暴露配置项。

## 更新判定

同步判断以远端元数据和本地 hash 为准：

- 优先使用远端 `hash`。
- 如果没有远端 `hash`，使用远端 `mtimeMs + size`。
- 如果远端没有稳定元数据，则在刷新窗口到期后重新读取。
- 本地 `btime` / `mtime` 不作为权威判断。

因此 `ec fs cp` 是否保留本地文件的 btime/mtime 不影响同步正确性。

本地缓存只有在 registry 中 `local.usable === true` 且实际文件 hash 与 registry 记录一致时才可被注入。手工修改本地 `rules.md` 会导致 hash 不匹配，下次同步会重新拉取远端权威文件。

## 状态语义

`groupRulesSyncStatus` 可能为：

| status | 含义 | 是否暴露 `groupRulesPath` |
| --- | --- | --- |
| `synced` | 本轮检查完成，远端与本地同步 | 是 |
| `cached` | 仍在固定检查窗口内，复用上次成功同步结果 | 是 |
| `missing` | 远端 `/rules.md` 不存在 | 否 |
| `forbidden` | 当前 agent 无权限读取远端规则 | 否 |
| `unreadable` | 远端临时不可读或下载失败 | 仅当有上次有效缓存 |
| `too_large` | 远端规则超过 4KB | 仅当有上次有效缓存 |
| `error` | 同步过程出现其它错误 | 仅当有上次有效缓存 |

关键规则：

- `missing` 和 `forbidden` 是明确“不加载”。即使本地还残留旧 `rules.md`，也不暴露 `groupRulesPath`。
- `unreadable`、`too_large`、`error` 是“本轮不能更新”。如果存在上次成功同步且 hash 匹配的缓存，可以继续作为旧规则加载。
- 超限不会覆盖本地缓存。

## vars + manifest 注入

同步结果注入到 ECK vars：

```text
venueKey
venueDir
groupRulesPath
groupRulesRemotePath
groupRulesUpdatedAt
groupRulesSyncStatus
groupRulesSyncError
```

manifest 中的群规则段：

```json
{
  "id": "venue-group-rules",
  "type": "file",
  "file": "$VENUES_DIR/{{venueKey}}/rules.md",
  "order": 43.2,
  "needsInjection": false,
  "when": {
    "and": [
      { "var": "groupRulesPath", "neq": null },
      { "var": "lifecycle", "neq": "bootstrapping" }
    ]
  },
  "description": "群资源空间同步的群规则"
}
```

装配策略：

1. `syncGroupVenueContext()` 先运行，产出 vars。
2. system fragment `venue.md` 注入同步状态，方便模型知道规则来源和状态。
3. manifest 仅当 `groupRulesPath != null` 时加载 `$VENUES_DIR/{{venueKey}}/rules.md`。
4. 因此 `missing/forbidden` 不会误读本地旧文件。

## 权限与写策略

被动同步只读远端，不写远端，不修改 ACL。

远端读写权限由 AUN group fs 后端和群空间 ACL 决定。建议策略：

- 群 owner/admin 有 `/rules.md` 写权限。
- 普通成员只读或无写权限。
- agent 运行时只按当前身份可见权限读取，不绕过 ACL。

如果当前 agent 无读取权限，同步状态为 `forbidden`，不会加载旧规则缓存。

## 更新通知策略

通知只属于写路径，不属于被动同步路径。

会触发通知的操作：

- `ec fs cp <local> <group-aid>:/rules.md --as <writer-aid>`
- `ec fs cp <remote> <group-aid>:/rules.md --as <writer-aid>`
- `ec fs mv <remote> <group-aid>:/rules.md --as <writer-aid>`

写入成功后，CLI 会 best-effort 发送群消息：

```json
{
  "type": "notice",
  "subtype": "group.rules.updated",
  "text": "群规则已更新：<group-aid>:/rules.md\n操作者：<writer-aid>\n来源：...",
  "actor_aid": "<writer-aid>",
  "group_id": "<group-aid>",
  "path": "/rules.md",
  "command": "ec.fs.cp",
  "updated_at": "..."
}
```

说明：

- 谁成功重写 `/rules.md`，谁触发通知。
- 被动同步发现规则变化不会发通知。
- 通知失败不回滚已经成功的远端写入，命令输出会提示“规则已写入，但通知发送失败”。
- 绕过 EvolClaw CLI 的外部写入不会自动广播；同步器只会在下一次读取时刷新本地缓存。

## 使用方法

### 写入群规则

准备本地入口规则：

```bash
cat > /tmp/rules.md <<'EOF'
# 群规则

- 默认使用中文回复。
- 需求讨论由产品 owner 汇总，技术拆分由 backend/frontend agent 分工处理。
- 涉及线上风险时先给出风险评估，再执行变更。
EOF
```

上传到群资源空间：

```bash
ec fs cp /tmp/rules.md team.group.agentid.pub:/rules.md --as admin.agentid.pub --overwrite
```

上传成功后，如果目标是 AUN group fs 的 `/rules.md`，命令会发送 `group.rules.updated` 通知。

### 查看规则

```bash
ec fs stat team.group.agentid.pub:/rules.md --as bot.agentid.pub
ec fs cat team.group.agentid.pub:/rules.md --as bot.agentid.pub
```

### 查询群内其它资源

不再生成 `resource-index.md`。需要时直接查：

```bash
ec fs ls team.group.agentid.pub:/ --as bot.agentid.pub
ec fs find team.group.agentid.pub:/ --name "*.md" --as bot.agentid.pub
ec fs stat team.group.agentid.pub:/docs/spec.md --as bot.agentid.pub
ec fs cat team.group.agentid.pub:/docs/spec.md --as bot.agentid.pub
```

### 检查本地同步状态

```bash
cat "$EVOLCLAW_HOME/agents/<self-aid>/venues/aun#<urlEncodedGroupId>/_sync/files.json"
```

重点看：

- `entries["rules.md"].remote`
- `entries["rules.md"].local.usable`
- `entries["rules.md"].last.status`
- `entries["rules.md"].last.error`

## 排障

### 规则未注入

检查 `groupRulesSyncStatus`：

- `missing`：远端没有 `/rules.md`。
- `forbidden`：当前 agent 没有读取权限。
- `too_large`：规则超过 4KB。
- `unreadable/error`：远端或网络暂时异常；如果没有历史有效缓存，就不会注入。

### 本地有 rules.md 但没有加载

这是预期保护。只有 registry 证明该文件来自上次成功同步，且 hash 匹配，才会暴露 `groupRulesPath`。

### 修改本地 rules.md 不生效

本地 `rules.md` 是远端权威文件的缓存。应修改并上传远端 `/rules.md`，不要直接编辑本地缓存。

### 规则更新后没有广播

只有 EvolClaw CLI 的成功写路径会广播。外部工具直接写群空间不会触发广播。

### 需要关闭群规则同步

当前没有关闭开关。群规则是 AUN 群上下文的默认能力；如果某个群不需要规则，删除远端 `/rules.md` 或不给当前 agent 读取权限即可。

## 相关实现文件

- `src/fs/remote-file-sync.ts`：通用远端 fs 文件 materialization、`_sync/files.json` registry、状态机。
- `src/eck/group-venue-sync.ts`：AUN 群规则同步 wrapper。
- `src/core/message/response-engine.ts`：群聊处理前调用同步并注入 vars。
- `kits/eck_manifest.json`：`venue-group-rules` manifest 段。
- `kits/templates/system-fragments/venue.md`：同步状态 vars 展示。
- `src/cli/fs-command.ts`：`ec fs cp/mv` 写入 `/rules.md` 后的 best-effort 群通知。
- `tests/unit/remote-file-sync.test.ts`：registry key、冲突、missing/不可读 fallback 测试。
