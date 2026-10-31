import { describe, expect, it } from 'vitest';

import {
  EARLY_DISTRIBUTION_PENALTY_RATE,
  earlyDistributionPenalty,
  maximumSeppInterestRate,
  seppAnnualAmount,
  seppAnnualAmountFromTables,
  seppAnnuityFactors,
  seppMustContinueUntil,
  seppRateWindow,
} from './sepp';

/**
 * SEPP / §72(t) (IRC §72(t)(2)(A)(iv); IRS Notice 2022-6).
 *
 * The three methods, on the same $500,000 balance at a 5 % rate over the 20-year period the
 * single-life table gives a 65-year-old:
 *
 *   annuity factor  a(n) = (1 − 1.05^−20) / 0.05 = 12.462210342539992
 *   annuity-due     ä(n) = a(n) × 1.05        = 13.085320859666991
 *
 *   RMD             500,000 / 20                    = $25,000.00
 *   fixed amortisation  500,000 × 0.05 / (1 − 1.05^−20)
 *                     = 25,000 / 0.623110511…      = $40,121.29
 *   fixed annuitisation 500,000 / 13.085320859…     = $38,210.76
 *
 * The spread is the point: annuitisation is one period earlier than amortisation, and the RMD
 * method never amortises at all.
 */

const yearly = (method: 'rmd' | 'fixedAmortization' | 'fixedAnnuitization', balance: number, rate: number, period: number) =>
  seppAnnualAmount({ method, balance, rate, distributionPeriod: period });

describe('the maximum rate Notice 2022-6 allows', () => {
  it('is the greater of 5 % and 120 % of the mid-term rate', () => {
    // 120 % × 4 % = 4.8 %, below the floor → 5 %.
    expect(maximumSeppInterestRate(0.04)).toBeCloseTo(0.05, 12);
    // 120 % × 5 % = 6 %, above the floor → 6 %.
    expect(maximumSeppInterestRate(0.05)).toBeCloseTo(0.06, 12);
    // 120 % × 4.55 % = 5.46 %.
    expect(maximumSeppInterestRate(0.0455)).toBeCloseTo(0.0546, 12);
    // A negative mid-term rate cannot pull the cap below the 5 % floor.
    expect(maximumSeppInterestRate(-0.02)).toBeCloseTo(0.05, 12);
  });
});

describe('the three methods', () => {
  it('RMD method: balance ÷ life expectancy', () => {
    // 500,000 / 20 = 25,000. Notice 2022-6 §III.A: recomputed each year from that year's balance.
    expect(yearly('rmd', 500_000, 0.05, 20)).toBeCloseTo(25_000, 10);
  });

  it('fixed amortisation: the ordinary-annuity level payment', () => {
    // 500,000 × 0.05 / (1 − 1.05^−20) = 25,000 / 0.6231105109… = 40,121.29359534564
    expect(yearly('fixedAmortization', 500_000, 0.05, 20)).toBeCloseTo(40_121.29359534564, 6);
  });

  it('fixed annuitisation: balance ÷ the annuity-due factor', () => {
    // 500,000 / 13.085320859666991 = 38,210.75580509109
    expect(yearly('fixedAnnuitization', 500_000, 0.05, 20)).toBeCloseTo(38_210.75580509109, 6);
  });

  it('keeps the methods distinct on a second balance and rate', () => {
    // 250,000 at 4 % over 25 years:
    //   a(25) = (1 − 1.04^−25) / 0.04 = 15.622079…;  ä = 16.246962…
    //   amortisation = 250,000 × 0.04 / (1 − 1.04^−25) = 16,002.990696613646
    //   annuitisation = 250,000 / 16.246962…           = 15,387.4910544362
    expect(yearly('fixedAmortization', 250_000, 0.04, 25)).toBeCloseTo(16_002.990696613646, 6);
    expect(yearly('fixedAnnuitization', 250_000, 0.04, 25)).toBeCloseTo(15_387.4910544362, 6);
    expect(yearly('fixedAmortization', 250_000, 0.04, 25)).toBeGreaterThan(yearly('fixedAnnuitization', 250_000, 0.04, 25));
  });

  it('degenerates every method to balance ÷ years at a zero rate', () => {
    // With no growth nothing compounds: spreading 240,000 over 30 years is 8,000 a year, whichever
    // formula the method uses.
    for (const method of ['rmd', 'fixedAmortization', 'fixedAnnuitization'] as const) {
      expect(yearly(method, 240_000, 0, 30)).toBeCloseTo(8_000, 10);
    }
  });

  it('rejects a distribution period that is not a positive number of years', () => {
    expect(() => yearly('rmd', 100_000, 0.05, 0)).toThrow(/at least one year/);
    expect(() => yearly('fixedAmortization', 100_000, 0.05, -5)).toThrow(/at least one year/);
  });

  it('exposes the annuity factors the fixed methods divide by', () => {
    // a(20) at 5 % = (1 − 1.05^−20) / 0.05 = 12.462210342539992; ä = 13.085320859666991.
    const factors = seppAnnuityFactors(0.05, 20);

    expect(factors.ordinary).toBeCloseTo(12.462210342539992, 10);
    expect(factors.due).toBeCloseTo(13.085320859666991, 10);
    expect(factors.due / factors.ordinary).toBeCloseTo(1.05, 12);
  });
});

