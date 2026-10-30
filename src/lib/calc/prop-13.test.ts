import { describe, expect, it } from 'vitest';

import {
  PROP_13_ASSESSED_GROWTH_CAP,
  PROP_13_DEFAULT_RATE_PERCENT,
  buildProp13Schedule,
  prop13AnnualTax,
  prop13AssessedGrowth,
  prop13AssessedValue,
} from './prop-13';

/**
 * Prop 13 (D9) hand-worked cases.
 *
 * The rule: assessed value starts at the purchase price and grows by the lesser of market
 * appreciation and the 2% cap; the year's liability is the assessed value times the rate
 * (1.1% by default).
 */
describe('Prop 13 assessed value', () => {
  it('binds the cap when appreciation is above 2%', () => {
    // A $500,000 home appreciating 8% a year. The assessment still grows at 2%:
    //   1.02^10 = 1.21899442
    //   assessed = 500,000 × 1.21899442 = 609,497.21
    //   tax      = 609,497.21 × 1.1% = 6,704.47
    const assessed = prop13AssessedValue(500000, 10, { marketAppreciationPercent: 8 });

    expect(PROP_13_ASSESSED_GROWTH_CAP).toBe(0.02);
    expect(prop13AssessedGrowth(8)).toBe(0.02);
    expect(assessed).toBeCloseTo(609497.21, 2);
    expect(prop13AnnualTax(assessed)).toBeCloseTo(6704.47, 2);
  });

  it('does not bind when appreciation is below 2%', () => {
    // The same home appreciating 1% a year, so the assessment follows the market:
    //   1.01^10 = 1.10462213
    //   assessed = 500,000 × 1.10462213 = 552,311.06
    //   tax      = 552,311.06 × 1.1% = 6,075.42
    const assessed = prop13AssessedValue(500000, 10, { marketAppreciationPercent: 1 });

    expect(prop13AssessedGrowth(1)).toBe(0.01);
    expect(assessed).toBeCloseTo(552311.06, 2);
    expect(prop13AnnualTax(assessed)).toBeCloseTo(6075.42, 2);
  });

  it('holds the assessment flat in a flat market', () => {
    // No appreciation, no growth: the purchase price is the assessed value for as long as it is
    // held, and the bill is 500,000 × 1.1% = 5,500 a year.
    for (const years of [0, 1, 10, 30]) {
      expect(prop13AssessedValue(500000, years, { marketAppreciationPercent: 0 })).toBe(500000);
    }
    expect(prop13AnnualTax(500000)).toBeCloseTo(5500, 6);
  });

  it('never assesses below the purchase price when the market falls', () => {
    // A decline in the market does not cut the Prop 13 assessment below its base-year value; the
    // Prop 8 decline-in-value reassessment is out of scope (see the module note).
    expect(prop13AssessedGrowth(-5)).toBe(-0.05);
    expect(prop13AssessedValue(500000, 10, { marketAppreciationPercent: -5 })).toBe(500000);
  });

  it('resets the assessment on a sale and repurchase', () => {
    // Held ten years while the market appreciated 8% a year: assessed 609,497.21, not the 500,000
    // purchase price and not the ~1,079,462 market value.
    const beforeSale = prop13AssessedValue(500000, 10, { marketAppreciationPercent: 8 });
    expect(beforeSale).toBeCloseTo(609497.21, 2);

    // Sold and repurchased for its then market value of 700,000: the new base is the price paid,
    // and the previous assessment carries nothing forward.
    const atRepurchase = prop13AssessedValue(700000, 0, { marketAppreciationPercent: 8 });
    const oneYearLater = prop13AssessedValue(700000, 1, { marketAppreciationPercent: 8 });

    expect(atRepurchase).toBe(700000);
    expect(atRepurchase).not.toBe(beforeSale);
    expect(prop13AnnualTax(atRepurchase)).toBeCloseTo(7700, 6);
    // Then the 2% cap applies from the new base: 700,000 × 1.02 = 714,000.
    expect(oneYearLater).toBeCloseTo(714000, 6);
  });

  it('honours a custom cap and rate', () => {
    // A cap of 0 freezes the assessment even in an 8% market; a 1.25% rate is a different bill.
    expect(prop13AssessedValue(500000, 10, { marketAppreciationPercent: 8, assessedGrowthCap: 0 })).toBe(500000);
    expect(prop13AnnualTax(500000, 1.25)).toBeCloseTo(6250, 6);

    // Defaults are the plan's: 2% cap, 1.1% rate.
    expect(PROP_13_DEFAULT_RATE_PERCENT).toBe(1.1);
    expect(prop13AnnualTax(500000)).toBeCloseTo(500000 * (PROP_13_DEFAULT_RATE_PERCENT / 100), 6);
  });

  it('rejects inputs that are not a property', () => {
    expect(() => prop13AssessedValue(0, 1, { marketAppreciationPercent: 3 })).toThrow(/purchasePrice must be greater than zero/);
    expect(() => prop13AssessedValue(500000, 1.5, { marketAppreciationPercent: 3 })).toThrow(/whole number of years/);
    expect(() => prop13AssessedValue(500000, -1, { marketAppreciationPercent: 3 })).toThrow(/whole number of years/);
    expect(() => prop13AssessedValue(Number.NaN, 1, { marketAppreciationPercent: 3 })).toThrow(/finite/);
    expect(() => prop13AssessedValue(500000, 1, { marketAppreciationPercent: -100 })).toThrow(/greater than -100/);
    expect(() => prop13AnnualTax(-1)).toThrow(/cannot be negative/);
  });
});

describe('Prop 13 schedule', () => {
  it('returns one row per year owned, from the purchase year', () => {
    // $500,000 at 8% market appreciation: the assessment grows 2% a year.
    //   500,000 → 510,000 → 520,200 → 530,604
    const schedule = buildProp13Schedule(500000, 3, { marketAppreciationPercent: 8 });

    expect(schedule).toHaveLength(4);
    expect(schedule.map((year) => year.yearIndex)).toEqual([0, 1, 2, 3]);
    expect(schedule.map((year) => year.assessedValue)).toEqual([
      expect.closeTo(500000, 6),
      expect.closeTo(510000, 6),
      expect.closeTo(520200, 6),
      expect.closeTo(530604, 6),
    ]);
    // 1.1% of each: 5,500.00 / 5,610.00 / 5,722.20 / 5,836.644
    expect(schedule.map((year) => year.annualTax)).toEqual([
      expect.closeTo(5500, 6),
      expect.closeTo(5610, 6),
      expect.closeTo(5722.2, 6),
      expect.closeTo(5836.644, 6),
    ]);
  });

  it('tracks the market when it stays under the cap', () => {
    // 1.5% appreciation, so the assessment compounds at 1.5%, not 2%:
    //   500,000 × 1.015^4 = 530,681
    const schedule = buildProp13Schedule(500000, 4, { marketAppreciationPercent: 1.5 });

    expect(schedule.map((year) => year.assessedValue)).toEqual([
      expect.closeTo(500000, 6),
      expect.closeTo(507500, 6),
      expect.closeTo(515112.5, 6),
      expect.closeTo(522839.19, 2),
      expect.closeTo(530681.78, 2),
    ]);
  });
});
