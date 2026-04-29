# AUN 远程菜单协议 — 客户端集成指南

面向第三方客户端（App、Bot、Web UI）开发者，描述如何集成 AUN 远程菜单协议，实现快捷指令发现、多级参数选择和动态子菜单加载。

## 协议概览

AUN 远程菜单基于两种消息类型实现：

| 消息类型 | 方向 | 用途 |
|----------|------|------|
| `menu.query` | 客户端 → 服务端 | 请求菜单数据 |
| `menu.response` | 服务端 → 客户端 | 返回菜单数据 |

所有菜单消息通过 AUN 加密通道传输，与普通文本消息使用相同的 `message.send` 接口。

## 数据结构

### MenuGroup（顶层分组）

```typescript
interface MenuGroup {
  group: string;          // 分组名称，如 "会话管理"、"Agent 与模型"
  commands: MenuItem[];   // 该分组下的菜单项
}
```

### MenuItem（菜单节点）

```typescript
interface MenuItem {
  cmd?: string;     // 命令片段，带 / 前缀（如 "/model"），参与拼接
  value?: string;   // 参数值（如 "sonnet"），参与拼接。与 cmd 互斥
  label: string;    // 显示名称
  args?: string;    // 参数占位提示，text 类型时展示（如 "名称"）
  desc?: string;    // 用途说明
  next?: MenuNext;  // 下一级定义，无则为叶子节点
}
```

### MenuNext（下一级定义）

```typescript
interface MenuNext {
  type: 'select' | 'text';   // 选择列表 或 自由文本输入
  items?: MenuItem[];         // select 的静态选项
  dynamic?: boolean;          // select 动态加载，需发子菜单查询
}
```

### 节点类型判断

| 条件 | 节点类型 | 行为 |
|------|---------|------|
| 无 `next` | 叶子节点 | 选中即发送拼接后的命令 |
| `next.type == "select"` + `items` | 静态子菜单 | 直接展示 items |
| `next.type == "select"` + `dynamic: true` | 动态子菜单 | 发 `menu.query` + `cmd` 请求 |
| `next.type == "text"` | 文本输入 | 等待用户输入，不自动发送 |
| 无 `cmd` 也无 `value` | 纯 UI 分组 | 不参与命令拼接，仅展示其 `next.items` |

## 协议交互

### 1. 获取全量菜单

客户端连接后或需要刷新时，发送不带 `cmd` 的查询：

```
客户端 → 服务端:
{
  "type": "menu.query"
}

服务端 → 客户端:
{
  "type": "menu.response",
  "items": [ MenuGroup, ... ]
}
```

建议缓存返回结果（TTL 5 分钟），避免频繁查询。

### 2. 获取动态子菜单

当用户导航到 `next.dynamic == true` 的节点时，发送带 `cmd` 的查询：

```
客户端 → 服务端:
{
  "type": "menu.query",
  "cmd": "/session delete"
}

服务端 → 客户端:
{
  "type": "menu.response",
  "cmd": "/session delete",
  "items": [
    { "value": "重构会话", "label": "重构会话" },
    { "value": "测试会话", "label": "测试会话" }
  ]
}
```

`cmd` 字段是从根节点到当前节点的命令路径拼接结果（空格分隔）。

### 3. 区分响应类型

收到 `menu.response` 时：

```
if response.cmd 存在:
    → 子菜单响应，缓存到 subMenuCache[response.cmd]
else:
    → 全量菜单响应，替换主菜单缓存
```

## 命令拼接规则

用户逐级选择后，沿路径收集所有 `cmd` 和 `value` 字段，空格拼接为最终命令文本发送：

```
路径                                          拼接结果
────────────────────────────────────────────  ──────────────────
cmd:/model → value:opus                       /model opus
cmd:/session → value:delete → value:重构       /session delete 重构
cmd:/new → (text 输入 "我的会话")              /new 我的会话
cmd:/safe                                     /safe
(纯分组) → cmd:/perm → value:bypass           /perm bypass
```

