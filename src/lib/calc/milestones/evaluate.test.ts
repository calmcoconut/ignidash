import { describe, expect, it } from 'vitest';

import {
  MILESTONE_EQUALITY_TOLERANCE,
  MILESTONE_METRICS,
  MILESTONE_METRIC_UNITS,
  MILESTONE_OPERATORS,
  compareMilestoneValues,
  evaluateMilestone,
  readMilestoneLeafValue,
} from './index';
import type { MilestoneExpression, MilestoneSnapshot } from './index';

/**
 * P1-P7: the milestone evaluator.
 *
 * The truth tables, the empty-group decision (empty `and` and empty `or` are both **false**), every
 * operator at its boundary, and one case per metric.
 */

const snapshot = (overrides: Partial<MilestoneSnapshot> = {}): MilestoneSnapshot => ({
  age: 40,
  year: 2026,
  month: 1,
  portfolio: 500_000,
  income: 120_000,
  expense: 90_000,
  netWorth: 750_000,
  accounts: { brokerage: 250_000, '401k': 400_000 },
  ...overrides,
});

/** A leaf that is met by the default snapshot, and one that is not. */
const TRUE_LEAF: MilestoneExpression = { metric: 'age', operator: '>=', value: 40 };
const FALSE_LEAF: MilestoneExpression = { metric: 'age', operator: '>=', value: 65 };

const and = (...children: MilestoneExpression[]): MilestoneExpression => ({ op: 'and', children });
const or = (...children: MilestoneExpression[]): MilestoneExpression => ({ op: 'or', children });

describe('the metric vocabulary', () => {
  it('is exactly the row`s list', () => {
    expect([...MILESTONE_METRICS]).toEqual(['age', 'year', 'portfolio', 'account', 'income', 'expense', 'netWorth']);
  });

  it('gives every metric a unit and every operator a distinct meaning', () => {
    // The Record makes a missing unit a compile error; this pins the values a form will format with.
    expect(Object.keys(MILESTONE_METRIC_UNITS).sort()).toEqual([...MILESTONE_METRICS].sort());
    expect(MILESTONE_METRIC_UNITS.age).toBe('years');
    expect(MILESTONE_METRIC_UNITS.year).toBe('calendarYear');
    expect(MILESTONE_METRIC_UNITS.portfolio).toBe('currency');
    expect([...MILESTONE_OPERATORS]).toEqual(['<', '<=', '==', '>=', '>']);
  });
});

describe('reading a leaf', () => {
  it('takes each metric from its own reading', () => {
    const s = snapshot();
    expect(readMilestoneLeafValue({ metric: 'age', operator: '>', value: 0 }, s)).toBe(40);
    expect(readMilestoneLeafValue({ metric: 'year', operator: '>', value: 0 }, s)).toBe(2026);
    expect(readMilestoneLeafValue({ metric: 'portfolio', operator: '>', value: 0 }, s)).toBe(500_000);
    expect(readMilestoneLeafValue({ metric: 'income', operator: '>', value: 0 }, s)).toBe(120_000);
    expect(readMilestoneLeafValue({ metric: 'expense', operator: '>', value: 0 }, s)).toBe(90_000);
    expect(readMilestoneLeafValue({ metric: 'netWorth', operator: '>', value: 0 }, s)).toBe(750_000);
  });

  it('reads an account by id, and reads an id it does not know as zero', () => {
    const s = snapshot();
    expect(readMilestoneLeafValue({ metric: 'account', accountId: '401k', operator: '>', value: 0 }, s)).toBe(400_000);
    // A plan whose accounts changed shape still evaluates: an absent id reads as $0, so a
    // "≥ $1" goal fails rather than throwing, and the plan-level superRefine is where a dangling
    // reference is rejected.
    expect(readMilestoneLeafValue({ metric: 'account', accountId: 'closed', operator: '>', value: 0 }, s)).toBe(0);
    expect(evaluateMilestone({ metric: 'account', accountId: 'closed', operator: '>=', value: 1 }, s)).toBe(false);
  });

  it('distinguishes an account balance from the portfolio total', () => {
    const s = snapshot({ accounts: { brokerage: 250_000 } });
    expect(evaluateMilestone({ metric: 'account', accountId: 'brokerage', operator: '>=', value: 250_000 }, s)).toBe(true);
    expect(evaluateMilestone({ metric: 'account', accountId: 'brokerage', operator: '>=', value: 250_001 }, s)).toBe(false);
  });
});

