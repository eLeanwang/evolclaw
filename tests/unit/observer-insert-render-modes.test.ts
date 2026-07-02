import { describe, it, expect } from 'vitest';
import path from 'path';
import { evaluateWhen, defaultModeNames, type ManifestSection } from '../../src/agents/manifest-engine.js';
import { renderMessageBody } from '../../src/agents/message-renderer.js';
import { getPackageRoot } from '../../src/paths.js';
import type { SubMessage } from '../../src/types.js';

// 观察者插话（v0.3）渲染模式：类型(modeType)+名称(modeName)选中唯一 section；
// owner-hint item 走 inject 模板、普通 item 走 private/group。
// 详见 docs/observer-insert-design.md 第二部分。

describe('evaluateWhen: and / or compound', () => {
  it('and requires all sub-conditions', () => {
    const w = { and: [{ var: 'isOwnerHint', eq: true }, { var: 'renderMode_inject', eq: 'default' }] };
    expect(evaluateWhen(w, { isOwnerHint: true, renderMode_inject: 'default' })).toBe(true);
    expect(evaluateWhen(w, { isOwnerHint: false, renderMode_inject: 'default' })).toBe(false);
    expect(evaluateWhen(w, { isOwnerHint: true, renderMode_inject: 'verbose' })).toBe(false);
  });

  it('neq excludes owner-hint from peer sections', () => {
    const w = { and: [{ var: 'isOwnerHint', neq: true }, { var: 'chatType', neq: 'group' }, { var: 'renderMode_private', eq: 'default' }] };
    expect(evaluateWhen(w, { isOwnerHint: false, chatType: 'private', renderMode_private: 'default' })).toBe(true);
    expect(evaluateWhen(w, { isOwnerHint: true, chatType: 'private', renderMode_private: 'default' })).toBe(false);
    expect(evaluateWhen(w, { isOwnerHint: false, chatType: 'group', renderMode_private: 'default' })).toBe(false);
  });

  it('or matches any sub-condition', () => {
    const w = { or: [{ var: 'a', eq: 1 }, { var: 'b', eq: 2 }] };
    expect(evaluateWhen(w, { a: 1, b: 0 })).toBe(true);
    expect(evaluateWhen(w, { a: 0, b: 2 })).toBe(true);
    expect(evaluateWhen(w, { a: 0, b: 0 })).toBe(false);
  });
});

describe('defaultModeNames', () => {
  it('picks the isDefault modeName per modeType', () => {
    const sections: ManifestSection[] = [
      { id: 's1', type: 'file', order: 10, needsInjection: true, when: 'always', modeType: 'private', modeName: 'concise' },
      { id: 's2', type: 'file', order: 11, needsInjection: true, when: 'always', modeType: 'private', modeName: 'default', isDefault: true },
      { id: 's3', type: 'file', order: 5, needsInjection: true, when: 'always', modeType: 'inject', modeName: 'default', isDefault: true },
    ];
    expect(defaultModeNames(sections)).toEqual({ private: 'default', inject: 'default' });
  });
});

