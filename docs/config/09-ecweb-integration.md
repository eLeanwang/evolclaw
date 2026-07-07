# ECWeb 配置管理对接

> EvolClaw 配置体系 v3 - 补充文档
> 相关：[06-cli-commands.md](./06-cli-commands.md)

---

## 一、ECWeb 是什么

ECWeb 是 EvolClaw 的 Web 管理控制台，提供配置的图形化管理界面。

**访问地址**：`http://localhost:{ecweb.port}/` (默认 8080)

**启用方式**：
```jsonc
// evolclaw.json
{
  "ecweb": {
    "enabled": true,
    "port": 8080
  }
}
```

---

## 二、ECWeb 配置管理功能

### 2.1 配置浏览

**功能**：
- 查看所有层级的配置文件
- 支持 process / defaults / agent / relation 层级切换
- 实时显示合并后的 effective 配置
- 高亮显示每个参数的来源层级

**界面**：
```
┌─────────────────────────────────────────┐
│ EvolClaw 配置管理                        │
├─────────────────────────────────────────┤
│ 层级选择：                               │
│  ○ Process  ○ Defaults  ● Agent  ○ Relation │
│                                          │
│ Agent: bot1.aid.pub    Peer: (none)      │
├─────────────────────────────────────────┤
│ 参数列表：                               │
│                                          │
│ chatmode.private = proactive             │
│   来源: relation > aun#alice             │
│   解析链: defaults:(undefined) → agent:interactive → relation:proactive ✓ │
│                                          │
│ baseagents.claude.model = opus           │
│   来源: agent                             │
│   解析链: defaults:opus → agent:opus ✓   │
│                                          │
│ flush_delay = 3                          │
│   来源: defaults                          │
│   解析链: defaults:3 ✓                   │
└─────────────────────────────────────────┘
```

### 2.2 配置编辑

**功能**：
- 在线编辑配置参数
- Schema 验证（实时）
- 预览变更影响范围
- 一键应用或撤销

**编辑流程**：
1. 选择层级和 agent/relation
2. 点击参数进入编辑模式
3. 修改值，实时 schema 验证
4. 预览：显示影响的对端数量
5. 应用：调用 `ec config set` 写入

**权限控制**：
- 需要 owner 权限才能编辑
- 编辑操作记录审计日志
- 支持只读模式（viewer 角色）

### 2.3 快照管理

**功能**：
- 查看快照历史（列表 + 时间线）
- 对比两个版本的差异（可视化 diff）
- 创建手动快照
- 恢复到指定版本（需确认）
- 查看启动日志

**快照时间线**：
```
v205 ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━● (当前)
     2026-06-19 10:30  startup
     捕获 alice 的 chatmode 改动
     successCount: 5
     
v204 ●
     2026-06-19 09:15  manual
     调整模型配置
     successCount: 3
     
v203 ●
     2026-06-18 22:00  startup
     捕获人工编辑
     successCount: 8
     
v200 ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━● (全量)
     2026-06-18 18:00  manual --full
     手动全量快照
     successCount: 12
```

### 2.4 版本对比

**功能**：
- 选择两个版本进行对比
- 参数级差异（新增/修改/删除）
- 文件级差异（哪些文件变了）
- 支持导出对比报告

**对比界面**：
```
┌─────────────────────────────────────────┐
│ 版本对比: v200 ↔ v205                    │
├─────────────────────────────────────────┤
│ 变更文件: 2                              │
│  ✓ agents/bot1.aid.pub/config.json       │
│  ✓ agents/bot1.aid.pub/relations/aun#alice.aid.pub/config.json │
│                                          │
│ 参数变更: 4                              │
│                                          │
│ agents/bot1.aid.pub/config.json:         │
│  - chatmode.private: interactive → proactive │
│  - baseagents.claude.model: sonnet → opus │
│                                          │
│ relations/aun#alice.aid.pub/config.json: │
│  + baseagents.claude.effort: max (新增)  │
│  - flush_delay: 5 (删除)                 │
└─────────────────────────────────────────┘
```

---

