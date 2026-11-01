/**
 * The household's Social Security, across lines (P1-P8, extended in v20).
 *
 * One object per run holds every rule that reads more than one line: the spousal add-on, the
 * survivor top-up (with the survivor's own early-claiming reduction and their own survivor claim
 * age), children's benefits, the family maximum that caps a record, and the earnings-test state
 * that a withheld month leaves behind (the recomputation at FRA). `incomes.ts` asks it what each
 * record line pays in a month; the line itself still decides whether it is active.
 *
 * ## Which line is a member's record
 *
 * A member's **record line** is their one Social Security income, or — when they have more than one
 * — the one that carries a `socialSecurity` block, if exactly one does. Any other Social Security
 * line of theirs pays its stored figure and nothing else. A member whose lines leave the record
 * ambiguous (two blocks, or several lines with none) has no record line and takes no part.
 *
 * A record line either carries a block, so its PIA is known, or carries only a stated amount. A
 * stated amount is enough for the survivor rule — the survivor is paid the larger of their own
 * benefit and the deceased's, reduced for the survivor's age — but not for the rules measured on a
 * PIA: the spousal add-on, children's rates and the family maximum need a block on the worker's line.
 *
 * ## Timing
 *
 * - *Spousal* (20 CFR 404.410): from the later of the two claims, while the worker lives.
 * - *Survivor* (§202(e)-(f)): from the latest of the death, the survivor's survivor claim age
 *   (`socialSecurity.survivorClaimAge`, else their own claim age, else their survivor FRA when they
 *   have no line) and age 60. The deceased's line pays `max(0, S − own)`, where `own` is the
 *   survivor's own benefit once *their* claim age is reached and 0 before: claiming the survivor
 *   benefit early and switching to one's own, larger benefit at 70 is a strategy this models.
 * - *Children* (§202(d)): on a living worker's record from the worker's claim, on a deceased
 *   worker's from the death; on whichever record pays the child more.
 *
 * Every age here is on the plan axis; a member's own age is `planAge - ageOffset`.
 */

import type { IncomeInputs } from '@/lib/schemas/inputs/income-form-schema';
import { type HouseholdMemberRole, ownerOf } from '@/lib/schemas/inputs/household-schema';

import { type FullRetirementAge, fullRetirementAge, survivorFullRetirementAge } from './fra-table';
import {
  claimingAdjustment,
  EARLIEST_SURVIVOR_CLAIM_AGE,
  estimateSocialSecurityBenefit,
  type SocialSecurityEstimate,
  spousalReductionFactor,
  survivorBenefit,
  survivorReductionFactor,
} from './social-security';
import {
  CHILD_SHARE_DECEASED_WORKER,
  CHILD_SHARE_LIVING_WORKER,
  familyMaximum,
  familyMaximumFactor,
  isChildEntitled,
} from './social-security-family';

/** A member, as the household rules need them. */
export interface SocialSecurityMember {
  readonly role: HouseholdMemberRole;
  /** `planAge = memberAge + ageOffset`. */
  readonly ageOffset: number;
  /** The plan-axis age at which this member dies; `Infinity` when the run ends first. */
  readonly deathPlanAge: number;
  readonly birthYear: number;
}

/** A child of the household, on the plan axis: `planAge - ageOffset` is the child's age. */
export interface SocialSecurityChild {
  readonly id: string;
  readonly ageOffset: number;
  readonly student: boolean;
}

interface RecordLine {
  readonly lineId: string;
  /** Present when the line carries a block; absent for a stated-amount line. */
  readonly estimate: SocialSecurityEstimate | undefined;
  /** The member's own claim age (their years), when the line carries a block. */
  readonly claimAge: number | undefined;
  /** The member's survivor claim age (their years), when stated. */
  readonly survivorClaimAge: number | undefined;
}

interface MemberState extends SocialSecurityMember {
  readonly fra: FullRetirementAge;
  readonly survivorFra: FullRetirementAge;
  readonly record: RecordLine | undefined;
  /** True when the member has Social Security lines but no record line can be named. */
  readonly ambiguous: boolean;
}

const otherRole = (role: HouseholdMemberRole): HouseholdMemberRole => (role === 'primary' ? 'partner' : 'primary');

/** Real growth after `years` whole years at `rate`. */
const grown = (amount: number, rate: number, years: number): number => amount * Math.pow(1 + rate, years);

/** A blockless line's stated benefit, as its own `Income` currently pays it (annual, today's dollars). */
export type StatedBenefitLookup = (lineId: string) => number;

