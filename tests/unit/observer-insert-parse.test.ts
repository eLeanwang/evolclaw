import { describe, it, expect } from 'vitest';
import {
  parseInjectRequest, hintsToSubMessages, composeHintFallback,
  type EffectiveHint,
} from '../../src/core/message/pending-hints.js';
import type { SubMessage } from '../../src/types.js';

// 观察者插话（v0.3）请求解析 + 渲染接线纯函数。
// 对应 docs/observer-insert-design.md §1.5[B][C] / §1.6 / §2.3。

const OWNER = 'owner.agentid.pub';
const OWNERS = [OWNER];

describe('parseInjectRequest: 鉴权 (D1)', () => {
  it('rejects non-owner with NOT_OWNER', () => {
    const r = parseInjectRequest(
      { action: 'add', target: { channel_id: 'peer.aid.pub' }, text: 'hi', id: 'i1' },
      'stranger.aid.pub', OWNERS, 100,
    );
    expect(r).toMatchObject({ kind: 'reject', code: 'NOT_OWNER', action: 'add', injectId: 'i1' });
  });
});

describe('parseInjectRequest: 校验 (D2/D3)', () => {
  it('add without text → INVALID_TARGET', () => {
    const r = parseInjectRequest({ action: 'add', target: { channel_id: 'peer.aid.pub' } }, OWNER, OWNERS, 100);
    expect(r).toMatchObject({ kind: 'reject', code: 'INVALID_TARGET', action: 'add' });
  });

  it('add without channel_id → INVALID_TARGET', () => {
    const r = parseInjectRequest({ action: 'add', text: 'hi' }, OWNER, OWNERS, 100);
    expect(r).toMatchObject({ kind: 'reject', code: 'INVALID_TARGET' });
  });

  it('whitespace-only text → INVALID_TARGET', () => {
    const r = parseInjectRequest({ action: 'add', target: { channel_id: 'p' }, text: '   ' }, OWNER, OWNERS, 100);
    expect(r).toMatchObject({ kind: 'reject', code: 'INVALID_TARGET' });
  });

  it('remove needs only channel_id (no text required)', () => {
    const r = parseInjectRequest({ action: 'remove', target: { channel_id: 'peer.aid.pub' } }, OWNER, OWNERS, 100);
    expect(r.kind).toBe('remove');
  });

  it('remove without channel_id → INVALID_TARGET', () => {
    const r = parseInjectRequest({ action: 'remove' }, OWNER, OWNERS, 100);
    expect(r).toMatchObject({ kind: 'reject', code: 'INVALID_TARGET', action: 'remove' });
  });
});

describe('parseInjectRequest: add 归一 (D4)', () => {
  it('parses a full add request', () => {
    const r = parseInjectRequest(
      { action: 'add', id: 'i1', target: { channel_id: 'peer.aid.pub', chat_type: 'private', thread_id: 't1' }, text: '语气客气些' },
      OWNER, OWNERS, 100,
    );
    expect(r).toEqual({
      kind: 'add', injectId: 'i1', id: 'i1', text: '语气客气些',
      channelId: 'peer.aid.pub', chatType: 'private', threadId: 't1', ownerAid: OWNER,
    });
  });

  it('defaults action to add when omitted', () => {
    const r = parseInjectRequest({ target: { channel_id: 'p' }, text: 'hi' }, OWNER, OWNERS, 100);
    expect(r.kind).toBe('add');
  });

  it('synthesizes id from ts when id missing', () => {
    const r = parseInjectRequest({ action: 'add', target: { channel_id: 'p' }, text: 'hi' }, OWNER, OWNERS, 777);
    expect(r).toMatchObject({ kind: 'add', id: 'inj-777', injectId: undefined });
  });

  it('defaults chatType to private and threadId undefined (main thread)', () => {
    const r = parseInjectRequest({ action: 'add', target: { channel_id: 'p' }, text: 'hi' }, OWNER, OWNERS, 100);
    expect(r).toMatchObject({ kind: 'add', chatType: 'private', threadId: undefined });
  });

  it('honors chat_type=group', () => {
    const r = parseInjectRequest({ action: 'add', target: { channel_id: 'g', chat_type: 'group' }, text: 'hi' }, OWNER, OWNERS, 100);
    expect(r).toMatchObject({ kind: 'add', chatType: 'group' });
  });
});

describe('parseInjectRequest: remove 归一 (D6)', () => {
  it('remove with target_id → precise', () => {
    const r = parseInjectRequest(
      { action: 'remove', target: { channel_id: 'p' }, target_id: 'i1' }, OWNER, OWNERS, 100,
    );
    expect(r).toMatchObject({ kind: 'remove', targetId: 'i1', channelId: 'p' });
  });

  it('remove without target_id → clear-all (targetId undefined)', () => {
    const r = parseInjectRequest({ action: 'remove', target: { channel_id: 'p' } }, OWNER, OWNERS, 100);
    expect(r).toMatchObject({ kind: 'remove', targetId: undefined });
  });
});

describe('parseInjectRequest: 畸形 payload 不崩', () => {
  it('handles null / non-object payload as empty (rejects)', () => {
    expect(parseInjectRequest(null, OWNER, OWNERS, 1).kind).toBe('reject');     // no target
    expect(parseInjectRequest('str', OWNER, OWNERS, 1).kind).toBe('reject');
    expect(parseInjectRequest(undefined, 'x', OWNERS, 1)).toMatchObject({ code: 'NOT_OWNER' });
  });
});

describe('hintsToSubMessages (C)', () => {
  it('maps EffectiveHint to owner-hint SubMessage', () => {
    const hints: EffectiveHint[] = [
      { id: 'h1', text: '别答应折扣', ownerAid: OWNER, ts: 123 },
    ];
    expect(hintsToSubMessages(hints)).toEqual([
      { kind: 'owner-hint', content: '别答应折扣', ownerAid: OWNER, injectTime: 123, timestamp: 123 },
    ]);
  });

  it('preserves order and maps all', () => {
    const hints: EffectiveHint[] = [
      { id: 'h1', text: 'a', ownerAid: OWNER, ts: 1 },
      { id: 'h2', text: 'b', ownerAid: OWNER, ts: 2 },
    ];
    expect(hintsToSubMessages(hints).map(s => s.content)).toEqual(['a', 'b']);
  });

  it('empty in → empty out', () => {
    expect(hintsToSubMessages([])).toEqual([]);
  });
});

describe('composeHintFallback (C5/C6)', () => {
  const hintItems: SubMessage[] = [
    { kind: 'owner-hint', content: 'HINT-A' },
    { kind: 'owner-hint', content: 'HINT-B' },
  ];

  it('prepends hint text before peer content', () => {
    const out = composeHintFallback(hintItems, 'peer-msg');
    expect(out).toContain('HINT-A');
    expect(out).toContain('HINT-B');
    expect(out.indexOf('HINT-A')).toBeLessThan(out.indexOf('peer-msg'));
    expect(out.indexOf('HINT-B')).toBeLessThan(out.indexOf('peer-msg'));
    expect(out).toContain('对端无感');
  });

  it('no hints → returns content unchanged', () => {
    expect(composeHintFallback([], 'peer-msg')).toBe('peer-msg');
  });
});
