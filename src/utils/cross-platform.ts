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
 * Match Claude Code's actual path encoding:
 * 1. Replace all path separators (/ \ :) with '-'
 * 2. Replace all non-ASCII, non-alphanumeric chars (except '-') with '-'
 * e.g. /home/user/project -> -home-user-project
 *      C:\Users\project -> C--Users-project
 *      D:\tx\定制绘本生成 -> D--tx-------
 */
export function encodePath(projectPath: string): string {
  let encoded = projectPath.replace(/[/\\:]/g, '-');
  encoded = encoded.split('').map(c => (c === '-' || (c.charCodeAt(0) < 128 && /[a-zA-Z0-9]/.test(c))) ? c : '-').join('');
  return encoded;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

export function killProcess(pid: number, force = false): void {
  if (isWindows && force) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/F']); } catch {}
  } else {
    try { process.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
  }
}

export function findProcesses(pattern: string): number[] {
  try {
    if (isWindows) {
      const output = execFileSync('wmic', ['process', 'where', 'CommandLine like '%' + pattern + '%'', 'get', 'ProcessId'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return output.split('\n').map(line => parseInt(line.trim(), 10)).filter(pid => !isNaN(pid) && pid !== process.pid);
    } else {
      const output = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf-8' }).trim();
      return output ? output.split('\n').map(Number).filter(pid => pid !== process.pid) : [];
    }
  } catch { return []; }
}

export interface ProcessInfo {
  uptime?: string;
  cpu?: string;
  memory?: string;
}

export function getProcessInfo(pid: number): ProcessInfo {
  try {
    if (isWindows) {
      const output = execFileSync('wmic', ['process', 'where', 'ProcessId=' + pid, 'get', 'WorkingSetSize,CreationDate'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = output.trim().split('\n').filter(l => l.trim());
      if (lines.length >= 2) {
        const parts = lines[1].trim().split(/\s+/);
        const memKB = parts[1] ? Math.round(parseInt(parts[1], 10) / 1024) : undefined;
        return { memory: memKB ? '' + memKB : undefined };
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

export function commandExists(cmd: string): boolean {
  try {
    if (isWindows) { execFileSync('where', [cmd], { encoding: 'utf-8', stdio: 'pipe' }); }
    else { execFileSync('which', [cmd], { encoding: 'utf-8', stdio: 'pipe' }); }
    return true;
  } catch { return false; }
}

export function tailFile(filePath: string): { abort: () => void } {
  if (!isWindows) {
    const child = spawn('tail', ['-f', filePath], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    return { abort: () => child.kill() };
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').slice(-20);
  process.stdout.write(lines.join('\n'));
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

export function dirFromImportMeta(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function isMainScript(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const selfPath = fileURLToPath(importMetaUrl);
    const argvPath = fs.realpathSync(argv1);
    return selfPath === argvPath || fs.realpathSync(selfPath) === argvPath;
  } catch { return false; }
}

export function onShutdown(callback: () => void | Promise<void>): void {
  process.on('SIGINT', callback);
  process.on('SIGTERM', callback);
  if (isWindows) { process.on('SIGHUP', callback); }
}
