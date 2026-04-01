import { logger } from '../utils/logger.js';

export interface AUNConfig {
  domain: string;
  agentName: string;
}

export interface MessageHandler {
  (sessionId: string, content: string): Promise<void>;
}

export class AUNChannel {
  private messageHandler?: MessageHandler;
  private connected = false;

  constructor(private config: AUNConfig) {}

  async connect(): Promise<void> {
    // TODO: 集成真实的 AUN SDK
    // 当前为占位符实现，确保接口一致性
    this.connected = true;
    logger.info(`[AUN] Connected as ${this.config.agentName}@${this.config.domain}`);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    if (!this.connected) throw new Error('AUN not connected');
    // TODO: 实现真实的消息发送
    logger.debug(`[AUN] Send to ${sessionId}: ${content.slice(0, 50)}...`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('[AUN] Disconnected');
  }
}

// Plugin implementation
import type { ChannelPlugin, ChannelInstance } from '../core/channel-loader.js';
import type { Config } from '../types.js';

export class AUNChannelPlugin implements ChannelPlugin {
  readonly name = 'aun';

  isEnabled(config: Config): boolean {
    return config.channels?.aun?.enabled !== false && !!config.channels?.aun?.domain;
  }

  async createChannel(config: Config): Promise<ChannelInstance> {
    const aunConfig = config.channels?.aun;
    if (!aunConfig?.domain || !aunConfig?.agentName) {
      throw new Error('AUN config missing');
    }

    const channel = new AUNChannel({
      domain: aunConfig.domain,
      agentName: aunConfig.agentName,
    });

    const adapter = {
      name: 'aun' as const,
      sendText: (id: string, text: string) => channel.sendMessage(id, text),
    };

    return {
      adapter,
      channel,
      connect: () => channel.connect(),
      disconnect: () => channel.disconnect(),
    };
  }
}
