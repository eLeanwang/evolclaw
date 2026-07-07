# EvolClaw 配置体系文档

> 版本：v3 (2026-06-19)

---

## 快速开始

**推荐阅读顺序**：

1. 📖 [01-overview.md](./01-overview.md) - **从这里开始**：了解配置体系的总体架构
2. 📖 [08-quick-reference.md](./08-quick-reference.md) - 快速参考：常用命令和操作

---

## 完整文档目录

### 核心设计文档（按顺序阅读）

| # | 文档 | 说明 | 大小 |
|---|------|------|------|
| 1 | [01-overview.md](./01-overview.md) | 总体架构 - 四层配置、覆盖链、凭证管理 | 13K |
| 2 | [02-merge-rules.md](./02-merge-rules.md) | 覆盖链与合并规则 - 标量/列表/字典的合并语义 | 6.8K |
| 3 | [03-schema.md](./03-schema.md) | Schema 治理 - 版本化、迁移、验证 | 9.4K |
| 4 | [04-config-manager.md](./04-config-manager.md) | ConfigManager API - 统一读写入口 | 11K |
| 5 | [05-snapshot.md](./05-snapshot.md) | 快照与回滚机制 - 双指针模型、自检模式 | 19K |
| 6 | [06-cli-commands.md](./06-cli-commands.md) | CLI 命令体系 - ec config 完整清单 | 7.6K |
| 7 | [07-security.md](./07-security.md) | 安全与权限控制 - Hook 拦截、凭证保护 | 7.1K |
| 8 | [08-quick-reference.md](./08-quick-reference.md) | 快速参考 - 速查表、常用操作 | 8.3K |

### 参考文档

| 文档 | 说明 | 大小 |
|------|------|------|
| [config-params-classified.md](./config-params-classified.md) | 完整参数清单（81+ 个参数，按功能分类） | 17K |
| [config-roles-layer-design.md](./config-roles-layer-design.md) | 角色层设计（草案，未定稿） | 4.1K |

### 实施文档

| 文档 | 说明 | 大小 |
|------|------|------|
| [code-refactoring-plan.md](./code-refactoring-plan.md) | 代码改造清单（4 个阶段，19 个文件） | 8.7K |
| [config-system-v3-implementation-status.md](./config-system-v3-implementation-status.md) | 实现状态跟踪 | 11K |

---

## 核心概念速览

### 配置层级

```
process (evolclaw.json)          ← 进程级（独立）
  
defaults (defaults.json)         ← 全局级（最低优先级）
  ↓ 覆盖
agent (agent/config.json)        ← Agent 级
  ↓ 覆盖
relation (relation/config.json)  ← 关系级（最高优先级）
```

### 关键特性

- ✅ **统一配置文件**：所有参数都在 config.json
- ✅ **覆盖链合并**：defaults → agent → relation，自动合并
- ✅ **关系级个性化**：针对不同用户的配置（29 个参数）
- ✅ **凭证分离**：凭证存 .env，配置只存引用 `${VAR}`
- ✅ **Schema 治理**：类型验证、版本化、自动迁移
- ✅ **快照回滚**：自动备份、自检模式、逐版本回落
- ✅ **权限控制**：Hook 拦截 + API 层权限

### 常用命令

```bash
# 读取配置
ec config get <field> --self <aid>
ec config effective --self <aid>

# 修改配置
ec config set <field> <value> --self <aid>

# 快照管理
ec config snapshot
ec config history
ec config restore <version>

# 自检启动
ec start --diagnose
```

---

## 设计决策

### 核心原则

**统一配置模型**
- 所有参数统一在 config.json
- 权限控制在 API 层，而非文件级
- Hook 禁止 agent 直接读写配置文件

### 其他重要决策

- **唯一合并实现点**：全项目只有 ConfigManager 一处合并逻辑
- **Schema 是 SSOT**：参数类型与归属的唯一事实源
- **不递归合并**：字典合并只到第一层键
- **凭证永不快照**：.env 不进快照
- **自检不改 current**：回落是临时措施

---

## 实现状态

### 已完成 ✅

- Schema 文件生成（4 个 schema）
- 文档重写（8 个核心文档 + 4 个参考文档）
- 参数梳理（81+ 个参数，14 个分类）

### 待完成 ⏭️

- **阶段 1**：类型定义修改（2-3 小时）
- **阶段 2**：ConfigManager 改造（4-6 小时）
- **阶段 3**：调用方修改（6-8 小时）
- **阶段 4**：测试验证（4-6 小时）
- **数据迁移**：preferences.json → config.json（2-3 小时）

**总预计**：18-26 小时

详见 [config-system-v3-implementation-status.md](./config-system-v3-implementation-status.md)

---

## FAQ

### Q1：关系级配置是什么？

针对不同用户的个性化配置（如：VIP 用户用 opus，普通用户用 sonnet）。支持 29 个参数。详见 [01-overview.md](./01-overview.md) 第三节。

### Q2：如何迁移旧配置？

参考 [08-quick-reference.md](./08-quick-reference.md) 的"迁移检查清单"。

### Q3：配置修改后何时生效？

实时解析，下一条消息即时生效。详见 [02-merge-rules.md](./02-merge-rules.md) 第七节。

### Q4：如何回滚配置？

`ec config restore <version>` 或 `ec start --diagnose`（自检模式）。详见 [05-snapshot.md](./05-snapshot.md)。

---

## 贡献指南

### 文档更新

1. 修改对应文档
2. 更新本 README.md 的"最后更新"时间
3. 提交 PR

### 新增参数

1. 更新 schema 文件（`kits/schemas/`）
2. 更新 [config-params-classified.md](./config-params-classified.md)
3. 更新 [01-overview.md](./01-overview.md) 的参数表格

### 报告问题

在 [config-system-v3-implementation-status.md](./config-system-v3-implementation-status.md) 的"遗留问题"章节记录。

---

## 版本历史

- **v3** (2026-06-19)：当前版本

---

**最后更新**：2026-07-07
