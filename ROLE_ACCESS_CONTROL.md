# 角色访问控制功能实现总结

## 新增功能

### 1. 默认角色 (defaultRole)
- **位置**: 全局配置 (`roles.json` 顶层字段)
- **默认值**: `'anonymous'`
- **语义**: 对端 AID 首次访问时，若不在 `owners/admins/members` 名单中，使用此角色作为兜底
- **UI**: ecweb 角色定义页面顶部下拉选择器，change 时自动保存

### 2. 是否允许访问 (allowAccess)
- **位置**: 每个角色定义的顶层字段 (与 `description`/`permissions` 同级)
- **默认值**:
  - `anonymous`: `false` (拒绝访问)
  - 其他角色 (`owner/admin/member/guest`): `true` (允许访问)
- **语义**: 当角色的 `allowAccess=false` 时，该角色用户访问 agent 会被直接拦截
- **拦截行为**: 返回系统错误消息 "暂无权限访问本 agent，请联系 agent 管理员授权访问"
- **UI**: ecweb 角色编辑/新建弹窗中，描述下方的下拉选择器 (允许 true / 拒绝 false)

## 实现架构

### Backend 改动

#### 1. Schema 升级 (v1 → v2)
- `kits/schemas/roles.schema.2.json` — 新增 `defaultRole` (top-level) 和 `allowAccess` (per-role)
- `kits/schemas/_meta.json` — currentVersion 更新为 2
- **迁移逻辑** (`src/config/config-manager.ts`):
  - `migrateRolesV1toV2()` — 直接升版本号，新字段由 merge 时从 builtin 补全 (overlay 模式)

#### 2. 类型定义 (`src/types.ts`)
```typescript
export interface RolesConfig {
  $schema_version: number;
  defaultRole?: string;  // 新增
  roles: Record<string, RoleDefinition>;
}

export interface RoleDefinition {
  description: string;
  allowAccess?: boolean;  // 新增
  permissions: Record<string, FieldPermission>;
}
```

#### 3. 内置配置 (`src/config/roles.ts`)
- `getBuiltinRolesConfig()` 升级为 `$schema_version: 2`
- 添加 `defaultRole: 'anonymous'`
- 每个角色添加 `allowAccess` 字段 (owner/admin/member/guest 为 `true`, anonymous 为 `false`)

#### 4. 角色解析器 (`src/config/role-resolver.ts`)
- `resolveUserRole()` 返回类型改为 `string` (支持自定义角色名)
- 移除 `isAuthenticated()` 判断，改为直接使用 `getDefaultRole()` 作为兜底
- **新增** `getDefaultRole()` — 从 roles.json 读取 `defaultRole` 字段
- **新增** `checkRoleAccess(role: string): boolean` — 读取该角色的 `allowAccess` 配置

#### 5. 合并/Diff 逻辑 (`src/config/roles-merge.ts`)
- `mergeRolesConfig()` — 合并 `defaultRole` (overlay 优先) 和每个角色的 `allowAccess`
- `diffRolesConfig()` — 比对 `defaultRole` 和 `allowAccess`，仅写入改动

#### 6. 访问控制拦截 (`src/core/message/response-engine.ts`)
- `processMessage()` 入口处，在 `resolveSession()` 之后立即检查
- 调用 `checkRoleAccess(userRole)`，为 `false` 时:
  1. 记录 warn 日志
  2. 通过 `adapter.send()` 回复 `system.error` 类型消息
  3. `return` 终止处理，不进入后续流程

### Frontend 改动 (ecweb)

#### 1. HTML 结构 (`ecweb/src/static/index.html`)
- 新增 `.role-default-selector` 区块 (在 header 和 grid 之间)
- 包含 `<select id="default-role-select">` 和提示文案

