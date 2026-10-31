/**
 * Withdrawal strategies (parity plan P1-P4, core).
 *
 * A strategy answers two questions about a cash-flow deficit:
 *
 *   1. **Where** the money comes from — `getOrder(ctx)` returns the account-type sequence the
 *      portfolio drains, in order. Today's tax-optimised sequence is `ordered`, the default.
 *   2. **How much** the strategy is willing to take from the portfolio this year — the optional
 *      `getAnnualCap(ctx)`. `undefined` means "no ceiling", which is exactly what `ordered` has
 *      always done; a strategy that returns a number caps the *spending* withdrawal at that
 *      amount, and whatever it refuses to fund is recorded as shortfall.
 *
 * Everything here is pure: a strategy's answer depends only on the context it is handed — no
 * store, no clock, no module-level mutable state. That is what lets the same object be used by
 * the engine, a compare run and the headless entry point and still produce identical numbers.
 *
 * The cap governs spending withdrawals only. Taxes withdrawn at settlement are a liability, not
 * a discretionary withdrawal, and are never capped (see `PortfolioProcessor.processTaxes`).
 */

import type { AccountInputs } from '@/lib/schemas/inputs/account-form-schema';

/**
 * How much of an account may be reached before retirement age: Roth contributions are available
 * without penalty, Roth earnings are not, so the same account type appears twice with this
 * modifier on the first pass.
 */
export type WithdrawalModifier = 'contributionsOnly';

/** One step of a withdrawal sequence: an account type, and how far into it the strategy may go. */
export interface WithdrawalOrderItem {
  accountType: AccountInputs['type'];
  modifier?: WithdrawalModifier;
}

/**
 * Everything a strategy is allowed to know at the moment it is asked.
 *
 * `age` is on the plan's axis (the primary member's age), the same axis the engine's clock runs
 * on. `endAge` is the plan's horizon, so a strategy that amortises over the remaining years (VPW)
 * needs no extra configuration. `previousWithdrawal` is last simulation year's portfolio
 * withdrawal, which only the history-dependent strategies (Guyton-Klinger) read.
 */
export interface WithdrawalContext {
  readonly age: number;
  /** The plan's last year on the plan axis: where the portfolio has to last to. */
  readonly endAge: number;
  readonly portfolioValue: number;
  /** Last simulation year's spending withdrawals, or `undefined` on the first year of the run. */
  readonly previousWithdrawal?: number | undefined;
}

/** The strategy ids the plan's `withdrawalStrategy` setting stores. */
export type WithdrawalStrategyId = 'ordered' | 'vpw' | 'xPercentRule' | 'guytonKlinger';

/** The row's interface: an order, and an optional annual ceiling. */
export interface WithdrawalStrategy {
  readonly id: WithdrawalStrategyId;

  /** The account types to drain, in order, for a withdrawal of any size. */
  getOrder(ctx: WithdrawalContext): readonly WithdrawalOrderItem[];

  /**
   * The most this strategy will withdraw from the portfolio in one simulation year, or
   * `undefined` for "no ceiling". Never negative, and never more than the portfolio holds.
   */
  getAnnualCap?(ctx: WithdrawalContext): number | undefined;
}
