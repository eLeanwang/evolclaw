import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'path';
import { getPackageRoot } from '../paths.js';
import { logger } from '../utils/logger.js';
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config, ReplyContext } from '../types.js';

export interface AUNConfig {
  domain: string;
  agentName: string;
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

  constructor(private config: AUNConfig) {}

  async connect(): Promise<void> {
    const bridgePath = path.join(getPackageRoot(), 'src', 'channels', 'aun_bridge.py');

    // Build env for sidecar
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (this.config.keystorePath) env.AUN_PATH = this.config.keystorePath;
    if (this.config.gatewayUrl) env.AUN_GATEWAY = this.config.gatewayUrl;
    if (this.config.accessToken) env.AUN_ACCESS_TOKEN = this.config.accessToken;
    // Pass AID for authenticate() — constructed from config
    env.AUN_AID = `${this.config.agentName}.${this.config.domain}`;

    // Resolve Python executable: config.pythonBin → AUN_PYTHON env → system python3
    const pythonBin = this.config.pythonBin || process.env.AUN_PYTHON || 'python3';

    this.sidecar = spawn(pythonBin, [bridgePath], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env,
    });

    this.sidecar.on('exit', (code) => {
      logger.warn(`[AUN] Sidecar exited with code ${code}`);
      this.connected = false;
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
      logger.info(`[AUN] Connected as ${this.aid}`);
      return;
    }

    if (event.event === 'disconnected') {
      this.connected = false;
      logger.warn(`[AUN] Disconnected: ${event.reason}`);
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

    this.write({ method: 'send', params });
  }

  private write(data: any): void {
    if (this.sidecar?.stdin?.writable) {
      this.sidecar.stdin.write(JSON.stringify(data) + '\n');
    }
  }

  async disconnect(): Promise<void> {
    if (this.sidecar) {
      this.sidecar.kill('SIGTERM');
      this.sidecar = null;
    }
    this.connected = false;
    logger.info('[AUN] Disconnected');
  }
}

// Plugin implementation
export class AUNChannelPlugin implements ChannelPlugin {
  readonly name = 'aun';

  isEnabled(config: Config): boolean {
    return config.channels?.aun?.enabled !== false && !!config.channels?.aun?.domain;
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const aunConfig = config.channels?.aun;
    if (!aunConfig?.domain || !aunConfig?.agentName) {
      throw new Error('AUN config missing (domain and agentName required)');
    }

    const channel = new AUNChannel({
      domain: aunConfig.domain,
      agentName: aunConfig.agentName,
      keystorePath: aunConfig.keystorePath,
      gatewayUrl: aunConfig.gatewayUrl,
      accessToken: aunConfig.accessToken,
      flushDelay: aunConfig.flushDelay,
      pythonBin: aunConfig.pythonBin,
    });

    const adapter = {
      name: 'aun' as const,
      sendText: (id: string, text: string, context?: ReplyContext) => channel.sendMessage(id, text, context),
    };

    const policy = {
      canSwitchProject: (chatType: string, identity: string) => identity === 'owner',
      canListProjects: (chatType: string, identity: string) => identity === 'owner',
      canCreateSession: (chatType: string, identity: string) => true,
      canDeleteSession: (chatType: string, identity: string) => true,
      canImportCliSession: (chatType: string, identity: string) => identity === 'owner',
      messagePrefix: (chatType: string, peerName?: string) => (chatType === 'group' && peerName) ? `[${peerName}] ` : '',
      showMiddleResult: (chatType: string, identity: string) => {
        const mode = config.showActivities || 'all';
        if (mode === 'none') return false;
        if (mode === 'dm-only') return chatType === 'private';
        if (mode === 'owner-dm-only') return chatType === 'private' && identity === 'owner';
        return true;
      },
      showIdleMonitor: (chatType: string, identity: string) => {
        const mode = config.showActivities || 'all';
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
