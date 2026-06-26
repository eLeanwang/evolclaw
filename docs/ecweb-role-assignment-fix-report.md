# ECWeb 角色分配修复报告

日期：2026-06-26

## 摘要

本次修复覆盖 ECWeb 角色分配的完整链路：

1. 修复“agent 配置不合 schema(agent-config.v2): / must NOT have additional properties”。
2. 修复角色定义管理有 5 个内置角色，但角色分配只有 4 个可选的问题。
3. 增加后端写操作权限校验，避免仅凭 ECWeb token 修改角色配置。
4. 完整 review `ecweb/src/static/app.js` 中角色相关前端逻辑，修复代理前缀、群聊分配和旧脏数据清理问题。
5. 增加单独 debug 日志文件，便于后续排查。

## 现象

角色分配给对端 AID 时可能报错：

```text
操作中... 配对失败: agent 配置不合 schema(agent-config.v2): / must NOT have additional properties
```

角色定义管理中有 5 个内置角色：

```text
owner, admin, member, guest, anonymous
```

但角色分配下拉框原来只有 4 个：

```text
owner, admin, member, anonymous
```

## 根因

### 1. Agent schema 缺少 `members`

ECWeb 会写入 agent 配置中的：

```text
owners
admins
members
```

但 `kits/schemas/agent-config.schema.2.json` 原来没有定义 `members`，而 schema 又设置了：

```json
"additionalProperties": false
```

所以写入 `members` 会触发 schema additional properties 错误。

### 2. 前端角色列表硬编码

`ecweb/src/static/app.js` 原来将角色分配下拉框硬编码为：

```js
['owner', 'admin', 'member', 'anonymous']
```

因此漏掉 `guest`，也不会展示自定义角色。

### 3. 非列表型角色没有完整持久化路径

`owner/admin/member` 是 agent 级列表角色，可以写入 `owners/admins/members`。

但 `guest/anonymous/custom roles` 不是列表型角色，需要写到 relation 级 `role` 覆盖。原链路没有完整支持这类角色。

### 4. 写操作只校验 token，没有校验操作者身份

ECWeb token 只能证明浏览器完成过配对，不能证明当前操作者是目标 agent 的 `owner/admin`。

因此后端写接口必须二次校验操作者权限，否则绕过前端即可修改角色。

### 5. 群聊被当成 AID 列表成员写入

群聊的 `peerAid` 实际是 `groupId`，不应该写入 agent 的 `owners/admins/members` AID 列表。

如果旧逻辑曾把 groupId 写进去，由于角色解析优先级是 `owners > admins > members > relation.role`，后续 relation 覆盖也可能被旧列表项压住。

## 修复内容

### Schema 和类型

修改文件：

```text
kits/schemas/agent-config.schema.2.json
kits/schemas/relation-config.schema.1.json
src/types.ts
```

修复点：

- `agent-config.schema.2.json` 增加 `members` 字段。
- `relation-config.schema.1.json` 增加 relation 级 `role` 字段。
- `RelationConfig` 增加 `role?: string`。

### 角色解析

修改文件：

```text
src/config/role-resolver.ts
```

角色优先级调整为：

```text
owners > admins > members > relation.role > authenticated guest > defaultRole
```

同时支持 raw / encoded 两种 AUN peer key：

```text
aun#peerAid
aun#encodeURIComponent(peerAid)
```

### ECWeb 后端角色分配

修改文件：

```text
ecweb/src/server.ts
ecweb/src/sources/role-assignments.ts
```

修复点：

- `/api/roles/agent/:aid` 写入前按 schema 白名单清理配置，避免 additionalProperties 错误。
- 新增 relation 级角色接口：

```text
PUT    /api/assignments/peer/:aid/:peerKey
DELETE /api/assignments/peer/:aid/:peerKey
```

- `guest/anonymous/custom roles` 通过 relation `role` 持久化。
- `/api/assignments/peer/` 增加 token 鉴权。
- agent 角色列表写入和 peer relation role 写入都增加后端 owner/admin 权限校验。
- URL 解析统一去掉 query，避免 `?token=` 被误解析进 aid 或 peerKey。

