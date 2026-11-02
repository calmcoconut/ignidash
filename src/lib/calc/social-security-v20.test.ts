/**
 * The v20 Social Security rules: the survivor's own early-claiming reduction and survivor claim
 * age, children's benefits under the family maximum, and the retirement earnings test with its
 * recomputation at FRA. Each engine case is hand-worked in its comment.
 */

import { describe, expect, it } from 'vitest';

import type { Household, HouseholdChild } from '@/lib/schemas/inputs/household-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { fullRetirementAge, survivorFullRetirementAge } from './fra-table';
import { CHILD_BENEFIT_ROW_PREFIX } from './incomes';
import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { FinancialSimulationEngine, type SimulationResult } from './simulation-engine';
import { survivorBenefit, survivorReductionFactor } from './social-security';
import { earningsTestWithholding, familyMaximum, familyMaximumFactor, isChildEntitled } from './social-security-family';
import {
  TEST_CLOCK,
  createDefaultTimeline,
  createIncomeInput,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
} from './__tests__/test-utils';

const ZERO_RETURNS = { stockReturn: 0, stockYield: 0, bondReturn: 0, bondYield: 0, cashReturn: 0, inflationRate: 0 };

describe('the pure rules', () => {
  it('reads the survivor FRA two cohorts behind the retirement FRA', () => {
    expect(survivorFullRetirementAge(1962).totalMonths).toBe(67 * 12);
    expect(survivorFullRetirementAge(1957).totalMonths).toBe(66 * 12 + 2);
    expect(survivorFullRetirementAge(1950).totalMonths).toBe(66 * 12);
    expect(fullRetirementAge(1957).totalMonths).toBe(66 * 12 + 6);
  });

  it('reduces a survivor benefit linearly from 28.5% at 60 to nothing at the survivor FRA', () => {
    const fra = survivorFullRetirementAge(1970);
    expect(survivorReductionFactor(60, fra)).toBeCloseTo(0.715, 12);
    expect(survivorReductionFactor(63, fra)).toBeCloseTo(1 - (0.285 * 48) / 84, 12);
    expect(survivorReductionFactor(67, fra)).toBe(1);
    expect(survivorReductionFactor(70, fra)).toBe(1);
  });

  it("applies the survivor's reduction under RIB-LIM when the deceased claimed early", () => {
    const fra = fullRetirementAge(1960);
    expect(survivorBenefit({ pia: 1000, claimAge: 62, deathAge: 75, fra, survivorFactor: 0.715 })).toBeCloseTo(715, 9);
    expect(survivorBenefit({ pia: 1000, claimAge: 70, deathAge: 75, fra, survivorFactor: 0.715 })).toBeCloseTo(886.6, 9);
    // Without a factor it is the P1-P8 rule: the 82.5% floor.
    expect(survivorBenefit({ pia: 1000, claimAge: 62, deathAge: 75, fra })).toBeCloseTo(825, 9);
  });

  it('computes the family maximum and shares it in proportion', () => {
    expect(familyMaximum(3000, 2026)).toBeCloseTo(5287.52, 9);
    expect(familyMaximumFactor(1000, [600, 600])).toBeCloseTo(1000 / 1200, 12);
    expect(familyMaximumFactor(1000, [400])).toBe(1);
  });

  it('entitles a child under 18, or under 19 as a student', () => {
    expect(isChildEntitled(17.9, false)).toBe(true);
    expect(isChildEntitled(18, false)).toBe(false);
    expect(isChildEntitled(18.5, true)).toBe(true);
    expect(isChildEntitled(-0.5, false)).toBe(false);
  });

  it('withholds $1 per $2 over the exempt amount, and $1 per $3 in the FRA year', () => {
    expect(earningsTestWithholding(44_480, 24_480, 1 / 2)).toBeCloseTo(10_000, 9);
    expect(earningsTestWithholding(80_160, 65_160, 1 / 3)).toBeCloseTo(5_000, 9);
    expect(earningsTestWithholding(20_000, 24_480, 1 / 2)).toBe(0);
  });
});

