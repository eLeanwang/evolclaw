# /perm 权限模式重新设计方案

## 背景

EvolClaw 当前 `/perm` 提供 `auto`/`manual`/`edit` 三种模式，存在以下问题：

1. **`manual` 无对应** — "每个工具都要审批"在 Claude SDK 和 Codex CLI 中都不存在，可用性极差
2. **`auto` 语义错位** — 名为"自动"，实际传给 SDK 的是 `default`，但 `canUseTool` 回调一律 allow，等于绕过了 SDK 的权限判断
3. **`edit` 未实现** — 只是占位符
4. **`canUseTool` 回调只用了 2 参数** — 丢掉了 SDK 提供的 `title`/`description`/`decisionReason` 等上下文信息
5. **Codex 权限完全硬编码** — `approvalPolicy: 'never'`，不可切换

## 统一映射表

| EvolClaw | Claude SDK | Codex CLI | 语义 |
|----------|-----------|-----------|------|
| `default` | `default` | `on-request` | 标准策略，部分自动放行，部分询问 |
| `edit` | `acceptEdits` | (无对应) | 自动接受文件编辑，其他按标准策略 |
| `never` | `bypassPermissions` | `never` | 不弹审批 |
| `plan` | `plan` | (无对应) | 规划模式，不执行 |
| `noask` | `dontAsk` | `untrusted` | 未预批准则拒绝，只放行已知安全操作 |

## SDK 版本确认

| 依赖 | 版本 | 状态 |
|------|------|------|
| `@anthropic-ai/claude-agent-sdk` | ^0.2.75 | ✅ 支持 `PermissionMode` 5 种、`CanUseTool` 3 参数、`setPermissionMode()` 动态切换 |
| `@openai/codex-sdk` | ^0.118.0 | ✅ 支持 `ApprovalMode`: `never`/`on-request`/`untrusted`/`on-failure`(弃用) |

## Claude SDK 权限评估顺序（官方文档）

```
1. Hooks (PreToolUse) → allow / deny / continue
2. Deny rules (disallowed_tools) → 黑名单拦截
3. Permission mode → bypassPermissions 全部通过，acceptEdits 文件操作通过
4. Allow rules (allowed_tools) → 白名单通过
5. canUseTool 回调 → 前面都没决定时才调用
   └─ dontAsk 模式下直接拒绝，不调 canUseTool
```

**关键**: `canUseTool` 只在前 4 步都未决定时触发，是最后一道关卡。

## 各模式下 `canUseTool` 触发情况

| SDK permissionMode | canUseTool 是否触发 | 触发条件 |
|-------------------|-------------------|---------|
| `default` | ✅ 触发 | 未被 hooks/deny/allow rules 命中的工具 |
| `acceptEdits` | ✅ 部分触发 | 文件操作被 mode 层自动 allow 不触发；其余未决工具触发 |
| `bypassPermissions` | ❌ 不触发 | mode 层全部 allow |
| `dontAsk` | ❌ 不触发 | 直接 deny |
| `plan` | ❌ 不触发 | 不执行工具 |

## 已知问题

- **Claude SDK `bypassPermissions`**: 已知会导致 SDK 崩溃，需要 `allowDangerouslySkipPermissions: true` 且仍不稳定
- **Codex `on-failure`**: 已弃用，不暴露给用户

## 详细设计

### 1. PermissionMode 类型定义更新

**文件**: `src/agents/claude-runner.ts`

```typescript
// 修改前
export interface PermissionMode {
  key: string;
  nameZh: string;
  description: string;
}

// 修改后
export interface PermissionModeInfo {
  key: string;
  nameZh: string;
  description: string;
  available: boolean;       // 当前 agent 是否支持
  unavailableReason?: string; // 不可用原因
}
```

### 2. AgentRunner (Claude) 改造

**文件**: `src/agents/claude-runner.ts`

#### 2a. `listModes()` 返回新的 5 种模式

```typescript
listModes(): PermissionModeInfo[] {
  return [
    { key: 'default', nameZh: '标准', description: '标准策略：部分自动放行，部分询问用户', available: true },
    { key: 'edit', nameZh: '编辑', description: '自动接受文件编辑，其他操作询问用户', available: true },
    { key: 'never', nameZh: '无审批', description: '不弹审批提示（已知 SDK 缺陷，暂不可用）', available: false, unavailableReason: 'Claude SDK bypassPermissions 存在崩溃缺陷' },
    { key: 'plan', nameZh: '规划', description: '规划模式，不执行任何操作', available: true },
    { key: 'noask', nameZh: '静默拒绝', description: '未预批准则直接拒绝，不询问用户', available: true },
  ];
}
```

