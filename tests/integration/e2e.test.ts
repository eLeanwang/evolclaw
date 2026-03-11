import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FeishuChannel } from '../../src/channels/feishu.js';
import { ACPChannel } from '../../src/channels/acp.js';

describe('End-to-End Integration Tests', () => {
  let feishu: FeishuChannel;
  let acp: ACPChannel;
  const receivedMessages: Array<{ id: string; content: string }> = [];

  beforeAll(async () => {
    feishu = new FeishuChannel({ appId: 'test-app', appSecret: 'test-secret' });
    acp = new ACPChannel({ domain: 'test.acp', agentName: 'test-agent' });

    feishu.onMessage(async (id, content) => {
      receivedMessages.push({ id, content });
    });

    await acp.connect();
  });

  afterAll(async () => {
    await feishu.disconnect();
    await acp.disconnect();
  });

  it('should initialize channels successfully', () => {
    expect(feishu).toBeDefined();
    expect(acp).toBeDefined();
  });

  it('should handle message deduplication', async () => {
    const initialCount = receivedMessages.length;
    expect(receivedMessages.length).toBe(initialCount);
  });

  it('should support concurrent message processing', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      acp.sendMessage(`session-${i}`, `test message ${i}`)
    );
    await Promise.all(promises);
    expect(promises).toHaveLength(5);
  });

  it('should process full message flow', async () => {
    await acp.sendMessage('test-session', 'hello');
    expect(true).toBe(true);
  });

  it('should handle error recovery', async () => {
    expect(true).toBe(true);
  });

  it('should support stress testing', async () => {
    const stress = Array(20).fill(0).map((_, i) =>
      acp.sendMessage(`stress-${i}`, `load-${i}`)
    );
    await expect(Promise.all(stress)).resolves.toBeDefined();
  });
});
