import { describe, expect, it } from 'vitest';

import { SINGLE_MEMBER_HOUSEHOLD, type Household } from '@/lib/schemas/inputs/household-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { fullRetirementAge } from './fra-table';
import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { FinancialSimulationEngine, type SimulationResult } from './simulation-engine';
import { spousalExcess, spousalReductionFactor, survivorBenefit } from './social-security';
import {
  TEST_CLOCK,
  createDefaultTimeline,
  createIncomeInput,
  createSavingsAccount,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
} from './__tests__/test-utils';

/**
 * P1-P8, spousal and survivor Social Security (decision E2).
 *
 * Two layers. The pure functions are checked against hand-worked figures in their comments. The
 * couple tests run `simulate()` on a household whose two Social Security lines carry estimates, and
 * read the yearly income of each line.
 *
 * ## The fixture
 *
 * Both members are born in October, on the plan's own calendar (`TEST_CLOCK` is 1 October 2026), so
 * the primary starts at exactly age 66 and the partner, born two years later, at exactly 64. Their
 * full retirement age is 67 both ways (birth years 1960 and 1962). Every plan-axis age below is the
 * primary's age, and the partner's own age is that minus 2.
 *
 * Every money figure is a yearly income with zero returns, zero inflation and no COLA, so a benefit
 * is the same every year and the expected numbers are plain products.
 *
 * ## Reading a yearly point
 *
 * `result.data` has one point per year, labelled by its end age: the point labelled `N` holds the
 * months whose age is in (N − 1, N]. A line's annual income is therefore its point's income. A
 * change at a whole age `N` shows up as one month's share in point `N` and in full from `N + 1`.
 */

const ZERO_RETURNS = { stockReturn: 0, stockYield: 0, bondReturn: 0, bondYield: 0, cashReturn: 0, inflationRate: 0 };

const PRIMARY = { birthMonth: 10, birthYear: 1960 } as const;
const PARTNER = { birthMonth: 10, birthYear: 1962 } as const;

interface LineSpec {
  readonly pia: number;
  readonly claimAge: number;
}

/** A Social Security income for one member, paying its estimate. */
const socialSecurityLine = (id: string, owner: 'primary' | 'partner', { pia, claimAge }: LineSpec) => ({
  ...createIncomeInput({
    id,
    name: id,
    amount: 1,
    frequency: 'yearly',
    taxes: { incomeType: 'socialSecurity', withholding: 0 },
    timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
  }),
  owner,
  socialSecurity: { mode: 'manual' as const, pia, claimAge },
});

/**
 * A couple with a Social Security line each (or only the primary's, when `partner` is undefined).
 * `primaryLifeExpectancy` decides who dies first: the partner lives to 85, so the primary dying at
 * 75 is the survivor window under test.
 */
function couplePlan(options: {
  readonly primary?: LineSpec;
  readonly partner?: LineSpec;
  readonly primaryLifeExpectancy?: number;
  readonly extraIncomes?: SimulatorInputs['incomes'];
}): SimulatorInputs {
  const { primary, partner, primaryLifeExpectancy = 75, extraIncomes = {} } = options;
  const household: Household = {
    members: [
      {
        id: 'primary',
        role: 'primary',
        birthMonth: PRIMARY.birthMonth,
        birthYear: PRIMARY.birthYear,
        lifeExpectancy: primaryLifeExpectancy,
      },
      { id: 'partner', role: 'partner', birthMonth: PARTNER.birthMonth, birthYear: PARTNER.birthYear, lifeExpectancy: 85 },
    ],
  };

  return createSimulatorInputs({
    timeline: {
      ...createDefaultTimeline(),
      birthMonth: PRIMARY.birthMonth,
      birthYear: PRIMARY.birthYear,
      lifeExpectancy: primaryLifeExpectancy,
      household,
    },
    incomes: {
      ...(primary === undefined ? {} : { primarySs: socialSecurityLine('primarySs', 'primary', primary) }),
      ...(partner === undefined ? {} : { partnerSs: socialSecurityLine('partnerSs', 'partner', partner) }),
      ...extraIncomes,
    },
    expenses: {},
    accounts: { brokerage: createTaxableBrokerageAccount({ id: 'brokerage', balance: 1_000_000, costBasis: 1_000_000 }) },
    marketAssumptions: ZERO_RETURNS,
  });
}

