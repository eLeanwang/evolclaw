import { DatabaseSync } from 'node:sqlite';
import { Session, SessionIdentity } from '../types.js';
import { ensureDir } from '../config.js';
import { resolvePaths } from '../paths.js';
import { logger } from '../utils/logger.js';
import { encodePath } from '../utils/cross-platform.js';
import { EventBus } from './event-bus.js';
import type { SessionFileAdapter, SessionFileInfo, CliSessionEntry, SdkSessionEntry } from './session-file-adapter.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

/** 判定用户是否为指定渠道的 owner */
export type OwnerResolver = (channel: string, userId: string) => boolean;

export class SessionManager {
  private db: DatabaseSync;
  private eventBus: EventBus;
  private ownerResolver?: OwnerResolver;
  private fileAdapters = new Map<string, SessionFileAdapter>();

  constructor(dbPath: string = resolvePaths().db, eventBus: EventBus, ownerResolver?: OwnerResolver) {
    ensureDir(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.eventBus = eventBus;
    this.ownerResolver = ownerResolver;
    this.initDatabase();
  }

  setOwnerResolver(resolver: OwnerResolver): void {
    this.ownerResolver = resolver;
  }

  registerFileAdapter(adapter: SessionFileAdapter): void {
    this.fileAdapters.set(adapter.agentId, adapter);
    logger.debug(`[SessionManager] Registered file adapter: ${adapter.agentId}`);
  }

  private getFileAdapter(agentId: string): SessionFileAdapter | undefined {
    return this.fileAdapters.get(agentId);
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
    const metadata = row.metadata ? JSON.parse(row.metadata) : undefined;
    return {
      id: row.id,
      channel: row.channel,
      channelId: row.channel_id,
      projectPath: row.project_path,
      threadId: row.thread_id || '',
      agentId: row.agent_id || 'claude',
      chatType: row.chat_type || 'private',
      sessionMode: row.session_mode || 'interactive',
      agentSessionId: row.agent_session_id,
      metadata,
      name: row.name,
      processingState: row.processing_state || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at ?? undefined,
    };
  }

  /** 根据 userId 计算身份 */
  resolveIdentity(channel: string, userId?: string): SessionIdentity {
    if (!userId) return { role: 'anonymous', mode: 'interactive' };
    const isOwner = this.ownerResolver?.(channel, userId) ?? false;
    return { role: isOwner ? 'owner' : 'guest', mode: 'interactive' };
  }

  /** 更新 session 的 identity（owner 绑定后调用） */
  async updateIdentity(sessionId: string, identity: SessionIdentity): Promise<void> {
    logger.debug(`[SessionManager] updateIdentity: sessionId=${sessionId}, role=${identity.role}`);
  }

  /** 取消所有活跃会话（通过 metadata.isActive） */
  private deactivateAllMetadata(channel: string, channelId: string): void {
    const rows = this.db.prepare(`
      SELECT id, metadata FROM sessions
      WHERE channel = ? AND channel_id = ? AND json_extract(metadata, '$.isActive') = true
    `).all(channel, channelId) as any[];

    for (const row of rows) {
      const metadata = row.metadata ? JSON.parse(row.metadata) : {};
      metadata.isActive = false;
      this.db.prepare(`
        UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(metadata), Date.now(), row.id);
    }
  }

  private validateSessionFile(row: any): string | undefined {
    const agentSessionId = row.agent_session_id;
    if (!agentSessionId) return undefined;
    const agentId = row.agent_id || 'claude';
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) {
      const sessionFile = this.getSessionFilePath(row.project_path, agentSessionId);
      if (fs.existsSync(sessionFile)) return agentSessionId;
    } else if (adapter.checkExists(row.project_path, agentSessionId)) {
      return agentSessionId;
    }
    // Session file not found - return the ID and let the caller decide
    // Do NOT clear the ID from DB here to allow session resume attempts
    logger.warn(`Session file not found for ${agentId}: ${agentSessionId}`);
    return agentSessionId;
  }

  private insertSession(session: Session): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, channel, channel_id, project_path, thread_id, agent_id, chat_type, session_mode, agent_session_id, name, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.channel,
      session.channelId,
      session.projectPath,
      session.threadId || '',
      session.agentId || 'claude',
      session.chatType || 'private',
      session.sessionMode || 'interactive',
      session.agentSessionId ?? null,
      session.name ?? null,
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
    const hasAgentId = tableInfo.some((col: any) => col.name === 'agent_id');
    const hasAgentSessionId = tableInfo.some((col: any) => col.name === 'agent_session_id');
    const hasMetadata = tableInfo.some((col: any) => col.name === 'metadata');
    const hasIsGroup = tableInfo.some((col: any) => col.name === 'is_group');
    const hasChatType = tableInfo.some((col: any) => col.name === 'chat_type');
    const hasSessionMode = tableInfo.some((col: any) => col.name === 'session_mode');
    const hasDeletedAt = tableInfo.some((col: any) => col.name === 'deleted_at');

    // 检测是否需要 schema 重构迁移（旧字段存在，新字段不存在）
    // 双重保险：同时检查旧字段确实存在（hasIsGroup）AND 新字段缺失，才进行迁移。
    // 避免误触发导致 INSERT INTO ... SELECT ... FROM sessions 时报错 "no such column"
    const needsSchemaRefactor = tableInfo.length > 0 && hasIsGroup && (!hasChatType || !hasAgentId || !hasSessionMode);

    // Schema 重构迁移：is_group → chat_type, agent_type → agent_id, 移除 is_active
    if (needsSchemaRefactor) {
      logger.info('[SessionManager] Running schema refactor migration...');
      this.db.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE IF NOT EXISTS sessions_new (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          project_path TEXT NOT NULL,
          thread_id TEXT DEFAULT '',
          agent_id TEXT DEFAULT 'claude',
          chat_type TEXT DEFAULT 'private',
          session_mode TEXT DEFAULT 'interactive',
          agent_session_id TEXT,
          name TEXT,
          processing_state TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER,
          metadata TEXT
        );
        INSERT INTO sessions_new (id, channel, channel_id, project_path, thread_id, agent_id, chat_type, session_mode, agent_session_id, name, processing_state, created_at, updated_at, deleted_at, metadata)
        SELECT id, channel, channel_id, project_path, thread_id, agent_type, is_group, 'interactive', agent_session_id, name, processing_state, created_at, updated_at, deleted_at, metadata
        FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        COMMIT;
      `);
      logger.info('[SessionManager] Schema refactor complete');
    }

    // 确保新 schema 完整
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        thread_id TEXT DEFAULT '',
        agent_id TEXT DEFAULT 'claude',
        chat_type TEXT DEFAULT 'private',
        session_mode TEXT DEFAULT 'interactive',
        agent_session_id TEXT,
        name TEXT,
        processing_state TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        metadata TEXT
      )
    `);

    // 可选索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel, channel_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, agent_session_id);
    `);
  }