// 渲染层端到端：使用真实 manifest（kits/eck_message_manifest.json）。
describe('renderMessageBody: owner-hint vs peer item', () => {
  // 渲染层靠 vars 解析模板路径 $KITS_MESSAGE_FRAGMENTS（生产中由 message-processor 注入）。
  const sessionVars = {
    selfAid: 'agent.aid.pub', timezone: 'UTC',
    KITS_MESSAGE_FRAGMENTS: path.join(getPackageRoot(), 'kits', 'templates', 'message-fragments'),
  };

  it('owner-hint item renders inject envelope header', () => {
    const items: SubMessage[] = [
      { kind: 'owner-hint', content: '别答应折扣', ownerAid: 'owner.aid.pub', injectTime: 1700000000000, timestamp: 1700000000000 },
    ];
    const { body } = renderMessageBody(items, sessionVars, 'sess-1');
    expect(body).toContain('owner');           // 信封头标注 owner
    expect(body).toContain('别答应折扣');        // 提示正文
  });

  it('normal private item renders peer envelope, not inject header', () => {
    const items: SubMessage[] = [
      { peerId: 'peer.aid.pub', content: '你好', timestamp: 1700000000000 },
    ];
    const { body } = renderMessageBody(items, { ...sessionVars, chatType: 'private' }, 'sess-2');
    expect(body).toContain('你好');
    expect(body).not.toContain('owner 提示');
  });

  it('hint item then peer item produce two stacked segments', () => {
    const items: SubMessage[] = [
      { kind: 'owner-hint', content: 'HINT', ownerAid: 'o.aid.pub', injectTime: 1700000000000 },
      { peerId: 'peer.aid.pub', content: 'PEERMSG', timestamp: 1700000000000 },
    ];
    const { body } = renderMessageBody(items, { ...sessionVars, chatType: 'private' }, 'sess-3');
    expect(body.indexOf('HINT')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('PEERMSG')).toBeGreaterThan(body.indexOf('HINT'));
  });

  // B3. coding/null chatType 普通消息 → 命中 private 兜底 section，仍有信封
  it('null chatType peer item still renders (private fallback)', () => {
    const items: SubMessage[] = [{ peerId: 'peer.aid.pub', content: 'CODINGMSG', timestamp: 1700000000000 }];
    const { body } = renderMessageBody(items, sessionVars, 'sess-4');  // 无 chatType
    expect(body).toContain('CODINGMSG');
    expect(body).toContain('from:peer.aid.pub');  // 信封头存在
    expect(body).not.toContain('owner 提示');
  });

  // B4. group chatType 普通消息 → 命中 group section
  it('group chatType peer item renders group envelope', () => {
    const items: SubMessage[] = [{ peerId: 'sender.aid.pub', content: 'GROUPMSG', timestamp: 1700000000000 }];
    const { body } = renderMessageBody(
      items,
      { ...sessionVars, chatType: 'group', groupId: 'g1', groupLabel: 'team<g1>' }, 'sess-5',
    );
    expect(body).toContain('GROUPMSG');
  });

  // B2. config 配了 manifest 无对应 section 的模式名 → 该 item 无命中 → 回退 raw（不丢消息）
  it('unknown configured mode falls back to raw content', () => {
    const items: SubMessage[] = [{ peerId: 'peer.aid.pub', content: 'RAWFALLBACK', timestamp: 1700000000000 }];
    const { body } = renderMessageBody(
      items,
      { ...sessionVars, chatType: 'private', renderModes: { private: 'nonexistent-mode' } },
      'sess-6',
    );
    // 无 section 命中 → renderOneItem 末尾兜底返回原文
    expect(body).toContain('RAWFALLBACK');
  });
});

describe('evaluateWhen: neq (B1)', () => {
  it('neq true excludes owner-hint, includes normal', () => {
    const w = { var: 'isOwnerHint', neq: true };
    expect(evaluateWhen(w, { isOwnerHint: true })).toBe(false);
    expect(evaluateWhen(w, { isOwnerHint: false })).toBe(true);
    expect(evaluateWhen(w, {})).toBe(true);  // 缺省（undefined）视为 != true
  });
});

describe('defaultModeNames: multiple isDefault (B5)', () => {
  it('takes the first (lowest order) isDefault per type', () => {
    const sections: ManifestSection[] = [
      { id: 's2', type: 'file', order: 20, needsInjection: true, when: 'always', modeType: 'private', modeName: 'second', isDefault: true },
      { id: 's1', type: 'file', order: 10, needsInjection: true, when: 'always', modeType: 'private', modeName: 'first', isDefault: true },
    ];
    // defaultModeNames 在已排序 sections 上取首个；这里手动按 order 传入升序
    const sorted = sections.slice().sort((a, b) => a.order - b.order);
    expect(defaultModeNames(sorted)).toEqual({ private: 'first' });
  });
});

