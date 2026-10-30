/**
 * Tax analytics (P3-P6): hand-worked fixtures.
 *
 * Every expected number below is arithmetic on the 2026 ruleset, cited in the comment next to it.
 * Nothing here is a snapshot: if a bracket moves, the test fails with an explanation already
 * written down.
 *
 * The rules 2026 single numbers used throughout:
 *   standard deduction                                  $16,100
 *   ordinary brackets  10% ≤12,400 | 12% ≤50,400 | 22% ≤105,700 | 24% ≤201,775 | 32% ≤256,225 …
 *   long-term gains    0% ≤49,450 | 15% ≤545,500 | 20% above (stacked on ordinary income)
 *   NIIT               3.8% above $200,000 MAGI
 *   Additional Medicare 0.9% above $200,000 of earned income
 *   OASDI 6.2% up to the $184,500 wage base; Medicare 1.45%; California SDI 1.3%
 *   §86 tiers (single) ≤25,000 → 0% | ≤34,000 → 50% | above → 85% of provisional income
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { createZeroAmtData, createZeroIrmaaData } from './__tests__/test-utils';

import type { FilingStatus } from '@/lib/schemas/inputs/tax-settings-form-schema';

import { parseISODateString } from './clock';
import { computeSelfEmploymentTaxes, computeWagePayrollTaxes } from './payroll-taxes';
import { simulate } from './simulate';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import {
  analyzeSimulationTaxYear,
  analyzeTaxYear,
  decomposeNextDollar,
  irmaaCliff,
  type MarginalIncomeType,
  type TaxAnalyticsInput,
} from './tax-analytics';
import type { TaxesData } from './taxes';

const TAX_YEAR = 2026;

interface YearSpec {
  /** Taxable ordinary income *after* adjustments and the standard deduction (the engine's figure). */
  taxableOrdinary: number;
  taxableCapitalGains?: number;
  /** AGI. Defaults to taxable ordinary + taxable gains + the 2026 standard deduction. */
  magi?: number;
  netInvestmentIncome?: number;
  socialSecurityBenefits?: number;
  taxableSocialSecurity?: number;
  provisionalIncome?: number;
  /** The §86 tier the engine resolved for the year; ignored when there is no Social Security. */
  maxTaxablePercentage?: number;
  wages?: number;
  selfEmployment?: number;
  filingStatus?: FilingStatus;
  taxYear?: number;
}

const STANDARD_DEDUCTION_2026 = { single: 16100, marriedFilingJointly: 32200, headOfHousehold: 24150 } as const;

/**
 * Builds the slice of `TaxesData` the analytics reads, with the payroll block computed by the real
 * payroll layer so the fixture cannot disagree with the engine about FICA or SDI. The federal
 * amounts are left at zero on purpose: the analytics recomputes them from the taxable-income
 * composition, and the integration test at the bottom pins that recomputation to a real run.
 */
function makeInput(spec: YearSpec): TaxAnalyticsInput {
  const filingStatus = spec.filingStatus ?? 'single';
  const taxYear = spec.taxYear ?? TAX_YEAR;
  const gains = spec.taxableCapitalGains ?? 0;
  const wages = spec.wages ?? 0;
  const selfEmployment = spec.selfEmployment ?? 0;
  const magi = spec.magi ?? spec.taxableOrdinary + gains + STANDARD_DEDUCTION_2026[filingStatus];

  const wagePayroll = computeWagePayrollTaxes({ wages, filingStatus, taxYear });
  const se = computeSelfEmploymentTaxes({ netEarnings: selfEmployment, wages, filingStatus, taxYear });

  const taxes: TaxesData = {
    federalIncomeTaxes: {
      taxableIncomeTaxedAsOrdinary: spec.taxableOrdinary,
      federalIncomeTaxAmount: 0,
      effectiveFederalIncomeTaxRate: 0,
      topMarginalFederalIncomeTaxRate: 0,
      federalIncomeTaxBrackets: [],
    },
    capitalGainsTaxes: {
      taxableIncomeTaxedAsCapitalGains: gains,
      capitalGainsTaxAmount: 0,
      effectiveCapitalGainsTaxRate: 0,
      topMarginalCapitalGainsTaxRate: 0,
      capitalGainsTaxBrackets: [],
    },
    niit: {
      netInvestmentIncome: spec.netInvestmentIncome ?? 0,
      incomeSubjectToNiit: 0,
      niitAmount: 0,
      threshold: filingStatus === 'marriedFilingJointly' ? 250000 : 200000,
    },
    earlyWithdrawalPenalties: { taxDeferredPenaltyAmount: 0, taxFreePenaltyAmount: 0, totalPenaltyAmount: 0 },
    socialSecurityTaxes: {
      taxableSocialSecurityIncome: spec.taxableSocialSecurity ?? 0,
      maxTaxablePercentage: spec.maxTaxablePercentage ?? 0,
      actualTaxablePercentage: 0,
      provisionalIncome: spec.provisionalIncome ?? 0,
    },
    fica: { wages: wagePayroll, selfEmployment: se, total: wagePayroll.total + se.total },
    incomeSources: {
      realizedGains: 0,
      capitalLossDeduction: 0,
      section121Exclusion: 0,
      taxDeferredWithdrawals: 0,
      taxableRetirementDistributions: 0,
      taxableDividendIncome: 0,
      taxableInterestIncome: 0,
      earnedIncome: wages + selfEmployment,
      socialSecurityIncome: spec.socialSecurityBenefits ?? 0,
      taxableSocialSecurityIncome: spec.taxableSocialSecurity ?? 0,
      maxTaxableSocialSecurityPercentage: spec.maxTaxablePercentage ?? 0,
      provisionalIncome: spec.provisionalIncome ?? 0,
      taxFreeIncome: 0,
      grossIncome: 0,
      incomeTaxedAsOrdinary: 0,
      incomeTaxedAsLtcg: 0,
      taxDeductibleContributions: 0,
      adjustedGrossIncome: magi,
      adjustedIncomeTaxedAsOrdinary: spec.taxableOrdinary,
      adjustedIncomeTaxedAsCapitalGains: gains,
      totalIncome: 0,
      earlyWithdrawals: { rothEarnings: 0, '401kAndIra': 0, hsa: 0 },
    },
    amt: createZeroAmtData(),
    irmaa: createZeroIrmaaData(),
    totalTaxLiability: 0,
    totalTaxesDue: 0,
    totalTaxesRefund: 0,
    totalTaxableIncome: spec.taxableOrdinary + gains,
    adjustments: { selfEmploymentTaxDeduction: se.halfDeduction },
    deductions: { standardDeduction: STANDARD_DEDUCTION_2026[filingStatus] },
  };

  return { taxYear, filingStatus, taxes, earnedIncome: { wages, selfEmployment } };
}

