'use client';

import { BarChart, Bar, ResponsiveContainer, Cell, ReferenceLine, LabelList } from 'recharts';

import { formatCompactCurrency, formatPercentage } from '@/lib/utils/number-formatters';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { getRules } from '@/lib/calc/tax-data';
import type { CapitalGainsTaxBracket, FederalIncomeTaxBracket } from '@/lib/calc/tax-data/types';
import type { SingleSimulationTaxesChartDataPoint } from '@/lib/types/chart-data-points';
import { getMetricValueFormatter, resolveBarChart } from '@/lib/charts/metric-registry';
import { toCategoricalBars } from '@/lib/charts/plot-types';
import type { TaxesDataView } from '@/lib/types/chart-data-views';
import type { TaxableIncomeReferenceLineMode, AgiReferenceLineMode } from '@/lib/types/reference-line-modes';

import {
  CustomLabelListContent,
  getBarChartTickConfig,
  ChartEmptyState,
  BarChartContainer,
  ChartGrid,
  BarChartXAxis,
  BarChartYAxis,
} from '../chart-primitives';

/**
 * The §1411 rate for the reference line's label.
 *
 * Unlike the base amount the line sits on, the rate is dimensionless and statute-locked at 3.8%,
 * and the ruleset's `dollarFields` for the table deliberately excludes it — so it is the rate in
 * every year a chart can plot, and the reference year it is read from cannot change it. The
 * *threshold* comes from the data point, because that one does move (it is not CPI-indexed).
 */
const NIIT_RATE = getRules(2026).tables.netInvestmentIncomeTax.values.rate;

const getTaxBrackets = (
  chartData: SingleSimulationTaxesChartDataPoint[]
): {
  federalIncomeTaxBrackets: FederalIncomeTaxBracket[] | null;
  capitalGainsTaxBrackets: CapitalGainsTaxBracket[] | null;
} => ({
  federalIncomeTaxBrackets: chartData[0]?.federalIncomeTaxBrackets ?? null,
  capitalGainsTaxBrackets: chartData[0]?.capitalGainsTaxBrackets ?? null,
});

const renderTaxBracketReferenceLines = (
  taxBrackets: FederalIncomeTaxBracket[] | CapitalGainsTaxBracket[],
  taxableIncome: number,
  foregroundColor: string,
  foregroundMutedColor: string
) => {
  const nextBracketIndex = taxBrackets.findIndex((bracket) => bracket.min > taxableIncome);
  const visibleBrackets = nextBracketIndex === -1 ? taxBrackets : taxBrackets.slice(0, nextBracketIndex + 1);

  return visibleBrackets.map((bracket, index) => (
    <ReferenceLine
      key={index}
      y={bracket.min}
      stroke={foregroundMutedColor}
      ifOverflow="extendDomain"
      label={{
        value: `${formatPercentage(bracket.rate, 0)} (${formatCompactCurrency(bracket.min, 1)})`,
        position: index !== visibleBrackets.length - 1 ? 'insideBottomRight' : 'insideTopRight',
        fill: foregroundColor,
        fontWeight: '600',
      }}
    />
  ));
};

const getNiitThreshold = (chartData: SingleSimulationTaxesChartDataPoint[]): number | null => {
  return chartData[0]?.niitThreshold ?? null;
};

const renderNiitThresholdReferenceLine = (niitThreshold: number, foregroundColor: string, foregroundMutedColor: string) => {
  return (
    <ReferenceLine
      y={niitThreshold}
      stroke={foregroundMutedColor}
      ifOverflow="extendDomain"
      label={{
        value: `${formatPercentage(NIIT_RATE)} (${formatCompactCurrency(niitThreshold, 1)})`,
        position: 'insideTopRight',
        fill: foregroundColor,
        fontWeight: '600',
      }}
    />
  );
};

const getTaxesLabelFormatter = (dataView: TaxesDataView) => {
  return (value: number) => {
    switch (dataView) {
      case 'marginalRates':
      case 'effectiveRates':
      case 'socialSecurityTaxablePercentage':
        return formatPercentage(value);
      default:
        return formatCompactCurrency(value, 1);
    }
  };
};

type BarChartData = {
  name: string;
  segments: Array<{ amount: number; color: string }>;
};

const normalizeChartData = (data: BarChartData[]) => {
  const maxSegments = Math.max(...data.map((d) => d.segments.length), 0);
  return {
    maxSegments,
    normalizedData: data.map((item) => ({
      ...item,
      segments: Array.from({ length: maxSegments }, (_, i) => item.segments[i] ?? { amount: 0, color: 'none' }),
    })),
  };
};

