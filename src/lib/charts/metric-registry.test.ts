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
import { formatChartString } from '@/lib/utils';

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

type SeriesFingerprint = readonly (readonly [key: string, color: string, sign: number, label: string, shortLabel: string])[];

/**
 * The rendered series of every ported metric, per chart kind: key, colour, sign, label
 * and short label. A refactor that recolours, renames or re-labels a series must fail
 * this test and be reviewed as a deliberate chart change.
 *
 * The labels are the OLD values. The pre-registry charts only had labels on the
 * single-age bar card (its `labelConfig` desktop/mobile arrays, reproduced verbatim by
 * `keeps the single-age bar labels identical to the old labelConfig arrays` below); the
 * remaining labels are the ones the port introduced, pinned here so a typo cannot slip
 * through. `shortLabel` falls back to `label` when no short form was ever specified.
 */
const FROZEN_SERIES: Record<string, Partial<Record<ChartKind, SeriesFingerprint>>> = {
  'cashFlow.surplusDeficit': {
    line: [
      ['surplusDeficit', 'var(--foreground)', 1, 'Surplus/Deficit', 'Surplus/Deficit'],
      ['income', 'var(--chart-1)', 1, 'Income', 'Income'],
      ['expenses', 'var(--chart-2)', -1, 'Expenses', 'Expenses'],
      ['taxesAndPenalties', 'var(--chart-3)', -1, 'Taxes & Penalties', 'Taxes'],
      ['debtPayments', 'var(--chart-4)', -1, 'Debt Payments', 'Debt'],
    ],
    bar: [
      ['earnedIncome', 'var(--chart-1)', 1, 'Earned Income', 'Earned'],
      ['socialSecurityIncome', 'var(--chart-1)', 1, 'Social Security', 'Soc. Sec.'],
      ['taxFreeIncome', 'var(--chart-1)', 1, 'Tax-Free Income', 'Tax-Free'],
      ['expenses', 'var(--chart-2)', -1, 'Expenses', 'Expenses'],
      ['taxesAndPenalties', 'var(--chart-3)', -1, 'Taxes & Penalties', 'Taxes'],
      ['debtPayments', 'var(--chart-4)', -1, 'Debt Payments', 'Debt'],
    ],
  },
  'cashFlow.cashFlow': {
    line: [
      ['netCashFlow', 'var(--foreground)', 1, 'Net Cash Flow', 'Net Cash Flow'],
      ['income', 'var(--chart-1)', 1, 'Income', 'Income'],
      ['amountLiquidated', 'var(--chart-2)', 1, 'Amount Liquidated', 'Liquidated'],
      ['assetSaleProceeds', 'var(--chart-3)', 1, 'Asset Sale Proceeds', 'Proceeds'],
      ['expenses', 'var(--chart-4)', -1, 'Expenses', 'Expenses'],
      ['taxesAndPenalties', 'var(--chart-5)', -1, 'Taxes & Penalties', 'Taxes'],
      ['debtPayments', 'var(--chart-6)', -1, 'Debt Payments', 'Debt'],
      ['amountInvested', 'var(--chart-7)', -1, 'Amount Invested', 'Invested'],
      ['assetPurchaseOutlay', 'var(--chart-8)', -1, 'Asset Purchase Outlay', 'Outlay'],
    ],
    bar: [
      ['earnedIncome', 'var(--chart-1)', 1, 'Earned Income', 'Earned'],
      ['socialSecurityIncome', 'var(--chart-1)', 1, 'Social Security', 'Soc. Sec.'],
      ['taxFreeIncome', 'var(--chart-1)', 1, 'Tax-Free Income', 'Tax-Free'],
      ['amountLiquidated', 'var(--chart-2)', 1, 'Amount Liquidated', 'Liquidated'],
      ['assetSaleProceeds', 'var(--chart-3)', 1, 'Asset Sale Proceeds', 'Proceeds'],
      ['expenses', 'var(--chart-4)', -1, 'Expenses', 'Expenses'],
      ['taxesAndPenalties', 'var(--chart-5)', -1, 'Taxes & Penalties', 'Taxes'],
      ['debtPayments', 'var(--chart-6)', -1, 'Debt Payments', 'Debt'],
      ['amountInvested', 'var(--chart-7)', -1, 'Amount Invested', 'Invested'],
      ['assetPurchaseOutlay', 'var(--chart-8)', -1, 'Asset Purchase Outlay', 'Outlay'],
    ],
  },
  'cashFlow.incomes': {
    line: [
      ['earnedIncome', 'var(--chart-1)', 1, 'Earned Income', 'Earned'],
      ['socialSecurityIncome', 'var(--chart-2)', 1, 'Social Security', 'Soc. Sec.'],
      ['taxFreeIncome', 'var(--chart-3)', 1, 'Tax-Free Income', 'Tax-Free'],
      ['employerMatch', 'var(--chart-4)', 1, 'Employer Match', 'Match'],
    ],
  },
  'cashFlow.expenses': {
    line: [
      ['expenses', 'var(--chart-1)', 1, 'Expenses', 'Expenses'],
      ['taxesAndPenalties', 'var(--chart-2)', 1, 'Taxes & Penalties', 'Taxes'],
      ['debtPayments', 'var(--chart-3)', 1, 'Debt Payments', 'Debt'],
    ],
  },
  'cashFlow.savingsRate': {
    line: [['savingsRate', 'var(--chart-3)', 1, 'Savings Rate', 'Savings Rate']],
  },
  realNetWorth: {
    line: [['realNetWorth', 'var(--chart-1)', 1, 'Net Worth (today\u2019s $)', 'Real NW']],
    area: [['realNetWorth', 'var(--chart-1)', 1, 'Net Worth (today\u2019s $)', 'Real NW']],
    bar: [['realNetWorth', 'var(--chart-1)', 1, 'Net Worth (today\u2019s $)', 'Real NW']],
    pie: [['realNetWorth', 'var(--chart-1)', 1, 'Net Worth (today\u2019s $)', 'Real NW']],
  },
};

