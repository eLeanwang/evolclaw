/**
 * MessageStream - Push-based async iterable for streaming user messages to the SDK.
 * Based on HappyClaw's implementation.
 */

import { logger } from '../utils/logger.js';

export interface ImageData {
  data: string;      // base64 encoded
  mimeType?: string; // e.g., 'image/png'
}

export interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    >;
  };
  parent_tool_use_id: null;
  session_id: string;
}

export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: ImageData[]): void {
    let content:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
        >;

    if (images && images.length > 0) {
      logger.debug('[MessageStream] Creating multimodal message with', images.length, 'images');
      logger.debug('[MessageStream] Image sizes:', images.map(img => img.data.length).join(', '));

      // 多模态消息：text + images
      content = [
        { type: 'text', text },
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mimeType || 'image/png',
            data: img.data,
          },
        })),
      ];
    } else {
      // 纯文本消息
      content = text;
    }

    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    };

    logger.debug('[MessageStream] Pushing message, content type:', Array.isArray(content) ? 'array' : 'string');
    this.queue.push(message);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}
