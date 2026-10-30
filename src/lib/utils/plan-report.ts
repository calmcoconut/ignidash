/**
 * Printed report model (P4-P5).
 *
 * The report is a *decision summary*, not a screenshot of the app: the key results, the
 * assumptions behind them, the milestones, and the three year-by-year tables that read
 * well on paper (net worth, cash flow, taxes). Charts, per-account breakdowns and the
 * twenty-plus-column data tables are left on screen — they are for exploring, and they do
 * not fit a portrait page.
 *
 * Every value here comes from the SAME extractors the on-screen views use
 * (`TableDataExtractor`, `KeyMetricsExtractor`, the annotation extractor), and the column
 * formatters are the on-screen table columns' own `format` functions with shorter titles
 * so a portrait page fits. Nothing is recomputed, so paper and screen cannot disagree.
 *
 * Pure and deterministic: no clock reads, no mutation of the simulation or the inputs.
 */

import type { SimulationResult } from '@/lib/calc/simulation-engine';
import type { KeyMetrics } from '@/lib/types/key-metrics';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import type { TableColumn } from '@/lib/types/table-column';
import { TableDataExtractor } from '@/lib/calc/data-extractors/table-data-extractor';
import { extractSimulationEvents, type SimulationEvent } from '@/lib/calc/data-extractors/annotations-extractor';
import { formatCurrency, formatPercentage } from '@/lib/utils/number-formatters';
import { generateCashFlowTableColumns, generateNetWorthTableColumns, generateTaxesTableColumns } from '@/lib/utils/table-formatters';

/** A column of a printed table: the on-screen formatter, optionally a shorter title. */
export interface ReportColumn {
  key: string;
  title: string;
  format: (value: unknown) => string;
}

export type ReportSectionId = 'netWorth' | 'cashFlow' | 'taxes';

/** One printed table. `pageBreakBefore` keeps a table off the tail of the previous page. */
export interface ReportSection {
  id: ReportSectionId;
  title: string;
  /** One sentence telling the reader what this table answers. Also printed. */
  summary: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  pageBreakBefore: boolean;
}

export interface ReportFact {
  label: string;
  value: string;
}

export interface PlanReport {
  title: string;
  planName: string;
  /** Simulation start date from the run's context (deterministic, never "now"). */
  asOf: string;
  facts: ReportFact[];
  assumptions: ReportFact[];
  events: ReportFact[];
  sections: ReportSection[];
}

export interface PlanReportInput {
  planName: string;
  inputs: SimulatorInputs;
  simulation: SimulationResult;
  keyMetrics: KeyMetrics;
  /** Human-readable mode label, e.g. `Fixed returns` or `Stochastic · seed 12345`. */
  modeLabel: string;
}

/** Report columns for net worth: the trajectory a person tracks over the years. */
const NET_WORTH_COLUMNS: ReadonlyArray<{ key: string; title?: string }> = [
  { key: 'year' },
  { key: 'age' },
  { key: 'phaseName', title: 'Phase' },
  { key: 'totalPortfolioValue', title: 'Portfolio' },
  { key: 'assetValue', title: 'Assets' },
  { key: 'totalDebtBalance', title: 'Debts' },
  { key: 'netWorth', title: 'Net worth' },
];

/** Cash flow: whether the plan pays for itself each year, and where the money goes. */
const CASH_FLOW_COLUMNS: ReadonlyArray<{ key: string; title?: string }> = [
  { key: 'year' },
  { key: 'age' },
  { key: 'earnedIncome', title: 'Earned' },
  { key: 'socialSecurityIncome', title: 'Social Security' },
  { key: 'totalTaxesAndPenalties', title: 'Taxes' },
  { key: 'expenses', title: 'Expenses' },
  { key: 'debtPayments', title: 'Debt' },
  { key: 'surplusDeficit', title: 'Surplus/Deficit' },
  { key: 'netCashFlow', title: 'Net cash flow' },
];

/**
 * Taxes: the annual liability by type plus the effective rate. Deliberately no FICA
 * column — it is inside the annual total, and the tax layer is being reworked; the total
 * is the stable figure a reader wants on paper.
 */
const TAXES_COLUMNS: ReadonlyArray<{ key: string; title?: string }> = [
  { key: 'year' },
  { key: 'age' },
  { key: 'grossIncome', title: 'Gross income' },
  { key: 'taxableIncome', title: 'Taxable income' },
  { key: 'annualFederalIncomeTax', title: 'Federal' },
  { key: 'annualCapitalGainsTax', title: 'Capital gains' },
  { key: 'annualNiit', title: 'NIIT' },
  { key: 'annualEarlyWithdrawalPenalties', title: 'Penalties' },
  { key: 'annualTotalTaxesAndPenalties', title: 'Total taxes' },
  { key: 'effectiveFederalIncomeTaxRate', title: 'Effective rate' },
];

const FILING_STATUS_LABELS: Readonly<Record<string, string>> = {
  single: 'Single',
  marriedFilingJointly: 'Married filing jointly',
  marriedFilingSeparately: 'Married filing separately',
  headOfHousehold: 'Head of household',
};

/**
 * Picks a subset of the on-screen table columns, keeping their `format` functions so a
 * printed number is formatted exactly as it is on screen.
 *
 * @param columns - Columns generated for the on-screen table
 * @param picks - Keys to keep, with an optional shorter title for print
 * @returns Report columns in the order requested
 */
