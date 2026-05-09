import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { getPackageRoot } from '../paths.js';

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
 * 查询 npm registry 上 evolclaw 的最新版本。
 * 超时 15 秒，失败返回 null。
 */
export function checkLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', ['view', 'evolclaw', 'version'], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const ver = stdout.trim();
      resolve(ver || null);
    });
  });
}

/**
 * 执行 npm install -g evolclaw@latest
 */
function runInstall(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile('npm', ['install', '-g', 'evolclaw@latest'], { timeout: 120000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: stderr || err.message });
      } else {
        resolve({ ok: true });
      }
    });
  });
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runInstall();
    if (result.ok) {
      return { status: 'upgraded', from: localVer, to: remoteVer };
    }
    if (attempt === 1) {
      return { status: 'failed', from: localVer, to: remoteVer, error: result.error };
    }
  }

  // unreachable
  return { status: 'failed', from: localVer, to: remoteVer };
}
