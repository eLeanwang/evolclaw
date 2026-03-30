import { DatabaseSync } from 'node:sqlite';
import { Session } from '../types.js';
import { ensureDir } from '../config.js';
import { resolvePaths } from '../paths.js';
import { logger } from '../utils/logger.js';
import { encodePath } from '../utils/platform.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

export class SessionManager {
  private db: DatabaseSync;

  constructor(dbPath: string = resolvePaths().db) {
    ensureDir(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.initDatabase();
  }

  getDatabase(): DatabaseSync {
    return this.db;
  }

  private getProjectDirName(projectPath: string): string {
    return encodePath(projectPath);
  }

  private getSessionFilePath(projectPath: string, sessionId: string): string {
    const homeDir = os.homedir();
    const encodedPath = this.getProjectDirName(projectPath);
    return path.join(homeDir, '.claude', 'projects', encodedPath, `${sessionId}.jsonl`);
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      channel: row.channel,
      channelId: row.channel_id,
      projectPath: row.project_path,
      threadId: row.thread_id || '',
      agentType: row.agent_type || 'claude',
      agentSessionId: row.agent_session_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      name: row.name,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private deactivateAll(channel: string, channelId: string): void {
    this.db.prepare(`
      UPDATE sessions SET is_active = 0, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(Date.now(), channel, channelId);
  }

  private validateSessionFile(row: any): string | undefined {
    const agentSessionId = row.agent_session_id;
    if (!agentSessionId) return undefined;
    const sessionFile = this.getSessionFilePath(row.project_path, agentSessionId);
    if (fs.existsSync(sessionFile)) return agentSessionId;
    logger.warn(`Session file not found: ${sessionFile}, clearing session ID`);
    this.db.prepare(`UPDATE sessions SET agent_session_id = NULL WHERE id = ?`).run(row.id);
    return undefined;
  }

  private insertSession(session: Session): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, channel, channel_id, project_path, thread_id, agent_type, agent_session_id, name, is_active, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.channel,
      session.channelId,
      session.projectPath,
      session.threadId || '',
      session.agentType || 'claude',
      session.agentSessionId ?? null,
      session.name ?? null,
      session.isActive ? 1 : 0,
      session.createdAt,
      session.updatedAt,
      session.metadata ? JSON.stringify(session.metadata) : null
    );
  }

  private extractUserMessageText(messageContent: any): string | null {
    if (typeof messageContent === 'string') {
      const text = messageContent.trim().replace(/\s+/g, ' ');
      return text.substring(0, 50) + (text.length > 50 ? '...' : '');
    } else if (Array.isArray(messageContent)) {
      const textContent = messageContent.find((c: any) => c.type === 'text');
      if (textContent?.text) {
        const text = textContent.text.trim().replace(/\s+/g, ' ');
        return text.substring(0, 50) + (text.length > 50 ? '...' : '');
      }
    }
    return null;
  }

  private initDatabase(): void {
    const tableInfo = this.db.prepare('PRAGMA table_info(sessions)').all() as any[];
    const hasIsActive = tableInfo.some((col: any) => col.name === 'is_active');
    const hasName = tableInfo.some((col: any) => col.name === 'name');
    const hasThreadId = tableInfo.some((col: any) => col.name === 'thread_id');
    const hasAgentType = tableInfo.some((col: any) => col.name === 'agent_type');
    const hasAgentSessionId = tableInfo.some((col: any) => col.name === 'agent_session_id');
    const hasMetadata = tableInfo.some((col: any) => col.name === 'metadata');

    // 检查是否有唯一约束
    const indexes = this.db.prepare('PRAGMA index_list(sessions)').all() as any[];
    const hasUniqueConstraint = indexes.some((idx: any) => idx.origin === 'u');

    // 迁移到新表结构（添加 thread_id, agent_type, agent_session_id, metadata）
    if (!hasThreadId && tableInfo.length > 0) {
      logger.info('Migrating database schema (adding thread support)...');
      this.db.exec(`DROP TABLE IF EXISTS sessions_new`);
      this.db.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          thread_id TEXT NOT NULL DEFAULT '',
          agent_type TEXT NOT NULL DEFAULT 'claude',
          agent_session_id TEXT,
          name TEXT,
          is_active INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          metadata TEXT
        );
        INSERT INTO sessions_new (id, channel, channel_id, project_path, thread_id, agent_type, agent_session_id, name, is_active, created_at, updated_at, metadata)
          SELECT id, channel, channel_id, project_path, '', 'claude', claude_session_id, name, is_active, created_at, updated_at, NULL FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
      `);
      // 话题会话唯一约束（thread_id 非空时才生效）
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_thread
          ON sessions(channel, channel_id, project_path, thread_id)
          WHERE thread_id != ''
      `);
      logger.info('✓ Database migration completed (thread support added)');
    }

    // 创建新表（首次初始化）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        agent_type TEXT NOT NULL DEFAULT 'claude',
        agent_session_id TEXT,
        name TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);
    // 话题会话唯一约束（thread_id 非空时才生效）
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_thread
        ON sessions(channel, channel_id, project_path, thread_id)
        WHERE thread_id != ''
    `);

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

  async getOrCreateSession(channel: string, channelId: string, defaultProjectPath: string, threadId?: string, metadata?: any, name?: string): Promise<Session> {
    // 话题会话：独立查找/创建，不参与 isActive 竞争
    if (threadId) {
      return this.getOrCreateThreadSession(channel, channelId, threadId, defaultProjectPath, metadata, name);
    }

    // 主会话：查找活跃会话
    const active = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND is_active = 1 AND thread_id = ''
    `).get(channel, channelId) as any;

    if (active) {
      const validSessionId = this.validateSessionFile(active);
      return { ...this.rowToSession(active), agentSessionId: validSessionId };
    }

    // 查找默认项目的主会话
    const existing = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ? AND thread_id = ''
      ORDER BY updated_at DESC LIMIT 1
    `).get(channel, channelId, defaultProjectPath) as any;

    if (existing) {
      const validSessionId = this.validateSessionFile(existing);
      this.db.prepare(`UPDATE sessions SET is_active = 1, updated_at = ? WHERE id = ?`).run(Date.now(), existing.id);
      return { ...this.rowToSession(existing), agentSessionId: validSessionId, isActive: true };
    }

    // 创建新主会话
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath: defaultProjectPath,
      threadId: '',
      agentType: 'claude',
      metadata,
      name: name || '默认会话',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);
    return session;
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    const fields = Object.keys(updates).filter(k => k !== 'id').map(k => `${k} = ?`).join(', ');
    const values = Object.keys(updates).filter(k => k !== 'id').map(k => {
      const v = updates[k as keyof Session];
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'object' && v !== null) return JSON.stringify(v);
      return v;
    });

