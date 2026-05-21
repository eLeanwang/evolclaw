import { Session, SessionIdentity, DEFAULT_PERMISSION_MODE } from '../../types.js';
import { ensureDir } from '../../utils/atomic-write.js';
import { resolvePaths } from '../../paths.js';
import { logger } from '../../utils/logger.js';
import { encodePath } from '../../utils/cross-platform.js';
import { EventBus } from '../event-bus.js';
import type { SessionFileAdapter, SessionFileInfo, CliSessionEntry, SdkSessionEntry } from './session-file-adapter.js';
import {
  SessionFile, HealthRecord,
  chatDirPath, generateSessionId, formatTimestamp,
  atomicWriteJson, appendJsonl, readJsonFile, readLastJsonlLine, readAllJsonlLines, scanChatDirs, scanMetaFiles,
  ensureChatDir, readThreadIndex, writeThreadIndex,
} from './session-fs-store.js';
import { sessionToFile, fileToSession } from './session-mapper.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

/** 判定用户是否为指定渠道的 owner */
export type OwnerResolver = (channel: string, userId: string) => boolean;
/** 判定用户是否为指定渠道的 admin */
export type AdminResolver = (channel: string, userId: string) => boolean;

/**
 * 解析新建 session 时的默认 sessionMode
 */
export type SessionModeResolver = (channel: string, chatType: string) => 'interactive' | 'proactive' | undefined;

export class SessionManager {
  private sessionsDir: string;
  private eventBus: EventBus;
  private ownerResolver?: OwnerResolver;
  private adminResolver?: AdminResolver;
  private sessionModeResolver?: SessionModeResolver;
  private fileAdapters = new Map<string, SessionFileAdapter>();
  private sessionEncryptState = new Map<string, boolean>();

  constructor(sessionsDir: string, eventBus: EventBus, ownerResolver?: OwnerResolver, adminResolver?: AdminResolver) {
    ensureDir(sessionsDir);
    this.sessionsDir = sessionsDir;
    this.eventBus = eventBus;
    this.ownerResolver = ownerResolver;
    this.adminResolver = adminResolver;
  }

  setOwnerResolver(resolver: OwnerResolver): void {
    this.ownerResolver = resolver;
  }

  setAdminResolver(resolver: AdminResolver): void {
    this.adminResolver = resolver;
  }

  setSessionModeResolver(resolver: SessionModeResolver): void {
    this.sessionModeResolver = resolver;
  }

  private resolveDefaultSessionMode(channel: string, chatType?: string): 'interactive' | 'proactive' {
    const ct = chatType || 'private';
    const resolved = this.sessionModeResolver?.(channel, ct);
    return resolved || 'interactive';
  }

  registerFileAdapter(adapter: SessionFileAdapter): void {
    this.fileAdapters.set(adapter.agentId, adapter);
    logger.debug(`[SessionManager] Registered file adapter: ${adapter.agentId}`);
  }

  private getFileAdapter(agentId: string): SessionFileAdapter | undefined {
    return this.fileAdapters.get(agentId);
  }

  private getProjectDirName(projectPath: string): string {
    return encodePath(projectPath);
  }

  private getSessionFilePath(projectPath: string, sessionId: string): string {
    const homeDir = os.homedir();
    const encodedPath = this.getProjectDirName(projectPath);
    return path.join(homeDir, '.claude', 'projects', encodedPath, `${sessionId}.jsonl`);
  }

  resolveIdentity(channel: string, userId?: string): SessionIdentity {
    if (!userId) return { role: 'anonymous', mode: 'interactive' };
    if (this.ownerResolver?.(channel, userId)) return { role: 'owner', mode: 'interactive' };
    if (this.adminResolver?.(channel, userId)) return { role: 'admin', mode: 'interactive' };
    return { role: 'guest', mode: 'interactive' };
  }

