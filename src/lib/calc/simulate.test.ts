import { describe, it, expect, afterAll } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import type { ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';

import { cumulativeInflationIndex as cumulativeInflationIndexFromTimeBinding } from './time-binding';
import { fixedClock } from './clock';
import { FinancialSimulationEngine, type SimulationResult } from './simulation-engine';
import { mergeMonteCarloSummaries, runMonteCarloRange, type MonteCarloRunResult } from './monte-carlo';
import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { StochasticReturnsProvider } from './returns-providers/stochastic-returns-provider';
import { LcgHistoricalBacktestReturnsProvider } from './returns-providers/lcg-historical-backtest-returns-provider';
import { cumulativeInflationIndex, DEFAULT_MONTE_CARLO_TRIALS, MONTE_CARLO_MAX_TRIALS, simulate, type SimulateOptions } from './simulate';
import {
  create401kAccount,
  createContributionRule,
  createDefaultMarketAssumptions,
  createDefaultTimeline,
  createLivingExpense,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
  createWageIncome,
} from './__tests__/test-utils';

/**
 * P2-P1a: `simulate()` must be the engine behind one pure function.
 *
 * Three properties are pinned here:
 * 1. determinism — identical arguments give deep-equal results;
 * 2. host independence — identical results whatever the process timezone is;
 * 3. extraction, not a change — each mode equals the calls the store/worker path makes today.
 */

const AS_OF = '2026-03-15';

const createPlan = (overrides?: Partial<SimulatorInputs>): SimulatorInputs =>
  createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 90 },
    accounts: {
      '401k-1': create401kAccount({ id: '401k-1', balance: 400000 }),
      'brokerage-1': createTaxableBrokerageAccount({ id: 'brokerage-1', balance: 150000 }),
    },
    incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 90000 }) },
    expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 45000 }) },
    contributionRules: { 'rule-1': createContributionRule({ id: 'rule-1', accountId: '401k-1' }) },
    ...overrides,
  });

const ALL_MODES = [
  'fixedReturns',
  'stochasticReturns',
  'historicalReturns',
  'monteCarloStochasticReturns',
  'monteCarloHistoricalReturns',
] as const;

// ============================================================================
// The existing store/worker path, replicated inline
// ============================================================================

/** Exactly what `useSimulationResult` runs on the main thread for the three single-run modes. */
function storeSingleRun(
  inputs: SimulatorInputs,
  mode: 'fixedReturns' | 'stochasticReturns' | 'historicalReturns',
  seed: number,
  asOf: string
): SimulationResult {
  const timeline = inputs.timeline!;
  const engine = new FinancialSimulationEngine(inputs, fixedClock(asOf));

  switch (mode) {
    case 'fixedReturns':
      return engine.runSimulation(new FixedReturnsProvider(inputs), timeline);
    case 'stochasticReturns':
      return engine.runSimulation(new StochasticReturnsProvider(inputs, seed), timeline);
    case 'historicalReturns': {
      const { historicalStartYearOverride, historicalRetirementStartYearOverride } = inputs.simulationSettings;
      const returnsProvider = new LcgHistoricalBacktestReturnsProvider(
        seed,
        historicalStartYearOverride,
        historicalRetirementStartYearOverride
      );
      const res = engine.runSimulation(returnsProvider, timeline);

      return { ...res, context: { ...res.context, historicalRanges: returnsProvider.getHistoricalRanges() } };
    }
  }
}

/**
 * Exactly what the store's worker pool runs: trial index ranges of 10, each handed to a worker,
 * and the merge worker folding the pieces back together. Chunks arrive in any order, so the
 * comparison is order-insensitive by construction (the merge sorts and sums).
 */
function storeMonteCarloRun(
  inputs: SimulatorInputs,
  mode: 'monteCarloStochasticReturns' | 'monteCarloHistoricalReturns',
  seed: number,
  asOf: string,
  totalTrials: number
): { simulations: Array<[number, SimulationResult]>; summary: MonteCarloRunResult['summary'] } {
  const chunks: Array<{ start: number; size: number }> = [];
  for (let start = 0; start < totalTrials; start += 10) chunks.push({ start, size: Math.min(10, totalTrials - start) });

  const partials = chunks.map((chunk) =>
    runMonteCarloRange(inputs, { mode, baseSeed: seed, asOf, config: { retention: 'full' }, startIndex: chunk.start, count: chunk.size })
  );

  return {
    simulations: partials.flatMap((partial) => partial.simulations),
    summary: mergeMonteCarloSummaries(partials.map((p) => p.summary)),
  };
}

const bySeed = (simulations: Array<[number, SimulationResult]>): Map<number, SimulationResult> =>
  new Map(simulations.map(([seed, result]) => [seed, result]));

const seedsOf = (simulations: Array<[number, SimulationResult]>): number[] => simulations.map(([seed]) => seed);

