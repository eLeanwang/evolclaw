import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execFile, spawn, spawnSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

export const isWindows = process.platform === 'win32';

/**
 * Encode project path as directory name (Claude SDK convention).
 * Replace all path separators with '-'.
 * e.g. /home/user/project -> -home-user-project
 *      C:\Users\project -> C--Users-project
 */
export function encodePath(projectPath: string): string {
  const normalized = projectPath.replace(/[/\\]+$/, '');
  return normalized.replace(/[/\\:]/g, '-');
}

/**
 * Cross-platform process liveness check.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH = process not found; EPERM = exists but no permission
    return e.code === 'EPERM';
  }
}

/**
 * Cross-platform process termination.
 */
export function killProcess(pid: number, force = false): void {
  if (isWindows && force) {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    } catch {}
  } else {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {}
  }
}

/**
 * Cross-platform process search by command line pattern.
 * Returns list of matching PIDs.
 */
export function findProcesses(pattern: string): number[] {
  try {
    if (isWindows) {
      const result = spawnSync('wmic', ['process', 'where', `CommandLine like '%${pattern}%'`, 'get', 'ProcessId'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const output = result.stdout || '';
      return output.split('\n')
        .map(line => parseInt(line.trim(), 10))
        .filter(pid => !isNaN(pid) && pid !== process.pid);
    } else {
      const output = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf-8' }).trim();
      return output ? output.split('\n').map(Number).filter(pid => pid !== process.pid) : [];
    }
  } catch {
    return [];
  }
}

/**
 * Cross-platform process info retrieval.
 */
export interface ProcessInfo {
  uptime?: string;
  cpu?: string;
  memory?: string;
}

export function getProcessInfo(pid: number): ProcessInfo {
  try {
    if (isWindows) {
      const result = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'WorkingSetSize,CreationDate'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const output = result.stdout || '';
      const lines = output.trim().split('\n').filter(l => l.trim());
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        const memKB = parts[1] ? Math.round(parseInt(parts[1], 10) / 1024) : undefined;
        return { memory: memKB ? `${memKB}` : undefined };
      }
    } else {
      const etimes = execFileSync('ps', ['-p', String(pid), '-o', 'etimes='], { encoding: 'utf-8' }).trim();
      const cpu = execFileSync('ps', ['-p', String(pid), '-o', '%cpu='], { encoding: 'utf-8' }).trim();
      const mem = execFileSync('ps', ['-p', String(pid), '-o', 'rss='], { encoding: 'utf-8' }).trim();
      const uptime = formatUptime(parseInt(etimes, 10));
      return { uptime, cpu, memory: mem };
    }
  } catch {}
  return {};
}

function formatUptime(totalSeconds: number): string {
  if (isNaN(totalSeconds) || totalSeconds < 0) return 'unknown';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Cross-platform command existence check.
 */
const _commandExistsCache = new Map<string, boolean>();
export function commandExists(cmd: string): boolean {
  const cached = _commandExistsCache.get(cmd);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    if (isWindows) {
      const r = spawnSync('where', [cmd], { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
      exists = r.status === 0;
    } else {
      execFileSync('which', [cmd], { encoding: 'utf-8', stdio: 'pipe' });
      exists = true;
    }
  } catch {
    exists = false;
  }
  _commandExistsCache.set(cmd, exists);
  return exists;
}

/**
 * 解析命令的真实可执行文件绝对路径。
 * Windows: `where` 返回首个匹配（自动含 .cmd/.exe 后缀），解决 execFileSync 不补后缀的问题。
 * 失败返回 null。不缓存——刚安装的命令需要重新探测。
 */
export function resolveCommandPath(cmd: string): string | null {
  try {
    if (isWindows) {
      const r = spawnSync('where', [cmd], { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
      if (r.status !== 0 || !r.stdout) return null;
      const first = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      return first || null;
    } else {
      const out = execFileSync('which', [cmd], { encoding: 'utf-8', stdio: 'pipe' }).trim();
      return out || null;
    }
  } catch {
    return null;
  }
}

/**
 * Cross-platform live log tailing (replaces tail -f).
 * Returns an abort function.
 */
export function tailFile(filePath: string): { abort: () => void } {
  if (!isWindows) {
    // Unix: use tail -f (more efficient)
    const child = spawn('tail', ['-f', filePath], { stdio: 'inherit' });
    child.on('exit', (code: number | null) => process.exit(code || 0));
    return { abort: () => child.kill() };
  }

  // Windows: Node.js-based implementation using stat polling
  // (fs.watch / ReadDirectoryChangesW is unreliable for cross-process appends)
  // Output last 20 lines of existing content
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const lastLines = lines.slice(-20);
  process.stdout.write(lastLines.join('\n'));

  let position = fs.statSync(filePath).size;
  const listener = () => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < position) {
        // File was truncated (log rotation) — reset and re-read from start
        position = 0;
      }
      if (stat.size > position) {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(stat.size - position);
        fs.readSync(fd, buffer, 0, buffer.length, position);
        fs.closeSync(fd);
        process.stdout.write(buffer.toString('utf-8'));
        position = stat.size;
      }
    } catch {
      // File may be briefly unavailable during rotation — ignore and retry next tick
    }
  };
  fs.watchFile(filePath, { interval: 500, persistent: true }, listener);

  return { abort: () => fs.unwatchFile(filePath, listener) };
}

/**
 * Resolve file path from import.meta.url (cross-platform safe).
 * Replaces unsafe `new URL('.', import.meta.url).pathname` usage.
 */
export function dirFromImportMeta(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * Check if current file is the main entry script (cross-platform safe).
 * Replaces unsafe `import.meta.url === \`file://\${process.argv[1]}\`` check.
 */
export function isMainScript(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;

  try {
    const selfPath = fileURLToPath(importMetaUrl);
    const argvPath = fs.realpathSync(argv1);
    return selfPath === argvPath || fs.realpathSync(selfPath) === argvPath;
  } catch {
    return false;
  }
}

/**
 * Register graceful shutdown signal handlers (cross-platform safe).
 */
export function onShutdown(callback: () => void | Promise<void>): void {
  process.on('SIGINT', callback);
  // SIGTERM is not fully supported on Windows, but Node.js can still emit it
  // in some scenarios (e.g., process managers), so register it anyway
  process.on('SIGTERM', callback);

  if (isWindows) {
    // On Windows, also handle SIGHUP for graceful shutdown
    // when the process is terminated via Task Manager or similar
    process.on('SIGHUP', callback);
  }
}
