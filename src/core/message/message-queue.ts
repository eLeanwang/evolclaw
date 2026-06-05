import { Message, SubMessage } from '../../types.js';
import path from 'path';
import { logger } from '../../utils/logger.js';
import type { EventBus } from '../event-bus.js';

type MessageHandler = (message: Message) => Promise<void>;

interface QueuedMessage {
  message: Message;
  projectPath: string;
  agentName: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const DEFAULT_AGENT_NAME = '<unknown>';

export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private processingAgent = new Map<string, string>();  // queueKey → agentName（处理中项目的 agent）
  private externalLocks = new Map<string, Promise<void>>();
  private handler: MessageHandler;
  private currentSessionKey?: string;
  private currentProjectPath?: string;
  private currentAgentId?: string;
  private activeMessageIds = new Set<string>();  // 正在执行的消息 ID
  private interruptCallback?: (sessionKey: string, agentId?: string, evolagentName?: string, reason?: 'new_message' | 'inject-preempt') => Promise<void>;
  private eventBus?: EventBus;
  private recentMessageIds = new Set<string>();
  private readonly DEDUP_WINDOW = 60_000; // 1 分钟窗口
  private interceptors = new Map<string, (message: Message) => void>();
  // observer 插话：当前正在处理的消息（用于抢占时捕获对端消息）；被插话抢占而捕获的待重放对端消息
  private currentMessage = new Map<string, Message>();          // queueKey → 处理中的 message
  private pendingReplay = new Map<string, { message: Message; projectPath: string; agentName: string; sessionKey: string }>();

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  /** 是否为 observer 插话消息（owner 优先级调度依据）。 */
  private isInject(m: Message): boolean {
    return m.source === 'owner-inject';
  }

  setInterruptCallback(callback: (sessionKey: string, agentId?: string, evolagentName?: string, reason?: 'new_message' | 'inject-preempt') => Promise<void>): void {
    this.interruptCallback = callback;
  }

