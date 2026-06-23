# Phase 5 完成总结

## 范围调整（已拍板）

Phase 5 原计划 4 个任务（T5.1-T5.4）。经评估，**T5.3（Menu Protocol 对接）挪到 Phase 6**。

### 为什么调整？

Menu Protocol 走的是**会话内 slash 命令**路径（`MENU_NAME_MAP` → `/model`、`/chatmode` 等），由运行中会话进程处理。

但 `ec response` 是**持久化作用域配置命令**（改 config.json），类比的是 `ec model`——而 `ec model` **本身没有进 MENU_NAME_MAP**（map 里的 `model: '/model'` 是会话内即时切换的 `/model`，不是 `ec model`）。

**现状映射关系**：
- `/model`（会话内即时）→ Menu 有
- `ec model`（持久化作用域）→ Menu 没有，靠 CLI

持久化配置类命令本来就不通过 Menu Protocol，而是通过 CLI。`ec response` 同理。

**真正需要 Menu 对接的是会话内即时切换响应模式**——对应未来的 `/response` slash 命令（会话内即时），需要 Coordinator 接入后才有意义（因为要真实切换运行中会话的模式实例）。

**决策**：T5.3 与 Phase 6 一起做（Coordinator 接入后，加 `/response` slash 命令 + Menu 映射）。

---

## 已完成任务

### T5.1 field-scope ✅

`src/core/model/field-scope.ts`

**设计**：提取 config-scope 的通用部分（作用域判定 + peer 归一化），处理**顶层字段**（H 链 config.json）的作用域读写。

- 复用 `normalizePeer`/`determineScope`/`ModelScopeError`（同一套语义）
- `readField` / `writeField` / `clearField`（read-modify-write + schema 校验）
- 作用域：defaults / agent / relation（去掉 role，顶层字段无角色级）
- 与 config-scope 互补：field-scope 处理顶层字段，config-scope 处理 baseagents 嵌套结构

### T5.2 命令实现 ✅

**文件**：
- `src/cli/response.ts`（6 个子命令）
- `src/response-modes/builtin-meta.ts`（内置模式元数据清单）
- `src/cli/index.ts`（注册 response 分支 + help 文本）

**子命令**：
- `list [--scene]`：列出所有响应模式
- `current`：显示当前作用域生效配置
- `info <id>`：查看单个模式详情（场景/配置参数）
- `set <id> --scene <s>`：设置默认模式（--self 必须）
- `reset`：清除作用域配置
- `config [<id>]`：查看配置参数
- `config set <k> <v> --mode <id>`：修改配置参数

**亮点**：
- **内置模式元数据清单**（builtin-meta.ts）：CLI 与运行时共享的静态信息，与模式运行时实现解耦（Phase 6 实现模式时元数据保持一致）
- **写操作要求 --self**：response_modes 是行为参数，从 agent 级起步（与 `ec model` 一致，全局默认不承载行为参数）
- **统一错误捕获**（safeWrite）：ConfigError/ModelScopeError 显示友好错误（JSON + 文本）
- **值解析智能**：config set 的 value 先尝试 JSON 解析（数字/布尔/数组），失败则当字符串

### T5.4 命令集知识文档 ✅

- `kits/docs/evolclaw/response.md`：10 种内置模式表 + 作用域 + 解析优先级 + 权限 + 示例
- `kits/docs/evolclaw/INDEX.md`：登记 `ec response` 命令集
- `kits/rules/06-channel.md`：命令表加一行

---

## 验收

| 测试项 | 结果 |
|--------|------|
| list | ✅ 10 种内置模式正确显示（适用场景、描述） |
| info dual-session | ✅ JSON 输出完整（configSchema 含 auxiliary_model/relevance_threshold） |
| set --scene group --self <aid> | ✅ agent 级写入 default_group |
| set --peer <X> --self <aid> | ✅ relation 级写入 |
| current --self <aid> | ✅ 读出 default_group: dual-session |
| config set <k> <v> --mode <id> --self <aid> | ✅ 数字 0.8 正确解析（非字符串） |
| config <id> --self <aid> | ✅ 读出 relevance_threshold: 0.8 |
| reset --self <aid> | ✅ 清除成功，current 返回 null |
| scene 校验 | ✅ interactive 用于 group → SCENE_MISMATCH 友好报错 |
| --self 必须 | ✅ 写操作无 --self → SELF_REQUIRED 友好报错 |
| --format json | ✅ 所有子命令支持 |
| 构建 | ✅ 无破坏 |
| 测试 | ✅ 38 个测试全部通过 |

---

## 统计

| 项目 | 数量 |
|------|------|
| 新文件 | 3（field-scope + response CLI + builtin-meta） |
| 改文件 | 4（cli/index + kits 文档 3 处） |
| 代码行数 | ~380 行（CLI 300 + field-scope 80） |
| 内置模式元数据 | 10 种 |
| 命令 | 6 个子命令 + 7 个 flag |

---

最后更新：2026-06-23
