import { Message, SessionIdentity, SubMessage } from '../../types.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import type { EventBus } from '../event-bus.js';
import { LogicalQueueBridge } from './logical-queue-bridge.js';

type MessageHandler = (message: Message) => Promise<void>;

export interface QueueItemSnapshot {
  status: 'active' | 'pending';
  sessionKey: string;       // 格式：channelType#urlEncode(channelId)#urlEncode(threadId)
  channelType: string;      // 从 sessionKey 解析
  channelId: string;        // 从 sessionKey 解析（解码后，人类可读）
  projectPath: string;      // 从 queueKey 解析（格式：sessionId::projectPath）
  peerName?: string;        // 发送者名称
  preview: string;          // 消息内容（默认 80 字符截断）
  messageId?: string;       // 消息 ID
  elapsedMs?: number;       // 处理时长（仅 active 有值）
}

interface QueuedMessage {
  message: Message;
  projectPath: string;
  agentName: string;
  role?: SessionIdentity['role'];
  resolve: () => void;
  reject: (error: Error) => void;
  parts?: QueuedMessagePart[];
}

interface QueuedMessagePart {
  message: Message;
  projectPath: string;
  agentName: string;
  role?: SessionIdentity['role'];
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PersistedQueueItem {
  message: Message;
  projectPath: string;
  agentName?: string;
  role?: SessionIdentity['role'];
  enqueuedAt?: number;
  parts?: PersistedQueuePart[];
}

interface PersistedQueuePart {
  message: Message;
  projectPath: string;
  agentName?: string;
  role?: SessionIdentity['role'];
  enqueuedAt?: number;
}

interface PersistedQueueBucket {
  queueKey: string;
  items: PersistedQueueItem[];
}

interface PersistedQueueFile {
  version: 1 | 2;
  updatedAt: number;
  queues: PersistedQueueBucket[];
  active?: PersistedQueueBucket[];
}

interface MessageQueueOptions {
  persistencePath?: string;
}

interface ActiveQueueState {
  baseagent?: string;
  peerId?: string;
  messageIds: Set<string>;
}

const DEFAULT_AGENT_NAME = '<unknown>';
const RESTART_RESUME_CONTENT = 'evolclaw 服务已重启，请继续之前未完成的任务。';

export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private processingAgent = new Map<string, string>();  // queueKey → agentName（处理中项目的 agent）
  private externalLocks = new Map<string, Promise<void>>();
  private handler: MessageHandler;
  private activeStates = new Map<string, ActiveQueueState>();  // queueKey → active task state
  private interruptCallback?: (sessionKey: string, baseagent?: string, evolagentName?: string, reason?: 'new_message') => Promise<void>;
  private eventBus?: EventBus;
  private recentMessageIds = new Set<string>();
  private readonly DEDUP_WINDOW = 60_000; // 1 分钟窗口
  private interceptors = new Map<string, (message: Message) => void>();
  private mutedAgents = new Set<string>();  // 禁言的 agent：消息照常入队，但不取出给大模型
  private persistencePath?: string;
  private activeBatches = new Map<string, QueuedMessage>();
  private processingStartTime = new Map<string, number>();  // queueKey → 处理开始时间戳
  private queueKeyToSessionKey = new Map<string, string>();  // queueKey → sessionKey（human-readable 格式）
  /** 逻辑队列桥接：管理出队顺序（响应模式可注入自定义策略，默认 FIFO） */
  private logicalQueue = new LogicalQueueBridge();

  constructor(handler: MessageHandler, options?: MessageQueueOptions) {
    this.handler = handler;
    this.persistencePath = options?.persistencePath;
  }

  /** 暴露逻辑队列桥接，供响应模式系统注入队列工厂 */
  getLogicalQueueBridge(): LogicalQueueBridge {
    return this.logicalQueue;
  }

