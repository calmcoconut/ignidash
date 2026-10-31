'use client';

import { useState, useCallback, memo, useMemo } from 'react';
import { ComposedChart, Tooltip, ReferenceLine } from 'recharts';
import { ChartLineIcon } from 'lucide-react';

import type { KeyMetrics } from '@/lib/types/key-metrics';
import { resolveDataView } from '@/lib/charts/metric-registry';
import { applySeriesSigns, resolveSeries, toAreaSeriesProps, toBarSeriesProps } from '@/lib/charts/plot-types';
import type { SingleSimulationNetWorthChartDataPoint } from '@/lib/types/chart-data-points';
import type { NetWorthDataView } from '@/lib/types/chart-data-views';
import type { AccountDataWithFlows } from '@/lib/calc/account';
import type { PhysicalAssetData } from '@/lib/calc/physical-assets';
import type { DebtData } from '@/lib/calc/debts';
import { formatChartString } from '@/lib/utils';
import { formatCompactCurrency, formatPercentage } from '@/lib/utils/number-formatters';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { useClickDetection } from '@/hooks/use-outside-click';
import { useChartDataSlice } from '@/hooks/use-chart-data-slice';
import { useChartInterval } from '@/hooks/use-chart-interval';
import type { SimulationEvent } from '@/lib/calc/data-extractors/annotations-extractor';
import { zeroAssetAmounts, type AssetAllocation } from '@/lib/calc/asset';

import {
  ChartEmptyState,
  TimeSeriesChartContainer,
  TooltipContainer,
  TooltipEntryRow,
  ChartGrid,
  TimeSeriesXAxis,
  TimeSeriesYAxis,
  AreaSeries,
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
    dataKey: keyof SingleSimulationNetWorthChartDataPoint | keyof AccountDataWithFlows | keyof PhysicalAssetData | keyof DebtData;
    payload:
      | SingleSimulationNetWorthChartDataPoint
      | ({ age: number; stockHoldings: number; bondHoldings: number; cashHoldings: number } & AccountDataWithFlows)
      | ({ age: number } & PhysicalAssetData)
      | ({ age: number } & DebtData);
  }>;
  label?: number;
  startAge: number;
  disabled: boolean;
  dataView: NetWorthDataView;
  customDataType: 'account' | 'asset' | 'debt' | undefined;
}

