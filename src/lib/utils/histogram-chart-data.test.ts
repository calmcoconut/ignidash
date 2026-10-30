import { describe, it, expect } from 'vitest';

import { toHistogramChartData } from './histogram-chart-data';
import { buildHistogram, MONTE_CARLO_HISTOGRAM_BINS, type MonteCarloHistogram } from '@/lib/calc/monte-carlo';
import { formatCurrency } from '@/lib/utils/number-formatters';

/**
 * A histogram the summary could NOT have produced by binning final values: two bins of unequal
 * width with a gap between them. If the chart mapping re-binned anything (or read trial values)
 * this shape would be lost, so passing it through unchanged is the proof that the chart renders
 * the summary's own bins.
 */
const handMade: MonteCarloHistogram = {
  binWidth: 0, // deliberately wrong for the bounds below: the mapping must not care
  min: 100,
  max: 2_000,
  bins: [
    { lowerBound: 100, upperBound: 150, count: 7 },
    { lowerBound: 1_000, upperBound: 2_000, count: 1 },
  ],
};

describe('toHistogramChartData', () => {
  it('passes the summary bins through untouched, one bar per bin', () => {
    const data = toHistogramChartData(handMade);

    expect(data).toHaveLength(handMade.bins.length);
    expect(data.map((datum) => datum.amount)).toEqual([7, 1]);
    expect(data.reduce((sum, datum) => sum + datum.amount, 0)).toBe(8);
  });

  it('does not re-bin: a real 20-bin summary keeps exactly 20 bars', () => {
    const values = Array.from({ length: 40 }, (_, index) => index * 1_000);
    const histogram = buildHistogram(values);
    const data = toHistogramChartData(histogram);

    expect(histogram.bins).toHaveLength(MONTE_CARLO_HISTOGRAM_BINS);
    expect(data).toHaveLength(MONTE_CARLO_HISTOGRAM_BINS);
    // Counts are the summary's counts, not a recount of `values`.
    expect(data.map((datum) => datum.amount)).toEqual(histogram.bins.map((bin) => bin.count));
    expect(data.reduce((sum, datum) => sum + datum.amount, 0)).toBe(values.length);
  });

  it('labels each bar with its lower bound and the full bucket range', () => {
    const [first, second] = toHistogramChartData({ ...handMade, binWidth: 50 });

    expect(first.name).toBe('$100.0');
    // Below 1 000 the formatter honours the digit count; the compact `k` branch is fixed at one.
    expect(first.range).toBe('$100.00 – $150.00');
    expect(second.name).toBe('$1.0k');
    expect(second.range).toBe('$1.0k – $2.0k');
  });

  it('collapses a single-bin histogram to one value instead of a zero-width range', () => {
    const [only] = toHistogramChartData({
      binWidth: 0,
      min: 5_000,
      max: 5_000,
      bins: [{ lowerBound: 5_000, upperBound: 5_000, count: 500 }],
    });

    expect(only.range).toBe(formatCurrency(5_000));
    expect(only.amount).toBe(500);
  });

  it('returns nothing to plot for an empty histogram', () => {
    expect(toHistogramChartData({ binWidth: 0, min: 0, max: 0, bins: [] })).toEqual([]);
  });

  it('does not mutate the summary histogram', () => {
    const snapshot = structuredClone(handMade);

    toHistogramChartData(handMade);

    expect(handMade).toEqual(snapshot);
  });

  it('uses one shared bar colour for every bucket', () => {
    const colours = new Set(toHistogramChartData(handMade).map((datum) => datum.color));

    expect(colours).toEqual(new Set(['var(--chart-3)']));
  });
});