  async updateIdentity(sessionId: string, identity: SessionIdentity): Promise<void> {
    logger.debug(`[SessionManager] updateIdentity: sessionId=${sessionId}, role=${identity.role}`);
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

  // ─── File I/O helpers ───

  /**
   * 解析 chat 目录路径。
   * 1. 先扫描所有 chat 目录，按 channelId 查找匹配项（同时 channelType==channel 或缺失时直接 channelId 匹配）
   * 2. 找不到则按 fallback：channelType=channel（实例名），selfId=null
   *
   * 这样保持兼容：不知道 channelType 的 caller 仍可以用 (channel, channelId) 调用。
   */
  private resolveChatDir(channel: string, channelId: string): string {
    // 优先尝试从已有目录里找
    const dirs = scanChatDirs(this.sessionsDir);
    for (const d of dirs) {
      if (d.channelId !== channelId) continue;
      // 验证 active.json 或 meta 文件里 channel（实例名）匹配
      const active = readJsonFile<SessionFile>(path.join(d.dirPath, 'active.json'));
      if (active && active.channel === channel) return d.dirPath;
      // 没 active.json 时，看 channelType 是否能匹配 channel
      if (!active && d.channelType === channel) return d.dirPath;
    }
    // Fallback：按 channel 当 channelType 创建（旧路径布局兼容）
    return chatDirPath(this.sessionsDir, channel, channelId);
  }

  /**
   * 给定明确的 channelType + selfId 时直接计算路径（不扫描）。
   * 用于 caller 已经知道完整路由信息的场景（如 message-bridge 透传）。
   */
  private resolveChatDirExact(channel: string, channelId: string, channelType?: string, selfId?: string): string {
    if (channelType) {
      return chatDirPath(this.sessionsDir, channelType, channelId, selfId);
    }
    return this.resolveChatDir(channel, channelId);
  }

  private resolveChatDirFromSession(session: Session): string {
    const channelType = session.channelType || session.channel;
    return chatDirPath(this.sessionsDir, channelType, session.channelId, session.selfId);
  }

  /** Public accessor: get the chat directory path for a session (for message log etc.) */
  getChatDir(session: Session): string {
    return this.resolveChatDirFromSession(session);
  }

  /** Like resolveChatDir but also ensures the dir + _threads + _trash exist. */
  private ensureResolvedChatDir(channel: string, channelId: string): string {
    const dir = this.resolveChatDir(channel, channelId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, '_threads'), { recursive: true });
    fs.mkdirSync(path.join(dir, '_trash'), { recursive: true });
    return dir;
  }

  /** 推断给定 chat 的 channelType（优先取 active.json）。无活跃时回落到 channel 实例名。 */
  private inferChannelType(channel: string, channelId: string): string {
    const active = this.readActive(channel, channelId);
    return active?.channelType || channel;
  }

  /** 从 active 推断 selfId（已有 session 的复用） */
  private inferSelfId(channel: string, channelId: string): string | undefined {
    const active = this.readActive(channel, channelId);
    return active?.selfId;
  }

  private readActive(channel: string, channelId: string): Session | undefined {
    const dir = this.resolveChatDir(channel, channelId);
    const file = readJsonFile<SessionFile>(path.join(dir, 'active.json'));
    if (!file) return undefined;
    return fileToSession(file);
  }

  private writeActive(channel: string, channelId: string, session: Session): void {
    const dir = this.ensureChatDirForSession(session);
    const file = sessionToFile(session);
    atomicWriteJson(path.join(dir, 'active.json'), file);
  }