// ============================================================================
// Determinism
// ============================================================================

describe('simulate determinism', () => {
  it.each(ALL_MODES)('returns deep-equal results for identical arguments (%s)', { timeout: 60_000 }, (mode) => {
    const inputs = createPlan();
    const options: SimulateOptions =
      mode === 'monteCarloStochasticReturns' || mode === 'monteCarloHistoricalReturns'
        ? { mode, seed: 4242, asOf: AS_OF, monteCarlo: { trials: 100 } }
        : { mode, seed: 4242, asOf: AS_OF };

    const first = simulate(inputs, options);
    const second = simulate(createPlan(), options);

    expect(second).toStrictEqual(first);
  });

  it('does not mutate its inputs', { timeout: 60_000 }, () => {
    const inputs = createPlan();
    const before = structuredClone(inputs);

    simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF });
    simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 1, asOf: AS_OF, monteCarlo: { trials: 100 } });

    expect(inputs).toStrictEqual(before);
  });
});

// ============================================================================
// Host independence
// ============================================================================

const ORIGINAL_TZ = process.env.TZ;

function runInTimezone<T>(timeZone: string, run: () => T): T {
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  }
}

/** Offset of a fixed winter instant, used to prove the timezone switch really took effect. */
function winterOffsetMinutes(): number {
  return new Date(2026, 0, 15).getTimezoneOffset();
}

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('simulate host independence', () => {
  it('returns identical results under three different process timezones', { timeout: 60_000 }, () => {
    const inputs = createPlan();

    const runIn = <T>(timeZone: string, run: () => T) => runInTimezone(timeZone, () => ({ offset: winterOffsetMinutes(), value: run() }));

    const utc = runIn('UTC', () => ({
      fixed: simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }),
      mc: simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 99, asOf: AS_OF, monteCarlo: { trials: 100 } }),
    }));
    const losAngeles = runIn('America/Los_Angeles', () => ({
      fixed: simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }),
      mc: simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 99, asOf: AS_OF, monteCarlo: { trials: 100 } }),
    }));
    const kiritimati = runIn('Pacific/Kiritimati', () => ({
      fixed: simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }),
      mc: simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 99, asOf: AS_OF, monteCarlo: { trials: 100 } }),
    }));

    expect(utc.offset).toBe(0);
    expect(losAngeles.offset).toBe(480);
    expect(kiritimati.offset).toBe(-840);

    expect(losAngeles.value).toStrictEqual(utc.value);
    expect(kiritimati.value).toStrictEqual(utc.value);
  });
});

// ============================================================================
// Extraction, not a change: equality with the existing store/worker path
// ============================================================================

describe('simulate equals the existing store/worker path', () => {
  it('fixedReturns matches useSimulationResult', () => {
    const inputs = createPlan();
    const outcome = simulate(inputs, { mode: 'fixedReturns', seed: 9521, asOf: AS_OF });

    expect(outcome.mode).toBe('fixedReturns');
    expect(outcome.result).toStrictEqual(storeSingleRun(inputs, 'fixedReturns', 9521, AS_OF));
  });

  it('stochasticReturns matches useSimulationResult', () => {
    const inputs = createPlan();
    const outcome = simulate(inputs, { mode: 'stochasticReturns', seed: 9521, asOf: AS_OF });

    expect(outcome.result).toStrictEqual(storeSingleRun(inputs, 'stochasticReturns', 9521, AS_OF));
  });

  it('historicalReturns matches useSimulationResult, including the pinned start years', () => {
    const inputs = createPlan({
      simulationSettings: {
        simulationSeed: 9521,
        simulationMode: 'historicalReturns',
        historicalStartYearOverride: 1975,
        historicalRetirementStartYearOverride: 1990,
      },
    });
    const outcome = simulate(inputs, { mode: 'historicalReturns', seed: 9521, asOf: AS_OF });

    const stored = storeSingleRun(inputs, 'historicalReturns', 9521, AS_OF);
    expect(outcome.result).toStrictEqual(stored);
    expect(outcome.result.context.historicalRanges?.[0]?.startYear).toBe(1975);
  });

  it('monteCarloStochasticReturns matches the worker pool seed-for-seed', { timeout: 60_000 }, () => {
    const inputs = createPlan();
    const outcome = simulate(inputs, {
      mode: 'monteCarloStochasticReturns',
      seed: 9521,
      asOf: AS_OF,
      monteCarlo: { trials: 100, retention: 'full' },
    });

    const stored = storeMonteCarloRun(inputs, 'monteCarloStochasticReturns', 9521, AS_OF, 100);

    expect(seedsOf(outcome.result.simulations)).toEqual(seedsOf(stored.simulations));
    expect(bySeed(outcome.result.simulations)).toStrictEqual(bySeed(stored.simulations));
    // The chunked worker path and the one-shot run must agree on the aggregates too.
    expect(outcome.result.summary).toStrictEqual(stored.summary);
  });

  it('monteCarloHistoricalReturns matches the worker pool seed-for-seed', { timeout: 60_000 }, () => {
    const inputs = createPlan();
    const outcome = simulate(inputs, {
      mode: 'monteCarloHistoricalReturns',
      seed: 9521,
      asOf: AS_OF,
      monteCarlo: { trials: 100, retention: 'full' },
    });

    const stored = storeMonteCarloRun(inputs, 'monteCarloHistoricalReturns', 9521, AS_OF, 100);

    expect(seedsOf(outcome.result.simulations)).toEqual(seedsOf(stored.simulations));
    expect(bySeed(outcome.result.simulations)).toStrictEqual(bySeed(stored.simulations));
    expect(outcome.result.summary).toStrictEqual(stored.summary);
  });

  it('matches the store path for a plan with no incomes, expenses, debts or assets', () => {
    const inputs = createSimulatorInputs({
      timeline: createDefaultTimeline(),
      accounts: { 'savings-1': create401kAccount({ id: 'savings-1', balance: 250000 }) },
    });

    expect(simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF }).result).toStrictEqual(
      storeSingleRun(inputs, 'fixedReturns', 1, AS_OF)
    );
  });
});

