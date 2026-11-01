/**
 * Dividends and interest in a taxable account (v20): reinvested into basis, or paid out as cash.
 *
 * Both are taxed in the year earned (`taxes.ts` reads `yieldAmounts`). A reinvested dividend buys
 * shares, so it adds to the cost basis (Treas. Reg. §1.1012-1(c)); a paid-out one leaves the account
 * as cash and leaves the basis alone.
 */

import { describe, expect, it } from 'vitest';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

import { TaxableBrokerageAccount } from './account';
import { extractAnnualCashFlowLedger } from './data-extractors/cash-flow-ledger';
import { FixedReturnsProvider } from './returns-providers/fixed-returns-provider';
import { FinancialSimulationEngine, type SimulationResult } from './simulation-engine';
import {
  TEST_CLOCK,
  createDefaultTimeline,
  createExpenseInput,
  createSimulatorInputs,
  createTaxableBrokerageAccount,
} from './__tests__/test-utils';

/**
 * Hand check, one month: $100,000 at 50% bonds, 1% dividend and 2% interest yields, 2% and 3%
 * total returns. Yields: stocks 50,000 × 1% = 500, bonds 50,000 × 2% = 1,000. Returns: stocks
 * 50,000 × 2% = 1,000, bonds 50,000 × 3% = 1,500, so the balance is 102,500 (51,000 + 51,500).
 */
function oneMonth(distributeIncome?: boolean) {
  const account = new TaxableBrokerageAccount(
    createTaxableBrokerageAccount({
      balance: 100_000,
      costBasis: 100_000,
      percentBonds: 50,
      ...(distributeIncome ? { distributeIncome } : {}),
    })
  );
  account.applyYields({ stocks: 0.01, bonds: 0.02, cash: 0 });
  account.applyReturns({ stocks: 0.02, bonds: 0.03, cash: 0 });
  const paid = account.settleInvestmentIncome();

  return { account, paid };
}

describe('settling a month of investment income', () => {
  it('adds reinvested income to the cost basis', () => {
    const { account, paid } = oneMonth();
    expect(paid).toBe(0);
    expect(account.getBalance()).toBeCloseTo(102_500, 9);
    expect(account.getCostBasis()).toBeCloseTo(101_500, 9);
  });

  it('pays income out sleeve by sleeve and leaves the basis alone', () => {
    const { account, paid } = oneMonth(true);
    expect(paid).toBeCloseTo(1_500, 9);
    // 102,500 - 1,500; bonds 51,500 - 1,000 = 50,500 of 101,000.
    expect(account.getBalance()).toBeCloseTo(101_000, 9);
    expect(account.getAccountData().assetAllocation.bonds).toBeCloseTo(0.5, 12);
    expect(account.getCostBasis()).toBe(100_000);
  });
});

const MARKET = { stockReturn: 6, stockYield: 2, bondReturn: 4, bondYield: 3, cashReturn: 0, inflationRate: 0 };

function plan(distributeIncome: boolean): SimulatorInputs {
  return createSimulatorInputs({
    timeline: { ...createDefaultTimeline(), birthMonth: 10, birthYear: 1960, lifeExpectancy: 75 },
    incomes: {},
    expenses: { living: createExpenseInput({ id: 'living', name: 'living', amount: 60_000, frequency: 'yearly' }) },
    accounts: {
      brokerage: createTaxableBrokerageAccount({
        id: 'brokerage',
        balance: 1_000_000,
        costBasis: 600_000,
        percentBonds: 40,
        ...(distributeIncome ? { distributeIncome } : {}),
      }),
    },
    marketAssumptions: MARKET,
  });
}

const run = (inputs: SimulatorInputs): SimulationResult =>
  new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);

describe('paying income out through the engine', () => {
  it('reports the payout, funds spending with it, and withdraws less', () => {
    const reinvested = run(plan(false));
    const paidOut = run(plan(true));

    const year = 1;
    expect(reinvested.data[year].returns?.incomePaidAsCash).toBeUndefined();
    const paid = paidOut.data[year].returns?.incomePaidAsCash ?? 0;
    // Roughly 2% of the stocks and 3% of the bonds of a ~$1M account.
    expect(paid).toBeGreaterThan(20_000);
    expect(paid).toBeLessThan(30_000);
    // The paid-out income equals the year's taxable yields: the tax overlay and the cash agree.
    const yields = paidOut.data[year].returns!.yieldAmounts.taxable;
    expect(paid).toBeCloseTo(yields.stocks + yields.bonds, 6);

    const withdrawn = (result: SimulationResult) => {
      const flows = result.data[year].portfolio.withdrawals;
      return flows.stocks + flows.bonds + flows.cash;
    };
    expect(withdrawn(paidOut)).toBeLessThan(withdrawn(reinvested) - 15_000);
  });

  it('keeps the cash ledger balanced with the payout as an inflow', () => {
    for (const entry of extractAnnualCashFlowLedger(run(plan(true)).data).slice(0, 5)) {
      expect(entry.inflows.investmentIncomePaid).toBeGreaterThan(0);
      // Under a dollar: the same sub-dollar tax-settlement lag a reinvesting plan shows (about
      // $0.55 a year here); without the payout inflow the residual would be ~$24,000.
      expect(Math.abs(entry.cashResidual)).toBeLessThan(1);
      expect(Math.abs(entry.reconciliationResidual)).toBeLessThan(1);
    }
  });
});
