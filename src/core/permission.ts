import { summarizeToolInput } from '../utils/permission-utils.js';
import type { EventBus } from './event-bus.js';

export type PermissionDecision = 'allow' | 'always' | 'deny';

interface PendingPermission {
  sessionId: string;
  toolName: string;
  resolve: (decision: PermissionDecision) => void;
  timer: NodeJS.Timeout;
}

export class PermissionGateway {
  private pending = new Map<string, PendingPermission>();
  private timeout = 5 * 60 * 1000;
  private eventBus?: EventBus;

  /** 始终允许的工具缓存：toolName → Set<pattern> */
  private alwaysAllow = new Map<string, Set<string>>();

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * 检查工具是否已被标记为"始终允许"
   */
  isAlwaysAllowed(toolName: string): boolean {
    return this.alwaysAllow.has(toolName);
  }

  /**
   * 将工具标记为"始终允许"
   */
  addAlwaysAllow(toolName: string): void {
    if (!this.alwaysAllow.has(toolName)) {
      this.alwaysAllow.set(toolName, new Set());
    }
  }

  /**
   * 清除所有"始终允许"缓存（用于切换权限模式时重置）
   */
  clearAlwaysAllow(): void {
    this.alwaysAllow.clear();
  }

  /**
   * 获取所有"始终允许"的工具列表
   */
  getAlwaysAllowList(): string[] {
    return [...this.alwaysAllow.keys()];
  }

  /**
   * 请求人工审批。返回三态决策。
   */
  async requestPermission(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    sendPrompt: (text: string) => Promise<void>,
    summary?: string,
    reason?: string
  ): Promise<PermissionDecision> {
    // 如果已标记为始终允许，直接放行
    if (this.isAlwaysAllowed(toolName)) {
      return 'always';
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const displaySummary = summary || summarizeToolInput(toolName, toolInput);
    const reasonLine = reason ? `\n原因：${reason}` : '';

    this.eventBus?.publish({ type: 'permission:requested', sessionId, requestId, toolName, input: displaySummary });

    await sendPrompt(
      `🔐 权限请求\n工具：${toolName}\n操作：${displaySummary}${reasonLine}\n\n回复 /perm allow 本次允许 | always 始终允许 | deny 拒绝`
    );

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.eventBus?.publish({ type: 'permission:timeout', sessionId, requestId });
        resolve('deny');
      }, this.timeout);
      this.pending.set(requestId, { sessionId, toolName, resolve, timer });
    });
  }

  resolvePermission(sessionId: string, requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    clearTimeout(pending.timer);

    // 如果是 always，缓存该工具
    if (decision === 'always') {
      this.addAlwaysAllow(pending.toolName);
    }

    pending.resolve(decision);
    this.pending.delete(requestId);
    this.eventBus?.publish({ type: 'permission:resolved', sessionId, requestId, approved: decision !== 'deny' });
    return true;
  }

  /** 中断时取消指定会话的所有 pending 权限请求 */
  cancelAll(sessionId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        pending.resolve('deny');
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
