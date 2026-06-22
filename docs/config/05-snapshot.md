# 配置快照与回滚机制

> EvolClaw 配置体系 v3
> 上一篇：[04-config-manager.md](./04-config-manager.md) | 下一篇：[06-cli-commands.md](./06-cli-commands.md)

---

## 一、双指针模型

配置快照体系使用**两个独立指针**追踪版本状态：

| 文件 | 语义 | 谁更新 | 格式 |
|------|------|--------|------|
| **`current.json`** | 回落起点指针：每次启动从哪个版本开始往老遍历回落 | 仅手动切换(restore) 或 产生新版本时 | `{"full":"v200","delta":"v205"}` |
| **`w-version.json`** | W当前展开的版本：工作目录(W)当前是哪个版本的内容 | 每次"展开版本到W"时写 | `{"full":"v200","delta":"v205"}` |

### 两者关系

**正常态**：`w-version == current`，且 W 内容 == 该版本内容

**异常态**：
- **改了参数没存**：`w-version` 指 vX，但 W 内容 ≠ vX（手工编辑未快照）
- **回落后**：`w-version` 指被回落到的 vR（W 已被覆盖），current 仍指回落前的版本

### 为什么需要两个指针？

**current** 是"最后一次确认的好版本"，作为回落的起点：
- 手动 restore 时移动
- 产生新版本时移动（因为产生新版本意味着"当前状态是新的好版本"）

**w-version** 是"工作目录实际内容对应的版本"：
- 展开版本到 W 时更新
- 用于检测 W 是否被手工修改（W ≠ w-version）

### current.json 的更新规则

| 场景 | 更新 current? | 新值 | 说明 |
|------|--------------|------|------|
| **P1** 手动 `ec config snapshot` | ✅ | → 新版本 | 新版本成为新的回落起点 |
| **P2** 正常启动成功 + W≠w-version | ✅ | → 新存档版本 | 捕获人工改动，成为新起点 |
| **P3** 正常启动成功 + W==w-version | ❌ | 不动 | 无改动，起点不变，只增加 successCount |
| **P4** 进入自检模式前 W≠w-version | ✅ | → 存档版本 | 保存改动后再回落 |
| **P5** schema-migration 迁移前 | ✅ | → 新全量版本 | 迁移前快照成为新起点 |
| **自检回落成功** | ❌ | 不动 | 回落是临时措施，不改起点 |
| **手动 restore** | ✅ | → 目标版本 | 明确切换到目标版本 |

### w-version.json 的更新规则

| 场景 | 更新 w-version? | 新值 |
|------|----------------|------|
| 展开任意版本到 W | ✅ | → 该版本 |
| 产生新版本 | ✅ | → 新版本 |
| 手动 restore | ✅ | → 目标版本 |
| 自检回落成功 | ✅ | → 回落到的版本 |
| 正常启动无改动 | ❌ | 不动 |

---

## 二、快照范围

快照覆盖**整个配置目录树**的所有配置 JSON：

### 包含文件

```
{evolclaw_home}/
├── evolclaw.json                     ✅ 包含
├── .env                              ❌ 不包含（凭证不进快照）
└── agents/
    ├── defaults.json                 ✅ 包含
    └── {aid}/
        ├── config.json               ✅ 包含
        ├── .env                      ❌ 不包含
        └── relations/{peerKey}/
            ├── config.json           ✅ 包含
            └── .env                  ❌ 不包含
```

### 额外备份（extra_backup）

每个层级可通过 `extra_backup` 声明需要备份的文件：

```jsonc
// agent/config.json
{
  "extra_backup": [
    { "path": "roles", "pattern": "*.md" },
    { "path": "roles", "pattern": "*.json" }
  ]
}
```

**规则**：
- `path`：相对于该配置文件所在目录
- `pattern`：文件名匹配（glob）
- **不得指向 .env**（构建期 schema 校验拒绝）

**用途**：
- 角色配置文件
- 自定义 prompt 文件
- Agent 相关的非凭证配置

---

## 三、版本号方案

### 版本号规则

