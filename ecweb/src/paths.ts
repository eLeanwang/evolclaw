/**
 * evolclaw 路径解析（独立版）。
 *
 * watch 进程只需要 EVOLCLAW_HOME 根目录，所有地址从它派生。
 * 逻辑与 evolclaw src/paths.ts 对齐，但不依赖 evolclaw 代码。
 *
 * 根目录解析优先级：
 *   1. --home 命令行参数（由 index.ts 写入 process.env.EVOLCLAW_HOME）
 *   2. EVOLCLAW_HOME 环境变量
 *   3. cwd/agents/defaults.json 存在 → cwd（开发模式）
 *   4. ~/.evolclaw
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
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

/** socket 路径派生：与 evolclaw resolveInstanceSocketPath 完全一致 */
function resolveInstanceSocketPath(root: string): string {
  if (isWindows) {
    const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\evolclaw-${hash}`;
  }
  return path.join(root, 'data', 'instance', 'evolclaw.sock');
}

export function resolvePaths() {
  const root = resolveRoot();
  return {
    root,
    sessionsDir: path.join(root, 'data', 'sessions'),
    instanceDir: path.join(root, 'data', 'instance'),
    dataDir: path.join(root, 'data'),
    logs: path.join(root, 'logs'),
    socket: resolveInstanceSocketPath(root),
  };
}

/** CC（Claude Code / Agent SDK）transcript 根目录 */
export function ccProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}
