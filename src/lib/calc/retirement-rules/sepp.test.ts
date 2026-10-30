import { describe, expect, it } from 'vitest';

import {
  EARLY_DISTRIBUTION_PENALTY_RATE,
  earlyDistributionPenalty,
  maximumSeppInterestRate,
  seppAnnualAmount,
  seppAnnuityFactors,
  seppMustContinueUntil,
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
