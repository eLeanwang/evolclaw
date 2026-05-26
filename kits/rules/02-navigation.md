# 导航：怎么找到我需要的信息

## 路径体系

### 三个基础路径

| 路径 | 含义 |
|------|------|
| `$EVOLCLAW_HOME` | 用户数据根（默认 `~/.evolclaw`） |
| `$PACKAGE_ROOT` | evolclaw 包根目录 |
| `$CURRENT_PROJECT` | 当前工作目录 |

### 派生路径

| 名称 | 派生自 | 含义 |
|------|--------|------|
| `$KITS` | `$PACKAGE_ROOT/kits` | ECK 知识包根 |
| `$KITS_RULES` | `$KITS/rules` | 自动载入部分（本目录） |
| `$KITS_DOCS` | `$KITS/docs` | 按需载入文档 |
| `$KITS_TEMPLATES` | `$KITS/templates` | prompt 模板 |
| `$KITS_FRAGMENTS` | `$KITS_TEMPLATES/system-fragments` | ECK 动态注入 fragment 模板 |
| `$ECK` | `$EVOLCLAW_HOME/eck` | 运行时配置 |
| `$AGENTS_DIR` | `$EVOLCLAW_HOME/agents` | per-agent 数据根 |
| `$AGENT_DIR` | `$AGENTS_DIR/<self-aid>` | 当前 agent 根 |
| `$SELF_DIR` | `$AGENT_DIR/personal` | 个人数据层（身份层） |
| `$RELATIONS_DIR` | `$AGENT_DIR/relations` | 关系层 |
| `$VENUES_DIR` | `$AGENT_DIR/venues` | 环境层 |
| `$AGENT_INDEX` | `$AGENT_DIR/index` | agent 级文档索引 |

会话级动态注入：`$PEER_DIR` → 当前对端的关系目录。

## 路径注册表机制

路径用 `$名称` 引用，不写死实际路径。

### 三层结构

| 层 | 位置 | 性质 | 内容 |
|----|------|------|------|
| 机制描述 | 本文件 | 只读 | 语法、规则 |
| 路径定义 | `$KITS_DOCS/path-registry.md` | 只读，按需加载 | 所有路径的派生规则或寻找规则 |
| 路径实例 | `$ECK/path-registry.md` | 可变，按需加载 | 已解析的真实值 + 用户自定义路径 |

### 两类路径

- **可直接派生**：从基础路径按固定规则算出（如 `$KITS = $PACKAGE_ROOT/kits`）
- **不可直接派生**：需按寻找规则搜索，找到后写入实例文件。例如：
  - `$AUN_SDK`：寻找规则 `npm list -g @agentunion/fastaun --parseable`
  - `$AUN_PROTOCOL_DOCS`：`$AUN_SDK/docs/protocol`（AUN 协议详细文档）

### 按需加载时机

路径定义和实例文件**不自动加载**，仅在以下场景 Read：
- 需要访问某个 `$名称` 但当前上下文中没有真实值
- 需要寻找外部依赖位置
- 用户要求注册或查看路径

## 索引机制

| 层 | 位置 | 维护者 | 写入权限 |
|----|------|--------|----------|
| evolclaw 级 | `$KITS_DOCS/INDEX.md` | 开发时维护 | 只读，过时时呈报用户 |
| agent 级 | `$AGENT_INDEX/INDEX.md` | agent 会话 | 可写，直接更新 |

agent 级索引范围：`$CURRENT_PROJECT` + `$AGENT_DIR`。

触发时机：上述范围内有文档新增或较大幅度修改时，主动重建索引。

## Bootstrap（独立使用 ECK 时）

无 evolclaw 动态注入时，路径确定顺序：
1. `$EVOLCLAW_HOME`：环境变量 → 默认 `~/.evolclaw`
2. 读取 `$ECK/runtime.md` 获取基础路径和运行时参数
3. 按派生规则构造其余路径

参数加载优先级：evolclaw 动态注入 > 环境变量 > `$ECK/runtime.md` > 硬编码默认值。
