'use client';

import { useState, useCallback, memo } from 'react';
import { ComposedChart, Tooltip } from 'recharts';
import { ChartLineIcon } from 'lucide-react';

import { formatCompactCurrency, formatPercentage } from '@/lib/utils/number-formatters';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { useClickDetection } from '@/hooks/use-outside-click';
import { useChartDataSlice } from '@/hooks/use-chart-data-slice';
import { useChartInterval } from '@/hooks/use-chart-interval';
import type { SingleSimulationCashFlowChartDataPoint } from '@/lib/types/chart-data-points';
import type { CashFlowDataView } from '@/lib/types/chart-data-views';
import type { IncomeData } from '@/lib/calc/incomes';
import type { ExpenseData } from '@/lib/calc/expenses';
import type { PhysicalAssetData } from '@/lib/calc/physical-assets';
import type { DebtData } from '@/lib/calc/debts';
import type { KeyMetrics } from '@/lib/types/key-metrics';
import type { SimulationEvent } from '@/lib/calc/data-extractors/annotations-extractor';

import { getMetricValueFormatter, resolveDataView } from '@/lib/charts/metric-registry';
import { applySeriesSigns, resolveSeries, toBarSeriesProps, toLineSeriesProps } from '@/lib/charts/plot-types';
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
  SignReferenceLine,
  AgeReferenceLines,
  EventAnnotations,
} from '../chart-primitives';

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    value: number;
    name: string;
    color: string;
    dataKey: keyof SingleSimulationCashFlowChartDataPoint | keyof IncomeData | keyof ExpenseData | keyof PhysicalAssetData | keyof DebtData;
    payload:
      | SingleSimulationCashFlowChartDataPoint
      | ({ age: number } & IncomeData)
      | ({ age: number } & ExpenseData)
      | ({ age: number } & PhysicalAssetData)
      | ({ age: number } & DebtData);
  }>;
  label?: number;
  startAge: number;
  disabled: boolean;
  dataView: CashFlowDataView;
}

const CustomTooltip = memo(({ active, payload, label, startAge, disabled, dataView }: CustomTooltipProps) => {
  if (!(active && payload && payload.length) || disabled) return null;

  const formatValue = (value: number) => {
    return dataView === 'savingsRate' ? formatPercentage(value) : formatCompactCurrency(value, 1);
  };

  const transformedPayload = payload.filter((entry) => entry.color !== LINE_COLOR);

  let footer = null;
  switch (dataView) {
    case 'surplusDeficit':
      const surplusDeficit = payload.find((entry) => entry.dataKey === 'surplusDeficit');
      if (!surplusDeficit) {
        console.error('Surplus/deficit data not found');
        break;
      }

      footer = (
        <p className="mx-1 mt-2 flex justify-between text-sm font-semibold">
          <span className="flex items-center gap-1">
            <ChartLineIcon className="h-3 w-3" />
            <span className="mr-2">Surplus/Deficit:</span>
          </span>
          <span className="ml-1 font-semibold">{formatCompactCurrency(surplusDeficit.value, 3)}</span>
        </p>
      );
      break;
    case 'cashFlow':
      const netCashFlow = payload.find((entry) => entry.dataKey === 'netCashFlow');
      if (!netCashFlow) {
        console.error('Net cash flow data not found');
        break;
      }

      footer = (
        <p className="mx-1 mt-2 flex justify-between text-sm font-semibold">
          <span className="flex items-center gap-1">
            <ChartLineIcon className="h-3 w-3" />
            <span className="mr-2">Net Cash Flow:</span>
          </span>
          <span className="ml-1 font-semibold">{formatCompactCurrency(netCashFlow.value, 3)}</span>
        </p>
      );
      break;
    case 'incomes':
    case 'expenses':
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
    case 'custom':
    case 'savingsRate':
      break;
  }

  return (
    <TooltipContainer label={label!} startAge={startAge} footer={footer}>
      <div className="flex flex-col gap-1">
        {transformedPayload
          .filter((entry) => entry.value !== 0)
          .map((entry) => (
            <TooltipEntryRow key={entry.dataKey} dataKey={entry.dataKey} color={entry.color} formattedValue={formatValue(entry.value)} />
          ))}
      </div>
    </TooltipContainer>
  );
});

CustomTooltip.displayName = 'CustomTooltip';

const LINE_COLOR = 'var(--foreground)';

interface SingleSimulationCashFlowLineChartProps {
  rawChartData: SingleSimulationCashFlowChartDataPoint[];
  startAge: number;
  keyMetrics: KeyMetrics;
  showReferenceLines: boolean;
  onAgeSelect: (age: number) => void;
  selectedAge: number;
  dataView: CashFlowDataView;
  customDataID?: string;
  /** Simulation events to mark (P4-P3); already derived by the card. */
  events?: readonly SimulationEvent[];
}

