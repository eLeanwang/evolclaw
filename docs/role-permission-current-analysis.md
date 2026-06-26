# Evolclaw 角色权限体系最新分析报告

**生成时间**: 2026-06-26  
**分析对象**: 角色定义、角色分配、权限约束、运行时接入、ecweb 管理界面  
**结论摘要**: 当前角色权限体系已经具备可运行的核心能力，尤其是角色定义、字段约束、模型/权限模式解析、访问拦截和测试覆盖已经较完整；但“角色身份的唯一事实源”仍未统一，`relation.role`、`resolveUserRole()`、`SessionManager.resolveIdentity()` 和 ecweb 展示之间存在语义差异。这是后续最需要收敛的方向。

---

## 一、当前整体判断

当前实现不是半成品，已经形成了三块主要能力：

1. **全局角色定义能力**  
   通过 `roles.json` overlay + 内置默认角色，支持 `owner/admin/member/guest/anonymous` 以及自定义角色。

2. **运行时行为约束能力**  
   `permissionMode`、`baseagents.*.model`、`effort` 等行为字段会按角色权限进行约束，防止低权限用户通过关系级配置越权。

3. **消息入口访问控制能力**  
   `allowAccess=false` 的角色会在消息处理入口被拦截，不进入模型调用流程。

但当前体系还没有彻底统一：

- 角色解析有两条路径：
  - `src/config/role-resolver.ts` 的 `resolveUserRole()`
  - `src/core/session/session-manager.ts` 的 `resolveIdentity()`
- `relation.role` 在 `resolveUserRole()` 中会生效，但运行时 session identity 主要来自 `EvolAgentRegistry/EvolAgent` 的列表式判断。
- ecweb 角色分配页面会优先展示 `relation.role`，可能与运行时真实身份不完全一致。

因此当前完成度可以评价为：

> **核心能力约 70% 完成；配置解析与约束链较完善；身份解析统一性仍需重点补齐。**

---

## 二、已经做好的部分

### 2.1 内置角色体系清晰

代码位置：

- `src/config/roles.ts`
- `kits/schemas/roles.schema.2.json`
- `src/types.ts`

当前内置五种角色：

| 角色 | 默认 permissionMode | 默认访问 | 模型限制 | 说明 |
|------|--------------------|----------|----------|------|
| owner | bypass | 允许 | `*` | 所有者，最高权限 |
| admin | request | 允许 | opus/sonnet/haiku | 管理员，需要确认敏感操作 |
| member | auto | 允许 | sonnet/haiku | 普通成员 |
| guest | readonly | 允许 | haiku | 已认证但未授权用户 |
| anonymous | readonly | 拒绝 | haiku | 未认证或匿名用户 |

比较好的点：

- `roles.schema.2.json` 已支持 `defaultRole` 和 `allowAccess`。
- `roles.ts` 的内置角色定义较完整。
- `roles-merge.ts` 支持 overlay 合并和 diff 写入，避免用户配置覆盖掉内置新增字段。
- 支持自定义角色名，`resolveUserRole()` 返回类型已经是 `string`。

需要注意：

- `SessionIdentity.role` 类型仍是五种内置角色联合类型，和自定义角色能力不完全匹配。

---

### 2.2 角色约束机制已经落地

代码位置：

- `src/config/role-constraints.ts`
- `src/core/model/config-scope.ts`
- `src/config/config-manager.ts`

当前已经支持：

- `allowOverride=false` 时强制使用角色默认值。
- `allowedModels` 支持模型白名单和通配符，例如 `claude-sonnet-*`。
- `allowedValues` 支持枚举值限制。
- 未知角色会 fallback 到 `member` 级别约束。
- 关系级行为写入时会进行角色约束校验。

已经接入的位置：

- `resolvePermissionMode()` 会应用角色约束。
- `resolveEffectiveModel()` 会应用角色约束。
- `resolveEffective()` 在合并行为字段后也会应用角色约束。
- `validateConfigWrite()` 对 `RelationBehavior` 写入做约束检查。

这是当前体系中比较成熟的一块。

---

### 2.3 行为配置链已经迁到 behavior.json

代码位置：