function pickColumns<T extends Record<string, unknown>>(
  columns: readonly TableColumn<T>[],
  picks: ReadonlyArray<{ key: string; title?: string }>
): ReportColumn[] {
  return picks.map(({ key, title }) => {
    const column = columns.find((entry) => String(entry.key) === key);
    if (!column) throw new Error(`Printed report column "${key}" is not part of the on-screen table`);

    return {
      key,
      title: title ?? column.title,
      // SAFETY: the row the caller pairs with this column comes from the same extractor that
      // produced the column set, so the cell type is the column's own value type.
      format: (value: unknown) => column.format(value as T[keyof T]),
    };
  });
}

/**
 * The printed column sets, built once: the on-screen columns never change, and reusing the
 * same objects keeps two builds of the same report structurally equal (and the render
 * cheap). Building them here also means a renamed on-screen column fails at import time
 * instead of silently printing a blank column.
 */
const REPORT_COLUMNS = {
  netWorth: pickColumns(generateNetWorthTableColumns(), NET_WORTH_COLUMNS),
  cashFlow: pickColumns(generateCashFlowTableColumns(), CASH_FLOW_COLUMNS),
  taxes: pickColumns(generateTaxesTableColumns(), TAXES_COLUMNS),
} as const;

const percent = (value: number): string => formatPercentage(value);
const money = (value: number | null | undefined): string => (value == null ? '—' : formatCurrency(value));
const age = (value: number | null | undefined): string => (value == null ? '—' : String(value));

/** Retirement strategy, in the words a printed report should use. */
function describeRetirementStrategy(inputs: SimulatorInputs): string {
  const strategy = inputs.timeline?.retirementStrategy;
  if (!strategy) return '—';

  return strategy.type === 'fixedAge'
    ? `Retire at age ${strategy.retirementAge}`
    : `Retire at a ${percent(strategy.safeWithdrawalRate)} withdrawal rate`;
}

/** Market assumptions, as one printed line. */
function describeMarketAssumptions(inputs: SimulatorInputs): string {
  const market = inputs.marketAssumptions;
  if (!market) return '—';

  return `Stocks ${percent(market.stockReturn)}, bonds ${percent(market.bondReturn)}, cash ${percent(market.cashReturn)}, inflation ${percent(market.inflationRate)}`;
}

/** Events as printable facts: age plus the short label, with the subject when there is one. */
function describeEvents(simulation: SimulationResult): ReportFact[] {
  return extractSimulationEvents(simulation.data).map((event: SimulationEvent) => ({
    label: event.detail ? `${event.label} — ${event.detail}` : event.label,
    value: `Age ${event.age}`,
  }));
}

/**
 * Builds the printed report for a completed simulation.
 *
 * @param input - Plan name, the inputs it was run with, the result, its key metrics and the
 *   simulation-mode label
 * @returns Everything the report route renders, in print order
 */
export function buildPlanReport({ planName, inputs, simulation, keyMetrics, modeLabel }: PlanReportInput): PlanReport {
  const { context } = simulation;

  const facts: ReportFact[] = [
    { label: 'Result', value: keyMetrics.success ? 'On track' : 'Needs attention' },
    { label: 'Retirement age', value: age(keyMetrics.retirementAge) },
    { label: 'Years to retirement', value: age(keyMetrics.yearsToRetirement) },
    { label: 'Portfolio at retirement', value: money(keyMetrics.portfolioAtRetirement) },
    { label: 'Final portfolio', value: money(keyMetrics.finalPortfolio) },
    { label: 'Lifetime taxes & penalties', value: money(keyMetrics.lifetimeTaxesAndPenalties) },
  ];

  // Only printed when it happened: a depletion age is not a field on a healthy plan.
  if (keyMetrics.bankruptcyAge !== null) {
    facts.push({ label: 'Portfolio depleted at', value: `Age ${keyMetrics.bankruptcyAge}` });
  }
  if (keyMetrics.progressToRetirement !== null) {
    facts.push({ label: 'Progress to retirement', value: percent(keyMetrics.progressToRetirement) });
  }

  const assumptions: ReportFact[] = [
    { label: 'Retirement', value: describeRetirementStrategy(inputs) },
    { label: 'Plan horizon', value: `Age ${Math.floor(context.startAge)} to ${Math.floor(context.endAge)}` },
    { label: 'Simulation start', value: context.startDate },
    { label: 'Simulation mode', value: modeLabel },
    { label: 'Market assumptions', value: describeMarketAssumptions(inputs) },
    { label: 'Required minimum distributions', value: `From age ${context.rmdAge}` },
    {
      label: 'Filing status',
      value: FILING_STATUS_LABELS[inputs.taxSettings?.filingStatus ?? ''] ?? '—',
    },
  ];

  return {
    title: 'Retirement plan report',
    planName,
    asOf: context.startDate,
    facts,
    assumptions,
    events: describeEvents(simulation),
    sections: [
      {
        id: 'netWorth',
        title: 'Net worth by year',
        summary: 'What you own minus what you owe, at the end of every simulated year.',
        columns: REPORT_COLUMNS.netWorth,
        rows: TableDataExtractor.extractSingleSimulationNetWorthData(simulation),
        pageBreakBefore: false,
      },
      {
        id: 'cashFlow',
        title: 'Cash flow by year',
        summary: 'What comes in, what goes out, and whether the year had a surplus or needed withdrawals.',
        columns: REPORT_COLUMNS.cashFlow,
        rows: TableDataExtractor.extractSingleSimulationCashFlowData(simulation),
        pageBreakBefore: true,
      },
      {
        id: 'taxes',
        title: 'Taxes by year',
        summary: 'The annual federal liability by type, with the effective rate actually paid.',
        columns: REPORT_COLUMNS.taxes,
        rows: TableDataExtractor.extractSingleSimulationTaxesData(simulation),
        pageBreakBefore: true,
      },
    ],
  };
}
