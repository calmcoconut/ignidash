'use client';

import { BarChart, ResponsiveContainer } from 'recharts';

import { formatCompactCurrency } from '@/lib/utils/number-formatters';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChartTheme } from '@/hooks/use-chart-theme';
import type { SingleSimulationWithdrawalsChartDataPoint } from '@/lib/types/chart-data-points';
import { getMetricValueFormatter, resolveBarChart } from '@/lib/charts/metric-registry';
import { toBarChartData } from '@/lib/charts/plot-types';
import type { WithdrawalsDataView } from '@/lib/types/chart-data-views';

import {
  getBarChartTickConfig,
  ChartEmptyState,
  BarChartContainer,
  ChartGrid,
  BarChartXAxis,
  BarChartYAxis,
  StandardBar,
} from '../chart-primitives';

interface SingleSimulationWithdrawalsBarChartProps {
  age: number;
  dataView: WithdrawalsDataView;
  rawChartData: SingleSimulationWithdrawalsChartDataPoint[];
  customDataID: string;
}

export default function SingleSimulationWithdrawalsBarChart({
  age,
  dataView,
  rawChartData,
  customDataID,
}: SingleSimulationWithdrawalsBarChartProps) {
  const { foregroundMutedColor } = useChartTheme();
  const isSmallScreen = useIsMobile();

  const chartData = rawChartData.filter((item) => item.age === age);

  let formatter = (value: number) => formatCompactCurrency(value, 1);
  let transformedChartData: { name: string; amount: number; color: string }[] = [];

  // Views come from the metric registry (P4-P6): keys, colours, signs, labels, segment grouping,
  // the zero filter and the formatter are frozen by the registry tests. `custom` keeps its own
  // per-account series in the switch that remains below.
  const definition = resolveBarChart('withdrawals', dataView);
  if (definition) {
    transformedChartData = chartData.length > 0 ? toBarChartData(chartData[0], definition, { isSmallScreen }) : [];
    formatter = getMetricValueFormatter(definition.format);
  } else {
    switch (dataView) {
      case 'custom': {
        if (!customDataID) {
          console.warn('Custom data name is required for custom data view');
          break;
        }

        transformedChartData = chartData
          .flatMap(({ perAccountData }) => perAccountData)
          .filter(({ id }) => id === customDataID)
          .flatMap(({ name, withdrawals }) => [
            { name: `${name} — Stock Withdrawals`, amount: withdrawals.stocks, color: 'var(--chart-1)' },
            { name: `${name} — Bond Withdrawals`, amount: withdrawals.bonds, color: 'var(--chart-2)' },
            { name: `${name} — Cash Withdrawals`, amount: withdrawals.cash, color: 'var(--chart-3)' },
          ]);
        break;
      }
      case 'withdrawalRate':
        break;
    }
  }

  transformedChartData.sort((a, b) => b.amount - a.amount);
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
          <StandardBar data={transformedChartData} />
        </BarChart>
      </ResponsiveContainer>
    </BarChartContainer>
  );
}