export class HouseholdSocialSecurity {
  private readonly members = new Map<HouseholdMemberRole, MemberState>();
  private readonly recordOwnerByLine = new Map<string, HouseholdMemberRole>();
  /** Earnings-test withholding against each member's own benefit, in months of that benefit (§202(q)(7)). */
  private readonly withheldMonths = new Map<HouseholdMemberRole, number>();
  private statedBenefit: StatedBenefitLookup = () => 0;

  /**
   * @param familyMaximumYear - The year whose family-maximum bend points apply (the plan's start year;
   *   the points are wage-indexed, so in today's dollars they are the projection).
   */
  constructor(
    lines: readonly IncomeInputs[],
    members: readonly SocialSecurityMember[],
    private readonly children: readonly SocialSecurityChild[],
    private readonly familyMaximumYear: number,
    inflationRate: number
  ) {
    for (const member of members) {
      const own = lines.filter(
        (income) => !income.disabled && ownerOf(income) === member.role && income.taxes.incomeType === 'socialSecurity'
      );
      const withBlock = own.filter((income) => income.socialSecurity !== undefined);
      const recordInput = own.length === 1 ? own[0] : withBlock.length === 1 ? withBlock[0] : undefined;
      const record: RecordLine | undefined =
        recordInput === undefined
          ? undefined
          : {
              lineId: recordInput.id,
              estimate:
                recordInput.socialSecurity === undefined
                  ? undefined
                  : estimateSocialSecurityBenefit({
                      socialSecurity: recordInput.socialSecurity,
                      birthYear: member.birthYear,
                      inflationRate,
                    }),
              claimAge: recordInput.socialSecurity?.claimAge,
              survivorClaimAge: recordInput.socialSecurity?.survivorClaimAge,
            };

      this.members.set(member.role, {
        ...member,
        fra: fullRetirementAge(member.birthYear),
        survivorFra: survivorFullRetirementAge(member.birthYear),
        record,
        ambiguous: own.length > 0 && record === undefined,
      });
      if (record !== undefined) this.recordOwnerByLine.set(record.lineId, member.role);
    }
  }

  /** Lets the deceased's stated-amount line read the survivor's stated-amount line (set by `Incomes`). */
  setStatedBenefitLookup(lookup: StatedBenefitLookup): void {
    this.statedBenefit = lookup;
  }

  /** Whether `lineId` is a member's record line, whose payment this object decides. */
  isRecordLine(lineId: string): boolean {
    return this.recordOwnerByLine.has(lineId);
  }

  /** The member whose record line `lineId` is. */
  recordOwnerOf(lineId: string): HouseholdMemberRole | undefined {
    return this.recordOwnerByLine.get(lineId);
  }

  /** Who receives what `lineId` pays at `planAge`: its owner, or the survivor once it pays a top-up. */
  receiverOf(lineId: string, planAge: number): HouseholdMemberRole | undefined {
    const owner = this.recordOwnerByLine.get(lineId);
    if (owner === undefined) return undefined;

    return this.isDead(owner, planAge) ? otherRole(owner) : owner;
  }

  /** The member's FRA on the plan axis (the earnings test stops there). */
  fraPlanAge(role: HouseholdMemberRole): number | undefined {
    const member = this.members.get(role);
    return member === undefined ? undefined : member.fra.totalMonths / 12 + member.ageOffset;
  }

  ageOffsetOf(role: HouseholdMemberRole): number | undefined {
    return this.members.get(role)?.ageOffset;
  }

  /** Earnings-test withholding taken from `role`'s own benefit, in months of that benefit. */
  recordWithholding(role: HouseholdMemberRole, monthsOfBenefit: number): void {
    if (monthsOfBenefit > 0) this.withheldMonths.set(role, (this.withheldMonths.get(role) ?? 0) + monthsOfBenefit);
  }

  /** A deceased member's record line is due at `planAge` only while it pays a survivor top-up. */
  isSurvivorBenefitDue(lineId: string, planAge: number): boolean {
    const owner = this.recordOwnerByLine.get(lineId);
    if (owner === undefined) return false;

    const start = this.survivorStartPlanAge(owner);
    return start !== undefined && planAge >= start;
  }

  /**
   * What a record line pays for the year at `planAge` (annual, today's dollars), after `years` of COLA.
   * @param statedAnnual - the line's own stated benefit for the year, for a line without a block
   */
  annualPayment(lineId: string, planAge: number, years: number, statedAnnual: number): number {
    const owner = this.recordOwnerByLine.get(lineId);
    const member = owner === undefined ? undefined : this.members.get(owner);
    if (owner === undefined || member === undefined) return statedAnnual;

    if (this.isDead(owner, planAge)) return this.survivorTopUp(member, planAge, years, statedAnnual);

    const estimate = member.record?.estimate;
    if (estimate === undefined) return statedAnnual;

    const growth = estimate.realColaGrowthRate ?? 0;
    return grown(this.ownMonthly(member, planAge) * 12, growth, years) + grown(this.spousalMonthly(member, planAge) * 12, growth, years);
  }

