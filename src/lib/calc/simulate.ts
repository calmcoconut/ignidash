/**
 * Pure simulation entry point (parity plan P2-P1a).
 *
 * `simulate()` is the whole engine behind one function: no store, no Web Worker, no Comlink,
 * no browser globals, no module state. Every input it needs is an argument, so two calls with
 * the same arguments return deep-equal results on any day, in any timezone, and the module is
 * safe to import from a Convex `'use node'` action (§7-A1).
 *
 * The function is an *extraction*, not a new engine: it performs exactly the provider/engine
 * selection the store's worker path performs (`src/lib/workers/simulation.worker.ts` plus
 * `useSimulationResult` / `useMultiSimulationResult` in `src/lib/stores/simulator-store.ts`)
 * and returns the engines' own result types unchanged:
 *
 * - single-run modes → `SimulationResult`
 * - Monte Carlo modes → `MultiSimulationResult`, the same shape the simulation workers post to
 *   the merge worker, so the existing analyzers/extractors consume it without a parallel type.
 *
 * The store keeps its worker pool for UI responsiveness; that pool is orchestration, and this
 * module is the same computation without it.
 *
 * Contract 3.1: `cumulativeInflationIndex` is re-exported here (see the export below) so a
 * caller can value an amount in the plan's inflation path without reaching into calc internals.
 */

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import type { SimulationSettingsInputs } from '@/lib/schemas/inputs/simulation-settings-form-schema';

import { type ISODateString, fixedClock } from './clock';
import {
  FinancialSimulationEngine,
  LcgHistoricalBacktestSimulationEngine,
  MonteCarloSimulationEngine,
  type MultiSimulationResult,
  type SimulationResult,
} from './simulation-engine';
import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { StochasticReturnsProvider } from './returns-providers/stochastic-returns-provider';

/**
 * Contract 3.1 — the single definition of the plan's cumulative inflation path.
 *
 * It is a named re-export rather than a field on the result on purpose: `SimulationResult` is
 * the engines' type (and what the extractors consume), so adding a plan-level helper to it
 * would either invent a wrapper result type or push a field nobody reads through every
 * extractor. A re-export keeps one implementation (`time-binding.ts` owns it), gives callers a
 * single import for "run the plan and convert dollars", and cannot drift from what the engine
 * used internally because it *is* the same function object.
 */
export { cumulativeInflationIndex } from './time-binding';

/** The five modes the app defines, taken from the settings schema's enum so the union cannot drift. */
type SimulationMode = SimulationSettingsInputs['simulationMode'];

/** Modes that produce one deterministic run. */
const SINGLE_SIMULATION_MODES = ['fixedReturns', 'stochasticReturns', 'historicalReturns'] as const;

/** Modes that produce a set of runs. */
const MONTE_CARLO_MODES = ['monteCarloStochasticReturns', 'monteCarloHistoricalReturns'] as const;

export type SingleSimulationMode = (typeof SINGLE_SIMULATION_MODES)[number];
export type MonteCarloSimulationMode = (typeof MONTE_CARLO_MODES)[number];

/** Arguments that fully determine a run. `asOf` is required: there is deliberately no wall-clock default. */
export interface SimulateOptions<M extends SimulationMode = SimulationMode> {
  /** Which engine path to run, using the same names as `simulationSettings.simulationMode`. */
  mode: M;
  /** Seed for the stochastic / historical / Monte Carlo paths; ignored by `fixedReturns`. */
  seed: number;
  /** The run's clock, as an ISO calendar date (`YYYY-MM-DD`). Never defaulted from the host clock. */
  asOf: ISODateString;
  /**
   * Monte Carlo trials. Only valid for the two `monteCarlo*` modes, where it is honoured
   * exactly; omitted means {@link DEFAULT_MONTE_CARLO_TRIALS}. Passing it to a single-run mode
   * throws instead of being ignored. The bounded/streaming configuration (retention,
   * histogram, the 100–5000 range) is P2-P3.
   */
  trials?: number;
}

/** A single-run outcome: the engine's own `SimulationResult`. */
export interface SingleSimulationOutcome<M extends SingleSimulationMode = SingleSimulationMode> {
  mode: M;
  result: SimulationResult;
}

/** A Monte Carlo outcome: the engine's own `MultiSimulationResult`. */
export interface MonteCarloOutcome<M extends MonteCarloSimulationMode = MonteCarloSimulationMode> {
  mode: M;
  result: MultiSimulationResult;
}

export type SimulateResult = SingleSimulationOutcome | MonteCarloOutcome;

/**
 * The outcome type a given mode produces, so `simulate()` narrows at the call site: a
 * `'fixedReturns'` literal yields `SimulationResult`, a `'monteCarlo…'` literal yields
 * `MultiSimulationResult`, and a variable mode yields the discriminated union.
 */
export type SimulateResultFor<M extends SimulationMode> = M extends SingleSimulationMode
  ? SingleSimulationOutcome<M>
  : MonteCarloOutcome<Extract<M, MonteCarloSimulationMode>>;

/** The app's Monte Carlo default trial count (F7); matches what the store's pool runs today. */
export const DEFAULT_MONTE_CARLO_TRIALS = 500;

