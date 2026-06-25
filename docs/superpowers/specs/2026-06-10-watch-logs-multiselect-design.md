# `ec watch logs` 多选日志监控 — 设计文档

**日期**：2026-06-10
**状态**：设计已确认，待写实现计划

## 背景

当前 `ec watch log` 经 `cmdWatch()`（`src/cli/index.ts`）实现：tail `logs/` 下**全部** `*.log` 文件，无法按类型筛选。日志类型很多（`evolclaw` / `aun` / `channel-in` / `channel-out` / `events` / `messages` / `restart` / `stdout` / `line-stats` / `ts-sdk-*` / `watch-web` 等），且每类有按小时轮转的多个文件，全量 tail 噪声大。

本次升级让用户通过勾选菜单选择要监控的日志类型，并把选择持久化到 `evolclaw.json`，下次自动预勾。

## 目标

- `ec watch logs`（复数）进入勾选菜单 → 保存选择 → 监控所选类型。
- `ec watch log <type...>`（单数带参）直接监控指定类型，不进菜单、不读写偏好。
- 选择按**日志类型**（去轮转后缀）粒度，持久化到 `evolclaw.json`。
- 每次进菜单预勾上次选择；保存后新出现的类型默认不勾。

## 非目标

- 不保留"无参看全部"的旧行为（明确不需要向后兼容）。
- 不改 `watch aid` / `watch msg` / `watch web`。
- 不做按具体文件（含日期轮转）粒度的勾选。

## 命令路由

`src/cli/index.ts` 的 `watch` case：

```
case 'watch':
  if (args[1] === 'aid')                      → cmdWatchAid()
  else if (args[1] === 'msg')                 → cmdWatchMsg()
  else if (args[1] === 'log' || args[1] === 'logs') {
    const types = args.slice(2);
    if (types.length > 0)  → cmdWatch(validateTypes(types))   // 直接监控，不存不读
    else                   → cmdWatchLogsFlow()               // 勾选菜单流程
  }
  else if (args[1] === 'web' || args[1] === 'session') → cmdWatchWeb()
  else if (!args[1])                          → cmdWatchMenu()
  else                                        → cmdWatchLogsFlow()
```

| 命令 | 行为 |
|---|---|
| `ec watch logs` / `ec watch log` | 勾选菜单（预勾上次）→ 保存 → 监控 |
| `ec watch log <type...>` | 直接监控指定类型，不读/不写偏好 |
| `ec watch`（顶层菜单选 log 项） | 同 `cmdWatchLogsFlow()` |

`validateTypes(types)`：扫描 `logs/*.log` 推导可用类型集合，逐个校验；任一无效则打印 `可用类型: evolclaw, aun, channel-in, ...` 后 `process.exit(1)`，不进监控。

## 方案选型

**方案 A（采用）— 复用 `cmdWatch` + 过滤参数**：新增 `cmdWatchLogsSelect()`（checkbox 菜单）与 `cmdWatchLogsFlow()`（编排），`cmdWatch()` 加 `filterTypes` 参数。改动小，与现有 tail 逻辑零冲突，菜单风格统一。

**方案 B（否决）— 独立命令自带 tail 循环**：重复 backfill / pumpFile / 实例登记约 150 行，维护两份。

## 组件设计

### 1. 配置与持久化

`EvolclawConfig`（`src/config-store.ts`）新增可选字段：

```typescript
export interface EvolclawConfig {
  // ...existing...
  watch?: {
    logTypes?: string[];   // 上次勾选的日志类型（shortName，去轮转后缀），如 ["evolclaw","aun","channel-in"]
  };
}
```

- 读：`loadEvolclawConfig().watch?.logTypes`。
- 写：`saveEvolclawConfig({ ...cfg, watch: { ...cfg.watch, logTypes } })`（保留其余字段，原子写）。
- 语义：`undefined` = 从未配置（菜单全部预勾）；非空数组 = 上次选择。确认时**不允许保存空集**（见 §2 Enter 行为），故不存在 `[]`。

### 2. 勾选菜单 `cmdWatchLogsSelect(types, preChecked)`

基于 `cmdWatchMenu` 的 raw-mode 模式扩展为 checkbox。

**入参**：`types: string[]`（可用类型，字母序）、`preChecked: Set<string>`（预勾集合）。
**返回**：`Promise<string[] | null>` — 选中类型数组；`null` = ESC/Ctrl+C 取消。

**菜单项来源**：扫描 `logs/*.log`，用现有 `shortName()` 去掉 `-YYYYMMDD-HH` 轮转后缀，去重，字母序。每项显示该类型当前匹配文件数，如 `channel-in (15 files)` / `stdout (1 file)`。

**预勾逻辑**：
- `logTypes === undefined` → 全部预勾。
- 有保存值 → 命中保存集的预勾；保存后才出现的新类型默认不勾。

**按键**：

| 键 | 行为 |
|---|---|
| ↑ / ↓ | 移动光标 |
| 空格 | 切换当前项勾选 |
| Enter | 校验：选中为空则提示"至少选择一项"并留在菜单；非空则确认返回 |
| ESC / Ctrl+C | 取消，返回 `null` |

