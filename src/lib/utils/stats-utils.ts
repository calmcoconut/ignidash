/**
 * Statistical utilities for simulation analysis.
 *
 * Provides descriptive statistics (mean, standard deviation, percentiles) and
 * normalization helpers used by multi-simulation analyzers and chart data extractors.
 */

export interface Stats {
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number | null;
}

export interface Percentiles<T> {
  p5: T;
  p10: T;
  p25: T;
  p50: T;
  p75: T;
  p90: T;
  p95: T;
}

export class StatsUtils {
  static getRange<T>(data: T[], extractor: (row: T) => number | null): { min: number; max: number; range: number } {
    const values = data.map(extractor).filter((v): v is number => v !== null);
    const min = Math.min(...values);
    const max = Math.max(...values);

    return { min, max, range: max - min };
  }

  /**
   * Normalizes a value to the 0–1 range, clamped. Returns `fallback` for null values
   * and 0.5 when range is zero. When `invert` is true, higher raw values produce lower normalized values.
   */
  static normalize(value: number | null, min: number, range: number, fallback: number = 0, invert: boolean = false): number {
    if (value === null) return fallback;
    if (range === 0) return 0.5;

    let norm = (value - min) / range;
    if (invert) norm = 1 - norm;

    return Math.max(0, Math.min(1, norm));
  }

  static mean(values: number[]): number {
    if (values.length === 0) return -1;

    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  static standardDeviation(values: number[]): number {
    if (values.length <= 1) return 0;

    const mean = this.mean(values);
    const squaredDiffs = values.map((val) => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / (values.length - 1);

    return Math.sqrt(variance);
  }

  static minFromSorted(sortedValues: number[]): number {
    if (sortedValues.length === 0) return -1;
    return sortedValues[0];
  }

  static maxFromSorted(sortedValues: number[]): number {
    if (sortedValues.length === 0) return -1;
    return sortedValues[sortedValues.length - 1];
  }

  /**
   * Percentile of a sorted series by linear interpolation between the two neighbouring order
   * statistics: the "type 7" / `PERCENTILE.INC` definition that Excel and NumPy use by default.
   *
   * The previous implementation used `Math.floor(p * n)` as an index, which reads one rank too
   * high for every percentile (it is biased upward) and jumps instead of interpolating. For
   * `[1..10]`, p50 was 6 and is now 5.5.
   *
   * Numeric series interpolate. Opaque rows (e.g. one whole simulation result keyed by seed)
   * have no midpoint, so they keep the discrete selection rank `floor(p * n)` — that is a pick,
   * not an estimate, so interpolation does not apply to it.
   */
  static calculatePercentile<T>(sortedValues: T[], percentile: number): T {
    if (typeof sortedValues[0] !== 'number') {
      const index = Math.floor((percentile / 100) * sortedValues.length);
      return sortedValues[Math.min(index, sortedValues.length - 1)];
    }

    const position = ((sortedValues.length - 1) * Math.max(0, Math.min(100, percentile))) / 100;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);

    const lower = sortedValues[lowerIndex] as number;
    const upper = sortedValues[upperIndex] as number;

    return (lower + (position - lowerIndex) * (upper - lower)) as T;
  }

  static calculatePercentilesFromValues<T>(sortedValues: T[]): Percentiles<T> {
    return {
      p5: this.calculatePercentile(sortedValues, 5),
      p10: this.calculatePercentile(sortedValues, 10),
      p25: this.calculatePercentile(sortedValues, 25),
      p50: this.calculatePercentile(sortedValues, 50),
      p75: this.calculatePercentile(sortedValues, 75),
      p90: this.calculatePercentile(sortedValues, 90),
      p95: this.calculatePercentile(sortedValues, 95),
    };
  }
}