const lineOf = (decomposition: ReturnType<typeof decomposeNextDollar>, id: string) =>
  decomposition.lines.find((line) => line.id === id)?.delta ?? 0;

describe('bracket fill and conversion headroom (one computation, two views)', () => {
  it('prices the next dollar at the rate the *next* dollar pays, either side of a boundary', () => {
    // 2026 single: the 12% bracket covers 12,400–50,400, so 50,400 is the first dollar of the 22%
    // bracket. The year's last dollar was taxed at 12%; the next one pays 22%.
    const justBelow = analyzeTaxYear(makeInput({ taxableOrdinary: 50399 }));
    const atBoundary = analyzeTaxYear(makeInput({ taxableOrdinary: 50400 }));

    expect(justBelow.bracketFill.ordinary.nextDollarRate).toBe(0.12);
    expect(atBoundary.bracketFill.ordinary.nextDollarRate).toBe(0.22);

    // …and the marginal rate follows the same rule, because it is measured on the next dollar.
    expect(justBelow.marginalRates.ordinary.rate).toBeCloseTo(0.12, 10);
    expect(atBoundary.marginalRates.ordinary.rate).toBeCloseTo(0.22, 10);

    // The capacity view: one dollar below the boundary there is $1 of 12% room; at the boundary the
    // remaining room belongs to the 22% bracket, which ends at 105,700 → 105,700 − 50,400.
    expect(justBelow.conversionHeadroom.nextBracket).toEqual({ rate: 0.22, headroom: 1, upToTaxableIncome: 50400 });
    expect(atBoundary.conversionHeadroom.nextBracket).toEqual({ rate: 0.24, headroom: 55300, upToTaxableIncome: 105700 });
  });

  it('fills every bracket row from the table, and the rows agree with the headroom', () => {
    // 60,000 of taxable ordinary income, single:
    //   10% row: 12,400 of 12,400 filled, nothing left
    //   12% row: 50,400 − 12,400 = 38,000 filled, nothing left
    //   22% row: 60,000 − 50,400 =  9,600 filled, 105,700 − 60,000 = 45,700 left
    //   24% row: nothing filled, the whole 201,775 − 105,700 = 96,075 left
    const analytics = analyzeTaxYear(makeInput({ taxableOrdinary: 60000 }));
    const rows = analytics.bracketFill.ordinary.brackets;

    expect(rows.map((row) => row.rate)).toEqual([0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37]);
    expect(rows[0]).toMatchObject({ taxableInBracket: 12400, remainingInBracket: 0, shareFilled: 1 });
    expect(rows[1]).toMatchObject({ taxableInBracket: 38000, remainingInBracket: 0, shareFilled: 1 });
    expect(rows[2]).toMatchObject({ taxableInBracket: 9600, remainingInBracket: 45700 });
    expect(rows[3]).toMatchObject({ taxableInBracket: 0, remainingInBracket: 96075 });
    expect(rows[6].remainingInBracket).toBeNull();

    // The same computation viewed as capacity, and it lands exactly on the table's boundary.
    const nextBracket = analytics.conversionHeadroom.nextBracket;
    expect(nextBracket).toEqual({ rate: 0.24, headroom: 45700, upToTaxableIncome: 105700 });
    expect(analytics.bracketFill.ordinary.taxableIncome + (nextBracket?.headroom ?? 0)).toBe(105700);

    // At that boundary the next dollar really is 24%, so the headroom is not off by one.
    const atBoundary = analyzeTaxYear(makeInput({ taxableOrdinary: 105700 }));
    expect(atBoundary.bracketFill.ordinary.nextDollarRate).toBe(0.24);
  });

  it('reports the targets above the current rate, and nothing in the top bracket', () => {
    // 200,000 is inside the 24% bracket, so the targets are the rates *above* today's, and the
    // first of them is reached at 201,775: 201,775 − 200,000 = 1,775 away.
    const analytics = analyzeTaxYear(makeInput({ taxableOrdinary: 200000 }));
    expect(analytics.bracketFill.ordinary.nextDollarRate).toBe(0.24);
    expect(analytics.conversionHeadroom.targets.map((target) => target.rate)).toEqual([0.32, 0.35, 0.37]);
    expect(analytics.conversionHeadroom.nextBracket).toEqual({ rate: 0.32, headroom: 1775, upToTaxableIncome: 201775 });

    const top = analyzeTaxYear(makeInput({ taxableOrdinary: 700000 }));
    expect(top.bracketFill.ordinary.nextDollarRate).toBe(0.37);
    expect(top.conversionHeadroom.nextBracket).toBeNull();
    expect(top.conversionHeadroom.targets).toEqual([]);
  });

  it('fills the capital-gains schedule by stacking it on ordinary income', () => {
    // 2026 single, ordinary 60,000 and 30,000 of gains: the 0% gains band ends at 49,450 of total
    // income, which the ordinary income already passes, so all 30,000 gains are taxed at 15%.
    const analytics = analyzeTaxYear(makeInput({ taxableOrdinary: 60000, taxableCapitalGains: 30000 }));
    const rows = analytics.bracketFill.capitalGains.brackets;

    expect(rows.map((row) => row.rate)).toEqual([0, 0.15, 0.2]);
    expect(rows[0].taxableInBracket).toBe(0);
    expect(rows[1].taxableInBracket).toBe(30000);
    expect(analytics.bracketFill.capitalGains.nextDollarRate).toBe(0.15);
    expect(analytics.bracketFill.capitalGains.stackedOnOrdinaryIncome).toBe(60000);
    expect(analytics.baseline.find((line) => line.id === 'federalCapitalGainsTax')?.amount).toBeCloseTo(4500);
  });
});

