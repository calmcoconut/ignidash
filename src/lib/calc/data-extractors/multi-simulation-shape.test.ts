import { describe, it, expect } from 'vitest';

import { ChartDataExtractor } from './chart-data-extractor';
import { TableDataExtractor } from './table-data-extractor';
import { MIXED_SIMULATION_LENGTH_ERROR, simulationYearCount } from './multi-simulation-shape';
import { createEmptyPortfolioData } from '../__tests__/test-utils';
import type { MultiSimulationResult, SimulationDataPoint, SimulationResult } from '../simulation-engine';

/**
 * A run whose portfolio value grows by a fixed step per year, so every yearly row has a known
 * distribution across runs.
 */
const createRun = (seed: number, startValue: number, years: number): [number, SimulationResult] => {
  const data: SimulationDataPoint[] = Array.from({ length: years }, (_, year) => ({
    date: `20${26 + year}-03-15`,
    age: 35 + year,
    portfolio: { ...createEmptyPortfolioData(), totalValue: startValue + year * 100 },
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

const RUNS = 3;
const YEARS = 20;

/** FEWER RUNS THAN YEARS: the shape that used to make every yearly aggregate throw. */
const multi: MultiSimulationResult = {
  simulations: [createRun(1, 1_000, YEARS), createRun(2, 2_000, YEARS), createRun(3, 3_000, YEARS)],
};

describe('yearly aggregates with fewer runs than years', () => {
  it('has the shape that used to throw (3 runs, 20 years)', () => {
    expect(multi.simulations).toHaveLength(RUNS);
    expect(multi.simulations[0][1].data).toHaveLength(YEARS);
    expect(RUNS).toBeLessThan(YEARS);
  });

  it('extracts the portfolio percentile fan across the years', () => {
    const points = ChartDataExtractor.extractMultiSimulationPortfolioData(multi);

    expect(points).toHaveLength(YEARS);
    expect(points[0].age).toBe(35);
    // Median of 1 000 / 2 000 / 3 000 in the first year, and the fan keeps stepping.
    expect(points[0].p50PortfolioValue).toBe(2_000);
    expect(points[YEARS - 1].age).toBe(35 + YEARS - 1);
    expect(points[YEARS - 1].p50PortfolioValue).toBe(2_000 + (YEARS - 1) * 100);
  });

  it('extracts the phase distribution across the years', () => {
    const points = ChartDataExtractor.extractMultiSimulationPhasesData(multi);

    expect(points).toHaveLength(YEARS);
    expect(points[0]).toMatchObject({ percentAccumulation: 1, numberAccumulation: RUNS, percentRetirement: 0, percentBankrupt: 0 });
    expect(points[YEARS - 1].age).toBe(35 + YEARS - 1);
  });

  it('extracts the yearly aggregate table across the years', () => {
    const rows = TableDataExtractor.extractMultiSimulationYearlyAggregateData(multi);

    expect(rows).toHaveLength(YEARS);
    expect(rows.map((row) => row.year)).toEqual(Array.from({ length: YEARS }, (_, year) => year));
    expect(rows[0]).toMatchObject({ year: 0, age: 35, p50PortfolioValue: 2_000, percentAccumulation: 1 });
    expect(rows[YEARS - 1]).toMatchObject({ year: YEARS - 1, age: 35 + YEARS - 1 });
  });
});

describe('simulationYearCount', () => {
  it('returns the shared year count', () => {
    expect(simulationYearCount(multi)).toBe(YEARS);
  });

  it('returns 0 for a set with no runs, and the aggregators produce no rows', () => {
    const empty: MultiSimulationResult = { simulations: [] };

    expect(simulationYearCount(empty)).toBe(0);
    expect(ChartDataExtractor.extractMultiSimulationPortfolioData(empty)).toEqual([]);
    expect(ChartDataExtractor.extractMultiSimulationPhasesData(empty)).toEqual([]);
    expect(TableDataExtractor.extractMultiSimulationYearlyAggregateData(empty)).toEqual([]);
  });

  it('refuses a set whose runs disagree on length, naming the offending run', () => {
    const ragged: MultiSimulationResult = { simulations: [createRun(1, 1_000, YEARS), createRun(2, 2_000, YEARS - 1)] };

    expect(() => simulationYearCount(ragged)).toThrow(MIXED_SIMULATION_LENGTH_ERROR);
    expect(() => simulationYearCount(ragged)).toThrow(/run 2 has 19 years, expected 20/);
    // The aggregators surface the same error rather than producing ragged rows.
    expect(() => ChartDataExtractor.extractMultiSimulationPortfolioData(ragged)).toThrow(MIXED_SIMULATION_LENGTH_ERROR);
    expect(() => TableDataExtractor.extractMultiSimulationYearlyAggregateData(ragged)).toThrow(MIXED_SIMULATION_LENGTH_ERROR);
  });
});
