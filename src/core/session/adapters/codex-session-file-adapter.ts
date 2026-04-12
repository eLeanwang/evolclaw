/**
 * Codex SessionFileAdapter
 *
 * Reads Codex thread data from ~/.codex/state_*.sqlite (read-only)
 * and Codex rollout JSONL files for detailed session info.
 */

import { DatabaseSync } from 'node:sqlite';
import type { SessionFileAdapter, SessionFileInfo, CliSessionEntry, SdkSessionEntry } from '../session-file-adapter.js';
import { logger } from '../../../utils/logger.js';
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
    // 1. 优先查 state_*.sqlite（覆盖 CLI 创建的线程）
    const db = this.getDb();
    if (db) {
      try {
        const row = db.prepare(
          'SELECT 1 FROM threads WHERE id = ? AND archived = 0'
        ).get(agentSessionId) as any;
        if (row) return true;
      } catch (error) {
        logger.warn(`[CodexAdapter] checkExists DB query failed:`, error);
      }
    }

    // 2. Fallback: 扫 ~/.codex/sessions/ 下的 rollout JSONL
    //    SDK 创建的 thread 不写 state_*.sqlite，但会持久化到 sessions 目录
    return !!this.findRolloutFile(agentSessionId);
  }

  /**
   * 在 ~/.codex/sessions/ 下递归查找含 agentSessionId 的 rollout JSONL 文件
   */
  private findRolloutFile(agentSessionId: string): string | null {
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;

    try {
      const search = (dir: string): string | null => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const found = search(path.join(dir, entry.name));
            if (found) return found;
          } else if (entry.name.endsWith('.jsonl') && entry.name.includes(agentSessionId)) {
            return path.join(dir, entry.name);
          }
        }
        return null;
      };
      return search(sessionsDir);
    } catch {
      return null;
    }
  }

  getFileInfo(projectPath: string, agentSessionId: string): SessionFileInfo {
    // 1. 优先查 state DB
    const db = this.getDb();
    if (db) {
      try {
        const row = db.prepare(
          'SELECT title, rollout_path FROM threads WHERE id = ?'
        ).get(agentSessionId) as any;

        if (row) {
          return {
            turns: this.countTurnsFromRollout(row.rollout_path),
            title: row.title || undefined,
          };
        }
      } catch (error) {
        logger.warn(`[CodexAdapter] getFileInfo DB query failed:`, error);
      }
    }

    // 2. Fallback: 从 sessions 目录查找 rollout 文件
    const rolloutPath = this.findRolloutFile(agentSessionId);
    if (rolloutPath) {
      return { turns: this.countTurnsFromRollout(rolloutPath) };
    }

    return { turns: 0 };
  }

  readFirstMessage(projectPath: string, agentSessionId: string): string | null {
    // 1. 优先查 state DB
    const db = this.getDb();
    if (db) {
      try {
        const row = db.prepare(
          'SELECT first_user_message FROM threads WHERE id = ?'
        ).get(agentSessionId) as any;

        if (row?.first_user_message) {
          const text = row.first_user_message.trim().replace(/\s+/g, ' ');
          return text.substring(0, 50) + (text.length > 50 ? '...' : '');
        }
      } catch (error) {
        logger.warn(`[CodexAdapter] readFirstMessage DB query failed:`, error);
      }
    }

    // 2. Fallback: 从 rollout JSONL 读取第一条 user_message
    const rolloutPath = this.findRolloutFile(agentSessionId);
    if (!rolloutPath) return null;
    return this.readUserMessageFromRollout(rolloutPath, 'first');
  }

  readLastUserMessage(projectPath: string, agentSessionId: string): string | null {
    // 1. 优先查 state DB 获取 rollout_path
    const db = this.getDb();
    let rolloutPath: string | null = null;

    if (db) {
      try {
        const row = db.prepare(
          'SELECT rollout_path FROM threads WHERE id = ?'
        ).get(agentSessionId) as any;
        if (row?.rollout_path && fs.existsSync(row.rollout_path)) {
          rolloutPath = row.rollout_path;
        }
      } catch (error) {
        logger.warn(`[CodexAdapter] readLastUserMessage DB query failed:`, error);
      }
    }

    // 2. Fallback: 从 sessions 目录查找 rollout 文件
    if (!rolloutPath) {
      rolloutPath = this.findRolloutFile(agentSessionId);
    }

    if (!rolloutPath) return null;
    return this.readUserMessageFromRollout(rolloutPath, 'last');
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
   * 从 rollout JSONL 读取第一条或最后一条 user_message
   */
  private readUserMessageFromRollout(rolloutPath: string, which: 'first' | 'last'): string | null {
    try {
      const content = fs.readFileSync(rolloutPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let result: string | null = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'event_msg' && event.payload?.type === 'user_message' && event.payload.message) {
            const text = event.payload.message.trim().replace(/\s+/g, ' ');
            const truncated = text.substring(0, 50) + (text.length > 50 ? '...' : '');
            if (which === 'first') return truncated;
            result = truncated;
          }
        } catch { /* skip malformed line */ }
      }
      return result;
    } catch {
      return null;
    }
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