## 三、ECWeb 与 CLI 的关系

### 数据流

```
ECWeb UI
    ↓ (HTTP API)
ecweb 后端
    ↓ (调用)
ConfigManager
    ↓ (读写)
配置文件
```

**关键点**：
- ECWeb 不直接操作配置文件
- 所有操作通过 ConfigManager API
- 与 CLI 共享同一套权限体系
- 操作结果实时同步（WebSocket）

### API 端点

**注意**：当前 ECWeb 主要提供角色管理相关的 API，通用配置管理 API（`/api/config/*`）尚未实现。配置管理请使用 CLI 命令 `ec config`。

当前可用的 API：

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/roles/*` | GET/POST | 角色分配管理 |
| `/api/role-definitions/*` | GET/POST | 角色定义管理 |
| `/api/assignments/peer/*` | GET/POST | 对端角色分配 |
| `/api/stats/*` | GET | 统计数据 |
| `/api/models/*` | GET | 模型信息 |
| `/api/available-baseagents` | GET | 可用的 base agent |
| `/api/pair-code` | GET | 获取配对码 |

**权限验证**：
- 所有 API 需要 token 认证（通过配对码获取）
- 当前主要用于 ECWeb 面板的只读展示和角色管理
- 配置修改操作请使用 CLI

---

## 四、实时同步机制

### WebSocket 通道

ECWeb 使用 WebSocket 实现配置变更的实时推送：

```
浏览器 ←━━ WebSocket ━━→ ecweb 后端
                            ↓
                        ConfigManager
                            ↓
                        文件监听器
```

**事件类型**：
- `config:changed` - 配置文件变更
- `config:snapshot:created` - 新快照创建
- `config:restored` - 版本恢复
- `agent:reloaded` - Agent 重新加载配置

**客户端处理**：
```javascript
ws.on('config:changed', (event) => {
  // event: { target, selector, field, oldValue, newValue }
  // 更新 UI 显示
  updateConfigView(event);
});
```

---

## 五、配置编辑器特性

### Schema 感知编辑

**功能**：
- 自动加载对应 schema
- 类型提示（string/number/bool/list/dict）
- 枚举值下拉选择
- 必填字段标注
- 实时验证错误提示

**示例**：
```
参数: chatmode.private
类型: string
可选值: ▼ interactive, proactive
必填: 否
当前值: [proactive ▼]
说明: 私聊对话模式。interactive=直接输出即回复；proactive=须显式发送
```

### 凭证保护

**规则**：
- 凭证字段（`${VAR}`）显示占位符
- 不支持在线编辑凭证
- 提示："凭证需通过 .env 文件管理"

**显示示例**：
```
channels[0].appSecret: ${FEISHU_APP_SECRET} 🔒
  提示: 凭证不可在线编辑，请修改对应 .env 文件
```

---

## 六、批量操作

### 批量修改

**功能**：
- 同时修改多个 agent 的相同参数
- 预览影响范围
- 一键应用

**界面**：
```
┌─────────────────────────────────────────┐
│ 批量修改配置                              │
├─────────────────────────────────────────┤
│ 目标: 所有 agent                          │
│  ☑ bot1.aid.pub                          │
│  ☑ bot2.aid.pub                          │
│  ☑ bot3.aid.pub                          │
│                                          │
│ 参数: chatmode.private                   │
│ 新值: proactive                          │
│                                          │
│ 影响: 3 个 agent                          │
│                                          │
│ [预览变更]  [应用]  [取消]                │
└─────────────────────────────────────────┘
```

### 批量导入/导出

**功能**：
- 导出配置为 JSON
- 导入配置（覆盖或合并）
- 支持部分导入（选择性）

**导出格式**：
```json
{
  "export_time": "2026-06-19T10:30:00Z",
  "scope": "agent",
  "selector": {"self": "bot1.aid.pub"},
  "config": {
    "chatmode": {"private": "proactive"},
    "baseagents": {"claude": {"model": "opus"}}
  }
}
```

---

## 七、安全特性

### 审计日志集成

所有通过 ECWeb 的操作都记录到审计日志：

```jsonl
{"timestamp":"2026-06-19T10:30:00Z","source":"ecweb","user":"admin","ip":"192.168.1.100","action":"config.set","target":"agent/bot1","field":"chatmode.private","oldValue":"interactive","newValue":"proactive"}
```

### 权限控制

| 角色 | 读配置 | 写配置 | 创建快照 | 恢复版本 |
|------|--------|--------|---------|---------|
| owner | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✅ | ❌ |
| viewer | ✅ | ❌ | ❌ | ❌ |

### 操作确认

高风险操作需要二次确认：
- 恢复版本
- 批量修改
- 删除配置

---

## 八、开发对接

### 后端实现

```typescript
// src/ecweb/config-routes.ts
export function registerConfigRoutes(app: Express) {
  // 读取配置
  app.get('/api/config/get', async (req, res) => {
    const { target, self, peer } = req.query;
    const selector = { self, peerKey: peer };
    const config = configManager.read(target as ConfigTarget, selector);
    res.json(config);
  });
  
  // 修改配置
  app.post('/api/config/set', async (req, res) => {
    const { target, selector, field, value } = req.body;
    // 权限检查
    if (!hasPermission(req.user, 'config:write')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // 写入
    configManager.write(target, { [field]: value }, { selector, merge: true });
    // 广播变更
    wss.broadcast('config:changed', { target, selector, field, value });
    res.json({ success: true });
  });
  
  // 更多端点...
}
```

### 前端集成

```typescript
// 读取配置
const config = await fetch('/api/config/effective?self=bot1.aid.pub')
  .then(r => r.json());

// 修改配置
await fetch('/api/config/set', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    target: 'agent',
    selector: { self: 'bot1.aid.pub' },
    field: 'chatmode.private',
    value: 'proactive'
  })
});

// 监听变更
ws.on('config:changed', (event) => {
  console.log('Config changed:', event);
});
```

---

## 九、使用场景

### 场景 1：快速调整 VIP 用户配置

1. 打开 ECWeb
2. 选择 relation 层级
3. 选择 agent=bot1, peer=aun#alice
4. 修改 `baseagents.claude.model` → `opus`
5. 修改 `baseagents.claude.effort` → `max`
6. 应用，实时生效

### 场景 2：批量更新所有 agent 的默认模型

1. 切换到 defaults 层级
2. 修改 `models.default` → `opus`
3. 预览影响：所有 agent（除非显式覆盖）
4. 应用

### 场景 3：故障回滚

1. 打开快照管理
2. 查看启动日志，发现 v205 启动失败
3. 对比 v205 和 v203
4. 发现问题参数
5. 恢复到 v203
6. 确认启动成功

---

## 十、与 CLI 的对比

| 功能 | CLI | ECWeb |
|------|-----|-------|
| 配置浏览 | `ec config show/get` | 可视化界面 |
| 配置编辑 | `ec config set` | 表单编辑 + 实时验证 |
| 快照管理 | `ec config snapshot/history/restore` | 时间线 + 可视化对比 |
| 批量操作 | 需脚本 | 内置批量功能 |
| 权限控制 | 基于 token | 基于 Web 认证 |
| 实时同步 | 无 | WebSocket 推送 |
| 学习曲线 | 需熟悉命令 | 直观易用 |

**建议**：
- 日常管理：优先使用 ECWeb
- 脚本自动化：使用 CLI
- 故障排查：CLI + ECWeb 配合

---

## 相关文档

- [01-overview.md](./01-overview.md) - 配置体系总体架构
- [06-cli-commands.md](./06-cli-commands.md) - CLI 命令参考
- [07-security.md](./07-security.md) - 安全与权限控制

---

## 术语澄清

**ECWeb** = EvolClaw Web Console，Web 管理控制台（本文档描述的系统）  
**ECK** = EvolClaw Context Kit，上下文组装系统（位于 `$KITS/`，为 base agent 组装身份/关系/环境/渠道层上下文）

两者**完全不同**，请勿混淆。