#### 2. JavaScript (`ecweb/src/static/app.js`)
- `renderRoleDefinitions()` — 调用 `renderDefaultRoleSelector(data)` 填充下拉框
- **新增** `renderDefaultRoleSelector()`:
  - 填充所有角色为选项
  - 绑定 `onchange` 事件 → 读取完整配置 → 更新 `defaultRole` → PUT 写回
- `showRoleEditModal()` / `showNewRoleModal()` — 在 description 后添加 `allowAccess` 下拉
- `saveRoleEdit()` — 收集 `allowAccess` 值 (转为真布尔), 写入 `updates` 对象

#### 3. CSS (`ecweb/src/static/style.css`)
- 新增 `.role-default-selector` / `.role-default-label` 样式
- 原有按钮样式已是黑边框黑字 (`var(--fg)` / `var(--border)`)，无需修改

## 配置示例

### roles.json (用户 overlay)
```json
{
  "$schema_version": 2,
  "defaultRole": "guest",
  "roles": {
    "anonymous": {
      "description": "匿名用户，完全未认证，极度受限",
      "allowAccess": false
    },
    "guest": {
      "description": "访客，只读权限，有身份但未授权",
      "allowAccess": true
    }
  }
}
```

### 内置基线 (builtin)
```javascript
{
  $schema_version: 2,
  defaultRole: 'anonymous',
  roles: {
    owner: { allowAccess: true, ... },
    admin: { allowAccess: true, ... },
    member: { allowAccess: true, ... },
    guest: { allowAccess: true, ... },
    anonymous: { allowAccess: false, ... }
  }
}
```

## 升级路径

1. **v1 → v2 自动迁移**:
   - 读取 v1 roles.json 时，`migrateRolesV1toV2()` 自动升版本号
   - `defaultRole` 和 `allowAccess` 字段从 builtin 继承 (overlay 为空时)
   - 原有用户改动 (permissions/description) 完整保留

2. **向后兼容**:
   - `defaultRole` 缺失时默认 `'anonymous'` (原有行为)
   - `allowAccess` 缺失时默认 `true` (除 anonymous 为 `false`)
   - 旧代码不读这两个字段时，功能降级但不报错

## 测试要点

1. **默认角色生效**:
   - 清空某 agent 的 owners/admins/members
   - 对端 AID 访问时，角色应为 `roles.json` 中的 `defaultRole`

2. **访问控制拦截**:
   - 设置某角色 `allowAccess: false`
   - 将用户加入该角色 (如 guest)
   - 用户访问时应收到 "暂无权限" 系统错误，后续流程不触发

3. **ecweb UI**:
   - 默认角色下拉能正常切换并保存
   - 编辑角色时，`allowAccess` 下拉能正确读取/保存
   - 保存按钮为黑边框黑字 (非白色)

4. **Schema 迁移**:
   - 备份旧 roles.json (v1)
   - 启动新版本，读取时自动升级为 v2
   - 原有改动不丢失，新字段从 builtin 补全

## 文件清单

### Backend
- `kits/schemas/roles.schema.2.json` (新增)
- `kits/schemas/_meta.json` (修改 - 版本号)
- `src/types.ts` (修改 - RolesConfig/RoleDefinition)
- `src/config/roles.ts` (修改 - builtin 配置)
- `src/config/role-resolver.ts` (修改 - 添加 checkRoleAccess)
- `src/config/roles-merge.ts` (修改 - merge/diff 逻辑)
- `src/config/config-manager.ts` (修改 - 迁移函数)
- `src/core/message/response-engine.ts` (修改 - 访问拦截)

### Frontend (ecweb)
- `ecweb/src/static/index.html` (修改 - 默认角色选择器)
- `ecweb/src/static/app.js` (修改 - render/save 逻辑)
- `ecweb/src/static/style.css` (修改 - 样式)

---

**实现完成时间**: 2026-06-25  
**Schema 版本**: roles v2  
**向后兼容**: ✅ (v1 自动迁移，字段缺失时使用默认值)
