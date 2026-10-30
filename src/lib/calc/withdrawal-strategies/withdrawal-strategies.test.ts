import { describe, expect, it } from 'vitest';

import { ContributionRules } from '../contribution-rules';
import { Portfolio, PortfolioProcessor } from '../portfolio';
import {
  create401kAccount,
  createEmptyDebtsData,
  createEmptyExpensesData,
  createEmptyIncomesData,
  createEmptyPhysicalAssetsData,
  createMockSimulationState,
  createSavingsAccount,
  createSimulationContext,
} from '../__tests__/test-utils';

import {
  DEFAULT_WITHDRAWAL_STRATEGY,
  getWithdrawalStrategy,
  guytonKlingerWithdrawal,
  orderedWithdrawalSequence,
  REGULAR_QUALIFIED_WITHDRAWAL_AGE,
  vpwPayoutRate,
  WITHDRAWAL_STRATEGY_IDS,
  WITHDRAWAL_STRATEGIES,
  xPercentRuleWithdrawal,
  createVpwStrategy,
  createXPercentRuleStrategy,
  createGuytonKlingerStrategy,
} from './index';
import type { WithdrawalContext, WithdrawalStrategy, WithdrawalStrategyId } from './types';

/**
 * Withdrawal strategies (parity plan P1-P4, core).
 *
 * Three things are being pinned here:
 *
 * 1. **The ordered default is a behavioural contract.** Its sequence is the one the golden corpus
 *    was frozen on, so the tests assert the exact account order on both sides of 59.5 and that a
 *    processor given the strategy explicitly produces the same run as one that defaults to it.
 * 2. **The formula strategies are hand-checked.** VPW and the X % rule are worked out from their
 *    published definitions at a known age and balance; Guyton-Klinger from its two guardrails.
 * 3. **No strategy can spend money that is not there.** Every cap is tested against a spread of
 *    balances and ages, including zero, and the processor test shows a cap turning the difference
 *    into shortfall rather than into a withdrawal.
 */

const context = (overrides: Partial<WithdrawalContext> = {}): WithdrawalContext => ({
  age: 65,
  endAge: 85,
  portfolioValue: 1_000_000,
  ...overrides,
});

describe('ordered — the default sequence, unchanged', () => {
  it('drains Roth contributions before tax-deferred accounts before 59.5', () => {
    expect(orderedWithdrawalSequence(REGULAR_QUALIFIED_WITHDRAWAL_AGE - 0.5).map((item) => item.accountType)).toStrictEqual([
      'savings',
      'taxableBrokerage',
      'roth401k',
      'roth403b',
      'rothIra',
      '401k',
      '403b',
      'ira',
      'roth401k',
      'roth403b',
      'rothIra',
      'hsa',
    ]);

    // The first Roth pass is contributions-only; the second reaches earnings after 59.5.
    const sequence = orderedWithdrawalSequence(30);
    expect(sequence.filter((item) => item.modifier === 'contributionsOnly').map((item) => item.accountType)).toStrictEqual([
      'roth401k',
      'roth403b',
      'rothIra',
    ]);
  });

  it('takes tax-deferred money first once the penalty age is reached', () => {
    expect(orderedWithdrawalSequence(REGULAR_QUALIFIED_WITHDRAWAL_AGE).map((item) => item.accountType)).toStrictEqual([
      'savings',
      '401k',
      '403b',
      'ira',
      'taxableBrokerage',
      'roth401k',
      'roth403b',
      'rothIra',
      'hsa',
    ]);
  });

  it('declares no annual cap, which is what makes it the pre-strategy behaviour', () => {
    expect(DEFAULT_WITHDRAWAL_STRATEGY.id).toBe('ordered');
    expect(DEFAULT_WITHDRAWAL_STRATEGY.getAnnualCap).toBeUndefined();
    expect(DEFAULT_WITHDRAWAL_STRATEGY.getOrder(context())).toStrictEqual(orderedWithdrawalSequence(65));
  });
});

