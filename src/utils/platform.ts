import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

export const isWindows = process.platform === 'win32';

/**
 * Encode project path as directory name (Claude SDK convention).
 * Replace all path separators with '-'.
 * e.g. /home/user/project -> -home-user-project
 *      C:\Users\project -> C-Users-project
 */
export function encodePath(projectPath: string): string {
  return projectPath.replace(/[/\\]/g, '-');
}

/**
 * Cross-platform process liveness check.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // Unix: ESRCH = not found, EPERM = exists but no permission
    // Windows: EPERM can also mean not found
    if (isWindows) {
      // On Windows, use tasklist to verify
      try {
        const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        return output.includes(String(pid));
      } catch {
        return false;
      }
    }
    return e.code === 'EPERM';
  }
}

/**
 * Cross-platform process termination.
 */
export function killProcess(pid: number, force = false): void {
  if (isWindows && force) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F']);
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
      const output = execFileSync('wmic', ['process', 'where', `CommandLine like '%${pattern}%'`, 'get', 'ProcessId'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
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
      // Use wmic on Windows
      const output = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'WorkingSetSize,CreationDate'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = output.trim().split('\n').filter(l => l.trim());
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        const memKB = parts[1] ? Math.round(parseInt(parts[1], 10) / 1024) : undefined;
        return { memory: memKB ? `${memKB}` : undefined };
      }
    } else {
      const uptime = execFileSync('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf-8' }).trim();
      const cpu = execFileSync('ps', ['-p', String(pid), '-o', '%cpu='], { encoding: 'utf-8' }).trim();
      const mem = execFileSync('ps', ['-p', String(pid), '-o', 'rss='], { encoding: 'utf-8' }).trim();
      return { uptime, cpu, memory: mem };
    }
  } catch {}
  return {};
}

/**
 * Cross-platform command existence check.
 */
export function commandExists(cmd: string): boolean {
  try {
    if (isWindows) {
      execFileSync('where', [cmd], { encoding: 'utf-8', stdio: 'pipe' });
    } else {
      execFileSync('which', [cmd], { encoding: 'utf-8', stdio: 'pipe' });
    }
    return true;
  } catch {
    return false;
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

  // Windows: Node.js-based implementation
  // Output last 20 lines of existing content
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const lastLines = lines.slice(-20);
  process.stdout.write(lastLines.join('\n'));

  let position = fs.statSync(filePath).size;
  const watcher = fs.watch(filePath, () => {
    const stat = fs.statSync(filePath);
    if (stat.size > position) {
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(stat.size - position);
      fs.readSync(fd, buffer, 0, buffer.length, position);
      fs.closeSync(fd);
      process.stdout.write(buffer.toString('utf-8'));
      position = stat.size;
    }
  });

  return { abort: () => watcher.close() };
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
