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

import { formatChartString } from '@/lib/utils';
import { formatCompactCurrency, formatPercentage } from '@/lib/utils/number-formatters';

import { metricValue } from './plot-types';
import type { ChartKind, MetricCategory, MetricDefinition, MetricSeriesDefinition, MetricValueFormat, PlotKind } from './plot-types';

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

// ================================
// MIGRATED TIME-SERIES CATEGORIES (P4-P6)
// ================================
//
// Taxes, returns, contributions, withdrawals and net worth use the same series model the
// cash-flow pilot established. `defineLineMetric` takes each old switch's series verbatim —
// key, colour, plot, sign, stack id, in order — so an entry below reads one-for-one against
// the switch it replaced. Labels are `formatChartString(key)`, the same humaniser the chart
// tooltips use, so a label cannot drift from its tooltip; the frozen registry tests pin the
// keys, colours, plots, signs, stack ids and formats.
//
// Only the time-series (line/area) switch of each category lives here. The single-age bar
// and pie charts keep their bespoke switches: they pipeline whole per-view segments (tax
// brackets, percentile bands) rather than a series list, so they need their own adapter and
// are migrated separately.

/** One series of a migrated time-series view: `[key, colour, plot?, sign?, stackId?]`. */
type LineSeriesRow = readonly [key: string, color: string, plot?: PlotKind, sign?: 1 | -1, stackId?: string];

/**
 * Builds a time-series metric from the series rows of the switch it replaces.
 *
 * @param id - `<category>.<dataViewId>`, matching the persisted view id
 * @param format - Axis formatter for the view (the switch's own formatter)
 * @param series - Series rows in the switch's order
 * @param options - `stackOffset: 'sign'` for views that plot outflows below zero; `tableColumns`
 *   to narrow the table equivalent (defaults to every series key)
 * @returns The metric definition
 */
function defineLineMetric(
  id: string,
  format: MetricValueFormat,
  series: readonly LineSeriesRow[],
  options: { stackOffset?: 'sign'; stack?: 'barStack' | 'none'; tableColumns?: readonly string[] } = {}
): MetricDefinition {
  const [category] = id.split('.') as [MetricCategory];

  return {
    id,
    category,
    chartKinds: ['line'],
    ...(options.stackOffset ? { stackOffset: options.stackOffset } : {}),
    format,
    series: series.map(([key, color, plot = 'bar', sign, declaredStackId]) => {
      // Bars stack on `barStack` unless the view opts out; area series carry their own stack id.
      const stackId = declaredStackId ?? (plot === 'bar' && options.stack !== 'none' ? 'barStack' : undefined);

      return {
        key,
        label: formatChartString(key),
        color,
        chartKinds: ['line'],
        plot,
        ...(sign === -1 ? { sign: -1 } : {}),
        ...(stackId === undefined ? {} : { stackId }),
      };
    }),
    table: {
      columns: (options.tableColumns ?? series.map(([key]) => key)).map((key) => ({
        key,
        label: formatChartString(key),
        format,
      })),
    },
  };
}

// --- Taxes: `extractSingleSimulationTaxesData` fields, exactly the old switch's keys/colours.

const TAXES_MARGINAL_RATES = defineLineMetric('taxes.marginalRates', 'percent', [
  ['topMarginalFederalIncomeTaxRate', 'var(--chart-2)', 'line'],
  ['topMarginalCapitalGainsTaxRate', 'var(--chart-4)', 'line'],
]);

const TAXES_EFFECTIVE_RATES = defineLineMetric('taxes.effectiveRates', 'percent', [
  ['effectiveFederalIncomeTaxRate', 'var(--chart-2)', 'line'],
  ['effectiveCapitalGainsTaxRate', 'var(--chart-4)', 'line'],
]);

const TAXES_ANNUAL_AMOUNTS = defineLineMetric('taxes.annualAmounts', 'currency', [
  ['annualFederalIncomeTax', 'var(--chart-1)'],
  ['annualFicaTax', 'var(--chart-2)'],
  ['annualCapitalGainsTax', 'var(--chart-3)'],
  ['annualNiit', 'var(--chart-4)'],
  ['annualEarlyWithdrawalPenalties', 'var(--chart-5)'],
]);

