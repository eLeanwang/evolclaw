# CLI 命令体系

> EvolClaw 配置体系 v3
> 上一篇：[05-snapshot.md](./05-snapshot.md) | 下一篇：[07-security.md](./07-security.md)

---

## 一、命令骨架

```bash
ec config                                          # 帮助
ec config help | --help | -h                       # 帮助
ec config <subcommand> [args] [--format json]
```

**通用约定**：
- 任意位置支持 `help`/`--help`/`-h`
- 所有子命令支持 `--format json`
- 不带子命令输出帮助
- Selector 统一：`--self <aid>`/`--peer <peerKey>`/`--default`/`--process`
- `--app <name>` 指定 slot

---

## 二、子命令清单

### 读取命令

| 命令 | 功能 | Selector | 权限 |
|------|------|----------|------|
| `ec config get <field>` | 读 effective 值 + 解析链 + 来源标注 | 必需 | 人/agent |
| `ec config show` | 查看某一层文件原始内容（凭证显示 `${VAR}`） | 必需 | 人/agent |
| `ec config effective` | 打印合并后的全部生效配置，每字段带来源标注 | 必需 | 人/agent |
| `ec config fields [<field>]` | schema 自省：列字段的 type/default/enum | 可选 | 人/agent |

### 写入命令

| 命令 | 功能 | Selector | 权限 |
|------|------|----------|------|
| `ec config set <field> <value>` | 写参数；scope 由 selector 推断 | 必需 | 人（agent 待权限体系） |
| `ec config unset <field>` | 删除某层显式设置，回落下一层 | 必需 | 人（agent 待权限体系） |

### 管理命令

| 命令 | 功能 | Selector | 权限 |
|------|------|----------|------|
| `ec config list` | 列出所有配置文件及存在状态 | — | 人/agent |
| `ec config validate` | 按 schema 校验配置文件 | 可选 | 人/agent |
| `ec config init` | 按 schema 生成骨架文件 | 必需 | 仅人 |
| `ec config schema [<name>] [<version>] [--list]` | 查看 schema 定义本身（字段/类型/版本） | — | 人/agent |

### 快照命令

| 命令 | 功能 | Selector | 权限 |
|------|------|----------|------|
| `ec config snapshot [--full] [--desc "..."]` | 立即创建快照 | — | 仅人 |
| `ec config history` | 列出快照版本 | — | 人/agent |
| `ec config diff <v1> <v2>` | 对比两版本差异（参数级） | — | 人/agent |
| `ec config restore <version>` | 恢复到指定版本 | — | 仅人 |
| `ec config current` | 显示当前版本指针 | — | 人/agent |
| `ec config boots [-n N]` | 查看启动日志 | — | 人/agent |
| `ec config prune` | 清理快照（dry-run，需 `--yes`） | — | 仅人 |

---

## 三、Selector 解析规则

| 参数组合 | scope | 用于 |
|----------|-------|------|
| `--self <aid>` | agent | get/set/unset/show/effective/fields/validate/init |
| `--self <aid> --peer <peerKey>` | relation | 同上 |
| `--default` | defaults | 同上（写操作必须显式带） |
| `--process`（或 `--evolclaw`） | process | 独立于覆盖链 |
| 写操作四者全无 | — | **拒绝**（防误写全局） |
| 读操作四者全无 | 全局视角 | get 展示完整解析链 |

---

## 四、命令详解

### get - 读取参数

```bash
# 读取 agent 级参数
ec config get chatmode.private --self bot1

# 读取关系级参数（解析链）
ec config get chatmode.private --self bot1 --peer aun#alice

# 读取 process 级参数
ec config get ecweb.port --process
```

**输出示例**：

```
chatmode.private = proactive          # effective
  解析链（低 → 高）：
    defaults  : (未定义)
    agent     : interactive
    relation  : proactive   ← 命中
```

### set - 写入参数

```bash
# 写入 agent 级
ec config set chatmode.private proactive --self bot1

# 写入关系级
ec config set baseagents.claude.model opus --self bot1 --peer aun#alice

# 写入 defaults
ec config set models.default opus --default

# 写入 process
ec config set ecweb.port 8080 --process
```

**注意**：
- 作用域由 selector 推断
- 写操作必须显式指定 selector（防误写）
- List 字段 set 是追加，不是替换

### show - 查看文件原始内容

```bash
# 查看 agent 配置
ec config show --self bot1

# 查看关系配置
ec config show --self bot1 --peer aun#alice

# 查看 defaults
ec config show --default
```

**输出**：JSON 原始内容，凭证显示 `${VAR}` 占位符。

### effective - 查看合并后配置

