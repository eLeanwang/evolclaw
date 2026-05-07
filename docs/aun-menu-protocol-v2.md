# AUN 远程菜单协议扩展方案：多级菜单、参数自动组装与 Skills 发现

## Context

AUN CLI 现有一级远程命令菜单（`menu.query` / `menu.response`），用户选择命令后直接作为文本发送。服务端对 Feishu 渠道会返回交互卡片（`InteractionRequest`）供用户点选，但 AUN 渠道不支持交互卡片，命令只能降级为纯文本列表。

### 目标

1. 在现有菜单协议基础上扩展多级菜单能力，让用户通过补全菜单逐级选择参数，最终拼接为一条完整的文本命令发出
2. 不引入新的消息类型，不改动 `CommandHandler` 的命令处理逻辑
3. 支持远程 Agent 的 Skills 通过菜单暴露给调用侧，实现跨端 Skill 发现与调用

## 架构分层

```
┌─────────────────────────────────────────────────────────┐
│  上层应用（如 EvolClaw）                                  │
│                                                         │
│  1. 读取本地 Skills（自行解析格式，如 .md frontmatter）    │
│  2. 组装业务快捷指令（/model, /perm ...）                 │
│  3. 合并策略：                                            │
│     · 有快捷指令 → Skills 收拢到 "Skills" 分组            │
│     · 无快捷指令 → Skills 直接平铺到第一层                 │
│  4. 调用 SDK registerMenu() 注册最终菜单                   │
│  5. 注册 onSubMenuQuery() 处理动态子菜单                  │
├─────────────────────────────────────────────────────────┤
│  AUN SDK（通用层）                                       │
│                                                         │
│  · registerMenu(items) — 接收上层传入的菜单结构           │
│  · 收到 menu.query 时自动返回 menu.response               │
│  · 收到 menu.query + cmd 时分发给 onSubMenuQuery 回调     │
│  · 不感知 Skills 格式，不感知业务语义                      │
│  · 只负责协议机制：存储、查询、分发                        │
└─────────────────────────────────────────────────────────┘
```

### 职责边界

| 职责 | 归属 |
|------|------|
| Skills 目录发现、格式解析 | 上层应用 |
| 快捷指令定义 | 上层应用 |
| 合并策略（Skills 平铺 vs 收拢） | 上层应用 |
| 动态子菜单数据提供 | 上层应用 |
| menu.query / menu.response 协议 | AUN SDK |
| 菜单存储与返回 | AUN SDK |
| 子菜单请求分发 | AUN SDK |

### SDK API

```typescript
// 注册菜单（上层组装好后传入）
client.registerMenu(items: MenuGroup[]);

// 注册动态子菜单回调（可选）
client.onSubMenuQuery(handler: (cmd: string) => MenuItem[] | null);
```

### 上层使用示例（EvolClaw）

```typescript
// 读取 Skills（自行解析 .md frontmatter）
const skills = readClaudeSkills(projectPath);

// 组装快捷指令
const commands = cmdHandler.getMenuItems(isAdmin);

// 合并策略
if (commands.length > 0) {
  // 有快捷指令 → Skills 收拢到一个分组
  aunClient.registerMenu([...commands, { group: 'Skills', commands: skills }]);
} else {
  // 纯 Skills → 平铺
  aunClient.registerMenu(skills);
}

// 动态子菜单
aunClient.onSubMenuQuery((cmd) => {
  if (cmd === '/session delete') {
    return sessions.map(s => ({ value: s.name, label: s.name }));
  }
  return null;
});
```

## 协议设计

### 核心概念

- `cmd` — 命令片段，带 `/` 前缀（如 `/model`、`/perm`），出现在命令层级
- `value` — 参数值（如 `sonnet`、`bypass`、`delete`），出现在参数层级
- 两者不会同时出现在同一节点，拼接时都参与
- 没有 `cmd` 也没有 `value` 的节点是纯 UI 分组，不参与命令拼接
- 沿用 `menu.query` / `menu.response`，通过 `cmd` 字段区分全量菜单与子菜单

### 节点定义（统一结构，任意层级复用）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cmd` | string | 否 | 命令片段，带 `/` 前缀，参与拼接 |
| `value` | string | 否 | 参数值，参与拼接。与 `cmd` 互斥 |
| `label` | string | 是 | 菜单显示名 |
| `args` | string | 否 | 参数占位提示（`text` 类型时展示） |
| `desc` | string | 否 | 用途说明（CLI 显示给用户，也可供 agent 理解用途） |
| `next` | object | 否 | 下一级定义，无则为叶子节点（选中即发送） |

