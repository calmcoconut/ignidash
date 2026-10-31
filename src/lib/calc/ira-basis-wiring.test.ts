/**
 * Form 8606 pro-rata basis recovery, wired through the engine (R3).
 *
 * `retirement-rules/ira-basis.test.ts` pins the pure maths. This file pins the wiring: which
 * accounts join the §408(d)(2) aggregate, what the engine does with the split, that the recovered
 * basis is spent year by year, and that a plan with no basis behaves exactly as it did before the
 * field existed.
 *
 * The hand-worked figures are Form 8606 Part I: line 6 (year-end balance), lines 2/5 (basis),
 * line 7/8 (distributions), line 9 (denominator), line 10 (the fraction), line 11 (tax-free),
 * line 14 (basis carried forward).
 */

import { describe, expect, it } from 'vitest';

import {
  createAccountData,
  createEmptyIncomesData,
  createEmptyPhysicalAssetsData,
  createEmptyPortfolioData,
  createEmptyReturnsData,
  createMockSimulationState,
} from './__tests__/test-utils';
import type { AccountDataWithFlows } from './account';
import { Portfolio } from './portfolio';
import type { PortfolioData } from './portfolio';
import type { SimulationState } from './simulation-engine';
import { TaxProcessor } from './taxes';

const RULESET_YEAR = 2026;

const createState = (age = 60): SimulationState => createMockSimulationState(new Portfolio([]), age);

/** One account's row in `perAccountData`, zeroed except for the withdrawal the test states. */
const accountRow = (row: { id: string; type: AccountDataWithFlows['type']; balance: number; withdrawn: number }): AccountDataWithFlows =>
  createAccountData({
    id: row.id,
    name: row.id,
    type: row.type,
    balance: row.balance,
    assetAllocation: { stocks: 0, bonds: 0, cash: 0 },
    ...(row.withdrawn === 0 ? {} : { withdrawals: { stocks: row.withdrawn, bonds: 0, cash: 0 } }),
  });

function portfolioWith(rows: AccountDataWithFlows[]): PortfolioData {
  const empty = createEmptyPortfolioData();

  return {
    ...empty,
    totalValue: rows.reduce((total, row) => total + row.balance, 0),
    perAccountData: Object.fromEntries(rows.map((row) => [row.id, row])),
  };
}

function processYear({
  age = 60,
  taxYear = RULESET_YEAR,
  iraBasisByAccount,
  portfolio,
  processor,
}: {
  age?: number;
  taxYear?: number;
  iraBasisByAccount?: Record<string, number>;
  portfolio: PortfolioData;
  processor?: TaxProcessor;
}) {
  const taxProcessor = processor ?? new TaxProcessor(createState(age), 'single', taxYear, undefined, { iraBasisByAccount });

  return taxProcessor.process(portfolio, createEmptyIncomesData(), createEmptyReturnsData(), createEmptyPhysicalAssetsData());
}