- **全量版本**：v100 起按百位递增（v100、v200、v300...），每个全量独立一个目录
- **增量版本**：在对应全量目录下，按个位递增（v101…v199），每个全量最多 99 个增量

### 目录结构

```
{evolclaw_home}/backups/config/
├── current.json          ← {"full":"v100","delta":"v103"}
├── w-version.json        ← {"full":"v100","delta":"v103"}
├── boot-log.jsonl        ← 启动日志
├── v100/                 ← 全量版本目录
│   ├── meta.json         ← 版本元数据
│   ├── snapshot/         ← 完整配置树（文件结构与 W 一致）
│   │   ├── evolclaw.json
│   │   └── agents/
│   │       ├── defaults.json
│   │       └── bot1.aid.pub/
│   │           ├── config.json
│   │           └── relations/
│   │               └── aun#alice.aid.pub/
│   │                   └── config.json
│   ├── v101/             ← 增量，基于 v100
│   │   ├── meta.json
│   │   └── delta/
│   │       ├── changes.jsonl    ← 变更记录
│   │       └── files/           ← 变更的文件
│   │           └── agents/
│   │               └── bot1.aid.pub/
│   │                   └── config.json
│   ├── v102/
│   └── v103/
└── v200/                 ← 新全量
    ├── meta.json
    ├── snapshot/
    └── v201/
```

### 版本号解析

```typescript
interface VersionRef {
  full: string;    // "v100"
  delta: string;   // "v103" 或 "v100"（无增量时与 full 相同）
}
```

---

## 四、版本产生时机

| # | 触发场景 | 类型判定 | 移动 current? | 移动 w-version? | 更新 successCount? |
|---|---------|---------|--------------|----------------|--------------------|
| **P1** | `ec config snapshot`(手动) | 自动判定 | ✅ → 新版本 | ✅ → 新版本 | ✅ 新版本=0 |
| **P2** | 正常启动成功 + W≠w-version(有未存改动) | 自动判定 | ✅ → 新版本 | ✅ → 新版本 | ✅ 新版本=0 |
| **P3** | 正常启动成功 + W==w-version(无改动) | 不建版本 | ❌ 不动 | ❌ 不动 | ✅ w-version 指向版本 +1 |
| **P4** | 进入自检模式时 W≠w-version | 自动判定 | ✅ → 存档版本 | ✅ → 存档版本 | ✅ 新版本=0 |
| **P5** | schema-migration 迁移前 | 无条件全量 | ✅ → 新版本 | ✅ → 新版本 | ✅ 新版本=0 |

### P2 的具体逻辑

```
daemon 启动
  ↓
读取 w-version.json → vW
  ↓
计算 W 的 tree hash → hashW
计算 vW 的 tree hash → hashVW
  ↓
hashW ≠ hashVW ?
  ├─ 是 → P2: 创建新版本（自动判定增量/全量）
  │      current.json → 新版本
  │      w-version.json → 新版本
  │      新版本.meta.json: {trigger:"startup", successCount:0}
  │
  └─ 否 → P3: 不建版本
         vW.meta.json: successCount += 1
```

### P4 的具体逻辑

```
ec start --diagnose
  ↓
env: EVOLCLAW_DIAGNOSE=1
  ↓
读取 w-version.json → vW
计算 W 的 tree hash
  ↓
hashW ≠ hashVW ?
  ├─ 是 → P4: 存档改动
  │      创建新版本（保留你的改动）
  │      current.json → 新版本
  │      w-version.json → 新版本
  │
  └─ 否 → 直接进入回落流程
```

---

## 五、增量 vs 全量

决定"建版本"后，再决定它是增量还是新全量。

### 默认策略：增量

在当前全量目录下建**增量**（delta）。

### 强制全量条件（满足任一）

1. **差异文件数 > 当前全量快照文件总数的一半**
   ```
   changedFiles.length > fullSnapshot.totalFiles / 2
   ```

2. **当前全量下增量数达到 99**
   ```
   currentFull.deltaCount >= 99
   ```

3. **手动指定** `ec config snapshot --full`

4. **schema-migration 迁移前**（P5 无条件全量）

