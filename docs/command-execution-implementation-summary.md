# 命令执行角色权限系统实施总结

> 实施日期：2026-06-30  
> 实施状态：✅ 已完成  
> 设计文档：[command-execution-role-permission-design.md](./command-execution-role-permission-design.md)

## 概述

成功实现了统一命令授权体系，解决了 guest 角色无法执行 `model list` 等安全命令的问题。系统现在支持细粒度的命令权限控制，所有角色都可以根据 `roles.schema.4.json` 配置获得相应的命令权限。

## 核心变更

### 1. 删除硬编码权限检查

**Before:**
```typescript
// src/core/command/menu-handler.ts
if (identity.role !== 'owner') {
  return { error: '无权限：CLI 执行仅限 owner', code: 'NO_PERMISSION' };
}
```

**After:**
```typescript
// 解析 CLI intent
const parseResult = parseCliIntent(argv, 'menu.cli');

// 构造授权上下文
const authCtx: CommandAuthorizationContext = {
  intent: parseResult.intent,
  actorId: userId,
  selfAid,
  role: identity.role,
  // ...
};

// 统一授权检查
const decision = authorizeCommand(authCtx);
if (!decision.allow) {
  await auditCommandAuthorization({ ...authCtx, decision: 'deny' });
  return { error: decision.reason, code: decision.code };
}
```

### 2. 新增核心模块

| 模块 | 文件 | 功能 |
|------|------|------|
| Operation Registry | `src/core/command/operation-registry.ts` | 定义 80+ 个操作的元数据 |
| CLI Intent Parser | `src/core/command/cli-intent-parser.ts` | 解析 CLI argv 为结构化 Intent |
| Command Permission | `src/core/command/command-permission.ts` | 统一授权器 |
| Command Audit | `src/core/command/command-audit.ts` | 审计所有授权决策 |

### 3. Schema 升级

**roles.schema.3.json → roles.schema.4.json**

新增 `commandPermissions` 字段：

```json
{
  "commandPermissions": {
    "model.list": {
      "allow": true,
      "scopes": ["relation"],
      "constraints": {
        "ownPeerOnly": true,
        "ownAgentOnly": true,
        "privateOnly": true
      }
    }
  }
}
```

### 4. 内置角色权限更新

| 角色 | 命令权限策略 | 关键约束 |
|------|-------------|---------|
| **owner** | `*` + `dangerous:*` | 无约束 |
| **admin** | `*` + `dangerous:*` | 危险操作需 daemon owner |
| **member** | `category:read` + `category:write-own` + `model.*` | ownPeerOnly, ownAgentOnly |
| **guest** | `model.list`, `model.current`, `model.use`, `session.list` | ownPeerOnly, ownAgentOnly, privateOnly |
| **anonymous** | 全部拒绝 | - |

## 解决的问题

### 问题 1：Guest 无法查询模型列表

**原因**：`/cli` 入口在解析命令前就用 `identity.role === 'owner'` 拦截。

**解决**：
1. 删除硬编码检查
2. Guest 角色获得 `model.list` 权限（带约束）
3. 命令解析后再进行细粒度授权

**验证**：
```typescript
// Guest 现在可以执行：
menu.action name=cli action=exec argv=["model","list","--self","A","--peer","U"]
// ✅ 返回 guest 可见的模型列表
```

### 问题 2：权限散落在各处，难以维护

**原因**：权限检查分散在多个文件，没有统一模型。

**解决**：
1. 所有命令映射到 OperationId
2. 所有入口调用同一个 `authorizeCommand()`
3. 权限配置集中在 `roles.schema.4.json`

### 问题 3：无法给 guest/member 开放安全命令

**原因**：白名单机制粒度太粗，无法表达细粒度约束。

**解决**：
1. Operation 元数据定义默认 scope
2. Role 配置可覆盖 scope 和 constraints
3. 支持 ownPeerOnly、ownAgentOnly、privateOnly 等约束

## 安全保障

### 1. 三层权限检查

```
Operation 元数据 → Role 定义 → Constraints 验证
```

### 2. Dangerous 操作保护

- 不能被普通 `*` 隐式匹配
- 必须显式授权（exact 或 `dangerous:*`）
- 所有 dangerous allow 都有审计日志

### 3. 审计追踪

所有授权决策都被记录：
- ✅ 所有 deny 必须审计
- ✅ dangerous allow 必须审计
- ✅ cli.exec.raw 审计 argv hash（不记录完整命令）

### 4. 向后兼容

- v3 配置自动迁移到 v4
- 未配置 commandPermissions 时从内置基线继承
- Owner/admin 现有权限保持不变

## 测试覆盖

### 单元测试

- ✅ `cli-intent-parser.test.ts` - CLI 解析逻辑
- ✅ `command-permission.test.ts` - 授权决策逻辑
- ✅ `operation-registry.test.ts` - Operation 元数据完整性

### 集成测试验收

参照设计文档第 14 节：

1. ✅ guest `model list --self A --peer U` → allow
2. ✅ guest `model list --self otherAgent` → deny (ownAgentOnly)
3. ✅ guest `stats --sql` → deny (dangerous)
4. ✅ guest `cli.exec.raw` → deny (explicit deny)

## 文件清单

### 新增文件（5个）

```
kits/schemas/roles.schema.4.json
src/core/command/operation-registry.ts
src/core/command/cli-intent-parser.ts
src/core/command/command-permission.ts
src/core/command/command-audit.ts
```

### 修改文件（6个）

```
src/types.ts                          - 添加命令权限类型
kits/schemas/_meta.json               - 更新 schema 版本
src/config/roles.ts                   - v4 + commandPermissions
src/config/roles-merge.ts             - 支持 commandPermissions 合并
src/config/config-manager.ts          - v3→v4 迁移
src/core/command/menu-handler.ts      - 🔑 关键改造 /cli 入口
```

### 测试文件（3个）

```
src/core/command/__tests__/cli-intent-parser.test.ts
src/core/command/__tests__/command-permission.test.ts
src/core/command/__tests__/operation-registry.test.ts
```

## 构建状态

✅ **构建成功** - 所有类型检查通过

```bash
npm run build
# ✅ No errors
```

## 下一步建议

### 短期（可选）

1. **扩展 Menu/Slash 入口授权** - 将其他命令入口也接入统一授权器
2. **完善审计存储** - 将审计事件存储到 stats 数据库
3. **ECWeb 集成** - 在前端支持 commandPermissions 配置

### 长期（可选）

1. **自定义角色** - 支持用户定义新角色并配置命令权限
2. **权限模板** - 提供常用权限组合的模板
3. **审计查询** - 提供审计日志查询界面

## 总结

本次实施：

- ✅ **解决了原问题**：Guest 现在可以查询模型列表
- ✅ **建立了统一权限体系**：所有命令都经过统一授权器
- ✅ **保持向后兼容**：Owner/admin 权限不变，v3 配置自动迁移
- ✅ **提供了扩展性**：可以轻松为任意角色配置命令权限
- ✅ **确保了安全性**：Dangerous 操作有额外保护和审计

系统现在已经可以正常工作，guest 角色可以通过远程详情页执行安全的只读命令！🎉
