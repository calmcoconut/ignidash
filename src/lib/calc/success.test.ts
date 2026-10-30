import { describe, it, expect } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import type { MultiSimulationResult, SimulationDataPoint, SimulationResult } from './simulation-engine';
import { SimulationDataExtractor } from './data-extractors/simulation-data-extractor';
import { TableDataExtractor } from './data-extractors/table-data-extractor';
import { KeyMetricsExtractor } from './data-extractors/key-metrics-extractor';
import { MultiSimulationAnalyzer } from './data-analyzers/multi-simulation-analyzer';
import { evaluateSuccess, SUCCESS_MINIMUM_FINAL_PORTFOLIO } from './success';
import { simulate } from './simulate';
import {
  create401kAccount,
  createContributionRule,
  createDefaultTimeline,
  createEmptyPortfolioData,
  createLivingExpense,
  createSimulatorInputs,
  createWageIncome,
} from './__tests__/test-utils';

/**
 * P2-P2: one success predicate for every readout.
 *
 * The fixtures below are built so each term of the predicate can disagree with one of the
 * predicates this replaced. The three old predicates are reproduced verbatim in this file, so
 * every fixture asserts that the old definition and the new one differ — the fixtures would
 * fail if `evaluateSuccess` were the old code with a new name.
 */

const AS_OF = '2026-03-15';

const dataPoint = (age: number, phase: 'accumulation' | 'retirement', totalValue: number, shortfall = 0): SimulationDataPoint => ({
  date: '2026-03-15',
  age,
  portfolio: { ...createEmptyPortfolioData(), totalValue, shortfall },
  incomes: null,
  expenses: null,
  debts: null,
  physicalAssets: null,
  phase: { name: phase },
  taxes: null,
  returns: null,
});

/** Builds a run whose phase flips to retirement at `retirementAge` (if the horizon reaches it). */
const simulation = (options: {
  startAge: number;
  endAge: number;
  retirementAge: number;
  finalPortfolioValue: number;
  shortfallAge?: number;
  finalPhase?: 'accumulation' | 'retirement';
  retirementStrategy?: SimulationResult['context']['retirementStrategy'];
}): SimulationResult => {
  const { startAge, endAge, retirementAge, finalPortfolioValue, shortfallAge, finalPhase } = options;

  const data: SimulationDataPoint[] = [];
  for (let age = startAge; age <= endAge; age++) {
    const phase: 'accumulation' | 'retirement' = age >= retirementAge ? 'retirement' : 'accumulation';
    const isLast = age === endAge;
    const totalValue = isLast ? finalPortfolioValue : 1_000_000;
    const shortfall = age === shortfallAge ? 5000 : 0;

    data.push(dataPoint(age, isLast && finalPhase !== undefined ? finalPhase : phase, totalValue, shortfall));
  }

  return {
    data,
    context: {
      startAge,
      endAge,
      yearsToSimulate: endAge - startAge,
      startDate: AS_OF,
      endDate: '2076-03-01',
      retirementStrategy: options.retirementStrategy ?? { type: 'fixedAge', retirementAge },
      rmdAge: 75,
    },
  };
};

// ============================================================================
// The predicates this replaced, reproduced verbatim
// ============================================================================

/** Pre-P2-P2 `KeyMetricsExtractor`: the strategy's age (always non-null for fixedAge) + shortfall. */
function oldKeyMetricsSuccess(sim: SimulationResult): boolean {
  const { data, context } = sim;

  const retirementAge =
    context.retirementStrategy.type === 'fixedAge'
      ? context.retirementStrategy.retirementAge
      : SimulationDataExtractor.getMilestonesData(data, context.startAge).retirementAge;

  const finalPortfolio = data[data.length - 1].portfolio.totalValue;
  const shortfallOccurred = data.some((dp) => dp.portfolio.shortfall > 0);

  return retirementAge !== null && finalPortfolio > 0.1 && !shortfallOccurred;
}

/** Pre-P2-P2 `TableDataExtractor`: milestones retirement + final value, no shortfall term. */
function oldTableSuccess(sim: SimulationResult): boolean {
  const { retirementAge } = SimulationDataExtractor.getMilestonesData(sim.data, sim.context.startAge);
  return retirementAge !== null && sim.data[sim.data.length - 1].portfolio.totalValue > 0.1;
}

