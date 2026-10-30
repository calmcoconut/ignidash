/**
 * The `ordered` strategy: today's behaviour, moved out of `PortfolioProcessor` unchanged.
 *
 * It is the default, and the one the golden corpus was frozen on, so its sequence is a
 * behavioural contract: same account types, same order, same `contributionsOnly` first pass on
 * the Roth accounts before 59.5. It declares no `getAnnualCap`, which is what tells the processor
 * to withdraw whatever the deficit asks for — the pre-strategy behaviour, to the cent.
 */

import type { WithdrawalContext, WithdrawalOrderItem, WithdrawalStrategy } from './types';

/** The age at which Roth earnings, 401(k)s and IRAs become reachable without the 10% penalty. */
export const REGULAR_QUALIFIED_WITHDRAWAL_AGE = 59.5;

/**
 * The tax-optimised account sequence for one age.
 *
 * Before 59.5: savings → taxable → Roth contributions (only) → tax-deferred → Roth earnings → HSA.
 * From 59.5 on: savings → tax-deferred → taxable → Roth → HSA.
 */
export function orderedWithdrawalSequence(age: number): WithdrawalOrderItem[] {
  if (age < REGULAR_QUALIFIED_WITHDRAWAL_AGE) {
    return [
      { accountType: 'savings' },
      { accountType: 'taxableBrokerage' },
      { accountType: 'roth401k', modifier: 'contributionsOnly' },
      { accountType: 'roth403b', modifier: 'contributionsOnly' },
      { accountType: 'rothIra', modifier: 'contributionsOnly' },
      { accountType: '401k' },
      { accountType: '403b' },
      { accountType: 'ira' },
      { accountType: 'roth401k' },
      { accountType: 'roth403b' },
      { accountType: 'rothIra' },
      { accountType: 'hsa' },
    ];
  }

  return [
    { accountType: 'savings' },
    { accountType: '401k' },
    { accountType: '403b' },
    { accountType: 'ira' },
    { accountType: 'taxableBrokerage' },
    { accountType: 'roth401k' },
    { accountType: 'roth403b' },
    { accountType: 'rothIra' },
    { accountType: 'hsa' },
  ];
}

/** The default strategy: the sequence above, and no annual ceiling. */
export const orderedWithdrawalStrategy: WithdrawalStrategy = {
  id: 'ordered',
  getOrder: (ctx: WithdrawalContext) => orderedWithdrawalSequence(ctx.age),
};