### `next` 定义

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `"select"` \| `"text"` | 选择列表 或 自由文本输入 |
| `items` | array | `select` 的静态选项，每项也是节点 |
| `dynamic` | bool | `select` 动态加载，触发 `menu.query` 子菜单查询 |

- `select` + `items`：静态选项，随一级菜单一次性返回
- `select` + `dynamic: true`：动态加载，用户到达该层级时发子菜单查询
- `text`：不自动发送，用户手动输入内容后按 Enter 发送

### 命令拼接规则

逐级收集有 `cmd` 或 `value` 的节点，空格拼接为最终命令：

```
cmd:/s → (dynamic 选择 value:dev)                        →  "/s dev"
cmd:/del → (dynamic 选择 value:prod)                     →  "/del prod"
cmd:/model → (dynamic 选择 value:opus)                   →  "/model opus"
cmd:/perm → value:bypass                                 →  "/perm bypass"
cmd:/new → (text 输入 "我的会话")                         →  "/new 我的会话"
cmd:/restart → (dynamic 选择 value:feishu)               →  "/restart feishu"
cmd:/agentmd → value:set → (text 输入 "内容")            →  "/agentmd set 内容"
cmd:/commit                                              →  "/commit"  (Skill 触发)
```

### 动态加载协议

沿用 `menu.query` / `menu.response`，通过 `cmd` 字段区分：

**全量菜单（现有行为）：**
```json
CLI   → { "type": "menu.query" }
服务端 → { "type": "menu.response", "items": [...] }
```

**子菜单（新增）：**
```json
CLI   → { "type": "menu.query", "cmd": "/session delete" }
服务端 → { "type": "menu.response", "cmd": "/session delete", "items": [...] }
```

服务端收到 `menu.query` 时判断：
- 无 `cmd` → 返回完整一级菜单（现有行为不变）
- 有 `cmd` → 调用 `onSubMenuQuery` 回调，返回该命令路径的子菜单选项

CLI 收到 `menu.response` 时判断：
- 无 `cmd` → 写入 `_pending_menu`（现有行为不变）
- 有 `cmd` → 写入 `_pending_sub_menu[cmd]`（供补全菜单读取）

旧客户端不发 `cmd`，行为完全兼容。

## 完整示例

### EvolClaw 实际菜单响应（owner / private）

