import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseModeRegistry } from '../../src/response-system/registry.js';
import { ResponseModeResolver } from '../../src/response-system/resolver.js';
import type { ResponseMode, MessageQueueInterface } from '../../src/response-system/types.js';
import { FIFOQueue } from '../../src/response-system/queues/fifo-queue.js';

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
    // single-session 标记为注册表首选（responseMode 解析链的最终兜底）
    reg.registerBuiltin(makeMode('single-session', 'builtin', ['private', 'group']), true);
    reg.registerBuiltin(makeMode('dual-session', 'builtin', ['group']));
    resolver = new ResponseModeResolver(reg);
  });

  it('无 responseMode 配置时兜底注册表首选 single-session', () => {
    const r = resolver.resolve(undefined);
    expect(r.mode.id).toBe('single-session');
    expect(r.source).toBe('preferred');
  });

  it('标量 responseMode 指定的模式优先于首选', () => {
    const r = resolver.resolve('dual-session');
    expect(r.mode.id).toBe('dual-session');
    expect(r.source).toBe('config');
  });

  it('responseMode 指向不存在的模式时回落注册表首选', () => {
    const r = resolver.resolve('nonexistent');
    expect(r.mode.id).toBe('single-session');
    expect(r.source).toBe('preferred');
  });
});
