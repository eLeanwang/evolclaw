# role-model-sync.ts 重构任务

> **负责人**: @liwenjiang  
> **优先级**: 中  
> **状态**: 待处理  
> **创建时间**: 2026-07-07

---

## 背景

在对齐 v3 配置设计（去除 behavior.json）的过程中，`src/config/role-model-sync.ts` 文件因为引用了已删除的 `behavior.js` 模块而无法编译。

该文件是角色系统的一部分（由 liwenjiang 开发），当前已创建临时存根让代码编译通过，但功能被禁用。

---

## 当前状态

### 文件位置
- **存根文件**: `src/config/role-model-sync.ts` (当前使用)
- **原始文件**: `src/config/role-model-sync.ts.original` (备份)

### 存根内容
```typescript
// TODO: 此文件是角色系统文件，在 5eda64a (v3设计) 中不存在
// 需要重构以对齐 v3 设计（去除 behavior.json）
// 暂时创建存根让代码编译通过

export interface RoleModelSyncResult {
  scannedAgents: number;
  scannedAssignments: number;
  updatedRelations: number;
}

export function syncNoOverrideRoleModelsForAllAgents(): RoleModelSyncResult {
  console.warn('[role-model-sync] 此功能暂时禁用，需要对齐 v3 设计');
  return { scannedAgents: 0, scannedAssignments: 0, updatedRelations: 0 };
}

export function syncNoOverrideRoleModelsForAgent(): RoleModelSyncResult {
  console.warn('[role-model-sync] 此功能暂时禁用，需要对齐 v3 设计');
  return { scannedAgents: 0, scannedAssignments: 0, updatedRelations: 0 };
}

export function normalizeRelationBehaviorForAssignedRole(
  aid: string,
  peerKey: string,
  value: any,
  roles: RolesConfig | null
): any {
  return value;
}
```

---

## v3 设计原则（必须遵守）

### 核心原则
1. **所有参数统一在 config.json**
   - 不再有 `behavior.json`
   - agent 级配置：`agents/{aid}/config.json`
   - relation 级配置：`agents/{aid}/relations/{peerKey}/config.json`

2. **配置覆盖链**
   ```
   defaults.json → agent/config.json → relation/config.json
   ```

3. **权限控制在 API 层**
   - 不在文件级区分权限
   - 通过 Hook 和 API 层控制访问

### 文件结构
```
agents/{aid}/
├── config.json              ← 所有参数（包括原来的 behavior 参数）
├── role-assignments.json    ← 角色分配
└── relations/{peerKey}/
    └── config.json          ← 关系级配置（所有参数）
```

---

## 问题分析

### 原始代码的问题
原始 `role-model-sync.ts` 文件：

1. **引用已删除的模块**
   ```typescript
   import type { BehaviorConfig } from './behavior.js';
   import { agentRelationBehaviorConfig } from '../paths.js';
   ```
   - `BehaviorConfig` 类型已删除
   - `agentRelationBehaviorConfig()` 函数已删除

2. **读写 behavior.json 文件**
   ```typescript
   function readRelationBehaviorFile(aid: string, peerKey: string): BehaviorConfig | null {
     return atomicReadJson<BehaviorConfig>(agentRelationBehaviorConfig(aid, peerKey));
   }
   ```
   - v3 设计中不再有 `behavior.json`

3. **依赖 behavior 概念**
   - 整个文件围绕 "behavior" 设计
   - 需要改为读写 `config.json`

---

## 重构要求

### 1. 替换类型引用

**删除**:
```typescript
import type { BehaviorConfig } from './behavior.js';
```

**改为**:
```typescript
import type { RelationConfig } from '../types.js';
```

### 2. 替换路径函数

**删除**:
```typescript
import { agentRelationBehaviorConfig } from '../paths.js';
```

**改为**:
```typescript
import { agentRelationConfig } from '../paths.js';
```

### 3. 修改文件读写逻辑

