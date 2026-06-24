# 配置体系总体架构

> EvolClaw 配置体系 v3 - 2026-06-23
> 当前实现采用 H 配置链 + HA 行为链。`behavior.json` 不是历史残留，而是正式运行机制。

---

## 一、核心原则

配置按字段所有权拆分：

- **H 字段**：人类/进程管理字段，写入 `evolclaw.json`、`agents/defaults.json`、`agents/{aid}/config.json`、`relations/{peerKey}/config.json`。
- **HA 字段**：运行时行为字段，写入 `agents/{aid}/behavior.json` 或 `relations/{peerKey}/behavior.json`。
- **effective 配置**：运行时先合并 H 链，再叠加 HA 行为链；同名行为字段以 `behavior.json` 链为高优先级。

不要再把 v3 描述成“所有参数统一在 config.json”。当前短中期路线是保留 `behavior.json`，并通过 ConfigManager 统一路由读写。

---

## 二、文件结构

```text
{evolclaw_home}/
├── evolclaw.json                         # 进程级配置，链外 H
├── .env                                  # 全局凭证，不进快照
├── backups/config/                       # 配置快照与回滚
└── agents/
    ├── defaults.json                     # H 链默认层
    └── {aid}/
        ├── config.json                   # agent H 配置
        ├── behavior.json                 # agent HA 行为配置
        ├── .env                          # agent 凭证，不进快照
        └── relations/{peerKey}/
            ├── config.json               # relation H 配置
            ├── behavior.json             # relation HA 行为配置
            └── .env                      # relation 凭证，不进快照
```

---

## 三、覆盖链

### H 配置链

```text
agents/defaults.json
  -> agents/{aid}/config.json
  -> agents/{aid}/relations/{peerKey}/config.json
```

H 链承载身份、授权、渠道、凭证引用、项目路径、基础设施等人类管理字段。

### HA 行为链

```text
agents/{aid}/behavior.json
  -> behavior.roles.{role}
  -> agents/{aid}/relations/{peerKey}/behavior.json
```

HA 链承载运行行为字段，例如 `model/effort`、`permissionMode`、`chatmode`、`dispatch`、`flush_delay`、`show_activities`、`render`、`proactive`。

### 进程级配置

`evolclaw.json` 是链外配置，不参与 agent effective 覆盖链。`idleMonitor`、`ecweb`、`serviceProxy` 等 daemon 自身配置放在这里。

---

## 四、字段归属

| 字段类别 | Canonical owner |
|----------|-----------------|
| `aid`、`owners`、`admins`、`channels[]` | H |
| `aun`、`projects`、`debug`、`extra_backup` | H |
| `baseagents.<ba>.apiKey/baseUrl/cliPath` 等基础设施 | H |
| `active_baseagent` | HA |
| `baseagents.<ba>.model/effort/reasoning/mode` 等行为 | HA |
| `permissionMode`、`roles.*` | HA |
| `chatmode`、`dispatch`、`flush_delay`、`debounce` | HA |
| `show_activities`、`proactive`、`render`、`enable_rich_content` | HA |
| `idleMonitor`、`ecweb`、`serviceProxy`、`watch` | process |

旧 H 文件中可能仍存在部分行为字段，运行时会兼容读取；新写入应通过 ConfigManager 路由到 canonical owner。

---

## 五、合并规则

字段合并语义来自 schema 的 `x-merge`：

| 类型 | 行为 |
|------|------|
| `scalar` | 高优先级整体覆盖 |
| `list` | 并集追加去重 |
| `dict` | 第一层键合并，同键高优先级整体覆盖 |

注意：`dict` 当前不是递归深合并。`baseagents.claude` 在高层只写 `model` 时，会整体覆盖低层同名 `claude` 块。因此凭证/基础设施字段与行为字段应按 owner 拆分，避免同一对象内跨链互相覆盖。

---

## 六、CLI 语义

`ec config get/set/unset` 按完整字段路径自动路由：

- H 字段写 `config.json` / `defaults.json` / `evolclaw.json`。
- HA 字段写 `behavior.json`。
- agent 托管环境不能写 H 字段，只能写允许的 HA 字段。

`ec config show --self <aid>` 和 `ec config validate --self <aid>` 会同时处理该作用域下的 H 文件和 HA `behavior.json`。

---

## 七、当前已收敛的不一致

- `permissionMode` 全局兜底统一为 `auto`；owner/admin 角色默认仍为 `bypass`，guest/anonymous 默认 `readonly`。
- `dispatch` 配置枚举统一为 `mention` / `broadcast`；旧 `all` / `none` 在 effective 读取时兼容归一为 `broadcast`。
- `flush_delay` 默认统一为 `DEFAULT_FLUSH_DELAY_SECONDS = 3`。
- `idleMonitor` 归属进程级 `evolclaw.json`。
- `chatmode` 作为新 session 默认值接入 `SessionManager`；已有 session 仍以持久化 session 状态为准，群聊仍强制 `proactive`。

---

## 八、相关文档

| 文档 | 说明 |
|------|------|
| `PARAMS-GAPS-AND-FIXES.md` | 配置缺口、风险与修复计划 |
| `PARAMS-FULL-REFERENCE.md` | 参数完整参考 |
| `02-merge-rules.md` | 覆盖链与合并规则 |
| `03-schema.md` | Schema 治理与版本化 |
| `04-config-manager.md` | ConfigManager API |
| `05-snapshot.md` | 快照与回滚机制 |
| `06-cli-commands.md` | CLI 命令说明 |
| `07-security.md` | 安全与权限控制 |

