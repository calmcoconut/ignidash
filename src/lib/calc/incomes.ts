/**
 * Income processing for the simulation engine
 *
 * Handles multiple income sources with varying frequencies, time frames,
 * growth rates, and tax treatments (wage, exempt, Social Security) and applies
 * the payroll withholding this month's paycheques carry.
 *
 * Payroll tax is *not* computed here any more (P3-P4): FICA, the Additional Medicare Tax, the
 * self-employment tax and California SDI live in `./payroll-taxes`, which reads the tax ruleset.
 * This module only applies the withholding that layer returns, so the wage base, the Additional
 * Medicare threshold and the SDI rate have exactly one home.
 *
 * ## Which figure is paid: `amount` or the Social Security estimate (P1-P8)
 *
 * A Social Security income always carries a stored `amount`, because the form requires one. An
 * income that *also* carries a `socialSecurity` block is paid from the estimate instead, in both of
 * that block's modes:
 *
 * | income | what is paid |
 * | --- | --- |
 * | `incomeType: 'socialSecurity'` with a `socialSecurity` block | `estimateSocialSecurityBenefit()`: AIME → PIA → the claim-age adjustment for the earner's full retirement age → COLA as real growth |
 * | `incomeType: 'socialSecurity'` without a block | the stored `amount`, grown by `growth.growthRate` |
 * | any other `incomeType` with a block | the stored `amount`; the block does not apply to a non-Social-Security income |
 *
 * The estimate supersedes `amount`, `growth.growthRate`, `growth.growthLimit` and `amountBasis`
 * outright — it is not blended with the stored figure. AIME, PIA and the benefit derived from them
 * are today's dollars by definition, and the COLA is the growth the estimate already models, so the
 * amount's growth rate would be a second, wrong growth. `incomes.test.ts` pins the precedence with
 * an `amount` deliberately set to a different number.
 *
 * The estimate is still paid as Social Security, not as ordinary income: the benefit is reported as
 * `socialSecurityIncome` and withheld like any Social Security income, and never as
 * `taxFreeIncome`, so `taxes.ts` reaches it through §86's provisional income. Paying an estimate
 * must not quietly move it into the earned-income bucket.
 *
 * ## Spousal and survivor benefits (P1-P8, E2)
 *
 * A couple's lines are wired by `householdSocialSecurityTerms` in this module, with the two rules in
 * `social-security.ts`. A member has either no Social Security line, or exactly one line with a
 * `socialSecurity` block; a member with no line has no benefit of their own, which is what a
 * survivor with no line is paid against. The rules:
 *
 * - *Spousal* (20 CFR 404.410): while the other member lives, a line adds the spousal excess from the
 *   later of the two claim dates. The start is at the earner's own age, so the reduction uses the
 *   earner's own FRA.
 * - *Survivor* (Social Security Act §202(e)-(f), RIB-LIM at §202(e)(2)(D)): the line of the member who dies first stops paying their
 *   own benefit and pays the survivor top-up, `max(0, survivor benefit − the survivor's own
 *   benefit)`, from the later of the death and the survivor's own claim age (the survivor's FRA when
 *   they have no line). The top-up is taxed as Social Security. Its own timeframe does not cut it
 *   short, because the survivor's benefit runs for the survivor's life.
 *
 * Anything else leaves the lines as they were. A member with more than one Social Security line, or
 * with a line that carries no block, is left out of the couple rules: that line pays its stored or
 * own figure, a deceased member's line stops at death as it always did, a survivor who is left out
 * gives no top-up, and nothing spousal is added to a line whose other member is left out. A `joint`
 * line is never wired. A household of one has no `coupleAgeOffsets`, so none of this applies to it.
 *
 * Boundaries: no early-claiming reduction on a survivor benefit, no separate survivor claiming
 * strategy, no earnings test, no dependent benefits. A Social Security income pays the earner's own
 * retirement benefit, with the spousal and survivor terms above, and nothing else whatever its
 * `owner`. The claim age in the block adjusts the amount; the income's own timeframe decides when
 * its own benefit starts being paid, while the spousal and survivor starts are the claim dates.
 */

import type { IncomeInputs, IncomeType } from '@/lib/schemas/inputs/income-form-schema';
import { type HouseholdMemberRole, type Owner, ownerOf } from '@/lib/schemas/inputs/household-schema';

import type { PayrollTaxProcessor } from './payroll-taxes';
import { estimateSocialSecurityBenefit, type SocialSecurityEstimate } from './social-security';
import { HouseholdSocialSecurity, type SocialSecurityChild } from './social-security-household';
import {
  EARNINGS_TEST_FRA_YEAR_WITHHOLDING_RATE,
  EARNINGS_TEST_WITHHOLDING_RATE,
  earningsTestAmountsFor,
  earningsTestWithholding,
} from './social-security-family';

/** Id prefix of the child-benefit rows, one per worker record (`social-security:children:primary`). */
export const CHILD_BENEFIT_ROW_PREFIX = 'social-security:children:';
import { TimeBinding, type TimeBindingContext } from './time-binding';

import type { SimulationState } from './simulation-engine';