```bash
# 查看 agent 级合并结果
ec config effective --self bot1

# 查看关系级合并结果
ec config effective --self bot1 --peer aun#alice
```

**输出**：合并后的完整配置，每个字段标注来源。

### snapshot - 创建快照

```bash
# 自动判断类型（增量/全量）
ec config snapshot

# 强制全量
ec config snapshot --full

# 带描述
ec config snapshot --desc "修改 alice 模型配置"
```

### restore - 恢复版本

```bash
# 恢复到指定版本
ec config restore v100

# 会提示确认
# 成功后 current 和 w-version 都指向 v100
```

### history - 查看快照历史

```bash
# 列出所有快照
ec config history

# 输出格式
# v103  2026-06-10 03:30  startup     捕获 alice 的 chatmode 改动  (successCount: 5)
# v102  2026-06-09 22:15  manual      手动快照  (successCount: 3)
```

### diff - 对比版本

```bash
# 对比两个版本
ec config diff v100 v103

# 输出参数级差异
# agents/bot1/config.json:
#   chatmode.private: interactive → proactive
#   baseagents.claude.model: sonnet → opus
```

### schema - 查看 schema 定义

查看随包分发的配置 schema **定义本身**（`kits/schemas/*.schema.*.json`）——不是读写配置值，而是查「某作用域有哪些字段、类型/枚举/默认、schema 有几个版本」。纯只读，数据源为 `schema-registry`（读 `_meta.json` + 扫描 schema 文件），人和 agent 均可。

```bash
# 概览：列出全部逻辑 schema 及各自当前版本
ec config schema

# 列出某 schema 磁盘上所有版本（* 标当前，附日期/说明）
ec config schema agent-config --list

# 查看某 schema 的完整定义（缺省版本号 = 当前版本）
ec config schema agent-config
ec config schema agent-config 2
```

逻辑 schema 名：`evolclaw` / `defaults` / `agent-config` / `relation-config` / `contact-book`。

三种输出模式（由参数决定）：

| 调用形式 | mode | 输出 |
|----------|------|------|
| `config schema` | overview | 全部 schema + 各自当前版本号 |
| `config schema <name> --list` | versions | 该 schema 所有磁盘版本，`*` 标当前，附 date/description |
| `config schema <name> [version]` | content | 指定版本（缺省=当前）的完整 schema JSON |

**参数约定与报错**：

| 情形 | 错误码 |
|------|--------|
| `--list` 与 version 参数同时给出 | `INVALID_CONFIG_COMMAND` |
| `--list` 或指定 version 却未带 `<name>` | `MISSING_ARG` |
| version 非非负整数 | `INVALID_CONFIG_VALUE` |
| 未知 schema 名 | `UNKNOWN_SCHEMA`（错误信息列出已知名） |
| 版本不存在 | `SCHEMA_VERSION_NOT_FOUND`（错误信息列出可用版本） |

**典型用途**：写配置前用 `ec config fields` 看某层可设字段的取值，或用 `ec config schema <name>` 看该层 schema 的完整字段约束与 `x-merge` 合并语义；排查「字段为何被拒/怎么合并」时先定位 schema 版本。

---

## 五、与现有命令的关系

### 保留的快捷命令

| 现有命令 | 变更 | 说明 |
|---------|------|------|
| `ec model use/reset/effort` | **保留**，内部改走 ConfigManager | 是 `ec config set baseagents.*` 的快捷方式 |
| `ec ctl chatmode/dispatch/...` | **保留**，同上 | 是 `ec config set` 的快捷方式 |
| `ec agent get/set <aid> <key>` | **保留**，内部改走 ConfigManager | 位置参数别名 |

**例如**：
```bash
# 快捷命令
ec model use opus --self bot1
ec ctl chatmode private proactive --self bot1

# 等价于
ec config set baseagents.claude.model opus --self bot1
ec config set chatmode.private proactive --self bot1
```

---

## 六、权限裁剪

### Agent 托管环境

在 agent 托管环境（带 `EVOLCLAW_CTL_TOKEN`）下：

**允许**：
- 所有读操作（get/show/effective/fields/schema/list/history/diff/current/boots/validate）
- 写入任意参数（待权限体系实现后可能限制）

**禁止**：
- snapshot/prune/restore/init（仅人）
- 读写任何 `.env`

**凭证保护**：
- 读取时凭证显示 `${VAR}` 占位符，不泄露明文

---

## 七、错误处理

### 写操作拒绝

| 情形 | 错误信息 |
|------|---------|
| 无 selector | `写操作必须指定作用域：--self <aid> / --default / --process` |
| Schema 验证失败 | `参数 <field> 类型错误：期望 string，得到 number` |
| 文件不存在 | `配置文件不存在，使用 ec config init 创建` |

