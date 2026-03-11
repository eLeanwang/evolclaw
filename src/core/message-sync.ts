import { readFileSync } from 'fs';
import { MessageDatabase, MessageRecord } from './database.js';
import { logger } from '../utils/logger.js';

interface StopHookInput {
  session_id: string;
  transcript_path: string;
}

export class MessageSync {
  private db: MessageDatabase;
  private fullSyncInterval: number;
  private syncTimer?: NodeJS.Timeout;

  constructor(db: MessageDatabase, fullSyncInterval: number = 300000) {
    this.db = db;
    this.fullSyncInterval = fullSyncInterval;
  }

  start(): void {
    this.syncTimer = setInterval(() => {
      this.checkAndRunFullSync();
    }, this.fullSyncInterval);
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  async onStopHook(input: StopHookInput): Promise<void> {
    await this.syncLatest(input.session_id, input.transcript_path);
  }

  private async syncLatest(sessionId: string, transcriptPath: string): Promise<void> {
    const lastLine = this.db.getLastSyncedLine(sessionId);
    const messages = this.parseJSONL(transcriptPath, lastLine);

    for (const msg of messages) {
      this.db.insertMessage(msg);
    }

    if (messages.length > 0) {
      const maxLine = Math.max(...messages.map(m => m.line_number));
      this.db.updateSyncState(sessionId, maxLine, false);
    }
  }

  private checkAndRunFullSync(): void {
    // 这里需要遍历所有活跃会话，暂时简化实现
    // 实际使用时由 InstanceManager 触发
  }

  async syncFull(sessionId: string, transcriptPath: string): Promise<void> {
    const messages = this.parseJSONL(transcriptPath, 0);

    for (const msg of messages) {
      this.db.insertMessage(msg);
    }

    if (messages.length > 0) {
      const maxLine = Math.max(...messages.map(m => m.line_number));
      this.db.updateSyncState(sessionId, maxLine, true);
    }
  }

  private parseJSONL(path: string, fromLine: number): MessageRecord[] {
    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const messages: MessageRecord[] = [];

      for (let i = fromLine; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        const entry = JSON.parse(line);
        const role = entry.role as 'user' | 'assistant';

        let content = '';
        if (Array.isArray(entry.content)) {
          content = entry.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        } else if (typeof entry.content === 'string') {
          content = entry.content;
        }

        messages.push({
          session_id: entry.session_id || 'unknown',
          role,
          content,
          timestamp: entry.timestamp || Date.now(),
          line_number: i
        });
      }

      return messages;
    } catch (error) {
      logger.error(`Failed to parse JSONL: ${path}`, error);
      return [];
    }
  }
}