### 判定流程

```typescript
function determineSnapshotType(changedFiles: string[]): 'full' | 'delta' {
  const currentFull = getCurrentFull();
  const totalFiles = countFilesInSnapshot(currentFull);
  
  // 条件 1：差异过大
  if (changedFiles.length > totalFiles / 2) {
    return 'full';
  }
  
  // 条件 2：增量数达到上限
  if (currentFull.deltaCount >= 99) {
    return 'full';
  }
  
  // 默认增量
  return 'delta';
}
```

---

## 六、版本元数据（meta.json）

### 全量版本 meta.json

```json
{
  "version": "v200",
  "type": "full",
  "createdAt": "2026-06-19T10:30:00Z",
  "trigger": "manual",
  "description": "手动全量快照",
  "totalFiles": 25,
  "successCount": 5,
  "deltaCount": 3
}
```

**字段说明**：
- `version`: 版本号
- `type`: `full` 或 `delta`
- `createdAt`: 创建时间（ISO 8601）
- `trigger`: 触发原因（`manual` / `startup` / `schema-migration` / `diagnose`）
- `description`: 描述（手动快照时提供）
- `totalFiles`: 快照文件总数（仅全量）
- `successCount`: 该版本成功启动的次数（用于回落资格判定）
- `deltaCount`: 该全量下增量版本数量（仅全量）

### 增量版本 meta.json

```json
{
  "version": "v203",
  "type": "delta",
  "baseVersion": "v200",
  "createdAt": "2026-06-19T11:15:00Z",
  "trigger": "startup",
  "description": "捕获 alice 的 chatmode 改动",
  "changedFiles": [
    "agents/bot1.aid.pub/relations/aun#alice.aid.pub/config.json"
  ],
  "deletedFiles": [],
  "successCount": 0
}
```

**额外字段**：
- `baseVersion`: 基于哪个全量版本
- `changedFiles`: 变更的文件列表
- `deletedFiles`: 删除的文件列表

---

## 七、successCount 机制

### 作用

**successCount** 记录某版本成功启动的次数，用于：
1. **回落资格判定** - 只回落到 successCount > 0 的版本
2. **版本可信度评估** - successCount 越高越可靠

### 更新规则

| 场景 | 更新 successCount | 哪个版本 |
|------|------------------|---------|
| 正常启动成功 + W==w-version | ✅ +1 | w-version 指向的版本 |
| 正常启动成功 + W≠w-version | ✅ 新版本=0 | 新创建的版本 |
| 产生新版本 | ✅ 新版本=0 | 新创建的版本 |
| 自检回落成功 | ❌ 不更新 | — |

### 示例

```
v100.meta.json: {successCount: 10}  ← 启动成功 10 次
v101.meta.json: {successCount: 0}   ← 刚创建，未启动成功过
v102.meta.json: {successCount: 5}   ← 启动成功 5 次
```

**回落候选**：v100（10次）、v102（5次）  
**不回落**：v101（0次，除非是序列中最新两个）

---

## 八、恢复链（版本展开算法）

恢复任意版本只需两步：

### 算法

```typescript
function restoreVersion(targetVersion: VersionRef): void {
  // 1. 清空 W
  cleanWorkingDirectory();
  
  // 2. 展开全量基础
  const fullSnapshot = loadSnapshot(targetVersion.full);
  copyTo(fullSnapshot, W);
  
  // 3. 如果目标是增量，应用 delta
  if (targetVersion.delta !== targetVersion.full) {
    const deltaVersions = getDeltaChain(targetVersion.full, targetVersion.delta);
    for (const deltaVer of deltaVersions) {
      applyDelta(deltaVer, W);
    }
  }
  
  // 4. 更新 w-version
  writeWVersion(targetVersion);
}
```

### 增量应用（applyDelta）

```typescript
function applyDelta(deltaVersion: string, targetDir: string): void {
  const delta = loadDelta(deltaVersion);
  
  // 读取 changes.jsonl
  for (const change of delta.changes) {
    if (change.op === 'write') {
      copyFile(delta.files[change.path], targetDir + change.path);
    } else if (change.op === 'delete') {
      deleteFile(targetDir + change.path);
    }
  }
}
```

