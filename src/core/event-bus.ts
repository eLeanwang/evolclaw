import { EventEmitter } from 'events';

// ── 系统事件 ──
export type SystemEvent =
  | { type: 'system:started'; channels: string[]; timestamp: number }
  | { type: 'system:shutdown'; reason?: string; timestamp?: number }
  | { type: 'system:restart'; channel: string; channelId: string };

// ── 渠道事件 ──
export type ChannelEvent =
  | { type: 'channel:connected'; channel: string; channelName?: string; timestamp?: number }
  | { type: 'channel:disconnected'; channel: string; channelName?: string; reason?: string }
  | { type: 'channel:error'; channel: string; channelName?: string; status: 'auth_error'; message: string; timestamp?: number }
  | { type: 'channel:owner-bound'; channel: string; channelName?: string; userId: string };

// ── 会话事件 ──
export type SessionEvent =
  | { type: 'session:created'; sessionId: string; channel: string; channelName?: string; channelId: string; projectPath?: string; name?: string; chatType?: string; threadId?: string; timestamp?: number }
  | { type: 'session:switched'; sessionId: string; fromSessionId: string; toSessionId: string }
  | { type: 'session:deleted'; sessionId: string }
  | { type: 'session:renamed'; sessionId: string; oldName: string; newName: string }
  | { type: 'session:forked'; sessionId: string; sourceSessionId: string; name?: string }
  | { type: 'session:rewind'; sessionId: string; turnNum: number; mode: string }
  | { type: 'session:imported'; sessionId: string; agentSessionId: string; projectPath: string }
  | { type: 'session:safe-mode-entered'; sessionId: string; consecutiveErrors?: number; reason?: string }
  | { type: 'session:safe-mode-exited'; sessionId: string; method?: string }
  | { type: 'session:chat-mode-changed'; sessionId: string; mode: string; timestamp?: number }
  | { type: 'session:dispatch-mode-changed'; sessionId: string; mode: string; timestamp?: number };

// ── 项目事件 ──
export type ProjectEvent =
  | { type: 'project:switched'; sessionId: string; channel?: string; channelId?: string; projectPath?: string; fromProject?: string; toProject?: string; timestamp?: number }
  | { type: 'project:bound'; sessionId: string; channel?: string; channelId?: string; projectPath: string; timestamp?: number };

// ── 消息事件 ──
export type MessageEvent =
  | { type: 'message:received'; sessionId: string; channel: string; channelName?: string; channelId: string; content: string; userId?: string; agentName?: string; timestamp?: number }
  | { type: 'message:text'; sessionId: string; text: string; isFinal: boolean };

// ── 任务事件（从 message:* 拆出，语义为任务生命周期） ──
export type TaskBusEvent =
  | { type: 'task:started'; sessionId: string }
  | { type: 'task:queued'; channel: string; channelId: string; replyContext?: Record<string, unknown> }
  | { type: 'task:completed'; sessionId: string; channel: string; channelName?: string; channelId: string; finalText?: string; durationMs?: number; terminalReason?: string; agentName?: string; timestamp?: number }
  | { type: 'task:error'; sessionId: string; error: string; errorType: string; terminalReason?: string; agentName?: string }
  | { type: 'task:interrupted'; sessionId: string; reason?: string; agentName?: string };

// ── 工具事件 ──
export type ToolEvent =
  | { type: 'tool:use'; sessionId: string; toolName: string; input: any; timestamp?: number }
  | { type: 'tool:result'; sessionId: string; toolName: string; isError?: boolean; content?: string; agentName?: string; timestamp?: number };

// ── 权限事件 ──
export type PermissionEvent =
  | { type: 'permission:requested'; sessionId: string; requestId: string; toolName: string; input: string }
  | { type: 'permission:resolved'; sessionId: string; requestId: string; approved: boolean }
  | { type: 'permission:timeout'; sessionId: string; requestId: string; toolName?: string };

// ── Runner 运行事件（AI 后端执行流） ──
export type RunnerBusEvent =
  | { type: 'runner:compact-start'; sessionId: string }
  | { type: 'runner:compact-complete'; sessionId: string; preTokens: number }
  | { type: 'runner:model-changed'; sessionId?: string; model?: string; timestamp?: number }
  | { type: 'runner:idle-timeout'; sessionId: string; idleSec: number }
  | { type: 'runner:file-sent'; sessionId: string; filePath: string; channel: string; channelName?: string }
  | { type: 'runner:state-changed'; sessionId: string; state: string }
  | { type: 'runner:status'; sessionId: string; subtype: string; message: string; timestamp?: number };

// ── 自愈事件 ──
export type SelfHealEvent =
  | { type: 'self-heal:started'; reason: string }
  | { type: 'self-heal:attempt'; attemptNumber: number; maxAttempts: number }
  | { type: 'self-heal:completed'; success: boolean; attempts: number };

// ── 配置事件 ──
export type ConfigEvent =
  | { type: 'config:corrupted'; backupPath: string; reasons: string[] };

// ── 触发器事件 ──
export type TriggerEvent =
  | { type: 'trigger:registered'; triggerId: string; name: string; peerId: string }
  | { type: 'trigger:fired'; triggerId: string; name: string; fireTime: number }
  | { type: 'trigger:completed'; triggerId: string; messageId: string; durationMs: number }
  | { type: 'trigger:failed'; triggerId: string; messageId: string; error: string }
  | { type: 'trigger:skipped'; triggerId: string; reason: 'overlap' | 'interrupted' }
  | { type: 'trigger:cancelled'; triggerId: string; by: string };
export type GatewayEvent =
  | SystemEvent
  | ChannelEvent
  | SessionEvent
  | ProjectEvent
  | MessageEvent
  | TaskBusEvent
  | ToolEvent
  | PermissionEvent
  | RunnerBusEvent
  | SelfHealEvent
  | ConfigEvent
  | TriggerEvent;

export class EventBus extends EventEmitter {
  publish(event: GatewayEvent): void {
    const handlers = [
      ...this.listeners(event.type),
      ...this.listeners('*'),
    ];
    for (const handler of handlers) {
      try {
        (handler as (event: GatewayEvent) => void)(event);
      } catch (err) {
        console.error(`[EventBus] Handler error for ${event.type}:`, err);
      }
    }
  }

  subscribe(eventType: string, handler: (event: GatewayEvent) => void): void {
    this.on(eventType, handler);
  }

  subscribeAll(handler: (event: GatewayEvent) => void): void {
    this.on('*', handler);
  }

  subscribePrefix(prefix: string, handler: (event: GatewayEvent) => void): void {
    this.on('*', (event: GatewayEvent) => {
      if (event.type.startsWith(prefix)) handler(event);
    });
  }

  unsubscribe(eventType: string, handler: (event: GatewayEvent) => void): void {
    this.off(eventType, handler);
  }
}
