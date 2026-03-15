import fs from 'fs';
import path from 'path';

const LOG_DIR = 'logs';
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

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
  return LEVELS[level as keyof typeof LEVELS] >= LEVELS[LOG_LEVEL as keyof typeof LEVELS];
}

function write(stream: fs.WriteStream | null, data: any) {
  if (!stream) return;
  const line = typeof data === 'string' ? data : JSON.stringify(data);
  stream.write(`${line}\n`);
}

function log(level: string, ...args: any[]) {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] [${level}] ${args.join(' ')}`;
  // 只写文件，不输出到 console（避免重定向时重复）
  write(streams.main, msg);
}

export const logger = {
  debug: (...args: any[]) => log('DEBUG', ...args),
  info: (...args: any[]) => log('INFO', ...args),
  warn: (...args: any[]) => log('WARN', ...args),
  error: (...args: any[]) => log('ERROR', ...args),

  message: (data: any) => {
    write(streams.message, { ts: new Date().toISOString(), ...data });
  },

  event: (data: any) => {
    write(streams.event, { ts: new Date().toISOString(), ...data });
  }
};