- `src/core/model/config-scope.ts`
- `src/config/behavior.ts`
- `kits/schemas/behavior.schema.1.json`

当前实际链路是：

```text
agent behavior.json
  -> behavior.roles[role]
  -> relation behavior.json
```

旧的 `config.json` 字段仍有 fallback，但主路径已经是 HA 行为链。

这点比旧文档更清晰，也更合理：

- `config.json` 更偏身份、凭证、基础设施配置。
- `behavior.json` 更适合存模型、权限模式、chatmode、dispatch 等运行时行为配置。

需要更新旧文档中的描述，不能继续把 `model/effort/permissionMode/roles` 主要写成 `config.json` 字段。

---

### 2.4 消息入口已经接入 allowAccess 拦截

代码位置：

- `src/core/message/response-engine.ts`
- `src/config/role-resolver.ts`

当前流程：

1. `ResponseEngine.processMessage()` 先解析 session。
2. 读取 `session.identity.role`。
3. 调用 `checkRoleAccess(role)`。
4. 若 `allowAccess=false`，直接发送 `system.error` 并 return。

这是一个关键能力，说明角色已经不只是配置展示，而是实际参与了运行时安全控制。

当前表现：

- `anonymous` 内置为 `allowAccess=false`。
- owner/admin/member/guest 默认允许访问。
- 自定义角色也可以通过 `allowAccess` 控制是否可访问。

---

### 2.5 核心运行时基本传递了 sel.role

代码位置：

- `src/core/message/response-engine.ts`
- `src/core/model/config-scope.ts`

旧分析文档中提到“调用方不一定传 `sel.role`”的问题，当前核心消息链路里已经明显改善：

- `resolvePermissionMode({ self, peerKey, role: peerRole })`
- `resolveEffectiveModel({ self, peerKey, role: session.identity?.role })`
- `resolveEffective({ self, peerKey, role: peerRole })`

这说明核心运行时已经在尽量避免重复解析角色。

仍需注意：

- CLI、菜单、ecweb、测试工具等外围路径仍可能没有统一传递 role。
- 更根本的问题不是“有没有传 role”，而是这个 role 本身来自哪里。

---

### 2.6 测试覆盖比较充分

本次核对运行了角色相关测试：

```bash
npm.cmd test -- tests/roles.test.ts tests/role-resolver.test.ts tests/role-constraints.test.ts tests/config-routing.test.ts tests/role-integration.test.ts tests/role-second-fixes.test.ts tests/role-third-fixes.test.ts tests/role-fixes-verification.test.ts
```

结果：

```text
8 test files passed
143 tests passed
```

覆盖内容包括：

- 角色解析优先级。
- relation role 行为。
- 角色约束。
- permissionMode 解析。
- model/effort 解析。
- RelationBehavior 写入约束。
- 默认角色和 allowAccess 基础行为。

这是一个很好的基础，后续重构可以依赖这些测试防回归。

---

## 三、仍需完善的部分

### 3.1 最大问题：运行时身份源没有统一

这是当前最核心的问题。

现在存在两个角色解析入口：

#### 入口一：完整角色解析器

代码位置：

- `src/config/role-resolver.ts`

优先级：

```text
owners[] -> admins[] -> members[] -> relation.role -> guest/defaultRole
```

这个解析器支持：

- agent 顶层 owners/admins/members。
- relation-level role。
- guest / anonymous 兜底。
- 自定义 role。

#### 入口二：SessionManager 身份解析

代码位置：

- `src/core/session/session-manager.ts`
- `src/core/evolagent-registry.ts`
- `src/core/evolagent.ts`

运行时 session identity 的来源是：

```text
agentRegistry.isOwner()
-> agentRegistry.isAdmin()
-> agentRegistry.isMember()
-> guest
```

这个路径主要读取：

- AUN 顶层 owners/admins/members。
- 非 AUN channel instance 的 owners/admins/members。

它没有直接调用 `resolveUserRole()`，因此也不会完整应用 `relation.role` 的语义。

影响：

- `resolveUserRole()` 认为某用户是 `relation.role = anonymous`。
- 但运行时 `session.identity.role` 可能仍是 `guest`、`member`、`admin` 或 `owner`。
- `ResponseEngine` 后续访问控制、权限模式、模型约束都基于 `session.identity.role`，因此 relation role 可能没有用户预期中的全链路效果。

