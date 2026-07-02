import { describe, it, expect } from 'vitest';
import { LogicalQueueBridge } from '../../src/core/message/logical-queue-bridge.js';
import { LIFOQueue } from '../../src/response-modes/queues/lifo-queue.js';
import type { Message } from '../../src/types.js';

function msg(id: string): Message {
  return { channel: 'test', channelId: 'c1', peerId: 'p1', content: `c-${id}`, messageId: id };
}

function physical(ids: string[]): Array<{ message: Message }> {
  return ids.map(id => ({ message: msg(id) }));
}

describe('LogicalQueueBridge', () => {
  it('default FIFO keeps physical order', () => {
    const bridge = new LogicalQueueBridge();
    bridge.enqueue('q', msg('m1'));
    bridge.enqueue('q', msg('m2'));
    bridge.enqueue('q', msg('m3'));
    const phys = physical(['m1', 'm2', 'm3']);
    bridge.reorderPhysical('q', phys);
    expect(phys[0].message.messageId).toBe('m1');
  });

  it('injected LIFO moves last message to head', () => {
    const bridge = new LogicalQueueBridge();
    bridge.setQueue('q', new LIFOQueue());
    bridge.enqueue('q', msg('m1'));
    bridge.enqueue('q', msg('m2'));
    bridge.enqueue('q', msg('m3'));
    const phys = physical(['m1', 'm2', 'm3']);
    bridge.reorderPhysical('q', phys);
    expect(phys[0].message.messageId).toBe('m3');
  });

  it('single item needs no reorder', () => {
    const bridge = new LogicalQueueBridge();
    bridge.enqueue('q', msg('m1'));
    const phys = physical(['m1']);
    expect(bridge.reorderPhysical('q', phys)).toBe(false);
  });

  it('empty array needs no reorder', () => {
    const bridge = new LogicalQueueBridge();
    expect(bridge.reorderPhysical('q', [])).toBe(false);
  });
});
