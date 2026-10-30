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
 */

import type { IncomeInputs, IncomeType } from '@/lib/schemas/inputs/income-form-schema';
import { type HouseholdMemberRole, type Owner, ownerOf } from '@/lib/schemas/inputs/household-schema';

import type { PayrollTaxProcessor } from './payroll-taxes';
import { TimeBinding, type TimeBindingContext } from './time-binding';

import type { SimulationState } from './simulation-engine';

/** Processes all active incomes each month and aggregates annual totals */
export class IncomesProcessor {
  private monthlyData: IncomesData[] = [];

  constructor(
    private simulationState: SimulationState,
    private incomes: Incomes,
    private payrollTaxProcessor: PayrollTaxProcessor
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

    const totals = processedIncomes.reduce(
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

    const perIncomeData = Object.fromEntries(processedIncomes.map((income) => [income.id, income]));

    const result = {
      ...totals,
      totalWageIncome: wageIncome,
      totalSelfEmploymentIncome: selfEmploymentIncome,
      perIncomeData,
    };

    this.monthlyData.push(result);
    return result;
  }

  resetMonthlyData(): void {
    this.monthlyData = [];
  }

  getAnnualData(): IncomesData {
    return this.monthlyData.reduce(
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
  }
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
}

/** Collection of income sources that filters by active time frame */
export class Incomes {
  private readonly incomes: Income[];
  private readonly memberDeaths: Partial<Record<HouseholdMemberRole, number>>;

  /**
   * @param memberDeaths - Plan-axis age at which each member dies, when a survivor outlives them.
   *   An income whose owner is that member stops being active from that age (P1-P3 piece 4); a
   *   `joint` income keeps paying, because community income is the survivor's too. Empty for a
   *   single-member plan, and for a couple with no survivor window, so nothing moves there.
   */
  constructor(data: IncomeInputs[], context?: TimeBindingContext, memberDeaths: Partial<Record<HouseholdMemberRole, number>> = {}) {
    this.incomes = data.filter((income) => !income.disabled).map((income) => new Income(income, context));
    this.memberDeaths = memberDeaths;
  }

  getActiveIncomesByTimeFrame(simulationState: SimulationState): Income[] {
    return this.incomes.filter((income) => {
      if (this.isStoppedByDeath(income, simulationState)) return false;

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

  constructor(data: IncomeInputs, context?: TimeBindingContext) {
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
  }

  /** The tax treatment this income is declared under; payroll tax applies to `wage` only. */
  getIncomeType(): IncomeType {
    return this.incomeType;
  }

  /** Whose income this is. Absent on a pre-household plan, which reads as `primary`. */
  getOwner(): Owner {
    return this.owner;
  }

  /**
   * Calculates this income's monthly amount with growth and income-tax withholding
   * @param year - Current simulation year (fractional)
   * @returns Income data before payroll withholding, which `IncomesProcessor` applies
   */
  processMonthlyAmount(year: number): Omit<IncomeData, 'ficaTax' | 'incomeAfterPayrollDeductions'> {
    const rawAmount = this.amount;

    const timesToApplyPerYear = this.getTimesToApplyPerYear();
    const timesToApplyPerMonth = this.getTimesToApplyPerMonth();

    let annualAmount = rawAmount * timesToApplyPerYear;

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

    let amountWithheld: number = 0;
    let taxFreeIncome: number = 0;
    let socialSecurityIncome: number = 0;
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