/** Processes all active incomes each month and aggregates annual totals */
export class IncomesProcessor {
  private monthlyData: IncomesData[] = [];

  /**
   * @param splitByOwner - Whether to also aggregate the year's totals **per owner** (P3-P1b).
   *   True only when the household files **two** returns (`marriedFilingSeparately`), because
   *   `perOwnerData` is what that split divides. False everywhere else — a joint household's totals
   *   are the household's, and a household of one's totals already are its only member's — so a run
   *   that files one return keeps exactly the income data it had before the field existed (the
   *   frozen golden corpus is the witness).
   */
  constructor(
    private simulationState: SimulationState,
    private incomes: Incomes,
    private payrollTaxProcessor: PayrollTaxProcessor,
    private readonly splitByOwner: boolean = false
  ) {}

  /**
   * Processes all active incomes for the current month
   * @returns Aggregated income data with per-income breakdowns
   */
  process(): IncomesData {
    const activeIncomes = this.incomes.getActiveIncomesByTimeFrame(this.simulationState);

    // Payroll withholding is applied per income, in order, so two wage incomes in the same month
    // share one annual OASDI wage base instead of each getting a fresh one.
    const processedIncomes: IncomeData[] = activeIncomes.map((income) => {
      const monthly = income.processMonthlyAmount(this.simulationState.time.year);
      const payrollTax = income.getIncomeType() === 'wage' ? this.payrollTaxProcessor.processMonthlyWages(monthly.income) : null;
      const ficaTax = payrollTax?.total ?? 0;

      return {
        ...monthly,
        ficaTax,
        incomeAfterPayrollDeductions: monthly.income - monthly.amountWithheld - ficaTax,
      };
    });

    // Children's benefits and the earnings test (v20) read every line of the month at once, so they
    // run after each line has been priced. The child rows are the child's income, not the parents':
    // tax-free here, and kept out of the per-owner split that divides a separate-return pair.
    const childRows = this.incomes.applySocialSecurityHouseholdRules(activeIncomes, processedIncomes, this.simulationState);
    const allRows = [...processedIncomes, ...childRows];

    const totals = allRows.reduce(
      (acc, curr) => {
        acc.totalIncome += curr.income;
        acc.totalAmountWithheld += curr.amountWithheld;
        acc.totalFicaTax += curr.ficaTax;
        acc.totalIncomeAfterPayrollDeductions += curr.incomeAfterPayrollDeductions;
        acc.totalTaxFreeIncome += curr.taxFreeIncome;
        acc.totalSocialSecurityIncome += curr.socialSecurityIncome;
        return acc;
      },
      {
        totalIncome: 0,
        totalAmountWithheld: 0,
        totalFicaTax: 0,
        totalIncomeAfterPayrollDeductions: 0,
        totalTaxFreeIncome: 0,
        totalSocialSecurityIncome: 0,
        totalWageIncome: 0,
        totalSelfEmploymentIncome: 0,
      }
    );

    const wageIncome = activeIncomes.reduce(
      (total, income, index) => (income.getIncomeType() === 'wage' ? total + processedIncomes[index].income : total),
      0
    );
    const selfEmploymentIncome = activeIncomes.reduce(
      (total, income, index) => (income.getIncomeType() === 'selfEmployment' ? total + processedIncomes[index].income : total),
      0
    );

    const perIncomeData = Object.fromEntries(allRows.map((income) => [income.id, income]));

    const result: IncomesData = {
      ...totals,
      totalWageIncome: wageIncome,
      totalSelfEmploymentIncome: selfEmploymentIncome,
      perIncomeData,
      ...(this.splitByOwner ? { perOwnerData: perOwnerTotals(activeIncomes, processedIncomes) } : {}),
    };

    this.monthlyData.push(result);
    return result;
  }

  resetMonthlyData(): void {
    this.monthlyData = [];
  }

  getAnnualData(): IncomesData {
    const annual = this.monthlyData.reduce(
      (acc, curr) => {
        acc.totalIncome += curr.totalIncome;
        acc.totalAmountWithheld += curr.totalAmountWithheld;
        acc.totalFicaTax += curr.totalFicaTax;
        acc.totalIncomeAfterPayrollDeductions += curr.totalIncomeAfterPayrollDeductions;
        acc.totalTaxFreeIncome += curr.totalTaxFreeIncome;
        acc.totalSocialSecurityIncome += curr.totalSocialSecurityIncome;
        acc.totalWageIncome += curr.totalWageIncome;
        acc.totalSelfEmploymentIncome += curr.totalSelfEmploymentIncome;

        for (const [incomeID, incomeData] of Object.entries(curr.perIncomeData)) {
          const existing = acc.perIncomeData[incomeID];
          acc.perIncomeData[incomeID] = {
            ...incomeData,
            income: (existing?.income ?? 0) + incomeData.income,
            amountWithheld: (existing?.amountWithheld ?? 0) + incomeData.amountWithheld,
            ficaTax: (existing?.ficaTax ?? 0) + incomeData.ficaTax,
            incomeAfterPayrollDeductions: (existing?.incomeAfterPayrollDeductions ?? 0) + incomeData.incomeAfterPayrollDeductions,
            taxFreeIncome: (existing?.taxFreeIncome ?? 0) + incomeData.taxFreeIncome,
            socialSecurityIncome: (existing?.socialSecurityIncome ?? 0) + incomeData.socialSecurityIncome,
          };
        }

        return acc;
      },
      {
        totalIncome: 0,
        totalAmountWithheld: 0,
        totalFicaTax: 0,
        totalIncomeAfterPayrollDeductions: 0,
        totalTaxFreeIncome: 0,
        totalSocialSecurityIncome: 0,
        totalWageIncome: 0,
        totalSelfEmploymentIncome: 0,
        perIncomeData: {},
      } satisfies IncomesData
    );

    // The per-owner totals are summed separately from `perIncomeData` so the single-member path
    // (where `splitByOwner` is false) returns exactly the object it always did.
    if (!this.splitByOwner) return annual;

    return { ...annual, perOwnerData: sumPerOwnerTotals(this.monthlyData) };
  }
}