const CustomTooltip = memo(({ active, payload, label, startAge, disabled, dataView, customDataType }: CustomTooltipProps) => {
  if (!(active && payload && payload.length) || disabled) return null;

  const transformedPayload = payload.filter((entry) => entry.color !== LINE_COLOR);

  let body = null;
  let footer = null;
  switch (dataView) {
    case 'netPortfolioChange':
    case 'netWorth':
    case 'netWorthChange':
    case 'assetEquity':
    case 'netAssetChange':
    case 'netDebtReduction': {
      const lineData = payload.find((entry) => entry.dataKey === dataView);
      if (!lineData) {
        console.error(`${formatChartString(dataView)} data not found`);
        break;
      }

      body = (
        <div className="flex flex-col gap-1">
          {transformedPayload.map((entry) => (
            <TooltipEntryRow
              key={entry.dataKey}
              dataKey={entry.dataKey}
              color={entry.color}
              formattedValue={formatCompactCurrency(entry.value, 1)}
            />
          ))}
        </div>
      );

      footer = (
        <p className="mx-1 mt-2 flex justify-between text-sm font-semibold">
          <span className="flex items-center gap-1">
            <ChartLineIcon className="h-3 w-3" />
            <span className="mr-2">{`${formatChartString(dataView)}:`}</span>
          </span>
          <span className="ml-1 font-semibold">{formatCompactCurrency(lineData.value, 3)}</span>
        </p>
      );
      break;
    }
    case 'custom': {
      const total = transformedPayload.reduce((sum, item) => sum + item.value, 0);

      body = (
        <div className="flex flex-col gap-1">
          {transformedPayload.map((entry) => (
            <TooltipEntryRow
              key={entry.dataKey}
              dataKey={entry.dataKey}
              color={entry.color}
              formattedValue={formatCompactCurrency(entry.value, 1)}
            />
          ))}
        </div>
      );

      const footerConfig = {
        account: { title: 'Account Value', icon: null },
        asset: { title: 'Equity', icon: <ChartLineIcon className="h-3 w-3" /> },
        debt: { title: 'Debt Balance', icon: null },
      } as const;

      const { title: footerTitle, icon: footerIcon } = footerConfig[customDataType!];

      footer = (
        <p className="mx-1 mt-2 flex justify-between text-sm font-semibold">
          <span className="flex items-center gap-1">
            {footerIcon}
            <span className="mr-2">{footerTitle}:</span>
          </span>
          <span className="ml-1 font-semibold">{formatCompactCurrency(total, 3)}</span>
        </p>
      );
      break;
    }
    default: {
      const total = transformedPayload.reduce((sum, item) => sum + item.value, 0);

      body = (
        <div className="flex flex-col gap-1">
          {transformedPayload.map((entry) => (
            <TooltipEntryRow
              key={entry.dataKey}
              dataKey={entry.dataKey}
              color={entry.color}
              formattedValue={`${formatCompactCurrency(entry.value, 1)}${total > 0 ? ` (${formatPercentage(entry.value / total)})` : ''}`}
            />
          ))}
        </div>
      );

      footer = (
        <p className="mx-1 mt-2 flex justify-between text-sm font-semibold">
          <span className="mr-2">Total:</span>
          <span className="ml-1 font-semibold">{formatCompactCurrency(total, 3)}</span>
        </p>
      );
      break;
    }
  }

  return (
    <TooltipContainer label={label!} startAge={startAge} footer={footer}>
      {body}
    </TooltipContainer>
  );
});

CustomTooltip.displayName = 'CustomTooltip';

const LINE_COLOR = 'var(--foreground)';

interface SingleSimulationNetWorthAreaChartProps {
  rawChartData: SingleSimulationNetWorthChartDataPoint[];
  startAge: number;
  keyMetrics: KeyMetrics;
  showReferenceLines: boolean;
  dataView: NetWorthDataView;
  customDataID: string;
  onAgeSelect: (age: number) => void;
  selectedAge: number;
  /** Simulation events to mark (P4-P3); already derived by the card. */
  events?: readonly SimulationEvent[];
}

