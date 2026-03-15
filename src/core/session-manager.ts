import Database from 'better-sqlite3';
import { Session } from '../types.js';
import { ensureDir } from '../config.js';
import { logger } from '../utils/logger.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

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

  private getProjectDirName(projectPath: string): string {
    return projectPath.replace(/\//g, '-');
  }

  private getSessionFilePath(projectPath: string, sessionId: string): string {
    const homeDir = os.homedir();
    const encodedPath = this.getProjectDirName(projectPath);
    return path.join(homeDir, '.claude', 'projects', encodedPath, `${sessionId}.jsonl`);
  }

  private initDatabase(): void {
    const tableInfo = this.db.pragma('table_info(sessions)') as any[];
    const hasIsActive = tableInfo.some((col: any) => col.name === 'is_active');
    const hasName = tableInfo.some((col: any) => col.name === 'name');

    // 检查是否有唯一约束
    const indexes = this.db.pragma('index_list(sessions)') as any[];
    const hasUniqueConstraint = indexes.some((idx: any) => idx.origin === 'u');

    if (!hasIsActive && tableInfo.length > 0) {
      logger.info('Migrating database schema (removing unique constraint)...');
      this.db.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          claude_session_id TEXT,
          name TEXT,
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO sessions_new SELECT id, channel, channel_id, project_path, claude_session_id, NULL, 1, created_at, updated_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
      `);
      logger.info('✓ Database migration completed');
    } else if (!hasName && tableInfo.length > 0) {
      logger.info('Adding name column...');
      this.db.exec(`ALTER TABLE sessions ADD COLUMN name TEXT`);
      if (hasUniqueConstraint) {
        logger.info('Removing unique constraint...');
        this.db.exec(`
          CREATE TABLE sessions_new (
            id TEXT PRIMARY KEY,
            channel TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            project_path TEXT NOT NULL,
            claude_session_id TEXT,
            name TEXT,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO sessions_new SELECT * FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
        `);
      }
      logger.info('✓ Schema updated');
    } else {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          claude_session_id TEXT,
          name TEXT,
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
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

    // 创建会话健康状态表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_health (
        session_id TEXT PRIMARY KEY,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_error_type TEXT,
        safe_mode INTEGER NOT NULL DEFAULT 0,
        last_success_time INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_health_safe_mode ON session_health(safe_mode);
    `);
  }

  async getOrCreateSession(channel: 'feishu' | 'acp', channelId: string, defaultProjectPath: string, name?: string): Promise<Session> {
    // 1. 查找该聊天的活跃会话
    const active = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).get(channel, channelId) as any;

    if (active) {
      // 验证会话文件是否存在
      let validSessionId = active.claude_session_id;
      if (validSessionId) {
        const sessionFile = this.getSessionFilePath(active.project_path, validSessionId);
        if (!fs.existsSync(sessionFile)) {
          logger.warn(`Session file not found: ${sessionFile}`);
          validSessionId = null;
        }
      }

      return {
        id: active.id,
        channel: active.channel,
        channelId: active.channel_id,
        projectPath: active.project_path,
        claudeSessionId: validSessionId,
        name: active.name,
        isActive: active.is_active === 1,
        createdAt: active.created_at,
        updatedAt: active.updated_at
      };
    }

    // 2. 没有活跃会话，查找该聊天在默认项目的会话
    const existing = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(channel, channelId, defaultProjectPath) as any;

    if (existing) {
      // 验证会话文件是否存在
      let validSessionId = existing.claude_session_id;
      if (validSessionId) {
        const sessionFile = this.getSessionFilePath(existing.project_path, validSessionId);
        if (!fs.existsSync(sessionFile)) {
          logger.warn(`Session file not found: ${sessionFile}, clearing session ID`);
          validSessionId = null;
          this.db.prepare(`UPDATE sessions SET claude_session_id = NULL WHERE id = ?`).run(existing.id);
        }
      }

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
        claudeSessionId: validSessionId,
        name: existing.name,
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
      name: name || '默认会话',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // 使用 INSERT OR IGNORE 避免并发时的 UNIQUE 约束冲突
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, channel, channel_id, project_path, claude_session_id, name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.channel, session.channelId, session.projectPath, session.claudeSessionId, session.name, 1, session.createdAt, session.updatedAt);

    // 如果插入被忽略（已存在），重新查询
    if (result.changes === 0) {
      const existing = this.db.prepare(`
        SELECT * FROM sessions
        WHERE channel = ? AND channel_id = ? AND project_path = ?
      `).get(channel, channelId, defaultProjectPath) as any;

      if (existing) {
        this.db.prepare(`UPDATE sessions SET is_active = 1, updated_at = ? WHERE id = ?`).run(Date.now(), existing.id);
        return {
          id: existing.id,
          channel: existing.channel,
          channelId: existing.channel_id,
          projectPath: existing.project_path,
          claudeSessionId: existing.claude_session_id,
          name: existing.name,
          isActive: true,
          createdAt: existing.created_at,
          updatedAt: Date.now()
        };
      }
    }

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
      ORDER BY updated_at DESC LIMIT 1
    `).get(channel, channelId, newProjectPath) as any;

    if (target) {
      // 验证会话文件是否存在
      let validSessionId = target.claude_session_id;
      if (validSessionId) {
        const sessionFile = this.getSessionFilePath(newProjectPath, validSessionId);
        if (!fs.existsSync(sessionFile)) {
          logger.warn(`Session file not found: ${sessionFile}, clearing session ID`);
          validSessionId = null;
          this.db.prepare(`UPDATE sessions SET claude_session_id = NULL WHERE id = ?`).run(target.id);
        }
      }

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
        claudeSessionId: validSessionId,
        name: target.name,
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
      name: '默认会话',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, channel, channel_id, project_path, claude_session_id, name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.channel, session.channelId, session.projectPath, null, session.name, 1, session.createdAt, session.updatedAt);

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
    logger.info(`[SessionManager] Updating claude_session_id: sessionId=${sessionId}, claudeSessionId=${claudeSessionId}`);
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
      name: row.name,
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
      name: row.name,
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
      name: row.name,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async getSessionByName(channel: 'feishu' | 'acp', channelId: string, name: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND name = ?
    `).get(channel, channelId, name) as any;

    if (!row) return undefined;

    return {
      id: row.id,
      channel: row.channel,
      channelId: row.channel_id,
      projectPath: row.project_path,
      claudeSessionId: row.claude_session_id,
      name: row.name,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async switchToSession(channel: 'feishu' | 'acp', channelId: string, targetSessionId: string): Promise<Session | null> {
    // 验证目标会话存在
    const target = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ? AND channel = ? AND channel_id = ?
    `).get(targetSessionId, channel, channelId) as any;

    if (!target) return null;

    // 取消当前活跃会话
    this.db.prepare(`
      UPDATE sessions SET is_active = 0, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(Date.now(), channel, channelId);

    // 激活目标会话
    this.db.prepare(`
      UPDATE sessions SET is_active = 1, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), targetSessionId);

    return {
      id: target.id,
      channel: target.channel,
      channelId: target.channel_id,
      projectPath: target.project_path,
      claudeSessionId: target.claude_session_id,
      name: target.name,
      isActive: true,
      createdAt: target.created_at,
      updatedAt: Date.now()
    };
  }

  async renameSession(sessionId: string, newName: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?
    `).run(newName, Date.now(), sessionId);

    return result.changes > 0;
  }

  async createNewSession(channel: 'feishu' | 'acp', channelId: string, projectPath: string, name?: string): Promise<Session> {
    // 取消当前活跃会话
    this.db.prepare(`
      UPDATE sessions SET is_active = 0, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(Date.now(), channel, channelId);

    // 创建新会话
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      name: name || '默认会话',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, channel, channel_id, project_path, claude_session_id, name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.channel, session.channelId, session.projectPath, null, session.name, 1, session.createdAt, session.updatedAt);

    return session;
  }

  async scanCliSessions(projectPath: string): Promise<Array<{ uuid: string; mtime: number }>> {
    const homeDir = os.homedir();
    const encodedPath = this.getProjectDirName(projectPath);
    const sessionDir = path.join(homeDir, '.claude', 'projects', encodedPath);

    if (!fs.existsSync(sessionDir)) return [];

    const files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('agent-'))  // 过滤子代理会话
      .map(f => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        return { uuid: f.replace('.jsonl', ''), mtime: stat.mtimeMs, size: stat.size };
      })
      .filter(f => f.size > 0)  // 过滤空文件
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10);

    return files.map(f => ({ uuid: f.uuid, mtime: f.mtime }));
  }

  checkSessionFileExists(projectPath: string, claudeSessionId: string): boolean {
    const sessionFile = this.getSessionFilePath(projectPath, claudeSessionId);
    return fs.existsSync(sessionFile);
  }

  readSessionFirstMessage(projectPath: string, claudeSessionId: string): string | null {
    const sessionFile = this.getSessionFilePath(projectPath, claudeSessionId);
    if (!fs.existsSync(sessionFile)) return null;

    try {
      const content = fs.readFileSync(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const event = JSON.parse(line);

        // 格式: {type: "user", message: {role: "user", content: ...}}
        if (event.type === 'user' && event.message?.role === 'user') {
          const messageContent = event.message.content;

          // content 可能是字符串或数组
          if (typeof messageContent === 'string') {
            const text = messageContent.trim();
            return text.substring(0, 50) + (text.length > 50 ? '...' : '');
          } else if (Array.isArray(messageContent)) {
            const textContent = messageContent.find((c: any) => c.type === 'text');
            if (textContent?.text) {
              const text = textContent.text.trim();
              return text.substring(0, 50) + (text.length > 50 ? '...' : '');
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`Failed to read session file: ${sessionFile}`, error);
    }
    return null;
  }

  async getSessionByUuidPrefix(channel: 'feishu' | 'acp', channelId: string, uuidPrefix: string): Promise<Session | undefined> {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND claude_session_id LIKE ?
    `).all(channel, channelId, `${uuidPrefix}%`) as any[];

    if (rows.length === 0) return undefined;
    if (rows.length > 1) {
      logger.warn(`Multiple sessions found with UUID prefix: ${uuidPrefix}`);
    }

    const row = rows[0];
    return {
      id: row.id,
      channel: row.channel,
      channelId: row.channel_id,
      projectPath: row.project_path,
      claudeSessionId: row.claude_session_id,
      name: row.name,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async importCliSession(channel: 'feishu' | 'acp', channelId: string, projectPath: string, claudeSessionId: string): Promise<Session> {
    // 检查是否已存在相同项目路径的会话
    const existingByPath = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ?
    `).get(channel, channelId, projectPath) as any;

    if (existingByPath) {
      // 更新 claude_session_id 并激活
      this.db.prepare(`
        UPDATE sessions SET is_active = 0, updated_at = ?
        WHERE channel = ? AND channel_id = ? AND is_active = 1 AND id != ?
      `).run(Date.now(), channel, channelId, existingByPath.id);

      this.db.prepare(`
        UPDATE sessions SET claude_session_id = ?, is_active = 1, updated_at = ?
        WHERE id = ?
      `).run(claudeSessionId, Date.now(), existingByPath.id);

      return {
        id: existingByPath.id,
        channel: existingByPath.channel,
        channelId: existingByPath.channel_id,
        projectPath: existingByPath.project_path,
        claudeSessionId,
        name: existingByPath.name,
        isActive: true,
        createdAt: existingByPath.created_at,
        updatedAt: Date.now()
      };
    }

    // 取消当前活跃会话
    this.db.prepare(`
      UPDATE sessions SET is_active = 0, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(Date.now(), channel, channelId);

    // 创建会话记录
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      claudeSessionId,
      name: `CLI会话-${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, channel, channel_id, project_path, claude_session_id, name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.channel, session.channelId, session.projectPath, session.claudeSessionId, session.name, 1, session.createdAt, session.updatedAt);

    return session;
  }

  // ==================== 健康状态管理 ====================

  /**
   * 获取会话健康状态
   */
  async getHealthStatus(sessionId: string): Promise<{
    consecutiveErrors: number;
    lastError?: string;
    lastErrorType?: string;
    safeMode: boolean;
    lastSuccessTime: number;
  }> {
    const row = this.db.prepare(`
      SELECT * FROM session_health WHERE session_id = ?
    `).get(sessionId) as any;

    if (!row) {
      // 首次查询，创建默认记录
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO session_health (session_id, consecutive_errors, safe_mode, last_success_time, created_at, updated_at)
        VALUES (?, 0, 0, ?, ?, ?)
      `).run(sessionId, now, now, now);

      return {
        consecutiveErrors: 0,
        safeMode: false,
        lastSuccessTime: now
      };
    }

    return {
      consecutiveErrors: row.consecutive_errors,
      lastError: row.last_error,
      lastErrorType: row.last_error_type,
      safeMode: row.safe_mode === 1,
      lastSuccessTime: row.last_success_time
    };
  }

  /**
   * 记录成功响应（重置错误计数）
   */
  async recordSuccess(sessionId: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO session_health (session_id, consecutive_errors, safe_mode, last_success_time, created_at, updated_at)
      VALUES (?, 0, 0, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        consecutive_errors = 0,
        last_success_time = ?,
        updated_at = ?
    `).run(sessionId, now, now, now, now, now);
  }

  /**
   * 记录错误（增加计数）
   */
  async recordError(sessionId: string, errorType: string, errorMessage: string): Promise<void> {
    const now = Date.now();
    const health = await this.getHealthStatus(sessionId);

    this.db.prepare(`
      INSERT INTO session_health (session_id, consecutive_errors, last_error, last_error_type, safe_mode, last_success_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        consecutive_errors = consecutive_errors + 1,
        last_error = ?,
        last_error_type = ?,
        updated_at = ?
    `).run(sessionId, health.consecutiveErrors + 1, errorMessage, errorType, health.safeMode ? 1 : 0, health.lastSuccessTime, now, now, errorMessage, errorType, now);
  }

  /**
   * 设置安全模式
   */
  async setSafeMode(sessionId: string, enabled: boolean): Promise<void> {
    const now = Date.now();
    const health = await this.getHealthStatus(sessionId);

    this.db.prepare(`
      INSERT INTO session_health (session_id, consecutive_errors, safe_mode, last_success_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        safe_mode = ?,
        updated_at = ?
    `).run(sessionId, health.consecutiveErrors, enabled ? 1 : 0, health.lastSuccessTime, now, now, enabled ? 1 : 0, now);
  }

  /**
   * 重置健康状态（用于修复后）
   */
  async resetHealthStatus(sessionId: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO session_health (session_id, consecutive_errors, safe_mode, last_success_time, created_at, updated_at)
      VALUES (?, 0, 0, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        consecutive_errors = 0,
        last_error = NULL,
        last_error_type = NULL,
        safe_mode = 0,
        updated_at = ?
    `).run(sessionId, now, now, now, now);
  }

  close(): void {
    this.db.close();
  }
}
