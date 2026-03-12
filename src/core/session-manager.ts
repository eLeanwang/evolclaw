import Database from 'better-sqlite3';
import { Session } from '../types.js';
import { ensureDir } from '../config.js';
import { logger } from '../utils/logger.js';
import path from 'path';

export class SessionManager {
  private db: Database.Database;

  constructor(dbPath: string = './data/sessions.db') {
    ensureDir(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  private initDatabase(): void {
    // 检查是否需要迁移
    const tableInfo = this.db.pragma('table_info(sessions)') as any[];
    const hasIsActive = tableInfo.some((col: any) => col.name === 'is_active');

    if (!hasIsActive && tableInfo.length > 0) {
      // 需要迁移：旧表存在但没有 is_active 字段
      logger.info('Migrating database schema...');
      this.db.exec(`
        -- 创建新表
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          claude_session_id TEXT,
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(channel, channel_id, project_path)
        );

        -- 迁移数据（所有现有会话标记为活跃）
        INSERT INTO sessions_new
          (id, channel, channel_id, project_path, claude_session_id, is_active, created_at, updated_at)
        SELECT
          id, channel, channel_id, project_path, claude_session_id, 1, created_at, updated_at
        FROM sessions;

        -- 替换表
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
      `);
      logger.info('✓ Database migration completed');
    } else {
      // 创建新表（如果不存在）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          claude_session_id TEXT,
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(channel, channel_id, project_path)
        )
      `);
    }

    // 创建消息去重表
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

  async getOrCreateSession(channel: 'feishu' | 'acp', channelId: string, defaultProjectPath: string): Promise<Session> {
    // 1. 查找该聊天的活跃会话
    const active = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).get(channel, channelId) as any;

    if (active) {
      return {
        id: active.id,
        channel: active.channel,
        channelId: active.channel_id,
        projectPath: active.project_path,
        claudeSessionId: active.claude_session_id,
        isActive: active.is_active === 1,
        createdAt: active.created_at,
        updatedAt: active.updated_at
      };
    }

    // 2. 没有活跃会话，查找该聊天在默认项目的会话
    const existing = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ?
    `).get(channel, channelId, defaultProjectPath) as any;

    if (existing) {
      // 激活该会话
      this.db.prepare(`
        UPDATE sessions SET is_active = 1, updated_at = ?
        WHERE id = ?
      `).run(Date.now(), existing.id);

      return {
        id: existing.id,
        channel: existing.channel,
        channelId: existing.channel_id,
        projectPath: existing.project_path,
        claudeSessionId: existing.claude_session_id,
        isActive: true,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at
      };
    }

    // 3. 创建新会话（默认为活跃）
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath: defaultProjectPath,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.db.prepare(`
      INSERT INTO sessions (id, channel, channel_id, project_path, claude_session_id, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.channel, session.channelId, session.projectPath, session.claudeSessionId, 1, session.createdAt, session.updatedAt);

    return session;
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    const fields = Object.keys(updates).filter(k => k !== 'id').map(k => `${k} = ?`).join(', ');
    const values = Object.keys(updates).filter(k => k !== 'id').map(k => updates[k as keyof Session]);

    this.db.prepare(`UPDATE sessions SET ${fields}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), sessionId);
  }

  async switchProject(channel: 'feishu' | 'acp', channelId: string, newProjectPath: string): Promise<Session> {
    // 1. 取消当前活跃会话
    this.db.prepare(`
      UPDATE sessions SET is_active = 0, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(Date.now(), channel, channelId);

    // 2. 查找目标项目的会话
    const target = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ?
    `).get(channel, channelId, newProjectPath) as any;

    if (target) {
      // 激活已有会话
      this.db.prepare(`
        UPDATE sessions SET is_active = 1, updated_at = ?
        WHERE id = ?
      `).run(Date.now(), target.id);

      return {
        id: target.id,
        channel: target.channel,
        channelId: target.channel_id,
        projectPath: target.project_path,
        claudeSessionId: target.claude_session_id,
        isActive: true,
        createdAt: target.created_at,
        updatedAt: target.updated_at
      };
    }

    // 3. 创建新会话
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath: newProjectPath,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.db.prepare(`
      INSERT INTO sessions (id, channel, channel_id, project_path, claude_session_id, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.channel, session.channelId, session.projectPath, null, 1, session.createdAt, session.updatedAt);

    return session;
  }

  async updateProjectPath(channel: 'feishu' | 'acp', channelId: string, projectPath: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET project_path = ?, updated_at = ? WHERE channel = ? AND channel_id = ?')
      .run(projectPath, Date.now(), channel, channelId);
  }

  async updateClaudeSessionId(channel: 'feishu' | 'acp', channelId: string, claudeSessionId: string): Promise<void> {
    // 只更新当前活跃会话的 Claude Session ID
    this.db.prepare(`
      UPDATE sessions
      SET claude_session_id = ?, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(claudeSessionId, Date.now(), channel, channelId);
  }

  async updateClaudeSessionIdBySessionId(sessionId: string, claudeSessionId: string): Promise<void> {
    // 根据 sessionId 直接更新
    this.db.prepare(`
      UPDATE sessions
      SET claude_session_id = ?, updated_at = ?
      WHERE id = ?
    `).run(claudeSessionId, Date.now(), sessionId);
  }

  async clearActiveSession(channel: 'feishu' | 'acp', channelId: string): Promise<void> {
    // 清除当前活跃会话的 Claude Session ID
    this.db.prepare(`
      UPDATE sessions
      SET claude_session_id = NULL, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(Date.now(), channel, channelId);
  }

  async clearClaudeSessionId(channel: 'feishu' | 'acp', channelId: string): Promise<void> {
    // 向后兼容的别名
    await this.clearActiveSession(channel, channelId);
  }

  async getSession(channel: 'feishu' | 'acp', channelId: string): Promise<Session | undefined> {
    // 获取活跃会话
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).get(channel, channelId) as any;

    if (!row) return undefined;

    return {
      id: row.id,
      channel: row.channel,
      channelId: row.channel_id,
      projectPath: row.project_path,
      claudeSessionId: row.claude_session_id,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * 获取活跃会话（getSession 的别名，语义更清晰）
   */
  async getActiveSession(channel: 'feishu' | 'acp', channelId: string): Promise<Session | undefined> {
    return this.getSession(channel, channelId);
  }

  async listSessions(channel: 'feishu' | 'acp', channelId: string): Promise<Session[]> {
    // 列出该聊天的所有会话
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ?
      ORDER BY updated_at DESC
    `).all(channel, channelId) as any[];

    return rows.map(row => ({
      id: row.id,
      channel: row.channel,
      channelId: row.channel_id,
      projectPath: row.project_path,
      claudeSessionId: row.claude_session_id,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async getSessionByProjectPath(channel: 'feishu' | 'acp', channelId: string, projectPath: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ?
    `).get(channel, channelId, projectPath) as any;

    if (!row) return undefined;

    return {
      id: row.id,
      channel: row.channel,
      channelId: row.channel_id,
      projectPath: row.project_path,
      claudeSessionId: row.claude_session_id,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  close(): void {
    this.db.close();
  }
}
