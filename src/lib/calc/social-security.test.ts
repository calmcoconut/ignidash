import { describe, expect, it } from 'vitest';

import type { SocialSecurityInputs } from '@/lib/schemas/inputs/income-form-schema';

import { FULL_RETIREMENT_AGE_TABLE, fullRetirementAge } from './fra-table';
import { PIA_BEND_POINTS_2025, piaBendPointsFor } from './social-security-bend-points';
import {
  EARLIEST_CLAIM_AGE,
  LATEST_CLAIM_AGE,
  claimingAdjustment,
  estimateSocialSecurityBenefit,
  primaryInsuranceAmount,
  projectRealAnnualBenefit,
  realBenefitGrowthRate,
} from './social-security';

/**
 * P1-P8: Social Security benefit estimation.
 *
 * Every number here is hand-worked from the published formula (SSA's "Benefit Formula Bend Points"
 * for the PIA, §216(l) for the FRA, and the 5/9% · 5/12% · 2/3% monthly adjustments for claiming
 * early or late). The arithmetic for each case is in the comment above it, so the expectation can
 * be checked without running the code.
 *
 * The vendored table is 2025 (the most recent year whose bend points we can cite): $1,226 and
 * $7,391 at 90% / 32% / 15%.
 */

const bendPoints = PIA_BEND_POINTS_2025;

const socialSecurity = (overrides: Partial<SocialSecurityInputs>): SocialSecurityInputs =>
  ({ mode: 'manual', pia: 3000, claimAge: 67, ...overrides }) as SocialSecurityInputs;

describe('the vendored tables', () => {
  it('carries the 2025 bend points with their source', () => {
    expect(bendPoints.year).toBe(2025);
    expect(bendPoints.firstBendPoint).toBe(1226);
    expect(bendPoints.secondBendPoint).toBe(7391);
    expect(bendPoints.replacementRates).toEqual({ first: 0.9, second: 0.32, third: 0.15 });
    expect(bendPoints.source).toMatch(/SSA/);
    expect(piaBendPointsFor(2025)).toBe(bendPoints);
  });

  it('returns nothing for a year it does not vendor, rather than borrowing another year', () => {
    expect(piaBendPointsFor(2026)).toBeUndefined();
  });

  it('has one FRA step per transition cohort, and the statute’s two plateaus', () => {
    // 13 steps: the 65 plateau, five months-steps to 66, the 66 plateau, five more, then 67.
    expect(FULL_RETIREMENT_AGE_TABLE).toHaveLength(13);

    for (const [birthYear, expected] of [
      [1930, { years: 65, months: 0, totalMonths: 780 }],
      [1938, { years: 65, months: 2, totalMonths: 782 }],
      [1942, { years: 65, months: 10, totalMonths: 790 }],
      [1943, { years: 66, months: 0, totalMonths: 792 }],
      [1954, { years: 66, months: 0, totalMonths: 792 }],
      [1955, { years: 66, months: 2, totalMonths: 794 }],
      [1959, { years: 66, months: 10, totalMonths: 802 }],
      [1960, { years: 67, months: 0, totalMonths: 804 }],
      [1990, { years: 67, months: 0, totalMonths: 804 }],
    ] as const) {
      expect(fullRetirementAge(birthYear), String(birthYear)).toEqual(expected);
    }
  });
});

describe('primaryInsuranceAmount: the three bands', () => {
  it('is 90% of earnings up to the first bend point', () => {
    // 1,226 × 0.90 = 1,103.40
    expect(primaryInsuranceAmount(1226, bendPoints)).toBeCloseTo(1103.4, 10);
    // Half the first band: 613 × 0.90 = 551.70
    expect(primaryInsuranceAmount(613, bendPoints)).toBeCloseTo(551.7, 10);
  });

  it('adds 32% of the second band', () => {
    // 1,103.40 + (5,000 − 1,226) × 0.32 = 1,103.40 + 1,207.68 = 2,311.08
    expect(primaryInsuranceAmount(5000, bendPoints)).toBeCloseTo(2311.08, 10);
  });

  it('reaches the second bend point exactly', () => {
    // 1,103.40 + (7,391 − 1,226) × 0.32 = 1,103.40 + 1,972.80 = 3,076.20
    expect(primaryInsuranceAmount(7391, bendPoints)).toBeCloseTo(3076.2, 10);
  });

  it('adds 15% above the second bend point', () => {
    // 3,076.20 + (10,000 − 7,391) × 0.15 = 3,076.20 + 391.35 = 3,467.55
    expect(primaryInsuranceAmount(10000, bendPoints)).toBeCloseTo(3467.55, 10);
    expect(primaryInsuranceAmount(8000, bendPoints)).toBeCloseTo(3167.55, 10); // +609 × 0.15 = 91.35
  });

  it('treats no earnings as no benefit', () => {
    expect(primaryInsuranceAmount(0, bendPoints)).toBe(0);
    expect(primaryInsuranceAmount(-100, bendPoints)).toBe(0);
  });
});