const run = (inputs: SimulatorInputs): SimulationResult =>
  new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);

const pointAt = (result: SimulationResult, age: number) => {
  const point = result.data.find((candidate) => Math.abs(candidate.age - age) < 1e-9);
  if (point === undefined) throw new Error(`no yearly point at age ${age}`);
  return point;
};
const incomeAt = (result: SimulationResult, age: number, id: string): number =>
  pointAt(result, age).incomes?.perIncomeData[id]?.income ?? 0;

const ssLine = (
  id: string,
  owner: 'primary' | 'partner',
  block: { pia: number; claimAge: number; survivorClaimAge?: number }
): SimulatorInputs['incomes'][string] => ({
  ...createIncomeInput({
    id,
    name: id,
    amount: 1,
    frequency: 'yearly',
    taxes: { incomeType: 'socialSecurity', withholding: 0 },
    timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
  }),
  owner,
  socialSecurity: { mode: 'manual', ...block },
});

function plan(options: {
  household: Household;
  birthYear: number;
  lifeExpectancy: number;
  incomes: SimulatorInputs['incomes'];
}): SimulatorInputs {
  return createSimulatorInputs({
    timeline: {
      ...createDefaultTimeline(),
      birthMonth: 10,
      birthYear: options.birthYear,
      lifeExpectancy: options.lifeExpectancy,
      household: options.household,
    },
    incomes: options.incomes,
    expenses: {},
    accounts: { brokerage: createTaxableBrokerageAccount({ id: 'brokerage', balance: 3_000_000, costBasis: 3_000_000 }) },
    marketAssumptions: ZERO_RETURNS,
  });
}

describe('the survivor claiming strategy (v20)', () => {
  /**
   * Primary born Oct 1970 (56.0 at the clock), PIA $3,000, claim 70, dies at 62 before claiming, so
   * S = the PIA, $3,000. Partner born Oct 1972 (two years younger, survivor FRA 67), PIA $500, claim 67.
   */
  const couple = (survivorClaimAge?: number) =>
    plan({
      birthYear: 1970,
      lifeExpectancy: 62,
      household: {
        members: [
          { id: 'primary', role: 'primary', birthMonth: 10, birthYear: 1970, lifeExpectancy: 62 },
          { id: 'partner', role: 'partner', birthMonth: 10, birthYear: 1972, lifeExpectancy: 90 },
        ],
      },
      incomes: {
        primarySs: ssLine('primarySs', 'primary', { pia: 3000, claimAge: 70 }),
        partnerSs: ssLine('partnerSs', 'partner', {
          pia: 500,
          claimAge: 67,
          ...(survivorClaimAge === undefined ? {} : { survivorClaimAge }),
        }),
      },
    });

  it('starts the survivor benefit at 60, reduced 28.5%, and tops up less once the own benefit starts', () => {
    const result = run(couple(60));
    // From the death (plan 62, partner 60): 3,000 × 0.715 × 12 = 25,740, the partner's own not yet claimed.
    expect(incomeAt(result, 64, 'primarySs')).toBeCloseTo(25_740, 6);
    // From the partner's own claim at 67 (plan 69): 25,740 − 500 × 12 = 19,740.
    expect(incomeAt(result, 70, 'primarySs')).toBeCloseTo(19_740, 6);
  });

  it('without a survivor claim age, waits for the own claim age and pays the unreduced benefit', () => {
    const result = run(couple());
    expect(incomeAt(result, 64, 'primarySs')).toBe(0);
    // At 67 (survivor FRA) there is no reduction: 36,000 − 6,000 = 30,000.
    expect(incomeAt(result, 70, 'primarySs')).toBeCloseTo(30_000, 6);
  });
});