/**
 * Chunking of a Monte Carlo run, mirroring today's store/worker path exactly: the store splits
 * the trials into chunks of 10 and gives chunk `c` the base seed `seed + c * 9973`, and each
 * engine then uses `baseSeed + i * 1009` inside its chunk. Reproducing that mapping is what
 * makes a pure run agree seed-for-seed with the worker pool. P2-P3 replaces it with a mapping
 * that does not depend on chunking at all.
 */
const MONTE_CARLO_CHUNK_SIZE = 10;
const MONTE_CARLO_CHUNK_STRIDE = 9973;

/**
 * Runs one simulation, or one Monte Carlo collection, as a pure function of its arguments.
 *
 * @throws if the plan has no timeline, if `asOf` is not a real `YYYY-MM-DD` date, if `seed` is
 * not a positive integer, if `trials` is not a positive integer, or if `trials` is passed to a
 * single-run mode.
 */
export function simulate<M extends SimulationMode>(inputs: SimulatorInputs, options: SimulateOptions<M>): SimulateResultFor<M> {
  // Safe by construction: `runSimulation` picks `mode` and the result shape in the same switch,
  // and `SimulateResultFor` is that correspondence expressed as a type.
  return runSimulation(inputs, options) as SimulateResultFor<M>;
}

function runSimulation(inputs: SimulatorInputs, options: SimulateOptions): SimulateResult {
  const { mode, seed, asOf } = options;

  const timeline = inputs.timeline;
  if (!timeline) throw new Error('simulate(): inputs.timeline is required; a plan without a timeline has no projection.');

  if (!Number.isInteger(seed) || seed <= 0) {
    throw new Error(`simulate(): seed must be a positive integer, received ${String(seed)}.`);
  }

  // Validates the ISO date and throws on anything that is not a real calendar date.
  const clock = fixedClock(asOf);

  switch (mode) {
    case 'fixedReturns': {
      assertNoTrials(options);

      const engine = new FinancialSimulationEngine(inputs, clock);
      return { mode, result: engine.runSimulation(new FixedReturnsProvider(inputs), timeline) };
    }

    case 'stochasticReturns': {
      assertNoTrials(options);

      const engine = new FinancialSimulationEngine(inputs, clock);
      return { mode, result: engine.runSimulation(new StochasticReturnsProvider(inputs, seed), timeline) };
    }

    case 'historicalReturns': {
      assertNoTrials(options);

      // Historical start-year pinning stays a plan input, exactly as the store reads it.
      const { historicalStartYearOverride, historicalRetirementStartYearOverride } = inputs.simulationSettings;
      const engine = new LcgHistoricalBacktestSimulationEngine(inputs, seed, clock);

      return { mode, result: engine.runSingleSimulation(seed, historicalStartYearOverride, historicalRetirementStartYearOverride) };
    }

    case 'monteCarloStochasticReturns': {
      const trials = resolveTrials(options);
      const simulations = runInChunks(seed, trials, (chunkSeed, size) =>
        new MonteCarloSimulationEngine(inputs, chunkSeed, clock).runMonteCarloSimulation(size)
      );

      return { mode, result: { simulations } };
    }

    case 'monteCarloHistoricalReturns': {
      const trials = resolveTrials(options);
      const simulations = runInChunks(seed, trials, (chunkSeed, size) =>
        new LcgHistoricalBacktestSimulationEngine(inputs, chunkSeed, clock).runLcgHistoricalBacktest(size)
      );

      return { mode, result: { simulations } };
    }

    default: {
      // Exhaustiveness guard: a newly added mode fails to compile here instead of silently
      // falling through, and an out-of-union value at runtime throws rather than guessing.
      const unhandled: never = mode;
      const knownModes = [...SINGLE_SIMULATION_MODES, ...MONTE_CARLO_MODES].join(', ');
      throw new Error(`simulate(): unknown simulation mode "${String(unhandled)}"; expected one of ${knownModes}.`);
    }
  }
}

/**
 * Splits `trials` into the store's worker-sized chunks and concatenates the per-chunk results,
 * preserving seed order (chunk by chunk, seed within chunk) so the output is deterministic.
 */
function runInChunks(
  seed: number,
  trials: number,
  runChunk: (chunkSeed: number, size: number) => MultiSimulationResult
): Array<[number, SimulationResult]> {
  const simulations: Array<[number, SimulationResult]> = [];

  for (let offset = 0, chunkIndex = 0; offset < trials; offset += MONTE_CARLO_CHUNK_SIZE, chunkIndex++) {
    const size = Math.min(MONTE_CARLO_CHUNK_SIZE, trials - offset);
    simulations.push(...runChunk(seed + chunkIndex * MONTE_CARLO_CHUNK_STRIDE, size).simulations);
  }

  return simulations;
}

/** Resolves and validates the Monte Carlo trial count. */
function resolveTrials(options: SimulateOptions): number {
  const trials = options.trials ?? DEFAULT_MONTE_CARLO_TRIALS;

  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`simulate(): trials must be a positive integer, received ${String(trials)}.`);
  }

  return trials;
}

/** Single-run modes have nothing to do with trials, so a supplied value is a caller bug, not a no-op. */
function assertNoTrials(options: SimulateOptions): void {
  if (options.trials !== undefined) {
    throw new Error(
      `simulate(): trials is only valid for the Monte Carlo modes (${MONTE_CARLO_MODES.join(', ')}), but mode "${options.mode}" runs once.`
    );
  }
}
