# 安全与权限控制

> EvolClaw 配置体系 v3
> 上一篇：[06-cli-commands.md](./06-cli-commands.md) | 下一篇：[08-quick-reference.md](./08-quick-reference.md)

---

## 一、核心原则

**权限控制在 API 层，而非文件级。**

### 为什么不用文件级权限？

**原设计（已废弃）**：
- config.json(H) - 人类修改，hook 禁止 agent 写
- behavior.json(HA) - agent 可修改，hook 允许 agent 写

**问题**：
- 实际所有配置修改都通过 evolclaw 代码/CLI 完成
- Hook 可以直接禁止 agent 直接读写**所有**配置文件
- 文件级权限控制过于粗粒度
- behavior.json 的存在增加了复杂性

**新设计（v3）**：
- 所有参数统一在 config.json（不再有 behavior.json）
- Hook 禁止所有配置文件的直接读写
- Agent 通过 CLI（`ec model`, `ec ctl`, `ec config`）修改配置
- CLI 内部根据参数类型和调用方身份判断是否允许

---

## 二、Hook 拦截策略

### 拦截目标

**禁止 agent 直接读写的文件**：
- 所有配置文件（evolclaw.json, defaults.json, config.json）
- 所有 `.env` 文件（全局/agent/关系级）
- 快照目录（backups/config/）

### 实施方式

通过 Hook 拦截文件系统调用：

```typescript
// Hook 伪代码
function interceptFileAccess(path: string, operation: 'read' | 'write') {
  if (isConfigFile(path) || isEnvFile(path) || isSnapshotDir(path)) {
    throw new Error(`禁止直接${operation}配置文件，请使用 CLI 命令`);
  }
}
```

### 白名单机制

允许的操作：
- ✅ 通过 CLI 命令修改配置（`ec config set`, `ec model`, `ec ctl`）
- ✅ 通过 ConfigManager API 读取配置（内部运行时）
- ❌ 直接读写配置文件（fs.readFileSync, fs.writeFileSync）

---

## 三、凭证安全

### .env 文件保护

**三级 .env**：
- 全局：`{evolclaw_home}/.env`
- agent：`{evolclaw_home}/agents/{aid}/.env`
- 关系：`{evolclaw_home}/agents/{aid}/relations/{peerKey}/.env`

**保护措施**：
1. Hook 拦截任何对 `.env` 的读写
2. 配置 JSON 只存引用（`${VAR}`）
3. CLI 读命令永不展开 `${VAR}`（显示占位符）
4. 只有 ConfigManager 内部运行时展开

### 引用格式

```jsonc
// config.json
{
  "channels": [
    { 
      "type": "feishu",
      "appId": "${FEISHU_APP_ID}",
      "appSecret": "${FEISHU_APP_SECRET}"
    }
  ]
}

// .env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=yyy
```

### 解析优先级

```
关系级 .env > agent 级 .env > 全局 .env > process.env
```

### 安全保证

- ✅ CLI 读取时不展开（防泄露）
- ✅ 快照不包含 `.env`（防持久化）
- ✅ Hook 拦截直接读写（防绕过）
- ✅ 运行时展开仅在内部（防外传）

---

## 四、参数级权限控制（未来）

### 当前状态

**Agent 可以通过 CLI 修改任意配置参数。**

权限体系的具体设计待完善。

### 设计方向

#### 方案 A：Schema 标注

在 schema 中标记参数权限：

```json
{
  "properties": {
    "aid": {
      "type": "string",
      "x-permission": "human-only",
      "description": "Agent AID"
    },
    "chatmode": {
      "type": "object",
      "x-permission": "configurable",
      "description": "对话模式"
    }
  }
}
```

#### 方案 B：白名单/黑名单

维护参数白名单/黑名单：

```typescript
// 人类专属参数（agent 不能修改）
const HUMAN_ONLY_PARAMS = [
  'aid',
  'owners',
  'admins',
  'channels',
  'aun',
  'projects',
  'debug',
];

// 检查权限
function checkPermission(field: string, caller: 'human' | 'agent') {
  if (caller === 'agent' && HUMAN_ONLY_PARAMS.includes(field)) {
    throw new Error(`Agent 不能修改参数 ${field}`);
  }
}
```

