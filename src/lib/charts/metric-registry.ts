/**
 * Declarative metric registry.
 *
 * Owns the persisted `dataViews` ids, the series keys, labels, colours, stacking,
 * formatting and table columns of a metric. `resolveSeries()` is pure: it maps a
 * definition onto the series for one chart kind, and the renderer adapters in
 * `plot-types.ts` hand those to the existing chart primitives.
 *
 * PILOT SCOPE (P4-P1): only the cash-flow category is ported, plus the display-only
 * `realNetWorth` canary. Every other category keeps its current in-chart switch and
 * resolves here as `status: 'legacy'` — the migration of those switches is a later
 * item (P4-P6). The mapping is total, so a persisted id can never fail to resolve and
 * a saved view is never reset.
 */

import { formatCompactCurrency, formatPercentage } from '@/lib/utils/number-formatters';

import { metricValue } from './plot-types';
import type { ChartKind, MetricCategory, MetricDefinition, MetricSeriesDefinition, MetricValueFormat } from './plot-types';

// ================================
// PERSISTED DATA VIEW IDS
// ================================

/**
 * The persisted `dataViews` id unions. These strings are a user-facing contract:
 * a saved view references them, so they may only be added to, never renamed.
 */
export const NET_WORTH_DATA_VIEWS = [
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
] as const;

export const CASH_FLOW_DATA_VIEWS = ['surplusDeficit', 'cashFlow', 'incomes', 'expenses', 'custom', 'savingsRate'] as const;

export const TAXES_DATA_VIEWS = [
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
] as const;

export const RETURNS_DATA_VIEWS = ['rates', 'cagr', 'annualAmounts', 'cumulativeAmounts', 'taxCategory', 'appreciation', 'custom'] as const;

export const CONTRIBUTIONS_DATA_VIEWS = [
  'annualAmounts',
  'cumulativeAmounts',
  'taxCategory',
  'custom',
  'employerMatch',
  'shortfall',
] as const;

export const WITHDRAWALS_DATA_VIEWS = [
  'annualAmounts',
  'cumulativeAmounts',
  'taxCategory',
  'realizedGains',
  'requiredMinimumDistributions',
  'earlyWithdrawals',
  'shortfall',
  'withdrawalRate',
  'custom',
] as const;

export type NetWorthDataView = (typeof NET_WORTH_DATA_VIEWS)[number];
export type CashFlowDataView = (typeof CASH_FLOW_DATA_VIEWS)[number];
export type TaxesDataView = (typeof TAXES_DATA_VIEWS)[number];
export type ReturnsDataView = (typeof RETURNS_DATA_VIEWS)[number];
export type ContributionsDataView = (typeof CONTRIBUTIONS_DATA_VIEWS)[number];
export type WithdrawalsDataView = (typeof WITHDRAWALS_DATA_VIEWS)[number];

/** Every category that keeps a `dataViews` entry in the store. */
export const DATA_VIEW_CATEGORIES = ['netWorth', 'cashFlow', 'taxes', 'returns', 'contributions', 'withdrawals'] as const;

/** Persisted data-view ids per category. */
export const DATA_VIEW_IDS_BY_CATEGORY = {
  netWorth: NET_WORTH_DATA_VIEWS,
  cashFlow: CASH_FLOW_DATA_VIEWS,
  taxes: TAXES_DATA_VIEWS,
  returns: RETURNS_DATA_VIEWS,
  contributions: CONTRIBUTIONS_DATA_VIEWS,
  withdrawals: WITHDRAWALS_DATA_VIEWS,
} as const satisfies Record<MetricCategory, readonly string[]>;

// ================================
// METRIC DEFINITIONS
// ================================

/**
 * Cash flow: line (composed time series) series. Keys and colours are frozen by
 * `metric-registry.test.ts`; changing one is a deliberate, reviewed chart change.
 */
