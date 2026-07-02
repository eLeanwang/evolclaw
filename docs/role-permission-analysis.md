# Evolclaw 对端 Agent 角色权限分析报告

**生成时间**: 2026-06-26  
**分析范围**: 角色权限配置、解析、约束、使用全链路

---

## 一、角色权限体系概览

### 1.1 五种内置角色

| 角色 | 权限模式 | 模型限制 | 描述 |
|------|---------|---------|------|
| **owner** | bypass | 任意模型（*） | 所有者，完全控制权限 |
| **admin** | request | claude-opus/sonnet/haiku-* | 管理员，需确认操作 |
| **member** | auto | claude-sonnet/haiku-* | 团队成员，基本使用权限 |
| **guest** | readonly | claude-haiku-* | 访客，只读权限 |
| **anonymous** | readonly | claude-haiku-* | 匿名，完全未认证 |

**代码位置**: `src/config/roles.ts:77-338`

### 1.2 角色配置的三层存储结构

```
┌─────────────────────────────────────────────────────┐
│ 全局层 (Global)                                      │
│ roles.json - 内置角色定义和默认配置                    │
│ 位置: src/config/roles.ts (getBuiltinRolesConfig)   │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│ Agent层                                              │
│ agents/<aid>/config.json                            │
│ - owners: string[]      ← 所有者AID列表              │
│ - admins: string[]      ← 管理员AID列表              │
│ - members: string[]     ← 成员AID列表                │
│ - roles: {...}          ← 角色级行为覆盖（内嵌）     │
└─────────────────────────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────┐
│ Relation层 (关系级)                                  │
│ agents/<aid>/relations/<peerKey>/config.json        │
│ - role: string          ← 单个字段，覆盖角色         │
│ - baseagents: {...}     ← 具体配置覆盖               │
│ - permissionMode: ...   ← 权限模式覆盖               │
└─────────────────────────────────────────────────────┘
```

---

## 二、角色解析逻辑

### 2.1 解析优先级（从高到低）

**代码位置**: `src/config/role-resolver.ts:42-93`

```
1. config.owners[] 列表     → 'owner'
2. config.admins[] 列表     → 'admin'
3. config.members[] 列表    → 'member'
4. relation-config.role     → 任意角色（包括降级）
5. 已认证但未授权           → 'guest'
6. 未认证                   → 'anonymous' (defaultRole)
```

**关键代码**:
```typescript
// 优先级: owners > admins > members > relation.role > guest > anonymous
if (config.owners?.includes(peerId)) return 'owner';
if (config.admins?.includes(peerId)) return 'admin';
if (config.members?.includes(peerId)) return 'member';
const relationRole = readRelationRole(self, peerKey, peerId);
if (relationRole) return relationRole;
if (isAuthenticated(peerId)) return 'guest';
return getDefaultRole(); // 'anonymous'
```

### 2.2 配置参数解析链

**代码位置**: `src/core/model/config-scope.ts`

不同参数有不同的解析链：

| 参数 | 解析链 | 兜底值 |
|------|--------|--------|
| **model/effort** | 关系 > 角色(roles[role]) > agent > 全局 | undefined |
| **permissionMode** | 关系 > 角色(roles[role]) > 内置映射 | 'auto' |
| **show_activities** | 关系 > agent > 全局（跳过角色） | 'all' |
| **chatmode** | 关系 > agent > 全局（群聊强制proactive） | 'interactive' |
| **dispatch** | 关系 > agent > 全局 | 服务器下发 |

---

## 三、当前设计中的混淆点

### 3.1 ⚠️ 两套角色分配机制并存

**问题**: Agent层和Relation层使用了不同的角色分配方式，容易混淆。

#### 方式一: 列表式（Agent层）
```json
{
  "owners": ["alice.aid.pub", "bob.agentid.pub"],
  "admins": ["charlie.aid.pub"],
  "members": ["dave.aid.pub"]
}
```
- ✅ 优点: 批量管理，清晰
- ❌ 缺点: 只支持三种角色（owner/admin/member）

