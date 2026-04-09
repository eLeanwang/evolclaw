import { AUNClient, FileSecretStore } from '@aun/core-node';
import { logger } from '../utils/logger.js';
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config, ReplyContext } from '../types.js';

export interface AUNConfig {
  aid: string;
  keystorePath?: string;
  gatewayPort?: number;
  gatewayUrl?: string;    // 兼容旧配置，优先级高于 gatewayPort
  accessToken?: string;
  flushDelay?: number;
  encryptionSeed?: string;
}

export interface AUNMessageHandler {
  (options: {
    channelId: string;
    content: string;
    chatType: 'private' | 'group';
    peerId: string;
    messageId?: string;
    threadId?: string;
    mentions?: Array<{ userId: string; name?: string }>;
    replyContext?: ReplyContext;
  }): Promise<void>;
}

export class AUNChannel {
  private client: AUNClient | null = null;
  private messageHandler?: AUNMessageHandler;
  private connected = false;
  private _aid?: string;
  private seenMessages = new Map<string, number>();
  private messageSeqMap = new Map<string, number>();  // messageId → seq (for ack)
  private sentCount = new Map<string, number>();  // channelId → 已发消息计数（用于判断最终回复）

  // Reconnect state (TS-layer fallback, on top of SDK auto_reconnect)
  private intentionalDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RECONNECT_DELAYS = [60, 120, 300, 600];  // seconds
  private onChannelDown?: () => void;

