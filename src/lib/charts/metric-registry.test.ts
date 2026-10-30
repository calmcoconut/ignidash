import { describe, it, expect } from 'vitest';

import {
  CASH_FLOW_DATA_VIEWS,
  CONTRIBUTIONS_DATA_VIEWS,
  DATA_VIEW_CATEGORIES,
  METRIC_DEFINITIONS,
  NET_WORTH_DATA_VIEWS,
  REAL_NET_WORTH_METRIC_ID,
  RETURNS_DATA_VIEWS,
  TAXES_DATA_VIEWS,
  WITHDRAWALS_DATA_VIEWS,
  chartKindsForDataView,
  dataViewIdsForCategory,
  getMetric,
  getMetricValueFormatter,
  metricIdForDataView,
  resolveDataView,
} from './metric-registry';
import {
  applySeriesSigns,
  metricValue,
  resolveSeries,
  seriesValue,
  seriesValues,
  toAreaSeriesProps,
  toBarSeriesProps,
  toLineSeriesProps,
  toPieSlices,
} from './plot-types';
import type { ChartKind, MetricDataPoint } from './plot-types';

// ============================================================================
// FROZEN CONTRACTS
// ============================================================================

/**
 * The persisted data-view ids. These strings are what a saved user preference points
 * at: renaming one silently resets that preference, so any change must fail here first.
 */
const FROZEN_DATA_VIEW_IDS = {
  netWorth: [
    'assetClass',
    'taxCategory',
    'netPortfolioChange',
    'netWorth',
    'netWorthChange',
    'assetEquity',
    'netAssetChange',
    'debts',
    'netDebtReduction',
    'custom',
  ],
  cashFlow: ['surplusDeficit', 'cashFlow', 'incomes', 'expenses', 'custom', 'savingsRate'],
  taxes: [
    'marginalRates',
    'effectiveRates',
    'annualAmounts',
    'cumulativeAmounts',
    'taxableIncome',
    'adjustedGrossIncome',
    'investmentIncome',
    'retirementDistributions',
    'taxFreeIncome',
    'ordinaryIncome',
    'capitalGainsAndDividends',
    'earlyWithdrawalPenalties',
    'adjustmentsAndDeductions',
    'socialSecurityIncome',
    'socialSecurityTaxablePercentage',
  ],
  returns: ['rates', 'cagr', 'annualAmounts', 'cumulativeAmounts', 'taxCategory', 'appreciation', 'custom'],
  contributions: ['annualAmounts', 'cumulativeAmounts', 'taxCategory', 'custom', 'employerMatch', 'shortfall'],
  withdrawals: [
    'annualAmounts',
    'cumulativeAmounts',
    'taxCategory',
    'realizedGains',
    'requiredMinimumDistributions',
    'earlyWithdrawals',
    'shortfall',
    'withdrawalRate',
    'custom',
  ],
} as const;

type SeriesFingerprint = readonly (readonly [key: string, color: string, sign: number])[];

/**
 * The rendered series of every ported metric, per chart kind: key, colour, sign.
 * A refactor that recolours, renames or re-signs a series must fail this test and be
 * reviewed as a deliberate chart change.
 */
