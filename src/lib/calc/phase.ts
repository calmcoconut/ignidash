/**
 * Simulation phase identification (accumulation vs retirement)
 *
 * Determines the current phase based on the user's retirement strategy:
 * fixed age triggers at a specific age, SWR target triggers when portfolio
 * can sustain expenses at the safe withdrawal rate.
 */

import type { TimelineInputs } from '@/lib/schemas/inputs/timeline-form-schema';
import { isCoupleHousehold } from '@/lib/schemas/inputs/household-schema';

import type { SimulationState } from './simulation-engine';
import type { TimeBinding } from './time-binding';

export type PhaseName = 'accumulation' | 'retirement';

/** Current simulation phase data */
export interface PhaseData {
  name: PhaseName;
}

/** Determines the current simulation phase based on retirement strategy */
export class PhaseIdentifier {
  constructor(
    private simulationState: SimulationState,
    private timeline: TimelineInputs,
    /**
     * The wage incomes that can still keep a couple in accumulation, resolved through the shared
     * time binding. Empty for a single-member plan (and for a couple that has no wage income with
     * a bound of its own), in which case this class behaves exactly as it did before P1-P3.
     */
    private workingIncomeBindings: readonly TimeBinding[] = []
  ) {}

  /**
   * Evaluates the current simulation phase
   * @returns Phase data indicating accumulation or retirement
   */
  getCurrentPhase(): PhaseData {
    return this.holdJointPhaseForEarners(this.getStrategyPhase());
  }

  /** The phase the retirement strategy alone asks for, unchanged from before P1-P3. */
  private getStrategyPhase(): PhaseData {
    switch (this.timeline.retirementStrategy.type) {
      case 'fixedAge':
        const age = this.simulationState.time.age;

        return { name: age < this.timeline.retirementStrategy.retirementAge ? 'accumulation' : 'retirement' };
      case 'swrTarget':
        const currPhase = this.simulationState.phase;
        if (currPhase?.name === 'retirement') {
          return { ...currPhase };
        }

        const annualExpensesData = this.simulationState.annualData.expenses;
        if (annualExpensesData.length === 0) {
          return { name: 'accumulation' };
        }

        const totalPortfolioValue = this.simulationState.portfolio.getTotalValue();
        const safeWithdrawalRate = this.timeline.retirementStrategy.safeWithdrawalRate / 100;
        const safeWithdrawalAmount = totalPortfolioValue * safeWithdrawalRate;

        const meanAnnualExpenses =
          annualExpensesData.length !== 0
            ? annualExpensesData.reduce((acc, curr) => acc + curr.totalExpenses, 0) / annualExpensesData.length
            : 0;

        const annualDebtsData = this.simulationState.annualData.debts;
        const annualPhysicalAssetsData = this.simulationState.annualData.physicalAssets;

        const meanAnnualDebtPayments =
          (annualDebtsData.length !== 0 ? annualDebtsData.reduce((acc, curr) => acc + curr.totalPayment, 0) / annualDebtsData.length : 0) +
          (annualPhysicalAssetsData.length !== 0
            ? annualPhysicalAssetsData.reduce((acc, curr) => acc + curr.totalLoanPayment, 0) / annualPhysicalAssetsData.length
            : 0);

        return { name: meanAnnualExpenses + meanAnnualDebtPayments < safeWithdrawalAmount ? 'retirement' : 'accumulation' };
    }
  }

  /**
   * A couple has not retired while one of its members is still earning a wage (P1-P3 piece 3).
   *
   * The joint phase therefore starts at the *later* retirement, not at the first one: both the
   * fixed-age and the SWR rule are held in accumulation until no wage-earner is still being paid.
   * The gate can only ever delay retirement; it never brings it forward, so a couple whose wages
   * stop when the phase flips (an income ending `atRetirement`) is unaffected, and a household of
   * one is not consulted at all — one person's phase is exactly what it was before this item.
   *
   * Retirement is a one-way latch in the SWR case already; this gate inherits that, because it
   * reports accumulation only while a wage is genuinely still being paid.
   */
  private holdJointPhaseForEarners(phase: PhaseData): PhaseData {
    if (phase.name !== 'retirement') return phase;
    if (!isCoupleHousehold(this.timeline.household)) return phase;

    const someoneStillEarning = this.workingIncomeBindings.some((binding) => binding.isActiveAt(this.simulationState));

    return someoneStillEarning ? { name: 'accumulation' } : phase;
  }
}