#### 2b. `permissionMode → SDK permissionMode` 映射

```typescript
// 新增映射函数
private toSdkPermissionMode(): import('@anthropic-ai/claude-agent-sdk').PermissionMode {
  const map: Record<string, import('@anthropic-ai/claude-agent-sdk').PermissionMode> = {
    'default': 'default',
    'edit': 'acceptEdits',
    'never': 'bypassPermissions',
    'plan': 'plan',
    'noask': 'dontAsk',
  };
  return map[this.permissionMode] || 'default';
}
```

#### 2c. `canUseTool` 回调改造

当前实现（`permission-utils.ts`）：只做黑名单检查，非黑名单一律 allow。

改造后：黑名单保留在 `PreToolUse` hook（第 1 步拦截），`canUseTool` 变为接入 `PermissionGateway` 的用户审批入口。

```typescript
// 在 runQuery() 内构造 canUseTool
const canUseToolCallback: CanUseTool = async (toolName, input, options) => {
  // 到达这里说明 SDK 认为此工具需要用户确认
  // （黑名单已在 PreToolUse hook 拦截）

  // 利用 SDK 提供的上下文信息构造友好提示
  const summary = options.title
    || options.description
    || summarizeToolInput(toolName, input);

  const approved = await this.permissionGateway!.requestPermission(
    sessionId,
    toolName,
    input,
    this.sendPromptFn!,
    summary,             // 新增：SDK 提供的可读描述
    options.decisionReason // 新增：SDK 解释为何需要审批
  );

  return approved
    ? { behavior: 'allow' as const, updatedInput: input }
    : { behavior: 'deny' as const, message: '用户拒绝或审批超时' };
};
```

**注意**: 如果 `permissionGateway` 或 `sendPromptFn` 未设置（如测试环境），则回退到原有行为（一律 allow）。

#### 2d. `PreToolUse` hook 精简

删掉 `manual` 模式分支，只保留黑名单检查：

```typescript
const preToolUseHook = async (input: any) => {
  // 黑名单检查（不可绕过，所有模式都走）
  const result = await canUseTool(input.tool_name, input.tool_input || {});
  if (result.behavior === 'deny') {
    return { decision: 'block' as const, reason: result.message };
  }
  return {};
};
```

#### 2e. `commonOptions` 中传入新的 permissionMode

```typescript
// 修改前
const isEdit = this.permissionMode === 'edit';
const sdkPermissionMode = isEdit ? 'acceptEdits' as const : 'default' as const;

// 修改后
const sdkPermissionMode = this.toSdkPermissionMode();
```

### 3. CodexRunner 改造

**文件**: `src/agents/codex-runner.ts`

#### 3a. `listModes()` 返回 Codex 支持的模式

```typescript
listModes(): PermissionModeInfo[] {
  return [
    { key: 'default', nameZh: '标准', description: '需要审批时停下来询问', available: true },
    { key: 'never', nameZh: '无审批', description: '不弹审批提示（仍受 sandbox 约束）', available: true },
    { key: 'noask', nameZh: '只读安全', description: '只自动执行已知安全的只读操作', available: true },
  ];
}
```

`edit` 和 `plan` 对 Codex 不适用，不列出。

#### 3b. `setMode()` 生效 + 映射到 Codex `approvalPolicy`

```typescript
private approvalPolicy: ApprovalMode = 'never';

setMode(mode: string): void {
  const map: Record<string, ApprovalMode> = {
    'default': 'on-request',
    'never': 'never',
    'noask': 'untrusted',
  };
  this.approvalPolicy = map[mode] || 'never';
  this.currentMode = mode;
}

getMode(): string { return this.currentMode; }
```

#### 3c. `runQuery()` 使用动态 approvalPolicy

```typescript
// 修改前
approvalPolicy: 'never',

// 修改后
approvalPolicy: this.approvalPolicy,
```

### 4. PermissionGateway 改造

**文件**: `src/core/permission.ts`

增加 `summary` 和 `reason` 参数，提升审批提示的可读性：

```typescript
async requestPermission(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sendPrompt: (text: string) => Promise<void>,
  summary?: string,       // SDK 提供的可读描述
  reason?: string         // SDK 解释为何需要审批
): Promise<boolean> {
  const displaySummary = summary || summarizeToolInput(toolName, toolInput);
  const reasonLine = reason ? `\n原因：${reason}` : '';

  await sendPrompt(
    `🔐 权限请求\n工具：${toolName}\n操作：${displaySummary}${reasonLine}\n\n回复 /perm allow 批准 或 /perm deny 拒绝`
  );
  // ... 其余逻辑不变
}
```

