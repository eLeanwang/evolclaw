/**
 * Codex SessionFileAdapter
 *
 * Reads Codex thread data from ~/.codex/state_*.sqlite (read-only)
 * and Codex rollout JSONL files for detailed session info.
 */

import { DatabaseSync } from 'node:sqlite';
import type { SessionFileAdapter, SessionFileInfo, CliSessionEntry, SdkSessionEntry } from '../session-file-adapter.js';
import { logger } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

export class CodexSessionFileAdapter implements SessionFileAdapter {
  readonly agentId = 'codex';
  private db: DatabaseSync | null = null;
  private dbInitialized = false;

  /**
   * 动态发现最新的 state_*.sqlite 文件
   * Codex 使用 sqlx 迁移，DB 文件名含版本号（state_5, state_6, ...）
   */
  private resolveStateDbPath(): string | null {
    const codexHome = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexHome)) return null;

    try {
      const files = fs.readdirSync(codexHome)
        .filter(f => /^state_\d+\.sqlite$/.test(f))
        .sort((a, b) => {
          const va = parseInt(a.match(/state_(\d+)/)?.[1] || '0');
          const vb = parseInt(b.match(/state_(\d+)/)?.[1] || '0');
          return vb - va;
        });
      return files.length > 0 ? path.join(codexHome, files[0]) : null;
    } catch {
      return null;
    }
  }

  private getDb(): DatabaseSync | null {
    if (this.dbInitialized) return this.db;
    this.dbInitialized = true;

    const dbPath = this.resolveStateDbPath();
    if (!dbPath) return null;

    try {
      this.db = new DatabaseSync(dbPath, { readOnly: true } as any);
      logger.debug(`[CodexAdapter] Opened state DB: ${dbPath}`);
    } catch (error) {
      logger.warn(`[CodexAdapter] Failed to open state DB: ${dbPath}`, error);
      this.db = null;
    }
    return this.db;
  }

  checkExists(projectPath: string, agentSessionId: string): boolean {
    const db = this.getDb();
    if (!db) return false;

    try {
      const row = db.prepare(
        'SELECT 1 FROM threads WHERE id = ? AND archived = 0'
      ).get(agentSessionId) as any;
      return !!row;
    } catch (error) {
      logger.warn(`[CodexAdapter] checkExists failed:`, error);
      return false;
    }
  }

  getFileInfo(projectPath: string, agentSessionId: string): SessionFileInfo {
    const db = this.getDb();
    if (!db) return { turns: 0 };

    try {
      const row = db.prepare(
        'SELECT title, rollout_path FROM threads WHERE id = ?'
      ).get(agentSessionId) as any;

      if (!row) return { turns: 0 };

      const title = row.title || undefined;
      const turns = this.countTurnsFromRollout(row.rollout_path);

      return { turns, title };
    } catch (error) {
      logger.warn(`[CodexAdapter] getFileInfo failed:`, error);
      return { turns: 0 };
    }
  }

  readFirstMessage(projectPath: string, agentSessionId: string): string | null {
    const db = this.getDb();
    if (!db) return null;

    try {
      const row = db.prepare(
        'SELECT first_user_message FROM threads WHERE id = ?'
      ).get(agentSessionId) as any;

      if (!row?.first_user_message) return null;
      const text = row.first_user_message.trim().replace(/\s+/g, ' ');
      return text.substring(0, 50) + (text.length > 50 ? '...' : '');
    } catch (error) {
      logger.warn(`[CodexAdapter] readFirstMessage failed:`, error);
      return null;
    }
  }

  readLastUserMessage(projectPath: string, agentSessionId: string): string | null {
    const db = this.getDb();
    if (!db) return null;

    try {
      const row = db.prepare(
        'SELECT rollout_path FROM threads WHERE id = ?'
      ).get(agentSessionId) as any;

      if (!row?.rollout_path || !fs.existsSync(row.rollout_path)) return null;

      const content = fs.readFileSync(row.rollout_path, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let lastMessage: string | null = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'event_msg' && event.payload?.type === 'user_message' && event.payload.message) {
            const text = event.payload.message.trim().replace(/\s+/g, ' ');
            lastMessage = text.substring(0, 50) + (text.length > 50 ? '...' : '');
          }
        } catch { /* skip malformed line */ }
      }
      return lastMessage;
    } catch (error) {
      logger.warn(`[CodexAdapter] readLastUserMessage failed:`, error);
      return null;
    }
  }

  scanCliSessions(projectPath: string): CliSessionEntry[] {
    const db = this.getDb();
    if (!db) return [];

    try {
      const rows = db.prepare(
        'SELECT id, updated_at FROM threads WHERE cwd = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 10'
      ).all(projectPath) as any[];

      return rows.map(r => ({
        uuid: r.id,
        mtime: r.updated_at,  // Codex uses Unix timestamp (seconds)
      }));
    } catch (error) {
      logger.warn(`[CodexAdapter] scanCliSessions failed:`, error);
      return [];
    }
  }

  async listSdkSessions(projectPath: string): Promise<SdkSessionEntry[]> {
    const db = this.getDb();
    if (!db) return [];

    try {
      const rows = db.prepare(
        'SELECT id, title FROM threads WHERE cwd = ? AND archived = 0 ORDER BY updated_at DESC'
      ).all(projectPath) as any[];

      return rows.map(r => ({
        sessionId: r.id,
        title: r.title || undefined,
      }));
    } catch (error) {
      logger.warn(`[CodexAdapter] listSdkSessions failed:`, error);
      return [];
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch { /* ignore close errors */ }
      this.db = null;
    }
    this.dbInitialized = false;
  }

  /**
   * 从 rollout JSONL 文件计算轮数（数 turn_context 行）
   */
  private countTurnsFromRollout(rolloutPath: string): number {
    if (!rolloutPath || !fs.existsSync(rolloutPath)) return 0;

    try {
      const content = fs.readFileSync(rolloutPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let turns = 0;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'turn_context') {
            turns++;
          }
        } catch { /* skip malformed line */ }
      }
      return turns;
    } catch {
      return 0;
    }
  }
}