/**
 * One owner's share of a month's (or a year's) income.
 *
 * The same eight totals `IncomesData` carries, restricted to one member — which is exactly what a
 * separate return (§6013) is computed from.
 */
export interface OwnerIncomesData {
  totalIncome: number;
  totalAmountWithheld: number;
  totalFicaTax: number;
  totalIncomeAfterPayrollDeductions: number;
  totalTaxFreeIncome: number;
  totalSocialSecurityIncome: number;
  /** Wages subject to payroll tax, for the OASDI wage base and the Additional Medicare threshold. */
  totalWageIncome: number;
  /** Net self-employment earnings, the base for the annual self-employment tax. */
  totalSelfEmploymentIncome: number;
}

/** A zeroed owner total, so the two owners' records always carry every field. */
const zeroOwnerTotals = (): OwnerIncomesData => ({
  totalIncome: 0,
  totalAmountWithheld: 0,
  totalFicaTax: 0,
  totalIncomeAfterPayrollDeductions: 0,
  totalTaxFreeIncome: 0,
  totalSocialSecurityIncome: 0,
  totalWageIncome: 0,
  totalSelfEmploymentIncome: 0,
});

/**
 * How much of an income belongs to each owner.
 *
 * A `joint` income is **community income** in California (E2, F10), so half of it belongs on each
 * separate return — the Form 8958 rule. A `primary` or `partner` income belongs wholly to that
 * owner. A household of one is unaffected: `ownerOf` reads an absent owner as `primary`, so
 * everything lands on the primary's record.
 */
const ownerShares = (owner: Owner): { owner: HouseholdMemberRole; share: number }[] => {
  if (owner === 'joint') {
    return [
      { owner: 'primary', share: 0.5 },
      { owner: 'partner', share: 0.5 },
    ];
  }

  return [{ owner, share: 1 }];
};

/** Splits one month's active incomes into the two owners' totals. */
function perOwnerTotals(
  activeIncomes: readonly Income[],
  processedIncomes: readonly IncomeData[]
): Record<'primary' | 'partner', OwnerIncomesData> {
  const totals: Record<'primary' | 'partner', OwnerIncomesData> = { primary: zeroOwnerTotals(), partner: zeroOwnerTotals() };

  activeIncomes.forEach((income, index) => {
    const monthly = processedIncomes[index];
    const isWage = income.getIncomeType() === 'wage';
    const isSelfEmployment = income.getIncomeType() === 'selfEmployment';

    for (const { owner, share } of ownerShares(income.getOwner())) {
      const ownerTotals = totals[owner];
      ownerTotals.totalIncome += monthly.income * share;
      ownerTotals.totalAmountWithheld += monthly.amountWithheld * share;
      ownerTotals.totalFicaTax += monthly.ficaTax * share;
      ownerTotals.totalIncomeAfterPayrollDeductions += monthly.incomeAfterPayrollDeductions * share;
      ownerTotals.totalTaxFreeIncome += monthly.taxFreeIncome * share;
      ownerTotals.totalSocialSecurityIncome += monthly.socialSecurityIncome * share;
      if (isWage) ownerTotals.totalWageIncome += monthly.income * share;
      if (isSelfEmployment) ownerTotals.totalSelfEmploymentIncome += monthly.income * share;
    }
  });

  return totals;
}

/** Sums the monthly per-owner totals into a year. */
function sumPerOwnerTotals(monthlyData: readonly IncomesData[]): Record<'primary' | 'partner', OwnerIncomesData> {
  const totals: Record<'primary' | 'partner', OwnerIncomesData> = { primary: zeroOwnerTotals(), partner: zeroOwnerTotals() };

  for (const month of monthlyData) {
    const perOwner = month.perOwnerData;
    if (perOwner === undefined) continue;

    for (const owner of ['primary', 'partner'] as const) {
      const monthTotals = perOwner[owner];
      if (monthTotals === undefined) continue;

      const ownerTotals = totals[owner];
      ownerTotals.totalIncome += monthTotals.totalIncome;
      ownerTotals.totalAmountWithheld += monthTotals.totalAmountWithheld;
      ownerTotals.totalFicaTax += monthTotals.totalFicaTax;
      ownerTotals.totalIncomeAfterPayrollDeductions += monthTotals.totalIncomeAfterPayrollDeductions;
      ownerTotals.totalTaxFreeIncome += monthTotals.totalTaxFreeIncome;
      ownerTotals.totalSocialSecurityIncome += monthTotals.totalSocialSecurityIncome;
      ownerTotals.totalWageIncome += monthTotals.totalWageIncome;
      ownerTotals.totalSelfEmploymentIncome += monthTotals.totalSelfEmploymentIncome;
    }
  }

  return totals;
}

