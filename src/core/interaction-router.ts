import type { InteractionResponse } from '../types.js';
import { logger } from '../utils/logger.js';

interface PendingInteraction {
  callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void | Promise<void>;
  timer?: NodeJS.Timeout;
  sessionId: string;
  initiatorId?: string;
  fallbackCommand?: string;
}

export class InteractionRouter {
  private handlers = new Map<string, PendingInteraction>();

  register(
    id: string,
    sessionId: string,
    callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void | Promise<void>,
    opts?: { timeoutMs?: number; onTimeout?: () => void; initiatorId?: string; fallbackCommand?: string },
  ): void {
    const existing = this.handlers.get(id);
    if (existing?.timer) clearTimeout(existing.timer);

    let timer: NodeJS.Timeout | undefined;
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        this.handlers.delete(id);
        logger.debug(`[InteractionRouter] Timeout for interaction: ${id}`);
        opts.onTimeout?.();
      }, opts.timeoutMs);
    }

    this.handlers.set(id, {
      callback,
      timer,
      sessionId,
      initiatorId: opts?.initiatorId,
      fallbackCommand: opts?.fallbackCommand,
    });
  }

  handle(response: InteractionResponse): boolean {
    const handler = this.handlers.get(response.id);
    if (!handler) return false;

    if (handler.timer) clearTimeout(handler.timer);
    this.handlers.delete(response.id);

    try {
      const result = handler.callback(response.action, response.values, response.operatorId);
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

  getInitiator(id: string): string | undefined {
    return this.handlers.get(id)?.initiatorId;
  }

  findPendingByCommand(sessionId: string, command: string): string | undefined {
    for (const [id, handler] of this.handlers.entries()) {
      if (handler.sessionId === sessionId && handler.fallbackCommand === command) {
        return id;
      }
    }
    return undefined;
  }
}
import type { CommandCard, InteractionRequest } from '../types.js';

/** 把 CommandCard 渲染为文本提示，channel 不支持卡片时使用 */
export function renderCommandCardAsText(card: CommandCard): string {
  const lines: string[] = [card.title];
  if (card.body) lines.push(card.body);
  lines.push('', '可用命令:');
  for (const btn of card.buttons) {
    const marker = btn.disabled ? '✓' : ' ';
    lines.push(`  ${marker} ${btn.command}    ← ${btn.label}`);
  }
  return lines.join('\n');
}

/** 把 ActionInteraction 渲染为文本提示，channel 不支持卡片或卡片发送失败时使用 */
export function renderActionAsText(req: InteractionRequest): string {
  if (req.kind.kind !== 'action') {
    throw new Error('[renderActionAsText] expected ActionInteraction, got ' + req.kind.kind);
  }
  const action = req.kind;
  const fb = req.fallback;
  const lines: string[] = [action.title];
  if (action.body) lines.push(action.body);

  // checkers 多选：渲染选项列表
  if (action.checkers?.length) {
    lines.push('');
    action.checkers.forEach((chk, idx) => {
      const desc = chk.description ? ` — ${chk.description}` : '';
      lines.push(`  ${idx + 1}. ${chk.label}${desc}`);
    });
    lines.push('', '回复选项编号（多选用逗号分隔），或输入自定义内容');
    return lines.join('\n');
  }

  if (!fb) {
    return lines.join('\n');
  }

  lines.push('', '回复:');
  for (const btn of action.buttons) {
    const arg = fb.buttonArgMap?.[btn.key] ?? btn.key;
    lines.push(`  /${fb.command} ${arg}    ← ${btn.label}`);
  }
  if (fb.acceptFreeText && fb.freeTextHint) {
    lines.push(`  ${fb.freeTextHint}`);
  }
  if (action.allowCustomInput) {
    lines.push(`  或直接输入自定义内容`);
  }
  return lines.join('\n');
}
