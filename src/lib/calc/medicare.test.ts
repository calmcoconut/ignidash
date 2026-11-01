/**
 * Medicare enrolment and base premiums (v20), through the engine.
 *
 * 2026 rates (CMS): standard Part B $202.90 a month, Part D national base beneficiary premium
 * $38.99 a month. A member enrolled all year pays (202.90 + 38.99) × 12 = $2,902.68 for Parts B and D.
 */

import { describe, expect, it } from 'vitest';

import type { Household } from '@/lib/schemas/inputs/household-schema';
import type { MedicareSettingsInputs } from '@/lib/schemas/inputs/tax-settings-form-schema';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import {
  enrolledMedicareMemberMonths,
  isEnrolledInMedicare,
  MEDICARE_PARTS_B_D_EXPENSE_ID,
  MEDICARE_SUPPLEMENTAL_EXPENSE_ID,
} from './medicare';
import { Expenses, ExpensesProcessor } from './expenses';
import { Portfolio } from './portfolio';
import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { FinancialSimulationEngine, type SimulationResult } from './simulation-engine';
import {
  TEST_CLOCK,
  createDefaultTimeline,
  createMockSimulationState,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
} from './__tests__/test-utils';

const ZERO_RETURNS = { stockReturn: 0, stockYield: 0, bondReturn: 0, bondYield: 0, cashReturn: 0, inflationRate: 0 };

/** Born October 1960: 66.0 at the test clock's 2026-10-01, so every yearly point is a whole age. */
function plan(options: { medicare?: MedicareSettingsInputs; household?: Household; birthYear?: number } = {}): SimulatorInputs {
  const birthYear = options.birthYear ?? 1960;
  const base = createSimulatorInputs({
    timeline: {
      ...createDefaultTimeline(),
      birthMonth: 10,
      birthYear,
      lifeExpectancy: 80,
      ...(options.household === undefined ? {} : { household: options.household }),
    },
    incomes: {},
    expenses: {},
    accounts: { brokerage: createTaxableBrokerageAccount({ id: 'brokerage', balance: 2_000_000, costBasis: 2_000_000 }) },
    marketAssumptions: ZERO_RETURNS,
  });

  return { ...base, taxSettings: { ...base.taxSettings, ...(options.medicare === undefined ? {} : { medicare: options.medicare }) } };
}

const run = (inputs: SimulatorInputs): SimulationResult =>
  new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);

const expenseAt = (result: SimulationResult, age: number, id: string): number => {
  const point = result.data.find((candidate) => Math.abs(candidate.age - age) < 1e-9);
  if (point === undefined) throw new Error(`no yearly point at age ${age}`);

  return point.expenses?.perExpenseData[id]?.expense ?? 0;
};

describe('the enrolment rule', () => {
  it('enrols at 65 by default, and not after death', () => {
    const member = { role: 'primary' as const, ageOffset: 0, deathAge: 90 };
    expect(isEnrolledInMedicare(member, 64.99)).toBe(false);
    expect(isEnrolledInMedicare(member, 65)).toBe(true);
    expect(isEnrolledInMedicare(member, 90)).toBe(false);
  });

  it("reads each member's own age through the offset", () => {
    // Plan age 66, partner 3 years younger → 63: not enrolled.
    expect(isEnrolledInMedicare({ role: 'partner', ageOffset: 3, deathAge: Infinity }, 66)).toBe(false);
  });

  it('counts the member-months of the year that ends at the given age', () => {
    expect(enrolledMedicareMemberMonths([{ role: 'primary', ageOffset: 0, deathAge: Infinity }], 65.5)).toBe(7);
  });
});

describe('base premiums through the engine', () => {
  it('charges nothing when the plan has not opted in', () => {
    const result = run(plan());
    expect(expenseAt(result, 67, MEDICARE_PARTS_B_D_EXPENSE_ID)).toBe(0);
  });

  it('charges the standard Part B and base Part D premiums, and a stated supplemental premium', () => {
    const result = run(plan({ medicare: { includePremiums: true, supplementalMonthly: 150 } }));
    expect(expenseAt(result, 67, MEDICARE_PARTS_B_D_EXPENSE_ID)).toBeCloseTo((202.9 + 38.99) * 12, 6);
    expect(expenseAt(result, 67, MEDICARE_SUPPLEMENTAL_EXPENSE_ID)).toBeCloseTo(150 * 12, 6);
  });

  it('uses a stated Part D premium instead of the base beneficiary premium', () => {
    const result = run(plan({ medicare: { includePremiums: true, partDMonthly: 0 } }));
    expect(expenseAt(result, 67, MEDICARE_PARTS_B_D_EXPENSE_ID)).toBeCloseTo(202.9 * 12, 6);
  });

  it('starts at the enrolment age', () => {
    const result = run(plan({ medicare: { includePremiums: true, enrollmentAge: 68 } }));
    expect(expenseAt(result, 67, MEDICARE_PARTS_B_D_EXPENSE_ID)).toBe(0);
    // The year ending at 68 holds one enrolled month (the month at 68.0).
    expect(expenseAt(result, 68, MEDICARE_PARTS_B_D_EXPENSE_ID)).toBeCloseTo(202.9 + 38.99, 6);
    expect(expenseAt(result, 69, MEDICARE_PARTS_B_D_EXPENSE_ID)).toBeCloseTo((202.9 + 38.99) * 12, 6);
  });

  it('charges each enrolled member of a couple, and stops at a death', () => {
    const household: Household = {
      members: [
        { id: 'primary', role: 'primary', birthMonth: 10, birthYear: 1960, lifeExpectancy: 70 },
        { id: 'partner', role: 'partner', birthMonth: 10, birthYear: 1958, lifeExpectancy: 85 },
      ],
    };
    const result = run(plan({ medicare: { includePremiums: true }, household }));
    // Both enrolled all year at plan age 67 (the partner is 69).
    expect(expenseAt(result, 67, MEDICARE_PARTS_B_D_EXPENSE_ID)).toBeCloseTo((202.9 + 38.99) * 24, 6);
    // After the primary's death at 70 only the partner pays.
    expect(expenseAt(result, 72, MEDICARE_PARTS_B_D_EXPENSE_ID)).toBeCloseTo((202.9 + 38.99) * 12, 6);
  });

  it('reports Parts B and D as qualified medical and essential spending, and the supplemental premium as essential only', () => {
    const state = createMockSimulationState(new Portfolio([]), 70);
    const processor = new ExpensesProcessor(state, new Expenses([], { startDate: { year: 2026, month: 10, day: 1 } } as never), {
      members: [{ role: 'primary', ageOffset: 0, deathAge: Infinity }],
      enrollmentAge: 65,
      ratesForMonth: () => ({ partBMonthly: 200, partDMonthly: 40, supplementalMonthly: 100 }),
    });
    processor.process();
    expect(processor.getAnnualQualifiedMedicalExpenses()).toBeCloseTo(240, 9);
    expect(processor.getMonthlyEssentialExpenses()).toBeCloseTo(340, 9);
  });
});
