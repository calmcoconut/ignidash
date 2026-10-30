/**
 * Configurable, memory-bounded Monte Carlo (parity plan P2-P3, decision F7).
 *
 * Two things this module owns:
 *
 * 1. **A chunk-independent seed mapping.** Trial `j` of a run is
 *    `trialSeed(baseSeed, j) = baseSeed + j * 1009`, so its seed depends on the base seed and its
 *    own index only. How the work is split across workers, and in what order the chunks finish,
 *    cannot change which trial a seed belongs to. (Before this, chunk `c` started from
 *    `baseSeed + c * 9973`, so a trial's seed depended on where the chunk boundary fell.)
 * 2. **A streaming summary.** Each trial contributes its final value, success flag, retirement and
 *    bankruptcy age, and its per-year portfolio values to running accumulators; the full
 *    `SimulationResult` is dropped unless `retention: 'full'` asks for it. What is kept is
 *    O(trials) doubles (final values, for the histogram) plus O(years) accumulators — never
 *    O(trials × years) result objects.
 *
 * Everything here is a pure function of its arguments: no clock, no `Math.random`, no module
 * state, and no dependence on the order chunks are merged in (`finalValues` is kept sorted, and
 * every other accumulator is order-insensitive).
 */

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { type ISODateString, fixedClock } from './clock';
import {
  type MultiSimulationResult,
  type SimulationResult,
  MonteCarloSimulationEngine,
  LcgHistoricalBacktestSimulationEngine,
} from './simulation-engine';
import { SimulationDataExtractor } from './data-extractors/simulation-data-extractor';
import { evaluateSuccess } from './success';

/** Accepted trial range (F7). */
export const MONTE_CARLO_MIN_TRIALS = 100;
export const MONTE_CARLO_MAX_TRIALS = 5000;

/** Today's behaviour, kept as the default (F7). */
export const DEFAULT_MONTE_CARLO_TRIALS = 500;

/** Bins in the final-value histogram; fixed so the corpus and callers cannot drift. */
export const MONTE_CARLO_HISTOGRAM_BINS = 20;

/** Prime spacing between trial seeds, the same one the engine already used inside a chunk. */
const TRIAL_SEED_STRIDE = 1009;

export type MonteCarloRetention = 'summary' | 'full';

export interface MonteCarloConfig {
  /** Trials to run. Integer in [100, 5000]; defaults to 500 (F7). */
  trials?: number;
  /** `'summary'` keeps aggregates only; `'full'` also keeps every `SimulationResult`. Default `'summary'`. */
  retention?: MonteCarloRetention;
}

export interface ResolvedMonteCarloConfig {
  trials: number;
  retention: MonteCarloRetention;
}

/** One bucket of the final-value histogram. */
export interface MonteCarloHistogramBin {
  lowerBound: number;
  upperBound: number;
  count: number;
}

export interface MonteCarloHistogram {
  /** Width of every bin; 0 when all trials ended at the same value (a single bin). */
  binWidth: number;
  min: number;
  max: number;
  bins: MonteCarloHistogramBin[];
}

/** Bounded, mergeable per-trial aggregates. ~1 double per trial plus one accumulator per year. */
export interface MonteCarloSummary {
  trials: number;
  successes: number;
  successRate: number;
  /** Final portfolio value per trial, ascending. Used for the histogram and exact merging. */
  finalValues: number[];
  finalValue: { mean: number; min: number; max: number };
  retirementAge: { reached: number; sum: number; min: number | null; max: number | null; mean: number | null };
  bankruptcyAge: { count: number; sum: number; min: number | null; max: number | null; mean: number | null };
  /**
   * Per-year portfolio totals. Kept as integer **cents** so merging chunks is exact: floating-point
   * sums are not associative, and a chunk boundary must not move the last digits of a total.
   */
  perYear: Array<{ year: number; totalCents: number; trials: number; mean: number }>;
  histogram: MonteCarloHistogram;
}

/** A Monte Carlo run: retained full results (empty under `'summary'`) plus the bounded summary. */
export interface MonteCarloRunResult extends MultiSimulationResult {
  summary: MonteCarloSummary;
}

/** The seed of trial `index` of a run seeded `baseSeed`. Depends on the base seed and the index only. */
export function trialSeed(baseSeed: number, index: number): number {
  return baseSeed + index * TRIAL_SEED_STRIDE;
}

/** Validates the configuration and applies the F7 defaults. Throws rather than clamping. */
export function resolveMonteCarloConfig(config: MonteCarloConfig = {}): ResolvedMonteCarloConfig {
  const trials = config.trials ?? DEFAULT_MONTE_CARLO_TRIALS;
  const retention = config.retention ?? 'summary';

  if (!Number.isInteger(trials) || trials < MONTE_CARLO_MIN_TRIALS || trials > MONTE_CARLO_MAX_TRIALS) {
    throw new Error(
      `monteCarlo.trials must be an integer between ${MONTE_CARLO_MIN_TRIALS} and ${MONTE_CARLO_MAX_TRIALS}, received ${String(trials)}.`
    );
  }

  if (retention !== 'summary' && retention !== 'full') {
    throw new Error(`monteCarlo.retention must be 'summary' or 'full', received ${String(retention)}.`);
  }

  return { trials, retention };
}

