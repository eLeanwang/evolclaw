# EvolClaw 文档索引

本文件是 `$KITS_DOCS` 下所有文档的索引。

## 路径与机制

| 文档 | 路径 | 说明 |
|------|------|------|
| 查阅指南 | `GUIDE.md` | 文档查阅流程 |
| 路径定义 | `path-registry.md` | 所有预定义路径及派生规则 |
| 上下文组装机制 | `context-assembly.md` | manifest 装配机制：when 条件/合并覆盖/模板渲染/运行时变量/调试输出 |

## AUN 协议

| 文档 | 路径 | 说明 |
|------|------|------|
| 速查表 | `aun/CHEATSHEET.md` | AUN 协议命名空间与常用操作速查 |
| 同步协议 | `aun/SYNC_PROTOCOL.md` | 上游协议同步 SOP |

## EvolClaw 命令

所有 `ec` 命令集的专属目录（用途/触发词/适用场景/文档）见 `evolclaw/INDEX.md`。
运行时由 `commands` fragment 按场景注入精简能力卡。

| 文档 | 路径 | 说明 |
|------|------|------|
| 命令集目录 | `evolclaw/INDEX.md` | msg/group/agent/aid/storage/ctl/rpc/model/bench 全集索引 |

## 身份

| 文档 | 路径 | 说明 |
|------|------|------|
| 身份工具 | `identity/identity-tools.md` | 身份识别与环境层工具 |
| 角色详情 | `identity/ROLE_DETAIL.md` | 角色与场景详细规则 |
| AID 档案规范 | `identity/AID_PROFILE_SPEC.md` | AID 档案格式规范 |
| 路径运维 | `identity/PATH_OPS.md` | 路径运维操作 |

## 渠道（知识文档·按需加载，不依赖当前渠道）

| 文档 | 路径 | 说明 |
|------|------|------|
| AUN 渠道 | `channels/aun.md` | AUN 渠道配置、参数与特有机制（网关发现/E2EE/群 ID/证书链） |
| 飞书渠道 | `channels/feishu.md` | 飞书渠道配置、参数与特有机制（appId/合并转发/卡片/user_id） |

## 触发器

| 文档 | 路径 | 说明 |
|------|------|------|
| Trigger 命令手册 | `evolclaw/trigger.md` | 创建、管理、运行定时与事件 trigger |
| EventBus 事件目录 | `triggers/event-catalog.md` | event source 可监听事件、payload、filter 与循环防护规则 |

## ECK 模板

| 文档 | 路径 | 说明 |
|------|------|------|
| 运行时配置模板 | `eck_templates/runtime.template.md` | agent 运行时配置模板 |
| 路径注册表模板 | `eck_templates/path-registry.template.md` | 路径实例模板 |
| 索引模板 | `eck_templates/INDEX.template.md` | agent 级索引模板 |
| 指南模板 | `eck_templates/GUIDE.template.md` | agent 级查阅指南模板 |

## Base Agent

| 文档 | 路径 | 说明 |
|------|------|------|
| Claude Code 日志 | `baseagent/cc-logs.md` | CC 会话日志查阅（找完整对话/工具调用/注入） |
