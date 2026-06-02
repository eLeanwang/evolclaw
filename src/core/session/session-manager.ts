import { Session, SessionIdentity, DEFAULT_PERMISSION_MODE } from '../../types.js';
import { ensureDir } from '../../utils/atomic-write.js';
import { resolvePaths } from '../../paths.js';
import { logger } from '../../utils/logger.js';
import { encodePath } from '../../utils/cross-platform.js';
import { EventBus } from '../event-bus.js';
import type { SessionFileAdapter, SessionFileInfo, CliSessionEntry, SdkSessionEntry } from './session-file-adapter.js';
import {
  SessionFile, HealthRecord, ThreadIndexEntry,
  chatDirPath, generateSessionId, formatTimestamp,
  atomicWriteJson, appendJsonl, readJsonFile, readLastJsonlLine, readAllJsonlLines, scanChatDirs, scanMetaFiles,
  ensureChatDir, readThreadIndex, writeThreadIndex,
} from './session-fs-store.js';
import { sessionToFile, fileToSession } from './session-mapper.js';
import { formatSessionKey, DEFAULT_THREAD_ID } from './session-key.js';
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
export type SessionModeResolver = (channel: string, chatType: string, peerType?: string) => 'interactive' | 'proactive' | undefined;

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
    this.migrateChannelKeyFormat();
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

  private resolveDefaultSessionMode(channel: string, chatType?: string, peerType?: string): 'interactive' | 'proactive' {
    const ct = chatType || 'private';

    // 来源2：群聊强制 proactive
    if (ct === 'group') return 'proactive';

    // 来源3：非 human 对端强制 proactive，无视 agent 的默认 chatmode 配置
    if (peerType && peerType !== 'human') return 'proactive';

    // 来源1：agent 配置默认值
    const resolved = this.sessionModeResolver?.(channel, ct, peerType);
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
   * 需要明确的 channelType + selfAID 才能确定路径。
   */
  private resolveChatDir(channel: string, channelId: string, channelType: string, selfAID?: string): string {
    return chatDirPath(this.sessionsDir, channelType, channelId, selfAID);
  }

  /**
   * 给定明确的 channelType + selfAID 时直接计算路径（不扫描）。
   * 用于 caller 已经知道完整路由信息的场景（如 message-bridge 透传）。
   */
  private resolveChatDirExact(channel: string, channelId: string, channelType: string, selfAID?: string): string {
    return chatDirPath(this.sessionsDir, channelType, channelId, selfAID);
  }

  private resolveChatDirFromSession(session: Session): string {
    if (!session.channelType) {
      throw new Error(`[SessionManager] missing channelType for session ${session.id}`);
    }
    return chatDirPath(this.sessionsDir, session.channelType, session.channelId, session.selfAID);
  }

  /** Public accessor: get the chat directory path for a session (for message log etc.) */
  getChatDir(session: Session): string {
    return this.resolveChatDirFromSession(session);
  }

  /** Like resolveChatDir but also ensures the dir + _threads + _trash exist. */
  private ensureResolvedChatDir(channel: string, channelId: string, channelType: string, selfAID?: string): string {
    const dir = this.resolveChatDir(channel, channelId, channelType, selfAID);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, '_threads'), { recursive: true });
    fs.mkdirSync(path.join(dir, '_trash'), { recursive: true });
    return dir;
  }

  /**
   * 扫描已有 chat 目录，找到匹配 channel+channelId 的目录并返回其 chatDir 路径。
   * 用于不知道 channelType/selfAID 的 caller 在调用 resolveChatDir 前定位已有目录。
   */
  private findExistingChatDir(channel: string, channelId: string): string | undefined {
    const dirs = scanChatDirs(this.sessionsDir);
    for (const d of dirs) {
      if (d.channelId !== channelId) continue;
      const active = readJsonFile<SessionFile>(path.join(d.dirPath, 'active.json'));
      if (active && active.channel === channel) return d.dirPath;
      // 即使没有 active.json，也检查 meta 文件
      const metaFiles = scanMetaFiles(d.dirPath);
      for (const mf of metaFiles) {
        const meta = readLastJsonlLine<SessionFile>(path.join(d.dirPath, mf));
        if (meta && meta.channel === channel) return d.dirPath;
      }
      // 仅 thread session 场景：主目录无 active.json 也无 main meta，但 _threads/ 有内容
      const threadsDir = path.join(d.dirPath, '_threads');
      if (fs.existsSync(threadsDir)) {
        const threadMetas = scanMetaFiles(threadsDir);
        for (const mf of threadMetas) {
          const meta = readLastJsonlLine<SessionFile>(path.join(threadsDir, mf));
          if (meta && meta.channel === channel) return d.dirPath;
        }
      }
    }
    return undefined;
  }

  /**
   * 安全版 resolveChatDir：先尝试用提供的 channelType/selfAID，
   * 如果没有则扫描已有目录推断。用于操作已有 session 的公共方法。
   */
  private resolveChatDirSafe(channel: string, channelId: string, channelType?: string, selfAID?: string): string {
    if (channelType && (selfAID || channelType !== 'aun')) {
      return this.resolveChatDir(channel, channelId, channelType, selfAID);
    }
    // 尝试从已有目录推断
    const existingDir = this.findExistingChatDir(channel, channelId);
    if (existingDir) return existingDir;
    throw new Error(`[SessionManager] Cannot resolve chat dir for channel="${channel}" channelId="${channelId}". No channelType/selfAID provided and no existing session found.`);
  }

  /**
   * 安全版 ensureResolvedChatDir：先尝试用提供的 channelType/selfAID，
   * 如果没有则扫描已有目录推断。确保目录存在。
   */
  private ensureResolvedChatDirSafe(channel: string, channelId: string, channelType?: string, selfAID?: string): string {
    if (channelType && (selfAID || channelType !== 'aun')) {
      return this.ensureResolvedChatDir(channel, channelId, channelType, selfAID);
    }
    // 尝试从已有目录推断
    const existingDir = this.findExistingChatDir(channel, channelId);
    if (existingDir) {
      // 确保子目录存在
      fs.mkdirSync(existingDir, { recursive: true });
      fs.mkdirSync(path.join(existingDir, '_threads'), { recursive: true });
      fs.mkdirSync(path.join(existingDir, '_trash'), { recursive: true });
      return existingDir;
    }
    throw new Error(`[SessionManager] Cannot resolve chat dir for channel="${channel}" channelId="${channelId}". No channelType/selfAID provided and no existing session found.`);
  }

  private readActive(channel: string, channelId: string, channelType?: string, selfAID?: string): Session | undefined {
    let dir: string;
    if (channelType && selfAID) {
      dir = this.resolveChatDir(channel, channelId, channelType, selfAID);
    } else {
      const existingDir = this.findExistingChatDir(channel, channelId);
      if (!existingDir) return undefined;
      dir = existingDir;
    }
    const file = readJsonFile<SessionFile>(path.join(dir, 'active.json'));
    if (!file) return undefined;
    return fileToSession(file);
  }

  private writeActive(channel: string, channelId: string, session: Session): void {
    const dir = this.ensureChatDirForSession(session);
    const file = sessionToFile(session);
    atomicWriteJson(path.join(dir, 'active.json'), file);
  }

  private clearActive(channel: string, channelId: string, channelType?: string, selfAID?: string): void {
    let dir: string;
    if (channelType && selfAID) {
      dir = this.resolveChatDir(channel, channelId, channelType, selfAID);
    } else {
      const existingDir = this.findExistingChatDir(channel, channelId);
      if (!existingDir) return;
      dir = existingDir;
    }
    const activePath = path.join(dir, 'active.json');
    try { fs.unlinkSync(activePath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }

  private ensureChatDirForSession(session: Session): string {
    const channelType = session.channelType || session.channel;
    return ensureChatDir(this.sessionsDir, channelType, session.channelId, session.selfAID);
  }

  private metaFilePath(chatDir: string, sessionId: string): string {
    return path.join(chatDir, `${sessionId}.jsonl`);
  }

  /** 由 session 自身的 channelType/channelId/selfId/threadId 直接定位其 .jsonl 路径（不扫描目录）。 */
  private metaPathForSession(session: Session): string {
    const dir = this.ensureChatDirForSession(session);
    const targetDir = session.threadId ? path.join(dir, '_threads') : dir;
    return this.metaFilePath(targetDir, session.id);
  }

  private appendMeta(channel: string, channelId: string, session: Session): void {
    const file = sessionToFile(session);
    appendJsonl(this.metaPathForSession(session), file);
  }

  /**
   * Session 持久化的唯一事务原语。所有 session 写操作都应经此，业务层不直接调
   * appendMeta / writeActive。
   *
   * 契约：.jsonl 是权威源，active.json 是热缓存。
   *   1. 内建 diff 去重：与该 session 的 .jsonl 末行比较（忽略 updatedAt），无变化则跳过
   *   2. appendMeta(.jsonl) —— 始终先落历史档案（权威源）
   *   3. 按 intent 决定 active.json 行为：
   *      - 'set'  : 无条件让该 session 成为 active（创建/切换主会话）
   *      - 'sync' : 仅当该 session 已是当前 active 时同步缓存（更新自身字段）
   *      - 'none' : 不碰 active.json（thread 会话 / 后台 autonomous 会话）
   *
   * @param session   要持久化的 session（其 updatedAt 会被刷新）
   * @param intent    active.json 行为意图
   * @param opts.forceWrite  强制写入一条新记录，跳过去重。用于 markProcessing/clearProcessing
   *                         这类"状态转换事件必须留痕"的场景。
   * @returns 是否真的写入了 .jsonl（去重命中时返回 false）
   */
  private persistSession(
    session: Session,
    intent: 'set' | 'sync' | 'none',
    opts?: { forceWrite?: boolean }
  ): boolean {
    if (!opts?.forceWrite) {
      const lastMeta = readLastJsonlLine<SessionFile>(this.metaPathForSession(session));
      if (lastMeta && this.sessionFilesEqual(lastMeta, sessionToFile(session))) {
        // .jsonl 末行已与目标一致：仍可能需要把缓存对齐（'set' 语义）
        if (intent === 'set') {
          session.updatedAt = Date.now();
          this.writeActive(session.channel, session.channelId, session);
        }
        return false;
      }
    }
    session.updatedAt = Date.now();
    this.appendMeta(session.channel, session.channelId, session);
    if (intent === 'set') {
      this.writeActive(session.channel, session.channelId, session);
    } else if (intent === 'sync') {
      const active = this.readActive(session.channel, session.channelId);
      if (active && active.id === session.id) {
        this.writeActive(session.channel, session.channelId, session);
      }
    }
    return true;
  }

  /**
   * 比较两个 SessionFile 是否在内容上相等（忽略 updatedAt / updatedAtStr）。
   * 用于跳过"没真变化"的写入，避免 jsonl 写放大。
   */
  private sessionFilesEqual(a: ReturnType<typeof sessionToFile>, b: ReturnType<typeof sessionToFile>): boolean {
    const stripVolatile = ({ updatedAt, updatedAtStr, ...rest }: ReturnType<typeof sessionToFile>) => rest;
    return JSON.stringify(stripVolatile(a)) === JSON.stringify(stripVolatile(b));
  }

  private readMetaLatest(metaFilePath: string): Session | undefined {
    const file = readLastJsonlLine<SessionFile>(metaFilePath);
    if (!file) return undefined;
    return fileToSession(file);
  }

  /**
   * 为 by-sessionId 改方法加载"当前 session 状态"。
   *
   * 设计契约（docs/refactor/01-db-to-fs.md）：
   *   active.json 是热路径权威源。.jsonl 是历史档案。
   *
   * 读取策略：
   *   1. 先按 sessionId 定位 .jsonl 文件（确认 session 存在 + 拿到 channel/channelId）
   *   2. 优先读 active.json（如果 active.id === sessionId）—— 当前状态
   *   3. 否则 fallback 到 .jsonl 末行 —— 非活跃 session 的更新（如多 session 并存时改非 active 那个）
   *
   * 返回 { current }：caller 修改后交给 persistSession 写回（去重由 persistSession 内建）。
   */
  private loadSessionForUpdate(sessionId: string): { current: Session } | undefined {
    const found = this.findSessionFileById(sessionId);
    if (!found) return undefined;

    // 先读 .jsonl 末行拿 channel/channelId（active.json 文件路径需要这两个）
    const fromJsonl = this.readMetaLatest(found.metaPath);
    if (!fromJsonl) return undefined;

    // 优先用 active.json 的当前状态（如果它就是这个 sessionId）
    const active = this.readActive(fromJsonl.channel, fromJsonl.channelId);
    const base = (active && active.id === sessionId) ? active : fromJsonl;

    const current: Session = JSON.parse(JSON.stringify(base));
    return { current };
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
    this.persistSession(session, 'sync');
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
    const found = this.findSessionFileById(sessionId);
    if (!found) return;
    const session = this.readMetaLatest(found.metaPath);
    if (!session) return;
    session.processingState = state;
    this.persistSession(session, 'sync', { forceWrite: true });
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
    const found = this.findSessionFileById(sessionId);
    if (!found) { this.sessionEncryptState.delete(sessionId); return; }
    const session = this.readMetaLatest(found.metaPath);
    if (!session) { this.sessionEncryptState.delete(sessionId); return; }
    // 仅当 .jsonl 末行确实有 activeTask 时才写（避免写放大）
    if (session.processingState) {
      session.processingState = undefined;
      this.persistSession(session, 'sync', { forceWrite: true });
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
      for (const metaFile of scanMetaFiles(dirPath)) {
        const session = this.readMetaLatest(path.join(dirPath, metaFile));
        if (!session?.processingState) continue;
        const colonIdx = session.processingState.indexOf(':');
        const ts = parseInt(colonIdx > 0 ? session.processingState.slice(0, colonIdx) : session.processingState, 10);
        if (!isNaN(ts) && (now - ts) < maxAgeMs) {
          result.push(session);
        } else {
          this.clearProcessing(session.id);
        }
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
    selfAID?: string,
    channelType?: string,
    peerType?: string
  ): Promise<Session> {
    if (!selfAID && channelType === 'aun') {
      throw new Error(`[SessionManager] getOrCreateSession requires selfAID for aun channel. channelId="${channelId}"`);
    }
    if (!channelType) {
      throw new Error(`[SessionManager] getOrCreateSession requires channelType. channel="${channel}" channelId="${channelId}"`);
    }
    if (threadId) {
      const session = this.getOrCreateThreadSession(channel, channelId, threadId, defaultProjectPath, metadata, name, agentId, selfAID, channelType, peerType);
      session.identity = this.resolveIdentity(channel, userId);
      if (session.metadata && !session.metadata.permissionMode) {
        session.metadata.permissionMode = DEFAULT_PERMISSION_MODE;
        this.persistSession(session, 'none');
      }
      return session;
    }

    // 使用精确路径解析（caller 提供了 channelType 时直接定位，避免扫描回落）
    const exactDir = this.resolveChatDirExact(channel, channelId, channelType, selfAID);
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

      if (session.selfAID !== selfAID) {
        session.selfAID = selfAID;
        mutated = true;
      }

      if (chatType === 'private' && userId) {
        if (!session.metadata) session.metadata = {};
        if (!session.metadata.peerId) { session.metadata.peerId = userId; mutated = true; }
        if (!session.metadata.peerName && metadata?.peerName) { session.metadata.peerName = metadata.peerName; mutated = true; }
        if (metadata?.channelKey && session.metadata.channelKey !== metadata.channelKey) { session.metadata.channelKey = metadata.channelKey; mutated = true; }
      }
      if (metadata?.channelKey && chatType !== 'private') {
        if (!session.metadata) session.metadata = {};
        if (session.metadata.channelKey !== metadata.channelKey) {
          session.metadata.channelKey = metadata.channelKey;
          mutated = true;
        }
      }
      if (mutated) {
        this.persistSession(session, 'sync');
      }
      return session;
    }

    // Find existing session for default project path
    const chatDir = this.resolveChatDir(channel, channelId, channelType, selfAID);
    const allSessions = this.findAllSessionsInChat(chatDir, false);
    const existing = allSessions
      .filter(s => s.projectPath === defaultProjectPath && !s.threadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (existing) {
      const validSessionId = this.validateSessionFile(existing);
      const session: Session = { ...existing, agentSessionId: validSessionId };
      session.identity = this.resolveIdentity(channel, userId);

      if (!session.metadata) session.metadata = {};
      if (session.selfAID !== selfAID) {
        session.selfAID = selfAID;
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
      this.persistSession(session, 'sync');
      return session;
    }

    // Create new session
    const sessionMetadata: any = { ...(metadata || {}) };
    if (!sessionMetadata.permissionMode) sessionMetadata.permissionMode = DEFAULT_PERMISSION_MODE;

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType,
      channelId,
      selfAID,
      projectPath: defaultProjectPath,
      threadId: '',
      agentId: agentId || 'claude',
      sessionKey: formatSessionKey(channelType, channelId, DEFAULT_THREAD_ID),
      chatType: chatType || 'private',
      sessionMode: this.resolveDefaultSessionMode(channel, chatType || 'private', peerType),
      metadata: sessionMetadata,
      name: name || '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    session.identity = this.resolveIdentity(channel, userId);

    this.persistSession(session, 'set');
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
    const loaded = this.loadSessionForUpdate(sessionId);
    if (!loaded) return;
    const { current } = loaded;

    if (updates.chatType !== undefined) current.chatType = updates.chatType;
    if (updates.name !== undefined) current.name = updates.name;
    if (updates.sessionMode !== undefined) current.sessionMode = updates.sessionMode;
    if (updates.metadata !== undefined) current.metadata = updates.metadata;
    if ('agentSessionId' in updates) current.agentSessionId = updates.agentSessionId ?? undefined;

    this.persistSession(current, 'sync');
  }

  private getOrCreateThreadSession(
    channel: string,
    channelId: string,
    threadId: string,
    defaultProjectPath: string,
    metadata?: any,
    name?: string,
    agentId?: string,
    selfAID?: string,
    channelType?: string,
    peerType?: string
  ): Session {
    // 使用精确路径（channelType + selfAID）
    const chatDir = (channelType && selfAID)
      ? (() => { const d = chatDirPath(this.sessionsDir, channelType, channelId, selfAID); fs.mkdirSync(d, { recursive: true }); fs.mkdirSync(path.join(d, '_threads'), { recursive: true }); return d; })()
      : this.ensureResolvedChatDirSafe(channel, channelId, channelType, selfAID);
    const threadIndex = readThreadIndex(chatDir);
    const existingEntry = threadIndex[threadId];

    if (existingEntry) {
      const metaPath = path.join(chatDir, '_threads', `${existingEntry.sessionId}.jsonl`);
      const existing = this.readMetaLatest(metaPath);
      if (existing) {
        const validSessionId = this.validateSessionFile(existing);
        if (metadata) {
          existing.metadata = { ...(existing.metadata || {}), ...metadata };
          this.persistSession(existing, 'none');
        }
        return { ...existing, agentSessionId: validSessionId };
      }
    }

    // Inherit project path & chatType from active main session
    const activeMain = this.readActive(channel, channelId, channelType, selfAID);
    const projectPath = (activeMain && !activeMain.threadId ? activeMain.projectPath : undefined) || defaultProjectPath;
    const inheritedChatType = (activeMain && !activeMain.threadId ? activeMain.chatType : undefined) || 'private';

    const effectiveChannelType = channelType || channel;
    const sessionKey = formatSessionKey(effectiveChannelType, channelId, threadId);

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType: effectiveChannelType,
      channelId,
      selfAID: selfAID || '',
      projectPath,
      threadId,
      agentId: agentId || 'claude',
      sessionKey,
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType, peerType),
      metadata,
      name: name || '话题会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.persistSession(session, 'none');
    threadIndex[threadId] = {
      sessionId: session.id,
      sessionKey,
      metaFile: `${session.id}.jsonl`,
    };
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

    const chatDir = this.ensureResolvedChatDirSafe(channel, channelId);
    const allSessions = this.findAllSessionsInChat(chatDir, false);
    const target = allSessions
      .filter(s => s.projectPath === newProjectPath && (s.agentId || 'claude') === agentId && !s.threadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (target) {
      const validSessionId = this.validateSessionFile(target);
      target.agentSessionId = validSessionId;
      this.persistSession(target, 'set');
      return target;
    }

    // Derive selfAID and channelType from existing sessions in this chatDir
    const existingAny = allSessions[0];
    const selfAID = existingAny?.selfAID || '';
    const channelType = existingAny?.channelType || channel;

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType,
      channelId,
      selfAID,
      projectPath: newProjectPath,
      threadId: '',
      agentId,
      sessionKey: formatSessionKey(channelType, channelId, DEFAULT_THREAD_ID),
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      metadata: {},
      name: '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.persistSession(session, 'set');
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
    this.persistSession(active, 'sync');
  }

  async updateAgentSessionIdBySessionId(sessionId: string, agentSessionId: string): Promise<void> {
    const loaded = this.loadSessionForUpdate(sessionId);
    if (!loaded) return;
    const { current } = loaded;
    current.agentSessionId = agentSessionId;
    const wrote = this.persistSession(current, 'sync');
    if (wrote) {
      logger.info(`[SessionManager] Updating agent_session_id: sessionId=${sessionId}, agentSessionId=${agentSessionId}`);
    }
  }

  async switchAgent(channel: string, channelId: string, projectPath: string, newAgentId: string): Promise<Session> {
    const inheritedChatType = this.getActiveChatType(channel, channelId);
    // Derive channelType/selfAID from existing sessions; fall back to channel name
    const probeChatDir = this.resolveChatDir(channel, channelId, channel, '');
    const probeSessions = fs.existsSync(probeChatDir) ? this.findAllSessionsInChat(probeChatDir, false) : [];
    const existingAny = probeSessions[0];
    const channelType = existingAny?.channelType || channel;
    const selfAID = existingAny?.selfAID || '';
    const chatDir = this.ensureResolvedChatDir(channel, channelId, channelType, selfAID);
    const allSessions = this.findAllSessionsInChat(chatDir, false);
    const target = allSessions
      .filter(s => s.projectPath === projectPath && (s.agentId || 'claude') === newAgentId && !s.threadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (target) {
      const validSessionId = this.validateSessionFile(target);
      target.agentSessionId = validSessionId;
      this.persistSession(target, 'set');
      return target;
    }

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType,
      channelId,
      selfAID,
      projectPath,
      threadId: '',
      agentId: newAgentId,
      sessionKey: formatSessionKey(channelType, channelId, DEFAULT_THREAD_ID),
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      metadata: {},
      name: '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.persistSession(session, 'set');
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
    this.persistSession(active, 'sync');
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

  /** 同步版 getActiveSession，支持精确路径定位（避免扫描） */
  getActiveSessionSync(channel: string, channelId: string, channelType?: string, selfAID?: string): Session | undefined {
    return this.readActive(channel, channelId, channelType, selfAID);
  }

  async getThreadSession(channel: string, channelId: string, threadId: string): Promise<Session | undefined> {
    let chatDir: string;
    try {
      chatDir = this.resolveChatDirSafe(channel, channelId);
    } catch {
      return undefined;
    }
    const threadIndex = readThreadIndex(chatDir);
    const entry = threadIndex[threadId];
    if (!entry) return undefined;
    const metaPath = path.join(chatDir, '_threads', `${entry.sessionId}.jsonl`);
    const session = this.readMetaLatest(metaPath);
    if (!session) return undefined;
    const validSessionId = this.validateSessionFile(session);
    return { ...session, agentSessionId: validSessionId };
  }

  async listSessions(channel: string, channelId: string): Promise<Session[]> {
    let chatDir: string;
    try {
      chatDir = this.resolveChatDirSafe(channel, channelId);
    } catch {
      return [];
    }
    const sessions = this.findAllSessionsInChat(chatDir, true);
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSessionByProjectPath(channel: string, channelId: string, projectPath: string): Promise<Session | undefined> {
    let chatDir: string;
    try {
      chatDir = this.resolveChatDirSafe(channel, channelId);
    } catch {
      return undefined;
    }
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
    let chatDir: string;
    try {
      chatDir = this.resolveChatDirSafe(channel, channelId);
    } catch {
      return undefined;
    }
    const sessions = this.findAllSessionsInChat(chatDir, true);
    return sessions.find(s => s.name === name);
  }

  async switchToSession(channel: string, channelId: string, targetSessionId: string): Promise<Session | null> {
    let chatDir: string;
    try {
      chatDir = this.resolveChatDirSafe(channel, channelId);
    } catch {
      return null;
    }
    const sessions = this.findAllSessionsInChat(chatDir, true);
    const target = sessions.find(s => s.id === targetSessionId);
    if (!target) return null;

    this.persistSession(target, 'set');
    return target;
  }

  updateMetadata(sessionId: string, metadata: Record<string, any>): void {
    const loaded = this.loadSessionForUpdate(sessionId);
    if (!loaded) return;
    const { current } = loaded;
    current.metadata = metadata;
    this.persistSession(current, 'sync');
  }

  async renameSession(sessionId: string, newName: string): Promise<boolean> {
    const loaded = this.loadSessionForUpdate(sessionId);
    if (!loaded) return false;
    const { current } = loaded;
    current.name = newName;
    this.persistSession(current, 'sync');
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
      for (const [tid, entry] of Object.entries(threadIndex)) {
        if (entry.sessionId === sessionId) { delete threadIndex[tid]; break; }
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

    // Derive selfAID and channelType from existing sessions
    const existingDir = this.findExistingChatDir(channel, channelId);
    let channelType = channel;
    let selfAID = '';
    if (existingDir) {
      const active = readJsonFile<SessionFile>(path.join(existingDir, 'active.json'));
      if (active) {
        channelType = active.channelType || channel;
        selfAID = active.selfAID || '';
      }
    }

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType,
      channelId,
      selfAID,
      projectPath,
      threadId: '',
      agentId: agentId || 'claude',
      sessionKey: formatSessionKey(channelType, channelId, DEFAULT_THREAD_ID),
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      metadata: { permissionMode: DEFAULT_PERMISSION_MODE },
      name: name || '默认会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.persistSession(session, 'set');
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
    const channelType = sourceSession.channelType || sourceSession.channel;
    const threadId = sourceSession.threadId || '';
    const session: Session = {
      id: generateSessionId(),
      channel: sourceSession.channel,
      channelType,
      channelId: sourceSession.channelId,
      selfAID: sourceSession.selfAID,
      projectPath: sourceSession.projectPath,
      threadId,
      agentId: sourceSession.agentId || 'claude',
      sessionKey: formatSessionKey(channelType, sourceSession.channelId, threadId || DEFAULT_THREAD_ID),
      chatType: sourceSession.chatType || 'private',
      sessionMode: sourceSession.sessionMode || 'interactive',
      agentSessionId: forkedAgentSessionId,
      metadata: { permissionMode: sourceSession.metadata?.permissionMode || DEFAULT_PERMISSION_MODE },
      name: name || `${sourceSession.name || '会话'}-分支`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.persistSession(session, 'set');
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
    const chatDir = this.resolveChatDirSafe(channel, channelId);
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

    // Derive selfAID and channelType from existing sessions
    const existingDir = this.findExistingChatDir(channel, channelId);
    let channelType = channel;
    let selfAID = '';
    if (existingDir) {
      const active = readJsonFile<SessionFile>(path.join(existingDir, 'active.json'));
      if (active) {
        channelType = active.channelType || channel;
        selfAID = active.selfAID || '';
      }
    }

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType,
      channelId,
      selfAID,
      projectPath,
      threadId: '',
      agentId,
      sessionKey: formatSessionKey(channelType, channelId, DEFAULT_THREAD_ID),
      chatType: inheritedChatType,
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType),
      agentSessionId,
      metadata: {},
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.persistSession(session, 'set');
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
    return path.join(this.ensureResolvedChatDirSafe(channel, channelId), 'health.jsonl');
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

  /**
   * Migrate session channel key from old format "{selfPeerId}#{type}#{name}"
   * to new format "{type}#{selfPeerId}#{name}".
   * Runs once at startup, rewrites active.json and meta_*.jsonl in-place.
   */
  private migrateChannelKeyFormat(): void {
    const chatDirs = scanChatDirs(this.sessionsDir);
    let migrated = 0;

    for (const { dirPath } of chatDirs) {
      const activePath = path.join(dirPath, 'active.json');
      const active = readJsonFile<SessionFile>(activePath);
      if (!active?.channel) continue;

      const newKey = this.convertOldChannelKey(active.channel);
      if (!newKey) continue;

      // Rewrite active.json
      active.channel = newKey;
      atomicWriteJson(activePath, active);

      // Rewrite meta_*.jsonl files
      const metaFiles = scanMetaFiles(dirPath);
      for (const metaFile of metaFiles) {
        const metaPath = path.join(dirPath, metaFile);
        const lines = readAllJsonlLines<any>(metaPath);
        if (!lines.length) continue;
        let changed = false;
        for (const line of lines) {
          if (line.channel && this.convertOldChannelKey(line.channel)) {
            line.channel = this.convertOldChannelKey(line.channel);
            changed = true;
          }
        }
        if (changed) {
          const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
          fs.writeFileSync(metaPath, content, 'utf-8');
        }
      }
      migrated++;
    }

    if (migrated > 0) {
      logger.info(`[SessionManager] Migrated ${migrated} session(s) to new channelKey format`);
    }
  }

  /**
   * Detect old format "selfPeerId#type#name" and convert to "type#selfPeerId#name".
   * Returns null if already in new format or not a valid key.
   */
  private convertOldChannelKey(key: string): string | null {
    const parts = key.split('#');
    if (parts.length !== 3) return null;
    const [first, second, third] = parts;
    // New format: type#selfPeerId#name — type is short (aun, feishu, wechat, etc.)
    // Old format: selfPeerId#type#name — selfPeerId contains '.' (e.g., evolai.agentid.pub)
    const knownTypes = ['aun', 'feishu', 'wechat', 'dingtalk', 'qqbot', 'wecom'];
    if (knownTypes.includes(first)) return null; // already new format
    if (knownTypes.includes(second) && first.includes('.')) {
      return `${second}#${first}#${third}`;
    }
    return null;
  }
}