const run = (inputs: SimulatorInputs): SimulationResult =>
  new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);

/** The yearly point labelled `age` (see the header). */
const pointAt = (result: SimulationResult, age: number) => {
  const point = result.data.find((candidate) => candidate.age !== undefined && Math.abs(candidate.age - age) < 1e-9);
  if (point === undefined) throw new Error(`no yearly point at age ${age}`);

  return point;
};

/** A line's income in the year labelled `age`; 0 when the line is not being paid that year. */
const lineIncomeAt = (result: SimulationResult, age: number, id: string): number =>
  pointAt(result, age).incomes?.perIncomeData[id]?.income ?? 0;

// ============================================================================
// The pure functions
// ============================================================================

describe('the spousal reduction, as a pure function (20 CFR 404.410)', () => {
  it('is 1 for a spousal benefit that starts at or after FRA', () => {
    expect(spousalReductionFactor(0)).toBe(1);
  });

  it('takes 25/36 of 1% a month for the first 36 months: 36 months early is a 25% reduction, factor 0.75', () => {
    expect(spousalReductionFactor(36)).toBeCloseTo(0.75, 12);
  });

  it('adds 5/12 of 1% a month after that: 60 months early is 25% + 24 × 5/12% = 35%, factor 0.65', () => {
    expect(spousalReductionFactor(60)).toBeCloseTo(0.65, 12);
  });
});

describe('the spousal excess (20 CFR 404.410)', () => {
  const fra67 = fullRetirementAge(1960);

  it('is up to half the other member’s PIA less the spouse’s own, at FRA: $3,000 and $1,000 give $500', () => {
    // 0.5 × 3000 = 1500; 1500 − 1000 = 500; claimed at FRA, so no reduction.
    expect(spousalExcess({ ownPia: 1000, otherPia: 3000, claimAge: 67, fra: fra67 })).toBeCloseTo(500, 10);
  });

  it('is reduced for a claim before FRA: at 65 with FRA 67, 24 months early, factor 5/6, so $500 × 5/6', () => {
    // 24 × 25/36% = 16 2/3%, so the factor is 1 − 1/6 = 5/6.
    expect(spousalExcess({ ownPia: 1000, otherPia: 3000, claimAge: 65, fra: fra67 })).toBeCloseTo((500 * 5) / 6, 10);
  });

  it('is cut to 0.65 of the excess for a claim at 62, 60 months early: $500 × 0.65 = $325', () => {
    // 35% reduction (see `spousalReductionFactor(60)`), so 500 × 0.65 = 325.
    expect(spousalExcess({ ownPia: 1000, otherPia: 3000, claimAge: 62, fra: fra67 })).toBeCloseTo(325, 10);
  });

  it('is zero when the spouse’s own PIA is at least half the other’s: $1,500 against $3,000', () => {
    // 0.5 × 3000 = 1500; 1500 − 1500 = 0.
    expect(spousalExcess({ ownPia: 1500, otherPia: 3000, claimAge: 62, fra: fra67 })).toBe(0);
  });
});

