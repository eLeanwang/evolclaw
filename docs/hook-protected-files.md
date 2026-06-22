# Hook 机制保护的文件清单

> 版本：v0.5.0
> 更新时间：2026-06-20
> 目的：明确哪些文件需要被 Hook 保护，禁止 agent 直接读写

---

## 保护策略

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| **禁止读写** | agent 完全无法访问 | 配置文件、快照、系统状态 |
| **只读允许** | agent 可读但不可写 | 某些元数据（待定） |
| **通过 CLI** | 必须通过 evolclaw CLI 操作 | 所有配置修改 |

**当前阶段实施**：**禁止读写** - agent 完全无法直接访问受保护文件

---

## 一、配置文件（核心保护对象）

### 1.1 全局配置

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/evolclaw.json` | 进程级配置 | 禁止读写 |
| `$EVOLCLAW_HOME/agents/defaults.json` | 默认配置 | 禁止读写 |

**CLI 替代操作**：
- 读取：`evolclaw config get <field> --default`
- 写入：`evolclaw config set <field> <value> --default`
- 查看：`evolclaw config show --default`

### 1.2 Agent 配置

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/agents/<aid>/config.json` | agent 级配置 | 禁止读写 |

**CLI 替代操作**：
- 读取：`evolclaw config get <field> --self <aid>`
- 写入：`evolclaw config set <field> <value> --self <aid>`
- 查看：`evolclaw config show --self <aid>`

### 1.3 Relation 配置（设计中）

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/agents/<aid>/relations/<peerKey>/config.json` | relation 级配置 | 禁止读写 |

**CLI 替代操作**：
- 读取：`evolclaw config get <field> --self <aid> --peer <peerKey>`
- 写入：`evolclaw config set <field> <value> --self <aid> --peer <peerKey>`

---

## 二、快照和版本控制文件

### 2.1 快照目录

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/backups/config/` | 快照根目录 | 禁止读写 |
| `$EVOLCLAW_HOME/backups/config/vXXX/` | 版本快照目录 | 禁止读写 |
| `$EVOLCLAW_HOME/backups/config/vXXX/meta.json` | 快照元数据 | 禁止读写 |
| `$EVOLCLAW_HOME/backups/config/vXXX/snapshot/` | 快照内容 | 禁止读写 |

### 2.2 版本控制文件

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/backups/config/w-version.json` | 工作版本指针 | 禁止读写 |
| `$EVOLCLAW_HOME/backups/config/current.json` | 当前选定版本 | 禁止读写 |
| `$EVOLCLAW_HOME/backups/config/boot-log.jsonl` | 启动日志 | 禁止读写 |

**CLI 替代操作**：
- 创建快照：`evolclaw config snapshot [--full] --desc "..."`
- 查看历史：`evolclaw config history`
- 恢复版本：`evolclaw config restore <version>`
- 对比版本：`evolclaw config diff <v1> <v2>`

---

## 三、证书和密钥（高敏感）

### 3.1 证书目录

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/CA/` | 根证书目录 | 禁止读写 |
| `$EVOLCLAW_HOME/aids/<aid>/cert/` | agent 证书 | 禁止读写 |
| `$EVOLCLAW_HOME/aids/<aid>/keys/` | agent 密钥 | 禁止读写 |

**说明**：
- 证书和密钥是高度敏感数据
- agent 通过 AUN SDK 使用证书，不直接访问文件
- CLI 操作：`evolclaw aid cert ...`（待完善）

---

## 四、系统状态文件

### 4.1 锁和 PID 文件

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/.lock` | 全局锁文件（如果存在） | 禁止读写 |
| `$EVOLCLAW_HOME/daemon.pid` | Daemon PID（如果存在） | 禁止读写 |

### 4.2 设备标识

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/.device_id` | 设备唯一标识 | 禁止读写 |
| `$EVOLCLAW_HOME/.seed.migrated.*` | 迁移标记 | 禁止读写 |
| `$EVOLCLAW_HOME/.migrated-from-aun` | 迁移标记 | 禁止读写 |

---

## 五、备份和归档文件

### 5.1 配置备份