/**
 * Final-value histogram. Fixed bin count over [min, max]; the max lands in the last bin; a run
 * whose values are all equal collapses to one bin. `bins` therefore always sum to the trial count.
 */
export function buildHistogram(values: number[], binCount: number = MONTE_CARLO_HISTOGRAM_BINS): MonteCarloHistogram {
  if (values.length === 0) return { binWidth: 0, min: 0, max: 0, bins: [] };

  const min = values[0];
  const max = values[values.length - 1];

  if (min === max) return { binWidth: 0, min, max, bins: [{ lowerBound: min, upperBound: max, count: values.length }] };

  const binWidth = (max - min) / binCount;
  const bins: MonteCarloHistogramBin[] = Array.from({ length: binCount }, (_, index) => ({
    lowerBound: min + index * binWidth,
    upperBound: min + (index + 1) * binWidth,
    count: 0,
  }));

  for (const value of values) {
    const index = Math.min(Math.floor((value - min) / binWidth), binCount - 1);
    bins[index].count++;
  }

  return { binWidth, min, max, bins };
}

/** Retirement-age accumulator: how many trials reached it, and the running sum/extremes. */
type RetirementAgeAccumulator = { reached: number; sum: number; min: number | null; max: number | null };

/** Bankruptcy-age accumulator: how many trials went bankrupt, and the running sum/extremes. */
type BankruptcyAgeAccumulator = { count: number; sum: number; min: number | null; max: number | null };

/** Recomputes the derived fields (`mean`, `successRate`, `finalValue`, `histogram`) from accumulators. */
function finalize(
  trials: number,
  successes: number,
  finalValues: number[],
  retirementAge: RetirementAgeAccumulator,
  bankruptcyAge: BankruptcyAgeAccumulator,
  perYear: MonteCarloSummary['perYear']
): MonteCarloSummary {
  const sorted = [...finalValues].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    trials,
    successes,
    successRate: trials === 0 ? 0 : successes / trials,
    finalValues: sorted,
    finalValue: {
      mean: trials === 0 ? 0 : total / trials,
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
    },
    retirementAge: { ...retirementAge, mean: retirementAge.reached === 0 ? null : retirementAge.sum / retirementAge.reached },
    bankruptcyAge: { ...bankruptcyAge, mean: bankruptcyAge.count === 0 ? null : bankruptcyAge.sum / bankruptcyAge.count },
    perYear: perYear.map((entry) => ({
      ...entry,
      mean: entry.trials === 0 ? 0 : entry.totalCents / 100 / entry.trials,
    })),
    histogram: buildHistogram(sorted),
  };
}

interface Accumulator {
  trials: number;
  successes: number;
  finalValues: number[];
  retirementAge: RetirementAgeAccumulator;
  bankruptcyAge: BankruptcyAgeAccumulator;
  perYear: MonteCarloSummary['perYear'];
}

function createAccumulator(): Accumulator {
  return {
    trials: 0,
    successes: 0,
    finalValues: [],
    retirementAge: { reached: 0, sum: 0, min: null, max: null },
    bankruptcyAge: { count: 0, sum: 0, min: null, max: null },
    perYear: [],
  };
}

/** Folds one finished trial into the accumulator. This is the whole "streaming" part. */
function accumulate(accumulator: Accumulator, result: SimulationResult): void {
  const { data, context } = result;
  const { retirementAge, bankruptcyAge } = SimulationDataExtractor.getMilestonesData(data, context.startAge);

  accumulator.trials++;
  accumulator.finalValues.push(data[data.length - 1].portfolio.totalValue);
  if (evaluateSuccess(result)) accumulator.successes++;

  if (retirementAge !== null) {
    accumulator.retirementAge.reached++;
    accumulator.retirementAge.sum += retirementAge;
    accumulator.retirementAge.min =
      accumulator.retirementAge.min === null ? retirementAge : Math.min(accumulator.retirementAge.min, retirementAge);
    accumulator.retirementAge.max =
      accumulator.retirementAge.max === null ? retirementAge : Math.max(accumulator.retirementAge.max, retirementAge);
  }

  if (bankruptcyAge !== null) {
    accumulator.bankruptcyAge.count++;
    accumulator.bankruptcyAge.sum += bankruptcyAge;
    accumulator.bankruptcyAge.min =
      accumulator.bankruptcyAge.min === null ? bankruptcyAge : Math.min(accumulator.bankruptcyAge.min, bankruptcyAge);
    accumulator.bankruptcyAge.max =
      accumulator.bankruptcyAge.max === null ? bankruptcyAge : Math.max(accumulator.bankruptcyAge.max, bankruptcyAge);
  }

  for (let year = 0; year < data.length; year++) {
    const entry = (accumulator.perYear[year] ??= { year, totalCents: 0, trials: 0, mean: 0 });
    // Integer cents: exact addition, so the total does not depend on how the trials were grouped.
    entry.totalCents += Math.round(data[year].portfolio.totalValue * 100);
    entry.trials++;
  }
}

