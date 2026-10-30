'use client';

import { BarChart, ResponsiveContainer, Tooltip } from 'recharts';

import { formatCurrency } from '@/lib/utils/number-formatters';
import { toHistogramChartData, type HistogramChartDatum } from '@/lib/utils/histogram-chart-data';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChartTheme } from '@/hooks/use-chart-theme';
import type { MonteCarloHistogram } from '@/lib/calc/monte-carlo';

import {
  getBarChartTickConfig,
  ChartEmptyState,
  BarChartContainer,
  ChartGrid,
  BarChartXAxis,
  BarChartYAxis,
  StandardBar,
} from '../chart-primitives';

function HistogramTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: HistogramChartDatum }> }) {
  if (!active || !payload || payload.length === 0) return null;

  const datum = payload[0].payload;

  return (
    <div className="text-foreground bg-background rounded-lg border p-2 text-sm shadow-md">
      <p className="font-semibold">{datum.range}</p>
      <p className="text-muted-foreground">{`${datum.amount} ${datum.amount === 1 ? 'trial' : 'trials'}`}</p>
    </div>
  );
}

interface MultiSimulationHistogramBarChartProps {
  /** Bins and bounds as the Monte Carlo summary computed them; never recomputed here. */
  histogram: MonteCarloHistogram;
  /** Trials in the run, for the caption and the "% of trials" reading. */
  trials: number;
}

/**
 * Distribution of final portfolio values across the Monte Carlo trials.
 *
 * The bins arrive pre-computed on the summary (P2-P3), so this component only maps them to
 * bars: no trial results are read, no binning happens here, and the same chart works when the
 * run was aggregated with `retention: 'summary'` and no per-trial result exists at all.
 */
export default function MultiSimulationHistogramBarChart({ histogram, trials }: MultiSimulationHistogramBarChartProps) {
  const { foregroundMutedColor } = useChartTheme();
  const isSmallScreen = useIsMobile();

  if (histogram.bins.length === 0) {
    return <ChartEmptyState message="No finished trials to plot yet." />;
  }

  const chartData = toHistogramChartData(histogram);

  const { tick, bottomMargin } = getBarChartTickConfig(chartData.length, isSmallScreen, foregroundMutedColor);

  return (
    <>
      <BarChartContainer>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} className="text-xs" margin={{ top: 5, right: 10, left: 10, bottom: bottomMargin }} tabIndex={-1}>
            <ChartGrid />
            <BarChartXAxis tick={tick} />
            <BarChartYAxis formatter={(value: number) => `${value}`} />
            <StandardBar data={chartData} formatValue={(value: number) => `${value}`} />
            <Tooltip content={<HistogramTooltip />} cursor={{ fill: 'var(--emphasized-background)' }} />
          </BarChart>
        </ResponsiveContainer>
      </BarChartContainer>
      <p className="text-muted-foreground mt-1 text-xs">
        {`Final portfolio after the last simulated year: ${formatCurrency(histogram.min)} to ${formatCurrency(histogram.max)} across ${trials} trials.`}
      </p>
    </>
  );
}
