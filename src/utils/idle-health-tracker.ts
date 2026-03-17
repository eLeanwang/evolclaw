/**
 * 空闲健康检查追踪器
 * 记录事件流执行上下文，分级响应空闲状态
 */

export interface TaskExecutionState {
  lastEventType: string;
  lastEventTime: number;
  lastToolName?: string;
  lastToolStartTime?: number;
  totalEvents: number;
  totalToolCalls: number;
  hasReceivedText: boolean;
}

export type IdleAction = 'notify' | 'warn' | 'kill';

export interface IdleCheckResult {
  action: IdleAction;
  idleSec: number;
  state: TaskExecutionState;
  message: string;
}

// 分级倍率
const NOTIFY_MULTIPLIER = 1;    // 1× idleMs
const WARN_MULTIPLIER = 2.5;    // 2.5× idleMs
const KILL_MULTIPLIER = 5;      // 5× idleMs

export class IdleHealthTracker {
  private state: TaskExecutionState;
  private triggeredLevels = new Set<IdleAction>();
  private idleMs: number;

  constructor(idleMs: number) {
    this.idleMs = idleMs;
    this.state = {
      lastEventType: '',
      lastEventTime: Date.now(),
      lastToolName: undefined,
      lastToolStartTime: undefined,
      totalEvents: 0,
      totalToolCalls: 0,
      hasReceivedText: false,
    };
  }

  /**
   * 记录 SDK 事件，更新状态并重置空闲计时
   */
  recordEvent(type: string, toolName?: string): void {
    this.state.lastEventType = type;
    this.state.lastEventTime = Date.now();
    this.state.totalEvents++;

    if (toolName) {
      this.state.lastToolName = toolName;
      this.state.lastToolStartTime = Date.now();
      this.state.totalToolCalls++;
    }

    if (type === 'text_delta' || type === 'result') {
      this.state.hasReceivedText = true;
    }

    // 收到新事件，重置已触发级别
    this.triggeredLevels.clear();
  }

  /**
   * 检查健康状态，返回 null（未空闲）或分级结果
   */
  checkHealth(): IdleCheckResult | null {
    const now = Date.now();
    const idleDuration = now - this.state.lastEventTime;

    const notifyThreshold = this.idleMs * NOTIFY_MULTIPLIER;
    const warnThreshold = this.idleMs * WARN_MULTIPLIER;
    const killThreshold = this.idleMs * KILL_MULTIPLIER;

    // Check from lowest to highest — return first untriggered level
    if (idleDuration >= notifyThreshold && !this.triggeredLevels.has('notify')) {
      this.triggeredLevels.add('notify');
      return {
        action: 'notify',
        idleSec: Math.round(idleDuration / 1000),
        state: { ...this.state },
        message: this.buildMessage('notify', idleDuration),
      };
    }

    if (idleDuration >= warnThreshold && !this.triggeredLevels.has('warn')) {
      this.triggeredLevels.add('warn');
      return {
        action: 'warn',
        idleSec: Math.round(idleDuration / 1000),
        state: { ...this.state },
        message: this.buildMessage('warn', idleDuration),
      };
    }

    if (idleDuration >= killThreshold && !this.triggeredLevels.has('kill')) {
      this.triggeredLevels.add('kill');
      return {
        action: 'kill',
        idleSec: Math.round(idleDuration / 1000),
        state: { ...this.state },
        message: this.buildMessage('kill', idleDuration),
      };
    }

    return null;
  }

  /**
   * 获取当前执行状态快照
   */
  getState(): TaskExecutionState {
    return { ...this.state };
  }

  private buildMessage(action: IdleAction, idleDuration: number): string {
    const idleSec = Math.round(idleDuration / 1000);
    const lastToolInfo = this.state.lastToolName
      ? `🔧 ${this.state.lastToolName}`
      : '无工具调用';

    const timeSinceLastEvent = idleSec;

    if (action === 'kill') {
      return `🛑 任务超时（${idleSec}秒无响应），已自动中断\n\n执行状态：\n- 已处理 ${this.state.totalEvents} 个事件，${this.state.totalToolCalls} 次工具调用\n- 最后活动：${lastToolInfo}（${timeSinceLastEvent}秒前）`;
    }

    if (action === 'warn') {
      return `⚠️ 健康检查：任务已 ${idleSec} 秒无输出\n\n执行状态：\n- 已处理 ${this.state.totalEvents} 个事件，${this.state.totalToolCalls} 次工具调用\n- 最后活动：${lastToolInfo}（${timeSinceLastEvent}秒前）\n\n如果任务无响应，将在 ${Math.round((this.idleMs * KILL_MULTIPLIER - idleDuration) / 1000)} 秒后自动中断。\n使用 /stop 可立即中断当前任务。`;
    }

    // notify
    return `🔍 健康检查：任务已 ${idleSec} 秒无输出\n\n执行状态：\n- 已处理 ${this.state.totalEvents} 个事件，${this.state.totalToolCalls} 次工具调用\n- 最后活动：${lastToolInfo}（${timeSinceLastEvent}秒前）\n\n任务仍在运行中。使用 /stop 可中断当前任务。`;
  }
}