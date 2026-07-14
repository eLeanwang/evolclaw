# 快速参考

> EvolClaw 配置体系 v3
> 上一篇：[07-security.md](./07-security.md)

---

## 一、配置层级

```
process (evolclaw.json)          ← 进程级（独立，不参与覆盖链）
  
defaults (defaults.json)         ← 全局级（最低优先级）
  ↓
agent (agent/config.json)        ← Agent 级
  ↓
relation (relation/config.json)  ← 关系级（最高优先级）
```

---

## 二、文件位置速查

| 配置文件 | 路径 | Schema |
|---------|------|--------|
| 进程级 | `{evolclaw_home}/evolclaw.json` | `evolclaw.schema.1.json` |
| 全局级 | `{evolclaw_home}/agents/defaults.json` | `defaults.schema.1.json` |
| Agent级 | `{evolclaw_home}/agents/{aid}/config.json` | `agent-config.schema.1.json` |
| 关系级 | `{evolclaw_home}/agents/{aid}/relations/{peerKey}/config.json` | `relation-config.schema.1.json` |
| 全局凭证 | `{evolclaw_home}/.env` | — |
| Agent凭证 | `{evolclaw_home}/agents/{aid}/.env` | — |
| 关系凭证 | `{evolclaw_home}/agents/{aid}/relations/{peerKey}/.env` | — |
| 快照目录 | `{evolclaw_home}/backups/config/` | — |

---

## 三、常用 CLI 命令

### 读取配置

```bash
# 查看参数值（含解析链）
ec config get <field> --self <aid> [--peer <peerKey>]

# 查看文件原始内容
ec config show --self <aid>

# 查看合并后的配置
ec config effective --self <aid>

# 列出所有配置文件
ec config list

# 查看 schema 定义（字段/类型/版本）
ec config schema                       # 全部 schema + 当前版本
ec config schema agent-config --list   # 某 schema 的所有版本
ec config schema agent-config [version]# 某版本完整定义（缺省=当前）
```

### 修改配置

```bash
# 设置参数
ec config set <field> <value> --self <aid>
ec config set <field> <value> --self <aid> --peer <peerKey>
ec config set <field> <value> --default
ec config set <field> <value> --process

# 删除参数（回落到下一层）
ec config unset <field> --self <aid>

# 快捷命令（等价）
ec model use <model> --self <aid>
ec ctl chatmode private <mode> --self <aid>
```

### 快照管理

```bash
# 创建快照
ec config snapshot
ec config snapshot --full --desc "描述"

# 查看历史
ec config history

# 对比版本
ec config diff v100 v103

# 恢复版本
ec config restore v100

# 查看当前版本
ec config current
```

### 自检启动

```bash
# 启动失败时逐版本回落
ec start --diagnose
ec restart --diagnose
```

---

## 四、Selector 速查

| Selector | 作用域 | 示例 |
|---------|--------|------|
| `--self <aid>` | agent 级 | `--self bot1.aid.pub` |
| `--self <aid> --peer <peerKey>` | relation 级 | `--self bot1.aid.pub --peer aun#alice.aid.pub` |
| `--default` | 全局级 | `--default` |
| `--process` | 进程级 | `--process` |

---

## 五、参数分类速查

### 身份与安全（7个）

- `aid` - Agent 标识
- `owners[]` - 控制面鉴权名单
- `admins[]` - 管理员名单
- `enabled` - Agent 启用状态
- `initialized` - 初始化标记
- `observable` - 观察者模式

### 模型配置（支持关系级）

- `models.default` - 默认模型
- `models.allowed[]` - 模型白名单
- `active_baseagent` - 当前活跃引擎
- `baseagents.claude.model` - Claude 模型
- `baseagents.claude.effort` - Claude 推理强度
- `baseagents.codex.model` - Codex 模型
- `baseagents.gemini.model` - Gemini 模型

### 对话模式（支持关系级）

- `chatmode.private` - 私聊模式（interactive/proactive）
- `chatmode.group` - 群聊模式
- `flush_delay` - 消息 flush 间隔（秒）
- `debounce` - 消息去抖间隔（秒）
- `dispatch` - 群聊分发策略（mention/broadcast）

### 交互体验（支持关系级）

- `show_activities` - 中间活动可见性（all/none）
- `enable_rich_content` - 富内容渲染
- `render.private` - 私聊渲染模式
- `render.group` - 群聊渲染模式
- `proactive.pre_tool_1stmsgchk` - Proactive 首次工具检查
- `proactive.tool_use_reminder` - Proactive 工具提醒

### 权限控制（支持关系级）

- `permissionMode` - 执行权限模式
- `roles.<role>.baseagents` - 角色级 baseagents 覆盖
- `roles.<role>.permissionMode` - 角色级权限覆盖

### 基础设施

- `channels[]` - 渠道配置
- `aun` - AUN 配置
- `projects` - 项目路径
- `debug` - 调试配置
- `extra_backup[]` - 额外备份声明

