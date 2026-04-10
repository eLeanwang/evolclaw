import { EventEmitter } from 'events';

// ── 系统事件 ──
export type SystemEvent =
  | { type: 'system:started'; channels: string[]; timestamp: number }
  | { type: 'system:shutdown'; reason?: string; timestamp?: number }
  | { type: 'system:restart'; channel: string; channelId: string };

// ── 渠道事件 ──
export type ChannelEvent =
  | { type: 'channel:connected'; channel: string; timestamp?: number }
  | { type: 'channel:disconnected'; channel: string; reason?: string }
  | { type: 'channel:health'; channel: string; status: 'auth_error'; message: string; timestamp?: number }
  | { type: 'channel:owner-bound'; channel: string; userId: string };

// ── 会话事件 ──
export type SessionEvent =
  | { type: 'session:created'; sessionId: string; channel: string; channelId: string; projectPath?: string; name?: string; chatType?: string; threadId?: string; timestamp?: number }
  | { type: 'session:switched'; sessionId: string; fromSessionId: string; toSessionId: string }
  | { type: 'session:deleted'; sessionId: string }
  | { type: 'session:renamed'; sessionId: string; oldName: string; newName: string }
  | { type: 'session:forked'; sessionId: string; sourceSessionId: string; name?: string }
  | { type: 'session:imported'; sessionId: string; agentSessionId: string; projectPath: string }
  | { type: 'session:safe-mode-entered'; sessionId: string; consecutiveErrors?: number; reason?: string }
  | { type: 'session:safe-mode-exited'; sessionId: string; method?: string };

// ── 项目事件 ──
export type ProjectEvent =
  | { type: 'project:switched'; sessionId: string; channel?: string; channelId?: string; projectPath?: string; fromProject?: string; toProject?: string; timestamp?: number }
  | { type: 'project:bound'; sessionId: string; channel?: string; channelId?: string; projectPath: string; timestamp?: number };

// ── 消息事件 ──
export type MessageEvent =
  | { type: 'message:received'; sessionId: string; channel: string; channelId: string; content: string; userId?: string; timestamp?: number }
  | { type: 'message:processing'; sessionId: string }
  | { type: 'message:text'; sessionId: string; text: string; isFinal: boolean }
  | { type: 'message:completed'; sessionId: string; channel: string; channelId: string; finalText?: string; durationMs?: number; timestamp?: number }
  | { type: 'message:error'; sessionId: string; error: string; errorType: string }
  | { type: 'message:interrupted'; sessionId: string; reason?: string };

// ── 工具事件 ──
export type ToolEvent =
  | { type: 'tool:use'; sessionId: string; toolName: string; input: any; timestamp?: number }
  | { type: 'tool:result'; sessionId: string; toolName: string; isError?: boolean; content?: string; timestamp?: number };

// ── 权限事件 ──
export type PermissionEvent =
  | { type: 'permission:requested'; sessionId: string; requestId: string; toolName: string; input: string }
  | { type: 'permission:resolved'; sessionId: string; requestId: string; approved: boolean }
  | { type: 'permission:timeout'; sessionId: string; requestId: string };

// ── Agent 运行事件 ──
export type AgentEvent =
  | { type: 'agent:compact-start'; sessionId: string }
  | { type: 'agent:compact-complete'; sessionId: string; preTokens: number }
  | { type: 'agent:model-changed'; sessionId?: string; oldModel?: string; newModel?: string; model?: string; timestamp?: number }
  | { type: 'agent:idle-timeout'; sessionId: string; idleSec: number }
  | { type: 'agent:file-sent'; sessionId: string; filePath: string; channel: string };

// ── 自愈事件 ──
export type SelfHealEvent =
  | { type: 'self-heal:started'; reason: string }
  | { type: 'self-heal:attempt'; attemptNumber: number; maxAttempts: number }
  | { type: 'self-heal:completed'; success: boolean; attempts: number };

// ── 配置事件 ──
export type ConfigEvent =
  | { type: 'config:corrupted'; backupPath: string; reasons: string[] };

export type GatewayEvent =
  | SystemEvent
  | ChannelEvent
  | SessionEvent
  | ProjectEvent
  | MessageEvent
  | ToolEvent
  | PermissionEvent
  | AgentEvent
  | SelfHealEvent
  | ConfigEvent;

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

