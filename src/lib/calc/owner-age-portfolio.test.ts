import { describe, expect, it } from 'vitest';

import { getAnnualContributionLimit } from '@/lib/schemas/inputs/contribution-form-schema';
import type { Household } from '@/lib/schemas/inputs/household-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { simulate } from './simulate';
import { seppAnnualAmountFromTables } from './retirement-rules/sepp';
import { singleLifeExpectancy } from './retirement-rules/sepp-tables';
import {
  create401kAccount,
  createContributionRule,
  createDefaultTimeline,
  createIraAccount,
  createSimulatorInputs,
  createWageIncome,
} from './__tests__/test-utils';

/**
 * Owner age in the portfolio layer.
 *
 * Both members are born on 1 January so that their ages on the 2026-01-01 start are whole numbers:
 * a member born 1954 is 72, one born 1974 is 52, one born 1981 is 45. The plan axis is the plan
 * birth, which is the primary's. Every test runs through the pure `simulate()` entry point with zero
 * market growth, so balances are exactly what the fixtures say.
 */

type BirthDate = { birthMonth: number; birthYear: number };

const ZERO_GROWTH = {
  stockReturn: 0,
  stockYield: 0,
  bondReturn: 0,
  bondYield: 0,
  cashReturn: 0,
  inflationRate: 0,
};

/** A couple whose members are born on the given dates; the primary's date is the plan's own. */
const couplePlan = (primary: BirthDate, partner: BirthDate, overrides: Partial<SimulatorInputs> = {}): SimulatorInputs => {
  const household: Household = {
    members: [
      { id: 'primary', role: 'primary', ...primary, lifeExpectancy: 92 },
      { id: 'partner', role: 'partner', ...partner, lifeExpectancy: 92 },
    ],
  };

  // `createSimulatorInputs` copies only the fields it names (not `sepp`, `conversions`, ...), so the
  // overrides are spread after it rather than passed into it.
  return {
    ...createSimulatorInputs({
      timeline: {
        ...createDefaultTimeline(),
        birthMonth: primary.birthMonth,
        birthYear: primary.birthYear,
        lifeExpectancy: 92,
        household,
      },
      marketAssumptions: { ...ZERO_GROWTH },
    }),
    ...overrides,
  };
};

const run = (inputs: SimulatorInputs) => simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 }).result;

/** `data[0]` is the initial state, so the settlement of calendar year Y is `data[Y - 2025]`. */
const settlementOf = (result: ReturnType<typeof run>, calendarYear: number) => result.data[calendarYear - 2025];

const PRIMARY_1954: BirthDate = { birthMonth: 1, birthYear: 1954 };
const PARTNER_1974: BirthDate = { birthMonth: 1, birthYear: 1974 };
const PARTNER_1981: BirthDate = { birthMonth: 1, birthYear: 1981 };

describe('a SEPP schedule on the partner`s IRA is measured at the partner`s age', () => {
  /** An RMD-method schedule on the partner's own traditional IRA, starting in 2026. */
  const rmdSeppOnPartnerIra = () =>
    couplePlan(PRIMARY_1954, PARTNER_1974, {
      accounts: {
        partnerIra: {
          ...createIraAccount({ id: 'partnerIra', name: 'Partner IRA', balance: 500000, percentBonds: 0 }),
          owner: 'partner' as const,
        },
      },
      sepp: [{ id: 'sepp-1', accountId: 'partnerIra', method: 'rmd', startYear: 2026 }],
    });

  it('sizes the RMD-method payment by the partner`s Single Life period, not the primary`s', () => {
    // The Single Life Table gives 34.3 years at age 52 (the partner) and 17.2 at age 72 (the
    // primary). The balance on 1 January 2026 is 500,000, as nothing grows. So the 2026 payment is
    // 500,000 / 34.3 = 14,577.26 at the partner's age, and 500,000 / 17.2 = 29,069.77 at the primary's.
    expect(singleLifeExpectancy(52)).toBe(34.3);
    expect(singleLifeExpectancy(72)).toBe(17.2);

    const paid = settlementOf(run(rmdSeppOnPartnerIra()), 2026).taxes!.incomeSources.taxDeferredWithdrawals;

    expect(paid).toBeCloseTo(500000 / 34.3, 6);
    expect(paid).not.toBeCloseTo(500000 / 17.2, 0);
  });
});