**原来**（错误）:
```typescript
function readRelationBehaviorFile(aid: string, peerKey: string): BehaviorConfig | null {
  return atomicReadJson<BehaviorConfig>(agentRelationBehaviorConfig(aid, peerKey));
}

function writeRelationBehaviorFile(aid: string, peerKey: string, value: BehaviorConfig): void {
  const file = agentRelationBehaviorConfig(aid, peerKey);
  const withVersion: BehaviorConfig = { ...value, $schema_version: currentVersion('behavior') };
  atomicWriteJson(file, withVersion);
}
```

**改为**（正确）:
```typescript
function readRelationConfigFile(aid: string, peerKey: string): RelationConfig | null {
  return atomicReadJson<RelationConfig>(agentRelationConfig(aid, peerKey));
}

function writeRelationConfigFile(aid: string, peerKey: string, value: RelationConfig): void {
  const file = agentRelationConfig(aid, peerKey);
  const withVersion: RelationConfig = { 
    ...value, 
    $schema_version: currentVersion('relation-config') 
  };
  atomicWriteJson(file, withVersion);
}
```

### 4. 统一配置管理

**建议**：使用 ConfigManager 统一读写配置，而不是直接操作文件

```typescript
import { read, write, ConfigTarget } from './config-manager.js';

// 读取 relation 配置
const config = read(ConfigTarget.Relation, { self: aid, peerKey });

// 写入 relation 配置
write(ConfigTarget.Relation, updatedConfig, { self: aid, peerKey });
```

---

## 实现步骤

### Step 1: 分析原始代码
1. 查看 `role-model-sync.ts.original`
2. 理解每个函数的功能和业务逻辑
3. 识别所有 `BehaviorConfig` 的使用位置

### Step 2: 重构类型和导入
1. 将所有 `BehaviorConfig` 改为 `RelationConfig` 或 `AgentConfig`
2. 替换路径函数引用
3. 确保导入正确

### Step 3: 修改读写逻辑
1. 将读写 `behavior.json` 改为读写 `config.json`
2. 使用 `ConfigTarget.Relation` 和 `ConfigTarget.Agent`
3. 更新 schema 版本引用

### Step 4: 调整业务逻辑
1. 确保角色模型同步逻辑仍然正确
2. 测试 `syncNoOverrideRoleModelsForAllAgents()`
3. 测试 `normalizeRelationBehaviorForAssignedRole()`

### Step 5: 测试验证
1. 编译通过
2. 手动测试角色权限功能
3. 确认配置文件正确读写

---

## 参考资料

### v3 设计文档
- `docs/config/01-overview.md` - v3 总体架构
- `docs/config/03-schema.md` - Schema 定义
- `docs/config/04-config-manager.md` - ConfigManager 使用

### 代码参考
- `src/config/config-manager.ts` - 统一配置管理
- `src/paths.ts` - 路径函数定义
- `src/types.ts` - RelationConfig 类型定义

### 历史版本
- **5eda64a** - v3 设计基准版本（此版本没有 role-model-sync.ts）
- **role-model-sync.ts.original** - 需要重构的原始代码

---

## 注意事项

1. **不要重新引入 behavior.json**
   - v3 设计明确去除了 behavior.json
   - 所有配置统一在 config.json

2. **使用 ConfigManager**
   - 不要直接 `atomicReadJson` / `atomicWriteJson`
   - 通过 ConfigManager 统一读写

3. **保持角色系统功能**
   - 重构后角色权限功能应保持正常
   - 不要破坏现有的角色分配逻辑

4. **测试充分**
   - 至少手动测试基本场景
   - 确保不影响其他模块

---

## 联系方式

如有疑问，请联系：
- **agentcp** - v3 设计和 behavior 清理负责人
- 查看提交记录：`git log --grep="behavior" --oneline`

---

## 完成标准

- [ ] 代码编译通过
- [ ] 不再引用 behavior.js 或 BehaviorConfig
- [ ] 使用 ConfigManager 读写配置
- [ ] 角色模型同步功能正常
- [ ] 添加必要的注释和文档
- [ ] 提交前与 agentcp 确认

---

**预计工作量**: 2-4 小时  
**截止日期**: 按项目优先级安排