describe('each operator at its boundary', () => {
  const s = snapshot({ portfolio: 500_000 });
  const at = (operator: (typeof MILESTONE_OPERATORS)[number], value: number): boolean =>
    evaluateMilestone({ metric: 'portfolio', operator, value }, s);

  it('`<` is excluded at the threshold', () => {
    expect(at('<', 500_000)).toBe(false);
    expect(at('<', 500_000.01)).toBe(true);
    expect(at('<', 499_999.99)).toBe(false);
  });

  it('`<=` is included at the threshold', () => {
    expect(at('<=', 500_000)).toBe(true);
    expect(at('<=', 499_999.99)).toBe(false);
    expect(at('<=', 500_000.01)).toBe(true);
  });

  it('`>=` is included at the threshold', () => {
    expect(at('>=', 500_000)).toBe(true);
    expect(at('>=', 500_000.01)).toBe(false);
    expect(at('>=', 499_999.99)).toBe(true);
  });

  it('`>` is excluded at the threshold', () => {
    expect(at('>', 500_000)).toBe(false);
    expect(at('>', 499_999.99)).toBe(true);
    expect(at('>', 500_000.01)).toBe(false);
  });

  it('`==` is cents-exact, so a compounding residual cannot miss an exact goal', () => {
    expect(at('==', 500_000)).toBe(true);
    // Within half a cent either side counts: 500000.0000001 is "exactly $500,000".
    expect(at('==', 500_000.0000001)).toBe(true);
    expect(at('==', 499_999.996)).toBe(true);
    // A whole cent away is not.
    expect(at('==', 500_000.01)).toBe(false);
    expect(at('==', 499_999.99)).toBe(false);
    expect(MILESTONE_EQUALITY_TOLERANCE).toBe(0.005);
  });

  it('honours a negative threshold, which an account balance can reach', () => {
    const negative = snapshot({ portfolio: -1_200 });
    expect(evaluateMilestone({ metric: 'portfolio', operator: '<', value: 0 }, negative)).toBe(true);
    expect(evaluateMilestone({ metric: 'portfolio', operator: '<=', value: -1_200 }, negative)).toBe(true);
    expect(evaluateMilestone({ metric: 'portfolio', operator: '>', value: -1_200 }, negative)).toBe(false);
  });

  it('compares a calendar year and an age with the same rules', () => {
    const s2 = snapshot({ age: 64.5, year: 2035 });
    expect(evaluateMilestone({ metric: 'age', operator: '>=', value: 65 }, s2)).toBe(false);
    expect(evaluateMilestone({ metric: 'age', operator: '>=', value: 64.5 }, s2)).toBe(true);
    expect(evaluateMilestone({ metric: 'year', operator: '==', value: 2035 }, s2)).toBe(true);
    expect(evaluateMilestone({ metric: 'year', operator: '>', value: 2035 }, s2)).toBe(false);
  });
});

describe('compareMilestoneValues', () => {
  it('is the same function the evaluator applies', () => {
    expect(compareMilestoneValues(1, '<', 2)).toBe(true);
    expect(compareMilestoneValues(2, '<=', 2)).toBe(true);
    expect(compareMilestoneValues(2, '==', 2)).toBe(true);
    expect(compareMilestoneValues(2, '>=', 2)).toBe(true);
    expect(compareMilestoneValues(3, '>', 2)).toBe(true);
    expect(compareMilestoneValues(2, '>', 2)).toBe(false);
  });
});

