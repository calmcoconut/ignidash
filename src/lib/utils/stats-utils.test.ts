import { describe, it, expect } from 'vitest';
import { StatsUtils } from './stats-utils';

describe('StatsUtils', () => {
  describe('mean', () => {
    it('should return -1 for empty array', () => {
      expect(StatsUtils.mean([])).toBe(-1);
    });

    it('should return the value for a single element', () => {
      expect(StatsUtils.mean([5])).toBe(5);
    });

    it('should calculate mean correctly', () => {
      expect(StatsUtils.mean([2, 4, 6])).toBe(4);
      expect(StatsUtils.mean([10, 20, 30, 40])).toBe(25);
    });
  });

  describe('standardDeviation', () => {
    it('should return 0 for empty array', () => {
      expect(StatsUtils.standardDeviation([])).toBe(0);
    });

    it('should return 0 for single element', () => {
      expect(StatsUtils.standardDeviation([42])).toBe(0);
    });

    it('should calculate sample standard deviation correctly', () => {
      // Known values: [2, 4, 4, 4, 5, 5, 7, 9] → sample std dev ≈ 2.138
      const result = StatsUtils.standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]);
      expect(result).toBeCloseTo(2.138, 2);
    });

    it('should return 0 for identical values', () => {
      expect(StatsUtils.standardDeviation([5, 5, 5, 5])).toBe(0);
    });
  });

  describe('getRange', () => {
    it('should extract range from objects', () => {
      const data = [{ v: 10 }, { v: 20 }, { v: 5 }];
      const result = StatsUtils.getRange(data, (d) => d.v);
      expect(result).toEqual({ min: 5, max: 20, range: 15 });
    });

    it('should skip null values', () => {
      const data = [{ v: 10 as number | null }, { v: null }, { v: 30 }];
      const result = StatsUtils.getRange(data, (d) => d.v);
      expect(result).toEqual({ min: 10, max: 30, range: 20 });
    });
  });

  describe('normalize', () => {
    it('should return fallback for null', () => {
      expect(StatsUtils.normalize(null, 0, 100)).toBe(0);
      expect(StatsUtils.normalize(null, 0, 100, 0.5)).toBe(0.5);
    });

    it('should return 0.5 when range is 0', () => {
      expect(StatsUtils.normalize(50, 50, 0)).toBe(0.5);
    });

    it('should normalize to 0-1 range', () => {
      expect(StatsUtils.normalize(0, 0, 100)).toBe(0);
      expect(StatsUtils.normalize(50, 0, 100)).toBe(0.5);
      expect(StatsUtils.normalize(100, 0, 100)).toBe(1);
    });

    it('should clamp to 0-1', () => {
      expect(StatsUtils.normalize(-10, 0, 100)).toBe(0);
      expect(StatsUtils.normalize(200, 0, 100)).toBe(1);
    });

    it('should invert when flag is set', () => {
      expect(StatsUtils.normalize(0, 0, 100, 0, true)).toBe(1);
      expect(StatsUtils.normalize(100, 0, 100, 0, true)).toBe(0);
      expect(StatsUtils.normalize(75, 0, 100, 0, true)).toBe(0.25);
    });
  });

  describe('calculatePercentile', () => {
    // Linear interpolation between the neighbouring order statistics (type 7 / PERCENTILE.INC).
    // Each comment gives the value the old `Math.floor(p * n)` index produced, which was one
    // rank too high — that is the bias P2-P2 removes.
    it('interpolates between order statistics instead of jumping ranks', () => {
      const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      expect(StatsUtils.calculatePercentile(sorted, 0)).toBe(1);
      expect(StatsUtils.calculatePercentile(sorted, 5)).toBeCloseTo(1.45, 10); // was 1 (n=10 → index 0)
      expect(StatsUtils.calculatePercentile(sorted, 10)).toBeCloseTo(1.9, 10); // was 2  (index 1)
      expect(StatsUtils.calculatePercentile(sorted, 25)).toBeCloseTo(3.25, 10); // was 3  (index 2)
      expect(StatsUtils.calculatePercentile(sorted, 50)).toBeCloseTo(5.5, 10); // was 6  (index 5)
      expect(StatsUtils.calculatePercentile(sorted, 75)).toBeCloseTo(7.75, 10); // was 8  (index 7)
      expect(StatsUtils.calculatePercentile(sorted, 90)).toBeCloseTo(9.1, 10); // was 10 (index 9)
      expect(StatsUtils.calculatePercentile(sorted, 95)).toBeCloseTo(9.55, 10); // was 10 (index 9)
      expect(StatsUtils.calculatePercentile(sorted, 100)).toBe(10);
    });

    it('interpolates on a longer known distribution', () => {
      // 1..100: position = (n - 1) * p / 100, so p10 sits at 9.9 → 10.9.
      const sorted = Array.from({ length: 100 }, (_, i) => i + 1);

      expect(StatsUtils.calculatePercentile(sorted, 5)).toBeCloseTo(5.95, 10); // was 6
      expect(StatsUtils.calculatePercentile(sorted, 10)).toBeCloseTo(10.9, 10); // was 11
      expect(StatsUtils.calculatePercentile(sorted, 50)).toBeCloseTo(50.5, 10); // was 51
      expect(StatsUtils.calculatePercentile(sorted, 95)).toBeCloseTo(95.05, 10); // was 96
    });

    it('keeps a discrete rank for opaque rows, which have no midpoint', () => {
      // Whole simulation rows are selected, not estimated, so the rank rule is unchanged.
      const rows = Array.from({ length: 10 }, (_, i) => ({ seed: i + 1 }));

      expect(StatsUtils.calculatePercentile(rows, 50)).toEqual({ seed: 6 });
      expect(StatsUtils.calculatePercentile(rows, 90)).toEqual({ seed: 10 });
    });
  });

  describe('calculatePercentilesFromValues', () => {
    it('should return all percentile buckets, including p5 and p95', () => {
      const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
      const result = StatsUtils.calculatePercentilesFromValues(sorted);

      // Old values (p * n index): p10 = 11, p25 = 26, p50 = 51, p75 = 76, p90 = 91.
      expect(result.p5).toBeCloseTo(5.95, 10);
      expect(result.p10).toBeCloseTo(10.9, 10);
      expect(result.p25).toBeCloseTo(25.75, 10);
      expect(result.p50).toBeCloseTo(50.5, 10);
      expect(result.p75).toBeCloseTo(75.25, 10);
      expect(result.p90).toBeCloseTo(90.1, 10);
      expect(result.p95).toBeCloseTo(95.05, 10);
    });

    it('collapses to the single value of a one-element series', () => {
      const result = StatsUtils.calculatePercentilesFromValues([42]);

      expect(result).toEqual({ p5: 42, p10: 42, p25: 42, p50: 42, p75: 42, p90: 42, p95: 42 });
    });
  });

  describe('minFromSorted / maxFromSorted', () => {
    it('should return -1 for empty arrays', () => {
      expect(StatsUtils.minFromSorted([])).toBe(-1);
      expect(StatsUtils.maxFromSorted([])).toBe(-1);
    });

    it('should return first/last element', () => {
      const sorted = [3, 5, 10];
      expect(StatsUtils.minFromSorted(sorted)).toBe(3);
      expect(StatsUtils.maxFromSorted(sorted)).toBe(10);
    });
  });
});
