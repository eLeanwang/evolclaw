# Menu 协议扩展：Capability 开关管理 MVP

> 状态：方案设计（简化版）  
> 日期：2026-06-29  
> 关联：`docs/aun-menu-protocol-dev-guide-v2.4.md`

---

## 1. 目标与边界

前端（Evol App/Web）通过 Menu 协议管理当前 agent 可用能力。MVP 只做：

- 查看当前 agent 可发现的 Skills
- 查看当前 agent 可发现的 MCP servers
- 查看当前 agent 可发现的 Plugins
- 设置能力类型的默认策略
- 设置单个能力的显式覆盖
- MVP 纳入 `claude` 与 `codex`

MVP 不做：

- 不安装 / 卸载 Skill 文件
- 不新增 / 删除 MCP server 配置
- 不安装 / 卸载 Plugin
- 不读写 baseagent 用户级配置文件作为开关状态源
- 不支持单 agent 多 `projectPath` 的能力策略分叉
- 不承诺运行中任务即时切换所有能力
- 不提供 `reload` / `refresh` / `rescan` 协议动作

核心路径：

```text
agents/<aid>/config.json 保存能力策略
  -> runner 下一轮启动时注入 baseagent
  -> baseagent 用户配置文件只作为发现来源
```

---

## 2. Scope 与存储

### 2.1 Scope

MVP 只支持 `scope="project"`，语义为“当前 agent 绑定的 project”。

后端解析顺序：

1. 从当前 channel 解析 owning agent
2. 读取 `$EVOLCLAW_HOME/agents/<aid>/config.json`
3. 使用 `projects.defaultPath`
4. 若无 `projects.defaultPath`，可回退当前活跃 session 的 `projectPath`
5. 仍无法解析则返回 `NO_PROJECT`

前端不得通过 `args.path` 指定任意落盘位置。

### 2.2 存储位置

能力策略写入：

```text
$EVOLCLAW_HOME/agents/<aid>/config.json
```

建议字段：

```json
{
  "projects": {
    "defaultPath": "/home/evolclaw"
  },
  "capabilities": {
    "claude": {
      "skill": {
        "mode": "inherit",
        "overrides": {}
      },
      "mcp": {
        "mode": "inherit",
        "overrides": {}
      },
      "plugin": {
        "mode": "inherit",
        "overrides": {}
      }
    },
    "codex": {
      "skill": {
        "mode": "inherit",
        "overrides": {}
      },
      "mcp": {
        "mode": "inherit",
        "overrides": {}
      },
      "plugin": {
        "mode": "inherit",
        "overrides": {}
      }
    }
  }
}
```

只存策略，不存 catalog。Skills/MCP/Plugins 的发现结果由 provider 在查询时读取。

---

## 3. 策略模型

```typescript
type CapabilityType = 'skill' | 'mcp' | 'plugin';
type CapabilityMode = 'inherit' | 'all' | 'none';
type CapabilityOverride = 'enabled' | 'disabled';

interface CapabilityTypeConfig {
  mode: CapabilityMode;
  overrides: Record<string, CapabilityOverride>;
}
```

类型级 `mode`：

| mode | 语义 |
|------|------|
| `inherit` | 默认继承 baseagent / CLI / project 行为 |
| `all` | 默认启用该类型所有已发现能力 |
| `none` | 默认禁用该类型所有已发现能力 |

单项级 `overrides[id]`：

| override | 语义 |
|----------|------|
| `enabled` | 显式启用该能力 |
| `disabled` | 显式禁用该能力 |
| 不存在 | 使用该类型的 `mode` |

状态计算：

```typescript
function resolveEnabled(config: CapabilityTypeConfig, id: string): boolean | 'inherit' {
  const override = config.overrides[id];
  if (override === 'enabled') return true;
  if (override === 'disabled') return false;
  if (config.mode === 'all') return true;
  if (config.mode === 'none') return false;
  return 'inherit';
}
```

---

## 4. Menu 协议

### 4.1 menu.query name=capability

`menu.query` 只返回类型级状态，即 `capabilities.<type>.*`，不返回单项列表。

请求：

```json
{
  "type": "menu.query",
  "id": "q-cap-001",
  "name": "capability",
  "args": {
    "scope": "project"
  }
}
```

也可以只查一种类型：

