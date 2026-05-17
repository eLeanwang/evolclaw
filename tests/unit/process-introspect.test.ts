import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCimDate, startTimeMatches, START_TIME_TOLERANCE_MS } from '../../src/utils/process-introspect.js';

describe('process-introspect', () => {
  describe('parseCimDate', () => {
    it('parses standard CIM date format (UTC+8)', () => {
      const result = parseCimDate('20260516080000.000000+480');
      expect(result).toBeTypeOf('number');
      // 2026-05-16 08:00:00 local (UTC+8) = 2026-05-16 00:00:00 UTC
      const expected = Date.UTC(2026, 4, 16, 0, 0, 0);
      expect(result).toBe(expected);
    });

    it('parses CIM date with negative timezone', () => {
      const result = parseCimDate('20260516120000.000000-300');
      expect(result).toBeTypeOf('number');
      // 2026-05-16 12:00:00 local (UTC-5) = 2026-05-16 17:00:00 UTC
      const expected = Date.UTC(2026, 4, 16, 17, 0, 0);
      expect(result).toBe(expected);
    });

    it('parses CIM date with microseconds', () => {
      const result = parseCimDate('20260516153045.123456+480');
      expect(result).toBeTypeOf('number');
      // 2026-05-16 15:30:45.123 local (UTC+8) = 2026-05-16 07:30:45.123 UTC
      const expected = Date.UTC(2026, 4, 16, 7, 30, 45, 123);
      expect(result).toBe(expected);
    });

    it('returns null for empty string', () => {
      expect(parseCimDate('')).toBeNull();
    });

    it('returns null for invalid format', () => {
      expect(parseCimDate('not-a-date')).toBeNull();
      expect(parseCimDate('2026-05-16T08:00:00Z')).toBeNull();
    });

    it('returns null for null/undefined input', () => {
      expect(parseCimDate(null as any)).toBeNull();
      expect(parseCimDate(undefined as any)).toBeNull();
    });
  });

  describe('startTimeMatches', () => {
    it('matches when times are identical', () => {
      const now = Date.now();
      expect(startTimeMatches(now, now)).toBe(true);
    });

    it('matches within 2s tolerance', () => {
      const now = Date.now();
      expect(startTimeMatches(now, now + 1500)).toBe(true);
      expect(startTimeMatches(now, now - 1999)).toBe(true);
    });

    it('does not match beyond 2s tolerance', () => {
      const now = Date.now();
      expect(startTimeMatches(now, now + 2001)).toBe(false);
      expect(startTimeMatches(now, now - 3000)).toBe(false);
    });

    it('does not match when actual is null', () => {
      expect(startTimeMatches(Date.now(), null)).toBe(false);
    });

    it('tolerance constant is 2000ms', () => {
      expect(START_TIME_TOLERANCE_MS).toBe(2000);
    });
  });
});
