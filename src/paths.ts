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

export function getPackageRoot(): string {
  // import.meta.dirname is available in Node.js 21.2+ and always returns
  // the correct OS-native path, regardless of Git Bash or MSYS2 environment.
  return path.resolve(import.meta.dirname, '..');
}