describe('claiming adjustment against the full retirement age', () => {
  const fra67 = fullRetirementAge(1965);

  it('reduces 60 months early to 70% of the PIA (FRA 67)', () => {
    // 36 × 5/9% = 20%, then 24 × 5/12% = 10% → 30% reduction → 0.70
    const adjustment = claimingAdjustment(62, fra67);

    expect(adjustment.monthsEarly).toBe(60);
    expect(adjustment.monthsLate).toBe(0);
    expect(adjustment.reduction).toBeCloseTo(0.3, 10);
    expect(adjustment.factor).toBeCloseTo(0.7, 10);
  });

  it('reduces 36 months early to exactly 80% (the boundary between the two reductions)', () => {
    // 36 × 5/9% = 20% → factor 0.80
    expect(claimingAdjustment(64, fra67)).toMatchObject({ monthsEarly: 36 });
    expect(claimingAdjustment(64, fra67).factor).toBeCloseTo(0.8, 10);
  });

  it('applies the first band only for a claim inside it', () => {
    // 12 × 5/9% = 6.666…% → factor 0.9333…
    expect(claimingAdjustment(66, fra67).monthsEarly).toBe(12);
    expect(claimingAdjustment(66, fra67).factor).toBeCloseTo(1 - 12 * (5 / 9 / 100), 10);
  });

  it('adds 24% for 36 months late, and nothing beyond 70 (FRA 67)', () => {
    // 36 × 2/3% = 24% → 1.24
    expect(claimingAdjustment(70, fra67)).toMatchObject({ monthsEarly: 0, monthsLate: 36 });
    expect(claimingAdjustment(70, fra67).credit).toBeCloseTo(0.24, 10);
    expect(claimingAdjustment(70, fra67).factor).toBeCloseTo(1.24, 10);
    // No benefit starts after 70, so 71 is the same as 70.
    expect(claimingAdjustment(71, fra67).factor).toBeCloseTo(1.24, 10);
  });

  it('leaves a claim at the FRA unadjusted', () => {
    expect(claimingAdjustment(67, fra67)).toEqual({ monthsEarly: 0, monthsLate: 0, reduction: 0, credit: 0, factor: 1 });
  });

  it('uses the cohort FRA: 48 months early against FRA 66 is 75%', () => {
    // FRA 66 (born 1943–1954): 48 months early → 36 × 5/9% = 20% + 12 × 5/12% = 5% → 25% → 0.75
    const fra66 = fullRetirementAge(1950);
    const adjustment = claimingAdjustment(62, fra66);

    expect(fra66.totalMonths).toBe(792);
    expect(adjustment.monthsEarly).toBe(48);
    expect(adjustment.factor).toBeCloseTo(0.75, 10);
  });

  it('clamps a claim age to the statutory window', () => {
    // Nothing starts before 62, so 60 is 62; nothing after 70, checked above.
    expect(claimingAdjustment(60, fra67).factor).toBeCloseTo(claimingAdjustment(EARLIEST_CLAIM_AGE, fra67).factor, 10);
    expect(claimingAdjustment(60, fra67).factor).toBeCloseTo(0.7, 10);
    expect(LATEST_CLAIM_AGE).toBe(70);
  });
});