export interface IncomesData {
  totalIncome: number;
  totalAmountWithheld: number;
  /**
   * Payroll tax withheld from this year's wages, i.e. what `PayrollTaxProcessor` reported. The
   * authoritative payroll-tax figure for reporting is `TaxesData.fica`, which also carries the
   * self-employment tax and the half deduction; this field is the per-income cash-flow detail that
   * explains the difference between `totalIncome` and `totalIncomeAfterPayrollDeductions`.
   */
  totalFicaTax: number;
  totalIncomeAfterPayrollDeductions: number;
  totalTaxFreeIncome: number;
  totalSocialSecurityIncome: number;
  /** Wages subject to payroll tax this year; the OASDI wage base is applied to this total. */
  totalWageIncome: number;
  /** Net self-employment earnings; the base for the annual self-employment tax. */
  totalSelfEmploymentIncome: number;
  perIncomeData: Record<string, IncomeData>;
  /**
   * The year's totals per owner (P3-P1b), present **only** when the household files two returns.
   *
   * This is what a married couple filing separately divides between the two returns: the fields
   * above are the household's, and these are each member's. A `joint` income is community income
   * under California law, so half of each of its lines lands on each record (F10); a `primary` or
   * `partner` income lands wholly on its owner's.
   *
   * Absent for a household filing one return, where the totals above already are the whole answer.
   * The field is optional for a second reason: it is additive output, and a one-return run's data
   * must stay byte-identical to what it was before this item (see the golden corpus).
   */
  perOwnerData?: Record<'primary' | 'partner', OwnerIncomesData>;
}

/** Collection of income sources that filters by active time frame */
export class Incomes {
  private readonly incomes: Income[];
  private readonly socialSecurity: HouseholdSocialSecurity;
  private readonly startYear: number;
  private earningsTestYear = -1;
  private readonly earningsYearToDate = new Map<HouseholdMemberRole, number>();
  private readonly withheldYearToDate = new Map<HouseholdMemberRole, number>();
  private readonly dueYearToDate = new Map<HouseholdMemberRole, number>();
  private readonly carriedWithholding = new Map<HouseholdMemberRole, number>();
  private readonly memberDeaths: Partial<Record<HouseholdMemberRole, number>>;

  /**
   * @param memberDeaths - Plan-axis age at which each member dies, when a survivor outlives them.
   *   An income whose owner is that member stops being active from that age (P1-P3 piece 4); a
   *   `joint` income keeps paying, because community income is the survivor's too. Empty for a
   *   single-member plan, and for a couple with no survivor window, so nothing moves there. A
   *   deceased member's Social Security line instead pays the survivor top-up (P1-P8, see above).
   * @param coupleAgeOffsets - Each member's plan-axis age offset (`planAge = memberAge + offset`),
   *   present only for a two-member household. It is what places the spousal and survivor starts on
   *   the simulation's axis. Absent for a household of one, which then has no household terms at all.
   * @param context - Required. It is what resolves a `nominal` amount against the plan's start;
   *   omitting it used to treat every amount as real, which is a wrong number with no symptom.
   */
  constructor(
    data: IncomeInputs[],
    context: TimeBindingContext,
    memberDeaths: Partial<Record<HouseholdMemberRole, number>> = {},
    coupleAgeOffsets?: Record<HouseholdMemberRole, number>,
    children: readonly SocialSecurityChild[] = []
  ) {
    const activeData = data.filter((income) => !income.disabled);
    this.startYear = context.startDate.getFullYear();
    const roles: readonly HouseholdMemberRole[] = coupleAgeOffsets === undefined ? ['primary'] : ['primary', 'partner'];
    this.socialSecurity = new HouseholdSocialSecurity(
      activeData,
      roles.map((role) => ({
        role,
        ageOffset: coupleAgeOffsets?.[role] ?? 0,
        deathPlanAge: memberDeaths[role] ?? Number.POSITIVE_INFINITY,
        birthYear: ownerBirthYear(role, context),
      })),
      children,
      context.startDate.getFullYear(),
      context.marketAssumptions.inflationRate
    );

    this.incomes = activeData.map((income) => new Income(income, context, this.socialSecurity));
    this.memberDeaths = memberDeaths;

    const byId = new Map(this.incomes.map((income) => [income.getId(), income]));
    this.socialSecurity.setStatedBenefitLookup((lineId) => byId.get(lineId)?.getStatedAnnualAmount() ?? 0);
  }