/** Pre-P2-P2 `MultiSimulationAnalyzer`: final data point's phase + final value, no shortfall term. */
function oldAnalyzerSuccess(sim: SimulationResult): boolean {
  const finalDp = sim.data[sim.data.length - 1];
  return finalDp.portfolio.totalValue > 0.1 && finalDp.phase?.name === 'retirement';
}

// ============================================================================
// The predicate
// ============================================================================

describe('evaluateSuccess', () => {
  it('succeeds when retirement was reached, money is left, and no year had a shortfall', () => {
    const sim = simulation({ startAge: 30, endAge: 90, retirementAge: 65, finalPortfolioValue: 2_000_000 });

    expect(evaluateSuccess(sim)).toBe(true);
  });

  it(`fails when the final portfolio is at or below $${SUCCESS_MINIMUM_FINAL_PORTFOLIO}`, () => {
    const atThreshold = simulation({ startAge: 30, endAge: 90, retirementAge: 65, finalPortfolioValue: SUCCESS_MINIMUM_FINAL_PORTFOLIO });
    const aboveThreshold = simulation({
      startAge: 30,
      endAge: 90,
      retirementAge: 65,
      finalPortfolioValue: SUCCESS_MINIMUM_FINAL_PORTFOLIO + 0.01,
    });

    expect(evaluateSuccess(atThreshold)).toBe(false);
    expect(evaluateSuccess(aboveThreshold)).toBe(true);
  });

  it('fails when retirement was never reached, whatever the ending balance', () => {
    const sim = simulation({ startAge: 30, endAge: 70, retirementAge: 80, finalPortfolioValue: 10_000_000 });

    expect(evaluateSuccess(sim)).toBe(false);
  });
});

// ============================================================================
// Fixture 1: a shortfall that a later surplus repaid
// ============================================================================

describe('shortfall-then-recovery fixture', () => {
  const shortfallThenRecovery = simulation({
    startAge: 30,
    endAge: 90,
    retirementAge: 65,
    shortfallAge: 70,
    finalPortfolioValue: 1_500_000,
  });

  it('fails, because the run could not fund spending in year 70', () => {
    expect(evaluateSuccess(shortfallThenRecovery)).toBe(false);
  });

  it('discriminates: the old per-row table and analyzer predicates called it a success', () => {
    expect(oldTableSuccess(shortfallThenRecovery)).toBe(true);
    expect(oldAnalyzerSuccess(shortfallThenRecovery)).toBe(true);
    // The headline already had the term, so this fixture did not move it.
    expect(oldKeyMetricsSuccess(shortfallThenRecovery)).toBe(false);
  });
});

// ============================================================================
// Fixture 2: retirement reached, but the run's final phase is not retirement
// ============================================================================

describe('retirement-reached-but-final-phase-not-retirement fixture', () => {
  const retiredThenBackToAccumulation = simulation({
    startAge: 30,
    endAge: 90,
    retirementAge: 65,
    finalPhase: 'accumulation',
    finalPortfolioValue: 1_500_000,
    retirementStrategy: { type: 'swrTarget', safeWithdrawalRate: 4 },
  });

  it('succeeds, because the run did reach retirement at 65 and kept its money', () => {
    expect(SimulationDataExtractor.getMilestonesData(retiredThenBackToAccumulation.data, 30).retirementAge).toBe(65);
    expect(evaluateSuccess(retiredThenBackToAccumulation)).toBe(true);
  });

  it('discriminates: the old analyzer predicate required the *final* phase to be retirement', () => {
    expect(oldAnalyzerSuccess(retiredThenBackToAccumulation)).toBe(false);
    expect(oldTableSuccess(retiredThenBackToAccumulation)).toBe(true);
    expect(oldKeyMetricsSuccess(retiredThenBackToAccumulation)).toBe(true);
  });
});

// ============================================================================
// Fixture 3: a fixedAge plan that never reaches retirement
// ============================================================================