**渲染**：`[✔] evolclaw   (8 files)` / `[ ] stdout   (1 file)`；光标行用 `▸` + 高亮。复用 `cmdWatchMenu` 的颜色常量（`RST`/`DIM`/`BOLD`/`CYAN`）。底部提示 `↑↓ 移动  空格 勾选  Enter 确认  ESC 取消`。

**raw-mode 交接**：退出时 `setRawMode(false)` 并移除自己的 `data` listener，再交给后续流程，避免两个 listener 抢输入。

### 3. 监控过滤 `cmdWatch(filterTypes: Set<string>)`

给 `cmdWatch()` 加参数 `filterTypes: Set<string>`（调用方永远传明确集合，无 `undefined` 兜底全部）：

- `listLogs()` 改为：列出 `logs/*.log` 后用 `shortName(file)` 判断 `filterTypes.has(...)`，只保留命中文件。
- backfill（最近 20 条）、实时 `pumpFile`、`updateMaxName`、实例登记全部不动——均经 `listLogs()`，过滤天然生效。
- 实时阶段新轮转文件（如跨小时新建 `channel-in-...-15.log`）：`shortName` 仍是 `channel-in`，命中 filter，自动纳入。

### 4. 编排 `cmdWatchLogsFlow()`

1. 扫描 `logs/*.log` → 推导类型列表（`shortName` 去重）。无 `.log` 文件则提示并退出。
2. 读 `loadEvolclawConfig().watch?.logTypes` → 计算 `preChecked`。
3. `const selected = await cmdWatchLogsSelect(types, preChecked)`。
4. `selected === null`（取消）→ 直接退出，不监控不保存。
5. 非空 → `saveEvolclawConfig({ ...cfg, watch: { ...cfg.watch, logTypes: selected } })`。
6. `cmdWatch(new Set(selected))` 进入实时监控。

**顶层 `cmdWatchMenu` 的 log 项**：原直接 `cmdWatch()`，改为 `await cmdWatchLogsFlow()`。标签/描述更新为"勾选日志类型监控（记忆上次选择）"。

## 数据流

```
ec watch logs
  → cmdWatchLogsFlow()
      → 扫描 logs/*.log → types[]
      → loadEvolclawConfig().watch?.logTypes → preChecked
      → cmdWatchLogsSelect(types, preChecked)  ──ESC──> 退出
            ↓ Enter(非空)
      → saveEvolclawConfig(watch.logTypes = selected)
      → cmdWatch(new Set(selected))
            → listLogs() 按 filterTypes 过滤 → backfill + 实时 tail
```

## 错误处理

- `logs/` 不存在或无 `.log`：提示后退出（沿用 `cmdWatch` 现有检查）。
- `ec watch log <type...>` 含无效类型：打印可用类型列表后 `exit(1)`。
- `cmdWatchLogsSelect` 空选 Enter：提示"至少选择一项"，留在菜单。
- 保存后所选类型当前无对应文件（类型已不再产生日志）：菜单仍可勾选（基于历史保存值），监控时 `listLogs()` 暂无命中文件即空 tail，待该类型再产生日志自动出现。
- 非 TTY（管道/重定向）：`cmdWatchLogsSelect` 无法交互 → 回退为使用已保存的 `logTypes`（无则全部）直接 `cmdWatch()`，与 `cmdWatchMenu` 的 `!isTTY` 处理一致。

## 测试策略

逻辑函数抽纯函数便于单测：

- `shortName()`（已存在）：轮转后缀剥离正确。
- 类型推导：给定文件名列表 → 去重类型集合（字母序）。
- 预勾计算：`(savedTypes | undefined, availableTypes)` → `preChecked`，覆盖 undefined=全选、新类型不勾、已存类型勾选三种。
- `validateTypes`：有效/无效类型分支。
- filter 过滤：给定文件列表 + filterTypes → 命中文件集。

raw-mode 交互菜单的按键循环不做自动化测试（与现有 `cmdWatchMenu` / `watch-msg` 一致，手动验证）。

## 涉及文件

- `src/config-store.ts` — `EvolclawConfig.watch.logTypes` 字段。
- `src/cli/index.ts` — `watch` case 路由、`cmdWatch(filterTypes)` 改造、新增 `cmdWatchLogsSelect()` 与 `cmdWatchLogsFlow()`、`cmdWatchMenu` log 项改向、help 文案。
- 测试文件 — 纯函数单测（类型推导 / 预勾 / validateTypes / filter）。

## 验收标准

1. `ec watch logs` 显示 checkbox 菜单，预勾上次选择（首次全勾）。
2. 空格切换、Enter 确认非空选择、ESC 取消。
3. 确认后选择写入 `evolclaw.json` 的 `watch.logTypes`，且只监控所选类型（含其轮转文件）。
4. 再次 `ec watch logs` 预勾上次选择；新出现的类型默认不勾。
5. `ec watch log evolclaw channel-in` 直接监控这两类，不修改 `evolclaw.json`。
6. `ec watch log <无效类型>` 报可用类型并退出。
7. `npm run build` 通过，新增纯函数单测通过。
