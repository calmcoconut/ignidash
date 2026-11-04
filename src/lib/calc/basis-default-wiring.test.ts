import { describe, it, expect } from 'vitest';

import { simulate } from './simulate';
import { create401kAccount, createLivingExpense, createSimulatorInputs, createTaxableBrokerageAccount } from './__tests__/test-utils';

/**
 * A taxable brokerage account whose cost basis was left blank in the form. The key is omitted
 * entirely (the test-utils factory would otherwise fill it in with a default).
 */
const brokerageWithoutCostBasis = (balance: number) => {
  const { costBasis: _omitted, ...data } = createTaxableBrokerageAccount({ id: 'brokerage-1', balance });
  return data;
};

describe('engine with a taxable account whose costBasis is absent', () => {
  it('yields finite federal income tax, capital gains tax and NIIT every year', () => {
    // The 401k is a small, untaxed-by-withdrawal source; expenses are drawn from the brokerage
    // so withdrawals realize gains and the tax pipeline runs for every simulated year.
    const inputs = createSimulatorInputs({
      timeline: { lifeExpectancy: 80, birthMonth: 6, birthYear: 1960, retirementStrategy: { type: 'fixedAge', retirementAge: 60 } },
      accounts: {
        'brokerage-1': brokerageWithoutCostBasis(800000),
        '401k-1': create401kAccount({ id: '401k-1', balance: 1 }),
      },
      expenses: { 'expense-1': createLivingExpense({ id: 'expense-1', amount: 60000 }) },
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
    }

    // Gains accrue as the balance grows past the basis, so withdrawals must realize gains in some
    // year. Before the fix the realized gain was NaN in every year.
    const realizedAny = yearly.some((point) => point.portfolio.realizedGains > 0);
    expect(realizedAny).toBe(true);
    expect(yearly.every((point) => Number.isFinite(point.portfolio.realizedGains))).toBe(true);
  });
});
