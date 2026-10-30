import { describe, it, expect } from 'vitest';

import { buildPlanReport } from './plan-report';
import { generateCashFlowTableColumns, generateNetWorthTableColumns, generateTaxesTableColumns } from './table-formatters';
import { FinancialSimulationEngine } from '@/lib/calc/simulation-engine';
import { FixedReturnsProvider } from '@/lib/calc/returns-providers/fixed-returns-provider';
import { TableDataExtractor } from '@/lib/calc/data-extractors/table-data-extractor';
import { KeyMetricsExtractor } from '@/lib/calc/data-extractors/key-metrics-extractor';
import { formatCurrency } from '@/lib/utils/number-formatters';
import {
  TEST_CLOCK,
  create401kAccount,
  createContributionRule,
  createDebtInput,
  createFinancedAssetInput,
  createLivingExpense,
  createSavingsAccount,
  createSimulatorInputs,
  createWageIncome,
} from '@/lib/calc/__tests__/test-utils';

/** A healthy plan: retire at 65, living expenses, a mortgage, a card, one savings account. */
function buildHealthyPlan() {
  const inputs = createSimulatorInputs({
    timeline: { lifeExpectancy: 87, birthMonth: 1, birthYear: 1990, retirementStrategy: { type: 'fixedAge', retirementAge: 65 } },
    incomes: { salary: createWageIncome({ amount: 150000 }) },
    expenses: { living: createLivingExpense({ amount: 55000 }) },
    accounts: {
      retirement: create401kAccount({ balance: 800000 }),
      savings: createSavingsAccount({ balance: 60000 }),
    },
    contributionRules: { rule: createContributionRule({ accountId: '401k-1', contributionType: 'unlimited' }) },
    debts: { card: createDebtInput({ balance: 6000, monthlyPayment: 500 }) },
    physicalAssets: { residence: createFinancedAssetInput({}) },
  });

  const simulation = new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);
  const keyMetrics = KeyMetricsExtractor.extractSingleSimulationMetrics(simulation);

  return { inputs, simulation, keyMetrics };
}

/** A plan that runs out of money, so the shortfall facts have to appear. */
function buildShortfallPlan() {
  const inputs = createSimulatorInputs({
    incomes: { salary: createWageIncome({ amount: 30000 }) },
    expenses: { living: createLivingExpense({ amount: 90000 }) },
    accounts: { savings: createSavingsAccount({ balance: 20000 }) },
  });

  const simulation = new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);
  const keyMetrics = KeyMetricsExtractor.extractSingleSimulationMetrics(simulation);

  return { inputs, simulation, keyMetrics };
}

const healthy = buildHealthyPlan();
const report = buildPlanReport({ planName: 'Test Plan', ...healthy, modeLabel: 'Fixed returns' });

describe('printed report structure', () => {
  it('prints a summary, the assumptions and exactly three year-by-year tables', () => {
    expect(report.title).toBe('Retirement plan report');
    expect(report.planName).toBe('Test Plan');
    expect(report.facts.length).toBeGreaterThan(4);
    expect(report.assumptions.length).toBeGreaterThan(4);
    expect(report.sections.map((section) => section.id)).toEqual(['netWorth', 'cashFlow', 'taxes']);

    for (const section of report.sections) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.summary.length).toBeGreaterThan(0);
      expect(section.columns.length).toBeGreaterThan(2);
      expect(section.rows.length).toBeGreaterThan(0);
    }
  });

  it('starts every table after the first on a new page', () => {
    // The summary and the first table share a page; the other two tables each start fresh so
    // a long table cannot be squeezed into the tail of the previous one.
    expect(report.sections.map((section) => section.pageBreakBefore)).toEqual([false, true, true]);
  });

  it('dates the report from the simulation context, never from a clock', () => {
    expect(report.asOf).toBe(healthy.simulation.context.startDate);
    expect(report.assumptions.find((fact) => fact.label === 'Simulation start')?.value).toBe(healthy.simulation.context.startDate);
  });
});