describe('priced from the vendored tables', () => {
  it('resolves the Single Life Table period and the rate cap for the month payments begin', () => {
    // Age 65 is 22.9 years in Table 1 to §1.401(a)(9)-9(b). Payments beginning in November 2026 may
    // use the mid-term rate for October 2026 (4.61 %, Rev. Rul. 2026-19) or September 2026 (4.49 %,
    // Rev. Rul. 2026-17): 120 % of 4.61 % = 5.532 %, which beats the 5 % floor.
    const result = seppAnnualAmountFromTables({
      method: 'fixedAmortization',
      balance: 500_000,
      age: 65,
      firstDistributionMonth: '2026-11',
    });

    expect(result.distributionPeriod).toBe(22.9);
    expect(result.maximumRate).toBeCloseTo(0.05532, 12);
    expect(result.rate).toBeCloseTo(0.05532, 12);
    expect(result.rateWindow.eligibleMonths.map((entry) => entry.month)).toStrictEqual(['2026-10', '2026-09']);
    expect(result.rateWindow.eligibleMonths[0]).toStrictEqual({
      month: '2026-10',
      federalMidTermRate: 0.0461,
      maximumRate: 0.05532,
    });
    expect(result.rateWindow.eligibleMonths[1]?.maximumRate).toBeCloseTo(0.05388, 12);
  });

  it('gives each method its hand-worked amount at the cap', () => {
    // 500,000 over 22.9 years at 5.532 %:
    //   a(22.9)  = (1 − 1.05532^−22.9) / 0.05532 = 12.808953105260315
    //   ä(22.9)  = a × 1.05532                    = 13.517544391043316
    //   RMD             500,000 / 22.9                = 21,834.0611353712
    //   amortisation    500,000 × 0.05532 / (1 − 1.05532^−22.9)
    //                   = 500,000 / 12.808953105…     = 39,035.1963888963
    //   annuitisation   500,000 / 13.517544391…        = 36,988.9667483762
    const priced = (method: 'rmd' | 'fixedAmortization' | 'fixedAnnuitization') =>
      seppAnnualAmountFromTables({ method, balance: 500_000, age: 65, firstDistributionMonth: '2026-11' }).annualAmount;

    expect(priced('rmd')).toBeCloseTo(21_834.0611353712, 6);
    expect(priced('fixedAmortization')).toBeCloseTo(39_035.1963888963, 6);
    expect(priced('fixedAnnuitization')).toBeCloseTo(36_988.9667483762, 6);
  });

  it('applies the 5 % floor when both permitted months price below it', () => {
    // March 2022 payments: February 2022 was 1.40 % (Rev. Rul. 2022-3) and January 2022 1.30 %
    // (Rev. Rul. 2022-1). 120 % of either is far below 5 %, so the floor is the cap.
    const window = seppRateWindow('2022-03');

    expect(window.maximumRate).toBeCloseTo(0.05, 12);
    expect(window.eligibleMonths.map((entry) => entry.federalMidTermRate)).toStrictEqual([0.014, 0.013]);

    // 500,000 at 5 % over 22.9: 500,000 / 13.456726901347134 = 37,156.1378681131.
    const result = seppAnnualAmountFromTables({
      method: 'fixedAmortization',
      balance: 500_000,
      age: 65,
      firstDistributionMonth: '2022-03',
    });
    expect(result.rate).toBe(0.05);
    expect(result.annualAmount).toBeCloseTo(37_156.1378681131, 6);
  });

  it('takes the better of the two permitted months', () => {
    // December 2026 payments: November 2026 (5.08 %) beats October 2026 (4.61 %), so the cap is
    // 120 % × 5.08 % = 6.096 % — the two-month window exists precisely to allow the better month.
    expect(seppRateWindow('2026-12').maximumRate).toBeCloseTo(0.06096, 12);
    expect(seppRateWindow('2026-12').eligibleMonths[0]?.month).toBe('2026-11');
  });

  it('accepts a rate below the cap and refuses one above it', () => {
    // Understating the rate is permitted, so a deliberate 4 % is priced as given and matches the
    // parameterised path exactly.
    const atFour = seppAnnualAmountFromTables({
      method: 'fixedAmortization',
      balance: 500_000,
      age: 65,
      firstDistributionMonth: '2026-11',
      rate: 0.04,
    });
    expect(atFour.rate).toBe(0.04);
    expect(atFour.annualAmount).toBeCloseTo(33_745.0650602113, 6);
    expect(atFour.annualAmount).toBe(yearly('fixedAmortization', 500_000, 0.04, 22.9));

    // 6 % is above what March 2022 permits (5 %, the floor), and an out-of-cap rate is a §72(t)
    // modification rather than a number to return.
    expect(() =>
      seppAnnualAmountFromTables({ method: 'rmd', balance: 500_000, age: 65, firstDistributionMonth: '2022-03', rate: 0.06 })
    ).toThrow(/exceeds the Notice 2022-6 §3.02\(c\) maximum of 5 %/);
  });

  it('re-reads the period from the next year`s age under the RMD method', () => {
    // The RMD method redetermines the period every year (Notice 2022-6 §3.01(a)): age 65 → 22.9,
    // age 66 → 22.0, so the same 500,000 pays 21,834.06 then 22,727.27.
    const first = seppAnnualAmountFromTables({ method: 'rmd', balance: 500_000, age: 65, firstDistributionMonth: '2026-11' });
    const second = seppAnnualAmountFromTables({ method: 'rmd', balance: 500_000, age: 66, firstDistributionMonth: '2026-11' });

    expect(first.distributionPeriod).toBe(22.9);
    expect(second.distributionPeriod).toBe(22.0);
    expect(second.annualAmount).toBeCloseTo(22_727.2727272727, 6);
    expect(second.annualAmount).toBeGreaterThan(first.annualAmount);
  });

  it('refuses a distribution month whose rate window reaches past the vendored data', () => {
    // December 2026 is the last supported month (it needs November and October 2026). January 2027
    // would need December 2026, which the IRS has not published, so it throws from the lookup rather
    // than pricing at the newest month it happens to have.
    expect(seppRateWindow('2026-12').maximumRate).toBeGreaterThan(0);
    expect(() => seppAnnualAmountFromTables({ method: 'rmd', balance: 500_000, age: 65, firstDistributionMonth: '2027-01' })).toThrow(
      /No federal mid-term rate vendored for 2026-12/
    );
    expect(() => seppAnnualAmountFromTables({ method: 'rmd', balance: 500_000, age: 65, firstDistributionMonth: '2021-12' })).toThrow(
      /No federal mid-term rate vendored for 2021-10/
    );
  });
});