const CASH_FLOW_CASH_FLOW: MetricDefinition = {
  id: 'cashFlow.cashFlow',
  category: 'cashFlow',
  chartKinds: ['line', 'bar'],
  stackOffset: 'sign',
  format: 'currency',
  annotations: [{ kind: 'referenceLine', label: 'Retirement' }],
  series: [
    { key: 'netCashFlow', label: 'Net Cash Flow', color: 'var(--foreground)', chartKinds: ['line'], plot: 'line' },
    { key: 'income', label: 'Income', color: 'var(--chart-1)', chartKinds: ['line'], plot: 'bar', stackId: 'barStack' },
    {
      key: 'amountLiquidated',
      label: 'Amount Liquidated',
      shortLabel: 'Liquidated',
      color: 'var(--chart-2)',
      chartKinds: ['line'],
      plot: 'bar',
      stackId: 'barStack',
    },
    {
      key: 'assetSaleProceeds',
      label: 'Asset Sale Proceeds',
      shortLabel: 'Proceeds',
      color: 'var(--chart-3)',
      chartKinds: ['line'],
      plot: 'bar',
      stackId: 'barStack',
    },
    { key: 'expenses', label: 'Expenses', color: 'var(--chart-4)', chartKinds: ['line'], plot: 'bar', sign: -1, stackId: 'barStack' },
    {
      key: 'taxesAndPenalties',
      label: 'Taxes & Penalties',
      shortLabel: 'Taxes',
      color: 'var(--chart-5)',
      chartKinds: ['line'],
      plot: 'bar',
      sign: -1,
      stackId: 'barStack',
    },
    {
      key: 'debtPayments',
      label: 'Debt Payments',
      shortLabel: 'Debt',
      color: 'var(--chart-6)',
      chartKinds: ['line'],
      plot: 'bar',
      sign: -1,
      stackId: 'barStack',
    },
    {
      key: 'amountInvested',
      label: 'Amount Invested',
      shortLabel: 'Invested',
      color: 'var(--chart-7)',
      chartKinds: ['line'],
      plot: 'bar',
      sign: -1,
      stackId: 'barStack',
    },
    {
      key: 'assetPurchaseOutlay',
      label: 'Asset Purchase Outlay',
      shortLabel: 'Outlay',
      color: 'var(--chart-8)',
      chartKinds: ['line'],
      plot: 'bar',
      sign: -1,
      stackId: 'barStack',
    },

    // Single-age bar (decomposition) series for the same metric.
    { key: 'earnedIncome', label: 'Earned Income', shortLabel: 'Earned', color: 'var(--chart-1)', chartKinds: ['bar'], plot: 'bar' },
    {
      key: 'socialSecurityIncome',
      label: 'Social Security',
      shortLabel: 'Soc. Sec.',
      color: 'var(--chart-1)',
      chartKinds: ['bar'],
      plot: 'bar',
    },
    { key: 'taxFreeIncome', label: 'Tax-Free Income', shortLabel: 'Tax-Free', color: 'var(--chart-1)', chartKinds: ['bar'], plot: 'bar' },
    {
      key: 'amountLiquidated',
      label: 'Amount Liquidated',
      shortLabel: 'Liquidated',
      color: 'var(--chart-2)',
      chartKinds: ['bar'],
      plot: 'bar',
    },
    {
      key: 'assetSaleProceeds',
      label: 'Asset Sale Proceeds',
      shortLabel: 'Proceeds',
      color: 'var(--chart-3)',
      chartKinds: ['bar'],
      plot: 'bar',
    },
    { key: 'expenses', label: 'Expenses', color: 'var(--chart-4)', chartKinds: ['bar'], plot: 'bar', sign: -1 },
    {
      key: 'taxesAndPenalties',
      label: 'Taxes & Penalties',
      shortLabel: 'Taxes',
      color: 'var(--chart-5)',
      chartKinds: ['bar'],
      plot: 'bar',
      sign: -1,
    },
    {
      key: 'debtPayments',
      label: 'Debt Payments',
      shortLabel: 'Debt',
      color: 'var(--chart-6)',
      chartKinds: ['bar'],
      plot: 'bar',
      sign: -1,
    },
    {
      key: 'amountInvested',
      label: 'Amount Invested',
      shortLabel: 'Invested',
      color: 'var(--chart-7)',
      chartKinds: ['bar'],
      plot: 'bar',
      sign: -1,
    },
    {
      key: 'assetPurchaseOutlay',
      label: 'Asset Purchase Outlay',
      shortLabel: 'Outlay',
      color: 'var(--chart-8)',
      chartKinds: ['bar'],
      plot: 'bar',
      sign: -1,
    },
  ],
  table: {
    columns: [
      { key: 'earnedIncome', label: 'Earned Income', format: 'currency' },
      { key: 'socialSecurityIncome', label: 'Social Security Income', format: 'currency' },
      { key: 'taxFreeIncome', label: 'Tax-Free Income', format: 'currency' },
      { key: 'amountLiquidated', label: 'Amount Liquidated', format: 'currency' },
      { key: 'assetSaleProceeds', label: 'Asset Sale Proceeds', format: 'currency' },
      { key: 'expenses', label: 'Expenses', format: 'currency' },
      { key: 'taxesAndPenalties', label: 'Total Taxes & Penalties', format: 'currency' },
      { key: 'debtPayments', label: 'Debt Payments', format: 'currency' },
      { key: 'amountInvested', label: 'Amount Invested', format: 'currency' },
      { key: 'assetPurchaseOutlay', label: 'Asset Purchase Outlay', format: 'currency' },
      { key: 'netCashFlow', label: 'Net Cash Flow', format: 'currency' },
    ],
  },
};