| 文件路径 | 用途 | 保护级别 |
|---------|------|----------|
| `$EVOLCLAW_HOME/agents/defaults_*.json` | defaults 历史备份 | 禁止读写 |
| `$EVOLCLAW_HOME/agents/*/config.json_` | config 备份（`_` 后缀） | 禁止读写 |
| `$EVOLCLAW_HOME/*.json.migrated` | 迁移归档 | 禁止读写 |

**说明**：这些是系统自动创建的备份文件，不应被 agent 修改

---

## 六、可能需要保护的其他文件

### 6.1 环境配置

| 文件路径 | 用途 | 保护级别 | 待定原因 |
|---------|------|----------|----------|
| `$EVOLCLAW_HOME/.env` | 环境变量配置 | 禁止读写？ | 包含凭证信息 |

### 6.2 数据目录（待讨论）

| 文件路径 | 用途 | 保护级别 | 待定原因 |
|---------|------|----------|----------|
| `$EVOLCLAW_HOME/agents/<aid>/relations/` | 关系数据 | ？ | agent 可能需要读取 |
| `$EVOLCLAW_HOME/agents/<aid>/personal/` | 个人数据 | ？ | agent 可能需要读取 |
| `$EVOLCLAW_HOME/agents/<aid>/venues/` | 环境数据 | ？ | agent 可能需要读取 |
| `$EVOLCLAW_HOME/agents/<aid>/sessions/` | 会话数据 | ？ | agent 可能需要读取 |
| `$EVOLCLAW_HOME/data/` | 系统数据目录 | ？ | 包含多种数据 |

**说明**：这些目录可能需要 agent 读取来工作，但可能需要限制写入

---

## 七、保护文件的模式匹配规则

### 7.1 精确路径匹配

```
$EVOLCLAW_HOME/evolclaw.json
$EVOLCLAW_HOME/agents/defaults.json
$EVOLCLAW_HOME/.device_id
$EVOLCLAW_HOME/.env
```

### 7.2 模式匹配（glob）

```
# 配置文件
$EVOLCLAW_HOME/agents/*/config.json
$EVOLCLAW_HOME/agents/*/relations/*/config.json

# 快照目录
$EVOLCLAW_HOME/backups/config/**/*

# 备份文件
$EVOLCLAW_HOME/**/*.json_
$EVOLCLAW_HOME/**/*.json.migrated
$EVOLCLAW_HOME/**/defaults_*.json

# 证书和密钥
$EVOLCLAW_HOME/CA/**/*
$EVOLCLAW_HOME/aids/*/cert/**/*
$EVOLCLAW_HOME/aids/*/keys/**/*

# 系统标记文件
$EVOLCLAW_HOME/.seed.*
$EVOLCLAW_HOME/.migrated-*
$EVOLCLAW_HOME/.lock
$EVOLCLAW_HOME/daemon.pid
```

### 7.3 正则表达式匹配

```javascript
// 配置文件
/^.*\/config\.json$/
/^.*\/defaults\.json$/
/^.*\/evolclaw\.json$/

// 备份文件
/^.*\.json_$/
/^.*\.json\.migrated$/
/^.*\/defaults_\d+\.json$/

// 快照目录
/^.*\/backups\/config\/.*/

// 证书密钥
/^.*\/(CA|aids|cert|keys)\/.*/
```

---

## 八、实现策略

### 8.1 Claude Code Hook

**位置**：Claude Code 的 settings.json 或全局配置

**Hook 类型**：
- `ReadFileHook` - 读取文件前检查
- `WriteFileHook` - 写入文件前检查
- `EditFileHook` - 编辑文件前检查

**实现方式**：
```json
{
  "hooks": {
    "ReadFile": {
      "script": "evolclaw-file-guard",
      "protected": [
        "$EVOLCLAW_HOME/evolclaw.json",
        "$EVOLCLAW_HOME/agents/defaults.json",
        "$EVOLCLAW_HOME/agents/*/config.json",
        "$EVOLCLAW_HOME/backups/config/**/*"
      ]
    },
    "WriteFile": {
      "script": "evolclaw-file-guard",
      "protected": ["...同上"]
    }
  }
}
```

### 8.2 Codex Hook

