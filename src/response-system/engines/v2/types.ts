import type { EffectiveAgentConfig, Session } from '../../../types.js';
import type { InboundMessage, OutboundPayload } from '../../types.js';

export interface DualSessionConfig {
  auxiliaryModel?: string;
  mainModel?: string;
  mentionMode?: 'disabled' | 'fast-track';
  debounceMs?: number;
  maxWaitMs?: number;
  maxQueueSize?: number;
  maxBatchSize?: number;
  maxBatchBytes?: number;
}

export interface V2Context {
  session: Session;
  agentConfig: EffectiveAgentConfig;
  runner: unknown;
  channel: unknown;
  logger: {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
  };
  dataDir: string;
  projectPath?: string;
}

export type { InboundMessage, OutboundPayload };