#### 方式二: 字段式（Relation层）
```json
// agents/xxx/relations/aun#peer.aid.pub/config.json
{
  "role": "guest"
}
```
- ✅ 优点: 可以设置任意角色，包括降级
- ❌ 缺点: 优先级**低于**列表式，可能被覆盖

**混淆场景**:
```
假设 alice.aid.pub 在 config.owners 列表中，
但你在 relation config 里设置了 role: "guest"，
实际解析时仍然是 'owner'，因为列表优先级更高！
```

### 3.2 ⚠️ 角色约束应用时机不一致

**代码位置**: `src/core/model/config-scope.ts:230-246`

在 `resolvePermissionMode` 中会应用角色约束：

```typescript
// 1. 先读关系级 permissionMode
if (relation.permissionMode) {
  // 2. 应用角色约束（这里会重新解析角色或使用 sel.role）
  const role = sel.role || resolveUserRole(sel.self, sel.peerKey);
  const constrained = mergeWithRoleConstraints(role, {
    permissionMode: relation.permissionMode
  });
  return constrained.effectiveConfig.permissionMode;
}
```

**问题**:
- 如果传入 `sel.role`，会用传入的角色
- 如果没传，会重新调用 `resolveUserRole` 解析
- 但**其他地方调用时不一定都传 `sel.role`**，可能导致：
  - 同一个对端在不同地方解析出不同的角色
  - 群聊场景下，同一个群成员可能被当作不同角色

### 3.3 ⚠️ roles[role] 内嵌配置的作用范围不明确

**代码位置**: `agents/<aid>/config.json` 的 `roles` 块

```json
{
  "roles": {
    "owner": {
      "baseagents": { "claude": { "model": "opus" } },
      "permissionMode": "bypass"
    },
    "guest": {
      "baseagents": { "claude": { "model": "haiku" } },
      "permissionMode": "readonly"
    }
  }
}
```

**问题**:
- 这个 `roles` 块是**每个agent自己定义**的角色行为覆盖
- 但它会被 `resolveEffectiveModel` / `resolvePermissionMode` 在解析链中使用
- **容易与全局的 roles.json 混淆**，不清楚优先级

**实际行为**:
```
解析链: 关系级 > agent的roles[role]块 > 全局roles.json内置定义
```

### 3.4 ⚠️ Relation-level role 字段的设计缺陷

**schema位置**: `kits/schemas/relation-config.schema.1.json:18-22`

```json
{
  "role": {
    "type": "string",
    "description": "Relation-level role override for this peer",
    "x-merge": "scalar"
  }
}
```

**问题**:
1. **优先级倒挂**: 列表式（owners/admins/members）优先级更高，导致 relation.role 可能不生效
2. **缺少验证**: schema 只定义为 `string`，没有 enum 约束，可以写任意值
3. **语义混淆**: 
   - `relation.role` 看起来是"给这个对端分配角色"
   - 但实际上**只有在列表里找不到时才会用**
   - 用户可能以为设置了就生效，实际不是

---

## 四、使用检查清单

### 4.1 角色分配的正确方式

#### ✅ 推荐: 使用列表式管理核心角色
```json
// agents/my-agent.aid.pub/config.json
{
  "owners": ["alice.aid.pub"],
  "admins": ["bob.aid.pub", "charlie.aid.pub"],
  "members": ["dave.aid.pub", "eve.aid.pub"]
}
```

#### ⚠️ 慎用: Relation-level role 仅用于特殊降级
```json
// agents/my-agent/relations/aun#special.aid.pub/config.json
{
  "role": "anonymous"  // 临时封禁某个用户
}
```
**注意**: 只有当该用户**不在任何列表中**时才生效！

### 4.2 权限约束的正确理解

每个角色的 `permissions` 定义中有两个关键字段：

#### `allowOverride`: 是否允许用户覆盖

```json
{
  "permissionMode": {
    "default": "bypass",
    "allowOverride": false,  // ← owner 的 permissionMode 不可降级
    "reason": "所有者权限不可降级"
  }
}
```

#### `allowedModels`: 模型白名单