// ============================================================================
// trials
// ============================================================================

describe('simulate trials', () => {
  it('honours an explicit trial count exactly, across chunk boundaries', { timeout: 60_000 }, () => {
    const inputs = createPlan();

    const count = (mode: 'monteCarloStochasticReturns' | 'monteCarloHistoricalReturns', trials: number) => {
      const outcome = simulate(inputs, { mode, seed: 7, asOf: AS_OF, monteCarlo: { trials, retention: 'full' } });
      expect(outcome.result.simulations).toHaveLength(trials);
      expect(outcome.result.summary.trials).toBe(trials);
      return outcome.result.summary.successes;
    };

    count('monteCarloStochasticReturns', 100);
    count('monteCarloStochasticReturns', 101);
    count('monteCarloHistoricalReturns', 137);
  });

  it(`defaults to ${DEFAULT_MONTE_CARLO_TRIALS} trials and summary retention when nothing is configured`, { timeout: 60_000 }, () => {
    expect(DEFAULT_MONTE_CARLO_TRIALS).toBe(500);

    // A bare plan keeps this 500-trial assertion cheap; the count is the point here.
    const inputs = createSimulatorInputs({
      timeline: { ...createDefaultTimeline(), lifeExpectancy: 60 },
      accounts: { 'savings-1': create401kAccount({ id: 'savings-1', balance: 250000 }) },
    });
    const outcome = simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 7, asOf: AS_OF });

    expect(outcome.result.summary.trials).toBe(DEFAULT_MONTE_CARLO_TRIALS);
    expect(outcome.result.simulations).toEqual([]);
    expect(outcome.result.summary.histogram.bins.reduce((total, bin) => total + bin.count, 0)).toBe(DEFAULT_MONTE_CARLO_TRIALS);
  });

  it('keeps the trials shorthand on summary retention, with full retention now opt-in', () => {
    // The shorthand predates both the range check and retention. It no longer retains runs by
    // itself, so a stray large `--trials` cannot silently keep a gigabyte of results.
    const inputs = createSimulatorInputs({
      timeline: { ...createDefaultTimeline(), lifeExpectancy: 62 },
      accounts: { 'savings-1': create401kAccount({ id: 'savings-1', balance: 250000 }) },
    });

    const shorthand = simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 7, asOf: AS_OF, trials: 3 });
    const optedIn = simulate(inputs, {
      mode: 'monteCarloStochasticReturns',
      seed: 7,
      asOf: AS_OF,
      trials: 3,
      monteCarlo: { retention: 'full' },
    });

    expect(shorthand.result.summary.trials).toBe(3);
    expect(shorthand.result.simulations).toEqual([]);
    expect(optedIn.result.simulations).toHaveLength(3);
    // Retention changes what is kept, never the aggregates.
    expect(optedIn.result.summary).toStrictEqual(shorthand.result.summary);
  });

  it('bounds the trials shorthand at the maximum trial count', () => {
    const inputs = createSimulatorInputs({
      timeline: { ...createDefaultTimeline(), lifeExpectancy: 62 },
      accounts: { 'savings-1': create401kAccount({ id: 'savings-1', balance: 250000 }) },
    });

    expect(() =>
      simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 7, asOf: AS_OF, trials: MONTE_CARLO_MAX_TRIALS + 1 })
    ).toThrow(/exceeds the 5000-trial maximum/);
  });

  it.each(['fixedReturns', 'stochasticReturns', 'historicalReturns'] as const)(
    'rejects Monte Carlo options for the single-run mode %s',
    (mode) => {
      const inputs = createPlan();

      expect(() => simulate(inputs, { mode, seed: 1, asOf: AS_OF, trials: 100 })).toThrow(/Monte Carlo options are only valid/);
      expect(() => simulate(inputs, { mode, seed: 1, asOf: AS_OF, monteCarlo: { trials: 100 } })).toThrow(
        /Monte Carlo options are only valid/
      );
    }
  );

  it.each([0, -5, 1.5, Number.NaN])('rejects an invalid trial shorthand (%s)', (trials) => {
    const inputs = createPlan();

    expect(() => simulate(inputs, { mode: 'monteCarloStochasticReturns', seed: 1, asOf: AS_OF, trials })).toThrow(/trials must be/);
  });
});

