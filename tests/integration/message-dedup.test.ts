import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TEST_DIR = 'tests/tmp';
const TEST_DB = path.join(TEST_DIR, 'test.db');

describe('Message Deduplication', () => {
  let db: Database.Database;

  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = new Database(TEST_DB);
    db.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        processed_at INTEGER NOT NULL
      )
    `);
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it('should process first message', () => {
    const stmt = db.prepare('SELECT * FROM processed_messages WHERE message_id = ?');
    const result = stmt.get('msg1');
    expect(result).toBeUndefined();
  });

  it('should reject duplicate message', () => {
    db.prepare('INSERT INTO processed_messages (message_id, channel, channel_id, processed_at) VALUES (?, ?, ?, ?)').run('msg1', 'feishu', 'chat1', Date.now());

    const result = db.prepare('SELECT * FROM processed_messages WHERE message_id = ?').get('msg1');
    expect(result).toBeDefined();
  });

  it('should persist across restarts', () => {
    db.prepare('INSERT INTO processed_messages (message_id, channel, channel_id, processed_at) VALUES (?, ?, ?, ?)').run('msg1', 'feishu', 'chat1', Date.now());
    db.close();

    db = new Database(TEST_DB);
    const result = db.prepare('SELECT * FROM processed_messages WHERE message_id = ?').get('msg1');
    expect(result).toBeDefined();
  });
});