const TAXES_CUMULATIVE_AMOUNTS = defineLineMetric('taxes.cumulativeAmounts', 'currency', [
  ['cumulativeFederalIncomeTax', 'var(--chart-1)'],
  ['cumulativeFicaTax', 'var(--chart-2)'],
  ['cumulativeCapitalGainsTax', 'var(--chart-3)'],
  ['cumulativeNiit', 'var(--chart-4)'],
  ['cumulativeEarlyWithdrawalPenalties', 'var(--chart-5)'],
]);

const TAXES_TAXABLE_INCOME = defineLineMetric(
  'taxes.taxableIncome',
  'currency',
  [
    ['taxableIncome', 'var(--foreground)', 'line'],
    ['incomeTaxedAsOrdinary', 'var(--chart-1)'],
    ['incomeTaxedAsLtcg', 'var(--chart-2)'],
    ['taxDeductibleContributions', 'var(--chart-3)', 'bar', -1],
    ['standardDeduction', 'var(--chart-4)', 'bar', -1],
    ['capitalLossDeduction', 'var(--chart-5)', 'bar', -1],
  ],
  { stackOffset: 'sign' }
);

const TAXES_ADJUSTED_GROSS_INCOME = defineLineMetric(
  'taxes.adjustedGrossIncome',
  'currency',
  [
    ['adjustedGrossIncome', 'var(--foreground)', 'line'],
    ['incomeTaxedAsOrdinary', 'var(--chart-1)'],
    ['incomeTaxedAsLtcg', 'var(--chart-2)'],
    ['taxDeductibleContributions', 'var(--chart-3)', 'bar', -1],
    ['capitalLossDeduction', 'var(--chart-5)', 'bar', -1],
  ],
  { stackOffset: 'sign' }
);

const TAXES_INVESTMENT_INCOME = defineLineMetric('taxes.investmentIncome', 'currency', [
  ['taxableInterestIncome', 'var(--chart-1)'],
  ['taxableDividendIncome', 'var(--chart-2)'],
  ['realizedGains', 'var(--chart-3)'],
]);

const TAXES_RETIREMENT_DISTRIBUTIONS = defineLineMetric('taxes.retirementDistributions', 'currency', [
  ['taxDeferredWithdrawals', 'var(--chart-1)'],
  ['earlyRothEarningsWithdrawals', 'var(--chart-2)'],
]);

const TAXES_TAX_FREE_INCOME = defineLineMetric('taxes.taxFreeIncome', 'currency', [['taxFreeIncome', 'var(--chart-2)', 'line']]);

const TAXES_ORDINARY_INCOME = defineLineMetric('taxes.ordinaryIncome', 'currency', [
  ['earnedIncome', 'var(--chart-1)'],
  ['taxableSocialSecurityIncome', 'var(--chart-2)'],
  ['taxableInterestIncome', 'var(--chart-3)'],
  ['taxableRetirementDistributions', 'var(--chart-4)'],
]);

const TAXES_CAPITAL_GAINS_AND_DIVIDENDS = defineLineMetric('taxes.capitalGainsAndDividends', 'currency', [
  ['realizedGains', 'var(--chart-1)'],
  ['taxableDividendIncome', 'var(--chart-2)'],
]);

const TAXES_EARLY_WITHDRAWAL_PENALTIES = defineLineMetric(
  'taxes.earlyWithdrawalPenalties',
  'currency',
  [
    ['annualEarlyWithdrawalPenalties', 'var(--chart-2)'],
    ['cumulativeEarlyWithdrawalPenalties', 'var(--chart-4)'],
  ],
  { stack: 'none' }
);

const TAXES_ADJUSTMENTS_AND_DEDUCTIONS = defineLineMetric('taxes.adjustmentsAndDeductions', 'currency', [
  ['taxDeductibleContributions', 'var(--chart-1)'],
  ['capitalLossDeduction', 'var(--chart-2)'],
  ['standardDeduction', 'var(--chart-3)'],
]);

const TAXES_SOCIAL_SECURITY_INCOME = defineLineMetric(
  'taxes.socialSecurityIncome',
  'currency',
  [
    ['socialSecurityIncome', 'var(--chart-1)'],
    ['taxableSocialSecurityIncome', 'var(--chart-2)'],
  ],
  { stack: 'none' }
);

const TAXES_SOCIAL_SECURITY_TAXABLE_PERCENTAGE = defineLineMetric('taxes.socialSecurityTaxablePercentage', 'percent', [
  ['maxTaxablePercentage', 'var(--chart-2)', 'line'],
  ['actualTaxablePercentage', 'var(--chart-4)', 'line'],
]);

// --- Returns: the composed line chart's six registered views (custom stays bespoke).

