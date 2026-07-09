# EvolClaw 模型配置 - 网关动态选择设计

> **文档版本**: v1.1  
> **创建时间**: 2026-06-27  
> **修订时间**: 2026-06-29  
> **状态**: Implemented  
> **关联文档**: [模型配置设计方案](./model-config-design.md)

---

## 一、功能概述

### 1.1 需求背景

管理员需要为不同角色配置允许使用的模型列表。当前运行时已经支持 `allowedModels` 白名单，并支持两类表达：

1. **通配符白名单**：如 `claude-sonnet-*`，用于允许整个模型系列。
2. **精确型号白名单**：如 `claude-sonnet-4-6`，用于只允许具体模型。

本文档重点解决 ecweb 上的可视化配置问题：管理员应该能看到网关当前可用模型，通过勾选方式生成 `allowedModels`，而不是手动编辑 JSON。

### 1.2 首期设计口径

首期不改变运行时权限模型，不新增必需配置字段：

- 权限真相仍是 `roles.json` 中 `roles[role].permissions["baseagents.claude.model"].allowedModels`。
- `selectionMode` 只作为前端 UI 状态，用于区分“通配符编辑”和“精确型号勾选”。
- 后端保存时不写 `selectionMode`，避免违反当前 `roles.schema.3.json` 的 `additionalProperties: false`。
- 保存必须走 ConfigManager 的 `writeRoles()`，不能新增直接写 `roles.json` 的文件写入器。

### 1.3 功能目标

- 从网关模型目录获取可用模型列表。
- 在角色定义页展示当前角色模型权限。
- 支持通配符模式和精确型号模式的 UI 切换。
- 保存前预览当前白名单实际匹配的模型。
- 保存角色模型权限后立即通过现有角色约束逻辑生效。

### 1.4 非目标

- 首期不实现真实成本计费。
- 首期不持久化 `selectionMode`。
- 首期不保证别名 `opus/sonnet/haiku` 已自动解析到最新具体型号；如果需要该能力，应单独实现稳定排序和解析函数。
- 首期不把 `refresh=true` 暴露为真实强制刷新，除非后端先实现 catalog 缓存。

---

## 二、数据结构设计

### 2.1 持久化结构

当前 schema 已支持的模型权限字段如下：

```typescript
interface FieldPermission<T = any> {
  default: T;
  allowOverride: boolean;
  allowedModels?: string[];
  allowedValues?: T[];
  reason?: string;
}
```

示例：

```json
{
  "baseagents.claude.model": {
    "default": "claude-sonnet-4-6",
    "allowOverride": true,
    "allowedModels": ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    "reason": "成员只允许使用验证过的中低成本模型"
  }
}
```

### 2.2 前端 UI 状态

前端可以维护额外状态，但不能直接等同于持久化 schema：

```typescript
interface RoleModelConfigUI {
  role: string;
  defaultModel: string;
  allowOverride: boolean;
  reason: string;
  allowedModels: string[];
  selectionMode: 'pattern' | 'explicit' | 'mixed';
  gatewayModels: GatewayModel[];
  preview: {
    matched: GatewayModel[];
    statistics: {
      total: number;
      opus: number;
      sonnet: number;
      haiku: number;
      other: number;
    };
  };
}

interface GatewayModel {
  id: string;
  family: 'opus' | 'sonnet' | 'haiku' | 'other';
  owned_by?: string;
  created?: number;
  status: 'available' | 'alias' | 'unknown';
}
```

### 2.3 selectionMode 推断规则

`selectionMode` 由 `allowedModels` 推断：

```typescript
function inferSelectionMode(allowedModels: string[]): 'pattern' | 'explicit' | 'mixed' {
  const hasPattern = allowedModels.some(v => v === '*' || v.endsWith('*'));
  const hasExplicit = allowedModels.some(v => v !== '*' && !v.endsWith('*'));
  if (hasPattern && hasExplicit) return 'mixed';
  return hasExplicit ? 'explicit' : 'pattern';
}
```

混合模式是合法配置，但 UI 应明确提示它不是普通勾选模式，避免管理员误以为只有当前勾选模型会生效。

---

## 三、API 设计