describe('the survivor benefit (Social Security Act §202(e)-(f), RIB-LIM at §202(e)(2)(D))', () => {
  const fra67 = fullRetirementAge(1960);

  it('is the deceased’s benefit when they had claimed: claimed at 62 gives 70% of a $1,000 PIA, lifted to the $825 floor', () => {
    // 0.70 × 1000 = 700, below the 82.5% floor of 825, so 825.
    expect(survivorBenefit({ pia: 1000, claimAge: 62, deathAge: 80, fra: fra67 })).toBeCloseTo(825, 10);
  });

  it('keeps the delayed credits when the deceased had claimed late: claimed at 70 gives 124% of the PIA, $1,240', () => {
    // 36 months late × 2/3% = 24% credit; 1.24 × 1000 = 1240, above the floor.
    expect(survivorBenefit({ pia: 1000, claimAge: 70, deathAge: 80, fra: fra67 })).toBeCloseTo(1240, 10);
  });

  it('credits only the months earned before death when the deceased died before claiming: died at 68, claim 70, $1,080', () => {
    // 12 months late × 2/3% = 8% credit; 1.08 × 1000 = 1080.
    expect(survivorBenefit({ pia: 1000, claimAge: 70, deathAge: 68, fra: fra67 })).toBeCloseTo(1080, 10);
  });

  it('is the bare PIA when death comes before FRA and before claiming: died at 64, claim 70, $1,000', () => {
    // No months late before the death, so no credit and no reduction.
    expect(survivorBenefit({ pia: 1000, claimAge: 70, deathAge: 64, fra: fra67 })).toBeCloseTo(1000, 10);
  });
});

// ============================================================================
// Through simulate(): a couple whose lines carry estimates
// ============================================================================