describe('VPW — hand-worked payout', () => {
  it('applies the annuity-due payout rate at age 65 for a plan that ends at 85', () => {
    // n = 20 years, r = 5%: A = Σ_{k=0..19} 1.05^-k = (1 − 1.05^-20) / (1 − 1.05^-1) = 13.0853208597
    // rate = 1 / A = 0.0764215116 → 7.6422 % of the balance this year.
    expect(vpwPayoutRate(65, 85, 0.05)).toBeCloseTo(0.0764215116, 10);

    const cap = createVpwStrategy(0.05).getAnnualCap!(context({ age: 65, endAge: 85, portfolioValue: 1_000_000 }));
    expect(cap).toBeCloseTo(76_421.5116, 4);
  });

  it('raises the payout rate as the horizon shortens, and takes everything in the last year', () => {
    const atSixtyFive = vpwPayoutRate(65, 85, 0.05);
    const atSeventyFive = vpwPayoutRate(75, 85, 0.05);

    expect(atSeventyFive).toBeGreaterThan(atSixtyFive);
    // Ten years left: A = Σ_{k=0..9} 1.05^-k = 8.1078216756, rate = 0.123337... ≈ 12.33 %.
    expect(atSeventyFive).toBeCloseTo(0.123337, 5);

    // One year left is 100 %, and nothing can exceed it.
    expect(vpwPayoutRate(84, 85, 0.05)).toBe(1);
    expect(vpwPayoutRate(85, 85, 0.05)).toBe(1);
    expect(vpwPayoutRate(120, 85, 0.05)).toBe(1);
  });

  it('degenerates to 1/n when the assumed real return is zero', () => {
    expect(vpwPayoutRate(65, 85, 0)).toBeCloseTo(1 / 20, 12);
    expect(vpwPayoutRate(84, 85, 0)).toBe(1);
  });
});

describe('X%-rule — hand-worked', () => {
  it('takes the fixed percentage of the current balance', () => {
    expect(xPercentRuleWithdrawal(1_000_000, 4)).toBe(40_000);
    expect(xPercentRuleWithdrawal(250_000, 4)).toBe(10_000);
    expect(xPercentRuleWithdrawal(0, 4)).toBe(0);

    const cap = createXPercentRuleStrategy(4).getAnnualCap!(context({ portfolioValue: 1_000_000 }));
    expect(cap).toBe(40_000);
  });

  it('never takes more than the balance, even at 100 % or above', () => {
    expect(xPercentRuleWithdrawal(500_000, 100)).toBe(500_000);
    expect(xPercentRuleWithdrawal(500_000, 400)).toBe(500_000);
  });
});

describe('Guyton-Klinger — hand-worked guardrails', () => {
  // Initial rate 5.2 %: 5.2 % × $1,000,000 = $52,000; the band is 4.16 %–6.24 %.
  it('starts at the initial rate with no history', () => {
    expect(guytonKlingerWithdrawal(context({ previousWithdrawal: undefined }))).toBeCloseTo(52_000, 10);
    expect(guytonKlingerWithdrawal(context({ previousWithdrawal: 0 }))).toBeCloseTo(52_000, 10);
  });

  it('cuts 10 % when the current rate is above the upper guardrail', () => {
    // $80,000 on $1,000,000 is 8.0 % > 6.24 % → 80,000 × 0.9 = 72,000.
    expect(guytonKlingerWithdrawal(context({ previousWithdrawal: 80_000 }))).toBeCloseTo(72_000, 10);
  });

  it('raises 10 % when the current rate is below the lower guardrail', () => {
    // $40,000 is 4.0 % < 4.16 % → 40,000 × 1.1 = 44,000.
    expect(guytonKlingerWithdrawal(context({ previousWithdrawal: 40_000 }))).toBeCloseTo(44_000, 10);
  });

  it('keeps last year`s withdrawal inside the band', () => {
    // $56,000 is 5.6 %, inside 4.16 %–6.24 % → unchanged.
    expect(guytonKlingerWithdrawal(context({ previousWithdrawal: 56_000 }))).toBeCloseTo(56_000, 10);
  });

  it('caps a raise at what the portfolio holds', () => {
    // A withdrawal larger than the balance cannot survive the clamp: 2× the portfolio in the
    // capital-preservation branch is cut 10 % and then held to the balance.
    expect(guytonKlingerWithdrawal(context({ portfolioValue: 1_000, previousWithdrawal: 2_000 }))).toBe(1_000);
  });
});

describe('no strategy can propose withdrawing more than the portfolio holds', () => {
  const portfolios = [0, 1, 999, 250_000, 1_000_000, 1_000_000_000];
  const ages = [0, 20, 59.4, 59.5, 65, 84.9, 85, 200];

  for (const id of WITHDRAWAL_STRATEGY_IDS) {
    it(`${id} clamps its cap to the balance at every age`, () => {
      const strategy = WITHDRAWAL_STRATEGIES[id];

      for (const portfolioValue of portfolios) {
        for (const age of ages) {
          const ctx = context({ age, portfolioValue, previousWithdrawal: portfolioValue * 0.2 });
          const cap = strategy.getAnnualCap?.(ctx);

          if (cap === undefined) continue; // `ordered`: no ceiling, so nothing to clamp.
          expect(cap, `${id}@${age}/${portfolioValue}`).toBeGreaterThanOrEqual(0);
          expect(cap, `${id}@${age}/${portfolioValue}`).toBeLessThanOrEqual(portfolioValue);
        }
      }
    });
  }
});