  /**
   * Children's benefits and the retirement earnings test for the month (v20; see
   * `social-security-family.ts`). Mutates the Social Security rows of `processed` in place when the
   * test withholds from them, and returns the month's child-benefit rows, one per worker record.
   *
   * The year-to-date state lives here rather than on the processor, because the engine builds a new
   * `IncomesProcessor` when a death changes the filing status, and the test must not restart then.
   */
  applySocialSecurityHouseholdRules(active: readonly Income[], processed: IncomeData[], simulationState: SimulationState): IncomeData[] {
    const household = this.socialSecurity;
    const planAge = simulationState.time.age;
    const monthsElapsed = simulationState.time.month;
    const years = Math.max(0, Math.floor(simulationState.time.year));

    const childRows: IncomeData[] = [];
    for (const [role, annual] of household.annualChildBenefitsByRecord(planAge, years)) {
      const income = annual / 12;
      if (income <= 0) continue;
      childRows.push({
        id: `${CHILD_BENEFIT_ROW_PREFIX}${role}`,
        name: 'Social Security (children)',
        income,
        amountWithheld: 0,
        ficaTax: 0,
        incomeAfterPayrollDeductions: income,
        taxFreeIncome: income,
        socialSecurityIncome: 0,
      });
    }

    // The engine's year: months 1-12 are year 0. The test runs on these years (see the module doc).
    const yearIndex = Math.floor((monthsElapsed - 1) / 12);
    if (yearIndex !== this.earningsTestYear) {
      // Withholding falls after the excess is earned, so a year's last months may not hold all of it:
      // what is still owed carries into the next year, as SSA recovers an overpayment from later benefits.
      for (const role of ['primary', 'partner'] as const) {
        this.carriedWithholding.set(role, Math.max(0, (this.dueYearToDate.get(role) ?? 0) - (this.withheldYearToDate.get(role) ?? 0)));
      }
      this.earningsTestYear = yearIndex;
      this.earningsYearToDate.clear();
      this.withheldYearToDate.clear();
      this.dueYearToDate.clear();
    }
    const yearEndPlanAge = planAge - monthsElapsed / 12 + yearIndex + 1;
    const amounts = earningsTestAmountsFor(this.startYear + yearIndex);

    for (const role of ['primary', 'partner'] as const) {
      const fraPlanAge = household.fraPlanAge(role);
      if (fraPlanAge === undefined || planAge >= fraPlanAge - 1e-9) continue;

      let earned = 0;
      active.forEach((income, index) => {
        const type = income.getIncomeType();
        if (type !== 'wage' && type !== 'selfEmployment') return;
        const owner = income.getOwner();
        earned += processed[index]!.income * (owner === role ? 1 : owner === 'joint' ? 0.5 : 0);
      });
      const yearToDate = (this.earningsYearToDate.get(role) ?? 0) + earned;
      this.earningsYearToDate.set(role, yearToDate);

      const fraYear = fraPlanAge <= yearEndPlanAge + 1e-9;
      const dueYearToDate =
        earningsTestWithholding(
          yearToDate,
          fraYear ? amounts.fraYearExempt : amounts.annualExempt,
          fraYear ? EARNINGS_TEST_FRA_YEAR_WITHHOLDING_RATE : EARNINGS_TEST_WITHHOLDING_RATE
        ) + (this.carriedWithholding.get(role) ?? 0);
      this.dueYearToDate.set(role, dueYearToDate);
      const due = dueYearToDate - (this.withheldYearToDate.get(role) ?? 0);
      if (due <= 1e-9) continue;

      // What this member is paid this month: their record line (own and spousal, or the survivor
      // top-up on the deceased's line), and the children's benefits on their record.
      const rows: IncomeData[] = [];
      let ownsAnOwnRow = false;
      active.forEach((income, index) => {
        const id = income.getId();
        // A Social Security line that is not a record line (a second line) is its owner's.
        const receiver =
          household.receiverOf(id, planAge) ??
          (income.getIncomeType() === 'socialSecurity' && income.getOwner() === role ? role : undefined);
        if (receiver !== role) return;
        rows.push(processed[index]!);
        if (household.recordOwnerOf(id) === role) ownsAnOwnRow = true;
      });
      const childRow = childRows.find((row) => row.id === `${CHILD_BENEFIT_ROW_PREFIX}${role}`);
      if (childRow !== undefined) rows.push(childRow);

      const paid = rows.reduce((total, row) => total + row.income, 0);
      if (paid <= 0) continue;

      const withheld = Math.min(due, paid);
      const keep = 1 - withheld / paid;
      for (const row of rows) {
        row.income *= keep;
        row.amountWithheld *= keep;
        row.socialSecurityIncome *= keep;
        row.taxFreeIncome *= keep;
        row.incomeAfterPayrollDeductions = row.income - row.amountWithheld - row.ficaTax;
      }
      this.withheldYearToDate.set(role, (this.withheldYearToDate.get(role) ?? 0) + withheld);
      // The share of this month's own benefit withheld, in months, for the recomputation at FRA.
      if (ownsAnOwnRow) household.recordWithholding(role, withheld / paid);
    }

    return childRows;
  }