#### 方案 C：角色系统

引入角色系统，不同角色有不同权限：

```jsonc
// agent/config.json
{
  "roles": {
    "vip": {
      "permissionMode": "bypass",
      "allowedParams": ["*"]
    },
    "guest": {
      "permissionMode": "readonly",
      "allowedParams": []
    }
  }
}
```

### 待决策的问题

1. **哪些参数应该是"人类专属"？**
   - 身份参数（aid, owners, admins）
   - 基础设施（aun, channels, projects）
   - 调试参数（debug）
   - 安全参数（permissionMode）

2. **Agent 可以修改哪些参数？**
   - 模型选择（active_baseagent, baseagents.*.model）
   - 对话模式（chatmode）
   - 交互参数（flush_delay, debounce, show_activities）
   - 渲染模式（render）

3. **权限检查在哪里实施？**
   - CLI 命令层（`ec config set` 检查调用方身份）
   - ConfigManager.write() 层（统一权限检查）

---

## 五、审计日志

### 配置变更审计

每次配置变更记录：

```jsonl
{"timestamp":"2026-06-19T10:30:00Z","caller":"human","command":"ec config set chatmode.private proactive","target":"agent/bot1","field":"chatmode.private","oldValue":"interactive","newValue":"proactive"}
{"timestamp":"2026-06-19T10:35:00Z","caller":"agent:bot1","command":"ec model use opus","target":"agent/bot1","field":"baseagents.claude.model","oldValue":"sonnet","newValue":"opus"}
```

### 审计日志位置

```
{evolclaw_home}/logs/config-audit.jsonl
```

### 保留策略

- 保留最近 30 天
- 超过 30 天归档到 `logs/archive/config-audit-{YYYY-MM}.jsonl`

---

## 六、安全最佳实践

### 1. 最小权限原则

- 默认禁止，显式允许
- Agent 只能访问必需的参数
- 敏感参数（owners, admins）仅人类可修改

### 2. 凭证分离

- 所有凭证存 `.env`
- 配置 JSON 只存引用
- 不在配置文件中硬编码凭证

### 3. 审计可追溯

- 记录所有配置变更
- 标注变更来源（human / agent）
- 定期审查审计日志

### 4. 快照保护

- 定期自动快照
- 快照不包含凭证
- 支持快速回滚

### 5. Hook 严格拦截

- 禁止直接文件访问
- 强制走 CLI/API
- 监控异常访问

---

## 七、权限体系实现路径

### 阶段 1：基础拦截（已完成）

- ✅ Hook 拦截配置文件直接访问
- ✅ Hook 拦截 .env 文件访问
- ✅ ConfigManager 统一读写入口

### 阶段 2：参数级权限（待实现）

- [ ] 在 schema 中标注参数权限（x-permission）
- [ ] CLI 命令检查调用方身份
- [ ] ConfigManager.write() 实施权限检查
- [ ] 定义"人类专属参数"清单

### 阶段 3：审计日志（待实现）

- [ ] 记录所有配置变更
- [ ] 标注变更来源和原因
- [ ] 提供审计查询 CLI（`ec config audit`）

### 阶段 4：角色系统（未来）

- [ ] 引入角色概念（vip, normal, guest）
- [ ] 角色级权限配置
- [ ] 动态权限调整

---

## 九、权限检查流程详解

### 检查时机

配置修改时的权限检查发生在以下时机：

```
CLI 命令接收
  ↓
1. 身份识别（caller: human / agent:aid / eck:user）
  ↓
2. 操作类型判定（read / write / snapshot / restore）
  ↓
3. 参数级权限检查（是否允许该 caller 操作该 field）
  ↓
4. 作用域权限检查（是否允许操作该 agent/relation）
  ↓
5. 执行操作
  ↓
6. 记录审计日志
```

### 身份识别

