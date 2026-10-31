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
import type {
  BarChartDefinition,
  ChartKind,
  MetricCategory,
  MetricDefinition,
  MetricSeriesDefinition,
  MetricValueFormat,
  PieChartDefinition,
  PlotKind,
} from './plot-types';

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

// RMDs and Roth conversions are the two taxable events of a tax-deferred account: both leave
// the tax-deferred side and raise ordinary income, and `portfolio.conversions` is already folded
// into the tax-deferred distribution line the taxes views show. They share this view so the
// conversion that raised taxable income has a visible source; the conversion series is labelled
// as a transfer between accounts, never as a withdrawal or a distribution.
const WITHDRAWALS_REQUIRED_MINIMUM_DISTRIBUTIONS = defineLineMetric(
  'withdrawals.requiredMinimumDistributions',
  'currency',
  [
    ['annualRequiredMinimumDistributions', 'var(--chart-2)'],
    ['cumulativeRequiredMinimumDistributions', 'var(--chart-4)'],
    ['annualRothConversions', 'var(--chart-1)'],
    ['cumulativeRothConversions', 'var(--chart-3)'],
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

// ================================
// SINGLE-AGE BAR AND PIE VIEWS (P4-P6, second half)
// ================================
//
// The single-age bar charts and the pie do not plot a series list over time: they render one
// bar (or slice) per series at the selected age, with their own labels, a per-view segment
// grouping (the taxes chart draws one "Taxable Income" bar out of two segments) and a per-view
// zero filter. These views keep that shape declaratively here instead of in each chart, and the
// frozen tests pin every key, colour, sign, label, grouping and formatter.

/** One bar/pie row: `[key, colour, label, shortLabel?, sign?]`. */
type BarRow = readonly [key: string, color: string, label: string, shortLabel?: string, sign?: 1 | -1];

const barView = (
  format: MetricValueFormat,
  rows: readonly BarRow[],
  options: { segments?: readonly number[]; keepZero?: boolean } = {}
): BarChartDefinition => ({
  format,
  series: rows.map(([key, color, label, shortLabel, sign]) => ({
    key,
    color,
    label,
    ...(shortLabel === undefined ? {} : { shortLabel }),
    ...(sign === -1 ? { sign: -1 as const } : {}),
  })),
  ...(options.segments === undefined ? {} : { segments: options.segments }),
  ...(options.keepZero ? { filterZeroValues: false } : {}),
});

const pieView = (rows: ReadonlyArray<readonly [key: string, color: string, label: string, sign?: 1 | -1]>): PieChartDefinition => ({
  series: rows.map(([key, color, label, sign]) => ({
    key,
    color,
    label,
    ...(sign === -1 ? { sign: -1 as const } : {}),
  })),
});

/** Every single-age bar view the registry owns, keyed by `<category>.<dataViewId>`. */
export const BAR_CHARTS: Readonly<Record<string, BarChartDefinition>> = {
  // Taxes: the bracket reference lines stay in the chart; only the bars move here.
  'taxes.marginalRates': barView(
    'percent',
    [
      ['topMarginalFederalIncomeTaxRate', 'var(--chart-2)', 'Top Marginal Fed. Income Tax Rate', 'Fed. Income Rate'],
      ['topMarginalCapitalGainsTaxRate', 'var(--chart-4)', 'Top Marginal Cap Gains Tax Rate', 'Cap Gains Rate'],
    ],
    { keepZero: true }
  ),
  'taxes.effectiveRates': barView(
    'percent',
    [
      ['effectiveFederalIncomeTaxRate', 'var(--chart-2)', 'Effective Fed. Income Tax Rate', 'Fed. Income Rate'],
      ['effectiveCapitalGainsTaxRate', 'var(--chart-4)', 'Effective Cap Gains Tax Rate', 'Cap Gains Rate'],
    ],
    { keepZero: true }
  ),
  'taxes.annualAmounts': barView('currency', [
    ['annualFederalIncomeTax', 'var(--chart-1)', 'Annual Fed. Income Tax', 'Fed. Income Tax'],
    ['annualFicaTax', 'var(--chart-2)', 'Annual FICA Tax', 'FICA Tax'],
    ['annualCapitalGainsTax', 'var(--chart-3)', 'Annual Cap Gains Tax', 'Cap Gains Tax'],
    ['annualNiit', 'var(--chart-4)', 'Annual NIIT', 'NIIT'],
    ['annualEarlyWithdrawalPenalties', 'var(--chart-5)', 'Annual EW Penalties', 'EW Penalty'],
  ]),
  'taxes.cumulativeAmounts': barView('currency', [
    ['cumulativeFederalIncomeTax', 'var(--chart-1)', 'Cumul. Fed. Income Tax', 'Cumul. Fed. Income Tax'],
    ['cumulativeFicaTax', 'var(--chart-2)', 'Cumul. FICA Tax', 'Cumul. FICA Tax'],
    ['cumulativeCapitalGainsTax', 'var(--chart-3)', 'Cumul. Cap Gains Tax', 'Cumul. CG Tax'],
    ['cumulativeNiit', 'var(--chart-4)', 'Cumul. NIIT', 'Cumul. NIIT'],
    ['cumulativeEarlyWithdrawalPenalties', 'var(--chart-5)', 'Cumul. EW Penalties', 'Cumul. EW Penalty'],
  ]),
  'taxes.taxableIncome': barView(
    'currency',
    [
      ['taxableIncomeTaxedAsOrdinary', 'var(--chart-1)', 'Taxable Income', 'Taxable Income'],
      ['taxableIncomeTaxedAsCapitalGains', 'var(--chart-2)', 'Taxable Income', 'Taxable Income'],
    ],
    { segments: [2] }
  ),
  'taxes.adjustedGrossIncome': barView(
    'currency',
    [
      ['adjustedIncomeTaxedAsOrdinary', 'var(--chart-1)', 'Adjusted Gross Income', 'Adjusted Gross Income'],
      ['adjustedIncomeTaxedAsCapitalGains', 'var(--chart-2)', 'Adjusted Gross Income', 'Adjusted Gross Income'],
    ],
    { segments: [2] }
  ),
  'taxes.investmentIncome': barView('currency', [
    ['taxableInterestIncome', 'var(--chart-1)', 'Interest Income', 'Interest Income'],
    ['taxableDividendIncome', 'var(--chart-2)', 'Dividend Income', 'Dividend Income'],
    ['realizedGains', 'var(--chart-3)', 'Realized Gains', 'Realized Gains'],
  ]),
  'taxes.retirementDistributions': barView('currency', [
    ['taxDeferredWithdrawals', 'var(--chart-1)', 'Tax-Deferred Withdrawals', 'Tax-Deferred'],
    ['earlyRothEarningsWithdrawals', 'var(--chart-2)', 'Early Roth Earnings Withdrawals', 'Early Roth'],
  ]),
  'taxes.taxFreeIncome': barView('currency', [['taxFreeIncome', 'var(--chart-2)', 'Tax-Free Income', 'Tax-Free Income']]),
  'taxes.ordinaryIncome': barView('currency', [
    ['earnedIncome', 'var(--chart-1)', 'Earned Income', 'Earned Income'],
    ['socialSecurityIncome', 'var(--chart-2)', 'Social Security', 'Soc. Sec.'],
    ['taxableInterestIncome', 'var(--chart-3)', 'Interest Income', 'Interest Income'],
    ['taxableRetirementDistributions', 'var(--chart-4)', 'Retirement Distributions', 'Retirement Dist.'],
  ]),
  'taxes.capitalGainsAndDividends': barView('currency', [
    ['realizedGains', 'var(--chart-1)', 'Realized Gains', 'Realized Gains'],
    ['taxableDividendIncome', 'var(--chart-2)', 'Dividend Income', 'Dividend Income'],
  ]),
  'taxes.earlyWithdrawalPenalties': barView(
    'currency',
    [
      ['annualEarlyWithdrawalPenalties', 'var(--chart-2)', 'Annual EW Penalties', 'Annual EW Penalty'],
      ['cumulativeEarlyWithdrawalPenalties', 'var(--chart-4)', 'Cumul. EW Penalties', 'Cumul. EW Penalty'],
    ],
    { keepZero: true }
  ),
  'taxes.adjustmentsAndDeductions': barView('currency', [
    ['taxDeductibleContributions', 'var(--chart-1)', 'Tax-Deductible Contributions', 'Deductible Contrib.'],
    ['capitalLossDeduction', 'var(--chart-2)', 'Capital Loss Deduction', 'CL Deduction'],
    ['standardDeduction', 'var(--chart-3)', 'Standard Deduction', 'Std. Deduction'],
  ]),
  'taxes.socialSecurityIncome': barView(
    'currency',
    [
      ['socialSecurityIncome', 'var(--chart-1)', 'Social Security', 'Soc. Sec.'],
      ['taxableSocialSecurityIncome', 'var(--chart-2)', 'Taxable Social Security', 'Taxable Soc. Sec.'],
    ],
    { keepZero: true }
  ),
  'taxes.socialSecurityTaxablePercentage': barView(
    'percent',
    [
      ['maxTaxablePercentage', 'var(--chart-2)', 'Max Taxable %', 'Max Taxable %'],
      ['actualTaxablePercentage', 'var(--chart-4)', 'Actual Taxable %', 'Actual Taxable %'],
    ],
    { keepZero: true }
  ),

  // Returns.
  'returns.rates': barView('percent', [
    ['realStockReturnRate', 'var(--chart-2)', 'Real Stock Rate', 'Stock Rate'],
    ['realBondReturnRate', 'var(--chart-3)', 'Real Bond Rate', 'Bond Rate'],
    ['realCashReturnRate', 'var(--chart-4)', 'Real Cash Rate', 'Cash Rate'],
    ['inflationRate', 'var(--chart-8)', 'Inflation Rate', 'Inflation Rate'],
  ]),
  'returns.cagr': barView('percent', [
    ['realStockCagr', 'var(--chart-2)', 'Real Stock CAGR', 'Stock CAGR'],
    ['realBondCagr', 'var(--chart-3)', 'Real Bond CAGR', 'Bond CAGR'],
    ['realCashCagr', 'var(--chart-4)', 'Real Cash CAGR', 'Cash CAGR'],
  ]),
  'returns.annualAmounts': barView('currency', [
    ['annualStockGain', 'var(--chart-2)', 'Annual Stock Gain', 'Stock Gain'],
    ['annualBondGain', 'var(--chart-3)', 'Annual Bond Gain', 'Bond Gain'],
    ['annualCashGain', 'var(--chart-4)', 'Annual Cash Gain', 'Cash Gain'],
  ]),
  'returns.cumulativeAmounts': barView('currency', [
    ['cumulativeStockGain', 'var(--chart-2)', 'Cumul. Stock Gain', 'Cumul. Stock'],
    ['cumulativeBondGain', 'var(--chart-3)', 'Cumul. Bond Gain', 'Cumul. Bond'],
    ['cumulativeCashGain', 'var(--chart-4)', 'Cumul. Cash Gain', 'Cumul. Cash'],
  ]),
  'returns.appreciation': barView('currency', [
    ['annualAssetAppreciation', 'var(--chart-2)', 'Annual Appreciation', 'Annual Appreciation'],
    ['cumulativeAssetAppreciation', 'var(--chart-4)', 'Cumul. Appreciation', 'Cumul. Appreciation'],
  ]),
  'returns.taxCategory': barView('currency', [
    ['taxableGains', 'var(--chart-1)', 'Taxable Gains', 'Taxable'],
    ['taxDeferredGains', 'var(--chart-2)', 'Tax-Deferred Gains', 'Tax-Deferred'],
    ['taxFreeGains', 'var(--chart-3)', 'Tax-Free Gains', 'Tax-Free'],
    ['cashSavingsGains', 'var(--chart-4)', 'Cash Gains', 'Cash'],
  ]),

  // Contributions.
  'contributions.annualAmounts': barView('currency', [
    ['annualStockContributions', 'var(--chart-1)', 'Annual Stock Contrib.', 'Stock Contrib.'],
    ['annualBondContributions', 'var(--chart-2)', 'Annual Bond Contrib.', 'Bond Contrib.'],
    ['annualCashContributions', 'var(--chart-3)', 'Annual Cash Contrib.', 'Cash Contrib.'],
  ]),
  'contributions.cumulativeAmounts': barView('currency', [
    ['cumulativeStockContributions', 'var(--chart-1)', 'Cumul. Stock Contrib.', 'Cumul. Stock'],
    ['cumulativeBondContributions', 'var(--chart-2)', 'Cumul. Bond Contrib.', 'Cumul. Bond'],
    ['cumulativeCashContributions', 'var(--chart-3)', 'Cumul. Cash Contrib.', 'Cumul. Cash'],
  ]),
  'contributions.taxCategory': barView('currency', [
    ['taxableContributions', 'var(--chart-1)', 'Taxable Contrib.', 'Taxable'],
    ['taxDeferredContributions', 'var(--chart-2)', 'Tax-Deferred Contrib.', 'Tax-Deferred'],
    ['taxFreeContributions', 'var(--chart-3)', 'Tax-Free Contrib.', 'Tax-Free'],
    ['cashSavingsContributions', 'var(--chart-4)', 'Cash Contrib.', 'Cash'],
  ]),
  'contributions.employerMatch': barView('currency', [
    ['annualEmployerMatch', 'var(--chart-2)', 'Annual Employer Match', 'Annual Match'],
    ['cumulativeEmployerMatch', 'var(--chart-4)', 'Cumul. Employer Match', 'Cumul. Match'],
  ]),
  'contributions.shortfall': barView('currency', [
    ['annualShortfallRepaid', 'var(--chart-2)', 'Annual Shortfall Repaid', 'Shortfall Repaid'],
    ['outstandingShortfall', 'var(--chart-4)', 'Outstanding Shortfall', 'Outstanding Shortfall'],
  ]),

  // Withdrawals.
  'withdrawals.annualAmounts': barView('currency', [
    ['annualStockWithdrawals', 'var(--chart-1)', 'Annual Stock Withdrawals', 'Stock Withdrawals'],
    ['annualBondWithdrawals', 'var(--chart-2)', 'Annual Bond Withdrawals', 'Bond Withdrawals'],
    ['annualCashWithdrawals', 'var(--chart-3)', 'Annual Cash Withdrawals', 'Cash Withdrawals'],
  ]),
  'withdrawals.cumulativeAmounts': barView('currency', [
    ['cumulativeStockWithdrawals', 'var(--chart-1)', 'Cumul. Stock Withdrawals', 'Cumul. Stock'],
    ['cumulativeBondWithdrawals', 'var(--chart-2)', 'Cumul. Bond Withdrawals', 'Cumul. Bond'],
    ['cumulativeCashWithdrawals', 'var(--chart-3)', 'Cumul. Cash Withdrawals', 'Cumul. Cash'],
  ]),
  'withdrawals.taxCategory': barView('currency', [
    ['taxableWithdrawals', 'var(--chart-1)', 'Taxable Withdrawals', 'Taxable'],
    ['taxDeferredWithdrawals', 'var(--chart-2)', 'Tax-Deferred Withdrawals', 'Tax-Deferred'],
    ['taxFreeWithdrawals', 'var(--chart-3)', 'Tax-Free Withdrawals', 'Tax-Free'],
    ['cashSavingsWithdrawals', 'var(--chart-4)', 'Cash Withdrawals', 'Cash'],
  ]),
  'withdrawals.realizedGains': barView('currency', [
    ['annualRealizedGains', 'var(--chart-2)', 'Annual Realized Gains', 'Annual Gains'],
    ['cumulativeRealizedGains', 'var(--chart-4)', 'Cumul. Realized Gains', 'Cumul. Gains'],
  ]),
  'withdrawals.requiredMinimumDistributions': barView('currency', [
    ['annualRequiredMinimumDistributions', 'var(--chart-2)', 'Annual RMDs', 'Annual RMDs'],
    ['cumulativeRequiredMinimumDistributions', 'var(--chart-4)', 'Cumul. RMDs', 'Cumul. RMDs'],
    ['annualRothConversions', 'var(--chart-1)', 'Annual Roth Conversions', 'Annual Roth Conv.'],
    ['cumulativeRothConversions', 'var(--chart-3)', 'Cumul. Roth Conversions', 'Cumul. Roth Conv.'],
  ]),
  'withdrawals.earlyWithdrawals': barView('currency', [
    ['annualEarlyWithdrawals', 'var(--chart-2)', 'Annual Early Withdrawals', 'Annual EWs'],
    ['cumulativeEarlyWithdrawals', 'var(--chart-4)', 'Cumul. Early Withdrawals', 'Cumul. EWs'],
  ]),
  'withdrawals.shortfall': barView('currency', [
    ['annualShortfall', 'var(--chart-2)', 'Annual Shortfall', 'Annual Shortfall'],
    ['outstandingShortfall', 'var(--chart-4)', 'Outstanding Shortfall', 'Outstanding Shortfall'],
  ]),

  // Net worth: the four change views the pie card delegates to its bar chart.
  'netWorth.netPortfolioChange': barView('currency', [
    ['annualReturns', 'var(--chart-1)', 'Annual Returns', 'Returns'],
    ['annualContributions', 'var(--chart-2)', 'Annual Contributions', 'Contributions'],
    ['annualWithdrawals', 'var(--chart-3)', 'Annual Withdrawals', 'Withdrawals', -1],
  ]),
  'netWorth.netAssetChange': barView('currency', [
    ['annualAssetAppreciation', 'var(--chart-1)', 'Annual Asset Appreciation', 'Appreciation'],
    ['annualPurchasedAssetValue', 'var(--chart-2)', 'Annual Purchased Asset Value', 'Purchased Value'],
    ['annualSoldAssetValue', 'var(--chart-3)', 'Annual Sold Asset Value', 'Sold Value', -1],
  ]),
  'netWorth.netDebtReduction': barView('currency', [
    ['annualDebtPaydown', 'var(--chart-1)', 'Annual Debt Paydown', 'Debt Paydown'],
    ['annualDebtPayoff', 'var(--chart-2)', 'Annual Debt Payoff', 'Debt Payoff'],
    ['annualDebtIncurred', 'var(--chart-3)', 'Annual Debt Incurred', 'Debt Incurred', -1],
  ]),
  'netWorth.netWorthChange': barView('currency', [
    ['netPortfolioChange', 'var(--chart-1)', 'Net Portfolio Change', 'Portfolio Change'],
    ['netAssetChange', 'var(--chart-2)', 'Net Asset Change', 'Asset Change'],
    ['netDebtReduction', 'var(--chart-3)', 'Net Debt Reduction', 'Debt Reduction'],
  ]),
};

/** Every pie view the registry owns, keyed by `<category>.<dataViewId>`. */
export const PIE_CHARTS: Readonly<Record<string, PieChartDefinition>> = {
  'netWorth.assetClass': pieView([
    ['stockHoldings', 'var(--chart-1)', 'Stock Holdings'],
    ['bondHoldings', 'var(--chart-2)', 'Bond Holdings'],
    ['cashHoldings', 'var(--chart-3)', 'Cash Holdings'],
  ]),
  'netWorth.taxCategory': pieView([
    ['taxableValue', 'var(--chart-1)', 'Taxable Value'],
    ['taxDeferredValue', 'var(--chart-2)', 'Tax Deferred Value'],
    ['taxFreeValue', 'var(--chart-3)', 'Tax Free Value'],
    ['cashSavings', 'var(--chart-4)', 'Cash Savings'],
  ]),
  'netWorth.netWorth': pieView([
    ['portfolioValue', 'var(--chart-1)', 'Portfolio Value'],
    ['assetValue', 'var(--chart-2)', 'Asset Value'],
    ['debtBalance', 'var(--chart-3)', 'Debt Balance', -1],
  ]),
  'netWorth.assetEquity': pieView([
    ['assetEquity', 'var(--chart-1)', 'Asset Equity'],
    ['securedDebtBalance', 'var(--chart-2)', 'Secured Debt'],
  ]),
  'netWorth.debts': pieView([
    ['unsecuredDebtBalance', 'var(--chart-1)', 'Unsecured Debt'],
    ['securedDebtBalance', 'var(--chart-2)', 'Secured Debt'],
  ]),
};

/** The single-age bar definition for a data view, or `undefined` when it stays on its switch. */
export function resolveBarChart(category: MetricCategory, dataViewId: string): BarChartDefinition | undefined {
  return BAR_CHARTS[metricIdForDataView(category, dataViewId)];
}

/** The pie definition for a data view, or `undefined` when it stays on its switch. */
export function resolvePieChart(category: MetricCategory, dataViewId: string): PieChartDefinition | undefined {
  return PIE_CHARTS[metricIdForDataView(category, dataViewId)];
}

/** Value formatter for a metric's declared `format`. */
export function getMetricValueFormatter(format: MetricValueFormat | undefined): (value: number) => string {
  return format === 'percent' ? PERCENT_FORMATTER : CURRENCY_FORMATTER;
}
