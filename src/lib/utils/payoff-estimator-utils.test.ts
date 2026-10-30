import { describe, it, expect } from 'vitest';

import { createDebtInput, createFinancedAssetInput } from '@/lib/calc/__tests__/test-utils';
import { Debt } from '@/lib/calc/debts';
import { PhysicalAsset } from '@/lib/calc/physical-assets';
import type { DebtInputs } from '@/lib/schemas/inputs/debt-form-schema';
import type { PhysicalAssetInputs } from '@/lib/schemas/inputs/physical-asset-form-schema';
import { estimatePayoffMonths, formatPayoffEstimate } from './payoff-estimator-utils';

describe('estimatePayoffMonths', () => {
  it('handles 0% APR correctly', () => {
    expect(
      estimatePayoffMonths({
        balance: 1000,
        apr: 0,
        monthlyPayment: 100,
        interestType: 'simple',
      })
    ).toBe(10);
  });

  it('calculates simple interest payoff', () => {
    const months = estimatePayoffMonths({
      balance: 10000,
      apr: 18,
      monthlyPayment: 500,
      interestType: 'simple',
    });
    expect(months).toBeGreaterThan(20);
    expect(months).toBeLessThan(30);
  });

  it('calculates compound monthly interest payoff', () => {
    const months = estimatePayoffMonths({
      balance: 10000,
      apr: 18,
      monthlyPayment: 500,
      interestType: 'compound',
      compoundingFrequency: 'monthly',
    });
    expect(months).toBeGreaterThan(20);
    expect(months).toBeLessThan(30);
  });

  it('calculates compound daily interest payoff', () => {
    const months = estimatePayoffMonths({
      balance: 10000,
      apr: 18,
      monthlyPayment: 500,
      interestType: 'compound',
      compoundingFrequency: 'daily',
    });
    expect(months).toBeGreaterThan(20);
    expect(months).toBeLessThan(30);
  });

  it('returns Infinity when payment is less than interest', () => {
    expect(
      estimatePayoffMonths({
        balance: 10000,
        apr: 24,
        monthlyPayment: 150,
        interestType: 'simple',
      })
    ).toBe(Infinity);
  });

  it('returns null for zero balance', () => {
    expect(
      estimatePayoffMonths({
        balance: 0,
        apr: 18,
        monthlyPayment: 500,
        interestType: 'simple',
      })
    ).toBeNull();
  });

  it('returns null for zero payment', () => {
    expect(
      estimatePayoffMonths({
        balance: 10000,
        apr: 18,
        monthlyPayment: 0,
        interestType: 'simple',
      })
    ).toBeNull();
  });

  it('calculates 30-year mortgage correctly', () => {
    const months = estimatePayoffMonths({
      balance: 320000,
      apr: 6,
      monthlyPayment: 1918.56,
      interestType: 'simple',
    });
    expect(months).toBeGreaterThan(355);
    expect(months).toBeLessThan(365);
  });
});

describe('formatPayoffEstimate', () => {
  it('formats months only', () => {
    expect(formatPayoffEstimate(5)).toBe('5 months');
    expect(formatPayoffEstimate(1)).toBe('1 month');
  });

  it('formats years only', () => {
    expect(formatPayoffEstimate(24)).toBe('2 years');
    expect(formatPayoffEstimate(12)).toBe('1 year');
  });

  it('formats years and months', () => {
    expect(formatPayoffEstimate(15)).toBe('1 yr, 3 mo');
    expect(formatPayoffEstimate(25)).toBe('2 yrs, 1 mo');
  });

  it('formats Infinity as never', () => {
    expect(formatPayoffEstimate(Infinity)).toBe('Never (payment too low)');
  });
});

/**
 * Payoff estimates must agree with the simulation engine. The engine (see `Debt` in
 * `src/lib/calc/debts.ts` and `PhysicalAsset` in `src/lib/calc/physical-assets.ts`) charges a
 * Fisher-deflated real interest rate and deflates the monthly payment by the plan's inflation
 * assumption, so a nominal estimate disagrees with the simulation.
 */