describe('the strategy registry', () => {
  it('resolves every id, and falls back to ordered for none or an unknown one', () => {
    for (const id of WITHDRAWAL_STRATEGY_IDS) expect(getWithdrawalStrategy(id).id).toBe(id);

    expect(getWithdrawalStrategy(undefined)).toBe(DEFAULT_WITHDRAWAL_STRATEGY);
    expect(getWithdrawalStrategy('notAStrategy' as WithdrawalStrategyId)).toBe(DEFAULT_WITHDRAWAL_STRATEGY);
  });

  it('is stateless: the same context gives the same answer twice', () => {
    const ctx = context({ previousWithdrawal: 80_000 });

    for (const id of WITHDRAWAL_STRATEGY_IDS) {
      const strategy = WITHDRAWAL_STRATEGIES[id];
      const first = strategy.getAnnualCap?.(ctx);
      const second = strategy.getAnnualCap?.(ctx);

      expect(second).toBe(first);
      expect(strategy.getOrder(ctx)).toStrictEqual(strategy.getOrder(ctx));
    }
  });

  it('shares the ordered sequence across the capping strategies', () => {
    const ctx = context({ age: 70 });
    for (const id of ['vpw', 'xPercentRule', 'guytonKlinger'] as const) {
      expect(WITHDRAWAL_STRATEGIES[id].getOrder(ctx)).toStrictEqual(orderedWithdrawalSequence(70));
    }
  });
});

// ============================================================================
// Injection through PortfolioProcessor
// ============================================================================

/** A processor over a fresh, identical portfolio, so two runs can be compared exactly. */
function makeProcessor(strategy?: WithdrawalStrategy) {
  const portfolio = new Portfolio([createSavingsAccount({ balance: 100_000 }), create401kAccount({ balance: 200_000 })]);
  const state = createMockSimulationState(portfolio, 70);
  const simulationContext = createSimulationContext({ startAge: 35, endAge: 90 });
  const processor = new PortfolioProcessor(state, simulationContext, new ContributionRules([], { type: 'spend' }), undefined, strategy);

  return { processor, state };
}

const draw = (processor: PortfolioProcessor, expenses: number) =>
  processor.processContributionsAndWithdrawals(
    createEmptyIncomesData(),
    createEmptyExpensesData({ totalExpenses: expenses }),
    createEmptyDebtsData(),
    createEmptyPhysicalAssetsData()
  );

describe('the ordered default is byte-identical when injected explicitly', () => {
  it('produces the same month whether the strategy is passed or defaulted', () => {
    const defaulted = makeProcessor();
    const explicit = makeProcessor(DEFAULT_WITHDRAWAL_STRATEGY);

    expect(draw(explicit.processor, 50_000)).toStrictEqual(draw(defaulted.processor, 50_000));
  });

  it('withdraws the whole deficit, as it did before strategies existed', () => {
    // $300,000 of portfolio, a $50,000 deficit, no cap: everything is funded from the portfolio.
    const { portfolioData } = draw(makeProcessor().processor, 50_000);

    expect(portfolioData.shortfall).toBe(0);
    expect(portfolioData.withdrawals.stocks + portfolioData.withdrawals.bonds + portfolioData.withdrawals.cash).toBeCloseTo(50_000, 6);
  });
});

