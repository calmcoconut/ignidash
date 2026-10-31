import { describe, it, expect } from 'vitest';
import { simulate } from './simulate';
import { createSimulatorInputs, createDefaultTimeline } from './__tests__/test-utils';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

describe('QCD engine execution (R6, IRC §408(d)(8))', () => {
  it('satisfies RMD with QCD, excluding distribution from gross income and lowering AGI', () => {
    // Single retiree, age 75 in 2026 (born 1951-01).
    // Starting balance in traditional IRA: $246,000.
    // Uniform Lifetime Table factor for age 75 is 24.6 -> RMD is $10,000.
    // Social Security: $30,000 / year.
    // Charitable expense: $10,000 satisfied from IRA (satisfyFromIra: true).
    // Without QCD:
    //   Gross income includes $10,000 IRA distribution.
    //   Provisional income for §86: 0.5 * 30,000 + 10,000 = $25,000.
    //   Taxable SS would be non-zero (single base is $25k).
    // With QCD:
    //   $10,000 is excluded from gross income under §408(d)(8).
    //   Taxable IRA distributions = $0.
    //   Provisional income for §86: 0.5 * 30,000 + 0 = $15,000 (under $25,000 threshold!).
    //   Taxable SS = $0!
    //   Total federal taxable ordinary income = $0!
    const base = createSimulatorInputs();
    const inputsWithQcd: SimulatorInputs = {
      ...base,
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1951,
        birthMonth: 1,
      },
      incomes: {
        'ss-1': {
          id: 'ss-1',
          name: 'Social Security',
          amount: 30_000,
          frequency: 'yearly',
          amountBasis: 'nominal',
          taxes: {
            incomeType: 'socialSecurity',
          },
          timeframe: {
            start: { type: 'now' },
            end: { type: 'atLifeExpectancy' },
          },
        },
      },
      expenses: {
        'charity-1': {
          id: 'charity-1',
          name: 'Charitable Donation',
          amount: 10_000,
          frequency: 'yearly',
          amountBasis: 'nominal',
          satisfyFromIra: true,
          timeframe: {
            start: { type: 'now' },
            end: { type: 'atLifeExpectancy' },
          },
        },
      },
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
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 246_000,
          percentBonds: 0,
        },
      },
    };

    const runWithQcd = simulate(inputsWithQcd, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const year1WithQcd = runWithQcd.result.data[1]; // 2026 settlement

    expect(year1WithQcd.taxes?.incomeSources.taxDeferredWithdrawals).toBe(0);
    expect(year1WithQcd.taxes?.incomeSources.taxableRetirementDistributions).toBe(0);
    expect(year1WithQcd.taxes?.incomeSources.qcdData?.excludedAmount).toBe(10_000);
    expect(year1WithQcd.taxes?.incomeSources.qcdData?.rmdSatisfied).toBe(10_000);
    expect(year1WithQcd.taxes?.incomeSources.provisionalIncome).toBe(15_000);
    expect(year1WithQcd.taxes?.incomeSources.taxableSocialSecurityIncome).toBe(0);
    expect(year1WithQcd.taxes?.federalIncomeTaxes.taxableIncomeTaxedAsOrdinary).toBe(0);

    // Contrast with the exact same plan without satisfyFromIra (regular expense):
    const inputsWithoutQcd: SimulatorInputs = {
      ...inputsWithQcd,
      expenses: {
        'charity-1': {
          ...inputsWithQcd.expenses['charity-1'],
          satisfyFromIra: false,
        },
      },
    };

    const runWithoutQcd = simulate(inputsWithoutQcd, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const year1WithoutQcd = runWithoutQcd.result.data[1];

    expect(year1WithoutQcd.taxes?.incomeSources.taxDeferredWithdrawals).toBe(10_000);
    expect(year1WithoutQcd.taxes?.incomeSources.taxableRetirementDistributions).toBe(10_000);
    expect(year1WithoutQcd.taxes?.incomeSources.qcdData).toBeUndefined();
    expect(year1WithoutQcd.taxes?.incomeSources.provisionalIncome).toBe(25_000);
  });

  it('refuses QCD treatment for individuals under age 70½', () => {
    // Age 65 retiree (born 1961-01), takes $20,000 from IRA with satisfyFromIra: true.
    // Under IRC §408(d)(8), age must be 70½+.
    // Since age is 65 < 70.5, excludedAmount = 0 and entire distribution is taxable.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1961,
        birthMonth: 1,
      },
      incomes: {},
      expenses: {
        'charity-1': {
          id: 'charity-1',
          name: 'Charity Under Age',
          amount: 20_000,
          frequency: 'yearly',
          amountBasis: 'nominal',
          satisfyFromIra: true,
          timeframe: {
            start: { type: 'now' },
            end: { type: 'atLifeExpectancy' },
          },
        },
      },
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
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 100_000,
          percentBonds: 0,
        },
      },
    };

    const run = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const year1 = run.result.data[1];

    expect(year1.taxes?.incomeSources.qcdData?.excludedAmount).toBe(0);
    expect(year1.taxes?.incomeSources.qcdData?.taxableAmount).toBe(20_000);
    expect(year1.taxes?.incomeSources.taxDeferredWithdrawals).toBe(20_000);
  });

  it('caps the QCD exclusion at the statutory annual limit and leaves the excess taxable', () => {
    // Age 75 retiree, $150,000 charitable gift from IRA.
    // 2026 resolves to 2025 limit ($108,000).
    // Excluded amount: $108,000.
    // Taxable amount: $42,000.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1951,
        birthMonth: 1,
      },
      incomes: {},
      expenses: {
        'charity-big': {
          id: 'charity-big',
          name: 'Large Gift',
          amount: 150_000,
          frequency: 'yearly',
          amountBasis: 'nominal',
          satisfyFromIra: true,
          timeframe: {
            start: { type: 'now' },
            end: { type: 'atLifeExpectancy' },
          },
        },
      },
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
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 500_000,
          percentBonds: 0,
        },
      },
    };

    const run = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const year1 = run.result.data[1];

    expect(year1.taxes?.incomeSources.qcdData?.excludedAmount).toBe(108_000);
    expect(year1.taxes?.incomeSources.qcdData?.taxableAmount).toBe(42_000);
    // Taxable retirement distributions include the $42,000 excess plus any iterative tax-payment withdrawals
    expect(year1.taxes?.incomeSources.taxDeferredWithdrawals).toBeCloseTo(44_431.31, 1);
  });

  it('prevents double-dipping: excluded QCD reduces entered itemized charitable deduction', () => {
    // Age 75 retiree, $10,000 charitable expense with satisfyFromIra: true.
    // User also entered $15,000 in taxSettings.itemizedDeductions.charitable.
    // Under IRC §408(d)(8), the $10,000 excluded QCD cannot also be deducted on Schedule A.
    // Allowed charitable itemized deduction: $15,000 - $10,000 = $5,000.
    const base = createSimulatorInputs();
    const inputs: SimulatorInputs = {
      ...base,
      timeline: {
        ...createDefaultTimeline(),
        birthYear: 1951,
        birthMonth: 1,
      },
      incomes: {},
      expenses: {
        'charity-1': {
          id: 'charity-1',
          name: 'Charity Gift',
          amount: 10_000,
          frequency: 'yearly',
          amountBasis: 'nominal',
          satisfyFromIra: true,
          timeframe: {
            start: { type: 'now' },
            end: { type: 'atLifeExpectancy' },
          },
        },
      },
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
        itemizedDeductions: {
          mortgageInterest: 0,
          charitable: 15_000,
          stateAndLocalTaxes: 0,
          medicalExpenses: 0,
        },
      },
      accounts: {
        'ira-1': {
          id: 'ira-1',
          name: 'Traditional IRA',
          type: 'ira',
          balance: 246_000,
          percentBonds: 0,
        },
      },
    };

    const run = simulate(inputs, { mode: 'fixedReturns', asOf: '2026-01-01', seed: 1 });
    const year1 = run.result.data[1];

    expect(year1.taxes?.deduction.itemized.charitable).toBe(5_000);
  });
});