### 5. CommandHandler `/perm` 命令更新

**文件**: `src/core/command-handler.ts`

#### 5a. 模式列表：过滤不可用模式

```typescript
// /perm（无参数）：显示当前模式和可选模式
const modes = agent.listModes();
const modeList = modes.map(m => {
  const prefix = m.key === currentMode ? '▶' : ' ';
  const suffix = m.available ? '' : ' ⚠️ 不可用';
  return `  ${prefix} ${m.key} (${m.nameZh}) - ${m.description}${suffix}`;
}).join('\n');
```

#### 5b. 切换模式：拦截不可用模式

```typescript
// /perm <mode>：切换权限模式
const matched = modes.find(m => m.key === arg);
if (matched) {
  if (!matched.available) {
    return `❌ ${matched.key} 模式当前不可用：${matched.unavailableReason}`;
  }
  // ... 正常切换逻辑
}
```

#### 5c. 帮助文本更新

```
🔐 权限管理：
  /perm - 查看当前权限模式
  /perm <default|edit|never|plan|noask> - 切换权限模式
  /perm allow|deny - 审批权限请求
```

#### 5d. metadata 类型更新

```typescript
// 修改前
metadata.permissionMode = arg as 'auto' | 'manual' | 'edit';

// 修改后
metadata.permissionMode = arg;
```

#### 5e. 默认值迁移

```typescript
// 修改前
const currentMode = session.metadata?.permissionMode || 'auto';

// 修改后
const currentMode = session.metadata?.permissionMode || 'default';
// 向后兼容：如果旧数据中存在 'auto'，映射为 'default'
const normalizedMode = currentMode === 'auto' ? 'default' : currentMode;
```

### 6. message-processor.ts 默认值更新

**文件**: `src/core/message-processor.ts`

```typescript
// 修改前
const permissionMode = session.metadata?.permissionMode || 'auto';

// 修改后
let permissionMode = session.metadata?.permissionMode || 'default';
if (permissionMode === 'auto') permissionMode = 'default';       // 向后兼容
if (permissionMode === 'manual') permissionMode = 'default';     // 向后兼容
```

### 7. permission-utils.ts 精简

**文件**: `src/utils/permission-utils.ts`

`canUseTool` 函数保留原样（黑名单检查），仍用于 `PreToolUse` hook。
但不再作为 SDK 的 `canUseTool` 选项传入——SDK 层的 `canUseTool` 改为 `canUseToolCallback`（见 2c）。

为避免命名混淆，可将原函数重命名为 `checkBlacklist`。

## 实施步骤

| 步骤 | 文件 | 改动 | 风险 |
|------|------|------|------|
| 1 | `claude-runner.ts` | `PermissionModeInfo` 类型 + `listModes()` 更新 | 低 |
| 2 | `claude-runner.ts` | `toSdkPermissionMode()` 映射 + `commonOptions` 更新 | 低 |
| 3 | `claude-runner.ts` | `canUseToolCallback` 替换直接传入的 `canUseTool` | **中** — 核心改动 |
| 4 | `claude-runner.ts` | `PreToolUse` hook 删除 `manual` 分支 | 低 |
| 5 | `codex-runner.ts` | `listModes()` + `setMode()` + 动态 `approvalPolicy` | 低 |
| 6 | `permission.ts` | `requestPermission()` 增加 `summary`/`reason` 参数 | 低 |
| 7 | `command-handler.ts` | `/perm` 命令逻辑更新 | 低 |
| 8 | `message-processor.ts` | 默认值 `'auto'` → `'default'` + 向后兼容 | 低 |
| 9 | `permission-utils.ts` | 可选：`canUseTool` 重命名为 `checkBlacklist` | 低 |
| 10 | 测试 | 验证各模式下权限行为 | — |

## 测试验证计划

1. **`default` 模式**: 发送消息 → Agent 调用 Bash → SDK 触发 `canUseTool` → 聊天窗口收到审批提示 → `/perm allow` → 执行继续
2. **`edit` 模式**: Agent 调用 Edit → 自动通过 → Agent 调用 Bash → 聊天窗口弹审批
3. **`noask` 模式**: Agent 调用 Bash → 直接拒绝 → Agent 收到 deny 信息
4. **`plan` 模式**: Agent 不执行任何工具
5. **`never` 模式**: `/perm never` → 返回不可用提示
6. **向后兼容**: 旧 session 中 `permissionMode: 'auto'` → 自动映射为 `default`
7. **Codex `default` 模式**: Codex 执行命令时暂停询问（由 CLI 内部处理）
