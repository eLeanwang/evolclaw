# Bypass 模式权限策略改进方案

## 问题描述

当前 EvolClaw 的 `bypass` 权限模式存在安全隐患：危险命令（如 `rm -rf`, `sudo`, `chmod 777` 等）在 bypass 模式下会**直接放行**，不请求用户授权。这与 Claude CLI 工具的行为不一致，且违背了用户对 "bypass" 语义的合理预期。

### 核心矛盾

- **用户期望**：bypass = 跳过 AI 智能分类器的自动判断（auto 模式），保留人工设置的安全规则
- **当前实现**：bypass = 跳过所有权限检查（除了 PreToolUse hook 的绝对禁止命令）

## 当前实现分析

### 三层权限检查架构

```
┌─────────────────────────────────────────────┐
│  PreToolUse Hook（所有模式都经过）           │
│  ✓ 绝对禁止命令（shutdown, mkfs）           │
│  ✓ H类文件保护（config.json, 证书）         │
│  ✓ readonly 模式写入检查                     │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│  canUseTool 回调（权限模式分流点）           │
│  • auto 模式 → SDK 智能分类器                │
│  • bypass 模式 → 直接放行 ❌                 │
│  • request 模式 → 请求用户授权               │
│  • edit 模式 → 编辑类自动，其他询问          │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│  危险命令检测（DANGEROUS_PATTERNS）          │
│  • rm -rf, sudo, chmod 777, pkill...        │
│  • 目前只在非 bypass 模式下生效 ❌           │
└─────────────────────────────────────────────┘
```

### 问题代码位置

**文件**：`src/agents/claude-runner.ts`

**行号**：1349-1352

```typescript
// bypass 模式：一律 allow
if (callPermissionMode === 'bypass') {
  return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
}
```

**问题**：bypass 模式直接返回 allow，跳过了后续的危险命令检测逻辑（1363-1393 行）。

## 不一致性对比

| 场景 | 当前 bypass 行为 | CLI 工具行为 | 用户期望 | 是否一致 |
|------|-----------------|-------------|---------|---------|
| 系统级破坏命令（shutdown, mkfs） | PreToolUse 拦截 | 拦截 | 拦截 | ✅ |
| H类文件写入（config.json, 证书） | PreToolUse 拦截 | 拦截 | 拦截 | ✅ |
| 危险命令（rm -rf, sudo） | 直接放行 | 请求授权 | 请求授权 | ❌ |
| 普通工具调用（Read, Grep） | 直接放行 | 直接放行 | 直接放行 | ✅ |
| readonly 模式写入 | PreToolUse 拦截 | 拦截 | 拦截 | ✅ |

**结论**：唯一的不一致点在于**危险命令的处理**。

## 方案 A：修改 bypass 语义（推荐）

### 设计原则

1. **安全优先**：bypass 不应该成为"关闭所有安全检查"的开关
2. **语义正确**：bypass = 跳过 AI 智能判断，保留人工安全规则
3. **CLI 对齐**：与 Claude CLI 的 `--dangerously-skip-permissions` 行为一致
4. **分层清晰**：
   - 系统级保护（ABSOLUTE_FORBIDDEN）→ 永远拦截
   - 危险操作（DANGEROUS_PATTERNS）→ 需要授权
   - 普通操作 → bypass 放行

### 核心修改

**位置**：`src/agents/claude-runner.ts`、`src/agents/codex-runner.ts`、`src/core/permission.ts`

**修改前**：
```typescript
// bypass 模式：一律 allow
if (callPermissionMode === 'bypass') {
  return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
}
```

**修改后**：
```typescript
// bypass 模式：跳过 AI 分类器，但保留危险命令检测
if (callPermissionMode === 'bypass') {
  const dangerDecision = await requestDangerousCommandPermission(
    this.permissionGateway,
    sessionId,
    toolName,
    input,
    this.sendPromptFn,
    this.permissionContexts.get(sessionId)
  );
  if (dangerDecision.matched) {
    // allow / always / deny 按审批结果映射
  }

  // 非危险操作直接放行
  return { behavior: 'allow' as const, updatedInput: input, decisionClassification: 'user_permanent' as const };
}
```