describe('never-reached-retirement fixture (fixedAge strategy)', () => {
  const neverRetires = simulation({ startAge: 30, endAge: 70, retirementAge: 80, finalPortfolioValue: 5_000_000 });

  it('fails even though the strategy names a retirement age and the portfolio is large', () => {
    expect(evaluateSuccess(neverRetires)).toBe(false);
  });

  it('discriminates: the old headline predicate trusted the strategy age and called it a success', () => {
    expect(oldKeyMetricsSuccess(neverRetires)).toBe(true);
    expect(oldTableSuccess(neverRetires)).toBe(false);
    expect(oldAnalyzerSuccess(neverRetires)).toBe(false);
  });
});

// ============================================================================
// The whole point: every readout reports the same success rate
// ============================================================================

describe('success rate is one number across every readout', () => {
  const mixed: MultiSimulationResult = {
    simulations: [
      [1, simulation({ startAge: 30, endAge: 90, retirementAge: 65, finalPortfolioValue: 2_000_000 })],
      [2, simulation({ startAge: 30, endAge: 90, retirementAge: 65, shortfallAge: 70, finalPortfolioValue: 1_500_000 })],
      [
        3,
        simulation({
          startAge: 30,
          endAge: 90,
          retirementAge: 65,
          finalPhase: 'accumulation',
          finalPortfolioValue: 1_500_000,
          retirementStrategy: { type: 'swrTarget', safeWithdrawalRate: 4 },
        }),
      ],
      [4, simulation({ startAge: 30, endAge: 70, retirementAge: 80, finalPortfolioValue: 5_000_000 })],
    ],
  };

  it('reports 50% everywhere, where the three old predicates reported 75%, 75% and 50%', () => {
    const perSimulation = mixed.simulations.map(([, sim]) => evaluateSuccess(sim));
    expect(perSimulation).toEqual([true, false, true, false]);

    expect(perSimulation.filter(Boolean).length / perSimulation.length).toBe(0.5);

    // Before P2-P2 the three readouts each had their own answer for the same four runs.
    const oldHeadline = mixed.simulations.filter(([, sim]) => oldKeyMetricsSuccess(sim)).length / 4;
    const oldPerRowColumn = mixed.simulations.filter(([, sim]) => oldTableSuccess(sim)).length / 4;
    const oldAnalyzerRate = mixed.simulations.filter(([, sim]) => oldAnalyzerSuccess(sim)).length / 4;

    expect(oldHeadline).toBe(0.75);
    expect(oldPerRowColumn).toBe(0.75);
    expect(oldAnalyzerRate).toBe(0.5);
  });

  it('makes the headline percentage equal the per-row success column on real simulations', () => {
    // Real engine output, so every extractor below runs against its normal input.
    const inputs: SimulatorInputs = createSimulatorInputs({
      timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 88 },
      accounts: { '401k-1': create401kAccount({ id: '401k-1', balance: 300000 }) },
      incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 85000 }) },
      expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 55000 }) },
      contributionRules: { 'rule-1': createContributionRule({ id: 'rule-1', accountId: '401k-1' }) },
    });

    const simulations = [11, 22, 33, 44, 55, 66].map((seed): [number, SimulationResult] => {
      const outcome = simulate(inputs, { mode: 'stochasticReturns', seed, asOf: AS_OF });
      if (outcome.mode !== 'stochasticReturns') throw new Error('expected a single-run outcome');
      return [seed, outcome.result];
    });
    const multi: MultiSimulationResult = { simulations };

    const rows = TableDataExtractor.extractMultiSimulationData(multi);
    const rowSuccessRate = rows.filter((row) => row.success).length / rows.length;
    const headline = KeyMetricsExtractor.extractMultiSimulationMetrics(multi).success;
    const analysis = MultiSimulationAnalyzer.analyze(multi, 'finalPortfolioValue');

    // The Verify item: the headline % is the per-row column, not a second opinion.
    expect(rows.map((row) => row.success)).toEqual(simulations.map(([, sim]) => evaluateSuccess(sim)));
    expect(headline).toBe(rowSuccessRate);
    expect(analysis.success).toBe(rowSuccessRate);
  });
});
