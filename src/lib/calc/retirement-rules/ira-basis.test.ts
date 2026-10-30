import { describe, expect, it } from 'vitest';

import { prorateIraDistribution, roundForm8606Ratio } from './ira-basis';

/**
 * Pro-rata IRA basis (IRC §408(d)(2); Form 8606).
 *
 * Every case works the Form 8606 lines by hand:
 *
 *   line 6 = year-end balance
 *   line 7 = distributions (conversions go on line 8 and join line 9)
 *   line 9 = line 6 + line 7 (+ line 8)     ← the denominator, NOT the year-end balance alone
 *   line 10 = line 5 / line 9               ← basis remaining / denominator
 *   line 11 = line 7 × line 10              ← tax-free part
 *   line 14 = line 5 − line 11              ← basis carried forward
 *
 * The IRS Form 8606 instructions do not print a single worked example with all of these lines
 * filled in, so these cases state their own arithmetic rather than citing one; the line mapping
 * above is from the form and its instructions.
 */

describe('pro-rata basis recovery', () => {
  it('splits a distribution by the shared fraction (clean numbers)', () => {
    // line 5 = $12,000 basis; line 6 = $60,000 year-end; line 7 = $12,000 distributed.
    // line 9 = 60,000 + 12,000 = $72,000
    // line 10 = 12,000 / 72,000 = 1/6 = 0.166666…
    // line 11 = 12,000 × 1/6 = $2,000 tax-free
    // taxable = 12,000 − 2,000 = $10,000
    // line 14 = 12,000 − 2,000 = $10,000 basis remaining
    const result = prorateIraDistribution({ yearEndBalance: 60_000, basis: 12_000, distribution: 12_000 });

    expect(result.denominator).toBe(72_000);
    expect(result.exclusionRatio).toBeCloseTo(1 / 6, 12);
    expect(result.nontaxableAmount).toBeCloseTo(2_000, 10);
    expect(result.taxableAmount).toBeCloseTo(10_000, 10);
    expect(result.remainingBasis).toBeCloseTo(10_000, 10);
  });

  it('uses the year-end balance PLUS the distribution, not the year-end balance', () => {
    // line 5 = $30,000; line 6 = $90,000; line 7 = $10,000.
    // Correct: line 9 = 90,000 + 10,000 = $100,000 → ratio 0.3 → $3,000 tax-free.
    // The common error divides by $90,000 → ratio 0.3333 → $3,333.33, overstating the tax-free
    // part by $333.33 and understating income by the same amount.
    const result = prorateIraDistribution({ yearEndBalance: 90_000, basis: 30_000, distribution: 10_000 });

    expect(result.denominator).toBe(100_000);
    expect(result.nontaxableAmount).toBeCloseTo(3_000, 10);
    expect(result.taxableAmount).toBeCloseTo(7_000, 10);
    expect(result.nontaxableAmount).not.toBeCloseTo(10_000 / 3, 2);
  });

  it('follows the Form 8606 three-decimal rounding path', () => {
    // line 5 = $2,400; line 6 = $12,000; line 7 = $3,600.
    // line 9 = 15,600; exact ratio = 2,400 / 15,600 = 0.1538461538…
    // exact line 11 = $553.8461538 → line 14 = $1,846.1538462
    // The form rounds line 10 to at least three decimals: 0.154
    //   → line 11 = 3,600 × 0.154 = $554.40 → taxable = $3,045.60
    const result = prorateIraDistribution({ yearEndBalance: 12_000, basis: 2_400, distribution: 3_600 });
    const roundedRatio = roundForm8606Ratio(result.exclusionRatio);

    expect(result.denominator).toBe(15_600);
    expect(result.exclusionRatio).toBeCloseTo(0.15384615384615385, 14);
    expect(result.nontaxableAmount).toBeCloseTo(553.8461538461538, 10);
    expect(result.taxableAmount).toBeCloseTo(3_046.1538461538462, 10);
    expect(result.remainingBasis).toBeCloseTo(1_846.1538461538462, 10);

    expect(roundedRatio).toBe(0.154);
    expect(3_600 * roundedRatio).toBeCloseTo(554.4, 10);
    expect(3_600 - 3_600 * roundedRatio).toBeCloseTo(3_045.6, 10);
  });

  it('never takes out more than the distribution when basis exceeds the denominator', () => {
    // After a market fall the basis can exceed the balance: line 5 = $100,000; line 6 = $60,000;
    // line 7 = $40,000 → line 9 = $100,000 → ratio exactly 1.0
    //   → the whole $40,000 is tax-free, line 14 = $60,000 basis left for next year.
    // A ratio computed as 100,000 / 60,000 = 1.667 would claim $66,667 of a $40,000 distribution.
    const result = prorateIraDistribution({ yearEndBalance: 60_000, basis: 100_000, distribution: 40_000 });

    expect(result.exclusionRatio).toBe(1);
    expect(result.nontaxableAmount).toBe(40_000);
    expect(result.taxableAmount).toBe(0);
    expect(result.remainingBasis).toBeCloseTo(60_000, 10);
  });

  it('makes a no-basis IRA fully taxable', () => {
    // line 5 = $0; line 6 = $50,000; line 7 = $5,000 → ratio 0 → all $5,000 taxable.
    const result = prorateIraDistribution({ yearEndBalance: 50_000, basis: 0, distribution: 5_000 });

    expect(result.exclusionRatio).toBe(0);
    expect(result.nontaxableAmount).toBe(0);
    expect(result.taxableAmount).toBe(5_000);
    expect(result.remainingBasis).toBe(0);
  });

  it('returns zeros instead of NaN for an empty account with no distribution', () => {
    const result = prorateIraDistribution({ yearEndBalance: 0, basis: 0, distribution: 0 });

    expect(result).toStrictEqual({ denominator: 0, exclusionRatio: 0, nontaxableAmount: 0, taxableAmount: 0, remainingBasis: 0 });
    expect(Number.isNaN(result.exclusionRatio)).toBe(false);
  });

  it('treats negative inputs as zero rather than producing a negative taxable amount', () => {
    const result = prorateIraDistribution({ yearEndBalance: -1_000, basis: -500, distribution: -200 });

    expect(result).toStrictEqual({ denominator: 0, exclusionRatio: 0, nontaxableAmount: 0, taxableAmount: 0, remainingBasis: 0 });
  });
});

describe('roundForm8606Ratio', () => {
  it('rounds to at least three decimals, and to more when asked', () => {
    expect(roundForm8606Ratio(0.1538461538)).toBe(0.154);
    expect(roundForm8606Ratio(0.1538461538, 4)).toBe(0.1538);
    expect(roundForm8606Ratio(0.5)).toBe(0.5);
    expect(roundForm8606Ratio(1)).toBe(1);
  });
});