```typescript
function identifyCaller(context: CommandContext): Caller {
  // 1. 检查是否是 ECK 请求
  if (context.source === 'eck') {
    return {
      type: 'eck',
      user: context.eckUser,
      ip: context.ip
    };
  }
  
  // 2. 检查是否是 agent 托管环境
  if (process.env.EVOLCLAW_CTL_TOKEN) {
    return {
      type: 'agent',
      aid: context.agentId
    };
  }
  
  // 3. 默认人类
  return {
    type: 'human',
    user: process.env.USER || 'unknown'
  };
}
```

### 参数级权限检查

```typescript
function checkFieldPermission(caller: Caller, field: string, operation: 'read' | 'write'): boolean {
  // 读操作：所有人都可以
  if (operation === 'read') {
    return true;
  }
  
  // 写操作：检查字段权限
  const fieldMeta = getFieldMeta(field);
  
  // 人类专属字段
  if (fieldMeta.permission === 'human-only') {
    return caller.type === 'human';
  }
  
  // owner 专属字段
  if (fieldMeta.permission === 'owner-only') {
    return caller.type === 'human' || isOwner(caller);
  }
  
  // 可配置字段（默认）
  return true;
}
```

### 作用域权限检查

```typescript
function checkScopePermission(caller: Caller, target: ConfigTarget, selector: Selector): boolean {
  // process / defaults 层：仅人类
  if (target === ConfigTarget.Process || target === ConfigTarget.Defaults) {
    return caller.type === 'human';
  }
  
  // agent 层：owner 或本 agent
  if (target === ConfigTarget.Agent) {
    if (caller.type === 'human') return true;
    if (caller.type === 'agent' && caller.aid === selector.self) return true;
    return isOwner(caller, selector.self);
  }
  
  // relation 层：owner 或本 agent
  if (target === ConfigTarget.Relation) {
    if (caller.type === 'human') return true;
    if (caller.type === 'agent' && caller.aid === selector.self) return true;
    return isOwner(caller, selector.self);
  }
  
  return false;
}
```

### 完整检查流程

```typescript
export function checkPermission(
  caller: Caller,
  operation: 'read' | 'write' | 'snapshot' | 'restore',
  target: ConfigTarget,
  selector: Selector,
  field?: string
): PermissionCheckResult {
  // 1. 操作类型权限
  if (operation === 'snapshot' || operation === 'restore') {
    if (caller.type !== 'human') {
      return { allowed: false, reason: '只有人类可以创建快照或恢复版本' };
    }
  }
  
  // 2. 作用域权限
  if (!checkScopePermission(caller, target, selector)) {
    return { allowed: false, reason: `无权操作 ${target} 层级` };
  }
  
  // 3. 参数级权限（如果指定了 field）
  if (field && !checkFieldPermission(caller, field, operation)) {
    return { allowed: false, reason: `无权修改字段 ${field}` };
  }
  
  // 4. 通过所有检查
  return { allowed: true };
}
```

---

## 十、操作审批机制（未来）

### 设计目标

对于高风险操作，引入审批流程：

- Agent 发起修改请求
- Owner 审批
- 审批通过后执行

### 需要审批的操作

| 操作 | 审批条件 | 审批者 |
|------|---------|--------|
| 修改 `owners` 字段 | 总是需要 | 现有 owner |
| 修改 `channels` | 总是需要 | owner |
| 修改 `aun` 配置 | 总是需要 | owner |
| 批量修改（>5 个 agent） | 总是需要 | owner |
| 恢复快照版本 | 总是需要 | owner |
| 修改 `permissionMode` | agent 发起时 | owner |

### 审批流程

```
Agent 发起修改请求
  ↓
系统创建待审批任务
  ↓
通知 owner（AUN 消息 / 邮件）
  ↓
Owner 审查变更详情
  ↓
Owner 决策：批准 / 拒绝 / 修改后批准
  ↓
系统执行（批准）或丢弃（拒绝）
  ↓
通知 agent 结果
```

### 实现示例（伪代码）