const RETURNS_RATES = defineLineMetric('returns.rates', 'percent', [
  ['realStockReturnRate', 'var(--chart-2)', 'line'],
  ['realBondReturnRate', 'var(--chart-3)', 'line'],
  ['realCashReturnRate', 'var(--chart-4)', 'line'],
  ['inflationRate', 'var(--chart-8)', 'line'],
]);

const RETURNS_CAGR = defineLineMetric('returns.cagr', 'percent', [
  ['realStockCagr', 'var(--chart-2)', 'line'],
  ['realBondCagr', 'var(--chart-3)', 'line'],
  ['realCashCagr', 'var(--chart-4)', 'line'],
]);

const RETURNS_ANNUAL_AMOUNTS = defineLineMetric('returns.annualAmounts', 'currency', [
  ['totalAnnualGains', 'var(--foreground)', 'line'],
  ['annualStockGain', 'var(--chart-2)'],
  ['annualBondGain', 'var(--chart-3)'],
  ['annualCashGain', 'var(--chart-4)'],
]);

const RETURNS_CUMULATIVE_AMOUNTS = defineLineMetric('returns.cumulativeAmounts', 'currency', [
  ['totalCumulativeGains', 'var(--foreground)', 'line'],
  ['cumulativeStockGain', 'var(--chart-2)'],
  ['cumulativeBondGain', 'var(--chart-3)'],
  ['cumulativeCashGain', 'var(--chart-4)'],
]);

const RETURNS_TAX_CATEGORY = defineLineMetric('returns.taxCategory', 'currency', [
  ['totalAnnualGains', 'var(--foreground)', 'line'],
  ['taxableGains', 'var(--chart-1)'],
  ['taxDeferredGains', 'var(--chart-2)'],
  ['taxFreeGains', 'var(--chart-3)'],
  ['cashSavingsGains', 'var(--chart-4)'],
]);

const RETURNS_APPRECIATION = defineLineMetric(
  'returns.appreciation',
  'currency',
  [
    ['annualAssetAppreciation', 'var(--chart-2)'],
    ['cumulativeAssetAppreciation', 'var(--chart-4)'],
  ],
  { stack: 'none' }
);

// --- Contributions: five registered views (custom stays bespoke).

const CONTRIBUTIONS_ANNUAL_AMOUNTS = defineLineMetric('contributions.annualAmounts', 'currency', [
  ['annualStockContributions', 'var(--chart-1)'],
  ['annualBondContributions', 'var(--chart-2)'],
  ['annualCashContributions', 'var(--chart-3)'],
]);

const CONTRIBUTIONS_CUMULATIVE_AMOUNTS = defineLineMetric('contributions.cumulativeAmounts', 'currency', [
  ['cumulativeStockContributions', 'var(--chart-1)'],
  ['cumulativeBondContributions', 'var(--chart-2)'],
  ['cumulativeCashContributions', 'var(--chart-3)'],
]);

const CONTRIBUTIONS_TAX_CATEGORY = defineLineMetric('contributions.taxCategory', 'currency', [
  ['taxableContributions', 'var(--chart-1)'],
  ['taxDeferredContributions', 'var(--chart-2)'],
  ['taxFreeContributions', 'var(--chart-3)'],
  ['cashSavingsContributions', 'var(--chart-4)'],
]);

const CONTRIBUTIONS_EMPLOYER_MATCH = defineLineMetric(
  'contributions.employerMatch',
  'currency',
  [
    ['annualEmployerMatch', 'var(--chart-2)'],
    ['cumulativeEmployerMatch', 'var(--chart-4)'],
  ],
  { stack: 'none' }
);

const CONTRIBUTIONS_SHORTFALL = defineLineMetric(
  'contributions.shortfall',
  'currency',
  [
    ['annualShortfallRepaid', 'var(--chart-2)'],
    ['outstandingShortfall', 'var(--chart-4)'],
  ],
  { stack: 'none' }
);

// --- Withdrawals: eight registered views (custom stays bespoke).

const WITHDRAWALS_ANNUAL_AMOUNTS = defineLineMetric('withdrawals.annualAmounts', 'currency', [
  ['annualStockWithdrawals', 'var(--chart-1)'],
  ['annualBondWithdrawals', 'var(--chart-2)'],
  ['annualCashWithdrawals', 'var(--chart-3)'],
]);