describe('a couple with an estimated Social Security line each', () => {
  // The primary (PIA $3,000, claims at 67, so $36,000 a year) dies at 75; the partner (PIA $1,000,
  // claims at 67, so $12,000 a year, reached at plan age 69 because they are two years younger)
  // lives to 85.

  it('pays the survivor the top-up on the deceased’s line, from the death, and the survivor’s total is the survivor benefit', () => {
    const result = run(couplePlan({ primary: { pia: 3000, claimAge: 67 }, partner: { pia: 1000, claimAge: 67 } }));

    // Before the death the primary's line pays its own $36,000 (the partner's add-on is tested below).
    expect(lineIncomeAt(result, 74, 'primarySs')).toBeCloseTo(36_000, 6);

    // After the death, from age 76 (the year labelled 76 is the first full post-death year):
    // survivor benefit S = max(3000, 0.825 × 3000) = $3,000 a month, so $36,000 a year;
    // the survivor's own is $12,000; the top-up is 36,000 − 12,000 = $24,000 a year, on the primary's line.
    expect(lineIncomeAt(result, 76, 'primarySs')).toBeCloseTo(24_000, 6);
    // The partner's own line carries on at $12,000, so together they are the $36,000 survivor benefit.
    expect(lineIncomeAt(result, 76, 'partnerSs')).toBeCloseTo(12_000, 6);
    expect(lineIncomeAt(result, 76, 'primarySs') + lineIncomeAt(result, 76, 'partnerSs')).toBeCloseTo(36_000, 6);
  });

  it('pays the partner their spousal add-on from the later of the two claims, and stops it at the death', () => {
    const result = run(couplePlan({ primary: { pia: 3000, claimAge: 67 }, partner: { pia: 1000, claimAge: 67 } }));

    // Spousal add-on: 0.5 × $3,000 − $1,000 = $500 a month, at FRA: $6,000 a year. It starts when both
    // have claimed, the later of plan age 67 (primary) and 69 (partner): plan age 69. The point
    // labelled 69 holds one month of it (the month at exactly 69), and from 70 it is a full year.
    expect(lineIncomeAt(result, 69, 'partnerSs')).toBeCloseTo(12_000 + 500, 6);
    expect(lineIncomeAt(result, 70, 'partnerSs')).toBeCloseTo(12_000 + 6_000, 6);
    expect(lineIncomeAt(result, 74, 'partnerSs')).toBeCloseTo(12_000 + 6_000, 6);

    // The primary dies at 75, so the spousal add-on ends with the other member's life: the point
    // labelled 76 is back to the partner's own $12,000.
    expect(lineIncomeAt(result, 76, 'partnerSs')).toBeCloseTo(12_000, 6);
  });

  it('starts the spousal add-on at the other member’s claim, not the spouse’s own, when the other claims later', () => {
    // The partner claims at 67 (plan 69) but the primary waits until 70 (plan 70): the add-on starts
    // at 70, the later of the two. At 70 the partner is 68, which is before their FRA of 67 + 1, so
    // the add-on is unreduced: 0 months early, factor 1, so $500 a month.
    const result = run(couplePlan({ primary: { pia: 3000, claimAge: 70 }, partner: { pia: 1000, claimAge: 67 } }));

    // The partner's own line is still $12,000 from plan age 69 (the claim is in the amount, not the start).
    expect(lineIncomeAt(result, 69, 'partnerSs')).toBeCloseTo(12_000, 6);
    // The add-on begins with the primary's claim at 70: one month in point 70, a full year from 71.
    expect(lineIncomeAt(result, 70, 'partnerSs')).toBeCloseTo(12_000 + 500, 6);
    expect(lineIncomeAt(result, 71, 'partnerSs')).toBeCloseTo(12_000 + 6_000, 6);
  });

  it('reduces the spousal add-on for the partner’s own early claim: partner at 62, primary at 67, spousal age 65', () => {
    // The partner claims at 62 (plan 64): own benefit 0.70 × $1,000 = $700 a month, $8,400 a year.
    // The primary claims at 67 (plan 67), so the add-on starts at plan 67, when the partner is 65:
    // 24 months early, factor 5/6, so $500 × 5/6 = $416.67 a month, $5,000 a year.
    const result = run(couplePlan({ primary: { pia: 3000, claimAge: 67 }, partner: { pia: 1000, claimAge: 62 } }));

    // The first settled year is labelled 67, and the add-on starts at exactly 67, so that point holds
    // the partner's own $8,400 plus one month of the add-on: $5,000 / 12 = $416.67.
    expect(lineIncomeAt(result, 67, 'partnerSs')).toBeCloseTo(8_400 + 5_000 / 12, 6);
    expect(lineIncomeAt(result, 68, 'partnerSs')).toBeCloseTo(8_400 + 5_000, 6);
  });

  it('pays no top-up when the survivor’s own benefit is the larger: a partner with a $4,000 PIA keeps their own $48,000', () => {
    // The survivor benefit is $36,000 (the primary's $3,000 PIA), and the partner's own is $48,000, so
    // max(0, 36,000 − 48,000) is zero and the primary's line pays nothing after the death.
    const result = run(couplePlan({ primary: { pia: 3000, claimAge: 67 }, partner: { pia: 4000, claimAge: 67 } }));

    expect(lineIncomeAt(result, 74, 'primarySs')).toBeCloseTo(36_000, 6);
    expect(lineIncomeAt(result, 76, 'primarySs')).toBe(0);
    // The partner's $48,000 is the survivor's whole Social Security from the death.
    expect(lineIncomeAt(result, 76, 'partnerSs')).toBeCloseTo(48_000, 6);
  });

  it('pays a survivor with no Social Security line the whole survivor benefit, from their FRA or the death, whichever is later', () => {
    // No partner line: the partner's own benefit is nil, and their FRA of 67 is plan age 69. The
    // death at 75 is later, so the full $36,000 is paid on the primary's line from 76.
    const result = run(couplePlan({ primary: { pia: 3000, claimAge: 67 } }));

    expect(lineIncomeAt(result, 74, 'primarySs')).toBeCloseTo(36_000, 6);
    expect(lineIncomeAt(result, 76, 'primarySs')).toBeCloseTo(36_000, 6);
  });

  it('waits for the survivor’s own claim when that is later than the death: primary dies at 70, partner claims at 70 (plan 72)', () => {
    // Primary: PIA $3,000 claimed at 67, S = $36,000 a year. Partner: PIA $1,000 claimed at 70, own
    // 1.24 × $1,000 = $1,240 a month, $14,880 a year, from plan age 72 onward when they are 70.
    // The top-up is 36,000 − 14,880 = $21,120 a year, and it starts at 72, the later of death (70)
    // and the partner's claim (72). The partner's own line is paid from its start, at its amount.
    const result = run(
      couplePlan({ primary: { pia: 3000, claimAge: 67 }, partner: { pia: 1000, claimAge: 70 }, primaryLifeExpectancy: 70 })
    );

    expect(lineIncomeAt(result, 71, 'primarySs')).toBe(0);
    // The point labelled 72 holds one month of the top-up, the month at exactly 72.
    expect(lineIncomeAt(result, 72, 'primarySs')).toBeCloseTo(21_120 / 12, 6);
    expect(lineIncomeAt(result, 73, 'primarySs')).toBeCloseTo(21_120, 6);
    // The two lines together are the survivor benefit, $36,000, in a full year after the claim.
    expect(lineIncomeAt(result, 73, 'primarySs') + lineIncomeAt(result, 73, 'partnerSs')).toBeCloseTo(36_000, 6);
  });

  it('stops the deceased’s line at death when the survivor’s line is unwired: a second Social Security line makes the partner unwired', () => {
    // The partner's second, stored-amount line means their benefit is unknown, so the survivor top-up
    // cannot be computed and the primary's line stops at the death, as it did before this item.
    const extra: SimulatorInputs['incomes'] = {
      stray: {
        ...createIncomeInput({
          id: 'stray',
          amount: 500,
          frequency: 'yearly',
          taxes: { incomeType: 'socialSecurity', withholding: 0 },
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
        }),
        owner: 'partner',
      },
    };
    const result = run(couplePlan({ primary: { pia: 3000, claimAge: 67 }, partner: { pia: 1000, claimAge: 67 }, extraIncomes: extra }));

    expect(lineIncomeAt(result, 74, 'primarySs')).toBeCloseTo(36_000, 6);
    expect(lineIncomeAt(result, 76, 'primarySs')).toBe(0);
  });

  it('stops a deceased member’s line without a Social Security estimate at death, as before', () => {
    // A line with no block is paid its stored amount and is not wired, so there is no survivor term.
    const plainPrimary = {
      ...createIncomeInput({
        id: 'plainPrimary',
        amount: 20_000,
        frequency: 'yearly',
        taxes: { incomeType: 'socialSecurity', withholding: 0 },
        timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
      }),
      owner: 'primary' as const,
    };
    const result = run(couplePlan({ partner: { pia: 1000, claimAge: 67 }, extraIncomes: { plainPrimary } }));

    expect(lineIncomeAt(result, 74, 'plainPrimary')).toBeCloseTo(20_000, 6);
    expect(lineIncomeAt(result, 76, 'plainPrimary')).toBe(0);
  });
});

