import { query, type Query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';

export enum InstanceState {
  IDLE = 'idle',
  BUSY = 'busy',
  STOPPED = 'stopped'
}

export interface InstanceMetrics {
  sessionId: string;
  state: InstanceState;
  queryCount: number;
  lastQueryTime: number;
}

export class ClaudeInstance extends EventEmitter {
  private state: InstanceState = InstanceState.IDLE;
  private metrics: InstanceMetrics;
  private options: Options;
  private claudeSessionId?: string;

  constructor(
    public readonly sessionId: string,
    public readonly projectPath: string,
    apiKey: string
  ) {
    super();
    this.metrics = {
      sessionId,
      state: InstanceState.IDLE,
      queryCount: 0,
      lastQueryTime: 0
    };
    this.options = {
      cwd: projectPath,
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      hooks: {
        Stop: [{
          hooks: [async (input) => {
            logger.event({ type: 'stop', sessionId, data: input });
            this.emit('hook', { type: 'stop' });
            return { continue: true };
          }]
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            logger.event({ type: 'post_tool_use', sessionId, tool: (input as any).tool_name || 'unknown' });
            this.emit('hook', { type: 'postToolUse', data: input });
            return { continue: true };
          }]
        }],
        SubagentStart: [{
          hooks: [async (input) => {
            logger.event({ type: 'subagent_start', sessionId, data: input });
            this.emit('hook', { type: 'subagentStart', data: input });
            return { continue: true };
          }]
        }],
        SubagentStop: [{
          hooks: [async (input) => {
            logger.event({ type: 'subagent_stop', sessionId, data: input });
            this.emit('hook', { type: 'subagentStop', data: input });
            return { continue: true };
          }]
        }],
        Notification: [{
          hooks: [async (input) => {
            logger.event({ type: 'notification', sessionId, data: input });
            this.emit('hook', { type: 'notification', data: input });
            return { continue: true };
          }]
        }]
      }
    };
  }

  async query(prompt: string): Promise<string> {
    this.state = InstanceState.BUSY;
    this.metrics.queryCount++;
    this.metrics.lastQueryTime = Date.now();

    try {
      // 使用 resume 参数恢复会话
      const q = query({
        prompt,
        options: {
          ...this.options,
          resume: this.claudeSessionId
        }
      });
      let result = '';
      for await (const msg of q) {
        // 提取并保存 session ID
        if (msg.session_id) {
          this.claudeSessionId = msg.session_id;
        }

        if (msg.type === 'result' && msg.subtype === 'success') {
          result = msg.result;
          break;
        }
      }
      this.state = InstanceState.IDLE;
      return result;
    } catch (error) {
      this.state = InstanceState.IDLE;
      throw error;
    }
  }

  getClaudeSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  async stop(): Promise<void> {
    this.state = InstanceState.STOPPED;
  }

  getState(): InstanceState {
    return this.state;
  }

  getMetrics(): InstanceMetrics {
    return { ...this.metrics, state: this.state };
  }

  getIdleTime(): number {
    return this.metrics.lastQueryTime === 0 ? 0 : Date.now() - this.metrics.lastQueryTime;
  }

  isAlive(): boolean {
    return this.state !== InstanceState.STOPPED;
  }
}