### changes.jsonl 格式

```jsonl
{"op":"write","path":"agents/bot1.aid.pub/config.json","hash":"abc123"}
{"op":"write","path":"agents/bot1.aid.pub/relations/aun#alice.aid.pub/config.json","hash":"def456"}
{"op":"delete","path":"agents/old.aid.pub/config.json"}
```

---

## 九、保留策略

### 保留规则

- **全量**：保留最近 **10** 个
- **增量**：保留最近 **20** 个（跨全量统计）
- **延迟清理**：每次成功启动后触发
- **拒删规则**：
  1. 被保留区间内增量依赖的全量（即使全量本身不在保留区）
  2. `current.json` 指向的版本
  3. `w-version.json` 指向的版本

### 清理算法

```typescript
function pruneSnapshots(): void {
  const allVersions = listAllVersions();
  
  // 1. 收集增量依赖的全量
  const referencedFulls = new Set<string>();
  const recentDeltas = allVersions.deltas.slice(-20);
  for (const delta of recentDeltas) {
    referencedFulls.add(delta.baseVersion);
  }
  
  // 2. 收集 current/w-version 指向的版本
  const current = readCurrent();
  const wVersion = readWVersion();
  referencedFulls.add(current.full);
  referencedFulls.add(wVersion.full);
  
  // 3. 删除不需要的全量
  const recentFulls = allVersions.fulls.slice(-10);
  for (const full of allVersions.fulls) {
    if (!recentFulls.includes(full) && !referencedFulls.has(full.version)) {
      deleteFullSnapshot(full);
    }
  }
  
  // 4. 删除不需要的增量
  for (const delta of allVersions.deltas) {
    if (!recentDeltas.includes(delta)) {
      deleteDeltaSnapshot(delta);
    }
  }
}
```

### 清理时机

- **每次成功启动后**：正常启动成功 → 触发 `pruneSnapshots()`
- **手动触发**：`ec config prune`（dry-run，需 `--yes`）

---

## 十、启动日志（boot-log.jsonl）

### 日志格式

每次成功启动追加一行：

```jsonl
{"bootedAt":"2026-06-19T10:30:00Z","startMethod":"auto","selectedVersion":{"full":"v200","delta":"v205"},"actualVersion":{"full":"v200","delta":"v203"},"fellBack":true,"bootDuration":2500}
```

**字段说明**：
- `bootedAt`: 启动时间
- `startMethod`: 启动方式（`auto` / `diagnose` / `manual`）
- `selectedVersion`: 预期启动的版本（从 current 读取）
- `actualVersion`: 实际启动的版本（自检回落后可能不同）
- `fellBack`: 是否发生了回落
- `bootDuration`: 启动耗时（毫秒）

### 归档规则

- **触发条件**：超过 300 条记录
- **归档方式**：按月归档到 `boot-log-archive/{YYYY-MM}.jsonl`
- **保留原文件**：归档后保留最近 100 条

### 查询命令

```bash
# 查看最近 10 次启动
ec config boots -n 10

# 查看所有回落记录
ec config boots --fell-back

# 查看某月归档
ec config boots --archive 2026-06
```

---

## 十一、自检模式（启动失败逐版本回落）

### 触发方式

**CLI 参数**：
```bash
ec start --diagnose
ec restart --diagnose
```

**环境变量**：
```bash
EVOLCLAW_DIAGNOSE=1 ec start
```

### 核心原则

**自检回落不修改 `current.json`**：
- current 是"最后确认的好版本"
- 回落是临时探测，不改变起点
- 只更新 `w-version`（W 的实际内容）

### 自检流程（完整版）

