/**
 * Monte Carlo configuration, seed mapping, streaming summary and histogram (P2-P3).
 *
 * The properties that matter: a trial's seed depends on its index only (so chunking and arrival
 * order cannot change the answer), the summary is bounded and merges exactly, and the histogram
 * accounts for every trial.
 */

import { describe, expect, it } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import {
  DEFAULT_MONTE_CARLO_TRIALS,
  MONTE_CARLO_HISTOGRAM_BINS,
  MONTE_CARLO_MAX_TRIALS,
  MONTE_CARLO_MIN_TRIALS,
  buildHistogram,
  mergeMonteCarloSummaries,
  resolveMonteCarloConfig,
  runMonteCarlo,
  runMonteCarloRange,
  trialSeed,
  type MonteCarloRunResult,
  type MonteCarloSummary,
} from './monte-carlo';
import { simulate } from './simulate';
import {
  create401kAccount,
  createContributionRule,
  createDefaultTimeline,
  createLivingExpense,
  createSimulatorInputs,
  createWageIncome,
} from './__tests__/test-utils';

const AS_OF = '2026-03-15';
const SEED = 9521;

/** The plan the Monte Carlo numbers are exercised on: marginal enough to mix successes and failures. */
const createPlan = (): SimulatorInputs =>
  createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 88 },
    accounts: { '401k-1': create401kAccount({ id: '401k-1', balance: 500000 }) },
    incomes: { 'income-1': createWageIncome({ id: 'income-1', amount: 90000 }) },
    expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 70000 }) },
    contributionRules: { 'rule-1': createContributionRule({ id: 'rule-1', accountId: '401k-1' }) },
  });

/** A cheap plan, used where the trial count (not the plan) is what is being measured. */
const createCheapPlan = (): SimulatorInputs =>
  createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 6, birthYear: 1990, lifeExpectancy: 70 },
    accounts: { '401k-1': create401kAccount({ id: '401k-1', balance: 250000 }) },
  });

/** Splits a run into chunks of `chunkSize` trial indices (the worker-pool shape) and merges. */
function runInChunks(inputs: SimulatorInputs, trials: number, chunkSize: number, order: number[] = []): MonteCarloRunResult {
  const chunks: Array<{ start: number; size: number }> = [];
  for (let start = 0; start < trials; start += chunkSize) chunks.push({ start, size: Math.min(chunkSize, trials - start) });

  const arranged = order.length > 0 ? order.map((index) => chunks[index]) : chunks;
  const partials = arranged.map((chunk) =>
    runMonteCarloRange(inputs, {
      mode: 'monteCarloStochasticReturns',
      baseSeed: SEED,
      asOf: AS_OF,
      config: { retention: 'full' },
      startIndex: chunk.start,
      count: chunk.size,
    })
  );

  return {
    simulations: partials.flatMap((partial) => partial.simulations),
    summary: mergeMonteCarloSummaries(partials.map((p) => p.summary)),
  };
}

const seedsOf = (simulations: Array<[number, unknown]>): number[] => simulations.map(([seed]) => seed);

const sumBinCounts = (summary: MonteCarloSummary): number => summary.histogram.bins.reduce((total, bin) => total + bin.count, 0);

describe('monteCarlo configuration', () => {
  it(`defaults to ${DEFAULT_MONTE_CARLO_TRIALS} trials and summary retention (F7)`, () => {
    expect(DEFAULT_MONTE_CARLO_TRIALS).toBe(500);
    expect(resolveMonteCarloConfig()).toEqual({ trials: 500, retention: 'summary' });
  });

  it(`accepts ${MONTE_CARLO_MIN_TRIALS} and ${MONTE_CARLO_MAX_TRIALS}, and rejects anything outside`, () => {
    expect(resolveMonteCarloConfig({ trials: 100 }).trials).toBe(100);
    expect(resolveMonteCarloConfig({ trials: 5000 }).trials).toBe(5000);

    for (const trials of [99, 5001, 0, -1, 100.5, Number.NaN]) {
      expect(() => resolveMonteCarloConfig({ trials })).toThrow(/monteCarlo\.trials must be an integer between 100 and 5000/);
    }
  });

  it('rejects an unknown retention mode', () => {
    expect(() => resolveMonteCarloConfig({ retention: 'nope' as never })).toThrow(/retention must be 'summary' or 'full'/);
  });

  it('surfaces the configuration through simulate()', () => {
    const outcome = simulate(createCheapPlan(), {
      mode: 'monteCarloStochasticReturns',
      seed: SEED,
      asOf: AS_OF,
      monteCarlo: { trials: 100 },
    });

    expect(outcome.mode).toBe('monteCarloStochasticReturns');
    expect(outcome.result.summary.trials).toBe(100);

    expect(() =>
      simulate(createCheapPlan(), { mode: 'monteCarloStochasticReturns', seed: SEED, asOf: AS_OF, monteCarlo: { trials: 99 } })
    ).toThrow(/between 100 and 5000/);
  });

  it('refuses a shorthand that disagrees with monteCarlo.trials', () => {
    expect(() =>
      simulate(createCheapPlan(), {
        mode: 'monteCarloStochasticReturns',
        seed: SEED,
        asOf: AS_OF,
        trials: 100,
        monteCarlo: { trials: 200 },
      })
    ).toThrow(/disagrees/);
  });
});