规则：
1. 遇到 `cmd` 字段 → 追加到路径（保留 `/` 前缀）
2. 遇到 `value` 字段 → 追加到路径（无前缀）
3. 无 `cmd` 也无 `value` → 跳过（纯 UI 分组）
4. `text` 类型 → 追加用户输入的文本
5. 最终结果作为普通文本消息发送

## 完整交互示例

### 示例 1：静态子菜单（切换模型）

```
1. 用户打开菜单 → 客户端发 menu.query
2. 服务端返回全量菜单，其中包含：
   { "cmd": "/model", "label": "切换模型",
     "next": { "type": "select", "items": [
       { "value": "sonnet", "label": "Sonnet" },
       { "value": "opus", "label": "Opus" },
       { "value": "haiku", "label": "Haiku" }
     ]}}
3. 用户选择 /model → 展示 sonnet / opus / haiku
4. 用户选择 opus → 叶子节点，发送文本 "/model opus"
```

### 示例 2：动态子菜单（删除会话）

```
1. 全量菜单中包含：
   { "cmd": "/del", "label": "删除指定会话",
     "next": { "type": "select", "dynamic": true }}
2. 用户选择 /del → 检测到 dynamic，发送：
   { "type": "menu.query", "cmd": "/del" }
3. 服务端返回：
   { "type": "menu.response", "cmd": "/del", "items": [
     { "value": "重构会话", "label": "重构会话" },
     { "value": "测试会话", "label": "测试会话" }
   ]}
4. 用户选择 "重构会话" → 叶子节点，发送文本 "/del 重构会话"
```

### 示例 3：文本输入（新建会话）

```
1. 全量菜单中包含：
   { "cmd": "/new", "label": "创建新会话",
     "next": { "type": "text" }}
2. 用户选择 /new → 检测到 text 类型
3. 客户端显示输入框，提示 "名称"（来自 args 字段）
4. 用户输入 "前端重构" → 发送文本 "/new 前端重构"
```

### 示例 4：纯分组节点（权限管理）

```
1. 全量菜单中包含：
   { "group": "权限管理", "commands": [
     { "cmd": "/perm", "label": "权限模式管理",
       "next": { "type": "select", "items": [
         { "value": "bypass", "label": "免审批模式" },
         { "value": "plan", "label": "计划模式" }
       ]}}
   ]}
2. 用户选择 /perm → 展示 bypass / plan
3. 用户选择 bypass → 叶子节点，发送文本 "/perm bypass"
```

## 实际服务端响应参考

以下是 EvolClaw 服务端对 owner 角色返回的全量菜单结构（精简）：

