# 路径定义

本文件定义所有预定义路径的含义和派生规则。运行时实际值在 `$ECK/path-registry.md`。

## 基础路径（三个锚点）

| 名称 | 含义 | 来源 |
|------|------|------|
| `$EVOLCLAW_HOME` | evolclaw 用户数据根 | 环境变量 `EVOLCLAW_HOME` 或默认 `~/.evolclaw` |
| `$PACKAGE_ROOT` | evolclaw 包根目录 | `require.resolve('evolclaw')` 所在目录 |
| `$CURRENT_PROJECT` | 当前工作目录 | `process.cwd()` |

## 包内路径（从 $PACKAGE_ROOT 派生）

| 名称 | 派生规则 | 说明 |
|------|----------|------|
| `$KITS` | `$PACKAGE_ROOT/kits` | kits 根目录 |
| `$KITS_RULES` | `$KITS/rules` | 自动加载的规则文件 |
| `$KITS_DOCS` | `$KITS/docs` | 按需加载的文档 |
| `$KITS_TEMPLATES` | `$KITS/templates` | 运行时 prompt 组装模板 |

## 用户数据路径（从 $EVOLCLAW_HOME 派生）

| 名称 | 派生规则 | 说明 |
|------|----------|------|
| `$ECK` | `$EVOLCLAW_HOME/eck` | ECK 实例数据（路径注册表实例等） |
| `$AGENTS_DIR` | `$EVOLCLAW_HOME/agents` | 所有 agent 数据根 |
| `$AGENT_DIR` | `$AGENTS_DIR/<self-aid>` | 当前 agent 数据目录 |
| `$SELF_DIR` | `$AGENT_DIR/personal` | 自己的身份档案 |
| `$RELATIONS_DIR` | `$AGENT_DIR/relations` | 对端关系档案（含具体群/私聊实例数据） |
| `$VENUES_DIR` | `$AGENT_DIR/venues` | 环境层（预留，更高抽象，非实例） |
| `$AGENT_INDEX` | `$AGENT_DIR/index` | agent 级索引 |

## 外部依赖路径（需寻找）

| 名称 | 寻找规则 | 说明 |
|------|----------|------|
| `$KITE` | 在 `$EVOLCLAW_HOME/config.json` 的 `kitePath` 字段查找 | Kite 框架根 |
| `$AUN_SDK_CORE` | `$KITE/aun-sdk-core` | AUN SDK 源码 |

## 路径实例文件

运行时实际路径值写入 `$ECK/path-registry.md`，格式见 `$KITS_DOCS/eck_templates/path-registry.template.md`。
