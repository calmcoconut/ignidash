/**
 * The milestone latch wired into the engine (parity plan P1-P7).
 *
 * The core's own tests (`src/lib/calc/milestones/*.test.ts`) pin the evaluator, the graph and the
 * state machine in isolation. This file pins the *wiring*: that the engine evaluates on the month
 * start, that the latch state is carried from month to month, that two milestones can fire in the
 * same month, and — the frozen decision — that a plan with no milestones produces exactly the result
 * it produced before this field existed.
 *
 * Every expectation is hand-worked from `TEST_CLOCK` (`2026-10-01`) rather than read back from the
 * engine, so a change of placement has to disagree with the arithmetic below.
 */

import { describe, expect, it } from 'vitest';

import type { MilestoneInputs } from '@/lib/schemas/inputs/milestone-form-schema';
import { simulatorSchema } from '@/lib/schemas/inputs/simulator-schema';
import { SimulationDataExtractor } from '@/lib/calc/data-extractors/simulation-data-extractor';

import { FinancialSimulationEngine, type SimulationResult } from '../simulation-engine';
import { FixedReturnsProvider } from '../returns-providers/fixed-returns-provider';
import { evaluateMilestone } from '../milestones';
import { createSimulatorInputs, createSavingsAccount, TEST_CLOCK } from './test-utils';

/** A milestone over one comparison, with the id derived from its name. */
function milestone(name: string, condition: MilestoneInputs['condition'], references: string[] = []): MilestoneInputs {
  return { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, condition, references };
}

/**
 * Runs one plan on the shared test clock.
 *
 * The clock is `2026-10-01`, so the engine's first month-start tick is **November 2026** and the
 * n-th tick (`month` elapsed) falls in the calendar month `2026-10 + n` — which is what every
 * expected fire date below is derived from.
 */
function run(milestones: MilestoneInputs[] | undefined, overrides: Parameters<typeof createSimulatorInputs>[0] = {}): SimulationResult {
  // `createSimulatorInputs` lists its fields one by one, so the milestones are attached here — and
  // attached only when the caller states them, because "absent" is the case under test.
  const base = createSimulatorInputs(overrides);
  const inputs = simulatorSchema.parse(milestones === undefined ? base : { ...base, milestones });
  const engine = new FinancialSimulationEngine(inputs, TEST_CLOCK);

  return engine.runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);
}

/** A plan with one savings account and no flows, so the month-start portfolio value is knowable. */
const SAVINGS_ONLY = { accounts: { savings: createSavingsAccount({ id: 'savings', balance: 1000 }) } };

const firedAt = (result: SimulationResult, id: string) => result.milestones?.find((entry) => entry.id === id)?.firedAt;

describe('a plan with no milestones is untouched', () => {
  it('adds no `milestones` key at all, so the result object is the pre-P1-P7 one', () => {
    const withoutField = run(undefined);
    const withEmptyList = run([]);

    expect(withoutField).not.toHaveProperty('milestones');
    expect(withEmptyList).not.toHaveProperty('milestones');
    // Both spellings of "no milestones" are the same run, byte for byte.
    expect(JSON.stringify(withEmptyList)).toBe(JSON.stringify(withoutField));
  });

  it('moves not one data point when a milestone is added to a plan that would fire it', () => {
    const plan = run(undefined, SAVINGS_ONLY);
    const withMilestone = run([milestone('Thousand', { metric: 'netWorth', operator: '>=', value: 1000 })], SAVINGS_ONLY);

    // The milestone is a reading of the run, never an input to it: the same data points, the same
    // context, plus one report.
    expect(withMilestone.data).toStrictEqual(plan.data);
    expect(withMilestone.context).toStrictEqual(plan.context);
    expect(withMilestone.milestones).toHaveLength(1);
  });
});