### 读操作

| 情形 | 行为 |
|------|------|
| 文件不存在 | 返回空或提示 |
| 参数不存在 | 返回 `(未定义)` |
| 解析错误 | 报错并提示修复 |

---

## 八、实现位置

新建 `src/cli/config-commands.ts`，注册到 `ec config` 子命令。

---

## 十、配置修改方式对比

### 方式 1：CLI 命令（推荐）

```bash
ec config set chatmode.private proactive --self bot1
```

**优点**：
- ✅ Schema 自动验证
- ✅ 权限检查
- ✅ 原子性保证
- ✅ 审计日志
- ✅ 自动触发快照（P2）

**适用场景**：日常配置修改

---

### 方式 2：直接编辑文件（不推荐）

```bash
vim ~/.evolclaw/agents/bot1.aid.pub/config.json
```

**问题**：
- ❌ 无 schema 验证（可能写入非法值）
- ❌ 无权限检查
- ❌ 无审计日志
- ⚠️ 需手动触发快照或等待下次启动（P2 自动捕获）
- ⚠️ 并发修改风险

**但是**：直接编辑仍然是允许的，系统会在下次启动时：
1. 检测到 W ≠ w-version（P2 触发条件）
2. 自动创建快照（trigger=startup）
3. 校验配置（启动时 schema 验证）
4. 如果校验失败 → 进入自检模式（如果启用）

**适用场景**：
- 批量修改（脚本生成配置）
- 紧急修复（daemon 未运行）
- 开发调试

---

### 方式 3：编程接口

```typescript
import { configManager } from './config/config-manager';

configManager.write(
  ConfigTarget.Agent,
  { chatmode: { private: 'proactive' } },
  { self: 'bot1.aid.pub', merge: true }
);
```

**优点**：
- ✅ Schema 验证
- ✅ 原子性保证
- ✅ 可编程、可批量

**适用场景**：
- 自动化脚本
- 集成到其他系统
- 批量操作

---

### 方式 4：Web 界面（ECWeb）

见 [09-ecweb-integration.md](./09-ecweb-integration.md)

**优点**：
- ✅ 可视化
- ✅ 实时验证
- ✅ 批量操作支持

**适用场景**：
- 日常管理
- 非技术人员
- 可视化对比

---

## 十一、配置修改的原子性与并发

### 原子性保证

CLI 命令使用 ConfigManager，内部实现原子写入：

```
1. 读取当前文件 + mtime
2. 合并内容（如果 --merge）
3. Schema 验证
4. 写入临时文件（.tmp.{timestamp}）
5. 检查 mtime（乐观锁）
6. 原子替换（rename）
7. 清除缓存
```

**关键点**：
- `rename` 是原子操作（在大多数文件系统上）
- 要么全部成功，要么全部失败
- 不会出现"写了一半"的情况

---

### 并发修改检测

**场景**：两个进程同时修改同一个配置文件

```bash
# 进程 A
ec config set chatmode.private proactive --self bot1

# 进程 B（同时执行）
ec config set flush_delay 5 --self bot1
```

**处理流程**：

1. **进程 A** 和 **进程 B** 同时读取文件（mtime=100）
2. **进程 A** 先完成写入 → mtime 变为 101
3. **进程 B** 尝试写入时检测到 mtime 不匹配（期望 100，实际 101）
4. **进程 B** 抛出 `ConfigConflictError`
5. **进程 B** 自动重试：
   - 重新读取文件（包含进程 A 的修改）
   - 合并自己的修改
   - 再次尝试写入

**用户体验**：
- 大多数情况下自动重试成功，用户无感知
- 极少数情况（连续冲突）可能提示"配置文件繁忙，请稍后重试"

---

### 直接编辑文件的并发风险

**问题**：如果用户直接编辑文件，无法检测并发冲突

```bash
# 终端 1
vim ~/.evolclaw/agents/bot1.aid.pub/config.json
# 修改 chatmode.private = proactive
# 保存（但还没退出 vim）

# 终端 2（同时）
ec config set flush_delay 5 --self bot1
# ✅ 成功写入

# 终端 1
# 继续保存退出
# ⚠️ 覆盖了终端 2 的修改！
```

**缓解措施**：
- 建议使用 CLI 而非直接编辑
- 如果必须直接编辑，确保没有其他进程在操作
- daemon 启动时会检测并快照（P2）

---

## 十二、配置生效时机

### 立即生效

以下操作**立即生效**（下一条消息使用新配置）：

- `ec config set` 修改配置
- 直接编辑文件并保存
- 通过 ECWeb 修改配置