export default function SingleSimulationCashFlowLineChart({
  rawChartData,
  startAge,
  keyMetrics,
  showReferenceLines,
  onAgeSelect,
  selectedAge,
  dataView,
  customDataID,
  events = [],
}: SingleSimulationCashFlowLineChartProps) {
  const [clickedOutsideChart, setClickedOutsideChart] = useState(false);

  const { foregroundColor } = useChartTheme();
  const isSmallScreen = useIsMobile();

  const chartRef = useClickDetection<HTMLDivElement>(
    () => setClickedOutsideChart(true),
    () => setClickedOutsideChart(false)
  );

  const chartSlice = useChartDataSlice(rawChartData, 'single');

  let chartData:
    | SingleSimulationCashFlowChartDataPoint[]
    | Array<{ age: number } & IncomeData>
    | Array<{ age: number } & ExpenseData>
    | Array<{ age: number } & PhysicalAssetData>
    | Array<{ age: number } & DebtData> = chartSlice;

  // Ported views render from the metric registry. `custom` is deliberately not a
  // registry metric: it derives its series from per-entity data, so that escape hatch
  // keeps its bespoke switch below, exactly as before.
  const resolution = resolveDataView('cashFlow', dataView);
  const metric = resolution.status === 'registry' ? resolution.metric : undefined;
  const resolvedSeries = metric ? resolveSeries(metric, 'line') : [];

  const lineProps = toLineSeriesProps(resolvedSeries);
  const barProps = toBarSeriesProps(resolvedSeries);

  const lineDataKeys: string[] = [...lineProps.dataKeys];
  const strokeColors: string[] = [...lineProps.strokeColors];

  const barDataKeys: string[] = [...barProps.dataKeys];
  const barColors: string[] = [...barProps.barColors];

  let formatter = metric ? getMetricValueFormatter(metric.format) : undefined;
  const stackOffset: 'sign' | undefined = metric?.stackOffset;

  if (metric) {
    chartData = applySeriesSigns(chartData, resolvedSeries);
  } else if (dataView === 'custom') {
    formatter = (value: number) => formatCompactCurrency(value, 1);

    if (!customDataID) {
      console.warn('Custom data name is required for custom data view');
    } else {
      const perIncomeData = chartData.flatMap(({ age, perIncomeData }) =>
        perIncomeData.filter((income) => income.id === customDataID && income.income !== 0).map((income) => ({ age, ...income }))
      );
      if (perIncomeData.length > 0) {
        lineDataKeys.push('income');
        strokeColors.push('var(--chart-2)');

        chartData = perIncomeData;
      } else {
        const perExpenseData = chartData.flatMap(({ age, perExpenseData }) =>
          perExpenseData.filter((expense) => expense.id === customDataID && expense.expense !== 0).map((expense) => ({ age, ...expense }))
        );
        if (perExpenseData.length > 0) {
          lineDataKeys.push('expense');
          strokeColors.push('var(--chart-4)');

          chartData = perExpenseData;
        } else {
          const perAssetData = chartData.flatMap(({ age, perAssetData }) =>
            perAssetData.filter((asset) => asset.id === customDataID && asset.loanPayment !== 0).map((asset) => ({ age, ...asset }))
          );
          if (perAssetData.length > 0) {
            lineDataKeys.push('loanPayment');
            strokeColors.push('var(--chart-8)');

            chartData = perAssetData;
          } else {
            const perDebtData = chartData.flatMap(({ age, perDebtData }) =>
              perDebtData.filter((debt) => debt.id === customDataID && debt.payment !== 0).map((debt) => ({ age, ...debt }))
            );
            if (perDebtData.length > 0) {
              lineDataKeys.push('payment');
              strokeColors.push('var(--chart-5)');

              chartData = perDebtData;
            }
          }
        }
      }
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
        stackOffset={stackOffset}
        margin={{ top: 5, right: 10, left: 10, bottom: 0 }}
        tabIndex={-1}
        onClick={onClick}
      >
        <ChartGrid />
        <TimeSeriesXAxis interval={interval} />
        <TimeSeriesYAxis formatter={formatter} />
        {stackOffset === 'sign' && <SignReferenceLine />}
        <LineSeries dataKeys={lineDataKeys} strokeColors={strokeColors} />
        <BarSeries dataKeys={barDataKeys} barColors={barColors} stackId="barStack" />
        <Tooltip
          content={<CustomTooltip startAge={startAge} disabled={isSmallScreen && clickedOutsideChart} dataView={dataView} />}
          cursor={{ stroke: foregroundColor }}
        />
        <AgeReferenceLines keyMetrics={keyMetrics} showReferenceLines={showReferenceLines} selectedAge={selectedAge} />
        <EventAnnotations events={events} showReferenceLines={showReferenceLines} />
      </ComposedChart>
    </TimeSeriesChartContainer>
  );
}