为贴合当前 ecweb，角色模型权限接口建议放在 `/api/role-definitions` 下。当前 `/api/roles/` 已用于角色分配，不建议复用该前缀承载角色定义写入。

### 3.1 获取模型目录

```http
GET /api/models/catalog?baseagent=claude
```

响应：

```json
{
  "success": true,
  "data": {
    "models": [
      {
        "id": "claude-sonnet-4-6",
        "owned_by": "anthropic",
        "family": "sonnet",
        "status": "available"
      }
    ],
    "source": "v1/models",
    "lastUpdate": "2026-06-29T00:00:00.000Z"
  }
}
```

实现要点：

- 复用 `src/core/model/model-catalog.ts` 的 `getCatalog()`。
- `family` 可以先按 ID 包含 `opus`、`sonnet`、`haiku` 推断。
- `status=alias` 仅用于 `owned_by === "alias"` 的虚拟条目。
- 若要支持 `refresh=true`，必须先实现真实缓存和 bypass；否则不要返回 `cached: !refresh` 这种伪状态。

### 3.2 获取角色可配置模型

```http
GET /api/role-definitions/:role/configurable-models
```

响应：

```json
{
  "success": true,
  "data": {
    "role": "member",
    "current": {
      "defaultModel": "claude-sonnet-4-6",
      "allowOverride": true,
      "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],
      "reason": "成员可使用中低成本模型",
      "selectionMode": "pattern"
    },
    "gatewayModels": [
      { "id": "claude-sonnet-4-6", "family": "sonnet", "status": "available" }
    ],
    "matched": {
      "models": [
        { "id": "claude-sonnet-4-6", "family": "sonnet", "status": "available" }
      ],
      "count": 1
    }
  }
}
```

实现要点：

- 使用 `readRolesConfig()` 读取完整合并视图。
- `selectionMode` 只在响应中推断返回。
- 匹配逻辑应复用或抽取现有 `isModelAllowed()` 的规则，避免前后端各写一套不一致算法。

### 3.3 预览白名单匹配结果

```http
POST /api/role-definitions/:role/preview-models
Content-Type: application/json

{
  "allowedModels": ["claude-sonnet-*", "claude-haiku-*"]
}
```

响应：

```json
{
  "success": true,
  "data": {
    "role": "member",
    "selectionMode": "pattern",
    "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],
    "matched": [
      { "id": "claude-sonnet-4-6", "family": "sonnet", "status": "available" }
    ],
    "statistics": {
      "total": 1,
      "opus": 0,
      "sonnet": 1,
      "haiku": 0,
      "other": 0
    },
    "riskHint": {
      "tier": "medium",
      "message": "包含 Sonnet 系列模型"
    }
  }
}
```

`riskHint` 只是 UI 风险提示，不是计费或强约束依据。

### 3.4 更新角色模型权限

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

保存校验：

- `role` 必须存在。
- `defaultModel` 必须是非空字符串。
- `allowOverride` 必须是 boolean。
- `allowedModels` 必须是非空字符串数组。
- `defaultModel` 必须被 `allowedModels` 允许；如果 `defaultModel` 是 `opus/sonnet/haiku` 这类别名，需要先有明确别名解析策略再允许。
- 不能提交 `selectionMode` 到持久化对象。

写入流程：

1. 读取 `readRolesConfig()` 完整视图。
2. 只替换目标角色的 `permissions["baseagents.claude.model"]`。
3. 调用 ConfigManager `writeRoles(fullConfig)`。
4. `writeRoles()` 内部负责 overlay diff、schema 校验、原子写入和角色缓存清理。
5. 返回保存后的 effective permission 和匹配预览。

---

## 四、前端交互设计

### 4.1 角色定义页模型配置区

每个角色详情或编辑弹窗中增加“模型权限”区域：

- 默认模型输入或选择器。
- `allowOverride` 开关。
- 白名单编辑方式：
  - 通配符模式：`*`、`claude-opus-*`、`claude-sonnet-*`、`claude-haiku-*`。
  - 精确型号模式：按网关模型列表勾选具体 ID。
  - 混合模式：显示高级提示，允许手工编辑白名单。
- 匹配预览：显示当前白名单实际匹配哪些模型。

### 4.2 模式切换策略

从通配符模式切换到精确型号模式时：