describe('the month-start tick', () => {
  it('fires a calendar-year milestone in that year`s January start', () => {
    const result = run([milestone('Next year', { metric: 'year', operator: '>=', value: 2027 })]);

    // Ticks: Nov 2026 (1), Dec 2026 (2), Jan 2027 (3). The first one that satisfies "year ≥ 2027"
    // is January 2027's start — an end-of-month tick would have stamped December 2026 instead.
    expect(firedAt(result, 'next-year')).toStrictEqual({ year: 2027, month: 1 });
  });

  it('fires in the run`s first month, not before it', () => {
    const result = run([milestone('This year', { metric: 'year', operator: '>=', value: 2026 })]);

    // The clock is 2026-10-01, so a tick placed before the clock advanced — or one evaluated on the
    // plan's start date — would stamp October (or the as-of month). The first month-start is November.
    expect(firedAt(result, 'this-year')).toStrictEqual({ year: 2026, month: 11 });
  });

  it('reads the month-start portfolio, so a threshold is crossed on the right month', () => {
    // $1,000 at the first month start, growing from the first month's return afterwards (cash's
    // nominal 10% against 3% inflation is a real gain, so the second tick already reads above the
    // opening balance). The initial data point is the same 1,000, which is what makes the reading
    // verifiable: the snapshot's net worth and the net-worth chart's agree there.
    const result = run(
      [
        milestone('At least a thousand', { metric: 'netWorth', operator: '>=', value: 1000 }),
        milestone('More than a thousand', { metric: 'netWorth', operator: '>', value: 1000 }),
      ],
      {
        ...SAVINGS_ONLY,
        marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 10, inflationRate: 3 },
      }
    );

    expect(firedAt(result, 'at-least-a-thousand')).toStrictEqual({ year: 2026, month: 11 });
    expect(firedAt(result, 'more-than-a-thousand')).toStrictEqual({ year: 2026, month: 12 });

    // The snapshot's net-worth definition is the net-worth chart's: at the initial data point (no
    // physical assets, no debts) both read the same balance.
    expect(SimulationDataExtractor.getAssetsAndLiabilitiesData(result.data[0]).netWorth).toBe(1000);
  });

  it('takes income and expense from the last settled period, so a flow milestone answers after settlement', () => {
    const result = run(
      [
        milestone('Earned something', { metric: 'income', operator: '>=', value: 1 }),
        milestone('Spent something', { metric: 'expense', operator: '>=', value: 1 }),
      ],
      {
        ...SAVINGS_ONLY,
        incomes: {
          salary: {
            id: 'salary',
            name: 'Salary',
            amount: 120000,
            frequency: 'yearly',
            timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
            taxes: { incomeType: 'wage', withholding: 22 },
          },
        },
        expenses: {
          living: {
            id: 'living',
            name: 'Living',
            amount: 1000,
            frequency: 'yearly',
            timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
          },
        },
      }
    );

    // The initial data point carries no flows (`incomes`/`expenses` are `null` there), so the first
    // twelve ticks read 0. The thirteenth tick — November 2027 — is the first one after the first
    // settlement, and it reads that period's totals. This is the documented granularity: the engine
    // settles income and expenses annually, so a milestone over them is answered at a period
    // boundary rather than monthly.
    expect(firedAt(result, 'earned-something')).toStrictEqual({ year: 2027, month: 11 });
    expect(firedAt(result, 'spent-something')).toStrictEqual({ year: 2027, month: 11 });
  });
});

