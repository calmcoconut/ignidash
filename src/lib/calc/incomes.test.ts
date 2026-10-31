import { describe, it, expect } from 'vitest';

import type { IncomeInputs } from '@/lib/schemas/inputs/income-form-schema';

import { TEST_TIME_BINDING_CONTEXT } from '@/lib/calc/__tests__/time-binding-context';
import { createSavingsAccount, createSimulatorInputs } from '@/lib/calc/__tests__/test-utils';

import { Income, Incomes, IncomesProcessor } from './incomes';
import { PayrollTaxProcessor } from './payroll-taxes';
import type { SimulationState } from './simulation-engine';
import { simulate } from './simulate';
import type { TimeBindingContext } from './time-binding';

/**
 * Payroll withholding is applied by `IncomesProcessor` from the tax layer's
 * `PayrollTaxProcessor`, so every processor in this file needs one. 2026 is the tax year with a
 * ruleset; the wage base, the Additional Medicare threshold and the 1.3% SDI rate all come from
 * it.
 */
const createPayrollTaxProcessor = () => new PayrollTaxProcessor(2026, 'single');

/**
 * Income Processing Tests
 *
 * Tests for:
 * - Timeframe start/end (customAge, customDate, now, atRetirement)
 * - Growth rate application (yearly, with limits)
 * - Income type tax handling (wage, socialSecurity, tax-free)
 * - Frequency handling (yearly, monthly, oneTime, etc.)
 */

// Helper to create a mock simulation state
const createSimulationState = (overrides: Partial<SimulationState> = {}): SimulationState => ({
  time: {
    age: 35,
    year: 2024,
    month: 1,
    date: new Date(2024, 0, 1),
    ...overrides.time,
  },
  phase: overrides.phase !== undefined ? overrides.phase : { name: 'accumulation' },
  portfolio: {} as SimulationState['portfolio'],
  annualData: { expenses: [], debts: [], physicalAssets: [] },
});

// Helper to create income input
const createIncomeInput = (overrides: Partial<IncomeInputs> = {}): IncomeInputs => ({
  id: 'income-1',
  name: 'Salary',
  amount: 10000, // Per period amount
  frequency: 'monthly',
  disabled: false,
  timeframe: {
    start: { type: 'now' },
    end: undefined,
  },
  taxes: {
    incomeType: 'wage',
    withholding: 22,
  },
  growth: undefined,
  ...overrides,
});