describe("children's benefits under the family maximum (v20)", () => {
  /** Born Oct 1960 (66.0), PIA $2,000, claim 66: paid from now. */
  const single = (children: HouseholdChild[]) =>
    plan({
      birthYear: 1960,
      lifeExpectancy: 85,
      household: { members: [{ id: 'primary', role: 'primary' }], children },
      incomes: { ss: ssLine('ss', 'primary', { pia: 2000, claimAge: 66 }) },
    });
  const childRow = `${CHILD_BENEFIT_ROW_PREFIX}primary`;

  it("pays a child 50% of a living worker's PIA until 18", () => {
    // Family max (2026): 1.5 × 1,643 + 2.72 × 357 = 3,435.54; the auxiliaries share 1,435.54 ≥ 1,000.
    const result = run(single([{ id: 'kid', birthMonth: 10, birthYear: 2012 }]));
    expect(incomeAt(result, 67, childRow)).toBeCloseTo(12_000, 6);
    // The year ending at 70 holds 11 months before the 18th birthday.
    expect(incomeAt(result, 70, childRow)).toBeCloseTo(11_000, 6);
    expect(incomeAt(result, 72, childRow)).toBe(0);
    // A child's benefit is the child's, not the parents': it is not Social Security income on the return.
    expect(pointAt(result, 67).incomes?.totalSocialSecurityIncome).toBeCloseTo(2000 * (1 - 12 * (5 / 9 / 100)) * 12, 6);
  });

  it('caps two children at the family maximum', () => {
    const twins = [
      { id: 'a', birthMonth: 10, birthYear: 2012 },
      { id: 'b', birthMonth: 10, birthYear: 2012 },
    ];
    const result = run(single(twins));
    expect(incomeAt(result, 67, childRow)).toBeCloseTo((familyMaximum(2000, 2026) - 2000) * 12, 6);
  });

  it('continues to 19 for a student', () => {
    const result = run(single([{ id: 'kid', birthMonth: 10, birthYear: 2012, student: true }]));
    expect(incomeAt(result, 71, childRow)).toBeCloseTo(11_000, 6);
  });
});

describe('the retirement earnings test (v20)', () => {
  /**
   * Born Oct 1962 (64.0, FRA 67 → plan 67), PIA $2,000, claim 64: 36 months early, factor 0.8, so
   * $1,600 a month. Wages $44,480 a year: the 2026 test withholds (44,480 − 24,480) / 2 = $10,000 a
   * year. Withholding falls after the excess is earned: month 7 owes (7 × 3,706.67 − 24,480) / 2 =
   * 733.33, months 8-12 a full 1,600 each, so year one holds 8,733.33 and the last 1,266.67 carries
   * into year two, which withholds 10,000 and carries 1,266.67 into the FRA year. Withheld months:
   * 20,000 / 1,600 = 12.5 → 12, so at FRA the benefit is
   * recomputed as 24 months early: factor 1 − 24 × 5/9% = 0.86667, $1,733.33 a month.
   */
  const worker = () =>
    plan({
      birthYear: 1962,
      lifeExpectancy: 85,
      household: { members: [{ id: 'primary', role: 'primary' }] },
      incomes: {
        ss: ssLine('ss', 'primary', { pia: 2000, claimAge: 64 }),
        wages: createIncomeInput({
          id: 'wages',
          name: 'wages',
          amount: 44_480,
          frequency: 'yearly',
          taxes: { incomeType: 'wage', withholding: 0 },
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
        }),
      },
    });

  it('withholds the excess and recomputes the benefit at FRA', () => {
    const result = run(worker());
    expect(incomeAt(result, 65, 'ss')).toBeCloseTo(19_200 - 8_733.333333, 4);
    expect(incomeAt(result, 66, 'ss')).toBeCloseTo(19_200 - 10_000, 6);
    expect(incomeAt(result, 68, 'ss')).toBeCloseTo(2000 * (1 - (24 * 5) / 9 / 100) * 12, 6);
  });
});