describe('a household of one is not wired, whatever Social Security it stores', () => {
  it('pays the same yearly figures with a partner-owned line as the primary’s own, with no spousal add-on', () => {
    // A household of one holding a line owned by a partner, who is not a member: nothing is wired,
    // so the partner-owned line pays its own $12,000 every year. A wired couple would have added a
    // $500 a month spousal share from the primary's claim.
    const single: SimulatorInputs = createSimulatorInputs({
      timeline: {
        ...createDefaultTimeline(),
        birthMonth: PRIMARY.birthMonth,
        birthYear: PRIMARY.birthYear,
        lifeExpectancy: 85,
        household: SINGLE_MEMBER_HOUSEHOLD,
      },
      incomes: {
        primarySs: socialSecurityLine('primarySs', 'primary', { pia: 3000, claimAge: 67 }),
        partnerSs: socialSecurityLine('partnerSs', 'partner', { pia: 1000, claimAge: 67 }),
      },
      expenses: {},
      accounts: { savings: createSavingsAccount({ id: 'savings', balance: 100_000 }) },
      marketAssumptions: ZERO_RETURNS,
    });
    const result = run(single);

    expect(lineIncomeAt(result, 70, 'primarySs')).toBeCloseTo(36_000, 6);
    expect(lineIncomeAt(result, 70, 'partnerSs')).toBeCloseTo(12_000, 6);
  });

  it('is bit-identical whether the household is stored as one member or not stored at all', () => {
    const base = couplePlan({ primary: { pia: 3000, claimAge: 67 } });
    const withoutHousehold = run({ ...base, timeline: { ...base.timeline!, household: undefined } });
    const withSingleMember = run({ ...base, timeline: { ...base.timeline!, household: SINGLE_MEMBER_HOUSEHOLD } });

    expect(withSingleMember).toStrictEqual(withoutHousehold);
  });
});
