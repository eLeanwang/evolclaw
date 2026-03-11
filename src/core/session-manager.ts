import { Message } from '../types.js';

export type SessionMode = 'shared' | 'isolated';

export interface SessionMapping {
  channelSessionKey: string;
  claudeSessionId: string;
}

export class SessionManager {
  private mode: SessionMode;
  private mappings = new Map<string, string>();

  constructor(mode: SessionMode = 'isolated') {
    this.mode = mode;
  }

  getClaudeSessionId(message: Message): string {
    const channelKey = this.getChannelSessionKey(message);

    if (!this.mappings.has(channelKey)) {
      const claudeSessionId = this.generateClaudeSessionId(message);
      this.mappings.set(channelKey, claudeSessionId);
    }

    return this.mappings.get(channelKey)!;
  }

  private getChannelSessionKey(message: Message): string {
    if (this.mode === 'shared') {
      return `${message.channel}-shared`;
    }
    return `${message.channel}-${message.channelId}`;
  }

  private generateClaudeSessionId(message: Message): string {
    const timestamp = Date.now();
    if (this.mode === 'shared') {
      return `${message.channel}-shared-${timestamp}`;
    }
    return `${message.channel}-${message.channelId}-${timestamp}`;
  }

  setMode(mode: SessionMode): void {
    this.mode = mode;
  }

  getMode(): SessionMode {
    return this.mode;
  }

  getAllMappings(): SessionMapping[] {
    return Array.from(this.mappings.entries()).map(([channelSessionKey, claudeSessionId]) => ({
      channelSessionKey,
      claudeSessionId,
    }));
  }

  clearMapping(channelSessionKey: string): void {
    this.mappings.delete(channelSessionKey);
  }
}
