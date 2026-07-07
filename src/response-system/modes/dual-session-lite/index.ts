import type { JSONSchema } from '../../types.js';
import type { DualSessionConfig, V2Context, InboundMessage, OutboundPayload } from '../../engines/v2/types.js';

/**
 * User-visible dual-session-lite mode. The V2 engine implementation is added in
 * the next phase; this thin wrapper reserves the public mode id in the new
 * response-system layout without binding it to the old ResponseMode interface.
 */
export class DualSessionLiteMode {
  readonly id = 'dual-session-lite';
  readonly displayName = '双会话轻量模式';
  readonly description = '辅助会话判断投递时机，主会话批量处理内容。';
  readonly type = 'builtin' as const;
  readonly applicableScenes = ['private', 'group'] as const;
  readonly engineType = 'v2' as const;
  readonly configSchema: JSONSchema = {
    type: 'object',
    properties: {
      auxiliaryModel: { type: 'string', description: '辅助会话模型' },
      mainModel: { type: 'string', description: '主会话模型' },
      mentionMode: { type: 'string', enum: ['disabled', 'fast-track'], default: 'fast-track' },
      debounceMs: { type: 'number', default: 3000 },
      maxWaitMs: { type: 'number', default: 15000 },
      maxQueueSize: { type: 'number', default: 50 },
      maxBatchSize: { type: 'number', default: 50 },
      maxBatchBytes: { type: 'number', default: 10000 },
    },
  };

  constructor(private readonly config: DualSessionConfig = {}) {}

  async initialize(_context: V2Context): Promise<void> {
    throw new Error('[DualSessionLiteMode] V2 engine implementation is not available yet');
  }

  async cleanup(): Promise<void> {}

  async processInbound(_message: InboundMessage): Promise<void> {
    throw new Error('[DualSessionLiteMode] V2 engine implementation is not available yet');
  }

  async processOutbound(_payload: OutboundPayload): Promise<void> {
    throw new Error('[DualSessionLiteMode] V2 engine implementation is not available yet');
  }
}