```typescript
// Agent 发起修改
async function agentRequestConfigChange(
  agentId: string,
  target: ConfigTarget,
  selector: Selector,
  field: string,
  value: any
): Promise<string> {
  // 检查是否需要审批
  if (requiresApproval(field)) {
    // 创建待审批任务
    const taskId = await approvalQueue.create({
      requester: agentId,
      operation: 'config.set',
      target,
      selector,
      field,
      value,
      status: 'pending'
    });
    
    // 通知 owner
    await notifyOwners(selector.self, {
      message: `Agent ${agentId} 请求修改 ${field} → ${value}`,
      actions: ['批准', '拒绝', '查看详情']
    });
    
    return taskId;
  } else {
    // 直接执行
    configManager.write(target, { [field]: value }, { selector, merge: true });
    return 'completed';
  }
}

// Owner 审批
async function ownerApprove(taskId: string, ownerId: string): Promise<void> {
  const task = await approvalQueue.get(taskId);
  
  // 验证 owner 身份
  if (!isOwner(ownerId, task.selector.self)) {
    throw new Error('Not owner');
  }
  
  // 执行修改
  configManager.write(task.target, { [task.field]: task.value }, {
    selector: task.selector,
    merge: true
  });
  
  // 更新任务状态
  await approvalQueue.update(taskId, { status: 'approved', approver: ownerId });
  
  // 通知 agent
  await notifyAgent(task.requester, `配置修改已批准: ${task.field}`);
}
```

---

## 十一、循环引用检测

### 问题场景

凭证引用可能形成循环：

```bash
# global .env
FOO=${BAR}

# agent .env
BAR=${FOO}

# 循环！
```

### 检测算法

```typescript
function expandEnvRefs(
  value: string,
  selector: Selector,
  visited: Set<string> = new Set()
): string {
  if (!value.startsWith('${') || !value.endsWith('}')) {
    return value;
  }
  
  const varName = value.slice(2, -1);
  
  // 检测循环引用
  if (visited.has(varName)) {
    throw new Error(`循环引用检测: ${Array.from(visited).join(' → ')} → ${varName}`);
  }
  
  visited.add(varName);
  
  // 按优先级查找变量
  const rawValue = lookupEnv(varName, selector);
  if (!rawValue) {
    return value; // 保持原样
  }
  
  // 递归展开
  return expandEnvRefs(rawValue, selector, visited);
}
```

### 示例

```bash
# global .env
A=${B}
B=${C}
C=hello

# 正常：A → B → C → "hello"
```

```bash
# global .env
A=${B}
B=${A}

# 错误：循环引用检测: A → B → A
```

---

## 十二、凭证轮换策略

### 为什么需要轮换

- 定期更换凭证降低泄露风险
- 员工离职时更换相关凭证
- 疑似泄露时紧急轮换

### 轮换流程

```
1. 生成新凭证（在服务提供方）
  ↓
2. 更新 .env 文件（添加 _NEW 后缀）
  ↓
3. 测试新凭证（启动测试 agent）
  ↓
4. 切换到新凭证（重命名变量）
  ↓
5. 重启生产 agent
  ↓
6. 验证生产正常
  ↓
7. 吊销旧凭证
```

### 零停机轮换

使用双凭证策略：

```bash
# 步骤 1：添加新凭证
# agent/.env
FEISHU_APP_SECRET=${FEISHU_APP_SECRET_V2}  # 切换引用
FEISHU_APP_SECRET_V1=old_secret            # 保留旧凭证
FEISHU_APP_SECRET_V2=new_secret            # 新凭证

# 步骤 2：重启 agent（使用新凭证）

# 步骤 3：验证 24 小时

# 步骤 4：删除旧凭证
# agent/.env
FEISHU_APP_SECRET=new_secret
```

### 批量轮换脚本

```bash
#!/bin/bash
# rotate-feishu-secrets.sh

AGENTS=$(ec agent list --format json | jq -r '.[].aid')

for AID in $AGENTS; do
  ENV_FILE=~/.evolclaw/agents/$AID/.env
  
  echo "轮换 $AID 的飞书凭证..."
  
  # 生成新凭证（调用飞书 API）
  NEW_SECRET=$(generate_new_feishu_secret "$AID")
  
  # 备份旧 .env
  cp "$ENV_FILE" "$ENV_FILE.backup"
  
  # 更新 .env（添加 _V2）
  echo "FEISHU_APP_SECRET_V2=$NEW_SECRET" >> "$ENV_FILE"
  sed -i 's/FEISHU_APP_SECRET=/FEISHU_APP_SECRET_V1=/' "$ENV_FILE"
  echo "FEISHU_APP_SECRET=\${FEISHU_APP_SECRET_V2}" >> "$ENV_FILE"
  
  echo "✓ $AID 凭证已更新，请重启 agent"
done
```