const fingerprint = (metricId: string, chartKind: ChartKind): Array<[string, string, number, string, string]> => {
  const metric = getMetric(metricId);
  if (!metric) throw new Error(`Metric ${metricId} is not registered`);
  return resolveSeries(metric, chartKind).map((series) => [series.key, series.color, series.sign, series.label, series.shortLabel]);
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

/**
 * Frozen series of the five categories P4-P6 migrated, in the order the old switch declared
 * them: `[key, colour, plot, sign, stackId?]`. These are the OLD values, transcribed from each
 * chart's `switch (dataView)` before it was deleted; the test below also pins each metric's id,
 * formatter and `stackOffset`, and asserts every label is `formatChartString(key)` (the same
 * humaniser the chart tooltips use).
 */
type FrozenLineSeries = readonly [key: string, color: string, plot: string, sign: 1 | -1, stackId?: string];

const FROZEN_LINE_METRICS: Record<string, { format: 'currency' | 'percent'; stackOffset?: 'sign'; series: readonly FrozenLineSeries[] }> = {
  'taxes.marginalRates': {
    format: 'percent',
    series: [
      ['topMarginalFederalIncomeTaxRate', 'var(--chart-2)', 'line', 1],
      ['topMarginalCapitalGainsTaxRate', 'var(--chart-4)', 'line', 1],
    ],
  },
  'taxes.effectiveRates': {
    format: 'percent',
    series: [
      ['effectiveFederalIncomeTaxRate', 'var(--chart-2)', 'line', 1],
      ['effectiveCapitalGainsTaxRate', 'var(--chart-4)', 'line', 1],
    ],
  },
  'taxes.annualAmounts': {
    format: 'currency',
    series: [
      ['annualFederalIncomeTax', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['annualFicaTax', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['annualCapitalGainsTax', 'var(--chart-3)', 'bar', 1, 'barStack'],
      ['annualNiit', 'var(--chart-4)', 'bar', 1, 'barStack'],
      ['annualEarlyWithdrawalPenalties', 'var(--chart-5)', 'bar', 1, 'barStack'],
    ],
  },
  'taxes.cumulativeAmounts': {
    format: 'currency',
    series: [
      ['cumulativeFederalIncomeTax', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['cumulativeFicaTax', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['cumulativeCapitalGainsTax', 'var(--chart-3)', 'bar', 1, 'barStack'],
      ['cumulativeNiit', 'var(--chart-4)', 'bar', 1, 'barStack'],
      ['cumulativeEarlyWithdrawalPenalties', 'var(--chart-5)', 'bar', 1, 'barStack'],
    ],
  },
  'taxes.taxableIncome': {
    format: 'currency',
    stackOffset: 'sign',
    series: [
      ['taxableIncome', 'var(--foreground)', 'line', 1],
      ['incomeTaxedAsOrdinary', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['incomeTaxedAsLtcg', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['taxDeductibleContributions', 'var(--chart-3)', 'bar', -1, 'barStack'],
      ['standardDeduction', 'var(--chart-4)', 'bar', -1, 'barStack'],
      ['capitalLossDeduction', 'var(--chart-5)', 'bar', -1, 'barStack'],
    ],
  },
  'taxes.adjustedGrossIncome': {
    format: 'currency',
    stackOffset: 'sign',
    series: [
      ['adjustedGrossIncome', 'var(--foreground)', 'line', 1],
      ['incomeTaxedAsOrdinary', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['incomeTaxedAsLtcg', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['taxDeductibleContributions', 'var(--chart-3)', 'bar', -1, 'barStack'],
      ['capitalLossDeduction', 'var(--chart-5)', 'bar', -1, 'barStack'],
    ],
  },
  'taxes.investmentIncome': {
    format: 'currency',
    series: [
      ['taxableInterestIncome', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['taxableDividendIncome', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['realizedGains', 'var(--chart-3)', 'bar', 1, 'barStack'],
    ],
  },
  'taxes.retirementDistributions': {
    format: 'currency',
    series: [
      ['taxDeferredWithdrawals', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['earlyRothEarningsWithdrawals', 'var(--chart-2)', 'bar', 1, 'barStack'],
    ],
  },
  'taxes.taxFreeIncome': { format: 'currency', series: [['taxFreeIncome', 'var(--chart-2)', 'line', 1]] },
  'taxes.ordinaryIncome': {
    format: 'currency',
    series: [
      ['earnedIncome', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['taxableSocialSecurityIncome', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['taxableInterestIncome', 'var(--chart-3)', 'bar', 1, 'barStack'],
      ['taxableRetirementDistributions', 'var(--chart-4)', 'bar', 1, 'barStack'],
    ],
  },
  'taxes.capitalGainsAndDividends': {
    format: 'currency',
    series: [
      ['realizedGains', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['taxableDividendIncome', 'var(--chart-2)', 'bar', 1, 'barStack'],
    ],
  },
  'taxes.earlyWithdrawalPenalties': {
    format: 'currency',
    series: [
      ['annualEarlyWithdrawalPenalties', 'var(--chart-2)', 'bar', 1],
      ['cumulativeEarlyWithdrawalPenalties', 'var(--chart-4)', 'bar', 1],
    ],
  },
  'taxes.adjustmentsAndDeductions': {
    format: 'currency',
    series: [
      ['taxDeductibleContributions', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['capitalLossDeduction', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['standardDeduction', 'var(--chart-3)', 'bar', 1, 'barStack'],
    ],
  },
  'taxes.socialSecurityIncome': {
    format: 'currency',
    series: [
      ['socialSecurityIncome', 'var(--chart-1)', 'bar', 1],
      ['taxableSocialSecurityIncome', 'var(--chart-2)', 'bar', 1],
    ],
  },
  'taxes.socialSecurityTaxablePercentage': {
    format: 'percent',
    series: [
      ['maxTaxablePercentage', 'var(--chart-2)', 'line', 1],
      ['actualTaxablePercentage', 'var(--chart-4)', 'line', 1],
    ],
  },
  'returns.rates': {
    format: 'percent',
    series: [
      ['realStockReturnRate', 'var(--chart-2)', 'line', 1],
      ['realBondReturnRate', 'var(--chart-3)', 'line', 1],
      ['realCashReturnRate', 'var(--chart-4)', 'line', 1],
      ['inflationRate', 'var(--chart-8)', 'line', 1],
    ],
  },
  'returns.cagr': {
    format: 'percent',
    series: [
      ['realStockCagr', 'var(--chart-2)', 'line', 1],
      ['realBondCagr', 'var(--chart-3)', 'line', 1],
      ['realCashCagr', 'var(--chart-4)', 'line', 1],
    ],
  },
  'returns.annualAmounts': {
    format: 'currency',
    series: [
      ['totalAnnualGains', 'var(--foreground)', 'line', 1],
      ['annualStockGain', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['annualBondGain', 'var(--chart-3)', 'bar', 1, 'barStack'],
      ['annualCashGain', 'var(--chart-4)', 'bar', 1, 'barStack'],
    ],
  },
  'returns.cumulativeAmounts': {
    format: 'currency',
    series: [
      ['totalCumulativeGains', 'var(--foreground)', 'line', 1],
      ['cumulativeStockGain', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['cumulativeBondGain', 'var(--chart-3)', 'bar', 1, 'barStack'],
      ['cumulativeCashGain', 'var(--chart-4)', 'bar', 1, 'barStack'],
    ],
  },
  'returns.taxCategory': {
    format: 'currency',
    series: [
      ['totalAnnualGains', 'var(--foreground)', 'line', 1],
      ['taxableGains', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['taxDeferredGains', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['taxFreeGains', 'var(--chart-3)', 'bar', 1, 'barStack'],
      ['cashSavingsGains', 'var(--chart-4)', 'bar', 1, 'barStack'],
    ],
  },
  'returns.appreciation': {
    format: 'currency',
    series: [
      ['annualAssetAppreciation', 'var(--chart-2)', 'bar', 1],
      ['cumulativeAssetAppreciation', 'var(--chart-4)', 'bar', 1],
    ],
  },
  'contributions.annualAmounts': {
    format: 'currency',
    series: [
      ['annualStockContributions', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['annualBondContributions', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['annualCashContributions', 'var(--chart-3)', 'bar', 1, 'barStack'],
    ],
  },
  'contributions.cumulativeAmounts': {
    format: 'currency',
    series: [
      ['cumulativeStockContributions', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['cumulativeBondContributions', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['cumulativeCashContributions', 'var(--chart-3)', 'bar', 1, 'barStack'],
    ],
  },
  'contributions.taxCategory': {
    format: 'currency',
    series: [
      ['taxableContributions', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['taxDeferredContributions', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['taxFreeContributions', 'var(--chart-3)', 'bar', 1, 'barStack'],
      ['cashSavingsContributions', 'var(--chart-4)', 'bar', 1, 'barStack'],
    ],
  },
  'contributions.employerMatch': {
    format: 'currency',
    series: [
      ['annualEmployerMatch', 'var(--chart-2)', 'bar', 1],
      ['cumulativeEmployerMatch', 'var(--chart-4)', 'bar', 1],
    ],
  },
  'contributions.shortfall': {
    format: 'currency',
    series: [
      ['annualShortfallRepaid', 'var(--chart-2)', 'bar', 1],
      ['outstandingShortfall', 'var(--chart-4)', 'bar', 1],
    ],
  },
  'withdrawals.annualAmounts': {
    format: 'currency',
    series: [
      ['annualStockWithdrawals', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['annualBondWithdrawals', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['annualCashWithdrawals', 'var(--chart-3)', 'bar', 1, 'barStack'],
    ],
  },
  'withdrawals.cumulativeAmounts': {
    format: 'currency',
    series: [
      ['cumulativeStockWithdrawals', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['cumulativeBondWithdrawals', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['cumulativeCashWithdrawals', 'var(--chart-3)', 'bar', 1, 'barStack'],
    ],
  },
  'withdrawals.taxCategory': {
    format: 'currency',
    series: [
      ['taxableWithdrawals', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['taxDeferredWithdrawals', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['taxFreeWithdrawals', 'var(--chart-3)', 'bar', 1, 'barStack'],
      ['cashSavingsWithdrawals', 'var(--chart-4)', 'bar', 1, 'barStack'],
    ],
  },
  'withdrawals.realizedGains': {
    format: 'currency',
    series: [
      ['annualRealizedGains', 'var(--chart-2)', 'bar', 1],
      ['cumulativeRealizedGains', 'var(--chart-4)', 'bar', 1],
    ],
  },
  'withdrawals.requiredMinimumDistributions': {
    format: 'currency',
    series: [
      ['annualRequiredMinimumDistributions', 'var(--chart-2)', 'bar', 1],
      ['cumulativeRequiredMinimumDistributions', 'var(--chart-4)', 'bar', 1],
    ],
  },
  'withdrawals.earlyWithdrawals': {
    format: 'currency',
    series: [
      ['annualEarlyWithdrawals', 'var(--chart-2)', 'bar', 1],
      ['cumulativeEarlyWithdrawals', 'var(--chart-4)', 'bar', 1],
    ],
  },
  'withdrawals.shortfall': {
    format: 'currency',
    series: [
      ['annualShortfall', 'var(--chart-2)', 'bar', 1],
      ['outstandingShortfall', 'var(--chart-4)', 'bar', 1],
    ],
  },
  'withdrawals.withdrawalRate': { format: 'percent', series: [['withdrawalRate', 'var(--chart-2)', 'line', 1]] },
  'netWorth.assetClass': {
    format: 'currency',
    series: [
      ['stockHoldings', 'var(--chart-1)', 'area', 1, 'areaStack'],
      ['bondHoldings', 'var(--chart-2)', 'area', 1, 'areaStack'],
      ['cashHoldings', 'var(--chart-3)', 'area', 1, 'areaStack'],
    ],
  },
  'netWorth.taxCategory': {
    format: 'currency',
    series: [
      ['taxableValue', 'var(--chart-1)', 'area', 1, 'areaStack'],
      ['taxDeferredValue', 'var(--chart-2)', 'area', 1, 'areaStack'],
      ['taxFreeValue', 'var(--chart-3)', 'area', 1, 'areaStack'],
      ['cashSavings', 'var(--chart-4)', 'area', 1, 'areaStack'],
    ],
  },
  'netWorth.netPortfolioChange': {
    format: 'currency',
    stackOffset: 'sign',
    series: [
      ['netPortfolioChange', 'var(--foreground)', 'line', 1],
      ['annualReturns', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['annualContributions', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['annualWithdrawals', 'var(--chart-3)', 'bar', -1, 'barStack'],
    ],
  },
  'netWorth.netWorth': {
    format: 'currency',
    stackOffset: 'sign',
    series: [
      ['netWorth', 'var(--foreground)', 'line', 1],
      ['portfolioValue', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['assetValue', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['debtBalance', 'var(--chart-3)', 'bar', -1, 'barStack'],
    ],
  },
  'netWorth.netWorthChange': {
    format: 'currency',
    stackOffset: 'sign',
    series: [
      ['netWorthChange', 'var(--foreground)', 'line', 1],
      ['netPortfolioChange', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['netAssetChange', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['netDebtReduction', 'var(--chart-3)', 'bar', 1, 'barStack'],
    ],
  },
  'netWorth.assetEquity': {
    format: 'currency',
    stackOffset: 'sign',
    series: [
      ['assetEquity', 'var(--foreground)', 'line', 1],
      ['assetValue', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['securedDebtBalance', 'var(--chart-2)', 'bar', -1, 'barStack'],
    ],
  },
  'netWorth.netAssetChange': {
    format: 'currency',
    stackOffset: 'sign',
    series: [
      ['netAssetChange', 'var(--foreground)', 'line', 1],
      ['annualAssetAppreciation', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['annualPurchasedAssetValue', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['annualSoldAssetValue', 'var(--chart-3)', 'bar', -1, 'barStack'],
    ],
  },
  'netWorth.debts': {
    format: 'currency',
    series: [
      ['unsecuredDebtBalance', 'var(--chart-1)', 'area', 1, 'areaStack'],
      ['securedDebtBalance', 'var(--chart-2)', 'area', 1, 'areaStack'],
    ],
  },
  'netWorth.netDebtReduction': {
    format: 'currency',
    stackOffset: 'sign',
    series: [
      ['netDebtReduction', 'var(--foreground)', 'line', 1],
      ['annualDebtPaydown', 'var(--chart-1)', 'bar', 1, 'barStack'],
      ['annualDebtPayoff', 'var(--chart-2)', 'bar', 1, 'barStack'],
      ['annualDebtIncurred', 'var(--chart-3)', 'bar', -1, 'barStack'],
    ],
  },
};

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

  it('migrates every non-custom view and leaves only the per-entity escape hatches legacy', () => {
    // P4-P6 migrated the time-series switch of all five remaining categories, so the only ids
    // that still resolve to a bespoke switch are the `custom` views (per-account/asset/debt
    // series, which cannot be expressed as a fixed key list).
    const legacy: string[] = [];

    for (const category of DATA_VIEW_CATEGORIES) {
      for (const dataViewId of dataViewIdsForCategory(category)) {
        if (resolveDataView(category, dataViewId).status === 'legacy') legacy.push(`${category}.${dataViewId}`);
      }
    }

    expect(legacy).toEqual(['netWorth.custom', 'cashFlow.custom', 'returns.custom', 'contributions.custom', 'withdrawals.custom']);
  });

  it('does not register the net-worth canary as a persisted view', () => {
    // The canary is a display-only metric with its own id; no persisted `dataView` id maps to it.
    expect(getMetric(REAL_NET_WORTH_METRIC_ID)).toBeDefined();
    expect(resolveDataView('netWorth', 'realNetWorth').status).toBe('legacy');
    expect(metricIdForDataView('netWorth', 'netWorth')).not.toBe(REAL_NET_WORTH_METRIC_ID);
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

describe('series key, colour and label parity', () => {
  for (const [metricId, byChartKind] of Object.entries(FROZEN_SERIES)) {
    for (const [chartKind, expected] of Object.entries(byChartKind) as Array<[ChartKind, SeriesFingerprint]>) {
      it(`renders ${metricId} as ${chartKind} with frozen keys, colours and labels`, () => {
        expect(fingerprint(metricId, chartKind)).toEqual(expected.map((series) => [...series]));
      });
    }
  }

  it('keeps the single-age bar labels identical to the old labelConfig arrays', () => {
    // Verbatim from the pre-registry `single-simulation-cash-flow-bar-chart.tsx`
    // `labelConfig`, which was the only place the old charts spelled out labels:
    // desktop labels first, then the mobile short labels.
    const OLD_LABEL_CONFIG = {
      surplusDeficit: {
        desktop: ['Earned Income', 'Social Security', 'Tax-Free Income', 'Expenses', 'Taxes & Penalties', 'Debt Payments'],
        mobile: ['Earned', 'Soc. Sec.', 'Tax-Free', 'Expenses', 'Taxes', 'Debt'],
      },
      cashFlow: {
        desktop: [
          'Earned Income',
          'Social Security',
          'Tax-Free Income',
          'Amount Liquidated',
          'Asset Sale Proceeds',
          'Expenses',
          'Taxes & Penalties',
          'Debt Payments',
          'Amount Invested',
          'Asset Purchase Outlay',
        ],
        mobile: ['Earned', 'Soc. Sec.', 'Tax-Free', 'Liquidated', 'Proceeds', 'Expenses', 'Taxes', 'Debt', 'Invested', 'Outlay'],
      },
    } as const;

    for (const [dataViewId, expected] of Object.entries(OLD_LABEL_CONFIG)) {
      const metric = getMetric(`cashFlow.${dataViewId}`);
      if (!metric) throw new Error(`missing metric cashFlow.${dataViewId}`);
      const series = resolveSeries(metric, 'bar');

      expect(
        series.map((entry) => entry.label),
        dataViewId
      ).toEqual([...expected.desktop]);
      expect(
        series.map((entry) => entry.shortLabel),
        dataViewId
      ).toEqual([...expected.mobile]);
    }
  });

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

describe('migrated time-series categories: frozen parity', () => {
  it('freezes every metric the migration added, so none can slip in unfrozen', () => {
    const migratedIds = METRIC_DEFINITIONS.filter(
      (metric) =>
        ['taxes', 'returns', 'contributions', 'withdrawals', 'netWorth'].includes(metric.category) && metric.id !== REAL_NET_WORTH_METRIC_ID
    )
      .map((metric) => metric.id)
      .sort();

    expect(Object.keys(FROZEN_LINE_METRICS).sort()).toEqual(migratedIds);
  });

  for (const [metricId, expected] of Object.entries(FROZEN_LINE_METRICS)) {
    it(`freezes ${metricId}`, () => {
      const metric = getMetric(metricId);
      if (!metric) throw new Error(`metric ${metricId} is not registered`);

      expect(metric.category).toBe(metricId.split('.')[0]);
      expect(metric.chartKinds).toEqual(['line']);
      expect(metric.format).toBe(expected.format);
      expect(metric.stackOffset).toBe(expected.stackOffset);

      const resolved = resolveSeries(metric, 'line');
      expect(resolved.map((series) => [series.key, series.color, series.plot, series.sign, series.stackId])).toEqual(
        expected.series.map(([key, color, plot, sign, stackId]) => [key, color, plot, sign, stackId])
      );

      // Labels come from the tooltip humaniser, so a label cannot drift from its tooltip.
      expect(resolved.map((series) => series.label)).toEqual(expected.series.map(([key]) => formatChartString(key)));
      expect(resolved.map((series) => series.shortLabel)).toEqual(resolved.map((series) => series.label));
    });
  }
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
