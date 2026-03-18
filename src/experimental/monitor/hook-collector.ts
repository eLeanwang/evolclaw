import { DatabaseSync, StatementSync } from 'node:sqlite';

export type HookEventType =
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Notification';

export interface HookEvent {
  session_id: string;
  event_type: HookEventType;
  timestamp: number;
  data?: any;
}

export class HookCollector {
  private db: DatabaseSync;
  private insertStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initSchema();
    this.insertStmt = this.db.prepare(`
      INSERT INTO session_events (session_id, event_type, timestamp, data)
      VALUES (?, ?, ?, ?)
    `);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_events ON session_events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_event_type ON session_events(event_type);
    `);
  }

  collect(event: HookEvent): void {
    this.insertStmt.run(
      event.session_id,
      event.event_type,
      event.timestamp,
      event.data ? JSON.stringify(event.data) : null
    );
  }

  getLastActivity(sessionId: string): number | null {
    const row = this.db.prepare(`
      SELECT MAX(timestamp) as last_activity
      FROM session_events
      WHERE session_id = ? AND event_type IN ('Stop', 'PostToolUse', 'SubagentStart', 'SubagentStop')
    `).get(sessionId) as { last_activity: number | null } | undefined;
    return row?.last_activity || null;
  }

  hasEndEvent(sessionId: string): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM session_events
      WHERE session_id = ? AND event_type IN ('SessionEnd', 'timeout', 'crashed')
    `).get(sessionId) as { count: number };
    return row.count > 0;
  }

  getActiveSessions(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT session_id
      FROM session_events
      WHERE session_id NOT IN (
        SELECT session_id FROM session_events WHERE event_type IN ('SessionEnd', 'timeout', 'crashed')
      )
    `).all() as { session_id: string }[];
    return rows.map(r => r.session_id);
  }
}
