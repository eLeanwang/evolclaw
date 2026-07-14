# ec config — 配置体系底层入口

按作用域读写所有配置参数 + 配置快照/回滚/启动历史。触发词：看配置/改配置/查字段/列配置/校验配置/快照/回滚/历史/对比版本/启动记录。

> `ec config` 是底层通用入口；`ec model` / `ec ctl` 是高频操作的语义化快捷命令，二者最终都经 ConfigManager。
> 字段按 owner 路由：H 字段写 config/defaults/evolclaw，HA 行为字段写 behavior.json。

## 参数读写

```bash
# 读 effective 值（显示覆盖链来源）
ec config get <field> [--self <aid>] [--peer <X>] [--default] [--process]

# 写参数：scope 由 selector 推断
ec config set <field> <value> [--self <aid>] [--peer <X>] [--default] [--process]

# 删除某层显式设置，回落下一层
ec config unset <field> [--self <aid>] [--peer <X>]

# 查看某一层文件原始内容（不合并，凭证显示 ${VAR} 不展开）
ec config show [--self <aid>] [--peer <X>] [--default] [--process]

# 打印合并后的全部生效配置
ec config effective [--self <aid>] [--peer <X>]

# 列出某作用域可设字段（类型/枚举值，来源 schema）
ec config fields [--self <aid>] [--default] [--process]

# 列出所有配置文件
ec config list

# 按 schema 校验配置文件
ec config validate [--self <aid>] [--peer <X>] [--default] [--process]

# 按 schema 物化骨架文件（仅人）
ec config init [--self <aid>] [--peer <X>] [--default] [--process]
```

## 快照 / 回滚

```bash
# 立即创建快照（与当前版本比对，不一致才建；--full 强制新全量）（仅人）
ec config snapshot [--full] [--desc "说明"]

# 列出快照版本（版本号/类型/触发/时间/说明）
ec config history

# 对比两版本差异
ec config diff <v1> <v2>

# 恢复到指定版本：展开到工作目录 + 更新 current.json（先 pre-restore 快照）（仅人）
ec config restore <version>

# 显示 current.json 选定版本（上次启动回落时给出告警）
ec config current

# 查看启动历史（含回落标记）
ec config boots [-n N]

# 清理旧快照（默认 dry-run，--yes 真删；拒删被依赖全量 / current 指向版本）（仅人）
ec config prune [--keep-full N] [--keep-delta N] [--yes]
```

## Schema 查看

查看随包分发的配置 schema **定义本身**（`kits/schemas/*.schema.*.json`）——不是读写配置值，而是查「某作用域有哪些字段、类型/枚举/默认、schema 有几个版本」。纯只读，人和 agent 均可。

```bash
# 概览：列出全部逻辑 schema 及各自当前版本
ec config schema

# 列出某 schema 磁盘上的所有版本（* 标当前版本，附日期/说明）
ec config schema <name> --list

# 查看某 schema 的原始定义（缺省版本号 = 当前版本）
ec config schema <name> [version]
```

逻辑 schema 名（`<name>`）：`evolclaw` / `defaults` / `agent-config` / `relation-config` / `contact-book`。

三种输出模式：

| 调用形式 | mode | 输出 |
|----------|------|------|
| `config schema` | overview | 全部 schema + 各自当前版本号 |
| `config schema <name> --list` | versions | 该 schema 所有磁盘版本，`*` 标当前，附 date/description |
| `config schema <name> [version]` | content | 指定版本（缺省=当前）的完整 schema JSON |

约定与报错：
- `--list` 与 version 参数互斥（`INVALID_CONFIG_COMMAND`）
- `--list` 或指定 version 时必须带 `<name>`（`MISSING_ARG`）
- version 须为非负整数；未知 name → `UNKNOWN_SCHEMA`；版本不存在 → `SCHEMA_VERSION_NOT_FOUND`（错误信息列出可用版本）

> 用途：写配置前先 `ec config fields` 看字段可设值，或 `ec config schema <name>` 看该层 schema 的完整字段约束与 `x-merge` 合并语义；排查「字段为何被拒/怎么合并」时定位 schema 版本。

## 作用域 selector

| 参数 | 作用域 | 落盘 |
|------|--------|------|
| `--self <aid>` | agent 级 | `agents/<aid>/config.json` 或 `agents/<aid>/behavior.json` |
| `--self <aid> --peer <X>` | 关系级 | `relations/<peerKey>/config.json` 或 `relations/<peerKey>/behavior.json` |
| `--default` | 全局默认 | `agents/defaults.json` |
| `--process` | 进程级 | `~/.evolclaw/evolclaw.json` |
| 写操作三者全无 | — | **拒绝**（防误写全局） |

`--peer` 取 `channelType#channelId` 或裸 aid（裸 aid 视为 `aun#<aid>`）。改某作用域后，对应范围所有会话的下一条消息即时生效。

## 覆盖链

```
defaults → agent/config → relation/config
agent/behavior → roles.<role> → relation/behavior
```

运行时先合并覆盖链，再叠加行为链；同名行为字段以 behavior 链为高优先级。同名字段深合并（对象/数组），标量覆盖。

## 权限控制

**写权限**（API 层判定）：
- **可写字段**：active_baseagent / baseagents / chatmode / dispatch / show_activities / proactive / flush_delay / debounce / render / enable_rich_content / permissionMode / roles
- **仅人可写**：channels / owners / admins / 凭证 / aid / enabled / projects / aun / models.allowed
- Agent 托管环境写仅人字段被拒

**操作权限**：
- 读操作（get/show/list/effective/fields/schema/history/diff/current/boots/validate）：人和 agent 均可
- 快照管理（snapshot/restore/init/prune）：仅人可执行

**凭证安全**：
- 凭证一律 `${VAR}` 引用，CLI 读命令永不展开、不泄露明文
- `.env` 全程禁读写

## 通用约定

- `--format json` — 所有子命令通用
- 本命令操作本地配置，不连 AUN 网络
- 单文件内 list 字段 `set` = 追加去重；删单个元素请直接编辑文件（角色/owner 链只增不减）
