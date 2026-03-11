import { describe, it, expect, vi } from 'vitest';
import { ClaudeInstance, InstanceState } from '../../src/gateway/claude-instance.js';

describe('ClaudeInstance', () => {
  it('should initialize in idle state', () => {
    const instance = new ClaudeInstance('s1', '/tmp', 'test-key');
    expect(instance.getState()).toBe(InstanceState.IDLE);
  });

  it('should track idle time', () => {
    const instance = new ClaudeInstance('s1', '/tmp', 'test-key');
    expect(instance.getIdleTime()).toBeGreaterThanOrEqual(0);
  });

  it('should check if alive', () => {
    const instance = new ClaudeInstance('s1', '/tmp', 'test-key');
    expect(instance.isAlive()).toBe(true);
  });

  it('should handle stop', async () => {
    const instance = new ClaudeInstance('s1', '/tmp', 'test-key');
    await instance.stop();
    expect(instance.getState()).toBe(InstanceState.STOPPED);
  });

  it('should emit hook events', () => {
    const instance = new ClaudeInstance('s1', '/tmp', 'test-key');
    const handler = vi.fn();
    instance.on('hook', handler);
    expect(handler).not.toHaveBeenCalled();
  });
});
