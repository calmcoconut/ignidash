'use client';

import { useState, useCallback, memo } from 'react';
import { ComposedChart, Tooltip } from 'recharts';

import { formatCompactCurrency } from '@/lib/utils/number-formatters';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { useClickDetection } from '@/hooks/use-outside-click';
import { useChartDataSlice } from '@/hooks/use-chart-data-slice';
import { useChartInterval } from '@/hooks/use-chart-interval';
import type { SingleSimulationContributionsChartDataPoint } from '@/lib/types/chart-data-points';
import type { ContributionsDataView } from '@/lib/types/chart-data-views';
import type { AccountDataWithFlows } from '@/lib/calc/account';
import type { KeyMetrics } from '@/lib/types/key-metrics';
import { resolveDataView } from '@/lib/charts/metric-registry';
import { applySeriesSigns, resolveSeries, toBarSeriesProps } from '@/lib/charts/plot-types';

import {
  ChartEmptyState,
  TimeSeriesChartContainer,
  TooltipContainer,
  TooltipEntryRow,
  ChartGrid,
  TimeSeriesXAxis,
  TimeSeriesYAxis,
  LineSeries,
  BarSeries,
  AgeReferenceLines,
} from '../chart-primitives';

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    value: number;
    name: string;
    color: string;
    dataKey: keyof SingleSimulationContributionsChartDataPoint;
    payload:
      | SingleSimulationContributionsChartDataPoint
      | ({
          age: number;
          annualStockContributions: number;
          annualBondContributions: number;
          annualCashContributions: number;
        } & AccountDataWithFlows);
  }>;
  label?: number;
  startAge: number;
  disabled: boolean;
  dataView: ContributionsDataView;
}

const CustomTooltip = memo(({ active, payload, label, startAge, disabled, dataView }: CustomTooltipProps) => {
  if (!(active && payload && payload.length) || disabled) return null;

  let footer = null;
  switch (dataView) {
    case 'annualAmounts':
    case 'cumulativeAmounts':
    case 'taxCategory':
    case 'custom':
      footer = (
        <p className="mx-1 mt-2 flex justify-between text-sm font-semibold">
          <span className="mr-2">Total:</span>
          <span className="ml-1 font-semibold">
            {formatCompactCurrency(
              payload.reduce((sum, item) => sum + item.value, 0),
              3
            )}
          </span>
        </p>
      );
      break;
    default:
      break;
  }

  const filterZeroValues = !['employerMatch', 'shortfall'].includes(dataView);

  return (
    <TooltipContainer label={label!} startAge={startAge} footer={footer}>
      <div className="flex flex-col gap-1">
        {payload
          .filter((entry) => (filterZeroValues ? entry.value !== 0 : true))
          .map((entry) => (
            <TooltipEntryRow
              key={entry.dataKey}
              dataKey={entry.dataKey}
              color={entry.color}
              formattedValue={formatCompactCurrency(entry.value, 1)}
            />
          ))}
      </div>
    </TooltipContainer>
  );
});

CustomTooltip.displayName = 'CustomTooltip';

interface SingleSimulationContributionsLineChartProps {
  rawChartData: SingleSimulationContributionsChartDataPoint[];
  keyMetrics: KeyMetrics;
  showReferenceLines: boolean;
  onAgeSelect: (age: number) => void;
  selectedAge: number;
  dataView: ContributionsDataView;
  customDataID: string;
  startAge: number;
}