完整参数清单见 [config-params-classified.md](./config-params-classified.md)。

---

## 六、覆盖链合并规则

| 类型 | 合并行为 | 示例 |
|------|---------|------|
| **标量** (string/number/bool) | 高优先级覆盖 | `active_baseagent: "claude"` |
| **列表** (array) | 并集去重 | `owners: ["a", "b"]` + `["c"]` = `["a", "b", "c"]` |
| **字典** (object) | 键并集，同键覆盖（不递归） | `baseagents: {claude: {model}}` |

详见 [02-merge-rules.md](./02-merge-rules.md)。

---

## 七、凭证管理

### 引用格式

```jsonc
// config.json
{
  "channels": [
    { "appSecret": "${FEISHU_APP_SECRET}" }
  ]
}

// .env
FEISHU_APP_SECRET=xxx
```

### 解析优先级

```
relation/.env > agent/.env > {evolclaw_home}/.env > process.env
```

### 安全要点

- ✅ 凭证只存 `.env`
- ✅ 配置 JSON 只存引用
- ✅ CLI 读取不展开（显示 `${VAR}`）
- ✅ Hook 拦截直接访问

---

## 八、快照机制

### 双指针

| 文件 | 含义 |
|------|------|
| `current.json` | 回落起点指针 |
| `w-version.json` | 工作目录当前版本 |

### 版本产生时机

- ✅ 手动：`ec config snapshot`
- ✅ 启动成功 + 有未存改动
- ✅ Schema 迁移前
- ✅ 进入自检模式时

### 版本号

- 全量：v100, v200, v300...（百位递增）
- 增量：v101, v102...（在全量下递增）

详见 [05-snapshot.md](./05-snapshot.md)。

---

## 九、自检模式

### 触发方式

```bash
ec start --diagnose
# 或
EVOLCLAW_DIAGNOSE=1 ec start
```

### 回落流程

1. 从 current 往老遍历
2. 只尝试 successCount > 0 的版本
3. 逐版本展开并真实探测
4. 成功 → 更新 w-version，current 不变
5. 失败 → 继续下一个

### 回落资格

```
successCount > 0  或  序列中最新两个
```

---

## 十、常见操作示例

### 为新 agent 初始化配置

```bash
ec config init --self bot1.aid.pub
```

### 修改 agent 的对话模式

```bash
ec config set chatmode.private proactive --self bot1.aid.pub
```

### 为特定用户设置模型

```bash
ec config set baseagents.claude.model opus \
  --self bot1.aid.pub --peer aun#alice.aid.pub
```

### 查看配置生效值

```bash
ec config effective --self bot1.aid.pub --peer aun#alice.aid.pub
```

### 创建快照并恢复

```bash
# 创建快照
ec config snapshot --desc "调整前备份"

# 恢复
ec config restore v100
```

### 对比两个版本

```bash
ec config diff v100 v103
```

---

## 十一、故障排查

### 配置不生效

1. 检查 selector 是否正确
2. 查看解析链：`ec config get <field> --self <aid>`
3. 查看合并结果：`ec config effective --self <aid>`
4. 检查 schema 验证：`ec config validate --self <aid>`

### 启动失败

1. 使用自检模式：`ec start --diagnose`
2. 查看启动日志：`ec config boots -n 10`
3. 对比当前版本与上次成功版本：`ec config diff`
4. 恢复到已知好版本：`ec config restore <version>`

### 凭证问题

1. 检查 .env 文件是否存在
2. 检查引用格式：`${VAR}`
3. 检查解析优先级（relation > agent > global）
4. 确认 Hook 未拦截 .env 读取

---

## 十二、迁移检查清单

从旧配置迁移到 v3：

- [ ] 备份所有配置文件
- [ ] 将 preferences.json 的 model 字段迁移到 relation/config.json（如有数据）
- [ ] 检查所有凭证已移入 .env
- [ ] 运行 schema 验证：`ec config validate`
- [ ] 创建迁移后快照：`ec config snapshot --full --desc "迁移到 v3"`
- [ ] 测试配置读取
- [ ] 测试配置修改

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [01-overview.md](./01-overview.md) | 总体架构 |
| [02-merge-rules.md](./02-merge-rules.md) | 覆盖链与合并规则 |
| [03-schema.md](./03-schema.md) | Schema 治理 |
| [04-config-manager.md](./04-config-manager.md) | ConfigManager API |
| [05-snapshot.md](./05-snapshot.md) | 快照与回滚机制 |
| [06-cli-commands.md](./06-cli-commands.md) | CLI 命令完整清单 |
| [07-security.md](./07-security.md) | 安全与权限 |
| [config-params-classified.md](./config-params-classified.md) | 完整参数清单（81+ 个） |
| [code-refactoring-plan.md](./code-refactoring-plan.md) | 代码改造清单 |