```json
{
  "type": "menu.response",
  "items": [
    {
      "group": "项目管理",
      "commands": [
        { "cmd": "/pwd", "label": "显示当前项目路径", "desc": "查看当前会话绑定的项目目录" },
        { "cmd": "/p", "label": "列出或切换项目", "desc": "切换到其他已配置的项目", "next": { "type": "select", "dynamic": true } },
        { "cmd": "/bind", "args": "<path>", "label": "绑定新项目目录", "desc": "将当前会话绑定到指定项目路径", "next": { "type": "text" } }
      ]
    },
    {
      "group": "会话管理",
      "commands": [
        { "cmd": "/new", "label": "创建新会话", "desc": "清空历史，开始全新对话", "next": { "type": "text" } },
        { "cmd": "/s", "label": "切换会话", "desc": "切换到同项目下的其他会话", "next": { "type": "select", "dynamic": true } },
        { "cmd": "/name", "label": "重命名当前会话", "desc": "为当前会话设置一个易识别的名称", "next": { "type": "text" } },
        { "cmd": "/del", "label": "删除指定会话", "desc": "永久删除一个非活跃会话", "next": { "type": "select", "dynamic": true } },
        { "cmd": "/fork", "label": "分支当前会话", "desc": "基于当前会话创建独立分支", "next": { "type": "text" } },
        { "cmd": "/rewind", "args": "[N] [chat|file|all]", "label": "查看历史/撤销指定轮次", "desc": "回退会话到指定轮次，可选择撤销文件改动" },
        { "cmd": "/compact", "label": "压缩会话上下文", "desc": "将长对话压缩为摘要以节省 token" }
      ]
    },
    {
      "group": "Agent 与模型",
      "commands": [
        { "cmd": "/agent", "label": "切换 Agent 后端", "desc": "切换当前会话使用的 AI 后端", "next": { "type": "select", "dynamic": true } },
        { "cmd": "/model", "label": "切换模型", "desc": "切换当前 Agent 使用的模型版本", "next": { "type": "select", "dynamic": true } },
        {
          "cmd": "/effort", "label": "切换推理强度", "desc": "调整模型推理深度，影响响应速度与质量",
          "next": {
            "type": "select",
            "items": [
              { "value": "low", "label": "Low" },
              { "value": "medium", "label": "Medium" },
              { "value": "high", "label": "High" },
              { "value": "max", "label": "Max" }
            ]
          }
        }
      ]
    },
    {
      "group": "权限管理",
      "commands": [
        {
          "cmd": "/perm", "label": "权限模式管理", "desc": "控制工具调用的审批策略",
          "next": {
            "type": "select",
            "items": [
              { "value": "auto", "label": "自动模式", "desc": "根据风险等级自动决定是否审批" },
              { "value": "bypass", "label": "免审批模式", "desc": "跳过所有工具审批确认" },
              { "value": "plan", "label": "计划模式", "desc": "仅允许只读操作，写操作需审批" },
              { "value": "edit", "label": "编辑模式", "desc": "允许文件编辑，其他操作需审批" },
              { "value": "request", "label": "请求模式", "desc": "所有操作均需审批" },
              { "value": "noask", "label": "静默模式", "desc": "不弹出审批，自动拒绝未授权操作" },
              { "value": "allow", "label": "允许此操作", "desc": "本次允许当前待审批操作" },
              { "value": "always", "label": "始终允许", "desc": "永久允许同类操作" },
              { "value": "deny", "label": "拒绝此操作", "desc": "拒绝当前待审批操作" }
            ]
          }
        }
      ]
    },
    {
      "group": "运维",
      "commands": [
        { "cmd": "/status", "label": "显示会话状态", "desc": "查看当前会话、项目、Agent 的详细状态" },
        { "cmd": "/stop", "label": "中断当前任务", "desc": "立即中断正在执行的 Agent 任务" },
        { "cmd": "/check", "label": "检查渠道状态", "desc": "检查各消息渠道的连接健康状态" },
        {
          "cmd": "/activity", "label": "控制中间输出显示", "desc": "设置工具调用过程的可见范围",
          "next": {
            "type": "select",
            "items": [
              { "value": "all", "label": "全部显示", "desc": "所有用户均可见中间输出" },
              { "value": "dm", "label": "仅私聊", "desc": "仅私聊中显示中间输出" },
              { "value": "owner", "label": "仅 owner 私聊", "desc": "仅 owner 的私聊中显示" },
              { "value": "none", "label": "不显示", "desc": "关闭所有中间输出" }
            ]
          }
        },
        { "cmd": "/restart", "label": "重启/重连", "desc": "重启服务或重连指定渠道", "next": { "type": "select", "dynamic": true } },
        { "cmd": "/file", "args": "[channel] <path>", "label": "发送项目内文件", "desc": "将项目目录内的文件发送给用户" },
        {
          "cmd": "/agentmd", "label": "管理 agent.md", "desc": "查看或更新 AUN 网络上的 agent.md 身份文件",
          "next": {
            "type": "select",
            "items": [
              { "value": "put", "label": "上传当前", "desc": "将本地 agent.md 上传到 AUN 网络" },
              { "value": "set", "label": "直接设置", "desc": "输入内容直接更新 agent.md", "next": { "type": "text" } }
            ]
          }
        }
      ]
    },
    {
      "group": "帮助",
      "commands": [
        { "cmd": "/help", "label": "显示帮助信息", "desc": "列出所有可用命令及说明" }
      ]
    }
  ]
}
```

### 动态子菜单响应示例

**`/s` 会话列表：**
```json
{
  "type": "menu.response",
  "cmd": "/s",
  "items": [
    { "value": "dev", "label": "dev", "desc": "abcdef12 · 1分钟前" },
    { "value": "prod", "label": "prod", "desc": "11223344 · 1小时前" },
    { "value": "cli", "label": "查看 CLI 会话", "desc": "列出未导入的 CLI 本地会话" }
  ]
}
```

**`/p` 项目列表：**
```json
{
  "type": "menu.response",
  "cmd": "/p",
  "items": [
    { "value": "evolclaw", "label": "evolclaw", "desc": "/home/evolclaw" },
    { "value": "hermes", "label": "hermes", "desc": "/home/projects/hermes-agent" }
  ]
}
```

**`/restart` 渠道列表（owner）：**
```json
{
  "type": "menu.response",
  "cmd": "/restart",
  "items": [
    { "value": "", "label": "重启服务", "desc": "重启整个 EvolClaw 服务进程" },
    { "value": "feishu", "label": "feishu", "desc": "重连此渠道" },
    { "value": "wechat", "label": "wechat", "desc": "重连此渠道" },
    { "value": "aun", "label": "aun", "desc": "重连此渠道" }
  ]
}
```