describe('the AND truth table', () => {
  it('is met only when every child is met', () => {
    const s = snapshot();
    expect(evaluateMilestone(and(TRUE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(and(FALSE_LEAF), s)).toBe(false);
    expect(evaluateMilestone(and(TRUE_LEAF, TRUE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(and(TRUE_LEAF, FALSE_LEAF), s)).toBe(false);
    expect(evaluateMilestone(and(FALSE_LEAF, TRUE_LEAF), s)).toBe(false);
    expect(evaluateMilestone(and(FALSE_LEAF, FALSE_LEAF), s)).toBe(false);
    expect(evaluateMilestone(and(TRUE_LEAF, TRUE_LEAF, TRUE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(and(TRUE_LEAF, TRUE_LEAF, FALSE_LEAF), s)).toBe(false);
  });

  it('treats one FALSE child as decisive however many TRUE children surround it', () => {
    const s = snapshot();
    expect(evaluateMilestone(and(TRUE_LEAF, TRUE_LEAF, FALSE_LEAF, TRUE_LEAF), s)).toBe(false);
  });
});

describe('the OR truth table', () => {
  it('is met when at least one child is met', () => {
    const s = snapshot();
    expect(evaluateMilestone(or(TRUE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(or(FALSE_LEAF), s)).toBe(false);
    expect(evaluateMilestone(or(TRUE_LEAF, TRUE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(or(TRUE_LEAF, FALSE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(or(FALSE_LEAF, TRUE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(or(FALSE_LEAF, FALSE_LEAF), s)).toBe(false);
    expect(evaluateMilestone(or(FALSE_LEAF, FALSE_LEAF, TRUE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(or(FALSE_LEAF, FALSE_LEAF, FALSE_LEAF), s)).toBe(false);
  });

  it('treats one TRUE child as decisive however many FALSE children surround it', () => {
    const s = snapshot();
    expect(evaluateMilestone(or(FALSE_LEAF, FALSE_LEAF, TRUE_LEAF, FALSE_LEAF), s)).toBe(true);
  });
});

describe('empty children: an empty group is never met', () => {
  it('is false for an empty OR, which is also the Boolean identity', () => {
    expect(evaluateMilestone(or(), snapshot())).toBe(false);
  });

  it('is false for an empty AND, against the Boolean identity, so a half-built condition cannot fire', () => {
    // `[].every()` is `true`. If that leaked through, a brand-new milestone would be "reached" in
    // the plan's first month and — because the latch has no reset — could never be un-reached.
    expect([].every(() => true)).toBe(true); // the trap
    expect(evaluateMilestone(and(), snapshot())).toBe(false);
  });

  it('is false whatever the snapshot says', () => {
    const extreme = snapshot({ age: 0, year: 1900, portfolio: 0, netWorth: 0, income: 0, expense: 0, accounts: {} });
    expect(evaluateMilestone(and(), extreme)).toBe(false);
    expect(evaluateMilestone(or(), extreme)).toBe(false);
  });

  it('is inert inside a parent OR', () => {
    const s = snapshot();
    // The empty group contributes false, so the parent is decided by its real children.
    expect(evaluateMilestone(or(TRUE_LEAF, and()), s)).toBe(true);
    expect(evaluateMilestone(or(FALSE_LEAF, or()), s)).toBe(false);
  });

  it('makes a parent AND unreachable, which is visible rather than silently firing', () => {
    const s = snapshot();
    expect(evaluateMilestone(and(TRUE_LEAF, or()), s)).toBe(false);
    expect(evaluateMilestone(and(TRUE_LEAF, and()), s)).toBe(false);
  });

  it('propagates through nesting', () => {
    const s = snapshot();
    // or(and(), TRUE) → true; or(and(TRUE, or()), FALSE) → false; and(or(TRUE), or()) → false.
    expect(evaluateMilestone(or(and(), TRUE_LEAF), s)).toBe(true);
    expect(evaluateMilestone(or(and(TRUE_LEAF, or()), FALSE_LEAF), s)).toBe(false);
    expect(evaluateMilestone(and(or(TRUE_LEAF), or()), s)).toBe(false);
    expect(evaluateMilestone(and(or(TRUE_LEAF, FALSE_LEAF), TRUE_LEAF), s)).toBe(true);
  });
});

describe('nesting', () => {
  it('evaluates a realistic two-level plan condition', () => {
    const s = snapshot({ age: 59, year: 2031, netWorth: 2_400_000, accounts: { brokerage: 610_000 } });
    // "net worth ≥ $2M, and either 60+ or retired with $600k liquid".
    const expression: MilestoneExpression = and(
      { metric: 'netWorth', operator: '>=', value: 2_000_000 },
      or({ metric: 'age', operator: '>=', value: 60 }, { metric: 'account', accountId: 'brokerage', operator: '>=', value: 600_000 })
    );
    expect(evaluateMilestone(expression, s)).toBe(true);

    // The same expression one year earlier and without the liquid balance: neither OR branch holds.
    const earlier = snapshot({ age: 58, year: 2030, netWorth: 2_400_000, accounts: { brokerage: 590_000 } });
    expect(evaluateMilestone(expression, earlier)).toBe(false);

    // The OR holds but the AND's first child does not.
    const poorer = snapshot({ age: 61, year: 2033, netWorth: 1_900_000, accounts: { brokerage: 610_000 } });
    expect(evaluateMilestone(expression, poorer)).toBe(false);
  });
});

describe('purity', () => {
  it('is the same answer twice and mutates neither argument', () => {
    const expression: MilestoneExpression = and({ metric: 'portfolio', operator: '>=', value: 500_000 }, or());
    const s = snapshot();
    const expressionBefore = JSON.parse(JSON.stringify(expression));
    const snapshotBefore = JSON.parse(JSON.stringify(s));

    const first = evaluateMilestone(expression, s);
    const second = evaluateMilestone(expression, s);

    expect(first).toBe(second);
    expect(JSON.parse(JSON.stringify(expression))).toEqual(expressionBefore);
    expect(JSON.parse(JSON.stringify(s))).toEqual(snapshotBefore);
  });
});