describe('next-dollar decomposition', () => {
  it('breaks $1,000 of ordinary income into its parts, and the parts sum to the total', () => {
    // 2026 single, ordinary 143,900 (24% bracket), 45,000 of gains (all at 15%, because the gains
    // start above the 49,450 zero-rate band), MAGI 205,000 with 205,000 of net investment income.
    // Adding 1,000 of ordinary income (interest — not a gain):
    //   federal ordinary tax: 1,000 × 24%                       = $240.00
    //   NIIT:   MAGI 205,000 → 206,000 over the 200,000 threshold; subject amount 5,000 → 6,000
    //           min(NII 205,000, 6,000) × 3.8% = 228.00, was 190.00 → Δ $38.00
    //   gains tax: unchanged — the gains are already at 15% and stack above the ordinary income
    //   total                                                     = $278.00 = 27.8% of 1,000
    const input = makeInput({
      taxableOrdinary: 143900,
      taxableCapitalGains: 45000,
      magi: 205000,
      netInvestmentIncome: 205000,
    });

    // The baseline first, hand-worked from the bracket table:
    //   10%  × 12,400                        =  1,240
    //   12%  × (50,400 − 12,400)   = 38,000  =  4,560
    //   22%  × (105,700 − 50,400)  = 55,300  = 12,166
    //   24%  × (143,900 − 105,700) = 38,200  =  9,168
    //                                    total 27,134; gains 45,000 × 15% = 6,750; NIIT 190
    const analytics = analyzeTaxYear(input);
    expect(analytics.baseline.find((line) => line.id === 'federalOrdinaryIncomeTax')?.amount).toBeCloseTo(27134);
    expect(analytics.baseline.find((line) => line.id === 'federalCapitalGainsTax')?.amount).toBeCloseTo(6750);
    expect(analytics.baseline.find((line) => line.id === 'niit')?.amount).toBeCloseTo(190);

    const decomposition = decomposeNextDollar(input, { incomeType: 'ordinary', amount: 1000 });

    expect(lineOf(decomposition, 'federalOrdinaryIncomeTax')).toBeCloseTo(240);
    expect(lineOf(decomposition, 'niit')).toBeCloseTo(38);
    expect(lineOf(decomposition, 'federalCapitalGainsTax')).toBe(0);
    expect(decomposition.totalDelta).toBeCloseTo(278);
    expect(decomposition.marginalRate).toBeCloseTo(0.278, 10);
    expect(decomposition.taxableOrdinaryIncomeDelta).toBeCloseTo(1000);
    expect(decomposition.magiDelta).toBeCloseTo(1000);

    // The invariant: the parts are the total, not a separate formula that could disagree.
    expect(decomposition.lines.reduce((total, line) => total + line.delta, 0)).toBeCloseTo(decomposition.totalDelta);
  });

  it('prices a wage dollar with the payroll lines, and tags the California one', () => {
    // 2026 single, 100,000 of wages, taxable 83,900 (22% bracket), MAGI 100,000.
    //   1,000 of wages: federal 1,000 × 22%              = $220.00
    //                   OASDI 1,000 × 6.2%               =  $62.00  (base has room: 100k < 184.5k)
    //                   Medicare 1,000 × 1.45%           =  $14.50
    //                   Additional Medicare              =   $0.00  (below 200,000)
    //                   California SDI 1,000 × 1.3%      =  $13.00
    //                   total                            = $309.50 = 30.95%
    const input = makeInput({ taxableOrdinary: 83900, magi: 100000, wages: 100000 });
    const decomposition = decomposeNextDollar(input, { incomeType: 'wage', amount: 1000 });

    expect(lineOf(decomposition, 'federalOrdinaryIncomeTax')).toBeCloseTo(220);
    expect(lineOf(decomposition, 'payrollSocialSecurity')).toBeCloseTo(62);
    expect(lineOf(decomposition, 'payrollMedicare')).toBeCloseTo(14.5);
    expect(lineOf(decomposition, 'payrollAdditionalMedicare')).toBe(0);
    expect(lineOf(decomposition, 'payrollStateDisability')).toBeCloseTo(13);
    expect(decomposition.totalDelta).toBeCloseTo(309.5);
    expect(decomposition.marginalRate).toBeCloseTo(0.3095, 10);

    expect(decomposition.lines.find((line) => line.id === 'payrollStateDisability')?.jurisdiction).toBe('CA');
    expect(analyzeTaxYear(input).marginalRates.wage.rate).toBeCloseTo(0.3095, 10);
  });

  it('drops OASDI and starts Additional Medicare above the wage base and the $200,000 threshold', () => {
    // 200,000 of wages, single: the OASDI base (184,500) is full, and the threshold is reached.
    //   1,000 more: federal 1,000 × 24% (taxable 183,900) = $240.00
    //               OASDI                               =   $0.00
    //               Medicare 1,000 × 1.45%              =  $14.50
    //               Additional Medicare 1,000 × 0.9%    =   $9.00
    //               SDI 1,000 × 1.3%                    =  $13.00
    //               total                               = $276.50
    const input = makeInput({ taxableOrdinary: 183900, magi: 200000, wages: 200000 });
    const decomposition = decomposeNextDollar(input, { incomeType: 'wage', amount: 1000 });

    expect(lineOf(decomposition, 'payrollSocialSecurity')).toBe(0);
    expect(lineOf(decomposition, 'payrollAdditionalMedicare')).toBeCloseTo(9);
    expect(lineOf(decomposition, 'federalOrdinaryIncomeTax')).toBeCloseTo(240);
    expect(decomposition.totalDelta).toBeCloseTo(276.5);
  });

  it('charges self-employment income its SE tax and deducts half of the extra tax', () => {
    // No wages, 100,000 of net SE earnings (base 92.35%), taxable ordinary income 20,000 (12%).
    //   +1,000 of SE earnings:
    //     SE base grows by 1,000 × 92.35%                        =   $923.50
    //     SE tax    923.50 × 15.3%                              =   $141.2955
    //     half of that is a new above-the-line deduction        =    $70.64775
    //     taxable ordinary income: +1,000 (the earnings) − 70.64775 (the deduction)
    //                                                          =   $929.35225
    //     federal income tax 929.35225 × 12%                    =   $111.52227
    //     total                                                 =   $252.81777 = 25.28%
    const input = makeInput({ taxableOrdinary: 20000, magi: 43100, selfEmployment: 100000 });
    const decomposition = decomposeNextDollar(input, { incomeType: 'selfEmployment', amount: 1000 });

    expect(lineOf(decomposition, 'selfEmploymentTax')).toBeCloseTo(141.2955);
    expect(lineOf(decomposition, 'federalOrdinaryIncomeTax')).toBeCloseTo(111.52227, 4);
    expect(decomposition.totalDelta).toBeCloseTo(252.81777, 4);
    expect(decomposition.marginalRate).toBeCloseTo(0.25281777, 6);
    // The half deduction is visible in the base, not just in the tax.
    expect(decomposition.taxableOrdinaryIncomeDelta).toBeCloseTo(1000 - 70.64775);
  });

  it('prices gains and qualified dividends at the capital-gains rate plus NIIT', () => {
    // 2026 single: ordinary 60,000, no gains, all of MAGI taxable, above the $200,000 threshold.
    //   1,000 of long-term gain: it stacks above 60,000, inside the 15% band (49,450–545,500)
    //                            = $150.00, plus NIIT 1,000 × 3.8% = $38.00 (NII and MAGI both
    //                            rise, subject amount is the lesser: both are 1,000)
    const input = makeInput({
      taxableOrdinary: 60000,
      magi: 250000,
      netInvestmentIncome: 30000,
    });
    const gains = decomposeNextDollar(input, { incomeType: 'longTermCapitalGain', amount: 1000 });
    expect(lineOf(gains, 'federalCapitalGainsTax')).toBeCloseTo(150);
    expect(lineOf(gains, 'niit')).toBeCloseTo(38);
    expect(gains.totalDelta).toBeCloseTo(188);
    expect(gains.marginalRate).toBeCloseTo(0.188, 10);

    // A qualified dividend behaves the same way in this engine.
    const dividends = decomposeNextDollar(input, { incomeType: 'qualifiedDividend', amount: 1000 });
    expect(dividends.totalDelta).toBeCloseTo(gains.totalDelta);
  });

  it('multiplies the ordinary rate by the §86 phase-in for Social Security income', () => {
    // 2026 single, $20,000 of benefits, $30,000 of other income:
    //   provisional income = 30,000 + 10,000 = 40,000 → top tier (85%)
    //   taxable benefits   = min((40,000 − 34,000) × 85%, 20,000 × 85%) = min(5,100, 17,000) = 5,100
    //   taxable ordinary   = 30,000 + 5,100 − 16,100 = 19,000 → 12% bracket
    //
    // Adding $1,000 of ordinary income raises provisional income by 1,000, which makes another
    // 850 of benefits taxable (85% × 1,000; capacity is 17,000 − 5,100 = 11,900, so it is not
    // capped): taxable income +1,850, tax +1,850 × 12% = $222.00 → a 22.2% marginal rate.
    const input = makeInput({
      taxableOrdinary: 19000,
      magi: 30600, // 30,000 + 5,100 taxable benefits − nothing else
      socialSecurityBenefits: 20000,
      taxableSocialSecurity: 5100,
      provisionalIncome: 40000,
      maxTaxablePercentage: 0.85,
    });

    const decomposition = decomposeNextDollar(input, { incomeType: 'ordinary', amount: 1000 });
    expect(decomposition.taxableOrdinaryIncomeDelta).toBeCloseTo(1850);
    expect(decomposition.totalDelta).toBeCloseTo(222);
    expect(decomposition.marginalRate).toBeCloseTo(0.222, 10);

    // A Social Security dollar is not ordinary income: it raises provisional income by only 50
    // cents, which pulls in 0.5 × 0.85 = 0.425 of taxable benefit per dollar of benefit.
    //   1,000 × 0.425 = $425 of taxable income → 425 × 12% = $51.00, i.e. 5.1% of the benefit.
    const ss = decomposeNextDollar(input, { incomeType: 'socialSecurity', amount: 1000 });
    expect(ss.taxableOrdinaryIncomeDelta).toBeCloseTo(425);
    expect(ss.totalDelta).toBeCloseTo(51);
  });

  it('charges nothing on tax-exempt income', () => {
    const input = makeInput({ taxableOrdinary: 60000, magi: 76100 });
    const decomposition = decomposeNextDollar(input, { incomeType: 'taxExempt', amount: 1000 });
    expect(decomposition.lines).toEqual([]);
    expect(decomposition.totalDelta).toBe(0);
    expect(decomposition.marginalRate).toBe(0);
  });

  it('rejects a negative amount instead of pretending it is a marginal rate', () => {
    expect(() => decomposeNextDollar(makeInput({ taxableOrdinary: 1000 }), { incomeType: 'ordinary', amount: -1 })).toThrow(/non-negative/);
  });
});

