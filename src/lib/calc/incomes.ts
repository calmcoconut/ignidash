/**
 * Income processing for the simulation engine
 *
 * Handles multiple income sources with varying frequencies, time frames,
 * growth rates, and tax treatments (wage, exempt, Social Security).
 * Processes FICA tax (7.65%) and withholding at the income level.
 */

import type { IncomeInputs, IncomeType } from '@/lib/schemas/inputs/income-form-schema';

import { TimeBinding, type TimeBindingContext } from './time-binding';

import type { SimulationState } from './simulation-engine';

/** Processes all active incomes each month and aggregates annual totals */
export class IncomesProcessor {
  private monthlyData: IncomesData[] = [];

  constructor(
    private simulationState: SimulationState,
    private incomes: Incomes
  ) {}

  /**
   * Processes all active incomes for the current month
   * @returns Aggregated income data with per-income breakdowns
   */
  process(): IncomesData {
    const activeIncomes = this.incomes.getActiveIncomesByTimeFrame(this.simulationState);

    const processedIncomes = activeIncomes.map((income) => income.processMonthlyAmount(this.simulationState.time.year));

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
      }
    );
    const perIncomeData = Object.fromEntries(processedIncomes.map((income) => [income.id, income]));

    const result = { ...totals, perIncomeData };

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
        perIncomeData: {},
      } satisfies IncomesData
    );
  }
}

export interface IncomesData {
  totalIncome: number;
  totalAmountWithheld: number;
  totalFicaTax: number;
  totalIncomeAfterPayrollDeductions: number;
  totalTaxFreeIncome: number;
  totalSocialSecurityIncome: number;
  perIncomeData: Record<string, IncomeData>;
}

/** Collection of income sources that filters by active time frame */
export class Incomes {
  private readonly incomes: Income[];

  constructor(data: IncomeInputs[], context?: TimeBindingContext) {
    this.incomes = data.filter((income) => !income.disabled).map((income) => new Income(income, context));
  }

  getActiveIncomesByTimeFrame(simulationState: SimulationState): Income[] {
    return this.incomes.filter((income) => income.getIsActiveByTimeFrame(simulationState));
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

  /**
   * Calculates this income's monthly amount with growth, withholding, and FICA
   * @param year - Current simulation year (fractional)
   * @returns Income data including gross, withholding, and FICA amounts
   */
  processMonthlyAmount(year: number): IncomeData {
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
        ficaTax: 0,
        incomeAfterPayrollDeductions: 0,
        taxFreeIncome: 0,
        socialSecurityIncome: 0,
      };
    }

    const income = Math.max((annualAmount / timesToApplyPerYear) * timesToApplyPerMonth, 0);

    let amountWithheld: number = 0;
    let ficaTax: number = 0;
    let taxFreeIncome: number = 0;
    let socialSecurityIncome: number = 0;
    switch (this.incomeType) {
      case 'wage':
        amountWithheld = income * (this.withholdingRate / 100);
        ficaTax = income * 0.0765; // FICA: 6.2% Social Security + 1.45% Medicare
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
        // Gated in the income schema until self-employment tax ships. Treated as ordinary income
        // with no FICA for now, which is why the gate exists.
        break;
      default:
        break;
    }

    const incomeAfterPayrollDeductions = income - amountWithheld - ficaTax;

    if (this.frequency === 'oneTime') {
      this.hasOneTimeIncomeOccurred = true;
      this.oneTimeOccurrenceIndex = this.currentOccurrenceIndex;
    }
    return {
      id: this.id,
      name: this.name,
      income,
      amountWithheld,
      ficaTax,
      incomeAfterPayrollDeductions,
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
