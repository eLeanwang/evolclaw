/**
 * Cross-platform process introspection.
 *
 * Provides process start time retrieval for PID reuse detection.
 * Returns null when start time cannot be obtained — callers should treat
 * this as "do not match" (conservative: prefer leaving an orphan over
 * killing the wrong process).
 */
import fs from 'fs';
import { spawnSync } from 'child_process';
import { isWindows } from './cross-platform.js';

const isMacOS = process.platform === 'darwin';

/** 容差：2 秒（覆盖 macOS 秒级精度 + 时钟漂移） */
export const START_TIME_TOLERANCE_MS = 2000;

/**
 * 获取进程启动时间（Unix 毫秒）。
 * 拿不到时返回 null，调用方应保守处理（不杀该 PID）。
 */
export function getProcessStartTime(pid: number): number | null {
  try {
    if (pid === process.pid) {
      return Math.round(Date.now() - process.uptime() * 1000);
    }
    if (isWindows) return getStartTimeWindows(pid);
    if (isMacOS) return getStartTimeMacOS(pid);
    return getStartTimeLinux(pid);
  } catch {
    return null;
  }
}

/**
 * 比对记录的启动时间与实际启动时间是否匹配（容差 2 秒）。
 * actual === null 时返回 false（保守不匹配）。
 */
export function startTimeMatches(recorded: number, actual: number | null): boolean {
  if (actual === null) return false;
  return Math.abs(recorded - actual) < START_TIME_TOLERANCE_MS;
}

// ── Linux ──

function getStartTimeLinux(pid: number): number | null {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return null;
  }
  const tail = stat.slice(stat.lastIndexOf(')') + 2);
  const fields = tail.split(' ');
  const starttimeJiffies = parseInt(fields[19], 10);
  if (isNaN(starttimeJiffies)) return null;

  let uptimeSec: number;
  try {
    uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);
  } catch {
    return null;
  }
  if (isNaN(uptimeSec)) return null;

  const clkTck = 100;
  const bootTimeMs = Date.now() - uptimeSec * 1000;
  return bootTimeMs + (starttimeJiffies / clkTck) * 1000;
}

// ── macOS ──

function getStartTimeMacOS(pid: number): number | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out = result.stdout?.trim();
  if (!out) return null;
  const t = Date.parse(out);
  return isNaN(t) ? null : t;
}

// ── Windows ──

function getStartTimeWindows(pid: number): number | null {
  const fromPwsh = winPowerShellCreationDate(pid);
  if (fromPwsh !== null) return fromPwsh;
  return winWmicCreationDate(pid);
}

function winPowerShellCreationDate(pid: number): number | null {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate`,
    ],
    { encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const out = result.stdout?.trim();
  if (!out) return null;
  return parseCimDate(out);
}

function winWmicCreationDate(pid: number): number | null {
  const result = spawnSync(
    'wmic',
    ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
    { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const out = result.stdout || '';
  const m = out.match(/CreationDate=([^\r\n]+)/);
  if (!m) return null;
  return parseCimDate(m[1].trim());
}

/**
 * 解析 CIM/WMI 日期格式：yyyyMMddHHmmss.ffffff±TZZZ
 * TZZZ 是相对 UTC 的分钟偏移（中国是 +480）
 */
export function parseCimDate(s: string): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d+)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, us, tz] = m;
  const tzMin = parseInt(tz, 10);
  if (isNaN(tzMin)) return null;
  const localUtcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, Math.floor(+us / 1000));
  return localUtcMs - tzMin * 60 * 1000;
}