const CASH_FLOW_SURPLUS_DEFICIT: MetricDefinition = {
  id: 'cashFlow.surplusDeficit',
  category: 'cashFlow',
  chartKinds: ['line', 'bar'],
  stackOffset: 'sign',
  format: 'currency',
  series: [
    { key: 'surplusDeficit', label: 'Surplus/Deficit', color: 'var(--foreground)', chartKinds: ['line'], plot: 'line' },
    { key: 'income', label: 'Income', color: 'var(--chart-1)', chartKinds: ['line'], plot: 'bar', stackId: 'barStack' },
    { key: 'expenses', label: 'Expenses', color: 'var(--chart-2)', chartKinds: ['line'], plot: 'bar', sign: -1, stackId: 'barStack' },
    {
      key: 'taxesAndPenalties',
      label: 'Taxes & Penalties',
      shortLabel: 'Taxes',
      color: 'var(--chart-3)',
      chartKinds: ['line'],
      plot: 'bar',
      sign: -1,
      stackId: 'barStack',
    },
    {
      key: 'debtPayments',
      label: 'Debt Payments',
      shortLabel: 'Debt',
      color: 'var(--chart-4)',
      chartKinds: ['line'],
      plot: 'bar',
      sign: -1,
      stackId: 'barStack',
    },

    { key: 'earnedIncome', label: 'Earned Income', shortLabel: 'Earned', color: 'var(--chart-1)', chartKinds: ['bar'], plot: 'bar' },
    {
      key: 'socialSecurityIncome',
      label: 'Social Security',
      shortLabel: 'Soc. Sec.',
      color: 'var(--chart-1)',
      chartKinds: ['bar'],
      plot: 'bar',
    },
    { key: 'taxFreeIncome', label: 'Tax-Free Income', shortLabel: 'Tax-Free', color: 'var(--chart-1)', chartKinds: ['bar'], plot: 'bar' },
    { key: 'expenses', label: 'Expenses', color: 'var(--chart-2)', chartKinds: ['bar'], plot: 'bar', sign: -1 },
    {
      key: 'taxesAndPenalties',
      label: 'Taxes & Penalties',
      shortLabel: 'Taxes',
      color: 'var(--chart-3)',
      chartKinds: ['bar'],
      plot: 'bar',
      sign: -1,
    },
    {
      key: 'debtPayments',
      label: 'Debt Payments',
      shortLabel: 'Debt',
      color: 'var(--chart-4)',
      chartKinds: ['bar'],
      plot: 'bar',
      sign: -1,
    },
  ],
  table: {
    columns: [
      { key: 'earnedIncome', label: 'Earned Income', format: 'currency' },
      { key: 'socialSecurityIncome', label: 'Social Security Income', format: 'currency' },
      { key: 'taxFreeIncome', label: 'Tax-Free Income', format: 'currency' },
      { key: 'expenses', label: 'Expenses', format: 'currency' },
      { key: 'taxesAndPenalties', label: 'Total Taxes & Penalties', format: 'currency' },
      { key: 'debtPayments', label: 'Debt Payments', format: 'currency' },
      { key: 'surplusDeficit', label: 'Surplus/Deficit', format: 'currency' },
    ],
  },
};

