/**
 * 消息处理工具函数
 *
 * 从 message-processor.ts 提取的独立工具函数，供 ResponseEngine 和其他模块使用。
 */

import type { OutboundEnvelope, ReplyContext, ChannelAdapter, InteractionRequest, OutboundPayload, InteractionKind, ActionInteraction } from '../../types.js';
import { renderCommandCardAsText, renderActionAsText } from '../interaction-router.js';

/**
 * 构造出站消息信封
 */
export function buildEnvelope(opts: {
  taskId?: string;
  sessionId?: string;
  channel: string;
  channelId: string;
  agentName?: string;
  chatmode?: 'interactive' | 'proactive';
  replyContext?: ReplyContext;
  timestamp?: number;
}): OutboundEnvelope {
  return {
    taskId: opts.taskId ?? `interaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: opts.sessionId,
    channel: opts.channel,
    channelId: opts.channelId,
    agentName: opts.agentName ?? '<unknown>',
    chatmode: opts.chatmode ?? 'interactive',
    replyContext: opts.replyContext,
    timestamp: opts.timestamp ?? Date.now(),
  };
}

/**
 * 交互请求的默认回退文本
 * 当调用方未显式提供时使用，根据交互类型选择合适的渲染器。
 */
export function defaultFallbackText(interaction: InteractionRequest): string {
  const kind: InteractionKind = interaction.kind;
  if (kind.kind === 'command-card') {
    return renderCommandCardAsText(kind);
  }
  if (kind.kind === 'action') {
    try {
      return renderActionAsText(interaction);
    } catch {
      // ActionInteraction without fallback metadata — produce a minimal hint
      const action = kind as ActionInteraction;
      const lines = [action.title];
      if (action.body) lines.push(action.body);
      return lines.join('\n');
    }
  }
  return '';
}

/**
 * 通过统一的 adapter.send 入口发送交互负载
 *
 * 通过 adapter.send(envelope, { kind: 'interaction', ... }) 发送交互。
 * 成功返回 'sent'，失败返回 false。
 */
export async function sendInteractionPayload(
  adapter: ChannelAdapter,
  envelope: OutboundEnvelope,
  interaction: InteractionRequest,
  fallbackText?: string,
  replyCtx?: ReplyContext,
): Promise<string | false> {
  const text = fallbackText ?? defaultFallbackText(interaction);
  const payload: OutboundPayload = {
    kind: 'interaction',
    interaction,
    fallbackText: text || undefined,
  };
  try {
    const enriched: OutboundEnvelope = replyCtx
      ? { ...envelope, replyContext: replyCtx }
      : envelope;
    await adapter.send(enriched, payload);
    return 'sent';
  } catch {
    return false;
  }
}
