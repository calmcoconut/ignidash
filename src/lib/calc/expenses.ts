/**
 * Expense processing for the simulation engine
 *
 * Handles multiple expense sources with varying frequencies, time frames,
 * and real growth rates. Includes discretionary (surplus) spending.
 */

import type { ExpenseInputs } from '@/lib/schemas/inputs/expense-form-schema';

import { TimeBinding, type TimeBindingContext } from './time-binding';

import type { SimulationState } from './simulation-engine';

/** Processes all active expenses each month and aggregates annual totals */
export class ExpensesProcessor {
  private monthlyData: ExpensesData[] = [];
  /**
   * Essential spending for the month `process()` last ran (P1-P4), which a withdrawal cap may not
   * cut. Kept off `ExpensesData` because that object is part of every frozen result row: a new key
   * there would move the golden corpus for a value the engine, not the readouts, consumes.
   */
  private currentEssentialExpenses = 0;
  private currentQualifiedMedicalExpenses = 0;
  private monthlyQualifiedMedicalExpenses: number[] = [];
  private currentQcdExpenses = 0;
  private monthlyQcdExpenses: number[] = [];

  constructor(
    private simulationState: SimulationState,
    private expenses: Expenses
  ) {}

  /**
   * Processes all active expenses for the current month
   * @returns Aggregated expense data with per-expense breakdowns
   */
  process(): ExpensesData {
    const activeExpenses = this.expenses.getActiveExpensesByTimeFrame(this.simulationState);

    const processed = activeExpenses.map((expense) => ({
      data: expense.processMonthlyAmount(this.simulationState.time.year),
      essential: expense.getIsEssential(),
      qualifiedMedical: expense.getIsQualifiedMedical(),
      qcd: expense.getIsSatisfyFromIra(),
    }));
    const processedExpenses = processed.map((entry) => entry.data);

    const totals = processedExpenses.reduce(
      (acc, curr) => {
        acc.totalExpenses += curr.expense;
        return acc;
      },
      { totalExpenses: 0 }
    );
    this.currentEssentialExpenses = processed.reduce((acc, entry) => acc + (entry.essential ? entry.data.expense : 0), 0);
    this.currentQualifiedMedicalExpenses = processed.reduce((acc, entry) => acc + (entry.qualifiedMedical ? entry.data.expense : 0), 0);
    this.monthlyQualifiedMedicalExpenses.push(this.currentQualifiedMedicalExpenses);
    this.currentQcdExpenses = processed.reduce((acc, entry) => acc + (entry.qcd ? entry.data.expense : 0), 0);
    this.monthlyQcdExpenses.push(this.currentQcdExpenses);
    const perExpenseData = Object.fromEntries(processedExpenses.map((expense) => [expense.id, expense]));

    const result = { ...totals, perExpenseData };

    this.monthlyData.push(result);
    return result;
  }

  /**
   * Adds a discretionary (surplus) expense to the current month's data
   * @param expense - Dollar amount of discretionary spending
   * @returns Updated expense data including the discretionary amount
   */
  processDiscretionaryExpense(expense: number): ExpensesData {
    const discretionaryExpense: ExpenseData = {
      id: '4ad31cac-7e17-47c4-af4e-784e080c05dd',
      name: 'Extra Spending',
      expense,
    };

    const currentMonthlyData = this.monthlyData[this.monthlyData.length - 1];
    if (!currentMonthlyData) {
      console.error('No current monthly data found when processing discretionary expense. This should not happen!');

      const result = {
        totalExpenses: expense,
        perExpenseData: { [discretionaryExpense.id]: discretionaryExpense },
      };
      this.monthlyData.push(result);

      return result;
    }

    currentMonthlyData.totalExpenses += expense;

    const currentDiscretionaryExpenses = currentMonthlyData.perExpenseData[discretionaryExpense.id];
    currentMonthlyData.perExpenseData[discretionaryExpense.id] = {
      ...discretionaryExpense,
      expense: (currentDiscretionaryExpenses?.expense ?? 0) + expense,
    };

    return currentMonthlyData;
  }

  resetMonthlyData(): void {
    this.monthlyData = [];
    this.currentEssentialExpenses = 0;
    this.currentQualifiedMedicalExpenses = 0;
    this.monthlyQualifiedMedicalExpenses = [];
    this.currentQcdExpenses = 0;
    this.monthlyQcdExpenses = [];
  }

  /**
   * Essential spending this month, as `process()` computed it.
   *
   * A withdrawal strategy's annual cap trims discretionary spending; spending the plan marks
   * essential is funded first, whatever the cap says. Zero before the first month and after a reset,
   * which is also what a plan with no essential expense reports.
   */
  getMonthlyEssentialExpenses(): number {
    return this.currentEssentialExpenses;
  }

  /**
   * Qualified medical expenses for the whole year, for pairing with tax-free HSA withdrawals (R5).
   */
  getAnnualQualifiedMedicalExpenses(): number {
    return this.monthlyQualifiedMedicalExpenses.reduce((sum, val) => sum + val, 0);
  }

  /**
   * Qualified charitable distribution expenses for the whole year, satisfied from IRA (R6).
   */
  getAnnualQcdExpenses(): number {
    return this.monthlyQcdExpenses.reduce((sum, val) => sum + val, 0);
  }