---

## 十三、安全事件响应

### 场景 1：凭证泄露

**立即行动**：
```bash
# 1. 吊销泄露的凭证（在服务提供方）
# 2. 生成新凭证
# 3. 批量更新所有 agent
./rotate-secrets.sh --force

# 4. 重启所有 agent
ec restart --all

# 5. 审计日志检查
grep "FEISHU_APP_SECRET" ~/.evolclaw/logs/config-audit.jsonl
```

### 场景 2：配置被篡改

**检测**：
```bash
# 对比当前配置与最近快照
ec config diff $(ec config current) v200
```

**恢复**：
```bash
# 恢复到已知好版本
ec config restore v200

# 或使用自检模式
ec start --diagnose
```

### 场景 3：权限提升攻击

**检测**：
```bash
# 检查 owners 字段的修改历史
grep '"field":"owners"' ~/.evolclaw/logs/config-audit.jsonl

# 检查可疑的权限修改
grep '"field":"permissionMode"' ~/.evolclaw/logs/config-audit.jsonl
```

**响应**：
```bash
# 1. 恢复正确的 owners 配置
ec config set owners '["正确的owner1","正确的owner2"]' --self bot1

# 2. 审查所有 agent 的 owners
ec config get owners --self bot1
ec config get owners --self bot2

# 3. 创建快照
ec config snapshot --desc "修复权限提升攻击"
```

---

## 十四、安全加固建议

### 1. 最小权限原则

```bash
# 为每个 agent 只配置必需的渠道
# ❌ 不好：配置所有渠道
channels: [feishu, wechat, dingtalk, slack]

# ✅ 好：只配置使用的渠道
channels: [feishu]
```

### 2. 定期审计

```bash
# 每周审计脚本
#!/bin/bash

echo "=== 权限审计 ==="
for AID in $(ec agent list --format json | jq -r '.[].aid'); do
  OWNERS=$(ec config get owners --self "$AID" --format json)
  echo "$AID: $OWNERS"
done

echo ""
echo "=== 凭证审计 ==="
find ~/.evolclaw -name ".env" -exec grep -H "SECRET\|TOKEN\|KEY" {} \;

echo ""
echo "=== 配置修改审计 ==="
tail -100 ~/.evolclaw/logs/config-audit.jsonl | jq -r '.field' | sort | uniq -c | sort -rn
```

### 3. 分离环境

```bash
# 开发环境
~/.evolclaw-dev/

# 生产环境
~/.evolclaw-prod/

# 不要共享 .env
```

### 4. Hook 强化

```typescript
// 禁止 agent 读取配置文件
if (isAgentProcess() && isConfigFile(path)) {
  throw new Error('禁止 agent 直接访问配置文件');
}

// 禁止 agent 执行危险命令
if (isAgentProcess() && isDangerousCommand(cmd)) {
  throw new Error('禁止 agent 执行危险命令');
}
```

### 5. 网络隔离

```bash
# 生产 agent 只能访问白名单域名
# 通过防火墙或网络策略实现
```

---

## 八、安全检查清单

在部署前检查：

- [ ] 所有凭证已移入 `.env`
- [ ] 配置文件中无硬编码凭证
- [ ] Hook 已启用并测试生效
- [ ] ConfigManager 是唯一配置读写入口
- [ ] CLI 命令权限检查已实施
- [ ] 审计日志已启用
- [ ] 快照机制已启用
- [ ] 定期备份策略已配置

---

## 相关文档

- [01-overview.md](./01-overview.md) - 总体架构
- [04-config-manager.md](./04-config-manager.md) - ConfigManager API
- [06-cli-commands.md](./06-cli-commands.md) - CLI 命令
- [code-refactoring-plan.md](./code-refactoring-plan.md) - 代码改造清单
