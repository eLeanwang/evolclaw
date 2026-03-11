import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/core/session-manager.js';
import { Message } from '../../src/types.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager('isolated');
  });

  it('should generate unique session IDs in isolated mode', () => {
    const msg1: Message = { channel: 'feishu', channelId: 'c1', content: 'test', timestamp: Date.now() };
    const msg2: Message = { channel: 'feishu', channelId: 'c2', content: 'test', timestamp: Date.now() };

    const id1 = manager.getClaudeSessionId(msg1);
    const id2 = manager.getClaudeSessionId(msg2);

    expect(id1).not.toBe(id2);
  });

  it('should reuse session ID for same channel in isolated mode', () => {
    const msg1: Message = { channel: 'feishu', channelId: 'c1', content: 'test1', timestamp: Date.now() };
    const msg2: Message = { channel: 'feishu', channelId: 'c1', content: 'test2', timestamp: Date.now() };

    const id1 = manager.getClaudeSessionId(msg1);
    const id2 = manager.getClaudeSessionId(msg2);

    expect(id1).toBe(id2);
  });

  it('should share session in shared mode', () => {
    manager.setMode('shared');
    const msg1: Message = { channel: 'feishu', channelId: 'c1', content: 'test', timestamp: Date.now() };
    const msg2: Message = { channel: 'feishu', channelId: 'c2', content: 'test', timestamp: Date.now() };

    const id1 = manager.getClaudeSessionId(msg1);
    const id2 = manager.getClaudeSessionId(msg2);

    expect(id1).toBe(id2);
  });

  it('should switch modes', () => {
    expect(manager.getMode()).toBe('isolated');
    manager.setMode('shared');
    expect(manager.getMode()).toBe('shared');
  });
});
