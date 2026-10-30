/**
 * Mapping from the Monte Carlo summary's histogram to chart rows.
 *
 * The bins are computed once, in the summary (P2-P3). This module only re-labels them for a
 * bar chart: it never re-bins, never reads trial results, and preserves the counts exactly as
 * the summary reported them. Keeping it pure and separate is what makes "the histogram chart
 * reads the summary, not the full results" a testable claim rather than a comment.
 */

import { formatCompactCurrency, formatCurrency } from '@/lib/utils/number-formatters';
import type { MonteCarloHistogram } from '@/lib/calc/monte-carlo';

/** One bar of the histogram. */
export interface HistogramChartDatum {
  /** Bin lower bound, used as the (rotated) axis label. */
  name: string;
  /** Trials that landed in the bin, as counted by the summary. */
  amount: number;
  /** Full bucket range, shown in the tooltip. */
  range: string;
  color: string;
}

/** Bars share the app's chart palette; the third slot reads well in both themes. */
const HISTOGRAM_BAR_COLOR = 'var(--chart-3)';

/**
 * Turns summary bins into chart rows, one bar per bin, in bin order.
 *
 * @param histogram - Histogram from `MonteCarloSummary`
 * @returns One datum per bin; empty when there is nothing to plot
 */
export function toHistogramChartData(histogram: MonteCarloHistogram): HistogramChartDatum[] {
  return histogram.bins.map((bin) => ({
    name: formatCompactCurrency(bin.lowerBound, 1),
    amount: bin.count,
    // A single collapsed bin has no width, so a range would read "$1,000 – $1,000".
    range:
      histogram.binWidth === 0
        ? formatCurrency(bin.lowerBound)
        : `${formatCompactCurrency(bin.lowerBound, 2)} – ${formatCompactCurrency(bin.upperBound, 2)}`,
    color: HISTOGRAM_BAR_COLOR,
  }));
}
