import { logger } from '../utils/logger.js';

export interface ACPConfig {
  domain: string;
  agentName: string;
}

export interface MessageHandler {
  (sessionId: string, content: string): Promise<void>;
}

export class ACPChannel {
  private messageHandler?: MessageHandler;
  private connected = false;

  constructor(private config: ACPConfig) {}

  async connect(): Promise<void> {
    // TODO: 集成真实的 ACP SDK (agentcp_node 或其他)
    // 当前为占位符实现，确保接口一致性
    this.connected = true;
    logger.info(`[ACP] Connected as ${this.config.agentName}@${this.config.domain}`);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    if (!this.connected) throw new Error('ACP not connected');
    // TODO: 实现真实的消息发送
    logger.debug(`[ACP] Send to ${sessionId}: ${content.slice(0, 50)}...`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('[ACP] Disconnected');
  }
}
