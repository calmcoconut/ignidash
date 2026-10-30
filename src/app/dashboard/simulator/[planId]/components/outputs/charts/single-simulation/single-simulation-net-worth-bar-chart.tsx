'use client';

import { BarChart, ReferenceLine, ResponsiveContainer } from 'recharts';

import { useIsMobile } from '@/hooks/use-mobile';
import { useChartTheme } from '@/hooks/use-chart-theme';
import type { SingleSimulationNetWorthChartDataPoint } from '@/lib/types/chart-data-points';
import { getMetricValueFormatter, resolveBarChart } from '@/lib/charts/metric-registry';
import { toBarChartData } from '@/lib/charts/plot-types';

import {
  getBarChartTickConfig,
  ChartEmptyState,
  BarChartContainer,
  ChartGrid,
  BarChartXAxis,
  BarChartYAxis,
  StandardBar,
} from '../chart-primitives';

interface SingleSimulationNetWorthBarChartProps {
  age: number;
  dataView: 'netPortfolioChange' | 'netAssetChange' | 'netDebtReduction' | 'netWorthChange';
  rawChartData: SingleSimulationNetWorthChartDataPoint[];
}

export default function SingleSimulationNetWorthBarChart({ age, dataView, rawChartData }: SingleSimulationNetWorthBarChartProps) {
  const { foregroundColor, foregroundMutedColor } = useChartTheme();
  const isSmallScreen = useIsMobile();

  // The four change views come from the registry (P4-P6): keys, colours, signs, labels and the
  // formatter are frozen by the registry tests. This chart has no `custom` view, so there is no
  // escape hatch to keep.
  const definition = resolveBarChart('netWorth', dataView);
  const chartData = rawChartData.filter((item) => item.age === age);
  const transformedChartData = definition && chartData.length > 0 ? toBarChartData(chartData[0], definition, { isSmallScreen }) : [];
  const formatter = getMetricValueFormatter(definition?.format);

  if (transformedChartData.length === 0) {
    return <ChartEmptyState />;
  }

  const { tick, bottomMargin } = getBarChartTickConfig(transformedChartData.length, isSmallScreen, foregroundMutedColor);

  return (
    <BarChartContainer>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={transformedChartData}
          className="text-xs"
          margin={{ top: 5, right: 10, left: 10, bottom: bottomMargin }}
          tabIndex={-1}
        >
          <ChartGrid />
          <BarChartXAxis tick={tick} />
          <BarChartYAxis formatter={formatter} />
          <ReferenceLine y={0} stroke={foregroundColor} strokeWidth={1} ifOverflow="extendDomain" />
          <StandardBar data={transformedChartData} />
        </BarChart>
      </ResponsiveContainer>
    </BarChartContainer>
  );
}
