/**
 * Milestones (parity plan P1-P7) — the pure core.
 *
 * Four modules, and nothing else:
 *
 * | module | question it answers |
 * | --- | --- |
 * | `types` | what a milestone condition *is* (`MilestoneExpression`) and what it is evaluated against (`MilestoneSnapshot`) |
 * | `evaluate` | is the condition met at this instant? (`evaluateMilestone`) |
 * | `dependency-graph` | is the plan's web of milestone references plannable? (`findMilestoneCycles`, which reports the loop of names) |
 * | `latch` | has it fired, and did it fire *now*? (`tickMilestoneLatch`, a one-way state machine) |
 *
 * All of it is a pure function of its arguments: no clock, no store, no engine import, no module
 * state, no wall-clock read. Placing the modules under `src/lib/calc` is deliberate — the
 * determinism lint (`no-restricted-syntax` on argument-less `new Date()`/`Date.now()` and the
 * import ban on `system-clock`) covers this directory, so purity is enforced rather than promised.
 *
 * ## What this is not
 *
 * The row's remaining work needs either the export-version constant (which another change holds)
 * or the engine, so it is deliberately absent here — this module set adds no plan field:
 *
 * - `milestones` in `SimulatorInputs` (a Zod schema built from `MILESTONE_METRICS` /
 *   `MILESTONE_OPERATORS`, a `references` field per milestone, and the Convex validator);
 * - `timePointSchema.milestone` (a time point that resolves to "when this milestone fires"), plus
 *   its branch in `time-binding.ts`;
 * - the plan-level `superRefine` that turns `findMilestoneCycles` into a validation issue;
 * - the engine call at month start that builds a `MilestoneSnapshot` from a `SimulationDataPoint`
 *   and ticks each latch (it must build `netWorth` from portfolio + physical assets − debt, and
 *   take `income`/`expense` from the data point's own totals);
 * - the extractor's marker output (§4's event annotations) that reads `firedAt` off a latch.
 *
 * The wiring item also owns the two reference questions this layer cannot answer: rejecting a
 * milestone that references an id the plan does not contain, and persisting latch state (whether a
 * fired milestone is recomputed from a re-run or stored, and how an edited condition resets it).
 */

export {
  MILESTONE_METRICS,
  MILESTONE_METRIC_UNITS,
  MILESTONE_OPERATORS,
  isMilestoneGroup,
  type MilestoneComparison,
  type MilestoneExpression,
  type MilestoneGroup,
  type MilestoneLeaf,
  type MilestoneMetric,
  type MilestoneMetricUnit,
  type MilestoneOperator,
  type MilestoneSnapshot,
  type SimpleMilestoneMetric,
} from './types';

export { MILESTONE_EQUALITY_TOLERANCE, compareMilestoneValues, evaluateMilestone, readMilestoneLeafValue } from './evaluate';

export { findMilestoneCycles, formatMilestoneCycle, type MilestoneCycle, type MilestoneDependency } from './dependency-graph';

export {
  PENDING_MILESTONE_LATCH,
  tickMilestoneLatch,
  type MilestoneFireDate,
  type MilestoneLatchOutcome,
  type MilestoneLatchResult,
  type MilestoneLatchState,
} from './latch';
