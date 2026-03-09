import Database from 'better-sqlite3';
import { join } from 'path';

export interface MessageRecord {
  id?: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  line_number: number;
}

export class MessageDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        UNIQUE(session_id, line_number)
      );
      CREATE INDEX IF NOT EXISTS idx_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        session_id TEXT PRIMARY KEY,
        last_synced_line INTEGER NOT NULL DEFAULT 0,
        last_full_sync INTEGER NOT NULL DEFAULT 0
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        processed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_messages(processed_at);
    `);
  }

  insertMessage(msg: MessageRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (session_id, role, content, timestamp, line_number)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(msg.session_id, msg.role, msg.content, msg.timestamp, msg.line_number);
  }

  getLastSyncedLine(sessionId: string): number {
    const row = this.db.prepare('SELECT last_synced_line FROM sync_state WHERE session_id = ?').get(sessionId) as { last_synced_line: number } | undefined;
    return row?.last_synced_line || 0;
  }

  updateSyncState(sessionId: string, lastLine: number, isFullSync: boolean = false): void {
    const stmt = this.db.prepare(`
      INSERT INTO sync_state (session_id, last_synced_line, last_full_sync)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_synced_line = ?,
        last_full_sync = CASE WHEN ? THEN ? ELSE last_full_sync END
    `);
    const now = Date.now();
    stmt.run(sessionId, lastLine, isFullSync ? now : 0, lastLine, isFullSync, now);
  }

  getLastFullSyncTime(sessionId: string): number {
    const row = this.db.prepare('SELECT last_full_sync FROM sync_state WHERE session_id = ?').get(sessionId) as { last_full_sync: number } | undefined;
    return row?.last_full_sync || 0;
  }

  close(): void {
    this.db.close();
  }
}
