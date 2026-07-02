# 模型配置 - 网关动态选择功能总结

> **补充文档**: [model-config-dynamic-selection.md](./model-config-dynamic-selection.md)  
> **创建时间**: 2026-06-27  
> **修订口径**: 2026-06-29，根据当前代码边界收敛为首期可落地方案

---

## 核心结论

管理员需要在 ecweb 中看到网关当前可用模型，并用勾选方式维护角色的 `allowedModels`。首期实现不改变运行时约束模型：仍以 `roles.json` 中 `baseagents.claude.model.allowedModels` 作为唯一权限来源。

`selectionMode` 首期只作为前端 UI 派生状态，不写入 `roles.json`。原因是当前 `roles.schema.3.json` 对 `FieldPermission` 使用 `additionalProperties: false`，直接写入 `selectionMode` 会导致 schema 校验失败。运行时也不需要该字段：`allowedModels` 数组已经能同时表达通配符和精确型号。

---

## 两种配置方式

### 方式 1: 通配符白名单（默认推荐）

```json
{
  "allowedModels": ["claude-sonnet-*", "claude-haiku-*"]
}
```

特点：
- 新模型上线后自动纳入授权范围。
- 配置简单，维护成本低。
- 成本控制粒度是“模型系列”，不是单个型号。

### 方式 2: 精确型号白名单（严格控制）

```json
{
  "allowedModels": [
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001"
  ]
}
```

特点：
- 只允许管理员勾选过的具体型号。
- 新模型上线后默认不可用，需要手动启用。
- 更适合预算敏感或需要逐个验证模型的团队。

---

## 数据结构口径

### 持久化配置

首期只持久化现有 schema 已支持的字段：

```typescript
interface FieldPermission {
  default: string;
  allowOverride: boolean;
  allowedModels?: string[];
  allowedValues?: unknown[];
  reason?: string;
}
```

### 前端 UI 状态

`selectionMode` 可以保留在前端状态中，用于切换 UI，但保存时只提交 `default`、`allowOverride`、`allowedModels`、`reason`。

```typescript
interface RoleModelConfigUI {
  role: string;
  defaultModel: string;
  allowOverride: boolean;
  reason: string;
  selectionMode: 'pattern' | 'explicit';
  allowedModels: string[];
  gatewayModels: GatewayModel[];
  preview: {
    matched: GatewayModel[];
    matchedCount: number;
  };
}
```

`selectionMode` 的推断规则：
- `allowedModels` 全部是 `*` 或以 `*` 结尾的模式时，显示为 `pattern`。
- `allowedModels` 包含具体模型 ID 时，显示为 `explicit`。
- 混合列表允许存在，但 UI 应提示“高级/混合白名单”。

---

## 推荐 API

为贴合当前 ecweb 结构，角色模型权限接口建议挂在 `role-definitions` 下，而不是新增 `/api/roles/...` 分支。

### API 1: 获取网关模型目录

```http
GET /api/models/catalog?baseagent=claude
```

返回网关模型列表、来源、拉取时间。`refresh=true` 只有在后端实现真实缓存后再开放。

### API 2: 获取角色可配置模型

```http
GET /api/role-definitions/:role/configurable-models
```

返回：
- 当前角色的 `baseagents.claude.model` 权限配置。
- 网关可用模型。
- 当前 `allowedModels` 实际匹配的模型。

### API 3: 预览白名单匹配结果

```http
POST /api/role-definitions/:role/preview-models
Content-Type: application/json

{
  "allowedModels": ["claude-sonnet-*", "claude-haiku-*"]
}
```

返回实际匹配模型和系列统计。预览接口不写配置。

### API 4: 更新角色模型权限

```http
PUT /api/role-definitions/:role/model-permissions
Content-Type: application/json

{
  "defaultModel": "claude-sonnet-4-6",
  "allowOverride": true,
  "allowedModels": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  "reason": "成员只允许使用验证过的中低成本模型"
}
```

保存前必须校验：
- `role` 存在。
- `defaultModel` 非空。
- `allowedModels` 是非空字符串数组。
- `defaultModel` 必须被 `allowedModels` 允许，或是受支持的别名并能解析到允许范围内。
- 写入必须复用 ConfigManager `writeRoles()`，不要直接手写 `roles.json`。

---

## 业务流程

1. 管理员进入 ecweb 的角色定义页。
2. 选择某个角色，例如 `member`。
3. 前端读取角色配置和网关模型目录。
4. 前端根据 `allowedModels` 推断显示通配符模式、精确型号模式或混合模式。
5. 管理员勾选或调整白名单。
6. 前端调用预览接口显示实际匹配模型和成本等级提示。
7. 管理员保存。
8. 后端通过 `writeRoles()` 写入 roles overlay，清除角色缓存。
9. 运行时仍通过现有 `mergeWithRoleConstraints()` 和 `isModelAllowedForRole()` 生效。

---

## 实现优先级

### Phase 1: 最小可用闭环

- `GET /api/models/catalog`
- `GET /api/role-definitions/:role/configurable-models`
- `POST /api/role-definitions/:role/preview-models`
- `PUT /api/role-definitions/:role/model-permissions`
- 角色定义页增加模型白名单配置区
- 保存路径复用 `writeRoles()`

### Phase 2: 体验增强

- 模型目录页
- 新增模型/未授权模型提示
- 白名单混合模式提示
- 审计日志
- 真实 catalog 缓存与刷新

### Phase 3: 可选扩展

- 将 `selectionMode` 持久化到 schema。
- 实现别名到最新具体模型的稳定解析。
- 运行时二次验证模型是否仍在网关目录中。

---

## 需要暂缓的设计点

- 不在首期直接写入 `selectionMode`。
- 不新增绕过 ConfigManager 的 `writeRolesConfig()`。
- 不把 `refresh=true` 标记为真实刷新，除非先实现缓存。
- 不把“包含 Opus = high”当成真实成本控制，只作为 UI 提醒。
