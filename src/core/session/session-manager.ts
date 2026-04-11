import { DatabaseSync } from 'node:sqlite';
import { Session, SessionIdentity } from '../../types.js';
import { ensureDir } from '../../config.js';
import { resolvePaths } from '../../paths.js';
import { logger } from '../../utils/logger.js';
import { encodePath } from '../../utils/cross-platform.js';
import { EventBus } from '../event-bus.js';
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
    // identity 不持久化到 DB，仅更新内存中的返回值
    // 调用方应直接修改持有的 session 对象
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
      // 无适配器：无法验证文件，信任 DB 记录
      return agentSessionId;
    }
    if (adapter.checkExists(row.project_path, agentSessionId)) {
      return agentSessionId;
    }
    logger.warn(`Session file not found for ${agentId}: ${agentSessionId}, clearing session ID`);
    this.db.prepare(`UPDATE sessions SET agent_session_id = NULL WHERE id = ?`).run(row.id);
    return undefined;
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
    const needsSchemaRefactor = tableInfo.length > 0 && (hasIsGroup || hasIsActive || hasAgentType) && (!hasChatType || !hasAgentId || !hasSessionMode);

    // Schema 重构迁移：is_group → chat_type, agent_type → agent_id, 移除 is_active
    if (needsSchemaRefactor) {
      logger.info('Migrating database schema (session model refactor)...');
      this.db.exec(`DROP TABLE IF EXISTS sessions_new`);
      this.db.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT 'claude',
          thread_id TEXT NOT NULL DEFAULT '',
          chat_type TEXT NOT NULL DEFAULT 'private',
          session_mode TEXT NOT NULL DEFAULT 'interactive',
          project_path TEXT NOT NULL,
          agent_session_id TEXT,
          name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          metadata TEXT,
          deleted_at INTEGER
        )
      `);

      // 迁移数据：is_group → chat_type, agent_type → agent_id
      this.db.exec(`
        INSERT INTO sessions_new (id, channel, channel_id, agent_id, thread_id, chat_type, session_mode, project_path, agent_session_id, name, created_at, updated_at, metadata, deleted_at)
        SELECT
          id,
          channel,
          channel_id,
          COALESCE(agent_type, 'claude'),
          COALESCE(thread_id, ''),
          CASE WHEN is_group = 1 THEN 'group' ELSE 'private' END,
          'interactive',
          project_path,
          agent_session_id,
          name,
          created_at,
          updated_at,
          metadata,
          deleted_at
        FROM sessions
      `);

      this.db.exec(`DROP TABLE sessions`);
      this.db.exec(`ALTER TABLE sessions_new RENAME TO sessions`);

      // 创建新索引
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_space
          ON sessions(channel, channel_id, agent_id, thread_id)
          WHERE deleted_at IS NULL
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_session_active
          ON sessions(channel, channel_id)
          WHERE deleted_at IS NULL
      `);

      logger.info('✓ Database migration completed (session model refactored)');
    }

    // ── 旧 schema 迁移（仅当旧字段存在、新字段还未迁移时运行）──
    // 这些迁移按顺序将最旧的 schema 逐步升级到包含 is_group 的中间格式，
    // 然后由上面的 needsSchemaRefactor 迁移一步到位转为新 schema。
    if (!needsSchemaRefactor && tableInfo.length > 0 && hasAgentType) {
      // 检查是否有唯一约束
      const indexes = this.db.prepare('PRAGMA index_list(sessions)').all() as any[];
      const hasUniqueConstraint = indexes.some((idx: any) => idx.origin === 'u');

      // 迁移到新表结构（添加 thread_id, agent_type, agent_session_id, metadata）
      if (!hasThreadId) {
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

      // Migration: add is_group column
      if (!hasIsGroup) {
        logger.info('Migrating database schema (adding is_group)...');
        const addIsGroupCol = 'ALTER TABLE sessions ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0';
        this.db.exec(addIsGroupCol);
        logger.info('✓ Database migration completed (is_group added)');
      }

      // Reset incorrect is_group values (oc_ prefix doesn't reliably indicate group chat)
      if (hasIsGroup) {
        this.db.exec("UPDATE sessions SET is_group = 0 WHERE channel = 'feishu'");
      }

      // Migration: add deleted_at column
      if (!hasDeletedAt) {
        logger.info('Migrating database schema (adding deleted_at)...');
        this.db.exec(`ALTER TABLE sessions ADD COLUMN deleted_at INTEGER`);
        logger.info('✓ Database migration completed (deleted_at added)');
      }
    }

    // Migration: add processing_state column (独立于 schema 重构)
    if (tableInfo.length > 0) {
      const hasProcessingState = tableInfo.some((col: any) => col.name === 'processing_state');
      if (!hasProcessingState) {
        logger.info('Migrating database schema (adding processing_state)...');
        this.db.exec(`ALTER TABLE sessions ADD COLUMN processing_state TEXT`);
        logger.info('✓ Database migration completed (processing_state added)');
      }
    }

    // Migration: normalize legacy metadata rootId → replyContext
    if (hasMetadata && tableInfo.length > 0) {
      const rows = this.db.prepare(
        `SELECT id, metadata FROM sessions WHERE metadata IS NOT NULL AND metadata != ''`
      ).all() as { id: string; metadata: string }[];
      let migrated = 0;
      for (const row of rows) {
        try {
          const meta = JSON.parse(row.metadata);
          const rootId = meta.feishu?.rootId ?? meta.threadRootId ?? meta.replyOpts?.rootId;
          if (!rootId && !meta.feishu && !meta.threadRootId && !meta.replyOpts) continue;
          // Generate replyContext from rootId if missing
          if (rootId && !meta.replyContext) {
            meta.replyContext = { replyToMessageId: rootId, replyInThread: true };
          }
          // Clean up all legacy fields
          delete meta.feishu;
          delete meta.threadRootId;
          delete meta.replyOpts;
          this.db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
            .run(JSON.stringify(meta), row.id);
          migrated++;
        } catch { /* skip malformed JSON */ }
      }
      if (migrated > 0) {
        logger.info(`✓ Migrated ${migrated} session(s): rootId normalized to replyContext`);
      }
    }

    // 创建新表（首次初始化）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'claude',
        thread_id TEXT NOT NULL DEFAULT '',
        chat_type TEXT NOT NULL DEFAULT 'private',
        session_mode TEXT NOT NULL DEFAULT 'interactive',
        project_path TEXT NOT NULL,
        agent_session_id TEXT,
        name TEXT,
        processing_state TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT,
        deleted_at INTEGER
      )
    `);
    // 会话空间索引（查询优化，无唯一约束）
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_space
        ON sessions(channel, channel_id, agent_id, thread_id)
        WHERE deleted_at IS NULL
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_session_active
        ON sessions(channel, channel_id)
        WHERE deleted_at IS NULL
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

  /**
   * 启动时迁移：将 sessions.channel 列中的旧实例名回填为 channelType。
   * @param instanceToType 实例名 → channelType 映射表（外部构建）
   */
  migrateChannelNames(instanceToType: Map<string, string>): void {
    if (instanceToType.size === 0) return;

    let migrated = 0;
    for (const [instanceName, channelType] of instanceToType) {
      if (instanceName === channelType) continue;
      const result = this.db.prepare(
        `UPDATE sessions SET channel = ? WHERE channel = ?`
      ).run(channelType, instanceName);
      const changes = (result as any).changes ?? 0;
      if (changes > 0) {
        migrated += changes;
        logger.info(`[Migration] Renamed channel '${instanceName}' -> '${channelType}' (${changes} sessions)`);
      }
    }
    if (migrated > 0) {
      logger.info(`Channel name migration completed (${migrated} sessions updated)`);
    }
  }

  /**
   * 获取指定渠道所有已知的 thread_id（用于重启后预填充 seenThreads）
   */
  getKnownThreadIds(channel: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT thread_id FROM sessions
      WHERE channel = ? AND thread_id != '' AND deleted_at IS NULL
    `).all(channel) as any[];
    return rows.map(r => r.thread_id);
  }

  /**
   * 标记会话为处理中（实时写 DB，crash 也能恢复）
   */
  markProcessing(sessionId: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE sessions SET processing_state = ?, updated_at = ? WHERE id = ?`)
      .run(String(now), now, sessionId);
  }

  /**
   * 清除会话处理中状态
   */
  clearProcessing(sessionId: string): void {
    this.db.prepare(`UPDATE sessions SET processing_state = NULL, updated_at = ? WHERE id = ?`)
      .run(Date.now(), sessionId);
  }

  /**
   * 获取所有处于 processing 状态的会话（用于重启后恢复）
   * @param maxAgeMs 最大存活时间（超过则视为超时，清除状态）默认 1 小时
   */
  getPendingProcessingSessions(maxAgeMs: number = 60 * 60 * 1000): Session[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE processing_state IS NOT NULL AND deleted_at IS NULL
    `).all() as any[];

    const now = Date.now();
    const result: Session[] = [];
    for (const row of rows) {
      const ts = parseInt(row.processing_state, 10);
      if (!isNaN(ts) && (now - ts) < maxAgeMs) {
        result.push(this.rowToSession(row));
      } else {
        // 超时：清除过期状态
        this.db.prepare(`UPDATE sessions SET processing_state = NULL WHERE id = ?`)
          .run(row.id);
      }
    }
    return result;
  }

  async getOrCreateSession(
    channel: string,
    channelId: string,
    defaultProjectPath: string,
    threadId?: string,
    metadata?: any,
    name?: string,
    userId?: string,
    chatType?: 'private' | 'group',
    agentId?: string
  ): Promise<Session> {
    // 话题会话：独立查找/创建
    if (threadId) {
      const session = this.getOrCreateThreadSession(channel, channelId, threadId, defaultProjectPath, metadata, name, agentId);
      session.identity = this.resolveIdentity(channel, userId);
      return session;
    }

    // 主会话：查找活跃会话
    const active = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND json_extract(metadata, '$.isActive') = true AND thread_id = '' AND deleted_at IS NULL
    `).get(channel, channelId) as any;

    if (active) {
      const validSessionId = this.validateSessionFile(active);
      const session = { ...this.rowToSession(active), agentSessionId: validSessionId };
      session.identity = this.resolveIdentity(channel, userId);
      // 补写 peerId/peerName/channelName（旧 session 可能在这些字段引入前创建）
      if (chatType === 'private' && userId) {
        const activeMeta = active.metadata ? JSON.parse(active.metadata) : {};
        let updated = false;
        if (!activeMeta.peerId) { activeMeta.peerId = userId; updated = true; }
        if (!activeMeta.peerName && metadata?.peerName) { activeMeta.peerName = metadata.peerName; updated = true; }
        if (metadata?.channelName && activeMeta.channelName !== metadata.channelName) { activeMeta.channelName = metadata.channelName; updated = true; }
        if (updated) {
          this.db.prepare(`UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(activeMeta), Date.now(), active.id);
          session.metadata = activeMeta;
        }
      }
      // 补写 channelName（非私聊时也需要）
      if (metadata?.channelName && chatType !== 'private') {
        const activeMeta = active.metadata ? JSON.parse(active.metadata) : {};
        if (activeMeta.channelName !== metadata.channelName) {
          activeMeta.channelName = metadata.channelName;
          this.db.prepare(`UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(activeMeta), Date.now(), active.id);
          session.metadata = activeMeta;
        }
      }
      return session;
    }

    // 查找默认项目的主会话
    const existing = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ? AND thread_id = '' AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(channel, channelId, defaultProjectPath) as any;

    if (existing) {
      const validSessionId = this.validateSessionFile(existing);
      // 激活此会话
      const existingMeta = existing.metadata ? JSON.parse(existing.metadata) : {};
      existingMeta.isActive = true;
      // 补写 peerId/peerName
      if (chatType === 'private' && userId && !existingMeta.peerId) {
        existingMeta.peerId = userId;
      }
      if (chatType === 'private' && metadata?.peerName && !existingMeta.peerName) {
        existingMeta.peerName = metadata.peerName;
      }
      this.db.prepare(`UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(existingMeta), Date.now(), existing.id);
      const session = { ...this.rowToSession(existing), agentSessionId: validSessionId, metadata: existingMeta };
      session.identity = this.resolveIdentity(channel, userId);
      return session;
    }

    // 创建新主会话
    const sessionMetadata = { ...metadata, isActive: true };
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath: defaultProjectPath,
      threadId: '',
      agentId: agentId || 'claude',
      chatType: chatType || 'private',
      sessionMode: 'interactive',
      metadata: sessionMetadata,
      name: name || '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    session.identity = this.resolveIdentity(channel, userId);

    this.insertSession(session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath: defaultProjectPath,
      name: session.name,
      chatType: session.chatType,
      timestamp: Date.now()
    });
    return session;
  }

  async updateSession(sessionId: string, updates: Partial<Pick<Session, 'chatType' | 'name' | 'metadata'>>): Promise<void> {
    const sets: string[] = [];
    const values: any[] = [];
    if (updates.chatType !== undefined) {
      sets.push('chat_type = ?');
      values.push(updates.chatType);
    }
    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name);
    }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(sessionId);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  private getOrCreateThreadSession(
    channel: string,
    channelId: string,
    threadId: string,
    defaultProjectPath: string,
    metadata?: any,
    name?: string,
    agentId?: string
  ): Session {
    // 查找已有话题会话
    const existing = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND thread_id = ? AND deleted_at IS NULL
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
      WHERE channel = ? AND channel_id = ? AND json_extract(metadata, '$.isActive') = true AND thread_id = ''
    `).get(channel, channelId) as any;

    const projectPath = activeMain?.project_path || defaultProjectPath;

    // 创建新话题会话
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      threadId,
      agentId: agentId || 'claude',
      chatType: 'private',
      sessionMode: 'interactive',
      metadata,
      name: name || '话题会话',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath,
      name: session.name,
      timestamp: Date.now()
    });
    return session;
  }

  async switchProject(channel: string, channelId: string, newProjectPath: string, currentAgentId?: string): Promise<Session> {
    const agentId = currentAgentId || 'claude';
    // 1. 取消当前活跃会话
    this.deactivateAllMetadata(channel, channelId);

    // 2. 查找目标项目 + 当前 agent 的会话
    const target = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ? AND agent_id = ? AND thread_id = '' AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(channel, channelId, newProjectPath, agentId) as any;

    if (target) {
      const validSessionId = this.validateSessionFile(target);
      // 激活目标会话
      const metadata = target.metadata ? JSON.parse(target.metadata) : {};
      metadata.isActive = true;
      this.db.prepare(`UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(metadata), Date.now(), target.id);
      return { ...this.rowToSession(target), agentSessionId: validSessionId, metadata };
    }

    // 3. 创建新会话
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath: newProjectPath,
      threadId: '',
      agentId,
      chatType: 'private',
      sessionMode: 'interactive',
      metadata: { isActive: true },
      name: '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath: newProjectPath,
      name: session.name,
      timestamp: Date.now()
    });

    return session;
  }

  async updateAgentSessionId(channel: string, channelId: string, agentSessionId: string): Promise<void> {
    // 只更新当前活跃会话的 Agent Session ID
    this.db.prepare(`
      UPDATE sessions
      SET agent_session_id = ?, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND json_extract(metadata, '$.isActive') = true
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

  async switchAgent(channel: string, channelId: string, projectPath: string, newAgentId: string): Promise<Session> {
    // 1. 取消当前活跃会话
    this.deactivateAllMetadata(channel, channelId);

    // 2. 查找目标 agent 在当前项目下的会话
    const target = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ? AND agent_id = ? AND thread_id = '' AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(channel, channelId, projectPath, newAgentId) as any;

    if (target) {
      const validSessionId = this.validateSessionFile(target);
      // 激活目标会话
      const metadata = target.metadata ? JSON.parse(target.metadata) : {};
      metadata.isActive = true;
      this.db.prepare(`UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(metadata), Date.now(), target.id);
      return { ...this.rowToSession(target), agentSessionId: validSessionId, metadata };
    }

    // 3. 创建新会话（与 switchProject 保持一致）
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      threadId: '',
      agentId: newAgentId,
      chatType: 'private',
      sessionMode: 'interactive',
      metadata: { isActive: true },
      name: '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath,
      name: session.name,
      timestamp: Date.now()
    });

    return session;
  }

  async clearActiveSession(channel: string, channelId: string): Promise<void> {
    // 清除当前活跃会话的 Agent Session ID
    this.db.prepare(`
      UPDATE sessions
      SET agent_session_id = NULL, updated_at = ?
      WHERE channel = ? AND channel_id = ? AND json_extract(metadata, '$.isActive') = true
    `).run(Date.now(), channel, channelId);
  }

  /** 查找 owner 在目标通道的私聊 channelId（用于跨通道文件投递） */
  getOwnerChatId(targetChannel: string, ownerPeerId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT channel_id FROM sessions
      WHERE channel = ? AND chat_type = 'private'
        AND json_extract(metadata, '$.peerId') = ?
        AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(targetChannel, ownerPeerId) as any;
    return row?.channel_id;
  }

  async getActiveSession(channel: string, channelId: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND json_extract(metadata, '$.isActive') = true AND deleted_at IS NULL
    `).get(channel, channelId) as any;

    if (!row) return undefined;
    return this.rowToSession(row);
  }

  /**
   * 查询话题会话（不创建）
   */
  async getThreadSession(channel: string, channelId: string, threadId: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND thread_id = ? AND deleted_at IS NULL
    `).get(channel, channelId, threadId) as any;

    if (!row) return undefined;
    const validSessionId = this.validateSessionFile(row);
    return { ...this.rowToSession(row), agentSessionId: validSessionId };
  }

  async listSessions(channel: string, channelId: string): Promise<Session[]> {
    // 列出该聊天的所有会话
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).all(channel, channelId) as any[];

    return rows.map(row => this.rowToSession(row));
  }

  async getSessionByProjectPath(channel: string, channelId: string, projectPath: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND project_path = ? AND deleted_at IS NULL
      ORDER BY processing_state IS NOT NULL DESC, updated_at DESC
      LIMIT 1
    `).get(channel, channelId, projectPath) as any;

    if (!row) return undefined;
    return this.rowToSession(row);
  }

  async getSessionByName(channel: string, channelId: string, name: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND name = ? AND deleted_at IS NULL
    `).get(channel, channelId, name) as any;

    if (!row) return undefined;
    return this.rowToSession(row);
  }

  async switchToSession(channel: string, channelId: string, targetSessionId: string): Promise<Session | null> {
    // 验证目标会话存在
    const target = this.db.prepare(`
      SELECT * FROM sessions WHERE id = ? AND channel = ? AND channel_id = ? AND deleted_at IS NULL
    `).get(targetSessionId, channel, channelId) as any;

    if (!target) return null;

    // 取消当前活跃会话
    this.deactivateAllMetadata(channel, channelId);

    // 激活目标会话
    const metadata = target.metadata ? JSON.parse(target.metadata) : {};
    metadata.isActive = true;
    this.db.prepare(`UPDATE sessions SET metadata = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(metadata), Date.now(), targetSessionId);

    return { ...this.rowToSession(target), metadata, updatedAt: Date.now() };
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

  async softDeleteSession(channelId: string): Promise<void> {
    this.db.prepare(`
      UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE channel_id = ? AND deleted_at IS NULL
    `).run(Date.now(), Date.now(), channelId);
  }

  async createNewSession(channel: string, channelId: string, projectPath: string, name?: string, agentId?: string): Promise<Session> {
    // 取消当前活跃会话
    this.deactivateAllMetadata(channel, channelId);

    // 创建新会话
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      threadId: '',
      agentId: agentId || 'claude',
      chatType: 'private',
      sessionMode: 'interactive',
      metadata: { isActive: true },
      name: name || '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath,
      name: session.name,
      timestamp: Date.now()
    });

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
    this.deactivateAllMetadata(sourceSession.channel, sourceSession.channelId);

    const session: Session = {
      id: `${sourceSession.channel}-${sourceSession.channelId}-${Date.now()}`,
      channel: sourceSession.channel,
      channelId: sourceSession.channelId,
      projectPath: sourceSession.projectPath,
      threadId: sourceSession.threadId || '',
      agentId: sourceSession.agentId || 'claude',
      chatType: sourceSession.chatType || 'private',
      sessionMode: sourceSession.sessionMode || 'interactive',
      agentSessionId: forkedAgentSessionId,
      metadata: { isActive: true },
      name: name || `${sourceSession.name || '会话'}-分支`,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel: sourceSession.channel,
      channelId: sourceSession.channelId,
      projectPath: sourceSession.projectPath,
      name: session.name,
      timestamp: Date.now()
    });

    return session;
  }

  async scanCliSessions(projectPath: string, agentId: string): Promise<CliSessionEntry[]> {
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) return [];
    return adapter.scanCliSessions(projectPath);
  }

  checkSessionFileExists(projectPath: string, agentSessionId: string, agentId: string): boolean {
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) return false;
    return adapter.checkExists(projectPath, agentSessionId);
  }

  readSessionFirstMessage(projectPath: string, agentSessionId: string, agentId: string): string | null {
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) return null;
    return adapter.readFirstMessage(projectPath, agentSessionId);
  }

  readSessionLastUserMessage(projectPath: string, agentSessionId: string, agentId: string): string | null {
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) return null;
    return adapter.readLastUserMessage(projectPath, agentSessionId);
  }

  /**
   * 获取会话文件信息（回合数 + 标题）
   */
  getSessionFileInfo(projectPath: string, agentSessionId: string, agentId: string): SessionFileInfo {
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) return { turns: 0 };
    return adapter.getFileInfo(projectPath, agentSessionId);
  }

  /**
   * 列出 SDK 侧的会话列表（用于名称同步）
   */
  async listSdkSessions(projectPath: string, agentId: string): Promise<SdkSessionEntry[]> {
    const adapter = this.getFileAdapter(agentId);
    if (!adapter?.listSdkSessions) return [];
    return adapter.listSdkSessions(projectPath);
  }

  async getSessionByUuidPrefix(channel: string, channelId: string, uuidPrefix: string): Promise<Session | undefined> {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE channel = ? AND channel_id = ? AND agent_session_id LIKE ? AND deleted_at IS NULL
    `).all(channel, channelId, `${uuidPrefix}%`) as any[];

    if (rows.length === 0) return undefined;
    if (rows.length > 1) {
      logger.warn(`Multiple sessions found with UUID prefix: ${uuidPrefix}`);
    }

    return this.rowToSession(rows[0]);
  }

  async importCliSession(channel: string, channelId: string, projectPath: string, agentSessionId: string, agentId: string = 'claude'): Promise<Session> {
    // 取消当前活跃会话
    this.deactivateAllMetadata(channel, channelId);

    // 从 CLI 会话文件读取标题
    const fileInfo = this.getSessionFileInfo(projectPath, agentSessionId, agentId);
    const name = fileInfo.title || `CLI会话-${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;

    // 创建新会话记录
    const session: Session = {
      id: `${channel}-${channelId}-${Date.now()}`,
      channel,
      channelId,
      projectPath,
      threadId: '',
      agentId,
      chatType: 'private',
      sessionMode: 'interactive',
      agentSessionId,
      metadata: { isActive: true },
      name,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.insertSession(session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath,
      name,
      timestamp: Date.now()
    });

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

  /** 当前处于安全模式的会话数 */
  getSafeModeSessionCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM session_health WHERE safe_mode = 1`).get() as any;
    return row?.count ?? 0;
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
        last_error = NULL,
        last_error_type = NULL,
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
    for (const adapter of this.fileAdapters.values()) adapter.close?.();
    this.db.close();
  }
}
