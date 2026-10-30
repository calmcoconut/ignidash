'use client';

import { BarChart, ReferenceLine, ResponsiveContainer } from 'recharts';

import { formatCompactCurrency, formatPercentage } from '@/lib/utils/number-formatters';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChartTheme } from '@/hooks/use-chart-theme';
import type { SingleSimulationReturnsChartDataPoint } from '@/lib/types/chart-data-points';
import { getMetricValueFormatter, resolveBarChart } from '@/lib/charts/metric-registry';
import { toBarChartData } from '@/lib/charts/plot-types';
import type { ReturnsDataView } from '@/lib/types/chart-data-views';

import {
  getBarChartTickConfig,
  ChartEmptyState,
  BarChartContainer,
  ChartGrid,
  BarChartXAxis,
  BarChartYAxis,
  StandardBar,
} from '../chart-primitives';

const getReturnsLabelFormatter = (dataView: ReturnsDataView) => {
  return (value: number) => {
    switch (dataView) {
      case 'rates':
      case 'cagr':
        return formatPercentage(value);
      case 'annualAmounts':
      case 'cumulativeAmounts':
      case 'taxCategory':
      case 'appreciation':
      case 'custom':
        return formatCompactCurrency(value, 1);
    }
  };
};

interface SingleSimulationReturnsBarChartProps {
  age: number;
  dataView: ReturnsDataView;
  rawChartData: SingleSimulationReturnsChartDataPoint[];
  customDataID: string;
}

export default function SingleSimulationReturnsBarChart({
  age,
  dataView,
  rawChartData,
  customDataID,
}: SingleSimulationReturnsBarChartProps) {
  const { foregroundColor, foregroundMutedColor } = useChartTheme();
  const isSmallScreen = useIsMobile();

  const labelConfig: Record<string, { mobile: string[]; desktop: string[] }> = {
    rates: {
      mobile: ['Stock Rate', 'Bond Rate', 'Cash Rate', 'Inflation Rate'],
      desktop: ['Real Stock Rate', 'Real Bond Rate', 'Real Cash Rate', 'Inflation Rate'],
    },
    cagr: {
      mobile: ['Stock CAGR', 'Bond CAGR', 'Cash CAGR'],
      desktop: ['Real Stock CAGR', 'Real Bond CAGR', 'Real Cash CAGR'],
    },
    annualAmounts: {
      mobile: ['Stock Gain', 'Bond Gain', 'Cash Gain'],
      desktop: ['Annual Stock Gain', 'Annual Bond Gain', 'Annual Cash Gain'],
    },
    cumulativeAmounts: {
      mobile: ['Cumul. Stock', 'Cumul. Bond', 'Cumul. Cash'],
      desktop: ['Cumul. Stock Gain', 'Cumul. Bond Gain', 'Cumul. Cash Gain'],
    },
    taxCategory: {
      mobile: ['Taxable', 'Tax-Deferred', 'Tax-Free', 'Cash'],
      desktop: ['Taxable Gains', 'Tax-Deferred Gains', 'Tax-Free Gains', 'Cash Gains'],
    },
    custom: {
      mobile: ['Stock Gain', 'Bond Gain', 'Cash Gain'],
      desktop: ['Annual Stock Gain', 'Annual Bond Gain', 'Annual Cash Gain'],
    },
  };

  const getLabelsForScreenSize = (dataView: keyof typeof labelConfig, isSmallScreen: boolean) => {
    return labelConfig[dataView][isSmallScreen ? 'mobile' : 'desktop'];
  };

  const chartData = rawChartData.filter((item) => item.age === age);

  let showReferenceLineAtZero = true;
  let formatter = undefined;
  let transformedChartData: { name: string; amount: number; color: string }[] = [];

  // Views come from the metric registry (P4-P6): keys, colours, signs, labels, segment grouping,
  // the zero filter and the formatter are frozen by the registry tests. `custom` keeps its own
  // per-account series in the switch that remains below.
  const definition = resolveBarChart('returns', dataView);
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

        formatter = (value: number) => formatCompactCurrency(value, 1);

        const perAccountData = chartData.flatMap(({ perAccountData }) => perAccountData).filter(({ id }) => id === customDataID);
        if (perAccountData.length > 0) {
          const [stockLabel, bondLabel, cashLabel] = getLabelsForScreenSize(dataView, isSmallScreen);
          transformedChartData = perAccountData.flatMap(({ returnAmounts }) => [
            { name: stockLabel, amount: returnAmounts.stocks, color: 'var(--chart-2)' },
            { name: bondLabel, amount: returnAmounts.bonds, color: 'var(--chart-3)' },
            { name: cashLabel, amount: returnAmounts.cash, color: 'var(--chart-4)' },
          ]);
          break;
        }

        const perAssetData = chartData.flatMap(({ perAssetData }) => perAssetData).filter(({ id }) => id === customDataID);
        if (perAssetData.length > 0) {
          transformedChartData = perAssetData.map(({ name, appreciation }) => ({ name, amount: appreciation, color: 'var(--chart-2)' }));
          showReferenceLineAtZero = false;
          break;
        }

        break;
      }
    }
  }

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
          {showReferenceLineAtZero && <ReferenceLine y={0} stroke={foregroundColor} strokeWidth={1} ifOverflow="extendDomain" />}
          <StandardBar data={transformedChartData} formatValue={getReturnsLabelFormatter(dataView)} />
        </BarChart>
      </ResponsiveContainer>
    </BarChartContainer>
  );
}