- 前端先调用预览接口。
- 将当前通配符匹配到的模型作为初始勾选项。
- 用户保存后，`allowedModels` 变成具体模型 ID 列表。

从精确型号模式切换到通配符模式时：

- 前端显示系列选项。
- 用户保存后，`allowedModels` 变成通配符列表。

### 4.3 新模型提示

当网关目录中存在匹配某个系列但未被当前精确白名单授权的模型时，UI 应显示“新模型未授权”提示，并允许管理员勾选启用。

---

## 五、业务流程

### 5.1 管理员配置 member 角色

1. 管理员进入 ecweb 角色定义页。
2. 打开 `member` 角色编辑。
3. 前端调用 `GET /api/role-definitions/member/configurable-models`。
4. UI 根据 `allowedModels` 推断当前为通配符、精确型号或混合模式。
5. 管理员选择精确型号模式。
6. 前端用当前通配符匹配结果初始化勾选项。
7. 管理员取消 Opus，仅保留 Sonnet 和 Haiku 的具体型号。
8. 前端调用预览接口展示匹配结果。
9. 管理员保存。
10. 后端通过 `writeRoles()` 写入角色 overlay。
11. 运行时继续由 `mergeWithRoleConstraints()` 校验关系级覆盖是否在白名单内。

### 5.2 新模型上线

通配符模式：

- 网关目录出现新 `claude-sonnet-*` 后，角色自动允许该模型。

精确型号模式：

- 新模型会出现在 ecweb 模型目录中。
- 该模型不会自动进入角色白名单。
- UI 提示“当前角色未授权此新模型”，管理员手动勾选后生效。

---

## 六、实现细节

### 6.1 白名单匹配函数

现有 `role-constraints.ts` 中有私有 `isModelAllowed()`。为避免 API 预览另写一套，建议将其导出或抽到共享模块，例如：

```typescript
export function isModelAllowedByPatterns(model: string, allowedModels: string[]): boolean {
  if (allowedModels.includes('*')) return true;
  return allowedModels.some(pattern => {
    if (pattern.endsWith('*')) return model.startsWith(pattern.slice(0, -1));
    return model === pattern;
  });
}
```

### 6.2 GatewayModel 归一化

```typescript
function normalizeGatewayModel(entry: ModelCatalogEntry): GatewayModel {
  return {
    id: entry.id,
    owned_by: entry.owned_by,
    created: entry.created,
    family: inferFamily(entry.id),
    status: entry.owned_by === 'alias' ? 'alias' : 'available'
  };
}

function inferFamily(id: string): GatewayModel['family'] {
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return 'other';
}
```

### 6.3 默认模型校验

保存前必须执行：

```typescript
if (!isModelAllowedByPatterns(defaultModel, allowedModels)) {
  throw new Error('defaultModel must be included in allowedModels');
}
```

如果要允许别名作为默认模型，则需要先实现并测试 `resolveModelAlias(alias, catalog)`，再用解析后的具体模型参与白名单校验。

### 6.4 审计日志

审计日志建议作为 Phase 2 实现。首期保存接口可以先返回变更摘要；正式审计落地时应记录：

- 操作者。
- 角色。
- 旧权限配置。
- 新权限配置。
- 匹配模型数量。
- 时间戳。

---

## 七、后续扩展

### 7.1 持久化 selectionMode

如果后续需要把 `selectionMode` 写入配置，必须同时修改：

- `src/types.ts` 的 `FieldPermission`。
- `kits/schemas/roles.schema.3.json` 或升级到 `roles.schema.4.json`。
- roles 迁移逻辑。
- role definitions 保存和 reset 流程。
- 相关单元测试。

### 7.2 别名解析到最新模型

当前模型目录能展示别名，但“别名自动解析到最新具体型号”需要额外实现：

- 定义版本排序规则。
- 处理日期型、语义版本型、网关自定义命名。
- 明确没有可用模型时的回退策略。
- 在 runner 使用模型前执行解析。

### 7.3 真实缓存和刷新

如需 `refresh=true`：

- `getCatalog()` 增加 TTL 缓存。
- API 支持 bypass cache。
- 响应返回真实 `cached`、`lastUpdate`。
- 失败时返回最近一次可用缓存，并标记 stale。
