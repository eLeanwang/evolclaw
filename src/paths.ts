import fs from 'fs';
import path from 'path';
import os from 'os';

let _root: string | null = null;

export function resolveRoot(): string {
  if (_root) return _root;
  _root = process.env.EVOLCLAW_HOME || path.join(os.homedir(), '.evolclaw');
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
    config: path.join(root, 'data', 'config.json'),
    configSample: path.join(root, 'data', 'config.sample.json'),
    db: path.join(root, 'data', 'sessions.db'),
    pid: path.join(root, 'data', 'evolclaw.pid'),
    dataDir: path.join(root, 'data'),
    logs: path.join(root, 'logs'),
    lineStats: path.join(root, 'logs', 'line-stats.log'),
  };
}

export function ensureDataDirs(): void {
  const p = resolvePaths();
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.mkdirSync(p.logs, { recursive: true });
}

export function getPackageRoot(): string {
  return path.resolve(new URL('.', import.meta.url).pathname, '..');
}
