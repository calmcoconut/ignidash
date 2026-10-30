import { describe, it, expect } from 'vitest';

import type { MultiSimulationResult, SimulationDataPoint, SimulationResult } from '../simulation-engine';
import { createEmptyPortfolioData } from '../__tests__/test-utils';
import { generateYearlyAggregateTableColumns } from '@/lib/utils/table-formatters';
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
