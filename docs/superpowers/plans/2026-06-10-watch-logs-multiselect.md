# `ec watch logs` 多选日志监控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `ec watch logs` 进入勾选菜单选择要监控的日志类型并持久化到 `evolclaw.json`，`ec watch log <type...>` 直接监控指定类型。

**Architecture:** 纯逻辑（类型推导、预勾计算、校验、文件过滤）抽到新模块 `src/cli/watch-logs.ts` 便于单测；交互式 raw-mode checkbox 菜单（`cmdWatchLogsSelect`）与编排（`cmdWatchLogsFlow`）放在 `src/cli/index.ts`，复用现有 `cmdWatchMenu` 的按键模式；`cmdWatch()` 加 `filterTypes` 参数，`listLogs()` 按类型过滤。配置经 `EvolclawConfig.watch.logTypes` 原子读写。

**Tech Stack:** TypeScript (ES modules, `.js` import 后缀), Node fs, vitest。

---

## File Structure

- `src/config-store.ts` — `EvolclawConfig` 新增 `watch?: { logTypes?: string[] }`。
- `src/cli/watch-logs.ts`（新建）— 纯函数：`shortLogName`、`deriveLogTypes`、`computePreChecked`、`validateLogTypes`、`filterLogFiles`。
- `src/cli/index.ts` — `cmdWatch(filterTypes)` 改造、新增 `cmdWatchLogsSelect`/`cmdWatchLogsFlow`、`watch` case 路由、`cmdWatchMenu` log 项改向、help 文案。
- `tests/unit/watch-logs.test.ts`（新建）— 纯函数单测。
- `tests/unit/evolclaw-config.test.ts` — 追加 `watch.logTypes` round-trip 用例。

---

### Task 1: 配置字段 `watch.logTypes`

