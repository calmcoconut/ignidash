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
 * ## An omitted COLA means a flat real benefit (decided on review of `746e1ca0`)
 *
 * `colaRate` is optional on the income, and its absence is read as **the benefit holding its real
 * value**: the COLA defaults to the plan's inflation assumption, not to zero. Zero would mean a
 * benefit frozen in nominal dollars, which the plan's own inflation then erodes — at a 3%
 * assumption, `1 / 1.03 - 1 ≈ -2.91%` a year, about `0.41×` the benefit after thirty years. An
 * optional field left unset must not quietly delete most of a retirement benefit, and nobody reads
 * a blank field as "hold this cheque flat while prices rise"; an operator who means that types 0.
 * Without an inflation assumption there is no real basis to hold flat, and the COLA is then 0.
 *
 * ## Rounding
 *
 * SSA rounds the PIA down to the next lower dime and the payable monthly benefit down to the next
 * lower dollar. This module keeps the exact arithmetic instead, in whole cents, because the plan
 * is a projection rather than a payment: a sub-dollar rounding is invisible at the scale of a
 * retirement, and keeping exact values makes every number here checkable by hand against the
 * published formula. The hand-worked tests in `social-security.test.ts` rely on that.
 *
 * ## Spousal and survivor benefits (P1-P8, E2)
 *
 * The two household rules are pure functions here, `spousalExcess` and `survivorBenefit`, each
 * taking the members' own figures as arguments. They do not read a household: `incomes.ts` decides
 * which couple's lines they apply to, when they start, and when they stop. A member with two
 * Social Security lines, or with a line that has no `socialSecurity` block, is left out of the couple
 * rules; any other shape is handled there (see `incomes.ts`).
 *
 * Not modelled, on purpose: an early-claiming reduction on a survivor benefit (the survivor is paid
 * the deceased's benefit, not reduced for the survivor's own age), a separate survivor claiming
 * strategy, the retirement earnings test, and dependent (child) benefits.
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
  /**
   * The COLA the plan assumes, as a percentage: the income's own rate, or the plan's inflation rate
   * when the income omitted it (0 when the plan has no inflation assumption at all).
   */
  readonly colaRate: number;
  /** Real growth implied by `colaRate` against the plan's inflation; absent without inflation. */
  readonly realColaGrowthRate: number | undefined;
}

