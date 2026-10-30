/**
 * The one definition of a successful simulation run (parity plan P2-P2).
 *
 * Before this module three readouts each carried their own version of the predicate and they
 * disagreed:
 *
 * | readout | retirement term | shortfall term |
 * | --- | --- | --- |
 * | `KeyMetricsExtractor` (the headline) | the strategy's `retirementAge` | checked |
 * | `TableDataExtractor` (per-row column) | `retirementAge !== null` | **missing** |
 * | `MultiSimulationAnalyzer` (chart/percentile path) | final `phase === 'retirement'` | **missing** |
 *
 * Every readout now calls `evaluateSuccess`, so the headline success rate is the mean of the
 * per-row column by construction rather than by coincidence.
 *
 * Both terms are taken from the engine, not recomputed here:
 *
 * - **Reached retirement** comes from `SimulationDataExtractor.getMilestonesData`, the same
 *   helper the per-row table uses: the run's phase reached `retirement` at some data point, so
 *   the age is `null` only when the phase never got there. Which runs can miss it depends on the
 *   strategy. With `swrTarget` the phase starts once the target withdrawal rate is sustainable,
 *   so a plan that runs out of money first never reaches it. With `fixedAge` the phase is purely
 *   age-based: a plan that goes bankrupt at 36 still enters retirement at 65, so the milestone is
 *   present and this predicate fails on its shortfall and final-balance terms instead. Only a
 *   `fixedAge` retirement age past the horizon (life expectancy) leaves the age `null`.
 * - **Shortfall** is the engine's own `PortfolioData.shortfall`, the amount an annual period
 *   could not fund after every account was drained (`portfolio.ts`). A run that ever recorded
 *   one failed that year, even if a later surplus repaid it: `shortfallRepaid` and
 *   `outstandingShortfall` are the repayment side, which is not what this predicate means.
 */

import { SimulationDataExtractor } from './data-extractors/simulation-data-extractor';
import type { SimulationResult } from './simulation-engine';

/** A portfolio at or below this value counts as spent out (floating-point residual tolerance). */
export const SUCCESS_MINIMUM_FINAL_PORTFOLIO = 0.1;

/**
 * True when the run succeeded: it reached retirement, ended with more than
 * {@link SUCCESS_MINIMUM_FINAL_PORTFOLIO}, and never recorded a shortfall.
 */
export function evaluateSuccess(simulation: SimulationResult): boolean {
  const { data, context } = simulation;

  const { retirementAge } = SimulationDataExtractor.getMilestonesData(data, context.startAge);
  if (retirementAge === null) return false;

  const finalPortfolioValue = data[data.length - 1].portfolio.totalValue;
  if (finalPortfolioValue <= SUCCESS_MINIMUM_FINAL_PORTFOLIO) return false;

  return !data.some((dataPoint) => dataPoint.portfolio.shortfall > 0);
}
