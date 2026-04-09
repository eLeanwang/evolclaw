import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'path';
import { getPackageRoot } from '../paths.js';
import { logger } from '../utils/logger.js';
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config, ReplyContext } from '../types.js';

export interface AUNConfig {
  aid: string;
  keystorePath?: string;
  gatewayUrl?: string;
  accessToken?: string;
  flushDelay?: number;
  pythonBin?: string;
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
  private sidecar: ChildProcess | null = null;
  private messageHandler?: AUNMessageHandler;
  private connected = false;
  private aid?: string;
  private seenMessages = new Map<string, number>();
  private messageSeqMap = new Map<string, number>();  // messageId → seq (for ack)
  private sentCount = new Map<string, number>();  // channelId → 已发消息计数（用于判断最终回复）

  // Reconnect state
  private intentionalDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RECONNECT_DELAYS = [60, 120, 300, 600];  // seconds
  private onChannelDown?: () => void;

  constructor(private config: AUNConfig) {}

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.reconnectAttempt = 0;
    await this.spawnSidecar();
  }

  private async spawnSidecar(): Promise<void> {
    // Clean up existing sidecar if any
    if (this.sidecar) {
      this.sidecar.removeAllListeners();
      this.sidecar.kill('SIGTERM');
      this.sidecar = null;
    }
    this.connected = false;

    const bridgePath = path.join(getPackageRoot(), 'src', 'channels', 'aun_bridge.py');

    // Build env for sidecar
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (this.config.keystorePath) env.AUN_PATH = this.config.keystorePath;
    if (this.config.gatewayUrl) env.AUN_GATEWAY = this.config.gatewayUrl;
    if (this.config.accessToken) env.AUN_ACCESS_TOKEN = this.config.accessToken;
    // Pass AID for authenticate()
    env.AUN_AID = this.config.aid;

    // Resolve Python executable: config.pythonBin → AUN_PYTHON env → system python3
    const pythonBin = this.config.pythonBin || process.env.AUN_PYTHON || 'python3';

    this.sidecar = spawn(pythonBin, [bridgePath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    this.sidecar.on('exit', (code) => {
      logger.warn(`[AUN] Sidecar exited with code ${code}`);
      this.connected = false;
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    this.sidecar.on('error', (err) => {
      logger.error('[AUN] Sidecar error:', err);
      this.connected = false;
    });

    // Read stdout line by line
    if (this.sidecar.stdout) {
      const rl = createInterface({ input: this.sidecar.stdout });
      rl.on('line', (line) => {
        try {
          const event = JSON.parse(line);
          this.handleEvent(event);
        } catch {
          logger.debug('[AUN] Non-JSON output:', line);
        }
      });
    }

    // Wait for ready event (timeout 15s)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('AUN sidecar ready timeout')), 15000);
      const checkReady = () => {
        if (this.connected) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };
      // Also check for early exit
      this.sidecar!.on('exit', () => {
        clearTimeout(timeout);
        if (!this.connected) reject(new Error('AUN sidecar exited before ready'));
      });
      checkReady();
    });
  }

  private handleEvent(event: any): void {
    if (event.event === 'ready') {
      this.aid = event.aid;
      this.connected = true;
      this.reconnectAttempt = 0;  // Reset on successful connection
      logger.info(`[AUN] Connected as ${this.aid}`);
      return;
    }

    if (event.event === 'reconnecting') {
      logger.info(`[AUN] SDK reconnecting (attempt ${event.attempt}/${event.maxAttempts})`);
      return;
    }

    if (event.event === 'disconnected') {
      this.connected = false;
      logger.warn(`[AUN] Disconnected: ${event.reason}`);
      // Sidecar will handle SDK auto_reconnect; if that fails → terminal_failed → exit → our exit handler fires
      return;
    }

    if (event.event === 'terminal_failed') {
      this.connected = false;
      logger.error(`[AUN] Terminal failure: ${event.reason}`);
      // Sidecar will exit(1), our exit handler will call scheduleReconnect()
      return;
    }

    if (event.event === 'error') {
      logger.error(`[AUN] Error: ${event.message}`);
      return;
    }

    if (event.event === 'message') {
      this.handleInboundMessage(event);
    }
  }

  private async handleInboundMessage(event: any): Promise<void> {
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

    // Map sidecar event to handler options
    const mentions = event.mentions?.map((aid: string) => ({ userId: aid }));

    // Build replyContext from taskId
    let replyContext: ReplyContext | undefined;
    if (event.taskId) {
      replyContext = { threadId: event.taskId };
    }

    try {
      await this.messageHandler({
        channelId: event.channelId || '',
        content: event.text || '',
        chatType: event.chatType || 'private',
        peerId: event.userId || event.channelId || '',
        messageId: event.messageId,
        threadId: event.taskId,  // AUN task_id = EvolClaw thread concept
        mentions,
        replyContext,
      });
    } catch (err) {
      logger.error('[AUN] Message handler error:', err);
    }
  }

  onMessage(handler: AUNMessageHandler): void {
    this.messageHandler = handler;
  }

  async sendMessage(channelId: string, text: string, context?: ReplyContext): Promise<void> {
    if (!this.connected || !this.sidecar?.stdin) {
      logger.warn('[AUN] Cannot send: not connected');
      return;
    }

    if (!text?.trim()) {
      logger.warn('[AUN] Attempted to send empty message, skipping');
      return;
    }

    const params: Record<string, any> = { channelId, text };
    if (context?.threadId) params.taskId = context.threadId;
    // 多轮工具调用后的最终回复：仅在已有中间消息时添加前缀
    if (context?.title && (this.sentCount.get(channelId) || 0) > 0) {
      params.text = '最终回复\n' + text;
    }
    this.sentCount.set(channelId, (this.sentCount.get(channelId) || 0) + 1);

    this.write({ method: 'send', params });
  }

  private write(data: any): void {
    if (this.sidecar?.stdin?.writable) {
      this.sidecar.stdin.write(JSON.stringify(data) + '\n');
    }
  }

  acknowledge(messageId: string): void {
    const seq = this.messageSeqMap.get(messageId);
    if (seq != null) {
      this.write({ method: 'ack', params: { seq } });
      this.messageSeqMap.delete(messageId);
    }
  }

  sendProcessingStatus(channelId: string, status: 'start' | 'done' | 'interrupted' | 'error' | 'timeout', sessionId: string, context?: ReplyContext): void {
    if (status === 'start') this.sentCount.delete(channelId);  // 新任务开始，重置计数
    const params: Record<string, any> = { channelId, status, sessionId };
    if (context?.threadId) params.taskId = context.threadId;
    this.write({ method: 'processing', params });
  }

  sendCustomPayload(channelId: string, payload: string): void {
    this.write({ method: 'custom_payload', params: { channelId, payload } });
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sidecar) {
      this.sidecar.removeAllListeners();
      this.sidecar.kill('SIGTERM');
      this.sidecar = null;
    }
    this.connected = false;
    logger.info('[AUN] Disconnected');
  }

  /** Schedule a sidecar restart with exponential backoff */
  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectTimer) return;  // Already scheduled

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
        await this.spawnSidecar();
        logger.info(`[AUN] Reconnect #${this.reconnectAttempt} succeeded`);
        // reconnectAttempt is reset in handleEvent on 'ready'
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
      await this.spawnSidecar();
      return `重连成功 (${this.aid})`;
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
      aid: this.aid,
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
      gatewayUrl: aunConfig.gatewayUrl,
      accessToken: aunConfig.accessToken,
      flushDelay: aunConfig.flushDelay,
      pythonBin: aunConfig.pythonBin,
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
