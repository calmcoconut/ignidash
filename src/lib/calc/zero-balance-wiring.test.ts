import { describe, it, expect } from 'vitest';

import { simulate } from './simulate';
import {
  create401kAccount,
  createLivingExpense,
  createRothIraAccount,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
} from './__tests__/test-utils';

describe('engine with $0 taxable and $0 Roth accounts alongside funded accounts', () => {
  it('yields finite taxes and portfolio values every year', () => {
    const { costBasis: _omitted, ...emptyBrokerage } = createTaxableBrokerageAccount({ id: 'brokerage-empty', balance: 0 });
    const inputs = createSimulatorInputs({
      timeline: { lifeExpectancy: 80, birthMonth: 6, birthYear: 1960, retirementStrategy: { type: 'fixedAge', retirementAge: 60 } },
      accounts: {
        'brokerage-empty': emptyBrokerage,
        'roth-empty': createRothIraAccount({ id: 'roth-empty', balance: 0 }),
        '401k-1': create401kAccount({ id: '401k-1', balance: 500000 }),
        'brokerage-funded': createTaxableBrokerageAccount({ id: 'brokerage-funded', balance: 300000, costBasis: 200000 }),
      },
      expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 50000 }) },
    });

    const outcome = simulate(inputs, { mode: 'fixedReturns', seed: 1, asOf: '2026-03-15' });
    const yearly = outcome.result.data.filter((point) => point.taxes !== null);

    expect(yearly.length).toBeGreaterThan(0);

    for (const point of yearly) {
      const taxes = point.taxes!;
      expect(Number.isFinite(taxes.federalIncomeTaxes.federalIncomeTaxAmount)).toBe(true);
      expect(Number.isFinite(taxes.capitalGainsTaxes.capitalGainsTaxAmount)).toBe(true);
      expect(Number.isFinite(taxes.niit.niitAmount)).toBe(true);
      expect(Number.isFinite(taxes.totalTaxLiability)).toBe(true);
      expect(Number.isFinite(point.portfolio.realizedGains)).toBe(true);
      expect(Number.isFinite(point.portfolio.totalValue)).toBe(true);
    }
  });
});