```
1. daemon 启动（env: EVOLCLAW_DIAGNOSE=1）
    ↓
2. 读取 current.json → vC
   读取 w-version.json → vW
    ↓
3. P4 检查：W ≠ vW ?
    ├─ 是 → 先存档（保留你的改动）
    │      创建新版本 vN（trigger=diagnose）
    │      current.json → vN
    │      w-version.json → vN
    │
    └─ 否 → 跳过
    ↓
4. 构建回落候选序列
   从 current 往老遍历所有版本
   过滤：保留 successCount > 0 或 序列中最新两个
   排序：从新到老
    ↓
5. 逐版本回落尝试
   for (candidate in candidates) {
     a) 展开 candidate 到 W
     b) writeWVersion(candidate)
     c) 真实探测：loadAllAgents()
        ├─ 成功 → 跳转到 step 6
        └─ 失败 → 记录错误，继续下一个
   }
    ↓
6. 回落成功
   当前状态：
   - W = 回落版本 vR
   - w-version = vR
   - current 不变（仍指 vC）
    ↓
7. 打印参数级 diff
   计算：vC 与 vR 的参数差异
   输出：哪些参数被回退了
    ↓
8. daemon 继续启动
    ↓
9. 所有候选都失败
   还原最新版本 W
   报错退出：无可用版本
```

### 回落资格判定

```typescript
function isEligibleForFallback(version: Version, position: number, total: number): boolean {
  // 条件 1：成功启动过
  if (version.successCount > 0) {
    return true;
  }
  
  // 条件 2：序列中最新两个（即使 successCount=0）
  if (position < 2) {
    return true;
  }
  
  return false;
}
```

**原因**：
- **successCount > 0**：该版本启动过，是可信的
- **最新两个**：即使没启动过，也可能是刚创建的好版本（给它一次机会）

### 回落熔断上限

满足任一条件即终止：

1. **回落尝试次数 > 20 次**
   ```typescript
   if (attemptCount > 20) {
     throw new Error('回落次数超过上限');
   }
   ```

2. **累计回落耗时 > 2 分钟**
   ```typescript
   if (Date.now() - startTime > 120_000) {
     throw new Error('回落耗时超过上限');
   }
   ```

### 参数级 diff 输出

回落成功后，打印 current 与实际启动版本的参数差异：

```
🔄 自检回落成功：v205 → v203

参数变更：
  agents/bot1.aid.pub/config.json:
    - chatmode.private: proactive → interactive
    - baseagents.claude.model: opus → sonnet
    + flush_delay: 3 (v203 新增)
    
  agents/bot1.aid.pub/relations/aun#alice.aid.pub/config.json:
    - baseagents.claude.effort: max → high

2 个文件，4 处参数变更
```

### 自检后的手动修复

```bash
# 1. 查看 diff
ec config diff v205 v203

# 2. 确认问题参数
ec config get chatmode.private --self bot1.aid.pub

# 3. 修复
ec config set chatmode.private interactive --self bot1.aid.pub

# 4. 创建新快照
ec config snapshot --desc "修复 chatmode 配置"

# 5. 重新启动（不带 --diagnose）
ec restart
```

---

## 十二、常用命令

### 快照管理

```bash
# 手动创建快照
ec config snapshot
ec config snapshot --full --desc "重大调整前备份"

# 查看快照历史
ec config history
ec config history --full-only     # 只显示全量
ec config history --after 2026-06-01  # 指定时间后

# 对比两版本
ec config diff v100 v103
ec config diff v100 v103 --files-only  # 只显示变更的文件

# 恢复到指定版本
ec config restore v100
ec config restore v100 --yes  # 跳过确认

# 查看当前版本
ec config current

# 查看启动日志
ec config boots -n 10
ec config boots --fell-back  # 只看回落记录

# 清理快照（dry-run）
ec config prune
ec config prune --yes  # 真正执行
```

### 版本信息

```bash
# 查看版本元数据
ec config version v103

# 查看版本文件列表
ec config version v103 --files

# 验证版本完整性
ec config verify v103
```

### 自检启动

```bash
# 自检模式启动
ec start --diagnose

# 查看自检日志
ec config boots --diagnose-only
```

---

## 相关文档

- [01-overview.md](./01-overview.md) - 总体架构
- [06-cli-commands.md](./06-cli-commands.md) - CLI 命令完整清单
- [04-config-manager.md](./04-config-manager.md) - ConfigManager API