const FROZEN_SERIES: Record<string, Partial<Record<ChartKind, SeriesFingerprint>>> = {
  'cashFlow.surplusDeficit': {
    line: [
      ['surplusDeficit', 'var(--foreground)', 1],
      ['income', 'var(--chart-1)', 1],
      ['expenses', 'var(--chart-2)', -1],
      ['taxesAndPenalties', 'var(--chart-3)', -1],
      ['debtPayments', 'var(--chart-4)', -1],
    ],
    bar: [
      ['earnedIncome', 'var(--chart-1)', 1],
      ['socialSecurityIncome', 'var(--chart-1)', 1],
      ['taxFreeIncome', 'var(--chart-1)', 1],
      ['expenses', 'var(--chart-2)', -1],
      ['taxesAndPenalties', 'var(--chart-3)', -1],
      ['debtPayments', 'var(--chart-4)', -1],
    ],
  },
  'cashFlow.cashFlow': {
    line: [
      ['netCashFlow', 'var(--foreground)', 1],
      ['income', 'var(--chart-1)', 1],
      ['amountLiquidated', 'var(--chart-2)', 1],
      ['assetSaleProceeds', 'var(--chart-3)', 1],
      ['expenses', 'var(--chart-4)', -1],
      ['taxesAndPenalties', 'var(--chart-5)', -1],
      ['debtPayments', 'var(--chart-6)', -1],
      ['amountInvested', 'var(--chart-7)', -1],
      ['assetPurchaseOutlay', 'var(--chart-8)', -1],
    ],
    bar: [
      ['earnedIncome', 'var(--chart-1)', 1],
      ['socialSecurityIncome', 'var(--chart-1)', 1],
      ['taxFreeIncome', 'var(--chart-1)', 1],
      ['amountLiquidated', 'var(--chart-2)', 1],
      ['assetSaleProceeds', 'var(--chart-3)', 1],
      ['expenses', 'var(--chart-4)', -1],
      ['taxesAndPenalties', 'var(--chart-5)', -1],
      ['debtPayments', 'var(--chart-6)', -1],
      ['amountInvested', 'var(--chart-7)', -1],
      ['assetPurchaseOutlay', 'var(--chart-8)', -1],
    ],
  },
  'cashFlow.incomes': {
    line: [
      ['earnedIncome', 'var(--chart-1)', 1],
      ['socialSecurityIncome', 'var(--chart-2)', 1],
      ['taxFreeIncome', 'var(--chart-3)', 1],
      ['employerMatch', 'var(--chart-4)', 1],
    ],
  },
  'cashFlow.expenses': {
    line: [
      ['expenses', 'var(--chart-1)', 1],
      ['taxesAndPenalties', 'var(--chart-2)', 1],
      ['debtPayments', 'var(--chart-3)', 1],
    ],
  },
  'cashFlow.savingsRate': {
    line: [['savingsRate', 'var(--chart-3)', 1]],
  },
  realNetWorth: {
    line: [['realNetWorth', 'var(--chart-1)', 1]],
    area: [['realNetWorth', 'var(--chart-1)', 1]],
    bar: [['realNetWorth', 'var(--chart-1)', 1]],
    pie: [['realNetWorth', 'var(--chart-1)', 1]],
  },
};

const fingerprint = (metricId: string, chartKind: ChartKind): Array<[string, string, number]> => {
  const metric = getMetric(metricId);
  if (!metric) throw new Error(`Metric ${metricId} is not registered`);
  return resolveSeries(metric, chartKind).map((series) => [series.key, series.color, series.sign]);
};

/** Test-only escape hatch: metric data points carry arbitrary numeric fields. */
const point = (fields: Record<string, unknown>): MetricDataPoint => fields as MetricDataPoint;

// ============================================================================
// REGISTRY INTEGRITY
// ============================================================================

