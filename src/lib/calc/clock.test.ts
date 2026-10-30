import { describe, it, expect } from 'vitest';

import { addMonths, fixedClock, formatISODate, formatISOMonth, isISODateString, parseISODateString, toSimulationDate } from './clock';

describe('clock', () => {
  describe('parseISODateString', () => {
    it('reads calendar components straight from the string', () => {
      expect(parseISODateString('2026-03-15')).toEqual({ year: 2026, month: 3, day: 15 });
      expect(parseISODateString('2026-12-01')).toEqual({ year: 2026, month: 12, day: 1 });
    });

    it('rejects malformed strings', () => {
      expect(() => parseISODateString('2026-3-15')).toThrow();
      expect(() => parseISODateString('15/03/2026')).toThrow();
      expect(() => parseISODateString('')).toThrow();
      expect(() => parseISODateString('2026-03-15T00:00:00Z')).toThrow();
    });

    it('rejects impossible calendar dates', () => {
      expect(() => parseISODateString('2026-02-30')).toThrow();
      expect(() => parseISODateString('2026-13-01')).toThrow();
      expect(() => parseISODateString('2026-00-10')).toThrow();
      expect(() => parseISODateString('2026-04-31')).toThrow();
    });
  });

  describe('isISODateString', () => {
    it('accepts only real YYYY-MM-DD dates', () => {
      expect(isISODateString('2026-03-15')).toBe(true);
      expect(isISODateString('2024-02-29')).toBe(true);
      expect(isISODateString('2026-02-29')).toBe(false);
      expect(isISODateString('2026-02-30')).toBe(false);
      expect(isISODateString('not-a-date')).toBe(false);
    });
  });

  describe('formatting', () => {
    it('formats a calendar date', () => {
      expect(formatISODate({ year: 2026, month: 3, day: 5 })).toBe('2026-03-05');
      expect(formatISODate({ year: 999, month: 12, day: 31 })).toBe('0999-12-31');
    });

    it('formats a calendar month as its first day', () => {
      expect(formatISOMonth(2026, 3)).toBe('2026-03-01');
      expect(formatISOMonth(2031, 12)).toBe('2031-12-01');
    });
  });

  describe('addMonths', () => {
    it('does integer month arithmetic without a Date', () => {
      const start = { year: 2026, month: 10, day: 29 };
      expect(addMonths(start, 0)).toEqual({ year: 2026, month: 10, day: 29 });
      expect(addMonths(start, 1)).toEqual({ year: 2026, month: 11, day: 29 });
      expect(addMonths(start, 3)).toEqual({ year: 2027, month: 1, day: 29 });
      expect(addMonths(start, 12)).toEqual({ year: 2027, month: 10, day: 29 });
      expect(addMonths(start, 26)).toEqual({ year: 2028, month: 12, day: 29 });
    });

    it('handles month boundaries in both directions', () => {
      expect(addMonths({ year: 2026, month: 12, day: 1 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
      expect(addMonths({ year: 2026, month: 1, day: 1 }, 11)).toEqual({ year: 2026, month: 12, day: 1 });
      expect(addMonths({ year: 2026, month: 1, day: 1 }, -1)).toEqual({ year: 2025, month: 12, day: 1 });
      expect(addMonths({ year: 2026, month: 1, day: 1 }, -13)).toEqual({ year: 2024, month: 12, day: 1 });
    });
  });

  describe('fixedClock', () => {
    it('pins and normalizes the as-of date', () => {
      expect(fixedClock('2026-03-15').asOf).toBe('2026-03-15');
      expect(fixedClock('2026-03-05').asOf).toBe('2026-03-05');
    });

    it('refuses an invalid as-of date instead of falling back to the wall clock', () => {
      expect(() => fixedClock('2026-02-30')).toThrow(/Invalid ISO date/);
      expect(() => fixedClock('today')).toThrow(/Invalid ISO date/);
    });
  });

  describe('toSimulationDate', () => {
    it('round-trips calendar components through the local date constructor', () => {
      // The engine compares this Date against the timeline processors' `new Date(y, m, d)`
      // time points, so the components must survive whatever timezone the host is in.
      for (const date of [
        { year: 2026, month: 1, day: 1 },
        { year: 2026, month: 3, day: 15 },
        { year: 2031, month: 12, day: 1 },
      ]) {
        const result = toSimulationDate(date);
        expect(result.getFullYear()).toBe(date.year);
        expect(result.getMonth() + 1).toBe(date.month);
        expect(result.getDate()).toBe(date.day);
      }
    });
  });
});
