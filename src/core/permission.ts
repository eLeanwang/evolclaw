import { canUseTool, summarizeToolInput } from '../utils/permission-utils.js';
import type { EventBus } from './event-bus.js';

interface PendingPermission {
  sessionId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class PermissionGateway {
  private pending = new Map<string, PendingPermission>();
  private timeout = 5 * 60 * 1000;
  private eventBus?: EventBus;

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  async requestPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    mode: string,
    sendPrompt: (text: string) => Promise<void>
  ): Promise<boolean> {
    // 自主模式直接批准
    if (mode === 'autonomous') return true;

    // 先走黑名单检查
    const blacklistResult = await canUseTool(toolName, toolInput);
    if (blacklistResult.behavior === 'deny') return false;

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const summary = summarizeToolInput(toolName, toolInput);

    this.eventBus?.publish({ type: 'permission:requested', sessionId, requestId, toolName, input: summary });

    await sendPrompt(
      `\ud83d\udd10 \u6743\u9650\u8bf7\u6c42 [${requestId}]\n\u5de5\u5177\uff1a${toolName}\n\u64cd\u4f5c\uff1a${summary}\n\n` +
      `\u56de\u590d /perm ${requestId} allow \u6279\u51c6\n\u56de\u590d /perm ${requestId} deny \u62d2\u7edd`
    );

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.eventBus?.publish({ type: 'permission:timeout', sessionId, requestId });
        resolve(false);
      }, this.timeout);
      this.pending.set(requestId, { sessionId, resolve, timer });
    });
  }

  resolvePermission(sessionId: string, requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    clearTimeout(pending.timer);
    pending.resolve(approved);
    this.pending.delete(requestId);
    this.eventBus?.publish({ type: 'permission:resolved', sessionId, requestId, approved });
    return true;
  }

  /** 中断时取消指定会话的所有 pending 权限请求 */
  cancelAll(sessionId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.pending.delete(requestId);
      }
    }
  }
}
