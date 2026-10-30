import { describe, expect, it } from 'vitest';

import { PENDING_MILESTONE_LATCH, evaluateMilestone, tickMilestoneLatch } from './index';
import type { MilestoneExpression, MilestoneLatchState, MilestoneSnapshot } from './index';

/**
 * P1-P7: the latch — evaluated at month start, fires once.
 *
 * Three outcomes (`firedNow`, `stillUnmet`, `alreadyFired`), a one-way transition, and no way to
 * fire twice however many times the tick is called.
 */

const snapshot = (month: number, year = 2030, netWorth = 900_000): MilestoneSnapshot => ({
  age: 40 + (year - 2030),
  year,
  month,
  portfolio: 800_000,
  income: 120_000,
  expense: 90_000,
  netWorth,
  accounts: { brokerage: 400_000 },
});

/** "Net worth ≥ $1M". True once the snapshot crosses the threshold. */
const NET_WORTH_GOAL: MilestoneExpression = { metric: 'netWorth', operator: '>=', value: 1_000_000 };

/** Walk twelve month starts of one year, returning every tick's result. */
function tickMonths(
  state: MilestoneLatchState,
  expression: MilestoneExpression,
  year = 2030,
  netWorthAt: (month: number) => number = () => 900_000
) {
  const results = [];
  let current = state;
  for (let month = 1; month <= 12; month += 1) {
    const result = tickMilestoneLatch(current, expression, snapshot(month, year, netWorthAt(month)));
    results.push(result);
    current = result.state;
  }
  return { results, state: current };
}

describe('the three outcomes', () => {
  it('reports stillUnmet, and hands the same state back', () => {
    const result = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, snapshot(1, 2030, 900_000));

    expect(result.outcome).toBe('stillUnmet');
    expect(result.state).toBe(PENDING_MILESTONE_LATCH);
    expect(result.firedAt).toBeNull();
  });

  it('reports firedNow and stamps the snapshot`s own month', () => {
    const result = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, snapshot(7, 2032, 1_050_000));

    expect(result.outcome).toBe('firedNow');
    expect(result.state.status).toBe('fired');
    expect(result.firedAt).toEqual({ year: 2032, month: 7 });
    expect(evaluateMilestone(NET_WORTH_GOAL, snapshot(7, 2032, 1_050_000))).toBe(true);
  });

  it('reports alreadyFired for a fired milestone, whatever the snapshot says', () => {
    const fired = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, snapshot(7, 2032, 1_050_000)).state;

    const met = tickMilestoneLatch(fired, NET_WORTH_GOAL, snapshot(8, 2032, 1_100_000));
    const unmet = tickMilestoneLatch(fired, NET_WORTH_GOAL, snapshot(8, 2032, 100_000));

    expect(met.outcome).toBe('alreadyFired');
    expect(unmet.outcome).toBe('alreadyFired');
  });

  it('keeps the original fire date after a later month is evaluated', () => {
    const fired = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, snapshot(7, 2032, 1_050_000)).state;
    const later = tickMilestoneLatch(fired, NET_WORTH_GOAL, snapshot(11, 2035, 2_000_000));

    // Not "fired in November 2035" because the engine ran again: the first month it held is the one.
    expect(later.firedAt).toEqual({ year: 2032, month: 7 });
  });
});

describe('fires exactly once', () => {
  it('does not fire twice when the same snapshot is evaluated twice', () => {
    const at = snapshot(3, 2031, 1_200_000);

    const first = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, at);
    const second = tickMilestoneLatch(first.state, NET_WORTH_GOAL, at);

    expect(first.outcome).toBe('firedNow');
    expect(second.outcome).toBe('alreadyFired');
    expect(second.state).toBe(first.state);
  });

  it('fires once across a year of month starts that all satisfy the condition', () => {
    const { results } = tickMonths(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, 2031, () => 1_500_000);

    expect(results.filter((result) => result.outcome === 'firedNow')).toHaveLength(1);
    expect(results[0].outcome).toBe('firedNow');
    expect(results[0].firedAt).toEqual({ year: 2031, month: 1 });
    expect(results.slice(1).every((result) => result.outcome === 'alreadyFired')).toBe(true);
  });

  it('fires on the first month the condition holds, not the month the run ends', () => {
    // Net worth passes $1M in month 5 and stays above it.
    const { results } = tickMonths(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, 2031, (month) => (month >= 5 ? 1_000_000 : 999_999));

    expect(results.filter((result) => result.outcome === 'firedNow')).toHaveLength(1);
    expect(results.findIndex((result) => result.outcome === 'firedNow')).toBe(4); // month 5, 0-indexed
    expect(results[4].firedAt).toEqual({ year: 2031, month: 5 });
  });
});