```json
{
  "baseagents.claude.model": {
    "default": "claude-sonnet-4-6",
    "allowedModels": ["claude-sonnet-*", "claude-haiku-*"],  // ← 支持通配符
    "reason": "成员可使用中低成本模型"
  }
}
```

**约束检查代码**: `src/config/role-constraints.ts:22-151`

### 4.3 常见错误示例

#### ❌ 错误1: 期望 relation.role 覆盖列表
```json
// config.json
{ "owners": ["alice.aid.pub"] }

// relations/aun#alice.aid.pub/config.json
{ "role": "guest" }  // ← 不会生效！alice 仍是 owner
```

#### ❌ 错误2: 没有传递 sel.role 导致重复解析
```typescript
// 某处代码
const mode1 = resolvePermissionMode({ self, peerKey, role: 'owner' });
// 另一处代码
const mode2 = resolvePermissionMode({ self, peerKey }); // ← 会重新解析角色
// mode1 和 mode2 可能不一致！
```

#### ❌ 错误3: 修改 relation config 期望立即生效
```json
// 修改了 relation config
{ "role": "member" }
```
但如果该用户在 `owners` 列表中，仍然会被解析为 `owner`，需要**从列表中移除**才行。

---

## 五、改进建议

### 5.1 统一角色分配机制

**建议**: 废弃 `relation.role` 字段，统一使用列表式管理。

**理由**:
- 列表式优先级更高，relation.role 形同虚设
- 两套机制并存容易混淆
- 临时降级可以通过从列表中移除实现

**或者**: 调整优先级，让 relation.role 优先级最高（但这会破坏现有逻辑）

### 5.2 明确 sel.role 的传递规则

**建议**: 在所有调用 `resolvePermissionMode` / `resolveEffectiveModel` 的地方，统一传递 `sel.role`。

**改进点**:
```typescript
// 在消息处理的入口统一解析角色
const role = resolveUserRole(self, peerKey);

// 后续所有地方都传递这个角色，避免重复解析
const mode = resolvePermissionMode({ self, peerKey, role });
const model = resolveEffectiveModel({ self, peerKey, role }, 'claude');
```

### 5.3 增强 relation.role 的验证

如果保留 `relation.role` 字段，建议：

```json
// relation-config.schema.json
{
  "role": {
    "type": "string",
    "enum": ["owner", "admin", "member", "guest", "anonymous"],
    "description": "⚠️ 优先级低于 config.owners/admins/members 列表"
  }
}
```

### 5.4 文档化优先级规则

在 `ROLE_ACCESS_CONTROL.md` 或 config 文档中明确说明：

```markdown
## 角色分配优先级（重要！）

1. config.owners[] 列表（最高）
2. config.admins[] 列表
3. config.members[] 列表
4. relation-config.role 字段（仅在不在以上列表时生效）
5. 认证状态判断（guest vs anonymous）

⚠️ 如果用户在 owners/admins/members 列表中，
   设置 relation.role 不会改变其角色！
```

---

## 六、总结

### 当前状态

✅ **设计得好的部分**:
- 五种内置角色定义清晰
- 角色约束机制完善（allowOverride, allowedModels）
- 配置参数解析链设计合理

⚠️ **混乱的部分**:
1. **两套角色分配机制**并存（列表式 vs 字段式），优先级不直观
2. **sel.role 传递不一致**，可能导致同一对端在不同地方解析出不同角色
3. **relation.role 优先级倒挂**，容易误用
4. **agent的roles块与全局roles.json**的关系不够明确

### 核心问题

**最大的混淆点**: 用户可能以为在 `relation config` 里设置了 `role: "guest"`，这个对端就会被当作 guest，但如果这个对端在 `owners` 列表中，实际仍然是 owner。

**建议行动**:
1. 短期: 在文档中明确说明优先级规则，避免误用
2. 中期: 统一 sel.role 的传递，避免重复解析
3. 长期: 考虑废弃 relation.role 或调整优先级，统一为一套机制

---

**生成工具**: Claude Code (Opus 4.8)
