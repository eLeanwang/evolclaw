import { resolvePaths } from '../paths.js';
import { LogWriter } from './log-writer.js';

const LOG_DIR = resolvePaths().logs;
let currentLevel = process.env.LOG_LEVEL || 'INFO';
const LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const config = {
  messageLog: process.env.MESSAGE_LOG === 'true',
  eventLog: process.env.EVENT_LOG === 'true'
};

// 主日志：按小时切片，保留 24 小时
const mainWriter = new LogWriter({
  baseName: 'evolclaw',
  logDir: LOG_DIR,
  rotation: 'hourly',
  retention: { hours: 24 },
});

// 消息日志：按小时切片，保留 24 小时
const messageWriter = config.messageLog
  ? new LogWriter({ baseName: 'messages', logDir: LOG_DIR, rotation: 'hourly', retention: { hours: 24 } })
  : null;

// 事件日志：按小时切片，保留 24 小时（由 index.ts 订阅 EventBus 后填充）
const eventWriter = config.eventLog
  ? new LogWriter({ baseName: 'events', logDir: LOG_DIR, rotation: 'hourly', retention: { hours: 24 } })
  : null;

// 渠道入站日志：记录从渠道收到的原始消息
const channelInWriter = new LogWriter({ baseName: 'channel-in', logDir: LOG_DIR, rotation: 'hourly', retention: { hours: 24 } });

// 渠道出站日志：记录发往渠道的所有消息
const channelOutWriter = new LogWriter({ baseName: 'channel-out', logDir: LOG_DIR, rotation: 'hourly', retention: { hours: 24 } });

function shouldLog(level: string): boolean {
  return (LEVELS[level] ?? 1) >= (LEVELS[currentLevel] ?? 1);
}

export function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(level: string, ...args: any[]) {
  if (!shouldLog(level)) return;
  const msg = `[${localTimestamp()}] [${level}] ${args.join(' ')}`;
  mainWriter.write(msg);
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
    if (!messageWriter) return;
    messageWriter.write(JSON.stringify({ ts: localTimestamp(), ...data }));
  },

  event: (data: any) => {
    if (!eventWriter) return;
    eventWriter.write(JSON.stringify({ ts: localTimestamp(), ...data }));
  },

  channelIn: (data: any) => {
    channelInWriter.write(JSON.stringify({ ts: localTimestamp(), ...data }));
  },

  channelOut: (data: any) => {
    channelOutWriter.write(JSON.stringify({ ts: localTimestamp(), ...data }));
  }
};
