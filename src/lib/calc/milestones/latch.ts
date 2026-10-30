/**
 * The milestone latch (parity plan P1-P7): evaluate at month start, fire once.
 *
 * A milestone is not a predicate, it is an event. "Net worth ≥ $1M" is interesting the first month
 * it is true — that is the month the plan marks, and (once the wiring item lands) the month an
 * event date may key off. Every month after that it is still true, and re-firing it would spam a
 * marker per month, so the row requires the evaluation to be **latched**: fired stays fired.
 *
 * The latch is modelled as an explicit state machine rather than a boolean the caller passes back
 * in, for one reason: a boolean makes the mistake available. `if (!fired && met) fire()` with
 * `fired` supplied by the caller fires twice the moment two code paths (the engine, a form
 * preview, a re-render) each hold a copy — and the plan has three such paths. Here the only way to
 * learn that a milestone has fired is to consume the state the tick returned, and the transition
 * is one-way, so no argument the caller can pass makes a fired milestone fire again:
 *
 *     pending ──met──────▶ fired        (outcome 'firedNow', stamps year+month)
 *        │
 *        └──unmet───────▶ pending      (outcome 'stillUnmet', same state object back)
 *
 *     fired ──anything───▶ fired        (outcome 'alreadyFired', same state object back)
 *
 * Two invariants make it safe to call the tick as often as convenient — every month, every
 * re-render, twice with the same snapshot:
 *
 * 1. **It never resets.** `fired` has no outgoing edge back to `pending`, and no branch anywhere
 *    constructs a pending state from a fired one. The simulation cannot "un-reach" a milestone by
 *    revising an earlier month.
 * 2. **It is idempotent.** Ticking a fired state returns the *same state object* (`toBe`, not just
 *    deep-equality), so a second evaluation on the same month changes nothing at all, and ticking
 *    a `stillUnmet` result again re-evaluates from an identical state.
 *
 * The fire date is stamped from the snapshot's own `year`/`month`, never from a wall clock: the
 * module is pure (`tick(state, expression, snapshot)`), so a run replayed with the same inputs
 * stamps the same date, which is what the annotation extractor's markers need and what the
 * determinism lint under `src/lib/calc` enforces for free.
 *
 * Only the first evaluation is recorded. A later month's tick against a fired milestone returns
 * the **original** `firedAt`, not the month that happened to be evaluated last: "fired in March
 * 2031" does not become "fired in August 2031" because the engine ran again.
 */

import { evaluateMilestone } from './evaluate';
import type { MilestoneExpression, MilestoneSnapshot } from './types';

/** The month a milestone fired: `year` is a calendar year, `month` is 1-12 (a month start). */
export interface MilestoneFireDate {
  readonly year: number;
  readonly month: number;
}

/** A milestone's latch. `pending` until the condition is first met, `fired` forever after. */
export type MilestoneLatchState = { readonly status: 'pending' } | { readonly status: 'fired'; readonly firedAt: MilestoneFireDate };

/**
 * The start state of every milestone. Frozen, because it is shared: no caller may mutate it into
 * an early fire, and `tickMilestoneLatch` never writes to the state it is given.
 */
export const PENDING_MILESTONE_LATCH: MilestoneLatchState = Object.freeze({ status: 'pending' });

/** What one month-start evaluation did. Exactly one of the three, so a caller must handle each. */
export type MilestoneLatchOutcome =
  /** The condition was met for the first time: this is the month the milestone is reached. */
  | 'firedNow'
  /** The condition was still false; the milestone stays pending. */
  | 'stillUnmet'
  /** The milestone fired on an earlier evaluation; nothing changed and nothing is re-stamped. */
  | 'alreadyFired';

/** The result of one tick: what happened, the state to keep, and the fire date once there is one. */
export interface MilestoneLatchResult {
  readonly outcome: MilestoneLatchOutcome;
  /** The state to carry into the next tick. Identical (same object) when nothing changed. */
  readonly state: MilestoneLatchState;
  /** The month the milestone fired, or `null` while it is pending. */
  readonly firedAt: MilestoneFireDate | null;
}

/**
 * Evaluate one milestone at one month start and advance its latch.
 *
 * `snapshot` is the month-start reading (see `types.ts`); its `year`/`month` are the fire date. The
 * expression is only evaluated while the latch is pending — a fired milestone costs one comparison
 * per tick, not a tree walk.
 */
export function tickMilestoneLatch(
  state: MilestoneLatchState,
  expression: MilestoneExpression,
  snapshot: MilestoneSnapshot
): MilestoneLatchResult {
  // The one-way door, checked first: once fired, nothing the snapshot says can change anything.
  if (state.status === 'fired') return { outcome: 'alreadyFired', state, firedAt: state.firedAt };

  if (!evaluateMilestone(expression, snapshot)) return { outcome: 'stillUnmet', state, firedAt: null };

  const firedAt: MilestoneFireDate = Object.freeze({ year: snapshot.year, month: snapshot.month });
  const firedState: MilestoneLatchState = Object.freeze({ status: 'fired', firedAt });
  return { outcome: 'firedNow', state: firedState, firedAt };
}