    this.db.prepare(`UPDATE sessions SET ${fields}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), sessionId);
  }

  private getOrCreateThreadSession(
    channel: string,
    channelId: string,
    threadId: string,
    defaultProjectPath: string,
    metadata?: any,
    name?: string
  ): Session {
    // 查找已有话题会话
    const existing = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND thread_id = ?
    `).get(channel, channelId, threadId) as any;

    if (existing) {
      const validSessionId = this.validateSessionFile(existing);
      // 合并 metadata（如果提供）
      if (metadata) {
        const existingMeta = this.rowToSession(existing).metadata;
        const merged = existingMeta ? { ...existingMeta, ...metadata } : metadata;
        this.db.prepare(`UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(merged), Date.now(), existing.id);
        return { ...this.rowToSession(existing), agentSessionId: validSessionId, metadata: merged };
      }
      return { ...this.rowToSession(existing), agentSessionId: validSessionId };
    }

    // 继承当前活跃主会话的项目路径
    const activeMain = this.db.prepare(`
      SELECT project_path FROM sessions
      WHERE channel = ? AND channel_id = ? AND is_active = 1 AND thread_id = ''
    `).get(channel, channelId) as any;

    const projectPath = activeMain?.project_path || defaultProjectPath;

    // 创建新话题会话（isActive 固定为 false）
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      threadId,
      agentType: 'claude',
      metadata,
      name: name || '话题会话',
      isActive: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);
    return session;
  }

  async switchProject(channel: string, channelId: string, newProjectPath: string): Promise<Session> {
    // 1. 取消当前活跃会话
    this.deactivateAll(channel, channelId);

    // 2. 查找目标项目的会话
    const target = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(channel, channelId, newProjectPath) as any;

    if (target) {
      const validSessionId = this.validateSessionFile(target);

      // 激活已有会话
      this.db.prepare(`
        UPDATE sessions SET is_active = 1, updated_at = ?
        WHERE id = ?
      `).run(Date.now(), target.id);

      return { ...this.rowToSession(target), agentSessionId: validSessionId, isActive: true };
    }

    // 3. 创建新会话
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath: newProjectPath,
      threadId: '',
      agentType: 'claude',
      name: '默认会话',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);

    return session;
  }

  async updateAgentSessionId(channel: string, channelId: string, agentSessionId: string): Promise<void> {
    // 只更新当前活跃会话的 Agent Session ID
    this.db.prepare(`
      UPDATE sessions
      SET agent_session_id = ?, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(agentSessionId, Date.now(), channel, channelId);
  }

  async updateAgentSessionIdBySessionId(sessionId: string, agentSessionId: string): Promise<void> {
    // 根据 sessionId 直接更新
    logger.info(`[SessionManager] Updating agent_session_id: sessionId=${sessionId}, agentSessionId=${agentSessionId}`);
    this.db.prepare(`
      UPDATE sessions
      SET agent_session_id = ?, updated_at = ?
      WHERE id = ?
    `).run(agentSessionId, Date.now(), sessionId);
  }

  async clearActiveSession(channel: string, channelId: string): Promise<void> {
    // 清除当前活跃会话的 Agent Session ID
    this.db.prepare(`
      UPDATE sessions
      SET agent_session_id = NULL, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).run(Date.now(), channel, channelId);
  }

  async getActiveSession(channel: string, channelId: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND is_active = 1
    `).get(channel, channelId) as any;

    if (!row) return undefined;
    return this.rowToSession(row);
  }

  async listSessions(channel: string, channelId: string): Promise<Session[]> {
    // 列出该聊天的所有会话
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ?
      ORDER BY updated_at DESC
    `).all(channel, channelId) as any[];

    return rows.map(row => this.rowToSession(row));
  }

  async getSessionByProjectPath(channel: string, channelId: string, projectPath: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ?
    `).get(channel, channelId, projectPath) as any;

    if (!row) return undefined;
    return this.rowToSession(row);
  }

  async getSessionByName(channel: string, channelId: string, name: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND name = ?
    `).get(channel, channelId, name) as any;

    if (!row) return undefined;
    return this.rowToSession(row);
  }

  async switchToSession(channel: string, channelId: string, targetSessionId: string): Promise<Session | null> {
    // 验证目标会话存在
    const target = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ? AND channel = ? AND channel_id = ?
    `).get(targetSessionId, channel, channelId) as any;

    if (!target) return null;

    // 取消当前活跃会话
    this.deactivateAll(channel, channelId);

    // 激活目标会话
    this.db.prepare(`
      UPDATE sessions SET is_active = 1, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), targetSessionId);

    return { ...this.rowToSession(target), isActive: true, updatedAt: Date.now() };
  }

  async renameSession(sessionId: string, newName: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?
    `).run(newName, Date.now(), sessionId);

    return result.changes > 0;
  }

