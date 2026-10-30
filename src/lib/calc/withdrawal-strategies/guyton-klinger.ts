/**
 * Guyton-Klinger decision rules — the guardrail core.
 *
 * The published rule set starts from an initial withdrawal rate and then leaves the withdrawal
 * alone except when a guardrail is crossed. The engine models everything in today's dollars, so
 * the rule set's annual inflation adjustment is already implicit and drops out; what remains is:
 *
 *     initialAmount = portfolioValue × initialRate                  (cold start, no history)
 *     currentRate   = previousWithdrawal / portfolioValue
 *
 *     currentRate > initialRate × (1 + band)   → capital preservation: previousWithdrawal × (1 − cut)
 *     currentRate < initialRate × (1 − band)   → prosperity:           previousWithdrawal × (1 + raise)
 *     otherwise                                → keep last year's withdrawal
 *
 * The two guardrails are the paper's 20 % band and 10 % adjustment: a portfolio that falls far
 * enough behind a 5.2 % initial rate triggers a 10 % cut, and one that runs far enough ahead
 * triggers a 10 % raise. Because the rule only ever spends what the portfolio holds, the result
 * is clamped to [0, portfolioValue].
 *
 * `previousWithdrawal` is supplied by the processor from the previous simulation year; with no
 * history (the first year, or a year that withdrew nothing) the rule starts at the initial rate.
 */

import { orderedWithdrawalSequence } from './ordered';
import type { WithdrawalContext, WithdrawalStrategy } from './types';

/** Guyton-Klinger's published starting rate. */
export const DEFAULT_GUYTON_KLINGER_INITIAL_RATE = 0.052;

/** The guardrail band around the initial rate (20 % either way). */
export const GUYTON_KLINGER_GUARDRAIL_BAND = 0.2;

/** How much each guardrail moves the withdrawal (10 %). */
export const GUYTON_KLINGER_ADJUSTMENT = 0.1;

/** This year's withdrawal under the guardrail rules. */
export function guytonKlingerWithdrawal(ctx: WithdrawalContext, initialRate = DEFAULT_GUYTON_KLINGER_INITIAL_RATE): number {
  const portfolioValue = Math.max(0, ctx.portfolioValue);
  const clamp = (amount: number) => Math.min(portfolioValue, Math.max(0, amount));

  const previousWithdrawal = ctx.previousWithdrawal;
  if (previousWithdrawal === undefined || previousWithdrawal <= 0) return clamp(portfolioValue * initialRate);

  const currentRate = previousWithdrawal / portfolioValue;

  if (currentRate > initialRate * (1 + GUYTON_KLINGER_GUARDRAIL_BAND)) {
    return clamp(previousWithdrawal * (1 - GUYTON_KLINGER_ADJUSTMENT));
  }
  if (currentRate < initialRate * (1 - GUYTON_KLINGER_GUARDRAIL_BAND)) {
    return clamp(previousWithdrawal * (1 + GUYTON_KLINGER_ADJUSTMENT));
  }

  return clamp(previousWithdrawal);
}

/** A Guyton-Klinger strategy; `initialRate` is the only knob and 5.2 % is the documented default. */
export function createGuytonKlingerStrategy(initialRate = DEFAULT_GUYTON_KLINGER_INITIAL_RATE): WithdrawalStrategy {
  return {
    id: 'guytonKlinger',
    getOrder: (ctx: WithdrawalContext) => orderedWithdrawalSequence(ctx.age),
    getAnnualCap: (ctx: WithdrawalContext) => guytonKlingerWithdrawal(ctx, initialRate),
  };
}

/** The shared, stateless instance the engine and the processor use by default once selected. */
export const guytonKlingerWithdrawalStrategy = createGuytonKlingerStrategy();