const WITHDRAWALS_CUMULATIVE_AMOUNTS = defineLineMetric('withdrawals.cumulativeAmounts', 'currency', [
  ['cumulativeStockWithdrawals', 'var(--chart-1)'],
  ['cumulativeBondWithdrawals', 'var(--chart-2)'],
  ['cumulativeCashWithdrawals', 'var(--chart-3)'],
]);

const WITHDRAWALS_TAX_CATEGORY = defineLineMetric('withdrawals.taxCategory', 'currency', [
  ['taxableWithdrawals', 'var(--chart-1)'],
  ['taxDeferredWithdrawals', 'var(--chart-2)'],
  ['taxFreeWithdrawals', 'var(--chart-3)'],
  ['cashSavingsWithdrawals', 'var(--chart-4)'],
]);

const WITHDRAWALS_REALIZED_GAINS = defineLineMetric(
  'withdrawals.realizedGains',
  'currency',
  [
    ['annualRealizedGains', 'var(--chart-2)'],
    ['cumulativeRealizedGains', 'var(--chart-4)'],
  ],
  { stack: 'none' }
);

const WITHDRAWALS_REQUIRED_MINIMUM_DISTRIBUTIONS = defineLineMetric(
  'withdrawals.requiredMinimumDistributions',
  'currency',
  [
    ['annualRequiredMinimumDistributions', 'var(--chart-2)'],
    ['cumulativeRequiredMinimumDistributions', 'var(--chart-4)'],
  ],
  { stack: 'none' }
);

const WITHDRAWALS_EARLY_WITHDRAWALS = defineLineMetric(
  'withdrawals.earlyWithdrawals',
  'currency',
  [
    ['annualEarlyWithdrawals', 'var(--chart-2)'],
    ['cumulativeEarlyWithdrawals', 'var(--chart-4)'],
  ],
  { stack: 'none' }
);

const WITHDRAWALS_SHORTFALL = defineLineMetric(
  'withdrawals.shortfall',
  'currency',
  [
    ['annualShortfall', 'var(--chart-2)'],
    ['outstandingShortfall', 'var(--chart-4)'],
  ],
  { stack: 'none' }
);

const WITHDRAWALS_WITHDRAWAL_RATE = defineLineMetric('withdrawals.withdrawalRate', 'percent', [
  ['withdrawalRate', 'var(--chart-2)', 'line'],
]);

// --- Net worth: the composed area chart's nine registered views (custom stays bespoke).
// Area series stack on the chart's own `areaStack`; line series use the chart's LINE_COLOR.

const NET_WORTH_ASSET_CLASS = defineLineMetric('netWorth.assetClass', 'currency', [
  ['stockHoldings', 'var(--chart-1)', 'area', 1, 'areaStack'],
  ['bondHoldings', 'var(--chart-2)', 'area', 1, 'areaStack'],
  ['cashHoldings', 'var(--chart-3)', 'area', 1, 'areaStack'],
]);

const NET_WORTH_TAX_CATEGORY = defineLineMetric('netWorth.taxCategory', 'currency', [
  ['taxableValue', 'var(--chart-1)', 'area', 1, 'areaStack'],
  ['taxDeferredValue', 'var(--chart-2)', 'area', 1, 'areaStack'],
  ['taxFreeValue', 'var(--chart-3)', 'area', 1, 'areaStack'],
  ['cashSavings', 'var(--chart-4)', 'area', 1, 'areaStack'],
]);

const NET_WORTH_NET_PORTFOLIO_CHANGE = defineLineMetric(
  'netWorth.netPortfolioChange',
  'currency',
  [
    ['netPortfolioChange', 'var(--foreground)', 'line'],
    ['annualReturns', 'var(--chart-1)'],
    ['annualContributions', 'var(--chart-2)'],
    ['annualWithdrawals', 'var(--chart-3)', 'bar', -1],
  ],
  { stackOffset: 'sign' }
);

const NET_WORTH_NET_WORTH = defineLineMetric(
  'netWorth.netWorth',
  'currency',
  [
    ['netWorth', 'var(--foreground)', 'line'],
    ['portfolioValue', 'var(--chart-1)'],
    ['assetValue', 'var(--chart-2)'],
    ['debtBalance', 'var(--chart-3)', 'bar', -1],
  ],
  { stackOffset: 'sign' }
);

