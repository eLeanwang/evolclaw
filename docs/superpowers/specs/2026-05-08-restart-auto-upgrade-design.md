# Restart Auto-Upgrade Design

## Overview

在 `evolclaw restart` 执行时自动检查 npm registry 是否有新版本，如有则自动升级后再启动。覆盖两条 restart 路径：CLI (`evolclaw restart`) 和消息通道 (`/restart` → `restart-monitor`)。

## 核心流程

```
restart 触发
  ↓
检测是否 npm link 开发模式
  ↓ 是 → 跳过升级，正常 restart
  ↓ 否
查询 registry 最新版本 (npm view evolclaw version)
  ↓
与本地版本比较
  ↓ 无新版本 → 正常 restart
  ↓ 有新版本
执行 npm install -g evolclaw@latest
  ↓ 成功 → 日志/通知 "已升级 x.y.z → a.b.c"，继续 restart
  ↓ 失败 → 重试一次
          ↓ 成功 → 同上
          ↓ 仍失败 → 日志/通知 "升级失败，使用当前版本继续"，正常 restart
```

## 模块设计

### 新文件 `src/utils/upgrade.ts`

导出三个函数：

#### `isLinkedInstall(): boolean`

检查 `getPackageRoot()` 路径是否包含 `node_modules/`。不包含说明是 symlink 开发模式（`npm link` 创建的 symlink 指向项目源码目录而非 `node_modules` 内），应跳过升级。

#### `checkLatestVersion(): Promise<string | null>`

执行 `npm view evolclaw version`，返回 registry 最新版本号。超时 15 秒，失败返回 `null`。

#### `tryUpgrade(): Promise<UpgradeResult>`

完整升级流程：

1. 调用 `isLinkedInstall()` → 是则返回 `{ status: 'skipped' }`
2. 调用 `checkLatestVersion()` → 查询失败返回 `{ status: 'skipped' }`
3. 与本地 `package.json` 版本比较（`localVer < remoteVer` 时才升级）
4. 执行 `npm install -g evolclaw@latest`，失败重试一次
5. 返回结果

```typescript
interface UpgradeResult {
  status: 'skipped' | 'upgraded' | 'no-update' | 'failed';
  from?: string;
  to?: string;
  error?: string;
}
```

### 版本比较

不引入 semver 依赖。实现简单的 `compareVersions(a, b)` 函数：将 `a.b.c` 拆分为数字数组逐位比较，返回 `-1 | 0 | 1`。

## 集成点

### `cmdRestart()` (CLI 路径)

在 `stopAndWait()` 之前调用 `tryUpgrade()`，打印结果到 console，然后继续正常 restart 流程。

```
console.log('🔄 Restarting EvolClaw...');
const upgradeResult = await tryUpgrade();
// 打印升级结果
await stopAndWait(p.pid);
setTimeout(() => cmdStart(), 1000);
```

### `restart-monitor` (消息通道路径)

在停止旧进程后、`spawnAndWaitReady()` 之前调用 `tryUpgrade()`。结果写入 `restart.log`，并通过 `notifyChannel()` 通知用户。

## 边界情况

| 场景 | 行为 |
|------|------|
| npm link 开发模式 | 跳过，日志 "开发模式，跳过版本检查" |
| 网络不可达 | `checkLatestVersion` 返回 null → 跳过 |
| registry 版本 <= 本地版本 | `no-update`，正常 restart |
| npm install 权限不足 | 重试一次仍失败 → 跳过，日志警告 |
| 升级后新版本有 bug | 不在此功能范围；已有 self-heal 兜底 |

## 不做的事

- 不引入 semver 依赖 — 简单数字比较即可
- 不做 changelog 展示 — 只提示版本号变更
- 不做回滚机制 — self-heal 已覆盖启动失败场景
