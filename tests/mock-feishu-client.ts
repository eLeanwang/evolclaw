/**
 * Feishu 客户端模拟器
 * 用于测试消息缓存机制
 */

import { EventEmitter } from 'events';

export interface MockMessage {
  chatId: string;
  content: string;
  timestamp: number;
}

export class MockFeishuClient extends EventEmitter {
  private sentMessages: MockMessage[] = [];
  private sentFiles: Array<{ chatId: string; filePath: string }> = [];

  /**
   * 模拟发送消息到飞书
   */
  async sendMessage(chatId: string, content: string): Promise<void> {
    this.sentMessages.push({
      chatId,
      content,
      timestamp: Date.now()
    });
    console.log(`[MockFeishu] Sent to ${chatId}: ${content.substring(0, 50)}...`);
  }

  /**
   * 模拟发送文件到飞书
   */
  async sendFile(chatId: string, filePath: string): Promise<void> {
    this.sentFiles.push({ chatId, filePath });
    console.log(`[MockFeishu] Sent file to ${chatId}: ${filePath}`);
  }

  /**
   * 模拟接收用户消息
   */
  receiveMessage(chatId: string, content: string, images?: Array<{ data: string; mimeType: string }>): void {
    console.log(`[MockFeishu] Received from ${chatId}: ${content}`);
    this.emit('message', chatId, content, images);
  }

  /**
   * 获取发送的消息列表
   */
  getSentMessages(chatId?: string): MockMessage[] {
    if (chatId) {
      return this.sentMessages.filter(m => m.chatId === chatId);
    }
    return this.sentMessages;
  }

  /**
   * 获取发送的文件列表
   */
  getSentFiles(chatId?: string): Array<{ chatId: string; filePath: string }> {
    if (chatId) {
      return this.sentFiles.filter(f => f.chatId === chatId);
    }
    return this.sentFiles;
  }

  /**
   * 清空记录
   */
  clear(): void {
    this.sentMessages = [];
    this.sentFiles = [];
  }

  /**
   * 等待消息发送（用于测试）
   */
  async waitForMessages(count: number, timeout: number = 5000): Promise<MockMessage[]> {
    const startCount = this.sentMessages.length;
    const startTime = Date.now();

    while (this.sentMessages.length < startCount + count) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Timeout waiting for ${count} messages (got ${this.sentMessages.length - startCount})`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return this.sentMessages.slice(startCount);
  }

  /**
   * 等待特定内容的消息
   */
  async waitForMessageContaining(text: string, timeout: number = 5000): Promise<MockMessage | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const found = this.sentMessages.find(m => m.content.includes(text));
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return null;
  }
}