  /** Children's benefits for the year at `planAge`, per worker record (annual, today's dollars). */
  annualChildBenefitsByRecord(planAge: number, years: number): Map<HouseholdMemberRole, number> {
    const byRecord = new Map<HouseholdMemberRole, number>();

    for (const child of this.children) {
      const choice = this.childRecord(child, planAge);
      if (choice === undefined) continue;

      const worker = this.members.get(choice.role)!;
      const factor = this.familyFactor(choice.role, planAge);
      const amount = grown(choice.monthly * factor * 12, worker.record?.estimate?.realColaGrowthRate ?? 0, years);
      byRecord.set(choice.role, (byRecord.get(choice.role) ?? 0) + amount);
    }

    return byRecord;
  }

  // ==========================================================================
  // Rules
  // ==========================================================================

  private isDead(role: HouseholdMemberRole, planAge: number): boolean {
    const member = this.members.get(role);
    return member !== undefined && planAge >= member.deathPlanAge;
  }

  private claimPlanAge(member: MemberState): number | undefined {
    return member.record?.claimAge === undefined ? undefined : member.record.claimAge + member.ageOffset;
  }

  /** Whether `member` is being paid their own retirement benefit at `planAge`. */
  private isClaimed(member: MemberState, planAge: number): boolean {
    const claim = this.claimPlanAge(member);
    return claim !== undefined && planAge >= claim && !this.isDead(member.role, planAge);
  }

  /** The earnings-test recomputation (§202(q)(7)): withheld months count as if the claim were later. */
  private recomputedMonthsEarly(member: MemberState, planAge: number, monthsEarly: number): number {
    if (planAge - member.ageOffset < member.fra.totalMonths / 12) return monthsEarly;

    return Math.max(0, monthsEarly - Math.floor((this.withheldMonths.get(member.role) ?? 0) + 1e-9));
  }

  /** The member's own monthly retirement benefit at `planAge`, before COLA growth. */
  private ownMonthly(member: MemberState, planAge: number): number {
    const estimate = member.record?.estimate;
    if (estimate === undefined) return 0;

    const { monthsEarly } = estimate.claiming;
    if (monthsEarly === 0) return estimate.monthlyBenefit;

    const recomputed = this.recomputedMonthsEarly(member, planAge, monthsEarly);
    if (recomputed === monthsEarly) return estimate.monthlyBenefit;

    // Re-read the claiming adjustment at the later, recomputed claim age.
    const laterClaimAge = (estimate.fullRetirementAge.totalMonths - recomputed) / 12;
    return estimate.pia * claimingAdjustment(laterClaimAge, estimate.fullRetirementAge).factor;
  }

  /** The spousal add-on (20 CFR 404.410), monthly, after the family maximum on the worker's record. */
  private spousalMonthly(member: MemberState, planAge: number): number {
    const worker = this.members.get(otherRole(member.role));
    const ownEstimate = member.record?.estimate;
    const workerPia = worker?.record?.estimate?.pia;
    if (worker === undefined || ownEstimate === undefined || workerPia === undefined) return 0;
    if (!this.isSpousalActive(member, planAge)) return 0;

    const start = Math.max(this.claimPlanAge(member)!, this.claimPlanAge(worker)!);
    const { monthsEarly } = claimingAdjustment(start - member.ageOffset, member.fra);
    const rate = 0.5 * workerPia * this.familyFactor(worker.role, planAge);

    return Math.max(0, rate - ownEstimate.pia) * spousalReductionFactor(this.recomputedMonthsEarly(member, planAge, monthsEarly));
  }

  private isSpousalActive(member: MemberState, planAge: number): boolean {
    const worker = this.members.get(otherRole(member.role));
    if (worker === undefined || worker.record?.estimate === undefined || member.record?.estimate === undefined) return false;
    if (this.isDead(worker.role, planAge) || !this.isClaimed(member, planAge) || !this.isClaimed(worker, planAge)) return false;

    return 0.5 * worker.record.estimate.pia > member.record.estimate.pia;
  }

