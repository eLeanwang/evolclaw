import { describe, it, expect } from 'vitest';
import { resolveResponseDepth, computeTopicHash } from '../../src/core/message/response-depth.js';

describe('resolveResponseDepth', () => {
  const baseInput = {
    chatType: 'group' as const,
    content: '这是一条测试消息',
    selfAid: 'me.agentid.pub',
    mentionAids: undefined as string[] | undefined,
    dispatch: 'broadcast' as string | undefined,
    topicRounds: 0,
    lastTopicHash: undefined as string | undefined,
  };

  describe('non-group bypasses', () => {
    it('private chat returns standard', () => {
      const result = resolveResponseDepth({ ...baseInput, chatType: 'private' });
      expect(result.depth).toBe('standard');
    });

    it('undefined chatType returns standard', () => {
      const result = resolveResponseDepth({ ...baseInput, chatType: undefined });
      expect(result.depth).toBe('standard');
    });
  });

  describe('topic tracking', () => {
    it('new topic resets topicRounds to 1', () => {
      const result = resolveResponseDepth({ ...baseInput, topicRounds: 5, lastTopicHash: 'different' });
      expect(result.topicRounds).toBe(1);
    });

    it('same topic increments topicRounds', () => {
      const hash = computeTopicHash('这是一条测试消息');
      const result = resolveResponseDepth({ ...baseInput, topicRounds: 2, lastTopicHash: hash });
      expect(result.topicRounds).toBe(3);
    });

    it('returns consistent topicHash', () => {
      const result = resolveResponseDepth(baseInput);
      expect(result.topicHash).toBe(computeTopicHash('这是一条测试消息'));
    });
  });

  describe('mentioned (isMentioned=true)', () => {
    it('mentioned + topicRounds < 3 → standard', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        mentionAids: ['me.agentid.pub'],
        topicRounds: 0,
        lastTopicHash: undefined,
      });
      expect(result.depth).toBe('standard');
    });

    it('mentioned + topicRounds >= 3 → deep', () => {
      const hash = computeTopicHash('这是一条测试消息');
      const result = resolveResponseDepth({
        ...baseInput,
        mentionAids: ['me.agentid.pub'],
        topicRounds: 2, // will become 3 with same hash
        lastTopicHash: hash,
      });
      expect(result.topicRounds).toBe(3);
      expect(result.depth).toBe('deep');
    });

    it('mentioned takes precedence over broadcast lightweight', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        content: '好的', // short + non-question
        dispatch: 'broadcast',
        mentionAids: ['me.agentid.pub'],
      });
      expect(result.depth).toBe('standard'); // not lightweight
    });
  });

  describe('broadcast mode (not mentioned)', () => {
    it('short + non-question → lightweight', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        content: '好的',
        dispatch: 'broadcast',
      });
      expect(result.depth).toBe('lightweight');
    });

    it('short + question mark → standard (not lightweight)', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        content: '这个行吗？',
        dispatch: 'broadcast',
      });
      expect(result.depth).toBe('standard');
    });

    it('short + question prefix → standard (not lightweight)', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        content: '怎么做的',
        dispatch: 'broadcast',
      });
      expect(result.depth).toBe('standard');
    });

    it('long message → standard', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        content: '这是一条比较长的消息，超过了三十个字符的限制，所以它不算短消息，应该走 standard 路径',
        dispatch: 'broadcast',
      });
      expect(result.depth).toBe('standard');
    });

    it('broadcast + topicRounds >= 3 → deep', () => {
      const content = '好的没问题';
      const hash = computeTopicHash(content);
      const result = resolveResponseDepth({
        ...baseInput,
        content,
        dispatch: 'broadcast',
        topicRounds: 2,
        lastTopicHash: hash,
      });
      // topicRounds becomes 3 → deep overrides lightweight
      expect(result.depth).toBe('deep');
    });
  });

  describe('mention dispatch mode (not mentioned — fallback)', () => {
    it('topicRounds < 3 → standard', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        dispatch: 'mention',
        topicRounds: 0,
      });
      expect(result.depth).toBe('standard');
    });

    it('topicRounds >= 3 → deep', () => {
      const hash = computeTopicHash('这是一条测试消息');
      const result = resolveResponseDepth({
        ...baseInput,
        dispatch: 'mention',
        topicRounds: 2,
        lastTopicHash: hash,
      });
      expect(result.depth).toBe('deep');
    });
  });

  describe('edge cases', () => {
    it('no selfAid → not mentioned even if mentionAids has entries', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        content: '好的',
        selfAid: undefined,
        mentionAids: ['someone.agentid.pub'],
        dispatch: 'broadcast',
      });
      expect(result.depth).toBe('lightweight');
    });

    it('empty content → short, treated as lightweight in broadcast', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        content: '',
        dispatch: 'broadcast',
      });
      expect(result.depth).toBe('lightweight');
    });

    it('English question prefix → standard in broadcast', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        content: 'How does this work',
        dispatch: 'broadcast',
      });
      expect(result.depth).toBe('standard');
    });

    it('no dispatch (undefined) + topicRounds < 3 → standard', () => {
      const result = resolveResponseDepth({
        ...baseInput,
        dispatch: undefined,
      });
      expect(result.depth).toBe('standard');
    });
  });
});

describe('computeTopicHash', () => {
  it('returns 8-char hex string', () => {
    const hash = computeTopicHash('hello world');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('same input → same hash', () => {
    expect(computeTopicHash('test')).toBe(computeTopicHash('test'));
  });

  it('different input → different hash', () => {
    expect(computeTopicHash('alpha')).not.toBe(computeTopicHash('beta'));
  });

  it('only uses first 20 chars', () => {
    const a = 'x'.repeat(20) + 'AAAA';
    const b = 'x'.repeat(20) + 'BBBB';
    expect(computeTopicHash(a)).toBe(computeTopicHash(b));
  });

  it('trims whitespace before hashing', () => {
    expect(computeTopicHash('  hello  ')).toBe(computeTopicHash('hello'));
  });
});
