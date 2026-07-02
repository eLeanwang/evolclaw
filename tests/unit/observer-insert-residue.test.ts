import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 观察者插话 v0.3 残留清除回归（E）：用源码断言锁死 v0.2 主动链路不回潮。
// 详见 docs/observer-insert-design.md §2.5 #9。

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function readAll(dir: string): string {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) out += readAll(fp);
    else if (e.name.endsWith('.ts')) out += `\n/*FILE:${fp}*/\n` + fs.readFileSync(fp, 'utf-8');
  }
  return out;
}

describe('v0.2 residue removed from src/ (E1)', () => {
  const all = readAll(SRC);
  const FORBIDDEN = [
    'replyOverride',
    'injectMeta',
    'InjectMeta',
    'injectPeerChannelId',
    'forceInteractive',
    'pendingReplay',
    'recallRecentOutbound',
    'trackOutboundMid',
    'setInjectRecallHook',
    'peer-replay',
    'outboundChannelId',
  ];
  for (const token of FORBIDDEN) {
    it(`no occurrence of "${token}"`, () => {
      expect(all.includes(token)).toBe(false);
    });
  }
});

describe('message-queue has no inject-priority logic (E2)', () => {
  const queue = fs.readFileSync(path.join(SRC, 'core', 'message', 'message-queue.ts'), 'utf-8');
  it('no isInject helper / owner-priority splice', () => {
    expect(queue.includes('isInject')).toBe(false);
    expect(queue.includes('owner-inject')).toBe(false);
  });
});

describe('message-bridge has no inject special-routing (E3)', () => {
  const bridge = fs.readFileSync(path.join(SRC, 'core', 'message', 'message-bridge.ts'), 'utf-8');
  it('no isInject branch / owner-inject handling', () => {
    expect(bridge.includes('isInject')).toBe(false);
    expect(bridge.includes('owner-inject')).toBe(false);
  });
});