describe('marginal rates by income type', () => {
  it('reports every supported type with lines that add up to the rate', () => {
    const analytics = analyzeTaxYear(makeInput({ taxableOrdinary: 60000, magi: 76100 }));
    const types: MarginalIncomeType[] = [
      'ordinary',
      'taxDeferredWithdrawal',
      'rothConversion',
      'wage',
      'selfEmployment',
      'longTermCapitalGain',
      'qualifiedDividend',
      'socialSecurity',
      'taxExempt',
    ];

    expect(Object.keys(analytics.marginalRates).sort()).toEqual([...types].sort());
    for (const type of types) {
      const rate = analytics.marginalRates[type];
      expect(rate.incomeType).toBe(type);
      expect(rate.lines.reduce((total, line) => total + line.rate, 0)).toBeCloseTo(rate.rate, 10);
    }

    // With no gift of investment income, an ordinary dollar pays the bracket rate, and a Roth
    // conversion costs the same as a distribution: 22% (60,000 is inside 50,400–105,700). These
    // three coincide today and diverge once P3-P5 adds pro-rata basis.
    expect(analytics.marginalRates.ordinary.rate).toBeCloseTo(0.22, 10);
    expect(analytics.marginalRates.rothConversion.rate).toBeCloseTo(0.22, 10);
    expect(analytics.marginalRates.taxDeferredWithdrawal.rate).toBeCloseTo(0.22, 10);
    // A marginal wage dollar is a *new* wage dollar, so it carries payroll whether or not the year
    // already has wages: 22% + 6.2% OASDI + 1.45% Medicare + 1.3% SDI = 30.95%.
    expect(analytics.marginalRates.wage.rate).toBeCloseTo(0.3095, 10);
    // Gains start at the 15% band here (60,000 of ordinary income is past the 49,450 zero band).
    expect(analytics.marginalRates.longTermCapitalGain.rate).toBeCloseTo(0.15, 10);
  });
});

