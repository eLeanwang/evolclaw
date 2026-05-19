import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionRouter } from '../../src/core/interaction-router.js';

describe('InteractionRouter', () => {
  let router: InteractionRouter;

  beforeEach(() => {
    router = new InteractionRouter();
  });

  describe('findPendingByCommand', () => {
    it('returns id when matching sessionId and fallbackCommand', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, { fallbackCommand: 'perm' });

      expect(router.findPendingByCommand('session-a', 'perm')).toBe('req-1');
    });

    it('returns undefined when no matching command', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, { fallbackCommand: 'perm' });

      expect(router.findPendingByCommand('session-a', 'ask')).toBeUndefined();
    });

    it('returns undefined when no matching session', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, { fallbackCommand: 'perm' });

      expect(router.findPendingByCommand('session-b', 'perm')).toBeUndefined();
    });

    it('returns earliest pending when multiple match', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, { fallbackCommand: 'ask' });
      router.register('req-2', 'session-a', cb, { fallbackCommand: 'ask' });

      expect(router.findPendingByCommand('session-a', 'ask')).toBe('req-1');
    });

    it('returns undefined when handler has no fallbackCommand', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb);

      expect(router.findPendingByCommand('session-a', 'perm')).toBeUndefined();
    });
  });

  describe('getInitiator', () => {
    it('returns initiatorId when set', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, { initiatorId: 'user-123' });

      expect(router.getInitiator('req-1')).toBe('user-123');
    });

    it('returns undefined when not set', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb);

      expect(router.getInitiator('req-1')).toBeUndefined();
    });

    it('returns undefined for non-existent id', () => {
      expect(router.getInitiator('non-existent')).toBeUndefined();
    });
  });

  describe('register with new opts', () => {
    it('stores initiatorId and fallbackCommand', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, {
        initiatorId: 'user-abc',
        fallbackCommand: 'perm',
      });

      expect(router.getInitiator('req-1')).toBe('user-abc');
      expect(router.findPendingByCommand('session-a', 'perm')).toBe('req-1');
    });

    it('clears pending after handle', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, { fallbackCommand: 'ask' });

      router.handle({ type: 'interaction.response', id: 'req-1', action: '1' });

      expect(router.findPendingByCommand('session-a', 'ask')).toBeUndefined();
      expect(router.getInitiator('req-1')).toBeUndefined();
    });

    it('clears pending after cancel', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, { fallbackCommand: 'perm' });

      router.cancel('req-1');

      expect(router.findPendingByCommand('session-a', 'perm')).toBeUndefined();
    });

    it('clears pending after cancelAll for the session', () => {
      const cb = vi.fn();
      router.register('req-1', 'session-a', cb, { fallbackCommand: 'perm' });
      router.register('req-2', 'session-b', cb, { fallbackCommand: 'perm' });

      router.cancelAll('session-a');

      expect(router.findPendingByCommand('session-a', 'perm')).toBeUndefined();
      expect(router.findPendingByCommand('session-b', 'perm')).toBe('req-2');
    });

    it('isolates pending across different sessions', () => {
      const cb = vi.fn();
      router.register('req-a', 'session-a', cb, { fallbackCommand: 'ask' });
      router.register('req-b', 'session-b', cb, { fallbackCommand: 'ask' });

      expect(router.findPendingByCommand('session-a', 'ask')).toBe('req-a');
      expect(router.findPendingByCommand('session-b', 'ask')).toBe('req-b');
    });

    it('reusing same id replaces previous registration', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      router.register('req-1', 'session-a', cb1, { fallbackCommand: 'perm', initiatorId: 'user-1' });
      router.register('req-1', 'session-a', cb2, { fallbackCommand: 'ask', initiatorId: 'user-2' });

      expect(router.findPendingByCommand('session-a', 'perm')).toBeUndefined();
      expect(router.findPendingByCommand('session-a', 'ask')).toBe('req-1');
      expect(router.getInitiator('req-1')).toBe('user-2');
    });
  });
});
