import { describe, expect, it } from 'vitest';

import { SINGLE_MEMBER_HOUSEHOLD, type Household } from '@/lib/schemas/inputs/household-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { deriveFilingStatus, FinancialSimulationEngine, type SimulationResult } from './simulation-engine';
import {
  TEST_CLOCK,
  create401kAccount,
  createDefaultTimeline,
  createLivingExpense,
  createSimulatorInputs,
  createWageIncome,
} from './__tests__/test-utils';

/**
 * Household behaviour (parity plan P1-P3, pieces 3 and 4).
 *
 * | piece | rule | how it is proved here |
 * | --- | --- | --- |
 * | 3 | a couple's joint phase starts when the **last** earner retires | two wage incomes with staggered end bounds; the phase flips at the later one, and a single-member plan with the same income still flips at its retirement age |
 * | 4 | filing status is derived from the household | one member keeps the stored status; two members settle as `marriedFilingJointly` whatever the stored field says |
 *
 * Pieces 1 (per-owner RMD age) and 2 (horizon = longest life expectancy) are **not** here: both
 * need a per-member birth year and life expectancy, and `household.members` carries neither
 * (`{ id, role }` only). That input is a schema/validator/UI change, so it is a separate item.
 *
 * Every fixture is a plan the schema accepts: no shape here is one only the test understands.
 */

const TWO_MEMBER_HOUSEHOLD: Household = {
  members: [
    { id: 'primary', role: 'primary' },
    { id: 'partner', role: 'partner' },
  ],
};

/** A household of the given members on the plan's default timeline. */
const timelineWith = (household: Household | undefined) => ({ ...createDefaultTimeline(), household });

type IncomeTimeframeEnd = SimulatorInputs['incomes'][string]['timeframe']['end'];

/** A wage income for one member, ending either at retirement or at an age of its own. */
const wageIncome = (overrides: { id: string; owner?: 'primary' | 'partner'; end?: IncomeTimeframeEnd }) => ({
  ...createWageIncome({ id: overrides.id, amount: 90000 }),
  ...(overrides.owner === undefined ? {} : { owner: overrides.owner }),
  timeframe: { start: { type: 'now' as const }, end: overrides.end ?? { type: 'atRetirement' as const } },
});

/**
 * A plan with a single wage earner, room to save and a long horizon. The 401(k) is what makes the
 * filing status observable: a joint return taxes the same wage and withdrawals differently.
 */
function basePlan(overrides: Partial<SimulatorInputs> = {}): SimulatorInputs {
  return createSimulatorInputs({
    timeline: createDefaultTimeline(),
    incomes: { salary: wageIncome({ id: 'salary' }) },
    expenses: {
      living: createLivingExpense({
        id: 'living',
        amount: 45000,
        timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
      }),
    },
    accounts: { retirement: create401kAccount({ balance: 500000 }) },
    ...overrides,
  });
}

const run = (inputs: SimulatorInputs): SimulationResult =>
  new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);

/** The age at which the run first reports the retirement phase, or `undefined` if it never does. */
const retirementAge = (result: SimulationResult): number | undefined =>
  result.data.find((point) => point.phase?.name === 'retirement')?.age;

// ============================================================================
// Piece 3 — the joint phase starts when the last earner retires
// ============================================================================

describe('a couple retires when the last earner retires', () => {
  const singleMemberPlan = basePlan();

  it('flips at the plan retirement age when both wages end at retirement', () => {
    // Regression guard for the circular case: an income ending `atRetirement` stops *because* the
    // phase flips, so counting it as "still working" would hold the phase in accumulation forever.
    const couple = basePlan({
      timeline: timelineWith(TWO_MEMBER_HOUSEHOLD),
      incomes: {
        primarySalary: wageIncome({ id: 'primarySalary', owner: 'primary' }),
        partnerSalary: wageIncome({ id: 'partnerSalary', owner: 'partner' }),
      },
    });

    expect(retirementAge(run(couple))).toBe(retirementAge(run(singleMemberPlan)));
  });

  it('waits for a partner who keeps working past the plan retirement age', () => {
    const partnered = basePlan({
      timeline: timelineWith(TWO_MEMBER_HOUSEHOLD),
      incomes: {
        primarySalary: wageIncome({ id: 'primarySalary', owner: 'primary' }),
        partnerSalary: wageIncome({ id: 'partnerSalary', owner: 'partner', end: { type: 'customAge', age: 68 } }),
      },
    });

    const singleFlip = retirementAge(run(singleMemberPlan))!;
    const coupleFlip = retirementAge(run(partnered))!;

    // The later retirement wins, and the gap is the three years the partner keeps earning.
    expect(coupleFlip).toBeGreaterThan(singleFlip);
    expect(coupleFlip - singleFlip).toBeCloseTo(3, 10);
  });

  it('reports accumulation for the whole stretch in which one member is still paid', () => {
    const partnered = basePlan({
      timeline: timelineWith(TWO_MEMBER_HOUSEHOLD),
      incomes: {
        primarySalary: wageIncome({ id: 'primarySalary', owner: 'primary' }),
        partnerSalary: wageIncome({ id: 'partnerSalary', owner: 'partner', end: { type: 'customAge', age: 68 } }),
      },
    });

    const result = run(partnered);
    const singleFlip = retirementAge(run(singleMemberPlan))!;
    const coupleFlip = retirementAge(result)!;

    // One year after the first earner's retirement: still accumulation, because the partner earns.
    const yearAfterFirstRetirement = result.data.find((point) => point.age >= singleFlip + 1)!;
    expect(yearAfterFirstRetirement.phase).toEqual({ name: 'accumulation' });

    // ...and every year between the first retirement and the flip is accumulation, never a gap.
    const between = result.data.filter((point) => point.age >= singleFlip && point.age < coupleFlip);
    expect(between.length).toBeGreaterThan(0);
    for (const point of between) expect(point.phase).toEqual({ name: 'accumulation' });
  });

  it('does not delay retirement for a partner who stopped earning first', () => {
    const partnered = basePlan({
      timeline: timelineWith(TWO_MEMBER_HOUSEHOLD),
      incomes: {
        primarySalary: wageIncome({ id: 'primarySalary', owner: 'primary' }),
        partnerSalary: wageIncome({ id: 'partnerSalary', owner: 'partner', end: { type: 'customAge', age: 60 } }),
      },
    });

    expect(retirementAge(run(partnered))).toBe(retirementAge(run(singleMemberPlan)));
  });

  it('leaves a single member on the retirement strategy alone, whatever the wage income does', () => {
    // The very income that staggers a couple must not move a one-person plan: the gate is not
    // consulted at all for a household of one.
    const lateEarner = basePlan({
      incomes: { salary: wageIncome({ id: 'salary', end: { type: 'customAge', age: 68 } }) },
    });

    expect(retirementAge(run(lateEarner))).toBe(retirementAge(run(singleMemberPlan)));
  });
});