  constructor(private config: AUNConfig) {}

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.reconnectAttempt = 0;
    await this.initClient();
  }

  private async initClient(): Promise<void> {
    // Clean up existing client if any
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
    this.connected = false;

    const aunPath = this.config.keystorePath || `${process.env.HOME || '~'}/.aun`;
    const aidName = this.config.aid;
    const encryptionSeed = this.config.encryptionSeed || process.env.AUN_ENCRYPTION_SEED || undefined;

    // Gateway URL: 旧配置 gatewayUrl 优先，否则从 AID 推导
    let gateway = this.config.gatewayUrl || '';
    if (!gateway) {
      const parts = aidName.split('.');
      if (parts.length >= 3) {
        const domain = parts.slice(1).join('.');  // alice.agentid.pub → agentid.pub
        const port = this.config.gatewayPort || 443;
        gateway = `wss://gateway.${domain}:${port}/aun`;
      }
    }

    if (!gateway) {
      logger.error('[AUN] Cannot derive gateway URL from AID');
      return;
    }

    logger.info(`[AUN] Initializing: aid=${aidName}, gateway=${gateway}, aun_path=${aunPath}`);

    // Create client with FileSecretStore (AES-256-GCM)
    // 不传 encryption_seed 时，SDK 自动从 {aun_path}/.seed 文件派生密钥（与 aun_cli.py 对齐）
    this.client = new AUNClient({
      aun_path: aunPath,
      ...(encryptionSeed && { encryption_seed: encryptionSeed }),
    });
    // Set gateway URL (internal property, same as Python SDK)
    (this.client as any)._gatewayUrl = gateway;

    // Register event handlers before connecting
    this.client.on('message.received', (data: unknown) => this.handleIncomingPrivateMessage(data));
    this.client.on('group.message_created', (data: unknown) => this.handleIncomingGroupMessage(data));
    this.client.on('connection.state', (data: unknown) => this.handleConnectionState(data));

    // Authenticate
    let accessToken: string;
    try {
      logger.info(`[AUN] Authenticating as ${aidName}...`);
      const auth = await this.client.auth.authenticate(aidName ? { aid: aidName } : undefined);
      accessToken = auth.access_token as string;
      const resolvedGateway = (auth.gateway as string) || gateway;
      (this.client as any)._gatewayUrl = resolvedGateway;
      logger.info(`[AUN] Authenticated as ${auth.aid ?? '?'}, gateway=${resolvedGateway}`);
    } catch (e: any) {
      const errMsg = e.message || String(e);
      const errName = e.constructor?.name || 'Error';
      logger.error(`[AUN] Authentication failed (${errName}): ${errMsg}`);
      if (e.stack) logger.debug(`[AUN] Auth stack: ${e.stack}`);
      // Fallback: try direct token from env/config (legacy)
      accessToken = this.config.accessToken || process.env.AUN_ACCESS_TOKEN || '';
      if (!accessToken) {
        logger.error(`[AUN] No accessToken fallback available, AUN channel disabled`);
        return;
      }
      logger.warn(`[AUN] Using accessToken fallback`);
    }

    // Connect (SDK auto_reconnect handles transient failures)
    try {
      await this.client.connect(
        { access_token: accessToken, gateway: (this.client as any)._gatewayUrl },
        { auto_reconnect: true, retry: { max_attempts: 5, initial_delay: 1.0, max_delay: 30.0 } },
      );
      this._aid = this.client.aid ?? undefined;
      this.connected = true;
      this.reconnectAttempt = 0;
      logger.info(`[AUN] Connected as ${this._aid}`);
    } catch (e) {
      logger.error(`[AUN] Connection failed: ${e}`);
      return;
    }
  }

  // ── Event handlers ──────────────────────────────────────────

  private async handleIncomingPrivateMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    const fromAid = msg.from ?? '';
    const payload = msg.payload ?? '';
    const text = typeof payload === 'string' ? payload : (payload ? JSON.stringify(payload) : '');
    const taskId = msg.task_id;
    const messageId = msg.message_id ?? '';
    const seq = msg.seq;

    // Detect @mentions
    const mentions: string[] = [];
    if (this._aid && text.includes(`@${this._aid}`)) {
      mentions.push(this._aid);
    }

    this.dispatchMessage({
      channelId: fromAid,
      userId: fromAid,
      text,
      chatType: 'private',
      messageId,
      seq,
      taskId,
      mentions,
    });
  }

  private async handleIncomingGroupMessage(data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    const msg = data as Record<string, any>;

    const groupId = msg.group_id ?? '';
    const senderAid = msg.sender_aid ?? msg.from ?? '';
    const payload = msg.payload ?? '';
    const text = typeof payload === 'string' ? payload : (payload ? JSON.stringify(payload) : '');
    const taskId = msg.task_id;
    const messageId = msg.message_id ?? '';
    const seq = msg.seq;

    // Detect @mentions
    const mentions: string[] = [];
    if (this._aid && text.includes(`@${this._aid}`)) {
      mentions.push(this._aid);
    }

    this.dispatchMessage({
      channelId: groupId,
      userId: senderAid,
      text,
      chatType: 'group',
      messageId,
      seq,
      taskId,
      mentions,
    });
  }

  private dispatchMessage(event: {
    channelId: string; userId: string; text: string;
    chatType: 'private' | 'group'; messageId: string;
    seq?: number; taskId?: string; mentions?: string[];
  }): void {
    // Dedup
    if (event.messageId) {
      if (this.seenMessages.has(event.messageId)) return;
      this.seenMessages.set(event.messageId, Date.now());
      setTimeout(() => this.seenMessages.delete(event.messageId), 5 * 60 * 1000);
      // Track seq for acknowledge
      if (event.seq != null) {
        this.messageSeqMap.set(event.messageId, event.seq);
      }
    }

    if (!this.messageHandler) return;

    const mentionObjects = event.mentions?.map(aid => ({ userId: aid }));
    let replyContext: ReplyContext | undefined;
    if (event.taskId) {
      replyContext = { threadId: event.taskId };
    }

    this.messageHandler({
      channelId: event.channelId || '',
      content: event.text || '',
      chatType: event.chatType,
      peerId: event.userId || event.channelId || '',
      messageId: event.messageId,
      threadId: event.taskId,
      mentions: mentionObjects,
      replyContext,
    }).catch(err => {
      logger.error('[AUN] Message handler error:', err);
    });
  }

  private handleConnectionState(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const state = (data as Record<string, any>).state ?? '';

    if (state === 'connected') {
      this.connected = true;
      this.reconnectAttempt = 0;
      logger.info('[AUN] Connected');
    } else if (state === 'disconnected') {
      this.connected = false;
      logger.warn(`[AUN] Disconnected: ${(data as Record<string, any>).error ?? 'unknown'}`);
    } else if (state === 'reconnecting') {
      logger.info(`[AUN] SDK reconnecting (attempt ${(data as Record<string, any>).attempt})`);
    } else if (state === 'terminal_failed') {
      this.connected = false;
      logger.error(`[AUN] Terminal failure: ${(data as Record<string, any>).error ?? 'unknown'}`);
      // SDK auto_reconnect exhausted; fall back to TS-layer reconnect
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    }
  }

  // ── Public API (same interface as before) ───────────────────

  onMessage(handler: AUNMessageHandler): void {
    this.messageHandler = handler;
  }

  async sendMessage(channelId: string, text: string, context?: ReplyContext): Promise<void> {
    if (!this.connected || !this.client) {
      logger.warn('[AUN] Cannot send: not connected');
      return;
    }

    if (!text?.trim()) {
      logger.warn('[AUN] Attempted to send empty message, skipping');
      return;
    }

    let finalText = text;
    // 多轮工具调用后的最终回复：仅在已有中间消息时添加前缀
    if (context?.title && (this.sentCount.get(channelId) || 0) > 0) {
      finalText = '最终回复\n' + text;
    }
    this.sentCount.set(channelId, (this.sentCount.get(channelId) || 0) + 1);

    const params: Record<string, any> = { payload: finalText, encrypt: true };
    if (context?.threadId) params.task_id = context.threadId;

    try {
      if (channelId.startsWith('grp_')) {
        params.group_id = channelId;
        await this.client.call('group.send', params);
      } else {
        params.to = channelId;
        await this.client.call('message.send', params);
      }
    } catch (e) {
      logger.error(`[AUN] Send failed to ${channelId}: ${e}`);
    }
  }

  acknowledge(messageId: string): void {
    const seq = this.messageSeqMap.get(messageId);
    if (seq != null && this.client) {
      this.client.call('message.ack', { seq }).catch(e => {
        logger.debug(`[AUN] Ack failed: ${e}`);
      });
      this.messageSeqMap.delete(messageId);
    }
  }

  sendProcessingStatus(channelId: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout', sessionId: string, context?: ReplyContext): void {
    if (status === 'start') this.sentCount.delete(channelId);  // 新任务开始，重置计数
    if (!this.client || !this.connected) return;

    const payload = JSON.stringify({
      type: 'processing',
      status,
      sessionId,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const params: Record<string, any> = {
      to: channelId, payload,
      encrypt: true, persist: false,
    };
    if (context?.threadId) params.task_id = context.threadId;

    this.client.call('message.send', params).catch(e => {
      logger.debug(`[AUN] Processing status failed: ${e}`);
    });
  }

  sendCustomPayload(channelId: string, payload: string): void {
    if (!this.client || !this.connected) return;

    this.client.call('message.send', {
      to: channelId, payload,
      encrypt: true, persist: false,
    }).catch(e => {
      logger.debug(`[AUN] Custom payload failed: ${e}`);
    });
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
    this.connected = false;
    logger.info('[AUN] Disconnected');
  }

  // ── TS-layer reconnect (fallback when SDK auto_reconnect exhausted) ──

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectTimer) return;

    const delays = AUNChannel.RECONNECT_DELAYS;
    if (this.reconnectAttempt >= delays.length) {
      logger.error(`[AUN] All ${delays.length} reconnect attempts exhausted, giving up`);
      this.onChannelDown?.();
      return;
    }

    const delay = delays[this.reconnectAttempt];
    this.reconnectAttempt++;
    logger.info(`[AUN] Scheduling reconnect #${this.reconnectAttempt}/${delays.length} in ${delay}s`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        logger.info(`[AUN] Reconnect #${this.reconnectAttempt} starting...`);
        await this.initClient();
        logger.info(`[AUN] Reconnect #${this.reconnectAttempt} succeeded`);
      } catch (err) {
        logger.error(`[AUN] Reconnect #${this.reconnectAttempt} failed:`, err);
        this.scheduleReconnect();
      }
    }, delay * 1000);
  }

  /** Manually trigger reconnect (e.g. from /check reconnect command) */
  async reconnect(): Promise<string> {
    if (this.connected) return '已连接，无需重连';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    try {
      await this.initClient();
      return `重连成功 (${this._aid})`;
    } catch (err) {
      this.scheduleReconnect();
      return `重连失败: ${err}，已安排自动重试`;
    }
  }

  /** Set callback for when all reconnect attempts are exhausted */
  setOnChannelDown(callback: () => void): void {
    this.onChannelDown = callback;
  }

  /** Get current connection status */
  getStatus(): { connected: boolean; aid?: string; reconnectAttempt: number; maxAttempts: number } {
    return {
      connected: this.connected,
      aid: this._aid,
      reconnectAttempt: this.reconnectAttempt,
      maxAttempts: AUNChannel.RECONNECT_DELAYS.length,
    };
  }
}