const CASH_FLOW_INCOMES: MetricDefinition = {
  id: 'cashFlow.incomes',
  category: 'cashFlow',
  chartKinds: ['line'],
  format: 'currency',
  series: [
    {
      key: 'earnedIncome',
      label: 'Earned Income',
      shortLabel: 'Earned',
      color: 'var(--chart-1)',
      chartKinds: ['line'],
      plot: 'bar',
      stackId: 'barStack',
    },
    {
      key: 'socialSecurityIncome',
      label: 'Social Security',
      shortLabel: 'Soc. Sec.',
      color: 'var(--chart-2)',
      chartKinds: ['line'],
      plot: 'bar',
      stackId: 'barStack',
    },
    {
      key: 'taxFreeIncome',
      label: 'Tax-Free Income',
      shortLabel: 'Tax-Free',
      color: 'var(--chart-3)',
      chartKinds: ['line'],
      plot: 'bar',
      stackId: 'barStack',
    },
    {
      key: 'employerMatch',
      label: 'Employer Match',
      shortLabel: 'Match',
      color: 'var(--chart-4)',
      chartKinds: ['line'],
      plot: 'bar',
      stackId: 'barStack',
    },
  ],
  table: {
    columns: [
      { key: 'earnedIncome', label: 'Earned Income', format: 'currency' },
      { key: 'socialSecurityIncome', label: 'Social Security Income', format: 'currency' },
      { key: 'taxFreeIncome', label: 'Tax-Free Income', format: 'currency' },
      { key: 'employerMatch', label: 'Employer Match', format: 'currency' },
    ],
  },
};

const CASH_FLOW_EXPENSES: MetricDefinition = {
  id: 'cashFlow.expenses',
  category: 'cashFlow',
  chartKinds: ['line'],
  format: 'currency',
  series: [
    { key: 'expenses', label: 'Expenses', color: 'var(--chart-1)', chartKinds: ['line'], plot: 'bar', stackId: 'barStack' },
    {
      key: 'taxesAndPenalties',
      label: 'Taxes & Penalties',
      shortLabel: 'Taxes',
      color: 'var(--chart-2)',
      chartKinds: ['line'],
      plot: 'bar',
      stackId: 'barStack',
    },
    {
      key: 'debtPayments',
      label: 'Debt Payments',
      shortLabel: 'Debt',
      color: 'var(--chart-3)',
      chartKinds: ['line'],
      plot: 'bar',
      stackId: 'barStack',
    },
  ],
  table: {
    columns: [
      { key: 'expenses', label: 'Expenses', format: 'currency' },
      { key: 'taxesAndPenalties', label: 'Total Taxes & Penalties', format: 'currency' },
      { key: 'debtPayments', label: 'Debt Payments', format: 'currency' },
    ],
  },
};

const CASH_FLOW_SAVINGS_RATE: MetricDefinition = {
  id: 'cashFlow.savingsRate',
  category: 'cashFlow',
  chartKinds: ['line'],
  format: 'percent',
  series: [{ key: 'savingsRate', label: 'Savings Rate', color: 'var(--chart-3)', chartKinds: ['line'], plot: 'line' }],
  table: {
    columns: [{ key: 'savingsRate', label: 'Savings Rate', format: 'percent' }],
  },
};

/**
 * Canary metric (display-only). It is registered so the registry is exercised against
 * inflation-adjusted, *derived* series and all four renderer adapters, but no chart
 * reads it yet: adding it must not change what any existing chart displays.
 *
 * `netWorth` and `cumulativeInflationFactor` come from the net worth chart data point,
 * so the series is net worth expressed in today's dollars.
 */
const realNetWorthOf: NonNullable<MetricSeriesDefinition['derive']> = (point) => {
  const netWorth = metricValue(point, 'netWorth');
  const inflationFactor = metricValue(point, 'cumulativeInflationFactor');
  return inflationFactor > 0 ? netWorth / inflationFactor : netWorth;
};