export default function SingleSimulationContributionsLineChart({
  rawChartData,
  keyMetrics,
  showReferenceLines,
  onAgeSelect,
  selectedAge,
  dataView,
  customDataID,
  startAge,
}: SingleSimulationContributionsLineChartProps) {
  const [clickedOutsideChart, setClickedOutsideChart] = useState(false);

  const { foregroundColor } = useChartTheme();
  const isSmallScreen = useIsMobile();

  const chartRef = useClickDetection<HTMLDivElement>(
    () => setClickedOutsideChart(true),
    () => setClickedOutsideChart(false)
  );

  let chartData:
    | SingleSimulationContributionsChartDataPoint[]
    | Array<
        {
          age: number;
          annualStockContributions: number;
          annualBondContributions: number;
          annualCashContributions: number;
        } & AccountDataWithFlows
      > = useChartDataSlice(rawChartData, 'single');

  const lineDataKeys: string[] = [];
  const strokeColors: string[] = [];

  const barDataKeys: string[] = [];
  const barColors: string[] = [];

  const formatter = (value: number) => formatCompactCurrency(value, 1);
  let stackId: string | undefined = undefined;

  // Series come from the metric registry (P4-P6); keys, colours, plots and stack ids are the
  // ones this chart's deleted switch used, frozen by the registry tests. `custom` keeps its own
  // per-account series in the switch's remaining case below.
  const resolution = resolveDataView('contributions', dataView);
  const metric = resolution.status === 'registry' ? resolution.metric : undefined;
  const resolvedSeries = metric ? resolveSeries(metric, 'line') : [];

  if (metric) {
    const barProps = toBarSeriesProps(resolvedSeries);

    stackId = barProps.stackId;

    barDataKeys.push(...barProps.dataKeys);
    barColors.push(...barProps.barColors);

    chartData = applySeriesSigns(chartData, resolvedSeries);
  } else {
    switch (dataView) {
      case 'custom':
        if (!customDataID) {
          console.warn('Custom data name is required for custom data view');
          break;
        }

        stackId = 'barStack';

        chartData = chartData.flatMap(({ age, perAccountData }) =>
          perAccountData
            .filter((account) => account.id === customDataID)
            .map((account) => ({
              age,
              ...account,
              annualStockContributions: account.contributions.stocks,
              annualBondContributions: account.contributions.bonds,
              annualCashContributions: account.contributions.cash,
            }))
        );

        barDataKeys.push('annualStockContributions', 'annualBondContributions', 'annualCashContributions');
        barColors.push('var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)');
        break;
    }
  }

  const interval = useChartInterval(chartData.length);

  const onClick = useCallback(
    (data: { activeLabel: string | number | undefined }) => {
      if (data.activeLabel !== undefined && onAgeSelect) {
        onAgeSelect(Number(data.activeLabel));
      }
    },
    [onAgeSelect]
  );

  const allDataKeys = [...lineDataKeys, ...barDataKeys];
  // SAFETY: `allDataKeys` holds registry series keys, which name fields of the plotted rows
  // (the custom branch's keys name fields of the per-account rows it builds).
  const hasNoData =
    chartData.length === 0 ||
    chartData.every((point) => allDataKeys.every((key) => (point as unknown as Record<string, unknown>)[key] === 0));
  if (hasNoData) {
    return <ChartEmptyState />;
  }

  return (
    <TimeSeriesChartContainer ref={chartRef}>
      <ComposedChart
        responsive
        width="100%"
        height="100%"
        data={chartData}
        className="text-xs"
        margin={{ top: 5, right: 10, left: 10, bottom: 0 }}
        tabIndex={-1}
        onClick={onClick}
      >
        <ChartGrid />
        <TimeSeriesXAxis interval={interval} />
        <TimeSeriesYAxis formatter={formatter} />
        <LineSeries dataKeys={lineDataKeys} strokeColors={strokeColors} />
        <BarSeries dataKeys={barDataKeys} barColors={barColors} stackId={stackId} />
        <Tooltip
          content={<CustomTooltip startAge={startAge} disabled={isSmallScreen && clickedOutsideChart} dataView={dataView} />}
          cursor={{ stroke: foregroundColor }}
        />
        <AgeReferenceLines keyMetrics={keyMetrics} showReferenceLines={showReferenceLines} selectedAge={selectedAge} />
      </ComposedChart>
    </TimeSeriesChartContainer>
  );
}