export interface MonteCarloRangeOptions {
  mode: 'monteCarloStochasticReturns' | 'monteCarloHistoricalReturns';
  baseSeed: number;
  asOf: ISODateString;
  config?: MonteCarloConfig;
  /** First trial index this range owns (chunk start). */
  startIndex?: number;
  /** How many trials this range owns; defaults to `config.trials`. */
  count?: number;
  /** Called after each trial. Purely a progress hook; it cannot affect the result. */
  onTrial?: () => void;
}

/**
 * Runs trials `[startIndex, startIndex + count)` of a Monte Carlo run and returns the retained
 * results plus the bounded summary for that range. Calling this per chunk and merging the pieces
 * gives the same answer as one call over the whole range.
 */
export function runMonteCarloRange(inputs: SimulatorInputs, options: MonteCarloRangeOptions): MonteCarloRunResult {
  const { mode, baseSeed, asOf, startIndex = 0, onTrial } = options;
  const config = resolveMonteCarloConfig(options.config);
  const count = options.count ?? config.trials;

  // An explicit count is a chunk size, so it is only required to be a positive integer: the
  // 100-5000 range applies to the public `monteCarlo.trials` configuration, not to a slice of it.
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`runMonteCarloRange(): count must be a positive integer, received ${String(count)}.`);
  }

  const timeline = inputs.timeline;
  if (!timeline) throw new Error('runMonteCarlo(): inputs.timeline is required; a plan without a timeline has no projection.');

  const clock = fixedClock(asOf);
  const engine =
    mode === 'monteCarloStochasticReturns'
      ? new MonteCarloSimulationEngine(inputs, baseSeed, clock)
      : new LcgHistoricalBacktestSimulationEngine(inputs, baseSeed, clock);

  const accumulator = createAccumulator();
  const simulations: Array<[number, SimulationResult]> = [];

  for (let index = startIndex; index < startIndex + count; index++) {
    const seed = trialSeed(baseSeed, index);
    const result =
      engine instanceof MonteCarloSimulationEngine
        ? engine.runSingleSimulation(seed)
        : engine.runSingleSimulation(seed, undefined, undefined);

    accumulate(accumulator, result);
    if (config.retention === 'full') simulations.push([seed, result]);
    onTrial?.();
  }

  return {
    simulations,
    summary: finalize(
      accumulator.trials,
      accumulator.successes,
      accumulator.finalValues,
      accumulator.retirementAge,
      accumulator.bankruptcyAge,
      accumulator.perYear
    ),
  };
}

/** Runs a whole Monte Carlo run in one call (the pure entry point's path). */
export function runMonteCarlo(inputs: SimulatorInputs, options: Omit<MonteCarloRangeOptions, 'startIndex' | 'count'>): MonteCarloRunResult {
  return runMonteCarloRange(inputs, options);
}

/**
 * Merges per-chunk summaries. Order-independent: values are re-sorted and every other field is a
 * sum, a count or an extreme.
 */
export function mergeMonteCarloSummaries(summaries: MonteCarloSummary[]): MonteCarloSummary {
  const trials = summaries.reduce((total, summary) => total + summary.trials, 0);
  const successes = summaries.reduce((total, summary) => total + summary.successes, 0);
  const finalValues = summaries.flatMap((summary) => summary.finalValues);

  const retirementAge: RetirementAgeAccumulator = { reached: 0, sum: 0, min: null, max: null };
  const bankruptcyAge: BankruptcyAgeAccumulator = { count: 0, sum: 0, min: null, max: null };
  const perYear: MonteCarloSummary['perYear'] = [];

  for (const summary of summaries) {
    retirementAge.reached += summary.retirementAge.reached;
    retirementAge.sum += summary.retirementAge.sum;
    if (summary.retirementAge.min !== null) {
      retirementAge.min = retirementAge.min === null ? summary.retirementAge.min : Math.min(retirementAge.min, summary.retirementAge.min);
    }
    if (summary.retirementAge.max !== null) {
      retirementAge.max = retirementAge.max === null ? summary.retirementAge.max : Math.max(retirementAge.max, summary.retirementAge.max);
    }

    bankruptcyAge.count += summary.bankruptcyAge.count;
    bankruptcyAge.sum += summary.bankruptcyAge.sum;
    if (summary.bankruptcyAge.min !== null) {
      bankruptcyAge.min = bankruptcyAge.min === null ? summary.bankruptcyAge.min : Math.min(bankruptcyAge.min, summary.bankruptcyAge.min);
    }
    if (summary.bankruptcyAge.max !== null) {
      bankruptcyAge.max = bankruptcyAge.max === null ? summary.bankruptcyAge.max : Math.max(bankruptcyAge.max, summary.bankruptcyAge.max);
    }

    for (const entry of summary.perYear) {
      const merged = (perYear[entry.year] ??= { year: entry.year, totalCents: 0, trials: 0, mean: 0 });
      merged.totalCents += entry.totalCents;
      merged.trials += entry.trials;
    }
  }

  return finalize(trials, successes, finalValues, retirementAge, bankruptcyAge, perYear);
}
