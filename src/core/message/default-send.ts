import type {
  ChannelAdapter,
  ChannelCapabilities,
  OutboundEnvelope,
  OutboundPayload,
  ReplyContext,
} from '../../types.js';
import { logger } from '../../utils/logger.js';

/**
 * defaultSend — 通用 OutboundPayload 分发器
 *
 * Phase 3 复用策略：每个 channel 复用此函数作为 `send()` 实现，内部按 `payload.kind`
 * 分发到 adapter 已有的旧方法（sendText / sendFile / sendImage / sendProcessingStatus /
 * sendInteraction / putThought / sendCustomPayload）。
 *
 * 不需要每个 channel 重写一份分发逻辑。channel 想自定义某个 kind 的渲染时，可在
 * 自身 `send()` 内拦截后再 fallback 到 defaultSend。
 *
 * 降级矩阵（按 capabilities）：
 * - result.file 无 file 能力 → sendText（输出文件路径）
 * - result.image 无 image 能力 → 丢弃 + warn 日志
 * - interaction 无 interaction 能力 → sendText(fallbackText)
 * - status.* 无 status 能力 → 跳过（不阻塞流程）
 * - activity.*（proactive）无 thought 能力 → 跳过
 */
export async function defaultSend(
  adapter: ChannelAdapter,
  envelope: OutboundEnvelope,
  payload: OutboundPayload
): Promise<void> {
  const caps: ChannelCapabilities = adapter.capabilities ?? {
    file: !!adapter.sendFile,
    image: !!adapter.sendImage,
    interaction: !!adapter.sendInteraction,
    markdown: false,
    thought: !!adapter.putThought,
    status: !!adapter.sendProcessingStatus,
  };

  const { channelId, replyContext, chatmode, taskId } = envelope;
  const ctx: ReplyContext = {
    ...(replyContext ?? {}),
    metadata: { ...(replyContext?.metadata ?? {}), taskId, chatmode },
  };

  switch (payload.kind) {
    case 'result.text':
    case 'command.result':
    case 'system.notice':
    case 'system.error':
    case 'command.error':
    case 'result.error': {
      const opts: ReplyContext = { ...ctx };
      if (payload.kind === 'result.text' && payload.isFinal) {
        opts.title = '✓ 最终回复:';
      }
      await adapter.sendText(channelId, payload.text, opts);
      return;
    }

    case 'result.file': {
      if (caps.file && adapter.sendFile) {
        await adapter.sendFile(channelId, payload.filePath, ctx);
      } else {
        // 降级：输出文件路径
        const name = payload.fileName || payload.filePath;
        await adapter.sendText(channelId, `📎 文件已生成：${name}\n路径：${payload.filePath}`, ctx);
      }
      return;
    }

    case 'result.image': {
      if (caps.image && adapter.sendImage) {
        await adapter.sendImage(channelId, payload.data, ctx);
      } else {
        logger.warn(`[defaultSend] result.image dropped: channel=${adapter.channelName} has no image capability`);
      }
      return;
    }

    case 'activity.tool_use':
    case 'activity.tool_result':
    case 'activity.thinking':
    case 'activity.progress':
    case 'activity.notice': {
      if (chatmode === 'proactive') {
        if (caps.thought && adapter.putThought) {
          const stage = mapActivityStage(payload.kind);
          const thoughtPayload: any = {
            type: 'thought',
            text: payload.text,
            stage,
            task_id: taskId,
            chatmode,
          };
          if ('metadata' in payload && payload.metadata) {
            thoughtPayload.metadata = payload.metadata;
          }
          await adapter.putThought(channelId, taskId, thoughtPayload, ctx).catch(err => {
            logger.debug(`[defaultSend] putThought failed: ${(err as Error).message}`);
          });
        }
        // 无 thought 能力 → 丢弃（proactive 模式中间过程）
      } else {
        // interactive 模式：activity 由 IMRenderer 聚合后调用 sendText，
        // 不应直接走 defaultSend。这里作为兜底直接发文本。
        await adapter.sendText(channelId, payload.text, ctx);
      }
      return;
    }

    case 'status.started':
    case 'status.completed':
    case 'status.interrupted':
    case 'status.error':
    case 'status.timeout': {
      if (caps.status && adapter.sendProcessingStatus) {
        const statusName = mapStatusKind(payload.kind);
        const sessionId = (envelope.replyContext?.sessionId) || '';
        adapter.sendProcessingStatus(channelId, statusName, sessionId, taskId, ctx);
      }
      // 无 status 能力 → 跳过（不发任何东西，状态信号不强求所有渠道感知）
      return;
    }

    case 'interaction': {
      if (caps.interaction && adapter.sendInteraction) {
        await adapter.sendInteraction(channelId, payload.interaction, ctx);
      } else {
        const text = payload.fallbackText || `[交互请求] ${payload.interaction.kind?.title || '请操作'}`;
        await adapter.sendText(channelId, text, ctx);
      }
      return;
    }

    case 'custom': {
      // 渠道自定义，仅当渠道实现 sendCustomPayload 时透传
      if (adapter.sendCustomPayload) {
        const json = typeof payload.payload === 'string' ? payload.payload : JSON.stringify(payload.payload);
        adapter.sendCustomPayload(channelId, json);
      } else {
        logger.warn(`[defaultSend] custom payload dropped: channel=${adapter.channelName} has no sendCustomPayload`);
      }
      return;
    }

    default: {
      const _exhaustive: never = payload;
      logger.warn(`[defaultSend] Unknown payload kind: ${(_exhaustive as any).kind}`);
    }
  }
}

function mapActivityStage(kind: string): string {
  switch (kind) {
    case 'activity.tool_use':
    case 'activity.tool_result':
      return 'tool';
    case 'activity.thinking':
      return 'thinking';
    case 'activity.progress':
      return 'planning';
    case 'activity.notice':
      return 'system';
    default:
      return 'system';
  }
}

function mapStatusKind(kind: string): 'start' | 'done' | 'interrupted' | 'error' | 'timeout' {
  switch (kind) {
    case 'status.started':
      return 'start';
    case 'status.completed':
      return 'done';
    case 'status.interrupted':
      return 'interrupted';
    case 'status.error':
      return 'error';
    case 'status.timeout':
      return 'timeout';
    default:
      return 'done';
  }
}
