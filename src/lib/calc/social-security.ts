/**
 * Social Security benefit estimation (parity plan P1-P8).
 *
 * Three pure steps, no I/O and no clock:
 *
 *   1. Average Indexed Monthly Earnings → Primary Insurance Amount, through the vendored PIA bend
 *      points (`social-security-bend-points.ts`);
 *   2. Primary Insurance Amount → payable benefit, through the claiming adjustment for an early or
 *      delayed start relative to the full retirement age (`fra-table.ts`);
 *   3. the cost-of-living adjustment, expressed as **real growth**: benefits are paid in nominal
 *      dollars that rise by the COLA, while the engine models everything in today's dollars, so
 *      the real benefit grows by `(1 + COLA) / (1 + inflation) - 1`. A COLA equal to the plan's
 *      inflation assumption therefore leaves the real benefit exactly unchanged.
 *
 * ## Rounding
 *
 * SSA rounds the PIA down to the next lower dime and the payable monthly benefit down to the next
 * lower dollar. This module keeps the exact arithmetic instead, in whole cents, because the plan
 * is a projection rather than a payment: a sub-dollar rounding is invisible at the scale of a
 * retirement, and keeping exact values makes every number here checkable by hand against the
 * published formula. The hand-worked tests in `social-security.test.ts` rely on that.
 *
 * ## What is deliberately not modelled
 *
 * Spousal benefits (up to 50% of a spouse's PIA) and survivor benefits both need the household
 * model and the survivor rules in `portfolio.ts` / `phase.ts`, which another item owns. Nothing
 * here reads a household: a single earner's own retirement benefit is the whole scope, and adding
 * a hook that nothing consumes would be worse than leaving this note.
 */

import type { SocialSecurityInputs } from '@/lib/schemas/inputs/income-form-schema';

import { PIA_BEND_POINTS_2025, type PiaBendPoints } from './social-security-bend-points';
import { fullRetirementAge, type FullRetirementAge } from './fra-table';

/** Earliest and latest ages at which a retirement benefit may start (SSA: 62 through 70). */
export const EARLIEST_CLAIM_AGE = 62;
export const LATEST_CLAIM_AGE = 70;

/** SSA's early-claim reduction: 5/9 of 1% per month for the first 36, then 5/12 of 1% per month. */
const EARLY_REDUCTION_PER_MONTH_FIRST_36 = 5 / 9 / 100;
const EARLY_REDUCTION_PER_MONTH_AFTER_36 = 5 / 12 / 100;
/** SSA's delayed-retirement credit: 2/3 of 1% per month (8% a year). */
const DELAY_CREDIT_PER_MONTH = 2 / 3 / 100;

/** How a claim's timing adjusts the PIA. `factor` is the payable fraction of the PIA. */
export interface ClaimingAdjustment {
  /** Months claimed before the full retirement age (0 when claiming at or after it). */
  readonly monthsEarly: number;
  /** Months claimed after the full retirement age (0 when claiming at or before it). */
  readonly monthsLate: number;
  /** Total reduction as a fraction of the PIA, e.g. 0.3 for a claim 60 months early. */
  readonly reduction: number;
  /** Total delayed credit as a fraction of the PIA, e.g. 0.24 for a claim 36 months late. */
  readonly credit: number;
  /** `1 - reduction + credit`: the fraction of the PIA actually payable. */
  readonly factor: number;
}

/** The PIA itself for an AIME, through the bend points of one year's table. */
export function primaryInsuranceAmount(aime: number, bendPoints: PiaBendPoints = PIA_BEND_POINTS_2025): number {
  const earnings = Math.max(0, aime);
  const { first, second, third } = bendPoints.replacementRates;

  // 90% of the first band, 32% of the second, 15% of everything above the second bend point.
  const firstBand = Math.min(earnings, bendPoints.firstBendPoint) * first;
  const secondBand = Math.max(0, Math.min(earnings, bendPoints.secondBendPoint) - bendPoints.firstBendPoint) * second;
  const thirdBand = Math.max(0, earnings - bendPoints.secondBendPoint) * third;

  return firstBand + secondBand + thirdBand;
}

/**
 * The claiming adjustment for a claim age, against a full retirement age.
 *
 * Worked cases (FRA 67):
 * - claim at 62 → 60 months early → 36 × 5/9% = 20% + 24 × 5/12% = 10% → 30% reduction, factor 0.70;
 * - claim at 64 → 36 months early → exactly the first band → 20% reduction, factor 0.80;
 * - claim at 67 → no adjustment, factor 1;
 * - claim at 70 → 36 months late → 36 × 2/3% = 24% credit, factor 1.24.
 *
 * A fractional claim age is rounded to the nearest month. A claim age outside 62–70 is clamped to
 * that window before the arithmetic, because no benefit starts earlier or later in law.
 */