// ============================================================================
// Piece 4 — the filing status is derived from the household
// ============================================================================

describe('deriveFilingStatus', () => {
  it('keeps the stored status for one member, including head of household', () => {
    expect(deriveFilingStatus(undefined, 'single')).toBe('single');
    expect(deriveFilingStatus(undefined, 'headOfHousehold')).toBe('headOfHousehold');
    expect(deriveFilingStatus(SINGLE_MEMBER_HOUSEHOLD, 'single')).toBe('single');
    expect(deriveFilingStatus(SINGLE_MEMBER_HOUSEHOLD, 'headOfHousehold')).toBe('headOfHousehold');
  });

  it('settles a couple jointly, whatever the stored field says', () => {
    // Married filing separately lands with P3-P1b; today a couple's only status is joint.
    expect(deriveFilingStatus(TWO_MEMBER_HOUSEHOLD, 'single')).toBe('marriedFilingJointly');
    expect(deriveFilingStatus(TWO_MEMBER_HOUSEHOLD, 'headOfHousehold')).toBe('marriedFilingJointly');
    expect(deriveFilingStatus(TWO_MEMBER_HOUSEHOLD, 'marriedFilingJointly')).toBe('marriedFilingJointly');
  });
});

describe('a run settles under the status its household derives', () => {
  const asCoupleStoredAs = (stored: 'single' | 'marriedFilingJointly') =>
    basePlan({
      timeline: timelineWith(TWO_MEMBER_HOUSEHOLD),
      taxSettings: { filingStatus: stored },
    });

  it('ignores a stored single status on a two-member plan', () => {
    // A two-member plan that still says `single` was written before the household existed;
    // filing it as one person would be the wrong answer, so the derived status wins.
    expect(run(asCoupleStoredAs('single'))).toStrictEqual(run(asCoupleStoredAs('marriedFilingJointly')));
  });

  it('taxes a couple jointly rather than as one person', () => {
    const couple = run(asCoupleStoredAs('single'));
    const single = run(basePlan({ taxSettings: { filingStatus: 'single' } }));

    expect(couple.data.at(-1)!.taxes).not.toStrictEqual(single.data.at(-1)!.taxes);
  });

  it('keeps a one-member plan filing exactly as it was stored', () => {
    const storedHeadOfHousehold = basePlan({ taxSettings: { filingStatus: 'headOfHousehold' } });
    const withHouseholdOfOne = basePlan({
      timeline: timelineWith(SINGLE_MEMBER_HOUSEHOLD),
      taxSettings: { filingStatus: 'headOfHousehold' },
    });

    // Piece 4 must not quietly file a one-member plan as single.
    expect(run(withHouseholdOfOne)).toStrictEqual(run(storedHeadOfHousehold));
  });
});

// ============================================================================
// Single-member identity — the property the golden corpus depends on
// ============================================================================

describe('a household of one is byte-identical to no household at all', () => {
  it('leaves every result unchanged on a default single-member plan', () => {
    const withHousehold = basePlan({ timeline: timelineWith(SINGLE_MEMBER_HOUSEHOLD) });

    expect(run(withHousehold)).toStrictEqual(run(basePlan()));
  });

  it('leaves every result unchanged when the single member has a partner-style income', () => {
    const incomes = { salary: wageIncome({ id: 'salary', end: { type: 'customAge', age: 68 } }) };
    const withHousehold = basePlan({ timeline: timelineWith(SINGLE_MEMBER_HOUSEHOLD), incomes });

    expect(run(withHousehold)).toStrictEqual(run(basePlan({ incomes })));
  });
});
