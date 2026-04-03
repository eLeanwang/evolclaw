import { summarizeToolInput } from '../utils/permission-utils.js';
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

  /**
   * 请求人工审批。调用方负责模式判断（仅 approve 模式调用此方法）。
   * 黑名单检查由调用方（preToolUseHook）在调用此方法前完成。
   */
  async requestPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    sendPrompt: (text: string) => Promise<void>,
    summary?: string,
    reason?: string
  ): Promise<boolean> {
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displaySummary = summary || summarizeToolInput(toolName, toolInput);
    const reasonLine = reason ? `\n原因：${reason}` : '';

    this.eventBus?.publish({ type: 'permission:requested', sessionId, requestId, toolName, input: displaySummary });

    await sendPrompt(
      `🔐 权限请求\n工具：${toolName}\n操作：${displaySummary}${reasonLine}\n\n回复 /perm allow 批准 或 /perm deny 拒绝`
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

  /** 获取指定会话的所有 pending requestId */
  getPendingRequests(sessionId: string): string[] {
    const ids: string[] = [];
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        ids.push(requestId);
      }
    }
    return ids;
  }
}