```json
{
  "type": "menu.query",
  "id": "q-cap-002",
  "name": "capability",
  "args": {
    "scope": "project",
    "type": "mcp"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "q-cap-001",
  "name": "capability",
  "data": {
    "scope": "project",
    "projectPath": "/home/evolclaw",
    "baseagent": "claude",
    "capabilities": {
      "skill": {
        "mode": "inherit",
        "canUpdate": true
      },
      "mcp": {
        "mode": "all",
        "canUpdate": true
      },
      "plugin": {
        "mode": "none",
        "canUpdate": true
      }
    }
  }
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `capabilities.<type>.mode` | 类型默认策略，直接来自 `config.json` |
| `capabilities.<type>.canUpdate` | provider 是否支持该类型下一轮注入 |
| `capabilities.<type>.reason` | `canUpdate=false` 时的可选原因 |

### 4.2 menu.options name=capability

`menu.options` 用于查询某一类型下的具体能力列表。`args.type` 必填。

请求：

```json
{
  "type": "menu.options",
  "id": "o-cap-001",
  "name": "capability",
  "args": {
    "scope": "project",
    "type": "mcp"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "o-cap-001",
  "name": "capability",
  "data": [
    {
      "value": "playwright",
      "label": "Playwright",
      "desc": "Browser automation MCP server",
      "source": "project",
      "status": "connected",
      "enabled": false,
      "override": "disabled",
      "runtimeEnabled": true
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `value` | 稳定能力 ID；update 时作为 `args.name` |
| `label` | 展示名称 |
| `desc` | 简短描述 |
| `source` | `project` / `user` / `plugin` / `marketplace` / `bundled` / `system` / `unknown` |
| `status` | provider 运行状态；主要用于 MCP |
| `enabled` | 计算后的下一轮期望状态：`true` / `false` / `"inherit"` |
| `override` | 单项显式覆盖：`enabled` / `disabled` / `null` |
| `runtimeEnabled` | 当前运行态观测值，可选 |

`menu.options` 不提供刷新语义。provider 如需缓存，应自行通过 mtime、TTL 或 SDK invalidation 管理。

### 4.3 menu.update name=capability

`menu.update` 同时支持类型级和单项级更新，通过 `args.name` 是否存在区分。

#### 类型级更新

当 `args.name` 不存在时，更新 `capabilities.<baseagent>.<type>.mode`。

类型级 `value` 只允许：

```typescript
type CapabilityMode = 'inherit' | 'all' | 'none';
```

请求：

```json
{
  "type": "menu.update",
  "id": "u-cap-001",
  "name": "capability",
  "value": "all",
  "args": {
    "scope": "project",
    "type": "mcp"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "u-cap-001",
  "name": "capability",
  "data": {
    "type": "mcp",
    "mode": "all",
    "saved": true
  }
}
```

类型级 update 只修改 `mode`，不清空已有 `overrides`。

#### 单项级更新

当 `args.name` 存在时，更新 `capabilities.<baseagent>.<type>.overrides[args.name]`。

单项级 `value` 只允许：

```typescript
type CapabilityItemValue = 'enabled' | 'disabled' | 'inherit';
```

请求：

```json
{
  "type": "menu.update",
  "id": "u-cap-002",
  "name": "capability",
  "value": "disabled",
  "args": {
    "scope": "project",
    "type": "mcp",
    "name": "playwright"
  }
}
```

响应：

```json
{
  "type": "menu.response",
  "id": "u-cap-002",
  "name": "capability",
  "data": {
    "type": "mcp",
    "name": "playwright",
    "override": "disabled",
    "saved": true
  }
}
```

写入规则：

| value | 写入 |
|-------|------|
| `enabled` | `overrides[name] = "enabled"` |
| `disabled` | `overrides[name] = "disabled"` |
| `inherit` | 删除 `overrides[name]` |

单项级 `inherit` 响应：

```json
{
  "type": "menu.response",
  "id": "u-cap-003",
  "name": "capability",
  "data": {
    "type": "mcp",
    "name": "playwright",
    "override": null,
    "saved": true
  }
}
```

校验规则：

| 条件 | 合法 value | 非法时 |
|------|------------|--------|
| `args.name` 不存在 | `inherit` / `all` / `none` | `INVALID_ARGS` |
| `args.name` 存在 | `enabled` / `disabled` / `inherit` | `INVALID_ARGS` |

### 4.4 menu.action name=capability

MVP 不提供 `menu.action name=capability`。

所有能力开关修改都走 `menu.update`：

- 类型级：`value = inherit | all | none`
- 单项级：`value = enabled | disabled | inherit`

---

## 5. Baseagent 映射

### 5.1 Claude Provider

| 类型 | 查询 | 下一轮注入 | 运行中增强 |
|------|------|------------|------------|
| Skills | `Query.reloadSkills()` 或扫描 skills roots | `options.skills` / `settings.skillOverrides` | 可选 `applyFlagSettings({ skillOverrides })` |
| MCP | `Query.mcpServerStatus()` | `settings.enabledMcpjsonServers` / `disabledMcpjsonServers` / `allowedMcpServers` / `deniedMcpServers` | 可选 `toggleMcpServer()` |
| Plugins | `Query.reloadPlugins()` | `settings.enabledPlugins` | 可选 `applyFlagSettings({ enabledPlugins })` + `reloadPlugins()` |

MVP 以“下一轮注入”为准。运行中增强不是协议承诺。

### 5.2 Codex Provider

Codex 纳入 MVP 的查看与启停能力，但不写 `~/.codex/config.toml`。

| 类型 | 查询入口 | 下一轮注入 |
|------|----------|------------|
| Skills | app-server `skills/list` 或扫描 skills roots | `thread/start` / `thread/resume` 的 `config.skills.config` |
| MCP | app-server `mcpServerStatus/list` 或 `codex mcp list --json` | `thread/start` / `thread/resume` 的 `config.mcp_servers` 裁剪后集合 |
| Plugins | app-server `plugin/installed` / `plugin/list` 或 `codex plugin list --json` | `thread/start` / `thread/resume` 的 `config.plugins` |

Codex app-server 协议中 `thread/start` 与 `thread/resume` 有 `config`，`turn/start` 没有通用 `config` 字段。因此 Codex 的能力开关语义是“下一轮消息启动或恢复 thread 时生效”，不承诺当前运行中的 turn 热切。

约束：

- `skills/config/write`、`config/value/write`、`config/batchWrite` 都是 baseagent 配置写入路径，MVP 不使用。
- `mcpServerStatus/list` 支持 `threadId`，可用于按线程查看 MCP 状态；普通发现仍可使用 CLI fallback。
- 某类型若后续无法通过 thread config 或 EvolClaw 过滤层保证下一轮生效，必须将该类型 `canUpdate=false`，`menu.update` 返回 `NOT_SUPPORTED`。

---

## 6. 后端实现

新增：

```text
src/core/capability/
├── capability-manager.ts
├── providers/
│   ├── claude-capability-provider.ts
│   ├── codex-capability-provider.ts
│   └── gemini-capability-provider.ts
└── types.ts
```

策略读写复用现有 agent config 读写能力，不新增独立 policy store。

核心接口：

```typescript
interface CapabilityTypeState {
  mode: 'inherit' | 'all' | 'none';
  canUpdate: boolean;
  reason?: string;
}

interface CapabilityProvider {
  readonly baseagent: string;

  discover(ctx: CapabilityContext, type: CapabilityType): Promise<CapabilityOption[]>;

  resolveRunOptions?(
    config: Record<CapabilityType, CapabilityTypeConfig>,
    catalog: Partial<Record<CapabilityType, CapabilityOption[]>>
  ): Record<string, unknown>;
}
```

能力策略写入 `agents/<aid>/config.json`。更新时只 patch `capabilities.<baseagent>.<type>`，不能覆盖用户并发改动的其他 config 字段。

---

## 7. 权限模型

| 操作 | owner | admin | guest / anonymous |
|------|:-----:|:-----:|:------------------:|
| query | yes | yes | yes（脱敏只读） |
| options | yes | yes | yes（脱敏只读） |
| update type mode | yes | no | no |
| update item override | yes | yes | no |

说明：

- 类型级 update 会改变整类默认能力边界，仅 owner 可执行。
- 单项级 update 只影响某个能力 override，admin 可执行。
- guest 查询不返回本机绝对路径、MCP command/env、plugin path、skill 文件内容。

---

## 8. 错误码

| code | 场景 |
|------|------|
| `NO_PERMISSION` | 无权限修改 |
| `INVALID_ARGS` | 参数缺失、value 与目标层级不匹配 |
| `INVALID_TYPE` | `type` 不是 `skill/mcp/plugin` |
| `INVALID_SCOPE` | MVP 只支持 `scope=project` |
| `NO_PROJECT` | 无法解析当前 agent projectPath |
| `NOT_SUPPORTED` | 当前 baseagent 或能力类型不支持下一轮注入 |
| `NOT_FOUND` | 目标能力未发现 |
| `DISCOVERY_UNAVAILABLE` | 无法获取 catalog |
| `EXEC_FAILED` | config 写入或 SDK/app-server 调用失败 |
