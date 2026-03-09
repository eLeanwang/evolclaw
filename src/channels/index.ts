export interface MessageChannel {
  connect(): Promise<void>;
  onMessage(handler: (id: string, content: string) => Promise<void>): void;
  sendMessage(id: string, content: string): Promise<void>;
  disconnect(): Promise<void>;
}

export { FeishuChannel, type FeishuConfig } from './feishu.js';
export { ACPChannel, type ACPConfig } from './acp.js';
