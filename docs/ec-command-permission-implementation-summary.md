# EC 命令独立权限控制模块 - 实施总结

> 实施日期：2026-07-02  
> 状态：✅ **已完成**  
> 参照设计文档：`docs/权限配置化与通用接口鉴权设计.md`

---

## 1. 实施背景

EC 命令（`ec msg send`、`ec group send`、`ec ctl send/file` 等）是 evolclaw 系统的核心命令，但之前完全通过 Bash 工具执行，仅在工具层面做会话内目标匹配，没有走 operation-based 的统一角色权限模型（`authorizeCommand()`）。

本次实施将 ec 命令纳入统一权限体系，使其可以按角色通过 `commandPermissions` 精细授权（`ownPeerOnly`、`groupOnly`、`requireControlChannel` 等约束）。

---

## 2. 实施范围

### 本次已覆盖

✅ **EC 命令操作类型**：
- `ec.msg.send` / `ec.msg.file` - 私聊消息/文件发送
- `ec.group.send` / `ec.group.file` - 群组消息/文件发送
- `ec.ctl.send` / `ec.ctl.file` - 控制通道消息/文件发送

✅ **Runner 集成**：
- Claude runner（`src/agents/claude-runner.ts`）

✅ **角色权限配置**：
- owner/admin：全部权限（现有 `'*': { allow: true }` 自动覆盖）
- member：允许私聊和群组 send/file，禁止控制通道
- guest：仅允许私聊 send（严格约束），禁止 file 和其他操作

✅ **测试覆盖**：
- Operation registry 测试
- EC 命令鉴权逻辑测试（21 个测试用例）
- 现有命令权限测试（无破坏）

### 暂不覆盖（留待后续扩展）

⏸️ **只读命令**：`ec ctl status` / `ec ctl queue` 等只读命令暂不纳入，仍走原有 Bash 白名单逻辑。

⏸️ **其他 Runner**：Codex runner / Gemini runner 等暂不接入，可按需在后续阶段扩展。

⏸️ **ECWeb 可视化编辑**：ECWeb 后台可以展示新的 ec.* operations（自动从 registry 读取），但暂未新增直接编辑 `commandPermissions` 的 API/UI。

---

## 3. 核心改动

### 3.1 类型定义扩展

**文件**：`src/types.ts`

- 新增 CommandSource：`'agent-tool'`（表示 agent 在会话内通过 Bash 工具调用）

### 3.2 Operation Registry 扩展

**文件**：`src/core/command/operation-registry.ts`

新增 6 个 ec.* operations：

| Operation ID | Category | Dangerous | Default Scopes | Sources |
|---|---|---|---|---|
| `ec.msg.send` | write-own | false | relation, agent | agent-tool |
| `ec.msg.file` | write-own | false | relation, agent | agent-tool |
| `ec.group.send` | write-own | false | relation, agent | agent-tool |
| `ec.group.file` | write-own | false | relation, agent | agent-tool |
| `ec.ctl.send` | write-agent | false | control, agent | agent-tool |
| `ec.ctl.file` | write-agent | false | control, agent | agent-tool |

### 3.3 EC 命令鉴权模块

**新文件**：`src/core/command/ec-command-permission.ts`

核心函数：
- `parseEcOperationId(command: string): string | null` - 解析 Bash 命令字符串，识别是否为 ec send/file 命令
- `authorizeEcCommand(command: string, ctx: EcCommandAuthorizationContext): CommandAuthorizationDecision | null` - 对 ec 命令执行统一鉴权，返回 null 表示非 ec 命令

设计特点：
- 复用现有 `parseEvolclawSendCommand()` 解析逻辑
- 复用现有 `authorizeCommand()` 鉴权核心
- 自动记录审计日志（`auditCommandAuthorization()`）
- 返回 null 时调用方回退到原有工具层逻辑，不破坏现有行为

### 3.4 Claude Runner 集成

**文件**：`src/agents/claude-runner.ts`

在 PreToolUse hook 中插入 ec 命令鉴权：

```typescript
// 位置：黑名单检查之后、只读模式检查之前
if (input.tool_name === 'Bash') {
  const ecDecision = authorizeEcCommand(command, ecAuthCtx);
  if (ecDecision) {
    if (!ecDecision.allow) {
      return { decision: 'block', reason: `🔒 EC 命令权限拒绝: ${ecDecision.reason}` };
    }
    return {}; // 放行，跳过后续危险命令检测
  }
  // 非 ec 命令，继续走原有逻辑
}
```

### 3.5 角色权限配置

**文件**：`src/config/builtin-roles.ts`

**member 角色**新增：
```typescript
'ec.msg.send': { allow: true, constraints: { ownPeerOnly: true } },
'ec.msg.file': { allow: true, constraints: { ownPeerOnly: true } },
'ec.group.send': { allow: true, constraints: { groupOnly: true } },
'ec.group.file': { allow: true, constraints: { groupOnly: true } },
'ec.ctl.*': { allow: false },
```

**guest 角色**新增：
```typescript
'ec.msg.send': { allow: true, scopes: ['relation'], constraints: { ownPeerOnly: true, privateOnly: true } },
'ec.msg.file': { allow: false },
'ec.group.*': { allow: false },
'ec.ctl.*': { allow: false },
```

### 3.6 测试

