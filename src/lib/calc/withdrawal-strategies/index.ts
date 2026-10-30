/**
 * Withdrawal strategies — the registry (parity plan P1-P4, core).
 *
 * `ordered` is the default and reproduces the pre-strategy behaviour exactly; it is what the
 * processor uses when no strategy is injected. The other three cap how much a year may withdraw
 * from the portfolio, which is the lever the plan's `withdrawalStrategy` setting will select
 * (that plan field lands with the export-version bump).
 *
 * Resolution is deliberately a single lookup so the follow-up is one line at the engine:
 *
 *     const strategy = getWithdrawalStrategy(settings.withdrawalStrategy);
 *     new PortfolioProcessor(state, context, rules, glidePath, strategy)
 */

import {
  guytonKlingerWithdrawalStrategy,
  createGuytonKlingerStrategy,
  guytonKlingerWithdrawal,
  DEFAULT_GUYTON_KLINGER_INITIAL_RATE,
  GUYTON_KLINGER_GUARDRAIL_BAND,
  GUYTON_KLINGER_ADJUSTMENT,
} from './guyton-klinger';
import { orderedWithdrawalStrategy, orderedWithdrawalSequence, REGULAR_QUALIFIED_WITHDRAWAL_AGE } from './ordered';
import type { WithdrawalStrategy, WithdrawalStrategyId } from './types';
import { createVpwStrategy, vpwPayoutRate, vpwWithdrawalStrategy, DEFAULT_VPW_REAL_RETURN } from './vpw';
import {
  createXPercentRuleStrategy,
  xPercentRuleWithdrawal,
  xPercentRuleWithdrawalStrategy,
  DEFAULT_X_PERCENT_RATE,
} from './x-percent-rule';

export type { WithdrawalContext, WithdrawalModifier, WithdrawalOrderItem, WithdrawalStrategy, WithdrawalStrategyId } from './types';
export { orderedWithdrawalSequence, REGULAR_QUALIFIED_WITHDRAWAL_AGE, orderedWithdrawalStrategy };
export { vpwPayoutRate, vpwWithdrawalStrategy, createVpwStrategy, DEFAULT_VPW_REAL_RETURN };
export { xPercentRuleWithdrawal, xPercentRuleWithdrawalStrategy, createXPercentRuleStrategy, DEFAULT_X_PERCENT_RATE };
export {
  guytonKlingerWithdrawal,
  guytonKlingerWithdrawalStrategy,
  createGuytonKlingerStrategy,
  DEFAULT_GUYTON_KLINGER_INITIAL_RATE,
  GUYTON_KLINGER_GUARDRAIL_BAND,
  GUYTON_KLINGER_ADJUSTMENT,
};

/** The default: today's sequence, and no ceiling. What a processor uses when none is injected. */
export const DEFAULT_WITHDRAWAL_STRATEGY = orderedWithdrawalStrategy;

/** Every strategy, keyed by the id the plan setting will carry. */
export const WITHDRAWAL_STRATEGIES: Record<WithdrawalStrategyId, WithdrawalStrategy> = {
  ordered: orderedWithdrawalStrategy,
  vpw: vpwWithdrawalStrategy,
  xPercentRule: xPercentRuleWithdrawalStrategy,
  guytonKlinger: guytonKlingerWithdrawalStrategy,
};

/** The ids in the order a UI would offer them. */
export const WITHDRAWAL_STRATEGY_IDS = [
  'ordered',
  'vpw',
  'xPercentRule',
  'guytonKlinger',
] as const satisfies readonly WithdrawalStrategyId[];

/**
 * The strategy to run: the one asked for, or `ordered` when the plan stores none (which is every
 * plan today — the setting does not exist yet). An id the build does not know falls back to
 * `ordered` rather than throwing, so a plan written by a newer build still simulates.
 */
export function getWithdrawalStrategy(id: WithdrawalStrategyId | undefined): WithdrawalStrategy {
  if (id === undefined) return orderedWithdrawalStrategy;

  return WITHDRAWAL_STRATEGIES[id] ?? orderedWithdrawalStrategy;
}
