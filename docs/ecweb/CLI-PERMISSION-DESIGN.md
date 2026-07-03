### 6. 数据流设计

#### 6.1 数据流向

```
┌─────────────────────────────────────────────────────────────────┐
│                         数据流向                                  │
└─────────────────────────────────────────────────────────────────┘

1. 读取流程
   ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
   │  前端页面     │─────>│   API 层      │─────>│ 后端配置     │
   │ PermissionsPage│ GET │ /api/role-   │      │ roles.json   │
   └──────────────┘      │  definitions  │      └──────────────┘
                         └──────────────┘

2. 写入流程
   ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
   │  编辑对话框   │─────>│   API 层      │─────>│ ConfigManager│
   │ PermissionModal│ PUT │ /api/role-   │      │ writeRoles() │
   └──────────────┘      │  definitions  │      └──────────────┘
                         └──────────────┘

3. WebSocket 推送
   ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
   │  后端监听     │─────>│  WS 推送      │─────>│  前端更新    │
   │ roles.json   │ 2s轮询│ roleDefinitions│     │  自动刷新    │
   └──────────────┘      └──────────────┘      └──────────────┘
```

#### 6.2 权限匹配优先级

```typescript
// 权限匹配顺序（从高到低）
function getPermissionForOperation(operation: string, permissions: RoleCommandPermissions) {
  // 1. 精确匹配：relation:read
  if (permissions[operation]) {
    return permissions[operation];
  }

  // 2. 命名空间通配符：relation:*
  const namespace = operation.split(':')[0];
  if (permissions[`${namespace}:*`]) {
    return permissions[`${namespace}:*`];
  }

  // 3. 类别匹配：relation
  if (permissions[namespace]) {
    return permissions[namespace];
  }

  // 4. 全局通配符：*
  if (permissions['*']) {
    return permissions['*'];
  }

  // 5. 默认：不允许
  return { allow: false };
}
```

#### 6.3 示例权限配置

```json
{
  "$schema_version": 4,
  "roles": {
    "admin": {
      "description": "管理员角色",
      "allowAccess": true,
      "permissions": {
        "baseagents.claude.model": {
          "default": "claude-sonnet-4",
          "allowOverride": true,
          "allowedModels": ["claude-opus-*", "claude-sonnet-*"]
        }
      },
      "commandPermissions": {
        // 关系管理：允许读取，写入需要控制通道
        "relation:read": {
          "allow": true,
          "scopes": ["relation"],
          "constraints": {
            "ownPeerOnly": true
          }
        },
        "relation:write": {
          "allow": true,
          "dangerous": true,
          "scopes": ["relation"],
          "reason": "管理员可修改关系配置，需通过控制通道",
          "constraints": {
            "ownPeerOnly": true,
            "requireControlChannel": true,
            "allowedConfigKeys": ["model", "dispatch", "chatmode"]
          }
        },
        "relation:delete": {
          "allow": false,
          "dangerous": true,
          "reason": "管理员不允许删除关系"
        },

        // 角色管理：仅查看
        "role:read": {
          "allow": true,
          "scopes": ["role"]
        },
        "role:*": {
          "allow": false,
          "dangerous": true,
          "reason": "管理员不能修改角色定义"
        },

        // Agent 管理：仅自己的
        "agent:*": {
          "allow": true,
          "scopes": ["agent"],
          "constraints": {
            "ownAgentOnly": true
          }
        },

        // 文件系统：受限访问
        "filesystem:read": {
          "allow": true,
          "scopes": ["filesystem"],
          "constraints": {
            "cwdPolicy": "agentProject",
            "allowedPrefixes": [".evolclaw/", "data/"],
            "outputLimitBytes": 1048576
          }
        },
        "filesystem:write": {
          "allow": false,
          "dangerous": true,
          "reason": "管理员不允许写入文件"
        },

        // 原始 CLI：完全禁止
        "raw-cli": {
          "allow": false,
          "dangerous": true,
          "scopes": ["raw-cli"],
          "reason": "管理员不允许执行原始 CLI 命令"
        }
      }
    }
  }
}
```

### 7. 实施步骤

#### Phase 1: 基础设施（1-2 天）

**任务清单：**
- [x] 创建类型定义 `cli-permissions.ts`
- [x] 创建设计文档 `CLI-PERMISSION-DESIGN.md`
- [ ] 添加 API 测试用例
- [ ] 验证数据结构兼容性

