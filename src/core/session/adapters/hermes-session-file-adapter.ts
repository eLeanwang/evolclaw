/**
 * Hermes SessionFileAdapter
 *
 * Reads Hermes session state from ~/.hermes/state.db (or $HERMES_HOME/state.db).
 * Hermes persists conversations in SQLite, not per-project JSONL files like Claude.
 *
 * Fallback: When a session is missing from state.db (e.g. due to transient
 * SQLite write-lock contention), checks for the JSON session log file at
 * ~/.hermes/sessions/session_{id}.json — Hermes always writes these regardless
 * of DB persistence success.
 */

import { DatabaseSync } from 'node:sqlite';
import type { CliSessionEntry, SdkSessionEntry, SessionFileAdapter, SessionFileInfo } from '../session-file-adapter.js';
import { logger } from '../../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

export class HermesSessionFileAdapter implements SessionFileAdapter {
  readonly agentId = 'hermes';
  private db: DatabaseSync | null = null;
  private dbInitialized = false;

  private resolveStateDbPath(): string | null {
    const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
    const dbPath = path.join(hermesHome, 'state.db');
    return fs.existsSync(dbPath) ? dbPath : null;
  }

  private getDb(): DatabaseSync | null {
    if (this.dbInitialized) return this.db;
    this.dbInitialized = true;

    const dbPath = this.resolveStateDbPath();
    if (!dbPath) return null;

    try {
      this.db = new DatabaseSync(dbPath, { readOnly: true } as any);
      logger.debug(`[HermesAdapter] Opened state DB: ${dbPath}`);
    } catch (error) {
      logger.warn(`[HermesAdapter] Failed to open state DB: ${dbPath}`, error);
      this.db = null;
    }
    return this.db;
  }

  checkExists(_projectPath: string, agentSessionId: string): boolean {
    // Primary: check SQLite state.db
    const db = this.getDb();
    if (db) {
      try {
        const row = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(agentSessionId) as any;
        if (row) return true;
      } catch (error) {
        logger.warn('[HermesAdapter] checkExists DB query failed:', error);
      }
    }

    // Fallback: check session log file on disk.
    // Hermes always writes JSON session logs even when SQLite persistence
    // fails (e.g. transient write-lock contention), so the log file is the
    // most reliable existence proof.
    const logFile = this.resolveSessionLogPath(agentSessionId);
    if (logFile && fs.existsSync(logFile)) {
      logger.warn(
        `[HermesAdapter] Session ${agentSessionId} missing from state.db but log file exists — DB write was likely lost`,
      );
      return true;
    }

    return false;
  }

  getFileInfo(_projectPath: string, agentSessionId: string): SessionFileInfo {
    const db = this.getDb();
    if (db) {
      try {
        const row = db.prepare(
          `SELECT title,
                  (SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'user') AS turns
           FROM sessions
           WHERE id = ?`
        ).get(agentSessionId, agentSessionId) as any;

        if (row) {
          return {
            turns: Number(row.turns || 0),
            title: row.title || undefined,
          };
        }
      } catch (error) {
        logger.warn('[HermesAdapter] getFileInfo DB query failed:', error);
      }
    }

    // Fallback: estimate turns from session log file
    const logFile = this.resolveSessionLogPath(agentSessionId);
    if (logFile && fs.existsSync(logFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
        const msgs = Array.isArray(data) ? data : data.messages || [];
        const turns = msgs.filter((m: any) => m.role === 'user').length;
        return { turns };
      } catch {
        return { turns: 0 };
      }
    }

    return { turns: 0 };
  }

  readFirstMessage(_projectPath: string, agentSessionId: string): string | null {
    return this.readUserMessage(agentSessionId, 'ASC');
  }

  readLastUserMessage(_projectPath: string, agentSessionId: string): string | null {
    return this.readUserMessage(agentSessionId, 'DESC');
  }

  scanCliSessions(_projectPath: string): CliSessionEntry[] {
    const db = this.getDb();
    if (!db) return [];

    try {
      const rows = db.prepare(
        `SELECT id, started_at
         FROM sessions
         WHERE source = 'cli'
         ORDER BY started_at DESC
         LIMIT 10`
      ).all() as any[];

      return rows.map((row) => ({
        uuid: row.id,
        mtime: Math.floor(Number(row.started_at || 0) * 1000),
      }));
    } catch (error) {
      logger.warn('[HermesAdapter] scanCliSessions failed:', error);
      return [];
    }
  }

  async listSdkSessions(_projectPath: string): Promise<SdkSessionEntry[]> {
    const db = this.getDb();
    if (!db) return [];

    try {
      const rows = db.prepare(
        `SELECT id, title
         FROM sessions
         ORDER BY started_at DESC
         LIMIT 50`
      ).all() as any[];

      return rows.map((row) => ({
        sessionId: row.id,
        title: row.title || undefined,
      }));
    } catch (error) {
      logger.warn('[HermesAdapter] listSdkSessions failed:', error);
      return [];
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close errors
      }
      this.db = null;
    }
    this.dbInitialized = false;
  }

  private resolveSessionLogPath(agentSessionId: string): string | null {
    const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
    const logPath = path.join(hermesHome, 'sessions', `session_${agentSessionId}.json`);
    return logPath;
  }

  private readUserMessage(agentSessionId: string, order: 'ASC' | 'DESC'): string | null {
    const db = this.getDb();
    if (!db) return null;

    try {
      const row = db.prepare(
        `SELECT content
         FROM messages
         WHERE session_id = ? AND role = 'user' AND content IS NOT NULL
         ORDER BY timestamp ${order}, id ${order}
         LIMIT 1`
      ).get(agentSessionId) as any;

      if (!row?.content || typeof row.content !== 'string') return null;
      const text = row.content.trim().replace(/\s+/g, ' ');
      return text.substring(0, 50) + (text.length > 50 ? '...' : '');
    } catch (error) {
      logger.warn('[HermesAdapter] readUserMessage failed:', error);
      return null;
    }
  }
}
