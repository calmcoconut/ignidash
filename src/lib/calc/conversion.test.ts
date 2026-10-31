import { describe, expect, it } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { createSimulatorInputs, createWageIncome } from './__tests__/test-utils';
import { simulate } from './simulate';

describe('Roth conversion engine execution (R4a)', () => {
  it('transfers fixed amount balance from traditional IRA to Roth IRA', () => {
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      incomes: {},
      expenses: {},
      debts: {},
      physicalAssets: {},
      accounts: {
        'savings-1': {
          id: 'savings-1',
          name: 'Savings',
          type: 'savings',
          balance: 10_000,
        },
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 100_000,
          percentBonds: 0,
        },
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 20_000,
          percentBonds: 0,
          contributionBasis: 20_000,
        },
      },
      conversions: [
        {
          id: 'conv-1',
          fromAccountId: 'ira-1',
          toAccountId: 'roth-1',
          amount: 25_000,
          year: 2026,
        },
      ],
    };

    const result = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const firstYear = result.result.data[1];

    // In year 1, conversion moved 25k from IRA to Roth
    // Both accounts experienced return during the year, but the conversion happened at month 1
    const iraData = firstYear.portfolio.perAccountData['ira-1'];
    const rothData = firstYear.portfolio.perAccountData['roth-1'];

    expect(iraData.conversions).toBe(25_000);
    expect(firstYear.portfolio.conversions).toBe(25_000);
    // Roth balance grew by at least the 25k converted
    expect(rothData.balance).toBeGreaterThan(45_000);
  });

  it('prorates basis through Form 8606 for conversions', () => {
    // Hand-worked Form 8606:
    // Starting IRA balance = 100k, nondeductible basis = 20k.
    // Fixed returns: 0% so return doesn't mask the numbers.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      incomes: {},
      expenses: {},
      debts: {},
      physicalAssets: {},
      marketAssumptions: {
        ...base.marketAssumptions,
        stockReturn: 0,
        bondReturn: 0,
        cashReturn: 0,
        stockYield: 0,
        bondYield: 0,
        inflationRate: 0,
      },
      taxSettings: {
        ...base.taxSettings,
        stateResidency: 'none', // isolate federal
      },
      accounts: {
        'savings-1': {
          id: 'savings-1',
          name: 'Savings',
          type: 'savings',
          balance: 10_000,
        },
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 100_000,
          percentBonds: 0,
          nondeductibleBasis: 20_000,
        },
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 0,
          percentBonds: 0,
          contributionBasis: 0,
        },
      },
      conversions: [
        {
          id: 'conv-1',
          fromAccountId: 'ira-1',
          toAccountId: 'roth-1',
          amount: 10_000,
          year: 2026,
        },
      ],
    };

    const result = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const firstYear = result.result.data[1];

    // Form 8606 calculation:
    // Starting IRA = 100k, nondeductible basis = 20k.
    // Converted 10k (< standard deduction so no tax withdrawal needed from IRA).
    // Denominator = 90k year-end + 10k conversion = 100k.
    // Exclusion ratio = 20k / 100k = 0.20.
    // Nontaxable = 10k * 0.20 = 2,000.
    // Taxable conversion = 10k - 2,000 = 8,000.
    expect(firstYear.taxes?.incomeSources.taxableRetirementDistributions).toBe(8_000);
  });

  it('exempts conversions from 10% early withdrawal penalty under age 59.5', () => {
    // Under age 59.5, regular IRA withdrawals incur 10% penalty (§72(t)).
    // Conversions are exempt from §72(t) at conversion time (IRC §408A(d)(3)(A)(ii)).
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      incomes: {},
      expenses: {},
      debts: {},
      physicalAssets: {},
      timeline: {
        ...base.timeline!,
        birthYear: 1986,
        birthMonth: 1,
        lifeExpectancy: 85,
        retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
      },
      marketAssumptions: {
        ...base.marketAssumptions,
        stockReturn: 0,
        bondReturn: 0,
        cashReturn: 0,
        stockYield: 0,
        bondYield: 0,
        inflationRate: 0,
      },
      taxSettings: {
        ...base.taxSettings,
        stateResidency: 'none',
      },
      accounts: {
        'savings-1': {
          id: 'savings-1',
          name: 'Savings',
          type: 'savings',
          balance: 10_000,
        },
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 100_000,
          percentBonds: 0,
        },
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 0,
          percentBonds: 0,
          contributionBasis: 0,
        },
      },
      conversions: [
        {
          id: 'conv-1',
          fromAccountId: 'ira-1',
          toAccountId: 'roth-1',
          amount: 20_000,
          year: 2026,
        },
      ],
    };

    const result = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const firstYear = result.result.data[1];

    // Total taxable income = 20,000.
    // Early withdrawal penalty must be 0!
    expect(firstYear.taxes?.earlyWithdrawalPenalties.totalPenaltyAmount).toBe(0);
  });

  it('executes federal fillToBracket landing within $1 of the bracket top (R4b)', () => {
    // 2026 federal single:
    // 10% bracket: [0, 12,400]
    // 12% bracket: [12,400, 50,400] -> top is $50,400.
    // Standard deduction for single in 2026 is $16,100.
    // With 0 income, to reach $50,400 of taxable ordinary income:
    // Gross conversion needed = 50,400 + 16,100 = 66,500.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      incomes: {},
      expenses: {},
      debts: {},
      physicalAssets: {},
      marketAssumptions: {
        ...base.marketAssumptions,
        stockReturn: 0,
        bondReturn: 0,
        cashReturn: 0,
        stockYield: 0,
        bondYield: 0,
        inflationRate: 0,
      },
      taxSettings: {
        ...base.taxSettings,
        stateResidency: 'none',
      },
      accounts: {
        'savings-1': {
          id: 'savings-1',
          name: 'Savings',
          type: 'savings',
          balance: 10_000,
        },
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 100_000,
          percentBonds: 0,
        },
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 0,
          percentBonds: 0,
          contributionBasis: 0,
        },
      },
      conversions: [
        {
          id: 'conv-1',
          fromAccountId: 'ira-1',
          toAccountId: 'roth-1',
          fillToBracket: 0.12,
          year: 2026,
        },
      ],
    };

    const result = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const firstYear = result.result.data[1];

    const taxableOrdinary = firstYear.taxes?.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary ?? 0;
    // Must land within $1 of the bracket top ($50,400)
    expect(Math.abs(taxableOrdinary - 50_400)).toBeLessThanOrEqual(1);
    expect(Math.abs((firstYear.portfolio.conversions ?? 0) - 66_500)).toBeLessThanOrEqual(1);
  });

  it('executes federal fillToBracket with existing wage income landing within $1 of the 22% top (R4b)', () => {
    // 2026 federal single 22% bracket top is $105,700.
    // Wage income = $60,000.
    // Standard deduction = $16,100.
    // Taxable income before conversion = $43,900.
    // Headroom to 22% top = $105,700 - $43,900 = $61,800.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      incomes: {
        'wage-1': createWageIncome({
          id: 'wage-1',
          name: 'Salary',
          amount: 60_000,
          frequency: 'yearly',
          taxes: {
            incomeType: 'wage',
            withholding: 0,
          },
        }),
      },
      expenses: {},
      debts: {},
      physicalAssets: {},
      marketAssumptions: {
        ...base.marketAssumptions,
        stockReturn: 0,
        bondReturn: 0,
        cashReturn: 0,
        stockYield: 0,
        bondYield: 0,
        inflationRate: 0,
      },
      taxSettings: {
        ...base.taxSettings,
        stateResidency: 'none',
      },
      accounts: {
        'savings-1': {
          id: 'savings-1',
          name: 'Savings',
          type: 'savings',
          balance: 50_000,
        },
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 150_000,
          percentBonds: 0,
        },
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 0,
          percentBonds: 0,
          contributionBasis: 0,
        },
      },
      conversions: [
        {
          id: 'conv-1',
          fromAccountId: 'ira-1',
          toAccountId: 'roth-1',
          fillToBracket: 0.22,
          year: 2026,
        },
      ],
    };

    const result = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const firstYear = result.result.data[1];

    const taxableOrdinary = firstYear.taxes?.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary ?? 0;
    // Must land within $1 of the 22% bracket top ($105,700)
    expect(Math.abs(taxableOrdinary - 105_700)).toBeLessThanOrEqual(1);
    expect(Math.abs((firstYear.portfolio.conversions ?? 0) - 61_800)).toBeLessThanOrEqual(1);
  });

  it('executes California fillToBracket landing within $1 of the CA bracket top (R4b)', () => {
    // California single 9.3% bracket top in 2025/2026 is $371,479.
    // CA standard deduction for single is $5,706.
    // With 0 other income, gross conversion to reach CA taxable income of $371,479:
    // 371,479 + 5,706 = 377,185.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      incomes: {},
      expenses: {},
      debts: {},
      physicalAssets: {},
      marketAssumptions: {
        ...base.marketAssumptions,
        stockReturn: 0,
        bondReturn: 0,
        cashReturn: 0,
        stockYield: 0,
        bondYield: 0,
        inflationRate: 0,
      },
      taxSettings: {
        ...base.taxSettings,
        stateResidency: 'CA',
      },
      accounts: {
        'savings-1': {
          id: 'savings-1',
          name: 'Savings',
          type: 'savings',
          balance: 300_000,
        },
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 500_000,
          percentBonds: 0,
        },
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 0,
          percentBonds: 0,
          contributionBasis: 0,
        },
      },
      conversions: [
        {
          id: 'conv-1',
          fromAccountId: 'ira-1',
          toAccountId: 'roth-1',
          fillToBracket: {
            targetBracketRate: 0.093,
            jurisdiction: 'california',
          },
          year: 2026,
        },
      ],
    };

    const result = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const firstYear = result.result.data[1];

    const caTaxable = firstYear.taxes?.state.taxableIncome ?? 0;
    // Must land within $1 of the California 9.3% bracket top ($371,479)
    expect(Math.abs(caTaxable - 371_479)).toBeLessThanOrEqual(1);
    expect(Math.abs((firstYear.portfolio.conversions ?? 0) - (371_479 + 5_706))).toBeLessThanOrEqual(1);
  });

  it('executes fillToBracket with Form 8606 pro-rata basis landing within $1 of the bracket top (R4b)', () => {
    // 2026 federal single 12% bracket top is $50,400. Standard deduction is $16,100.
    // Target taxable income = $50,400.
    // Taxable conversion needed = 50,400 + 16,100 = $66,500.
    // Traditional IRA starting balance = $100,000, basis = $20,000.
    // Exclusion ratio = 20,000 / 100,000 = 0.20 -> Taxable fraction = 0.80.
    // Gross conversion needed = 66,500 / 0.80 = $83,125.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      incomes: {},
      expenses: {},
      debts: {},
      physicalAssets: {},
      marketAssumptions: {
        ...base.marketAssumptions,
        stockReturn: 0,
        bondReturn: 0,
        cashReturn: 0,
        stockYield: 0,
        bondYield: 0,
        inflationRate: 0,
      },
      taxSettings: {
        ...base.taxSettings,
        stateResidency: 'none',
      },
      accounts: {
        'savings-1': {
          id: 'savings-1',
          name: 'Savings',
          type: 'savings',
          balance: 10_000,
        },
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 100_000,
          percentBonds: 0,
          nondeductibleBasis: 20_000,
        },
        'roth-1': {
          id: 'roth-1',
          name: 'Roth IRA',
          type: 'rothIra',
          balance: 0,
          percentBonds: 0,
          contributionBasis: 0,
        },
      },
      conversions: [
        {
          id: 'conv-1',
          fromAccountId: 'ira-1',
          toAccountId: 'roth-1',
          fillToBracket: 0.12,
          year: 2026,
        },
      ],
    };

    const result = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const firstYear = result.result.data[1];

    const taxableOrdinary = firstYear.taxes?.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary ?? 0;
    // Must land within $1 of the bracket top ($50,400)
    expect(Math.abs(taxableOrdinary - 50_400)).toBeLessThanOrEqual(1);
    expect(Math.abs((firstYear.portfolio.conversions ?? 0) - 83_125)).toBeLessThanOrEqual(1);
  });
});
