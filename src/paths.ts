import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

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

    // ── 新结构（evolclaw-directory-design.md）────────────────
    defaultsConfig: path.join(root, 'agents', 'defaults.json'),
    processConfig: path.join(root, 'config.json'), // legacy ProcessConfig path — only for migration source
    evolclawJson: path.join(root, 'evolclaw.json'),
    eckDir: path.join(root, 'eck'),
    instanceReadySignal: path.join(root, 'data', 'instance', 'ready.signal'),
    instanceSocket: resolveInstanceSocketPath(root),
    aidLogsDir: path.join(root, 'logs', 'aids'),

    // ── 配置快照体系（config-system-design-v2.md §八/§九）──────
    configBackupsDir: path.join(root, 'backups', 'config'),
    configCurrentPointer: path.join(root, 'backups', 'config', 'current.json'),
    configWVersion: path.join(root, 'backups', 'config', 'w-version.json'),
    configBootLog: path.join(root, 'backups', 'config', 'boot-log.jsonl'),
    configBootLogArchiveDir: path.join(root, 'backups', 'config', 'boot-log-archive'),
  };
}

// per-agent relation 路径
export function agentRelationConfig(aid: string, peerKey: string): string {
  return path.join(resolveRoot(), 'agents', aid, 'relations', peerKey, 'config.json');
}

// ── AID 路径（agent.md 存放在 $EVOLCLAW_HOME/AIDs/<aid>/）──

/**
 * AUN SDK 数据根路径（密钥/证书/AgentMDs 等）。
 * 与 evolclaw 数据共用 $EVOLCLAW_HOME 根，避免散落到 ~/.aun。
 * 启动时 SDK 通过 aun_path 选项指向这里；agent.md 子目录通过 setAgentMdPath(aidsDir()) 单独设置。
 */
export function aunPath(): string {
  return resolveRoot();
}

export function aidsDir(): string {
  return path.join(resolveRoot(), 'AIDs');
}

export function aidLocalDir(aid: string): string {
  return path.join(resolveRoot(), 'AIDs', aid);
}

export function agentMdPath(aid: string): string {
  return path.join(resolveRoot(), 'AIDs', aid, 'agent.md');
}

// ── per-agent 路径（参数化，不进 resolvePaths() 的固定 map）──