**Files:**
- Modify: `src/config-store.ts:59-70`
- Test: `tests/unit/evolclaw-config.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `tests/unit/evolclaw-config.test.ts` 的 `describe('evolclaw-config', ...)` 内追加：

```typescript
  it('round-trips watch.logTypes', () => {
    saveEvolclawConfig({ watch: { logTypes: ['evolclaw', 'aun'] } });
    const cfg = loadEvolclawConfig();
    expect(cfg.watch?.logTypes).toEqual(['evolclaw', 'aun']);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/unit/evolclaw-config.test.ts`
Expected: 类型检查报错或断言失败（`watch` 字段不存在）。

- [ ] **Step 3: 加字段**

`src/config-store.ts` 的 `EvolclawConfig` 接口内（`ecweb` 字段后）追加：

```typescript
  watch?: {
    logTypes?: string[];   // 上次勾选的日志类型（shortName，去轮转后缀）
  };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/unit/evolclaw-config.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config-store.ts tests/unit/evolclaw-config.test.ts
git commit -m "feat(watch): add EvolclawConfig.watch.logTypes field"
```

---

### Task 2: 纯逻辑模块 `watch-logs.ts`

**Files:**
- Create: `src/cli/watch-logs.ts`
- Test: `tests/unit/watch-logs.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/unit/watch-logs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  shortLogName, deriveLogTypes, computePreChecked, validateLogTypes, filterLogFiles,
} from '../../src/cli/watch-logs.js';

describe('shortLogName', () => {
  it('strips rotation suffix', () => {
    expect(shortLogName('evolclaw-20260518-21.log')).toBe('evolclaw');
  });
  it('keeps plain name', () => {
    expect(shortLogName('aun.log')).toBe('aun');
  });
});

describe('deriveLogTypes', () => {
  it('dedups and sorts types', () => {
    const files = ['evolclaw.log', 'evolclaw-20260610-03.log', 'aun.log', 'channel-in-20260610-04.log'];
    expect(deriveLogTypes(files)).toEqual(['aun', 'channel-in', 'evolclaw']);
  });
});

describe('computePreChecked', () => {
  const types = ['aun', 'channel-in', 'evolclaw'];
  it('checks all when saved is undefined', () => {
    expect([...computePreChecked(types, undefined)].sort()).toEqual(['aun', 'channel-in', 'evolclaw']);
  });
  it('checks only saved, new types unchecked', () => {
    expect([...computePreChecked(types, ['aun'])].sort()).toEqual(['aun']);
  });
});

describe('validateLogTypes', () => {
  const available = ['aun', 'evolclaw'];
  it('returns empty for all-valid', () => {
    expect(validateLogTypes(['aun'], available)).toEqual([]);
  });
  it('returns invalid ones', () => {
    expect(validateLogTypes(['aun', 'nope'], available)).toEqual(['nope']);
  });
});

describe('filterLogFiles', () => {
  it('keeps only files whose type is selected', () => {
    const files = ['/l/evolclaw-20260610-03.log', '/l/aun.log', '/l/stdout.log'];
    expect(filterLogFiles(files, new Set(['evolclaw', 'aun']))).toEqual(['/l/evolclaw-20260610-03.log', '/l/aun.log']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- tests/unit/watch-logs.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现模块**

Create `src/cli/watch-logs.ts`:

```typescript
import path from 'path';

/** 去掉轮转后缀（"evolclaw-20260518-21.log" → "evolclaw"）。入参可为文件名或绝对路径。 */
export function shortLogName(file: string): string {
  return path.basename(file, '.log').replace(/-\d{8}-\d{2}$/, '');
}

/** 从 .log 文件名列表推导去重、字母序的类型列表。 */
export function deriveLogTypes(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    if (!f.endsWith('.log')) continue;
    set.add(shortLogName(f));
  }
  return [...set].sort();
}

/** 计算预勾集合：saved 为 undefined → 全勾；否则只勾命中 saved 的类型（新类型不勾）。 */
export function computePreChecked(types: string[], saved: string[] | undefined): Set<string> {
  if (saved === undefined) return new Set(types);
  const savedSet = new Set(saved);
  return new Set(types.filter(t => savedSet.has(t)));
}

/** 返回 requested 中不在 available 里的无效类型。 */
export function validateLogTypes(requested: string[], available: string[]): string[] {
  const set = new Set(available);
  return requested.filter(t => !set.has(t));
}

/** 只保留类型命中 filterTypes 的文件路径。 */
export function filterLogFiles(files: string[], filterTypes: Set<string>): string[] {
  return files.filter(f => filterTypes.has(shortLogName(f)));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test -- tests/unit/watch-logs.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交**

```bash
git add src/cli/watch-logs.ts tests/unit/watch-logs.test.ts
git commit -m "feat(watch): add pure helpers for log type select/filter"
```

---

### Task 3: `cmdWatch` 支持 `filterTypes` 过滤

**Files:**
- Modify: `src/cli/index.ts:1535` (`function cmdWatch()` 签名), `src/cli/index.ts:1580` (`listLogs`)

- [ ] **Step 1: 改签名 + 引入过滤**

把 `function cmdWatch() {` 改为：

```typescript
function cmdWatch(filterTypes: Set<string>) {
```

在文件顶部 import 区追加（与其他 `./` 导入并列）：

```typescript
import { filterLogFiles } from './watch-logs.js';
```

将 `listLogs`（`src/cli/index.ts:1580`）：

```typescript
  const listLogs = () => fs.readdirSync(p.logs).filter(f => f.endsWith('.log')).map(f => path.join(p.logs, f));
```

改为：

```typescript
  const listLogs = () => {
    const all = fs.readdirSync(p.logs).filter(f => f.endsWith('.log')).map(f => path.join(p.logs, f));
    return filterLogFiles(all, filterTypes);
  };
```

- [ ] **Step 2: 改所有调用点（暂时编译用全集）**

此时 `cmdWatch()` 的 3 个调用点（`watch` case 内 `args[1]==='log'`、`!args[1]` 默认 else、`cmdWatchMenu` 的 log 分支）会因缺参报错。Task 4/5 会替换为正确调用；本步先临时改为 `cmdWatch(new Set())` 占位以便编译，标记 `// TODO: Task 4/5 替换`。定位：

Run: `grep -n "cmdWatch()" src/cli/index.ts`
对每个匹配（不含 `cmdWatchAid`/`cmdWatchMsg`/`cmdWatchMenu`/`cmdWatchWeb`/`cmdWatchLogs`）改为 `cmdWatch(new Set()) /* TODO: Task 4/5 替换 */`。

- [ ] **Step 3: 编译确认通过**

Run: `npm run build`
Expected: 编译通过，无类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/cli/index.ts
git commit -m "feat(watch): cmdWatch accepts filterTypes to scope tailed logs"
```

---

### Task 4: 勾选菜单 `cmdWatchLogsSelect`

**Files:**
- Modify: `src/cli/index.ts`（在 `cmdWatchMenu` 之后、`cmdWatch` 之前新增函数）

- [ ] **Step 1: 新增 import**

在顶部 import 区把 Task 3 加的那行扩展为：

```typescript
import { filterLogFiles, deriveLogTypes, computePreChecked } from './watch-logs.js';
```

- [ ] **Step 2: 实现交互菜单**

在 `cmdWatchMenu` 函数结束 `}` 之后插入：

```typescript
/**
 * 勾选要监控的日志类型。返回选中类型数组；ESC/Ctrl+C 取消返回 null。
 * types: 可用类型（字母序）。preChecked: 预勾集合。fileCount: 类型→当前文件数。
 */
async function cmdWatchLogsSelect(
  types: string[],
  preChecked: Set<string>,
  fileCount: Map<string, number>,
): Promise<string[] | null> {
  let index = 0;
  const checked = new Set(preChecked);
  const useColor = !!process.stdout.isTTY;
  const RST = useColor ? '\x1b[0m' : '';
  const DIM = useColor ? '\x1b[2m' : '';
  const BOLD = useColor ? '\x1b[1m' : '';
  const CYAN = useColor ? '\x1b[36m' : '';
  let hint = '';

  function render() {
    let buf = '\x1b[2J\x1b[H';
    buf += `${BOLD}选择要监控的日志类型${RST}\n\n`;
    for (let i = 0; i < types.length; i++) {
      const sel = i === index;
      const mark = checked.has(types[i]) ? '✔' : ' ';
      const cursor = sel ? `${CYAN}${BOLD}▸ ` : '  ';
      const n = fileCount.get(types[i]) ?? 0;
      const label = sel ? `${types[i]}${RST}` : `${DIM}${types[i]}${RST}`;
      buf += `${cursor}[${mark}] ${label}   ${DIM}(${n} file${n === 1 ? '' : 's'})${RST}\n`;
    }
    buf += `\n${DIM}  ↑↓ 移动  空格 勾选  Enter 确认  ESC 取消${RST}\n`;
    if (hint) buf += `${CYAN}  ${hint}${RST}\n`;
    process.stdout.write(buf);
  }

  render();

  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(null); return; }
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (data: Buffer) => {
      if ((data[0] === 0x1b && data.length === 1) || data[0] === 0x03) {
        finish(null); return;
      }
      if (data[0] === 0x1b && data[1] === 0x5b) {
        if (data[2] === 0x41) { index = Math.max(0, index - 1); hint = ''; render(); }
        if (data[2] === 0x42) { index = Math.min(types.length - 1, index + 1); hint = ''; render(); }
        return;
      }
      if (data[0] === 0x20) { // space
        const t = types[index];
        if (checked.has(t)) checked.delete(t); else checked.add(t);
        hint = ''; render(); return;
      }
      if (data[0] === 0x0d) { // enter
        if (checked.size === 0) { hint = '至少选择一项'; render(); return; }
        finish(types.filter(t => checked.has(t)));
      }
    };

    function finish(result: string[] | null) {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\x1b[2J\x1b[H');
      resolve(result);
    }

    process.stdin.on('data', onData);
  });
}
```

- [ ] **Step 3: 编译确认通过**

Run: `npm run build`
Expected: 编译通过（函数已被定义；尚未被调用，TS 不报未使用错误，因为它是模块级 function）。

- [ ] **Step 4: 提交**

```bash
git add src/cli/index.ts
git commit -m "feat(watch): add cmdWatchLogsSelect checkbox menu"
```

---

### Task 5: 编排 `cmdWatchLogsFlow` + 路由接线

**Files:**
- Modify: `src/cli/index.ts`（新增 `cmdWatchLogsFlow`、改 `watch` case、改 `cmdWatchMenu` log 分支、help 文案）

- [ ] **Step 1: 实现编排函数**

在 `cmdWatchLogsSelect` 之后插入：

```typescript
/** logs 勾选流程：扫描类型 → 预勾 → 菜单 → 保存 → 监控。 */
async function cmdWatchLogsFlow(): Promise<void> {
  const p = resolvePaths();
  if (!fs.existsSync(p.logs)) {
    console.log(`❌ Log directory not found: ${p.logs}`);
    process.exit(1);
  }
  const files = fs.readdirSync(p.logs).filter(f => f.endsWith('.log'));
  const types = deriveLogTypes(files);
  if (types.length === 0) {
    console.log(`⚠ ${p.logs} 下暂无 .log 文件`);
    return;
  }
  const fileCount = new Map<string, number>();
  for (const t of types) fileCount.set(t, files.filter(f => shortLogNameLocal(f) === t).length);

  const cfg = loadEvolclawConfig();
  const preChecked = computePreChecked(types, cfg.watch?.logTypes);

  if (!process.stdin.isTTY) {
    const fallback = cfg.watch?.logTypes && cfg.watch.logTypes.length > 0
      ? new Set(cfg.watch.logTypes) : new Set(types);
    cmdWatch(fallback);
    return;
  }

  const selected = await cmdWatchLogsSelect(types, preChecked, fileCount);
  if (selected === null) return; // 取消
  saveEvolclawConfig({ ...cfg, watch: { ...cfg.watch, logTypes: selected } });
  cmdWatch(new Set(selected));
}
```

在 import 区再补 `shortLogName`，并在 index.ts 内加一个本地别名（避免与 `cmdWatch` 内联 `shortName` 混淆）。把 Task 4 Step 1 的 import 行改为：

```typescript
import { filterLogFiles, deriveLogTypes, computePreChecked, shortLogName as shortLogNameLocal } from './watch-logs.js';
```

- [ ] **Step 2: 接线 `watch` case**

定位 `src/cli/index.ts` 的 `watch` case（约 `args[1] === 'log'` 分支处，原 `src/cli/index.ts:5077-5085`）。将该 if/else 链中关于 log 的部分替换为：

```typescript
      } else if (args[1] === 'log' || args[1] === 'logs') {
        const requested = args.slice(2);
        if (requested.length > 0) {
          const p2 = resolvePaths();
          const avail = fs.existsSync(p2.logs)
            ? deriveLogTypes(fs.readdirSync(p2.logs).filter(f => f.endsWith('.log')))
            : [];
          const invalid = validateLogTypes(requested, avail);
          if (invalid.length > 0) {
            console.log(`❌ 无效日志类型: ${invalid.join(', ')}`);
            console.log(`可用类型: ${avail.join(', ') || '(无)'}`);
            process.exit(1);
          }
          cmdWatch(new Set(requested));
        } else {
          await cmdWatchLogsFlow();
        }
      } else if (args[1] === 'web' || args[1] === 'session') {
        await cmdWatchWeb();
      } else if (!args[1]) {
        await cmdWatchMenu();
      } else {
        await cmdWatchLogsFlow();
      }
```

并把 import 行补上 `validateLogTypes`：

```typescript
import { filterLogFiles, deriveLogTypes, computePreChecked, validateLogTypes, shortLogName as shortLogNameLocal } from './watch-logs.js';
```

- [ ] **Step 3: 改 `cmdWatchMenu` log 分支**

在 `cmdWatchMenu` 内（原 `src/cli/index.ts:1512`）将：

```typescript
        if (chosen === 'log') { cmdWatch(); }
```

改为：

```typescript
        if (chosen === 'log') { await cmdWatchLogsFlow(); }
```

并把同函数 items 里 log 项描述（原 `{ key: 'log', label: 'log', desc: 'real-time log tail' }`）改为：

```typescript
    { key: 'log', label: 'log', desc: '勾选日志类型监控（记忆上次选择）' },
```

- [ ] **Step 4: 清掉 Task 3 占位 + 改 help 文案**

Run: `grep -n "TODO: Task 4/5 替换" src/cli/index.ts`
应只剩 `!args[1]` 外的占位（若 Step 2 已覆盖 log 分支占位则此处可能为 0）。把任何残留的 `cmdWatch(new Set()) /* TODO: Task 4/5 替换 */` 删除/替换为正确调用（log 相关走 `cmdWatchLogsFlow()`）。

定位 help 文案（原 `src/cli/index.ts:5193`）：

```
  watch log     监控 logs/ 下所有 .log 文件（汇总实时输出，启动时显示最近 20 条）
```

改为两行：

```
  watch logs    勾选日志类型后实时监控（记忆上次选择，存入 evolclaw.json）
  watch log <类型...>  直接监控指定类型（如 evolclaw aun），不读写偏好
```

- [ ] **Step 5: 编译确认通过**

Run: `npm run build`
Expected: 编译通过，无 `cmdWatch()` 缺参错误、无未用 import。

- [ ] **Step 6: 全量测试**

Run: `npm test -- tests/unit/watch-logs.test.ts tests/unit/evolclaw-config.test.ts`
Expected: PASS。

- [ ] **Step 7: 手动冒烟（TTY 交互）**

Run: `EVOLCLAW_HOME=/home/evolclaw node dist/cli/index.js watch logs`
预期：显示 checkbox 菜单（首次全勾），空格切换、Enter 后写入 `/home/evolclaw/evolclaw.json` 的 `watch.logTypes` 并进入监控；ESC 取消退出。再运行 `node dist/cli/index.js watch log aun` 直接只监控 aun，不改配置。

- [ ] **Step 8: 提交**

```bash
git add src/cli/index.ts
git commit -m "feat(watch): wire ec watch logs multi-select flow and routing"
```

---

## Self-Review

**Spec coverage:**
- 命令路由表（logs / log <type...> / 顶层菜单）→ Task 5 Step 2/3。✓
- 配置字段持久化 → Task 1 + Task 5 Step 1。✓
- 勾选菜单（来源/预勾/按键/渲染/raw-mode 交接）→ Task 4。✓
- 监控过滤 `cmdWatch(filterTypes)` → Task 3。✓
- 编排 `cmdWatchLogsFlow` 5 步 → Task 5 Step 1。✓
- 错误处理：无 .log（Task 5 Step 1）、无效类型（Task 5 Step 2）、空选 Enter（Task 4）、非 TTY 回退（Task 5 Step 1）。✓
- 测试策略：纯函数单测 → Task 2。✓
- 验收标准 1-7 全部由 Task 1-5 覆盖。✓

**Placeholder scan:** Task 3 Step 2 故意引入临时占位 `cmdWatch(new Set())`，由 Task 5 Step 4 显式清除——非计划遗留，已闭环。无其它 TODO/TBD。

**Type consistency:**
- `cmdWatch(filterTypes: Set<string>)` 在 Task 3 定义，Task 5 所有调用传 `Set<string>`。✓
- `cmdWatchLogsSelect(types, preChecked, fileCount): Promise<string[] | null>` Task 4 定义，Task 5 Step 1 按此签名调用。✓
- `cmdWatchLogsFlow(): Promise<void>` Task 5 定义，Task 5 Step 2/3 以 `await` 调用。✓
- 纯函数名 `shortLogName`/`deriveLogTypes`/`computePreChecked`/`validateLogTypes`/`filterLogFiles` 在 Task 2 定义，后续 import 一致（`shortLogName` 在 index.ts 别名为 `shortLogNameLocal`）。✓
