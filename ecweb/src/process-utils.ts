/**
 * 进程工具（独立版）— 内联自 evolclaw cross-platform + process-introspect + instance-registry。
 *
 * 只包含 ecweb 单实例保护实际用到的函数，无任何 evolclaw 代码依赖。
 * 关键不变量：杀进程前用启动时间比对防 PID 复用，按端口兜底时只杀确认是 ecweb 的进程。
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { resolvePaths } from './paths.js';

const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';

/** 启动时间容差：2 秒（覆盖 macOS 秒级精度 + 时钟漂移） */
const START_TIME_TOLERANCE_MS = 2000;

export interface EcwebRecord {
  pid: number;
  startedAt: number;
  startedAtIso: string;
  port: number;
}

// ── 进程存活 / 终止 ──

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

function killPid(pid: number): void {
  if (isWindows) {
    try { spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }); } catch {}
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

// ── 启动时间（PID 复用检测）──

export function getProcessStartTime(pid: number): number | null {
  try {
    if (isWindows) return getStartTimeWindows(pid);
    if (isMacOS) return getStartTimeMacOS(pid);
    return getStartTimeLinux(pid);
  } catch {
    return null;
  }
}

function startTimeMatches(recorded: number, actual: number | null): boolean {
  if (actual === null) return false;
  return Math.abs(recorded - actual) < START_TIME_TOLERANCE_MS;
}

function getStartTimeLinux(pid: number): number | null {
  let stat: string;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8'); } catch { return null; }
  const tail = stat.slice(stat.lastIndexOf(')') + 2);
  const starttimeJiffies = parseInt(tail.split(' ')[19], 10);
  if (isNaN(starttimeJiffies)) return null;
  let uptimeSec: number;
  try { uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0]); } catch { return null; }
  const clkTck = 100; // 几乎所有 Linux 为 100
  const bootMs = Date.now() - uptimeSec * 1000;
  return Math.round(bootMs + (starttimeJiffies / clkTck) * 1000);
}

function getStartTimeMacOS(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', timeout: 3000 });
  const out = (r.stdout || '').trim();
  if (!out) return null;
  const ms = Date.parse(out);
  return isNaN(ms) ? null : ms;
}

function getStartTimeWindows(pid: number): number | null {
  const r = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
    { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const m = (r.stdout || '').match(/CreationDate=(\d{14})/);
  if (!m) return null;
  const s = m[1]; // yyyymmddHHMMSS
  const ms = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`);
  return isNaN(ms) ? null : ms;
}

// ── 端口 → PID ──

export function findPidByPort(port: number): number[] {
  const pids = new Set<number>();
  try {
    if (isWindows) {
      const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      for (const line of (result.stdout || '').split('\n')) {
        if (!/LISTENING/i.test(line)) continue;
        const m = line.match(/[:\]](\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && parseInt(m[1], 10) === port) {
          const pid = parseInt(m[2], 10);
          if (!isNaN(pid) && pid !== process.pid) pids.add(pid);
        }
      }
    } else {
      const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' }).stdout || '';
      for (const l of out.split('\n')) {
        const pid = parseInt(l.trim(), 10);
        if (!isNaN(pid) && pid !== process.pid) pids.add(pid);
      }
    }
  } catch {}
  return [...pids];
}

function readCmdline(pid: number): string {
  if (isWindows) {
    try {
      const result = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'],
        { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const m = (result.stdout || '').match(/CommandLine=([^\r\n]+)/);
      return m ? m[1].trim() : '';
    } catch { return ''; }
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
  } catch {
    try {
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
      return r.stdout?.trim() || '';
    } catch { return ''; }
  }
}

// ── instance 文件读写 ──

function instanceDir(): string {
  return resolvePaths().instanceDir;
}

function isEcwebInstanceFile(file: string): boolean {
  return /^(ecweb|watch-web)-\d+\.json$/.test(file);
}

function ecwebFile(pid: number): string {
  return path.join(instanceDir(), `ecweb-${pid}.json`);
}

export function writeEcweb(port: number): string {
  const dir = instanceDir();
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = getProcessStartTime(process.pid) ?? Date.now();
  const record: EcwebRecord = { pid: process.pid, startedAt, startedAtIso: new Date(startedAt).toISOString(), port };
  const filePath = ecwebFile(process.pid);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, filePath);
  return filePath;
}

export function removeEcweb(pid?: number): void {
  const target = pid ?? process.pid;
  const dir = instanceDir();
  for (const prefix of ['ecweb', 'watch-web']) {
    try { fs.unlinkSync(path.join(dir, `${prefix}-${target}.json`)); } catch {}
  }
}

function safeParseJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T; } catch { return null; }
}

/**
 * 杀掉所有非自己 PID 的存活 ecweb 进程并清理文件。
 * 兼容清理迁移前遗留的 watch-web-*.json。
 * 用启动时间比对防 PID 复用。返回被杀的记录列表。
 */
export function cleanupEcwebs(): EcwebRecord[] {
  const dir = instanceDir();
  if (!fs.existsSync(dir)) return [];
  let files: string[];
  try { files = fs.readdirSync(dir); } catch { return []; }

  const killed: EcwebRecord[] = [];
  for (const file of files) {
    if (!isEcwebInstanceFile(file)) continue;
    const filePath = path.join(dir, file);
    const record = safeParseJson<EcwebRecord>(filePath);
    if (record?.pid && record.pid !== process.pid) {
      if (isProcessRunning(record.pid) && startTimeMatches(record.startedAt, getProcessStartTime(record.pid))) {
        killPid(record.pid);
        killed.push(record);
      }
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
  return killed;
}

/**
 * 兜底：按端口找占用进程，确认是 ecweb 进程后 SIGKILL。
 * 用于清理 instance 文件已丢失的孤儿进程（杀不掉的僵尸）。返回被杀的 PID 列表。
 */
export function cleanupEcwebByPort(port: number): number[] {
  const killed: number[] = [];
  for (const pid of findPidByPort(port)) {
    if (pid === process.pid || !isProcessRunning(pid)) continue;
    const cmdline = readCmdline(pid);
    // 只杀确认是 ecweb 的进程，避免误杀别人占的端口
    if (/ecweb|dist[\\/]index\.js/i.test(cmdline)) {
      killPid(pid);
      killed.push(pid);
    }
  }
  return killed;
}