  setInterruptCallback(callback: (sessionKey: string, baseagent?: string, evolagentName?: string, reason?: 'new_message') => Promise<void>): void {
    this.interruptCallback = callback;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * 注册一次性消息拦截器：下一条来自 sessionKey 的消息不入队、不触发 interrupt，
   * 直接传给 handler。用于 AskUserQuestion 的"手动输入"场景。
   */
  interceptNext(sessionKey: string, handler: (message: Message) => void): void {
    this.interceptors.set(sessionKey, handler);
  }

  /**
   * 取消拦截器（超时或卡片被其他方式回答时调用）
   */
  cancelIntercept(sessionKey: string): void {
    this.interceptors.delete(sessionKey);
  }

  /**
   * 检查消息是否应该处理（去重）
   *
   * 去重 key = `${sessionKey}:${messageId}`，而非裸 messageId。
   * MessageQueue 是进程级单例，被所有 evolagent 共享。AUN 群广播时同一条群消息
   * 会投递给群里每个 evolagent，它们 messageId 相同但 session 不同，必须各处理一次。
   * 裸 messageId 去重会让先入队的 agent 吞掉其他 agent 的消息。
   */
  private shouldProcess(sessionKey: string, message: Message): boolean {
    if (!message.messageId) return true; // 无 ID 的消息不去重
    const dedupKey = `${sessionKey}:${message.messageId}`;
    if (this.recentMessageIds.has(dedupKey)) {
      logger.debug(`[Queue] Duplicate message ${dedupKey}, skipping`);
      return false;
    }
    this.recentMessageIds.add(dedupKey);
    setTimeout(() => this.recentMessageIds.delete(dedupKey), this.DEDUP_WINDOW);
    return true;
  }

  /**
   * 检查队列 key 是否属于指定 sessionKey
   */
  private matchesSession(key: string, sessionKey: string): boolean {
    return this.sessionKeyFromQueueKey(key) === sessionKey;
  }

  /**
   * 生成队列键（格式：selfAID::sessionKey::projectPath）
   * 不同 agent 与同一对端的队列独立，避免冲突。
   */
  private getQueueKey(sessionKey: string, projectPath: string, selfAID?: string): string {
    const normalized = projectPath ? path.resolve(projectPath) : '';
    const prefix = selfAID ? `${selfAID}::` : '';
    return `${prefix}${sessionKey}::${normalized}`;
  }

  private sessionKeyFromQueueKey(queueKey: string): string {
    // 格式：selfAID::sessionKey::projectPath 或 sessionKey::projectPath（旧格式兼容）
    const parts = queueKey.split('::');
    if (parts.length >= 3) {
      // 新格式：selfAID::sessionKey::projectPath
      return parts[1];
    } else if (parts.length === 2) {
      // 旧格式：sessionKey::projectPath
      return parts[0];
    }
    return queueKey;
  }

  private partFromItem(item: QueuedMessage): QueuedMessagePart {
    return {
      message: item.message,
      projectPath: item.projectPath,
      agentName: item.agentName,
      role: item.role,
      resolve: item.resolve,
      reject: item.reject,
    };
  }

  private itemFromPart(part: QueuedMessagePart): QueuedMessage {
    return {
      message: part.message,
      projectPath: part.projectPath,
      agentName: part.agentName,
      role: part.role,
      resolve: part.resolve,
      reject: part.reject,
    };
  }

  private partsOf(item: QueuedMessage): QueuedMessagePart[] {
    return item.parts ?? [this.partFromItem(item)];
  }

  private partCount(item: QueuedMessage): number {
    return item.parts?.length ?? 1;
  }

  private queueRawMessageCount(queue: QueuedMessage[]): number {
    return queue.reduce((sum, item) => sum + this.partCount(item), 0);
  }

  private messageIdsFor(item: QueuedMessage): string[] {
    return this.partsOf(item)
      .map(part => part.message.messageId)
      .filter((id): id is string => !!id);
  }

  private peerIdsFor(item: QueuedMessage): Array<string | undefined> {
    return this.partsOf(item).map(part => part.message.peerId);
  }

  private serializePart(part: QueuedMessagePart, enqueuedAt: number): PersistedQueuePart {
    return {
      message: part.message,
      projectPath: part.projectPath,
      agentName: part.agentName,
      role: part.role,
      enqueuedAt,
    };
  }

  private serializeItem(item: QueuedMessage, enqueuedAt: number): PersistedQueueItem {
    return {
      message: item.message,
      projectPath: item.projectPath,
      agentName: item.agentName,
      role: item.role,
      enqueuedAt,
      parts: item.parts?.map(part => this.serializePart(part, enqueuedAt)),
    };
  }

  private restoredPart(item: PersistedQueuePart): QueuedMessagePart {
    return {
      message: item.message,
      projectPath: item.projectPath,
      agentName: item.agentName || DEFAULT_AGENT_NAME,
      role: item.role,
      resolve: () => {},
      reject: () => {},
    };
  }

  private restoreSubmittedPart(item: PersistedQueuePart): QueuedMessagePart {
    const source = item.message;
    const message: Message = {
      ...source,
      content: RESTART_RESUME_CONTENT,
      images: undefined,
      mentions: undefined,
      mentionAids: undefined,
      messageId: undefined,
      batchRole: item.role,
      items: [{
        kind: 'restart-resume',
        peerId: source.peerId,
        peerName: source.peerName,
        peerType: source.peerType,
        peerRole: item.role,
        sameDevice: source.sameDevice,
        sameNetwork: source.sameNetwork,
        sameEgressIp: source.sameEgressIp,
        content: RESTART_RESUME_CONTENT,
        timestamp: source.timestamp,
      }],
      restartResume: { submitted: true },
    };
    return {
      message,
      projectPath: item.projectPath,
      agentName: item.agentName || DEFAULT_AGENT_NAME,
      role: item.role,
      resolve: () => {},
      reject: () => {},
    };
  }

  private buildCoalescedItem(parts: QueuedMessagePart[]): QueuedMessage {
    if (parts.length === 1) return this.itemFromPart(parts[0]);

    const merged = this.mergeItems(parts.map(part => this.itemFromPart(part)));
    return {
      message: merged.message,
      projectPath: merged.projectPath,
      agentName: merged.agentName,
      role: this.highestRole(parts),
      resolve: () => parts.forEach(part => part.resolve()),
      reject: (error: Error) => parts.forEach(part => part.reject(error)),
      parts,
    };
  }

  private highestRole(items: Array<QueuedMessage | QueuedMessagePart>): SessionIdentity['role'] | undefined {
    const rank: Record<SessionIdentity['role'], number> = {
      anonymous: 0,
      guest: 1,
      admin: 2,
      owner: 3,
    };
    let best: SessionIdentity['role'] | undefined;
    for (const item of items) {
      if (!item.role) continue;
      if (!best || rank[item.role] > rank[best]) best = item.role;
    }
    return best;
  }

  private commonRole(items: Array<QueuedMessage | QueuedMessagePart>): SessionIdentity['role'] | undefined {
    let role: SessionIdentity['role'] | undefined;
    for (const item of items) {
      if (!item.role) return undefined;
      if (!role) {
        role = item.role;
      } else if (role !== item.role) {
        return undefined;
      }
    }
    return role;
  }

  private canDequeueGroupTimeline(first: QueuedMessage, next: QueuedMessage): boolean {
    if (first.role === undefined || next.role === undefined) return false;
    if ((first.agentName || DEFAULT_AGENT_NAME) !== (next.agentName || DEFAULT_AGENT_NAME)) return false;
    if (path.resolve(first.projectPath) !== path.resolve(next.projectPath)) return false;
    return true;
  }

  private canDequeueAfterSubmittedResume(first: QueuedMessage, next: QueuedMessage): boolean {
    if (!first.message.restartResume?.submitted) return false;
    if ((first.agentName || DEFAULT_AGENT_NAME) !== (next.agentName || DEFAULT_AGENT_NAME)) return false;
    if (path.resolve(first.projectPath) !== path.resolve(next.projectPath)) return false;
    return true;
  }

  /**
   * 写盘队列状态。每次队列结构变化（入队/出队/取消/清理）后调用。
   * 仅在内容真正变化时写盘，文件小（数 KB），renameSync 原子替换保证崩溃一致性。
   */
  private persistQueues(): void {
    this.persistQueuesSync();
  }

  /** 立即同步写盘（语义同 persistQueues，保留供进程退出钩子显式调用） */
  persistQueuesImmediate(): void {
    this.persistQueuesSync();
  }

  private persistQueuesSync(): void {
    if (!this.persistencePath) return;
    try {
      const buckets: PersistedQueueBucket[] = [];
      const activeBuckets: PersistedQueueBucket[] = [];
      const enqueuedAt = Date.now();
      for (const [queueKey, queue] of this.queues.entries()) {
        if (queue.length === 0) continue;
        buckets.push({
          queueKey,
          items: queue.map(item => this.serializeItem(item, enqueuedAt)),
        });
      }
      for (const [queueKey, item] of this.activeBatches.entries()) {
        activeBuckets.push({
          queueKey,
          items: [this.serializeItem(item, enqueuedAt)],
        });
      }

      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      if (buckets.length === 0 && activeBuckets.length === 0) {
        try { fs.unlinkSync(this.persistencePath); } catch {}
        return;
      }

      const data: PersistedQueueFile = {
        version: 2,
        updatedAt: Date.now(),
        queues: buckets,
        active: activeBuckets,
      };
      const tmp = `${this.persistencePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
      fs.renameSync(tmp, this.persistencePath);
    } catch (error) {
      logger.error('[Queue] Failed to persist queue state:', error);
    }
  }

  private restoreBucket(bucket: PersistedQueueBucket, restoredKeys: Set<string>): number {
    if (!bucket.queueKey || !Array.isArray(bucket.items)) return 0;
    if (!this.queues.has(bucket.queueKey)) this.queues.set(bucket.queueKey, []);
    const queue = this.queues.get(bucket.queueKey)!;
    const sessionKey = this.sessionKeyFromQueueKey(bucket.queueKey);
    let restored = 0;

    for (const item of bucket.items) {
      if (!item?.message || !item.projectPath) continue;
      const parts = Array.isArray(item.parts) && item.parts.length > 0
        ? item.parts
            .filter(part => part?.message && part.projectPath)
            .map(part => this.restoredPart(part))
        : [this.restoredPart(item)];
      if (parts.length === 0) continue;
      const rawParts = parts
        .sort((a, b) => (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0));
      for (const part of rawParts) {
        const rawItem = this.itemFromPart(part);
        queue.push(rawItem);
        if (rawItem.message.messageId) {
          const dedupKey = `${sessionKey}:${rawItem.message.messageId}`;
          this.recentMessageIds.add(dedupKey);
          setTimeout(() => this.recentMessageIds.delete(dedupKey), this.DEDUP_WINDOW);
        }
      }
      restored += rawParts.length;
    }

    if (queue.length > 0) restoredKeys.add(bucket.queueKey);
    return restored;
  }

  private restoreSubmittedBucket(bucket: PersistedQueueBucket, restoredKeys: Set<string>): number {
    if (!bucket.queueKey || !Array.isArray(bucket.items)) return 0;
    if (!this.queues.has(bucket.queueKey)) this.queues.set(bucket.queueKey, []);
    const queue = this.queues.get(bucket.queueKey)!;
    let restored = 0;

    for (const item of bucket.items) {
      if (!item?.message || !item.projectPath) continue;
      const rawParts = Array.isArray(item.parts) && item.parts.length > 0
        ? item.parts.filter(part => part?.message && part.projectPath)
        : [item];
      if (rawParts.length === 0) continue;

      const first = rawParts[0];
      const submittedPart = this.restoreSubmittedPart(first);
      const submittedItem = this.itemFromPart(submittedPart);
      submittedItem.message.timestamp = first.message.timestamp;
      queue.push(submittedItem);

      const sessionKey = this.sessionKeyFromQueueKey(bucket.queueKey);
      for (const part of rawParts) {
        if (!part.message.messageId) continue;
        const dedupKey = `${sessionKey}:${part.message.messageId}`;
        this.recentMessageIds.add(dedupKey);
        setTimeout(() => this.recentMessageIds.delete(dedupKey), this.DEDUP_WINDOW);
      }
      restored += rawParts.length;
    }

    if (queue.length > 0) restoredKeys.add(bucket.queueKey);
    return restored;
  }

  restorePersisted(startProcessing = true): number {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return 0;

    let restored = 0;
    try {
      const raw = fs.readFileSync(this.persistencePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedQueueFile;
      if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.queues)) {
        logger.warn('[Queue] Ignoring unsupported persisted queue file');
        return 0;
      }

      const restoredKeys = new Set<string>();
      if (Array.isArray(parsed.active)) {
        for (const bucket of parsed.active) {
          restored += this.restoreSubmittedBucket(bucket, restoredKeys);
        }
      }
      for (const bucket of parsed.queues) {
        restored += this.restoreBucket(bucket, restoredKeys);
      }

      this.persistQueuesImmediate();
      if (restored > 0) {
        logger.info(`[Queue] Restored ${restored} persisted message(s) from ${this.persistencePath}`);
      }

      if (startProcessing) {
        for (const key of restoredKeys) {
          if (!this.processing.has(key)) this.processNext(key);
        }
      }
    } catch (error) {
      logger.error('[Queue] Failed to restore persisted queue:', error);
    }

    return restored;
  }

  async enqueue(sessionKey: string, message: Message, projectPath: string, options?: { interruptible?: boolean; interruptSamePeer?: boolean; agentName?: string; role?: SessionIdentity['role']; sessionKeyField?: string; selfAID?: string }): Promise<void> {
    // 消息去重检查
    if (!this.shouldProcess(sessionKey, message)) {
      return Promise.resolve();
    }

    // 拦截器检查：AskUserQuestion 等场景的一次性消息拦截
    const interceptor = this.interceptors.get(sessionKey);
    if (interceptor) {
      this.interceptors.delete(sessionKey);
      logger.debug(`[Queue] Message intercepted for ${sessionKey}`);
      interceptor(message);
      return Promise.resolve();
    }

    const queueKey = this.getQueueKey(sessionKey, projectPath, options?.selfAID);
    // 记录 sessionKey 映射（human-readable 格式，供 getQueueItemsBySession/getQueueItemsByAgent 输出）
    if (options?.sessionKeyField) {
      this.queueKeyToSessionKey.set(queueKey, options.sessionKeyField);
    }
    const agentName = options?.agentName || DEFAULT_AGENT_NAME;
    const isProcessing = this.processing.has(queueKey);
    const currentQueue = this.queues.get(queueKey);
    logger.info(`[Queue] enqueue: key=${queueKey} processing=${isProcessing} queueLen=${currentQueue?.length ?? 0} pending=${currentQueue?.length ?? 0} rawPending=${currentQueue ? this.queueRawMessageCount(currentQueue) : 0} agent=${agentName} role=${options?.role ?? '<none>'} peer=${message.peerId ?? '<none>'} msg=${message.messageId ?? '<none>'}`);

    return new Promise((resolve, reject) => {
      if (!this.queues.has(queueKey)) {
        this.queues.set(queueKey, []);
      }

      const queue = this.queues.get(queueKey)!;
      queue.push({ message, projectPath, agentName, role: options?.role, resolve, reject });
      this.logicalQueue.enqueue(queueKey, message);  // 通知逻辑队列记录出队顺序
      this.persistQueues();

      if (this.processing.has(queueKey)) {
        // 打断判定：
        //  - 单聊（interruptible !== false）：始终打断
        //  - 群聊（interruptible === false）+ interruptSamePeer：仅当「同一发送者连发」
        //    且队列里没有其他人的消息时打断，避免抢占群里他人的排队消息
        const interruptSingle = options?.interruptible !== false;
        const activeState = this.activeStates.get(queueKey);
        const interruptGroupSamePeer =
          options?.interruptible === false &&
          options?.interruptSamePeer === true &&
          !!message.peerId &&
          activeState?.peerId === message.peerId &&
          !this.hasOtherPeerQueued(queueKey, message.peerId);

        if (interruptSingle || interruptGroupSamePeer) {
          logger.debug(`[Queue] ${queueKey} is processing, triggering interrupt (samePeer=${interruptGroupSamePeer})`);
          this.eventBus?.publish({
            type: 'task:interrupted',
            sessionId: sessionKey,
            reason: 'new_message',
            agentName: this.processingAgent.get(queueKey),
          });
          if (this.interruptCallback) {
            this.interruptCallback(sessionKey, activeState?.baseagent, this.processingAgent.get(queueKey)).catch(() => {});
          }
        } else {
          // 群聊：FIFO，不打断
          logger.debug(`[Queue] ${queueKey} is processing, message queued (FIFO)`);
          this.eventBus?.publish({
            type: 'task:queued',
            channel: message.channel,
            channelId: message.channelId,
            replyContext: message.replyContext as Record<string, unknown> | undefined,
          });
        }
      } else {
        logger.debug(`[Queue] Starting to process ${queueKey}`);
        this.processNext(queueKey);
      }
    });
  }

  /**
   * 队列中是否存在 peerId 不同于给定值的消息（群聊同人打断守卫）。
   * 忽略 peerId 为 undefined 的消息（系统消息等不参与打断判定）。
   */
  private hasOtherPeerQueued(queueKey: string, peerId?: string): boolean {
    const q = this.queues.get(queueKey);
    if (!q) return false;
    return q.some(item => this.peerIdsFor(item).some(queuedPeerId => !!queuedPeerId && queuedPeerId !== peerId));
  }

  private async processNext(queueKey: string): Promise<void> {
    this.processing.add(queueKey);
    logger.info(`[Queue] processNext: start key=${queueKey}`);

    while (true) {
      // 等待外部锁释放（/compact, /clear 等快速命令）
      const lock = this.getExternalLock(queueKey);
      if (lock) {
        logger.debug(`[Queue] Waiting for external lock on ${queueKey}`);
        await lock;
      }

      const queue = this.queues.get(queueKey);
      if (!queue || queue.length === 0) {
        logger.info(`[Queue] processNext: queue empty, releasing key=${queueKey}`);
        this.processing.delete(queueKey);
        this.processingAgent.delete(queueKey);
        this.activeStates.delete(queueKey);
        return;
      }

      // 禁言：消息留在队列里，暂停消费（解禁后由 unmuteAgent 重新触发 processNext）
      const headAgent = queue[0].agentName || DEFAULT_AGENT_NAME;
      if (this.mutedAgents.has(headAgent)) {
        logger.info(`[Queue] processNext: agent ${headAgent} muted, pausing key=${queueKey} (${queue.length} pending, ${this.queueRawMessageCount(queue)} raw)`);
        this.processing.delete(queueKey);
        this.processingAgent.delete(queueKey);
        this.activeStates.delete(queueKey);
        return;
      }

      // 逻辑队列重排：让响应模式的出队策略决定队首（默认 FIFO，不改变顺序）
      this.logicalQueue.reorderPhysical(queueKey, queue);
      // 贪心合并：群聊按完整时间线，旧路径/私聊按 peerId
      const items = this.dequeueGreedy(queue);
      // 同步逻辑队列：移除所有被合并处理的消息
      if (items.length > 0) {
        const processedIds = items.map(item => item.message.messageId).filter((id): id is string => !!id);
        if (processedIds.length > 0) {
          this.logicalQueue.removeProcessed(queueKey, processedIds);
        }
      }
      const merged = items.length === 1 ? items[0] : this.mergeItems(items);
      const rawItems = items.flatMap(item => this.partsOf(item).map(part => this.itemFromPart(part)));
      const rawParts = rawItems.map(item => this.partFromItem(item));
      // activeItem 复用已合并的 message，仅额外持有 parts 用于持久化和撤回定位（不重复 merge）
      const activeItem: QueuedMessage = rawParts.length === 1
        ? this.itemFromPart(rawParts[0])
        : {
            message: merged.message,
            projectPath: merged.projectPath,
            agentName: merged.agentName,
            role: this.highestRole(rawParts),
            resolve: () => rawParts.forEach(part => part.resolve()),
            reject: (error: Error) => rawParts.forEach(part => part.reject(error)),
            parts: rawParts,
          };
      const batchRole = this.commonRole(rawItems);
      if (batchRole && !merged.message.batchRole) merged.message.batchRole = batchRole;

      this.processingAgent.set(queueKey, merged.agentName);

      // 记录正在执行的 messageId（用于撤回中断）
      const activeMessageIds = new Set<string>();
      for (const item of rawItems) {
        if (item.message.messageId) activeMessageIds.add(item.message.messageId);
      }
      const activeState: ActiveQueueState = {
        baseagent: merged.message.baseagent,
        peerId: this.uniquePeerId(rawItems),
        messageIds: activeMessageIds,
      };
      this.activeStates.set(queueKey, activeState);

      const resolves = rawItems.map(i => i.resolve);
      const rejects = rawItems.map(i => i.reject);

      this.activeBatches.set(queueKey, activeItem);
      this.processingStartTime.set(queueKey, Date.now());
      this.persistQueuesImmediate();

      logger.info(`[Queue] processing batch: key=${queueKey} items=${rawItems.length} pending=${queue.length} rawPending=${this.queueRawMessageCount(queue)} batchRole=${merged.message.batchRole ?? '<mixed>'} peer=${activeState.peerId ?? '<multi>'} msg=${merged.message.messageId ?? '<none>'}`);
      try {
        await this.handler(merged.message);
        logger.debug(`[Queue] Message processed successfully`);
        resolves.forEach(r => r());
      } catch (error) {
        logger.error(`[Queue] Message processing failed:`, error);
        rejects.forEach(r => r(error as Error));
      } finally {
        this.activeBatches.delete(queueKey);
        this.processingStartTime.delete(queueKey);
        this.activeStates.delete(queueKey);
        this.persistQueuesImmediate();
      }
    }
  }

  /**
   * 贪心弹出队首可合并消息。
   * 群聊入队携带 role，此时取出当前所有群聊 pending 并按时间线合并；
   * role 只作为逐条元数据，不作为分批边界。未携带 role 的旧路径/私聊按 peerId 合并。
   */
  private dequeueGreedy(queue: QueuedMessage[]): QueuedMessage[] {
    const first = queue.shift()!;
    const result = [first];
    const mergeSubmittedResume = first.message.restartResume?.submitted === true;
    const mergeGroupTimeline = first.role !== undefined;
    const mergeKey = mergeGroupTimeline ? '<group-timeline>' : first.message.peerId;

    if (mergeSubmittedResume) {
      const remaining: QueuedMessage[] = [];
      for (const item of queue) {
        if (this.canDequeueAfterSubmittedResume(first, item)) {
          result.push(item);
        } else {
          remaining.push(item);
        }
      }
      queue.length = 0;
      queue.push(...remaining);
      result.sort((a, b) => {
        if (a.message.restartResume?.submitted) return -1;
        if (b.message.restartResume?.submitted) return 1;
        return this.firstTimestamp(a) - this.firstTimestamp(b);
      });
    } else if (mergeGroupTimeline) {
      const remaining: QueuedMessage[] = [];
      for (const item of queue) {
        if (this.canDequeueGroupTimeline(first, item)) {
          result.push(item);
        } else {
          remaining.push(item);
        }
      }
      queue.length = 0;
      queue.push(...remaining);
      result.sort((a, b) => this.firstTimestamp(a) - this.firstTimestamp(b));
    } else {
      while (queue.length > 0 && queue[0].message.peerId === mergeKey) {
        result.push(queue.shift()!);
      }
    }

    if (result.length > 1) {
      logger.info(`[Queue] Greedy dequeue: merged ${result.length} pending item(s) by ${mergeSubmittedResume ? 'restart-resume' : (mergeGroupTimeline ? 'group-timeline' : 'peerId')}=${mergeKey ?? '<none>'}`);
    }

    return result;
  }

  private firstTimestamp(item: QueuedMessage): number {
    const parts = this.partsOf(item);
    let ts = Number.POSITIVE_INFINITY;
    for (const part of parts) ts = Math.min(ts, part.message.timestamp ?? 0);
    return Number.isFinite(ts) ? ts : 0;
  }

  /**
   * 当前在途任务只有一个真实发送者时才启用 same-peer 打断。
   * 多发送者群聊批次返回 undefined，避免其中某个成员的新消息不断打断聚合推理。
   */
  private uniquePeerId(items: QueuedMessage[]): string | undefined {
    const peers = new Set(items.map(item => item.message.peerId).filter(Boolean));
    if (peers.size !== 1) return undefined;
    return [...peers][0];
  }

  /**
   * 合并多条同 peerId 或群聊时间线消息：
   * - content: \n 连接（兜底用，渲染层优先用 items）
   * - items: 保留每条子消息（含各自 peer/timestamp），供消息渲染层逐条渲染
   * - images / mentions: 扁平合并
   * - messageId: 取最新一条的 messageId（用于 thought 锚定与中断追踪）
   * - replyContext / peerName / 其余字段: 取最后一条
   */
  private mergeItems(items: QueuedMessage[]): QueuedMessage {
    const contents: string[] = [];
    const allImages: Array<{ data: string; mimeType: string }> = [];
    const allMentions: Array<{ userId: string; name?: string; key?: string }> = [];
    const subMessages: SubMessage[] = [];
    let mergedPeerType: string | undefined;
    let hasRestartResume = false;
    let hasMessagesAfterRestartResume = false;

    for (const item of items) {
      const m = item.message;
      if (hasRestartResume && !m.restartResume?.submitted) {
        hasMessagesAfterRestartResume = true;
      }
      if (m.restartResume?.submitted) {
        hasRestartResume = true;
      }
      contents.push(m.content);
      if (m.images) allImages.push(...m.images);
      if (m.mentions) allMentions.push(...m.mentions);
      if (m.peerType && m.peerType !== 'human') {
        mergedPeerType = m.peerType;
      } else if (!mergedPeerType && m.peerType) {
        mergedPeerType = m.peerType;
      }
      // 逐条保留发送者、时刻、图片；若该条已自带 items（罕见），展开保留细粒度
      if (m.items && m.items.length > 0) {
        subMessages.push(...m.items.map(sub => ({ ...sub, peerRole: sub.peerRole ?? item.role })));
      } else {
        subMessages.push({
          peerId: m.peerId, peerName: m.peerName, peerType: m.peerType,
          peerRole: item.role,
          sameDevice: m.sameDevice, sameNetwork: m.sameNetwork, sameEgressIp: m.sameEgressIp,
          encrypted: m.encrypted,
          content: m.content, timestamp: m.timestamp,
          images: m.images && m.images.length > 0 ? m.images : undefined,
          mentionAids: m.mentionAids && m.mentionAids.length > 0 ? m.mentionAids : undefined,
        });
      }
    }

    const last = items[items.length - 1];
    const role = this.commonRole(items);
    // 保留最新一条的 messageId（若最后一条无 ID 则回退到前面已有的 ID）
    let latestMessageId: string | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].message.messageId) {
        latestMessageId = items[i].message.messageId;
        break;
      }
    }
    const merged: Message = {
      ...last.message,
      content: contents.join('\n'),
      items: subMessages,
      images: allImages.length > 0 ? allImages : undefined,
      mentions: allMentions.length > 0 ? allMentions : undefined,
      messageId: latestMessageId,
      // 密文优先：合并批次内任一条密文，则整轮（interactive 自动回复的单值出站）按密文。
      // 任一条 encrypted===true 即 true；否则若有明确的 false 则 false；全 undefined（非 aun）则 undefined。
      encrypted: subMessages.some(s => s.encrypted === true)
        ? true
        : (subMessages.some(s => s.encrypted === false) ? false : undefined),
      batchRole: role,
      peerType: mergedPeerType,
      restartResume: hasRestartResume
        ? { submitted: true, pendingInterrupted: hasMessagesAfterRestartResume }
        : undefined,
    };

    return {
      message: merged,
      projectPath: last.projectPath,
      agentName: last.agentName,
      resolve: () => {},  // 由调用方管理
      reject: () => {},
    };
  }

  getQueueLength(sessionKey: string): number {
    // 计算该 sessionKey 下所有项目队列的总长度
    let total = 0;
    for (const [key, queue] of this.queues.entries()) {
      if (this.matchesSession(key, sessionKey)) {
        total += queue.length;
      }
    }
    return total;
  }

  isProcessing(sessionKey: string): boolean {
    // 检查该 sessionKey 下是否有任何项目队列在处理
    for (const key of this.processing.keys()) {
      if (this.matchesSession(key, sessionKey)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查指定 channel 下是否有任何 session 在处理。
   * queueKey 格式为 `${sessionKey}::${projectPath}`，其中 sessionKey
   * 形如 `${channelName}-${channelId}-${ts}`，因此匹配 `${channelName}-` 前缀。
   */
  isChannelProcessing(channelName: string): boolean {
    const prefix = `${channelName}-`;
    for (const key of this.processing.keys()) {
      if (key.startsWith(prefix) || key.startsWith(`${channelName}::`)) {
        return true;
      }
    }
    return false;
  }

  cancel(messageId: string): boolean {
    for (const queue of this.queues.values()) {
      const idx = queue.findIndex(q => this.messageIdsFor(q).includes(messageId));
      if (idx === -1) continue;

      const target = queue[idx];
      const parts = this.partsOf(target);
      const partIdx = parts.findIndex(part => part.message.messageId === messageId);
      if (partIdx === -1) continue;

      if (parts.length === 1) {
        const [removed] = queue.splice(idx, 1);
        removed.resolve();
      } else {
        const [removed] = parts.splice(partIdx, 1);
        removed.resolve();
        queue[idx] = this.buildCoalescedItem(parts);
      }

      this.persistQueuesImmediate();
      logger.info(`[Queue] Cancelled queued message ${messageId}`);
      return true;
    }
    return false;
  }

  /**
   * 撤回正在执行的消息：如果 messageId 正在处理中，触发 interrupt。
   * @returns true 如果找到并触发了中断
   */
  cancelActive(messageId: string): boolean {
    for (const [queueKey, activeState] of this.activeStates.entries()) {
      if (!activeState.messageIds.has(messageId)) continue;

      const active = this.activeBatches.get(queueKey);
      if (active && this.messageIdsFor(active).includes(messageId)) {
        const parts = this.partsOf(active);
        const remaining = parts.filter(part => part.message.messageId !== messageId);
        if (remaining.length === 0) {
          this.activeBatches.delete(queueKey);
          this.processingStartTime.delete(queueKey);
          activeState.messageIds.clear();
        } else {
          this.activeBatches.set(queueKey, this.buildCoalescedItem(remaining));
          activeState.messageIds = new Set(
            remaining
              .map(part => part.message.messageId)
              .filter((id): id is string => !!id)
          );
        }
        this.persistQueuesImmediate();
      }

      const sessionKey = this.sessionKeyFromQueueKey(queueKey);
      const agentName = this.processingAgent.get(queueKey);
      logger.info(`[Queue] Recalled active message ${messageId}, interrupting session ${sessionKey}`);
      this.eventBus?.publish({
        type: 'task:interrupted',
        sessionId: sessionKey,
        reason: 'recalled',
        agentName,
      });
      if (this.interruptCallback) {
        this.interruptCallback(sessionKey, activeState.baseagent, agentName).catch(() => {});
      }
      return true;
    }
    return false;
  }

  /**
   * 外部锁：快速命令（/compact, /clear）执行期间阻塞队列处理
   * 返回 release 函数
   */
  acquireLock(sessionKey: string): () => void {
    let releaseFn!: () => void;
    const promise = new Promise<void>(resolve => { releaseFn = resolve; });
    this.externalLocks.set(sessionKey, promise);
    return () => {
      this.externalLocks.delete(sessionKey);
      releaseFn();
    };
  }

  /** 检查是否有外部锁 */
  private getExternalLock(queueKey: string): Promise<void> | undefined {
    for (const [key, promise] of this.externalLocks) {
      if (this.matchesSession(queueKey, key)) return promise;
    }
    return undefined;
  }

  /**
   * 获取全局队列长度（所有会话的待处理消息总数）
   */
  getGlobalQueueLength(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  /**
   * 获取全局处理中队列数量
   */
  getGlobalProcessingCount(): number {
    return this.processing.size;
  }

  /**
   * 获取指定 agent 的待处理消息数量。
   * agent 维度按 enqueue 时传入的 agentName 计数。
   * 可传入 excludeSessionKey 排除某个会话。
   */
  getQueueLengthByAgent(agentName: string, excludeSessionKey?: string): number {
    let total = 0;
    for (const [key, queue] of this.queues.entries()) {
      if (excludeSessionKey && this.matchesSession(key, excludeSessionKey)) continue;
      for (const item of queue) {
        if ((item.agentName || DEFAULT_AGENT_NAME) === agentName) total++;
      }
    }
    return total;
  }

  /**
   * 获取指定 agent 的处理中队列数量。
   * 可传入 excludeSessionKey 排除某个会话（用于 restart 等操作排除自身）。
   */
  getProcessingCountByAgent(agentName: string, excludeSessionKey?: string): number {
    let total = 0;
    for (const [key, a] of this.processingAgent.entries()) {
      if (excludeSessionKey && this.matchesSession(key, excludeSessionKey)) continue;
      if ((a || DEFAULT_AGENT_NAME) === agentName) total++;
    }
    return total;
  }

  /**
   * 获取指定 agent 的处理中队列详情列表（用于阻塞提示，帮助 agent 判断等待时长）。
   * 每项包含 queueKey（可从中解析 sessionId 和路径）和 agentName。
   */
  getProcessingDetailsByAgent(agentName: string, excludeSessionKey?: string): Array<{ queueKey: string; agentName: string }> {
    const results: Array<{ queueKey: string; agentName: string }> = [];
    for (const [key, a] of this.processingAgent.entries()) {
      if (excludeSessionKey && this.matchesSession(key, excludeSessionKey)) continue;
      if ((a || DEFAULT_AGENT_NAME) === agentName) {
        results.push({ queueKey: key, agentName: a || DEFAULT_AGENT_NAME });
      }
    }
    return results;
  }

  /**
   * 清空指定 agent 的待处理消息（不影响正在处理中的消息）。
   * 被移除的消息直接 resolve（与 cancel 一致），让 enqueue 的等待方正常解除阻塞。
   * @returns 被清除的消息数量
   */
  clearByAgent(agentName: string): number {
    let cleared = 0;
    for (const queue of this.queues.values()) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if ((queue[i].agentName || DEFAULT_AGENT_NAME) === agentName) {
          const [removed] = queue.splice(i, 1);
          removed.resolve();
          cleared++;
        }
      }
    }
    if (cleared > 0) {
      this.persistQueuesImmediate();
      logger.info(`[Queue] Cleared ${cleared} pending message(s) for agent ${agentName}`);
    }
    return cleared;
  }

  /** 禁言 agent：后续消息照常入队，但 processNext 不再取出处理。 */
  muteAgent(agentName: string): void {
    this.mutedAgents.add(agentName);
    logger.info(`[Queue] Muted agent ${agentName}`);
  }

  /** 解除禁言：重新触发该 agent 已积压、且当前未在处理的队列。 */
  unmuteAgent(agentName: string): void {
    if (!this.mutedAgents.delete(agentName)) return;
    logger.info(`[Queue] Unmuted agent ${agentName}, resuming queued messages`);
    for (const [key, queue] of this.queues) {
      if (queue.length > 0 && !this.processing.has(key)) {
        const headAgent = queue[0].agentName || DEFAULT_AGENT_NAME;
        if (headAgent === agentName) this.processNext(key);
      }
    }
  }

  isAgentMuted(agentName: string): boolean {
    return this.mutedAgents.has(agentName);
  }

  /** 中断指定 agent 所有正在处理中的会话（停止 agent 时调用）。 */
  interruptByAgent(agentName: string): void {
    for (const [queueKey, name] of this.processingAgent) {
      if ((name || DEFAULT_AGENT_NAME) === agentName) {
        const sessionKey = this.sessionKeyFromQueueKey(queueKey);
        const activeState = this.activeStates.get(queueKey);
        logger.info(`[Queue] Interrupting session ${sessionKey} for stopped agent ${agentName}`);
        this.eventBus?.publish({
          type: 'task:interrupted',
          sessionId: sessionKey,
          reason: 'new_message',
          agentName: name,
        });
        if (this.interruptCallback) {
          this.interruptCallback(sessionKey, activeState?.baseagent, name).catch(() => {});
        }
      }
    }
  }

  // ── Queue query/management methods ──

  /**
   * 解析 sessionKey 的 channelType 和 channelId 组件。
   * sessionKey 格式：channelType#urlEncode(channelId)#urlEncode(threadId)
   */
  private parseSessionKey(sessionKey: string): { channelType: string; channelId: string } {
    const parts = sessionKey.split('#');
    const channelType = parts[0] || '';
    let channelId = '';
    if (parts.length > 1) {
      try { channelId = decodeURIComponent(parts[1]); } catch { channelId = parts[1]; }
    }
    return { channelType, channelId };
  }

  /** 从 queueKey 提取 projectPath */
  private projectPathFromQueueKey(queueKey: string): string {
    const parts = queueKey.split('::');
    if (parts.length >= 3) return parts.slice(2).join('::');
    if (parts.length === 2) return parts[1];
    return queueKey;
  }

  /** 截断消息内容用于预览 */
  private truncatePreview(content: string, maxLen = 80): string {
    if (!content) return '';
    const cleaned = content.replace(/\s+/g, ' ').trim();
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '...' : cleaned;
  }

  /** 构建 QueueItemSnapshot */
  private buildSnapshot(
    status: 'active' | 'pending',
    queueKey: string,
    sessionKey: string,
    item: QueuedMessage,
  ): QueueItemSnapshot {
    const { channelType, channelId } = this.parseSessionKey(sessionKey);
    const startTime = this.processingStartTime.get(queueKey);
    const elapsedMs = status === 'active' && startTime != null
      ? Date.now() - startTime
      : undefined;
    return {
      status,
      sessionKey,
      channelType,
      channelId,
      projectPath: this.projectPathFromQueueKey(queueKey),
      peerName: item.message.peerName,
      preview: this.truncatePreview(item.message.content),
      messageId: item.message.messageId,
      elapsedMs,
    };
  }

  /**
   * 通过 human-readable sessionKey 反查 sessionId（cli interrupt 用）
   */
  findSessionIdBySessionKey(sessionKey: string): string | undefined {
    for (const [queueKey, sk] of this.queueKeyToSessionKey.entries()) {
      if (sk === sessionKey) return this.sessionKeyFromQueueKey(queueKey);
    }
    return undefined;
  }

  /**
   * 按 sessionId 查询队列（ctl 用）
   * @param sessionId - Session.id（meta_YYYYMMDD_TS）
   * @returns 仅返回 pending 状态的消息
   */
  getQueueItemsBySession(sessionId: string): QueueItemSnapshot[] {
    const result: QueueItemSnapshot[] = [];
    for (const [queueKey, queue] of this.queues.entries()) {
      if (!this.matchesSession(queueKey, sessionId)) continue;
      const sessionKey = this.queueKeyToSessionKey.get(queueKey)
        || this.sessionKeyFromQueueKey(queueKey);
      for (const item of queue) {
        result.push(this.buildSnapshot('pending', queueKey, sessionKey, item));
      }
    }
    return result;
  }

  /**
   * 按 agent 查询队列（cli 用）
   * @param agentName - agent 内部名称
   * @returns 返回所有状态（active + pending）的消息
   */
  getQueueItemsByAgent(agentName: string): QueueItemSnapshot[] {
    const result: QueueItemSnapshot[] = [];

    // active 项
    for (const [queueKey, item] of this.activeBatches.entries()) {
      const itemAgent = item.agentName || DEFAULT_AGENT_NAME;
      if (itemAgent !== agentName) continue;
      const sessionKey = this.queueKeyToSessionKey.get(queueKey)
        || this.sessionKeyFromQueueKey(queueKey);
      result.push(this.buildSnapshot('active', queueKey, sessionKey, item));
    }

    // pending 项
    for (const [queueKey, queue] of this.queues.entries()) {
      for (const item of queue) {
        const itemAgent = item.agentName || DEFAULT_AGENT_NAME;
        if (itemAgent !== agentName) continue;
        const sessionKey = this.queueKeyToSessionKey.get(queueKey)
          || this.sessionKeyFromQueueKey(queueKey);
        result.push(this.buildSnapshot('pending', queueKey, sessionKey, item));
      }
    }

    return result;
  }

  /**
   * 按 sessionId 清空待处理消息（ctl 用）
   * @returns 被清除的消息数量
   */
  clearBySession(sessionId: string): number {
    let cleared = 0;
    for (const [queueKey, queue] of this.queues.entries()) {
      if (!this.matchesSession(queueKey, sessionId)) continue;
      while (queue.length > 0) {
        const item = queue.shift()!;
        item.resolve();
        cleared++;
      }
    }
    if (cleared > 0) {
      this.persistQueuesImmediate();
      logger.info(`[Queue] Cleared ${cleared} pending message(s) for sessionId ${sessionId}`);
    }
    return cleared;
  }

  /**
   * 按 messageId 取消消息（sessionId 作用域，ctl 用）
   * @returns 是否成功
   */
  cancelMessageByIdInSession(sessionId: string, messageId: string): boolean {
    for (const [queueKey, queue] of this.queues.entries()) {
      if (!this.matchesSession(queueKey, sessionId)) continue;
      const idx = queue.findIndex(q => this.messageIdsFor(q).includes(messageId));
      if (idx === -1) continue;
      const target = queue[idx];
      const parts = this.partsOf(target);
      const partIdx = parts.findIndex(part => part.message.messageId === messageId);
      if (partIdx === -1) continue;
      if (parts.length === 1) {
        const [removed] = queue.splice(idx, 1);
        removed.resolve();
      } else {
        const [removed] = parts.splice(partIdx, 1);
        removed.resolve();
        queue[idx] = this.buildCoalescedItem(parts);
      }
      this.persistQueuesImmediate();
      logger.info(`[Queue] Cancelled queued message ${messageId} in session ${sessionId}`);
      return true;
    }
    return false;
  }

  /**
   * 按 messageId 取消消息（agent 作用域，cli 用）
   * @returns 是否成功
   */
  cancelMessageById(agentName: string, messageId: string): boolean {
    for (const [queueKey, queue] of this.queues.entries()) {
      const idx = queue.findIndex(q => {
        if ((q.agentName || DEFAULT_AGENT_NAME) !== agentName) return false;
        return this.messageIdsFor(q).includes(messageId);
      });
      if (idx === -1) continue;
      const target = queue[idx];
      const parts = this.partsOf(target);
      const partIdx = parts.findIndex(part => part.message.messageId === messageId);
      if (partIdx === -1) continue;
      if (parts.length === 1) {
        const [removed] = queue.splice(idx, 1);
        removed.resolve();
      } else {
        const [removed] = parts.splice(partIdx, 1);
        removed.resolve();
        queue[idx] = this.buildCoalescedItem(parts);
      }
      this.persistQueuesImmediate();
      logger.info(`[Queue] Cancelled queued message ${messageId} for agent ${agentName}`);
      return true;
    }
    return false;
  }

  /**
   * 打断 session 的处理中任务（ctl 用）
   * 一个 session 只可能有一个 queueKey。
   * @returns 是否有任务被打断
   */
  async interruptBySession(sessionId: string): Promise<boolean> {
    let targetQueueKey: string | undefined;
    let targetAgentName: string | undefined;

    for (const queueKey of this.processing) {
      if (this.matchesSession(queueKey, sessionId)) {
        targetQueueKey = queueKey;
        targetAgentName = this.processingAgent.get(queueKey);
        break;
      }
    }

    if (!targetQueueKey) return false;

    const sessionKey = this.sessionKeyFromQueueKey(targetQueueKey);
    logger.info(`[Queue] Interrupting session ${sessionKey} (queueKey=${targetQueueKey})`);

    this.eventBus?.publish({
      type: 'task:interrupted',
      sessionId: sessionKey,
      reason: 'new_message',
      agentName: targetAgentName,
    });

    if (this.interruptCallback) {
      await this.interruptCallback(sessionKey, this.activeStates.get(targetQueueKey)?.baseagent, targetAgentName);
    }

    return true;
  }
}
