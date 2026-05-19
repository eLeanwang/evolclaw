import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../src/core/event-bus.js';

describe('EventBus Integration Flow', () => {
  let eventBus: EventBus;
  let events: any[];

  beforeEach(() => {
    eventBus = new EventBus();
    events = [];
  });

  it('should publish events in correct order during message flow', async () => {
    const sessionId = 'test-session';

    eventBus.subscribeAll((event) => {
      events.push(event);
    });

    // Simulate message processing flow
    eventBus.publish({ type: 'message:received', sessionId, channel: 'feishu', channelId: 'chat1', content: 'test' });
    eventBus.publish({ type: 'task:started', sessionId });
    eventBus.publish({ type: 'tool:start', sessionId, toolName: 'Read', input: 'file.txt' });
    eventBus.publish({ type: 'tool:complete', sessionId, toolName: 'Read' });
    eventBus.publish({ type: 'message:complete', sessionId, finalText: 'done', durationMs: 100 });

    expect(events).toHaveLength(5);
    expect(events[0].type).toBe('message:received');
    expect(events[1].type).toBe('task:started');
    expect(events[2].type).toBe('tool:start');
    expect(events[3].type).toBe('tool:complete');
    expect(events[4].type).toBe('message:complete');
  });

  it('should support wildcard subscription', () => {
    let count = 0;
    eventBus.subscribeAll(() => count++);

    eventBus.publish({ type: 'system:started', channels: ['feishu'], timestamp: Date.now() });
    eventBus.publish({ type: 'channel:connected', channel: 'feishu' });
    eventBus.publish({ type: 'session:created', sessionId: 's1', channel: 'feishu', channelId: 'c1' });

    expect(count).toBe(3);
  });

  it('should support prefix subscription', () => {
    const sessionEvents: any[] = [];
    eventBus.subscribePrefix('session:', (event) => {
      sessionEvents.push(event);
    });

    eventBus.publish({ type: 'session:created', sessionId: 's1', channel: 'feishu', channelId: 'c1' });
    eventBus.publish({ type: 'message:received', sessionId: 's1', channel: 'feishu', channelId: 'c1', content: 'hi' });
    eventBus.publish({ type: 'session:renamed', sessionId: 's1', oldName: 'old', newName: 'new' });

    expect(sessionEvents).toHaveLength(2);
    expect(sessionEvents[0].type).toBe('session:created');
    expect(sessionEvents[1].type).toBe('session:renamed');
  });

  it('should handle multiple subscribers for same event', () => {
    let count1 = 0, count2 = 0;

    eventBus.subscribe('tool:start', () => count1++);
    eventBus.subscribe('tool:start', () => count2++);

    eventBus.publish({ type: 'tool:start', sessionId: 's1', toolName: 'Bash', input: 'ls' });

    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });

  it('should support unsubscribe', () => {
    let count = 0;
    const handler = () => count++;

    eventBus.subscribe('tool:start', handler);
    eventBus.publish({ type: 'tool:start', sessionId: 's1', toolName: 'Read', input: 'f' });
    expect(count).toBe(1);

    eventBus.unsubscribe('tool:start', handler);
    eventBus.publish({ type: 'tool:start', sessionId: 's1', toolName: 'Read', input: 'f' });
    expect(count).toBe(1);
  });
});