const REAL_NET_WORTH: MetricDefinition = {
  id: 'realNetWorth',
  category: 'netWorth',
  chartKinds: ['line', 'area', 'bar', 'pie'],
  format: 'currency',
  series: [
    {
      key: 'realNetWorth',
      label: 'Net Worth (today\u2019s $)',
      shortLabel: 'Real NW',
      color: 'var(--chart-1)',
      chartKinds: ['line', 'area', 'bar'],
      derive: realNetWorthOf,
    },
    {
      key: 'realNetWorth',
      label: 'Net Worth (today\u2019s $)',
      shortLabel: 'Real NW',
      color: 'var(--chart-1)',
      chartKinds: ['pie'],
      derive: realNetWorthOf,
    },
  ],
  table: {
    columns: [{ key: 'realNetWorth', label: 'Net Worth (today\u2019s $)', format: 'currency' }],
  },
};

/** Registry id of the display-only canary metric. */
export const REAL_NET_WORTH_METRIC_ID = REAL_NET_WORTH.id;

/** Every metric the registry owns. Only ported metrics and the canary appear here. */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  CASH_FLOW_SURPLUS_DEFICIT,
  CASH_FLOW_CASH_FLOW,
  CASH_FLOW_INCOMES,
  CASH_FLOW_EXPENSES,
  CASH_FLOW_SAVINGS_RATE,
  REAL_NET_WORTH,
];

const METRICS_BY_ID: ReadonlyMap<string, MetricDefinition> = new Map(METRIC_DEFINITIONS.map((metric) => [metric.id, metric]));

/** Looks up a registry metric by id, or `undefined` when the id is not ported. */
export function getMetric(metricId: string): MetricDefinition | undefined {
  return METRICS_BY_ID.get(metricId);
}

// ================================
// DATA VIEW RESOLUTION
// ================================

/** The registry id a persisted data-view id maps to (`<category>.<dataViewId>`). */
export type DataViewMetricId = string;

/**
 * A persisted data-view id resolved against the registry.
 *
 * `registry` means a `MetricDefinition` owns this view's series. `legacy` means the
 * view still renders through its own in-chart switch (P4-P6 migrates those); the
 * metric id is reserved so the mapping never has a hole.
 */
export type DataViewResolution =
  | { readonly status: 'registry'; readonly category: MetricCategory; readonly dataViewId: string; readonly metric: MetricDefinition }
  | { readonly status: 'legacy'; readonly category: MetricCategory; readonly dataViewId: string; readonly metricId: string };

/** Maps a persisted data-view id onto its registry id, without checking for a definition. */
export function metricIdForDataView(category: MetricCategory, dataViewId: string): string {
  return `${category}.${dataViewId}`;
}

/**
 * Resolves a persisted data-view id. Total over every category and every id: an id
 * that the registry does not own resolves as `legacy`, never as a failure, so a saved
 * user view can never be lost.
 */
export function resolveDataView(category: MetricCategory, dataViewId: string): DataViewResolution {
  const metricId = metricIdForDataView(category, dataViewId);
  const metric = METRICS_BY_ID.get(metricId);
  if (metric) return { status: 'registry', category, dataViewId, metric };
  return { status: 'legacy', category, dataViewId, metricId };
}

/** Every persisted data-view id of a category, as a plain array. */
export function dataViewIdsForCategory(category: MetricCategory): readonly string[] {
  return DATA_VIEW_IDS_BY_CATEGORY[category];
}

/** Chart kinds a given data view is registered for, or `[]` when it is not ported. */
export function chartKindsForDataView(category: MetricCategory, dataViewId: string): readonly ChartKind[] {
  const resolution = resolveDataView(category, dataViewId);
  return resolution.status === 'registry' ? resolution.metric.chartKinds : [];
}

// ================================
// FORMATTING
// ================================

const CURRENCY_FORMATTER = (value: number) => formatCompactCurrency(value, 1);
const PERCENT_FORMATTER = (value: number) => formatPercentage(value);

/** Value formatter for a metric's declared `format`. */
export function getMetricValueFormatter(format: MetricValueFormat | undefined): (value: number) => string {
  return format === 'percent' ? PERCENT_FORMATTER : CURRENCY_FORMATTER;
}
