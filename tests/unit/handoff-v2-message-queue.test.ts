import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue } from '../../src/core/message/message-queue.js';
import type { Message } from '../../src/types.js';

const roots: string[] = [];

function makeMessage(content: string, messageId: string): Message {
  return {
    channel: 'aun#self.agentid.pub#main', channelType: 'aun', channelId: 'target.agentid.pub',
    chatType: 'private', peerId: 'target.agentid.pub', selfAID: 'self.agentid.pub',
    content, messageId, timestamp: 1,
    handoffDelivery: { direction: 'origin', handoffId: 'h-001' },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('handoff v2 message queue', () => {
  it('restores an active handoff with its original body and fixed binding', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-queue-'));
    roots.push(root);
    const persistencePath = path.join(root, 'queue.json');
    const message = makeMessage('durable return body', 'origin-deliver:h-001:s1');
    fs.writeFileSync(persistencePath, JSON.stringify({
      version: 2, updatedAt: 1, queues: [], active: [{
        queueKey: 'self.agentid.pub::s1::/project',
        items: [{ message, projectPath: '/project', agentName: 'self.agentid.pub' }],
      }],
    }));
    const handled: Message[] = [];
    const queue = new MessageQueue(async restored => { handled.push(restored); }, { persistencePath });

    expect(queue.restorePersisted(false)).toBe(1);
    expect(handled).toHaveLength(0);
    queue.startRestored();

    await vi.waitFor(() => expect(handled).toHaveLength(1));
    expect(handled[0]).toMatchObject({
      content: 'durable return body',
      messageId: 'origin-deliver:h-001:s1',
      handoffDelivery: { direction: 'origin', handoffId: 'h-001' },
    });
    expect(handled[0].restartResume).toBeUndefined();
  });

  it('deduplicates a durable operation against pending storage after the recent cache expires', async () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-queue-'));
    roots.push(root);
    const queue = new MessageQueue(async () => {}, { persistencePath: path.join(root, 'queue.json') });
    queue.muteAgent('self.agentid.pub');
    const message = makeMessage('durable return body', 'origin-deliver:h-001:s1');
    const firstPersisted = vi.fn();
    const duplicatePersisted = vi.fn();

    await queue.enqueuePersisted('s1', message, '/project', {
      agentName: 'self.agentid.pub', onPersisted: firstPersisted,
    });
    await vi.advanceTimersByTimeAsync(60_001);
    await queue.enqueuePersisted('s1', message, '/project', {
      agentName: 'self.agentid.pub', onPersisted: duplicatePersisted,
    });

    expect(firstPersisted).toHaveBeenCalledTimes(1);
    expect(duplicatePersisted).toHaveBeenCalledTimes(1);
    expect(queue.getQueueLength('s1')).toBe(1);
  });
});