describe('Income Timeframe Tests', () => {
  describe('Start Timeframe', () => {
    it('now: income is active immediately', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: { start: { type: 'now' }, end: undefined },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const simState = createSimulationState();
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);
    });

    it('customAge: income starts at specified age', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: { start: { type: 'customAge', age: 40 }, end: undefined },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before age 40
      let simState = createSimulationState({ time: { age: 39, year: 2024, month: 1, date: new Date(2024, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(false);

      // At age 40
      simState = createSimulationState({ time: { age: 40, year: 2029, month: 1, date: new Date(2029, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);

      // After age 40
      simState = createSimulationState({ time: { age: 45, year: 2034, month: 1, date: new Date(2034, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);
    });

    it('customDate: income starts at specified date', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: { start: { type: 'customDate', year: 2025, month: 6 }, end: undefined },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before June 2025
      let simState = createSimulationState({ time: { age: 35, year: 2025, month: 5, date: new Date(2025, 4, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(false);

      // At June 2025
      simState = createSimulationState({ time: { age: 35, year: 2025.416, month: 6, date: new Date(2025, 5, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);

      // After June 2025
      simState = createSimulationState({ time: { age: 36, year: 2026, month: 1, date: new Date(2026, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);
    });

    it('atRetirement: income starts when retirement phase begins', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: { start: { type: 'atRetirement' }, end: undefined },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Pre-retirement phase
      let simState = createSimulationState({
        phase: { name: 'accumulation' } as SimulationState['phase'],
      });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(false);

      // Retirement phase
      simState = createSimulationState({
        phase: { name: 'retirement' } as SimulationState['phase'],
      });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);
    });
  });

  describe('End Timeframe', () => {
    it('no end: income continues indefinitely', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: { start: { type: 'now' }, end: undefined },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      const simState = createSimulationState({ time: { age: 100, year: 2089, month: 1, date: new Date(2089, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);
    });

    it('customAge: income ends at specified age', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: { start: { type: 'now' }, end: { type: 'customAge', age: 65 } },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before age 65
      let simState = createSimulationState({ time: { age: 64, year: 2053, month: 12, date: new Date(2053, 11, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);

      // At age 65
      simState = createSimulationState({ time: { age: 65, year: 2054, month: 1, date: new Date(2054, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);

      // After age 65
      simState = createSimulationState({ time: { age: 66, year: 2055, month: 1, date: new Date(2055, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(false);
    });

    it('customDate: income ends at specified date', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: { start: { type: 'now' }, end: { type: 'customDate', year: 2030, month: 12 } },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before December 2030
      let simState = createSimulationState({ time: { age: 41, year: 2030, month: 11, date: new Date(2030, 10, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);

      // At December 2030
      simState = createSimulationState({ time: { age: 41, year: 2030.916, month: 12, date: new Date(2030, 11, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);

      // After December 2030
      simState = createSimulationState({ time: { age: 42, year: 2031, month: 1, date: new Date(2031, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(false);
    });

    it('atRetirement: income ends when retirement phase begins', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: { start: { type: 'now' }, end: { type: 'atRetirement' } },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Pre-retirement phase
      let simState = createSimulationState({
        phase: { name: 'accumulation' } as SimulationState['phase'],
      });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);

      // Retirement phase
      simState = createSimulationState({
        phase: { name: 'retirement' } as SimulationState['phase'],
      });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(false);
    });
  });

  describe('Timeframe Boundary Conditions', () => {
    it('income with start age 30 and end age 65 is only active within range', () => {
      const income = new Income(
        createIncomeInput({
          timeframe: {
            start: { type: 'customAge', age: 30 },
            end: { type: 'customAge', age: 65 },
          },
        }),
        TEST_TIME_BINDING_CONTEXT
      );

      // Before range
      let simState = createSimulationState({ time: { age: 29, year: 2018, month: 1, date: new Date(2018, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(false);

      // Within range
      simState = createSimulationState({ time: { age: 45, year: 2034, month: 1, date: new Date(2034, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(true);

      // After range
      simState = createSimulationState({ time: { age: 66, year: 2055, month: 1, date: new Date(2055, 0, 1) } });
      expect(income.getIsActiveByTimeFrame(simState)).toBe(false);
    });
  });
});

describe('Income Growth Rate Tests', () => {
  it('applies growth rate annually (year change)', () => {
    const income = new Income(
      createIncomeInput({
        amount: 10000, // $10k/month = $120k/year
        frequency: 'monthly',
        growth: { growthRate: 3, growthLimit: undefined }, // 3% annual growth
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // First call of year 1 - growth is applied (since lastYear starts at 0)
    const year1Result = income.processMonthlyAmount(2024);
    expect(year1Result.income).toBeCloseTo(10000 * 1.03);

    // Still year 1 (no additional growth)
    const year1Result2 = income.processMonthlyAmount(2024.5);
    expect(year1Result2.income).toBeCloseTo(10000 * 1.03);

    // Year 2 - growth applied again
    const year2Result = income.processMonthlyAmount(2025);
    expect(year2Result.income).toBeCloseTo(10000 * 1.03 * 1.03);
  });

  it('compounds growth over multiple years', () => {
    const income = new Income(
      createIncomeInput({
        amount: 10000,
        frequency: 'monthly',
        growth: { growthRate: 5, growthLimit: undefined }, // 5% annual growth
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Year 1 (growth applied on first call since lastYear starts at 0)
    income.processMonthlyAmount(2024);

    // Year 2 (5% additional growth)
    income.processMonthlyAmount(2025);

    // Year 3 (another 5% on top of year 2)
    // Total: 3 years of growth compounded
    const year3Result = income.processMonthlyAmount(2026);
    expect(year3Result.income).toBeCloseTo(10000 * 1.05 * 1.05 * 1.05);
  });

  it('respects upper growth limit with positive growth', () => {
    const income = new Income(
      createIncomeInput({
        amount: 10000,
        frequency: 'monthly',
        growth: { growthRate: 50, growthLimit: 130000 }, // 50% annual growth, max $130k/year
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Year 1: $120k annual ($10k/month)
    income.processMonthlyAmount(2024);

    // Year 2: Would be $180k but capped at $130k
    const year2Result = income.processMonthlyAmount(2025);
    // Monthly amount should be capped at 130k/12
    expect(year2Result.income).toBeCloseTo(130000 / 12);
  });

  it('respects lower growth limit with negative growth', () => {
    const income = new Income(
      createIncomeInput({
        amount: 10000,
        frequency: 'monthly',
        growth: { growthRate: -50, growthLimit: 60000 }, // -50% annual, min $60k/year
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Year 1: $120k annual
    income.processMonthlyAmount(2024);

    // Year 2: Would be $60k but growth limit (floor) is $60k
    const year2Result = income.processMonthlyAmount(2025);
    expect(year2Result.income).toBeCloseTo(60000 / 12);
  });

  it('handles zero growth correctly', () => {
    const income = new Income(
      createIncomeInput({
        amount: 10000,
        frequency: 'monthly',
        growth: { growthRate: 0, growthLimit: undefined },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    income.processMonthlyAmount(2024);
    const year2Result = income.processMonthlyAmount(2025);
    const year3Result = income.processMonthlyAmount(2026);

    expect(year2Result.income).toBeCloseTo(10000);
    expect(year3Result.income).toBeCloseTo(10000);
  });

  it('handles no growth config', () => {
    const income = new Income(
      createIncomeInput({
        amount: 5000,
        frequency: 'monthly',
        growth: undefined,
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    income.processMonthlyAmount(2024);
    const year2Result = income.processMonthlyAmount(2025);
    const year5Result = income.processMonthlyAmount(2028);

    expect(year2Result.income).toBeCloseTo(5000);
    expect(year5Result.income).toBeCloseTo(5000);
  });
});

describe('Income Type Tax Handling', () => {
  it('wage income: applies withholding here and payroll tax in the processor', () => {
    const income = new Income(
      createIncomeInput({
        amount: 10000,
        frequency: 'monthly',
        taxes: { incomeType: 'wage', withholding: 22 }, // 22% withholding
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);

    // `Income` reports gross and income-tax withholding only; payroll tax is the tax layer's job.
    expect(result.income).toBe(10000);
    expect(result.amountWithheld).toBeCloseTo(2200); // 22% of $10k
    expect(result).not.toHaveProperty('ficaTax');
    expect(result.taxFreeIncome).toBe(0);
    expect(result.socialSecurityIncome).toBe(0);

    // Payroll withholding on $10,000 (2026 rules, single):
    //   OASDI 6.2% + Medicare 1.45% = 7.65%  → $765.00
    //   California SDI 1.3% (no wage cap)    → $130.00
    //   total                                → $895.00
    const processor = new IncomesProcessor(
      createSimulationState(),
      new Incomes([createIncomeInput()], TEST_TIME_BINDING_CONTEXT),
      createPayrollTaxProcessor()
    );
    const processed = processor.process();
    expect(processed.totalFicaTax).toBeCloseTo(895);
    expect(processed.perIncomeData['income-1'].ficaTax).toBeCloseTo(895);
    // Net: 10,000 − 2,200 withheld − 895 payroll = 6,905
    expect(processed.totalIncomeAfterPayrollDeductions).toBeCloseTo(6905);
  });

  it('social security income: applies withholding, tracks as SS income', () => {
    const income = new Income(
      createIncomeInput({
        amount: 2500,
        frequency: 'monthly',
        taxes: { incomeType: 'socialSecurity', withholding: 10 }, // 10% voluntary withholding
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);

    expect(result.income).toBe(2500);
    expect(result.amountWithheld).toBeCloseTo(250); // 10%
    expect(result.socialSecurityIncome).toBe(2500); // Tracked for provisional income
    expect(result.taxFreeIncome).toBe(0);
  });

  it('tax-free income: no taxes, tracked as tax-free', () => {
    const income = new Income(
      createIncomeInput({
        amount: 3000,
        frequency: 'monthly',
        taxes: { incomeType: 'exempt' },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);

    expect(result.income).toBe(3000);
    expect(result.amountWithheld).toBe(0);
    expect(result.taxFreeIncome).toBe(3000);
    expect(result.socialSecurityIncome).toBe(0);

    const processed = new IncomesProcessor(
      createSimulationState(),
      new Incomes(
        [
          createIncomeInput({
            amount: 3000,
            frequency: 'monthly',
            taxes: { incomeType: 'exempt' },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      ),
      createPayrollTaxProcessor()
    ).process();
    // No payroll tax on tax-free income, so take-home is the gross amount.
    expect(processed.totalFicaTax).toBe(0);
    expect(processed.totalIncomeAfterPayrollDeductions).toBe(3000);
  });

  it('zero withholding rate on wage income still applies payroll tax', () => {
    const processed = new IncomesProcessor(
      createSimulationState(),
      new Incomes(
        [
          createIncomeInput({
            amount: 10000,
            frequency: 'monthly',
            taxes: { incomeType: 'wage', withholding: 0 },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      ),
      createPayrollTaxProcessor()
    ).process();

    expect(processed.totalIncome).toBe(10000);
    expect(processed.totalAmountWithheld).toBe(0);
    // 7.65% FICA ($765.00) + 1.3% SDI ($130.00) = $895.00
    expect(processed.totalFicaTax).toBeCloseTo(895);
    expect(processed.totalIncomeAfterPayrollDeductions).toBeCloseTo(9105); // 10,000 − 0 − 895
  });

  it('mixed income types produce correct aggregate deductions', () => {
    const incomes = new Incomes(
      [
        createIncomeInput({
          id: 'wage',
          name: 'Wage',
          amount: 10000,
          frequency: 'monthly',
          taxes: { incomeType: 'wage', withholding: 22 },
        }),
        createIncomeInput({
          id: 'ss',
          name: 'Social Security',
          amount: 2500,
          frequency: 'monthly',
          taxes: { incomeType: 'socialSecurity', withholding: 10 },
        }),
        createIncomeInput({
          id: 'exempt',
          name: 'Tax Free',
          amount: 3000,
          frequency: 'monthly',
          taxes: { incomeType: 'exempt' },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new IncomesProcessor(simState, incomes, createPayrollTaxProcessor());
    const result = processor.process();

    // Gross: 10000 + 2500 + 3000 = 15500
    expect(result.totalIncome).toBeCloseTo(15500);
    // Withheld: 10000*0.22 + 2500*0.10 = 2200 + 250 = 2450
    expect(result.totalAmountWithheld).toBeCloseTo(2450);
    // Payroll: only on the wage = 7.65% ($765.00) + 1.3% SDI ($130.00) = $895.00
    expect(result.totalFicaTax).toBeCloseTo(895);
    // Net: 15500 - 2450 - 895 = 12155
    expect(result.totalIncomeAfterPayrollDeductions).toBeCloseTo(12155);
  });

  it('pension income: ordinary income with no payroll tax', () => {
    const income = new Income(
      createIncomeInput({
        amount: 4000,
        frequency: 'monthly',
        taxes: { incomeType: 'pension' },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);

    // Fully taxable ordinary income: it must not be tagged tax-free or as Social Security income
    // (Social Security income feeds the provisional-income calculation in taxes.ts).
    expect(result.income).toBe(4000);
    expect(result.amountWithheld).toBe(0);
    expect(result.taxFreeIncome).toBe(0);
    expect(result.socialSecurityIncome).toBe(0);

    const processed = new IncomesProcessor(
      createSimulationState(),
      new Incomes(
        [
          createIncomeInput({
            amount: 4000,
            frequency: 'monthly',
            taxes: { incomeType: 'pension' },
          }),
        ],
        TEST_TIME_BINDING_CONTEXT
      ),
      createPayrollTaxProcessor()
    ).process();
    expect(processed.totalFicaTax).toBe(0);
    expect(processed.totalIncomeAfterPayrollDeductions).toBe(4000);
  });

  it('pension and wage income: FICA is charged on the wage only', () => {
    const incomes = new Incomes(
      [
        createIncomeInput({
          id: 'salary',
          name: 'Salary',
          amount: 10000,
          frequency: 'monthly',
          taxes: { incomeType: 'wage', withholding: 22 },
        }),
        createIncomeInput({
          id: 'pension',
          name: 'Pension',
          amount: 4000,
          frequency: 'monthly',
          taxes: { incomeType: 'pension' },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const processor = new IncomesProcessor(createSimulationState(), incomes, createPayrollTaxProcessor());
    const result = processor.process();

    // Pension flows into total income...
    expect(result.totalIncome).toBeCloseTo(14000);
    // ...but carries no payroll tax: payroll tax is wage-only
    // (10,000 × 7.65% FICA = $765.00 + 10,000 × 1.3% SDI = $130.00 = $895.00).
    expect(result.totalFicaTax).toBeCloseTo(895);
    expect(result.perIncomeData['pension'].ficaTax).toBe(0);
    // ...and is not mistaken for Social Security or tax-free income.
    expect(result.totalSocialSecurityIncome).toBe(0);
    expect(result.totalTaxFreeIncome).toBe(0);
  });
});

describe('Income Frequency Tests', () => {
  it('monthly: processes full amount each month', () => {
    const income = new Income(
      createIncomeInput({
        amount: 10000,
        frequency: 'monthly',
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);
    expect(result.income).toBeCloseTo(10000);
  });

  it('yearly: distributes amount across 12 months', () => {
    const income = new Income(
      createIncomeInput({
        amount: 120000, // Annual amount
        frequency: 'yearly',
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);
    // yearly / 12 months
    expect(result.income).toBeCloseTo(10000);
  });

  it('quarterly: distributes quarterly amount across months', () => {
    const income = new Income(
      createIncomeInput({
        amount: 30000, // Per quarter
        frequency: 'quarterly',
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);
    // 4 quarters per year * $30k = $120k annual / 12 = $10k per month
    expect(result.income).toBeCloseTo(10000);
  });

  it('biweekly: distributes biweekly amount across months', () => {
    const income = new Income(
      createIncomeInput({
        amount: 4615.38, // Per biweekly period (~$120k annual / 26)
        frequency: 'biweekly',
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);
    // 26 periods * $4615.38 / 12 months
    expect(result.income).toBeCloseTo(10000, 0);
  });

  it('weekly: distributes weekly amount across months', () => {
    const income = new Income(
      createIncomeInput({
        amount: 2307.69, // Per week (~$120k annual / 52)
        frequency: 'weekly',
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    const result = income.processMonthlyAmount(2024);
    // 52 weeks * $2307.69 / 12 months
    expect(result.income).toBeCloseTo(10000, 0);
  });

  it('oneTime: processes once and then returns zero', () => {
    const income = new Income(
      createIncomeInput({
        amount: 50000, // One-time bonus
        frequency: 'oneTime',
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // First month - full amount
    const result1 = income.processMonthlyAmount(2024);
    expect(result1.income).toBe(50000);

    // Second month - zero (already occurred)
    const result2 = income.processMonthlyAmount(2024.083);
    expect(result2.income).toBe(0);

    // Later month - still zero
    const result3 = income.processMonthlyAmount(2025);
    expect(result3.income).toBe(0);
  });
});

describe('Incomes Collection Tests', () => {
  it('filters active incomes by timeframe', () => {
    const incomes = new Incomes(
      [
        createIncomeInput({
          id: 'active',
          name: 'Active Income',
          timeframe: { start: { type: 'now' }, end: undefined },
        }),
        createIncomeInput({
          id: 'future',
          name: 'Future Income',
          timeframe: { start: { type: 'customAge', age: 65 }, end: undefined },
        }),
        createIncomeInput({
          id: 'past',
          name: 'Past Income',
          timeframe: { start: { type: 'now' }, end: { type: 'customAge', age: 30 } },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState({ time: { age: 35, year: 2024, month: 1, date: new Date(2024, 0, 1) } });
    const activeIncomes = incomes.getActiveIncomesByTimeFrame(simState);

    expect(activeIncomes.length).toBe(1);
    expect(activeIncomes[0].processMonthlyAmount(2024).name).toBe('Active Income');
  });

  it('excludes disabled incomes', () => {
    const incomes = new Incomes(
      [
        createIncomeInput({ id: 'enabled', name: 'Enabled', disabled: false }),
        createIncomeInput({ id: 'disabled', name: 'Disabled', disabled: true }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const activeIncomes = incomes.getActiveIncomesByTimeFrame(simState);

    expect(activeIncomes.length).toBe(1);
    expect(activeIncomes[0].processMonthlyAmount(2024).name).toBe('Enabled');
  });
});

describe('IncomesProcessor Tests', () => {
  it('aggregates multiple incomes correctly', () => {
    const incomes = new Incomes(
      [
        createIncomeInput({
          id: 'salary',
          name: 'Salary',
          amount: 10000,
          frequency: 'monthly',
          taxes: { incomeType: 'wage', withholding: 22 },
        }),
        createIncomeInput({
          id: 'side-gig',
          name: 'Side Gig',
          amount: 2000,
          frequency: 'monthly',
          taxes: { incomeType: 'selfEmployment' },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new IncomesProcessor(simState, incomes, createPayrollTaxProcessor());
    const result = processor.process();

    expect(result.totalIncome).toBeCloseTo(12000);
    expect(Object.keys(result.perIncomeData).length).toBe(2);
    expect(result.perIncomeData['salary'].income).toBeCloseTo(10000);
    expect(result.perIncomeData['side-gig'].income).toBeCloseTo(2000);
    // Self-employment income is reported as its own total; nothing is withheld from it here —
    // the self-employment tax is settled annually by `TaxProcessor`.
    expect(result.totalWageIncome).toBeCloseTo(10000);
    expect(result.totalSelfEmploymentIncome).toBeCloseTo(2000);
    expect(result.perIncomeData['side-gig'].ficaTax).toBe(0);
  });

  it('tracks Social Security income separately for provisional income', () => {
    const incomes = new Incomes(
      [
        createIncomeInput({
          id: 'pension',
          name: 'Pension',
          amount: 3000,
          frequency: 'monthly',
          taxes: { incomeType: 'pension' },
        }),
        createIncomeInput({
          id: 'ss',
          name: 'Social Security',
          amount: 2500,
          frequency: 'monthly',
          taxes: { incomeType: 'socialSecurity', withholding: 0 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new IncomesProcessor(simState, incomes, createPayrollTaxProcessor());
    const result = processor.process();

    expect(result.totalIncome).toBeCloseTo(5500);
    expect(result.totalSocialSecurityIncome).toBeCloseTo(2500);
  });

  it('annual data sums monthly data correctly', () => {
    const incomes = new Incomes(
      [
        createIncomeInput({
          id: 'salary',
          name: 'Salary',
          amount: 10000,
          frequency: 'monthly',
          taxes: { incomeType: 'wage', withholding: 22 },
        }),
      ],
      TEST_TIME_BINDING_CONTEXT
    );

    const simState = createSimulationState();
    const processor = new IncomesProcessor(simState, incomes, createPayrollTaxProcessor());

    // Process 12 months
    for (let month = 0; month < 12; month++) {
      processor.process();
    }

    const annualData = processor.getAnnualData();
    expect(annualData.totalIncome).toBeCloseTo(120000);
    expect(annualData.totalAmountWithheld).toBeCloseTo(26400); // 22% of $120k
    // Payroll on $120,000 for 2026 (single), all twelve months below the $184,500 wage base:
    //   OASDI 6.2%  = $7,440.00
    //   Medicare 1.45% = $1,740.00
    //   SDI 1.3%    = $1,560.00
    //   total       = $10,740.00
    expect(annualData.totalFicaTax).toBeCloseTo(10740);
    // Net: 120000 - 26400 - 10740 = 82860
    expect(annualData.totalIncomeAfterPayrollDeductions).toBeCloseTo(82860);
  });
});

/**
 * P1-P8: an income with a `socialSecurity` block is **paid** from the estimate.
 *
 * The estimator in `social-security.ts` came first; these tests are about which figure the engine
 * pays, and what that figure costs in tax. Every expectation is worked by hand from the vendored
 * 2025 bend points:
 *
 *   PIA(AIME 5,000) = 1,226 × 0.90 + (5,000 − 1,226) × 0.32 = 1,103.40 + 1,207.68 = 2,311.08
 *
 * and the claiming factors for the 1990 birth year this test context starts from (plan start
 * 2025-01-01 at age 35 → birth year 1990 → full retirement age 67, `fra-table.ts`):
 *
 *   claim 62 → 60 months early → 20% + 10% = 30% reduction → 0.70 → 1,617.756
 *   claim 67 → no adjustment                              → 1.00 → 2,311.08
 *   claim 70 → 36 months late → 36 × 2/3% = 24% credit    → 1.24 → 2,865.7392
 *
 * The stored `amount` on every fixture below is $1, a figure that cannot be mistaken for any
 * of the benefits, so "the estimate was paid" and "the amount was paid" can never be confused.
 */
const createSocialSecurityIncome = (overrides: Partial<IncomeInputs> = {}): IncomeInputs =>
  createIncomeInput({
    name: 'Social Security',
    amount: 1,
    frequency: 'monthly',
    taxes: { incomeType: 'socialSecurity', withholding: 0 },
    socialSecurity: { mode: 'estimated', aime: 5000, claimAge: 67 },
    ...overrides,
  });

describe('Social Security: the estimate decides the paid benefit (P1-P8)', () => {
  it('pays the estimated benefit at the full retirement age', () => {
    const income = new Income(createSocialSecurityIncome(), TEST_TIME_BINDING_CONTEXT);

    const estimate = income.getSocialSecurityEstimate();
    expect(estimate?.pia).toBeCloseTo(2311.08, 10);
    // Birth year 1990 → FRA 67 for every cohort from 1960 on.
    expect(estimate?.fullRetirementAge.totalMonths).toBe(804);

    const month = income.processMonthlyAmount(0);
    expect(month.income).toBeCloseTo(2311.08, 10);
    // The benefit is tagged as Social Security income, which is what routes it through §86 —
    // it must not be reported as tax-free or as ordinary (earned) income.
    expect(month.socialSecurityIncome).toBeCloseTo(2311.08, 10);
    expect(month.taxFreeIncome).toBe(0);
    expect(month.amountWithheld).toBe(0);
  });

  it('pays 70% of the PIA when the claim starts at 62', () => {
    const income = new Income(
      createSocialSecurityIncome({ socialSecurity: { mode: 'estimated', aime: 5000, claimAge: 62 } }),
      TEST_TIME_BINDING_CONTEXT
    );

    // 2,311.08 × 0.70 = 1,617.756
    expect(income.processMonthlyAmount(0).income).toBeCloseTo(1617.756, 10);
  });

  it('pays 124% of the PIA when the claim starts at 70', () => {
    const income = new Income(
      createSocialSecurityIncome({ socialSecurity: { mode: 'estimated', aime: 5000, claimAge: 70 } }),
      TEST_TIME_BINDING_CONTEXT
    );

    // 2,311.08 × 1.24 = 2,865.7392
    expect(income.processMonthlyAmount(0).income).toBeCloseTo(2865.7392, 10);
  });

  it('grows the benefit by the COLA in real terms', () => {
    const context: TimeBindingContext = {
      ...TEST_TIME_BINDING_CONTEXT,
      marketAssumptions: { ...TEST_TIME_BINDING_CONTEXT.marketAssumptions, inflationRate: 3 },
    };
    const income = new Income(
      createSocialSecurityIncome({ socialSecurity: { mode: 'estimated', aime: 5000, claimAge: 67, colaRate: 4 } }),
      context
    );

    // Plan start: no COLA has accrued yet.
    expect(income.processMonthlyAmount(0).income).toBeCloseTo(2311.08, 10);

    // Two years of a 4% COLA against the plan's 3% inflation: (1.04 / 1.03)^2 = 1.0816 / 1.0609
    // = 1.0195117, so 2,311.08 × 1.0195117 = 2,356.17 — growth in real dollars, not nominal.
    const grown = income.processMonthlyAmount(2).income;
    expect(grown).toBeCloseTo(2311.08 * (1.04 ** 2 / 1.03 ** 2), 10);
    expect(grown).toBeCloseTo(2356.17, 2);
  });

  it('leaves the real benefit unchanged when the COLA matches inflation', () => {
    const context: TimeBindingContext = {
      ...TEST_TIME_BINDING_CONTEXT,
      marketAssumptions: { ...TEST_TIME_BINDING_CONTEXT.marketAssumptions, inflationRate: 3 },
    };
    const income = new Income(
      createSocialSecurityIncome({ socialSecurity: { mode: 'estimated', aime: 5000, claimAge: 67, colaRate: 3 } }),
      context
    );

    // COLA 3% against inflation 3% → real growth 0, so year five pays exactly year zero's benefit.
    expect(income.processMonthlyAmount(5).income).toBeCloseTo(2311.08, 10);
  });
});

describe('Social Security: which figure wins when an amount is also stored (P1-P8)', () => {
  it('pays the estimate rather than the stored amount', () => {
    const income = new Income(createSocialSecurityIncome({ amount: 9999 }), TEST_TIME_BINDING_CONTEXT);

    expect(income.getSocialSecurityEstimate()).toBeDefined();
    // 2,311.08, not 9,999: the block supersedes the amount outright, and nothing is blended.
    expect(income.processMonthlyAmount(0).income).toBeCloseTo(2311.08, 10);
  });

  it('ignores the amount growth rate and growth limit too', () => {
    const income = new Income(
      createSocialSecurityIncome({ amount: 9999, growth: { growthRate: 5, growthLimit: 20000 } }),
      TEST_TIME_BINDING_CONTEXT
    );

    // Two years on, with no COLA set, the estimate is flat: the amount's 5% growth never applies,
    // and the amount itself was never grown.
    expect(income.processMonthlyAmount(2).income).toBeCloseTo(2311.08, 10);
  });

  it('pays the stored amount when the income carries no socialSecurity block', () => {
    const income = new Income(createSocialSecurityIncome({ amount: 2500, socialSecurity: undefined }), TEST_TIME_BINDING_CONTEXT);

    expect(income.getSocialSecurityEstimate()).toBeUndefined();
    expect(income.processMonthlyAmount(0).income).toBeCloseTo(2500, 10);
  });

  it('uses the stored PIA in manual mode, ahead of the amount, and still applies the claim age', () => {
    const atFra = new Income(
      createSocialSecurityIncome({ amount: 9999, socialSecurity: { mode: 'manual', pia: 3000, claimAge: 67 } }),
      TEST_TIME_BINDING_CONTEXT
    );
    expect(atFra.processMonthlyAmount(0).income).toBeCloseTo(3000, 10);

    const early = new Income(
      createSocialSecurityIncome({ amount: 9999, socialSecurity: { mode: 'manual', pia: 3000, claimAge: 62 } }),
      TEST_TIME_BINDING_CONTEXT
    );
    // 3,000 × 0.70 = 2,100
    expect(early.processMonthlyAmount(0).income).toBeCloseTo(2100, 10);
  });

  it('ignores the block on an income that is not declared Social Security', () => {
    const income = new Income(
      createSocialSecurityIncome({
        amount: 4000,
        taxes: { incomeType: 'wage', withholding: 20 },
        socialSecurity: { mode: 'estimated', aime: 5000, claimAge: 67 },
      }),
      TEST_TIME_BINDING_CONTEXT
    );

    // A Social Security estimate on a wage would be a second wage out of nowhere.
    expect(income.getSocialSecurityEstimate()).toBeUndefined();
    expect(income.processMonthlyAmount(0).income).toBeCloseTo(4000, 10);
  });

  it('refuses an estimated block with no AIME rather than paying a guess', () => {
    expect(
      () => new Income(createSocialSecurityIncome({ socialSecurity: { mode: 'estimated', claimAge: 67 } }), TEST_TIME_BINDING_CONTEXT)
    ).toThrow(/aime/i);
  });
});

describe('Social Security: the estimated benefit is taxed as Social Security, not as ordinary income', () => {
  it('routes the paid benefit through provisional income (§86)', () => {
    const plan = createSimulatorInputs({
      // Born 1960: FRA 67. The plan starts 2026-10-01, at age 66.75.
      timeline: { lifeExpectancy: 90, birthMonth: 1, birthYear: 1960, retirementStrategy: { type: 'fixedAge', retirementAge: 65 } },
      accounts: { 'savings-1': createSavingsAccount({ balance: 0 }) },
      incomes: {
        'ss-1': createSocialSecurityIncome({
          id: 'ss-1',
          timeframe: { start: { type: 'customAge', age: 67 }, end: undefined },
          socialSecurity: { mode: 'estimated', aime: 5000, claimAge: 67, colaRate: 3 },
        }),
        // Ordinary income alongside the benefit, so provisional income reaches §86's top tier.
        'pension-1': {
          id: 'pension-1',
          name: 'Pension',
          amount: 40000,
          frequency: 'yearly',
          timeframe: { start: { type: 'customAge', age: 67 }, end: undefined },
          taxes: { incomeType: 'pension' },
          disabled: false,
        },
      },
      // No returns at all, so the only income is the two streams above and the §86 arithmetic below
      // is exactly what the return sees.
      marketAssumptions: { stockReturn: 0, stockYield: 0, bondReturn: 0, bondYield: 0, cashReturn: 0, inflationRate: 3 },
    });

    const run = simulate(plan, { mode: 'fixedReturns', seed: 1, asOf: '2026-10-01' });
    const withBenefits = run.result.data.filter((point) => (point.incomes?.totalSocialSecurityIncome ?? 0) > 0);
    expect(withBenefits.length).toBeGreaterThan(0);

    // The largest year's benefit is a complete year: 12 × 2,311.08 = 27,732.96 (COLA 3% against 3%
    // inflation, so no real growth). The stored amount is $1/month, so this also fails loudly if the
    // estimate ever stops being paid.
    const fullYear = withBenefits.reduce((best, point) =>
      (point.incomes?.totalSocialSecurityIncome ?? 0) > (best.incomes?.totalSocialSecurityIncome ?? 0) ? point : best
    );
    expect(fullYear.incomes?.totalSocialSecurityIncome).toBeCloseTo(27732.96, 6);
    expect(fullYear.incomes?.totalIncome).toBeCloseTo(40000 + 27732.96, 6);

    const taxes = fullYear.taxes;
    expect(taxes).not.toBeNull();
    // The benefit reaches the return as Social Security income …
    expect(taxes?.incomeSources.socialSecurityIncome).toBeCloseTo(27732.96, 6);
    // … and *not* as earned (ordinary) income: that bucket holds the pension alone.
    expect(taxes?.incomeSources.earnedIncome).toBeCloseTo(40000, 6);

    // §86 on a single return, 2026 base amounts $25,000 / $34,000:
    //   provisional income = 40,000 + 50% × 27,732.96          = 53,866.48
    //   tier-1 amount      = min(9,000 × 50%, 50% × 27,732.96)  = 4,500
    //   taxable            = min(4,500 + 85% × 19,866.48, 85% × 27,732.96) = 21,386.508
    expect(taxes?.socialSecurityTaxes.provisionalIncome).toBeCloseTo(53866.48, 6);
    expect(taxes?.socialSecurityTaxes.taxableSocialSecurityIncome).toBeCloseTo(21386.508, 6);
    expect(taxes?.socialSecurityTaxes.maxTaxablePercentage).toBe(0.85);
    // 21,386.508 / 27,732.96 = 77.1% — computed from provisional income, not a flat 85% inclusion.
    expect(taxes?.socialSecurityTaxes.actualTaxablePercentage).toBeCloseTo(0.771158505979888, 8);
  });
});