**新文件**：`src/core/command/__tests__/ec-command-permission.test.ts`

- 21 个测试用例覆盖 parseEcOperationId 和 authorizeEcCommand
- 验证各种 ec 命令格式解析
- 验证 member/guest 角色的权限策略
- 验证约束（ownPeerOnly、groupOnly、privateOnly）生效

**更新文件**：`src/core/command/__tests__/operation-registry.test.ts`

- 新增测试验证 6 个 ec.* operations 存在性和元数据完整性

---

## 4. 权限策略总结

| 角色 | ec msg send | ec msg file | ec group send | ec group file | ec ctl.* |
|---|---|---|---|---|---|
| **owner** | ✅ 全部权限 | ✅ 全部权限 | ✅ 全部权限 | ✅ 全部权限 | ✅ 全部权限 |
| **admin** | ✅ 全部权限 | ✅ 全部权限 | ✅ 全部权限 | ✅ 全部权限 | ✅ 全部权限 |
| **member** | ✅ 仅自己 | ✅ 仅自己 | ✅ 仅群组 | ✅ 仅群组 | ❌ 禁止 |
| **guest** | ✅ 私聊+自己 | ❌ 禁止 | ❌ 禁止 | ❌ 禁止 | ❌ 禁止 |
| **anonymous** | ❌ 禁止全部 | ❌ 禁止全部 | ❌ 禁止全部 | ❌ 禁止全部 | ❌ 禁止全部 |

**约束说明**：
- `ownPeerOnly`：只能向自己（actorId）发送消息
- `groupOnly`：只能在群组聊天（chatType='group'）中使用
- `privateOnly`：只能在私聊（chatType='private'）中使用

---

## 5. 测试结果

✅ **所有测试通过**：
- operation-registry.test.ts：23 个测试
- ec-command-permission.test.ts：21 个测试
- command-permission.test.ts：25 个测试（现有，无破坏）

✅ **TypeScript 编译通过**：无类型错误

---

## 6. 架构优势

1. **统一鉴权模型**：ec 命令与其他 operations（model.*、stats.*、agent.* 等）使用相同的鉴权流程和审计机制。

2. **细粒度权限控制**：可以针对每个 ec 子命令设置不同的权限策略和约束，而不是"全有或全无"。

3. **可扩展性**：
   - 新增自定义角色时，可以通过 `roles.json` 的 `commandPermissions` 灵活配置 ec 命令权限。
   - 后续新增 ec 子命令（如 `ec.ctl.status`）只需在 operation-registry 注册即可自动接入。

4. **审计完整性**：所有 ec 命令的鉴权决策（尤其是拒绝）都会记录审计日志，ECWeb 审计日志视图可追溯。

5. **向后兼容**：
   - owner/admin 的现有行为不变（`'*': { allow: true }` 继续有效）。
   - 非 ec 命令的 Bash 工具调用走原有逻辑，不受影响。

---

## 7. 后续扩展建议

### 7.1 扩展只读命令

将 `ec ctl status` / `ec ctl queue` 等只读命令纳入权限控制：

1. 扩展 `parseEvolclawSendCommand()` 或新增解析函数识别这些子命令。
2. 在 operation-registry.ts 新增 `ec.ctl.status` / `ec.ctl.queue`（category='read'）。
3. 更新 builtin-roles.ts 配置各角色权限（guest 可能可以只读 ctl status，但禁止 send）。

### 7.2 扩展到其他 Runner

将 ec 命令鉴权接入 Codex runner / Gemini runner：

1. 在各 runner 的 PreToolUse hook 中复用 `authorizeEcCommand()`。
2. 确保 context（role、selfAid、peerKey、chatType 等）正确传递。

### 7.3 ECWeb 可视化编辑

如果需要在 ECWeb 后台提供"直接编辑角色 commandPermissions 规则"的功能：

1. 新增 API 端点（如 `PUT /api/roles/definitions/:role/commands`）。
2. 调用父进程的 `roles.ts` 写入接口。
3. 前端提供 operation 选择器 + constraints 配置表单。

### 7.4 更多约束类型

可以为 ec 命令新增更多约束，例如：

- `allowedTargets: string[]` - 白名单目标 peer/group ID
- `deniedTargets: string[]` - 黑名单目标 peer/group ID
- `requireAuthenticatedPeer: boolean` - 要求目标 peer 已通过 AID 认证
- `maxMessageLength: number` - 限制消息内容长度
- `allowedFileExtensions: string[]` - 限制文件类型

---

## 8. 相关文档

- **设计文档**：`docs/权限配置化与通用接口鉴权设计.md`
- **权限体系分析**：`docs/权限授权体系分析与扩展指南.md`
- **命令执行权限设计**：`docs/command-execution-role-permission-design.md`
- **角色配置 Schema**：`kits/schemas/roles.schema.4.json`

---

## 9. 总结

本次实施成功将 ec 命令纳入 evolclaw 统一的 operation-based 权限体系，实现了：

✅ 细粒度的角色权限控制  
✅ 统一的鉴权流程和审计机制  
✅ 向后兼容的渐进式改造  
✅ 完整的测试覆盖  
✅ 可扩展的架构基础  

这为后续新增更多 ec 子命令、扩展到其他 runner、以及 ECWeb 可视化配置奠定了坚实基础。