### Skills 合并示例（暂未实现）

有快捷指令时，Skills 收拢到独立分组：

```json
{
  "group": "Skills",
  "commands": [
    { "cmd": "/commit", "label": "提交代码", "desc": "生成 commit message 并提交" },
    { "cmd": "/review", "label": "代码审查", "desc": "审查当前分支的改动" },
    { "cmd": "/init", "label": "初始化项目", "desc": "生成 CLAUDE.md 项目文档" }
  ]
}
```

无快捷指令时，Skills 直接平铺到第一层：

```json
{
  "type": "menu.response",
  "items": [
    {
      "group": "开发",
      "commands": [
        { "cmd": "/commit", "label": "提交代码", "desc": "生成 commit message 并提交" },
        { "cmd": "/review", "label": "代码审查", "desc": "审查当前分支的改动" }
      ]
    }
  ]
}
```

## CLI 补全行为

| 场景 | 用户输入 | 补全菜单展示 | 行为 |
|------|----------|-------------|------|
| 一级菜单 | `/` | 所有一级命令 + Skills | 缓存加载 |
| 静态二级 | `/model` | sonnet / opus / haiku | 直接展示 `next.items` |
| 动态二级 | `/session delete` | 加载中... → 会话列表 | 发 `menu.query` + `cmd` |
| text 类型 | `/new` | `/new <名称>` (灰色提示) | 不自动发送，等用户输入 |
| 纯分组 | 权限 | /perm / /safe | 无 `cmd`/`value`，不拼接 |
| 叶子节点 | `/model opus` | — | 无 `next`，自动发送 |
| Skill 调用 | `/commit` | — | 无 `next`，自动发送，Agent 执行 Skill |

## 改动范围

### AUN SDK

本次不走 SDK `registerMenu()` / `onSubMenuQuery()` 路径，沿用现有自定义消息方式（`handleCustomPayload` 拦截 `menu.query`）。SDK API 保留为未来可选升级。

### 上层应用（EvolClaw）— 已实现

**节点字段**：使用 `label` 作为显示名字段。新增 `value`、`desc`、`next` 字段，旧客户端忽略即可。所有命令节点均已补全 `desc` 文案。

**`getMenuItems(role, chatType)`**（`src/core/command-handler.ts`）：
- 命令节点加 `next` 字段：
  - `text` 类型：`/new`、`/name`、`/bind`、`/fork`
  - `select` + `dynamic`：`/s`、`/del`、`/p`、`/agent`、`/model`、`/restart`
  - `select` + 静态 `items`：
    - `/effort` → low / medium / high / max
    - `/perm` → auto / bypass / plan / edit / request / noask（owner-only）+ allow / always / deny（所有 admin）
    - `/activity` → all / dm / owner / none
    - `/agentmd` → put / set（set 有嵌套 `next: { type: 'text' }`）
  - 叶子命令（`/pwd`、`/compact`、`/help`、`/status`、`/stop`、`/check` 等）无 `next`
- `/restart` 合并为单一入口（admin+），子菜单动态返回渠道列表 + owner 额外看到"重启服务"选项

**`getSubMenuItems(cmd, channel, channelId, userId?)`**（`src/core/command-handler.ts`，新增）：
- `/s` → 会话列表（desc 含 agentSessionId 前 8 位 + 相对时间）+ 末尾追加 `cli` 选项
- `/del` → 会话列表（排除当前活跃会话，无 `cli` 选项）
- `/p` → `config.projects.list` 中的项目名（desc 为绝对路径）
- `/agent` → 已注册的 agent 列表
- `/model` → 调用 `agent.listModels()`，不支持时返回 `null`
- `/restart` → 已注册渠道列表（owner 额外前置"重启服务"选项）
- 未知 `cmd` → 返回 `null`

**`handleCustomPayload()`**（`src/core/message/message-bridge.ts`）：
- 有 `cmd` → 调用 `getSubMenuItems()`，返回 `{ type: 'menu.response', cmd, items }`
- 无 `cmd` → 走原有全量菜单路径（行为不变）

**裸命令保护**：`/name`、`/rename`、`/bind` 无参数时返回用法提示，不再透传给 agent。

**暂未实现**：
- Skills 读取合并（解析 `~/.claude/skills/*.md` frontmatter，追加到菜单）

### AUN CLI（客户端）

- `AUNCompleter`：支持多级补全、动态加载、text 类型处理
- `_on_message`：处理带 `cmd` 的 `menu.response`，写入 `_pending_sub_menu`
- 补全行为：叶子节点 select 自动发送，text 类型不自动发送