describe('printed report data comes from the on-screen extractors', () => {
  it('uses the same rows the on-screen tables show', () => {
    const [netWorth, cashFlow, taxes] = report.sections;

    expect(netWorth.rows).toEqual(TableDataExtractor.extractSingleSimulationNetWorthData(healthy.simulation));
    expect(cashFlow.rows).toEqual(TableDataExtractor.extractSingleSimulationCashFlowData(healthy.simulation));
    expect(taxes.rows).toEqual(TableDataExtractor.extractSingleSimulationTaxesData(healthy.simulation));
  });

  it('keeps the on-screen formatters, only shortening the printed titles', () => {
    const netWorthColumn = report.sections[0].columns.find((column) => column.key === 'netWorth');
    const onScreen = generateNetWorthTableColumns().find((column) => column.key === 'netWorth');
    if (!netWorthColumn || !onScreen) throw new Error('missing net worth net-value column');

    const row = report.sections[0].rows[0];
    expect(netWorthColumn.title).toBe('Net worth'); // shortened for a portrait page
    expect(netWorthColumn.format(row.netWorth)).toBe(onScreen.format(row.netWorth as never));
    expect(netWorthColumn.format(row.netWorth)).toMatch(/^\$|^-?\$/);
  });

  it('formats every cell of every section without throwing', () => {
    const onScreenKeys = {
      netWorth: new Set(generateNetWorthTableColumns().map((column) => column.key)),
      cashFlow: new Set(generateCashFlowTableColumns().map((column) => column.key)),
      taxes: new Set(generateTaxesTableColumns().map((column) => column.key)),
    } as const;

    for (const section of report.sections) {
      expect(section.pageBreakBefore || section.id === 'netWorth').toBe(true);

      for (const column of section.columns) {
        expect(onScreenKeys[section.id].has(column.key as never), `${section.id}.${column.key}`).toBe(true);

        for (const row of section.rows) {
          const formatted = column.format(row[column.key]);
          expect(typeof formatted, `${section.id}.${column.key}`).toBe('string');
          expect(formatted.length, `${section.id}.${column.key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('prints the key metrics the on-screen summary shows', () => {
    const byLabel = new Map(report.facts.map((fact) => [fact.label, fact.value]));

    expect(byLabel.get('Result')).toBe('On track');
    expect(byLabel.get('Retirement age')).toBe('65');
    expect(byLabel.get('Lifetime taxes & penalties')).toBe(formatCurrency(healthy.keyMetrics.lifetimeTaxesAndPenalties));
    expect(byLabel.get('Final portfolio')).toBe(formatCurrency(healthy.keyMetrics.finalPortfolio));
  });

  it('prints the assumptions behind those numbers', () => {
    const byLabel = new Map(report.assumptions.map((fact) => [fact.label, fact.value]));

    expect(byLabel.get('Retirement')).toBe('Retire at age 65');
    expect(byLabel.get('Plan horizon')).toBe(`Age ${Math.floor(healthy.simulation.context.startAge)} to 87`);
    expect(byLabel.get('Required minimum distributions')).toBe(`From age ${healthy.simulation.context.rmdAge}`);
    expect(byLabel.get('Filing status')).toBe('Single');
    expect(byLabel.get('Simulation mode')).toBe('Fixed returns');
    expect(byLabel.get('Market assumptions')).toContain('inflation');
  });

  it('prints the milestones from the annotation extractor', () => {
    const retirement = report.events.find((event) => event.label === 'Retire');
    expect(retirement).toEqual({ label: 'Retire', value: 'Age 65' });
    expect(report.events.some((event) => event.label === 'RMDs')).toBe(true);
  });
});

describe('printed report facts that only appear when they happened', () => {
  it('omits the depletion line for a plan that survives', () => {
    expect(report.facts.some((fact) => fact.label === 'Portfolio depleted at')).toBe(false);
  });

  it('prints the depletion line for a plan that runs out of money', () => {
    const shortfall = buildShortfallPlan();
    const shortfallReport = buildPlanReport({ planName: 'Shortfall', ...shortfall, modeLabel: 'Fixed returns' });
    const depleted = shortfallReport.facts.find((fact) => fact.label === 'Portfolio depleted at');

    expect(shortfallReport.facts.find((fact) => fact.label === 'Result')?.value).toBe('Needs attention');
    expect(depleted?.value).toMatch(/^Age \d+$/);
  });
});

describe('printed report determinism', () => {
  it('is pure: repeat calls are equal and the inputs are not mutated', () => {
    const simulationSnapshot = structuredClone(healthy.simulation);
    const inputsSnapshot = structuredClone(healthy.inputs);

    const first = buildPlanReport({ planName: 'Test Plan', ...healthy, modeLabel: 'Fixed returns' });
    const second = buildPlanReport({ planName: 'Test Plan', ...healthy, modeLabel: 'Fixed returns' });

    expect(second).toEqual(first);
    expect(healthy.simulation).toEqual(simulationSnapshot);
    expect(healthy.inputs).toEqual(inputsSnapshot);
  });
});