describe('cliffs', () => {
  it('finds the Part B IRMAA cliff below and above the first threshold', () => {
    // CMS 2026: standard Part B premium $202.90/month. Tier 1 starts above $109,000 of MAGI and adds
    // $81.20 Part B + $14.50 Part D a month = $95.70, or $1,148.40 a year.
    const below = irmaaCliff({ magi: 108000, taxYear: TAX_YEAR, filingStatus: 'single' });
    expect(below.tier.tier).toBe(0);
    expect(below.tier.monthlyPremium).toBeCloseTo(202.9);
    expect(below.tier.annualSurcharge).toBe(0);
    expect(below.headroomToNextTier).toBe(1000);
    expect(below.nextTier?.monthlyPremium).toBeCloseTo(284.1);
    // One dollar past the threshold costs $1,148.40 a year: (81.20 + 14.50) × 12.
    expect(below.nextTier?.stepUp).toBeCloseTo(1148.4);

    const above = irmaaCliff({ magi: 110000, taxYear: TAX_YEAR, filingStatus: 'single' });
    expect(above.tier.tier).toBe(1);
    expect(above.tier.monthlyAdjustment).toBeCloseTo(81.2);
    expect(above.tier.partDMonthly).toBeCloseTo(14.5);
    expect(above.tier.annualSurcharge).toBeCloseTo(1148.4);
    // 137,000 − 110,000 = 27,000 of room before the next tier.
    expect(above.headroomToNextTier).toBe(27000);
    // Tier 2 is $202.90 Part B + $37.50 Part D = $240.40 a month, so crossing costs
    // (240.40 − 95.70) × 12 = $1,736.40 more.
    expect(above.nextTier?.monthlyPremium).toBeCloseTo(405.8);
    expect(above.nextTier?.stepUp).toBeCloseTo(1736.4);

    // Joint filers double the thresholds: $220,000 is already inside tier 1.
    const joint = irmaaCliff({ magi: 220000, taxYear: TAX_YEAR, filingStatus: 'marriedFilingJointly' });
    expect(joint.tier.tier).toBe(1);
    expect(joint.headroomToNextTier).toBe(54000);
  });

  it('uses the two-year lookback for premiums charged this year, and says when it cannot', () => {
    // MAGI 108,000 in 2024 charges the standard premium in 2026; the 2026 MAGI projects the 2028
    // premium. The 2024 MAGI is inside tier 0, so nothing is surcharged in 2026.
    const charged = analyzeTaxYear({
      ...makeInput({ taxableOrdinary: 60000, magi: 110000, taxYear: 2026 }),
      priorYearMagi: { taxYear: 2024, magi: 108000 },
    });
    expect(charged.cliffs.irmaa.premiumYear).toBe(2028);
    expect(charged.cliffs.irmaa.projected.tier.tier).toBe(1); // 110,000 in the 2026 column
    expect(charged.cliffs.irmaa.charged?.tier).toBe(0); // 108,000, from 2024
    expect(charged.cliffs.irmaa.charged?.magiTaxYear).toBe(2024);
    expect(charged.cliffs.irmaa.unavailable).toBeNull();

    // No lookback year: the analytics says so rather than borrowing the current MAGI.
    const missing = analyzeTaxYear(makeInput({ taxableOrdinary: 60000, magi: 110000 }));
    expect(missing.cliffs.irmaa.charged).toBeNull();
    expect(missing.cliffs.irmaa.unavailable).toMatch(/no MAGI for 2024/);

    // A year that is not exactly two back is refused, too.
    const wrongYear = analyzeTaxYear({
      ...makeInput({ taxableOrdinary: 60000, magi: 110000 }),
      priorYearMagi: { taxYear: 2025, magi: 108000 },
    });
    expect(wrongYear.cliffs.irmaa.charged).toBeNull();
    expect(wrongYear.cliffs.irmaa.unavailable).toMatch(/exactly two years earlier/);
  });

  it('reports NIIT and Additional Medicare headroom from the ruleset', () => {
    const input = makeInput({ taxableOrdinary: 143900, magi: 205000, netInvestmentIncome: 205000, wages: 190000 });
    const analytics = analyzeTaxYear(input);

    // Already over the NIIT threshold: 0 of headroom, 3.8% of the next investment dollar.
    expect(analytics.cliffs.niit).toMatchObject({ threshold: 200000, current: 205000, headroom: 0 });
    expect(analytics.cliffs.niit.costOfCrossing).toBeCloseTo(0.038);
    // Earned income is 190,000, so $10,000 fits before the Additional Medicare Tax starts.
    expect(analytics.cliffs.additionalMedicare).toMatchObject({ threshold: 200000, current: 190000, headroom: 10000 });
    expect(analytics.cliffs.additionalMedicare.costOfCrossing).toBeCloseTo(0.009);
  });

  it('marks the ACA cliff and the California return as not computed, with the reason', () => {
    const analytics = analyzeTaxYear(makeInput({ taxableOrdinary: 60000, magi: 76100 }));

    expect(analytics.cliffs.aca.supported).toBe(false);
    expect(analytics.cliffs.aca.prerequisites).toHaveLength(4);
    expect(analytics.cliffs.aca.prerequisites.join(' ')).toMatch(/SLCSP/);

    expect(analytics.jurisdictions.federal.supported).toBe(true);
    expect(analytics.jurisdictions.california).toMatchObject({ supported: false, pending: 'P3-P8' });
    // The one California number the engine has today is the SDI payroll line.
    expect(analytics.jurisdictions.california.available.stateDisability).toBe(0);

    const withWages = analyzeTaxYear(makeInput({ taxableOrdinary: 83900, magi: 100000, wages: 100000 }));
    // 100,000 × 1.3% = $1,300 of SDI.
    expect(withWages.jurisdictions.california.available.stateDisability).toBeCloseTo(1300);

    expect(analytics.notComputed.join(' ')).toMatch(/California income tax/);
    expect(analytics.notComputed.join(' ')).toMatch(/P3-P8/);
  });

  it('refuses a year the ruleset does not cover', () => {
    // The table now lives in the ruleset, so the resolver's own error is the guard.
    expect(() => irmaaCliff({ magi: 100000, taxYear: 2025, filingStatus: 'single' })).toThrow(/No federal tax ruleset for 2025/);
  });
});

