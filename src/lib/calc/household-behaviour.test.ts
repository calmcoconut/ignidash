import { describe, expect, it } from 'vitest';

import { SINGLE_MEMBER_HOUSEHOLD, type Household } from '@/lib/schemas/inputs/household-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import {
  basisStepUpFraction,
  deriveFilingStatus,
  FinancialSimulationEngine,
  survivorFilingStatus,
  type SimulationResult,
} from './simulation-engine';
import {
  TEST_CLOCK,
  create401kAccount,
  createDefaultTimeline,
  createLivingExpense,
  createSavingsAccount,
  createSimulatorInputs,
  createWageIncome,
} from './__tests__/test-utils';

/**
 * Household behaviour (parity plan P1-P3, pieces 1-4).
 *
 * | piece | rule | how it is proved here |
 * | --- | --- | --- |
 * | 1 | per-owner RMD age | two members born either side of 1960 whose accounts start RMDs at their own ages |
 * | 2 | horizon = the longest life expectancy | the run ends at the later death, and a single member's end age is exactly the plan's |
 * | 3 | a couple's joint phase starts when the **last** earner retires | two wage incomes with staggered end bounds; the phase flips at the later one, and a single-member plan with the same income still flips at its retirement age |
 * | 4 | derived filing status, and the survivor transition | one member keeps the stored status, two settle jointly; after the first death the survivor files single, the deceased's incomes stop, and cost basis steps up (community in full, separate half) |
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

interface MemberAges {
  birthMonth?: number;
  birthYear?: number;
  lifeExpectancy?: number;
}

/** A two-member household, with only the ages each member actually stores. */
const householdWith = (primaryAges: MemberAges = {}, partnerAges: MemberAges = {}): Household => ({
  members: [
    { id: 'primary', role: 'primary', ...primaryAges },
    { id: 'partner', role: 'partner', ...partnerAges },
  ],
});

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

// ============================================================================
// Member ages, and the fallback that keeps an age-less household working
// ============================================================================

describe('member ages fall back to the plan', () => {
  it('reads a partner with no ages exactly as a partner holding the plan`s own', () => {
    // The plan-level fields are the primary's, so an age-less partner resolves to the same values.
    // The two runs must agree to the last cent: same ages, same expectancies, same everything.
    const implicit = basePlan({ timeline: { ...createDefaultTimeline(), household: householdWith() } });
    const explicit = basePlan({
      timeline: {
        ...createDefaultTimeline(),
        household: householdWith(
          {},
          {
            birthMonth: createDefaultTimeline().birthMonth,
            birthYear: createDefaultTimeline().birthYear,
            lifeExpectancy: createDefaultTimeline().lifeExpectancy,
          }
        ),
      },
    });

    expect(run(implicit)).toStrictEqual(run(explicit));
  });

  it('does not invent a member age where the file has none', () => {
    const plan = basePlan({ timeline: { ...createDefaultTimeline(), household: householdsMembersWithoutAges() } });

    expect(plan.timeline?.household?.members.map((member) => Object.keys(member).sort())).toStrictEqual([
      ['id', 'role'],
      ['id', 'role'],
    ]);
  });
});

function householdsMembersWithoutAges(): Household {
  return { members: householdWith().members.map((member) => ({ id: member.id, role: member.role })) };
}

// ============================================================================
// Piece 1 — per-owner RMD ages
// ============================================================================

/** The first data point of the run that shows an RMD taken from `accountId`. */
const firstRmdAge = (result: SimulationResult, accountId: string): number | undefined =>
  result.data.find((point) => (point.portfolio.perAccountData[accountId]?.rmds ?? 0) > 0)?.age;

describe('each member reaches RMD age on their own birth year', () => {
  /**
   * A couple ten years apart: the plan is the primary's (born 1955, RMD at 73), and the partner was
   * born in 1965 (RMD at 75, i.e. plan-axis age 85). Both live to plan-axis 98, so no survivor
   * transition interferes with what is being measured here.
   */
  const rmdPlan = () =>
    basePlan({
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1955,
        lifeExpectancy: 98,
        household: householdWith({}, { birthMonth: 1, birthYear: 1965, lifeExpectancy: 88 }),
      },
      incomes: {},
      accounts: {
        primaryIra: { id: 'primaryIra', name: 'Primary IRA', type: 'ira', balance: 200000, percentBonds: 30, owner: 'primary' },
        partnerIra: { id: 'partnerIra', name: 'Partner IRA', type: 'ira', balance: 200000, percentBonds: 30, owner: 'partner' },
        savings: createSavingsAccount({ balance: 150000 }),
      },
      expenses: {
        living: createLivingExpense({
          id: 'living',
          amount: 30000,
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
        }),
      },
    });

  it('starts each member`s RMDs at that member`s own table age', () => {
    const result = run(rmdPlan());

    const primaryRmdAge = firstRmdAge(result, 'primaryIra')!;
    const partnerRmdAge = firstRmdAge(result, 'partnerIra')!;

    // Born 1955 → the first RMD year is the one that ends inside 73..75.
    expect(primaryRmdAge).toBeGreaterThanOrEqual(73);
    expect(primaryRmdAge).toBeLessThan(75);
    // Born 1965 and ten years younger → the same table age, ten years later on the plan axis.
    expect(partnerRmdAge).toBeGreaterThanOrEqual(85);
    expect(partnerRmdAge).toBeLessThan(87);
    expect(partnerRmdAge - primaryRmdAge).toBeCloseTo(12, 0);

    // The plan reports the first RMD of the household, not the primary`s.
    expect(result.context.rmdAge).toBe(73);
  });

  it('leaves a single member on the plan-level RMD age', () => {
    const result = run(basePlan({ timeline: { ...createDefaultTimeline(), birthYear: 1955 } }));

    expect(result.context.rmdAge).toBe(73);
  });
});