### 文案更新

**位置**：`src/agents/claude-runner.ts:410`、`src/agents/codex-runner.ts`

**修改前**：
```typescript
{ key: 'bypass', nameZh: '放行', description: '全部自动放行', available: true },
```

**修改后**：
```typescript
{ key: 'bypass', nameZh: '放行', description: '跳过 AI 判断，危险操作仍需确认', available: true },
```

### 相关文档更新

**位置**：`CLAUDE.md`（项目根目录）

在 "Command Management" 或 "Permission Modes" 章节添加说明：

```markdown
### Permission Modes

| Mode | Description | Behavior |
|------|-------------|----------|
| auto | AI 分类器自动判断 | SDK 智能分类，部分询问 |
| bypass | 跳过 AI 判断 | 普通操作自动放行，**危险命令仍需确认** |
| request | 部分询问 | 部分自动，部分询问 |
| edit | 编辑类自动 | 编辑类自动，其他询问 |
| plan | 只规划不执行 | 生成计划，等待审批 |
| noask | 静默模式 | 未批准则拒绝 |

**危险命令列表**（所有模式下都需要用户授权，除非标记为"始终允许"）：
- `rm -rf` - 递归删除
- `sudo` - 提权执行
- `chmod 777` - 危险权限
- `pkill` / `killall` - 批量终止进程
- `reg delete` - 删除注册表（Windows）
- `net stop` - 停止服务（Windows）
- 重定向到设备文件（`> /dev/sda` 等）
```

## 实现清单

- [x] 修改 `claude-runner.ts` - bypass 模式增加危险命令检测
- [x] 修改 `codex-runner.ts` - bypass 模式增加危险命令检测
- [x] 修改 `permission.ts` - 抽出 `requestDangerousCommandPermission()` 共享审批入口
- [x] 修改 `permission.ts` - "始终允许"缓存从 `dangerous:Bash` 收窄为 `dangerous:Bash:<kind>`
- [x] 修改 runner 和菜单文案 - bypass 显示为普通操作放行、危险操作仍需确认
- [x] 更新 `CLAUDE.md` - 添加权限模式说明表
- [x] 测试用例 - 验证 bypass 模式下危险命令会触发授权请求
- [x] 测试用例 - 验证 bypass 模式下普通操作直接放行
- [x] 测试用例 - 验证"始终允许"缓存在 bypass 模式下生效
- [ ] Changelog - 待随下一个版本发布记录

## 向后兼容性影响

### 影响范围

**轻微影响**：使用 bypass 模式且频繁执行危险命令的用户，首次执行时会收到授权请求。

### 缓解措施

1. **"始终允许"机制**：用户点击"始终允许"后，后续相同危险类型不再询问（例如 `dangerous:Bash:sudo`，不会放行所有危险 Bash）
2. **清晰提示**：授权请求会说明具体风险和原因
3. **文档说明**：Changelog 明确标注此为安全性改进

### 不影响的场景

- 不使用 bypass 模式的用户（auto, request, edit）→ 无影响
- bypass 模式下不执行危险命令 → 无影响
- 已有"始终允许"缓存的用户 → 无影响

## 替代方案对比

### 方案 B：保持现状

**优点**：向后兼容  
**缺点**：安全隐患，与 CLI 不一致

### 方案 C：新增 smart-bypass 模式

**优点**：完全向后兼容  
**缺点**：增加概念复杂度，用户需要学习新模式

### 为什么选择方案 A

1. **安全性 > 兼容性**：涉及系统安全，应该优先保护
2. **影响可控**：只影响少数高级用户，且有缓解措施
3. **长期价值**：统一行为规范，降低用户学习成本

## 参考

- Claude CLI 权限模型：`--dangerously-skip-permissions` 仍会拦截危险操作
- DANGEROUS_PATTERNS 定义：`src/core/permission.ts:24-36`
- checkDangerousCommand 实现：`src/core/permission.ts:205-248`

---

**提议人**：molian1108  
**日期**：2026-06-28  
**状态**：已实现（2026-06-28）