interface SingleSimulationTaxesBarChartProps {
  age: number;
  dataView: TaxesDataView;
  rawChartData: SingleSimulationTaxesChartDataPoint[];
  referenceLineMode: TaxableIncomeReferenceLineMode | null;
  agiReferenceLineMode: AgiReferenceLineMode | null;
}

export default function SingleSimulationTaxesBarChart({
  age,
  dataView,
  rawChartData,
  referenceLineMode,
  agiReferenceLineMode,
}: SingleSimulationTaxesBarChartProps) {
  const { foregroundColor, foregroundMutedColor } = useChartTheme();
  const isSmallScreen = useIsMobile();

  const chartData = rawChartData.filter((item) => item.age === age);

  const { federalIncomeTaxBrackets, capitalGainsTaxBrackets } = getTaxBrackets(chartData);
  const niitThreshold = getNiitThreshold(chartData);
  const taxableIncome = Math.max(...chartData.map((item) => item.taxableIncome));

  // Every taxes view comes from the metric registry (P4-P6): keys, colours, segment grouping,
  // the zero filter and the formatter are frozen by the registry tests. Taxes has no `custom`
  // view, so the per-view switch is gone. The bracket reference lines below are chart furniture
  // and stay untouched.
  const definition = resolveBarChart('taxes', dataView);
  const point = chartData[0];

  const formatter = getMetricValueFormatter(definition?.format);
  const filterZeroValues = definition?.filterZeroValues !== false;
  const stackId = definition?.segments?.some((size) => size > 1) ? 'barStack' : undefined;

  const getTotalAmount = (item: BarChartData) => item.segments.reduce((acc, s) => acc + s.amount, 0);
  const transformedChartData = (definition && point ? toCategoricalBars(point, definition, { isSmallScreen }) : [])
    .filter((item) => (filterZeroValues ? getTotalAmount(item) !== 0 : true))
    .sort((a, b) => getTotalAmount(b) - getTotalAmount(a));
  if (transformedChartData.length === 0) {
    return <ChartEmptyState />;
  }

  const { tick, bottomMargin } = getBarChartTickConfig(transformedChartData.length, isSmallScreen, foregroundMutedColor);

  const { maxSegments, normalizedData } = normalizeChartData(transformedChartData);
  const getDataKey = (segmentIndex: number) => `segments[${segmentIndex}].amount`;

  return (
    <BarChartContainer>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={normalizedData} className="text-xs" margin={{ top: 5, right: 10, left: 10, bottom: bottomMargin }} tabIndex={-1}>
          <ChartGrid />
          <BarChartXAxis tick={tick} />
          <BarChartYAxis formatter={formatter} />
          {Array.from({ length: maxSegments }).map((_, segmentIndex) => (
            <Bar key={segmentIndex} dataKey={getDataKey(segmentIndex)} maxBarSize={75} minPointSize={20} stackId={stackId}>
              {normalizedData.map((entry, i) => {
                const segment = entry.segments[segmentIndex];

                const color = segment?.color;
                const amount = segment?.amount;

                const fillOpacity = filterZeroValues ? (amount !== 0 ? 0.5 : 0) : 0.5;
                const strokeWidth = filterZeroValues ? (amount !== 0 ? 3 : 0) : 3;

                return <Cell key={i} fill={color} fillOpacity={fillOpacity} stroke={color} strokeWidth={strokeWidth} />;
              })}
              <LabelList
                dataKey={getDataKey(segmentIndex)}
                position="middle"
                content={<CustomLabelListContent isSmallScreen={isSmallScreen} formatValue={getTaxesLabelFormatter(dataView)} />}
              />
            </Bar>
          ))}
          {referenceLineMode === 'marginalFederalIncomeTaxRates' &&
            federalIncomeTaxBrackets &&
            renderTaxBracketReferenceLines(federalIncomeTaxBrackets, taxableIncome, foregroundColor, foregroundMutedColor)}
          {referenceLineMode === 'marginalCapitalGainsTaxRates' &&
            capitalGainsTaxBrackets &&
            renderTaxBracketReferenceLines(capitalGainsTaxBrackets, taxableIncome, foregroundColor, foregroundMutedColor)}
          {agiReferenceLineMode === 'niitThreshold' &&
            niitThreshold &&
            renderNiitThresholdReferenceLine(niitThreshold, foregroundColor, foregroundMutedColor)}
        </BarChart>
      </ResponsiveContainer>
    </BarChartContainer>
  );
}