describe('never resets', () => {
  it('stays fired when the condition stops holding', () => {
    const fired = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, snapshot(6, 2031, 1_100_000)).state;

    // A market crash takes net worth back below the goal: the milestone is still reached.
    const crashed = tickMilestoneLatch(fired, NET_WORTH_GOAL, snapshot(7, 2031, 400_000));
    expect(crashed.outcome).toBe('alreadyFired');
    expect(crashed.state).toBe(fired);
    expect(crashed.state.status === 'fired' && crashed.state.firedAt).toEqual({ year: 2031, month: 6 });
  });

  it('does not reset over a two-year run with a mid-run reversal', () => {
    let state: MilestoneLatchState = PENDING_MILESTONE_LATCH;
    const outcomes: string[] = [];

    for (const year of [2030, 2031]) {
      const { results, state: next } = tickMonths(state, NET_WORTH_GOAL, year, (month) =>
        // 2030 crosses the goal in month 9; 2031 collapses in month 2.
        year === 2030 ? (month >= 9 ? 1_050_000 : 950_000) : month < 2 ? 1_050_000 : 200_000
      );
      outcomes.push(...results.map((result) => result.outcome));
      state = next;
    }

    expect(outcomes.filter((outcome) => outcome === 'firedNow')).toHaveLength(1);
    expect(state.status === 'fired' && state.firedAt).toEqual({ year: 2030, month: 9 });
  });

  it('cannot be fired again by re-seeding it from a pending state', () => {
    // The only pending state a caller can obtain is the shared frozen constant, which no earlier
    // tick can turn into a fire: the state travels in the result, so a stale copy of "pending" can
    // never be ahead of the fired state.
    const fired = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, snapshot(6, 2031, 1_100_000)).state;
    expect(PENDING_MILESTONE_LATCH).toEqual({ status: 'pending' });
    expect(fired).not.toBe(PENDING_MILESTONE_LATCH);
    expect(Object.isFrozen(fired)).toBe(true);
  });
});

describe('the empty-group decision reaches the latch', () => {
  it('never fires for a group with no conditions', () => {
    // The reason empty `and` is `false`: with vacuous truth this milestone would fire in month 1
    // and, because the latch has no reset, be permanently "reached" by a plan that says nothing.
    const { results } = tickMonths(PENDING_MILESTONE_LATCH, { op: 'and', children: [] }, 2030, () => 10_000_000);
    expect(results.every((result) => result.outcome === 'stillUnmet')).toBe(true);
  });
});

describe('purity', () => {
  it('is idempotent for a given state and snapshot', () => {
    const at = snapshot(4, 2031, 1_000_000);
    const first = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, at);
    const second = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, at);

    expect(second).toEqual(first);
  });

  it('does not mutate the state or the snapshot it was given', () => {
    const state = tickMilestoneLatch(PENDING_MILESTONE_LATCH, NET_WORTH_GOAL, snapshot(6, 2031, 1_100_000)).state;
    const stateBefore = JSON.parse(JSON.stringify(state));
    const at = snapshot(7, 2031, 1_200_000);
    const snapshotBefore = JSON.parse(JSON.stringify(at));

    tickMilestoneLatch(state, NET_WORTH_GOAL, at);

    expect(JSON.parse(JSON.stringify(state))).toEqual(stateBefore);
    expect(JSON.parse(JSON.stringify(at))).toEqual(snapshotBefore);
  });
});
