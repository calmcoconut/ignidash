/**
 * Owner-age tax gates (parity plan P1-P3, piece C).
 *
 * The tax layer reads each account's gate at its owner's age, not the primary's:
 *
 * | gate | rule | how it is proved here |
 * | --- | --- | --- |
 * | QCD (§408(d)(8)) | the owner must be 70½; the base is that owner's IRA distributions | a partner-owned IRA is excluded at the partner's 72, not refused for the primary's 68; the mirror (partner 68, primary 72) is refused |
 * | HSA (§223(f)(4)) | the 20% penalty on non-qualified withdrawals applies below 65 | the 66-year-old partner is not penalised while the primary is 63; the 63-year-old partner is, while the primary is 66 |
 * | Roth seasoning (§408A(d)(3)) | an unseasoned conversion is penalised below 59½ | pinned in both directions by swapping which member is over 59½ |
 *
 * Every fixture is a plan the schema accepts and runs through the pure `simulate()` entry point.
 * Returns are zero and inflation is zero, so every figure below is hand-checkable.
 */

import { describe, expect, it } from 'vitest';

import type { Household } from '@/lib/schemas/inputs/household-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { createDefaultTimeline, createHsaAccount, createIraAccount, createSimulatorInputs } from './__tests__/test-utils';
import { simulate } from './simulate';

const NO_GROWTH = { stockReturn: 0, bondReturn: 0, cashReturn: 0, stockYield: 0, bondYield: 0, inflationRate: 0 };

/** A couple whose members are born on the 1st of the given month and year, both to live to 92. */
const coupleBorn = (primary: { birthYear: number }, partner: { birthYear: number }): Household => ({
  members: [
    { id: 'primary', role: 'primary', birthMonth: 1, birthYear: primary.birthYear, lifeExpectancy: 92 },
    { id: 'partner', role: 'partner', birthMonth: 1, birthYear: partner.birthYear, lifeExpectancy: 92 },
  ],
});

/** A zero-return, tax-free-state plan for a couple, with nothing in it but what a test adds. */
const planFor = (household: Household, overrides: Partial<SimulatorInputs>): SimulatorInputs => {
  const base = createSimulatorInputs();
  const primary = household.members[0]!;

  return {
    ...base,
    timeline: { ...createDefaultTimeline(), birthYear: primary.birthYear!, birthMonth: 1, lifeExpectancy: 92, household },
    incomes: {},
    expenses: {},
    debts: {},
    physicalAssets: {},
    marketAssumptions: { ...base.marketAssumptions, ...NO_GROWTH },
    taxSettings: { ...base.taxSettings, stateResidency: 'none' },
    ...overrides,
  };
};

/** The first settled year: `data[0]` is the initial state, `data[1]` the first year's settlement. */
const runFirstYear = (inputs: SimulatorInputs) => simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 }).result.data[1]!;

/** A flat yearly living cost from now to the end of the plan. */
const livingCost = (amount: number) => ({
  living: {
    id: 'living',
    name: 'Living',
    amount,
    frequency: 'yearly' as const,
    amountBasis: 'nominal' as const,
    timeframe: { start: { type: 'now' as const }, end: { type: 'atLifeExpectancy' as const } },
  },
});

describe('a qualified charitable distribution is measured at the IRA owner`s age', () => {
  /** A $10,000 charitable gift paid from the IRA, funded by the IRA owned by the partner. */
  const charitableGiftFromPartnerIra = (household: Household) =>
    planFor(household, {
      accounts: {
        partnerIra: {
          ...createIraAccount({ id: 'partnerIra', name: 'Partner IRA', balance: 246000, percentBonds: 0 }),
          owner: 'partner' as const,
        },
      },
      expenses: {
        charity: {
          id: 'charity',
          name: 'Charity',
          amount: 10000,
          frequency: 'yearly',
          amountBasis: 'nominal',
          satisfyFromIra: true,
          timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
        },
      },
    });

  it('excludes a partner-owned IRA distribution when the partner is 72, though the primary is 68', () => {
    // Partner born 1954 is 72 in 2026: past 70½. The primary born 1958 is 68: not past it.
    // The $10,000 gift is paid from the partner's IRA, so the whole of it is QCD-eligible:
    // excluded = min(10,000 eligible, 10,000 gift) = 10,000, taxable = 0, rmdSatisfied = 10,000.
    const settled = runFirstYear(charitableGiftFromPartnerIra(coupleBorn({ birthYear: 1958 }, { birthYear: 1954 })));
    const qcd = settled.taxes!.incomeSources.qcdData!;

    expect(qcd.excludedAmount).toBe(10000);
    expect(qcd.taxableAmount).toBe(0);
    expect(qcd.rmdSatisfied).toBe(10000);
    expect(settled.taxes!.incomeSources.taxDeferredWithdrawals).toBe(0);
  });

  it('refuses the exclusion for a partner-owned IRA distribution when only the primary is 72', () => {
    // Mirror: primary born 1954 is 72, but the IRA that pays the gift belongs to the partner, born
    // 1958 and 68. Nothing is excluded: the distribution is ordinary income, so taxable = 10,000.
    // A primary-age read would exclude it, which is the defect this pins.
    const settled = runFirstYear(charitableGiftFromPartnerIra(coupleBorn({ birthYear: 1954 }, { birthYear: 1958 })));
    const qcd = settled.taxes!.incomeSources.qcdData!;

    expect(qcd.excludedAmount).toBe(0);
    expect(qcd.taxableAmount).toBe(10000);
    expect(qcd.rmdSatisfied).toBe(0);
    expect(settled.taxes!.incomeSources.taxDeferredWithdrawals).toBe(10000);
  });
});

