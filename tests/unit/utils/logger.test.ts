import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { logger } from '../../../src/utils/logger.js';

const LOG_DIR = 'logs';

describe('Logger', () => {
  beforeEach(() => {
    if (fs.existsSync(LOG_DIR)) {
      const files = fs.readdirSync(LOG_DIR);
      files.forEach(f => fs.unlinkSync(path.join(LOG_DIR, f)));
    }
  });

  afterEach(() => {
    if (fs.existsSync(LOG_DIR)) {
      const files = fs.readdirSync(LOG_DIR);
      files.forEach(f => fs.unlinkSync(path.join(LOG_DIR, f)));
    }
  });

  it('should create log directory', () => {
    expect(fs.existsSync(LOG_DIR)).toBe(true);
  });

  it.skip('should write to main log file', async () => {
    logger.info('test message');
    await new Promise(resolve => setTimeout(resolve, 100));

    const logFile = path.join(LOG_DIR, 'evolclaw.log');
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf-8');
    expect(content).toContain('[INFO] test message');
  });

  it.skip('should write multiple log levels', async () => {
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    await new Promise(resolve => setTimeout(resolve, 100));

    const content = fs.readFileSync(path.join(LOG_DIR, 'evolclaw.log'), 'utf-8');
    expect(content).toContain('[INFO] info msg');
    expect(content).toContain('[WARN] warn msg');
    expect(content).toContain('[ERROR] error msg');
  });
});