  async unbindSession(sessionId: string): Promise<boolean> {
    const result = this.db.prepare(`
      DELETE FROM sessions WHERE id = ?
    `).run(sessionId);

    return result.changes > 0;
  }

  async createNewSession(channel: string, channelId: string, projectPath: string, name?: string): Promise<Session> {
    // 取消当前活跃会话
    this.deactivateAll(channel, channelId);

    // 创建新会话
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      threadId: '',
      agentType: 'claude',
      name: name || '默认会话',
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);

    return session;
  }

  /**
   * 基于现有会话创建分支会话
   */
  async createForkedSession(
    sourceSession: Session,
    forkedAgentSessionId: string,
    name?: string
  ): Promise<Session> {
    // 取消当前活跃会话
    this.deactivateAll(sourceSession.channel, sourceSession.channelId);

    const session: Session = {
      id: `${sourceSession.channel}-${sourceSession.channelId}-${Date.now()}`,
      channel: sourceSession.channel,
      channelId: sourceSession.channelId,
      projectPath: sourceSession.projectPath,
      threadId: sourceSession.threadId || '',
      agentType: sourceSession.agentType || 'claude',
      agentSessionId: forkedAgentSessionId,
      name: name || `${sourceSession.name || '会话'}-分支`,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);

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

  checkSessionFileExists(projectPath: string, agentSessionId: string): boolean {
    const sessionFile = this.getSessionFilePath(projectPath, agentSessionId);
    return fs.existsSync(sessionFile);
  }

  readSessionFirstMessage(projectPath: string, agentSessionId: string): string | null {
    const sessionFile = this.getSessionFilePath(projectPath, agentSessionId);
    if (!fs.existsSync(sessionFile)) return null;

    try {
      const content = fs.readFileSync(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'user' && event.message?.role === 'user') {
          const text = this.extractUserMessageText(event.message.content);
          if (text) return text;
        }
      }
    } catch (error) {
      logger.warn(`Failed to read session file: ${sessionFile}`, error);
    }
    return null;
  }

  readSessionLastUserMessage(projectPath: string, agentSessionId: string): string | null {
    const sessionFile = this.getSessionFilePath(projectPath, agentSessionId);
    if (!fs.existsSync(sessionFile)) return null;

    try {
      const content = fs.readFileSync(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let lastMessage: string | null = null;

      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'user' && event.message?.role === 'user') {
          lastMessage = this.extractUserMessageText(event.message.content) ?? lastMessage;
        }
      }
      return lastMessage;
    } catch (error) {
      logger.warn(`Failed to read last message from session file: ${sessionFile}`, error);
    }
    return null;
  }

  /**
   * 获取会话文件信息（回合数 + 标题）
   */
  getSessionFileInfo(projectPath: string, agentSessionId: string): { turns: number; title?: string } {
    const sessionFile = this.getSessionFilePath(projectPath, agentSessionId);
    if (!fs.existsSync(sessionFile)) return { turns: 0 };

    try {
      const content = fs.readFileSync(sessionFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      let turns = 0;
      let title: string | undefined;
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'user' && event.message?.role === 'user') {
          // Only count real user input, skip auto-generated tool_result messages
          const content = event.message.content;
          const isToolResult = Array.isArray(content) && content.every((c: any) => c.type === 'tool_result');
          if (!isToolResult) {
            turns++;
          }
        }
        // 提取会话标题（从 session 元数据中）
        if (event.title && !title) {
          title = event.title;
        }
        if (event.sessionTitle && !title) {
          title = event.sessionTitle;
        }
      }
      return { turns, title };
    } catch (error) {
      logger.warn(`Failed to read session file info: ${sessionFile}`, error);
      return { turns: 0 };
    }
  }

  async getSessionByUuidPrefix(channel: string, channelId: string, uuidPrefix: string): Promise<Session | undefined> {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND agent_session_id LIKE ?
    `).all(channel, channelId, `${uuidPrefix}%`) as any[];

    if (rows.length === 0) return undefined;
    if (rows.length > 1) {
      logger.warn(`Multiple sessions found with UUID prefix: ${uuidPrefix}`);
    }

    return this.rowToSession(rows[0]);
  }

  async importCliSession(channel: string, channelId: string, projectPath: string, agentSessionId: string): Promise<Session> {
    // 检查是否已存在相同项目路径的会话
    const existingByPath = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ?
    `).get(channel, channelId, projectPath) as any;

    if (existingByPath) {
      // 更新 agent_session_id 并激活
      this.db.prepare(`
        UPDATE sessions SET is_active = 0, updated_at = ?
        WHERE channel = ? AND channel_id = ? AND is_active = 1 AND id != ?
      `).run(Date.now(), channel, channelId, existingByPath.id);

      this.db.prepare(`
        UPDATE sessions SET agent_session_id = ?, is_active = 1, updated_at = ?
        WHERE id = ?
      `).run(agentSessionId, Date.now(), existingByPath.id);

      return { ...this.rowToSession(existingByPath), agentSessionId, isActive: true, updatedAt: Date.now() };
    }

    // 取消当前活跃会话
    this.deactivateAll(channel, channelId);

    // 创建会话记录
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      threadId: '',
      agentType: 'claude',
      agentSessionId,
      name: `CLI会话-${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
      isActive: true,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);

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
  async recordError(sessionId: string, errorType: string, errorMessage: string): Promise<number> {
    const now = Date.now();
    const health = await this.getHealthStatus(sessionId);
    const newCount = health.consecutiveErrors + 1;

    this.db.prepare(`
      INSERT INTO session_health (session_id, consecutive_errors, last_error, last_error_type, safe_mode, last_success_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        consecutive_errors = consecutive_errors + 1,
        last_error = ?,
        last_error_type = ?,
        updated_at = ?
    `).run(sessionId, newCount, errorMessage, errorType, health.safeMode ? 1 : 0, health.lastSuccessTime, now, now, errorMessage, errorType, now);

    return newCount;
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