  /** The household's cross-line Social Security rules (spousal, survivor, children, earnings test). */
  getHouseholdSocialSecurity(): HouseholdSocialSecurity {
    return this.socialSecurity;
  }

  /** Every active income, in plan order. */
  getAll(): readonly Income[] {
    return this.incomes;
  }

  getActiveIncomesByTimeFrame(simulationState: SimulationState): Income[] {
    return this.incomes.filter((income) => {
      // A deceased owner's line is never asked its time frame: it pays only a survivor top-up, from
      // the survivor's claim date, and that is decided by the income itself.
      if (this.isStoppedByDeath(income, simulationState)) return income.isSurvivorBenefitDue(simulationState.time.age);

      return income.getIsActiveByTimeFrame(simulationState);
    });
  }

  /**
   * True once the income's owner has died. Checked before the time frame, so an income the death
   * stopped is never asked about — `getIsActiveByTimeFrame` carries the one-time latch and must
   * only run for incomes the processor is actually considering.
   */
  private isStoppedByDeath(income: Income, simulationState: SimulationState): boolean {
    const owner = income.getOwner();
    if (owner === 'joint') return false;

    const deathAge = this.memberDeaths[owner];
    return deathAge !== undefined && simulationState.time.age >= deathAge;
  }
}

export interface IncomeData {
  id: string;
  name: string;
  income: number;
  amountWithheld: number;
  ficaTax: number;
  incomeAfterPayrollDeductions: number;
  taxFreeIncome: number;
  socialSecurityIncome: number;
}

/**
 * The birth year a claiming adjustment is read from for one owner: that member's own, when the
 * context carries the household's (`TimeBindingContext.birthYearByOwner`, P1-P3), and otherwise the
 * plan's.
 *
 * The plan-level fallback recovers the primary's birth year from the plan start.
 * `TimeBindingContext.startAge` is `calculatePreciseAge(birthMonth, birthYear, asOf)` — whole months
 * over twelve — and `startDate` is that same `asOf`, so stepping the plan start back by
 * `round(startAge × 12)` calendar months lands on the primary's birth month exactly. The full
 * retirement age (`fra-table.ts`) is a step function of the birth *year*, so that is all the
 * precision it needs.
 *
 * Why the owner decides it: FRA rises from 65 to 67 across the 1938–1960 cohorts
 * (`FULL_RETIREMENT_AGE_TABLE`), so a couple born either side of a step gets different claim-age
 * factors from the same `claimAge`. Two members two years apart in FRA differ by up to ~14% of the
 * benefit — a partner claiming at 62 receives 0.70 of their PIA at FRA 67 and 0.80 at FRA 65 — and
 * the difference persists for every year of the run, so reading the primary's year for a partner's
 * income is a wrong number with no symptom.
 *
 * A member that stores no birth year of its own resolves to the plan's (`resolveHouseholdMember`),
 * so the fallback is the pre-household behaviour rather than a second rule: it is reached by a
 * context built without a household (a unit test, or a caller that predates per-member ages), and
 * by an owner the map cannot name.
 */
function planBirthYear(context: TimeBindingContext): number {
  const monthsSinceBirth = Math.round(context.startAge * 12);
  const { startDate } = context;

  // A locally built date, so `getFullYear()` reads the same calendar day this context was built in.
  return new Date(startDate.getFullYear(), startDate.getMonth() - monthsSinceBirth, 1).getFullYear();
}

/** The birth year the income's own owner claims against, falling back to the plan's (see above). */
function ownerBirthYear(owner: Owner, context: TimeBindingContext): number {
  return context.birthYearByOwner?.[owner] ?? planBirthYear(context);
}

/**
 * The estimate an income pays, or `undefined` when the estimate does not apply to it.
 *
 * @throws through `estimateSocialSecurityBenefit` when the block's mode lacks the figure that mode
 *   needs (`estimated` without an AIME, `manual` without a PIA). The input schema forbids that
 *   shape, so reaching it means a plan bypassed validation; stopping is the honest response, since
 *   paying a guessed benefit would be a wrong number with no symptom.
 */
function socialSecurityEstimateFor(data: IncomeInputs, owner: Owner, context: TimeBindingContext): SocialSecurityEstimate | undefined {
  if (data.socialSecurity === undefined || data.taxes.incomeType !== 'socialSecurity') return undefined;

  return estimateSocialSecurityBenefit({
    socialSecurity: data.socialSecurity,
    birthYear: ownerBirthYear(owner, context),
    inflationRate: context.marketAssumptions.inflationRate,
  });
}

