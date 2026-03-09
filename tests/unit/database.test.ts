import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageDatabase } from '../../src/core/database.js';
import { rmSync, mkdirSync, existsSync } from 'fs';

describe('MessageDatabase', () => {
  const testDataDir = './data/test-db';
  const testDbPath = `${testDataDir}/test.db`;
  let db: MessageDatabase;

  beforeEach(() => {
    mkdirSync(testDataDir, { recursive: true });
    db = new MessageDatabase(testDbPath);
  });

  afterEach(() => {
    db.close();
    // 只删除测试目录，不删除整个 data 目录
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it('should insert message', () => {
    db.insertMessage({ session_id: 's1', role: 'user', content: 'Hello', timestamp: Date.now(), line_number: 1 });
    expect(db.getLastSyncedLine('s1')).toBe(0);
  });

  it('should get last synced line', () => {
    expect(db.getLastSyncedLine('s1')).toBe(0);
  });

  it('should get last full sync time', () => {
    expect(db.getLastFullSyncTime('s1')).toBe(0);
  });
});