```json
{
  "type": "menu.response",
  "items": [
    {
      "group": "项目管理",
      "commands": [
        { "cmd": "/pwd", "label": "显示当前项目路径" },
        { "cmd": "/p", "label": "列出或切换项目",
          "next": { "type": "select", "dynamic": true } },
        { "cmd": "/bind", "args": "<path>", "label": "绑定新项目目录",
          "next": { "type": "text" } }
      ]
    },
    {
      "group": "会话管理",
      "commands": [
        { "cmd": "/new", "label": "创建新会话",
          "next": { "type": "text" } },
        { "cmd": "/s", "label": "切换会话",
          "next": { "type": "select", "dynamic": true } },
        { "cmd": "/name", "label": "重命名当前会话",
          "next": { "type": "text" } },
        { "cmd": "/del", "label": "删除指定会话",
          "next": { "type": "select", "dynamic": true } },
        { "cmd": "/fork", "label": "分支当前会话",
          "next": { "type": "text" } },
        { "cmd": "/compact", "label": "压缩会话上下文" }
      ]
    },
    {
      "group": "Agent 与模型",
      "commands": [
        { "cmd": "/agent", "label": "切换 Agent 后端",
          "next": { "type": "select", "dynamic": true } },
        { "cmd": "/model", "label": "切换模型",
          "next": { "type": "select", "dynamic": true } },
        { "cmd": "/effort", "label": "切换推理强度",
          "next": { "type": "select", "items": [
            { "value": "low", "label": "Low" },
            { "value": "medium", "label": "Medium" },
            { "value": "high", "label": "High" },
            { "value": "max", "label": "Max (Opus only)" }
          ]}}
      ]
    },
    {
      "group": "权限管理",
      "commands": [
        { "cmd": "/perm", "label": "权限模式管理",
          "next": { "type": "select", "items": [
            { "value": "bypass", "label": "免审批模式" },
            { "value": "plan", "label": "计划模式" },
            { "value": "allow", "label": "允许此操作" },
            { "value": "always", "label": "始终允许" },
            { "value": "deny", "label": "拒绝此操作" }
          ]}}
      ]
    },
    {
      "group": "运维",
      "commands": [
        { "cmd": "/status", "label": "显示会话状态" },
        { "cmd": "/stop", "label": "中断当前任务" },
        { "cmd": "/check", "label": "检查渠道状态" },
        { "cmd": "/restart", "label": "重启服务" }
      ]
    },
    {
      "group": "帮助",
      "commands": [
        { "cmd": "/help", "label": "显示帮助信息" }
      ]
    }
  ]
}
```

## 客户端实现建议

### 缓存策略

- 全量菜单：连接后首次查询，缓存 5 分钟
- 动态子菜单：按 `cmd` 路径缓存，用户每次导航到该节点时刷新
- 切换目标/重连时清空所有缓存

### UI 适配

| 客户端类型 | 推荐实现 |
|-----------|---------|
| CLI / Terminal | Tab 补全 + 多级导航（参考 aun-cli 实现） |
| 移动端 App | 底部弹出菜单 → 列表选择 → 逐级深入 |
| Web UI | 下拉菜单 / Command Palette（Cmd+K 风格） |
| Bot 平台 | 交互卡片 / 按钮组（如 Slack Block Kit） |

### 导航交互

- 选中有 `next` 的节点 → 不发送，展示下一级
- 选中叶子节点（无 `next`）→ 拼接命令并发送
- `text` 类型 → 显示输入框，用 `args` 字段作为 placeholder
- 返回上一级 → 回退到父节点的选项列表
- 动态加载中 → 显示 loading 状态，收到响应后刷新

### 错误处理

- `menu.query` 发出后无响应 → 超时 5 秒后提示"对端不支持菜单"
- 动态子菜单返回空 `items` → 提示"暂无可选项"
- 服务端不识别 `cmd` → 返回空 `items`（不会报错）

### 向后兼容

- 旧服务端不返回 `next` 字段 → 所有节点视为叶子节点，选中即发送（与 v1 行为一致）
- 旧客户端不发 `cmd` → 服务端返回全量菜单（行为不变）
- 客户端应对缺失的 `next`、`desc`、`args` 字段做容错处理

## 传输层参考

菜单消息通过 AUN `message.send` 发送，payload 为 JSON 字符串：

```javascript
// 发送 menu.query
await client.call('message.send', {
  to: targetAid,
  payload: JSON.stringify({ type: 'menu.query' }),
  encrypt: true
});

// 发送带 cmd 的子菜单查询
await client.call('message.send', {
  to: targetAid,
  payload: JSON.stringify({ type: 'menu.query', cmd: '/del' }),
  encrypt: true
});
```

收到消息时解析 payload，检查 `type` 字段判断是否为菜单响应：

```javascript
function onMessage(payload) {
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return; }
  if (parsed.type === 'menu.response') {
    if (parsed.cmd) {
      // 子菜单响应
      subMenuCache[parsed.cmd] = parsed.items || [];
    } else {
      // 全量菜单响应
      mainMenu = parsed.items || [];
    }
  }
}
```