export interface SocialSecurityEstimateInput {
  /** The income's stored `socialSecurity` block: mode, AIME or PIA, claim age, COLA. */
  readonly socialSecurity: SocialSecurityInputs;
  /** The plan member's birth year, from the timeline — the FRA depends on it and nothing else. */
  readonly birthYear: number;
  /**
   * The plan's inflation assumption, as a percentage, so the COLA can be read in real terms. It is
   * also the COLA an income that left `colaRate` unset is paid by.
   */
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
  // An omitted COLA holds the real benefit flat (see the module doc): it takes the plan's inflation
  // assumption, so `realBenefitGrowthRate` is exactly 0. Defaulting to 0 instead would erode the
  // benefit by the plan's whole inflation rate every year — about 0.41× its value after thirty
  // years at 3% — which is a decision nobody made by leaving a field blank. With no inflation
  // assumption there is no real basis, and 0 is the only honest reading.
  const colaRate = socialSecurity.colaRate ?? inflationRate ?? 0;

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

// ============================================================================
// Spousal and survivor benefits (P1-P8)
// ============================================================================

/** SSA's spousal reduction: 25/36 of 1% per month for the first 36 months early, then 5/12 of 1% (20 CFR 404.410). */
const SPOUSAL_REDUCTION_PER_MONTH_FIRST_36 = 25 / 36 / 100;
const SPOUSAL_REDUCTION_PER_MONTH_AFTER_36 = 5 / 12 / 100;

/** The survivor floor (RIB-LIM, Social Security Act §202(e)(2)(D)): a survivor is never paid below 82.5% of the deceased's PIA. */
const SURVIVOR_FLOOR_SHARE = 0.825;

/**
 * The fraction of a spousal benefit that is payable, given the months it starts before the spouse's
 * full retirement age. No delayed credits attach to a spousal benefit, so a spousal claim after FRA
 * is paid at its full amount.
 *
 * Worked cases: 36 months early → 25% reduction, factor 0.75; 60 months early → 25% + 24 × 5/12% = 10%,
 * so 35% reduction and factor 0.65.
 */
export function spousalReductionFactor(monthsEarly: number): number {
  const months = Math.max(0, monthsEarly);
  const reduction =
    Math.min(months, 36) * SPOUSAL_REDUCTION_PER_MONTH_FIRST_36 + Math.max(0, months - 36) * SPOUSAL_REDUCTION_PER_MONTH_AFTER_36;

  return 1 - reduction;
}

export interface SpousalExcessInput {
  /** The spouse's own PIA, monthly, today's dollars. */
  readonly ownPia: number;
  /** The other member's PIA, monthly, today's dollars. Spousal benefits are measured on the worker's PIA, not on what they claim. */
  readonly otherPia: number;
  /** The spouse's own age when the spousal benefit starts (member age, not plan age). */
  readonly claimAge: number;
  /** The spouse's own full retirement age. */
  readonly fra: FullRetirementAge;
}

/**
 * The monthly spousal add-on a spouse receives on top of their own benefit (20 CFR 404.410): up to
 * 50% of the other member's PIA, less the spouse's own PIA, so the spouse is paid the larger of the
 * two. The excess is reduced for each month the spousal benefit starts before the spouse's FRA, and
 * is not reduced at or after it.
 *
 * Worked cases (other PIA $3,000, own PIA $1,000, so the excess is $1,500 − $1,000 = $500):
 * - spousal starts at FRA 67 → no reduction, $500 a month;
 * - spousal starts at 65 with FRA 67 → 24 months early → 24 × 25/36% = 16 2/3% → factor 5/6, $416.67 a month.
 * With own PIA $1,500 the excess is $0, whatever the claim age.
 */
export function spousalExcess({ ownPia, otherPia, claimAge, fra }: SpousalExcessInput): number {
  const excess = Math.max(0, 0.5 * otherPia - ownPia);
  const { monthsEarly } = claimingAdjustment(claimAge, fra);

  return excess * spousalReductionFactor(monthsEarly);
}

export interface SurvivorBenefitInput {
  /** The deceased's PIA, monthly, today's dollars. */
  readonly pia: number;
  /** The deceased's claim age (member age). */
  readonly claimAge: number;
  /** The age at which the deceased died (member age). */
  readonly deathAge: number;
  /** The deceased's full retirement age. */
  readonly fra: FullRetirementAge;
  /**
   * The survivor's own early-claiming factor (`survivorReductionFactor`); 1 for a survivor benefit
   * that starts at or after the survivor's FRA, which is also the default.
   */
  readonly survivorFactor?: number;
}

/** The earliest age a survivor benefit can start on age alone (Social Security Act §202(e)(1)(B)(i)). */
export const EARLIEST_SURVIVOR_CLAIM_AGE = 60;

/** The largest survivor reduction, at age 60: 28.5% (Social Security Act §202(q)(1)(A); 20 CFR 404.410(b)). */
const MAX_SURVIVOR_REDUCTION = 0.285;

/**
 * The fraction of a survivor benefit that is payable when it starts at `claimAge` (the survivor's
 * own age, in years), against the survivor's own survivor FRA (`survivorFullRetirementAge`).
 *
 * The reduction runs linearly from 28.5% at 60 to nothing at the survivor FRA, by the month: the
 * statute spreads the 28.5% over the months between 60 and that FRA (§202(q)(1)(A)). A claim at or
 * after the FRA is paid in full; there are no delayed credits on a survivor benefit.
 *
 * Worked cases, survivor FRA 67 (84 months after 60): at 60 → factor 0.715; at 63 → 48 months early
 * → 0.285 × 48 / 84 = 16.29% → 0.83714; at 67 → 1.
 */
export function survivorReductionFactor(claimAge: number, survivorFra: FullRetirementAge): number {
  const claimMonths = Math.round(Math.max(EARLIEST_SURVIVOR_CLAIM_AGE, claimAge) * 12);
  const spanMonths = survivorFra.totalMonths - EARLIEST_SURVIVOR_CLAIM_AGE * 12;
  const monthsEarly = Math.min(Math.max(0, survivorFra.totalMonths - claimMonths), spanMonths);

  return spanMonths > 0 ? 1 - (MAX_SURVIVOR_REDUCTION * monthsEarly) / spanMonths : 1;
}

/**
 * The monthly survivor benefit a surviving spouse is paid on the deceased's record (Social Security Act
 * §202(e)-(f); the RIB-LIM floor is §202(e)(2)(D)), in today's dollars.
 *
 * - The deceased had claimed by death: the benefit they were being paid (their claiming adjustment,
 *   delayed credits included), but never less than 82.5% of their PIA (the RIB-LIM floor).
 * - The deceased died before claiming: their PIA with only the delayed credits earned up to the
 *   death age; no reduction applies, because they never claimed.
 *
 * Worked cases (PIA $1,000, FRA 67):
 * - claimed at 62 → 70% = $700, floor 82.5% = $825, so $825;
 * - claimed at 70 → 124% = $1,240, above the floor, so $1,240;
 * - died at 68 before claiming at 70 → 12 months late → 8% credit → $1,080;
 * - died at 64 before claiming at 70 → no credit → $1,000.
 *
 * With `survivorFactor` (the survivor claiming before their own survivor FRA), the same cases at a
 * factor of 0.715 (survivor claims at 60): claimed at 62 → min($715, max($700, $825)) = $715;
 * claimed at 70 → $1,240 × 0.715 = $886.60.
 */
export function survivorBenefit({ pia, claimAge, deathAge, fra, survivorFactor = 1 }: SurvivorBenefitInput): number {
  if (deathAge >= claimAge) {
    const adjustment = claimingAdjustment(claimAge, fra);
    const payable = pia * adjustment.factor;

    // Delayed credits carry over to the survivor, and the survivor's own reduction applies to them.
    if (adjustment.factor >= 1) return payable * survivorFactor;

    // The deceased claimed early: the survivor's rate is the PIA, reduced for the survivor's own age,
    // and then limited to the larger of the deceased's reduced benefit and 82.5% of the PIA (RIB-LIM,
    // §202(e)(2)(D); POMS RS 00615.320). At the survivor's FRA this is the floor rule above.
    return Math.min(pia * survivorFactor, Math.max(payable, SURVIVOR_FLOOR_SHARE * pia));
  }

  return pia * (1 + claimingAdjustment(deathAge, fra).credit) * survivorFactor;
}