const NET_WORTH_NET_WORTH_CHANGE = defineLineMetric(
  'netWorth.netWorthChange',
  'currency',
  [
    ['netWorthChange', 'var(--foreground)', 'line'],
    ['netPortfolioChange', 'var(--chart-1)'],
    ['netAssetChange', 'var(--chart-2)'],
    ['netDebtReduction', 'var(--chart-3)'],
  ],
  { stackOffset: 'sign' }
);

const NET_WORTH_ASSET_EQUITY = defineLineMetric(
  'netWorth.assetEquity',
  'currency',
  [
    ['assetEquity', 'var(--foreground)', 'line'],
    ['assetValue', 'var(--chart-1)'],
    ['securedDebtBalance', 'var(--chart-2)', 'bar', -1],
  ],
  { stackOffset: 'sign' }
);

const NET_WORTH_NET_ASSET_CHANGE = defineLineMetric(
  'netWorth.netAssetChange',
  'currency',
  [
    ['netAssetChange', 'var(--foreground)', 'line'],
    ['annualAssetAppreciation', 'var(--chart-1)'],
    ['annualPurchasedAssetValue', 'var(--chart-2)'],
    ['annualSoldAssetValue', 'var(--chart-3)', 'bar', -1],
  ],
  { stackOffset: 'sign' }
);

const NET_WORTH_DEBTS = defineLineMetric('netWorth.debts', 'currency', [
  ['unsecuredDebtBalance', 'var(--chart-1)', 'area', 1, 'areaStack'],
  ['securedDebtBalance', 'var(--chart-2)', 'area', 1, 'areaStack'],
]);

const NET_WORTH_NET_DEBT_REDUCTION = defineLineMetric(
  'netWorth.netDebtReduction',
  'currency',
  [
    ['netDebtReduction', 'var(--foreground)', 'line'],
    ['annualDebtPaydown', 'var(--chart-1)'],
    ['annualDebtPayoff', 'var(--chart-2)'],
    ['annualDebtIncurred', 'var(--chart-3)', 'bar', -1],
  ],
  { stackOffset: 'sign' }
);

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
  TAXES_MARGINAL_RATES,
  TAXES_EFFECTIVE_RATES,
  TAXES_ANNUAL_AMOUNTS,
  TAXES_CUMULATIVE_AMOUNTS,
  TAXES_TAXABLE_INCOME,
  TAXES_ADJUSTED_GROSS_INCOME,
  TAXES_INVESTMENT_INCOME,
  TAXES_RETIREMENT_DISTRIBUTIONS,
  TAXES_TAX_FREE_INCOME,
  TAXES_ORDINARY_INCOME,
  TAXES_CAPITAL_GAINS_AND_DIVIDENDS,
  TAXES_EARLY_WITHDRAWAL_PENALTIES,
  TAXES_ADJUSTMENTS_AND_DEDUCTIONS,
  TAXES_SOCIAL_SECURITY_INCOME,
  TAXES_SOCIAL_SECURITY_TAXABLE_PERCENTAGE,
  RETURNS_RATES,
  RETURNS_CAGR,
  RETURNS_ANNUAL_AMOUNTS,
  RETURNS_CUMULATIVE_AMOUNTS,
  RETURNS_TAX_CATEGORY,
  RETURNS_APPRECIATION,
  CONTRIBUTIONS_ANNUAL_AMOUNTS,
  CONTRIBUTIONS_CUMULATIVE_AMOUNTS,
  CONTRIBUTIONS_TAX_CATEGORY,
  CONTRIBUTIONS_EMPLOYER_MATCH,
  CONTRIBUTIONS_SHORTFALL,
  WITHDRAWALS_ANNUAL_AMOUNTS,
  WITHDRAWALS_CUMULATIVE_AMOUNTS,
  WITHDRAWALS_TAX_CATEGORY,
  WITHDRAWALS_REALIZED_GAINS,
  WITHDRAWALS_REQUIRED_MINIMUM_DISTRIBUTIONS,
  WITHDRAWALS_EARLY_WITHDRAWALS,
  WITHDRAWALS_SHORTFALL,
  WITHDRAWALS_WITHDRAWAL_RATE,
  NET_WORTH_ASSET_CLASS,
  NET_WORTH_TAX_CATEGORY,
  NET_WORTH_NET_PORTFOLIO_CHANGE,
  NET_WORTH_NET_WORTH,
  NET_WORTH_NET_WORTH_CHANGE,
  NET_WORTH_ASSET_EQUITY,
  NET_WORTH_NET_ASSET_CHANGE,
  NET_WORTH_DEBTS,
  NET_WORTH_NET_DEBT_REDUCTION,
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