describe('trial seeds', () => {
  it('depend on the base seed and the trial index only', () => {
    expect(trialSeed(1, 0)).toBe(1);
    expect(trialSeed(1, 1)).toBe(1 + 1009);
    expect(trialSeed(1, 2)).toBe(1 + 2 * 1009);
    // Same index, same seed, whatever the run and however the work was split.
    expect(trialSeed(9521, 137)).toBe(trialSeed(9521, 137));
  });

  it('are unaffected by chunking (chunk 1 no longer restarts at a stride of 9973)', () => {
    const oneChunk = seedsOf(runInChunks(createCheapPlan(), 100, 100).simulations);
    const tenChunks = seedsOf(runInChunks(createCheapPlan(), 100, 10).simulations);

    expect(tenChunks).toEqual(oneChunk);
    // The old mapping started chunk 1 at `seed + 9973`; the new one continues `seed + index*1009`.
    expect(oneChunk[10]).toBe(trialSeed(SEED, 10));
    expect(oneChunk[10]).not.toBe(SEED + 9973);
  });
});

describe('chunk independence', () => {
  it('gives identical seeds and summaries for chunk sizes 1, 7, 50 and 100', { timeout: 60_000 }, () => {
    const whole = runInChunks(createPlan(), 100, 100);

    for (const chunkSize of [1, 7, 50]) {
      const chunked = runInChunks(createPlan(), 100, chunkSize);

      expect(seedsOf(chunked.simulations)).toEqual(seedsOf(whole.simulations));
      expect(chunked.summary).toStrictEqual(whole.summary);
    }
  });

  it('gives identical results when the chunks are merged in a different order', { timeout: 60_000 }, () => {
    const forward = runInChunks(createPlan(), 100, 10);
    const reversed = runInChunks(createPlan(), 100, 10, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

    expect(seedsOf(reversed.simulations).sort((a, b) => a - b)).toEqual(seedsOf(forward.simulations).sort((a, b) => a - b));
    expect(reversed.summary).toStrictEqual(forward.summary);
  });

  it('matches a one-shot run', { timeout: 60_000 }, () => {
    const oneShot = runMonteCarlo(createPlan(), {
      mode: 'monteCarloStochasticReturns',
      baseSeed: SEED,
      asOf: AS_OF,
      config: { trials: 100 },
    });
    const chunked = runInChunks(createPlan(), 100, 7);

    expect(chunked.summary).toStrictEqual(oneShot.summary);
  });

  it('is identical in the historical Monte Carlo mode too', { timeout: 60_000 }, () => {
    const oneShot = runMonteCarlo(createCheapPlan(), {
      mode: 'monteCarloHistoricalReturns',
      baseSeed: SEED,
      asOf: AS_OF,
      config: { trials: 100 },
    });
    const chunked = [0, 1, 2, 3].flatMap(
      (index) =>
        runMonteCarloRange(createCheapPlan(), {
          mode: 'monteCarloHistoricalReturns',
          baseSeed: SEED,
          asOf: AS_OF,
          config: { trials: 100 },
          startIndex: index * 25,
          count: 25,
        }).summary
    );

    expect(mergeMonteCarloSummaries(chunked)).toStrictEqual(oneShot.summary);
  });
});

describe('retention', () => {
  it("keeps no full results under 'summary' and every one under 'full'", { timeout: 60_000 }, () => {
    const summaryOnly = runMonteCarlo(createCheapPlan(), {
      mode: 'monteCarloStochasticReturns',
      baseSeed: SEED,
      asOf: AS_OF,
      config: { trials: 100, retention: 'summary' },
    });
    const full = runMonteCarlo(createCheapPlan(), {
      mode: 'monteCarloStochasticReturns',
      baseSeed: SEED,
      asOf: AS_OF,
      config: { trials: 100, retention: 'full' },
    });

    expect(summaryOnly.simulations).toEqual([]);
    expect(full.simulations).toHaveLength(100);
    // Retention changes what is kept, never the aggregates.
    expect(summaryOnly.summary).toStrictEqual(full.summary);
  });
});

describe('summary', () => {
  it('accounts for every trial in the histogram', { timeout: 60_000 }, () => {
    const { summary } = runMonteCarlo(createPlan(), {
      mode: 'monteCarloStochasticReturns',
      baseSeed: SEED,
      asOf: AS_OF,
      config: { trials: 100 },
    });

    expect(summary.histogram.bins).toHaveLength(MONTE_CARLO_HISTOGRAM_BINS);
    expect(sumBinCounts(summary)).toBe(100);
    // One final value per trial, and the success rate is exactly successes / trials.
    expect(summary.finalValues).toHaveLength(100);
    expect(summary.successRate).toBeCloseTo(summary.successes / 100, 12);
  });

  it('is a genuine mix on the marginal plan, not all-green', { timeout: 60_000 }, () => {
    const { summary } = runMonteCarlo(createPlan(), {
      mode: 'monteCarloStochasticReturns',
      baseSeed: SEED,
      asOf: AS_OF,
      config: { trials: 100 },
    });

    expect(summary.successes).toBeGreaterThan(0);
    expect(summary.successes).toBeLessThan(100);
    expect(summary.retirementAge.reached).toBeGreaterThan(0);
    expect(summary.bankruptcyAge.count).toBeGreaterThan(0);
  });

  it('bins a degenerate distribution into a single bucket', () => {
    const histogram = buildHistogram([5, 5, 5]);

    expect(histogram).toEqual({ binWidth: 0, min: 5, max: 5, bins: [{ lowerBound: 5, upperBound: 5, count: 3 }] });
  });

  it('puts the maximum in the last bin and never overflows the bucket count', () => {
    const histogram = buildHistogram([0, 10]);

    expect(histogram.bins).toHaveLength(MONTE_CARLO_HISTOGRAM_BINS);
    expect(histogram.bins[0].count).toBe(1);
    expect(histogram.bins[histogram.bins.length - 1].count).toBe(1);
  });
});

describe('memory bound', () => {
  const heapUsed = (): number => {
    global.gc?.();
    return process.memoryUsage().heapUsed;
  };

  it('retains nothing proportional to trials × years under summary retention', { timeout: 60_000 }, () => {
    // A cheap plan keeps this affordable at the maximum trial count; the bound is about what the
    // aggregator keeps, not about how expensive one trial is.
    const measure = (trials: number): { retainedMb: number; summary: MonteCarloSummary } => {
      const before = heapUsed();
      const result = runMonteCarlo(createCheapPlan(), {
        mode: 'monteCarloStochasticReturns',
        baseSeed: SEED,
        asOf: AS_OF,
        config: { trials, retention: 'summary' },
      });
      const after = heapUsed();

      expect(result.simulations).toEqual([]);
      return { retainedMb: (after - before) / (1024 * 1024), summary: result.summary };
    };

    const atDefault = measure(DEFAULT_MONTE_CARLO_TRIALS);
    const atMaximum = measure(MONTE_CARLO_MAX_TRIALS);

    expect(atDefault.summary.trials).toBe(DEFAULT_MONTE_CARLO_TRIALS);
    expect(atMaximum.summary.trials).toBe(MONTE_CARLO_MAX_TRIALS);
    expect(sumBinCounts(atMaximum.summary)).toBe(MONTE_CARLO_MAX_TRIALS);

    // The summary keeps one double per trial plus one accumulator per year — a few hundred KB at
    // most. `retention: 'full'` is what would grow with trials × years.
    expect(atDefault.retainedMb).toBeLessThan(16);
    expect(atMaximum.retainedMb).toBeLessThan(32);
  });
});
