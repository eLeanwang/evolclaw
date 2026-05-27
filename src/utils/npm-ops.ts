/**
 * npm operations
 *
 * 集中管理本仓库所有 `npm install -g` / `npm view` 相关的子进程调用：
 *  - tryUpgrade()       — evolclaw 自我升级
 *  - requireOptional()  — 可选依赖动态加载 + 自动安装
 *  - npmInstallGlobal() — 全局安装（含 EACCES → sudo 回退、Windows npm.cmd）
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getPackageRoot } from '../paths.js';
import { isWindows } from './cross-platform.js';

const execFileAsync = promisify(execFile);

// ── npm install -g (shared) ────────────────────────────────────────────────

export async function npmInstallGlobal(pkg: string): Promise<void> {
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';
  const execOpts = { timeout: 180000, shell: isWindows };
  try {
    await execFileAsync(npmCmd, ['install', '-g', pkg], execOpts);
  } catch (e: any) {
    if (e.stderr?.includes('EACCES') || e.message?.includes('EACCES')) {
      if (isWindows) {
        throw new Error('权限不足。请以管理员身份运行 PowerShell 或 CMD，然后重试');
      }
      await execFileAsync('sudo', ['npm', 'install', '-g', pkg], { timeout: 180000 });
    } else {
      throw e;
    }
  }
}

/** Dynamic import with auto-install fallback for optional dependencies */
export async function requireOptional<T = any>(pkg: string, autoInstall = true): Promise<T> {
  try {
    return await import(pkg) as T;
  } catch (e: any) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'MODULE_NOT_FOUND') throw e;
    if (!autoInstall) throw new Error(`依赖 ${pkg} 未安装。请运行: npm install -g ${pkg}`);
    const { logger } = await import('./logger.js');
    logger.info(`正在安装可选依赖 ${pkg}...`);
    await npmInstallGlobal(pkg);
    return await import(pkg) as T;
  }
}

// ── evolclaw self-upgrade ──────────────────────────────────────────────────

export interface UpgradeResult {
  status: 'skipped' | 'upgraded' | 'no-update' | 'failed';
  from?: string;
  to?: string;
  error?: string;
}

/**
 * 比较两个 semver 版本号 (a.b.c 格式)
 * 返回 -1 (a < b), 0 (a == b), 1 (a > b)
 * 自动剥离 pre-release 标签 (e.g. 2.6.0-beta.1 → 2.6.0)
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * 检查当前安装是否为 npm link 开发模式。
 * 正式全局安装的路径结构为 .../node_modules/evolclaw，
 * 而 npm link 指向项目源码目录，其父目录不是 node_modules。
 */
export function isLinkedInstall(): boolean {
  const pkgRoot = getPackageRoot();
  return path.basename(path.dirname(pkgRoot)) !== 'node_modules';
}

/** 获取本地 package.json 中的版本号 */
export function getLocalVersion(): string {
  const pkgPath = path.join(getPackageRoot(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

/**
 * 查询 npm registry 上指定包的最新版本。
 * 使用 HTTP fetch 直接查 registry API，不依赖 npm CLI。
 * 超时 10 秒，失败返回 null。
 */
export async function checkLatestVersion(pkg = 'evolclaw'): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

/**
 * 完整升级流程：检查 → 比较 → 安装（失败重试一次）
 */
export async function tryUpgrade(): Promise<UpgradeResult> {
  // 开发模式跳过
  if (isLinkedInstall()) {
    return { status: 'skipped' };
  }

  const localVer = getLocalVersion();

  // 查询 registry
  const remoteVer = await checkLatestVersion();
  if (!remoteVer) {
    return { status: 'skipped', error: 'Failed to check remote version' };
  }

  // 版本比较
  if (compareVersions(localVer, remoteVer) >= 0) {
    return { status: 'no-update', from: localVer };
  }

  // 有新版本，执行升级（失败重试一次）
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await npmInstallGlobal('evolclaw@latest');
      return { status: 'upgraded', from: localVer, to: remoteVer };
    } catch (e: any) {
      lastError = e.stderr || e.message || String(e);
    }
  }
  return { status: 'failed', from: localVer, to: remoteVer, error: lastError };
}

/**
 * AUN SDK 升级流程：检查 → 比较 → 安装
 * 仅在 SDK 已安装时检查升级，未安装则跳过。
 */
export async function tryUpgradeAunSdk(
  resolveAunCoreSdkPkg: () => { version: string; path: string } | null,
  AUN_CORE_SDK_PKG: string,
): Promise<UpgradeResult> {
  if (isLinkedInstall()) {
    return { status: 'skipped' };
  }

  const installed = resolveAunCoreSdkPkg();
  if (!installed) {
    return { status: 'skipped' }; // SDK not installed, skip
  }

  const localVer = installed.version;
  const remoteVer = await checkLatestVersion(AUN_CORE_SDK_PKG);
  if (!remoteVer) {
    return { status: 'skipped', error: 'Failed to check remote version' };
  }

  if (compareVersions(localVer, remoteVer) >= 0) {
    return { status: 'no-update', from: localVer };
  }

  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await npmInstallGlobal(`${AUN_CORE_SDK_PKG}@latest`);
      return { status: 'upgraded', from: localVer, to: remoteVer };
    } catch (e: any) {
      lastError = e.stderr || e.message || String(e);
    }
  }
  return { status: 'failed', from: localVer, to: remoteVer, error: lastError };
}