/** A single income source with frequency, growth, time frame, and tax treatment */
export class Income {
  private hasOneTimeIncomeOccurred: boolean;
  private id: string;
  private name: string;
  private owner: Owner;
  private amount: number;
  private growthRate: number | undefined;
  private growthLimit: number | undefined;
  private binding: TimeBinding;
  private frequency: 'yearly' | 'oneTime' | 'quarterly' | 'monthly' | 'biweekly' | 'weekly';
  private lastYear: number = 0;
  private incomeType: IncomeType;
  private withholdingRate: number;
  /** Occurrence year the one-time payment last fired, so a recurrence can fire once per year. */
  private oneTimeOccurrenceIndex: number | null = null;
  /** Recurrence year of the most recent active month; see `getIsActiveByTimeFrame`. */
  private currentOccurrenceIndex: number | null = null;
  /**
   * P1-P8: the estimate this income pays **instead of** `amount`, resolved once at construction
   * from pure inputs. `undefined` means the income pays its stored amount.
   */
  private socialSecurityEstimate: SocialSecurityEstimate | undefined;
  /** The household's cross-line Social Security rules; a record line's payment is decided there. */
  private readonly household: HouseholdSocialSecurity | undefined;
  /** The plan start's age, so `startAge + year` is the plan-axis age `time.age` runs on. */
  private readonly startAge: number;

  /**
   * @param context - Required. It is what resolves a `nominal` amount against the plan's start;
   *   omitting it used to treat every amount as real, which is a wrong number with no symptom.
   * @param household - The household's Social Security rules (`social-security-household.ts`). When
   *   this line is a member's record line, they decide what it pays; absent in direct unit tests.
   */
  constructor(data: IncomeInputs, context: TimeBindingContext, household?: HouseholdSocialSecurity) {
    this.startAge = context.startAge;
    this.household = household;
    this.hasOneTimeIncomeOccurred = false;
    this.id = data.id;
    this.name = data.name;
    this.owner = ownerOf(data);
    this.binding = new TimeBinding(data.timeframe.start, data.timeframe.end, context);
    // A nominal amount is expressed in the dollars of the date the income starts, so it is
    // converted to the plan's real dollars here. The growth limit is an amount too, so it moves
    // with the same factor.
    const amountScale = this.binding.amountScale(data.amountBasis);
    this.amount = data.amount * amountScale;
    this.growthRate = data.growth?.growthRate;
    this.growthLimit = data.growth?.growthLimit === undefined ? undefined : data.growth.growthLimit * amountScale;
    this.frequency = data.frequency;
    this.incomeType = data.taxes.incomeType;
    this.withholdingRate = data.taxes.withholding ?? 0;
    // P1-P8: resolved here, once, so every month pays the same benefit before the COLA step. The
    // module doc's precedence table is the rule; the estimate wins over `amount` in both modes.
    this.socialSecurityEstimate = socialSecurityEstimateFor(data, this.owner, context);
  }

  /** The tax treatment this income is declared under; payroll tax applies to `wage` only. */
  getIncomeType(): IncomeType {
    return this.incomeType;
  }

  getId(): string {
    return this.id;
  }

  /** The stated benefit as currently paid (annual), for a stated-amount Social Security line. */
  getStatedAnnualAmount(): number {
    return this.amount * this.getTimesToApplyPerYear();
  }

  /** Whose income this is. Absent on a pre-household plan, which reads as `primary`. */
  getOwner(): Owner {
    return this.owner;
  }

  /**
   * The estimate this income pays, or `undefined` when it pays its stored `amount` (P1-P8).
   *
   * Exposed so a caller — a test, a report, a later UI line — can say which of the two figures is in
   * force without re-deriving it.
   */
  getSocialSecurityEstimate(): SocialSecurityEstimate | undefined {
    return this.socialSecurityEstimate;
  }

  /**
   * True when a deceased owner's line is paying its survivor top-up at this plan-axis age (P1-P8).
   * Always false for a line with no survivor terms, which therefore stops at the death as before.
   */
  isSurvivorBenefitDue(planAge: number): boolean {
    return this.household?.isSurvivorBenefitDue(this.id, planAge) ?? false;
  }

  /**
   * Calculates this income's monthly amount with growth and income-tax withholding
   * @param year - Current simulation year (fractional)
   * @returns Income data before payroll withholding, which `IncomesProcessor` applies
   */
  processMonthlyAmount(year: number): Omit<IncomeData, 'ficaTax' | 'incomeAfterPayrollDeductions'> {
    const timesToApplyPerYear = this.getTimesToApplyPerYear();
    const timesToApplyPerMonth = this.getTimesToApplyPerMonth();

    // Which figure is paid (P1-P8): the estimate when the income has one, otherwise the stored
    // amount grown to this year. The two are never combined — see the module doc.
    const annualAmount =
      this.household?.isRecordLine(this.id) === true
        ? this.household.annualPayment(
            this.id,
            this.startAge + year,
            Math.max(0, Math.floor(year)),
            this.socialSecurityEstimate === undefined ? this.grownAnnualAmount(year) : 0
          )
        : this.socialSecurityEstimate === undefined
          ? this.grownAnnualAmount(year)
          : this.annualSocialSecurityBenefit(year);

    if (timesToApplyPerYear === 0) {
      return {
        id: this.id,
        name: this.name,
        income: 0,
        amountWithheld: 0,
        taxFreeIncome: 0,
        socialSecurityIncome: 0,
      };
    }

    const income = Math.max((annualAmount / timesToApplyPerYear) * timesToApplyPerMonth, 0);

    let amountWithheld = 0;
    let taxFreeIncome = 0;
    let socialSecurityIncome = 0;
    switch (this.incomeType) {
      case 'wage':
        amountWithheld = income * (this.withholdingRate / 100);
        break;
      case 'exempt':
        taxFreeIncome = income;
        break;
      case 'socialSecurity':
        amountWithheld = income * (this.withholdingRate / 100);
        socialSecurityIncome = income;
        break;
      case 'pension':
        // Pension income is fully taxable ordinary income, but payroll-tax free: no Social Security
        // or Medicare withholding applies. It therefore stays in `income` only (no `taxFreeIncome`
        // and no `socialSecurityIncome`, so it never feeds the provisional-income calculation as SS).
        break;
      case 'selfEmployment':
        // The gross amount is ordinary income here; the self-employment tax on it is an annual
        // settlement in `TaxProcessor`, because the 92.35% base and the half deduction are
        // year-level facts. Nothing is withheld from a self-employed paycheque.
        break;
      default:
        break;
    }

    if (this.frequency === 'oneTime') {
      this.hasOneTimeIncomeOccurred = true;
      this.oneTimeOccurrenceIndex = this.currentOccurrenceIndex;
    }
    return {
      id: this.id,
      name: this.name,
      income,
      amountWithheld,
      taxFreeIncome,
      socialSecurityIncome,
    };
  }