describe('a capped strategy spends only its allowance', () => {
  it('withdraws the X%-rule cap and records the rest as shortfall', () => {
    // 4 % of $300,000 is $12,000, against a $50,000 deficit: $38,000 is unfunded.
    const { portfolioData } = draw(makeProcessor(createXPercentRuleStrategy(4)).processor, 50_000);

    expect(portfolioData.withdrawals.stocks + portfolioData.withdrawals.bonds + portfolioData.withdrawals.cash).toBeCloseTo(12_000, 6);
    expect(portfolioData.shortfall).toBeCloseTo(38_000, 6);
  });

  it('does not re-spend the year`s allowance on a second deficit', () => {
    const { processor } = makeProcessor(createXPercentRuleStrategy(4));

    const first = draw(processor, 50_000);
    const second = draw(processor, 50_000);

    expect(
      first.portfolioData.withdrawals.cash + first.portfolioData.withdrawals.stocks + first.portfolioData.withdrawals.bonds
    ).toBeCloseTo(12_000, 6);
    // The year's budget is gone: nothing more comes out, and the whole deficit is unfunded.
    expect(second.portfolioData.withdrawals.stocks + second.portfolioData.withdrawals.bonds + second.portfolioData.withdrawals.cash).toBe(
      0
    );
    expect(second.portfolioData.shortfall).toBeCloseTo(50_000, 6);
  });

  it('opens a fresh allowance in the next simulation year', () => {
    const { processor, state } = makeProcessor(createXPercentRuleStrategy(4));

    draw(processor, 50_000);
    state.time.month = 13; // the next simulation year

    const nextYear = draw(processor, 50_000);
    expect(
      nextYear.portfolioData.withdrawals.stocks + nextYear.portfolioData.withdrawals.bonds + nextYear.portfolioData.withdrawals.cash
    ).toBeCloseTo(11_520, 6);
    // 4 % of the remaining $288,000, not of the original $300,000.
    expect(nextYear.portfolioData.shortfall).toBeCloseTo(38_480, 6);
  });

  it('never withdraws more than the portfolio even when the cap is the whole balance', () => {
    // The X %-rule at 100 % permits the entire balance, and $300,000 cannot cover a $400,000 need.
    const { processor } = makeProcessor(createXPercentRuleStrategy(100));
    const { portfolioData } = draw(processor, 400_000);

    expect(portfolioData.withdrawals.stocks + portfolioData.withdrawals.bonds + portfolioData.withdrawals.cash).toBeCloseTo(300_000, 6);
    expect(portfolioData.shortfall).toBeCloseTo(100_000, 6);
  });
});

describe('the cap is per strategy, not per account', () => {
  it('takes from the ordered sequence and stops at the cap', () => {
    // Savings ($100,000) comes first in the sequence; the $12,000 cap never reaches the 401(k).
    const { portfolio, processor } = (() => {
      const portfolio = new Portfolio([createSavingsAccount({ balance: 100_000 }), create401kAccount({ balance: 200_000 })]);
      const state = createMockSimulationState(portfolio, 70);

      return {
        portfolio,
        processor: new PortfolioProcessor(
          state,
          createSimulationContext({ startAge: 35, endAge: 90 }),
          new ContributionRules([], { type: 'spend' }),
          undefined,
          createXPercentRuleStrategy(4)
        ),
      };
    })();

    draw(processor, 50_000);

    expect(
      portfolio
        .getAccounts()
        .find((account) => account.getAccountType() === 'savings')!
        .getBalance()
    ).toBeCloseTo(88_000, 6);
    expect(
      portfolio
        .getAccounts()
        .find((account) => account.getAccountType() === '401k')!
        .getBalance()
    ).toBe(200_000);
  });
});

describe('Guyton-Klinger through the processor', () => {
  it('uses the previous year`s withdrawal as its history', () => {
    const { processor, state } = makeProcessor(createGuytonKlingerStrategy(0.052));

    // Year one, no history: 5.2 % of $300,000 = $15,600, and the deficit is small enough to fund.
    const first = draw(processor, 10_000);
    expect(
      first.portfolioData.withdrawals.stocks + first.portfolioData.withdrawals.bonds + first.portfolioData.withdrawals.cash
    ).toBeCloseTo(10_000, 6);

    state.time.month = 13;
    // The portfolio still holds $290,000, so last year's $10,000 is 3.45 % — under the 4.16 %
    // guardrail, so the rule proposes 10,000 × 1.1 = $11,000, which covers the deficit.
    const second = draw(processor, 25_000);
    const withdrawn =
      second.portfolioData.withdrawals.stocks + second.portfolioData.withdrawals.bonds + second.portfolioData.withdrawals.cash;
    expect(withdrawn).toBeCloseTo(11_000, 6);
    expect(second.portfolioData.shortfall).toBeCloseTo(14_000, 6);

    state.time.month = 25;
    // Now $9,000 of the $279,000 left is 3.23 %: another 10 % raise, to $12,100 at most.
    const third = draw(processor, 25_000);
    const thirdWithdrawn =
      third.portfolioData.withdrawals.stocks + third.portfolioData.withdrawals.bonds + third.portfolioData.withdrawals.cash;
    expect(thirdWithdrawn).toBeCloseTo(12_100, 6);
  });
});
