import { describe, expect, it } from 'vitest';

import { QCD_BASE_LIMIT, QCD_MINIMUM_AGE, qcdAnnualLimit, qualifiedCharitableDistribution } from './qcd';

/**
 * Qualified charitable distributions (IRC §408(d)(8)).
 *
 * Age 70½ on the date of the payment, a per-individual annual limit ($100,000 flat for 2013–2023,
 * indexed after), exclusion from income rather than a deduction, and the amount counting toward
 * the year's RMD.
 */

describe('the annual limit', () => {
  it('is the flat $100,000 for the years before indexation', () => {
    expect(QCD_BASE_LIMIT).toBe(100_000);
    for (const year of [2013, 2019, 2023]) expect(qcdAnnualLimit(year)).toBe(100_000);
  });

  it('uses the indexed amounts it carries', () => {
    // 2024: $105,000; 2025: $108,000 — the IRS inflation adjustments in $1,000 steps.
    expect(qcdAnnualLimit(2024)).toBe(105_000);
    expect(qcdAnnualLimit(2025)).toBe(108_000);
  });

  it('refuses a year it cannot cite', () => {
    expect(() => qcdAnnualLimit(2026)).toThrow(/No QCD limit for 2026/);
    expect(() => qcdAnnualLimit(2012)).toThrow(/No QCD limit for 2012/);
  });
});

describe('the distribution', () => {
  it('needs age 70½', () => {
    expect(QCD_MINIMUM_AGE).toBe(70.5);

    // Age 70 exactly: nothing qualifies, so the whole $50,000 is an ordinary IRA distribution and
    // the RMD is untouched.
    const tooYoung = qualifiedCharitableDistribution({ year: 2025, age: 70, distribution: 50_000, rmdRequired: 20_000 });
    expect(tooYoung.excludedAmount).toBe(0);
    expect(tooYoung.taxableAmount).toBe(50_000);
    expect(tooYoung.rmdSatisfied).toBe(0);
    expect(tooYoung.rmdRemaining).toBe(20_000);

    // Age 70½ exactly: eligible.
    const eligible = qualifiedCharitableDistribution({ year: 2025, age: 70.5, distribution: 50_000, rmdRequired: 20_000 });
    expect(eligible.excludedAmount).toBe(50_000);
  });

  it('caps the exclusion at the year`s limit and leaves the excess taxable', () => {
    // 2025 limit $108,000 against a $150,000 distribution → $108,000 excluded, $42,000 taxable.
    // The RMD of $20,000 is fully satisfied by the QCD, so nothing remains due.
    const result = qualifiedCharitableDistribution({ year: 2025, age: 72, distribution: 150_000, rmdRequired: 20_000 });

    expect(result.limit).toBe(108_000);
    expect(result.excludedAmount).toBe(108_000);
    expect(result.taxableAmount).toBe(42_000);
    expect(result.rmdSatisfied).toBe(20_000);
    expect(result.rmdRemaining).toBe(0);
  });

  it('counts toward the RMD dollar for dollar, and leaves the rest due', () => {
    // A $10,000 QCD against a $30,000 RMD: $10,000 satisfied, $20,000 still to distribute.
    const partial = qualifiedCharitableDistribution({ year: 2025, age: 75, distribution: 10_000, rmdRequired: 30_000 });

    expect(partial.excludedAmount).toBe(10_000);
    expect(partial.taxableAmount).toBe(0);
    expect(partial.rmdSatisfied).toBe(10_000);
    expect(partial.rmdRemaining).toBe(20_000);
  });

  it('keeps a distribution under the limit entirely out of income', () => {
    // $80,000 in 2025, below the $108,000 limit: excluded in full, nothing taxable, and the whole
    // $30,000 RMD is satisfied.
    const result = qualifiedCharitableDistribution({ year: 2025, age: 80, distribution: 80_000, rmdRequired: 30_000 });

    expect(result.excludedAmount).toBe(80_000);
    expect(result.taxableAmount).toBe(0);
    expect(result.rmdSatisfied).toBe(30_000);
    expect(result.rmdRemaining).toBe(0);
  });

  it('uses the 2024 limit for a 2024 distribution', () => {
    // $120,000 in 2024: $105,000 excluded, $15,000 taxable.
    const result = qualifiedCharitableDistribution({ year: 2024, age: 72, distribution: 120_000 });

    expect(result.limit).toBe(105_000);
    expect(result.excludedAmount).toBe(105_000);
    expect(result.taxableAmount).toBe(15_000);
  });

  it('is all zeros for no distribution', () => {
    expect(qualifiedCharitableDistribution({ year: 2025, age: 80, distribution: 0, rmdRequired: 25_000 })).toStrictEqual({
      excludedAmount: 0,
      taxableAmount: 0,
      rmdSatisfied: 0,
      rmdRemaining: 25_000,
      limit: 108_000,
    });
  });
});
