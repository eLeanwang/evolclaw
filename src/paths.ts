import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const isWindows = process.platform === 'win32';

let _root: string | null = null;

export function resolveRoot(): string {
  if (_root) return _root;
  if (process.env.EVOLCLAW_HOME) {
    _root = process.env.EVOLCLAW_HOME;
  } else if (fs.existsSync(path.join(process.cwd(), 'agents', 'defaults.json'))) {
    _root = process.cwd();
  } else {
    _root = path.join(os.homedir(), '.evolclaw');
  }
  return _root;
}

/** 重置缓存（仅供测试使用） */
export function _resetRoot(): void {
  _root = null;
}

export function resolvePaths() {
  const root = resolveRoot();
  return {
    root,
    sessionsDir: path.join(root, 'data', 'sessions'),
    instanceDir: path.join(root, 'data', 'instance'),
    outboxDir: path.join(root, 'data', 'outbox'),
    dataDir: path.join(root, 'data'),
    logs: path.join(root, 'logs'),
    agentsDir: path.join(root, 'agents'),
    lineStats: path.join(root, 'logs', 'line-stats.log'),
    readySignal: path.join(root, 'data', 'instance', 'ready.signal'),
    selfHealLog: path.join(root, 'logs', 'self-heal.md'),
    socket: resolveInstanceSocketPath(root),

    // ── 新结构（evolclaw-home-directory.md）────────────────
    defaultsConfig: path.join(root, 'agents', 'defaults.json'),
    kitsDir: path.join(root, 'kits'),
    kitsAunDir: path.join(root, 'kits', 'aun'),
    kitsChannelsDir: path.join(root, 'kits', 'channels'),
    kitsEvolclawDir: path.join(root, 'kits', 'evolclaw'),
    kitsTemplatesDir: path.join(root, 'kits', 'templates'),
    instanceReadySignal: path.join(root, 'data', 'instance', 'ready.signal'),
    instanceSocket: resolveInstanceSocketPath(root),
  };
}

// ── per-agent 路径（参数化，不进 resolvePaths() 的固定 map）──

export function agentDir(aid: string): string {
  return path.join(resolveRoot(), 'agents', aid);
}
export function agentConfig(aid: string): string {
  return path.join(agentDir(aid), 'config.json');
}
export function agentPersonalDir(aid: string): string {
  return path.join(agentDir(aid), 'personal');
}
export function agentIdentitiesDir(aid: string): string {
  return path.join(agentDir(aid), 'identities');
}
export function agentVenuesDir(aid: string): string {
  return path.join(agentDir(aid), 'venues');
}
export function agentSessionsDir(aid: string): string {
  return path.join(agentDir(aid), 'sessions');
}
export function agentDataDir(aid: string): string {
  return path.join(agentDir(aid), 'data');
}
export function agentDataCacheDir(aid: string): string {
  return path.join(agentDataDir(aid), 'cache');
}

function resolveInstanceSocketPath(root: string): string {
  if (isWindows) {
    const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\evolclaw-${hash}`;
  }
  return path.join(root, 'data', 'instance', 'evolclaw.sock');
}

export function ensureDataDirs(): void {
  const p = resolvePaths();
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.mkdirSync(p.logs, { recursive: true });
  fs.mkdirSync(p.agentsDir, { recursive: true });
  fs.mkdirSync(p.sessionsDir, { recursive: true });
  fs.mkdirSync(p.instanceDir, { recursive: true });
  fs.mkdirSync(p.outboxDir, { recursive: true });
  fs.mkdirSync(p.kitsDir, { recursive: true });
}

/**
 * 首次启动或升级时，把包内 kits/ 复制到 EVOLCLAW_HOME/kits/。
 * 策略：如果目标 kits/ 为空或包版本更新，整体覆盖。
 */
export function syncKitsFromPackage(): void {
  const p = resolvePaths();
  const srcKits = path.join(getPackageRoot(), 'kits');
  if (!fs.existsSync(srcKits)) return;

  const destKits = p.kitsDir;
  // 包内自用场景：EVOLCLAW_HOME 等于包根（开发仓 / 用户家目录恰好是安装目录），
  // src === dest 会让 cpSync 抛 ERR_FS_CP_EINVAL。直接跳过同步。
  if (path.resolve(srcKits) === path.resolve(destKits)) return;

  // 用 .kits-version 文件跟踪已安装的版本
  const versionFile = path.join(destKits, '.kits-version');
  const pkgJsonPath = path.join(getPackageRoot(), 'package.json');
  let pkgVersion = '0.0.0';
  try {
    pkgVersion = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')).version || '0.0.0';
  } catch {}

  let installedVersion = '';
  try {
    installedVersion = fs.readFileSync(versionFile, 'utf-8').trim();
  } catch {}

  if (installedVersion === pkgVersion) return;

  // 递归复制（覆盖）
  fs.cpSync(srcKits, destKits, { recursive: true, force: true });
  fs.writeFileSync(versionFile, pkgVersion, 'utf-8');
}

export function getPackageRoot(): string {
  // import.meta.dirname is available in Node.js 21.2+ and always returns
  // the correct OS-native path, regardless of Git Bash or MSYS2 environment.
  return path.resolve(import.meta.dirname, '..');
}