### ECWeb 后端角色定义

修改文件：

```text
ecweb/src/server.ts
ecweb/src/sources/role-definitions.ts
```

修复点：

- `/api/role-definitions` 增加 token 鉴权。
- 创建、修改、删除、重置角色定义时增加后端权限校验。
- 本地直连允许写入。
- 代理访问必须有可信 actor AID，且 actor 必须在 `evolclaw.json` 的 `owners` 中。
- 没有可信 actor AID 的代理写请求 fail closed，返回 `403`。

权限策略：

```text
角色分配写入：
local direct -> allow
proxied + trusted actor AID -> actor must be target agent owner/admin
proxied without trusted actor AID -> deny

角色定义写入：
local direct -> allow
proxied + trusted actor AID -> actor must be process owner
proxied without trusted actor AID -> deny
```

注意：当前 AUN Service Proxy 文档说明不会注入访客身份。因此远程代理场景如果没有可信 actor header，会被拒绝写入。这是为了满足“非 owner/admin 禁止修改”的 fail-closed 策略。

当前预留可信 actor header：

```text
x-aun-visitor-aid
x-aun-actor-aid
x-aun-user-aid
x-evolclaw-actor-aid
```

### ECWeb 前端

修改文件：

```text
ecweb/src/static/app.js
```

修复点：

- 角色分配下拉框包含 5 个内置角色：

```text
owner, admin, member, guest, anonymous
```

- 同时合并角色定义管理中的自定义角色。
- 角色相关 REST 调用全部使用 `apiUrl(...)`，适配 AUN Service Proxy path prefix。
- 使用 snapshot 中真实 `peerKey`，不再从 `peerAid` 重新拼。
- 私聊：
  - `owner/admin/member` 写入 agent 列表。
  - `guest/anonymous/custom` 写入 relation `role`。
  - 切回列表型角色时清掉 relation override。
- 群聊：
  - 所有角色，包括 `owner/admin/member`，都写入 relation `role`。
  - 不再把 groupId 写入 agent 的 `owners/admins/members`。
  - 如果旧版本已写入 groupId，下次保存群聊角色时会先清理这些脏列表项。

### Debug 日志

新增日志文件：

```text
$EVOLCLAW_HOME/logs/role-assignments-debug.jsonl
```

关键事件包括：

```text
agent-role-update-request
agent-role-update-existing-config
agent-role-update-before-write
agent-role-update-success
agent-role-update-error
agent-role-update-forbidden
peer-role-update-request
peer-role-update-success
peer-role-update-error
peer-role-update-unknown-role
peer-role-update-forbidden
```

## 验证结果

已运行测试：

```powershell
npm.cmd test -- tests/roles.test.ts tests/role-constraints.test.ts tests/role-integration.test.ts tests/role-second-fixes.test.ts tests/role-third-fixes.test.ts tests/role-fixes-verification.test.ts tests/role-resolver.test.ts tests/config-routing.test.ts
```

结果：

```text
8 test files passed
143 tests passed
```

已运行主项目构建：

```powershell
npm.cmd run build
```

已运行 ECWeb 构建：

```powershell
cd ecweb
npm.cmd run build
```

两个构建均通过。

## 文件变更

主修复文件：

```text
ecweb/src/server.ts
ecweb/src/sources/role-assignments.ts
ecweb/src/sources/role-definitions.ts
ecweb/src/static/app.js
kits/schemas/agent-config.schema.2.json
kits/schemas/relation-config.schema.1.json
src/config/role-resolver.ts
src/types.ts
```

测试文件：

```text
tests/config-routing.test.ts
tests/role-resolver.test.ts
tests/roles.test.ts
```

报告文件：

```text
docs/ecweb-role-assignment-fix-report.md
```

## 结论

schema 报错已修复；角色分配现在支持 5 个内置角色和自定义角色；非列表型角色通过 relation `role` 持久化；群聊角色不再污染 agent AID 列表；后端写操作已补 owner/admin/process owner 权限校验；角色分配 debug 日志已落地。
