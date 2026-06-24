# EvolClaw 配置体系文档

> 版本：v3 (2026-06-23)
> 当前实现：H 配置链 + HA 行为链。`behavior.json` 仍是正式运行机制。

## 推荐阅读

1. [01-overview.md](./01-overview.md) - 配置体系总体架构
2. [PARAMS-GAPS-AND-FIXES.md](./PARAMS-GAPS-AND-FIXES.md) - 配置缺口、已处理项与后续建议
3. [CONFIG-MID-LONG-TERM-IMPLEMENTATION-PLAN.md](./CONFIG-MID-LONG-TERM-IMPLEMENTATION-PLAN.md) - 剩余中长期项可执行实施计划
4. [PARAMS-FULL-REFERENCE.md](./PARAMS-FULL-REFERENCE.md) - 参数完整参考
5. [08-quick-reference.md](./08-quick-reference.md) - 常用命令速查

## 核心概念

```text
process:  evolclaw.json                         # daemon 自身配置，链外

H 链:     agents/defaults.json
            -> agents/{aid}/config.json
            -> agents/{aid}/relations/{peerKey}/config.json

HA 链:    agents/{aid}/behavior.json
            -> behavior.roles.{role}
            -> agents/{aid}/relations/{peerKey}/behavior.json
```

运行时 `effective` 配置先合并 H 链，再叠加 HA 行为链。新写入通过 ConfigManager 按字段 owner 路由：

- H 字段：身份、授权、渠道、凭证引用、项目、基础设施。
- HA 字段：`model/effort`、`permissionMode`、`chatmode`、`dispatch`、`flush_delay`、`show_activities`、`render`、`proactive` 等运行行为。

## 常用命令

```bash
ec config get <field> --self <aid>
ec config set <field> <value> --self <aid>
ec config effective --self <aid>
ec config fields --self <aid>
ec config validate --self <aid>

ec config snapshot
ec config history
ec config restore <version>
```

`ec config set` 会自动判断落点：H 字段写 `config.json` / `defaults.json` / `evolclaw.json`，HA 字段写 `behavior.json`。

## 当前状态

- 已保留并正式化 `behavior.json` 路线。
- 已修正 `permissionMode` 默认值、`dispatch` 枚举、`flush_delay` 兜底、`idleMonitor` 归属、`chatmode` 新 session 默认值。
- 已将 agent/relation `behavior.json` 纳入配置快照。
- 尚未完成：全局 HA 默认层、完整 source trace、channel discriminated schema、project path 默认解析统一、ecweb/serviceProxy item schema 细化。可执行拆解见 [CONFIG-MID-LONG-TERM-IMPLEMENTATION-PLAN.md](./CONFIG-MID-LONG-TERM-IMPLEMENTATION-PLAN.md)。

## 文档目录

| 文档 | 说明 |
|------|------|
| [01-overview.md](./01-overview.md) | 总体架构 |
| [02-merge-rules.md](./02-merge-rules.md) | 覆盖链与合并规则 |
| [03-schema.md](./03-schema.md) | Schema 治理 |
| [04-config-manager.md](./04-config-manager.md) | ConfigManager API |
| [05-snapshot.md](./05-snapshot.md) | 快照与回滚 |
| [06-cli-commands.md](./06-cli-commands.md) | CLI 命令 |
| [07-security.md](./07-security.md) | 安全与权限控制 |
| [08-quick-reference.md](./08-quick-reference.md) | 快速参考 |
| [CONFIG-MID-LONG-TERM-IMPLEMENTATION-PLAN.md](./CONFIG-MID-LONG-TERM-IMPLEMENTATION-PLAN.md) | 剩余中长期项实施计划 |
| [PARAMS-GAPS-AND-FIXES.md](./PARAMS-GAPS-AND-FIXES.md) | 配置缺口、已处理项与后续建议 |
| [PARAMS-FULL-REFERENCE.md](./PARAMS-FULL-REFERENCE.md) | 参数完整参考 |
