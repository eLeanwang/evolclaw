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

    // 来源3：非 human 对端（ai/bot）强制 proactive，无视 agent 的默认 chatmode 配置
    if (peerType && peerType !== 'human' && peerType !== 'unknown') return 'proactive';

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
   * 1. 先扫描所有 chat 目录，按 channelId 查找匹配项（同时 channelType==channel 或缺失时直接 channelId 匹配）
   * 2. 找不到则按 fallback：channelType=channel（实例名），selfId=null
   *
   * 这样保持兼容：不知道 channelType 的 caller 仍可以用 (channel, channelId) 调用。
   */
  private resolveChatDir(channel: string, channelId: string, channelType?: string, selfId?: string): string {
    // 必须有明确 channelType 才能确定路径
    if (!channelType) {
      throw new Error(`[SessionManager] resolveChatDir requires channelType. Got channel="${channel}" channelId="${channelId}". Caller must pass channelType (e.g. 'aun', 'feishu').`);
    }
    return chatDirPath(this.sessionsDir, channelType, channelId, selfId);
  }

  /**
   * 给定明确的 channelType + selfId 时直接计算路径（不扫描）。
   * 用于 caller 已经知道完整路由信息的场景（如 message-bridge 透传）。
   */
  private resolveChatDirExact(channel: string, channelId: string, channelType?: string, selfId?: string): string {
    if (channelType) {
      return chatDirPath(this.sessionsDir, channelType, channelId, selfId);
    }
    return this.resolveChatDirSafe(channel, channelId);
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
  private ensureResolvedChatDir(channel: string, channelId: string, channelType?: string, selfId?: string): string {
    const dir = this.resolveChatDir(channel, channelId, channelType, selfId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, '_threads'), { recursive: true });
    fs.mkdirSync(path.join(dir, '_trash'), { recursive: true });
    return dir;
  }

  /** 推断给定 chat 的 channelType（优先取 active.json）。无活跃时回落到 channel 实例名。 */
  private inferChannelType(channel: string, channelId: string, chatDir?: string): string {
    if (chatDir) {
      const active = readJsonFile<SessionFile>(path.join(chatDir, 'active.json'));
      if (active?.channelType) return active.channelType;
    }
    // 扫描已有目录
    const dirs = scanChatDirs(this.sessionsDir);
    for (const d of dirs) {
      if (d.channelId !== channelId) continue;
      const active = readJsonFile<SessionFile>(path.join(d.dirPath, 'active.json'));
      if (active && active.channel === channel && active.channelType) return active.channelType;
    }
    throw new Error(`[SessionManager] Cannot infer channelType for channel="${channel}" channelId="${channelId}". No existing session found.`);
  }

  /** 从 active 推断 selfId（已有 session 的复用） */
  private inferSelfId(channel: string, channelId: string, chatDir?: string): string | undefined {
    if (chatDir) {
      const active = readJsonFile<SessionFile>(path.join(chatDir, 'active.json'));
      if (active?.selfId) return active.selfId;
    }
    // 扫描已有目录
    const dirs = scanChatDirs(this.sessionsDir);
    for (const d of dirs) {
      if (d.channelId !== channelId) continue;
      const active = readJsonFile<SessionFile>(path.join(d.dirPath, 'active.json'));
      if (active && active.channel === channel) return active.selfId || undefined;
    }
    return undefined;
  }

  /**
   * 扫描已有 chat 目录，找到匹配 channel+channelId 的目录并返回其 chatDir 路径。
   * 用于不知道 channelType/selfId 的 caller 在调用 resolveChatDir 前定位已有目录。
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
   * 安全版 resolveChatDir：先尝试用提供的 channelType/selfId，
   * 如果没有则扫描已有目录推断。用于操作已有 session 的公共方法。
   */
  private resolveChatDirSafe(channel: string, channelId: string, channelType?: string, selfId?: string): string {
    if (channelType) {
      return this.resolveChatDir(channel, channelId, channelType, selfId);
    }
    // 尝试从已有目录推断
    const existingDir = this.findExistingChatDir(channel, channelId);
    if (existingDir) return existingDir;
    throw new Error(`[SessionManager] Cannot resolve chat dir for channel="${channel}" channelId="${channelId}". No channelType provided and no existing session found.`);
  }

  /**
   * 安全版 ensureResolvedChatDir：先尝试用提供的 channelType/selfId，
   * 如果没有则扫描已有目录推断。确保目录存在。
   */
  private ensureResolvedChatDirSafe(channel: string, channelId: string, channelType?: string, selfId?: string): string {
    if (channelType) {
      return this.ensureResolvedChatDir(channel, channelId, channelType, selfId);
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
    // 回退：推断 channelType 和 selfId
    const inferredType = this.inferChannelType(channel, channelId);
    const inferredSelfId = this.inferSelfId(channel, channelId);
    return this.ensureResolvedChatDir(channel, channelId, inferredType, inferredSelfId);
  }

  private readActive(channel: string, channelId: string, channelType?: string, selfId?: string): Session | undefined {
    let dir: string;
    try {
      dir = this.resolveChatDir(channel, channelId, channelType, selfId);
    } catch {
      // channelType not provided — try to find existing dir
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

  private clearActive(channel: string, channelId: string, channelType?: string, selfId?: string): void {
    let dir: string;
    try {
      dir = this.resolveChatDir(channel, channelId, channelType, selfId);
    } catch {
      const existingDir = this.findExistingChatDir(channel, channelId);
      if (!existingDir) return;
      dir = existingDir;
    }
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

  /**
   * 比较两个 SessionFile 是否在内容上相等（忽略 updatedAt / updatedAtStr）。
   * 用于跳过"没真变化"的写入，避免 jsonl 写放大。
   */
  private sessionFilesEqual(a: ReturnType<typeof sessionToFile>, b: ReturnType<typeof sessionToFile>): boolean {
    const stripVolatile = ({ updatedAt, updatedAtStr, ...rest }: ReturnType<typeof sessionToFile>) => rest;
    return JSON.stringify(stripVolatile(a)) === JSON.stringify(stripVolatile(b));
  }

  /**
   * Append meta + write active.json，但只在 session 内容（除 updatedAt 外）真正变化时才写。
   * prev 是修改前的快照（用于 diff），next 是修改后的 session。
   * 返回是否发生了写入。
   */
  private writeSessionIfChanged(channel: string, channelId: string, prev: Session | undefined, next: Session): boolean {
    if (prev) {
      const prevFile = sessionToFile(prev);
      const nextFile = sessionToFile(next);
      if (this.sessionFilesEqual(prevFile, nextFile)) return false;
    }
    next.updatedAt = Date.now();
    this.appendMeta(channel, channelId, next);
    const active = this.readActive(channel, channelId);
    if (active && active.id === next.id) {
      // 保留 active.json 中已有的 activeTask（markProcessing 写入的处理状态）
      if (active.processingState && !next.processingState) {
        next.processingState = active.processingState;
      }
      this.writeActive(channel, channelId, next);
    }
    return true;
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
   * 返回 { current, prev }：
   *   - current 用于 caller 修改后写回
   *   - prev 是 current 的初始快照（用于 writeSessionIfChanged 的 diff 检查）
   */
  private loadSessionForUpdate(sessionId: string): { current: Session; prev: Session } | undefined {
    const found = this.findSessionFileById(sessionId);
    if (!found) return undefined;

    // 先读 .jsonl 末行拿 channel/channelId（active.json 文件路径需要这两个）
    const fromJsonl = this.readMetaLatest(found.metaPath);
    if (!fromJsonl) return undefined;

    // 优先用 active.json 的当前状态（如果它就是这个 sessionId）
    const active = this.readActive(fromJsonl.channel, fromJsonl.channelId);
    const base = (active && active.id === sessionId) ? active : fromJsonl;

    // 深拷贝避免 caller 改 current 时污染 prev
    const current: Session = JSON.parse(JSON.stringify(base));
    const prev: Session = JSON.parse(JSON.stringify(base));
    return { current, prev };
  }

  private validateSessionFile(session: Session): string | undefined {
    const agentSessionId = session.agentSessionId;
    if (!agentSessionId) return undefined;
    const agentId = session.agentId || 'claude';
    const adapter = this.getFileAdapter(agentId);
    if (!adapter) return agentSessionId;
    if (adapter.checkExists(session.projectPath, agentSessionId)) return agentSessionId;
    logger.warn(`Session file not found for ${agentId}: ${agentSessionId}, clearing session ID`);
    const prev: Session = JSON.parse(JSON.stringify(session));
    session.agentSessionId = undefined;
    this.writeSessionIfChanged(session.channel, session.channelId, prev, session);
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
    channelType?: string,
    peerType?: string
  ): Promise<Session> {
    if (threadId) {
      const session = this.getOrCreateThreadSession(channel, channelId, threadId, defaultProjectPath, metadata, name, agentId, selfId, channelType, peerType);
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
    const chatDir = this.resolveChatDir(channel, channelId, channelType, selfId);
    const allSessions = this.findAllSessionsInChat(chatDir, false);
    const existing = allSessions
      .filter(s => s.projectPath === defaultProjectPath && !s.threadId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (existing) {
      const validSessionId = this.validateSessionFile(existing);
      const prev: Session = JSON.parse(JSON.stringify({ ...existing, agentSessionId: validSessionId }));
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
      this.writeSessionIfChanged(channel, channelId, prev, session);
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
      sessionMode: this.resolveDefaultSessionMode(channel, chatType || 'private', peerType),
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
    const loaded = this.loadSessionForUpdate(sessionId);
    if (!loaded) return;
    const { current, prev } = loaded;

    if (updates.chatType !== undefined) current.chatType = updates.chatType;
    if (updates.name !== undefined) current.name = updates.name;
    if (updates.sessionMode !== undefined) current.sessionMode = updates.sessionMode;
    if (updates.metadata !== undefined) current.metadata = updates.metadata;
    if ('agentSessionId' in updates) current.agentSessionId = updates.agentSessionId ?? undefined;

    this.writeSessionIfChanged(current.channel, current.channelId, prev, current);
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
    channelType?: string,
    peerType?: string
  ): Session {
    // 优先使用精确路径（channelType + selfId），避免 fallback 到错误目录
    const chatDir = (channelType && selfId)
      ? (() => { const d = chatDirPath(this.sessionsDir, channelType, channelId, selfId); fs.mkdirSync(d, { recursive: true }); fs.mkdirSync(path.join(d, '_threads'), { recursive: true }); return d; })()
      : this.ensureResolvedChatDirSafe(channel, channelId, channelType);
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
    const activeMain = this.readActive(channel, channelId, channelType, selfId);
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
      sessionMode: this.resolveDefaultSessionMode(channel, inheritedChatType, peerType),
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

    const chatDir = this.ensureResolvedChatDirSafe(channel, channelId);
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
    const prev: Session = JSON.parse(JSON.stringify(active));
    active.agentSessionId = agentSessionId;
    this.writeSessionIfChanged(channel, channelId, prev, active);
  }

  async updateAgentSessionIdBySessionId(sessionId: string, agentSessionId: string): Promise<void> {
    const loaded = this.loadSessionForUpdate(sessionId);
    if (!loaded) return;
    const { current, prev } = loaded;
    current.agentSessionId = agentSessionId;
    const wrote = this.writeSessionIfChanged(current.channel, current.channelId, prev, current);
    if (wrote) {
      logger.info(`[SessionManager] Updating agent_session_id: sessionId=${sessionId}, agentSessionId=${agentSessionId}`);
    }
  }

  async switchAgent(channel: string, channelId: string, projectPath: string, newAgentId: string): Promise<Session> {
    const inheritedChatType = this.getActiveChatType(channel, channelId);
    const chatDir = this.ensureResolvedChatDirSafe(channel, channelId);
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
    const prev: Session = JSON.parse(JSON.stringify(active));
    active.agentSessionId = undefined;
    this.writeSessionIfChanged(channel, channelId, prev, active);
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
    let chatDir: string;
    try {
      chatDir = this.resolveChatDirSafe(channel, channelId);
    } catch {
      return undefined;
    }
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

    target.updatedAt = Date.now();
    this.appendMeta(channel, channelId, target);
    this.writeActive(channel, channelId, target);
    return target;
  }

  updateMetadata(sessionId: string, metadata: Record<string, any>): void {
    const loaded = this.loadSessionForUpdate(sessionId);
    if (!loaded) return;
    const { current, prev } = loaded;
    current.metadata = metadata;
    this.writeSessionIfChanged(current.channel, current.channelId, prev, current);
  }

  async renameSession(sessionId: string, newName: string): Promise<boolean> {
    const loaded = this.loadSessionForUpdate(sessionId);
    if (!loaded) return false;
    const { current, prev } = loaded;
    current.name = newName;
    this.writeSessionIfChanged(current.channel, current.channelId, prev, current);
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

    let inferredType: string;
    let inferredSelfId: string | undefined;
    try {
      inferredType = this.inferChannelType(channel, channelId);
      inferredSelfId = this.inferSelfId(channel, channelId);
    } catch {
      inferredType = channel;
      inferredSelfId = undefined;
    }

    const session: Session = {
      id: generateSessionId(),
      channel,
      channelType: inferredType,
      channelId,
      selfId: inferredSelfId,
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
}
