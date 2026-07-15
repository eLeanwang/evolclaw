import type { InteractionResponse } from '../types.js';
import { logger } from '../utils/logger.js';

interface PendingInteraction {
  callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void | Promise<void>;
  timer?: NodeJS.Timeout;
  sessionId: string;
  initiatorId?: string;
  fallbackCommand?: string;
}

/** 等待生命周期钩子：用于在等待用户交互期间暂停/恢复 idle 监控 */
export interface WaitHooks {
  /** 某 session 从「无待应答交互」变为「有待应答交互」时触发 */
  onWaitStart: (sessionId: string) => void;
  /** 某 session 最后一个待应答交互被解决（应答/取消/超时）时触发 */
  onWaitEnd: (sessionId: string) => void;
}

export class InteractionRouter {
  private handlers = new Map<string, PendingInteraction>();
  /** sessionId → 该会话当前待应答的交互数量，用于触发 wait 生命周期钩子 */
  private pendingBySession = new Map<string, number>();
  private waitHooks?: WaitHooks;

  setWaitHooks(hooks: WaitHooks): void {
    this.waitHooks = hooks;
  }

  /**
   * 在 register() 之前提前标记 session 为等待状态（适用于发卡片有异步延迟的场景）。
   * 必须与 unmarkWaiting() 配对使用，或后续 register() 会接管计数。
   */
  markWaiting(sessionId: string): void {
    this.incPending(sessionId);
  }

  /** 取消 markWaiting() 的占位（后续若有 register() 接管则不需调用此方法） */
  unmarkWaiting(sessionId: string): void {
    this.decPending(sessionId);
  }

  /** 登记一个待应答交互；session 计数 0→1 时触发 onWaitStart */
  private incPending(sessionId: string): void {
    const next = (this.pendingBySession.get(sessionId) ?? 0) + 1;
    this.pendingBySession.set(sessionId, next);
    if (next === 1) this.waitHooks?.onWaitStart(sessionId);
  }

  /** 注销一个待应答交互；session 计数 1→0 时触发 onWaitEnd */
  private decPending(sessionId: string): void {
    const cur = this.pendingBySession.get(sessionId) ?? 0;
    if (cur <= 0) return;
    const next = cur - 1;
    if (next === 0) {
      this.pendingBySession.delete(sessionId);
      this.waitHooks?.onWaitEnd(sessionId);
    } else {
      this.pendingBySession.set(sessionId, next);
    }
  }

  register(
    id: string,
    sessionId: string,
    callback: (action: string, values?: Record<string, unknown>, operatorId?: string) => void | Promise<void>,
    opts?: { timeoutMs?: number; onTimeout?: () => void; initiatorId?: string; fallbackCommand?: string },
  ): void {
    // 同 id 替换：槽位本就占用，计数不变，不触发 wait 钩子
    const existing = this.handlers.get(id);
    if (existing?.timer) clearTimeout(existing.timer);
    const isReplacement = !!existing;

    let timer: NodeJS.Timeout | undefined;
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        this.handlers.delete(id);
        this.decPending(sessionId);
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
    if (!isReplacement) this.incPending(sessionId);
  }

  handle(response: InteractionResponse): boolean {
    const handler = this.handlers.get(response.id);
    if (!handler) return false;

    // Initiator 校验（集中式 backstop）：非发起者的操作直接丢弃，不消费 handler、不解除等待，
    // 让真正的发起者仍可继续操作。身份只信渠道传入的已认证 operatorId（来自消息信封，非 payload 自报）。
    // 渠道层若已自行校验（如飞书的 reject toast），此处不会重复命中（operatorId 已匹配）。
    if (handler.initiatorId && response.operatorId !== handler.initiatorId) {
      logger.info(`[InteractionRouter] rejected unauthenticated or non-initiator response: operator=${response.operatorId ?? '<missing>'} initiator=${handler.initiatorId} id=${response.id}`);
      return false;
    }

    if (handler.timer) clearTimeout(handler.timer);
    this.handlers.delete(response.id);
    this.decPending(handler.sessionId);

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
        this.decPending(handler.sessionId);
      }
    }
  }

  cancel(id: string): void {
    const handler = this.handlers.get(id);
    if (handler) {
      if (handler.timer) clearTimeout(handler.timer);
      this.handlers.delete(id);
      this.decPending(handler.sessionId);
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