export function claimingAdjustment(claimAge: number, fra: FullRetirementAge): ClaimingAdjustment {
  const clampedAge = Math.min(LATEST_CLAIM_AGE, Math.max(EARLIEST_CLAIM_AGE, claimAge));
  const claimMonths = Math.round(clampedAge * 12);
  const earliestMonths = EARLIEST_CLAIM_AGE * 12;
  const latestMonths = LATEST_CLAIM_AGE * 12;

  const monthsEarly = Math.min(Math.max(0, fra.totalMonths - claimMonths), fra.totalMonths - earliestMonths);
  const monthsLate = Math.min(Math.max(0, claimMonths - fra.totalMonths), latestMonths - fra.totalMonths);

  const reduction =
    Math.min(monthsEarly, 36) * EARLY_REDUCTION_PER_MONTH_FIRST_36 + Math.max(0, monthsEarly - 36) * EARLY_REDUCTION_PER_MONTH_AFTER_36;
  const credit = monthsLate * DELAY_CREDIT_PER_MONTH;

  return { monthsEarly, monthsLate, reduction, credit, factor: 1 - reduction + credit };
}

/**
 * How fast a benefit grows in real (today's) dollars when it is raised by `colaRate` while prices
 * rise by `inflationRate`, both as percentages.
 *
 * This is the whole of "COLA as real growth": with equal rates the result is exactly 0, so a plan
 * inflating at its own assumption sees a flat real benefit; a COLA above inflation is real growth,
 * below it is real erosion.
 */
export function realBenefitGrowthRate(colaRate: number, inflationRate: number): number {
  return (1 + colaRate / 100) / (1 + inflationRate / 100) - 1;
}

/** A benefit `years` from now, in today's dollars, after `years` of real COLA growth. */
export function projectRealAnnualBenefit(annualBenefit: number, years: number, colaRate: number, inflationRate: number): number {
  return annualBenefit * Math.pow(1 + realBenefitGrowthRate(colaRate, inflationRate), years);
}

/** Everything the estimate produces, all in today's dollars except the COLA rate itself. */
export interface SocialSecurityEstimate {
  /** Monthly Primary Insurance Amount before the claiming adjustment. */
  readonly pia: number;
  readonly fullRetirementAge: FullRetirementAge;
  readonly claiming: ClaimingAdjustment;
  /** Monthly benefit after the claiming adjustment. */
  readonly monthlyBenefit: number;
  readonly annualBenefit: number;
  /** The COLA the plan assumes, as a percentage; 0 when it did not set one. */
  readonly colaRate: number;
  /** Real growth implied by `colaRate` against the plan's inflation; absent without inflation. */
  readonly realColaGrowthRate: number | undefined;
}

export interface SocialSecurityEstimateInput {
  /** The income's stored `socialSecurity` block: mode, AIME or PIA, claim age, COLA. */
  readonly socialSecurity: SocialSecurityInputs;
  /** The plan member's birth year, from the timeline — the FRA depends on it and nothing else. */
  readonly birthYear: number;
  /** The plan's inflation assumption, as a percentage, so the COLA can be read in real terms. */
  readonly inflationRate?: number;
  /** The PIA bend-point table to use; defaults to the vendored 2025 table. */
  readonly bendPoints?: PiaBendPoints;
}

/**
 * The full estimate for one earner.
 *
 * @throws when the block is `estimated` without an AIME or `manual` without a PIA, because
 *         silently treating a missing input as zero would produce a confident, wrong benefit.
 */
export function estimateSocialSecurityBenefit(input: SocialSecurityEstimateInput): SocialSecurityEstimate {
  const { socialSecurity, birthYear, inflationRate } = input;

  const pia =
    socialSecurity.mode === 'manual'
      ? requireAmount(socialSecurity.pia, 'pia', 'manual')
      : primaryInsuranceAmount(requireAmount(socialSecurity.aime, 'aime', 'estimated'), input.bendPoints ?? PIA_BEND_POINTS_2025);

  const fra = fullRetirementAge(birthYear);
  const claiming = claimingAdjustment(socialSecurity.claimAge, fra);
  const monthlyBenefit = pia * claiming.factor;
  const colaRate = socialSecurity.colaRate ?? 0;

  return {
    pia,
    fullRetirementAge: fra,
    claiming,
    monthlyBenefit,
    annualBenefit: monthlyBenefit * 12,
    colaRate,
    realColaGrowthRate: inflationRate === undefined ? undefined : realBenefitGrowthRate(colaRate, inflationRate),
  };
}

function requireAmount(value: number | undefined, field: 'aime' | 'pia', mode: SocialSecurityInputs['mode']): number {
  if (value === undefined) {
    throw new Error(`Social Security income with mode "${mode}" needs ${mode === 'manual' ? 'a pia' : 'an aime'}; ${field} is missing.`);
  }

  return value;
}
