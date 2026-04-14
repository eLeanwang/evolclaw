import type { InteractionResponse } from '../types.js';
import { logger } from '../utils/logger.js';

interface PendingInteraction {
  callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void | Promise<void>;
  timer?: NodeJS.Timeout;
  sessionId: string;
}

export class InteractionRouter {
  private handlers = new Map<string, PendingInteraction>();

  register(
    id: string,
    sessionId: string,
    callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void | Promise<void>,
    timeoutMs?: number,
    onTimeout?: () => void,
  ): void {
    // Clear any existing handler for this ID
    const existing = this.handlers.get(id);
    if (existing?.timer) clearTimeout(existing.timer);

    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        this.handlers.delete(id);
        logger.debug(`[InteractionRouter] Timeout for interaction: ${id}`);
        onTimeout?.();
      }, timeoutMs);
    }

    this.handlers.set(id, { callback, timer, sessionId });
  }

  handle(response: InteractionResponse): boolean {
    const handler = this.handlers.get(response.id);
    if (!handler) return false;

    if (handler.timer) clearTimeout(handler.timer);
    this.handlers.delete(response.id);

    try {
      const result = handler.callback(response.action, response.values, response.operatorId);
      // Catch async callback errors to prevent unhandled rejections
      if (result && typeof (result as any).catch === 'function') {
        (result as any).catch((err: unknown) => {
          logger.error(`[InteractionRouter] Async callback error for ${response.id}:`, err);
        });
      }
    } catch (err) {
      logger.error(`[InteractionRouter] Callback error for ${response.id}:`, err);
    }
    return true;
  }

  cancelAll(sessionId: string): void {
    for (const [id, handler] of this.handlers.entries()) {
      if (handler.sessionId === sessionId) {
        if (handler.timer) clearTimeout(handler.timer);
        this.handlers.delete(id);
      }
    }
  }

  /** Cancel a single interaction by ID */
  cancel(id: string): void {
    const handler = this.handlers.get(id);
    if (handler) {
      if (handler.timer) clearTimeout(handler.timer);
      this.handlers.delete(id);
    }
  }

  getPending(sessionId: string): string[] {
    const ids: string[] = [];
    for (const [id, handler] of this.handlers.entries()) {
      if (handler.sessionId === sessionId) ids.push(id);
    }
    return ids;
  }
}
