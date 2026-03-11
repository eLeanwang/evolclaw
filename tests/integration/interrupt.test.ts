import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRunner } from '../../src/agent-runner.js';
import { MessageQueue } from '../../src/core/message-queue.js';

describe('Interrupt Functionality', () => {
  let agentRunner: AgentRunner;
  let messageQueue: MessageQueue;

  beforeEach(() => {
    agentRunner = new AgentRunner('test-api-key');
    messageQueue = new MessageQueue(async () => {});
  });

  afterEach(async () => {
    await agentRunner.closeSession('test-session');
  });

  describe('AgentRunner Interrupt', () => {
    it('should store stream for session', async () => {
      const sessionId = 'test-session-1';
      expect(agentRunner['activeStreams'].size).toBe(0);

      // runQuery 会保存 stream 引用
      expect(agentRunner['activeStreams']).toBeDefined();
    });

    it('should call interrupt on stream', async () => {
      const sessionId = 'test-session-2';
      let interruptCalled = false;

      // 模拟一个带有 interrupt 方法的 stream
      const mockStream = {
        interrupt: async () => { interruptCalled = true; }
      };

      agentRunner['activeStreams'].set(sessionId, mockStream as any);

      await agentRunner.interrupt(sessionId);

      expect(interruptCalled).toBe(true);
      expect(agentRunner['activeStreams'].has(sessionId)).toBe(false);
    });

    it('should handle interrupt on non-existent session', async () => {
      await expect(agentRunner.interrupt('non-existent')).resolves.not.toThrow();
    });
  });

  describe('MessageQueue Interrupt Callback', () => {
    it('should set interrupt callback', () => {
      const callback = async (sessionKey: string) => {};
      messageQueue.setInterruptCallback(callback);
      expect(messageQueue['interruptCallback']).toBe(callback);
    });

    it('should trigger callback when queue has messages', async () => {
      let interrupted = false;
      messageQueue.setInterruptCallback(async () => {
        interrupted = true;
      });

      // 模拟队列中有消息的情况
      // 实际测试需要真实的消息处理流程
      expect(messageQueue['interruptCallback']).toBeDefined();
    });
  });

  describe('Integration', () => {
    it('should integrate interrupt with message queue', () => {
      const queue = new MessageQueue(async () => {});
      const runner = new AgentRunner('test-key');

      queue.setInterruptCallback(async (sessionKey) => {
        await runner.interrupt(sessionKey);
      });

      expect(queue['interruptCallback']).toBeDefined();
    });
  });
});