describe('estimatePayoffMonths vs simulation engine', () => {
  /** Runs the engine's `Debt` month loop (same call order as `DebtsProcessor.process`). */
  function engineDebtPayoffMonths(debtInput: DebtInputs, annualInflationRate: number): number {
    const monthlyInflationRate = Math.pow(1 + annualInflationRate / 100, 1 / 12) - 1;
    const debt = new Debt(debtInput);
    let months = 0;
    while (!debt.isPaidOff() && months < 1200) {
      const { monthlyPaymentDue, interest } = debt.getMonthlyPaymentInfo(monthlyInflationRate);
      debt.applyPayment(monthlyPaymentDue, interest);
      debt.applyMonthlyInflation(monthlyInflationRate);
      months++;
    }
    return months;
  }

  /** Runs the engine's `PhysicalAsset` month loop (same call order as `PhysicalAssetsProcessor.process`). */
  function engineAssetPayoffMonths(assetInput: PhysicalAssetInputs, annualInflationRate: number): number {
    const monthlyInflationRate = Math.pow(1 + annualInflationRate / 100, 1 / 12) - 1;
    const asset = new PhysicalAsset(assetInput);
    let months = 0;
    while (!asset.isPaidOff() && months < 1200) {
      const { monthlyPaymentDue, interest } = asset.getMonthlyPaymentInfo(monthlyInflationRate);
      asset.applyLoanPayment(monthlyPaymentDue, interest);
      asset.applyMonthlyInflation(monthlyInflationRate);
      months++;
    }
    return months;
  }

  it('matches the engine payoff month for a 30-year mortgage (simple interest, 3% inflation)', () => {
    // Fixture: $320,000 loan at 6.00% APR with the standard 30-year payment of $1,918.56,
    // plan inflation assumption 3.00% a year.
    const debtInput = createDebtInput({
      balance: 320000,
      apr: 6,
      interestType: 'simple',
      monthlyPayment: 1918.56,
    });
    const annualInflationRate = 3;

    const engineMonths = engineDebtPayoffMonths(debtInput, annualInflationRate);
    const estimateMonths = estimatePayoffMonths({
      balance: debtInput.balance,
      monthlyPayment: debtInput.monthlyPayment,
      apr: debtInput.apr,
      interestType: debtInput.interestType,
      annualInflationRate,
    });

    expect(engineMonths).toBe(358);
    expect(estimateMonths).toBe(engineMonths);
  });

  it('matches the engine payoff month for the same loan with no inflation', () => {
    const debtInput = createDebtInput({ balance: 320000, apr: 6, interestType: 'simple', monthlyPayment: 1918.56 });

    const engineMonths = engineDebtPayoffMonths(debtInput, 0);
    const estimateMonths = estimatePayoffMonths({
      balance: debtInput.balance,
      monthlyPayment: debtInput.monthlyPayment,
      apr: debtInput.apr,
      interestType: debtInput.interestType,
      annualInflationRate: 0,
    });

    expect(engineMonths).toBe(361);
    expect(estimateMonths).toBe(engineMonths);
  });

  it('matches the engine payoff month for a compound-monthly credit card (3% inflation)', () => {
    // Fixture: $10,000 balance at 24.00% APR, $400 monthly payment, compounded monthly, 3% inflation.
    const debtInput = createDebtInput({
      balance: 10000,
      apr: 24,
      interestType: 'compound',
      compoundingFrequency: 'monthly',
      monthlyPayment: 400,
    });
    const annualInflationRate = 3;

    const engineMonths = engineDebtPayoffMonths(debtInput, annualInflationRate);
    const estimateMonths = estimatePayoffMonths({
      balance: debtInput.balance,
      monthlyPayment: debtInput.monthlyPayment,
      apr: debtInput.apr,
      interestType: debtInput.interestType,
      compoundingFrequency: debtInput.compoundingFrequency,
      annualInflationRate,
    });

    expect(estimateMonths).toBe(engineMonths);
  });

  it('matches the engine payoff month for a compound-daily personal loan (3% inflation)', () => {
    // Fixture: $15,000 balance at 12.00% APR, $500 monthly payment, compounded daily, 3% inflation.
    const debtInput = createDebtInput({
      balance: 15000,
      apr: 12,
      interestType: 'compound',
      compoundingFrequency: 'daily',
      monthlyPayment: 500,
    });
    const annualInflationRate = 3;

    const engineMonths = engineDebtPayoffMonths(debtInput, annualInflationRate);
    const estimateMonths = estimatePayoffMonths({
      balance: debtInput.balance,
      monthlyPayment: debtInput.monthlyPayment,
      apr: debtInput.apr,
      interestType: debtInput.interestType,
      compoundingFrequency: debtInput.compoundingFrequency,
      annualInflationRate,
    });

    expect(estimateMonths).toBe(engineMonths);
  });

  it('matches the engine payoff month for a physical-asset loan (net worth section estimate)', () => {
    // Fixture: $320,000 loan at 6.00% APR, $1,918.56 monthly payment, 3% inflation.
    const assetInput = createFinancedAssetInput({
      purchasePrice: 400000,
      paymentMethod: { type: 'loan', downPayment: 80000, loanBalance: 320000, apr: 6, monthlyPayment: 1918.56 },
    });
    const annualInflationRate = 3;

    const engineMonths = engineAssetPayoffMonths(assetInput, annualInflationRate);
    const estimateMonths = estimatePayoffMonths({
      balance: 320000,
      monthlyPayment: 1918.56,
      apr: 6,
      interestType: 'simple',
      annualInflationRate,
    });

    expect(engineMonths).toBe(358);
    expect(estimateMonths).toBe(engineMonths);
  });

  it('a nominal estimate overstates the payoff month when inflation is positive', () => {
    const nominalMonths = estimatePayoffMonths({ balance: 320000, monthlyPayment: 1918.56, apr: 6, interestType: 'simple' });
    const realMonths = estimatePayoffMonths({
      balance: 320000,
      monthlyPayment: 1918.56,
      apr: 6,
      interestType: 'simple',
      annualInflationRate: 3,
    });

    expect(nominalMonths).toBe(361);
    expect(realMonths).toBe(358);
  });
});
