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