export function agentDir(aid: string): string {
  return path.join(resolveRoot(), 'agents', aid);
}
export function agentConfig(aid: string): string {
  return path.join(agentDir(aid), 'config.json');
}
export function agentBehaviorConfig(aid: string): string {
  return path.join(agentDir(aid), 'behavior.json');
}
export function agentRoleAssignmentsConfig(aid: string): string {
  return path.join(agentDir(aid), 'role-assignments.json');
}
export function agentPersonalDir(aid: string): string {
  return path.join(agentDir(aid), 'personal');
}
export function agentRelationsDir(aid: string): string {
  return path.join(agentDir(aid), 'relations');
}
export function agentRelationBehaviorConfig(aid: string, peerKey: string): string {
  return path.join(agentRelationsDir(aid), peerKey, 'behavior.json');
}
/** @deprecated Use agentRelationsDir instead */
export function agentIdentitiesDir(aid: string): string {
  return agentRelationsDir(aid);
}
export function agentIndexDir(aid: string): string {
  return path.join(agentDir(aid), 'index');
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
export function agentTriggersDir(aid: string): string {
  return path.join(resolveRoot(), 'data', 'triggers', aid);
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
  fs.mkdirSync(p.aidLogsDir, { recursive: true });
  fs.mkdirSync(p.agentsDir, { recursive: true });
  fs.mkdirSync(p.sessionsDir, { recursive: true });
  fs.mkdirSync(p.instanceDir, { recursive: true });
  fs.mkdirSync(p.outboxDir, { recursive: true });
  fs.mkdirSync(p.eckDir, { recursive: true });
  fs.mkdirSync(eckDebugDir(), { recursive: true });
  fs.mkdirSync(aidsDir(), { recursive: true });
  seedConfigTemplates();
  migrateFromAun();
}

const MIGRATION_MARKER = '.migrated-from-aun';

/**
 * 一次性迁移：把 ~/.aun 下的 SDK 数据搬到 $EVOLCLAW_HOME 下。
 * 通过标记文件判断是否已迁移，完成后写入标记，后续版本可删除此函数。
 */
function migrateFromAun(): void {
  const newRoot = resolveRoot();
  const markerPath = path.join(newRoot, MIGRATION_MARKER);
  if (fs.existsSync(markerPath)) return;

  const oldRoot = path.join(os.homedir(), '.aun');
  if (!fs.existsSync(oldRoot) || oldRoot === newRoot) {
    try { fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8'); } catch {}
    return;
  }

  const copyFileIfMissing = (src: string, dst: string) => {
    if (!fs.existsSync(src) || fs.existsSync(dst)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  };

  const copyDirIfMissing = (src: string, dst: string) => {
    if (!fs.existsSync(src)) return;
    if (!fs.statSync(src).isDirectory()) return;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        copyDirIfMissing(s, d);
      } else if (entry.isFile()) {
        copyFileIfMissing(s, d);
      }
    }
  };

  try {
    const oldAids = path.join(oldRoot, 'AIDs');
    const newAids = aidsDir();
    if (fs.existsSync(oldAids)) {
      for (const entry of fs.readdirSync(oldAids, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        copyDirIfMissing(path.join(oldAids, entry.name), path.join(newAids, entry.name));
      }
    }
    copyDirIfMissing(path.join(oldRoot, 'CA'), path.join(newRoot, 'CA'));
    for (const f of ['.seed', '.device_id']) {
      copyFileIfMissing(path.join(oldRoot, f), path.join(newRoot, f));
    }
  } catch { /* best-effort */ }

  try { fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8'); } catch {}
}

/**
 * 首次运行时从 assets/ 模板拷贝 .env 到 $EVOLCLAW_HOME。
 * 已存在则跳过，不覆盖用户修改。
 *
 * 注：config.json（旧 ProcessConfig）已废弃——不再 seed，否则会与
 * migrateProcessConfigIfNeeded 的归档形成每次启动重建+重迁移的循环。
 * 进程级配置统一走 evolclaw.json。
 */
function seedConfigTemplates(): void {
  const root = resolveRoot();
  const assetsDir = path.join(getPackageRoot(), 'assets');

  const templates: Array<{ src: string; dst: string }> = [
    { src: '.env.template', dst: '.env' },
  ];

  for (const { src, dst } of templates) {
    const dstPath = path.join(root, dst);
    if (fs.existsSync(dstPath)) continue;
    const srcPath = path.join(assetsDir, src);
    if (!fs.existsSync(srcPath)) continue;
    try {
      fs.copyFileSync(srcPath, dstPath);
    } catch { /* best-effort */ }
  }
}

// ── kits 路径（始终从包内读取，不复制到 EVOLCLAW_HOME）──

export function kitsDir(): string {
  return path.join(getPackageRoot(), 'kits');
}
export function kitsRulesDir(): string {
  return path.join(getPackageRoot(), 'kits', 'rules');
}
export function kitsDocsDir(): string {
  return path.join(getPackageRoot(), 'kits', 'docs');
}
export function kitsTemplatesDir(): string {
  return path.join(getPackageRoot(), 'kits', 'templates');
}
export function kitsSchemasDir(): string {
  return path.join(getPackageRoot(), 'kits', 'schemas');
}

// ── Role System ──

export function rolesConfig(): string {
  return path.join(resolveRoot(), 'roles.json');
}

// ── 调试输出 ──

export function eckDebugDir(): string {
  return path.join(resolveRoot(), 'data', 'eck-debug');
}

export function getPackageRoot(): string {
  // import.meta.dirname is available in Node.js 21.2+ and always returns
  // the correct OS-native path, regardless of Git Bash or MSYS2 environment.
  return path.resolve(import.meta.dirname, '..');
}