  /**
   * The stored amount grown to this year, capped or floored by its growth limit — the path every
   * income without an estimate takes. Its yearly growth step mutates `this.amount`, so it is called
   * once per processed month and never for an estimated benefit.
   */
  private grownAnnualAmount(year: number): number {
    const timesToApplyPerYear = this.getTimesToApplyPerYear();
    let annualAmount = this.amount * timesToApplyPerYear;

    if (this.lastYear !== Math.floor(year)) {
      if (this.growthRate) {
        const realGrowthRate = this.growthRate / 100;
        annualAmount *= 1 + realGrowthRate;

        const growthLimit = this.growthLimit;
        if (growthLimit !== undefined && realGrowthRate > 0) {
          annualAmount = Math.min(annualAmount, growthLimit);
        } else if (growthLimit !== undefined && realGrowthRate < 0) {
          annualAmount = Math.max(annualAmount, growthLimit);
        }

        if (timesToApplyPerYear !== 0) this.amount = Math.max(annualAmount / timesToApplyPerYear, 0);
      }

      this.lastYear = Math.floor(year);
    }

    return annualAmount;
  }

  /**
   * The year's benefit from the estimate, in the plan's real (today's) dollars, after `floor(year)`
   * years of COLA growth — for a line with a block that is not its member's record line (a second
   * line, or a `joint` one). A record line is paid by `HouseholdSocialSecurity` instead, which adds
   * the spousal, survivor and earnings-test terms to the same own benefit.
   *
   * `year` is the engine's years-since-plan-start axis, so the growth is measured from the plan's
   * own start: `realColaGrowthRate` already carries `(1 + COLA) / (1 + inflation) - 1`, which is 0
   * when the COLA matches the plan's inflation assumption. Growth is stepped once per year.
   */
  private annualSocialSecurityBenefit(year: number): number {
    const estimate = this.socialSecurityEstimate;
    if (estimate === undefined) return 0;

    return estimate.annualBenefit * Math.pow(1 + (estimate.realColaGrowthRate ?? 0), Math.max(0, Math.floor(year)));
  }

  getIsActiveByTimeFrame(simulationState: SimulationState): boolean {
    const isActive = this.binding.isActiveAt(simulationState);

    // The one-time latch needs the occurrence year of the month being processed; remember it
    // while the caller is asking whether this income is active.
    this.currentOccurrenceIndex = isActive ? this.binding.occurrenceIndexAt(simulationState) : null;

    return isActive;
  }

  private getTimesToApplyPerYear(): number {
    switch (this.frequency) {
      case 'yearly':
        return 1;
      case 'oneTime':
        if (this.hasOneTimeAlreadyOccurred()) return 0;
        return 1;
      case 'quarterly':
        return 4;
      case 'monthly':
        return 12;
      case 'biweekly':
        return 26;
      case 'weekly':
        return 52;
    }
  }

  /**
   * Whether this one-time payment has already been made for the month being processed.
   *
   * Without a cadence it fires exactly once, as it always has. With `everyNYears` it fires once
   * per occurrence year, so "every 5 years" pays out in year 0, 5, 10, ...
   */
  private hasOneTimeAlreadyOccurred(): boolean {
    if (!this.binding.isRecurring()) return this.hasOneTimeIncomeOccurred;
    return this.oneTimeOccurrenceIndex !== null && this.oneTimeOccurrenceIndex === this.currentOccurrenceIndex;
  }

  private getTimesToApplyPerMonth(): number {
    switch (this.frequency) {
      case 'yearly':
        return 1 / 12;
      case 'oneTime':
        if (this.hasOneTimeAlreadyOccurred()) return 0;
        return 1;
      case 'quarterly':
        return 4 / 12;
      case 'monthly':
        return 1;
      case 'biweekly':
        return 26 / 12;
      case 'weekly':
        return 52 / 12;
    }
  }
}