**原因**：
- ConfigManager 使用 mtime 门控缓存
- 文件修改后缓存自动失效
- 下次读取时加载新内容
- 每条消息实时解析配置（不缓存到会话）

**示例**：

```bash
# 当前 alice 的对话模式是 interactive
# 发送消息 → 立即回复

# 修改配置
ec config set chatmode.private proactive --self bot1 --peer aun#alice

# 再发送消息 → 需要显式发送（proactive 模式）
# ✅ 立即生效
```

---

### 需要重启生效

以下配置修改需要**重启 daemon**：

| 配置项 | 原因 |
|--------|------|
| `evolclaw.json` 的任何字段 | 进程级配置，启动时读取 |
| `channels[]` 的增删 | 渠道实例在启动时创建 |
| `channels[].appId/appSecret` | 渠道认证在启动时初始化 |
| `aun.encryptionSeed` | keystore 在启动时解密 |

**重启方式**：

```bash
ec restart
# 或
ec stop && ec start
```

---

### 热更新配置

以下配置支持**热更新**（无需重启）：

| 配置项 | 生效时机 |
|--------|---------|
| `chatmode.*` | 下一条消息 |
| `flush_delay`, `debounce` | 下一条消息 |
| `show_activities` | 下一条消息 |
| `baseagents.*.model` | 下一条消息（新会话使用新模型） |
| `baseagents.*.effort` | 下一条消息 |
| `permissionMode` | 下一次权限检查 |
| `render.*` | 下一条消息 |
| 关系级任何配置 | 下一条消息 |

**原理**：
- 每条消息到达时重新解析配置
- 覆盖链实时合并
- 无会话级缓存

---

## 十三、配置修改的最佳实践

### 1. 优先使用 CLI

```bash
# ✅ 推荐
ec config set chatmode.private proactive --self bot1

# ❌ 不推荐（除非批量操作）
vim ~/.evolclaw/agents/bot1.aid.pub/config.json
```

### 2. 修改前先查看当前值

```bash
# 查看当前值和来源
ec config get chatmode.private --self bot1

# 查看完整配置
ec config effective --self bot1
```

### 3. 重要修改前创建快照

```bash
# 创建快照
ec config snapshot --desc "修改 alice 的模型配置前"

# 修改配置
ec config set baseagents.claude.model opus --self bot1 --peer aun#alice

# 如果有问题，回滚
ec config restore v100
```

### 4. 批量修改使用脚本

```bash
# 批量修改所有 agent 的默认模型
for aid in $(ec agent list --format json | jq -r '.[].aid'); do
  ec config set models.default opus --self "$aid"
done
```

### 5. 生产环境谨慎操作

```bash
# 先在测试 agent 上验证
ec config set chatmode.private proactive --self test-bot

# 确认无误后再应用到生产
ec config set chatmode.private proactive --self prod-bot
```

---

## 十四、配置修改的审计

### 审计日志位置

```
{evolclaw_home}/logs/config-audit.jsonl
```

### 日志格式

```jsonl
{"timestamp":"2026-06-19T10:30:00Z","caller":"human","command":"ec config set chatmode.private proactive --self bot1","target":"agent/bot1","field":"chatmode.private","oldValue":"interactive","newValue":"proactive"}
{"timestamp":"2026-06-19T10:35:00Z","caller":"ecweb:admin","ip":"192.168.1.100","target":"agent/bot1","field":"baseagents.claude.model","oldValue":"sonnet","newValue":"opus"}
```

### 查询审计日志

```bash
# 查看最近的配置修改
tail -20 ~/.evolclaw/logs/config-audit.jsonl

# 查看特定 agent 的修改历史
grep '"target":"agent/bot1"' ~/.evolclaw/logs/config-audit.jsonl

# 查看特定字段的修改历史
grep '"field":"chatmode.private"' ~/.evolclaw/logs/config-audit.jsonl
```

---

## 九、快速参考

### 常用操作

```bash
# 读取配置
ec config get chatmode.private --self bot1
ec config show --self bot1
ec config effective --self bot1

# 修改配置
ec config set chatmode.private proactive --self bot1
ec config set baseagents.claude.model opus --self bot1 --peer aun#alice

# 快照管理
ec config snapshot
ec config history
ec config restore v100

# 自检启动
ec start --diagnose
```

---

## 相关文档

- [01-overview.md](./01-overview.md) - 总体架构
- [05-snapshot.md](./05-snapshot.md) - 快照与回滚机制
- [07-security.md](./07-security.md) - 安全与权限
- [08-quick-reference.md](./08-quick-reference.md) - 快速参考
