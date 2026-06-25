# ECWeb 系统菜单信息改进审查说明

日期：2026-06-25

## 背景

ECWeb 的系统页需要展示运行环境与依赖状态，用于排查服务版本、前端版本、底层 baseagent CLI 是否安装等问题。当前改动集中在 menu 协议的 `/system` 查询与检查动作上，目标是让 ECWeb 能拿到更完整、结构更稳定的系统信息。

本说明基于当前工作区未提交 diff 生成，涉及文件：

- `src/core/command/menu-handler.ts`

## 改进目标

1. `/system` query 返回 ECWeb 独立包版本。
2. `/system` query 返回主机上可用的 baseagent CLI 列表及版本。
3. `/system check` 保持 `delegateAsAction()` 的原始结构化返回，不再二次展开 `data.structured`。
4. 减少 ECWeb 对后端字段拼装逻辑的猜测，方便后续前端按稳定结构展示。

## 行为变更

### `/system` query

新增字段：

- `ecwebVersion`：通过 `resolveGlobalPkg('evolclaw-web')` 读取已安装的 ECWeb 全局包版本。
- `baseagents`：数组，格式为 `{ name, version }`。
  - 当前检测命令：`claude`、`gemini`、`codex`。
  - 仅当 `commandExists(cmd)` 为 true 时加入列表。
  - 版本通过 `<cmd> --version` 获取，最多等待 3 秒。
  - 版本解析使用 `\d+\.\d+\.\d+`，解析失败时 `version` 为 `null`。

移除字段：

- `agent`
- `channel`

这两个字段在当前系统信息响应里不是核心运行环境字段，而且 channel/agent 维度已有其他接口或结构可表达。若 ECWeb 仍依赖这两个字段，需要前端同步调整。

### `/system check`

旧逻辑会把 `data.structured` 展开并合并到顶层：

```ts
if (structured) return { data: { ...data, ...structured } };
```

新逻辑直接返回 `delegateAsAction()` 的结果，让结构保持在 `data.structured` 下：

```ts
return r as any;
```

这样可以避免同一份结构化数据同时存在于顶层和 `structured` 下，降低前端字段冲突风险。

## 实现概要

新增 helper：

- `getBaseagentVersion(cmd: string): string | null`

实现要点：

- 使用 `execSync(`${cmd} --version`)`。
- 设置 `timeout: 3000`，避免 CLI 卡住影响系统页响应。
- 捕获所有异常，失败返回 `null`。
- 在调用前先用 `commandExists(cmd)` 判断命令是否存在。

新增依赖导入：

- `execSync` from `child_process`
- `resolveGlobalPkg` from `../../utils/npm-ops.js`
- `commandExists` from `../../utils/cross-platform.js`

## 审查重点

1. `execSync` 是否可接受

当前调用只发生在 `/system` query，且每个 CLI 设置 3 秒 timeout。最差情况下三个命令串行可能带来约 9 秒延迟。建议审查 ECWeb 调用频率，如果系统页会高频轮询，应考虑缓存版本探测结果。

2. 版本解析是否足够稳健

当前只提取 `x.y.z`。已覆盖常见输出：

- `2.1.187 (Claude Code)`
- `0.38.0`
- `codex-cli 0.142.0`

如果未来 CLI 输出不含三段 semver，会返回 `null`，前端应展示“未知版本”而不是报错。

3. 移除 `agent` / `channel` 的兼容性

这是主要兼容风险。需要确认 ECWeb 系统页是否仍读取：

- `data.agent`
- `data.channel`

如果有，需要改用已有的 channel 列表或其他 agent 维度接口。

4. `/system check` 结构变化

前端应读取 `data.structured`，不要依赖展开后的顶层字段。该变化更利于长期维护，但可能影响旧版 ECWeb。

## 验证结果

已执行：

```bash
npx tsc --noEmit
npx vitest run tests/unit/menu-exec.test.ts tests/unit/menu-file.test.ts tests/unit/menu-process-auth.test.ts
```

结果：

- TypeScript 类型检查通过。
- 3 个测试文件通过。
- 111 个测试用例通过。

## 后续建议

1. 在 ECWeb 系统页增加对 `ecwebVersion` 和 `baseagents` 的展示。
2. 对 `/system` query 的版本探测增加短期缓存，避免系统页频繁打开时重复执行 CLI。
3. 给 `/system` query 增补单元测试，覆盖 `ecwebVersion`、`baseagents`、CLI 不存在、版本解析失败等场景。
4. 在前端审查时重点确认是否还依赖已移除的 `agent` / `channel` 顶层字段。