// ============================================================================
// Engine equivalence: the recomputation must agree with what the engine charged
// ============================================================================

const repoRoot = process.cwd();
const goldenFixtureSource = readFileSync(join(repoRoot, 'src/lib/calc/__tests__/golden/fixtures.ts'), 'utf8');
// The golden fixtures are the plans the corpus is frozen on; reusing `steady-saver` here means the
// analytics is checked against a plan the corpus already trusts.
expect(goldenFixtureSource).toContain('steady-saver');

const steadySaver: SimulatorInputs = {
  timeline: {
    birthMonth: 6,
    birthYear: 1985,
    lifeExpectancy: 45,
    retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
  },
  incomes: {
    salary: {
      id: 'salary',
      name: 'Salary',
      amount: 110000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
      taxes: { incomeType: 'wage', withholding: 22 },
    },
  },
  accounts: { brokerage: { id: 'brokerage', name: 'Brokerage', type: 'taxableBrokerage', balance: 250000, percentBonds: 30 } },
  expenses: {
    living: {
      id: 'living',
      name: 'Living Expenses',
      amount: 55000,
      frequency: 'yearly',
      timeframe: { start: { type: 'now' }, end: { type: 'atLifeExpectancy' } },
    },
  },
  debts: {},
  physicalAssets: {},
  contributionRules: {},
  baseContributionRule: { type: 'save' },
  marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
  taxSettings: { filingStatus: 'single' },
  privacySettings: { isPrivate: true },
  simulationSettings: { simulationSeed: 1, simulationMode: 'fixedReturns' },
};