这个问题比旧文档提到的 `sel.role` 传递更关键。

---

### 3.2 relation.role 的语义仍然容易误解

代码位置：

- `src/config/role-resolver.ts`
- `kits/schemas/relation-config.schema.1.json`
- `ecweb/src/sources/role-assignments.ts`

当前 `relation.role` 的实际语义是：

```text
只有当用户不在 owners/admins/members 列表中时，
resolveUserRole() 才会使用 relation.role。
```

但用户看到字段名 `role`，很容易理解为：

```text
这个关系配置里的 role 就是该对端的最终角色。
```

这两者不一致。

已有问题：

- schema 只有 `type: string`，没有 enum 或 role existence 校验。
- ecweb 写入时会校验未知 role，但文件层面仍可手写任意字符串。
- ecweb 展示时使用 `relationConfig?.role || resolveUserRole(...)`，这会把 relation role 当成优先展示值，和 `resolveUserRole()` 的真实优先级不同。

典型冲突：

```json
{
  "owners": ["alice.aid.pub"]
}
```

同时：

```json
{
  "role": "guest"
}
```

`resolveUserRole()` 仍会得到 `owner`，但 ecweb 如果直接显示 relation role，可能让用户以为 alice 已经被降级。

---

### 3.3 defaultRole 语义和文档不一致

代码位置：

- `src/config/role-resolver.ts`
- `ROLE_ACCESS_CONTROL.md`

`ROLE_ACCESS_CONTROL.md` 中描述过“未在名单中时使用 defaultRole”。

但当前代码实际逻辑是：

```text
合法 AID / agentid -> guest
非认证格式 -> defaultRole
```

也就是说：

- `stranger.aid.pub` 当前会解析为 `guest`。
- `unknown-user` 当前会解析为 `defaultRole`，默认是 `anonymous`。

这不一定是错误设计，但必须明确。

需要选择一个方向：

1. 保留当前逻辑：`guest` 表示“有 AID 但未授权”，`defaultRole` 只用于非认证身份。
2. 改成文档逻辑：所有未命中名单的用户都使用 `defaultRole`。

当前文档和代码不一致，应尽快统一。

---

### 3.4 自定义角色支持还不彻底

已经支持的部分：

- roles schema 支持任意 role name。
- `resolveUserRole()` 返回 `string`。
- `relation.role` 可以写自定义角色。
- ecweb 创建/编辑角色定义。

未完全支持的部分：

- `SessionIdentity.role` 类型仍是 `'owner' | 'admin' | 'member' | 'guest' | 'anonymous'`。
- `SessionManager.resolveIdentity()` 无法返回自定义角色。
- 菜单权限、命令权限很多地方仍按 owner/admin/member/guest 做硬编码判断。
- 一些 UI 和策略可能默认只理解内置五种角色。

因此当前自定义角色更像是“配置约束层支持”，还不是“完整运行时身份层支持”。

---

### 3.5 配置字段分层文档需要重写

旧文档中有不少表述仍以 `config.json` 为主，例如：

- agent 的 `roles` 块。
- relation 的 `permissionMode`。
- relation 的 `baseagents`。

但当前代码已经有明确的 H/HA 分层：

```text
H 链：
defaults.json -> agent/config.json -> relation/config.json

HA 行为链：
agent/behavior.json -> behavior.roles[role] -> relation/behavior.json
```

如果文档继续混用，会导致后续开发和排障误判。

需要把以下内容重新文档化：

- 哪些字段属于 H。
- 哪些字段属于 HA。
- 哪些字段仍有 config fallback。
- CLI 写入到底写哪个文件。
- ecweb 写入到底写哪个文件。
- relation/config.json 与 relation/behavior.json 的边界。

---

### 3.6 ecweb 展示与运行时可能不一致

代码位置：

- `ecweb/src/sources/role-assignments.ts`

当前 ecweb 构建关系角色快照时：

```typescript
const role = relationConfig?.role || resolveUserRole(aid, peerAid);
```

问题：