describe('COLA as real growth', () => {
  it('is exactly zero when the COLA matches the plan’s inflation assumption', () => {
    expect(realBenefitGrowthRate(3, 3)).toBe(0);
    expect(realBenefitGrowthRate(0, 0)).toBe(0);
    // …which is the parity statement: the real value of the benefit does not move, year after year.
    for (const years of [0, 1, 10, 30]) {
      expect(projectRealAnnualBenefit(30000, years, 3, 3)).toBe(30000);
    }
  });

  it('compounds the difference when the COLA outruns inflation', () => {
    // (1.04 / 1.03) − 1 = 0.009708737864077666…
    expect(realBenefitGrowthRate(4, 3)).toBeCloseTo(0.009708737864077666, 15);
    // 10 years: 1.04^10 / 1.03^10 = 1.4802442849183444 / 1.3439163793441222 = 1.101440764968394
    expect(projectRealAnnualBenefit(30000, 10, 4, 3)).toBeCloseTo(30000 * 1.101440764968394, 6);
  });

  it('erodes the real value when the COLA lags inflation', () => {
    expect(realBenefitGrowthRate(2, 3)).toBeLessThan(0);
    expect(projectRealAnnualBenefit(30000, 10, 2, 3)).toBeLessThan(30000);
  });
});

describe('estimateSocialSecurityBenefit', () => {
  it('estimates from an AIME, then adjusts for an FRA claim', () => {
    // AIME 5,000 → PIA 2,311.08; claim at 67 with FRA 67 → ×1 → 2,311.08/mo, 27,732.96/yr
    const estimate = estimateSocialSecurityBenefit({
      socialSecurity: socialSecurity({ mode: 'estimated', aime: 5000, pia: undefined, claimAge: 67 }),
      birthYear: 1965,
    });

    expect(estimate.pia).toBeCloseTo(2311.08, 10);
    expect(estimate.fullRetirementAge.totalMonths).toBe(804);
    expect(estimate.claiming.factor).toBe(1);
    expect(estimate.monthlyBenefit).toBeCloseTo(2311.08, 10);
    expect(estimate.annualBenefit).toBeCloseTo(27732.96, 10);
  });

  it('takes a manual PIA and applies an early claim at 62', () => {
    // PIA 3,000 × 0.70 = 2,100/mo → 25,200/yr
    const estimate = estimateSocialSecurityBenefit({
      socialSecurity: socialSecurity({ mode: 'manual', pia: 3000, claimAge: 62 }),
      birthYear: 1960,
    });

    expect(estimate.pia).toBe(3000);
    expect(estimate.claiming.reduction).toBeCloseTo(0.3, 10);
    expect(estimate.monthlyBenefit).toBeCloseTo(2100, 10);
    expect(estimate.annualBenefit).toBeCloseTo(25200, 10);
  });

  it('applies the delayed credit at 70', () => {
    // PIA 2,500 × 1.24 = 3,100/mo
    const estimate = estimateSocialSecurityBenefit({
      socialSecurity: socialSecurity({ mode: 'manual', pia: 2500, claimAge: 70 }),
      birthYear: 1990,
    });

    expect(estimate.claiming.credit).toBeCloseTo(0.24, 10);
    expect(estimate.monthlyBenefit).toBeCloseTo(3100, 10);
  });

  it('reads the stored COLA against the plan’s inflation', () => {
    const estimate = estimateSocialSecurityBenefit({
      socialSecurity: socialSecurity({ mode: 'manual', pia: 2000, claimAge: 67, colaRate: 3 }),
      birthYear: 1990,
      inflationRate: 3,
    });

    expect(estimate.colaRate).toBe(3);
    expect(estimate.realColaGrowthRate).toBe(0);
  });

  it('reports no COLA growth when the income sets no COLA', () => {
    const estimate = estimateSocialSecurityBenefit({
      socialSecurity: socialSecurity({ mode: 'manual', pia: 2000, claimAge: 67, colaRate: undefined }),
      birthYear: 1990,
      inflationRate: 3,
    });

    // A benefit frozen in nominal terms loses (1 / 1.03) − 1 ≈ −2.91% of real value a year.
    expect(estimate.colaRate).toBe(0);
    expect(estimate.realColaGrowthRate).toBeCloseTo(1 / 1.03 - 1, 12);
  });

  it('refuses to guess when the block is missing the amount its mode needs', () => {
    expect(() =>
      estimateSocialSecurityBenefit({ socialSecurity: socialSecurity({ mode: 'manual', pia: undefined }), birthYear: 1990 })
    ).toThrow(/needs a pia/i);
    expect(() =>
      estimateSocialSecurityBenefit({
        socialSecurity: socialSecurity({ mode: 'estimated', aime: undefined, pia: undefined }),
        birthYear: 1990,
      })
    ).toThrow(/needs an aime/i);
  });
});