// ============================================================================
// Piece 2 — the horizon follows the longest life expectancy
// ============================================================================

describe('the run lasts until the longest-lived member dies', () => {
  const coupleHorizon = (primaryLifeExpectancy: number, partnerLifeExpectancy: number) =>
    basePlan({
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1955,
        lifeExpectancy: primaryLifeExpectancy,
        household: householdWith({}, { birthMonth: 1, birthYear: 1965, lifeExpectancy: partnerLifeExpectancy }),
      },
    });

  it('ends at the later death, whichever member it belongs to', () => {
    // The primary dies at 80 on the plan axis; the partner, ten years younger, dies at 10 + 90 = 100.
    expect(run(coupleHorizon(80, 90)).context.endAge).toBe(100);
    // The other way round: the partner dies at 10 + 80 = 90, the primary at 95.
    expect(run(coupleHorizon(95, 80)).context.endAge).toBe(95);
  });

  it('collapses to exactly the plan value for one member', () => {
    const single = run(basePlan());

    expect(single.context.endAge).toBe(createDefaultTimeline().lifeExpectancy);
    expect(single.context.yearsToSimulate).toBe(Math.ceil(single.context.endAge - single.context.startAge));
  });
});

// ============================================================================
// Piece 4 — the survivor transition at the first death
// ============================================================================

