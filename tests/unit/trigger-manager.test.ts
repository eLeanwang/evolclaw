import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { TriggerManager } from '../../src/core/trigger/manager.js';
import type { Trigger } from '../../src/types.js';

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 'test-id-1',
    name: 'test-trigger',
    scheduleType: 'delay',
    scheduleValue: String(30 * 60 * 1000),
    nextFireAt: Date.now() + 30 * 60 * 1000,
    targetChannel: 'feishu-main',
    targetChannelId: 'oc_xxx',
    targetSessionStrategy: 'latest',
    prompt: 'check CI',
    createdByPeerId: 'user-1',
    createdByChannel: 'feishu-main',
    fireCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('TriggerManager', () => {
  let tmpDir: string;
  let manager: TriggerManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-test-'));
    manager = new TriggerManager('test-aid', tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads empty when no file', () => {
    const triggers = manager.load();
    expect(triggers).toHaveLength(0);
  });

  it('registers and persists a trigger', () => {
    const t = makeTrigger();
    manager.register(t);
    expect(manager.listActive()).toHaveLength(1);

    const manager2 = new TriggerManager('test-aid', tmpDir);
    const loaded = manager2.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('test-trigger');
  });

  it('throws on duplicate name', () => {
    manager.register(makeTrigger());
    expect(() => manager.register(makeTrigger({ id: 'other-id' }))).toThrow('名称已存在');
  });

  it('throws on duplicate id', () => {
    manager.register(makeTrigger());
    expect(() => manager.register(makeTrigger({ name: 'other-name' }))).toThrow('ID 已存在');
  });

  it('getByName finds trigger', () => {
    manager.register(makeTrigger());
    expect(manager.getByName('test-trigger')).toBeDefined();
    expect(manager.getByName('nonexistent')).toBeUndefined();
  });

  it('getByNameScoped respects ownership', () => {
    manager.register(makeTrigger());
    expect(manager.getByNameScoped('test-trigger', 'user-1', 'feishu-main')).toBeDefined();
    expect(manager.getByNameScoped('test-trigger', 'other-user', 'feishu-main')).toBeUndefined();
  });

  it('getByIdScoped respects ownership', () => {
    manager.register(makeTrigger());
    expect(manager.getByIdScoped('test-id-1', 'user-1', 'feishu-main')).toBeDefined();
    expect(manager.getByIdScoped('test-id-1', 'other-user', 'feishu-main')).toBeUndefined();
  });

  it('moveToDone removes from active and appends to history', () => {
    manager.register(makeTrigger());
    manager.moveToDone('test-id-1', 'fired');
    expect(manager.listActive()).toHaveLength(0);

    const { history } = manager.listAll();
    expect(history).toHaveLength(1);
    expect((history[0] as any).doneReason).toBe('fired');
  });

  it('updateFireStats increments count', () => {
    manager.register(makeTrigger());
    manager.updateFireStats('test-id-1', Date.now());
    const t = manager.getById('test-id-1');
    expect(t?.fireCount).toBe(1);
  });

  it('listActive sorts by nextFireAt', () => {
    const now = Date.now();
    manager.register(makeTrigger({ id: 'id-2', name: 'b', nextFireAt: now + 2000 }));
    manager.register(makeTrigger({ id: 'id-1', name: 'a', nextFireAt: now + 1000 }));
    const active = manager.listActive();
    expect(active[0].name).toBe('a');
    expect(active[1].name).toBe('b');
  });
});