// ============================================================================
// Argument validation: `asOf` is required and explicit
// ============================================================================

describe('simulate arguments', () => {
  it('requires a real ISO date for asOf', () => {
    const inputs = createPlan();

    expect(() => simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: '2026-02-30' })).toThrow(/Invalid ISO date/);
    expect(() => simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: '2026-3-15' })).toThrow(/Invalid ISO date/);
  });

  it('requires a positive integer seed', () => {
    const inputs = createPlan();

    expect(() => simulate(inputs, { mode: 'stochasticReturns', seed: 0, asOf: AS_OF })).toThrow(/seed must be a positive integer/);
    expect(() => simulate(inputs, { mode: 'stochasticReturns', seed: 1.5, asOf: AS_OF })).toThrow(/seed must be a positive integer/);
  });

  it('requires a timeline', () => {
    const inputs = createPlan({ timeline: null });

    expect(() => simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF })).toThrow(/inputs\.timeline is required/);
  });

  it('pins the run to asOf', () => {
    const inputs = createPlan();
    const outcome = simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: AS_OF });

    expect(outcome.result.context.startDate).toBe(AS_OF);
    expect(outcome.result.data[0].date).toBe(AS_OF);
  });
});

// ============================================================================
// Contract 3.1: cumulativeInflationIndex on simulate()'s surface
// ============================================================================

describe('cumulativeInflationIndex (contract 3.1)', () => {
  it('is the same function the engine binds amounts with, not a copy', () => {
    expect(cumulativeInflationIndex).toBe(cumulativeInflationIndexFromTimeBinding);
  });

  it('compounds the plan inflation rate', () => {
    const marketAssumptions = createDefaultMarketAssumptions(); // 3% inflation

    expect(cumulativeInflationIndex(marketAssumptions, 0)).toBe(1);
    expect(cumulativeInflationIndex(marketAssumptions, 1)).toBeCloseTo(1.03, 12);
    expect(cumulativeInflationIndex(marketAssumptions, 10)).toBeCloseTo(Math.pow(1.03, 10), 12);
    expect(cumulativeInflationIndex(marketAssumptions, -1)).toBeCloseTo(1 / 1.03, 12);
  });

  it('agrees with the index the engine used to convert a nominal amount', () => {
    const marketAssumptions = createDefaultMarketAssumptions();
    const startYear = 2028; // two years after AS_OF
    const startMonth = 3;

    // Same amount, same dates; only the basis differs, so the ratio of what the engine reports
    // is exactly the index it scaled the nominal amount with.
    const expense = (amountBasis: 'real' | 'nominal'): ExpenseInputs => ({
      id: 'expense-1',
      name: 'Living Expenses',
      amount: 1000,
      amountBasis,
      frequency: 'yearly',
      disabled: false,
      timeframe: {
        start: { type: 'customDate', year: startYear, month: startMonth },
        end: { type: 'atLifeExpectancy' },
      },
    });

    const runWith = (amountBasis: 'real' | 'nominal') =>
      simulate(createPlan({ expenses: { 'expense-1': expense(amountBasis) } }), { mode: 'fixedReturns', seed: 1, asOf: AS_OF });

    const real = runWith('real');
    const nominal = runWith('nominal');

    const firstActiveIndex = real.result.data.findIndex((point) => (point.expenses?.perExpenseData['expense-1']?.expense ?? 0) > 0);
    expect(firstActiveIndex).toBeGreaterThan(-1);
    expect(real.result.data[firstActiveIndex].date).toBe('2028-03-01');

    const realAmount = real.result.data[firstActiveIndex].expenses!.perExpenseData['expense-1'].expense;
    const nominalAmount = nominal.result.data[firstActiveIndex].expenses!.perExpenseData['expense-1'].expense;

    // ... and that is the same number the module exposes to callers.
    expect(realAmount / nominalAmount).toBeCloseTo(cumulativeInflationIndex(marketAssumptions, 2), 8);
    expect(realAmount / nominalAmount).toBeCloseTo(Math.pow(1.03, 2), 8);
  });
});