describe('how long the payments must continue', () => {
  it('is five years from the first payment when that is the later date', () => {
    // Start 2026-03-15 → five years is 2031-03-15. Born 1970-07-01 → 59½ on 2030-01-01.
    expect(seppMustContinueUntil({ startDate: '2026-03-15', birthDate: '1970-07-01' })).toBe('2031-03-15');
  });

  it('is the 59½ birthday when the owner is young', () => {
    // Start 2020-03-15 → five years is 2025-03-15. Born 1990-01-01 → 59½ on 2049-07-01.
    expect(seppMustContinueUntil({ startDate: '2020-03-15', birthDate: '1990-01-01' })).toBe('2049-07-01');
  });

  it('is five years when the owner is already past 59½', () => {
    // Born 1955-01-01 → 59½ on 2014-07-01, already past; start 2020-03-15 → 2025-03-15.
    expect(seppMustContinueUntil({ startDate: '2020-03-15', birthDate: '1955-01-01' })).toBe('2025-03-15');
  });
});

describe('the §72(t) additional tax', () => {
  it('is 10 % of a taxable early distribution', () => {
    // Age 45, no exception, $10,000 taxable → 10 % = $1,000.
    expect(earlyDistributionPenalty({ taxableAmount: 10_000, age: 45 })).toStrictEqual({ applies: true, amount: 1_000 });
    expect(EARLY_DISTRIBUTION_PENALTY_RATE).toBe(0.1);
  });

  it('does not apply at or after 59½', () => {
    expect(earlyDistributionPenalty({ taxableAmount: 10_000, age: 59.5 })).toStrictEqual({ applies: false, amount: 0 });
    expect(earlyDistributionPenalty({ taxableAmount: 10_000, age: 70 })).toStrictEqual({ applies: false, amount: 0 });
  });

  it('does not apply under a modelled exception', () => {
    for (const exception of ['sepp', 'death', 'disability', 'rothFirstTimeHomebuyer'] as const) {
      expect(earlyDistributionPenalty({ taxableAmount: 10_000, age: 45, exception }).applies).toBe(false);
    }
    // `none` is not an exception.
    expect(earlyDistributionPenalty({ taxableAmount: 10_000, age: 45, exception: 'none' }).applies).toBe(true);
  });

  it('is zero when nothing is taxable', () => {
    expect(earlyDistributionPenalty({ taxableAmount: 0, age: 45 }).amount).toBe(0);
  });
});