**验收标准：**
- 类型定义完整且与后端 schema 一致
- 所有常量定义清晰

#### Phase 2: 组件开发（3-4 天）

**任务清单：**
- [x] `CliPermissionTabs` - Tab 分类组件
- [x] `CommandPermissionList` - 命令列表组件
- [ ] `CommandPermissionModal` - 编辑对话框
- [ ] `ConstraintForm` - 约束条件表单
- [ ] 组件单元测试

**验收标准：**
- 7 个 Tab 正确分类展示
- 命令列表可正确显示权限状态
- 编辑功能完整且验证正确

#### Phase 3: 集成测试（2 天）

**任务清单：**
- [ ] 集成到角色管理页面
- [ ] E2E 测试流程
- [ ] 权限匹配逻辑测试
- [ ] WebSocket 实时更新测试

**验收标准：**
- 完整流程可用
- 实时更新正常工作
- 边界情况处理正确

#### Phase 4: 优化和文档（1 天）

**任务清单：**
- [ ] 性能优化（大量命令时的渲染）
- [ ] 用户体验优化
- [ ] 补充使用文档
- [ ] 添加在线帮助

**验收标准：**
- 渲染性能良好（1000+ 命令）
- 用户操作流畅
- 文档完整

### 8. 技术要点

#### 8.1 性能优化

```typescript
// 使用虚拟滚动处理大量命令
import { List } from 'react-virtualized';

// 使用 memo 避免不必要的重渲染
export const CommandPermissionItem = React.memo(({ operation, permission }) => {
  // ...
});

// 使用 useMemo 缓存分组结果
const groupedOperations = useMemo(() => {
  return groupByScope(operations);
}, [operations]);
```

#### 8.2 权限验证

```typescript
// 前端验证（用户体验）
function validatePermission(permission: CommandPermission): string[] {
  const errors: string[] = [];

  if (permission.allow && permission.dangerous && !permission.constraints?.requireExplicitDangerousGrant) {
    errors.push('危险操作建议添加显式授权约束');
  }

  if (permission.constraints?.privateOnly && permission.constraints?.groupOnly) {
    errors.push('不能同时要求私聊和群组');
  }

  return errors;
}

// 后端验证（安全保障）
// 见 role-definitions.ts:validateCommandPermissions
```

#### 8.3 实时更新

```typescript
// WebSocket 订阅
useEffect(() => {
  const ws = new WebSocket('ws://localhost:3000/ws');
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.kind === 'roleDefinitions') {
      setPermissions(data.roles[roleName]?.commandPermissions || {});
    }
  };

  return () => ws.close();
}, [roleName]);
```

### 9. 常见问题

**Q1: 为什么按 scope 分 Tab 而不是按命名空间？**

A: scope 是语义化的功能分类（如"关系管理"、"文件系统"），比命名空间更直观。一个命令可能跨多个 scope，但用户理解起来更容易。

**Q2: 如何处理通配符权限？**

A: 通配符权限（如 `relation:*`）在列表中单独显示，并标明"影响 X 个命令"。用户可以看到哪些命令会被通配符覆盖。

**Q3: 约束条件太多，如何简化界面？**

A: 使用分组和折叠：
- 常用约束（ownPeerOnly, privateOnly）默认展开
- 高级约束（allowedArgs, deniedArgs）折叠显示
- 提供"快速模板"功能

**Q4: 如何处理角色继承？**

A: 当前设计不支持角色继承。如需实现，建议：
- 在 UI 中显示"继承自"信息
- 被继承的权限标记为"不可修改"
- 允许覆盖继承的权限

### 10. 后续优化方向

1. **权限模板**
   - 预设常见权限组合（只读、读写、管理员）
   - 一键应用模板

2. **批量操作**
   - 批量允许/禁止某类命令
   - 批量设置约束条件

3. **权限对比**
   - 对比两个角色的权限差异
   - 显示权限升级/降级建议

4. **权限影响分析**
   - 显示某个权限影响的用户数
   - 显示权限变更的风险评估

5. **操作日志**
   - 记录谁在何时修改了哪些权限
   - 支持回滚到历史版本

---

**文档维护**: Claude (Opus 4.8)  
**创建日期**: 2026-07-03  
**最后更新**: 2026-07-03