  private clearActive(channel: string, channelId: string): void {
    const dir = this.resolveChatDir(channel, channelId);
    const activePath = path.join(dir, 'active.json');
    try { fs.unlinkSync(activePath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }

  private ensureChatDirForSession(session: Session): string {
    const channelType = session.channelType || session.channel;
    return ensureChatDir(this.sessionsDir, channelType, session.channelId, session.selfId);
  }

  private metaFilePath(chatDir: string, sessionId: string): string {
    return path.join(chatDir, `${sessionId}.jsonl`);
  }

  private appendMeta(channel: string, channelId: string, session: Session): void {
    const dir = this.ensureChatDirForSession(session);
    const isThread = !!session.threadId;
    const targetDir = isThread ? path.join(dir, '_threads') : dir;
    const file = sessionToFile(session);
    const metaPath = this.metaFilePath(targetDir, session.id);
    appendJsonl(metaPath, file);
  }

  private readMetaLatest(metaFilePath: string): Session | undefined {
    const file = readLastJsonlLine<SessionFile>(metaFilePath);
    if (!file) return undefined;
    return fileToSession(file);
  }

  private validateSessionFile(session: Session): string | undefined {
    const agentSessionId = session.agentSessionId;
    if (!agentSessionId) return undefined;
    const agentId = session.agentId || 'claude';
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) return agentSessionId;
    if (adapter.checkExists(session.projectPath, agentSessionId)) return agentSessionId;
    logger.warn(`Session file not found for ${agentId}: ${agentSessionId}, clearing session ID`);
    session.agentSessionId = undefined;
    this.appendMeta(session.channel, session.channelId, session);
    const active = this.readActive(session.channel, session.channelId);
    if (active && active.id === session.id) {
      this.writeActive(session.channel, session.channelId, session);
    }
    return undefined;
  }

  private getActiveChatType(channel: string, channelId: string): string {
    const active = this.readActive(channel, channelId);
    if (active && !active.threadId) return active.chatType || 'private';
    return 'private';
  }

  private findAllSessionsInChat(chatDir: string, includeThreads: boolean = true): Session[] {
    const metaFiles = scanMetaFiles(chatDir);
    const results: Session[] = [];
    for (const metaFile of metaFiles) {
      const session = this.readMetaLatest(path.join(chatDir, metaFile));
      if (session) results.push(session);
    }
    if (includeThreads) {
      const threadsDir = path.join(chatDir, '_threads');
      const threadMetas = scanMetaFiles(threadsDir);
      for (const metaFile of threadMetas) {
        const session = this.readMetaLatest(path.join(threadsDir, metaFile));
        if (session) results.push(session);
      }
    }
    return results;
  }

  private findSessionFileById(sessionId: string): { chatDir: string; metaPath: string; isThread: boolean } | undefined {
    const chatDirs = scanChatDirs(this.sessionsDir);
    for (const { dirPath } of chatDirs) {
      const mainPath = path.join(dirPath, `${sessionId}.jsonl`);
      try { fs.statSync(mainPath); return { chatDir: dirPath, metaPath: mainPath, isThread: false }; } catch {}
      const threadPath = path.join(dirPath, '_threads', `${sessionId}.jsonl`);
      try { fs.statSync(threadPath); return { chatDir: dirPath, metaPath: threadPath, isThread: true }; } catch {}
    }
    return undefined;
  }

  // ─── Public API ───

  getKnownThreadIds(channel: string): string[] {
    const chatDirs = scanChatDirs(this.sessionsDir);
    const threadIds: string[] = [];
    for (const { dirPath } of chatDirs) {
      const active = readJsonFile<SessionFile>(path.join(dirPath, 'active.json'));
      const matchInstance = active?.channel === channel;
      // 也兼容没 active.json 时按目录顶层 channelType 匹配（fallback 路径布局）
      if (!matchInstance) continue;
      const index = readThreadIndex(dirPath);
      for (const tid of Object.keys(index)) threadIds.push(tid);
    }
    return threadIds;
  }

  markProcessing(sessionId: string, taskId?: string): void {
    const now = Date.now();
    const state = taskId ? `${now}:${taskId}` : String(now);
    const chatDirs = scanChatDirs(this.sessionsDir);
    for (const { dirPath } of chatDirs) {
      const active = readJsonFile<SessionFile>(path.join(dirPath, 'active.json'));
      if (active && active.id === sessionId) {
        active.activeTask = state;
        active.updatedAt = now;
        active.updatedAtStr = formatTimestamp(now);
        atomicWriteJson(path.join(dirPath, 'active.json'), active);
        return;
      }
    }
  }

  getActiveTaskId(sessionId: string): string | undefined {
    const chatDirs = scanChatDirs(this.sessionsDir);
    for (const { dirPath } of chatDirs) {
      const active = readJsonFile<SessionFile>(path.join(dirPath, 'active.json'));
      if (active && active.id === sessionId) {
        if (!active.activeTask) return undefined;
        const colonIdx = active.activeTask.indexOf(':');
        return colonIdx > 0 ? active.activeTask.slice(colonIdx + 1) : undefined;
      }
    }
    return undefined;
  }

  clearProcessing(sessionId: string): void {
    const now = Date.now();
    const chatDirs = scanChatDirs(this.sessionsDir);
    for (const { dirPath } of chatDirs) {
      const active = readJsonFile<SessionFile>(path.join(dirPath, 'active.json'));
      if (active && active.id === sessionId) {
        active.activeTask = null;
        active.updatedAt = now;
        active.updatedAtStr = formatTimestamp(now);
        atomicWriteJson(path.join(dirPath, 'active.json'), active);
        break;
      }
    }
    this.sessionEncryptState.delete(sessionId);
  }

  setSessionEncrypt(sessionId: string, encrypted: boolean): void {
    this.sessionEncryptState.set(sessionId, encrypted);
  }

  getSessionEncrypt(sessionId: string): boolean | undefined {
    return this.sessionEncryptState.get(sessionId);
  }

  getPendingProcessingSessions(maxAgeMs: number = 60 * 60 * 1000): Session[] {
    const now = Date.now();
    const result: Session[] = [];
    const chatDirs = scanChatDirs(this.sessionsDir);
    for (const { dirPath } of chatDirs) {
      const active = readJsonFile<SessionFile>(path.join(dirPath, 'active.json'));
      if (!active || !active.activeTask) continue;
      const colonIdx = active.activeTask.indexOf(':');
      const ts = parseInt(colonIdx > 0 ? active.activeTask.slice(0, colonIdx) : active.activeTask, 10);
      if (!isNaN(ts) && (now - ts) < maxAgeMs) {
        result.push(fileToSession(active));
      } else {
        active.activeTask = null;
        active.updatedAt = now;
        active.updatedAtStr = formatTimestamp(now);
        atomicWriteJson(path.join(dirPath, 'active.json'), active);
      }
    }
    return result;
  }

  // ─── Session lifecycle ───

  async getOrCreateSession(
    channel: string,
    channelId: string,
    defaultProjectPath: string,
    threadId?: string,
    metadata?: any,
    name?: string,
    userId?: string,
    chatType?: 'private' | 'group',
    agentId?: string,
    selfId?: string,
    channelType?: string
  ): Promise<Session> {
    if (threadId) {
      const session = this.getOrCreateThreadSession(channel, channelId, threadId, defaultProjectPath, metadata, name, agentId, selfId, channelType);
      session.identity = this.resolveIdentity(channel, userId);
      if (session.metadata && !session.metadata.permissionMode) {
        session.metadata.permissionMode = DEFAULT_PERMISSION_MODE;
        this.appendMeta(channel, channelId, session);
      }
      return session;
    }

    // 使用精确路径解析（caller 提供了 channelType 时直接定位，避免扫描回落）
    const exactDir = this.resolveChatDirExact(channel, channelId, channelType, selfId);
    const activeFile = readJsonFile<SessionFile>(path.join(exactDir, 'active.json'));
    const active = activeFile ? fileToSession(activeFile) : undefined;
    if (active && !active.threadId) {
      const validSessionId = this.validateSessionFile(active);
      const session: Session = { ...active, agentSessionId: validSessionId };
      session.identity = this.resolveIdentity(channel, userId);

      let mutated = false;
      if (chatType && session.chatType !== chatType) {
        logger.info(`[SessionManager] Updating chatType for session ${session.id}: ${session.chatType} -> ${chatType}`);
        session.chatType = chatType;
        mutated = true;
      }

      if (selfId && session.selfId !== selfId) {
        session.selfId = selfId;
        mutated = true;
      }

      if (chatType === 'private' && userId) {
        if (!session.metadata) session.metadata = {};
        if (!session.metadata.peerId) { session.metadata.peerId = userId; mutated = true; }
        if (!session.metadata.peerName && metadata?.peerName) { session.metadata.peerName = metadata.peerName; mutated = true; }
        if (metadata?.channelName && session.metadata.channelName !== metadata.channelName) { session.metadata.channelName = metadata.channelName; mutated = true; }
      }
      if (metadata?.channelName && chatType !== 'private') {
        if (!session.metadata) session.metadata = {};
        if (session.metadata.channelName !== metadata.channelName) {
          session.metadata.channelName = metadata.channelName;
          mutated = true;
        }
      }
      if (mutated) {
        session.updatedAt = Date.now();
        this.appendMeta(channel, channelId, session);
        this.writeActive(channel, channelId, session);
      }
      return session;
    }

    // Find existing session for default project path
    const chatDir = this.resolveChatDir(channel, channelId);
    const allSessions = this.findAllSessionsInChat(chatDir, false);
    const existing = allSessions
      .filter(s => s.projectPath === defaultProjectPath && !s.threadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (existing) {
      const validSessionId = this.validateSessionFile(existing);
      const session: Session = { ...existing, agentSessionId: validSessionId };
      session.identity = this.resolveIdentity(channel, userId);

      if (!session.metadata) session.metadata = {};
      if (selfId && session.selfId !== selfId) {
        session.selfId = selfId;
      }
      if (chatType && session.chatType !== chatType) {
        logger.info(`[SessionManager] Updating chatType for session ${session.id}: ${session.chatType} -> ${chatType}`);
        session.chatType = chatType;
      }
      if (chatType === 'private' && userId && !session.metadata.peerId) {
        session.metadata.peerId = userId;
      }
      if (chatType === 'private' && metadata?.peerName && !session.metadata.peerName) {
        session.metadata.peerName = metadata.peerName;
      }
      session.updatedAt = Date.now();
      this.appendMeta(channel, channelId, session);
      this.writeActive(channel, channelId, session);
      return session;
    }

    // Create new session
    const sessionMetadata: any = { ...(metadata || {}) };
    if (!sessionMetadata.permissionMode) sessionMetadata.permissionMode = DEFAULT_PERMISSION_MODE;

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType: channelType || channel,
      channelId,
      selfId,
      projectPath: defaultProjectPath,
      threadId: '',
      agentId: agentId || 'claude',
      chatType: chatType || 'private',
      sessionMode: this.resolveDefaultSessionMode(channel, chatType || 'private'),
      metadata: sessionMetadata,
      name: name || '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    session.identity = this.resolveIdentity(channel, userId);

    this.appendMeta(channel, channelId, session);
    this.writeActive(channel, channelId, session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath: defaultProjectPath,
      name: session.name,
      chatType: session.chatType,
      timestamp: Date.now(),
    });
    return session;
  }

  async updateSession(sessionId: string, updates: Partial<Pick<Session, 'chatType' | 'name' | 'metadata' | 'sessionMode'>> & { agentSessionId?: string | null }): Promise<void> {
    const found = this.findSessionFileById(sessionId);
    if (!found) return;
    const current = this.readMetaLatest(found.metaPath);
    if (!current) return;

    if (updates.chatType !== undefined) current.chatType = updates.chatType;
    if (updates.name !== undefined) current.name = updates.name;
    if (updates.sessionMode !== undefined) current.sessionMode = updates.sessionMode;
    if (updates.metadata !== undefined) current.metadata = updates.metadata;
    if ('agentSessionId' in updates) current.agentSessionId = updates.agentSessionId ?? undefined;
    current.updatedAt = Date.now();

    this.appendMeta(current.channel, current.channelId, current);
    const active = this.readActive(current.channel, current.channelId);
    if (active && active.id === sessionId) {
      // 保留 active.json 中已有的 activeTask（markProcessing 写入的处理状态）
      if (active.processingState && !current.processingState) {
        current.processingState = active.processingState;
      }
      this.writeActive(current.channel, current.channelId, current);
    }
  }

  private getOrCreateThreadSession(
    channel: string,
    channelId: string,
    threadId: string,
    defaultProjectPath: string,
    metadata?: any,
    name?: string,
    agentId?: string,
    selfId?: string,
    channelType?: string
  ): Session {
    const chatDir = this.ensureResolvedChatDir(channel, channelId);
    const threadIndex = readThreadIndex(chatDir);
    const existingMetaId = threadIndex[threadId];

    if (existingMetaId) {
      const metaPath = path.join(chatDir, '_threads', `${existingMetaId}.jsonl`);
      const existing = this.readMetaLatest(metaPath);
      if (existing) {
        const validSessionId = this.validateSessionFile(existing);
        if (metadata) {
          existing.metadata = { ...(existing.metadata || {}), ...metadata };
          existing.updatedAt = Date.now();
          this.appendMeta(channel, channelId, existing);
        }
        return { ...existing, agentSessionId: validSessionId };
      }
    }

    // Inherit project path & chatType from active main session
    const activeMain = this.readActive(channel, channelId);
    const projectPath = (activeMain && !activeMain.threadId ? activeMain.projectPath : undefined) || defaultProjectPath;
    const inheritedChatType = (activeMain && !activeMain.threadId ? activeMain.chatType : undefined) || 'private';

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType: channelType || channel,
      channelId,
      selfId,
      projectPath,
      threadId,
      agentId: agentId || 'claude',
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      metadata,
      name: name || '话题会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.appendMeta(channel, channelId, session);
    threadIndex[threadId] = session.id;
    writeThreadIndex(chatDir, threadIndex);

    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath,
      name: session.name,
      timestamp: Date.now(),
    });
    return session;
  }

  async switchProject(channel: string, channelId: string, newProjectPath: string, currentAgentId?: string): Promise<Session> {
    const agentId = currentAgentId || 'claude';
    logger.info(`[SessionManager] switchProject: channel=${channel} channelId=${channelId} newPath=${newProjectPath} agent=${agentId}`);
    const inheritedChatType = this.getActiveChatType(channel, channelId);

    const chatDir = this.ensureResolvedChatDir(channel, channelId);
    const allSessions = this.findAllSessionsInChat(chatDir, false);
    const target = allSessions
      .filter(s => s.projectPath === newProjectPath && (s.agentId || 'claude') === agentId && !s.threadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (target) {
      const validSessionId = this.validateSessionFile(target);
      target.agentSessionId = validSessionId;
      target.updatedAt = Date.now();
      this.appendMeta(channel, channelId, target);
      this.writeActive(channel, channelId, target);
      return target;
    }

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType: this.inferChannelType(channel, channelId),
      channelId,
      selfId: this.inferSelfId(channel, channelId),
      projectPath: newProjectPath,
      threadId: '',
      agentId,
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      metadata: {},
      name: '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.appendMeta(channel, channelId, session);
    this.writeActive(channel, channelId, session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath: newProjectPath,
      name: session.name,
      timestamp: Date.now(),
    });
    return session;
  }

  async updateAgentSessionId(channel: string, channelId: string, agentSessionId: string): Promise<void> {
    const active = this.readActive(channel, channelId);
    if (!active) return;
    active.agentSessionId = agentSessionId;
    active.updatedAt = Date.now();
    this.appendMeta(channel, channelId, active);
    this.writeActive(channel, channelId, active);
  }

  async updateAgentSessionIdBySessionId(sessionId: string, agentSessionId: string): Promise<void> {
    logger.info(`[SessionManager] Updating agent_session_id: sessionId=${sessionId}, agentSessionId=${agentSessionId}`);
    const found = this.findSessionFileById(sessionId);
    if (!found) return;
    const current = this.readMetaLatest(found.metaPath);
    if (!current) return;
    current.agentSessionId = agentSessionId;
    current.updatedAt = Date.now();
    this.appendMeta(current.channel, current.channelId, current);
    const active = this.readActive(current.channel, current.channelId);
    if (active && active.id === sessionId) {
      if (active.processingState && !current.processingState) {
        current.processingState = active.processingState;
      }
      this.writeActive(current.channel, current.channelId, current);
    }
  }

  async switchAgent(channel: string, channelId: string, projectPath: string, newAgentId: string): Promise<Session> {
    const inheritedChatType = this.getActiveChatType(channel, channelId);
    const chatDir = this.ensureResolvedChatDir(channel, channelId);
    const allSessions = this.findAllSessionsInChat(chatDir, false);
    const target = allSessions
      .filter(s => s.projectPath === projectPath && (s.agentId || 'claude') === newAgentId && !s.threadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (target) {
      const validSessionId = this.validateSessionFile(target);
      target.agentSessionId = validSessionId;
      target.updatedAt = Date.now();
      this.appendMeta(channel, channelId, target);
      this.writeActive(channel, channelId, target);
      return target;
    }

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType: this.inferChannelType(channel, channelId),
      channelId,
      selfId: this.inferSelfId(channel, channelId),
      projectPath,
      threadId: '',
      agentId: newAgentId,
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      metadata: {},
      name: '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.appendMeta(channel, channelId, session);
    this.writeActive(channel, channelId, session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath,
      name: session.name,
      timestamp: Date.now(),
    });
    return session;
  }

  async clearActiveSession(channel: string, channelId: string): Promise<void> {
    const active = this.readActive(channel, channelId);
    if (!active) return;
    active.agentSessionId = undefined;
    active.updatedAt = Date.now();
    this.appendMeta(channel, channelId, active);
    this.writeActive(channel, channelId, active);
  }

  getOwnerChatId(targetChannel: string, ownerPeerId: string): string | undefined {
    const chatDirs = scanChatDirs(this.sessionsDir);
    let bestMatch: { channelId: string; updatedAt: number } | undefined;
    for (const { channelId, dirPath } of chatDirs) {
      // Check active.json first
      const active = readJsonFile<SessionFile>(path.join(dirPath, 'active.json'));
      // 按 channel 实例名匹配（active.json 里有；缺失就跳过这个 chat）
      if (!active || active.channel !== targetChannel) continue;
      const candidates: SessionFile[] = [active];
      // Also scan meta files
      for (const metaFile of scanMetaFiles(dirPath)) {
        const file = readLastJsonlLine<SessionFile>(path.join(dirPath, metaFile));
        if (file) candidates.push(file);
      }
      for (const cand of candidates) {
        if (cand.chatType !== 'private') continue;
        if (cand.metadata?.peerId !== ownerPeerId) continue;
        if (!bestMatch || cand.updatedAt > bestMatch.updatedAt) {
          bestMatch = { channelId, updatedAt: cand.updatedAt };
        }
      }
    }
    return bestMatch?.channelId;
  }

  async getSessionById(sessionId: string): Promise<Session | undefined> {
    const found = this.findSessionFileById(sessionId);
    if (!found) return undefined;
    return this.readMetaLatest(found.metaPath);
  }

  async getActiveSession(channel: string, channelId: string): Promise<Session | undefined> {
    return this.readActive(channel, channelId);
  }

  async getThreadSession(channel: string, channelId: string, threadId: string): Promise<Session | undefined> {
    const chatDir = this.resolveChatDir(channel, channelId);
    const threadIndex = readThreadIndex(chatDir);
    const metaId = threadIndex[threadId];
    if (!metaId) return undefined;
    const metaPath = path.join(chatDir, '_threads', `${metaId}.jsonl`);
    const session = this.readMetaLatest(metaPath);
    if (!session) return undefined;
    const validSessionId = this.validateSessionFile(session);
    return { ...session, agentSessionId: validSessionId };
  }

  async listSessions(channel: string, channelId: string): Promise<Session[]> {
    const chatDir = this.resolveChatDir(channel, channelId);
    const sessions = this.findAllSessionsInChat(chatDir, true);
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSessionByProjectPath(channel: string, channelId: string, projectPath: string): Promise<Session | undefined> {
    const chatDir = this.resolveChatDir(channel, channelId);
    const sessions = this.findAllSessionsInChat(chatDir, false);
    const matched = sessions.filter(s => s.projectPath === projectPath);
    if (matched.length === 0) return undefined;
    matched.sort((a, b) => {
      const aProc = a.processingState ? 1 : 0;
      const bProc = b.processingState ? 1 : 0;
      if (aProc !== bProc) return bProc - aProc;
      return b.updatedAt - a.updatedAt;
    });
    return matched[0];
  }

  async getSessionByName(channel: string, channelId: string, name: string): Promise<Session | undefined> {
    const chatDir = this.resolveChatDir(channel, channelId);
    const sessions = this.findAllSessionsInChat(chatDir, true);
    return sessions.find(s => s.name === name);
  }

  async switchToSession(channel: string, channelId: string, targetSessionId: string): Promise<Session | null> {
    const chatDir = this.resolveChatDir(channel, channelId);
    const sessions = this.findAllSessionsInChat(chatDir, true);
    const target = sessions.find(s => s.id === targetSessionId);
    if (!target) return null;

    target.updatedAt = Date.now();
    this.appendMeta(channel, channelId, target);
    this.writeActive(channel, channelId, target);
    return target;
  }

  updateMetadata(sessionId: string, metadata: Record<string, any>): void {
    const found = this.findSessionFileById(sessionId);
    if (!found) return;
    const current = this.readMetaLatest(found.metaPath);
    if (!current) return;
    current.metadata = metadata;
    current.updatedAt = Date.now();
    this.appendMeta(current.channel, current.channelId, current);
    const active = this.readActive(current.channel, current.channelId);
    if (active && active.id === sessionId) {
      this.writeActive(current.channel, current.channelId, current);
    }
  }

  async renameSession(sessionId: string, newName: string): Promise<boolean> {
    const found = this.findSessionFileById(sessionId);
    if (!found) return false;
    const current = this.readMetaLatest(found.metaPath);
    if (!current) return false;
    current.name = newName;
    current.updatedAt = Date.now();
    this.appendMeta(current.channel, current.channelId, current);
    const active = this.readActive(current.channel, current.channelId);
    if (active && active.id === sessionId) {
      this.writeActive(current.channel, current.channelId, current);
    }
    return true;
  }

  async unbindSession(sessionId: string): Promise<boolean> {
    const found = this.findSessionFileById(sessionId);
    if (!found) return false;
    const trashDir = path.join(found.chatDir, '_trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const trashPath = path.join(trashDir, path.basename(found.metaPath));
    try { fs.renameSync(found.metaPath, trashPath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    // If thread session, remove from thread-index
    if (found.isThread) {
      const threadIndex = readThreadIndex(found.chatDir);
      for (const [tid, mid] of Object.entries(threadIndex)) {
        if (mid === sessionId) { delete threadIndex[tid]; break; }
      }
      writeThreadIndex(found.chatDir, threadIndex);
    }
    // Clear active.json if it pointed to this session
    const activePath = path.join(found.chatDir, 'active.json');
    const active = readJsonFile<SessionFile>(activePath);
    if (active && active.id === sessionId) {
      try { fs.unlinkSync(activePath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    return true;
  }

  async softDeleteSession(channelId: string): Promise<void> {
    const chatDirs = scanChatDirs(this.sessionsDir);
    for (const { channelId: cid, dirPath } of chatDirs) {
      if (cid !== channelId) continue;
      const trashDir = path.join(dirPath, '_trash');
      fs.mkdirSync(trashDir, { recursive: true });
      for (const metaFile of scanMetaFiles(dirPath)) {
        const src = path.join(dirPath, metaFile);
        const dst = path.join(trashDir, metaFile);
        try { fs.renameSync(src, dst); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
      const threadsDir = path.join(dirPath, '_threads');
      for (const metaFile of scanMetaFiles(threadsDir)) {
        const src = path.join(threadsDir, metaFile);
        const dst = path.join(trashDir, metaFile);
        try { fs.renameSync(src, dst); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
      // Clear active.json
      const activePath = path.join(dirPath, 'active.json');
      try { fs.unlinkSync(activePath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      // Clear thread index
      try { fs.unlinkSync(path.join(threadsDir, 'thread-index.json')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
  }

  async createNewSession(channel: string, channelId: string, projectPath: string, name?: string, agentId?: string): Promise<Session> {
    const inheritedChatType = this.getActiveChatType(channel, channelId);

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType: this.inferChannelType(channel, channelId),
      channelId,
      selfId: this.inferSelfId(channel, channelId),
      projectPath,
      threadId: '',
      agentId: agentId || 'claude',
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      metadata: {},
      name: name || '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.appendMeta(channel, channelId, session);
    this.writeActive(channel, channelId, session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath,
      name: session.name,
      timestamp: Date.now(),
    });
    return session;
  }

  async createForkedSession(
    sourceSession: Session,
    forkedAgentSessionId: string,
    name?: string
  ): Promise<Session> {
    const session: Session = {
      id: generateSessionId(),
      channel: sourceSession.channel,
      channelType: sourceSession.channelType || sourceSession.channel,
      channelId: sourceSession.channelId,
      selfId: sourceSession.selfId,
      projectPath: sourceSession.projectPath,
      threadId: sourceSession.threadId || '',
      agentId: sourceSession.agentId || 'claude',
      chatType: sourceSession.chatType || 'private',
      sessionMode: sourceSession.sessionMode || 'interactive',
      agentSessionId: forkedAgentSessionId,
      metadata: {},
      name: name || `${sourceSession.name || '会话'}-分支`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.appendMeta(sourceSession.channel, sourceSession.channelId, session);
    this.writeActive(sourceSession.channel, sourceSession.channelId, session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel: sourceSession.channel,
      channelId: sourceSession.channelId,
      projectPath: sourceSession.projectPath,
      name: session.name,
      timestamp: Date.now(),
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

  getSessionFileInfo(projectPath: string, agentSessionId: string, agentId: string): SessionFileInfo {
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) return { turns: 0 };
    return adapter.getFileInfo(projectPath, agentSessionId);
  }

  async listSdkSessions(projectPath: string, agentId: string): Promise<SdkSessionEntry[]> {
    const adapter = this.getFileAdapter(agentId);
    if (!adapter?.listSdkSessions) return [];
    return adapter.listSdkSessions(projectPath);
  }

  async getSessionByUuidPrefix(channel: string, channelId: string, uuidPrefix: string): Promise<Session | undefined> {
    const chatDir = this.resolveChatDir(channel, channelId);
    const sessions = this.findAllSessionsInChat(chatDir, true);
    const matched = sessions.filter(s => s.agentSessionId && s.agentSessionId.startsWith(uuidPrefix));
    if (matched.length === 0) return undefined;
    if (matched.length > 1) {
      logger.warn(`Multiple sessions found with UUID prefix: ${uuidPrefix}`);
    }
    return matched[0];
  }

  async importCliSession(channel: string, channelId: string, projectPath: string, agentSessionId: string, agentId: string = 'claude'): Promise<Session> {
    const inheritedChatType = this.getActiveChatType(channel, channelId);

    const fileInfo = this.getSessionFileInfo(projectPath, agentSessionId, agentId);
    const name = fileInfo.title || `CLI会话-${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType: this.inferChannelType(channel, channelId),
      channelId,
      selfId: this.inferSelfId(channel, channelId),
      projectPath,
      threadId: '',
      agentId,
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      agentSessionId,
      metadata: {},
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.appendMeta(channel, channelId, session);
    this.writeActive(channel, channelId, session);
    this.eventBus.publish({
      type: 'session:created',
      sessionId: session.id,
      channel,
      channelId,
      projectPath,
      name,
      timestamp: Date.now(),
    });
    return session;
  }

  // ─── Health status ───

  private healthFilePath(channel: string, channelId: string): string {
    return path.join(this.ensureResolvedChatDir(channel, channelId), 'health.jsonl');
  }

  /** Find the chat dir containing a given session id */
  private chatDirForSession(sessionId: string): { channel: string; channelId: string; dirPath: string } | undefined {
    const found = this.findSessionFileById(sessionId);
    if (!found) return undefined;
    // 从 meta jsonl 最后一行读 channel 实例名 + channelId
    const meta = readLastJsonlLine<SessionFile>(found.metaPath);
    if (!meta) return undefined;
    return { channel: meta.channel, channelId: meta.channelId, dirPath: found.chatDir };
  }

  async getHealthStatus(sessionId: string): Promise<{
    consecutiveErrors: number;
    lastError?: string;
    lastErrorType?: string;
    safeMode: boolean;
    lastSuccessTime: number;
  }> {
    const chatInfo = this.chatDirForSession(sessionId);
    if (!chatInfo) {
      return { consecutiveErrors: 0, safeMode: false, lastSuccessTime: Date.now() };
    }
    const healthPath = path.join(chatInfo.dirPath, 'health.jsonl');
    const records = readAllJsonlLines<HealthRecord>(healthPath).filter(r => r.sessionId === sessionId);

    let consecutiveErrors = 0;
    let lastError: string | undefined;
    let lastErrorType: string | undefined;
    let lastSuccessTime = 0;

    // Walk from tail to count consecutive errors
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i];
      if (rec.type === 'error') {
        consecutiveErrors++;
        if (lastError === undefined) {
          lastError = rec.error;
          lastErrorType = rec.errorType;
        }
      } else {
        // success or reset breaks the streak
        if (rec.type === 'success' && rec.at > lastSuccessTime) lastSuccessTime = rec.at;
        break;
      }
    }
    // Find most recent success time across all records
    if (lastSuccessTime === 0) {
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].type === 'success' && records[i].at > lastSuccessTime) {
          lastSuccessTime = records[i].at;
          break;
        }
      }
    }
    if (lastSuccessTime === 0) lastSuccessTime = Date.now();

    return {
      consecutiveErrors,
      lastError,
      lastErrorType,
      safeMode: false,
      lastSuccessTime,
    };
  }

  async recordSuccess(sessionId: string): Promise<void> {
    const chatInfo = this.chatDirForSession(sessionId);
    if (!chatInfo) return;
    const now = Date.now();
    const record: HealthRecord = {
      type: 'success',
      sessionId,
      at: now,
      atStr: formatTimestamp(now),
    };
    appendJsonl(path.join(chatInfo.dirPath, 'health.jsonl'), record);
  }

  async recordError(sessionId: string, errorType: string, errorMessage: string): Promise<number> {
    const chatInfo = this.chatDirForSession(sessionId);
    if (!chatInfo) return 0;
    const now = Date.now();
    const record: HealthRecord = {
      type: 'error',
      sessionId,
      errorType,
      error: errorMessage,
      at: now,
      atStr: formatTimestamp(now),
    };
    appendJsonl(path.join(chatInfo.dirPath, 'health.jsonl'), record);
    const status = await this.getHealthStatus(sessionId);
    return status.consecutiveErrors;
  }

  async resetHealthStatus(sessionId: string): Promise<void> {
    const chatInfo = this.chatDirForSession(sessionId);
    if (!chatInfo) return;
    const now = Date.now();
    const record: HealthRecord = {
      type: 'reset',
      sessionId,
      at: now,
      atStr: formatTimestamp(now),
    };
    appendJsonl(path.join(chatInfo.dirPath, 'health.jsonl'), record);
  }

  close(): void {
    for (const adapter of this.fileAdapters.values()) adapter.close?.();
  }
}