  /**
   * 注册插话抢占撤回钩子：当 owner 插话抢占了一个正在向对端输出的 turn 时调用，
   * 撤回已漏给对端的半句。由 daemon 接到对应 channel 的 recallRecentOutbound。
   */
  setInjectRecallHook(hook: (channelKey: string, channelId: string, chatType: 'private' | 'group') => void): void {
    this.injectRecallHook = hook;
  }
  private injectRecallHook?: (channelKey: string, channelId: string, chatType: 'private' | 'group') => void;

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
    return key.startsWith(sessionKey + '::');
  }

  /**
   * 生成项目级别的队列 key
   */
  private getQueueKey(sessionKey: string, projectPath: string): string {
    const normalized = projectPath ? path.resolve(projectPath) : '';
    return `${sessionKey}::${normalized}`;
  }

  async enqueue(sessionKey: string, message: Message, projectPath: string, options?: { interruptible?: boolean; agentName?: string }): Promise<void> {
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

    const queueKey = this.getQueueKey(sessionKey, projectPath);
    const agentName = options?.agentName || DEFAULT_AGENT_NAME;
    const isProcessing = this.processing.has(queueKey);
    logger.info(`[Queue] enqueue: key=${queueKey} processing=${isProcessing} queueLen=${this.queues.get(queueKey)?.length ?? 0} agent=${agentName}`);

    const inject = this.isInject(message);

    return new Promise((resolve, reject) => {
      if (!this.queues.has(queueKey)) {
        this.queues.set(queueKey, []);
      }

      const queue = this.queues.get(queueKey)!;
      if (inject) {
        // owner 优先级调度：插话排到所有非插话消息之前（已排队的插话仍在其后，保持 owner 内部 FIFO）。
        let insertAt = queue.length;
        for (let i = 0; i < queue.length; i++) {
          if (!this.isInject(queue[i].message)) { insertAt = i; break; }
        }
        queue.splice(insertAt, 0, { message, projectPath, agentName, resolve, reject });
      } else {
        queue.push({ message, projectPath, agentName, resolve, reject });
      }

      if (this.processing.has(queueKey)) {
        if (inject) {
          // 插话抢占：无论私聊/群聊都打断在跑的对端 turn，并捕获它以便 Phase 1 后重放。
          const inFlight = this.currentMessage.get(queueKey);
          if (inFlight && !this.isInject(inFlight) && !this.pendingReplay.has(queueKey)) {
            this.pendingReplay.set(queueKey, {
              message: inFlight,
              projectPath: this.currentProjectPath || projectPath,
              agentName: this.processingAgent.get(queueKey) || agentName,
              sessionKey,
            });
            logger.info(`[Queue] inject preempt: captured peer message for replay (key=${queueKey} mid=${inFlight.messageId ?? 'none'})`);
            // 撤回已漏给对端的半句（私聊；群聊待 SDK）
            if (this.injectRecallHook && inFlight.channel && inFlight.channelId) {
              try {
                this.injectRecallHook(inFlight.channel, inFlight.channelId, (inFlight.chatType as 'private' | 'group') || 'private');
              } catch (e) {
                logger.debug(`[Queue] injectRecallHook failed: ${e}`);
              }
            }
          }
          this.eventBus?.publish({
            type: 'task:interrupted',
            sessionId: sessionKey,
            reason: 'new_message',
            agentName: this.processingAgent.get(queueKey),
          });
          if (this.interruptCallback) {
            this.interruptCallback(sessionKey, this.currentAgentId, this.processingAgent.get(queueKey), 'inject-preempt').catch(() => {});
          }
        } else if (options?.interruptible !== false) {
          // 单聊：保留中断行为
          logger.debug(`[Queue] ${queueKey} is processing, triggering interrupt`);
          this.eventBus?.publish({
            type: 'task:interrupted',
            sessionId: sessionKey,
            reason: 'new_message',
            agentName: this.processingAgent.get(queueKey),
          });
          if (this.interruptCallback) {
            this.interruptCallback(sessionKey, this.currentAgentId, this.processingAgent.get(queueKey)).catch(() => {});
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
        // 队列空：若有被抢占捕获的对端消息，重放它（Phase 2），否则释放。
        const replay = this.pendingReplay.get(queueKey);
        if (replay) {
          this.pendingReplay.delete(queueKey);
          // 清掉去重记录，让原对端消息能再次入队处理（否则被 shouldProcess 当重复丢弃）
          if (replay.message.messageId) this.recentMessageIds.delete(replay.message.messageId);
          logger.info(`[Queue] processNext: replaying preempted peer message (key=${queueKey} mid=${replay.message.messageId ?? 'none'})`);
          const replayMsg: Message = { ...replay.message, source: 'peer-replay' };
          if (!this.queues.has(queueKey)) this.queues.set(queueKey, []);
          this.queues.get(queueKey)!.push({
            message: replayMsg, projectPath: replay.projectPath, agentName: replay.agentName,
            resolve: () => {}, reject: () => {},
          });
          // 继续循环处理重放消息
          continue;
        }
        logger.info(`[Queue] processNext: queue empty, releasing key=${queueKey}`);
        this.processing.delete(queueKey);
        this.processingAgent.delete(queueKey);
        this.currentSessionKey = undefined;
        this.currentProjectPath = undefined;
        this.currentMessage.delete(queueKey);
        this.activeMessageIds.clear();
        return;
      }

      // FIFO 贪心合并：弹出队首连续同 peerId 的消息（插话消息单独处理，不与对端消息合并）
      const items = this.dequeueGreedy(queue);
      const merged = items.length === 1 ? items[0] : this.mergeItems(items);

      this.currentSessionKey = queueKey;
      this.currentProjectPath = merged.projectPath;
      this.currentAgentId = merged.message.agentId;
      this.currentMessage.set(queueKey, merged.message);
      this.processingAgent.set(queueKey, merged.agentName);

      // 记录正在执行的 messageId（用于撤回中断）
      this.activeMessageIds.clear();
      for (const item of items) {
        if (item.message.messageId) this.activeMessageIds.add(item.message.messageId);
      }

      const resolves = items.map(i => i.resolve);
      const rejects = items.map(i => i.reject);

      logger.debug(`[Queue] Processing ${items.length} message(s) from ${merged.message.channel}:${merged.message.channelId}`);
      try {
        await this.handler(merged.message);
        logger.debug(`[Queue] Message processed successfully`);
        resolves.forEach(r => r());
      } catch (error) {
        logger.error(`[Queue] Message processing failed:`, error);
        rejects.forEach(r => r(error as Error));
      }
    }
  }

  /**
   * 贪心弹出队首连续同 peerId 的消息。
   * 遇到不同 peerId 或队列为空时停止。
   */
  private dequeueGreedy(queue: QueuedMessage[]): QueuedMessage[] {
    const first = queue.shift()!;
    const result = [first];
    const peerId = first.message.peerId;

    // 插话消息单独成轮：不与对端消息（即便同 peerId）贪心合并，
    // 保证 owner 插话独立处理、回复独立改道。
    if (this.isInject(first.message)) return result;

    while (queue.length > 0 && queue[0].message.peerId === peerId && !this.isInject(queue[0].message)) {
      result.push(queue.shift()!);
    }

    if (result.length > 1) {
      logger.debug(`[Queue] Greedy dequeue: merged ${result.length} messages from peerId=${peerId}`);
    }

    return result;
  }

  /**
   * 合并多条同 peerId 消息：
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

    for (const item of items) {
      const m = item.message;
      contents.push(m.content);
      if (m.images) allImages.push(...m.images);
      if (m.mentions) allMentions.push(...m.mentions);
      // 逐条保留发送者、时刻、图片；若该条已自带 items（罕见），展开保留细粒度
      if (m.items && m.items.length > 0) {
        subMessages.push(...m.items);
      } else {
        subMessages.push({
          peerId: m.peerId, peerName: m.peerName, peerType: m.peerType,
          sameDevice: m.sameDevice, sameNetwork: m.sameNetwork, sameEgressIp: m.sameEgressIp,
          content: m.content, timestamp: m.timestamp,
          images: m.images && m.images.length > 0 ? m.images : undefined,
          mentionAids: m.mentionAids && m.mentionAids.length > 0 ? m.mentionAids : undefined,
        });
      }
    }

    const last = items[items.length - 1];
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
      const idx = queue.findIndex(q => q.message.messageId === messageId);
      if (idx !== -1) {
        const [removed] = queue.splice(idx, 1);
        removed.resolve();
        logger.info(`[Queue] Cancelled queued message ${messageId}`);
        return true;
      }
    }
    return false;
  }

  /**
   * 撤回正在执行的消息：如果 messageId 正在处理中，触发 interrupt。
   * @returns true 如果找到并触发了中断
   */
  cancelActive(messageId: string): boolean {
    if (!this.activeMessageIds.has(messageId)) return false;
    if (!this.currentSessionKey) return false;

    // 从 queueKey 提取 sessionKey
    const sessionKey = this.currentSessionKey.split('::')[0];
    logger.info(`[Queue] Recalled active message ${messageId}, interrupting session ${sessionKey}`);
    this.eventBus?.publish({
      type: 'task:interrupted',
      sessionId: sessionKey,
      reason: 'recalled',
      agentName: this.processingAgent.get(this.currentSessionKey),
    });
    if (this.interruptCallback) {
      this.interruptCallback(sessionKey, this.currentAgentId, this.processingAgent.get(this.currentSessionKey)).catch(() => {});
    }
    return true;
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
   */
  getQueueLengthByAgent(agentName: string): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      for (const item of queue) {
        if ((item.agentName || DEFAULT_AGENT_NAME) === agentName) total++;
      }
    }
    return total;
  }

  /**
   * 获取指定 agent 的处理中队列数量。
   */
  getProcessingCountByAgent(agentName: string): number {
    let total = 0;
    for (const a of this.processingAgent.values()) {
      if ((a || DEFAULT_AGENT_NAME) === agentName) total++;
    }
    return total;
  }
}