**位置**：Codex 的配置系统

**实现方式**：
- 在 Codex 的文件操作层注入检查逻辑
- 检查文件路径是否匹配保护规则
- 拒绝访问并提示使用 CLI

### 8.3 Hook Guard 脚本

**脚本名**：`evolclaw-file-guard`

**功能**：
1. 接收文件路径和操作类型（read/write/edit）
2. 检查路径是否匹配保护规则
3. 如果匹配，返回拒绝并提示 CLI 命令
4. 如果不匹配，允许操作

**返回格式**：
```json
{
  "allowed": false,
  "reason": "配置文件受保护，请使用: evolclaw config get <field> --self <aid>",
  "suggestedCommand": "evolclaw config get <field> --self <aid>"
}
```

---

## 九、错误提示信息

当 agent 尝试访问受保护文件时，应给出清晰的错误提示：

### 9.1 配置文件

```
❌ 此文件受保护，无法直接访问。

文件：~/.evolclaw/agents/dddd.agentid.pub/config.json
类型：agent 配置文件

请使用以下命令操作：
  查看配置：evolclaw config show --self dddd.agentid.pub
  读取字段：evolclaw config get <field> --self dddd.agentid.pub
  修改字段：evolclaw config set <field> <value> --self dddd.agentid.pub

文档：run `evolclaw config --help`
```

### 9.2 快照文件

```
❌ 此文件受保护，无法直接访问。

文件：~/.evolclaw/backups/config/v200/meta.json
类型：配置快照文件

快照系统由 evolclaw 自动管理，请使用以下命令：
  查看历史：evolclaw config history
  查看快照：evolclaw config show-snapshot <version>
  恢复快照：evolclaw config restore <version>

文档：run `evolclaw config snapshot --help`
```

### 9.3 证书密钥

```
❌ 此文件受保护，无法直接访问。

文件：~/.evolclaw/aids/dddd.agentid.pub/cert/agent.crt
类型：证书文件（高度敏感）

证书由 evolclaw 和 AUN SDK 自动管理，请使用：
  查看证书信息：evolclaw aid cert show <aid>
  更新证书：evolclaw aid cert renew <aid>

文档：run `evolclaw aid --help`
```

---

## 十、待讨论的问题

### 10.1 读写权限分离

**问题**：某些文件 agent 需要**读取**来工作（如 relations/personal/venues），但不应**修改**。

**方案**：
- **方案 A**：读写都禁止，通过 API 提供数据
- **方案 B**：允许读取，仅禁止写入
- **方案 C**：不同文件不同策略

**建议**：先实施方案 A（全部禁止），观察实际需求后调整

### 10.2 临时文件和日志

**问题**：agent 可能需要创建临时文件或写日志

**方案**：
- 在 `$EVOLCLAW_HOME` 之外允许任意读写
- 或者在 `$EVOLCLAW_HOME/agents/<aid>/temp/` 等特定目录允许写入

### 10.3 环境变量文件

**问题**：`.env` 文件包含凭证，但 agent 可能需要读取某些环境变量

**方案**：
- 禁止直接访问 `.env` 文件
- 通过环境变量传递给 agent（已注入到进程环境）

---

## 十一、实施计划

### 阶段 1：核心保护（当前）

保护范围：
- ✅ 所有配置文件（evolclaw.json, defaults.json, config.json）
- ✅ 快照目录（backups/config/）
- ✅ 证书密钥（CA/, aids/*/cert/, aids/*/keys/）
- ✅ 系统状态文件（.device_id, .env, .lock 等）

### 阶段 2：细化权限（后续）

- 区分读写权限
- 允许 agent 读取某些元数据
- 根据实际需求调整策略

### 阶段 3：审计和监控（未来）

- 记录所有被拒绝的访问尝试
- 分析访问模式，优化保护规则
- 提供审计报告

---

## 十二、相关文档

- [配置系统设计 v2](./config-system-design-v2.md)
- [配置命令测试报告](./config/TEST-REPORT.md)
- [Hook 机制实现指南](./hook-implementation-guide.md)（待创建）

---

**文档维护者**：Kiro
**最后更新**：2026-06-20
