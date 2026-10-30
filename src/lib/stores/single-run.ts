/**
 * The store's single-run policy, in one pure function.
 *
 * `simulate()` (`src/lib/calc/simulate.ts`) owns the engine wiring: which provider, which engine,
 * how the historical context is assembled. The UI used to re-derive all of that inside
 * `useSimulationResult`, which meant the store could drift from `simulate()` — and it had: a plan
 * with `historicalBacktest.mode: 'truncate'` was rendered as a looping backtest, because the store
 * built the provider without the mode and patched `context.historicalRanges` in by hand.
 *
 * What is left here is the part that is genuinely the store's, and only that:
 *
 * 1. the **seed override** rule — a Monte Carlo seed drill-down runs at that trial's seed instead
 *    of `simulationSettings.simulationSeed`;
 * 2. the **pin suppression** rule — such a per-seed run must not re-pin the historical start
 *    years, because the pins describe the plan's historical run, not a Monte Carlo trial;
 * 3. the **null for a plan without a timeline** contract — callers render "results will appear
 *    here" rather than catching a throw;
 * 4. the resolved **clock**, passed in by the caller. This module never reads the wall clock; the
 *    store boundary (`useSimulationClock`) owns the one read.
 *
 * No React, no Comlink, no worker and no browser globals, so the test suite can import this
 * module directly and compare it with `simulate()` instead of transcribing the wiring.
 */

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import type { ISODateString } from '@/lib/calc/clock';
import type { SimulationResult } from '@/lib/calc/simulation-engine';
import { simulate, type SingleSimulationMode } from '@/lib/calc/simulate';

export interface SingleRunOptions {
  /** A trial seed from the Monte Carlo drill-down; absent means "use the plan's own seed". */
  seedOverride?: number | null;
  /** The store's resolved clock, as an ISO calendar date. */
  asOf: ISODateString;
}

/**
 * Runs one plan through `simulate()` with the store's seed, pin and clock rules applied.
 *
 * @returns the engine's `SimulationResult`, or `null` when the plan has no timeline yet.
 */
export function runStoreSingleSimulation(
  inputs: SimulatorInputs,
  mode: SingleSimulationMode,
  options: SingleRunOptions
): SimulationResult | null {
  if (!inputs.timeline) return null;

  const { seedOverride } = options;
  const hasSeedOverride = seedOverride !== undefined && seedOverride !== null;
  const seed = hasSeedOverride ? seedOverride : inputs.simulationSettings.simulationSeed;

  // `simulate()` reads the historical pins from the plan, and deliberately has no override option:
  // one pin, one source. So the store expresses "a per-seed run ignores the pins" by clearing them
  // on a copy of the inputs. It only matters for the historical mode, which is the only reader.
  const runInputs = hasSeedOverride && mode === 'historicalReturns' ? withoutHistoricalPins(inputs) : inputs;

  return simulate(runInputs, { mode, seed, asOf: options.asOf }).result;
}

/** A copy of the plan with the historical start-year pins removed. */
function withoutHistoricalPins(inputs: SimulatorInputs): SimulatorInputs {
  const {
    historicalStartYearOverride: _startYear,
    historicalRetirementStartYearOverride: _retirementStartYear,
    ...simulationSettings
  } = inputs.simulationSettings;

  return { ...inputs, simulationSettings };
}
