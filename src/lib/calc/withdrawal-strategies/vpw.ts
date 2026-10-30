/**
 * VPW — variable percentage withdrawal, the Bogleheads form.
 *
 * The portfolio is treated as an annuity that has to last to the plan's horizon: each year's
 * withdrawal is a fixed *payout rate* applied to the current balance, where the rate is the
 * reciprocal of the present value of one dollar a year for the remaining years, discounted at an
 * assumed real return:
 *
 *     n     = max(ceil(endAge − age), 1)          remaining years on the plan axis
 *     A(n)  = Σ_{k=0}^{n-1} (1 + r)^(−k)           annuity-due PV factor
 *     rate  = 1 / A(n)
 *     cap   = portfolioValue × rate
 *
 * Two properties follow from the formula and are asserted in the tests: the rate rises as the
 * horizon shortens, and the final year takes everything (n = 1 → rate = 1). The rate never
 * exceeds 100 %, so the cap never exceeds the portfolio.
 *
 * The default real return is 5 %, the Bogleheads table's growth assumption for a balanced
 * portfolio. It is a parameter here rather than a plan field because the setting lands with the
 * version bump the export constant is waiting on.
 */

import { orderedWithdrawalSequence } from './ordered';
import type { WithdrawalContext, WithdrawalStrategy } from './types';

/** The Bogleheads VPW default: 5 % real growth for a balanced portfolio. */
export const DEFAULT_VPW_REAL_RETURN = 0.05;

/** The payout rate VPW uses for `age` on a plan that ends at `endAge`. */
export function vpwPayoutRate(age: number, endAge: number, realReturn = DEFAULT_VPW_REAL_RETURN): number {
  const remainingYears = Math.max(Math.ceil(endAge - age), 1);

  if (!(realReturn > 0)) return 1 / remainingYears;

  let annuityFactor = 0;
  for (let year = 0; year < remainingYears; year++) annuityFactor += Math.pow(1 + realReturn, -year);

  return 1 / annuityFactor;
}

/** A VPW strategy; `realReturn` is the only knob, and 5 % is the documented default. */
export function createVpwStrategy(realReturn = DEFAULT_VPW_REAL_RETURN): WithdrawalStrategy {
  return {
    id: 'vpw',
    getOrder: (ctx: WithdrawalContext) => orderedWithdrawalSequence(ctx.age),
    getAnnualCap: (ctx: WithdrawalContext) => {
      const rate = vpwPayoutRate(ctx.age, ctx.endAge, realReturn);

      return Math.min(ctx.portfolioValue, Math.max(0, ctx.portfolioValue * rate));
    },
  };
}

/** The shared, stateless instance the engine and the processor use by default once selected. */
export const vpwWithdrawalStrategy = createVpwStrategy();
