import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseModeRegistry } from '../../src/response-modes/registry.js';
import { ResponseModeResolver } from '../../src/response-modes/resolver.js';
import type { ResponseMode, MessageQueueInterface } from '../../src/response-modes/types.js';
import { FIFOQueue } from '../../src/response-modes/queues/fifo-queue.js';

function makeMode(id: string, type: 'builtin' | 'extension', scenes: ('private' | 'group')[]): ResponseMode {
  const queue = new FIFOQueue();
  return {
    id,
    displayName: id,
    description: `mode ${id}`,
    type,
    applicableScenes: scenes,
    initialize: async () => {},
    cleanup: async () => {},
    handleInbound: async () => ({ action: 'process' }),
    handleOutbound: async () => ({ method: 'direct' }),
    getQueue: () => queue,
  };
}

describe('ResponseModeRegistry', () => {
  let reg: ResponseModeRegistry;
  beforeEach(() => { reg = new ResponseModeRegistry(); });

  it('registers and gets builtin', () => {
    const m = makeMode('interactive', 'builtin', ['private']);
    reg.registerBuiltin(m);
    expect(reg.get('interactive')).toBe(m);
    expect(reg.has('interactive')).toBe(true);
  });

  it('rejects builtin with wrong type', () => {
    const m = makeMode('x', 'extension', ['private']);
    expect(() => reg.registerBuiltin(m)).toThrow(/type='builtin'/);
  });

  it('rejects duplicate builtin', () => {
    reg.registerBuiltin(makeMode('a', 'builtin', ['private']));
    expect(() => reg.registerBuiltin(makeMode('a', 'builtin', ['private']))).toThrow(/already registered/);
  });

  it('extension cannot override builtin', () => {
    reg.registerBuiltin(makeMode('a', 'builtin', ['private']));
    expect(() => reg.registerExtension(makeMode('a', 'extension', ['private']))).toThrow(/cannot override builtin/);
  });

  it('cannot unregister builtin', () => {
    reg.registerBuiltin(makeMode('a', 'builtin', ['private']));
    expect(() => reg.unregister('a')).toThrow(/cannot unregister builtin/);
  });

  it('unregisters extension', () => {
    reg.registerExtension(makeMode('e', 'extension', ['private']));
    reg.unregister('e');
    expect(reg.has('e')).toBe(false);
  });

  it('lists filtered by scene', () => {
    reg.registerBuiltin(makeMode('p', 'builtin', ['private']));
    reg.registerBuiltin(makeMode('g', 'builtin', ['group']));
    reg.registerBuiltin(makeMode('both', 'builtin', ['private', 'group']));
    expect(reg.list('private').map(m => m.id).sort()).toEqual(['both', 'p']);
    expect(reg.list('group').map(m => m.id).sort()).toEqual(['both', 'g']);
    expect(reg.list().length).toBe(3);
  });
});

describe('ResponseModeResolver', () => {
  let reg: ResponseModeRegistry;
  let resolver: ResponseModeResolver;

  beforeEach(() => {
    reg = new ResponseModeRegistry();
    reg.registerBuiltin(makeMode('interactive', 'builtin', ['private']));
    reg.registerBuiltin(makeMode('proactive', 'builtin', ['private', 'group']));
    reg.registerBuiltin(makeMode('dual-session', 'builtin', ['group']));
    resolver = new ResponseModeResolver(reg);
  });

  it('falls back to interactive for private when no config', () => {
    const r = resolver.resolve('private', undefined, undefined);
    expect(r.mode.id).toBe('interactive');
    expect(r.source).toBe('fallback');
  });

  it('falls back to proactive for group when no config', () => {
    const r = resolver.resolve('group', undefined, undefined);
    expect(r.mode.id).toBe('proactive');
    expect(r.source).toBe('fallback');
  });

  it('uses chatType default', () => {
    const r = resolver.resolve('group', undefined, { default_group: 'dual-session' });
    expect(r.mode.id).toBe('dual-session');
    expect(r.source).toBe('default');
  });

  it('override wins over default', () => {
    const r = resolver.resolve('group', 'aun#grp1', {
      default_group: 'proactive',
      overrides: { 'aun#grp1': { mode: 'dual-session' } },
    });
    expect(r.mode.id).toBe('dual-session');
    expect(r.source).toBe('override');
  });

  it('merges config: override.config over configs[id]', () => {
    const r = resolver.resolve('group', 'aun#grp1', {
      configs: { 'dual-session': { a: 1, b: 2 } },
      overrides: { 'aun#grp1': { mode: 'dual-session', config: { b: 99 } } },
    });
    expect(r.config).toEqual({ a: 1, b: 99 });
  });

  it('bad override mode falls back to default', () => {
    const r = resolver.resolve('group', 'aun#grp1', {
      default_group: 'proactive',
      overrides: { 'aun#grp1': { mode: 'nonexistent' } },
    });
    expect(r.mode.id).toBe('proactive');
    expect(r.source).toBe('default');
  });
});