describe('the latch', () => {
  it('keeps a milestone met after the condition stops holding', () => {
    // True only inside calendar 2027, so the condition is false for the rest of the run. A
    // re-evaluated (un-latched) milestone would report the final month's answer, which is "not met".
    const result = run([
      milestone('During 2027', {
        op: 'and',
        children: [
          { metric: 'year', operator: '>=', value: 2027 },
          { metric: 'year', operator: '<', value: 2028 },
        ],
      }),
    ]);

    expect(firedAt(result, 'during-2027')).toStrictEqual({ year: 2027, month: 1 });
  });

  it('reports the first month it held, never a later month that also held', () => {
    // Still true at the end of the run, so a per-month re-seed of the latch would report 2077.
    const result = run([milestone('Any year', { metric: 'year', operator: '>=', value: 2026 })]);

    expect(firedAt(result, 'any-year')).toStrictEqual({ year: 2026, month: 11 });
  });

  it('fires two milestones in the same month, both at that month`s start', () => {
    const result = run([
      milestone('First', { metric: 'year', operator: '==', value: 2030 }),
      milestone('Second', { metric: 'age', operator: '>=', value: 36.75 + 39 / 12 }),
      milestone('Third', { metric: 'year', operator: '==', value: 2030 }, []),
    ]);

    // Age 36.75 at the clock date; 39/12 = 3.25 years later is January 2030, tick 40.
    expect(firedAt(result, 'first')).toStrictEqual({ year: 2030, month: 1 });
    expect(firedAt(result, 'second')).toStrictEqual({ year: 2030, month: 1 });
    expect(firedAt(result, 'third')).toStrictEqual({ year: 2030, month: 1 });
  });

  it('reports null for a milestone the horizon never reaches', () => {
    const result = run([milestone('Never', { metric: 'netWorth', operator: '>', value: 1_000_000_000 })]);

    expect(firedAt(result, 'never')).toBeNull();
  });

  it('reports every milestone in the plan`s own order', () => {
    const result = run([
      milestone('Zeta', { metric: 'year', operator: '>=', value: 2026 }),
      milestone('Alpha', { metric: 'year', operator: '>=', value: 2026 }),
    ]);

    expect(result.milestones?.map((entry) => entry.name)).toEqual(['Zeta', 'Alpha']);
  });
});

describe('an empty or half-built group never fires', () => {
  it('is not met, against `[].every()`, which is the trap', () => {
    // The naive implementation: an empty `and` is vacuously true, so a milestone the user has not
    // finished writing "fires" in month one — and, because the latch has no reset, stays reached for
    // the whole run. `[].every()` really is `true`; the evaluator refuses to inherit it.
    expect([].every(() => true)).toBe(true);

    const emptyGroup = { op: 'and', children: [] } as const;
    expect(
      evaluateMilestone(emptyGroup, { age: 40, year: 2030, month: 1, portfolio: 1, income: 1, expense: 1, netWorth: 1, accounts: {} })
    ).toBe(false);

    const result = run([milestone('Half built', emptyGroup)]);
    expect(firedAt(result, 'half-built')).toBeNull();
    // Not "fired in month one and stayed": the report has no date at all.
    expect(result.milestones).toStrictEqual([{ id: 'half-built', name: 'Half built', firedAt: null }]);
  });

  it('is not met for an empty `or` either, and does not make a parent `and` fire', () => {
    const result = run([
      milestone('Empty or', { op: 'or', children: [] }),
      milestone('Parent and', {
        op: 'and',
        children: [
          { metric: 'year', operator: '>=', value: 2000 },
          { op: 'or', children: [] },
        ],
      }),
    ]);

    expect(firedAt(result, 'empty-or')).toBeNull();
    expect(firedAt(result, 'parent-and')).toBeNull();
  });
});

describe('a reference never gates an evaluation', () => {
  it('evaluates both milestones from the same month-start reading, in plan order', () => {
    // "Sell the rental" depends on "Pay off the mortgage", yet both are ticked in the same month:
    // the reference is identity (what cycle detection walks), not an ordering constraint.
    const result = run([
      milestone('Sell the rental', { metric: 'year', operator: '==', value: 2029 }, ['pay-off-the-mortgage']),
      milestone('Pay off the mortgage', { metric: 'year', operator: '==', value: 2029 }),
    ]);

    expect(firedAt(result, 'sell-the-rental')).toStrictEqual({ year: 2029, month: 1 });
    expect(firedAt(result, 'pay-off-the-mortgage')).toStrictEqual({ year: 2029, month: 1 });
  });
});