describe('the survivor transition', () => {
  /** No returns at all, so an unrealized-gain fraction can only move when the basis is stepped up. */
  const zeroReturns = { stockReturn: 0, stockYield: 0, bondReturn: 0, bondYield: 0, cashReturn: 0, inflationRate: 0 };

  /**
   * The primary (born 1955) and the partner (born 1965, ten years younger). With `survivor: true`
   * the primary dies at plan-axis 75 and the partner at 82; with `survivor: false` both die at 82,
   * so nothing about the household changes mid-run and that run is the control.
   *
   * One brokerage account per run, because the ordered withdrawal strategy drains taxable accounts
   * in sequence: a fixture with three of them would measure only the first.
   */
  const householdPlan = (survivor: boolean, brokerage: SimulatorInputs['accounts'][string]) =>
    basePlan({
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1955,
        lifeExpectancy: survivor ? 75 : 82,
        household: householdWith({}, { birthMonth: 1, birthYear: 1965, lifeExpectancy: 72 }),
      },
      incomes: {
        primarySalary: wageIncome({ id: 'primarySalary', owner: 'primary', end: { type: 'atLifeExpectancy' } }),
        partnerSalary: wageIncome({ id: 'partnerSalary', owner: 'partner', end: { type: 'atLifeExpectancy' } }),
      },
      accounts: { brokerage },
      expenses: {
        living: createLivingExpense({
          id: 'living',
          amount: 250000,
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
        }),
      },
      marketAssumptions: zeroReturns,
    });

  /** A brokerage account holding a fixed unrealized gain the step-up can rewrite. */
  const BROKERAGE = {
    community: {
      id: 'brokerage',
      name: 'Joint Brokerage',
      type: 'taxableBrokerage' as const,
      balance: 2_000_000,
      percentBonds: 0,
      costBasis: 1_000_000,
      owner: 'joint' as const,
      propertyRegime: 'community' as const,
    },
    deceasedSeparate: {
      id: 'brokerage',
      name: 'Primary Brokerage',
      type: 'taxableBrokerage' as const,
      balance: 2_000_000,
      percentBonds: 0,
      costBasis: 1_000_000,
      owner: 'primary' as const,
    },
    survivorSeparate: {
      id: 'brokerage',
      name: 'Partner Brokerage',
      type: 'taxableBrokerage' as const,
      balance: 2_000_000,
      percentBonds: 0,
      costBasis: 1_200_000,
      owner: 'partner' as const,
    },
  };

  /** Realized gains as a share of what was withdrawn from an account, between two ages. */
  const gainFraction = (result: SimulationResult, accountId: string, fromAge: number, toAge = Number.POSITIVE_INFINITY): number => {
    let gains = 0;
    let withdrawn = 0;

    for (const point of result.data) {
      if (point.age < fromAge || point.age > toAge) continue;
      const account = point.portfolio.perAccountData[accountId];
      if (account === undefined) continue;

      gains += account.realizedGains;
      withdrawn += account.withdrawals.stocks + account.withdrawals.bonds + account.withdrawals.cash;
    }

    return withdrawn === 0 ? Number.NaN : gains / withdrawn;
  };

  it('steps up community property in full, the deceased`s separate property by half, and nothing else', () => {
    // Each account holds the same unrealized gain (a basis well below its balance), so the share of
    // every withdrawal that is a realized gain is fixed unless the basis itself moves.
    const expected = {
      community: { before: 0.5, after: 0 },
      deceasedSeparate: { before: 0.5, after: 0.25 },
      survivorSeparate: { before: 0.4, after: 0.4 },
    } as const;

    for (const kind of ['community', 'deceasedSeparate', 'survivorSeparate'] as const) {
      const survivor = run(householdPlan(true, BROKERAGE[kind]));
      const control = run(householdPlan(false, BROKERAGE[kind]));

      // Non-vacuous: the control (nobody dies first) never moves, before or after age 78.
      expect(gainFraction(control, 'brokerage', 71.75, 75)).toBeCloseTo(expected[kind].before, 10);
      expect(gainFraction(control, 'brokerage', 78)).toBeCloseTo(expected[kind].before, 10);

      // The survivor run is unchanged up to the death, then the step-up shows in the fraction.
      expect(gainFraction(survivor, 'brokerage', 71.75, 75)).toBeCloseTo(expected[kind].before, 10);
      expect(gainFraction(survivor, 'brokerage', 78)).toBeCloseTo(expected[kind].after, 10);
    }
  });

  it('stops the deceased`s income streams and keeps the survivor`s', () => {
    const survivor = run(householdPlan(true, BROKERAGE.community));
    const control = run(householdPlan(false, BROKERAGE.community));

    const at = (result: SimulationResult, age: number) => result.data.find((point) => point.age >= age)!;

    // Before the death both members are paid...
    expect(Object.keys(at(survivor, 74).incomes!.perIncomeData).sort()).toStrictEqual(['partnerSalary', 'primarySalary']);
    // ...after it only the survivor is, while the control (nobody died) still pays both.
    expect(Object.keys(at(survivor, 78).incomes!.perIncomeData)).toStrictEqual(['partnerSalary']);
    expect(Object.keys(at(control, 78).incomes!.perIncomeData).sort()).toStrictEqual(['partnerSalary', 'primarySalary']);
  });

  it('files the year of the death jointly and the survivor`s years as single', () => {
    const survivor = run(householdPlan(true, BROKERAGE.community));
    const control = run(householdPlan(false, BROKERAGE.community));

    const standardDeduction = (result: SimulationResult, age: number) =>
      result.data.find((point) => point.age >= age)!.taxes!.deductions.standardDeduction;

    // Same ages, same start date, so both runs settle those years under the same ruleset. The only
    // difference is the status: joint (the control, and the survivor before the death) versus the
    // single filer the survivor becomes. Single is roughly half of joint, not equal to it.
    const survivorDeduction = standardDeduction(survivor, 78);
    const jointDeduction = standardDeduction(control, 78);

    expect(survivorDeduction).toBeGreaterThan(jointDeduction * 0.4);
    expect(survivorDeduction).toBeLessThan(jointDeduction * 0.6);

    // Before the death the same plan files jointly, so the deduction is the joint one.
    expect(standardDeduction(survivor, 72)).toBeCloseTo(standardDeduction(control, 72), 10);
  });
});

describe('the survivor arithmetic, as pure functions', () => {
  it('steps up community property in full and the deceased`s half otherwise', () => {
    expect(basisStepUpFraction({ owner: 'joint' }, 'primary')).toBe(1);
    expect(basisStepUpFraction({ owner: 'joint', propertyRegime: 'community' }, 'partner')).toBe(1);
    expect(basisStepUpFraction({ owner: 'joint', propertyRegime: 'jointTenancy' }, 'primary')).toBe(0.5);
    expect(basisStepUpFraction({ owner: 'primary' }, 'primary')).toBe(0.5);
    expect(basisStepUpFraction({ owner: 'primary' }, 'partner')).toBe(0);
    expect(basisStepUpFraction({}, 'partner')).toBe(0);
  });

  it('keeps the joint return for the year of the death and files single after it', () => {
    expect(survivorFilingStatus('marriedFilingJointly', undefined, 80)).toBe('marriedFilingJointly');
    // The settlement year ending at 71 spans ages 70..71, so a death at 70.5 is inside it.
    expect(survivorFilingStatus('marriedFilingJointly', { age: 70.5 }, 71)).toBe('marriedFilingJointly');
    expect(survivorFilingStatus('marriedFilingJointly', { age: 70 }, 71.5)).toBe('single');
  });
});