describe('IRA pro-rata basis recovery (Form 8606 Part I)', () => {
  it('taxes only the non-basis share of a distribution', () => {
    // line 6 = 90,000 · lines 2/5 = 10,000 · line 7 = 10,000
    // line 9  = 90,000 + 10,000 = 100,000
    // line 10 = 10,000 / 100,000 = 0.1
    // line 11 = 10,000 × 0.1 = 1,000 tax-free, so 9,000 is income
    const result = processYear({
      portfolio: portfolioWith([accountRow({ id: 'ira', type: 'ira', balance: 90000, withdrawn: 10000 })]),
      iraBasisByAccount: { ira: 10000 },
    });

    expect(result.incomeSources.taxDeferredWithdrawals).toBeCloseTo(9000, 6);
  });

  it('uses the year-end balance plus the distribution, so a fully-drained IRA is entirely tax-free', () => {
    // line 6 = 0 (the withdrawal emptied it) · lines 2/5 = 10,000 · line 7 = 10,000
    // line 9  = 0 + 10,000 = 10,000, line 10 = 1, line 11 = the whole distribution.
    // `basis / year-end balance` alone would be 10,000/0 and this is the case that catches it.
    const result = processYear({
      portfolio: portfolioWith([accountRow({ id: 'ira', type: 'ira', balance: 0, withdrawn: 10000 })]),
      iraBasisByAccount: { ira: 10000 },
    });

    expect(result.incomeSources.taxDeferredWithdrawals).toBe(0);
  });

  it('never recovers more basis than it has, so the carried figure cannot go negative', () => {
    // basis 5,000 against a 10,000 distribution from an emptied account: line 10 = 0.5, so 5,000 is
    // tax-free — not 10,000, and the remaining basis is 0 rather than −5,000.
    const result = processYear({
      portfolio: portfolioWith([accountRow({ id: 'ira', type: 'ira', balance: 0, withdrawn: 10000 })]),
      iraBasisByAccount: { ira: 5000 },
    });

    expect(result.incomeSources.taxDeferredWithdrawals).toBeCloseTo(5000, 6);
  });

  it('spends the recovered basis, so the next year measures against what is left', () => {
    const processor = new TaxProcessor(createState(), 'single', RULESET_YEAR, undefined, { iraBasisByAccount: { ira: 10000 } });
    const firstPortfolio = portfolioWith([accountRow({ id: 'ira', type: 'ira', balance: 90000, withdrawn: 10000 })]);
    const secondPortfolio = portfolioWith([accountRow({ id: 'ira', type: 'ira', balance: 80000, withdrawn: 10000 })]);

    // Year one recovers 1,000 of basis (see the first test), leaving 9,000.
    expect(processYear({ portfolio: firstPortfolio, processor }).incomeSources.taxDeferredWithdrawals).toBeCloseTo(9000, 6);

    // Year two: basis 9,000 over a denominator of 80,000 + 10,000 = 90,000 → 0.1 again → 1,000
    // tax-free. A processor that re-read the plan's 10,000 each year would report 9,000 here too,
    // which is why the second year's denominator is different and the assertion is not a repeat.
    const second = processYear({ portfolio: secondPortfolio, processor, taxYear: RULESET_YEAR + 1 });
    expect(second.incomeSources.taxDeferredWithdrawals).toBeCloseTo(9000, 6);
  });

  it('taxes the whole distribution when the plan states no basis — the pre-R3 behaviour', () => {
    const result = processYear({
      portfolio: portfolioWith([accountRow({ id: 'ira', type: 'ira', balance: 90000, withdrawn: 10000 })]),
    });

    expect(result.incomeSources.taxDeferredWithdrawals).toBe(10000);
  });

  it('leaves a 401(k) out of the aggregate: a basis beside it changes nothing', () => {
    // The 401(k)'s balance and withdrawal are not part of Form 8606's lines 6/7, and an IRA with no
    // withdrawal contributes its balance to line 6 only.
    const result = processYear({
      portfolio: portfolioWith([
        accountRow({ id: 'ira', type: 'ira', balance: 90000, withdrawn: 10000 }),
        accountRow({ id: '401k', type: '401k', balance: 500000, withdrawn: 50000 }),
      ]),
      iraBasisByAccount: { ira: 10000 },
    });

    // Taxable IRA 9,000 + the whole 401(k) withdrawal 50,000.
    expect(result.incomeSources.taxDeferredWithdrawals).toBeCloseTo(59000, 6);
  });

  it('charges the §72(t) 10% on the includible part only', () => {
    // Age 50: the distribution is early. 1,000 of the 10,000 is tax-free, so the penalty is
    // 10% of 9,000 — not 10% of 10,000.
    const result = processYear({
      age: 50,
      portfolio: portfolioWith([accountRow({ id: 'ira', type: 'ira', balance: 90000, withdrawn: 10000 })]),
      iraBasisByAccount: { ira: 10000 },
    });

    expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBeCloseTo(900, 6);
  });

  it('charges no penalty at 59½ or later, and still recovers the basis', () => {
    const result = processYear({
      age: 60,
      portfolio: portfolioWith([accountRow({ id: 'ira', type: 'ira', balance: 90000, withdrawn: 10000 })]),
      iraBasisByAccount: { ira: 10000 },
    });

    expect(result.earlyWithdrawalPenalties.taxDeferredPenaltyAmount).toBe(0);
    expect(result.incomeSources.taxDeferredWithdrawals).toBeCloseTo(9000, 6);
  });
});