- 这不是 `resolveUserRole()` 的真实优先级。
- 如果某用户在 owners/admins/members 中，同时 relation.role 设为 guest，ecweb 可能显示 guest，但运行时仍是 owner。
- source 标记为 `relation` 也可能误导用户。

更合理的展示应该拆成：

```text
effectiveRole: resolveUserRole(...)
relationRole: relationConfig?.role
source: agent-list | relation | fallback
shadowed: relationRole 存在但被 agent list 覆盖
```

这样 UI 才能清楚告诉用户：

> 你设置了 relation.role，但当前没有生效，因为该用户仍在 owners/admins/members 列表里。

---

## 四、当前设计中合理的地方

### 4.1 列表式角色适合作为核心授权

`owners/admins/members` 这种列表式授权适合做核心身份控制：

- 直观。
- 方便批量管理。
- 适合作为 owner/admin/member 这类强权限身份的来源。
- 便于审计。

继续保留是合理的。

---

### 4.2 relation.role 适合做精细化例外，但不适合含糊存在

`relation.role` 不是完全没有价值，它适合：

- 给某个特定对端设置自定义角色。
- 临时把非列表用户设为更低权限。
- 为特殊用户设置自定义约束。

但它必须满足两个条件：

1. 文档和 UI 明确说明其优先级。
2. 运行时身份解析必须统一，否则它只是局部生效。

如果不能统一，建议废弃或重命名。

---

### 4.3 行为链独立出来是正确方向

把可运行时调整的字段放到 `behavior.json` 是合理的：

- 避免 agent 基础身份配置和运行时行为混在一起。
- 方便后续做 agent 可写配置。
- 更适合权限约束。
- 和 `RelationBehavior` 写入约束模型匹配。

这部分方向是对的，后续重点是把文档和 UI 跟上。

---

## 五、后续方向建议

### 方向一：统一角色解析入口

优先级：最高。

目标：

```text
所有运行时身份、权限模式、模型约束、ecweb 展示都使用同一个角色解析结果。
```

建议实现：

1. 引入一个更完整的解析接口，例如：

```typescript
interface ResolvedRole {
  effectiveRole: string;
  source: 'agent-owner' | 'agent-admin' | 'agent-member' | 'relation' | 'guest' | 'default';
  peerId: string;
  relationRole?: string;
  shadowed?: boolean;
  reason?: string;
}
```

2. 让 `resolveUserRole()` 或新函数 `resolveUserRoleDetail()` 返回完整信息。

3. `SessionManager.resolveIdentity()` 不再自己判断 owner/admin/member，而是调用统一解析器。

4. `ResponseEngine`、菜单、命令、ecweb 都使用同一个 `effectiveRole`。

收益：

- 消除 `relation.role` 局部生效的问题。
- 消除 ecweb 展示和运行时不一致。
- 为自定义角色铺平道路。

---

### 方向二：重新定义 relation.role 的产品语义

需要明确二选一。

#### 方案 A：保留当前优先级

```text
owners/admins/members > relation.role > guest/defaultRole
```

适合：

- 核心角色必须由 agent 列表控制。
- relation.role 只做非核心用户的细粒度覆盖。

需要做：

- UI 显示 shadowed 状态。
- schema description 明确写出“低于 owners/admins/members”。
- 文档写清楚“不能用 relation.role 降级列表用户”。

#### 方案 B：让 relation.role 优先级最高

```text
relation.role > owners/admins/members > guest/defaultRole
```

适合：

- 希望 relation 配置就是对端最终角色。
- 支持临时封禁/降级 owner/admin/member。

风险：

- 会改变现有安全模型。
- 配错 relation.role 可能意外降级 owner。
- 需要迁移和兼容说明。

当前更稳妥的建议是：

> 短期采用方案 A，明确 shadowed；长期如果确实需要临时封禁，再单独设计 `blocked` / `denyAccess` 字段，而不是依靠 role 优先级反转。

---

### 方向三：修正 defaultRole 语义

需要做一个产品决策。

当前代码：

```text
合法 AID 未授权 -> guest
非法/匿名身份 -> defaultRole
```

如果保留当前行为，建议把字段说明改成：

```text
defaultRole 仅用于非认证身份或无法识别身份的兜底角色。
合法 AID 但未授权的用户固定为 guest。
```