  /** When the survivor top-up on `deceasedRole`'s line starts, or `undefined` when it never does. */
  private survivorStartPlanAge(deceasedRole: HouseholdMemberRole): number | undefined {
    const deceased = this.members.get(deceasedRole);
    const survivor = this.members.get(otherRole(deceasedRole));
    if (deceased?.record === undefined || survivor === undefined || survivor.ambiguous) return undefined;
    if (!Number.isFinite(deceased.deathPlanAge) || survivor.deathPlanAge <= deceased.deathPlanAge) return undefined;
    // A stated-amount line is enough for the deceased's side only when the survivor side is known too.
    if (deceased.record.estimate === undefined && survivor.record !== undefined && survivor.record.estimate === undefined) {
      // Both stated: still the larger of the two, so this is supported.
    }

    const survivorClaimAge = survivor.record?.survivorClaimAge ?? survivor.record?.claimAge ?? survivor.survivorFra.totalMonths / 12;

    return Math.max(deceased.deathPlanAge, survivorClaimAge + survivor.ageOffset, EARLIEST_SURVIVOR_CLAIM_AGE + survivor.ageOffset);
  }

  /** The deceased's line: `max(0, S × family factor − the survivor's own benefit paid)` (annual). */
  private survivorTopUp(deceased: MemberState, planAge: number, years: number, statedAnnual: number): number {
    const start = this.survivorStartPlanAge(deceased.role);
    const survivor = this.members.get(otherRole(deceased.role));
    if (start === undefined || survivor === undefined || planAge < start) return 0;

    const survivorFactor = survivorReductionFactor(start - survivor.ageOffset, survivor.survivorFra);
    const deceasedEstimate = deceased.record?.estimate;

    const survivorAnnual =
      deceasedEstimate === undefined
        ? statedAnnual * survivorFactor
        : grown(
            survivorBenefit({
              pia: deceasedEstimate.pia,
              claimAge: deceased.record!.claimAge!,
              deathAge: deceased.deathPlanAge - deceased.ageOffset,
              fra: deceasedEstimate.fullRetirementAge,
              survivorFactor,
            }) *
              12 *
              this.familyFactor(deceased.role, planAge),
            deceasedEstimate.realColaGrowthRate ?? 0,
            years
          );

    return Math.max(0, survivorAnnual - this.survivorOwnAnnual(survivor, planAge, years));
  }

  /** What the survivor is paid on their own record at `planAge` (annual): 0 before their own claim. */
  private survivorOwnAnnual(survivor: MemberState, planAge: number, years: number): number {
    const record = survivor.record;
    if (record === undefined) return 0;
    if (record.estimate === undefined) return this.statedBenefit(record.lineId);
    if (!this.isClaimed(survivor, planAge)) return 0;

    return grown(this.ownMonthly(survivor, planAge) * 12, record.estimate.realColaGrowthRate ?? 0, years);
  }

  /** The record a child is paid on at `planAge`, and the child's monthly rate before the family maximum. */
  private childRecord(child: SocialSecurityChild, planAge: number): { role: HouseholdMemberRole; monthly: number } | undefined {
    if (!isChildEntitled(planAge - child.ageOffset, child.student)) return undefined;

    let best: { role: HouseholdMemberRole; monthly: number } | undefined;
    for (const worker of this.members.values()) {
      const pia = worker.record?.estimate?.pia;
      if (pia === undefined) continue;

      const monthly = this.isDead(worker.role, planAge)
        ? CHILD_SHARE_DECEASED_WORKER * pia
        : this.isClaimed(worker, planAge)
          ? CHILD_SHARE_LIVING_WORKER * pia
          : 0;
      if (monthly > 0 && (best === undefined || monthly > best.monthly)) best = { role: worker.role, monthly };
    }

    return best;
  }

  /**
   * The family-maximum factor on `workerRole`'s record at `planAge` (§203(a)): every auxiliary or
   * survivor claim on the record is multiplied by it. 1 when the claims fit, or the record has no PIA.
   */
  private familyFactor(workerRole: HouseholdMemberRole, planAge: number): number {
    const worker = this.members.get(workerRole);
    const pia = worker?.record?.estimate?.pia;
    if (worker === undefined || pia === undefined) return 1;

    const maximum = familyMaximum(pia, this.familyMaximumYear);
    const claims: number[] = [];
    for (const child of this.children) {
      const choice = this.childRecord(child, planAge);
      if (choice?.role === workerRole) claims.push(choice.monthly);
    }

    const spouse = this.members.get(otherRole(workerRole));
    if (this.isDead(workerRole, planAge)) {
      const start = this.survivorStartPlanAge(workerRole);
      if (spouse !== undefined && start !== undefined && planAge >= start && worker.record?.claimAge !== undefined) {
        claims.push(
          survivorBenefit({
            pia,
            claimAge: worker.record.claimAge,
            deathAge: worker.deathPlanAge - worker.ageOffset,
            fra: worker.fra,
          })
        );
      }
      return familyMaximumFactor(maximum, claims);
    }

    if (spouse !== undefined && this.isSpousalActive(spouse, planAge)) claims.push(0.5 * pia);
    return familyMaximumFactor(maximum - pia, claims);
  }
}