export default function SingleSimulationNetWorthAreaChart({
  rawChartData,
  startAge,
  keyMetrics,
  showReferenceLines,
  dataView,
  customDataID,
  onAgeSelect,
  selectedAge,
  events = [],
}: SingleSimulationNetWorthAreaChartProps) {
  const [clickedOutsideChart, setClickedOutsideChart] = useState(false);

  const { foregroundColor, foregroundMutedColor } = useChartTheme();
  const isSmallScreen = useIsMobile();

  const netWorthByAge = useMemo(() => new Map(rawChartData.map((dataPoint) => [dataPoint.age, dataPoint.netWorth])), [rawChartData]);

  const chartRef = useClickDetection<HTMLDivElement>(
    () => setClickedOutsideChart(true),
    () => setClickedOutsideChart(false)
  );

  let chartData:
    | SingleSimulationNetWorthChartDataPoint[]
    | Array<{ age: number; stockHoldings: number; bondHoldings: number; cashHoldings: number } & AccountDataWithFlows>
    | Array<{ age: number } & PhysicalAssetData>
    | Array<{ age: number } & DebtData> = useChartDataSlice(rawChartData, 'single');

  const areaDataKeys: string[] = [];
  const areaColors: string[] = [];

  const lineDataKeys: string[] = [];

  const barDataKeys: string[] = [];
  const barColors: string[] = [];

  const formatter = (value: number) => formatCompactCurrency(value, 1);
  let stackOffset: 'sign' | undefined = undefined;

  let customDataType: 'account' | 'asset' | 'debt' | undefined = undefined;

  // Series come from the metric registry (P4-P6); keys, colours, plots, signs and stack ids are
  // the ones this chart's deleted switch used, frozen by the registry tests. The `custom` branch
  // below still builds per-account/per-asset/per-debt series: that escape hatch stays bespoke.
  const resolution = resolveDataView('netWorth', dataView);
  const metric = resolution.status === 'registry' ? resolution.metric : undefined;
  const resolvedSeries = metric ? resolveSeries(metric, 'line') : [];

  if (metric) {
    const areaProps = toAreaSeriesProps(resolvedSeries);
    const barProps = toBarSeriesProps(resolvedSeries);

    stackOffset = metric.stackOffset;

    areaDataKeys.push(...areaProps.dataKeys);
    areaColors.push(...areaProps.areaColors);
    lineDataKeys.push(...resolvedSeries.filter((series) => series.plot === 'line').map((series) => series.key));
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

        const perAccountData = chartData.flatMap(({ age, perAccountData }) =>
          perAccountData
            .filter((account) => account.id === customDataID)
            .map((account) => {
              const balance = account.balance;

              const assetAllocation = account.assetAllocation ?? zeroAssetAmounts<AssetAllocation>();

              return {
                age,
                ...account,
                stockHoldings: balance * assetAllocation.stocks,
                bondHoldings: balance * assetAllocation.bonds,
                cashHoldings: balance * assetAllocation.cash,
              };
            })
        );
        if (perAccountData.length > 0) {
          customDataType = 'account';

          areaDataKeys.push('stockHoldings', 'bondHoldings', 'cashHoldings');
          areaColors.push('var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)');

          chartData = perAccountData;
          break;
        }

        const perAssetData = chartData.flatMap(({ age, perAssetData }) =>
          perAssetData.filter((asset) => asset.id === customDataID).map((asset) => ({ age, ...asset, loanBalance: -asset.loanBalance }))
        );
        if (perAssetData.length > 0) {
          customDataType = 'asset';

          lineDataKeys.push('equity');

          barDataKeys.push('marketValue', 'loanBalance');
          barColors.push('var(--chart-1)', 'var(--chart-2)');

          chartData = perAssetData;

          stackOffset = 'sign';
          break;
        }

        const perDebtData = chartData.flatMap(({ age, perDebtData }) =>
          perDebtData.filter((debt) => debt.id === customDataID).map((debt) => ({ age, ...debt }))
        );
        if (perDebtData.length > 0) {
          customDataType = 'debt';

          areaDataKeys.push('balance');
          areaColors.push('var(--chart-1)');

          chartData = perDebtData;
          break;
        }

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

  const allDataKeys = [...areaDataKeys, ...lineDataKeys, ...barDataKeys];
  // SAFETY: `allDataKeys` holds registry series keys, which name fields of the plotted rows
  // (the custom branch's keys name fields of the per-account/asset/debt rows it builds).
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
        <AreaSeries dataKeys={areaDataKeys} areaColors={areaColors} stackId="areaStack" />
        <LineSeries dataKeys={lineDataKeys} strokeColors={[LINE_COLOR]} />
        <BarSeries dataKeys={barDataKeys} barColors={barColors} stackId="barStack" />
        <Tooltip
          content={
            <CustomTooltip
              startAge={startAge}
              disabled={isSmallScreen && clickedOutsideChart}
              dataView={dataView}
              customDataType={customDataType}
            />
          }
          cursor={{ stroke: foregroundColor }}
        />
        <AgeReferenceLines keyMetrics={keyMetrics} showReferenceLines={showReferenceLines} selectedAge={selectedAge} />
        {/* Dots for asset purchases/sales sit on the net worth curve itself. */}
        <EventAnnotations events={events} showReferenceLines={showReferenceLines} getY={(age) => netWorthByAge.get(age)} />
        {keyMetrics.portfolioAtRetirement && showReferenceLines && ['assetClass', 'taxCategory'].includes(dataView) && (
          <ReferenceLine y={Math.round(keyMetrics.portfolioAtRetirement)} stroke={foregroundMutedColor} strokeDasharray="10 5" />
        )}
      </ComposedChart>
    </TimeSeriesChartContainer>
  );
}