如果希望 `defaultRole` 真正控制“未授权用户”，则改代码：

```typescript
if (relationRole) return relationRole;
return getDefaultRole();
```

同时测试要改：

- `stranger.aid.pub` 不再固定为 guest。
- defaultRole 设置为 guest 时才是 guest。

建议：

> 如果产品目标是“陌生 AID 默认可只读访问”，保留 guest 逻辑；如果产品目标是“默认拒绝所有陌生人”，应改为 defaultRole 控制。

---

### 方向四：完善自定义角色的运行时支持

建议逐步做：

1. 把 `SessionIdentity.role` 从内置联合类型改为 `string`。
2. 命令权限不要只硬编码 owner/admin/member，改成从 role permissions 或 capability 表读取。
3. 菜单显示根据 role capability 控制。
4. ecweb 支持给自定义角色配置更明确的能力项。
5. 测试增加自定义角色的完整链路：
   - relation.role = custom role。
   - session.identity.role = custom role。
   - allowAccess 生效。
   - permissionMode/model 约束生效。
   - 菜单权限符合预期。

---

### 方向五：更新 schema 和文档

建议新增或重写一份正式文档：

```text
docs/config/ROLE-PERMISSION-CURRENT.md
```

应包含：

- 角色分配优先级。
- H 链和 HA 链区别。
- `config.json` 与 `behavior.json` 的字段归属。
- `relation.role` 的真实语义。
- `defaultRole` 的真实语义。
- 自定义角色支持边界。
- ecweb 展示字段说明。

schema 建议：

- `relation-config.schema.1.json` 的 `role.description` 明确优先级。
- 如果不支持任意字符串，增加 enum 或动态校验机制。
- 如果支持自定义角色，schema 不适合 enum，但写入 API 和 CLI 必须校验 role 是否存在。

---

## 六、建议执行顺序

### 第一阶段：先消除误导

目标：不大改运行时，只把语义说明清楚。

建议任务：

1. 修正文档，把 `behavior.json` 作为 HA 主链写清楚。
2. 修正 `ROLE_ACCESS_CONTROL.md` 中 defaultRole 描述。
3. ecweb 展示拆分 `effectiveRole` 和 `relationRole`。
4. relation.role schema description 增加优先级说明。

收益：

- 风险低。
- 能立刻减少误用。
- 不破坏现有行为。

---

### 第二阶段：统一角色解析入口

目标：让运行时身份和配置解析吃同一个结果。

建议任务：

1. 新增 `resolveUserRoleDetail()`。
2. `SessionManager.resolveIdentity()` 改为基于统一解析器。
3. `ResponseEngine` 使用统一解析后的 effective role。
4. ecweb 使用同一解析器展示 effective role。
5. 增加 relation.role 被 shadowed 的测试。

收益：

- 解决当前最大的架构不一致。
- 后续才能放心做自定义角色。

---

### 第三阶段：自定义角色能力化

目标：从“五种内置角色 + 字段约束”升级为“可扩展角色权限体系”。

建议任务：

1. `SessionIdentity.role` 改为 string。
2. 命令和菜单权限从硬编码角色名逐步迁移到 capability/permission。
3. roles schema 增加 command/menu capability。
4. ecweb 支持编辑 capability。

收益：

- 自定义角色真正可用。
- 角色权限体系从模型配置约束扩展到完整操作权限控制。

---

## 七、最终结论

当前角色权限体系已经完成了最难的一半：

- 角色定义完整。
- 角色约束机制可用。
- 访问控制已接入消息入口。
- 行为配置链已经较合理。
- 测试覆盖较充分。

还没完成的是另一半：

- 角色身份来源未统一。
- `relation.role` 语义容易误导。
- ecweb 展示可能和运行时不一致。
- `defaultRole` 文档和代码不一致。
- 自定义角色还没有完整运行时权限语义。

后续最重要的方向不是继续增加字段，而是：

> **先统一角色解析结果，再围绕这个结果重建文档、UI 展示和命令权限。**

只要这个统一入口完成，当前已有的约束、访问控制、测试体系都可以继续复用，整体会从“能用但容易混淆”进入“可解释、可扩展、可维护”的状态。