describe('the must-continue date of a partner-owned SEPP uses the partner`s 59½ date', () => {
  /**
   * The partner, born 1 January 1974, reaches 59½ on 1 July 2033. The primary, born 1954, passed it
   * in 2013. A schedule starting 1 January 2026 must run at least five years, to 1 January 2031.
   * For the partner the later of the two dates is 1 July 2033; read off the primary's birth date
   * it would be 1 January 2031.
   */
  const partnerSeppStoppingIn2032 = () =>
    couplePlan(PRIMARY_1954, PARTNER_1974, {
      accounts: {
        partnerIra: {
          ...createIraAccount({ id: 'partnerIra', name: 'Partner IRA', balance: 500000, percentBonds: 0 }),
          owner: 'partner' as const,
        },
      },
      sepp: [
        {
          id: 'sepp-1',
          accountId: 'partnerIra',
          method: 'fixedAmortization',
          startYear: 2026,
          stopYear: 2032,
          annualAmount: 20000,
        },
      ],
    });

  it('recaptures the 10% penalty when the partner stops in 2032, before the partner`s 59½', () => {
    // 1 January 2032 is after the primary-based date (2031) but before the partner's 59½ (2033), so
    // the stop is premature for the partner. Six payments were made, 2026 to 2031: 6 x 20,000 =
    // 120,000 recaptured in the 2032 settlement, with a 10% penalty of 12,000.
    const year2032 = settlementOf(run(partnerSeppStoppingIn2032()), 2032);

    expect(year2032.taxes!.incomeSources.earlyWithdrawals.seppRecapture).toBe(120000);
    expect(year2032.taxes!.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(12000);
  });

  it('reads the partner`s own birth month, not the plan`s', () => {
    // The partner is born 1 August 1973, so 59½ falls on 1 February 2033; stopping on 1 January 2033
    // is premature. Read with the plan's January birth month the date would be 1 July 2032, and the
    // same stop would be clean. Seven payments, 2026 to 2032: 7 x 20,000 = 140,000 recaptured.
    const inputs = couplePlan(
      PRIMARY_1954,
      { birthMonth: 8, birthYear: 1973 },
      {
        accounts: {
          partnerIra: {
            ...createIraAccount({ id: 'partnerIra', name: 'Partner IRA', balance: 500000, percentBonds: 0 }),
            owner: 'partner' as const,
          },
        },
        sepp: [
          { id: 'sepp-1', accountId: 'partnerIra', method: 'fixedAmortization', startYear: 2026, stopYear: 2033, annualAmount: 20000 },
        ],
      }
    );

    expect(settlementOf(run(inputs), 2033).taxes!.incomeSources.earlyWithdrawals.seppRecapture).toBe(140000);
  });
});

describe('catch-up eligibility is the contributing account owner`s age', () => {
  /** A couple with 200,000 of salary and no spending, saving into a 401(k) owned by the partner. */
  const partnerFunded401k = (primary: BirthDate, partner: BirthDate) =>
    couplePlan(primary, partner, {
      incomes: {
        salary: {
          ...createWageIncome({ id: 'salary', amount: 200000 }),
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
        },
      },
      accounts: {
        partner401k: {
          ...create401kAccount({ id: 'partner401k', name: 'Partner 401k', balance: 0 }),
          owner: 'partner' as const,
        },
      },
      contributionRules: {
        'rule-1': createContributionRule({ id: 'rule-1', accountId: 'partner401k', contributionType: 'unlimited' }),
      },
    });

  /** Employee money paid into the partner's 401(k) during calendar 2026 (no employer match is set). */
  const contributedIn2026 = (inputs: SimulatorInputs): number => {
    const flows = settlementOf(run(inputs), 2026).portfolio.perAccountData['partner401k']!.cumulativeContributions;

    return flows.stocks + flows.bonds + flows.cash;
  };

  it('gives a 45-year-old partner the base limit when the primary is 52', () => {
    // 2026 base limit for a 401(k) under 50: 24,500. The surplus is far above that each month, so
    // the year total is the limit exactly. Reading the primary's 52 would allow 24,500 + 8,000 of
    // age-50 catch-up, i.e. 32,500.
    expect(getAnnualContributionLimit('401kCombined', 45)).toBe(24500);
    expect(getAnnualContributionLimit('401kCombined', 52)).toBe(32500);

    expect(contributedIn2026(partnerFunded401k(PARTNER_1974, PARTNER_1981))).toBe(24500);
  });

  it('gives a 52-year-old partner the age-50 catch-up when the primary is 45', () => {
    // The mirror: partner born 1974 (52 in 2026) gets 24,500 + 8,000 = 32,500, where reading the
    // primary's 45 would hold them to 24,500.
    expect(contributedIn2026(partnerFunded401k(PARTNER_1981, PARTNER_1974))).toBe(32500);
  });
});

describe('a fixed SEPP table payment on the partner`s IRA is sized at the partner`s age', () => {
  /** A fixed-method schedule on the partner's IRA, with no `annualAmount`, so the table path prices it. */
  const fixedSeppOnPartnerIra = (method: 'fixedAmortization' | 'fixedAnnuitization') =>
    couplePlan(PRIMARY_1954, PARTNER_1974, {
      accounts: {
        partnerIra: {
          ...createIraAccount({ id: 'partnerIra', name: 'Partner IRA', balance: 500000, percentBonds: 0 }),
          owner: 'partner' as const,
        },
      },
      sepp: [{ id: 'sepp-1', accountId: 'partnerIra', method, startYear: 2026 }],
    });

  it.each(['fixedAmortization', 'fixedAnnuitization'] as const)(
    '%s prices the 2026 payment at the partner`s age 52, not the primary`s 72',
    (method) => {
      // Table path at age 52 gives the period 34.3; at age 72 it gives 17.2. Balance 500,000 with no growth.
      const atPartnerAge = seppAnnualAmountFromTables({ method, balance: 500000, age: 52, firstDistributionMonth: '2026-01' });
      const atPrimaryAge = seppAnnualAmountFromTables({ method, balance: 500000, age: 72, firstDistributionMonth: '2026-01' });

      const result = run(fixedSeppOnPartnerIra(method));
      const paid2026 = settlementOf(result, 2026).taxes!.incomeSources.taxDeferredWithdrawals;

      expect(paid2026).toBeCloseTo(atPartnerAge.annualAmount, 6);
      expect(paid2026).not.toBeCloseTo(atPrimaryAge.annualAmount, 0);
    }
  );

  it.each(['fixedAmortization', 'fixedAnnuitization'] as const)('%s keeps the 2026 payment fixed in 2027', (method) => {
    const result = run(fixedSeppOnPartnerIra(method));
    const paid2026 = settlementOf(result, 2026).taxes!.incomeSources.taxDeferredWithdrawals;
    const paid2027 = settlementOf(result, 2027).taxes!.incomeSources.taxDeferredWithdrawals;

    expect(paid2027).toBeCloseTo(paid2026, 6);
  });

  it('`fixedAmortization` equals B · r / (1 − (1 + r)^−n) with B = 500,000, n = 34.3 (age 52), r = the 2026-01 cap', () => {
    // Code formula (sepp.ts, seppAnnualAmount): balance × rate / (1 − (1 + rate)^−period), the ordinary-annuity
    // level payment. Here B = 500,000, n = singleLifeExpectancy(52) = 34.3, r = the maximum rate for a 2026-01 start.
    const { rate, distributionPeriod } = seppAnnualAmountFromTables({
      method: 'fixedAmortization',
      balance: 500000,
      age: 52,
      firstDistributionMonth: '2026-01',
    });
    expect(distributionPeriod).toBe(singleLifeExpectancy(52));

    const handWorked = (500000 * rate) / (1 - Math.pow(1 + rate, -34.3));

    const paid2026 = settlementOf(run(fixedSeppOnPartnerIra('fixedAmortization')), 2026).taxes!.incomeSources.taxDeferredWithdrawals;

    expect(paid2026).toBeCloseTo(handWorked, 6);
  });
});