describe('metric registry integrity', () => {
  it('has unique metric ids', () => {
    const ids = METRIC_DEFINITIONS.map((metric) => metric.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('namespaces ported metric ids by category, with the canary as the only exception', () => {
    for (const metric of METRIC_DEFINITIONS) {
      if (metric.id === REAL_NET_WORTH_METRIC_ID) continue;
      expect(metric.id.startsWith(`${metric.category}.`)).toBe(true);
    }
  });

  it('never declares a series for a chart kind the metric does not support', () => {
    for (const metric of METRIC_DEFINITIONS) {
      for (const series of metric.series) {
        for (const chartKind of series.chartKinds) {
          expect(metric.chartKinds, `${metric.id} declares ${series.key} for ${chartKind}`).toContain(chartKind);
        }
      }
    }
  });

  it('declares a table for every metric', () => {
    for (const metric of METRIC_DEFINITIONS) {
      expect(metric.table.columns.length).toBeGreaterThan(0);
      for (const column of metric.table.columns) {
        expect(column.key.length).toBeGreaterThan(0);
        expect(column.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('resolves every metric for every chart kind it supports, and nothing for the others', () => {
    const allChartKinds: ChartKind[] = ['line', 'area', 'bar', 'pie'];
    for (const metric of METRIC_DEFINITIONS) {
      for (const chartKind of allChartKinds) {
        const series = resolveSeries(metric, chartKind);
        if (metric.chartKinds.includes(chartKind)) {
          expect(series.length, `${metric.id} has no series for ${chartKind}`).toBeGreaterThan(0);
        } else {
          expect(series).toEqual([]);
        }
      }
    }
  });
});

// ============================================================================
// PERSISTED DATA VIEWS
// ============================================================================

describe('persisted data view resolution', () => {
  it('freezes the persisted data-view ids of every category', () => {
    expect(NET_WORTH_DATA_VIEWS).toEqual(FROZEN_DATA_VIEW_IDS.netWorth);
    expect(CASH_FLOW_DATA_VIEWS).toEqual(FROZEN_DATA_VIEW_IDS.cashFlow);
    expect(TAXES_DATA_VIEWS).toEqual(FROZEN_DATA_VIEW_IDS.taxes);
    expect(RETURNS_DATA_VIEWS).toEqual(FROZEN_DATA_VIEW_IDS.returns);
    expect(CONTRIBUTIONS_DATA_VIEWS).toEqual(FROZEN_DATA_VIEW_IDS.contributions);
    expect(WITHDRAWALS_DATA_VIEWS).toEqual(FROZEN_DATA_VIEW_IDS.withdrawals);
  });

  it('resolves every persisted data-view id of every category, without throwing', () => {
    for (const category of DATA_VIEW_CATEGORIES) {
      const ids = dataViewIdsForCategory(category);
      expect(ids.length).toBeGreaterThan(0);
      for (const dataViewId of ids) {
        const resolution = resolveDataView(category, dataViewId);
        expect(resolution.category).toBe(category);
        expect(resolution.dataViewId).toBe(dataViewId);
        if (resolution.status === 'legacy') {
          expect(resolution.metricId).toBe(metricIdForDataView(category, dataViewId));
        } else {
          expect(resolution.metric.category).toBe(category);
          expect(resolution.metric.id).toBe(metricIdForDataView(category, dataViewId));
        }
      }
    }
  });

  it('maps the ported cash-flow views to registry metrics and leaves custom as legacy', () => {
    const ported = ['surplusDeficit', 'cashFlow', 'incomes', 'expenses', 'savingsRate'];
    for (const dataViewId of ported) {
      const resolution = resolveDataView('cashFlow', dataViewId);
      expect(resolution.status).toBe('registry');
    }

    const custom = resolveDataView('cashFlow', 'custom');
    expect(custom.status).toBe('legacy');
    if (custom.status !== 'legacy') throw new Error('custom must stay on the legacy switch');
    expect(custom.metricId).toBe('cashFlow.custom');
  });

  it('keeps every unported category on its legacy switch', () => {
    for (const category of DATA_VIEW_CATEGORIES) {
      if (category === 'cashFlow') continue;
      for (const dataViewId of dataViewIdsForCategory(category)) {
        expect(resolveDataView(category, dataViewId).status).toBe('legacy');
      }
    }
  });

  it('does not register the net-worth canary as a persisted view', () => {
    expect(getMetric(REAL_NET_WORTH_METRIC_ID)).toBeDefined();
    expect(chartKindsForDataView('netWorth', 'netWorth')).toEqual([]);
  });

  it('reports the chart kinds a ported data view supports', () => {
    expect(chartKindsForDataView('cashFlow', 'cashFlow')).toEqual(['line', 'bar']);
    expect(chartKindsForDataView('cashFlow', 'incomes')).toEqual(['line']);
    expect(chartKindsForDataView('cashFlow', 'custom')).toEqual([]);
  });

  it('resolves an unknown id as legacy instead of failing', () => {
    const resolution = resolveDataView('cashFlow', 'someFutureView');
    expect(resolution.status).toBe('legacy');
  });
});

// ============================================================================
// KEY / COLOUR PARITY
// ============================================================================

describe('series key and colour parity', () => {
  for (const [metricId, byChartKind] of Object.entries(FROZEN_SERIES)) {
    for (const [chartKind, expected] of Object.entries(byChartKind) as Array<[ChartKind, SeriesFingerprint]>) {
      it(`renders ${metricId} as ${chartKind} with frozen keys and colours`, () => {
        expect(fingerprint(metricId, chartKind)).toEqual(expected.map(([key, color, sign]) => [key, color, sign]));
      });
    }
  }

  it('gives the line and bar cash-flow views their own series sets', () => {
    expect(fingerprint('cashFlow.cashFlow', 'line')[0][0]).toBe('netCashFlow');
    expect(fingerprint('cashFlow.cashFlow', 'bar')[0][0]).toBe('earnedIncome');
  });

  it('assigns a stack id to stacked series and none to unstacked ones', () => {
    const metric = getMetric('cashFlow.surplusDeficit');
    if (!metric) throw new Error('missing metric');
    const line = resolveSeries(metric, 'line');
    expect(line.filter((series) => series.plot === 'bar').every((series) => series.stackId === 'barStack')).toBe(true);
    expect(toBarSeriesProps(line).stackId).toBe('barStack');

    const bar = resolveSeries(metric, 'bar');
    expect(bar.every((series) => series.stackId === undefined)).toBe(true);
  });
});

// ============================================================================
// RENDERED OUTPUT PARITY (substitute for the manual chart diff)
// ============================================================================

describe('rendered cash-flow output parity', () => {
  it('draws the same signed series the old surplus/deficit line chart did', () => {
    const metric = getMetric('cashFlow.surplusDeficit');
    if (!metric) throw new Error('missing metric');
    const series = resolveSeries(metric, 'line');
    const signed = applySeriesSigns(
      [point({ age: 40, surplusDeficit: 15, income: 100, expenses: 60, taxesAndPenalties: 20, debtPayments: 5 })],
      series
    );

    expect(toLineSeriesProps(series)).toEqual({ dataKeys: ['surplusDeficit'], strokeColors: ['var(--foreground)'] });
    expect(toBarSeriesProps(series).dataKeys).toEqual(['income', 'expenses', 'taxesAndPenalties', 'debtPayments']);
    expect(['income', 'expenses', 'taxesAndPenalties', 'debtPayments'].map((key) => metricValue(signed[0], key))).toEqual([
      100, -60, -20, -5,
    ]);
  });

  it('draws the same single-age rows, labels and colours the old bar chart did', () => {
    const metric = getMetric('cashFlow.surplusDeficit');
    if (!metric) throw new Error('missing metric');
    const series = resolveSeries(metric, 'bar');
    const dp = point({
      age: 40,
      earnedIncome: 100,
      socialSecurityIncome: 20,
      taxFreeIncome: 5,
      expenses: 60,
      taxesAndPenalties: 10,
      debtPayments: 8,
    });

    const rows = series.map((entry) => ({ name: entry.label, amount: seriesValue(dp, entry, 0), color: entry.color }));
    expect(rows).toEqual([
      { name: 'Earned Income', amount: 100, color: 'var(--chart-1)' },
      { name: 'Social Security', amount: 20, color: 'var(--chart-1)' },
      { name: 'Tax-Free Income', amount: 5, color: 'var(--chart-1)' },
      { name: 'Expenses', amount: -60, color: 'var(--chart-2)' },
      { name: 'Taxes & Penalties', amount: -10, color: 'var(--chart-3)' },
      { name: 'Debt Payments', amount: -8, color: 'var(--chart-4)' },
    ]);
    expect(series.map((entry) => entry.shortLabel)).toEqual(['Earned', 'Soc. Sec.', 'Tax-Free', 'Expenses', 'Taxes', 'Debt']);
  });

  it('draws the same signed net cash flow series the old cash-flow line chart did', () => {
    const metric = getMetric('cashFlow.cashFlow');
    if (!metric) throw new Error('missing metric');
    const series = resolveSeries(metric, 'line');
    const signed = applySeriesSigns(
      [
        point({
          age: 40,
          netCashFlow: 25,
          income: 150,
          amountLiquidated: 40,
          assetSaleProceeds: 10,
          expenses: 90,
          taxesAndPenalties: 30,
          debtPayments: 20,
          amountInvested: 30,
          assetPurchaseOutlay: 5,
        }),
      ],
      series
    );

    expect(toLineSeriesProps(series)).toEqual({ dataKeys: ['netCashFlow'], strokeColors: ['var(--foreground)'] });
    expect(toBarSeriesProps(series).dataKeys).toEqual([
      'income',
      'amountLiquidated',
      'assetSaleProceeds',
      'expenses',
      'taxesAndPenalties',
      'debtPayments',
      'amountInvested',
      'assetPurchaseOutlay',
    ]);
    expect(toBarSeriesProps(series).barColors).toEqual([
      'var(--chart-1)',
      'var(--chart-2)',
      'var(--chart-3)',
      'var(--chart-4)',
      'var(--chart-5)',
      'var(--chart-6)',
      'var(--chart-7)',
      'var(--chart-8)',
    ]);
    expect(
      ['expenses', 'taxesAndPenalties', 'debtPayments', 'amountInvested', 'assetPurchaseOutlay'].map((key) => metricValue(signed[0], key))
    ).toEqual([-90, -30, -20, -30, -5]);
  });

  it('keeps the income and expense stacks in their original colours', () => {
    const incomes = getMetric('cashFlow.incomes');
    const expenses = getMetric('cashFlow.expenses');
    if (!incomes || !expenses) throw new Error('missing metric');

    expect(toBarSeriesProps(resolveSeries(incomes, 'line'))).toEqual({
      dataKeys: ['earnedIncome', 'socialSecurityIncome', 'taxFreeIncome', 'employerMatch'],
      barColors: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'],
      stackId: 'barStack',
    });
    expect(toBarSeriesProps(resolveSeries(expenses, 'line'))).toEqual({
      dataKeys: ['expenses', 'taxesAndPenalties', 'debtPayments'],
      barColors: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'],
      stackId: 'barStack',
    });
  });
});

// ============================================================================
// resolveSeries PURITY
// ============================================================================

describe('resolveSeries', () => {
  it('is pure: repeated calls return equal results', () => {
    const metric = getMetric('cashFlow.cashFlow');
    if (!metric) throw new Error('missing metric');
    expect(resolveSeries(metric, 'line')).toEqual(resolveSeries(metric, 'line'));
  });

  it('does not mutate the metric definition', () => {
    const metric = getMetric('cashFlow.cashFlow');
    if (!metric) throw new Error('missing metric');
    const snapshot = JSON.stringify(metric);
    const series = resolveSeries(metric, 'bar');
    (series[0] as { key: string }).key = 'mutated';
    expect(JSON.stringify(metric)).toBe(snapshot);
  });

  it('falls back from shortLabel to label', () => {
    const metric = getMetric('cashFlow.expenses');
    if (!metric) throw new Error('missing metric');
    const series = resolveSeries(metric, 'line');
    expect(series[0].shortLabel).toBe(series[0].label);
  });
});

// ============================================================================
// ADAPTERS
// ============================================================================

describe('renderer adapters', () => {
  const metric = getMetric('cashFlow.surplusDeficit');
  if (!metric) throw new Error('missing metric');

  it('splits line and bar series for the line renderer', () => {
    const series = resolveSeries(metric, 'line');
    expect(toLineSeriesProps(series)).toEqual({ dataKeys: ['surplusDeficit'], strokeColors: ['var(--foreground)'] });
    expect(toBarSeriesProps(series)).toEqual({
      dataKeys: ['income', 'expenses', 'taxesAndPenalties', 'debtPayments'],
      barColors: ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'],
      stackId: 'barStack',
    });
  });

  it('produces bar cells for the single-age bar renderer', () => {
    const series = resolveSeries(metric, 'bar');
    expect(toBarSeriesProps(series).dataKeys).toEqual([
      'earnedIncome',
      'socialSecurityIncome',
      'taxFreeIncome',
      'expenses',
      'taxesAndPenalties',
      'debtPayments',
    ]);
  });

  it('produces area props', () => {
    const canary = getMetric(REAL_NET_WORTH_METRIC_ID);
    if (!canary) throw new Error('missing canary metric');
    const series = resolveSeries(canary, 'area');
    expect(toAreaSeriesProps(series)).toEqual({ dataKeys: ['realNetWorth'], areaColors: ['var(--chart-1)'], stackId: undefined });
  });

  it('produces pie slices', () => {
    const canary = getMetric(REAL_NET_WORTH_METRIC_ID);
    if (!canary) throw new Error('missing canary metric');
    expect(toPieSlices(resolveSeries(canary, 'pie'))).toEqual([
      { dataKey: 'realNetWorth', name: 'Net Worth (today\u2019s $)', color: 'var(--chart-1)' },
    ]);
  });

  it('applies declared signs so outflows render below zero', () => {
    const points: MetricDataPoint[] = [
      point({ age: 30, income: 100, expenses: 60, taxesAndPenalties: 20, debtPayments: 5, surplusDeficit: 15 }),
    ];
    const series = resolveSeries(metric, 'line');
    const signed = applySeriesSigns(points, series);
    expect(signed[0]).toEqual({ age: 30, income: 100, expenses: -60, taxesAndPenalties: -20, debtPayments: -5, surplusDeficit: 15 });
    // The input array is untouched.
    expect(points[0]).toEqual({ age: 30, income: 100, expenses: 60, taxesAndPenalties: 20, debtPayments: 5, surplusDeficit: 15 });
  });

  it('reads series values with the sign applied', () => {
    const points: MetricDataPoint[] = [point({ age: 30, expenses: 60 })];
    const series = resolveSeries(getMetric('cashFlow.expenses') ?? metric, 'line')[0];
    expect(seriesValue(points[0], series, 0)).toBe(60);
    expect(seriesValues(points, resolveSeries(getMetric('cashFlow.surplusDeficit') ?? metric, 'line')[2])).toEqual([-60]);
  });
});

// ============================================================================
// CANARY METRIC
// ============================================================================

describe('realNetWorth canary', () => {
  const canary = getMetric(REAL_NET_WORTH_METRIC_ID);

  it('is registered for all four chart kinds', () => {
    if (!canary) throw new Error('missing canary metric');
    expect(canary.chartKinds).toEqual(['line', 'area', 'bar', 'pie']);
  });

  it('deflates net worth by the cumulative inflation factor', () => {
    const points: MetricDataPoint[] = [
      point({ age: 40, netWorth: 100_000, cumulativeInflationFactor: 1 }),
      point({ age: 41, netWorth: 110_000, cumulativeInflationFactor: 1.1 }),
      point({ age: 42, netWorth: 121_000, cumulativeInflationFactor: 1.21 }),
    ];
    const series = resolveSeries(canary!, 'line')[0];
    const values = seriesValues(points, series);
    for (const value of values) expect(value).toBeCloseTo(100_000, 6);
  });

  it('falls back to nominal net worth when no inflation factor is present', () => {
    const series = resolveSeries(canary!, 'line')[0];
    expect(seriesValues([point({ age: 40, netWorth: 50_000 })], series)).toEqual([50_000]);
  });
});

// ============================================================================
// FORMATTING
// ============================================================================

describe('metric value formatting', () => {
  it('formats currency metrics compactly', () => {
    expect(getMetricValueFormatter('currency')(1_500_000)).toBe('$1.50M');
  });

  it('formats percent metrics as percentages', () => {
    expect(getMetricValueFormatter('percent')(0.25)).toBe('25.0%');
  });

  it('defaults to currency', () => {
    expect(getMetricValueFormatter(undefined)(2000)).toBe('$2.0k');
  });
});