  getAnnualData(): ExpensesData {
    return this.monthlyData.reduce(
      (acc, curr) => {
        acc.totalExpenses += curr.totalExpenses;

        for (const [expenseID, expenseData] of Object.entries(curr.perExpenseData)) {
          const existing = acc.perExpenseData[expenseID];
          acc.perExpenseData[expenseID] = {
            ...expenseData,
            expense: (existing?.expense ?? 0) + expenseData.expense,
          };
        }

        return acc;
      },
      { totalExpenses: 0, perExpenseData: {} } satisfies ExpensesData
    );
  }
}

export interface ExpensesData {
  totalExpenses: number;
  perExpenseData: Record<string, ExpenseData>;
}

/** Collection of expense sources that filters by active time frame */
export class Expenses {
  private readonly expenses: Expense[];

  /**
   * @param context - Required. It is what resolves a `nominal` amount against the plan's start;
   *   omitting it used to treat every amount as real, which is a wrong number with no symptom.
   */
  constructor(data: ExpenseInputs[], context: TimeBindingContext) {
    this.expenses = data.filter((expense) => !expense.disabled).map((expense) => new Expense(expense, context));
  }

  getActiveExpensesByTimeFrame(simulationState: SimulationState): Expense[] {
    return this.expenses.filter((expense) => expense.getIsActiveByTimeFrame(simulationState));
  }
}

export interface ExpenseData {
  id: string;
  name: string;
  expense: number;
}

/** A single expense source with frequency, growth, and time frame */
export class Expense {
  private hasOneTimeExpenseOccurred: boolean;
  private id: string;
  private name: string;
  private amount: number;
  private growthRate: number | undefined;
  private growthLimit: number | undefined;
  private binding: TimeBinding;
  private frequency: 'yearly' | 'oneTime' | 'quarterly' | 'monthly' | 'biweekly' | 'weekly';
  /** Whether a withdrawal cap may cut this expense (P1-P4). Absent means no. */
  private essential: boolean;
  /** Whether this expense is qualified medical spending for tax-free HSA withdrawals (R5). */
  private qualifiedMedical: boolean;
  /** Whether this expense is satisfied from IRA as a Qualified Charitable Distribution (R6, IRC §408(d)(8)). */
  private satisfyFromIra: boolean;
  private lastYear: number = 0;
  /** Occurrence year the one-time expense last fired, so a recurrence can fire once per year. */
  private oneTimeOccurrenceIndex: number | null = null;
  /** Recurrence year of the most recent active month; see `getIsActiveByTimeFrame`. */
  private currentOccurrenceIndex: number | null = null;

  /**
   * @param context - Required. It is what resolves a `nominal` amount against the plan's start;
   *   omitting it used to treat every amount as real, which is a wrong number with no symptom.
   */
  constructor(data: ExpenseInputs, context: TimeBindingContext) {
    this.hasOneTimeExpenseOccurred = false;
    this.id = data.id;
    this.name = data.name;
    this.binding = new TimeBinding(data.timeframe.start, data.timeframe.end, context);
    // A nominal amount is expressed in the dollars of the date the expense starts, so it is
    // converted to the plan's real dollars here. The growth limit is an amount too, so it moves
    // with the same factor.
    const amountScale = this.binding.amountScale(data.amountBasis);
    this.amount = data.amount * amountScale;
    this.growthRate = data.growth?.growthRate;
    this.growthLimit = data.growth?.growthLimit === undefined ? undefined : data.growth.growthLimit * amountScale;
    this.frequency = data.frequency;
    this.essential = data.essential ?? false;
    this.qualifiedMedical = data.qualifiedMedical ?? false;
    this.satisfyFromIra = data.satisfyFromIra ?? false;
  }

  /** Whether this expense is essential spending, which no withdrawal strategy may cut. */
  getIsEssential(): boolean {
    return this.essential;
  }

  /** Whether this expense is qualified medical spending for tax-free HSA withdrawals (R5). */
  getIsQualifiedMedical(): boolean {
    return this.qualifiedMedical;
  }

  /** Whether this expense is satisfied from IRA as a Qualified Charitable Distribution (R6, IRC §408(d)(8)). */
  getIsSatisfyFromIra(): boolean {
    return this.satisfyFromIra;
  }

  getIsQcd(): boolean {
    return this.satisfyFromIra;
  }

  processMonthlyAmount(year: number): ExpenseData {
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

    if (timesToApplyPerYear === 0) return { id: this.id, name: this.name, expense: 0 };

    const monthlyAmount = Math.max((annualAmount / timesToApplyPerYear) * timesToApplyPerMonth, 0);

    if (this.frequency === 'oneTime') {
      this.hasOneTimeExpenseOccurred = true;
      this.oneTimeOccurrenceIndex = this.currentOccurrenceIndex;
    }
    return { id: this.id, name: this.name, expense: monthlyAmount };
  }

  getIsActiveByTimeFrame(simulationState: SimulationState): boolean {
    const isActive = this.binding.isActiveAt(simulationState);

    // The one-time latch needs the occurrence year of the month being processed; remember it
    // while the caller is asking whether this expense is active.
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
   * Whether this one-time expense has already been paid for the month being processed.
   *
   * Without a cadence it fires exactly once, as it always has. With `everyNYears` it fires once
   * per occurrence year, so "every 5 years" pays out in year 0, 5, 10, ...
   */
  private hasOneTimeAlreadyOccurred(): boolean {
    if (!this.binding.isRecurring()) return this.hasOneTimeExpenseOccurred;
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
