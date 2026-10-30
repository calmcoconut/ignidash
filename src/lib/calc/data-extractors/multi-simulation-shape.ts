/**
 * Shape validation shared by the multi-simulation (Monte Carlo) aggregators.
 *
 * Every yearly aggregate walks the year dimension and reads each run at that year. The three
 * aggregators used to run that walk as `for (let i = 0; i < yearCount; i++)` and then index
 * *runs* with `simulations.simulations[i]`, conflating the year index with the run index: with
 * fewer runs than years it read past the end of the run array and threw. Production never hit
 * it only because 500 trials exceed a ~50-year horizon.
 *
 * The invariant the aggregators actually need is "every run has the same number of years", which
 * is a property of the runs, not of the years. `simulationYearCount` checks it once by iterating
 * runs and returns the year count the callers loop over.
 */

import type { MultiSimulationResult } from '@/lib/calc/simulation-engine';

/** Message used when the run lengths disagree; kept stable for tests and diagnostics. */
export const MIXED_SIMULATION_LENGTH_ERROR = 'All simulations must have the same length for yearly aggregate data extraction.';

/**
 * Number of yearly rows in a multi-simulation result, after checking every run agrees.
 *
 * @param simulations - Monte Carlo (or any multi-run) result
 * @returns The common year count, or `0` for a set with no runs (callers then produce no rows)
 * @throws When two runs have different lengths, because a row would not describe the same year
 */
export function simulationYearCount(simulations: MultiSimulationResult): number {
  const runs = simulations.simulations;
  if (runs.length === 0) return 0;

  const yearCount = runs[0][1].data.length;

  for (const [seed, run] of runs) {
    if (run.data.length !== yearCount) {
      throw new Error(`${MIXED_SIMULATION_LENGTH_ERROR} (run ${seed} has ${run.data.length} years, expected ${yearCount})`);
    }
  }

  return yearCount;
}
