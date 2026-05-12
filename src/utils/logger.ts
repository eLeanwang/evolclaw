import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../paths.js';

const LOG_DIR = resolvePaths().logs;
let currentLevel = process.env.LOG_LEVEL || 'INFO';
const LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const config = {
  messageLog: process.env.MESSAGE_LOG === 'true',
  eventLog: process.env.EVENT_LOG === 'true'
};

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const streams = {
  main: fs.createWriteStream(path.join(LOG_DIR, 'evolclaw.log'), { flags: 'a' }),
  message: config.messageLog ? fs.createWriteStream(path.join(LOG_DIR, 'messages.log'), { flags: 'a' }) : null,
  event: config.eventLog ? fs.createWriteStream(path.join(LOG_DIR, 'events.log'), { flags: 'a' }) : null
};

function shouldLog(level: string): boolean {
  return (LEVELS[level] ?? 1) >= (LEVELS[currentLevel] ?? 1);
}

function write(stream: fs.WriteStream | null, data: any) {
  if (!stream) return;
  const line = typeof data === 'string' ? data : JSON.stringify(data);
  stream.write(`${line}\n`);
}

export function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(level: string, ...args: any[]) {
  if (!shouldLog(level)) return;
  const timestamp = localTimestamp();
  const msg = `[${timestamp}] [${level}] ${args.join(' ')}`;
  write(streams.main, msg);
}

/**
 * 设置日志级别（config 加载后调用，覆盖环境变量默认值）
 * 优先级：config.debug.logLevel → LOG_LEVEL 环境变量 → 'INFO'
 */
export function setLogLevel(level: string): void {
  const upper = level.toUpperCase();
  if (upper in LEVELS) {
    currentLevel = upper;
  }
}

export function getLogLevel(): string {
  return currentLevel;
}

export const logger = {
  debug: (...args: any[]) => log('DEBUG', ...args),
  info: (...args: any[]) => log('INFO', ...args),
  warn: (...args: any[]) => log('WARN', ...args),
  error: (...args: any[]) => log('ERROR', ...args),

  message: (data: any) => {
    write(streams.message, { ts: localTimestamp(), ...data });
  },

  event: (data: any) => {
    write(streams.event, { ts: localTimestamp(), ...data });
  }
};
