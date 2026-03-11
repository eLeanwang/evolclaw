import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InstanceManager } from '../../src/gateway/instance-manager.js';

describe('InstanceManager', () => {
  let manager: InstanceManager;

  beforeEach(() => {
    manager = new InstanceManager({ maxInstances: 2, idleTimeout: 60000, apiKey: 'test' });
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it('should respect max instances limit', async () => {
    await manager.getOrCreateInstance('s1', '/tmp');
    await manager.getOrCreateInstance('s2', '/tmp');
    await expect(manager.getOrCreateInstance('s3', '/tmp')).rejects.toThrow('Max instances');
  });

  it('should reuse existing instance', async () => {
    const i1 = await manager.getOrCreateInstance('s1', '/tmp');
    const i2 = await manager.getOrCreateInstance('s1', '/tmp');
    expect(i1).toBe(i2);
  });

  it('should get instance by id', async () => {
    await manager.getOrCreateInstance('s1', '/tmp');
    expect(manager.getInstance('s1')).toBeDefined();
  });

  it('should get metrics', async () => {
    await manager.getOrCreateInstance('s1', '/tmp');
    const metrics = manager.getMetrics();
    expect(metrics.total).toBe(1);
  });

  it('should stop instance', async () => {
    await manager.getOrCreateInstance('s1', '/tmp');
    await manager.stopInstance('s1');
    expect(manager.getInstance('s1')).toBeUndefined();
  });
});