// Plugin implementation
export class AUNChannelPlugin implements ChannelPlugin {
  readonly name = 'aun';

  isEnabled(config: Config): boolean {
    return config.channels?.aun?.enabled !== false && !!config.channels?.aun?.aid;
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const aunConfig = config.channels?.aun;
    if (!aunConfig?.aid) {
      throw new Error('AUN config missing (aid required, e.g. "mybot.agentid.pub")');
    }

    const channel = new AUNChannel({
      aid: aunConfig.aid,
      keystorePath: aunConfig.keystorePath,
      gatewayPort: aunConfig.gatewayPort,
      gatewayUrl: aunConfig.gatewayUrl,
      accessToken: aunConfig.accessToken,
      flushDelay: aunConfig.flushDelay,
      encryptionSeed: aunConfig.encryptionSeed,
    });

    const adapter = {
      name: 'aun' as const,
      sendText: (id: string, text: string, context?: ReplyContext) => channel.sendMessage(id, text, context),
      acknowledge: (messageId: string) => { channel.acknowledge(messageId); return Promise.resolve(); },
      sendProcessingStatus: (id: string, status: 'start' | 'done', sessionId: string, context?: ReplyContext) => channel.sendProcessingStatus(id, status, sessionId, context),
      sendCustomPayload: (id: string, payload: string) => channel.sendCustomPayload(id, payload),
    };

    const policy = {
      canSwitchProject: (chatType: string, identity: string) => identity === 'owner',
      canListProjects: (chatType: string, identity: string) => identity === 'owner',
      canCreateSession: (chatType: string, identity: string) => true,
      canDeleteSession: (chatType: string, identity: string) => true,
      canImportCliSession: (chatType: string, identity: string) => identity === 'owner',
      messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
      showMiddleResult: (chatType: string, identity: string) => {
        const mode = aunConfig.showActivities ?? config.showActivities ?? 'all';
        if (mode === 'none') return false;
        if (mode === 'dm-only') return chatType === 'private';
        if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
        return true;
      },
      showIdleMonitor: (chatType: string, identity: string) => {
        const mode = aunConfig.showActivities ?? config.showActivities ?? 'all';
        if (mode === 'none') return false;
        if (mode === 'dm-only') return chatType === 'private';
        if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
        return true;
      },
      accumulateErrors: (chatType: string, identity: string) => true,
    };

    const options = {
      flushDelay: aunConfig.flushDelay ?? 3,
      fileMarkerPattern: /\[SEND_FILE:(?:(\w+):)?([^\]]+)\]/g,
    };

    return {
      adapter,
      channel,
      policy,
      options,
      connect: () => channel.connect(),
      disconnect: () => channel.disconnect(),
    };
  }
}