describe('the HSA 65 penalty gate reads the HSA owner`s age', () => {
  /** A $10,000 living cost paid from a partner-owned HSA, with no qualified medical expenses. */
  const partnerHsaPlan = (household: Household) =>
    planFor(household, {
      accounts: {
        partnerHsa: {
          ...createHsaAccount({ id: 'partnerHsa', name: 'Partner HSA', balance: 50000, percentBonds: 0 }),
          owner: 'partner' as const,
        },
      },
      expenses: livingCost(10000),
    });

  it('does not charge the 20% penalty on a 66-year-old partner`s HSA while the primary is 63', () => {
    // Partner born 1960 is 66 in 2026: the §223(f)(4) penalty does not apply at 65 or over.
    // Primary born 1963 is 63. A primary-age read would charge 20% and fail this.
    const settled = runFirstYear(partnerHsaPlan(coupleBorn({ birthYear: 1963 }, { birthYear: 1960 })));

    expect(settled.taxes!.incomeSources.earlyWithdrawals.hsa).toBe(0);
    expect(settled.taxes!.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(0);
  });

  it('charges the 20% penalty on a 63-year-old partner`s HSA while the primary is 66', () => {
    // Mirror: partner born 1963 is 63, primary born 1960 is 66. The non-qualified draw is
    // penalised at 20%. The draw grosses up for its own penalty: 10,000 / 0.8 = 12,500 (the engine
    // rounds to the cent of the year's sale), so the penalty is 20% of what was withdrawn.
    const settled = runFirstYear(partnerHsaPlan(coupleBorn({ birthYear: 1960 }, { birthYear: 1963 })));
    const withdrawn = settled.taxes!.incomeSources.earlyWithdrawals.hsa;

    expect(withdrawn).toBeCloseTo(10000 / 0.8, -1);
    expect(settled.taxes!.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBeCloseTo(withdrawn * 0.2, 6);
  });
});

describe('Roth conversion seasoning reads the owner`s age', () => {
  /**
   * A $20,000 conversion from a partner-owned IRA into their Roth, then a $10,000 living cost paid
   * from that Roth. The conversion is unseasoned for five years, so the draw on it is exposed to
   * the 10% §72(t) penalty unless the owner is past 59½. The tax on the conversion is zero: $20,000
   * sits inside the couple's 2026 standard deduction.
   */
  const converted = (household: Household) =>
    planFor(household, {
      accounts: {
        partnerIra: {
          ...createIraAccount({ id: 'partnerIra', name: 'Partner IRA', balance: 20000, percentBonds: 0 }),
          owner: 'partner' as const,
        },
        partnerRoth: {
          type: 'rothIra' as const,
          id: 'partnerRoth',
          name: 'Partner Roth',
          balance: 0,
          percentBonds: 0,
          contributionBasis: 0,
          owner: 'partner' as const,
        },
      },
      conversions: [{ id: 'conv-1', fromAccountId: 'partnerIra', toAccountId: 'partnerRoth', amount: 20000, year: 2026 }],
      expenses: livingCost(10000),
    });

  it('penalises a 58-year-old partner`s unseasoned conversion while the primary is 72', () => {
    // Partner born 1968 is 58 in 2026: under 59½, so the draw is exposed. Primary born 1954 is 72,
    // which would clear the rule if it were read. The draw is 10,000 / 0.9 = 11,111.11 (the 10%
    // penalty grosses it up), so the penalty is 10% of that draw.
    const settled = runFirstYear(converted(coupleBorn({ birthYear: 1954 }, { birthYear: 1968 })));
    const exposed = settled.taxes!.incomeSources.earlyWithdrawals.unseasonedConversions ?? 0;

    expect(exposed).toBeCloseTo(10000 / 0.9, -1);
    expect(settled.taxes!.earlyWithdrawalPenalties.taxFreePenaltyAmount).toBeCloseTo(exposed * 0.1, 6);
  });

  it('does not penalise a 72-year-old partner`s unseasoned conversion while the primary is 58', () => {
    // The swap: partner born 1954 is 72 and past 59½; primary born 1968 is 58. The same draw from the
    // partner's Roth is clear of the penalty, so the reading is the owner's, not the primary's.
    const settled = runFirstYear(converted(coupleBorn({ birthYear: 1968 }, { birthYear: 1954 })));

    // The key is left out when there is nothing to report, so absent reads as zero here.
    expect(settled.taxes!.incomeSources.earlyWithdrawals.unseasonedConversions ?? 0).toBe(0);
    expect(settled.taxes!.earlyWithdrawalPenalties.taxFreePenaltyAmount).toBe(0);
    expect(settled.portfolio.perAccountData.partnerRoth!.withdrawals.stocks).toBeCloseTo(10000, 0);
  });
});
