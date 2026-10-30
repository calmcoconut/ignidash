/**
 * The X % rule: withdraw a fixed percentage of the *current* balance every year.
 *
 * It is the classic constant-percentage rule (Bengen's "4 % rule" in its simplest dynamic form):
 * spending rises with the portfolio and falls with it, so the portfolio can never be exhausted by
 * the rule itself — the withdrawal is always a fraction of what is there. That property is the
 * reason the cap is clamped to the balance: at 100 % the rule takes everything, above it nothing
 * more exists to take.
 */

import { orderedWithdrawalSequence } from './ordered';
import type { WithdrawalContext, WithdrawalStrategy } from './types';

/** The conventional starting rate, in percent. */
export const DEFAULT_X_PERCENT_RATE = 4;

/** The year's withdrawal for a portfolio and a rate in percent. */
export function xPercentRuleWithdrawal(portfolioValue: number, ratePercent = DEFAULT_X_PERCENT_RATE): number {
  return Math.min(portfolioValue, Math.max(0, portfolioValue * (ratePercent / 100)));
}

/** An X %-rule strategy; `ratePercent` is the only knob, and 4 % is the documented default. */
export function createXPercentRuleStrategy(ratePercent = DEFAULT_X_PERCENT_RATE): WithdrawalStrategy {
  return {
    id: 'xPercentRule',
    getOrder: (ctx: WithdrawalContext) => orderedWithdrawalSequence(ctx.age),
    getAnnualCap: (ctx: WithdrawalContext) => xPercentRuleWithdrawal(ctx.portfolioValue, ratePercent),
  };
}

/** The shared, stateless instance the engine and the processor use by default once selected. */
export const xPercentRuleWithdrawalStrategy = createXPercentRuleStrategy();
