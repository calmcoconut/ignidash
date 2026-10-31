import { describe, it, expect } from 'vitest';

import type { MultiSimulationResult, SimulationDataPoint, SimulationResult } from '../simulation-engine';
import { createEmptyPortfolioData } from '../__tests__/test-utils';
import { generateYearlyAggregateTableColumns } from '@/lib/utils/table-formatters';
import { SIMULATION_WITHDRAWALS_TABLE_CONFIG } from '@/lib/schemas/tables/single-simulation-table-schema';
import { TableDataExtractor } from './table-data-extractor';

/** A run whose portfolio value is constant, so each yearly row has a known distribution. */
const createSimulation = (seed: number, value: number, years: number): [number, SimulationResult] => {
  const data: SimulationDataPoint[] = Array.from({ length: years }, (_, year) => ({
    date: `20${26 + year}-03-15`,
    age: 35 + year,
    portfolio: { ...createEmptyPortfolioData(), totalValue: value },
    incomes: null,
    expenses: null,
    debts: null,
    physicalAssets: null,
    phase: { name: 'accumulation' as const },
    taxes: null,
    returns: null,
  }));

  return [
    seed,
    {
      data,
      context: {
        startAge: 35,
        endAge: 35 + years - 1,
        yearsToSimulate: years,
        startDate: '2026-03-15',
        endDate: `20${26 + years - 1}-03-01`,
        retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
        rmdAge: 75,
      },
    },
  ];
};

describe('TableDataExtractor yearly aggregate percentiles', () => {
  // Ten runs over four yearly rows. Runs and rows are independent now: a fixture with fewer runs
  // than rows is covered by `multi-simulation-shape.test.ts` (3 runs over 20 years).
  const multi: MultiSimulationResult = {
    simulations: Array.from({ length: 10 }, (_, index) => createSimulation(index + 1, (index + 1) * 1000, 4)),
  };

  it('reports p5 and p95 alongside the existing percentile columns', () => {
    const rows = TableDataExtractor.extractMultiSimulationYearlyAggregateData(multi);

    expect(rows).toHaveLength(4);

    // Values are 1000..10000, so the interpolated percentiles land at:
    // p5 = 1450, p10 = 1900, p50 = 5500, p90 = 9100, p95 = 9550.
    expect(rows[0]).toMatchObject({
      p5PortfolioValue: 1450,
      p10PortfolioValue: 1900,
      p25PortfolioValue: 3250,
      p50PortfolioValue: 5500,
      p75PortfolioValue: 7750,
      p90PortfolioValue: 9100,
      p95PortfolioValue: 9550,
    });
  });

  it('surfaces them as table columns, since the columns are generated from the row config', () => {
    const titles = generateYearlyAggregateTableColumns().map((column) => column.title);

    expect(titles).toContain('P5 Portfolio Value');
    expect(titles).toContain('P95 Portfolio Value');
    expect(titles).toContain('P10 Portfolio Value');
    expect(titles).toContain('P90 Portfolio Value');
  });
});

// ============================================================================
// Roth conversions in the withdrawals table
// ============================================================================

/** A withdrawals-relevant row whose only interesting field is `portfolio.conversions`. */
const createConversionPoint = (age: number, conversions?: number): SimulationDataPoint => ({
  date: `20${26 + (age - 40)}-03-15`,
  age,
  portfolio: {
    ...createEmptyPortfolioData(),
    totalValue: 500_000,
    ...(conversions === undefined ? {} : { conversions }),
  },
  incomes: null,
  expenses: null,
  debts: null,
  physicalAssets: null,
  phase: { name: 'retirement' as const },
  taxes: null,
  returns: null,
});

const createConversionSimulation = (data: SimulationDataPoint[]): SimulationResult =>
  ({
    data,
    context: {
      startAge: data[0].age,
      endAge: data[data.length - 1].age,
      yearsToSimulate: data.length,
      startDate: data[0].date,
      endDate: data[data.length - 1].date,
      retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
      rmdAge: 75,
    },
  }) as SimulationResult;

describe('TableDataExtractor single-simulation withdrawals: Roth conversions', () => {
  it('reports the annual conversion and accumulates it like the neighbouring RMD pair', () => {
    const simulation = createConversionSimulation([
      createConversionPoint(40),
      createConversionPoint(41, 25_000),
      createConversionPoint(42),
      createConversionPoint(43, 10_000),
    ]);

    const rows = TableDataExtractor.extractSingleSimulationWithdrawalsData(simulation);

    // Row 0 is the pre-simulation header row: every withdrawal field is null, not zero.
    expect(rows[0].annualRothConversions).toBeNull();
    expect(rows[0].cumulativeRothConversions).toBeNull();
    expect(rows.slice(1).map((row) => row.annualRothConversions)).toEqual([25_000, 0, 10_000]);
    expect(rows.slice(1).map((row) => row.cumulativeRothConversions)).toEqual([25_000, 25_000, 35_000]);
  });

  it('reports zero conversions on a plan without a conversion schedule', () => {
    const rows = TableDataExtractor.extractSingleSimulationWithdrawalsData(
      createConversionSimulation([createConversionPoint(40), createConversionPoint(41)])
    );

    expect(rows.slice(1).map((row) => row.annualRothConversions)).toEqual([0]);
    expect(rows.slice(1).map((row) => row.cumulativeRothConversions)).toEqual([0]);
  });

  it('gives both conversion figures their own columns, since the columns come from the row config', () => {
    const titles = Object.values(SIMULATION_WITHDRAWALS_TABLE_CONFIG).map((column) => column.title);

    expect(titles).toContain('Annual Roth Conversions');
    expect(titles).toContain('Cumulative Roth Conversions');
  });
});
