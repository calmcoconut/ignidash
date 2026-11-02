/**
 * Medicare enrolment and premiums for the household's members.
 *
 * Two charges read the same enrolment rule:
 *
 * - **IRMAA** (42 U.S.C. §1395r(i), §1395w-113(a)(7)), the income-related surcharge, is a liability
 *   settled with the year's taxes in `taxes.ts`. It is charged per **enrolled beneficiary**, for each
 *   month that beneficiary is enrolled: a joint return with both spouses on Medicare pays the tier
 *   twice, and nobody under the enrolment age pays it at all.
 * - **Base premiums** — the standard Part B premium (42 U.S.C. §1395r(a)), a Part D premium and any
 *   supplemental (Medigap or Medicare Advantage) premium — are opt-in expenses charged monthly by
 *   the expenses processor, because the cash leaves the household whether or not a return is filed.
 *   They are opt-in because a plan may already carry its healthcare costs as an expense line, and
 *   charging both would count the same premium twice.
 *
 * Enrolment starts at the member's own `enrollmentAge` (65 by default, the age of entitlement under
 * 42 U.S.C. §426(a)) and ends at their death. Every age here is on the plan axis: a member's own age
 * is `planAge - ageOffset`, the convention `ageOffsetByOwner` uses everywhere else.
 *
 * Part B and Part D premiums are qualified medical expenses for an HSA once the holder is 65 (IRC
 * §223(d)(2)(B)-(C)); a Medigap premium is not (§223(d)(2)(C)(iv) excludes it), so the two lines
 * are reported separately and only the first is offered to the HSA pairing.
 */

import type { HouseholdMemberRole } from '@/lib/schemas/inputs/household-schema';

/** The age of Medicare entitlement for a retiree (42 U.S.C. §426(a)(1)). */
export const MEDICARE_ELIGIBILITY_AGE = 65;

/** One household member, as the enrolment rule needs them. */
export interface MedicareMember {
  readonly role: HouseholdMemberRole;
  /** `planAge - ageOffset` is this member's own age. */
  readonly ageOffset: number;
  /** The plan-axis age at which this member dies; enrolment ends there. */
  readonly deathAge: number;
}

/** The single member a plan without a household has: the primary, on the plan's own axis. */
export const SOLE_MEDICARE_MEMBER: readonly MedicareMember[] = [{ role: 'primary', ageOffset: 0, deathAge: Infinity }];

/** Whether `member` is enrolled in the month whose plan-axis age is `planAge`. */
export function isEnrolledInMedicare(member: MedicareMember, planAge: number, enrollmentAge: number = MEDICARE_ELIGIBILITY_AGE): boolean {
  if (planAge >= member.deathAge) return false;
  // A small tolerance, because `startAge + months / 12` is not exact and a member who turns 65 in a
  // month must read as 65 in that month, not as 64.9999999.
  return planAge - member.ageOffset >= enrollmentAge - 1e-9;
}

/** The number of `members` enrolled in the month whose plan-axis age is `planAge`. */
export function enrolledMedicareMembers(
  members: readonly MedicareMember[],
  planAge: number,
  enrollmentAge: number = MEDICARE_ELIGIBILITY_AGE
): number {
  return members.reduce((count, member) => count + (isEnrolledInMedicare(member, planAge, enrollmentAge) ? 1 : 0), 0);
}

/**
 * Enrolled member-months in the twelve months that end at `yearEndPlanAge`.
 *
 * The engine settles a year after its twelfth month, when `simulationState.time.age` is that month's
 * age; the year's months are therefore `yearEndPlanAge - k / 12` for `k = 0..11`.
 */
export function enrolledMedicareMemberMonths(
  members: readonly MedicareMember[],
  yearEndPlanAge: number,
  enrollmentAge: number = MEDICARE_ELIGIBILITY_AGE
): number {
  let months = 0;
  for (let k = 0; k < 12; k++) months += enrolledMedicareMembers(members, yearEndPlanAge - k / 12, enrollmentAge);
  return months;
}

/** The monthly premium rates the plan pays per enrolled member, before any IRMAA surcharge. */
export interface MedicarePremiumRates {
  readonly partBMonthly: number;
  readonly partDMonthly: number;
  readonly supplementalMonthly: number;
}

/** What the expenses processor needs to charge base premiums each month. */
export interface MedicarePremiumSchedule {
  readonly members: readonly MedicareMember[];
  readonly enrollmentAge: number;
  /** The rates for the month `monthsElapsed` after the plan's start (tax-year dependent). */
  readonly ratesForMonth: (monthsElapsed: number) => MedicarePremiumRates;
}

/** Ids of the two expense rows the schedule produces; namespaced so no plan expense can collide. */
export const MEDICARE_PARTS_B_D_EXPENSE_ID = 'medicare:parts-b-d';
export const MEDICARE_SUPPLEMENTAL_EXPENSE_ID = 'medicare:supplemental';

/** This month's base premiums: Parts B and D (HSA-qualified), and the supplemental premium. */
export function monthlyMedicarePremiums(
  schedule: MedicarePremiumSchedule,
  planAge: number,
  monthsElapsed: number
): { partsBAndD: number; supplemental: number } {
  const enrolled = enrolledMedicareMembers(schedule.members, planAge, schedule.enrollmentAge);
  if (enrolled === 0) return { partsBAndD: 0, supplemental: 0 };

  const rates = schedule.ratesForMonth(monthsElapsed);
  return {
    partsBAndD: enrolled * (rates.partBMonthly + rates.partDMonthly),
    supplemental: enrolled * rates.supplementalMonthly,
  };
}