describe('engine equivalence', () => {
  const outcome = simulate(steadySaver, { mode: 'fixedReturns', seed: 1, asOf: '2026-03-15' });
  const data = outcome.result.data;

  it('reproduces the engine’s own federal lines from the settled tax base', () => {
    const analytics = analyzeSimulationTaxYear({ data, index: 1, filingStatus: 'single' });
    const taxes = data[1].taxes!;

    const line = (id: string) => analytics.baseline.find((entry) => entry.id === id)?.amount ?? 0;

    expect(line('federalOrdinaryIncomeTax')).toBeCloseTo(taxes.federalIncomeTaxes.federalIncomeTaxAmount, 6);
    expect(line('federalCapitalGainsTax')).toBeCloseTo(taxes.capitalGainsTaxes.capitalGainsTaxAmount, 6);
    expect(line('niit')).toBeCloseTo(taxes.niit.niitAmount, 6);
    // OASDI, Medicare and the SE tax are statutory, so they agree in every year.
    expect(line('payrollSocialSecurity')).toBeCloseTo(taxes.fica.wages.socialSecurity, 6);
    expect(line('payrollMedicare')).toBeCloseTo(taxes.fica.wages.medicare, 6);
    expect(line('payrollAdditionalMedicare')).toBeCloseTo(taxes.fica.wages.additionalMedicare, 6);
    expect(line('selfEmploymentTax')).toBeCloseTo(taxes.fica.selfEmployment.total, 6);

    // SDI is the one line whose *rate* moves by year, so it is the line that proves the payroll and
    // income-tax tables agree. The row dates from 2027, and both sides withhold 2027's 1.4% — the
    // alignment fix removed the one-year lag that once had this settlement withholding 2026's 1.3%.
    const engineWages = data[1].incomes!.totalWageIncome;
    expect(taxes.fica.wages.stateDisability).toBeCloseTo(engineWages * 0.014, 6);
    expect(line('payrollStateDisability')).toBeCloseTo(taxes.fica.wages.stateDisability, 6);
    expect(line('payrollStateDisability')).not.toBeCloseTo(engineWages * 0.013, 6);

    // `reported` is the engine's own figure, copied rather than recomputed.
    expect(analytics.reported).toMatchObject({
      federalIncomeTax: taxes.federalIncomeTaxes.federalIncomeTaxAmount,
      capitalGainsTax: taxes.capitalGainsTaxes.capitalGainsTaxAmount,
      niit: taxes.niit.niitAmount,
      payrollTaxes: taxes.fica.total,
      totalTaxLiability: taxes.totalTaxLiability,
    });
  });

  it('agrees with the engine on every payroll line in a later settlement too', () => {
    const analytics = analyzeSimulationTaxYear({ data, index: 2, filingStatus: 'single' });
    const taxes = data[2].taxes!;
    const line = (id: string) => analytics.baseline.find((entry) => entry.id === id)?.amount ?? 0;

    expect(line('payrollSocialSecurity')).toBeCloseTo(taxes.fica.wages.socialSecurity, 6);
    expect(line('payrollMedicare')).toBeCloseTo(taxes.fica.wages.medicare, 6);
    expect(line('payrollAdditionalMedicare')).toBeCloseTo(taxes.fica.wages.additionalMedicare, 6);
    expect(line('payrollStateDisability')).toBeCloseTo(taxes.fica.wages.stateDisability, 6);
    expect(taxes.fica.wages.stateDisability).toBeCloseTo(data[2].incomes!.totalWageIncome * 0.014, 6);
  });

  it('resolves the tax year from the row, and the IRMAA lookback from two rows earlier', () => {
    const third = analyzeSimulationTaxYear({ data, index: 3, filingStatus: 'single' });
    const rowYear = parseISODateString(data[3].date).year;
    const lookbackRow = data[1];

    expect(third.taxYear).toBe(rowYear);
    expect(third.cliffs.irmaa.charged).not.toBeNull();
    expect(third.cliffs.irmaa.charged?.magi).toBeCloseTo(lookbackRow.taxes!.incomeSources.adjustedGrossIncome, 6);
    expect(third.cliffs.irmaa.charged?.magiTaxYear).toBe(third.taxYear - 2);

    // The first two rows have no lookback year in the result; that is reported, not guessed.
    for (const index of [1, 2]) {
      const analytics = analyzeSimulationTaxYear({ data, index, filingStatus: 'single' });
      expect(analytics.cliffs.irmaa.charged).toBeNull();
      expect(analytics.cliffs.irmaa.unavailable).toMatch(/no MAGI for/);
    }

    // Row 0 is the initial state: it has no settled tax result and must be refused by name.
    expect(() => analyzeSimulationTaxYear({ data, index: 0, filingStatus: 'single' })).toThrow(/no settled tax result/);
  });

  it('is deterministic: the same row analysed twice is deep-equal', () => {
    const first = analyzeSimulationTaxYear({ data, index: 2, filingStatus: 'single' });
    const second = analyzeSimulationTaxYear({ data, index: 2, filingStatus: 'single' });
    expect(first).toStrictEqual(second);

    // And it does not read a clock: the same year from a bare input gives the same rates.
    const bare = analyzeTaxYear({
      taxYear: first.taxYear,
      filingStatus: 'single',
      taxes: data[2].taxes!,
      earnedIncome: { wages: data[2].incomes!.totalWageIncome, selfEmployment: data[2].incomes!.totalSelfEmploymentIncome },
    });
    expect(bare.marginalRates).toStrictEqual(first.marginalRates);
    expect(bare.bracketFill).toStrictEqual(first.bracketFill);
  });
});
